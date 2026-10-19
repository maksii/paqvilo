// Record handlers for the simulated Dataverse Web API: collections, single rows,
// properties, navigation, $ref and collection-bound actions. The Dataverse layer
// authorizes each call here before the store runs under the bypass identity.
// metadata, objectTypeCode and clock are accepted for the router contract and unused so far.
import { DataError } from "./data-error.mjs";
import { parseEntityReference } from "./data.mjs";
import { webApiPagingCookie } from "./fetchxml-engine.mjs";
import { expressionPaths, parseExpand, parseODataExpression, parseOrderBy, parseSelect } from "./odata-query.mjs";
import { NAVIGATION, createWebApiFormatter } from "./webapi-format.mjs";
import { ownershipOf } from "./dataverse-security.mjs";
import {
  JSON_CONTENT_TYPE,
  annotationMatcher,
  skipTokenQueryValue,
  contextUrl,
  decodeSkipToken,
  encodeSkipToken,
  entityUrl,
  parseKey,
  preferenceApplied,
} from "./dataverse-odata.mjs";

const PAGE_CAP = 5000;
// Control annotations a write may carry; other @ annotations are dropped by payload().
const CONTROL = new Set(["@odata.type", "@odata.context", "@odata.id", "@odata.etag"]);
const OWNER_FIELDS = ["ownerid", "owninguser", "owningteam"];
const BIND = "@odata.bind";
const ALLOWED_QUERY = new Set([
  "$select", "$filter", "$expand", "$orderby", "$top", "$count", "$apply", "$skiptoken", "$id",
  "fetchXml", "fetchxml", "savedQuery", "userQuery",
]);
const RECORD_COUNT = "Microsoft.Dynamics.CRM.totalrecordcount";
const RECORD_LIMIT = "Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded";
const MORE_RECORDS = "Microsoft.Dynamics.CRM.morerecords";
const PAGING_COOKIE = "Microsoft.Dynamics.CRM.fetchxmlpagingcookie";

const invalid = (message, innerCode = "0x80040203") => new DataError(message, 400, "InvalidRequest", { innerCode });
const unknownSet = (set) => new DataError(`Resource not found for the segment '${set}'.`, 404, "UnknownEntity", { innerCode: "0x8006088a" });
const notFoundRecord = (logical, id, innerCode = "0x80040217") =>
  new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { id, innerCode });
const noResource = (c) => new DataError(`No HTTP resource was found that matches the request URI '${c.url.href}'.`, 404, "UnknownResource", { innerCode: "" });
const methodNotAllowed = (method) =>
  new DataError(`The requested resource does not support http method '${method}'.`, 405, "MethodNotAllowed", { innerCode: "" });
const sameId = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const withoutNulls = (row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
const etagOf = (body) => (body["@odata.etag"] ? { ETag: body["@odata.etag"] } : {});
const emptyPage = () => ({ value: [], paging: { moreRecords: false, totalCount: 0 } });

function checkQuery(url) {
  for (const name of url.searchParams.keys()) {
    if (!ALLOWED_QUERY.has(name) && !name.startsWith("@")) {
      throw new DataError(`The query parameter ${name} is not supported`, 400, "UnsupportedQuery", { innerCode: "0x80060888" });
    }
  }
}

// $skiptoken names a page; offsets are (pageNumber - 1) * pageSize into the stable result order.
function pageOffset(url, pageSize) {
  const text = url.searchParams.get("$skiptoken");
  if (text == null) return 0;
  const token = decodeSkipToken(text);
  const offset = token && Number.isInteger(token.pageNumber) && token.pageNumber >= 2 ? (token.pageNumber - 1) * pageSize : -1;
  if (offset < 0) throw invalid("The $skiptoken is not valid.", "0x80060888");
  return offset;
}

// The primary id always travels with $select so paging and etags have it; the context URL keeps the caller's list.
function withIdSelect(select, idColumn) {
  if (select == null || select === "*" || (parseSelect(select) ?? []).includes(idColumn)) return select;
  return `${select},${idColumn}`;
}

// Mirrors the handler's annotation stripping: @odata.* always stays, other annotations need a match.
function keepAnnotations(value, include) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const at = key.indexOf("@");
    const term = at < 0 ? null : key.slice(at + 1);
    if (term != null && !term.startsWith("odata.") && !(include && include(term))) continue;
    out[key] = item;
  }
  return out;
}

// Accepts /set(key), set(key), absolute <origin>/api/data/vX/set(key) and alternate-key forms.
function refOf(value) {
  const text = String(value ?? "").trim().replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?api\/data\/v\d+\.\d+\//i, "");
  const ref = parseEntityReference(text);
  if (!ref) throw invalid(`Invalid entity reference '${text}'.`, "0x80048d19");
  return ref;
}

// The token is passed to skipTokenQueryValue after one decode: its inner pagingcookie stays percent-encoded.
function nextLinkOf(c, base, token) {
  const query = new URLSearchParams(c.url.searchParams);
  query.delete("$skiptoken");
  const text = query.toString().replace(/%24/g, "$");
  return `${base}?${text ? `${text}&` : ""}$skiptoken=${skipTokenQueryValue(decodeURIComponent(token))}`;
}

const refKey = (id) => String(id ?? "").toLowerCase();
const refIdOf = (value) => (value && typeof value === "object" ? (value.id ?? null) : (value ?? null));

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

export function createRecordHandlers({ store, change, principals, metadataFields = () => undefined }) {
  const authorize = (c, entity, operation, mapping, row) => principals.authorize({ user: c.user, entity, operation, row, mapping });
  const filterOf = (c, mapping) => principals.readFilter({ user: c.user, entity: mapping.logicalName, mapping }) ?? null;
  const filterOptions = (readFilter) => (readFilter ? { backendRowFilter: readFilter } : {});
  const queryOptions = (extra = {}) => ({ dialect: "dataverse", metadata: metadataFields, includeKeys: true, ...extra });
  const writeOptions = (extra = {}) => ({ coerce: true, metadata: metadataFields, ...extra });
  const runWrite = (fn) => change(() => store.transact(fn, { incremental: true }));
  const contextFor = (c, suffix) => contextUrl(c.origin, c.version, suffix);
  const suffixFor = (c, mapping) => {
    const select = parseSelect(c.url.searchParams.get("$select")) ?? [];
    return `${mapping.entitySet}${select.length ? `(${select.join(",")})` : ""}`;
  };
  const bodyOf = (set, body) => {
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
    throw invalid(`Error identified in Payload provided by the user for Entity :'${set}'  ---->  InnerException : A request body is required.`, "0x80048d19");
  };

  // Entity set names are case-sensitive; logical names do not route (Dataverse 404 0x8006088a).
  function mappingForSet(set) {
    const owner = Object.keys(store.state.mappings).find((name) => store.state.mappings[name]?.entitySet === set);
    if (owner) return store.resolveMapping(owner);
    const virtual = store.virtualTable(set)?.mapping;
    if (virtual?.entitySet === set) return virtual;
    throw unknownSet(set);
  }

  const navigationOf = (mapping, segment) => mapping.relationships?.[segment] ?? null;
  const isMember = (mapping, name) =>
    name === mapping.idColumn || Boolean(navigationOf(mapping, name)) || Boolean(store.fieldDefinition(mapping.logicalName, name, metadataFields));
  const undeclared = (set, nav) =>
    invalid(
      `Error identified in Payload provided by the user for Entity :'${set}'  ---->  InnerException : Microsoft.OData.ODataException: An undeclared property '${nav}' which only has property annotations in the payload but no property value was found in the payload. In OData, only declared navigation properties and declared named streams can be represented as properties without values`,
      "0x80048d19",
    );
  const onBehalfOf = (c) =>
    c.caller && c.user && refKey(c.caller.systemuserid) !== refKey(c.user.systemuserid)
      ? principals.modifiedBy({ user: c.caller }).modifiedby
      : null;

  // Every key of a write must be a property, the id, a navigation or a nav@odata.bind on one (Dataverse 0x0 / 0x80048d19).
  function assertPayload(mapping, body) {
    for (const key of Object.keys(body)) {
      if (CONTROL.has(key) || (key.includes("@") && !key.endsWith(BIND))) continue;
      if (key.endsWith(BIND)) {
        const nav = key.slice(0, -BIND.length);
        if (!isMember(mapping, nav)) throw undeclared(mapping.entitySet, nav);
        continue;
      }
      if (!isMember(mapping, key)) {
        throw new DataError(
          `An error occurred while validating input parameters: Microsoft.Crm.CrmException: Invalid property '${key}' was found in entity 'Microsoft.Dynamics.CRM.${mapping.logicalName}'. ---> Microsoft.OData.ODataException: Does not support untyped value in non-open type.`,
          400,
          "InvalidRequest",
          { innerCode: "0x0" },
        );
      }
    }
  }

  // $filter, $orderby and $expand roots must name a property (or a navigation for $expand); unknown ones are 0x0.
  function assertQueryMembers(mapping, params) {
    const aliases = Object.fromEntries([...params].filter(([name]) => name.startsWith("@")));
    const filter = params.get("$filter");
    if (filter) {
      for (const [head] of expressionPaths(parseODataExpression(filter, { dialect: "dataverse", aliases }))) {
        if (head && !head.startsWith("@") && !navigationOf(mapping, head)) assertProperty(mapping, head);
      }
    }
    for (const spec of parseOrderBy(params.get("$orderby"))) {
      const head = spec.path[0];
      if (!navigationOf(mapping, head)) assertProperty(mapping, head);
    }
    for (const item of parseExpand(params.get("$expand"))) {
      if (!navigationOf(mapping, item.navigation)) assertProperty(mapping, item.navigation);
    }
  }

  // Formats one row and adds the owner navigation annotation the formatter leaves out.
  function formatRow(c, mapping, row, options) {
    const formatted = c.formatter.formatEntity(row, mapping, options);
    for (const field of OWNER_FIELDS) {
      const key = `_${field}_value`;
      if (formatted[key] != null && formatted[`${key}${NAVIGATION}`] === undefined) formatted[`${key}${NAVIGATION}`] = field;
    }
    return formatted;
  }

  function rowOf(c, mapping, id) {
    return String(id).includes("=") ? (store.findByKey(mapping, id) ?? null) : (store.get(mapping.logicalName, id, c.identity) ?? null);
  }

  // Resolves the addressed row by primary key or alternate key; row is null when absent.
  function lookupKey(c, mapping, text) {
    const parsed = parseKey(text);
    if (!parsed) throw invalid("Invalid argument.");
    if (parsed.id) return { id: parsed.id, text: parsed.id, row: rowOf(c, mapping, parsed.id), alternate: null };
    const row = store.findByKey(mapping, text) ?? null;
    return { id: row ? row[mapping.idColumn] : null, text, row, alternate: parsed.alternate };
  }

  function parentRow(c, mapping, operation) {
    const key = lookupKey(c, mapping, c.route.key);
    if (!key.row) throw notFoundRecord(mapping.logicalName, key.text);
    authorize(c, mapping.logicalName, operation, mapping, key.row);
    return key;
  }

  // Query options for collections: $top yields to maxpagesize, $skiptoken is handled here, the id always rides along.
  function collectionParams(c, mapping) {
    const params = new URLSearchParams(c.url.searchParams);
    params.delete("$skiptoken");
    if (c.prefer.maxPageSize != null) params.delete("$top");
    assertSelect(mapping, params.get("$select"));
    assertQueryMembers(mapping, params);
    const select = withIdSelect(params.get("$select"), mapping.idColumn);
    if (select != null) params.set("$select", select);
    return params;
  }

  // Dataverse answers 400 0x0 for an unknown $select column; the store would project an empty row instead.
  function assertSelect(mapping, text) {
    if (!text) return;
    for (const name of text.split(",").map((part) => part.trim()).filter(Boolean)) assertProperty(mapping, name);
  }

  // Single rows only project $select and $expand (and aliases); filters never apply to a key read.
  function entityParams(c, mapping) {
    const params = new URLSearchParams();
    for (const [name, value] of c.url.searchParams) {
      if (name === "$expand" || name === "$select" || name.startsWith("@")) params.append(name, value);
    }
    assertSelect(mapping, params.get("$select"));
    assertQueryMembers(mapping, params);
    const select = withIdSelect(params.get("$select"), mapping.idColumn);
    if (select != null) params.set("$select", select);
    return params;
  }

  function entityBody(c, mapping, id, params) {
    const result = store.query(mapping.logicalName, params, c.identity, undefined, queryOptions({ id }));
    const projected = result.value[0];
    if (!projected) throw notFoundRecord(mapping.logicalName, id);
    const formatted = formatRow(c, mapping, projected, { etag: true, expand: parseExpand(params.get("$expand")) });
    return { "@odata.context": contextFor(c, `${suffixFor(c, mapping)}/$entity`), ...keepAnnotations(formatted, c.include) };
  }

  // Collection page with Dataverse paging: maxpagesize (cap 5000) or the default page; $skiptoken names the next page.
  function collectionPage(c, mapping, { ids = null, readFilter = null, nextBase = null }) {
    const { url, prefer } = c;
    const pageSize = Math.min(prefer.maxPageSize ?? PAGE_CAP, PAGE_CAP);
    const offset = pageOffset(url, pageSize);
    const params = collectionParams(c, mapping);
    const paging = { params, offset, pageSize, preferenceApplied: null, nextLink: () => null };
    const options = queryOptions({ ...(ids ? { ids } : {}), ...filterOptions(readFilter) });
    const result = ids?.length === 0 ? emptyPage() : store.query(mapping.logicalName, params, c.identity, paging, options);
    const rows = result.value;
    const total = result.paging?.totalCount ?? rows.length;
    const counted = url.searchParams.get("$count") === "true";
    const body = { "@odata.context": contextFor(c, suffixFor(c, mapping)) };
    if (counted) body["@odata.count"] = Math.min(total, PAGE_CAP);
    if (c.include?.(RECORD_COUNT)) body[`@${RECORD_COUNT}`] = counted ? Math.min(total, PAGE_CAP) : -1;
    if (c.include?.(RECORD_LIMIT)) body[`@${RECORD_LIMIT}`] = counted ? total > PAGE_CAP : false;
    const expand = parseExpand(url.searchParams.get("$expand"));
    body.value = rows.map((row) => keepAnnotations(formatRow(c, mapping, row, { etag: true, expand }), c.include));
    if (result.paging?.moreRecords) {
      const idColumn = mapping.idColumn;
      const token = encodeSkipToken({
        pageNumber: offset / pageSize + 2,
        lastId: rows.at(-1)[idColumn],
        firstId: rows[0][idColumn],
        idColumn,
      });
      const base = nextBase ?? `${c.origin}/api/data/${c.version}/${mapping.entitySet}`;
      body["@odata.nextLink"] = nextLinkOf(c, base, token);
    }
    const applied = preferenceApplied(prefer, { paged: true, batch: false });
    return { status: 200, headers: applied ? { "Preference-Applied": applied } : {}, body };
  }

  function applyPage(c, mapping, readFilter) {
    assertQueryMembers(mapping, c.url.searchParams);
    const result = store.query(mapping.logicalName, new URLSearchParams(c.url.searchParams), c.identity, undefined, queryOptions(filterOptions(readFilter)));
    const value = result.value.map((row) => keepAnnotations(formatRow(c, mapping, row, { etag: false }), c.include));
    return { status: 200, body: { "@odata.context": contextFor(c, mapping.entitySet), ...(result["@odata.count"] !== undefined ? { "@odata.count": result["@odata.count"] } : {}), value } };
  }

  function fetchXmlPage(c, mapping, readFilter, xml) {
    const logical = mapping.logicalName;
    const root = /<entity\b[^>]*?\bname\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1];
    if (root !== logical) {
      throw invalid(`The entity set name '${mapping.entitySet}' does not match the FetchXml entity '${root}'.`, "0x80060888");
    }
    const fetched = store.fetchXml(xml, c.identity, {
      metadata: metadataFields,
      backendRowsFilter: readFilter ? (name, row) => name !== logical || readFilter(row) : undefined,
    });
    const info = fetched.columns;
    const columns = (info.columns ?? []).filter((col) => col.alias == null && !col.aliased && !col.aggregate).map((col) => col.attribute);
    if (!info.aggregate && !info.distinct && !columns.includes(mapping.idColumn)) columns.unshift(mapping.idColumn);
    const body = { "@odata.context": contextFor(c, `${mapping.entitySet}(${columns.join(",")})`) };
    body.value = fetched.entities.map((row) => withoutNulls(keepAnnotations(c.formatter.formatFetchRow(row, info), c.include)));
    if (fetched.more_records && c.include?.(MORE_RECORDS)) body[`@${MORE_RECORDS}`] = true;
    if (fetched.more_records && fetched.paging_cookie && c.include?.(PAGING_COOKIE)) {
      body[`@${PAGING_COOKIE}`] = webApiPagingCookie(fetched.paging_cookie, Number(info.page ?? 1));
    }
    return { status: 200, body };
  }

  function collection(c) {
    const { mapping, url } = c;
    authorize(c, mapping.logicalName, "read", mapping);
    const readFilter = filterOf(c, mapping);
    const xml = url.searchParams.get("fetchXml") ?? url.searchParams.get("fetchxml");
    if (xml != null) return fetchXmlPage(c, mapping, readFilter, xml);
    if (url.searchParams.has("$apply")) return applyPage(c, mapping, readFilter);
    return collectionPage(c, mapping, { readFilter });
  }

  function countRecords(c) {
    const { mapping, url } = c;
    authorize(c, mapping.logicalName, "read", mapping);
    const params = new URLSearchParams();
    if (url.searchParams.has("$filter")) params.set("$filter", url.searchParams.get("$filter"));
    params.set("$select", mapping.idColumn);
    assertQueryMembers(mapping, params);
    const result = store.query(mapping.logicalName, params, c.identity, undefined, queryOptions(filterOptions(filterOf(c, mapping))));
    return { status: 200, body: String(Math.min(result.value.length, PAGE_CAP)) };
  }

  function getEntity(c) {
    const { mapping } = c;
    const key = lookupKey(c, mapping, c.route.key);
    if (!key.row) throw notFoundRecord(mapping.logicalName, key.text);
    authorize(c, mapping.logicalName, "read", mapping, key.row);
    const body = entityBody(c, mapping, key.row[mapping.idColumn], entityParams(c, mapping));
    const etag = body["@odata.etag"];
    const match = c.headers["if-none-match"];
    if (etag && match && !c.url.searchParams.has("$expand") && c.include == null && String(match).split(",").map((item) => item.trim()).includes(etag)) {
      return { status: 304, headers: { ETag: etag, "Content-Type": JSON_CONTENT_TYPE, "OData-Version": "4.0" } };
    }
    return { status: 200, headers: etagOf(body), body };
  }

  // Payload as the store receives it: plain columns and nav@odata.bind, every other annotation dropped.
  function payload(mapping, body) {
    assertPayload(mapping, body);
    const data = {};
    for (const [key, value] of Object.entries(body)) if (!key.includes("@") || key.endsWith(BIND)) data[key] = value;
    return data;
  }

  // Owner columns that follow an ownerid bind: the user's or team's business unit, owninguser for users, owningteam for teams.
  function ownerColumns(mapping, target, row) {
    if (ownershipOf(mapping.logicalName, undefined, mapping) !== "user") return {};
    const buId = refIdOf(row.businessunitid);
    const bu = buId ? store.tableRows("businessunit").find((item) => sameId(item.businessunitid, buId)) : null;
    const buRef = bu ? { id: bu.businessunitid, logical_name: "businessunit", name: bu.name ?? "" } : null;
    const columns = target.logicalName === "team"
      ? { owninguser: null, owningteam: { id: row.teamid, logical_name: "team", name: row.name ?? "" }, owningbusinessunit: buRef }
      : { owninguser: principals.ownershipDefaults({ user: { systemuserid: row.systemuserid, businessunitid: buId }, mapping }).owninguser, owningteam: null, owningbusinessunit: buRef };
    return Object.fromEntries(Object.entries(columns).filter(([name]) => store.fieldDefinition(mapping.logicalName, name, metadataFields)));
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
      const row = rowOf(c, target, ref.id);
      if (!row) throw notFoundRecord(target.logicalName, ref.id);
      authorize(c, target.logicalName, "appendto", target, row);
      data[key] = `/${ref.set}(${ref.id})`;
      if (nav === "ownerid") Object.assign(data, ownerColumns(mapping, target, row));
    }
    return data;
  }

  // ponytail: ownership and state defaults only fill columns the mapping declares, so tables without ownerid get no owner column.
  function createData(c, mapping, body) {
    const data = payload(mapping, body);
    const logical = mapping.logicalName;
    const declared = (name) => Boolean(store.fieldDefinition(logical, name, metadataFields));
    authorize(c, logical, "create", mapping);
    if (Object.keys(data).some((key) => key.endsWith(BIND))) authorize(c, logical, "append", mapping);
    bindsOf(c, mapping, data, null);
    // ownershipDefaults wants the business unit as an id; the stored systemuser row keeps it as a lookup.
    const owner = { ...c.user, businessunitid: c.user.businessunitid?.id ?? c.user.businessunitid };
    const defaults = principals.ownershipDefaults({ user: owner, mapping });
    for (const [name, value] of Object.entries(defaults)) {
      if (name in data || `${name}${BIND}` in data) continue;
      if (declared(name)) data[name] = value;
    }
    // A new row is active (statecode 0) with the default status of that state.
    if (!("statecode" in data) && (mapping.stateStatusDefaults || declared("statecode") || declared("statuscode"))) data.statecode = 0;
    if (!("statuscode" in data) && (mapping.stateStatusDefaults || declared("statecode") || declared("statuscode"))) {
      const status = defaultStatus(mapping);
      if (status !== undefined) data.statuscode = status;
    }
    const caller = onBehalfOf(c);
    if (caller && !("createdonbehalfby" in data) && declared("createdonbehalfby")) data.createdonbehalfby = caller;
    return data;
  }

  // The state-0 status: the mapping's own default first, else the first status option whose state is 0.
  function defaultStatus(mapping) {
    const fromMapping = mapping.stateStatusDefaults?.[0];
    if (fromMapping !== undefined) return fromMapping;
    const definition = store.fieldDefinition(mapping.logicalName, "statuscode", metadataFields);
    return (definition?.statuses ?? definition?.options ?? []).find((option) => String(option?.state) === "0")?.value;
  }

  function updateData(c, mapping, body, existing) {
    const data = bindsOf(c, mapping, payload(mapping, body), existing);
    delete data[mapping.idColumn];
    for (const [name, value] of Object.entries(principals.modifiedBy({ user: c.user }))) {
      if (store.fieldDefinition(mapping.logicalName, name, metadataFields)) data[name] = value;
    }
    const caller = onBehalfOf(c);
    if (caller && store.fieldDefinition(mapping.logicalName, "modifiedonbehalfby", metadataFields)) data.modifiedonbehalfby = caller;
    return data;
  }

  // Upsert semantics per If-Match / If-None-Match; runs inside the caller's transaction and returns { created, id }.
  function upsertNow(c, mapping, key, body, { ifMatch, ifNoneMatch }) {
    const logical = mapping.logicalName;
    if (key.row && ifNoneMatch === "*") {
      throw new DataError("A record with matching key values already exists.", 412, "PreconditionFailed", { innerCode: "" });
    }
    if (!key.row && ifMatch != null) throw notFoundRecord(logical, key.text, "");
    if (key.row) {
      authorize(c, logical, "update", mapping, key.row);
      const data = updateData(c, mapping, body, key.row);
      withKeyViolation(mapping, data, () => store.updateRecord(logical, key.row[mapping.idColumn], data, c.identity, writeOptions({ ifMatch, ifNoneMatch })));
      return { created: false, id: key.row[mapping.idColumn] };
    }
    const data = createData(c, mapping, body);
    if (key.alternate) Object.assign(data, key.alternate);
    else data[mapping.idColumn] = key.id;
    const row = withKeyViolation(mapping, data, () => store.createRecord(logical, data, c.identity, writeOptions({ ifNoneMatch })));
    return { created: true, id: row[mapping.idColumn] };
  }

  async function createEntity(c) {
    const { mapping } = c;
    const body = bodyOf(mapping.entitySet, c.body);
    const row = await runWrite(() => {
      const data = createData(c, mapping, body);
      return withKeyViolation(mapping, data, () =>
        store.createRecord(mapping.logicalName, data, c.identity, writeOptions({ ifNoneMatch: c.headers["if-none-match"] })),
      );
    });
    const id = row[mapping.idColumn];
    // 204 names the new row in OData-EntityId; a 201 representation carries the row itself.
    if (!c.prefer.representation) return { status: 204, headers: { "OData-EntityId": entityUrl(c.origin, c.version, mapping.entitySet, id) } };
    const represented = entityBody(c, mapping, id, entityParams(c, mapping));
    return { status: 201, headers: { ...etagOf(represented), "Preference-Applied": "return=representation" }, body: represented };
  }

  async function patchEntity(c) {
    const { mapping } = c;
    const body = bodyOf(mapping.entitySet, c.body);
    const key = lookupKey(c, mapping, c.route.key);
    const outcome = await runWrite(() =>
      upsertNow(c, mapping, key, body, { ifMatch: c.headers["if-match"], ifNoneMatch: c.headers["if-none-match"] }),
    );
    const location = entityUrl(c.origin, c.version, mapping.entitySet, key.alternate ? key.text : outcome.id);
    if (!c.prefer.representation) return { status: 204, headers: { "OData-EntityId": location } };
    const represented = entityBody(c, mapping, outcome.id, entityParams(c, mapping));
    const headers = outcome.created ? {} : { "OData-EntityId": location };
    return { status: outcome.created ? 201 : 200, headers: { ...headers, ...etagOf(represented), "Preference-Applied": "return=representation" }, body: represented };
  }

  async function deleteEntity(c) {
    const { mapping } = c;
    const key = lookupKey(c, mapping, c.route.key);
    if (!key.row) throw notFoundRecord(mapping.logicalName, key.text);
    authorize(c, mapping.logicalName, "delete", mapping, key.row);
    await runWrite(() =>
      store.removeRecord(mapping.logicalName, key.row[mapping.idColumn], c.identity, writeOptions({ ifMatch: c.headers["if-match"] })),
    );
    return { status: 204 };
  }

  // Related rows through a relationship, narrowed by a member key and the caller's row filter.
  function relatedRows(c, mapping, row, rel, segmentKey) {
    const target = store.resolveMapping(rel.entity);
    const readFilter = filterOf(c, target);
    const wanted = segmentKey ? parseKey(segmentKey)?.id : null;
    const rows = store
      .queryContext(c.identity, { metadata: metadataFields })
      .related(row, rel)
      .filter((item) => (!wanted || sameId(item[target.idColumn], wanted)) && (!readFilter || readFilter(item)));
    return { target, rows };
  }

  function getNavigation(c, rel) {
    const { mapping, route } = c;
    const key = parentRow(c, mapping, "read");
    const { target, rows } = relatedRows(c, mapping, key.row, rel, route.segmentKey);
    if (rel.many === false) {
      const [row] = rows;
      return row ? { status: 200, body: entityBody(c, target, row[target.idColumn], entityParams(c, target)) } : { status: 204 };
    }
    const base = `${c.origin}/api/data/${c.version}/${mapping.entitySet}(${route.key})/${route.segment}`;
    return collectionPage(c, target, { ids: rows.map((row) => row[target.idColumn]), nextBase: base });
  }

  // The store does not reject unknown $select columns on the by-id path, so the property name is checked here.
  function assertProperty(mapping, segment) {
    if (segment === mapping.idColumn || store.fieldDefinition(mapping.logicalName, segment, metadataFields)) return;
    throw invalid(`Could not find a property named '${segment}' on type 'Microsoft.Dynamics.CRM.${mapping.logicalName}'.`, "0x0");
  }

  function readProperty(c, mapping, id, segment) {
    assertProperty(mapping, segment);
    const params = new URLSearchParams({ $select: segment });
    const projected = store.query(mapping.logicalName, params, c.identity, undefined, queryOptions({ id })).value[0];
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
    const value = readProperty(c, c.mapping, key.row[c.mapping.idColumn], c.route.segment);
    return value == null ? { status: 204 } : { status: 200, body: String(value) };
  }

  async function writeProperty(c, segment, value) {
    const { mapping } = c;
    const key = parentRow(c, mapping, "update");
    const data = updateData(c, mapping, { [segment]: value }, key.row);
    await runWrite(() => store.updateRecord(mapping.logicalName, key.row[mapping.idColumn], data, c.identity, writeOptions()));
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
    if (rel.many === false) return rows[0] ? { status: 200, body: link(rows[0]) } : { status: 204 };
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
    await change(() => store.associate(mapping.logicalName, parent.row[mapping.idColumn], route.segment, child[target.idColumn], c.identity));
    return { status: 204 };
  }

  async function putRef(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (!rel || rel.many !== false) throw methodNotAllowed(c.method);
    const ref = refOf(bodyOf(mapping.entitySet, c.body)["@odata.id"]);
    const parent = parentRow(c, mapping, "update");
    const data = updateData(c, mapping, { [`${route.segment}${BIND}`]: `/${ref.set}(${ref.id})` }, parent.row);
    await runWrite(() => store.updateRecord(mapping.logicalName, parent.row[mapping.idColumn], data, c.identity, writeOptions()));
    return { status: 204 };
  }

  async function deleteRef(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (!rel) throw noResource(c);
    if (rel.many === false) {
      const parent = parentRow(c, mapping, "update");
      const data = updateData(c, mapping, { [`${route.segment}${BIND}`]: null }, parent.row);
      await runWrite(() => store.updateRecord(mapping.logicalName, parent.row[mapping.idColumn], data, c.identity, writeOptions()));
      return { status: 204 };
    }
    const parent = parentRow(c, mapping, "appendto");
    const target = store.resolveMapping(rel.entity);
    const childId = route.kind === "navigationRef" ? parseKey(route.targetKey)?.id : refOf(c.url.searchParams.get("$id")).id;
    const child = rowOf(c, target, childId);
    if (!child) throw notFoundRecord(target.logicalName, childId);
    authorize(c, target.logicalName, "append", target, child);
    await change(() => store.disassociate(mapping.logicalName, parent.row[mapping.idColumn], route.segment, child[target.idColumn], c.identity));
    return { status: 204 };
  }

  function targetsOf(c) {
    const targets = c.body?.Targets;
    if (!Array.isArray(targets) || !targets.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      throw invalid("The Targets parameter must be an array of objects.");
    }
    return targets;
  }

  async function boundAction(c) {
    const { mapping, route } = c;
    if (route.key != null) throw noResource(c);
    if (route.name === "CreateMultiple") {
      const targets = targetsOf(c);
      const rows = await runWrite(() =>
        targets.map((target) => {
          const data = createData(c, mapping, target);
          return withKeyViolation(mapping, data, () => store.createRecord(mapping.logicalName, data, c.identity, writeOptions()));
        }),
      );
      return {
        status: 200,
        body: { "@odata.context": contextFor(c, "Microsoft.Dynamics.CRM.CreateMultipleResponse"), Ids: rows.map((row) => row[mapping.idColumn]) },
      };
    }
    if (route.name === "UpdateMultiple" || route.name === "UpsertMultiple") {
      const targets = targetsOf(c);
      await runWrite(() => {
        for (const target of targets) {
          const text = route.name === "UpdateMultiple" ? String(target[mapping.idColumn] ?? "") : refOf(target["@odata.id"]).id;
          const key = lookupKey(c, mapping, text);
          if (route.name === "UpdateMultiple" && !key.row) throw notFoundRecord(mapping.logicalName, key.text);
          upsertNow(c, mapping, key, target, {});
        }
      });
      return { status: 204 };
    }
    if (route.name === "DeleteMultiple") {
      throw new DataError("DeleteMultiple has not yet been implemented.", 501, "NotImplemented", { innerCode: "0x80040216" });
    }
    throw noResource(c);
  }

  const verbs = (c, table) => {
    const run = table[c.method];
    if (!run) throw methodNotAllowed(c.method);
    return run(c);
  };

  function dispatch(c) {
    switch (c.route.kind) {
      case "collection": return verbs(c, { GET: collection, POST: createEntity });
      case "count": return verbs(c, { GET: countRecords });
      case "entity": return verbs(c, { GET: getEntity, PATCH: patchEntity, DELETE: deleteEntity });
      case "property":
      case "member": return verbs(c, { GET: getProperty, PUT: putProperty, DELETE: deleteProperty });
      case "value": return verbs(c, { GET: getValue });
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
          metadata: metadataFields,
          formatting: { ...store.state.settings, currencySymbol: store.state.settings?.currencySymbol ?? "$" },
        }),
      };
      return dispatch(c);
    },
  };
}
