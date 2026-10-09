// All catalogue/browser traffic in this proof stays on disposable loopback origins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { loadDevTargets } from '../lense/config.mjs';
import { openBrowser } from '../lense/browser.mjs';
import { startDevSessions } from '../lense/dev-sessions.mjs';
import { createFixture, HOME_ID } from '../test/fixture.mjs';

const APP = 'web-files/app.js';
const CSS = 'web-files/theme.css';
const script = (value) => `window.localSite = ${JSON.stringify(value)};\n`;
const style = (color) => `#theme { color: ${color}; }\n`;

async function serve(name, servers, { redirectTo, markup = '' } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith('/')) return response.writeHead(403).end();
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push({ method: request.method, pathname });
    response.setHeader('cache-control', 'no-store');
    if (pathname === '/scripts/app.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(script(`online-${name}`));
    if (pathname === '/theme.css') return response.writeHead(200, { 'content-type': 'text/css' }).end(style('rgb(1, 2, 3)'));
    if (pathname === '/favicon.ico') return response.writeHead(204).end();
    if (pathname.startsWith('/__paqvilo/')) return response.writeHead(500).end('A local endpoint leaked to the fixture server');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><title>${name} fixture</title>${redirectTo ? `<meta http-equiv="refresh" content="0.3;url=${redirectTo}">` : ''}<link rel="stylesheet" href="/theme.css"><script src="/scripts/app.js"></script></head><body><h1>${name} synthetic portal</h1>${markup}<p id="theme">Same-path resource isolation</p></body></html>`);
  });
  server.on('connect', (_request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { name, origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test('headless checks preserve the saved headed window placement in owned and selected external profiles', { timeout: 60_000 }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-headless-placement-'));
  const servers = [];
  let browser;
  t.after(async () => {
    await browser?.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const fixture = await serve('placement', servers);
  const launch = chromium.launchPersistentContext;
  t.mock.method(chromium, 'launchPersistentContext', function (profile, options) {
    return launch.call(this, profile, { ...options, proxy: { server: fixture.origin, bypass: '127.0.0.1,localhost' }, args: [...options.args, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
  });
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  for (const external of [false, true]) {
    const root = path.join(work, external ? 'external' : 'profiles/test-dev');
    const child = external ? 'Profile 2' : 'Default';
    const prefs = path.join(root, child, 'Preferences');
    fs.mkdirSync(path.dirname(prefs), { recursive: true });
    fs.writeFileSync(prefs, JSON.stringify({ browser: { window_placement: { left: 0, top: 0, right: 1200, bottom: 820, maximized: false } } }));
    browser = await openBrowser({ configDir: work, siteName: 'test', envName: 'dev', browser: { channel, headless: true, ...(external ? { userDataDir: root, profileDirectory: child } : { profileDir: 'profiles' }) } });
    const page = browser.context.pages()[0] ?? await browser.context.newPage();
    await page.goto(fixture.origin);
    assert.deepEqual(page.viewportSize(), { width: 1440, height: 900 }, 'verification retains its independent test viewport');
    await browser.close(); browser = null;
    const saved = JSON.parse(fs.readFileSync(prefs, 'utf8')).browser.window_placement;
    assert.equal(saved.right - saved.left, 1200);
    assert.equal(saved.bottom - saved.top, 820);
    assert.equal(saved.maximized, false);
    if (external) assert.equal(fs.existsSync(`${root}.session.json`), false, 'no external session credentials are exported');
  }
});

// Toolkit profiles keep Edge at its historical path; other channels live under default/<channel>/.
const toolkitProfile = (work, channel, name) => (channel === 'msedge' ? path.join(work, 'profiles', name) : path.join(work, 'profiles', 'default', channel, name));

test('one catalogue browser isolates lazy portal sessions, environments, panels, APIs and source refreshes', { timeout: 180_000 }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-multi-portal-'));
  const alpha = createFixture();
  const beta = createFixture();
  const servers = [];
  let browser;
  let runtime;
  const launches = [];
  const launch = chromium.launchPersistentContext;
  t.after(async () => {
    chromium.launchPersistentContext = launch;
    await runtime?.close();
    await browser?.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    alpha.cleanup(); beta.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const [alphaDev, alphaTest, betaDev, betaExtra, foreign] = await Promise.all(['alpha-dev', 'alpha-test', 'beta-dev', 'beta-extra', 'foreign'].map((name) => serve(name, servers)));
  for (const [fixture, name, color] of [[alpha, 'alpha-v1', 'rgb(10, 20, 30)'], [beta, 'beta-v1', 'rgb(40, 50, 60)']]) {
    fixture.write(APP, script(name));
    fixture.write(CSS, style(color));
    fixture.write(`${CSS}.webfile.yml`, `adx_name: theme.css\nadx_partialurl: theme.css\nadx_parentpageid: ${HOME_ID}\nfilename: theme.css\n`);
  }
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  const config = path.join(work, 'paqvilo.config.yml');
  fs.writeFileSync(config, JSON.stringify({
    defaultSite: 'alpha',
    browser: { channel, headless: true, debugPort: 0, profileDir: 'profiles' },
    defaults: { scope: 'all' },
    sites: {
      alpha: { source: alpha.dir, defaultEnv: 'dev', environments: { dev: alphaDev.origin, test: alphaTest.origin } },
      beta: { source: beta.dir, defaultEnv: 'dev', environments: { dev: betaDev.origin } },
    },
  }, null, 2));
  fs.writeFileSync(path.join(work, '.env'), `PAQVILO_PORTALS=all\nPAQVILO_BETA_ENV_EXTRA=${betaExtra.origin}\n`);
  const selection = await loadDevTargets({ config }, {});
  assert.equal(selection.mode, 'all');
  assert.equal(selection.targets.length, 4, 'the per-site .env origin joins the catalogue');
  assert.deepEqual(new Set(selection.targets.map((cfg) => cfg.origin)), new Set([alphaDev.origin, alphaTest.origin, betaDev.origin, betaExtra.origin]));
  assert.equal(selection.initial, selection.targets.find((cfg) => cfg.origin === alphaDev.origin));
  chromium.launchPersistentContext = async function (profileDir, options) {
    launches.push(profileDir);
    return launch.call(this, profileDir, { ...options, proxy: { server: foreign.origin, bypass: '127.0.0.1,localhost' }, args: [...options.args, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
  };
  browser = await openBrowser(selection.initial);
  chromium.launchPersistentContext = launch;
  assert.equal(launches.length, 1);
  assert.equal(launches[0], toolkitProfile(work, channel, 'catalogue'), 'all-portal mode uses a dedicated catalogue profile');
  const { context } = browser;
  context.setDefaultTimeout(20_000);
  const contextPageListeners = context.listenerCount('page');
  const errors = [];
  const observe = (page) => page.on('pageerror', (error) => errors.push(error.message));
  context.pages().forEach(observe); context.on('page', observe);
  const logs = [];
  runtime = await startDevSessions(context, selection, { log: (line) => logs.push(line), debugPort: null });
  assert.deepEqual([...runtime.active.keys()], [alphaDev.origin], 'only the selected source is initialized before a portal is visited');
  assert.ok([alphaDev, alphaTest, betaDev, betaExtra, foreign].every((fixture) => fixture.requests.length === 0), 'registering the catalogue never visits environments');
  const main = context.pages()[0] ?? await context.newPage();
  const assertPortal = async (page, fixture, value, color) => {
    await page.waitForFunction((expected) => window.localSite === expected, value);
    await page.waitForFunction((label) => document.getElementById('paqvilo-panel')?.dataset.label === label, fixture.name.replace(/-(dev|test|extra)$/, ' @ $1'));
    assert.equal(await page.locator('#paqvilo-panel').count(), 1, 'one current panel owns the page');
    assert.equal(await page.locator('#theme').evaluate((node) => getComputedStyle(node).color), color);
  };
  await main.goto(alphaDev.origin, { waitUntil: 'load' });
  await assertPortal(main, alphaDev, 'alpha-v1', 'rgb(10, 20, 30)');
  await main.locator('#paqvilo-panel .pill').click();
  const switcher = main.getByLabel('Portal / environment');
  assert.equal(await switcher.locator('option').count(), 4);
  assert.ok((await switcher.locator('option').allTextContents()).includes('beta @ extra'), 'the .env-added environment is selectable in the panel');
  await Promise.all([main.waitForNavigation({ waitUntil: 'load' }), switcher.selectOption({ label: 'beta @ dev' })]);
  await assertPortal(main, betaDev, 'beta-v1', 'rgb(40, 50, 60)');
  assert.equal(runtime.active.size, 2, 'navigation in an existing tab activates its matching source');
  await main.goto(alphaDev.origin, { waitUntil: 'load' });
  await assertPortal(main, alphaDev, 'alpha-v1', 'rgb(10, 20, 30)');
  const popupPromise = main.waitForEvent('popup');
  await main.evaluate((url) => window.open(url, '_blank'), alphaTest.origin);
  const popup = await popupPromise;
  await assertPortal(popup, alphaTest, 'alpha-v1', 'rgb(10, 20, 30)');
  const [betaPage, extraOne, extraTwo] = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  await Promise.all([betaPage.goto(betaDev.origin), extraOne.goto(betaExtra.origin), extraTwo.goto(betaExtra.origin)]);
  await Promise.all([assertPortal(betaPage, betaDev, 'beta-v1', 'rgb(40, 50, 60)'), assertPortal(extraOne, betaExtra, 'beta-v1', 'rgb(40, 50, 60)'), assertPortal(extraTwo, betaExtra, 'beta-v1', 'rgb(40, 50, 60)')]);
  assert.equal(runtime.active.size, 4, 'concurrent visits share one activation per origin');
  const foreignPage = await context.newPage();
  await foreignPage.goto(foreign.origin, { waitUntil: 'load' });
  assert.equal(await foreignPage.evaluate(() => window.localSite), 'online-foreign');
  assert.equal(await foreignPage.locator('#paqvilo-panel').count(), 0);
  assert.equal(runtime.active.size, 4);

  const alphaRecord = runtime.active.get(alphaDev.origin);
  const alphaTestRecord = runtime.active.get(alphaTest.origin);
  const betaRecord = runtime.active.get(betaDev.origin);
  const extraRecord = runtime.active.get(betaExtra.origin);
  const generations = new Map();
  for (const page of [main, popup, betaPage, extraOne, extraTwo, foreignPage]) {
    generations.set(page, 0);
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) generations.set(page, generations.get(page) + 1); });
    await page.evaluate(() => { window.keepOnCssSwap = true; });
  }
  const refreshed = (record) => once(record.session, 'refreshed', { signal: AbortSignal.timeout(30_000) });
  const cssRefreshes = [refreshed(alphaRecord), refreshed(alphaTestRecord)];
  alpha.write(CSS, style('rgb(70, 80, 90)'));
  for (const [event] of await Promise.all(cssRefreshes)) assert.equal(event.how, 'css');
  for (const [page, fixture] of [[main, alphaDev], [popup, alphaTest]]) {
    await page.waitForFunction(() => getComputedStyle(document.getElementById('theme')).color === 'rgb(70, 80, 90)');
    await assertPortal(page, fixture, 'alpha-v1', 'rgb(70, 80, 90)');
    assert.equal(await page.evaluate(() => window.keepOnCssSwap), true);
  }
  assert.ok([...generations.values()].every((count) => count === 0), 'CSS saves do not navigate any portal or foreign tab');
  const jsRefreshes = [refreshed(alphaRecord), refreshed(alphaTestRecord)];
  alpha.write(APP, script('alpha-v2'));
  for (const [event] of await Promise.all(jsRefreshes)) assert.equal(event.how, 'reload');
  await Promise.all([assertPortal(main, alphaDev, 'alpha-v2', 'rgb(70, 80, 90)'), assertPortal(popup, alphaTest, 'alpha-v2', 'rgb(70, 80, 90)')]);
  assert.ok(generations.get(main) > 0 && generations.get(popup) > 0);
  for (const page of [betaPage, extraOne, extraTwo, foreignPage]) assert.equal(generations.get(page), 0, 'a different source save never reloads this page');

  const panelCall = (page, token, body) => page.evaluate(async ({ token, body }) => {
    const response = await fetch('/__paqvilo/api/mode', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paqvilo-token': token }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { token, body });
  assert.equal((await panelCall(betaPage, alphaRecord.panel.stateFor(main).token, { online: true })).status, 403, 'a different portal panel token is refused');
  assert.equal(betaRecord.session.bypass, false);
  assert.equal((await panelCall(betaPage, betaRecord.panel.stateFor(betaPage).token, { online: true })).body.ok, true);
  await betaPage.goto(betaDev.origin, { waitUntil: 'load' });
  await assertPortal(betaPage, betaDev, 'online-beta-dev', 'rgb(1, 2, 3)');
  assert.equal(extraRecord.session.bypass, false, 'online/local mode is independent between environments sharing sources');
  await assertPortal(extraOne, betaExtra, 'beta-v1', 'rgb(40, 50, 60)');
  assert.equal(alphaRecord.session.bypass, false);
  assert.equal((await panelCall(betaPage, betaRecord.panel.stateFor(betaPage).token, { online: false })).body.ok, true);
  await betaPage.goto(betaDev.origin, { waitUntil: 'load' });
  await assertPortal(betaPage, betaDev, 'beta-v1', 'rgb(40, 50, 60)');

  const alphaGenerations = [generations.get(main), generations.get(popup)];
  const betaRefreshes = [refreshed(betaRecord), refreshed(extraRecord)];
  beta.write(APP, script('beta-v2'));
  for (const [event] of await Promise.all(betaRefreshes)) assert.equal(event.how, 'reload');
  await Promise.all([assertPortal(betaPage, betaDev, 'beta-v2', 'rgb(40, 50, 60)'), assertPortal(extraOne, betaExtra, 'beta-v2', 'rgb(40, 50, 60)'), assertPortal(extraTwo, betaExtra, 'beta-v2', 'rgb(40, 50, 60)')]);
  assert.deepEqual([generations.get(main), generations.get(popup)], alphaGenerations, 'a lazily activated source refresh leaves the first site alone');
  assert.equal(generations.get(foreignPage), 0);

  const discoveries = [];
  for (const [origin, record] of runtime.active) {
    assert.ok(record.agent, 'each initialized portal exposes its own bounded agent API');
    const discovery = JSON.parse(fs.readFileSync(record.agent.discoveryFile, 'utf8'));
    discoveries.push({ file: record.agent.discoveryFile, ...discovery });
    const pages = await (await fetch(discovery.endpoint + '/v1/pages', { headers: { authorization: `Bearer ${discovery.token}` } })).json();
    assert.ok(pages.pages.length > 0);
    assert.ok(pages.pages.every((page) => new URL(page.url).origin === origin), 'agent discovery sees only its configured origin');
    const status = await (await fetch(discovery.endpoint + '/v1/session', { headers: { authorization: `Bearer ${discovery.token}` } })).json();
    assert.equal(status.browserScope.mode, 'all');
    assert.equal(status.browserScope.stopScope, 'browser');
    assert.deepEqual(new Set(status.browserScope.targets.map((target) => target.origin)), new Set(selection.targets.map((target) => target.origin)));
  }
  const refusedAgent = await fetch(discoveries[1].endpoint + '/v1/session', { headers: { authorization: `Bearer ${discoveries[0].token}` } });
  assert.equal(refusedAgent.status, 401);
  assert.deepEqual(errors, []);
  assert.ok(!logs.some((line) => /\bERROR\b/.test(line)), 'no target setup or watcher errors were hidden by another portal');
  assert.ok([alphaDev, alphaTest, betaDev, betaExtra, foreign].every((fixture) => fixture.requests.every((request) => request.method === 'GET' && !request.pathname.startsWith('/__paqvilo/'))), 'all business-origin traffic is GET and panel endpoints stay local');
  const activeCount = runtime.active.size;
  await runtime.close();
  await runtime.close();
  runtime = null;
  for (const page of [main, popup, betaPage, extraOne, extraTwo, foreignPage]) assert.equal(await page.locator('#paqvilo-panel').count(), 0, 'teardown removes every target panel');
  for (const discovery of discoveries) assert.equal(fs.existsSync(discovery.file), false, 'agent discovery is removed');
  for (const discovery of discoveries) await assert.rejects(fetch(discovery.endpoint + '/v1/session', { headers: { authorization: `Bearer ${discovery.token}` }, signal: AbortSignal.timeout(1000) }), 'agent API listener is closed');
  context.off('page', observe);
  assert.equal(context.listenerCount('page'), contextPageListeners, 'session teardown releases catalogue page listeners');
  await main.goto(alphaDev.origin, { waitUntil: 'load' });
  assert.equal(await main.evaluate(() => window.localSite), 'online-alpha-dev', 'detached pages use server resources again');
  const evidence = new URL('../.paqvilo/multi-portal-round/', import.meta.url);
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(new URL('acceptance.json', evidence), JSON.stringify({ configuredOrigins: selection.targets.length, activatedOrigins: activeCount, sites: ['alpha', 'beta'], envAddedOrigin: true, navigationAndPopup: true, samePathResourceIsolation: true, selectiveReload: true, independentMode: true, isolatedAgentApis: discoveries.length, cleanup: true, errors }, null, 2));
});

test('all-day navigation retains template edits after commit and recovers a restored checkout without restart', { timeout: 90_000 }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-all-day-'));
  const alpha = createFixture();
  const beta = createFixture();
  const hidden = `${beta.dir}-temporarily-missing`;
  const servers = [];
  const logs = [];
  let browser, runtime;
  t.after(async () => {
    await runtime?.close();
    await browser?.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    if (fs.existsSync(hidden)) fs.renameSync(hidden, beta.dir);
    alpha.cleanup(); beta.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const header = 'web-templates/header/Header.webtemplate.source.html';
  const original = '<h2 id="work-status">Initial status</h2>\n';
  alpha.write(header, original);
  alpha.write(APP, script('alpha-first'));
  alpha.commit();
  beta.write(APP, script('beta-restored'));
  fs.renameSync(beta.dir, hidden);
  const alphaServer = await serve('all-day-alpha', servers, { markup: original });
  const betaServer = await serve('all-day-beta', servers);
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  const config = path.join(work, 'paqvilo.config.yml');
  fs.writeFileSync(config, JSON.stringify({ defaultSite: 'alpha', portals: 'all', browser: { channel, profileDir: 'profiles', headless: true }, sites: {
    alpha: { source: alpha.dir, environments: { dev: alphaServer.origin } },
    beta: { source: beta.dir, environments: { dev: betaServer.origin } },
  } }));
  const selection = await loadDevTargets({ config }, {});
  const launch = chromium.launchPersistentContext;
  t.mock.method(chromium, 'launchPersistentContext', function (profile, options) {
    return launch.call(this, profile, { ...options, proxy: { server: alphaServer.origin, bypass: '127.0.0.1,localhost' }, args: [...options.args, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
  });
  browser = await openBrowser(selection.initial);
  runtime = await startDevSessions(browser.context, selection, { log: (line) => logs.push(line) });
  const main = browser.context.pages()[0];
  await main.goto(alphaServer.origin);
  const record = runtime.active.get(alphaServer.origin);
  const baseline = record.session.cfg.site.markup.baseline;
  assert.match(baseline, /^[a-f0-9]{40,64}$/, 'HEAD is captured as an immutable commit');
  const changed = original.replace('Initial status', 'Working all day');
  alpha.write(header, changed);
  await main.waitForFunction(() => document.getElementById('work-status')?.textContent === 'Working all day');
  alpha.commit();
  alpha.write(APP, script('alpha-after-commit'));
  await main.waitForFunction(() => window.localSite === 'alpha-after-commit');
  assert.equal(await main.locator('#work-status').textContent(), 'Working all day', 'a later save retains already committed template edits');
  const nextPage = await browser.context.newPage();
  await nextPage.goto(alphaServer.origin + '/another-page/');
  // New tabs can begin their first request before CDP attachment; the interceptor's
  // late-tab refresh must settle before inspecting the local document.
  await nextPage.waitForFunction(() => document.getElementById('work-status')?.textContent === 'Working all day');
  assert.equal(await nextPage.locator('#work-status').textContent(), 'Working all day', 'new pages share the same session baseline');
  assert.equal(record.session.cfg.site.markup.baseline, baseline);
  await assert.rejects(main.goto(betaServer.origin), 'a missing configured checkout fails visibly');
  assert.equal(runtime.active.size, 1, 'an unavailable unused portal does not stop the working portal');
  assert.ok(logs.some((line) => line.includes('Restore the checkout and reload')));
  fs.renameSync(hidden, beta.dir);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  await main.goto(betaServer.origin);
  await main.waitForFunction(() => window.localSite === 'beta-restored');
  assert.equal(runtime.active.size, 2, 'the restored portal activates in the same browser');
  assert.equal(await nextPage.locator('#work-status').textContent(), 'Working all day');
  assert.ok([alphaServer, betaServer].every((server) => server.requests.every((request) => request.method === 'GET')));
});

test('actual dev CLI activates catalogue navigation and agent stop tears down the whole browser', { timeout: 90_000 }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-multi-cli-'));
  const fixture = createFixture();
  const servers = [];
  const toolkit = fileURLToPath(new URL('..', import.meta.url));
  const stateDir = path.join(work, '.paqvilo', 'agents');
  let child;
  let childDone;
  let lastDiscovery;
  let output = '';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PAQVILO_|GIT_)/.test(key) && !['NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'].includes(key)));
  const waitFor = async (check, message, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (child?.exitCode !== null) throw new Error(`dev exited early (${child?.exitCode}): ${output}`);
      const result = await check();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${message}: ${output}`);
  };
  t.after(async () => {
    if (child && child.exitCode === null) {
      if (lastDiscovery) await fetch(lastDiscovery.endpoint + '/v1/stop', { method: 'POST', headers: { authorization: `Bearer ${lastDiscovery.token}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000) }).catch(() => {});
      const ended = await Promise.race([childDone.then(() => true, () => true), new Promise((resolve) => setTimeout(resolve, 5000, false))]);
      if (!ended) { child.kill(); await childDone.catch(() => {}); }
    }
    for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    fixture.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const beta = await serve('cli-beta', servers);
  const alpha = await serve('cli-alpha', servers, { redirectTo: beta.origin });
  fixture.write(APP, script('cli-local'));
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  const config = path.join(work, 'paqvilo.config.yml');
  fs.writeFileSync(config, JSON.stringify({ defaultSite: 'alpha', browser: { channel, profileDir: 'profiles' }, sites: { alpha: { source: fixture.dir, environments: { dev: alpha.origin } }, beta: { source: fixture.dir, environments: { dev: beta.origin } } } }));
  // The process executes the actual CLI. A test-only preload restricts Chromium background
  // traffic; production launch/config/runtime/agent/shutdown code runs without substitution.
  const preload = path.join(work, 'loopback-browser.mjs');
  fs.writeFileSync(preload, `import { chromium } from ${JSON.stringify(import.meta.resolve('playwright-core'))};\nconst launch = chromium.launchPersistentContext;\nchromium.launchPersistentContext = function(profile, options) { return launch.call(this, profile, {...options, proxy: {server: ${JSON.stringify(alpha.origin)}, bypass: '127.0.0.1,localhost'}, args: [...options.args, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']}); };\n`);
  child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'lense/cli.mjs', 'dev', '--config', config, '--portals', 'all', '--headless', '--debug-port', '0'], { cwd: toolkit, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  childDone = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  childDone.catch(() => {});
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk.toString()).slice(-64_000); });
  const discoveries = await waitFor(() => {
    if (!fs.existsSync(stateDir)) return null;
    try {
      const entries = fs.readdirSync(stateDir).filter((name) => name.endsWith('.json')).map((name) => ({ file: path.join(stateDir, name), ...JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')) }));
      lastDiscovery = entries[0];
      return entries.length === 2 ? entries : null;
    } catch { return null; } // discovery may be in the middle of its first write
  }, 'both visited portal agents were not discovered');
  const betaAgent = discoveries.find((entry) => entry.site === 'beta');
  const headers = { authorization: `Bearer ${betaAgent.token}` };
  const page = await waitFor(async () => {
    const result = await (await fetch(betaAgent.endpoint + '/v1/pages', { headers })).json();
    return result.pages[0];
  }, 'browser never reached the second configured origin');
  const pageState = await waitFor(async () => {
    const result = await (await fetch(`${betaAgent.endpoint}/v1/pages/${page.id}/state`, { headers })).json();
    return result.resources?.some((resource) => resource.rel === APP) ? result : null;
  }, 'second portal did not use its local JavaScript');
  assert.equal(new URL(pageState.page.url).origin, beta.origin);
  const status = await (await fetch(betaAgent.endpoint + '/v1/session', { headers })).json();
  assert.equal(status.browserScope.mode, 'all');
  assert.equal(status.browserScope.targets.length, 2);
  assert.equal(status.browserScope.stopScope, 'browser');
  assert.ok(fs.existsSync(toolkitProfile(work, channel, 'catalogue')));
  assert.equal(fs.existsSync(toolkitProfile(work, channel, 'alpha-dev')), false);
  assert.ok(alpha.requests.some((request) => request.pathname === '/'), 'the configured start page opened first');
  assert.ok(beta.requests.some((request) => request.pathname === '/'), 'a normal browser navigation activated the other source');
  const stopped = await promisify(execFile)(process.execPath, ['lense/cli.mjs', 'agent', 'stop', '--session', betaAgent.file], { cwd: toolkit, env, windowsHide: true, timeout: 15_000 });
  assert.ok(JSON.parse(stopped.stdout), 'the actual agent CLI returns structured stop output');
  let exitTimer;
  const finished = await Promise.race([childDone, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error(`dev did not stop: ${output}`)), 15_000); })]).finally(() => clearTimeout(exitTimer));
  assert.equal(finished.code, 0, output);
  for (const discovery of discoveries) assert.equal(fs.existsSync(discovery.file), false, 'stop from one portal removes every browser-owned agent');
  assert.ok([alpha, beta].every((server) => server.requests.every((request) => request.method === 'GET' && !request.pathname.startsWith('/__paqvilo/'))));
  const evidence = new URL('../.paqvilo/multi-portal-round/', import.meta.url);
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(new URL('cli-smoke.json', evidence), JSON.stringify({ exitCode: finished.code, configuredOrigins: 2, agentsDiscovered: discoveries.length, catalogueProfile: true, sourceAppliedAfterNavigation: true, browserWideAgentStop: true, cleanup: true }, null, 2));
});
