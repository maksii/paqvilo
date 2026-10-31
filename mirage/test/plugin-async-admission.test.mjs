// @test-kind contract: Paqvilo async admission: success only with an actual execution receipt; mocks and missing adapters are reported honestly
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';

const id = '10000000-0000-4000-8000-000000000041';
const source = {
  id,
  name: 'Invented queued admission',
  entity: 'widget',
  message: 'Update',
  enabled: true,
  stage: 40,
  rank: 1,
  mode: 1,
  supportedDeployment: 0,
  typeName: 'Invented.Queued',
  assemblyId: 'invented',
  filteringAttributes: [],
  images: [],
};
async function fixture(t, kind, { systemJobs = true, adapter = true } = {}) {
  const state = emptyState();
  for (const name of ['widget', 'audit']) {
    state.mappings[name] = { entitySet: name + 's', idColumn: name + 'id' };
    state.tables[name] = [];
  }
  const store = new DataStore({ state });
  const scheduler = createScheduler({ clock: fixedClock(), manual: true });
  store.scheduler = scheduler;
  const row = await store.create('widget', { title: 'Original' }, { admin: true });
  let current = { ...source },
    override = null,
    removed = false,
    executions = 0;
  if (kind === 'webhook') current = { ...current, serviceEndpointId: id, typeName: null, assemblyId: null };
  const handlers = new Map(
    kind === 'plugin'
      ? [
          [
            id,
            () => {
              executions++;
            },
          ],
        ]
      : [],
  );
  const items = () =>
    pluginCatalogue({
      plugins: { steps: removed ? [] : [current] },
      handlers,
      overrides: override ? { ['plugin-step:' + id]: override } : {},
    });
  const runner = createAsyncPluginRunner({
    store,
    items,
    handlers,
    runtimes: new Map(),
    systemJobs: () => systemJobs,
    webhooks: adapter
      ? {
          afterCommit: async () => {
            executions++;
            return {};
          },
        }
      : null,
  });
  t.after(async () => {
    await runner.close();
    await scheduler.close();
    store.close();
  });
  return {
    store,
    scheduler,
    run: async () => {
      await scheduler.runDue();
      // Webhooks are owned concurrent work, not the scheduler tick itself.
      await runner.drain();
    },
    row,
    get executions() {
      return executions;
    },
    change: (patch) => {
      Object.assign(current, patch);
    },
    choose: (value) => {
      override = value;
    },
    remove: () => {
      removed = true;
    },
    queue: async () => {
      await store.update('widget', row.widgetid, { title: 'Committed caller' }, { admin: true });
      assert.equal(store.tableRows('asyncoperation')[0].statuscode, 0);
    },
  };
}

for (const kind of ['plugin', 'webhook'])
  test(`${kind} queued work rechecks the current registration without reporting an unexecuted success`, async (t) => {
    for (const [name, mutate, expected = 32] of [
      ['state', (f) => f.change({ enabled: false })],
      ['mode', (f) => f.change({ mode: 0 })],
      ['message', (f) => f.change({ message: 'Create' })],
      ['table', (f) => f.change({ entity: 'audit' })],
      ['stage', (f) => f.change({ stage: 20 })],
      ['deployment', (f) => f.change({ supportedDeployment: 1 })],
      ['filtering attributes', (f) => f.change({ filteringAttributes: ['unsubmitted'] })],
      ['disabled local choice', (f) => f.choose({ mode: 'disabled' })],
      ['placeholder local choice', (f) => f.choose({ mode: 'placeholder' })],
      ['delivery kind', (f) => f.choose({ mode: kind === 'plugin' ? 'webhook' : 'handler' })],
      ['removed', (f) => f.remove(), 31],
    ])
      await t.test(name, async (t) => {
        const f = await fixture(t, kind);
        await f.queue();
        mutate(f);
        await f.run();
        assert.equal(f.executions, 0);
        const [job] = f.store.tableRows('asyncoperation');
        assert.equal(job.statecode, 3);
        assert.equal(job.statuscode, expected);
        // Native asyncStepDeleted (two captures, 3/31): a deleted step's job fails 0x8004418b "Could not find plugin step description.".
        // Native asyncStepDisabled (one capture, native r1: 3/32 with the skip notice; native-r2 ran the step, 3/30, a start race):
        // a disabled step's job is canceled with the platform's skip notice and no message.
        if (expected === 31) {
          assert.equal(job.message, 'Could not find plugin step description.');
          assert.equal(job.errorcode, 0x8004418b | 0);
        } else if (name === 'state' || name === 'disabled local choice') {
          assert.equal(job.message, null);
          assert.match(
            job.friendlymessage,
            /^Skipping Async Operation '.+' Sdk processing step '.+' is in disabled state$/,
          );
        } else assert.match(job.message, /nothing was executed/);
        assert.equal(f.store.tableRows('widget')[0].title, 'Committed caller');
      });
  });

test('an actual execution receipt, not matching submitted columns alone, is required for success', async (t) => {
  const f = await fixture(t, 'plugin');
  f.change({ filteringAttributes: ['title'] });
  await f.store.transact(() =>
    f.store.recordCommittedEvent('widget', 'update', f.row, ['title'], {
      target: {},
      previous: f.row,
      identity: { admin: true },
    }),
  );
  assert.equal(f.store.tableRows('asyncoperation')[0].statuscode, 0);
  await f.run();
  assert.equal(f.executions, 0);
  assert.equal(f.store.tableRows('asyncoperation')[0].statuscode, 32);
  assert.match(f.store.tableRows('asyncoperation')[0].message, /without executing/);
});

for (const kind of ['plugin', 'webhook'])
  test(`unchanged ${kind} work still succeeds after one actual invocation`, async (t) => {
    const f = await fixture(t, kind);
    await f.queue();
    await f.run();
    assert.equal(f.executions, 1);
    assert.equal(f.store.tableRows('asyncoperation')[0].statuscode, 30);
  });

test('an explicit asynchronous mock is an executed simulator choice', async (t) => {
  const f = await fixture(t, 'plugin');
  await f.queue();
  f.choose({ mode: 'mock', status: 200, body: {} });
  await f.run();
  assert.equal(f.executions, 0);
  assert.equal(f.store.tableRows('asyncoperation')[0].statuscode, 30);
});

for (const systemJobs of [true, false])
  test(`a missing webhook adapter cancels work with system jobs ${systemJobs ? 'visible' : 'private'}`, async (t) => {
    const f = await fixture(t, 'webhook', { systemJobs, adapter: false });
    await f.queue();
    await f.run();
    assert.equal(f.executions, 0);
    const jobs = f.store.tableRows('asyncoperation');
    if (systemJobs) {
      assert.equal(jobs[0].statuscode, 32);
      assert.match(jobs[0].message, /no asynchronous webhook delivery adapter/);
    } else assert.equal(jobs.length, 0);
  });
