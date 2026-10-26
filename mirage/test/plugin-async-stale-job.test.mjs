import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';

const id = '10000000-0000-4000-8000-000000000021';
const step = {
  id,
  name: 'Invented async web hook',
  entity: 'x_widget',
  message: 'Create',
  enabled: true,
  stage: 40,
  rank: 1,
  mode: 1,
  typeName: null,
  serviceEndpointId: '10000000-0000-4000-8000-000000000022',
  assemblyId: null,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
};
const data = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        x_widget: { entitySet: 'x_widgets', idColumn: 'x_widgetid' },
        x_note: { entitySet: 'x_notes', idColumn: 'x_noteid' },
      },
      tables: { x_widget: [], x_note: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });

async function run(t, answer) {
  const store = data(),
    notes = [];
  let release, entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const webhooks = {
    afterCommit: () => {
      entered();
      return new Promise((resolve) => {
        release = () => resolve(answer);
      });
    },
  };
  const items = () => pluginCatalogue({ plugins: { steps: [step] } });
  const runner = createAsyncPluginRunner({
    store,
    items,
    handlers: new Map(),
    runtimes: new Map(),
    webhooks,
    systemJobs: () => true,
    diagnostic: (n) => notes.push(n),
  });
  t.after(() => runner.close());
  await store.create('x_widget', { x_name: 'Caller' }, { admin: true });
  await store.flushCommittedEvents();
  await reached;
  assert.equal(store.snapshot().tables.asyncoperation[0].statuscode, 20);
  // An isolated commit (a $batch changeset) replaces the state object while the POST is in flight.
  await store.transact(() => store.createRecord('x_note', { x_name: 'Changeset' }, { admin: true }), {
    isolated: true,
  });
  release();
  await runner.drain();
  return { store, notes };
}

test('Async web hook System Job finishes the live row after an isolated commit during delivery', async (t) => {
  const { store, notes } = await run(t, {});
  const [job] = store.snapshot().tables.asyncoperation;
  assert.equal(job.statecode, 3);
  assert.equal(job.statuscode, 30);
  assert.ok(notes.some((n) => n.code === 'PLUGIN_ASYNC_COMPLETED'));
  assert.equal(store.snapshot().tables.x_note.length, 1);
});

test('Async web hook cancel also reaches the live row after an isolated commit', async (t) => {
  const { store } = await run(t, { canceled: 'Invented contract cannot be delivered' });
  const [job] = store.snapshot().tables.asyncoperation;
  assert.equal(job.statuscode, 32);
  assert.equal(job.message, 'Invented contract cannot be delivered');
});

test('A System Job row removed before delivery finishes is reported, not thrown', async (t) => {
  const store = data(),
    notes = [];
  let release, entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const webhooks = {
    afterCommit: () =>
      new Promise((resolve) => {
        release = resolve;
        entered();
      }),
  };
  const runner = createAsyncPluginRunner({
    store,
    items: () => pluginCatalogue({ plugins: { steps: [step] } }),
    handlers: new Map(),
    runtimes: new Map(),
    webhooks,
    systemJobs: () => true,
    diagnostic: (n) => notes.push(n),
  });
  t.after(() => runner.close());
  await store.create('x_widget', { x_name: 'Caller' }, { admin: true });
  await store.flushCommittedEvents();
  await reached;
  await store.transact(
    () => {
      store.state.tables.asyncoperation.length = 0;
    },
    { isolated: true },
  );
  release({});
  await runner.drain();
  assert.ok(notes.some((n) => n.code === 'PLUGIN_ASYNC_JOB_MISSING'));
  assert.ok(notes.some((n) => n.code === 'PLUGIN_ASYNC_COMPLETED'));
  assert.ok(!notes.some((n) => n.code === 'PLUGIN_ASYNC_FAILED'));
});
