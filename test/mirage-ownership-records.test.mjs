// @test-kind contract: the ownership records are replaced whole, read strictly and locked by a live owner; local fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { spawn } from 'node:child_process';
import {
  createHeld,
  miragePaths,
  ownedSessions,
  processStartTimeMs,
  updateOwnedSessions,
} from '../lense/commands/mirage.mjs';
import { tempDir } from './fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

// No process can have this PID: Windows PIDs are multiples of 4 well below it, and Linux caps pid_max at 2^22.
const EXITED_PID = 2_147_483_646;

async function fixture(t) {
  const root = await tempDir('paq-ownership-records-');
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const paths = miragePaths({ stateDir: root });
  await fs.mkdir(path.dirname(paths.ownershipFile), { recursive: true });
  return paths;
}

const sameFile = (left, right) => path.resolve(String(left)) === path.resolve(String(right));

test('a save while a reader holds the records leaves the reader the complete previous content', async (t) => {
  const paths = await fixture(t);
  await updateOwnedSessions(paths, () => [{ pid: 1, marker: 'previous' }]);
  const previous = await fs.readFile(paths.ownershipFile, 'utf8');
  const reader = await fs.open(paths.ownershipFile, 'r');
  t.after(() => reader.close().catch(() => {}));
  // The save's first rename attempt is observed; on Windows the open reader refuses it.
  let attempted;
  const renameAttempted = new Promise((resolve) => {
    attempted = resolve;
  });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    try {
      return await rename(from, to);
    } finally {
      if (sameFile(to, paths.ownershipFile)) attempted();
    }
  });
  const writeFile = fs.writeFile;
  const inPlace = [];
  t.mock.method(fs, 'writeFile', (file, ...rest) => {
    if (sameFile(file, paths.ownershipFile)) inPlace.push(file);
    return writeFile(file, ...rest);
  });
  const save = updateOwnedSessions(paths, () => [{ pid: 2, marker: 'next' }]);
  await renameAttempted;
  // Let a refused save run whatever it does next before the reader looks again.
  await new Promise((resolve) => setImmediate(resolve));
  const text = await reader.readFile('utf8');
  assert.ok(
    text === previous || JSON.parse(text).sessions[0].marker === 'next',
    `The reader saw neither complete content: ${JSON.stringify(text)}`,
  );
  await reader.close();
  await save;
  assert.deepEqual(inPlace, [], 'The records file is never written in place.');
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.marker),
    ['next'],
  );
});

test('only a missing records file reads as no sessions; any other failure is surfaced', async (t) => {
  const paths = await fixture(t);
  assert.deepEqual(await ownedSessions(paths), []);
  await fs.writeFile(paths.ownershipFile, '{"version":1,"sessions":[{"pid":');
  await assert.rejects(ownedSessions(paths), (error) => {
    assert.match(error.message, /ownership records .* are not valid JSON/);
    // The one line the user sees says which file to inspect or remove and how the listed Mirages can still be ended.
    assert.ok(error.message.includes(`Inspect or remove ${paths.ownershipFile}`));
    assert.match(error.message, /end them by their process IDs, which the session-<pid>\.json files in .+ name\./);
    return true;
  });
  await fs.rm(paths.ownershipFile);
  await fs.mkdir(paths.ownershipFile);
  await assert.rejects(ownedSessions(paths), (error) => {
    assert.match(error.message, /Could not read the Mirage ownership records/);
    assert.notEqual(error.cause.code, 'ENOENT');
    return true;
  });
});

test('a recent lock whose owner has exited is taken over at once', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, String(EXITED_PID));
  // A third exclusive create would mean the lock was waited on instead of taken over.
  const controller = new AbortController();
  let creates = 0;
  const open = fs.open;
  t.mock.method(fs, 'open', (file, flags, ...rest) => {
    if (sameFile(file, lock) && flags === 'wx' && ++creates === 3) controller.abort();
    return open(file, flags, ...rest);
  });
  await updateOwnedSessions(paths, () => [{ pid: 7 }], { signal: controller.signal });
  assert.equal(creates, 2);
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [7],
  );
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

test('a waiter that judged a dead owner never removes the live lock another waiter created meanwhile', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, String(EXITED_PID));
  // Right after this waiter reads the dead owner, another waiter takes the lock over (this live process stands in for
  // it). The waiter is released after it has examined the lock three more times.
  const controller = new AbortController();
  let examined = 0;
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...rest) => {
    const value = await readFile(file, ...rest);
    if (sameFile(file, lock) && ++examined === 1) await fs.writeFile(lock, String(process.pid));
    if (examined === 4) controller.abort();
    return value;
  });
  let changed = false;
  await assert.rejects(
    updateOwnedSessions(
      paths,
      () => {
        changed = true;
        return [];
      },
      { signal: controller.signal },
    ),
    (error) => error.name === 'AbortError',
  );
  assert.equal(changed, false);
  assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
  assert.deepEqual(
    (await fs.readdir(path.dirname(lock))).filter((name) => name.endsWith('.stale') || name.endsWith('.breaking')),
    [],
  );
});

test('an old lock whose owner is alive is never taken over', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, String(process.pid));
  const hourAgo = new Date(Date.now() - 3_600_000);
  await fs.utimes(lock, hourAgo, hourAgo);
  // The waiter is released after it has examined the lock three times.
  const controller = new AbortController();
  let examined = 0;
  const readFile = fs.readFile;
  const stat = fs.stat;
  const examine = (file) => {
    if (sameFile(file, lock) && ++examined === 3) controller.abort();
  };
  t.mock.method(fs, 'readFile', (file, ...rest) => {
    examine(file);
    return readFile(file, ...rest);
  });
  t.mock.method(fs, 'stat', (file, ...rest) => {
    examine(file);
    return stat(file, ...rest);
  });
  let changed = false;
  await assert.rejects(
    updateOwnedSessions(
      paths,
      () => {
        changed = true;
        return [];
      },
      { signal: controller.signal },
    ),
    (error) => error.name === 'AbortError',
  );
  assert.equal(changed, false);
  assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
});

/** A monotonic clock for the lock guard that advances by `step` on every read, so the guard is reached without waiting. */
const steppingClock = (step) => {
  let now = 0;
  return () => (now += step);
};
/** A monotonic clock for the lock guard that stands where the test sets `clock.now`. */
const manualClock = () => {
  const clock = () => clock.now;
  clock.now = 0;
  return clock;
};

test('a save whose replacement stays refused ends at the hang guard with the refusal and what to do', async (t) => {
  const paths = await fixture(t);
  await updateOwnedSessions(paths, () => [{ pid: 1 }]);
  // The replacement's guard runs on the monotonic clock, which advances a second on every read here.
  let now = performance.now();
  t.mock.method(performance, 'now', () => (now += 1000));
  // A permanent refusal, as for a read-only file; the signal only turns a save that never ends into a failure here.
  const controller = new AbortController();
  let attempts = 0;
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!sameFile(to, paths.ownershipFile)) return rename(from, to);
    if (++attempts === 200) controller.abort();
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  });
  await assert.rejects(
    updateOwnedSessions(paths, () => [{ pid: 2 }], { signal: controller.signal }),
    (error) => {
      assert.ok(
        error.message.includes(`Could not replace the Mirage ownership records ${paths.ownershipFile} (EPERM)`),
      );
      assert.match(error.message, /read-only or another program keeps it open/);
      return true;
    },
  );
  assert.ok(attempts < 200, 'the hang guard, not the test, ended the save');
  assert.deepEqual(
    (await fs.readdir(path.dirname(paths.ownershipFile))).filter((name) => name !== 'sessions.json'),
    [],
    'neither the temporary file nor the lock is left behind',
  );
});

test('a lock that records no holder is taken over only after this waiter has seen it for the whole guard, whatever its file time', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  // Just created and not yet written, on a file server whose clock is a minute behind this machine.
  await fs.writeFile(lock, '');
  const minuteAgo = new Date(Date.now() - 60_000);
  await fs.utimes(lock, minuteAgo, minuteAgo);
  // The waiter's own clock passes the guard at its third look; until then the lock must still be there, unchanged.
  const clock = manualClock();
  let looks = 0;
  const seen = [];
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...rest) => {
    const value = await readFile(file, ...rest);
    if (sameFile(file, lock) && ++looks <= 3) {
      seen.push(value);
      if (looks === 3) clock.now = 30_001;
    }
    return value;
  });
  await updateOwnedSessions(paths, () => [{ pid: 3 }], { clock, platform: 'win32' });
  assert.deepEqual(seen, ['', '', ''], 'the lock was not taken over before the waiter had seen it for the guard');
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [3],
  );
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

test('a lock that records no holder and is re-created meanwhile restarts the waiter guard', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, '');
  // At the second look another creator has replaced the lock; the guard counts from that look, not from the first.
  const clock = manualClock();
  const steps = { 2: 20_000, 3: 40_000, 4: 50_001 };
  let looks = 0;
  const present = [];
  // A look reads the lock and its file information together; both wait until the test has done its step.
  let step = Promise.resolve();
  const readFile = fs.readFile;
  const stat = fs.stat;
  t.mock.method(fs, 'stat', async (file, ...rest) => {
    if (sameFile(file, lock)) await step;
    return stat(file, ...rest);
  });
  t.mock.method(fs, 'readFile', (file, ...rest) => {
    if (!sameFile(file, lock)) return readFile(file, ...rest);
    step = (async () => {
      // Only the waiter's own looks count, not the re-read of a breaker that is removing the lock.
      const breaking = await fs.access(`${lock}.breaking`).then(
        () => true,
        () => false,
      );
      if (breaking || !(++looks in steps)) return;
      if (looks === 2) {
        await fs.rm(lock);
        await fs.writeFile(lock, '');
        const earlier = new Date(Date.now() - 50_000);
        await fs.utimes(lock, earlier, earlier);
      }
      present.push(looks);
      clock.now = steps[looks];
    })();
    return step.then(() => readFile(file, ...rest));
  });
  await updateOwnedSessions(paths, () => [{ pid: 3 }], { clock, platform: 'win32' });
  assert.deepEqual(present, [2, 3, 4], 'the re-created lock was kept until the waiter had seen it for the guard');
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [3],
  );
});

test('a folder that refuses the lock ends at the hang guard with a message naming the folder', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  const clock = steppingClock(1000);
  // Windows answers an exclusive create in an unwritable folder with EPERM, and the lock then does not exist.
  const open = fs.open;
  t.mock.method(fs, 'open', (file, flags, ...rest) => {
    if (sameFile(file, lock) && flags === 'wx')
      return Promise.reject(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
    return open(file, flags, ...rest);
  });
  await assert.rejects(
    updateOwnedSessions(paths, () => [], { clock }),
    (error) => {
      assert.ok(error.message.includes(`Could not create the Mirage ownership lock in ${path.dirname(lock)}`));
      return true;
    },
  );
});

test('a folder that refuses the breaker of an abandoned lock ends at the breaker guard with a message naming both files', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, String(EXITED_PID));
  // Windows answers the exclusive create of the breaker in a folder that refuses new files with EPERM, and the breaker
  // then does not exist. The signal only ends a wait that would not end by itself.
  const controller = new AbortController();
  let refusals = 0;
  const open = fs.open;
  t.mock.method(fs, 'open', (file, flags, ...rest) => {
    if (!sameFile(file, `${lock}.breaking`) || flags !== 'wx') return open(file, flags, ...rest);
    if (++refusals === 50) controller.abort();
    return Promise.reject(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }));
  });
  await assert.rejects(
    updateOwnedSessions(paths, () => [], { clock: steppingClock(1000), signal: controller.signal }),
    (error) => {
      assert.ok(error.message.includes(`Could not create ${lock}.breaking`), error.message);
      assert.match(error.message, /the folder refuses new files\. Make the folder writable/);
      assert.ok(error.message.includes(`remove ${lock} if no Paqvilo command is running`), error.message);
      return true;
    },
  );
  assert.ok(refusals < 50, 'the breaker guard, not the test, ended the wait');
  assert.equal(await fs.readFile(lock, 'utf8'), String(EXITED_PID));
});

/** A lock in the older Mirage format whose holder has exited, and a signal that ends a wait that would not end. */
async function abandonedLock(t, breaker) {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, String(EXITED_PID));
  if (breaker) await fs.writeFile(`${lock}.breaking`, String(EXITED_PID));
  const controller = new AbortController();
  return { paths, lock, controller, options: { clock: steppingClock(1000), signal: controller.signal } };
}

test('an abandoned lock whose removal is refused for a while is removed once the refusal ends', async (t) => {
  const { paths, lock, options } = await abandonedLock(t);
  const removals = refusedRemoval(t, lock, (attempt) => attempt <= 3);
  await updateOwnedSessions(paths, () => [{ pid: 13 }], options);
  assert.equal(removals(), 5, 'three refused removals, the one that landed and the release');
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [13],
  );
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

test('an abandoned lock whose removal stays refused ends at the lock guard with a message naming it', async (t) => {
  const { paths, lock, controller, options } = await abandonedLock(t);
  const removals = refusedRemoval(t, lock, (attempt) => attempt < 50 || controller.abort());
  await assert.rejects(
    updateOwnedSessions(paths, () => [], options),
    (error) => {
      assert.ok(
        error.message.includes(`Could not remove the abandoned Mirage ownership lock ${lock} (EBUSY)`),
        error.message,
      );
      assert.equal(error.cause.code, 'EBUSY');
      return true;
    },
  );
  assert.ok(removals() < 50, 'the lock guard, not the test, ended the wait');
  assert.equal(await fs.readFile(lock, 'utf8'), String(EXITED_PID));
});

test('an ended breaker whose removal is refused for a while is removed once the refusal ends', async (t) => {
  const { paths, lock, options } = await abandonedLock(t, true);
  const removals = refusedRemoval(t, `${lock}.breaking`, (attempt) => attempt <= 3);
  await updateOwnedSessions(paths, () => [{ pid: 14 }], options);
  assert.equal(removals(), 5, "three refused removals, the one that landed and this waiter's own release");
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [14],
  );
  assert.deepEqual(
    (await fs.readdir(path.dirname(lock))).filter((name) => name !== 'sessions.json'),
    [],
    'no lock or breaker is left behind',
  );
});

test('an ended breaker whose removal stays refused ends at the breaker guard with a message naming it', async (t) => {
  const { paths, lock, controller, options } = await abandonedLock(t, true);
  const removals = refusedRemoval(t, `${lock}.breaking`, (attempt) => attempt < 50 || controller.abort());
  await assert.rejects(
    updateOwnedSessions(paths, () => [], options),
    (error) => {
      assert.ok(
        error.message.includes(
          `Could not remove ${lock}.breaking, left by process ${EXITED_PID}, which has ended (EBUSY)`,
        ),
        error.message,
      );
      return true;
    },
  );
  assert.ok(removals() < 50, 'the breaker guard, not the test, ended the wait');
});

test('a lock taken on another host is never judged here: it is kept, no start is read, and the guard names that host', async (t) => {
  for (const platform of ['win32', 'linux']) {
    const paths = await fixture(t);
    const lock = `${paths.ownershipFile}.lock`;
    // Its number names no process here, as a holder's does in another process namespace.
    const text = JSON.stringify({ pid: EXITED_PID, at: Date.now(), ticks: '1', host: 'linux/elsewhere' });
    await fs.writeFile(lock, text);
    const reader = startTimeReader(() => assert.fail('a start time was read'));
    const ticks = ticksReader(() => '2');
    await assert.rejects(
      updateOwnedSessions(paths, () => [], {
        clock: steppingClock(10_000),
        platform,
        host: 'win32/here',
        startTimeOf: reader.startTimeOf,
        readTicks: ticks.readTicks,
      }),
      (error) => {
        assert.ok(error.message.includes(`stayed locked by process ${EXITED_PID} for 30 s: ${lock}.`), error.message);
        assert.match(error.message, /It was taken on linux\/elsewhere and can only be judged there/);
        return true;
      },
    );
    assert.deepEqual(reader.asked, [], `${platform}: no start time was read`);
    assert.deepEqual(ticks.others(), [], `${platform}: no start ticks of another process were read`);
    assert.equal(await fs.readFile(lock, 'utf8'), text);
  }
});

test('a lock taken on this host, or one that names no host, is judged here, and a new lock records its host', async (t) => {
  for (const host of ['win32/here', undefined]) {
    const paths = await fixture(t);
    const lock = `${paths.ownershipFile}.lock`;
    await fs.writeFile(lock, JSON.stringify({ pid: EXITED_PID, at: Date.now(), host }));
    // A third exclusive create would mean the lock was waited on instead of taken over.
    const controller = new AbortController();
    let creates = 0;
    const open = fs.open;
    t.mock.method(fs, 'open', (file, flags, ...rest) => {
      if (sameFile(file, lock) && flags === 'wx' && ++creates === 3) controller.abort();
      return open(file, flags, ...rest);
    });
    let recorded;
    await updateOwnedSessions(
      paths,
      async () => {
        recorded = JSON.parse(await fs.readFile(lock, 'utf8')).host;
        return [{ pid: 15 }];
      },
      { host: 'win32/here', signal: controller.signal },
    );
    assert.equal(creates, 2);
    assert.equal(recorded, 'win32/here');
    await assert.rejects(fs.access(lock), { code: 'ENOENT' });
  }
});

test('a waiter that judged a dead owner never revives the lock of a waiter that took it over and released it', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, String(EXITED_PID));
  // Order forced through this waiter's reads: after it reads the dead owner, another waiter (this live process stands
  // in for it) takes the lock over; on its next look the other waiter has worked and released it.
  const controller = new AbortController();
  let looks = 0,
    otherHeld = false;
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...rest) => {
    const lockFile = String(file).startsWith(lock);
    const value = await readFile(file, ...rest).catch((error) => error);
    if (lockFile) {
      looks++;
      if (looks === 1) {
        await fs.rm(lock);
        await fs.writeFile(lock, String(process.pid));
        otherHeld = true;
      } else if (looks === 2) {
        await fs.rm(lock);
        otherHeld = false;
      } else if (looks === 20) controller.abort();
    }
    if (value instanceof Error) throw value;
    return value;
  });
  let ranWhileOtherHeld = null;
  await updateOwnedSessions(
    paths,
    (sessions) => {
      ranWhileOtherHeld = otherHeld;
      return [...sessions, { pid: 4 }];
    },
    { signal: controller.signal },
  );
  assert.equal(ranWhileOtherHeld, false);
  assert.deepEqual(
    (await fs.readdir(path.dirname(lock))).filter((name) => name !== 'sessions.json'),
    [],
    'no lock, breaker or moved lock is left behind',
  );
});

/** A start-time reader that answers `answer(pid)` and counts its reads. */
function startTimeReader(answer) {
  const asked = [];
  return {
    asked,
    startTimeOf: async (pid) => {
      asked.push(pid);
      return answer(pid);
    },
  };
}

/**
 * A lock in the older Mirage format (the PID alone) held by this live process number, taken at its file time an hour
 * ago, judged by the time rule, with a guard clock that advances 10 s on every read.
 */
async function heldByLiveNumber(t) {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  const text = String(process.pid);
  await fs.writeFile(lock, text);
  const hourAgo = new Date(Date.now() - 3_600_000);
  await fs.utimes(lock, hourAgo, hourAgo);
  const at = (await fs.stat(lock)).mtimeMs;
  return { paths, lock, text, at, options: { clock: steppingClock(10_000), platform: 'win32' } };
}

test('a lock whose live number belongs to a process started after the lock was taken is taken over at the hang guard', async (t) => {
  const { paths, lock, at, options } = await heldByLiveNumber(t);
  const reader = startTimeReader(() => at + 2_001);
  await updateOwnedSessions(paths, () => [{ pid: 5 }], { ...options, startTimeOf: reader.startTimeOf });
  assert.deepEqual(reader.asked, [process.pid], 'the holder was asked once, at the hang guard');
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [5],
  );
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

test('a lock whose live holder started before the lock was taken, or within the margin, is refused and kept', async (t) => {
  for (const started of [(at) => at - 60_000, (at) => at + 2_000]) {
    const { paths, lock, text, at, options } = await heldByLiveNumber(t);
    const reader = startTimeReader(() => started(at));
    await assert.rejects(
      updateOwnedSessions(paths, () => [], { ...options, startTimeOf: reader.startTimeOf }),
      (error) => {
        assert.ok(error.message.includes(`stayed locked by process ${process.pid} for 30 s: ${lock}.`), error.message);
        assert.match(error.message, /remove that lock file/);
        assert.doesNotMatch(error.message, /could not be read/);
        return true;
      },
    );
    assert.equal(await fs.readFile(lock, 'utf8'), text);
  }
});

test('a lock whose live holder start time cannot be read is kept, and the message says so', async (t) => {
  const { paths, lock, text, options } = await heldByLiveNumber(t);
  const reader = startTimeReader(() => null);
  await assert.rejects(
    updateOwnedSessions(paths, () => [], { ...options, startTimeOf: reader.startTimeOf }),
    (error) => {
      assert.match(error.message, /Its start time could not be read, so the lock is kept\./);
      return true;
    },
  );
  assert.equal(await fs.readFile(lock, 'utf8'), text);
});

/** A reader of start ticks (`self`: this process) that answers `answer(pid)` and counts its reads. */
function ticksReader(answer) {
  const asked = [];
  return {
    asked,
    others: () => asked.filter((pid) => pid !== 'self'),
    readTicks: async (pid) => {
      asked.push(pid);
      return answer(pid);
    },
  };
}

test('no start is read and no process started for a free lock or one released before the hang guard', async (t) => {
  let started = 0;
  const onChild = () => started++;
  subscribe('child_process', onChild);
  t.after(() => unsubscribe('child_process', onChild));
  for (const platform of [process.platform, 'linux']) {
    const paths = await fixture(t);
    const lock = `${paths.ownershipFile}.lock`;
    const reader = startTimeReader(() => assert.fail('a start time was read'));
    // On Linux the holder reads its own start ticks once, at its first lock; no other process is read.
    const ticks = ticksReader((pid) => (pid === 'self' ? '4242' : assert.fail('another process was read')));
    const options = { platform, startTimeOf: reader.startTimeOf, readTicks: ticks.readTicks };
    await updateOwnedSessions(paths, () => [{ pid: 1 }], options);
    // Held by this live process number; released on the waiter's third look.
    await fs.writeFile(lock, String(process.pid));
    let looks = 0;
    const readFile = fs.readFile;
    t.mock.method(fs, 'readFile', async (file, ...rest) => {
      const value = await readFile(file, ...rest);
      if (sameFile(file, lock) && ++looks === 3) await fs.rm(lock);
      return value;
    });
    await updateOwnedSessions(paths, (sessions) => [...sessions, { pid: 2 }], options);
    t.mock.restoreAll();
    assert.ok(looks >= 3, 'the second update waited for the lock');
    assert.deepEqual(reader.asked, []);
    assert.deepEqual(ticks.asked, platform === 'linux' ? ['self'] : [], 'at most one read, of this process itself');
    assert.equal(started, 0, 'no process was started to take the lock');
    assert.deepEqual(
      (await ownedSessions(paths)).map((item) => item.pid),
      [1, 2],
    );
  }
});

test('on Windows and ps platforms a live holder is never taken over, whatever step the wall clock took before its take', async (t) => {
  for (const step of [3_000, 3_600_000, 30 * 86_400_000]) {
    const paths = await fixture(t);
    const lock = `${paths.ownershipFile}.lock`;
    // This process takes the lock after the wall clock has been stepped back by `step` since it started.
    const wall = Date.now;
    t.mock.method(Date, 'now', () => wall() - step);
    assert.equal(await createHeld(lock, { platform: 'win32' }), true);
    t.mock.restoreAll();
    const text = await fs.readFile(lock, 'utf8');
    // The system reports this process's start a little before its clock origin, as Windows does.
    const reader = startTimeReader(() => performance.timeOrigin - 20);
    await assert.rejects(
      updateOwnedSessions(paths, () => [], {
        clock: steppingClock(10_000),
        platform: 'win32',
        startTimeOf: reader.startTimeOf,
      }),
      (error) => error.message.includes(`stayed locked by process ${process.pid} for 30 s`),
    );
    assert.deepEqual(reader.asked, [process.pid]);
    assert.equal(await fs.readFile(lock, 'utf8'), text, `kept after a ${step} ms step`);
  }
  // A process that started after the stamp is another program with the reused number.
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  assert.equal(await createHeld(lock, { platform: 'win32' }), true);
  const { at } = JSON.parse(await fs.readFile(lock, 'utf8'));
  const reader = startTimeReader(() => at + 2_001);
  const options = { clock: steppingClock(10_000), platform: 'win32', startTimeOf: reader.startTimeOf };
  await updateOwnedSessions(paths, () => [{ pid: 8 }], options);
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [8],
  );
});

/** A lock with a Linux record held by this live process number, taken five seconds ago. */
async function linuxLock(t, record) {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  const text = JSON.stringify({ pid: process.pid, at: Date.now() - 5_000, ...record });
  await fs.writeFile(lock, text);
  return { paths, lock, text, options: { clock: steppingClock(10_000), platform: 'linux' } };
}

test('on Linux a live holder with the recorded start ticks is refused, even after a forward clock step', async (t) => {
  // The holder started 50 s after boot (5000 ticks at 100 a second) and took the lock 5 s later. Then the clock was
  // stepped 8 s forward: Linux start times follow the current clock, so the time rule would call the holder reused.
  const boot = 1_700_000_000_000;
  const at = boot + 55_000;
  const proc = {
    '/proc/stat': `btime ${(boot + 8_000) / 1000}\n`,
    '/proc/self/stat': `1 (node) S ${[...Array(18).fill('0'), '5000', '0'].join(' ')}`,
  };
  const startTimeOf = async (pid) =>
    processStartTimeMs(pid, {
      platform: 'linux',
      identityOf: async () => '5000',
      readText: async (file) => proc[file],
      now: () => boot + 8_000 + 50_000 + 7_000,
      uptimeMs: () => 7_000,
    });
  assert.ok((await startTimeOf(process.pid)) > at + 2_000, 'the time rule alone would take the lock over');
  const { paths, lock, text, options } = await linuxLock(t, { at, ticks: '5000' });
  const ticks = ticksReader((pid) => (pid === 'self' ? '7777' : '5000'));
  await assert.rejects(
    updateOwnedSessions(paths, () => [], { ...options, startTimeOf, readTicks: ticks.readTicks }),
    (error) => error.message.includes(`stayed locked by process ${process.pid} for 30 s`),
  );
  assert.deepEqual(ticks.others(), [process.pid]);
  assert.equal(await fs.readFile(lock, 'utf8'), text);
});

test('on Linux a live number with other start ticks is taken over, and the new lock records its own', async (t) => {
  const { paths, lock, options } = await linuxLock(t, { ticks: '5000' });
  const reader = startTimeReader(() => assert.fail('the time rule was asked'));
  const ticks = ticksReader((pid) => (pid === 'self' ? '7777' : '5001'));
  let record;
  await updateOwnedSessions(
    paths,
    async () => {
      record = JSON.parse(await fs.readFile(lock, 'utf8'));
      return [{ pid: 9 }];
    },
    { ...options, startTimeOf: reader.startTimeOf, readTicks: ticks.readTicks },
  );
  assert.deepEqual(ticks.others(), [process.pid]);
  assert.equal(ticks.asked.filter((pid) => pid === 'self').length, 1, 'its own ticks were read once');
  assert.equal(record.pid, process.pid);
  assert.equal(record.ticks, '7777');
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [9],
  );
});

test('on Linux a live holder whose start ticks cannot be read is kept, and the message says so', async (t) => {
  const { paths, lock, text, options } = await linuxLock(t, { ticks: '5000' });
  const ticks = ticksReader((pid) => (pid === 'self' ? '7777' : null));
  await assert.rejects(
    updateOwnedSessions(paths, () => [], { ...options, readTicks: ticks.readTicks }),
    /Its start time could not be read, so the lock is kept\./,
  );
  assert.equal(await fs.readFile(lock, 'utf8'), text);
});

test('on Linux a lock without start ticks, from an older toolkit, is judged by the time rule', async (t) => {
  const { paths, text, options } = await linuxLock(t, {});
  const { at } = JSON.parse(text);
  const reader = startTimeReader(() => at + 2_001);
  const ticks = ticksReader((pid) => (pid === 'self' ? '7777' : assert.fail('ticks were compared')));
  await updateOwnedSessions(paths, () => [{ pid: 10 }], {
    ...options,
    startTimeOf: reader.startTimeOf,
    readTicks: ticks.readTicks,
  });
  assert.deepEqual(reader.asked, [process.pid]);
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [10],
  );
});

test(
  'the real start ticks this process records are the ones another process reads for it',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const paths = await fixture(t);
    const lock = `${paths.ownershipFile}.lock`;
    assert.equal(await createHeld(lock), true);
    const { ticks } = JSON.parse(await fs.readFile(lock, 'utf8'));
    assert.match(ticks, /^\d+$/);
    const read = spawn(process.execPath, [
      '-e',
      `const s = require('fs').readFileSync('/proc/${process.pid}/stat', 'utf8'); process.stdout.write(s.slice(s.lastIndexOf(')') + 2).split(' ')[19]);`,
    ]);
    let output = '';
    read.stdout.on('data', (chunk) => (output += chunk));
    await new Promise((resolve) => read.once('close', resolve));
    assert.equal(output, ticks);
    // A waiter at its guard therefore finds this live holder by its real ticks and keeps the lock.
    await assert.rejects(
      updateOwnedSessions(paths, () => [], { clock: steppingClock(10_000) }),
      (error) => error.message.includes(`stayed locked by process ${process.pid} for 30 s`),
    );
  },
);

test('three waiters on one abandoned lock all take it in turn', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  const abandoned = JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 });
  await fs.writeFile(lock, abandoned);
  // Three commands, each with its own copy of the module (its own queue and locks), as three processes have.
  const waiters = await Promise.all(
    [1, 2, 3].map((n) => import(new URL(`../lense/commands/mirage.mjs?waiter=${n}`, import.meta.url).href)),
  );
  // Each waiter reads one clock through its own function. A waiter first reads it to start its watch on the abandoned
  // lock, which nobody can remove before the guard ends. The clock steps past the guard once all three have started
  // their watch, whatever order their looks complete in, and then stands still, so each waiter's guard for a lock
  // another waiter took never ends: they can only take the lock in turn.
  let now = 0;
  const watching = new Set();
  const clockOf = (waiter) => () => {
    const reading = now;
    if (watching.add(waiter).size === waiters.length) now = 30_001;
    return reading;
  };
  // The first waiter to remove the abandoned lock does so only after the others have twice found it removing it.
  const othersWaited = Promise.withResolvers();
  let busy = 0;
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...rest) => {
    const value = await readFile(file, ...rest);
    if (sameFile(file, `${lock}.breaking`) && ++busy === 2) othersWaited.resolve();
    return value;
  });
  const rm = fs.rm;
  let removals = 0;
  t.mock.method(fs, 'rm', async (file, ...rest) => {
    if (sameFile(file, lock) && ++removals === 1) await othersWaited.promise;
    return rm(file, ...rest);
  });
  const reader = startTimeReader(() => JSON.parse(abandoned).at + 2_001);
  const options = { platform: 'win32', startTimeOf: reader.startTimeOf };
  await Promise.all(
    waiters.map((waiter, index) =>
      waiter.updateOwnedSessions(paths, (sessions) => [...sessions, { pid: 20 + index }], {
        ...options,
        clock: clockOf(waiter),
      }),
    ),
  );
  assert.deepEqual((await ownedSessions(paths)).map((item) => item.pid).sort(), [20, 21, 22]);
  assert.deepEqual(
    (await fs.readdir(path.dirname(lock))).filter((name) => name !== 'sessions.json'),
    [],
    'no lock or breaker is left behind',
  );
});

test('a lock that becomes free exactly when the guard ends is taken', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, String(process.pid));
  // The guard ends at the waiter's second look, which still finds the lock held; the holder releases it just before
  // the waiter's next exclusive create (its third).
  const clock = manualClock();
  let looks = 0,
    creates = 0;
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', (file, ...rest) => {
    if (sameFile(file, lock) && ++looks === 2) clock.now = 30_001;
    return readFile(file, ...rest);
  });
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, flags, ...rest) => {
    if (sameFile(file, lock) && flags === 'wx' && ++creates === 3) await fs.rm(lock);
    return open(file, flags, ...rest);
  });
  const reader = startTimeReader(() => assert.fail('the start of a holder that released its lock was read'));
  await updateOwnedSessions(paths, () => [{ pid: 11 }], { clock, platform: 'win32', startTimeOf: reader.startTimeOf });
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [11],
  );
});

test('a holder that has exited never has its start read, also when its removal must wait for another breaker', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, String(EXITED_PID));
  // Another waiter (this live process stands in for it) is removing the lock; it finishes at the second look, which
  // is also when this waiter's guard ends.
  await fs.writeFile(`${lock}.breaking`, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const clock = manualClock();
  let looks = 0;
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...rest) => {
    const value = await readFile(file, ...rest);
    if (sameFile(file, lock) && ++looks === 2) {
      clock.now = 30_001;
      await fs.rm(`${lock}.breaking`);
    }
    return value;
  });
  const reader = startTimeReader(() => assert.fail('a start time was read'));
  await updateOwnedSessions(paths, () => [{ pid: 12 }], { clock, platform: 'win32', startTimeOf: reader.startTimeOf });
  assert.deepEqual(reader.asked, []);
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [12],
  );
});

test('a breaker that another live process keeps past the guard ends the wait with a message naming it', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  await fs.writeFile(lock, String(EXITED_PID));
  const breaker = JSON.stringify({ pid: process.pid, at: Date.now() });
  await fs.writeFile(`${lock}.breaking`, breaker);
  const reader = startTimeReader(() => performance.timeOrigin - 20);
  await assert.rejects(
    updateOwnedSessions(paths, () => [], {
      clock: steppingClock(10_000),
      platform: 'win32',
      startTimeOf: reader.startTimeOf,
    }),
    (error) => error.message.includes(`${lock}.breaking`) && error.message.includes(`process ${process.pid}`),
  );
  assert.equal(await fs.readFile(`${lock}.breaking`, 'utf8'), breaker);
  assert.equal(await fs.readFile(lock, 'utf8'), String(EXITED_PID));
});

/** Fails the removal of `file` while `refuse()` is true, as Windows does while another program has it open. */
function refusedRemoval(t, file, refuse) {
  const rm = fs.rm;
  let refusals = 0;
  t.mock.method(fs, 'rm', (target, ...rest) => {
    if (sameFile(target, file) && refuse(++refusals))
      return Promise.reject(Object.assign(new Error('resource busy'), { code: 'EBUSY' }));
    return rm(target, ...rest);
  });
  return () => refusals;
}

test('a release whose removal is refused a few times is retried until it lands', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  const attempts = refusedRemoval(t, lock, (attempt) => attempt <= 3);
  const warnings = [];
  await updateOwnedSessions(paths, () => [{ pid: 1 }], { warn: (message) => warnings.push(message) });
  assert.equal(attempts(), 4);
  assert.deepEqual(warnings, []);
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

test('a release that never lands is reported once, keeps the result, and this process takes its own lock again', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  let refuse = true;
  refusedRemoval(t, lock, () => refuse);
  const warnings = [];
  const warn = (message) => warnings.push(message);
  const result = await updateOwnedSessions(paths, () => [{ pid: 1 }], { warn });
  assert.deepEqual(
    result.map((item) => item.pid),
    [1],
  );
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(`Could not remove the lock file ${lock} (EBUSY)`), warnings[0]);
  assert.match(warnings[0], /remove that file by hand/);
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).pid, process.pid);
  // The next update takes the leftover at once: its first exclusive create already holds the lock.
  refuse = false;
  const controller = new AbortController();
  let looks = 0;
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', (file, ...rest) => {
    if (sameFile(file, lock) && ++looks === 2) controller.abort();
    return readFile(file, ...rest);
  });
  await updateOwnedSessions(paths, (sessions) => [...sessions, { pid: 2 }], {
    warn,
    signal: controller.signal,
    clock: manualClock(),
  });
  assert.equal(looks, 1, 'the leftover was read once, by the create that took it again');
  assert.equal(warnings.length, 1);
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [1, 2],
  );
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

test('a leftover lock removed by hand is no longer the own lock of this process once the lock is taken afresh', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  // The lock stamp's monotonic clock stands still, so every record this process writes has the same text.
  t.mock.method(performance, 'now', () => 1000);
  let refuse = true;
  refusedRemoval(t, lock, () => refuse);
  const warnings = [];
  const options = { platform: 'win32', warn: (message) => warnings.push(message) };
  await updateOwnedSessions(paths, () => [{ pid: 1 }], options);
  assert.equal(warnings.length, 1, 'the first release left the lock behind');
  refuse = false;
  await fs.rm(lock);
  // While the next update holds a fresh lock, another chain in this process must not enter it as its leftover.
  let enteredBeside;
  await updateOwnedSessions(
    paths,
    async (sessions) => {
      enteredBeside = await createHeld(lock, { platform: 'win32' });
      return [...sessions, { pid: 2 }];
    },
    options,
  );
  assert.equal(enteredBeside, false);
  assert.equal(warnings.length, 1);
  await assert.rejects(fs.access(lock), { code: 'ENOENT' });
});

/** A live process other than this one, owned by the test: a node child that exits when its stdin ends. */
function liveChild(t) {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const closed = new Promise((resolve) => child.once('close', resolve));
  ownedFixture(t).add(() => {
    child.stdin.end();
    return closed;
  });
  assert.ok(Number.isInteger(child.pid), 'the holder process started');
  return child.pid;
}

test('a lock another live process holds where this process left its own is still refused', async (t) => {
  const paths = await fixture(t);
  const lock = `${paths.ownershipFile}.lock`;
  let refuse = true;
  refusedRemoval(t, lock, () => refuse);
  const warnings = [];
  await updateOwnedSessions(paths, () => [{ pid: 1 }], { warn: (message) => warnings.push(message) });
  assert.equal(warnings.length, 1);
  // The leftover is gone and another live process holds a lock of its own there now.
  refuse = false;
  const holder = liveChild(t);
  const text = JSON.stringify({ pid: holder, at: Date.now() });
  await fs.rm(lock);
  await fs.writeFile(lock, text);
  const reader = startTimeReader(() => Date.now() - 60_000);
  await assert.rejects(
    updateOwnedSessions(paths, () => [], {
      clock: steppingClock(10_000),
      platform: 'win32',
      startTimeOf: reader.startTimeOf,
    }),
    (error) => error.message.includes(`stayed locked by process ${holder} for 30 s`),
  );
  assert.equal(await fs.readFile(lock, 'utf8'), text);
});

const identity = (value) => async () => value;

test('a Windows start time is converted from its ticks', async () => {
  const ms = Date.UTC(2026, 10, 13, 17, 3, 5, 123);
  const ticks = String(621_355_968_000_000_000n + BigInt(ms) * 10_000n + 9_999n);
  assert.equal(await processStartTimeMs(4, { platform: 'win32', identityOf: identity(ticks) }), ms);
  assert.equal(await processStartTimeMs(4, { platform: 'win32', identityOf: identity(null) }), null);
  assert.equal(await processStartTimeMs(4, { platform: 'win32', identityOf: identity('not ticks') }), null);
});

test('a Linux start time is converted at the tick rate that gives this process its own start time', async () => {
  const boot = 1_700_000_000_000;
  const stat = (ticks) => `123 (no de) S ${[...Array(18).fill('0'), String(ticks), '0'].join(' ')}`;
  const files = { '/proc/stat': 'cpu  1 2 3\nbtime 1700000000\nprocesses 9\n', '/proc/self/stat': stat(5_000) };
  const readText = async (file) => files[file];
  const linux = (now) => ({
    platform: 'linux',
    identityOf: identity('6000'),
    readText,
    now: () => now,
    uptimeMs: () => 7_000,
  });
  // At 100 ticks a second this process started 50 s after boot; at 1000 ticks a second, 5 s after.
  assert.equal(await processStartTimeMs(9, linux(boot + 50_000 + 7_000)), boot + 60_000);
  assert.equal(await processStartTimeMs(9, linux(boot + 5_000 + 7_000)), boot + 6_000);
  assert.equal(await processStartTimeMs(9, linux(boot + 30_000)), null, 'no tick rate agrees');
  const unreadable = { ...linux(0), readText: async () => Promise.reject(new Error('no /proc')) };
  assert.equal(await processStartTimeMs(9, unreadable), null);
});

test('a ps start time is read only in its unambiguous C-locale form', async (t) => {
  const zone = process.env.TZ;
  t.after(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  process.env.TZ = 'Europe/Berlin';
  const ps = (text) => processStartTimeMs(9, { platform: 'darwin', identityOf: identity(text) });
  assert.equal(await ps('Fri Nov 13 18:03:05 2026'), new Date(2026, 10, 13, 18, 3, 5).getTime());
  assert.equal(await ps('Fri Nov  6 08:03:05 2026'), new Date(2026, 10, 6, 8, 3, 5).getTime());
  assert.equal(await ps('Fr 13 Nov 18:03:05 2026'), null, 'another locale');
  assert.equal(await ps('Mon Feb 30 10:00:00 2026'), null, 'no such day');
  assert.equal(await ps('Sun Mar 29 02:30:00 2026'), null, 'a skipped hour');
  assert.equal(await ps('Sun Oct 25 02:30:00 2026'), null, 'a repeated hour');
});
