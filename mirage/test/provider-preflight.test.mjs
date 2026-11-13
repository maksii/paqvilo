// @test-kind contract: Paqvilo's provider readiness designed to wait for the provider's own answer, bounded only by a caller's timeout
// Provider readiness: an instantiated storage provider or message bus is satisfied only when its optional
// preflight() answers { ready: true } (within the caller's timeout, when it gives one, and the idle guard otherwise); without preflight() it is declared (placeholder), never satisfied, offline
// and live. preflight({ packs }) reads module paths as createSimulator does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createSimulator } from '../api.mjs';
import { preflight } from '../lib/capability-report.mjs';
import { providerRequirements } from '../lib/organization-host.mjs';
import {
  PREFLIGHT_IDLE_TIMEOUT_MS,
  assertProvider,
  guardProvider,
  preflightProvider,
  requestBound,
} from '../lib/storage-provider.mjs';
import { createMemoryStorage } from '../lib/storage-memory.mjs';
import { createLocalDiskStorage } from '../lib/storage-local-disk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { calledFrom } from './support/timer-origin.mjs';

const MEMORY = new URL('../lib/storage-memory.mjs', import.meta.url).href;

async function fixture(t, packSource) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'provider-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'solution', 'Other'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'solution', 'Other', 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>InventedReadiness</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  await fs.writeFile(path.join(root, 'pack.mjs'), packSource);
  return {
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    simulation: { level: 'dry-run' },
    packs: [path.join(root, 'pack.mjs')],
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    providers: {
      storage: { remote: { kind: 'pack:fx-ready/blob' } },
      messaging: { relay: { kind: 'pack:fx-ready/bus' } },
    },
  };
}

const PACK = (storage, bus) => `import { createMemoryStorage } from '${MEMORY}';
export default { id: 'fx-ready', name: 'Invented', description: 'Invented', matches: () => true, presets: () => ({}),
  storageProviders: { blob: ({ id }) => { const provider = createMemoryStorage({ id }); ${storage} return provider; } },
  messageProviders: { bus: () => ({ descriptor: { id: 'relay', kind: 'invented' }, send: async () => {} ${bus} }) } };`;

const row = (report, id) => report.requirements.find((item) => item.id === id);

async function bothReports(options) {
  const offline = await preflight({ ...options, env: {} });
  const sim = await createSimulator({ ...options, port: 0, watch: false });
  try {
    return { offline, live: await sim.preflight() };
  } finally {
    await sim.close();
  }
}

test('an instantiated provider without preflight() is declared (placeholder) offline and live, never satisfied', async (t) => {
  const options = await fixture(t, PACK('delete provider.preflight;', ''));
  for (const report of Object.values(await bothReports(options))) {
    for (const id of ['provider:storage/remote', 'provider:messaging/relay']) {
      assert.equal(row(report, id).status, 'placeholder', id);
      assert.deepEqual(row(report, id).resolution, { by: 'declared' });
      assert.match(row(report, id).message, /declares no preflight\(\)/);
    }
  }
});

test('preflight() answers decide: ready is satisfied, not ready is missing with the reason (offline and live)', async (t) => {
  const options = await fixture(
    t,
    PACK(
      "provider.preflight = async () => ({ ready: false, reason: 'invented backend refused' });",
      ', preflight: async () => ({ ready: true })',
    ),
  );
  for (const report of Object.values(await bothReports(options))) {
    assert.equal(row(report, 'provider:storage/remote').status, 'missing');
    assert.match(row(report, 'provider:storage/remote').message, /invented backend refused/);
    assert.equal(row(report, 'provider:messaging/relay').status, 'satisfied');
    assert.equal(
      row(report, 'provider:storage/local').status,
      'satisfied',
      'the core local provider implements preflight()',
    );
  }
});

test('preflight({ packs }) loads module paths like createSimulator', async (t) => {
  const options = await fixture(t, PACK('', ''));
  const report = await preflight({ ...options, env: {} });
  assert.equal(
    row(report, 'provider:storage/remote').status,
    'satisfied',
    'the pack named by path supplied the provider',
  );
});

// Regression: an unref'd deadline timer lets a process with no other handle exit (code 13, unsettled top-level await)
// before the answer. A non-zero exit rejects with the child's stderr; the test's own deadline bounds a hung child.
test('provider deadlines deliver an answer when a CLI has no other active handles', async (t) => {
  const child = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/hung-provider-preflight.mjs', import.meta.url))],
    { encoding: 'utf8', windowsHide: true, signal: t.signal },
  );
  assert.deepEqual(JSON.parse(child.stdout), { ready: false, reason: 'No preflight answer within 20 ms.' });
});

// A working provider signals progress every 10 s of the fake clock for its first 60 s.
const signalProgress = (progress) => {
  for (let at = 10000; at <= 60000; at += 10000) setTimeout(progress, at);
};

test('a probe without a caller timeout keeps waiting for a provider that becomes ready late', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer;
  const late = new Promise((resolve) => {
    answer = resolve;
  });
  const probe = preflightProvider({
    preflight: ({ progress }) => {
      signalProgress(progress);
      return late;
    },
  });
  // The emulator takes longer than 2 s; the test advances its own clock, never the wall clock.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(60000);
  answer({ ready: true });
  assert.deepEqual(await probe, { ready: true, reason: null });
});

test('an idle guard ends a probe whose provider never answers, and reports it as a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let timedOut = 0;
  const probe = preflightProvider(
    { preflight: () => new Promise(() => {}) },
    {
      onTimeout: () => {
        timedOut += 1;
      },
    },
  );
  t.mock.timers.tick(PREFLIGHT_IDLE_TIMEOUT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timedOut, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await probe, { ready: false, reason: 'The provider gave no answer for 30000 ms.' });
  assert.equal(timedOut, 1);
});

test('the idle bound is the caller idleTimeoutMs when one is given', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const probe = preflightProvider({ preflight: () => new Promise(() => {}) }, { idleTimeoutMs: 5000 });
  t.mock.timers.tick(5000);
  assert.deepEqual(await probe, { ready: false, reason: 'The provider gave no answer for 5000 ms.' });
});

test('a provider that answers late but keeps signalling progress passes the probe', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const probe = preflightProvider({
    preflight: ({ progress }) => {
      signalProgress(progress);
      return new Promise((resolve) => setTimeout(() => resolve({ ready: true }), 60000));
    },
  });
  // The provider starts after the probe's first microtask turn, so its progress timers exist before the clock advances.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(60000);
  assert.deepEqual(await probe, { ready: true, reason: null });
});

test('the host probe passes no caller timeout, so the default idle bound ends a silent bus probe as a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const providers = {
    storage: { describe: () => ({ providers: [] }) },
    messaging: {
      settings: { relay: { kind: 'invented' } },
      buses: { relay: { preflight: () => new Promise(() => {}) } },
    },
  };
  const rows = providerRequirements({ providers });
  t.mock.timers.tick(PREFLIGHT_IDLE_TIMEOUT_MS);
  assert.deepEqual(await rows, [
    {
      id: 'provider:messaging/relay',
      reachable: false,
      status: 'unknown',
      reason: 'PROVIDER_PREFLIGHT_TIMEOUT',
      message:
        "Messaging provider 'relay' did not answer its readiness probe: The provider gave no answer for 30000 ms.",
    },
  ]);
});

test('GET /_sim/api/preflight carries the PROVIDER_PREFLIGHT_TIMEOUT reason of a storage provider that gives no answer', async (t) => {
  let probeStarted;
  const started = new Promise((resolve) => {
    probeStarted = resolve;
  });
  globalThis.inventedProbeStarted = probeStarted;
  t.after(() => {
    delete globalThis.inventedProbeStarted;
  });
  const options = await fixture(
    t,
    PACK('provider.preflight = () => { globalThis.inventedProbeStarted(); return new Promise(() => {}); };', ''),
  );
  const sim = await createSimulator({ ...options, port: 0, watch: false });
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const response = fetch(`${sim.url}/_sim/api/preflight`);
    await started;
    t.mock.timers.tick(PREFLIGHT_IDLE_TIMEOUT_MS);
    const report = await (await response).json();
    assert.equal(row(report, 'provider:storage/remote').status, 'unknown');
    assert.equal(row(report, 'provider:storage/remote').reason, 'PROVIDER_PREFLIGHT_TIMEOUT');
  } finally {
    t.mock.timers.reset();
    await sim.close();
  }
});

test('a refused connection is a not-ready answer at once', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  assert.deepEqual(await preflightProvider({ preflight: () => Promise.reject(refused) }), {
    ready: false,
    reason: refused.message,
  });
});

test('a caller timeout that expires reports the provider unknown with PROVIDER_PREFLIGHT_TIMEOUT, not missing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const providers = {
    storage: { describe: () => ({ providers: [] }) },
    messaging: {
      settings: { relay: { kind: 'invented' } },
      buses: { relay: { preflight: () => new Promise(() => {}) } },
    },
  };
  const rows = providerRequirements({ providers, timeoutMs: 20 });
  t.mock.timers.tick(60000);
  assert.deepEqual(await rows, [
    {
      id: 'provider:messaging/relay',
      reachable: false,
      status: 'unknown',
      reason: 'PROVIDER_PREFLIGHT_TIMEOUT',
      message: "Messaging provider 'relay' did not answer its readiness probe: No preflight answer within 20 ms.",
    },
  ]);
});

test('preflightProvider is bounded and the contract checks its shape', async (t) => {
  assert.equal(await preflightProvider({}), null);
  const hung = await preflightProvider({ preflight: () => new Promise(() => {}) }, { timeoutMs: 20 });
  assert.equal(hung.ready, false);
  assert.match(hung.reason, /within 20 ms/);
  assert.deepEqual(
    await preflightProvider({
      preflight: () => {
        throw new Error('invented throw');
      },
    }),
    { ready: false, reason: 'invented throw' },
  );
  const memory = createMemoryStorage({ id: 'fx-memory' });
  assert.deepEqual(await preflightProvider(memory), { ready: true, reason: null });
  assert.throws(
    () => assertProvider(Object.assign(createMemoryStorage({ id: 'fx-bad' }), { preflight: true })),
    /preflight must be a function/,
  );
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'provider-preflight-disk-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const disk = createLocalDiskStorage({ root: path.join(root, 'blobs'), id: 'fx-disk' });
  assert.deepEqual(await preflightProvider(disk), { ready: true, reason: null });
  await disk.close();
  assert.equal((await preflightProvider(disk)).ready, false);
});

test('the offline preflight accepts a local-disk root the running host accepts (one root rule)', async (t) => {
  const options = {
    ...(await fixture(t, PACK('', ''))),
    simulation: { level: 'simulation' },
    providers: { storage: { local: { kind: 'local-disk', root: 'blobs' } } },
  };
  const offline = await preflight({ ...options, env: {} });
  assert.equal(row(offline, 'provider:storage/local').status, 'satisfied');
  await assert.rejects(
    () =>
      preflight({ ...options, providers: { storage: { local: { kind: 'local-disk', root: '../outside' } } }, env: {} }),
    /must resolve under the state directory/,
  );
  // An absolute root under the state directory, which the running host accepts, passes the offline preflight too.
  const absolute = path.join(options.projectRoot, '.paqvilo', 'mirage', 'blobs');
  assert.equal(
    row(
      await preflight({
        ...options,
        providers: { storage: { local: { kind: 'local-disk', root: absolute } } },
        env: {},
      }),
      'provider:storage/local',
    ).status,
    'satisfied',
  );
});

// Records the delay of every timer the code under test arms on the mocked clock, and counts the timers still armed. It
// replaces the mocked setTimeout and clearTimeout for the duration of run() and restores them in finally. Only timers
// armed by Mirage's own code are recorded: a fetch connection of an earlier test also arms global timers.
const MIRAGE_LIB = new URL('../lib/', import.meta.url).href;
async function withTimerSpy(run) {
  const mockedSetTimeout = globalThis.setTimeout;
  const mockedClearTimeout = globalThis.clearTimeout;
  const delays = [];
  const armed = new Set();
  globalThis.setTimeout = (callback, delay, ...rest) => {
    if (!calledFrom(MIRAGE_LIB, import.meta.url)) return mockedSetTimeout(callback, delay, ...rest);
    delays.push(delay);
    const handle = mockedSetTimeout(
      function (...args) {
        armed.delete(handle);
        callback.apply(this, args);
      },
      delay,
      ...rest,
    );
    armed.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    armed.delete(handle);
    mockedClearTimeout(handle);
  };
  try {
    return await run({ delays, armedCount: () => armed.size });
  } finally {
    globalThis.setTimeout = mockedSetTimeout;
    globalThis.clearTimeout = mockedClearTimeout;
  }
}

const settleNow = () => new Promise((resolve) => setImmediate(resolve));

// Regression: a caller's timeoutMs on a provider that never reports progress was cut at the 30 s idle window. An explicit
// timeoutMs is the only bound of the probe, so the idle guard is not armed.
test('an explicit timeoutMs is the only bound of a silent probe: it is pending at 31 s and ends at its own 60 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withTimerSpy(async ({ delays, armedCount }) => {
    let settled = false;
    const probe = preflightProvider({ preflight: () => new Promise(() => {}) }, { timeoutMs: 60000 });
    probe.then(() => {
      settled = true;
    });
    t.mock.timers.tick(31000);
    await settleNow();
    assert.equal(settled, false, 'a 60 s caller timeout still waits at 31 s');
    t.mock.timers.tick(29000);
    assert.deepEqual(await probe, { ready: false, reason: 'No preflight answer within 60000 ms.' });
    assert.deepEqual(delays, [60000], 'only the caller deadline is armed');
    assert.equal(armedCount(), 0, 'no timer is left armed');
  });
});

// The one-request bound that the probes of local services, message bus and Azurite use takes the same rule: a non-finite
// explicit timeoutMs is no bound, so it neither throws (AbortSignal.timeout rejects Infinity) nor aborts.
test('a non-finite explicit timeoutMs is no request bound: requestBound neither throws nor aborts', () => {
  const bound = requestBound(Infinity);
  assert.equal(bound.signal.aborted, false);
  assert.equal(bound.limitMs, Infinity);
  bound.done();
});

// Regression: Infinity is not a delay Node accepts (it throws or fires at once); a non-finite idle window arms no timer.
test('an idleTimeoutMs of Infinity arms no idle timer: a silent probe still waits after ten minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withTimerSpy(async ({ delays, armedCount }) => {
    let answer;
    const probe = preflightProvider(
      { preflight: () => new Promise((resolve) => (answer = resolve)) },
      { idleTimeoutMs: Infinity },
    );
    t.mock.timers.tick(600000);
    await settleNow();
    assert.deepEqual(delays, [], 'no timer is armed for a non-finite idle window');
    assert.equal(armedCount(), 0);
    answer({ ready: true });
    assert.deepEqual(await probe, { ready: true, reason: null });
  });
});

// Regression: Node fires a timer longer than 2^31-1 ms after 1 ms, so the idle window is clamped to the largest delay.
test('an idle window above the Node timer limit arms a timer at the clamp, not at 1 ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withTimerSpy(async ({ delays, armedCount }) => {
    const probe = preflightProvider({ preflight: () => new Promise(() => {}) }, { idleTimeoutMs: 2 ** 31 });
    assert.deepEqual(delays, [2147483647], 'the idle timer is armed at the clamp');
    t.mock.timers.tick(2147483647);
    assert.deepEqual(await probe, { ready: false, reason: 'The provider gave no answer for 2147483648 ms.' });
    assert.equal(armedCount(), 0, 'no timer is left armed');
  });
});

// Regression: the bound ends the probe at once, but the provider's cleanup after the abort is still running. close() of the
// guarded provider waits for that cleanup, so the provider is not closed under its own probe.
test('close of a guarded provider waits for an aborted preflight to finish its cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const order = [];
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let releaseCleanup;
  const cleanupReleased = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const provider = Object.assign(createMemoryStorage({ id: 'fx-cleanup' }), {
    async preflight({ signal }) {
      enter();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await cleanupReleased;
      order.push('cleanup done');
      return { ready: true, reason: null };
    },
    close() {
      order.push('provider closed');
    },
  });
  const guarded = guardProvider(provider);
  const probe = preflightProvider(guarded, { timeoutMs: 10 });
  await entered;
  t.mock.timers.tick(10);
  assert.equal((await probe).ready, false);
  const closed = guarded.close().then(() => order.push('closed'));
  releaseCleanup();
  await closed;
  assert.deepEqual(order, ['cleanup done', 'provider closed', 'closed']);
});
