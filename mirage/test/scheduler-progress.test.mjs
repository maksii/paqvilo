import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { committedJobs, liveJob, settleCommittedWork } from '../lib/committed-work.mjs';
import { createScheduler, fixedClock, storeScheduler } from '../lib/runtime-clock.mjs';

const bounded = (work, ms = 3000) =>
  Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error('deadlocked')), ms).unref())]);

// A Ready job staged inside a transaction of its own (committed-work.mjs stage(); the runner starts after the commit).
const stageJobs = async (store, jobs, entries) => {
  let start;
  await store.transact(() => {
    start = jobs.stage(entries);
  });
  start?.();
};
test('a due task awaiting a connector retry pause on the same manual scheduler completes on the next advance()', async () => {
  const clock = fixedClock(),
    scheduler = createScheduler({ clock, manual: true });
  let calls = 0,
    outcome = 'pending';
  const pack = {
    id: 'fx-pack',
    connectors: {
      shared_fx: {
        operations: {
          Ping: async () => (++calls === 1 ? { statusCode: 503, body: {} } : { statusCode: 200, body: { ok: true } }),
        },
      },
    },
  };
  const connectors = createConnectorRuntime({ packs: [pack], scheduler, clock });
  scheduler.schedule(
    async () => {
      const connection = connectors.resolve({
        connectorId: 'shared_fx',
        connectionId: null,
        principal: null,
        connectionReferences: undefined,
      });
      const answer = await connectors.invoke({
        connectorId: 'shared_fx',
        operationId: 'Ping',
        connection: { ...connection, provider: 'pack:fx-pack' },
        retry: { type: 'fixed', count: 1, intervalMs: 1000 },
      });
      outcome = 'done ' + answer.statusCode;
    },
    0,
    { name: 'committed-jobs' },
  );
  assert.equal(await bounded(scheduler.advance(1000)), 1);
  assert.deepEqual([calls, outcome], [1, 'pending']);
  assert.deepEqual(
    scheduler.pending().map((task) => task.name),
    ['connector-retry'],
  );
  assert.equal(scheduler.status().blocked, 1);
  assert.equal(scheduler.status().pending, 0);
  assert.equal(await bounded(scheduler.advance(1000)), 1);
  assert.deepEqual([calls, outcome], [2, 'done 200']);
  assert.deepEqual([scheduler.status().running, scheduler.status().blocked], [0, 0]);
});

test('runDue returns while a task waits on a not-yet-due timer and reports it as blocked', async () => {
  const clock = fixedClock(),
    scheduler = createScheduler({ clock, manual: true });
  let done = false;
  scheduler.schedule(async () => {
    await new Promise((resolve) => scheduler.schedule(resolve, 5000));
    done = true;
  });
  assert.equal(await bounded(scheduler.runDue()), 1);
  assert.equal(await bounded(scheduler.drain()), undefined);
  assert.deepEqual([done, scheduler.status().blocked, scheduler.status().pending], [false, 1, 0]);
  await bounded(scheduler.advance(5000));
  assert.deepEqual([done, scheduler.status().blocked, scheduler.status().running], [true, 0, 0]);
});

test('a task awaiting a due continuation of its own finishes in the same runDue', async () => {
  const scheduler = createScheduler({ clock: fixedClock(), manual: true });
  let done = false;
  scheduler.schedule(async () => {
    await new Promise((resolve) => scheduler.schedule(resolve, 0));
    done = true;
  });
  assert.equal(await bounded(scheduler.runDue()), 2);
  assert.deepEqual([done, scheduler.status().running], [true, 0]);
});

test('FIFO order of non-blocking due tasks is unchanged, including tasks that wait on real I/O turns', async () => {
  const scheduler = createScheduler({ clock: fixedClock(), manual: true }),
    order = [];
  for (const name of ['a', 'b', 'c'])
    scheduler.schedule(async () => {
      order.push(name + '>');
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('<' + name);
    });
  assert.equal(await bounded(scheduler.runDue()), 3);
  assert.deepEqual(order, ['a>', '<a', 'b>', '<b', 'c>', '<c']);
});

test('settle and close return while a committed job waits on a retry pause, and a later advance finishes it', async () => {
  const state = emptyState();
  const store = await new DataStore({ state }).init();
  const clock = fixedClock();
  storeScheduler(store, createScheduler({ clock, manual: true }));
  const jobs = committedJobs(store);
  let finished = false;
  jobs.register('x_wait', async ({ id }) => {
    await new Promise((resolve) => store.scheduler.schedule(resolve, 1000, { name: 'connector-retry' }));
    await store.transact(() => {
      const { rows, index } = liveJob(store, id);
      store.removeRow('asyncoperation', rows, index);
    });
    finished = true;
  });
  await stageJobs(store, jobs, [{ kind: 'x_wait', event: { entity: 'x_item' } }]);
  await bounded(store.scheduler.runDue());
  assert.equal(finished, false);
  await bounded(settleCommittedWork(store, []));
  await bounded(jobs.drain());
  assert.equal(jobs.pending(), 0);
  assert.equal(store.scheduler.status().pending, 0);
  await bounded(store.scheduler.advance(1000));
  assert.equal(finished, true);
  assert.equal((store.state.tables.asyncoperation ?? []).length, 0);
  // A second blocked job: close returns too, and the job row stays Ready for the next runtime.
  finished = false;
  await stageJobs(store, jobs, [{ kind: 'x_wait', event: { entity: 'x_item' } }]);
  await bounded(store.scheduler.runDue());
  await bounded(settleCommittedWork(store, [], { close: true }));
  assert.equal(finished, false);
  assert.equal(store.state.tables.asyncoperation.length, 1);
  assert.equal(store.state.tables.asyncoperation[0].statecode, 0);
});
