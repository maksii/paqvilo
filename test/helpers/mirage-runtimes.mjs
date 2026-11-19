// Test-only owner for the Mirage runtimes `mirage start` leaves running after the command has ended: when a test fails
// before its own `mirage stop`, or that stop fails, the runtimes are ended after the test so they cannot keep their
// ports, their CPU or their fixture folders.
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';
import { isAlive, ownedSessions } from '../../lense/commands/mirage.mjs';
import { START_TOKEN_OPTION, endRecordedWindowsProcess, recordedIdentityNow } from '../../lense/process-identity.mjs';

const OWNERSHIP = path.join('mirage', 'sessions.json');
// How often the closer looks again whether an ended runtime has gone; the test runner's limit is the hang guard.
const EXIT_POLL_MS = 100;

/**
 * Ends process `pid`, a child the caller holds, and every process it started: `taskkill /t /f` on Windows (which
 * follows the parent link of detached children too); elsewhere `signal` to its process group. `missingGroup` runs
 * when the group is already gone (ESRCH). It returns once the processes are told to end: the caller observes the exit
 * of its child itself (its `close` event), which costs nothing, and that wait is what shows a child taskkill left
 * running. taskkill reports a process of the tree that ended by itself meanwhile as a failure, so only a taskkill
 * that could not run fails the call.
 */
export async function endProcessTree(pid, { signal = 'SIGKILL', missingGroup = () => {} } = {}) {
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) =>
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, (error) =>
        error && typeof error.code !== 'number' ? reject(error) : resolve(),
      ),
    );
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    missingGroup(signal);
  }
}

/**
 * The runtimes `ownershipFile` (`<stateDir>/mirage/sessions.json`) records now; a missing file records none. Take this
 * snapshot before a product stop: the stop removes the records of what it reports as ended.
 * @returns {Promise<{pid: number, processIdentity: string|undefined, url: string|undefined}[]>}
 */
export async function recordedRuntimes(ownershipFile) {
  return (await ownedSessions({ ownershipFile })).map(({ pid, processIdentity, url }) => ({
    pid,
    processIdentity,
    url,
  }));
}

/** The product's reader of a recorded PID (lense/commands/mirage.mjs): tests inject their own in its place. */
const recordedIdentity = (pid, { recorded } = {}) => recordedIdentityNow(pid, recorded);

/**
 * Ends every runtime of a `recordedRuntimes` snapshot that is still running with the start identity the snapshot
 * names, whether or not its record is still in the file, and returns once each has exited. A PID whose identity is
 * missing or cannot be confirmed is reported and never signalled: it may have been reused by another program. No step
 * ends on elapsed time; the test runner's limit is the hang guard.
 */
export async function endRuntimes(runtimes, { identityOf = recordedIdentity, report }) {
  const unconfirmed = ({ pid, url }) =>
    report(
      `Mirage runtime pid ${pid} (${url}) was not ended: the process holding that PID could not be confirmed to have the start identity its record names.`,
    );
  for (const runtime of runtimes) {
    const { pid, processIdentity: recorded } = runtime;
    if (!isAlive(pid)) continue;
    if (process.platform === 'win32' && identityOf === recordedIdentity) {
      // One helper confirms the identity, ends the tree and waits for the exit, through one held process handle.
      const answer = recorded ? await endRecordedWindowsProcess(pid, recorded, { tree: true }) : 'unread';
      // 'other': the PID belongs to another program now, so the recorded runtime has gone.
      if (answer === 'unread' || answer === 'refused') unconfirmed(runtime);
      continue;
    }
    if (!recorded || (await identityOf(pid, { recorded })) !== recorded) {
      unconfirmed(runtime);
      continue;
    }
    // POSIX, or an injected reader: the group is signalled and the exit observed by its PID and identity.
    await endProcessTree(pid);
    while (isAlive(pid) && (await identityOf(pid, { recorded })) === recorded) await delay(EXIT_POLL_MS);
  }
}

/**
 * Owner of the runtimes `ownershipFile` records during a test's teardown. `note()` adds what the file records now and
 * never throws: a failed read is kept, so the teardown that called it continues. `end()` ends every noted runtime that
 * is still running and then fails with the read failures, if any; a failure is reported once.
 */
export function recordedRuntimeOwner(ownershipFile, { identityOf = recordedIdentity, report }) {
  const noted = [],
    failures = [];
  return {
    async note() {
      try {
        noted.push(...(await recordedRuntimes(ownershipFile)));
      } catch (error) {
        failures.push(error);
      }
    },
    async end() {
      await endRuntimes(noted, { identityOf, report });
      const failed = failures.splice(0);
      if (failed.length === 1) throw failed[0];
      if (failed.length)
        throw new AggregateError(failed, `The Mirage ownership records ${ownershipFile} could not be read.`);
    },
  };
}

/** The runtimes a `mirage start --json` answer (text or parsed) reports as started by that command. */
function startedRuntimes(answer) {
  let value = answer;
  if (typeof answer === 'string')
    try {
      value = JSON.parse(answer);
    } catch {
      return [];
    }
  return (value?.portals ?? [value])
    .filter((item) => item?.started === true && Number.isInteger(item.pid))
    .map((item) => ({
      pid: item.pid,
      url: item.url,
      ownershipFile: (item.writesFiles ?? []).find((file) => file.endsWith(OWNERSHIP)),
    }));
}

/**
 * Registers one closer, run after the test, that ends every runtime `answer` reports as started and that is still
 * running. A runtime is ended only while its PID still has the start identity `mirage start` recorded for it in its
 * ownership records — the check `mirage stop` itself makes — so a reused PID is never signalled. A runtime the
 * test's own stop ended (its record is gone, or its process has exited) is left alone. Call it as soon as the start
 * answer is available, before anything that can throw.
 *
 * A start that was ended before it answered (its hang guard, the end of its test) names no runtime, yet it records the
 * runtime before it waits for readiness. With `ownershipFile`, the records file of the test's own state folder, the
 * closer also ends every runtime that file still records. A runtime whose start was ended before it was recorded is
 * not covered.
 * @returns {{pid: number, url: string, ownershipFile: string|undefined}[]} the runtimes it owns
 */
export function ownStartedRuntimes(
  t,
  answer,
  { identityOf = recordedIdentity, report = (line) => t.diagnostic(line), ownershipFile } = {},
) {
  const runtimes = startedRuntimes(answer);
  const recorded = ownershipFile ? recordedRuntimeOwner(ownershipFile, { identityOf, report }) : null;
  ownedFixture(t).add(async () => {
    try {
      await endStarted();
    } finally {
      await recorded?.note();
      await recorded?.end();
    }
  });
  return runtimes;
  async function endStarted() {
    for (const runtime of runtimes) {
      if (!isAlive(runtime.pid)) continue;
      const records = runtime.ownershipFile ? await ownedSessions({ ownershipFile: runtime.ownershipFile }) : [];
      const record = records.find((entry) => entry.pid === runtime.pid);
      if (!record) {
        if (!runtime.ownershipFile)
          report(`Mirage runtime pid ${runtime.pid} (${runtime.url}) was left running: its start named no records.`);
        continue; // The test's own stop ended the runtime and removed its record.
      }
      await endRuntimes([{ pid: runtime.pid, processIdentity: record.processIdentity, url: runtime.url }], {
        identityOf,
        report,
      });
    }
  }
}

/**
 * Resolves `{ free: true }` when nothing listens on `port` any more: this process can bind it. Otherwise it resolves
 * `{ free: false, code }` with the error code of the refused bind, so a failure names EADDRINUSE or EACCES.
 */
export const portBinding = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve({ free: false, code: error.code }));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve({ free: true })));
  });

/** Resolves true when nothing listens on `port` any more: this process can bind it. */
export const portFree = async (port) => (await portBinding(port)).free;

/**
 * Starts a process of its own group that listens on a loopback port and answers every request 503, so it refuses a
 * graceful Mirage shutdown. Windows closes the handles of a terminated process in the order they were opened, after it
 * reads as exited: the files this process opens ahead of its listener keep the port bound well past that moment, so
 * a caller that takes "exited" for "released" finds the port still in use. `startToken` puts a start token on its
 * command line, as the launcher of a runtime does.
 * @returns {Promise<{child: import('node:child_process').ChildProcess, port: number}>}
 */
export async function listenerBehindOpenHandles(t, { startToken = null } = {}) {
  const held = process.platform === 'win32' ? 4000 : 0;
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const fs = require('node:fs'); globalThis.held = [];
       for (let index = 0; index < ${held}; index++) held.push(fs.openSync(process.execPath, 'r'));
       const server = require('node:http').createServer((request, response) => response.writeHead(503).end());
       server.listen(0, '127.0.0.1', () => console.log(String(server.address().port)));`,
      ...(startToken ? ['--', START_TOKEN_OPTION, startToken] : []),
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  );
  const exited = once(child, 'exit');
  ownedFixture(t).add(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const [line] = await Promise.race([
    once(child.stdout, 'data'),
    exited.then(() => Promise.reject(new Error('The listener ended before it reported its port.'))),
  ]);
  return { child, port: Number(String(line)) };
}
