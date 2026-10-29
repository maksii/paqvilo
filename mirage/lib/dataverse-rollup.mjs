import { cloneStateData } from './state-clone.mjs';
import { validateDerivedColumns } from './derived-columns.mjs';
// Rollup columns (SourceType 2) in the Dataverse API: the state and date columns are maintained, the value is recalculated on demand.
//
// A column is a rollup when its metadata says SourceType 2 (exported column facts sit under columnMetadata). Its FormulaDefinition
// is the aggregate FetchXML the platform stores: one <entity> (the child table), one aggregate <attribute>, and a <filter> whose
// condition with value="{id}" names the child column holding the parent's id (the 1:N relationship). Behaviour:
//   1. create: a new parent row is stamped <column>_state = 0 (NotCalculated) and <column>_date = null when the payload omits
//      them. An explicit write to <column> itself is refused with 400 (create, update and upsert).
//   2. child write (create, update, upsert, delete): every parent linked through a rollup column gets <column>_state = 0 (stale),
//      in the write's own transaction, so the mass recalculation picks it up. A reparent or delete marks the parent the row
//      pointed at before the write too. The flag is a journaled row mutation (store.mutateRow): the parent's versionnumber,
//      modifiedon and ETag stay, and no Update step, flow, audit or committed event runs for the parent.
//      The native platform keeps no per-row stale flag (its system job recalculates rollups incrementally); the _state = 0
//      marking only tells Mirage's own mass recalculation which rows to visit.
//   3. recalculate(api, table, id, column): the value is computed over the local child rows and stored with <column>_state = 1
//      (Calculated) and <column>_date = now. A trusted pack's rollups['<table>.<column>'](row, ctx) wins and supplies the value.
//      A definition outside the subset reports ROLLUP_UNSUPPORTED once per column and stores null with <column>_state = 2.
//
// Supported FormulaDefinition subset (element local names, case-insensitive, prefixes ignored):
//   <fetch aggregate="true"><entity name="child">
//     <attribute name="column" aggregate="count|sum|min|max|avg" alias="..."/>
//     <filter type="and">
//       <condition attribute="parentcolumn" operator="eq" value="{id}"/>
//       <condition attribute="statecode" operator="eq" value="0"/>   (optional)
//     </filter>
//   </entity></fetch>
// count counts the non-null values of the attribute; sum, min, max and avg read numbers and ignore nulls. A row without a
// statecode value counts as active. Anything else (link-entity, or-filters, other conditions, several attributes) is outside
// the subset.
// Assumed native behavior: the FormulaDefinition is FetchXML, as the CalculateRollupField handler reads it; aggregation
// follows SQL (SUM over no rows is 0, MIN, MAX and AVG over none are null, COUNT counts non-null values).
// State 2 (OverflowError) for a definition outside the subset is this module's choice: the nearest documented error state, as
// OtherError (3) describes an internal failure.
// Guesses: the refusal of a write to a rollup column reuses the calculated module's invalid-property shape (0x80048d19), and the
// 400 and 404 of recalculate reuse the CalculateRollupField handler's shapes.
// The rollup columns per table and the child -> parent sources are memoised per store.tablesRevision([]) (it changes on a
//   metadata commit, a promoted or non-incremental commit and a state replacement, not on an incremental row write) and on reset.
// ponytail: aggregation runs over all child rows of the table (no index); fine for simulated data sets.
// ponytail: arithmetic uses JS doubles, so money results can differ in the last digits; route through exact-numeric.mjs when a
//   project needs exact decimals.
// Mass recalculation: when the runtime has a scheduler (api.scheduler), install schedules a recurring "Mass Calculate Rollup
//   Fields" task every MASS_INTERVAL_MS (the scheduler clamps long timers) that recalculates every stale (_state = 0) rollup
//   column of every row; describe(api) then reports MassRecalculation at behaviour, otherwise at contract.
//   The native job's cadence (hourly and incremental per column, configurable on the platform) is not modelled.
import { DataError } from './data-error.mjs';
import { parseSolutionXml } from './solution-xml.mjs';
import { packCheck, registerPackExport } from './pack-exports.mjs';
import { onceReporter, packOverrides } from './dataverse-addon-common.mjs';

const ROLLUP = 2;
const STATE = { notCalculated: 0, calculated: 1, overflowError: 2 };
const AGGREGATES = new Set(['count', 'sum', 'min', 'max', 'avg']);
const INVALID = '0x80040203';
const BEHAVIOUR_OPERATIONS = ['CreateState', 'StaleMark', 'Recalculate'];
const CONTRACT_OPERATIONS = ['MassRecalculation'];
const MASS_INTERVAL_MS = 3600 * 1000;
const MASS_JOB = 'Mass Calculate Rollup Fields';

const localName = (name) => String(name).split(':').pop().toLowerCase();
const elements = (node) => (node?.children ?? []).filter((item) => !item.name.startsWith('#'));
const attr = (node, name) =>
  Object.entries(node.attrs ?? {}).find(([key]) => localName(key) === name.toLowerCase())?.[1];
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value);
const bare = (value) =>
  String(refId(value) ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const sameId = (a, b) => bare(a) !== '' && bare(a) === bare(b);
const enumValue = (value) => (value !== null && typeof value === 'object' ? value.Value : value);
const facts = (definition) => ({ ...definition, ...(definition?.columnMetadata ?? {}) });
const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function';
const hasKey = (data, name) => Object.keys(data).some((key) => key.toLowerCase() === name);

class Unsupported extends Error {}
const unsupported = (message) => {
  throw new Unsupported(message);
};

const invalid = (message) => new DataError(message, 400, 'InvalidRequest', { innerCode: INVALID });
const notFound = (logical, id) =>
  new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, 'NotFound', { id, innerCode: '0x80040217' });
const writeRefused = (mapping, column) =>
  new DataError(
    `The attribute '${column}' of entity '${mapping.logicalName}' is a rollup field and cannot be set.`,
    400,
    'InvalidRequest',
    { innerCode: '0x80048d19' },
  );

// ---- Parser: FormulaDefinition text -> rule

// Reads the parts of the rule in order: child and link first, so a rule outside the aggregate subset still names its 1:N source.
function readFetch(root, rule) {
  if (localName(root.name) !== 'fetch') unsupported('The FormulaDefinition is not a <fetch> query.');
  if (String(attr(root, 'aggregate') ?? '').toLowerCase() !== 'true')
    unsupported('The <fetch> is not an aggregate query (aggregate="true").');
  const entities = elements(root);
  if (entities.length !== 1 || localName(entities[0].name) !== 'entity')
    unsupported('The <fetch> must hold exactly one <entity>.');
  const entity = entities[0];
  rule.child =
    String(attr(entity, 'name') ?? '')
      .trim()
      .toLowerCase() || null;
  if (!rule.child) unsupported('The <entity> names no table.');
  const parts = elements(entity);
  const filters = parts.filter((item) => localName(item.name) === 'filter');
  const attributes = parts.filter((item) => localName(item.name) === 'attribute');
  if (filters.length + attributes.length !== parts.length)
    unsupported('The <entity> holds an element outside the subset (link-entity, order, ...).');
  const [filter] = filters;
  if (!filter) unsupported('The query has no <filter> with an {id} condition.');
  const idCondition = elements(filter).find(
    (item) =>
      localName(item.name) === 'condition' &&
      String(attr(item, 'value') ?? '')
        .trim()
        .toLowerCase() === '{id}',
  );
  rule.link =
    String(attr(idCondition ?? {}, 'attribute') ?? '')
      .trim()
      .toLowerCase() || null;
  if (!rule.link) unsupported('The filter needs a condition with value {id} naming the parent column.');
  if (filters.length > 1) unsupported('The query has more than one <filter>.');
  if (String(attr(filter, 'type') ?? 'and').toLowerCase() !== 'and') unsupported('Only an and-filter is supported.');
  const conditions = elements(filter);
  if (conditions.some((item) => localName(item.name) !== 'condition')) unsupported('A nested filter is not supported.');
  if (String(attr(idCondition, 'operator') ?? '').toLowerCase() !== 'eq')
    unsupported('The {id} condition must use operator eq.');
  rule.active = false;
  for (const condition of conditions) {
    if (condition === idCondition) continue;
    const field = String(attr(condition, 'attribute') ?? '')
      .trim()
      .toLowerCase();
    const operator = String(attr(condition, 'operator') ?? '').toLowerCase();
    if (
      field === 'statecode' &&
      operator === 'eq' &&
      String(attr(condition, 'value') ?? '').trim() === '0' &&
      !rule.active
    )
      rule.active = true;
    else unsupported(`The condition on '${field}' is outside the subset.`);
  }
  if (attributes.length !== 1) unsupported('The aggregate names exactly one <attribute>.');
  const aggregate = String(attr(attributes[0], 'aggregate') ?? '').toLowerCase();
  if (!AGGREGATES.has(aggregate)) unsupported(`Aggregate '${aggregate || 'none'}' is not supported.`);
  rule.aggregate = aggregate;
  rule.attribute = String(attr(attributes[0], 'name') ?? '')
    .trim()
    .toLowerCase();
  if (!rule.attribute) unsupported('The aggregate attribute has no name.');
}

/**
 * Parses a rollup FormulaDefinition into { child, link, active, aggregate, attribute, unsupported }. child and link (the 1:N
 * source) are kept even when the rest is outside the subset: unsupported is then the reason, null when the rule is supported.
 */
export function parseRollupFormula(text) {
  const rule = { child: null, link: null, unsupported: null };
  if (!text || !String(text).trim()) return { ...rule, unsupported: 'The column has no FormulaDefinition.' };
  try {
    readFetch(parseSolutionXml(text), rule);
  } catch (error) {
    rule.unsupported =
      error instanceof Unsupported ? error.message : `The FormulaDefinition is not readable XML: ${error.message}`;
  }
  return rule;
}

// ---- Aggregation

const asNumber = (value) => {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(number)) unsupported(`'${value}' is not a number.`);
  return number;
};

// Aggregates the child rows whose parent column holds parentId (active rows only when the rule says so).
function aggregateOf(rule, rows, parentId) {
  const linked = rows.filter(
    (row) => sameId(row[rule.link], parentId) && (!rule.active || Number(row.statecode ?? 0) === 0),
  );
  const values = linked
    .map((row) => row[rule.attribute])
    .filter((value) => value !== null && value !== undefined && value !== '');
  if (rule.aggregate === 'count') return values.length;
  const numbers = values.map(asNumber);
  if (rule.aggregate === 'sum') return numbers.reduce((total, value) => total + value, 0);
  if (!numbers.length) return null;
  if (rule.aggregate === 'min') return numbers.reduce((low, value) => Math.min(low, value));
  if (rule.aggregate === 'max') return numbers.reduce((high, value) => Math.max(high, value));
  return numbers.reduce((total, value) => total + value, 0) / numbers.length;
}

// ---- Rules of a table

const states = new WeakMap();
// Pre-images of writes in flight, per request context: the parents the row pointed at before the write (for reparent and delete).
const pending = new WeakMap();

function stateOf(api) {
  if (!states.has(api)) states.set(api, { overrides: {}, reporter: onceReporter(), parsed: new Map(), memo: null });
  return states.get(api);
}

const report = (state, entry) => state.reporter.report(entry, `${entry.code}\u0000${entry.table}\u0000${entry.column}`);

// The memo of rollup columns and sources, dropped when the store's table revision moves (see the header).
function memoOf(api) {
  const state = stateOf(api);
  const key = api.store.tablesRevision([]);
  if (state.memo?.key !== key) state.memo = { key, columns: new Map(), sources: null };
  return state.memo;
}

// The rollup columns of a table as { name: formulaDefinition }.
function rollupColumnsOf(api, logical) {
  const memo = memoOf(api);
  if (memo.columns.has(logical)) return memo.columns.get(logical);
  const definitions = api.store.fieldDefinitions(logical, api.metadataFields) ?? {};
  const result = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const column = facts(definition);
    if (Number(enumValue(column.sourceType ?? column.SourceType)) === ROLLUP)
      result[name.toLowerCase()] = column.formulaDefinition ?? column.FormulaDefinition ?? '';
  }
  memo.columns.set(logical, result);
  return result;
}

function parsedOf(state, formula) {
  if (!state.parsed.has(formula)) state.parsed.set(formula, parseRollupFormula(formula));
  return state.parsed.get(formula);
}

// The rollup columns (of any table) whose 1:N source is the given child table: [{ table, column, link }].
function rollupsSourcedFrom(api, state, child) {
  const memo = memoOf(api);
  if (!memo.sources) {
    memo.sources = new Map();
    for (const logical of Object.keys(api.store.state.mappings)) {
      for (const [column, formula] of Object.entries(rollupColumnsOf(api, logical))) {
        const rule = parsedOf(state, formula);
        if (!rule.child || !rule.link) continue;
        if (!memo.sources.has(rule.child)) memo.sources.set(rule.child, []);
        memo.sources.get(rule.child).push({ table: logical, column, link: rule.link });
      }
    }
  }
  return memo.sources.get(child) ?? [];
}

/** The mass recalculation: every rollup column whose state is NotCalculated (0), row by row. Returns the count recalculated. */
async function recalculateStale(api) {
  let count = 0;
  for (const logical of Object.keys(api.store.state.mappings)) {
    const columns = Object.keys(rollupColumnsOf(api, logical));
    if (!columns.length) continue;
    const mapping = api.store.resolveMapping(logical);
    for (const row of [...api.store.tableRows(logical)])
      for (const column of columns) {
        if (row[`${column}_state`] !== STATE.notCalculated) continue;
        await recalculate(api, logical, row[mapping.idColumn], column);
        count += 1;
      }
  }
  return count;
}

// The recurring task re-arms itself after each run; a failed run is reported and the next one still comes.
function scheduleMass(api, state) {
  if (!api.scheduler?.schedule) return;
  const run = async () => {
    state.massHandle = null;
    try {
      await recalculateStale(api);
    } catch (error) {
      state.reporter.report(
        { code: 'ROLLUP_MASS_RECALCULATION_FAILED', message: error.message },
        `ROLLUP_MASS_RECALCULATION_FAILED\u0000${error.message}`,
      );
    }
    if (!state.closed) state.massHandle = api.scheduler.schedule(run, MASS_INTERVAL_MS, { name: MASS_JOB });
  };
  state.massHandle = api.scheduler.schedule(run, MASS_INTERVAL_MS, { name: MASS_JOB });
  state.massScheduled = state.massHandle !== null;
}

// The parent references a child row holds through the given rollup links: [{ table, column, id }].
const parentsOf = (sources, row) =>
  sources
    .map((source) => ({ table: source.table, column: source.column, id: bare(row?.[source.link]) }))
    .filter((parent) => parent.id !== '');

// The platform writes rollup values as an administrator, as the cascade module does; the caller only authorizes its own write.
const PLATFORM = { admin: true };

// Stale marking of one parent row, in the current transaction, as a journaled row mutation (see the header). A parent already
// NotCalculated is left as it is.
function markStale(api, parent) {
  const mapping = api.store.resolveMapping(parent.table);
  const rows = api.store.state.tables[mapping.logicalName];
  if (!rows) return;
  const index = api.store.rowIndex(mapping, rows, parent.id);
  const stateColumn = `${parent.column}_state`;
  if (index < 0 || rows[index][stateColumn] === STATE.notCalculated) return;
  api.store.mutateRow(mapping.logicalName, rows, index, { [stateColumn]: STATE.notCalculated });
}

/**
 * recalculate(api, table, id, column): computes one rollup column of one row and stores the value with its date and state.
 * Returns { table, id, column, value, state, date }. Rejects with 400 when the column is not a rollup and 404 for an unknown row.
 */
export async function recalculate(api, table, id, column) {
  const state = stateOf(api);
  const mapping = api.store.resolveMapping(table);
  const logical = mapping.logicalName;
  const name = String(column).toLowerCase();
  const formula = rollupColumnsOf(api, logical)[name];
  if (formula === undefined) throw invalid(`The ${name} column has no rollup definition.`);
  const row = api.store.tableRows(logical).find((item) => sameId(item[mapping.idColumn], id));
  if (!row) throw notFound(logical, id);
  // The write runs on the asynchronous pipeline (updateRecordAsync): a synchronous service endpoint step on the row posts in
  // process, never on the synchronous I/O bridge.
  return api.change(() =>
    api.store.transact(
      async () => {
        const now = new Date(api.clock ? api.clock() : Date.now()).toISOString();
        let value = null;
        let stateValue = STATE.overflowError;
        const override = state.overrides[`${logical}.${name}`];
        if (override) {
          // A pack function is arbitrary code: the write's row journal becomes a full backup first, as a plug-in step does.
          api.store.promoteRowTransaction();
          const answer = override(cloneStateData(row), { table: logical, column: name });
          if (isThenable(answer))
            report(state, {
              code: 'ROLLUP_UNSUPPORTED',
              table: logical,
              column: name,
              message: 'The pack rollups function returned a promise; rollups are computed synchronously.',
            });
          else {
            value = answer ?? null;
            stateValue = STATE.calculated;
          }
        } else {
          const rule = parsedOf(state, formula);
          try {
            if (rule.unsupported) unsupported(rule.unsupported);
            value = aggregateOf(rule, api.store.tableRows(rule.child), row[mapping.idColumn]);
            stateValue = STATE.calculated;
          } catch (error) {
            if (!(error instanceof Unsupported)) throw error;
            report(state, {
              code: 'ROLLUP_UNSUPPORTED',
              table: logical,
              column: name,
              message: `${error.message} The column reads as null with state 2; supply a pack rollups['${logical}.${name}'] function.`,
            });
          }
        }
        await api.store.updateRecordAsync(
          logical,
          row[mapping.idColumn],
          { [name]: value, [`${name}_state`]: stateValue, [`${name}_date`]: now },
          PLATFORM,
          {
            systemColumns: { modifiedon: row.modifiedon },
          },
        );
        return { table: logical, id: row[mapping.idColumn], column: name, value, state: stateValue, date: now };
      },
      { incremental: true },
    ),
  );
}

/**
 * install(api, { rollups, diagnostic }): rollups is the pack export (validateRollups), diagnostic receives each diagnostic once.
 * Exposes api.rollups = { diagnostics(), recalculate(table, id, column), recalculateStale() }; the CalculateRollupField message
 * (dataverse-record-messages.mjs) calls recalculate through it.
 */
function install(api, options = {}) {
  const state = stateOf(api);
  state.overrides = validateRollups(options.rollups ?? packOverrides(api, 'rollups'));
  state.reporter = onceReporter(options.diagnostic ?? api.diagnostic ?? null);
  api.rollups = {
    diagnostics: () => [...state.reporter.diagnostics],
    recalculate: (table, id, column) => recalculate(api, table, id, column),
    recalculateStale: () => recalculateStale(api),
  };
  state.closed = false;
  scheduleMass(api, state);
  api.recordHooks.add('beforeWrite', (c, mapping, { operation, data, existing }) => {
    const table = mapping.logicalName;
    const rollups = rollupColumnsOf(api, table);
    if (operation !== 'delete' && data) {
      const refused = Object.keys(data).find((key) => Object.hasOwn(rollups, key.toLowerCase()));
      if (refused) throw writeRefused(mapping, refused);
      if (operation === 'create' || (operation === 'upsert' && !existing)) {
        for (const column of Object.keys(rollups)) {
          if (!hasKey(data, `${column}_state`)) data[`${column}_state`] = STATE.notCalculated;
          if (!hasKey(data, `${column}_date`)) data[`${column}_date`] = null;
        }
      }
    }
    const sources = rollupsSourcedFrom(api, state, table);
    const before = existing ? parentsOf(sources, existing) : [];
    if (!before.length) return;
    const list = pending.get(c) ?? [];
    list.push({ table, operation, parents: before });
    pending.set(c, list);
  });
  api.recordHooks.add('afterWrite', (c, mapping, { operation, id }) => {
    const table = mapping.logicalName;
    const sources = rollupsSourcedFrom(api, state, table);
    if (!sources.length) return;
    const list = pending.get(c) ?? [];
    const index = list.findLastIndex((entry) => entry.table === table && entry.operation === operation);
    const [entry] = index < 0 ? [] : list.splice(index, 1);
    const current =
      operation === 'delete'
        ? null
        : (api.store.tableRows(table).find((row) => sameId(row[mapping.idColumn], id)) ?? null);
    const seen = new Set();
    for (const parent of [...(entry?.parents ?? []), ...parentsOf(sources, current)]) {
      const key = `${parent.table}\u0000${parent.column}\u0000${parent.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      markStale(api, parent);
    }
  });
}

/** Validates a pack's rollups export: '<table>.<column>' keys mapping to synchronous (row, ctx) => value functions. Returns the map. */
export function validateRollups(map) {
  return validateDerivedColumns(map, 'rollups');
}

// Reseed: parsed formulas and the once-per-column diagnostics start again (the metadata may have changed).
function reset(api) {
  const state = stateOf(api);
  state.parsed.clear();
  state.memo = null;
  state.reporter.clear();
}

function close(api) {
  const state = stateOf(api);
  state.closed = true;
  if (state.massHandle != null) api.scheduler?.cancel?.(state.massHandle);
  state.massHandle = null;
}

/** Capability record for the capability registry. The periodic job is behaviour when this api scheduled it, else contract. */
function describe(api) {
  const scheduled = Boolean(api && states.get(api)?.massScheduled);
  return {
    name: 'dataverse-rollup',
    version: 1,
    kind: 'dataverse-extension',
    level: 'behaviour',
    operations: scheduled ? [...BEHAVIOUR_OPERATIONS, ...CONTRACT_OPERATIONS] : BEHAVIOUR_OPERATIONS,
    ...(scheduled ? {} : { contractOperations: CONTRACT_OPERATIONS }),
    requires: ['metadata:FormulaDefinition', 'scheduler'],
    principal: 'platform',
    stateOwner: 'none',
    lifecycle: 'per-request',
  };
}

export const EXTENSION = { name: 'dataverse-rollup', install, reset, close, describe };

registerPackExport('rollups', { key: (key) => key.toLowerCase(), check: packCheck(validateRollups) });
