// Condition operators shared by FetchXML <condition> and the Dataverse OData
// query functions (Microsoft.Dynamics.CRM.*). One implementation keeps both
// query languages consistent; see docs/dataverse-parity.md for evidence.
import { DataError } from "./data-error.mjs";
import {
  DATE_OPERATORS,
  TIME_PRECISION_OPERATORS,
  compareForFilter,
  dateOperatorPredicate,
  fieldKind,
  foldText,
  guidKey,
  isDateOnlyField,
  likeMatcher,
  localDay,
  parseDateValue,
  scalar,
  valuesEqual,
} from "./dataverse-values.mjs";

const VALUE_OPERATORS = new Set([
  "eq", "ne", "neq", "gt", "ge", "lt", "le", "like", "not-like", "begins-with",
  "not-begin-with", "ends-with", "not-end-with", "on", "on-or-before", "on-or-after",
]);
const LIST_OPERATORS = new Set(["in", "not-in", "contain-values", "not-contain-values"]);
const PAIR_OPERATORS = new Set(["between", "not-between"]);
const NO_VALUE_OPERATORS = new Set(["null", "not-null", "eq-userid", "ne-userid", "eq-userlanguage"]);
const UNSUPPORTED_OPERATORS = new Map([
  ["above", "hierarchy operators need hierarchical relationship metadata"],
  ["eq-or-above", "hierarchy operators need hierarchical relationship metadata"],
  ["under", "hierarchy operators need hierarchical relationship metadata"],
  ["eq-or-under", "hierarchy operators need hierarchical relationship metadata"],
  ["not-under", "hierarchy operators need hierarchical relationship metadata"],
  ["eq-useroruserhierarchy", "user hierarchy security is not modelled for the portal application user"],
  ["eq-useroruserhierarchyandteams", "user hierarchy security is not modelled for the portal application user"],
  ["eq-useroruserteams", "team membership of the portal application user is not modelled"],
  ["eq-userteams", "team membership of the portal application user is not modelled"],
  ["eq-businessid", "the portal application user's business unit is not modelled"],
  ["ne-businessid", "the portal application user's business unit is not modelled"],
]);

/** Every documented FetchXML condition operator with its local support status. */
export const FETCH_OPERATORS = new Set([
  ...VALUE_OPERATORS,
  ...LIST_OPERATORS,
  ...PAIR_OPERATORS,
  ...NO_VALUE_OPERATORS,
  ...DATE_OPERATORS,
]);
export const UNSUPPORTED_FETCH_OPERATORS = UNSUPPORTED_OPERATORS;
export const COLUMN_COMPARISON_OPERATORS = new Set(["eq", "ne", "gt", "ge", "lt", "le"]);

const nullMessage = (attribute) =>
  `Condition for attribute '${attribute}': null is not a valid value for an attribute. Use 'Null' or 'NotNull' conditions instead.`;

const isNullValue = (value) =>
  value == null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

const multiValues = (value) => {
  const raw = scalar(value);
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw.map((item) => Number(scalar(item)));
  return String(raw)
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number);
};

/**
 * Compile one operator into a predicate over the stored column value.
 * `values` are the literal operands (value attribute or <value> children).
 */
export function compileOperator(operator, {
  attribute = "attribute",
  values = [],
  definition,
  identity = {},
  settings = {},
  now = Date.now(),
} = {}) {
  const op = operator === "neq" ? "ne" : operator;
  const unsupported = UNSUPPORTED_OPERATORS.get(op);
  if (unsupported)
    throw new DataError(
      `FetchXML operator ${operator} is not supported locally: ${unsupported}.`,
      400,
      "UnsupportedQuery",
    );
  if (!FETCH_OPERATORS.has(op))
    throw new DataError(`Unsupported FetchXML operator ${operator}`, 400, "UnsupportedQuery");
  const kind = fieldKind(definition) ?? undefined;
  const collation = settings.collation ?? "CI_AI";
  const timeZoneOffsetMinutes = Number(settings.timeZoneOffsetMinutes ?? 0);
  const options = { kind, collation, timeZoneOffsetMinutes };
  const first = values[0];
  if (VALUE_OPERATORS.has(op) && first === undefined)
    throw new DataError(nullMessage(attribute), 400, "InvalidQuery");
  if (LIST_OPERATORS.has(op) && !values.length)
    throw new DataError(
      `Condition for attribute '${attribute}': expected at least one value for operator ${operator}.`,
      400,
      "InvalidQuery",
    );
  if (PAIR_OPERATORS.has(op) && values.length !== 2)
    throw new DataError(
      `Condition for attribute '${attribute}': operator ${operator} requires exactly two values.`,
      400,
      "InvalidQuery",
    );
  if (TIME_PRECISION_OPERATORS.has(op) && isDateOnlyField(definition))
    throw new DataError(
      `The operator ${operator} can't be applied to the DateOnly column ${attribute}.`,
      400,
      "InvalidQuery",
    );
  const equal = (x, y) => valuesEqual(x, y, options);
  const compare = (x, y) => compareForFilter(x, y, options);
  switch (op) {
    case "eq":
      return (x) => !isNullValue(x) && equal(x, first);
    case "ne":
      return (x) => !isNullValue(x) && !equal(x, first);
    case "gt":
      return (x) => !isNullValue(x) && compare(x, first) > 0;
    case "ge":
      return (x) => !isNullValue(x) && compare(x, first) >= 0;
    case "lt":
      return (x) => !isNullValue(x) && compare(x, first) < 0;
    case "le":
      return (x) => !isNullValue(x) && compare(x, first) <= 0;
    case "null":
      return (x) => isNullValue(x);
    case "not-null":
      return (x) => !isNullValue(x);
    case "in": {
      const guids = new Set(values.map(guidKey).filter(Boolean));
      return (x) =>
        !isNullValue(x) &&
        ((guids.size && guids.has(guidKey(scalar(x)))) || values.some((v) => equal(x, v)));
    }
    case "not-in":
      return (x) => !isNullValue(x) && !values.some((v) => equal(x, v));
    case "between":
      return (x) => !isNullValue(x) && compare(x, values[0]) >= 0 && compare(x, values[1]) <= 0;
    case "not-between":
      return (x) => !isNullValue(x) && (compare(x, values[0]) < 0 || compare(x, values[1]) > 0);
    case "like":
    case "not-like":
    case "begins-with":
    case "not-begin-with":
    case "ends-with":
    case "not-end-with": {
      const text = String(first);
      const pattern = op.startsWith("begins") || op === "not-begin-with"
        ? `${text}%`
        : op.startsWith("ends") || op === "not-end-with"
          ? `%${text}`
          : text;
      const match = likeMatcher(pattern, collation);
      const negate = op.startsWith("not-");
      return (x) => !isNullValue(x) && match(x) !== negate;
    }
    case "on":
    case "on-or-before":
    case "on-or-after": {
      const day = localDay(first, { timeZoneOffsetMinutes });
      if (day == null)
        throw new DataError(
          `Condition for attribute '${attribute}': '${first}' is not a valid date.`,
          400,
          "InvalidQuery",
        );
      return (x) => {
        const value = localDay(x, { timeZoneOffsetMinutes });
        if (value == null) return false;
        return op === "on" ? value === day : op === "on-or-before" ? value <= day : value >= day;
      };
    }
    case "eq-userid":
    case "ne-userid": {
      // Power Pages executes FetchXML as its Dataverse application user. The
      // local identity may name that user explicitly; contacts are not users.
      const user = guidKey(identity.systemUserId) ?? identity.systemUserId ?? null;
      return op === "eq-userid"
        ? (x) => user != null && !isNullValue(x) && equal(x, user)
        : (x) => !isNullValue(x) && (user == null || !equal(x, user));
    }
    case "eq-userlanguage": {
      const language = Number(identity.languageCode ?? settings.languageCode ?? 1033);
      return (x) => !isNullValue(x) && Number(scalar(x)) === language;
    }
    case "contain-values":
    case "not-contain-values": {
      const wanted = new Set(values.map(Number));
      return (x) => {
        const present = multiValues(x);
        const hit = present.some((item) => wanted.has(item));
        return op === "contain-values" ? hit : !hit;
      };
    }
    default: {
      const predicate = dateOperatorPredicate(op, values, {
        now,
        timeZoneOffsetMinutes,
        // The fiscal calendar comes from the query settings (lib/fiscal-calendar.mjs).
        fiscal: settings,
      });
      if (!predicate)
        throw new DataError(`Unsupported FetchXML operator ${operator}`, 400, "UnsupportedQuery");
      return (x) => {
        if (isNullValue(x)) return false;
        const parsed = parseDateValue(x, { timeZoneOffsetMinutes });
        return parsed ? predicate(parsed.ms) : false;
      };
    }
  }
}

/** Column comparison (valueof) supports only eq/ne/gt/ge/lt/le between same-typed values. */
export function compileColumnComparison(operator, { attribute, definition, settings = {} } = {}) {
  const op = operator === "neq" ? "ne" : operator;
  if (!COLUMN_COMPARISON_OPERATORS.has(op))
    throw new DataError(
      `Condition for attribute '${attribute}': column comparison supports only eq, ne, gt, ge, lt and le.`,
      400,
      "InvalidQuery",
    );
  const options = {
    kind: fieldKind(definition) ?? undefined,
    collation: settings.collation ?? "CI_AI",
    timeZoneOffsetMinutes: Number(settings.timeZoneOffsetMinutes ?? 0),
  };
  return (x, y) => {
    if (isNullValue(x) || isNullValue(y)) return false;
    if (op === "eq") return valuesEqual(x, y, options);
    if (op === "ne") return !valuesEqual(x, y, options);
    const result = compareForFilter(x, y, options);
    return op === "gt" ? result > 0 : op === "ge" ? result >= 0 : op === "lt" ? result < 0 : result <= 0;
  };
}

/** Dataverse Web API query functions mapped onto the shared FetchXML operators. */
export const CRM_FUNCTIONS = {
  In: { operator: "in", values: "list" },
  NotIn: { operator: "not-in", values: "list" },
  Between: { operator: "between", values: "list" },
  NotBetween: { operator: "not-between", values: "list" },
  ContainValues: { operator: "contain-values", values: "list" },
  DoesNotContainValues: { operator: "not-contain-values", values: "list" },
  EqualUserId: { operator: "eq-userid", values: "none" },
  NotEqualUserId: { operator: "ne-userid", values: "none" },
  EqualUserLanguage: { operator: "eq-userlanguage", values: "none" },
  On: { operator: "on", values: "one" },
  OnOrAfter: { operator: "on-or-after", values: "one" },
  OnOrBefore: { operator: "on-or-before", values: "one" },
  Today: { operator: "today", values: "none" },
  Yesterday: { operator: "yesterday", values: "none" },
  Tomorrow: { operator: "tomorrow", values: "none" },
  Last7Days: { operator: "last-seven-days", values: "none" },
  Next7Days: { operator: "next-seven-days", values: "none" },
  LastWeek: { operator: "last-week", values: "none" },
  ThisWeek: { operator: "this-week", values: "none" },
  NextWeek: { operator: "next-week", values: "none" },
  LastMonth: { operator: "last-month", values: "none" },
  ThisMonth: { operator: "this-month", values: "none" },
  NextMonth: { operator: "next-month", values: "none" },
  LastYear: { operator: "last-year", values: "none" },
  ThisYear: { operator: "this-year", values: "none" },
  NextYear: { operator: "next-year", values: "none" },
  LastXHours: { operator: "last-x-hours", values: "one" },
  NextXHours: { operator: "next-x-hours", values: "one" },
  LastXDays: { operator: "last-x-days", values: "one" },
  NextXDays: { operator: "next-x-days", values: "one" },
  LastXWeeks: { operator: "last-x-weeks", values: "one" },
  NextXWeeks: { operator: "next-x-weeks", values: "one" },
  LastXMonths: { operator: "last-x-months", values: "one" },
  NextXMonths: { operator: "next-x-months", values: "one" },
  LastXYears: { operator: "last-x-years", values: "one" },
  NextXYears: { operator: "next-x-years", values: "one" },
  OlderThanXMinutes: { operator: "olderthan-x-minutes", values: "one" },
  OlderThanXHours: { operator: "olderthan-x-hours", values: "one" },
  OlderThanXDays: { operator: "olderthan-x-days", values: "one" },
  OlderThanXWeeks: { operator: "olderthan-x-weeks", values: "one" },
  OlderThanXMonths: { operator: "olderthan-x-months", values: "one" },
  OlderThanXYears: { operator: "olderthan-x-years", values: "one" },
  InFiscalYear: { operator: "in-fiscal-year", values: "one" },
  InFiscalPeriod: { operator: "in-fiscal-period", values: "one" },
  InFiscalPeriodAndYear: { operator: "in-fiscal-period-and-year", values: "pair" },
  InOrBeforeFiscalPeriodAndYear: { operator: "in-or-before-fiscal-period-and-year", values: "pair" },
  InOrAfterFiscalPeriodAndYear: { operator: "in-or-after-fiscal-period-and-year", values: "pair" },
  ThisFiscalYear: { operator: "this-fiscal-year", values: "none" },
  ThisFiscalPeriod: { operator: "this-fiscal-period", values: "none" },
  NextFiscalYear: { operator: "next-fiscal-year", values: "none" },
  NextFiscalPeriod: { operator: "next-fiscal-period", values: "none" },
  LastFiscalYear: { operator: "last-fiscal-year", values: "none" },
  LastFiscalPeriod: { operator: "last-fiscal-period", values: "none" },
  LastXFiscalYears: { operator: "last-x-fiscal-years", values: "one" },
  LastXFiscalPeriods: { operator: "last-x-fiscal-periods", values: "one" },
  NextXFiscalYears: { operator: "next-x-fiscal-years", values: "one" },
  NextXFiscalPeriods: { operator: "next-x-fiscal-periods", values: "one" },
  Above: { operator: "above", values: "one" },
  AboveOrEqual: { operator: "eq-or-above", values: "one" },
  Under: { operator: "under", values: "one" },
  UnderOrEqual: { operator: "eq-or-under", values: "one" },
  NotUnder: { operator: "not-under", values: "one" },
  EqualUserOrUserHierarchy: { operator: "eq-useroruserhierarchy", values: "none" },
  EqualUserOrUserHierarchyAndTeams: { operator: "eq-useroruserhierarchyandteams", values: "none" },
  EqualUserOrUserTeams: { operator: "eq-useroruserteams", values: "none" },
  EqualUserTeams: { operator: "eq-userteams", values: "none" },
  EqualBusinessId: { operator: "eq-businessid", values: "none" },
  NotEqualBusinessId: { operator: "ne-businessid", values: "none" },
  // Full-text search (webapi/reference/contains): Dataverse accepts it only on columns enabled
  // for full-text indexing and otherwise answers 400 0x80041120 with this message. Exported
  // metadata doesn't say which columns are indexed, so every call gets the documented error.
  Contains: {
    operator: null,
    values: "one",
    rejection: {
      status: 400,
      code: "FullTextConditionUnsupported",
      innerCode: "0x80041120",
      message: "Unknown Condition Operator: Contains. FetchXml does not support it",
    },
  },
  // ConditionOperator.EqualRoleBusinessId (89) is "for internal use only" and has no FetchXML
  // operator; like EqualBusinessId it needs a business unit the local model doesn't have.
  EqualRoleBusinessId: {
    operator: null,
    values: "none",
    unsupported: "the business unit of the portal application user's security roles is not modelled",
  },
};

/** Case-insensitive helper used by OData string functions (contains/startswith/endswith). */
export function stringFunctionMatcher(name, pattern, collation = "CI_AI") {
  const text = String(pattern ?? "");
  const like =
    name === "contains" ? `%${text}%` : name === "startswith" ? `${text}%` : `%${text}`;
  return likeMatcher(like, collation);
}
export { foldText };
