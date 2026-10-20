import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { startupProgress, waitForStartupPage } from '../lense/startup-progress.mjs';

test('startup separates delayed navigation, delayed usable application, failures and sign-in redirects', async t => {
  let browser;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/signin' }).end(); return; }
    if (req.url === '/hang') return;
    if (req.url === '/app-data') { setTimeout(() => res.end('Invented data'), 150); return; }
    const delay = req.url === '/slow-origin' ? 100 : 0;
    setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><p id="notice">${req.url === '/main.aspx?error' ? 'Invented catalogue failure' : ''}</p>${req.url.startsWith('/main.aspx') ? `<script>setTimeout(() => document.documentElement.dataset.mirageAppState = '${req.url.includes('error') ? 'error' : 'ready'}', 150)</script>` : req.url === '/slow-app' ? '<script>fetch("/app-data")</script>' : ''}`), delay);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  const page = await browser.newPage();
  const run = async (pathname, settings) => {
    const events = [], progress = startupProgress({ structured: true, intervalMs: 20, write: line => events.push(JSON.parse(line)) });
    try { const loaded = await waitForStartupPage(page, origin + pathname, { progress, ...settings }); return { events, loaded }; }
    finally { progress.close(); }
  };
  const slow = await run('/slow-origin');
  assert.ok(slow.events.some(event => event.phase === 'document navigation' && event.status === 'waiting'));
  assert.match(slow.events.at(-1).detail, /application readiness remain unverified/);
  const data = await run('/slow-app');
  assert.ok(data.events.some(event => event.phase === 'page resources' && event.status === 'waiting'));
  const app = await run('/main.aspx', { modelDriven: true });
  assert.ok(app.events.some(event => event.phase === 'application data' && event.status === 'waiting'));
  assert.equal(app.events.at(-1).detail, 'application and initial view usable');
  assert.ok(app.events.every((event, index) => index === 0 || event.totalElapsedMs >= app.events[index - 1].totalElapsedMs));
  await assert.rejects(run('/main.aspx?error', { modelDriven: true }), /Invented catalogue failure/);
  const redirect = await run('/redirect', { modelDriven: true });
  assert.equal(new URL(page.url()).pathname, '/signin');
  assert.doesNotMatch(redirect.events.at(-1).detail, /usable/);
  await assert.rejects(run('/hang', { timeout: 100 }), /Timeout/);
  await page.goto(origin);
  const cancelled = await run('/hang', { stopped: new Promise(resolve => setTimeout(resolve, 30)), timeout: 1000 });
  assert.equal(cancelled.loaded, false);
  const closingPage = await browser.newPage();
  await closingPage.route('**/main.aspx', route => route.fulfill({ contentType: 'text/html', body: '<p>Still loading application</p>' }));
  const progress = startupProgress({ write() {} });
  const closing = waitForStartupPage(closingPage, origin + '/main.aspx', { progress, modelDriven: true, timeout: 1000 });
  await closingPage.locator('p').waitFor();
  await closingPage.close();
  assert.equal(await closing, false, 'closing during a readiness wait is normal dev shutdown');
  progress.close();
});
