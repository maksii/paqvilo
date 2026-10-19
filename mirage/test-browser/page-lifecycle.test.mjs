import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions, observePageLifecycle, observeContextLifecycle } from '../acceptance-api.mjs';

async function fixture(t) {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url.startsWith('/pending') || req.url === '/__sim/events') return;
    if (req.url === '/reset') return req.socket.destroy();
    if (req.url === '/stream-error') { res.writeHead(500, { 'content-type': 'text/plain' }); res.write('invented failure'); return; }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/child') return res.end(`<script>fetch('/pending-child').catch(()=>{})</script>`);
    res.end('<p>invented lifecycle fixture</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  return { origin, context, page };
}

test('a detached iframe read needs lifecycle evidence at failure time', { timeout: 30000 }, async t => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin }); t.after(() => observer.dispose());
  await page.goto(origin);
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/child'; document.body.append(frame); });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.readyState === 'complete');
  await page.waitForTimeout(100);
  await page.evaluate(() => document.querySelector('iframe').remove());
  const result = await observer.settle();
  assert.equal(result.settled, true, JSON.stringify(result));
  assert.equal(result.failures.length + result.supersededReads.length, 1);
  // Chromium versions may deliver the failure before the detach notification.
  // That ordering provides no proof at failure time and must fail closed.
  for (const row of result.failures) { assert.equal(row.error, 'net::ERR_ABORTED'); assert.equal(row.lifecycle, undefined); }
  for (const row of result.supersededReads) assert.equal(row.lifecycle.reason, 'frame-detached');
});

test('a replaced postback document separates still-pending reads without claiming completion', { timeout: 30000 }, async t => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin }); t.after(() => observer.dispose());
  await page.goto(origin);
  await page.evaluate(() => { fetch('/pending-read').catch(() => {}); });
  await page.waitForTimeout(50);
  await page.evaluate(() => { const form = document.createElement('form'); form.method = 'POST'; form.action = '/done'; document.body.append(form); form.submit(); });
  await page.waitForURL(origin + '/done');
  const result = await observer.settle();
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.ok(result.supersededReads.some(row => row.lifecycle.reason === 'document-replaced'));
  assert.ok(result.supersededReads.every(row => row.browserCompletionObserved === false));
});

test('same-document history and fragments leave pending reads visible and bounded', { timeout: 30000 }, async t => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin }); t.after(() => observer.dispose());
  await page.goto(origin);
  await page.evaluate(() => { fetch('/pending?token=secret').catch(() => {}); location.hash = 'fragment'; history.pushState({}, '', '/history'); });
  const result = await observer.settle({ timeout: 250 });
  assert.equal(result.settled, false); assert.equal(result.pendingRequests.length, 1);
  assert.deepEqual(result.supersededReads, []); assert.ok(result.waitedMs < 1000);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('failed live reads and authored aborts stay failed after unrelated navigation', { timeout: 30000 }, async t => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin }); t.after(() => observer.dispose());
  await page.goto(origin);
  await page.evaluate(async () => {
    await fetch('/reset').catch(() => {});
    const controller = new AbortController(); const pending = fetch('/pending-abort', { signal: controller.signal }).catch(() => {});
    setTimeout(() => controller.abort(), 30); await pending;
  });
  await page.waitForTimeout(50); await page.goto(origin + '/other');
  const result = await observer.settle();
  assert.equal(result.settled, true); assert.equal(result.passed, false);
  assert.equal(result.failures.length, 2); assert.deepEqual(result.supersededReads, []);
  assert.ok(result.failures.every(row => row.outcome === 'network-failure'));
});

test('cancelled and failed writes remain failures, including owned-background lookalikes', { timeout: 30000 }, async t => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin }); t.after(() => observer.dispose());
  await page.goto(origin);
  await page.evaluate(async () => { await fetch('/reset', { method: 'POST' }).catch(() => {}); fetch('/pending-write', { method: 'PATCH' }).catch(() => {}); fetch('/__sim/events', { method: 'POST' }).catch(() => {}); });
  await page.waitForTimeout(50); await page.goto(origin + '/other');
  const result = await observer.settle();
  assert.equal(result.passed, false); assert.equal(result.failures.length, 3, JSON.stringify(result));
  assert.ok(result.failures.every(row => !row.ownedBackground)); assert.deepEqual(result.supersededReads, []);
});

test('context observer attaches new pages, excludes only owned reads and disposes without closing pages', { timeout: 30000 }, async t => {
  const { origin, context, page } = await fixture(t);
  const observer = await observeContextLifecycle(context, { origin }); t.after(() => observer.dispose());
  const second = await context.newPage(); await observer.ready();
  await Promise.all([page.goto(origin), second.goto(origin)]);
  await second.evaluate(() => { fetch('/__sim/events').catch(() => {}); });
  const result = await observer.settle({ timeout: 1000 });
  assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.pages.length, 2);
  assert.ok(result.pages.some(row => row.requests.some(request => request.ownedBackground)));
  await observer.dispose(); assert.equal(page.isClosed(), false); assert.equal(second.isClosed(), false);
});

test('observation overflow fails closed and disposing cannot report successful settling', { timeout: 30000 }, async t => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin, maxRecords: 1 }); t.after(() => observer.dispose());
  await page.goto(origin); await page.evaluate(async () => { await fetch('/other'); });
  const result = await observer.settle({ timeout: 30 });
  assert.equal(result.overflow, true); assert.equal(result.passed, false);
  await observer.dispose(); assert.equal((await observer.settle()).passed, false);
});

test('a streaming HTTP error stays failed when its document is replaced', { timeout: 30000 }, async t => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin }); t.after(() => observer.dispose());
  await page.goto(origin);
  await page.evaluate(async () => { await fetch('/stream-error').catch(() => {}); });
  await page.goto(origin + '/other');
  const result = await observer.settle();
  assert.equal(result.passed, false); assert.equal(result.failures.length, 1, JSON.stringify(result));
  assert.equal(result.failures[0].status, 500); assert.deepEqual(result.supersededReads, []);
});
