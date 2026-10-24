import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { createConnectorRuntime, DATAVERSE_OPERATION_SPEC } from '../lib/connector-runtime.mjs';
import { executeFlowDefinition, inspectFlowDefinition } from '../lib/flow-runtime.mjs';

// The Dataverse connector operations share one parameter table with the interpreter allowlist and run through
// the SDK service of the flow principal (the organization's internal entries when the store has an organization).
const PARENT = '77777777-7777-4777-8777-000000000101', CHILD = '77777777-7777-4777-8777-000000000102', MISSING = '77777777-7777-4777-8777-000000000103';
const API = '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps';
const ops = ['read', 'create', 'update', 'delete', 'associate', 'disassociate'];
const profile = { userId: '77777777-7777-4777-8777-000000000100', evidence: 'Invented flow owner', grants: [{ entity: 'x_parent', operations: ops }, { entity: 'x_child', operations: ops }] };
function setup() {
  const store = new DataStore({ state: { version: 1, mappings: {
    x_parent: { entitySet: 'x_parents', idColumn: 'x_parentid', fields: { x_name: { type: 'string' } },
      relationships: { x_parent_children: { schemaName: 'x_parent_children', entity: 'x_child', from: 'x_parentid', to: 'x_parentid', many: true } } },
    x_child: { entitySet: 'x_children', idColumn: 'x_childid', fields: { x_name: { type: 'string' }, x_parentid: { type: 'lookup' } } },
  }, tables: { x_parent: [{ x_parentid: PARENT, x_name: 'parent' }], x_child: [{ x_childid: CHILD, x_name: 'child', x_parentid: null }] }, permissions: [], plugins: [], settings: { permissionMode: 'enforce' } } });
  const connectors = createConnectorRuntime({ store });
  const invoke = (operationId, parameters) => connectors.invoke({ connectorId: 'shared_commondataserviceforapps', operationId, parameters, context: { principal: profile } });
  return { store, connectors, invoke, rows: table => store.snapshot().tables[table] };
}
const action = (operationId, parameters, runAfter = {}) => ({ type: 'OpenApiConnection', runAfter, inputs: { host: { apiId: API, operationId }, parameters } });
const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } };

test('UpdateRecord upserts a missing row and updates an existing one; UpdateOnlyRecord fails NotFound on a missing row', async () => {
  const { invoke, rows } = setup();
  const created = await invoke('UpdateRecord', { entityName: 'x_parents', recordId: MISSING, 'item/x_name': 'upserted' });
  assert.equal(created.statusCode, 201);
  assert.equal(rows('x_parent').find(r => r.x_parentid === MISSING).x_name, 'upserted');
  const updated = await invoke('UpdateRecord', { entityName: 'x_parents', recordId: MISSING, 'item/x_name': 'again' });
  assert.deepEqual([updated.statusCode, updated.body.x_name], [200, 'again']);
  assert.equal(rows('x_parent').length, 2);
  assert.throws(() => invoke('UpdateOnlyRecord', { entityName: 'x_parents', recordId: '77777777-7777-4777-8777-000000000199', 'item/x_name': 'x' }), { code: 'NotFound' });
  const only = await invoke('UpdateOnlyRecord', { entityName: 'x_parents', recordId: PARENT, 'item/x_name': 'renamed' });
  assert.equal(only.body.x_name, 'renamed');
});

test('AssociateEntities relates two invented rows through a 1:N relationship and DisassociateEntities removes it', async () => {
  const { invoke, rows } = setup();
  await invoke('AssociateEntities', { entityName: 'x_parents', recordId: PARENT, associationEntityRelationship: 'x_parent_children', '@odata.id': `http://localhost:5555/api/data/v9.2/x_children(${CHILD})` });
  assert.equal(String(rows('x_child')[0].x_parentid?.id ?? rows('x_child')[0].x_parentid).toLowerCase(), PARENT);
  await invoke('DisassociateEntities', { entityName: 'x_parents', recordId: PARENT, associationEntityRelationship: 'x_parent_children', $id: `x_children(${CHILD})` });
  assert.equal(rows('x_child')[0].x_parentid ?? null, null);
});

test('an @odata.id on another origin is refused', () => {
  const { invoke, rows } = setup();
  assert.throws(() => invoke('AssociateEntities', { entityName: 'x_parents', recordId: PARENT, associationEntityRelationship: 'x_parent_children', '@odata.id': `https://other.example.test/api/data/v9.2/x_children(${CHILD})` }), /another organization/);
  assert.equal(rows('x_child')[0].x_parentid ?? null, null);
});

test('bound and unbound actions and file columns answer OperationUnsupported until the organization entry is wired', () => {
  const { invoke } = setup();
  assert.throws(() => invoke('PerformUnboundAction', { actionName: 'x_Recalculate', 'item/x_value': 1 }), { code: 'OperationUnsupported', status: 501 });
  assert.throws(() => invoke('PerformBoundAction', { entityName: 'x_parents', recordId: PARENT, actionName: 'x_Close' }), { code: 'OperationUnsupported' });
  assert.throws(() => invoke('GetEntityFileImageFieldContent', { entityName: 'x_parents', recordId: PARENT, fileImageFieldName: 'x_file' }), { code: 'OperationUnsupported' });
});

test('a changeset commits its rows together and rolls every one back when one fails', async () => {
  const { connectors, rows } = setup();
  const changeset = (second) => ({ triggers: manual, actions: {
    Batch: { type: 'ChangeSet', runAfter: {}, actions: {
      AddParent: action('CreateRecord', { entityName: 'x_parents', 'item/x_name': 'batched' }),
      Touch: second } },
    Reply: { type: 'Response', runAfter: { Batch: ['Succeeded', 'Failed'] }, inputs: { statusCode: 200, body: { batch: "@actions('Batch')['status']", touch: "@actions('Touch')['status']" } } } } });
  const ok = await executeFlowDefinition({ definition: changeset(action('UpdateOnlyRecord', { entityName: 'x_children', recordId: CHILD, 'item/x_name': 'touched' })), input: {}, connectors, serviceProfile: profile });
  assert.deepEqual(ok.body, { batch: 'Succeeded', touch: 'Succeeded' });
  assert.equal(rows('x_parent').length, 2);
  assert.equal(rows('x_child')[0].x_name, 'touched');
  const failed = await executeFlowDefinition({ definition: changeset(action('UpdateOnlyRecord', { entityName: 'x_children', recordId: MISSING, 'item/x_name': 'never' })), input: {}, connectors, serviceProfile: profile });
  assert.deepEqual(failed.body, { batch: 'Failed', touch: 'Failed' });
  assert.equal(rows('x_parent').length, 2, 'the first request of the failed changeset was rolled back');
  // Inside the run's store transaction (as the hosts run flows) the rollback holds too, and the transaction commits.
  const fresh = setup();
  const inTransaction = await fresh.store.transact(() => executeFlowDefinition({ definition: changeset(action('UpdateOnlyRecord', { entityName: 'x_children', recordId: MISSING, 'item/x_name': 'never' })), input: {}, connectors: fresh.connectors, serviceProfile: profile }), { cloneResult: false });
  assert.deepEqual([inTransaction.body.batch, fresh.rows('x_parent').length], ['Failed', 1]);
  const mixed = changeset(action('GetItem', { entityName: 'x_children', recordId: CHILD }));
  assert.match(inspectFlowDefinition(mixed, {}, { connectors, principal: profile }).errors.join(' '), /only Dataverse Add, Update, Upsert and Delete/);
});

test('inspect and invoke accept the same parameter set', () => {
  const { connectors, invoke } = setup();
  for (const [operationId, spec] of Object.entries(DATAVERSE_OPERATION_SPEC)) {
    if (operationId === 'ExecuteChangeset') continue;
    const definition = parameters => ({ triggers: manual, actions: { A: action(operationId, parameters), R: { type: 'Response', runAfter: { A: ['Succeeded', 'Failed'] }, inputs: { statusCode: 200 } } } });
    const allowed = Object.fromEntries(spec.parameters.map(key => [key, 'x']));
    const inspected = inspectFlowDefinition(definition({ ...allowed, ...(spec.item ? { 'item/x_name': 'x' } : {}) }), {}, { connectors, principal: profile });
    assert.ok(!inspected.errors.some(e => /Unsupported Dataverse parameter/.test(e)), operationId + ': ' + inspected.errors.join(' '));
    assert.match(inspectFlowDefinition(definition({ ...allowed, x_unknown: 'x' }), {}, { connectors, principal: profile }).errors.join(' '), /Unsupported Dataverse parameter A\/x_unknown/, operationId);
    assert.throws(() => invoke(operationId, { ...allowed, x_unknown: 'x' }), new RegExp(`Unsupported Dataverse parameter ${operationId}/x_unknown`));
  }
});
