import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import chokidar from 'chokidar';
import { createFixture } from '../test/fixture.mjs';
import { loadDevTargets } from '../lense/config.mjs';
import { startDevSessions } from '../lense/dev-sessions.mjs';
import { readDiscovery } from '../lense/commands/agent.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { openBrowser } from '../lense/browser.mjs';
import { createCdpFaultProxy } from './helpers/cdp-fault-proxy.mjs';

import { servesAgentSession } from './helpers/agent-endpoint.mjs';
import { childOutput } from './helpers/child-output.mjs';
import { PROFILE_RELEASE_RETRIES } from './helpers/profile-cleanup.mjs';
import { freeDebugPort } from './helpers/debug-port.mjs';

async function fixture(t) {
  const owner = ownedFixture(t);
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-dev-close-'));
  const source = createFixture();
  owner.remove(() => source.cleanup());
  // The actual-CLI case keeps its owned browser profile in this directory.
  owner.remove(() => fs.rm(directory, { recursive: true, force: true, ...PROFILE_RELEASE_RETRIES }));
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith('/')) return response.writeHead(403).end();
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><title>Owned close fixture</title><p>Synthetic portal</p>');
  });
  // The rejecting fixture proxy can receive a peer reset when its owned browser
  // shuts down. Keep that allowance at the socket boundary; other errors fail.
  server.on('connection', (socket) =>
    socket.on('error', (error) => {
      if (!['ECONNRESET', 'EPIPE'].includes(error.code)) server.emit('error', error);
    }),
  );
  server.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  owner.add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = path.join(directory, 'paqvilo.config.yml');
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  await fs.writeFile(
    config,
    JSON.stringify({
      defaultSite: 'synthetic',
      panel: false,
      browser: { channel, headless: true, profileDir: 'profiles' },
      sites: {
        synthetic: { source: source.dir, environments: { dev: origin } },
      },
    }),
  );
  const browserOptions = {
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    proxy: { server: origin, bypass: '127.0.0.1,localhost' },
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ],
  };
  const browser = await chromium.launch(browserOptions);
  owner.add(() => browser.close());
  const context = await browser.newContext();
  const selection = await loadDevTargets({ config }, {});
  return {
    owner,
    directory,
    config,
    origin,
    context,
    selection,
    browserOptions,
    source,
  };
}

test(
  'owned browser isolates real wire timeouts in tabs and popups, cancellation, retry and transport loss',
  { timeout: 60000 },
  async (t) => {
    const { owner, origin, selection, browserOptions, source } = await fixture(t);
    const debugPort = await freeDebugPort();
    const launch = chromium.launchPersistentContext;
    // Network confinement only; the fault is injected by the independent proxy.
    t.mock.method(chromium, 'launchPersistentContext', (profile, options) =>
      launch.call(chromium, profile, {
        ...options,
        proxy: browserOptions.proxy,
        args: [...options.args, ...browserOptions.args],
      }),
    );
    const owned = await openBrowser(selection.initial, { headless: true, debugPort });
    owner.add(() => owned.close());
    assert.equal(owned.attached, false);
    const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json());
    const proxy = await createCdpFaultProxy(version.webSocketDebuggerUrl, t.signal);
    owner.add(() => proxy.close());
    const browser = await chromium.connectOverCDP(proxy.endpoint);
    owner.add(() => browser.close());
    const context = browser.contexts()[0],
      logs = [];
    const stopped = Promise.withResolvers();
    const runtime = await startDevSessions(context, selection, {
      attached: owned.attached,
      debugPort,
      stop: () => stopped.resolve(),
      log: (line) => logs.push(line),
    });
    owner.add(() => runtime.close());
    // These are the same owner stop events used by the development CLI.
    browser.once('disconnected', () => stopped.resolve());
    context.once('close', () => stopped.resolve());
    const healthy = [];
    for (let index = 0; index < 2; index++) {
      const ready = proxy.nextAck('Fetch.enable');
      const page = await context.newPage();
      await ready;
      await page.goto(origin);
      assert.match(await page.evaluate(() => fetch('/scripts/app.js').then((r) => r.text())), /console\.log\("app"\)/);
      await page.evaluate((index) => {
        document.body.innerHTML += '<input id="draft">';
        document.getElementById('draft').value = 'unsaved-' + index;
      }, index);
      healthy.push(page);
    }
    const record = runtime.active.get(origin);
    const discovery = await readDiscovery(record.agent.discoveryFile);
    const agentRead = async (path) => {
      const response = await fetch(discovery.endpoint + path, {
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${discovery.token}` },
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    // Cancel an actually stalled initializer before its deadline. Teardown must
    // neither report a successful target nor poison the next attachment.
    const cancelling = proxy.arm();
    const cancelled = await context.newPage();
    await cancelling;
    await cancelled.close();
    for (const popup of [false, true]) {
      const fault = proxy.arm();
      let failed;
      if (popup) {
        const opening = healthy[0].waitForEvent('popup');
        await healthy[0].evaluate((origin) => window.open(origin + '/popup'), origin);
        failed = await opening;
      } else failed = await context.newPage();
      const dropped = await fault;
      assert.equal(dropped.method, 'Page.getFrameTree');
      if (!failed.isClosed()) await failed.waitForEvent('close');
      assert.equal(runtime.failure, undefined);
      assert.equal(runtime.active.size, 1);
      assert.equal(browser.isConnected(), true);
      for (const [index, page] of healthy.entries()) {
        assert.equal(page.isClosed(), false);
        assert.equal(await page.locator('#draft').inputValue(), 'unsaved-' + index);
        assert.match(
          await page.evaluate(() => fetch('/scripts/app.js').then((r) => r.text())),
          /console\.log\("app"\)/,
        );
      }
      await agentRead('/v1/session');
      const events = await agentRead('/v1/events?after=0&limit=500');
      assert.equal(typeof events.nextSequence, 'number');
      assert.equal(events.dropped, 0);
    }
    assert.equal(proxy.dropped.length, 3, 'one actual unanswered command per cancelled/tab/popup initializer');
    assert.equal(logs.filter((line) => line.includes('Page.getFrameTree did not answer within 10000 ms')).length, 2);
    // Live JS saves intentionally reload pages. Turn that user option off before
    // testing watcher/retry continuity with unsaved drafts still present.
    record.session.liveReload = false;
    const refreshed = once(record.session, 'refreshed', { signal: t.signal });
    source.write('web-files/app.js', 'window.fixtureRevision = "v2";');
    await refreshed;
    const retryReady = proxy.nextAck('Fetch.enable');
    const retry = await context.newPage();
    await retryReady;
    await retry.goto(origin);
    await retry.evaluate(async () => {
      const script = document.createElement('script');
      script.src = '/scripts/app.js';
      const done = new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = reject;
      });
      document.body.append(script);
      await done;
    });
    assert.equal(await retry.evaluate(() => window.fixtureRevision), 'v2');
    await agentRead('/v1/pages');
    for (const [index, page] of healthy.entries())
      assert.equal(await page.locator('#draft').inputValue(), 'unsaved-' + index);
    assert.equal(
      logs.some((line) => line.includes(discovery.token)),
      false,
    );
    const disconnected = once(browser, 'disconnected', { signal: t.signal });
    proxy.disconnect();
    await Promise.all([stopped.promise, disconnected]);
    assert.equal(browser.isConnected(), false, 'actual shared transport loss reaches the owner stop path');
    await runtime.close();
    assert.equal(runtime.active.size, 0);
    assert.deepEqual(Object.keys(record.watcher.getWatched()), []);
    await assert.rejects(fs.access(record.agent.discoveryFile), { code: 'ENOENT' });
  },
);

for (const attached of [false, true]) {
  test(
    `a failed new target preserves two healthy drafts, the agent and retry (${attached ? 'attached' : 'owned'})`,
    { timeout: 30000 },
    async (t) => {
      const { owner, origin, context, selection } = await fixture(t);
      const logs = [];
      let stopped = false;
      // Open the healthy tabs before startup so their interception is installed before they
      // navigate; a tab opened afterwards can need a late repair reload that would replace a
      // draft typed too early. Only the failing tab is new to the running session.
      const healthy = [await context.newPage(), await context.newPage()];
      const runtime = await startDevSessions(context, selection, {
        attached,
        stop: () => {
          stopped = true;
        },
        log: (line) => logs.push(line),
      });
      owner.add(() => runtime.close());
      for (const [index, page] of healthy.entries()) {
        await page.goto(origin);
        await page.evaluate((value) => {
          const input = document.createElement('input');
          input.id = 'draft';
          input.value = value;
          document.body.append(input);
        }, `unsaved-${index}`);
      }
      const original = context.newCDPSession.bind(context);
      let injected = false;
      let retryReady;
      const retrySetup = new Promise((resolve) => {
        retryReady = resolve;
      });
      t.mock.method(context, 'newCDPSession', async (page) => {
        const cdp = await original(page);
        if (!injected && !healthy.includes(page)) {
          injected = true;
          const send = cdp.send.bind(cdp);
          cdp.send = (method, params) =>
            method === 'Page.getFrameTree'
              ? Promise.reject(new Error('Page.getFrameTree did not answer within 10000 ms'))
              : method === 'Fetch.disable' && !attached
                ? new Promise(() => {})
                : send(method, params);
        } else if (injected && !healthy.includes(page)) {
          const send = cdp.send.bind(cdp);
          cdp.send = async (method, params) => {
            const result = await send(method, params);
            if (method === 'Fetch.enable') retryReady();
            return result;
          };
        }
        return cdp;
      });
      const failed = await context.newPage();
      if (attached) await failed.waitForFunction(() => document.title === 'Local preview unavailable');
      else if (!failed.isClosed()) await failed.waitForEvent('close');
      assert.equal(stopped, false);
      assert.equal(runtime.failure, undefined);
      assert.equal(runtime.active.size, 1);
      assert.ok(logs.some((line) => line.includes('Healthy tabs remain active')));
      for (const [index, page] of healthy.entries()) {
        assert.equal(await page.locator('#draft').inputValue(), `unsaved-${index}`);
        assert.match(
          await page.evaluate(() => fetch('/scripts/app.js').then((response) => response.text())),
          /console\.log\("app"\)/,
        );
      }
      const record = runtime.active.get(origin);
      if (!attached) {
        const discovery = await readDiscovery(record.agent.discoveryFile);
        assert.equal(discovery.endpoint, record.agent.endpoint);
        const status = await fetch(`${discovery.endpoint}/v1/session`, {
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${discovery.token}` },
        });
        try {
          assert.equal(status.status, 200);
        } finally {
          await status.body?.cancel();
        }
      }
      const retry = await context.newPage();
      await retrySetup;
      await retry.goto(origin);
      assert.match(
        await retry.evaluate(() => fetch('/scripts/app.js').then((response) => response.text())),
        /console\.log\("app"\)/,
      );
      assert.equal(
        healthy.every((page) => !page.isClosed()),
        true,
      );
    },
  );
}

for (const multiple of [false, true]) {
  test(
    `development teardown exposes actual agent filesystem failure and drains remaining owners (${multiple ? 'multiple causes' : 'single cause'})`,
    { timeout: 30000 },
    async (t) => {
      const { owner, origin, context, selection } = await fixture(t);
      const pageListeners = context.listenerCount('page');
      const runtime = await startDevSessions(context, selection, {
        log: () => {},
      });
      const record = runtime.active.get(origin);
      const discovery = record.agent.discoveryFile;
      const logFailure = new Error('Invented synchronous log cleanup failure');
      let expectedFailure;
      owner.add(async () => {
        // The blocker is entirely owned by this fixture. Preserve genuine cleanup
        // faults while accepting only the exact failure asserted by this test.
        await fs.rmdir(discovery);
        try {
          await runtime.close();
        } catch (cause) {
          if (cause !== expectedFailure) throw cause;
        }
      });
      const credentials = await readDiscovery(discovery);
      await fs.unlink(discovery);
      await fs.mkdir(discovery);
      const stopLogs = record.stopLogs;
      if (multiple)
        record.stopLogs = () => {
          stopLogs();
          throw logFailure;
        };
      let watcherClosed = false;
      const closeWatcher = record.watcher.close.bind(record.watcher);
      owner.add(async () => {
        // Also drain directly if a counterfactual runtime abandons this record
        // after a synchronous stop callback failure.
        await closeWatcher();
        try {
          await record.agent.close();
        } catch (cause) {
          if (!/EISDIR|EPERM/.test(cause.code ?? '')) throw cause;
        }
      });
      record.watcher.close = async () => {
        await closeWatcher();
        watcherClosed = true;
      };
      let failure;
      try {
        await runtime.close();
      } catch (cause) {
        failure = cause;
      }
      expectedFailure = failure;
      assert.ok(failure, 'cleanup failure must not become successful runtime completion');
      let agentFailure;
      try {
        await record.agent.close();
      } catch (cause) {
        agentFailure = cause;
      }
      assert.match(agentFailure.code, /EISDIR|EPERM/);
      if (multiple) {
        assert.ok(failure instanceof AggregateError);
        assert.deepEqual(failure.errors, [logFailure, agentFailure]);
      } else assert.equal(failure, agentFailure, 'one original error remains unchanged');
      assert.equal(
        runtime.failure instanceof AggregateError
          ? runtime.failure.errors.includes(agentFailure)
          : runtime.failure === agentFailure,
        true,
        'failure remains observable after records are removed',
      );
      assert.equal(watcherClosed, true);
      assert.equal(runtime.active.size, 0);
      assert.equal(context.listenerCount('page'), pageListeners);
      assert.equal(record.session.eventNames().length, 0);
      assert.equal(
        await servesAgentSession(credentials),
        false,
        'the failed remover must not leave its HTTP listener open',
      );
      await assert.rejects(runtime.close(), (cause) => cause === failure);
    },
  );
}

test(
  'development initialization preserves its primary failure and a separate real watcher cleanup failure',
  { timeout: 30000 },
  async (t) => {
    const { owner, context, selection } = await fixture(t);
    const primary = new Error('Invented source reconciliation failure');
    const cleanup = new Error('Invented watcher close failure');
    const create = OverlaySession.create;
    t.mock.method(OverlaySession, 'create', async function (...args) {
      const session = await create.apply(this, args);
      session.reconcile = () => {
        throw primary;
      };
      return session;
    });
    const originalWatch = chokidar.watch;
    const watches = [];
    t.mock.method(chokidar, 'watch', function (...args) {
      const watcher = originalWatch.apply(this, args);
      const close = watcher.close.bind(watcher);
      const first = watches.length === 0;
      watches.push({ watcher, close });
      watcher.close = async () => {
        await close();
        if (first) throw cleanup;
      };
      return watcher;
    });
    owner.add(async () => {
      for (const entry of watches) await entry.close();
    });
    const listeners = context.listenerCount('page');
    await assert.rejects(startDevSessions(context, selection, { log: () => {} }), (cause) => {
      assert.ok(cause instanceof AggregateError);
      assert.deepEqual(cause.errors, [primary, cleanup]);
      return true;
    });
    assert.ok(watches.length > 0);
    for (const entry of watches) assert.deepEqual(Object.keys(entry.watcher.getWatched()), []);
    assert.equal(context.listenerCount('page'), listeners);
  },
);

test('actual development CLI exits nonzero after agent filesystem cleanup failure', { timeout: 30000 }, async (t) => {
  const { owner, config, origin } = await fixture(t);
  const preload = new URL('./helpers/browser-loopback-preload.mjs', import.meta.url).href;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:PAQVILO_|GIT_)/.test(key) &&
        !['NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'].includes(key),
    ),
  );
  env.PAQVILO_TEST_LOOPBACK_PROXY = origin;
  const debugPort = await freeDebugPort();
  const child = spawn(
    process.execPath,
    ['--import', preload, 'lense/cli.mjs', 'dev', '--config', config, '--headless', '--debug-port', String(debugPort)],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env,
      signal: t.signal,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output = childOutput(child, { limit: 32000 });
  const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  child.on('error', () => {}); // Abort is owned by the test deadline; close is still awaited.
  let blocker, remoteBrowser;
  owner.add(async () => {
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
    await closed;
    if (blocker) await fs.rmdir(blocker);
  });
  owner.add(() => remoteBrowser?.close());
  // dev prints the discovery path once the file is completely written.
  const [, advertised] = await output.waitFor(/^agent API\s+.+?: (.+\.json)\s*$/m, {
    timeoutMs: 15_000,
    label: 'actual dev must reach its agent startup',
  });
  blocker = advertised;
  const discovery = JSON.parse(await fs.readFile(blocker, 'utf8'));
  assert.equal(discovery.pid, child.pid, 'the blocker belongs to this exact CLI child');
  await fs.unlink(blocker);
  await fs.mkdir(blocker);
  // Browser closure is the documented stop path for the exact dedicated
  // browser launched above. Discovery credentials never enter a network call.
  remoteBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const ownedPage = remoteBrowser.contexts()[0].pages()[0];
  await ownedPage.waitForFunction((expected) => location.origin === expected, origin);
  const protocol = await remoteBrowser.newBrowserCDPSession();
  await protocol.send('Browser.close');
  assert.equal(await closed, 1, 'actual CLI must report unsuccessful shutdown');
  assert.equal(output.text.includes(discovery.token), false, 'discovery credentials must not enter diagnostics');
  assert.match(output.text, /EISDIR|EPERM|directory/);
  assert.equal(remoteBrowser.isConnected(), false, 'the exact owned browser disconnected');
});
