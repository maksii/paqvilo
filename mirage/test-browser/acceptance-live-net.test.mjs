// @test-kind security: runAcceptance stops a live flow's popup writes with its write net even when another debugging client resumes the popups before the flow's page guard, and removes the net when the flow ends
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { wsServer as WebSocketServer } from 'playwright-core/lib/utilsBundle';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSelfSignedCertificate } from '../lib/dataverse-tls.mjs';
import { ownedFixture, makeTemporaryDirectory, removeFixtureDirectory } from '../testing/owned-fixture.mjs';
import { runAcceptance } from '../acceptance.mjs';
import { closeServer, devToolsActivePort, openResumingClient } from './shared-browser.mjs';

const POPUP_WRITES = ['/form-save', '/popup-save'];
const AFTER_WRITE = '/after-save';

// The flow's page posts a form into a new window and opens a popup whose script posts by fetch. The page also keeps a
// read (`/gate`) in flight until both popup writes have a fate, so the flow, and with it the net, runs until then.
const PAGES = {
  '/': `<!doctype html><title>Flow</title><main>Flow page</main>
<form id="save" method="post" action="/form-save" target="form-popup"><input name="a" value="1"></form>
<script>
document.getElementById('save').submit();
window.open('/popup', 'popup');
fetch('/gate');
</script>`,
  '/popup': `<!doctype html><title>Popup</title><script>
fetch('/popup-save', { method: 'POST', body: 'x' }).catch(() => {});
</script>`,
  '/other': '<!doctype html><title>Other tab</title><main>Other tab</main>',
};

/** Launches a headless browser whose only identity is the persistent context, with a loopback debugging port. */
async function launchAttachedBrowser(profile) {
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
        // The live origin is a loopback HTTPS fixture whose certificate is made for this test.
        '--ignore-certificate-errors',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      ],
    }),
  );
  const port = await devToolsActivePort(profile);
  return { context, cdpUrl: `http://127.0.0.1:${port}` };
}

/**
 * The debugging endpoint the run connects through (its Playwright client and its write net). It holds each
 * `Fetch.enable` sent on a popup's session, which is the run's page guard for that popup and, with it, Playwright's own
 * resume of the popup, until `released` settles; the popup is then resumed only by the other debugging client and the
 * page guard is late for every popup write. A browser-session `Fetch.failRequest`, the net's answer, resolves the fate of
 * the write it names as blocked by the net. `paused` collects the path of every request paused for any client.
 */
async function holdingEndpoint(browserSocketUrl, released, fates) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(server, 'listening');
  const paused = new Set();
  const sockets = new Set();
  server.on('connection', (down) => {
    const up = new WebSocket(browserSocketUrl);
    const opened = once(up, 'open');
    const popupSessions = new Set();
    const pausedPaths = new Map();
    sockets.add(down);
    sockets.add(up);
    up.addEventListener('message', (event) => {
      const { method, params, sessionId } = JSON.parse(event.data);
      if (method === 'Target.attachedToTarget' && params.targetInfo.openerId) popupSessions.add(params.sessionId);
      if (method === 'Fetch.requestPaused') {
        const pathname = new URL(params.request.url).pathname;
        paused.add(pathname);
        pausedPaths.set(`${sessionId ?? 'browser'}:${params.requestId}`, pathname);
      }
      if (down.readyState === down.OPEN) down.send(event.data);
    });
    down.on('message', (data) => {
      const text = String(data);
      const { method, params, sessionId } = JSON.parse(text);
      if (method === 'Fetch.failRequest' && !sessionId)
        fates.get(pausedPaths.get(`browser:${params.requestId}`))?.resolve('blocked by the net');
      const held = method === 'Fetch.enable' && popupSessions.has(sessionId) ? released : null;
      Promise.all([opened, held]).then(() => {
        if (up.readyState === WebSocket.OPEN) up.send(text);
      });
    });
    const end = () => {
      down.close();
      up.close();
    };
    down.on('close', end);
    up.addEventListener('close', end);
    up.addEventListener('error', end);
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}/devtools/browser/held`,
    paused,
    async close() {
      for (const socket of sockets) socket.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a live acceptance flow stops the writes of popups another debugging client resumes, and removes its net after the flow', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-acceptance-live-net-'));
  const fates = new Map([...POPUP_WRITES, AFTER_WRITE].map((write) => [write, Promise.withResolvers()]));
  const posts = [];
  const { key, cert } = createSelfSignedCertificate({ hosts: ['127.0.0.1'] });
  const live = https.createServer({ key, cert }, (req, res) => {
    const { pathname } = new URL(req.url, 'https://fixture');
    if (pathname === '/gate') {
      Promise.all(POPUP_WRITES.map((write) => fates.get(write).promise)).then(() => res.end('ok'));
      return;
    }
    if (req.method !== 'GET') {
      posts.push(pathname);
      fates.get(pathname)?.resolve('reached');
      res.writeHead(200).end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGES[pathname] ?? '<!doctype html><title>Other</title>');
  });
  live.listen(0, '127.0.0.1');
  await once(live, 'listening');
  const liveOrigin = `https://127.0.0.1:${live.address().port}`;
  // A live-only run still reads the local simulator's state before and after its flows.
  const state = {
    config: { mode: 'local', pageMode: 'local', endpoints: [] },
    status: { sourceFingerprint: 'synthetic', implementationFingerprint: 'synthetic' },
  };
  const simulator = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(state));
  });
  simulator.listen(0, '127.0.0.1');
  await once(simulator, 'listening');

  const { context: owner, cdpUrl } = await launchAttachedBrowser(path.join(directory, 'profile'));
  const resuming = await openResumingClient(cdpUrl);
  const { webSocketDebuggerUrl } = await (await fetch(new URL('/json/version', cdpUrl))).json();
  const popupFates = Promise.all(POPUP_WRITES.map((write) => fates.get(write).promise));
  const endpoint = await holdingEndpoint(webSocketDebuggerUrl, popupFates, fates);
  ownedFixture(t).add(async () => {
    await endpoint.close();
    await resuming.close();
    await owner.close();
    await closeServer(live);
    await closeServer(simulator);
    await removeFixtureDirectory(directory);
  });
  // A tab of the live origin open before the run, as in the user's browser.
  await (await owner.newPage()).goto(`${liveOrigin}/other`);

  const result = await runAcceptance({
    localUrl: `http://127.0.0.1:${simulator.address().port}`,
    liveOrigin: liveOrigin + '/',
    cdpUrl: endpoint.url,
    outputDir: path.join(directory, 'evidence'),
    timeout: 120_000,
    flows: [{ name: 'Live popups', mode: 'live', steps: [{ action: 'navigate', path: '/' }] }],
  });

  assert.equal(result.error, undefined, 'the run itself completed');
  assert.deepEqual(
    Object.fromEntries(await Promise.all(POPUP_WRITES.map(async (write) => [write, await fates.get(write).promise]))),
    { '/form-save': 'blocked by the net', '/popup-save': 'blocked by the net' },
    'each popup write was stopped by the flow net while the page guard of the popups was held',
  );
  assert.deepEqual(posts, [], 'the server saw no write of the flow');
  const [flow] = result.flows;
  assert.equal(flow.mode, 'live-read-only');
  assert.deepEqual(
    flow.blockedRequests.toSorted((a, b) => a.url.localeCompare(b.url)),
    POPUP_WRITES.map((write) => ({ method: 'POST', url: liveOrigin + write })),
    'the live flow reports each blocked write by method and redacted URL',
  );

  // The run is over: a write of a new tab reaches the server and no client of the run paused it on the way.
  const after = await owner.newPage();
  await after.goto(`${liveOrigin}/other`);
  await after.evaluate(() => fetch('/after-save', { method: 'POST', body: 'x' }).then(() => 'sent'));
  assert.equal(
    await fates.get(AFTER_WRITE).promise,
    'reached',
    'a write of a new tab reaches the server after the run',
  );
  assert.ok(!endpoint.paused.has(AFTER_WRITE), 'no debugging client of the run paused a request after the run');
});
