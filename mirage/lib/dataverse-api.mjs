import {dataverseHttpReaderContext} from './dataverse-scalar-reader.mjs';
// Dataverse HTTP listeners: STS, discovery, SOAP and the Web API router.
// Table rows are delegated to dataverse-records.mjs; metadata to dataverse-metadata.mjs.
// Order in the router: managed identity, STS, Prefer, extension routes (bearer first), discovery, SOAP, then the Web API.
import http from "node:http";
import { encodeDataverseText } from "./dataverse-text-value.mjs";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { ownsChange, runOwned, runAtomic } from "./dataverse-transaction-context.mjs";
import { createRequestContext, currentRequest, runWithRequest } from "./request-context.mjs";
export { runAtomic } from "./dataverse-transaction-context.mjs";
import { createOrganizationRuntime } from "./dataverse-organization.mjs";
export { dataverseOrganizationId } from "./dataverse-organization.mjs";
import { createModelDrivenRecordService } from './dataverse-model-driven.mjs';
import { organizationPrincipalContext } from './dataverse-principal-context.mjs';
import { gzipSync } from "node:zlib";
import { DataError } from "./data-error.mjs";
import { createAuthority, verifySecret } from "./dataverse-auth.mjs";
import { executeBatch, parseBatch } from "./dataverse-batch.mjs";
import { grantAccess, modifyAccess, parseAccessMask, privilegeId, revokeAccess, syncGroupMembership, uuidV5 } from "./dataverse-security.mjs";
import { objectTypeCode as typeCodeOf } from "./dataverse-metadata.mjs";
import { EXTENSIONS } from "./dataverse-extensions.mjs";
import { runInBackground } from "./dataverse-async.mjs";
import { AUDIT_ACTION, writeAudit } from "./dataverse-audit.mjs";
import { createServiceProtection } from "./dataverse-limits.mjs";
import { createDiscovery } from "./dataverse-discovery.mjs";
import { handleSoap } from "./dataverse-soap.mjs";
import { startDataverseTds } from "./dataverse-tds.mjs";
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
  preferMalformedResponse,
  preferenceApplied,
} from "./dataverse-odata.mjs";
import { parseExactJson, stringifyExactJson } from "./exact-numeric.mjs";

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
const GLOBAL_DISCO = "https://globaldisco.crm.dynamics.com";
const SYSTEMUSER_TYPE = typeCodeOf("systemuser");
const TENANT = "(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|common|organizations|consumers)";
const STS_PATH = new RegExp(
  `^/(${TENANT})/(oauth2/v2\\.0/token|oauth2/token|oauth2/v2\\.0/authorize|oauth2/authorize|oauth2/v2\\.0/devicecode|oauth2/v2\\.0/logout|v2\\.0/\\.well-known/openid-configuration|\\.well-known/openid-configuration|discovery/v2\\.0/keys|discovery/keys)$`,
  "i",
);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  // Explicit names first: the Fetch spec does not let "*" cover Authorization.
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Prefer, If-Match, If-None-Match, OData-Version, OData-MaxVersion, MSCRMCallerID, CallerObjectId, *",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Expose-Headers": "OData-EntityId, ETag, Preference-Applied, x-ms-service-request-id, REQ_ID, Retry-After, x-ms-dop-hint, Location",
};
// The SOAP endpoint with or without /web (SDKClientVersion is a query parameter and never part of the pathname).
const SOAP_ROUTE = /^\/XRMServices\/2011\/Organization\.svc(?:\/web)?\/?$/i;
// Global Discovery Instances and $metadata under any vN.N (the service document is matched before this).
const DISCOVERY_ROUTE = /^\/api\/discovery\/v\d+\.\d+\/(?:\$metadata|Instances(?:\(.*\))?)\/?$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]);
const ODATA_VERSIONS = new Set(["4.0", "4.01"]);
const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);
const ROUTER_BOUND = new Set(["RetrieveUserPrivileges", "RetrievePrincipalAccess"]);
const SHARE_ACTIONS = { GrantAccess: grantAccess, ModifyAccess: modifyAccess, RevokeAccess: revokeAccess };
// The audit action each share change writes (Action option set: Share 14, Modify Share 48, Unshare 49).
const SHARE_AUDIT = { GrantAccess: AUDIT_ACTION.share, ModifyAccess: AUDIT_ACTION.modifyShare, RevokeAccess: AUDIT_ACTION.unshare };
const CRM_TYPE = /^Microsoft\.Dynamics\.CRM\.([A-Za-z_]\w*)$/;
// Dataverse's request message limit (128 MB); a larger body answers 413 0x8004418a.
const BODY_LIMIT = 128 * 1024 * 1024;
// prvBypassCustomPlugins and prvBypassCustomBusinessLogic are distinct privileges, both held by System Administrator only
// (dataverse-security.mjs), so this role check matches exactly the holders of either.
const BYPASS_ROLES = new Set(["System Administrator"]);
const GUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RING_SIZE = 500;
// Header block limit for both listeners; a URL up to MAX_URL_LENGTH must fit in it.
const MAX_HEADER_SIZE = 65536;
const MAX_URL_LENGTH = 32768;
const PLAIN_INVALID_URL = "Bad Request - Invalid URL";
// The other MSCRM headers (SuppressDuplicateDetection, SolutionUniqueName, MergeLabels) and Consistency are accepted no-ops:
// the simulator has no duplicate detection, solution layers or consistency levels.
// Names a browser or client may use for the listeners: the TLS certificate's subjectAltNames and the listener's own host.
const TLS_HOST_NAMES = ["localhost", "127.0.0.1", "[::1]"];
// Record writes made while a $batch runs share the batch's change slot: the server's queue is not re-entrant.

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

// The Host header becomes the origin that tokens carry (iss/aud) and CORS allows any origin, so a page reaching the
// simulator under another name (DNS rebinding, a cross-site fetch by IP) must not get a token or data.
const allowedHostNames = (listenerHost) => new Set([...TLS_HOST_NAMES, String(listenerHost).includes(":") ? `[${listenerHost}]` : String(listenerHost)].map((name) => name.toLowerCase()));
function hostAllowed(value, names) {
  try {
    return names.has(new URL(`http://${value}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// The received bytes, unchanged; callers decode only the bodies they parse as text.
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new DataError("Request message length is too large.", 413, "PayloadTooLarge", { innerCode: "0x8004418a" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readForm(req) {
  const raw = (await readBody(req)).toString("utf8");
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

// CORS headers answer cross-origin callers only: an Origin other than this server's own, and every preflight.
const wantsCors = (req, origin) =>
  req.headers.origin !== undefined &&
  (String(req.headers.origin).toLowerCase() !== origin.toLowerCase() ||
    (req.method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined));
const acceptsGzip = (req) => /gzip/i.test(String(req.headers["accept-encoding"] ?? ""));

// Every write to res happens here; a throw (for example ERR_INVALID_CHAR from a header value) is the caller's to answer.
// The fallback answer passes no options: no CORS and no gzip.
function send(res, result, requestId, clientRequestId, { cors = false, gzip = false } = {}) {
  const merged = {
    ...(cors ? CORS : {}),
    ...baseHeaders(requestId),
    ...(clientRequestId ? { "x-ms-client-request-id": clientRequestId } : {}),
    ...(result.headers ?? {}),
  };
  const headers = {};
  for (const [name, value] of Object.entries(merged)) if (value !== undefined && value !== null) headers[name.toLowerCase()] = value;
  let payload;
  const body = result.body;
  if (body !== undefined && body !== null) {
    const text = typeof body === "string";
    const binary = Buffer.isBuffer(body);
    payload = text || binary ? body : stringifyExactJson(orderAnnotations(body));
    headers["content-type"] ??= text ? "text/plain" : binary ? "application/octet-stream" : JSON_CONTENT_TYPE;
  }
  const status = result.status ?? 200;
  if (status === 304) delete headers['odata-version'];
  // observed: parity cases, every native 200 that is not an octet-stream download is gzipped when the caller accepts it.
  if (status === 200 && gzip && payload !== undefined && headers["content-type"] !== "application/octet-stream") {
    payload = gzipSync(payload);
    headers["content-encoding"] = "gzip";
    headers.vary = "Accept-Encoding";
  }
  // Every native success carries nosniff; errors get it from dataverseError, which knows the engine-versus-route split.
  if (status < 400) headers["x-content-type-options"] ??= "nosniff";
  // Every native 204 (image and file ones included) is answered as an empty text/html response.
  if (status === 204) headers["content-type"] ??= "text/html; charset=utf-8";
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.statusCode = status;
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

// Sign-in pages are HTML; everything else the authority returns is JSON.
const stsReply = (result) =>
  typeof result.body === "string" ? { ...result, headers: { "content-type": "text/html; charset=utf-8", ...(result.headers ?? {}) } } : asJson(result);

async function stsRoute(d, c) {
  const { req, url, origin, meta } = c;
  const path = url.pathname;
  if (/^\/common\/discovery\/instance$/i.test(path)) return asJson({ status: 200, body: d.authority.instanceDiscovery(origin) });
  if (/^\/common\/oauth2\/deviceauth$/i.test(path)) {
    const verification = { origin, url, query: Object.fromEntries(url.searchParams), form: await readForm(req), method: req.method };
    return stsReply(d.authority.handleDeviceVerification(verification));
  }
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
  if (lower.endsWith("devicecode")) return d.authority.handleDeviceCode({ origin, tenantSegment, form: await readForm(req) });
  if (lower.endsWith("authorize")) {
    const request = { origin, tenantSegment, url, query: Object.fromEntries(url.searchParams), form: await readForm(req), method: req.method };
    return stsReply(d.authority.handleAuthorize(request));
  }
  return { status: 204 };
}

function discoveryService(c) {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return methodNotAllowed(c);
  return {
    status: 200,
    body: { "@odata.context": `${c.origin}/api/discovery/v2.0/$metadata`, value: [{ name: "Instances", kind: "EntitySet", url: "Instances" }] },
  };
}

// The caller's Global Discovery instance; State is Int32 (0 = Enabled) as the discovery CSDL types it.
const discoveryInstance = (d, origin) => ({
  Id: d.organizationId,
  UniqueName: d.settings.uniqueName,
  UrlName: d.settings.uniqueName,
  FriendlyName: d.settings.friendlyName,
  State: 0,
  Version: d.settings.version,
  Url: origin,
  ApiUrl: origin,
  LastUpdated: new Date(d.clock()).toISOString(),
  Region: "NA",
  TenantId: d.tenantId,
  EnvironmentId: d.environmentId,
  DatacenterId: ZERO_GUID,
  TrialExpirationDate: "9999-12-31T23:59:59.9999999Z",
  SchemaType: "Standard",
});

// Instances needs a bearer (a globaldisco-audience token is accepted too); $metadata is public. The pure handler does the rest.
function discoveryCall(d, c) {
  if (c.method !== "GET") return methodNotAllowed(c);
  const { req, origin } = c;
  if (!/\$metadata\/?$/.test(c.url.pathname)) {
    let verdict = d.authority.verifyBearer(req.headers.authorization, { origin, tenantId: d.tenantId });
    // verifyBearer also checks the issuer against the origin it is given, so a discovery token needs the global origin.
    if (!verdict.ok && verdict.reason !== "missing") verdict = d.authority.verifyBearer(req.headers.authorization, { origin: GLOBAL_DISCO, tenantId: d.tenantId });
    if (!verdict.ok) throw unauthorized(verdict);
    c.meta.appId = verdict.claims.appid ?? null;
  }
  return createDiscovery({ instance: () => discoveryInstance(d, origin) }).handle({ pathname: c.url.pathname, searchParams: c.url.searchParams, origin });
}

function soap(c) {
  if (c.req.method === "GET") throw unauthorized({ reason: "missing" });
  return methodNotAllowed(c);
}

// SOAP POST: the bearer check first, then handleSoap (which answers its own faults). A 401 names the authority and resource for SOAP clients.
async function soapCall(d, c) {
  if (c.method !== "POST") return soap(c);
  try {
    return await authenticated(d, c, ({ user, caller, identity, bodyBuffer }) =>
      handleSoap({ method: c.method, headers: c.req.headers, bodyBuffer, user, caller, identity, origin: c.origin, version: "v9.2", requestId: c.requestId }, d.api),
    );
  } catch (error) {
    if (error?.code !== "Unauthorized") throw error;
    const result = dataverseError(error, { origin: c.origin, tenantId: d.tenantId, requestId: c.requestId });
    result.headers["WWW-Authenticate"] = `Bearer authorization_uri="${c.origin}/${d.tenantId}", resource_id="${c.origin}"`;
    return result;
  }
}

function listParamTotals(d, c, route, common) {
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
    d.principals.authorize({ user: common.user, entity: logical, operation: "read" });
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
      return {
        status: 200,
        body: { "@odata.context": contextUrl(c.origin, route.version, "Microsoft.Dynamics.CRM.RetrieveVersionResponse"), Version: d.settings.version },
      };
    case "RetrieveCurrentOrganization":
      return {
        status: 200,
        body: {
          "@odata.context": contextUrl(c.origin, route.version, "Microsoft.Dynamics.CRM.RetrieveCurrentOrganizationResponse"),
          Detail: organizationDetail(d, c.origin),
        },
      };
    case "RetrieveTotalRecordCount":
      return { status: 200, body: listParamTotals(d, c, route, common) };
    case "RetrieveMetadataChanges":
      return { status: 200, body: metadataChanges(d, c, route) };
    // Not a function: the name is read as an entity set (empty parentheses included), so an unknown one is the segment error.
    default:
      return recordCall(d, { version: route.version, kind: "collection", set: route.name }, common);
  }
}

// RetrieveMetadataChanges(Query=@p1, ClientVersionStamp=@p2, DeletedMetadataFilters=@p3).
function metadataChanges(d, c, route) {
  const params = parseFunctionParameters(route.params, c.url.searchParams);
  const changes = d.metadata.retrieveMetadataChanges(params.Query ?? null, {
    clientVersionStamp: params.ClientVersionStamp ?? null,
    deletedMetadataFilters: params.DeletedMetadataFilters ?? null,
  });
  return { "@odata.context": contextUrl(c.origin, route.version, "Microsoft.Dynamics.CRM.RetrieveMetadataChangesResponse"), ...changes };
}

function principalAccess(d, c, route, subjectId, common) {
  const reference = referenceOf(parseFunctionParameters(route.params, c.url.searchParams).Target);
  const target = referenceRoute(reference, c.origin, route.version);
  if (target?.kind !== "entity") throw new DataError("Invalid argument.", 400, "InvalidKey");
  const logical = d.store.resolveMapping(target.set).logicalName;
  const rowId = parseKey(target.key)?.id ?? target.key;
  const row = d.store.get(logical, rowId, common.identity);
  if (!row) throw new DataError(`${logical} With Id = ${rowId} Does Not Exist`, 404, "NotFound", { id: rowId });
  let AccessRights;
  if (route.set === "systemusers") {
    const subject = d.principals.byId(subjectId);
    if (!subject) throw new DataError(`systemuser With Id = ${subjectId} Does Not Exist`, 404, "NotFound", { id: subjectId });
    AccessRights = d.principals.principalAccess({ user: subject, entity: logical, row });
  } else if (route.set === "teams") {
    const team = d.store.get("team", subjectId, common.identity);
    if (!team) throw new DataError(`team With Id = ${subjectId} Does Not Exist`, 404, "NotFound", { id: subjectId });
    AccessRights = d.principals.teamAccess({ team, entity: logical, row });
  } else {
    AccessRights = d.principals.organizationAccess({ entity: logical });
  }
  return {
    status: 200,
    body: {
      "@odata.context": contextUrl(c.origin, route.version, "Microsoft.Dynamics.CRM.RetrievePrincipalAccessResponse"),
      AccessRights,
    },
  };
}

function boundFunction(d, c, route, common) {
  if (c.method !== "GET") return notFound(c);
  // RetrievePrincipalAccess is bound to systemuser, team and organization; RetrieveUserPrivileges to systemuser only.
  const subjectSets = route.name === "RetrievePrincipalAccess" ? ["systemusers", "teams", "organizations"] : ["systemusers"];
  // A function is not bound to any other type, so the segment resolves to no resource (no 501 on a native path).
  if (!subjectSets.includes(route.set) || !route.key) return notFound(c);
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
  return principalAccess(d, c, route, subjectId, common);
}

const invalidArgument = () => new DataError("Invalid argument.", 400, "InvalidKey");

// Action parameter entity: { "<idattribute>": "<guid>", "@odata.type": "Microsoft.Dynamics.CRM.<logical>" }.
function entityParameter(d, value) {
  const logical = CRM_TYPE.exec(String(value?.["@odata.type"] ?? ""))?.[1];
  if (!logical) throw invalidArgument();
  let mapping;
  try {
    mapping = d.store.resolveMapping(logical);
  } catch {
    throw invalidArgument();
  }
  // ownerid is the primary key of systemuser and team as well (EntityType inheritance), so it is accepted for those two.
  const raw = value[mapping.idColumn] ?? (["systemuser", "team"].includes(mapping.logicalName) ? value.ownerid : undefined);
  const id = parseKey(raw)?.id;
  if (!id) throw invalidArgument();
  return { logical: mapping.logicalName, mapping, id };
}

// GrantAccess / ModifyAccess / RevokeAccess: the caller needs Share on the target; the principal is a systemuser or team.
async function shareAction(d, c, route, common) {
  const body = common.body ?? {};
  const target = entityParameter(d, body.Target);
  const row = d.store.get(target.logical, target.id, common.identity);
  if (!row) throw new DataError(`${target.logical} With Id = ${target.id} Does Not Exist`, 404, "NotFound", { id: target.id });
  // Sharing needs Read on the row as well as Share (security-access-rights, dependencies between access rights).
  d.principals.authorize({ user: common.user, entity: target.logical, operation: "read", row, mapping: target.mapping });
  d.principals.authorize({ user: common.user, entity: target.logical, operation: "share", row, mapping: target.mapping });
  const principal = entityParameter(d, route.name === "RevokeAccess" ? body.Revokee : body.PrincipalAccess?.Principal);
  if (!["systemuser", "team"].includes(principal.logical) || !d.store.get(principal.logical, principal.id, common.identity)) throw invalidArgument();
  const share = { target: { logical: target.logical, id: target.id }, principal: { id: principal.id, logical_name: principal.logical } };
  if (route.name !== "RevokeAccess") share.mask = parseAccessMask(body.PrincipalAccess?.AccessMask);
  // The audit row joins the share's transaction, so a rolled-back share takes its row with it.
  const run = async () => {
    await SHARE_ACTIONS[route.name](d.store, share);
    await writeAudit(d.api, { entity: target.logical, id: target.id, action: SHARE_AUDIT[route.name], identity: common.identity });
  };
  // Inside a $batch the batch already holds the change slot (see ownsChange); a nested change call would wait on itself.
  await (ownsChange() ? run() : d.change(run));
  return { status: 204 };
}

// $expand names without their nested options: "OptionSet($select=Options)" becomes "OptionSet".
function expandNames(text) {
  let flat = String(text ?? "");
  for (let previous = null; previous !== flat; ) {
    previous = flat;
    flat = flat.replace(/\([^()]*\)/g, "");
  }
  return flat.split(",").map((name) => name.trim()).filter(Boolean);
}

// Read-only metadata: EntityDefinitions, RelationshipDefinitions and GlobalOptionSetDefinitions.
function metadataRead(c, metadata, route) {
  const select = c.url.searchParams.get("$select") ?? "";
  const filter = c.url.searchParams.get("$filter") ?? "";
  const expand = expandNames(c.url.searchParams.get("$expand"));
  const { set, key, segment, segmentKey, cast } = route;
  const context = (suffix) => contextUrl(c.origin, route.version, suffix);
  const collection = (items, suffix) => ({ status: 200, body: { "@odata.context": context(suffix), value: items } });
  const single = (item, suffix) => ({ status: 200, body: { "@odata.context": context(suffix), ...item } });
  const missing = (segmentName) => {
    throw new DataError(`Resource not found for the segment '${segmentName}'.`, 404, "UnknownEntity", { segment: segmentName, route: true });
  };
  const shape = (items) => metadata.filterMetadata(items, filter).map((item) => metadata.selectMetadata(item, select));
  const listed = (items, segmentName) => shape(items ?? missing(segmentName));
  // Native writes the key as requested without its LogicalName= name, and the $select inside the set's parentheses.
  const keyedContext = (path, key) => `${path}(${key.replace(/^LogicalName=/i, "")})`;
  const selectContext = (select) => (select ? `(${select})` : "");

  if (set === "GlobalOptionSetDefinitions") {
    if (c.url.searchParams.has("$filter")) throw new DataError("The $filter query option is not supported for GlobalOptionSetDefinitions.", 400, "InvalidRequest");
    if (key == null) return collection(shape(metadata.globalOptionSets()), set);
    const name = /^Name=['"]?([^'")]+)/i.exec(key)?.[1];
    const found = name ? metadata.globalOptionSet(name) : null;
    // observed: parity case metadata.choices (the option set is typed OptionSetMetadata).
    return found ? single(metadata.selectMetadata(found, select), `${set}/Microsoft.Dynamics.CRM.OptionSetMetadata/$entity`) : missing(set);
  }
  if (set === "RelationshipDefinitions") {
    if (key == null) return collection(shape(metadata.relationships({ cast })), set);
    const found = metadata.relationship(key, { cast });
    return found ? single(metadata.selectMetadata(found, select), `${set}/$entity`) : missing(set);
  }
  if (key == null) {
    let entities = metadata.entities();
    if (expand.length) entities = entities.map((entity) => metadata.entity(entity.LogicalName, { expand }));
    return collection(shape(entities), select ? `${set}(${select})` : set);
  }
  const entity = metadata.entity(key, { expand });
  if (!entity && set === "EntityDefinitions" && !segment) {
    // Native names the metadata id it looked for, under 0x80060888 (not the segment error).
    throw new DataError(`EntityMetadata With Id = ${key} does not exist.`, 404, "NotFound", { httpStatus: 404, innerCode: "0x80060888" });
  }
  if (!entity) return missing(set);
  if (!segment) {
    // observed: parity cases metadata.table and metadata.relationships ($expand navigations are written as name()).
    const names = [...(select ? [select] : []), ...expand.map((name) => `${name}()`)];
    return single(metadata.selectMetadata(entity, select), `${names.length ? `${set}(${names.join(",")})` : set}/$entity`);
  }
  const logical = entity.LogicalName;
  // EntityDefinitions(k)/Attributes(k2)/Microsoft.Dynamics.CRM.X/OptionSet (or GlobalOptionSet) → OptionSetMetadata.
  if (route.subSegment) {
    const option = metadata.attributeOptionSet(key, segmentKey, { global: route.subSegment === "GlobalOptionSet", select });
    return option ? single(option, `${set}/Attributes/${route.subSegment}/$entity`) : missing(route.subSegment);
  }
  switch (segment) {
    case "Attributes": {
      const list = metadata.attributes(key, { cast, key: segmentKey, select, expand }) ?? missing(set);
      if (segmentKey != null) return list[0] ? single(list[0], `${set}/Attributes/$entity`) : missing("Attributes");
      // observed: parity cases metadata.attributes and metadata.typed-string (the cast is a typed attribute collection).
      return collection(metadata.filterMetadata(list, filter), keyedContext(set, key) + `/Attributes${cast ? `/Microsoft.Dynamics.CRM.${cast}` : ""}${selectContext(select)}`);
    }
    case "Keys":
      // observed: parity case metadata.keys.
      return collection(listed(metadata.keys(key, { select }), "Keys"), keyedContext(set, key) + `/Keys${selectContext(select)}`);
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
  // A metadata write is an extension route (dataverse-metadata-tables.mjs, -relationships.mjs), at top level and inside a $batch;
  // a verb no route takes is the Web API's 405.
  if (c.method !== "GET") return methodNotAllowed(c);
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
    bypassCustomPlugins: common.bypassCustomPlugins === true,
    dataverseHttpReader: dataverseHttpReaderContext({method:common.method,route,headers:common.req.headers,bodyBuffer:common.bodyBuffer}),
  });
  return result ?? { status: 204 };
}

// Full privilege-denied text, as the security module words it for entity access (without the entity clause).
function privilegeDenied(d, user, name) {
  const id = user.systemuserid;
  const roleCount = d.principals.roles(user).length;
  const privilegeCount = d.principals.privileges(user).size;
  return new DataError(
    `Principal user (Id=${id}, type=${SYSTEMUSER_TYPE}, roleCount=${roleCount}, privilegeCount=${privilegeCount}, accessMode=${user.accessmode ?? 0}), is missing ${name} privilege (Id=${privilegeId(d.organizationId, name)}). context.Caller=${id}. Consider adding missing privilege to one of the principal (user/team) roles for the request to succeed.`,
    403,
    "PermissionDenied",
    { innerCode: "0x80040220" },
  );
}

const disabledEnvelope = (user, requestId) =>
  envelope(
    401,
    "0x80040225",
    `The specified user(Id = ${user.systemuserid}) is disabled. Consider enabling this user. Additional Details: The user is disabled in Dataverse.`,
    requestId,
  );

const INVALID_CALLER = "CallerId provided for impersonation is invalid. Provided CallerId is either NULL or empty string";

// An MSCRMCallerID that names no user: 404 in the legacy _error body (native evidence), not the envelope.
function unknownCaller(id, requestId) {
  const text = `Entity 'systemuser' With Id = ${id} Does Not Exist`;
  return {
    status: 404,
    headers: { ...baseHeaders(requestId), 'OData-Version': undefined, "Content-Type": "application/json; charset=utf-8" },
    body: {
      _error: {
        Code: "0x80040217",
        Description: text,
        DisplayText: "The requested record was not found.",
        ErrorCode: -2147220969,
        RedirectToEdit: false,
        SerializedEntity: "",
        SerializedException: "System.ServiceModel.FaultException`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]: " + text,
        Title: "Record Is Unavailable",
      },
    },
  };
}

// The limiter's own 429 text and Retry-After: dataverseError would rewrite a 0x80072322 message to a fixed limit.
const limitedEnvelope = (error, requestId) => {
  const result = envelope(429, error.details.innerCode, error.message, requestId);
  result.headers["Retry-After"] = String(error.details.retryAfter);
  return result;
};

async function dataApi(d, c, route) {
  const { req, origin, requestId } = c;
  if (route.kind === "unknown") return envelope(404, "", route.message, requestId);
  if (route.kind === "invalid") {
    // An over-long key segment answers as plain text; other malformed URIs use the JSON envelope.
    if (route.message === PLAIN_INVALID_URL) return { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: PLAIN_INVALID_URL };
    return envelope(400, "0x80060888", route.message, requestId);
  }
  // HEAD is not a Web API verb (405, no body); the serve step maps it to GET only for the non-data routes.
  if (!METHODS.has(req.method) || req.method === "HEAD") {
    const refused = methodNotAllowed(c);
    // observed: parity cases errors.method-head and errors.method-options on a keyed record list the record's verbs.
    if (route.kind === "entity") refused.headers.Allow = "POST,OPTIONS,GET,HEAD,POST";
    return refused;
  }
  const version = req.headers["odata-version"];
  if (version !== undefined && !ODATA_VERSIONS.has(String(version).trim())) {
    return envelope(412, "0x80060888", `The value '${version}' of the OData-Version HTTP header is invalid. Only '4.0' and '4.01' are supported as values for the OData-Version header.`, requestId);
  }
  // A record write takes JSON (or a binary column's octet-stream); any other media type is refused before the body is read.
  const type = req.headers["content-type"];
  if (type !== undefined && BODY_METHODS.has(req.method) && (route.kind === "entity" || route.kind === "collection") && !/json|octet-stream/i.test(type)) {
    return envelope(415, "", `The request entity's media type '${String(type).split(";")[0].trim()}' is not supported for this resource.`, requestId);
  }
  return authenticated(d, c, ({ user, caller, identity, bodyBuffer }) =>
    handleDataRequest(d, { method: c.method, url: c.url, route, headers: req.headers, bodyBuffer, user, caller, identity, prefer: c.prefer, origin, requestId }),
  );
}

// The bearer check, caller resolution and impersonation for every route that acts as a caller (Web API, extension routes, SOAP).
// handle({ user, caller, identity, bodyBuffer }) runs inside the service-protection admission. An unauthenticated request throws
// the same 401 everywhere; a disabled or unknown caller gets the Dataverse envelope.
// CallerObjectId / MSCRMCallerID impersonation (Learn impersonate-another-user-web-api): { user } for the impersonated
// principal, { user: null } without the headers, { refused } with the envelope of an invalid or disabled target. A top-level
// request and each $batch part (Learn execute-batch-operations: a part's own headers control it) resolve it here.
function impersonatedUser(d, caller, headers, requestId) {
  const callerObjectId = headers.callerobjectid;
  const callerId = headers.mscrmcallerid;
  if (callerObjectId === undefined && callerId === undefined) return { user: null };
  if (!d.principals.canImpersonate(caller)) throw privilegeDenied(d, caller, "prvActOnBehalfOfAnotherUser");
  const byObjectId = callerObjectId !== undefined;
  const value = String(byObjectId ? callerObjectId : callerId);
  if (!GUID_TEXT.test(value)) return { refused: envelope(400, "0x80048d1A", INVALID_CALLER, requestId) };
  const target = byObjectId ? d.principals.byObjectId(value) : d.principals.byId(value);
  if (!target) return { refused: byObjectId ? envelope(400, "0x80040203", "Invalid argument.", requestId) : unknownCaller(value, requestId) };
  if (target.isdisabled === true) return { refused: disabledEnvelope(target, requestId) };
  return { user: d.principals.effectivePrincipal(caller, target) };
}

async function authenticated(d, c, handle) {
  const { req, origin, requestId, meta } = c;
  const verdict = d.authority.verifyBearer(req.headers.authorization, { origin, tenantId: d.tenantId });
  if (!verdict.ok) throw unauthorized(verdict);
  meta.appId = verdict.claims.appid ?? null;
  const resolved = d.principals.resolve(verdict.claims);
  if (!resolved.user) return envelope(401, "0x80072560", "The user is not a member of the organization.", requestId);
  if (resolved.reason === "disabled") return disabledEnvelope(resolved.user, requestId);
  const caller = resolved.user;
  meta.userId = caller.systemuserid;

  // Service protection: admitted before dispatch and released when the request ends, whatever its outcome.
  const admission = d.limits.admit(caller.systemuserid);
  if (!admission.ok) return limitedEnvelope(admission.error, requestId);
  const started = d.clock();
  try {
    // A groups claim keeps the caller's group teams current before the identity reads them.
    if (Array.isArray(verdict.claims.groups)) await d.change(() => syncGroupMembership(d.store, caller, verdict.claims.groups));

    const impersonation = impersonatedUser(d, caller, req.headers, requestId);
    if (impersonation.refused) return impersonation.refused;
    const user = impersonation.user ?? caller;

    const { identity } = organizationPrincipalContext(d.store, user, { caller, appId: verdict.claims.appid });
    const bodyBuffer = BODY_METHODS.has(c.method) ? await readBody(req) : Buffer.alloc(0);
    // The request context names who asked (the caller) and who executes (the impersonated user) from here on.
    const context = currentRequest();
    const run = () => handle({ user, caller, identity, bodyBuffer });
    return await (context ? runWithRequest(context.with({ initiator: { kind: verdict.claims.appid ? "app" : "staff", id: caller.systemuserid },
      principal: { systemUserId: user.systemuserid, callerId: caller.systemuserid } }), run) : run());
  } finally {
    admission.release(d.clock() - started);
  }
}

// The request an extension route handler gets: the parsed route and JSON body, and the caller authenticated() resolved.
function extensionContext(c, { user, caller, identity, bodyBuffer }) {
  const route = parseDataverseRoute(c.url.pathname);
  const headers = c.req.headers;
  return {
    method: c.method, url: c.url, origin: c.origin, version: route?.version, route, prefer: c.prefer, headers, requestId: c.requestId,
    body: bodyOf(c.method, headers, bodyBuffer, route), bodyBuffer, user, caller, identity, req: c.req,
  };
}

// The JSON body of a write, parsed; a body that is not JSON is the Web API's malformed-payload error.
function bodyOf(method, headers, bodyBuffer, route) {
  if (!bodyBuffer.length || !BODY_METHODS.has(method) || !/json/i.test(headers["content-type"] ?? "")) return undefined;
  try {
    // Exact parse: a decimal, money or Int64 literal a double cannot hold keeps its digits (exact-numeric.mjs).
    return parseExactJson(bodyBuffer.toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const set = route?.set ?? route?.name ?? "";
    throw new DataError(
      `Error identified in Payload provided by the user for Entity :'${set}'  ---->  InnerException : Microsoft.OData.ODataException: ${error.message}`,
      400,
      "InvalidLookup",
    );
  }
}

// Answers one Web API request for a caller already authenticated. The HTTP path and $batch parts both come through here,
// and it returns a result rather than writing to the response.
async function handleDataRequest(d, { method, url, route, headers = {}, bodyBuffer = Buffer.alloc(0), user, caller, identity, prefer, origin, requestId }) {
  const req = { method, headers };
  const c = { req, method, url, origin, requestId, prefer, meta: {} };
  // MSCRM.BypassCustomPluginExecution: true needs prvBypassCustomPlugins. MSCRM.BypassBusinessLogicExecution (a comma list)
  // needs prvBypassCustomBusinessLogic; CustomSync also skips the synchronous plug-in phase, as the header asks.
  const plugins = ["true", "1"].includes(String(headers["mscrm.bypasscustompluginexecution"] ?? "").trim().toLowerCase());
  const logic = String(headers["mscrm.bypassbusinesslogicexecution"] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const holds = (privilege) => d.principals.privileges(caller).has(privilege) || d.principals.roles(caller).some((role) => BYPASS_ROLES.has(role.name));
  if (plugins && !holds("prvBypassCustomPlugins")) throw privilegeDenied(d, caller, "prvBypassCustomPlugins");
  if (logic.length && !holds("prvBypassCustomBusinessLogic")) throw privilegeDenied(d, caller, "prvBypassCustomBusinessLogic");
  const bypassCustomPlugins = plugins || logic.includes("customsync");
  const body = bodyOf(method, headers, bodyBuffer, route);

  const common = { req, origin, requestId, prefer, method, url, body, bodyBuffer, user, caller, identity, bypassCustomPlugins };
  const operated = await operationCall(d, route, common);
  if (operated) return operated;
  switch (route.kind) {
    case "service":
      // Native omits Expires on the service document and $metadata (see baseHeaders).
      return method === "GET" ? { status: 200, headers: { expires: undefined, ETag: d.metadata.etag() }, body: d.metadata.serviceDocument(origin, route.version) } : methodNotAllowed(c);
    case "metadata":
      if (method !== "GET") return methodNotAllowed(c);
      return {
        status: 200,
        headers: { "content-type": "application/xml", expires: undefined, ETag: d.metadata.etag() },
        body: d.metadata.csdl(origin, { annotations: url.searchParams.get("annotations") === "true" || prefer.annotations === "*" }),
      };
    case "batch":
      return batchCall(d, c, common);
    case "function":
      if (method === "POST" && Object.hasOwn(SHARE_ACTIONS, route.name)) return shareAction(d, c, route, common);
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

// Extension operations (dataverse-operations.mjs) answer before the built-in functions and actions. Returns null on a miss so
// the built-ins run. A name registered under another verb, binding or entity is a 404, as a wrong verb is for built-ins.
const entitySetNamed = (store, name) =>
  Object.values(store.state.mappings ?? {}).some((mapping) => mapping?.entitySet === name) || store.virtualTable?.(name)?.mapping?.entitySet === name;

async function operationCall(d, route, common) {
  const ops = d.operations;
  // A bound operation written without the Microsoft.Dynamics.CRM. prefix parses as a property of the entity row.
  if ((route.kind === "property" || route.kind === "member") && ops.has(route.segment)) {
    return envelope(400, "", "Request message has unresolved parameters", common.requestId);
  }
  const kind = common.method === "GET" ? "function" : "action";
  // One segment that names a registered unbound operation (route.candidate) is that operation before it is read as a set.
  // A wrong verb there falls through to the set, which may be a real entity; a registered bound name does not.
  if (route.candidate && route.kind !== "function" && ops.has(route.candidate.name)) {
    const op = ops.find({ name: route.candidate.name, kind, binding: "unbound" });
    if (op) return runOperation(d, op, route, route.candidate.params, common, undefined);
    // A wrong verb on a registered name falls to the set only when an entity set has that name; otherwise there is no route (native: 404, no code).
    return entitySetNamed(d.store, route.candidate.name) ? null : notFound(common);
  }
  if (!["function", "boundFunction", "boundAction"].includes(route.kind) || !ops.has(route.name)) return null;
  let binding = "unbound";
  let entity;
  let mapping;
  let id;
  // The name is registered, so a bound route the operation cannot serve (unknown set, alternate key) is a 404, not a built-in.
  const unroutable = () => notFound({ url: common.url, requestId: common.requestId });
  if (route.kind !== "function") {
    try {
      mapping = d.store.resolveMapping(route.set);
    } catch {
      return unroutable();
    }
    entity = mapping.logicalName;
    if (route.key == null) binding = "collection";
    else {
      // ponytail: alternate-key addressing is not resolved for operations; a GUID key is the supported form.
      id = parseKey(route.key)?.id;
      if (!id) return unroutable();
      binding = "entity";
    }
  }
  const op = ops.find({ name: route.name, kind, binding, entity });
  if (!op) return notFound({ url: common.url, requestId: common.requestId });
  let target;
  if (binding === "entity") {
    const row = d.store.get(entity, id, common.identity);
    if (!row) throw new DataError(`${entity} With Id = ${id} Does Not Exist`, 404, "NotFound", { id });
    target = { mapping, id, row };
  } else if (binding === "collection") target = { mapping };
  return runOperation(d, op, route, route.params, common, target);
}

// Calls the operation's handle(ctx) and shapes its result: object bodies are JSON, Buffers go out as they are.
async function runOperation(d, op, route, paramsText, common, target) {
  const headers = Object.fromEntries(Object.entries(common.req.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  const call = {
    method: common.method,
    route,
    url: common.url,
    origin: common.origin,
    version: route.version,
    prefer: common.prefer,
    headers,
    body: common.body,
    bodyBuffer: common.bodyBuffer,
    dataverseHttpReader: dataverseHttpReaderContext({method:common.method,route,headers,bodyBuffer:common.bodyBuffer}),
    params: parseFunctionParameters(paramsText, common.url.searchParams),
    user: common.user,
    caller: common.caller,
    identity: common.identity,
    requestId: common.requestId,
    target,
    api: d.api,
  };
  // A Prefer: respond-async call to a custom API is answered 202 here and runs later; otherwise the operation runs now.
  const result = (await runInBackground(d.api, call, op)) ?? (await op.handle(call));
  if (!result) return { status: 204 };
  const jsonBody = result.body !== null && typeof result.body === "object" && !Buffer.isBuffer(result.body);
  // observed: parity cases custom.* and file.* answer application/json; odata.metadata=minimal with no charset.
  return jsonBody ? { ...result, headers: { "content-type": JSON_CONTENT_TYPE, ...(result.headers ?? {}) } } : result;
}

// The largest versionnumber any stored row holds (0 for none); a reset restores the org row version to it.
// Runs fn as one unit: an isolated store transaction, so its writes stay private until fn returns and a throw discards them.
// The change log is rewound to its revision on rollback. Usable by any caller that holds the api (a $batch changeset, a later
// SOAP ExecuteTransaction); the caller holds the change slot. Plain store.transact calls made inside fn join this transaction.
// $batch: parts run in process under the caller verified for the batch; a changeset rolls back on failure (runAtomic).
async function batchCall(d, c, common) {
  if (c.method !== "POST") return methodNotAllowed(c);
  const parsed = parseBatch(c.req.headers["content-type"], common.bodyBuffer);
  const runPart = async ({ method, url, headers, body }) => {
    const target = new URL(url);
    const route = parseDataverseRoute(target.pathname);
    if (!route || route.kind === "unknown") return envelope(404, "", `No HTTP resource was found that matches the request URI '${target.href}'.`, c.requestId);
    if (route.kind === "invalid") throw new DataError(route.message, 400, "InvalidRequest");
    if (route.kind === "discovery" || route.kind === "soap" || route.kind === "batch") {
      return envelope(400, "", `The request URI '${target.href}' is not supported inside a batch.`, c.requestId);
    }
    if (!METHODS.has(method)) return envelope(405, "", `The requested resource does not support http method '${method}'.`, c.requestId);
    // A part's own CallerObjectId / MSCRMCallerID impersonates for that part; without them the batch's principal acts.
    const partHeaders = { authorization: c.req.headers.authorization, ...headers };
    const impersonation = impersonatedUser(d, common.caller, partHeaders, c.requestId);
    if (impersonation.refused) return impersonation.refused;
    const user = impersonation.user ?? common.user;
    const identity = impersonation.user ? organizationPrincipalContext(d.store, user, { caller: common.caller, appId: common.identity?.dataverse?.appId }).identity : common.identity;
    // Extension routes (metadata writes and the other api.addRoute writes) answer inside a batch as they do at top level. In a
    // changeset they run in its transaction, so a metadata change rolls back with the changeset (Learn
    // execute-batch-operations-using-web-api "Change sets": a failing operation rolls back every completed one).
    const extension = (d.routes ?? []).find((entry) => !entry.anonymous && entry.match(target.pathname, method));
    if (extension) {
      return extension.handler(extensionContext({ method, url: target, origin: c.origin, prefer: parsePrefer(headers?.prefer), requestId: c.requestId, req: { method, headers: partHeaders } },
        { user, caller: common.caller, identity, bodyBuffer: Buffer.from(body ?? "", "utf8") }));
    }
    return handleDataRequest(d, {
      method,
      url: target,
      route,
      headers: partHeaders,
      bodyBuffer: Buffer.from(body ?? "", "utf8"),
      user,
      caller: common.caller,
      identity,
      prefer: parsePrefer(headers?.prefer),
      origin: c.origin,
      requestId: c.requestId,
    });
  };
  // A part fails with the same envelope as a top-level response, and its body is serialized here: executeBatch
  // would otherwise JSON.stringify it without the annotation ordering or exact numerics.
  const dispatch = async (part) => {
    let result;
    try {
      result = await runPart(part);
    } catch (error) {
      result = dataverseError(error, {
        prefer: parsePrefer(part.headers?.prefer),
        requestId: c.requestId,
        origin: c.origin,
        tenantId: d.tenantId,
        logical: error?.details?.logical,
        method: part.method,
      });
      // Native answers a route-resolution failure inside a batch without REQ_ID (only Content-Type and OData-Version are left).
      if (error?.details?.route && result.headers) delete result.headers.REQ_ID;
      // A part's engine error carries its request id once: the part serialiser expects a string, not the top-level pair.
      else if (Array.isArray(result.headers?.REQ_ID)) result.headers.REQ_ID = c.requestId;
    }
    result = encodeDataverseText(parseDataverseRoute(new URL(part.url).pathname), result);
    const body = result.body ?? undefined;
    return { ...result, body: body === undefined || typeof body === "string" ? body : stringifyExactJson(orderAnnotations(body)) };
  };
  dispatch.transaction = (fn) => runAtomic(d.api, fn);
  const continueOnError = common.prefer.continueOnError;
  // ponytail: the whole batch takes one slot in the server's change queue, so no other write lands while a changeset runs.
  // Ceiling: a long batch holds writers back; split the batch if that matters.
  const result = await d.change(() => runOwned(() => executeBatch(parsed, { dispatch, origin: c.origin, base: new URL("./", c.url).href, continueOnError })));
  const applied = preferenceApplied(common.prefer);
  return applied ? { ...result, headers: { ...result.headers, "Preference-Applied": applied } } : result;
}

async function route(d, c) {
  const path = c.url.pathname;
  // Managed identity endpoints (the server's hook) answer GET requests before any route, discovery or data path.
  if (c.method === "GET" && d.managedIdentity) {
    const identityReply = d.managedIdentity({ method: c.req.method, pathname: path, searchParams: c.url.searchParams, headers: c.req.headers });
    if (identityReply) {
      c.meta.kind = "managedIdentity";
      return asJson(identityReply);
    }
  }
  // An anonymous extension route (api.addRoute with { anonymous: true }) answers without a bearer; every other route keeps the check.
  const anonymous = (d.routes ?? []).find((entry) => entry.anonymous && entry.match(path, c.method));
  if (anonymous) {
    c.meta.kind = "extension";
    return anonymous.handler({ ...c, user: null });
  }
  const sts = await stsRoute(d, c);
  if (sts) {
    c.meta.kind = "sts";
    return sts;
  }
  // A malformed Prefer is answered before any routing, as Dataverse does for every Web API request.
  if (c.prefer.malformed) return preferMalformedResponse(c.prefer.malformed);
  // Extension routes (api.addRoute) answer before discovery, SOAP and the Web API, after the bearer check; the first match wins.
  const extension = (d.routes ?? []).find((entry) => entry.match(path, c.method));
  if (extension) {
    c.meta.kind = "extension";
    return authenticated(d, c, (caller) => extension.handler(extensionContext(c, caller)));
  }
  if (path === "/api/discovery/v2.0" || path === "/api/discovery/v2.0/") {
    c.meta.kind = "discovery";
    return discoveryService(c);
  }
  if (DISCOVERY_ROUTE.test(path)) {
    c.meta.kind = "discovery";
    return discoveryCall(d, c);
  }
  if (SOAP_ROUTE.test(path)) {
    c.meta.kind = "soap";
    return soapCall(d, c);
  }
  const parsed = parseDataverseRoute(path);
  if (!parsed) {
    const parts = path.split("/").filter(Boolean);
    throw new DataError(`Resource not found for the segment '${parts[3] ?? parts.at(-1) ?? ""}'.`, 404, "UnknownEntity", { segment: parts[3] ?? parts.at(-1) ?? "" });
  }
  return dataApi(d, c, parsed);
}

// Every response write sits inside serve's try; a header that cannot be sent (for example a non-Latin-1 OData-EntityId)
// becomes a Dataverse error envelope, and only if that write fails too does the connection drop.
const DATA_PLANE = /^\/api\/data\/v\d+(?:\.\d+)*(?:\/|$)/i;
export function createDataverseHandler(deps) {
  const limits = deps.limits ?? createServiceProtection({ ...(deps.settings?.serviceProtection ?? {}), clock: deps.clock });
  const d = { ...deps, change: deps.change ?? ((fn) => fn()), limits, requests: deps.requests ?? [], hostNames: allowedHostNames(deps.host ?? "127.0.0.1") };
  const log = deps.log ?? (() => {});
  const serve = async (req, res) => {
    const requestId = randomUUID();
    const started = d.clock();
    const clientRequestId = req.headers["x-ms-client-request-id"];
    const origin = originOf(req, d.host);
    const meta = { appId: null, userId: null, grant: null, kind: "data" };
    const prefer = parsePrefer(req.headers.prefer);
    const c = { req, url: null, origin, requestId, meta, prefer, method: req.method === "HEAD" ? "GET" : req.method };
    // Dashboard counters (runtime-counters.mjs): dataverseRequests and dataverseRequests.failed count data-plane Web API
    // requests (/api/data/v*, not $metadata); token, discovery, metadata document, SOAP and every other request on this
    // listener count as dataverseRequests.other. TDS has its own listener and is not counted.
    res.on("finish", () => {
      const counters = d.store?.counters;
      if (!counters) return;
      const pathname = c.url?.pathname ?? "";
      if (meta.kind !== "data" || !DATA_PLANE.test(pathname) || /\/\$metadata$/i.test(pathname)) return counters.increment("dataverseRequests.other");
      counters.increment("dataverseRequests");
      if (res.statusCode >= 400) counters.increment("dataverseRequests.failed");
    });
    res.on("finish", () =>
      remember(d.requests, {
        at: started,
        method: req.method,
        path: c.url?.pathname ?? "",
        status: res.statusCode,
        ms: d.clock() - started,
        appId: meta.appId,
        userId: meta.userId,
        grant: meta.grant,
        kind: meta.kind,
      }),
    );
    const reply = (result) => send(res, encodeDataverseText(c.url ? parseDataverseRoute(c.url.pathname) : null, result), requestId, clientRequestId, { cors: wantsCors(req, origin), gzip: acceptsGzip(req) });
    let result;
    try {
      if (req.headers.host !== undefined && !hostAllowed(req.headers.host, d.hostNames)) {
        result = { status: 403, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Forbidden - Host name is not served by this simulator." };
      } else if (String(req.url ?? "").length > MAX_URL_LENGTH) {
        result = envelope(400, "0x80060888", "Invalid URI: The Uri string is too long.", requestId);
      } else {
        c.url = new URL(req.url ?? "/", origin);
        // A CORS preflight (Origin + Access-Control-Request-Method) and an anonymous OPTIONS answer 204. An authenticated
        // OPTIONS that is not a preflight is a 405 from the route (native evidence: Dataverse refuses it).
        const preflight = req.headers.origin !== undefined && req.headers["access-control-request-method"] !== undefined;
        if (req.method === "OPTIONS" && (preflight || req.headers.authorization === undefined)) {
          meta.kind = "options";
          result = { status: 204 };
        } else {
          // One request context per call: x-ms-correlation-request-id (when it is a plain token) or the request id correlates
          // the committed events, jobs and web hooks this request causes.
          const context = createRequestContext({ organization: d.api ? { organizationId: d.organizationId, clock: d.clock, ids: d.api.ids } : null,
            correlationId: req.headers["x-ms-correlation-request-id"] ?? requestId, requestId });
          result = await runWithRequest(context, () => route(d, c));
        }
      }
    } catch (error) {
      result = dataverseError(error, { prefer, requestId, origin, tenantId: d.tenantId, logical: error?.details?.logical, method: c.method });
      log("dataverse request failed", { requestId, path: c.url?.pathname, status: result.status, message: error?.message });
    }
    // Every response for an authenticated caller carries the remaining service-protection headers; none reach unauthenticated ones.
    const withLimits = meta.userId ? { ...result, headers: { ...(result.headers ?? {}), ...d.limits.headers(meta.userId) } } : result;
    try {
      reply(withLimits);
    } catch (error) {
      log("dataverse response failed", { requestId, message: error?.message });
      try {
        reply(dataverseError(error, { prefer, requestId, origin, tenantId: d.tenantId, method: c.method }));
      } catch {
        res.destroy();
      }
    }
  };
  // serve never rejects here: whatever escapes it still gets an answer or a dropped connection.
  return function handle(req, res) {
    return serve(req, res).catch((error) => {
      try {
        if (res.headersSent) res.destroy();
        else send(res, dataverseError(error, {}), undefined);
      } catch {
        res.destroy();
      }
    });
  };
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
  extensions = EXTENSIONS,
  managedIdentity = null,
  organization = null,
  beforeListen,
}) {
  const ownsOrganization = !organization;
  organization ??= await createOrganizationRuntime({ store, settings, change, schema, metadataFields, clock, records, log, extensions });
  ({ store, settings, change, clock } = organization);
  const { api, principals, metadata, changes, routes, limits, tenantId, organizationId, environmentId } = organization;
  const operations = organization.registry, recordHandlers = organization.records;
  metadataFields = api.metadataFields;
  const servers = [];
  let tds, closing;
  const close = () => closing ??= (async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => tds?.close()),
      ...servers.map(server => new Promise(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })),
    ]);
    if (ownsOrganization) await organization.close();
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Dataverse transport cleanup failed.');
  })();
  try {
  const authority = createAuthority({
    tenantId,
    applications: () => store.state.dataverse?.applications ?? [],
    federatedIssuers: () => store.state.dataverse?.federatedIssuers ?? settings.federatedIssuers,
    users: {
      byObjectId: principals.byObjectId,
      byDomainName: principals.byDomainName,
      list: () => store.tableRows("systemuser"),
      verifyPassword: (row, password) => {
        const record = store.state.dataverse?.passwords?.[row.systemuserid];
        return typeof password === "string" && Boolean(record) && verifySecret(password, record);
      },
    },
    clock,
  });

  const requests = [];
  const handle = createDataverseHandler({
    store,
    change,
    settings,
    operations,
    routes,
    api,
    authority,
    principals,
    metadata,
    recordHandlers,
    changes,
    tenantId,
    organizationId,
    environmentId,
    host,
    clock,
    log,
    requests,
    managedIdentity,
    limits,
  });

  await beforeListen?.(organization);
  const httpServer = http.createServer({ maxHeaderSize: MAX_HEADER_SIZE }, handle);
  servers.push(httpServer);
  await listen(httpServer, settings.port ?? 0, host);
  const origin = listenerOrigin("http", host, httpServer.address().port);
  let tlsOrigin = null;
  if (tls) {
    const httpsServer = https.createServer({ ...tls, maxHeaderSize: MAX_HEADER_SIZE }, handle);
    servers.push(httpsServer);
    await listen(httpsServer, settings.tlsPort ?? 0, host);
    tlsOrigin = listenerOrigin("https", host, httpsServer.address().port);
  }
  // On by default (Enable TDS endpoint); port 0 is ephemeral. Started last: the STS URL needs the HTTPS origin.
  // Listens even when disabled: the endpoint then refuses every login (tds.enabled false).
  const tdsSettings = settings.tds ?? { enabled: true, port: 0 };
  tds = await startDataverseTds({
    store, authority, principals, records: recordHandlers, limits, metadataFields, clock, origin, tlsOrigin, tenantId,
    version: settings.version, tls, host, port: tdsSettings.port, enabled: tdsSettings.enabled,
  });
  api.tdsPort = tds?.port ?? null;

  return {
    origin,
    tlsOrigin,
    authority: `${origin}/${tenantId}`,
    tenantId,
    organizationId,
    tdsPort: api.tdsPort,
    servers,
    // Re-seeds the registrations and security rows after a store reset. Runs store transactions only, never `change`,
    // so it can be called from inside the server's change queue (its /reset handler does).
    organization,
    reseed: organization.reseed,
    requests: () => requests.map((entry) => ({ ...entry })),
    issueManagedIdentityToken: authority.issueManagedIdentityToken,
    // Code apps (code-apps-http.mjs authorityTokenIssuer) mint staff tokens for this origin through the same authority.
    issueAccessToken: authority.issueAccessToken,
    // Called by the local administration shell while it owns the host's change
    // queue. Reuse the record pipeline without entering that queue a second time.
    writeLocalRecord: createModelDrivenRecordService({
      organization,
      store, records: recordHandlers, origin: () => origin,
      principal: () => principals.byId(uuidV5(organizationId, 'systemuser:SYSTEM')),
      run: fn => runOwned(() => runAtomic(api, fn)),
    }),
    close,
    handle,
  };
  } catch (error) {
    await close().catch(cleanup => log('transport-cleanup', cleanup));
    throw error;
  }
}
