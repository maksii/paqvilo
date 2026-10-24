// Power Fx interpreter: lexer, parser, typed values and evaluator. The function table lives in power-fx-functions.mjs and the
// Dataverse data sources (delegation through the records layer) in power-fx-dataverse.mjs. canvas-power-fx.mjs registers
// this engine as the default evaluator, so formula columns, Dataverse Functions, low-code plug-ins and canvas formulas
// evaluate for real; a trusted pack's powerFx adapter can still replace it.
//
// Language (Learn, Power Fx "Expression grammar" and "Operators and Identifiers"):
// - literals: numbers (`1.5e3`), text ("a ""quoted"" b"), `true`/`false`, string interpolation `$"Hi {Name}"` with `{{`/`}}`;
// - identifiers: regular and 'single quoted' (`''` escapes a quote), case-sensitive; `[@Name]` global and `Table[@Field]`
//   disambiguation; context keywords ThisRecord, ThisItem, Self, Parent;
// - records `{ A: 1 }`, tables `[1, 2]` (a single column named Value), `.` property selection, function calls `F(a, b)`
//   and namespaced calls `Ns.F(a)`, chaining with `;` (also inside function arguments), comments `//` and `/* */`;
// - operators, loosest first: `As`; `||` `Or`; `&&` `And`; `in` `exactin`; `=` `<>` `<` `<=` `>` `>=`; `&`; `+` `-`;
//   `*` `/`; prefix `-` `!` `Not`; `^`; postfix `%`.
// The precedence ladder is read from the grammar and the open-source parser's order (Learn gives no table); in
//   particular `-2^2` is -(2^2) = -4 here.
// Values (Learn, "Data types"): Blank is null; Number and Decimal are JS numbers; Text; Boolean; FxDate (DateTime, Date or
// Time); FxGuid; records are plain objects; tables are arrays of records; FxError carries Learn error records (Kind,
// Message); FxUntyped is the dynamic value ParseJSON returns; FxRecordRef is a related record loaded on first use;
// FxDataSource is a delegable table (Dataverse).
// Errors flow through (Learn, "Error handling": error in, error out); IfError, IsError and IsBlankOrError observe them.
// Blank is 0 in arithmetic and "" in text (Learn, "Blank, Coalesce, IsBlank, and IsEmpty functions").
// Numbers: Decimal arithmetic and comparison are exact (exact-numeric.mjs; a recurring quotient is rounded at 28 places);
// Float (FxFloat) is an IEEE double, as Learn defines Float.
// ponytail: Float text shows 15 significant digits (numberText); a Float-specific format rule if one is captured.
//
// Host contract (evaluate(expression, { values, host })), every member optional:
//   values: named globals (control records, parameters, ThisItem...); host.scope: the implicit ThisRecord (a formula column's
//   row, an automated plug-in's target); host.variables (Set, Collect collections) and host.context (UpdateContext) objects;
//   host.dataSource(name) -> FxDataSource | undefined; host.navigate/back/notify/trace callbacks; host.user (a record for
//   User()); host.language (Language(), default "en-US"); host.timeZone (IANA name for local date/time parts, default
//   "UTC"); host.now() (ms, default Date.now); host.guid() (GUID() text, default crypto.randomUUID); host.dataRowLimit (non-delegated reads, default 500); host.diagnostic(entry)
//   (delegation warnings); host.self / host.parent records; host.app ('canvas' makes IsMatch default to Complete).
import { DataError } from './data-error.mjs';
import {
  compareNumeric,
  decimalParts,
  decimalText,
  exactNumeric,
  isExactNumeric,
  multiplyNumeric,
  numericPair,
} from './exact-numeric.mjs';
import { FUNCTIONS } from './power-fx-functions.mjs';

// ---- Values

// Learn, "Error handling" (ErrorKind enum values) and the Power Fx SDK ErrorKind enum.
export const ErrorKind = Object.freeze({
  None: 0,
  Sync: 1,
  MissingRequired: 2,
  CreatePermission: 3,
  EditPermissions: 4,
  DeletePermissions: 5,
  Conflict: 6,
  NotFound: 7,
  ConstraintViolated: 8,
  GeneratedValue: 9,
  ReadOnlyValue: 10,
  Validation: 11,
  Unknown: 12,
  Div0: 13,
  BadLanguageCode: 14,
  BadRegex: 15,
  InvalidFunctionUsage: 16,
  FileNotFound: 17,
  AnalysisError: 18,
  ReadPermission: 19,
  NotSupported: 20,
  InsufficientMemory: 21,
  QuotaExceeded: 22,
  Network: 23,
  Numeric: 24,
  InvalidArgument: 25,
  Internal: 26,
  NotApplicable: 27,
  Timeout: 28,
  ServiceUnavailable: 29,
  InvalidJSON: 30,
  Custom: 1000,
});

export class FxError {
  constructor(errors) {
    this.errors = errors;
  }
}
export const fxError = (kind, message) => new FxError([{ Kind: kind, Message: message }]);
// The data source's own refusal (a DataError: privilege, validation, not found) behind an error record.
export const CAUSE = Symbol('power-fx.cause');

// kind 'datetime': ms is the UTC instant; tzi marks a time zone independent value (UTCNow, a TimeZoneIndependent column) whose
// parts read in UTC. kind 'date': ms is UTC midnight of the calendar date. kind 'time': ms since midnight.
export class FxDate {
  constructor(kind, ms, tzi = false) {
    this.kind = kind;
    this.ms = ms;
    this.tzi = tzi;
  }
}
export class FxGuid {
  constructor(text) {
    this.value = String(text).toLowerCase();
  }
  toString() {
    return this.value;
  }
}
export class FxUntyped {
  constructor(raw) {
    this.raw = raw;
  }
}
// A related record (a Dataverse lookup) read on first use. table and id identify it; load() answers the record or null.
export class FxRecordRef {
  constructor(table, id, load) {
    this.table = table;
    this.id = String(id).toLowerCase();
    this.load = load;
  }
  get record() {
    if (!('cached' in this)) this.cached = this.load();
    return this.cached;
  }
}
// A delegable table: adapter (power-fx-dataverse.mjs) answers reads, writes and the OData translation of columns; query
// holds the delegated filters, order and top so far.
export class FxDataSource {
  constructor(name, adapter, query = { filters: [], orderby: [], top: null }) {
    this.name = name;
    this.adapter = adapter;
    this.query = query;
  }
  with(change) {
    return new FxDataSource(this.name, this.adapter, { ...this.query, ...change });
  }
}
// A record's display-name aliases (Dataverse 'Display Name' -> logical name), kept off the enumerable fields.
export const ALIASES = Symbol('power-fx.aliases');

export const isBlank = (v) => v === null || v === undefined;
export const isRecord = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !isExactNumeric(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
// A host record marked with LAZY (a canvas control whose properties are getters) is used as it is: toFx never reads its
// properties, so a property is evaluated only when a formula selects it.
export const LAZY = Symbol.for('power-fx.lazy');

// JS value -> Power Fx value: arrays become tables (scalars in a Value column), plain objects records, Date a DateTime.
export function toFx(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && value[LAZY]) return value;
  if (value instanceof Date) return new FxDate('datetime', value.getTime());
  if (Array.isArray(value)) return value.map((item) => (isRecord(item) ? toFx(item) : { Value: toFx(item) }));
  if (isRecord(value)) {
    const record = {};
    for (const [key, item] of Object.entries(value)) record[key] = toFx(item);
    if (value[ALIASES]) record[ALIASES] = value[ALIASES];
    return record;
  }
  return value;
}

// Power Fx value -> JSON-shaped value for hosts: a date/time as ISO 8601 text, a GUID as text, a related record as
// { id, logical_name }, a data source read in full. An error throws (the host decides its envelope).
export function fromFx(value, fx = null) {
  if (value === null || value === undefined) return null;
  if (value instanceof FxError) throw runtimeError(value);
  if (value instanceof FxDate) return isoOf(value);
  if (value instanceof FxFloat) return value.value;
  if (value instanceof FxGuid) return value.value;
  if (value instanceof FxUntyped) return value.raw;
  if (value instanceof FxRecordRef) return { id: value.id, logical_name: value.table };
  if (value instanceof FxDataSource) return fromFx(readAll(fx, value, 'fromFx'), fx);
  if (Array.isArray(value)) return value.map((item) => fromFx(item, fx));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromFx(item, fx)]));
  return value;
}

/** The DataError a host answers for an error value: 400 PowerFxError with the first Learn error record. */
function runtimeError(error) {
  const first = error.errors[0] ?? { Kind: ErrorKind.Unknown, Message: 'Unknown error.' };
  // A refused data-source write answers the data source's own error (the Web API envelope), not a generic formula error.
  if (first[CAUSE]) return first[CAUSE];
  const kind = Object.keys(ErrorKind).find((name) => ErrorKind[name] === first.Kind) ?? String(first.Kind);
  return new DataError(String(first.Message ?? kind), 400, 'PowerFxError', {
    kind,
    errorKind: first.Kind,
    errors: error.errors,
  });
}

// ---- Dates and time zones

const DAY = 86_400_000;
const zoneFormats = new Map();
// Offset (ms) of an IANA zone at a UTC instant, from Intl (stdlib); 0 for UTC.
export function zoneOffset(utcMs, timeZone) {
  if (!timeZone || timeZone === 'UTC') return 0;
  if (!zoneFormats.has(timeZone))
    zoneFormats.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }),
    );
  const parts = Object.fromEntries(
    zoneFormats
      .get(timeZone)
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(utcMs / 1000) * 1000;
}
// Wall-clock ms (a UTC-shaped number) of a date/time value in the zone its parts read in.
export function wallOf(date, timeZone) {
  if (date.kind !== 'datetime' || date.tzi) return date.ms;
  return date.ms + zoneOffset(date.ms, timeZone);
}
// The value of the given kind at a wall-clock time.
export function fromWall(kind, wall, timeZone, tzi = false) {
  if (kind === 'date') return new FxDate('date', Math.floor(wall / DAY) * DAY);
  if (kind === 'time') return new FxDate('time', ((wall % DAY) + DAY) % DAY);
  if (tzi || !timeZone || timeZone === 'UTC') return new FxDate('datetime', wall, tzi);
  const guess = wall - zoneOffset(wall, timeZone);
  return new FxDate('datetime', wall - zoneOffset(guess, timeZone));
}
const pad = (n, width = 2) => String(n).padStart(width, '0');
export function isoOf(date) {
  const d = new Date(date.ms);
  if (date.kind === 'date') return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (date.kind === 'time')
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
  return d.toISOString();
}

// Date/time text -> value. ISO 8601 (an offset or Z is honoured; without one the text is wall time in the host zone),
// en-US M/D/YYYY with an optional time and AM/PM, and what Date.parse reads as a last resort.
// Power Fx parses with the language's patterns; only en-US forms are read here.
// A calendar date and time of day that exist (no month 13, no February 30, no hour 24): Learn ("DateValue"): text that is
// not a valid date answers an error, it does not roll over.
function wallOfParts(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const d = new Date(wall);
  const valid =
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60;
  return valid ? wall : NaN;
}
function parseDateText(text, kind, timeZone) {
  const value = String(text).trim();
  if (!value) return null;
  let m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      value,
    );
  let wall,
    zoned = null;
  if (m) {
    wall = wallOfParts(
      +m[1],
      +m[2],
      +m[3],
      +(m[4] ?? 0),
      +(m[5] ?? 0),
      +(m[6] ?? 0),
      Number(
        String(m[7] ?? '0')
          .slice(0, 3)
          .padEnd(3, '0'),
      ),
    );
    if (m[8])
      zoned =
        m[8].toUpperCase() === 'Z'
          ? 0
          : (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(-2))) * 60_000;
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(value))) {
    let hour = +(m[4] ?? 0);
    if (m[7]) hour = (hour % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    wall = wallOfParts(year, +m[1], +m[2], hour, +(m[5] ?? 0), +(m[6] ?? 0));
  } else if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(AM|PM)?$/i.exec(value))) {
    let hour = Number(m[1]);
    if (m[5]) hour = (hour % 12) + (m[5].toUpperCase() === 'PM' ? 12 : 0);
    wall = wallOfParts(1970, 1, 1, hour, +m[2], +(m[3] ?? 0), Number(String(m[4] ?? '0').padEnd(3, '0')));
    if (kind === 'datetime') return null;
  } else {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return null;
    const d = new Date(parsed);
    wall = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  }
  if (Number.isNaN(wall)) return null;
  if (zoned !== null) {
    const utc = wall - zoned;
    return kind === 'datetime'
      ? new FxDate('datetime', utc)
      : fromWall(kind, utc + zoneOffset(utc, timeZone), timeZone);
  }
  return fromWall(kind, wall, timeZone);
}

// ---- Coercion (Learn, "Data types" and the Value, Text and Boolean functions)

export const round15 = (n) => (Number.isFinite(n) && !Number.isInteger(n) ? Number(n.toPrecision(15)) : n);

// Decimal (the default number type of Dataverse formula columns, Learn "Create formula columns with decimal, whole number,
// float, and choice data types") is exact: a JS number when the decimal digits fit one exactly, else an exact-numeric value
// (exact-numeric.mjs, the store's own representation). Float (Float(), Sqrt, Ln, Exp, Power, ^ and float columns, which
// Learn says return float, and any arithmetic with a float operand) is an FxFloat double.
export class FxFloat {
  constructor(value) {
    this.value = value;
  }
}
export const isNumeric = (v) => typeof v === 'number' || isExactNumeric(v) || v instanceof FxFloat;
const DECIMAL_PLACES = 28;
// Exact decimal arithmetic on numbers and exact-numeric values. Division keeps every digit of a terminating quotient and
// rounds a recurring one half away from zero at 28 places.
export function decimalArithmetic(op, a, b) {
  try {
    return exactArithmetic(op, a, b);
  } catch (error) {
    // Learn ("Error handling", ErrorKind.Numeric): a numeric overflow is an error value, never an exception.
    if (error?.code === 'NumericPrecisionUnsupported')
      return fxError(ErrorKind.Numeric, 'Invalid operation: the number is out of range.');
    throw error;
  }
}
function exactArithmetic(op, a, b) {
  const pair = numericPair(a, b);
  const scale = Math.max(decimalParts(a).scale, decimalParts(b).scale);
  if (op === '+' || op === '-')
    return exactNumeric(decimalText({ coefficient: op === '+' ? pair.x + pair.y : pair.x - pair.y, scale }), 'Decimal');
  if (op === '*') return multiplyNumeric([a, b], 'Decimal');
  if (pair.y === 0n) return fxError(ErrorKind.Div0, 'Invalid operation: division by zero.');
  const scaled = pair.x * 10n ** BigInt(DECIMAL_PLACES),
    quotient = scaled / pair.y,
    rest = scaled % pair.y;
  const negative = pair.x < 0n !== pair.y < 0n;
  const up = (rest < 0n ? -rest : rest) * 2n >= (pair.y < 0n ? -pair.y : pair.y) ? (negative ? -1n : 1n) : 0n;
  return exactNumeric(decimalText({ coefficient: quotient + up, scale: DECIMAL_PLACES }), 'Decimal');
}
// A numeric operand as a decimal (number or exact value); a Float as its double.
export function toDecimal(v) {
  if (v instanceof FxFloat) return v.value;
  if (isExactNumeric(v)) return v;
  return toNumber(v);
}

export function toNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (v instanceof FxFloat) return v.value;
  if (isExactNumeric(v)) return Number(v.value);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const parsed = parseNumber(v);
    return isExactNumeric(parsed) ? Number(parsed.value) : parsed;
  }
  if (v instanceof FxDate) return v.ms;
  if (v instanceof FxUntyped) return toNumber(v.raw);
  if (v instanceof FxError) return v;
  return fxError(ErrorKind.InvalidArgument, 'The value cannot be converted to a number.');
}
// Number text as an exact decimal in a language (Learn "Decimal, Float, and Value functions": "Different languages
// interpret , and . differently"; the language tag argument, else the current user's language): group separators, a
// currency symbol, a trailing or leading percent sign, an exponent. The language's decimal and group separators come from
// Intl.NumberFormat parts. Power Fx ignores only the current language's currency symbol; $ € £ ¥ are ignored here.
function numberSeparators(language = 'en-US') {
  let parts;
  try {
    parts = new Intl.NumberFormat(language || 'en-US', { useGrouping: true }).formatToParts(1234567.5);
  } catch {
    return null;
  }
  // Group widths come from the same parts: en-IN 12,34,567 is primary 3, secondary 2.
  const widths = parts.filter((part) => part.type === 'integer').map((part) => part.value.length);
  return {
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    group: parts.find((part) => part.type === 'group')?.value ?? ',',
    primary: widths.at(-1) ?? 3,
    secondary: widths.length > 2 ? widths.at(-2) : (widths.at(-1) ?? 3),
  };
}
// The invariant (en-US) form of number text in a language: { text, percent } or an FxError.
export function invariantNumberText(text, language = 'en-US') {
  let value = String(text).trim();
  const separators = numberSeparators(language);
  if (!separators) return fxError(ErrorKind.InvalidArgument, `The language tag '${language}' is not valid.`);
  let percent = false;
  if (value.endsWith('%')) {
    percent = true;
    value = value.slice(0, -1).trim();
  } else if (value.startsWith('%')) {
    percent = true;
    value = value.slice(1).trim();
  }
  value = value.replace(/^([+-]?)\s*[$€£¥]\s*/, '$1').replace(/\s*[$€£¥]$/, '');
  // A space-like group separator (fr-FR U+202F, others U+00A0) also matches a plain space typed by a user; an apostrophe
  // (de-CH) also matches the typographic U+2019.
  const group = /^\s$/.test(separators.group)
    ? '[\\s\\u00a0\\u202f]'
    : /^['’]$/.test(separators.group)
      ? "['’]"
      : separators.group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Groups are removed only where they follow the language's widths (secondary groups, then the primary group last).
  const { primary, secondary } = separators;
  value = value.replace(
    new RegExp(`^([+-]?)(\\d{1,${secondary}}(?:${group}\\d{${secondary}})*${group}\\d{${primary}})(?!\\d)`),
    (_, sign, digits) => sign + digits.replace(new RegExp(group, 'g'), ''),
  );
  // With a non-period decimal separator a remaining period is not part of a number in that language.
  if (separators.decimal !== '.') value = value.replace(/\./g, 'x').split(separators.decimal).join('.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value))
    return fxError(ErrorKind.InvalidArgument, `The value '${text}' cannot be converted to a number.`);
  return { text: value.replace(/^([+-]?)\./, '$10.').replace(/^\+/, ''), percent };
}
export function parseNumber(text, language = 'en-US') {
  if (!String(text).trim()) return null;
  const parsed = invariantNumberText(text, language);
  if (parsed instanceof FxError) return parsed;
  // Learn "Data types" (Numbers): Decimal holds up to about ±7.9 x 10^28; Decimal("1e100") is an overflow error.
  let exact;
  try {
    if (compareNumeric(parsed.text.replace(/^-/, ''), '79228162514264337593543950335') > 0)
      throw new RangeError('Decimal range');
    exact = exactNumeric(parsed.text, 'Decimal');
  } catch {
    return fxError(ErrorKind.Numeric, `The value '${text}' is out of range.`);
  }
  return parsed.percent ? decimalArithmetic('/', exact, 100) : exact;
}
export function toBoolean(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (isNumeric(v)) return toNumber(v) !== 0;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false' || t === '') return false;
    return fxError(ErrorKind.InvalidArgument, `The value '${v}' cannot be converted to a Boolean.`);
  }
  if (v instanceof FxUntyped) return toBoolean(v.raw);
  if (v instanceof FxError) return v;
  return fxError(ErrorKind.InvalidArgument, 'The value cannot be converted to a Boolean.');
}
// General number format: up to 15 significant digits, no grouping.
const numberText = (n) => (Number.isInteger(n) ? String(n) : String(round15(n)));
export function toText(v, fx = null) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numberText(v);
  if (v instanceof FxFloat) return numberText(v.value);
  if (isExactNumeric(v)) return decimalText(decimalParts(v));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof FxDate)
    return formatDate(
      v,
      v.kind === 'date' ? 'm/d/yyyy' : v.kind === 'time' ? 'h:mm AM/PM' : 'm/d/yyyy h:mm AM/PM',
      fx?.timeZone,
      fx?.language,
    );
  if (v instanceof FxGuid) return v.value;
  if (v instanceof FxUntyped)
    return v.raw === null
      ? ''
      : typeof v.raw === 'object'
        ? fxError(ErrorKind.InvalidArgument, 'The untyped value is not text.')
        : String(v.raw);
  if (v instanceof FxError) return v;
  if (typeof v === 'object' && typeof v.toString === 'function' && /^-?\d/.test(String(v))) return String(v); // exact-numeric
  return fxError(ErrorKind.InvalidArgument, 'The value cannot be converted to text.');
}
export function toDate(v, kind, fx) {
  if (v === null || v === undefined) return null;
  if (v instanceof FxDate) {
    if (v.kind === kind || kind === 'any') return v;
    if (kind === 'datetime')
      return v.kind === 'date' ? fromWall('datetime', v.ms, fx?.timeZone) : fromWall('datetime', v.ms, fx?.timeZone);
    return fromWall(kind, wallOf(v, fx?.timeZone), fx?.timeZone);
  }
  if (typeof v === 'string' || v instanceof FxUntyped) {
    const text = v instanceof FxUntyped ? v.raw : v;
    if (text === null) return null;
    const parsed = parseDateText(text, kind === 'any' ? 'datetime' : kind, fx?.timeZone);
    return parsed ?? fxError(ErrorKind.InvalidArgument, `The value '${text}' cannot be converted to a date/time.`);
  }
  if (typeof v === 'number') return new FxDate(kind === 'any' ? 'datetime' : kind, v);
  if (v instanceof FxError) return v;
  return fxError(ErrorKind.InvalidArgument, 'The value cannot be converted to a date/time.');
}

// Learn, "Text function" date/time placeholders: yyyy yy mmmm mmm mm m dddd ddd dd d hh h mm(minutes) ss s f.. AM/PM am/pm
// a/p, "quoted" literals and \x escapes. Month and day names come from Intl in the given language.
export function formatDate(date, format, timeZone, language = 'en-US') {
  const wall = wallOf(date, timeZone);
  const d = new Date(wall);
  const name = (options) => new Intl.DateTimeFormat(language || 'en-US', { timeZone: 'UTC', ...options }).format(d);
  const tokens = [];
  const re = /"([^"]*)"|\\(.)|(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|f{1,3}|AM\/PM|am\/pm|A\/P|a\/p)|(.)/gs;
  for (const match of String(format).matchAll(re)) {
    if (match[1] !== undefined) tokens.push({ text: match[1] });
    else if (match[2] !== undefined) tokens.push({ text: match[2] });
    else if (match[3] !== undefined) tokens.push({ token: match[3] });
    else tokens.push({ text: match[4] });
  }
  const ampm = tokens.some((t) => t.token && /\//.test(t.token));
  const out = tokens.map((t, i) => {
    if (!t.token) return t.text;
    const tok = t.token;
    // m and mm are minutes after an hour token or before a seconds token (Excel rule).
    const isMinute =
      (tok === 'm' || tok === 'mm') &&
      (tokens
        .slice(0, i)
        .reverse()
        .find((x) => x.token)
        ?.token?.startsWith('h') ||
        tokens
          .slice(i + 1)
          .find((x) => x.token)
          ?.token?.startsWith('s'));
    if (isMinute) return tok === 'mm' ? pad(d.getUTCMinutes()) : String(d.getUTCMinutes());
    const hour12 = d.getUTCHours() % 12 || 12;
    switch (tok) {
      case 'yyyy':
        return String(d.getUTCFullYear());
      case 'yy':
        return pad(d.getUTCFullYear() % 100);
      case 'mmmm':
        return name({ month: 'long' });
      case 'mmm':
        return name({ month: 'short' });
      case 'mm':
        return pad(d.getUTCMonth() + 1);
      case 'm':
        return String(d.getUTCMonth() + 1);
      case 'dddd':
        return name({ weekday: 'long' });
      case 'ddd':
        return name({ weekday: 'short' });
      case 'dd':
        return pad(d.getUTCDate());
      case 'd':
        return String(d.getUTCDate());
      case 'hh':
        return pad(ampm ? hour12 : d.getUTCHours());
      case 'h':
        return String(ampm ? hour12 : d.getUTCHours());
      case 'ss':
        return pad(d.getUTCSeconds());
      case 's':
        return String(d.getUTCSeconds());
      case 'AM/PM':
        return d.getUTCHours() < 12 ? 'AM' : 'PM';
      case 'am/pm':
        return d.getUTCHours() < 12 ? 'am' : 'pm';
      case 'A/P':
        return d.getUTCHours() < 12 ? 'A' : 'P';
      case 'a/p':
        return d.getUTCHours() < 12 ? 'a' : 'p';
      default:
        return pad(d.getUTCMilliseconds(), 3).slice(0, tok.length); // f, ff, fff
    }
  });
  return out.join('');
}

// ---- Comparison

// Equality (Learn, "Operators"): text is case-sensitive, GUIDs compare case-insensitively (also against GUID text), records
// by their fields (a related record by its id), blank equals only blank.
// Not checked against native: Blank() = "" reads false here (IsBlank("") is true by Learn).
export function equals(a, b, fx = null) {
  if (a instanceof FxRecordRef) a = a.id;
  if (b instanceof FxRecordRef) b = b.id;
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  if (a instanceof FxGuid || b instanceof FxGuid) return String(a).toLowerCase() === String(b).toLowerCase();
  if (a instanceof FxDate && b instanceof FxDate) return compareDates(a, b, fx) === 0;
  if (a instanceof FxUntyped) a = a.raw;
  if (b instanceof FxUntyped) b = b.raw;
  if (isNumeric(a) || isNumeric(b)) return numericOrder(a, b) === 0;
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => equals(a[key] ?? null, b[key] ?? null, fx));
  }
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => equals(item, b[i], fx));
  return a === b;
}
function compareDates(a, b, fx) {
  if (a.kind === 'datetime' && b.kind === 'datetime') return Math.sign(a.ms - b.ms);
  return Math.sign(wallOf(a, fx?.timeZone) - wallOf(b, fx?.timeZone));
}
// Ordering for < > and Sort: numbers (blank as 0), text, dates, Booleans. An incomparable pair is an error.
export function compare(a, b, fx = null) {
  if (a instanceof FxUntyped) a = a.raw;
  if (b instanceof FxUntyped) b = b.raw;
  if (a instanceof FxDate || b instanceof FxDate) {
    if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b) ? 0 : isBlank(a) ? -1 : 1;
    const da = toDate(a, 'any', fx),
      db = toDate(b, 'any', fx);
    if (da instanceof FxError) return da;
    if (db instanceof FxError) return db;
    return compareDates(da, db, fx);
  }
  if (typeof a === 'string' || typeof b === 'string') {
    if (isNumeric(a) || isNumeric(b)) return numericOrder(a, b);
    const ta = a ?? '',
      tb = b ?? '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  }
  if (a instanceof FxGuid || b instanceof FxGuid) return String(a ?? '').localeCompare(String(b ?? ''));
  return numericOrder(a, b);
}
// Numbers compare exactly (decimal digits, not doubles); a value that is not a number is an error.
function numericOrder(a, b) {
  const da = toDecimal(a),
    db = toDecimal(b);
  if (da instanceof FxError) return da;
  if (db instanceof FxError) return db;
  return compareNumeric(da ?? 0, db ?? 0);
}

// ---- Lexer

class FxSyntaxError extends DataError {
  constructor(message, position) {
    super(`${message} (position ${position + 1}).`, 400, 'PowerFxSyntaxError', { position });
  }
}

const IDENT_START = /[\p{L}\p{Nl}_]/u;
const IDENT_PART = /[\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}_]/u;
const OPERATORS = [
  '[@',
  '<>',
  '<=',
  '>=',
  '&&',
  '||',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ',',
  ';',
  ':',
  '.',
  '!',
  '@',
  '+',
  '-',
  '*',
  '/',
  '^',
  '%',
  '&',
  '=',
  '<',
  '>',
];

function lex(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new FxSyntaxError('Unterminated comment', i);
      i = end + 2;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(\d*\.?\d*)(e[+-]?\d+)?/i.exec(text.slice(i));
      let v;
      try {
        v = exactNumeric((m[0].startsWith('.') ? '0' : '') + m[0], 'Decimal');
      } catch {
        v = fxError(ErrorKind.Numeric, `The number ${m[0]} is out of range.`);
      }
      tokens.push({ k: 'num', v, at: start });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i++;
      for (;;) {
        if (i >= text.length) throw new FxSyntaxError('Unterminated text literal', start);
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i++];
      }
      tokens.push({ k: 'str', v: value, at: start });
      continue;
    }
    if (ch === '$' && text[i + 1] === '"') {
      const { parts, end } = lexInterpolation(text, i + 2);
      tokens.push({ k: 'interp', parts, at: start });
      i = end;
      continue;
    }
    if (ch === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= text.length) throw new FxSyntaxError('Unterminated quoted identifier', start);
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i++];
      }
      tokens.push({ k: 'id', v: value, quoted: true, at: start });
      continue;
    }
    if (IDENT_START.test(ch)) {
      while (i < text.length && IDENT_PART.test(text[i])) i++;
      tokens.push({ k: 'id', v: text.slice(start, i), quoted: false, at: start });
      continue;
    }
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, i));
    if (!op) throw new FxSyntaxError(`Unexpected character '${ch}'`, i);
    tokens.push({ k: 'op', v: op, at: start });
    i += op.length;
  }
  tokens.push({ k: 'eof', at: text.length });
  return tokens;
}

// $"..." body from `from`: literal text with "" and {{ }} escapes, and {expression} islands (strings inside them skipped).
function lexInterpolation(text, from) {
  const parts = [];
  let literal = '';
  let i = from;
  for (;;) {
    if (i >= text.length) throw new FxSyntaxError('Unterminated interpolated text', from - 2);
    const ch = text[i];
    if (ch === '"') {
      if (text[i + 1] === '"') {
        literal += '"';
        i += 2;
        continue;
      }
      i++;
      break;
    }
    if (ch === '{' && text[i + 1] === '{') {
      literal += '{';
      i += 2;
      continue;
    }
    if (ch === '}' && text[i + 1] === '}') {
      literal += '}';
      i += 2;
      continue;
    }
    if (ch === '{') {
      if (literal) parts.push(literal);
      literal = '';
      let depth = 1,
        j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '"') {
          j++;
          while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1;
        } else if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      if (depth) throw new FxSyntaxError('Unterminated interpolation island', i);
      parts.push({ node: parse(text.slice(i + 1, j - 1)) });
      i = j;
      continue;
    }
    literal += ch;
    i++;
  }
  if (literal) parts.push(literal);
  return { parts, end: i };
}

// ---- Parser

const BINARY = {
  As: 1,
  '||': 2,
  Or: 2,
  '&&': 3,
  And: 3,
  in: 4,
  exactin: 4,
  '=': 5,
  '<>': 5,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '&': 6,
  '+': 7,
  '-': 7,
  '*': 8,
  '/': 8,
  '^': 10,
};
const PREFIX = 9;
const KEYWORD_OPERATORS = new Set(['As', 'Or', 'And', 'in', 'exactin', 'Not']);

const parsed = new Map();
/** Parses a Power Fx expression (with `;` chaining) into an AST. Cached per text. */
export function parse(text) {
  if (parsed.has(text)) return parsed.get(text);
  const tokens = lex(String(text));
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (v) => peek().k === 'op' && peek().v === v;
  const expect = (v) => {
    if (!isOp(v)) throw new FxSyntaxError(`Expected '${v}'`, peek().at);
    return next();
  };
  const identifier = () => {
    const token = next();
    if (token.k !== 'id') throw new FxSyntaxError('Expected an identifier', token.at);
    return token.v;
  };
  const binaryOp = () => {
    const token = peek();
    if (token.k === 'op' && token.v in BINARY) return token.v;
    if (token.k === 'id' && !token.quoted && KEYWORD_OPERATORS.has(token.v) && token.v !== 'Not') return token.v;
    return null;
  };

  function chain() {
    const items = [expression(0)];
    while (isOp(';')) {
      next();
      if (peek().k === 'eof' || isOp(')') || isOp(',') || isOp('}') || isOp(']')) break;
      items.push(expression(0));
    }
    return items.length === 1 ? items[0] : { t: 'chain', items };
  }
  function expression(min) {
    let left = unary();
    for (;;) {
      const op = binaryOp();
      if (!op || BINARY[op] < min) return left;
      next();
      if (op === 'As') {
        left = { t: 'as', e: left, name: identifier() };
        continue;
      }
      const right = expression(BINARY[op] + 1);
      left = { t: 'bin', op: op === 'Or' ? '||' : op === 'And' ? '&&' : op, l: left, r: right };
    }
  }
  function unary() {
    const token = peek();
    if (token.k === 'op' && (token.v === '-' || token.v === '!' || token.v === '+')) {
      next();
      const e = expression(PREFIX);
      return token.v === '+' ? e : { t: 'unary', op: token.v, e };
    }
    if (
      token.k === 'id' &&
      !token.quoted &&
      token.v === 'Not' &&
      !(tokens[pos + 1].k === 'op' && tokens[pos + 1].v === '(')
    ) {
      next();
      return { t: 'unary', op: '!', e: expression(PREFIX) };
    }
    return postfix(primary());
  }
  function postfix(node) {
    for (;;) {
      if (isOp('.')) {
        next();
        const name = identifier();
        if (isOp('(') && dottedName(node) !== null) {
          node = call(`${dottedName(node)}.${name}`);
          continue;
        }
        node = { t: 'dot', obj: node, name };
        continue;
      }
      if (isOp('[@') && node.t === 'id') {
        next();
        const field = identifier();
        expect(']');
        node = { t: 'disamb', table: node.name, field };
        continue;
      }
      if (isOp('%')) {
        next();
        node = { t: 'pct', e: node };
        continue;
      }
      return node;
    }
  }
  function dottedName(node) {
    if (node.t === 'id' && !node.global) return node.name;
    if (node.t === 'dot') {
      const base = dottedName(node.obj);
      return base === null ? null : `${base}.${node.name}`;
    }
    return null;
  }
  function call(name) {
    expect('(');
    const args = [];
    if (!isOp(')')) {
      for (;;) {
        args.push(chain());
        if (isOp(',')) {
          next();
          continue;
        }
        break;
      }
    }
    expect(')');
    return { t: 'call', name, args };
  }
  function primary() {
    const token = next();
    switch (token.k) {
      case 'num':
        return { t: 'lit', v: token.v };
      case 'str':
        return { t: 'lit', v: token.v };
      case 'interp':
        return { t: 'interp', parts: token.parts };
      case 'id': {
        if (!token.quoted && (token.v === 'true' || token.v === 'false')) return { t: 'lit', v: token.v === 'true' };
        if (isOp('(')) return call(token.v);
        return { t: 'id', name: token.v, at: token.at };
      }
      case 'op': {
        if (token.v === '(') {
          const inner = chain();
          expect(')');
          return inner;
        }
        if (token.v === '[@') {
          const name = identifier();
          expect(']');
          return { t: 'id', name, global: true, at: token.at };
        }
        if (token.v === '{') {
          const fields = [];
          while (!isOp('}')) {
            const name = identifier();
            expect(':');
            fields.push([name, expression(0)]);
            if (isOp(',')) {
              next();
              continue;
            }
            if (!isOp('}')) throw new FxSyntaxError("Expected ',' or '}'", peek().at);
          }
          next();
          return { t: 'rec', fields };
        }
        if (token.v === '[') {
          const items = [];
          while (!isOp(']')) {
            items.push(expression(0));
            if (isOp(',')) {
              next();
              continue;
            }
            if (!isOp(']')) throw new FxSyntaxError("Expected ',' or ']'", peek().at);
          }
          next();
          return { t: 'tbl', items };
        }
        break;
      }
      default:
        break;
    }
    throw new FxSyntaxError(
      token.k === 'eof' ? 'Unexpected end of formula' : `Unexpected '${token.v ?? token.k}'`,
      token.at,
    );
  }

  if (peek().k === 'eof') throw new FxSyntaxError('The formula is empty', 0);
  const ast = chain();
  if (peek().k !== 'eof') throw new FxSyntaxError(`Unexpected '${peek().v ?? peek().k}'`, peek().at);
  if (parsed.size > 2000) parsed.clear(); // ponytail: bounded parse cache, cleared wholesale; an LRU if formulas churn.
  parsed.set(text, ast);
  return ast;
}

// ---- Evaluator

// Built-in enumerations (Learn: ErrorKind, TimeUnit, SortOrder, StartOfWeek, MatchOptions, Match, JSONFormat,
// NotificationType, DateTimeFormat, RemoveFlags).
// Guessed: the underlying values of the text-valued enumerations; they are the option and pattern strings each one stands
//   for here, and the DateTimeFormat members are the en-US patterns Learn's Text examples print.
const ENUMS = {
  ErrorKind,
  TimeUnit: {
    Milliseconds: 'Milliseconds',
    Seconds: 'Seconds',
    Minutes: 'Minutes',
    Hours: 'Hours',
    Days: 'Days',
    Months: 'Months',
    Quarters: 'Quarters',
    Years: 'Years',
  },
  SortOrder: { Ascending: 'Ascending', Descending: 'Descending' },
  StartOfWeek: {
    Sunday: 1,
    Monday: 2,
    MondayZero: 3,
    Tuesday: 12,
    Wednesday: 13,
    Thursday: 14,
    Friday: 15,
    Saturday: 16,
  },
  MatchOptions: {
    BeginsWith: '^c',
    Complete: '^c$',
    Contains: 'c',
    EndsWith: 'c$',
    IgnoreCase: 'i',
    Multiline: 'm',
    DotAll: 's',
    FreeSpacing: 'x',
    NumberedSubMatches: 'N',
  },
  Match: {
    Any: '.',
    Comma: ',',
    Digit: '\\d',
    Email: '[^@\\s]+@[^@\\s]+\\.[^@\\s]+',
    Hyphen: '-',
    LeftParen: '\\(',
    Letter: '\\p{L}',
    MultipleDigits: '\\d+',
    MultipleLetters: '\\p{L}+',
    MultipleNonSpaces: '\\S+',
    MultipleSpaces: '\\s+',
    NonSpace: '\\S',
    OptionalDigits: '\\d*',
    OptionalLetters: '\\p{L}*',
    OptionalNonSpaces: '\\S*',
    OptionalSpaces: '\\s*',
    Period: '\\.',
    RightParen: '\\)',
    Space: '\\s',
    Tab: '\\t',
  },
  JSONFormat: {
    Compact: '',
    IndentFour: '4',
    IgnoreBinaryData: 'G',
    IncludeBinaryData: 'B',
    IgnoreUnsupportedTypes: 'I',
    FlattenValueTables: '_',
  },
  NotificationType: { Error: 'Error', Information: 'Information', Success: 'Success', Warning: 'Warning' },
  DateTimeFormat: {
    LongDate: 'dddd, mmmm d, yyyy',
    ShortDate: 'm/d/yyyy',
    LongTime: 'h:mm:ss AM/PM',
    ShortTime: 'h:mm AM/PM',
    LongTime24: 'hh:mm:ss',
    ShortTime24: 'hh:mm',
    LongDateTime: 'dddd, mmmm d, yyyy h:mm:ss AM/PM',
    ShortDateTime: 'm/d/yyyy h:mm AM/PM',
    LongDateTime24: 'dddd, mmmm d, yyyy hh:mm:ss',
    ShortDateTime24: 'm/d/yyyy hh:mm',
    UTC: 'UTC',
  },
  RemoveFlags: { First: 'First', All: 'All' },
};

class FxNameError extends DataError {
  constructor(name) {
    super(`Name isn't valid. '${name}' isn't recognized.`, 400, 'PowerFxNameUnknown', { name });
  }
}

// Evaluation context for one formula: the host, the globals and the scope stack (innermost last). Scope entries are
// { record, name, source } for record scopes (ThisRecord, As name, the table's identifier) and { vars } for named values
// (FirstError, AllErrors).
class Fx {
  constructor({ values = {}, host = {} } = {}) {
    this.host = host ?? {};
    this.values = values ?? {};
    this.scopes = [];
    this.timeZone = this.host.timeZone ?? 'UTC';
    this.language = this.host.language ?? 'en-US';
    this.rowLimit = Number(this.host.dataRowLimit ?? 500);
    this.warnings = [];
  }
  now() {
    return typeof this.host.now === 'function' ? this.host.now() : Date.now();
  }
  warn(entry) {
    this.warnings.push(entry);
    this.host.diagnostic?.(entry);
  }
  // Evaluates node with an extra record scope for the duration of fn.
  inScope(scope, fn) {
    this.scopes.push(scope);
    try {
      return fn();
    } finally {
      this.scopes.pop();
    }
  }
  ev(node) {
    return evaluateNode(this, node);
  }
}

function lookupName(fx, node) {
  const { name } = node;
  if (!node.global) {
    if (name === 'ThisRecord') {
      for (let i = fx.scopes.length - 1; i >= 0; i--)
        if (fx.scopes[i].record !== undefined && !fx.scopes[i].vars) return fx.scopes[i].record;
      if (fx.host.scope) return fx.host.scope;
    }
    for (let i = fx.scopes.length - 1; i >= 0; i--) {
      const scope = fx.scopes[i];
      if (scope.vars && Object.hasOwn(scope.vars, name)) return scope.vars[name];
      if (scope.name === name) return scope.record;
      if (scope.record !== undefined && !scope.vars) {
        const found = field(scope.record, name);
        if (found !== MISSING) return found;
      }
    }
    if (fx.host.scope) {
      const found = field(fx.host.scope, name);
      if (found !== MISSING) return found;
    }
  }
  if (name === 'Self' && fx.host.self !== undefined) return fx.host.self;
  if (name === 'Parent' && fx.host.parent !== undefined) return fx.host.parent;
  if (fx.host.context && Object.hasOwn(fx.host.context, name)) return fx.host.context[name];
  if (fx.host.variables && Object.hasOwn(fx.host.variables, name)) return fx.host.variables[name];
  if (Object.hasOwn(fx.values, name)) return toFx(fx.values[name]);
  const source = fx.host.dataSource?.(name);
  if (source) return source;
  if (Object.hasOwn(ENUMS, name)) return ENUMS[name];
  throw new FxNameError(name);
}

const MISSING = Symbol('missing');
// A record field by name, then case-insensitively, then by display-name alias; MISSING when the record has none.
function field(record, name) {
  if (record instanceof FxRecordRef) record = record.record;
  if (!isRecord(record)) return MISSING;
  if (Object.hasOwn(record, name)) return record[name];
  const alias = record[ALIASES]?.get(name) ?? record[ALIASES]?.get(name.toLowerCase());
  if (alias && Object.hasOwn(record, alias)) return record[alias];
  return MISSING;
}
export const fieldName = (record, name) => {
  if (!isRecord(record) || Object.hasOwn(record, name)) return name;
  return record[ALIASES]?.get(name) ?? record[ALIASES]?.get(name.toLowerCase()) ?? name;
};

// Property selection on a value: a record field (blank when absent), a related record's field, an untyped object's
// property, a table column (a single-column table of that name).
export function member(fx, value, name) {
  if (value instanceof FxError || isBlank(value)) return value ?? null;
  if (value instanceof FxRecordRef) return member(fx, value.record, name);
  if (value instanceof FxUntyped) {
    const raw = value.raw;
    return raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      Object.hasOwn(raw, name) &&
      raw[name] !== null
      ? new FxUntyped(raw[name])
      : null;
  }
  if (value instanceof FxDataSource) value = readAll(fx, value, 'property selection');
  if (Array.isArray(value)) return value.map((row) => ({ [name]: member(fx, row, name) }));
  if (isRecord(value)) {
    const found = field(value, name);
    return found === MISSING ? null : found;
  }
  return fxError(ErrorKind.InvalidArgument, `The value has no property '${name}'.`);
}

/** A table's rows; a data source is read without delegation up to the data row limit, with the delegation warning. */
export function readAll(fx, value, operation) {
  if (!(value instanceof FxDataSource)) return value;
  const limit = fx?.rowLimit ?? 500;
  const rows = value.adapter.read({
    ...value.query,
    top: value.query.top === null ? limit + 1 : Math.min(value.query.top, limit + 1),
  });
  const truncated = rows.length > limit;
  // Learn shows this warning at authoring time (Studio wording); here it is raised when the formula runs.
  fx?.warn({
    code: 'POWERFX_DELEGATION',
    severity: 'warning',
    dataSource: value.name,
    operation,
    rowLimit: limit,
    truncated,
    message: `Delegation warning. The '${operation}' part of this formula might not work correctly on large data sets; it read the first ${limit} rows of '${value.name}'.`,
  });
  return truncated ? rows.slice(0, limit) : rows;
}

function evaluateNode(fx, node) {
  switch (node.t) {
    case 'lit':
      return node.v;
    case 'interp': {
      let out = '';
      for (const part of node.parts) {
        if (typeof part === 'string') {
          out += part;
          continue;
        }
        const text = toText(fx.ev(part.node), fx);
        if (text instanceof FxError) return text;
        out += text;
      }
      return out;
    }
    case 'id':
      return lookupName(fx, node);
    case 'disamb': {
      for (let i = fx.scopes.length - 1; i >= 0; i--) {
        if (fx.scopes[i].source === node.table) return member(fx, fx.scopes[i].record, node.field);
      }
      throw new FxNameError(`${node.table}[@${node.field}]`);
    }
    case 'dot': {
      const base = fx.ev(node.obj);
      // An unknown member of a built-in enumeration is a name error, not a blank.
      const isEnum = node.obj.t === 'id' && Object.hasOwn(ENUMS, node.obj.name) && base === ENUMS[node.obj.name];
      if (isEnum && !Object.hasOwn(base, node.name)) throw new FxNameError(`${node.obj.name}.${node.name}`);
      return member(fx, base, node.name);
    }
    case 'rec': {
      const record = {};
      for (const [name, value] of node.fields) record[name] = fx.ev(value);
      return record;
    }
    case 'tbl':
      return node.items.map((item) => {
        const value = fx.ev(item);
        return isRecord(value) ? value : { Value: value };
      });
    case 'unary': {
      const value = fx.ev(node.e);
      if (value instanceof FxError) return value;
      if (node.op === '!') {
        const b = toBoolean(value);
        return b instanceof FxError ? b : !b;
      }
      return arithmetic(fx, '-', 0, value);
    }
    case 'pct': {
      const value = fx.ev(node.e);
      return value instanceof FxError ? value : arithmetic(fx, '/', value, 100);
    }
    case 'bin':
      return binary(fx, node);
    case 'as':
      return fx.ev(node.e);
    case 'chain': {
      // Learn ("Error handling", Stopping further processing): each chained formula runs even when an earlier one failed;
      // Assumed: the chain's result is the earlier errors when any, else the last value.
      const errors = [];
      let last = null;
      for (const item of node.items) {
        last = fx.ev(item);
        if (last instanceof FxError) errors.push(...last.errors);
      }
      return errors.length ? new FxError(errors) : last;
    }
    case 'call':
      return callFunction(fx, node);
    default:
      throw new DataError(`Unknown Power Fx node '${node.t}'.`, 500, 'PowerFxInternal');
  }
}

function binary(fx, node) {
  const { op } = node;
  if (op === '&&' || op === '||') {
    const left = toBoolean(fx.ev(node.l));
    if (left instanceof FxError) return left;
    if (op === '&&' ? !left : left) return left;
    const right = toBoolean(fx.ev(node.r));
    return right;
  }
  const l = fx.ev(node.l);
  if (l instanceof FxError) return l;
  const r = fx.ev(node.r);
  if (r instanceof FxError) return r;
  switch (op) {
    case '&': {
      const a = toText(l, fx),
        b = toText(r, fx);
      return a instanceof FxError ? a : b instanceof FxError ? b : a + b;
    }
    case '=':
      return equals(l, r, fx);
    case '<>':
      return !equals(l, r, fx);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const c = compare(l, r, fx);
      if (c instanceof FxError) return c;
      return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
    }
    case 'in':
    case 'exactin':
      return membership(fx, l, r, op === 'exactin');
    default:
      return arithmetic(fx, op, l, r);
  }
}

// Learn, "Operators": in/exactin test a substring (text right side) or membership in a table (a single-column table's
// values, or records).
function membership(fx, needle, haystack, exact) {
  if (haystack instanceof FxDataSource) haystack = readAll(fx, haystack, 'in');
  if (Array.isArray(haystack)) {
    return haystack.some((row) => {
      if (isRecord(needle)) return equals(needle, row, fx);
      const keys = Object.keys(row);
      const value = keys.length === 1 ? row[keys[0]] : row;
      if (!exact && typeof needle === 'string' && typeof value === 'string')
        return needle.toLowerCase() === value.toLowerCase();
      return equals(needle, value, fx);
    });
  }
  const text = toText(haystack, fx),
    part = toText(needle, fx);
  if (text instanceof FxError) return text;
  if (part instanceof FxError) return part;
  return exact ? text.includes(part) : text.toLowerCase().includes(part.toLowerCase());
}

function arithmetic(fx, op, l, r) {
  // Date arithmetic: date/time + number adds days (Learn, "Data types": date/time values in arithmetic), date - date gives
  // days. The result kinds of mixed date arithmetic are a guess.
  if (l instanceof FxDate && (op === '+' || op === '-') && !(r instanceof FxDate)) {
    const n = toNumber(r);
    if (n instanceof FxError) return n;
    // A day is a wall-clock day, as DateAdd(..., TimeUnit.Days) counts it (one rule for both, across daylight saving).
    return fromWall(l.kind, wallOf(l, fx.timeZone) + (op === '+' ? n : -n) * DAY, fx.timeZone, l.tzi);
  }
  if (l instanceof FxDate && r instanceof FxDate && op === '-')
    return round15((wallOf(l, fx.timeZone) - wallOf(r, fx.timeZone)) / DAY);
  const a = toDecimal(l),
    b = toDecimal(r);
  if (a instanceof FxError) return a;
  if (b instanceof FxError) return b;
  // Learn (formula column data types): ^ returns a float, and a float operand makes the result a float.
  if (op === '^' || l instanceof FxFloat || r instanceof FxFloat) {
    const x = toNumber(a),
      y = toNumber(b);
    if (op === '/' && y === 0) return fxError(ErrorKind.Div0, 'Invalid operation: division by zero.');
    const result = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : Math.pow(x, y);
    return Number.isFinite(result)
      ? new FxFloat(result)
      : fxError(ErrorKind.Numeric, 'Invalid operation: the result is not a number.');
  }
  if (!['+', '-', '*', '/'].includes(op)) throw new DataError(`Unknown operator '${op}'.`, 500, 'PowerFxInternal');
  return decimalArithmetic(op, a, b);
}

class FxFunctionError extends DataError {
  constructor(message, details = {}) {
    super(message, 400, 'PowerFxFunctionUnsupported', details);
  }
}

function callFunction(fx, node) {
  const definition = Object.hasOwn(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : null;
  if (!definition) {
    const hosted = fx.host.functions?.[node.name];
    if (typeof hosted === 'function') return toFx(hosted(...node.args.map((arg) => fromFx(fx.ev(arg), fx))));
    throw new FxFunctionError(`'${node.name}' is an unknown or unsupported function.`, { function: node.name });
  }
  const { min = 0, max = Infinity } = definition;
  if (node.args.length < min || node.args.length > max)
    throw new FxFunctionError(
      `Invalid number of arguments to ${node.name}: received ${node.args.length}, expected ${min === max ? min : max === Infinity ? `${min} or more` : `${min} to ${max}`}.`,
      { function: node.name },
    );
  if (definition.lazy) return definition.fn(fx, node.args, node);
  const args = node.args.map((arg) => fx.ev(arg));
  if (!definition.errors) {
    const failed = args.filter((arg) => arg instanceof FxError);
    if (failed.length) return failed.length === 1 ? failed[0] : new FxError(failed.flatMap((error) => error.errors));
  }
  return definition.fn(fx, ...args);
}

// ---- Engine (the evaluator adapter canvas-power-fx.mjs registers as the default)

/** Evaluates text against values and host; answers the Power Fx value (an FxError for an error value). */
export function evaluateFx(expression, { values = {}, host = {} } = {}) {
  const fx = new Fx({ values, host });
  return { value: fx.ev(parse(expression)), fx };
}

export function functionNames() {
  return Object.keys(FUNCTIONS).sort();
}

// Names a formula calls that the function table does not hold (recursively through every node).
function calledNames(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (node.t === 'call') out.add(node.name);
  for (const value of Object.values(node)) {
    if (Array.isArray(value))
      value.forEach((item) =>
        Array.isArray(item) ? item.forEach((x) => calledNames(x, out)) : calledNames(item?.node ?? item, out),
      );
    else if (value && typeof value === 'object') calledNames(value, out);
  }
  return out;
}

/**
 * The core engine in the evaluator adapter shape: evaluateSync / evaluate answer { value, diagnostics } with the value
 * converted for the host (fromFx); an error value throws 400 PowerFxError (runtimeError) so each host answers its own
 * envelope. checkSync / check parse the formula and name unknown functions.
 */
export const powerFxEngine = Object.freeze({
  evaluateSync(expression, { values = {}, host = {} } = {}) {
    const { value, fx } = evaluateFx(expression, { values, host });
    if (value instanceof FxError) throw runtimeError(value);
    return { value: fromFx(value, fx), diagnostics: fx.warnings };
  },
  async evaluate(expression, options = {}) {
    return powerFxEngine.evaluateSync(expression, options);
  },
  checkSync(expression, { host = {} } = {}) {
    try {
      const ast = parse(expression);
      const unknown = [...calledNames(ast)].filter(
        (name) => !Object.hasOwn(FUNCTIONS, name) && typeof host.functions?.[name] !== 'function',
      );
      return {
        ok: unknown.length === 0,
        diagnostics: unknown.map((name) => ({
          code: 'POWERFX_FUNCTION_UNSUPPORTED',
          function: name,
          message: `'${name}' is an unknown or unsupported function.`,
        })),
      };
    } catch (error) {
      return {
        ok: false,
        diagnostics: [{ code: 'POWERFX_SYNTAX', message: error.message, position: error.details?.position ?? null }],
      };
    }
  },
  async check(expression, options = {}) {
    return powerFxEngine.checkSync(expression, options);
  },
});
