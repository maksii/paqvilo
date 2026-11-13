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
import { devToolsActivePort, openResumingClient } from './shared-browser.mjs';

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
        // Every site runs in its own process, so the cross-site frames of these tests are out-of-process frames on every
        // browser: Edge isolates sites by default, Playwright's headless Chromium shell does not.
        '--site-per-process',
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
  const port = await devToolsActivePort(profile);
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
async function openDriver(t, directory, reference, frame, options = {}) {
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
  driver = await openCdpTabDriver({ cdpUrl, origin, allowLoopbackReference: true, ...options });
  return driver;
}

const referencePage = (frameOrigin) => `<!doctype html><title>Portal</title><main>Reference page</main>
<iframe src="${frameOrigin}/frame"></iframe>
<script>window.open('/popup', 'popup');</script>`;

// Each child reports to its own server (a read the driver continues) once its own write attempt has settled.
const framePage = `<!doctype html><title>Frame</title><script>
fetch('/frame-save', { method: 'POST', body: 'x' }).catch(() => {}).finally(() => fetch('/frame-reported'));
</script>`;

const popupPage = `<!doctype html><title>Popup</title><script>
window.open('/nested', 'nested');
fetch('/popup-save', { method: 'POST', body: 'x' }).catch(() => {}).finally(() => fetch('/popup-reported'));
</script>`;

// A popup of the popup: its opener is the driver's popup, so ownership must follow the opener chain.
const nestedPage = `<!doctype html><title>Nested</title><script>
fetch('/nested-save', { method: 'POST', body: 'x' }).catch(() => {}).finally(() => fetch('/nested-reported'));
</script>`;

/**
 * The driver's WebSocket, unchanged except that it records the fate of each named write: the fate settles, naming the
 * session kind, when the driver fails a paused request whose path is that write's. The type of every attached target is
 * added to `targetTypes`.
 */
function recordFailedWrites(fates, targetTypes = new Set()) {
  const key = (sessionId, requestId) => `${sessionId ?? 'browser'}:${requestId}`;
  return class FailedWrites extends WebSocket {
    #pausedPaths = new Map();
    constructor(url) {
      super(url);
      // Registered before the driver's handler, so a paused request is recorded before the driver answers it.
      this.addEventListener('message', (event) => {
        const { method, params, sessionId } = JSON.parse(event.data);
        if (method === 'Target.attachedToTarget') targetTypes.add(params.targetInfo.type);
        if (method === 'Fetch.requestPaused')
          this.#pausedPaths.set(key(sessionId, params.requestId), new URL(params.request.url).pathname);
      });
    }
    send(data) {
      const { method, params, sessionId } = JSON.parse(data);
      if (method === 'Fetch.failRequest')
        fates
          .get(this.#pausedPaths.get(key(sessionId, params.requestId)))
          ?.resolve(sessionId ? 'blocked by the page interception' : 'blocked by the write net');
      super.send(data);
    }
  };
}

/**
 * A fixture server handler: a write resolves its fate as reached and is recorded in `writes`; a report resolves its
 * arrival; /all-reported is answered "done" once every report has arrived; any other read is answered with
 * `respond(url)` as HTML.
 */
function fateHandler({ writes, fates, reports }, respond) {
  return async (req, res) => {
    if (req.url === '/all-reported') {
      await Promise.all([...reports.values()].map((report) => report.promise));
      res.end('done');
      return;
    }
    if (req.method !== 'GET') {
      writes.push(req.url);
      fates.get(req.url)?.resolve('reached a fixture server');
      res.writeHead(200).end();
      return;
    }
    if (reports.has(req.url)) {
      reports.get(req.url).resolve();
      res.writeHead(204).end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(respond(req.url));
  };
}

const withResolvers = (keys) => new Map(keys.map((key) => [key, Promise.withResolvers()]));
const settledFates = async (fates) =>
  Object.fromEntries(await Promise.all([...fates].map(async ([write, fate]) => [write, await fate.promise])));

test('a cross-site frame and a popup opened by a reference page send no write through the signed-in driver', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-child-targets-'));
  const posts = { reference: [], frame: [] };
  const fates = withResolvers(['/frame-save', '/popup-save', '/nested-save']);
  const reports = withResolvers(['/frame-reported', '/popup-reported', '/nested-reported']);
  const frame = await listen(fateHandler({ writes: posts.frame, fates, reports }, () => framePage));
  const frameOrigin = `http://localhost:${frame.address().port}`;
  const pages = { '/popup': popupPage, '/nested': nestedPage };
  const reference = await listen(
    fateHandler({ writes: posts.reference, fates, reports }, (url) => pages[url] ?? referencePage(frameOrigin)),
  );
  const targetTypes = new Set();
  const driver = await openDriver(t, directory, reference, frame, {
    WebSocketImpl: recordFailedWrites(fates, targetTypes),
  });
  // The probe's read is answered once all three children reported, each after its own write attempt settled.
  const observation = await driver.page('/', {
    roots: ['main'],
    settleMs: 0,
    quietMs: 300,
    probeExpression: 'fetch("/all-reported").then((response) => response.text())',
  });
  assert.ok(targetTypes.has('iframe'), 'the cross-site frame ran in its own process, under its own frame session');
  assert.equal(observation.probeValue, 'done', 'all three child documents reported after their write attempts settled');
  assert.deepEqual(
    await settledFates(fates),
    {
      '/frame-save': 'blocked by the page interception',
      '/popup-save': 'blocked by the page interception',
      '/nested-save': 'blocked by the page interception',
    },
    'each child write was stopped by the driver',
  );
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

// @test-kind contract: a page with a cross-site frame settles once the frame's document has been handed to the frame's own process
test('a page with a cross-site frame settles without waiting for the settle limit', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-frame-settle-'));
  const frame = await listen((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Frame</title><main>Frame</main>');
  });
  const frameOrigin = `http://localhost:${frame.address().port}`;
  const reference = await listen(
    recordingHandler(
      [],
      () =>
        `<!doctype html><title>Portal</title><main>Reference page</main><iframe src="${frameOrigin}/frame"></iframe>`,
    ),
  );
  const driver = await openDriver(t, directory, reference, frame);
  const observation = await driver.page('/', { roots: ['main'], settleMs: 0, quietMs: 300 });
  assert.equal(observation.settled, true, 'the page settles while its cross-site frame is loaded');
  assert.deepEqual(observation.pendingRequests, [], 'no request is left pending after the frame has loaded');
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

const framedPopupPage = (frameOrigin) =>
  `<!doctype html><title>Framed popup</title><iframe src="${frameOrigin}/frame"></iframe>`;

const openerFramePage = `<!doctype html><title>Portal</title><main>Reference page</main><script>
window.open('/popup-frame', 'popup-frame');
</script>`;

// @test-kind security: a cross-site frame inside a popup of the driver sends no write, and its interception routes end with the popup
test('a cross-site frame inside a popup of the driver sends no write, and no interception route outlives the popup', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-popup-frame-'));
  const posts = { reference: [], frame: [] };
  const fates = withResolvers(['/frame-save']);
  const reports = withResolvers(['/frame-reported']);
  const frame = await listen(fateHandler({ writes: posts.frame, fates, reports }, () => framePage));
  const frameOrigin = `http://localhost:${frame.address().port}`;
  const reference = await listen(
    fateHandler({ writes: posts.reference, fates, reports }, (url) =>
      url === '/popup-frame' ? framedPopupPage(frameOrigin) : openerFramePage,
    ),
  );
  const targetTypes = new Set();
  const driver = await openDriver(t, directory, reference, frame, {
    WebSocketImpl: recordFailedWrites(fates, targetTypes),
  });
  const observation = await driver.page('/', {
    roots: ['main'],
    settleMs: 0,
    quietMs: 300,
    probeExpression: 'fetch("/all-reported").then((response) => response.text())',
  });
  assert.ok(
    targetTypes.has('iframe'),
    'the frame inside the popup ran in its own process, under its own frame session',
  );
  assert.equal(observation.probeValue, 'done', 'the frame inside the popup reported after its write attempt settled');
  assert.deepEqual(
    await settledFates(fates),
    { '/frame-save': 'blocked by the page interception' },
    'the write of the frame inside the popup was stopped by the driver',
  );
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

/**
 * The driver's WebSocket, holding each popup session's Fetch.enable and Runtime.runIfWaitingForDebugger until
 * `released`. A write's fate settles when the driver fails a paused request, on any session, that names its path.
 */
function holdPopupGuards(released, fates) {
  const key = (sessionId, requestId) => `${sessionId ?? 'browser'}:${requestId}`;
  return class HeldPopupGuards extends WebSocket {
    #popupSessions = new Set();
    #pausedPaths = new Map();
    constructor(url) {
      super(url);
      this.addEventListener('message', (event) => this.#observe(JSON.parse(event.data)));
    }
    #observe({ method, params, sessionId }) {
      if (method === 'Target.attachedToTarget' && !sessionId && params.targetInfo.openerId)
        this.#popupSessions.add(params.sessionId);
      if (method === 'Fetch.requestPaused')
        this.#pausedPaths.set(key(sessionId, params.requestId), new URL(params.request.url).pathname);
    }
    send(data) {
      const { method, params, sessionId } = JSON.parse(data);
      if (method === 'Fetch.failRequest')
        fates
          .get(this.#pausedPaths.get(key(sessionId, params.requestId)))
          ?.resolve(sessionId ? 'blocked by the page interception' : 'blocked by the write net');
      const guard = method === 'Fetch.enable' || method === 'Runtime.runIfWaitingForDebugger';
      if (!guard || !this.#popupSessions.has(sessionId)) {
        super.send(data);
        return;
      }
      released.then(() => {
        if (this.readyState === WebSocket.OPEN) super.send(data);
      });
    }
  };
}

const coClientOpenerPage = `<!doctype html><title>Portal</title><main>Reference page</main>
<form id="save" method="post" action="/form-save" target="form-popup"><input name="a" value="1"></form>
<script>
window.popupDone = new Promise((resolve) => {
  addEventListener('message', (event) => { if (event.data === 'popup-done') resolve(); });
});
document.getElementById('save').submit();
window.open('/popup', 'popup');
</script>`;

const coClientPopupPage = `<!doctype html><title>Popup</title><script>
fetch('/popup-save', { method: 'POST', body: 'x' }).catch(() => {}).finally(() => window.opener.postMessage('popup-done', '*'));
</script>`;

// @test-kind security: a popup that another debugging client resumes before the driver guards it sends no write, whether the write is its first request (a form POST) or a script request
test('a popup resumed by another debugging client before the driver guards it sends no write', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-co-client-'));
  const writes = ['/form-save', '/popup-save'];
  const fates = new Map(writes.map((write) => [write, Promise.withResolvers()]));
  const posts = [];
  const reference = await listen(async (req, res) => {
    if (req.method !== 'GET') {
      posts.push(req.url);
      fates.get(req.url)?.resolve('reached the reference');
      res.writeHead(200).end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/popup') {
      // The scripted popup loads once the form popup's write has met its fate, so both fates settle before the probe.
      await fates.get('/form-save').promise;
      res.end(coClientPopupPage);
      return;
    }
    res.end(req.url === '/' ? coClientOpenerPage : '<!doctype html><title>Other</title>');
  });
  const { context, cdpUrl } = await launchOwnedBrowser(path.join(directory, 'profile'));
  const coClient = await openResumingClient(cdpUrl);
  let driver;
  t.after(async () => {
    await driver?.close();
    await coClient.close();
    await context.close();
    await closeServer(reference);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const released = Promise.all([...fates.values()].map((fate) => fate.promise));
  driver = await openCdpTabDriver({
    cdpUrl,
    origin: `http://127.0.0.1:${reference.address().port}`,
    allowLoopbackReference: true,
    WebSocketImpl: holdPopupGuards(released, fates),
  });
  const observation = await driver.page('/', {
    roots: ['main'],
    settleMs: 0,
    quietMs: 300,
    probeExpression: 'window.popupDone.then(() => "done")',
  });
  assert.equal(observation.probeValue, 'done', 'the scripted popup reported after its write attempt settled');
  assert.deepEqual(
    Object.fromEntries(await Promise.all(writes.map(async (write) => [write, await fates.get(write).promise]))),
    { '/form-save': 'blocked by the write net', '/popup-save': 'blocked by the write net' },
    'each write was stopped by the driver while the popup guards were held',
  );
  assert.deepEqual(posts, [], 'no popup write reached the reference');
  for (const write of writes)
    assert.ok(
      observation.blockedWrites.some((item) => item.url.includes(write)),
      `${write} is named as a blocked write`,
    );
});

const popupOpenerPage = `<!doctype html><title>Portal</title><main>Reference page</main><script>
window.popupDone = new Promise((resolve) => {
  addEventListener('message', (event) => { if (event.data === 'popup-done') resolve(); });
});
window.open('/popup', 'popup');
</script>`;

/**
 * The driver's WebSocket, which holds the response to Fetch.enable of a popup the driver opened until the popup's first
 * paused request has reached the driver. The driver then reads that request before the response that registers its
 * handler, the order a late Fetch.enable response produces. No timer releases the response.
 */
class PopupEnableAckAfterPause extends WebSocket {
  #popupSessions = new Set();
  #enableCommands = new Map();
  #held = new Map();
  #handler = null;
  set onmessage(handler) {
    this.#handler = handler;
    super.onmessage = (event) => this.#incoming(event.data);
  }
  get onmessage() {
    return this.#handler;
  }
  send(data) {
    const { id, method, sessionId } = JSON.parse(data);
    if (method === 'Fetch.enable' && this.#popupSessions.has(sessionId)) this.#enableCommands.set(id, sessionId);
    super.send(data);
  }
  #incoming(data) {
    const { id, method, params, sessionId } = JSON.parse(data);
    if (method === 'Target.attachedToTarget' && !sessionId && params.waitingForDebugger && params.targetInfo.openerId)
      this.#popupSessions.add(params.sessionId);
    if (this.#enableCommands.has(id)) {
      this.#held.set(this.#enableCommands.get(id), data);
      return;
    }
    this.#deliver(data);
    if (method === 'Fetch.requestPaused' && this.#held.has(sessionId)) {
      this.#deliver(this.#held.get(sessionId));
      this.#held.delete(sessionId);
    }
  }
  #deliver(data) {
    this.#handler?.({ data });
  }
}

// @test-kind security: a popup request paused before its interception is acknowledged is still refused, and the popup loads
test('a popup request that is paused before its interception is acknowledged is still handled', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-paused-early-'));
  const posts = [];
  const reference = await listen(
    recordingHandler(posts, (url) => (url === '/popup' ? coClientPopupPage : popupOpenerPage)),
  );
  const { context, cdpUrl } = await launchOwnedBrowser(path.join(directory, 'profile'));
  const resuming = await openResumingClient(cdpUrl);
  let driver;
  t.after(async () => {
    await driver?.close();
    await resuming.close();
    await context.close();
    await closeServer(reference);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  driver = await openCdpTabDriver({
    cdpUrl,
    origin: `http://127.0.0.1:${reference.address().port}`,
    allowLoopbackReference: true,
    WebSocketImpl: PopupEnableAckAfterPause,
  });
  const observation = await driver.page('/', {
    roots: ['main'],
    settleMs: 0,
    quietMs: 300,
    probeExpression: 'window.popupDone.then(() => "done")',
  });
  assert.equal(observation.probeValue, 'done', 'the popup reported after its write attempt settled');
  assert.deepEqual(posts, [], 'no popup write reached the reference');
  assert.ok(
    observation.blockedWrites.some((item) => /popup-save/.test(item.url)),
    'the popup write is named as blocked',
  );
});

// The cross-site frame starts a read that its server holds until the test opens the gate. The reference page's own
// image is answered only once that read has reached the frame server, so the page's document completes only after
// the frame's read was announced to the driver.
const gatedFramePage = `<!doctype html><title>Frame</title><main>Frame</main><script>fetch('/slow').catch(() => {});</script>`;
const gatedReferencePage = (frameOrigin) =>
  `<!doctype html><title>Portal</title><main>Reference page</main><iframe src="${frameOrigin}/frame"></iframe><img src="/after-frame-read" alt="">`;

// @test-kind contract: a page is not settled while a request of its cross-site frame is in flight, and is settled once that request has finished
test('a page is not settled while its cross-site frame still has a request in flight', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-frame-inflight-'));
  let gateOpen = false;
  const held = new Set();
  let frameRead = Promise.withResolvers();
  const frame = await listen((req, res) => {
    if (req.url === '/slow') {
      frameRead.resolve();
      if (gateOpen) res.end('ok');
      else held.add(res);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(gatedFramePage);
  });
  const frameOrigin = `http://localhost:${frame.address().port}`;
  const reference = await listen(async (req, res) => {
    if (req.url === '/after-frame-read') {
      await frameRead.promise;
      res.writeHead(204).end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(gatedReferencePage(frameOrigin));
  });
  const driver = await openDriver(t, directory, reference, frame);
  const held1 = await driver.page('/', { roots: ['main'], quietMs: 300, settleTimeout: 1000 });
  assert.equal(held1.settled, false, 'the page is not settled while the frame read is held');
  assert.deepEqual(
    held1.pendingRequests.filter((url) => url.endsWith('/slow')),
    [`${frameOrigin}/slow`],
    'the held frame read is named as pending',
  );
  gateOpen = true;
  for (const res of held) res.end('ok');
  frameRead = Promise.withResolvers();
  const released = await driver.page('/', { roots: ['main'], quietMs: 300 });
  assert.equal(released.settled, true, 'the page settles once the frame read has finished');
  assert.deepEqual(released.pendingRequests, [], 'no request is left pending');
});

// A cross-site frame embeds a frame back on the reference site. The nested frame first attempts a write, then starts a
// read that the reference server holds until the test opens the gate. The reference page's own image is answered only
// once that read has reached the server, so the page's document completes only after the nested read was announced.
const outerFramePage = (nestedUrl) =>
  `<!doctype html><title>Frame</title><main>Frame</main><iframe src="${nestedUrl}"></iframe>`;
const nestedFramePage = `<!doctype html><title>Nested frame</title><script>
fetch('/nested-save', { method: 'POST', body: 'x' }).catch(() => {}).finally(() => fetch('/nested-slow'));
</script>`;
const nestedReferencePage = (frameOrigin) =>
  `<!doctype html><title>Portal</title><main>Reference page</main><iframe src="${frameOrigin}/frame"></iframe><img src="/after-nested-read" alt="">`;

// @test-kind contract: a page is not settled while a request of a frame nested in its cross-site frame is in flight, and the nested frame's write is refused for the tab
test('a page is not settled while a frame nested inside its cross-site frame still has a request in flight', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-nested-inflight-'));
  const posts = [];
  let gateOpen = false;
  const held = new Set();
  let nestedRead = Promise.withResolvers();
  const fates = withResolvers(['/nested-save']);
  const reference = await listen(async (req, res) => {
    if (req.method !== 'GET') {
      posts.push(req.url);
      fates.get(req.url)?.resolve('reached the reference');
      res.writeHead(200).end();
      return;
    }
    if (req.url === '/nested-slow') {
      nestedRead.resolve();
      if (gateOpen) res.end('ok');
      else held.add(res);
      return;
    }
    if (req.url === '/after-nested-read') {
      await nestedRead.promise;
      res.writeHead(204).end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(req.url === '/nested' ? nestedFramePage : nestedReferencePage(frameOrigin));
  });
  const origin = `http://127.0.0.1:${reference.address().port}`;
  const frame = await listen((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(outerFramePage(`${origin}/nested`));
  });
  const frameOrigin = `http://localhost:${frame.address().port}`;
  const driver = await openDriver(t, directory, reference, frame, { WebSocketImpl: recordFailedWrites(fates) });
  const held1 = await driver.page('/', { roots: ['main'], quietMs: 300, settleTimeout: 1000 });
  assert.equal(held1.settled, false, 'the page is not settled while the nested frame read is held');
  assert.deepEqual(
    held1.pendingRequests.filter((url) => url.endsWith('/nested-slow')),
    ['/nested-slow'],
    'the held nested frame read is named as pending',
  );
  assert.deepEqual(
    await settledFates(fates),
    { '/nested-save': 'blocked by the page interception' },
    'the nested frame write was stopped by the driver',
  );
  assert.deepEqual(posts, [], 'no nested frame write reached the reference');
  assert.ok(
    held1.blockedWrites.some((item) => /nested-save/.test(item.url)),
    'the nested frame write is named as blocked for the tab',
  );
  gateOpen = true;
  for (const res of held) res.end('ok');
  nestedRead = Promise.withResolvers();
  const released = await driver.page('/', { roots: ['main'], quietMs: 300 });
  assert.equal(released.settled, true, 'the page settles once the nested frame read has finished');
  assert.deepEqual(released.pendingRequests, [], 'no request is left pending');
});

// A dedicated worker started by the frame (or by the root page) reads /worker-read and attempts /worker-save. The root
// page's image is answered only once /worker-read reached the server, so the document cannot finish while the worker
// is held.
const workerScript = `fetch('/worker-save', { method: 'POST', body: 'x' }).catch(() => {}).finally(() => fetch('/worker-read'));`;
const workerFramePage = `<!doctype html><title>Frame</title><main>Frame</main><script>new Worker('/worker.js');</script>`;

for (const where of ['cross-site frame', 'root page']) {
  // @test-kind contract: a dedicated worker of the page or of its cross-site frame runs and the page settles once its requests finish
  test(`a dedicated worker of the ${where} runs, and the page settles`, async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-worker-'));
    const workerRead = Promise.withResolvers();
    const posts = [];
    const fates = withResolvers(['/worker-save']);
    const serveWorker = (req, res) => {
      if (req.method !== 'GET') {
        posts.push(req.url);
        fates.get(req.url)?.resolve('reached a fixture server');
        res.writeHead(200).end();
        return true;
      }
      if (req.url === '/worker.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(workerScript);
        return true;
      }
      if (req.url === '/worker-read') {
        workerRead.resolve();
        res.end('ok');
        return true;
      }
      return false;
    };
    const frame = await listen((req, res) => {
      if (serveWorker(req, res)) return;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(workerFramePage);
    });
    const frameOrigin = `http://localhost:${frame.address().port}`;
    const reference = await listen(async (req, res) => {
      if (serveWorker(req, res)) return;
      if (req.url === '/after-worker-read') {
        await workerRead.promise;
        res.writeHead(204).end();
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        where === 'root page'
          ? `<!doctype html><title>Portal</title><main>Reference page</main><script>new Worker('/worker.js');</script><img src="/after-worker-read" alt="">`
          : `<!doctype html><title>Portal</title><main>Reference page</main><iframe src="${frameOrigin}/frame"></iframe><img src="/after-worker-read" alt="">`,
      );
    });
    const driver = await openDriver(t, directory, reference, frame, { WebSocketImpl: recordFailedWrites(fates) });
    const observation = await driver.page('/', { roots: ['main'], quietMs: 300, settleTimeout: 15000 });
    assert.equal(observation.settled, true, 'the page settles once the worker and its requests have finished');
    assert.deepEqual(observation.pendingRequests, [], 'no request of the page or of the worker is left pending');
    assert.deepEqual(posts, [], 'no worker write reached a fixture server');
    assert.deepEqual(await settledFates(fates), { '/worker-save': 'blocked by the page interception' });
    await workerRead.promise;
  });
}

// The popup is cross-site, so it runs in its own renderer process (--site-per-process). Playwright's Linux headless
// Chromium shell, under CPU load, can leave a same-site popup's dedicated worker forever unstarted (its target exists
// with no URL, no client is attached to it, and it never runs), with no driver involved; a popup in its own process
// does not show this, and the test proves the same driver behaviour either way.
const workerPopupPage = `<!doctype html><title>Popup</title><script>new Worker('/worker.js');</script>`;
const workerOpenerPage = (popupOrigin) => `<!doctype html><title>Portal</title><main>Reference page</main>
<script>window.open('${popupOrigin}/popup', 'popup');</script>`;

// @test-kind contract: a dedicated worker of a popup opened by the page runs, and its write is refused
test('a dedicated worker of a popup opened by the page runs, and its write is refused', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-popup-worker-'));
  const posts = { reference: [], popup: [] };
  const fates = withResolvers(['/worker-save']);
  // The worker's read is its report: it is sent after the worker's write attempt has settled, whatever its outcome.
  const reports = withResolvers(['/worker-read']);
  const popupServer = await listen((req, res) => {
    if (req.url === '/worker.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(workerScript);
      return;
    }
    fateHandler({ writes: posts.popup, fates, reports }, () => workerPopupPage)(req, res);
  });
  const popupOrigin = `http://localhost:${popupServer.address().port}`;
  const reference = await listen(
    fateHandler({ writes: posts.reference, fates, reports }, () => workerOpenerPage(popupOrigin)),
  );
  const driver = await openDriver(t, directory, reference, popupServer, { WebSocketImpl: recordFailedWrites(fates) });
  // The probe's read is answered once the popup's worker has reported.
  const observation = await driver.page('/', {
    roots: ['main'],
    settleMs: 0,
    quietMs: 300,
    probeExpression: 'fetch("/all-reported").then((response) => response.text())',
  });
  assert.equal(observation.probeValue, 'done', 'the worker of the popup reported after its write attempt settled');
  // A worker has no Fetch domain: the popup session that started it pauses the write (handlePopupMessage).
  assert.deepEqual(
    await settledFates(fates),
    { '/worker-save': 'blocked by the page interception' },
    'the write of the popup worker was stopped by the driver',
  );
  assert.deepEqual(posts, { reference: [], popup: [] }, 'no worker write reached a fixture server');
  assert.ok(
    observation.blockedWrites.some((item) => /worker-save/.test(item.url)),
    'the worker write is named as blocked',
  );
  assert.equal(await driver.remainingRoutes(), 0, 'the popup closed, so no interception route remains for it');
});
