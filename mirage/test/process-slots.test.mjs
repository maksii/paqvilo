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
