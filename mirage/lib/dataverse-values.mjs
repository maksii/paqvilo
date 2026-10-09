// Dataverse value semantics shared by the FetchXML and OData evaluators.
// Evidence for each rule is recorded in docs/dataverse-parity.md.
import { DataError } from "./data-error.mjs";
import { FISCAL_OPERATORS, fiscalCalendar, fiscalOperatorPredicate, fiscalPeriodOf } from "./fiscal-calendar.mjs";

export const own = (obj, key) =>
  obj != null && Object.prototype.hasOwnProperty.call(obj, key);

const GUID_BODY = "[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}";
export const GUID_PATTERN = new RegExp(`^${GUID_BODY}$`, "i");
const DECORATED_GUID = new RegExp(
  `^\\s*(?:\\{(${GUID_BODY})\\}|\\((${GUID_BODY})\\)|(${GUID_BODY}))\\s*$`,
  "i",
);

/** Lookup references, choice wrappers and plain values compare by their stored scalar. */
export const scalar = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value.id ?? value.value ?? value)
    : value;

/** GUIDs compare case-insensitively with optional braces or parentheses. */
export function guidKey(value) {
  if (value == null || typeof value === "object") return null;
  const match = DECORATED_GUID.exec(String(value));
  return match ? (match[1] ?? match[2] ?? match[3]).toLowerCase() : null;
}
export const isGuid = (value) => guidKey(value) != null;

const DIACRITICS = /[̀-ͯ]/g;
/** English Dataverse databases use a case- and accent-insensitive (_CI_AI) collation. */
export function foldText(value, collation = "CI_AI") {
  let text = String(value);
  if (!/_?AS$/i.test(collation))
    text = text.normalize("NFD").replace(DIACRITICS, "");
  return text.toLowerCase();
}
const collators = new Map();
export function textCollator(collation = "CI_AI") {
  if (!collators.has(collation))
    collators.set(
      collation,
      new Intl.Collator("en", {
        sensitivity: /_?AS$/i.test(collation) ? "accent" : "base",
      }),
    );
  return collators.get(collation);
}

const TYPE_KINDS = {
  nvarchar: "string",
  string: "string",
  text: "string",
  entityname: "string",
  memo: "string",
  ntext: "string",
  textarea: "string",
  email: "string",
  int: "integer",
  integer: "integer",
  bigint: "integer",
  number: "number",
  decimal: "decimal",
  float: "double",
  double: "double",
  money: "money",
  bit: "boolean",
  boolean: "boolean",
  twooptions: "boolean",
  datetime: "datetime",
  date: "datetime",
  picklist: "choice",
  state: "choice",
  status: "choice",
  choice: "choice",
  optionset: "choice",
  multiselectpicklist: "multichoice",
  lookup: "lookup",
  customer: "lookup",
  owner: "lookup",
  partylist: "partylist",
  uniqueidentifier: "guid",
  primarykey: "guid",
  image: "file",
  file: "file",
  virtual: "virtual",
};

/** Normalise imported Entity.xml/explicit schema field types into evaluator kinds. */
export function fieldKind(definition) {
  if (!definition) return null;
  const raw = String(
    definition.dataverseType ?? definition.type ?? "",
  ).toLowerCase();
  const kind = TYPE_KINDS[raw] ?? null;
  if (kind === "number" && Array.isArray(definition.options)) return "choice";
  return kind;
}
export function isDateOnlyField(definition) {
  if (!definition) return false;
  const behavior = String(
    definition.dateTimeBehavior ?? definition.behavior ?? "",
  ).toLowerCase();
  const format = String(definition.format ?? "").toLowerCase();
  return (
    behavior === "dateonly" ||
    behavior === "2" ||
    (format === "dateonly" && behavior !== "userlocal")
  );
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Parse stored or literal date/time values. Values without a zone are UTC,
 * matching Dataverse storage; date-only values represent local midnight.
 */
export function parseDateValue(value, { timeZoneOffsetMinutes = 0 } = {}) {
  if (value == null || value === "") return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime())
      ? null
      : { ms: value.getTime(), dateOnly: false };
  const text = String(scalar(value)).trim();
  let match = ISO_DATE.exec(text);
  if (match) {
    const ms = Date.UTC(+match[1], +match[2] - 1, +match[3]);
    if (Number.isNaN(ms) || new Date(ms).getUTCDate() !== +match[3]) return null;
    return { ms: ms - timeZoneOffsetMinutes * 60000, dateOnly: true };
  }
  match = ISO_DATETIME.exec(text);
  if (!match) return null;
  const fraction = Number(`0.${match[7] ?? "0"}`) * 1000;
  let ms = Date.UTC(
    +match[1],
    +match[2] - 1,
    +match[3],
    +match[4],
    +match[5],
    +(match[6] ?? 0),
    Math.round(fraction),
  );
  if (Number.isNaN(ms) || new Date(ms).getUTCDate() !== +match[3]) return null;
  const zone = match[8];
  if (zone && zone.toUpperCase() !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
  }
  return { ms, dateOnly: false };
}
export const looksLikeDate = (value) =>
  typeof value === "string" &&
  (ISO_DATE.test(value.trim()) || ISO_DATETIME.test(value.trim()));

/** Dataverse Web API returns UTC instants with second precision. */
export function isoUtc(ms, { dateOnly = false, timeZoneOffsetMinutes = 0 } = {}) {
  const date = new Date(dateOnly ? ms + timeZoneOffsetMinutes * 60000 : ms);
  const iso = date.toISOString();
  return dateOnly ? iso.slice(0, 10) : iso.replace(/\.\d{3}Z$/, "Z");
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
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(text)) return true;
  if (["0", "false", "no"].includes(text)) return false;
  return null;
};

/**
 * Coerce a condition literal and stored value into one comparable domain.
 * Returns { kind, x, y } or null when the values are not comparable.
 */
export function coercePair(stored, literal, { kind, collation, timeZoneOffsetMinutes } = {}) {
  const x = scalar(stored);
  const y = scalar(literal);
  if (x == null || y == null) return null;
  const numeric = () => {
    if (typeof x === "boolean" || typeof y === "boolean") {
      const a = booleanLiteral(x),
        b = booleanLiteral(y);
      return a == null || b == null ? null : { kind: "number", x: Number(a), y: Number(b) };
    }
    const a = Number(x),
      b = Number(y);
    return Number.isFinite(a) && Number.isFinite(b) && String(x).trim() !== "" && String(y).trim() !== ""
      ? { kind: "number", x: a, y: b }
      : null;
  };
  const boolean = () => {
    const a = booleanLiteral(x),
      b = booleanLiteral(y);
    return a == null || b == null ? null : { kind: "number", x: Number(a), y: Number(b) };
  };
  const date = () => {
    const a = parseDateValue(x, { timeZoneOffsetMinutes }),
      b = parseDateValue(y, { timeZoneOffsetMinutes });
    return a && b ? { kind: "date", x: a.ms, y: b.ms } : null;
  };
  const guid = () => ({
    kind: "guid",
    x: guidKey(x) ?? foldText(x, collation),
    y: guidKey(y) ?? foldText(y, collation),
  });
  const text = () => {
    // A decorated GUID literal still matches an undecorated stored identifier.
    const gx = guidKey(x),
      gy = guidKey(y);
    if (gx && gy) return { kind: "guid", x: gx, y: gy };
    return { kind: "string", x: foldText(x, collation), y: foldText(y, collation) };
  };
  switch (kind === "lookup" ? "guid" : kind) {
    case "integer":
    case "decimal":
    case "double":
    case "money":
    case "number":
    case "choice":
      return numeric();
    case "boolean":
      return boolean();
    case "datetime":
      return date();
    case "guid":
      return guid();
    case "string":
      return text();
    default:
      if (typeof x === "boolean") return boolean();
      if (typeof x === "number") return numeric() ?? text();
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
  if (!pair) return NaN;
  if (pair.kind === "string")
    return textCollator(options.collation).compare(String(scalar(stored)), String(scalar(literal)));
  return pair.x < pair.y ? -1 : pair.x > pair.y ? 1 : 0;
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
  if (typeof value === "object" && !Array.isArray(value)) {
    if (own(value, "id")) {
      const name = lookupName ? lookupName(value) : value.name;
      if (name != null) return { t: "s", v: String(name) };
      return { t: "g", v: sqlGuidSortKey(value.id) ?? String(value.id) };
    }
    if (own(value, "value")) {
      if (!rawChoice) {
        const label = value.label ?? choiceLabelOf(definition, value.value);
        if (label != null) return { t: "s", v: String(label) };
      }
      const number = Number(value.value);
      return Number.isFinite(number) ? { t: "n", v: number } : { t: "s", v: String(value.value) };
    }
    return { t: "s", v: JSON.stringify(value) };
  }
  if (kind === "choice" && !rawChoice) {
    const label = choiceLabelOf(definition, value);
    if (label != null) return { t: "s", v: String(label) };
  }
  if (kind === "lookup" && lookupName) {
    const name = lookupName({ id: value });
    if (name != null) return { t: "s", v: String(name) };
  }
  if (typeof value === "number") return { t: "n", v: value };
  if (typeof value === "boolean") return { t: "n", v: Number(value) };
  const guid = sqlGuidSortKey(value);
  if (guid) return { t: "g", v: guid };
  if (kind === "datetime" || looksLikeDate(value)) {
    const parsed = parseDateValue(value, { timeZoneOffsetMinutes });
    if (parsed) return { t: "n", v: parsed.ms };
  }
  return { t: "s", v: String(value) };
}
export function compareSortKeys(a, b, collation = "CI_AI") {
  if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1;
  if (a.t === b.t) {
    if (a.t === "s") return textCollator(collation).compare(a.v, b.v);
    return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  }
  return a.t < b.t ? -1 : 1;
}

/** SQL LIKE pattern (%, _, [set], [^set], [%] literals) as an anchored matcher. */
export function likeMatcher(pattern, collation = "CI_AI") {
  const source = foldText(pattern ?? "", collation);
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "%") out += "[\\s\\S]*";
    else if (c === "_") out += "[\\s\\S]";
    else if (c === "[") {
      const close = source.indexOf("]", i + 2);
      if (close < 0) {
        out += "\\[";
        continue;
      }
      let body = source.slice(i + 1, close),
        negate = false;
      if (body.length > 1 && body[0] === "^") {
        negate = true;
        body = body.slice(1);
      }
      out += `[${negate ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      i = close;
    } else out += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  const expression = new RegExp(`^${out}$`, "s");
  return (value) => value != null && expression.test(foldText(scalar(value), collation));
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
const localMidnight = (year, month, day, offset) =>
  Date.UTC(year, month, day) - offset * 60000;
const addMonths = (ms, months, offset) => {
  const p = localParts(ms, offset);
  const time = ms - localMidnight(p.year, p.month, p.day, offset);
  const target = new Date(Date.UTC(p.year, p.month + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return (
    localMidnight(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(p.day, last),
      offset,
    ) + time
  );
};

const positiveInteger = (value, operator) => {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1)
    throw new DataError(
      `${operator} requires a positive integer value`,
      400,
      "InvalidQuery",
    );
  return Number(text);
};

/**
 * Relative and calendar datetime operators return a predicate over instants.
 * `now` is supplied by the caller so one query evaluates against one clock. Fiscal
 * operators use the organisation fiscal calendar (`fiscal`: a calendar or the query
 * settings, lib/fiscal-calendar.mjs); `fiscalPeriods` is the earlier periods-per-year form.
 */
export function dateOperatorPredicate(operator, values, { now = Date.now(), timeZoneOffsetMinutes: offset = 0, fiscal, fiscalPeriods } = {}) {
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
    case "today":
      return range(sod, sod + DAY);
    case "yesterday":
      return range(sod - DAY, sod);
    case "tomorrow":
      return range(sod + DAY, sod + 2 * DAY);
    case "last-seven-days":
      return upTo(sod - 7 * DAY, now);
    case "next-seven-days":
      return upTo(now, sod + 8 * DAY - 1);
    case "last-x-hours":
      return upTo(now - n() * 3600000, now);
    case "next-x-hours":
      return upTo(now, now + n() * 3600000);
    case "last-x-days":
      return upTo(sod - n() * DAY, now);
    case "next-x-days":
      return upTo(now, sod + (n() + 1) * DAY - 1);
    case "last-x-weeks":
      return upTo(sod - 7 * n() * DAY, now);
    case "next-x-weeks":
      return upTo(now, sod + (7 * n() + 1) * DAY - 1);
    case "last-x-months":
      return upTo(addMonths(sod, -n(), offset), now);
    case "next-x-months":
      return upTo(now, addMonths(sod, n(), offset) + DAY - 1);
    case "last-x-years":
      return upTo(addMonths(sod, -12 * n(), offset), now);
    case "next-x-years":
      return upTo(now, addMonths(sod, 12 * n(), offset) + DAY - 1);
    case "olderthan-x-minutes":
      return ((limit) => (ms) => ms < limit)(now - n() * 60000);
    case "olderthan-x-hours":
      return ((limit) => (ms) => ms < limit)(now - n() * 3600000);
    case "olderthan-x-days":
      return ((limit) => (ms) => ms < limit)(now - n() * DAY);
    case "olderthan-x-weeks":
      return ((limit) => (ms) => ms < limit)(now - 7 * n() * DAY);
    case "olderthan-x-months":
      return ((limit) => (ms) => ms < limit)(addMonths(now, -n(), offset));
    case "olderthan-x-years":
      return ((limit) => (ms) => ms < limit)(addMonths(now, -12 * n(), offset));
    case "this-week":
      return range(weekStart, weekStart + 7 * DAY);
    case "last-week":
      return range(weekStart - 7 * DAY, weekStart);
    case "next-week":
      return range(weekStart + 7 * DAY, weekStart + 14 * DAY);
    case "this-month":
      return range(monthStart, addMonths(monthStart, 1, offset));
    case "last-month":
      return range(addMonths(monthStart, -1, offset), monthStart);
    case "next-month":
      return range(addMonths(monthStart, 1, offset), addMonths(monthStart, 2, offset));
    case "this-year":
      return range(yearStart, localMidnight(parts.year + 1, 0, 1, offset));
    case "last-year":
      return range(localMidnight(parts.year - 1, 0, 1, offset), yearStart);
    case "next-year":
      return range(
        localMidnight(parts.year + 1, 0, 1, offset),
        localMidnight(parts.year + 2, 0, 1, offset),
      );
    default:
      return null;
  }
}
export const DATE_OPERATORS = new Set([
  "today", "yesterday", "tomorrow", "last-seven-days", "next-seven-days",
  "last-x-hours", "next-x-hours", "last-x-days", "next-x-days", "last-x-weeks",
  "next-x-weeks", "last-x-months", "next-x-months", "last-x-years", "next-x-years",
  "olderthan-x-minutes", "olderthan-x-hours", "olderthan-x-days", "olderthan-x-weeks",
  "olderthan-x-months", "olderthan-x-years", "this-week", "last-week", "next-week",
  "this-month", "last-month", "next-month", "this-year", "last-year", "next-year",
  "this-fiscal-year", "last-fiscal-year", "next-fiscal-year", "this-fiscal-period",
  "last-fiscal-period", "next-fiscal-period", "last-x-fiscal-years", "next-x-fiscal-years",
  "last-x-fiscal-periods", "next-x-fiscal-periods", "in-fiscal-year", "in-fiscal-period",
  "in-fiscal-period-and-year", "in-or-before-fiscal-period-and-year",
  "in-or-after-fiscal-period-and-year",
]);
/** Operators that need hour/minute precision cannot target DateOnly columns. */
export const TIME_PRECISION_OPERATORS = new Set([
  "last-x-hours", "next-x-hours", "olderthan-x-hours", "olderthan-x-minutes",
]);

/** Local calendar date (ms at local midnight) for on/on-or-before/on-or-after. */
export function localDay(value, { timeZoneOffsetMinutes = 0 } = {}) {
  const parsed = parseDateValue(value, { timeZoneOffsetMinutes });
  return parsed ? startOfLocalDay(parsed.ms, timeZoneOffsetMinutes) : null;
}

/** SQL DATEPART(week) style week number: Sunday-start weeks with January 1 in week 1. */
export function weekOfYear(ms, offset = 0) {
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
    case "day":
      return p.day;
    case "week":
      return weekOfYear(parsed.ms, timeZoneOffsetMinutes);
    case "month":
      return p.month + 1;
    case "quarter":
      return Math.floor(p.month / 3) + 1;
    case "year":
      return p.year;
    case "fiscal-period":
    case "fiscal-year": {
      const calendar = fiscalCalendar(fiscal ?? { fiscalPeriodsPerYear: fiscalPeriods });
      const at = fiscalPeriodOf(calendar, parsed.ms, timeZoneOffsetMinutes);
      return grouping === "fiscal-period" ? at.period : at.year;
    }
    default:
      throw new DataError(
        `Unsupported FetchXML dategrouping ${grouping}`,
        400,
        "UnsupportedQuery",
      );
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STANDARD_FORMATS = {
  d: "M/d/yyyy",
  D: "dddd, MMMM d, yyyy",
  t: "h:mm tt",
  T: "h:mm:ss tt",
  g: "M/d/yyyy h:mm tt",
  G: "M/d/yyyy h:mm:ss tt",
  f: "dddd, MMMM d, yyyy h:mm tt",
  F: "dddd, MMMM d, yyyy h:mm:ss tt",
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
  const pad = (value, width) => String(value).padStart(width, "0");
  let out = "";
  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i];
    if (c === "'" || c === '"') {
      const end = pattern.indexOf(c, i + 1);
      out += pattern.slice(i + 1, end < 0 ? pattern.length : end);
      i = end < 0 ? pattern.length : end + 1;
      continue;
    }
    if (c === "\\") {
      out += pattern[i + 1] ?? "";
      i += 2;
      continue;
    }
    let run = 1;
    while (pattern[i + run] === c) run++;
    const h12 = values.hour % 12 || 12;
    switch (c) {
      case "y":
        out += run <= 2 ? pad(values.year % 100, run) : pad(values.year, run);
        break;
      case "M":
        out += run >= 4 ? MONTHS[values.month - 1] : run === 3 ? MONTHS[values.month - 1].slice(0, 3) : pad(values.month, run);
        break;
      case "d":
        out += run >= 4 ? DAYS[values.weekday] : run === 3 ? DAYS[values.weekday].slice(0, 3) : pad(values.day, run);
        break;
      case "H":
        out += pad(values.hour, Math.min(run, 2));
        break;
      case "h":
        out += pad(h12, Math.min(run, 2));
        break;
      case "m":
        out += pad(values.minute, Math.min(run, 2));
        break;
      case "s":
        out += pad(values.second, Math.min(run, 2));
        break;
      case "f":
      case "F":
        out += pad(values.millisecond, 3).slice(0, run);
        break;
      case "t":
        out += (values.hour < 12 ? "AM" : "PM").slice(0, run === 1 ? 1 : 2);
        break;
      default:
        out += c.repeat(run);
    }
    i += run;
  }
  return out;
}

const numberFormats = new Map();
const formatNumber = (value, digits) => {
  const key = String(digits);
  if (!numberFormats.has(key))
    numberFormats.set(
      key,
      new Intl.NumberFormat("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }),
    );
  return numberFormats.get(key).format(value);
};
const optionLabel = (definition, value) =>
  Array.isArray(definition?.options)
    ? definition.options.find((option) => Number(option.value) === Number(value))?.label
    : undefined;

/**
 * Formatted values follow Dataverse's defaults for the calling user (en-US),
 * optionally overridden by explicit simulator formatting settings.
 */
export function formattedValue(value, definition, settings = {}) {
  if (value == null) return undefined;
  if (typeof value === "object" && !Array.isArray(value)) {
    if (own(value, "label") && value.label != null) return String(value.label);
    if (own(value, "name") && own(value, "id")) return value.name ?? undefined;
    value = scalar(value);
  }
  const kind = fieldKind(definition);
  const offset = Number(settings.timeZoneOffsetMinutes ?? 0);
  switch (kind) {
    case "choice":
      return optionLabel(definition, value);
    case "multichoice": {
      const items = (Array.isArray(value) ? value : String(value).split(","))
        .map((item) => optionLabel(definition, item))
        .filter((label) => label != null);
      return items.length ? items.join("; ") : undefined;
    }
    case "boolean": {
      const flag = booleanLiteral(value);
      if (flag == null) return undefined;
      return optionLabel(definition, Number(flag)) ?? (flag ? "Yes" : "No");
    }
    case "integer":
      return typeof value === "number" ? formatNumber(value, 0) : undefined;
    case "decimal":
    case "double":
      return typeof value === "number"
        ? formatNumber(value, Number.isInteger(definition?.precision) ? definition.precision : 2)
        : undefined;
    case "money":
      return typeof value === "number"
        ? `${settings.currencySymbol ?? definition?.currencySymbol ?? ""}${formatNumber(value, Number.isInteger(definition?.precision) ? definition.precision : 2)}`
        : undefined;
    case "datetime": {
      const parsed = parseDateValue(value, { timeZoneOffsetMinutes: offset });
      if (!parsed) return undefined;
      const dateOnly = parsed.dateOnly || isDateOnlyField(definition);
      return formatDotNetDate(
        parsed.ms,
        dateOnly
          ? (settings.dateFormat ?? "M/d/yyyy")
          : (settings.dateTimeFormat ?? `${settings.dateFormat ?? "M/d/yyyy"} ${settings.timeFormat ?? "h:mm tt"}`),
        offset,
      );
    }
    default:
      if (Array.isArray(definition?.options) && typeof value === "number")
        return optionLabel(definition, value);
      return undefined;
  }
}

/**
 * Primary name column of a table: the mapping's nameColumn, the metadata
 * column flagged isPrimaryName, Dataverse's <prefix>_name convention for
 * custom and portal tables, then "name". Values fall back to name/fullname.
 */
export function primaryNameColumn(mapping, logicalName = mapping?.logicalName) {
  if (mapping?.nameColumn) return mapping.nameColumn;
  for (const fields of [mapping?.fields, mapping?.fieldMetadata])
    if (fields && typeof fields === "object")
      for (const [name, definition] of Object.entries(fields))
        if (definition?.isPrimaryName) return name;
  const prefix = /^([a-z][a-z0-9]*)_/i.exec(String(logicalName ?? ""))?.[1];
  return prefix ? `${prefix}_name` : "name";
}
export function primaryNameValue(mapping, row, logicalName) {
  if (!row) return undefined;
  return row[primaryNameColumn(mapping, logicalName)] ?? row.name ?? row.fullname ?? undefined;
}
