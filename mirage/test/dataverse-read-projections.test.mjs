// @test-kind parity: native and native-r2 relationsReads ($expand child keys, fetchXml row keys), faults ($select on an organization-owned table), imageAliasOrder (multi-select read as a comma-joined string)
// Web API read projections of invented x_parent and x_child rows: the keys of each $expand child, each fetchXml row and
// each $select row of an organization-owned table, and the multi-select value of a read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const PARENT = '20000000-0000-0000-0000-0000000000a1';
const CHILD_ONE = '20000000-0000-0000-0000-0000000000c1';
const CHILD_TWO = '20000000-0000-0000-0000-0000000000c2';

const parentRef = { id: PARENT, logical_name: 'x_parent', name: 'Invented parent' };

// Sorted key set of an object, ignoring the annotations (keys with an '@').
const keysOf = (object) =>
  Object.keys(object)
    .filter((key) => !key.includes('@'))
    .sort();

async function fixture(t) {
  return contractModuleFixture(t, {
    mappings: {
      x_parent: {
        logicalName: 'x_parent',
        entitySet: 'x_parents',
        idColumn: 'x_parentid',
        nameColumn: 'x_name',
        relationships: { x_parent_children: { entity: 'x_child', many: true, from: 'x_parentid', to: 'x_parentid' } },
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_choices: { dataverseType: 'multiselectpicklist', options: [{ value: 1 }, { value: 2 }] },
        },
      },
      x_child: {
        logicalName: 'x_child',
        entitySet: 'x_children',
        idColumn: 'x_childid',
        nameColumn: 'x_name',
        ownership: 'OrganizationOwned',
        relationships: { x_parentid: { entity: 'x_parent', many: false, from: 'x_parentid', to: 'x_parentid' } },
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] },
        },
      },
    },
    tables: {
      x_parent: [{ x_parentid: PARENT, x_name: 'Invented parent', x_choices: '1,2' }],
      x_child: [
        { x_childid: CHILD_ONE, x_name: 'Invented child one', x_parentid: parentRef },
        { x_childid: CHILD_TWO, x_name: 'Invented child two', x_parentid: parentRef },
      ],
    },
    extension: { name: 'read-projections-probe', install: () => {} },
  });
}

async function getJson(f, path) {
  return f.json(await f.request('GET', path), 200);
}

test('an $expand of a collection navigation with a nested $select returns the selected columns and the child key only', async (t) => {
  const f = await fixture(t);
  const body = await getJson(f, `/x_parents(${PARENT})?$expand=x_parent_children($select=x_name)`);
  assert.ok(body.x_parent_children.length > 0);
  for (const child of body.x_parent_children) assert.deepEqual(keysOf(child), ['x_childid', 'x_name']);
});

test('a fetchXml GET returns the primary key of each row even when only other attributes are listed', async (t) => {
  const f = await fixture(t);
  const fetch = "<fetch><entity name='x_child'><attribute name='x_name'/></entity></fetch>";
  const body = await getJson(f, `/x_children?fetchXml=${encodeURIComponent(fetch)}`);
  assert.equal(body.value.length, 2);
  for (const row of body.value) assert.deepEqual(keysOf(row), ['x_childid', 'x_name']);
});

test('a $select on an organization-owned table returns the selected columns and the primary key only', async (t) => {
  const f = await fixture(t);
  const body = await getJson(f, '/x_children?$select=x_name');
  assert.equal(body.value.length, 2);
  for (const row of body.value) assert.deepEqual(keysOf(row), ['x_childid', 'x_name']);
});

test('a multi-select choice column reads as a comma-joined string of its integer values', async (t) => {
  const f = await fixture(t);
  const body = await getJson(f, `/x_parents(${PARENT})?$select=x_choices`);
  assert.equal(body.x_choices, '1,2');
});
