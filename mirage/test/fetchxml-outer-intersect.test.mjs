import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';

const query =
  '<fetch><entity name="child"><attribute name="childid"/><link-entity name="edge" from="childid" to="childid" link-type="outer" alias="e"/><filter><condition entityname="e" attribute="edgeid" operator="null"/></filter></entity></fetch>';
function state(metadata) {
  return {
    settings: { permissionMode: 'enforce' },
    mappings: {
      parent: { idColumn: 'parentid' },
      child: {
        idColumn: 'childid',
        ...(metadata
          ? {
              relationships: {
                parents: {
                  entity: 'parent',
                  from: 'childid',
                  to: 'parentid',
                  many: true,
                  intersect: { entity: 'edge', from: 'childid', to: 'parentid' },
                },
              },
            }
          : {}),
      },
      edge: { idColumn: 'edgeid' },
    },
    tables: {
      parent: [{ parentid: 'p1' }],
      child: [{ childid: 'c1' }, { childid: 'c2' }],
      edge: [{ edgeid: 'e1', childid: 'c1', parentid: 'p1' }],
    },
    permissions: ['parent', 'child', 'edge'].map((entity) => ({
      entity,
      scope: 'global',
      operations: ['read'],
      roles: ['reader'],
    })),
  };
}
for (const metadata of [false, true])
  test(`outer intersect NULL filters the joined alias with relationship metadata ${metadata}`, () => {
    const store = new DataStore({ state: state(metadata) });
    assert.deepEqual(
      store.fetchXml(query, { roles: ['reader'] }).entities.map((row) => row.childid),
      ['c2'],
    );
  });
test('mapped structural N:N traversal needs endpoint permissions, not an independent intersect grant', () => {
  const data = state(true);
  data.permissions = data.permissions.filter((rule) => rule.entity !== 'edge');
  const store = new DataStore({ state: data });
  assert.deepEqual(
    store.fetchXml(query, { roles: ['reader'] }).entities.map((row) => row.childid),
    ['c2'],
  );
  assert.deepEqual(store.rows('edge', { roles: ['reader'] }), []);
});
test('a declared outer N:N link can project its endpoint key without linking the other table', () => {
  const selected =
    '<fetch distinct="true"><entity name="child"><attribute name="childid"/><link-entity name="edge" from="childid" to="childid" intersect="true" link-type="outer" alias="MO"><attribute name="parentid"/></link-entity><filter><condition entityname="MO" attribute="parentid" operator="null"/></filter></entity></fetch>';
  for (const declared of [true, false]) {
    const data = state(declared);
    data.permissions = data.permissions.filter((rule) => rule.entity !== 'edge');
    const store = new DataStore({ state: data });
    assert.deepEqual(
      store.fetchXml(selected, { roles: ['reader'] }).entities.map((row) => row.childid),
      declared ? ['c2'] : ['c1', 'c2'],
    );
    assert.deepEqual(store.rows('edge', { roles: ['reader'] }), []);
  }
});
test('query column names never grant intersection reads without mapped structural evidence', () => {
  const data = state(false);
  data.permissions = data.permissions.filter((rule) => rule.entity !== 'edge');
  const store = new DataStore({ state: data });
  assert.deepEqual(store.rows('edge', { roles: ['reader'] }), []);
  assert.deepEqual(store.fetchXml('<fetch><entity name="edge"/></fetch>', { roles: ['reader'] }).entities, []);
  // An unreadable ordinary join has no visible related row; column names alone
  // must not turn it into privileged structural N:N traversal.
  assert.deepEqual(
    store.fetchXml(query, { roles: ['reader'] }).entities.map((row) => row.childid),
    ['c1', 'c2'],
  );
});

test('structural endpoint projections do not expose arbitrary intersection columns', () => {
  const data = state(true);
  data.permissions = data.permissions.filter((rule) => rule.entity !== 'edge');
  data.tables.edge[0].privatevalue = 'hidden';
  const store = new DataStore({ state: data });
  const xml =
    '<fetch><entity name="child"><attribute name="childid"/><link-entity name="edge" from="childid" to="childid" link-type="outer" alias="MO"><attribute name="privatevalue"/></link-entity></entity></fetch>';
  const result = store.fetchXml(xml, { roles: ['reader'] });
  assert.deepEqual(
    result.entities.map((row) => [row.childid, row['MO.privatevalue'] ?? null]),
    [
      ['c1', null],
      ['c2', null],
    ],
  );
  assert.deepEqual(store.rows('edge', { roles: ['reader'] }), []);
});
