// The flow Dataverse connector (connector-runtime.mjs dataverseProvider) is one dataverse span per call under its connector
// span (docs/design/tracing.md): the store reads and the organization record entries it drives open none of their own,
// with or without the organization's record pipeline. Invented schema only.
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

async function setup(pipeline) {
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
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  return { store, connectors: createConnectorRuntime({ store }) };
}

const calls = [
  ['CreateRecord', { entityName: 'x_items', 'item/x_name': 'two' }, 'create'],
  ['UpdateOnlyRecord', { entityName: 'x_items', recordId: ID(1), 'item/x_name': 'uno' }, 'update'],
  ['UpdateRecord', { entityName: 'x_items', recordId: ID(1), 'item/x_name': 'upserted' }, 'upsert'],
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
    }
  });
