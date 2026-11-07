// Formula columns (lib/dataverse-formula.mjs): SourceType 3 columns read through the Power Fx evaluator, pack override wins,
// one diagnostic per column when the value is not available, writes refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION, validateFormulaColumns } from '../lib/dataverse-formula.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const ITEM = '66666666-6666-4666-8666-666666666666';
const FORMULAS = {
  x_total: 'x_amount * x_quantity',
  x_label: 'x_name & " / invented"',
};
const formula = (formulaDefinition, dataverseType = 'decimal') => ({
  dataverseType,
  columnMetadata: { sourceType: 3, formulaDefinition },
});

const mappings = {
  x_item: {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_amount: { dataverseType: 'decimal' },
      x_quantity: { dataverseType: 'int' },
      x_total: formula(FORMULAS.x_total),
      x_label: formula(FORMULAS.x_label, 'nvarchar'),
    },
  },
};
const tables = {
  x_item: [{ x_itemid: ITEM, x_name: 'Invented item', x_amount: 4, x_quantity: 2, statecode: 0, statuscode: 1 }],
};

// A synchronous stub engine: answers 8 for x_total and a text for x_label, records each call.
const stub = (calls = []) => ({
  evaluateSync: (expression, options) => {
    calls.push({ expression, options });
    return { value: expression === FORMULAS.x_total ? 8 : 'Invented item / invented' };
  },
  describe: () => ({
    name: 'stub-power-fx',
    level: 'behaviour',
    operations: [{ name: 'evaluateSync', level: 'behaviour' }],
  }),
});

// The fixture returns the server handle, so the installed API (which carries api.formulaColumns) is captured here.
async function setup(t, options = {}, providers = null) {
  const diagnostics = [];
  const captured = {};
  const extension = {
    ...EXTENSION,
    install: (api, opts) => {
      captured.api = api;
      return EXTENSION.install(api, opts);
    },
  };
  const fixture = await contractModuleFixture(t, {
    mappings,
    tables,
    extension,
    providers,
    options: { diagnostic: (entry) => diagnostics.push(entry), ...options },
  });
  return { ...fixture, diagnostics, installed: captured.api };
}

test('the default evaluator (the core Power Fx engine) computes formula columns', async (t) => {
  const { request, json, diagnostics, installed } = await setup(t);
  assert.equal(installed.formulaColumns.describe().level, 'behaviour', 'the core engine answers synchronously');
  const row = await json(await request('GET', `/x_items(${ITEM})`), 200);
  assert.equal(row.x_total, 8);
  assert.equal(row.x_label, 'Invented item / invented');
  assert.equal(diagnostics.length, 0);
});

test('formula capability descriptions skip column scans when the evaluator already establishes behaviour', async (t) => {
  const { installed, store } = await setup(t);
  const original = store.fieldDefinitions;
  let reads = 0;
  store.fieldDefinitions = function (...args) {
    reads++;
    return original.apply(this, args);
  };
  try {
    assert.equal(installed.formulaColumns.describe().level, 'behaviour');
  } finally {
    store.fieldDefinitions = original;
  }
  assert.equal(reads, 0);
});

test('formula columns read null with one FORMULA_NOT_EVALUATED per column under the disabled engine', async (t) => {
  const { request, json, diagnostics, installed } = await setup(t, {
    evaluator: createPowerFxEvaluator({ engine: false }),
  });
  assert.equal(installed.formulaColumns.describe().level, 'contract');
  await json(await request('GET', `/x_items(${ITEM})`), 200);
  const row = await json(await request('GET', `/x_items(${ITEM})`), 200);
  assert.equal(row.x_total, null);
  assert.equal(row.x_label, null);
  const reported = diagnostics.filter((entry) => entry.code === 'FORMULA_NOT_EVALUATED');
  assert.equal(reported.length, 2);
  assert.deepEqual(reported.map((entry) => entry.column).sort(), ['x_label', 'x_total']);
  assert.match(reported[0].message, /disabled/);
});

test('a synchronous evaluator supplies the value and receives the formula, symbols and the stored row', async (t) => {
  const calls = [];
  const { request, json, diagnostics, installed } = await setup(t, { evaluator: stub(calls) });
  assert.equal(installed.formulaColumns.describe().level, 'behaviour');
  const row = await json(await request('GET', `/x_items(${ITEM})`), 200);
  assert.equal(row.x_total, 8);
  assert.equal(row.x_label, 'Invented item / invented');
  assert.equal(diagnostics.length, 0);
  const total = calls.find((call) => call.expression === FORMULAS.x_total);
  assert.equal(total.options.principal, null, 'formula columns compute as the system user, not the caller');
  assert.equal(total.options.symbols.table, 'x_item');
  assert.equal(total.options.values.x_itemid, ITEM);
});

test("without an evaluator option, the host's api.providers.powerFx answers the formula column", async (t) => {
  const { request, json, diagnostics } = await setup(t, {}, { powerFx: stub() });
  const row = await json(await request('GET', `/x_items(${ITEM})`), 200);
  assert.equal(row.x_total, 8);
  assert.equal(row.x_label, 'Invented item / invented');
  assert.equal(diagnostics.length, 0);
});

test('an evaluator failure or a missing value reads null with one diagnostic naming the cause', async (t) => {
  const failing = {
    evaluateSync: (expression) => {
      if (expression === FORMULAS.x_total) throw new Error('invented failure');
      return {};
    },
    describe: () => ({ level: 'behaviour' }),
  };
  const { request, json, diagnostics } = await setup(t, { evaluator: failing });
  await json(await request('GET', `/x_items(${ITEM})`), 200);
  const row = await json(await request('GET', `/x_items(${ITEM})`), 200);
  assert.equal(row.x_total, null);
  assert.equal(row.x_label, null);
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics.find((entry) => entry.column === 'x_total').message, /invented failure/);
  assert.match(diagnostics.find((entry) => entry.column === 'x_label').message, /did not return \{ value \}/);
});

test('a pack formulaColumns function wins over the evaluator', async (t) => {
  const calls = [];
  const { request, json } = await setup(t, {
    evaluator: stub(calls),
    formulaColumns: { 'x_item.x_total': (row) => row.x_amount * 10 },
  });
  const row = await json(await request('GET', `/x_items(${ITEM})`), 200);
  assert.equal(row.x_total, 40);
  assert.equal(row.x_label, 'Invented item / invented');
  assert.equal(
    calls.some((call) => call.expression === FORMULAS.x_total),
    false,
  );
});

test('writes to a formula column are refused and store nothing', async (t) => {
  const { request, json, store } = await setup(t);
  const created = await json(await request('POST', '/x_items', { x_name: 'Refused', x_total: 1 }), 400);
  assert.equal(created.error.code, '0x80048d19');
  assert.equal(
    store.state.tables.x_item.some((row) => row.x_name === 'Refused'),
    false,
  );
  await json(await request('PATCH', `/x_items(${ITEM})`, { x_total: 99 }), 400);
  assert.equal(store.state.tables.x_item[0].x_total, undefined);
});

test('describe is contract without an evaluator that answers, behaviour when it answers synchronously or overrides cover every column', async (t) => {
  assert.equal(EXTENSION.describe().level, 'contract');
  assert.deepEqual(EXTENSION.describe().requires, ['provider:power-fx']);
  // The installed levels of the core, disabled and synchronous engines are asserted by the cases that install them above.
  const disabled = createPowerFxEvaluator({ engine: false });
  assert.equal(
    (
      await setup(t, { evaluator: disabled, formulaColumns: { 'x_item.x_total': () => 1 } })
    ).installed.formulaColumns.describe().level,
    'contract',
  );
  const covered = await setup(t, {
    evaluator: disabled,
    formulaColumns: { 'x_item.x_total': () => 1, 'x_item.x_label': () => 'a' },
  });
  assert.equal(covered.installed.formulaColumns.describe().level, 'behaviour');
});

test('an async evaluator never flips the level to behaviour', async (t) => {
  const engine = createPowerFxEvaluator({ adapter: { evaluate: async () => ({ value: 1 }) } });
  const { installed, request, json, diagnostics } = await setup(t, { evaluator: engine });
  assert.equal(installed.formulaColumns.describe().level, 'contract');
  await json(await request('GET', `/x_items(${ITEM})`), 200);
  const row = await json(await request('GET', `/x_items(${ITEM})`), 200);
  assert.equal(row.x_total, null);
  assert.equal(diagnostics.find((entry) => entry.column === 'x_total').code, 'FORMULA_NOT_EVALUATED');
});

test('a Power Fx adapter with a synchronous evaluate, registered through createPowerFxEvaluator, supplies the values', async (t) => {
  const engine = createPowerFxEvaluator({
    adapter: { evaluate: (expression) => ({ value: expression === FORMULAS.x_total ? 12 : 'text' }) },
  });
  const { request, json, diagnostics, installed } = await setup(t, { evaluator: engine });
  const row = await json(await request('GET', `/x_items(${ITEM})`), 200);
  assert.equal(row.x_total, 12);
  assert.equal(row.x_label, 'text');
  assert.equal(diagnostics.length, 0);
  assert.equal(installed.formulaColumns.describe().level, 'behaviour');
});

test("validateFormulaColumns accepts '<table>.<column>' synchronous functions only", () => {
  assert.throws(() => validateFormulaColumns({ 'bad key': () => 1 }), /<table>\.<column>/);
  assert.throws(() => validateFormulaColumns({ 'x_item.x_total': async () => 1 }), /synchronous/);
  assert.deepEqual(Object.keys(validateFormulaColumns({ 'X_Item.X_Total': () => 1 })), ['x_item.x_total']);
  assert.deepEqual(validateFormulaColumns(undefined), {});
});
