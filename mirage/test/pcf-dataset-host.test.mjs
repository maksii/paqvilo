import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDatasetHost, pcfAdmission as runtimeAdmission, pcfDescriptor } from '../lib/model-driven/pcf-runtime.mjs';
import { pcfAdmission, renderCodeComponent } from '../lib/code-components.mjs';
import { importModelDrivenResources } from '../lib/model-driven-resources.mjs';
import { modelDrivenFixture } from './model-driven-fixture.mjs';

const table = { entity: 'x_child', idColumn: 'x_childid', nameColumn: 'x_name', label: 'Children',
  fields: { x_childid: { name: 'x_childid', type: 'text' }, x_name: { name: 'x_name', type: 'text', label: 'Name' }, x_parentid: { name: 'x_parentid', type: 'lookup', targets: ['x_item'] } } };
const tables = { x_child: table, x_item: { entity: 'x_item', fields: { x_itemid: { name: 'x_itemid' }, x_name: { name: 'x_name' } } } };
const rows = Array.from({ length: 5 }, (_, index) => ({ x_childid: `77777777-7777-4777-8777-77777777777${index}`, x_name: `Child ${index}`, x_parentid: '77777777-7777-4777-8777-777777777799',
  'x_parentid@OData.Community.Display.V1.FormattedValue': 'Invented parent', 'x_parentid@Microsoft.Dynamics.CRM.lookuplogicalname': 'x_item' }));

function host(extra = {}) {
  const queries = [], opened = [];
  const query = async input => { queries.push(input); const ordered = input.direction === 'desc' ? [...rows].reverse() : rows; return { rows: ordered.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), total: rows.length }; };
  return { queries, opened, ...createDatasetHost({ table, tables, view: { id: 'children-view', name: 'Children' }, columns: [{ name: 'x_name', width: 200 }, { name: 'x_parentid' }],
    query, openRecord: (entity, id) => opened.push([entity, id]), baseFilters: [{ field: 'x_parentid', operator: 'eq', value: '77777777-7777-4777-8777-777777777799' }], ...extra }) };
}

test('a dataset PCF pages, sorts, filters and formats records over the view query', async () => {
  const { dataset, load, queries } = host();
  dataset.paging.setPageSize(2); await load();
  assert.deepEqual(dataset.sortedRecordIds, [rows[0].x_childid, rows[1].x_childid]);
  assert.deepEqual([dataset.paging.totalResultCount, dataset.paging.hasNextPage, dataset.paging.hasPreviousPage], [5, true, false]);
  assert.deepEqual(queries[0], { view: 'children-view', page: 1, pageSize: 2, filters: [{ field: 'x_parentid', operator: 'eq', value: '77777777-7777-4777-8777-777777777799' }], columns: ['x_name', 'x_parentid'] });
  const first = dataset.records[rows[0].x_childid];
  assert.equal(first.getFormattedValue('x_parentid'), 'Invented parent');
  assert.deepEqual(first.getValue('x_parentid'), { id: { guid: '77777777-7777-4777-8777-777777777799' }, name: 'Invented parent', etn: 'x_item' });
  assert.equal(dataset.columns[0].dataType, 'SingleLine.Text'); assert.equal(dataset.columns[1].dataType, 'Lookup.Simple');
  await dataset.paging.loadNextPage();
  assert.deepEqual(dataset.sortedRecordIds, [rows[2].x_childid, rows[3].x_childid]); assert.equal(dataset.paging.hasPreviousPage, true);
  dataset.sorting.push({ name: 'x_name', sortDirection: 1 }); await dataset.refresh();
  assert.equal(queries.at(-1).sort, 'x_name'); assert.equal(queries.at(-1).direction, 'desc'); assert.equal(dataset.sortedRecordIds[0], rows[4].x_childid);
  dataset.filtering.setFilter({ filterOperator: 0, conditions: [{ attributeName: 'x_name', conditionOperator: 6, value: 'Child%' }] }); await dataset.refresh();
  assert.deepEqual(queries.at(-1).filters.at(-1), { field: 'x_name', operator: 'like', value: 'Child%' });
  assert.throws(() => dataset.filtering.setFilter({ filterOperator: 1, conditions: [] }), /AND group/);
  dataset.sorting.push({ name: 'x_parentid', sortDirection: 0 }); await dataset.refresh();
  assert.equal(dataset.error, true); assert.match(dataset.errorMessage, /one column/);
});

test('a dataset PCF links an imported table and opens its records', async () => {
  const { dataset, load, queries, opened } = host();
  dataset.linking.addLinkedEntity({ name: 'x_item', from: 'x_itemid', to: 'x_parentid', linkType: 'outer', alias: 'parent' });
  dataset.addColumn('x_name', 'parent'); await load();
  assert.deepEqual(queries[0].links, [{ name: 'x_item', from: 'x_itemid', to: 'x_parentid', linkType: 'outer', alias: 'parent', columns: ['x_name'] }]);
  assert.ok(dataset.columns.some(column => column.name === 'parent.x_name'));
  assert.throws(() => dataset.linking.addLinkedEntity({ name: 'x_unknown', from: 'a', to: 'b', alias: 'c' }), /imported table/);
  await dataset.openDatasetItem(dataset.records[rows[0].x_childid].getNamedReference());
  assert.deepEqual(opened, [['x_child', rows[0].x_childid]]);
});

test('the view query engine joins linked tables for dataset components', async t => {
  const { origin, sim } = await modelDrivenFixture(t);
  const input = { view: 'children-view', links: [{ name: 'x_item', from: 'x_itemid', to: 'x_parentid', linkType: 'inner', alias: 'parent', columns: ['x_name'] }] };
  const response = await fetch(`${origin}/_apps/api/tables/x_child?query=${encodeURIComponent(JSON.stringify(input))}`, { headers: { 'x-sim-csrf': sim.state().csrf } });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.rows.map(row => [row.x_name, row['parent.x_name']]).sort(), [['Copper child', 'Copper'], ['Silver child', 'Silver']]);
  const bad = await fetch(`${origin}/_apps/api/tables/x_child?query=${encodeURIComponent(JSON.stringify({ links: [{ name: 'x_item', from: 'nope', to: 'x_parentid', alias: 'p' }] }))}`);
  assert.equal(bad.status, 400);
});

test('Power Pages and model-driven hosts share one PCF admission rule', () => {
  assert.equal(pcfAdmission, runtimeAdmission);
  const virtual = { name: 'x_Invented.Virtual', controlType: 'virtual', libraries: [{ name: 'React', version: '16.14.0' }], properties: [] };
  const refused = pcfAdmission(virtual);
  assert.equal(refused.code, 'PCF_VIRTUAL_UNSUPPORTED'); assert.match(refused.reason, /x_Invented\.Virtual/); assert.deepEqual(refused.missing, ['React@16.14.0', 'ReactDOM@16.14.0']);
  const libraries = [{ name: 'React', version: '16.14.0', url: '/_apps/controls/platform/a/React.js' }, { name: 'ReactDOM', version: '16.14.0', url: '/_apps/controls/platform/b/ReactDOM.js' }];
  assert.deepEqual(pcfAdmission(virtual, { platformLibraries: libraries }), { admitted: true, kind: 'virtual', dataset: false, libraries });
  assert.equal(pcfAdmission({ ...virtual, libraries: [] }).code, 'PCF_VIRTUAL_UNSUPPORTED');
  assert.equal(pcfAdmission({ name: 'x_Grid', controlType: 'standard', datasets: [{ name: 'records' }] }).kind, 'dataset');
  // The model-driven field host refuses the virtual control with the same code; a dataset control needs a subgrid.
  assert.equal(pcfDescriptor({ name: virtual.name }, { trusted: true, pcf: { controls: [virtual] } }).code, 'PCF_VIRTUAL_UNSUPPORTED');
  assert.equal(pcfDescriptor({ name: virtual.name }, { trusted: true, pcf: { controls: [virtual], platformLibraries: libraries } }).admission.kind, 'virtual');
  // The Power Pages host reports the same code in its diagnostic.
  const diagnostics = [];
  const catalog = { controls: new Map([['x_Invented.Virtual', { ...virtual, schemaName: 'x_Invented.Virtual', type: 'virtual', features: [] }]]) };
  assert.match(renderCodeComponent({ name: 'x_Invented.Virtual', portal: {}, catalog, diagnostic: entry => diagnostics.push(entry) }), /requires platform libraries \(React 16\.14\.0\)/);
  assert.equal(diagnostics[0].reason, 'PCF_VIRTUAL_UNSUPPORTED');
});

test('clientSources library files become platform libraries served under /_apps/controls/platform/', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-platform-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'React@16.14.0.js'), 'window.React = { createElement() {} };');
  await fs.writeFile(path.join(root, 'react.min.js'), '');
  const result = await importModelDrivenResources([], { clientSources: [path.join(root, 'React@16.14.0.js'), path.join(root, 'react.min.js')] });
  assert.deepEqual(result.pcf.platformLibraries.map(library => [library.name, library.version]), [['React', '16.14.0']]);
  assert.match(result.pcf.platformLibraries[0].url, /^\/_apps\/controls\/platform\/[0-9a-f]+\/React\.js$/);
  assert.equal(result.assets.get(result.pcf.platformLibraries[0].url).data.toString(), 'window.React = { createElement() {} };');
  assert.equal(result.diagnostics.find(entry => entry.code === 'MODEL_PCF_PLATFORM_LIBRARY_INVALID')?.message.includes('<Library>@<version>.js'), true);
});
