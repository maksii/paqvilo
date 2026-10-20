// Record handlers for the simulated Dataverse Web API: collections, single rows,
// properties, navigation, $ref and collection-bound actions. The Dataverse layer
// authorizes each call here before the store runs under the bypass identity.
// metadata, objectTypeCode and clock are accepted for the router contract and unused so far.
import { createHash } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { isElastic, recordKey, samePartition } from "./dataverse-elastic.mjs";
import { parseEntityReference } from "./data.mjs";
import { DATAVERSE_SYSTEM_COLUMNS, parseXmlDocument, webApiPagingCookie } from "./fetchxml-engine.mjs";
import { compileODataPredicate, expressionPaths, parseApply, parseExpand, parseODataExpression, parseOrderBy, parseSelect, splitTopLevel } from "./odata-query.mjs";
import { assertExpand, assertExpandText, childLinks } from "./dataverse-expand.mjs";
import { FORMATTED, NAVIGATION, createWebApiFormatter } from "./webapi-format.mjs";
import { baseCurrencyRow, ownershipOf, privilegeDeniedError, privilegeName } from "./dataverse-security.mjs";
import { dateTimeBehavior, fieldKind, formattedValue, isDateOnlyField } from "./dataverse-values.mjs";
import { fixedScaleNumeric } from "./exact-numeric.mjs";
import { createChangeLog, encodeDeltaToken, nextRowVersion } from "./dataverse-changes.mjs";
import { standardNavigation } from "./dataverse-standard.mjs";
import {
  JSON_CONTENT_TYPE,
  annotationMatcher,
  skipTokenQueryValue,
  contextUrl,
  decodeSkipToken,
  encodeSkipToken,
  entityUrl,
  keySyntaxError,
  parseKey,
  preferenceApplied,
} from "./dataverse-odata.mjs";

const PAGE_CAP = 5000;
// Control annotations a write may carry; other @ annotations are dropped by payload().
const CONTROL = new Set(["@odata.type", "@odata.context", "@odata.id", "@odata.etag"]);
// owningteam is left out: unverified, always null in the evidence.
const OWNER_FIELDS = ["ownerid", "owningbusinessunit"];
// System lookups every table carries (audit always, owner columns on user-owned tables), with their targets.
const SYSTEM_AUDIT = { createdby: ["systemuser"], modifiedby: ["systemuser"], createdonbehalfby: ["systemuser"], modifiedonbehalfby: ["systemuser"] };
const SYSTEM_OWNER = { ownerid: ["systemuser", "team"], owninguser: ["systemuser"], owningteam: ["team"], owningbusinessunit: ["businessunit"] };
// Columns every table carries (audit, version and state stamps) that Solution metadata may not list; a read with no $select answers them.
const TABLE_COLUMNS = [...DATAVERSE_SYSTEM_COLUMNS];
const BIND = "@odata.bind";
const ALLOWED_QUERY = new Set([
  "$select", "$filter", "$expand", "$orderby", "$top", "$count", "$apply", "$skiptoken", "$deltatoken", "$id",
  "fetchXml", "fetchxml", "savedQuery", "userQuery",
  "partitionId",
]);
const TRACKING_REJECTS = ["$filter", "$orderby", "$expand", "$top"];
const MONEY_SCALE = 4;
// The JSON type of a record read whose Accept asked for XML or text (observed: parity cases headers.accept-xml, headers.accept-text).
const JSON_STREAMING_CONTENT_TYPE = "application/json; odata.metadata=minimal; odata.streaming=true";
const CURRENCY = "_transactioncurrencyid_value";
const RECORD_COUNT = "Microsoft.Dynamics.CRM.totalrecordcount";
const RECORD_LIMIT = "Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded";
const MORE_RECORDS = "Microsoft.Dynamics.CRM.morerecords";
const PAGING_COOKIE = "Microsoft.Dynamics.CRM.fetchxmlpagingcookie";
const GLOBAL_VERSION = "Microsoft.Dynamics.CRM.globalmetadataversion";
const OVERRIDDEN = "overriddencreatedon";
// System columns Dataverse rejects on create and update (IsValidForCreate/IsValidForUpdate false): accepted and ignored,
// the system stamp wins. unverified: live capture (ignored silently; the platform's answer is not captured).
const SYSTEM_IGNORED = new Set([
  "createdby", "createdon", "modifiedby", "modifiedon", "createdonbehalfby", "modifiedonbehalfby",
  "owninguser", "owningteam", "owningbusinessunit", "versionnumber",
]);
const ignoredSystem = (key) => SYSTEM_IGNORED.has(key.endsWith(BIND) ? key.slice(0, -BIND.length) : key);
// System lookups a plain (non-bind) property may not set: Dataverse answers 0x0. Their bind forms are accepted and ignored.
const LOOKUP_SYSTEM = new Set([...Object.keys(SYSTEM_AUDIT), ...Object.keys(SYSTEM_OWNER)]);

// Records hooks (api.recordHooks.add(name, fn)). Several functions may share a name and run in the order added.
// query and stream answer with the first result that is not undefined; project, beforeWrite and afterWrite run them all.
export function createRecordHooks() {
  const byName = new Map();
  return {
    add(name, fn) {
      if (typeof fn !== "function") throw new TypeError(`Record hook ${name} must be a function.`);
      byName.set(name, [...(byName.get(name) ?? []), fn]);
    },
    list: (name) => byName.get(name) ?? [],
  };
}

// @Microsoft.Dynamics.CRM.globalmetadataversion, copied from webapi-handler (not imported). Synthetic, never a live value.
const metadataVersions = new WeakMap();
function globalMetadataVersion(store) {
  if (store.observed?.webApiGlobalMetadataVersion != null) return store.observed.webApiGlobalMetadataVersion;
  const mappings = store.state.mappings ?? {};
  if (!metadataVersions.has(mappings)) {
    const digest = createHash("sha256").update(JSON.stringify(mappings)).digest("hex");
    metadataVersions.set(mappings, String(parseInt(digest.slice(0, 8), 16)));
  }
  return metadataVersions.get(mappings);
}

const invalid = (message, innerCode = "0x80040203") => new DataError(message, 400, "InvalidRequest", { innerCode });
// A key the entity does not declare: the OData payload reader's 0x80048d19 (native batch.rollback), without its stack trace.
const unknownProperty = (key, mapping) =>
  new DataError(
    `Error identified in Payload provided by the user for Entity :'${mapping.entitySet}', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : Microsoft.Crm.CrmException: Invalid property '${key}' was found in entity 'Microsoft.Dynamics.CRM.${mapping.logicalName}'. ---> Microsoft.OData.ODataException: The property '${key}' does not exist on type 'Microsoft.Dynamics.CRM.${mapping.logicalName}'. Make sure to only use property names that are defined by the type.`,
    400,
    "InvalidRequest",
    { innerCode: "0x80048d19" },
  );
// A lookup, owner or audit value given as a plain value: the untyped-value form, 0x0 (no native case measured).
const untypedProperty = (key, logical) =>
  new DataError(
    `An error occurred while validating input parameters: Microsoft.Crm.CrmException: Invalid property '${key}' was found in entity 'Microsoft.Dynamics.CRM.${logical}'. ---> Microsoft.OData.ODataException: Does not support untyped value in non-open type.`,
    400,
    "InvalidRequest",
    { innerCode: "0x0" },
  );
const LOOKUP_VALUE = /^_[^@]+_value$/;
// Native answers an unknown or wrongly cased entity set with 404 0x80060888 (the same segment message).
const unknownSet = (set) => new DataError(`Resource not found for the segment '${set}'.`, 404, "UnknownEntity", { httpStatus: 404, innerCode: "0x80060888", route: true });
// A key whose alternate-key names the entity does not declare: the native key rule, a 400 0x80060888.
const keyNotDeclared = (mapping) =>
  new DataError(
    `The key in the request URI is not valid for resource 'Microsoft.Dynamics.CRM.${mapping.logicalName}'. Ensure that the names and number of key properties match the declared or alternate key properties for the resource 'Microsoft.Dynamics.CRM.${mapping.logicalName}'.`,
    400,
    "InvalidKey",
    { httpStatus: 400, innerCode: "0x80060888", route: true },
  );
const notFoundRecord = (logical, id, innerCode = "0x80040217") =>
  new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { id, innerCode });
const noResource = (c) => new DataError(`No HTTP resource was found that matches the request URI '${c.url.href}'.`, 404, "UnknownResource", { innerCode: "" });
const methodNotAllowed = (method) =>
  new DataError(`The requested resource does not support http method '${method}'.`, 405, "MethodNotAllowed", { innerCode: "" });
const sameId = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const withoutNulls = (row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
const etagOf = (body) => (body["@odata.etag"] ? { ETag: body["@odata.etag"] } : {});
// Preference-Applied for the Prefer options a request carried; preferenceApplied owns the wording.
const appliedHeader = (prefer, options) => {
  const applied = preferenceApplied(prefer, options);
  return applied ? { "Preference-Applied": applied } : {};
};
// A write representation drops the columns it leaves null, with their @ annotations (observed: every native PATCH 200 body).
const withoutNullColumns = (body) => {
  const nulls = new Set(Object.keys(body).filter((key) => !key.includes("@") && body[key] === null));
  return Object.fromEntries(Object.entries(body).filter(([key]) => !nulls.has(key.split("@")[0])));
};
const emptyPage = () => ({ value: [], paging: { moreRecords: false, totalCount: 0 } });

function checkQuery(url) {
  for (const name of url.searchParams.keys()) {
    if (!ALLOWED_QUERY.has(name) && !name.startsWith("@")) {
      if (name === "$search") throw new DataError('The "$search" query parameter isn\'t supported.', 501, "UnsupportedQueryFunction");
      throw new DataError(`The query parameter ${name} is not supported`, 400, "UnsupportedQuery", { innerCode: "0x80060888" });
    }
  }
}

// $skiptoken names a page; offsets are (pageNumber - 1) * pageSize into the stable result order.
// A token that is not a paging cookie at all is read as malformed XML by Dataverse (0x80040201).
function pageOffset(url, pageSize) {
  const text = url.searchParams.get("$skiptoken");
  if (text == null) return 0;
  const token = decodeSkipToken(text);
  if (!token) throw invalid("Malformed XML", "0x80040201");
  const offset = Number.isInteger(token.pageNumber) && token.pageNumber >= 2 ? (token.pageNumber - 1) * pageSize : -1;
  if (offset < 0) throw invalid("The $skiptoken is not valid.", "0x80060888");
  return offset;
}

// The delta token a tracked page's $skiptoken carries (see collectionPage); null when the token has none.
const carriedDelta = (url) => /\sdeltatoken="([^"]*)"/.exec(url.searchParams.get("$skiptoken") ?? "")?.[1] ?? null;

// The primary id always travels with $select so paging and etags have it; the context URL keeps the caller's list.
function withIdSelect(select, idColumn) {
  if (select == null || select === "*" || (parseSelect(select) ?? []).includes(idColumn)) return select;
  return `${select},${idColumn}`;
}

// Mirrors the handler's annotation stripping: @odata.* always stays, other annotations need a match.
// Expanded rows (single or collection, at any depth) follow the same rule for their own annotations.
// observed: parity cases query.expand-children, query.expand-filter: no FormattedValue or lookup annotation leaks into an expanded row without Prefer.
function keepAnnotations(value, include) {
  const nested = (item) => (item !== null && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype ? keepAnnotations(item, include) : item);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const at = key.indexOf("@");
    const term = at < 0 ? null : key.slice(at + 1);
    if (term != null && !term.startsWith("odata.") && !(include && include(term))) continue;
    out[key] = Array.isArray(item) ? item.map(nested) : nested(item);
  }
  return out;
}

// Accepts /set(key), set(key), absolute <origin>/api/data/vX/set(key) and alternate-key forms.
// urlKey: the value is a URL key ($id), which keeps the route flag; a bind or $ref body value does not (observed: relationships.bind-invalid sends REQ_ID twice).
function refOf(value, { urlKey = false } = {}) {
  const text = String(value ?? "").trim().replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?api\/data\/v\d+\.\d+\//i, "");
  const ref = parseEntityReference(text);
  if (!ref) throw invalid(`Invalid entity reference '${text}'.`, "0x80048d19");
  // A GUID-shaped key that is not a GUID is a key syntax error in a bind as it is in a URI.
  const malformed = keySyntaxError(ref.id);
  if (malformed) {
    if (urlKey) throw malformed;
    const { route, ...details } = malformed.details ?? {};
    throw new DataError(malformed.message, malformed.status, malformed.code, details);
  }
  return ref;
}

// The caller's query without paging tokens, followed by one token parameter.
// observed: parity case query.paging-first: a nextLink encodes each value like encodeURIComponent ( ) ' stay literal, , and : are escaped;
// a deltaLink keeps the caller's $select raw (query.track-changes).
function linkOf(c, base, name, token, { raw = false } = {}) {
  const query = new URLSearchParams(c.url.searchParams);
  query.delete("$skiptoken");
  query.delete("$deltatoken");
  const text = [...query].map(([key, value]) => `${key}=${(raw ? value : encodeURIComponent(value)).replace(/%24/g, "$")}`).join("&");
  return `${base}?${text ? `${text}&` : ""}${name}=${token}`;
}
// The token is passed to skipTokenQueryValue after one decode: its inner pagingcookie stays percent-encoded.
const nextLinkOf = (c, base, token) => linkOf(c, base, "$skiptoken", skipTokenQueryValue(decodeURIComponent(token)));
const deltaLinkOf = (c, base, token) => linkOf(c, base, "$deltatoken", encodeDeltaToken(token), { raw: true });

function withKeyViolation(mapping, data, fn) {
  try {
    return fn();
  } catch (error) {
    if (error?.code !== "DuplicateRecord" || !String(error.message).startsWith("A record that has the attribute values")) throw error;
    const attributesOf = (key) => key.attributes ?? key.keyAttributes ?? [];
    const keys = mapping.alternateKeys ?? [];
    const key = keys.find((item) => attributesOf(item).every((name) => name in data)) ?? keys[0];
    if (!key) throw error;
    const columns = attributesOf(key);
    const keyName = key.name ?? columns.join("_");
    throw new DataError(
      `Entity Key ${keyName} violated. A record with the same value for ${columns.join(", ")} already exists. A duplicate record cannot be created. Select one or more unique values and try again.`,
      412,
      "DuplicateRecord",
      { innerCode: "0x80060892", keyName, columns },
    );
  }
}

// changeTrackingEnabled(logical) overrides the table's metadata flag; without it the flag is read from the mapping,
// and an undefined flag keeps tracking allowed.
// fieldSecurity is a getter for api.fieldSecurity (dataverse-fls): the extension installs after the handlers exist. Absent or
// undefined, no column is hidden.
export function createRecordHandlers({ store, change, principals, metadataFields = () => undefined, clock = () => Date.now(), changes = createChangeLog(store, { clock }), changeTrackingEnabled, hooks = createRecordHooks(), fieldSecurity }) {
  const authorize = (c, entity, operation, mapping, row) => principals.authorize({ user: c.user, entity, operation, row, mapping });
  const hookList = (name) => hooks.list?.(name) ?? [];
  const runHooks = (name, ...args) => { for (const hook of hookList(name)) hook(...args); };
  // Write hooks are awaited inside the write's store transaction (every write path runs them in runWrite), so their
  // state changes commit or roll back with the write; a throw rolls the write back.
  const runWriteHooks = async (name, ...args) => { for (const hook of hookList(name)) await hook(...args); };
  const beforeWrite = (c, mapping, info) => runWriteHooks("beforeWrite", c, mapping, info);
  const afterWrite = (c, mapping, info) => runWriteHooks("afterWrite", c, mapping, info);
  // Async-capable first answer: the first hook whose result is not undefined wins.
  const firstAnswer = async (name, ...args) => {
    for (const hook of hookList(name)) {
      const answer = await hook(...args);
      if (answer !== undefined) return answer;
    }
    return undefined;
  };
  const trackingFlag = (logical, mapping) =>
    changeTrackingEnabled ? changeTrackingEnabled(logical) : (mapping.changeTrackingEnabled ?? mapping.dataverseMetadata?.ChangeTrackingEnabled);
  const addMetadataVersion = (c, body) => {
    if (c.include?.(GLOBAL_VERSION)) body[`@${GLOBAL_VERSION}`] = globalMetadataVersion(store);
    return body;
  };
  // savedQuery and userQuery are answered only by a query hook; without an answer Dataverse's 501 stands.
  const assertPredefinedAnswered = (url) => {
    for (const name of ["savedQuery", "userQuery"]) {
      if (url.searchParams.has(name)) throw new DataError(`${name} has not yet been implemented.`, 501, "NotImplemented", { innerCode: "0x80040216" });
    }
  };
  const filterOf = (c, mapping) => principals.readFilter({ user: c.user, entity: mapping.logicalName, mapping }) ?? null;
  // Row filter for every table a query reads: root, $expand, navigation $filter/$orderby and link-entity. Those tables are
  // read-authorized up front (assertQueryMembers, fetchXmlPage), so an empty table still answers 403; this trims rows.
  const rowsFilterOf = (c) => {
    const filters = new Map();
    return (name, row) => {
      if (!filters.has(name)) filters.set(name, principals.readFilter({ user: c.user, entity: name }) ?? (() => true));
      return filters.get(name)(row);
    };
  };
  const secured = (c, extra = {}) => queryOptions({ ...extra, backendRowsFilter: rowsFilterOf(c) });
  // Field metadata as this layer reads it: the system lookups are always declared, so a null lookup serializes as _x_value.
  const systemFields = (logical) => {
    let m;
    try { m = store.resolveMapping(logical); } catch { return {}; }
    const names = ownershipOf(m.logicalName, undefined, m) === "user" ? { ...SYSTEM_AUDIT, ...SYSTEM_OWNER } : SYSTEM_AUDIT;
    return Object.fromEntries(Object.entries(names).map(([n, targets]) => [n, { dataverseType: n === "ownerid" ? "owner" : "lookup", targets }]));
  };
  const fieldsOf = (logical) => ({ ...systemFields(logical), ...(metadataFields(logical) ?? {}) });
  const queryOptions = (extra = {}) => ({ dialect: "dataverse", metadata: fieldsOf, includeKeys: true, ...extra });
  // dataverseWebApi: the Dataverse Web API's stricter value rules (lib/data.mjs coerceValue); the portal /_api never sets it.
  const writeOptions = (extra = {}) => ({ coerce: true, metadata: fieldsOf, dataverseWebApi: true, ...extra });
  const runWrite = (fn) => change(() => store.transact(fn, { incremental: true }));
  const contextFor = (c, suffix) => contextUrl(c.origin, c.version, suffix);
  // The context lists the $select columns (a repeated one once) then each expanded navigation with its own columns and nested expansions.
  // observed: parity cases query.select-duplicate, query.expand-children, query.expand-filter, relationships.parent.
  const navContext = (item) => {
    const columns = [...(item.select ? parseSelect(item.select) ?? [] : []), ...(item.expand ?? []).map(navContext)];
    return `${item.navigation}(${[...new Set(columns)].join(",")})`;
  };
  const suffixFor = (c, mapping) => {
    const text = c.url.searchParams.get("$select");
    if (text?.trim() === "*") return `${mapping.entitySet}(*)`;
    const parts = [...(parseSelect(text) ?? []), ...parseExpand(c.url.searchParams.get("$expand")).map(navContext)];
    const unique = [...new Set(parts)];
    return `${mapping.entitySet}${unique.length ? `(${unique.join(",")})` : ""}`;
  };
  const bodyOf = (set, body) => {
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
    throw invalid(`Error identified in Payload provided by the user for Entity :'${set}'  ---->  InnerException : A request body is required.`, "0x80048d19");
  };
  // The organization's base currency seeded by the security model, found by the organization row's id; null when the Dataverse tables are absent.
  const baseCurrency = () => baseCurrencyRow(store, store.state.tables.organization?.[0]?.organizationid);
  const isMoney = (mapping, key) => fieldKind(store.fieldDefinition(mapping.logicalName, key, fieldsOf)) === "money";
  // No $select (or $select=*) answers every column, the currency lookup included; a $select list answers it only when named.
  const currencySelected = (c) => {
    const select = parseSelect(c.url.searchParams.get("$select"));
    return select == null || select.includes(CURRENCY);
  };
  // A single row whose $select names a money column answers the base currency lookup too (see formatRow).
  const moneyNamed = (c, mapping) => (parseSelect(c.url.searchParams.get("$select")) ?? []).some((name) => isMoney(mapping, name));
  // Whether the stored row holds a base currency (transactioncurrencyid, set by currencyOnWrite). Ids of the table's holders are
  // read once per request (c.currencyHolders), so a row's lookup follows what was stored rather than what it projects.
  const keyOfId = (id) => String(id ?? "").replace(/[{}]/g, "").toLowerCase();
  function currencyHeld(c, mapping, id) {
    const holders = (c.currencyHolders ??= new Map());
    if (!holders.has(mapping.logicalName)) {
      const rows = store.state.tables[mapping.logicalName] ?? [];
      holders.set(mapping.logicalName, new Set(rows.filter((row) => row.transactioncurrencyid != null).map((row) => keyOfId(row[mapping.idColumn]))));
    }
    return holders.get(mapping.logicalName).has(keyOfId(id));
  }
  // A write that gives a money column a non-null value stores the base currency on the row, once the organization has one.
  // A row never given a money value has no currency lookup; setting a money value supplies one.
  function currencyOnWrite(mapping, row) {
    const given = Object.keys(row ?? {}).some((key) => !key.includes("@") && row[key] != null && isMoney(mapping, key));
    const base = given ? baseCurrency() : null;
    return base ? { transactioncurrencyid: base.transactioncurrencyid } : {};
  }

  // Money columns serialize with four-decimal lexemes, and a row that carries one reports the base currency lookup,
  // but only when the caller's $select asks for it (or selects everything): Dataverse omits the lookup otherwise.
  function shapeMoney(mapping, out, { currencyWanted = true, named = false } = {}) {
    // named: the money column was selected on a single row, so it counts even when its value is null (observed: key GET with money select).
    let money = named;
    for (const key of Object.keys(out)) {
      if (key.includes("@") || !isMoney(mapping, key)) continue;
      money = true;
      if (out[key] == null) continue;
      out[key] = fixedScaleNumeric(out[key], MONEY_SCALE);
      // Negative money values format as a parenthesized symbol and amount.
      const text = out[`${key}${FORMATTED}`];
      if (typeof text === "string" && out[key]?.value?.startsWith?.("-")) out[`${key}${FORMATTED}`] = text.replace(/^([^\d-]*)-(.*)$/, "($1$2)");
    }
    const currency = money && currencyWanted ? baseCurrency() : null;
    if (!currency) return out;
    // A stored currency lookup (currencyOnWrite) can already be in out, from the formatter, without its annotations: they still come.
    out[CURRENCY] ??= currency.transactioncurrencyid;
    out[`${CURRENCY}${FORMATTED}`] ??= currency.currencyname;
    out[`${CURRENCY}@Microsoft.Dynamics.CRM.associatednavigationproperty`] ??= "transactioncurrencyid";
    out[`${CURRENCY}@Microsoft.Dynamics.CRM.lookuplogicalname`] ??= "transactioncurrency";
    return out;
  }

  // Entity set names are case-sensitive; logical names do not route (Dataverse 404 0x8006088a).
  function mappingForSet(set) {
    const owner = Object.keys(store.state.mappings).find((name) => store.state.mappings[name]?.entitySet === set);
    if (owner) return store.resolveMapping(owner);
    const virtual = store.virtualTable(set)?.mapping;
    if (virtual?.entitySet === set) return virtual;
    throw unknownSet(set);
  }

  // A standard table's navigations come from the standard file where the mapping does not name them (read time only).
  const navigationOf = (mapping, segment) => mapping.relationships?.[segment] ?? standardNavigation(store, mapping.logicalName, segment);
  // The facts assertExpand reads: many-valued unless many is false, the N:N intersect and the target mapping.
  const relationshipOf = (mapping, navigation) => {
    const rel = navigationOf(mapping, navigation);
    return rel ? { many: rel.many !== false, intersect: rel.intersect, target: store.resolveMapping(rel.entity) } : null;
  };
  const isMember = (mapping, name) =>
    name === mapping.idColumn || Boolean(navigationOf(mapping, name)) || Boolean(store.fieldDefinition(mapping.logicalName, name, fieldsOf));
  const undeclared = (set, nav) =>
    invalid(
      `Error identified in Payload provided by the user for Entity :'${set}'  ---->  InnerException : Microsoft.OData.ODataException: An undeclared property '${nav}' which only has property annotations in the payload but no property value was found in the payload. In OData, only declared navigation properties and declared named streams can be represented as properties without values`,
      "0x80048d19",
    );
  // Every key of a write must be a property, the id, a navigation or a nav@odata.bind on one. An undeclared name is 0x80048d19;
  // a lookup or audit value given plainly is the untyped form (0x0).
  function assertPayload(mapping, body) {
    for (const key of Object.keys(body)) {
      if (CONTROL.has(key) || (key.includes("@") && !key.endsWith(BIND))) continue;
      if (key.endsWith(BIND)) {
        const nav = key.slice(0, -BIND.length);
        if (!isMember(mapping, nav)) throw undeclared(mapping.entitySet, nav);
        continue;
      }
      // A plain lookup, owner or customer value is untyped: lookups are set through @odata.bind (a navigation object is a deep insert).
      const lookup = fieldKind(store.fieldDefinition(mapping.logicalName, key, fieldsOf)) === "lookup";
      const deepInsert = navigationOf(mapping, key) && body[key] && typeof body[key] === "object";
      if (LOOKUP_SYSTEM.has(key) || LOOKUP_VALUE.test(key) || (lookup && !deepInsert)) throw untypedProperty(key, mapping.logicalName);
      if (!isMember(mapping, key)) throw unknownProperty(key, mapping);
    }
  }

  // The table a navigation leads to, read-authorized up front: a table with no rows still answers 403 when the caller cannot read it.
  const readableTarget = (c, mapping, navigation) => {
    const target = store.resolveMapping(navigationOf(mapping, navigation).entity);
    authorize(c, target.logicalName, "read", target);
    return target;
  };
  // Every $expand target, nested ones included, is read-authorized before any row is read.
  function assertExpandReadable(c, mapping, items) {
    for (const item of items) {
      if (navigationOf(mapping, item.navigation)) assertExpandReadable(c, readableTarget(c, mapping, item.navigation), item.expand ?? []);
    }
  }
  // $filter, $orderby and $expand roots must name a property (or a navigation); unknown ones are 0x0. $expand is then
  // validated by assertExpand and its tables authorized. Navigation $filter and $orderby tables are authorized too.
  function assertQueryMembers(c, mapping, params) {
    const aliases = Object.fromEntries([...params].filter(([name]) => name.startsWith("@")));
    const filter = params.get("$filter");
    if (filter) {
      const expression = parseODataExpression(filter, {
        dialect: "dataverse", aliases, rejectNotOnQueryFunctions: true,
        strictEdm: true, columnDefinition: (name) => store.fieldDefinition(mapping.logicalName, name, fieldsOf),
      });
      for (const [head] of expressionPaths(expression)) {
        if (!head || head.startsWith("@")) continue;
        if (navigationOf(mapping, head)) readableTarget(c, mapping, head);
        else assertProperty(mapping, head);
      }
    }
    for (const spec of parseOrderBy(params.get("$orderby"))) {
      const head = spec.path[0];
      if (navigationOf(mapping, head)) readableTarget(c, mapping, head);
      else assertProperty(mapping, head);
    }
    assertExpandText(params.get("$expand"));
    const items = parseExpand(params.get("$expand"));
    for (const item of items) {
      if (!navigationOf(mapping, item.navigation)) assertProperty(mapping, item.navigation);
    }
    assertExpand(items, mapping, relationshipOf);
    assertExpandReadable(c, mapping, items);
  }

  // Formats one row, adds the owner navigation annotation the formatter leaves out and shapes money columns.
  function formatRow(c, mapping, row, options) {
    const formatted = c.formatter.formatEntity(row, mapping, options);
    // The stored base currency (currencyOnWrite) answers as the _transactioncurrencyid_value lookup, never as a raw column (the currency table's own key excepted).
    if (mapping.idColumn !== "transactioncurrencyid") delete formatted.transactioncurrencyid;
    // A selected currency lookup the row does not carry projects as null; shapeMoney supplies the base currency instead.
    if (formatted[CURRENCY] === null) delete formatted[CURRENCY];
    for (const field of OWNER_FIELDS) {
      const key = `_${field}_value`;
      if (formatted[key] != null && formatted[`${key}${NAVIGATION}`] === undefined) formatted[`${key}${NAVIGATION}`] = field;
    }
    // The user-owner lookup carries its logical name only, no FormattedValue or navigation (observed: owner annotation sets).
    delete formatted[`_owninguser_value${FORMATTED}`];
    delete formatted[`_owninguser_value${NAVIGATION}`];
    // Organization-owned rows always answer the organization lookup, selected or not (observed: seed.child, relationships.parent).
    const organizationId = store.state.tables.organization?.[0]?.organizationid;
    const selected = parseSelect(c.url.searchParams.get("$select"));
    if (organizationId && (!c.navigation || selected == null || selected.includes("_organizationid_value")) && formatted._organizationid_value === undefined && ownershipOf(mapping.logicalName, undefined, mapping) === "org") {
      formatted._organizationid_value = organizationId;
    }
    // A picklist value with no option still answers its FormattedValue, as null (observed: a picklist value of -1).
    for (const key of Object.keys(formatted)) {
      if (key.includes("@") || formatted[key] == null) continue;
      if (fieldKind(store.fieldDefinition(mapping.logicalName, key, fieldsOf)) === "choice" && formatted[`${key}${FORMATTED}`] === undefined) {
        formatted[`${key}${FORMATTED}`] = null;
      }
    }
    const named = options?.single === true && moneyNamed(c, mapping);
    // The base currency lookup is answered only for a row that holds one (currencyOnWrite). A selected lookup the row does not hold is null.
    const held = currencyHeld(c, mapping, row[mapping.idColumn]);
    shapeMoney(mapping, formatted, { currencyWanted: held && (currencySelected(c) || named), named });
    if (!held && formatted[CURRENCY] === undefined && currencySelected(c) && Object.keys(formatted).some((key) => !key.includes("@") && isMoney(mapping, key))) formatted[CURRENCY] = null;
    if (options?.allColumns) fillColumns(c, mapping, formatted);
    if (options?.expand?.length) pageExpansions(c, mapping, row, formatted, options.expand, { collection: options.single !== true });
    projectRow(c, mapping, formatted, options?.expand);
    return formatted;
  }

  // A read with no $select list (or $select=*) answers every column of the table, unset ones as null (lookups as _x_value).
  // Columns come from the table's metadata and system fields; a $select list is projected by the store and left alone.
  function fillColumns(c, mapping, formatted) {
    if (parseSelect(c.url.searchParams.get("$select")) != null) return;
    const { names, moneys, dateColumns } = columnNamesOf(mapping);
    // A row that carries the base currency (shapeMoney) has exchange rate 1: the base currency's own rate is 1, so a money value is its base amount.
    if (formatted[CURRENCY] != null) {
      formatted.exchangerate = 1;
      // observed: parity case headers.prefer-malformed: the rate's FormattedValue is 1 at its 12-place scale; a base companion formats like its money column.
      formatted[`exchangerate${FORMATTED}`] = "1.000000000000";
      for (const name of moneys) {
        if (formatted[name] == null) continue;
        formatted[`${name}_base`] = formatted[name];
        if (formatted[`${name}${FORMATTED}`] !== undefined) formatted[`${name}_base${FORMATTED}`] = formatted[`${name}${FORMATTED}`];
      }
    }
    stampSystemValues(mapping, formatted, dateColumns);
    for (const name of names) if (!(name in formatted)) formatted[name] = null;
  }

  // Every column name a read of the table answers (system columns, lookups as _x_value, money companions, file parts), with money and date columns that imply a time-zone rule stamp.
  function columnNamesOf(mapping) {
    const names = [mapping.idColumn, ...TABLE_COLUMNS];
    const moneys = [];
    const dateColumns = [];
    for (const [name, definition] of Object.entries(store.fieldDefinitions(mapping.logicalName, fieldsOf))) {
      const kind = fieldKind(definition);
      if (kind === "virtual" || kind === "partylist") continue;
      if (kind === "datetime" && ((dateTimeBehavior(definition) || "userlocal") === "userlocal" || isDateOnlyField(definition))) dateColumns.push(name);
      if (kind === "lookup") names.push(`_${name}_value`);
      else names.push(name);
      // A money column has a base-currency companion; the companion is money-typed and has no companion of its own.
      if (kind === "money" && !name.endsWith("_base")) {
        moneys.push(name);
        names.push(`${name}_base`);
      }
      if (kind === "file") {
        const image = String(definition.dataverseType ?? definition.type ?? "").toLowerCase() === "image";
        names.push(...(image ? [`${name}id`, `${name}_url`, `${name}_timestamp`] : [`${name}_name`]));
      }
    }
    if (moneys.length) names.push(CURRENCY, "exchangerate");
    return { names: isElastic(mapping) ? names.filter((name) => name !== "statecode" && name !== "statuscode") : names, moneys, dateColumns };
  }

  // Native rows always carry their state, version and time-zone stamps, stored or not. statecode and statuscode come from
  // the mapping's defaults on tables with a state or status column; versionnumber is the number of the row's ETag, so
  // W/"n" and versionnumber agree. A non-null UserLocal or DateOnly value implies timezoneruleversionnumber 4,
  // including a DateOnly-only row and a row whose UserLocal value was cleared while its DateOnly value remains.
  function stampSystemValues(mapping, formatted, dateColumns) {
    if (hasStateColumns(mapping)) {
      if (formatted.statecode == null) formatted.statecode = mapping.recordDefaults?.statecode ?? 0;
      const status = mapping.stateStatusDefaults?.[formatted.statecode] ?? mapping.recordDefaults?.statuscode ?? (Number(formatted.statecode) === 0 ? 1 : undefined);
      if (formatted.statuscode == null && status !== undefined) formatted.statuscode = status;
    }
    const etagNumber = /^W\/"(\d+)"$/.exec(formatted["@odata.etag"] ?? "");
    if (formatted.versionnumber == null && etagNumber) formatted.versionnumber = Number(etagNumber[1]);
    if (formatted.timezoneruleversionnumber == null && dateColumns.some((name) => formatted[name] != null)) formatted.timezoneruleversionnumber = 4;
    if (typeof formatted.timezoneruleversionnumber === "number")
      formatted[`timezoneruleversionnumber${FORMATTED}`] ??= formattedValue(formatted.timezoneruleversionnumber, { dataverseType: "int" }, store.state.settings);
  }

  // An expanded collection holds at most PAGE_CAP rows; its nav@odata.nextLink pages on through the navigation (nested paging).
  // observed: parity cases query.expand-children, query.expand-filter, relationships.parent. A collection query links every expanded
  // collection (short or empty too); a child row carries its parent's lookup; a child with no $select carries every column; a
  // single-valued expansion carries its etag.
  function pageExpansions(c, mapping, row, formatted, expand, { collection = true } = {}) {
    for (const item of expand) {
      const rel = navigationOf(mapping, item.navigation);
      const value = formatted[item.navigation];
      if (!rel || value == null) continue;
      if (!Array.isArray(value)) {
        const target = store.resolveMapping(rel.entity);
        const stored = value[target.idColumn] == null ? null : rowOf(c, target, value[target.idColumn]);
        if (stored) value["@odata.etag"] = store.etag(stored);
        continue;
      }
      if (rel.many !== false) for (const child of value) shapeChild(c, mapping, row, rel, child, item);
      if (value.length <= PAGE_CAP) {
        if (collection) {
          const link = childLinks(c.origin, c.version, mapping.entitySet, row[mapping.idColumn], item.navigation, item);
          formatted[link.key] = link.url;
        }
        continue;
      }
      const { target, rows } = relatedRows(c, mapping, row, rel);
      const kept = rows.slice(0, PAGE_CAP);
      const token = {
        pageNumber: 2, firstId: kept[0][target.idColumn], lastId: kept.at(-1)[target.idColumn], idColumn: target.idColumn, countOfRecords: rows.length,
      };
      value.length = PAGE_CAP;
      const link = childLinks(c.origin, c.version, mapping.entitySet, row[mapping.idColumn], item.navigation, item, { nested: true, token });
      formatted[link.key] = link.url;
    }
  }

  // One expanded child of a collection: its referencing lookup, and every column when the expansion selects none.
  function shapeChild(c, mapping, row, rel, child, item) {
    if (rel.to && rel.from && child[`_${rel.to}_value`] === undefined) child[`_${rel.to}_value`] = row[rel.from] ?? null;
    if (item.select) return;
    const target = store.resolveMapping(rel.entity);
    for (const name of columnNamesOf(target).names) if (!(name in child)) child[name] = null;
    const organizationId = store.state.tables.organization?.[0]?.organizationid;
    if (organizationId && child._organizationid_value === undefined && ownershipOf(target.logicalName, undefined, target) === "org") child._organizationid_value = organizationId;
  }

  // project hooks see the row, then each expanded row under it (in its own table, with its own nested expansions).
  function projectRow(c, mapping, formatted, expand = []) {
    runHooks("project", c, mapping, formatted);
    for (const spec of expand) {
      const rel = navigationOf(mapping, spec.navigation);
      const value = formatted[spec.navigation];
      if (!rel || value == null || typeof value !== "object") continue;
      const target = store.resolveMapping(rel.entity);
      for (const item of [].concat(value)) if (item && typeof item === "object") projectRow(c, target, item, spec.expand ?? []);
    }
  }

  function rowOf(c, mapping, id, partitionId = null) {
    return String(id).includes("=") ? (store.findByKey(mapping, id) ?? null) : (store.get(mapping.logicalName, id, c.identity, { partitionId }) ?? null);
  }

  // Resolves the addressed row by primary key or alternate key; row is null when absent.
  function lookupKey(c, mapping, text) {
    const parsed = parseKey(text);
    if (!parsed) throw keySyntaxError(text) ?? invalid("Invalid argument.");
    if (parsed.id) return { id: parsed.id, text: parsed.id, row: rowOf(c, mapping, parsed.id, isElastic(mapping) ? c.partitionId : null), alternate: null };
    let row;
    try {
      row = store.findByKey(mapping, text) ?? null;
    } catch (error) {
      // The store refuses an alternate-key name the entity does not declare; native words that as the key rule (400 0x80060888).
      if (error?.code === "InvalidKey" && error.details?.innerCode === "0x80040203") throw keyNotDeclared(mapping);
      throw error;
    }
    return { id: row ? row[mapping.idColumn] : null, text, row, alternate: parsed.alternate };
  }

  function parentRow(c, mapping, operation) {
    const key = lookupKey(c, mapping, c.route.key);
    if (!key.row) throw notFoundRecord(mapping.logicalName, key.text);
    authorize(c, mapping.logicalName, operation, mapping, key.row);
    return key;
  }

  // Option values Dataverse refuses before it reads a collection: a bad maxpagesize (405), a repeated or non-positive $top,
  // a $count other than true or false, and an empty $filter.
  function assertCollectionOptions(c) {
    const { url, prefer } = c;
    if (prefer.maxPageSizeInvalid) {
      throw new DataError("Prefer Odata.maxpagesize value should be 32 bit integer.", 405, "InvalidRequest", { innerCode: "0x80060888", httpStatus: 405, route: true });
    }
    if (url.searchParams.getAll("$top").length > 1) {
      throw new DataError("Query option '$top' was specified more than once, but it must be specified at most once.", 400, "InvalidRequest", { innerCode: "0x80060888", route: true });
    }
    const top = url.searchParams.get("$top");
    if (top != null && !(/^\d+$/.test(top) && Number(top) > 0)) throw invalid("Invalid value for $top query option.", "0x80060888");
    const count = url.searchParams.get("$count");
    if (count != null && count !== "true" && count !== "false") throw invalid(`'${count}' is not a valid count option.`, "0x80060888");
    const filter = url.searchParams.get("$filter");
    if (filter != null && filter.trim() === "") throw invalid("The value for OData query '$filter' cannot be empty.", "0x80060888");
  }

  // Query options for collections: $top yields to maxpagesize, $skiptoken is handled here, the id always rides along.
  function collectionParams(c, mapping) {
    const params = new URLSearchParams(c.url.searchParams);
    params.delete("$skiptoken");
    params.delete("$deltatoken");
    if (c.prefer.maxPageSize != null) params.delete("$top");
    assertSelect(mapping, params.get("$select"));
    assertQueryMembers(c, mapping, params);
    const select = withIdSelect(params.get("$select"), mapping.idColumn);
    if (select != null) params.set("$select", select);
    return params;
  }

  // Dataverse answers 400 0x80060888 for an unknown $select column; the store would project an empty row instead.
  // $select=* names every column and is checked as such.
  function assertSelect(mapping, text) {
    if (!text) return;
    for (const name of text.split(",").map((part) => part.trim()).filter((part) => part && part !== "*")) assertProperty(mapping, name);
  }

  // Single rows only project $select and $expand (and aliases); filters never apply to a key read.
  function entityParams(c, mapping) {
    const params = new URLSearchParams();
    for (const [name, value] of c.url.searchParams) {
      if (name === "$expand" || name === "$select" || name.startsWith("@")) params.append(name, value);
    }
    assertSelect(mapping, params.get("$select"));
    assertQueryMembers(c, mapping, params);
    const select = withIdSelect(params.get("$select"), mapping.idColumn);
    if (select != null) params.set("$select", select);
    return params;
  }

  // allColumns: a read with no $select answers every column, and so does a write representation (unset ones as null); a $select list is projected as given.
  function entityBody(c, mapping, id, params, { allColumns = false } = {}) {
    const result = store.query(mapping.logicalName, params, c.identity, undefined, secured(c, { id, ...(isElastic(mapping) ? { partitionId: c.partitionId ?? null } : {}) }));
    const projected = result.value[0];
    if (!projected) throw notFoundRecord(mapping.logicalName, id);
    const formatted = formatRow(c, mapping, projected, { etag: true, expand: parseExpand(params.get("$expand")), allColumns, single: true });
    return { "@odata.context": contextFor(c, `${suffixFor(c, mapping)}/$entity`), ...keepAnnotations(formatted, c.include) };
  }

  const collectionBase = (c, mapping) => `${c.origin}/api/data/${c.version}/${mapping.entitySet}`;
  const tracking = (c) => c.prefer.trackChanges || c.url.searchParams.has("$deltatoken");

  // Change tracking refuses the query options Dataverse refuses; the message is the documented one.
  function assertTrackable(c) {
    for (const name of TRACKING_REJECTS) {
      if (c.url.searchParams.has(name)) throw invalid(`The "${name}" query parameter isn't supported when Change Tracking is enabled.`, "0x80060888");
    }
  }

  // The changes after a $deltatoken's revision; the token is parsed by the change log and never inspected here.
  async function deltaChanges(c, mapping) {
    const token = changes.parse(c.url.searchParams.get("$deltatoken"));
    if (!token) throw invalid("The $deltatoken is not valid.", "0x80060888");
    return changes.since(mapping.logicalName, token.revision);
  }

  // Delta read: rows changed after the token's revision, then one $deletedEntity entry per deleted row, and a fresh delta link.
  async function deltaPage(c, mapping) {
    // Minted before the read: a commit that lands during it shows up in the next delta, not lost between the two.
    const next = changes.token();
    const { changed, deleted } = await deltaChanges(c, mapping);
    const params = collectionParams(c, mapping);
    const options = secured(c, { ids: changed });
    const rows = changed.length ? store.query(mapping.logicalName, params, c.identity, undefined, options).value : [];
    const body = addMetadataVersion(c, { "@odata.context": contextFor(c, `${suffixFor(c, mapping)}/$delta`) });
    body.value = [
      ...rows.map((row) => keepAnnotations(formatRow(c, mapping, row, { etag: true, expand: [] }), c.include)),
      ...deleted.map((id) => ({ "@odata.context": contextFor(c, `${mapping.entitySet}/$deletedEntity`), id, reason: "deleted" })),
    ];
    body["@odata.deltaLink"] = deltaLinkOf(c, collectionBase(c, mapping), next);
    // A delta is one page, so maxpagesize is not applied and not echoed.
    const applied = preferenceApplied(c.prefer, { tracked: true });
    return { status: 200, headers: applied ? { "Preference-Applied": applied } : {}, body };
  }

  // Column-level security (api.fieldSecurity). unverified: live capture. The platform docs do not say how a $filter or $orderby
  // on a secured column behaves, so here such a column reads as null for the caller: a $filter runs over the masked rows and
  // a $orderby drops its hidden items (equal nulls tie, so the rest of the sort decides).
  const security = () => fieldSecurity?.();
  const hiddenColumn = (c, logical, name) => {
    const fs = security();
    return Boolean(fs) && !fs.canRead(c.user, logical, String(name ?? "").replace(/^_(.+)_value$/, "$1"));
  };
  const hiddenIn = (c, logical, ast) => expressionPaths(ast).some(([name, ...rest]) => rest.length === 0 && hiddenColumn(c, logical, name));
  const aliasesOf = (params) => Object.fromEntries([...params].filter(([name]) => name.startsWith("@")));
  // Ids both narrowings keep; null is no narrowing.
  const intersectIds = (a, b) => {
    if (a == null || b == null) return a ?? b;
    const keep = new Set(b.map((id) => String(id).toLowerCase()));
    return a.filter((id) => keep.has(String(id).toLowerCase()));
  };
  // The ids whose masked row satisfies the filter: the store's own predicate, run over each row with its hidden columns nulled.
  function maskedIds(c, mapping, ast) {
    const logical = mapping.logicalName;
    const ctx = store.queryContext(c.identity, { metadata: fieldsOf, backendRowsFilter: rowsFilterOf(c), dialect: "dataverse" });
    const predicate = compileODataPredicate(ast, mapping, ctx);
    return store.query(logical, new URLSearchParams(), c.identity, undefined, secured(c)).value
      .filter((row) => predicate(security().mask(c.user, logical, row)))
      .map((row) => row[mapping.idColumn]);
  }
  // Drops the hidden items of a $orderby from out; the rest of the sort stands.
  function dropHiddenOrder(c, logical, params, out) {
    const orderby = params.get("$orderby");
    if (!orderby) return;
    const kept = splitTopLevel(orderby).filter((item) => !hiddenColumn(c, logical, item.trim().split(/\s+/)[0]));
    if (kept.length) out.set("$orderby", kept.join(",")); else out.delete("$orderby");
  }
  // A collection's $filter and $orderby narrowed for hidden columns: the params to run, and the ids the rows must be in (null: no narrowing).
  function securedQuery(c, mapping, params) {
    const out = new URLSearchParams(params);
    let ids = null;
    if (!security()) return { params: out, ids };
    const filter = params.get("$filter");
    if (filter) {
      const ast = parseODataExpression(filter, { dialect: "dataverse", aliases: aliasesOf(params), rejectNotOnQueryFunctions: true });
      if (hiddenIn(c, mapping.logicalName, ast)) {
        out.delete("$filter");
        ids = maskedIds(c, mapping, ast);
      }
    }
    dropHiddenOrder(c, mapping.logicalName, params, out);
    return { params: out, ids };
  }
  // $apply: a filter step on a hidden column leaves the pipeline and its masked matches narrow the rows instead. Aggregates and
  // groupings over a secured column the caller cannot read are refused (assertAggregate).
  function applyNarrowed(c, mapping, params) {
    const logical = mapping.logicalName;
    const out = new URLSearchParams(params);
    let ids = null;
    if (!security()) return { params: out, ids };
    const steps = parseApply(params.get("$apply"), { dialect: "dataverse", aliases: aliasesOf(params) });
    const reads = steps.flatMap((step) => [...(step.properties ?? []), ...(step.aggregates ?? []).map((item) => item.path)]);
    security().assertAggregate(c, mapping, reads.filter((path) => path?.length === 1).map(([name]) => name));
    const parts = splitTopLevel(params.get("$apply").trim(), "/");
    const kept = [];
    steps.forEach((step, index) => {
      if (step.kind === "filter" && hiddenIn(c, logical, step.ast)) ids = intersectIds(ids, maskedIds(c, mapping, step.ast));
      else kept.push(parts[index]);
    });
    if (ids != null) {
      if (kept.length) out.set("$apply", kept.join("/"));
      else out.delete("$apply");
    }
    dropHiddenOrder(c, logical, params, out);
    return { params: out, ids };
  }
  // The entity and link-entity elements of a FetchXML document, each with the attribute names it reads.
  function fetchFrames(xml) {
    const frames = [], open = [];
    for (const [, closing, tag, attrs, empty] of xml.matchAll(/<(\/?)(entity|link-entity|attribute)\b([^<>]*?)(\/?)>/gi)) {
      if (closing) {
        if (!/^attribute$/i.test(tag)) open.pop();
        continue;
      }
      const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      if (/^attribute$/i.test(tag)) {
        if (name) open.at(-1)?.attributes.push(name);
        continue;
      }
      const frame = { entity: name, attributes: [] };
      frames.push(frame);
      if (!empty) open.push(frame);
    }
    return frames.filter((frame) => frame.entity);
  }
  // Formatted FetchXML row: hidden secured columns are nulled on the root and on each link-entity under its alias prefix.
  // An attribute given its own alias keeps that key, which the prefix does not reach, so it is nulled by key.
  function maskFetched(c, mapping, row, info) {
    const fs = security();
    if (!fs) return row;
    let out = fs.mask(c.user, mapping.logicalName, row);
    for (const [alias, logical] of Object.entries(info.aliases ?? {})) out = fs.mask(c.user, logical, out, { prefix: `${alias}.` });
    for (const column of info.columns ?? []) {
      if (!column.aliased || fs.canRead(c.user, column.entity, column.attribute)) continue;
      out[column.key] = null;
      for (const key of Object.keys(out)) if (key.startsWith(`${column.key}@`)) delete out[key];
    }
    return out;
  }

  // The paging cookie carries the values of a single $orderby column (first and last row), as encodeSkipToken writes them.
  function orderColumnOf(url, rows) {
    const specs = parseOrderBy(url.searchParams.get("$orderby"));
    if (specs.length !== 1 || specs[0].path.length !== 1 || rows.length === 0) return null;
    const name = specs[0].path[0];
    const last = rows.at(-1)[name];
    const first = rows[0][name];
    return last === undefined || first === undefined ? null : { name, last, first };
  }

  // Collection page with Dataverse paging: maxpagesize (cap 5000) or the default page; $skiptoken names the next page.
  function collectionPage(c, mapping, { ids = null, nextBase = null, tracked = false }) {
    assertCollectionOptions(c);
    const { url, prefer } = c;
    const pageCap = isElastic(mapping) ? 500 : PAGE_CAP;
    const pageSize = Math.min(prefer.maxPageSize ?? pageCap, pageCap);
    const offset = pageOffset(url, pageSize);
    // Tracked paging: the token minted on the first page travels in the $skiptoken, so the delta link starts there.
    const delta = tracked ? (carriedDelta(url) ?? changes.token()) : null;
    const narrowed = securedQuery(c, mapping, collectionParams(c, mapping));
    const params = narrowed.params;
    // observed: parity case query.track-changes: a tracked page without $orderby answers in row-version (creation/update) order.
    // The sort is internal: links and context are built from the caller's url, so the order is not echoed.
    if (tracked && !params.has("$orderby")) params.set("$orderby", "versionnumber asc");
    const paging = { params, offset, pageSize, preferenceApplied: null, nextLink: () => null };
    const scope = intersectIds(ids, narrowed.ids);
    const options = secured(c, scope ? { ids: scope } : {});
    const result = scope?.length === 0 ? emptyPage() : store.query(mapping.logicalName, params, c.identity, paging, options);
    const rows = result.value;
    const total = result.paging?.totalCount ?? rows.length;
    const counted = url.searchParams.get("$count") === "true";
    const body = { "@odata.context": contextFor(c, suffixFor(c, mapping)) };
    if (counted) body["@odata.count"] = Math.min(total, pageCap);
    addMetadataVersion(c, body);
    if (c.include?.(RECORD_COUNT)) body[`@${RECORD_COUNT}`] = counted ? Math.min(total, pageCap) : -1;
    if (c.include?.(RECORD_LIMIT)) body[`@${RECORD_LIMIT}`] = counted ? total > pageCap : false;
    const expand = parseExpand(url.searchParams.get("$expand"));
    body.value = rows.map((row) => keepAnnotations(formatRow(c, mapping, row, { etag: true, expand, allColumns: true }), c.include));
    if (result.paging?.moreRecords) {
      const idColumn = mapping.idColumn;
      const cookie = encodeSkipToken({
        pageNumber: offset / pageSize + 2,
        lastId: rows.at(-1)[idColumn],
        firstId: rows[0][idColumn],
        idColumn,
        orderColumn: orderColumnOf(url, rows),
      });
      // An extra attribute on the cookie carries the delta token; decodeSkipToken reads the paging attributes around it.
      const token = tracked ? cookie.replace(" />", ` deltatoken="${delta}" />`) : cookie;
      const base = nextBase ?? collectionBase(c, mapping);
      body["@odata.nextLink"] = nextLinkOf(c, base, token);
    } else if (tracked) body["@odata.deltaLink"] = deltaLinkOf(c, collectionBase(c, mapping), delta);
    const applied = preferenceApplied(prefer, { paged: true, tracked });
    return { status: 200, headers: applied ? { "Preference-Applied": applied } : {}, body };
  }

  // An aggregate alias (a number with no field definition) gets a formatted value in the organization number format, as FetchXML aggregates do.
  function aggregateValues(mapping, row, formatted) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== "number" || key.includes("@") || store.fieldDefinition(mapping.logicalName, key, fieldsOf)) continue;
      formatted[`${key}${FORMATTED}`] = formattedValue(value, { dataverseType: Number.isInteger(value) ? "int" : "decimal" }, store.state.settings);
    }
    return formatted;
  }

  function applyPage(c, mapping) {
    assertQueryMembers(c, mapping, c.url.searchParams);
    const narrowed = applyNarrowed(c, mapping, new URLSearchParams(c.url.searchParams));
    const result = store.query(mapping.logicalName, narrowed.params, c.identity, undefined, secured(c, narrowed.ids ? { ids: narrowed.ids } : {}));
    const value = result.value.map((row) => keepAnnotations(aggregateValues(mapping, row, formatRow(c, mapping, row, { etag: false })), c.include));
    const body = { "@odata.context": contextFor(c, mapping.entitySet), ...(result["@odata.count"] !== undefined ? { "@odata.count": result["@odata.count"] } : {}) };
    return { status: 200, body: { ...addMetadataVersion(c, body), value } };
  }

  function fetchXmlPage(c, mapping, xml, { order = "sorted" } = {}) {
    if (isElastic(mapping) && /<link-entity\b/i.test(xml))
      throw invalid("Link entities are not supported", "0x80048d0b");
    const logical = mapping.logicalName;
    // Well-formedness first: malformed XML answers before any entity is read.
    try {
      parseXmlDocument(xml);
    } catch (cause) {
      if (cause.code === "InvalidRequest") throw invalid("Invalid XML.", "0x80040201");
      throw cause;
    }
    const root = /<entity\b[^>]*?\bname\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1];
    if (root == null) throw invalid("Entity Name was not specified in FetchXml String.", "0x80041102");
    if (root !== logical) {
      throw invalid(`The entity set name '${mapping.entitySet}' does not match the FetchXml entity '${root}'.`, "0x80060888");
    }
    // Every link-entity table is read-authorized up front, so an empty linked table still answers 403; rows are trimmed by rowsFilterOf.
    for (const [, linked] of xml.matchAll(/<link-entity\b[^>]*?\bname\s*=\s*["']([^"']+)["']/gi)) {
      authorize(c, linked, "read", store.resolveMapping(linked));
    }
    // Aggregates read raw columns: a hidden secured one is refused, on the root or on any link-entity.
    if (security() && /<fetch\b[^>]*\baggregate\s*=\s*["']true["']/i.test(xml)) {
      for (const frame of fetchFrames(xml)) security().assertAggregate(c, store.resolveMapping(frame.entity), frame.attributes);
    }
    const fetched = store.fetchXml(xml, c.identity, { metadata: fieldsOf, backendRowsFilter: rowsFilterOf(c) });
    const info = fetched.columns;
    const columns = (info.columns ?? []).filter((col) => col.alias == null && !col.aliased && !col.aggregate).map((col) => col.attribute);
    if (!info.aggregate && !info.distinct && !columns.includes(mapping.idColumn)) columns.push(mapping.idColumn);
    // observed: parity case fetchxml.basic lists the columns alphabetically with the id, not in attribute order; an aggregate has no column list.
    // A saved query's columns keep the saved attribute order (observed: parity case views.system); the id stays last when it is not listed.
    const ordered = order === "attribute" ? columns : [...columns].sort();
    const listed = columns.length ? `(${ordered.join(",")})` : "";
    const body = { "@odata.context": contextFor(c, `${mapping.entitySet}${listed}`) };
    // returntotalrecordcount="true" answers the count (capped like $count) and, when included, the total and its limit flag.
    const counted = /<fetch\b[^>]*?\breturntotalrecordcount\s*=\s*["']true["']/i.test(xml) && fetched.total_record_count >= 0;
    if (counted) body["@odata.count"] = Math.min(fetched.total_record_count, PAGE_CAP);
    addMetadataVersion(c, body);
    if (counted && c.include?.(RECORD_COUNT)) body[`@${RECORD_COUNT}`] = fetched.total_record_count;
    if (counted && c.include?.(RECORD_LIMIT)) body[`@${RECORD_LIMIT}`] = Boolean(fetched.total_record_count_limit_exceeded);
    body.value = fetched.entities.map((row) => withoutNulls(keepAnnotations(shapeMoney(mapping, maskFetched(c, mapping, c.formatter.formatFetchRow(row, info), info)), c.include)));
    if (fetched.more_records && c.include?.(MORE_RECORDS)) body[`@${MORE_RECORDS}`] = true;
    // observed: parity case fetchxml.page: the paging cookie is answered without a Prefer header.
    if (fetched.more_records && fetched.paging_cookie) {
      body[`@${PAGING_COOKIE}`] = webApiPagingCookie(fetched.paging_cookie, Number(info.page ?? 1));
    }
    // observed: parity case fetchxml.join only: a FetchXML with a link-entity answers its JSON type with charset=utf-8.
    const joined = /<link-entity\b/i.test(xml);
    return { status: 200, headers: joined ? { "Content-Type": "application/json; odata.metadata=minimal; charset=utf-8" } : undefined, body };
  }

  // A tracked table: enabled in its metadata (when the metadata says), and read at organization level, since the delta
  // includes the ids of deleted rows. Anything less answers the privilege error Dataverse gives for a limited reader.
  function assertTableTracking(c, mapping, readFilter) {
    const logical = mapping.logicalName;
    if (trackingFlag(logical, mapping) === false) {
      throw new DataError(`Entity ${logical} isn't enabled for change tracking.`, 400, "InvalidRequest", { innerCode: "0x80072491" });
    }
    if (readFilter !== null) {
      throw privilegeDeniedError(c.user, privilegeName("read", principals.privilegeNoun(logical)), logical);
    }
  }

  // Change tracking answers only a plain collection (or a delta of one): no FetchXml, no $apply, and the query options it refuses.
  function assertTracking(c, mapping, readFilter) {
    for (const name of ["fetchXml", "fetchxml", "$apply"]) {
      if (c.url.searchParams.has(name)) throw invalid(`The "${name}" query parameter isn't supported when Change Tracking is enabled.`, "0x80060888");
    }
    assertTableTracking(c, mapping, readFilter);
    assertTrackable(c);
  }

  async function collection(c) {
    const { mapping, url } = c;
    if (isElastic(mapping) && url.searchParams.has("$expand"))
      throw invalid("Link entities are not supported", "0x80048d0b");
    authorize(c, mapping.logicalName, "read", mapping);
    const readFilter = filterOf(c, mapping);
    const answer = await firstAnswer("query", c, mapping);
    if (answer !== undefined) return answer.fetchXml != null ? fetchXmlPage(c, mapping, answer.fetchXml, { order: answer.columnOrder }) : answer;
    assertPredefinedAnswered(url);
    if (tracking(c)) {
      assertTracking(c, mapping, readFilter);
      if (url.searchParams.has("$deltatoken")) return deltaPage(c, mapping);
    }
    const xml = url.searchParams.get("fetchXml") ?? url.searchParams.get("fetchxml");
    if (xml != null) return fetchXmlPage(c, mapping, xml);
    if (url.searchParams.has("$apply")) return applyPage(c, mapping);
    return collectionPage(c, mapping, { tracked: tracking(c) });
  }

  async function countRecords(c) {
    const { mapping, url } = c;
    authorize(c, mapping.logicalName, "read", mapping);
    if (url.searchParams.has("$deltatoken")) {
      assertTableTracking(c, mapping, filterOf(c, mapping));
      const { changed, deleted } = await deltaChanges(c, mapping);
      return { status: 200, body: String(changed.length + deleted.length) };
    }
    // /$count is an Edm.Int32, so a $filter that names a property of the collection is refused (0x80060888).
    const countFilter = url.searchParams.get("$filter");
    if (countFilter != null) {
      for (const [head] of expressionPaths(parseODataExpression(countFilter, { dialect: "dataverse", rejectNotOnQueryFunctions: true }))) {
        if (head && !head.startsWith("@")) throw invalid(`Could not find a property named '${head}' on type 'Edm.Int32'.`, "0x80060888");
      }
    }
    const params = new URLSearchParams();
    if (url.searchParams.has("$filter")) params.set("$filter", url.searchParams.get("$filter"));
    params.set("$select", mapping.idColumn);
    assertQueryMembers(c, mapping, params);
    const narrowed = securedQuery(c, mapping, params);
    const result = store.query(mapping.logicalName, narrowed.params, c.identity, undefined, secured(c, narrowed.ids ? { ids: narrowed.ids } : {}));
    return { status: 200, body: String(Math.min(result.value.length, isElastic(mapping) ? 500 : PAGE_CAP)) };
  }

  function getEntity(c) {
    const { mapping } = c;
    const key = lookupKey(c, mapping, c.route.key);
    if (!key.row) throw notFoundRecord(mapping.logicalName, key.text);
    authorize(c, mapping.logicalName, "read", mapping, key.row);
    const body = entityBody(c, mapping, key.row[mapping.idColumn], entityParams(c, mapping), { allColumns: true });
    const etag = body["@odata.etag"];
    const match = c.headers["if-none-match"];
    if (etag && match && !c.url.searchParams.has("$expand") && c.include == null && String(match).split(",").map((item) => item.trim()).includes(etag)) {
      // observed: parity case concurrency.not-modified: the 304 is an empty text/html answer with no ETag and no OData-Version.
      return { status: 304, headers: { "Content-Type": "text/html; charset=utf-8" } };
    }
    // observed: parity cases headers.accept-xml and headers.accept-text: a record read asked for XML or text still answers JSON, streaming.
    const asOther = /application\/xml|text\/plain/i.test(String(c.headers.accept ?? ""));
    return {
      status: 200,
      headers: { ...etagOf(body), ...appliedHeader(c.prefer), ...(asOther ? { "Content-Type": JSON_STREAMING_CONTENT_TYPE } : {}) },
      body,
    };
  }

  // Payload as the store receives it: plain columns and nav@odata.bind, every other annotation dropped.
  // System columns are accepted and ignored (SYSTEM_IGNORED), except a plain system lookup, which assertPayload refuses;
  // overriddencreatedon is taken by createPayload only.
  function payload(mapping, body) {
    const data = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === OVERRIDDEN || (ignoredSystem(key) && (key.endsWith(BIND) || !LOOKUP_SYSTEM.has(key)))) continue;
      if (!key.includes("@") || key.endsWith(BIND)) data[key] = value;
    }
    assertPayload(mapping, data);
    return data;
  }

  // A create payload: overriddencreatedon sets createdon (UTC, ISO) and is stored under its own name; null is ignored.
  // unverified: the rejection of an unparseable date and the stored form are not captured from the live service.
  function createPayload(mapping, body) {
    const data = payload(mapping, body);
    const value = body[OVERRIDDEN];
    if (value == null) return data;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw invalid(`The value '${value}' is not a valid date-time for ${OVERRIDDEN}.`, "0x80040203");
    data.createdon = date.toISOString();
    data[OVERRIDDEN] = data.createdon;
    return data;
  }

  // Deep insert: each nested child is a create of its own table, so it needs create and append on the child and appendto
  // on the parent (a refusal names the child table), then the same payload rules. Ownership is stamped per row by the store.
  async function deepPayload(c, mapping, data) {
    for (const key of Object.keys(data)) {
      const rel = navigationOf(mapping, key);
      const value = data[key];
      if (!rel || key.endsWith(BIND) || !value || typeof value !== "object") continue;
      if (Object.hasOwn(value, "id") && Object.hasOwn(value, "logical_name")) continue;
      if (isElastic(mapping)) throw invalid("Cannot create related entities. Create has to be called individually for each entity.");
      const target = store.resolveMapping(rel.entity);
      const children = [];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!child || typeof child !== "object" || Array.isArray(child)) {
          children.push(child);
          continue;
        }
        authorize(c, target.logicalName, "create", target);
        authorize(c, target.logicalName, "append", target);
        authorize(c, mapping.logicalName, "appendto", mapping);
        const childData = await deepPayload(c, target, createPayload(target, child));
        await beforeWrite(c, target, { operation: "create", data: childData, existing: null });
        children.push(childData);
      }
      data[key] = Array.isArray(value) ? children : children[0];
    }
    return data;
  }

  // Authorizes each bind (appendto on the bound row, assign for ownerid) and normalises it to /set(key).
  function bindsOf(c, mapping, data, existing) {
    for (const key of Object.keys(data)) {
      if (!key.endsWith(BIND)) continue;
      const nav = key.slice(0, -BIND.length);
      if (nav === "ownerid") {
        if (!isMember(mapping, nav)) throw undeclared(mapping.entitySet, nav);
        authorize(c, mapping.logicalName, "assign", mapping, existing ?? undefined);
      }
      if (data[key] === null) continue;
      const ref = refOf(data[key]);
      const target = mappingForSet(ref.set);
      const rel = navigationOf(mapping, nav);
      const row = rowOf(c, target, ref.id, isElastic(target) ? data[`${rel?.from ?? nav}pid`] : null);
      if (!row && isElastic(target) && !ref.id.includes("=") && data[`${rel?.from ?? nav}pid`] == null) {
        authorize(c, target.logicalName, "appendto", target);
        data[key] = `/${ref.set}(${ref.id})`;
        continue;
      }
      if (!row) throw notFoundRecord(target.logicalName, ref.id);
      authorize(c, target.logicalName, "appendto", target, row);
      data[key] = `/${ref.set}(${ref.id})`;
    }
    return data;
  }

  // Owner of a write as { id, logical_name }: the ownerid bind on a create, or the ownerid the store coerced from a bind on an update.
  // A plain ownerid never gets here: assertPayload refuses it, so no branch is needed for it.
  function ownerOf(data) {
    const bind = data[`ownerid${BIND}`];
    if (bind == null) return data.ownerid?.id ? { id: data.ownerid.id, logical_name: data.ownerid.logical_name } : null;
    const ref = refOf(bind);
    return { id: ref.id, logical_name: mappingForSet(ref.set).logicalName };
  }
  // Audit and ownership columns are written by the store after coercion, whether or not the mapping declares them.
  // The store calls this per row it writes, so a deep-inserted child gets the columns of its own table.
  // A created or updated row takes the next org-wide row version (state.rowVersion, persisted): its versionnumber, and the ETag W/"<versionnumber>".
  const systemColumns = (c, create) => (mapping, input) => ({
    ...principals.systemColumns({ user: c.user, caller: c.caller, mapping, owner: ownerOf(input), create }),
    versionnumber: nextRowVersion(store),
    ...currencyOnWrite(mapping, input),
  });
  const createOptions = (c, extra = {}) => writeOptions({ ...extra, systemColumns: systemColumns(c, true), bypassCustomPlugins: c.bypassCustomPlugins === true });
  const updateOptions = (c, extra = {}) => writeOptions({ partitionId: c.partitionId, ...extra, systemColumns: systemColumns(c, false), bypassCustomPlugins: c.bypassCustomPlugins === true });

  async function createData(c, mapping, body) {
    const data = createPayload(mapping, body);
    const logical = mapping.logicalName;
    authorize(c, logical, "create", mapping);
    if (Object.keys(data).some((key) => key.endsWith(BIND))) authorize(c, logical, "append", mapping);
    bindsOf(c, mapping, data, null);
    await deepPayload(c, mapping, data);
    // A new row is active (statecode 0) with the default status of that state.
    if (!("statecode" in data) && hasStateColumns(mapping)) data.statecode = 0;
    if (!("statuscode" in data) && hasStateColumns(mapping)) {
      const status = defaultStatus(mapping);
      if (status !== undefined) data.statuscode = status;
    }
    await beforeWrite(c, mapping, { operation: "create", data, existing: null });
    return data;
  }

  // The state-0 status: the mapping's own default first, else the first status option whose state is 0, else 1 (Active on the probe).
  function defaultStatus(mapping) {
    const fromMapping = mapping.stateStatusDefaults?.[0];
    if (fromMapping !== undefined) return fromMapping;
    const definition = store.fieldDefinition(mapping.logicalName, "statuscode", fieldsOf);
    return (definition?.statuses ?? definition?.options ?? []).find((option) => String(option?.state) === "0")?.value ?? 1;
  }

  // Tables with a state and status pair: every table but an intersect table, whose solution metadata may omit the pair.
  function hasStateColumns(mapping) {
    if (isElastic(mapping)) return false;
    return !mapping.intersect || Boolean(mapping.stateStatusDefaults || store.fieldDefinition(mapping.logicalName, "statecode", fieldsOf) || store.fieldDefinition(mapping.logicalName, "statuscode", fieldsOf));
  }

  async function updateData(c, mapping, body, existing) {
    const data = bindsOf(c, mapping, payload(mapping, body), existing);
    delete data[mapping.idColumn];
    await beforeWrite(c, mapping, { operation: "update", data, existing });
    return data;
  }

  // Upsert semantics per If-Match / If-None-Match; runs inside the caller's transaction and returns { created, id }.
  async function upsertNow(c, mapping, key, body, { ifMatch, ifNoneMatch }) {
    const logical = mapping.logicalName;
    if (key.row && ifNoneMatch === "*") {
      throw new DataError("A record with matching key values already exists.", 412, "PreconditionFailed", { innerCode: "0x80040237" });
    }
    // Native PATCH with If-Match on a missing row: 404 0x80040217, worded "Entity '<table>' With Id = <id> Does Not Exist".
    if (!key.row && ifMatch != null) {
      throw new DataError(`Entity '${logical}' With Id = ${key.text} Does Not Exist`, 404, "NotFound", { innerCode: "0x80040217" });
    }
    if (isElastic(mapping) && ifMatch == null) {
      const data = bindsOf(c, mapping, payload(mapping, body), key.row);
      if (key.alternate) {
        if (Object.hasOwn(data, "partitionid") && !samePartition(data.partitionid, key.alternate.partitionid))
          throw invalid("The partitionid value of an elastic table row cannot be changed.");
        Object.assign(data, key.alternate);
      } else data[mapping.idColumn] = key.id;
      authorize(c, logical, key.row ? "update" : "create", mapping, key.row ?? undefined);
      if (Object.keys(data).some((name) => name.endsWith(BIND))) authorize(c, logical, "append", mapping);
      await beforeWrite(c, mapping, { operation: "upsert", data, existing: key.row });
      const result = store.elasticUpsertRecord(logical, key.id ?? data[mapping.idColumn], data, c.identity,
        (key.row ? updateOptions : createOptions)(c, { ifMatch, ifNoneMatch, partitionId: c.partitionId }));
      await afterWrite(c, mapping, { operation: "upsert", id: result.row[mapping.idColumn] });
      return { created: result.created, id: result.row[mapping.idColumn] };
    }
    if (key.row) {
      authorize(c, logical, "update", mapping, key.row);
      const data = await updateData(c, mapping, body, key.row);
      withKeyViolation(mapping, data, () => store.updateRecord(logical, key.row[mapping.idColumn], data, c.identity, updateOptions(c, { ifMatch, ifNoneMatch })));
      await afterWrite(c, mapping, { operation: "update", id: key.row[mapping.idColumn] });
      return { created: false, id: key.row[mapping.idColumn] };
    }
    const data = await createData(c, mapping, body);
    if (key.alternate) Object.assign(data, key.alternate);
    else data[mapping.idColumn] = key.id;
    const row = withKeyViolation(mapping, data, () => store.createRecord(logical, data, c.identity, createOptions(c, { ifNoneMatch })));
    await afterWrite(c, mapping, { operation: "create", id: row[mapping.idColumn] });
    return { created: true, id: row[mapping.idColumn] };
  }

  async function createEntity(c) {
    const { mapping } = c;
    const body = bodyOf(mapping.entitySet, c.body);
    const row = await runWrite(async () => {
      const data = await createData(c, mapping, body);
      const created = withKeyViolation(mapping, data, () =>
        store.createRecord(mapping.logicalName, data, c.identity, createOptions(c, { ifNoneMatch: c.headers["if-none-match"] })),
      );
      await afterWrite(c, mapping, { operation: "create", id: created[mapping.idColumn] });
      return created;
    });
    const id = row[mapping.idColumn];
    if (isElastic(mapping)) c.partitionId = row.partitionid ?? null;
    // 204 names the new row in OData-EntityId; a 201 representation carries the row itself.
    // ServiceClient (UseWebApi) reads the new id only from Location (ConnectionService.cs Command_WebAPIProcess_ExecuteAsync).
    if (!c.prefer.representation) {
      const url = entityUrl(c.origin, c.version, mapping.entitySet, id);
      return { status: 204, headers: { "OData-EntityId": url, Location: url } };
    }
    // The new row representation answers every column; the 201 carries no ETag (observed: POST 201 has Preference-Applied only).
    const represented = entityBody(c, mapping, id, entityParams(c, mapping), { allColumns: true });
    return { status: 201, headers: appliedHeader(c.prefer), body: represented };
  }

  async function patchEntity(c) {
    const { mapping } = c;
    const body = bodyOf(mapping.entitySet, c.body);
    const key = lookupKey(c, mapping, c.route.key);
    const outcome = await runWrite(() =>
      upsertNow(c, mapping, key, body, { ifMatch: c.headers["if-match"], ifNoneMatch: c.headers["if-none-match"] }),
    );
    const location = entityUrl(c.origin, c.version, mapping.entitySet, isElastic(mapping) ? recordKey(mapping, { [mapping.idColumn]: outcome.id, partitionid: c.partitionId }) : key.alternate ? key.text : outcome.id);
    if (!c.prefer.representation) return { status: 204, headers: { "OData-EntityId": location, Location: location } };
    // An update answers every column but drops the null ones (observed: every PATCH 200 body); an upsert-create keeps its own column set.
    const represented = outcome.created
      ? entityBody(c, mapping, outcome.id, entityParams(c, mapping))
      : withoutNullColumns(entityBody(c, mapping, outcome.id, entityParams(c, mapping), { allColumns: true }));
    return { status: outcome.created ? 201 : 200, headers: { ...etagOf(represented), ...appliedHeader(c.prefer) }, body: represented };
  }

  async function deleteEntity(c) {
    const { mapping } = c;
    const key = lookupKey(c, mapping, c.route.key);
    if (!key.row) throw notFoundRecord(mapping.logicalName, key.text);
    authorize(c, mapping.logicalName, "delete", mapping, key.row);
    await runWrite(async () => {
      await beforeWrite(c, mapping, { operation: "delete", existing: key.row });
      store.removeRecord(mapping.logicalName, key.row[mapping.idColumn], c.identity, updateOptions(c, { ifMatch: c.headers["if-match"] }));
      await afterWrite(c, mapping, { operation: "delete", id: key.row[mapping.idColumn] });
    });
    return { status: 204 };
  }

  // Related rows through a relationship, narrowed by a member key and the caller's row filter.
  function relatedRows(c, mapping, row, rel, segmentKey) {
    const target = store.resolveMapping(rel.entity);
    const wanted = segmentKey ? parseKey(segmentKey)?.id : null;
    const rows = store
      .queryContext(c.identity, { metadata: fieldsOf, backendRowsFilter: rowsFilterOf(c) })
      .related(row, rel)
      .filter((item) => !wanted || sameId(item[target.idColumn], wanted));
    return { target, rows };
  }

  // Navigation collections reach the query hook with c.mapping as the parent and the related mapping as its argument.
  async function getNavigation(c, rel) {
    const { mapping, route } = c;
    const key = parentRow(c, mapping, "read");
    const { target, rows } = relatedRows(c, mapping, key.row, rel, route.segmentKey);
    if (rel.many === false) {
      const [row] = rows;
      return row ? { status: 200, body: entityBody({ ...c, partitionId: row.partitionid ?? null }, target, row[target.idColumn], entityParams(c, target)) } : { status: 204 };
    }
    const navigation = { ...c, navigation: { parent: { mapping, id: key.row[mapping.idColumn] }, name: route.segment } };
    const answer = await firstAnswer("query", navigation, target);
    if (answer !== undefined) {
      if (answer.fetchXml == null) return answer;
      authorize(c, target.logicalName, "read", target);
      return fetchXmlPage(navigation, target, answer.fetchXml, { order: answer.columnOrder });
    }
    assertPredefinedAnswered(c.url);
    const base = `${c.origin}/api/data/${c.version}/${mapping.entitySet}(${route.key})/${route.segment}`;
    return collectionPage(navigation, target, { ids: rows.map((row) => row[target.idColumn]), nextBase: base });
  }

  // The store does not reject unknown $select columns on the by-id path, so the property name is checked here.
  // The currency lookup is a property of any table with a money column (its value comes from shapeMoney).
  const hasProperty = (mapping, segment) =>
    segment === mapping.idColumn ||
    Boolean(store.fieldDefinition(mapping.logicalName, segment, fieldsOf)) ||
    (segment === CURRENCY && Object.keys(mapping.fields ?? {}).some((key) => isMoney(mapping, key)));
  function assertProperty(mapping, segment) {
    if (hasProperty(mapping, segment)) return;
    throw invalid(`Could not find a property named '${segment}' on type 'Microsoft.Dynamics.CRM.${mapping.logicalName}'.`, "0x80060888");
  }

  function readProperty(c, mapping, id, segment) {
    // A path segment that names no column is a missing resource (404 0x80060888), not a bad query option.
    if (!hasProperty(mapping, segment)) throw new DataError(`Resource not found for the segment '${segment}'`, 404, "UnknownEntity", { httpStatus: 404, innerCode: "0x80060888" });
    const params = new URLSearchParams({ $select: segment });
    const projected = store.query(mapping.logicalName, params, c.identity, undefined, secured(c, { id })).value[0];
    return projected?.[segment] ?? null;
  }

  function getProperty(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (rel) return getNavigation(c, rel);
    const key = parentRow(c, mapping, "read");
    const value = readProperty(c, mapping, key.row[mapping.idColumn], route.segment);
    if (value == null) return { status: 204 };
    return { status: 200, body: { "@odata.context": contextFor(c, `${mapping.entitySet}(${route.key})/${route.segment}`), value } };
  }

  function getValue(c) {
    const key = parentRow(c, c.mapping, "read");
    // A raw value of an unknown property: Dataverse names the $value segment, not the property.
    if (!hasProperty(c.mapping, c.route.segment)) {
      throw new DataError(`The URI segment '$value' is invalid after the segment '${c.route.segment}'.`, 400, "InvalidRequest", { innerCode: "0x80060888", route: true });
    }
    const value = readProperty(c, c.mapping, key.row[c.mapping.idColumn], c.route.segment);
    return value == null ? { status: 204 } : { status: 200, body: String(value) };
  }

  async function writeProperty(c, segment, value) {
    const { mapping } = c;
    const key = parentRow(c, mapping, "update");
    await runWrite(async () => {
      const data = await updateData(c, mapping, { [segment]: value }, key.row);
      store.updateRecord(mapping.logicalName, key.row[mapping.idColumn], data, c.identity, updateOptions(c));
      await afterWrite(c, mapping, { operation: "update", id: key.row[mapping.idColumn] });
    });
    return { status: 204 };
  }

  function putProperty(c) {
    if (navigationOf(c.mapping, c.route.segment)) throw methodNotAllowed(c.method);
    const body = bodyOf(c.mapping.entitySet, c.body);
    if (!("value" in body)) throw invalid('A property value is required: { "value": ... }.', "0x0");
    return writeProperty(c, c.route.segment, body.value);
  }

  function deleteProperty(c) {
    if (navigationOf(c.mapping, c.route.segment)) throw methodNotAllowed(c.method);
    return writeProperty(c, c.route.segment, null);
  }

  function navigationCount(c) {
    const rel = navigationOf(c.mapping, c.route.segment);
    if (!rel || rel.many === false) throw noResource(c);
    const key = parentRow(c, c.mapping, "read");
    const { rows } = relatedRows(c, c.mapping, key.row, rel);
    return { status: 200, body: String(Math.min(rows.length, PAGE_CAP)) };
  }

  function getRef(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (!rel) throw noResource(c);
    const key = parentRow(c, mapping, "read");
    const { target, rows } = relatedRows(c, mapping, key.row, rel);
    const link = (row) => ({ "@odata.id": entityUrl(c.origin, c.version, target.entitySet, row[target.idColumn]) });
    // observed: parity case relationships.reference: a single-valued $ref answers the $ref context.
    if (rel.many === false) return rows[0] ? { status: 200, body: { "@odata.context": contextFor(c, "$ref"), ...link(rows[0]) } } : { status: 204 };
    return { status: 200, body: { "@odata.context": contextFor(c, "Collection($ref)"), value: rows.map(link) } };
  }

  async function postRef(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (!rel || rel.many === false) throw methodNotAllowed(c.method);
    const ref = refOf(bodyOf(mapping.entitySet, c.body)["@odata.id"]);
    const target = store.resolveMapping(rel.entity);
    const parent = parentRow(c, mapping, "appendto");
    const child = rowOf(c, target, ref.id);
    if (!child) throw notFoundRecord(target.logicalName, ref.id);
    authorize(c, target.logicalName, "append", target, child);
    // changeAssociationRecord, not store.associate: that one opens its own transaction, which would queue behind this one.
    await runWrite(async () => {
      await beforeWrite(c, mapping, { operation: "associate", data: { relationship: route.segment, id: child[target.idColumn] }, existing: parent.row });
      store.changeAssociationRecord(mapping.logicalName, parent.row[mapping.idColumn], route.segment, child[target.idColumn], c.identity, true, updateOptions(c));
      await afterWrite(c, mapping, { operation: "associate", id: parent.row[mapping.idColumn], relationship: route.segment });
    });
    return { status: 204 };
  }

  async function putRef(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (!rel || rel.many !== false) throw methodNotAllowed(c.method);
    const ref = refOf(bodyOf(mapping.entitySet, c.body)["@odata.id"]);
    const parent = parentRow(c, mapping, "update");
    await runWrite(async () => {
      const data = await updateData(c, mapping, { [`${route.segment}${BIND}`]: `/${ref.set}(${ref.id})` }, parent.row);
      store.updateRecord(mapping.logicalName, parent.row[mapping.idColumn], data, c.identity, updateOptions(c));
      await afterWrite(c, mapping, { operation: "update", id: parent.row[mapping.idColumn], relationship: route.segment });
    });
    return { status: 204 };
  }

  async function deleteRef(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (!rel) throw noResource(c);
    if (rel.many === false) {
      const parent = parentRow(c, mapping, "update");
      await runWrite(async () => {
        const data = await updateData(c, mapping, { [`${route.segment}${BIND}`]: null }, parent.row);
        store.updateRecord(mapping.logicalName, parent.row[mapping.idColumn], data, c.identity, updateOptions(c));
        await afterWrite(c, mapping, { operation: "update", id: parent.row[mapping.idColumn], relationship: route.segment });
      });
      return { status: 204 };
    }
    const parent = parentRow(c, mapping, "appendto");
    const target = store.resolveMapping(rel.entity);
    const childId = route.kind === "navigationRef" ? parseKey(route.targetKey)?.id : refOf(c.url.searchParams.get("$id"), { urlKey: true }).id;
    const child = rowOf(c, target, childId);
    if (!child) throw notFoundRecord(target.logicalName, childId);
    authorize(c, target.logicalName, "append", target, child);
    await runWrite(async () => {
      await beforeWrite(c, mapping, { operation: "disassociate", data: { relationship: route.segment, id: child[target.idColumn] }, existing: parent.row });
      store.changeAssociationRecord(mapping.logicalName, parent.row[mapping.idColumn], route.segment, child[target.idColumn], c.identity, false, updateOptions(c));
      await afterWrite(c, mapping, { operation: "disassociate", id: parent.row[mapping.idColumn], relationship: route.segment });
    });
    return { status: 204 };
  }

  function targetsOf(c) {
    const targets = c.body?.Targets;
    if (!Array.isArray(targets) || !targets.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      throw invalid("The Targets parameter must be an array of objects.");
    }
    return targets;
  }

  // Native refuses a bulk message before any write: no targets, or a target typed as another table (the message reads 'none' there).
  // unverified: live capture (only CreateMultiple recorded); UpdateMultiple and UpsertMultiple take the same refusals.
  function refuseBulkTargets(mapping, message, targets) {
    if (targets.length === 0) throw new DataError("Custom state is not set for entity type crmbaseentity.", 400, "InvalidRequest", { innerCode: "0x80040216" });
    const typed = `Microsoft.Dynamics.CRM.${mapping.logicalName}`;
    if (targets.some((target) => target["@odata.type"] !== undefined && String(target["@odata.type"]).replace(/^#/, "") !== typed)) {
      throw new DataError(`The '${message}' method does not support entities of type 'none'. MessageProcessorCache returned MessageProcessor.Empty. `, 400, "InvalidRequest", { innerCode: "0x80040800" });
    }
  }

  // Elastic bulk requests commit each successful target independently and continue after failures.
  // Learn: bulk-operations, "On error behavior with elastic tables". Error codes of individual targets remain native CRUD errors.
  async function elasticBulk(c) {
    const { mapping, route } = c;
    const targets = targetsOf(c);
    refuseBulkTargets(mapping, route.name, targets);
    const ids = [], failures = [];
    let firstError;
    for (const [index, target] of targets.entries()) {
      try {
        const reference = target["@odata.id"] == null ? null : refOf(target["@odata.id"]);
        if (reference && reference.set !== mapping.entitySet) throw invalid("The target does not belong to the bound table.");
        const text = reference?.id ?? target[mapping.idColumn];
        const alternate = text == null ? null : parseKey(text)?.alternate;
        const item = { ...c, partitionId: alternate?.partitionid ?? target.partitionid ?? null };
        await runWrite(async () => {
          if (route.name === "CreateMultiple") {
            const data = await createData(item, mapping, target);
            const row = store.createRecord(mapping.logicalName, data, c.identity, createOptions(item));
            ids.push(row[mapping.idColumn]);
            await afterWrite(item, mapping, { operation: "create", id: row[mapping.idColumn] });
          } else {
            if (text == null) throw invalid(`The ${mapping.idColumn} property is required.`);
            const key = lookupKey(item, mapping, String(text));
            if (route.name === "DeleteMultiple") {
              if (!key.row) throw notFoundRecord(mapping.logicalName, key.text);
              authorize(item, mapping.logicalName, "delete", mapping, key.row);
              await beforeWrite(item, mapping, { operation: "delete", existing: key.row });
              store.removeRecord(mapping.logicalName, key.row[mapping.idColumn], c.identity, updateOptions(item));
              await afterWrite(item, mapping, { operation: "delete", id: key.row[mapping.idColumn] });
            } else {
              await upsertNow(item, mapping, key, target, { ifMatch: route.name === "UpdateMultiple" ? "*" : undefined });
            }
          }
        });
      } catch (error) {
        if (!(error instanceof DataError)) throw error;
        firstError ??= error;
        failures.push({ RequestIndex: index, Id: target[mapping.idColumn] ?? null, StatusCode: error.status ?? 400 });
      }
    }
    if (firstError) throw new DataError(firstError.message, firstError.status, firstError.code, { ...firstError.details, bulkApiErrorDetails: failures });
    return route.name === "CreateMultiple"
      ? { status: 200, body: { "@odata.context": contextFor(c, "Microsoft.Dynamics.CRM.CreateMultipleResponse"), Ids: ids } }
      : { status: 204 };
  }

  async function boundAction(c) {
    const { mapping, route } = c;
    if (route.key != null) throw noResource(c);
    if (isElastic(mapping) && ["CreateMultiple", "UpdateMultiple", "UpsertMultiple", "DeleteMultiple"].includes(route.name))
      return elasticBulk(c);
    if (route.name === "CreateMultiple") {
      const targets = targetsOf(c);
      refuseBulkTargets(mapping, "CreateMultiple", targets);
      const rows = await runWrite(async () => {
        const created = [];
        for (const target of targets) {
          const data = await createData(c, mapping, target);
          created.push(withKeyViolation(mapping, data, () => store.createRecord(mapping.logicalName, data, c.identity, createOptions(c))));
        }
        for (const row of created) await afterWrite(c, mapping, { operation: "create", id: row[mapping.idColumn] });
        return created;
      });
      return {
        status: 200,
        body: { "@odata.context": contextFor(c, "Microsoft.Dynamics.CRM.CreateMultipleResponse"), Ids: rows.map((row) => row[mapping.idColumn]) },
      };
    }
    if (route.name === "UpdateMultiple" || route.name === "UpsertMultiple") {
      const update = route.name === "UpdateMultiple";
      const targets = targetsOf(c);
      refuseBulkTargets(mapping, route.name, targets);
      const texts =targets.map((target) => (update ? String(target[mapping.idColumn] ?? "") : refOf(target["@odata.id"]).id));
      // The first target per key wins: UpdateMultiple drops later repeats, UpsertMultiple refuses the batch.
      const seen = new Set();
      const work = [];
      targets.forEach((target, index) => {
        const folded = texts[index].toLowerCase();
        if (seen.has(folded)) return;
        seen.add(folded);
        work.push({ target, text: texts[index] });
      });
      if (!update && work.length !== targets.length) throw invalid("Duplicate key in Targets.", "0x80040203"); // unverified: message
      await runWrite(async () => {
        for (const { target, text } of work) {
          const key = lookupKey(c, mapping, text);
          if (update && !key.row) throw notFoundRecord(mapping.logicalName, key.text);
          await upsertNow(c, mapping, key, target, {});
        }
      });
      return { status: 204 };
    }
    if (route.name === "DeleteMultiple") {
      throw new DataError("DeleteMultiple has not yet been implemented.", 501, "NotImplemented", { innerCode: "0x80040216" });
    }
    throw noResource(c);
  }

  // A verb a record does not take. PUT and POST on a record have their own native 0x80060888 messages; others are the generic 405.
  const unsupportedVerbError = (c) => {
    if (c.route.kind === "entity" && c.method === "PUT") {
      return new DataError(`Operation not supported on ${c.mapping.logicalName}`, 405, "MethodNotAllowed", { httpStatus: 405, innerCode: "0x80060888" });
    }
    if (c.route.kind === "entity" && c.method === "POST") {
      return new DataError("Unmapped Request found, PathTemplate:~/entityset/key, HttpVerb:POST", 405, "MethodNotAllowed", { httpStatus: 405, innerCode: "0x80060888" });
    }
    return methodNotAllowed(c.method);
  };
  // Allow on a keyed 405 lists the methods of the record, per attempted method (observed: errors.method-put, -post, -head).
  const RECORD_ALLOW = {
    HEAD: "POST,OPTIONS,GET,HEAD,POST",
    OPTIONS: "POST,OPTIONS,GET,HEAD,POST",
    PUT: "GET,PATCH,DELETE,OPTIONS,GET,HEAD,POST",
    POST: "GET,PUT,PATCH,DELETE,OPTIONS,GET,HEAD,POST",
  };
  const unsupportedVerb = (c) => {
    const error = unsupportedVerbError(c);
    if (c.route.kind === "entity" && RECORD_ALLOW[c.method]) error.details = { ...error.details, allow: RECORD_ALLOW[c.method] };
    return error;
  };

  const verbs = (c, table) => {
    const run = table[c.method];
    if (!run) throw unsupportedVerb(c);
    return run(c);
  };

  // The stream hook sees property and value routes on any verb, before the route's own verbs run.
  const streamOr = async (c, otherwise) => {
    const answer = await firstAnswer("stream", c);
    return answer !== undefined ? answer : otherwise();
  };

  async function dispatch(c) {
    switch (c.route.kind) {
      case "collection": return verbs(c, { GET: collection, POST: createEntity });
      case "count": return verbs(c, { GET: countRecords });
      case "entity": return verbs(c, { GET: getEntity, PATCH: patchEntity, DELETE: deleteEntity });
      case "property": return streamOr(c, () => verbs(c, { GET: getProperty, PUT: putProperty, DELETE: deleteProperty }));
      case "member": return verbs(c, { GET: getProperty, PUT: putProperty, DELETE: deleteProperty });
      case "value": return streamOr(c, () => verbs(c, { GET: getValue }));
      case "navigationCount": return verbs(c, { GET: navigationCount });
      case "ref": return verbs(c, { GET: getRef, POST: postRef, PUT: putRef, DELETE: deleteRef });
      case "navigationRef": return verbs(c, { DELETE: deleteRef });
      case "boundAction": return verbs(c, { POST: boundAction });
      default: throw noResource(c);
    }
  }

  return {
    async handle(ctx) {
      checkQuery(ctx.url);
      const mapping = mappingForSet(ctx.route.set);
      const c = {
        ...ctx,
        mapping,
        include: ctx.prefer.annotations == null ? null : annotationMatcher(ctx.prefer.annotations),
        // Money formatted values carry the organization currency symbol, "$" when none is configured.
        formatter: createWebApiFormatter({
          store,
          identity: ctx.identity,
          metadata: fieldsOf,
          formatting: { ...store.state.settings, currencySymbol: baseCurrency()?.currencysymbol ?? store.state.settings.currencySymbol ?? "$" },
        }),
      };
      if (isElastic(mapping)) {
        const alternate = ctx.route.key == null ? null : parseKey(ctx.route.key)?.alternate;
        const raw = ctx.url.searchParams.get("partitionId");
        const parameter = raw?.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : raw;
        c.partitionId = alternate?.partitionid ?? ((ctx.method === "GET" || ctx.method === "DELETE") ? parameter : ctx.body?.partitionid) ?? null;
      }
      const response = await dispatch(c);
      if (isElastic(mapping) && ctx.method !== "GET" && ctx.method !== "DELETE" && response?.status < 400)
        response.headers = { ...response.headers, "x-ms-session-token": `mirage:${mapping.logicalName}:${store.state.rowVersion ?? 0}` };
      return response;
    },
    // Unsubscribes the change log from the store; the API calls it when it closes.
    close: () => changes.close(),
  };
}
