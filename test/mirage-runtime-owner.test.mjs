// @test-kind tooling: the test helper that ends Mirage runtimes a failed test or a failed stop leaves running
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { isAlive, ownedSessions, processIdentity } from '../lense/commands/mirage.mjs';
import { START_TOKEN_OPTION, newStartIdentity, recordedIdentityNow, startTokenOf } from '../lense/process-identity.mjs';
import {
  endRuntimes,
  listenerBehindOpenHandles,
  ownStartedRuntimes,
  portBinding,
  recordedRuntimeOwner,
  recordedRuntimes,
} from './helpers/mirage-runtimes.mjs';
import { ownedHealthRequest } from './helpers/owned-health-request.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
);

test('the runtime owner ends a started runtime nobody stopped, and never a process without its start identity', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-runtime-owner-'));
  const project = path.join(directory, 'organization.project.json');
  await fs.writeFile(
    project,
    JSON.stringify({ version: 2, runtime: { kind: 'model-driven' }, simulation: { level: 'dry-run' }, solutions: [] }),
  );
  const mirage = (action, ...args) =>
    execute(process.execPath, [cli, 'mirage', action, '--project', project, ...args, '--json'], {
      cwd: directory,
      env,
      windowsHide: true,
    });
  // The product's own stop is the last resort should the owner under test leave the runtime running.
  ownedFixture(t).add(() => mirage('stop').catch(() => {}));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const { stdout } = await mirage('start', '--port', '0');
  // Should a case below fail before its own owner ends the runtime, the test's owner does.
  ownStartedRuntimes(t, stdout);
  const answer = JSON.parse(stdout);
  const ownershipFile = answer.writesFiles.find((file) => file.endsWith(path.join('mirage', 'sessions.json')));
  const recorded = (await ownedSessions({ ownershipFile })).find((entry) => entry.pid === answer.pid).processIdentity;
  const port = Number(new URL(answer.url).port);
  assert.ok(recorded, 'the start recorded the runtime identity');

  const foreign = [];
  await t.test('a PID whose identity is not the recorded one is not signalled, and the owner says so', (st) => {
    const owned = ownStartedRuntimes(st, stdout, {
      identityOf: () => 'an invented identity of another program',
      report: (line) => foreign.push(line),
    });
    assert.deepEqual(
      owned.map((runtime) => runtime.pid),
      [answer.pid],
    );
  });
  assert.equal(foreign.length, 1);
  assert.match(foreign[0], new RegExp(`pid ${answer.pid} .*was not ended`));
  assert.equal(isAlive(answer.pid), true, 'the process was left running');
  assert.equal(await recordedIdentityNow(answer.pid, recorded), recorded);
  const health = await ownedHealthRequest(t, new URL('/_sim/api/status', answer.url));
  assert.equal(health.status, 200);

  const reports = [];
  await t.test('a started runtime is ended after its test when nothing stopped it', (st) => {
    ownStartedRuntimes(st, stdout, { report: (line) => reports.push(line) });
  });
  assert.deepEqual(reports, []);
  assert.notEqual(await recordedIdentityNow(answer.pid, recorded), recorded, 'the runtime process has gone');
  await health.closed;
  const binding = await portBinding(port);
  assert.equal(binding.free, true, `its port ${port} is free (${binding.code ?? 'bound'})`);
});

/**
 * Starts an idle process of its own group with a records file naming it, as `mirage start` records a runtime: by a
 * start token on its command line where one is issued, by its start time elsewhere.
 */
async function recordedProcess(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-runtime-snapshot-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const token = newStartIdentity();
  const shown = token ? ['--', START_TOKEN_OPTION, startTokenOf(token)] : [];
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...shown], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = once(child, 'exit');
  ownedFixture(t).add(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await once(child, 'spawn');
  const ownershipFile = path.join(directory, 'mirage', 'sessions.json');
  const write = (sessions) => fs.writeFile(ownershipFile, JSON.stringify({ version: 1, sessions }));
  await fs.mkdir(path.dirname(ownershipFile), { recursive: true });
  const record = { pid: child.pid, processIdentity: token ?? processIdentity(child.pid), url: 'http://127.0.0.1:9/' };
  assert.ok(record.processIdentity, 'the identity of the started process was read');
  await write([record]);
  return { child, exited, ownershipFile, record, write };
}

test('a runtime of the snapshot that outlived a stop which removed its record is ended', async (t) => {
  const { child, exited, ownershipFile, record, write } = await recordedProcess(t);
  const snapshot = await recordedRuntimes(ownershipFile);
  assert.deepEqual(snapshot, [record]);
  await write([]); // A stop that reported the runtime as ended and removed its record, while it kept running.
  assert.equal(isAlive(child.pid), true);
  const reports = [];
  await endRuntimes(snapshot, { report: (line) => reports.push(line) });
  assert.deepEqual(reports, []);
  await exited; // The process has gone: its exit was observed.
});

test('a listener behind open handles reports its port also when the test runs with forced colours', async (t) => {
  // Hosted CI sets FORCE_COLOR, which children inherit: a number printed by console.log then arrives coloured.
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  let listener;
  try {
    listener = await listenerBehindOpenHandles(t);
  } finally {
    if (previous === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previous;
  }
  assert.ok(Number.isInteger(listener.port) && listener.port > 0, `a port number was reported (${listener.port})`);
  assert.equal((await portBinding(listener.port)).code, 'EADDRINUSE', 'the reported port is the one it listens on');
});

test('an ended runtime has released its port when the owner returns, also while its other handles are still closing', async (t) => {
  const token = newStartIdentity();
  const { child, port } = await listenerBehindOpenHandles(t, { startToken: startTokenOf(token) });
  const record = {
    pid: child.pid,
    processIdentity: token ?? processIdentity(child.pid),
    url: `http://127.0.0.1:${port}/`,
  };
  assert.ok(record.processIdentity, 'the identity of the started process was read');
  const reports = [];
  await endRuntimes([record], { report: (text) => reports.push(text) });
  assert.deepEqual(reports, []);
  const binding = await portBinding(port);
  assert.equal(binding.free, true, `its port is free (${binding.code ?? 'bound'})`);
});

test('a runtime named by two snapshots is ended once, and its second entry is passed over silently', async (t) => {
  const { exited, ownershipFile } = await recordedProcess(t);
  const snapshot = await recordedRuntimes(ownershipFile);
  const reports = [];
  await endRuntimes([...snapshot, ...snapshot], { report: (line) => reports.push(line) });
  assert.deepEqual(reports, []);
  await exited; // The process has gone: its exit was observed.
});

test('a snapshot entry whose PID now has another identity is reported and not signalled', async (t) => {
  const { child, ownershipFile } = await recordedProcess(t);
  const reports = [];
  await endRuntimes(await recordedRuntimes(ownershipFile), {
    identityOf: () => 'an invented identity of another program',
    report: (line) => reports.push(line),
  });
  assert.equal(reports.length, 1);
  assert.match(reports[0], new RegExp(`pid ${child.pid} .*was not ended`));
  assert.equal(isAlive(child.pid), true, 'the process was left running');
  assert.equal(child.exitCode, null);
});

test('a teardown owner keeps a failed read, ends what it noted, and then fails with that read once', async (t) => {
  const { exited, ownershipFile, record, write } = await recordedProcess(t);
  const reports = [];
  const runtimes = recordedRuntimeOwner(ownershipFile, { report: (line) => reports.push(line) });
  await fs.writeFile(ownershipFile, '{"version":1,"sessions":[');
  await runtimes.note();
  await write([record]);
  await runtimes.note();
  await assert.rejects(runtimes.end(), /are not valid JSON/);
  assert.deepEqual(reports, []);
  await exited; // The process has gone: its exit was observed.
  await assert.doesNotReject(runtimes.end(), 'the read failure fails one end only');
});

test('a missing records file records no runtimes', async () => {
  assert.deepEqual(
    await recordedRuntimes(path.join(os.tmpdir(), 'paqvilo-no-such-state', 'mirage', 'sessions.json')),
    [],
  );
});

test('the runtime owner leaves a refused or reused start alone', (t) => {
  assert.deepEqual(ownStartedRuntimes(t, '{"error":{"message":"refused"}}'), []);
  assert.deepEqual(ownStartedRuntimes(t, 'not JSON'), []);
  assert.deepEqual(ownStartedRuntimes(t, { pid: 4, started: false, writesFiles: [] }), []);
});
