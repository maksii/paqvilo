// Calculated columns (SourceType 1) in the Dataverse API: computed on read, refused on write.
//
// A column is calculated when its metadata says SourceType 1 (exported column facts sit under columnMetadata). On every read
// the store's computed-column seam (store.setComputedColumns) answers the value computed from the row, so $filter, $orderby,
// $apply, FetchXML and the property route all see it (ctx.user is null: the platform computes the column):
//   1. a trusted pack's calculatedColumns['<table>.<column>'](row, ctx) wins;
//   2. else the FormulaDefinition is parsed into a small expression tree and evaluated;
//   3. else (no definition, or a node outside the supported subset) the value is null and CALCULATED_UNSUPPORTED is
//      reported once per column. A value is never guessed.
//
// Supported FormulaDefinition subset (element local names, case-insensitive, prefixes ignored). The root is a <Formula>
// wrapper with one expression, or the expression itself:
//   <Constant Value="2" Type="number|string|boolean|datetime|null"/>   (Type omitted: a number when numeric, else text)
//   <Field Name="x_amount"/>  same row;  <Field Name="x_parentid.x_rate"/>  one hop through an N:1 lookup
//   <Add>, <Subtract>, <Multiply>, <Divide>  numbers; <Concat> text (null is empty)
//   <If> condition, then, else?;  <Equal>, <NotEqual>, <GreaterThan>, <GreaterEqual>, <LessThan>, <LessEqual>, <And>, <Or>,
//   <Not>, <IsNull>
//   <AddDays|AddHours|AddWeeks|AddMonths|AddYears> date, amount;  <DiffInDays|DiffInHours|DiffInMinutes|DiffInWeeks|
//   DiffInMonths|DiffInYears> from, to
// The designer's native FormulaDefinition is Windows Workflow XAML (ActivityReference / EvaluateExpression with VB
// expressions). It is outside this subset, so an exported designer formula reports CALCULATED_UNSUPPORTED; a pack override
// supplies its value.
// Expressions nest at most 64 deep; a deeper definition reports CALCULATED_UNSUPPORTED (parse and evaluation recurse).
// describe(api) is contract: the subset above is the simulator's own grammar, not the designer's XAML. It is behaviour only when
// the installed api's pack calculatedColumns cover every calculated column of the store.
// Arithmetic and comparison of numbers are exact decimals (exact-numeric.mjs), as Dataverse decimal and money columns are.
import { DataError } from "./data-error.mjs";
import { compareNumeric, isExactNumeric } from "./exact-numeric.mjs";
import { FxError, decimalArithmetic } from "./power-fx.mjs";
import { parseSolutionXml } from "./solution-xml.mjs";
import { packCheck, registerPackExport } from "./pack-exports.mjs";
import { onceReporter, packOverrides } from "./dataverse-addon-common.mjs";

const CALCULATED = 1;
const MAX_DEPTH = 64;
const MAX_CHAIN = 5;
const DAY = 86_400_000;
const OPERATIONS = [
  "Constant", "Field", "Add", "Subtract", "Multiply", "Divide", "Concat", "If", "Equal", "NotEqual",
  "GreaterThan", "GreaterEqual", "LessThan", "LessEqual", "And", "Or", "Not", "IsNull",
  "AddDays", "AddHours", "AddWeeks", "AddMonths", "AddYears", "DiffInDays", "DiffInHours", "DiffInMinutes", "DiffInWeeks",
  "DiffInMonths", "DiffInYears",
];

const enumValue = (value) => (value !== null && typeof value === "object" ? value.Value : value);
const facts = (definition) => ({ ...definition, ...(definition?.columnMetadata ?? {}) });
const localName = (name) => String(name).split(":").pop().toLowerCase();
const elements = (node) => (node?.children ?? []).filter((item) => !item.name.startsWith("#"));
const attr = (node, name) => Object.entries(node.attrs ?? {}).find(([key]) => localName(key) === name.toLowerCase())?.[1];
const refId = (value) => (value !== null && typeof value === "object" ? value.id : value);
const isThenable = (value) => value !== null && typeof value === "object" && typeof value.then === "function";

class Unsupported extends Error {}
const unsupported = (message) => { throw new Unsupported(message); };

// ---- Parser: FormulaDefinition text -> expression tree

const ARITY = {
  add: [2, Infinity], subtract: [2, 2], multiply: [2, Infinity], divide: [2, 2], concat: [1, Infinity], if: [2, 3],
  equal: [2, 2], notequal: [2, 2], greaterthan: [2, 2], greaterequal: [2, 2], lessthan: [2, 2], lessequal: [2, 2],
  and: [1, Infinity], or: [1, Infinity], not: [1, 1], isnull: [1, 1],
  adddays: [2, 2], addhours: [2, 2], addweeks: [2, 2], addmonths: [2, 2], addyears: [2, 2],
  diffindays: [2, 2], diffinhours: [2, 2], diffinminutes: [2, 2], diffinweeks: [2, 2], diffinmonths: [2, 2], diffinyears: [2, 2],
};

function constantOf(node) {
  const text = attr(node, "Value") ?? node.text.trim();
  const type = String(attr(node, "Type") ?? "").toLowerCase();
  if (type === "null") return null;
  if (type === "string") return text;
  if (type === "boolean") return ["1", "true"].includes(text.toLowerCase());
  if (type === "datetime") {
    if (Number.isNaN(Date.parse(text))) unsupported(`Constant '${text}' is not a date.`);
    return new Date(text).toISOString();
  }
  if (type === "number" || (!type && text !== "" && Number.isFinite(Number(text)))) {
    if (!Number.isFinite(Number(text))) unsupported(`Constant '${text}' is not a number.`);
    return Number(text);
  }
  if (type) unsupported(`Constant type '${type}' is not supported.`);
  return text;
}

function parseNode(node, depth = 0) {
  if (depth >= MAX_DEPTH) unsupported(`The formula nests deeper than ${MAX_DEPTH} expressions.`);
  const kind = localName(node.name);
  if (kind === "constant") return { kind, value: constantOf(node) };
  if (kind === "field") {
    const name = String(attr(node, "Name") ?? "").trim().toLowerCase();
    const parts = name.split(".");
    if (!name || parts.length > 2 || parts.some((part) => !/^[a-z_][a-z0-9_]*$/.test(part))) unsupported(`Field '${name}' is not a column or a one-hop parent column.`);
    return parts.length === 2 ? { kind: "parent", lookup: parts[0], column: parts[1] } : { kind, column: name };
  }
  const arity = ARITY[kind];
  if (!arity) unsupported(`Formula node <${node.name}> is not supported.`);
  const args = elements(node).map((child) => parseNode(child, depth + 1));
  if (args.length < arity[0] || args.length > arity[1]) unsupported(`<${node.name}> takes ${arity[0]}${arity[1] === arity[0] ? "" : "+"} arguments.`);
  return { kind, args };
}

/** Parses a FormulaDefinition into { ast } or { unsupported: reason }. Exported for tests and the model-driven host. */
export function parseCalculatedFormula(text) {
  if (!text || !String(text).trim()) return { unsupported: "The column has no FormulaDefinition." };
  try {
    let root = parseSolutionXml(text);
    if (localName(root.name) === "formula") {
      const inner = elements(root);
      if (inner.length !== 1) unsupported("<Formula> holds exactly one expression.");
      root = inner[0];
    }
    return { ast: parseNode(root) };
  } catch (error) {
    return { unsupported: error instanceof Unsupported ? error.message : `The FormulaDefinition is not readable XML: ${error.message}` };
  }
}

// ---- Evaluator

const asNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (isExactNumeric(value)) return value;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(number)) unsupported(`'${value}' is not a number.`);
  return number;
};
const asDate = (value) => {
  if (value === null || value === undefined) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) unsupported(`'${value}' is not a date.`);
  return new Date(time);
};
const comparable = (value) => {
  if (value === null || value === undefined) return null;
  if (isExactNumeric(value)) return value;
  if (typeof value === "object") return refId(value) == null ? null : String(refId(value)).toLowerCase();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}/.test(value)) return Date.parse(value);
  return value;
};
function compare(kind, left, right) {
  const a = comparable(left), b = comparable(right);
  // Numbers compare by their exact decimal digits (store exact-numeric values included).
  if ([a, b].every((value) => typeof value === "number" || isExactNumeric(value)) && [a, b].some(isExactNumeric)) {
    const order = compareNumeric(a, b);
    return { equal: order === 0, notequal: order !== 0, greaterthan: order > 0, greaterequal: order >= 0, lessthan: order < 0, lessequal: order <= 0 }[kind];
  }
  if (kind === "equal") return a === b;
  if (kind === "notequal") return a !== b;
  if (a === null || b === null) return false;
  if (kind === "greaterthan") return a > b;
  if (kind === "greaterequal") return a >= b;
  if (kind === "lessthan") return a < b;
  return a <= b;
}
function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}
// Whole units, truncated toward zero; months and years count calendar boundaries. Native DIFFIN* rounding is a guess.
function diff(kind, from, to) {
  const ms = to - from;
  if (kind === "diffindays") return Math.trunc(ms / DAY);
  if (kind === "diffinhours") return Math.trunc(ms / 3_600_000);
  if (kind === "diffinminutes") return Math.trunc(ms / 60_000);
  if (kind === "diffinweeks") return Math.trunc(ms / (7 * DAY));
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
  return kind === "diffinmonths" ? months : Math.trunc(months / 12);
}

// Evaluates an expression against the stored row; ctx.related(lookup) is the parent row or null. Null in arithmetic and dates
// yields null (no guessed zero). Divide by zero yields null.
function evaluate(node, row, ctx) {
  const { kind } = node;
  if (kind === "constant") return node.value;
  if (kind === "field") return row[node.column] ?? null;
  if (kind === "parent") return ctx.related(node.lookup)?.[node.column] ?? null;
  if (kind === "if") {
    const [condition, then, otherwise] = node.args;
    return evaluate(condition, row, ctx) === true ? evaluate(then, row, ctx) : otherwise ? evaluate(otherwise, row, ctx) : null;
  }
  if (kind === "and") return node.args.every((arg) => evaluate(arg, row, ctx) === true);
  if (kind === "or") return node.args.some((arg) => evaluate(arg, row, ctx) === true);
  const values = node.args.map((arg) => evaluate(arg, row, ctx));
  if (kind === "not") return values[0] !== true;
  if (kind === "isnull") return values[0] === null || values[0] === undefined || values[0] === "";
  if (kind === "concat") return values.map((value) => (value === null || value === undefined ? "" : typeof value === "object" ? String(value.name ?? refId(value) ?? "") : String(value))).join("");
  if (kind in { equal: 1, notequal: 1, greaterthan: 1, greaterequal: 1, lessthan: 1, lessequal: 1 }) return compare(kind, values[0], values[1]);
  if (kind.startsWith("add") && kind !== "add") {
    const date = asDate(values[0]), amount = asNumber(values[1]);
    if (date === null || amount === null) return null;
    if (kind === "addmonths") return addMonths(date, Math.trunc(amount)).toISOString();
    if (kind === "addyears") return addMonths(date, Math.trunc(amount) * 12).toISOString();
    const unit = { adddays: DAY, addhours: 3_600_000, addweeks: 7 * DAY }[kind];
    return new Date(date.getTime() + amount * unit).toISOString();
  }
  if (kind.startsWith("diffin")) {
    const from = asDate(values[0]), to = asDate(values[1]);
    return from === null || to === null ? null : diff(kind, from, to);
  }
  const numbers = values.map(asNumber);
  if (numbers.includes(null)) return null;
  // Exact decimal arithmetic (power-fx.mjs decimalArithmetic over exact-numeric.mjs); divide by zero is null.
  if (kind === "add") return numbers.reduce((a, b) => decimalArithmetic("+", a, b));
  if (kind === "subtract") return decimalArithmetic("-", numbers[0], numbers[1]);
  if (kind === "multiply") return numbers.reduce((a, b) => decimalArithmetic("*", a, b));
  const quotient = decimalArithmetic("/", numbers[0], numbers[1]);
  return quotient instanceof FxError ? null : quotient;
}

// ---- Pack export

/** Validates a pack's calculatedColumns export: '<table>.<column>' keys mapping to synchronous functions. Returns the map. */
export function validateCalculatedColumns(map) {
  if (map === undefined) return {};
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new TypeError("calculatedColumns must map '<table>.<column>' to functions.");
  const result = {};
  for (const [key, fn] of Object.entries(map)) {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(key)) throw new TypeError(`calculatedColumns key '${key}' must be '<table>.<column>'.`);
    if (typeof fn !== "function" || fn.constructor?.name === "AsyncFunction") throw new TypeError(`calculatedColumns['${key}'] must be a synchronous function (row, ctx) => value.`);
    result[key.toLowerCase()] = fn;
  }
  return result;
}

// ---- Extension

// The native refusal of a value for a calculated column (IsValidForCreate/IsValidForUpdate are false) is not known; the
// payload reader's invalid-property shape (0x80048d19) stands in.
const writeRefused = (mapping, column) => new DataError(
  `The attribute '${column}' of entity '${mapping.logicalName}' is a calculated field and cannot be set.`,
  400,
  "InvalidRequest",
  { innerCode: "0x80048d19" },
);

const states = new WeakMap();

function stateOf(api) {
  if (!states.has(api)) states.set(api, { overrides: {}, reporter: onceReporter(), parsed: new Map(), depth: 0, provider: null });
  return states.get(api);
}

const report = (state, entry) => state.reporter.report(entry, `${entry.code}\u0000${entry.table}\u0000${entry.column}`);

/** The calculated columns of a table as { name: formulaDefinition }. */
function calculatedColumnsOf(api, logical) {
  const definitions = api.store.fieldDefinitions(logical, api.metadataFields) ?? {};
  const result = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const column = facts(definition);
    if (Number(enumValue(column.sourceType ?? column.SourceType)) === CALCULATED) result[name.toLowerCase()] = column.formulaDefinition ?? column.FormulaDefinition ?? "";
  }
  return result;
}

// The parent row as a read copy: its own calculated columns read computed (store.withComputed), never stale.
function storedRow(store, logical, id) {
  if (id === null || id === undefined) return null;
  let mapping;
  try { mapping = store.resolveMapping(logical); } catch { return null; }
  const rows = store.tableRows(mapping.logicalName);
  const row = rows[store.rowIndex(mapping, rows, refId(id))] ?? null;
  return row && store.withComputed(mapping.logicalName, [row])[0];
}

// The parent row behind a lookup column of the row: the lookup's own logical_name first, else the N:1 relationship.
// The platform computes calculated columns itself, so the parent is read without the caller's read privilege (assumed).
function relatedRow(store, mapping, row, lookup) {
  const value = row[lookup];
  if (value === null || value === undefined) return null;
  const target = (typeof value === "object" && value.logical_name)
    || Object.values(mapping.relationships ?? {}).find((rel) => rel.many === false && rel.from === lookup)?.entity;
  return target ? storedRow(store, target, value) : null;
}

// row is the read copy: a chained calculated column reads computed (a column reading itself reads null).
function computeColumn(api, state, c, mapping, row, column, formula) {
  const table = mapping.logicalName;
  // A copy of the parent row: a pack function cannot mutate the stored row outside the write journal.
  const ctx = { table, column, user: c.user ?? null, related: (lookup) => structuredClone(relatedRow(api.store, mapping, row, lookup)) };
  const override = state.overrides[`${table}.${column}`];
  if (override) {
    const value = override(structuredClone(row), ctx);
    if (!isThenable(value)) return value ?? null;
    report(state, { code: "CALCULATED_UNSUPPORTED", table, column, message: "The pack calculatedColumns function returned a promise; calculated columns are computed synchronously." });
    return null;
  }
  const key = `${table}.${column}\u0000${formula}`;
  if (!state.parsed.has(key)) state.parsed.set(key, parseCalculatedFormula(formula));
  const parsed = state.parsed.get(key);
  // A chain of calculated columns is at most 5 deep.
  if (state.depth >= MAX_CHAIN) {
    report(state, { code: "CALCULATED_UNSUPPORTED", table, column, message: `The column is calculated through more than ${MAX_CHAIN} chained calculated columns. The column reads as null.` });
    return null;
  }
  state.depth++;
  try {
    if (parsed.unsupported) unsupported(parsed.unsupported);
    return evaluate(parsed.ast, row, ctx) ?? null;
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    report(state, { code: "CALCULATED_UNSUPPORTED", table, column, message: `${error.message} The column reads as null; supply a pack calculatedColumns['${table}.${column}'] function.` });
    return null;
  } finally {
    state.depth--;
  }
}

// Sorting is disabled on a calculated column that references a parent
// column or another calculated column (the subset has no Now() or logical-column node); such an order is ignored.
function sortable(api, state, logical, column) {
  const calculated = calculatedColumnsOf(api, logical);
  const key = `${logical}.${column}\u0000${calculated[column]}`;
  if (!state.parsed.has(key)) state.parsed.set(key, parseCalculatedFormula(calculated[column]));
  const { ast } = state.parsed.get(key);
  const blocked = (node) => node.kind === "parent" || (node.kind === "field" && Object.hasOwn(calculated, node.column)) || (node.args ?? []).some(blocked);
  return !ast || !blocked(ast);
}

/**
 * install(api, { calculatedColumns, diagnostic }): calculatedColumns is the pack export (validateCalculatedColumns), diagnostic
 * receives each diagnostic once. Exposes api.calculatedColumns = { columnsOf(table), compute(table, row), diagnostics(), describe() }.
 */
function install(api, options = {}) {
  const state = stateOf(api);
  state.overrides = validateCalculatedColumns(options.calculatedColumns ?? packOverrides(api, "calculatedColumns"));
  state.reporter = onceReporter(options.diagnostic ?? api.diagnostic ?? null);
  api.calculatedColumns = {
    columnsOf: (table) => calculatedColumnsOf(api, table),
    compute(table, row, c = {}) {
      const mapping = api.store.resolveMapping(table);
      return Object.fromEntries(Object.entries(calculatedColumnsOf(api, mapping.logicalName)).map(([column, formula]) => [column, computeColumn(api, state, c, mapping, row, column, formula)]));
    },
    diagnostics: () => [...state.reporter.diagnostics],
    describe: () => describe(api),
  };
  // One computed-value source for every read (store.setComputedColumns): Web API, FetchXML, $filter, $orderby, $apply,
  // the property route and the portal read the computed value; the platform computes it, so the pack ctx.user is null.
  state.provider = {
    columnsOf: (logical) => Object.keys(calculatedColumnsOf(api, logical)),
    compute: (logical, column, { row }) => {
      const mapping = api.store.resolveMapping(logical);
      return computeColumn(api, state, {}, mapping, row, column, calculatedColumnsOf(api, logical)[column]);
    },
    sortable: (logical, column) => sortable(api, state, logical, column),
  };
  api.store.setComputedColumns("dataverse-calculated", state.provider);
  api.recordHooks.add("beforeWrite", (c, mapping, { operation, data }) => {
    if (operation === "delete" || !data) return;
    const calculated = calculatedColumnsOf(api, mapping.logicalName);
    const column = Object.keys(data).find((key) => Object.hasOwn(calculated, key.toLowerCase()));
    if (column) throw writeRefused(mapping, column);
  });
}

// Reseed: parsed formulas and the once-per-column diagnostics start again (the metadata may have changed).
function reset(api) {
  const state = stateOf(api);
  state.parsed.clear();
  state.reporter.clear();
  state.depth = 0;
  if (state.provider) api.store.setComputedColumns("dataverse-calculated", state.provider);
}

/** Capability record: contract, or behaviour when the installed api's pack overrides cover every calculated column. */
function describe(api = null) {
  const overrides = api ? states.get(api)?.overrides ?? {} : {};
  const columns = api ? Object.keys(api.store.state.mappings ?? {}).flatMap((table) => Object.keys(calculatedColumnsOf(api, table)).map((column) => `${table}.${column}`)) : [];
  return {
    name: "dataverse-calculated",
    version: 1,
    kind: "dataverse-extension",
    level: columns.length > 0 && columns.every((key) => key in overrides) ? "behaviour" : "contract",
    operations: OPERATIONS,
    requires: ["metadata:FormulaDefinition"],
    principal: "platform",
    stateOwner: "none",
    lifecycle: "per-request",
  };
}

export const EXTENSION = { name: "dataverse-calculated", install, reset, describe };

registerPackExport("calculatedColumns", { key: (key) => key.toLowerCase(), check: packCheck(validateCalculatedColumns) });
