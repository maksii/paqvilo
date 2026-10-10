import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { openBrowser, refreshPages, keepSessionCookies, safeDownloadName, browserProfileDir } from '../lense/browser.mjs';
import { refreshUrl } from '../lense/navigation.mjs';
import { defaultEdgeDataDirs, validateBrowserProfile } from '../lense/browser-profile.mjs';

const origin = 'https://portal.example.com';

test('Edge normal storage fails early with actionable attachment options without reading profile data', () => {
  assert.ok(defaultEdgeDataDirs().length >= 3);
  for (const userDataDir of defaultEdgeDataDirs()) {
    assert.throws(() => validateBrowserProfile({ kind: 'external', channel: 'msedge', userDataDir, profileDirectory: 'Profile 5' }), /--profile work.*--cdp-url/);
  }
  assert.doesNotThrow(() => validateBrowserProfile({ kind: 'attached', channel: 'msedge' }));
  assert.doesNotThrow(() => validateBrowserProfile({ kind: 'named', channel: 'msedge' }));
  assert.deepEqual(defaultEdgeDataDirs({ platform: 'linux', home: '/home/test', env: { XDG_CONFIG_HOME: '/custom' } }), ['microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev'].map(name => path.join('/custom', name)));
});

test('external browser storage stays in the selected child without exporting session credentials', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-external-browser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Profile 2'));
  let closed = false;
  const context = Object.assign(new EventEmitter(), {
    pages: () => [],
    cookies: async () => assert.fail('external credentials must remain browser-managed'),
    addCookies: async () => assert.fail('external credentials must never be imported'),
    close: async () => { closed = true; },
  });
  t.mock.method(chromium, 'launchPersistentContext', async (dir, options) => {
    assert.equal(dir, root);
    assert.ok(options.args.includes('--profile-directory=Profile 2'));
    return context;
  });
  const browser = await openBrowser({ configDir: root, browser: { channel: 'msedge', userDataDir: root, profileDirectory: 'Profile 2' } }, { headless: false });
  assert.equal(browser.profile.kind, 'external');
  await browser.close();
  assert.equal(closed, true);
  assert.equal(fs.existsSync(`${root}.session.json`), false);
  assert.equal(fs.existsSync(`${root}.window.json`), false, 'external window placement remains browser-managed');
});

test('owned headed windows normalize old maximization once and retain subsequent user placement', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-window-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sends = [];
  const launches = [];
  let detached = 0;
  const context = Object.assign(new EventEmitter(), {
    pages: () => [], newPage: async () => ({}), cookies: async () => [], close: async () => {},
    newCDPSession: async () => ({
      send: async (method, params) => { sends.push({ method, params }); return { windowId: 7 }; },
      detach: async () => { detached++; },
    }),
  });
  t.mock.method(chromium, 'launchPersistentContext', async (_dir, options) => { launches.push(options); return context; });
  const cfg = { configDir: root, siteName: 'test', envName: 'dev', browser: { channel: 'msedge', profileDir: 'profiles' } };
  await (await openBrowser(cfg, { headless: false })).close();
  assert.deepEqual(sends, [
    { method: 'Browser.getWindowForTarget', params: undefined },
    { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { windowState: 'normal' } } },
    { method: 'Browser.setWindowBounds', params: { windowId: 7, bounds: { width: 1280, height: 900 } } },
  ]);
  assert.equal(detached, 1);
  await (await openBrowser(cfg, { headless: false })).close();
  assert.equal(sends.length, 3, 'the next launch does not reset a window the developer resized');
  assert.ok(launches[0].args.includes('--window-size=1280,900'));
  assert.ok(!launches[1].args.some((arg) => /window-size|maximized/.test(arg)));
  assert.ok(launches.every((options) => options.chromiumSandbox === true));
});

test('default browser profiles preserve migrated Edge sign-in and isolate Chrome and Chromium', () => {
  const cfg = { configDir: path.resolve('tool'), browser: { profileDir: '.paqvilo/profiles', channel: 'msedge' }, siteName: 'alpha', envName: 'test' };
  const edge = browserProfileDir(cfg);
  const chrome = browserProfileDir({ ...cfg, browser: { ...cfg.browser, channel: 'chrome' } });
  const chromium = browserProfileDir({ ...cfg, browser: { ...cfg.browser, channel: 'chromium' } });
  assert.equal(edge, path.resolve('tool/.paqvilo/profiles/alpha-test'));
  assert.equal(new Set([edge, chrome, chromium]).size, 3);
  assert.equal(chrome, path.resolve('tool/.paqvilo/profiles/default/chrome/alpha-test'));
});

test('dev and signed-in verification select the same isolated catalogue profile', () => {
  const cfg = { configDir: path.resolve('tool'), browser: { profileDir: '.paqvilo/profiles' }, siteName: 'alpha', envName: 'test' };
  assert.equal(browserProfileDir(cfg), path.resolve('tool/.paqvilo/profiles/alpha-test'));
  assert.equal(browserProfileDir({ ...cfg, portals: 'all' }), path.resolve('tool/.paqvilo/profiles/catalogue'));
  assert.equal(browserProfileDir({ ...cfg, portals: 'all', siteName: 'beta', envName: 'uat' }), browserProfileDir({ ...cfg, portals: 'all' }));
});
const page = (url, result = 1) => ({
  url: () => url,
  isClosed: () => false,
  reloads: 0,
  evaluations: 0,
  async reload() { assert.fail('refresh must never use browser reload, which can repeat POST'); },
  async goto(target, options) { assert.equal(target, new URL(url).href); assert.equal(options.waitUntil, 'commit'); assert.ok(options.timeout > 0); this.reloads++; },
  async evaluate() { this.evaluations++; return { links: result, styles: 0 }; },
});
const session = { cfg: { origin }, model: { webFiles: [{ file: 'main.css', url: '/main.css' }, { file: 'other.css', url: '/other.css' }] } };

test('refresh only touches pages with the exact portal origin', async () => {
  const valid = page(`${origin}/`);
  const foreign = page(`${origin}.evil.test/`);
  const port = page(`${origin}:444/`);
  assert.equal(await refreshPages({ pages: () => [valid, foreign, port] }, session, ['app.js']), 'reload');
  assert.deepEqual([valid.reloads, foreign.reloads, port.reloads], [1, 0, 0]);
});

test('empty file batches do not evaluate or reload any page', async () => {
  const tab = page(origin);
  assert.equal(await refreshPages({ pages: () => [tab] }, session, []), 'none');
  assert.equal(tab.evaluations + tab.reloads, 0);
});

test('fragment refresh forces GET while preserving existing query parameters and fragment', () => {
  const target = new URL(refreshUrl(`${origin}/result?filter=ready#table`));
  assert.equal(target.searchParams.get('filter'), 'ready');
  assert.equal(target.hash, '#table');
  assert.ok(target.searchParams.get('paqvilo'));
  assert.notEqual(refreshUrl(target.href), target.href);
  assert.equal(refreshUrl(`${origin}/result?filter=ready`), `${origin}/result?filter=ready`);
  const emptyFragment = new URL(refreshUrl(`${origin}/result?filter=ready&filter=other#`));
  assert.ok(emptyFragment.href.endsWith('#')); assert.ok(emptyFragment.searchParams.has('paqvilo'));
  assert.deepEqual(emptyFragment.searchParams.getAll('filter'), ['ready', 'other']);
});

test('linked CSS swaps in place while imported or missing links trigger a reload', async () => {
  const direct = page(origin, 1);
  const imported = page(origin, 0);
  assert.equal(await refreshPages({ pages: () => [direct] }, session, ['main.css']), 'css');
  assert.equal(direct.reloads, 0);
  assert.equal(await refreshPages({ pages: () => [imported] }, session, ['main.css']), 'reload');
  assert.equal(imported.reloads, 1);
});

test('failed CSS evaluation falls back to a bounded document reload', async () => {
  const tab = page(origin);
  tab.evaluate = async () => { throw new Error('page navigated'); };
  assert.equal(await refreshPages({ pages: () => [tab] }, session, ['main.css']), 'reload');
  assert.equal(tab.reloads, 1);
});

test('page-specific changes refresh language variants while preserving unrelated tabs', async () => {
  const about = page(`${origin}/en-US/about-us/`);
  const home = page(origin);
  const s = { ...session, model: { webFiles: [], languageCodes: new Set(['en-us']), inlineSources: [{ file: 'about.js', kind: 'page-js', pageUrl: '/about-us' }] } };
  const outcomes = new Map();
  assert.equal(await refreshPages({ pages: () => [home, about] }, s, ['about.js'], { outcomes }), 'reload');
  assert.deepEqual([home.reloads, about.reloads], [0, 1]);
  assert.equal(outcomes.get(home).how, 'skipped');
  assert.deepEqual(outcomes.get(home).files, []);
  assert.equal(await refreshPages({ pages: () => [home] }, s, ['about.js']), 'skipped');
});

test('refresh keeps native short routes distinct from home and exported language variants', async () => {
  const home = page(`${origin}/`), native = page(`${origin}/it`), localized = page(`${origin}/fr-FR/it`), unknown = page(`${origin}/zz-ZZ/`);
  const model = { webFiles: [], languageCodes: new Set(['fr-fr']), pagePaths: new Set(['/', '/it', '/ui']), inlineSources: [{ file: 'it.js', kind: 'page-js', pageUrl: '/it' }, { file: 'home.js', kind: 'page-js', pageUrl: '/' }] };
  const s = { ...session, model };
  const tabs = { pages: () => [home, native, localized, unknown] };
  await refreshPages(tabs, s, ['it.js']);
  assert.deepEqual([home.reloads, native.reloads, localized.reloads, unknown.reloads], [0, 1, 1, 0]);
  await refreshPages(tabs, s, ['home.js']);
  assert.deepEqual([home.reloads, native.reloads, localized.reloads, unknown.reloads], [1, 1, 1, 0]);
});

test('failed document GETs are left pending and online mode does not change page styles', async () => {
  const tab = page(origin);
  tab.goto = async () => { throw new Error('offline'); };
  const outcomes = new Map();
  assert.equal(await refreshPages({ pages: () => [tab] }, session, ['app.js'], { outcomes }), 'none');
  assert.equal(outcomes.get(tab).how, 'none');
  assert.equal(await refreshPages({ pages: () => [tab] }, { ...session, bypass: true }, ['main.css']), 'none');
  assert.equal(tab.evaluations, 0);
});

test('session cookies restore and save atomically without retaining persistent cookies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-cookies-'));
  const file = path.join(dir, 'profile.session.json');
  const old = [{ name: 'old', value: 'value', domain: 'portal.example.com', path: '/', expires: -1 }];
  fs.writeFileSync(file, JSON.stringify(old));
  let restored;
  const context = Object.assign(new EventEmitter(), {
    addCookies: async (cookies) => { restored = cookies; },
    cookies: async () => [{ ...old[0], name: 'new' }, { ...old[0], name: 'persistent', expires: 9999999999 }],
  });
  try {
    const stop = await keepSessionCookies(context, file);
    assert.deepEqual(restored, old);
    await stop();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((c) => c.name), ['new']);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    context.emit('close');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('download names cannot escape Downloads or name a Windows device', () => {
  assert.equal(safeDownloadName('../../private/data.txt'), 'data.txt');
  assert.equal(safeDownloadName('..\\private\\data.txt'), 'data.txt');
  assert.equal(safeDownloadName('CON.txt'), '_CON.txt');
  assert.equal(safeDownloadName('report?.txt'), 'report_.txt');
  assert.equal(safeDownloadName('...'), 'download');
});

test('unchanged session cookies do not rewrite credentials and stopping is idempotent', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-cookie-cache-'));
  const file = path.join(dir, 'profile.session.json');
  const cookies = [{ name: 'session', value: 'secret', domain: 'portal.example.com', path: '/', expires: -1 }];
  fs.writeFileSync(file, JSON.stringify(cookies));
  const context = Object.assign(new EventEmitter(), { addCookies: async () => {}, cookies: async () => cookies });
  const write = t.mock.method(fs, 'writeFileSync');
  try {
    const stop = await keepSessionCookies(context, file);
    await Promise.all([stop(), stop()]);
    assert.equal(write.mock.callCount(), 0);
    context.emit('close');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
