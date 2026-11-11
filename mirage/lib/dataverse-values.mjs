// Dataverse value semantics shared by the FetchXML and OData evaluators.
// Evidence for each rule is recorded in docs/dataverse-parity.md.
import { DataError } from './data-error.mjs';
import {
  isExactNumeric,
  numericPair,
  compareNumeric,
  formatExactNumeric,
  decimalParts,
  parseNumericLiteral,
} from './exact-numeric.mjs';
import { FISCAL_OPERATORS, fiscalCalendar, fiscalOperatorPredicate, fiscalPeriodOf } from './fiscal-calendar.mjs';
import { compileFormattedTimeZone } from './formatted-time-zone.mjs';

export const own = (obj, key) => obj != null && Object.hasOwn(obj, key);

const GUID_BODY = String.raw`[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}`;
export const GUID_PATTERN = new RegExp(`^${GUID_BODY}$`, 'i');
const DECORATED_GUID = new RegExp(String.raw`^\s*(?:\{(${GUID_BODY})\}|\((${GUID_BODY})\)|(${GUID_BODY}))\s*$`, 'i');

/** Lookup references, choice wrappers and plain values compare by their stored scalar. */
export const scalar = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value.id ?? value.value ?? value) : value;

/** Read an own field before falling back to its logical/Web API lookup alias. */
export function lookupColumnValue(row, name) {
  if (row == null) return undefined;
  if (own(row, name)) return row[name];
  const lookup = /^_(.+)_value$/.exec(name);
  if (lookup && own(row, lookup[1])) return scalar(row[lookup[1]]);
  if (!lookup && own(row, `_${name}_value`)) return row[`_${name}_value`];
  return undefined;
}

/** GUIDs compare case-insensitively with optional braces or parentheses. */
export function guidKey(value) {
  if (value == null || typeof value === 'object') return null;
  const match = DECORATED_GUID.exec(String(value));
  return match ? (match[1] ?? match[2] ?? match[3]).toLowerCase() : null;
}
const isGuid = (value) => guidKey(value) != null;

const DIACRITICS = /[̀-ͯ]/g;
/** English Dataverse databases use a case- and accent-insensitive (_CI_AI) collation. */
export function foldText(value, collation = 'CI_AI') {
  let text = String(value);
  if (!/_?AS$/i.test(collation)) text = text.normalize('NFD').replace(DIACRITICS, '');
  return text.toLowerCase();
}
/**
 * Bucket key for equality under the column collation (groupby, distinct, countdistinct, TDS comparisons): text folds
 * case and accents as foldText does, a lookup or GUID is its bare lowercase id, a number its exact canonical digits
 * (so 1, 1.0 and an exact 1 agree), null, undefined and "" are one empty key. Filters use the same folding.
 */
export function equalityKey(value, collation = 'CI_AI') {
  const raw = isExactNumeric(value) ? value : scalar(value);
  if (raw == null || raw === '') return '\u0000';
  if (isExactNumeric(raw) || typeof raw === 'number') {
    const parts = decimalParts(raw);
    return parts ? `n:${parts.coefficient}e${-parts.scale}` : `n:${raw}`;
  }
  if (typeof raw === 'boolean') return `b:${raw}`;
  const guid = guidKey(raw);
  if (guid) return `g:${guid}`;
  if (typeof raw === 'string') return `s:${foldText(raw, collation)}`;
  return `j:${JSON.stringify(raw)}`;
}
const collators = new Map();
function textCollator(collation = 'CI_AI') {
  if (!collators.has(collation))
    collators.set(
      collation,
      new Intl.Collator('en', {
        sensitivity: /_?AS$/i.test(collation) ? 'accent' : 'base',
      }),
    );
  return collators.get(collation);
}

const TYPE_KINDS = {
  nvarchar: 'string',
  string: 'string',
  text: 'string',
  entityname: 'string',
  memo: 'string',
  ntext: 'string',
  textarea: 'string',
  email: 'string',
  int: 'integer',
  integer: 'integer',
  bigint: 'integer',
  number: 'number',
  decimal: 'decimal',
  float: 'double',
  double: 'double',
  money: 'money',
  bit: 'boolean',
  boolean: 'boolean',
  twooptions: 'boolean',
  datetime: 'datetime',
  date: 'datetime',
  picklist: 'choice',
  state: 'choice',
  status: 'choice',
  choice: 'choice',
  optionset: 'choice',
  multiselectpicklist: 'multichoice',
  lookup: 'lookup',
  customer: 'lookup',
  owner: 'lookup',
  partylist: 'partylist',
  uniqueidentifier: 'guid',
  primarykey: 'guid',
  image: 'file',
  file: 'file',
  virtual: 'virtual',
};

/** Normalise imported Entity.xml/explicit schema field types into evaluator kinds. */
export function fieldKind(definition) {
  if (!definition) return null;
  const raw = String(definition.dataverseType ?? definition.type ?? '').toLowerCase();
  const kind = TYPE_KINDS[raw] ?? null;
  if (kind === 'number' && Array.isArray(definition.options)) return 'choice';
  return kind;
}
export function dateTimeBehavior(definition) {
  const value = definition?.dateTimeBehavior ?? definition?.behavior;
  const behavior = String(value?.Value ?? value ?? '').toLowerCase();
  return { 1: 'userlocal', 2: 'dateonly', 3: 'timezoneindependent' }[behavior] ?? behavior;
}
export function isDateOnlyField(definition) {
  const behavior = dateTimeBehavior(definition);
  // Format controls presentation, not storage. Keep the legacy format-only
  // schema usable when no behavior metadata was supplied.
  return behavior === 'dateonly' || (!behavior && String(definition?.format ?? '').toLowerCase() === 'dateonly');
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Edm.Date's ISO calendar reader accepts unpadded month/day, not surrounding whitespace. */
export function portalDateOnly(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!match || +match[1] === 0) return null;
  const canonical = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  return parseDateValue(canonical) ? canonical : null;
}
/** Opt-in portal conversion; direct data/query date parsing remains ISO-only. */
const MONTH_FIRST_DATE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,7})?)?\s*(AM|PM)?)?$/i; // NOSONAR: regex kept: a rewrite would change matches or captures
const ENGLISH_MONTHS = new Map(
  [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ].flatMap((name, index) => [
    [name, index + 1],
    [name.slice(0, 3), index + 1],
  ]),
);
/* NOSONAR */ export function portalMonthFirstDate(value, { twoDigitYearMax = 2049 } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const named = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})(.*)$/i.exec(trimmed);
  const text = named ? namedMonthDate(named) : trimmed;
  if (!text) return null;
  const match = MONTH_FIRST_DATE.exec(text);
  if (!match) return null;
  if (!Number.isInteger(twoDigitYearMax) || twoDigitYearMax < 99 || twoDigitYearMax > 9999) return null;
  let year = +match[3];
  if (match[3].length === 2) {
    year += Math.floor(twoDigitYearMax / 100) * 100;
    if (year > twoDigitYearMax) year -= 100;
  }
  if (year === 0) return null;
  let hour = +(match[4] ?? 0);
  if (match[8]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (match[8].toUpperCase() === 'PM' ? 12 : 0);
  }
  const pad = (text) => String(text).padStart(2, '0');
  const date = `${String(year).padStart(4, '0')}-${pad(match[1])}-${pad(match[2])}`;
  const result =
    match[4] === undefined ? date : `${date}T${pad(hour)}:${match[5]}:${match[6] ?? '00'}${match[7] ?? ''}Z`;
  return parseDateValue(result) ? result : null;
}

function namedMonthDate(named) {
  const month = ENGLISH_MONTHS.get(named[1].toLowerCase());
  return month ? `${month}/${named[2]}/${named[3]}${named[4]}` : null;
}

/** Preserve the posted literal separately from the parsed value used in CrmDateTime errors. */
export function dateTimeRangeError(value, parsed = parseDateValue(value)) {
  const year = parsed ? new Date(parsed.ms).getUTCFullYear() : null;
  const belowMinimum = parsed && year < 1753;
  return new DataError(
    `The date-time format for ${value} is invalid, or value is outside the supported range.`,
    400,
    'InvalidDateTime',
    {
      innerCode: '0x80040239',
      failedDateConversion: !parsed,
      ...(belowMinimum
        ? {
            dateTimeBelowMinimum: true,
            dateTimeActual: year < 1 ? '01/01/0001 00:00:00' : formatDotNetDate(parsed.ms, 'MM/dd/yyyy HH:mm:ss', 0),
          }
        : {}),
    },
  );
}
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-]\d{2}:?\d{2})?$/i; // NOSONAR: regex kept: a rewrite would change matches or captures

// Date.UTC treats years 0–99 as 1900–1999. Date text must retain its literal
// year so the caller can enforce the source/platform supported date range.
function calendarUtc(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

const matchesCalendar = (ms, match) => {
  const date = new Date(ms);
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3];
};

/**
 * Parse stored or literal date/time values. Values without a zone are UTC,
 * matching Dataverse storage; date-only values represent local midnight.
 */
/* NOSONAR */ export function parseDateValue(value, { timeZoneOffsetMinutes = 0 } = {}) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { ms: value.getTime(), dateOnly: false };
  const text = String(scalar(value)).trim();
  let match = ISO_DATE.exec(text);
  if (match) {
    if (+match[2] < 1 || +match[2] > 12 || +match[3] < 1 || +match[3] > 31) return null;
    const ms = calendarUtc(+match[1], +match[2] - 1, +match[3]);
    if (!matchesCalendar(ms, match)) return null;
    return { ms: ms - timeZoneOffsetMinutes * 60000, dateOnly: true };
  }
  match = ISO_DATETIME.exec(text);
  if (!match) return null;
  // Date.UTC normalizes overflowing calendar/clock components. Dataverse's
  // payload reader rejects them instead of silently moving to another instant.
  if (!validDateTimeParts(match)) return null;
  const zone = match[8];
  if (!validDateTimeZone(zone)) return null;
  const fraction = Number(`0.${match[7] ?? '0'}`) * 1000;
  let ms = calendarUtc(
    +match[1],
    +match[2] - 1,
    +match[3],
    +match[4],
    +match[5],
    +(match[6] ?? 0),
    Math.trunc(fraction),
  );
  if (!matchesCalendar(ms, match)) return null;
  if (zone && zone.toUpperCase() !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
  }
  return { ms, dateOnly: false };
}
function validDateTimeParts(match) {
  return !(
    +match[2] < 1 ||
    +match[2] > 12 ||
    +match[3] < 1 ||
    +match[3] > 31 ||
    +match[4] > 23 ||
    +match[5] > 59 ||
    +(match[6] ?? 0) > 59
  );
}
function validDateTimeZone(zone) {
  if (!zone || zone.toUpperCase() === 'Z') return true;
  const digits = zone.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2)),
    minutes = Number(digits.slice(2));
  return !(hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0));
}
export const looksLikeDate = (value) =>
  typeof value === 'string' && (ISO_DATE.test(value.trim()) || ISO_DATETIME.test(value.trim()));

/** Dataverse Web API returns UTC instants with second precision. */
export function isoUtc(ms, { dateOnly = false, timeZoneOffsetMinutes = 0 } = {}) {
  const date = new Date(dateOnly ? ms + timeZoneOffsetMinutes * 60000 : ms);
  const iso = date.toISOString();
  return dateOnly ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, 'Z');
}

/** SQL Server orders uniqueidentifier values by byte groups 10-15, 8-9, 6-7, 4-5, 0-3. */
export function sqlGuidSortKey(value) {
  const id = guidKey(value);
  if (!id) return null;
  return (
    id.slice(24, 36) +
    id.slice(19, 23) +
    id.slice(16, 18) +
    id.slice(14, 16) +
    id.slice(11, 13) +
    id.slice(9, 11) +
    id.slice(6, 8) +
    id.slice(4, 6) +
    id.slice(2, 4) +
    id.slice(0, 2)
  );
}

const booleanLiteral = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(text)) return true;
  if (['0', 'false', 'no'].includes(text)) return false;
  return null;
};

/**
 * Coerce a condition literal and stored value into one comparable domain.
 * Returns { kind, x, y } or null when the values are not comparable.
 */
function coercePair(stored, literal, { kind, collation, timeZoneOffsetMinutes } = {}) {
  const x = scalar(stored);
  const y = scalar(literal);
  if (x == null || y == null) return null;
  const numeric = () => {
    if (typeof x === 'boolean' || typeof y === 'boolean') {
      const a = booleanLiteral(x),
        b = booleanLiteral(y);
      return a == null || b == null ? null : { kind: 'number', x: Number(a), y: Number(b) };
    }
    if (
      ['decimal', 'money'].includes(kind) ||
      (kind !== 'double' && (isExactNumeric(stored) || isExactNumeric(literal)))
    ) {
      const pair = numericPair(x, y);
      return pair ? { kind: 'exact-number', ...pair } : null;
    }
    const a = Number(x),
      b = Number(y);
    return Number.isFinite(a) && Number.isFinite(b) && String(x).trim() !== '' && String(y).trim() !== ''
      ? { kind: 'number', x: a, y: b }
      : null;
  };
  const boolean = () => {
    const a = booleanLiteral(x),
      b = booleanLiteral(y);
    return a == null || b == null ? null : { kind: 'number', x: Number(a), y: Number(b) };
  };
  const date = () => {
    const a = parseDateValue(x, { timeZoneOffsetMinutes }),
      b = parseDateValue(y, { timeZoneOffsetMinutes });
    return a && b ? { kind: 'date', x: a.ms, y: b.ms } : null;
  };
  const guid = () => ({
    kind: 'guid',
    x: guidKey(x) ?? foldText(x, collation),
    y: guidKey(y) ?? foldText(y, collation),
  });
  const text = () => {
    // A decorated GUID literal still matches an undecorated stored identifier.
    const gx = guidKey(x),
      gy = guidKey(y);
    if (gx && gy) return { kind: 'guid', x: gx, y: gy };
    return { kind: 'string', x: foldText(x, collation), y: foldText(y, collation) };
  };
  switch (kind === 'lookup' ? 'guid' : kind) {
    case 'integer':
    case 'decimal':
    case 'double':
    case 'money':
    case 'number':
    case 'choice':
      return numeric();
    case 'boolean':
      return boolean();
    case 'datetime':
      return date();
    case 'guid':
      return guid();
    case 'string':
      return text();
    default:
      if (isExactNumeric(stored) || isExactNumeric(literal)) return numeric();
      if (typeof x === 'boolean') return boolean();
      if (typeof x === 'number') return numeric() ?? text();
      if (isGuid(x) && isGuid(y)) return guid();
      if (looksLikeDate(x) && looksLikeDate(y)) return date();
      return text();
  }
}

/** Equality under Dataverse collation, GUID and numeric coercions. */
export function valuesEqual(stored, literal, options) {
  const pair = coercePair(stored, literal, options);
  return pair ? pair.x === pair.y : false;
}
/** Ordering comparison for gt/ge/lt/le; NaN when not comparable. */
export function compareForFilter(stored, literal, options = {}) {
  const pair = coercePair(stored, literal, options);
  if (!pair) return Number.NaN;
  if (pair.kind === 'string')
    return textCollator(options.collation).compare(String(scalar(stored)), String(scalar(literal)));
  if (pair.x < pair.y) return -1;
  if (pair.x > pair.y) return 1;
  return 0;
}

// Static $filter operand typing (Dataverse Web API): the EDM type a column reads as, and the family
// (text, number, boolean, datetime) that decides whether a comparison can ever match. Guid and
// lookup operands are not checked, so they return null.
const EDM_COLUMN = new Map([
  ...['nvarchar', 'string', 'text', 'memo', 'ntext', 'textarea', 'email', 'entityname'].map((t) => [t, 'Edm.String']),
  ...['int', 'integer', 'picklist', 'state', 'status', 'choice', 'optionset'].map((t) => [t, 'Edm.Int32']),
  ['bigint', 'Edm.Int64'],
  ...['decimal', 'money'].map((t) => [t, 'Edm.Decimal']),
  ...['float', 'double'].map((t) => [t, 'Edm.Double']),
  ...['bit', 'boolean', 'twooptions'].map((t) => [t, 'Edm.Boolean']),
  ...['datetime', 'date'].map((t) => [t, 'Edm.DateTimeOffset']),
  ['uniqueidentifier', 'Edm.Guid'],
  ['primarykey', 'Edm.Guid'],
]);
const EDM_FAMILY = new Map([
  ['Edm.String', 'text'],
  ['Edm.Int32', 'number'],
  ['Edm.Int64', 'number'],
  ['Edm.Decimal', 'number'],
  ['Edm.Double', 'number'],
  ['Edm.Single', 'number'],
  ['Edm.Boolean', 'boolean'],
  ['Edm.DateTimeOffset', 'datetime'],
  ['Edm.Date', 'datetime'],
]);
export const edmFamily = (edm) => EDM_FAMILY.get(edm) ?? null;
export function edmOfColumn(definition) {
  const raw = String(definition?.dataverseType ?? definition?.type ?? '').toLowerCase();
  const edm = EDM_COLUMN.get(raw) ?? null;
  // A DateOnly column (behaviour, or format when no behaviour is declared) reads as Edm.Date, not DateTimeOffset.
  if (
    edm === 'Edm.DateTimeOffset' &&
    (isDateOnlyField(definition) || /^dateonly$/i.test(String(definition?.format ?? '')))
  )
    return 'Edm.Date';
  return edm;
}
/** EDM type of a parsed literal node (kind string|number|boolean|datetime|guid|null; number nodes carry raw text). */
export function edmOfLiteral(literal) {
  switch (literal?.kind) {
    case 'string':
      return 'Edm.String';
    case 'boolean':
      return 'Edm.Boolean';
    case 'datetime':
      return String(literal.value).includes('T') ? 'Edm.DateTimeOffset' : 'Edm.Date';
    case 'guid':
      return 'Edm.Guid';
    case 'number': {
      const raw = String(literal.raw ?? literal.value);
      if (/[fF]$/.test(raw)) return 'Edm.Single';
      if (/[dDeE]/.test(raw)) return 'Edm.Double';
      if (/[mM]$|\./.test(raw)) return 'Edm.Decimal';
      if (/[lL]$/.test(raw) || Math.abs(Number(raw.replace(/[lL]$/, ''))) > 2147483647) return 'Edm.Int64';
      return 'Edm.Int32';
    }
    default:
      return null;
  }
}

const choiceLabelOf = (definition, value) =>
  Array.isArray(definition?.options)
    ? definition.options.find((option) => Number(option.value) === Number(value))?.label
    : undefined;

/**
 * Sort keys follow Dataverse ordering: lookups by the related primary name,
 * choices by label (unless raw ordering is requested), GUIDs in SQL Server
 * uniqueidentifier order, and nulls first in ascending order.
 */
export function makeSortKey(value, { definition, rawChoice = false, lookupName, timeZoneOffsetMinutes = 0 } = {}) {
  if (value == null) return null;
  const kind = fieldKind(definition);
  if (isExactNumeric(value)) return { t: 'n', v: value };
  if (
    ['integer', 'decimal', 'money', 'double', 'number'].includes(kind) &&
    typeof value === 'string' &&
    decimalParts(value)
  )
    return { t: 'n', v: parseNumericLiteral(value) };
  if (typeof value === 'object' && !Array.isArray(value))
    return objectSortKey(value, definition, rawChoice, lookupName);
  return primitiveSortKey(value, kind, definition, rawChoice, lookupName, timeZoneOffsetMinutes);
}

function primitiveSortKey(value, kind, definition, rawChoice, lookupName, timeZoneOffsetMinutes) {
  if (kind === 'choice' && !rawChoice) {
    const label = choiceLabelOf(definition, value);
    if (label != null) return { t: 's', v: String(label) };
  }
  if (kind === 'lookup' && lookupName) {
    const name = lookupName({ id: value });
    if (name != null) return { t: 's', v: String(name) };
  }
  if (typeof value === 'number') return { t: 'n', v: value };
  if (typeof value === 'boolean') return { t: 'n', v: Number(value) };
  const guid = sqlGuidSortKey(value);
  if (guid) return { t: 'g', v: guid };
  if (kind === 'datetime' || looksLikeDate(value)) {
    const parsed = parseDateValue(value, { timeZoneOffsetMinutes });
    if (parsed) return { t: 'n', v: parsed.ms };
  }
  return { t: 's', v: String(value) };
}
function objectSortKey(value, definition, rawChoice, lookupName) {
  if (own(value, 'id')) {
    const name = lookupName ? lookupName(value) : value.name;
    if (name != null) return { t: 's', v: String(name) };
    return { t: 'g', v: sqlGuidSortKey(value.id) ?? String(value.id) };
  }
  if (!own(value, 'value')) return { t: 's', v: JSON.stringify(value) };
  if (!rawChoice) {
    const label = value.label ?? choiceLabelOf(definition, value.value);
    if (label != null) return { t: 's', v: String(label) };
  }
  const number = Number(value.value);
  return Number.isFinite(number) ? { t: 'n', v: number } : { t: 's', v: String(value.value) };
}
export function compareSortKeys(a, b, collation = 'CI_AI') {
  if (a == null || b == null) return compareNullSortKeys(a, b);
  if (a.t === b.t) return compareMatchingSortKeys(a, b, collation);
  return a.t < b.t ? -1 : 1;
}
function compareNullSortKeys(a, b) {
  if (a == null) {
    if (b == null) return 0;
    return -1;
  }
  return 1;
}
function compareMatchingSortKeys(a, b, collation) {
  if (a.t === 's') return textCollator(collation).compare(a.v, b.v);
  if (a.t === 'n' && (isExactNumeric(a.v) || isExactNumeric(b.v))) return compareNumeric(a.v, b.v);
  if (a.v < b.v) return -1;
  if (a.v > b.v) return 1;
  return 0;
}

/** SQL LIKE pattern (%, _, [set], [^set], [%] literals) as an anchored matcher. */
export function likeMatcher(pattern, collation = 'CI_AI') {
  const tokens = likeTokens(foldText(pattern ?? '', collation), { brackets: 'matcher' });
  if (tokens === null) return () => false;
  return (value) => value != null && likeTokensMatch(tokens, foldText(scalar(value), collation));
}

const LIKE_ANY = { any: true };
const LIKE_ONE = { one: true };
const LIKE_LITERAL = Symbol('literal');
const LIKE_INVALID = Symbol('invalid');
const identityFold = (text) => text;
const escapeLikeChar = (char) => char.replace(/[.*+?^${}()|[\]\\/-]/g, String.raw`\$&`);

/**
 * Compiles a LIKE pattern into tokens: { any: true } for a run of %, { one: true } for _, { test(char) } for a
 * [set], and { char } for a literal. `escape` (one character or null) makes the next pattern character literal.
 * `fold` maps each literal and set member (it may expand one character into several). `ignoreCase` compares
 * literals and sets as a case-insensitive regular expression does. `brackets` selects where [ opens a set:
 * 'sql' (a ] at least two units later), 'matcher' (any later ]; an empty set never matches) or 'pattern' (as 'sql',
 * with [^] matching any character). Returns null when the pattern can never match.
 */
export function likeTokens(pattern, { escape = null, fold = identityFold, ignoreCase = false, brackets = 'sql' } = {}) {
  const tokens = [];
  const literal = (text) => {
    for (let k = 0; k < text.length; k++) {
      const char = text[k];
      tokens.push(ignoreCase ? { test: caseClassTest(escapeLikeChar(char), true) } : { char });
    }
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (escape !== null && c === escape) {
      if (i + 1 === pattern.length) return null;
      literal(fold(pattern[++i]));
    } else if (c === '%') {
      if (tokens.at(-1) !== LIKE_ANY) tokens.push(LIKE_ANY);
    } else if (c === '_') tokens.push(LIKE_ONE);
    else if (c === '[') {
      const set = likeSetAt(pattern, i, escape, fold, brackets);
      if (set === LIKE_INVALID) return null;
      if (set === LIKE_LITERAL) literal(fold(c));
      else {
        tokens.push({ test: caseClassTest(set.source, ignoreCase) });
        i = set.end; // NOSONAR: loop cursor is advanced in the body on purpose
      }
    } else literal(fold(c));
  }
  return tokens;
}

// Ranges are read from escaped class text: an escape is one atom, an unescaped - between two atoms is a range.
// A range whose start is above its end matches no character, so it is dropped and the other members still apply.
// Every dash that is kept is written escaped, so dropping a range cannot turn a literal dash into a range operator.
function withoutBackwardRanges(body) {
  const atoms = [];
  for (let k = 0; k < body.length; k++) {
    const escaped = body[k] === '\\' && k + 1 < body.length;
    atoms.push({
      text: escaped ? body.slice(k, k + 2) : body[k],
      code: (escaped ? body[k + 1] : body[k]).charCodeAt(0),
    });
    if (escaped) k++;
  }
  const kept = (atom) => (atom.text === '-' ? String.raw`\-` : atom.text);
  let out = '';
  for (let k = 0; k < atoms.length; k++) {
    if (k + 2 < atoms.length && atoms[k + 1].text === '-') {
      if (atoms[k].code <= atoms[k + 2].code) out += `${kept(atoms[k])}-${kept(atoms[k + 2])}`;
      k += 2;
    } else out += kept(atoms[k]);
  }
  return out;
}

function likeSetAt(pattern, index, escape, fold, brackets) {
  const close = pattern.indexOf(']', index + 1);
  if (brackets === 'matcher') {
    if (close < 0) return LIKE_LITERAL;
    let body = pattern.slice(index + 1, close);
    if (!body || body === '^') return LIKE_INVALID;
    const negate = body.length > 1 && body.startsWith('^');
    if (negate) body = body.slice(1);
    const escapedBody = body.replace(/[\\\]^]/g, String.raw`\$&`);
    return { source: `[${negate ? '^' : ''}${withoutBackwardRanges(escapedBody)}]`, end: close };
  }
  if (close <= index + 1) return LIKE_LITERAL;
  if (brackets === 'pattern') {
    const negate = pattern[index + 1] === '^';
    const body = pattern.slice(index + 1 + (negate ? 1 : 0), close).replace(/[\\\][]/g, String.raw`\$&`);
    return { source: `[${negate ? '^' : ''}${withoutBackwardRanges(body)}]`, end: close };
  }
  return sqlSetAt(pattern, index, escape, fold);
}

function sqlSetAt(pattern, index, escape, fold) {
  let end = index + 1;
  const negate = pattern[end] === '^' && escape !== '^';
  if (negate) end++;
  let set = '';
  for (; end < pattern.length && pattern[end] !== ']'; end++) {
    const escaped = escape !== null && pattern[end] === escape;
    if (escaped && ++end === pattern.length) return LIKE_INVALID;
    const member = fold(pattern[end]).replace(/[\\[\]^]/g, String.raw`\$&`);
    set += escaped ? member.replaceAll('-', String.raw`\-`) : member;
  }
  if (end === pattern.length || !set) return LIKE_INVALID;
  return { source: `[${negate ? '^' : ''}${withoutBackwardRanges(set)}]`, end };
}

const caseClassTests = new Map();
function caseClassTest(source, ignoreCase) {
  const key = `${ignoreCase ? 1 : 0}:${source}`;
  if (!caseClassTests.has(key)) {
    // ponytail: cleared when full; an LRU is the upgrade if pattern variety ever shows in profiles.
    if (caseClassTests.size >= 4096) caseClassTests.clear();
    const expression = new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
    caseClassTests.set(key, (char) => expression.test(char));
  }
  return caseClassTests.get(key);
}

const likeConsumes = (token, char) => token.one === true || (token.test ? token.test(char) : token.char === char);

/**
 * Whole-string LIKE match of already folded text against tokens, in O(text length × token count) time: the last
 * % seen is the only backtrack point, so no pattern can make matching take exponential time.
 */
export function likeTokensMatch(tokens, text) {
  let t = 0;
  let p = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    const token = tokens[p];
    if (token === LIKE_ANY) {
      starP = p;
      starT = t;
      p++;
    } else if (token && likeConsumes(token, text[t])) {
      p++;
      t++;
    } else if (starP >= 0) {
      p = starP + 1;
      t = ++starT;
    } else return false;
  }
  while (p < tokens.length && tokens[p] === LIKE_ANY) p++;
  return p === tokens.length;
}

/**
 * Leftmost start at which the tokens match the rest of the text to its end, or -1. One pass keeps, for each token
 * position, the smallest start still alive; starts that reach the same position behave identically afterwards.
 */
export function likeTokensSuffixStart(tokens, text) {
  const last = tokens.length;
  let best = new Array(last + 1).fill(Infinity);
  for (let t = 0; t <= text.length; t++) {
    best[0] = Math.min(best[0], t);
    for (let p = 0; p < last; p++) if (tokens[p] === LIKE_ANY) best[p + 1] = Math.min(best[p + 1], best[p]);
    if (t === text.length) return best[last] === Infinity ? -1 : best[last];
    const next = new Array(last + 1).fill(Infinity);
    for (let p = 0; p < last; p++) {
      if (tokens[p] === LIKE_ANY) next[p] = Math.min(next[p], best[p]);
      else if (best[p] !== Infinity && likeConsumes(tokens[p], text[t])) next[p + 1] = Math.min(next[p + 1], best[p]);
    }
    best = next;
  }
  return -1;
}

const DAY = 86400000;
const startOfLocalDay = (ms, offset) => {
  const local = ms + offset * 60000;
  return local - (((local % DAY) + DAY) % DAY) - offset * 60000;
};
const localParts = (ms, offset) => {
  const d = new Date(ms + offset * 60000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  };
};
const localMidnight = (year, month, day, offset) => Date.UTC(year, month, day) - offset * 60000;
const addMonths = (ms, months, offset) => {
  const p = localParts(ms, offset);
  const time = ms - localMidnight(p.year, p.month, p.day, offset);
  const target = new Date(Date.UTC(p.year, p.month + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return localMidnight(target.getUTCFullYear(), target.getUTCMonth(), Math.min(p.day, last), offset) + time;
};

const positiveInteger = (value, operator) => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1)
    throw new DataError(`${operator} requires a positive integer value`, 400, 'InvalidQuery');
  return Number(text);
};

/**
 * Relative and calendar datetime operators return a predicate over instants.
 * `now` is supplied by the caller so one query evaluates against one clock. Fiscal
 * operators use the organisation fiscal calendar (`fiscal`: a calendar or the query
 * settings, lib/fiscal-calendar.mjs); `fiscalPeriods` is the earlier periods-per-year form.
 */
export function dateOperatorPredicate(
  operator,
  values,
  { now = Date.now(), timeZoneOffsetMinutes: offset = 0, fiscal, fiscalPeriods } = {},
) {
  if (FISCAL_OPERATORS.has(operator))
    return fiscalOperatorPredicate(operator, values, {
      now,
      offset,
      calendar: fiscalCalendar(fiscal ?? { fiscalPeriodsPerYear: fiscalPeriods }),
    });
  const sod = startOfLocalDay(now, offset);
  const parts = localParts(now, offset);
  const range = (start, end) => (ms) => ms >= start && ms < end;
  const upTo = (start, end) => (ms) => ms >= start && ms <= end;
  const n = () => positiveInteger(values[0], operator);
  const weekStart = sod - parts.weekday * DAY;
  const monthStart = localMidnight(parts.year, parts.month, 1, offset);
  const yearStart = localMidnight(parts.year, 0, 1, offset);
  switch (operator) {
    case 'today':
      return range(sod, sod + DAY);
    case 'yesterday':
      return range(sod - DAY, sod);
    case 'tomorrow':
      return range(sod + DAY, sod + 2 * DAY);
    case 'last-seven-days':
      return upTo(sod - 7 * DAY, now);
    case 'next-seven-days':
      return upTo(now, sod + 8 * DAY - 1);
    case 'last-x-hours':
      return upTo(now - n() * 3600000, now);
    case 'next-x-hours':
      return upTo(now, now + n() * 3600000);
    case 'last-x-days':
      return upTo(sod - n() * DAY, now);
    case 'next-x-days':
      return upTo(now, sod + (n() + 1) * DAY - 1);
    case 'last-x-weeks':
      return upTo(sod - 7 * n() * DAY, now);
    case 'next-x-weeks':
      return upTo(now, sod + (7 * n() + 1) * DAY - 1);
    case 'last-x-months':
      return upTo(addMonths(sod, -n(), offset), now);
    case 'next-x-months':
      return upTo(now, addMonths(sod, n(), offset) + DAY - 1);
    case 'last-x-years':
      return upTo(addMonths(sod, -12 * n(), offset), now);
    case 'next-x-years':
      return upTo(now, addMonths(sod, 12 * n(), offset) + DAY - 1);
    case 'olderthan-x-minutes':
      return (
        (limit) => (ms) =>
          ms < limit
      )(now - n() * 60000);
    case 'olderthan-x-hours':
      return (
        (limit) => (ms) =>
          ms < limit
      )(now - n() * 3600000);
    case 'olderthan-x-days':
      return (
        (limit) => (ms) =>
          ms < limit
      )(now - n() * DAY);
    case 'olderthan-x-weeks':
      return (
        (limit) => (ms) =>
          ms < limit
      )(now - 7 * n() * DAY);
    case 'olderthan-x-months':
      return (
        (limit) => (ms) =>
          ms < limit
      )(addMonths(now, -n(), offset));
    case 'olderthan-x-years':
      return (
        (limit) => (ms) =>
          ms < limit
      )(addMonths(now, -12 * n(), offset));
    case 'this-week':
      return range(weekStart, weekStart + 7 * DAY);
    case 'last-week':
      return range(weekStart - 7 * DAY, weekStart);
    case 'next-week':
      return range(weekStart + 7 * DAY, weekStart + 14 * DAY);
    case 'this-month':
      return range(monthStart, addMonths(monthStart, 1, offset));
    case 'last-month':
      return range(addMonths(monthStart, -1, offset), monthStart);
    case 'next-month':
      return range(addMonths(monthStart, 1, offset), addMonths(monthStart, 2, offset));
    case 'this-year':
      return range(yearStart, localMidnight(parts.year + 1, 0, 1, offset));
    case 'last-year':
      return range(localMidnight(parts.year - 1, 0, 1, offset), yearStart);
    case 'next-year':
      return range(localMidnight(parts.year + 1, 0, 1, offset), localMidnight(parts.year + 2, 0, 1, offset));
    default:
      return null;
  }
}
export const DATE_OPERATORS = new Set([
  'today',
  'yesterday',
  'tomorrow',
  'last-seven-days',
  'next-seven-days',
  'last-x-hours',
  'next-x-hours',
  'last-x-days',
  'next-x-days',
  'last-x-weeks',
  'next-x-weeks',
  'last-x-months',
  'next-x-months',
  'last-x-years',
  'next-x-years',
  'olderthan-x-minutes',
  'olderthan-x-hours',
  'olderthan-x-days',
  'olderthan-x-weeks',
  'olderthan-x-months',
  'olderthan-x-years',
  'this-week',
  'last-week',
  'next-week',
  'this-month',
  'last-month',
  'next-month',
  'this-year',
  'last-year',
  'next-year',
  'this-fiscal-year',
  'last-fiscal-year',
  'next-fiscal-year',
  'this-fiscal-period',
  'last-fiscal-period',
  'next-fiscal-period',
  'last-x-fiscal-years',
  'next-x-fiscal-years',
  'last-x-fiscal-periods',
  'next-x-fiscal-periods',
  'in-fiscal-year',
  'in-fiscal-period',
  'in-fiscal-period-and-year',
  'in-or-before-fiscal-period-and-year',
  'in-or-after-fiscal-period-and-year',
]);
/** Operators that need hour/minute precision cannot target DateOnly columns. */
export const TIME_PRECISION_OPERATORS = new Set([
  'last-x-hours',
  'next-x-hours',
  'olderthan-x-hours',
  'olderthan-x-minutes',
]);

/** Local calendar date (ms at local midnight) for on/on-or-before/on-or-after. */
export function localDay(value, { timeZoneOffsetMinutes = 0 } = {}) {
  const parsed = parseDateValue(value, { timeZoneOffsetMinutes });
  return parsed ? startOfLocalDay(parsed.ms, timeZoneOffsetMinutes) : null;
}

/** SQL DATEPART(week) style week number: Sunday-start weeks with January 1 in week 1. */
function weekOfYear(ms, offset = 0) {
  const p = localParts(ms, offset);
  const jan1 = new Date(Date.UTC(p.year, 0, 1));
  const dayOfYear = Math.floor((Date.UTC(p.year, p.month, p.day) - jan1.getTime()) / DAY);
  return Math.floor((dayOfYear + jan1.getUTCDay()) / 7) + 1;
}
export function dateGroupValue(value, grouping, { timeZoneOffsetMinutes = 0, fiscal, fiscalPeriods } = {}) {
  const parsed = parseDateValue(value, { timeZoneOffsetMinutes });
  if (!parsed) return null;
  const p = localParts(parsed.ms, timeZoneOffsetMinutes);
  switch (grouping) {
    case 'day':
      return p.day;
    case 'week':
      return weekOfYear(parsed.ms, timeZoneOffsetMinutes);
    case 'month':
      return p.month + 1;
    case 'quarter':
      return Math.floor(p.month / 3) + 1;
    case 'year':
      return p.year;
    case 'fiscal-period':
    case 'fiscal-year': {
      const calendar = fiscalCalendar(fiscal ?? { fiscalPeriodsPerYear: fiscalPeriods });
      const at = fiscalPeriodOf(calendar, parsed.ms, timeZoneOffsetMinutes);
      return grouping === 'fiscal-period' ? at.period : at.year;
    }
    default:
      throw new DataError(`Unsupported FetchXML dategrouping ${grouping}`, 400, 'UnsupportedQuery');
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STANDARD_FORMATS = {
  d: 'M/d/yyyy',
  D: 'dddd, MMMM d, yyyy',
  t: 'h:mm tt',
  T: 'h:mm:ss tt',
  g: 'M/d/yyyy h:mm tt',
  G: 'M/d/yyyy h:mm:ss tt',
  f: 'dddd, MMMM d, yyyy h:mm tt',
  F: 'dddd, MMMM d, yyyy h:mm:ss tt',
};
/** .NET custom date and time format strings (the subset used by site settings). */
export function formatDotNetDate(ms, format, offset = 0) {
  const pattern = STANDARD_FORMATS[format] ?? format;
  const d = new Date(ms + offset * 60000);
  const values = {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millisecond: d.getUTCMilliseconds(),
  };
  const pad = (value, width) => String(value).padStart(width, '0');
  let out = '';
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i];
    if (c === "'" || c === '"') {
      const quoted = quotedFormatText(pattern, i, c);
      out += quoted.text;
      i = quoted.next;
      continue;
    }
    if (c === '\\') {
      out += pattern[i + 1] ?? '';
      i += 2;
      continue;
    }
    let run = 1;
    while (pattern[i + run] === c) run++;
    out += formatDateToken(c, run, values, pad);
    i += run;
  }
  return out;
}

function quotedFormatText(pattern, index, quote) {
  const end = pattern.indexOf(quote, index + 1);
  return {
    text: pattern.slice(index + 1, end < 0 ? pattern.length : end),
    next: end < 0 ? pattern.length : end + 1,
  };
}

function formatDateToken(c, run, values, pad) {
  const h12 = values.hour % 12 || 12;
  switch (c) {
    case 'y':
      return run <= 2 ? pad(values.year % 100, run) : pad(values.year, run);
    case 'M':
      if (run >= 4) return MONTHS[values.month - 1];
      if (run === 3) return MONTHS[values.month - 1].slice(0, 3);
      return pad(values.month, run);
    case 'd':
      if (run >= 4) return DAYS[values.weekday];
      if (run === 3) return DAYS[values.weekday].slice(0, 3);
      return pad(values.day, run);
    case 'H':
      return pad(values.hour, Math.min(run, 2));
    case 'h':
      return pad(h12, Math.min(run, 2));
    case 'm':
      return pad(values.minute, Math.min(run, 2));
    case 's':
      return pad(values.second, Math.min(run, 2));
    case 'f':
    case 'F':
      return pad(values.millisecond, 3).slice(0, run);
    case 't':
      return (values.hour < 12 ? 'AM' : 'PM').slice(0, run === 1 ? 1 : 2);
    default:
      return c.repeat(run);
  }
}

const numberFormats = new Map();
const formatNumber = (value, digits) => {
  const key = String(digits);
  if (!numberFormats.has(key))
    numberFormats.set(
      key,
      new Intl.NumberFormat('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }),
    );
  return numberFormats.get(key).format(value);
};
const optionLabel = (definition, value) => choiceLabelOf(definition, value);

/**
 * Formatted values follow Dataverse's defaults for the calling user (en-US),
 * optionally overridden by explicit simulator formatting settings.
 */
export function formattedValue(value, definition, settings = {}) {
  if (value == null) return undefined;
  if (isExactNumeric(value)) return formattedExactNumeric(value, definition, settings);
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (own(value, 'label') && value.label != null) return String(value.label);
    if (own(value, 'name') && own(value, 'id')) return value.name ?? undefined;
    value = scalar(value);
  }
  return formattedByKind(value, definition, settings, fieldKind(definition));
}

function formattedExactNumeric(value, definition, settings) {
  const kind = fieldKind(definition);
  let digits;
  if (kind === 'integer') digits = 0;
  else if (Number.isInteger(definition?.precision)) digits = definition.precision;
  else digits = 2;
  return (
    (kind === 'money' ? (settings.currencySymbol ?? definition?.currencySymbol ?? '') : '') +
    formatExactNumeric(value, digits)
  );
}

/* NOSONAR */ function formattedByKind(value, definition, settings, kind) {
  switch (kind) {
    case 'choice':
      return optionLabel(definition, value);
    case 'multichoice': {
      const items = (Array.isArray(value) ? value : String(value).split(','))
        .map((item) => optionLabel(definition, item))
        .filter((label) => label != null);
      return items.length ? items.join('; ') : undefined;
    }
    case 'boolean': {
      const flag = booleanLiteral(value);
      if (flag == null) return undefined;
      return optionLabel(definition, Number(flag)) ?? (flag ? 'Yes' : 'No');
    }
    case 'integer':
      return typeof value === 'number' ? formatNumber(value, 0) : undefined;
    case 'decimal':
    case 'double': {
      if (typeof value !== 'number') return undefined;
      const digits = Number.isInteger(definition?.precision) ? definition.precision : 2;
      return formatNumber(value, digits);
    }
    case 'money': {
      if (typeof value !== 'number') return undefined;
      const digits = Number.isInteger(definition?.precision) ? definition.precision : 2;
      return `${settings.currencySymbol ?? definition?.currencySymbol ?? ''}${formatNumber(value, digits)}`;
    }
    case 'datetime': {
      return formattedDateTime(value, definition, settings);
    }
    default:
      if (Array.isArray(definition?.options) && typeof value === 'number') return optionLabel(definition, value);
      return undefined;
  }
}

function formattedDateTime(value, definition, settings) {
  const parsed = parseDateValue(value);
  if (!parsed) return undefined;
  const behavior = dateTimeBehavior(definition);
  const dateOnly = isDateOnlyField(definition) || /^(date|dateonly)$/i.test(String(definition?.format ?? ''));
  const offsetAt = settings.timeZoneOffsetAt ?? compileFormattedTimeZone(settings.formattedValueTimeZone);
  let offset;
  if (isDateOnlyField(definition) || behavior === 'timezoneindependent') offset = 0;
  else if (offsetAt) offset = offsetAt(parsed.ms);
  else offset = Number(settings.timeZoneOffsetMinutes ?? 0);
  return formatDotNetDate(
    parsed.ms,
    dateOnly
      ? (settings.dateFormat ?? 'M/d/yyyy')
      : (settings.dateTimeFormat ?? `${settings.dateFormat ?? 'M/d/yyyy'} ${settings.timeFormat ?? 'h:mm tt'}`),
    offset,
  );
}

/**
 * Primary name column of a table: the mapping's nameColumn, the metadata
 * column flagged isPrimaryName, Dataverse's <prefix>_name convention for
 * custom and portal tables, then "name". Values fall back to name/fullname.
 */
function primaryNameColumn(mapping, logicalName = mapping?.logicalName) {
  if (mapping?.nameColumn) return mapping.nameColumn;
  for (const fields of [mapping?.fields, mapping?.fieldMetadata])
    if (fields && typeof fields === 'object')
      for (const [name, definition] of Object.entries(fields)) if (definition?.isPrimaryName) return name;
  const prefix = /^([a-z][a-z0-9]*)_/i.exec(String(logicalName ?? ''))?.[1];
  return prefix ? `${prefix}_name` : 'name';
}
export function primaryNameValue(mapping, row, logicalName) {
  if (!row) return undefined;
  return row[primaryNameColumn(mapping, logicalName)] ?? row.name ?? row.fullname ?? undefined;
}
