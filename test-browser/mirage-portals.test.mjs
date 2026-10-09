// mirage dev with portals=all: several local Mirages and live targets in one browser
// context, switched through the panel's portal selector. Loopback fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { loadDevTargets } from '../lense/config.mjs';
import { startDevSessions } from '../lense/dev-sessions.mjs';
import { mirageTarget } from '../lense/commands/mirage.mjs';
import { createFixture } from '../test/fixture.mjs';
import { createSimulator } from '../mirage/server.mjs';

const ENHANCED = fs.realpathSync.native(fileURLToPath(new URL('./fixtures/enhanced/', import.meta.url)));
const MEMBER = 'e1000000-0000-4000-8000-000000000111';

async function serveLive(servers) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><html><head><title>Live fixture</title></head><body><h1 id="live">Live fixture</h1></body></html>');
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

const people = { mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } }, tables: { contact: [{ contactid: 'alex', firstname: 'Alex', lastname: 'Local', fullname: 'Alex Local' }] } };

test('local Mirage portals and live targets share one browser: the selector switches between them, each keeping its own sign-in session', { timeout: 240_000 }, async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-mirage-portals-')));
  const classic = createFixture();
  const servers = [];
  let browser, runtime;
  const apps = [];
  t.after(async () => {
    await runtime?.close();
    await browser?.close();
    for (const app of apps) await app.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    classic.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const live = await serveLive(servers);
  const config = path.join(work, 'paqvilo.config.yml');
  fs.writeFileSync(config, JSON.stringify({
    defaultSite: 'classic',
    portals: 'all',
    defaults: { scope: 'all' },
    sites: {
      classic: { source: classic.dir, defaultEnv: 'dev', environments: { dev: live.origin } },
      enhanced: { source: ENHANCED, defaultEnv: 'local', environments: { local: 'http://127.0.0.1:9' } },
    },
  }, null, 2));
  const catalogue = await loadDevTargets({ config }, {});
  const siteCfg = (site) => catalogue.targets.find((cfg) => cfg.siteName === site);
  const start = async (sourceDir, extra = {}) => {
    const app = await createSimulator({
      sourceDir,
      stateFile: path.join(work, `state-${apps.length}`, 'state.json'),
      watch: false,
      initial: { version: 1, ...people, settings: { permissionMode: 'enforce' }, simulator: { mode: 'local', pageMode: 'local', identity: { roles: [] }, live: {}, endpoints: [], ...extra } },
    });
    apps.push(app);
    return app;
  };
  const classicApp = await start(classic.dir);
  const enhancedApp = await start(ENHANCED, { permissionSource: 'exported', contactRoles: [{ contactId: 'alex', roleId: MEMBER }] });
  const session = (app, sourceDir) => ({ url: app.url, sourceDir, launch: { solutionRoots: [] }, pid: process.pid, started: false });
  const classicLocal = mirageTarget(siteCfg('classic'), session(classicApp, classic.dir));
  const enhancedLocal = mirageTarget(siteCfg('enhanced'), session(enhancedApp, ENHANCED));
  // The live origin of the classic site; the enhanced site's placeholder origin is not offered.
  const liveTargets = catalogue.targets.filter((cfg) => cfg.siteName === 'classic');
  const selection = { mode: 'all', initial: classicLocal, targets: [classicLocal, enhancedLocal, ...liveTargets] };

  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true, args: ['--disable-background-networking', '--disable-component-update'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 1000 } });
  context.setDefaultTimeout(20_000);
  const allowed = new Set([classicApp.url, enhancedApp.url, live.origin]);
  await context.route('**/*', (route) => (allowed.has(new URL(route.request().url()).origin) ? route.fallback() : route.abort()));
  runtime = await startDevSessions(context, selection, { log: () => {}, debugPort: null });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const panel = (selector) => page.locator(`#paqvilo-panel ${selector}`);
  const label = () => page.locator('#paqvilo-panel').getAttribute('data-label');
  const openTab = async (tab) => {
    await panel('.pill').waitFor({ state: 'attached' });
    if (await panel('.pill').isVisible()) await panel('.pill').click();
    await panel(`.tabs [data-act="tab"][data-v="${tab}"]`).click();
  };
  const choose = async (index, origin) => {
    await openTab('overrides');
    await Promise.all([page.waitForURL((url) => url.origin === origin), page.getByLabel('Portal / environment', { exact: true }).selectOption(String(index))]);
  };
  const signedIn = async (app) => (await (await context.request.get(`${app.url}/_sim/api/session`)).json()).signedIn;

  // The first local portal opens in Mirage mode; the selector lists both runtimes and the live target.
  await page.goto(`${classicApp.url}/`);
  await page.waitForFunction(() => document.getElementById('paqvilo-panel')?.dataset.label === 'classic Mirage @ local');
  await openTab('runtime');
  await panel('.card').filter({ hasText: 'Current persona' }).getByText('allowed', { exact: true }).waitFor();
  const options = await page.getByLabel('Portal / environment', { exact: true }).locator('option').allInnerTexts();
  assert.equal(options.length, 3);
  assert.ok(options[0].includes('classic Mirage @ local') && options[1].includes('enhanced Mirage @ local') && options[2].includes('classic @ dev'), options.join(' | '));

  // Switch to the enhanced Mirage without restarting: its own Inspect report and sign-in.
  await choose(1, enhancedApp.url);
  await page.waitForFunction(() => document.getElementById('paqvilo-panel')?.dataset.label === 'enhanced Mirage @ local');
  await openTab('runtime');
  await panel('[data-group="runtime-chain"] .row').filter({ hasText: 'Partial' }).first().waitFor();
  await openTab('tweaks');
  await panel('select[data-pick="persona"]').selectOption('alex');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), panel('[data-act="signin"]').click()]);
  await page.locator('#who').getByText('Alex Local', { exact: true }).waitFor();
  assert.deepEqual([await signedIn(enhancedApp), await signedIn(classicApp)], [true, false], 'signing in on one local portal leaves the other anonymous');

  // Back on the classic Mirage: sign in there too; both sessions now coexist (one cookie per port).
  await choose(0, classicApp.url);
  await openTab('tweaks');
  await panel('.card').filter({ hasText: 'Browser session' }).getByText('Anonymous', { exact: true }).waitFor();
  await panel('select[data-pick="persona"]').selectOption('alex');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), panel('[data-act="signin"]').click()]);
  assert.deepEqual([await signedIn(classicApp), await signedIn(enhancedApp)], [true, true]);
  const names = (await context.cookies()).map((cookie) => cookie.name).filter((name) => name.startsWith('paqvilo-mirage-auth')).sort();
  assert.deepEqual(names, [`paqvilo-mirage-auth-${new URL(classicApp.url).port}`, `paqvilo-mirage-auth-${new URL(enhancedApp.url).port}`].sort());
  await choose(1, enhancedApp.url);
  await page.locator('#who').getByText('Alex Local', { exact: true }).waitFor();

  // And out to the live target: an overlay session (no Mirage tabs), then back again.
  await choose(2, live.origin);
  await page.locator('#live').waitFor();
  await page.waitForFunction(() => document.getElementById('paqvilo-panel')?.dataset.label === 'classic @ dev');
  assert.equal(await panel('.tabs [data-act="tab"][data-v="runtime"]').count(), 0, 'live targets use the overlay panel');
  await choose(0, classicApp.url);
  assert.equal(await label(), 'classic Mirage @ local');
  assert.deepEqual(errors, []);
});
