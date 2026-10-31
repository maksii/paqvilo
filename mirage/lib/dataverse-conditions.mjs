// Condition operators shared by FetchXML <condition> and the Dataverse OData
// query functions (Microsoft.Dynamics.CRM.*). One implementation keeps both
// query languages consistent; see mirage/docs/dataverse-parity.md.
import { AsyncLocalStorage } from 'node:async_hooks';
import { DataError } from './data-error.mjs';
import {
  DATE_OPERATORS,
  TIME_PRECISION_OPERATORS,
  compareForFilter,
  dateOperatorPredicate,
  fieldKind,
  guidKey,
  isDateOnlyField,
  likeMatcher,
  localDay,
  parseDateValue,
  scalar,
  valuesEqual,
} from './dataverse-values.mjs';

const VALUE_OPERATORS = new Set([
  'eq',
  'ne',
  'neq',
  'gt',
  'ge',
  'lt',
  'le',
  'like',
  'not-like',
  'begins-with',
  'not-begin-with',
  'ends-with',
  'not-end-with',
  'on',
  'not-on',
  'on-or-before',
  'on-or-after',
]);
const MASK_OPERATORS = new Set(['mask', 'not-mask', 'masks-select']);
const LIST_OPERATORS = new Set(['in', 'not-in', 'contain-values', 'not-contain-values']);
const PAIR_OPERATORS = new Set(['between', 'not-between']);
const NO_VALUE_OPERATORS = new Set(['null', 'not-null', 'eq-userid', 'ne-userid', 'eq-userlanguage']);
const UNSUPPORTED_OPERATORS = new Map([
  ['above', 'hierarchy operators need hierarchical relationship metadata'],
  ['eq-or-above', 'hierarchy operators need hierarchical relationship metadata'],
  ['under', 'hierarchy operators need hierarchical relationship metadata'],
  ['eq-or-under', 'hierarchy operators need hierarchical relationship metadata'],
  ['not-under', 'hierarchy operators need hierarchical relationship metadata'],
  ['eq-useroruserhierarchy', 'user hierarchy security is not modelled for the portal application user'],
  ['eq-useroruserhierarchyandteams', 'user hierarchy security is not modelled for the portal application user'],
  ['eq-useroruserteams', 'team membership of the portal application user is not modelled'],
  ['eq-userteams', 'team membership of the portal application user is not modelled'],
  ['eq-businessid', "the portal application user's business unit is not modelled"],
  ['ne-businessid', "the portal application user's business unit is not modelled"],
]);

// The record hierarchy operators. A Dataverse caller resolves them through identity.dataverse.hierarchy; every other caller
// (portal FetchXML, Liquid, the portal Web API) through the runtime's query scope (runWithQueryResolvers, entered by the
// organization host per request), which answers from the organization's hierarchy module (store.hierarchyResolver).
// Outside any scope they keep the UNSUPPORTED_OPERATORS refusal; inside one, only a table that is not hierarchical is refused.
export const HIERARCHY_OPERATORS = new Set(['above', 'eq-or-above', 'under', 'eq-or-under', 'not-under']);
const queryScope = new AsyncLocalStorage();
/** Runs fn with the runtime's query resolvers ({ hierarchy(table, attribute, id, mode) }) in scope. */
export const runWithQueryResolvers = (resolvers, fn) => queryScope.run(resolvers, fn);

// Hierarchy, team and business-unit operators need `identity.dataverse` (the Dataverse caller's
// userId, businessUnitId, teamIds and hierarchy lookups). Without it they keep UNSUPPORTED_OPERATORS.
const DATAVERSE_IDENTITY_OPERATORS = new Set([
  'above',
  'eq-or-above',
  'under',
  'eq-or-under',
  'not-under',
  'eq-useroruserhierarchy',
  'eq-useroruserhierarchyandteams',
  'eq-useroruserteams',
  'eq-userteams',
  'eq-businessid',
  'ne-businessid',
]);

/** Every documented FetchXML condition operator with its local support status. */
export const FETCH_OPERATORS = new Set([
  ...VALUE_OPERATORS,
  ...LIST_OPERATORS,
  ...PAIR_OPERATORS,
  ...NO_VALUE_OPERATORS,
  ...MASK_OPERATORS,
  ...DATE_OPERATORS,
]);
export const UNSUPPORTED_FETCH_OPERATORS = UNSUPPORTED_OPERATORS;
/** Whether a FetchXML condition operator runs for a Dataverse caller (identity.dataverse) on any table: the record
 * hierarchy operators also need the table's hierarchical relationship, so they are not in this set. */
export const dataverseFetchOperator = (operator) =>
  FETCH_OPERATORS.has(operator) || (DATAVERSE_IDENTITY_OPERATORS.has(operator) && !HIERARCHY_OPERATORS.has(operator));
const COLUMN_COMPARISON_OPERATORS = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);

export const nullMessage = (attribute) =>
  `Condition for attribute '${attribute}': null is not a valid value for an attribute. Use 'Null' or 'NotNull' conditions instead.`;

const isNullValue = (value) => value == null || value === '' || (Array.isArray(value) && value.length === 0);

const multiValues = (value) => {
  const raw = scalar(value);
  if (raw == null || raw === '') return [];
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
export function compileOperator(
  operator,
  { attribute = 'attribute', values = [], definition, identity = {}, settings = {}, now = Date.now(), table } = {},
) {
  const op = operator === 'neq' ? 'ne' : operator;
  if (identity.dataverse && DATAVERSE_IDENTITY_OPERATORS.has(op))
    return compileIdentityOperator(op, { attribute, values, table, identity: identity.dataverse });
  const hierarchy = HIERARCHY_OPERATORS.has(op) ? queryScope.getStore()?.hierarchy : null;
  if (hierarchy) return compileIdentityOperator(op, { attribute, values, table, identity: { hierarchy } });
  // EqualUserAuthContext is a query function only: it has no FetchXML operator, so it is not in FETCH_OPERATORS.
  // The caller's authentication contexts come from identity.dataverse.authContexts; the simulator issues no acrs claim,
  // so the list is empty and nothing matches. The semantics are a guess from the name.
  if (op === 'eq-userauthcontext') {
    if (!identity.dataverse)
      throw new DataError(
        "FetchXML operator eq-userauthcontext is not supported locally: the portal application user's authentication contexts are not modelled.",
        400,
        'UnsupportedQuery',
      );
    const contexts = identityIds(identity.dataverse.authContexts ?? []);
    return (x) => !isNullValue(x) && contexts.has(identityKey(x) ?? String(scalar(x)).toLowerCase());
  }
  const unsupported = UNSUPPORTED_OPERATORS.get(op);
  if (unsupported)
    throw new DataError(
      `FetchXML operator ${operator} is not supported locally: ${unsupported}.`,
      400,
      'UnsupportedQuery',
    );
  if (!FETCH_OPERATORS.has(op))
    throw new DataError(`Unsupported FetchXML operator ${operator}`, 400, 'UnsupportedQuery');
  const kind = fieldKind(definition) ?? undefined;
  const collation = settings.collation ?? 'CI_AI';
  const timeZoneOffsetMinutes = Number(settings.timeZoneOffsetMinutes ?? 0);
  const options = { kind, collation, timeZoneOffsetMinutes };
  const first = values[0];
  if ((VALUE_OPERATORS.has(op) || MASK_OPERATORS.has(op)) && first === undefined)
    throw new DataError(nullMessage(attribute), 400, 'InvalidQuery');
  if (LIST_OPERATORS.has(op) && !values.length)
    throw new DataError(
      `Condition for attribute '${attribute}': expected at least one value for operator ${operator}.`,
      400,
      'InvalidQuery',
    );
  if (PAIR_OPERATORS.has(op) && values.length !== 2)
    throw new DataError(
      `Condition for attribute '${attribute}': operator ${operator} requires exactly two values.`,
      400,
      'InvalidQuery',
    );
  if (TIME_PRECISION_OPERATORS.has(op) && isDateOnlyField(definition))
    throw new DataError(
      `The operator ${operator} can't be applied to the DateOnly column ${attribute}.`,
      400,
      'InvalidQuery',
    );
  const equal = (x, y) => valuesEqual(x, y, options);
  const compare = (x, y) => compareForFilter(x, y, options);
  switch (op) {
    case 'eq':
      return (x) => !isNullValue(x) && equal(x, first);
    case 'ne':
      return (x) => !isNullValue(x) && !equal(x, first);
    case 'gt':
      return (x) => !isNullValue(x) && compare(x, first) > 0;
    case 'ge':
      return (x) => !isNullValue(x) && compare(x, first) >= 0;
    case 'lt':
      return (x) => !isNullValue(x) && compare(x, first) < 0;
    case 'le':
      return (x) => !isNullValue(x) && compare(x, first) <= 0;
    case 'null':
      return (x) => isNullValue(x);
    case 'not-null':
      return (x) => !isNullValue(x);
    case 'in': {
      const guids = new Set(values.map(guidKey).filter(Boolean));
      return (x) =>
        !isNullValue(x) && ((guids.size && guids.has(guidKey(scalar(x)))) || values.some((v) => equal(x, v)));
    }
    case 'not-in':
      return (x) => !isNullValue(x) && !values.some((v) => equal(x, v));
    case 'between':
      return (x) => !isNullValue(x) && compare(x, values[0]) >= 0 && compare(x, values[1]) <= 0;
    case 'not-between':
      return (x) => !isNullValue(x) && (compare(x, values[0]) < 0 || compare(x, values[1]) > 0);
    case 'like':
    case 'not-like':
    case 'begins-with':
    case 'not-begin-with':
    case 'ends-with':
    case 'not-end-with': {
      const text = String(first);
      const pattern =
        op.startsWith('begins') || op === 'not-begin-with'
          ? `${text}%`
          : op.startsWith('ends') || op === 'not-end-with'
            ? `%${text}`
            : text;
      const match = likeMatcher(pattern, collation);
      const negate = op.startsWith('not-');
      return (x) => !isNullValue(x) && match(x) !== negate;
    }
    case 'on':
    case 'not-on':
    case 'on-or-before':
    case 'on-or-after': {
      const day = localDay(first, { timeZoneOffsetMinutes });
      if (day == null)
        throw new DataError(
          `Condition for attribute '${attribute}': '${first}' is not a valid date.`,
          400,
          'InvalidQuery',
        );
      return (x) => {
        const value = localDay(x, { timeZoneOffsetMinutes });
        if (value == null) return false;
        if (op === 'on' || op === 'not-on') return (value === day) === (op === 'on');
        return op === 'on-or-before' ? value <= day : value >= day;
      };
    }
    case 'eq-userid':
    case 'ne-userid': {
      // Power Pages executes FetchXML as its Dataverse application user. The
      // local identity may name that user explicitly; contacts are not users.
      const self = identity.systemUserId ?? identity.dataverse?.userId;
      const user = guidKey(self) ?? self ?? null;
      return op === 'eq-userid'
        ? (x) => user != null && !isNullValue(x) && equal(x, user)
        : (x) => !isNullValue(x) && (user == null || !equal(x, user));
    }
    case 'eq-userlanguage': {
      const language = Number(identity.languageCode ?? settings.languageCode ?? 1033);
      return (x) => !isNullValue(x) && Number(scalar(x)) === language;
    }
    case 'contain-values':
    case 'not-contain-values': {
      const wanted = new Set(values.map(Number));
      return (x) => {
        const present = multiValues(x);
        const hit = present.some((item) => wanted.has(item));
        return op === 'contain-values' ? hit : !hit;
      };
    }
    case 'mask':
    case 'not-mask':
    case 'masks-select': {
      const mask = Number(scalar(first));
      if (!Number.isSafeInteger(mask) || mask < 0)
        throw new DataError(
          `Condition for attribute '${attribute}': operator ${operator} requires an integer bit mask.`,
          400,
          'InvalidQuery',
        );
      // ponytail: bit semantics are a local model (the docs only say "found in the bit-mask"); a native SDK query capture (NATIVE sdk-values-queries) settles them.
      const bits = BigInt(mask);
      return (x) => {
        if (isNullValue(x)) return false;
        const value = Number(scalar(x));
        if (!Number.isSafeInteger(value)) return false;
        const both = BigInt(value) & bits;
        return op === 'mask' ? both === bits : op === 'not-mask' ? both !== bits : both !== 0n;
      };
    }
    default: {
      const predicate = dateOperatorPredicate(op, values, {
        now,
        timeZoneOffsetMinutes,
        // The fiscal calendar comes from the query settings (lib/fiscal-calendar.mjs).
        fiscal: settings,
      });
      if (!predicate) throw new DataError(`Unsupported FetchXML operator ${operator}`, 400, 'UnsupportedQuery');
      return (x) => {
        if (isNullValue(x)) return false;
        const parsed = parseDateValue(x, { timeZoneOffsetMinutes });
        return parsed ? predicate(parsed.ms) : false;
      };
    }
  }
}

const identityKey = (value) => guidKey(scalar(value));
const identityIds = (items) => new Set([...items].map((item) => guidKey(item) ?? String(item).toLowerCase()));

/**
 * Operators that need the Dataverse caller (identity.dataverse). Hierarchy sets come from the
 * router's lookups: hierarchy(table, idColumn, recordId, mode) and userHierarchy(userId). A null
 * answer means the table or user has no hierarchy.
 */
function compileIdentityOperator(op, { attribute, values, table, identity }) {
  const hierarchyError = () =>
    new DataError('The entity does not have a hierarchical relationship.', 400, 'InvalidQuery', {
      innerCode: '0x80040203',
      reason: 'HIERARCHY_NOT_HIERARCHICAL',
    });
  const treeOf = (mode) => {
    const recordId = identityKey(values[0]);
    if (recordId == null) throw new DataError(nullMessage(attribute), 400, 'InvalidQuery');
    const ids = identity.hierarchy?.(table, attribute, recordId, mode) ?? null;
    if (ids == null) throw hierarchyError();
    return identityIds(ids);
  };
  const userSet = (extra = []) => {
    const userId = identityKey(identity.userId) ?? identity.userId;
    const ids = identity.userHierarchy ? identity.userHierarchy(userId) : new Set();
    if (ids == null) throw hierarchyError();
    return identityIds([userId, ...extra, ...ids].filter(Boolean));
  };
  const teams = identityIds(identity.teamIds ?? []);
  switch (op) {
    case 'above':
    case 'eq-or-above':
    case 'under':
    case 'eq-or-under': {
      const ids = treeOf(op);
      return (x) => !isNullValue(x) && ids.has(identityKey(x));
    }
    case 'not-under': {
      const ids = treeOf('under');
      return (x) => !isNullValue(x) && !ids.has(identityKey(x));
    }
    case 'eq-businessid':
    case 'ne-businessid': {
      const bu = identityKey(identity.businessUnitId) ?? identity.businessUnitId ?? null;
      return op === 'eq-businessid'
        ? (x) => bu != null && !isNullValue(x) && identityKey(x) === bu
        : (x) => !isNullValue(x) && (bu == null || identityKey(x) !== bu);
    }
    case 'eq-userteams':
      return (x) => !isNullValue(x) && teams.has(identityKey(x));
    case 'eq-useroruserteams': {
      const set = userSet([...teams]);
      return (x) => !isNullValue(x) && set.has(identityKey(x));
    }
    case 'eq-useroruserhierarchy': {
      const set = userSet();
      return (x) => !isNullValue(x) && set.has(identityKey(x));
    }
    case 'eq-useroruserhierarchyandteams': {
      // Reports' own teams are not in the router's lookup, so only the caller's teams are added.
      const set = userSet([...teams]);
      return (x) => !isNullValue(x) && set.has(identityKey(x));
    }
    default:
      throw new DataError(`Unsupported FetchXML operator ${op}`, 400, 'UnsupportedQuery');
  }
}

/** Column comparison (valueof) supports only eq/ne/gt/ge/lt/le between same-typed values. */
export function compileColumnComparison(operator, { attribute, definition, settings = {} } = {}) {
  const op = operator === 'neq' ? 'ne' : operator;
  if (!COLUMN_COMPARISON_OPERATORS.has(op))
    throw new DataError(
      `Condition for attribute '${attribute}': column comparison supports only eq, ne, gt, ge, lt and le.`,
      400,
      'InvalidQuery',
    );
  const options = {
    kind: fieldKind(definition) ?? undefined,
    collation: settings.collation ?? 'CI_AI',
    timeZoneOffsetMinutes: Number(settings.timeZoneOffsetMinutes ?? 0),
  };
  return (x, y) => {
    if (isNullValue(x) || isNullValue(y)) return false;
    if (op === 'eq') return valuesEqual(x, y, options);
    if (op === 'ne') return !valuesEqual(x, y, options);
    const result = compareForFilter(x, y, options);
    return op === 'gt' ? result > 0 : op === 'ge' ? result >= 0 : op === 'lt' ? result < 0 : result <= 0;
  };
}

/** Dataverse Web API query functions mapped onto the shared FetchXML operators. */
export const CRM_FUNCTIONS = {
  In: { operator: 'in', values: 'list' },
  NotIn: { operator: 'not-in', values: 'list' },
  Between: { operator: 'between', values: 'list' },
  NotBetween: { operator: 'not-between', values: 'list' },
  ContainValues: { operator: 'contain-values', values: 'list' },
  DoesNotContainValues: { operator: 'not-contain-values', values: 'list' },
  EqualUserId: { operator: 'eq-userid', values: 'none' },
  NotEqualUserId: { operator: 'ne-userid', values: 'none' },
  EqualUserLanguage: { operator: 'eq-userlanguage', values: 'none' },
  EqualUserAuthContext: { operator: 'eq-userauthcontext', values: 'none' },
  On: { operator: 'on', values: 'one' },
  OnOrAfter: { operator: 'on-or-after', values: 'one' },
  OnOrBefore: { operator: 'on-or-before', values: 'one' },
  Today: { operator: 'today', values: 'none' },
  Yesterday: { operator: 'yesterday', values: 'none' },
  Tomorrow: { operator: 'tomorrow', values: 'none' },
  Last7Days: { operator: 'last-seven-days', values: 'none' },
  Next7Days: { operator: 'next-seven-days', values: 'none' },
  LastWeek: { operator: 'last-week', values: 'none' },
  ThisWeek: { operator: 'this-week', values: 'none' },
  NextWeek: { operator: 'next-week', values: 'none' },
  LastMonth: { operator: 'last-month', values: 'none' },
  ThisMonth: { operator: 'this-month', values: 'none' },
  NextMonth: { operator: 'next-month', values: 'none' },
  LastYear: { operator: 'last-year', values: 'none' },
  ThisYear: { operator: 'this-year', values: 'none' },
  NextYear: { operator: 'next-year', values: 'none' },
  LastXHours: { operator: 'last-x-hours', values: 'one' },
  NextXHours: { operator: 'next-x-hours', values: 'one' },
  LastXDays: { operator: 'last-x-days', values: 'one' },
  NextXDays: { operator: 'next-x-days', values: 'one' },
  LastXWeeks: { operator: 'last-x-weeks', values: 'one' },
  NextXWeeks: { operator: 'next-x-weeks', values: 'one' },
  LastXMonths: { operator: 'last-x-months', values: 'one' },
  NextXMonths: { operator: 'next-x-months', values: 'one' },
  LastXYears: { operator: 'last-x-years', values: 'one' },
  NextXYears: { operator: 'next-x-years', values: 'one' },
  OlderThanXMinutes: { operator: 'olderthan-x-minutes', values: 'one' },
  OlderThanXHours: { operator: 'olderthan-x-hours', values: 'one' },
  OlderThanXDays: { operator: 'olderthan-x-days', values: 'one' },
  OlderThanXWeeks: { operator: 'olderthan-x-weeks', values: 'one' },
  OlderThanXMonths: { operator: 'olderthan-x-months', values: 'one' },
  OlderThanXYears: { operator: 'olderthan-x-years', values: 'one' },
  InFiscalYear: { operator: 'in-fiscal-year', values: 'one' },
  InFiscalPeriod: { operator: 'in-fiscal-period', values: 'one' },
  InFiscalPeriodAndYear: { operator: 'in-fiscal-period-and-year', values: 'pair' },
  InOrBeforeFiscalPeriodAndYear: { operator: 'in-or-before-fiscal-period-and-year', values: 'pair' },
  InOrAfterFiscalPeriodAndYear: { operator: 'in-or-after-fiscal-period-and-year', values: 'pair' },
  ThisFiscalYear: { operator: 'this-fiscal-year', values: 'none' },
  ThisFiscalPeriod: { operator: 'this-fiscal-period', values: 'none' },
  NextFiscalYear: { operator: 'next-fiscal-year', values: 'none' },
  NextFiscalPeriod: { operator: 'next-fiscal-period', values: 'none' },
  LastFiscalYear: { operator: 'last-fiscal-year', values: 'none' },
  LastFiscalPeriod: { operator: 'last-fiscal-period', values: 'none' },
  LastXFiscalYears: { operator: 'last-x-fiscal-years', values: 'one' },
  LastXFiscalPeriods: { operator: 'last-x-fiscal-periods', values: 'one' },
  NextXFiscalYears: { operator: 'next-x-fiscal-years', values: 'one' },
  NextXFiscalPeriods: { operator: 'next-x-fiscal-periods', values: 'one' },
  Above: { operator: 'above', values: 'one' },
  AboveOrEqual: { operator: 'eq-or-above', values: 'one' },
  Under: { operator: 'under', values: 'one' },
  UnderOrEqual: { operator: 'eq-or-under', values: 'one' },
  NotUnder: { operator: 'not-under', values: 'one' },
  EqualUserOrUserHierarchy: { operator: 'eq-useroruserhierarchy', values: 'none' },
  EqualUserOrUserHierarchyAndTeams: { operator: 'eq-useroruserhierarchyandteams', values: 'none' },
  EqualUserOrUserTeams: { operator: 'eq-useroruserteams', values: 'none' },
  EqualUserTeams: { operator: 'eq-userteams', values: 'none' },
  EqualBusinessId: { operator: 'eq-businessid', values: 'none' },
  NotEqualBusinessId: { operator: 'ne-businessid', values: 'none' },
  // Full-text search: Dataverse accepts it only on columns enabled
  // for full-text indexing and otherwise answers 400 0x80041120 with this message. Exported
  // metadata doesn't say which columns are indexed, so every call gets the documented error.
  Contains: {
    operator: null,
    values: 'one',
    rejection: {
      status: 400,
      code: 'FullTextConditionUnsupported',
      innerCode: '0x80041120',
      message: 'Unknown Condition Operator: Contains. FetchXml does not support it',
    },
  },
  // ConditionOperator.EqualRoleBusinessId (89) is "for internal use only" and has no FetchXML
  // operator; like EqualBusinessId it needs a business unit the local model doesn't have.
  EqualRoleBusinessId: {
    operator: null,
    values: 'none',
    unsupported: "the business unit of the portal application user's security roles is not modelled",
  },
};

/** Case-insensitive helper used by OData string functions (contains/startswith/endswith). */
export function stringFunctionMatcher(name, pattern, collation = 'CI_AI') {
  const text = String(pattern ?? '');
  const like = name === 'contains' ? `%${text}%` : name === 'startswith' ? `${text}%` : `%${text}`;
  return likeMatcher(like, collation);
}
