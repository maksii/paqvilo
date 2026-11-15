// @test-kind unproven: local three-valued model of any/all lambda truth over rows; no native capture cited
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { odataToSdkQuery } from '../lib/plugin-query.mjs';
import { queryExpressionToFetch } from '../lib/plugin-sdk-query.mjs';
const guid = (n) => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture() {
  const state = emptyState();
  state.mappings.parent = {
    entitySet: 'parents',
    idColumn: 'parentid',
    relationships: {
      children: { entity: 'child', from: 'parentid', to: 'parentid', many: true },
    },
  };
  state.mappings.parent.relationships.members = {
    entity: 'child',
    from: 'parentid',
    to: 'childid',
    many: true,
    intersect: { entity: 'membership', from: 'parentid', to: 'childid' },
  };
  state.mappings.child = {
    entitySet: 'children',
    idColumn: 'childid',
    fields: {
      age: { dataverseType: 'int' },
      active: { dataverseType: 'bit' },
      title: { dataverseType: 'nvarchar' },
    },
    relationships: {
      grandchildren: { entity: 'grandchild', from: 'childid', to: 'childid', many: true },
      manager: { entity: 'manager', from: 'managerid', to: 'managerid', many: false },
    },
  };
  state.mappings.manager = {
    entitySet: 'managers',
    idColumn: 'managerid',
    fields: { score: { dataverseType: 'int' } },
  };
  state.mappings.grandchild = {
    entitySet: 'grandchildren',
    idColumn: 'grandchildid',
    fields: { score: { dataverseType: 'int' } },
  };
  state.mappings.membership = { entitySet: 'memberships', idColumn: 'membershipid' };
  state.tables.parent = [];
  state.tables.child = [];
  state.tables.grandchild = [];
  state.tables.manager = [
    { managerid: guid(999999), score: null },
    { managerid: guid(999998), score: 20 },
  ];
  state.tables.membership = [];
  let serial = 1;
  const childStates = [];
  for (const age of [null, 10, 20])
    for (const active of [null, false, true])
      for (const title of [null, 'yes', 'no']) childStates.push({ age, active, title });
  const sets = [[], ...childStates.map((v) => [v]), ...childStates.flatMap((a) => childStates.map((b) => [a, b]))];
  for (const children of sets) {
    const parentid = guid(serial++);
    state.tables.parent.push({ parentid });
    for (const child of children) {
      const childid = guid(serial++);
      state.tables.child.push({
        ...child,
        childid,
        parentid,
        managerid: child.title === null ? null : child.title === 'no' ? guid(999999) : guid(999998),
      });
      state.tables.membership.push({ membershipid: guid(serial++), parentid, childid });
      if (child.title !== 'no')
        state.tables.grandchild.push({ grandchildid: guid(serial++), childid, score: child.age });
    }
  }
  return new DataStore({ state });
}
const bodies = [
  'true',
  'false',
  'null',
  'c/age gt 18',
  'c/age le 18',
  'c/age eq null',
  'c/age ne null',
  'c/active',
  'not c/active',
  'c/age gt 18 and c/active',
  'c/age gt 18 or c/active',
  'not (c/age gt 18 and c/active)',
  'not (c/age gt 18 or c/active)',
  "contains(c/title,'y')",
  "not contains(c/title,'y')",
  'c/grandchildren/any(g:g/score gt 18)',
  'c/grandchildren/all(g:g/score gt 18)',
  'not c/grandchildren/any(g:g/score gt 18)',
  'not c/grandchildren/all(g:g/score gt 18)',
  'c/manager/score gt 18',
  'c/manager/score eq null',
  'c/manager/score ne null',
  'c/manager/score gt 18 or c/active',
  'not (c/manager/score gt 18 and c/active)',
  "Microsoft.Dynamics.CRM.In(PropertyName='c/age',PropertyValues=['10','20'])",
  "not Microsoft.Dynamics.CRM.In(PropertyName='c/age',PropertyValues=['10','20'])",
];
const rowsOf = (answer, key = 'value') => answer[key].map((row) => row.parentid).sort();
const represented = (store, filter) => {
  const query = odataToSdkQuery('parent', { $filter: filter }, store);
  return rowsOf(
    store.fetchXml(
      queryExpressionToFetch(query, store),
      { admin: true },
      {
        sdkResult: true,
        skipPluginRead: true,
      },
    ),
    'entities',
  );
};

test('represented any/all queries preserve all three truth values in 208 scalar, compound, lookup and nested relationship vectors', () => {
  const store = fixture();
  let vectors = 0;
  for (const relationship of ['children', 'members'])
    for (const body of bodies)
      for (const kind of ['any', 'all'])
        for (const negated of [false, true]) {
          const filter = `${negated ? 'not ' : ''}${relationship}/${kind}(c:${body})`;
          const expected = rowsOf(store.query('parent', { $filter: filter }, { admin: true }));
          assert.deepEqual(represented(store, filter), expected, filter);
          vectors++;
        }
  assert.equal(vectors, 208);
  for (const filter of ['children/any()', 'not children/any()', 'members/any()', 'not members/any()'])
    assert.deepEqual(
      represented(store, filter),
      rowsOf(store.query('parent', { $filter: filter }, { admin: true })),
      filter,
    );
});

test('unknown child truth cannot make all or negated any true, while an empty collection remains vacuously true', () => {
  const store = fixture();
  // Empty parent, a nullable child, and an adult child with an unknown Boolean.
  const [empty, nullable] = store.tableRows('parent');
  const adult = store.tableRows('parent').find((row) => {
    const children = store.tableRows('child').filter((child) => child.parentid === row.parentid);
    return children.length === 1 && children[0].age === 20 && children[0].active === null;
  });
  for (const [filter, yes, no] of [
    ['children/all(c:c/age gt 18)', [empty, adult], [nullable]],
    ['not children/any(c:c/age gt 18)', [empty], [nullable, adult]],
    ['children/all(c:c/age gt 18 or c/active)', [empty, adult], [nullable]],
  ]) {
    const ids = represented(store, filter);
    for (const row of yes) assert.ok(ids.includes(row.parentid), filter);
    for (const row of no) assert.equal(ids.includes(row.parentid), false, filter);
  }
});

test('a no-op read observer preserves lambda query counts and a collection predicate rewrite still refuses explicitly', () => {
  const store = fixture();
  const params = { $filter: 'children/all(c:c/age gt 18 or c/active)', $count: 'true', $select: 'parentid' };
  const expected = store.query('parent', params, { admin: true });
  store.setPluginPipeline(
    () => {},
    ({ operation }) => operation === 'retrievemultiple',
  );
  assert.deepEqual(store.query('parent', params, { admin: true }), expected);
  store.setPluginPipeline(
    ({ stage, query }) => {
      if (stage === 20)
        query.criteria.conditions.push({ attributeName: 'parentid', operatorName: 'NotNull', values: [] });
    },
    ({ operation }) => operation === 'retrievemultiple',
  );
  assert.throws(() => store.query('parent', params, { admin: true }), {
    code: 'LocalPluginSdkUnsupported',
    status: 501,
    message: 'Collection criteria require the typed FetchXML execution adapter.',
  });
});
