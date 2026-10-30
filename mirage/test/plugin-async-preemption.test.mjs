// @test-kind parity: native dataverse-recorder corpus (sdkMessages, crud, async): a job regarding a row deleted before it starts never executes, for every message and for web hooks
// Invented schema, handlers and loopback receiver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';

const id = (n) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENDPOINT = id(1);
const step = (n, message, extra = {}) => ({
  id: id(100 + n),
  enabled: true,
  name: `Invented async ${message}`,
  entity: 'x_item',
  message,
  stage: 40,
  mode: 1,
  rank: 1,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  ...extra,
});
const typed = (n, message) => step(n, message, { typeName: `Invented.${message}`, assemblyId: 'invented' });

async function organization(t, steps, { asyncStartDelayMs } = {}) {
  const ran = [];
  const receiver = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      ran.push(`webhook ${JSON.parse(Buffer.concat(chunks)).MessageName}`);
      response.writeHead(200).end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = [];
  state.tables.serviceendpoint = [
    { serviceendpointid: ENDPOINT, contract: 8, authtype: 0, url: `http://127.0.0.1:${receiver.address().port}/hook` },
  ];
  const handlers = new Map(
    ['Create', 'Update', 'Delete', 'Assign', 'UpdateMultiple'].map((message) => [
      `Invented.${message}`,
      ({ context }) => ran.push(`plugin ${context.MessageName}`),
    ]),
  );
  const clock = fixedClock(),
    store = new DataStore({ state, clock }),
    scheduler = createScheduler({ clock, manual: true }),
    items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({
    store,
    items: () => items,
    handlers,
    scheduler,
    ...(asyncStartDelayMs === undefined ? {} : { asyncStartDelayMs: () => asyncStartDelayMs }),
  });
  t.after(async () => {
    await backend.close();
    store.close();
    await new Promise((resolve) => {
      receiver.close(resolve);
      receiver.closeAllConnections();
    });
  });
  const settle = async () => {
    await scheduler.runDue();
    await backend.asyncPluginRunner.drain();
  };
  return { store, scheduler, backend, settle, ran };
}
const admin = { admin: true };
const assign = (store, row) =>
  store.transact(() =>
    store.recordCommittedEvent('x_item', 'assign', row, [], { target: {}, identity: admin, messageEvent: true }),
  );

// Native sdkMessages: the Assign, SetStateDynamicEntity and sharing asynchronous steps and the Update web hook of a row the
// scenario deleted never ran; native crud: the last Update's asynchronous plug-in and web hook never ran either, while
// the Delete's own asynchronous step did.
test('deleting a row stops every waiting plug-in and web hook job regarding it, whatever its message', async (t) => {
  const { store, settle, ran } = await organization(t, [
    typed(1, 'Update'),
    step(2, 'Update', { serviceEndpointId: ENDPOINT }),
    typed(3, 'Assign'),
    typed(4, 'Delete'),
    typed(5, 'UpdateMultiple'),
  ]);
  const row = await store.create('x_item', { x_name: 'brief' }, admin);
  await store.update('x_item', row.x_itemid, { x_name: 'changed' }, admin);
  await assign(store, store.tableRows('x_item')[0]);
  const other = await store.create('x_item', { x_name: 'kept' }, admin);
  await store.update('x_item', other.x_itemid, { x_name: 'kept and changed' }, admin);
  await store.remove('x_item', row.x_itemid, admin);
  await settle();
  // Only the jobs regarding the surviving row, and the Delete's own job, executed.
  assert.deepEqual(ran.toSorted(), ['plugin Delete', 'plugin Update', 'plugin UpdateMultiple', 'webhook Update']);
  // @parity-evidence: native and native-r2 asyncDeletedRow (two captures): the deleted row's queued jobs, the bridged UpdateMultiple included, end Canceled 3/32 with errorcode and message null
  // Native asyncDeletedRow (two captures): such a job ends Canceled (3/32) with no errorcode or message.
  const canceled = store
    .tableRows('asyncoperation')
    .filter((job) => job.regardingobjectid?.id === row.x_itemid && job.messagename !== 'Delete');
  // Native asyncDeletedRow: the UpdateMultiple job bridged from the row's Update regards the row and is canceled too.
  assert.equal(canceled.length, 4);
  for (const job of canceled) {
    assert.deepEqual([job.statecode, job.statuscode, job.errorcode, job.message], [3, 32, null, null]);
    assert.equal(job.friendlymessage, 'This system job was canceled because a referenced record was deleted.');
  }
});

// @test-kind contract: asyncStartDelayMs is Paqvilo's calibration knob for the native asynchronous start latency (1.2-6 s recorded); 0 keeps the next-turn start
test('a configured asynchronous start delay keeps jobs Ready until due, so a deletion inside the window pre-empts them', async (t) => {
  const { store, scheduler, backend, settle, ran } = await organization(
    t,
    [typed(1, 'Create'), typed(2, 'Update'), step(3, 'Update', { serviceEndpointId: ENDPOINT }), typed(4, 'Delete')],
    { asyncStartDelayMs: 2000 },
  );
  const row = await store.create('x_item', { x_name: 'waiting' }, admin);
  await settle();
  assert.deepEqual(ran, [], 'a postponed job does not start on the next turn');
  const [job] = store.tableRows('asyncoperation');
  assert.equal(job.statecode, 0);
  assert.equal(Date.parse(job.postponeuntil), store.clock.now() + 2000);
  assert.equal(backend.asyncPluginRunner.status().pending, 0, 'settling does not wait for a job that is not due');
  await scheduler.advance(2000);
  await backend.asyncPluginRunner.drain();
  assert.deepEqual(ran, ['plugin Create']);
  ran.length = 0;
  await store.update('x_item', row.x_itemid, { x_name: 'changed' }, admin);
  await scheduler.advance(1000);
  await store.remove('x_item', row.x_itemid, admin);
  await scheduler.advance(2000);
  await backend.asyncPluginRunner.drain();
  assert.deepEqual(ran, ['plugin Delete']);
});
