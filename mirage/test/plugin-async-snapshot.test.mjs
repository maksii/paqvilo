// @test-kind parity: native dev-environment recorder corpus (pipelineEffects, async, crud, ownerAndState): async step context and deleted-row job failure
// Asynchronous step admission against native corpus facts (dataverse-recorder). Invented schema and handlers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const step = (n, message, stage, mode, typeName) => ({
  id: id(n),
  enabled: true,
  name: typeName,
  entity: 'x_item',
  message,
  stage,
  mode,
  rank: 1,
  supportedDeployment: 0,
  assemblyId: 'invented',
  filteringAttributes: [],
  images: [],
  typeName,
});

async function organization(t, steps, handlers) {
  const state = emptyState(),
    text = { dataverseType: 'nvarchar' };
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid', fields: { x_name: text, x_note: text } };
  state.tables.x_item = [];
  const store = new DataStore({ state, clock: fixedClock() }),
    scheduler = createScheduler({ clock: store.clock, manual: true }),
    items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store, items: () => items, handlers, scheduler });
  t.after(async () => {
    await backend.close();
    store.close();
  });
  const settle = async () => {
    await scheduler.runDue();
    await backend.asyncPluginRunner.drain();
  };
  return { store, settle };
}

// Native pipelineEffects: a value a synchronous PostOperation step set on the Create Target, its custom output and
// its shared variable are absent from the asynchronous Create step's context; PreOperation edits and shared
// variables reach it.
test('an asynchronous Create step sees the operation as PostOperation started, not PostOperation edits', async (t) => {
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Pre',
      ({ context }) => {
        context.InputParameters.Target.x_name = 'from PreOperation';
        context.SharedVariables['x.pre'] = 'pre';
      },
    ],
    [
      'Invented.Post',
      ({ context }) => {
        context.InputParameters.Target.x_note = 'from PostOperation';
        context.OutputParameters['x.output'] = 'post output';
        context.SharedVariables['x.post'] = 'post';
      },
    ],
    [
      'Invented.Async',
      ({ context }) => {
        seen.push({
          target: { x_name: context.InputParameters.Target.x_name, x_note: context.InputParameters.Target.x_note },
          outputs: Object.keys(context.OutputParameters).sort(),
          shared: Object.keys(context.SharedVariables).filter((key) => key.startsWith('x.')),
        });
      },
    ],
  ]);
  const { store, settle } = await organization(
    t,
    [
      step(1, 'Create', 20, 0, 'Invented.Pre'),
      step(2, 'Create', 40, 0, 'Invented.Post'),
      step(3, 'Create', 40, 1, 'Invented.Async'),
    ],
    handlers,
  );
  const row = await store.create('x_item', { x_name: 'caller' }, { admin: true });
  await settle();
  assert.deepEqual(seen, [
    { target: { x_name: 'from PreOperation', x_note: undefined }, outputs: ['id'], shared: ['x.pre'] },
  ]);
  // The stored row keeps the PreOperation value; PostOperation context edits never write data.
  assert.equal(store.tableRows('x_item').find((r) => r.x_itemid === row.x_itemid).x_note ?? null, null);
});

// Native async, crud and ownerAndState: an Update whose row was deleted before its asynchronous job ran never
// executes that step (the Delete's own asynchronous step does run).
test('a queued asynchronous Update of a row deleted before its job ran does not execute and fails its job', async (t) => {
  const runs = [];
  const handlers = new Map([
    ['Invented.AsyncUpdate', ({ context }) => runs.push(context.MessageName)],
    ['Invented.AsyncDelete', ({ context }) => runs.push(context.MessageName)],
  ]);
  const { store, settle } = await organization(
    t,
    [step(4, 'Update', 40, 1, 'Invented.AsyncUpdate'), step(5, 'Delete', 40, 1, 'Invented.AsyncDelete')],
    handlers,
  );
  const row = await store.create('x_item', { x_name: 'kept briefly' }, { admin: true });
  await store.update('x_item', row.x_itemid, { x_name: 'changed' }, { admin: true });
  await store.remove('x_item', row.x_itemid, { admin: true });
  await settle();
  assert.deepEqual(runs, ['Delete']);
  const failed = store.tableRows('asyncoperation').find((job) => job.messagename === 'Update');
  assert.equal(failed.statuscode, 31);
  assert.equal(failed.errorcode, 0x80040217 | 0);
  assert.match(failed.message, /Does Not Exist/);
});
