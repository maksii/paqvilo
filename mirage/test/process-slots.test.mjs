import test from 'node:test';
import assert from 'node:assert/strict';
import { withProcessSlot } from './process-slots.mjs';

test('process slots never run more than the limit at once and run every call', async () => {
  let running = 0,
    peak = 0;
  const job = async (value) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return value;
  };
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => withProcessSlot(() => job(index), 3)));
  assert.deepEqual(
    results,
    Array.from({ length: 12 }, (_, index) => index),
  );
  assert.equal(peak, 3);
  await assert.rejects(
    withProcessSlot(async () => {
      throw new Error('child failed');
    }, 1),
    /child failed/,
  );
  assert.equal(
    await withProcessSlot(() => job('after a failure'), 1),
    'after a failure',
    'a failed call releases its slot',
  );
});

test('process slots count each limit separately, so a stricter caller is never handed an extra slot', async () => {
  const running = { wide: 0, narrow: 0 },
    peak = { wide: 0, narrow: 0 };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const job = (kind) => async () => {
    running[kind]++;
    peak[kind] = Math.max(peak[kind], running[kind]);
    await gate;
    running[kind]--;
  };
  const all = [
    ...Array.from({ length: 3 }, () => withProcessSlot(job('wide'), 3)),
    ...Array.from({ length: 2 }, () => withProcessSlot(job('narrow'), 1)),
  ];
  // Every admitted job has started once the pending promise reactions have run.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(running, { wide: 3, narrow: 1 }, 'a full wide pool does not hold back the narrow one');
  release();
  await Promise.all(all);
  assert.deepEqual(peak, { wide: 3, narrow: 1 });
});
