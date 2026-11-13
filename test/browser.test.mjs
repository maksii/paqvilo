// @test-kind contract: owned browser profiles and their runtime behaviour are designed Paqvilo behaviour
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { chromium } from 'playwright-core';
import {
  openBrowser,
  refreshPages,
  keepSessionCookies,
  sessionFileFor,
  safeDownloadName,
  browserProfileDir,
  profileLockPresent,
} from '../lense/browser.mjs';
import { refreshUrl } from '../lense/navigation.mjs';
import { defaultEdgeDataDirs, validateBrowserProfile } from '../lense/browser-profile.mjs';
import { tempDirSync } from './fixture.mjs';

const origin = 'https://portal.example.com';

test('CDP attachment rejects a launch debugger port before connecting or opening any browser', async (t) => {
  const connect = t.mock.method(chromium, 'connectOverCDP', async () =>
    assert.fail('ambiguous debugger selection must not connect'),
  );
  const launch = t.mock.method(chromium, 'launchPersistentContext', async () =>
    assert.fail('attachment must not launch'),
  );
  for (const cdpUrl of [
    'http://127.0.0.1:9222',
    'ws://127.0.0.1:9333/devtools/browser/invented',
    'https://remote.example.test:9222',
  ]) {
    for (const [browserPort, overrides] of [
      [9222, {}],
      [null, { debugPort: 9222 }],
    ]) {
      await assert.rejects(openBrowser({ browser: { cdpUrl, debugPort: browserPort } }, overrides), (error) => {
        assert.match(error.message, /browser.debugPort.*cannot be combined with browser.cdpUrl/);
        assert.match(error.message, /--debug-port 0/);
        assert.ok(!error.message.includes(cdpUrl), 'endpoint details are not copied into diagnostics');
        return true;
      });
    }
  }
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(launch.mock.callCount(), 0);
});

test('ordinary CDP attachment and an explicit disabled launch port retain user-owned browser lifetime', async (t) => {
  const context = { close: async () => assert.fail('the attached context belongs to the user') };
  let detached = 0;
  const endpoints = [];
  t.mock.method(chromium, 'connectOverCDP', async (endpoint) => {
    endpoints.push(endpoint);
    return {
      contexts: () => [context],
      close: async () => {
        detached++;
      },
    };
  });
  t.mock.method(chromium, 'launchPersistentContext', async () => assert.fail('attachment must not launch'));
  const cdpUrl = 'ws://127.0.0.1:9333/devtools/browser/invented';
  for (const [debugPort, overrides] of [
    [null, {}],
    [9222, { debugPort: 0 }],
  ]) {
    const browser = await openBrowser({ browser: { cdpUrl, debugPort } }, overrides);
    assert.equal(browser.context, context);
    assert.equal(browser.attached, true);
    assert.equal(browser.profile.kind, 'attached');
    await browser.close();
  }
  assert.deepEqual(endpoints, [cdpUrl, cdpUrl]);
  assert.equal(detached, 2, 'closing only disconnects the toolkit transport');
});

test('Edge normal storage fails early with actionable attachment options without reading profile data', () => {
  assert.ok(defaultEdgeDataDirs().length >= 3);
  for (const userDataDir of defaultEdgeDataDirs()) {
    assert.throws(
      () => validateBrowserProfile({ kind: 'external', channel: 'msedge', userDataDir, profileDirectory: 'Profile 2' }),
      /--profile work.*--cdp-url/,
    );
  }
  assert.doesNotThrow(() => validateBrowserProfile({ kind: 'attached', channel: 'msedge' }));
  assert.doesNotThrow(() => validateBrowserProfile({ kind: 'named', channel: 'msedge' }));
  assert.deepEqual(
    defaultEdgeDataDirs({ platform: 'linux', home: '/home/test', env: { XDG_CONFIG_HOME: '/custom' } }),
    ['microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev'].map((name) => path.join('/custom', name)),
  );
});

// @test-kind security: session credentials are not exported from external browser storage
test('external browser storage stays in the selected child without exporting session credentials', async (t) => {
  const root = tempDirSync('pp-external-browser-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'Profile 2'));
  let closed = false;
  const context = Object.assign(new EventEmitter(), {
    pages: () => [],
    cookies: async () => assert.fail('external credentials must remain browser-managed'),
    addCookies: async () => assert.fail('external credentials must never be imported'),
    close: async () => {
      closed = true;
    },
  });
  t.mock.method(chromium, 'launchPersistentContext', async (dir, options) => {
    assert.equal(dir, root);
    assert.ok(options.args.includes('--profile-directory=Profile 2'));
    return context;
  });
  const browser = await openBrowser(
    { configDir: root, browser: { channel: 'msedge', userDataDir: root, profileDirectory: 'Profile 2' } },
    { headless: false },
  );
  assert.equal(browser.profile.kind, 'external');
  await browser.close();
  assert.equal(closed, true);
  assert.equal(fs.existsSync(`${root}.session.json`), false);
  assert.equal(fs.existsSync(`${root}.window.json`), false, 'external window placement remains browser-managed');
});

test('owned headed windows normalize old maximization once and retain subsequent user placement', async (t) => {
  const root = tempDirSync('pp-window-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sends = [];
  const launches = [];
  let detached = 0;
  const context = Object.assign(new EventEmitter(), {
    pages: () => [],
    newPage: async () => ({}),
    cookies: async () => [],
    close: async () => {},
    newCDPSession: async () => ({
      send: async (method, params) => {
        sends.push({ method, params });
        return { windowId: 7 };
      },
      detach: async () => {
        detached++;
      },
    }),
  });
  t.mock.method(chromium, 'launchPersistentContext', async (_dir, options) => {
    launches.push(options);
    return context;
  });
  const cfg = {
    configDir: root,
    siteName: 'test',
    envName: 'dev',
    browser: { channel: 'msedge', profileDir: 'profiles' },
  };
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
  const cfg = {
    configDir: path.resolve('tool'),
    browser: { profileDir: '.paqvilo/profiles', channel: 'msedge' },
    siteName: 'alpha',
    envName: 'test',
  };
  const edge = browserProfileDir(cfg);
  const chrome = browserProfileDir({ ...cfg, browser: { ...cfg.browser, channel: 'chrome' } });
  const chromium = browserProfileDir({ ...cfg, browser: { ...cfg.browser, channel: 'chromium' } });
  assert.equal(edge, path.resolve('tool/.paqvilo/profiles/alpha-test'));
  assert.equal(new Set([edge, chrome, chromium]).size, 3);
  assert.equal(chrome, path.resolve('tool/.paqvilo/profiles/default/chrome/alpha-test'));
});

test('dev and signed-in verification select the same isolated catalogue profile', () => {
  const cfg = {
    configDir: path.resolve('tool'),
    browser: { profileDir: '.paqvilo/profiles' },
    siteName: 'alpha',
    envName: 'test',
  };
  assert.equal(browserProfileDir(cfg), path.resolve('tool/.paqvilo/profiles/alpha-test'));
  assert.equal(browserProfileDir({ ...cfg, portals: 'all' }), path.resolve('tool/.paqvilo/profiles/catalogue'));
  assert.equal(
    browserProfileDir({ ...cfg, portals: 'all', siteName: 'beta', envName: 'uat' }),
    browserProfileDir({ ...cfg, portals: 'all' }),
  );
});
const page = (url, result = 1) => ({
  url: () => url,
  isClosed: () => false,
  reloads: 0,
  evaluations: 0,
  async reload() {
    assert.fail('refresh must never use browser reload, which can repeat POST');
  },
  async goto(target, options) {
    assert.equal(target, new URL(url).href);
    assert.equal(options.waitUntil, 'commit');
    assert.ok(options.timeout > 0);
    this.reloads++;
  },
  async evaluate() {
    this.evaluations++;
    return { links: result, styles: 0 };
  },
});
const session = {
  cfg: { origin },
  model: {
    webFiles: [
      { file: 'main.css', url: '/main.css' },
      { file: 'other.css', url: '/other.css' },
    ],
  },
};

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
  assert.ok(emptyFragment.href.endsWith('#'));
  assert.ok(emptyFragment.searchParams.has('paqvilo'));
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
  tab.evaluate = async () => {
    throw new Error('page navigated');
  };
  assert.equal(await refreshPages({ pages: () => [tab] }, session, ['main.css']), 'reload');
  assert.equal(tab.reloads, 1);
});

test('page-specific changes refresh language variants while preserving unrelated tabs', async () => {
  const about = page(`${origin}/en-US/about-us/`);
  const home = page(origin);
  const s = {
    ...session,
    model: {
      webFiles: [],
      languageCodes: new Set(['en-us']),
      inlineSources: [{ file: 'about.js', kind: 'page-js', pageUrl: '/about-us' }],
    },
  };
  const outcomes = new Map();
  assert.equal(await refreshPages({ pages: () => [home, about] }, s, ['about.js'], { outcomes }), 'reload');
  assert.deepEqual([home.reloads, about.reloads], [0, 1]);
  assert.equal(outcomes.get(home).how, 'skipped');
  assert.deepEqual(outcomes.get(home).files, []);
  assert.equal(await refreshPages({ pages: () => [home] }, s, ['about.js']), 'skipped');
});

test('refresh keeps native short routes distinct from home and exported language variants', async () => {
  const home = page(`${origin}/`),
    native = page(`${origin}/it`),
    localized = page(`${origin}/fr-FR/it`),
    unknown = page(`${origin}/zz-ZZ/`);
  const model = {
    webFiles: [],
    languageCodes: new Set(['fr-fr']),
    pagePaths: new Set(['/', '/it', '/ui']),
    inlineSources: [
      { file: 'it.js', kind: 'page-js', pageUrl: '/it' },
      { file: 'home.js', kind: 'page-js', pageUrl: '/' },
    ],
  };
  const s = { ...session, model };
  const tabs = { pages: () => [home, native, localized, unknown] };
  await refreshPages(tabs, s, ['it.js']);
  assert.deepEqual([home.reloads, native.reloads, localized.reloads, unknown.reloads], [0, 1, 1, 0]);
  await refreshPages(tabs, s, ['home.js']);
  assert.deepEqual([home.reloads, native.reloads, localized.reloads, unknown.reloads], [1, 1, 1, 0]);
});

test('failed document GETs are left pending and online mode does not change page styles', async () => {
  const tab = page(origin);
  tab.goto = async () => {
    throw new Error('offline');
  };
  const outcomes = new Map();
  assert.equal(await refreshPages({ pages: () => [tab] }, session, ['app.js'], { outcomes }), 'none');
  assert.equal(outcomes.get(tab).how, 'none');
  assert.equal(await refreshPages({ pages: () => [tab] }, { ...session, bypass: true }, ['main.css']), 'none');
  assert.equal(tab.evaluations, 0);
});

test('session cookies restore and save atomically without retaining persistent cookies', async () => {
  const dir = tempDirSync('paqvilo-cookies-');
  const file = path.join(dir, 'profile.session.json');
  const old = [{ name: 'old', value: 'value', domain: 'portal.example.com', path: '/', expires: -1 }];
  fs.writeFileSync(file, JSON.stringify(old));
  let restored;
  const context = Object.assign(new EventEmitter(), {
    addCookies: async (cookies) => {
      restored = cookies;
    },
    cookies: async () => [
      { ...old[0], name: 'new' },
      { ...old[0], name: 'persistent', expires: 9999999999 },
    ],
  });
  try {
    const stop = await keepSessionCookies(context, file, { origins: ['https://portal.example.com'] });
    assert.deepEqual(restored, old);
    await stop();
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file, 'utf8')).map((c) => c.name),
      ['new'],
    );
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    context.emit('close');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owned profiles discard obsolete loopback Mirage port cookies while preserving selected runtimes and remote cookies', async (t) => {
  const dir = tempDirSync('paqvilo-cookie-ports-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessions.json'),
    cookie = (name, domain = '127.0.0.1') => ({ name, domain, path: '/', expires: -1, value: 'invented' });
  const cookies = [
    cookie('paqvilo-mirage-auth-8000'),
    cookie('paqvilo-mirage-idp-8000'),
    cookie('paqvilo-mirage-auth-9000'),
    cookie('paqvilo-mirage-auth-9100'),
    cookie('session', 'portal.example.test'),
    cookie('paqvilo-mirage-auth-8000', 'portal.example.test'),
  ];
  fs.writeFileSync(file, JSON.stringify(cookies));
  const removed = [];
  let restored;
  const context = Object.assign(new EventEmitter(), {
    cookies: async () => cookies,
    clearCookies: async (match) => removed.push(match.name),
    addCookies: async (values) => {
      restored = values;
    },
  });
  const stop = await keepSessionCookies(context, file, {
    origins: ['http://127.0.0.1:9000', 'http://127.0.0.1:9100', 'https://portal.example.test'],
  });
  await stop();
  assert.deepEqual(removed, ['paqvilo-mirage-auth-8000', 'paqvilo-mirage-idp-8000']);
  assert.deepEqual(
    restored.map((item) => [item.name, item.domain]),
    [
      ['paqvilo-mirage-auth-9000', '127.0.0.1'],
      ['paqvilo-mirage-auth-9100', '127.0.0.1'],
      ['session', 'portal.example.test'],
      ['paqvilo-mirage-auth-8000', 'portal.example.test'],
    ],
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 4);
});

// @test-kind security: owned profiles save and restore only the session cookies of the portal origins
test('owned profiles save and restore only the session cookies of the portal origins', async (t) => {
  const dir = tempDirSync('paqvilo-cookie-scope-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'profile.session.json');
  const cookie = (name, domain) => ({ name, domain, path: '/', expires: -1, value: 'invented' });
  const cookies = [
    cookie('portal', 'portal.example.test'),
    cookie('domain', '.example.test'),
    cookie('idp', 'login.example.net'),
  ];
  fs.writeFileSync(file, JSON.stringify(cookies));
  let restored;
  const context = Object.assign(new EventEmitter(), {
    cookies: async () => cookies,
    addCookies: async (values) => {
      restored = values;
    },
  });
  const stop = await keepSessionCookies(context, file, { origins: ['https://portal.example.test'] });
  await stop();
  assert.deepEqual(
    restored.map((item) => item.name),
    ['portal', 'domain'],
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, 'utf8')).map((item) => item.name),
    ['portal', 'domain'],
  );
});

// Fake browser context: `live` is what the browser holds, and `restored` collects the cookies put back into it.
function fakeSessionContext(live) {
  const context = Object.assign(new EventEmitter(), {
    restored: [],
    cookies: async () => live,
    addCookies: async (values) => {
      context.restored.push(...values);
    },
    close: async () => {
      context.emit('close');
    },
  });
  return context;
}

// Installs the launch mock once; a test sets `launch.context` before each open.
function fakeLaunch(t) {
  const launch = { context: null };
  t.mock.method(chromium, 'launchPersistentContext', async () => launch.context);
  return launch;
}

const portalConfig = (configDir, origin) => ({
  configDir,
  siteName: 'test',
  envName: 'dev',
  origin,
  browser: { channel: 'chromium', headless: true },
});

// The session files of the profile `${dir}/profile`, sorted by name.
const sessionFilesIn = (dir) =>
  fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('profile.session.'))
    .toSorted((a, b) => a.localeCompare(b));

// @test-kind security: portals that share one profile keep separate session files and never restore each other's cookies
test('portals that share one profile keep separate session files and restore only their own cookies', async (t) => {
  const dir = tempDirSync('paqvilo-session-scope-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profileDir = path.join(dir, 'profile');
  const launch = fakeLaunch(t);
  launch.context = fakeSessionContext([sessionCookie('session-a', 'a.example.test')]);
  const openedA = await openBrowser(portalConfig(dir, 'https://a.example.test'), { profileDir });
  await openedA.close();
  const [fileA] = sessionFilesIn(dir);
  const bytesA = fs.readFileSync(path.join(dir, fileA), 'utf8');

  launch.context = fakeSessionContext([sessionCookie('session-b', 'b.example.test')]);
  const openedB = await openBrowser(portalConfig(dir, 'https://b.example.test'), { profileDir });
  assert.deepEqual(launch.context.restored, []);
  await openedB.close();

  assert.equal(sessionFilesIn(dir).length, 2);
  assert.equal(fs.readFileSync(path.join(dir, fileA), 'utf8'), bytesA);
});

// @test-kind security: the same portal hosts in another order or case select the same session file
test('the same portal hosts in another order or case select the same session file', async (t) => {
  const dir = tempDirSync('paqvilo-session-order-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profileDir = path.join(dir, 'profile');
  const launch = fakeLaunch(t);
  launch.context = fakeSessionContext([
    sessionCookie('session-a', 'a.example.test'),
    sessionCookie('session-b', 'b.example.test'),
  ]);
  const first = await openBrowser(portalConfig(dir, 'https://a.example.test'), {
    profileDir,
    cookieOrigins: ['https://b.example.test', 'https://A.example.test'],
  });
  await first.close();

  launch.context = fakeSessionContext([]);
  const second = await openBrowser(portalConfig(dir, 'https://a.example.test'), {
    profileDir,
    cookieOrigins: ['https://B.example.test', 'https://a.example.test'],
  });
  assert.deepEqual(
    launch.context.restored.map((item) => item.name),
    ['session-a', 'session-b'],
  );
  await second.close();
  assert.equal(sessionFilesIn(dir).length, 1);
});

// @test-kind security: an unscoped session file from an earlier version is deleted on open and never restored
test('an unscoped session file from an earlier version is deleted on open and never restored', async (t) => {
  const dir = tempDirSync('paqvilo-session-legacy-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profileDir = path.join(dir, 'profile');
  const legacy = `${profileDir}.session.json`;
  fs.writeFileSync(
    legacy,
    JSON.stringify([sessionCookie('session-a', 'a.example.test'), sessionCookie('idp', 'login.example.net')]),
  );
  const launch = fakeLaunch(t);
  launch.context = fakeSessionContext([]);
  const opened = await openBrowser(portalConfig(dir, 'https://a.example.test'), { profileDir });
  assert.equal(fs.existsSync(legacy), false);
  assert.deepEqual(launch.context.restored, []);
  await opened.close();
});

// @test-kind security: a legacy session file that cannot be deleted is reported in one line and the browser still opens
test('a legacy session file that cannot be deleted is reported in one line and the browser still opens', async (t) => {
  const dir = tempDirSync('paqvilo-session-legacy-fail-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profileDir = path.join(dir, 'profile');
  const legacy = `${profileDir}.session.json`;
  fs.writeFileSync(legacy, '[]');
  const remove = fs.rmSync;
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (target === legacy)
      throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${legacy}'`), { code: 'EPERM' });
    return remove(target, options);
  });
  const error = t.mock.method(console, 'error', () => {});
  const launch = fakeLaunch(t);
  launch.context = fakeSessionContext([]);
  const opened = await openBrowser(portalConfig(dir, 'https://a.example.test'), { profileDir });
  await opened.close();
  assert.deepEqual(
    error.mock.calls.map((call) => call.arguments[0]),
    [
      `Could not remove the unscoped session file ${legacy}: EPERM: operation not permitted, unlink '${legacy}'. It is not read.`,
    ],
  );
});

// @test-kind security: the session file name is a hash of the portal scope and carries no host text
test('the session file name carries a hash of the portal scope and no host text', async (t) => {
  const dir = tempDirSync('paqvilo-session-name-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const launch = fakeLaunch(t);
  launch.context = fakeSessionContext([sessionCookie('session-a', 'portal.example.test')]);
  const opened = await openBrowser(portalConfig(dir, 'https://portal.example.test'), {
    profileDir: path.join(dir, 'profile'),
  });
  await opened.close();
  assert.deepEqual(
    sessionFilesIn(dir).map((name) => name.replace(/[0-9a-f]{16}/, '<scope>')),
    ['profile.session.<scope>.json'],
  );
});

// Restores the cookies that `origins` admits from a session file holding `cookies`; returns their names.
async function restoredCookieNames(file, origins, cookies) {
  fs.writeFileSync(file, JSON.stringify(cookies));
  let restored = [];
  const context = Object.assign(new EventEmitter(), {
    cookies: async () => cookies,
    addCookies: async (values) => {
      restored = values;
    },
  });
  const stop = await keepSessionCookies(context, file, { origins });
  await stop();
  context.emit('close');
  return restored.map((item) => item.name);
}

const sessionCookie = (name, domain) => ({ name, domain, path: '/', expires: -1, value: 'invented' });

// @test-kind security: an empty origin list restores nothing and leaves the stored session file byte-identical
test('an empty origin list restores nothing and leaves the stored session file byte-identical', async (t) => {
  const dir = tempDirSync('paqvilo-cookie-empty-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'profile.session.json');
  const stored = JSON.stringify([sessionCookie('session', 'portal.example.com')], null, 2);
  fs.writeFileSync(file, stored);
  let restored;
  const context = Object.assign(new EventEmitter(), {
    cookies: async () => [sessionCookie('session', 'portal.example.com'), sessionCookie('other', 'login.example.net')],
    addCookies: async (values) => {
      restored = values;
    },
  });
  const stop = await keepSessionCookies(context, file, { origins: [] });
  await stop();
  context.emit('close');
  assert.equal(restored, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), stored);
});

// @test-kind security: cookies match the origin host on label boundaries and ignore its port
test('session cookies match the origin host on label boundaries, ignoring ports', async (t) => {
  const dir = tempDirSync('paqvilo-cookie-match-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'profile.session.json');
  const portal = [
    sessionCookie('host', 'portal.example.com'),
    sessionCookie('parent', '.example.com'),
    sessionCookie('lookalike', 'evilportal.example.com'),
    sessionCookie('suffix', 'example.com.evil.test'),
  ];
  assert.deepEqual(await restoredCookieNames(file, ['https://portal.example.com:8443'], portal), ['host', 'parent']);
  assert.deepEqual(await restoredCookieNames(file, ['https://portal.example.com'], portal), ['host', 'parent']);
  const ipv6 = [sessionCookie('bracketed', '[::1]'), sessionCookie('bare', '::1'), sessionCookie('local', 'localhost')];
  assert.deepEqual(await restoredCookieNames(file, ['http://[::1]:5000'], ipv6), ['bracketed', 'bare']);
  const loopback = [sessionCookie('localhost', 'localhost'), sessionCookie('ipv4', '127.0.0.1')];
  assert.deepEqual(await restoredCookieNames(file, ['http://127.0.0.1:5000'], loopback), ['ipv4']);
  assert.deepEqual(await restoredCookieNames(file, ['http://localhost:5000'], loopback), ['localhost']);
});

// @test-kind security: a download name cannot write outside Downloads
test('download names cannot escape Downloads or name a Windows device', () => {
  assert.equal(safeDownloadName('../../private/data.txt'), 'data.txt');
  assert.equal(safeDownloadName('..\\private\\data.txt'), 'data.txt');
  assert.equal(safeDownloadName('CON.txt'), '_CON.txt');
  assert.equal(safeDownloadName('report?.txt'), 'report_.txt');
  assert.equal(safeDownloadName('...'), 'download');
});

test('unchanged session cookies do not rewrite credentials and stopping is idempotent', async (t) => {
  const dir = tempDirSync('paqvilo-cookie-cache-');
  const file = path.join(dir, 'profile.session.json');
  const cookies = [{ name: 'session', value: 'secret', domain: 'portal.example.com', path: '/', expires: -1 }];
  fs.writeFileSync(file, JSON.stringify(cookies));
  const context = Object.assign(new EventEmitter(), { addCookies: async () => {}, cookies: async () => cookies });
  const write = t.mock.method(fs, 'writeFileSync');
  try {
    const stop = await keepSessionCookies(context, file, { origins: ['https://portal.example.com'] });
    await Promise.all([stop(), stop()]);
    assert.equal(write.mock.callCount(), 0);
    context.emit('close');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('the debugger port wait keeps polling past ten refused attempts until the launched target is listed', async (t) => {
  const root = tempDirSync('paqvilo-debugger-wait-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = await freeLoopbackPort();
  // The mocked clock only moves when the test ticks it, so each poll pause is released by the test.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let listings = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    listings++;
    if (listings <= 20) throw new TypeError('fetch failed');
    return { ok: true, json: async () => [{ id: 'target-1' }] };
  });
  const context = Object.assign(new EventEmitter(), {
    pages: () => [{}],
    newCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: 'target-1' } }),
      detach: async () => {},
    }),
    close: async () => {
      context.emit('close');
    },
  });
  t.mock.method(chromium, 'launchPersistentContext', async () => context);
  let opened = null;
  openBrowser(
    { configDir: root, siteName: 'test', envName: 'dev', browser: { channel: 'chromium', headless: true } },
    { profileDir: path.join(root, 'profile'), headless: true, debugPort: port },
  ).then(
    (browser) => {
      opened = browser;
    },
    (error) => {
      opened = error;
    },
  );
  while (!opened) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(200);
  }
  assert.equal(opened instanceof Error, false, opened?.message);
  assert.equal(listings, 21);
  await opened.close();
});

test('closing waits for a slow session cookie save and still writes the cookie file', async (t) => {
  const fixture = closeFixture(t);
  const cookie = { name: 'session', value: 'kept', domain: 'portal.example.com', path: '/', expires: -1 };
  const opened = await openBrowser(fixture.cfg, { profileDir: fixture.profileDir });
  // the save reads the cookies only at close, and that read takes 10 s of mocked time
  fixture.context.cookies = () => new Promise((resolve) => setTimeout(() => resolve([cookie]), 10_000));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const error = t.mock.method(console, 'error', () => {});
  await settleWhileTicking(t, opened.close(), 1000);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file, 'utf8')), [cookie]);
  assert.equal(error.mock.callCount(), 0);
});

test('a session cookie save that never settles ends at the close guard with one notice line', async (t) => {
  const fixture = closeFixture(t);
  const opened = await openBrowser(fixture.cfg, { profileDir: fixture.profileDir });
  fixture.context.cookies = () => new Promise(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const error = t.mock.method(console, 'error', () => {});
  await settleWhileTicking(t, opened.close(), 1000);
  assert.deepEqual(
    error.mock.calls.map((call) => call.arguments[0]),
    ['Session cookies were not saved: the browser did not answer within 30 s.'],
  );
  assert.equal(fs.existsSync(fixture.file), false);
});

test('a session cookie save that never settles is reported even when the browser has no page left', async (t) => {
  const fixture = closeFixture(t);
  const opened = await openBrowser(fixture.cfg, { profileDir: fixture.profileDir });
  fixture.context.cookies = () => new Promise(() => {});
  fixture.context.pages = () => [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const error = t.mock.method(console, 'error', () => {});
  await settleWhileTicking(t, opened.close(), 1000);
  assert.deepEqual(
    error.mock.calls.map((call) => call.arguments[0]),
    ['Session cookies were not saved: the browser did not answer within 30 s.'],
  );
});

test('a final session cookie save that fails prints the write error, not the timeout notice', async (t) => {
  const fixture = closeFixture(t);
  const opened = await openBrowser(fixture.cfg, { profileDir: fixture.profileDir });
  t.mock.method(fs, 'writeFileSync', () => {
    throw Object.assign(new Error("EACCES: permission denied, open 'profile.session.json.tmp'"), { code: 'EACCES' });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const error = t.mock.method(console, 'error', () => {});
  await settleWhileTicking(t, opened.close(), 1000);
  assert.deepEqual(
    error.mock.calls.map((call) => call.arguments[0]),
    ["Session cookies were not saved: EACCES: permission denied, open 'profile.session.json.tmp'"],
  );
});

test('closing after the user closed the browser prints no notice and leaves the session file as it was', async (t) => {
  const fixture = closeFixture(t);
  fs.writeFileSync(fixture.file, JSON.stringify([]));
  const before = fs.readFileSync(fixture.file, 'utf8');
  const opened = await openBrowser(fixture.cfg, { profileDir: fixture.profileDir });
  // The user closed the browser: its cookies can no longer be read at the final save.
  fixture.context.cookies = async () => {
    throw new Error('browserContext.cookies: Target page, context or browser has been closed');
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const error = t.mock.method(console, 'error', () => {});
  await settleWhileTicking(t, opened.close(), 1000);
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), before);
  assert.equal(error.mock.callCount(), 0);
});

// @test-kind contract: a browser guard override that is not a positive duration is rejected before any launch
test('browser guard overrides must be positive durations and are rejected before a launch', async (t) => {
  const dir = tempDirSync('paqvilo-guard-override-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const launch = t.mock.method(chromium, 'launchPersistentContext', async () =>
    assert.fail('a rejected guard override must not launch the browser'),
  );
  const cfg = {
    configDir: dir,
    siteName: 'test',
    envName: 'dev',
    origin,
    browser: { channel: 'chromium', headless: true },
  };
  const invalid = [0, -1, NaN, 'x'];
  for (const name of ['hangGuardMs', 'closeGuardMs']) {
    for (const value of invalid) {
      await assert.rejects(openBrowser(cfg, { profileDir: path.join(dir, 'profile'), [name]: value }), (error) => {
        assert.equal(error.message, `${name} must be a positive number of milliseconds.`);
        return true;
      });
    }
  }
  assert.equal(launch.mock.callCount(), 0);
});

// @test-kind contract: a browser guard override above the timer limit is clamped to that limit before a launch
test('a browser guard override above the timer limit is clamped to it', async (t) => {
  const dir = tempDirSync('paqvilo-guard-clamp-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const context = Object.assign(new EventEmitter(), { close: async () => {} });
  const launch = t.mock.method(chromium, 'launchPersistentContext', async () => context);
  const opened = await openBrowser(
    { configDir: dir, siteName: 'test', envName: 'dev', browser: { channel: 'chromium', headless: true } },
    { profileDir: path.join(dir, 'profile'), hangGuardMs: 3_000_000_000 },
  );
  assert.equal(launch.mock.calls[0].arguments[1].timeout, 2_147_483_647);
  await opened.close();
});

test('a normal close leaves no timer armed', async (t) => {
  const fixture = closeFixture(t);
  const armed = trackTimers(t);
  const opened = await openBrowser(fixture.cfg, { profileDir: fixture.profileDir });
  await opened.close();
  assert.equal(armed.size, 0);
});

test('a reload that gets no document in time is given up with one notice line', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const error = t.mock.method(console, 'error', () => {});
  const tab = page(origin);
  tab.goto = () => new Promise(() => {});
  const outcomes = new Map();
  let result;
  const refreshing = refreshPages({ pages: () => [tab] }, session, ['app.js'], { outcomes }).then((value) => {
    result = value;
  });
  for (let step = 0; result === undefined && step < 100; step++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  await refreshing;
  assert.equal(result, 'none');
  assert.equal(outcomes.get(tab).how, 'none');
  assert.deepEqual(
    error.mock.calls.map((call) => call.arguments[0]),
    ['Browser tab was not reloaded: its document did not arrive within 60 s. It keeps its previous document.'],
  );
});

// An owned headless browser whose cookie file lives beside its profile, in a fresh directory.
function closeFixture(t) {
  const dir = tempDirSync('paqvilo-close-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const context = Object.assign(new EventEmitter(), {
    cookies: async () => [],
    addCookies: async () => {},
    close: async () => {
      context.emit('close');
    },
  });
  t.mock.method(chromium, 'launchPersistentContext', async () => context);
  return {
    context,
    cfg: { configDir: dir, siteName: 'test', envName: 'dev', origin, browser: { channel: 'chromium', headless: true } },
    profileDir: path.join(dir, 'profile'),
    file: sessionFileFor(path.join(dir, 'profile'), [origin]),
  };
}

// Advances the mocked clock step by step until the promise settles, so each pending callback runs in turn.
async function settleWhileTicking(t, promise, stepMs) {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  promise.then(mark, mark);
  for (let step = 0; !settled && step < 100; step++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(stepMs);
  }
  assert.ok(settled, 'the close did not finish within the mocked clock steps');
  await promise;
}

// Records the timers that are scheduled and not yet cleared, so a test can assert that none is left armed.
function trackTimers(t) {
  const armed = new Set();
  const {
    setTimeout: startTimer,
    clearTimeout: stopTimer,
    setInterval: startInterval,
    clearInterval: stopInterval,
  } = globalThis;
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    const handle = startTimer(() => {
      armed.delete(handle);
      callback();
    }, ms);
    armed.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => {
    armed.delete(handle);
    stopTimer(handle);
  });
  t.mock.method(globalThis, 'setInterval', (callback, ms) => {
    const handle = startInterval(callback, ms);
    armed.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearInterval', (handle) => {
    armed.delete(handle);
    stopInterval(handle);
  });
  return armed;
}

test('a launch that Playwright times out is reported as the hang guard whatever its message says', async (t) => {
  const dir = tempDirSync('paqvilo-launch-guard-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const timeout = Object.assign(new Error('the launch was cut short'), { name: 'TimeoutError' });
  t.mock.method(chromium, 'launchPersistentContext', async () => {
    throw timeout;
  });
  await assert.rejects(
    openBrowser(portalConfig(dir, origin), { profileDir: path.join(dir, 'profile'), hangGuardMs: 5 }),
    (error) => {
      assert.match(error.message, /Launching the browser profile did not finish within 5 ms/);
      assert.equal(error.cause, timeout);
      return true;
    },
  );
});

test('a failed launch names the profile as in use only while its browser lock file is present', async (t) => {
  const launchError = new Error('browser exited during start-up');
  t.mock.method(chromium, 'launchPersistentContext', async () => {
    throw launchError;
  });
  for (const lock of ['lockfile', 'SingletonLock', null]) {
    const dir = tempDirSync('paqvilo-profile-lock-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const profileDir = path.join(dir, 'profile');
    fs.mkdirSync(profileDir);
    if (lock) fs.writeFileSync(path.join(profileDir, lock), '');
    await assert.rejects(openBrowser(portalConfig(dir, origin), { profileDir }), (error) => {
      if (lock) assert.match(error.message, /is in use or could not start/);
      else assert.equal(error, launchError);
      return true;
    });
  }
});

test('a launch timeout keeps its hang-guard message while the profile lock file is present', async (t) => {
  t.mock.method(chromium, 'launchPersistentContext', async () => {
    throw Object.assign(new Error('Timeout 5ms exceeded.'), { name: 'TimeoutError' });
  });
  const dir = tempDirSync('paqvilo-profile-timeout-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(profileDir);
  fs.writeFileSync(path.join(profileDir, 'lockfile'), '');
  await assert.rejects(openBrowser(portalConfig(dir, origin), { profileDir, hangGuardMs: 5 }), (error) => {
    assert.match(error.message, /Launching the browser profile did not finish within 5 ms/);
    assert.doesNotMatch(error.message, /in use/);
    return true;
  });
});

test('a missing browser executable is named as not installed while a stale SingletonLock is present', async (t) => {
  t.mock.method(chromium, 'launchPersistentContext', async () => {
    throw new Error("browserType.launchPersistentContext: Executable doesn't exist at /invented/msedge");
  });
  const dir = tempDirSync('paqvilo-profile-missing-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(profileDir);
  fs.writeFileSync(path.join(profileDir, 'SingletonLock'), '');
  await assert.rejects(openBrowser(portalConfig(dir, origin), { profileDir }), (error) => {
    assert.match(error.message, /is not installed/);
    assert.doesNotMatch(error.message, /in use/);
    return true;
  });
});

test('a dangling SingletonLock link whose target cannot be parsed still names the profile as in use', async (t) => {
  t.mock.method(chromium, 'launchPersistentContext', async () => {
    throw new Error('browser exited during start-up');
  });
  const dir = tempDirSync('paqvilo-profile-dangling-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(profileDir);
  const lockPath = path.join(profileDir, 'SingletonLock');
  fs.symlinkSync(path.join(dir, 'gone'), lockPath, 'junction');
  assert.equal(fs.existsSync(lockPath), false, 'an existence test misses the dangling link');
  await assert.rejects(openBrowser(portalConfig(dir, origin), { profileDir }), (error) => {
    assert.match(error.message, /is in use or could not start/);
    return true;
  });
});

test('a SingletonLock link that names another host does not hold the profile', async (t) => {
  const launchError = new Error('browser exited during start-up');
  t.mock.method(chromium, 'launchPersistentContext', async () => {
    throw launchError;
  });
  const dir = tempDirSync('paqvilo-profile-other-host-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(profileDir);
  fs.symlinkSync('invented-host-12345', path.join(profileDir, 'SingletonLock'), 'junction');
  await assert.rejects(openBrowser(portalConfig(dir, origin), { profileDir }), (error) => {
    assert.equal(error, launchError);
    return true;
  });
});

test('a SingletonLock link is held only by a live process on the host it names', (t) => {
  const dir = tempDirSync('paqvilo-profile-live-link-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync('lock-host-4242', path.join(dir, 'SingletonLock'), 'junction');
  const probed = [];
  const alive = (pid) => {
    probed.push(pid);
    return true;
  };
  assert.equal(profileLockPresent(dir, { hostname: 'lock-host', alive }), true);
  assert.equal(profileLockPresent(dir, { hostname: 'lock-host', alive: () => false }), false);
  assert.equal(profileLockPresent(dir, { hostname: 'other-host', alive }), false);
  assert.deepEqual(probed, [4242]);
});
