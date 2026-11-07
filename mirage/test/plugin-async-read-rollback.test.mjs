// @test-kind parity: native dataverse-recorder faults.json, reproduced in native-r2 faults.json: a PATCH (Upsert) whose Update PreOperation step threw (400) still ran the existence read's asynchronous RetrieveMultiple step, with the request's RequestId
// Invented schema and handlers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';

const id = (n) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const step = (n, message, stage, mode, typeName) => ({
  id: id(100 + n),
  enabled: true,
  name: typeName,
  entity: 'x_item',
  message,
  stage,
  mode,
  rank: 1,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName,
  assemblyId: 'invented',
});

test('a completed read keeps its asynchronous job when the enclosing request rolls back', async (t) => {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = [{ x_itemid: id(1), x_name: 'existing' }];
  const reads = [];
  const handlers = new Map([
    ['Invented.ReadAsync', ({ context }) => reads.push(context)],
    [
      'Invented.UpdatePre',
      () => {
        throw new Error('Invented ordinary exception');
      },
    ],
  ]);
  const clock = fixedClock(),
    store = new DataStore({ state, clock }),
    scheduler = createScheduler({ clock, manual: true }),
    items = pluginCatalogue({
      plugins: {
        steps: [
          step(1, 'RetrieveMultiple', 40, 1, 'Invented.ReadAsync'),
          step(2, 'Update', 20, 0, 'Invented.UpdatePre'),
        ],
      },
      handlers,
    });
  const backend = await createOrganizationBackend({ store, items: () => items, handlers, scheduler });
  t.after(async () => {
    await backend.close();
    store.close();
  });
  // The Upsert's existence read, then its Update, in one request transaction.
  await assert.rejects(
    store.transact(async () => {
      store.query('x_item', { $filter: `x_itemid eq ${id(1)}`, $top: '2' }, { admin: true });
      await store.updateRecordAsync('x_item', id(1), { x_name: 'refused' }, { admin: true });
    }),
    /Invented ordinary exception/,
  );
  assert.equal(store.tableRows('x_item')[0].x_name, 'existing');
  // The read's job is staged in its own transaction, queued after the rolled-back one.
  await store.transact(() => {});
  assert.equal(store.tableRows('asyncoperation').length, 1);
  await scheduler.runDue();
  await backend.asyncPluginRunner.drain();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].MessageName, 'RetrieveMultiple');
  assert.equal(reads[0].Mode, 1);
});

// @test-kind parity: native readNested: a Retrieve whose PostOperation synchronous step faults answers 400 0x80040265, yet its asynchronous Retrieve step runs once with the read's BusinessEntity
// @parity-evidence: native and native-r2 readNested event 30 (Retrieve/40 sync fault, GET 400 0x80040265) and the 'Recorder: Retrieve async' Retrieve/40/m1/d1 context with OutputParameters.BusinessEntity
test('a Retrieve whose PostOperation step faults still runs its asynchronous Retrieve step with the read result', async (t) => {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = [{ x_itemid: id(1), x_name: 'existing' }];
  const reads = [];
  const handlers = new Map([
    ['Invented.ReadAsync', ({ context }) => reads.push(context)],
    [
      'Invented.ReadFault',
      () => {
        throw new Error('Invented read fault');
      },
    ],
  ]);
  const clock = fixedClock(),
    store = new DataStore({ state, clock }),
    scheduler = createScheduler({ clock, manual: true }),
    items = pluginCatalogue({
      plugins: {
        steps: [step(1, 'Retrieve', 40, 1, 'Invented.ReadAsync'), step(2, 'Retrieve', 40, 0, 'Invented.ReadFault')],
      },
      handlers,
    });
  const backend = await createOrganizationBackend({ store, items: () => items, handlers, scheduler });
  t.after(async () => {
    await backend.close();
    store.close();
  });
  // The request boundary of a Web API read whose steps run (dataverse-records.mjs): the read operation fails with the step.
  await assert.rejects(
    store.readOperation(() => store.get('x_item', id(1), { admin: true })),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.innerCode, '0x80040265');
      assert.equal(error.message, 'Invented read fault');
      return true;
    },
  );
  // The read's job is staged in its own transaction, queued after the failed read.
  await store.transact(() => {});
  assert.equal(store.tableRows('asyncoperation').length, 1);
  await scheduler.runDue();
  await backend.asyncPluginRunner.drain();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].MessageName, 'Retrieve');
  assert.equal(reads[0].Mode, 1);
  // A JavaScript handler's context carries the entity in its Web API shape.
  assert.equal(reads[0].OutputParameters.BusinessEntity?.x_itemid, id(1));
  assert.equal(reads[0].OutputParameters.BusinessEntity?.x_name, 'existing');
});
