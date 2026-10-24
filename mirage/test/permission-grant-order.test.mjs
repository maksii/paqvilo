import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePermissionFetchXml, permissionOrderGraphFingerprint } from '../lib/permission-query.mjs';
import { observedConfig } from '../lib/project-config.mjs';

const first = '00000000-0000-0000-0000-000000000001',
  second = '00000000-0000-0000-0000-000000000002';
const permissions = [
  {
    id: first,
    name: 'Owner',
    entity: 'widget',
    scope: 'contact',
    field: 'owner',
    roles: ['owner'],
    operations: ['read'],
  },
  {
    id: second,
    name: 'Reviewer',
    entity: 'widget',
    scope: 'contact',
    field: 'reviewer',
    roles: ['reviewer'],
    operations: ['read'],
  },
];
const order = {
  normalizedGraphHash: permissionOrderGraphFingerprint(permissions),
  tables: { widget: [[second], [first]] },
};
const source = '<fetch><entity name="widget"><attribute name="widgetid"/></entity></fetch>';
const compile = (roles, options = {}) =>
  compilePermissionFetchXml(source, {
    permissions,
    identity: { contactId: 'person', roles },
    grantOrder: order,
    ...options,
  });

test('source-bound ordering selects alternatives independently for each role subset', () => {
  assert.deepEqual(compile(['owner', 'reviewer']).grantIds, [second, first]);
  assert.deepEqual(compile(['owner']).grantIds, [first]);
  assert.deepEqual(compile(['reviewer']).grantIds, [second]);
  assert.deepEqual(compile([]).grantIds, []);
  assert.ok(
    compile(['owner', 'reviewer']).xml.indexOf('attribute="reviewer"') <
      compile(['owner', 'reviewer']).xml.indexOf('attribute="owner"'),
  );
});

test('ordering never qualifies a changed or incompletely mapped permission graph', () => {
  for (const patch of [
    { name: 'Changed' },
    { roles: ['other'] },
    { field: 'changed' },
    { enabled: false },
    { operations: ['read', 'write'] },
  ])
    assert.throws(
      () => compile(['owner', 'reviewer'], { permissions: [{ ...permissions[0], ...patch }, permissions[1]] }),
      (error) => error.code === 'PermissionGrantOrderUnqualified',
    );
  assert.throws(
    () => compile(['owner'], { grantOrder: { ...order, tables: { widget: [[second]] } } }),
    (error) => error.code === 'PermissionGrantOrderUnqualified',
  );
  assert.throws(
    () => compile(['owner', 'reviewer'], { grantOrder: { ...order, tables: {} } }),
    (error) => error.code === 'PermissionGrantOrderUnqualified',
  );
  assert.deepEqual(compile(['owner', 'reviewer'], { grantOrder: undefined }).grantIds, [first, second]);
  assert.equal(permissionOrderGraphFingerprint([...permissions].reverse()), order.normalizedGraphHash);
});

test('observed ordered GUID groups require evidence and reject malformed, duplicate and oversized inputs', () => {
  const config = { tablePermissionGrantOrder: order, evidence: 'Invented source-bound ordering fixture' };
  assert.deepEqual(observedConfig(config).tablePermissionGrantOrder, order);
  assert.throws(() => observedConfig({ tablePermissionGrantOrder: order }), /evidence/);
  for (const bad of [
    { ...order, normalizedGraphHash: 'bad' },
    { ...order, unexpected: true },
    { ...order, tables: { widget: [[]] } },
    { ...order, tables: { widget: [[first], [first.toUpperCase()]] } },
    { ...order, tables: { widget: [['bad']] } },
    { ...order, tables: { 'invalid/table': [[first]] } },
    { ...order, tables: { widget: Array.from({ length: 5001 }, () => [first]) } },
  ])
    assert.throws(() => observedConfig({ ...config, tablePermissionGrantOrder: bad }), /tablePermissionGrantOrder/);
  const isolated = observedConfig(config);
  order.tables.widget[0].push(first);
  assert.deepEqual(isolated.tablePermissionGrantOrder.tables.widget, [[second], [first]]);
  order.tables.widget[0].pop();
});
