// @test-kind unproven: the checks in this file exercise mirage startup cancellation with local fixtures; no native capture establishes the behaviour they assert.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { readdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import mirage, {
  codeAppStartupInterrupted,
  discoveries,
  miragePaths,
  start,
  updateOwnedSessions,
  processIdentityAsync,
} from '../lense/commands/mirage.mjs';
import { startCodeAppDevServers, CODE_APP_STARTUP_CANCELLED } from '../lense/code-app-dev-servers.mjs';
import { tempDir } from './fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { readyRuntime } from './helpers/mirage-session-doubles.mjs';

// A released operation settles within event-loop latency. The bound stays below the 2.5 s status probe timeout and the
// 30 s ownership lock deadline, so an operation that ignores its signal fails here instead of settling later on its own.
const RELEASE_BOUND_MS = 1000;
const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Cancellation did not release the operation promptly.')),
          RELEASE_BOUND_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
// Start-up reads process identities through this instead of PowerShell or /proc.
const INJECTED_IDENTITY = 'injected identity';
const injectedIdentity = async () => INJECTED_IDENTITY;
// A start-up under test settles before its test ends, so a failed assertion cannot leave it running into the next test.
function settleWithTest(t, pending) {
  const settled = pending.then(
    () => {},
    () => {},
  );
  ownedFixture(t).add(() => settled);
  return settled;
}
async function fixture(t) {
  const root = await tempDir('paq-startup-cancel-');
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const paths = miragePaths({ stateDir: root });
  await fs.mkdir(paths.discoveryRoot, { recursive: true });
  return { root, paths };
}
const launchIdentity = (paths) => ({
  stateFile: path.join(paths.discoveryRoot, 'invented', 'state.json'),
  runtime: { kind: 'model-driven' },
  solutionOrder: 'derived',
  solutionRoots: [],
  requestedPort: '0',
});
async function ownRuntime(paths, identity, url) {
  const discovery = path.join(paths.discoveryRoot, `session-${process.pid}.json`);
  await fs.writeFile(discovery, JSON.stringify({ pid: process.pid, url }));
  await updateOwnedSessions(paths, () => [
    { pid: process.pid, discovery, processIdentity: identity, identity: launchIdentity(paths) },
  ]);
}

// @test-kind contract: cancellation and cleanup for each authored lifecycle case
for (const streaming of [false, true])
  test(`discovery cancellation aborts a pending ${streaming ? 'status body' : 'status response'} and skips remaining portals`, async (t) => {
    const { paths } = await fixture(t);
    let requested,
      requests = 0;
    const entered = new Promise((resolve) => {
      requested = resolve;
    });
    const server = http.createServer((_req, res) => {
      requests++;
      if (streaming) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"running":');
      }
      requested();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ownedFixture(t).add(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const url = `http://127.0.0.1:${server.address().port}`;
    await fs.writeFile(
      path.join(paths.discoveryRoot, `session-${process.pid}.json`),
      JSON.stringify({ pid: process.pid, portals: ['one', 'two', 'three'].map((id) => ({ id, url })) }),
    );
    const controller = new AbortController(),
      reason = Error('Invented cancellation');
    const pending = discoveries(paths, { signal: controller.signal });
    await entered;
    controller.abort(reason);
    await bounded(assert.rejects(pending, (error) => error === reason));
    assert.equal(requests, 1);
    assert.equal(
      (await discoveries(paths, { probe: false })).length,
      3,
      'Ordinary status callers retain their existing behavior.',
    );
  });

// @test-kind contract: ownership cancellation releases queued and externally locked updates without changing another owner
test('ownership cancellation releases queued and externally locked updates without changing another owner', async (t) => {
  const { paths } = await fixture(t);
  await fs.mkdir(path.dirname(paths.ownershipFile), { recursive: true });
  const initial = JSON.stringify({ version: 1, sessions: [{ pid: 123, marker: 'Keep foreign ownership' }] });
  await fs.writeFile(paths.ownershipFile, initial);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, 'foreign-lock');
  // The lock's owner is read only after an exclusive create found the lock taken: the external-lock retry path.
  let retrying;
  const retried = new Promise((resolve) => {
    retrying = resolve;
  });
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(lock)) retrying();
    return readFile(file, ...rest);
  });
  const first = new AbortController(),
    second = new AbortController();
  let changes = 0;
  const waiting = updateOwnedSessions(
    paths,
    (sessions) => {
      changes++;
      return sessions;
    },
    { signal: first.signal },
  );
  const queued = updateOwnedSessions(
    paths,
    (sessions) => {
      changes++;
      return sessions;
    },
    { signal: second.signal },
  );
  second.abort();
  await bounded(assert.rejects(queued, (error) => error.name === 'AbortError'));
  await retried;
  first.abort();
  await bounded(assert.rejects(waiting, (error) => error.name === 'AbortError'));
  assert.equal(changes, 0);
  assert.equal(await fs.readFile(lock, 'utf8'), 'foreign-lock');
  assert.equal(await fs.readFile(paths.ownershipFile, 'utf8'), initial);
  await fs.rm(lock);
  await updateOwnedSessions(paths, (sessions) => [...sessions, { pid: 456 }]);
  assert.deepEqual(
    JSON.parse(await fs.readFile(paths.ownershipFile)).sessions.map((entry) => entry.pid),
    [123, 456],
  );
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

// @test-kind contract: Ctrl+C during existing-runtime discovery exits before launching a child
test('Ctrl+C during existing-runtime discovery exits before launching a child', async (t) => {
  const { root, paths } = await fixture(t);
  let requested;
  const entered = new Promise((resolve) => {
    requested = resolve;
  });
  const server = http.createServer(() => requested());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  await ownRuntime(paths, INJECTED_IDENTITY, `http://127.0.0.1:${server.address().port}`);
  const phases = [],
    signalsBefore = process.listenerCount('SIGINT');
  const pending = start(
    modelDrivenConfig(root),
    { port: '0', startup: { elapsedMs: 0, phase: (phase) => phases.push(phase) } },
    { identityOf: injectedIdentity },
  );
  settleWithTest(t, pending);
  await entered;
  process.emit('SIGINT');
  await bounded(assert.rejects(pending, /startup was interrupted/));
  assert.equal(phases.includes('process launch'), false);
  await assert.rejects(fs.access(paths.logRoot), { code: 'ENOENT' });
  assert.equal(process.listenerCount('SIGINT'), signalsBefore);
});

// @test-kind contract: cancellation and cleanup for each authored lifecycle case
for (const ownedMismatch of [false, true])
  test(`startup skips ${ownedMismatch ? 'owned settings-mismatch' : 'unowned'} listener probes before cancellation during log setup`, async (t) => {
    const { root, paths } = await fixture(t);
    let requests = 0;
    const server = http.createServer(() => {
      requests++;
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ownedFixture(t).add(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const discovery = path.join(paths.discoveryRoot, `session-${process.pid}.json`);
    await fs.writeFile(
      discovery,
      JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.address().port}` }),
    );
    if (ownedMismatch)
      await updateOwnedSessions(paths, () => [
        {
          pid: process.pid,
          discovery,
          processIdentity: 'unused identity',
          identity: { ...launchIdentity(paths), preset: 'another-dataset' },
        },
      ]);
    const phases = [];
    let interrupt;
    const interrupted = new Promise((resolve) => {
      interrupt = resolve;
    });
    const pending = start(
      modelDrivenConfig(root),
      {
        port: '0',
        startup: {
          elapsedMs: 0,
          phase(phase) {
            phases.push(phase);
            if (phase === 'process launch')
              queueMicrotask(() => {
                process.emit('SIGINT');
                interrupt();
              });
          },
        },
      },
      { identityOf: injectedIdentity },
    );
    const settled = settleWithTest(t, pending);
    // The bound covers only the release after the interrupt, not the start-up work before it.
    await Promise.race([interrupted, settled]);
    await bounded(assert.rejects(pending, /startup was interrupted/));
    assert.equal(requests, 0);
    assert.ok(phases.includes('process launch'));
    assert.equal(phases.includes('process ownership'), false, 'Cancellation during log setup must prevent the fork.');
    for (const name of await fs.readdir(paths.logRoot))
      assert.equal((await fs.stat(path.join(paths.logRoot, name))).size, 0);
  });

// @test-kind contract: startup probes and reuses a runtime whose ownership, launch settings and process identity match
test('startup probes and reuses a runtime whose ownership, launch settings and process identity match', async (t) => {
  const { root, paths } = await fixture(t);
  let requests = 0;
  const url = await readyRuntime(t, () => {
    requests++;
  });
  await ownRuntime(paths, await processIdentityAsync(process.pid), url);
  const output = [],
    phases = [];
  t.mock.method(console, 'log', (value) => output.push(value));
  assert.equal(
    await mirage(
      { stateDir: root, runtime: { kind: 'model-driven' }, siteName: 'invented' },
      { port: '0', json: true, startup: { elapsedMs: 0, phase: (phase) => phases.push(phase), complete() {} } },
      ['start'],
    ),
    0,
  );
  const result = JSON.parse(output[0]);
  assert.equal(result.started, false);
  assert.equal(result.pid, process.pid);
  assert.equal(result.url, url);
  assert.equal(requests, 1);
  assert.equal(phases.includes('process launch'), false);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The start-up poll loop calls `sleep` once per finished poll. Each call hands the test a handle, and the poll resumes
// only when the test resolves it, so the test decides when the next poll begins.
function pollGate() {
  const parked = [];
  let waiting = null;
  return {
    sleep() {
      const poll = deferred();
      if (waiting) waiting.resolve(poll);
      else parked.push(poll);
      waiting = null;
      return poll.promise;
    },
    nextPoll() {
      if (parked.length) return Promise.resolve(parked.shift());
      waiting = deferred();
      return waiting.promise;
    },
  };
}

// Resolves when the start reports the named phase. The listener is attached before the poll that could report it resumes.
function phaseSeen(phases, name) {
  return new Promise((resolve) => {
    const listener = (phase) => {
      if (phase !== name) return;
      phases.off('phase', listener);
      resolve();
    };
    phases.on('phase', listener);
  });
}

// A stand-in runtime child: the start reads its pid and identity; it counts as alive until the start kills it.
const STARTUP_PID = 4242;
function fakeStartup(paths) {
  const double = {
    clock: { now: 1_000_000 },
    kills: [],
    gate: pollGate(),
    phases: new EventEmitter(),
    logPath: null,
  };
  const child = Object.assign(new EventEmitter(), { pid: STARTUP_PID, exitCode: null, unref() {}, kill() {} });
  double.startup = { phase: (name) => double.phases.emit('phase', name) };
  double.options = {
    paths,
    identityOf: async () => 'invented identity',
    sleep: double.gate.sleep,
    now: () => double.clock.now,
    alive: () => double.kills.length === 0,
    kill: (pid, signal) => double.kills.push([pid, signal]),
    spawnRuntime() {
      // The start creates its own log before spawning, and the log root holds no other file in this fixture.
      const names = readdirSync(paths.logRoot);
      assert.equal(names.length, 1);
      double.logPath = path.join(paths.logRoot, names[0]);
      return child;
    },
  };
  return double;
}

const progressLine = (round) =>
  `${JSON.stringify({ type: 'runtime-startup', phase: 'configuration', elapsedMs: round * 200 })}\n`;
const modelDrivenConfig = (root) => ({ stateDir: root, runtime: { kind: 'model-driven' }, siteName: 'invented' });

// @test-kind contract: start-up is bounded by silence, so a runtime that keeps reporting progress is not abandoned
test('start-up stays alive while the runtime keeps reporting progress within the silence bound', async (t) => {
  const { root, paths } = await fixture(t);
  const url = await readyRuntime(t, () => {});
  const fake = fakeStartup(paths);
  const started = start(
    modelDrivenConfig(root),
    { port: '0', 'startup-timeout': '1000', startup: fake.startup },
    fake.options,
  );
  // Each round: the runtime reports one progress line, the start consumes it, and 600 ms of controlled time pass.
  for (let round = 1; round <= 12; round++) {
    const poll = await fake.gate.nextPoll();
    await fs.appendFile(fake.logPath, progressLine(round));
    const consumed = phaseSeen(fake.phases, 'configuration');
    poll.resolve();
    await consumed;
    fake.clock.now += 600;
  }
  // The runtime then publishes its discovery record, which the next poll reads.
  await fs.writeFile(
    path.join(paths.discoveryRoot, `session-${STARTUP_PID}.json`),
    JSON.stringify({ pid: STARTUP_PID, url }),
  );
  const poll = await fake.gate.nextPoll();
  poll.resolve();
  const session = await started;
  assert.equal(session.started, true);
  assert.equal(session.url, url);
  assert.deepEqual(fake.kills, []);
});

// @test-kind contract: start-up fails once the runtime is silent for the bound, and the failure names the silence and the log
test('start-up fails after the silence bound and names the silence and the start-up log', async (t) => {
  const { root, paths } = await fixture(t);
  const fake = fakeStartup(paths);
  const started = start(
    modelDrivenConfig(root),
    { port: '0', 'startup-timeout': '1000', startup: fake.startup },
    fake.options,
  );
  // No progress is reported: the next poll finishes past the silence bound.
  const poll = await fake.gate.nextPoll();
  fake.clock.now += 1001;
  poll.resolve();
  await assert.rejects(started, (error) => {
    assert.match(error.message, /no start-up progress for \d+ ms/);
    assert.match(error.message, /See startup log: .*startup-\d+-[0-9a-f]+\.log$/);
    assert.ok(error.writesFiles.some((file) => file.endsWith('.log')));
    return true;
  });
  assert.deepEqual(fake.kills, [[STARTUP_PID, 'SIGTERM']]);
});

// A loopback runtime whose every status request is handed to `respond`, so the test decides when and how it answers.
async function probedRuntime(t, respond) {
  const server = http.createServer((_req, res) => respond(res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
const answerReady = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ runtime: { kind: 'model-driven' } }));
};
// The connection ends without an answer: to the start this is the same as a probe that timed out.
const failProbe = (res) => res.socket.destroy();

// The test's own runtime record: this process, with the start's launch settings and the identity the start reads.
function ownedLaunch(paths, { alive = () => true } = {}) {
  const gate = pollGate();
  const launched = [];
  return {
    gate,
    launched,
    options: {
      paths,
      identityOf: injectedIdentity,
      sleep: gate.sleep,
      now: () => 1_000_000,
      alive,
      spawnRuntime() {
        launched.push(true);
        throw new Error('The test launches no runtime.');
      },
    },
  };
}

// The start's next wait for its owned runtime; a start that settles instead never waited.
const nextWait = (launch, pending) =>
  Promise.race([
    launch.gate.nextPoll(),
    pending.then(
      () => assert.fail('The start returned without waiting for its owned runtime.'),
      (error) => assert.fail(`The start failed without waiting for its owned runtime: ${error.message}`),
    ),
  ]);

// @test-kind contract: an owned runtime with the launch settings is waited for while its process lives, never launched twice
test('an owned runtime whose status answers late is reused, not launched a second time', async (t) => {
  const { root, paths } = await fixture(t);
  const release = deferred(),
    held = deferred();
  let requests = 0;
  const url = await probedRuntime(t, (res) => {
    if (++requests === 1) return failProbe(res);
    held.resolve();
    release.promise.then(() => answerReady(res));
  });
  await ownRuntime(paths, INJECTED_IDENTITY, url);
  const launch = ownedLaunch(paths);
  // The CLI hands the start a fractional elapsed time, as here.
  const pending = start(
    modelDrivenConfig(root),
    { port: '0', 'startup-timeout': '600000', startup: { elapsedMs: 0.25, phase() {} } },
    launch.options,
  );
  settleWithTest(t, pending);
  // The first probe failed; the start waits for the live owner instead of launching.
  const poll = await nextWait(launch, pending);
  assert.deepEqual(launch.launched, []);
  poll.resolve();
  // The repeated probe reaches the runtime: a start that waits again without asking is not waiting for it.
  await Promise.race([
    held.promise,
    launch.gate.nextPoll().then(() => assert.fail('The repeated probe never reached the runtime.')),
  ]);
  assert.deepEqual(launch.launched, [], 'A held status answer must not start a second runtime.');
  release.resolve();
  const session = await pending;
  assert.equal(session.started, false);
  assert.equal(session.pid, process.pid);
  assert.equal(session.url, url);
  assert.equal(requests, 2);
});

// @test-kind contract: an owned runtime that stays silent past the start-up bound refuses the start
test('an owned runtime that stays silent past the start-up bound refuses the start', async (t) => {
  const { root, paths } = await fixture(t);
  const url = await probedRuntime(t, failProbe);
  await ownRuntime(paths, INJECTED_IDENTITY, url);
  let now = 1_000_000;
  const launch = ownedLaunch(paths);
  launch.options.now = () => now;
  const pending = start(
    modelDrivenConfig(root),
    { port: '0', 'startup-timeout': '1000', startup: { phase() {} } },
    launch.options,
  );
  settleWithTest(t, pending);
  const poll = await nextWait(launch, pending);
  now += 1000;
  poll.resolve();
  await assert.rejects(pending, (error) => {
    assert.match(error.message, new RegExp(`Mirage pid ${process.pid} runs with these settings`));
    assert.match(error.message, /did not answer within 1000 ms/);
    assert.match(error.message, /mirage stop/);
    return true;
  });
  assert.deepEqual(launch.launched, []);
});

// @test-kind contract: once the owned runtime's process has exited, the start launches a new runtime
test('an owned runtime whose process exits while it is awaited is replaced by a new launch', async (t) => {
  const { root, paths } = await fixture(t);
  const url = await probedRuntime(t, failProbe);
  await ownRuntime(paths, INJECTED_IDENTITY, url);
  let ownerAlive = true;
  const launch = ownedLaunch(paths, { alive: () => ownerAlive });
  const pending = start(
    modelDrivenConfig(root),
    { port: '0', 'startup-timeout': '600000', startup: { phase() {} } },
    launch.options,
  );
  settleWithTest(t, pending);
  const poll = await nextWait(launch, pending);
  assert.deepEqual(launch.launched, []);
  ownerAlive = false;
  poll.resolve();
  await assert.rejects(pending, /The test launches no runtime/);
  assert.deepEqual(launch.launched, [true]);
});

// Every readiness probe is refused at connect level by this double, so no port is reserved, released or listened on.
const refusedConnect = () => {
  const request = new EventEmitter();
  request.end = () =>
    request.emit('error', Object.assign(Error('Connection refused by the test double.'), { code: 'ECONNREFUSED' }));
  return request;
};

// A Code App whose dev server is a configured command on a loopback URL.
async function codeAppAt(t, script) {
  const root = await tempDir('paq-code-app-start-');
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  return [
    {
      name: 'invented-app',
      dir: root,
      localAppUrl: 'http://127.0.0.1:5299/',
      devServer: { command: [process.execPath, '-e', script] },
    },
  ];
}

// @test-kind contract: a Code App dev server that exits during start-up is a failure that keeps its exit detail
test('a Code App dev server that exits during start-up is a failure with its exit detail, not an interrupt', async (t) => {
  const apps = await codeAppAt(t, 'console.error("invented exit detail"); process.exit(3)');
  const error = await startCodeAppDevServers(apps, { output: () => {}, connect: refusedConnect }).then(
    () => assert.fail('the dev server must not become ready'),
    (failure) => failure,
  );
  const lines = [];
  assert.equal(
    codeAppStartupInterrupted(error, (line) => lines.push(line)),
    false,
  );
  assert.deepEqual(lines, []);
  assert.match(error.message, /dev server exited \(3\)/);
  assert.match(error.message, /Command: .*-e console\.error\("invented exit detail"\)/);
  assert.match(error.message, /invented exit detail/);
  assert.doesNotMatch(error.message, /aborted/);
});

// @test-kind contract: a Ctrl+C during Code App start-up is an interrupt that prints one cancellation line, never an abort message
test('a Ctrl+C during Code App start-up is an interrupt with one cancellation line', async (t) => {
  const apps = await codeAppAt(t, 'setInterval(() => {}, 1000)');
  const controller = new AbortController();
  controller.abort(new Error('Code App development stopped.'));
  const error = await startCodeAppDevServers(apps, {
    signal: controller.signal,
    output: () => {},
    connect: refusedConnect,
  }).then(
    () => assert.fail('a cancelled start-up must not become ready'),
    (failure) => failure,
  );
  assert.equal(error.code, CODE_APP_STARTUP_CANCELLED);
  const lines = [];
  assert.equal(
    codeAppStartupInterrupted(error, (line) => lines.push(line)),
    true,
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Code App start-up was interrupted/);
  assert.doesNotMatch(lines[0], /aborted/);
});
