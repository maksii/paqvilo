// @test-kind contract: how Lense tells that the portal serves another version of a file than the comparison baseline holds (a checkout ahead of the deployment, or behind it), what it lays over a page then, and which Git refs it names as holding the served version
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PortalModel } from '../lense/portal-model.mjs';
import { GitBaseline, fileVersions, refVersions, blobText } from '../lense/git.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { ServedVersions } from '../lense/served-version.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { servedVersionLine } from '../lense/commands/dev.mjs';
import { createSourceInspector } from '../lense/source-inspection.mjs';
import { createFixture, SITE } from './fixture.mjs';

let fx;
beforeEach(() => {
  fx = createFixture();
});
afterEach(() => fx.cleanup());

const BANNER = 'web-templates/banner/Banner.webtemplate.source.html';
const banner = (source) => {
  fx.write('web-templates/banner/Banner.webtemplate.yml', 'adx_name: Banner\nadx_webtemplateid: banner-id\n');
  fx.write(BANNER, source);
};
const rewriter = (ref = 'HEAD') =>
  new HtmlRewriter({ model: new PortalModel(fx.dir), site: SITE, baseline: new GitBaseline(fx.dir, ref) });
const indexFor = (route = '/') => createSourceInspector({ sourceDir: fx.dir }).sourceIndexFor(route);
const page = (body) => `<!DOCTYPE html>\n<html><head><title>Invented</title></head><body>\n${body}\n</body></html>\n`;
const rewrite = async (current, served, route = '/') => {
  const sourceIndex = await indexFor(route);
  return { sourceIndex, result: current.rewrite(served, route, { isDocument: true, sourceIndex, provenance: false }) };
};
const tracker = (current, ref = 'HEAD') =>
  new ServedVersions({ sourceDir: fx.dir, rewriter: () => current, baseline: () => ({ spec: ref, commit: null }) });

// One template in two versions: the portal has the first, a later commit holds the second.
const DEPLOYED =
  '<section class="banner" id="banner">\n  <a class="skip" href="#main">Skip to content</a>\n  <h2 class="banner-title" id="banner-title">Invented spring sale</h2>\n  <p class="banner-text" id="banner-text">Until the end of the month</p>\n</section>\n';
const AHEAD =
  '<section class="banner" id="banner">\n  <h2 class="banner-title" id="banner-title">Invented summer sale</h2>\n  <p class="banner-text" id="banner-text">Until the end of the month</p>\n  <a class="banner-more" href="/sale/">See the offers</a>\n</section>\n';

test('a page the baseline explains differs nowhere and lists the files it shows', async () => {
  banner(DEPLOYED);
  fx.commit();
  const { result } = await rewrite(rewriter(), page(DEPLOYED));
  assert.deepEqual(result.drift.files, []);
  assert.deepEqual(result.drift.places, []);
  assert.deepEqual(result.drift.seen, [BANNER]);
  assert.deepEqual(result.applied, []);
});

test('a checkout ahead of the portal: the committed changes are named place by place, and the ref that holds the served version is found', async () => {
  banner(DEPLOYED);
  fx.commit();
  fx.git('branch', 'deployed');
  fx.git('tag', 'release-1');
  banner(AHEAD);
  fx.commit();
  const served = page(DEPLOYED);
  const current = rewriter();
  const { result, sourceIndex } = await rewrite(current, served);
  // Nothing differs from the baseline (HEAD), so nothing is laid over: the page stays what the portal sent.
  assert.deepEqual(result.applied, []);
  assert.equal(result.html, served);
  assert.deepEqual(
    result.drift.files.map((file) => [file.rel, file.kind, file.places, file.changed, file.deployed]),
    [[BANNER, 'webtemplate', 3, undefined, undefined]],
  );
  assert.deepEqual(
    result.drift.places.map((place) => [place.change, place.line, place.local, place.served]),
    [
      ['served-only', 1, '', '<a class="skip" href="#main">Skip to content</a>'],
      ['changed', 2, 'Invented summer sale', 'Invented spring sale'],
      ['local-only', 4, '<a class="banner-more" href="/sale/">See the offers</a>', ''],
    ],
  );
  const versions = tracker(current);
  versions.note('/', result.drift, served, sourceIndex);
  const snapshot = await versions.settled();
  assert.equal(snapshot.differs, 1);
  assert.equal(snapshot.search.state, 'done');
  assert.deepEqual(snapshot.search.refs.map((ref) => ref.name).sort(), ['deployed', 'release-1']);
  assert.equal(snapshot.files[0].versions.fits.length, 1, 'the first version of the file is what the page shows');
  assert.match(
    servedVersionLine(snapshot),
    /^1 file is served in another version than the baseline HEAD holds \(Banner\.webtemplate\.source\.html\): the pages opened show it as (deployed|release-1) [0-9a-f]{7} has it; use --baseline (deployed|release-1) /,
  );
  // Compared with that ref, the checkout is laid over what is deployed and nothing is left to differ.
  const over = await rewrite(rewriter('deployed'), served);
  assert.deepEqual(over.result.drift.files, []);
  assert.deepEqual(
    over.result.applied.map((entry) => entry.rel),
    [BANNER],
  );
  assert.match(over.result.html, /Invented summer sale/);
  assert.match(over.result.html, /<a class="banner-more" href="\/sale\/">See the offers<\/a>/);
  assert.doesNotMatch(over.result.html, /Skip to content|spring sale/);
  // A later page that shows the file as the baseline has it clears the finding for that page.
  versions.note('/', over.result.drift, served, over.sourceIndex);
  assert.equal(versions.snapshot().files.length, 0);
});

test('a checkout behind the portal: an older branch against a newer deployment is told the same way', async () => {
  banner(DEPLOYED);
  fx.commit();
  fx.git('branch', 'old-release');
  banner(AHEAD);
  fx.commit();
  fx.git('branch', 'current');
  fx.git('checkout', '-q', 'old-release');
  // The portal serves the newer version; the checkout holds the older one.
  const served = page(AHEAD);
  const current = rewriter();
  const { result, sourceIndex } = await rewrite(current, served);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(
    result.drift.places.map((place) => place.change),
    ['local-only', 'changed', 'served-only'],
  );
  const versions = tracker(current);
  versions.note('/', result.drift, served, sourceIndex);
  const snapshot = await versions.settled();
  assert.ok(snapshot.search.refs.some((ref) => ref.name === 'current'));
  assert.ok(!snapshot.search.refs.some((ref) => ref.name === 'old-release'));
  // Compared with the deployed ref, the older checkout is what the page shows.
  const over = await rewrite(rewriter('current'), served);
  assert.match(over.result.html, /Invented spring sale/);
  assert.match(over.result.html, /Skip to content/);
  assert.doesNotMatch(over.result.html, /See the offers/);
  assert.deepEqual(over.result.drift.files, []);
});

test('a version the repository does not have is said to be nowhere, and no ref is named', async () => {
  banner(AHEAD);
  fx.commit();
  const served = page(DEPLOYED.replace('spring', 'winter'));
  const current = rewriter();
  const { result, sourceIndex } = await rewrite(current, served);
  const versions = tracker(current);
  versions.note('/', result.drift, served, sourceIndex);
  const snapshot = await versions.settled();
  assert.deepEqual(snapshot.search.refs, []);
  assert.deepEqual(snapshot.files[0].versions.fits, []);
  assert.match(servedVersionLine(snapshot), /no branch or tag of this repository holds what the portal serves$/);
});

test('a working copy the portal already serves is not laid over a second time', async () => {
  banner(DEPLOYED);
  fx.commit();
  // Saved and deployed, not committed: the baseline is behind both the working copy and the portal.
  fx.write(BANNER, AHEAD);
  const served = page(AHEAD);
  const current = rewriter();
  const { result, sourceIndex } = await rewrite(current, served);
  assert.deepEqual(result.applied, []);
  assert.equal(result.html, served, 'the added link is not added again');
  assert.deepEqual(
    result.drift.files.map((file) => [file.rel, file.deployed]),
    [[BANNER, true]],
  );
  assert.deepEqual(result.drift.places, []);
  assert.deepEqual(
    result.notes.map((note) => [note.rel, note.reason]),
    [
      [
        BANNER,
        'the portal already serves this version of the file where the page shows it: those changes are not laid over a second time',
      ],
    ],
  );
  const versions = tracker(current);
  versions.note('/', result.drift, served, sourceIndex);
  const snapshot = versions.snapshot();
  assert.deepEqual([snapshot.differs, snapshot.deployed, snapshot.files[0].state], [0, 1, 'deployed']);
  assert.equal(snapshot.search, undefined, 'nothing to ask Git about');
  assert.equal(servedVersionLine(snapshot), '');
});

test('changes scattered over one long line with Liquid code elsewhere in it are laid over where they stand', async () => {
  const line = (brand, extra) =>
    `<header class="site-top" id="site-top"><a class="skip-link" href="#main">Skip</a><span class="brand-name" id="brand-name">${brand}</span><nav class="site-nav" id="site-nav"><a class="nav-item" href="/one/">One</a>${extra}</nav><div class="who" id="who">{% if user %}{{ user.fullname }}{% else %}<a class="sign-in" href="/SignIn">Sign in</a>{% endif %}</div></header>`;
  banner(line('Invented brand', ''));
  fx.commit();
  fx.write(
    BANNER,
    line('Invented brand, renamed', '<a class="nav-item added" href="/two/">Two</a>').replace(
      '<a class="skip-link" href="#main">Skip</a>',
      '',
    ),
  );
  const served = page(
    '<header class="site-top" id="site-top"><a class="skip-link" href="#main">Skip</a><span class="brand-name" id="brand-name">Invented brand</span><nav class="site-nav" id="site-nav"><a class="nav-item" href="/one/">One</a></nav><div class="who" id="who"><a class="sign-in" href="/SignIn">Sign in</a></div></header>',
  );
  const { result } = await rewrite(rewriter(), served);
  assert.deepEqual(
    result.applied.map((entry) => entry.rel),
    [BANNER],
  );
  assert.equal(result.alignment, undefined, 'no element is named without the panel');
  assert.match(result.html, /<span class="brand-name" id="brand-name">Invented brand, renamed<\/span>/);
  assert.match(
    result.html,
    /<a class="nav-item" href="\/one\/">One<\/a><a class="nav-item added" href="\/two\/">Two<\/a><\/nav>/,
  );
  assert.doesNotMatch(result.html, /skip-link/);
  // What the Liquid code wrote stays the portal's.
  assert.match(result.html, /<div class="who" id="who"><a class="sign-in" href="\/SignIn">Sign in<\/a><\/div>/);
  assert.deepEqual(result.drift.files, [], 'the page is what the baseline says the portal has');
});

test('a long line that the line patch cannot anchor is laid over by position, and says what is left to the portal', async () => {
  const line = (brand, extra, signIn) =>
    `<header class="site-top" id="site-top"><span class="brand-name" id="brand-name">${brand}</span><nav class="site-nav" id="site-nav"><a class="nav-item" href="/one/">One</a>${extra}</nav><div class="who" id="who">{% if user %}{{ user.fullname }}{% else %}<a class="sign-in" href="/SignIn">${signIn}</a>{% endif %}</div></header>`;
  banner(line('Invented brand', '', 'Sign in'));
  fx.commit();
  fx.write(BANNER, line('Invented brand, renamed', '<a class="nav-item added" href="/two/">Two</a>', 'Sign in here'));
  const served = page(
    '<header class="site-top" id="site-top"><span class="brand-name" id="brand-name">Invented brand</span><nav class="site-nav" id="site-nav"><a class="nav-item" href="/one/">One</a></nav><div class="who" id="who"><a class="sign-in" href="/SignIn">Sign in</a></div></header>',
  );
  const current = rewriter();
  const { result } = await rewrite(current, served);
  assert.deepEqual(
    result.applied.map((entry) => [entry.rel, entry.action]),
    [[BANNER, 'patched 3 changes']],
  );
  assert.ok(result.html.includes('Invented brand, renamed</span>'));
  assert.ok(result.html.includes('<a class="nav-item added" href="/two/">Two</a></nav>'));
  // The link of the branch the portal rendered is found on the page: its text is the file's too.
  assert.ok(result.html.includes('>Sign in here</a></div>'));
  assert.deepEqual(
    current.unsupported.map((entry) => [entry.rel, entry.reason]),
    [
      [
        BANNER,
        'line 1: the line holds Liquid code: its changed markup is laid over where a page shows it between two of its tags; text right beside what the Liquid code prints needs a deployment',
      ],
    ],
  );
});

test('the file versions and the refs Git is asked for', async () => {
  banner(DEPLOYED);
  fx.commit();
  fx.git('tag', 'first');
  banner(AHEAD);
  fx.commit();
  const file = fx.file(BANNER);
  const versions = await fileVersions(fx.dir, file);
  assert.equal(versions.length, 2);
  assert.equal(await blobText(fx.dir, versions[0].blob), AHEAD, 'newest first');
  assert.equal(await blobText(fx.dir, versions[1].blob), DEPLOYED);
  assert.equal(await blobText(fx.dir, 'not-an-object'), null);
  const refs = await refVersions(fx.dir, [file]);
  const first = refs.find((ref) => ref.name === 'first');
  assert.equal(first.blobs.get(file), versions[1].blob);
  assert.ok(
    refs.some((ref) => ref.blobs.get(file) === versions[0].blob),
    'the branch holds the newest version',
  );
  assert.deepEqual(await fileVersions(fx.dir, fx.file('../outside.html')), []);
  // A source folder below the repository's root: paths are read from that folder.
  const below = fx.file('web-templates');
  assert.equal((await fileVersions(below, file)).length, 2);
  const fromBelow = await refVersions(below, [file]);
  assert.equal(fromBelow.find((ref) => ref.name === 'first').blobs.get(file), versions[1].blob);
});

test('a session compares with another ref on request and keeps its baseline when the ref cannot be read', async () => {
  banner(DEPLOYED);
  fx.commit();
  fx.git('branch', 'deployed');
  banner(AHEAD);
  fx.commit();
  const session = await OverlaySession.create({
    origin: 'https://portal.example',
    sourceDir: fx.dir,
    site: structuredClone(SITE),
  });
  assert.equal(session.rewriter.patches.length, 0);
  const events = [];
  session.on('served', (snapshot) => events.push(snapshot.files.length));
  const sourceIndex = await indexFor();
  const before = session.rewriter.rewrite(page(DEPLOYED), '/', { isDocument: true, sourceIndex, provenance: false });
  session.served.note('/', before.drift, page(DEPLOYED), sourceIndex);
  assert.deepEqual(events, [1]);
  const used = await session.useBaseline('deployed');
  assert.equal(used.spec, 'deployed');
  assert.equal(session.baseline.spec, 'deployed');
  assert.equal(session.rewriter.patches.length, 1, 'the committed change is a change against the new baseline');
  assert.equal(session.served.snapshot().files.length, 0, 'what the pages showed was compared with the old baseline');
  await assert.rejects(session.useBaseline('no-such-ref'), /Cannot read baseline no-such-ref/);
  assert.equal(session.baseline.spec, 'deployed');
  await assert.rejects(session.useBaseline('--upload-pack=x'), /invalid baseline ref|Cannot read baseline/);
});

test('a file no version of the repository explains does not keep the others from naming their ref', async () => {
  const BOT = 'web-templates/bot/Bot.webtemplate.source.html';
  const bot = (text) =>
    `<div class="bot-frame" id="bot-frame">\n  <p class="bot-hello" id="bot-hello">${text}</p>\n  <p class="bot-hint" id="bot-hint">Ask the invented assistant</p>\n</div>\n`;
  banner(DEPLOYED);
  fx.write('web-templates/bot/Bot.webtemplate.yml', 'adx_name: Bot\nadx_webtemplateid: bot-id\n');
  fx.write(BOT, bot('Hello from the export'));
  fx.commit();
  fx.git('branch', 'deployed');
  banner(AHEAD);
  fx.commit();
  // The portal renders the assistant from a copy of its own, and the banner as the first commit has it.
  const served = page(DEPLOYED + bot('Hello from the portal itself'));
  const current = rewriter();
  const { result, sourceIndex } = await rewrite(current, served);
  assert.deepEqual(result.drift.files.map((file) => file.rel).sort(), [BANNER, BOT].sort());
  const versions = tracker(current);
  versions.note('/', result.drift, served, sourceIndex);
  const snapshot = await versions.settled();
  assert.deepEqual(
    snapshot.search.refs.map((ref) => ref.name),
    ['deployed'],
  );
  const byRel = new Map(snapshot.files.map((file) => [file.rel, file.versions.fits.length]));
  assert.deepEqual([byRel.get(BANNER), byRel.get(BOT)], [1, 0]);
  assert.match(servedVersionLine(snapshot), /^1 file is served in another version .*use --baseline deployed /);
});

test('Git that cannot be asked is said as that, and a history compared only in part is not called the whole of it', async () => {
  banner(DEPLOYED);
  fx.commit();
  banner(AHEAD);
  fx.commit();
  const served = page(DEPLOYED);
  const current = rewriter();
  const { result, sourceIndex } = await rewrite(current, served);
  const missing = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  const silent = new ServedVersions({
    sourceDir: fx.dir,
    rewriter: () => current,
    baseline: () => ({ spec: 'HEAD', commit: null }),
    git: {
      fileVersions: () => Promise.reject(missing),
      blobText: () => Promise.reject(missing),
      refVersions: () => Promise.reject(missing),
    },
  });
  silent.note('/', result.drift, served, sourceIndex);
  const unavailable = await silent.settled();
  assert.equal(unavailable.search.state, 'unavailable');
  assert.match(servedVersionLine(unavailable), /: Git could not be asked which version that is$/);
  // The real helpers pass that failure on instead of answering "nothing".
  // (A folder that does not exist: the Git process cannot start there.)
  const nowhere = fx.dir + '-not-there';
  await assert.rejects(fileVersions(nowhere, nowhere + '/Banner.html'), (error) => error.code === 'ENOENT');
  // Only the newest version was compared: none of those holds it, which is not "none in the repository".
  const partial = new ServedVersions({
    sourceDir: fx.dir,
    rewriter: () => current,
    baseline: () => ({ spec: 'HEAD', commit: null }),
    git: {
      fileVersions: async (...args) => Object.assign((await fileVersions(...args)).slice(0, 1), { limited: true }),
      blobText,
      refVersions,
    },
  });
  partial.note('/', result.drift, served, sourceIndex);
  const limited = await partial.settled();
  assert.deepEqual(
    [limited.search.state, limited.search.limited, limited.files[0].versions.limited],
    ['done', true, true],
  );
  assert.match(
    servedVersionLine(limited),
    /no branch or tag among the newest versions and refs compared holds what the portal serves$/,
  );
});

test('a ref is named in full when a branch and a tag share its short name, and a tag by the commit it points at', async () => {
  banner(DEPLOYED);
  fx.commit();
  fx.git('branch', 'v1');
  banner(AHEAD);
  fx.commit();
  // An annotated tag of the same name on the newer commit: `v1` alone would resolve to it, not to the branch.
  fx.git('-c', 'user.name=test', '-c', 'user.email=test@localhost', 'tag', '-a', 'v1', '-m', 'invented release');
  const file = fx.file(BANNER);
  const versions = await fileVersions(fx.dir, file);
  const refs = await refVersions(fx.dir, [file]);
  const branch = refs.find((ref) => ref.ref === 'refs/heads/v1');
  const tag = refs.find((ref) => ref.ref === 'refs/tags/v1');
  assert.deepEqual([branch.name, tag.name], ['v1', 'v1']);
  assert.equal(branch.commit, versions[1].commit);
  assert.equal(tag.commit, versions[0].commit, 'the commit the tag points at, not the tag object');
  assert.match(tag.date, /^\d{4}-\d\d-\d\d/);
  const served = page(DEPLOYED);
  const current = rewriter();
  const { result, sourceIndex } = await rewrite(current, served);
  const tracked = tracker(current);
  tracked.note('/', result.drift, served, sourceIndex);
  const snapshot = await tracked.settled();
  assert.deepEqual(
    snapshot.search.refs.map((ref) => [ref.ref, ref.ambiguous]),
    [['refs/heads/v1', true]],
  );
  assert.match(servedVersionLine(snapshot), /use --baseline refs\/heads\/v1 \(or the panel\)/);
  // The full name resolves to the branch's commit.
  assert.equal(new GitBaseline(fx.dir, 'refs/heads/v1').commit, branch.commit);
});

test('a ref whose name a shell would read into is never printed as a command', () => {
  const snapshot = {
    baseline: { spec: 'HEAD' },
    files: [{ rel: 'a/Banner.html', state: 'differs', versions: { fits: [{ commit: 'a'.repeat(40) }] } }],
    search: { state: 'done', refs: [{ name: 'x$(id)y', ref: 'refs/heads/x$(id)y', commit: 'b'.repeat(40) }] },
  };
  const line = servedVersionLine(snapshot);
  assert.doesNotMatch(line, /\$\(id\)/);
  assert.match(line, /use the panel to lay this checkout over the version served$/);
});

test('waiting for a search waits for the one just started, and a failing listener ends nothing', async () => {
  banner(DEPLOYED);
  fx.commit();
  fx.git('branch', 'deployed');
  banner(AHEAD);
  fx.commit();
  const served = page(DEPLOYED);
  const current = rewriter();
  const { result, sourceIndex } = await rewrite(current, served);
  const failures = [];
  const onRejection = (error) => failures.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    const tracked = new ServedVersions({
      sourceDir: fx.dir,
      rewriter: () => current,
      baseline: () => ({ spec: 'HEAD', commit: null }),
      onChange: () => {
        throw new Error('listener failed');
      },
    });
    tracked.note('/', result.drift, served, sourceIndex);
    assert.equal((await tracked.settled()).search.state, 'done');
    tracked.note('/other', result.drift, served, sourceIndex);
    assert.equal((await tracked.settled()).search.state, 'done', 'the second search, not the promise of the first');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(failures, []);
});

test('only a change the page shows as served is held back: a second change the page does not compare is still laid over', async () => {
  const text = (title, thanks) =>
    `<section class="banner" id="banner">\n  <h2 class="banner-title" id="banner-title">${title}</h2>\n  <p class="banner-note" id="banner-note">Terms apply</p>\n</section>\n{{ page.title }}\n<em>${thanks}</em>\n`;
  banner(text('Spring sale', 'Thanks for visiting'));
  fx.commit();
  fx.write(BANNER, text('Summer sale', 'Thanks, come again'));
  // The portal has the new title already; the last line stands behind a Liquid output, where nothing is compared.
  const served = page(text('Summer sale', 'Thanks for visiting').replace('{{ page.title }}', 'Home'));
  const { result } = await rewrite(rewriter(), served);
  assert.equal(result.drift.files[0].deployed, true);
  assert.ok(result.html.includes('<em>Thanks, come again</em>'), 'the change the page does not have is laid over');
  assert.equal(result.html.match(/Summer sale/g).length, 1);
});

test('a place the portal has in a version of its own keeps the served text when another place of the file is changed', async () => {
  const line = (title, lead) =>
    `<section class="banner" id="banner"><h2 class="banner-title" id="banner-title">${title}</h2><p class="banner-lead" id="banner-lead">${lead}</p><footer class="foot" id="foot"><a class="more" href="/more">More</a></footer></section>`;
  banner(line('Title', 'Old lead'));
  fx.commit();
  fx.write(BANNER, line('Title', 'New lead'));
  const served = page(line('Title as the portal has it', 'Old lead'));
  const { result } = await rewrite(rewriter(), served);
  assert.ok(result.html.includes('>New lead</p>'), 'the changed place is laid over');
  assert.ok(result.html.includes('>Title as the portal has it</h2>'), 'the place nobody changed stays the portal’s');
  assert.deepEqual(
    result.drift.places.map((place) => [place.change, place.local, place.served]),
    [['changed', 'Title', 'Title as the portal has it']],
  );
});

test('a template that is a field of a record file is told as already served by its source, not by its path', async () => {
  const HOME = '00000000-0000-0000-0000-0000000000a0';
  const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const component = (id, type, name, content) =>
    [
      `<powerpagecomponent powerpagecomponentid="${id}">`,
      `  <content>${escape(JSON.stringify(content, null, 2))}</content>`,
      `  <name>${escape(name)}</name>`,
      `  <powerpagecomponenttype>${type}</powerpagecomponenttype>`,
      '</powerpagecomponent>',
    ].join('\n');
  // An export in the enhanced data model, in a repository of its own.
  for (const entry of fs.readdirSync(fx.dir))
    if (entry !== '.git') fs.rmSync(fx.file(entry), { recursive: true, force: true });
  const put = (id, xml) => fx.write(`powerpagecomponents/${id}/powerpagecomponent.xml`, xml);
  const working = DEPLOYED.replace(
    '</section>',
    '  <a class="banner-more" href="/sale/">See the offers</a>\n</section>',
  );
  put(HOME, component(HOME, 2, 'Home', { isroot: true, partialurl: '/' }));
  put('t1', component('t1', 8, 'Banner', { source: DEPLOYED }));
  fx.commit();
  put('t1', component('t1', 8, 'Banner', { source: working }));
  const current = rewriter();
  assert.deepEqual(
    current.patches.map((patch) => patch.rel),
    ['powerpagecomponents/t1/powerpagecomponent.xml#source'],
  );
  const { result } = await rewrite(current, page(working));
  assert.deepEqual(result.applied, []);
  assert.equal(result.html.match(/banner-more/g).length, 1, 'the link the portal already serves is not added again');
  assert.deepEqual(
    result.notes.map((note) => note.rel),
    ['powerpagecomponents/t1/powerpagecomponent.xml#source'],
  );
});
