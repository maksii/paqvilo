// One computed-value source for every read: calculated and formula columns compute through the store seam
// (store.setComputedColumns), so $filter, $orderby, $apply, FetchXML conditions/attributes and the property route read the
// computed value, never the stale stored one (filtering on calculated columns is supported; ordering on a column over a
// parent or another calculated column is ignored without error).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION as FORMULA } from '../lib/dataverse-formula.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { readFixture } from './read-projection-fixture.mjs';

const A = '77777777-7777-4777-8777-00000000000a',
  B = '77777777-7777-4777-8777-00000000000b',
  C = '77777777-7777-4777-8777-00000000000c';
const P1 = '77777777-7777-4777-8777-0000000000f1',
  P2 = '77777777-7777-4777-8777-0000000000f2';
const calc = (formulaDefinition, dataverseType = 'decimal') => ({
  dataverseType,
  columnMetadata: { sourceType: 1, formulaDefinition },
});
const mappings = {
  x_parent: {
    logicalName: 'x_parent',
    entitySet: 'x_parents',
    idColumn: 'x_parentid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_rate: { dataverseType: 'decimal' } },
  },
  x_item: {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    relationships: { x_parentid: { entity: 'x_parent', from: 'x_parentid', to: 'x_parentid', many: false } },
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_amount: { dataverseType: 'decimal' },
      x_quantity: { dataverseType: 'int' },
      x_parentid: { dataverseType: 'lookup' },
      x_total: calc('<Multiply><Field Name="x_amount"/><Field Name="x_quantity"/></Multiply>'),
      x_double: calc('<Multiply><Field Name="x_total"/><Constant Value="2"/></Multiply>'),
      x_scaled: calc('<Multiply><Field Name="x_amount"/><Field Name="x_parentid.x_rate"/></Multiply>'),
    },
  },
};
// Stored x_total values are stale: 999 on A, absent on B and C. Parent rates make x_scaled sort c, a, b while names sort a, b, c.
const tables = {
  x_parent: [
    { x_parentid: P1, x_name: 'p1', x_rate: 1 },
    { x_parentid: P2, x_name: 'p2', x_rate: 100 },
  ],
  x_item: [
    {
      x_itemid: A,
      x_name: 'a',
      x_amount: 1,
      x_quantity: 1,
      x_total: 999,
      x_parentid: { id: P1, logical_name: 'x_parent' },
      statecode: 0,
      statuscode: 1,
    },
    {
      x_itemid: B,
      x_name: 'b',
      x_amount: 10,
      x_quantity: 5,
      x_parentid: { id: P1, logical_name: 'x_parent' },
      statecode: 0,
      statuscode: 1,
    },
    {
      x_itemid: C,
      x_name: 'c',
      x_amount: 3,
      x_quantity: 2,
      x_parentid: { id: P2, logical_name: 'x_parent' },
      statecode: 0,
      statuscode: 1,
    },
  ],
};
const names = (body) => body.value.map((row) => row.x_name);
const fx = (xml) => `/x_items?fetchXml=${encodeURIComponent(xml)}`;

test('$filter on a calculated column compares the computed value, not the stored one', async (t) => {
  const f = await readFixture(t, { mappings, tables });
  assert.deepEqual(names(await f.json(await f.request('GET', '/x_items?$select=x_name&$filter=x_total ge 50'), 200)), [
    'b',
  ]);
  assert.deepEqual(
    names(await f.json(await f.request('GET', '/x_items?$select=x_name&$filter=x_total eq 999'), 200)),
    [],
  );
  // A chained calculated column reads the other one computed.
  assert.deepEqual(
    names(await f.json(await f.request('GET', '/x_items?$select=x_name&$filter=x_double eq 100'), 200)),
    ['b'],
  );
});

test('$orderby on a same-row calculated column sorts by the computed value', async (t) => {
  const f = await readFixture(t, { mappings, tables });
  const body = await f.json(await f.request('GET', '/x_items?$select=x_name,x_total&$orderby=x_total desc'), 200);
  assert.deepEqual(
    body.value.map((row) => [row.x_name, row.x_total]),
    [
      ['b', 50],
      ['c', 6],
      ['a', 1],
    ],
  );
});

test('$orderby on a parent-referencing or chained calculated column is ignored without error', async (t) => {
  const f = await readFixture(t, { mappings, tables });
  const scaled = await f.json(
    await f.request('GET', '/x_items?$select=x_name,x_scaled&$orderby=x_scaled desc,x_name asc'),
    200,
  );
  assert.deepEqual(names(scaled), ['a', 'b', 'c']);
  assert.deepEqual(
    scaled.value.map((row) => row.x_scaled),
    [1, 10, 300],
  );
  assert.deepEqual(
    names(await f.json(await f.request('GET', '/x_items?$select=x_name&$orderby=x_double desc,x_name asc'), 200)),
    ['a', 'b', 'c'],
  );
});

test('$apply aggregate over a calculated column sums computed values', async (t) => {
  const f = await readFixture(t, { mappings, tables });
  const body = await f.json(await f.request('GET', '/x_items?$apply=aggregate(x_total with sum as s)'), 200);
  assert.equal(Number(body.value[0].s), 57);
});

test('FetchXML condition and attribute on a calculated column use the computed value', async (t) => {
  const f = await readFixture(t, { mappings, tables });
  const body = await f.json(
    await f.request(
      'GET',
      fx(
        '<fetch><entity name="x_item"><attribute name="x_name"/><attribute name="x_total"/><filter><condition attribute="x_total" operator="ge" value="50"/></filter></entity></fetch>',
      ),
    ),
    200,
  );
  assert.deepEqual(
    body.value.map((row) => [row.x_name, row.x_total]),
    [['b', 50]],
  );
  const ordered = await f.json(
    await f.request(
      'GET',
      fx(
        '<fetch><entity name="x_item"><attribute name="x_name"/><order attribute="x_total" descending="true"/></entity></fetch>',
      ),
    ),
    200,
  );
  assert.deepEqual(names(ordered), ['b', 'c', 'a']);
});

test('property route returns the computed value', async (t) => {
  const f = await readFixture(t, { mappings, tables });
  assert.equal((await f.json(await f.request('GET', `/x_items(${A})/x_total`), 200)).value, 1);
  assert.equal(await (await f.request('GET', `/x_items(${A})/x_total/$value`)).text(), '1');
});

test('formula columns filter, sort and read through the same seam', async (t) => {
  const formula = {
    dataverseType: 'decimal',
    columnMetadata: { sourceType: 3, formulaDefinition: 'x_amount * x_quantity' },
  };
  const { request, json } = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        ...mappings.x_item,
        relationships: {},
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_amount: { dataverseType: 'decimal' },
          x_quantity: { dataverseType: 'int' },
          x_total: formula,
        },
      },
    },
    tables: { x_item: tables.x_item.map(({ x_parentid, ...row }) => row) },
    extension: FORMULA,
    options: { formulaColumns: { 'x_item.x_total': (row) => row.x_amount * row.x_quantity } },
  });
  assert.deepEqual(names(await json(await request('GET', '/x_items?$select=x_name&$filter=x_total ge 50'), 200)), [
    'b',
  ]);
  assert.deepEqual(names(await json(await request('GET', '/x_items?$select=x_name&$orderby=x_total desc'), 200)), [
    'b',
    'c',
    'a',
  ]);
  assert.equal((await json(await request('GET', `/x_items(${A})/x_total`), 200)).value, 1);
  const fetched = await json(
    await request(
      'GET',
      fx(
        '<fetch><entity name="x_item"><attribute name="x_name"/><filter><condition attribute="x_total" operator="lt" value="5"/></filter></entity></fetch>',
      ),
    ),
    200,
  );
  assert.deepEqual(names(fetched), ['a']);
});
