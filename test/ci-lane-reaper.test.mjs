// @test-kind tooling: a validation run ends the lane trees an interrupted earlier run left running
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { makeTemporaryDirectorySync, removeFixtureDirectory } from '../mirage/testing/owned-fixture.mjs';
import { endLaneTree, reapLanes, runSteps } from '../scripts/ci.mjs';
import { acquireCiWorkspaceLease } from '../scripts/ci-workspace-lease.mjs';
import { isAlive, processIdentity, processIdentityAsync } from '../lense/process-identity.mjs';

// A lane root that starts a grandchild sharing its output, then prints the grandchild's PID as its readiness line.
const LANE_ROOT = [
  "const { spawn } = require('node:child_process');",
  "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
  'console.log(grandchild.pid);',
  'setInterval(() => {}, 1000);',
].join('\n');

function fixture(t) {
  const directory = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paq-ci-lane-reaper-'));
  t.after(() => removeFixtureDirectory(directory));
  const runs = path.join(directory, '.paqvilo', 'ci', 'runs');
  const run = path.join(runs, 'run-1');
  fs.mkdirSync(run, { recursive: true });
  const write = (records) => fs.writeFileSync(path.join(run, 'lanes.json'), JSON.stringify(records));
  return { directory, runs, run, write };
}

/** A lane that stays alive until the sentinel file exists. It watches the sentinel's folder, so it ends on the event. */
function sentinelLane(sentinel) {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const sentinel = ${JSON.stringify(sentinel)};`,
    'const finish = () => process.exit(0);',
    'fs.watch(path.dirname(sentinel), () => { if (fs.existsSync(sentinel)) finish(); });',
    'if (fs.existsSync(sentinel)) finish();',
  ].join('\n');
}

/** Runs one validation step whose lane stays alive until `finish` is called. Its record lives in `runs/lanes.json`. */
function startLane(directory, runs, label, options = {}) {
  const sentinel = path.join(runs, `${label}.finish`);
  const running = runSteps([{ label, commands: [['-e', sentinelLane(sentinel)]] }], 1, {
    cwd: directory,
    logs: path.join(runs, 'logs'),
    ...options,
  });
  running.catch(() => {}); // reported by finish
  return {
    record: path.join(runs, 'lanes.json'),
    async finish() {
      fs.writeFileSync(sentinel, '');
      await running;
    },
  };
}

/** Resolves once `file` exists. The folder's change events wake the wait, so nothing polls. */
function waitForFile(file) {
  return new Promise((resolve) => {
    if (fs.existsSync(file)) return resolve();
    const watcher = fs.watch(path.dirname(file), () => {
      if (!fs.existsSync(file)) return;
      watcher.close();
      resolve();
    });
    if (fs.existsSync(file)) {
      watcher.close();
      resolve();
    }
  });
}

test('a validation run ends the lane trees an interrupted earlier run left running', async (t) => {
  const { runs, run, write } = fixture(t);
  // detached as a lane is on POSIX: the lane leads its own process group, which the stop signals.
  const lane = spawn(process.execPath, ['-e', LANE_ROOT], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  t.after(() => lane.kill('SIGKILL'));
  const laneExited = once(lane, 'exit');
  const laneOutputClosed = once(lane.stdout, 'close');
  const [readiness] = await once(readline.createInterface({ input: lane.stdout }), 'line');
  const grandchild = Number(readiness);
  t.after(() => {
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {
      /* already ended */
    }
  });
  write([{ pid: lane.pid, identity: processIdentity(lane.pid), label: 'unit' }]);

  const stopped = [];
  await reapLanes(runs, {
    stopTree: (pid) => {
      stopped.push(pid);
      return endLaneTree(pid);
    },
  });

  assert.deepEqual(stopped, [lane.pid]);
  await laneExited;
  // The grandchild holds the lane's output pipe, so the pipe closes when the grandchild has exited.
  await laneOutputClosed;
  assert.equal(isAlive(grandchild) && !/\) Z /.test(readStat(grandchild)), false, 'the grandchild ended with its lane');
  assert.equal(fs.existsSync(path.join(run, 'lanes.json')), false, 'the record is removed once its tree has ended');
});

test('a lane record whose PID has another start identity is dropped and its process is not signalled', async (t) => {
  const { runs, run, write } = fixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => unrelated.kill('SIGKILL'));
  const unrelatedExited = once(unrelated, 'exit');
  await once(unrelated, 'spawn');
  write([{ pid: unrelated.pid, identity: 'recorded-for-an-earlier-process', label: 'unit' }]);

  const stopped = [];
  await reapLanes(runs, {
    identityOf: () => 'the-identity-of-a-process-that-reused-the-pid',
    stopTree: (pid) => {
      stopped.push(pid);
      return endLaneTree(pid);
    },
  });

  assert.deepEqual(stopped, []);
  assert.equal(isAlive(unrelated.pid), true, 'the unrelated process is left running');
  assert.equal(fs.existsSync(path.join(run, 'lanes.json')), false, 'the stale record is dropped');
  unrelated.kill('SIGKILL');
  await unrelatedExited;
});

test('a validation lane is recorded while it runs, and its record is removed when it ends', async (t) => {
  const { directory, runs } = fixture(t);
  const lane = startLane(directory, runs, 'recorded');
  await waitForFile(lane.record);
  const [entry] = JSON.parse(fs.readFileSync(lane.record, 'utf8'));
  assert.equal(entry.label, 'recorded');
  assert.equal(typeof entry.identity, 'string', 'the record carries the lane process start identity');
  assert.equal(isAlive(entry.pid), true);
  await lane.finish();
  assert.equal(fs.existsSync(lane.record), false, 'the record is removed once the lane has ended');
});

test('a lane whose start identity cannot be read is logged and never recorded', async (t) => {
  const { directory, runs } = fixture(t);
  const log = t.mock.method(console, 'log');
  const lane = startLane(directory, runs, 'unidentified', { laneIdentity: async () => null });
  await lane.finish();
  assert.equal(fs.existsSync(lane.record), false, 'no record is written without an identity');
  const messages = log.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(
    messages.some(
      (message) => message.includes('"unidentified" is not recorded') && message.includes('cannot be read'),
    ),
    'the unrecorded lane is named in the log',
  );
});

test('a lane of the current run is not reaped while it runs', async (t) => {
  const { directory, runs } = fixture(t);
  const lane = startLane(directory, runs, 'live');
  try {
    await waitForFile(lane.record);
    const [entry] = JSON.parse(fs.readFileSync(lane.record, 'utf8'));
    const stopped = [];
    await reapLanes(runs, {
      stopTree: (pid) => {
        stopped.push(pid);
        return endLaneTree(pid);
      },
    });
    assert.deepEqual(stopped, []);
    assert.equal(isAlive(entry.pid), true, 'the running lane is left alone');
    assert.equal(fs.existsSync(lane.record), true, 'its record is kept');
  } finally {
    await lane.finish();
  }
});

test('a corrupt lane record is logged once and removed, and nothing is ended from it', async (t) => {
  const { runs, run } = fixture(t);
  const file = path.join(run, 'lanes.json');
  fs.writeFileSync(file, '{"pid": ');
  const log = t.mock.method(console, 'log');
  const stopped = [];
  await reapLanes(runs, {
    stopTree: (pid) => {
      stopped.push(pid);
      return Promise.resolve();
    },
  });
  assert.deepEqual(stopped, []);
  assert.equal(fs.existsSync(file), false, 'the corrupt record is removed');
  const unreadable = log.mock.calls.filter((call) => String(call.arguments[0]).includes('is unreadable'));
  assert.equal(unreadable.length, 1, 'the corrupt record is reported once');
});

test('a member that inherited the lease does not reap the lanes of its owner', async (t) => {
  const { directory, runs } = fixture(t);
  const lane = startLane(directory, runs, 'owned');
  try {
    await waitForFile(lane.record);
    const [entry] = JSON.parse(fs.readFileSync(lane.record, 'utf8'));
    const stopped = [];
    await runSteps([], 1, {
      cwd: directory,
      logs: path.join(runs, 'logs'),
      // The marker an inherited member sees names the owner, which is another process.
      environment: { PAQ_CI_WORKSPACE_LEASE: JSON.stringify({ root: directory, pid: process.ppid, token: 'owner' }) },
      stopTree: (pid) => {
        stopped.push(pid);
        return endLaneTree(pid);
      },
    });
    assert.deepEqual(stopped, []);
    assert.equal(isAlive(entry.pid), true, 'the owner lane keeps running');
  } finally {
    await lane.finish();
  }
});

test('a lease whose owner has ended is taken over, and the orphaned lane it left is reaped', async (t) => {
  const { directory, runs } = fixture(t);
  const lock = path.join(directory, '.paqvilo', 'ci', 'workspace.lock');
  const ended = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await once(ended, 'exit');
  fs.mkdirSync(path.join(lock, 'members'), { recursive: true });
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({
      root: fs.realpathSync(directory),
      pid: ended.pid,
      token: 'ended-run',
      identity: 'the-identity-the-ended-owner-had',
    }),
  );
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(() => {
    try {
      orphan.kill('SIGKILL');
    } catch {
      /* already ended */
    }
  });
  const orphanExited = once(orphan, 'exit');
  await once(orphan, 'spawn');
  fs.writeFileSync(
    path.join(runs, 'lanes.json'),
    JSON.stringify([{ pid: orphan.pid, identity: processIdentity(orphan.pid), label: 'orphan' }]),
  );

  const environment = {};
  const release = await acquireCiWorkspaceLease(directory, environment);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).pid, process.pid, 'taken over');
  await runSteps([], 1, { cwd: directory, logs: path.join(runs, 'logs'), environment });
  await orphanExited;
  assert.equal(fs.existsSync(path.join(runs, 'lanes.json')), false, 'the orphan record is removed');
  await release();
});

test('an interrupted run ends its lanes, removes their records and releases its lease before it exits', async (t) => {
  const { directory, runs } = fixture(t);
  const lock = path.join(directory, '.paqvilo', 'ci', 'workspace.lock');
  const ci = new URL('../scripts/ci.mjs', import.meta.url).href;
  const lease = new URL('../scripts/ci-workspace-lease.mjs', import.meta.url).href;
  // The child stands in for a runner interrupted while its lane runs. It reports the lane PID on stdout (a synchronous
  // write, so it survives the exit) and then raises SIGINT in-process.
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { acquireCiWorkspaceLease } from ${JSON.stringify(lease)};
    import { endOnShutdown, runSteps } from ${JSON.stringify(ci)};
    const runs = ${JSON.stringify(runs)};
    const record = path.join(runs, 'lanes.json');
    const environment = {};
    const release = await acquireCiWorkspaceLease(${JSON.stringify(directory)}, environment);
    endOnShutdown(release);
    runSteps([{ label: 'interrupted', commands: [['-e', 'setInterval(() => {}, 1000)']] }], 1, {
      cwd: ${JSON.stringify(directory)},
      logs: path.join(runs, 'logs'),
      environment,
    }).catch(() => {});
    await new Promise((resolve) => {
      const watcher = fs.watch(runs, () => {
        if (!fs.existsSync(record)) return;
        watcher.close();
        resolve();
      });
      if (fs.existsSync(record)) {
        watcher.close();
        resolve();
      }
    });
    fs.writeSync(1, 'lane-pid ' + JSON.parse(fs.readFileSync(record, 'utf8'))[0].pid + '\\n');
    process.emit('SIGINT');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  const [code] = await once(child, 'close');
  // The runner's own [ci] lines share stdout with the PID line, so the PID is matched rather than read whole.
  const lanePid = Number(output.match(/^lane-pid (\d+)$/m)?.[1]);
  assert.ok(Number.isInteger(lanePid) && lanePid > 0, `the child reported its lane PID ${errors}`);
  assert.equal(code, 130, 'the run exits with the SIGINT code');
  assert.equal(isAlive(lanePid), false, 'its lane tree has ended');
  assert.equal(fs.existsSync(path.join(runs, 'lanes.json')), false, 'its lane record is removed');
  assert.equal(fs.existsSync(lock), false, 'its workspace lease is released');
});

/** The /proc stat line of a process, or '' where /proc is not available. */
function readStat(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return '';
  }
}

test('the asynchronous process identity read agrees with the synchronous one', async () => {
  const identity = processIdentity(process.pid);
  assert.match(identity, /\S/, 'this process has a readable identity');
  assert.equal(await processIdentityAsync(process.pid), identity);
  assert.equal(await processIdentityAsync(0), null);
});
