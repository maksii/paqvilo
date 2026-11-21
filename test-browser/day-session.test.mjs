// @test-kind contract: sustained saves in a Lense dev session keep forms, scoped reloads and Git drift consistent through the panel.
import { makeTemporaryDirectorySync, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

// Sustained saves and panel controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { listenLoopbackContext } from './helpers/owned-server.mjs';
import { startDevSessions } from '../lense/dev-sessions.mjs';
import { createFixture, SITE, HOME_ID } from '../test/fixture.mjs';
import { PROFILE_RELEASE_RETRIES } from './helpers/profile-cleanup.mjs';
import { workflowSteps } from '../test/helpers/workflow-step.mjs';
import { operationBudget } from '../test/helpers/operation-budget.mjs';

const CSS_SAVES = 20;
const DAY_OPERATIONS = CSS_SAVES + 8;
const OPERATION_GUARD_MS = 300_000;

// Each real operation retains the browser lane's guard; the finite sustained
// workflow is not timed as though its twenty saves were one operation.
test(
  'sustained saves preserve forms, scope reloads, show Git drift and repin HEAD through the panel',
  { timeout: operationBudget(DAY_OPERATIONS, OPERATION_GUARD_MS) },
  async (t) => {
    const fx = createFixture();
    const work = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'pp-day-browser-'));
    const css = 'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css';
    const aboutJs = 'web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js';
    const originalCss = fx.read(css);
    const originalAbout = 'window.aboutVersion = "baseline";';
    fx.write(aboutJs, originalAbout);
    fx.write('web-files/day.css', '#web-style { color: rgb(11, 22, 33); }');
    fx.write(
      'web-files/day.css.webfile.yml',
      `adx_name: day.css\nadx_partialurl: day.css\nadx_parentpageid: ${HOME_ID}\n`,
    );
    fx.commit();
    let runtime, origin, context, home, about, session, panel, pinned;
    const errors = [];
    const step = workflowSteps(t, {
      guardMs: OPERATION_GUARD_MS,
      operations: DAY_OPERATIONS,
      abort: async () => {
        if (!context) return false;
        await context.close();
        return true;
      },
    });
    let signedInComparisons = 0;
    const leakedRequests = [];
    const server = http.createServer((request, response) => {
      const pathname = new URL(request.url, origin).pathname;
      if (pathname.startsWith('/__paqvilo/')) {
        leakedRequests.push(pathname);
        return response.writeHead(500).end();
      }
      if (pathname === '/favicon.ico') return response.writeHead(204).end();
      if (pathname === '/day.css') {
        if (!request.headers.cookie?.includes('fixture-session=synthetic'))
          return response.writeHead(302, { location: '/signin' }).end();
        signedInComparisons++;
        return response.writeHead(200, { 'content-type': 'text/css' }).end('#web-style { color: rgb(11, 22, 33); }');
      }
      const about = pathname.startsWith('/about-us');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(`<!doctype html><html><head><title>All-day synthetic fixture</title>
      <link rel="stylesheet" href="/day.css">${about ? `<script>${originalAbout}</script>` : `<style>${originalCss}</style>`}</head>
      <body><h1>${about ? 'About' : 'Home'}</h1><input id="draft" placeholder="Unsaved form input"><p class="hero">Page CSS</p><p id="web-style">Web CSS</p></body></html>`);
    });
    server.on('connect', (_request, socket) => {
      socket.on('error', () => {});
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    ownedFixture(t).add(async () => {
      await runtime?.close();
    });
    ownedFixture(t).remove(async () => {
      fx.cleanup();
    });
    ownedFixture(t).remove(async () => {
      fs.rmSync(work, { recursive: true, force: true, ...PROFILE_RELEASE_RETRIES });
    });
    await step('start both intercepted pages and observe signed-in local application', async (signal) => {
      ({ origin, context } = await listenLoopbackContext(t, server));
      signal.throwIfAborted();
      await context.addCookies([{ name: 'fixture-session', value: 'synthetic', url: origin }]);
      // Attach both blank tabs before navigating so this sustained-save scenario
      // starts with each document intercepted, without an outstanding late repair.
      home = await context.newPage();
      about = await context.newPage();
      for (const page of [home, about]) page.on('pageerror', (error) => errors.push(error.message));
      const cfg = {
        sourceDir: fx.dir,
        origin,
        site: structuredClone(SITE),
        siteName: 'audit',
        envName: 'synthetic',
        stateDir: work,
        configDir: work,
        browser: {},
        panel: true,
        agent: { enabled: false },
        liveReload: true,
        sourceMaps: false,
        caution: true,
      };
      runtime = await startDevSessions(context, { mode: 'selected', initial: cfg, targets: [cfg] }, { log: () => {} });
      ({ session, panel } = runtime.active.get(origin));
      pinned = session.baseline.commit;
      // The first published comparison of the locally served web file is the result to check;
      // it is also observed local application before any draft is typed.
      const compared = (async () => {
        while (!session.onlineState.has('/day.css')) await once(session, 'online-state', { signal });
        return session.onlineState.get('/day.css');
      })();
      const [, , comparison] = await Promise.all([home.goto(origin), about.goto(origin + '/about-us/'), compared]);
      assert.equal(comparison, 'same', 'comparison must use browser sign-in');
      assert.ok(signedInComparisons > 0);
      await home.locator('#draft').fill('keep my draft');
      await about.locator('#draft').fill('another draft');
    });
    // Each real watcher event must finish before the next save; exercise repeated in-place swaps.
    for (let i = 1; i <= CSS_SAVES; i++) {
      await step(`CSS save ${i} preserves both drafts and refreshes only its page`, async (signal) => {
        const [, [event]] = await Promise.all([
          Promise.resolve().then(() => fx.write(css, originalCss.replace('color: red', `color: rgb(${i}, 2, 3)`))),
          once(session, 'refreshed', { signal }),
        ]);
        assert.equal(event.how, 'css');
        assert.equal(event.pageResults.get(about).how, 'skipped');
        assert.equal(await home.locator('#draft').inputValue(), 'keep my draft');
        assert.equal(await about.locator('#draft').inputValue(), 'another draft');
        assert.equal(
          await home.locator('.hero').evaluate((element) => getComputedStyle(element).color),
          `rgb(${i}, 2, 3)`,
        );
      });
    }
    const evidence = async (name) => {
      if (!process.env.PAQVILO_EVIDENCE_DIR) return;
      fs.mkdirSync(process.env.PAQVILO_EVIDENCE_DIR, { recursive: true });
      await home.screenshot({ path: path.join(process.env.PAQVILO_EVIDENCE_DIR, name), fullPage: true });
    };
    // A page script refreshes its page alone, then committing keeps the startup baseline intact.
    await step('a page script reloads only its page and keeps the other draft', async (signal) => {
      const [, saved] = await Promise.all([
        Promise.resolve().then(() => fx.write(aboutJs, 'window.aboutVersion = "edited";')),
        once(session, 'refreshed', { signal }),
      ]);
      assert.equal(saved[0].how, 'reload');
      await about.waitForFunction(() => window.aboutVersion === 'edited');
      assert.equal(await home.locator('#draft').inputValue(), 'keep my draft');
    });
    await step('a commit exposes Git drift without moving the pinned baseline', async (signal) => {
      await Promise.all([Promise.resolve().then(() => fx.commit()), once(session, 'head', { signal })]);
      assert.equal(session.baseline.commit, pinned);
      assert.equal(panel.stateFor(home).git.headMoved, true);
    });
    await step('the desktop panel offers the new baseline', async () => {
      await panel.draw(home);
      await home.locator('#paqvilo-panel .pill').click();
      await home.locator('#paqvilo-panel [data-act="rebaseline"]').waitFor();
      await evidence('git-drift-panel.png');
    });
    await step('the narrow panel retains the caution and Git identity', async () => {
      await home.setViewportSize({ width: 430, height: 780 });
      await panel.draw(home);
      assert.equal(
        await home.locator('#paqvilo-panel .head .real').isVisible(),
        true,
        'REAL DATA stays visible on narrow screens',
      );
      assert.equal(await home.locator('#paqvilo-panel .gitline').isVisible(), true, 'branch and baseline stay visible');
      await evidence('git-drift-mobile.png');
    });
    await step('panel repinning updates the baseline and retains the other page pending state', async () => {
      await Promise.all([home.waitForNavigation(), home.locator('#paqvilo-panel [data-act="rebaseline"]').click()]);
      assert.equal(session.baseline.commit, session.head.commit);
      assert.equal(session.changedFiles.size, 0);
      assert.equal(panel.stateFor(about).pendingBaseline, true);
    });
    await step('activating the other page applies its pending baseline', async () => {
      await about.goto(origin + '/about-us/');
      assert.equal(panel.stateFor(about).pendingBaseline, false);
    });
    await step('runtime cleanup removes listeners and preserves both user-owned tabs', async () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(leakedRequests, []);
      const observed = session.listenerCount('refreshed');
      assert.ok(observed > 0);
      await runtime.close();
      assert.equal(session.eventNames().length, 0);
      assert.equal(
        context.pages().filter((page) => !page.isClosed()).length,
        2,
        'runtime cleanup does not close user-owned tabs',
      );
    });
  },
);
