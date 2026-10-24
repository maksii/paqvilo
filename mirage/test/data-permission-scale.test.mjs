// Performance regression: parent-scope table permissions through a
// many-to-many (intersect) relationship must evaluate by key lookups, not by
// scanning parents x intersect rows for every child. Shapes follow ExampleApp's
// exported change-request grant (change request -> sample_changerequest_product
// -> product -> customer account -> parent account -> application user role).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';

const SMALL = 1000,
  SIZE = 10000;
const id = (prefix, n) => `${prefix}-${String(n).padStart(6, '0')}`;

function scaleState(SIZE) {
  const tables = {
    account: [],
    role: [],
    product: [],
    change: [],
    change_product: [],
  };
  for (let n = 0; n < 60; n++) {
    tables.account.push({
      accountid: id('org', n),
      name: `Org ${n}`,
      parentaccountid: n < 30 ? null : { id: id('org', n - 30), logical_name: 'account' },
    });
    if (n < 30)
      tables.role.push({
        roleid: id('role', n),
        userid: n % 10 === 0 ? 'me' : `user-${n}`,
        organisationid: { id: id('org', n), logical_name: 'account' },
      });
  }
  for (let n = 0; n < SIZE; n++) {
    tables.product.push({
      productid: id('p', n),
      customerid: { id: id('org', 30 + (n % 30)), logical_name: 'account' },
    });
    tables.change.push({ changeid: id('c', n), name: `Change ${n}` });
    tables.change_product.push({
      change_productid: id('cp', n),
      changeid: id('c', n),
      productid: id('p', (n * 7) % SIZE),
    });
  }
  return {
    mappings: {
      account: { entitySet: 'accounts', idColumn: 'accountid' },
      role: { entitySet: 'roles', idColumn: 'roleid' },
      product: { entitySet: 'products', idColumn: 'productid' },
      change: { entitySet: 'changes', idColumn: 'changeid' },
      change_product: { entitySet: 'change_products', idColumn: 'change_productid' },
    },
    tables,
    permissions: [
      { id: 'roles', entity: 'role', scope: 'contact', field: 'userid', roles: ['Manager'], operations: ['read'] },
      {
        id: 'orgs',
        entity: 'account',
        scope: 'parent',
        parentPermissionId: 'roles',
        relationship: { entity: 'role', from: 'accountid', to: 'organisationid' },
        roles: ['Manager'],
        operations: ['read'],
      },
      {
        id: 'child-orgs',
        entity: 'account',
        scope: 'parent',
        parentPermissionId: 'orgs',
        relationship: { entity: 'account', from: 'parentaccountid', to: 'accountid' },
        roles: ['Manager'],
        operations: ['read'],
      },
      {
        id: 'products',
        entity: 'product',
        scope: 'parent',
        parentPermissionId: 'child-orgs',
        relationship: { entity: 'account', from: 'customerid', to: 'accountid' },
        roles: ['Manager'],
        operations: ['read'],
      },
      {
        id: 'changes',
        entity: 'change',
        scope: 'parent',
        parentPermissionId: 'products',
        relationship: {
          entity: 'product',
          from: 'changeid',
          to: 'productid',
          intersect: { entity: 'change_product', from: 'changeid', to: 'productid' },
        },
        roles: ['Manager'],
        operations: ['read'],
      },
    ],
    settings: { permissionMode: 'enforce' },
  };
}

// Fastest of three runs: one GC pause or scheduler stall on a loaded runner cannot fail the ratio.
const fastest = (fn) =>
  Math.min(
    ...[0, 1, 2].map(() => {
      const started = performance.now();
      fn();
      return performance.now() - started;
    }),
  );
const identity = { id: 'me', contactId: 'me', roles: ['Manager'] };

test(`parent-scope grants through an intersect table scale linearly from ${SMALL} to ${SIZE} rows`, async () => {
  const small = await new DataStore({ state: scaleState(SMALL) }).init();
  const store = await new DataStore({ state: scaleState(SIZE) }).init();
  // Roles for users "me" exist on organisations 0, 10 and 20; products belong
  // to the child organisations 30, 40 and 50, so 3 of every 30 products and
  // the changes linked to them are visible.
  const expected = store.state.tables.change_product.filter((edge) =>
    [0, 10, 20].includes(Number(edge.productid.slice(2)) % 30),
  ).length;
  assert.equal(store.rows('change', identity).length, expected);
  const fetched = store.fetchXml(
    '<fetch returntotalrecordcount="true"><entity name="change"><attribute name="name"/></entity></fetch>',
    identity,
  );
  assert.equal(fetched.total_record_count, Math.min(expected, 5000));
  assert.equal(store.query('change', { $select: 'name', $count: 'true' }, identity)['@odata.count'], expected);
  // 10x the rows: a key-lookup evaluation takes about 10x the time, a parents x intersect scan about 100x.
  const ratio = fastest(() => store.rows('change', identity)) / fastest(() => small.rows('change', identity));
  assert.ok(ratio < 40, `rows() grew ${ratio.toFixed(1)}x for 10x the rows`);
  // Single-record checks (writes, Liquid entities[...] lookups) build only per-call indexes.
  const singles = (target) => () => {
    for (const row of target.state.tables.change.slice(0, 20)) target.allowed('change', 'read', row, identity);
  };
  const singleRatio = fastest(singles(store)) / fastest(singles(small));
  assert.ok(singleRatio < 40, `20 single-row checks grew ${singleRatio.toFixed(1)}x for 10x the rows`);
});
