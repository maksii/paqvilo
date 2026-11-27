// @test-kind contract: the request ledger of Lense (lense/request-classes.mjs, lense/session.mjs) and the override fixes around it, designed by Paqvilo and exercised with invented fixtures on fake loopback origins
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { OverlaySession } from '../lense/session.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { PortalModel } from '../lense/portal-model.mjs';
import { Resolver } from '../lense/resolver.mjs';
import {
  RequestLedger,
  REQUEST_CLASSES,
  REQUEST_RULES,
  platformRule,
  platformAssetName,
} from '../lense/request-classes.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { startAgentServer } from '../lense/agent-server.mjs';
import { readDiscovery } from '../lense/commands/agent.mjs';
import { createFixture, SITE, HOME_ID, ONLINE_HOME, tempDirSync } from './fixture.mjs';
import { fakeBrowser, pausedAnswers as answers } from './fake-browser.mjs';

const ORIGIN = 'https://portal.example.com';
const TYPES = { Document: 'document', Script: 'script', Image: 'image', XHR: 'xhr', Fetch: 'fetch', Media: 'media' };

function fixture(t, files = {}) {
  const fx = createFixture();
  t.after(() => fx.cleanup());
  for (const [rel, content] of Object.entries(files)) fx.write(rel, content);
  return fx;
}

const overlay = (fx, { site, ...cfg } = {}) =>
  new OverlaySession({
    origin: ORIGIN,
    sourceDir: fx.dir,
    sourceMaps: false,
    ...cfg,
    site: { ...structuredClone(SITE), ...site },
  });

/**
 * A tab whose requests reach the browser's request events (as Playwright reports them) and, for the portal origin,
 * interception (as the DevTools protocol pauses them). `load` resolves once the request is answered and reported.
 */
async function tabOn(t, session, online = {}, url = `${ORIGIN}/`) {
  const b = fakeBrowser(online);
  const tab = b.openTab(url);
  t.after(session.observeRequests(b.context));
  const detach = await interceptOrigin(b.context, ORIGIN, session.route);
  t.after(detach);
  const pause = answers(tab);
  let n = 0;
  const load = async (address, { type = 'XHR', method = 'GET', status = 200, paused, headers, frameId } = {}) => {
    const full = address.startsWith('/') ? ORIGIN + address : address;
    const id = `r${++n}`;
    const main = type === 'Document' && (frameId ?? 'main') === 'main';
    const request = {
      url: () => full,
      method: () => method,
      resourceType: () => TYPES[type] ?? 'other',
      isNavigationRequest: () => type === 'Document',
      frame: () => (main ? tab.page.mainFrame() : {}),
    };
    tab.page.emit('request', request);
    if (paused ?? new URL(full).origin === ORIGIN) await pause(id, full, { type, method, headers, frameId });
    if (status !== null) tab.page.emit('response', { request: () => request, status: () => status });
    return { id, answer: b.answers(id).at(-1) };
  };
  return { b, tab, load };
}

const item = (summary, match) => summary.items.find((entry) => entry.url.includes(match));
const body = (answer) => Buffer.from(answer.body, 'base64');

test('the ledger names every request of the document and where it came from', async (t) => {
  const fx = fixture(t);
  const session = overlay(fx);
  session.disabled.add('web-files/app.js');
  const page = { headers: { 'content-type': 'text/html' }, body: '<!doctype html><p>Invented page</p>' };
  const { tab, load } = await tabOn(t, session, { [`${ORIGIN}/`]: page });
  await load('/', { type: 'Document' });
  await load('/Logo.svg', { type: 'Image' });
  await load('/Logo.svg', { type: 'Image' });
  await load('/scripts/app.js', { type: 'Script' });
  await load('/_api/contacts?$select=fullname', { type: 'XHR' });
  await load('/resource/powerappsportal/dist/app.bundle-0a1b2c3d.js', { type: 'Script' });
  await load('/missing.png', { type: 'Image', status: 404 });
  await load('https://telemetry.example.net/collect?id=42', { type: 'Image' });
  await load('https://content.powerapps.com/resource/powerappsportal/dist/preform.moment_2_29_4.bundle-abcdef12.js', {
    type: 'Script',
  });
  // A worker's request: the browser reports it, interception never pauses it.
  await load('/worker-only.js', { type: 'Script', paused: false });

  const summary = session.requestSummary(tab.page);
  assert.deepEqual(summary.counts, {
    local: 2,
    document: 1,
    export: 1,
    'portal-data': 1,
    'platform-asset': 2,
    external: 1,
    unidentified: 2,
  });
  assert.equal(summary.total, 10);
  assert.equal(summary.truncated, false);
  assert.equal(
    summary.items.reduce((total, entry) => total + entry.count, 0),
    summary.total,
    'every recorded request is listed once with its count',
  );
  assert.deepEqual(item(summary, `${ORIGIN}/`), {
    url: `${ORIGIN}/`,
    method: 'GET',
    type: 'document',
    status: 200,
    class: 'document',
    count: 1,
  });
  assert.deepEqual(item(summary, 'Logo.svg'), {
    url: `${ORIGIN}/Logo.svg`,
    method: 'GET',
    type: 'image',
    status: 200,
    class: 'local',
    rel: 'web-files/Site-Logo',
    kind: 'web-file',
    count: 2,
  });
  assert.deepEqual(
    [item(summary, 'app.js').class, item(summary, 'app.js').rel, item(summary, 'app.js').reason],
    ['export', 'web-files/app.js', 'paused'],
  );
  assert.deepEqual(
    [item(summary, '/_api/contacts').class, item(summary, '/_api/contacts').platform],
    ['portal-data', 'web-api'],
  );
  assert.equal(item(summary, 'app.bundle').platform, 'app.bundle.js');
  assert.deepEqual(
    [item(summary, 'content.powerapps.com').class, item(summary, 'content.powerapps.com').platform],
    ['platform-asset', 'preform.moment_2_29_4.bundle.js'],
  );
  assert.deepEqual(
    [item(summary, 'missing.png').class, item(summary, 'missing.png').reason, item(summary, 'missing.png').status],
    ['unidentified', 'not-found', 404],
  );
  assert.deepEqual(item(summary, 'telemetry'), {
    url: 'https://telemetry.example.net',
    method: 'GET',
    type: 'image',
    status: 200,
    class: 'external',
    count: 1,
  });
  assert.deepEqual(
    [item(summary, 'worker-only').class, item(summary, 'worker-only').reason],
    ['unidentified', 'not-intercepted'],
  );

  // The next document starts a new ledger.
  await load('/', { type: 'Document' });
  assert.deepEqual(
    session.requestSummary(tab.page).items.map((entry) => entry.class),
    ['document'],
  );
});

// @test-kind security: the ledger never keeps query values, fragments, credentials, cookies or headers of a request
test('the ledger keeps no query values, fragments, credentials or headers', async (t) => {
  const fx = fixture(t);
  const session = overlay(fx);
  const { tab, load } = await tabOn(t, session);
  await load('/_api/contacts?access_token=SECRET-VALUE&$filter=SECRET-FILTER#SECRET-FRAGMENT', {
    type: 'XHR',
    headers: { cookie: 'session=SECRET-COOKIE', authorization: 'Bearer SECRET-BEARER' },
  });
  await load('https://user:SECRET-PASSWORD@identity.example.net/authorize?state=SECRET-STATE', {
    type: 'Document',
    frameId: 'child',
  });
  await load('https://content.powerapps.com/resource/powerappsportal/dist/app.bundle-0a1b2c3d.js?v=SECRET-VERSION', {
    type: 'Script',
  });
  const text = JSON.stringify(session.requestSummary(tab.page));
  assert.equal(/SECRET/.test(text), false, text);
  assert.match(text, /access_token=%5Bredacted%5D/);
});

test('the ledger is bounded, merges repeats and still counts every request', () => {
  const ledger = new RequestLedger({ limit: 3 });
  for (const name of ['a', 'b', 'a', 'c', 'd', 'e', 'e'])
    ledger.route({ url: `${ORIGIN}/${name}.js`, method: 'GET', type: 'script', class: 'unidentified', status: 200 });
  const summary = ledger.summary();
  assert.deepEqual(
    summary.items.map((entry) => [entry.url.slice(ORIGIN.length), entry.count]),
    [
      ['/a.js', 2],
      ['/b.js', 1],
      ['/c.js', 1],
    ],
  );
  assert.equal(summary.truncated, true);
  assert.equal(summary.total, 7);
  assert.equal(summary.counts.unidentified, 7);
  assert.equal(ledger.summary({ limit: 1 }).items.length, 1);
  ledger.reset();
  assert.deepEqual(ledger.summary(), {
    total: 0,
    truncated: false,
    counts: { local: 0, document: 0, export: 0, 'portal-data': 0, 'platform-asset': 0, external: 0, unidentified: 0 },
    items: [],
  });
});

test('the panel has a group for every class a ledger entry can have, in the ledger order', () => {
  // The panel script runs in the page and cannot import the ledger module: its own table names the classes again.
  const source = fs.readFileSync(new URL('../lense/panel-ui.mjs', import.meta.url), 'utf8');
  const from = source.indexOf('const REQUEST_CLASSES = [');
  assert.ok(from > 0);
  const table = source.slice(from, source.indexOf('\n    ];', from));
  // Each row is [class, [one, many], title]: the class is the string directly before the row's inner list.
  const shown = [...table.matchAll(/\[\s*'([a-z-]+)',\s*\[/g)].map((match) => match[1]);
  assert.deepEqual(shown, [...REQUEST_CLASSES]);
});

test('the platform rules name the Mirage module that models each endpoint', () => {
  for (const rule of REQUEST_RULES) {
    assert.ok(['portal-data', 'platform-asset'].includes(rule.class), rule.platform);
    assert.ok(rule.path instanceof RegExp);
  }
  const source = fs.readFileSync(new URL('../lense/request-classes.mjs', import.meta.url), 'utf8');
  const table = source.slice(source.indexOf('export const REQUEST_RULES'), source.indexOf('].map((rule)'));
  const rules = table.split(/\n\s*\{\s*(?:\n\s*)?class:/).slice(1);
  assert.equal(rules.length, REQUEST_RULES.length);
  // The comment lines directly above each rule name the Mirage module that models it.
  for (const [index, preceding] of table
    .split(/\n\s*\{\s*(?:\n\s*)?class:/)
    .slice(0, -1)
    .entries()) {
    const lines = preceding.trim().split('\n');
    const comment = [];
    while (lines.length && lines.at(-1).trim().startsWith('//')) comment.unshift(lines.pop());
    assert.match(comment.join(' '), /\/\/ mirage\//, `rule ${index} cites its Mirage module`);
  }
  const at = (address) => platformRule(new URL(address, ORIGIN), ORIGIN);
  assert.deepEqual(at('/_api/serverlogics/orders'), { class: 'portal-data', platform: 'server-logic' });
  assert.deepEqual(at('/_api/cloudflow/v1.0/trigger/00000000-0000-0000-0000-00000000000f'), {
    class: 'portal-data',
    platform: 'cloud-flow',
  });
  assert.deepEqual(at('/_portal/00000000-0000-0000-0000-00000000000e/Resources/ResourceManager'), {
    class: 'portal-data',
    platform: 'resource-manager',
  });
  assert.deepEqual(at('/_layout/tokenhtml'), { class: 'portal-data', platform: 'anti-forgery-token' });
  assert.deepEqual(at('/SignIn'), { class: 'portal-data', platform: 'sign-in' });
  assert.deepEqual(at('/_services/entity-grid-data.json/00000000-0000-0000-0000-00000000000d'), {
    class: 'portal-data',
    platform: 'portal-service',
  });
  assert.deepEqual(at('/resource/powerappsportal/img/web.png'), { class: 'platform-asset', platform: 'img/web.png' });
  assert.equal(at('/scripts/app.js'), null);
  assert.equal(at('https://telemetry.example.net/resource/powerappsportal/x.js'), null);
  assert.equal(
    platformAssetName('/resource/powerappsportal/dist/app.BootstrapV5.bundle-3f2e1d0c.js'),
    'app.BootstrapV5.bundle.js',
  );
});

// @test-kind unproven: why an export file is not served is Paqvilo's resolver model; the page-before-web-file and language-segment rules mirror Mirage (mirage/server.mjs pageFirst, mirage/lib/redirects.mjs languageRoute) without a platform capture
test('the resolver says why a file of the export is not served', (t) => {
  const fx = fixture(t, {
    'web-files/dup-a.js': 'a',
    'web-files/dup-a.js.webfile.yml': `adx_name: dup-a\nadx_partialurl: dup.js\nadx_parentpageid: ${HOME_ID}\n`,
    'web-files/dup-b.js': 'b',
    'web-files/dup-b.js.webfile.yml': `adx_name: dup-b\nadx_partialurl: dup.js\nadx_parentpageid: ${HOME_ID}\n`,
    'web-files/old.js': 'old',
    'web-files/old.js.webfile.yml': `adx_name: old\nadx_partialurl: old.js\nadx_parentpageid: ${HOME_ID}\nstatecode: 1\n`,
    'web-files/about-file.txt': 'a web file at the URL of a page',
    'web-files/about-file.txt.webfile.yml': `adx_name: about\nadx_partialurl: about-us\nadx_parentpageid: ${HOME_ID}\n`,
  });
  const model = new PortalModel(fx.dir);
  const all = new Resolver(model, SITE);
  const reason = (resolver, url, options) => {
    const found = resolver.explain(url, options);
    return found && (found.via ?? found.reason);
  };
  assert.equal(reason(all, '/scripts/app.js'), 'web-file');
  assert.equal(all.resolve('/scripts/app.js').file, fx.file('web-files/app.js'));
  assert.equal(reason(all, '/dup.js'), 'duplicate-url');
  assert.equal(reason(all, '/old.js'), 'inactive');
  assert.equal(all.resolve('/old.js'), null);
  // A path ending with "/" and a document navigation are the page's; a sub-resource request gets the web file.
  assert.equal(reason(all, '/about-us/'), 'page-first');
  assert.equal(reason(all, '/about-us', { document: true }), 'page-first');
  assert.equal(reason(all, '/about-us'), 'web-file');
  // The first segment is a website language of the export: the web file answers without it.
  assert.equal(reason(all, '/en-US/scripts/app.js'), 'web-file');
  assert.equal(all.resolve('/en-us/Logo.svg').file, fx.file('web-files/Site-Logo'));
  // A two-letter segment that is not an exported language stays part of the path.
  assert.equal(all.explain('/xx/scripts/app.js'), null);
  assert.equal(
    reason(new Resolver(model, { ...SITE, webFiles: { enabled: true, exclude: ['/Logo.svg'] } }), '/Logo.svg'),
    'excluded',
  );
  assert.equal(reason(new Resolver(model, SITE, { changed: new Set() }), '/scripts/app.js'), 'out-of-scope');
  assert.equal(
    reason(new Resolver(model, { ...SITE, routes: [{ url: '/scripts/**', passthrough: true }] }), '/scripts/app.js'),
    'passthrough-route',
  );
  assert.equal(all.explain('/nothing-here.js'), null);
});

test('a multipart form post that navigates is sent once by the browser and its page is overlaid like any other', async (t) => {
  const fx = fixture(t);
  const session = overlay(fx);
  const { b, tab, load } = await tabOn(t, session, {
    [`${ORIGIN}/`]: { headers: { 'content-type': 'text/html' }, body: ONLINE_HOME },
  });
  await load('/', { type: 'Document' });
  assert.ok(session.pageHits.get(tab.page).some((hit) => hit.matched?.length));
  const { answer } = await load('/', {
    type: 'Document',
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=invented' },
  });
  assert.equal(
    b.fetched.length,
    1,
    'the overlay itself fetched only the first GET: the post is never sent a second time',
  );
  assert.deepEqual(
    b.staged.map((entry) => entry.url),
    [`${ORIGIN}/`],
    'the browser sent the post itself, with its response paused',
  );
  // The answer of the post is the portal's page: it is read from the paused response and handled like a GET page.
  assert.ok(['Fetch.fulfillRequest', 'Fetch.continueRequest'].includes(answer.method));
  const hits = session.pageHits.get(tab.page);
  assert.deepEqual(
    hits.map((hit) => [hit.navigation, hit.matched?.length > 0]),
    [[true, true]],
    'the previous document has no hits left, and the new one names its local sources',
  );
  const summary = session.requestSummary(tab.page);
  assert.deepEqual(
    summary.items.map((entry) => [entry.method, entry.class, entry.reason]),
    [['POST', 'document', undefined]],
  );
});

// @test-kind unproven: website-language segments of web file URLs follow Mirage's languageRoute (mirage/lib/redirects.mjs), not a platform capture
test('a language-prefixed web file URL is served from the local file', async (t) => {
  const fx = fixture(t);
  const session = overlay(fx);
  const { tab, load } = await tabOn(t, session);
  const { answer } = await load('/en-US/scripts/app.js', { type: 'Script' });
  assert.equal(answer.method, 'Fetch.fulfillRequest');
  assert.equal(body(answer).toString(), fx.read('web-files/app.js'));
  const other = await load('/xx/scripts/app.js', { type: 'Script' });
  assert.equal(other.answer.method, 'Fetch.continueRequest');
  assert.equal(item(session.requestSummary(tab.page), '/en-US/').class, 'local');
});

test('a request interception never pauses is listed as not intercepted, pending until the browser answers', async (t) => {
  const fx = fixture(t);
  const session = overlay(fx);
  const { tab, load } = await tabOn(t, session);
  await load('/scripts/app.js', { type: 'Script', paused: false, status: null });
  assert.equal(item(session.requestSummary(tab.page), 'app.js').reason, 'pending');
  tab.page.emit('response', {
    request: () => ({ url: () => `${ORIGIN}/scripts/app.js`, method: () => 'GET' }),
    status: () => 200,
  });
  const { reason } = item(session.requestSummary(tab.page), 'app.js');
  assert.equal(reason, 'pending', 'an answer to another request object does not settle this one');
  await load('/scripts/app.js', { type: 'Script', paused: false });
  assert.deepEqual(
    (({ class: kind, rel, reason: why, count }) => ({ kind, rel, why, count }))(
      item(session.requestSummary(tab.page), 'app.js'),
    ),
    { kind: 'export', rel: 'web-files/app.js', why: 'not-intercepted', count: 2 },
  );
});

test('a script the document pins with integrity is served byte for byte and checked', async (t) => {
  const fx = fixture(t);
  const session = overlay(fx, { sourceMaps: true });
  const deployed = Buffer.from(fx.read('web-files/app.js'));
  const integrity = `sha384-${crypto.createHash('sha384').update(deployed).digest('base64')}`;
  const html = `<!doctype html><script src="/scripts/app.js" integrity="${integrity}" crossorigin="anonymous"></script><script src="/Logo.svg"></script>`;
  const { tab, load } = await tabOn(t, session, {
    [`${ORIGIN}/`]: { headers: { 'content-type': 'text/html' }, body: html },
  });
  // Without an integrity attribute a script gets its source map appended.
  await load('/', { type: 'Document' });
  const pinned = await load('/scripts/app.js', { type: 'Script' });
  assert.deepEqual(body(pinned.answer), deployed, 'no source map is appended to a pinned script');
  assert.match(item(session.requestSummary(tab.page), 'app.js').note, /integrity hash: it is served byte for byte/);

  fx.write('web-files/app.js', 'console.log("edited locally");\n');
  session.refresh([fx.file('web-files/app.js')]);
  await load('/', { type: 'Document' });
  await load('/scripts/app.js', { type: 'Script' });
  assert.match(item(session.requestSummary(tab.page), 'app.js').note, /refuses the file/);
  assert.ok(
    session.pageHits.get(tab.page).some((hit) => hit.notes?.some((note) => /integrity/.test(note.reason))),
    'the mismatch is a page note',
  );

  // A document without the attribute gets the source map again.
  const plain = overlay(fx, { sourceMaps: true });
  const second = await tabOn(t, plain, {
    [`${ORIGIN}/`]: { headers: { 'content-type': 'text/html' }, body: '<!doctype html><p>No pins</p>' },
  });
  await second.load('/', { type: 'Document' });
  const mapped = await second.load('/scripts/app.js', { type: 'Script' });
  assert.match(body(mapped.answer).toString(), /sourceMappingURL/);
});

// @test-kind unproven: the web file headers follow Mirage's model of them (mirage/lib/response-headers.mjs webFileHeaders, siteHeaders; mirage/server.mjs sendFile), not a platform capture
test('a local web file keeps its record disposition, the HTTP site settings, byte ranges and HEAD length', async (t) => {
  const pdf = '%PDF-invented-bytes';
  const fx = fixture(t, {
    'web-files/report.pdf': pdf,
    'web-files/report.pdf.webfile.yml': `adx_name: Report\nadx_partialurl: report.pdf\nadx_parentpageid: ${HOME_ID}\nfilename: Quarterly report.pdf\nmimetype: application/pdf\nadx_contentdisposition: 756150001\n`,
    'sitesetting.yml':
      '- adx_sitesettingid: 00000000-0000-0000-0000-0000000000s1\n  adx_name: HTTP/X-Content-Type-Options\n  adx_value: nosniff\n- adx_sitesettingid: 00000000-0000-0000-0000-0000000000s2\n  adx_name: Search/Enabled\n  adx_value: "true"\n',
  });
  const session = overlay(fx);
  const { load } = await tabOn(t, session);
  const headersOf = (answer) =>
    Object.fromEntries(answer.responseHeaders.map(({ name, value }) => [name.toLowerCase(), value]));

  const whole = headersOf((await load('/report.pdf', { type: 'Media' })).answer);
  assert.equal(whole['content-disposition'], "attachment;filename*=UTF-8''Quarterly%20report.pdf");
  assert.equal(whole['x-content-type-options'], 'nosniff');
  assert.equal(whole['x-frame-options'], 'SAMEORIGIN');
  assert.equal(whole['accept-ranges'], 'bytes');
  assert.equal(whole['search/enabled'], undefined);
  const inline = headersOf((await load('/Logo.svg', { type: 'Image' })).answer);
  assert.equal(inline['content-disposition'], "inline;filename*=UTF-8''logo-final.svg");

  const part = (await load('/report.pdf', { type: 'Media', headers: { range: 'bytes=0-3' } })).answer;
  assert.equal(part.responseCode, 206);
  assert.equal(headersOf(part)['content-range'], `bytes 0-3/${pdf.length}`);
  assert.equal(body(part).toString(), '%PDF');
  const tail = (await load('/report.pdf', { type: 'Media', headers: { range: 'bytes=-5' } })).answer;
  assert.equal(body(tail).toString(), pdf.slice(-5));
  const outside = (await load('/report.pdf', { type: 'Media', headers: { range: 'bytes=999-' } })).answer;
  assert.equal(outside.responseCode, 416);
  assert.equal(headersOf(outside)['content-range'], `bytes */${pdf.length}`);

  const head = (await load('/report.pdf', { type: 'Media', method: 'HEAD' })).answer;
  assert.equal(head.responseCode, 200);
  assert.equal(headersOf(head)['content-length'], String(pdf.length));
  assert.equal(body(head).length, 0);
});

// @test-kind unproven: a page before a web file at one URL mirrors mirage/server.mjs pageFirst; no platform capture shows which one the portal serves
test('a web file at the URL of a page never answers the page navigation', async (t) => {
  const fx = fixture(t, {
    'web-files/about-file.txt': 'a web file at the URL of a page',
    'web-files/about-file.txt.webfile.yml': `adx_name: about\nadx_partialurl: about-us\nadx_parentpageid: ${HOME_ID}\n`,
  });
  const session = overlay(fx);
  const online = { headers: { 'content-type': 'text/html' }, body: '<!doctype html><p>About page</p>' };
  const { tab, load } = await tabOn(t, session, { [`${ORIGIN}/about-us`]: online, [`${ORIGIN}/about-us/`]: online });
  const navigation = await load('/about-us', { type: 'Document' });
  assert.equal(body(navigation.answer).toString(), online.body);
  const slash = await load('/about-us/', { type: 'Fetch' });
  assert.equal(slash.answer.method, 'Fetch.continueRequest');
  assert.equal(item(session.requestSummary(tab.page), '/about-us/').reason, 'page-first');
  const asset = await load('/about-us', { type: 'Fetch' });
  assert.equal(body(asset.answer).toString(), 'a web file at the URL of a page');
});

test('a local file that cannot be read is a fault and a ledger entry, and the portal answers', async (t) => {
  const fx = fixture(t);
  const session = overlay(fx);
  const faults = [];
  session.on('fault', (error, url) => faults.push([error.message, url]));
  session.fileBodies.read = () => {
    throw Object.assign(new Error('invented read failure'), { code: 'EACCES' });
  };
  const { tab, load } = await tabOn(t, session);
  const { answer } = await load('/scripts/app.js', { type: 'Script' });
  assert.equal(answer.method, 'Fetch.continueRequest');
  assert.equal(faults.length, 1);
  assert.match(faults[0][0], /Could not read the local file web-files\/app\.js \(EACCES\)/);
  assert.equal(faults[0][1], `${ORIGIN}/scripts/app.js`);
  assert.deepEqual(
    [item(session.requestSummary(tab.page), 'app.js').class, item(session.requestSummary(tab.page), 'app.js').reason],
    ['export', 'read-failed'],
  );
});

test('in front of Mirage catalogue routes answer from local files and the ledger is filled without serving', async (t) => {
  const fx = fixture(t, { 'dist/bundle.js': 'window.bundle = "local";\n' });
  const session = overlay(fx, { mirage: true, site: { routes: [{ url: '/bundle/*', dir: 'dist' }] } });
  const { tab, load } = await tabOn(t, session);
  await load('/', { type: 'Document' });
  const routed = await load('/bundle/bundle.js', { type: 'Script' });
  assert.equal(routed.answer.method, 'Fetch.fulfillRequest');
  assert.equal(body(routed.answer).toString(), 'window.bundle = "local";\n');
  const served = await load('/scripts/app.js', { type: 'Script' });
  assert.equal(served.answer.method, 'Fetch.continueRequest', 'Mirage serves the web files of the export');
  await load('/resource/powerappsportal/dist/app.bundle-0a1b2c3d.js', { type: 'Script' });
  const summary = session.requestSummary(tab.page);
  assert.deepEqual(
    summary.items.map((entry) => [entry.url.slice(ORIGIN.length), entry.class, entry.reason ?? entry.platform ?? null]),
    [
      ['/', 'document', 'mirage'],
      ['/bundle/bundle.js', 'local', null],
      ['/scripts/app.js', 'export', 'mirage'],
      ['/resource/powerappsportal/dist/app.bundle-0a1b2c3d.js', 'platform-asset', 'app.bundle.js'],
    ],
  );
  assert.equal(item(summary, 'bundle/bundle.js').kind, 'route');
});

test('the panel state lists frames, blocks that differ but are not applied, page-scoped pauses and the requests', async (t) => {
  const fx = fixture(t);
  const stateDir = tempDirSync('paqvilo-ledger-panel-');
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const session = overlay(fx, { site: { scope: 'changed' }, siteName: 'test', envName: 'dev', stateDir });
  session.disabled.add('web-files/app.js');
  session.disabled.add('web-files/Site-Logo');
  const about = [
    '<!doctype html><html><body><p>About</p>',
    '<script type="text/javascript">console.log("about one");',
    'console.log("about two, as deployed");',
    'console.log("about three");</script>',
    '</body></html>',
  ].join('\n');
  const online = {
    [`${ORIGIN}/about-us`]: { headers: { 'content-type': 'text/html' }, body: about },
    [`${ORIGIN}/`]: { headers: { 'content-type': 'text/html' }, body: ONLINE_HOME },
  };
  const b = fakeBrowser(online);
  const tab = b.openTab(`${ORIGIN}/about-us`);
  const panel = enablePanel(b.context, session, { open: async () => null, headless: true });
  t.after(() => panel.dispose());
  await panel.ready;
  t.after(await interceptOrigin(b.context, ORIGIN, session.route));
  const pause = answers(tab);
  await pause('doc', `${ORIGIN}/about-us`, { type: 'Document' });
  // A frame of the page shows the home page's stylesheet and form script blocks, identical to the local sources.
  await pause('frame', `${ORIGIN}/`, { type: 'Document', frameId: 'child' });
  await pause('script', `${ORIGIN}/scripts/app.js`, { type: 'Script' });
  const state = panel.stateFor(tab.page);
  assert.deepEqual(
    state.insync.map((entry) => entry.rel),
    [
      'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css',
      'basic-forms/contact/Contact.basicform.custom_javascript.js',
    ],
  );
  assert.deepEqual(
    state.notApplied.map(({ rel, state: kind, reason, differs }) => ({ rel, kind, reason, differs })),
    [
      {
        rel: 'web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js',
        kind: 'differs-not-applied',
        reason: 'out-of-scope',
        differs: true,
      },
    ],
  );
  assert.deepEqual(
    state.paused.map((entry) => entry.rel),
    ['web-files/app.js'],
  );
  assert.equal(state.pausedElsewhere, 1);
  assert.deepEqual(state.counts, {
    items: state.items.length,
    edited: 0,
    differs: 0,
    insync: 2,
    paused: 1,
    pausedElsewhere: 1,
    notApplied: 1,
  });
  assert.equal(state.requests.counts.document, 2);
  assert.equal(state.requests.counts.export, 1);
  // Out of scope comes first: switching the pause off would not serve the unchanged file either.
  assert.equal(item(state.requests, 'app.js').reason, 'out-of-scope');
});

test('the agent page state carries the request ledger and the panel rows it used to drop', async (t) => {
  const fx = fixture(t);
  const stateDir = tempDirSync('paqvilo-ledger-agent-');
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const session = overlay(fx, { siteName: 'test', envName: 'dev', stateDir, agent: { enabled: true } });
  const b = fakeBrowser({
    [`${ORIGIN}/`]: { headers: { 'content-type': 'text/html' }, body: '<!doctype html><p>Invented</p>' },
  });
  const tab = b.openTab(`${ORIGIN}/`);
  const panel = {
    stateFor: () => ({
      items: [{ rel: 'web-files/app.js', group: 'js', url: '/scripts/app.js', note: 'route /scripts/**', count: 1 }],
      insync: [{ rel: 'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css', group: 'insync' }],
      notApplied: [{ rel: 'web-pages/about/about.js', group: 'not-applied', state: 'differs-not-applied' }],
      paused: [{ rel: 'web-files/Site-Logo', group: 'paused', paused: true }],
      page: {
        sources: [{ rel: 'web-pages/home/Home.webpage.yml', kind: 'page-js', label: 'JavaScript', empty: true }],
      },
      problems: [],
      notes: [],
      needsDeploy: [],
    }),
  };
  const server = await startAgentServer({ session, context: b.context, panel, runtime: { watching: true } });
  t.after(() => server.close());
  t.after(await interceptOrigin(b.context, ORIGIN, session.route));
  const pause = answers(tab);
  await pause('doc', `${ORIGIN}/`, { type: 'Document' });
  await pause('logo', `${ORIGIN}/Logo.svg?v=SECRET-QUERY`, { type: 'Image' });
  await pause('api', `${ORIGIN}/_api/contacts`, { type: 'XHR' });
  session.pageHitsTrimmed.set(tab.page, 3);
  const discovery = await readDiscovery(server.discoveryFile);
  const response = await fetch(`${server.endpoint}/v1/pages/1/state`, {
    headers: { authorization: `Bearer ${discovery.token}` },
  });
  const state = await response.json();
  assert.deepEqual(
    state.resources.map((row) => [row.group, row.note ?? row.state ?? (row.paused ? 'paused' : null)]),
    [
      ['js', 'route /scripts/**'],
      ['insync', null],
      ['not-applied', 'differs-not-applied'],
      ['paused', 'paused'],
    ],
  );
  assert.deepEqual(state.pageFiles, [
    { rel: 'web-pages/home/Home.webpage.yml', kind: 'page-js', label: 'JavaScript', empty: true },
  ]);
  assert.equal(state.limits.hitsTrimmed, 3);
  assert.equal(state.limits.resourcesTruncated, true);
  assert.equal(state.limits.requestsTruncated, false);
  assert.equal(state.requests.total, 3);
  assert.deepEqual(
    [state.requests.counts.document, state.requests.counts.local, state.requests.counts['portal-data']],
    [1, 1, 1],
  );
  assert.equal(item(state.requests, 'Logo.svg').rel, 'web-files/Site-Logo');
  assert.equal(JSON.stringify(state.requests).includes('SECRET'), false);
  assert.equal(JSON.stringify(state).includes(discovery.token), false);
});
