// @test-kind contract: Paqvilo durable committed-job recovery (restart, Locked recovery, poison budget); the missing-step job outcome is the native asyncStepDeleted capture
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { operationCatalogue } from '../lib/operation-catalogue.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';
import { committedJobs, encodeEvent } from '../lib/committed-work.mjs';
import { defaultSchedule } from '../lib/dataverse-async.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const stepId = '77777777-7777-4777-8777-000000000001',
  flowId = '77777777-7777-4777-8777-000000000002',
  flowUser = '77777777-7777-4777-8777-000000000003';
const step = {
  id: stepId,
  name: 'Invented asynchronous step',
  entity: 'x_widget',
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
const definition = {
  properties: {
    definition: {
      triggers: {
        row: {
          type: 'OpenApiConnectionWebhook',
          inputs: {
            host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger' },
            parameters: {
              'subscriptionRequest/message': 1,
              'subscriptionRequest/entityname': 'x_widget',
              'subscriptionRequest/scope': 4,
            },
          },
        },
      },
      actions: {
        create: {
          type: 'OpenApiConnection',
          inputs: {
            host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'CreateRecord' },
            parameters: { entityName: 'x_audits', 'item/x_name': "@triggerOutputs()['body/x_name']" },
          },
        },
      },
    },
  },
};
const workflows = new Map([
  [flowId, { file: '/invented/flow.json', active: true, activation: { sourceValue: 1 }, definition }],
]);
const identities = new Map([
  [
    flowId,
    {
      userId: flowUser,
      evidence: 'Invented explicit flow owner',
      grants: [
        { entity: 'x_widget', operations: ['read'] },
        { entity: 'x_audit', operations: ['read', 'create'] },
      ],
    },
  ],
]);

function initialState() {
  const state = emptyState();
  state.mappings.x_widget = {
    logicalName: 'x_widget',
    entitySet: 'x_widgets',
    idColumn: 'x_widgetid',
    nameColumn: 'x_name',
    fields: { x_name: { type: 'string' } },
  };
  state.mappings.x_audit = {
    logicalName: 'x_audit',
    entitySet: 'x_audits',
    idColumn: 'x_auditid',
    nameColumn: 'x_name',
    fields: { x_name: { type: 'string' } },
  };
  state.tables.x_widget = [];
  state.tables.x_audit = [];
  return state;
}

// One organization over a state file: the same composition the hosts use (organization runtime, then backend).
async function runtime(t, { file, scheduler = null, log = [], fresh = false, handler = null }) {
  const store = await new DataStore({ file, state: fresh ? initialState() : undefined }).init();
  const core = await createOrganizationRuntime({
    store,
    scheduler,
    settings: dataverseSettings({ enabled: false }),
    extensions: await sourceOrganizationExtensions(),
  });
  const handlers = new Map([
    [
      stepId,
      (context) => {
        log.push(['plugin', context.record.x_name, store.tableRows('x_audit').length]);
        handler?.(context);
      },
    ],
  ]);
  const notes = [];
  const backend = await createOrganizationBackend({
    store,
    scheduler,
    handlers,
    diagnostic: (note) => notes.push(note),
    items: () => pluginCatalogue({ plugins: { steps: [step] }, handlers }),
    operations: () => operationCatalogue({ portal: {}, workflows, handlers: { flowIdentities: identities } }),
    workflows: () => workflows,
    identities: () => identities,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await backend.close();
    await core.close();
  };
  ownedFixture(t).add(close);
  return { store, core, backend, notes, log, close };
}

async function stateFile(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'durable-async-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'state.json');
}

const jobs = (store) => store.tableRows('asyncoperation').filter((row) => row.operationtype === 1);

// A Ready job staged inside a transaction of its own (committed-work.mjs stage(); the runner starts after the commit).
const stageJobs = async (store, jobs, entries) => {
  let start;
  await store.transact(() => {
    start = jobs.stage(entries);
  });
  start?.();
};
test('an async plug-in step and a row trigger are Ready jobs that a manual scheduler runs in order', async (t) => {
  const scheduler = createScheduler({ clock: fixedClock(), manual: true });
  const { store, backend, log, notes } = await runtime(t, { file: await stateFile(t), scheduler, fresh: true });
  await store.create('x_widget', { x_name: 'Invented widget' }, { admin: true });
  await backend.settle();
  const ready = jobs(store);
  assert.deepEqual(
    ready.map((row) => [row.statecode, row.statuscode]),
    [
      [0, 0],
      [0, 0],
    ],
  );
  assert.ok(ready.every((row) => JSON.parse(row.data).event));
  assert.deepEqual(
    ready.map((row) => JSON.parse(row.data).kind),
    ['flow', 'plugin'],
  );
  assert.deepEqual(log, []);
  await scheduler.runDue();
  // FIFO: the flow job was enqueued first, so its audit row exists when the plug-in runs.
  assert.deepEqual(log, [['plugin', 'Invented widget', 1]]);
  assert.equal(store.tableRows('x_audit').length, 1);
  const [done] = jobs(store);
  assert.equal(jobs(store).length, 1, 'the flow job row is removed when its run ends');
  assert.deepEqual([done.statecode, done.statuscode], [3, 30]);
  assert.equal(done.owningextensionid.id, stepId);
  assert.ok(notes.some((note) => note.code === 'FLOW_TRIGGER_COMPLETED'));
  assert.ok(notes.some((note) => note.code === 'PLUGIN_ASYNC_COMPLETED'));
});

test('a runtime restarted from the saved state file resumes the Ready jobs and runs them exactly once', async (t) => {
  const file = await stateFile(t);
  const first = await runtime(t, {
    file,
    scheduler: createScheduler({ clock: fixedClock(), manual: true }),
    fresh: true,
  });
  await first.store.create('x_widget', { x_name: 'Saved before restart' }, { admin: true });
  await first.backend.settle();
  assert.equal(jobs(first.store).filter((row) => row.statecode === 0).length, 2);
  await first.close();
  assert.deepEqual(first.log, []);

  const log = [];
  const second = await runtime(t, { file, log });
  await second.backend.settle();
  assert.deepEqual(log, [['plugin', 'Saved before restart', 1]]);
  assert.equal(second.store.tableRows('x_audit').length, 1);
  assert.deepEqual(
    jobs(second.store).map((row) => [row.statecode, row.statuscode]),
    [[3, 30]],
  );
  second.backend.resume();
  await second.backend.settle();
  await second.close();

  const third = await runtime(t, { file, log });
  await third.backend.settle();
  assert.equal(log.length, 1, 'a completed job does not run again');
  assert.equal(third.store.tableRows('x_audit').length, 1);
});

test('settle waits for durable jobs on the real scheduler', async (t) => {
  const { store, backend, log } = await runtime(t, { file: await stateFile(t), fresh: true });
  await store.create('x_widget', { x_name: 'Settled' }, { admin: true });
  await backend.settle();
  assert.equal(log.length, 1);
  assert.equal(store.tableRows('x_audit').length, 1);
  assert.deepEqual(
    jobs(store).map((row) => [row.statecode, row.statuscode]),
    [[3, 30]],
  );
  assert.equal(backend.asyncPluginRunner.status().pending, 0);
});

// The default per-chain run limit and backlog report size of the async plug-in and flow trigger runners (maxChainRuns and
// maxPending, plugin-async.mjs and flow-triggers.mjs). One row more than it would exceed a shared chain's budget and is the
// first to cross the backlog report; more rows only add runs (each transaction clones the state, so the cost grows fast).
const DEFAULT_CHAIN_RUNS = 100;
const BULK_ROWS = DEFAULT_CHAIN_RUNS + 1;

test('one commit of more rows than a chain may run still yields one durable run per row, each on its own chain', async (t) => {
  const { store, backend, log, notes } = await runtime(t, { file: null, fresh: true });
  const events = Array.from({ length: BULK_ROWS }, (_, n) => ({
    entity: 'x_widget',
    operation: 'create',
    row: { x_widgetid: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`, x_name: 'Row ' + n },
    target: { x_name: 'Row ' + n },
    submittedAttributes: ['x_name'],
  }));
  await store.transact(() => {
    for (const e of events)
      store.recordCommittedEvent(e.entity, e.operation, e.row, e.submittedAttributes, { target: e.target });
  });
  await backend.settle();
  assert.equal(log.length, BULK_ROWS);
  assert.equal(store.tableRows('x_audit').length, BULK_ROWS);
  assert.deepEqual(
    log.slice(0, 2).map((entry) => entry[1]),
    ['Row 0', 'Row 1'],
  );
  const completed = jobs(store);
  assert.equal(completed.length, BULK_ROWS);
  assert.equal(new Set(completed.map((row) => row.correlationid)).size, BULK_ROWS);
  assert.ok(!notes.some((note) => /_LIMIT$/.test(note.code)));
  assert.equal(notes.filter((note) => note.code === 'PLUGIN_ASYNC_BACKLOG').length, 1);
  assert.equal(notes.filter((note) => note.code === 'FLOW_TRIGGER_BACKLOG').length, 1);
});

test('a Ready job cancelled before the scheduler runs it does not run', async (t) => {
  const scheduler = createScheduler({ clock: fixedClock(), manual: true });
  const { store, backend, log } = await runtime(t, { file: null, scheduler, fresh: true });
  await store.create('x_widget', { x_name: 'Cancelled' }, { admin: true });
  await backend.settle();
  await store.transact(() => {
    for (const row of jobs(store)) Object.assign(row, { statecode: 3, statuscode: 32 });
  });
  await scheduler.runDue();
  assert.deepEqual(log, []);
  assert.equal(store.tableRows('x_audit').length, 0);
  assert.deepEqual(
    jobs(store).map((row) => row.statuscode),
    [32, 32],
  );
});

// A job row as committed-work.mjs writes it, for a state saved by an earlier run.
const jobRow = (id, kind, columns, payload) => ({
  asyncoperationid: id,
  operationtype: 1,
  createdon: '2026-01-01T00:00:00.000Z',
  ...columns,
  data: JSON.stringify({
    kind,
    ...payload,
    event: encodeEvent({
      entity: 'x_widget',
      operation: 'create',
      row: { x_widgetid: '40000000-0000-4000-8000-000000000001', x_name: 'Saved' },
      target: { x_name: 'Saved' },
      submittedAttributes: ['x_name'],
    }),
  }),
});

test('a web hook job left Locked by an unfinished run is recovered once after a restart and fails when its registration is gone', async (t) => {
  const file = await stateFile(t);
  const first = await runtime(t, {
    file,
    scheduler: createScheduler({ clock: fixedClock(), manual: true }),
    fresh: true,
  });
  const id = '77777777-7777-4777-8777-000000000010';
  // The POST was in flight when the process stopped: the claim (2/20) is committed, the final state is not.
  await first.store.transact(() => {
    const table = (first.store.state.tables.asyncoperation ??= []);
    first.store.insertRow(
      'asyncoperation',
      table,
      jobRow(
        id,
        'webhook',
        { statecode: 2, statuscode: 20, startedon: '2026-01-01T00:00:01.000Z' },
        { itemId: '77777777-7777-4777-8777-0000000000ff', chain: { id: 'chain-r301', depth: 0 } },
      ),
    );
  });
  await first.close();

  const second = await runtime(t, { file });
  await second.backend.settle();
  const row = second.store.tableRows('asyncoperation').find((entry) => entry.asyncoperationid === id);
  // The registration is gone in this run, so the recovered job ends Failed with that reason instead of staying Locked.
  assert.deepEqual([row.statecode, row.statuscode], [3, 31]);
  // Native asyncStepDeleted (two captures): a job whose step is gone fails 0x8004418b "Could not find plugin step description.".
  assert.equal(row.message, 'Could not find plugin step description.');
  assert.equal(row.errorcode, 0x8004418b | 0);
  assert.deepEqual(
    second.notes.filter((note) => note.code === 'COMMITTED_JOB_RECOVERED').map((note) => note.count),
    [1],
  );
  second.backend.resume();
  await second.backend.settle();
  assert.equal(
    second.notes.filter((note) => note.code === 'COMMITTED_JOB_RECOVERED').length,
    1,
    'a finished job is not recovered again',
  );
});

test('a job whose transaction rolls back is tried three times, then finished Failed', async (t) => {
  let failCommit = false;
  const { store, backend, log, notes } = await runtime(t, {
    file: null,
    fresh: true,
    handler: () => {
      failCommit = true;
    },
  });
  const transact = store.transact.bind(store);
  // A simulated persistence failure: the transaction that ran the plug-in handler rejects, so its claim rolls back.
  store.transact = (fn, options) =>
    transact(async () => {
      const result = await fn();
      if (failCommit) {
        failCommit = false;
        throw new Error('Invented commit failure');
      }
      return result;
    }, options);
  await store.create('x_widget', { x_name: 'Poison' }, { admin: true });
  await backend.settle();
  assert.equal(log.length, 3);
  const [row] = jobs(store);
  assert.deepEqual([row.statecode, row.statuscode, row.message], [3, 31, 'Invented commit failure']);
  assert.equal(JSON.parse(row.data).attempts, 3);
  assert.deepEqual(
    notes
      .filter((note) => note.code === 'COMMITTED_JOB_POISONED')
      .map((note) => [note.asyncoperationid, note.attempts]),
    [[row.asyncoperationid, 3]],
  );
  // Later commits and a restart scan do not run it again.
  await store.create('x_audit', { x_name: 'Unrelated' }, { admin: true });
  backend.resume();
  await backend.settle();
  assert.equal(log.length, 3);
});

test('after the backend closes, the store keeps its closed scheduler and committed jobs run nothing', async (t) => {
  const { store, close } = await runtime(t, { file: null, fresh: true });
  await close();
  const closedScheduler = store.scheduler;
  const runs = [];
  const runner = committedJobs(store);
  assert.equal(runner.closed, true);
  runner.register('fx-probe', ({ id }) => {
    runs.push(id);
  });
  await stageJobs(store, runner, [{ kind: 'fx-probe', event: { entity: 'x_widget' } }]);
  runner.resume();
  await new Promise((resolve) => setImmediate(resolve));
  await runner.drain();
  assert.deepEqual(runs, []);
  assert.equal(store.scheduler, closedScheduler);
  assert.equal(store.scheduler.status().closed, true);
});

test('closing one organization leaves a second organization over the same store scheduling its jobs', async (t) => {
  const store = await new DataStore({ file: null, state: initialState() }).init();
  const create = () => createOrganizationRuntime({ store, settings: dataverseSettings({ enabled: false }) });
  const first = await create(),
    second = await create();
  ownedFixture(t).add(() => second.close());
  assert.equal(first.api.scheduler, second.api.scheduler);
  let firstRan = false;
  defaultSchedule(
    first.api,
    () => {
      firstRan = true;
    },
    60000,
  );
  await first.close();
  assert.equal(store.scheduler.status().closed, false);
  assert.deepEqual(
    store.scheduler.pending().filter((task) => task.name === 'dataverse-async'),
    [],
    'the closed organization cancelled its own task',
  );
  const ran = new Promise((resolve) => defaultSchedule(second.api, resolve, 0));
  await ran;
  assert.equal(firstRan, false);
});

test('a backend over a store whose previous backend closed opens a live scheduler and runs committed jobs again', async (t) => {
  const store = await new DataStore({ file: await stateFile(t), state: initialState() }).init();
  const log = [];
  const handlers = new Map([
    [
      stepId,
      (context) => {
        log.push(context.record.x_name);
      },
    ],
  ]);
  const options = { store, handlers, items: () => pluginCatalogue({ plugins: { steps: [step] }, handlers }) };
  const first = await createOrganizationBackend(options);
  await first.close();
  assert.equal(store.scheduler.status().closed, true);
  assert.equal(store.committedJobs.closed, true);
  const second = await createOrganizationBackend(options);
  ownedFixture(t).add(() => second.close());
  assert.equal(store.scheduler.status().closed, false);
  await store.create('x_widget', { x_name: 'After reopen' }, { admin: true });
  await second.settle();
  assert.deepEqual(log, ['After reopen']);
  assert.deepEqual(
    jobs(store).map((row) => [row.statecode, row.statuscode]),
    [[3, 30]],
  );
});

test('an organization closes the scheduler it opened and leaves a backend-owned scheduler open', async (t) => {
  const settings = dataverseSettings({ enabled: false }),
    extensions = await sourceOrganizationExtensions();
  const alone = new DataStore({ state: initialState() });
  const solo = await createOrganizationRuntime({ store: alone, settings, extensions });
  assert.equal(alone.scheduler.status().closed, false);
  await solo.close();
  assert.equal(alone.scheduler.status().closed, true, 'an organization without a backend leaves no timers');

  const shared = new DataStore({ state: initialState() });
  const backend = await createOrganizationBackend({ store: shared });
  ownedFixture(t).add(() => backend.close());
  const core = await createOrganizationRuntime({ store: shared, settings, extensions });
  await core.close();
  assert.equal(shared.scheduler.status().closed, false, 'the backend still owns its scheduler');
  await backend.close();
  assert.equal(shared.scheduler.status().closed, true);
});

test('a composition that fails after opening the scheduler closes it again', async () => {
  const settings = dataverseSettings({ enabled: false }),
    extensions = await sourceOrganizationExtensions();
  const store = new DataStore({ state: initialState() });
  const failing = [
    ...extensions,
    {
      name: 'x-failing',
      install() {
        throw new Error('install failed on purpose');
      },
    },
  ];
  await assert.rejects(
    createOrganizationRuntime({ store, settings, extensions: failing }),
    /install failed on purpose/,
  );
  assert.equal(store.scheduler.status().closed, true, 'the scheduler the failed composition opened is released');
  const retry = await createOrganizationRuntime({ store, settings, extensions });
  assert.equal(store.scheduler.status().closed, false, 'a later composition reopens it');
  await retry.close();
  assert.equal(store.scheduler.status().closed, true);
});
