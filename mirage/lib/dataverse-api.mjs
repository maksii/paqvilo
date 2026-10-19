// Dataverse HTTP listeners: STS, discovery, SOAP stub and the Web API router.
// Table rows are delegated to dataverse-records.mjs; metadata to dataverse-metadata.mjs.
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { createAuthority, hashSecret, verifySecret } from "./dataverse-auth.mjs";
import { createPrincipals, ensureSecurityModel, privilegeId, uuidV5 } from "./dataverse-security.mjs";
import { createMetadataService, objectTypeCode as typeCodeOf } from "./dataverse-metadata.mjs";
import {
  JSON_CONTENT_TYPE,
  baseHeaders,
  contextUrl,
  dataverseError,
  orderAnnotations,
  parseDataverseRoute,
  parseFunctionParameters,
  parseKey,
  parsePrefer,
} from "./dataverse-odata.mjs";
import { stringifyExactJson } from "./exact-numeric.mjs";

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
const GLOBAL_DISCO = "https://globaldisco.crm.dynamics.com";
const DATAVERSE_NAMESPACE = uuidV5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "paqvilo-dataverse");
const SYSTEMUSER_TYPE = typeCodeOf("systemuser");
const TENANT = "(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|common|organizations|consumers)";
const STS_PATH = new RegExp(
  `^/(${TENANT})/(oauth2/v2\\.0/token|oauth2/token|oauth2/v2\\.0/authorize|oauth2/authorize|oauth2/v2\\.0/devicecode|oauth2/v2\\.0/logout|v2\\.0/\\.well-known/openid-configuration|\\.well-known/openid-configuration|discovery/v2\\.0/keys|discovery/keys)$`,
  "i",
);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Expose-Headers": "OData-EntityId, ETag, Preference-Applied, x-ms-service-request-id, REQ_ID, Retry-After, x-ms-dop-hint, Location",
};
const SOAP_FAULT =
  '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
  "<faultcode>s:Receiver</faultcode>" +
  "<faultstring>SOAP organization service is not simulated; use the Web API at /api/data/v9.2/.</faultstring>" +
  "</s:Fault></s:Body></s:Envelope>";
const METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]);
const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);
const ROUTER_BOUND = new Set(["RetrieveUserPrivileges", "RetrievePrincipalAccess"]);
const BODY_LIMIT = 8 * 1024 * 1024;
const WINDOW_MS = 300000;
const RING_SIZE = 500;

const refOf = (value) => (value !== null && typeof value === "object" ? value.id : value) ?? undefined;
const asJson = (result) => ({ ...result, headers: { "content-type": "application/json; charset=utf-8", ...(result.headers ?? {}) } });
const envelope = (status, code, message, requestId) => ({
  status,
  headers: { ...baseHeaders(requestId), "Content-Type": JSON_CONTENT_TYPE },
  body: { error: { code, message } },
});
const methodNotAllowed = (c) => envelope(405, "", `The requested resource does not support http method '${c.req.method}'.`, c.requestId);
const notFound = (c) => envelope(404, "", `No HTTP resource was found that matches the request URI '${c.url.href}'.`, c.requestId);
const notImplementedFeature = (feature) => new DataError(`${feature} has not yet been implemented.`, 501, "NotImplemented");
const unauthorized = (verdict) => new DataError("", 401, "Unauthorized", { reason: verdict.reason === "missing" ? "missing" : "invalid_token" });

function originOf(req, fallbackHost) {
  const encrypted = Boolean(req.socket?.encrypted);
  const proto = encrypted ? "https" : "http";
  const defaultPort = encrypted ? 443 : 80;
  const host = String(req.headers.host ?? "");
  if (host && /^[a-z0-9.:[\]-]+$/i.test(host)) return `${proto}://${host.replace(new RegExp(`:${defaultPort}$`), "")}`;
  const port = req.socket?.localPort;
  return `${proto}://${fallbackHost}${port && port !== defaultPort ? `:${port}` : ""}`;
}

const listenerOrigin = (proto, host, port) => `${proto}://${host}${port === (proto === "https" ? 443 : 80) ? "" : `:${port}`}`;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new DataError("Request body is too large.", 413, "PayloadTooLarge");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req) {
  const raw = await readBody(req);
  if (/json/i.test(req.headers["content-type"] ?? "")) {
    try {
      return JSON.parse(raw || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function listParam(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value == null ? [] : [value];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

// Bound references arrive as a JSON object ({"@odata.id": ...}), a JSON string or a bare path.
function referenceOf(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
  }
  return typeof parsed === "string" ? parsed : parsed?.["@odata.id"];
}

function referenceRoute(reference, origin, version) {
  if (typeof reference !== "string") return null;
  const absolute = /^https?:\/\//i.test(reference) ? reference : `${origin}/api/data/${version}/${reference}`;
  try {
    return parseDataverseRoute(new URL(absolute).pathname);
  } catch {
    return null;
  }
}

function remember(requests, entry) {
  requests.push(entry);
  if (requests.length > RING_SIZE) requests.splice(0, requests.length - RING_SIZE);
}

function send(res, result, requestId) {
  const merged = { ...CORS, ...baseHeaders(requestId), ...(result.headers ?? {}) };
  const headers = {};
  for (const [name, value] of Object.entries(merged)) if (value !== undefined && value !== null) headers[name.toLowerCase()] = value;
  let payload;
  const body = result.body;
  if (body !== undefined && body !== null) {
    const text = typeof body === "string";
    payload = text ? body : stringifyExactJson(orderAnnotations(body));
    headers["content-type"] ??= text ? "text/plain; charset=utf-8" : JSON_CONTENT_TYPE;
  }
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.statusCode = result.status ?? 200;
  res.end(payload);
}

function organizationDetail(d, origin) {
  return {
    OrganizationId: d.organizationId,
    FriendlyName: d.settings.friendlyName,
    OrganizationVersion: d.settings.version,
    EnvironmentId: d.environmentId,
    DatacenterId: ZERO_GUID,
    Geo: "NA",
    TenantId: d.tenantId,
    UrlName: d.settings.uniqueName,
    UniqueName: d.settings.uniqueName,
    OrganizationType: "Default",
    SchemaType: "Standard",
    State: "Enabled",
    Endpoints: {
      Count: 3,
      IsReadOnly: false,
      Keys: ["OrganizationService", "OrganizationDataService", "WebApplication"],
      Values: [`${origin}/XRMServices/2011/Organization.svc`, `${origin}/XRMServices/2011/OrganizationData.svc`, `${origin}/`],
    },
  };
}

async function stsRoute(d, c) {
  const { req, url, origin, meta } = c;
  const path = url.pathname;
  if (/^\/common\/discovery\/instance$/i.test(path)) return asJson({ status: 200, body: d.authority.instanceDiscovery(origin) });
  if (/^\/common\/oauth2\/deviceauth$/i.test(path)) return d.authority.handleDeviceVerification({ origin, url, headers: req.headers });
  if (/^\/common\/userrealm\//i.test(path)) return { status: 204 };
  const match = STS_PATH.exec(path);
  if (!match) return null;
  const [, tenantSegment, rest] = match;
  const lower = rest.toLowerCase();
  if (lower.endsWith("keys")) return asJson({ status: 200, body: d.authority.jwks() });
  if (lower.endsWith("openid-configuration")) {
    return asJson({ status: 200, body: d.authority.openIdConfiguration(origin, lower.startsWith("v2.0/") ? "v2.0" : "v1.0") });
  }
  if (lower.endsWith("/token")) {
    const form = await readForm(req);
    meta.grant = typeof form.grant_type === "string" ? form.grant_type : null;
    const version = lower.includes("v2.0") ? "v2.0" : "v1.0";
    return asJson(await d.authority.handleToken({ origin, tenantSegment, form, headers: req.headers, version }));
  }
  if (lower.endsWith("devicecode")) return d.authority.handleDeviceCode({ origin, tenantSegment, url, headers: req.headers });
  if (lower.endsWith("authorize")) return d.authority.handleAuthorize({ origin, tenantSegment, url, headers: req.headers });
  return { status: 204 };
}

function discoveryService(c) {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return methodNotAllowed(c);
  return {
    status: 200,
    body: { "@odata.context": `${c.origin}/api/discovery/v2.0/$metadata`, value: [{ name: "Instances", kind: "EntitySet", url: "Instances" }] },
  };
}

function discoveryInstances(d, c, route) {
  if (c.method !== "GET") return methodNotAllowed(c);
  const { req, origin } = c;
  let verdict = d.authority.verifyBearer(req.headers.authorization, { origin, tenantId: d.tenantId });
  // Discovery callers may present a globaldisco-audience token; verifyBearer also checks the issuer against the origin it is given.
  if (!verdict.ok && verdict.reason !== "missing") verdict = d.authority.verifyBearer(req.headers.authorization, { origin: GLOBAL_DISCO, tenantId: d.tenantId });
  if (!verdict.ok) throw unauthorized(verdict);
  c.meta.appId = verdict.claims.appid ?? null;
  const instance = {
    Id: d.organizationId,
    UniqueName: d.settings.uniqueName,
    UrlName: d.settings.uniqueName,
    FriendlyName: d.settings.friendlyName,
    State: "Enabled",
    Version: d.settings.version,
    Url: origin,
    ApiUrl: origin,
    LastUpdated: new Date(d.clock()).toISOString(),
    Region: "NA",
    OrganizationType: "Default",
    TenantId: d.tenantId,
    EnvironmentId: d.environmentId,
    DatacenterId: ZERO_GUID,
    Geo: "NA",
    Purpose: null,
    StatusMessage: null,
    TrialExpirationDate: "9999-12-31T23:59:59.9999999Z",
    SchemaType: "Standard",
  };
  const key = route.key;
  const wanted = key == null || [instance.Id, instance.UniqueName].some((value) => key.toLowerCase().includes(String(value).toLowerCase()));
  return { status: 200, body: { "@odata.context": `${origin}/api/discovery/v2.0/$metadata#Instances`, value: wanted ? [instance] : [] } };
}

function soap(c) {
  if (c.req.method === "POST") return { status: 500, headers: { "content-type": "text/xml; charset=utf-8" }, body: SOAP_FAULT };
  if (c.req.method === "GET") throw unauthorized({ reason: "missing" });
  return methodNotAllowed(c);
}

function listParamTotals(d, c, route) {
  const params = parseFunctionParameters(route.params, c.url.searchParams);
  const keys = [];
  const values = [];
  for (const name of listParam(params.EntityNames)) {
    let logical;
    try {
      logical = d.store.resolveMapping(String(name)).logicalName;
    } catch {
      throw new DataError("Invalid argument.", 400, "InvalidKey");
    }
    keys.push(logical);
    values.push(d.store.tableRows(logical).length);
  }
  return {
    "@odata.context": contextUrl(c.origin, route.version, "Microsoft.Dynamics.CRM.RetrieveTotalRecordCountResponse"),
    EntityRecordCountCollection: { Count: keys.length, IsReadOnly: false, Keys: keys, Values: values },
  };
}

function unboundFunction(d, c, route, common) {
  if (c.method !== "GET") return notFound(c);
  switch (route.name) {
    case "WhoAmI":
      return {
        status: 200,
        body: {
          "@odata.context": contextUrl(c.origin, route.version, "Microsoft.Dynamics.CRM.WhoAmIResponse"),
          BusinessUnitId: refOf(common.user.businessunitid),
          UserId: common.user.systemuserid,
          OrganizationId: d.organizationId,
        },
      };
    case "RetrieveVersion":
      return { status: 200, body: { Version: d.settings.version } };
    case "RetrieveCurrentOrganization":
      return { status: 200, body: { Detail: organizationDetail(d, c.origin) } };
    case "RetrieveTotalRecordCount":
      return { status: 200, body: listParamTotals(d, c, route) };
    case "RetrieveMetadataChanges":
      throw notImplementedFeature("RetrieveMetadataChanges");
    default:
      return notFound(c);
  }
}

function principalAccess(d, c, route, subjectId, common) {
  const reference = referenceOf(parseFunctionParameters(route.params, c.url.searchParams).Target);
  const target = referenceRoute(reference, c.origin, route.version);
  if (target?.kind !== "entity") throw new DataError("Invalid argument.", 400, "InvalidKey");
  const logical = d.store.resolveMapping(target.set).logicalName;
  const rowId = parseKey(target.key)?.id ?? target.key;
  const row = d.store.get(logical, rowId, common.identity);
  if (!row) throw new DataError(`${logical} With Id = ${rowId} Does Not Exist`, 404, "NotFound", { id: rowId });
  const subject = d.principals.byId(subjectId);
  if (!subject) throw new DataError(`systemuser With Id = ${subjectId} Does Not Exist`, 404, "NotFound", { id: subjectId });
  return {
    status: 200,
    body: {
      "@odata.context": contextUrl(c.origin, route.version, "Microsoft.Dynamics.CRM.RetrievePrincipalAccessResponse"),
      AccessRights: d.principals.principalAccess({ user: subject, entity: logical, row }),
    },
  };
}

function boundFunction(d, c, route, common) {
  if (c.method !== "GET") return notFound(c);
  if (route.set !== "systemusers" || !route.key) throw notImplementedFeature(route.name);
  const subjectId = parseKey(route.key)?.id ?? route.key;
  if (route.name === "RetrieveUserPrivileges") {
    return {
      status: 200,
      body: {
        "@odata.context": contextUrl(c.origin, route.version, "Microsoft.Dynamics.CRM.RetrieveUserPrivilegesResponse"),
        RolePrivileges: d.principals.retrieveUserPrivileges(subjectId),
      },
    };
  }
  if (route.name === "RetrievePrincipalAccess") return principalAccess(d, c, route, subjectId, common);
  throw notImplementedFeature(route.name);
}

// Read-only metadata: EntityDefinitions, RelationshipDefinitions and GlobalOptionSetDefinitions.
function metadataRead(c, metadata, route) {
  const select = c.url.searchParams.get("$select") ?? "";
  const filter = c.url.searchParams.get("$filter") ?? "";
  const expand = c.url.searchParams.get("$expand") ?? "";
  const { set, key, segment, segmentKey, cast } = route;
  const context = (suffix) => contextUrl(c.origin, route.version, suffix);
  const collection = (items, suffix) => ({ status: 200, body: { "@odata.context": context(suffix), value: items } });
  const single = (item, suffix) => ({ status: 200, body: { "@odata.context": context(suffix), ...item } });
  const missing = (segmentName) => {
    throw new DataError(`Resource not found for the segment '${segmentName}'.`, 404, "UnknownEntity", { segment: segmentName });
  };
  const shape = (items) => metadata.filterMetadata(items, filter).map((item) => metadata.selectMetadata(item, select));
  const listed = (items, segmentName) => shape(items ?? missing(segmentName));

  if (set === "GlobalOptionSetDefinitions") {
    if (key == null) return collection(shape(metadata.globalOptionSets()), set);
    const name = /^Name=['"]?([^'")]+)/i.exec(key)?.[1];
    const found = name ? metadata.globalOptionSet(name) : null;
    return found ? single(metadata.selectMetadata(found, select), `${set}/$entity`) : missing(set);
  }
  if (set === "RelationshipDefinitions") {
    if (key == null) return collection(shape(metadata.relationships({ cast })), set);
    const found = metadata.relationship(key);
    return found ? single(metadata.selectMetadata(found, select), `${set}/$entity`) : missing(set);
  }
  if (key == null) {
    let entities = metadata.entities();
    if (expand) entities = entities.map((entity) => metadata.entity(entity.LogicalName, { expand }));
    return collection(shape(entities), select ? `${set}(${select})` : set);
  }
  const entity = metadata.entity(key, { expand });
  if (!entity) return missing(set);
  if (!segment) return single(metadata.selectMetadata(entity, select), `${set}/$entity`);
  const logical = entity.LogicalName;
  switch (segment) {
    case "Attributes": {
      const list = metadata.attributes(key, { cast, key: segmentKey, select, expand }) ?? missing(set);
      if (segmentKey != null) return list[0] ? single(list[0], `${set}/Attributes/$entity`) : missing("Attributes");
      return collection(metadata.filterMetadata(list, filter), `${set}/Attributes`);
    }
    case "Keys":
      return collection(listed(metadata.keys(key), "Keys"), `${set}/Keys`);
    case "OneToManyRelationships":
      return collection(listed(metadata.oneToMany(logical), segment), `${set}/${segment}`);
    case "ManyToOneRelationships":
      return collection(listed(metadata.manyToOne(logical), segment), `${set}/${segment}`);
    case "ManyToManyRelationships":
      return collection(listed(metadata.manyToMany(logical), segment), `${set}/${segment}`);
    default:
      return missing(segment);
  }
}

function metadataCall(d, c, route) {
  if (c.method !== "GET") throw notImplementedFeature("Metadata provisioning");
  return metadataRead(c, d.metadata, route);
}

async function recordCall(d, route, common) {
  const result = await d.recordHandlers.handle({
    method: common.method,
    route,
    url: common.url,
    origin: common.origin,
    version: route.version,
    prefer: common.prefer,
    headers: common.req.headers,
    body: common.body,
    user: common.user,
    caller: common.caller,
    identity: common.identity,
    requestId: common.requestId,
  });
  return result ?? { status: 204 };
}

async function dataApi(d, c, route) {
  const { req, origin, requestId, meta } = c;
  if (route.kind === "unknown") return envelope(404, "", route.message, requestId);
  if (route.kind === "invalid") throw new DataError(route.message, 400, "InvalidRequest");
  if (!METHODS.has(req.method)) return methodNotAllowed(c);

  const verdict = d.authority.verifyBearer(req.headers.authorization, { origin, tenantId: d.tenantId });
  if (!verdict.ok) throw unauthorized(verdict);
  meta.appId = verdict.claims.appid ?? null;
  const resolved = d.principals.resolve(verdict.claims);
  if (!resolved.user) return envelope(401, "0x80072560", "The user is not a member of the organization.", requestId);
  if (resolved.reason === "disabled") {
    return envelope(
      401,
      "0x80040225",
      `The specified user(Id = ${resolved.user.systemuserid}) is disabled. Consider enabling this user. Additional Details: The user is disabled in Dataverse.`,
      requestId,
    );
  }
  const caller = resolved.user;
  meta.userId = caller.systemuserid;

  const limit = d.settings.serviceProtection?.requestsPer300s;
  if (limit) {
    const now = d.clock();
    const recent = (d.throttle.get(caller.systemuserid) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= limit) {
      d.throttle.set(caller.systemuserid, recent);
      throw new DataError(`Number of requests exceeded the limit of ${limit} over time window of 300 seconds.`, 429, "ServiceProtection", { retryAfter: 300 });
    }
    recent.push(now);
    d.throttle.set(caller.systemuserid, recent);
  }

  let user = caller;
  const byObjectId = req.headers.callerobjectid;
  const byId = req.headers.mscrmcallerid;
  if (byObjectId || byId) {
    if (!d.principals.canImpersonate(caller)) {
      const privilege = privilegeId(d.organizationId, "prvActOnBehalfOfAnotherUser");
      return envelope(
        403,
        "0x80040220",
        `Principal user (Id=${caller.systemuserid}, type=${SYSTEMUSER_TYPE}), is missing prvActOnBehalfOfAnotherUser privilege (Id=${privilege})`,
        requestId,
      );
    }
    user = byObjectId ? d.principals.byObjectId(byObjectId) : d.principals.byId(byId);
    if (!user) return envelope(400, "0x80040203", "Invalid argument.", requestId);
  }

  let body;
  if (BODY_METHODS.has(req.method)) {
    const raw = await readBody(req);
    if (raw && /json/i.test(req.headers["content-type"] ?? "")) {
      try {
        body = JSON.parse(raw);
      } catch (error) {
        const set = route.set ?? route.name ?? "";
        throw new DataError(
          `Error identified in Payload provided by the user for Entity :'${set}'  ---->  InnerException : Microsoft.OData.ODataException: ${error.message}`,
          400,
          "InvalidLookup",
        );
      }
    }
  }

  const common = {
    req,
    origin,
    requestId,
    prefer: c.prefer,
    method: c.method,
    url: c.url,
    body,
    user,
    caller,
    identity: {
      admin: true,
      id: user.systemuserid,
      systemUserId: user.systemuserid,
      businessUnitId: refOf(user.businessunitid),
      dataverse: { appId: verdict.claims.appid, accessMode: user.accessmode, callerId: caller.systemuserid },
    },
  };
  switch (route.kind) {
    case "service":
      return c.method === "GET" ? { status: 200, body: d.metadata.serviceDocument(origin, route.version) } : methodNotAllowed(c);
    case "metadata":
      if (c.method !== "GET") return methodNotAllowed(c);
      return d.metadata.csdl();
    case "batch":
      throw notImplementedFeature("$batch");
    case "function":
      return unboundFunction(d, { ...c, origin, version: route.version }, route, common);
    case "boundFunction":
      return boundFunction(d, { ...c, origin, version: route.version }, route, common);
    // Parentheses-less bound calls parse as boundAction; the two router-owned functions accept both spellings.
    case "boundAction":
      if (ROUTER_BOUND.has(route.name)) return boundFunction(d, { ...c, origin, version: route.version }, route, common);
      return recordCall(d, route, common);
    case "metadataEntity":
      return metadataCall(d, c, route);
    default:
      return recordCall(d, route, common);
  }
}

async function route(d, c) {
  const path = c.url.pathname;
  const sts = await stsRoute(d, c);
  if (sts) return sts;
  if (path === "/api/discovery/v2.0" || path === "/api/discovery/v2.0/") return discoveryService(c);
  const parsed = parseDataverseRoute(path);
  if (!parsed) {
    const parts = path.split("/").filter(Boolean);
    throw new DataError(`Resource not found for the segment '${parts[3] ?? parts.at(-1) ?? ""}'.`, 404, "UnknownEntity", { segment: parts[3] ?? parts.at(-1) ?? "" });
  }
  if (parsed.kind === "discovery") return discoveryInstances(d, c, parsed);
  if (parsed.kind === "soap") return soap(c);
  return dataApi(d, c, parsed);
}

export function createDataverseHandler(deps) {
  const d = { ...deps, throttle: new Map(), requests: deps.requests ?? [] };
  const log = deps.log ?? (() => {});
  return async function handle(req, res) {
    const requestId = randomUUID();
    const started = d.clock();
    const origin = originOf(req, d.host);
    const url = new URL(req.url ?? "/", origin);
    const meta = { appId: null, userId: null, grant: null };
    const prefer = parsePrefer(req.headers.prefer);
    const c = { req, url, origin, requestId, meta, prefer, method: req.method === "HEAD" ? "GET" : req.method };
    res.on("finish", () =>
      remember(d.requests, {
        at: started,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: d.clock() - started,
        appId: meta.appId,
        userId: meta.userId,
        grant: meta.grant,
      }),
    );
    let result;
    try {
      result = req.method === "OPTIONS" ? { status: 204 } : await route(d, c);
    } catch (error) {
      result = dataverseError(error, { prefer, requestId, origin, tenantId: d.tenantId, logical: error?.details?.logical });
      log("dataverse request failed", { requestId, path: url.pathname, status: result.status, message: error?.message });
    }
    send(res, result, requestId);
  };
}

function seedRegistrations(store, settings, ids, clock) {
  const dv = (store.state.dataverse ??= {});
  Object.assign(dv, {
    tenantId: ids.tenantId,
    organizationId: ids.organizationId,
    uniqueName: settings.uniqueName,
    friendlyName: settings.friendlyName,
    version: settings.version,
    environmentId: ids.environmentId,
    datacenterId: ZERO_GUID,
    geo: "NA",
  });
  dv.applications ??= [];
  for (const app of settings.applications ?? []) {
    let entry = dv.applications.find((item) => String(item.appId).toLowerCase() === app.appId);
    if (!entry) {
      entry = { appId: app.appId, displayName: app.displayName, createdOn: new Date(clock()).toISOString(), secrets: [], certificates: [], publicClient: false, redirectUris: [] };
      dv.applications.push(entry);
    }
    entry.secrets ??= [];
    const secret = app.secretEnvironmentVariable ? process.env[app.secretEnvironmentVariable] : undefined;
    if (secret && !entry.secrets.some((item) => verifySecret(secret, item))) {
      entry.secrets.push({ id: randomUUID(), ...hashSecret(secret), hint: secret.slice(0, 3), expiresOn: null });
    }
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function startDataverseApi({
  store,
  change = (fn) => fn(),
  settings,
  host = "127.0.0.1",
  schema = () => null,
  metadataFields = () => undefined,
  observed = null,
  clock = () => Date.now(),
  tls = null,
  records = null,
  log = () => {},
}) {
  void observed; // accepted for the documented signature; no router behaviour depends on it yet
  const tenantId = (settings.tenantId ?? uuidV5(DATAVERSE_NAMESPACE, `${settings.uniqueName}:tenant`)).toLowerCase();
  const organizationId = (settings.organizationId ?? uuidV5(DATAVERSE_NAMESPACE, `${settings.uniqueName}:organization`)).toLowerCase();
  const environmentId = `Default-${tenantId}`;
  const applications = settings.applications ?? [];

  await change(() => store.transact(() => seedRegistrations(store, settings, { tenantId, organizationId, environmentId }, clock)));
  await change(() =>
    ensureSecurityModel(
      store,
      {
        organizationId,
        tenantId,
        uniqueName: settings.uniqueName,
        friendlyName: settings.friendlyName,
        version: settings.version,
        applications: applications.map((app) => ({ appId: app.appId, displayName: app.displayName, roles: app.roles ?? [] })),
        users: settings.users ?? [],
      },
      { schema },
    ),
  );

  const principals = createPrincipals(store, { organizationId, tenantId, objectTypeCode: typeCodeOf });
  const metadata = createMetadataService({
    organizationId,
    schema,
    mappings: () => store.state.mappings,
    virtualTables: () => store.virtualTables?.() ?? {},
  });
  const authority = createAuthority({
    tenantId,
    applications: () => store.state.dataverse?.applications ?? [],
    users: { byObjectId: principals.byObjectId, byDomainName: principals.byDomainName, verifyPassword: () => false },
    clock,
  });
  const recordHandlers =
    records ??
    (await import("./dataverse-records.mjs")).createRecordHandlers({ store, change, principals, metadata, metadataFields, objectTypeCode: typeCodeOf, clock });

  const requests = [];
  const handle = createDataverseHandler({
    store,
    settings,
    authority,
    principals,
    metadata,
    recordHandlers,
    tenantId,
    organizationId,
    environmentId,
    host,
    clock,
    log,
    requests,
  });

  const httpServer = http.createServer(handle);
  const servers = [httpServer];
  await listen(httpServer, settings.port ?? 0, host);
  const origin = listenerOrigin("http", host, httpServer.address().port);
  let tlsOrigin = null;
  if (tls) {
    const httpsServer = https.createServer(tls, handle);
    servers.push(httpsServer);
    await listen(httpsServer, settings.tlsPort ?? 0, host);
    tlsOrigin = listenerOrigin("https", host, httpsServer.address().port);
  }

  return {
    origin,
    tlsOrigin,
    authority: `${origin}/${tenantId}`,
    tenantId,
    organizationId,
    servers,
    requests: () => requests.map((entry) => ({ ...entry })),
    close: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      ).then(() => undefined),
    handle,
  };
}
