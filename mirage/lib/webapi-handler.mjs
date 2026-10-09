// Local Power Pages portals Web API (/_api) over the simulator data store.
//
// Routes, system query options, annotations, writes and the error envelope
// follow the Power Pages Web API documentation (power-pages/configure:
// web-api-overview, read-operations, write-update-delete-operations,
// web-api-http-requests-handle-errors) and, where Power Pages passes requests
// through, the Dataverse Web API. docs/dataverse-parity.md lists the evidence
// and the remaining open questions for each behaviour.
import { createHash } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { parseEntityReference, parseKeySegment } from "./data.mjs";
import { parseXmlDocument, planFetch, structuralIntersects, webApiPagingCookie } from "./fetchxml-engine.mjs";
import { prepareODataPage } from "./odata-paging.mjs";
import { parseExpand, parseSelect } from "./odata-query.mjs";
import { createWebApiFormatter } from "./webapi-format.mjs";
import { POWER_PAGES_TABLES, WEBAPI_UNSUPPORTED_TABLES, webApiFetchPolicy, webApiPolicy } from "./webapi-policy.mjs";
import { fieldKind, own } from "./dataverse-values.mjs";
import { siteHeaders } from "./response-headers.mjs";

export const WEBAPI_COUNT_LIMIT = 5000;
const KEY = String.raw`((?:'(?:[^']|'')*'|[^()'/])*)`;
const ROUTE = new RegExp(
  String.raw`^([A-Za-z_]\w*)(?:\(${KEY}\))?(?:/([A-Za-z_]\w*|\$count)(?:\(${KEY}\))?)?(?:/(\$ref|\$value|\$count))?$`,
);
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
// Observed on reference-portal (live parity evidence, 8 October 2026): /_api responses carry no
// OData-Version or Preference-Applied header; cache-control no-cache with Pragma and
// Expires (ASP.NET's no-cache pair); the site's HTTP/* headers as portal pages carry
// them (siteHeaders: the site Content-Security-Policy, X-Frame-Options, ...); and
// X-Content-Type-Options nosniff, which the Web API sends even when the site defines
// no HTTP/X-Content-Type-Options setting (portal pages then send none).
const CACHE_HEADERS = Object.freeze({
  "cache-control": "no-cache",
  pragma: "no-cache",
  expires: "-1",
});
const apiHeaders = (portal) => ({
  "x-content-type-options": "nosniff",
  ...siteHeaders(portal ?? {}),
  ...CACHE_HEADERS,
});
// Errors raised while Power Pages validates OData query options answer
// 400 9004010A with a generic message on reference-portal (unknown columns, invalid
// $filter, $expand or paths through a non-navigation property), as does an
// entity set that names no Dataverse table (reference-site-B, reference-site-A and Example live runs,
// 8 October 2026).
const QUERY_CODES = new Set([
  "InvalidAttribute",
  "UnsupportedQuery",
  "InvalidQuery",
  "MissingRelationship",
  "DuplicateQueryOption",
  "UnknownEntitySet",
  "UnsupportedKeySyntax",
]);
const queryPhase = (error) => {
  if (error && QUERY_CODES.has(error.code) && error.details?.phase == null)
    error.details = { ...(error.details ?? {}), phase: "query" };
  return error;
};

const notFound = (segment) =>
  new DataError(`Resource not found for the segment ${segment}.`, 404, "ResourceNotFound", { segment });
const unknownSet = (segment) =>
  new DataError(`No Dataverse table has the entity set name ${segment}.`, 400, "UnknownEntitySet", {
    segment,
    phase: "query",
  });
const methodNotAllowed = (method, target) =>
  new DataError(`The HTTP method '${method}' is not allowed for ${target}.`, 405, "MethodNotAllowed");
const badRequest = (message, code = "InvalidRequest", innerCode = "0x80040203") =>
  new DataError(message, 400, code, { innerCode });

/** Parse the path after /_api/ into a Web API resource description. */
export function parseWebApiRoute(pathname) {
  let path;
  try {
    path = decodeURIComponent(String(pathname).replace(/^\/_api\//, ""));
  } catch {
    throw badRequest("The request URI is not valid.", "InvalidRoute", "0x0");
  }
  if (/^cloudflow(?:\/|$)/i.test(path)) return { kind: "cloudflow", path };
  const match = ROUTE.exec(path);
  if (!match) throw notFound(path.split(/[/(]/)[0] || path);
  const [, set, rawKey, segment, navigationKey, tail] = match;
  const key = rawKey != null && rawKey.trim() !== "" ? rawKey.trim() : null;
  // The OData v2/v3 key literal guid'…' isn't OData v4 syntax: live sites reject it
  // while parsing the URL, 400 9004010A, before any permission check.
  for (const literal of [key, navigationKey])
    if (literal != null && /^\s*guid'/i.test(literal))
      throw new DataError(`The key ${literal.trim()} uses OData v3 syntax; OData v4 GUID keys are bare.`, 400, "UnsupportedKeySyntax", {
        segment: literal.trim(),
        phase: "query",
      });
  if (key == null) {
    if (segment === "$count" && navigationKey == null && !tail) return { kind: "count", set };
    if (segment == null && !tail) return { kind: "collection", set };
    throw notFound(segment ?? tail);
  }
  if (segment == null) {
    if (tail) throw notFound(tail);
    return { kind: "entity", set, key };
  }
  if (segment === "$count") throw notFound(segment);
  if (navigationKey != null) {
    if (tail === "$ref") return { kind: "ref", set, key, segment, targetKey: navigationKey.trim() };
    throw notFound(tail ?? segment);
  }
  if (tail === "$ref") return { kind: "ref", set, key, segment };
  if (tail === "$value") return { kind: "value", set, key, segment };
  if (tail === "$count") return { kind: "navcount", set, key, segment };
  return { kind: "member", set, key, segment };
}

/** Prefer header: include-annotations value (null when absent) and return=representation. */
export function parsePrefer(header) {
  const text = Array.isArray(header) ? header.join(",") : String(header ?? "");
  const annotations = /(?:^|[,;\s])odata\.include-annotations\s*=\s*(?:"([^"]*)"|([^,;\s"]*))/i.exec(text);
  return {
    annotations: annotations ? (annotations[1] ?? annotations[2] ?? "") : null,
    representation: /(?:^|[,;\s])return\s*=\s*representation(?:$|[,;\s])/i.test(text),
  };
}

/** OData include-annotations matcher: names, namespace.* patterns, * and -exclusions. */
export function annotationMatcher(value) {
  const patterns = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const matches = (pattern, term) => {
    const p = pattern.toLowerCase(),
      t = term.toLowerCase();
    return p === "*" || p === t || (p.endsWith(".*") && t.startsWith(p.slice(0, -1)));
  };
  return (term) =>
    patterns.some((pattern) => !pattern.startsWith("-") && matches(pattern, term)) &&
    !patterns.some((pattern) => pattern.startsWith("-") && matches(pattern.slice(1), term));
}

const stripAnnotations = (value, include) => {
  if (Array.isArray(value)) return value.map((item) => stripAnnotations(item, include));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const at = key.indexOf("@");
    const term = at < 0 ? null : key.slice(at + 1);
    if (term != null && !term.startsWith("odata.") && !include(term)) continue;
    out[key] = item && typeof item === "object" ? stripAnnotations(item, include) : item;
  }
  return out;
};

const siteSetting = (settings, name) => {
  if (!settings) return undefined;
  if (own(settings, name)) return settings[name];
  const key = Object.keys(settings).find((item) => item.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : settings[key];
};
const settingTrue = (settings, name) =>
  String(siteSetting(settings, name) ?? "")
    .trim()
    .toLowerCase() === "true";

const POLICY_CODES = new Set([
  "WebApiFieldNotEnabled",
  "WebApiPrivateField",
  "WebApiColumnPermissionDenied",
  "WebApiFieldsNotConfigured",
  "WebApiColumnsViewUnresolved",
  "WebApiWildcardDeprecated",
]);
const DEFAULT_INNER_CODES = {
  UnsupportedQuery: "0x0",
  InvalidQuery: "0x0",
  DuplicateQueryOption: "0x0",
  MissingRelationship: "0x0",
  QueryParamNotSupported: "0x80060888",
  InvalidPagingToken: "0x80060888",
  NotFound: "0x80040217",
  InvalidLookup: "0x80040217",
  DuplicateRecord: "0x80040237",
  PreconditionFailed: "0x80060882",
  PluginValidation: "0x80040265",
};

// innererror.type of each error code. Observed on two live reference sites with
// innererror on every error (identical on both): 9004010A UnexpectedError,
// 9004010E ConfigurationResourceNotSupported, 9004010C ResourceDoesNotExists and
// 90040120 EntityPermissionReadIsMissing. The others are the documented error names
// (web-api-http-requests-handle-errors: the error code table and the 405 error types).
const ERROR_TYPES = Object.freeze({
  "9004010A": "UnexpectedError",
  "9004010E": "ConfigurationResourceNotSupported",
  "90040120": "EntityPermissionReadIsMissing",
  "900400FF": "NoAttributesForTableCreate",
  "90040100": "InvalidAttribute",
  "90040101": "AttributePermissionIsMissing",
  "90040102": "TablePermissionWriteIsMissingDuringUpdate",
  "90040103": "TablePermissionCreateIsMissing",
  "90040104": "TablePermissionDeleteIsMissing",
  "90040105": "TablePermissionAppendIsMissngDuringAssociationChange",
  "90040106": "TablePermissionAppendToIsMissingDuringAssociationChange",
  "90040107": "HttpAntiForgeryException",
  "90040109": "MissingPortalSessionCookie",
  "9004010C": "ResourceDoesNotExists",
  "9004010D": "CDSError",
  InvalidOperation: "InvalidOperation",
});

/**
 * Map a simulator error to the Power Pages error envelope { error: { code, message } }.
 * With Webapi/error/innererror true, which errors carry innererror is the site's observed
 * behaviour (observed.webApiInnerError):
 * - "dataverse-errors", the default (one observed site sends none with the 9004010A,
 *   90040101, 9004010C, 90040120 and 9004010E errors): Dataverse failures (CDSError,
 *   9004010D) add innererror { code, message } with the Dataverse code and message,
 *   which portal scripts read for plugin messages.
 * - "all-errors" (two observed sites send innererror { code, message, type } with every
 *   error): code and message repeat the outer error, as observed; Dataverse failures,
 *   not yet observed in this mode, keep the Dataverse code and message that portal
 *   scripts read. type comes from ERROR_TYPES, or is null for a code without a name.
 * The observations and their evidence are in docs/dataverse-parity.md.
 * The simulator's own classification travels in the X-Sim-Error-Code response header.
 */
export function webApiErrorResponse(error, { innerError = false, innerErrorScope = "dataverse-errors" } = {}) {
  const status = Number(error?.status ?? error?.statusCode) || 500;
  const internal = error?.code == null ? null : String(error.code);
  const details = error?.details ?? {};
  const headers = internal ? { "X-Sim-Error-Code": internal } : {};
  const everyError = innerErrorScope === "all-errors";
  const respond = (httpStatus, code, message, inner) => {
    const body = { error: { code, message } };
    if (innerError && everyError)
      body.error.innererror = {
        code: inner?.code ?? code,
        message: inner?.message ?? message,
        type: ERROR_TYPES[code] ?? null,
      };
    else if (innerError && inner) body.error.innererror = { code: inner.code, message: inner.message };
    return { status: httpStatus, body, headers };
  };
  const plain = undefined;
  if (details.phase === "query" && QUERY_CODES.has(internal))
    return respond(400, "9004010A", "An unexpected error occurred while processing the request", plain);
  // A write payload the OData reader can't map (an @odata.bind name that isn't a navigation
  // property): the same generic 9004010A as a malformed query (decision, not observed).
  if (details.phase === "payload" && internal === "UndeclaredNavigationProperty")
    return respond(400, "9004010A", "An unexpected error occurred while processing the request", plain);
  if (internal === "WebApiConfigurationTable")
    return respond(404, "9004010E", `Configuration table ${details.table} is not supported.`, plain);
  if (internal === "ResourceNotFound" || internal === "WebApiTableNotEnabled" || internal === "UnknownEntity")
    return respond(404, "9004010C", `Resource not found for the segment ${details.table ?? details.segment ?? ""}.`, plain);
  if (internal === "InvalidAttribute")
    return respond(400, "90040100", `Attribute ${details.attribute} cannot be found for table ${details.table}.`, plain);
  if (POLICY_CODES.has(internal))
    return respond(
      403,
      "90040101",
      details.attribute && details.table
        ? `Attribute ${details.attribute} in table ${details.table} is not enabled for Web Api.`
        : error.message,
      plain,
    );
  if (internal === "PermissionDenied") {
    const operation = String(details.operation ?? "").toLowerCase(),
      table = details.table ?? "";
    if (operation === "create")
      return respond(403, "90040103", `You don't have permission to create ${table} entity.`, plain);
    if (operation === "update" || operation === "write")
      return respond(403, "90040102", `You don't have permission to update ${table} entity.`, plain);
    if (operation === "delete")
      return respond(403, "90040104", `You don't have permission to delete ${table} entity.`, plain);
    if (operation === "append")
      return respond(
        403,
        "90040105",
        `You don't have permission to associate or disassociate table ${table} with ${details.related ?? ""}.`,
        plain,
      );
    if (operation === "appendto")
      return respond(
        403,
        "90040106",
        `You don't have permission to associate or disassociate table ${table} to ${details.related ?? ""}`,
        plain,
      );
    // Read denial (reference-portal): 403 90040120, also for FetchXML link-entity tables.
    return respond(403, "90040120", `You don't have permission to read the ${table} table.`, plain);
  }
  // Learn lists 401 for MissingPortalRequestVerificationToken and MissingPortalSessionCookie
  // (90040109) and gives 90040107 HttpAntiForgeryException no status; Microsoft's clients
  // treat 403 with 90040107 as an expired token and 401 as an expired session. Local tokens
  // aren't bound to a session, so no local path raises MissingPortalSessionCookie.
  if (internal === "MissingPortalRequestVerificationToken") return respond(401, "90040107", error.message, plain);
  if (internal === "HttpAntiForgeryException") return respond(403, "90040107", error.message, plain);
  if (internal === "MissingPortalSessionCookie")
    return respond(401, "90040109", "An Invalid session token was passed into the throwing method.", plain);
  if (internal === "NoAttributesForTableCreate")
    return respond(400, "900400FF", "No attributes for Create Table action.", plain);
  if (internal === "MethodNotAllowed") return respond(405, "InvalidOperation", error.message, plain);
  if (internal === "NotImplemented") return respond(501, "NotImplemented", error.message, plain);
  if (status === 413) return respond(413, "", error.message, plain);
  if (status === 409 && internal === "StateConflict") return respond(409, "", error.message, plain);
  if (status >= 500) return respond(500, "", "An unexpected error occurred while processing the request.", plain);
  // Everything else is Dataverse rejecting the request: CDSError with the
  // platform error code and message in innererror.
  const innerCode = String(details.innerCode ?? DEFAULT_INNER_CODES[internal] ?? "0x80040203");
  return respond(status, "9004010D", "CDS error occurred.", {
    code: innerCode,
    message: error?.message ?? "",
  });
}

/**
 * Handle one /_api request locally. deps: { store, portal, identity, csrf,
 * origin, origins, metadata, json, jsonBody, change, onError }.
 */
export async function handleWebApi(req, res, url, deps) {
  try {
    await route(req, res, url, deps);
  } catch (cause) {
    if (res.headersSent) throw cause;
    const response = webApiErrorResponse(cause, {
      innerError: settingTrue(deps.portal?.settings, "Webapi/error/innererror"),
      innerErrorScope: deps.portal?.observed?.webApiInnerError,
    });
    deps.onError?.(cause, response);
    deps.json(res, response.status, response.body, { ...apiHeaders(deps.portal), ...response.headers });
  }
}

async function route(req, res, url, deps) {
  const method = req.method === "HEAD" ? "GET" : req.method;
  const seen = new Set();
  for (const key of url.searchParams.keys()) {
    if (seen.has(key))
      throw queryPhase(
        badRequest(
          `Query option '${key}' was specified more than once, but it must be specified at most once.`,
          "DuplicateQueryOption",
          "0x0",
        ),
      );
    seen.add(key);
  }
  if (WRITE_METHODS.has(method)) {
    // Token failures (docs/dataverse-parity.md, "Token failures"): no token is Learn's
    // 401 MissingPortalRequestVerificationToken; a token that doesn't match this session's is
    // 90040107 with 403, the status Microsoft's Power Pages clients refresh the token on.
    const supplied = req.headers.__requestverificationtoken;
    if (supplied == null || supplied === "")
      throw new DataError(
        'The required anti-forgery form field "__RequestVerificationToken" is not present.',
        401,
        "MissingPortalRequestVerificationToken",
      );
    if (supplied !== deps.csrf)
      throw new DataError(
        "The anti-forgery cookie token and form field token do not match.",
        403,
        "HttpAntiForgeryException",
      );
  } else if (method !== "GET") throw methodNotAllowed(method, "the portals Web API");
  const target = parseWebApiRoute(url.pathname);
  if (target.kind === "cloudflow")
    throw new DataError(
      `Cloud flow triggers are not run locally; configure a simulator endpoint for ${url.pathname} to answer this request.`,
      501,
      "NotImplemented",
    );
  const t = requestContext(req, res, url, deps, target, method);
  if (method === "GET" && !(target.kind === "collection" && url.searchParams.has("fetchXml")))
    try {
      return await dispatch(t);
    } catch (error) {
      throw queryPhase(error);
    }
  return dispatch(t);
}

function dispatch(t) {
  const { url, target, method } = t;
  switch (target.kind) {
    case "collection":
      if (method === "GET") return url.searchParams.has("fetchXml") ? getFetch(t) : getCollection(t);
      if (method === "POST") return createEntity(t);
      throw methodNotAllowed(method, "an entity set");
    case "count":
      if (method === "GET") return getCount(t);
      throw methodNotAllowed(method, "$count");
    case "entity":
      if (method === "GET") return getEntity(t);
      if (method === "PATCH") return patchEntity(t);
      if (method === "DELETE") return deleteEntity(t);
      throw methodNotAllowed(method, "an entity");
    case "member":
      if (t.mapping.relationships?.[target.segment]) {
        if (method === "GET") return getNavigation(t);
        throw methodNotAllowed(method, "a navigation property; use $ref or @odata.bind");
      }
      if (method === "GET") return getProperty(t, false);
      if (method === "PUT") return putProperty(t);
      if (method === "DELETE") return deleteProperty(t);
      throw methodNotAllowed(method, "a property");
    case "value":
      if (method === "GET") return getProperty(t, true);
      throw methodNotAllowed(method, "$value");
    case "navcount":
      if (method === "GET") return getNavigationCount(t);
      throw methodNotAllowed(method, "$count");
    case "ref":
      return reference(t);
    default:
      throw notFound(target.set);
  }
}

/**
 * Resolve an entity set segment; Web API segments are case-sensitive entity set names.
 * A segment that names no Dataverse table answers 400 9004010A, a known table that
 * isn't enabled 404 9004010C with its logical name (webApiPolicy), as live reference
 * sites answer (docs/dataverse-parity.md). Known tables are the local mappings, data
 * and site tables, and the Power Pages tables every environment has
 * (POWER_PAGES_TABLES).
 */
function resolveSet(store, set) {
  // The entity set name wins over a table whose logical name happens to equal it (a
  // table named x_products doesn't shadow the x_products set of x_product).
  const owner = Object.entries(store.state?.mappings ?? {}).find(([, value]) => value?.entitySet === set);
  if (owner) return store.resolveMapping(owner[0]);
  let mapping = null;
  try {
    mapping = store.resolveMapping(set);
  } catch (error) {
    if (!(error.status === 404 || error.code === "UnknownEntity")) throw error;
  }
  if (mapping?.entitySet === set) return mapping;
  const table = POWER_PAGES_TABLES.get(set);
  if (table)
    throw new DataError(`Resource not found for the segment '${set}'.`, 404, "WebApiTableNotEnabled", {
      segment: set,
      table,
    });
  throw unknownSet(set);
}

/** The 48 portal configuration tables answer 404 9004010E (reference-portal), mapped or not. */
function configurationTable(store, set) {
  try {
    const logical = store.resolveMapping(set).logicalName;
    if (WEBAPI_UNSUPPORTED_TABLES.has(logical)) return logical;
  } catch {
    // Unmapped: fall back to the entity set spelling below.
  }
  if (WEBAPI_UNSUPPORTED_TABLES.has(set)) return set;
  for (const suffix of ["es", "s"])
    if (set.endsWith(suffix) && WEBAPI_UNSUPPORTED_TABLES.has(set.slice(0, -suffix.length)))
      return set.slice(0, -suffix.length);
  return null;
}

function requestContext(req, res, url, deps, target, method) {
  const { store } = deps;
  const configuration = configurationTable(store, target.set);
  if (configuration)
    throw new DataError(`Configuration table ${configuration} is not supported.`, 404, "WebApiConfigurationTable", {
      table: configuration,
    });
  const mapping = resolveSet(store, target.set);
  const policy = webApiPolicy(deps.portal, store, mapping.logicalName);
  const prefer = parsePrefer(req.headers.prefer);
  const include = prefer.annotations == null ? null : annotationMatcher(prefer.annotations);
  const settings = store.state.settings ?? {};
  const formatter = createWebApiFormatter({
    store,
    identity: deps.identity,
    metadata: deps.metadata,
    formatting: {
      timeZoneOffsetMinutes: Number(settings.timeZoneOffsetMinutes ?? 0),
      dateFormat: settings.dateFormat,
      timeFormat: settings.timeFormat,
      dateTimeFormat: settings.dateTimeFormat,
      currencySymbol: settings.currencySymbol,
    },
  });
  return { req, res, url, deps, store, target, method, mapping, policy, prefer, include, formatter };
}

// ---- response helpers -------------------------------------------------------

const send = (t, status, body, headers = {}) =>
  t.deps.json(t.res, status, status === 204 ? null : t.include ? stripAnnotations(body, t.include) : body, {
    ...apiHeaders(t.deps.portal),
    ...headers,
  });
const sendText = (t, value) => {
  t.res.writeHead(200, { "content-type": "text/plain; charset=utf-8", ...apiHeaders(t.deps.portal) });
  t.res.end(String(value));
};
const metadataVersions = new WeakMap();
/**
 * @Microsoft.Dynamics.CRM.globalmetadataversion: Dataverse publishes an
 * opaque numeric string that changes with metadata. Locally it is a stable
 * number derived from the table mappings (synthetic, never a live value).
 */
function globalMetadataVersion(store) {
  const mappings = store.state.mappings ?? {};
  if (!metadataVersions.has(mappings)) {
    const digest = createHash("sha256").update(JSON.stringify(mappings)).digest("hex");
    metadataVersions.set(mappings, String(parseInt(digest.slice(0, 8), 16)));
  }
  return metadataVersions.get(mappings);
}
/** OData context URL: $metadata#set(select,nav(select)) as reference-portal publishes it. */
function contextUrl(t, mapping, params, { entity = false } = {}) {
  const describe = (select, expand) => {
    const parts = [...(select ?? [])];
    for (const spec of expand ?? [])
      parts.push(`${spec.navigation}(${describe(parseSelect(spec.select), spec.expand ?? []).join(",")})`);
    return parts;
  };
  const parts = params ? describe(parseSelect(params.get("$select")), parseExpand(params.get("$expand"))) : [];
  return `${t.deps.origin}/_api/$metadata#${mapping.entitySet}${parts.length ? `(${parts.join(",")})` : ""}${entity ? "/$entity" : ""}`;
}
const sendNoContent = (t, headers = {}) => send(t, 204, null, headers);
const pick = (params, names) => {
  const out = new URLSearchParams();
  for (const [key, value] of params)
    if (names.includes(key) || key.startsWith("@")) out.set(key, value);
  return out;
};
const queryOptions = (t, extra = {}) => ({
  dialect: "dataverse",
  metadata: t.deps.metadata,
  includeKeys: true,
  ...extra,
});
const entityLocation = (t, mapping, id) => `${t.deps.origin}/_api/${mapping.entitySet}(${id})`;
const recordNotFound = (mapping, key) =>
  new DataError(`${mapping.logicalName} With Id = ${key} Does Not Exist`, 404, "NotFound", {
    innerCode: "0x80040217",
  });

/** Explicitly allow-listed columns a select-less read returns, null when unset. */
function fillDeclaredColumns(t, out, policy, mapping) {
  for (const name of policy.fields) {
    if (name === "*") continue;
    const lookupName = /^_(.+)_value$/.exec(name);
    const physical = lookupName ? lookupName[1] : name;
    const rel = mapping.relationships?.[physical];
    // Navigation names aren't properties unless they name the lookup column itself.
    if ((rel && !(rel.many === false && rel.from === physical)) || physical === mapping.idColumn) continue;
    const definition = t.store.fieldDefinition(mapping.logicalName, physical, t.deps.metadata);
    if (!definition) continue;
    const lookup =
      lookupName ||
      fieldKind(definition) === "lookup" ||
      Object.values(mapping.relationships ?? {}).some((rel) => rel.many === false && rel.from === physical);
    const key = lookup ? `_${physical}_value` : physical;
    if (own(out, key) || own(out, physical) || !policy.allowed(key)) continue;
    out[key] = null;
  }
  return out;
}

function shapeEntity(t, policy, mapping, projected, { fill = false, expand = null } = {}) {
  const formatted = t.formatter.formatEntity(projected, mapping, { etag: true, expand: parseExpand(expand) });
  if (fill) fillDeclaredColumns(t, formatted, policy, mapping);
  return policy.project(formatted);
}

/** Resolve a key segment (primary key or alternate key) to a stored primary key. */
function locate(t, mapping, key) {
  const text = String(key).trim();
  if (text.includes("=")) {
    const row = t.store.findByKey(mapping, text);
    return { id: row ? row[mapping.idColumn] : null, alternate: parseKeySegment(text) };
  }
  return {
    id: text.replace(/^'(.*)'$/s, (_all, value) => value.replace(/''/g, "'")).replace(/^\{(.*)\}$/, "$1"),
    alternate: null,
  };
}

const readRecord = (t, mapping, id, key) => {
  if (id == null) throw recordNotFound(mapping, key);
  const row = t.store.get(mapping.logicalName, id, t.deps.identity);
  if (!row) throw recordNotFound(mapping, key);
  return row;
};

// ---- reads -----------------------------------------------------------------

function collectionBody(t, mapping, params, result, value, paging) {
  // reference-portal collections always carry the context and the CRM count annotations
  // (totalrecordcount is -1 without $count), with or without a Prefer header.
  const body = { "@odata.context": contextUrl(t, mapping, params) };
  const count = result["@odata.count"];
  if (count !== undefined) body["@odata.count"] = count;
  const total = result.paging?.totalCount ?? count;
  body["@Microsoft.Dynamics.CRM.totalrecordcount"] = count === undefined ? -1 : Math.min(total, WEBAPI_COUNT_LIMIT);
  body["@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"] = count !== undefined && total > WEBAPI_COUNT_LIMIT;
  body["@Microsoft.Dynamics.CRM.globalmetadataversion"] = globalMetadataVersion(t.store);
  body.value = value;
  if (paging && result.paging?.moreRecords) body["@odata.nextLink"] = paging.nextLink(result.paging.nextOffset);
  return body;
}

/** Web API property name of a table column: lookups read as _x_value. */
function propertyName(mapping, name, definition) {
  if (/^_.+_value$/.test(name)) return name;
  const lookup =
    fieldKind(definition) === "lookup" ||
    Object.values(mapping.relationships ?? {}).some((rel) => rel.many === false && rel.from === name);
  return lookup ? `_${name}_value` : name;
}
/**
 * reference-portal answers a select-less collection read with 403 90040101 naming the
 * first column (in property-name order) outside Webapi/<table>/fields; only
 * a wildcard list returns every column.
 */
function assertSelectLessRead(t, policy, mapping) {
  if (policy.fields.includes("*")) return;
  const columns = new Set();
  for (const [name, definition] of Object.entries(t.store.fieldDefinitions(mapping.logicalName, t.deps.metadata)))
    if (!definition?.attributeOf) columns.add(propertyName(mapping, name, definition));
  for (const row of t.store.tableRows(mapping.logicalName))
    for (const [name, value] of Object.entries(row))
      if (!/^__sim/i.test(name) && !name.includes("@"))
        columns.add(
          value && typeof value === "object" && own(value, "id") && own(value, "logical_name")
            ? `_${name}_value`
            : propertyName(mapping, name, t.store.fieldDefinition(mapping.logicalName, name, t.deps.metadata)),
        );
  columns.delete(mapping.idColumn);
  const denied = [...columns].sort().find((column) => !policy.allowed(column));
  if (denied)
    throw new DataError(`Attribute ${denied} in table ${mapping.logicalName} is not enabled for Web Api.`, 403, "WebApiFieldNotEnabled", {
      attribute: denied,
      table: mapping.logicalName,
    });
}

/**
 * Every table an $expand reads needs read permission. reference-portal answers an expansion of a
 * related table that the caller can't read with 403 90040120 naming that table, not with
 * an empty expansion, as it does for FetchXML link-entities. That holds even on a site
 * whose export sets Webapi/SkipRelatedTablePermissions. Rows of a readable related
 * table that the caller's scopes exclude are still left out of the expansion.
 */
function assertExpandReadable(t, mapping, expand, specs = parseExpand(expand)) {
  const { store, deps } = t;
  if (deps.identity?.admin || store.state.settings?.permissionMode === "permissive") return;
  const visit = (owner, specs) => {
    for (const spec of specs) {
      const rel = owner.relationships?.[spec.navigation];
      if (!rel) continue;
      const target = store.resolveMapping(rel.entity);
      if (!store.rules(target.logicalName, "read", deps.identity).length)
        throw new DataError(`Table permission denies read on ${target.logicalName}`, 403, "PermissionDenied", {
          operation: "read",
          table: target.logicalName,
        });
      visit(target, spec.expand ?? []);
    }
  };
  visit(mapping, specs);
}

function getCollection(t, { mapping = t.mapping, policy = t.policy, ids } = {}) {
  const { url, store, deps } = t;
  policy.assertQuery(url.searchParams);
  const apply = url.searchParams.has("$apply");
  // Table permission is checked before the select-less column rule.
  if (!deps.identity?.admin && store.state.settings?.permissionMode !== "permissive" && !store.rules(mapping.logicalName, "read", deps.identity).length)
    throw new DataError(`Table permission denies read on ${mapping.logicalName}`, 403, "PermissionDenied", {
      operation: "read",
      table: mapping.logicalName,
    });
  if (!apply) assertExpandReadable(t, mapping, url.searchParams.get("$expand"));
  if (!apply && !url.searchParams.has("$select")) assertSelectLessRead(t, policy, mapping);
  const paging = prepareODataPage({
    url,
    prefer: t.req.headers.prefer ?? "",
    identity: deps.identity,
    revision: store.dataRevision(),
    secret: deps.csrf,
  });
  const result = store.query(mapping.logicalName, paging.params, deps.identity, paging, queryOptions(t, ids ? { ids } : {}));
  const value = apply
    ? result.value.map((row) => t.formatter.formatEntity(row, mapping, { etag: false }))
    : result.value.map((row) => shapeEntity(t, policy, mapping, row, { expand: url.searchParams.get("$expand") }));
  return send(t, 200, collectionBody(t, mapping, apply ? null : url.searchParams, result, value, apply ? null : paging));
}

/**
 * Tables a FetchXML query reads, which each need read permission: the root and every
 * link-entity, in document order. A structural many-to-many traversal of an intersect
 * (structuralIntersects) reads no intersect table of its own; the tables it joins are
 * still checked, as the engine checks them.
 */
function fetchTables(store, xml) {
  const plan = planFetch(parseXmlDocument(xml, { root: "fetch" }), { profile: "webapi" });
  const mappingOf = new Map([[plan.root, store.resolveMapping(plan.root.attrs.name)]]);
  for (const link of plan.links) mappingOf.set(link, store.resolveMapping(link.attrs.name));
  const structural = structuralIntersects(plan, mappingOf);
  const read = [plan.root, ...plan.links.filter((link) => !structural.has(link))];
  return [...new Set(read.map((node) => mappingOf.get(node).logicalName))];
}

/**
 * FetchXML context as Dataverse builds it: root attributes in document order,
 * lookups as _x_value,x, followed by x() for each lookup. The primary key
 * leads when the query doesn't select it.
 */
function fetchContext(t, mapping, info) {
  const columns = info.columns.filter((column) => column.alias == null && !column.aliased && !column.aggregate);
  const parts = [],
    lookups = [];
  if (!info.aggregate && !info.distinct && !columns.some((column) => column.attribute === mapping.idColumn))
    parts.push(mapping.idColumn);
  for (const column of columns) {
    const definition = t.store.fieldDefinition(mapping.logicalName, column.attribute, t.deps.metadata);
    const name = propertyName(mapping, column.attribute, definition);
    if (name !== column.attribute) {
      parts.push(name, column.attribute);
      lookups.push(`${column.attribute}()`);
    } else parts.push(name);
  }
  return `${t.deps.origin}/_api/$metadata#${mapping.entitySet}(${[...parts, ...lookups].join(",")})`;
}

function getFetch(t) {
  const { url, store, deps, mapping } = t;
  const xml = url.searchParams.get("fetchXml");
  const project = webApiFetchPolicy(deps.portal, store, xml, mapping.logicalName);
  // reference-portal: 403 90040120 when any table the query reads (root or link-entity)
  // has no read permission for the caller, instead of silently empty joins.
  if (!deps.identity?.admin && store.state.settings?.permissionMode !== "permissive")
    for (const logical of fetchTables(store, xml))
      if (!store.rules(logical, "read", deps.identity).length)
        throw new DataError(`Table permission denies read on ${logical}`, 403, "PermissionDenied", {
          operation: "read",
          table: logical,
        });
  const counted = url.searchParams.get("$count") === "true";
  const fetched = store.fetchXml(xml, deps.identity, {
    profile: "webapi",
    metadata: deps.metadata,
    returnTotal: counted,
  });
  const info = fetched.columns;
  const body = { "@odata.context": fetchContext(t, mapping, info) };
  if (counted) body["@odata.count"] = Math.max(fetched.total_record_count, 0);
  body["@Microsoft.Dynamics.CRM.totalrecordcount"] = fetched.total_record_count;
  body["@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"] = fetched.total_record_count_limit_exceeded;
  body["@Microsoft.Dynamics.CRM.globalmetadataversion"] = globalMetadataVersion(store);
  // The final page carries neither morerecords nor the paging cookie
  // (fetchxml/page-results; observed on reference-portal).
  if (fetched.more_records) {
    body["@Microsoft.Dynamics.CRM.morerecords"] = true;
    if (fetched.paging_cookie)
      body["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"] = webApiPagingCookie(fetched.paging_cookie, Number(info.page ?? 1));
  }
  body.value = fetched.entities.map((row) => project(t.formatter.formatFetchRow(row, info)));
  return send(t, 200, body);
}

function getCount(t) {
  const { url, store, deps, mapping, policy } = t;
  const params = pick(url.searchParams, ["$filter"]);
  policy.assertQuery(params);
  params.set("$select", mapping.idColumn);
  const result = store.query(mapping.logicalName, params, deps.identity, undefined, queryOptions(t));
  return sendText(t, Math.min(result.value.length, WEBAPI_COUNT_LIMIT));
}

function entityResponse(t, mapping, policy, id, params) {
  const result = t.store.query(mapping.logicalName, params, t.deps.identity, undefined, queryOptions(t, { id }));
  const projected = result.value[0];
  if (!projected) throw recordNotFound(mapping, id);
  return {
    "@odata.context": contextUrl(t, mapping, params, { entity: true }),
    ...shapeEntity(t, policy, mapping, projected, { fill: !params.has("$select"), expand: params.get("$expand") }),
  };
}

function getEntity(t) {
  const { url, mapping, policy, target } = t;
  // Every supplied option is column-checked, even ones a single entity ignores.
  policy.assertQuery(url.searchParams);
  const params = pick(url.searchParams, ["$select", "$expand"]);
  const { id } = locate(t, mapping, target.key);
  readRecord(t, mapping, id, target.key);
  assertExpandReadable(t, mapping, params.get("$expand"));
  const body = entityResponse(t, mapping, policy, id, params);
  const match = t.req.headers["if-none-match"];
  if (match && body["@odata.etag"] && String(match).split(",").map((item) => item.trim()).includes(body["@odata.etag"])) {
    t.res.writeHead(304, { ...apiHeaders(t.deps.portal), ETag: body["@odata.etag"] });
    return t.res.end();
  }
  return send(t, 200, body);
}

function navigationTarget(t) {
  const rel = t.mapping.relationships[t.target.segment];
  t.policy.assertPath([t.target.segment]);
  const targetMapping = t.store.resolveMapping(rel.entity);
  const targetPolicy = webApiPolicy(t.deps.portal, t.store, targetMapping.logicalName);
  const { id } = locate(t, t.mapping, t.target.key);
  const parent = readRecord(t, t.mapping, id, t.target.key);
  const related = t.store
    .queryContext(t.deps.identity, { metadata: t.deps.metadata })
    .related(parent, rel)
    .map((row) => row[targetMapping.idColumn]);
  return { rel, targetMapping, targetPolicy, related };
}

function getNavigation(t) {
  const { rel, targetMapping, targetPolicy, related } = navigationTarget(t);
  if (rel.many !== false)
    return getCollection(t, { mapping: targetMapping, policy: targetPolicy, ids: related });
  const params = pick(t.url.searchParams, ["$select", "$expand"]);
  targetPolicy.assertQuery(params);
  // The related table needs read permission, as for $expand and collection navigations.
  assertExpandReadable(t, t.mapping, null, [{ navigation: t.target.segment, expand: parseExpand(params.get("$expand")) }]);
  if (!related.length) return sendNoContent(t);
  return send(t, 200, entityResponse(t, targetMapping, targetPolicy, related[0], params));
}

function getNavigationCount(t) {
  if (!t.mapping.relationships?.[t.target.segment]) throw notFound(t.target.segment);
  const { rel, related } = navigationTarget(t);
  if (rel.many === false) throw notFound("$count");
  return sendText(t, Math.min(related.length, WEBAPI_COUNT_LIMIT));
}

function getProperty(t, raw) {
  const { mapping, policy, target } = t;
  if (mapping.relationships?.[target.segment]) throw notFound(raw ? "$value" : target.segment);
  policy.assert(target.segment);
  const { id } = locate(t, mapping, target.key);
  readRecord(t, mapping, id, target.key);
  const params = new URLSearchParams({ $select: target.segment });
  const result = t.store.query(mapping.logicalName, params, t.deps.identity, undefined, queryOptions(t, { id }));
  const formatted = t.formatter.formatEntity(result.value[0] ?? {}, mapping, { etag: false });
  const lookup = /^_(.+)_value$/.test(target.segment) ? target.segment : `_${target.segment}_value`;
  const value = own(formatted, target.segment) ? formatted[target.segment] : formatted[lookup];
  if (value == null) return sendNoContent(t);
  if (raw) return sendText(t, value);
  return send(t, 200, { value });
}

// ---- writes ----------------------------------------------------------------

async function readBody(t) {
  const body = await t.deps.jsonBody(t.req);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw badRequest("The request body must be a JSON object.", "InvalidRequest", "0x0");
  return body;
}

/** @odata.bind and @odata.id references must stay on this portal (or its live origin). */
function checkReferenceOrigin(t, value, name) {
  const reference = parseEntityReference(value);
  if (!reference) throw new DataError(`Invalid entity reference in ${name}.`, 400, "InvalidLookup", { innerCode: "0x80040203" });
  if (reference.origin && !t.deps.origins.includes(reference.origin))
    throw new DataError(`Entity references in ${name} must use this portal origin.`, 400, "InvalidLookup", {
      innerCode: "0x80040203",
    });
  return reference;
}
function assertBindOrigins(t, body) {
  for (const [key, value] of Object.entries(body ?? {})) {
    if (key.endsWith("@odata.bind")) {
      for (const item of Array.isArray(value) ? value : [value]) if (item != null) checkReferenceOrigin(t, item, key);
    } else if (value && typeof value === "object")
      for (const item of Array.isArray(value) ? value : [value])
        if (item && typeof item === "object" && !Array.isArray(item)) assertBindOrigins(t, item);
  }
}
const writeOptions = (t, extra = {}) => ({
  coerce: true,
  metadata: t.deps.metadata,
  ifMatch: t.req.headers["if-match"],
  ifNoneMatch: t.req.headers["if-none-match"],
  ...extra,
});

/**
 * Prefer: return=representation is validated before anything is written: the
 * $select/$expand columns, read permission on the table and on every expanded table.
 * The body is then read inside the write's own store transaction, so a row the caller
 * still can't read (outside its read scope) rolls the write back with 403 90040120
 * instead of answering an error after a committed change.
 */
function representationParams(t, mapping) {
  if (!t.prefer.representation) return null;
  const { store, deps } = t;
  const params = pick(t.url.searchParams, ["$select", "$expand"]);
  t.policy.assertQuery(params);
  if (!deps.identity?.admin && store.state.settings?.permissionMode !== "permissive" && !store.rules(mapping.logicalName, "read", deps.identity).length)
    throw new DataError(`Table permission denies read on ${mapping.logicalName}`, 403, "PermissionDenied", {
      operation: "read",
      table: mapping.logicalName,
    });
  assertExpandReadable(t, mapping, params.get("$expand"));
  return params;
}
function representationBody(t, mapping, id, params) {
  try {
    return entityResponse(t, mapping, t.policy, id, params);
  } catch (error) {
    if (error?.code !== "NotFound") throw error;
    throw new DataError(`Table permission denies read on ${mapping.logicalName}`, 403, "PermissionDenied", {
      operation: "read",
      table: mapping.logicalName,
    });
  }
}
/** Run a write and, when requested, read its representation in one store transaction. */
function writeAndRepresent(t, mapping, params, write) {
  return t.deps.change(() =>
    t.store.transact(() => {
      const outcome = write();
      const row = outcome.row ?? outcome;
      const id = row[mapping.idColumn];
      return { outcome, id, body: params ? representationBody(t, mapping, id, params) : null };
    }),
  );
}

async function createEntity(t) {
  const { mapping, policy, store, deps } = t;
  const body = await readBody(t);
  if (!Object.keys(body).length) throw new DataError("No attributes for Create Table action.", 400, "NoAttributesForTableCreate");
  assertBindOrigins(t, body);
  const prepared = policy.prepareWrite(body, "create");
  const params = representationParams(t, mapping);
  const { id, body: represented } = await writeAndRepresent(t, mapping, params, () =>
    store.createRecord(mapping.logicalName, prepared, deps.identity, writeOptions(t)),
  );
  const headers = { "OData-EntityId": entityLocation(t, mapping, id), entityid: String(id) };
  if (params) return send(t, 201, represented, headers);
  return sendNoContent(t, headers);
}

async function patchEntity(t) {
  const { mapping, policy, store, deps, target } = t;
  const body = await readBody(t);
  assertBindOrigins(t, body);
  const located = locate(t, mapping, target.key);
  const exists = located.id != null && Boolean(store.findByKey(mapping, String(located.id)));
  const options = writeOptions(t);
  if (!exists && options.ifMatch != null) throw recordNotFound(mapping, target.key);
  let write;
  if (exists) {
    const prepared = policy.prepareWrite(body, "update");
    write = () => store.upsertRecord(mapping.logicalName, located.id, prepared, deps.identity, options);
  } else {
    // Upsert creates the record with the addressed primary or alternate key.
    const keyed = { ...body, ...(located.alternate ?? {}) };
    const prepared = policy.prepareWrite(keyed, "create");
    write = located.alternate
      ? () => ({ created: true, row: store.createRecord(mapping.logicalName, prepared, deps.identity, options) })
      : () => store.upsertRecord(mapping.logicalName, located.id, prepared, deps.identity, options);
  }
  const params = representationParams(t, mapping);
  const { outcome, id, body: represented } = await writeAndRepresent(t, mapping, params, write);
  const headers = { "OData-EntityId": entityLocation(t, mapping, id) };
  if (params) return send(t, outcome.created ? 201 : 200, represented, headers);
  return sendNoContent(t, headers);
}

async function deleteEntity(t) {
  const { mapping, store, deps, target } = t;
  const { id } = locate(t, mapping, target.key);
  if (id == null) throw recordNotFound(mapping, target.key);
  await deps.change(() => store.remove(mapping.logicalName, id, deps.identity, writeOptions(t)));
  return sendNoContent(t);
}

async function putProperty(t) {
  const { mapping, policy, store, deps, target } = t;
  const body = await readBody(t);
  if (!own(body, "value")) throw badRequest("A property value is required: { \"value\": ... }.", "InvalidRequest", "0x0");
  const { id } = locate(t, mapping, target.key);
  if (id == null) throw recordNotFound(mapping, target.key);
  const prepared = policy.prepareWrite({ [target.segment]: body.value }, "update");
  await deps.change(() => store.update(mapping.logicalName, id, prepared, deps.identity, writeOptions(t)));
  return sendNoContent(t);
}

async function deleteProperty(t) {
  const { mapping, policy, store, deps, target } = t;
  const { id } = locate(t, mapping, target.key);
  if (id == null) throw recordNotFound(mapping, target.key);
  const prepared = policy.prepareWrite({ [target.segment]: null }, "update");
  await deps.change(() => store.update(mapping.logicalName, id, prepared, deps.identity, writeOptions(t)));
  return sendNoContent(t);
}

/** $ref: POST/DELETE on collection-valued, PUT/DELETE on single-valued navigation properties. */
async function reference(t) {
  const { mapping, policy, store, deps, target, method } = t;
  const navigation = target.segment;
  if (!["POST", "PUT", "DELETE"].includes(method)) throw methodNotAllowed(method, "$ref");
  policy.assertWrite({ [`${navigation}@odata.bind`]: null }, "update");
  const rel = mapping.relationships?.[navigation];
  if (!rel) throw new DataError(`Relationship ${navigation} is not mapped for ${mapping.logicalName}.`, 400, "MissingRelationship");
  const targetMapping = store.resolveMapping(rel.entity);
  const { id } = locate(t, mapping, target.key);
  if (id == null) throw recordNotFound(mapping, target.key);
  const single = rel.many === false;
  const referenced = (value, name) => {
    if (typeof value !== "string") throw badRequest(`A target ${name} is required.`, "InvalidLookup");
    const ref = checkReferenceOrigin(t, value, name);
    let referencedMapping;
    try {
      referencedMapping = resolveSet(store, ref.set);
    } catch {
      throw badRequest(`Relationship target ${ref.set} is not a mapped entity set.`, "InvalidLookup");
    }
    if (referencedMapping.logicalName !== targetMapping.logicalName)
      throw badRequest("Relationship target entity does not match its mapping.", "InvalidLookup");
    return { set: ref.set, id: locate(t, targetMapping, ref.id).id };
  };
  if (method === "POST") {
    if (single || target.targetKey != null)
      throw methodNotAllowed(method, "a single-valued navigation property; use PUT");
    const body = await readBody(t);
    const { id: targetId } = referenced(body["@odata.id"], "@odata.id");
    await deps.change(() => store.associate(mapping.logicalName, id, navigation, targetId, deps.identity));
    return sendNoContent(t);
  }
  if (method === "PUT") {
    if (!single || target.targetKey != null)
      throw methodNotAllowed(method, "a collection-valued navigation property; use POST");
    const body = await readBody(t);
    const ref = referenced(body["@odata.id"], "@odata.id");
    const prepared = policy.prepareWrite({ [`${navigation}@odata.bind`]: `/${ref.set}(${ref.id})` }, "update");
    await deps.change(() => store.update(mapping.logicalName, id, prepared, deps.identity, writeOptions(t, { coerce: false })));
    return sendNoContent(t);
  }
  if (single) {
    if (target.targetKey != null || t.url.searchParams.has("$id")) throw badRequest("A single-valued navigation reference is removed without $id.", "InvalidLookup", "0x0");
    const prepared = policy.prepareWrite({ [`${navigation}@odata.bind`]: null }, "update");
    await deps.change(() => store.update(mapping.logicalName, id, prepared, deps.identity, writeOptions(t, { coerce: false })));
    return sendNoContent(t);
  }
  const targetId =
    target.targetKey != null
      ? locate(t, targetMapping, target.targetKey).id
      : referenced(t.url.searchParams.get("$id") ?? undefined, "$id").id;
  await deps.change(() => store.disassociate(mapping.logicalName, id, navigation, targetId, deps.identity));
  return sendNoContent(t);
}
