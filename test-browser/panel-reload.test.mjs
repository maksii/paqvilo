// Panel refresh controls must never repeat a form POST, including URLs with fragments.
// All submissions below go to a disposable loopback fixture, never a portal environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { createFixture, SITE } from '../test/fixture.mjs';

test('panel reload, mode, scope and override toggles refresh through GET after a POST', { timeout: 90_000 }, async (t) => {
  const fx = createFixture();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-panel-reload-'));
  let browser;
  let panel;
  let detach;
  let origin;
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (!request.url.startsWith('/')) return response.writeHead(403).end();
    const url = new URL(request.url, origin);
    for await (const _chunk of request) { /* consume synthetic form payload */ }
    requests.push({ method: request.method, pathname: url.pathname, search: url.search });
    if (url.pathname === '/scripts/app.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end('window.fromFixture = true;');
    if (url.pathname === '/favicon.ico') return response.writeHead(204).end();
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>Panel refresh fixture</title></head><body>
      <form method="post" action="/submitted?view=one&amp;view=two&amp;literal=a%2Bb#result"><input name="fixture" value="synthetic"><button id="submit">Submit fixture</button></form>
      <h1 id="result">Synthetic form result</h1><script src="/scripts/app.js"></script></body></html>`);
  });
  server.on('connect', (_request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  t.after(async () => {
    await panel?.dispose();
    await detach?.();
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
  browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel, headless: true,
    proxy: { server: origin, bypass: '127.0.0.1,localhost' },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  context.setDefaultTimeout(10_000);
  await context.route('**/*', async (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const session = new OverlaySession({ sourceDir: fx.dir, origin, site: structuredClone(SITE), sourceMaps: false, siteName: 'fixture', envName: 'loopback', stateDir: work, browser: {} });
  detach = await attachSession(context, session);
  panel = enablePanel(context, session);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'load' });
  const controls = [
    ['reload', '[data-act="reload"]', ''],
    ['reload with fragment', '[data-act="reload"]', '#result'],
    ['reload with empty fragment', '[data-act="reload"]', '#'],
    ['pause source', '[data-act="toggle"]', '#result'],
    ['resume source', '[data-act="toggle"]', '#result'],
    ['scope', '[data-act="scope"][data-v="changed"]', '#result'],
    ['online mode', '[data-act="mode"][data-v="online"]', '#result'],
    ['local mode', '[data-act="mode"][data-v="local"]', '#result'],
  ];
  for (const [name, selector, fragment] of controls) {
    t.diagnostic(`Checking ${name}`);
    await page.locator('form').evaluate((form, fragment) => { form.action = form.action.split('#')[0] + fragment; }, fragment);
    const postsBefore = requests.filter((request) => request.method === 'POST').length;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load' }),
      page.locator('#submit').click(),
    ]);
    assert.equal(requests.filter((request) => request.method === 'POST').length, postsBefore + 1, `${name}: exactly one deliberate fixture submission`);
    await page.locator('#paqvilo-panel').waitFor();
    await panel.draw(page);
    if (await page.locator('#paqvilo-panel .pill').isVisible()) await page.locator('#paqvilo-panel .pill').click();
    if (selector === '[data-act="toggle"]') await page.locator('#paqvilo-panel .row[data-rel="web-files/app.js"]').hover();
    const getsBefore = requests.filter((request) => request.method === 'GET' && request.pathname === '/submitted').length;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load' }),
      page.locator(`#paqvilo-panel ${selector}`).first().click(),
    ]).catch((error) => { const state = panel.stateFor(page); t.diagnostic(JSON.stringify({ control: name, url: page.url(), requests, errors, items: state.items, paused: state.paused, ui: state.ui })); throw error; });
    await page.waitForLoadState('load');
    assert.equal(requests.filter((request) => request.method === 'POST').length, postsBefore + 1, `${name}: panel must not replay the POST`);
    assert.equal(requests.filter((request) => request.method === 'GET' && request.pathname === '/submitted').length, getsBefore + 1, `${name}: one fresh document GET`);
    const url = new URL(page.url());
    assert.deepEqual(url.searchParams.getAll('view'), ['one', 'two'], `${name}: duplicate query parameters preserved`);
    assert.equal(url.searchParams.get('literal'), 'a+b', `${name}: encoded query value preserved`);
    assert.equal(url.href.slice(url.href.indexOf('#') < 0 ? url.href.length : url.href.indexOf('#')), fragment, `${name}: fragment preserved, including a bare #`);
    assert.equal(url.searchParams.has('paqvilo'), Boolean(fragment), `${name}: cache buster needed only for fragment navigation`);
  }
  assert.deepEqual(errors, []);
  assert.ok(!requests.some((request) => request.pathname.startsWith('/__paqvilo/')), 'panel actions stayed inside the local overlay');
});
