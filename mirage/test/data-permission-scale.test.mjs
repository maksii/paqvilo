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

// Count row reads directly so the complexity guard does not depend on scheduler or GC timing.
// Proxy the actual tables, catching indexed iteration, filter, some, and direct table access.
function rowReads(store, operation) {
  let count = 0;
  const tables = store.state.tables;
  const originals = Object.entries(tables);
  try {
    for (const [name, rows] of originals)
      tables[name] = new Proxy(rows, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) count++;
          return Reflect.get(target, key, receiver);
        },
      });
    operation();
    return count;
  } finally {
    for (const [name, rows] of originals) tables[name] = rows;
  }
}
const identity = { id: 'me', contactId: 'me', roles: ['Manager'] };

test(`parent-scope grants through an intersect table scale linearly from ${SMALL} to ${SIZE} rows`, async (t) => {
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
  // Ten times the rows must not produce the roughly 100x work of a parent-by-intersect scan.
  const smallReads = rowReads(small, () => small.rows('change', identity));
  const largeReads = rowReads(store, () => store.rows('change', identity));
  assert.ok(smallReads >= SMALL && largeReads >= SIZE, 'collection checks must read their rows');
  const ratio = largeReads / smallReads;
  assert.ok(ratio < 40, `rows() row reads grew ${ratio.toFixed(1)}x for 10x the rows`);
  // Single-record checks (writes, Liquid entities[...] lookups) build only per-call indexes.
  const singles = (target) => {
    const rows = target.state.tables.change.slice(0, 20);
    return () => {
      for (const row of rows) target.allowed('change', 'read', row, identity);
    };
  };
  const smallSingleReads = rowReads(small, singles(small));
  const largeSingleReads = rowReads(store, singles(store));
  assert.ok(smallSingleReads >= SMALL && largeSingleReads >= SIZE, 'single checks must build their indexes');
  const singleRatio = largeSingleReads / smallSingleReads;
  assert.ok(singleRatio < 40, `20 single-row checks row reads grew ${singleRatio.toFixed(1)}x for 10x the rows`);
  t.diagnostic(
    `collection row reads: ${smallReads} -> ${largeReads} (${ratio.toFixed(2)}x); single checks: ${smallSingleReads} -> ${largeSingleReads} (${singleRatio.toFixed(2)}x)`,
  );
});
