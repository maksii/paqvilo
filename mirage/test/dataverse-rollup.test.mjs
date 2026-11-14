// Rollup columns (lib/dataverse-rollup.mjs): create stamps state 0, a child write marks its parents stale, recalculate computes the
// supported aggregates with and without the statecode filter, unsupported definitions report once and store state 2, a pack
// override wins, and a write to a rollup column is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION, parseRollupFormula, recalculate, validateRollups } from '../lib/dataverse-rollup.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const PARENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const CHILD_ACTIVE = '22222222-2222-4222-8222-222222222221';
const CHILD_ACTIVE_2 = '22222222-2222-4222-8222-222222222222';
const CHILD_INACTIVE = '22222222-2222-4222-8222-222222222223';
const CHILD_OTHER = '22222222-2222-4222-8222-222222222224';

const fetchXml = (aggregate, attribute, { active = false, link = 'x_parentid', filterType = 'and' } = {}) =>
  `<fetch aggregate="true">` +
  `<entity name="x_child"><attribute name="${attribute}" aggregate="${aggregate}" alias="${attribute}_alias"/>` +
  `<filter type="${filterType}"><condition attribute="${link}" operator="eq" value="{id}"/>` +
  `${active ? '<condition attribute="statecode" operator="eq" value="0"/>' : ''}</filter></entity></fetch>`;

const FORMULAS = {
  x_countall: fetchXml('count', 'x_childid'),
  x_sumall: fetchXml('sum', 'x_amount'),
  x_sumactive: fetchXml('sum', 'x_amount', { active: true }),
  // An or-filter is outside the subset: the rollup reports ROLLUP_UNSUPPORTED and stores null with state 2.
  x_unsupported: fetchXml('sum', 'x_amount', { filterType: 'or' }),
};
const rollup = (formulaDefinition) => ({
  dataverseType: 'decimal',
  columnMetadata: { sourceType: 2, formulaDefinition },
});
const stateAndDate = (column) => ({
  [`${column}_state`]: { dataverseType: 'int' },
  [`${column}_date`]: { dataverseType: 'datetime' },
});

const mappings = {
  x_parent: {
    logicalName: 'x_parent',
    entitySet: 'x_parents',
    idColumn: 'x_parentid',
    nameColumn: 'x_name',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_countall: rollup(FORMULAS.x_countall),
      ...stateAndDate('x_countall'),
      x_sumall: rollup(FORMULAS.x_sumall),
      ...stateAndDate('x_sumall'),
      x_sumactive: rollup(FORMULAS.x_sumactive),
      ...stateAndDate('x_sumactive'),
      x_unsupported: rollup(FORMULAS.x_unsupported),
      ...stateAndDate('x_unsupported'),
    },
  },
  x_child: {
    logicalName: 'x_child',
    entitySet: 'x_children',
    idColumn: 'x_childid',
    nameColumn: 'x_name',
    relationships: { x_parentid: { entity: 'x_parent', from: 'x_parentid', to: 'x_parentid', many: false } },
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_amount: { dataverseType: 'decimal' },
      x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] },
      statecode: { dataverseType: 'int' },
      statuscode: { dataverseType: 'int' },
    },
  },
  // A table with no rollup and no rollup source, for the hot-path guard.
  x_note: {
    logicalName: 'x_note',
    entitySet: 'x_notes',
    idColumn: 'x_noteid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  },
};

const lookup = (id, name) => ({ id, logical_name: 'x_parent', name });
const tables = {
  x_parent: [
    {
      x_parentid: PARENT,
      x_name: 'Invented parent',
      x_countall: 0,
      x_countall_state: 1,
      x_sumall_state: 1,
      x_sumactive_state: 1,
      x_unsupported_state: 1,
      statecode: 0,
      statuscode: 1,
    },
    {
      x_parentid: OTHER,
      x_name: 'Invented other parent',
      x_countall: 0,
      x_countall_state: 1,
      x_sumall_state: 1,
      x_sumactive_state: 1,
      x_unsupported_state: 1,
      statecode: 0,
      statuscode: 1,
    },
  ],
  x_child: [
    {
      x_childid: CHILD_ACTIVE,
      x_name: 'Active one',
      x_amount: 10,
      x_parentid: lookup(PARENT, 'Invented parent'),
      statecode: 0,
      statuscode: 1,
    },
    {
      x_childid: CHILD_ACTIVE_2,
      x_name: 'Active two',
      x_amount: 5,
      x_parentid: lookup(PARENT, 'Invented parent'),
      statecode: 0,
      statuscode: 1,
    },
    {
      x_childid: CHILD_INACTIVE,
      x_name: 'Inactive',
      x_amount: 100,
      x_parentid: lookup(PARENT, 'Invented parent'),
      statecode: 1,
      statuscode: 2,
    },
    {
      x_childid: CHILD_OTHER,
      x_name: 'Under other',
      x_amount: 7,
      x_parentid: lookup(OTHER, 'Invented other parent'),
      statecode: 0,
      statuscode: 1,
    },
  ],
};

// The fixture installs the module explicitly; the wrapper keeps the internal api that recalculate takes.
async function setup(t, options = {}) {
  const diagnostics = [];
  let internal = null;
  const extension = {
    ...EXTENSION,
    install: (api, installOptions) => {
      internal = api;
      return EXTENSION.install(api, installOptions);
    },
  };
  const fixture = await contractModuleFixture(t, {
    mappings,
    tables: structuredClone(tables),
    extension,
    options: { diagnostic: (entry) => diagnostics.push(entry), ...options },
  });
  return { ...fixture, diagnostics, api: internal };
}

const rowOf = (store, table, id) => store.state.tables[table].find((row) => row[`${table}id`] === id);

test('create stamps every rollup column NotCalculated with a null date', async (t) => {
  const { request, json, store } = await setup(t);
  await json(await request('POST', '/x_parents', { x_name: 'Fresh parent' }), 201);
  const row = store.state.tables.x_parent.find((item) => item.x_name === 'Fresh parent');
  assert.equal(row.x_countall_state, 0);
  assert.equal(row.x_countall_date, null);
  assert.equal(row.x_sumactive_state, 0);
  assert.equal(row.x_sumactive_date, null);
});

test('a write to a rollup column is refused and stores nothing', async (t) => {
  const { request, json, store } = await setup(t);
  await json(await request('POST', '/x_parents', { x_name: 'Refused', x_countall: 5 }), 400);
  assert.equal(
    store.state.tables.x_parent.some((row) => row.x_name === 'Refused'),
    false,
  );
  await json(await request('PATCH', `/x_parents(${PARENT})`, { x_sumall: 1 }), 400);
  assert.equal(rowOf(store, 'x_parent', PARENT).x_sumall, undefined);
});

test('a child create marks its parent stale in the same write', async (t) => {
  const { request, json, store } = await setup(t);
  await json(
    await request('POST', '/x_children', {
      x_name: 'New child',
      x_amount: 3,
      'x_parentid@odata.bind': `/x_parents(${PARENT})`,
      statecode: 0,
    }),
    201,
  );
  const parent = rowOf(store, 'x_parent', PARENT);
  assert.equal(parent.x_countall_state, 0);
  assert.equal(parent.x_sumall_state, 0);
  assert.equal(parent.x_sumactive_state, 0);
  assert.equal(rowOf(store, 'x_parent', OTHER).x_countall_state, 1);
});

test('a reparent or a delete marks both the old and the new parent stale', async (t) => {
  const { request, json, store } = await setup(t);
  await json(
    await request('PATCH', `/x_children(${CHILD_ACTIVE})`, { 'x_parentid@odata.bind': `/x_parents(${OTHER})` }),
    200,
  );
  assert.equal(rowOf(store, 'x_parent', PARENT).x_sumall_state, 0);
  assert.equal(rowOf(store, 'x_parent', OTHER).x_sumall_state, 0);
  // Reset the marks, then delete a child: its parent is stale again, the other parent is untouched.
  store.state.tables.x_parent.forEach((row) => {
    row.x_sumall_state = 1;
  });
  await json(await request('DELETE', `/x_children(${CHILD_ACTIVE_2})`), 204);
  assert.equal(rowOf(store, 'x_parent', PARENT).x_sumall_state, 0);
  assert.equal(rowOf(store, 'x_parent', OTHER).x_sumall_state, 1);
});

test('recalculate computes COUNT and SUM, with and without the statecode filter', async (t) => {
  const { api, store, diagnostics } = await setup(t);
  const count = await recalculate(api, 'x_parent', PARENT, 'x_countall');
  assert.equal(count.value, 3);
  assert.equal(count.state, 1);
  assert.equal(await recalculate(api, 'x_parent', PARENT, 'x_sumall').then((result) => result.value), 115);
  assert.equal(await recalculate(api, 'x_parent', PARENT, 'x_sumactive').then((result) => result.value), 15);
  const stored = rowOf(store, 'x_parent', PARENT);
  assert.equal(stored.x_sumactive, 15);
  assert.equal(stored.x_sumactive_state, 1);
  assert.ok(Number.isFinite(Date.parse(stored.x_sumactive_date)));
  assert.equal((await recalculate(api, 'x_parent', OTHER, 'x_countall')).value, 1);
  assert.deepEqual(diagnostics, []);
});

test('an unsupported definition reports ROLLUP_UNSUPPORTED once and stores null with state 2', async (t) => {
  const { api, store, diagnostics } = await setup(t);
  await recalculate(api, 'x_parent', PARENT, 'x_unsupported');
  const again = await recalculate(api, 'x_parent', PARENT, 'x_unsupported');
  assert.equal(again.state, 2);
  assert.equal(again.value, null);
  const reported = diagnostics.filter((entry) => entry.code === 'ROLLUP_UNSUPPORTED');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].table, 'x_parent');
  assert.equal(reported[0].column, 'x_unsupported');
  const stored = rowOf(store, 'x_parent', PARENT);
  assert.equal(stored.x_unsupported, null);
  assert.equal(stored.x_unsupported_state, 2);
  assert.match(parseRollupFormula(FORMULAS.x_unsupported).unsupported, /and-filter/);
});

test('a pack rollups override wins over the definition', async (t) => {
  const { api } = await setup(t, {
    rollups: { 'x_parent.x_countall': (row) => (row.x_name === 'Invented parent' ? 42 : null) },
  });
  const result = await recalculate(api, 'x_parent', PARENT, 'x_countall');
  assert.equal(result.value, 42);
  assert.equal(result.state, 1);
});

test('recalculate refuses a column that is not a rollup and an unknown row', async (t) => {
  const { api } = await setup(t);
  await assert.rejects(recalculate(api, 'x_child', CHILD_ACTIVE, 'x_name'), /no rollup definition/);
  await assert.rejects(recalculate(api, 'x_parent', '44444444-4444-4444-8444-444444444444', 'x_countall'), {
    status: 404,
  });
});

test('validateRollups refuses async functions and bad keys; describe lists the contract job', () => {
  assert.throws(() => validateRollups({ 'x_parent.x_countall': async () => 1 }), /synchronous/);
  assert.throws(() => validateRollups({ bad: () => 1 }), /<table>\.<column>/);
  assert.deepEqual(validateRollups(undefined), {});
  const record = EXTENSION.describe();
  assert.equal(record.level, 'behaviour');
  assert.deepEqual(record.contractOperations, ['MassRecalculation']);
  assert.deepEqual(record.requires, ['metadata:FormulaDefinition', 'scheduler']);
});

const calculate = (request, id, column) => {
  const target = encodeURIComponent(JSON.stringify({ '@odata.id': `x_parents(${id})` }));
  return request('GET', `/CalculateRollupField(Target=@t,FieldName=@f)?@t=${target}&@f='${column}'`);
};

test('CalculateRollupField answers through the module: a pack rollups function supplies the value', async (t) => {
  const { request, json, store } = await setup(t, { rollups: { 'x_parent.x_countall': () => 42 } });
  const body = await json(await calculate(request, PARENT, 'x_countall'), 200);
  assert.equal(body.x_countall, 42);
  assert.equal(body.x_countall_state, 1);
  assert.ok(Number.isFinite(Date.parse(body.x_countall_date)));
  assert.equal(rowOf(store, 'x_parent', PARENT).x_countall, 42);
});

test('CalculateRollupField on an unsupported definition answers state 2 and reports ROLLUP_UNSUPPORTED', async (t) => {
  const { request, json, diagnostics } = await setup(t);
  const body = await json(await calculate(request, PARENT, 'x_unsupported'), 200);
  assert.equal(body.x_unsupported, null);
  assert.equal(body.x_unsupported_state, 2);
  assert.equal(
    diagnostics.filter((entry) => entry.code === 'ROLLUP_UNSUPPORTED' && entry.column === 'x_unsupported').length,
    1,
  );
});

test("a child write keeps the parent's ETag and runs no Update step or committed event on the parent", async (t) => {
  const { request, json, store } = await setup(t);
  // A parent created through the API carries a versionnumber, so its ETag is that version (seed rows hash their content).
  const parent = await json(await request('POST', '/x_parents', { x_name: 'Created parent' }), 201);
  const PARENT = parent.x_parentid;
  const etag = parent['@odata.etag'];
  assert.match(etag, /^W\/"\d+"$/);
  rowOf(store, 'x_parent', PARENT).x_sumall_state = 1;
  const phases = [];
  const events = [];
  const phase = store.exportedPluginPhase;
  store.exportedPluginPhase = function (mapping, operation, ...rest) {
    phases.push(`${mapping.logicalName}.${operation}`);
    return phase.call(this, mapping, operation, ...rest);
  };
  const record = store.recordCommittedEvent;
  store.recordCommittedEvent = function (table, operation, ...rest) {
    events.push(`${table}.${operation}`);
    return record.call(this, table, operation, ...rest);
  };
  await json(
    await request('POST', '/x_children', {
      x_name: 'New child',
      x_amount: 3,
      'x_parentid@odata.bind': `/x_parents(${PARENT})`,
      statecode: 0,
    }),
    201,
  );
  assert.equal(
    rowOf(store, 'x_parent', PARENT).x_sumall_state,
    0,
    'the parent is still marked for the mass recalculation',
  );
  assert.ok(!phases.includes('x_parent.update'), phases.join(','));
  assert.ok(!events.includes('x_parent.update'), events.join(','));
  const response = await request(
    'PATCH',
    `/x_parents(${PARENT})`,
    { x_name: 'Renamed parent' },
    { 'if-match': etag, prefer: 'return=minimal' },
  );
  assert.equal(response.status, 204, await response.text());
});

test("concurrent writes on a table without rollups read each table's field definitions once per table revision", async (t) => {
  const { request, store } = await setup(t);
  const calls = new Map();
  const definitions = store.fieldDefinitions;
  store.fieldDefinitions = function (logical, ...rest) {
    if (new Error().stack.includes('dataverse-rollup.mjs')) {
      const key = `${store.tablesRevision([])} ${logical}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
    }
    return definitions.call(this, logical, ...rest);
  };
  for (let batch = 0; batch < 3; batch++) {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        request('POST', '/x_notes', { x_name: `Note ${batch}.${index}` }, { prefer: 'return=minimal' }).then(
          (response) => assert.equal(response.status, 204),
        ),
      ),
    );
  }
  assert.equal(store.state.tables.x_note.length, 60);
  assert.ok(calls.size > 0, 'the rollup hook ran on the writes');
  assert.ok(
    [...calls.values()].every((count) => count === 1),
    JSON.stringify(Object.fromEntries(calls)),
  );
  assert.ok(
    calls.size <= Object.keys(store.state.mappings).length,
    `rollup read ${calls.size} definitions for 60 writes`,
  );
});
