// @test-kind contract: the administration client reads the open view's data by one load at a time
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneAtATime } from '../admin/view-common.mjs';

test('a view load asked for during another starts after it and is shared by every waiting caller', async () => {
  const gates = [];
  const order = [];
  const load = oneAtATime(async () => {
    const run = gates.length;
    order.push(`start ${run}`);
    const gate = Promise.withResolvers();
    gates.push(gate);
    await gate.promise;
    order.push(`end ${run}`);
    return run;
  });
  const first = load();
  await Promise.resolve();
  assert.deepEqual(order, ['start 0']);
  // Two callers ask while the first load is unanswered: neither starts a second read beside it.
  const second = load();
  const third = load();
  assert.equal(second, third);
  gates[0].resolve();
  assert.equal(await first, 0);
  assert.equal(await Promise.race([second, new Promise((resolve) => setImmediate(resolve, 'waiting'))]), 'waiting');
  assert.deepEqual(order, ['start 0', 'end 0', 'start 1']);
  gates[1].resolve();
  assert.equal(await second, 1);
  assert.deepEqual(order, ['start 0', 'end 0', 'start 1', 'end 1']);
});

test('a failed view load reaches its callers and does not stop the next load', async () => {
  let calls = 0;
  const load = oneAtATime(async () => {
    calls += 1;
    if (calls === 1) throw new Error('unavailable');
    return calls;
  });
  await assert.rejects(load(), /unavailable/);
  assert.equal(await load(), 2);
});
