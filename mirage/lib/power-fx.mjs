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
//   "UTC"); host.numberIsFloat (optional explicit Power Fx numeric literal mode); host.now() (ms, default Date.now); host.guid() (GUID() text, default crypto.randomUUID); host.dataRowLimit (non-delegated reads, default 500); host.diagnostic(entry)
//   (delegation warnings); host.regexGuardMs (hang guard in ms for a pattern that can backtrack without bound, default 10000);
//   host.self / host.parent records; host.app ('canvas' makes IsMatch default to Complete).
import { DataError } from './data-error.mjs';
import { canvasColorNames } from './power-fx-colors.mjs';
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
// A source-declared option enum: labels are case-insensitive and unknown members are errors.
export class FxEnum {
  constructor(name, entries) {
    this.name = name;
    this.entries = new Map(
      Object.entries(entries).map(([label, value]) => [label.toLowerCase(), new FxChoice(name, label, value)]),
    );
  }
}
export class FxChoice {
  constructor(enumName, label, value) {
    this.enumName = enumName;
    this.label = label;
    this.value = value;
  }
}
// Text-valued Canvas control properties implicitly display a choice's localized label.
export const choiceDisplayValue = (value) => (value instanceof FxChoice ? value.label : value);
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
  constructor(name, adapter, query = defaultDataSourceQuery()) {
    this.name = name;
    this.adapter = adapter;
    this.query = query;
  }
  with(change) {
    return new FxDataSource(this.name, this.adapter, { ...this.query, ...change });
  }
}
function defaultDataSourceQuery() {
  return { filters: [], orderby: [], top: null };
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
    const record = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toFx(item)]));
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
  if (value instanceof FxChoice) return value.value;
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
  return valid ? wall : Number.NaN;
}
const ISO_DATE_PATTERN = String.raw`^(\d{4})-(\d{2})-(\d{2})`;
const ISO_TIME_PATTERN = String.raw`(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?`;
const ISO_ZONE_PATTERN = String.raw`\s*(Z|[+-]\d{2}:?\d{2})?$`;
function parseIsoDateText(value) {
  const match = new RegExp(ISO_DATE_PATTERN + ISO_TIME_PATTERN + ISO_ZONE_PATTERN, 'i').exec(value);
  if (!match) return null;
  const wall = wallOfParts(
    +match[1],
    +match[2],
    +match[3],
    +(match[4] ?? 0),
    +(match[5] ?? 0),
    +(match[6] ?? 0),
    Number(
      String(match[7] ?? '0')
        .slice(0, 3)
        .padEnd(3, '0'),
    ),
  );
  let zoned = null;
  if (match[8]) {
    if (match[8].toUpperCase() === 'Z') zoned = 0;
    else
      zoned =
        (match[8].startsWith('-') ? -1 : 1) * (Number(match[8].slice(1, 3)) * 60 + Number(match[8].slice(-2))) * 60_000;
  }
  return { wall, zoned };
}
const DMY_DATE_PATTERN = String.raw`^(\d{1,2})\/(\d{1,2})\/(\d{2,4})`;
const DMY_TIME_PATTERN = String.raw`(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$`;
// A slash date is month first unless dayFirst is set (the day and month order of the language in DateValue's argument).
function parseDmyDateText(value, kind, app, dayFirst = false) {
  const match = new RegExp(DMY_DATE_PATTERN + DMY_TIME_PATTERN, 'i').exec(value);
  if (!match) return null;
  let hour = +(match[4] ?? 0);
  if (match[7]) hour = (hour % 12) + (match[7].toUpperCase() === 'PM' ? 12 : 0);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const [month, day] = dayFirst ? [+match[2], +match[1]] : [+match[1], +match[2]];
  // Native Canvas normalizes numeric slash-date parts: en-US13/01/2024 is January1,2025, rather than a parse error.
  return {
    wall:
      kind === 'date' && app === 'canvas'
        ? Date.UTC(year, month - 1, day, hour, +(match[5] ?? 0), +(match[6] ?? 0))
        : wallOfParts(year, month, day, hour, +(match[5] ?? 0), +(match[6] ?? 0)),
    zoned: null,
  };
}
function parseTimeDateText(value, kind) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(AM|PM)?$/i.exec(value);
  if (!match) return null;
  let hour = Number(match[1]);
  if (match[5]) hour = (hour % 12) + (match[5].toUpperCase() === 'PM' ? 12 : 0);
  // TimeValue accepts hours beyond a day and returns their time of day (official PAC: 25:00 -> 01:00).
  if (kind === 'time' && !match[5]) hour %= 24;
  return {
    wall: wallOfParts(1970, 1, 1, hour, +match[2], +(match[3] ?? 0), Number(String(match[4] ?? '0').padEnd(3, '0'))),
    zoned: null,
    invalidForDateTime: kind === 'datetime',
  };
}
function parseDateText(text, kind, timeZone, app, dayFirst) {
  const value = String(text).trim();
  if (!value) return null;
  let parsed =
    parseIsoDateText(value) ?? parseDmyDateText(value, kind, app, dayFirst) ?? parseTimeDateText(value, kind);
  if (!parsed) {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return null;
    const d = new Date(timestamp);
    parsed = {
      wall: Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()),
      zoned: null,
    };
  }
  if (parsed.invalidForDateTime) return null;
  const { wall, zoned } = parsed;
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
/* NOSONAR: mixed return values are part of the contract */ export function decimalArithmetic(op, a, b) {
  try {
    return exactArithmetic(op, a, b);
  } catch (error) {
    // Learn ("Error handling", ErrorKind.Numeric): a numeric overflow is an error value, never an exception.
    if (error?.code === 'NumericPrecisionUnsupported')
      return fxError(ErrorKind.Numeric, 'Invalid operation: the number is out of range.');
    throw error;
  }
}
/* NOSONAR: mixed return values are part of the contract */ function exactArithmetic(op, a, b) {
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
  let up = 0n;
  if ((rest < 0n ? -rest : rest) * 2n >= (pair.y < 0n ? -pair.y : pair.y)) up = negative ? -1n : 1n;
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
  return {
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    group: parts.find((part) => part.type === 'group')?.value ?? ',',
  };
}
// The invariant (en-US) form of number text in a language: { text, percent } or an FxError.
function stripTrailingCurrency(value) {
  return /[$€£¥]/.test(value[value.length - 1] ?? '') ? value.slice(0, -1).trimEnd() : value;
}
export function invariantNumberText(text, language = 'en-US') {
  let value = String(text).trim();
  const separators = numberSeparators(language);
  if (!separators) return fxError(ErrorKind.BadLanguageCode, `The language tag '${language}' is not valid.`);
  let percent = false;
  if (value.endsWith('%')) {
    percent = true;
    value = value.slice(0, -1).trim();
  } else if (value.startsWith('%')) {
    percent = true;
    value = value.slice(1).trim();
  }
  value = stripTrailingCurrency(value.replace(/^([+-]?)\s*[$€£¥]\s*/, '$1'));
  // A space-like group separator (fr-FR U+202F, others U+00A0) also matches a plain space typed by a user; an apostrophe
  // (de-CH) also matches the typographic U+2019.
  let group = separators.group.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  if (/^\s$/.test(separators.group)) group = String.raw`[\s\u00a0\u202f]`;
  else if (/^['’]$/.test(separators.group)) group = "['’]";
  // The Microsoft reader accepts noncanonical group widths, repeated groups and
  // trailing groups after an integer digit. A leading group or a group inside
  // the fractional/exponent part remains invalid.
  value = value.replace(new RegExp(String.raw`^([+-]?\d(?:\d|${group})*)`), (digits) =>
    digits.replace(new RegExp(group, 'g'), ''),
  );
  // With a non-period decimal separator a remaining period is not part of a number in that language.
  if (separators.decimal !== '.') value = value.replaceAll('.', 'x').split(separators.decimal).join('.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
    return fxError(ErrorKind.InvalidArgument, `The value '${text}' cannot be converted to a number.`);
  return { text: value.replace(/^([+-]?)\./, '$1' + '0.').replace(/^\+/, ''), percent };
}
/* NOSONAR: mixed return values are part of the contract */ export function parseNumber(text, language = 'en-US') {
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
    return fxError(ErrorKind.InvalidArgument, `The value '${text}' is out of range.`);
  }
  return parsed.percent ? decimalArithmetic('/', exact, 100) : exact;
}
/* NOSONAR: mixed return values are part of the contract */ export function toBoolean(v) {
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
function textOfDate(value, fx) {
  let pattern = 'm/d/yyyy h:mm AM/PM';
  if (value.kind === 'date') pattern = 'm/d/yyyy';
  else if (value.kind === 'time') pattern = 'h:mm AM/PM';
  return formatDate(value, pattern, fx?.timeZone, fx?.language);
}
/* NOSONAR: mixed return values are part of the contract */ function textOfUntyped(value) {
  if (value.raw === null) return '';
  if (typeof value.raw === 'object') return fxError(ErrorKind.InvalidArgument, 'The untyped value is not text.');
  return String(value.raw);
}
export function toText(v, fx = null) {
  if (v instanceof FxChoice) return v.label;
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numberText(v);
  if (v instanceof FxFloat) return numberText(v.value);
  if (isExactNumeric(v)) return decimalText(decimalParts(v));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof FxDate) return textOfDate(v, fx);
  if (v instanceof FxGuid) return v.value;
  if (v instanceof FxUntyped) return textOfUntyped(v);
  if (v instanceof FxError) return v;
  if (typeof v === 'object' && typeof v.toString === 'function' && /^-?\d/.test(String(v))) return String(v); // exact-numeric
  return fxError(ErrorKind.InvalidArgument, 'The value cannot be converted to text.');
}
function convertFxDate(value, kind, fx) {
  if (value.kind === kind || kind === 'any') return value;
  if (kind === 'datetime') return fromWall('datetime', value.ms, fx?.timeZone);
  return fromWall(kind, wallOf(value, fx?.timeZone), fx?.timeZone);
}
export function toDate(v, kind, fx, dayFirst) {
  if (v === null || v === undefined) return null;
  if (v instanceof FxDate) return convertFxDate(v, kind, fx);
  if (typeof v === 'string' || v instanceof FxUntyped) {
    const text = v instanceof FxUntyped ? v.raw : v;
    if (text === null) return null;
    const parsed = parseDateText(text, kind === 'any' ? 'datetime' : kind, fx?.timeZone, fx?.host?.app, dayFirst);
    return parsed ?? fxError(ErrorKind.InvalidArgument, `The value '${text}' cannot be converted to a date/time.`);
  }
  if (typeof v === 'number') return new FxDate(kind === 'any' ? 'datetime' : kind, v);
  if (v instanceof FxError) return v;
  return fxError(ErrorKind.InvalidArgument, 'The value cannot be converted to a date/time.');
}

/* NOSONAR */ function formatDateToken(t, i, tokens, d, name, ampm) {
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
}

// Learn, "Text function" date/time placeholders: yyyy yy mmmm mmm mm m dddd ddd dd d hh h mm(minutes) ss s f.. AM/PM am/pm
// a/p, "quoted" literals and \x escapes. Month and day names come from Intl in the given language.
export function formatDate(date, format, timeZone, language = 'en-US') {
  const wall = wallOf(date, timeZone);
  const d = new Date(wall);
  const name = (options) => new Intl.DateTimeFormat(language || 'en-US', { timeZone: 'UTC', ...options }).format(d);
  const tokens = [];
  const re = new RegExp(FORMAT_QUOTED_PATTERN + FORMAT_TOKEN_PATTERN + FORMAT_OTHER_PATTERN, 'gs');
  for (const match of String(format).matchAll(re)) {
    if (match[1] !== undefined) tokens.push({ text: match[1] });
    else if (match[2] !== undefined) tokens.push({ text: match[2] });
    else if (match[3] !== undefined) tokens.push({ token: match[3] });
    else tokens.push({ text: match[4] });
  }
  const ampm = tokens.some((t) => t.token && /\//.test(t.token));
  const out = tokens.map((t, i) => formatDateToken(t, i, tokens, d, name, ampm));
  return out.join('');
}

// ---- Comparison

// Equality (Learn, "Operators"): text is case-sensitive, GUIDs compare case-insensitively (also against GUID text), records
// by their fields (a related record by its id), blank equals only blank.
// Not checked against native: Blank() = "" reads false here (IsBlank("") is true by Learn).
export function equals(a, b, fx = null) {
  if (differentChoiceSets(a, b)) return false;
  [a, b] = comparableValues(a, b);
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
  if (a instanceof FxGuid || b instanceof FxGuid) return String(a).toLowerCase() === String(b).toLowerCase();
  if (a instanceof FxDate && b instanceof FxDate) return compareDates(a, b, fx) === 0;
  [a, b] = untypedValues(a, b);
  if (isNumeric(a) || isNumeric(b)) return numericOrder(a, b) === 0;
  if (isRecord(a) && isRecord(b)) return equalRecords(a, b, fx);
  if (Array.isArray(a) && Array.isArray(b)) return equalTables(a, b, fx);
  return a === b;
}
function differentChoiceSets(a, b) {
  return a instanceof FxChoice && b instanceof FxChoice && a.enumName.toLowerCase() !== b.enumName.toLowerCase();
}
function comparableValues(a, b) {
  if (a instanceof FxChoice) a = a.value;
  if (b instanceof FxChoice) b = b.value;
  if (a instanceof FxRecordRef) a = a.id;
  if (b instanceof FxRecordRef) b = b.id;
  return [a, b];
}
function untypedValues(a, b) {
  if (a instanceof FxUntyped) a = a.raw;
  if (b instanceof FxUntyped) b = b.raw;
  return [a, b];
}
function equalRecords(a, b, fx) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => equals(a[key] ?? null, b[key] ?? null, fx));
}
function equalTables(a, b, fx) {
  return a.length === b.length && a.every((item, i) => equals(item, b[i], fx));
}
function compareDates(a, b, fx) {
  if (a.kind === 'datetime' && b.kind === 'datetime') return Math.sign(a.ms - b.ms);
  return Math.sign(wallOf(a, fx?.timeZone) - wallOf(b, fx?.timeZone));
}
// Ordering for < > and Sort: numbers (blank as 0), text, dates, Booleans. An incomparable pair is an error.
/* NOSONAR: mixed return values are part of the contract */ export function compare(a, b, fx = null) {
  if (a instanceof FxChoice && b instanceof FxChoice && a.enumName.toLowerCase() !== b.enumName.toLowerCase())
    return fxError(ErrorKind.InvalidArgument, 'Choices from different option sets cannot be compared.');
  if (a instanceof FxChoice) a = a.value;
  if (b instanceof FxChoice) b = b.value;
  if (a instanceof FxUntyped) a = a.raw;
  if (b instanceof FxUntyped) b = b.raw;
  if (a instanceof FxDate || b instanceof FxDate) return compareDateValues(a, b, fx);
  if (typeof a === 'string' || typeof b === 'string') return compareTextValues(a, b);
  if (a instanceof FxGuid || b instanceof FxGuid) return String(a ?? '').localeCompare(String(b ?? ''));
  return numericOrder(a, b);
}
/* NOSONAR: mixed return values are part of the contract */ function compareDateValues(a, b, fx) {
  if (isBlank(a) || isBlank(b)) {
    if (isBlank(a) && isBlank(b)) return 0;
    return isBlank(a) ? -1 : 1;
  }
  const da = toDate(a, 'any', fx),
    db = toDate(b, 'any', fx);
  if (da instanceof FxError) return da;
  if (db instanceof FxError) return db;
  return compareDates(da, db, fx);
}
/* NOSONAR: mixed return values are part of the contract */ function compareTextValues(a, b) {
  if (isNumeric(a) || isNumeric(b)) return numericOrder(a, b);
  const ta = a ?? '',
    tb = b ?? '';
  if (ta < tb) return -1;
  return ta > tb ? 1 : 0;
}
// Numbers compare exactly (decimal digits, not doubles); a value that is not a number is an error.
/* NOSONAR: mixed return values are part of the contract */ function numericOrder(a, b) {
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

function roundDecimalToken(value) {
  const parts = decimalParts(value);
  if (parts.scale <= 28) return value;
  const divisor = 10n ** BigInt(parts.scale - 28);
  let rounded = parts.coefficient / divisor;
  const remainder = parts.coefficient % divisor;
  if (remainder * 2n > divisor || (remainder * 2n === divisor && rounded % 2n !== 0n)) rounded++;
  return exactNumeric(decimalText({ coefficient: rounded, scale: 28 }), 'Decimal', { collapse: false });
}
function decimalTokenFailure(error, text, start) {
  if (error instanceof FxSyntaxError) throw error;
  const number = Number(text);
  if (number === 0 || (number > 0 && number < 1e-128))
    return { token: { k: 'num', v: 0, at: start }, end: start + text.length };
  if (!Number.isFinite(number) || number > 7.922816251426434e28)
    throw new FxSyntaxError('Numeric value is too large', start);
  throw error;
}
function lexNumberToken(text, start, numberIsFloat) {
  const match = /^(\d*\.?\d*)(e[+-]?\d+)?/i.exec(text.slice(start));
  let value;
  if (numberIsFloat === true) {
    const number = Number(match[0]);
    if (!Number.isFinite(number)) throw new FxSyntaxError('Numeric value is too large', start);
    return { token: { k: 'num', v: new FxFloat(number), at: start }, end: start + match[0].length };
  }
  try {
    value = exactNumeric((match[0].startsWith('.') ? '0' : '') + match[0], 'Decimal');
    if (numberIsFloat === false) value = roundDecimalToken(value);
    if (numberIsFloat === false && compareNumeric(value, '79228162514264337593543950335') > 0)
      throw new FxSyntaxError('Numeric value is too large', start);
  } catch (error) {
    if (numberIsFloat === false) return decimalTokenFailure(error, match[0], start);
    value = fxError(ErrorKind.Numeric, `The number ${match[0]} is out of range.`);
  }
  return { token: { k: 'num', v: value, at: start }, end: start + match[0].length };
}
function lexStringToken(text, start) {
  let value = '',
    i = start + 1;
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
  return { token: { k: 'str', v: value, at: start }, end: i };
}
function lexQuotedIdentifier(text, start) {
  let value = '',
    i = start + 1;
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
  return { token: { k: 'id', v: value, quoted: true, at: start }, end: i };
}
function lexToken(text, start, numberIsFloat, depth) {
  const ch = text[start];
  if (/\d/.test(ch) || (ch === '.' && /\d/.test(text[start + 1] ?? '')))
    return lexNumberToken(text, start, numberIsFloat);
  if (ch === '"') return lexStringToken(text, start);
  if (ch === '$' && text[start + 1] === '"') {
    const { parts, end } = lexInterpolation(text, start + 2, numberIsFloat, depth);
    return { token: { k: 'interp', parts, at: start }, end };
  }
  if (ch === "'") return lexQuotedIdentifier(text, start);
  if (IDENT_START.test(ch)) {
    let end = start;
    while (end < text.length && IDENT_PART.test(text[end])) end++;
    return { token: { k: 'id', v: text.slice(start, end), quoted: false, at: start }, end };
  }
  const op = OPERATORS.find((candidate) => text.startsWith(candidate, start));
  if (!op) throw new FxSyntaxError(`Unexpected character '${ch}'`, start);
  return { token: { k: 'op', v: op, at: start }, end: start + op.length };
}
function lex(text, numberIsFloat, depth) {
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
    const next = lexToken(text, i, numberIsFloat, depth);
    tokens.push(next.token);
    i = next.end;
  }
  tokens.push({ k: 'eof', at: text.length });
  return tokens;
}

// $"..." body from `from`: literal text with "" and {{ }} escapes, and {expression} islands (strings inside them skipped).
/* NOSONAR */ function interpolationIslandEnd(text, start) {
  let depth = 1,
    end = start + 1;
  while (end < text.length && depth > 0) {
    if (text[end] === '"') {
      end++;
      while (end < text.length && !(text[end] === '"' && text[end + 1] !== '"')) end += text[end] === '"' ? 2 : 1;
    } else if (text[end] === '{') depth++;
    else if (text[end] === '}') depth--;
    end++;
  }
  if (depth) throw new FxSyntaxError('Unterminated interpolation island', start);
  return end;
}
function interpolationEscape(text, index, ch) {
  if (ch === '"' && text[index + 1] === '"') return '"';
  if (ch === '{' && text[index + 1] === '{') return '{';
  if (ch === '}' && text[index + 1] === '}') return '}';
  return null;
}
function lexInterpolation(text, from, numberIsFloat, depth) {
  const parts = [];
  let literal = '';
  let i = from;
  for (;;) {
    if (i >= text.length) throw new FxSyntaxError('Unterminated interpolated text', from - 2);
    const ch = text[i];
    const escaped = interpolationEscape(text, i, ch);
    if (escaped !== null) {
      literal += escaped;
      i += 2;
      continue;
    }
    if (ch === '"') {
      i++;
      break;
    }
    if (ch === '{') {
      if (literal) parts.push(literal);
      literal = '';
      const j = interpolationIslandEnd(text, i);
      parts.push({ node: parse(text.slice(i + 1, j - 1), { numberIsFloat, depth: depth + 1 }) });
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
const FORMAT_QUOTED_PATTERN = String.raw`"([^"]*)"|\\(.)`;
const FORMAT_TOKEN_PATTERN = String.raw`|(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|f{1,3}|AM\/PM|am\/pm|A\/P|a\/p)`;
const FORMAT_OTHER_PATTERN = String.raw`|(.)`; // NOSONAR: escaping is intentional
// Parser nesting limit: every nested expression (parenthesis, call argument, prefix operator, interpolation island) counts one.
const MAX_NESTING = 500;
// Terms in one left-deep chain (`a + b + c`, `a.b.c`, `x As a As b`): the evaluator walks a chain in a loop, and this bound keeps
// every chain walk finite and the parse of a chain from building an unbounded tree.
const MAX_CHAIN = 10_000;
/** Parses a Power Fx expression (with `;` chaining) into an AST. Top-level results are cached per text. */
function dottedName(node) {
  const names = [];
  let current = node;
  while (current.t === 'dot') {
    names.push(current.name);
    current = current.obj;
  }
  if (current.t !== 'id' || current.global) return null;
  return [current.name, ...names.toReversed()].join('.');
}
export function parse(text, { numberIsFloat, depth = 0 } = {}) {
  // Islands are parsed inside the lexer before the parser's own nesting check, so the island depth is checked here.
  if (depth > MAX_NESTING) throw new FxSyntaxError('The formula is nested too deeply', 0);
  let mode = 'default';
  if (numberIsFloat === true) mode = 'float';
  else if (numberIsFloat === false) mode = 'decimal';
  const cacheKey = `${mode}:${text}`;
  // A nested island is cached only with its outer formula: its cached tree would not carry the depth it was reached at.
  if (depth === 0 && parsed.has(cacheKey)) return parsed.get(cacheKey);
  const tokens = lex(String(text), numberIsFloat, depth);
  let pos = 0;
  let nesting = depth;
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
  // Each operator or member step extends the current left-deep chain by one term.
  const countTerm = (terms) => {
    if (terms >= MAX_CHAIN) throw new FxSyntaxError('The formula is nested too deeply', peek().at);
    return terms + 1;
  };
  // Every nested expression passes through here (a parenthesis, call argument, prefix operand or island), so each counts once.
  function expression(min) {
    if (++nesting > MAX_NESTING) throw new FxSyntaxError('The formula is nested too deeply', peek().at);
    const tree = binaryTail(min);
    nesting--;
    return tree;
  }
  function binaryTail(min) {
    let left = unary();
    let terms = 1;
    for (;;) {
      const op = binaryOp();
      if (!op || BINARY[op] < min) return left;
      terms = countTerm(terms);
      next();
      if (op === 'As') {
        left = { t: 'as', e: left, name: identifier() };
        continue;
      }
      // Official PAC evaluates 2^3^2 as 2^(3^2); every other binary operator stays left-associative.
      const right = expression(BINARY[op] + (op === '^' ? 0 : 1));
      let operator = op;
      if (op === 'Or') operator = '||';
      else if (op === 'And') operator = '&&';
      left = { t: 'bin', op: operator, l: left, r: right };
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
    let terms = 1;
    for (;;) {
      if (isOp('.')) {
        terms = countTerm(terms);
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
        terms = countTerm(terms);
        next();
        const field = identifier();
        expect(']');
        node = { t: 'disamb', table: node.name, field };
        continue;
      }
      if (isOp('%')) {
        terms = countTerm(terms);
        next();
        node = { t: 'pct', e: node };
        continue;
      }
      return node;
    }
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
  function recordPrimary() {
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
  function tablePrimary() {
    const items = [];
    while (!isOp(']')) {
      items.push(expression(0));
      if (isOp(',')) {
        next();
        continue;
      }
      if (!isOp(']')) throw new FxSyntaxError(`Expected ',' or ']'`, peek().at);
    }
    next();
    return { t: 'tbl', items };
  }
  function invalidPrimary(token) {
    throw new FxSyntaxError(
      token.k === 'eof' ? 'Unexpected end of formula' : `Unexpected '${token.v ?? token.k}'`,
      token.at,
    );
  }
  function operatorPrimary(token) {
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
    if (token.v === '{') return recordPrimary();
    if (token.v === '[') return tablePrimary();
    return invalidPrimary(token);
  }
  function primary() {
    const token = next();
    switch (token.k) {
      case 'num':
      case 'str':
        return { t: 'lit', v: token.v };
      case 'interp':
        return { t: 'interp', parts: token.parts };
      case 'id':
        if (!token.quoted && (token.v === 'true' || token.v === 'false')) return { t: 'lit', v: token.v === 'true' };
        if (isOp('(')) return call(token.v);
        return { t: 'id', name: token.v, at: token.at };
      case 'op':
        return operatorPrimary(token);
      default:
        return invalidPrimary(token);
    }
  }

  if (peek().k === 'eof') throw new FxSyntaxError('The formula is empty', 0);
  const ast = chain();
  if (peek().k !== 'eof') throw new FxSyntaxError(`Unexpected '${peek().v ?? peek().k}'`, peek().at);
  if (depth === 0) {
    if (parsed.size > 2000) parsed.clear(); // ponytail: bounded parse cache, cleared wholesale; an LRU if formulas churn.
    parsed.set(cacheKey, ast);
  }
  return ast;
}

// ---- Evaluator

// Built-in enumerations (Learn: ErrorKind, TimeUnit, SortOrder, StartOfWeek, MatchOptions, Match, JSONFormat,
// NotificationType, DateTimeFormat, RemoveFlags).
// Guessed: the underlying values of the text-valued enumerations; they are the option and pattern strings each one stands
//   for here, and the DateTimeFormat members are the en-US patterns Learn's Text examples print.
const ENUMS = {
  Color: canvasColorNames,
  DataSourceInfo: Object.fromEntries(
    [
      'DisplayName',
      'MaxLength',
      'MaxValue',
      'MinValue',
      'Required',
      'AllowedValues',
      'CreatePermission',
      'DeletePermission',
      'EditPermission',
      'ReadPermission',
    ].map((name) => [name, name]),
  ),
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
    Digit: String.raw`\d`,
    Email: String.raw`[^@\s]+@[^@\s]+\.[^@\s]+`,
    Hyphen: '-',
    LeftParen: String.raw`\(`,
    Letter: String.raw`\p{L}`,
    MultipleDigits: String.raw`\d+`,
    MultipleLetters: String.raw`\p{L}+`,
    MultipleNonSpaces: String.raw`\S+`,
    MultipleSpaces: String.raw`\s+`,
    NonSpace: String.raw`\S`,
    OptionalDigits: String.raw`\d*`,
    OptionalLetters: String.raw`\p{L}*`,
    OptionalNonSpaces: String.raw`\S*`,
    OptionalSpaces: String.raw`\s*`,
    Period: String.raw`\.`,
    RightParen: String.raw`\)`,
    Space: String.raw`\s`,
    Tab: String.raw`\t`,
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

export const powerFxBuiltinEnums = () => Object.keys(ENUMS);

class FxNameError extends DataError {
  constructor(name) {
    super(`Name isn't valid. '${name}' isn't recognized.`, 400, 'PowerFxNameUnknown', { name });
  }
}

class FxBudgetError extends DataError {
  constructor(limit) {
    super(
      `The formula entered more than ${limit} row scopes; Mirage stops it to keep the local runtime responsive.`,
      400,
      'PowerFxLimitExceeded',
      { limit },
    );
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
    // ponytail: one counter per evaluation, a local safeguard (not a platform limit);
    // hosts raise host.scopeBudget when a formula legitimately needs more.
    this.scopeBudget = Number(this.host.scopeBudget ?? 5_000_000);
    // A host may share one counter across nested evaluations (component functions); a standalone formula counts its own.
    this.scopeCounter = this.host.scopeCounter ?? { entered: 0 };
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
    if (++this.scopeCounter.entered > this.scopeBudget) throw new FxBudgetError(this.scopeBudget);
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
    const scoped = lookupScopedName(fx, name);
    if (scoped !== MISSING) return scoped;
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

function lookupScopedName(fx, name) {
  if (name === 'ThisRecord') {
    const record = lookupThisRecord(fx);
    if (record !== MISSING) return record;
  }
  for (let i = fx.scopes.length - 1; i >= 0; i--) {
    const found = lookupScopeValue(fx.scopes[i], name);
    if (found !== MISSING) return found;
  }
  if (fx.host.scope) {
    const found = field(fx.host.scope, name);
    if (found !== MISSING) return found;
  }
  return MISSING;
}
function lookupThisRecord(fx) {
  for (let i = fx.scopes.length - 1; i >= 0; i--)
    if (fx.scopes[i].record !== undefined && !fx.scopes[i].vars) return fx.scopes[i].record;
  return fx.host.scope || MISSING;
}
function lookupScopeValue(scope, name) {
  if (scope.vars && Object.hasOwn(scope.vars, name)) return scope.vars[name];
  if (scope.name === name) return scope.record;
  if (scope.record !== undefined && !scope.vars) {
    const found = field(scope.record, name);
    if (found !== MISSING) return found;
  }
  return MISSING;
}

const MISSING = Symbol('missing');
// A record field by name, then case-insensitively, then by display-name alias; MISSING when the record has none.
function field(record, name) {
  if (record instanceof FxRecordRef) record = record.record;
  if (!isRecord(record)) return MISSING;
  if (Object.hasOwn(record, name)) return record[name];
  const alias = record[ALIASES]?.get(name) ?? record[ALIASES]?.get(name.toLowerCase());
  if (alias) return Object.hasOwn(record, alias) ? record[alias] : null;
  return MISSING;
}
export const fieldName = (record, name) => {
  if (!isRecord(record) || Object.hasOwn(record, name)) return name;
  return record[ALIASES]?.get(name) ?? record[ALIASES]?.get(name.toLowerCase()) ?? name;
};

// Property selection on a value: a record field (blank when absent), a related record's field, an untyped object's
// property, a table column (a single-column table of that name).
export function member(fx, value, name) {
  if (value instanceof FxEnum) {
    const key = name.toLowerCase();
    if (!value.entries.has(key)) throw new FxNameError(`${value.name}.${name}`);
    return value.entries.get(key);
  }
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

/* NOSONAR: mixed return values are part of the contract */ function evaluateInterpolation(fx, node) {
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
function evaluateDisambiguation(fx, node) {
  for (let i = fx.scopes.length - 1; i >= 0; i--)
    if (fx.scopes[i].source === node.table) return member(fx, fx.scopes[i].record, node.field);
  throw new FxNameError(`${node.table}[@${node.field}]`);
}
function memberOf(fx, node, base) {
  // An unknown member of a built-in enumeration is a name error, not a blank.
  const isEnum = node.obj.t === 'id' && Object.hasOwn(ENUMS, node.obj.name) && base === ENUMS[node.obj.name];
  if (isEnum && node.obj.name === 'Color') {
    const key = Object.keys(base).find((item) => item.toLowerCase() === node.name.toLowerCase());
    if (!key) throw new FxNameError(`${node.obj.name}.${node.name}`);
    return base[key];
  }
  if (isEnum && !Object.hasOwn(base, node.name)) throw new FxNameError(`${node.obj.name}.${node.name}`);
  return member(fx, base, node.name);
}
function evaluateRecord(fx, node) {
  return Object.fromEntries(node.fields.map(([name, value]) => [name, fx.ev(value)]));
}
function evaluateTable(fx, node) {
  return node.items.map((item) => {
    const value = fx.ev(item);
    return isRecord(value) ? value : { Value: value };
  });
}
function evaluateUnary(fx, node) {
  const value = fx.ev(node.e);
  if (value instanceof FxError) return value;
  if (node.op === '!') {
    const b = toBoolean(value);
    return b instanceof FxError ? b : !b;
  }
  return arithmetic(fx, '-', 0, value);
}
function evaluateChain(fx, node) {
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
// A left-deep chain (binary operators, As, %, member access) is evaluated from its innermost operand outwards in a loop, so
// the call stack does not grow with the chain. Each step receives the value of the step below it, as nested evaluation did.
const SPINE_NODES = new Set(['bin', 'as', 'pct', 'dot']);
function spineOperand(node) {
  if (node.t === 'bin') return node.l;
  if (node.t === 'dot') return node.obj;
  return node.e;
}
function applySpineStep(fx, node, value) {
  if (node.t === 'dot') return memberOf(fx, node, value);
  if (node.t === 'bin') {
    return node.op === '&&' || node.op === '||' ? logicalStep(fx, node, value) : binaryStep(fx, node, value);
  }
  if (node.t === 'pct') return value instanceof FxError ? value : arithmetic(fx, '/', value, 100);
  return value;
}
function evaluateSpine(fx, node) {
  const steps = [];
  let operand = node;
  while (SPINE_NODES.has(operand.t)) {
    steps.push(operand);
    operand = spineOperand(operand);
  }
  let value = fx.ev(operand);
  for (let index = steps.length - 1; index >= 0; index -= 1) value = applySpineStep(fx, steps[index], value);
  return value;
}
function evaluateNode(fx, node) {
  switch (node.t) {
    case 'lit':
      return node.v;
    case 'interp':
      return evaluateInterpolation(fx, node);
    case 'id':
      return lookupName(fx, node);
    case 'disamb':
      return evaluateDisambiguation(fx, node);
    case 'dot':
    case 'bin':
    case 'as':
    case 'pct':
      return evaluateSpine(fx, node);
    case 'rec':
      return evaluateRecord(fx, node);
    case 'tbl':
      return evaluateTable(fx, node);
    case 'unary':
      return evaluateUnary(fx, node);
    case 'chain':
      return evaluateChain(fx, node);
    case 'call':
      return callFunction(fx, node);
    default:
      throw new DataError(`Unknown Power Fx node '${node.t}'.`, 500, 'PowerFxInternal');
  }
}

/* NOSONAR: mixed return values are part of the contract */ function logicalStep(fx, node, value) {
  const left = toBoolean(value);
  if (left instanceof FxError) return left;
  if (node.op === '&&' ? !left : left) return left;
  const right = toBoolean(fx.ev(node.r));
  return right;
}
/* NOSONAR: mixed return values are part of the contract */ function orderedBinary(fx, op, left, right) {
  const comparison = compare(left, right, fx);
  if (comparison instanceof FxError) return comparison;
  if (op === '<') return comparison < 0;
  if (op === '<=') return comparison <= 0;
  if (op === '>') return comparison > 0;
  return comparison >= 0;
}
function binaryStep(fx, node, l) {
  if (l instanceof FxError) return l;
  const r = fx.ev(node.r);
  if (r instanceof FxError) return r;
  return combineBinary(fx, node.op, l, r);
}
function combineBinary(fx, op, l, r) {
  const differentChoices =
    ['=', '<>', '<', '<=', '>', '>='].includes(op) &&
    l instanceof FxChoice &&
    r instanceof FxChoice &&
    l.enumName.toLowerCase() !== r.enumName.toLowerCase();
  if (differentChoices)
    return fxError(ErrorKind.InvalidArgument, 'Choices from different option sets cannot be compared.');
  switch (op) {
    case '&': {
      const a = toText(l, fx),
        b = toText(r, fx);
      if (a instanceof FxError) return a;
      if (b instanceof FxError) return b;
      return a + b;
    }
    case '=':
      return equals(l, r, fx);
    case '<>':
      return !equals(l, r, fx);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      return orderedBinary(fx, op, l, r);
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

function dateArithmetic(fx, op, left, right) {
  const amount = toNumber(right);
  if (amount instanceof FxError) return amount;
  // A day is a wall-clock day, as DateAdd(..., TimeUnit.Days) counts it (one rule for both, across daylight saving).
  return fromWall(left.kind, wallOf(left, fx.timeZone) + (op === '+' ? amount : -amount) * DAY, fx.timeZone, left.tzi);
}
function floatArithmetic(op, left, right) {
  const x = toNumber(left),
    y = toNumber(right);
  if (op === '/' && y === 0) return fxError(ErrorKind.Div0, 'Invalid operation: division by zero.');
  let result;
  switch (op) {
    case '+':
      result = x + y;
      break;
    case '-':
      result = x - y;
      break;
    case '*':
      result = x * y;
      break;
    case '/':
      result = x / y;
      break;
    default:
      result = Math.pow(x, y);
  }
  return Number.isFinite(result)
    ? new FxFloat(result)
    : fxError(ErrorKind.Numeric, 'Invalid operation: the result is not a number.');
}
function arithmetic(fx, op, l, r) {
  // Date arithmetic: date/time + number adds days (Learn, "Data types": date/time values in arithmetic), date - date gives
  // days. The result kinds of mixed date arithmetic are a guess.
  if (l instanceof FxDate && (op === '+' || op === '-') && !(r instanceof FxDate)) return dateArithmetic(fx, op, l, r);
  if (l instanceof FxDate && r instanceof FxDate && op === '-')
    return round15((wallOf(l, fx.timeZone) - wallOf(r, fx.timeZone)) / DAY);
  const a = toDecimal(l),
    b = toDecimal(r);
  if (a instanceof FxError) return a;
  if (b instanceof FxError) return b;
  // Learn (formula column data types): ^ returns a float, and a float operand makes the result a float.
  if (op === '^' || l instanceof FxFloat || r instanceof FxFloat) return floatArithmetic(op, a, b);
  if (!['+', '-', '*', '/'].includes(op)) throw new DataError(`Unknown operator '${op}'.`, 500, 'PowerFxInternal');
  return decimalArithmetic(op, a, b);
}

class FxFunctionError extends DataError {
  constructor(message, details = {}) {
    super(message, 400, 'PowerFxFunctionUnsupported', details);
  }
}

// Trusted hosts can opt into Power Fx values without the lossy JSON conversion used by connectors.
const TYPED_HOST_FUNCTION = Symbol('power-fx.typed-host-function');
export function typedPowerFxFunction(fn) {
  if (typeof fn !== 'function') throw new TypeError('typedPowerFxFunction needs a function.');
  Object.defineProperty(fn, TYPED_HOST_FUNCTION, { value: true });
  return fn;
}
const PURE_COMPONENT_DENIED = new Set([
  'Set',
  'UpdateContext',
  'Collect',
  'ClearCollect',
  'Clear',
  'Patch',
  'Remove',
  'RemoveIf',
  'UpdateIf',
  'Navigate',
  'Back',
  'Notify',
  'Trace',
]);
function arityText(min, max) {
  if (min === max) return String(min);
  if (max === Infinity) return `${min} or more`;
  return `${min} to ${max}`;
}
function callHostFunction(fx, node) {
  const hosted = fx.host.functions?.[node.name];
  if (typeof hosted !== 'function')
    throw new FxFunctionError(`'${node.name}' is an unknown or unsupported function.`, { function: node.name });
  if (!hosted[TYPED_HOST_FUNCTION]) return toFx(hosted(...node.args.map((arg) => fromFx(fx.ev(arg), fx))));
  const args = node.args.map((arg) => fx.ev(arg));
  const error = args.find((arg) => arg instanceof FxError);
  if (error) return error;
  const result = hosted(...args);
  if (result && typeof result.then === 'function')
    throw new FxFunctionError('Typed host functions must complete synchronously.', { function: node.name });
  return toFx(result);
}
function callBuiltinFunction(fx, node, definition) {
  const { min = 0, max = Infinity } = definition;
  if (node.args.length < min || node.args.length > max)
    throw new FxFunctionError(
      `Invalid number of arguments to ${node.name}: received ${node.args.length}, expected ${arityText(min, max)}.`,
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
function callFunction(fx, node) {
  if (fx.host.pureComponent && PURE_COMPONENT_DENIED.has(node.name))
    return fxError(ErrorKind.NotSupported, `${node.name} is not available in a pure component function.`);
  const definition = Object.hasOwn(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : null;
  if (!definition) return callHostFunction(fx, node);
  return callBuiltinFunction(fx, node, definition);
}

// ---- Engine (the evaluator adapter canvas-power-fx.mjs registers as the default)

/** Evaluates text against values and host; answers the Power Fx value (an FxError for an error value). */
export function evaluateFx(expression, { values = {}, host = {} } = {}) {
  const fx = new Fx({ values, host });
  return { value: fx.ev(parse(expression, { numberIsFloat: host.numberIsFloat })), fx };
}

export function functionNames() {
  return Object.keys(FUNCTIONS).sort(/* NOSONAR: preserve default string coercion */);
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
      const ast = parse(expression, { numberIsFloat: host.numberIsFloat });
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
