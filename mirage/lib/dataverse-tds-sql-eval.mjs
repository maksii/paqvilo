// Dataverse TDS SQL evaluator (read-only subset). Pure: no store, protocol or HTTP knowledge.
// Runs parseBatch() statements against a catalog and a scan callback.
//
// executeBatch(sql, { catalog, scan, params, principal, signal, now })
//   catalog    { tables: Map<lowercase logical name, { logicalName, columns: [{ name, sqlType, length, precision, scale, nullable }] }> }
//              (the shape buildCatalog returns, see dataverse-tds-catalog.mjs)
//   scan       async (logicalName, { columns, pushdown }) -> row objects keyed by catalog column names.
//              pushdown is null or { filters, top, orderBy } (see pushdownOf): predicates the scan may apply.
//              columns is the catalog columns the statement reads, always with the id column.
//   params     sp_executesql parameters such as { "@p1": 5 }. Visible in every batch.
//   principal  accepted, not read here.
//   signal     AbortSignal, checked between rows (error 3617).
//   now        Date or () => Date, used by GETDATE and friends.
// Returns { resultSets: [{ columns: [{ name, type, length, precision, scale, nullable }], rows: [[...values]] }], rowCount }.
// rowCount is @@ROWCOUNT after the last statement. Values follow the model in dataverse-tds-sql-functions.mjs.
// A column reference takes its catalog type; other columns take a type inferred from their values.
//
// Semantics chosen where the docs are silent:
//   - GO ends a batch: DECLAREd variables do not survive it (error 137), as in T-SQL. Parameters do.
//   - @@ROWCOUNT is updated after each statement: the rows a SELECT returned (or the rows a variable assignment
//     read), and 0 after DECLARE and SET.
//   - Declared types that CAST converts (CAST_TYPES) are applied to assigned values.
//   - Error numbers and messages follow SQL Server, written from memory; the endpoint's own refusals (40000) are guesses.
// ponytail: a value with no static type (scalar subquery, unknown function) takes its kind from the JS value.
// ponytail: CONTAINS is a case-insensitive substring test, with no full-text semantics.
// ponytail: LIKE builds a RegExp per evaluation; no cache.

import { splitBatches } from './dataverse-tds-sql-lexer.mjs';
import { equalityKey, foldText } from './dataverse-values.mjs';
import { parseBatch } from './dataverse-tds-sql-parser.mjs';
import {
  callFunction,
  castValue,
  commonType,
  compareValues,
  FUNCTIONS,
  formatDecimal,
  parseDecimal,
  returnType,
  systemVariable,
  toFloat,
} from './dataverse-tds-sql-functions.mjs';

// Aggregate calls group rows (aggregateValue). CHECKSUM_AGG and GROUPING are unsupported (195).
const AGGREGATES = new Set([
  'AVG',
  'CHECKSUM_AGG',
  'COUNT',
  'COUNT_BIG',
  'GROUPING',
  'GROUPING_ID',
  'MAX',
  'MIN',
  'STDEV',
  'STDEVP',
  'STRING_AGG',
  'SUM',
  'VAR',
  'VARP',
]);
const INT_MAX = 2147483647;
const NVARCHAR_MAX_CHARS = 4000;

const lower = (value) => String(value).toLowerCase();
const isNull = (value) => value === null || value === undefined;
const isDec = (value) => value !== null && typeof value === 'object' && 'decimal' in value;
const queryOf = (node) => (node.type === 'Select' || node.type === 'SetOperation' ? node : node.query);

function fail(number, message) {
  throw { number, message, class: 16, state: 1 };
}

function tick(st) {
  if (st.signal?.aborted) fail(3617, 'Query was cancelled by the user.');
}

export async function executeBatch(
  sql,
  { catalog, scan, params = {}, principal: _principal, signal, now, collation = 'CI_AI' } = {},
) {
  const { statements } = parseBatch(sql);
  const batches = splitBatches(sql);
  // A statement belongs to the last batch that starts at or before its line.
  const groups = batches.map(() => []);
  let index = 0;
  for (const statement of statements) {
    while (index + 1 < batches.length && batches[index + 1].line <= statement.line) index += 1;
    groups[index].push(statement);
  }
  const st = {
    catalog,
    scan,
    signal,
    now,
    collation,
    scanCache: new Map(),
    referenced: null,
    session: { rowCount: 0 },
    vars: null,
    ctx: null,
  };
  const resultSets = [];
  for (const [i, batch] of batches.entries()) {
    for (let run = 0; run < batch.repeat; run += 1) {
      st.vars = new Map();
      for (const [name, value] of Object.entries(params)) {
        const key = name.startsWith('@') ? name : `@${name}`;
        st.vars.set(lower(key), { name: key, value });
      }
      for (const statement of groups[i]) await runStatement(statement, st, resultSets);
    }
  }
  return { resultSets, rowCount: st.session.rowCount };
}

async function runStatement(statement, st, resultSets) {
  tick(st);
  // One ctx per statement: functions read @@ROWCOUNT and seeded state from it.
  st.ctx = { now: st.now, rowCount: st.session.rowCount, collation: st.collation };
  st.referenced = referencedColumns(statement);
  if (statement.type === 'Declare') {
    for (const variable of statement.variables) {
      const key = lower(variable.name);
      if (st.vars.has(key)) {
        fail(
          134,
          `The variable name '${variable.name}' has already been declared. Variable names must be unique within a query batch or stored procedure.`,
        );
      }
      const value = variable.value ? await evalExpr(variable.value, rootEnv(), st) : null;
      st.vars.set(key, { name: variable.name, type: variable.dataType, value: typedValue(variable.dataType, value) });
    }
    st.session.rowCount = 0;
    return;
  }
  if (statement.type === 'Set') {
    setVar(st, statement.name, await evalExpr(statement.value, rootEnv(), st));
    st.session.rowCount = 0;
    return;
  }
  const result = await evalQuery(statement, null, st);
  if (result.columns === null) {
    st.session.rowCount = result.rowCount;
    return;
  }
  for (const column of result.columns) {
    if (column.type === 'varbinary' || column.type === 'binary') {
      fail(40000, `The data type ${column.type} is not supported.`);
    }
  }
  resultSets.push({ columns: result.columns, rows: result.rows });
  st.session.rowCount = result.rows.length;
}

function setVar(st, name, value) {
  const variable = st.vars.get(lower(name));
  if (!variable) fail(137, `Must declare the scalar variable "${name}".`);
  variable.value = typedValue(variable.type, value);
}

// Declared types that CAST can convert. Other declared types (date, ...) keep the value as assigned.
const CAST_TYPES = new Set([
  'INT',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'BIT',
  'DECIMAL',
  'NUMERIC',
  'MONEY',
  'SMALLMONEY',
  'FLOAT',
  'REAL',
  'VARCHAR',
  'NVARCHAR',
  'CHAR',
  'NCHAR',
  'DATETIME',
  'SMALLDATETIME',
  'UNIQUEIDENTIFIER',
  'BINARY',
  'VARBINARY',
]);
// A declared variable holds its value converted to its type: DECLARE @s nvarchar(3) = 'abcdef' holds 'abc'.
function typedValue(type, value) {
  if (!type || !CAST_TYPES.has(type.name)) return value;
  const bare = (type.name === 'CHAR' || type.name === 'NCHAR') && type.length === null; // a bare char in DECLARE is char(1)
  return castValue(value, bare ? `${type.name}(1)` : typeText(type));
}

const rootEnv = () => ({ frames: [], parent: null });

// Frames pair a template (alias, column names, catalog types) with one row's values, or null when null-extended.
function envOf(templates, tuple, outer) {
  return { frames: templates.map((t, i) => ({ t, vals: tuple ? tuple[i] : null })), parent: outer };
}

function templateOf(alias, names, types) {
  return { alias: lower(alias), names, lower: names.map(lower), types };
}

function metaOfColumn(column) {
  return {
    type: column.sqlType,
    length: column.length ?? undefined,
    precision: column.precision ?? undefined,
    scale: column.scale ?? undefined,
    nullable: column.nullable,
  };
}

function tableOf(source, st) {
  const table = st.catalog.tables.get(lower(source.name));
  if (!table) fail(208, `Invalid object name '${source.name}'.`);
  return table;
}

// Columns a statement reads: a column reference anywhere names one, a star reads them all (null).
function referencedColumns(statement) {
  const names = new Set();
  let all = false;
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value === null || typeof value !== 'object') return;
    if (value.type === 'ColumnRef') names.add(lower(value.parts.at(-1)));
    if (value.kind === 'Star') all = true;
    Object.values(value).forEach(walk);
  };
  walk(statement);
  return all ? null : names;
}

async function scanTable(table, st, pushdown = null) {
  const names = table.columns.map((c) => c.name);
  const columns =
    st.referenced === null
      ? names
      : names.filter((name) => st.referenced.has(name) || lower(name) === lower(table.idColumn));
  const key = JSON.stringify([table.logicalName, columns, pushdown], (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
  if (!st.scanCache.has(key)) {
    tick(st);
    const rows = await st.scan(table.logicalName, { columns, pushdown });
    st.scanCache.set(
      key,
      rows.map((row) => names.map((name) => row?.[name] ?? null)),
    );
  }
  return st.scanCache.get(key);
}

// Pushdown. The scan may narrow rows by the single-table predicates below; the evaluator still applies
// the whole WHERE. A predicate is pushed only where the server keeps every row SQL keeps. exact means it keeps
// exactly the rows SQL keeps, which TOP needs. Text is never compared for equality: SQL pads trailing spaces
// and OData does not. Text is pushed only without cased letters, where no collation changes the result.
// ponytail: date and time columns are not pushed (SQL rounds datetime to 1/300 s; string-to-date conversion).
const NUMERIC = new Set(['int', 'bigint', 'decimal', 'float', 'money']);
const PUSH_OP = { '=': '=', '<>': '<>', '!=': '<>', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
const FLIP = { '=': '=', '<>': '<>', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IN = 50;
const caseless = (s) => s.toLowerCase() === s.toUpperCase();

function conjunctsOf(node) {
  return node.type === 'Binary' && node.operator === 'AND'
    ? [...conjunctsOf(node.left), ...conjunctsOf(node.right)]
    : [node];
}

// A literal or declared variable's value; undefined for anything else.
function pushOperand(node, st) {
  if (node.type === 'Literal')
    return node.kind === 'string' || node.kind === 'number' || node.kind === 'null' ? literalValue(node) : undefined;
  if (node.type === 'Variable') return st.vars?.get(lower(node.name))?.value;
  return undefined;
}

// The value to push for a column of this SQL type, or undefined when SQL would convert or compare it differently.
function pushableValue(sqlType, value) {
  const plainNumber = typeof value === 'number' && Number.isFinite(value) && !String(value).includes('e');
  switch (sqlType) {
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= INT_MAX ? value : undefined;
    case 'bigint':
      return (typeof value === 'number' && Number.isSafeInteger(value)) || typeof value === 'bigint'
        ? value
        : undefined;
    case 'decimal':
    case 'money':
      if (isDec(value) && /^-?\d+(\.\d+)?$/.test(value.decimal)) return value;
      return plainNumber || typeof value === 'bigint' ? value : undefined;
    case 'float':
      return plainNumber ? value : undefined;
    case 'bit':
      if (typeof value === 'boolean') return value;
      return value === 0 || value === 1 ? value === 1 : undefined;
    case 'uniqueidentifier':
      return typeof value === 'string' && GUID.test(value) ? value.toLowerCase() : undefined;
    case 'nvarchar':
      return typeof value === 'string' && caseless(value) ? value : undefined;
    default:
      return undefined;
  }
}

// The catalog column a node reads when it is a plain attribute of this table; else null.
function tableColumn(node, source, table) {
  if (node.type !== 'ColumnRef' || node.parts.length > 2) return null;
  const parts = node.parts.map(lower);
  if (parts.length === 2 && parts[0] !== lower(source.alias ?? source.name)) return null;
  const column = table.columns.find((c) => c.name === parts.at(-1));
  return column?.source?.kind === 'attribute' ? column : null;
}

// A comparison of a plain column with a pushable value. Only = and <> keep the column's type rules simple.
function compareFilter(column, operator, value) {
  if (value === undefined) return null;
  if (column.sqlType === 'nvarchar')
    return operator === '<>' ? { column: column.name, op: operator, value, exact: false } : null;
  if (column.sqlType === 'bit' || column.sqlType === 'uniqueidentifier') {
    return operator === '=' || operator === '<>'
      ? { column: column.name, op: operator, value, exact: operator === '=' }
      : null;
  }
  return NUMERIC.has(column.sqlType) ? { column: column.name, op: operator, value, exact: operator === '=' } : null;
}

function filterOf(node, source, table, st) {
  if (node.type === 'IsNull') {
    const column = tableColumn(node.operand, source, table);
    return column ? { column: column.name, op: node.negated ? 'not-null' : 'is-null', exact: true } : null;
  }
  if (node.type === 'Binary' && PUSH_OP[node.operator]) {
    let column = tableColumn(node.left, source, table);
    let operator = PUSH_OP[node.operator];
    let operand = node.right;
    if (!column) {
      column = tableColumn(node.right, source, table);
      operator = FLIP[PUSH_OP[node.operator]];
      operand = node.left;
    }
    if (!column) return null;
    const value = pushableValue(column.sqlType, pushOperand(operand, st));
    return compareFilter(column, operator, value);
  }
  if (node.type === 'In' && !node.negated && !node.subquery && node.list.length <= MAX_IN) {
    const column = tableColumn(node.operand, source, table);
    if (!column || column.sqlType === 'nvarchar') return null;
    const values = node.list.map((item) => pushableValue(column.sqlType, pushOperand(item, st)));
    return values.includes(undefined) ? null : { column: column.name, op: 'in', values, exact: true };
  }
  if (node.type === 'Like' && !node.negated && !node.escape) {
    const column = tableColumn(node.operand, source, table);
    const pattern = pushOperand(node.pattern, st);
    const match = typeof pattern === 'string' ? /^([^%_[\]^]+)%$/.exec(pattern) : null;
    if (!column || column.sqlType !== 'nvarchar' || !match || !caseless(match[1])) return null;
    return { column: column.name, op: 'prefix', value: match[1], exact: true };
  }
  return null;
}

// The pushdown for a single-table SELECT, or null. Joins, derived sources and aggregation keep the scan whole.
function pushdownOf(select, grouped, st) {
  if (
    !select.from ||
    select.from.length !== 1 ||
    select.from[0].joins.length ||
    select.from[0].source.type === 'Derived'
  )
    return null;
  if (select.columns.some((column) => column.kind === 'Assign')) return null;
  const { source } = select.from[0];
  const table = st.catalog.tables.get(lower(source.name));
  if (!table) return null;
  const conjuncts = select.where ? conjunctsOf(select.where) : [];
  const filters = conjuncts.map((node) => filterOf(node, source, table, st)).filter(Boolean);
  const allExact = filters.length === conjuncts.length && filters.every((f) => f.exact);

  // TOP narrows only when the server's rows are exactly SQL's, and when the order (if any) is the server's too.
  let top = null;
  let orderBy = null;
  const count = select.top && !select.top.percent ? pushOperand(select.top.count, st) : undefined;
  if (Number.isInteger(count) && count >= 1 && count <= INT_MAX && !select.distinct && !grouped && allExact) {
    const items = select.orderBy ?? [];
    const sorted = items.map((item) => {
      const column = isNull(item.ordinal) ? tableColumn(item.expr, source, table) : null;
      const aliased = select.columns.some((c) => c.kind === 'Expr' && c.alias && lower(c.alias) === column?.name);
      return column && NUMERIC.has(column.sqlType) && !aliased
        ? { column: column.name, desc: item.direction === 'DESC' }
        : null;
    });
    if (!sorted.includes(null)) {
      top = count;
      orderBy = sorted.length ? sorted : null;
    }
  }
  return filters.length || top !== null ? { filters, top, orderBy } : null;
}

// Resolves a column reference through the scope chain: the nearest scope with a match wins.
function resolveColumn(env, parts) {
  const name = lower(parts.at(-1));
  const qualifier = parts.length >= 2 ? lower(parts.at(-2)) : null;
  for (let scope = env; scope; scope = scope.parent) {
    const hits = [];
    for (const frame of scope.frames) {
      if (qualifier !== null && frame.t.alias !== qualifier) continue;
      const i = frame.t.lower.indexOf(name);
      if (i >= 0) hits.push({ t: frame.t, i, vals: frame.vals });
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) fail(209, `Ambiguous column name '${parts.at(-1)}'.`);
  }
  return fail(207, `Invalid column name '${parts.at(-1)}'.`);
}

// Checks every column reference under node without evaluating it, so unknown names fail even with no rows.
// Subqueries are skipped: they bind when they run.
function bindColumns(node, env) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) bindColumns(item, env);
    return;
  }
  if (node.type === 'ColumnRef') {
    resolveColumn(env, node.parts);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'query' && key !== 'subquery') bindColumns(value, env);
  }
}

// Any aggregate call in the tree, subqueries included (ON clauses forbid aggregates even inside subqueries).
function hasAggregate(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasAggregate);
  if (node.type === 'FunctionCall' && AGGREGATES.has(node.name.toUpperCase())) return true;
  return Object.values(node).some(hasAggregate);
}

function containsAggregate(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(containsAggregate);
  if (node.type === 'FunctionCall' && AGGREGATES.has(node.name.toUpperCase())) return true;
  return Object.entries(node).some(([key, value]) => key !== 'query' && key !== 'subquery' && containsAggregate(value));
}

// Output names of a query, computed without running it. Derived tables need them before their rows exist,
// so a CROSS APPLY over zero rows still has its columns.
function queryNames(query, st) {
  if (query.type === 'SetOperation') return queryNames(query.left, st);
  const names = [];
  for (const column of query.columns) {
    if (column.kind === 'Assign') continue;
    if (column.kind === 'Expr') {
      names.push(column.alias ?? (column.expr.type === 'ColumnRef' ? column.expr.parts.at(-1) : ''));
      continue;
    }
    const qualifier = column.qualifier === null ? null : lower(column.qualifier);
    for (const source of sourcesOf(query)) {
      if (qualifier !== null && lower(source.alias ?? source.name) !== qualifier) continue;
      if (source.type === 'Derived') names.push(...queryNames(source.query, st));
      else names.push(...tableOf(source, st).columns.map((c) => c.name));
    }
  }
  return names;
}

// FROM sources in evaluation order: each entry's source, then its joins.
function sourcesOf(select) {
  return (select.from ?? []).flatMap((entry) => [entry.source, ...entry.joins.map((join) => join.source)]);
}

async function evalQuery(query, outer, st) {
  if (query.type === 'SetOperation') return evalSetOperation(query, outer, st);
  return evalSelect(query, outer, st);
}

async function evalSetOperation(node, outer, st) {
  const left = await evalQuery(node.left, outer, st);
  const right = await evalQuery(node.right, outer, st);
  if (left.names.length !== right.names.length) {
    fail(
      205,
      'All queries combined using a UNION, INTERSECT or EXCEPT operator must have an equal number of expressions in their target lists.',
    );
  }
  let entries = [...left.rows, ...right.rows].map((out) => ({ out }));
  if (!node.all) entries = dedupe(entries, (entry) => entry.out, st);
  const order = orderItems(node.orderBy, left.names);
  if (order.some((item) => item.expr)) {
    fail(
      104,
      'ORDER BY items must appear in the select list if the statement contains a UNION, INTERSECT or EXCEPT operator.',
    );
  }
  for (const entry of entries) entry.keys = order.map((item) => entry.out[item.index]);
  if (order.length) entries.sort((a, b) => compareEntries(a, b, order, st));
  const rows = entries.map((entry) => entry.out);
  return {
    names: left.names,
    raw: left.raw,
    rows,
    columns: finishColumns(left.names, left.raw, rows),
    rowCount: rows.length,
  };
}

// ORDER BY items: an output position (ordinal, or an output name) or an expression evaluated per row.
function orderItems(orderBy, names) {
  return (orderBy ?? []).map((item) => {
    const desc = item.direction === 'DESC';
    if (!isNull(item.ordinal)) {
      if (item.ordinal < 1 || item.ordinal > names.length) {
        fail(
          149,
          `ORDER BY position number ${item.ordinal} is out of range of the number of items in the select list.`,
        );
      }
      return { desc, index: item.ordinal - 1 };
    }
    if (item.expr.type === 'ColumnRef' && item.expr.parts.length === 1) {
      const index = names.findIndex((name) => lower(name) === lower(item.expr.parts[0]));
      if (index >= 0) return { desc, index };
    }
    return { desc, expr: item.expr };
  });
}

function compareEntries(a, b, order, st) {
  for (let k = 0; k < order.length; k += 1) {
    const x = a.keys[k];
    const y = b.keys[k];
    // NULL sorts first ascending; descending reverses the whole order, so NULLs come last.
    let c;
    if (isNull(x) && isNull(y)) c = 0;
    else if (isNull(x)) c = -1;
    else if (isNull(y)) c = 1;
    else c = compareValues(x, y, st.ctx);
    if (c !== 0) return order[k].desc ? -c : c;
  }
  return 0;
}

// ---- Static types. A type is { type, length?, precision?, scale? }; 'null' is a bare NULL and
// null means unknown, where the value-based inference (inferMeta) applies instead.
const STRING_TYPES = new Set(['nvarchar', 'varchar']);
const NUMERIC_PRECEDENCE = {
  float: 5,
  real: 5,
  decimal: 4,
  numeric: 4,
  money: 3,
  bigint: 2,
  int: 1,
  smallint: 1,
  tinyint: 1,
  bit: 1,
};
const COMPARISON_OPS = new Set(['AND', 'OR', '=', '<>', '!=', '<', '>', '<=', '>=', '!<', '!>']);
const AGGREGATE_ARITY = {
  COUNT: 1,
  COUNT_BIG: 1,
  SUM: 1,
  AVG: 1,
  MIN: 1,
  MAX: 1,
  STDEV: 1,
  STDEVP: 1,
  VAR: 1,
  VARP: 1,
  STRING_AGG: 2,
};
const UNSUPPORTED_AGGREGATES = new Set(['CHECKSUM_AGG', 'GROUPING', 'GROUPING_ID']);

// A declared, cast or converted type (parser shape { name, length, scale }) as a static type.
function metaOfTypeNode(t) {
  const name = lower(t.name);
  const length = String(t.length).toUpperCase() === 'MAX' || t.length === -1 ? -1 : (t.length ?? null);
  if (name === 'decimal' || name === 'numeric')
    return { type: 'decimal', precision: length ?? 18, scale: t.scale ?? 0 };
  if (name === 'money') return { type: 'money', precision: 19, scale: 4 };
  if (name === 'binary') return { type: 'binary', length: length ?? 1 };
  if (name === 'varbinary') return { type: 'varbinary', length: length ?? 30 };
  const alias = { char: 'varchar', nchar: 'nvarchar', real: 'float', smalldatetime: 'datetime' }[name] ?? name;
  return STRING_TYPES.has(alias) ? { type: alias, length } : { type: alias };
}

function literalMeta(node) {
  switch (node.kind) {
    case 'null':
      return { type: 'null' };
    case 'string':
      return { type: 'nvarchar', length: Math.max(node.value.length, 1) };
    case 'binary':
      return { type: 'varbinary', length: Math.max(Math.ceil((node.text.length - 2) / 2), 1) };
    case 'number': {
      if (node.numberType === 'int' || node.numberType === 'bigint')
        return { type: node.numberType, precision: literalPrecision(node) };
      if (node.numberType === 'decimal') {
        const p = parseDecimal(literalValue(node).decimal);
        return { type: 'decimal', precision: Math.max(digitCount(p.coef), p.scale, 1), scale: p.scale };
      }
      return { type: 'float' };
    }
    default:
      return null;
  }
}

// Precision and scale of an operand in decimal arithmetic (int literals carry their digit count).
const precisionOf = (m) => {
  if (m.type === 'decimal' || m.type === 'money') return { p: m.precision ?? 38, s: m.scale ?? 0 };
  return { p: m.precision ?? (m.type === 'bigint' ? 19 : 10), s: 0 };
};

function arithMeta(op, a, b) {
  if (!a || !b) return null;
  if (a.type === 'null') return b.type === 'null' ? { type: 'int' } : b;
  if (b.type === 'null') return a;
  if (a.type === 'datetime' || b.type === 'datetime') return op === '+' || op === '-' ? { type: 'datetime' } : null;
  if (STRING_TYPES.has(a.type) || STRING_TYPES.has(b.type)) {
    if (STRING_TYPES.has(a.type) && STRING_TYPES.has(b.type)) return op === '+' ? { type: 'nvarchar' } : null;
    const other = STRING_TYPES.has(a.type) ? b : a; // a string takes the kind of the other operand
    return NUMERIC_PRECEDENCE[other.type] ? other : null;
  }
  if (!NUMERIC_PRECEDENCE[a.type] || !NUMERIC_PRECEDENCE[b.type]) return null;
  const best = NUMERIC_PRECEDENCE[a.type] >= NUMERIC_PRECEDENCE[b.type] ? a : b;
  const kind = KIND_OF_TYPE[best.type];
  if (kind === 'float') return { type: 'float' };
  if (kind === 'decimal') {
    if (best.type === 'money') return { type: 'money', precision: 19, scale: 4 };
    const x = precisionOf(a);
    const y = precisionOf(b);
    const { s, p } = capShape(decimalShape(op, { scale: x.s, precision: x.p }, { scale: y.s, precision: y.p }));
    return { type: 'decimal', precision: p, scale: s };
  }
  return { type: [a, b].some((m) => KIND_OF_TYPE[m.type] === 'bigint') ? 'bigint' : 'int' };
}

function functionMeta(node, env, st) {
  const name = node.name.toUpperCase();
  if (AGGREGATES.has(name)) return aggregateMeta(node, env, st);
  const fn = FUNCTIONS.get(name);
  if (!fn) return null;
  const argMetas = node.args.map((arg) => typeOf(arg, env, st));
  if (argMetas.some((m) => m === null)) return null;
  // CONVERT and TRY_CONVERT name their type in the first argument, so that argument must be a string literal.
  const isConvert = name === 'CONVERT' || name === 'TRY_CONVERT';
  if (isConvert && !(node.args[0]?.type === 'Literal' && node.args[0].kind === 'string')) return null;
  try {
    return returnType(name, argMetas, isConvert ? { target: node.args[0].value } : {});
  } catch {
    return null;
  }
}

function aggregateMeta(node, env, st) {
  const name = node.name.toUpperCase();
  if (name === 'COUNT') return { type: 'int' };
  if (name === 'COUNT_BIG') return { type: 'bigint' };
  if (name === 'STRING_AGG') return { type: 'nvarchar', length: -1 };
  if (UNSUPPORTED_AGGREGATES.has(name)) return null;
  if (name.startsWith('STDEV') || name.startsWith('VAR')) return { type: 'float' };
  const arg = typeOf(node.args[0], env, st);
  if (!arg) return null;
  if (name === 'MIN' || name === 'MAX') return arg.type === 'null' ? { type: 'int' } : arg;
  const kind = arg.type === 'null' ? 'int' : (KIND_OF_TYPE[arg.type] ?? 'float');
  if (kind === 'decimal') {
    if (arg.type === 'money') return { type: 'money', precision: 19, scale: 4 };
    return name === 'SUM'
      ? { type: 'decimal', precision: 38, scale: arg.scale ?? 0 }
      : { type: 'decimal', precision: 38, scale: Math.max(arg.scale ?? 0, 6) };
  }
  return { type: kind };
}

// Static type of an expression, or null when it is not known statically (scalar subqueries, unknown functions).
function typeOf(node, env, st) {
  switch (node.type) {
    case 'Literal':
      return literalMeta(node);
    case 'ColumnRef': {
      const ref = resolveColumn(env, node.parts);
      return ref.t.types?.[ref.i] ?? null;
    }
    case 'Variable': {
      const variable = st.vars.get(lower(node.name));
      return variable?.type ? metaOfTypeNode(variable.type) : null;
    }
    case 'GlobalVariable':
      return { '@@ROWCOUNT': { type: 'int' }, '@@VERSION': { type: 'nvarchar' } }[node.name.toUpperCase()] ?? null;
    case 'Unary':
      return node.operator === 'NOT' ? { type: 'bit' } : typeOf(node.operand, env, st);
    case 'Binary':
      if (COMPARISON_OPS.has(node.operator)) return { type: 'bit' };
      return arithMeta(node.operator, typeOf(node.left, env, st), typeOf(node.right, env, st));
    case 'Quantified':
    case 'IsNull':
    case 'In':
    case 'Between':
    case 'Like':
    case 'Exists':
      return { type: 'bit' };
    case 'Cast':
    case 'Convert':
      return metaOfTypeNode(node.targetType);
    case 'Case':
      return commonType([
        ...node.whens.map((w) => typeOf(w.then, env, st)),
        node.elseExpr ? typeOf(node.elseExpr, env, st) : { type: 'null' },
      ]);
    case 'FunctionCall':
      return functionMeta(node, env, st);
    case 'Subquery':
      return subqueryMeta(node.query, env, st);
    default:
      return null;
  }
}

// Static type of a scalar subquery: its single select column, bound over base-table sources only (null otherwise).
function subqueryMeta(query, env, st) {
  if (query.type !== 'Select' || query.columns.length !== 1 || query.columns[0].kind !== 'Expr') return null;
  const sources = sourcesOf(query);
  if (!sources.every((s) => s.type === 'TableRef' && st.catalog.tables.has(lower(s.name)))) return null;
  const templates = sources.map((s) => {
    const table = st.catalog.tables.get(lower(s.name));
    return templateOf(
      s.alias ?? s.name,
      table.columns.map((c) => c.name),
      table.columns.map(metaOfColumn),
    );
  });
  const expr = query.columns[0].expr;
  const inner = envOf(templates, null, env);
  bindColumns(expr, inner);
  return typeOf(expr, inner, st);
}

// Static string type of an operand when it meets varbinary: a non-N literal is varchar, unknown strings nvarchar.
function textTypeOf(node, env, st) {
  if (node.type === 'Literal' && node.kind === 'string') return node.national ? 'nvarchar' : 'varchar';
  return typeOf(node, env, st)?.type ?? 'nvarchar';
}

// ---- Aggregates over one group of rows. NULLs are ignored; COUNT(*) counts rows.
function distinctValues(values, st) {
  const seen = new Set();
  return values.filter((v) => {
    const key = JSON.stringify(keyOf(v, st));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// STRING_AGG(expr, sep) WITHIN GROUP (ORDER BY ...): NULLs are skipped; without WITHIN GROUP the group's row order holds.
async function stringAgg(node, group, st) {
  const order = (node.withinGroup ?? []).map((term) => ({ desc: term.direction === 'DESC' }));
  const items = [];
  for (const tuple of group.tuples) {
    tick(st);
    const env = envOf(group.templates, tuple, group.outer);
    const v = await evalExpr(node.args[0], env, st);
    if (isNull(v)) continue;
    const keys = [];
    for (const term of node.withinGroup ?? []) keys.push(await evalExpr(term.expr, env, st));
    items.push({ v, keys });
  }
  if (!items.length) return null;
  items.sort((a, b) => compareEntries(a, b, order, st));
  const sep = await evalExpr(node.args[1], group.env, st);
  return items.map((i) => String(i.v)).join(isNull(sep) ? '' : String(sep));
}

async function aggregateValue(node, group, st) {
  const name = node.name.toUpperCase();
  if (UNSUPPORTED_AGGREGATES.has(name)) fail(195, `'${name}' is not supported in Dataverse SQL.`);
  if (node.star) return name === 'COUNT_BIG' ? BigInt(group.tuples.length) : group.tuples.length;
  if (name === 'STRING_AGG') return stringAgg(node, group, st);
  const arg = node.args[0];
  let vals = [];
  for (const tuple of group.tuples) {
    tick(st);
    const v = await evalExpr(arg, envOf(group.templates, tuple, group.outer), st);
    if (!isNull(v)) vals.push(v);
  }
  if (node.distinct) vals = distinctValues(vals, st);
  if (name === 'COUNT') return vals.length;
  if (name === 'COUNT_BIG') return BigInt(vals.length);
  if (!vals.length) return null;
  if (name === 'MIN' || name === 'MAX') {
    let best = vals[0];
    for (const v of vals) {
      const c = compareValues(v, best, st.ctx);
      if (name === 'MIN' ? c < 0 : c > 0) best = v;
    }
    return best;
  }
  if (name.startsWith('VAR') || name.startsWith('STDEV')) {
    const xs = vals.map((v) => toNumber(v));
    const n = xs.length;
    const sample = name === 'VAR' || name === 'STDEV';
    if (sample && n < 2) return null;
    const mean = xs.reduce((sum, x) => sum + x, 0) / n;
    const variance = xs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (sample ? n - 1 : n);
    return name.startsWith('STDEV') ? Math.sqrt(variance) : variance;
  }
  return sumOrAvg(name, vals, typeOf(arg, group.env, st) ?? inferMeta(vals));
}

// SUM and AVG by the argument's static kind: int and bigint stay integral (AVG divides as integers),
// decimal and money are exact, anything else is float.
function sumOrAvg(name, vals, meta) {
  const avg = name === 'AVG';
  const kind = meta.type === 'null' ? 'int' : (KIND_OF_TYPE[meta.type] ?? 'float');
  if (kind === 'int' || kind === 'bigint') {
    const sum = vals.reduce((total, v) => total + (typeof v === 'boolean' ? BigInt(Number(v)) : BigInt(v)), 0n);
    const r = avg ? sum / BigInt(vals.length) : sum;
    const [min, max] = INT_BOUNDS[kind];
    if (r < min || r > max) fail(8115, `Arithmetic overflow error converting expression to data type ${kind}.`);
    return kind === 'bigint' ? r : Number(r);
  }
  if (kind === 'decimal') {
    const parts = vals.map((v) => parseDecimal(isDec(v) ? v.decimal : String(v)));
    const s = Math.max(meta.scale ?? 0, ...parts.map((p) => p.scale));
    const total = parts.reduce((t, p) => t + scaleUp(p.coef, p.scale, s), 0n);
    if (!avg) {
      if (digitCount(total) > 38) fail(8115, 'Arithmetic overflow error converting numeric to data type numeric.');
      return { decimal: formatDecimal({ coef: total, scale: s }) };
    }
    const t = meta.type === 'money' ? 4 : Math.max(s, 6); // AVG(decimal) scale is assumed, not observed
    const coef = (total * 10n ** BigInt(t - s)) / BigInt(vals.length);
    return { decimal: formatDecimal({ coef, scale: t }) };
  }
  const total = vals.reduce((t, v) => t + toNumber(v), 0);
  return avg ? total / vals.length : total;
}

// ---- Grouping checks. Errors are raised before any row is produced.
function hasSubquery(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasSubquery);
  if (node.query || node.subquery || node.type === 'Subquery' || node.type === 'Exists' || node.type === 'Quantified')
    return true;
  return Object.values(node).some(hasSubquery);
}

function checkAggregate(node) {
  const name = node.name.toUpperCase();
  if (node.star) return;
  if (AGGREGATE_ARITY[name] !== undefined && node.args.length !== AGGREGATE_ARITY[name]) {
    fail(174, `The ${name.toLowerCase()} function requires ${AGGREGATE_ARITY[name]} argument(s).`);
  }
  if (containsAggregate(node.args) || hasSubquery(node.args)) {
    fail(130, 'Cannot perform an aggregate function on an expression containing an aggregate or a subquery.');
  }
}

// Walks every aggregate call in the tree (subqueries are checked when they run).
function checkAggregates(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(checkAggregates);
    return;
  }
  if (node.type === 'FunctionCall' && AGGREGATES.has(node.name.toUpperCase())) {
    checkAggregate(node);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'query' && key !== 'subquery') checkAggregates(value);
  }
}

// Same expression for GROUP BY matching: column references compare by what they resolve to.
function sameExpr(a, b, env) {
  if (a.type === 'ColumnRef' && b.type === 'ColumnRef') {
    const x = resolveColumn(env, a.parts);
    const y = resolveColumn(env, b.parts);
    return x.t === y.t && x.i === y.i;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// Outside an aggregate, every column must be a GROUP BY expression (8120). Subqueries are not checked.
function checkGrouped(node, groupExprs, clause, env) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) checkGrouped(item, groupExprs, clause, env);
    return;
  }
  if (node.type === 'FunctionCall' && AGGREGATES.has(node.name.toUpperCase())) return;
  if (groupExprs.some((g) => sameExpr(g, node, env))) return;
  if (node.type === 'ColumnRef') {
    fail(
      8120,
      `Column '${node.parts.join('.')}' is invalid in the ${clause} because it is not contained in either an aggregate function or the GROUP BY clause.`,
    );
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'query' && key !== 'subquery') checkGrouped(value, groupExprs, clause, env);
  }
}

// The groups of the rows that pass WHERE. Without GROUP BY all rows form one group, even when there are none.
// Each group is a unit: an env (its representative row, with .group) and that row's tuple.
async function groupUnits(select, rel, tuples, outer, st) {
  const groups = new Map();
  if (!select.groupBy) groups.set('[]', []);
  for (const tuple of tuples) {
    const key = [];
    for (const g of select.groupBy ?? [])
      key.push(keyOf(await evalExpr(g, envOf(rel.templates, tuple, outer), st), st));
    const id = JSON.stringify(key);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(tuple);
  }
  return [...groups.values()].map((members) => {
    const tuple = members[0] ?? null;
    const env = envOf(rel.templates, tuple, outer);
    env.group = { templates: rel.templates, tuples: members, outer, env };
    return { env, tuple };
  });
}

async function evalSelect(select, outer, st) {
  const grouped = Boolean(select.groupBy || select.having || containsAggregate([select.columns, select.orderBy]));
  if (select.groupBy && containsAggregate(select.groupBy))
    fail(144, 'An aggregate may not appear in the GROUP BY clause.');
  if (select.where && containsAggregate(select.where)) {
    fail(
      147,
      'An aggregate may not appear in the WHERE clause unless it is in a subquery contained in a HAVING or SELECT clause and the column being aggregated is an outer reference.',
    );
  }
  checkAggregates([select.columns, select.having, select.orderBy]);
  const rel = select.from
    ? await buildFrom(select.from, outer, st, pushdownOf(select, grouped, st))
    : { templates: [], tuples: [[]] };
  const bindEnv = envOf(rel.templates, null, outer);
  const isAssign = select.columns.some((column) => column.kind === 'Assign');
  if (isAssign && !select.columns.every((column) => column.kind === 'Assign')) {
    fail(
      141,
      'A SELECT statement that assigns a value to a variable must not be combined with data-retrieval operations.',
    );
  }
  const plan = [];
  const names = [];
  const raw = [];
  for (const column of select.columns) {
    if (column.kind === 'Star') {
      const qualifier = column.qualifier === null ? null : lower(column.qualifier);
      if (qualifier !== null && !rel.templates.some((t) => t.alias === qualifier)) {
        fail(4104, `The multi-part identifier "${column.qualifier}.*" could not be bound.`);
      }
      rel.templates.forEach((t, ti) => {
        if (qualifier !== null && t.alias !== qualifier) return;
        t.names.forEach((name, i) => {
          if (grouped) {
            // a grouped star is a list of column references, so each column is checked against GROUP BY
            const expr = { type: 'ColumnRef', parts: [t.alias, name] };
            plan.push({ kind: 'expr', expr });
            raw.push(typeOf(expr, bindEnv, st));
          } else {
            plan.push({ kind: 'value', ti, i });
            raw.push(t.types?.[i] ?? null);
          }
          names.push(name);
        });
      });
    } else if (column.kind === 'Expr') {
      bindColumns(column.expr, bindEnv);
      plan.push({ kind: 'expr', expr: column.expr });
      names.push(column.alias ?? (column.expr.type === 'ColumnRef' ? column.expr.parts.at(-1) : ''));
      raw.push(typeOf(column.expr, bindEnv, st));
    } else {
      bindColumns(column.expr, bindEnv);
      plan.push({ kind: 'assign', name: column.name, expr: column.expr });
    }
  }
  if (outer === null && select.columns.some((column) => column.kind === 'Star')) {
    // Dataverse rejects result sets with duplicate column names (a star over a JOIN with a shared name).
    const seen = new Set();
    for (const name of names) {
      if (name === '') continue;
      if (seen.has(lower(name))) fail(40000, 'Duplicate column names are not supported.');
      seen.add(lower(name));
    }
  }
  if (select.where) bindColumns(select.where, bindEnv);
  if (select.groupBy) bindColumns(select.groupBy, bindEnv);
  if (select.having) bindColumns(select.having, bindEnv);
  const order = orderItems(select.orderBy, names);
  bindColumns(
    order.filter((item) => item.expr).map((item) => item.expr),
    bindEnv,
  );
  if (select.distinct) {
    // With DISTINCT, ORDER BY may only use select-list items: a column by name, or an expression equal to one.
    const listed = (expr) =>
      expr.type === 'ColumnRef'
        ? names.some((name) => lower(name) === lower(expr.parts.at(-1))) ||
          select.columns.some(
            (column) =>
              column.kind === 'Expr' &&
              column.expr.type === 'ColumnRef' &&
              lower(column.expr.parts.at(-1)) === lower(expr.parts.at(-1)),
          )
        : select.columns.some(
            (column) => column.kind === 'Expr' && JSON.stringify(column.expr) === JSON.stringify(expr),
          );
    if (order.some((item) => item.expr && !listed(item.expr))) {
      fail(145, 'ORDER BY items must appear in the select list if SELECT DISTINCT is specified.');
    }
  }
  if (grouped) {
    const groupExprs = select.groupBy ?? [];
    for (const item of plan) if (item.expr) checkGrouped(item.expr, groupExprs, 'select list', bindEnv);
    if (select.having) checkGrouped(select.having, groupExprs, 'HAVING clause', bindEnv);
    for (const item of order) if (item.expr) checkGrouped(item.expr, groupExprs, 'ORDER BY clause', bindEnv);
  }

  const kept = [];
  for (const tuple of rel.tuples) {
    tick(st);
    if (select.where && truth(await evalExpr(select.where, envOf(rel.templates, tuple, outer), st)) !== true) continue;
    kept.push(tuple);
  }
  const units = grouped
    ? await groupUnits(select, rel, kept, outer, st)
    : kept.map((tuple) => ({ env: envOf(rel.templates, tuple, outer), tuple }));

  const produced = [];
  let assigned = 0;
  for (const { env, tuple } of units) {
    tick(st);
    if (select.having && truth(await evalExpr(select.having, env, st)) !== true) continue;
    if (isAssign) {
      assigned += 1;
      for (const item of plan) setVar(st, item.name, await evalExpr(item.expr, env, st));
      continue;
    }
    const out = [];
    for (const item of plan)
      out.push(item.kind === 'value' ? valueAt(tuple, item) : await evalExpr(item.expr, env, st));
    const keys = [];
    for (const item of order) keys.push(item.expr ? await evalExpr(item.expr, env, st) : out[item.index]);
    produced.push({ out, keys });
  }
  if (isAssign) return { columns: null, rows: [], rowCount: assigned };

  // Order of effects: DISTINCT, then ORDER BY, then TOP (T-SQL applies TOP after sorting).
  let entries = produced;
  if (select.distinct) entries = dedupe(entries, (entry) => entry.out, st);
  if (order.length) entries.sort((a, b) => compareEntries(a, b, order, st));
  if (select.top) entries = entries.slice(0, await topLimit(select.top, outer, st, entries.length));
  const rows = entries.map((entry) => entry.out);
  return { names, raw, rows, columns: finishColumns(names, raw, rows), rowCount: rows.length };
}

function valueAt(tuple, item) {
  const vals = tuple[item.ti];
  return vals ? (vals[item.i] ?? null) : null;
}

async function topLimit(top, outer, st, total) {
  const value = await evalExpr(top.count, { frames: [], parent: outer }, st);
  const n = isNull(value) ? NaN : toNumber(value);
  if (!(n >= 0)) fail(8016, 'The TOP or FETCH clause contains an invalid value.');
  return top.percent ? Math.ceil((total * n) / 100) : Math.floor(n);
}

function dedupe(list, rowOf, st) {
  const seen = new Set();
  return list.filter((item) => {
    const key = JSON.stringify(rowOf(item).map((value) => keyOf(value, st)));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Equality key for DISTINCT, UNION and GROUP BY: NULLs equal each other; strings compare under the organization
// collation through equalityKey (CI_AI folds case and accents), unless caseSensitive.
function keyOf(value, st) {
  if (isNull(value)) return ['z'];
  if (typeof value === 'boolean') return ['n', value ? '1' : '0'];
  if (typeof value === 'number' || typeof value === 'bigint') return ['n', String(value)];
  if (isDec(value)) {
    const p = decParts(value);
    const frac = p.frac.replace(/0+$/, '');
    return ['n', (p.neg ? '-' : '') + p.int + (frac ? `.${frac}` : '')];
  }
  if (value instanceof Date) return ['d', String(value.getTime())];
  const text = String(value);
  return ['s', st.ctx?.caseSensitive ? text : equalityKey(text.replace(/ +$/, ''), st.ctx?.collation ?? 'CI_AI')];
}

function decParts(value) {
  const text = value.decimal;
  const neg = text.startsWith('-');
  const [int, frac = ''] = text.replace(/^[+-]/, '').split('.');
  return { neg, int: int || '0', frac };
}

function formatDec({ neg, int, frac }, scale) {
  return (neg ? '-' : '') + int + (scale > 0 ? `.${frac.padEnd(scale, '0')}` : '');
}

// Result column metadata. Static types win; a column without one infers from its values, and a bare NULL is int.
// Strings without a static length take the longest value.
function finishColumns(names, raw, rows) {
  return names.map((name, i) => {
    const values = rows.map((row) => row[i]);
    const meta = !raw[i] ? inferMeta(values) : raw[i].type === 'null' ? { type: 'int' } : { ...raw[i] };
    if (meta.type === 'decimal' || meta.type === 'money') rescaleColumn(rows, i, meta);
    if (STRING_TYPES.has(meta.type) && isNull(meta.length)) meta.length = inferLength(values);
    const column = { name, type: meta.type, nullable: meta.nullable ?? true };
    for (const key of ['length', 'precision', 'scale']) {
      if (isNull(meta[key])) continue;
      if (key !== 'length' && meta.type !== 'decimal' && meta.type !== 'money') continue;
      column[key] = meta[key];
    }
    if (
      column.type === 'nvarchar' &&
      (column.length === -1 || column.length === 'max' || column.length > NVARCHAR_MAX_CHARS)
    ) {
      column.length = 'max';
    }
    return column;
  });
}

function inferLength(values) {
  return values.filter((value) => !isNull(value)).reduce((max, value) => Math.max(max, String(value).length), 1);
}

function inferMeta(values) {
  const present = values.filter((value) => !isNull(value));
  const first = present[0];
  if (first === undefined) return { type: 'nvarchar', length: 1 };
  if (typeof first === 'boolean') return { type: 'bit' };
  if (typeof first === 'bigint') return { type: 'bigint' };
  if (typeof first === 'number')
    return { type: Number.isInteger(first) && Math.abs(first) <= INT_MAX ? 'int' : 'float' };
  if (first instanceof Date) return { type: 'datetime' };
  if (isDec(first)) return { type: 'decimal', precision: 38, scale: 0 };
  return { type: 'nvarchar', length: inferLength(present) };
}

// Pads every decimal value in the column to one scale, the largest any value needs.
function rescaleColumn(rows, i, meta) {
  const scale = rows.reduce(
    (max, row) => (isDec(row[i]) ? Math.max(max, decParts(row[i]).frac.length) : max),
    meta.scale ?? 0,
  );
  meta.scale = scale;
  for (const row of rows) {
    if (isDec(row[i])) row[i] = { decimal: formatDec(decParts(row[i]), scale) };
  }
}

async function buildFrom(from, outer, st, pushdown = null) {
  let rel = { templates: [], tuples: [[]] };
  for (const entry of from) {
    let part = await sourceRel(
      entry.source,
      outer,
      st,
      from.length === 1 && entry.joins.length === 0 ? pushdown : null,
    );
    for (const join of entry.joins) part = await joinRel(part, join, outer, st);
    rel = crossRel(rel, part, st);
  }
  return rel;
}

// A relation: templates (one per source) and tuples (one value array or null per template).
async function sourceRel(source, outer, st, pushdown = null) {
  if (source.type === 'Derived') {
    const result = await evalQuery(source.query, outer, st);
    const template = templateOf(source.alias, result.names, result.raw);
    return { templates: [template], tuples: result.rows.map((row) => [row]) };
  }
  const table = tableOf(source, st);
  const template = templateOf(
    source.alias ?? source.name,
    table.columns.map((c) => c.name),
    table.columns.map(metaOfColumn),
  );
  const rows = await scanTable(table, st, pushdown);
  return { templates: [template], tuples: rows.map((row) => [row]) };
}

async function joinRel(left, join, outer, st) {
  if (join.on && hasAggregate(join.on)) {
    fail(
      147,
      'An aggregate may not appear in the ON clause unless it is in a subquery contained in a HAVING clause or select list, and the column being aggregated is an outer reference.',
    );
  }
  if (join.type === 'Apply') {
    const template = templateOf(join.source.alias, queryNames(join.source.query, st), null);
    const out = [];
    for (const lt of left.tuples) {
      const result = await evalQuery(join.source.query, envOf(left.templates, lt, outer), st);
      if (result.rows.length === 0 && join.kind === 'OUTER') out.push([...lt, null]);
      for (const row of result.rows) {
        tick(st);
        out.push([...lt, row]);
      }
    }
    return { templates: [...left.templates, template], tuples: out };
  }
  const right = await sourceRel(join.source, outer, st);
  const templates = [...left.templates, ...right.templates];
  if (join.on) bindColumns(join.on, envOf(templates, null, outer));
  const rightHit = right.tuples.map(() => false);
  const out = [];
  for (const lt of left.tuples) {
    let hit = false;
    for (let j = 0; j < right.tuples.length; j += 1) {
      tick(st);
      const candidate = [...lt, ...right.tuples[j]];
      const matched =
        join.kind === 'CROSS' || truth(await evalExpr(join.on, envOf(templates, candidate, outer), st)) === true;
      if (matched) {
        hit = true;
        rightHit[j] = true;
        out.push(candidate);
      }
    }
    if (!hit && (join.kind === 'LEFT' || join.kind === 'FULL')) out.push([...lt, ...right.templates.map(() => null)]);
  }
  if (join.kind === 'RIGHT' || join.kind === 'FULL') {
    right.tuples.forEach((rt, j) => {
      if (!rightHit[j]) out.push([...left.templates.map(() => null), ...rt]);
    });
  }
  return { templates, tuples: out };
}

function crossRel(a, b, st) {
  const tuples = [];
  for (const x of a.tuples) {
    for (const y of b.tuples) {
      tick(st);
      tuples.push([...x, ...y]);
    }
  }
  return { templates: [...a.templates, ...b.templates], tuples };
}

// Three-valued logic. truth() maps a value to true, false or null (UNKNOWN).
function truth(value) {
  if (isNull(value)) return null;
  if (typeof value === 'boolean') return value;
  return toNumber(value) !== 0;
}

const not3 = (value) => (value === null ? null : !value);
const and3 = (a, b) => (a === false || b === false ? false : a === null || b === null ? null : true);
const or3 = (a, b) => (a === true || b === true ? true : a === null || b === null ? null : false);

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (isDec(value)) return Number(value.decimal);
  return Number(value);
}

// Comparison with UNKNOWN for NULL operands. Ordering and collation come from compareValues.
// tA and tB are the operands' static types, used when a string meets varbinary.
function compareOp(op, a, b, st, tA = null, tB = null) {
  if (isNull(a) || isNull(b)) return null;
  // Two strings compare under the organization collation: CI_AI folds accents as well as case.
  const fold = (v) => (typeof v === 'string' && !st.ctx.caseSensitive ? foldText(v, st.ctx.collation ?? 'CI_AI') : v);
  const c =
    typeof a === 'string' && typeof b === 'string'
      ? compareValues(fold(a), fold(b), st.ctx, tA, tB)
      : compareValues(a, b, st.ctx, tA, tB);
  switch (op) {
    case '=':
      return c === 0;
    case '<>':
    case '!=':
      return c !== 0;
    case '<':
      return c < 0;
    case '!<':
      return c >= 0;
    case '>':
      return c > 0;
    case '!>':
      return c <= 0;
    case '<=':
      return c <= 0;
    default:
      return c >= 0; // ">="
  }
}

// Arithmetic. Each operand has a kind: int, bigint, decimal, float. The result kind is the highest rank
// of the operands (int < bigint < decimal < float); a string takes the kind of the other operand.
// `ma` and `mb` are the operands' static types (see typeOf); a float column divides as float even when integral.
const NUM_RANK = { int: 0, bigint: 1, decimal: 2, float: 3 };
const INT_BOUNDS = { int: [-(2n ** 31n), 2n ** 31n - 1n], bigint: [-(2n ** 63n), 2n ** 63n - 1n] };
const BITWISE = new Set(['&', '|', '^']);
const OP_NAME = { '*': 'multiply', '/': 'divide', '%': 'modulo', '-': 'subtract', '+': 'add' };

// Kind of an operand: from its static type when known, else from the JS value.
const KIND_OF_TYPE = {
  int: 'int',
  smallint: 'int',
  tinyint: 'int',
  bit: 'int',
  bigint: 'bigint',
  decimal: 'decimal',
  numeric: 'decimal',
  money: 'decimal',
  float: 'float',
  real: 'float',
};
const numKind = (v, meta) => {
  if (meta && KIND_OF_TYPE[meta.type]) return KIND_OF_TYPE[meta.type];
  if (typeof v === 'boolean') return 'int';
  if (typeof v === 'bigint') return 'bigint';
  if (isDec(v)) return 'decimal';
  return Number.isInteger(v) ? 'int' : 'float';
};
const digitCount = (coef) => (coef < 0n ? -coef : coef).toString().length;
const scaleUp = (coef, from, to) => coef * 10n ** BigInt(to - from);
// Rescales an exact coefficient to fewer places, rounding half away from zero (SQL decimal cap).
function scaleDown(coef, from, to) {
  if (to >= from) return scaleUp(coef, from, to);
  const div = 10n ** BigInt(from - to);
  const neg = coef < 0n;
  const abs = neg ? -coef : coef;
  let q = abs / div;
  if ((abs % div) * 2n >= div) q += 1n;
  return neg ? -q : q;
}

// Converts an operand to the working form of `kind`: a JS number (float), { coef, scale, precision } (decimal) or BigInt.
function operandAs(v, kind, prec = null) {
  if (kind === 'float') return typeof v === 'string' ? toFloat(v, 'nvarchar') : Number(isDec(v) ? v.decimal : v);
  if (kind === 'decimal') {
    if (typeof v === 'string') {
      const p = parseDecimal(v);
      if (!p) fail(8114, 'Error converting data type nvarchar to numeric.');
      return { ...p, precision: Math.max(digitCount(p.coef), p.scale, 1) };
    }
    if (isDec(v)) {
      const p = parseDecimal(v.decimal);
      return { ...p, precision: Math.max(digitCount(p.coef), p.scale, 1) };
    }
    // An integer literal is decimal(digits, 0) in a non-parameterized query; other integers are decimal(10, 0) or (19, 0).
    return {
      coef: BigInt(typeof v === 'boolean' ? Number(v) : v),
      scale: 0,
      precision: prec ?? (typeof v === 'bigint' ? 19 : 10),
    };
  }
  if (typeof v === 'string') return BigInt(castValue(v, kind));
  return BigInt(typeof v === 'boolean' ? Number(v) : v);
}

// Result scale and precision of decimal arithmetic per SQL Server (+, -, *, /; % follows the modulo rule), before the 38 cap.
function decimalShape(op, { scale: s1, precision: p1 }, { scale: s2, precision: p2 }) {
  if (op === '+' || op === '-') {
    const s = Math.max(s1, s2);
    return { s, p: Math.max(p1 - s1, p2 - s2) + s + 1 };
  }
  if (op === '*') return { s: s1 + s2, p: p1 + p2 + 1 };
  if (op === '/') {
    const s = Math.max(6, s1 + p2 + 1);
    return { s, p: p1 - s1 + s2 + s };
  }
  const s = Math.max(s1, s2); // %
  return { s, p: Math.min(p1 - s1, p2 - s2) + s }; // modulo precision rule is assumed, not observed
}

// Caps precision at 38 and keeps min(scale, 6) fraction digits.
function capShape({ s, p }) {
  if (p <= 38) return { s, p };
  return { s: Math.max(38 - (p - s), Math.min(s, 6)), p: 38 };
}

function decimalArith(op, x, y) {
  const shape = decimalShape(op, x, y);
  const s = shape.s;
  let coef;
  if (op === '+' || op === '-') {
    const a = scaleUp(x.coef, x.scale, s);
    const b = scaleUp(y.coef, y.scale, s);
    coef = op === '+' ? a + b : a - b;
  } else if (op === '*') {
    coef = x.coef * y.coef;
  } else if (op === '/') {
    coef = (x.coef * 10n ** BigInt(s + y.scale - x.scale)) / y.coef; // truncates toward zero, as SQL does
  } else {
    coef = scaleUp(x.coef, x.scale, s) % scaleUp(y.coef, y.scale, s);
  }
  const capped = capShape(shape);
  if (capped.s !== s) coef = scaleDown(coef, s, capped.s);
  if (digitCount(coef) > capped.p) fail(8115, 'Arithmetic overflow error converting numeric to data type numeric.');
  return { decimal: formatDecimal({ coef, scale: capped.s }) };
}

function integerArith(op, x, y, kind) {
  const r = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : x % y;
  const [min, max] = INT_BOUNDS[kind];
  if (r < min || r > max) fail(8115, `Arithmetic overflow error converting expression to data type ${kind}.`);
  return kind === 'bigint' ? r : Number(r);
}

// Date arithmetic: datetime +/- a number of days (fractions allowed). datetime - datetime gives a datetime:
// 1900-01-01 moved by the difference, as SQL Server does.
function dateArith(op, a, b) {
  const isDate = (v) => v instanceof Date;
  const days = (v) => (typeof v === 'string' ? toFloat(v, 'nvarchar') : Number(isDec(v) ? v.decimal : v));
  if (isDate(a) && isDate(b)) {
    if (op !== '-') fail(206, 'Operand type clash: datetime is incompatible with datetime.');
    const ms = Date.UTC(1900, 0, 1) + (a.getTime() - b.getTime());
    if (!(ms >= DATETIME_MIN && ms <= DATETIME_MAX))
      fail(517, "Adding a value to a 'datetime' column caused an overflow.");
    return new Date(ms);
  }
  if (op !== '+' && op !== '-') fail(8117, `Operand data type datetime is invalid for ${OP_NAME[op] ?? op} operator.`);
  if (!isDate(a) && (op === '-' || !isDate(b)))
    fail(206, 'Operand type clash: datetime is incompatible with the operand.');
  const [base, delta] = isDate(a) ? [a, b] : [b, a];
  const ms = Math.round(base.getTime() + (op === '-' ? -1 : 1) * days(delta) * 86400000);
  if (!(ms >= DATETIME_MIN && ms <= DATETIME_MAX))
    fail(517, "Adding a value to a 'datetime' column caused an overflow.");
  return new Date(ms);
}
const DATETIME_MIN = Date.UTC(1753, 0, 1);
const DATETIME_MAX = Date.UTC(9999, 11, 31, 23, 59, 59, 997);

// `hints` carries the decimal precision of integer literal operands (see literalPrecision).
function arith(op, a, b, ma = null, mb = null, hints = {}) {
  if (isNull(a) || isNull(b)) return null;
  if (op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b))
    fail(
      402,
      `The data types varbinary and ${typeof a === 'string' || typeof b === 'string' ? 'nvarchar' : 'int'} are incompatible in the ${OP_NAME[op] ?? op} operator.`,
    );
  if (a instanceof Date || b instanceof Date) return dateArith(op, a, b);
  if (!['+', '-', '*', '/', '%', ...BITWISE].includes(op)) fail(40000, `operator ${op} is not implemented.`);
  const kA = typeof a === 'string' ? null : numKind(a, ma);
  const kB = typeof b === 'string' ? null : numKind(b, mb);
  let kind;
  if (kA === null && kB === null) kind = intText(a) && intText(b) ? 'int' : 'float';
  else if (kA === null) kind = kB;
  else if (kB === null) kind = kA;
  else kind = NUM_RANK[kA] >= NUM_RANK[kB] ? kA : kB;
  if (BITWISE.has(op) && (kind === 'float' || kind === 'decimal'))
    fail(402, `The ${OP_NAME[op] ?? 'bitwise'} operator is not valid for a ${kind} operand.`);
  const x = operandAs(a, BITWISE.has(op) ? 'bigint' : kind, hints.a ?? null);
  const y = operandAs(b, BITWISE.has(op) ? 'bigint' : kind, hints.b ?? null);
  if ((op === '/' || op === '%') && (kind === 'float' ? y === 0 : kind === 'decimal' ? y.coef === 0n : y === 0n)) {
    fail(8134, 'Divide by zero error encountered.');
  }
  if (BITWISE.has(op)) {
    const r = op === '&' ? x & y : op === '|' ? x | y : x ^ y;
    return kind === 'bigint' ? r : Number(r);
  }
  if (kind === 'float') {
    const r = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : x % y;
    if (!Number.isFinite(r)) fail(8115, 'Arithmetic overflow error converting expression to data type float.');
    return r;
  }
  if (kind === 'decimal') return decimalArith(op, x, y);
  return integerArith(op, x, y, kind);
}
const intText = (s) => /^\s*[+-]?\d+\s*$/.test(s);

// Precision of an integer literal (2 -> 1, 250 -> 3, -2 -> 1); null for anything else.
function literalPrecision(node) {
  if (node.type === 'Unary' && node.operator !== 'NOT') return literalPrecision(node.operand);
  if (node.type !== 'Literal' || node.kind !== 'number' || (node.numberType !== 'int' && node.numberType !== 'bigint'))
    return null;
  return String(BigInt(node.text)).length;
}

function unary(op, value) {
  if (op === 'NOT') return not3(truth(value));
  if (isNull(value)) return null;
  if (op === '+') return value;
  if (op === '~') return typeof value === 'bigint' ? ~value : ~toNumber(value);
  if (typeof value === 'bigint') return -value;
  if (isDec(value)) return { decimal: value.decimal.startsWith('-') ? value.decimal.slice(1) : `-${value.decimal}` };
  return -toNumber(value);
}

function literalValue(node) {
  switch (node.kind) {
    case 'null':
      return null;
    case 'string':
      return node.value;
    case 'number':
      if (node.numberType === 'int') return Number(node.text);
      if (node.numberType === 'bigint') return BigInt(node.text);
      if (node.numberType === 'decimal') return { decimal: node.text.startsWith('.') ? `0${node.text}` : node.text };
      return Number(node.text);
    case 'binary': {
      // 0x literals are varbinary; an odd digit count pads with a leading zero
      const hex = node.text.slice(2);
      return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
    }
    default:
      return fail(40000, `literal kind ${node.kind} is not implemented.`);
  }
}

// CAST and CONVERT take the type as text, e.g. "nvarchar(max)" or "decimal(10,2)".
function typeText(targetType) {
  const { name, length, scale } = targetType;
  let size = '';
  if (length !== null) size = scale === null ? `(${length})` : `(${length},${scale})`;
  return `${name.toLowerCase()}${size}`;
}

// Tokenize before collation folding so an accented escape remains distinct from a literal.
// A dangling escape produces an invalid pattern, which LIKE treats as a non-match.
function likeRegex(pattern, escape, collation) {
  const literal = (text) => escapeRe(foldText(text, collation));
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (escape !== null && c === escape) {
      if (i + 1 === pattern.length) return null;
      i += 1;
      out += literal(pattern[i]);
    } else if (c === '%') {
      out += '[\\s\\S]*';
    } else if (c === '_') {
      out += '[\\s\\S]';
    } else if (c === '[' && pattern.indexOf(']', i + 1) > i + 1) {
      let end = i + 1;
      const negate = pattern[end] === '^' && escape !== '^';
      if (negate) end++;
      let set = '';
      for (; end < pattern.length && pattern[end] !== ']'; end++) {
        const escaped = escape !== null && pattern[end] === escape;
        if (escaped && ++end === pattern.length) return null;
        const member = foldText(pattern[end], collation).replace(/[\\[\]^]/g, '\\$&');
        set += escaped ? member.replace(/-/g, '\\-') : member;
      }
      if (end === pattern.length || !set) return null;
      out += `[${negate ? '^' : ''}${set}]`;
      i = end;
    } else {
      out += literal(c);
    }
  }
  // Keep insensitive matching after accent folding: whole strings and individual
  // pattern tokens can lowercase differently (for example Greek final sigma).
  return new RegExp(`${out}$`, 'si');
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

function singleColumn(result) {
  if (result.names.length !== 1) {
    fail(
      116,
      'Only one expression can be specified in the select list when the subquery is not introduced with EXISTS.',
    );
  }
  return result;
}

async function evalExpr(node, env, st) {
  switch (node.type) {
    case 'Literal':
      return literalValue(node);
    case 'ColumnRef': {
      const ref = resolveColumn(env, node.parts);
      return ref.vals ? (ref.vals[ref.i] ?? null) : null;
    }
    case 'Variable': {
      const variable = st.vars.get(lower(node.name));
      if (!variable) fail(137, `Must declare the scalar variable "${node.name}".`);
      return variable.value;
    }
    case 'GlobalVariable':
      return systemVariable(node.name, st.ctx);
    case 'Unary':
      return unary(node.operator, await evalExpr(node.operand, env, st));
    case 'Binary': {
      const a = await evalExpr(node.left, env, st);
      const b = await evalExpr(node.right, env, st);
      switch (node.operator) {
        case 'AND':
          return and3(truth(a), truth(b));
        case 'OR':
          return or3(truth(a), truth(b));
        case '=':
        case '<>':
        case '!=':
        case '<':
        case '>':
        case '<=':
        case '>=':
        case '!<':
        case '!>':
          return compareOp(node.operator, a, b, st, textTypeOf(node.left, env, st), textTypeOf(node.right, env, st));
        default:
          return arith(node.operator, a, b, typeOf(node.left, env, st), typeOf(node.right, env, st), {
            a: literalPrecision(node.left),
            b: literalPrecision(node.right),
          });
      }
    }
    case 'Quantified': {
      const value = await evalExpr(node.left, env, st);
      const result = singleColumn(await evalQuery(node.query, env, st));
      let unknown = false;
      for (const row of result.rows) {
        const r = compareOp(node.operator, value, row[0], st);
        if (node.quantifier === 'ANY') {
          if (r === true) return true;
          if (r === null) unknown = true;
        } else {
          if (r === false) return false;
          if (r === null) unknown = true;
        }
      }
      if (node.quantifier === 'ANY') return unknown ? null : false;
      return unknown ? null : true;
    }
    case 'IsNull': {
      const isNil = isNull(await evalExpr(node.operand, env, st));
      return isNil !== node.negated;
    }
    case 'In': {
      const value = await evalExpr(node.operand, env, st);
      const valueType = textTypeOf(node.operand, env, st);
      const items = [];
      const itemTypes = [];
      if (node.subquery) {
        for (const row of singleColumn(await evalQuery(queryOf(node.subquery), env, st)).rows) items.push(row[0]);
      } else {
        for (const item of node.list) {
          items.push(await evalExpr(item, env, st));
          itemTypes.push(textTypeOf(item, env, st));
        }
      }
      let found = false;
      let unknown = false;
      for (const [k, item] of items.entries()) {
        const r = compareOp('=', value, item, st, valueType, itemTypes[k] ?? 'nvarchar');
        if (r === true) {
          found = true;
          break;
        }
        if (r === null) unknown = true;
      }
      const result = found ? true : unknown ? null : false;
      return node.negated ? not3(result) : result;
    }
    case 'Between': {
      const value = await evalExpr(node.operand, env, st);
      const low = await evalExpr(node.low, env, st);
      const high = await evalExpr(node.high, env, st);
      const valueType = textTypeOf(node.operand, env, st);
      const result = and3(
        compareOp('>=', value, low, st, valueType, textTypeOf(node.low, env, st)),
        compareOp('<=', value, high, st, valueType, textTypeOf(node.high, env, st)),
      );
      return node.negated ? not3(result) : result;
    }
    case 'Like': {
      const value = await evalExpr(node.operand, env, st);
      const pattern = await evalExpr(node.pattern, env, st);
      const escape = node.escape ? await evalExpr(node.escape, env, st) : null;
      if (isNull(value) || isNull(pattern) || (node.escape && isNull(escape))) return null;
      const escapeChar = node.escape ? String(escape) : null;
      if (escapeChar !== null && escapeChar.length !== 1)
        fail(506, `The invalid escape character "${escapeChar}" was specified in a LIKE predicate.`);
      const compiled = likeRegex(String(pattern), escapeChar, st.collation);
      const matched = compiled?.test(foldText(value, st.collation)) ?? false;
      return node.negated ? !matched : matched;
    }
    case 'Exists':
      return (await evalQuery(queryOf(node.subquery), env, st)).rows.length > 0;
    case 'Subquery': {
      const result = singleColumn(await evalQuery(node.query, env, st));
      if (result.rows.length > 1) {
        fail(
          512,
          'Subquery returned more than 1 value. This is not permitted when the subquery follows =, !=, <, <= , >, >= or when the subquery is used as an expression.',
        );
      }
      return result.rows.length ? result.rows[0][0] : null;
    }
    case 'Case': {
      const subject = node.operand ? await evalExpr(node.operand, env, st) : null;
      for (const { when, then } of node.whens) {
        const value = await evalExpr(when, env, st);
        const hit = node.operand ? compareOp('=', subject, value, st) === true : truth(value) === true;
        if (hit) return evalExpr(then, env, st);
      }
      return node.elseExpr ? evalExpr(node.elseExpr, env, st) : null;
    }
    case 'Cast': {
      const value = await evalExpr(node.operand, env, st);
      const spec = typeText(node.targetType);
      if (node.tryCast) return callFunction('TRY_CONVERT', [spec, value], st.ctx);
      return castValue(value, spec, { fromType: typeOf(node.operand, env, st)?.type });
    }
    case 'Convert': {
      const value = await evalExpr(node.operand, env, st);
      const spec = typeText(node.targetType);
      const style = node.style ? await evalExpr(node.style, env, st) : undefined;
      if (node.tryConvert)
        return callFunction('TRY_CONVERT', style === undefined ? [spec, value] : [spec, value, style], st.ctx);
      return castValue(value, spec, { style, fromType: typeOf(node.operand, env, st)?.type });
    }
    case 'FunctionCall': {
      const name = node.name.toUpperCase();
      if (AGGREGATES.has(name)) {
        if (!env.group) fail(40000, 'aggregate outside a grouped query is not implemented.'); // unreachable: grouping is decided per SELECT
        return aggregateValue(node, env.group, st);
      }
      const args = [];
      for (const arg of node.args) args.push(await evalExpr(arg, env, st));
      if (name === 'CONTAINS') {
        // ponytail: substring match only; no full-text semantics
        const [column, text] = args;
        if (isNull(column) || isNull(text)) return null;
        const haystack = String(column);
        const needle = String(text);
        return st.ctx.caseSensitive ? haystack.includes(needle) : haystack.toLowerCase().includes(needle.toLowerCase());
      }
      return callFunction(node.name, args, st.ctx);
    }
    default:
      return fail(40000, `expression ${node.type} is not implemented.`);
  }
}
