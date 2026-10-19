// QueryExpression (SOAP RetrieveMultiple, QueryByAttribute) and the BulkDelete
// JSON QuerySet become one FetchXML string, which the store already runs. The
// SDK enums are indexed by their numeric values, so named and numeric operators
// resolve through the same table. Mappings checked against the Microsoft Learn
// ConditionOperator and JoinOperator enum pages and the FetchXML operator,
// link-entity, condition and fetch references (2026-10-19).
import { DataError } from "./data-error.mjs";

const invalid = (message, innerCode = "0x80040203") => new DataError(message, 400, "InvalidRequest", { innerCode });

// [SDK name, FetchXML operator, wildcard wrap]. Array position is the enum value.
// A null operator means no documented FetchXML equivalent; using it is an error.
const CONDITION_TABLE = [
  ["Equal", "eq"],
  ["NotEqual", "ne"],
  ["GreaterThan", "gt"],
  ["LessThan", "lt"],
  ["GreaterEqual", "ge"],
  ["LessEqual", "le"],
  ["Like", "like"],
  ["NotLike", "not-like"],
  ["In", "in"],
  ["NotIn", "not-in"],
  ["Between", "between"],
  ["NotBetween", "not-between"],
  ["Null", "null"],
  ["NotNull", "not-null"],
  ["Yesterday", "yesterday"],
  ["Today", "today"],
  ["Tomorrow", "tomorrow"],
  ["Last7Days", "last-seven-days"],
  ["Next7Days", "next-seven-days"],
  ["LastWeek", "last-week"],
  ["ThisWeek", "this-week"],
  ["NextWeek", "next-week"],
  ["LastMonth", "last-month"],
  ["ThisMonth", "this-month"],
  ["NextMonth", "next-month"],
  ["On", "on"],
  ["OnOrBefore", "on-or-before"],
  ["OnOrAfter", "on-or-after"],
  ["LastYear", "last-year"],
  ["ThisYear", "this-year"],
  ["NextYear", "next-year"],
  ["LastXHours", "last-x-hours"],
  ["NextXHours", "next-x-hours"],
  ["LastXDays", "last-x-days"],
  ["NextXDays", "next-x-days"],
  ["LastXWeeks", "last-x-weeks"],
  ["NextXWeeks", "next-x-weeks"],
  ["LastXMonths", "last-x-months"],
  ["NextXMonths", "next-x-months"],
  ["LastXYears", "last-x-years"],
  ["NextXYears", "next-x-years"],
  ["EqualUserId", "eq-userid"],
  ["NotEqualUserId", "ne-userid"],
  ["EqualBusinessId", "eq-businessid"],
  ["NotEqualBusinessId", "ne-businessid"],
  ["ChildOf", null], // unverified: "for internal use only" in the SDK; no FetchXML operator documented
  ["Mask", null], // unverified: bit-mask operator is not in the FetchXML operator list
  ["NotMask", null], // unverified: as Mask
  ["MasksSelect", null], // unverified: "for internal use only" in the SDK
  ["Contains", "like", "%"], // unverified: no FetchXML contains operator; a like with wrapping wildcards is assumed
  ["DoesNotContain", "not-like", "%"], // unverified: as Contains
  ["EqualUserLanguage", "eq-userlanguage"],
  ["NotOn", null], // unverified: "for internal use only" in the SDK
  ["OlderThanXMonths", "olderthan-x-months"],
  ["BeginsWith", "begins-with"],
  ["DoesNotBeginWith", "not-begin-with"],
  ["EndsWith", "ends-with"],
  ["DoesNotEndWith", "not-end-with"],
  ["ThisFiscalYear", "this-fiscal-year"],
  ["ThisFiscalPeriod", "this-fiscal-period"],
  ["NextFiscalYear", "next-fiscal-year"],
  ["NextFiscalPeriod", "next-fiscal-period"],
  ["LastFiscalYear", "last-fiscal-year"],
  ["LastFiscalPeriod", "last-fiscal-period"],
  ["LastXFiscalYears", "last-x-fiscal-years"],
  ["LastXFiscalPeriods", "last-x-fiscal-periods"],
  ["NextXFiscalYears", "next-x-fiscal-years"],
  ["NextXFiscalPeriods", "next-x-fiscal-periods"],
  ["InFiscalYear", "in-fiscal-year"],
  ["InFiscalPeriod", "in-fiscal-period"],
  ["InFiscalPeriodAndYear", "in-fiscal-period-and-year"],
  ["InOrBeforeFiscalPeriodAndYear", "in-or-before-fiscal-period-and-year"],
  ["InOrAfterFiscalPeriodAndYear", "in-or-after-fiscal-period-and-year"],
  ["EqualUserTeams", "eq-userteams"],
  ["EqualUserOrUserTeams", "eq-useroruserteams"],
  ["Under", "under"],
  ["NotUnder", "not-under"],
  ["UnderOrEqual", "eq-or-under"],
  ["Above", "above"],
  ["AboveOrEqual", "eq-or-above"],
  ["EqualUserOrUserHierarchy", "eq-useroruserhierarchy"],
  ["EqualUserOrUserHierarchyAndTeams", "eq-useroruserhierarchyandteams"],
  ["OlderThanXYears", "olderthan-x-years"],
  ["OlderThanXWeeks", "olderthan-x-weeks"],
  ["OlderThanXDays", "olderthan-x-days"],
  ["OlderThanXHours", "olderthan-x-hours"],
  ["OlderThanXMinutes", "olderthan-x-minutes"],
  ["ContainValues", "contain-values"],
  ["DoesNotContainValues", "not-contain-values"],
  ["EqualRoleBusinessId", null], // unverified: "for internal use only" in the SDK
];
const CONDITIONS = new Map(CONDITION_TABLE.map(([name, op, wrap], value) => [name, { value, op, wrap }]));

// [SDK name, FetchXML link-type]. Array position is the enum value.
const JOIN_TABLE = [
  ["Inner", "inner"],
  ["LeftOuter", "outer"],
  ["Natural", "inner"], // unverified: no documented natural link-type; mapped to inner as specified
  ["MatchFirstRowUsingCrossApply", "matchfirstrowusingcrossapply"],
  ["In", "in"],
  ["Exists", "exists"],
  ["Any", "any"],
  ["NotAny", "not any"],
  ["All", "all"],
  ["NotAll", "not all"],
];
const JOINS = new Map(JOIN_TABLE.map(([name, linkType]) => [name, linkType]));
const FILTER_TYPES = { And: "and", Or: "or", 0: "and", 1: "or" };
const LIST_OPERATORS = new Set(["in", "not-in", "contain-values", "not-contain-values"]);

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const attr = (name, value) => (value == null || value === "" ? "" : ` ${name}="${esc(value)}"`);
const flag = (name, on) => (on ? ` ${name}="true"` : "");
// Wildcard metacharacters are literal when bracketed, which is the documented form.
const literal = (text) => text.replace(/[[%_]/g, (c) => `[${c}]`);

function conditionOf(operator) {
  const name = typeof operator === "number" ? CONDITION_TABLE[operator]?.[0] : operator;
  const entry = CONDITIONS.get(name);
  if (!entry) throw invalid(`Unknown condition operator '${operator}'.`);
  if (!entry.op) throw invalid(`Condition operator '${name}' has no FetchXML equivalent.`);
  return entry;
}

function joinTypeOf(joinOperator = "Inner") {
  const name = typeof joinOperator === "number" ? JOIN_TABLE[joinOperator]?.[0] : joinOperator;
  const linkType = JOINS.get(name);
  if (!linkType) throw invalid(`Unknown join operator '${joinOperator}'.`);
  return linkType;
}

function conditionXml(condition) {
  const entry = conditionOf(condition.operator);
  const values = (condition.values ?? []).map((v) => (entry.wrap ? `${entry.wrap}${literal(String(v))}${entry.wrap}` : v));
  const head = `${attr("entityname", condition.entityName)}${attr("attribute", condition.attributeName)} operator="${entry.op}"`;
  if (condition.compareColumns) return `<condition${head}${attr("valueof", values[0])}/>`;
  if (values.length === 0) return `<condition${head}/>`;
  if (values.length === 1 && !LIST_OPERATORS.has(entry.op)) return `<condition${head}${attr("value", values[0])}/>`;
  return `<condition${head}>${values.map((v) => `<value>${esc(v)}</value>`).join("")}</condition>`;
}

function filterXml(filter) {
  const { filterOperator = "And", conditions = [], filters = [] } = filter ?? {};
  const type = FILTER_TYPES[filterOperator];
  if (!type) throw invalid(`Unknown filter operator '${filterOperator}'.`);
  const inner = conditions.map(conditionXml).join("") + filters.map(filterXml).join("");
  return inner ? `<filter type="${type}">${inner}</filter>` : "";
}

function columnsXml(columnSet) {
  const { allColumns, columns = [] } = columnSet ?? {};
  return allColumns ? "<all-attributes/>" : columns.map((name) => `<attribute name="${esc(name)}"/>`).join("");
}

function ordersXml(orders = []) {
  // OrderType: Ascending = 0, Descending = 1.
  return orders
    .map((o) => `<order attribute="${esc(o.attributeName)}"${flag("descending", o.orderType === 1 || /^descending$/i.test(String(o.orderType)))}/>`)
    .join("");
}

// The SDK LinkEntity names the linked table with LinkToEntityName and joins LinkToAttributeName
// (FetchXML from) to LinkFromAttributeName (FetchXML to) on the parent. The parent is implied by nesting.
function linkXml(link) {
  const body = columnsXml(link.columns) + ordersXml(link.orders) + filterXml(link.linkCriteria) +
    (link.linkEntities ?? []).map(linkXml).join("");
  return `<link-entity name="${esc(link.linkToEntityName)}" from="${esc(link.linkToAttributeName)}" to="${esc(link.linkFromAttributeName)}" link-type="${joinTypeOf(link.joinOperator)}"${attr("alias", link.entityAlias)}>${body}</link-entity>`;
}

/** Renders a QueryExpression model as one FetchXML string. Values are escaped; nothing is validated against a schema. */
export function toFetchXml(model) {
  const page = model.pageInfo ?? {};
  const head = flag("distinct", model.distinct) + flag("no-lock", model.noLock) + attr("top", model.topCount > 0 ? model.topCount : null) +
    attr("page", page.pageNumber > 0 ? page.pageNumber : null) + attr("count", page.count > 0 ? page.count : null) +
    attr("paging-cookie", page.pagingCookie) + flag("returntotalrecordcount", page.returnTotalRecordCount);
  const body = columnsXml(model.columnSet) + ordersXml(model.orders) + filterXml(model.criteria) +
    (model.linkEntities ?? []).map(linkXml).join("");
  return `<fetch${head}><entity name="${esc(model.entityName)}">${body}</entity></fetch>`;
}

/** QueryByAttribute: every attribute/value pair becomes an Equal condition, all combined with And. */
export function fromQueryByAttribute(model) {
  const attributes = model.attributes ?? [];
  const values = model.values ?? [];
  if (attributes.length !== values.length) throw invalid("QueryByAttribute needs one value per attribute.");
  return {
    entityName: model.entityName,
    columnSet: model.columnSet ?? { allColumns: false, columns: [] },
    criteria: {
      filterOperator: "And",
      conditions: attributes.map((attributeName, i) => ({ attributeName, operator: "Equal", values: [values[i]] })),
      filters: [],
    },
    linkEntities: [],
    orders: model.orders ?? [],
    distinct: model.distinct,
    noLock: model.noLock,
    topCount: model.topCount,
    pageInfo: model.pageInfo,
  };
}

function criteriaFromJson(criteria = {}) {
  return {
    filterOperator: criteria.FilterOperator ?? "And",
    conditions: (criteria.Conditions ?? []).map((c) => ({
      attributeName: c.AttributeName,
      operator: c.Operator,
      values: (c.Values ?? []).map((v) => v.Value),
    })),
    filters: (criteria.Filters ?? []).map(criteriaFromJson),
  };
}

/** BulkDelete JSON QuerySet item ({ EntityName, Criteria }) as a QueryExpression model. */
export function fromBulkDeleteJson(querySetItem) {
  return {
    entityName: querySetItem.EntityName,
    criteria: criteriaFromJson(querySetItem.Criteria),
    linkEntities: [],
  };
}
