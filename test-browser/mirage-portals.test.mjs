// @test-kind contract: Local portal switching preserves each browser session and waits for the destination panel.
import { ownedFixture, drainFixture } from '../mirage/testing/owned-fixture.mjs';
// mirage dev with portals=all: several local Mirages and live targets in one browser
// context, switched through the panel's portal selector.
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
    response.end(
      '<!doctype html><html><head><title>Live fixture</title></head><body><h1 id="live">Live fixture</h1></body></html>',
    );
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

const people = {
  mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } },
  tables: { contact: [{ contactid: 'alex', firstname: 'Alex', lastname: 'Local', fullname: 'Alex Local' }] },
};

// Starts the two local Mirages, the live target and one browser tab with the portal selector.
// The tab is on the classic Mirage when this returns.
async function startPortals(t) {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-mirage-portals-')));
  const classic = createFixture();
  const servers = [];
  let browser, runtime;
  const apps = [];
  ownedFixture(t).add(async () => {
    await runtime?.close();
  });
  ownedFixture(t).add(async () => {
    await browser?.close();
  });
  ownedFixture(t).add(async () => {
    await drainFixture(
      [...apps].map((app) => async () => {
        await app.close();
      }),
    );
  });
  ownedFixture(t).add(async () => {
    await drainFixture(
      [...servers].map((server) => async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }),
    );
  });
  ownedFixture(t).remove(async () => {
    classic.cleanup();
  });
  ownedFixture(t).remove(async () => {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const live = await serveLive(servers);
  const config = path.join(work, 'paqvilo.config.yml');
  fs.writeFileSync(
    config,
    JSON.stringify(
      {
        defaultSite: 'classic',
        portals: 'all',
        defaults: { scope: 'all' },
        sites: {
          classic: { source: classic.dir, defaultEnv: 'dev', environments: { dev: live.origin } },
          enhanced: { source: ENHANCED, defaultEnv: 'local', environments: { local: 'http://127.0.0.1:9' } },
        },
      },
      null,
      2,
    ),
  );
  const catalogue = await loadDevTargets({ config }, {});
  const siteCfg = (site) => catalogue.targets.find((cfg) => cfg.siteName === site);
  const start = async (sourceDir, extra = {}) => {
    const app = await createSimulator({
      sourceDir,
      stateFile: path.join(work, `state-${apps.length}`, 'state.json'),
      watch: false,
      initial: {
        version: 1,
        ...people,
        settings: { permissionMode: 'enforce' },
        simulator: { mode: 'local', pageMode: 'local', identity: { roles: [] }, live: {}, endpoints: [], ...extra },
      },
    });
    apps.push(app);
    return app;
  };
  const classicApp = await start(classic.dir);
  const enhancedApp = await start(ENHANCED, {
    permissionSource: 'exported',
    contactRoles: [{ contactId: 'alex', roleId: MEMBER }],
  });
  const session = (app, sourceDir) => ({
    url: app.url,
    sourceDir,
    launch: { solutionRoots: [] },
    pid: process.pid,
    started: false,
  });
  const classicLocal = mirageTarget(siteCfg('classic'), session(classicApp, classic.dir));
  const enhancedLocal = mirageTarget(siteCfg('enhanced'), session(enhancedApp, ENHANCED));
  // The live origin of the classic site; the enhanced site's placeholder origin is not offered.
  const liveTargets = catalogue.targets.filter((cfg) => cfg.siteName === 'classic');
  const selection = { mode: 'all', initial: classicLocal, targets: [classicLocal, enhancedLocal, ...liveTargets] };

  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 1000 } });
  const allowed = new Set([classicApp.url, enhancedApp.url, live.origin]);
  await context.route('**/*', (route) =>
    allowed.has(new URL(route.request().url()).origin) ? route.fallback() : route.abort(),
  );
  // Open the tab before startup so its interception is installed before the first navigation.
  const page = await context.newPage();
  // Hold the classic panel detached on one return navigation, after the browser
  // has committed the destination document. This makes the URL/panel race deterministic.
  await page.addInitScript(
    ({ origin }) => {
      if (location.origin !== origin || window.name !== 'paqvilo-hold-classic-panel') return;
      window.name = '';
      const getById = Document.prototype.getElementById;
      const appendChild = Node.prototype.appendChild;
      let held;
      Document.prototype.getElementById = function (id) {
        if (id === 'paqvilo-panel' && held) return held;
        return getById.call(this, id);
      };
      Node.prototype.appendChild = function (child) {
        if (this === document.body && child.id === 'paqvilo-panel' && !held) {
          held = child;
          globalThis.__heldClassicPanel = true;
          return child;
        }
        return appendChild.call(this, child);
      };
      globalThis.__releaseClassicPanel = () => {
        Document.prototype.getElementById = getById;
        Node.prototype.appendChild = appendChild;
        appendChild.call(document.body, held);
      };
    },
    { origin: classicApp.url },
  );
  runtime = await startDevSessions(context, selection, { log: () => {}, debugPort: null });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const panel = (selector) => page.locator(`#paqvilo-panel ${selector}`);
  const label = () => page.locator('#paqvilo-panel').getAttribute('data-label');
  const openTab = async (tab) => {
    // Wait for a drawn state (collapsed pill or open panel) before deciding whether to expand;
    // an attached pill can still be mid-draw and invisible.
    await panel('.pill:visible, .wrap.open').first().waitFor();
    if (await panel('.pill').isVisible()) await panel('.pill').click();
    await panel(`.tabs [data-act="tab"][data-v="${tab}"]`).click();
  };
  const choose = async (index, origin, onOrigin) => {
    await openTab('overrides');
    await Promise.all([
      page.waitForURL((url) => url.origin === origin),
      page
        .getByLabel('Portal / environment', { exact: true })
        .selectOption(String(index))
        .then(() => page.locator('[data-target-go]').click()),
    ]);
    onOrigin?.();
    const expected = ['classic Mirage @ local', 'enhanced Mirage @ local', 'classic @ dev'][index];
    await page.waitForFunction((label) => {
      const host = document.getElementById('paqvilo-panel');
      return host?.isConnected && host.dataset.label === label;
    }, expected);
  };
  const signedIn = async (app) => (await (await context.request.get(`${app.url}/_sim/api/session`)).json()).signedIn;

  // The first local portal opens in Mirage mode; the selector lists both runtimes and the live target.
  await page.goto(`${classicApp.url}/`);
  await page.waitForFunction(
    () => document.getElementById('paqvilo-panel')?.dataset.label === 'classic Mirage @ local',
  );
  return { context, page, panel, label, openTab, choose, signedIn, errors, live, classicApp, enhancedApp };
}

// Switches to the enhanced Mirage and signs in as Alex there; the classic Mirage stays anonymous.
async function signInOnEnhanced(env) {
  const { page, panel, openTab, choose, signedIn, classicApp, enhancedApp } = env;
  await choose(1, enhancedApp.url);
  await page.waitForFunction(
    () => document.getElementById('paqvilo-panel')?.dataset.label === 'enhanced Mirage @ local',
  );
  await openTab('runtime');
  await panel('[data-group="runtime-chain"] .row').filter({ hasText: 'Partial' }).first().waitFor();
  await openTab('tweaks');
  await panel('[data-act="choosepersona"][data-contact="alex"]').first().click();
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), panel('[data-act="signin"]').click()]);
  await page.locator('#who').getByText('Alex Local', { exact: true }).waitFor();
  assert.deepEqual(
    [await signedIn(enhancedApp), await signedIn(classicApp)],
    [true, false],
    'signing in on one local portal leaves the other anonymous',
  );
}

// Returns to the classic Mirage through the portal selector while its panel is held detached.
// The panel is released once the destination document is committed. `beforeRelease` is awaited
// while the panel is still held; `afterRelease` runs right after the release.
async function returnToClassic(env, { beforeRelease, afterRelease } = {}) {
  const { page, choose, classicApp } = env;
  await page.evaluate(() => {
    window.name = 'paqvilo-hold-classic-panel';
  });
  let settled = false;
  let reportOrigin;
  const originObserved = new Promise((resolve) => {
    reportOrigin = resolve;
  });
  const returned = choose(0, classicApp.url, reportOrigin).finally(() => {
    settled = true;
  });
  await page.waitForFunction(() => globalThis.__heldClassicPanel === true);
  await originObserved;
  assert.equal(new URL(page.url()).origin, classicApp.url);
  assert.equal(settled, false, 'target selection waits for the connected destination panel');
  await beforeRelease?.();
  await page.evaluate(() => globalThis.__releaseClassicPanel());
  afterRelease?.();
  await returned;
}

// Answers the first `count` status reads after `gate.armed` is set by destroying their sockets, the way a
// keep-alive connection closed by the server looks to the client. Later reads are served normally.
// `gate.dropped` resolves when the last of those sockets is destroyed; `gate.statusServed` resolves when the
// first status read made while `gate.recording` is set has been answered.
function dropFirstStatusRead(server, gate, count = 1) {
  const listeners = server.listeners('request');
  server.removeAllListeners('request');
  let markDropped;
  let markServed;
  gate.dropped = new Promise((resolve) => {
    markDropped = resolve;
  });
  gate.statusServed = new Promise((resolve) => {
    markServed = resolve;
  });
  server.on('request', (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const statusRead = /^\/_{1,2}sim\/api\/status$/.test(pathname);
    if (gate.recording) gate.paths.push(pathname);
    if (gate.armed && gate.destroyed < count && statusRead) {
      gate.destroyed += 1;
      gate.droppedAt = gate.paths.length;
      request.socket.destroy();
      if (gate.destroyed === count) markDropped();
      return;
    }
    if (gate.destroyed > 0 && statusRead) {
      response.on('finish', () => {
        if (response.statusCode === 200) gate.served += 1;
      });
    }
    if (gate.recording && statusRead) {
      response.on('finish', () => {
        if (response.statusCode === 200) markServed();
      });
    }
    for (const listener of listeners) listener.call(server, request, response);
  });
}

// Waits for the Tweaks tab to show the anonymous browser session; a miss records the tab text as a diagnostic.
async function expectAnonymousTweaks(t, page, panel) {
  try {
    await panel('.card').filter({ hasText: 'Browser session' }).getByText('Anonymous', { exact: true }).waitFor();
  } catch (error) {
    const tab = await page
      .locator('#paqvilo-panel')
      .evaluate((host) => host.shadowRoot?.querySelector('#paqvilo-tab-content')?.textContent ?? '');
    t.diagnostic(JSON.stringify({ tab: tab.slice(0, 600), url: page.url() }));
    throw error;
  }
}

test('local Mirage portals and live targets share one browser: the selector switches between them, each keeping its own sign-in session', async (t) => {
  const env = await startPortals(t);
  const { context, page, panel, label, openTab, choose, signedIn, errors, live, classicApp, enhancedApp } = env;
  await openTab('runtime');
  await panel('.card').filter({ hasText: 'Current persona' }).getByText('allowed', { exact: true }).waitFor();
  const options = await page.getByLabel('Portal / environment', { exact: true }).locator('option').allInnerTexts();
  assert.equal(options.length, 3);
  assert.ok(
    options[0].includes('classic Mirage @ local') &&
      options[1].includes('enhanced Mirage @ local') &&
      options[2].includes('classic @ dev'),
    options.join(' | '),
  );

  // Switch to the enhanced Mirage without restarting: its own Inspect report and sign-in.
  await signInOnEnhanced(env);

  // Back on the classic Mirage: sign in there too; both sessions now coexist (one cookie per port).
  await returnToClassic(env);
  await openTab('tweaks');
  await expectAnonymousTweaks(t, page, panel);
  await panel('[data-act="choosepersona"][data-contact="alex"]').first().click();
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), panel('[data-act="signin"]').click()]);
  assert.deepEqual([await signedIn(classicApp), await signedIn(enhancedApp)], [true, true]);
  const names = (await context.cookies())
    .map((cookie) => cookie.name)
    .filter((name) => name.startsWith('paqvilo-mirage-auth'))
    .sort();
  assert.deepEqual(
    names,
    [
      `paqvilo-mirage-auth-${new URL(classicApp.url).port}`,
      `paqvilo-mirage-auth-${new URL(enhancedApp.url).port}`,
    ].sort(),
  );
  await choose(1, enhancedApp.url);
  await page.locator('#who').getByText('Alex Local', { exact: true }).waitFor();

  // And out to the live target: Inspect keeps source navigation, while Mirage Tweaks stay local.
  await choose(2, live.origin);
  await page.locator('#live').waitFor();
  await page.waitForFunction(() => document.getElementById('paqvilo-panel')?.dataset.label === 'classic @ dev');
  await openTab('runtime');
  assert.equal(
    await panel('.tabs [data-act="tab"][data-v="runtime"]').count(),
    1,
    'live targets retain source inspection',
  );
  assert.equal(
    await panel('.tabs [data-act="tab"][data-v="tweaks"]').count(),
    0,
    'live targets cannot change Mirage personas or scenarios',
  );
  await panel('.card').getByText('Live portal · local source inspection', { exact: true }).waitFor();
  await panel('[data-group="runtime-page-sources"] .row')
    .filter({ hasText: 'Home.en-US.webpage.custom_css.css' })
    .waitFor();
  assert.equal(await panel('.card').getByText('Live access', { exact: true }).count(), 1);
  assert.equal(
    await panel('.card').getByText('allowed', { exact: true }).count(),
    0,
    'source inspection cannot infer effective live access',
  );
  assert.equal(
    live.requests.some((route) => /^\/(?:_sim|__sim)\//.test(route)),
    false,
    'live Inspect never probes Mirage administration on the portal',
  );
  await choose(0, classicApp.url);
  assert.equal(await label(), 'classic Mirage @ local');
  assert.deepEqual(errors, []);
});

test('the Tweaks card recovers when the first Mirage status read after returning to a portal is dropped', async (t) => {
  const env = await startPortals(t);
  const { page, panel, errors, classicApp } = env;
  const gate = { recording: false, armed: false, destroyed: 0, served: 0, paths: [] };
  dropFirstStatusRead(classicApp.server, gate);
  await signInOnEnhanced(env);
  gate.recording = true;
  // The re-inspection's status read is answered before the gate arms, so the drop lands on the Tweaks read.
  await returnToClassic(env, {
    beforeRelease: () => gate.statusServed,
    afterRelease: () => {
      gate.armed = true;
    },
  });
  await env.openTab('tweaks');
  await expectAnonymousTweaks(t, page, panel);
  assert.equal(gate.destroyed, 1, 'the first status read after the return was dropped');
  assert.ok(gate.served >= 1, 'a later status read reached the Mirage');
  assert.ok(
    gate.paths.some((pathname) => pathname.includes('/page-resources')),
    `the return re-inspected the page; classic requests: ${JSON.stringify(gate.paths)}`,
  );
  assert.deepEqual(errors, []);
});

// @test-kind contract: The return's re-inspection must retry a dropped status read, not store an inactive runtime.
test('the Tweaks card recovers when the runtime re-inspection after returning to a portal is dropped', async (t) => {
  const env = await startPortals(t);
  const { page, panel, errors, classicApp } = env;
  const gate = { recording: false, armed: false, destroyed: 0, served: 0, paths: [] };
  dropFirstStatusRead(classicApp.server, gate);
  await signInOnEnhanced(env);
  // Armed before the return: the first status read after it is the re-inspection's, and the panel stays
  // held until that read has been dropped, so the Tweaks read cannot start first.
  gate.recording = true;
  gate.armed = true;
  await returnToClassic(env, { beforeRelease: () => gate.dropped });
  await env.openTab('tweaks');
  await expectAnonymousTweaks(t, page, panel);
  assert.equal(gate.destroyed, 1, 'the re-inspection status read after the return was dropped');
  assert.ok(gate.served >= 1, 'a later status read reached the Mirage');
  assert.ok(
    gate.paths.slice(gate.droppedAt).some((pathname) => pathname.includes('/page-resources')),
    `the re-inspection read the page again after the drop; classic requests: ${JSON.stringify(gate.paths)}`,
  );
  assert.deepEqual(errors, []);
});

// @test-kind contract: a runtime read that fails every immediate attempt is shown with Read again, and Read again reads the runtime again
test('the Tweaks card shows a runtime read that keeps failing after returning to a portal, and Read again recovers it', async (t) => {
  const env = await startPortals(t);
  const { page, panel, errors, classicApp } = env;
  const gate = { recording: false, armed: false, destroyed: 0, served: 0, paths: [] };
  dropFirstStatusRead(classicApp.server, gate, 3);
  await signInOnEnhanced(env);
  // Armed before the return: the status reads after it are the re-inspection's immediate attempts, and the panel
  // stays held until the last of them has been dropped, so the Tweaks read cannot start first.
  gate.recording = true;
  gate.armed = true;
  await returnToClassic(env, { beforeRelease: () => gate.dropped });
  await env.openTab('tweaks');
  const readAgain = panel('[data-act="inspect-refresh"]').filter({ hasText: 'Read again' });
  // The attempts are used up: the failure is stored and drawn with its control.
  await readAgain.waitFor();
  assert.equal(await panel('.empty').filter({ hasText: 'Mirage is not active' }).count(), 1);
  assert.equal(gate.destroyed, 3, 'the immediate attempts after the return were all dropped');
  assert.equal(gate.served, 0, 'no status read followed the failed attempts without a request');
  const droppedPaths = gate.paths.length;
  await readAgain.click();
  await expectAnonymousTweaks(t, page, panel);
  assert.ok(gate.served >= 1, 'Read again reached the Mirage status');
  assert.ok(
    gate.paths.slice(droppedPaths).some((pathname) => pathname.includes('/page-resources')),
    `Read again inspected the page; classic requests: ${JSON.stringify(gate.paths)}`,
  );
  assert.deepEqual(errors, []);
});
