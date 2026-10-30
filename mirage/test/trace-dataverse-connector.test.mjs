// The flow Dataverse connector (connector-runtime.mjs dataverseProvider) is one dataverse span per call under its connector
// span (docs/design/tracing.md): the store reads and the organization record entries it drives open none of their own,
// with or without the organization's record pipeline. The span is module dataverse with the canonical operation and
// attribute connector (D-R3-9); at level full it carries the written values and the read rows' count (DV-C-14).
// Invented schema only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { seed } from '../lib/dataverse-standard.mjs';
import { ensureSecurityModel, createPrincipals } from '../lib/dataverse-security.mjs';
import { createRecordHandlers } from '../lib/dataverse-records.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';

const ID = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const SETTINGS = {
  organizationId: '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [{ objectId: ID(900), upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] }],
};
const principal = {
  userId: ID(100),
  evidence: 'Invented flow owner',
  grants: [{ entity: 'x_item', operations: ['read', 'create', 'update', 'delete'] }],
};

async function setup(pipeline, level = 'summary') {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: { x_name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.x_item = [{ x_itemid: ID(1), x_name: 'one' }];
  const store = new DataStore({ state });
  if (pipeline) {
    await store.transact(() => seed(store));
    await ensureSecurityModel(store, SETTINGS);
    createRecordHandlers({
      store,
      change: (fn) => fn(),
      principals: createPrincipals(store, SETTINGS),
      changes: createChangeLog(store),
    });
  }
  store.traces = createTraceStore({ settings: { level } });
  return { store, connectors: createConnectorRuntime({ store }) };
}

// The connector's own dataverse spans (the record pipeline under it opens none: the first test).
const connectorSpans = (store, filters) =>
  store.traces.spans({ order: 'asc', pageSize: 200, ...filters }).items.filter((span) => span.attributes.connector);

const calls = [
  ['CreateRecord', { entityName: 'x_items', 'item/x_name': 'two' }, 'create'],
  ['UpdateOnlyRecord', { entityName: 'x_items', recordId: ID(1), 'item/x_name': 'uno' }, 'update'],
  ['UpdateRecord', { entityName: 'x_items', recordId: ID(1), 'item/x_name': 'upserted' }, 'update'],
  ['GetItem', { entityName: 'x_items', recordId: ID(1) }, 'retrieve'],
  ['ListRecords', { entityName: 'x_items' }, 'retrievemultiple'],
  [
    'ExecuteChangeset',
    {
      requests: [
        { operationId: 'CreateRecord', parameters: { entityName: 'x_items', 'item/x_name': 'three' } },
        { operationId: 'UpdateOnlyRecord', parameters: { entityName: 'x_items', recordId: ID(1), 'item/x_name': 'u' } },
      ],
    },
    'changeset',
  ],
  ['DeleteRecord', { entityName: 'x_items', recordId: ID(1) }, 'delete'],
];

for (const pipeline of [false, true])
  test(`each Dataverse connector call is one dataverse span under its connector span (${pipeline ? 'record pipeline' : 'bare store'})`, async () => {
    const { store, connectors } = await setup(pipeline);
    for (const [operationId, parameters, operation] of calls) {
      store.traces.clear();
      await connectors.invoke({
        connectorId: 'shared_commondataserviceforapps',
        operationId,
        parameters,
        context: { principal },
      });
      const spans = store.traces.spans({ order: 'asc', pageSize: 200 }).items;
      assert.deepEqual(
        spans.map((span) => [span.kind, span.operation, span.depth, span.status]),
        [
          ['connector', 'invoke', 0, 'ok'],
          ['dataverse', operation, 1, 'ok'],
        ],
        operationId,
      );
      const [connector, call] = spans;
      assert.equal(call.parentSpanId, connector.spanId, operationId);
      assert.equal(call.entity, operationId === 'ExecuteChangeset' ? null : 'x_item', operationId);
      assert.deepEqual(
        [connector.module, call.module, call.attributes.connector, call.attributes.operationId],
        ['connectors', 'dataverse', 'commondataserviceforapps', operationId],
        operationId,
      );
    }
  });

test('the Dataverse connector span is found by module, entity and canonical operation, with its record id', async () => {
  const { store, connectors } = await setup(true);
  const invoke = (operationId, parameters) =>
    connectors.invoke({
      connectorId: 'shared_commondataserviceforapps',
      operationId,
      parameters,
      context: { principal },
    });
  const created = await invoke('CreateRecord', { entityName: 'x_items', 'item/x_name': 'made' });
  await invoke('UpdateRecord', { entityName: 'x_items', recordId: ID(1), 'item/x_name': 'changed' });
  await invoke('UpdateRecord', { entityName: 'x_items', recordId: ID(7), 'item/x_name': 'upserted' });
  const [update, upsert] = store.traces.spans({
    module: 'dataverse',
    entity: 'x_item',
    operation: 'update',
    order: 'asc',
  }).items;
  assert.deepEqual([update.recordId, update.attributes.created, update.attributes.statusCode], [ID(1), undefined, 200]);
  assert.deepEqual([upsert.recordId, upsert.attributes.created, upsert.attributes.statusCode], [ID(7), true, 201]);
  const [create] = connectorSpans(store, { module: 'dataverse', operation: 'create' });
  assert.equal(create.recordId, created.body.x_itemid, 'a create names the row it made');
  assert.equal(connectorSpans(store, { recordId: ID(7) }).length, 1);
});

test('at level full a Dataverse connector write carries its values and a FetchXML read its row count', async () => {
  const { store, connectors } = await setup(true, 'full');
  const invoke = (operationId, parameters, context = {}) =>
    connectors.invoke({
      connectorId: 'shared_commondataserviceforapps',
      operationId,
      parameters,
      context: { principal, ...context },
    });
  await invoke('UpdateRecord', { entityName: 'x_items', recordId: ID(1), 'item/x_name': 'Written value' });
  await invoke('CreateRecord', { entityName: 'x_items', 'item/x_name': 'Second' });
  await invoke('ListRecords', {
    entityName: 'x_items',
    fetchXml: '<fetch><entity name="x_item"><attribute name="x_name" /></entity></fetch>',
  });
  const [update] = connectorSpans(store, { module: 'dataverse', operation: 'update' });
  assert.deepEqual(update.input, { entityName: 'x_items', recordId: ID(1), item: { x_name: 'Written value' } });
  assert.deepEqual(update.output, { statusCode: 200, id: ID(1), rowCount: null });
  const [read] = connectorSpans(store, { module: 'dataverse', operation: 'retrievemultiple' });
  assert.deepEqual([read.attributes.query, read.attributes.rowCount], ['fetchxml', 2]);
  assert.deepEqual(read.output, { statusCode: 200, id: null, rowCount: 2, moreRecords: false });
  assert.match(read.input.fetchXml, /<fetch>/);

  // A sealed run's call (context.secure) captures neither.
  store.traces.clear();
  await invoke(
    'UpdateRecord',
    { entityName: 'x_items', recordId: ID(1), 'item/x_name': 'Sealed value' },
    { secure: true },
  );
  const [sealed] = connectorSpans(store, { module: 'dataverse' });
  assert.equal(Object.hasOwn(sealed, 'input') || Object.hasOwn(sealed, 'output'), false);
  assert.equal(sealed.attributes.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(store.traces.export()), /Sealed value/);
});
