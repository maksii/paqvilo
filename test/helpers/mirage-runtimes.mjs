// Test-only owner for the Mirage runtimes `mirage start` leaves running after the command has ended: when a test fails
// before its own `mirage stop`, or that stop fails, the runtimes are ended after the test so they cannot keep their
// ports, their CPU or their fixture folders.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';
import { isAlive, ownedSessions, processIdentity } from '../../lense/commands/mirage.mjs';

const OWNERSHIP = path.join('mirage', 'sessions.json');
// How often the closer looks again whether an ended runtime has gone; the test runner's limit is the hang guard.
const EXIT_POLL_MS = 100;

/**
 * Ends process `pid` and every process it started: `taskkill /t /f` on Windows (which follows the parent link of
 * detached children too); elsewhere `signal` to its process group. `missingGroup` runs when the group is already
 * gone (ESRCH).
 */
export async function endProcessTree(pid, { signal = 'SIGKILL', missingGroup = () => {} } = {}) {
  if (process.platform === 'win32') {
    await new Promise((resolve) =>
      execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => resolve()),
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

/**
 * Ends every runtime of a `recordedRuntimes` snapshot that is still running with the start identity the snapshot
 * names, whether or not its record is still in the file. A PID whose identity is missing or differs is reported and
 * never signalled: it may have been reused by another program.
 */
export async function endRuntimes(runtimes, { identityOf = processIdentity, report }) {
  for (const { pid, processIdentity: recorded, url } of runtimes) {
    if (!isAlive(pid)) continue;
    if (!recorded || identityOf(pid) !== recorded) {
      report(
        `Mirage runtime pid ${pid} (${url}) was not ended: the process holding that PID could not be confirmed to have the start identity its record names.`,
      );
      continue;
    }
    await endProcessTree(pid);
    while (isAlive(pid) && identityOf(pid) === recorded) await delay(EXIT_POLL_MS);
  }
}

/**
 * Owner of the runtimes `ownershipFile` records during a test's teardown. `note()` adds what the file records now and
 * never throws: a failed read is kept, so the teardown that called it continues. `end()` ends every noted runtime that
 * is still running and then fails with the read failures, if any; a failure is reported once.
 */
export function recordedRuntimeOwner(ownershipFile, { identityOf = processIdentity, report }) {
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
 * @returns {{pid: number, url: string, ownershipFile: string|undefined}[]} the runtimes it owns
 */
export function ownStartedRuntimes(
  t,
  answer,
  { identityOf = processIdentity, report = (line) => t.diagnostic(line) } = {},
) {
  const runtimes = startedRuntimes(answer);
  ownedFixture(t).add(async () => {
    for (const runtime of runtimes) {
      const records = runtime.ownershipFile ? await ownedSessions({ ownershipFile: runtime.ownershipFile }) : [];
      const record = records.find((entry) => entry.pid === runtime.pid);
      if (!isAlive(runtime.pid)) continue;
      if (!record) {
        if (!runtime.ownershipFile)
          report(`Mirage runtime pid ${runtime.pid} (${runtime.url}) was left running: its start named no records.`);
        continue; // The test's own stop ended the runtime and removed its record.
      }
      const recorded = record.processIdentity;
      if (!recorded || identityOf(runtime.pid) !== recorded) {
        report(
          `Mirage runtime pid ${runtime.pid} (${runtime.url}) was not ended: the process holding that PID could not be confirmed to have the start identity its record names.`,
        );
        continue;
      }
      await endProcessTree(runtime.pid);
      while (isAlive(runtime.pid) && identityOf(runtime.pid) === recorded) await delay(EXIT_POLL_MS);
    }
  });
  return runtimes;
}
