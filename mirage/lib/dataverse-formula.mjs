import { cloneStateData } from './state-clone.mjs';
import { validateDerivedColumns, derivedColumnsOf } from './derived-columns.mjs';
// Formula columns (Power Fx) in the Dataverse API: computed on read by a Power Fx evaluator, refused on write.
//
// A column is a formula column when its metadata says SourceType 3 (0 simple, 1 calculated, 2 rollup, 3 formula,
// 4 prompt). Formula columns are read-only and are computed as the system user, not as the caller. A formula over a secured
// column therefore shows its result to callers who cannot read that column, as natively (formula columns cannot be
// secured themselves). FORMULA_COLUMN_OVER_SECURED_COLUMN (warning) names each such formula column and its secured inputs
// when the extension installs or reseeds. Every read takes the column's value from the store's computed-column seam
// (store.setComputedColumns), so $filter, $orderby, $apply and FetchXML see it too:
//   1. a trusted pack's formulaColumns['<table>.<column>'](row, ctx) wins (synchronous, like calculatedColumns);
//   2. else the evaluator (install option, else the host's api.providers.powerFx: the core Power Fx engine of power-fx.mjs or
//      a pack powerFx adapter) answers through its evaluateSync(formula, ctx) and returns { value }; ctx.principal is null:
//      the platform computes the column, so the caller's identity is not passed. ctx.host.scope is the row typed by its
//      column metadata (ThisRecord and the bare column names; lookups navigate to the related row; other formula columns
//      are computed when read, at most 10 deep);
//   3. else the value is null and FORMULA_NOT_EVALUATED is reported once per column. A value is never guessed.
// A formula that answers a Power Fx error value reads null with FORMULA_ERROR (its ErrorKind) once per column. A decimal
// result keeps the column's precision (default 2). An async-only engine is refused by evaluateSync (PowerFxAsyncAdapter),
// so the column reads null with the diagnostic; the explicitly disabled engine answers 501 and reads null the same way.
// solution-schema resolves a referenced FormulaDefinitions YAML column mapping to its expression;
// metadata containing an inline FormulaDefinition supplies the expression directly.
// ponytail: a formula is evaluated once per row per query (the read copy keeps it) with no cross-query cache. Upgrade path:
// a per-row cache keyed by the row's values when formula-heavy tables get slow.
import { DataError } from './data-error.mjs';
import { createPowerFxEvaluator } from './canvas-power-fx.mjs';
import { dataverseHost } from './power-fx-dataverse.mjs';
import { isExactNumeric, roundNumeric } from './exact-numeric.mjs';
import { packCheck, registerPackExport } from './pack-exports.mjs';
import { onceReporter, packOverrides } from './dataverse-addon-common.mjs';
import { isSecuredField } from './dataverse-fls.mjs';
import { parse } from './power-fx.mjs';

const FORMULA = 3;
const OPERATIONS = ['FormulaColumn', 'FormulaWriteRefused'];

const facts = (definition) => ({ ...definition, ...(definition?.columnMetadata ?? {}) });
const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function';

// Per-API state: one WeakMap entry per installed API. Never module-global mutable state.
const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api)) states.set(api, { api, overrides: {}, evaluator: null, reporter: onceReporter(), depth: 0 });
  return states.get(api);
}

// Diagnostics: once per code, table and column, then never again until reset.
const report = (state, entry) => state.reporter.report(entry, `${entry.code}\u0000${entry.table}\u0000${entry.column}`);

/** Validates the pack formulaColumns export: '<table>.<column>' keys mapping to synchronous (row, ctx) => value. Returns the map. */
export function validateFormulaColumns(map) {
  return validateDerivedColumns(map, 'formulaColumns');
}

/** The formula columns of a table as { name: formulaText }. */
function formulaColumnsOf(api, logical) {
  return derivedColumnsOf(api, logical, FORMULA);
}

function allFormulaColumns(api) {
  return Object.keys(api.store.state.mappings ?? {}).flatMap((table) =>
    Object.keys(formulaColumnsOf(api, table)).map((column) => [table, column]),
  );
}

// Native error for writing a formula column not known; the calculated-column invalid-property shape (0x80048d19) is a guess.
const writeRefused = (mapping, column) =>
  new DataError(
    `The attribute '${column}' of entity '${mapping.logicalName}' is a formula field and cannot be set.`,
    400,
    'InvalidRequest',
    { innerCode: '0x80048d19' },
  );

function unevaluated(state, table, column, reason) {
  report(state, {
    code: 'FORMULA_NOT_EVALUATED',
    table,
    column,
    message: `${reason} The column reads as null; supply a pack formulaColumns['${table}.${column}'] function.`,
  });
  return null;
}

// The implicit ThisRecord of a formula: the row typed by its column metadata (power-fx-dataverse.mjs), each other formula
// column of the table computed when the formula reads it, the column itself blank (a formula column cannot reference
// itself).
function scopeOf(state, host, mapping, row, column) {
  const record = host.record(mapping.logicalName, row);
  const formulas = formulaColumnsOf(state.api, mapping.logicalName);
  for (const [other, text] of Object.entries(formulas)) {
    if (other === column) {
      record[other] = null;
      continue;
    }
    Object.defineProperty(record, other, {
      enumerable: true,
      configurable: true,
      get: () =>
        host.record(mapping.logicalName, { [other]: computeColumn(state, {}, mapping, row, other, text) })[other] ??
        null,
    });
  }
  return record;
}

// A decimal formula column keeps its precision (0 to 10 places, default 2).
// The rounding is exact (exact-numeric.mjs roundNumeric, half away from zero), so a 28-digit decimal keeps its digits.
function columnValue(state, mapping, column, value) {
  if (typeof value !== 'number' && !isExactNumeric(value)) return value ?? null;
  const definition = facts(state.api.store.fieldDefinitions(mapping.logicalName, state.api.metadataFields)?.[column]);
  if (String(definition.dataverseType ?? definition.type ?? '').toLowerCase() !== 'decimal') return value;
  const places = Number(definition.precision ?? definition.Precision ?? 2);
  return roundNumeric(value, Math.min(10, Math.max(0, places)), 'Decimal');
}

function evaluateFormula(state, c, mapping, row, column, formula) {
  const table = mapping.logicalName;
  const engine = state.evaluator;
  if (typeof engine.evaluateSync !== 'function')
    return unevaluated(
      state,
      table,
      column,
      'The Power Fx evaluator has no evaluateSync, and a formula column is read synchronously.',
    );
  // Assumption: the expression is the stored FormulaDefinition text; a leading "=" (the YAML formula form) is dropped.
  const expression = String(formula ?? '')
    .trim()
    .replace(/^=/, '');
  if (!expression) return unevaluated(state, table, column, 'The column has no formula text.');
  // Formula columns may chain through other formula columns at most 10 deep.
  if (state.depth >= 10)
    return unevaluated(state, table, column, 'The column is computed through more than 10 chained formula columns.');
  state.depth++;
  try {
    // The platform computes the column (principal null, no caller): related rows read through lookups, no table sources.
    const host = dataverseHost(state.api, { c: null });
    const result = engine.evaluateSync(expression, {
      symbols: { table, columns: Object.keys(mapping.fields ?? {}) },
      values: cloneStateData(row),
      principal: null, // computed as the system user, not as the caller
      host: { ...host, scope: scopeOf(state, host, mapping, row, column) },
    });
    if (isThenable(result)) {
      Promise.resolve(result).catch(() => {}); // the rejection is answered by this diagnostic, not an unhandled rejection
      return unevaluated(
        state,
        table,
        column,
        'The Power Fx evaluator answered asynchronously, and a formula column is read synchronously.',
      );
    }
    if (result === null || typeof result !== 'object' || !Object.hasOwn(result, 'value'))
      return unevaluated(state, table, column, 'The Power Fx evaluator did not return { value }.');
    return columnValue(state, mapping, column, result.value);
  } catch (error) {
    // A Power Fx error value (ErrorKind) reads blank with its own diagnostic; any other failure is not evaluated.
    if (error.code === 'PowerFxError') {
      report(state, {
        code: 'FORMULA_ERROR',
        table,
        column,
        kind: error.details?.kind ?? null,
        message: `The formula answered an error (${error.details?.kind ?? 'Unknown'}): ${error.message} The column reads as null.`,
      });
      return null;
    }
    return unevaluated(state, table, column, `The Power Fx evaluator failed: ${error.message}.`);
  } finally {
    state.depth--;
  }
}

function computeColumn(state, c, mapping, row, column, formula) {
  const table = mapping.logicalName;
  const override = state.overrides[`${table}.${column}`];
  if (override) {
    const value = override(cloneStateData(row), { table, column, user: c.user ?? null });
    if (!isThenable(value)) return value ?? null;
    return unevaluated(
      state,
      table,
      column,
      'The pack formulaColumns function returned a promise; formula columns are computed synchronously.',
    );
  }
  return evaluateFormula(state, c, mapping, row, column, formula);
}

/**
 * install(api, options): options.formulaColumns (else the pack export, validateFormulaColumns), options.evaluator (else
 * api.providers.powerFx, else createPowerFxEvaluator()), options.diagnostic (else api.diagnostic) receives each diagnostic once. Exposes
 * api.formulaColumns = { columnsOf(table), diagnostics(), describe() }.
 */
function install(api, options = {}) {
  const state = stateOf(api);
  state.overrides = validateFormulaColumns(options.formulaColumns ?? packOverrides(api, 'formulaColumns'));
  // api.providers is frozen on the api before extensions install, so the host's pack evaluator is resolved once, here.
  state.evaluator = options.evaluator ?? api.providers?.powerFx ?? createPowerFxEvaluator();
  state.reporter = onceReporter(options.diagnostic ?? api.diagnostic ?? null);
  api.formulaColumns = {
    columnsOf: (table) => formulaColumnsOf(api, table),
    diagnostics: () => [...state.reporter.diagnostics],
    describe: () => describe(api),
  };
  // One computed-value source for every read (store.setComputedColumns): $filter, $orderby, $apply, FetchXML, the property
  // route and every row projection read the computed value. The platform computes the column, so the pack ctx.user is null.
  state.provider = {
    columnsOf: (logical) => Object.keys(formulaColumnsOf(api, logical)),
    compute: (logical, column, { row }) =>
      computeColumn(state, {}, api.store.resolveMapping(logical), row, column, formulaColumnsOf(api, logical)[column]),
  };
  api.store.setComputedColumns('dataverse-formula', state.provider);
  (api.readMetadata ?? ((fn) => fn()))(() => reportSecuredInputs(api, state));
  api.recordHooks.add('beforeWrite', (c, mapping, { operation, data }) => {
    if (operation === 'delete' || !data) return;
    const formulas = formulaColumnsOf(api, mapping.logicalName);
    const column = Object.keys(data).find((key) => Object.hasOwn(formulas, key.toLowerCase()));
    if (column) throw writeRefused(mapping, column);
  });
}

// The secured columns a formula reads: bare or ThisRecord columns of its table and columns reached through one lookup.
function securedInputs(api, table, formula) {
  let ast;
  try {
    ast = parse(
      String(formula ?? '')
        .trim()
        .replace(/^=/, ''),
    );
  } catch {
    return [];
  }
  const fieldsOf = (logical) => api.store.fieldDefinitions(logical, api.metadataFields) ?? {};
  const own = fieldsOf(table),
    found = new Set();
  const secured = (logical, column, fields) => {
    if (fields[column] && isSecuredField(fields[column])) found.add(`${logical}.${column}`);
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.t === 'id' && !node.global) secured(table, node.name, own);
    if (node.t === 'dot' && node.obj.t === 'id') {
      if (node.obj.name === 'ThisRecord') secured(table, node.name, own);
      const target = own[node.obj.name]?.targets?.[0];
      if (target) secured(target, node.name, fieldsOf(target));
    }
    Object.values(node).forEach((value) => walk(value?.node ?? value));
  };
  walk(ast);
  return [...found].sort();
}
function reportSecuredInputs(api, state) {
  for (const [table, column] of allFormulaColumns(api)) {
    const columns = securedInputs(api, table, formulaColumnsOf(api, table)[column]);
    if (columns.length)
      report(state, {
        code: 'FORMULA_COLUMN_OVER_SECURED_COLUMN',
        severity: 'warning',
        table,
        column,
        columns,
        message: `Formula column ${table}.${column} reads the secured column(s) ${columns.join(', ')}; the platform computes it, so callers without read access to those columns see the result. Secure the inputs' consumers accordingly (Learn column-level security best practices).`,
      });
  }
}

// Reseed: the once-per-column diagnostics start again (the metadata may have changed).
function reset(api) {
  const state = stateOf(api);
  state.reporter.clear();
  if (state.provider) api.store.setComputedColumns('dataverse-formula', state.provider);
  reportSecuredInputs(api, state);
}

/**
 * Capability record. Without an installed API it is the contract level. With one, it is behaviour when the evaluator lists
 * evaluateSync at behaviour, or when a pack formulaColumns function covers every formula column of the store.
 */
function describe(api = null) {
  const state = api ? states.get(api) : null;
  const engine = state?.evaluator ?? null;
  const engineAnswers =
    engine
      ?.describe?.()
      .operations?.some((operation) => operation.name === 'evaluateSync' && operation.level === 'behaviour') === true;
  const overrides = state?.overrides ?? {};
  // An answering evaluator already establishes the level. With no evaluator
  // and no overrides, no column scan can promote it to behaviour either.
  const columns = api && !engineAnswers && Object.keys(overrides).length ? allFormulaColumns(api) : [];
  const overridesCover = columns.length > 0 && columns.every(([table, column]) => `${table}.${column}` in overrides);
  return {
    name: 'dataverse-formula',
    version: 1,
    kind: 'dataverse-extension',
    level: engineAnswers || overridesCover ? 'behaviour' : 'contract',
    operations: OPERATIONS,
    requires: ['provider:power-fx'],
    principal: 'platform',
    stateOwner: 'none',
    lifecycle: 'per-request',
  };
}

export const EXTENSION = { name: 'dataverse-formula', install, reset, describe };

registerPackExport('formulaColumns', { key: (key) => key.toLowerCase(), check: packCheck(validateFormulaColumns) });
