// @test-kind contract: Paqvilo local async runner: local disabled/mock choices, close/drain semantics and committed-event consumer isolation
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';
const id = '10000000-0000-0000-0000-000000000001';
const step = {
  id,
  name: 'Invented asynchronous step',
  entity: 'widget',
  message: 'Create',
  enabled: true,
  stage: 40,
  rank: 1,
  mode: 1,
  typeName: 'Invented.Async',
  assemblyId: 'invented',
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
};
const data = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid' },
        audit: { entitySet: 'audits', idColumn: 'auditid' },
      },
      tables: { widget: [], audit: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });

test('an asynchronous job skipped by a later disabled local choice is canceled instead of reporting success', async (t) => {
  const store = data(),
    clock = fixedClock(),
    scheduler = createScheduler({ clock, manual: true });
  store.scheduler = scheduler;
  let disabled = false,
    executions = 0;
  const handlers = new Map([
    [
      id,
      () => {
        executions++;
      },
    ],
  ]);
  const items = () =>
    pluginCatalogue({
      plugins: { steps: [step] },
      handlers,
      overrides: disabled ? { [`plugin-step:${id}`]: { mode: 'disabled' } } : {},
    });
  const runner = createAsyncPluginRunner({ store, items, handlers, runtimes: new Map(), systemJobs: () => true });
  t.after(async () => {
    await runner.close();
    await scheduler.close();
  });
  await store.create('widget', { title: 'Queued' }, { admin: true });
  assert.equal(store.tableRows('asyncoperation')[0].statuscode, 0);
  disabled = true;
  await scheduler.runDue();
  assert.equal(executions, 0);
  assert.equal(store.tableRows('asyncoperation')[0].statuscode, 32);
  // Native asyncStepDisabled: the canceled job keeps no message and names the disabled step in its friendly message.
  assert.match(store.tableRows('asyncoperation')[0].friendlymessage, /is in disabled state/);
});
// @test-kind compatibility: Learn event pipeline: asynchronous steps run after the main transaction commits and their own SDK writes persist
test('Async source registrations execute only after commit and keep independent SDK writes after later job failure', async (t) => {
  const store = data(),
    notes = [],
    handlers = new Map([
      [
        id,
        (context) => {
          assert.equal(context.stage, 40);
          assert.equal(store.pluginInTransaction, false);
          store.sdkMutation(() =>
            store.createRecord('audit', { title: 'Completed asynchronous request' }, { admin: true }),
          );
          throw Error('Later asynchronous rejection');
        },
      ],
    ]),
    items = () => pluginCatalogue({ plugins: { steps: [step] }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items: items(), handlers }));
  const runner = createAsyncPluginRunner({
    store,
    items,
    handlers,
    runtimes: new Map(),
    diagnostic: (n) => notes.push(n),
  });
  t.after(() => runner.close());
  const row = await store.create('widget', { title: 'Caller committed' }, { admin: true });
  await runner.drain();
  assert.equal(store.snapshot().tables.widget[0].widgetid, row.widgetid);
  assert.equal(store.snapshot().tables.audit.length, 1);
  assert.ok(notes.some((n) => n.code === 'PLUGIN_ASYNC_FAILED'));
  await runner.close();
  assert.deepEqual(runner.status(), { pending: 0, closed: true });
});
// @test-kind unproven: local recursion limit (maxDepth option) and no async job on rollback; no native capture of async recursion bounds
test('Async recursion is bounded and rollback emits no asynchronous job', async (t) => {
  const store = data(),
    notes = [],
    handlers = new Map([
      [
        id,
        () => {
          store.sdkMutation(() => store.createRecord('widget', { title: 'Recursive child' }, { admin: true }));
        },
      ],
    ]),
    items = () => pluginCatalogue({ plugins: { steps: [step] }, handlers }),
    runner = createAsyncPluginRunner({
      store,
      items,
      handlers,
      runtimes: new Map(),
      limits: { maxDepth: 2 },
      diagnostic: (n) => notes.push(n),
    });
  t.after(() => runner.close());
  await store.create('widget', { title: 'Root' }, { admin: true });
  await runner.drain();
  assert.equal(store.snapshot().tables.widget.length, 3);
  assert.ok(notes.some((n) => n.code === 'PLUGIN_ASYNC_LIMIT'));
  store.setPluginPipeline(({ stage }) => {
    if (stage === 20) throw Error('Main rejection');
  });
  const count = store.snapshot().tables.widget.length;
  await assert.rejects(store.create('widget', { title: 'Rejected' }, { admin: true }), /Main rejection/);
  await runner.drain();
  assert.equal(store.snapshot().tables.widget.length, count);
});
test('Explicit disabled and mock choices remain selectable for source-unsupported registrations', async (t) => {
  const store = data(),
    notes = [],
    unsupported = { ...step, impersonatingUserId: '20000000-0000-0000-0000-000000000001' },
    overrides = { ['plugin-step:' + id]: { mode: 'disabled' } },
    items = () => pluginCatalogue({ plugins: { steps: [unsupported] }, overrides }),
    runner = createAsyncPluginRunner({
      store,
      items,
      handlers: new Map(),
      runtimes: new Map(),
      diagnostic: (n) => notes.push(n),
    });
  t.after(() => runner.close());
  await store.create('widget', { title: 'Disabled' }, { admin: true });
  await runner.drain();
  assert.ok(notes.some((n) => n.code === 'PLUGIN_STEP_DISABLED'));
  overrides['plugin-step:' + id] = { mode: 'mock' };
  await store.create('widget', { title: 'Mock' }, { admin: true });
  await runner.drain();
  assert.ok(notes.some((n) => n.code === 'PLUGIN_STEP_SIMULATED'));
  assert.ok(!notes.some((n) => n.code === 'PLUGIN_STEP_UNSUPPORTED'));
});
test('Close consumes callbacks captured at the saved commit boundary, including bounded descendants', async () => {
  const store = data(),
    notes = [],
    handlers = new Map([
      [
        id,
        (context) => {
          if (context.record.title === 'Root')
            store.sdkMutation(() => store.createRecord('widget', { title: 'Child' }, { admin: true }));
        },
      ],
    ]),
    items = () => pluginCatalogue({ plugins: { steps: [step] }, handlers }),
    runner = createAsyncPluginRunner({ store, items, handlers, runtimes: new Map(), diagnostic: (n) => notes.push(n) });
  await store.transact(() => {
    for (const e of [
      {
        entity: 'widget',
        operation: 'create',
        row: { widgetid: id, title: 'Root' },
        target: { title: 'Root' },
        submittedAttributes: ['title'],
      },
    ])
      store.recordCommittedEvent(e.entity, e.operation, e.row, e.submittedAttributes, { target: e.target });
  });
  await runner.close();
  assert.equal(notes.filter((n) => n.code === 'PLUGIN_ASYNC_COMPLETED').length, 2);
  assert.equal(store.snapshot().tables.widget[0].title, 'Child');
  assert.deepEqual(runner.status(), { pending: 0, closed: true });
});
test('A failing consumer does not drop another accepted consumer or reject a committed write', async () => {
  const store = data(),
    observed = [];
  store.addCommittedEvents(() => {
    throw Error('Consumer failed');
  });
  store.addCommittedEvents((events) => observed.push(...events));
  const row = await store.create('widget', { title: 'Committed' }, { admin: true });
  await store.flushCommittedEvents();
  assert.equal(observed[0].row.widgetid, row.widgetid);
  assert.equal(store.committedEventErrors[0].message, 'Consumer failed');
});
