// @test-kind contract: `mirage status` probes with the toolkit's interactive limit by default; a caller that has observed the runtime ready (portal-matrix serve) waits for the runtime's answer under its own signal instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { mirageStatus, miragePaths, updateOwnedSessions } from '../lense/commands/mirage.mjs';
import { runMirage } from './helpers/mirage-in-process.mjs';

// A runtime whose status answer is held until the test releases it; `asked` resolves when a probe has arrived.
async function heldRuntime(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-status-probe-'));
  const held = [];
  const server = http.createServer((request, response) => {
    held.push(response);
    server.emit('asked');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const paths = miragePaths(null, { project: path.join(root, 'mirage.project.yml') });
  await fs.mkdir(paths.discoveryRoot, { recursive: true });
  await fs.writeFile(
    path.join(paths.discoveryRoot, `session-${process.pid}.json`),
    JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.address().port}/` }),
  );
  const answer = () => held.pop().writeHead(200, { 'content-type': 'application/json' }).end('{"site":"Held"}');
  const refuse = () => held.pop().writeHead(503).end();
  /** Records the runtime as one this toolkit started with `identity`; `ready` is what its start observed. */
  const own = (identity, ready) =>
    updateOwnedSessions(paths, () => [
      {
        pid: process.pid,
        processIdentity: identity,
        discovery: path.join(paths.discoveryRoot, `session-${process.pid}.json`),
        url: `http://127.0.0.1:${server.address().port}/`,
        ready,
      },
    ]);
  return { paths, server, answer, refuse, own };
}

test('a probe limit lists a runtime that has not answered as not ready', async (t) => {
  const { paths } = await heldRuntime(t);
  const [session] = await mirageStatus(paths, { probeTimeout: 1 });
  assert.equal(session.pid, process.pid);
  assert.equal(session.ready, false);
  assert.equal(session.probe, 'no-answer', 'the status says that nothing answered, which is not "starting"');
});

// A runtime under load answers late. A status question that got no answer in time must not turn a preview that was
// running back into a starting one (the setup page redrew "Your preview is starting…" over a running preview).
test('a runtime recorded as ready stays ready when its status gives no answer in time', async (t) => {
  const { paths, own } = await heldRuntime(t);
  await own('recorded identity', true);
  const identityOf = async () => 'recorded identity';
  const [session] = await mirageStatus(paths, { probeTimeout: 1, identityOf });
  assert.deepEqual(
    [session.ready, session.probe, session.owned, session.runtime],
    [true, 'no-answer', true, null],
    'no answer in time changes nothing that is known about the runtime',
  );
});

test('a silent runtime is ready only on the evidence of its own record: a start that never saw it ready, or another process on its PID, is none', async (t) => {
  const { paths, own } = await heldRuntime(t);
  await own('recorded identity', false);
  const [starting] = await mirageStatus(paths, { probeTimeout: 1, identityOf: async () => 'recorded identity' });
  assert.deepEqual([starting.ready, starting.probe, starting.owned], [false, 'no-answer', true]);
  await own('recorded identity', true);
  const [reused] = await mirageStatus(paths, { probeTimeout: 1, identityOf: async () => 'another identity' });
  assert.deepEqual([reused.ready, reused.probe, reused.owned], [false, 'no-answer', false]);
  const [unread] = await mirageStatus(paths, { probeTimeout: 1, identityOf: async () => null });
  assert.deepEqual([unread.ready, unread.owned], [false, false]);
});

test('a runtime recorded as ready that answers that it is not is listed as not ready', async (t) => {
  const { paths, server, own, refuse } = await heldRuntime(t);
  await own('recorded identity', true);
  const asked = once(server, 'asked');
  const status = mirageStatus(paths, { probeTimeout: null, identityOf: async () => 'recorded identity' });
  await asked;
  refuse();
  const [session] = await status;
  assert.deepEqual([session.ready, session.probe, session.owned], [false, 'refused', true]);
});

test('without a probe limit the status waits for the runtime and lists it ready', async (t) => {
  const { paths, server, answer } = await heldRuntime(t);
  const asked = once(server, 'asked');
  let settled = false;
  const status = mirageStatus(paths, { probeTimeout: null }).finally(() => (settled = true));
  await asked;
  assert.equal(settled, false);
  answer();
  const [session] = await status;
  assert.equal(session.ready, true);
  assert.equal(session.runtime.site, 'Held');
});

test('the caller signal ends a status that waits without a probe limit', async (t) => {
  const { paths, server } = await heldRuntime(t);
  const stop = new AbortController();
  const asked = once(server, 'asked');
  const status = mirageStatus(paths, { probeTimeout: null, signal: stop.signal });
  await asked;
  stop.abort(new Error('stage deadline'));
  await assert.rejects(status, /stage deadline/);
});

// The composed `mirage status` command (selection, then print) passes the probe limit its host names to every status
// read: with `probeTimeout: null` it sets no limit at all (no AbortSignal.timeout) and prints what the runtime answered.
test('the mirage command reads status with the probe limit of its host and prints the answer', async (t) => {
  const { paths, server, answer } = await heldRuntime(t);
  const limits = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    limits.push(ms);
    return timeout(ms);
  });
  const asked = once(server, 'asked');
  const status = runMirage(['mirage', 'status', '--json'], {
    cwd: path.dirname(path.dirname(paths.discoveryRoot)),
    host: { probeTimeout: null },
  });
  await asked;
  answer();
  const result = await status;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(limits, [], 'no probe limit was set');
  const [session] = JSON.parse(result.stdout).sessions;
  assert.equal(session.pid, process.pid);
  assert.equal(session.ready, true);
  assert.equal(session.runtime.site, 'Held');
});
