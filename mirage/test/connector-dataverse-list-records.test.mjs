import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { inspectFlowDefinition } from '../lib/flow-runtime.mjs';

// Dataverse List rows with fetchXml, $expand and 5,000-row pages continued through $skiptoken / @odata.nextLink.
const ops = ['read', 'create', 'update', 'delete'];
const id = n => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const hidden = row => row.x_name !== 'c-hidden';
const profile = { userId: id(100), evidence: 'Invented flow owner', grants: [{ entity: 'x_parent', operations: ops }, { entity: 'x_child', operations: ['read'], predicate: hidden }] };
const PARENTS = 5001;
function setup(extraGrants = []) {
  const parents = Array.from({ length: PARENTS }, (_, i) => ({ x_parentid: id(1000 + i), x_name: 'p' + String(i).padStart(5, '0') }));
  const children = [{ x_childid: id(201), x_name: 'c-shown', x_parentid: id(1000) }, { x_childid: id(202), x_name: 'c-hidden', x_parentid: id(1000) }];
  const store = new DataStore({ state: { version: 1, mappings: {
    x_parent: { entitySet: 'x_parents', idColumn: 'x_parentid', fields: { x_name: { type: 'string' } }, relationships: {
      x_parent_children: { schemaName: 'x_parent_children', entity: 'x_child', from: 'x_parentid', to: 'x_parentid', many: true },
      x_parent_tags: { schemaName: 'x_parent_tags', entity: 'x_tag', from: 'x_parentid', to: 'x_tagid', many: true, intersect: { entity: 'x_parent_tag', from: 'x_parentid', to: 'x_tagid' } } } },
    x_child: { entitySet: 'x_children', idColumn: 'x_childid', fields: { x_name: { type: 'string' }, x_parentid: { type: 'lookup' } } },
    x_secret: { entitySet: 'x_secrets', idColumn: 'x_secretid', fields: { x_name: { type: 'string' } } } },
    tables: { x_parent: parents, x_child: children, x_secret: [] }, permissions: [], plugins: [], settings: { permissionMode: 'enforce' } } });
  const connectors = createConnectorRuntime({ store });
  const principal = { ...profile, grants: [...profile.grants, ...extraGrants] };
  const list = (parameters, extra = {}) => connectors.invoke({ connectorId: 'shared_commondataserviceforapps', operationId: 'ListRecords', parameters: { entityName: 'x_parents', ...parameters }, context: { principal }, ...extra });
  return { connectors, list };
}

test('List rows answers 5,000 rows with an @odata.nextLink whose skip token reads the next page; pagination follows it', async () => {
  const { list } = setup();
  const first = await list({ $orderby: 'x_name' });
  assert.equal(first.body.value.length, 5000);
  assert.equal(first.nextLink, first.body['@odata.nextLink']);
  const skiptoken = new URL(first.nextLink, 'http://localhost/').searchParams.get('$skiptoken');
  const second = await list({ $orderby: 'x_name', $skiptoken: skiptoken });
  assert.deepEqual([second.body.value.length, second.body.value[0].x_name, second.nextLink, second.body['@odata.nextLink']], [1, 'p05000', undefined, undefined]);
  const all = await list({ $orderby: 'x_name' }, { pagination: { minimumItemCount: 100000 } });
  assert.deepEqual([all.body.value.length, all.nextLink, all.body['@odata.nextLink']], [PARENTS, undefined, undefined]);
  await assert.rejects(async () => list({ $skiptoken: 'invented' }), { status: 400, code: 'LocalFlowExpression' });
});

test('fetchXml runs through the secured SDK fetch with the same paging', async () => {
  const { list } = setup();
  const xml = '<fetch page="9"><entity name="x_parent"><attribute name="x_name"/><order attribute="x_name"/></entity></fetch>';
  const first = await list({ fetchXml: xml });
  assert.deepEqual([first.body.value.length, first.body.value[0].x_name, Boolean(first.nextLink)], [5000, 'p00000', true]);
  const skiptoken = new URL(first.nextLink, 'http://localhost/').searchParams.get('$skiptoken');
  const second = await list({ fetchXml: xml, $skiptoken: skiptoken });
  assert.deepEqual([second.body.value.length, second.body.value[0].x_name, second.nextLink], [1, 'p05000', undefined]);
  // The child predicate filters fetched rows; a table without a read grant is refused.
  const children = await list({ entityName: 'x_children', fetchXml: '<fetch><entity name="x_child"><attribute name="x_name"/></entity></fetch>' });
  assert.deepEqual(children.body.value.map(r => r.x_name), ['c-shown']);
  await assert.rejects(async () => list({ entityName: 'x_secrets', fetchXml: '<fetch><entity name="x_secret"/></fetch>' }), { status: 403, code: 'LocalBackendPermissionDenied' });
  await assert.rejects(async () => list({ fetchXml: xml, $filter: "x_name eq 'p1'" }), { status: 400 });
});

test('$expand reads related rows through the SDK service grants and keeps $select', async () => {
  const { list, connectors } = setup();
  const answer = await list({ $filter: `x_parentid eq ${id(1000)}`, $select: 'x_name', $expand: 'x_parent_children($select=x_name)' });
  assert.deepEqual(answer.body.value, [{ x_parentid: id(1000), x_name: 'p00000', x_parent_children: [{ x_childid: id(201), x_name: 'c-shown' }] }]);
  await assert.rejects(async () => list({ $expand: 'x_parent_tags' }), { status: 501, code: 'LocalFlowUnsupported' });
  await assert.rejects(async () => list({ $expand: 'x_missing' }), { status: 400 });
  const denied = { ...profile, grants: [profile.grants[0]] };
  await assert.rejects(async () => connectors.invoke({ connectorId: 'shared_commondataserviceforapps', operationId: 'ListRecords', parameters: { entityName: 'x_parents', $top: 1, $expand: 'x_parent_children' }, context: { principal: denied } }),
    { status: 403, code: 'LocalBackendPermissionDenied' });
  // Inspection accepts the parameters; relevance search stays unsupported.
  const def = { triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } }, actions: { L: { type: 'OpenApiConnection', runAfter: {}, inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', operationId: 'ListRecords' }, parameters: { entityName: 'x_parents', $expand: 'x_parent_children', fetchXml: '<fetch/>', $skiptoken: 'x' } } } } };
  assert.deepEqual(inspectFlowDefinition(def, {}, { connectors, principal: profile }).errors, []);
  await assert.rejects(async () => connectors.invoke({ connectorId: 'shared_commondataserviceforapps', operationId: 'GetRelevantRows', parameters: { search: 'p' }, context: { principal: profile } }), { status: 501 });
});
