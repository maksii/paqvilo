import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readRawBody } from './http-body.mjs';
import { isPortalEntityDefinitionsPath, portalEntityDefinition } from './portal-entity-definitions.mjs';
import { rejectedGatewayProperty } from './webapi-gateway-fields.mjs';
import { globalMetadataVersion } from './metadata-version.mjs';
// Local Power Pages portals Web API (/_api) over the simulator data store.
//
// Routes, system query options, annotations, writes and the error envelope
// follow the Power Pages Web API documentation (power-pages/configure:
// web-api-overview, read-operations, write-update-delete-operations,
// web-api-http-requests-handle-errors) and, where Power Pages passes requests
// through, the Dataverse Web API.
import { isExactNumeric, parseExactJson, stringifyExactJson } from './exact-numeric.mjs';
import { preparePortalFetchXml } from './portal-fetchxml.mjs';
import { DataError } from './data-error.mjs';
import { parseEntityReference, parseKeySegment } from './data.mjs';
import {
  parseXmlDocument,
  planFetch,
  structuralIntersects,
  webApiPagingCookie,
  xmlEscapeAttribute,
} from './fetchxml-engine.mjs';
import { compilePermissionFetchXml } from './permission-query.mjs';
import { permissionGrantColumn } from './odata-permission-query.mjs';
import { prepareODataPage } from './odata-paging.mjs';
import {
  applyPaths,
  expressionPaths,
  parseApply,
  parseExpand,
  parseODataExpression,
  parseSelect,
} from './odata-query.mjs';
import { createWebApiFormatter } from './webapi-format.mjs';
import { POWER_PAGES_TABLES, WEBAPI_UNSUPPORTED_TABLES, webApiFetchPolicy, webApiPolicy } from './webapi-policy.mjs';
import { fieldKind, GUID_PATTERN, own } from './dataverse-values.mjs';
import { contentDisposition, fileNameHeader, siteHeaders } from './response-headers.mjs';
import { ATTACHMENT_COLUMNS } from './dataverse-files.mjs';
import {
  attachODataReaderDetails,
  attachODataJsonSource,
  odataNumberLexemes,
  odataRootDetails,
  observedODataInnerMessage,
} from './webapi-error-details.mjs';
import { appendObservedWebApiErrorTemplate } from './webapi-error-templates.mjs';
import { recordHttpError } from './trace-store.mjs';

// One private continuation signing key per running store. Browser verification tokens can have a separate lifetime.
const pagingKeys = new WeakMap();
function pagingKey(store) {
  let key = pagingKeys.get(store);
  if (!key) {
    key = randomBytes(32);
    pagingKeys.set(store, key);
  }
  return key;
}

const WEBAPI_COUNT_LIMIT = 5000;
const KEY = "((?:'(?:[^']|'')*'|[^()'/])*)";
const ROUTE = new RegExp(
  String.raw`^([A-Za-z_]\w*)(?:\(${KEY}\))?(?:/([A-Za-z_]\w*|\$count)(?:\(${KEY}\))?)?(?:/(\$ref|\$value|\$count))?$`,
);
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const UNSUPPORTED_OPTIONS = new Set(['$skip', '$search', '$compute', 'savedQuery', 'userQuery']);
const unsupportedRoute = (segment) =>
  new DataError(`The portal Web API does not serve GET ${segment}.`, 400, 'UnsupportedQuery', { segment });
// The local /_api response contract omits
// OData-Version or Preference-Applied header; cache-control no-cache with Pragma and
// Expires (ASP.NET's no-cache pair); the site's HTTP/* headers as portal pages carry
// them (siteHeaders: the site Content-Security-Policy, X-Frame-Options, ...); and
// X-Content-Type-Options nosniff, which the Web API sends even when the site defines
// no HTTP/X-Content-Type-Options setting (portal pages then send none).
const CACHE_HEADERS = Object.freeze({
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  expires: '-1',
});
// Every hosted /_api response carries x-ms-request-id. A JSON answer to a GET, success or error of any status (200, 204,
// 400, 403, 404 and 500), also names it as the correlation id of its Server-Timing header; an answer to a write (POST,
// PUT, PATCH, DELETE; 204 or error, the chunked-upload 500 included) carries the response code alone; a text or binary
// answer has none (hosted session F1, runs a, b, a2 and b2: odata-shapes, predefined, refs, files, nav-followup).
const correlationHeaders = (status, { json = true, method = 'GET' } = {}) => {
  const id = randomUUID();
  if (!json) return { 'x-ms-request-id': id };
  const timing =
    method === 'GET' || method === 'HEAD'
      ? `response-code; desc=${status}, correlationId; desc=${id}`
      : `response-code; desc=${status}`;
  return { 'x-ms-request-id': id, 'server-timing': timing };
};
const apiHeaders = (portal) => ({
  'x-content-type-options': 'nosniff',
  ...siteHeaders(portal ?? {}),
  ...CACHE_HEADERS,
  ...portal?.observed?.headers?.webApi,
});
// Errors raised while Power Pages validates OData query options answer
// 400 9004010A with a generic message on the platform (unknown columns, invalid
// $filter, $expand or paths through a non-navigation property), as does an
// entity set that names no Dataverse table.
const QUERY_CODES = new Set([
  'InvalidAttribute',
  'UnsupportedQuery',
  'InvalidQuery',
  'MissingRelationship',
  'DuplicateQueryOption',
  'UnknownEntitySet',
  'UnsupportedKeySyntax',
]);
const queryPhase = (error) => {
  // These are Dataverse execution budgets, including permission-generated
  // joins. They must retain the CDS error envelope rather than being reported
  // as a portal OData grammar failure.
  if (
    ['0x8004430c', '0x8004430d'].includes(String(error?.details?.innerCode).toLowerCase()) &&
    error.details.phase == null
  )
    error.details = { ...error.details, phase: 'backend' };
  if (error && QUERY_CODES.has(error.code) && error.details?.phase == null)
    error.details = { ...error.details, phase: 'query' };
  return error;
};

const notFound = (segment) =>
  new DataError(`Resource not found for the segment ${segment}.`, 404, 'ResourceNotFound', { segment });
const unknownSet = (segment) =>
  new DataError(`No Dataverse table has the entity set name ${segment}.`, 400, 'UnknownEntitySet', {
    segment,
    phase: 'query',
  });
const methodNotAllowed = (method, target) =>
  new DataError(`The HTTP method '${method}' is not allowed for ${target}.`, 405, 'MethodNotAllowed');
const badRequest = (message, code = 'InvalidRequest', innerCode = '0x80040203') =>
  new DataError(message, 400, code, { innerCode });

/** Parse the path after /_api/ into a Web API resource description. */
export function parseWebApiRoute(pathname) {
  let path;
  try {
    path = decodeURIComponent(String(pathname).replace(/^\/_api\//, ''));
  } catch {
    throw badRequest('The request URI is not valid.', 'InvalidRoute', '0x0');
  }
  if (/^cloudflow(?:\/|$)/i.test(path)) return { kind: 'cloudflow', path };
  const match = ROUTE.exec(path);
  if (!match) throw notFound(path.split(/[/(]/)[0] || path);
  const [, set, rawKey, segment, navigationKey, tail] = match;
  const key = rawKey != null && rawKey.trim() !== '' ? rawKey.trim() : null;
  assertV4RouteKeys(key, navigationKey);
  return key == null
    ? collectionRoute(set, segment, navigationKey, tail)
    : keyedRoute(set, key, segment, navigationKey, tail);
}

function assertV4RouteKeys(key, navigationKey) {
  // The OData v2/v3 key literal guid'…' isn't OData v4 syntax: the platform rejects it
  // while parsing the URL, 400 9004010A, before any permission check.
  for (const literal of [key, navigationKey])
    if (literal != null && /^\s*guid'/i.test(literal))
      throw new DataError(
        `The key ${literal.trim()} uses OData v3 syntax; OData v4 GUID keys are bare.`,
        400,
        'UnsupportedKeySyntax',
        {
          segment: literal.trim(),
          phase: 'query',
        },
      );
}

function collectionRoute(set, segment, navigationKey, tail) {
  if (segment === '$count' && navigationKey == null && !tail) return { kind: 'count', set };
  if (segment == null && !tail) return { kind: 'collection', set };
  throw notFound(segment ?? tail);
}

function keyedRoute(set, key, segment, navigationKey, tail) {
  if (segment == null) {
    if (tail) throw notFound(tail);
    return { kind: 'entity', set, key };
  }
  if (segment === '$count') throw notFound(segment);
  if (navigationKey != null) {
    if (tail === '$ref') return { kind: 'ref', set, key, segment, targetKey: navigationKey.trim() };
    throw notFound(tail ?? segment);
  }
  if (tail === '$ref') return { kind: 'ref', set, key, segment };
  if (tail === '$value') return { kind: 'value', set, key, segment };
  if (tail === '$count') return { kind: 'navcount', set, key, segment };
  return { kind: 'member', set, key, segment };
}

/** Prefer header: include-annotations value (null when absent) and return=representation. */
export function parsePrefer(header) {
  const text = Array.isArray(header) ? header.join(',') : String(header ?? '');
  const annotations = /(?:^|[,;\s])odata\.include-annotations\s*=\s*(?:"([^"]*)"|([^,;\s"]*))/i.exec(text);
  return {
    annotations: annotations ? (annotations[1] ?? annotations[2] ?? '') : null,
    representation: /(?:^|[,;\s])return\s*=\s*representation(?:$|[,;\s])/i.test(text),
  };
}

/** OData include-annotations matcher: names, namespace.* patterns, * and -exclusions. */
export function annotationMatcher(value) {
  const patterns = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const matches = (pattern, term) => {
    const p = pattern.toLowerCase(),
      t = term.toLowerCase();
    return p === '*' || p === t || (p.endsWith('.*') && t.startsWith(p.slice(0, -1)));
  };
  return (term) =>
    patterns.some((pattern) => !pattern.startsWith('-') && matches(pattern, term)) &&
    !patterns.some((pattern) => pattern.startsWith('-') && matches(pattern.slice(1), term));
}

const stripAnnotations = (value, include) => {
  if (Array.isArray(value)) return value.map((item) => stripAnnotations(item, include));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const at = key.indexOf('@');
    const term = at < 0 ? null : key.slice(at + 1);
    if (term != null && !term.startsWith('odata.') && !include(term)) continue;
    out[key] = item && typeof item === 'object' ? stripAnnotations(item, include) : item;
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
  String(siteSetting(settings, name) ?? '')
    .trim()
    .toLowerCase() === 'true';

const POLICY_CODES = new Set([
  'WebApiFieldNotEnabled',
  'WebApiPrivateField',
  'WebApiColumnPermissionDenied',
  'WebApiFieldsNotConfigured',
  'WebApiColumnsViewUnresolved',
]);
const DEFAULT_INNER_CODES = {
  UnsupportedQuery: '0x0',
  InvalidQuery: '0x0',
  DuplicateQueryOption: '0x0',
  MissingRelationship: '0x0',
  QueryParamNotSupported: '0x80060888',
  InvalidPagingToken: '0x80060888',
  NotFound: '0x80040217',
  InvalidLookup: '0x80040217',
  DuplicateRecord: '0x80040237',
  PreconditionFailed: '0x80060882',
  PluginValidation: '0x80040265',
};

// innererror.type of each error code. Observed natively, with
// innererror on every error: 9004010A UnexpectedError,
// 9004010E ConfigurationResourceNotSupported, 9004010C ResourceDoesNotExists and
// 90040120 EntityPermissionReadIsMissing. The others are the documented error names
// (web-api-http-requests-handle-errors: the error code table and the 405 error types).
const ERROR_TYPES = Object.freeze({
  '9004010A': 'UnexpectedError',
  // Hosted session F1 (2026-11-26) with Webapi/error/innererror: $skip, $search, $compute, savedQuery and userQuery.
  '9004010B': 'QueryParamNotSupported',
  '9004010E': 'ConfigurationResourceNotSupported',
  90040120: 'EntityPermissionReadIsMissing',
  // Hosted session F7 (2026-11-27): the wildcard column list refusal.
  90040122: 'WebApiUnAuthorizedAccess',
  '900400FF': 'NoAttributesForTableCreate',
  90040100: 'InvalidAttribute',
  90040101: 'AttributePermissionIsMissing',
  90040102: 'TablePermissionWriteIsMissingDuringUpdate',
  90040103: 'TablePermissionCreateIsMissing',
  90040104: 'TablePermissionDeleteIsMissing',
  90040105: 'TablePermissionAppendIsMissngDuringAssociationChange',
  90040106: 'TablePermissionAppendToIsMissingDuringAssociationChange',
  90040107: 'HttpAntiForgeryException',
  90040109: 'MissingPortalSessionCookie',
  '9004010C': 'ResourceDoesNotExists',
  '9004010D': 'CDSError',
  InvalidOperation: 'InvalidOperation',
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
 *   keep the Dataverse code and message that portal scripts read without a type.
 *   Portal exceptions use ERROR_TYPES, or null for a code without a name.
 * The simulator's own classification travels in the X-Sim-Error-Code response header.
 */
export function webApiErrorResponse(
  error,
  {
    innerError = false,
    innerErrorScope = 'dataverse-errors',
    // The text of every hosted capture since 2026-11-08 (the demo site, hosted session F1); hosted session F1 also sent
    // error.cdscode on a Dataverse failure without the inner error setting (400 0x80060888 for a bad $filter literal).
    cdsErrorMessage = 'Common Data Service error occurred.',
    cdsErrorCode = 'cdscode',
    // Hosted session F4 (paqvilo-developer hosted-f4 swap runs a and b): every refused token answers 401 "Request validation
    // failed : " with its own reason; "cookie-mismatch-403" keeps the former local answer.
    antiForgery = 'decryption-401',
    invalidDate = 'invalid-format',
    errorDetails = 'diagnostic',
    errorStacks = 'diagnostic',
    errorTemplates,
    errorMethod,
    errorEntitySet,
    mutationPermissionText,
    selfNnPermissionErrors,
  } = {},
) {
  const status = Number(error?.status ?? error?.statusCode) || 500;
  const internal = error?.code == null ? null : String(error.code);
  const details = error?.details ?? {};
  const headers = internal ? { 'X-Sim-Error-Code': internal } : {};
  const everyError = innerErrorScope === 'all-errors';
  const respond = (httpStatus, code, message, inner) => {
    const body = { error: { code, message } };
    if (innerError && everyError && !details.hideInner)
      body.error.innererror = {
        code: inner?.code ?? code,
        message: inner?.message ?? message,
        ...(code === '9004010D' ? {} : { type: ERROR_TYPES[code] ?? null }),
      };
    else if (innerError && inner && !details.hideInner)
      body.error.innererror = { code: inner.code, message: inner.message };
    return { status: httpStatus, body, headers };
  };
  return (
    providerErrorResponse({ internal, status, details, respond, cdsErrorMessage, cdsErrorCode }) ??
    transportErrorResponse({ internal, status, error, details, respond, cdsErrorMessage, cdsErrorCode }) ??
    requestErrorResponse({ internal, status, error, details, respond }) ??
    permissionErrorResponse({ internal, details, respond, selfNnPermissionErrors, mutationPermissionText }) ??
    authenticationErrorResponse({ internal, error, respond, antiForgery }) ??
    standardErrorResponse({
      internal,
      status,
      error,
      details,
      respond,
      cdsErrorCode,
      cdsErrorMessage,
      errorDetails,
      errorStacks,
      errorTemplates,
      errorMethod,
      errorEntitySet,
      invalidDate,
    })
  );
}

// A filter join into a virtual table (500) and a failing provider behind a collection read or a collection $expand
// (400): 9004010D with the platform code, never the provider's own message (hosted session F1 follow-up 2026-11-27).
function providerErrorResponse({ internal, status, details, respond, cdsErrorMessage, cdsErrorCode }) {
  if (
    internal !== 'VirtualTableJoinUnsupported' &&
    !(internal === 'VirtualProviderFailed' && details.portalProviderRead === 'query')
  )
    return null;
  const response = respond(status, '9004010D', cdsErrorMessage, undefined);
  if (cdsErrorCode === 'cdscode') response.body.error.cdscode = details.innerCode;
  return response;
}

// The 9004010D CDS envelope with its inner error; the cdscode shape also names the inner code on the error itself.
function cdsErrorEnvelope({ status, details, respond, cdsErrorMessage, cdsErrorCode }, innererror, innerType = null) {
  const response = respond(status, '9004010D', cdsErrorMessage, innererror);
  if (innerType && response.body.error.innererror) response.body.error.innererror.type = innerType;
  if (cdsErrorCode === 'cdscode') response.body.error.cdscode = details.innerCode;
  return response;
}

// Whether a failure answers with the CDS envelope carrying the error's own message as its inner message.
const cdsInnerFailure = (internal, status, details) =>
  // A plug-in that rebound a portal query to a virtual table fails in the backend's SQL execution (data.mjs
  // reboundPluginQuery; hosted F1 DATA-01e): 500 with the CDS envelope and its inner code.
  (internal === 'PluginQueryBackendFailure' && status === 500) ||
  // GET /_api/<set>(id)/<image>/$value?size=thumbnail (hosted session F1 files, runs a and b): 400 with the CDS envelope.
  (internal === 'PortalImageSizeUnsupported' && status === 400) ||
  (internal === 'ODataPermissionNavigationFailure' &&
    details.phase === 'native-odata-conversion' &&
    [400, 501].includes(status));

function transportErrorResponse(context) {
  const { internal, status, error, details } = context;
  if (internal === 'PortalFetchTransportFailure' && details.phase === 'native-api-transport')
    return cdsErrorEnvelope(context, { code: details.innerCode, message: details.innerMessage }, 'CDSError');
  if (cdsInnerFailure(internal, status, details))
    return cdsErrorEnvelope(context, { code: details.innerCode, message: error.message });
  return null;
}

// The 500 9004010A answers without a trailing period: an invalid reference, the chunked-upload handshake, a reversed
// file download range (hosted session F1 API-04g) and a provider that fails a keyed read of its own table (hosted session
// F1 follow-up 2026-11-27).
const UNEXPECTED_FAILURES = new Set([
  'WebApiInvalidReference',
  'WebApiChunkedUploadUnsupported',
  'WebApiFileRangeReversed',
]);
const unexpectedFailure = (internal, details) =>
  UNEXPECTED_FAILURES.has(internal) ||
  (internal === 'VirtualProviderFailed' && details.portalProviderRead === 'retrieve');

// The status of a failure that answers 9004010A "An unexpected error occurred while processing the request", or 0.
function unexpectedRequestStatus(internal, details) {
  if (internal === 'PortalQueryAdmissionFailure' && details.phase === 'native-api-admission') return 500;
  if (details.phase === 'query' && QUERY_CODES.has(internal)) return 400;
  // A write payload the OData reader can't map (an @odata.bind name that isn't a navigation property).
  if (details.phase === 'payload' && internal === 'UndeclaredNavigationProperty') return 400;
  if (unexpectedFailure(internal, details)) return 500;
  return 0;
}

function requestErrorResponse({ internal, error, details, respond }) {
  const plain = undefined;
  const unexpected = unexpectedRequestStatus(internal, details);
  if (unexpected)
    return respond(unexpected, '9004010A', 'An unexpected error occurred while processing the request', plain);
  if (internal === 'WebApiQueryOptionNotSupported')
    return respond(400, '9004010B', `The ${details.option} query parameter is not supported`, plain);
  if (internal === 'WebApiConfigurationTable')
    return respond(404, '9004010E', `Configuration table ${details.table} is not supported.`, plain);
  if (['ResourceNotFound', 'WebApiTableNotEnabled', 'UnknownEntity'].includes(internal))
    return respond(
      404,
      '9004010C',
      `Resource not found for the segment ${details.table ?? details.segment ?? ''}.`,
      plain,
    );
  if (internal === 'InvalidAttribute')
    return respond(
      400,
      '90040100',
      `Attribute ${details.attribute} cannot be found for table ${details.table}.`,
      plain,
    );
  // Webapi/<table>/fields = * refuses every request for the table, before its columns or rows are read, as 403 90040122
  // naming no attribute (hosted session F1, summary-F.md section 1 and summary-A2.md, its probe tables; hosted session F7,
  // api-s0 and api-s1-loc, sharepointdocument and sharepointdocumentlocation, with innererror type
  // WebApiUnAuthorizedAccess). The local cause stays in X-Sim-Error-Code.
  if (internal === 'WebApiWildcardDeprecated')
    return respond(403, '90040122', 'You are unauthorized to process this request.', plain);
  if (POLICY_CODES.has(internal))
    return respond(
      403,
      '90040101',
      details.attribute && details.table
        ? `Attribute ${details.attribute} in table ${details.table} is not enabled for Web Api.`
        : error.message,
      plain,
    );
  return null;
}

// Native portal association refusals (captured 2026-11-23): a missing Append To or Append grant names the related
// table "to" the request's table; a collection-valued $ref without Write on its own row reads as a create refusal.
function associationErrorResponse(details, table, respond) {
  if (details.association)
    return respond(
      403,
      '90040106',
      `You don’t have permission to associate or disassociate table ${details.association.table} to ${details.association.to}`,
      undefined,
    );
  if (details.associationSourceWrite)
    return respond(403, '90040103', `You don’t have permission to create records for ${table} table.`, undefined);
  return null;
}

function permissionErrorResponse({ internal, details, respond, selfNnPermissionErrors, mutationPermissionText }) {
  if (internal !== 'PermissionDenied') return null;
  const plain = undefined;
  const operation = String(details.operation ?? '').toLowerCase(),
    table = details.table ?? '';
  const selfNn = details.portalSelfNnAssociation;
  if (
    ['append', 'appendto'].includes(operation) &&
    selfNn?.table === table &&
    details.related === table &&
    selfNnPermissionErrors?.[String(selfNn.schema).toLowerCase()] === 'native-classic'
  ) {
    const response = respond(
      403,
      '90040106',
      `You don’t have permission to associate or disassociate table ${table} to ${table}`,
      plain,
    );
    if (response.body.error.innererror)
      response.body.error.innererror.type = 'EntityPermissionAppendToIsMissingDuringAssociationChange';
    return response;
  }
  const association = associationErrorResponse(details, table, respond);
  if (association) return association;
  if (operation === 'create')
    return respond(403, '90040103', `You don't have permission to create ${table} entity.`, plain);
  if (operation === 'update' || operation === 'write')
    return respond(
      403,
      '90040102',
      mutationPermissionText === 'table'
        ? `You don’t have permission to update ${table} table.`
        : `You don't have permission to update ${table} entity.`,
      plain,
    );
  if (operation === 'delete')
    return respond(
      403,
      '90040104',
      mutationPermissionText === 'table'
        ? `You don’t have permission to delete ${table} table.`
        : `You don't have permission to delete ${table} entity.`,
      plain,
    );
  if (operation === 'append')
    return respond(
      403,
      '90040105',
      `You don't have permission to associate or disassociate table ${table} with ${details.related ?? ''}.`,
      plain,
    );
  if (operation === 'appendto')
    return respond(
      403,
      '90040106',
      `You don't have permission to associate or disassociate table ${table} to ${details.related ?? ''}`,
      plain,
    );
  // Read denial: 403 90040120, also for FetchXML link-entity tables.
  return respond(403, '90040120', `You don't have permission to read the ${table} table.`, plain);
}

// The anti-forgery validation texts of a refused token by its refusal (the token refusals of portal-request-tokens.mjs), as
// hosted session F4 answered them after "Request validation failed : " (paqvilo-developer hosted-f4 swap runs a and b).
const ANTI_FORGERY_TEXTS = Object.freeze({
  undecryptable:
    'The anti-forgery token could not be decrypted. If this application is hosted by a Web Farm or cluster, ensure that all machines are running the same version of ASP.NET Web Pages and that the <machineKey> configuration specifies explicit encryption and validation keys. AutoGenerate cannot be used in a cluster.',
  mismatch: 'The anti-forgery cookie token and form field token do not match.',
  user: 'The provided anti-forgery token was meant for a different claims-based user than the current user.',
});

/**
 * Refuse a write whose __RequestVerificationToken header is not `expected`: none is 401 MissingPortalRequestVerificationToken,
 * any other token 90040107 HttpAntiForgeryException carrying why it was refused (`refusal()`, portal-request-tokens.mjs),
 * which chooses its text (webApiErrorResponse).
 */
export function assertAntiForgeryToken(supplied, expected, refusal) {
  if (supplied == null || supplied === '')
    throw new DataError(
      'The required anti-forgery form field "__RequestVerificationToken" is not present.',
      401,
      'MissingPortalRequestVerificationToken',
    );
  if (supplied === expected) return;
  const reason = refusal?.() ?? 'undecryptable';
  throw new DataError(ANTI_FORGERY_TEXTS.mismatch, 403, 'HttpAntiForgeryException', {
    antiForgery: reason === 'mismatch' || reason === 'user' ? reason : 'undecryptable',
  });
}

function authenticationErrorResponse({ internal, error, respond, antiForgery }) {
  const plain = undefined;
  // Learn lists 401 for missing request-verification tokens and 90040107 for anti-forgery failures.
  if (internal === 'MissingPortalRequestVerificationToken')
    return respond(
      401,
      '90040107',
      antiForgery === 'decryption-401' ? 'Request validation failed : ' + error.message : error.message,
      plain,
    );
  if (internal === 'HttpAntiForgeryException')
    return respond(
      antiForgery === 'decryption-401' ? 401 : 403,
      '90040107',
      antiForgery === 'decryption-401'
        ? 'Request validation failed : ' +
            (ANTI_FORGERY_TEXTS[error.details?.antiForgery] ?? ANTI_FORGERY_TEXTS.undecryptable)
        : error.message,
      plain,
    );
  if (internal === 'MissingPortalSessionCookie')
    return respond(401, '90040109', 'An Invalid session token was passed into the throwing method.', plain);
  return null;
}

function standardErrorResponse(options) {
  const { internal, status, error, details, respond } = options;
  const plain = undefined;
  if (internal === 'NoAttributesForTableCreate')
    return respond(400, '900400FF', 'No attributes for Create Table action.', plain);
  if (internal === 'MethodNotAllowed') return respond(405, 'InvalidOperation', error.message, plain);
  if (internal === 'NotImplemented') return respond(501, 'NotImplemented', error.message, plain);
  // Every envelope carries a code: the Dataverse code when the error has one, else the local classification.
  if (status === 413)
    return respond(413, String(details.innerCode ?? internal ?? 'PayloadTooLarge'), error.message, plain);
  if (status === 409 && internal === 'StateConflict') return respond(409, internal, error.message, plain);
  // A local capability gap (501) keeps its status and reason; any other server failure is the portal's generic 9004010A.
  if (status === 501) return respond(501, 'NotImplemented', error.message, plain);
  if (status >= 500)
    return respond(status, '9004010A', 'An unexpected error occurred while processing the request.', plain);
  return dataverseErrorResponse(options);
}

function dataverseErrorResponse({
  internal,
  status,
  error,
  details,
  respond,
  cdsErrorCode,
  cdsErrorMessage,
  errorDetails,
  errorStacks,
  errorTemplates,
  errorMethod,
  errorEntitySet,
  invalidDate,
}) {
  const innerCode = String(
    observedODataInnerMessage(error, errorDetails) !== null
      ? '0x80048d19'
      : (details.innerCode ?? DEFAULT_INNER_CODES[internal] ?? '0x80040203'),
  );
  const invalidMinimum =
    internal === 'InvalidDateTime' &&
    (details.failedDateConversion || details.dateTimeBelowMinimum) &&
    invalidDate === 'crm-minimum';
  const message = invalidMinimum
    ? `DateTime is less than minumum value supported by CrmDateTime. Actual value: ${details.dateTimeActual ?? '01/01/0001 00:00:00'}, Minimum value supported: 01/01/1753 00:00:00`
    : observedDataverseMessage(error, errorDetails, errorStacks, errorTemplates, errorMethod, errorEntitySet);
  const response = respond(status, '9004010D', cdsErrorMessage, { code: innerCode, message });
  if (cdsErrorCode === 'cdscode' && !details.hideInner) {
    const { innererror, ...base } = response.body.error;
    response.body.error = { ...base, cdscode: innerCode, ...(innererror ? { innererror } : {}) };
  }
  return response;
}

function observedDataverseMessage(error, errorDetails, errorStacks, errorTemplates, errorMethod, errorEntitySet) {
  const observed = observedODataInnerMessage(error, errorDetails, { method: errorMethod, entitySet: errorEntitySet });
  if (observed === null) return error?.message ?? '';
  return appendObservedWebApiErrorTemplate(error, observed, {
    mode: errorStacks,
    templates: errorTemplates,
    method: errorMethod,
  });
}

/**
 * Handle one /_api request locally. deps: { store, portal, identity, csrf,
 * origin, origins, metadata, json, jsonBody, change, onError }.
 */
export async function handleWebApi(req, res, url, deps) {
  const cache = readCache(req, url, deps);
  if (cache?.hit) {
    const { status, body, headers } = cache.hit;
    return deps.json(res, status, structuredClone(body), {
      ...headers,
      ...correlationHeaders(status, { method: req.method }),
    });
  }
  try {
    await route(req, res, url, cache ? { ...deps, json: cache.capture(deps.json) } : deps);
  } catch (cause) {
    if (res.headersSent) throw cause;
    const response = webApiErrorResponse(cause, {
      innerError: settingTrue(deps.portal?.settings, 'Webapi/error/innererror'),
      innerErrorScope: deps.portal?.observed?.webApiInnerError,
      cdsErrorMessage: deps.portal?.observed?.webApiCdsErrorMessage,
      cdsErrorCode: deps.portal?.observed?.webApiCdsErrorCode,
      antiForgery: deps.portal?.observed?.webApiAntiForgery,
      invalidDate: deps.portal?.observed?.webApiInvalidDate,
      errorDetails: deps.portal?.observed?.webApiErrorDetails,
      errorStacks: deps.portal?.observed?.webApiErrorStacks,
      errorTemplates: deps.webApiErrorTemplates,
      errorMethod: req.method,
      errorEntitySet: diagnosticEntitySet(url.pathname),
      mutationPermissionText: deps.portal?.observed?.webApiMutationPermissionText,
      selfNnPermissionErrors: deps.portal?.observed?.webApiSelfNnPermissionErrors,
    });
    deps.onError?.(cause, response);
    // An observed file download refusal is sent with its length, as hosted session F1 captured it (API-04g).
    const wireText = cause?.details?.exactLength ? stringifyExactJson(response.body) : undefined;
    deps.json(
      res,
      response.status,
      response.body,
      {
        ...apiHeaders(deps.portal),
        ...correlationHeaders(response.status, { method: req.method }),
        ...response.headers,
        ...(wireText === undefined ? {} : { 'content-length': String(Buffer.byteLength(wireText)) }),
      },
      ...(wireText === undefined ? [] : [{ wireText }]),
    );
  }
}

// observed.webApiReadCache { seconds }: a site observed serving repeated identical successful GETs from a cache without
// calling a provider (hosted session F1 follow-up 2026-11-27, runs a and b: for at least 3 min 15 s and under 6 min 55 s;
// errors were not cached; a changed query was read afresh). The evidence does not establish the key, so Mirage keys it
// conservatively: the visitor (identity, roles, web role ids), the exact request (path, query, Prefer and Accept) and the
// local data revision, so a local write, a permission change or another visitor reads afresh. Only 200 JSON answers are
// kept; a conditional request is never answered from it. Off unless observed.
const readCaches = new WeakMap();
const READ_CACHE_LIMIT = 500;
function readCache(req, url, deps) {
  const seconds = deps.portal?.observed?.webApiReadCache?.seconds;
  const store = deps.store;
  // The observed window, also for an observation that did not come through lib/project-config.mjs.
  const lifetime = Number.isInteger(seconds) && seconds >= 195 && seconds <= 414;
  if (!lifetime || req.method !== 'GET' || req.headers['if-none-match'] || typeof store?.dataRevision !== 'function')
    return null;
  const identity = deps.identity ?? {};
  const sorted = (values) => [...(values ?? [])].map(String).sort(compareText);
  const key = JSON.stringify({
    visitor: [identity.id ?? null, identity.contactId ?? null, Boolean(identity.admin)],
    roles: sorted(identity.roles),
    roleIds: sorted(identity.roleIds),
    path: url.pathname,
    query: url.search,
    prefer: req.headers.prefer ?? null,
    accept: req.headers.accept ?? null,
    revision: String(store.dataRevision()),
  });
  const now = Number(store.clock?.now?.() ?? Date.now());
  let entries = readCaches.get(store);
  if (!entries) {
    entries = new Map();
    readCaches.set(store, entries);
  }
  const found = entries.get(key);
  if (found && found.expires > now) return { hit: found };
  entries.delete(key);
  return {
    capture:
      (json) =>
      (out, status, body, headers = {}, options) => {
        if (status === 200 && body && typeof body === 'object' && !options) {
          const kept = Object.fromEntries(
            Object.entries(headers).filter(
              ([name]) => !['x-ms-request-id', 'server-timing'].includes(name.toLowerCase()),
            ),
          );
          if (entries.size >= READ_CACHE_LIMIT) entries.delete(entries.keys().next().value);
          entries.set(key, { status, body: structuredClone(body), headers: kept, expires: now + seconds * 1000 });
        }
        return json(out, status, body, headers, options);
      },
  };
}
const compareText = (left, right) => (left < right ? -1 : Number(left > right));

function diagnosticEntitySet(pathname) {
  try {
    return decodeURIComponent(/^\/_api\/([^/(]+)/.exec(pathname)?.[1] ?? '');
  } catch {
    // Formatting an earlier authentication or route failure must not replace it.
    return undefined;
  }
}

/* NOSONAR: preserve asynchronous lifecycle and concurrent operation ordering */ async function route(
  req,
  res,
  url,
  deps,
) {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const seen = new Set();
  for (const key of url.searchParams.keys()) {
    if (seen.has(key))
      throw queryPhase(
        badRequest(
          `Query option '${key}' was specified more than once, but it must be specified at most once.`,
          'DuplicateQueryOption',
          '0x0',
        ),
      );
    seen.add(key);
  }
  if (WRITE_METHODS.has(method)) {
    assertAntiForgeryToken(req.headers.__requestverificationtoken, deps.csrf, deps.tokenRefusal);
  } else if (method !== 'GET') throw methodNotAllowed(method, 'the portals Web API');
  // The code component EntityDefinitions read (portal-entity-definitions.mjs); other metadata paths are refused there.
  if (isPortalEntityDefinitionsPath(url.pathname)) {
    const answer = await portalEntityDefinition({
      method,
      url,
      origin: deps.origin,
      identity: deps.identity,
      metadata: deps.entityMetadata?.(),
      portal: policyPortal(deps.store, deps),
      headers: req.headers,
    });
    return deps.json(res, answer.status, answer.body, apiHeaders(deps.portal));
  }
  const target = parseWebApiRoute(url.pathname);
  assertWebRoleNavigation(deps, target);
  if (target.kind === 'cloudflow')
    throw new DataError(
      `Cloud flow triggers are not run locally; configure a simulator endpoint for ${url.pathname} to answer this request.`,
      501,
      'NotImplemented',
    );
  const t = requestContext(req, res, url, deps, target, method);
  const traces = deps.store.traces;
  const span = traces?.start({
    kind: 'webapi',
    name: `${req.method} ${target.set}`,
    module: 'webapi',
    operation: webApiOperation(method, target),
    entity: t.mapping.logicalName,
    recordId: target.key ?? null,
    attributes: { target: target.kind, prefer: req.headers.prefer },
  });
  if (!span?.enabled) return routeTarget(t, method, target, url);
  t.span = span;
  // The response the handler writes names the outcome: a row count for a collection, the id of a created row.
  let answered = null;
  const responseDeps = t.deps;
  t.deps = {
    ...responseDeps,
    json: (out, status, body, headers) => {
      answered = { body, headers };
      return responseDeps.json(out, status, body, headers);
    },
  };
  try {
    await traces.run(span, () => routeTarget(t, method, target, url));
  } catch (error) {
    span.fail(error);
    throw error;
  }
  const status = res.statusCode;
  const rowCount = Array.isArray(answered?.body?.value) ? answered.body.value.length : undefined;
  const entityId = answered?.headers?.['OData-EntityId'] ?? answered?.headers?.['odata-entityid'];
  const id = typeof entityId === 'string' ? (/\(([^()]+)\)$/.exec(entityId)?.[1] ?? undefined) : undefined;
  span.output(() => ({ status, ...(rowCount === undefined ? {} : { rowCount }), ...(id ? { id } : {}) }));
  // A created row names the span's record; an error envelope the handler answered itself is the span's error (D-R3-4).
  if (id && !span.recordId) span.setEntity(t.mapping.logicalName, id);
  recordHttpError(span, status, answered?.body?.error);
  span.end({ attributes: { statusCode: status, rowCount, id } });
}

/**
 * The 403 of a refused table read; the refusal is the deny `permission` event of the current span, as a refused create or
 * delete is (D-R3-11).
 */
function readDenied(store, table) {
  const message = `Table permission denies read on ${table}`;
  store.traceDenial?.({
    table,
    operation: 'read',
    model: store.portalAuthorization?.describe().model ?? 'standard',
    permissions: [],
    message,
  });
  return new DataError(message, 403, 'PermissionDenied', { operation: 'read', table });
}

// The span operation of a portal Web API request (docs/design/tracing.md span model).
function webApiOperation(method, target) {
  if (method === 'GET')
    return target.kind === 'collection' || target.kind === 'navcount' ? 'retrievemultiple' : 'retrieve';
  if (target.kind === 'ref') return method === 'DELETE' ? 'disassociate' : 'associate';
  if (method === 'POST') return target.kind === 'collection' ? 'create' : 'action';
  return method === 'DELETE' && target.kind === 'entity' ? 'delete' : 'update';
}

async function routeTarget(t, method, target, url) {
  // Options the portal refuses before any route projects or discards them: 400 9004010B "The <option> query parameter
  // is not supported" on every route shape (hosted session F1, API-02c and API-03b, two runs: $skip, $search, $compute,
  // savedQuery with a real, a random and a malformed id, on a keyed read and on /$count, and userQuery). The first such
  // option in the URL is named.
  const unsupported = [...url.searchParams.keys()].find((key) => UNSUPPORTED_OPTIONS.has(key));
  if (unsupported)
    throw new DataError(`The ${unsupported} query parameter is not supported`, 400, 'WebApiQueryOptionNotSupported', {
      option: unsupported,
    });
  // Reading a navigation's references (GET .../<navigation>/$ref) is malformed for the portal: 400 9004010A (hosted
  // session F1, API-02c, two runs). Associations through $ref stay POST and DELETE.
  if (method === 'GET' && target.kind === 'ref') throw queryPhase(unsupportedRoute('$ref'));
  // A navigation's $count answers 400 9004010A in every shape: collection-valued and single-valued, to an ordinary and to
  // a provider-backed table, on Contact- and Global-scope tables (hosted session F1 follow-up 2026-11-27, runs a and b).
  // A constant answer tells nothing about the related rows.
  if (method === 'GET' && target.kind === 'navcount' && ownRelationship(t.mapping, target.segment))
    throw queryPhase(unsupportedRoute('/$count of a navigation'));
  // A read observer can issue independently committed SDK writes. Finish the
  // serialized read unit before sending a successful response, including text
  // properties and conditional 304s, so persistence failures remain errors.
  const execute = () =>
    method === 'GET' && typeof t.store.readOperation === 'function' ? dispatchRead(t) : dispatch(t);
  if (method === 'GET' && !(target.kind === 'collection' && url.searchParams.has('fetchXml')))
    try {
      return await execute();
    } catch (error) {
      throw queryPhase(error);
    }
  return execute();
}

async function dispatchRead(t) {
  let response;
  let attachments = [];
  const pending = {
    writeHead(status, headers) {
      response = { status, headers, raw: true };
    },
    end(body) {
      response = { ...response, raw: true, body };
    },
  };
  const buffered = {
    ...t,
    res: pending,
    deps: {
      ...t.deps,
      json(_res, status, body, headers) {
        response = { status, body, headers };
      },
    },
  };
  await t.store.readOperation(async () => {
    await preparePortalRead(t, () => dispatch(buffered));
    if (response?.status === 200 && !response.raw) attachments = captureAttachments(t, response.body);
  });
  if (!response) throw new DataError('The read operation produced no response.', 500, 'InvalidReadResponse');
  for (const { row, column, load } of attachments) row[column] = await load();
  if (response.raw) {
    t.res.writeHead(response.status, response.headers);
    return t.res.end(response.body);
  }
  return t.deps.json(t.res, response.status, response.body, response.headers);
}

function preparePortalRead(t, execute) {
  const { kind } = t.target;
  const params = t.url.searchParams;
  if (
    typeof t.store.withPortalReadSources !== 'function' ||
    (kind === 'collection' && params.has('fetchXml')) ||
    kind === 'ref'
  )
    return execute();
  const query = assertPortalReadQuery(t);
  // The native-classic adapter refuses navigation and lambda filters itself; $expand and $apply run the modeled pipeline
  // (data.mjs nativeScalarODataRead).
  const local =
    query && (t.deps.identity?.admin || t.store.observed?.odataPermissionQueryPipeline !== 'native-classic');
  const key = t.target.key;
  return portalProviderFailure(
    t,
    t.store.withPortalReadSources(
      t.deps.identity,
      {
        table: t.mapping.logicalName,
        id: key != null && !String(key).includes('=') ? locate(t, t.mapping, key).id : null,
        expand: params.get('$expand'),
        navigation: t.mapping.relationships?.[t.target.segment] ? t.target.segment : null,
        queryPaths: local ? portalQueryPaths(t.store, query.mapping, query.params) : null,
        params: kind === 'collection' ? params : null,
        onProviderRows: (logical, rows) => reportExposedProviderColumns(t, logical, rows),
      },
      execute,
    ),
  );
}

/**
 * A provider that fails a portal read: a keyed read answers 500 9004010A, a collection read or a collection $expand 400
 * 9004010D with cdscode 0x80040265, the provider's message hidden (hosted session F1 follow-up 2026-11-27, runs a and b,
 * throwing provider).
 */
async function portalProviderFailure(t, read) {
  try {
    return await read;
  } catch (error) {
    if (error?.code !== 'VirtualProviderFailed') throw error;
    // The keyed read of a provider-backed table itself; an expansion behind a keyed read of another table fails as a query.
    const retrieve =
      t.target.kind === 'entity' &&
      Boolean(t.store.recordPipeline?.virtualProviders?.status(t.mapping.logicalName).virtual);
    error.status = error.statusCode = retrieve ? 500 : 400;
    error.details = { ...error.details, portalProviderRead: retrieve ? 'retrieve' : 'query', innerCode: '0x80040265' };
    throw error;
  }
}

/**
 * A hosted site returns every column a provider answers, outside Webapi/<table>/fields and $select too (hosted session F1
 * follow-up 2026-11-27, runs a and b; the test provider ignored the ColumnSet). Mirage keeps the column list on provider
 * rows (security decision) and reports the columns the live site would expose.
 */
function reportExposedProviderColumns(t, logical, rows) {
  const providers = t.store.recordPipeline?.virtualProviders;
  if (typeof providers?.report !== 'function' || !rows?.length) return;
  let policy;
  try {
    policy = webApiPolicy(policyPortal(t.store, t.deps), t.store, logical);
  } catch {
    // A table the Web API does not enable shows nothing to a visitor.
    return;
  }
  const exposed = new Set();
  for (const row of rows)
    for (const name of Object.keys(row))
      if (!name.startsWith('@') && !/^__sim/i.test(name) && !policy.allowed(name)) exposed.add(name);
  if (!exposed.size) return;
  const columns = [...exposed].sort((left, right) => (left < right ? -1 : Number(left > right)));
  providers.report({
    code: 'WEBAPI_PROVIDER_COLUMNS_HOSTED_EXPOSED',
    severity: 'warning',
    table: logical,
    operation: 'portal-read',
    columns,
    message: `The provider of virtual table '${logical}' returned ${columns.join(', ')} outside Webapi/${logical}/fields. A hosted Power Pages site returns every column the provider answers, whatever the column list and $select, so the live site exposes them; Mirage keeps the column list. Return only listed columns from the provider (honour the ColumnSet) or list them.`,
  });
}

/**
 * The column-policy and table-permission refusals a read route makes without reading rows, made before any provider read
 * so a provider failure cannot hide them. Returns the table and options the route queries, or null for a route that
 * runs no query.
 */
function assertPortalReadQuery(t) {
  const { kind, segment } = t.target;
  const params = t.url.searchParams;
  if (kind === 'collection') {
    assertCollectionQuery(t, t.mapping, t.policy, params);
    return { mapping: t.mapping, params };
  }
  if (kind === 'entity' || kind === 'count') return assertOwnTableRead(t, kind, params);
  if (kind === 'member') assertMemberRead(t);
  const rel = kind === 'member' ? ownRelationship(t.mapping, segment) : null;
  if (!rel) return null;
  if (kind === 'member' && rel.many !== false) assertCollectionNavigation(t);
  else t.policy.assertPath([segment]);
  const mapping = t.store.resolveMapping(rel.entity);
  const policy = webApiPolicy(policyPortal(t.store, t.deps), t.store, mapping.logicalName);
  if (rel.many !== false) {
    assertCollectionQuery(t, mapping, policy, params);
    return { mapping, params };
  }
  const read = pick(params, ['$select', '$expand']);
  policy.assertQuery(read);
  if (!read.has('$select') && !policy.fields.includes('*')) policy.assertSelectLess();
  assertExpandReadable(t, t.mapping, null, [{ navigation: segment, expand: parseExpand(read.get('$expand')) }]);
  return { mapping, params: read };
}

// A keyed read or /$count of the request's own table: its options, its select-less read and its expansions.
function assertOwnTableRead(t, kind, params) {
  const read = pick(params, kind === 'entity' ? ['$select', '$expand'] : ['$filter']);
  t.policy.assertQuery(kind === 'entity' ? params : read);
  if (kind === 'count') assertTableReadable(t, t.mapping);
  if (!read.has('$select')) t.policy.assertSelectLess();
  if (kind === 'entity') assertExpandReadable(t, t.mapping, read.get('$expand'));
  if (kind === 'count') assertNoProviderJoin(t, t.mapping, read);
  return { mapping: t.mapping, params: read };
}

/**
 * A $filter path that continues into a provider-backed (virtual) table, `<lookup>/<column>` or an any/all lambda body,
 * answers 500 9004010D "Common Data Service error occurred." with cdscode 0x80044150 and the provider is never called: the
 * platform cannot join a virtual table in the query it builds (hosted session F1 follow-up 2026-11-27, runs a and b,
 * healthy and throwing provider). A path that ends at the navigation (`<lookup> eq null`, a body-less any) was not
 * captured and keeps the earlier model. Checked after the column, table-permission and select-less refusals, before any
 * provider read.
 * The paths of an $apply answer the same: a filter() path into the virtual table, a lookup path or an any lambda, with
 * or without a following aggregate (hosted session F1 follow-up (2) 2026-11-27, runs a and b, nav-followup-nested:
 * apply-lookup-filter-count, apply-collection-any, apply-collection-any-count; the provider was never called). A groupby
 * or aggregate path into the virtual table was not captured; it needs the same join and is refused alike (fail closed).
 */
function assertNoProviderJoin(t, mapping, params) {
  const providers = t.store.recordPipeline?.virtualProviders;
  const filter = params.get('$filter');
  const apply = params.get('$apply');
  if (!providers || (!filter && !apply)) return;
  const aliases = Object.fromEntries([...params].filter(([key]) => key.startsWith('@')));
  const paths = [
    ...(filter ? expressionPaths(parseODataExpression(filter, { dialect: 'dataverse', aliases })) : []),
    ...(apply ? applyPaths(parseApply(apply, { dialect: 'dataverse', aliases })) : []),
  ];
  for (const segments of paths) {
    let current = mapping;
    for (const [index, segment] of segments.entries()) {
      const rel = ownRelationship(current, segment);
      if (!rel) break;
      current = t.store.resolveMapping(rel.entity);
      if (index < segments.length - 1 && providers.status(current.logicalName).virtual)
        throw new DataError(
          `A query path into virtual table ${current.logicalName} needs a join the platform cannot build.`,
          500,
          'VirtualTableJoinUnsupported',
          { innerCode: '0x80044150', table: current.logicalName },
        );
    }
  }
}

const ownRelationship = (mapping, name) =>
  name != null && own(mapping.relationships ?? {}, name) ? mapping.relationships[name] : null;

const allColumnsDenied = (table) =>
  new DataError(`Attribute All Columns in table ${table} is not enabled for Web Api.`, 403, 'WebApiFieldNotEnabled', {
    attribute: 'All Columns',
    table,
  });

/**
 * The member routes a GET may read (hosted session F1, API-02c, two runs, each with the segment's column listed): a
 * single-valued navigation to a row of the same table is served; a column (/<column>; its /$value is served), a
 * single-valued navigation to another table and a collection-valued navigation to another table answer 403 90040101
 * "Attribute All Columns in table <table> is not enabled for Web Api."; a collection-valued navigation to the same table
 * names itself ("Attribute <navigation> in table <table> ..."). Each refusal came before any backend query in both runs,
 * so it does not depend on the permission scope. `observed.webApiMemberReads: served` keeps the former local model.
 */
function assertMemberRead(t) {
  if (t.deps.portal?.observed?.webApiMemberReads === 'served') return;
  const { mapping, target } = t;
  const rel = ownRelationship(mapping, target.segment);
  const related = rel ? t.store.resolveMapping(rel.entity) : null;
  const sameTable = related?.logicalName === mapping.logicalName;
  // A related table the caller cannot read is refused first, 403 90040120 naming it (hosted session F1 AUTH-03c, replayed
  // by portal-webrole-refs/hosted-f1-without-settings#read-contact-roles-nav; with the read granted the same request
  // answered 403 All Columns).
  if (
    related &&
    !t.deps.identity?.admin &&
    t.store.state.settings?.permissionMode !== 'permissive' &&
    !t.store.rules(related.logicalName, 'read', t.deps.identity).length
  )
    throw readDenied(t.store, related.logicalName);
  if (rel?.many === false && sameTable) return;
  if (rel && rel.many !== false && sameTable)
    throw new DataError(
      `Attribute ${target.segment} in table ${mapping.logicalName} is not enabled for Web Api.`,
      403,
      'WebApiFieldNotEnabled',
      { attribute: target.segment, table: mapping.logicalName },
    );
  throw allColumnsDenied(mapping.logicalName);
}

/**
 * Navigation paths, qualified from the queried table, that evaluating its $filter (any/all lambdas included), every
 * $filter nested in its $expand and every $apply filter, groupby property and aggregate path follows. Each path lists
 * navigation segments only. A collection-valued hop counts only as the collection of a lambda: the query engine refuses
 * it anywhere else, and a refused query reads no provider.
 */
function portalQueryPaths(store, mapping, params) {
  const aliases = Object.fromEntries([...params].filter(([key]) => key.startsWith('@')));
  const parse = (expression) => parseODataExpression(expression, { dialect: 'dataverse', aliases });
  const paths = [];
  // The table a path reaches when every hop is traversable, else null. The last segment is a column unless collection.
  const follow = (owner, hops, collection) => {
    let current = owner;
    for (const [index, name] of hops.entries()) {
      const rel = ownRelationship(current, name);
      if (!rel || (rel.many !== false) !== (collection && index === hops.length - 1)) return null;
      current = store.resolveMapping(rel.entity);
    }
    return current;
  };
  const segmentsOf = (node) => {
    if (node.type === 'path') return node.segments;
    if (node.type === 'lambda') return node.path;
    const name = node.params?.PropertyName;
    return name?.type === 'literal' && typeof name.value === 'string' ? name.value.split('/') : null;
  };
  // A path, lambda or property-name function: the navigation hops it follows, then the body of a lambda.
  const visitPath = (node, base, scope) => {
    const segments = segmentsOf(node);
    if (!segments?.length) return;
    const origin = scope.get(segments[0]);
    const from = origin ?? base;
    const relative = origin ? segments.slice(1) : segments;
    const lambda = node.type === 'lambda';
    const hops = lambda ? relative : relative.slice(0, -1);
    const target = follow(from.mapping, hops, lambda);
    if (!target) return;
    const qualified = [...from.prefix, ...hops];
    if (hops.length) paths.push(qualified);
    if (lambda && node.body)
      visit(node.body, base, new Map([...scope, [node.variable, { mapping: target, prefix: qualified }]]));
  };
  const visit = (node, base, scope) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'path' || node.type === 'lambda' || node.type === 'crm') {
      visitPath(node, base, scope);
      return;
    }
    for (const key of ['left', 'right', 'operand', 'body']) visit(node[key], base, scope);
    for (const list of [node.args, node.values])
      if (Array.isArray(list)) for (const item of list) visit(item, base, scope);
  };
  const expand = (owner, prefix, specs) => {
    for (const spec of specs) {
      const rel = ownRelationship(owner, spec.navigation);
      if (!rel) continue;
      const target = store.resolveMapping(rel.entity);
      const nested = [...prefix, spec.navigation];
      if (spec.filter) visit(parse(spec.filter), { mapping: target, prefix: nested }, new Map());
      expand(target, nested, spec.expand ?? []);
    }
  };
  const filter = params.get('$filter');
  if (filter) visit(parse(filter), { mapping, prefix: [] }, new Map());
  expand(mapping, [], parseExpand(params.get('$expand')));
  // A step after a groupby reads aggregate aliases, which follow no relationship of the table.
  const apply = params.get('$apply');
  for (const step of apply ? parseApply(apply, { dialect: 'dataverse', aliases }) : []) {
    if (step.ast) visit(step.ast, { mapping, prefix: [] }, new Map());
    const read = [...(step.properties ?? []), ...(step.aggregates ?? []).map((aggregate) => aggregate.path)];
    for (const segments of read.filter(Boolean))
      visitPath({ type: 'path', segments }, { mapping, prefix: [] }, new Map());
  }
  return paths;
}

// A stored attachment body projects as null. Capture it alongside the admitted rows and load its bytes after the read.
// ponytail: bodies under $expand of another table are not read back; add the walk when a portal page expands notes.
function captureAttachments(t, body) {
  const logical = t.mapping?.logicalName;
  const column = ATTACHMENT_COLUMNS[logical];
  const { captureAttachmentBody, attachmentBody } = t.deps;
  if (!column || (!captureAttachmentBody && !attachmentBody) || !body || typeof body !== 'object') return [];
  const idColumn = t.mapping.idColumn;
  const attachments = [];
  for (const row of Array.isArray(body.value) ? body.value : [body]) {
    if (!row || typeof row !== 'object' || !own(row, column) || row[column] != null || !row[idColumn]) continue;
    const record = { [idColumn]: row[idColumn] };
    const load = captureAttachmentBody ? captureAttachmentBody(logical, record) : () => attachmentBody(logical, record);
    if (load) attachments.push({ row, column, load });
  }
  return attachments;
}

function dispatch(t) {
  const { url, target, method } = t;
  switch (target.kind) {
    case 'collection':
      return dispatchCollection(t, url, method);
    case 'count':
      return dispatchCount(t, method);
    case 'entity':
      return dispatchEntity(t, method);
    case 'member':
      return dispatchMember(t, method, target);
    case 'value':
      return dispatchValue(t, method);
    case 'navcount':
      if (method === 'GET') return getNavigationCount(t);
      throw methodNotAllowed(method, '$count');
    case 'ref':
      return reference(t);
    default:
      throw notFound(target.set);
  }
}

function dispatchCollection(t, url, method) {
  if (method === 'GET') return url.searchParams.has('fetchXml') ? getFetch(t) : getCollection(t);
  if (method === 'POST') return createEntity(t);
  throw methodNotAllowed(method, 'an entity set');
}

function dispatchCount(t, method) {
  if (method === 'GET') return getCount(t);
  throw methodNotAllowed(method, '$count');
}

function dispatchEntity(t, method) {
  if (method === 'GET') return getEntity(t);
  if (method === 'PATCH') return patchEntity(t);
  if (method === 'DELETE') return deleteEntity(t);
  throw methodNotAllowed(method, 'an entity');
}

function dispatchMember(t, method, target) {
  if (method === 'GET') assertMemberRead(t);
  if (t.mapping.relationships?.[target.segment]) {
    if (method === 'GET') return getNavigation(t);
    throw methodNotAllowed(method, 'a navigation property; use $ref or @odata.bind');
  }
  if (fileKind(t) && ['PUT', 'PATCH', 'DELETE'].includes(method)) return fileColumnRequest(t);
  if (method === 'GET') return getProperty(t, false);
  if (method === 'PUT') return putProperty(t);
  if (method === 'DELETE') return deleteProperty(t);
  throw methodNotAllowed(method, 'a property');
}

function dispatchValue(t, method) {
  if (method === 'GET') return fileKind(t) ? fileColumnRequest(t) : getProperty(t, true);
  throw methodNotAllowed(method, '$value');
}

/**
 * Resolve an entity set segment; Web API segments are case-sensitive entity set names.
 * A segment that names no Dataverse table answers 400 9004010A, a known table that
 * isn't enabled 404 9004010C with its logical name (webApiPolicy), as the platform
 * answers. Known tables are the local mappings (including
 * tables the simulated Dataverse API seeds or creates), data and site tables, and the
 * Power Pages tables every environment has (POWER_PAGES_TABLES).
 */
function resolveSet(store, set, pcfLogicalName) {
  if (pcfLogicalName !== undefined) return resolveLogicalSegment(store, set);
  // The entity set name wins over a table whose logical name happens to equal it (a
  // table named x_products doesn't shadow the x_products set of x_product).
  const owner = Object.entries(store.state?.mappings ?? {}).find(([, value]) => value?.entitySet === set);
  if (owner) return store.resolveMapping(owner[0]);
  let mapping = null;
  try {
    mapping = store.resolveMapping(set);
  } catch (error) {
    if (!(error.status === 404 || error.code === 'UnknownEntity')) throw error;
  }
  if (mapping?.entitySet === set) return mapping;
  const table = POWER_PAGES_TABLES.get(set);
  if (table)
    throw new DataError(`Resource not found for the segment '${set}'.`, 404, 'WebApiTableNotEnabled', {
      segment: set,
      table,
    });
  throw unknownSet(set);
}

/**
 * A segment of a request carrying pcf-entity-logical-name (the code component host's webAPI calls) is read as a table
 * logical name only (captured, paqvilo-developer pcf-parity summary-A3 and summary-F section 1, runs fa and fb): the
 * logical name of a known table resolves, an entity set name or an unknown name answers 400 9004010A. Without the
 * header resolveSet reads entity set names only (a logical name answers 400 9004010A). The header's value is not
 * compared with the segment (the host sends the same name in both; other combinations are not captured).
 */
function resolveLogicalSegment(store, set) {
  let mapping = null;
  try {
    mapping = store.resolveMapping(set);
  } catch (error) {
    if (!(error.status === 404 || error.code === 'UnknownEntity')) throw error;
  }
  if (mapping?.logicalName === set) return mapping;
  if ([...POWER_PAGES_TABLES.values()].includes(set))
    throw new DataError(`Resource not found for the segment '${set}'.`, 404, 'WebApiTableNotEnabled', {
      segment: set,
      table: set,
    });
  throw unknownSet(set);
}

/** The 48 portal configuration tables answer 404 9004010E whether mapped or not. */
function configurationTable(store, set) {
  try {
    const logical = store.resolveMapping(set).logicalName;
    if (WEBAPI_UNSUPPORTED_TABLES.has(logical)) return logical;
  } catch {
    // Unmapped: fall back to the entity set spelling below.
  }
  if (WEBAPI_UNSUPPORTED_TABLES.has(set)) return set;
  for (const suffix of ['es', 's'])
    if (set.endsWith(suffix) && WEBAPI_UNSUPPORTED_TABLES.has(set.slice(0, -suffix.length)))
      return set.slice(0, -suffix.length);
  return null;
}

function requestContext(req, res, url, deps, target, method) {
  const { store } = deps;
  const configuration = configurationTable(store, target.set);
  if (configuration)
    throw new DataError(`Configuration table ${configuration} is not supported.`, 404, 'WebApiConfigurationTable', {
      table: configuration,
    });
  const mapping = resolveSet(store, target.set, req.headers['pcf-entity-logical-name']);
  const policy = webApiPolicy(policyPortal(store, deps), store, mapping.logicalName);
  const prefer = parsePrefer(req.headers.prefer);
  const include = prefer.annotations == null ? null : annotationMatcher(prefer.annotations);
  const settings = store.state.settings ?? {};
  const formatter = createWebApiFormatter({
    store,
    identity: deps.identity,
    metadata: deps.metadata,
    formatting: {
      primaryKeyFirst:
        req.method === 'GET' &&
        target.segment == null &&
        deps.portal?.observed?.webApiReadResponse === 'jsonnet-indented',
      timeZoneOffsetMinutes: Number(settings.timeZoneOffsetMinutes ?? 0),
      formattedValueTimeZone: settings.formattedValueTimeZone,
      dateFormat: settings.dateFormat,
      timeFormat: settings.timeFormat,
      dateTimeFormat: settings.dateTimeFormat,
      currencySymbol: settings.currencySymbol,
    },
  });
  return {
    req,
    res,
    url,
    deps: { ...deps, json: responseWriter(req, target, deps) },
    store,
    target,
    method,
    mapping,
    policy,
    prefer,
    include,
    formatter,
  };
}

// ---- response helpers

// Apply wire encoding only at the final response sink. Buffered reads retain their
// structured payload through commit, attachment hydration and response tracing.
function responseWriter(req, target, deps) {
  return (out, status, payload, headers = {}) => {
    if (target.segment == null) {
      if (status === 200 && req.method === 'GET' && deps.portal?.observed?.webApiReadResponse === 'jsonnet-indented') {
        const text = JSON.stringify(
          payload,
          (_key, value) => (isExactNumeric(value) ? JSON.rawJSON(stringifyExactJson(value)) : value),
          2,
        ).replaceAll('\n', '\r\n');
        return deps.json(out, status, payload, headers, { wireText: text });
      }
      if (
        status === 204 &&
        ['POST', 'PATCH'].includes(req.method) &&
        deps.portal?.observed?.webApiWriteResponse === 'portal-classic'
      ) {
        return deps.json(out, status, payload, headers, { omitContentType: true });
      }
    }
    return deps.json(out, status, payload, headers);
  };
}

const send = async (t, status, body, headers = {}) => {
  if (status === 200 || status === 201) {
    const relationship = t.mapping.relationships?.[t.target.segment];
    const mapping = relationship ? t.store.resolveMapping(relationship.entity) : t.mapping;
    await hydrateImages(t, body, mapping);
  }
  let payload = body;
  if (status === 204) payload = null;
  else if (t.include) payload = stripAnnotations(body, t.include);
  return t.deps.json(t.res, status, payload, {
    ...apiHeaders(t.deps.portal),
    ...correlationHeaders(status, { method: t.req.method }),
    ...headers,
  });
};

// Query projection already enforced row, column and field-security permissions.
// Resolve only surviving image IDs, using the same authorized byte reader as /$value.
/* NOSONAR: preserve asynchronous lifecycle and concurrent operation ordering */ async function hydrateImages(
  t,
  body,
  mapping,
) {
  const files = t.store.recordPipeline?.fileContentInternal;
  if (typeof files?.kindOf !== 'function' || !body || typeof body !== 'object') return;
  for (const row of Array.isArray(body.value) ? body.value : [body]) {
    if (!row || typeof row !== 'object') continue;
    if (GUID_PATTERN.test(String(row[mapping.idColumn] ?? ''))) {
      for (const [column, value] of Object.entries(row)) {
        if (!GUID_PATTERN.test(String(value ?? '')) || files.kindOf(mapping.logicalName, column) !== 'image') continue;
        const answer = await files({
          principal: filePrincipal(t, mapping, 'read'),
          entity: mapping.logicalName,
          id: row[mapping.idColumn],
          column,
          operation: 'download',
          portalImage: true,
        });
        row[column] = answer.statusCode === 200 ? answer.body.$content : null;
      }
    }
    for (const [navigation, relation] of Object.entries(mapping.relationships ?? {})) {
      if (!own(row, navigation) || !row[navigation] || typeof row[navigation] !== 'object') continue;
      const nested = Array.isArray(row[navigation]) ? { value: row[navigation] } : row[navigation];
      await hydrateImages(t, nested, t.store.resolveMapping(relation.entity));
    }
  }
}

const sendText = (t, value) => {
  t.res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    ...apiHeaders(t.deps.portal),
    ...correlationHeaders(200, { json: false }),
  });
  t.res.end(String(value));
};

/** OData context URL: $metadata#set(select,nav(select)) as the platform publishes it. */
function contextUrl(t, mapping, params, { entity = false } = {}) {
  const describe = (select, expand) => {
    const parts = [...(select ?? [])];
    for (const spec of expand ?? [])
      parts.push(`${spec.navigation}(${describe(parseSelect(spec.select), spec.expand ?? []).join(',')})`);
    return parts;
  };
  const parts = params ? describe(parseSelect(params.get('$select')), parseExpand(params.get('$expand'))) : [];
  const partsSuffix = parts.length ? `(${parts.join(',')})` : '';
  return `${t.deps.origin}/_api/$metadata#${mapping.entitySet}${partsSuffix}${entity ? '/$entity' : ''}`;
}
const sendNoContent = (t, headers = {}) => send(t, 204, null, headers);
const pick = (params, names) => {
  const out = new URLSearchParams();
  for (const [key, value] of params) if (names.includes(key) || key.startsWith('@')) out.set(key, value);
  return out;
};
const queryOptions = (t, extra = {}) => ({
  dialect: 'dataverse',
  portalRequest: true,
  metadata: t.deps.metadata,
  includeKeys: true,
  ...extra,
});
const entityLocation = (t, mapping, id) => {
  const prefix = t.deps.portal?.observed?.webApiWriteResponse === 'portal-classic' ? '/api/data/v9.1/' : '/_api/';
  return `${t.deps.origin}${prefix}${mapping.entitySet}(${id})`;
};
const recordNotFound = (mapping, key) =>
  new DataError(`${mapping.logicalName} With Id = ${key} Does Not Exist`, 404, 'NotFound', {
    innerCode: '0x80040217',
  });

/** Explicitly allow-listed columns a select-less read returns, null when unset. */
function fillDeclaredColumns(t, out, policy, mapping) {
  for (const name of policy.fields) {
    if (name === '*') continue;
    const lookupName = /^_(.+)_value$/.exec(name);
    const physical = lookupName ? lookupName[1] : name;
    const rel = mapping.relationships?.[physical];
    // Navigation names aren't properties unless they name the lookup column itself.
    if ((rel && !(rel.many === false && rel.from === physical)) || physical === mapping.idColumn) continue;
    const definition = t.store.fieldDefinition(mapping.logicalName, physical, t.deps.metadata);
    if (!definition) continue;
    const lookup =
      lookupName ||
      fieldKind(definition) === 'lookup' ||
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
  nullProviderLookups(t, mapping, formatted, parseExpand(expand));
  return policy.project(formatted);
}

// A single-valued $expand into a provider-backed table reads null, with a healthy and with a throwing provider (hosted
// session F1 follow-up 2026-11-27, runs a and b); the provider is not read for it (data.mjs
// collectPortalNavigationReadSources), so no local mirror answers either.
function nullProviderLookups(t, mapping, row, specs) {
  const providers = t.store.recordPipeline?.virtualProviders;
  if (!providers || !row || typeof row !== 'object') return;
  for (const spec of specs) {
    const rel = ownRelationship(mapping, spec.navigation);
    if (!rel || !own(row, spec.navigation)) continue;
    const target = t.store.resolveMapping(rel.entity);
    if (rel.many === false && providers.status(target.logicalName).virtual) row[spec.navigation] = null;
    else {
      const value = row[spec.navigation];
      for (const child of Array.isArray(value) ? value : [value])
        nullProviderLookups(t, target, child, spec.expand ?? []);
    }
  }
}

/** Resolve a key segment (primary key or alternate key) to a stored primary key. */
function locate(t, mapping, key) {
  const text = String(key).trim();
  if (text.includes('=')) {
    const row = t.store.findByKey(mapping, text, { portalRequest: t.method === 'GET' });
    return { id: row ? row[mapping.idColumn] : null, alternate: parseKeySegment(text) };
  }
  return {
    id: text.replace(/^'(.*)'$/s, (_all, value) => value.replaceAll("''", "'")).replace(/^\{(.*)\}$/, '$1'),
    alternate: null,
  };
}

// A keyed read of a row that does not exist answers 404 9004010D "Common Data Service error occurred." with neither
// cdscode nor innererror, also with Webapi/error/innererror on (hosted session F1, API-02c, two runs and the inner error
// run). File and image column downloads keep their own answer.
const readNotFound = (t, mapping, key) => {
  const error = recordNotFound(mapping, key);
  if (!fileKind(t)) error.details = { ...error.details, hideInner: true };
  return error;
};
const readRecord = (t, mapping, id, key) => {
  if (id == null) throw readNotFound(t, mapping, key);
  const row = t.store.get(mapping.logicalName, id, t.deps.identity, { portalRequest: true });
  if (!row) throw readNotFound(t, mapping, key);
  return row;
};

// ---- reads

function collectionBody(t, mapping, params, result, value, paging) {
  // Collections carry the context and the CRM count annotations
  // (totalrecordcount is -1 without $count), with or without a Prefer header.
  const body = { '@odata.context': contextUrl(t, mapping, params) };
  const count = result['@odata.count'];
  if (count !== undefined) body['@odata.count'] = count;
  const total = result.paging?.totalCount ?? count;
  // A provider-answered virtual table read carries its own total (result.totalRecordCount; data.mjs providerAnswered).
  body['@Microsoft.Dynamics.CRM.totalrecordcount'] =
    result.totalRecordCount ?? (count === undefined ? -1 : Math.min(total, WEBAPI_COUNT_LIMIT));
  body['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'] = count !== undefined && total > WEBAPI_COUNT_LIMIT;
  body['@Microsoft.Dynamics.CRM.globalmetadataversion'] = globalMetadataVersion(t.store);
  body.value = value;
  if (paging && result.paging?.moreRecords) body['@odata.nextLink'] = paging.nextLink(result.paging.nextOffset);
  return body;
}

/** Web API property name of a table column: lookups read as _x_value. */
function propertyName(mapping, name, definition) {
  if (/^_.+_value$/.test(name)) return name;
  const lookup =
    fieldKind(definition) === 'lookup' ||
    Object.values(mapping.relationships ?? {}).some((rel) => rel.many === false && rel.from === name);
  return lookup ? `_${name}_value` : name;
}
/**
 * A select-less collection read reads the configured columns in list order and is refused at the first one the list
 * does not enable (policy.assertSelectLess; hosted session F1). A custom activity is then served those columns (F1
 * API-01c phases D and E). Any other table is also refused with 403 90040101 naming the first column (in property-name
 * order) outside Webapi/<table>/fields; only a wildcard list returns every column.
 */
function assertSelectLessRead(t, policy, mapping) {
  if (policy.fields.includes('*')) return;
  policy.assertSelectLess();
  if (policy.customActivity) return;
  const columns = selectLessReadColumns(t, mapping);
  const denied = [...columns]
    .sort(/* NOSONAR: preserve default string coercion */)
    .find((column) => !policy.allowed(column));
  if (denied)
    throw new DataError(
      `Attribute ${denied} in table ${mapping.logicalName} is not enabled for Web Api.`,
      403,
      'WebApiFieldNotEnabled',
      {
        attribute: denied,
        table: mapping.logicalName,
      },
    );
}

function selectLessReadColumns(t, mapping) {
  const columns = new Set();
  for (const [name, definition] of Object.entries(t.store.fieldDefinitions(mapping.logicalName, t.deps.metadata)))
    if (!definition?.attributeOf) columns.add(propertyName(mapping, name, definition));
  for (const row of t.store.tableRows(mapping.logicalName))
    for (const [name, value] of Object.entries(row))
      if (!/^__sim/i.test(name) && !name.includes('@'))
        columns.add(
          value && typeof value === 'object' && own(value, 'id') && own(value, 'logical_name')
            ? `_${name}_value`
            : propertyName(mapping, name, t.store.fieldDefinition(mapping.logicalName, name, t.deps.metadata)),
        );
  columns.delete(mapping.idColumn);
  return columns;
}

/**
 * Every table an $expand reads needs read permission. The adapter answers an expansion of a
 * related table that the caller can't read with 403 90040120 naming that table, not with
 * an empty expansion, as it does for FetchXML link-entities. That holds even on a site
 * whose export sets Webapi/SkipRelatedTablePermissions. Rows of a readable related
 * table that the caller's scopes exclude are still left out of the expansion.
 */
function assertExpandReadable(t, mapping, expand, specs = parseExpand(expand)) {
  const { store, deps } = t;
  if (deps.identity?.admin || store.state.settings?.permissionMode === 'permissive') return;
  const visit = (owner, specs) => {
    for (const spec of specs) {
      const rel = owner.relationships?.[spec.navigation];
      if (!rel) continue;
      const target = store.resolveMapping(rel.entity);
      if (!store.rules(target.logicalName, 'read', deps.identity).length) throw readDenied(t.store, target.logicalName);
      visit(target, spec.expand ?? []);
    }
  };
  visit(mapping, specs);
}

function assertCollectionQuery(t, mapping, policy, params) {
  policy.assertQuery(params);
  const apply = params.has('$apply');
  // Table permission is checked before the select-less column rule.
  assertTableReadable(t, mapping);
  if (!apply) assertExpandReadable(t, mapping, params.get('$expand'));
  if (!apply && !params.has('$select')) assertSelectLessRead(t, policy, mapping);
  // An $apply query has no $select: the portal refuses it as a select-less read (hosted session F1, API-02c, two runs:
  // groupby, aggregate and filter/aggregate named the first listed lookup's _x_value).
  if (apply && !t.summary && !policy.fields.includes('*')) policy.assertSelectLess();
  // Last: a visitor refused above never learns that the filter reaches a provider-backed table.
  assertNoProviderJoin(t, mapping, params);
}

/** 403 90040120 when the caller holds no read grant on the table. */
function assertTableReadable(t, mapping) {
  const { store, deps } = t;
  if (
    !deps.identity?.admin &&
    store.state.settings?.permissionMode !== 'permissive' &&
    !store.rules(mapping.logicalName, 'read', deps.identity).length
  )
    throw readDenied(store, mapping.logicalName);
}

/**
 * The request URL a collection read runs: a custom activity's select-less read selects its configured columns
 * (selectLessColumns), as the hosted context URL names them (F1 API-01c phases D and E: #<set>(activityid,subject,...)).
 */
function selectedUrl(url, policy) {
  if (
    !policy.customActivity ||
    url.searchParams.has('$select') ||
    url.searchParams.has('$apply') ||
    policy.fields.includes('*')
  )
    return url;
  const columns = policy.selectLessColumns();
  if (!columns.length) return url;
  const selected = new URL(url);
  selected.searchParams.set('$select', columns.join(','));
  return selected;
}

function getCollection(t, options) {
  return send(t, 200, collectionPayload(t, options));
}

/**
 * The wire columns of the caller's permission predicate on a table, or null when its read is not permission-filtered
 * (an administrator, permissive mode, or a Global grant). Only the Contact and Account scopes, whose predicate is a
 * column of the table itself, are modelled.
 */
function permissionPredicateColumns(t, mapping) {
  const { store, deps } = t;
  if (deps.identity?.admin || store.state.settings?.permissionMode === 'permissive') return null;
  const grants = store.rules(mapping.logicalName, 'read', deps.identity);
  if (!grants.length || grants.some((grant) => (grant.scope ?? 'global') === 'global')) return null;
  const columns = [];
  for (const grant of grants) {
    if (!['contact', 'account'].includes(grant.scope)) continue;
    const column = permissionGrantColumn(grant, mapping.idColumn);
    const wire = propertyName(mapping, column, store.fieldDefinition(mapping.logicalName, column, deps.metadata));
    if (!columns.includes(wire)) columns.push(wire);
  }
  return columns;
}

function collectionPayload(t, { mapping = t.mapping, policy = t.policy, ids } = {}) {
  const { store, deps } = t;
  assertCollectionQuery(t, mapping, policy, t.url.searchParams);
  const url = selectedUrl(t.url, policy);
  const apply = url.searchParams.has('$apply');
  const predicate = permissionPredicateColumns(t, mapping);
  // The platform's @odata.nextLink of a permission-filtered read embeds the permission predicate as a $filter
  // ("(_<lookup>_value eq <contact>)"), so following it is column-checked like any $filter: hosted session F1 (API-02c,
  // two runs) answered 403 90040101 naming _pqf1_contact_value, with and without the Prefer header, while the list held
  // only the logical lookup. Mirage's continuation stays a signed cursor; following it is checked the same way.
  const paging = prepareODataPage({
    url,
    prefer: t.req.headers.prefer ?? '',
    identity: deps.identity,
    revision: store.dataRevision(),
    secret: pagingKey(store),
    pageWithoutTop: predicate !== null,
  });
  // A validated cursor reuses the server's permission predicate. An exempt wildcard
  // already admits its readable columns, including a source permission field missing
  // from the exported attributes. Caller-authored filters passed schema checks above.
  if (predicate && !t.summary && url.searchParams.has('$skiptoken')) {
    const wildcardCursor = url.searchParams.get('$skiptoken') && policy.fields.includes('*');
    for (const column of predicate) if (!wildcardCursor || !policy.readable(column)) policy.assert(column);
  }
  const result = store.query(
    mapping.logicalName,
    paging.params,
    deps.identity,
    paging,
    queryOptions(t, ids ? { ids } : {}),
  );
  const value = apply
    ? result.value.map((row) => t.formatter.formatEntity(row, mapping, { etag: false }))
    : result.value.map((row) =>
        linkExpandedCollections(
          t,
          mapping,
          shapeEntity(t, policy, mapping, row, { expand: url.searchParams.get('$expand') }),
          url.searchParams.get('$expand'),
        ),
      );
  return collectionBody(t, mapping, apply ? null : url.searchParams, result, value, apply ? null : paging);
}

/**
 * A collection read's expanded collection-valued navigation, as Dataverse answers it: each child row carries the parent
 * lookup with its formatted value, navigation and table annotations, and the expansion carries
 * <navigation>@odata.nextLink to the navigation of that parent (hosted session F1, API-02b, two runs, with and without
 * nested options; a keyed read's expansion carries neither). The lookup is the platform's, outside the column list.
 */
function linkExpandedCollections(t, mapping, row, expand) {
  for (const spec of parseExpand(expand)) {
    const rel = ownRelationship(mapping, spec.navigation);
    const children = row[spec.navigation];
    if (!rel || rel.many === false || rel.intersect || !rel.to || !Array.isArray(children)) continue;
    const target = t.store.resolveMapping(rel.entity);
    const parentId = row[mapping.idColumn];
    const navigation =
      Object.entries(target.relationships ?? {}).find(([, item]) => item.many === false && item.from === rel.to)?.[0] ??
      rel.to;
    const parent = mapping.nameColumn ? t.store.get(mapping.logicalName, parentId, { admin: true }) : null;
    const lookup = `_${rel.to}_value`;
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      delete child[lookup];
      child[`${lookup}@OData.Community.Display.V1.FormattedValue`] = parent?.[mapping.nameColumn] ?? null;
      child[`${lookup}@Microsoft.Dynamics.CRM.associatednavigationproperty`] = navigation;
      child[`${lookup}@Microsoft.Dynamics.CRM.lookuplogicalname`] = mapping.logicalName;
      child[lookup] = parentId;
    }
    const options = ['select', 'filter', 'orderby', 'top']
      .filter((key) => spec[key] != null && spec[key] !== '')
      .map((key) => `$${key}=${encodeURIComponent(spec[key])}`);
    const query = options.length ? `?${options.join('&')}` : '';
    row[`${spec.navigation}@odata.nextLink`] =
      `${t.deps.origin}/_api/${mapping.entitySet}(${parentId})/${spec.navigation}${query}`;
  }
  return row;
}

/**
 * Tables a FetchXML query reads, which each need read permission: the root and every
 * link-entity, in document order. A structural many-to-many traversal of an intersect
 * (structuralIntersects) reads no intersect table of its own; the tables it joins are
 * still checked, as the engine checks them.
 */
function fetchTables(store, xml) {
  const plan = planFetch(parseXmlDocument(xml, { root: 'fetch' }), {
    profile: 'webapi',
    limits: store.querySettings().fetchLimits,
    linkBudgetError: store.observed?.fetchLinkBudgetError,
  });
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
function fetchContext(t, mapping, info, { empty = false } = {}) {
  if ((info.aggregate || empty) && t.store.observed?.tablePermissionQueryPipeline === 'native-classic')
    return `${t.deps.origin}/_api/$metadata#${mapping.entitySet}`;
  const columns = info.columns.filter((column) => column.alias == null && !column.aliased && !column.aggregate);
  const parts = [],
    lookups = [];
  for (const column of columns) {
    const definition = t.store.fieldDefinition(mapping.logicalName, column.attribute, t.deps.metadata);
    const name = propertyName(mapping, column.attribute, definition);
    if (name !== column.attribute) {
      parts.push(name, column.attribute);
      lookups.push(`${column.attribute}()`);
    } else parts.push(name);
  }
  // The primary key a non-distinct query did not list follows the authored columns (hosted session F7,
  // api-s1-loc-fields locations-fetch-regarding, runs a and b: name,relativeurl -> (name,relativeurl,<id>); hosted session
  // F1 fetch-webapi-owner-columns kept an authored id where it was authored).
  if (!info.aggregate && !info.distinct && !columns.some((column) => column.attribute === mapping.idColumn))
    parts.push(mapping.idColumn);
  return `${t.deps.origin}/_api/$metadata#${mapping.entitySet}(${[...parts, ...lookups].join(',')})`;
}

async function getFetch(t) {
  const { url, store, deps, mapping } = t;
  const authoredXml = url.searchParams.get('fetchXml');
  const xml = deps.identity?.admin
    ? authoredXml
    : preparePortalFetchXml(authoredXml, {
        linkTypes: store.observed?.webApiFetchXmlLinkTypes,
        authoring: store.observed?.portalFetchXmlAuthoring,
      });
  const nativePolicy = !deps.identity?.admin && store.observed?.tablePermissionQueryPipeline === 'native-classic';
  const project = prepareFetchProjection(t, deps, store, xml, mapping, nativePolicy);
  // Return 403 90040120 when any table the query reads (root or link-entity)
  // has no read permission for the caller, instead of silently empty joins.
  if (!nativePolicy) admitFetchTables(store, xml, deps);
  const counted = url.searchParams.get('$count') === 'true';
  const execute = () =>
    store.fetchXml(authoredXml, deps.identity, {
      profile: 'webapi',
      portalRequest: true,
      authoredPortalFetchXml: true,
      metadata: deps.metadata,
      returnTotal: counted,
    });
  const fetched =
    typeof store.withPortalReadSources === 'function'
      ? await store.withPortalReadSources(deps.identity, { fetchXml: xml }, execute)
      : execute();
  const info = fetched.columns;
  const body = { '@odata.context': fetchContext(t, mapping, info, { empty: fetched.entities.length === 0 }) };
  if (counted || (nativePolicy && fetched.total_record_count >= 0 && !fetched.providerAnswered))
    body['@odata.count'] = Math.max(fetched.total_record_count, 0);
  body['@Microsoft.Dynamics.CRM.totalrecordcount'] = fetched.total_record_count;
  body['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'] = fetched.total_record_count_limit_exceeded;
  body['@Microsoft.Dynamics.CRM.globalmetadataversion'] = globalMetadataVersion(store);
  addFetchResponseAnnotations(body, fetched, info, nativePolicy, xml, store);
  body.value = fetched.entities.map((row) => project(t.formatter.formatFetchRow(row, info)));
  return send(t, 200, body);
}

function admitFetchTables(store, xml, deps) {
  if (!deps.identity?.admin && store.state.settings?.permissionMode !== 'permissive')
    for (const logical of fetchTables(store, xml))
      if (!store.rules(logical, 'read', deps.identity).length) throw readDenied(store, logical);
}

function prepareFetchProjection(t, deps, store, xml, mapping, nativePolicy) {
  try {
    if (nativePolicy) admitFetchTables(store, xml, deps);
    return webApiFetchPolicy(policyPortal(store, deps), store, xml, mapping.logicalName, {
      structuralJoinFields: nativePolicy,
    });
  } catch (cause) {
    if (
      !deps.identity?.admin &&
      store.observed?.tablePermissionQueryPipeline === 'native-classic' &&
      cause.details?.innerCode === '0x8004430d'
    )
      throw new DataError(
        'An unexpected error occurred while processing the request',
        500,
        'PortalQueryAdmissionFailure',
        { phase: 'native-api-admission' },
      );
    throw cause;
  }
}

function addFetchResponseAnnotations(body, fetched, info, nativePolicy, xml, store) {
  if (nativePolicy) {
    const executed = planFetch(parseXmlDocument(fetched.executedXml ?? fetched.xml ?? xml, { root: 'fetch' }), {
      profile: 'webapi',
      limits: store.querySettings().fetchLimits,
      linkBudgetError: store.observed?.fetchLinkBudgetError,
    });
    for (const link of executed.root.children.filter((node) => node.name === 'link-entity'))
      body[`@${executed.aliasOf.get(link)}.OData.Community.Display.V1.CurrentEntityField`] = link.attrs.to;
  }
  // The final page carries neither morerecords nor the paging cookie (fetchxml/page-results).
  if (!fetched.more_records) return;
  body['@Microsoft.Dynamics.CRM.morerecords'] = true;
  if (fetched.paging_cookie)
    body['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'] = webApiPagingCookie(
      fetched.paging_cookie,
      Number(info.page ?? 1),
    );
}

function getCount(t, { mapping = t.mapping, policy = t.policy, ids } = {}) {
  const { url, store, deps } = t;
  const aliases = [...url.searchParams.keys()].filter((key) => key.startsWith('@'));
  const params = pick(url.searchParams, ['$filter', ...aliases]);
  policy.assertQuery(params);
  // /$count is a select-less read (hosted session F1, API-02c, two runs: 403 naming the first listed lookup's _x_value).
  if (!ids && !policy.fields.includes('*')) policy.assertSelectLess();
  params.set('$select', mapping.idColumn);
  const result = store.query(
    mapping.logicalName,
    params,
    deps.identity,
    undefined,
    queryOptions(t, ids ? { ids } : {}),
  );
  return sendText(t, Math.min(result.value.length, WEBAPI_COUNT_LIMIT));
}

function entityResponse(t, mapping, policy, id, params, { portalPrimaryKeyProjection = false } = {}) {
  const result = t.store.query(
    mapping.logicalName,
    params,
    t.deps.identity,
    undefined,
    queryOptions(t, { id, portalPrimaryKeyProjection }),
  );
  const projected = result.value[0];
  if (!projected) throw readNotFound(t, mapping, id);
  return {
    '@odata.context': contextUrl(t, mapping, params, { entity: true }),
    ...shapeEntity(t, policy, mapping, projected, { fill: !params.has('$select'), expand: params.get('$expand') }),
  };
}

function entityProjection(t) {
  const { url, mapping, policy, target } = t;
  // Every supplied option is column-checked, even ones a single entity ignores.
  policy.assertQuery(url.searchParams);
  const params = pick(url.searchParams, ['$select', '$expand']);
  // A select-less keyed read is refused like a select-less collection, before the row is read (hosted session F1,
  // API-02c, two runs: no backend query). It then returns the listed columns (fillDeclaredColumns).
  if (!params.has('$select') && !policy.fields.includes('*')) policy.assertSelectLess();
  const { id } = locate(t, mapping, target.key);
  readRecord(t, mapping, id, target.key);
  assertExpandReadable(t, mapping, params.get('$expand'));
  const portalPrimaryKeyProjection =
    GUID_PATTERN.test(target.key) && url.searchParams.size === 1 && Boolean(parseSelect(params.get('$select'))?.length);
  return entityResponse(t, mapping, policy, id, params, { portalPrimaryKeyProjection });
}

function getEntity(t) {
  const body = entityProjection(t);
  const match = t.req.headers['if-none-match'];
  if (
    match &&
    body['@odata.etag'] &&
    String(match)
      .split(',')
      .map((item) => item.trim())
      .includes(body['@odata.etag'])
  ) {
    t.res.writeHead(304, { ...apiHeaders(t.deps.portal), ETag: body['@odata.etag'] });
    return t.res.end();
  }
  return send(t, 200, body);
}

/** Read a summary's authorized source before response annotations and binary hydration. The caller owns the serialized read. */
export function readWebApiSummaryEntity(url, deps, project) {
  const target = parseWebApiRoute(url.pathname);
  if (target.kind !== 'entity')
    throw new DataError('Data summarization requires an entity set or an entity URL.', 404, 'ResourceNotFound');
  // A primary key or a declared, active alternate key resolves as the Web API GET resolves it (locate, findByKey).
  const t = summaryReadContext(url, deps, target);
  return preparePortalRead(t, () => project(entityProjection(t), t.mapping));
}

/**
 * Read a collection summary's authorized source: the page a portal Web API GET of the same query returns (its $filter,
 * $orderby, $top, $count, $apply, nested $expand options, Prefer odata.maxpagesize and $skiptoken), permission-filtered,
 * before response annotations and binary hydration. The caller owns the serialized read.
 */
export function readWebApiSummaryCollection(url, deps, project, { prefer } = {}) {
  const target = parseWebApiRoute(url.pathname);
  if (target.kind !== 'collection')
    throw new DataError('Data summarization requires an entity set or an entity URL.', 404, 'ResourceNotFound');
  // FetchXML is its own read lane (getFetch): its permission compilation and projection have no summary projection.
  if (url.searchParams.has('fetchXml') || url.searchParams.has('fetchxml'))
    throw new DataError(
      'Data summarization reads OData query options, not FetchXML.',
      400,
      'InvalidDataSummaryRequest',
    );
  const t = summaryReadContext(url, deps, target, prefer);
  return preparePortalRead(t, () => {
    const body = collectionPayload(t);
    return project(body.value, t.mapping, { apply: url.searchParams.has('$apply') });
  });
}

function summaryReadContext(url, deps, target, prefer) {
  if (deps.identity?.admin || deps.store.state.settings.permissionMode === 'permissive')
    throw new DataError('Local data summarization requires enforced portal permissions.', 403, 'PermissionDenied');
  const headers = typeof prefer === 'string' && prefer ? { prefer } : {};
  // A summary keeps the read checks it had before hosted session F1: the F1 $apply and continuation checks were
  // recorded on /_api, not on the summarization API.
  return { ...requestContext({ method: 'GET', headers }, null, url, deps, target, 'GET'), summary: true };
}

function navigationTarget(t) {
  const rel = t.mapping.relationships[t.target.segment];
  if (rel.many === false) t.policy.assertPath([t.target.segment]);
  else assertCollectionNavigation(t);
  const targetMapping = t.store.resolveMapping(rel.entity);
  const targetPolicy = webApiPolicy(policyPortal(t.store, t.deps), t.store, targetMapping.logicalName);
  const { id } = locate(t, t.mapping, t.target.key);
  const parent = readRecord(t, t.mapping, id, t.target.key);
  const related = t.store
    .queryContext(t.deps.identity, { metadata: t.deps.metadata, portalRequest: true })
    .related(parent, rel)
    .map((row) => row[targetMapping.idColumn]);
  return { rel, targetMapping, targetPolicy, related };
}

// A collection-valued navigation read (hosted session F1, AUTH-03c, two runs each way): the related table's read permission
// is refused first (403 90040120, before the related table's Web API settings), then a navigation that is not a listed
// field of the request's table is refused as an all-columns read of that table (403 90040101 "Attribute All Columns in
// table <table> is not enabled for Web Api.").
function assertCollectionNavigation(t) {
  assertExpandReadable(t, t.mapping, null, [{ navigation: t.target.segment, expand: [] }]);
  try {
    t.policy.assertPath([t.target.segment]);
  } catch (error) {
    if (error?.code !== 'WebApiFieldNotEnabled' || error.details?.attribute !== t.target.segment) throw error;
    throw new DataError(
      `Attribute All Columns in table ${t.mapping.logicalName} is not enabled for Web Api.`,
      403,
      'WebApiFieldNotEnabled',
      { attribute: 'All Columns', table: t.mapping.logicalName },
    );
  }
}

function getNavigation(t) {
  const { rel, targetMapping, targetPolicy, related } = navigationTarget(t);
  if (rel.many !== false) return getCollection(t, { mapping: targetMapping, policy: targetPolicy, ids: related });
  const params = pick(t.url.searchParams, ['$select', '$expand']);
  targetPolicy.assertQuery(params);
  // Without $select the related row is a select-less read (hosted session F1, API-02c, two runs).
  if (!params.has('$select') && !targetPolicy.fields.includes('*')) targetPolicy.assertSelectLess();
  // The related table needs read permission, as for $expand and collection navigations.
  assertExpandReadable(t, t.mapping, null, [
    { navigation: t.target.segment, expand: parseExpand(params.get('$expand')) },
  ]);
  if (!related.length) return sendNoContent(t);
  return send(t, 200, entityResponse(t, targetMapping, targetPolicy, related[0], params));
}

// A navigation's $count is refused in routeTarget; a segment that names no navigation is not a resource.
function getNavigationCount(t) {
  throw notFound(t.target.segment);
}

async function getProperty(t, raw) {
  const { mapping, policy, target } = t;
  if (mapping.relationships?.[target.segment]) throw notFound(raw ? '$value' : target.segment);
  policy.assert(target.segment);
  const { id } = locate(t, mapping, target.key);
  readRecord(t, mapping, id, target.key);
  const params = new URLSearchParams({ $select: target.segment });
  const result = t.store.query(mapping.logicalName, params, t.deps.identity, undefined, queryOptions(t, { id }));
  const formatted = t.formatter.formatEntity(result.value[0] ?? {}, mapping, { etag: false });
  const lookup = /^_(.+)_value$/.test(target.segment) ? target.segment : `_${target.segment}_value`;
  let value = own(formatted, target.segment) ? formatted[target.segment] : formatted[lookup];
  if (value != null && fileKind(t) === 'image') {
    const row = { [mapping.idColumn]: id, [target.segment]: value };
    await hydrateImages(t, row, mapping);
    value = row[target.segment];
  }
  if (
    value == null &&
    ATTACHMENT_COLUMNS[mapping.logicalName] === target.segment &&
    typeof t.deps.attachmentBody === 'function'
  )
    value = await t.deps.attachmentBody(mapping.logicalName, { [mapping.idColumn]: id }, { strict: raw });
  if (value == null) return sendNoContent(t);
  if (raw) return sendText(t, isExactNumeric(value) ? value.value : value);
  return send(t, 200, { value });
}

// ---- writes

function decodePortalClassicBody(t, body) {
  let decoded;
  try {
    decoded = JSON.parse(body);
  } catch {
    /* The OData token classifier formats rejected primitive roots. */
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return body;
  const source = body;
  body = attachODataJsonSource(parseExactJson(source, { allowFiniteDouble: true }), source);
  // Decoding changes only transport representation. All ordinary write and entity policies still run below.
  const unknown = rejectedGatewayProperty(body, {
    mapping: t.mapping,
    fields: t.policy.fields,
    metadataFields: [t.deps.portal?.webApiEntities?.[t.mapping.logicalName]?.fields],
    assertWrite: t.policy.assertWrite,
    operation: t.req.method === 'POST' ? 'create' : 'update',
  });
  if (unknown)
    throw attachODataReaderDetails(badRequest(`Unknown property '${unknown}'.`, 'InvalidRequest', '0x80048d19'), {
      kind: 'unknown-property',
      property: unknown,
      logicalName: t.mapping.logicalName,
    });
  return body;
}

const tooLarge = () =>
  new DataError('Request message length is too large.', 413, 'PayloadTooLarge', { innerCode: '0x8004418a' });
async function readBody(t) {
  const observed = t.deps.portal?.observed?.webApiErrorDetails === 'odata-wrapper';
  let body;
  try {
    body = await t.deps.jsonBody(t.req, { allowEmpty: false, odataErrorDetails: observed });
  } catch (error) {
    // The host's body limit answers as the Web API's own request limit does: the envelope with 413 0x8004418a.
    if (error?.status === 413) throw tooLarge();
    throw error;
  }
  if (t.deps.portal?.observed?.webApiRequestBody === 'portal-classic' && typeof body === 'string')
    body = decodePortalClassicBody(t, body);
  // The parsed body is the webapi span's input (captured, redacted, only at level full).
  t.span?.setInput(() => body);
  t.odataNumberLexemes = observed ? odataNumberLexemes(body) : undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw attachODataReaderDetails(
      badRequest('The request body must be a JSON object.', 'InvalidRequest', '0x0'),
      observed ? odataRootDetails(body) : null,
    );
  return body;
}

/** @odata.bind and @odata.id references must stay on this portal (or its live origin). */
function checkReferenceOrigin(t, value, name) {
  const observed = t.deps.portal?.observed?.webApiReferenceErrors === 'unexpected';
  const failure = (message) =>
    new DataError(message, observed ? 500 : 400, observed ? 'WebApiInvalidReference' : 'InvalidLookup', {
      innerCode: '0x80040203',
      ...(observed ? { hideInner: true } : {}),
    });
  const reference = parseEntityReference(value);
  if (!reference) throw failure(`Invalid entity reference in ${name}.`);
  if (observed && !GUID_PATTERN.test(reference.id) && !parseKeySegment(reference.id))
    throw failure(`Invalid entity reference in ${name}.`);
  if (reference.origin && !t.deps.origins.includes(reference.origin))
    throw failure(`Entity references in ${name} must use this portal origin.`);
  if (observed) {
    const target = t.store.resolveMapping(reference.set);
    if (!t.store.findByKey(target, reference.id))
      throw new DataError(`The referenced record does not exist.`, 404, 'InvalidLookup', { hideInner: true });
  }
  return reference;
}
function assertBindOrigins(t, body) {
  for (const [key, value] of Object.entries(body ?? {})) assertBindEntry(t, key, value);
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ function assertBindEntry(t, key, value) {
  if (key.endsWith('@odata.bind')) {
    for (const item of Array.isArray(value) ? value : [value])
      if (item != null || t.deps.portal?.observed?.webApiReferenceErrors === 'unexpected')
        checkReferenceOrigin(t, item, key);
    return;
  }
  if (value && typeof value === 'object')
    for (const item of Array.isArray(value) ? value : [value])
      if (item && typeof item === 'object' && !Array.isArray(item)) assertBindOrigins(t, item);
}
const writeOptions = (t, extra = {}) => ({
  coerce: true,
  portalRequest: true,
  odataErrorDetails: t.deps.portal?.observed?.webApiErrorDetails === 'odata-wrapper',
  odataNumberLexemes: t.odataNumberLexemes,
  ieee754Compatible: /(?:^|;)\s*IEEE754Compatible\s*=\s*(?:true|"true")\s*(?:;|$)/i.test(
    String(t.req.headers['content-type'] ?? ''),
  ),
  metadata: t.deps.metadata,
  ifMatch: t.req.headers['if-match'],
  ifNoneMatch: t.req.headers['if-none-match'],
  ...extra,
});
// Portal writes go through the organization's internal entries (dataverse-records.mjs, store.recordPipeline) once the
// portal policy (prepareWrite, table permissions in the store) has admitted them: the organization rules (state defaults,
// record hooks, audit and version columns, alternate-key answers) apply as on any organization write ("Dataverse and portal
// share data"). The portal's own value rules stay (no dataverseWebApi, the portal metadata). Without an organization on the
// store, the store writes directly. Under enhanced authorization the write runs as the visitor's mapped Dataverse user,
// called by the site's application user (portal-authorization.mjs principal), so column security profiles apply to it.
const portalContext = (t) => ({
  identity: t.deps.identity,
  portal: true,
  caller: null,
  method: t.req.method,
  headers: {},
  ...t.store.portalAuthorization?.principal(t.deps.identity),
});
// The portal the column policy reads: enhanced authorization bypasses the Web API column permissions (portal-authorization.mjs).
const policyPortal = (store, deps) => store.portalAuthorization?.webApiPortal(deps.portal) ?? deps.portal;
const internalOptions = (t, extra) => ({
  authorized: true,
  writeOptions: { ...writeOptions(t, extra), dataverseWebApi: false },
});
function portalCreate(t, mapping, data, extra) {
  const records = t.store.recordPipeline;
  if (!records) return t.store.createRecordAsync(mapping.logicalName, data, t.deps.identity, writeOptions(t, extra));
  return records.createInternal(portalContext(t), mapping.logicalName, data, internalOptions(t, extra));
}
function portalUpdate(t, mapping, id, data, extra) {
  assertUpdatePermissionQueryAdmission(t, mapping);
  const records = t.store.recordPipeline;
  if (!records)
    return t.store.updateRecordAsync(mapping.logicalName, id, data, t.deps.identity, writeOptions(t, extra));
  return records.updateInternal(portalContext(t), mapping.logicalName, id, data, internalOptions(t, extra));
}
// Some classic portals build the complete Update permission query before
// checking the addressed row. Qualify this independently: an oversized source
// graph can fail even for a row that would otherwise be denied. Do not execute
// the modeled query or apply this portal admission rule to SDK writes.
function assertUpdatePermissionQueryAdmission(t, mapping) {
  const store = t.store,
    identity = t.deps.identity;
  if (
    store.observed?.webApiUpdatePermissionQuery !== 'native-classic' ||
    identity?.admin ||
    store.state.settings?.permissionMode === 'permissive'
  )
    return;
  const xml = `<fetch><entity name="${xmlEscapeAttribute(mapping.logicalName)}"><attribute name="${xmlEscapeAttribute(mapping.idColumn)}"/></entity></fetch>`;
  const query = compilePermissionFetchXml(xml, {
    permissions: store.state.permissions,
    identity,
    mappings: store.state.mappings,
    operation: 'update',
    rules: store.rules.bind(store),
  });
  if (!query.permissionGranted) return;
  try {
    planFetch(parseXmlDocument(query.xml), {
      profile: 'webapi',
      limits: store.querySettings().fetchLimits,
      linkBudgetError: store.observed?.fetchLinkBudgetError,
    });
  } catch (error) {
    if (String(error.details?.innerCode).toLowerCase() === '0x8004430d')
      throw new DataError(
        'An unexpected error occurred while processing the request',
        500,
        'PortalQueryAdmissionFailure',
        { phase: 'native-api-admission' },
      );
    throw error;
  }
}
function portalRemove(t, mapping, id) {
  const records = t.store.recordPipeline;
  if (!records) return t.store.removeRecordAsync(mapping.logicalName, id, t.deps.identity, writeOptions(t));
  return records.removeInternal(portalContext(t), mapping.logicalName, id, internalOptions(t));
}
// Portal $ref associations run the organization's association pipeline (records.associateInternal/disassociateInternal:
// record hooks, Associate/Disassociate plug-in stages, committed work); the store write keeps the portal identity, so the
// table permissions (append/appendTo) apply.
function portalAssociation(t, mapping, id, navigation, targetId, associate) {
  const records = t.store.recordPipeline;
  if (!records)
    return t.store.changeAssociationRecord(mapping.logicalName, id, navigation, targetId, t.deps.identity, associate);
  const entry = associate ? records.associateInternal : records.disassociateInternal;
  return entry(portalContext(t), mapping.logicalName, id, navigation, [targetId], {
    authorized: true,
    writeOptions: { portalRequest: true },
  });
}
// One portal write in its own store transaction (the write slot the store's update/remove wrappers took).
const portalWrite = (t, fn) => t.deps.change(() => t.store.transact(fn, { incremental: true }));

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
  const params = pick(t.url.searchParams, ['$select', '$expand']);
  t.policy.assertQuery(params);
  if (
    !deps.identity?.admin &&
    store.state.settings?.permissionMode !== 'permissive' &&
    !store.rules(mapping.logicalName, 'read', deps.identity).length
  )
    throw readDenied(t.store, mapping.logicalName);
  assertExpandReadable(t, mapping, params.get('$expand'));
  return params;
}
function representationBody(t, mapping, id, params) {
  try {
    return entityResponse(t, mapping, t.policy, id, params);
  } catch (error) {
    if (error?.code !== 'NotFound') throw error;
    throw readDenied(t.store, mapping.logicalName);
  }
}
/** Run a write and, when requested, read its representation in one store transaction. */
function writeAndRepresent(t, mapping, params, write) {
  return t.deps.change(() =>
    t.store.transact(
      async () => {
        const outcome = await write();
        const row = outcome.row ?? outcome;
        const id = row[mapping.idColumn];
        return { outcome, id, body: params ? representationBody(t, mapping, id, params) : null };
      },
      { incremental: true },
    ),
  );
}

async function createEntity(t) {
  const { mapping, policy } = t;
  const body = await readBody(t);
  if (!Object.keys(body).length)
    throw new DataError('No attributes for Create Table action.', 400, 'NoAttributesForTableCreate');
  assertBindOrigins(t, body);
  const prepared = policy.prepareWrite(body, 'create');
  const params = representationParams(t, mapping);
  const { id, body: represented } = await writeAndRepresent(t, mapping, params, () =>
    portalCreate(t, mapping, prepared),
  );
  const headers = { 'OData-EntityId': entityLocation(t, mapping, id), entityid: String(id) };
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
    const prepared = policy.prepareWrite(body, 'update');
    write = existingPatchWrite(t, mapping, located.id, prepared, store, deps, options);
  } else {
    assertUpsertKeyIsGuid(located, target.key);
    // Upsert creates the record with the addressed primary or alternate key.
    const keyed = { ...body, ...located.alternate };
    const prepared = policy.prepareWrite(keyed, 'create');
    write = missingPatchWrite(t, mapping, located, prepared, store, deps, options);
  }
  const params = representationParams(t, mapping);
  const { outcome, id, body: represented } = await writeAndRepresent(t, mapping, params, write);
  const headers = {
    'OData-EntityId': entityLocation(t, mapping, id),
    ...(t.deps.portal?.observed?.webApiWriteResponse === 'portal-classic' ? { entityid: String(id) } : {}),
  };
  if (params) return send(t, outcome.created ? 201 : 200, represented, headers);
  return sendNoContent(t, headers);
}

// An upsert by primary key creates the row under that key, which must be a GUID (Edm.Guid). Alternate keys are not checked.
function assertUpsertKeyIsGuid(located, key) {
  if (located.alternate || GUID_PATTERN.test(String(located.id))) return;
  throw new DataError(`The key ${key} is not a valid GUID.`, 400, 'InvalidQuery', { segment: key, phase: 'query' });
}

function existingPatchWrite(t, mapping, id, prepared, store, deps, options) {
  if (!store.recordPipeline) assertUpdatePermissionQueryAdmission(t, mapping);
  if (store.recordPipeline) return async () => ({ created: false, row: await portalUpdate(t, mapping, id, prepared) });
  return () => store.upsertRecordAsync(mapping.logicalName, id, prepared, deps.identity, options);
}

function missingPatchWrite(t, mapping, located, prepared, store, deps, options) {
  if (located.alternate || store.recordPipeline)
    return async () => ({
      created: true,
      row: await portalCreate(
        t,
        mapping,
        located.alternate ? prepared : { ...prepared, [mapping.idColumn]: located.id },
      ),
    });
  return () => store.upsertRecordAsync(mapping.logicalName, located.id, prepared, deps.identity, options);
}

async function deleteEntity(t) {
  const { mapping, target } = t;
  const { id } = locate(t, mapping, target.key);
  if (id == null) throw recordNotFound(mapping, target.key);
  await portalWrite(t, () => portalRemove(t, mapping, id));
  return sendNoContent(t);
}

async function putProperty(t) {
  const { mapping, policy, target } = t;
  const body = await readBody(t);
  if (!own(body, 'value')) throw badRequest('A property value is required: { "value": ... }.', 'InvalidRequest', '0x0');
  const { id } = locate(t, mapping, target.key);
  if (id == null) throw recordNotFound(mapping, target.key);
  const prepared = policy.prepareWrite({ [target.segment]: body.value }, 'update');
  await portalWrite(t, () => portalUpdate(t, mapping, id, prepared));
  return sendNoContent(t);
}

// ---- file and image columns (Learn: power-pages/configure/file-column#web-api; the binary contract is Dataverse's,
// power-apps/developer/data-platform/file-column-data): PUT or PATCH /_api/<set>(id)/<column> with the bytes as the body
// and the name in x-ms-file-name (header or query), GET /_api/<set>(id)/<column>/$value (the thumbnail of an image, or size=full),
// DELETE /_api/<set>(id)/<column>. The portal checks come first: the column enabled in Webapi/<table>/fields, its column
// permission, and the table permission (Read to download, Write to upload or delete) on the row. The bytes then go through
// the organization's file seam (store.recordPipeline.fileContentInternal, dataverse-files.mjs): column MaxSizeInKB, image
// sniffing, storage routing, the 404 of an empty file column and the 204 of an empty image, as on /api/data.
// The observed file-range profile is opt-in. Full downloads answer 200 and partial ones 206; upload or delete answer 204.
// A download is never served as its stored type on the portal origin (an uploaded .html would run as the reader):
// application/octet-stream with nosniff (sendFileColumnResponse). An upload without a name keeps the stored file's name, else
// <column>.bin (seam defaultName).
const FILE_BODY_LIMIT = 128 * 1024 * 1024; // Learn: a single-request Web API upload is under 128 MB.
const fileKind = (t) =>
  t.store.recordPipeline?.fileContentInternal?.kindOf?.(t.mapping.logicalName, t.target.segment) ?? null;
function filePrincipal(t, mapping, operation) {
  const userId =
    [t.deps.identity?.contactId, t.deps.identity?.id].find((value) => GUID_PATTERN.test(String(value ?? ''))) ??
    '00000000-0000-0000-0000-000000000000';
  return {
    userId,
    evidence: 'portal table permissions (webapi-handler.mjs)',
    grants: [{ entity: mapping.logicalName, operations: [operation] }],
  };
}
const rawBody = (req) => readRawBody(req, { maximum: FILE_BODY_LIMIT, tooLarge });
const transferOf = (download, method) => {
  if (download) return 'download';
  return method === 'DELETE' ? 'delete' : 'upload';
};
function observedFileRange(t) {
  return t.deps.portal?.observed?.webApiFileDownload === 'portal-range' && fileKind(t) === 'file';
}

function fileDownloadRange(t, range) {
  if (typeof range !== 'string') return null;
  if (!observedFileRange(t)) return range;
  assertObservedFileRange(range);
  // The observed portal interprets bytes=-N as the inclusive range from 0 to N.
  return range.trim().replace(/^bytes=-(\d+)$/, 'bytes=0-$1');
}

// The Range refusals of an observed portal file download (hosted session F1 API-04g, parity/portal-file-range-a.json and
// -b.json, 13 cases identical across runs): a header the front end cannot parse answers its own 400 page
// (sendFrontEndBadRange); more than one range answers the unsatisfiable-range 416 of a start past the end; a range whose
// end precedes its start answers 500 9004010A. Each refusal comes before the bytes are read.
const RANGE_SPEC = /^(\d*)-(\d*)$/;
function assertObservedFileRange(range) {
  const set = /^bytes=(.*)$/i.exec(range.trim());
  const specs = set ? set[1].split(',').map((spec) => RANGE_SPEC.exec(spec.trim())) : [null];
  if (specs.some((spec) => !spec || (spec[1] === '' && spec[2] === '')))
    throw new DataError('The Range header cannot be parsed.', 400, 'FrontEndBadRange');
  if (specs.length > 1)
    throw new DataError('A portal file download answers one range.', 416, 'InvalidRange', {
      innerCode: '0x80090000',
      exactLength: true,
    });
  const [, first, last] = specs[0];
  if (first !== '' && last !== '' && Number(last) < Number(first))
    throw new DataError('The range ends before it starts.', 500, 'WebApiFileRangeReversed', { exactLength: true });
}

// The bytes of an observed portal file download: a range starting past the end answers the captured 416 with its length.
async function observedRangeContent(t, read) {
  try {
    return await read();
  } catch (error) {
    if (observedFileRange(t) && error?.code === 'InvalidRange' && Number(error.status) === 416)
      error.details = { ...error.details, exactLength: true };
    throw error;
  }
}

// The front end's own answer to an unparseable Range header (hosted session F1 API-04g, runs a and b: these 339 bytes,
// no header but its type, length and date).
const FRONT_END_BAD_HEADER =
  '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN""http://www.w3.org/TR/html4/strict.dtd">\r\n' +
  '<HTML><HEAD><TITLE>Bad Request</TITLE>\r\n' +
  '<META HTTP-EQUIV="Content-Type" Content="text/html; charset=us-ascii"></HEAD>\r\n' +
  '<BODY><h2>Bad Request - Invalid Header</h2>\r\n' +
  '<hr><p>HTTP Error 400. The request has an invalid header name.</p>\r\n' +
  '</BODY></HTML>\r\n';
function sendFrontEndBadRange(t) {
  t.res.writeHead(400, {
    'content-type': 'text/html; charset=us-ascii',
    'content-length': String(Buffer.byteLength(FRONT_END_BAD_HEADER)),
    'x-sim-error-code': 'FrontEndBadRange',
  });
  return t.res.end(FRONT_END_BAD_HEADER);
}

// The portal has no chunked upload: the handshake (x-ms-transfer-mode: chunked) answers 500 9004010A "An unexpected
// error occurred while processing the request" (hosted session F1, API-04c, two runs); /api/data keeps its chunked
// sessions (dataverse-files.mjs).
function assertSingleRequestUpload(method, transferMode) {
  if (['PUT', 'PATCH'].includes(method) && transferMode?.trim().toLowerCase() === 'chunked')
    throw new DataError(
      'The portal Web API does not support chunked file uploads; send the file in one request.',
      500,
      'WebApiChunkedUploadUnsupported',
    );
}

// An image read names size=full or nothing (the thumbnail); size=thumbnail is refused (hosted session F1 files, runs a
// and b: 400 9004010D, cdscode 0x80060888).
function assertImageSizeSupported(t, download) {
  if (download && fileKind(t) === 'image' && t.url.searchParams.get('size') === 'thumbnail')
    throw new DataError('The size parameter value thumbnail is not supported.', 400, 'PortalImageSizeUnsupported', {
      innerCode: '0x80060888',
    });
}

// The entity tag of a ranged download: the stored file id's hash, as a replacement uses a new file id even when it keeps
// the filename and byte count. An If-Match naming another tag refuses the download. Null without a range.
function fileDownloadEtag(row, column, range, ifMatch) {
  if (range === null) return null;
  const etag = `"${createHash('sha256').update(String(row[column])).digest('hex')}"`;
  const match = ifMatch();
  if (match && match !== '*' && !match.split(',').some((value) => value.trim() === etag))
    throw new DataError('The file changed during the download.', 412, 'PreconditionFailed');
  return etag;
}

// The file transfer on the Web API span: the column, the operation and (once known) the file's name, size and type.
function recordFileTransfer(t, download, answer, fileName) {
  t.span?.set({
    fileColumn: t.target.segment,
    transfer: transferOf(download, t.method),
    ...(answer.file
      ? { fileName: answer.file.name, fileSize: answer.file.size, mimetype: answer.file.mimeType }
      : { fileName: fileName ?? undefined }),
  });
}

async function fileColumnRequest(t) {
  const { mapping, policy, target, method, store, deps, url, req } = t;
  const download = method === 'GET';
  if (download) policy.assert(target.segment);
  else policy.assertWrite({ [target.segment]: null }, 'update');
  const { id } = locate(t, mapping, target.key);
  const row = fileColumnRow(t, download, id);
  if (!row) throw recordNotFound(mapping, target.key);
  // A field-security projection may hide an existing file. Never re-read its
  // raw storage ID through the byte seam after the portal reader masked it.
  if (download && !GUID_PATTERN.test(String(row[target.segment] ?? ''))) return emptyFileColumn(t);
  const operation = download ? 'read' : 'update';
  store.assertAllowed(mapping.logicalName, operation, row, deps.identity);
  // The table permission check above is the grant; the profile only carries it into the seam's own check.
  const principal = filePrincipal(t, mapping, operation);
  const header = (name) => (typeof req.headers?.[name] === 'string' ? req.headers[name] : null);
  assertSingleRequestUpload(method, header('x-ms-transfer-mode'));
  assertImageSizeSupported(t, download);
  let range;
  try {
    range = download ? fileDownloadRange(t, header('range')) : null;
  } catch (error) {
    if (error?.code === 'FrontEndBadRange') return sendFrontEndBadRange(t);
    throw error;
  }
  const etag = fileDownloadEtag(row, target.segment, range, () => header('if-match'));
  const fileName = header('x-ms-file-name') ?? url.searchParams.get('x-ms-file-name');
  // A file name is a name, never a path: separators, NUL and "."/".." are refused before anything is read or stored.
  // The platform's code and wording for such a name are a guess.
  assertFileName(fileName);
  const content = download || method === 'DELETE' ? null : await rawBody(req);
  const answer = await observedRangeContent(t, () =>
    store.recordPipeline.fileContentInternal({
      principal,
      entity: mapping.logicalName,
      id: row[mapping.idColumn],
      column: target.segment,
      operation: transferOf(download, method),
      size: download && url.searchParams.get('size') === 'full' ? 'full' : null,
      range,
      content,
      fileName,
      contentType: header('content-type'),
      defaultName: true,
      portalImage: true,
    }),
  );
  recordFileTransfer(t, download, answer, fileName);
  const thumbnail = download && fileKind(t) === 'image' && url.searchParams.get('size') !== 'full';
  return sendFileColumnResponse(t, answer, etag, { thumbnail });
}

// The download headers of hosted session F1 (files runs a and b): application/octet-stream, inline with the stored name
// (`inline; filename=<name>`) and x-ms-file-name; an image thumbnail carries neither. Neither the stored type
// (mimetype) nor x-ms-file-size is sent. Mirage adds x-content-type-options: nosniff, which hosted does not send, so a
// browser never sniffs an uploaded page out of the octet-stream body on the portal origin (mirage/docs/dataverse-parity.md).
function sendFileColumnResponse(t, answer, etag, { thumbnail = false } = {}) {
  if (answer.statusCode === 204) return sendNoContent(t);
  const { name } = answer.file;
  const body = Buffer.from(answer.body['$content'], 'base64');
  const partial = answer.statusCode === 206;
  const observed = observedFileRange(t);
  const headers = apiHeaders(t.deps.portal);
  if (observed) {
    delete headers.etag;
    delete headers['accept-ranges'];
  }
  const expose = [];
  if (partial) expose.push('x-ms-chunk-size', 'content-range');
  if (partial && !observed) expose.push('etag');
  t.res.writeHead(answer.statusCode, {
    ...headers,
    'content-type': 'application/octet-stream',
    ...(thumbnail
      ? {}
      : {
          'content-disposition': contentDisposition('inline', name, { tokenFilename: true }),
          'x-ms-file-name': fileNameHeader(name),
        }),
    'x-content-type-options': 'nosniff',
    ...(observed ? { 'content-length': String(body.byteLength) } : { 'accept-ranges': 'bytes' }),
    ...(partial
      ? {
          'content-range': answer.headers['Content-Range'],
          'x-ms-chunk-size': answer.headers['x-ms-chunk-size'],
          ...(!observed ? { etag } : {}),
        }
      : {}),
    ...(expose.length ? { 'access-control-expose-headers': expose.join(', ') } : {}),
  });
  return t.res.end(body);
}

function fileColumnRow(t, download, id) {
  const { mapping, target, store } = t;
  if (download) return readRecord(t, mapping, id, target.key);
  if (id != null) return store.findByKey(mapping, String(id));
  return null;
}

function emptyFileColumn(t) {
  if (fileKind(t) === 'image') return sendNoContent(t);
  throw new DataError('No file attachment found.', 404, 'NotFound', { innerCode: '0x80040217' });
}

function assertFileName(fileName) {
  if (fileName != null && (/[\\/\0]/.test(fileName) || /^\.{1,2}$/.test(fileName.trim())))
    throw badRequest('The file name must not contain a path.', 'InvalidRequest', '0x80040203');
}

async function deleteProperty(t) {
  const { mapping, policy, target } = t;
  const { id } = locate(t, mapping, target.key);
  if (id == null) throw recordNotFound(mapping, target.key);
  const prepared = policy.prepareWrite({ [target.segment]: null }, 'update');
  await portalWrite(t, () => portalUpdate(t, mapping, id, prepared));
  return sendNoContent(t);
}

// On the enhanced data model the web role memberships are the N:N powerpagecomponent_mspp_webrole_contact; a $ref through
// mspp_webrole_contact or adx_webrole_contact (from a contact or a web role, whatever the Web API settings) answers
// 400 9004010A on a hosted site (session F1, summary-F1.md AUTH-03c, two runs without and two with settings).
const LEGACY_WEB_ROLE_NAVIGATIONS = new Set(['mspp_webrole_contact', 'adx_webrole_contact']);
function assertWebRoleNavigation(deps, target) {
  if (target.kind !== 'ref' || deps.portal?.format !== 'enhanced' || !LEGACY_WEB_ROLE_NAVIGATIONS.has(target.segment))
    return;
  throw new DataError(
    `${target.segment} is not a navigation property of the enhanced data model.`,
    400,
    'UndeclaredNavigationProperty',
    { phase: 'payload', navigation: target.segment },
  );
}
// The web role membership intersect is export-derived (site-tables.mjs). A hosted site checks the association rights of a
// DELETE $ref first and answers 204 without a backend call when the link is absent (session F1, AUTH-03c).
const membershipIntersect = (store, rel) => Boolean(rel?.intersect && store.siteMembership?.(rel.intersect.entity));
function membershipLinked(store, id, rel, targetId) {
  const link = rel.intersect;
  return store
    .tableRows(link.entity)
    .some(
      (edge) =>
        String(edge[link.from] ?? '').toLowerCase() === String(id).toLowerCase() &&
        String(edge[link.to] ?? '').toLowerCase() === String(targetId).toLowerCase(),
    );
}

// Native order for a collection-valued POST $ref (captured 2026-11-23): the association's table permissions and Write
// on the request's row are refused before the navigation's Web API field check. A DELETE of a derived web role
// membership checks its association rights first too (assertMembershipRemoval).
function fieldCheckDeferred({ store, target, method }, rel) {
  if (!rel) return false;
  if (method === 'DELETE') return membershipIntersect(store, rel);
  return rel.many !== false && target.targetKey == null && method === 'POST';
}

/** $ref: POST/DELETE on collection-valued, PUT/DELETE on single-valued navigation properties. */
async function reference(t) {
  const { mapping, policy, store, target, method } = t;
  const navigation = target.segment;
  if (!['POST', 'PUT', 'DELETE'].includes(method)) throw methodNotAllowed(method, '$ref');
  const rel = mapping.relationships?.[navigation];
  if (!fieldCheckDeferred(t, rel)) policy.assertWrite({ [`${navigation}@odata.bind`]: null }, 'update');
  if (!rel)
    throw new DataError(
      `Relationship ${navigation} is not mapped for ${mapping.logicalName}.`,
      400,
      'MissingRelationship',
    );
  const targetMapping = store.resolveMapping(rel.entity);
  const { id } = locate(t, mapping, target.key);
  if (id == null) throw recordNotFound(mapping, target.key);
  const single = rel.many === false;
  const referenced = (value, name) => {
    if (typeof value !== 'string') throw badRequest(`A target ${name} is required.`, 'InvalidLookup');
    const ref = checkReferenceOrigin(t, value, name);
    let referencedMapping;
    try {
      referencedMapping = resolveSet(store, ref.set);
    } catch {
      throw badRequest(`Relationship target ${ref.set} is not a mapped entity set.`, 'InvalidLookup');
    }
    if (referencedMapping.logicalName !== targetMapping.logicalName)
      throw badRequest('Relationship target entity does not match its mapping.', 'InvalidLookup');
    return { set: ref.set, id: locate(t, targetMapping, ref.id).id };
  };
  if (method === 'POST') {
    if (single || target.targetKey != null)
      throw methodNotAllowed(method, 'a single-valued navigation property; use PUT');
    const body = await readBody(t);
    const { id: targetId } = referenced(body['@odata.id'], '@odata.id');
    store.authorizedAssociation(mapping.logicalName, id, navigation, targetId, t.deps.identity, {
      portalRequest: true,
    });
    policy.assertWrite({ [`${navigation}@odata.bind`]: null }, 'update');
    await portalWrite(t, () => portalAssociation(t, mapping, id, navigation, targetId, true));
    return sendNoContent(t);
  }
  if (method === 'PUT') {
    if (!single || target.targetKey != null)
      throw methodNotAllowed(method, 'a collection-valued navigation property; use POST');
    const body = await readBody(t);
    const ref = referenced(body['@odata.id'], '@odata.id');
    const prepared = policy.prepareWrite({ [`${navigation}@odata.bind`]: `/${ref.set}(${ref.id})` }, 'update');
    await portalWrite(t, () => portalUpdate(t, mapping, id, prepared, { coerce: false }));
    return sendNoContent(t);
  }
  if (single) {
    if (target.targetKey != null || t.url.searchParams.has('$id'))
      throw badRequest('A single-valued navigation reference is removed without $id.', 'InvalidLookup', '0x0');
    const prepared = policy.prepareWrite({ [`${navigation}@odata.bind`]: null }, 'update');
    await portalWrite(t, () => portalUpdate(t, mapping, id, prepared, { coerce: false }));
    return sendNoContent(t);
  }
  const targetId =
    target.targetKey != null
      ? locate(t, targetMapping, target.targetKey).id
      : referenced(t.url.searchParams.get('$id') ?? undefined, '$id').id;
  if (!assertMembershipRemoval(t, { mapping, id, rel, navigation, targetId })) return sendNoContent(t);
  await portalWrite(t, () => portalAssociation(t, mapping, id, navigation, targetId, false));
  return sendNoContent(t);
}

// A DELETE $ref of a derived web role membership: the association rights, then (when the link exists) the navigation field
// check reference() deferred. False when there is nothing to remove.
function assertMembershipRemoval(t, { mapping, id, rel, navigation, targetId }) {
  if (!membershipIntersect(t.store, rel)) return true;
  t.store.authorizedAssociation(mapping.logicalName, id, navigation, targetId, t.deps.identity, {
    portalRequest: true,
    associationOnly: true,
  });
  if (!membershipLinked(t.store, id, rel, targetId)) return false;
  t.policy.assertWrite({ [`${navigation}@odata.bind`]: null }, 'update');
  return true;
}
