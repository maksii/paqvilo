import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSimulator } from '../api.mjs';
import { connectRuntime } from '../testing.mjs';
import {
  captureCdpUrl,
  captureThroughRuntime,
  captureShell,
  captureSummary,
  captureExitCode,
} from '../capture-shell.mjs';

const bin = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-capture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'portal/web-pages'), { recursive: true });
  await fs.writeFile(path.join(root, 'portal/website.yml'), 'adx_name: Invented\nadx_websiteid: invented\n');
  await fs.writeFile(
    path.join(root, 'portal/web-pages/home.webpage.yml'),
    'adx_name: Home\nadx_webpageid: home\nadx_partialurl: /\nadx_copy: <div>Home</div>\n',
  );
  await fs.writeFile(
    path.join(root, 'paqvilo.config.yml'),
    'sourceRoot: .\nsites:\n  invented:\n    source: portal\n    environments:\n      dev: https://invented.example.test\n',
  );
  return root;
}

// A live bridge serving a page with one stylesheet and one jQuery script; `extraHead` adds markup to the page.
function shellBridge(extraHead = '') {
  return {
    origin: 'https://invented.example.test',
    connected: false,
    configure(value) {
      if (value?.origin) this.origin = value.origin;
    },
    status() {
      return { connected: this.connected };
    },
    async connect() {
      this.connected = true;
      this.context = {};
      return this.status();
    },
    async close() {
      this.connected = false;
      this.context = null;
    },
    async request(route) {
      return {
        status: 200,
        headers: {
          'content-type': route === '/' ? 'text/html' : route.endsWith('.css') ? 'text/css' : 'text/javascript',
        },
        body: Buffer.from(
          route === '/'
            ? `<link rel="stylesheet" href="/theme.css"><script src="/jquery.js"></script>${extraHead}`
            : route.endsWith('.css')
              ? 'body{}'
              : 'window.jQuery={};',
        ),
      };
    },
  };
}

function runCli(args) {
  const child = spawn(process.execPath, [bin, ...args], { windowsHide: true });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
    child.once('error', reject);
  });
}

test('capture client preserves incomplete reports and other errors preserve the server message', async () => {
  const report = {
    shellProfile: {},
    captured: [],
    failures: [{ code: 'ASSET_HTTP', path: '/missing.css' }],
    complete: false,
    applied: false,
  };
  const client = await connectRuntime({
    origin: 'http://127.0.0.1:9999',
    fetchImpl: async (url) =>
      url.endsWith('/status')
        ? Response.json({})
        : url.includes('/state?')
          ? Response.json({ csrf: 'synthetic' })
          : url.endsWith('/assets/capture-shell')
            ? Response.json(report, { status: 409 })
            : Response.json({ error: { message: 'Synthetic conflict' } }, { status: 409 }),
  });
  assert.deepEqual(await client.captureShell('/'), report);
  await assert.rejects(client.liveDisconnect(), /409.*Synthetic conflict/);
  const empty = await connectRuntime({
    origin: 'http://127.0.0.1:9999',
    fetchImpl: async (url) =>
      url.endsWith('/status')
        ? Response.json({})
        : url.includes('/state?')
          ? Response.json({ csrf: 'synthetic' })
          : new Response('', { status: 409 }),
  });
  await assert.rejects(empty.captureShell('/'), /Local runtime request failed \(409\)/);
});

test('capture client has no default deadline, configurable deadlines identify the option, and ordinary calls remain bounded', async () => {
  const client = await connectRuntime({
    origin: 'http://127.0.0.1:8787',
    fetchImpl: async (url, options) => {
      if (!url.endsWith('/assets/capture-shell')) {
        assert.ok(options.signal);
        return Response.json(url.includes('/state?') ? { csrf: 'synthetic' } : {});
      }
      if (!options.signal) return Response.json({ applied: true });
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }),
      );
    },
  });
  assert.equal((await client.captureShell('/')).applied, true);
  // Keep the process alive while AbortSignal.timeout's unreferenced timer runs.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      client.captureShell('/', { timeoutMs: 10 }),
      (error) =>
        error.code === 'SHELL_CAPTURE_TIMEOUT' && /--timeout.*server may still be working/s.test(error.message),
    );
  } finally {
    clearTimeout(keepAlive);
  }
  await assert.rejects(client.captureShell('/', { timeoutMs: -1 }), /timeoutMs must/);
});

test('capture through a runtime disconnects after a capture failure and a failed disconnect does not mask the original error', async () => {
  const calls = [];
  const failing = {
    liveConnect: async () => calls.push('connect'),
    captureShell: async () => {
      calls.push('capture');
      throw new Error('Synthetic failure');
    },
    liveDisconnect: async () => calls.push('disconnect'),
  };
  await assert.rejects(captureThroughRuntime(failing, 'http://127.0.0.1:9222', '/'), /Synthetic/);
  assert.deepEqual(calls, ['connect', 'capture', 'disconnect']);
  const timeout = Object.assign(new Error('Capture timeout'), { code: 'SHELL_CAPTURE_TIMEOUT' });
  const both = {
    liveConnect: async () => {},
    captureShell: async () => {
      throw timeout;
    },
    liveDisconnect: async () => {
      throw new Error('Cleanup also timed out');
    },
  };
  await assert.rejects(
    captureThroughRuntime(both, 'http://127.0.0.1:9222', '/'),
    (actual) => actual === timeout && actual.disconnectFailed === true,
  );
});

test('a running-runtime capture waits without a deadline, reports progress every 15 s and disconnects', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-long-capture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'portal');
  await fs.mkdir(path.join(sourceDir, 'web-pages'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'website.yml'), 'adx_name: Synthetic\nadx_websiteid: synthetic\n');
  const calls = [];
  let answerCapture, captureArrived;
  const arrived = new Promise((resolve) => {
    captureArrived = resolve;
  });
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader('content-type', 'application/json');
    req.resume();
    if (req.url.endsWith('/status')) return res.end(JSON.stringify({ sourceDir }));
    if (req.url.includes('/state?'))
      return res.end(
        JSON.stringify({
          csrf: 'synthetic',
          config: { live: { origin: 'https://synthetic.example.test' } },
          status: { live: { connected: false } },
        }),
      );
    if (req.url.endsWith('/assets/capture-shell')) {
      answerCapture = () => res.end(JSON.stringify({ applied: true, ready: true, complete: true, failures: [] }));
      return captureArrived();
    }
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const config = path.join(root, 'paqvilo.config.json');
  await fs.writeFile(
    config,
    JSON.stringify({
      sourceRoot: '.',
      sites: {
        synthetic: {
          source: 'portal',
          environments: { dev: 'https://synthetic.example.test' },
          mirage: { port: server.address().port },
        },
      },
    }),
  );
  const realFetch = globalThis.fetch,
    captureSignals = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url).endsWith('/assets/capture-shell')) captureSignals.push(options?.signal);
    return realFetch(url, options);
  });
  // Only the progress interval and its clock are virtual; HTTP keeps real timers.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const progress = [];
  const pending = captureShell({ config, cdp: 'http://127.0.0.1:9222', onProgress: (event) => progress.push(event) });
  // A capture that fails before its request arrives fails the test instead of waiting for the test timeout.
  await Promise.race([arrived, pending]);
  for (let step = 0; step < 3; step++) t.mock.timers.tick(15000);
  answerCapture();
  const report = await pending;
  t.mock.timers.tick(30000);
  assert.deepEqual(
    progress,
    [0, 15000, 30000, 45000].map((elapsedMs) => ({
      site: 'synthetic',
      phase: elapsedMs ? 'waiting' : 'started',
      elapsedMs,
    })),
  );
  assert.deepEqual(captureSignals, [undefined]);
  assert.deepEqual(
    report.reports.map(({ site, env, applied, ready, complete }) => ({ site, env, applied, ready, complete })),
    [{ site: 'synthetic', env: 'dev', applied: true, ready: true, complete: true }],
  );
  assert.deepEqual(
    calls.filter((route) => /\/(?:live\/|assets\/capture-shell$)/.test(route)),
    ['/_sim/api/live/connect', '/_sim/api/assets/capture-shell', '/_sim/api/live/disconnect'],
  );
});

test('capture all chooses one safe environment per configured site and reports caution skips', async (t) => {
  const root = await project(t),
    config = path.join(root, 'paqvilo.config.yml');
  await fs.writeFile(
    config,
    'sourceRoot: .\nsites:\n  first:\n    source: portal\n    mirage: { port: 0 }\n    environments:\n      dev: https://invented.example.test\n      production: { url: https://production.example.test, caution: true }\n  second:\n    source: portal\n    mirage: { port: 0 }\n    environments:\n      dev: https://invented.example.test\n      production: { url: https://production.example.test, caution: true }\n',
  );
  const starts = [];
  const report = await captureShell({
    config,
    all: true,
    cdp: 'http://127.0.0.1:9222',
    createLocalSimulator: (options) => {
      starts.push(options.stateFile);
      return createSimulator({ ...options, liveBridge: shellBridge() }).then(async (app) => {
        if (starts.length === 1) {
          // Past rich text discovery's 20,000-object work bound.
          const state = app.store.snapshot();
          state.simulator.componentSchemas = {
            large: { fields: Array.from({ length: 25000 }, () => ({ name: 'synthetic' })) },
          };
          await app.store.replaceState(state);
        }
        return app;
      });
    },
  });
  assert.equal(report.complete, false);
  assert.equal(captureExitCode(report), 0);
  assert.equal(captureExitCode(report, { strict: true }), 1);
  assert.equal(report.reports[0].applied, true);
  assert.equal(report.reports[0].shellProfile.platformStyles.mode, 'captured');
  assert.equal(report.reports[0].richText.failures[0].code, 'RICHTEXT_SCHEMA_TRUNCATED');
  assert.equal(report.reports[1].complete, true);
  assert.deepEqual(
    report.reports.map((item) => [item.site, item.env]),
    [
      ['first', 'dev'],
      ['second', 'dev'],
    ],
  );
  assert.equal(new Set(starts).size, 2);
  assert.deepEqual(
    report.skipped.map((item) => [item.site, item.env]),
    [
      ['first', 'production'],
      ['second', 'production'],
    ],
  );
});

test('all-site capture retains a sanitized failure reason and continues other sites', async (t) => {
  const root = await project(t),
    config = path.join(root, 'paqvilo.config.yml');
  await fs.writeFile(
    config,
    'sourceRoot: .\nsites:\n  failed:\n    source: portal\n    mirage: { port: 0 }\n    environments: { dev: https://invented.example.test }\n  captured:\n    source: portal\n    mirage: { port: 0 }\n    environments: { dev: https://invented.example.test }\n',
  );
  let attempts = 0;
  const report = await captureShell({
    config,
    all: true,
    cdp: 'http://127.0.0.1:9222',
    createLocalSimulator: (options) => {
      if (++attempts === 1)
        throw Object.assign(
          new Error(
            'Synthetic service unavailable at https://user:private@invented.example.test/capture?token=private access_token=private',
          ),
          { status: 503, code: 'SYNTHETIC_UNAVAILABLE' },
        );
      return createSimulator({ ...options, liveBridge: shellBridge() });
    },
  });
  assert.equal(report.reports[1].applied, true, JSON.stringify(report.reports[1]));
  const failure = report.reports[0].failures[0];
  assert.match(failure.message, /Synthetic service unavailable/);
  assert.equal(failure.status, 503);
  assert.equal(failure.causeCode, 'SYNTHETIC_UNAVAILABLE');
  assert.equal(JSON.stringify(report).includes('private'), false);
});

test('capture exit status follows usable shells, with strict completeness available explicitly', () => {
  const report = {
    complete: false,
    reports: [
      {
        applied: true,
        ready: true,
        complete: false,
        failures: [{ code: 'SHELL_RESOURCE_ORIGIN', blocking: false }],
        richText: {
          complete: false,
          failures: [{ code: 'RICHTEXT_SCHEMA_TRUNCATED' }],
          diagnostics: [{ code: 'RICHTEXT_NATIVE_NOT_READY', message: 'Editor unavailable anonymously.' }],
        },
      },
    ],
  };
  assert.equal(captureExitCode(report), 0);
  assert.equal(captureExitCode(report, { strict: true }), 1);
  assert.match(captureSummary(report), /RICHTEXT_SCHEMA_TRUNCATED/);
  assert.match(captureSummary(report), /RICHTEXT_NATIVE_NOT_READY/);
  report.reports[0].failures.push({ blocking: true });
  assert.equal(captureExitCode(report), 1);
  assert.equal(captureExitCode({ reports: [] }), 1);
});

test('installed CLI accepts applied partial shells and strict mode rejects their incompleteness', async (t) => {
  const root = await project(t),
    config = path.join(root, 'paqvilo.config.yml');
  const bridge = shellBridge('<link rel="stylesheet" href="https://third-party.example.test/theme.css">');
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    origin: bridge.origin,
    stateFile: path.join(root, '.paqvilo/simulator/invented/state.json'),
    liveBridge: bridge,
    watch: false,
  });
  t.after(() => app.close());
  await fs.appendFile(config, `    mirage: { port: ${new URL(app.url).port} }\n`);
  // Sequential: one runtime accepts one live connection at a time.
  for (const strict of [false, true]) {
    const { code, stdout, stderr } = await runCli([
      'mirage',
      'capture-shell',
      '--config',
      config,
      '--site',
      'invented',
      '--cdp',
      'http://127.0.0.1:9222',
      ...(strict ? ['--strict'] : []),
    ]);
    assert.equal(code, strict ? 1 : 0, stderr);
    assert.equal(JSON.parse(stdout).reports[0].applied, true);
    assert.match(stderr, /Shell invented: capturing shell and editor resources/);
    assert.match(stderr, /observed SHELL_RESOURCE_ORIGIN/);
    assert.equal(bridge.connected, false);
  }
});

test('capture CLI prints failed resources, exits one and disconnects the running runtime', async (t) => {
  const root = await project(t),
    sourceDir = path.join(root, 'portal');
  const bridge = {
    origin: 'https://invented.example.test',
    connected: false,
    configure() {},
    status() {
      return { connected: this.connected };
    },
    async connect() {
      this.connected = true;
      this.context = {};
      return this.status();
    },
    async close() {
      this.connected = false;
      this.context = null;
    },
    async request(route) {
      return route === '/'
        ? {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: Buffer.from('<link rel="stylesheet" href="/missing.css"><script src="/jquery.js"></script>'),
          }
        : { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') };
    },
  };
  const app = await createSimulator({
    sourceDir,
    origin: bridge.origin,
    stateFile: path.join(root, '.paqvilo/simulator/invented/state.json'),
    watch: false,
    liveBridge: bridge,
  });
  t.after(() => app.close());
  const config = path.join(root, 'paqvilo.config.yml');
  await fs.appendFile(config, `    mirage: { port: ${new URL(app.url).port} }\n`);
  const { code, stdout, stderr } = await runCli([
    'mirage',
    'capture-shell',
    '--config',
    config,
    '--site',
    'invented',
    '--cdp',
    'http://127.0.0.1:9222',
    '--json',
  ]);
  assert.equal(code, 1, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.reports[0].applied, false);
  assert.ok(
    report.reports[0].failures.some(
      (item) => item.code === 'NATIVE_ASSET_HTTP' && item.path === '/missing.css' && !item.blocking,
    ),
  );
  assert.ok(report.reports[0].failures.some((item) => item.code === 'SHELL_JQUERY_MISSING' && item.blocking));
  assert.equal(bridge.connected, false);
  assert.match(captureSummary(report), /BLOCKING SHELL_JQUERY_MISSING[\s\S]*observed NATIVE_ASSET_HTTP/);
});

test('capture rejects untrusted CDP URLs, caution environments and absolute paths before launching a browser', async (t) => {
  assert.throws(() => captureCdpUrl('http://external.example.test:9222'), /loopback/);
  const root = await project(t);
  await fs.writeFile(
    path.join(root, 'paqvilo.config.local.yml'),
    'sites:\n  invented:\n    environments:\n      dev:\n        caution: true\n',
  );
  const launchBrowser = () => {
    throw new Error('Browser should not launch');
  };
  await assert.rejects(
    captureShell({ config: path.join(root, 'paqvilo.config.yml'), site: 'invented', launchBrowser }),
    /caution/,
  );
  await assert.rejects(
    captureShell({
      config: path.join(root, 'paqvilo.config.yml'),
      path: 'https://external.example.test/',
      launchBrowser,
    }),
    /relative/,
  );
});

test('offline shell capture writes state and matching runtime capture uses its API exclusively', async (t) => {
  const root = await project(t),
    calls = [];
  const bridge = {
    origin: 'https://invented.example.test',
    connected: false,
    configure(value) {
      this.origin = value.origin;
    },
    status() {
      return { connected: this.connected, origin: this.origin };
    },
    async connect() {
      this.connected = true;
      this.context = {};
      calls.push('connect');
      return this.status();
    },
    async close() {
      this.connected = false;
      this.context = null;
      calls.push('disconnect');
    },
    async request(route) {
      calls.push(route);
      return route === '/'
        ? {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: Buffer.from(
              '<html><head><link rel="stylesheet" href="/theme.css"><script src="/jquery.min.js"></script></head><body>Invented</body></html>',
            ),
          }
        : {
            status: 200,
            headers: { 'content-type': route.endsWith('.css') ? 'text/css' : 'text/javascript' },
            body: Buffer.from(route.endsWith('.css') ? 'body{color:blue}' : 'window.jQuery={};'),
          };
    },
  };
  const config = path.join(root, 'paqvilo.config.yml');
  // Port 0: the capture must not probe a developer's runtime on the default port 8787.
  await fs.appendFile(config, '    mirage:\n      port: 0\n');
  const report = await captureShell({
    config,
    site: 'invented',
    cdp: 'http://127.0.0.1:9222',
    createLocalSimulator: (options) => createSimulator({ ...options, liveBridge: bridge }),
  });
  assert.equal(report.complete, true);
  const stateFile = path.join(root, '.paqvilo/simulator/invented/state.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(state.simulator.shellProfile.platformStyles.mode, 'captured');
  assert.equal(bridge.connected, false);
  assert.ok(calls.includes('connect') && calls.includes('/theme.css'));
  const simulator = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    stateFile,
    origin: bridge.origin,
    liveBridge: bridge,
    watch: false,
  });
  try {
    await fs.writeFile(
      config,
      (await fs.readFile(config, 'utf8')).replace('port: 0', `port: ${new URL(simulator.url).port}`),
    );
    const result = await captureShell({
      config,
      site: 'invented',
      cdp: 'http://127.0.0.1:9222',
      createLocalSimulator: () => {
        throw new Error('Must use running runtime');
      },
    });
    assert.equal(result.complete, true);
    assert.equal(bridge.connected, false);
    assert.equal(simulator.state().status.platformStyles.mode, 'captured');
    const missing = await connectRuntime({ origin: simulator.url });
    assert.deepEqual((await missing.status()).platformStyles.missingHeadStylesheets, []);
    await fs.writeFile(
      config,
      `sourceRoot: .\nsites:\n  invented:\n    source: portal\n    defaultEnv: other\n    mirage: { port: ${new URL(simulator.url).port} }\n    environments:\n      other: https://other.example.test\n      dev: https://invented.example.test\n      production: { url: https://production.example.test, caution: true }\n`,
    );
    const all = await captureShell({
      config,
      all: true,
      cdp: 'http://127.0.0.1:9222',
      createLocalSimulator: () => {
        throw new Error('Must use running runtime');
      },
    });
    assert.equal(all.complete, true);
    assert.equal(all.reports[0].env, 'dev');
    assert.ok(all.skipped.some((item) => item.env === 'other' && item.reason.includes('running runtime')));
  } finally {
    await simulator.close();
  }
});

test('runtime applies a bundled-jQuery shell despite verified native stylesheet defects', async (t) => {
  const root = await project(t),
    bundle = '/resource/powerappsportal/dist/preform.BootstrapV5.moment_2_29_4.bundle-abcdef.js';
  const assets = {
    '/': [
      'text/html',
      `<link rel="stylesheet" href="/bad.css"><link rel="stylesheet" href="/style.css"><script src="${bundle}"></script>`,
    ],
    '/bad.css': ['text/html', '<html>Not CSS</html>'],
    '/style.css': ['text/css', 'a{background:url(%22images%2Fmissing.png%22)}'],
    [bundle]: ['application/javascript', 'window.jQuery=window.$={fn:{jquery:"3.6.2"}};'],
  };
  const bridge = {
    ...shellBridge(),
    async request(route) {
      const entry = assets[route];
      return {
        status: entry ? 200 : 404,
        headers: { 'content-type': entry?.[0] ?? 'text/plain' },
        body: Buffer.from(entry?.[1] ?? 'Not found'),
      };
    },
  };
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    origin: bridge.origin,
    stateFile: path.join(root, 'state.json'),
    watch: false,
    liveBridge: bridge,
  });
  t.after(() => app.close());
  const client = await connectRuntime({ origin: app.url });
  const report = await captureThroughRuntime(client, 'http://127.0.0.1:9222', '/');
  assert.equal(report.applied, true);
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.failures.map(({ code, path, nativeOriginFailed, blocking }) => ({
      code,
      path,
      nativeOriginFailed,
      blocking,
    })),
    [
      { code: 'NATIVE_ASSET_CONTENT_TYPE', path: '/bad.css', nativeOriginFailed: true, blocking: false },
      { code: 'NATIVE_ASSET_HTTP', path: '/%22images%2Fmissing.png%22', nativeOriginFailed: true, blocking: false },
    ],
  );
  assert.equal(app.state().config.shellProfile.jquery.source, bundle);
  assert.equal((await client.status()).platformStyles.mode, 'captured');
  assert.equal(bridge.connected, false);
});
