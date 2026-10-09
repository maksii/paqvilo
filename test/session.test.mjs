import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OverlaySession } from '../lense/session.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { createFixture, SITE, ONLINE_HOME, HOME_ID } from './fixture.mjs';
import { fakeBrowser } from './fake-browser.mjs';
import { watchSources } from '../lense/commands/dev.mjs';
import { createSimulator } from '../mirage/server.mjs';

const ORIGIN = 'https://portal.example.com';
const fx = createFixture();
after(() => fx.cleanup());

const tick = () => new Promise((r) => setTimeout(r, 20));

const session = () => new OverlaySession({ origin: ORIGIN, sourceDir: fx.dir, site: SITE, sourceMaps: false });

test('snippet changes patch fetched HTML fragments while preserving JSON payloads', async (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  local.write('content-snippets/footer-text/Footer-Text.en-US.contentsnippet.value.html', 'Changed footer text');
  const s = new OverlaySession({ origin: ORIGIN, sourceDir: local.dir, site: structuredClone(SITE) });
  assert.equal(s.rewriter.patches.length, 1);
  const json = '{"message":"All rights reserved by the agency."}';
  const b = fakeBrowser({
    [`${ORIGIN}/fragment`]: { headers: { 'content-type': 'text/html' }, body: '<footer>All rights reserved by the agency.</footer>' },
    [`${ORIGIN}/data`]: { headers: { 'content-type': 'application/json' }, body: json },
  });
  const tab = b.openTab();
  const detach = await interceptOrigin(b.context, ORIGIN, s.route);
  t.after(detach);
  tab.pause('polling', `${ORIGIN}/data`, { type: 'XHR' });
  tab.pause('fragment', `${ORIGIN}/fragment`, { type: 'XHR' });
  await tick();
  assert.equal(b.fetched.length, 2);
  assert.equal(Buffer.from(b.answers('polling')[0].body, 'base64').toString(), json);
  assert.match(Buffer.from(b.answers('fragment')[0].body, 'base64').toString(), /Changed footer text/);
});

test('asynchronous startup preserves the synchronous model and rewrite result', async () => {
  const cfg = { origin: ORIGIN, sourceDir: fx.dir, site: SITE, sourceMaps: false };
  const sync = new OverlaySession(cfg);
  const prepared = await OverlaySession.create(cfg);
  assert.deepEqual([...prepared.model.webFileByUrl.keys()], [...sync.model.webFileByUrl.keys()]);
  assert.deepEqual([...prepared.changedFiles], [...sync.changedFiles]);
  assert.deepEqual(prepared.rewriter.rewrite(ONLINE_HOME, '/'), sync.rewriter.rewrite(ONLINE_HOME, '/'));
});

test('Mirage-rendered pages pass through unchanged while the toolkit panel API remains local', async (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  local.write('content-snippets/footer-text/Footer-Text.en-US.contentsnippet.value.html', 'Changed footer text');
  const s = new OverlaySession({ origin: ORIGIN, sourceDir: local.dir, site: structuredClone(SITE), mirage: true });
  let rewrites = 0, fallbacks = 0, panelPath = null, hit = null;
  const page = { url: () => ORIGIN + '/', isClosed: () => false };
  const request = (address, method = 'GET', type = 'document') => ({
    url: () => address,
    method: () => method,
    resourceType: () => type,
    headers: () => ({}),
    isNavigationRequest: () => true,
    frame: () => ({ page: () => page, parentFrame: () => null }),
  });
  const route = (address, method, type) => ({
    request: () => request(address, method, type),
    fallback: async () => { fallbacks++; },
    fulfill: async () => assert.fail('Mirage responses must not be rewritten or fulfilled by the overlay'),
    abort: async () => assert.fail('Mirage source navigation must not be aborted'),
  });
  s.rewriter.rewrite = () => { rewrites++; throw new Error('the remote-source rewriter must not run'); };
  s.on('hit', (entry) => { hit = entry; });
  await s.route(route(ORIGIN + '/', 'GET', 'document'));
  assert.equal(rewrites, 0);
  assert.equal(fallbacks, 1);
  assert.equal(hit.navigation, true);
  s.api = async (_route, name) => { panelPath = name; };
  await s.route(route(ORIGIN + '/__paqvilo/api/catalog', 'POST', 'fetch'));
  assert.equal(panelPath, 'catalog');
  assert.equal(fallbacks, 1);
});

test('Mirage Liquid output is not patched a second time by the remote overlay', async (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  const copy = 'web-pages/home/content-pages/Home.en-US.webpage.copy.html';
  const snippet = 'content-snippets/promo/Promo.en-US.contentsnippet.value.html';
  local.write(copy, "<p id=\"liquid\">{{ snippets['Promo'] }}</p><span id=\"literal\">Old local greeting</span>");
  local.write(snippet, 'Old local greeting');
  local.commit();
  local.write(snippet, 'New local greeting');
  const app = await createSimulator({
    sourceDir: local.dir,
    initial: { version: 1, mappings: {}, tables: {}, permissions: [], settings: { permissionMode: 'permissive' }, simulator: { mode: 'local', pageMode: 'local', identity: { id: 'person', roles: [] }, endpoints: [], live: {} } },
    watch: false,
  });
  t.after(() => app.close());
  const rendered = await (await fetch(app.url + '/')).text();
  assert.match(rendered, /id="liquid">New local greeting/);
  assert.match(rendered, /id="literal">Old local greeting/);

  const ordinary = new OverlaySession({ origin: app.url, sourceDir: local.dir, site: structuredClone(SITE) });
  const incorrectlyOverlaid = ordinary.rewriter.rewrite(rendered, '/').html;
  assert.match(incorrectlyOverlaid, /id="literal">New local greeting/, 'the remote-site markup overlay would rewrite the already-rendered page copy');

  const mirage = new OverlaySession({ origin: app.url, sourceDir: local.dir, site: structuredClone(SITE), mirage: true });
  mirage.rewriter.rewrite = () => assert.fail('Mirage HTML must not enter the remote-site markup rewriter');
  const page = { url: () => app.url + '/', isClosed: () => false };
  let fallbacks = 0;
  const route = {
    request: () => ({ url: () => app.url + '/', method: () => 'GET', resourceType: () => 'document', headers: () => ({}), isNavigationRequest: () => true, frame: () => ({ page: () => page, parentFrame: () => null }) }),
    fallback: async () => { fallbacks++; },
    fulfill: async () => assert.fail('Mirage responses must be passed through'),
    abort: async () => assert.fail('Mirage navigation must remain available'),
  };
  await mirage.route(route);
  assert.equal(fallbacks, 1);
});

test('HEAD reads no asset bytes and repeated mapped GETs reuse source-map work', async () => {
  const s = new OverlaySession({ origin: ORIGIN, sourceDir: fx.dir, site: SITE, sourceMaps: true });
  const b = fakeBrowser();
  const tab = b.openTab();
  const detach = await interceptOrigin(b.context, ORIGIN, s.route);
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function(file, ...args) {
    if (path.resolve(String(file)) === path.join(fx.dir, 'web-files/app.js')) reads++;
    return read.call(this, file, ...args);
  };
  try {
    tab.pause('head', `${ORIGIN}/scripts/app.js`, { type: 'Script', method: 'HEAD' });
    await tick();
    assert.equal(reads, 0);
    assert.equal(b.answers('head')[0].responseCode, 200);
    tab.pause('get1', `${ORIGIN}/scripts/app.js`, { type: 'Script' });
    await tick();
    tab.pause('get2', `${ORIGIN}/scripts/app.js`, { type: 'Script' });
    await tick();
    assert.equal(reads, 1);
    assert.equal(b.answers('get1')[0].body, b.answers('get2')[0].body);
  } finally {
    fs.readFileSync = read;
    await detach();
  }
});

test('an external route save does not rebuild the unrelated portal index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-route-refresh-'));
  try {
    const file = path.join(dir, 'external.js');
    fs.writeFileSync(file, 'original');
    const s = new OverlaySession({ origin: ORIGIN, sourceDir: fx.dir, site: { ...SITE, routes: [{ url: '/external.js', file }] }, sourceMaps: false });
    let reloads = 0;
    s.model.load = () => { reloads++; };
    s.fileBodies.read(file);
    fs.writeFileSync(file, 'changed');
    s.refresh([file]);
    assert.equal(reloads, 0);
    assert.equal(s.fileBodies.read(file).toString(), 'changed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('background HTML history deduplicates polling and bounds retained inline bodies', async () => {
  const s = session();
  const page = {};
  const online = 'x'.repeat(1024 * 1024);
  s.rewriter = { patches: [{}], rewrite: () => ({ html: 'edited', applied: [{ rel: 'snippet', action: 'patched', kind: 'content-snippet' }], notes: [], matched: [{ rel: 'script', online }] }) };
  const route = (suffix) => ({
    request: () => ({ url: () => `${ORIGIN}/fragment/${suffix}`, method: () => 'GET', resourceType: () => 'fetch', frame: () => ({ page: () => page }), headers: () => ({}) }),
    fetch: async () => ({ headers: () => ({ 'content-type': 'text/html' }), status: () => 200, text: async () => 'original' }),
    fulfill: async () => {}, fallback: async () => {}, abort: async () => {},
  });
  await s.route(route('same'));
  await s.route(route('same'));
  assert.equal(s.pageHits.get(page).length, 1);
  assert.equal(s.pageHits.get(page)[0].count, 2);
  for (let i = 0; i < 12; i++) await s.route(route(i));
  assert.ok(s.pageHitBytes.get(page) <= 8 * 1024 * 1024);
  assert.equal(s.pageHits.get(page).at(-1).url, '/fragment/11');
});

test('only the portal origin is intercepted, in every tab, also in tabs opened later', async () => {
  const b = fakeBrowser();
  b.openTab();
  await interceptOrigin(b.context, ORIGIN, async () => {});
  const later = b.openTab();
  b.context.emit('page', later.page);
  await tick();
  const enabled = b.sent.filter((s) => s.method === 'Fetch.enable');
  assert.equal(enabled.length, 2);
  assert.deepEqual(enabled[0].patterns, [{ urlPattern: `${ORIGIN}/*` }]);
  // the browser must ask again for a file once its local version comes into play
  assert.equal(b.sent.filter((s) => s.method === 'Network.setCacheDisabled' && s.cacheDisabled === true).length, 2);
});

test('every paused request is answered: also when the handler ignores it or throws', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  let calls = 0;
  await interceptOrigin(b.context, ORIGIN, async () => {
    if (++calls === 2) throw new Error('boom');
  });
  tab.pause('r1', `${ORIGIN}/_api/things`);
  tab.pause('r2', `${ORIGIN}/_api/things`);
  await tick();
  assert.deepEqual(b.answers('r1').map((a) => a.method), ['Fetch.continueRequest']);
  assert.deepEqual(b.answers('r2').map((a) => a.method), ['Fetch.continueRequest']);
});

test('a web file is answered from disk and the portal is not asked', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, session().route);
  tab.pause('r1', `${ORIGIN}/scripts/app.js`, { type: 'Script' });
  await tick();
  const [answer] = b.answers('r1');
  assert.equal(answer.method, 'Fetch.fulfillRequest');
  assert.equal(answer.responseCode, 200);
  assert.equal(Buffer.from(answer.body, 'base64').toString(), fx.read('web-files/app.js'));
  assert.ok(answer.responseHeaders.some((h) => h.name === 'content-type' && /javascript/.test(h.value)));
  assert.equal(b.fetched.length, 0);
});

test('a page is fetched online with the request as the browser made it, rewritten, and answered once', async () => {
  fx.write('web-pages/home/content-pages/Home.en-US.webpage.custom_css.css', '.hero {\n  color: blue;\n}\n.card {\n  margin: 0;\n}\n.footer {\n  padding: 1px;\n}\n');
  const b = fakeBrowser({
    [`${ORIGIN}/`]: { headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': '123', 'set-cookie': 'a=1' }, body: ONLINE_HOME },
  });
  const tab = b.openTab();
  const s = session();
  const hits = [];
  s.on('hit', (h) => hits.push(h));
  await interceptOrigin(b.context, ORIGIN, s.route);
  tab.pause('r1', `${ORIGIN}/`, { type: 'Document', headers: { Cookie: 'session=x', Accept: 'text/html', Host: 'portal.example.com' } });
  await tick();
  // cookies come from the browser's own jar, not from the copied header
  assert.deepEqual(b.fetched[0].headers, { accept: 'text/html' });
  assert.equal(b.fetched[0].maxRedirects, 0);
  const answers = b.answers('r1');
  assert.equal(answers.length, 1);
  const body = Buffer.from(answers[0].body, 'base64').toString();
  assert.match(body, /color: blue;/);
  const names = answers[0].responseHeaders.map((h) => h.name.toLowerCase());
  assert.ok(!names.includes('content-encoding'), 'the body is sent decoded');
  assert.ok(names.includes('set-cookie'));
  assert.equal(answers[0].responseHeaders.find((h) => h.name === 'content-length').value, String(Buffer.byteLength(body)));
  assert.equal(hits[0].navigation, true);
  assert.equal(hits[0].page, tab.page);
  fx.write('web-pages/home/content-pages/Home.en-US.webpage.custom_css.css', '.hero {\n  color: red;\n}\n.card {\n  margin: 0;\n}\n.footer {\n  padding: 1px;\n}\n');
});

test('a form post carries its body to the portal', async () => {
  const b = fakeBrowser({ [`${ORIGIN}/about-us/`]: { headers: { 'content-type': 'text/html' }, body: '<html><body>saved</body></html>' } });
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, session().route);
  tab.pause('r1', `${ORIGIN}/about-us/`, { type: 'Document', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, postData: 'a=1&b=2' });
  await tick();
  assert.equal(b.fetched[0].method, 'POST');
  assert.equal(b.fetched[0].timeout, 120_000, 'stalled API work must have a bounded lifetime');
  assert.equal(b.fetched[0].data, 'a=1&b=2');
  assert.equal(b.answers('r1')[0].method, 'Fetch.fulfillRequest');
});

test('a redirect is handed to the browser as it is', async () => {
  const b = fakeBrowser({ [`${ORIGIN}/about-us`]: { status: 301, headers: { location: '/about-us/' } } });
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, session().route);
  tab.pause('r1', `${ORIGIN}/about-us`, { type: 'Document' });
  await tick();
  const [answer] = b.answers('r1');
  assert.equal(answer.responseCode, 301);
  assert.ok(answer.responseHeaders.some((h) => h.name === 'location' && h.value === '/about-us/'));
});

test('data requests, posts of data and sign-in pages go to the portal untouched', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, session().route);
  tab.pause('r1', `${ORIGIN}/_api/things`);
  tab.pause('r2', `${ORIGIN}/_api/things`, { method: 'POST', postData: '{}' });
  tab.pause('r3', `${ORIGIN}/en-US/SignIn`, { type: 'Document' });
  await tick();
  for (const id of ['r1', 'r2', 'r3']) assert.deepEqual(b.answers(id).map((a) => a.method), ['Fetch.continueRequest']);
  assert.equal(b.fetched.length, 0);
});

test('when the portal cannot be reached a page request goes back to the browser', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, session().route);
  tab.pause('r1', `${ORIGIN}/gone/`, { type: 'Document' });
  await tick();
  assert.deepEqual(b.answers('r1').map((a) => a.method), ['Fetch.continueRequest']);
});

test('the first custom JavaScript file of a page is picked up when it is created', () => {
  const s = session();
  const rel = 'web-pages/scripts/content-pages/Scripts.en-US.webpage.custom_javascript.js';
  const page = '<html><head></head><body><p>scripts</p></body></html>';
  assert.equal(s.rewriter.rewrite(page, '/scripts/').applied.length, 0);
  fx.write(rel, 'console.log("first script of this page");\n');
  s.refresh([fx.file(rel)]);
  const result = s.rewriter.rewrite(page, '/scripts/');
  assert.deepEqual(result.applied.map((a) => `${a.action} ${a.rel}`), [`injected (not online yet) ${rel}`]);
  assert.match(result.html, /first script of this page/);
  fs.rmSync(fx.file(rel));
  s.refresh([fx.file(rel)]);
  assert.equal(s.rewriter.rewrite(page, '/scripts/').applied.length, 0);
});

test('a tab that loaded its page before interception was on is loaded once more', async () => {
  const b = fakeBrowser();
  const early = b.openTab(`${ORIGIN}/about-us/`);
  await interceptOrigin(b.context, ORIGIN, async () => {});
  assert.equal(early.page.reloads, 1);
  // a tab whose page did go through interception is left alone
  const normal = b.openTab(`${ORIGIN}/`);
  b.context.emit('page', normal.page);
  await tick();
  normal.pause('r1', `${ORIGIN}/`, { type: 'Document' });
  await tick();
  normal.page.emit('domcontentloaded');
  assert.equal(normal.page.reloads, 1, 'it had the portal address before interception was on');
  const fresh = b.openTab('about:blank');
  b.context.emit('page', fresh.page);
  await tick();
  fresh.pause('r2', `${ORIGIN}/`, { type: 'Document' });
  await tick();
  fresh.page.emit('domcontentloaded');
  assert.equal(fresh.page.reloads, 0);
});

test('a failed rewrite preserves a completed form POST response without resubmitting', async () => {
  const original = '<html><body>saved exactly once</body></html>';
  const b = fakeBrowser({ [`${ORIGIN}/save/`]: { headers: { 'content-type': 'text/html' }, body: original } });
  const tab = b.openTab();
  const s = session();
  s.rewriter.rewrite = () => { throw new Error('invalid local markup'); };
  const faults = [];
  s.on('fault', (err) => faults.push(err.message));
  await interceptOrigin(b.context, ORIGIN, s.route);
  tab.pause('save', `${ORIGIN}/save/`, { type: 'Document', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, postData: 'save=1' });
  await tick();
  assert.equal(b.fetched.length, 1);
  assert.deepEqual(b.answers('save').map((a) => a.method), ['Fetch.fulfillRequest']);
  assert.equal(Buffer.from(b.answers('save')[0].body, 'base64').toString(), original);
  assert.deepEqual(faults, ['invalid local markup']);
});

test('a form request that fails or times out is aborted without browser resubmission', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, session().route);
  tab.pause('timeout', `${ORIGIN}/save/`, { type: 'Document', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, postData: 'save=1' });
  await tick();
  assert.equal(b.fetched.length, 1);
  assert.equal(b.fetched[0].timeout, 120_000);
  assert.deepEqual(b.answers('timeout').map((a) => a.method), ['Fetch.failRequest']);
});

test('an internal API fault is aborted and never forwarded to the portal', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  const s = session();
  s.api = () => { throw new Error('panel failed'); };
  await interceptOrigin(b.context, ORIGIN, s.route);
  tab.pause('api-fault', `${ORIGIN}/__paqvilo/api/open`, { type: 'Fetch', method: 'POST', postData: '{}' });
  await tick();
  assert.deepEqual(b.answers('api-fault').map((a) => a.method), ['Fetch.failRequest']);
  assert.equal(b.fetched.length, 0);
});

test('authentication endpoints stay online even if an explicit local route matches them', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  const s = new OverlaySession({ origin: ORIGIN, sourceDir: fx.dir, site: { ...SITE, routes: [{ url: '/**', file: 'web-files/app.js' }] } });
  await interceptOrigin(b.context, ORIGIN, s.route);
  for (const [id, url] of [['signin', '/en-US/signin'], ['account', '/account'], ['auth', '/.auth/login']]) {
    tab.pause(id, `${ORIGIN}${url}`, { type: 'Document' });
  }
  await tick();
  for (const id of ['signin', 'account', 'auth']) assert.deepEqual(b.answers(id).map((a) => a.method), ['Fetch.continueRequest']);
});

test('a web file payload created after its metadata is picked up on save', () => {
  const metadata = 'web-files/late.css.webfile.yml';
  const payload = 'web-files/late.css';
  fx.write(metadata, `adx_partialurl: late.css\nfilename: late.css\nadx_parentpageid: ${HOME_ID}\n`);
  try {
    const s = session();
    assert.equal(s.resolver.resolve('/late.css'), null);
    fx.write(payload, '.late { color: green; }');
    s.refresh([fx.file(payload)]);
    assert.equal(s.resolver.resolve('/late.css')?.file, fx.file(payload));
  } finally {
    fs.rmSync(fx.file(metadata), { force: true });
    fs.rmSync(fx.file(payload), { force: true });
  }
});

test('repeated file requests retain a count without growing per-tab history', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  const s = session();
  await interceptOrigin(b.context, ORIGIN, s.route);
  for (let n = 0; n < 50; n++) tab.pause(`repeat-${n}`, `${ORIGIN}/scripts/app.js`, { type: 'Script' });
  await tick();
  const hits = s.pageHits.get(tab.page);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 50);
});

test('committing a local edit removes its changed-scope override without another source save', async () => {
  const local = createFixture();
  const site = structuredClone(SITE);
  site.scope = 'changed';
  local.write('web-files/app.js', 'console.log("committed edit");\n');
  const s = new OverlaySession({ origin: ORIGIN, sourceDir: local.dir, site });
  assert.ok(s.resolver.resolve('/scripts/app.js'));
  const b = fakeBrowser();
  const tab = b.openTab(`${ORIGIN}/`);
  const watcher = watchSources(s, b.context, { baselinePollMs: 50, log: () => {} });
  let timer;
  try {
    await new Promise((resolve) => watcher.once('ready', resolve));
    const changed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('committed baseline was not refreshed')), 10000);
      s.on('refreshed', (event) => { if (event.baselineChanged) resolve(event); });
    });
    local.commit();
    await changed;
    assert.equal(s.resolver.resolve('/scripts/app.js'), null);
    assert.equal(tab.page.reloads, 1);
  } finally {
    clearTimeout(timer);
    await watcher.close();
    local.cleanup();
  }
});

test('startup reconciles markup and URL metadata saved during async source prefetch', async (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  const read = fs.promises.readFile;
  let edited = false;
  t.mock.method(fs.promises, 'readFile', async function(file, ...args) {
    const text = await read.call(this, file, ...args);
    if (!edited && String(file).endsWith('.webpage.custom_css.css')) {
      edited = true;
      local.write('content-snippets/footer-text/Footer-Text.en-US.contentsnippet.value.html', 'All rights reserved by the local team.');
      const metadata = 'web-pages/scripts/Scripts.webpage.yml';
      local.write(metadata, local.read(metadata).replace('adx_partialurl: scripts', 'adx_partialurl: updated-scripts'));
    }
    return text;
  });
  const s = await OverlaySession.create({ origin: ORIGIN, sourceDir: local.dir, site: SITE });
  assert.equal(edited, true);
  assert.match(s.rewriter.rewrite(ONLINE_HOME, '/').html, /All rights reserved by the local team\./);
  assert.equal(s.resolver.resolve('/scripts/app.js'), null);
  assert.equal(s.resolver.resolve('/updated-scripts/app.js')?.file, local.file('web-files/app.js'));
});

test('a baseline discovered during an unrelated save rebuilds every markup patch', async (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  const snippet = 'content-snippets/footer-text/Footer-Text.en-US.contentsnippet.value.html';
  const asset = 'web-files/app.js';
  local.write(snippet, 'All rights reserved by the local team.');
  const s = new OverlaySession({ origin: ORIGIN, sourceDir: local.dir, site: SITE });
  assert.equal(s.rewriter.patches.length, 1);
  local.commit();
  local.write(asset, 'console.log("saved after commit");');
  assert.equal(s.refresh([local.file(asset)]).baselineChanged, true);
  assert.equal(s.rewriter.patches.length, 0);

  local.write(snippet, 'All rights reserved by the newer local team.');
  s.refresh([local.file(snippet)]);
  assert.equal(s.rewriter.patches.length, 1);
  local.commit();
  assert.equal(await s.baseline.checkForUpdate(), true);
  // The poll has already updated baseline.commit, so comparing before/after this save is insufficient.
  assert.equal(s.refresh([local.file(asset)]).baselineChanged, true);
  assert.equal(s.rewriter.patches.length, 0);
});

test('web-only saves prepare bytes without synchronous Git and publish tracking asynchronously', async (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  const s = new OverlaySession({ origin: ORIGIN, sourceDir: local.dir, site: SITE });
  const file = local.file('web-files/app.js');
  const tracked = s.changedFiles;
  s.fileBodies.read(file);
  local.write('web-files/app.js', 'console.log("fresh local asset");');
  const scan = t.mock.method(s.baseline, 'changedFiles', () => assert.fail('preparing bytes must not run synchronous Git'));
  const result = s.refresh([file], { deferChangeTracking: true });
  assert.equal(result.changeTrackingDeferred, true);
  assert.equal(scan.mock.callCount(), 0);
  assert.equal(s.fileBodies.read(file).toString(), 'console.log("fresh local asset");');
  assert.equal(tracked.has(file), false);
  assert.equal((await s.refreshChangeTracking([file])).baselineChanged, false);
  assert.equal(s.changedFiles, tracked, 'panel and rewriter retain the shared snapshot object');
  assert.equal(tracked.has(file), true);
});

test('watch readiness reconciles edits made after session creation before first navigation', async (t) => {
  const local = createFixture();
  t.after(() => local.cleanup());
  const s = await OverlaySession.create({ origin: ORIGIN, sourceDir: local.dir, site: SITE });
  local.write('content-snippets/footer-text/Footer-Text.en-US.contentsnippet.value.html', 'All rights reserved by the watcher team.');
  const watcher = watchSources(s, { pages: () => [] }, { log: () => {} });
  try {
    await watcher.ready;
    assert.match(s.rewriter.rewrite(ONLINE_HOME, '/').html, /All rights reserved by the watcher team\./);
  } finally { await watcher.close(); }
});
