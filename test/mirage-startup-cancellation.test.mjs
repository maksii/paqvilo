import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import mirage, {
  discoveries,
  miragePaths,
  updateOwnedSessions,
  processIdentityAsync,
} from '../lense/commands/mirage.mjs';

const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Cancellation did not release the operation promptly.')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-startup-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
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
    t.after(
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

test('ownership cancellation releases queued and externally locked updates without changing another owner', async (t) => {
  const { paths } = await fixture(t);
  await fs.mkdir(path.dirname(paths.ownershipFile), { recursive: true });
  const initial = JSON.stringify({ version: 1, sessions: [{ pid: 123, marker: 'Keep foreign ownership' }] });
  await fs.writeFile(paths.ownershipFile, initial);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, 'foreign-lock');
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
  // Let the predecessor enter the external-lock retry path before aborting it.
  await new Promise((resolve) => setTimeout(resolve, 30));
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

test('Ctrl+C during existing-runtime discovery exits before launching a child', async (t) => {
  const { root, paths } = await fixture(t);
  let requested;
  const entered = new Promise((resolve) => {
    requested = resolve;
  });
  const server = http.createServer(() => requested());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  await ownRuntime(paths, await processIdentityAsync(process.pid), `http://127.0.0.1:${server.address().port}`);
  const phases = [],
    signalsBefore = process.listenerCount('SIGINT');
  const pending = mirage(
    { stateDir: root, runtime: { kind: 'model-driven' }, siteName: 'invented' },
    { port: '0', startup: { elapsedMs: 0, phase: (phase) => phases.push(phase) } },
    ['start'],
  );
  await entered;
  process.emit('SIGINT');
  await bounded(assert.rejects(pending, /startup was interrupted/));
  assert.equal(phases.includes('process launch'), false);
  await assert.rejects(fs.access(paths.logRoot), { code: 'ENOENT' });
  assert.equal(process.listenerCount('SIGINT'), signalsBefore);
});

for (const ownedMismatch of [false, true])
  test(`startup skips ${ownedMismatch ? 'owned settings-mismatch' : 'unowned'} listener probes before cancellation during log setup`, async (t) => {
    const { root, paths } = await fixture(t);
    let requests = 0;
    const server = http.createServer(() => {
      requests++;
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
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
    const pending = mirage(
      { stateDir: root, runtime: { kind: 'model-driven' }, siteName: 'invented' },
      {
        port: '0',
        startup: {
          elapsedMs: 0,
          phase(phase) {
            phases.push(phase);
            if (phase === 'process launch') queueMicrotask(() => process.emit('SIGINT'));
          },
        },
      },
      ['start'],
    );
    await bounded(assert.rejects(pending, /startup was interrupted/));
    assert.equal(requests, 0);
    assert.ok(phases.includes('process launch'));
    assert.equal(phases.includes('process ownership'), false, 'Cancellation during log setup must prevent the fork.');
    for (const name of await fs.readdir(paths.logRoot))
      assert.equal((await fs.stat(path.join(paths.logRoot, name))).size, 0);
  });

test('startup probes and reuses a runtime whose ownership, launch settings and process identity match', async (t) => {
  const { root, paths } = await fixture(t);
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ runtime: { kind: 'model-driven' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
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
