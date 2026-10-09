import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OverlaySession } from '../lense/session.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { enablePanel, comparison, openInEditor } from '../lense/panel.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { createFixture, SITE } from './fixture.mjs';
import { fakeBrowser } from './fake-browser.mjs';

const ORIGIN = 'https://portal.example.com';
const fx = createFixture();
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-panel-'));
const panels = [];
after(() => {
  panels.forEach((panel) => panel.dispose());
  fx.cleanup();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** A dev loop with one tab on the portal, and a way to press the buttons of its panel. */
async function setup(online = {}) {
  const b = fakeBrowser(online);
  const tab = b.openTab(`${ORIGIN}/scripts/`);
  const session = new OverlaySession({ origin: ORIGIN, sourceDir: fx.dir, site: structuredClone(SITE), sourceMaps: false, siteName: 'test', envName: 'dev', stateDir });
  const opened = [];
  const panel = enablePanel(b.context, session, {
    open: async (...args) => {
      opened.push(args);
      return null;
    },
  });
  panels.push(panel);
  await interceptOrigin(b.context, ORIGIN, session.route);
  const { token } = panel.stateFor(tab.page);
  let n = 0;
  const call = async (name, body, headers = { 'x-paqvilo-token': token }) => {
    const id = `api${++n}`;
    tab.pause(id, `${ORIGIN}/__paqvilo/api/${name}`, { type: 'Fetch', method: 'POST', headers, postData: JSON.stringify(body ?? {}) });
    await tick();
    const answers = b.answers(id);
    assert.equal(answers.length, 1);
    assert.equal(answers[0].method, 'Fetch.fulfillRequest', 'a request of the panel is never sent to the portal');
    return { status: answers[0].responseCode, ...JSON.parse(Buffer.from(answers[0].body, 'base64').toString()) };
  };
  return { b, tab, session, panel, call, opened };
}

test('the panel function is self-contained: it is sent to the browser as text', () => {
  // must compile on its own, without this module around it
  assert.doesNotThrow(() => new Function(`return (${panelUi.toString()})`));
});

test('selective CSS refresh preserves an unrelated tab\'s earlier pending save and baseline banner', async () => {
  const { b, tab, session, panel } = await setup();
  const home = b.openTab(`${ORIGIN}/`);
  const script = fx.file('web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js');
  const asset = fx.file('web-files/app.js');
  session.emit('refreshed', { files: [asset], how: 'none', baselineChanged: true });
  const css = fx.file('web-pages/home/content-pages/Home.en-US.webpage.custom_css.css');
  session.emit('refreshed', { files: [css], how: 'css', pageResults: new Map([
    [home.page, { how: 'css', files: [css] }], [tab.page, { how: 'skipped', files: [] }],
  ]) });
  assert.deepEqual(panel.stateFor(tab.page).pending, [session.rel(asset)]);
  assert.equal(panel.stateFor(tab.page).pendingBaseline, true);
  assert.equal(panel.stateFor(tab.page).lastChange.how, 'skipped', 'an unrelated tab must not announce a reload');
  assert.deepEqual(panel.stateFor(home.page).pending, [session.rel(asset)], 'CSS does not apply an earlier pending script save');
  session.emit('refreshed', { files: [script], how: 'none' });
  assert.deepEqual(panel.stateFor(home.page).pending, [session.rel(asset)], 'paused reload only marks affected pages');
  session.emit('refreshed', { files: [], how: 'none', baselineChanged: true });
  assert.equal(panel.stateFor(home.page).pendingBaseline, true);
});

test('a comparison lists changed lines with a little context and folds the rest', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const changed = before.replace('line 15', 'line fifteen').replace('line 30', 'line 30\nline 31');
  const c = comparison(before, changed);
  assert.equal(c.added, 2);
  assert.equal(c.removed, 1);
  assert.deepEqual(c.lines.filter((l) => l[0] === '-'), [['-', 15, null, 'line 15']]);
  assert.deepEqual(c.lines.filter((l) => l[0] === '+'), [['+', null, 15, 'line fifteen'], ['+', null, 31, 'line 31']]);
  assert.deepEqual(c.lines[0], ['@', null, null, '11 unchanged lines']);
  assert.deepEqual(c.lines[1], [' ', 12, 12, 'line 12']);
  assert.equal(comparison('a\r\nb\r\n', 'a\nb\n').lines.length, 0, 'line endings are not a difference');
});

test('what a tab served from local sources is what its panel lists', async () => {
  const { tab, panel } = await setup();
  tab.pause('r1', `${ORIGIN}/scripts/app.js`, { type: 'Script' });
  tab.pause('r2', `${ORIGIN}/scripts/app.js`, { type: 'Script' });
  await tick(350);
  const [item, ...more] = panel.stateFor(tab.page).items;
  assert.equal(more.length, 0);
  assert.deepEqual(
    { rel: item.rel, url: item.url, group: item.group, count: item.count, edited: item.edited },
    { rel: 'web-files/app.js', url: '/scripts/app.js', group: 'js', count: 2, edited: false },
  );
  assert.equal(panel.stateFor(tab.page).page.path, '/scripts');
  assert.equal(tab.page.drawn.items.length, 1, 'the tab was redrawn');
});

test('the buttons only work for the panel itself', async () => {
  const { call, session } = await setup();
  const refused = await call('mode', { online: true }, {});
  assert.equal(refused.status, 403);
  assert.equal(session.bypass, false);
  assert.equal((await call('nothing-like-this', {})).status, 403);
});

test('a file opens in the editor at the line asked for, and only files of the sources do', async () => {
  const { call, opened } = await setup();
  assert.equal((await call('open', { rel: 'web-files/app.js', line: 7, col: 3 })).ok, true);
  assert.deepEqual(opened, [['code', fx.file('web-files/app.js'), 7, 3]]);
  assert.equal((await call('open', { rel: '../../outside.txt' })).ok, false);
  assert.equal((await call('open', { rel: 'web-files/missing.js' })).ok, false);
  assert.equal(opened.length, 1);
});

test('a paused override shows the online file until it is switched back on', async () => {
  const { b, tab, call, panel } = await setup();
  assert.equal((await call('toggle', { rel: 'web-files/app.js', off: true })).ok, true);
  tab.pause('r1', `${ORIGIN}/scripts/app.js`, { type: 'Script' });
  await tick();
  assert.deepEqual(b.answers('r1').map((a) => a.method), ['Fetch.continueRequest']);
  assert.deepEqual(panel.stateFor(tab.page).paused.map((p) => p.rel), ['web-files/app.js']);
  await call('toggle', { rel: 'web-files/app.js', off: false });
  tab.pause('r2', `${ORIGIN}/scripts/app.js`, { type: 'Script' });
  await tick();
  assert.equal(b.answers('r2')[0].method, 'Fetch.fulfillRequest');
});

test('online mode overrides nothing, and the panel still answers', async () => {
  const { b, tab, call, panel } = await setup();
  await call('mode', { online: true });
  tab.pause('r1', `${ORIGIN}/scripts/app.js`, { type: 'Script' });
  tab.pause('r2', `${ORIGIN}/`, { type: 'Document' });
  await tick();
  assert.deepEqual(b.answers('r1').map((a) => a.method), ['Fetch.continueRequest']);
  assert.deepEqual(b.answers('r2').map((a) => a.method), ['Fetch.continueRequest']);
  assert.equal(panel.stateFor(tab.page).online, true);
  await call('mode', { online: false });
  tab.pause('r3', `${ORIGIN}/scripts/app.js`, { type: 'Script' });
  await tick();
  assert.equal(b.answers('r3')[0].method, 'Fetch.fulfillRequest');
});

test('a web file is compared with what the environment serves', async () => {
  const { call } = await setup({ [`${ORIGIN}/scripts/app.js`]: { body: 'console.log("online app");\n' } });
  const diff = await call('diff', { rel: 'web-files/app.js', url: '/scripts/app.js' });
  assert.equal(diff.ok, true);
  assert.equal(diff.against, 'dev online');
  assert.deepEqual(diff.lines.filter((l) => l[0] !== ' '), [['-', 1, null, 'console.log("online app");'], ['+', null, 1, 'console.log("app");']]);
});

test('scope and live reload are switched while the loop runs; the position is remembered', async () => {
  const { call, session } = await setup();
  await call('scope', { scope: 'changed' });
  assert.equal(session.cfg.site.scope, 'changed');
  assert.equal(session.resolver.resolve('/scripts/app.js'), null, 'nothing is changed against the baseline');
  assert.equal((await call('scope', { scope: 'everything' })).ok, false);
  await call('live', { on: false });
  assert.equal(session.liveReload, false);
  await call('ui', { pos: { h: 'right', v: 'top', dx: 20, dy: 30 }, hidden: true, somethingElse: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'panel.json'), 'utf8')), { pos: { h: 'right', v: 'top', dx: 20, dy: 30 }, hidden: true });
});

test('lookalike portal origins receive neither the panel nor its token', async () => {
  const { b, panel } = await setup();
  for (const url of [`${ORIGIN}.evil.test/`, `${ORIGIN}:444/`, 'about:blank']) {
    const tab = b.openTab(url);
    await panel.draw(tab.page);
    assert.equal(tab.page.drawn, null);
  }
});

test('panel state exposes configured destinations while retaining the active session identity', async () => {
  const { session, tab, panel } = await setup();
  session.cfg.devTargets = [{ siteName: 'other', envName: 'test', origin: 'https://other.example', startPath: '/home/', caution: true, privateConfig: 'excluded' }];
  const state = panel.stateFor(tab.page);
  assert.equal(state.origin, ORIGIN);
  assert.equal(state.site, 'test'); assert.equal(state.env, 'dev');
  assert.deepEqual(state.targets, [{ siteName: 'other', envName: 'test', origin: 'https://other.example', startPath: '/home/', caution: true }]);
});

/** A Mirage answering the panel's admin requests from a synthetic report. */
function fakeMirage(b, { report, status = {}, personas = null, onWrite } = {}) {
  const calls = [];
  const response = (value, code = 200) => ({ ok: () => code < 400, status: () => code, json: async () => value });
  b.context.request.get = async (url) => {
    calls.push(['GET', String(url)]);
    if (String(url).includes('/page-resources?')) return response(structuredClone(report));
    if (String(url).includes('/personas')) return personas ? response(personas) : response({ error: { message: 'missing' } }, 404);
    if (String(url).includes('/status')) return response({ csrf: 'panel-csrf', site: 'Test', format: 'standard', sourceDir: fx.dir, revision: 7, sourceFingerprint: 'f'.repeat(64), diagnostics: { total: 3 }, identity: { name: 'Anonymous', roles: [] }, permissionMode: 'enforce', presets: [{ id: 'demo', name: 'Demo' }], scenarios: [{ id: 'reviewer', name: 'Reviewer' }], ...status });
    return response({}, 404);
  };
  b.context.request.fetch = async (url, options = {}) => {
    calls.push([options.method, String(url), options.headers?.['x-sim-csrf'], options.data]);
    const result = onWrite ? await onWrite(String(url), options) : { status: 200, body: { identity: { name: 'Switched' } } };
    return response(result.body, result.status);
  };
  return calls;
}

test('Mirage inspection: redraws carry a compact summary; the Inspect report arrives on request with openable portal and Solution sources', async () => {
  const { b, tab, session, panel, call, opened } = await setup();
  const solution = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-solution-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-unlisted-'));
  try {
    const entity = path.join(solution, 'Entities', 'contact', 'Entity.xml');
    fs.mkdirSync(path.dirname(entity), { recursive: true });
    fs.writeFileSync(entity, '<Entity>\n  <attributes>\n    <attribute>\n      <LogicalName>fullname</LogicalName>\n    </attribute>\n  </attributes>\n</Entity>\n');
    fs.writeFileSync(path.join(outside, 'secret.xml'), '<secret/>');
    session.cfg.mirage = true;
    session.cfg.mirageSourceRoots = [fx.dir, solution];
    const report = {
      path: '/scripts', sourceRoots: [fx.dir, solution, outside],
      page: { name: 'Scripts', pageName: 'Scripts', url: '/scripts/', sourceFile: fx.file('web-pages/scripts/Scripts.webpage.yml'), access: { allowed: true, rules: [] } },
      pageTemplate: null,
      webTemplates: [{ kind: 'web-template', name: 'Header', relativePath: 'web-templates/header/Header.webtemplate.yml' }],
      snippets: [], siteSettings: [], forms: [], views: [], columns: [{ entity: 'contact', name: 'fullname', sourceFile: entity }],
      tables: [{ kind: 'table', name: 'contact', logicalName: 'contact', sourceFile: entity, sourceFiles: [entity, path.join(outside, 'secret.xml')] }],
      components: [], usages: [], dependencies: [], unresolved: [], templateChain: [],
      related: { weblinks: [], sitemarkers: [], redirects: [], shortcuts: [{ name: 'Elsewhere', sourceFile: path.join(outside, 'secret.xml') }] },
    };
    fakeMirage(b, { report });
    session.emit('hit', { page: tab.page, navigation: true });
    await tick(80);
    const state = panel.stateFor(tab.page);
    assert.equal(state.mirage.active, true);
    assert.equal(state.git, null, 'Mirage pages do not advertise a Git deployment baseline');
    assert.equal(state.mirage.counts.templates, 1);
    assert.equal(state.mirage.counts.tables, 1);
    assert.equal(state.mirage.status.revision, 7);
    assert.equal(state.mirage.status.diagnostics, 3);
    assert.equal(state.mirage.report, undefined, 'the full report is not part of every redraw');
    assert.equal(JSON.stringify(state).includes('panel-csrf'), false, 'the admin token never reaches the page state');
    const inspected = await call('inspect');
    assert.equal(inspected.ok, true);
    assert.equal(inspected.version, state.mirage.version);
    assert.equal(inspected.report.webTemplates[0].ref, 'web-templates/header/Header.webtemplate.yml');
    const table = inspected.report.tables[0];
    assert.equal(table.ref, `@${path.basename(solution)}/Entities/contact/Entity.xml`);
    assert.equal(table.sourceRefs.length, 1, 'layers outside the launched roots get no reference');
    assert.equal(inspected.report.related.shortcuts[0].ref, undefined);
    assert.equal(JSON.stringify(inspected).includes('panel-csrf'), false);
    assert.equal((await call('open', { rel: 'web-templates/header/Header.webtemplate.yml' })).ok, true);
    assert.equal(opened.at(-1)[1], fx.file('web-templates/header/Header.webtemplate.yml'));
    assert.equal((await call('open', { rel: table.ref, find: '<LogicalName>fullname</LogicalName>' })).ok, true);
    assert.deepEqual(opened.at(-1).slice(1, 3), [fs.realpathSync.native(entity), 4], 'a Solution file opens at the reported column');
    assert.equal((await call('open', { rel: 'web-pages/about/About.webpage.yml' })).ok, false, 'opening is limited to descriptors reported for this page');
    assert.equal((await call('open', { rel: `@${path.basename(outside)}/secret.xml` })).ok, false, 'unlaunched roots stay closed even when the report names them');
    assert.match(panelUi.toString(), /Mirage is not active/);
  } finally {
    fs.rmSync(solution, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('Mirage tweaks read personas lazily and write through the CSRF-protected admin API, retrying once for a restarted runtime', async () => {
  const { b, tab, session, call } = await setup();
  assert.equal((await call('persona', { contactId: 'alex' })).ok, false, 'overlay sessions have no Mirage tweaks');
  session.cfg.mirage = true;
  let rejectOnce = true;
  const calls = fakeMirage(b, {
    report: { path: '/scripts', page: null, webTemplates: [], snippets: [], siteSettings: [], forms: [], views: [], tables: [{ logicalName: 'contact' }], columns: [], components: [], unresolved: [] },
    personas: { identity: { contactId: null, name: 'Anonymous', roles: [] }, personas: [{ contactId: 'alex', name: 'Alex Local', roles: ['Member'], active: true, accountId: 'secret-account' }], permissionMode: 'enforce' },
    onWrite: async (url) => {
      if (url.endsWith('/personas/select') && rejectOnce) {
        rejectOnce = false;
        return { status: 403, body: { error: { message: 'Missing simulator CSRF token.' } } };
      }
      if (url.includes('/presets/missing/')) return { status: 404, body: { error: { message: 'Preset not found.' } } };
      return { status: 200, body: { identity: { name: 'Alex Local' } } };
    },
  });
  session.emit('hit', { page: tab.page, navigation: true });
  await tick(80);
  const tweaks = await call('tweaks');
  assert.equal(tweaks.ok, true);
  assert.deepEqual(tweaks.personas, [{ contactId: 'alex', name: 'Alex Local', roles: ['Member'], active: true }]);
  assert.deepEqual(tweaks.presets.map((preset) => preset.id), ['demo']);
  assert.deepEqual(tweaks.scenarios.map((scenario) => scenario.id), ['reviewer']);
  assert.deepEqual(tweaks.tables, ['contact']);
  assert.equal(JSON.stringify(tweaks).includes('panel-csrf'), false);
  const switched = await call('persona', { contactId: 'alex' });
  assert.equal(switched.ok, true);
  const writes = calls.filter(([method]) => method && method !== 'GET');
  assert.deepEqual(writes.slice(0, 2).map(([method, url, csrf, data]) => [method, new URL(url).pathname, csrf, data]), [
    ['POST', '/_sim/api/personas/select', 'panel-csrf', '{"contactId":"alex"}'],
    ['POST', '/_sim/api/personas/select', 'panel-csrf', '{"contactId":"alex"}'],
  ]);
  assert.equal((await call('persona', { contactId: null })).ok, true, 'anonymous is a valid persona');
  assert.equal((await call('persona', { contactId: 42 })).ok, false);
  assert.equal((await call('permissions', { mode: 'permissive' })).ok, true);
  assert.equal((await call('permissions', { mode: 'everything' })).ok, false);
  assert.equal((await call('preset', { id: 'demo' })).ok, true);
  const missing = await call('preset', { id: 'missing' });
  assert.deepEqual([missing.ok, missing.error], [false, 'Preset not found.']);
  assert.equal((await call('preset', { id: '../escape' })).ok, false);
  assert.equal((await call('scenario', { id: 'reviewer' })).ok, true);
  const routes = calls.filter(([method]) => method && method !== 'GET').map(([method, url, , data]) => `${method} ${new URL(url).pathname} ${data ?? ''}`);
  assert.ok(routes.includes('PATCH /_sim/api/config {"permissionMode":"permissive"}'));
  assert.ok(routes.includes('POST /_sim/api/presets/demo/apply {}'));
  assert.ok(routes.includes('POST /_sim/api/scenarios/reviewer/apply {}'));
});

test('Mirage administration pages are neither decorated nor inspected', async () => {
  const { b, session, panel } = await setup();
  session.cfg.mirage = true;
  const calls = fakeMirage(b, { report: { path: '/', page: null } });
  const admin = b.openTab(`${ORIGIN}/_sim/#records`);
  session.emit('hit', { page: admin.page, navigation: true });
  await tick(300);
  await panel.draw(admin.page);
  assert.equal(admin.page.drawn, null);
  assert.equal(calls.length, 0);
});

test('Mirage inspections of one tab coalesce while a request is running', async () => {
  const { b, tab, session, panel } = await setup();
  session.cfg.mirage = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = fakeMirage(b, { report: { path: '/scripts', page: null } });
  const get = b.context.request.get;
  b.context.request.get = async (url, options) => { await gate; return get(url, options); };
  for (let n = 0; n < 5; n++) session.emit('hit', { page: tab.page, navigation: true });
  release();
  await tick(120);
  assert.equal(calls.filter(([, url]) => url.includes('/page-resources?')).length, 2, 'one running request plus one rerun');
  assert.equal(panel.stateFor(tab.page).mirage.active, true);
});

test('panels ignore foreign console errors and avoid scheduling foreign tab redraws', async () => {
  const { b, panel } = await setup();
  const other = b.openTab('https://other.example/');
  other.page.emit('pageerror', new Error('foreign problem'));
  other.page.emit('console', { type: () => 'error', text: () => { throw new Error('foreign console must not be read'); } });
  other.page.emit('domcontentloaded'); other.page.emit('load');
  await tick(300);
  assert.deepEqual(panel.stateFor(other.page).problems, []);
  assert.equal(other.page.drawn, null);
});

test('comparison refuses unrelated and authority-changing URLs without any request', async () => {
  const { b, call } = await setup();
  for (const url of ['@evil.test/source', '//evil.test/source', 'https://evil.test/source', '/_api/data', '/Logo.svg']) {
    const result = await call('diff', { rel: 'web-files/app.js', url });
    assert.equal(result.ok, false, url);
  }
  assert.equal(b.fetched.length, 0);
});

test('the panel refuses sources reached through a directory junction escaping the extract', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-outside-'));
  const linked = fx.file('outside-link');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.symlinkSync(outside, linked, 'junction');
  try {
    const { call, opened } = await setup();
    assert.equal((await call('open', { rel: 'outside-link/secret.txt' })).ok, false);
    assert.equal(opened.length, 0);
  } finally {
    fs.unlinkSync(linked);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('comparison totals include hidden hunks and output allocation stays bounded', () => {
  const before = Array.from({ length: 20 }, (_, n) => `old ${n}`).join('\n');
  const after = Array.from({ length: 20 }, (_, n) => `new ${n}`).join('\n');
  const diff = comparison(before, after, 3, 5);
  assert.equal(diff.lines.length, 5);
  assert.equal(diff.removed, 20);
  assert.equal(diff.added, 20);
  assert.equal(diff.truncated, true);
  const exact = comparison('old', 'new', 3, 2);
  assert.equal(exact.truncated, false);
});

test('a navigation only clears pending changes for the tab that loaded them', async () => {
  const { b, tab, session, panel } = await setup();
  const other = b.openTab(`${ORIGIN}/about-us/`);
  const changed = fx.file('web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js');
  session.emit('refreshed', { files: [changed], how: 'none' });
  session.emit('hit', { page: tab.page, navigation: true });
  assert.deepEqual(panel.stateFor(tab.page).pending, []);
  assert.deepEqual(panel.stateFor(other.page).pending, [session.rel(changed)]);
});

test('malformed UI settings and oversized API input are safely rejected', async () => {
  const { call, panel, tab } = await setup();
  await call('ui', { tab: '<invalid>', pos: 'broken', open: 'yes', collapsed: [] });
  const state = panel.stateFor(tab.page).ui;
  assert.notEqual(state.tab, '<invalid>');
  assert.notEqual(state.open, 'yes');
  assert.equal((await call('mode', { online: true, padding: 'x'.repeat(32768) })).status, 413);
});

test('disposing the panel clears scheduled work and releases session listeners', async () => {
  const { b, tab, session, panel } = await setup();
  session.emit('hit', { page: tab.page });
  await panel.dispose();
  await tick(300);
  assert.deepEqual(tab.page.drawn, { token: panel.stateFor(tab.page).token }, 'only the UI cleanup is evaluated');
  assert.equal(session.listenerCount('refreshed'), 0);
  assert.equal(session.api, null);
  assert.equal(b.context.listenerCount('page'), 1, 'only interception remains');
});

test('closing a tab immediately releases its panel listeners', async () => {
  const { tab } = await setup();
  assert.ok(tab.page.listenerCount('console') > 0);
  tab.page.emit('close');
  assert.equal(tab.page.listenerCount('console'), 0);
  assert.equal(tab.page.listenerCount('pageerror'), 0);
});

test('editor shell syntax is rejected before starting any process', async () => {
  assert.match(await openInEditor('code & unexpected-command', fx.file('web-files/app.js')), /executable/);
  assert.match(await openInEditor('code', fx.file('web-files/unsafe%NAME%.js')), /file name/);
});

test('unindexed files under the extract are not exposed through panel actions', async () => {
  fx.write('private-local-settings.txt', 'sensitive local data');
  try {
    const { call, opened } = await setup();
    assert.equal((await call('open', { rel: 'private-local-settings.txt' })).ok, false);
    assert.equal((await call('diff', { rel: 'private-local-settings.txt' })).ok, false);
    assert.equal(opened.length, 0);
  } finally {
    fs.rmSync(fx.file('private-local-settings.txt'));
  }
});

test('unchanged panel redraws reuse page/source metadata without filesystem reads', async (t) => {
  const { b, panel, session } = await setup();
  const tab = b.openTab(`${ORIGIN}/about-us/`);
  const read = t.mock.method(fs, 'readFileSync');
  const first = panel.stateFor(tab.page);
  const initialReads = read.mock.callCount();
  assert.ok(initialReads > 0);
  for (let n = 0; n < 100; n++) assert.equal(panel.stateFor(tab.page).page, first.page);
  assert.equal(read.mock.callCount(), initialReads);
  session.emit('refreshed', { files: [], how: 'none' });
  panel.stateFor(tab.page);
  assert.ok(read.mock.callCount() > initialReads, 'a source refresh invalidates the page metadata');
});

test('a paused page has at most one panel evaluation pending and receives the latest update afterwards', async () => {
  const { panel, tab, session } = await setup();
  let finish;
  let calls = 0;
  tab.page.evaluate = async (_fn, state) => {
    calls++;
    tab.page.drawn = state;
    if (calls === 1) await new Promise((resolve) => { finish = resolve; });
  };
  const draws = Array.from({ length: 50 }, () => panel.draw(tab.page));
  await tick();
  assert.equal(calls, 1);
  session.bypass = true;
  finish();
  await Promise.all(draws);
  await tick(300);
  assert.equal(calls, 2);
  assert.equal(tab.page.drawn.online, true);
});

test('Mirage navigation fetches a page summary; the full Inspect report is fetched once, on request', async () => {
  const { b, tab, session, panel, call } = await setup();
  session.cfg.mirage = true;
  const full = { path: '/scripts', view: undefined, page: { name: 'Scripts', url: '/scripts/', access: { allowed: true, rules: [] } }, webTemplates: [{ name: 'Header', relativePath: 'web-templates/header/Header.webtemplate.yml' }], snippets: [], siteSettings: [], forms: [], views: [], tables: [{ logicalName: 'contact' }], columns: [], components: [], usages: [], unresolved: [], templateChain: [], related: {}, dependencies: [{ kind: 'web-template', relativePath: 'web-templates/header/Header.webtemplate.yml' }] };
  const summary = { path: '/scripts', view: 'summary', sourceRoots: [fx.dir], page: { name: 'Scripts', url: '/scripts/', access: { allowed: true } }, tables: ['contact'], counts: { templates: 1, snippets: 0, settings: 0, forms: 0, views: 0, tables: 1, columns: 0, usages: 0, related: 0, unresolved: 0, accessRules: 0 } };
  const calls = fakeMirage(b, { report: full });
  const get = b.context.request.get;
  b.context.request.get = async (url, options) => String(url).includes('&view=summary') ? (calls.push(['GET', String(url)]), { ok: () => true, status: () => 200, json: async () => structuredClone(summary) }) : get(url, options);
  session.emit('hit', { page: tab.page, navigation: true, url: '/scripts/' });
  await tick(80);
  const pageRequests = () => calls.filter(([, url]) => url.includes('/page-resources?'));
  assert.deepEqual(pageRequests().map(([, url]) => url.includes('view=summary')), [true], 'navigation asks only for the summary');
  const state = panel.stateFor(tab.page);
  assert.equal(state.mirage.counts.total, 2);
  assert.equal(state.mirage.page.allowed, true);
  const first = await call('inspect');
  assert.equal(first.report.webTemplates[0].ref, 'web-templates/header/Header.webtemplate.yml');
  assert.equal(first.report.dependencies, undefined, 'the flat dependency list is not sent to the page');
  await call('inspect');
  assert.deepEqual(pageRequests().map(([, url]) => url.includes('view=summary')), [true, false], 'the full report is fetched once per page version');
  assert.equal((await call('open', { rel: 'web-templates/header/Header.webtemplate.yml' })).ok, true);
  assert.deepEqual((await call('tweaks')).tables, ['contact']);
});

test('Mirage browser sessions: Tweaks show this browser\'s session and identity provider; sign-in and sign-out run the portal\'s own flow in the page', async () => {
  const { b, tab, session, panel, call } = await setup();
  session.cfg.mirage = true;
  let signedIn = null;
  let override = null;
  const external = { available: true, origin: 'http://127.0.0.1:61234', port: 61234, providers: [{ id: 'https://idp.example.test/local/', name: 'Local', type: 'OpenIdConnect', caption: 'Local IdP', callbackPath: '/signin-local', authority: 'https://idp.example.test/local/', localAuthority: 'http://127.0.0.1:61234/local/', default: true }] };
  let identityProvider = external;
  const people = [{ contactId: 'alex', name: 'Alex Local', roles: ['Member'], active: true }, { contactId: 'blair', name: 'Blair Default', roles: ['Member'], active: true }];
  const fakeStatus = { scenarios: [{ id: 'anon', name: 'Anonymous', persona: null }, { id: 'as-alex', name: 'Alex', persona: { contactId: 'alex' } }, { id: 'keep', name: 'Keep persona' }] };
  const calls = fakeMirage(b, {
    report: { path: '/scripts', view: 'summary', page: null, tables: [], counts: { templates: 0 } },
    personas: { identity: { contactId: 'blair', name: 'Blair Default', roles: ['Member'] }, personas: people },
    status: fakeStatus,
    onWrite: async () => ({ status: 200, body: {} }),
  });
  const get = b.context.request.get;
  b.context.request.get = async (url, options) => {
    if (!new URL(String(url)).pathname.endsWith('/session')) return get(url, options);
    calls.push(['GET', String(url)]);
    const person = people.find((item) => item.contactId === signedIn);
    const body = person
      ? { signedIn: true, contactId: person.contactId, name: person.name, roles: override ?? person.roles, roleSource: override ? 'override' : 'contact', accountId: 'account-1', identityProvider }
      : { signedIn: false, contactId: null, name: null, roles: ['Anonymous Users'], accountId: null, identityProvider };
    return { ok: () => true, status: () => 200, json: async () => body };
  };
  const cookieWrites = () => calls.filter(([method, url]) => method === 'POST' && /\/session\//.test(url));
  const flows = tab.page.flows;

  session.emit('hit', { page: tab.page, navigation: true });
  await tick(80);
  const shown = panel.stateFor(tab.page).mirage.session;
  assert.deepEqual([shown.supported, shown.signedIn, shown.contactId, shown.roles], [true, false, null, ['Anonymous Users']]);
  assert.deepEqual(shown.identityProvider, { available: true, reason: null, port: 61234, provider: { id: 'https://idp.example.test/local/', name: 'Local', caption: 'Local IdP', type: 'OpenIdConnect', callbackPath: '/signin-local' }, callbackPaths: ['/signin-local'] });
  const tweaks = await call('tweaks');
  assert.equal(tweaks.session.signedIn, false, 'Tweaks report this browser\'s session ...');
  assert.equal(tweaks.identity.name, 'Blair Default', '... separately from the Mirage default persona');

  // Sign in as: the page posts the portal's ExternalLogin form with a login_hint (the local
  // identity provider answers it without a click) and comes back to this page.
  const signed = await call('signin', { contactId: 'alex' });
  assert.deepEqual([signed.ok, signed.navigating, signed.via, signed.returnUrl, signed.contactId], [true, true, 'Local IdP', '/scripts/', 'alex']);
  assert.deepEqual(flows.at(-1), { logOff: null, token: '/_layout/tokenhtml', action: '/Account/Login/ExternalLogin?returnUrl=%2Fscripts%2F', fields: { provider: 'https://idp.example.test/local/', login_hint: 'alex' } });
  signedIn = 'alex';
  // Another persona: the current session ends first, because an external login made while signed
  // in would link to that account instead of switching.
  await call('signin', { contactId: 'blair' });
  assert.deepEqual([flows.at(-1).logOff, flows.at(-1).fields.login_hint], ['/Account/Login/LogOff?returnUrl=%2F', 'blair']);
  // A simulation override set in _sim is reported with the session.
  override = ['Reader'];
  const overridden = (await call('tweaks')).session;
  assert.deepEqual([overridden.roleSource, overridden.roles], ['override', ['Reader']]);
  override = null;
  // Sign out goes to the portal's LogOff, which ends the session through the provider's end-session.
  const out = await call('signout');
  assert.deepEqual([out.ok, out.navigating], [true, true]);
  assert.deepEqual(flows.at(-1), { navigate: '/Account/Login/LogOff?returnUrl=%2Fscripts%2F' });
  signedIn = null;
  const idle = await call('signout');
  assert.deepEqual([idle.ok, idle.navigating], [true, false], 'an anonymous browser has nothing to sign out');
  assert.equal((await call('signin', {})).ok, false, 'a persona is required');

  // From a sign-in page the flow returns to its ReturnUrl; from a provider callback, home.
  let n = 0;
  const callFrom = async (from, name, body) => {
    const id = `session-api${++n}`;
    from.pause(id, `${ORIGIN}/__paqvilo/api/${name}`, { type: 'Fetch', method: 'POST', headers: { 'x-paqvilo-token': panel.stateFor(from.page).token }, postData: JSON.stringify(body ?? {}) });
    await tick();
    return JSON.parse(Buffer.from(b.answers(id)[0].body, 'base64').toString());
  };
  const returnsTo = async (cases) => {
    for (const [url, target] of cases) {
      const opened = b.openTab(url);
      b.context.emit('page', opened.page);
      await tick(20);
      const result = await callFrom(opened, 'signin', { contactId: 'blair' });
      assert.equal(result.returnUrl, target, url);
      assert.equal(opened.page.flows.at(-1).action, `/Account/Login/ExternalLogin?returnUrl=${encodeURIComponent(target)}`, url);
    }
  };
  await returnsTo([
    [`${ORIGIN}/SignIn?ReturnUrl=%2Fsecure%2F%3Fid%3D1`, '/secure/?id=1'],
    [`${ORIGIN}/en-US/signin?returnUrl=/secure/`, '/secure/'],
    [`${ORIGIN}/SignIn?ReturnUrl=%2F%2Fexample.test%2F`, '/'],
    [`${ORIGIN}/SignIn`, '/'],
    [`${ORIGIN}/Account/Login/Login?ReturnUrl=%2Fsecure%2F`, '/secure/'],
    [`${ORIGIN}/signin-local`, '/'],
    [`${ORIGIN}/secure/page?id=2&paqvilo=abc`, '/secure/page?id=2'],
  ]);
  // A site with another sign-in path (exported or observed): the Mirage status names it.
  fakeStatus.signInPath = '/Custom/Login';
  await call('tweaks');
  await returnsTo([
    [`${ORIGIN}/Custom/Login?ReturnUrl=%2Fsecure%2F`, '/secure/'],
    [`${ORIGIN}/en-US/custom/login/?ReturnUrl=%2Fsecure%2F`, '/secure/'],
    [`${ORIGIN}/SignIn?ReturnUrl=%2Fsecure%2F`, '/SignIn?ReturnUrl=%2Fsecure%2F'],
  ]);
  delete fakeStatus.signInPath;
  await call('tweaks');

  // Without an external identity provider the portal's sign-in is the local persona page.
  identityProvider = { available: false, reason: 'No external identity provider is configured.', providers: [] };
  const local = await call('signin', { contactId: 'alex' });
  assert.deepEqual([local.ok, local.via], [true, 'the local sign-in page']);
  assert.deepEqual(flows.at(-1), { logOff: null, token: '/_layout/tokenhtml', action: '/SignIn?ReturnUrl=%2Fscripts%2F', fields: { contactId: 'alex' } });
  assert.equal((await call('tweaks')).session.identityProvider.reason, 'No external identity provider is configured.');
  identityProvider = external;

  // A scenario persona applies to this browser through the same flow, once the page has taken the
  // Mirage's reload; "keep" and an unchanged persona leave the session alone.
  signedIn = 'alex';
  const before = flows.length;
  const anonymous = await call('scenario', { id: 'anon' });
  assert.deepEqual([anonymous.ok, anonymous.navigating, anonymous.contactId], [true, true, null]);
  assert.equal(flows.length, before, 'nothing runs before the reload');
  tab.page.emit('load');
  await tick(60);
  assert.deepEqual(flows.at(-1), { navigate: '/Account/Login/LogOff?returnUrl=%2Fscripts%2F' });
  signedIn = null;
  const asAlex = await call('scenario', { id: 'as-alex' });
  assert.deepEqual([asAlex.ok, asAlex.navigating, asAlex.contactId], [true, true, 'alex']);
  tab.page.emit('load');
  await tick(60);
  assert.deepEqual([flows.at(-1).logOff, flows.at(-1).fields.login_hint], [null, 'alex']);
  signedIn = 'alex';
  const kept = flows.length;
  assert.deepEqual([(await call('scenario', { id: 'keep' })).navigating, (await call('scenario', { id: 'as-alex' })).navigating], [undefined, undefined]);
  tab.page.emit('load');
  await tick(60);
  assert.equal(flows.length, kept);
  assert.deepEqual(cookieWrites(), [], 'the panel never sets the session cookie itself');
});

test('Mirage Tweaks report whether local pages are confined to loopback, with the exceptions', async () => {
  const { b, tab, session, call } = await setup();
  session.cfg.mirage = true;
  fakeMirage(b, {
    report: { path: '/scripts', view: 'summary', page: null, tables: [], counts: {} },
    status: { confinePortalPages: true, externalAssets: false, externalFrameOrigins: 2 },
  });
  session.emit('hit', { page: tab.page, navigation: true });
  await tick(80);
  const tweaks = await call('tweaks');
  assert.deepEqual([tweaks.status.confinePortalPages, tweaks.status.externalAssets, tweaks.status.externalFrameOrigins], [true, false, 2]);
  const source = panelUi.toString();
  assert.match(source, /Confined to loopback/);
  assert.match(source, /Not confined: pages carry only the headers their site settings define/);
});
