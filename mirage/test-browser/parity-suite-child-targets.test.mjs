// @test-kind security: a cross-site frame and a popup opened by a reference page send no write through the signed-in CDP driver
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { openCdpTabDriver } from '../parity-suite.mjs';

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function launchOwnedBrowser(profile) {
  const context = await chromium.launchPersistentContext(
    profile,
    browserLaunchOptions({
      headless: true,
      args: [
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-popup-blocking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      ],
    }),
  );
  const port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')[0]);
  return { context, cdpUrl: `http://127.0.0.1:${port}` };
}

/** Answers GET requests with `respond(url)` as HTML and records the URL of every other request in `writes`. */
function recordingHandler(writes, respond) {
  return (req, res) => {
    if (req.method !== 'GET') {
      writes.push(req.url);
      res.writeHead(200).end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(respond(req.url));
  };
}

/**
 * Opens the driver on the reference server's origin in an owned browser. The driver, the browser, both servers and the
 * directory close with the test.
 */
async function openDriver(t, directory, reference, frame) {
  const { context, cdpUrl } = await launchOwnedBrowser(path.join(directory, 'profile'));
  let driver;
  t.after(async () => {
    await driver?.close();
    await context.close();
    await closeServer(reference);
    await closeServer(frame);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const origin = `http://127.0.0.1:${reference.address().port}`;
  driver = await openCdpTabDriver({ cdpUrl, origin, allowLoopbackReference: true });
  return driver;
}

// The reference page reports each child once its own write attempt has settled, so the probe waits for all three.
const referencePage = (frameOrigin) => `<!doctype html><html><head><title>Portal</title><script>
window.childDone = new Promise((resolve) => {
  const seen = new Set();
  addEventListener('message', (event) => { seen.add(event.data); if (seen.size === 3) resolve(); });
});
</script></head><body><main>Reference page</main>
<iframe src="${frameOrigin}/frame"></iframe>
<script>window.open('/popup', 'popup');</script></body></html>`;

const framePage = `<!doctype html><title>Frame</title><script>
fetch('/frame-save', { method: 'POST', body: 'x' }).catch(() => {}).finally(() => parent.postMessage('frame-done', '*'));
</script>`;

const popupPage = `<!doctype html><title>Popup</title><script>
window.open('/nested', 'nested');
fetch('/popup-save', { method: 'POST', body: 'x' }).catch(() => {}).finally(() => window.opener.postMessage('popup-done', '*'));
</script>`;

// A popup of the popup: its opener is the driver's popup, so ownership must follow the opener chain.
const nestedPage = `<!doctype html><title>Nested</title><script>
fetch('/nested-save', { method: 'POST', body: 'x' }).catch(() => {}).finally(() => window.opener.opener.postMessage('nested-done', '*'));
</script>`;

test('a cross-site frame and a popup opened by a reference page send no write through the signed-in driver', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-child-targets-'));
  const posts = { reference: [], frame: [] };
  const frame = await listen(recordingHandler(posts.frame, () => framePage));
  const frameOrigin = `http://localhost:${frame.address().port}`;
  const pages = { '/popup': popupPage, '/nested': nestedPage };
  const reference = await listen(recordingHandler(posts.reference, (url) => pages[url] ?? referencePage(frameOrigin)));
  const driver = await openDriver(t, directory, reference, frame);
  const observation = await driver.page('/', {
    roots: ['main'],
    settleMs: 0,
    quietMs: 300,
    probeExpression: 'window.childDone.then(() => "done")',
  });
  assert.equal(observation.probeValue, 'done', 'all three child documents reported after their write attempts settled');
  assert.deepEqual(posts, { reference: [], frame: [] }, 'no child write reached a fixture server');
  assert.deepEqual(observation.blockedWrites.map((item) => item.method).sort(), ['POST', 'POST', 'POST']);
  assert.ok(
    observation.blockedWrites.some((item) => /frame-save/.test(item.url)),
    'the frame write is named',
  );
  assert.ok(
    observation.blockedWrites.some((item) => /popup-save/.test(item.url)),
    'the popup write is named',
  );
  assert.ok(
    observation.blockedWrites.some((item) => /nested-save/.test(item.url)),
    'the nested popup write is named',
  );
});

// @test-kind security: pages the driver does not own run untouched while it holds a tab, and a page opened after it closes is never intercepted
test('pages outside the driver run untouched while it holds a tab, and pages opened after it closes are not intercepted', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-foreign-'));
  const posts = { reference: [], foreign: [] };
  const arrivals = {
    '/foreign-save': Promise.withResolvers(),
    '/foreign-popup-save': Promise.withResolvers(),
    '/after-save': Promise.withResolvers(),
  };
  const foreign = await listen((req, res) => {
    if (req.method === 'POST') {
      posts.foreign.push(req.url);
      arrivals[req.url]?.resolve();
      res.writeHead(204).end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const origin = `http://127.0.0.1:${reference.address().port}`;
    const pages = {
      '/': `<!doctype html><title>Other</title><script>window.open(${JSON.stringify(`${origin}/foreign-popup`)}, 'foreign');
fetch('/foreign-save', { method: 'POST', body: 'x' }).catch(() => {});</script>`,
      '/after': `<!doctype html><title>After</title><script>fetch('/after-save', { method: 'POST', body: 'x' }).catch(() => {});</script>`,
    };
    res.end(pages[req.url] ?? '<!doctype html><title>Other</title>');
  });
  const reference = await listen((req, res) => {
    if (req.method === 'POST') {
      posts.reference.push(req.url);
      arrivals[req.url]?.resolve();
      res.writeHead(204).end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      req.url === '/foreign-popup'
        ? `<!doctype html><title>Foreign popup</title><script>fetch('/foreign-popup-save', { method: 'POST', body: 'x' }).catch(() => {});</script>`
        : '<!doctype html><title>Reference</title><main>Reference</main>',
    );
  });
  const origin = `http://127.0.0.1:${reference.address().port}`;
  const foreignOrigin = `http://127.0.0.1:${foreign.address().port}`;
  const { context, cdpUrl } = await launchOwnedBrowser(path.join(directory, 'profile'));
  let driver;
  t.after(async () => {
    await driver?.close();
    await context.close();
    await closeServer(reference);
    await closeServer(foreign);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  driver = await openCdpTabDriver({ cdpUrl, origin, allowLoopbackReference: true });
  // The driver's API tab stays open after a read, so the driver holds a tab while the foreign page loads.
  await driver.http('/');
  const outside = await context.newPage();
  await outside.goto(`${foreignOrigin}/`);
  await Promise.all([arrivals['/foreign-save'].promise, arrivals['/foreign-popup-save'].promise]);
  await driver.close();
  driver = null;
  const after = await context.newPage();
  await after.goto(`${foreignOrigin}/after`);
  await arrivals['/after-save'].promise;
  assert.deepEqual(posts.foreign.sort(), ['/after-save', '/foreign-save']);
  assert.deepEqual(
    posts.reference,
    ['/foreign-popup-save'],
    'a popup at the reference origin, not opened by the driver, is not intercepted',
  );
});

// The frame reports to the popup, and the popup reports to the page that opened it, once the frame's write attempt settled.
const framedPopupPage = (frameOrigin) => `<!doctype html><title>Framed popup</title><script>
addEventListener('message', (event) => { if (event.data === 'frame-done') window.opener.postMessage('popup-frame-done', '*'); });
</script><iframe src="${frameOrigin}/frame"></iframe>`;

const openerFramePage = `<!doctype html><title>Portal</title><main>Reference page</main><script>
window.popupFrameDone = new Promise((resolve) => {
  addEventListener('message', (event) => { if (event.data === 'popup-frame-done') resolve(); });
});
window.open('/popup-frame', 'popup-frame');
</script>`;

// @test-kind security: a cross-site frame inside a popup of the driver sends no write, and its interception routes end with the popup
test('a cross-site frame inside a popup of the driver sends no write, and no interception route outlives the popup', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-popup-frame-'));
  const posts = { reference: [], frame: [] };
  const frame = await listen(recordingHandler(posts.frame, () => framePage));
  const frameOrigin = `http://localhost:${frame.address().port}`;
  const reference = await listen(
    recordingHandler(posts.reference, (url) =>
      url === '/popup-frame' ? framedPopupPage(frameOrigin) : openerFramePage,
    ),
  );
  const driver = await openDriver(t, directory, reference, frame);
  const observation = await driver.page('/', {
    roots: ['main'],
    settleMs: 0,
    quietMs: 300,
    probeExpression: 'window.popupFrameDone.then(() => "done")',
  });
  assert.equal(observation.probeValue, 'done', 'the popup reported after its frame settled its write attempt');
  assert.deepEqual(posts, { reference: [], frame: [] }, 'no write of the framed popup reached a fixture server');
  assert.ok(
    observation.blockedWrites.some((item) => /frame-save/.test(item.url)),
    'the write of the frame inside the popup is named as blocked',
  );
  assert.equal(await driver.remainingRoutes(), 0, 'the popup closed, so no interception route remains for it');
});

// @test-kind tooling: the signed-in driver sends If-None-Match with a read, so a conditional read gets the reference's conditional answer
test('the signed-in driver sends the If-None-Match header of a conditional read', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-conditional-'));
  const conditions = [];
  const reference = await listen((req, res) => {
    if (req.url === '/items') conditions.push(req.headers['if-none-match'] ?? null);
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304).end();
      return;
    }
    res.setHeader('etag', '"v1"');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Items</title><main>Items</main>');
  });
  const origin = `http://127.0.0.1:${reference.address().port}`;
  const { context, cdpUrl } = await launchOwnedBrowser(path.join(directory, 'profile'));
  let driver;
  t.after(async () => {
    await driver?.close();
    await context.close();
    await closeServer(reference);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  driver = await openCdpTabDriver({ cdpUrl, origin, allowLoopbackReference: true });
  const first = await driver.http('/items');
  assert.equal(first.status, 200);
  const again = await driver.http('/items', { ifNoneMatch: first.headers.etag });
  assert.equal(again.status, 304);
  assert.deepEqual(conditions, [null, '"v1"']);
});
