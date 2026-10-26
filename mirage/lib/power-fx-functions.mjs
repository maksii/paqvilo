// The Power Fx function table (power-fx.mjs evaluates; this file answers each function). One entry per function:
// { min, max, fn(fx, ...values) } evaluates its arguments first and lets an error argument flow through (Learn, "Error
// handling": error in, error out); `errors: true` sees error arguments; `lazy: true` receives the argument nodes (If,
// Switch, IfError, record scope functions, behaviour functions that name their target).
// Semantics follow each function's Learn reference page (https://learn.microsoft.com/power-platform/power-fx/reference/).
import {
  decimalParts,
  decimalText,
  exactNumeric,
  isExactNumeric,
  numericPair,
  roundNumeric,
} from './exact-numeric.mjs';
import {
  ALIASES,
  CAUSE,
  FxFloat,
  decimalArithmetic,
  invariantNumberText,
  parseNumber,
  toDecimal,
  ErrorKind,
  FxDataSource,
  FxDate,
  FxError,
  FxGuid,
  FxRecordRef,
  FxUntyped,
  compare,
  equals,
  fieldName,
  formatDate,
  fromWall,
  fxError,
  isBlank,
  isRecord,
  isoOf,
  member,
  readAll,
  round15,
  toBoolean,
  toDate,
  toFx,
  toNumber,
  toText,
  wallOf,
  zoneOffset,
} from './power-fx.mjs';

const DAY = 86_400_000;
const fail = (kind, message) => fxError(ErrorKind[kind], message);
const notHosted = (name) => fail('NotSupported', `${name} is not available in this host.`);
const firstError = (...values) => values.find((value) => value instanceof FxError);

// Infer only result types fixed by syntax, without evaluating an unselected formula or invoking host functions.
// Dynamic names, connector calls and mixed-type arithmetic need a full Power Fx type checker and remain unknown.
function knownResultType(node) {
  if (!node) return null;
  if (node.t === 'lit') {
    if (node.v instanceof FxError && node.v.errors.every((error) => error.Kind === ErrorKind.Numeric)) return 'number';
    if (isExactNumeric(node.v) || typeof node.v === 'number') return 'number';
    if (typeof node.v === 'string') return 'text';
    if (typeof node.v === 'boolean') return 'boolean';
  }
  if (node.t === 'interp') return 'text';
  if (node.t === 'pct' || (node.t === 'unary' && node.op !== '!')) {
    const operand = knownResultType(node.e);
    return operand === 'number' || operand === 'float' ? operand : null;
  }
  if (node.t === 'unary') return 'boolean';
  if (node.t === 'bin') {
    if (node.op === '^') return 'float';
    if (['/', '*'].includes(node.op)) {
      const left = knownResultType(node.l),
        right = knownResultType(node.r);
      if (left === 'float' || right === 'float') return 'float';
      if (left === 'number' && right === 'number') return 'number';
      return null;
    }
    if (node.op === '&') return 'text';
    if (['=', '<>', '<', '<=', '>', '>=', 'in', 'exactin', '&&', '||'].includes(node.op)) return 'boolean';
    if (['+', '-'].includes(node.op) && knownResultType(node.l) === 'number' && knownResultType(node.r) === 'number')
      return 'number';
  }
  if (node.t === 'call') {
    return (
      {
        Text: 'text',
        Value: 'number',
        Decimal: 'number',
        Float: 'float',
        Boolean: 'boolean',
        DateValue: 'date',
        Date: 'date',
        DateTimeValue: 'datetime',
        TimeValue: 'time',
      }[node.name] ?? null
    );
  }
  return null;
}
function coerceIfErrorReplacement(fx, value, type) {
  if (value instanceof FxError || isBlank(value)) return value;
  if (type === 'number') return typeof value === 'string' ? parseNumber(value, fx.language) : toDecimal(value);
  if (type === 'float') return FUNCTIONS.Float.fn(fx, value);
  if (type === 'text') return toText(value, fx);
  if (type === 'boolean') return toBoolean(value);
  if (['date', 'datetime', 'time'].includes(type)) return toDate(value, type, fx);
  fx.warn({
    code: 'POWER_FX_IFERROR_TYPE_UNKNOWN',
    message: 'IfError replacement type could not be determined; coercion was not applied.',
  });
  return value;
}

// ---- Shared helpers

// A table argument's rows: a data source read without delegation (with the warning), an untyped array as Value records.
function rowsOf(fx, value, operation) {
  if (value instanceof FxDataSource) return readAll(fx, value, operation);
  if (value instanceof FxUntyped && Array.isArray(value.raw))
    return value.raw.map((item) => ({ Value: item === null ? null : new FxUntyped(item) }));
  if (Array.isArray(value)) return value;
  if (isBlank(value)) return [];
  return fail('InvalidArgument', `${operation} needs a table.`);
}
// The table argument of a record scope function: its value, the As name and the identifier it was written with.
function tableArg(fx, node) {
  if (node.t === 'as') return { value: fx.ev(node.e), name: node.name, source: node.e.t === 'id' ? node.e.name : null };
  return { value: fx.ev(node), name: null, source: node.t === 'id' ? node.name : null };
}
const inRow = (fx, row, table, fn) => fx.inScope({ record: row, name: table.name, source: table.source }, fn);
// A column name argument: an identifier (Power Fx 1.0) or a text value (earlier syntax).
function columnName(fx, node) {
  if (node.t === 'id') return node.name;
  const value = fx.ev(node);
  return value instanceof FxError ? value : toText(value, fx);
}
const singleColumn = (values) => values.map((value) => ({ Value: value }));
const copyRecord = (record) => {
  const copy = { ...record };
  if (record[ALIASES]) copy[ALIASES] = record[ALIASES];
  return copy;
};
const n = (fx, value) => toNumber(value);
const text = (fx, value) => toText(value, fx);
const integer = (value) => (value instanceof FxError ? value : Math.trunc(value));

// Number functions: the argument converted, an error or blank handled once.
const numeric = (fn, { blank = 'zero' } = {}) => ({
  min: 1,
  max: 1,
  fn: (fx, value) => {
    if (isBlank(value) && blank === 'blank') return null;
    const x = toNumber(value);
    return x instanceof FxError ? x : fn(x);
  },
});
const textual = (fn) => ({
  min: 1,
  max: 1,
  fn: (fx, value) => {
    const t = toText(value, fx);
    return t instanceof FxError ? t : fn(t);
  },
});

// Learn "Round, RoundDown, RoundUp, Int and Trunc": Round half away from zero; RoundUp away from zero; RoundDown and Trunc
// toward zero; Int down. Exponent arithmetic keeps 1.005 at 1.01.
function scaled(x, digits, mode) {
  const sign = x < 0 ? -1 : 1;
  const shift = (v, d) => Number(`${v}e${d}`);
  const abs = shift(round15(Math.abs(x)), digits);
  const whole = mode === 'round' ? Math.round(abs) : mode === 'up' ? Math.ceil(round15(abs)) : Math.floor(round15(abs));
  return sign * shift(whole, -digits) || 0;
}
const rounding = (mode) => ({
  min: 1,
  max: 2,
  fn: (fx, value, digits = 0) => {
    const x = toNumber(value),
      d = toNumber(digits);
    if (x instanceof FxError) return x;
    if (d instanceof FxError) return d;
    // An exact decimal beyond a double's digits rounds exactly (half away from zero).
    if (isExactNumeric(value) && mode === 'round' && d >= 0) return roundNumeric(value, Math.trunc(d), 'Decimal');
    return scaled(x, Math.trunc(d), mode);
  },
});

// ---- Number formatting (Learn "Text function": 0 # , . % placeholders, literal text)

function formatNumber(value, format, language) {
  let separators;
  try {
    if (!Intl.NumberFormat.supportedLocalesOf([language]).length) throw new RangeError();
    separators = new Intl.NumberFormat(language).formatToParts(1234.5);
  } catch {
    return fail('BadLanguageCode', `Language code '${language}' not supported.`);
  }
  const group = separators.find((part) => part.type === 'group')?.value ?? ',';
  const decimal = separators.find((part) => part.type === 'decimal')?.value ?? '.';
  const fmt = String(format).replace(/^\[\$-[^\]]*\]/, '');
  const parts = [...fmt.matchAll(/"([^"]*)"|\\(.)|([0#,.])|(.)/gs)].map((m) =>
    m[3] !== undefined ? { p: m[3] } : { t: m[1] ?? m[2] ?? m[4] },
  );
  const first = parts.findIndex((part) => part.p && part.p !== ',' && part.p !== '.');
  if (first < 0) return parts.map((part) => part.t ?? part.p).join('');
  let last = parts.length - 1;
  while (!parts[last].p || parts[last].p === ',') last--;
  const pattern = parts
    .slice(first, last + 1)
    .map((part) => part.p ?? '')
    .join('');
  const prefix = parts
    .slice(0, first)
    .map((part) => part.t ?? part.p)
    .join('');
  const suffix = parts
    .slice(last + 1)
    .map((part) => part.t ?? part.p)
    .join('');
  const percent = (prefix + suffix).includes('%');
  const [intPattern, decPattern = ''] = pattern.split('.');
  const decimals = (decPattern.match(/[0#]/g) ?? []).length;
  const minDecimals = (decPattern.match(/0/g) ?? []).length;
  const minInt = (intPattern.match(/0/g) ?? []).length;
  // Power Fx formats decimal digits without converting an exact Decimal to a double.
  // Float formatting uses the platform's 15-significant-digit decimal presentation.
  const input = value instanceof FxFloat ? round15(value.value) : value;
  const partsValue = decimalParts(input);
  let coefficient = partsValue.coefficient;
  let scale = partsValue.scale - (percent ? 2 : 0);
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  const negative = coefficient < 0n;
  let magnitude = negative ? -coefficient : coefficient;
  if (scale > decimals) {
    const divisor = 10n ** BigInt(scale - decimals);
    magnitude = magnitude / divisor + ((magnitude % divisor) * 2n >= divisor ? 1n : 0n);
  } else magnitude *= 10n ** BigInt(decimals - scale);
  const digits = magnitude.toString().padStart(decimals + 1, '0');
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals) : '';
  let intText = whole === '0' && minInt === 0 ? '' : whole.padStart(minInt, '0');
  if (intPattern.includes(',')) intText = intText.replace(/\B(?=(\d{3})+(?!\d))/g, () => group);
  let decText = fraction;
  while (decText.length > minDecimals && decText.endsWith('0')) decText = decText.slice(0, -1);
  const body = intText + (decText || (pattern.includes('.') && minDecimals) ? `${decimal}${decText}` : '');
  return `${negative && magnitude !== 0n ? '-' : ''}${prefix}${body}${suffix}`;
}

// ---- Dates (Learn "DateAdd, DateDiff", "Day, Month, Year, Hour, Minute, Second, and Weekday", "WeekNum and ISOWeekNum") --

const partsOf = (fx, date) => new Date(wallOf(date, fx.timeZone));
const datePart = (get) => ({
  min: 1,
  max: 1,
  fn: (fx, value) => {
    if (isBlank(value)) return null;
    const date = toDate(value, 'any', fx);
    return date instanceof FxError ? date : get(partsOf(fx, date));
  },
});
const UNITS = { milliseconds: 1, seconds: 1000, minutes: 60_000, hours: 3_600_000, days: DAY };
function unitOf(value) {
  const unit = String(value ?? 'Days').toLowerCase();
  if (UNITS[unit] || ['months', 'quarters', 'years'].includes(unit)) return unit;
  return fail('InvalidArgument', `'${value}' is not a TimeUnit.`);
}
function addMonths(wall, months) {
  const d = new Date(wall);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}
// Excel WEEKDAY return types, which StartOfWeek mirrors: 1 Sunday=1, 2 Monday=1, 3 Monday=0, 11..17 Monday..Sunday=1.
function weekday(day, type) {
  if (type === 1) return day + 1;
  if (type === 2) return ((day + 6) % 7) + 1;
  if (type === 3) return (day + 6) % 7;
  if (type >= 11 && type <= 17) return ((day - (type - 10) + 7) % 7) + 1;
  return null;
}
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
}

// ---- Regular expressions (Learn "IsMatch, Match, and MatchAll")

// The JavaScript engine runs the pattern (with the u flag); Learn's Power Fx dialect blocks some constructs at
// authoring time, which are not refused here.
function regexOf(fx, pattern, options, fallback) {
  const opts = String(options ?? fallback);
  let source = String(pattern);
  if (opts.includes('x'))
    source = source
      .replace(/\\#/g, '\u0000')
      .replace(/#[^\n]*/g, '')
      .replace(/\s+/g, '')
      // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
      .replace(/\u0000/g, '\\#');
  const begins = opts.includes('^c'),
    ends = opts.includes('c$');
  source = `${begins ? '^' : ''}(?:${source})${ends ? '$' : ''}`;
  const flags = `u${opts.includes('i') ? 'i' : ''}${opts.includes('m') ? 'm' : ''}${opts.includes('s') ? 's' : ''}`;
  try {
    return { re: new RegExp(source, flags), numbered: opts.includes('N') };
  } catch (error) {
    return { error: fail('BadRegex', `Invalid regular expression: ${error.message}`) };
  }
}
const isMatchDefault = (fx) => (fx.host.app === 'canvas' ? '^c$' : 'c');
function matchRecord(match, numbered) {
  const record = {
    ...Object.fromEntries(Object.entries(match.groups ?? {}).map(([key, value]) => [key, value ?? null])),
  };
  record.FullMatch = match[0];
  record.StartMatch = match.index + 1;
  if (numbered) record.SubMatches = singleColumn(match.slice(1).map((value) => value ?? null));
  return record;
}

// ---- JSON (Learn "JSON function", "ParseJSON function")

function jsonOf(fx, value, flatten) {
  if (isBlank(value)) return null;
  if (value instanceof FxError) throw value;
  if (value instanceof FxDate) return value.kind === 'datetime' ? new Date(value.ms).toISOString() : isoOf(value);
  if (value instanceof FxGuid) return value.value;
  if (value instanceof FxUntyped) return value.raw;
  if (value instanceof FxFloat) return value.value;
  if (isExactNumeric(value)) return JSON.rawJSON(toText(value));
  if (value instanceof FxRecordRef) return jsonOf(fx, value.record, flatten);
  if (value instanceof FxDataSource) return jsonOf(fx, readAll(fx, value, 'JSON'), flatten);
  if (Array.isArray(value)) {
    const single = flatten && value.every((row) => isRecord(row) && Object.keys(row).length === 1 && 'Value' in row);
    return value.map((row) => (single ? jsonOf(fx, row.Value, flatten) : jsonOf(fx, row, flatten)));
  }
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonOf(fx, item, flatten)]));
  if (typeof value === 'number' && !Number.isFinite(value))
    throw fail('InvalidArgument', 'JSON cannot serialize a non-finite number.');
  return value;
}

// ---- Delegation (Learn "Connect to Microsoft Dataverse": Power Apps delegable functions and operations for Dataverse)

const ODATA_OP = { '=': 'eq', '<>': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
const SWAPPED = { '=': '=', '<>': '<>', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
const ORDERED = new Set(['number', 'text', 'datetime', 'date']); // <, <=, >, >= (not Choice, not Guid)

// True when node reads the row being filtered (ThisRecord, the As name or a bare column name).
function readsRow(node, source, asName) {
  if (!node || typeof node !== 'object') return false;
  if (node.t === 'id' && !node.global)
    return node.name === 'ThisRecord' || node.name === asName || source.adapter.column(node.name) !== null;
  if (node.t === 'disamb') return true;
  return Object.values(node).some((value) =>
    Array.isArray(value)
      ? value.some((item) => readsRow(Array.isArray(item) ? item[1] : (item?.node ?? item), source, asName))
      : readsRow(value, source, asName),
  );
}
// The column a node names directly: `Col`, `ThisRecord.Col` or `<AsName>.Col`.
function columnRef(node, source, asName) {
  if (node.t === 'id' && !node.global && node.name !== 'ThisRecord' && node.name !== asName)
    return source.adapter.column(node.name);
  if (node.t === 'dot' && node.obj.t === 'id' && (node.obj.name === 'ThisRecord' || node.obj.name === asName))
    return source.adapter.column(node.name);
  return null;
}
// Learn (Dataverse delegation, note 3): DateTime is delegable except for the Now() and Today() functions.
const VOLATILE = new Set(['Now', 'Today', 'UTCNow', 'UTCToday', 'IsToday', 'IsUTCToday']);
const callsVolatile = (node) =>
  Boolean(node && typeof node === 'object') &&
  ((node.t === 'call' && VOLATILE.has(node.name)) ||
    Object.values(node).some((value) =>
      Array.isArray(value)
        ? value.some((item) => callsVolatile(Array.isArray(item) ? item[1] : (item?.node ?? item)))
        : callsVolatile(value),
    ));
// A row-independent operand evaluated in the outer scope; undefined when it cannot serve as a literal.
function constantOf(fx, node, source, asName) {
  if (readsRow(node, source, asName) || callsVolatile(node)) return undefined;
  const value = fx.ev(node);
  return value instanceof FxError ? undefined : value;
}
// A text column or a delegable text function of one (Learn Dataverse delegation, note 2: Left, Mid, Right, Upper, Lower,
// Replace and Substitute are supported; Trim, TrimEnds and Len are not). The store answers them in its extended OData
// dialect (toupper, tolower, substring, concat, right, replace).
function textExpr(fx, node, source, asName) {
  const column = columnRef(node, source, asName);
  if (column || node.t !== 'call' || !node.args.length) return column;
  const inner = textExpr(fx, node.args[0], source, asName);
  if (!inner || inner.type !== 'text') return null;
  const whole = (i) => {
    const value = node.args[i] ? constantOf(fx, node.args[i], source, asName) : undefined;
    const x = value === undefined ? NaN : toNumber(value);
    return Number.isInteger(x) && x >= 0 ? x : null;
  };
  const quoted = (text) => `'${text.replace(/'/g, "''")}'`;
  const of = (odata) => ({ ...inner, odata });
  switch (node.name) {
    case 'Upper':
      return node.args.length === 1 ? of(`toupper(${inner.odata})`) : null;
    case 'Lower':
      return node.args.length === 1 ? of(`tolower(${inner.odata})`) : null;
    case 'Right': {
      const count = whole(1);
      return count === null ? null : of(`right(${inner.odata},${count})`);
    }
    case 'Substitute': {
      if (node.args.length !== 3) return null; // an instance argument stays in memory
      const [from, to] = [1, 2]
        .map((i) => constantOf(fx, node.args[i], source, asName))
        .map((value) => (value === undefined ? null : toText(value, fx)));
      return typeof from === 'string' && typeof to === 'string'
        ? of(`replace(${inner.odata},${quoted(from)},${quoted(to)})`)
        : null;
    }
    case 'Left': {
      const count = whole(1);
      return count === null ? null : of(`substring(${inner.odata},0,${count})`);
    }
    case 'Mid': {
      const start = whole(1),
        count = node.args.length > 2 ? whole(2) : undefined;
      return !start || count === null
        ? null
        : of(`substring(${inner.odata},${start - 1}${count === undefined ? '' : `,${count}`})`);
    }
    case 'Replace': {
      const start = whole(1),
        count = whole(2),
        value = node.args[3] ? constantOf(fx, node.args[3], source, asName) : undefined;
      const text = value === undefined ? null : toText(value, fx);
      if (!start || count === null || typeof text !== 'string') return null;
      return of(
        `concat(concat(substring(${inner.odata},0,${start - 1}),${quoted(text)}),substring(${inner.odata},${start - 1 + count}))`,
      );
    }
    default:
      return null;
  }
}
// One predicate as an OData $filter clause: a string, true or false for a constant predicate, null when not delegable.
function delegate(fx, source, node, asName) {
  if (!readsRow(node, source, asName)) {
    const value = fx.ev(node);
    if (value instanceof FxError) return null;
    const b = toBoolean(value);
    return b instanceof FxError ? null : b;
  }
  const clause = (inner) => (inner === null || typeof inner === 'boolean' ? null : inner);
  if (node.t === 'bin' && (node.op === '&&' || node.op === '||')) {
    const l = clause(delegate(fx, source, node.l, asName)),
      r = clause(delegate(fx, source, node.r, asName));
    return l && r ? `(${l} ${node.op === '&&' ? 'and' : 'or'} ${r})` : null;
  }
  if ((node.t === 'unary' && node.op === '!') || (node.t === 'call' && node.name === 'Not' && node.args.length === 1)) {
    const inner = clause(delegate(fx, source, node.e ?? node.args[0], asName));
    return inner ? `not (${inner})` : null;
  }
  if (node.t === 'bin' && ODATA_OP[node.op]) {
    let column = textExpr(fx, node.l, source, asName),
      other = node.r,
      op = node.op;
    if (!column) {
      column = textExpr(fx, node.r, source, asName);
      other = node.l;
      op = SWAPPED[node.op];
    }
    if (!column || (!['=', '<>'].includes(op) && !ORDERED.has(column.type))) return null;
    const value = constantOf(fx, other, source, asName);
    if (value === undefined) return null;
    const literal = source.adapter.literal(column, value);
    return literal === null ? null : `${column.odata} ${ODATA_OP[op]} ${literal}`;
  }
  if (node.t === 'call' && node.name === 'IsBlank' && node.args.length === 1) {
    const column = columnRef(node.args[0], source, asName);
    return column && column.type !== 'choice' ? `${column.odata} eq null` : null;
  }
  if (node.t === 'call' && node.name === 'StartsWith' && node.args.length === 2) {
    const column = columnRef(node.args[0], source, asName);
    const value = column?.type === 'text' ? constantOf(fx, node.args[1], source, asName) : undefined;
    return value === undefined
      ? null
      : `startswith(${column.odata},${source.adapter.literal(column, toText(value, fx))})`;
  }
  if (node.t === 'bin' && node.op === 'in') {
    const column = columnRef(node.r, source, asName);
    if (column?.type === 'text') {
      // substring: "x" in Col
      const value = constantOf(fx, node.l, source, asName);
      return value === undefined
        ? null
        : `contains(${column.odata},${source.adapter.literal(column, toText(value, fx))})`;
    }
    const member = columnRef(node.l, source, asName); // membership: Col in [a, b]
    const list = member ? constantOf(fx, node.r, source, asName) : undefined;
    if (!Array.isArray(list) || !list.length) return null;
    const literals = list.map((row) => source.adapter.literal(member, isRecord(row) ? Object.values(row)[0] : row));
    return literals.includes(null)
      ? null
      : `(${literals.map((literal) => `${member.odata} eq ${literal}`).join(' or ')})`;
  }
  return null;
}
// Filter over a data source: delegated when every predicate translates, else read up to the row limit and filtered here.
function filterSource(fx, source, preds, asName, _name) {
  const clauses = preds.map((pred) => delegate(fx, source, pred, asName));
  if (clauses.every((clause) => clause !== null)) {
    if (clauses.includes(false)) return [];
    const filters = clauses.filter((clause) => typeof clause === 'string');
    const extended =
      source.query.extended ||
      filters.some((clause) => /(toupper|tolower|substring|concat|right|replace)\(/.test(clause));
    return source.with({ filters: [...source.query.filters, ...filters], extended });
  }
  return null;
}
// The column a Sort/aggregate formula names, for delegation; null when it is an expression.
const plainColumn = (node, source, asName) => (source instanceof FxDataSource ? columnRef(node, source, asName) : null);

function filterRows(fx, table, rows, preds) {
  const out = [];
  for (const row of rows) {
    let keep = true;
    for (const pred of preds) {
      const value = inRow(fx, row, table, () => fx.ev(pred));
      if (value instanceof FxError) {
        out.push(value);
        keep = false;
        break;
      } // Learn: the record becomes an error record
      const b = toBoolean(value);
      if (b instanceof FxError) {
        out.push(b);
        keep = false;
        break;
      }
      if (!b) {
        keep = false;
        break;
      }
    }
    if (keep) out.push(row);
  }
  return out;
}

// ---- Aggregates (Learn "Average, Max, Min, StdevP, Sum, and VarP")

function aggregate(name, reduce) {
  return {
    min: 1,
    lazy: true,
    fn(fx, args) {
      let values;
      const first = tableArg(fx, args[0]);
      if (first.value instanceof FxError) return first.value;
      const isTableForm = args.length === 2 && (Array.isArray(first.value) || first.value instanceof FxDataSource);
      if (isTableForm) {
        const column = plainColumn(args[1], first.value, first.name);
        // Learn: Sum, Min, Max, Avg delegate for Number columns; the delegated read has no row limit.
        const rows =
          column && column.type === 'number'
            ? first.value.adapter.read({ ...first.value.query, top: first.value.query.top })
            : rowsOf(fx, first.value, name);
        if (rows instanceof FxError) return rows;
        values = rows.map((row) => inRow(fx, row, first, () => fx.ev(args[1])));
      } else values = [first.value, ...args.slice(1).map((arg) => fx.ev(arg))];
      const error = firstError(...values);
      if (error) return error;
      return reduce(
        fx,
        values.filter((value) => !isBlank(value)),
      );
    },
  };
}
// Sum of numeric values: exact decimals, or a float when any value is a float.
function total(values) {
  const list = values.map(toDecimal);
  const error = firstError(...list);
  if (error) return error;
  if (values.some((value) => value instanceof FxFloat)) return new FxFloat(list.reduce((a, b) => a + toNumber(b), 0));
  return list.reduce((sum, value) => decimalArithmetic('+', sum, value), 0);
}
// The language number text is read in: the LanguageTag argument, else the user's language (Language()).
const numberLanguage = (fx, language) => (typeof language === 'string' && language ? language : fx.language);
// Value / Decimal: text parses to an exact decimal; a float becomes its decimal digits.
function asDecimal(value, language) {
  if (typeof value === 'string') return parseNumber(value, language);
  if (value instanceof FxFloat) return value.value;
  return isExactNumeric(value) ? value : toNumber(value);
}

// ---- Data writes (Learn "Patch", "Collect, Clear, and ClearCollect", "Remove and RemoveIf", "Set", "UpdateContext")

// The target of Collect, ClearCollect, Clear, Remove: a data source, a collection (an array in host.variables) or, for a
// name nothing holds yet, a new collection when the host keeps variables.
function collectionTarget(fx, node, create) {
  if (node.t === 'id') {
    try {
      const value = fx.ev(node);
      if (value instanceof FxDataSource || Array.isArray(value)) return { value, name: node.name };
      return { error: fail('InvalidArgument', `'${node.name}' is not a table or collection.`) };
    } catch (error) {
      if (error.code !== 'PowerFxNameUnknown' || !create || !fx.host.variables) throw error;
      fx.host.variables[node.name] = [];
      return { value: fx.host.variables[node.name], name: node.name };
    }
  }
  const value = fx.ev(node);
  return value instanceof FxDataSource || Array.isArray(value)
    ? { value }
    : { error: fail('InvalidArgument', 'The first argument must be a table or collection.') };
}
const recordsOf = (values) =>
  values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => (isRecord(value) ? value : { Value: value }));
const merged = (records) =>
  records.reduce((out, record) => {
    const next = copyRecord(out);
    for (const [key, value] of Object.entries(record ?? {})) next[fieldName(out, key)] = value;
    return next;
  }, {});
const sameRow = (a, b) => a === b || equals(a, b);
function guarded(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof FxError) return error;
    // A data source refusal (403, 404, 400...) becomes an error value with the kind the adapter names.
    if (error?.status) {
      const record = {
        Kind: ErrorKind[error.powerFxKind] ?? (error.status === 404 ? ErrorKind.NotFound : ErrorKind.Sync),
        Message: error.message,
        Details: { HttpStatusCode: error.status },
      };
      Object.defineProperty(record, CAUSE, { value: error });
      return new FxError([record]);
    }
    throw error;
  }
}

// ---- The table

export const FUNCTIONS = {
  // Logical (Learn "And, Or, and Not", "If and Switch", "IfError")
  And: {
    min: 1,
    lazy: true,
    fn: (fx, args) => {
      for (const arg of args) {
        const b = toBoolean(fx.ev(arg));
        if (b instanceof FxError || !b) return b;
      }
      return true;
    },
  },
  Or: {
    min: 1,
    lazy: true,
    fn: (fx, args) => {
      for (const arg of args) {
        const b = toBoolean(fx.ev(arg));
        if (b instanceof FxError || b) return b;
      }
      return false;
    },
  },
  Not: {
    min: 1,
    max: 1,
    fn: (fx, value) => {
      const b = toBoolean(value);
      return b instanceof FxError ? b : !b;
    },
  },
  If: {
    min: 2,
    lazy: true,
    fn(fx, args) {
      let i = 0;
      for (; i + 1 < args.length; i += 2) {
        const b = toBoolean(fx.ev(args[i]));
        if (b instanceof FxError) return b;
        if (b) return fx.ev(args[i + 1]);
      }
      return i < args.length ? fx.ev(args[i]) : null;
    },
  },
  Switch: {
    min: 3,
    lazy: true,
    fn(fx, args) {
      const value = fx.ev(args[0]);
      if (value instanceof FxError) return value;
      let i = 1;
      for (; i + 1 < args.length; i += 2) {
        const candidate = fx.ev(args[i]);
        if (candidate instanceof FxError) return candidate;
        if (equals(value, candidate, fx)) return fx.ev(args[i + 1]);
      }
      return i < args.length ? fx.ev(args[i]) : null;
    },
  },
  IfError: {
    min: 2,
    lazy: true,
    fn(fx, args) {
      let last = null,
        i = 0;
      for (; i + 1 < args.length; i += 2) {
        last = fx.ev(args[i]);
        if (last instanceof FxError) {
          const all = last.errors.map((error) => ({
            Kind: error.Kind,
            Message: error.Message ?? null,
            Source: error.Source ?? null,
            Observed: error.Observed ?? null,
            Details: error.Details ?? null,
          }));
          const replacement = fx.inScope({ vars: { FirstError: all[0], AllErrors: all } }, () => fx.ev(args[i + 1]));
          return coerceIfErrorReplacement(fx, replacement, knownResultType(args[i]));
        }
      }
      return i < args.length ? fx.ev(args[i]) : last;
    },
  },
  IsError: { min: 1, max: 1, errors: true, fn: (fx, value) => value instanceof FxError },
  IsBlankOrError: {
    min: 1,
    max: 1,
    errors: true,
    fn: (fx, value) => value instanceof FxError || isBlank(value) || value === '',
  },
  Error: {
    min: 1,
    max: 1,
    errors: true,
    fn(fx, value) {
      if (value instanceof FxError) return value;
      if (isBlank(value) || (Array.isArray(value) && !value.length)) return null;
      // Assumed: Error("text") (used by Learn's low-code plug-in examples) is a Custom error with that message.
      if (typeof value === 'string') return fxError(ErrorKind.Custom, value);
      const records = Array.isArray(value) ? value : [value];
      return new FxError(
        records.map((record) => ({
          ...record,
          Kind: record.Kind ?? ErrorKind.Custom,
          Message: record.Message ?? null,
        })),
      );
    },
  },
  Blank: { min: 0, max: 0, fn: () => null },
  IsBlank: {
    min: 1,
    max: 1,
    fn: (fx, value) =>
      Array.isArray(value)
        ? false
        : isBlank(value) || value === '' || (value instanceof FxUntyped && value.raw === null),
  },
  IsEmpty: {
    min: 1,
    max: 1,
    fn: (fx, value) =>
      value instanceof FxDataSource
        ? value.adapter.read({ ...value.query, top: 1 }).length === 0
        : rowsOf(fx, value, 'IsEmpty').length === 0,
  },
  Coalesce: {
    min: 1,
    lazy: true,
    fn(fx, args) {
      for (const arg of args) {
        const value = fx.ev(arg);
        if (!isBlank(value) && value !== '') return value;
      }
      return null;
    },
  },

  // Numbers (Learn "Abs, Exp, Ln, Power, Sqrt", "Mod", "Round...", "Value, Decimal, Float")
  Abs: numeric(Math.abs),
  // Learn (formula column data types): Float, Sqrt, Ln, Power, Exp and ^ return a float.
  Exp: numeric((x) => new FxFloat(Math.exp(x))),
  Ln: numeric((x) => (x <= 0 ? fail('Numeric', 'Ln needs a positive number.') : new FxFloat(Math.log(x)))),
  Sqrt: numeric((x) => (x < 0 ? fail('Numeric', 'Sqrt needs a non-negative number.') : new FxFloat(Math.sqrt(x)))),
  Power: {
    min: 2,
    max: 2,
    fn: (fx, a, b) => {
      const x = toNumber(a),
        y = toNumber(b);
      if (firstError(x, y)) return firstError(x, y);
      const result = Math.pow(x, y);
      return Number.isFinite(result)
        ? new FxFloat(result)
        : fail('Numeric', 'Invalid operation: the result is not a number.');
    },
  },
  Int: numeric(Math.floor),
  Trunc: rounding('down'),
  Round: rounding('round'),
  RoundUp: rounding('up'),
  RoundDown: rounding('down'),
  Mod: {
    min: 2,
    max: 2,
    fn: (fx, a, b) => {
      const x = toDecimal(a),
        d = toDecimal(b);
      if (firstError(x, d)) return firstError(x, d);
      if (toNumber(d) === 0) return fail('Div0', 'Invalid operation: division by zero.');
      if (a instanceof FxFloat || b instanceof FxFloat)
        return new FxFloat(toNumber(x) - toNumber(d) * Math.floor(toNumber(x) / toNumber(d)));
      // Exact remainder that takes the divisor's sign (Learn example Mod(-3, 2) = 1).
      const pair = numericPair(x, d),
        scale = Math.max(decimalParts(x).scale, decimalParts(d).scale);
      let rest = pair.x % pair.y;
      if (rest !== 0n && rest < 0n !== pair.y < 0n) rest += pair.y;
      return exactNumeric(decimalText({ coefficient: rest, scale }), 'Decimal');
    },
  },
  // Learn "Decimal, Float, and Value functions": text is read in the LanguageTag argument's language, else the user's.
  Value: {
    min: 1,
    max: 2,
    fn: (fx, value, language) =>
      isBlank(value) || value === '' ? null : asDecimal(value, numberLanguage(fx, language)),
  },
  Decimal: {
    min: 1,
    max: 2,
    fn: (fx, value, language) =>
      isBlank(value) || value === '' ? null : asDecimal(value, numberLanguage(fx, language)),
  },
  Float: {
    min: 1,
    max: 2,
    fn(fx, value, language) {
      if (isBlank(value) || value === '') return null;
      if (typeof value === 'string') {
        // Float keeps its own range: Float("1e100") is 1e100 where Decimal("1e100") overflows.
        const parsed = invariantNumberText(value, numberLanguage(fx, language));
        if (parsed instanceof FxError) return parsed;
        const x = Number(parsed.text) / (parsed.percent ? 100 : 1);
        return Number.isFinite(x) ? new FxFloat(x) : fail('Numeric', `The value '${value}' is out of range.`);
      }
      const x = toNumber(value);
      return x instanceof FxError ? x : new FxFloat(x);
    },
  },
  Boolean: { min: 1, max: 1, fn: (fx, value) => (isBlank(value) || value === '' ? null : toBoolean(value)) },
  Sum: aggregate('Sum', (fx, values) => total(values)),
  Average: aggregate('Average', (fx, values) => {
    const sum = total(values);
    if (sum instanceof FxError) return sum;
    if (!values.length) return fail('Div0', 'Average of no values: division by zero.');
    return sum instanceof FxFloat ? new FxFloat(sum.value / values.length) : decimalArithmetic('/', sum, values.length);
  }),
  Max: aggregate('Max', (fx, values) =>
    values.reduce((best, value) => (best === null || compare(value, best, fx) > 0 ? value : best), null),
  ),
  Min: aggregate('Min', (fx, values) =>
    values.reduce((best, value) => (best === null || compare(value, best, fx) < 0 ? value : best), null),
  ),
  Sequence: {
    min: 1,
    max: 3,
    fn(fx, records, start = 1, step = 1) {
      const count = toNumber(records),
        from = toNumber(start),
        by = toNumber(step);
      if (firstError(count, from, by)) return firstError(count, from, by);
      // Learn "Sequence": at most 50,000 records.
      if (count < 0 || count > 50000) return fail('InvalidArgument', 'Sequence needs between 0 and 50,000 records.');
      return Array.from({ length: Math.trunc(count) }, (_, i) => ({ Value: round15(from + i * by) }));
    },
  },

  // Text (Learn "Text", "Concat and Concatenate", "Left, Mid, Right", "Len", "Lower, Upper, Proper", "Trim", "Replace and
  // Substitute", "Find", "Split", "Char", "EndsWith and StartsWith")
  Text: {
    min: 1,
    max: 3,
    fn(fx, value, format, language) {
      if (isBlank(value)) return '';
      if (format === undefined || isBlank(format)) return toText(value, fx);
      const pattern = toText(format, fx);
      if (pattern instanceof FxError) return pattern;
      if (value instanceof FxDate) {
        const date = value;
        if (pattern === 'UTC')
          return new Date(
            date.kind === 'datetime' ? date.ms : fromWall('datetime', date.ms, fx.timeZone).ms,
          ).toISOString();
        return formatDate(date, pattern, fx.timeZone, typeof language === 'string' ? language : fx.language);
      }
      if (typeof value === 'string') return value;
      const x = isExactNumeric(value) || value instanceof FxFloat ? value : toNumber(value);
      return x instanceof FxError ? x : formatNumber(x, pattern, numberLanguage(fx, language));
    },
  },
  Concatenate: {
    min: 1,
    fn(fx, ...values) {
      const length = values.find(Array.isArray)?.length;
      const piece = (value, i) => toText(Array.isArray(value) ? Object.values(value[i] ?? {})[0] : value, fx);
      if (length === undefined) {
        const texts = values.map((value) => piece(value));
        return firstError(...texts) ?? texts.join('');
      }
      // A single-column table argument makes a single-column table result (Learn "Concat and Concatenate").
      return singleColumn(Array.from({ length }, (_, i) => values.map((value) => piece(value, i)).join('')));
    },
  },
  Concat: {
    min: 2,
    max: 3,
    lazy: true,
    fn(fx, args) {
      const table = tableArg(fx, args[0]);
      const rows = rowsOf(fx, table.value, 'Concat');
      if (rows instanceof FxError) return rows;
      const separator = args[2] ? toText(fx.ev(args[2]), fx) : '';
      const texts = rows.map((row) =>
        toText(
          inRow(fx, row, table, () => fx.ev(args[1])),
          fx,
        ),
      );
      return firstError(separator, ...texts) ?? texts.join(separator);
    },
  },
  Len: textual((t) => t.length),
  Lower: textual((t) => t.toLowerCase()),
  Upper: textual((t) => t.toUpperCase()),
  Proper: textual((t) => t.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())),
  Trim: textual((t) => t.replace(/^ +| +$/g, '').replace(/ {2,}/g, ' ')),
  TrimEnds: textual((t) => t.replace(/^ +| +$/g, '')),
  Left: {
    min: 2,
    max: 2,
    fn: (fx, value, count) => {
      const t = text(fx, value),
        c = integer(n(fx, count));
      return firstError(t, c) ?? (c < 0 ? fail('InvalidArgument', 'Left needs a non-negative count.') : t.slice(0, c));
    },
  },
  Right: {
    min: 2,
    max: 2,
    fn: (fx, value, count) => {
      const t = text(fx, value),
        c = integer(n(fx, count));
      return (
        firstError(t, c) ??
        (c < 0 ? fail('InvalidArgument', 'Right needs a non-negative count.') : c === 0 ? '' : t.slice(-c))
      );
    },
  },
  Mid: {
    min: 2,
    max: 3,
    fn(fx, value, start, count) {
      const t = text(fx, value),
        s = integer(n(fx, start)),
        c = count === undefined ? Infinity : integer(n(fx, count));
      if (firstError(t, s, c)) return firstError(t, s, c);
      if (s < 1 || c < 0) return fail('InvalidArgument', 'Mid needs a start of 1 or more and a non-negative count.');
      return t.substr(s - 1, c === Infinity ? undefined : c);
    },
  },
  Replace: {
    min: 4,
    max: 4,
    fn(fx, value, start, count, replacement) {
      const t = text(fx, value),
        s = integer(n(fx, start)),
        c = integer(n(fx, count)),
        r = text(fx, replacement);
      if (firstError(t, s, c, r)) return firstError(t, s, c, r);
      if (s < 1 || c < 0)
        return fail('InvalidArgument', 'Replace needs a start of 1 or more and a non-negative count.');
      return t.slice(0, s - 1) + r + t.slice(s - 1 + c);
    },
  },
  Substitute: {
    min: 3,
    max: 4,
    fn(fx, value, oldText, newText, instance) {
      const t = text(fx, value),
        o = text(fx, oldText),
        r = text(fx, newText);
      if (firstError(t, o, r)) return firstError(t, o, r);
      if (!o) return t;
      if (instance === undefined || isBlank(instance)) return t.split(o).join(r);
      const which = integer(n(fx, instance));
      if (which instanceof FxError) return which;
      if (which < 1) return fail('InvalidArgument', 'Substitute needs an instance of 1 or more.');
      let at = -1;
      for (let i = 0; i < which; i++) {
        at = t.indexOf(o, at + 1);
        if (at < 0) return t;
      }
      return t.slice(0, at) + r + t.slice(at + o.length);
    },
  },
  Find: {
    min: 2,
    max: 3,
    fn(fx, findText, within, start = 1) {
      const f = text(fx, findText),
        w = text(fx, within),
        s = integer(n(fx, start));
      if (firstError(f, w, s)) return firstError(f, w, s);
      if (s < 1 || s > w.length + 1) return fail('InvalidArgument', 'Find needs a start within the text.');
      const at = w.indexOf(f, s - 1);
      return at < 0 ? null : at + 1;
    },
  },
  Split: {
    min: 2,
    max: 2,
    fn: (fx, value, separator) => {
      const t = text(fx, value),
        s = text(fx, separator);
      if (firstError(t, s)) return firstError(t, s);
      return singleColumn(t === '' ? [] : s === '' ? [...t] : t.split(s));
    },
  },
  Char: numeric((x) => String.fromCharCode(Math.trunc(x))),
  StartsWith: {
    min: 2,
    max: 2,
    fn: (fx, value, start) => {
      const t = text(fx, value),
        s = text(fx, start);
      return firstError(t, s) ?? t.toLowerCase().startsWith(s.toLowerCase());
    },
  },
  EndsWith: {
    min: 2,
    max: 2,
    fn: (fx, value, end) => {
      const t = text(fx, value),
        e = text(fx, end);
      return firstError(t, e) ?? t.toLowerCase().endsWith(e.toLowerCase());
    },
  },
  IsMatch: {
    min: 2,
    max: 3,
    fn(fx, value, pattern, options) {
      const { re, error } = regexOf(fx, pattern, options, isMatchDefault(fx));
      if (error) return error;
      const t = text(fx, value);
      return t instanceof FxError ? t : re.test(t);
    },
  },
  Match: {
    min: 2,
    max: 3,
    fn(fx, value, pattern, options) {
      const { re, error, numbered } = regexOf(fx, pattern, options, 'c');
      if (error) return error;
      const t = text(fx, value);
      if (t instanceof FxError) return t;
      const match = re.exec(t);
      return match ? matchRecord(match, numbered) : null;
    },
  },
  MatchAll: {
    min: 2,
    max: 3,
    fn(fx, value, pattern, options) {
      const { re, error, numbered } = regexOf(fx, pattern, options, 'c');
      if (error) return error;
      const t = text(fx, value);
      if (t instanceof FxError) return t;
      return [...t.matchAll(new RegExp(re.source, `${re.flags}g`))].map((match) => matchRecord(match, numbered));
    },
  },
  GUID: {
    min: 0,
    max: 1,
    fn(fx, value) {
      if (value === undefined)
        return new FxGuid(typeof fx.host.guid === 'function' ? fx.host.guid() : crypto.randomUUID());
      const t = text(fx, value);
      if (t instanceof FxError) return t;
      const m = /^\{?([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})\}?$/i.exec(t.trim());
      if (!m) return fail('InvalidArgument', `'${t}' is not a GUID.`);
      const hex = m[1].replace(/-/g, '');
      return new FxGuid(
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
      );
    },
  },
  JSON: {
    min: 1,
    max: 2,
    fn(fx, value, format = '') {
      const options = toText(format, fx);
      if (options instanceof FxError) return options;
      try {
        return JSON.stringify(jsonOf(fx, value, options.includes('_')), null, options.includes('4') ? 4 : undefined);
      } catch (error) {
        if (error instanceof FxError) return error;
        throw error;
      }
    },
  },
  ParseJSON: {
    min: 1,
    max: 1,
    fn(fx, value) {
      if (isBlank(value)) return null;
      try {
        return new FxUntyped(JSON.parse(toText(value, fx)));
      } catch (error) {
        return fail('InvalidJSON', `The text is not valid JSON: ${error.message}`);
      }
    },
  },

  // Dates and times (Learn "Date, DateValue, DateTime, DateTimeValue, Time, TimeValue", "Now, Today, IsToday, UTCNow,
  // UTCToday, IsUTCToday", "DateAdd, DateDiff, TimeZoneOffset", "Day ... Weekday", "WeekNum and ISOWeekNum")
  Now: { min: 0, max: 0, fn: (fx) => new FxDate('datetime', fx.now()) },
  UTCNow: { min: 0, max: 0, fn: (fx) => new FxDate('datetime', fx.now(), true) },
  Today: {
    min: 0,
    max: 0,
    fn: (fx) => fromWall('date', wallOf(new FxDate('datetime', fx.now()), fx.timeZone), fx.timeZone),
  },
  UTCToday: { min: 0, max: 0, fn: (fx) => fromWall('date', fx.now()) },
  IsToday: {
    min: 1,
    max: 1,
    fn(fx, value) {
      if (isBlank(value)) return false;
      const date = toDate(value, 'any', fx);
      if (date instanceof FxError) return date;
      return (
        Math.floor(wallOf(date, fx.timeZone) / DAY) ===
        Math.floor(wallOf(new FxDate('datetime', fx.now()), fx.timeZone) / DAY)
      );
    },
  },
  IsUTCToday: {
    min: 1,
    max: 1,
    fn(fx, value) {
      if (isBlank(value)) return false;
      const date = toDate(value, 'any', fx);
      return date instanceof FxError ? date : Math.floor(date.ms / DAY) === Math.floor(fx.now() / DAY);
    },
  },
  Date: {
    min: 3,
    max: 3,
    fn(fx, y, m, d) {
      const [year, month, day] = [y, m, d].map((value) => integer(toNumber(value)));
      return firstError(year, month, day) ?? new FxDate('date', Date.UTC(year, month - 1, day));
    },
  },
  Time: {
    min: 3,
    max: 4,
    fn(fx, h, m, s, ms = 0) {
      const parts = [h, m, s, ms].map((value) => toNumber(value));
      if (firstError(...parts)) return firstError(...parts);
      const [hour, minute, second, milli] = parts;
      return new FxDate('time', ((((hour * 3600 + minute * 60 + second) * 1000 + milli) % DAY) + DAY) % DAY);
    },
  },
  DateValue: { min: 1, max: 2, fn: (fx, value) => (isBlank(value) || value === '' ? null : toDate(value, 'date', fx)) },
  TimeValue: { min: 1, max: 2, fn: (fx, value) => (isBlank(value) || value === '' ? null : toDate(value, 'time', fx)) },
  DateTimeValue: {
    min: 1,
    max: 2,
    fn: (fx, value) => (isBlank(value) || value === '' ? null : toDate(value, 'datetime', fx)),
  },
  Year: datePart((d) => d.getUTCFullYear()),
  Month: datePart((d) => d.getUTCMonth() + 1),
  Day: datePart((d) => d.getUTCDate()),
  Hour: datePart((d) => d.getUTCHours()),
  Minute: datePart((d) => d.getUTCMinutes()),
  Second: datePart((d) => d.getUTCSeconds()),
  Weekday: {
    min: 1,
    max: 2,
    fn(fx, value, start = 1) {
      if (isBlank(value)) return null;
      const date = toDate(value, 'any', fx),
        type = toNumber(start);
      if (firstError(date, type)) return firstError(date, type);
      return (
        weekday(partsOf(fx, date).getUTCDay(), type) ??
        fail('InvalidArgument', `'${start}' is not a StartOfWeek value.`)
      );
    },
  },
  WeekNum: {
    min: 1,
    max: 2,
    fn(fx, value, start = 1) {
      if (isBlank(value)) return null;
      const date = toDate(value, 'any', fx),
        type = toNumber(start);
      if (firstError(date, type)) return firstError(date, type);
      // Excel WEEKNUM system 1: the week holding January 1 is week 1; weeks begin on the StartOfWeek day.
      const startDay = { 1: 0, 2: 1, 3: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 0 }[type];
      if (startDay === undefined) return fail('InvalidArgument', `'${start}' is not a StartOfWeek value.`);
      const d = partsOf(fx, date);
      const firstDay = Date.UTC(d.getUTCFullYear(), 0, 1);
      const offset = (new Date(firstDay).getUTCDay() - startDay + 7) % 7;
      const dayOfYear = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - firstDay) / DAY);
      return Math.floor((dayOfYear + offset) / 7) + 1;
    },
  },
  ISOWeekNum: datePart(isoWeek),
  DateAdd: {
    min: 2,
    max: 3,
    fn(fx, value, addition, units) {
      if (isBlank(value)) return null;
      const date = toDate(value, 'any', fx),
        amount = toNumber(addition),
        unit = unitOf(units);
      if (firstError(date, amount, unit)) return firstError(date, amount, unit);
      if (UNITS[unit] && unit !== 'days') {
        // Sub-day units add to the instant; a date-only value becomes a date/time at local midnight.
        const base = date.kind === 'date' ? fromWall('datetime', date.ms, fx.timeZone) : date;
        return new FxDate(base.kind, base.ms + amount * UNITS[unit], base.tzi);
      }
      const wall = wallOf(date, fx.timeZone);
      const months = unit === 'months' ? amount : unit === 'quarters' ? amount * 3 : unit === 'years' ? amount * 12 : 0;
      const moved = unit === 'days' ? wall + amount * DAY : addMonths(wall, Math.trunc(months));
      return fromWall(date.kind, moved, fx.timeZone, date.tzi);
    },
  },
  DateDiff: {
    min: 2,
    max: 3,
    fn(fx, startValue, endValue, units) {
      if (isBlank(startValue) || isBlank(endValue)) return null;
      const start = toDate(startValue, 'any', fx),
        end = toDate(endValue, 'any', fx),
        unit = unitOf(units);
      if (firstError(start, end, unit)) return firstError(start, end, unit);
      // Whole units counted between unit boundaries (Learn examples: 09:45 to 10:15:36 is 1 hour, 30 minutes, 1836 seconds).
      const a = wallOf(start, fx.timeZone),
        b = wallOf(end, fx.timeZone);
      if (UNITS[unit] && unit !== 'days') {
        // Sub-day units count elapsed time: a daylight-saving change between two date/times is taken out of the wall clock.
        const shift = start.kind === 'datetime' && end.kind === 'datetime' ? b - end.ms - (a - start.ms) : 0;
        return Math.floor(b / UNITS[unit]) - Math.floor(a / UNITS[unit]) - Math.round(shift / UNITS[unit]);
      }
      if (unit === 'days') return Math.floor(b / DAY) - Math.floor(a / DAY);
      const da = new Date(a),
        db = new Date(b);
      const months = (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + db.getUTCMonth() - da.getUTCMonth();
      if (unit === 'months') return months;
      if (unit === 'quarters')
        return (
          db.getUTCFullYear() * 4 +
          Math.floor(db.getUTCMonth() / 3) -
          (da.getUTCFullYear() * 4 + Math.floor(da.getUTCMonth() / 3))
        );
      return db.getUTCFullYear() - da.getUTCFullYear();
    },
  },
  TimeZoneOffset: {
    min: 0,
    max: 1,
    fn(fx, value) {
      const date = value === undefined ? new FxDate('datetime', fx.now()) : toDate(value, 'datetime', fx);
      if (date instanceof FxError || isBlank(date)) return date;
      // Minutes to add to local time to reach UTC (UTC-8 answers 480).
      return -zoneOffset(date.ms, fx.timeZone) / 60_000;
    },
  },

  // Tables (Learn "Filter, Search, and LookUp", "Sort and SortByColumns", "First, FirstN, Index, Last, and LastN",
  // "CountRows, CountIf", "Distinct", "AddColumns, DropColumns, RenameColumns, and ShowColumns", "ForAll", "Table", "With")
  Filter: {
    min: 2,
    lazy: true,
    fn(fx, args) {
      const table = tableArg(fx, args[0]);
      if (table.value instanceof FxError) return table.value;
      if (table.value instanceof FxDataSource) {
        const delegated = filterSource(fx, table.value, args.slice(1), table.name);
        if (delegated !== null) return delegated;
      }
      const rows = rowsOf(fx, table.value, 'Filter');
      return rows instanceof FxError ? rows : filterRows(fx, table, rows, args.slice(1));
    },
  },
  LookUp: {
    min: 2,
    max: 3,
    lazy: true,
    fn(fx, args) {
      const table = tableArg(fx, args[0]);
      if (table.value instanceof FxError) return table.value;
      let row;
      const delegated =
        table.value instanceof FxDataSource ? filterSource(fx, table.value, [args[1]], table.name) : null;
      if (delegated instanceof FxDataSource) row = delegated.adapter.read({ ...delegated.query, top: 1 })[0] ?? null;
      else if (Array.isArray(delegated)) row = null;
      else {
        const rows = rowsOf(fx, table.value, 'LookUp');
        if (rows instanceof FxError) return rows;
        row = filterRows(fx, table, rows, [args[1]])[0] ?? null;
      }
      if (row === null || row instanceof FxError || args.length < 3) return row;
      return inRow(fx, row, table, () => fx.ev(args[2]));
    },
  },
  Sort: {
    min: 2,
    max: 3,
    lazy: true,
    fn(fx, args) {
      const table = tableArg(fx, args[0]);
      if (table.value instanceof FxError) return table.value;
      const order = args[2] ? toText(fx.ev(args[2]), fx) : 'Ascending';
      if (order instanceof FxError) return order;
      const descending = order.toLowerCase() === 'descending';
      const column = plainColumn(args[1], table.value, table.name);
      if (column && column.type !== 'guid' && column.type !== 'currency')
        return table.value.with({
          orderby: [...table.value.query.orderby, `${column.odata}${descending ? ' desc' : ''}`],
        });
      const rows = rowsOf(fx, table.value, 'Sort');
      if (rows instanceof FxError) return rows;
      const keyed = rows.map((row) => ({ row, key: inRow(fx, row, table, () => fx.ev(args[1])) }));
      const error = firstError(...keyed.map((item) => item.key));
      if (error) return error;
      return sortRows(fx, keyed, [descending]);
    },
  },
  SortByColumns: {
    min: 2,
    lazy: true,
    fn(fx, args) {
      const value = fx.ev(args[0]);
      if (value instanceof FxError) return value;
      // Column arguments are identifiers or text; an order argument is SortOrder.X, "Ascending"/"Descending" or a table.
      const isOrder = (node) => (node.t === 'lit' ? /^(ascending|descending)$/i.test(String(node.v)) : node.t !== 'id');
      const keys = [];
      for (let i = 1; i < args.length; i++) {
        const name = columnName(fx, args[i]);
        if (name instanceof FxError) return name;
        let order = 'Ascending';
        if (i + 1 < args.length && isOrder(args[i + 1])) {
          const orderValue = fx.ev(args[++i]);
          if (orderValue instanceof FxError) return orderValue;
          order = Array.isArray(orderValue) ? orderValue : toText(orderValue, fx);
        }
        keys.push({ name, order });
      }
      if (value instanceof FxDataSource) {
        const columns = keys.map((key) => ({
          key,
          column: typeof key.order === 'string' ? value.adapter.column(key.name) : null,
        }));
        if (columns.every((item) => item.column && item.column.type !== 'guid' && item.column.type !== 'currency'))
          return value.with({
            orderby: [
              ...value.query.orderby,
              ...columns.map(
                (item) => `${item.column.odata}${item.key.order.toLowerCase() === 'descending' ? ' desc' : ''}`,
              ),
            ],
          });
      }
      const rows = rowsOf(fx, value, 'SortByColumns');
      if (rows instanceof FxError) return rows;
      const keyed = rows.map((row) => ({ row, key: keys.map((key) => member(fx, row, key.name)) }));
      return [...keyed]
        .sort((a, b) => {
          for (let k = 0; k < keys.length; k++) {
            const order = keys[k].order;
            let c;
            if (Array.isArray(order)) {
              // a table of values gives the order (Learn SortByColumns, the ordering table form)
              const index = (v) => {
                const i = order.findIndex((row) => equals(Object.values(row)[0], v, fx));
                return i < 0 ? Infinity : i;
              };
              c = index(a.key[k]) - index(b.key[k]);
            } else {
              c = compareKeys(fx, a.key[k], b.key[k]);
              if (String(order).toLowerCase() === 'descending') c = -c;
            }
            if (c) return c;
          }
          return 0;
        })
        .map((item) => item.row);
    },
  },
  First: {
    min: 1,
    max: 1,
    fn: (fx, value) =>
      value instanceof FxDataSource
        ? (value.adapter.read({ ...value.query, top: 1 })[0] ?? null)
        : asRows(fx, value, 'First', (rows) => rows[0] ?? null),
  },
  Last: { min: 1, max: 1, fn: (fx, value) => asRows(fx, value, 'Last', (rows) => rows[rows.length - 1] ?? null) },
  FirstN: {
    min: 1,
    max: 2,
    fn: (fx, value, count = 1) =>
      asRows(fx, value, 'FirstN', (rows) => {
        const c = integer(toNumber(count));
        return c instanceof FxError ? c : rows.slice(0, Math.max(0, c));
      }),
  },
  LastN: {
    min: 1,
    max: 2,
    fn: (fx, value, count = 1) =>
      asRows(fx, value, 'LastN', (rows) => {
        const c = integer(toNumber(count));
        return c instanceof FxError ? c : c <= 0 ? [] : rows.slice(-c);
      }),
  },
  Index: {
    min: 2,
    max: 2,
    fn(fx, value, position) {
      const i = integer(toNumber(position));
      if (i instanceof FxError) return i;
      if (value instanceof FxUntyped) {
        if (!Array.isArray(value.raw)) return fail('InvalidArgument', 'Index needs an array.');
        return i >= 1 && i <= value.raw.length
          ? value.raw[i - 1] === null
            ? null
            : new FxUntyped(value.raw[i - 1])
          : fail('InvalidArgument', `Index ${i} is out of range.`);
      }
      return asRows(fx, value, 'Index', (rows) =>
        i >= 1 && i <= rows.length ? rows[i - 1] : fail('InvalidArgument', `Index ${i} is out of range.`),
      );
    },
  },
  CountRows: {
    min: 1,
    max: 1,
    // Learn: CountRows delegates to Dataverse (note 4: native answers a cached count; this answers the live count).
    fn: (fx, value) =>
      value instanceof FxDataSource
        ? value.adapter.count(value.query)
        : asRows(fx, value, 'CountRows', (rows) => rows.length),
  },
  CountIf: {
    min: 2,
    lazy: true,
    fn(fx, args) {
      const table = tableArg(fx, args[0]);
      if (table.value instanceof FxError) return table.value;
      if (table.value instanceof FxDataSource) {
        const delegated = filterSource(fx, table.value, args.slice(1), table.name);
        if (delegated instanceof FxDataSource) return delegated.adapter.count(delegated.query);
        if (Array.isArray(delegated)) return 0;
      }
      const rows = rowsOf(fx, table.value, 'CountIf');
      if (rows instanceof FxError) return rows;
      const kept = filterRows(fx, table, rows, args.slice(1));
      return firstError(...kept) ?? kept.length;
    },
  },
  Distinct: {
    min: 2,
    max: 2,
    lazy: true,
    fn(fx, args) {
      const table = tableArg(fx, args[0]);
      const rows = rowsOf(fx, table.value, 'Distinct');
      if (rows instanceof FxError) return rows;
      const out = [];
      for (const row of rows) {
        const value = inRow(fx, row, table, () => fx.ev(args[1]));
        if (value instanceof FxError) return value;
        if (!out.some((seen) => equals(seen, value, fx))) out.push(value);
      }
      return singleColumn(out); // Learn: the result column is named Value
    },
  },
  AddColumns: {
    min: 3,
    lazy: true,
    fn(fx, args) {
      const table = tableArg(fx, args[0]);
      const rows = rowsOf(fx, table.value, 'AddColumns');
      if (rows instanceof FxError) return rows;
      const columns = [];
      for (let i = 1; i + 1 < args.length; i += 2) {
        const name = columnName(fx, args[i]);
        if (name instanceof FxError) return name;
        columns.push([name, args[i + 1]]);
      }
      return rows.map((row) => {
        const out = copyRecord(row);
        for (const [name, formula] of columns) out[name] = inRow(fx, row, table, () => fx.ev(formula));
        return out;
      });
    },
  },
  DropColumns: columnsFunction('DropColumns', (row, names) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !names.includes(key))),
  ),
  ShowColumns: columnsFunction('ShowColumns', (row, names) =>
    Object.fromEntries(names.map((name) => [name, row[fieldName(row, name)] ?? null])),
  ),
  RenameColumns: {
    min: 3,
    lazy: true,
    fn(fx, args) {
      const rows = rowsOf(fx, fx.ev(args[0]), 'RenameColumns');
      if (rows instanceof FxError) return rows;
      const pairs = [];
      for (let i = 1; i + 1 < args.length; i += 2) pairs.push([columnName(fx, args[i]), columnName(fx, args[i + 1])]);
      const error = firstError(...pairs.flat());
      if (error) return error;
      return rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            pairs.find(([from]) => fieldName(row, from) === key)?.[1] ?? key,
            value,
          ]),
        ),
      );
    },
  },
  ForAll: {
    min: 2,
    max: 2,
    lazy: true,
    fn(fx, args) {
      const table = tableArg(fx, args[0]);
      if (table.value instanceof FxError) return table.value;
      const rows = rowsOf(fx, table.value, 'ForAll');
      if (rows instanceof FxError) return rows;
      // Learn "ForAll": a blank result adds no record; records stay records, other values go in a Value column.
      const results = rows.map((row) => inRow(fx, row, table, () => fx.ev(args[1]))).filter((value) => !isBlank(value));
      // An element that failed (a refused Patch, an Error()) makes ForAll an error value, so a behaviour formula sees the
      // failure and IfError/IsError still handle it. Assumed: native surfaces such element errors to the caller.
      const failed = results.filter((value) => value instanceof FxError);
      if (failed.length) return new FxError(failed.flatMap((error) => error.errors));
      return results.map((value) => (isRecord(value) ? value : { Value: value }));
    },
  },
  Table: {
    min: 0,
    fn(fx, ...values) {
      if (values.length === 1 && values[0] instanceof FxUntyped) return rowsOf(fx, values[0], 'Table');
      return values.flatMap((value) => (Array.isArray(value) ? value : [isRecord(value) ? value : { Value: value }]));
    },
  },
  With: {
    min: 2,
    max: 2,
    lazy: true,
    fn(fx, args) {
      const record = fx.ev(args[0]);
      if (record instanceof FxError) return record;
      const scope = record instanceof FxUntyped ? record.raw : record;
      if (!isRecord(scope)) return fail('InvalidArgument', 'With needs a record.');
      return fx.inScope({ record: scope, name: null, source: null }, () => fx.ev(args[1]));
    },
  },

  // Behaviour (Learn "Set", "UpdateContext", "Collect, Clear, and ClearCollect", "Patch", "Remove and RemoveIf",
  // "Defaults", "Navigate and Back", "Notify", "Trace")
  Set: {
    min: 2,
    max: 2,
    lazy: true,
    fn(fx, [target, valueNode]) {
      const value = fx.ev(valueNode);
      if (value instanceof FxError) return value;
      if (target.t === 'dot') {
        // Set(Record.Column, value): Learn "Supported functions" for Dataverse functions
        const record = fx.ev(target.obj);
        if (!isRecord(record)) return fail('InvalidArgument', 'Set needs a record to change a column.');
        record[fieldName(record, target.name)] = value;
        return true;
      }
      if (target.t !== 'id') return fail('InvalidArgument', 'Set needs a variable name.');
      // A plug-in's columns are global variables (Learn, low-code plug-ins: "columns are treated as global variables").
      if (fx.host.scope && isRecord(fx.host.scope) && fieldName(fx.host.scope, target.name) in fx.host.scope) {
        fx.host.scope[fieldName(fx.host.scope, target.name)] = value;
        return true;
      }
      if (!fx.host.variables) return notHosted('Set');
      fx.host.variables[target.name] = value;
      return true;
    },
  },
  UpdateContext: {
    min: 1,
    max: 1,
    fn(fx, record) {
      if (!fx.host.context) return notHosted('UpdateContext');
      if (!isRecord(record)) return fail('InvalidArgument', 'UpdateContext needs a record.');
      Object.assign(fx.host.context, record);
      return true;
    },
  },
  Collect: { min: 2, lazy: true, fn: (fx, args) => collect(fx, args, false) },
  ClearCollect: { min: 2, lazy: true, fn: (fx, args) => collect(fx, args, true) },
  Clear: {
    min: 1,
    max: 1,
    lazy: true,
    fn(fx, [node]) {
      const target = collectionTarget(fx, node, false);
      if (target.error) return target.error;
      if (target.value instanceof FxDataSource)
        return fail('NotSupported', 'Clear works on collections, not data sources.');
      target.value.length = 0;
      return true;
    },
  },
  Patch: {
    min: 2,
    lazy: true,
    fn(fx, args) {
      const source = fx.ev(args[0]);
      if (source instanceof FxError) return source;
      const rest = args.slice(1).map((arg) => fx.ev(arg));
      const error = firstError(...rest);
      if (error) return error;
      if (isRecord(source)) return merged([source, ...rest]); // Patch(Record1, Record2, ...) merges
      const [base, ...changes] = rest;
      const update = (row, change) => {
        if (source instanceof FxDataSource) {
          const key = isRecord(row) ? source.adapter.key(row) : null;
          return guarded(() =>
            key ? source.adapter.update(row, change) : source.adapter.create(merged([row ?? {}, change])),
          );
        }
        if (!Array.isArray(source)) return fail('InvalidArgument', 'Patch needs a data source, collection or record.');
        const index = source.findIndex((item) => sameRow(item, row));
        const next = merged([index < 0 ? (row ?? {}) : source[index], change]);
        if (index < 0) source.push(next);
        else source[index] = next;
        return next;
      };
      if (Array.isArray(base))
        return base.map((row, i) =>
          update(row, merged(changes.map((change) => (Array.isArray(change) ? change[i] : change)))),
        );
      return update(base, merged(changes));
    },
  },
  Remove: {
    min: 2,
    lazy: true,
    fn(fx, args) {
      const target = collectionTarget(fx, args[0], false);
      if (target.error) return target.error;
      const values = args.slice(1).map((arg) => fx.ev(arg));
      const error = firstError(...values);
      if (error) return error;
      const all = values.length > 1 && values[values.length - 1] === 'All';
      const records = recordsOf(all || values[values.length - 1] === 'First' ? values.slice(0, -1) : values);
      if (target.value instanceof FxDataSource) {
        for (const record of records) {
          const removed = guarded(() => target.value.adapter.remove(record));
          if (removed instanceof FxError) return removed;
        }
        return null;
      }
      for (const record of records) {
        const index = target.value.findIndex((row) => sameRow(row, record));
        if (index < 0) return fail('NotFound', 'The record to remove was not found.');
        if (all)
          for (let i = target.value.length - 1; i >= 0; i--) {
            if (sameRow(target.value[i], record)) target.value.splice(i, 1);
          }
        else target.value.splice(index, 1);
      }
      return null;
    },
  },
  RemoveIf: {
    min: 2,
    lazy: true,
    fn(fx, args) {
      const target = collectionTarget(fx, args[0], false);
      if (target.error) return target.error;
      const table = { name: args[0].t === 'as' ? args[0].name : null, source: target.name ?? null };
      const rows = rowsOf(fx, target.value, 'RemoveIf');
      const doomed = filterRows(fx, table, rows, args.slice(1));
      const error = firstError(...doomed);
      if (error) return error;
      for (const row of doomed) {
        if (target.value instanceof FxDataSource) {
          const removed = guarded(() => target.value.adapter.remove(row));
          if (removed instanceof FxError) return removed;
        } else target.value.splice(target.value.indexOf(row), 1);
      }
      return null;
    },
  },
  Defaults: { min: 1, max: 1, fn: (fx, value) => (value instanceof FxDataSource ? value.adapter.defaults() : {}) },
  Navigate: {
    min: 1,
    max: 3,
    fn(fx, screen, transition = null, context = null) {
      if (typeof fx.host.navigate !== 'function') return notHosted('Navigate');
      fx.host.navigate(screen, transition, context);
      return true;
    },
  },
  Back: {
    min: 0,
    max: 1,
    fn(fx, transition = null) {
      if (typeof fx.host.back !== 'function') return notHosted('Back');
      // The host answers false when there is no earlier screen.
      return fx.host.back(transition) !== false;
    },
  },
  Notify: {
    min: 1,
    max: 3,
    fn(fx, message, type = 'Information', timeout = 0) {
      if (typeof fx.host.notify !== 'function') return notHosted('Notify');
      const t = toText(message, fx);
      if (t instanceof FxError) return t;
      fx.host.notify(t, toText(type, fx), toNumber(timeout));
      return true;
    },
  },
  Trace: {
    min: 1,
    max: 3,
    fn(fx, message, severity = null, custom = null) {
      const t = toText(message, fx);
      if (t instanceof FxError) return t;
      fx.host.trace?.(t, severity, custom);
      return true;
    },
  },
  Language: { min: 0, max: 0, fn: (fx) => fx.language },
  User: { min: 0, max: 0, fn: (fx) => (isRecord(fx.host.user) ? toFx(fx.host.user) : notHosted('User')) },
};

function asRows(fx, value, operation, fn) {
  const rows = rowsOf(fx, value, operation);
  return rows instanceof FxError ? rows : fn(rows);
}
// Blank first in ascending order. Power Fx's placement of blanks and its text collation are not known; text compares by code
// unit here.
function compareKeys(fx, a, b) {
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b) ? 0 : isBlank(a) ? -1 : 1;
  const c = compare(a, b, fx);
  return c instanceof FxError ? 0 : c;
}
function sortRows(fx, keyed, [descending]) {
  return [...keyed].sort((a, b) => (descending ? -1 : 1) * compareKeys(fx, a.key, b.key)).map((item) => item.row);
}
function columnsFunction(name, project) {
  return {
    min: 2,
    lazy: true,
    fn(fx, args) {
      const rows = rowsOf(fx, fx.ev(args[0]), name);
      if (rows instanceof FxError) return rows;
      const names = args.slice(1).map((arg) => columnName(fx, arg));
      const error = firstError(...names);
      if (error) return error;
      return rows.map((row) =>
        project(
          row,
          names.map((column) => fieldName(row, column)),
        ),
      );
    },
  };
}
// Collect / ClearCollect: a data source creates rows through its adapter (the caller's principal); a collection appends
// copies. Learn ("Collect"): one record argument answers the added record, more answer the table.
function collect(fx, args, clear) {
  const target = collectionTarget(fx, args[0], true);
  if (target.error) return target.error;
  const values = args.slice(1).map((arg) => fx.ev(arg));
  const error = firstError(...values);
  if (error) return error;
  const records = recordsOf(values);
  if (target.value instanceof FxDataSource) {
    if (clear) return fail('NotSupported', 'ClearCollect works on collections, not data sources.');
    const created = [];
    for (const record of records) {
      const row = guarded(() => target.value.adapter.create(record));
      if (row instanceof FxError) return row;
      created.push(row);
    }
    return values.length === 1 && isRecord(values[0]) ? created[0] : created;
  }
  if (clear) target.value.length = 0;
  const added = records.map(copyRecord);
  target.value.push(...added);
  return values.length === 1 && isRecord(values[0]) ? added[0] : target.value;
}
