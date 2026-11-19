// @test-kind security: a cross-site frame and a popup opened by a reference page send no write through the signed-in CDP driver
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { ownedFixture, makeTemporaryDirectory, removeFixtureDirectory } from '../testing/owned-fixture.mjs';
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
// These settles are expected to succeed. The bound is longer than the runner's hang guard, so it never decides a
// result: settle() requires a finite timeout.
const STEP_GUARD_MS = 600_000;

async function openDriver(t, directory, reference, frame, { coClient = false, ...options } = {}) {
  const { context, cdpUrl } = await launchOwnedBrowser(path.join(directory, 'profile'));
  // A second debugging client that resumes every target the moment it is attached, ahead of the driver.
  const resuming = coClient ? await openResumingClient(cdpUrl) : null;
  let driver;
  ownedFixture(t).add(async () => {
    await driver?.close();
    await resuming?.close();
    await context.close();
    await closeServer(reference);
    await closeServer(frame);
    await removeFixtureDirectory(directory);
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
 * The driver's guards of the popups opened in the browser, in creation order. `decided(n)` settles once the driver has
 * decided each of the first n popups: the browser acknowledged the driver's auto-attach of it (every frame or worker it
 * creates from then on waits for the driver), or the driver resumed or closed it without that, or the popup sent a
 * request before the driver had attached it. Another debugging client (the test's own Playwright connection, on
 * Chromium) can resume a popup before the driver guards it, and the frames it creates meanwhile are stopped only by the
 * write net, so a fixture that asserts the page interception serves a popup's document once it is decided. A driver
 * that stops guarding popups opens the gate too, and the test then fails on its named assertions.
 */
function popupGuards() {
  const decisions = [];
  const decide = (index) => (decisions[index] ??= Promise.withResolvers());
  return {
    decide,
    created: 0,
    decided: (count) => Promise.all(Array.from({ length: count }, (_, index) => decide(index).promise)),
  };
}

/**
 * The driver's WebSocket, unchanged except that it records the fate of each named write: the fate settles, naming the
 * session kind, when the driver fails a paused request whose path is that write's. The type of every attached target is
 * added to `targetTypes`, and the driver's decision on each popup to `guards`. A popup's auto-attach is sent only once
 * `holdAutoAttach` settles.
 */
function recordFailedWrites(fates, targetTypes = new Set(), { guards = popupGuards(), holdAutoAttach = null } = {}) {
  const key = (sessionId, requestId) => `${sessionId ?? 'browser'}:${requestId}`;
  return class FailedWrites extends WebSocket {
    #pausedPaths = new Map();
    #popupTargets = new Map();
    #attachedPopups = new Set();
    #popupSessions = new Map();
    #autoAttachCommands = new Map();
    constructor(url) {
      super(url);
      // Registered before the driver's handler, so a paused request is recorded before the driver answers it.
      this.addEventListener('message', (event) => this.#observe(JSON.parse(event.data)));
    }
    #observe({ id, method, params, sessionId }) {
      if (method === 'Target.attachedToTarget') targetTypes.add(params.targetInfo.type);
      // The browser announces a popup (discovered by the write net) before any client can attach or resume it.
      if (method === 'Target.targetCreated' && params.targetInfo.type === 'page' && params.targetInfo.openerId)
        this.#popupTargets.set(params.targetInfo.targetId, guards.created++);
      // A popup the driver's browser session auto-attached (an explicit attach is not waiting for a debugger).
      if (method === 'Target.attachedToTarget' && !sessionId && params.waitingForDebugger) {
        const index = this.#popupTargets.get(params.targetInfo.targetId);
        if (index !== undefined) this.#popupSessions.set(params.sessionId, index);
        this.#attachedPopups.add(params.targetInfo.targetId);
      }
      if (this.#autoAttachCommands.has(id)) guards.decide(this.#autoAttachCommands.get(id)).resolve();
      // A popup request on the browser session before the driver attached the popup: it runs unguarded.
      if (method === 'Fetch.requestPaused' && !sessionId && !this.#attachedPopups.has(params.frameId))
        this.#decided(this.#popupTargets.get(params.frameId));
      if (method === 'Target.targetDestroyed') this.#decided(this.#popupTargets.get(params.targetId));
      if (method === 'Fetch.requestPaused')
        this.#pausedPaths.set(key(sessionId, params.requestId), new URL(params.request.url).pathname);
    }
    #decided(index) {
      if (index !== undefined) guards.decide(index).resolve();
    }
    send(data) {
      const { id, method, params, sessionId } = JSON.parse(data);
      if (method === 'Fetch.failRequest')
        fates
          .get(this.#pausedPaths.get(key(sessionId, params.requestId)))
          ?.resolve(sessionId ? 'blocked by the page interception' : 'blocked by the write net');
      // A popup the driver resumes or closes is decided, guarded or not.
      if (method === 'Runtime.runIfWaitingForDebugger') this.#decided(this.#popupSessions.get(sessionId));
      if (method === 'Target.closeTarget') this.#decided(this.#popupTargets.get(params.targetId));
      const popupAutoAttach = method === 'Target.setAutoAttach' && this.#popupSessions.has(sessionId);
      if (popupAutoAttach) this.#autoAttachCommands.set(id, this.#popupSessions.get(sessionId));
      if (!popupAutoAttach || !holdAutoAttach) {
        super.send(data);
        return;
      }
      holdAutoAttach.then(() => {
        if (this.readyState === WebSocket.OPEN) super.send(data);
      });
    }
  };
}

/**
 * A fixture server handler: a write resolves its fate as reached and is recorded in `writes`; a report resolves its
 * arrival; /all-reported is answered "done" once every report has arrived; any other read is answered with what
 * `respond(url)` resolves to, as HTML.
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
    res.end(await respond(req.url));
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
  const guards = popupGuards();
  // Each popup's document is served once the driver has decided it and every popup opened before it.
  const pages = { '/popup': [1, popupPage], '/nested': [2, nestedPage] };
  const reference = await listen(
    fateHandler({ writes: posts.reference, fates, reports }, async (url) => {
      if (!pages[url]) return referencePage(frameOrigin);
      const [popups, page] = pages[url];
      await guards.decided(popups);
      return page;
    }),
  );
  const targetTypes = new Set();
  const driver = await openDriver(t, directory, reference, frame, {
    WebSocketImpl: recordFailedWrites(fates, targetTypes, { guards }),
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
  const observation = await driver.page('/', {
    roots: ['main'],
    settleMs: 0,
    quietMs: 300,
    settleTimeout: STEP_GUARD_MS,
  });
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
  ownedFixture(t).add(async () => {
    await driver?.close();
    await context.close();
    await closeServer(reference);
    await closeServer(foreign);
    await removeFixtureDirectory(directory);
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

// Another client resumes the popup the moment it is attached, and the driver's guard of the popup (its auto-attach) is
// sent only once the popup's document is held for it, or, when no fixture holds it, once the frame's write has met its
// fate. A guarded popup's frame meets the driver's frame interception. A frame the popup created before its guard is the
// order the browser-session write net exists for: the net stops its write and reports it under the opener tab.
const popupFrameCases = [
  {
    name: 'a cross-site frame inside a popup of the driver sends no write, and no interception route outlives the popup',
    guardedDocument: true,
    fate: 'blocked by the page interception',
  },
  {
    name: 'a cross-site frame a popup creates before the driver guards the popup is stopped by the write net and reported for the tab',
    guardedDocument: false,
    fate: 'blocked by the write net',
  },
];

for (const { name, guardedDocument, fate } of popupFrameCases) {
  // @test-kind security: a cross-site frame inside a popup of the driver sends no write, whether the popup is guarded before the frame exists or after, and its interception routes end with the popup
  test(name, async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-mirage-popup-frame-'));
    const posts = { reference: [], frame: [] };
    const fates = withResolvers(['/frame-save']);
    const reports = withResolvers(['/frame-reported']);
    const frame = await listen(fateHandler({ writes: posts.frame, fates, reports }, () => framePage));
    const frameOrigin = `http://localhost:${frame.address().port}`;
    const guards = popupGuards();
    const popupHeld = Promise.withResolvers();
    const reference = await listen(
      fateHandler({ writes: posts.reference, fates, reports }, async (url) => {
        if (url !== '/popup-frame') return openerFramePage;
        if (guardedDocument) {
          popupHeld.resolve();
          await guards.decided(1);
        }
        return framedPopupPage(frameOrigin);
      }),
    );
    const targetTypes = new Set();
    const driver = await openDriver(t, directory, reference, frame, {
      coClient: true,
      WebSocketImpl: recordFailedWrites(fates, targetTypes, {
        guards,
        holdAutoAttach: Promise.race([popupHeld.promise, fates.get('/frame-save').promise]),
      }),
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
      { '/frame-save': fate },
      'the write of the frame inside the popup was stopped by the driver',
    );
    assert.deepEqual(posts, { reference: [], frame: [] }, 'no write of the framed popup reached a fixture server');
    assert.ok(
      observation.blockedWrites.some((item) => item.method === 'POST' && /frame-save/.test(item.url)),
      'the write of the frame inside the popup is named as blocked for the tab that opened the popup',
    );
    assert.equal(await driver.remainingRoutes(), 0, 'the popup closed, so no interception route remains for it');
  });
}

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
  ownedFixture(t).add(async () => {
    await driver?.close();
    await context.close();
    await closeServer(reference);
    await removeFixtureDirectory(directory);
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
  ownedFixture(t).add(async () => {
    await driver?.close();
    await coClient.close();
    await context.close();
    await closeServer(reference);
    await removeFixtureDirectory(directory);
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
  ownedFixture(t).add(async () => {
    await driver?.close();
    await resuming.close();
    await context.close();
    await closeServer(reference);
    await removeFixtureDirectory(directory);
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
  const released = await driver.page('/', { roots: ['main'], quietMs: 300, settleTimeout: STEP_GUARD_MS });
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
  const released = await driver.page('/', { roots: ['main'], quietMs: 300, settleTimeout: STEP_GUARD_MS });
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
    const observation = await driver.page('/', { roots: ['main'], quietMs: 300, settleTimeout: STEP_GUARD_MS });
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
  const guards = popupGuards();
  const popupServer = await listen((req, res) => {
    if (req.url === '/worker.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(workerScript);
      return;
    }
    // The popup's document, and with it its worker, is served once the driver has decided the popup.
    fateHandler({ writes: posts.popup, fates, reports }, () => guards.decided(1).then(() => workerPopupPage))(req, res);
  });
  const popupOrigin = `http://localhost:${popupServer.address().port}`;
  const reference = await listen(
    fateHandler({ writes: posts.reference, fates, reports }, () => workerOpenerPage(popupOrigin)),
  );
  const driver = await openDriver(t, directory, reference, popupServer, {
    WebSocketImpl: recordFailedWrites(fates, new Set(), { guards }),
  });
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
