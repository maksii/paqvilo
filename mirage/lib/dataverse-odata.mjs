import { parseKeySegment } from "./data.mjs";
import { DataError } from "./data-error.mjs";
import { annotationMatcher } from "./webapi-handler.mjs";

export { annotationMatcher };
export const VERSIONS = ["v9.0", "v9.1", "v9.2"];
export const JSON_CONTENT_TYPE = "application/json; odata.metadata=minimal";

const SOAP_PATH = "/XRMServices/2011/Organization.svc/web";
const DISCOVERY = /^\/api\/discovery\/v2\.0\/Instances(?:\((.*)\))?$/;
const DATA_PATH = /^\/api\/data\/(v[\d.]+)(?:\/(.*))?$/;
// Same key grammar as webapi-handler.mjs (not exported there).
const KEY = String.raw`((?:'(?:[^']|'')*'|[^()'/])*)`;
const SEGMENT = new RegExp(String.raw`^([^()]+)(?:\(${KEY}\))?$`);
const IDENT = /^[A-Za-z_]\w*$/;
const FUNCTION_NAME = /^(?:Microsoft\.Dynamics\.CRM\.)?[A-Z][A-Za-z]+$/;
const CRM_NAME = /^Microsoft\.Dynamics\.CRM\.([A-Za-z_]\w*)$/;
const METADATA_SETS = new Set(["EntityDefinitions", "RelationshipDefinitions", "GlobalOptionSetDefinitions"]);
const METADATA_SEGMENTS = new Set(["Attributes", "Keys", "OneToManyRelationships", "ManyToOneRelationships", "ManyToManyRelationships"]);
const GUID = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;
const HEAD_ANNOTATIONS = ["@odata.context", "@odata.count", "@odata.etag", "@odata.type"];
const TAIL_ANNOTATIONS = ["@odata.nextLink", "@odata.deltaLink"];
const MAX_PAGE_SIZE = 5000;
const MAX_SEGMENT_LENGTH = 260;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
// Marks an error object whose key order is already final (orderAnnotations must not move its annotations).
const KEEP_ORDER = Symbol("keepOrder");

// Store code (DataError.code) -> [status, Dataverse error code].
const CODE_MAP = {
  NotFound: [404, "0x80040217"],
  UnknownEntity: [404, "0x8006088a"],
  PermissionDenied: [403, "0x80040220"],
  InvalidKey: [400, "0x80040203"],
  InvalidAutoNumber: [400, "0x80040203"],
  InvalidLookup: [400, "0x80048d19"],
  InvalidValue: [400, "0x80044331"],
  PicklistValueOutOfRange: [400, "0x80044331"],
  DuplicateRecord: [412, "0x80060892"],
  PreconditionFailed: [412, "0x80060882"],
  PluginValidation: [400, "0x80040265"],
  LocalPluginInvalid: [400, "0x80040265"],
  LocalPluginQueryUnsupported: [501, "0x80040216"],
  NumericMetadataRequired: [501, "0x80040216"],
  ODataPermissionQueryUnsupported: [501, "0x80040216"],
  ServiceProtection: [429, "0x80072322"],
  PayloadTooLarge: [413, "0x8004418a"],
  RequestEntityTooLarge: [413, "0x8004418a"],
  InvalidBatch: [400, "0x80048d19"],
};
// Inner codes recognised from details.innerCode (the code is the inner code itself).
const INNER_STATUS = {
  "0x80040217": 404,
  "0x8006088a": 404,
  "0x80040220": 403,
  "0x80048306": 403,
  "0x80060882": 412,
  "0x80060892": 412,
  "0x8004430c": 400,
  "0x80044331": 400,
  "0x80040203": 400,
  "0x80048d19": 400,
  "0x80060888": 400,
  "0x80040265": 400,
  "0x80072322": 429,
  "0x8004418a": 413,
  "0x80072560": 401,
  "0x80040225": 401,
  "0x8004032c": 401,
};

const decode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};
const invalid = (message) => ({ kind: "invalid", message });

/** Splits on `separator` outside quotes and brackets. */
function splitTop(text, separator) {
  const parts = [];
  let current = "",
    depth = 0,
    quoted = false;
  for (const ch of text) {
    if (ch === "'") quoted = !quoted;
    else if (!quoted && "([{".includes(ch)) depth++;
    else if (!quoted && ")]}".includes(ch)) depth--;
    if (ch === separator && !quoted && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

function segment(text) {
  const match = SEGMENT.exec(text);
  return match ? { name: match[1], args: match[2] } : null;
}

/** Key predicates may not use OData v3 guid'' literals or parameter aliases. */
function keyProblem(text) {
  if (/^\s*guid'/i.test(text)) return `The key ${text.trim()} uses OData v3 syntax; OData v4 GUID keys are bare.`;
  if (/(^|[=,\s])@[A-Za-z_]/.test(text)) return `Parameter aliases are not supported in key predicates: ${text.trim()}.`;
  return null;
}

function metadata(parts, unknown) {
  const [head, second, third] = parts;
  if (head.args === "" || second?.args === "") return unknown;
  if (head.args !== undefined && keyProblem(head.args)) return invalid(keyProblem(head.args));
  const result = { kind: "metadataEntity", set: head.name, key: head.args ?? null, segment: null, segmentKey: null, cast: null };
  if (parts.length === 1) return result;
  if (!METADATA_SEGMENTS.has(second.name)) return unknown;
  if (second.args !== undefined && keyProblem(second.args)) return invalid(keyProblem(second.args));
  result.segment = second.name;
  result.segmentKey = second.args ?? null;
  if (parts.length === 2) return result;
  const cast = CRM_NAME.exec(third.name);
  if (parts.length === 3 && cast && third.args === undefined) return { ...result, cast: cast[1] };
  return unknown;
}

function resource(rest, path) {
  if (rest === "") return { kind: "service" };
  const unknown = { kind: "unknown", message: `No HTTP resource was found that matches the request URI '${path}'.` };
  const parts = splitTop(rest, "/").map(segment);
  if (parts.some((part) => part === null)) return unknown;
  const [head, second, third] = parts;
  const count = parts.length;
  if (METADATA_SETS.has(head.name)) return metadata(parts, unknown);
  if (count === 1 && head.args === undefined && head.name === "$metadata") return { kind: "metadata" };
  if (count === 1 && head.args === undefined && head.name === "$batch") return { kind: "batch" };
  if (count === 1 && FUNCTION_NAME.test(head.name)) {
    return { kind: "function", name: head.name.replace(/^Microsoft\.Dynamics\.CRM\./, ""), params: head.args };
  }
  if (!IDENT.test(head.name) || head.args === "") return unknown;
  const set = head.name;
  const key = head.args;
  if (key !== undefined && keyProblem(key)) return invalid(keyProblem(key));
  if (count === 1) return key === undefined ? { kind: "collection", set } : { kind: "entity", set, key };
  if (count === 2) {
    const bound = CRM_NAME.exec(second.name);
    if (bound) {
      return { kind: second.args === undefined ? "boundAction" : "boundFunction", set, key: key ?? null, name: bound[1], params: second.args };
    }
    if (second.name === "$count" && second.args === undefined && key === undefined) return { kind: "count", set };
    if (key === undefined || !IDENT.test(second.name) || second.args === "") return unknown;
    if (second.args === undefined) return { kind: "property", set, key, segment: second.name };
    if (keyProblem(second.args)) return invalid(keyProblem(second.args));
    return { kind: "member", set, key, segment: second.name, segmentKey: second.args };
  }
  if (count === 3) {
    if (key === undefined || !IDENT.test(second.name) || third.args !== undefined) return unknown;
    if (third.name === "$value" && second.args === undefined) return { kind: "value", set, key, segment: second.name };
    if (third.name === "$count" && second.args === undefined) return { kind: "navigationCount", set, key, segment: second.name };
    if (third.name === "$ref" && second.args === undefined) return { kind: "ref", set, key, segment: second.name };
    if (third.name === "$ref" && second.args !== "" && !keyProblem(second.args)) {
      return { kind: "navigationRef", set, key, segment: second.name, targetKey: second.args };
    }
  }
  return unknown;
}

/** Parses a /api/data/vX.Y path (or the SOAP and discovery endpoints); null when it is not one of them. */
export function parseDataverseRoute(pathname) {
  const path = String(pathname ?? "");
  if (path === SOAP_PATH) return { kind: "soap" };
  const discovery = DISCOVERY.exec(path);
  if (discovery) return { kind: "discovery", key: discovery[1] == null ? null : (decode(discovery[1]) ?? discovery[1]) };
  const data = DATA_PATH.exec(path);
  if (!data || !VERSIONS.includes(data[1])) return null;
  const version = data[1];
  if ((data[2] ?? "").split("/").some((part) => part.length > MAX_SEGMENT_LENGTH)) {
    return { version, kind: "invalid", status: 400, message: "Bad Request - Invalid URL" };
  }
  const rest = decode(data[2] ?? "");
  if (rest === null) return { version, kind: "invalid", message: "The request URI is not valid." };
  return { version, ...resource(rest, path) };
}

/** Key text is echoed in headers (Location, OData-EntityId), so control characters are a 400. */
export function assertKeyText(text) {
  if (CONTROL_CHARACTER.test(String(text ?? ""))) {
    throw new DataError("Invalid URI: the key segment contains control characters.", 400, "InvalidRequest", { innerCode: "0x80060888" });
  }
}

/** Key predicate text: GUID -> { id }, alternate key pairs -> { alternate }, otherwise null. */
export function parseKey(text) {
  assertKeyText(text);
  const value = String(text ?? "").trim();
  const guid = GUID.exec(value);
  if (guid) return { id: guid[1].toLowerCase() };
  try {
    const alternate = parseKeySegment(value);
    return alternate ? { alternate } : null;
  } catch {
    return null;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/'/g, '"'));
    } catch {
      return text;
    }
  }
}

/** Literal value: string, number, boolean, enum member, JSON array/object, or raw text. */
function literal(raw) {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const quoted = /^'((?:[^']|'')*)'$/.exec(text);
  if (quoted) return quoted[1].replace(/''/g, "'");
  const enumMember = /^[A-Za-z_][\w.]*'((?:[^']|'')*)'$/.exec(text);
  if (enumMember) return enumMember[1].replace(/''/g, "'");
  if (/^[[{]/.test(text)) return parseJson(text);
  return text;
}

/** Function parameters: inline literals, or @alias values from the query string (null when unresolved). */
export function parseFunctionParameters(text, searchParams) {
  const params = {};
  if (text == null || String(text).trim() === "") return params;
  for (const piece of splitTop(String(text), ",")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim();
    const raw = piece.slice(eq + 1).trim();
    if (raw.startsWith("@")) {
      const value = searchParams?.get?.(raw);
      params[name] = value == null ? null : literal(value.trim());
    } else params[name] = literal(raw);
  }
  return params;
}

/** First backslash outside a quoted-string, or an unterminated quote; null when the header is well formed. */
function preferMalformed(text) {
  const nameAt = (start) => /^\s*([A-Za-z][\w.-]*)/.exec(text.slice(start))?.[1] ?? null;
  let start = 0; // where the current preference begins
  let quote = null; // { at, preference } while inside a quoted-string
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '"') quote = { at: i, preference: nameAt(start) };
    else if (ch === "\\") return { preference: nameAt(start), position: i, detail: "the escape character '\\' is not inside a quoted-string" };
    else if (ch === "," || ch === ";") start = i + 1;
  }
  return quote && { preference: quote.preference, position: quote.at, detail: "the quoted-string is not terminated" };
}

/** Prefer header (string or array; comma or semicolon separated). A malformed header gets prefer.malformed. */
export function parsePrefer(header) {
  const text = Array.isArray(header) ? header.join(",") : String(header ?? "");
  const prefer = {
    annotations: null,
    maxPageSize: null,
    representation: false,
    continueOnError: false,
    trackChanges: false,
    respondAsync: false,
    raw: text,
  };
  for (const [, name, quoted, bare] of text.matchAll(/([A-Za-z][\w.-]*)(?:\s*=\s*(?:"([^"]*)"|([^,;\s"]*)))?/g)) {
    const value = (quoted ?? bare ?? "").trim();
    switch (name.toLowerCase()) {
      case "odata.include-annotations": {
        const names = value.split(",").map((item) => item.trim()).filter(Boolean);
        prefer.annotations = names.length === 1 && names[0] === "*" ? "*" : names.length ? names : null;
        break;
      }
      case "odata.maxpagesize":
        prefer.maxPageSize = /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
        break;
      case "return":
        if (value.toLowerCase() === "representation") prefer.representation = true;
        break;
      case "odata.continue-on-error":
        prefer.continueOnError = true;
        break;
      case "odata.track-changes":
        prefer.trackChanges = true;
        break;
      case "respond-async":
        prefer.respondAsync = true;
        break;
    }
  }
  const malformed = preferMalformed(text);
  if (malformed) prefer.malformed = { ...malformed, raw: text };
  return prefer;
}

/** 400 envelope for a malformed Prefer header (from parsePrefer(...).malformed). */
export function preferMalformedResponse(malformed) {
  const { preference, position, detail, raw } = malformed;
  return {
    status: 400,
    body: {
      Message: `Error identified on the '${preference ?? ""}' value inside the 'Prefer' header. Refer to the following link for more details: https://go.microsoft.com/fwlink/?linkid=2300109. See exception message for more details 'An error occurred when parsing the HTTP header 'Prefer'. The header value '${raw}' is incorrect at position '${position}' because ${detail}.'.`,
      ErrorCode: "0x80097303",
    },
  };
}

/**
 * Preference-Applied echo: only what the response actually applied. maxpagesize needs a paged response
 * (size up to 5,000); continue-on-error only on a batch; track-changes only when a delta link was issued.
 * respond-async is never echoed.
 */
export function preferenceApplied(prefer = {}, { paged = false, batch = false, tracked = false } = {}) {
  const applied = [];
  if (prefer.annotations) {
    const list = Array.isArray(prefer.annotations) ? prefer.annotations.join(",") : prefer.annotations;
    applied.push(`odata.include-annotations="${list}"`);
  }
  if (paged && prefer.maxPageSize > 0 && prefer.maxPageSize <= MAX_PAGE_SIZE) applied.push(`odata.maxpagesize=${prefer.maxPageSize}`);
  if (prefer.representation) applied.push("return=representation");
  if (batch && prefer.continueOnError) applied.push("odata.continue-on-error");
  if (tracked && prefer.trackChanges) applied.push("odata.track-changes");
  return applied.length ? applied.join(", ") : null;
}

export function contextUrl(origin, version, suffix) {
  return `${origin}/api/data/${version}/$metadata#${suffix}`;
}

/** Header-safe: encodeURI leaves ' = , ( ) as they are, and # and ? would end the path, so they are encoded too. */
export function entityUrl(origin, version, set, keyText) {
  const key = encodeURI(String(keyText ?? "").toWellFormed()).replace(/#/g, "%23").replace(/\?/g, "%3F");
  return `${origin}/api/data/${version}/${set}(${key})`;
}

const upperGuid = (id) => String(id).replace(/[{}]/g, "").toUpperCase();
const lowerGuid = (id) => String(id).replace(/[{}]/g, "").toLowerCase();

/** Raw paging cookie: the pagingcookie attribute is percent-encoded twice, with lowercase escapes. */
export function encodeSkipToken({ pageNumber, lastId, firstId, idColumn, countOfRecords }) {
  const count = countOfRecords == null ? "" : ` countOfRecords="${countOfRecords}"`;
  const inner = `<cookie page="${pageNumber - 1}"${count}><${idColumn} last="{${upperGuid(lastId)}}" first="{${upperGuid(firstId)}}" /></cookie>`;
  const paging = encodeURIComponent(encodeURIComponent(inner)).replace(/%25([0-9A-F]{2})/g, (escape, hex) => `%25${hex.toLowerCase()}`);
  return `<cookie pagenumber="${pageNumber}" pagingcookie="${paging}" istracking="False" />`;
}

const QUERY_ESCAPES = { "%": "%25", "<": "%3C", ">": "%3E", '"': "%22", " ": "%20" };

/**
 * nextLink $skiptoken value (the research sample form). Escapes only % < > " and space.
 * Pass the cookie as the query decodes it: decodeURIComponent(encodeSkipToken(state)).
 */
export function skipTokenQueryValue(token) {
  return String(token ?? "").replace(/[%<>" ]/g, (ch) => QUERY_ESCAPES[ch]);
}

/** Accepts the raw cookie or its single percent-encoded form (as in an @odata.nextLink query). */
export function decodeSkipToken(text) {
  let raw = String(text ?? "").trim();
  if (!raw.startsWith("<")) {
    raw = decode(raw);
    if (raw === null) return null;
  }
  const outer = /<cookie\s+pagenumber="(\d+)"\s+pagingcookie="([^"]*)"/.exec(raw);
  if (!outer) return null;
  const inner = decode(decode(outer[2]) ?? "");
  const element = inner && /<cookie\s+page="\d+"([^>]*)>\s*<(\w+)\s+last="\{?([^"}]*)\}?"\s+first="\{?([^"}]*)\}?"/.exec(inner);
  if (!element) return null;
  const count = /countOfRecords="(\d+)"/.exec(element[1]);
  return {
    pageNumber: Number(outer[1]),
    lastId: lowerGuid(element[3]),
    firstId: lowerGuid(element[4]),
    idColumn: element[2],
    ...(count ? { countOfRecords: Number(count[1]) } : {}),
  };
}

/** Value of @Microsoft.Dynamics.CRM.fetchxmlpagingcookie; pageNumber is the next page. */
export function fetchXmlPagingCookie(state) {
  return encodeSkipToken(state);
}

/** Prefer annotation names as annotationMatcher reads them; a trailing * (ErrorDetails*) becomes a .* prefix. */
const annotationPatterns = (prefer) => {
  const names = Array.isArray(prefer?.annotations) ? prefer.annotations : String(prefer?.annotations ?? "").split(",");
  return names
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => (name.endsWith("*") && name !== "*" && !name.endsWith(".*") ? `${name.slice(0, -1)}.*` : name))
    .join(",");
};

/** The CDS error annotations the Prefer header asks for, each matched by its own name. */
function cdsErrorAnnotations(prefer, code, message) {
  const matches = annotationMatcher(annotationPatterns(prefer));
  const all = {
    "Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus": "0",
    "Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode": "-2146233088",
    "Microsoft.PowerApps.CDS.HelpLink": `http://go.microsoft.com/fwlink/?LinkID=398563&error=Microsoft.Crm.CrmException%3a${code.slice(2)}&client=platform`,
    "Microsoft.PowerApps.CDS.TraceText": "",
    "Microsoft.PowerApps.CDS.InnerError.Message": message,
  };
  return Object.fromEntries(
    Object.entries(all)
      .filter(([name]) => matches(name))
      .map(([name, value]) => [`@${name}`, value]),
  );
}

/** Store error -> { status, body, headers }. Dataverse innerCode wins, then the store code, then the status. */
export function dataverseError(error, { prefer, logical, requestId, origin, tenantId, id } = {}) {
  const details = error?.details ?? {};
  if (error?.code === "Unauthorized") {
    const invalidToken = details.reason === "invalid_token" ? 'error="invalid_token", error_description="Error during token validation!", ' : "";
    return {
      status: 401,
      body: null,
      headers: {
        ...baseHeaders(requestId),
        "WWW-Authenticate": `Bearer ${invalidToken}authorization_uri="${origin}/${tenantId}/oauth2/authorize", resource_id="${origin}/"`,
      },
    };
  }
  // A duplicate of an entity (alternate) key carries its own Dataverse code and message whatever the inner code says.
  const keyViolation = error?.code === "DuplicateRecord" && details.keyName != null && details.columns != null;
  const [status, code] = keyViolation ? [412, "0x80060892"] : resolveError(error);
  let message = error?.message ?? "An unexpected error occurred.";
  const recordId = id ?? details.id;
  if (status === 500) message = "An unexpected error occurred.";
  else if (keyViolation) {
    const columns = [details.columns].flat().join(", ");
    message = `Entity Key ${details.keyName} violated. A record with the same value for ${columns} already exists. A duplicate record cannot be created. Select one or more unique values and try again.`;
  } else if (code === "0x80040217" && logical && recordId != null) message = `${logical} With Id = ${recordId} Does Not Exist`;
  else if (code === "0x8006088a" && details.segment) message = `Resource not found for the segment '${details.segment}'.`;
  else if (code === "0x80072322") message = "Number of requests exceeded the limit of 6000 over time window of 300 seconds.";
  // code and message come first, then the annotations; orderAnnotations must leave this object alone.
  const body = { error: { code, message, ...cdsErrorAnnotations(prefer, code, message) } };
  Object.defineProperty(body.error, KEEP_ORDER, { value: true });
  const headers = { ...baseHeaders(requestId), "Content-Type": JSON_CONTENT_TYPE };
  if (status === 429) headers["Retry-After"] = String(details.retryAfter ?? 300);
  return { status, body, headers };
}

function resolveError(error) {
  const inner = String(error?.details?.innerCode ?? "").toLowerCase();
  if (Object.hasOwn(INNER_STATUS, inner)) return [INNER_STATUS[inner], inner];
  // A handler that names its own Dataverse code (including "0x0" and the empty code) keeps it with its status.
  if (typeof error?.details?.innerCode === "string" && Number.isInteger(error?.status)) return [error.status, inner];
  if (Object.hasOwn(CODE_MAP, error?.code)) return CODE_MAP[error.code];
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return [status, status === 400 ? "0x80060888" : "0x80040216"];
}

export function baseHeaders(requestId) {
  return {
    "OData-Version": "4.0",
    "x-ms-service-request-id": requestId,
    REQ_ID: requestId,
    "x-ms-ratelimit-burst-remaining-xrm-requests": "5999",
    "x-ms-ratelimit-time-remaining-xrm-requests": "1199.99",
    "x-ms-dop-hint": "4",
    "cache-control": "no-cache",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

/** Puts each p@annotation before its property p; @odata.context first and @odata.nextLink/deltaLink last. */
export function orderAnnotations(object) {
  if (Array.isArray(object)) return object.map(orderAnnotations);
  if (!object || typeof object !== "object" || object[KEEP_ORDER]) return object;
  const keys = Object.keys(object);
  const out = {};
  const seen = new Set();
  const emit = (key) => {
    if (!keys.includes(key) || seen.has(key)) return;
    seen.add(key);
    out[key] = orderAnnotations(object[key]);
  };
  HEAD_ANNOTATIONS.forEach(emit);
  keys.filter((key) => key.startsWith("@") && !TAIL_ANNOTATIONS.includes(key)).forEach(emit);
  for (const key of keys.filter((item) => !item.includes("@"))) {
    keys.filter((item) => item.startsWith(`${key}@`)).forEach(emit);
    emit(key);
  }
  keys.filter((key) => !seen.has(key) && !TAIL_ANNOTATIONS.includes(key)).forEach(emit);
  TAIL_ANNOTATIONS.forEach(emit);
  return out;
}
