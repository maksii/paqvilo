// @test-kind security: a recorded PID is signalled only while the operating system shows it to be the recorded runtime
// A runtime started on Windows is identified by a start token instead of its start time. Its pipe shows it running
// without asking the operating system; only the command line of the process whose handle is held justifies a signal.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { miragePaths, stopOwnedSessions, updateOwnedSessions } from '../lense/commands/mirage.mjs';
import {
  START_TOKEN_OPTION,
  endRecordedWindowsProcess,
  isAlive,
  newStartIdentity,
  processIdentity,
  recordedIdentityNow,
  startTokenOf,
  windowsOwnershipScript,
} from '../lense/process-identity.mjs';

const identityModule = new URL('../lense/process-identity.mjs', import.meta.url).href;
const windows = process.platform === 'win32';

/**
 * Starts an idle process of its own group. `shown`: the token is on its command line, as a launcher puts it there.
 * `held`: it holds the pipe of that token, as a runtime does. Resolves once the pipe is held.
 */
async function idleProcess(t, { shown = null, held = null } = {}) {
  const code = `(async () => {
    const { holdStartToken } = await import(${JSON.stringify(identityModule)});
    const server = holdStartToken(${JSON.stringify(held)});
    const ready = () => console.log('ready');
    if (server) server.once('listening', ready); else ready();
    setInterval(() => {}, 1000);
  })()`;
  const child = spawn(process.execPath, ['-e', code, ...(shown ? ['--', START_TOKEN_OPTION, shown] : [])], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const exited = once(child, 'exit');
  ownedFixture(t).add(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await Promise.race([
    once(child.stdout, 'data'),
    exited.then(() => Promise.reject(new Error('The process ended before it was ready.'))),
  ]);
  return { child, exited, running: () => child.exitCode === null && child.signalCode === null && isAlive(child.pid) };
}

/** Counts the helper processes the identity module starts while the test runs. */
function helperStarts(t) {
  const starts = [];
  const { execFile } = childProcess;
  const mock = t.mock.method(childProcess, 'execFile', (file, ...rest) => {
    starts.push(file);
    return execFile(file, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return starts;
}

async function ownershipStore(t, sessions) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-start-token-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const paths = miragePaths({ stateDir: directory });
  await updateOwnedSessions(paths, () => sessions);
  return paths;
}

test('a start token is issued only where the operating system start time is expensive to read', () => {
  const identity = newStartIdentity('win32');
  assert.match(identity, /^token:[0-9a-f]{32}$/);
  assert.notEqual(newStartIdentity('win32'), identity, 'every start has its own token');
  assert.equal(startTokenOf(identity), identity.slice(6));
  assert.equal(newStartIdentity('linux'), null);
  assert.equal(newStartIdentity('darwin'), null);
  for (const other of ['639304139638802221', 'token:XYZ', 'token:' + 'a'.repeat(31), `${identity}'; calc`, null, 7])
    assert.equal(startTokenOf(other), null);
});

// @test-kind security: the Windows ownership helper's own command line never carries the token it matches
test("the Windows ownership helper's own command line never carries the token it matches", () => {
  const token = 'a'.repeat(32);
  const { body, env } = windowsOwnershipScript(1234, `token:${token}`);
  assert.equal(body.includes(token), false, 'the script that PowerShell is started with does not name the token');
  assert.equal(env.PAQVILO_START_TOKEN_MATCH, `${START_TOKEN_OPTION} ${token}`);
});

test('an identity that cannot name a process starts no helper and ends nothing', async (t) => {
  const starts = helperStarts(t);
  for (const recorded of ["token:'; Stop-Process -Id 4; '", '12; Stop-Process -Id 4', '', undefined, 12, {}])
    assert.equal(await endRecordedWindowsProcess(process.pid, recorded), 'unread');
  for (const pid of [0, -1, 1.5, '4', '4; calc'])
    assert.equal(await endRecordedWindowsProcess(pid, newStartIdentity('win32')), 'unread');
  // Without an identity only a caller that holds the process as its own child may end it, as a tree.
  assert.equal(await endRecordedWindowsProcess(process.pid, null), 'unread');
  assert.deepEqual(starts, []);
});

test('a token recorded on Windows is unreadable elsewhere, so its PID is never signalled there', async (t) => {
  const starts = helperStarts(t);
  const recorded = newStartIdentity('win32');
  assert.equal(await recordedIdentityNow(process.pid, recorded, { platform: 'linux' }), null);
  assert.equal(await recordedIdentityNow(process.pid, recorded, { signal: AbortSignal.abort() }), null);
  assert.deepEqual(starts, []);
});

if (windows) {
  test('a running runtime is shown by its pipe without a helper process, and a gone one is not', async (t) => {
    const recorded = newStartIdentity();
    const token = startTokenOf(recorded);
    const { child, exited } = await idleProcess(t, { shown: token, held: token });
    const starts = helperStarts(t);
    assert.equal(await recordedIdentityNow(child.pid, recorded), recorded);
    child.kill();
    await exited;
    assert.equal(await recordedIdentityNow(child.pid, recorded), null);
    assert.deepEqual(starts, [], 'neither answer asked the operating system');
  });

  test('a runtime that has not created its pipe yet is read from its command line', async (t) => {
    const recorded = newStartIdentity();
    const { child, running } = await idleProcess(t, { shown: startTokenOf(recorded) });
    const starts = helperStarts(t);
    assert.equal(await recordedIdentityNow(child.pid, recorded), recorded);
    assert.deepEqual(starts, ['powershell.exe']);
    assert.equal(running(), true, 'a read ends nothing');
  });

  test('another program holding the recorded PID is not the runtime and is never ended', async (t) => {
    const recorded = newStartIdentity();
    // The token of another start on its command line: only the recorded token counts.
    const { child, running } = await idleProcess(t, { shown: startTokenOf(newStartIdentity()) });
    const current = await recordedIdentityNow(child.pid, recorded);
    assert.equal(typeof current, 'string');
    assert.notEqual(current, recorded);
    assert.equal(await endRecordedWindowsProcess(child.pid, recorded, { tree: true }), 'other');
    assert.equal(running(), true, 'the other program was left running');
  });

  test('a stop drops the record of a PID that another program holds and leaves that program running', async (t) => {
    const recorded = newStartIdentity();
    const { child, running } = await idleProcess(t, { shown: startTokenOf(newStartIdentity()) });
    const paths = await ownershipStore(t, [{ pid: child.pid, processIdentity: recorded, url: null, ready: true }]);
    const report = await stopOwnedSessions({ paths, pids: [child.pid] });
    assert.deepEqual(report.stopped, []);
    assert.deepEqual(
      report.pruned.map(({ pid, reason }) => ({ pid, reason })),
      [{ pid: child.pid, reason: 'process ID now belongs to another program' }],
    );
    assert.equal(running(), true, 'the stop left the other program running');
  });

  test('a pipe of the token held by another program never gets the recorded PID signalled', async (t) => {
    const recorded = newStartIdentity();
    const token = startTokenOf(recorded);
    // The runtime has gone, its PID belongs to an unrelated program, and a third program holds a pipe of the name.
    const reused = await idleProcess(t);
    await idleProcess(t, { held: token });
    assert.equal(await recordedIdentityNow(reused.child.pid, recorded), recorded, 'the pipe listing alone is deceived');
    const paths = await ownershipStore(t, [
      { pid: reused.child.pid, processIdentity: recorded, url: null, ready: true },
    ]);
    const report = await stopOwnedSessions({ paths, pids: [reused.child.pid], deadline: 0 });
    assert.deepEqual(report.stopped, []);
    assert.deepEqual(
      report.remaining.map(({ pid }) => pid),
      [reused.child.pid],
      'the stop reports what it could not confirm instead of ending it',
    );
    assert.equal(reused.running(), true, 'the unrelated program was left running');
  });

  test('the recorded runtime that does not answer is ended once the operating system shows its token, and its exit is awaited', async (t) => {
    const recorded = newStartIdentity();
    const { child, exited } = await idleProcess(t, { shown: startTokenOf(recorded) });
    const paths = await ownershipStore(t, [{ pid: child.pid, processIdentity: recorded, url: null, ready: false }]);
    const report = await stopOwnedSessions({ paths, pids: [child.pid] });
    assert.deepEqual(
      report.stopped.map(({ pid, graceful }) => ({ pid, graceful })),
      [{ pid: child.pid, graceful: false }],
    );
    assert.deepEqual(report.remaining, []);
    await exited;
  });

  test('a record of an older version is ended by its start time', async (t) => {
    const { child, exited } = await idleProcess(t);
    const started = processIdentity(child.pid);
    assert.match(started, /^\d+$/);
    assert.equal(await endRecordedWindowsProcess(child.pid, started), 'ended');
    await exited;
  });

  test('a record of an older version never gets a PID with another start time ended', async (t) => {
    const { child, running } = await idleProcess(t);
    // The start time (in .NET ticks) of a process started in 2020: not this one's.
    assert.equal(await endRecordedWindowsProcess(child.pid, '637134336000000000'), 'other');
    assert.equal(running(), true, 'the process with another start time was left running');
  });
}
