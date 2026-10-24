import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
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
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

async function fixture(t) {
  const owner = ownedFixture(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-dev-close-'));
  const source = createFixture();
  owner.remove(() => source.cleanup());
  owner.remove(() => fs.rm(directory, { recursive: true, force: true }));
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
  };
}

for (const attached of [false, true]) {
  test(
    `a failed new target preserves two healthy drafts, the agent and retry (${attached ? 'attached' : 'owned'})`,
    { timeout: 30000 },
    async (t) => {
      const { owner, origin, context, selection } = await fixture(t);
      const logs = [];
      let stopped = false;
      const runtime = await startDevSessions(context, selection, {
        attached,
        stop: () => {
          stopped = true;
        },
        log: (line) => logs.push(line),
      });
      owner.add(() => runtime.close());
      const healthy = [await context.newPage(), await context.newPage()];
      for (const [index, page] of healthy.entries()) {
        await page.goto(origin);
        await page.waitForLoadState('networkidle');
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
      await assert.rejects(
        fetch(record.agent.endpoint + '/v1/session', {
          signal: AbortSignal.timeout(1000),
        }),
        /fetch failed/,
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
  const { owner, directory, config, origin } = await fixture(t);
  const preload = new URL('./helpers/browser-loopback-preload.mjs', import.meta.url).href;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:PAQVILO_|GIT_)/.test(key) &&
        !['NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'].includes(key),
    ),
  );
  env.PAQVILO_TEST_LOOPBACK_PROXY = origin;
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const debugPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
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
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-32000);
    });
  const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  child.on('error', () => {}); // Abort is owned by the test deadline; close is still awaited.
  let discovery, blocker, remoteBrowser;
  owner.add(async () => {
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
    await closed;
    if (blocker) await fs.rmdir(blocker);
  });
  owner.add(() => remoteBrowser?.close());
  const agentDir = path.join(directory, '.paqvilo', 'agents');
  const deadline = Date.now() + 15000;
  while (!discovery && Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'actual dev must reach its agent startup');
    try {
      const name = (await fs.readdir(agentDir)).find((name) => name.endsWith('.json'));
      if (name) {
        blocker = path.join(agentDir, name);
        discovery = JSON.parse(await fs.readFile(blocker, 'utf8'));
      }
    } catch {
      /* the first discovery write may still be in flight */
    }
    if (!discovery) await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(
    discovery,
    'actual CLI published its owned agent: ' + output.replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]').slice(-4000),
  );
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
  assert.equal(output.includes(discovery.token), false, 'discovery credentials must not enter diagnostics');
  assert.match(output, /EISDIR|EPERM|directory/);
  assert.equal(remoteBrowser.isConnected(), false, 'the exact owned browser disconnected');
});
