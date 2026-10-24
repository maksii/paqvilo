// A mobile offline profile filter with a record hierarchy operator (under, above...) is a gap only on a table whose
// metadata has no hierarchical relationship (IsHierarchical on a self-referencing 1:N). The
// download reads EntityDefinitions(...)/OneToManyRelationships from the organization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOfflineSessions, hierarchicalIn, offlineProfileGaps, offlineSessionState } from '../lib/model-driven/offline.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const ROOT = '77777777-7777-4777-8777-000000000a01';
const under = (entity, extra = '') => ({ entity, distribution: 3, filter: `<fetch><entity name="${entity}"><filter><condition attribute="${entity}id" operator="under" value="${ROOT}"/></filter>${extra}</entity></fetch>` });
const selfHierarchy = (table) => [{ IsHierarchical: true, ReferencingEntity: table, ReferencedEntity: table }];

test('a hierarchy operator is a gap only on a table without a hierarchical relationship, including a linked table', () => {
  const linked = { entity: 'x_task', distribution: 3, filter: '<fetch><entity name="x_task"><link-entity name="x_node" from="x_nodeid" to="x_nodeid" alias="n"/><filter><condition entityname="n" attribute="x_nodeid" operator="eq-or-under" value="' + ROOT + '"/></filter></entity></fetch>' };
  const profile = { items: [under('x_node'), under('x_flat'), linked] };
  const hierarchical = (table) => hierarchicalIn(selfHierarchy('x_node'), table);
  assert.deepEqual(offlineProfileGaps(profile, { hierarchical }).map((gap) => [gap.entity, /x_flat has no hierarchical relationship/.test(gap.reason)]), [['x_flat', true]]);
  assert.deepEqual(offlineProfileGaps(profile).map((gap) => gap.entity), ['x_node', 'x_flat', 'x_task']);
  assert.equal(hierarchicalIn([{ IsHierarchical: true, ReferencingEntity: 'x_task', ReferencedEntity: 'x_node' }], 'x_task'), false);
});

test('the download reads the organization metadata and runs the hierarchy filter on the hierarchical table only', async () => {
  const table = (name) => ({ entity: name, entitySet: `${name}s`, idColumn: `${name}id`, nameColumn: 'x_name', fields: { [`${name}id`]: { name: `${name}id`, isPrimaryId: true }, x_name: { name: 'x_name' } }, relationships: {} });
  const asked = [];
  const webApi = async ({ method: _method, path }) => {
    asked.push(decodeURIComponent(path));
    const meta = /EntityDefinitions\(LogicalName='(\w+)'\)\/OneToManyRelationships$/.exec(path);
    if (meta) return { status: 200, body: JSON.stringify({ value: meta[1] === 'x_node' ? selfHierarchy('x_node') : [] }) };
    return { status: 200, body: JSON.stringify({ value: [] }) };
  };
  const catalogue = async () => ({ apps: [{ id: 'app-h', offlineProfiles: [{ name: 'p', items: [under('x_node'), under('x_flat')] }] }], tables: { x_node: table('x_node'), x_flat: table('x_flat') } });
  const store = await new DataStore({ state: emptyState() }).init();
  const sessions = createOfflineSessions({ webApi, catalogue, state: offlineSessionState(store) });
  const status = await sessions.setMode({ kind: 'staff', principalId: 'u-h' }, 'app-h', 'offline');
  assert.deepEqual(status.gaps.map((gap) => gap.entity), ['x_flat']);
  assert.ok(asked.some((p) => p.startsWith('/api/data/v9.2/x_nodes?fetchXml=') && p.includes('operator="under"')), 'the hierarchy filter reached the organization');
  assert.ok(!asked.some((p) => p.startsWith('/api/data/v9.2/x_flats?fetchXml=')), 'the non-hierarchical table is not downloaded by that filter');
});

test('the organization answers IsHierarchical on a self-referencing relationship in EntityDefinitions OneToManyRelationships', async (t) => {
  const { request, json } = await contractModuleFixture(t, {
    mappings: { x_node: { logicalName: 'x_node', entitySet: 'x_nodes', idColumn: 'x_nodeid', nameColumn: 'x_name', fields: { x_name: { dataverseType: 'nvarchar' }, x_parentid: { dataverseType: 'lookup', targets: ['x_node'] } },
      relationships: { x_parentid: { schemaName: 'x_node_parent', entity: 'x_node', from: 'x_parentid', to: 'x_nodeid', many: false, hierarchical: true } } } },
    extension: { name: 'x-invented-none', install() {} },
  });
  const list = await json(await request('GET', "/EntityDefinitions(LogicalName='x_node')/OneToManyRelationships"), 200);
  assert.equal(hierarchicalIn(list.value, 'x_node'), true);
});

test('the preflight row reads the Solution relationships: a hierarchy filter is satisfied on a hierarchical table only', async () => {
  const { buildSourceGraph } = await import('../lib/source-graph.mjs');
  const profile = (name, entity) => ({ component: 'mobileofflineprofile', id: null, name, items: [{ ...under(entity), relationships: [] }] });
  const rows = Object.fromEntries(buildSourceGraph({ scan: { inventory: [profile('fx_tree', 'x_node'), profile('fx_flat', 'x_flat')] },
    solutionData: { schema: { relationships: { x_node_parent: { schemaName: 'x_node_parent', type: 'one-to-many', isHierarchical: true, referencingEntity: 'x_node', referencedEntity: 'x_node' } } } } })
    .requirements().map((row) => [row.id, row]));
  assert.deepEqual([rows['model-driven:offline/fx_tree'].status, rows['model-driven:offline/fx_flat'].status, rows['model-driven:offline/fx_flat'].reason], ['satisfied', 'unsupported', 'MD_OFFLINE_FILTER_UNSUPPORTED']);
});
