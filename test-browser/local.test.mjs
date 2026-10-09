// Explicit acceptance suite: only temporary extracts, local Git, and loopback HTTP fixtures.
// Run with npm run test:browser; it never reads the repository's site/environment catalogue.
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
import { panelUi } from '../lense/panel-ui.mjs';
import { watchSources } from '../lense/commands/dev.mjs';
import { createFixture, HOME_ID, SITE } from '../test/fixture.mjs';

const PAGE_JS = 'web-pages/home/content-pages/Home.en-US.webpage.custom_javascript.js';
const PAGE_CSS = 'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css';
const HEADER = 'web-templates/header/Header.webtemplate.source.html';
const APP = 'web-files/app.js';
const CSS = 'web-files/theme.css';

async function serve(handler) {
  const server = http.createServer(handler);
  // The fixture doubles as a deny proxy for any unexpected browser background traffic.
  server.on('connect', (_request, socket) => {
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('real browser: local overrides, watcher, panel, form submission, origin isolation, and detach', { timeout: 120_000 }, async (t) => {
  const fx = createFixture();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-browser-'));
  let context;
  let detach;
  let panel;
  let watcher;
  const servers = [];
  t.after(async () => {
    await watcher?.close();
    panel?.dispose();
    await detach?.();
    await context?.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fx.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  fx.write(PAGE_JS, 'window.inlineValue = "baseline";\n');
  fx.write(PAGE_CSS, '.hero { color: rgb(100, 0, 0); }\n');
  fx.write(HEADER, '<h1 id="title">Baseline title</h1>\n');
  fx.write(APP, 'window.webFile = "baseline";\n');
  fx.write(CSS, '#theme { color: rgb(100, 0, 0); }\n');
  fx.write(`${CSS}.webfile.yml`, `adx_name: theme.css\nadx_partialurl: theme.css\nadx_parentpageid: ${HOME_ID}\nfilename: theme.css\n`);
  fx.commit();
  const html = `<!doctype html><html><head><title>Loopback acceptance</title>
<link rel="stylesheet" href="/theme.css"><style>${fx.read(PAGE_CSS)}</style>
<script>${fx.read(PAGE_JS)}</script><script src="/scripts/app.js"></script>
</head><body>${fx.read(HEADER)}<p class="hero">Inline style</p><p id="theme">Web style</p>
<form method="post" action="/save#result"><textarea name="payload"></textarea><button id="save">Save</button></form>
</body></html>`;
  const requests = [];
  const posts = [];
  const local = await serve(async (request, response) => {
    if (!request.url.startsWith('/')) { response.writeHead(403).end(); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, method: request.method });
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      posts.push(Buffer.concat(chunks).toString());
    }
    if (url.pathname === '/scripts/app.js') response.writeHead(200, { 'content-type': 'application/javascript' }).end('window.webFile = "baseline";');
    else if (url.pathname === '/theme.css') response.writeHead(200, { 'content-type': 'text/css' }).end('#theme { color: rgb(100, 0, 0); }');
    else if (url.pathname === '/' || url.pathname === '/save') response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    else response.writeHead(404).end('loopback fixture: missing');
  });
  servers.push(local.server);
  const foreign = await serve((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><h1>Different origin</h1><script>window.webFile = "foreign";</script></body></html>'));
  servers.push(foreign.server);

  fx.write(PAGE_JS, 'window.inlineValue = "local-inline";\n');
  fx.write(PAGE_CSS, '.hero { color: rgb(0, 100, 0); }\n');
  fx.write(HEADER, '<h1 id="title">Local title</h1>\n');
  fx.write(APP, 'window.webFile = "local-v1";\n');
  fx.write(CSS, '#theme { color: rgb(10, 20, 30); }\n');
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    serviceWorkers: 'block',
    proxy: { server: local.origin, bypass: '127.0.0.1,localhost' },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-domain-reliability', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  context.setDefaultTimeout(15_000);
  const session = new OverlaySession({
    sourceDir: fx.dir, origin: local.origin, site: structuredClone(SITE), sourceMaps: true,
    siteName: 'loopback-test', envName: 'isolated', stateDir: path.join(work, 'state'), browser: { bypassCSP: false },
  });
  const faults = [];
  session.on('fault', (error) => faults.push(error.message));
  detach = await attachSession(context, session);
  panel = enablePanel(context, session, { open: async () => { throw new Error('Acceptance test must never launch an editor'); } });
  const page = context.pages()[0];
  const scriptResponses = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/__paqvilo/inline/')) scriptResponses.push(response);
  });
  await page.goto(local.origin, { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.webFile), 'local-v1');
  assert.equal(await page.evaluate(() => window.inlineValue), 'local-inline');
  assert.equal(await page.locator('#title').textContent(), 'Local title');
  assert.equal(await page.locator('.hero').evaluate((node) => getComputedStyle(node).color), 'rgb(0, 100, 0)');
  assert.equal(await page.locator('#theme').evaluate((node) => getComputedStyle(node).color), 'rgb(10, 20, 30)');
  assert.equal(scriptResponses.length, 1);
  assert.match(await scriptResponses[0].text(), /sourceMappingURL=data:application\/json/);
  assert.ok(!requests.some((request) => ['/scripts/app.js', '/theme.css'].includes(request.path)), 'local web files never reached even the fixture server');
  await page.locator('#paqvilo-panel').waitFor();
  await panel.draw(page);
  assert.ok(panel.stateFor(page).items.some((item) => item.rel === APP));
  assert.ok(panel.stateFor(page).items.some((item) => item.rel === PAGE_JS));

  watcher = watchSources(session, context, { log: () => {} });
  await once(watcher, 'ready');
  let navigationCount = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigationCount++; });
  const cssRefresh = once(session, 'refreshed');
  fx.write(CSS, '#theme { color: rgb(40, 50, 60); }\n');
  assert.equal((await cssRefresh)[0].how, 'css');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('theme')).color === 'rgb(40, 50, 60)');
  assert.equal(navigationCount, 0, 'a web stylesheet save hot-swaps without navigation');
  const jsRefresh = once(session, 'refreshed');
  fx.write(APP, 'window.webFile = "local-v2";\n');
  assert.equal((await jsRefresh)[0].how, 'reload');
  await page.waitForFunction(() => window.webFile === 'local-v2');
  assert.ok(navigationCount >= 1, 'a JavaScript save reloads the page');
  await watcher.close();
  watcher = null;

  const token = panel.stateFor(page).token;
  const callPanel = (name, body, authenticate = true) => page.evaluate(async ({ name, body, token }) => {
    const response = await fetch(`/__paqvilo/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-paqvilo-token': token } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { name, body, token: authenticate ? token : null });
  assert.equal((await callPanel('mode', { online: true }, false)).status, 403);
  assert.equal(session.bypass, false);
  assert.equal((await callPanel('toggle', { rel: APP, off: true })).body.ok, true);
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.webFile), 'baseline');
  assert.equal((await callPanel('toggle', { rel: APP, off: false })).body.ok, true);
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.webFile), 'local-v2');
  assert.ok(!requests.some((request) => request.path.startsWith('/__paqvilo/')), 'panel and inline routes remain local');

  const other = await context.newPage();
  await other.goto(foreign.origin, { waitUntil: 'load' });
  await panel.draw(other);
  assert.equal(await other.evaluate(() => window.webFile), 'foreign');
  assert.equal(await other.locator('#paqvilo-panel').count(), 0);
  await other.close();

  const payload = 'hello+world&value='.repeat(10_000);
  await page.locator('textarea[name=payload]').fill(payload);
  await Promise.all([page.waitForURL(`${local.origin}/save#result`, { waitUntil: 'load' }), page.locator('#save').click()]);
  assert.equal(posts.length, 1, 'a form submission reaches the loopback server exactly once');
  assert.equal(new URLSearchParams(posts[0]).get('payload'), payload, 'large POST bodies arrive intact');
  assert.equal(await page.locator('#title').textContent(), 'Local title');
  assert.deepEqual(faults, []);

  watcher = watchSources(session, context, { log: () => {} });
  await watcher.ready;
  const postSave = once(session, 'refreshed');
  fx.write(APP, 'window.webFile = "local-after-post";\n');
  await postSave;
  await page.waitForFunction(() => window.webFile === 'local-after-post');
  assert.equal(posts.length, 1, 'a source save after form submission loads GET and never repeats POST');
  assert.ok(requests.some((request) => request.path === '/save' && request.method === 'GET'));
  assert.equal(new URL(page.url()).hash, '#result');
  assert.ok(new URL(page.url()).searchParams.has('paqvilo'), 'fragment refresh performs a real GET');
  await watcher.close(); watcher = null;

  const retiredState = panel.stateFor(page);
  await panel.dispose();
  assert.equal(await page.locator('#paqvilo-panel').count(), 0, 'detaching removes the panel without requiring a portal navigation');
  await page.evaluate(panelUi, retiredState);
  assert.equal(await page.locator('#paqvilo-panel').count(), 0, 'late evaluation cannot recreate a retired panel');
  panel = null;
  await detach();
  detach = null;
  await page.goto(local.origin, { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => window.webFile), 'baseline');
  assert.equal(await page.evaluate(() => window.inlineValue), 'baseline');
  assert.equal(await page.locator('#title').textContent(), 'Baseline title');
  assert.equal(await page.locator('#paqvilo-panel').count(), 0);
});
