import { organizationRecord } from './organization-context.mjs';
// Miscellaneous platform messages of the simulated Dataverse Web API: FetchXML and QueryExpression conversion and
// validation, RetrieveTimestamp, the knowledge article and knowledge base article search functions, and the knowledge
// version and view, rollup, virtual table event, composite data source, certificate credential, managed identity and
// business process flow messages. install(api) registers them with the operation registry. Conversions are pure; reads go
// through api.principals.authorize and store.rows. Learn gives no error codes for most of these, so the 400s below use
// 0x80040203 and are marked unverified.
import { createHash, randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { idOf, registerInternalMessage, registerAddon } from "./dataverse-addon-common.mjs";
import { contextUrl, parseDataverseRoute, parsePrefer } from "./dataverse-odata.mjs";
import { privilegeDeniedError, privilegeName, uuidV5 } from "./dataverse-security.mjs";
import { toFetchXml } from "./dataverse-soap-query.mjs";
import { parseXmlDocument, planFetch } from "./fetchxml-engine.mjs";

const invalid = (message, innerCode = "0x80040203") => new DataError(message, 400, "InvalidRequest", { innerCode }); // unverified: codes and text
const contextFor = (ctx, suffix) => contextUrl(ctx.origin, ctx.version, suffix);

// FetchXML operator to the SDK ConditionOperator name (the inverse of dataverse-soap-query.mjs for the common operators).
const OPERATORS = {
  eq: "Equal", ne: "NotEqual", gt: "GreaterThan", lt: "LessThan", ge: "GreaterEqual", le: "LessEqual",
  like: "Like", "not-like": "NotLike", in: "In", "not-in": "NotIn", between: "Between", "not-between": "NotBetween",
  null: "Null", "not-null": "NotNull", "begins-with": "BeginsWith", "not-begin-with": "DoesNotBeginWith",
  "ends-with": "EndsWith", "not-end-with": "DoesNotEndWith", today: "Today", yesterday: "Yesterday", tomorrow: "Tomorrow",
  on: "On", "on-or-before": "OnOrBefore", "on-or-after": "OnOrAfter", "eq-userid": "EqualUserId", "ne-userid": "NotEqualUserId",
  "eq-businessid": "EqualBusinessId", "ne-businessid": "NotEqualBusinessId", "contain-values": "ContainValues",
  "not-contain-values": "DoesNotContainValues", under: "Under", "not-under": "NotUnder", "eq-or-under": "UnderOrEqual",
  above: "Above", "eq-or-above": "AboveOrEqual",
};
// FetchXML link-type to JoinOperator, as dataverse-soap-query.mjs writes them.
const JOINS = { inner: "Inner", outer: "LeftOuter", in: "In", exists: "Exists", any: "Any", "not any": "NotAny", all: "All", "not all": "NotAll" };
const FETCH_ENTITY_CHILDREN = new Set(["attribute", "all-attributes", "order", "filter", "link-entity"]);

// ---- QueryExpression JSON (Learn: QueryExpression, FilterExpression, ConditionExpression, OrderExpression, LinkEntity) ----

const columnsOf = (set) => (set ? { allColumns: set.AllColumns === true, columns: set.Columns ?? [] } : undefined);
const ordersOf = (orders = []) => orders.map((o) => ({ attributeName: o.AttributeName, orderType: o.OrderType }));
const filterOf = (filter = {}) => ({
  filterOperator: filter.FilterOperator ?? "And",
  conditions: (filter.Conditions ?? []).map((c) => ({
    entityName: c.EntityName, attributeName: c.AttributeName, operator: c.Operator, values: c.Values ?? [], compareColumns: c.CompareColumns === true,
  })),
  filters: (filter.Filters ?? []).map(filterOf),
});
const linkOf = (link) => ({
  linkToEntityName: link.LinkToEntityName, linkToAttributeName: link.LinkToAttributeName, linkFromAttributeName: link.LinkFromAttributeName,
  joinOperator: link.JoinOperator ?? "Inner", entityAlias: link.EntityAlias, columns: columnsOf(link.Columns),
  linkCriteria: filterOf(link.LinkCriteria), linkEntities: (link.LinkEntities ?? []).map(linkOf), orders: ordersOf(link.Orders),
});

// The codec model that dataverse-soap-query.mjs toFetchXml renders. Values stay as Learn gives them: plain objects in Values.
export function modelOf(json) {
  if (typeof json?.EntityName !== "string" || !json.EntityName) throw invalid("Query requires an EntityName."); // unverified
  if (json.SubQueryExpression != null) throw new DataError("SubQueryExpression is not simulated.", 501, "NotImplemented");
  const page = json.PageInfo;
  return {
    entityName: json.EntityName,
    columnSet: columnsOf(json.ColumnSet),
    criteria: filterOf(json.Criteria),
    linkEntities: (json.LinkEntities ?? []).map(linkOf),
    orders: ordersOf(json.Orders),
    distinct: json.Distinct === true,
    noLock: json.NoLock === true,
    topCount: json.TopCount ?? undefined,
    pageInfo: page ? { count: page.Count, pageNumber: page.PageNumber, pagingCookie: page.PagingCookie, returnTotalRecordCount: page.ReturnTotalRecordCount } : undefined,
  };
}

// ---- FetchXML parse tree (fetchxml-engine.mjs parseXmlDocument: { name, attrs, children, text }) to QueryExpression JSON ----

const sdkOperator = (op) => {
  const name = OPERATORS[op];
  if (!name) throw invalid(`FetchXML operator '${op}' has no QueryExpression equivalent in this simulator.`); // unverified
  return name;
};

function conditionJson(node) {
  if (node.attrs.valueof !== undefined) throw invalid("FetchXML condition 'valueof' has no QueryExpression equivalent in this simulator."); // unverified
  const values = node.children.some((c) => c.name === "value")
    ? node.children.filter((c) => c.name === "value").map((c) => c.text ?? "")
    : node.attrs.value !== undefined ? [node.attrs.value] : [];
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.ConditionExpression", AttributeName: node.attrs.attribute ?? null,
    EntityName: node.attrs.entityname ?? null, Operator: sdkOperator(node.attrs.operator), Values: values, CompareColumns: false,
  };
}

function filterJson(node) {
  const type = (node.attrs.type ?? "and").toLowerCase();
  if (type !== "and" && type !== "or") throw invalid(`Unknown filter type '${node.attrs.type}'.`); // unverified
  const conditions = [], filters = [];
  for (const child of node.children) {
    if (child.name === "condition") conditions.push(conditionJson(child));
    else if (child.name === "filter") filters.push(filterJson(child));
    else throw invalid(`FetchXML element '${child.name}' is not allowed in a filter.`); // unverified
  }
  return { "@odata.type": "Microsoft.Dynamics.CRM.FilterExpression", FilterOperator: type === "or" ? "Or" : "And", Conditions: conditions, Filters: filters };
}

// A root entity with no attribute returns every column in FetchXML; a link-entity with none returns nothing from the link.
function columnSetJson(children, { noAttributesMeansAll }) {
  const all = children.some((c) => c.name === "all-attributes") || (noAttributesMeansAll && !children.some((c) => c.name === "attribute"));
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.ColumnSet", AllColumns: all,
    Columns: all ? [] : children.filter((c) => c.name === "attribute").map((c) => c.attrs.name),
  };
}

// Criteria is the one top-level filter when the entity has exactly one, otherwise the entity's filters wrapped in And.
function criteriaJson(children) {
  const filters = children.filter((c) => c.name === "filter").map(filterJson);
  if (filters.length === 1) return filters[0];
  return { "@odata.type": "Microsoft.Dynamics.CRM.FilterExpression", FilterOperator: "And", Conditions: [], Filters: filters };
}

function ordersJson(children, entityName) {
  return children.filter((c) => c.name === "order").map((c) => ({
    "@odata.type": "Microsoft.Dynamics.CRM.OrderExpression", AttributeName: c.attrs.attribute, EntityName: entityName,
    OrderType: c.attrs.descending === "true" ? "Descending" : "Ascending", // unverified: the enum's JSON form
  }));
}

function checkChildren(node, allowed) {
  for (const child of node.children) if (!allowed.has(child.name)) throw invalid(`FetchXML element '${child.name}' has no QueryExpression equivalent in this simulator.`); // unverified
}

function linkJson(node, parentName) {
  checkChildren(node, FETCH_ENTITY_CHILDREN);
  const join = JOINS[node.attrs["link-type"] ?? "inner"];
  if (!join) throw invalid(`Unknown link-type '${node.attrs["link-type"]}'.`); // unverified
  const name = node.attrs.name;
  const alias = node.attrs.alias ?? null;
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.LinkEntity", LinkFromEntityName: parentName, LinkFromAttributeName: node.attrs.to ?? null,
    LinkToEntityName: name, LinkToAttributeName: node.attrs.from ?? null, JoinOperator: join, EntityAlias: alias,
    Columns: columnSetJson(node.children, { noAttributesMeansAll: false }), LinkCriteria: criteriaJson(node.children),
    LinkEntities: node.children.filter((c) => c.name === "link-entity").map((c) => linkJson(c, name)),
    Orders: ordersJson(node.children, alias ?? name),
  };
}

// The FetchXML fetch element as a QueryExpression JSON body.
export function queryJson(fetch) {
  checkChildren(fetch, new Set(["entity"]));
  const entity = fetch.children.find((c) => c.name === "entity");
  if (!entity) throw invalid("FetchXML requires an entity element."); // unverified
  checkChildren(entity, FETCH_ENTITY_CHILDREN);
  const { attrs } = fetch;
  const hasPaging = attrs.page !== undefined || attrs.count !== undefined || attrs["paging-cookie"] !== undefined || attrs.returntotalrecordcount !== undefined;
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.QueryExpression", EntityName: entity.attrs.name,
    ColumnSet: columnSetJson(entity.children, { noAttributesMeansAll: true }), Criteria: criteriaJson(entity.children),
    Distinct: attrs.distinct === "true", NoLock: attrs["no-lock"] === "true",
    LinkEntities: entity.children.filter((c) => c.name === "link-entity").map((c) => linkJson(c, entity.attrs.name)),
    Orders: ordersJson(entity.children, entity.attrs.name),
    PageInfo: hasPaging ? {
      Count: attrs.count !== undefined ? Number(attrs.count) : null, PageNumber: attrs.page !== undefined ? Number(attrs.page) : null,
      PagingCookie: attrs["paging-cookie"] ?? null, ReturnTotalRecordCount: attrs.returntotalrecordcount === "true",
    } : null,
    TopCount: attrs.top !== undefined ? Number(attrs.top) : null,
  };
}

// Parses and checks FetchXML the way Dataverse's Web API does (schema and limits). Malformed input raises the parser's 400.
export function parsedFetch(xml) {
  if (typeof xml !== "string" || !xml.trim()) throw invalid("FetchXml is required."); // unverified
  const fetch = parseXmlDocument(xml, { root: "fetch" });
  planFetch(fetch, { profile: "webapi" });
  return fetch;
}

// ---- Knowledge and search helpers ----

const contains = (value, text) => String(value ?? "").toLowerCase().includes(String(text).toLowerCase());
const sameId = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

// Rows the caller may read. Learn gives no privilege text, so the table read privilege is the one checked.
function readRows(api, ctx, logical) {
  const mapping = api.store.resolveMapping(logical);
  api.principals.authorize({ user: ctx.user, entity: logical, operation: "read", mapping });
  return api.store.rows(logical, ctx.identity);
}

// A subject given as a GUID or as an object (or JSON text) with subjectid.
function subjectIdOf(value) {
  if (value && typeof value === "object") return value.subjectid ?? value.id ?? null;
  const text = String(value ?? "").trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      return parsed.subjectid ?? parsed.id ?? null;
    } catch {
      return null;
    }
  }
  return text || null;
}

const collection = (ctx, rows) => ({
  status: 200,
  body: { "@odata.context": contextFor(ctx, "Collection(Microsoft.Dynamics.CRM.crmbaseentity)"), value: rows }, // unverified: the collection context
});

// ---- Handlers ----

function fetchXmlToQueryExpression(api, ctx) {
  const query = queryJson(parsedFetch(ctx.params?.FetchXml));
  return { status: 200, body: { "@odata.context": contextFor(ctx, "Microsoft.Dynamics.CRM.FetchXmlToQueryExpressionResponse"), Query: query } };
}

function queryExpressionToFetchXml(api, ctx) {
  if (!ctx.body?.Query) throw invalid("Query is required.");
  const primaryIdOf = (entity) => {
    try {
      return api.store.resolveMapping(entity).idColumn ?? null;
    } catch {
      return null;
    }
  };
  const FetchXml = toFetchXml(modelOf(ctx.body.Query), { primaryIdOf });
  return { status: 200, body: { "@odata.context": contextFor(ctx, "Microsoft.Dynamics.CRM.QueryExpressionToFetchXmlResponse"), FetchXml } };
}

function validateFetchXmlExpression(api, ctx) {
  parsedFetch(ctx.params?.FetchXml);
  // unverified: the performance checks Learn describes are not simulated, so no messages are reported.
  return { status: 200, body: { "@odata.context": contextFor(ctx, "Microsoft.Dynamics.CRM.ValidateFetchXmlExpressionResponse"), ValidationResults: { Helplink: null, Messages: [] } } };
}

// A saved query is validated against the same FetchXML rules; Learn gives no response, so the action answers 204.
function validateSavedQuery(api, ctx) {
  api.principals.authorize({ user: ctx.user, entity: "savedquery", operation: "read", mapping: api.store.resolveMapping("savedquery") });
  const body = ctx.body ?? {};
  parsedFetch(body.FetchXml);
  if (body.QueryType == null) throw invalid("QueryType is required."); // unverified
  return null;
}

function retrieveTimestamp(api, ctx) {
  const now = api.clock ? api.clock() : Date.now();
  return { status: 200, body: { "@odata.context": contextFor(ctx, "Microsoft.Dynamics.CRM.RetrieveTimestampResponse"), Timestamp: new Date(now).toISOString() } }; // unverified: the timestamp format
}

// ponytail: plain containment over the article text columns; UseInflection is ignored and QueryExpression refused. Add stem matching when a project's search needs it.
function fullTextSearch(api, ctx) {
  const body = ctx.body ?? {};
  if (typeof body.SearchText !== "string" || !body.SearchText) throw invalid("SearchText is required."); // unverified
  if (body.QueryExpression != null) throw new DataError("QueryExpression is not simulated for FullTextSearchKnowledgeArticle.", 501, "NotImplemented");
  let rows = readRows(api, ctx, "knowledgearticle").filter((row) =>
    ["title", "description", "keywords", "content"].some((column) => contains(row[column], body.SearchText)));
  if (body.StateCode != null) rows = rows.filter((row) => Number(row.statecode) === Number(body.StateCode));
  if (body.RemoveDuplicates === true) {
    // One row per article family: the latest version, else the first seen. unverified: Learn does not say which version wins.
    const kept = new Map();
    for (const row of rows) {
      const key = row.rootarticleid ?? row.knowledgearticleid;
      if (!kept.has(key) || (row.islatestversion === true && kept.get(key).islatestversion !== true)) kept.set(key, row);
    }
    rows = [...kept.values()];
  }
  return collection(ctx, rows);
}

// The kbarticle searches read one column each: Title the title, Keywords the keywords, Body the content.
function kbSearch(column) {
  return (api, ctx) => {
    const text = ctx.params?.SearchText;
    if (typeof text !== "string" || !text) throw invalid("SearchText is required."); // unverified
    const subjectId = subjectIdOf(ctx.params?.Subject);
    let rows = readRows(api, ctx, "kbarticle").filter((row) => contains(row[column], text));
    if (subjectId != null) rows = rows.filter((row) => sameId(row.subjectid, subjectId));
    return collection(ctx, rows);
  };
}

// The top ten articles about the bound subject. Order is the table's order (unverified).
function retrieveByTopIncidentSubject(api, ctx) {
  const rows = readRows(api, ctx, "kbarticle").filter((row) => sameId(row.subjectid, ctx.target?.id));
  return collection(ctx, rows.slice(0, 10));
}

// ---- CSDL (the registry joins the fragments into the service schema) ----

const complex = (name, property, type) => `<ComplexType Name="${name}Response"><Property Name="${property}" Type="${type}" /></ComplexType>`;
const CSDL = {
  FetchXmlToQueryExpression: [
    complex("FetchXmlToQueryExpression", "Query", "Edm.Untyped"), // unverified: the QueryExpression type is not declared here
    '<Function Name="FetchXmlToQueryExpression"><Parameter Name="FetchXml" Type="Edm.String" /><ReturnType Type="mscrm.FetchXmlToQueryExpressionResponse" Nullable="false" /></Function>',
  ].join("\n"),
  QueryExpressionToFetchXml: [
    complex("QueryExpressionToFetchXml", "FetchXml", "Edm.String"),
    '<Action Name="QueryExpressionToFetchXml"><Parameter Name="Query" Type="Edm.Untyped" /><ReturnType Type="mscrm.QueryExpressionToFetchXmlResponse" Nullable="false" /></Action>',
  ].join("\n"),
  ValidateFetchXmlExpression: [
    complex("ValidateFetchXmlExpression", "ValidationResults", "Edm.Untyped"),
    '<Function Name="ValidateFetchXmlExpression"><Parameter Name="FetchXml" Type="Edm.String" /><ReturnType Type="mscrm.ValidateFetchXmlExpressionResponse" Nullable="false" /></Function>',
  ].join("\n"),
  ValidateSavedQuery: '<Action Name="ValidateSavedQuery" IsBound="true"><Parameter Name="bindingParameter" Type="Collection(mscrm.savedquery)" /><Parameter Name="FetchXml" Type="Edm.String" Nullable="false" /><Parameter Name="QueryType" Type="Edm.Int32" Nullable="false" /></Action>',
  RetrieveTimestamp: [
    complex("RetrieveTimestamp", "Timestamp", "Edm.String"),
    '<Function Name="RetrieveTimestamp"><ReturnType Type="mscrm.RetrieveTimestampResponse" Nullable="false" /></Function>',
  ].join("\n"),
  FullTextSearchKnowledgeArticle: '<Action Name="FullTextSearchKnowledgeArticle"><Parameter Name="SearchText" Type="Edm.String" Nullable="false" /><Parameter Name="UseInflection" Type="Edm.Boolean" /><Parameter Name="RemoveDuplicates" Type="Edm.Boolean" /><Parameter Name="StateCode" Type="Edm.Int32" /><Parameter Name="QueryExpression" Type="Edm.Untyped" /><ReturnType Type="Collection(mscrm.crmbaseentity)" Nullable="false" /></Action>',
  kbSearch: (name) => `<Function Name="${name}" IsBound="true"><Parameter Name="entity" Type="Collection(mscrm.kbarticle)" /><Parameter Name="SearchText" Type="Edm.String" Nullable="false" /><Parameter Name="Subject" Type="mscrm.subject" /><Parameter Name="UseInflection" Type="Edm.Boolean" /><ReturnType Type="Collection(mscrm.kbarticle)" Nullable="false" /></Function>`,
  RetrieveByTopIncidentSubjectKbArticle: '<Function Name="RetrieveByTopIncidentSubjectKbArticle" IsBound="true"><Parameter Name="entity" Type="mscrm.subject" /><ReturnType Type="Collection(mscrm.kbarticle)" Nullable="false" /></Function>',
};

// ---- G5a: knowledge versions and views, rollup, virtual table events, composite data sources, certificate credentials,
// managed identity subjects and business process flows. The native signatures are in the registrations (the catalogue). ----

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
const key = (value) => String(value ?? "").toLowerCase();
const tableOf = (store, logical) => (store.state.tables[logical] ??= []);
const DATAVERSE_NAMESPACE = uuidV5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "paqvilo-dataverse"); // as dataverse-api.mjs
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { id, innerCode: "0x80040217" });
const argsOf = (c) => ({ ...(typeof c.body === "string" ? JSON.parse(c.body || "{}") : (c.body ?? {})), ...(c.params ?? {}) });
const respond = (c, name, payload) => ({ status: 200, body: { "@odata.context": contextFor(c, `Microsoft.Dynamics.CRM.${name}Response`), ...payload } });
const write = (api, fn) => api.change(() => api.store.transact(fn, { isolated: true }));
const need = (api, c, logical, right) => {
  const privilege = privilegeName(right, api.principals.privilegeNoun(logical));
  if (!(api.principals.privileges(c.user).get(privilege) > 0)) throw privilegeDeniedError(c.user, privilege, logical);
};
// Reads go through store.tableRows (no table is created by a read); writes inside write() use tableOf.
const findRow = (store, logical, pk, id) => (id == null ? null : store.tableRows(logical).find((row) => sameId(row[pk], id)) ?? null);
function mustRow(store, logical, pk, id) {
  const row = findRow(store, logical, pk, id);
  if (!row) throw notFound(logical, id);
  return row;
}
const orgIdOf = (store) => organizationRecord(store)?.organizationid ?? ZERO_GUID;
const tenantOf = (api) => (api.settings?.tenantId ?? uuidV5(DATAVERSE_NAMESPACE, `${api.settings?.uniqueName}:tenant`)).toLowerCase(); // as dataverse-api.mjs

// An entity reference ({"@odata.id": "accounts(guid)"}, an entity with @odata.type, or the URL text): its logical name and id.
function refOf(api, value) {
  const text = typeof value === "string" ? value : String(value?.["@odata.id"] ?? "");
  const type = value?.["@odata.type"];
  const logical = type ? String(type).split(".").pop() : text ? api.store.resolveMapping(text.split("(")[0].split("/").pop()).logicalName : null;
  return { logical, id: idOf(value) };
}

// A knowledge article copy, as a draft that is not a root article: the source minus its id and state.
const draftOf = (source, fields) => {
  const { knowledgearticleid, statecode, statuscode, ...rest } = source;
  return { ...rest, knowledgearticleid: randomUUID(), statecode: 0, statuscode: 2, isrootarticle: false, islatestversion: true, ...fields };
};
// Only one article per root and language is the latest version.
function clearLatest(rows, root, language) {
  for (const row of rows) if (sameId(row.rootarticleid ?? row.knowledgearticleid, root) && key(row.languagelocaleid) === key(language)) row.islatestversion = false;
}

// Learn: IncrementKnowledgeArticleViewCount. unverified: whether Location is part of the day row's key (the day row is found
// by article and UTC day, as the brief states), and the response shape. Invented data only.
async function incrementViews(api, c) {
  need(api, c, "knowledgearticle", "Read");
  const { Source, ViewDate, Location, Count } = argsOf(c);
  const articleId = idOf(Source);
  mustRow(api.store, "knowledgearticle", "knowledgearticleid", articleId);
  const location = Number(Location), count = Number(Count), date = new Date(ViewDate);
  if (!(location === 1 || location === 2) || !Number.isInteger(count) || count < 0 || Number.isNaN(date.getTime())) throw invalid("Invalid argument.");
  const day = date.toISOString().slice(0, 10);
  let view;
  await write(api, () => {
    const article = mustRow(api.store, "knowledgearticle", "knowledgearticleid", articleId);
    const rows = tableOf(api.store, "knowledgearticleviews");
    view = rows.find((row) => sameId(row.knowledgearticleid, articleId) && String(row.viewdate).slice(0, 10) === day);
    if (view) view.knowledgearticleview = Number(view.knowledgearticleview ?? 0) + count;
    else {
      view = { knowledgearticleviewsid: uuidV5(articleId, `kav:${day}:${location}`), knowledgearticleid: articleId, viewdate: `${day}T00:00:00Z`, location, knowledgearticleview: count, statecode: 0, statuscode: 1 };
      rows.push(view);
    }
    article.knowledgearticleviews = rows.filter((row) => sameId(row.knowledgearticleid, articleId)).reduce((sum, row) => sum + Number(row.knowledgearticleview ?? 0), 0);
    article.knowledgearticleviews_date = new Date(api.clock ? api.clock() : Date.now()).toISOString();
  });
  return { status: 200, body: { "@odata.context": contextFor(c, "knowledgearticleviews/$entity"), ...view } };
}

// Learn: CreateKnowledgeArticleVersion. A major version adds one to the major number and resets the minor; otherwise the minor
// number goes up. unverified: which copied fields are kept and the status of the draft.
async function createVersion(api, c) {
  need(api, c, "knowledgearticle", "Create");
  const args = argsOf(c);
  const source = mustRow(api.store, "knowledgearticle", "knowledgearticleid", idOf(args.Source));
  const major = String(args.IsMajor) === "true";
  const root = source.rootarticleid ?? source.knowledgearticleid;
  const majorNumber = Number(source.majorversionnumber ?? 1), minorNumber = Number(source.minorversionnumber ?? 0);
  let fresh;
  await write(api, () => {
    const rows = tableOf(api.store, "knowledgearticle");
    fresh = draftOf(source, {
      majorversionnumber: major ? majorNumber + 1 : majorNumber, minorversionnumber: major ? 0 : minorNumber + 1,
      rootarticleid: root, parentarticlecontentid: source.knowledgearticleid, previousarticlecontentid: source.knowledgearticleid,
    });
    clearLatest(rows, root, source.languagelocaleid);
    rows.push(fresh);
  });
  return { status: 200, body: { "@odata.context": contextFor(c, "knowledgearticles/$entity"), ...fresh } };
}

// Learn: CreateKnowledgeArticleTranslation. Error texts are unverified; the codes are from the Learn error list.
async function createTranslation(api, c) {
  need(api, c, "knowledgearticle", "Create");
  const args = argsOf(c);
  const languageId = idOf(args.Language);
  if (!findRow(api.store, "languagelocale", "languagelocaleid", languageId)) {
    throw new DataError(`Language with Locale ID ${languageId}, does not exist`, 400, "InvalidRequest", { innerCode: "0x80061400" });
  }
  const source = mustRow(api.store, "knowledgearticle", "knowledgearticleid", idOf(args.Source));
  if (source.isprimary === false) throw new DataError("Only primary articles can be translated.", 400, "InvalidRequest", { innerCode: "0x80061402" });
  const root = source.rootarticleid ?? source.knowledgearticleid;
  const exists = api.store.tableRows("knowledgearticle").some((row) =>
    sameId(row.rootarticleid ?? row.knowledgearticleid, root) && key(row.languagelocaleid) === key(languageId) &&
    Number(row.majorversionnumber) === Number(source.majorversionnumber) && Number(row.minorversionnumber) === Number(source.minorversionnumber));
  if (exists) throw new DataError("An article translation already exists for this language and version.", 400, "InvalidRequest", { innerCode: "0x80061403" });
  let fresh;
  await write(api, () => {
    const rows = tableOf(api.store, "knowledgearticle");
    fresh = draftOf(source, { languagelocaleid: languageId, isprimary: false, parentarticlecontentid: source.knowledgearticleid, rootarticleid: root });
    clearLatest(rows, root, languageId);
    rows.push(fresh);
  });
  return { status: 200, body: { "@odata.context": contextFor(c, "knowledgearticles/$entity"), ...fresh } };
}

// Learn: RollupRequest. The Query entity and the target decide which RollupType values apply (base-environment subset).
const ROLLUP_TYPES = ["None", "Related", "Extended"];
const ROLLUP_RULES = {
  activitypointer: { account: ["Related", "Extended"], contact: ["Related", "Extended"] },
  annotation: { account: ROLLUP_TYPES, contact: ROLLUP_TYPES },
};
const CHILD_RELATIONS = [["account", "parentaccountid"], ["contact", "parentcustomerid"]];
const notForRollup = (name) => new DataError(`The entity ${name} is not a valid entity for rollup.`, 400, "InvalidRequest", { innerCode: "0x80044813" });

// RollupType as a name or a number, in the forms a Web API caller sends: Microsoft.Dynamics.CRM.RollupType'Related', Related or 1.
function rollupTypeOf(value) {
  const text = String(value ?? "");
  const name = /^\d+$/.test(text) ? ROLLUP_TYPES[Number(text)] : (text.match(/'(\w+)'$/)?.[1] ?? text);
  const type = ROLLUP_TYPES.find((entry) => entry.toLowerCase() === String(name).toLowerCase());
  if (!type) throw invalid("The rollup type is invalid.", "0x80040234"); // unverified: the message text
  return type;
}

// The target and its children: Related takes the direct children, Extended every descendant (breadth first, no depth cap).
// ponytail: children are read from the store, not through the caller's privileges; the rows are then read through the GET below.
function rollupSet(store, targetId, type) {
  const set = new Set([key(targetId)]);
  let frontier = type === "None" ? [] : [targetId];
  while (frontier.length) {
    const next = [];
    for (const parent of frontier) for (const [table, column] of CHILD_RELATIONS) for (const row of store.tableRows(table)) {
      const id = row[`${table}id`];
      if (sameId(idOf(row[column]), parent) && !set.has(key(id))) {
        set.add(key(id));
        next.push(id);
      }
    }
    frontier = type === "Extended" ? next : [];
  }
  return set;
}

async function rollup(api, c) {
  const args = argsOf(c);
  const target = refOf(api, args.Target);
  const query = typeof args.Query === "string" ? JSON.parse(args.Query) : args.Query;
  const entity = query?.EntityName;
  if (!Object.hasOwn(ROLLUP_RULES, entity)) throw notForRollup(entity);
  const allowed = Object.hasOwn(ROLLUP_RULES[entity], target.logical) ? ROLLUP_RULES[entity][target.logical] : null;
  if (!allowed) throw notForRollup(target.logical); // unverified: the target check
  const type = rollupTypeOf(args.RollupType);
  if (!allowed.includes(type)) throw invalid("The rollup type is invalid.", "0x80040234");
  const set = rollupSet(api.store, target.id, type);
  const { entitySet } = api.store.resolveMapping(entity);
  // All columns, so the regarding or object lookup is present whatever the caller's column set.
  const xml = toFetchXml(modelOf({ ...query, ColumnSet: { AllColumns: true, Columns: [] } }), { primaryIdOf: (name) => api.store.resolveMapping(name).idColumn ?? null });
  const path = `/api/data/${c.version}/${entitySet}`;
  const result = await api.records.handle({
    method: "GET", route: parseDataverseRoute(path), url: new URL(`${c.origin}${path}?fetchXml=${encodeURIComponent(xml)}`), origin: c.origin, version: c.version,
    prefer: parsePrefer(undefined), headers: {}, user: c.user, caller: c.caller, identity: c.identity, requestId: c.requestId,
  });
  const lookup = entity === "annotation" ? "_objectid_value" : "_regardingobjectid_value";
  return collection(c, (result.body?.value ?? []).filter((row) => set.has(key(row[lookup]))));
}

// Learn: OnExternalUpdated, the event a virtual table's data source raises. ponytail: no plug-in or async dispatch, because
// Learn says only async steps run for these events. unverified: the virtualentitymetadata match (its name column) and the codes.
function virtualEventMetadata(api, logical) {
  const metadataId = api.metadata?.entity(logical)?.MetadataId;
  return api.store.tableRows('virtualentitymetadata').find(row => row.extensionofrecordid != null
    ? sameId(idOf(row.extensionofrecordid), metadataId) : key(row.name) === key(logical));
}
function onExternalEvent(name) { return async (api, c) => {
  const args = argsOf(c);
  const logical = refOf(api, args.Target).logical;
  if (!logical) throw invalid("Target is required.");
  need(api, c, logical, "Write");
  const mapping = api.store.resolveMapping(logical);
  if (!(mapping.isVirtual || mapping.dataSourceId)) throw invalid(`${logical} is not a virtual table.`);
  if (c.target?.mapping && c.target.mapping.logicalName !== logical) throw invalid("Target does not match the bound virtual table.");
  if (name === "OnExternalUpdated" && !Array.isArray(args.ChangedFields)) throw invalid("ChangedFields is required.");
  const meta = virtualEventMetadata(api, logical);
  const enabled = `is${name.toLowerCase()}enabled`;
  if (!meta || meta[enabled] !== true) throw invalid(`External event ${name} is not enabled for ${logical}.`, "0x80090309"); // unverified: fault text
  if (name === "OnExternalUpdated" && args.ChangedFields.length && meta.ischangedfieldsenabledforupdateevent !== true) {
    throw new DataError(`Changed fields are not enabled for the update event of ${logical}.`, 400, "InvalidRequest", { innerCode: "0x80073019" });
  }
  const { ["@odata.type"]: ignoredType, ["@odata.id"]: ignoredId, ...target } = args.Target ?? {};
  const id = refOf(api, args.Target).id;
  if (id) target[mapping.idColumn] ??= id;
  // Notifications publish the supplied external snapshot. They never create or
  // change a local row: the external provider remains the owner of the data.
  await write(api, () => api.store.recordCommittedEvent(logical, name.toLowerCase(), target, args.ChangedFields ?? Object.keys(target), {
    target, previous: args.PreImage ?? null, identity: c.identity,
  }));
  return { status: 204 };
}; }

// Composite data sources are environment variable definitions: a parent of type 100000004 (Data source) with an optional child
// that names it as its parent. The ids are derived from the schema name, so both messages address the same rows.
const ENV_DEFINITION = "environmentvariabledefinition";
const DATA_SOURCE_TYPE = 100000004;
const definitionIdOf = (store, schema) => uuidV5(orgIdOf(store), `environmentvariabledefinition:${String(schema).toLowerCase()}`);
const valueIdOf = (store, schema) => uuidV5(orgIdOf(store), `environmentvariablevalue:${String(schema).toLowerCase()}`);
const missingComposite = (schema) => new DataError(`Failed to find environment variables with schema name(s) '${schema}'.`, 404, "NotFound", { innerCode: "0x80095004" }); // unverified: text

function upsertDefinition(store, { schema, displayName, parameterKey, apiId, parentId }) {
  const id = definitionIdOf(store, schema);
  const fields = { schemaname: schema, displayname: displayName ?? null, parameterkey: parameterKey ?? null, apiid: apiId ?? null, type: DATA_SOURCE_TYPE, parentdefinitionid: parentId ?? null };
  const rows = tableOf(store, ENV_DEFINITION);
  const row = rows.find((entry) => sameId(entry.environmentvariabledefinitionid, id));
  if (row) Object.assign(row, fields);
  else rows.push({ environmentvariabledefinitionid: id, ...fields });
  return id;
}

function upsertValue(store, definitionId, schema, value) {
  if (value == null || value === "") return;
  const id = valueIdOf(store, schema);
  const rows = tableOf(store, "environmentvariablevalue");
  const row = rows.find((entry) => sameId(entry.environmentvariablevalueid, id));
  if (row) row.value = value;
  else rows.push({ environmentvariablevalueid: id, environmentvariabledefinitionid: definitionId, value });
}

// The definition with its values expanded under the navigation property name.
const expanded = (store, row) => ({
  ...row,
  environmentvariabledefinition_environmentvariablevalue: store.tableRows("environmentvariablevalue").filter((value) => sameId(value.environmentvariabledefinitionid, row.environmentvariabledefinitionid)),
});
const definitionOf = (store, schema) => findRow(store, ENV_DEFINITION, "environmentvariabledefinitionid", definitionIdOf(store, schema));

async function upsertComposite(api, c) {
  need(api, c, ENV_DEFINITION, "Write");
  const a = argsOf(c);
  if (!a.ParentSchemaName || !a.ParentParameterKey) throw invalid("ParentSchemaName and ParentParameterKey are required."); // unverified
  await write(api, () => {
    const parentId = upsertDefinition(api.store, { schema: a.ParentSchemaName, displayName: a.ParentDisplayName, parameterKey: a.ParentParameterKey, apiId: a.ParentApiId });
    upsertValue(api.store, parentId, a.ParentSchemaName, a.ParentValue);
    if (a.ChildSchemaName) {
      const childId = upsertDefinition(api.store, { schema: a.ChildSchemaName, displayName: a.ChildDisplayName, parameterKey: a.ChildParameterKey, parentId });
      upsertValue(api.store, childId, a.ChildSchemaName, a.ChildValue);
    }
  });
  return { status: 204 };
}

function retrieveComposite(api, c) {
  need(api, c, ENV_DEFINITION, "Read");
  const a = argsOf(c);
  const parent = definitionOf(api.store, a.ParentSchemaName) ?? throwMissing(a.ParentSchemaName);
  const child = definitionOf(api.store, a.ChildSchemaName) ?? throwMissing(a.ChildSchemaName);
  return collection(c, [expanded(api.store, parent), expanded(api.store, child)]);
}

function retrieveAllComposite(api, c) {
  need(api, c, ENV_DEFINITION, "Read");
  const parent = definitionOf(api.store, argsOf(c).ParentSchemaName) ?? throwMissing(argsOf(c).ParentSchemaName);
  const children = api.store.tableRows(ENV_DEFINITION).filter((row) => sameId(row.parentdefinitionid, parent.environmentvariabledefinitionid));
  return collection(c, [parent, ...children].map((row) => expanded(api.store, row)));
}
function throwMissing(schema) {
  throw missingComposite(schema);
}

// Certificate credentials belong to a managed identity (powerpagesmanagedidentity is absent, so only managedidentity is served).
// Learn gives no texts for these, so every error below is unverified apart from the codes in the Learn-derived comments.
function ownerOf(store, logical, id) {
  if (logical !== "managedidentity") throw invalid(`${logical} cannot hold certificate credentials.`); // unverified
  return mustRow(store, "managedidentity", "managedidentityid", id);
}

async function addCertificate(api, c) {
  need(api, c, "certificatecredential", "Write");
  const a = argsOf(c);
  const entityId = idOf(a.entityId);
  ownerOf(api.store, a.entityLogicalName, entityId);
  const thumb = String(a.thumbprint ?? "").toUpperCase();
  if (!/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/.test(thumb)) throw new DataError("The given certificate is invalid.", 400, "InvalidRequest", { innerCode: "0x8005E23A" });
  const id = uuidV5(entityId, `cc:${thumb}`);
  await write(api, () => {
    const rows = tableOf(api.store, "certificatecredential");
    if (!rows.some((row) => sameId(row.certificatecredentialid, id))) {
      rows.push({ certificatecredentialid: id, thumbprint: thumb, componentid: entityId, name: thumb, statecode: 0, statuscode: 1 });
    }
  });
  return { status: 204 };
}

function getCertificates(api, c) {
  need(api, c, "certificatecredential", "Read");
  const a = argsOf(c);
  const entityId = idOf(a.entityId);
  ownerOf(api.store, a.entityLogicalName, entityId);
  return collection(c, api.store.tableRows("certificatecredential").filter((row) => sameId(row.componentid, entityId)));
}

async function removeCertificate(api, c) {
  need(api, c, "certificatecredential", "Write");
  const a = argsOf(c);
  const entityId = idOf(a.entityId);
  ownerOf(api.store, a.entityLogicalName, entityId);
  const certificateId = idOf(a.certificateCredentialId);
  const found = api.store.tableRows("certificatecredential").some((row) => sameId(row.certificatecredentialid, certificateId) && sameId(row.componentid, entityId));
  if (!found) throw new DataError("The given certificate cannot be found.", 404, "NotFound", { innerCode: "0x8005E239" });
  await write(api, () => {
    const rows = tableOf(api.store, "certificatecredential");
    const index = rows.findIndex((row) => sameId(row.certificatecredentialid, certificateId) && sameId(row.componentid, entityId));
    if (index >= 0) rows.splice(index, 1);
  });
  return { status: 204 };
}

// .NET Guid.ToByteArray order: the first three groups little-endian, the last two as written.
function netGuidBytes(guid) {
  const b = Buffer.from(guid.replace(/-/g, ""), "hex");
  return Buffer.concat([b.subarray(0, 4).reverse(), b.subarray(4, 6).reverse(), b.subarray(6, 8).reverse(), b.subarray(8)]);
}
const FIC_COMPONENTS = { pluginassembly: "pluginassemblyid", pluginpackage: "pluginpackageid", serviceendpoint: "serviceendpointid" };

// Learn: the federated identity subject of a managed identity bound to a component (set-up-managed-identity). unverified: the
// h segment is a stand-in (native hashes the signing certificate); LC-G5-2 records the real value.
function ficSubject(api, c) {
  const a = argsOf(c);
  const logical = String(a.ComponentName ?? "").toLowerCase();
  if (!Object.hasOwn(FIC_COMPONENTS, logical)) throw invalid(`${a.ComponentName} has no managed identity.`); // unverified
  need(api, c, logical, "Read");
  const id = idOf(a.ComponentId);
  const component = mustRow(api.store, logical, FIC_COMPONENTS[logical], id);
  if (!idOf(component.managedidentityid)) throw invalid(`${logical} has no managed identity.`); // unverified
  const tenant = tenantOf(api);
  const environment = api.settings?.environmentId ?? `Default-${tenant}`;
  const hash = createHash("sha256").update(String(id).toLowerCase()).digest("hex");
  return respond(c, "GetComponentManagedIdentityFIC", {
    FICSubject: `/eid1/c/pub/t/${netGuidBytes(tenant).toString("base64url")}/a/qzXoWDkuqUa3l6zM5mM0Rw/n/plugin/e/${environment}/h/${hash}`,
  });
}

// Business process flows are workflow rows of category 4. Each instance table is named by the definition's uniquename.
const BPF_CATEGORY = 4;
const ACTIVATED = 1;
function bpfDefinitions(store, match) {
  return store.tableRows("workflow").filter((row) => Number(row.category) === BPF_CATEGORY && match(row));
}
function instanceMapping(store, name) {
  try {
    return store.resolveMapping(name);
  } catch {
    return null; // a definition whose instance table is not in the store
  }
}

// Learn: RetrieveProcessInstances. The instances of the activated flows on this entity, newest first.
function processInstances(api, c) {
  const a = argsOf(c);
  const logical = a.EntityLogicalName;
  need(api, c, logical, "Read");
  const entityId = idOf(a.EntityId);
  const found = [];
  for (const definition of bpfDefinitions(api.store, (row) => key(row.primaryentity) === key(logical) && Number(row.statecode) === ACTIVATED)) {
    const mapping = instanceMapping(api.store, definition.uniquename);
    if (!mapping) continue;
    const rows = api.store.tableRows(mapping.logicalName);
    const lookup = [`bpf_${logical}id`, `${logical}id`].find((column) => column in (mapping.fields ?? {}) || rows.some((row) => column in row));
    if (!lookup) continue;
    for (const row of rows) if (sameId(row[lookup], entityId)) found.push({ ...row, processstageid: idOf(row.activestageid) });
  }
  found.sort((x, y) => (Date.parse(y.modifiedon) || 0) - (Date.parse(x.modifiedon) || 0));
  return collection(c, found);
}

// Learn: RetrieveActivePath. ponytail: no branch conditions, so every stage of the flow is on the path; the traversed stages come
// first, in order. ponytail: the entity name is not known from the instance id, so the not-found message omits it.
function activePath(api, c) {
  need(api, c, "processstage", "Read");
  const id = idOf(argsOf(c).ProcessInstanceId);
  let instance = null, definition = null;
  for (const candidate of bpfDefinitions(api.store, () => true)) {
    const mapping = instanceMapping(api.store, candidate.uniquename);
    const row = mapping ? api.store.tableRows(mapping.logicalName).find((entry) => sameId(entry[mapping.idColumn], id)) : undefined;
    if (row) {
      instance = row;
      definition = candidate;
      break;
    }
  }
  if (!instance) throw new DataError(`Supplied process instance ${id} does not match any existing instance.`, 404, "NotFound", { innerCode: "0x80060370" });
  const stages = api.store.tableRows("processstage").filter((stage) => sameId(stage.processid, definition.workflowid));
  const traversed = String(instance.traversedpath ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const value = [
    ...traversed.map((stageId) => stages.find((stage) => sameId(stage.processstageid, stageId))).filter(Boolean),
    ...stages.filter((stage) => !traversed.some((stageId) => sameId(stageId, stage.processstageid))),
  ];
  return { status: 200, body: { "@odata.context": contextFor(c, "processstages"), value } };
}

export function install(api) {
  const op = (name, kind, binding, handle, csdl, entity) =>
    api.registry.register({ name, kind, binding, ...(entity ? { entity } : {}), csdl, handle: (ctx) => handle(api, ctx) });
  op("FetchXmlToQueryExpression", "function", "unbound", fetchXmlToQueryExpression, CSDL.FetchXmlToQueryExpression);
  op("QueryExpressionToFetchXml", "action", "unbound", queryExpressionToFetchXml, CSDL.QueryExpressionToFetchXml);
  op("ValidateFetchXmlExpression", "function", "unbound", validateFetchXmlExpression, CSDL.ValidateFetchXmlExpression);
  op("ValidateSavedQuery", "action", "collection", validateSavedQuery, CSDL.ValidateSavedQuery, "savedquery");
  op("RetrieveTimestamp", "function", "unbound", retrieveTimestamp, CSDL.RetrieveTimestamp);
  op("FullTextSearchKnowledgeArticle", "action", "unbound", fullTextSearch, CSDL.FullTextSearchKnowledgeArticle);
  op("SearchByTitleKbArticle", "function", "collection", kbSearch("title"), CSDL.kbSearch("SearchByTitleKbArticle"), "kbarticle");
  op("SearchByKeywordsKbArticle", "function", "collection", kbSearch("keywords"), CSDL.kbSearch("SearchByKeywordsKbArticle"), "kbarticle");
  op("SearchByBodyKbArticle", "function", "collection", kbSearch("content"), CSDL.kbSearch("SearchByBodyKbArticle"), "kbarticle");
  op("RetrieveByTopIncidentSubjectKbArticle", "function", "entity", retrieveByTopIncidentSubject, CSDL.RetrieveByTopIncidentSubjectKbArticle, "subject");
  // G5a. Each is unbound and declared from its native signature (the registry builds the CSDL from it). Edm.Untyped stands in
  // for the QueryBase and the RollupType enum, which are not declared here.
  const declare = (name, kind, handle, signature) => api.registry.register({ name, kind, binding: "unbound", signature, handle: (ctx) => handle(api, ctx) });
  declare("IncrementKnowledgeArticleViewCount", "function", incrementViews, {
    params: [["Source", "mscrm.crmbaseentity"], ["ViewDate", "Edm.DateTimeOffset"], ["Location", "Edm.Int32"], ["Count", "Edm.Int32"]], returns: "mscrm.crmbaseentity",
  });
  declare("CreateKnowledgeArticleVersion", "action", createVersion, { params: [["Source", "mscrm.crmbaseentity"], ["IsMajor", "Edm.Boolean"]], returns: "mscrm.crmbaseentity" });
  declare("CreateKnowledgeArticleTranslation", "action", createTranslation, {
    params: [["Source", "mscrm.crmbaseentity"], ["Language", "mscrm.crmbaseentity"], ["IsMajor", "Edm.Boolean"]], returns: "mscrm.crmbaseentity",
  });
  declare("Rollup", "function", rollup, { params: [["Target", "mscrm.crmbaseentity"], ["Query", "Edm.Untyped"], ["RollupType", "Edm.String"]], returns: "Collection(mscrm.crmbaseentity)" });
  const virtualBindings = new Set();
  const registerVirtualBindings = () => {
    for (const [entity, mapping] of Object.entries(api.store.state.mappings)) {
      if (!mapping.isVirtual && !mapping.dataSourceId) continue;
      for (const name of ["OnExternalCreated", "OnExternalUpdated", "OnExternalDeleted"]) {
        const key = `${name}:${entity}`;
        if (virtualBindings.has(key) || virtualEventMetadata(api, entity)?.[`is${name.toLowerCase()}enabled`] !== true) continue;
        const signature = { params: [["Target", "mscrm.crmbaseentity"], ...(name === "OnExternalUpdated" ? [["PreImage", "mscrm.crmbaseentity"], ["ChangedFields", "Collection(Edm.String)"]] : [])] };
        api.registry.register({ name, kind: "action", binding: "collection", entity, signature, handle: c => onExternalEvent(name)(api, c) });
        virtualBindings.add(key);
      }
    }
  };
  for (const name of ["OnExternalCreated", "OnExternalUpdated", "OnExternalDeleted"]) {
    const signature = { params: [["Target", "mscrm.crmbaseentity"], ...(name === "OnExternalUpdated" ? [["PreImage", "mscrm.crmbaseentity"], ["ChangedFields", "Collection(Edm.String)"]] : [])] };
    declare(name, "action", onExternalEvent(name), signature);
  }
  registerVirtualBindings();
  api.recordHooks?.add('afterWrite', (_c, mapping) => { if (mapping.logicalName === 'virtualentitymetadata') registerVirtualBindings(); });
  declare("UpsertCompositeDataSource", "action", upsertComposite, {
    params: [["ParentDisplayName", "Edm.String"], ["ParentSchemaName", "Edm.String"], ["ParentParameterKey", "Edm.String"], ["ParentApiId", "Edm.String"], ["ParentValue", "Edm.String"],
      ["ChildDisplayName", "Edm.String"], ["ChildSchemaName", "Edm.String"], ["ChildParameterKey", "Edm.String"], ["ChildValue", "Edm.String"]],
  });
  declare("RetrieveCompositeDataSource", "function", retrieveComposite, { params: [["ParentSchemaName", "Edm.String"], ["ChildSchemaName", "Edm.String"]], returns: "Collection(mscrm.crmbaseentity)" });
  declare("RetrieveAllCompositeDataSources", "function", retrieveAllComposite, { params: [["ParentSchemaName", "Edm.String"]], returns: "Collection(mscrm.crmbaseentity)" });
  declare("AddCertificateCredential", "action", addCertificate, { params: [["thumbprint", "Edm.String"], ["entityId", "Edm.Guid"], ["entityLogicalName", "Edm.String"]] });
  declare("GetCertificateCredential", "action", getCertificates, { params: [["entityLogicalName", "Edm.String"], ["entityId", "Edm.Guid"]], returns: "Collection(mscrm.crmbaseentity)" });
  declare("RemoveCertificateCredential", "action", removeCertificate, { params: [["entityLogicalName", "Edm.String"], ["entityId", "Edm.Guid"], ["certificateCredentialId", "Edm.Guid"]] });
  declare("GetComponentManagedIdentityFIC", "function", ficSubject, { params: [["ComponentName", "Edm.String"], ["ComponentId", "Edm.Guid"]], response: [["FICSubject", "Edm.String"]] });
  declare("RetrieveProcessInstances", "function", processInstances, { params: [["EntityId", "Edm.Guid"], ["EntityLogicalName", "Edm.String"]], returns: "Collection(mscrm.crmbaseentity)" });
  declare("RetrieveActivePath", "function", activePath, { params: [["ProcessInstanceId", "Edm.Guid"]], returns: "Collection(mscrm.processstage)" });
  // SetProcess is internal-only (Learn: business-process-flows-code, "You can no longer use the SetProcess message"): in $metadata, answers 501 by default.
  registerInternalMessage(api, {
    name: "SetProcess", kind: "action", binding: "unbound", signature: { params: [["Target", "mscrm.crmbaseentity"], ["NewProcess", "mscrm.crmbaseentity"], ["NewProcessInstance", "mscrm.crmbaseentity"]] },
  });
  // These platform contracts are discoverable but have no public behavioral
  // contract. Trusted packs can supply their implementation; unknown behavior
  // remains an explicit error instead of a fabricated successful response.
  for (const [name, signature] of [
    ["_Downloademailasattachment", { params: [["emailIdToBeDownloaded", "Edm.String"], ["additionalParameter", "Edm.String"]], response: [["emailRecordData", "Edm.String"]] }],
    ["_InvokeHideReserveEntities", { response: [["output", "Edm.String"]] }],
    ["_SyncKnowledgeManagementSettings", {}],
    ["cascadeAsync_SuccessAPI", { params: [["casadeAsync_JobName", "Edm.String"]] }],
  ]) registerAddon(api, { name, kind: "action", binding: "unbound", signature, fallback: () => new DataError(`${name} has no configured local implementation.`, 501, "NotImplemented", { innerCode: "0x80040216" }) });
}

export const EXTENSION = { name: "dataverse-misc-messages", install };
