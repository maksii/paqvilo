// Sustained saves and panel controls against a disposable loopback portal only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { startDevSessions } from '../lense/dev-sessions.mjs';
import { createFixture, SITE, HOME_ID } from '../test/fixture.mjs';

async function until(check, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

test('sustained saves preserve forms, scope reloads, show Git drift and repin HEAD through the panel', { timeout: 120_000 }, async (t) => {
  const fx = createFixture();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-day-browser-'));
  const css = 'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css';
  const aboutJs = 'web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js';
  const originalCss = fx.read(css);
  const originalAbout = 'window.aboutVersion = "baseline";';
  fx.write(aboutJs, originalAbout);
  fx.write('web-files/day.css', '#web-style { color: rgb(11, 22, 33); }');
  fx.write('web-files/day.css.webfile.yml', `adx_name: day.css\nadx_partialurl: day.css\nadx_parentpageid: ${HOME_ID}\n`);
  fx.commit();
  let browser;
  let runtime;
  let origin;
  let signedInComparisons = 0;
  const leakedRequests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, origin).pathname;
    if (pathname.startsWith('/__paqvilo/')) { leakedRequests.push(pathname); return response.writeHead(500).end(); }
    if (pathname === '/favicon.ico') return response.writeHead(204).end();
    if (pathname === '/day.css') {
      if (!request.headers.cookie?.includes('fixture-session=synthetic')) return response.writeHead(302, { location: '/signin' }).end();
      signedInComparisons++;
      return response.writeHead(200, { 'content-type': 'text/css' }).end('#web-style { color: rgb(11, 22, 33); }');
    }
    const about = pathname.startsWith('/about-us');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><title>All-day synthetic fixture</title>
      <link rel="stylesheet" href="/day.css">${about ? `<script>${originalAbout}</script>` : `<style>${originalCss}</style>`}</head>
      <body><h1>${about ? 'About' : 'Home'}</h1><input id="draft" placeholder="Unsaved form input"><p class="hero">Page CSS</p><p id="web-style">Web CSS</p></body></html>`);
  });
  server.on('connect', (_request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  t.after(async () => {
    await runtime?.close();
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fx.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true,
    proxy: { server: origin, bypass: '127.0.0.1,localhost' },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addCookies([{ name: 'fixture-session', value: 'synthetic', url: origin }]);
  const cfg = { sourceDir: fx.dir, origin, site: structuredClone(SITE), siteName: 'audit', envName: 'synthetic',
    stateDir: work, configDir: work, browser: {}, panel: true, agent: { enabled: false }, liveReload: true, sourceMaps: false, caution: true };
  runtime = await startDevSessions(context, { mode: 'selected', initial: cfg, targets: [cfg] }, { log: () => {} });
  const { session, panel } = runtime.active.get(origin);
  const pinned = session.baseline.commit;
  const home = await context.newPage();
  const about = await context.newPage();
  const errors = [];
  for (const page of [home, about]) page.on('pageerror', (error) => errors.push(error.message));
  await Promise.all([home.goto(origin), about.goto(origin + '/about-us/')]);
  await home.locator('#draft').fill('keep my draft');
  await about.locator('#draft').fill('another draft');
  await until(() => session.onlineState.get('/day.css') === 'same', 'comparison must use browser sign-in');
  assert.ok(signedInComparisons > 0);
  // Each real watcher event must finish before the next save; exercise repeated in-place swaps.
  for (let i = 1; i <= 20; i++) {
    const refreshed = once(session, 'refreshed', { signal: AbortSignal.timeout(15_000) });
    fx.write(css, originalCss.replace('color: red', `color: rgb(${i}, 2, 3)`));
    const [event] = await refreshed;
    assert.equal(event.how, 'css');
    assert.equal(event.pageResults.get(about).how, 'skipped');
    assert.equal(await home.locator('#draft').inputValue(), 'keep my draft');
    assert.equal(await about.locator('#draft').inputValue(), 'another draft');
    assert.equal(await home.locator('.hero').evaluate((element) => getComputedStyle(element).color), `rgb(${i}, 2, 3)`);
  }
  // A page script refreshes its page alone, then committing keeps the startup baseline intact.
  const saved = once(session, 'refreshed', { signal: AbortSignal.timeout(15_000) });
  fx.write(aboutJs, 'window.aboutVersion = "edited";');
  assert.equal((await saved)[0].how, 'reload');
  await about.waitForFunction(() => window.aboutVersion === 'edited');
  assert.equal(await home.locator('#draft').inputValue(), 'keep my draft');
  const moved = once(session, 'head', { signal: AbortSignal.timeout(15_000) });
  fx.commit();
  await moved;
  assert.equal(session.baseline.commit, pinned);
  assert.equal(panel.stateFor(home).git.headMoved, true);
  await panel.draw(home);
  await home.locator('#paqvilo-panel .pill').click();
  await home.locator('#paqvilo-panel [data-act="rebaseline"]').waitFor();
  const evidence = path.resolve('.paqvilo/evidence/day-session');
  fs.mkdirSync(evidence, { recursive: true });
  await home.screenshot({ path: path.join(evidence, 'git-drift-panel.png'), fullPage: true });
  await home.setViewportSize({ width: 430, height: 780 });
  await panel.draw(home);
  assert.equal(await home.locator('#paqvilo-panel .head .real').isVisible(), true, 'REAL DATA stays visible on narrow screens');
  assert.equal(await home.locator('#paqvilo-panel .gitline').isVisible(), true, 'branch and baseline stay visible');
  await home.screenshot({ path: path.join(evidence, 'git-drift-mobile.png'), fullPage: true });
  await Promise.all([home.waitForNavigation(), home.locator('#paqvilo-panel [data-act="rebaseline"]').click()]);
  assert.equal(session.baseline.commit, session.head.commit);
  assert.equal(session.changedFiles.size, 0);
  assert.equal(panel.stateFor(about).pendingBaseline, true);
  await about.goto(origin + '/about-us/');
  assert.equal(panel.stateFor(about).pendingBaseline, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(leakedRequests, []);
  const observed = session.listenerCount('refreshed');
  assert.ok(observed > 0);
  await runtime.close();
  assert.equal(session.eventNames().length, 0);
  assert.equal(context.pages().filter((page) => !page.isClosed()).length, 2, 'runtime cleanup does not close user-owned tabs');
});
