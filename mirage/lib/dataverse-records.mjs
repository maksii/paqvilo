import { cloneStateData } from './state-clone.mjs';
import { isDeepStrictEqual } from 'node:util';
import { pluginExecutionLifetime, pluginInvocationDepth } from './plugin-execution-lifetime.mjs';
import { globalMetadataVersion } from './metadata-version.mjs';
import { parseDataverseTop } from './dataverse-top.mjs';
import { organizationRecord } from './organization-context.mjs';
import { assertDataverseRootBody } from './dataverse-reader-details.mjs';
// Record handlers for the simulated Dataverse Web API: collections, single rows,
// properties, navigation, $ref and collection-bound actions. The Dataverse layer
// authorizes each call here before the store runs under the bypass identity.
import { DataError } from './data-error.mjs';
import { assertPluginMessageAdmission } from './plugin-message-admission.mjs';
import { refuseDeleteMultiple } from './plugin-platform-messages.mjs';
import { isConnectorDataverseSpan } from './connector-definition.mjs';
import { handoffPluginResponse } from './plugin-response.mjs';
import { executeBulkRecordsAsync } from './plugin-bulk.mjs';
import { associationRequestBinding } from './plugin-association.mjs';
import { recordToSdkEntity } from './plugin-clr.mjs';
import { odataToSdkQuery } from './plugin-query.mjs';
import { upsertSourceOperation } from './plugin-delegation.mjs';
import { isElastic, recordKey, samePartition } from './dataverse-elastic.mjs';
import { parseEntityReference, parseFetchXml } from './data.mjs';
import { DATAVERSE_SYSTEM_COLUMNS, parseXmlDocument, webApiPagingCookie } from './fetchxml-engine.mjs';
import {
  expressionPaths,
  parseApply,
  parseExpand,
  parseODataExpression,
  parseOrderBy,
  parseSelect,
  splitTopLevel,
} from './odata-query.mjs';
import { assertExpand, assertExpandText, childLinks } from './dataverse-expand.mjs';
import { FORMATTED, NAVIGATION, createWebApiFormatter } from './webapi-format.mjs';
import { baseCurrencyRow, ownershipOf, privilegeDeniedError, privilegeName, uuidV5 } from './dataverse-security.mjs';
import { dateTimeBehavior, fieldKind, formattedValue, guidKey, isDateOnlyField } from './dataverse-values.mjs';
import { fixedScaleNumeric } from './exact-numeric.mjs';
import { isSecuredField, maskedOperand } from './dataverse-fls.mjs';
import { createChangeLog, encodeDeltaToken, nextRowVersion } from './dataverse-changes.mjs';
import { standardNavigation } from './dataverse-standard.mjs';
import {
  annotationMatcher,
  skipTokenQueryValue,
  contextUrl,
  decodeSkipToken,
  encodeSkipToken,
  entityUrl,
  keySyntaxError,
  parseKey,
  preferenceApplied,
} from './dataverse-odata.mjs';

const PAGE_CAP = 5000;
// Control annotations a write may carry; other @ annotations are dropped by payload().
const CONTROL = new Set(['@odata.type', '@odata.context', '@odata.id', '@odata.etag']);
// owningteam is left out: assumed always null.
const OWNER_FIELDS = ['ownerid', 'owningbusinessunit'];
// System lookups every table carries (audit always, owner columns on user-owned tables), with their targets.
const SYSTEM_AUDIT = {
  createdby: ['systemuser'],
  modifiedby: ['systemuser'],
  createdonbehalfby: ['systemuser'],
  modifiedonbehalfby: ['systemuser'],
};
const SYSTEM_OWNER = {
  ownerid: ['systemuser', 'team'],
  owninguser: ['systemuser'],
  owningteam: ['team'],
  owningbusinessunit: ['businessunit'],
};
// Columns every table carries (audit, version and state stamps) that Solution metadata may not list; a read with no $select answers them.
const TABLE_COLUMNS = [...DATAVERSE_SYSTEM_COLUMNS];
const BIND = '@odata.bind';
const ALLOWED_QUERY = new Set([
  '$select',
  '$filter',
  '$expand',
  '$orderby',
  '$top',
  '$count',
  '$apply',
  '$skiptoken',
  '$deltatoken',
  '$id',
  'fetchXml',
  'fetchxml',
  'savedQuery',
  'userQuery',
  'partitionId',
  'tag',
  // Case-sensitive: any other casing keeps the 0x80060888 refusal.
  'UnMaskedData',
]);
const TRACKING_REJECTS = ['$filter', '$orderby', '$expand', '$top'];
const MONEY_SCALE = 4;
// The JSON type of a record read whose Accept asked for XML or text.
const JSON_STREAMING_CONTENT_TYPE = 'application/json; odata.metadata=minimal; odata.streaming=true';
const CURRENCY = '_transactioncurrencyid_value';
const RECORD_COUNT = 'Microsoft.Dynamics.CRM.totalrecordcount';
const RECORD_LIMIT = 'Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded';
const MORE_RECORDS = 'Microsoft.Dynamics.CRM.morerecords';
const PAGING_COOKIE = 'Microsoft.Dynamics.CRM.fetchxmlpagingcookie';
const GLOBAL_VERSION = 'Microsoft.Dynamics.CRM.globalmetadataversion';
const OVERRIDDEN = 'overriddencreatedon';
// System columns Dataverse rejects on create and update (IsValidForCreate/IsValidForUpdate false): accepted and ignored,
// the system stamp wins. Ignoring them silently is a guess.
const SYSTEM_IGNORED = new Set([
  'createdby',
  'createdon',
  'modifiedby',
  'modifiedon',
  'createdonbehalfby',
  'modifiedonbehalfby',
  'owninguser',
  'owningteam',
  'owningbusinessunit',
  'versionnumber',
]);
const ignoredSystem = (key) => SYSTEM_IGNORED.has(key.endsWith(BIND) ? key.slice(0, -BIND.length) : key);
// System lookups a plain (non-bind) property may not set: Dataverse answers 0x0. Their bind forms are accepted and ignored.
const LOOKUP_SYSTEM = new Set([...Object.keys(SYSTEM_AUDIT), ...Object.keys(SYSTEM_OWNER)]);

// Records hooks (api.recordHooks.add(name, fn)). Several functions may share a name and run in the order added.
// query and stream answer with the first result that is not undefined; project, source, beforeWrite and afterWrite run them all.
// source (c, mapping, { single, id }) runs, awaited, before a Web API read answers from the store: a collection, $count or
// navigation read (single false; c.url carries the query options) or a single record, property or $value read (single true,
// id the addressed primary key, null for an alternate key). A hook may refresh the rows the read then answers from (the
// virtual-table providers do); a throw answers the read with its error.
// external (c, mapping, { operation, id }) is the main-operation stage (native stage 30): it runs after the store write has
// passed every check (ETag, alternate keys, required columns, store plug-ins) and before the afterWrite hooks, inside the
// write's transaction, so a write refused locally never reaches it and its throw rolls the local write back. The hooks share
// one info object: an external hook that re-keys the row sets info.id for the afterWrite hooks.
// add(name, fn, module): module names the registering module in refusals (moduleOf); the function name stands in without it.
export function createRecordHooks() {
  const byName = new Map(),
    modules = new WeakMap();
  return {
    add(name, fn, module) {
      if (typeof fn !== 'function') throw new TypeError(`Record hook ${name} must be a function.`);
      if (module) modules.set(fn, String(module));
      byName.set(name, [...(byName.get(name) ?? []), fn]);
    },
    list: (name) => byName.get(name) ?? [],
    moduleOf: (fn) => modules.get(fn) ?? (fn.name || 'an unnamed record hook'),
  };
}

const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });
// A key the entity does not declare: the OData payload reader's 0x80048d19 (native batch.rollback), without its stack trace.
const unknownProperty = (key, mapping) =>
  new DataError(
    `Error identified in Payload provided by the user for Entity :'${mapping.entitySet}', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : Microsoft.Crm.CrmException: Invalid property '${key}' was found in entity 'Microsoft.Dynamics.CRM.${mapping.logicalName}'. ---> Microsoft.OData.ODataException: The property '${key}' does not exist on type 'Microsoft.Dynamics.CRM.${mapping.logicalName}'. Make sure to only use property names that are defined by the type.`,
    400,
    'InvalidRequest',
    { innerCode: '0x80048d19' },
  );
// A lookup, owner or audit value given as a plain value: the untyped-value form, 0x0 (assumed native answer).
const untypedProperty = (key, logical) =>
  new DataError(
    `An error occurred while validating input parameters: Microsoft.Crm.CrmException: Invalid property '${key}' was found in entity 'Microsoft.Dynamics.CRM.${logical}'. ---> Microsoft.OData.ODataException: Does not support untyped value in non-open type.`,
    400,
    'InvalidRequest',
    { innerCode: '0x0' },
  );
const LOOKUP_VALUE = /^_[^@]+_value$/;
// Native answers an unknown or wrongly cased entity set with 404 0x80060888 (the same segment message).
const unknownSet = (set) =>
  new DataError(`Resource not found for the segment '${set}'.`, 404, 'UnknownEntity', {
    httpStatus: 404,
    innerCode: '0x80060888',
    route: true,
  });
// A key whose alternate-key names the entity does not declare: the native key rule, a 400 0x80060888.
const keyNotDeclared = (mapping) =>
  new DataError(
    `The key in the request URI is not valid for resource 'Microsoft.Dynamics.CRM.${mapping.logicalName}'. Ensure that the names and number of key properties match the declared or alternate key properties for the resource 'Microsoft.Dynamics.CRM.${mapping.logicalName}'.`,
    400,
    'InvalidKey',
    { httpStatus: 400, innerCode: '0x80060888', route: true },
  );
const notFoundRecord = (logical, id, innerCode = '0x80040217') =>
  new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, 'NotFound', { id, innerCode });
const noResource = (c) =>
  new DataError(`No HTTP resource was found that matches the request URI '${c.url.href}'.`, 404, 'UnknownResource', {
    innerCode: '',
  });
const methodNotAllowed = (method) =>
  new DataError(`The requested resource does not support http method '${method}'.`, 405, 'MethodNotAllowed', {
    innerCode: '',
  });
const sameId = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const withoutNulls = (row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
const etagOf = (body) => (body['@odata.etag'] ? { ETag: body['@odata.etag'] } : {});
// Preference-Applied for the Prefer options a request carried; preferenceApplied owns the wording.
const appliedHeader = (prefer, options) => {
  const applied = preferenceApplied(prefer, options);
  return applied ? { 'Preference-Applied': applied } : {};
};
// A write representation drops the columns it leaves null, with their @ annotations (as every native PATCH 200 body does).
const withoutNullColumns = (body) => {
  const nulls = new Set(Object.keys(body).filter((key) => !key.includes('@') && body[key] === null));
  return Object.fromEntries(Object.entries(body).filter(([key]) => !nulls.has(key.split('@')[0])));
};
const emptyPage = () => ({ value: [], paging: { moreRecords: false, totalCount: 0 } });

function checkQuery(url, { nativeSyntax = false } = {}) {
  for (const name of url.searchParams.keys()) {
    if (!ALLOWED_QUERY.has(name) && !name.startsWith('@')) {
      if (nativeSyntax && name === '$skip')
        throw new DataError('Skip Clause is not supported in CRM', 400, 'UnsupportedQuery', {
          innerCode: '0x80060888',
        });
      if (name === '$search')
        throw new DataError('The "$search" query parameter isn\'t supported.', 501, 'UnsupportedQueryFunction');
      throw new DataError(`The query parameter ${name} is not supported`, 400, 'UnsupportedQuery', {
        innerCode: '0x80060888',
      });
    }
  }
}

// $skiptoken names a page; offsets are (pageNumber - 1) * pageSize into the stable result order.
// A token that is not a paging cookie at all is read as malformed XML by Dataverse (0x80040201).
function pageOffset(url, pageSize) {
  const text = url.searchParams.get('$skiptoken');
  if (text == null) return 0;
  const token = decodeSkipToken(text);
  if (!token) throw invalid('Malformed XML', '0x80040201');
  const offset = Number.isInteger(token.pageNumber) && token.pageNumber >= 2 ? (token.pageNumber - 1) * pageSize : -1;
  if (offset < 0) throw invalid('The $skiptoken is not valid.', '0x80060888');
  return offset;
}

// The delta token a tracked page's $skiptoken carries (see collectionPage); null when the token has none.
const carriedDelta = (url) => /\sdeltatoken="([^"]*)"/.exec(url.searchParams.get('$skiptoken') ?? '')?.[1] ?? null;

// The primary id always travels with $select so paging and etags have it; the context URL keeps the caller's list.
function withIdSelect(select, idColumn) {
  if (select == null || select === '*' || (parseSelect(select) ?? []).includes(idColumn)) return select;
  return `${select},${idColumn}`;
}

// Mirrors the handler's annotation stripping: @odata.* always stays, other annotations need a match.
// Expanded rows (single or collection, at any depth) follow the same rule for their own annotations: without Prefer, no
// FormattedValue or lookup annotation leaks into an expanded row.
function keepAnnotations(value, include) {
  const nested = (item) =>
    item !== null && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype
      ? keepAnnotations(item, include)
      : item;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const at = key.indexOf('@');
    const term = at < 0 ? null : key.slice(at + 1);
    if (term != null && !term.startsWith('odata.') && !(include && include(term))) continue;
    out[key] = Array.isArray(item) ? item.map(nested) : nested(item);
  }
  return out;
}

// Accepts /set(key), set(key), absolute <origin>/api/data/vX/set(key) and alternate-key forms.
// urlKey: the value is a URL key ($id), which keeps the route flag; a bind or $ref body value does not (native sends REQ_ID twice).
function refOf(value, { urlKey = false } = {}) {
  const text = String(value ?? '')
    .trim()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/?api\/data\/v\d+\.\d+\//i, '');
  const ref = parseEntityReference(text);
  if (!ref) throw invalid(`Invalid entity reference '${text}'.`, '0x80048d19');
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
// A nextLink encodes each value like encodeURIComponent ( ) ' stay literal, , and : are escaped;
// a deltaLink keeps the caller's $select raw.
function linkOf(c, base, name, token, { raw = false } = {}) {
  const query = new URLSearchParams(c.url.searchParams);
  query.delete('$skiptoken');
  query.delete('$deltatoken');
  const text = [...query]
    .map(([key, value]) => `${key}=${(raw ? value : encodeURIComponent(value)).replace(/%24/g, '$')}`)
    .join('&');
  return `${base}?${text ? `${text}&` : ''}${name}=${token}`;
}
// The token is passed to skipTokenQueryValue after one decode: its inner pagingcookie stays percent-encoded.
const nextLinkOf = (c, base, token) => linkOf(c, base, '$skiptoken', skipTokenQueryValue(decodeURIComponent(token)));
const deltaLinkOf = (c, base, token) => linkOf(c, base, '$deltatoken', encodeDeltaToken(token), { raw: true });

// An alternate-key duplicate from the store answers the Web API's 412 Entity Key wording. fn may answer a promise (a store write on
// the asynchronous pipeline, data.mjs createRecordAsync); its rejection is translated the same way.
function withKeyViolation(mapping, data, fn) {
  try {
    const result = fn();
    return typeof result?.then === 'function'
      ? result.catch((error) => {
          throw keyViolation(mapping, data, error);
        })
      : result;
  } catch (error) {
    throw keyViolation(mapping, data, error);
  }
}
function keyViolation(mapping, data, error) {
  if (error?.code !== 'DuplicateRecord' || !String(error.message).startsWith('A record that has the attribute values'))
    return error;
  const attributesOf = (key) => key.attributes ?? key.keyAttributes ?? [];
  const keys = mapping.alternateKeys ?? [];
  const key = keys.find((item) => attributesOf(item).every((name) => name in data)) ?? keys[0];
  if (!key) return error;
  const columns = attributesOf(key);
  const keyName = key.name ?? columns.join('_');
  return new DataError(
    `Entity Key ${keyName} violated. A record with the same value for ${columns.join(', ')} already exists. A duplicate record cannot be created. Select one or more unique values and try again.`,
    412,
    'DuplicateRecord',
    { innerCode: '0x80060892', keyName, columns },
  );
}

// Span names and operations of the dataverse spans (tracing): the message a route or internal entry runs.
const OPERATION_LABEL = {
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  retrieve: 'Retrieve',
  retrievemultiple: 'RetrieveMultiple',
  associate: 'Associate',
  disassociate: 'Disassociate',
  action: 'Action',
};
// Tracing of a Web API dispatch (docs/design/tracing.md, D-R3-1, D-R3-2, D-R3-22).
const GUID_TEXT = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
// The record a keyed route names by primary key; an alternate key resolves in the store (data.mjs traceRecord).
function routeRecordId(route) {
  if (route?.key == null) return null;
  try {
    return parseKey(route.key)?.id ?? null;
  } catch {
    return null;
  }
}
// The kind of query a request carries (attribute `query`), or null.
function queryKindOf(url) {
  const has = (name) => url.searchParams.has(name);
  if (has('fetchXml') || has('fetchxml')) return 'fetchxml';
  if (has('savedQuery')) return 'savedquery';
  if (has('userQuery')) return 'userquery';
  if (has('$deltatoken')) return 'delta';
  if (has('$apply')) return 'apply';
  return ['$filter', '$select', '$orderby', '$top', '$skip', '$expand', '$count', '$search', '$skiptoken'].some(has)
    ? 'odata'
    : null;
}
// Level full: the body, the query options (credential-named values redacted by the store) and the headers that change the
// answer.
const DISPATCH_HEADERS = ['prefer', 'if-match', 'if-none-match'];
function dispatchInput(c) {
  const headers = Object.fromEntries(
    DISPATCH_HEADERS.filter((name) => c.headers?.[name] != null).map((name) => [name, String(c.headers[name])]),
  );
  return {
    ...(c.body === undefined ? {} : { body: c.body }),
    query: c.url.searchParams,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}
// One bypass event per bypass header on the request: what it asked and which logic the local pipeline skipped for it.
// BypassCustomPluginExecution true and BypassBusinessLogicExecution CustomSync skip the synchronous plug-in stages.
const BYPASS_HEADERS = [
  ['mscrm.bypasscustompluginexecution', 'MSCRM.BypassCustomPluginExecution'],
  ['mscrm.bypassbusinesslogicexecution', 'MSCRM.BypassBusinessLogicExecution'],
];
function bypassEvents(span, c) {
  if (!span) return;
  for (const [name, header] of BYPASS_HEADERS) {
    const value = c.headers?.[name];
    if (value == null || String(value).trim() === '') continue;
    const words = String(value)
      .split(',')
      .map((word) => word.trim().toLowerCase());
    const skips =
      c.bypassCustomPlugins === true &&
      (name === 'mscrm.bypasscustompluginexecution' ? ['true', '1'].includes(words[0]) : words.includes('customsync'));
    span.event('bypass', { attributes: { header, value: String(value), skipped: skips ? ['sync-plugins'] : [] } });
  }
}
// The answer of a dispatch: its status, a single row's id, and for a collection page its row count, page number and
// (when the answer carries them) total count and whether more records follow; the output only at level full.
function dispatchAnswer(span, c, mapping, answer) {
  if (!span) return;
  const body =
    answer?.body && typeof answer.body === 'object' && !Buffer.isBuffer(answer.body) && !answer.body.pipe
      ? answer.body
      : null;
  const page = Array.isArray(body?.value);
  if (!page && span.recordId == null && body?.[mapping.idColumn] != null)
    span.setEntity(mapping.logicalName, String(body[mapping.idColumn]));
  let pageNumber;
  if (page) {
    try {
      pageNumber = decodeSkipToken(c.url.searchParams.get('$skiptoken') ?? '')?.pageNumber ?? 1;
    } catch {
      pageNumber = 1;
    }
  }
  const total = page ? (body['@odata.count'] ?? body['@Microsoft.Dynamics.CRM.totalrecordcount']) : undefined;
  span.set({
    statusCode: answer?.status ?? null,
    rowCount: page ? body.value.length : undefined,
    pageNumber,
    query: queryKindOf(c.url) ?? undefined,
  });
  span.output(() => ({
    id: span.recordId,
    rowCount: page ? body.value.length : null,
    ...(total != null ? { totalCount: total } : {}),
    ...(page ? { moreRecords: body['@odata.nextLink'] != null } : {}),
    statusCode: answer?.status ?? null,
  }));
}

const WEB_API_OPERATION = {
  collection: { GET: 'retrievemultiple', POST: 'create' },
  count: { GET: 'retrievemultiple' },
  entity: { GET: 'retrieve', PATCH: 'update', DELETE: 'delete' },
  property: { GET: 'retrieve', PUT: 'update', DELETE: 'update' },
  member: { GET: 'retrieve', PUT: 'update', DELETE: 'update' },
  value: { GET: 'retrieve' },
  navigationCount: { GET: 'retrievemultiple' },
  ref: { GET: 'retrieve', POST: 'associate', PUT: 'associate', DELETE: 'disassociate' },
  navigationRef: { DELETE: 'disassociate' },
  boundAction: { POST: 'action' },
};

// changeTrackingEnabled(logical) overrides the table's metadata flag; without it the flag is read from the mapping,
// and an undefined flag keeps tracking allowed.
// fieldSecurity is a getter for api.fieldSecurity (dataverse-fls): the extension installs after the handlers exist. Absent or
// undefined, no column is hidden.
export function createRecordHandlers({
  store,
  change,
  principals,
  metadata,
  metadataFields = () => undefined,
  clock = () => Date.now(),
  changes = createChangeLog(store, { clock }),
  changeTrackingEnabled,
  hooks = createRecordHooks(),
  fieldSecurity,
}) {
  const authorize = (c, entity, operation, mapping, row) =>
    principals.authorize({ user: c.user, entity, operation, row, mapping });
  // One dataverse span per internal entry and per Web API dispatch (docs/design/tracing.md); a plug-in step's nested SDK
  // writes run on the same stack, so their spans nest under the step. c is the resolved context (internalContext).
  // Record identity (D-R3-1): a primary key names the record at start; an alternate key or a create's id is named by the
  // store as soon as it resolves the row (data.mjs traceRecord), and an internal entry's returned row names it otherwise.
  // A Web API dispatch (dispatch: true) records its answer itself (dispatchAnswer).
  const traced = (c, operation, entity, recordId, { sync, authorized, dispatch = false } = {}, input, run) => {
    const traces = store.traces;
    const current = traces?.enabled ? traces.current() : null;
    // A bulk message has one span; its per-row writes open none (plugin-bulk.mjs). A flow Dataverse connector call is one
    // dataverse span too (connector-runtime.mjs dataverseProvider, marked by markConnectorDataverseSpan): the entries it
    // drives open none.
    if (!traces?.enabled || current?.kind === 'bulk' || isConnectorDataverseSpan(current)) return run();
    const user = c.portal ? null : c.user;
    return traces.wrap(
      {
        kind: 'dataverse',
        name: `${OPERATION_LABEL[operation] ?? operation} ${entity}`,
        module: 'dataverse',
        operation,
        entity,
        recordId: GUID_TEXT.test(String(recordId ?? '')) ? String(recordId).replace(/[{}]/g, '').toLowerCase() : null,
        ...(user
          ? {
              actor: {
                kind: user.applicationid ? 'app' : 'staff',
                id: user.systemuserid ?? null,
                name: user.fullname ?? null,
              },
            }
          : {}),
        attributes: {
          sync: sync === true,
          authorized: authorized === true,
          method: c.method ?? null,
          portal: c.portal ? true : undefined,
          impersonatedBy: user?.impersonator?.systemuserid,
          sdkUserId: c.method === 'SDK' ? (c.userId ?? undefined) : undefined,
        },
        input,
      },
      (span) => {
        const result = run(span);
        if (dispatch) return result;
        const done = (value) => {
          const id = (value && typeof value === 'object' ? value[store.resolveMapping(entity).idColumn] : null) ?? null;
          if (id != null && span.recordId == null) span.setEntity(entity, String(id));
          span.output(() => ({ id: span.recordId }));
          return value;
        };
        return typeof result?.then === 'function' ? result.then(done) : done(result);
      },
    );
  };
  const hookList = (name) => hooks.list?.(name) ?? [];
  const runHooks = (name, ...args) => {
    for (const hook of hookList(name)) hook(...args);
  };
  // Write hooks are awaited inside the write's store transaction (every write path runs them in runWrite), so their
  // state changes commit or roll back with the write; a throw rolls the write back.
  const runWriteHooks = async (name, ...args) => {
    for (const hook of hookList(name)) await hook(...args);
  };
  const beforeWrite = (c, mapping, info) => runWriteHooks('beforeWrite', c, mapping, info);
  const afterWrite = async (c, mapping, info) => {
    await runWriteHooks('external', c, mapping, info);
    await runWriteHooks('afterWrite', c, mapping, info);
  };
  const source = (c, mapping, info) => runWriteHooks('source', c, mapping, info);
  // The single-row source call for a keyed route (entity, property, $value, navigation parent).
  const sourceKey = (c, mapping) => source(c, mapping, { single: true, id: parseKey(c.route.key)?.id ?? null });
  // Async-capable first answer: the first hook whose result is not undefined wins.
  const firstAnswer = async (name, ...args) => {
    for (const hook of hookList(name)) {
      const answer = await hook(...args);
      if (answer !== undefined) return answer;
    }
    return undefined;
  };
  const trackingFlag = (logical, mapping) =>
    changeTrackingEnabled
      ? changeTrackingEnabled(logical)
      : (mapping.changeTrackingEnabled ?? mapping.dataverseMetadata?.ChangeTrackingEnabled);
  const addMetadataVersion = (c, body) => {
    if (c.include?.(GLOBAL_VERSION)) body[`@${GLOBAL_VERSION}`] = globalMetadataVersion(store);
    return body;
  };
  // savedQuery and userQuery are answered only by a query hook; without an answer Dataverse's 501 stands.
  const assertPredefinedAnswered = (url) => {
    for (const name of ['savedQuery', 'userQuery']) {
      if (url.searchParams.has(name))
        throw new DataError(`${name} has not yet been implemented.`, 501, 'NotImplemented', {
          innerCode: '0x80040216',
        });
    }
  };
  const filterOf = (c, mapping) =>
    principals.readFilter({ user: c.user, entity: mapping.logicalName, mapping }) ?? null;
  // Row filter for every table a query reads: root, $expand, navigation $filter/$orderby and link-entity. Those tables are
  // read-authorized up front (assertQueryMembers, fetchXmlPage), so an empty table still answers 403; this trims rows.
  const rowsFilterOf = (c) => {
    const filters = new Map();
    return (name, row) => {
      if (!filters.has(name)) filters.set(name, principals.readFilter({ user: c.user, entity: name }) ?? (() => true));
      return filters.get(name)(row);
    };
  };
  // Column security for the same reads: the store evaluates every table's rows with the columns the caller cannot read nulled
  // (api.fieldSecurity.rowMask), so no filter, order, aggregate, join, lambda or $expand option observes a hidden value.
  const rowsOptionsOf = (c) => {
    const fs = fieldSecurity?.();
    return {
      backendRowsFilter: rowsFilterOf(c),
      bypassCustomPlugins: c.bypassCustomPlugins === true,
      bypassStepIds: c.bypassStepIds,
      ...(c.sdkQuery ? { sdkQuery: c.sdkQuery } : {}),
      sdkResponseToken: c.sdkResponseToken,
      ...(fs?.rowMask ? { backendRowsMask: (name) => fs.rowMask(c.user, name) } : {}),
    };
  };
  // Web API reads add their request inputs to the Retrieve/RetrieveMultiple Target-less parameters (native recorder
  // parity corpus, reads): IncludeAnnotations (whether Prefer asks for annotations), and for collections the app-module
  // inputs of a request outside an app.
  const webApiReadFrame = (c, multiple) =>
    c.method === 'GET' && !c.portal
      ? {
          inputParameters: {
            $type: 'ParameterCollection',
            values: {
              IncludeAnnotations: Boolean(c.prefer?.annotations),
              ...(multiple
                ? {
                    AppModuleId: { $type: 'Guid', value: '00000000-0000-0000-0000-000000000000' },
                    IsAppModuleContext: false,
                  }
                : { ReturnNotifications: false }),
            },
          },
        }
      : undefined;
  const secured = (c, extra = {}) =>
    queryOptions({
      bypassCustomPlugins: c.bypassCustomPlugins === true,
      ...extra,
      ...rowsOptionsOf(c),
    });
  // Field metadata as this layer reads it: the system lookups are always declared, so a null lookup serializes as _x_value.
  const systemFields = (logical) => {
    let m;
    try {
      m = store.resolveMapping(logical);
    } catch {
      return {};
    }
    const names =
      ownershipOf(m.logicalName, undefined, m) === 'user' ? { ...SYSTEM_AUDIT, ...SYSTEM_OWNER } : SYSTEM_AUDIT;
    return Object.fromEntries(
      Object.entries(names).map(([n, targets]) => [
        n,
        { dataverseType: n === 'ownerid' ? 'owner' : 'lookup', targets },
      ]),
    );
  };
  const fieldsOf = (logical) => ({ ...systemFields(logical), ...(metadataFields(logical) ?? {}) });
  // Collection projection is synchronous. Reuse derived definitions only while
  // shaping that page; the next request must observe source/metadata changes.
  let projectionFields = null;
  const projectPage = (fn) => {
    const previous = projectionFields;
    projectionFields ??= new Map();
    try {
      return fn();
    } finally {
      projectionFields = previous;
    }
  };
  const declaredFields = (logical, includeNonOData = false) => {
    const key = `${logical}:${includeNonOData ? 'all' : 'odata'}`;
    if (projectionFields?.has(key)) return projectionFields.get(key);
    const fields = metadata?.recordFields?.(logical, { includeNonOData });
    projectionFields?.set(key, fields);
    return fields;
  };
  const readFieldsOf = (logical) => {
    if (projectionFields?.has(logical)) return projectionFields.get(logical);
    const definitions = declaredFields(logical);
    if (!definitions) return fieldsOf(logical);
    const originalFields = fieldsOf(logical);
    // Metadata controls which structural properties exist. Preserve the record pipeline's source/observed
    // formatting facts for those properties instead of replacing option labels with synthesized defaults.
    const fields = Object.fromEntries(
      Object.entries(definitions).map(([name, definition]) => {
        const source = store.fieldDefinition(logical, name, () => originalFields);
        const field = source ? { ...definition, ...source } : definition;
        const options = field.options ?? field.statuses ?? field.states;
        return [name, options ? { ...field, options } : field];
      }),
    );
    projectionFields?.set(logical, fields);
    return fields;
  };
  const readDefinition = (mapping, name) => {
    const fields = metadata?.recordFields ? readFieldsOf(mapping.logicalName) : null;
    return fields
      ? fields[/^_(.+)_value$/.exec(name)?.[1] ?? name]
      : store.fieldDefinition(mapping.logicalName, name, fieldsOf);
  };
  const queryOptions = (extra = {}) => ({ dialect: 'dataverse', metadata: readFieldsOf, includeKeys: true, ...extra });
  // dataverseWebApi: the Dataverse Web API's stricter value rules (lib/data.mjs coerceValue); the portal /_api never sets it.
  const writeOptions = (extra = {}) => ({ coerce: true, metadata: fieldsOf, dataverseWebApi: true, ...extra });
  const runWrite = (fn) => change(() => store.transact(fn, { incremental: true }));
  const contextFor = (c, suffix) => contextUrl(c.origin, c.version, suffix);
  // The context lists the $select columns (a repeated one once) then each expanded navigation with its own columns and nested expansions.
  const navContext = (item) => {
    const columns = [...(item.select ? (parseSelect(item.select) ?? []) : []), ...(item.expand ?? []).map(navContext)];
    return `${item.navigation}(${[...new Set(columns)].join(',')})`;
  };
  const suffixFor = (c, mapping) => {
    const text = c.url.searchParams.get('$select');
    if (text?.trim() === '*') return `${mapping.entitySet}(*)`;
    const parts = [...(parseSelect(text) ?? []), ...parseExpand(c.url.searchParams.get('$expand')).map(navContext)];
    const unique = [...new Set(parts)];
    return `${mapping.entitySet}${unique.length ? `(${unique.join(',')})` : ''}`;
  };
  const bodyOf = (set, body, c) => {
    assertDataverseRootBody(body, c?.dataverseHttpReader);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    throw invalid(
      `Error identified in Payload provided by the user for Entity :'${set}'  ---->  InnerException : A request body is required.`,
      '0x80048d19',
    );
  };
  // The organization's base currency seeded by the security model, found by the organization row's id; null when the Dataverse tables are absent.
  const baseCurrency = () => baseCurrencyRow(store, organizationRecord(store)?.organizationid);
  const isMoney = (mapping, key) => fieldKind(readDefinition(mapping, key)) === 'money';
  // No $select (or $select=*) answers every column, the currency lookup included; a $select list answers it only when named.
  const currencySelected = (c) => {
    const select = parseSelect(c.url.searchParams.get('$select'));
    return select == null || select.includes(CURRENCY);
  };
  // A single row whose $select names a money column answers the base currency lookup too (see formatRow).
  const moneyNamed = (c, mapping) =>
    (parseSelect(c.url.searchParams.get('$select')) ?? []).some((name) => isMoney(mapping, name));
  // Whether the stored row holds a base currency (transactioncurrencyid, set by currencyOnWrite). Ids of the table's holders are
  // read once per request (c.currencyHolders), so a row's lookup follows what was stored rather than what it projects.
  const keyOfId = (id) =>
    String(id ?? '')
      .replace(/[{}]/g, '')
      .toLowerCase();
  // A keyed table answers each row through its primary key; a table without that index is scanned once per request.
  function currencyHeld(c, mapping, id) {
    const holders = (c.currencyHolders ??= new Map());
    if (!holders.has(mapping.logicalName)) holders.set(mapping.logicalName, { ids: new Map(), all: null });
    const table = holders.get(mapping.logicalName),
      key = keyOfId(id);
    if (!table.all && !table.ids.has(key)) {
      const stored = typeof id === 'string' ? store.primaryKeySubset(mapping, [id]) : null;
      if (stored)
        table.ids.set(
          key,
          stored.some((row) => row.transactioncurrencyid != null),
        );
      else {
        const rows = store.state.tables[mapping.logicalName] ?? [];
        table.all = new Set(
          rows.filter((row) => row.transactioncurrencyid != null).map((row) => keyOfId(row[mapping.idColumn])),
        );
      }
    }
    return table.all ? table.all.has(key) : table.ids.get(key);
  }
  // A write that gives a money column a non-null value stores the base currency on the row, once the organization has one.
  // A row never given a money value has no currency lookup; setting a money value supplies one.
  function currencyOnWrite(mapping, row) {
    // An explicit currency lookup (a body bind resolved to the column) is kept, not replaced by the base currency.
    if (row?.transactioncurrencyid != null) return {};
    const given = Object.keys(row ?? {}).some((key) => !key.includes('@') && row[key] != null && isMoney(mapping, key));
    const base = given ? baseCurrency() : null;
    return base ? { transactioncurrencyid: base.transactioncurrencyid } : {};
  }

  // Money columns serialize with four-decimal lexemes, and a row that carries one reports the base currency lookup,
  // but only when the caller's $select asks for it (or selects everything): Dataverse omits the lookup otherwise.
  function shapeMoney(mapping, out, { currencyWanted = true, named = false } = {}) {
    // named: the money column was selected on a single row, so it counts even when its value is null (as a native key GET with a money $select does).
    let money = named;
    for (const key of Object.keys(out)) {
      if (key.includes('@') || !isMoney(mapping, key)) continue;
      money = true;
      if (out[key] == null) continue;
      out[key] = fixedScaleNumeric(out[key], MONEY_SCALE);
      // Negative money values format as a parenthesized symbol and amount.
      const text = out[`${key}${FORMATTED}`];
      if (typeof text === 'string' && out[key]?.value?.startsWith?.('-'))
        out[`${key}${FORMATTED}`] = text.replace(/^([^\d-]*)-(.*)$/, '($1$2)');
    }
    const currency = money && currencyWanted ? baseCurrency() : null;
    if (!currency) return out;
    // A stored currency lookup (currencyOnWrite) can already be in out, from the formatter, without its annotations: they still come.
    out[CURRENCY] ??= currency.transactioncurrencyid;
    out[`${CURRENCY}${FORMATTED}`] ??= currency.currencyname;
    out[`${CURRENCY}@Microsoft.Dynamics.CRM.associatednavigationproperty`] ??= 'transactioncurrencyid';
    out[`${CURRENCY}@Microsoft.Dynamics.CRM.lookuplogicalname`] ??= 'transactioncurrency';
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
  const navigationOf = (mapping, segment) =>
    mapping.relationships?.[segment] ?? standardNavigation(store, mapping.logicalName, segment);
  // The facts assertExpand reads: many-valued unless many is false, the N:N intersect and the target mapping.
  const relationshipOf = (mapping, navigation) => {
    const rel = navigationOf(mapping, navigation);
    return rel
      ? { many: rel.many !== false, intersect: rel.intersect, target: store.resolveMapping(rel.entity) }
      : null;
  };
  const isMember = (mapping, name) =>
    name === mapping.idColumn ||
    Boolean(navigationOf(mapping, name)) ||
    Boolean(store.fieldDefinition(mapping.logicalName, name, fieldsOf));
  // A nav@odata.bind names a navigation (case-sensitive), never a column; the system lookups bind on their column name.
  // ponytail: as data.mjs normalizeRecord, a lookup column no relationship covers binds on its exact name.
  const undeclaredLookup = (mapping, nav) =>
    fieldKind(mapping.fields?.[nav]) === 'lookup' &&
    !Object.values(mapping.relationships ?? {}).some((rel) => rel?.from === nav);
  const isBindable = (mapping, nav) =>
    Boolean(navigationOf(mapping, nav)) ||
    (LOOKUP_SYSTEM.has(nav) && isMember(mapping, nav)) ||
    nav === 'transactioncurrencyid' ||
    undeclaredLookup(mapping, nav);
  const undeclared = (set, nav) =>
    invalid(
      `Error identified in Payload provided by the user for Entity :'${set}'  ---->  InnerException : Microsoft.OData.ODataException: An undeclared property '${nav}' which only has property annotations in the payload but no property value was found in the payload. In OData, only declared navigation properties and declared named streams can be represented as properties without values`,
      '0x80048d19',
    );
  // Every key of a write must be a property, the id, a navigation or a nav@odata.bind on one. An undeclared name is 0x80048d19;
  // a lookup or audit value given plainly is the untyped form (0x0).
  function assertPayload(mapping, body) {
    for (const key of Object.keys(body)) {
      if (CONTROL.has(key) || (key.includes('@') && !key.endsWith(BIND))) continue;
      if (key.endsWith(BIND)) {
        const nav = key.slice(0, -BIND.length);
        if (!isBindable(mapping, nav)) throw undeclared(mapping.entitySet, nav);
        continue;
      }
      // A plain lookup, owner or customer value is untyped: lookups are set through @odata.bind (a navigation object is a deep insert).
      const lookup = fieldKind(store.fieldDefinition(mapping.logicalName, key, fieldsOf)) === 'lookup';
      const deepInsert = navigationOf(mapping, key) && body[key] && typeof body[key] === 'object';
      if (LOOKUP_SYSTEM.has(key) || LOOKUP_VALUE.test(key) || (lookup && !deepInsert))
        throw untypedProperty(key, mapping.logicalName);
      if (!isMember(mapping, key)) throw unknownProperty(key, mapping);
    }
  }

  // The table a navigation leads to, read-authorized up front: a table with no rows still answers 403 when the caller cannot read it.
  const readableTarget = (c, mapping, navigation) => {
    const target = store.resolveMapping(navigationOf(mapping, navigation).entity);
    authorize(c, target.logicalName, 'read', target);
    return target;
  };
  // Every $expand target, nested ones included, is read-authorized before any row is read.
  function assertExpandReadable(c, mapping, items) {
    for (const item of items) {
      if (navigationOf(mapping, item.navigation))
        assertExpandReadable(c, readableTarget(c, mapping, item.navigation), item.expand ?? []);
    }
  }
  // $filter, $orderby and $expand roots must name a property (or a navigation); unknown ones are 0x0. $expand is then
  // validated by assertExpand and its tables authorized. Navigation $filter and $orderby tables are authorized too.
  function assertQueryMembers(c, mapping, params) {
    const aliases = Object.fromEntries([...params].filter(([name]) => name.startsWith('@')));
    const filter = params.get('$filter');
    if (filter) {
      const expression = parseODataExpression(filter, {
        dialect: 'dataverse',
        aliases,
        rejectNotOnQueryFunctions: true,
        strictEdm: true,
        columnDefinition: (name) => readDefinition(mapping, name),
        nativeSyntax: Boolean(c.dataverseHttpReader),
      });
      for (const [head] of expressionPaths(expression)) {
        if (!head || head.startsWith('@')) continue;
        if (navigationOf(mapping, head)) readableTarget(c, mapping, head);
        else assertProperty(mapping, head);
      }
    }
    for (const spec of parseOrderBy(params.get('$orderby'), { nativeSyntax: Boolean(c.dataverseHttpReader) })) {
      const head = spec.path[0];
      if (navigationOf(mapping, head)) readableTarget(c, mapping, head);
      else assertProperty(mapping, head);
    }
    assertExpandText(params.get('$expand'));
    const items = parseExpand(params.get('$expand'));
    for (const item of items) {
      if (!navigationOf(mapping, item.navigation)) assertProperty(mapping, item.navigation);
    }
    assertExpand(items, mapping, relationshipOf);
    assertExpandReadable(c, mapping, items);
    if (security())
      assertUnmaskedQuery(c, mapping, { filter, orderby: params.get('$orderby'), expand: items }, aliases);
  }

  // Formats one row, adds the owner navigation annotation the formatter leaves out and shapes money columns.
  function formatRow(c, mapping, row, options) {
    const formatted = c.formatter.formatEntity(row, mapping, options);
    // The stored base currency (currencyOnWrite) answers as the _transactioncurrencyid_value lookup, never as a raw column (the currency table's own key excepted).
    if (mapping.idColumn !== 'transactioncurrencyid') delete formatted.transactioncurrencyid;
    // A selected currency lookup the row does not carry projects as null; shapeMoney supplies the base currency instead.
    if (
      formatted[CURRENCY] === null &&
      !(metadata?.recordFields && parseSelect(c.url.searchParams.get('$select'))?.includes(CURRENCY))
    )
      delete formatted[CURRENCY];
    for (const field of OWNER_FIELDS) {
      const key = `_${field}_value`;
      if (formatted[key] != null && formatted[`${key}${NAVIGATION}`] === undefined)
        formatted[`${key}${NAVIGATION}`] = field;
    }
    // The user-owner lookup carries its logical name only, no FormattedValue or navigation.
    delete formatted[`_owninguser_value${FORMATTED}`];
    delete formatted[`_owninguser_value${NAVIGATION}`];
    // Organization-owned rows always answer the organization lookup, selected or not.
    const organizationId = organizationRecord(store)?.organizationid;
    const selected = parseSelect(c.url.searchParams.get('$select'));
    if (
      organizationId &&
      (!c.navigation || selected == null || selected.includes('_organizationid_value')) &&
      formatted._organizationid_value === undefined &&
      ownershipOf(mapping.logicalName, undefined, mapping) === 'org'
    ) {
      formatted._organizationid_value = organizationId;
    }
    // A picklist value with no option still answers its FormattedValue, as null (a value of -1, for example).
    for (const key of Object.keys(formatted)) {
      if (key.includes('@') || formatted[key] == null) continue;
      if (fieldKind(readDefinition(mapping, key)) === 'choice' && formatted[`${key}${FORMATTED}`] === undefined) {
        formatted[`${key}${FORMATTED}`] = null;
      }
    }
    const named = options?.single === true && moneyNamed(c, mapping);
    // The base currency lookup is answered only for a row that holds one (currencyOnWrite). A selected lookup the row does not hold is null.
    const held = currencyHeld(c, mapping, row[mapping.idColumn]);
    shapeMoney(mapping, formatted, { currencyWanted: held && (currencySelected(c) || named), named });
    selectedSystemValues(c, mapping, row, formatted);
    if (
      !held &&
      formatted[CURRENCY] === undefined &&
      currencySelected(c) &&
      Object.keys(formatted).some((key) => !key.includes('@') && isMoney(mapping, key))
    )
      formatted[CURRENCY] = null;
    if (options?.allColumns) fillColumns(c, mapping, formatted);
    if (options?.expand?.length)
      pageExpansions(c, mapping, row, formatted, options.expand, { collection: options.single !== true });
    projectRow(c, mapping, formatted, options?.expand, options?.single === true);
    return formatted;
  }

  function selectedSystemValues(c, mapping, projected, formatted) {
    if (!metadata?.recordFields) return;
    const selected = parseSelect(c.url.searchParams.get('$select'));
    if (!selected) return;
    const definitions = readFieldsOf(mapping.logicalName);
    const source = store
      .tableRows(mapping.logicalName)
      .find(
        (row) =>
          sameId(row[mapping.idColumn], projected[mapping.idColumn]) &&
          (!isElastic(mapping) || samePartition(row.partitionid, c.partitionId)),
      );
    if (!source) return;
    const readable = (name) => security()?.canRead(c.user, mapping.logicalName, name) !== false;
    // The same observed stamp that an unselected full row receives must survive selecting the stamp alone.
    if (
      selected.includes('timezoneruleversionnumber') &&
      formatted.timezoneruleversionnumber == null &&
      columnNamesOf(mapping).dateColumns.some((name) => source[name] != null && readable(name))
    ) {
      formatted.timezoneruleversionnumber = 4;
      formatted[`timezoneruleversionnumber${FORMATTED}`] = formattedValue(
        4,
        { dataverseType: 'int' },
        store.state.settings,
      );
    }
    const base = baseCurrency();
    const currency = source.transactioncurrencyid?.id ?? source.transactioncurrencyid;
    if (!base || !sameId(currency, base.transactioncurrencyid)) return;
    // The existing base-currency projection uses rate 1. Do not infer a rate or converted amount for another currency.
    if (selected.includes('exchangerate') && formatted.exchangerate == null) {
      formatted.exchangerate = 1;
      formatted[`exchangerate${FORMATTED}`] = '1.000000000000';
    }
    for (const name of selected) {
      if (!name.endsWith('_base') || formatted[name] != null || fieldKind(definitions[name]) !== 'money') continue;
      const amount = name.slice(0, -5);
      if (source[amount] == null || !readable(amount) || !readable(name)) continue;
      formatted[name] = fixedScaleNumeric(source[amount], MONEY_SCALE);
      formatted[`${name}${FORMATTED}`] = formattedValue(source[amount], definitions[name], store.state.settings);
    }
  }

  // A read with no $select list (or $select=*) answers every column of the table, unset ones as null (lookups as _x_value).
  // Columns come from the table's metadata and system fields; a $select list is projected by the store and left alone.
  function fillColumns(c, mapping, formatted) {
    if (parseSelect(c.url.searchParams.get('$select')) != null) return;
    const { names, moneys, dateColumns } = columnNamesOf(mapping);
    // A row that carries the base currency (shapeMoney) has exchange rate 1: the base currency's own rate is 1, so a money value is its base amount.
    if (formatted[CURRENCY] != null) {
      formatted.exchangerate = 1;
      // The rate's FormattedValue is 1 at its 12-place scale; a base companion formats like its money column.
      formatted[`exchangerate${FORMATTED}`] = '1.000000000000';
      for (const name of moneys) {
        if (formatted[name] == null) continue;
        formatted[`${name}_base`] = formatted[name];
        if (formatted[`${name}${FORMATTED}`] !== undefined)
          formatted[`${name}_base${FORMATTED}`] = formatted[`${name}${FORMATTED}`];
      }
    }
    stampSystemValues(mapping, formatted, dateColumns);
    for (const name of names) if (!(name in formatted)) formatted[name] = null;
  }

  // Every column name a read of the table answers (system columns, lookups as _x_value, money companions, file parts), with money and date columns that imply a time-zone rule stamp.
  function columnNamesOf(mapping) {
    const names = [mapping.idColumn, ...(metadata?.recordFields ? [] : TABLE_COLUMNS)];
    const moneys = [];
    const dateColumns = [];
    // Readable system companions include audit timestamps. Their mere presence must not infer a time-zone
    // stamp: retain the original, source-declared date candidates used before implicit read admission.
    const sourceDates = store.fieldDefinitions(mapping.logicalName, fieldsOf);
    for (const [name, definition] of Object.entries(
      metadata?.recordFields
        ? readFieldsOf(mapping.logicalName)
        : store.fieldDefinitions(mapping.logicalName, fieldsOf),
    )) {
      const kind = fieldKind(definition);
      if (kind === 'virtual' || kind === 'partylist') continue;
      const sourceDate = sourceDates[name];
      if (
        fieldKind(sourceDate) === 'datetime' &&
        ((dateTimeBehavior(sourceDate) || 'userlocal') === 'userlocal' || isDateOnlyField(sourceDate))
      )
        dateColumns.push(name);
      if (kind === 'lookup') names.push(`_${name}_value`);
      else names.push(name);
      // A money column has a base-currency companion; the companion is money-typed and has no companion of its own.
      if (kind === 'money' && !name.endsWith('_base')) {
        moneys.push(name);
        names.push(`${name}_base`);
      }
      if (kind === 'file') {
        const image = String(definition.dataverseType ?? definition.type ?? '').toLowerCase() === 'image';
        names.push(...(image ? [`${name}id`, `${name}_url`, `${name}_timestamp`] : [`${name}_name`]));
      }
    }
    if (moneys.length) names.push(CURRENCY, 'exchangerate');
    return {
      names: isElastic(mapping) ? names.filter((name) => name !== 'statecode' && name !== 'statuscode') : names,
      moneys,
      dateColumns,
    };
  }

  // Native rows always carry their state, version and time-zone stamps, stored or not. statecode and statuscode come from
  // the mapping's defaults on tables with a state or status column; versionnumber is the number of the row's ETag, so
  // W/"n" and versionnumber agree. A non-null UserLocal or DateOnly value implies timezoneruleversionnumber 4,
  // including a DateOnly-only row and a row whose UserLocal value was cleared while its DateOnly value remains.
  function stampSystemValues(mapping, formatted, dateColumns) {
    const declared = metadata?.recordFields ? readFieldsOf(mapping.logicalName) : null;
    if (hasStateColumns(mapping) && (!declared || declared.statecode || declared.statuscode)) {
      if (formatted.statecode == null) formatted.statecode = mapping.recordDefaults?.statecode ?? 0;
      const status =
        mapping.stateStatusDefaults?.[formatted.statecode] ??
        mapping.recordDefaults?.statuscode ??
        (Number(formatted.statecode) === 0 ? 1 : undefined);
      if (formatted.statuscode == null && status !== undefined) formatted.statuscode = status;
    }
    const etagNumber = /^W\/"(\d+)"$/.exec(formatted['@odata.etag'] ?? '');
    if ((!declared || declared.versionnumber) && formatted.versionnumber == null && etagNumber)
      formatted.versionnumber = Number(etagNumber[1]);
    if (
      (!declared || declared.timezoneruleversionnumber) &&
      formatted.timezoneruleversionnumber == null &&
      dateColumns.some((name) => formatted[name] != null)
    )
      formatted.timezoneruleversionnumber = 4;
    if (typeof formatted.timezoneruleversionnumber === 'number')
      formatted[`timezoneruleversionnumber${FORMATTED}`] ??= formattedValue(
        formatted.timezoneruleversionnumber,
        { dataverseType: 'int' },
        store.state.settings,
      );
  }

  // An expanded collection holds at most PAGE_CAP rows; its nav@odata.nextLink pages on through the navigation (nested paging).
  // A collection query links every expanded collection (short or empty too); a child row carries its parent's lookup; a
  // child with no $select carries every column; a single-valued expansion carries its etag.
  function pageExpansions(c, mapping, row, formatted, expand, { collection = true } = {}) {
    for (const item of expand) {
      const rel = navigationOf(mapping, item.navigation);
      const value = formatted[item.navigation];
      if (!rel || value == null) continue;
      if (!Array.isArray(value)) {
        const target = store.resolveMapping(rel.entity);
        const stored = value[target.idColumn] == null ? null : rowOf(c, target, value[target.idColumn]);
        if (stored) value['@odata.etag'] = store.etag(stored);
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
        pageNumber: 2,
        firstId: kept[0][target.idColumn],
        lastId: kept.at(-1)[target.idColumn],
        idColumn: target.idColumn,
        countOfRecords: rows.length,
      };
      value.length = PAGE_CAP;
      const link = childLinks(c.origin, c.version, mapping.entitySet, row[mapping.idColumn], item.navigation, item, {
        nested: true,
        token,
      });
      formatted[link.key] = link.url;
    }
  }

  // One expanded child of a collection: its referencing lookup, and every column when the expansion selects none.
  function shapeChild(c, mapping, row, rel, child, item) {
    if (rel.to && rel.from && child[`_${rel.to}_value`] === undefined)
      child[`_${rel.to}_value`] = row[rel.from] ?? null;
    if (item.select) return;
    const target = store.resolveMapping(rel.entity);
    for (const name of columnNamesOf(target).names) if (!(name in child)) child[name] = null;
    const organizationId = organizationRecord(store)?.organizationid;
    if (
      organizationId &&
      child._organizationid_value === undefined &&
      ownershipOf(target.logicalName, undefined, target) === 'org'
    )
      child._organizationid_value = organizationId;
  }

  // The read projection: project hooks see the row, then each expanded row under it (in its own table, with its own
  // nested expansions). Computed columns already hold their computed value (store.setComputedColumns); the hooks then
  // apply column security (null) and masking rules (masked unless UnMaskedData and CanReadUnmasked allow it).
  // single is a single-record read (entity, property, $value); collections, FetchXML and $expand rows are not.
  function projectRow(c, mapping, formatted, expand = [], single = false) {
    const all = declaredFields(mapping.logicalName, true);
    if (all)
      for (const [name, field] of Object.entries(all)) {
        if ((field.dataverseMetadata?.IsValidODataAttribute ?? field.columnMetadata?.isValidODataAttribute) !== false)
          continue;
        for (const key of Object.keys(formatted)) if (key === name || key.startsWith(`${name}@`)) delete formatted[key];
      }
    runHooks('project', c, mapping, formatted, { single });
    for (const spec of expand) {
      const rel = navigationOf(mapping, spec.navigation);
      const value = formatted[spec.navigation];
      if (!rel || value == null || typeof value !== 'object') continue;
      const target = store.resolveMapping(rel.entity);
      for (const item of [].concat(value))
        if (item && typeof item === 'object') projectRow(c, target, item, spec.expand ?? []);
    }
  }

  function rowOf(c, mapping, id, partitionId = null) {
    return String(id).includes('=')
      ? (store.findByKey(mapping, id) ?? null)
      : (store.get(mapping.logicalName, id, c.identity, { partitionId, skipPluginRead: true }) ?? null);
  }

  // Resolves the addressed row by primary key or alternate key; row is null when absent.
  function lookupKey(c, mapping, text) {
    const parsed = parseKey(text);
    if (!parsed) throw keySyntaxError(text) ?? invalid('Invalid argument.');
    if (parsed.id)
      return {
        id: parsed.id,
        text: parsed.id,
        row: rowOf(c, mapping, parsed.id, isElastic(mapping) ? c.partitionId : null),
        alternate: null,
      };
    let row;
    try {
      row = store.findByKey(mapping, text) ?? null;
    } catch (error) {
      // The store refuses an alternate-key name the entity does not declare; native words that as the key rule (400 0x80060888).
      if (error?.code === 'InvalidKey' && error.details?.innerCode === '0x80040203') throw keyNotDeclared(mapping);
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
      throw new DataError('Prefer Odata.maxpagesize value should be 32 bit integer.', 405, 'InvalidRequest', {
        innerCode: '0x80060888',
        httpStatus: 405,
        route: true,
      });
    }
    if (url.searchParams.getAll('$top').length > 1) {
      throw new DataError(
        "Query option '$top' was specified more than once, but it must be specified at most once.",
        400,
        'InvalidRequest',
        { innerCode: '0x80060888', route: true },
      );
    }
    const top = url.searchParams.get('$top');
    parseDataverseTop(top);
    const count = url.searchParams.get('$count');
    if (count != null && count !== 'true' && count !== 'false')
      throw invalid(`'${count}' is not a valid count option.`, '0x80060888');
    const filter = url.searchParams.get('$filter');
    if (filter != null && filter.trim() === '')
      throw invalid("The value for OData query '$filter' cannot be empty.", '0x80060888');
  }

  // Query options for collections: $top yields to maxpagesize, $skiptoken is handled here, the id always rides along.
  function collectionParams(c, mapping) {
    const params = new URLSearchParams(c.url.searchParams);
    params.delete('tag');
    params.delete('$skiptoken');
    params.delete('$deltatoken');
    if (c.prefer.maxPageSize != null) params.delete('$top');
    assertSelect(mapping, params.get('$select'));
    assertQueryMembers(c, mapping, params);
    const select = withIdSelect(params.get('$select'), mapping.idColumn);
    if (select != null) params.set('$select', select);
    return params;
  }

  // Dataverse answers 400 0x80060888 for an unknown $select column; the store would project an empty row instead.
  // $select=* names every column and is checked as such.
  function assertSelect(mapping, text) {
    if (!text) return;
    for (const name of text
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part && part !== '*'))
      assertProperty(mapping, name);
  }

  // Single rows only project $select and $expand (and aliases); filters never apply to a key read.
  function entityParams(c, mapping) {
    const params = new URLSearchParams();
    for (const [name, value] of c.url.searchParams) {
      if (name === '$expand' || name === '$select' || name.startsWith('@')) params.append(name, value);
    }
    assertSelect(mapping, params.get('$select'));
    assertQueryMembers(c, mapping, params);
    const select = withIdSelect(params.get('$select'), mapping.idColumn);
    if (select != null) params.set('$select', select);
    return params;
  }

  // allColumns: a read with no $select answers every column, and so does a write representation (unset ones as null); a $select list is projected as given.
  function entityBody(c, mapping, id, params, { allColumns = false } = {}) {
    return projectPage(() => entityProjectedBody(c, mapping, id, params, { allColumns }));
  }

  function entityProjectedBody(c, mapping, id, params, { allColumns }) {
    const options = secured(c, { id, ...(isElastic(mapping) ? { partitionId: c.partitionId ?? null } : {}) });
    const runRetrieve =
      c.method === 'GET' &&
      store.pluginPipeline &&
      store.pluginPipelineActive({
        entity: mapping.logicalName,
        operation: 'retrieve',
        bypassCustomPlugins: c.bypassCustomPlugins === true,
        bypassStepIds: c.bypassStepIds,
      });
    const projected = runRetrieve
      ? store.get(mapping.logicalName, id, c.identity, {
          ...options,
          skipPluginRead: c.method !== 'GET',
          sdkColumns: c.sdkColumns ?? {
            allColumns:
              !params.get('$select') ||
              params
                .get('$select')
                .split(',')
                .some((column) => column.trim() === '*'),
            // The ColumnSet names the caller's columns; the projection's own primary key is not one of them.
            columns: (parseSelect(params.get('$select')) ?? []).filter(
              (column) =>
                column !== mapping.idColumn ||
                (parseSelect(c.url?.searchParams?.get('$select')) ?? []).includes(column),
            ),
          },
          ...(c.sdkColumns ? {} : { readInitialFrame: webApiReadFrame(c, false) }),
          sdkTarget: c.sdkTarget,
          ...(c.sdkTarget
            ? {
                resolveTarget: (target) => {
                  if (String(target.id).toLowerCase() !== String(c.sdkTarget.id).toLowerCase()) return target.id;
                  if (!isDeepStrictEqual(target.keyAttributes ?? {}, c.sdkTarget.keyAttributes ?? {}))
                    throw new DataError(
                      'Changing an alternate-key Retrieve binding requires a qualified SDK adapter.',
                      501,
                      'LocalPluginQueryUnsupported',
                    );
                  return id;
                },
              }
            : {}),
          preserveProperties: parseExpand(params.get('$expand')).map((item) => item.navigation),
          project: (_row, key, columns) => {
            const selected = new URLSearchParams(params);
            if (columns?.allColumns) selected.delete('$select');
            else if (columns?.columns)
              selected.set('$select', withIdSelect(columns.columns.join(','), mapping.idColumn));
            return store.queryCore(mapping.logicalName, selected, c.identity, undefined, { ...options, id: key })
              .value[0];
          },
        })
      : store.queryCore(mapping.logicalName, params, c.identity, undefined, options).value[0];
    if (!projected) throw notFoundRecord(mapping.logicalName, id);
    const formatted = formatRow(c, mapping, projected, {
      etag: true,
      expand: parseExpand(params.get('$expand')),
      allColumns,
      single: true,
    });
    return {
      '@odata.context': contextFor(c, `${suffixFor(c, mapping)}/$entity`),
      ...keepAnnotations(formatted, c.include),
    };
  }

  const collectionBase = (c, mapping) => `${c.origin}/api/data/${c.version}/${mapping.entitySet}`;
  const tracking = (c) => c.prefer.trackChanges || c.url.searchParams.has('$deltatoken');

  // Change tracking refuses the query options Dataverse refuses; the message is the documented one.
  function assertTrackable(c) {
    for (const name of TRACKING_REJECTS) {
      if (c.url.searchParams.has(name))
        throw invalid(`The "${name}" query parameter isn't supported when Change Tracking is enabled.`, '0x80060888');
    }
  }

  // The changes after a $deltatoken's revision; the token is parsed by the change log and never inspected here.
  async function deltaChanges(c, mapping) {
    const token = changes.parse(c.url.searchParams.get('$deltatoken'));
    if (!token) throw invalid('The $deltatoken is not valid.', '0x80060888');
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
    const body = addMetadataVersion(c, { '@odata.context': contextFor(c, `${suffixFor(c, mapping)}/$delta`) });
    body.value = [
      ...rows.map((row) => keepAnnotations(formatRow(c, mapping, row, { etag: true, expand: [] }), c.include)),
      ...deleted.map((id) => ({
        '@odata.context': contextFor(c, `${mapping.entitySet}/$deletedEntity`),
        id,
        reason: 'deleted',
      })),
    ];
    body['@odata.deltaLink'] = deltaLinkOf(c, collectionBase(c, mapping), next);
    // A delta is one page, so maxpagesize is not applied and not echoed.
    const applied = preferenceApplied(c.prefer, { tracked: true });
    return { status: 200, headers: applied ? { 'Preference-Applied': applied } : {}, body };
  }

  // Column-level security (api.fieldSecurity). A column the caller cannot read is nulled in the store's query context
  // (rowsOptionsOf), so every $filter, $orderby, $apply step, lambda and $expand option evaluates it as null: a right and a
  // wrong guess answer alike. How native evaluates such a filter is undocumented; this is a guess.
  // A readable secured column with a masking rule the read does not unmask (a collection read: UnMaskedData with
  // CanReadUnmasked All Records unmasks) is never a filter, order or aggregate operand at any path depth:
  // 0x80041155 CannotFilterOnMaskedAttribute. One rule: api.fieldSecurity.maskedFor.
  const security = () => fieldSecurity?.();
  // The table and column a property path ends on, through its navigation segments (lambda paths come qualified from the root).
  const columnOf = (logical, segments) => {
    let mapping = store.resolveMapping(logical);
    for (const segment of segments.slice(0, -1)) {
      const rel = navigationOf(mapping, segment);
      if (!rel) return null;
      mapping = store.resolveMapping(rel.entity);
    }
    return { logical: mapping.logicalName, column: String(segments.at(-1) ?? '').replace(/^_(.+)_value$/, '$1') };
  };
  const maskedPath = (c, logical, segments) => {
    const target = columnOf(logical, segments);
    return Boolean(
      target &&
      security()?.maskedFor?.(c.user, target.logical, target.column, { unmask: c.unmasked === true, single: false }),
    );
  };
  const maskedIn = (c, logical, ast) => expressionPaths(ast).some((path) => maskedPath(c, logical, path));
  // Only filtering is documented; an order on a masked column is refused the same way (it is the same oracle).
  const assertUnmasked = (c, logical, paths) => {
    if (paths.some((path) => maskedPath(c, logical, path))) throw maskedOperand();
  };
  const orderPaths = (orderby) =>
    orderby ? splitTopLevel(orderby).map((item) => item.trim().split(/\s+/)[0].split('/')) : [];
  const aliasesOf = (params) => Object.fromEntries([...params].filter(([name]) => name.startsWith('@')));
  // A query's $filter and $orderby on mapping, then each $expand option on its target table, at every depth.
  function assertUnmaskedQuery(c, mapping, { filter, orderby, expand = [] }, aliases) {
    if (
      filter &&
      maskedIn(
        c,
        mapping.logicalName,
        parseODataExpression(filter, { dialect: 'dataverse', aliases, rejectNotOnQueryFunctions: true }),
      )
    )
      throw maskedOperand();
    assertUnmasked(c, mapping.logicalName, orderPaths(orderby));
    for (const item of expand) {
      const rel = navigationOf(mapping, item.navigation);
      if (rel) assertUnmaskedQuery(c, store.resolveMapping(rel.entity), item, aliases);
    }
  }
  // $apply: a filter step on a masked path is refused; every groupby and aggregate path is resolved to its table and column
  // and checked by assertAggregate (hidden 403, masked 400).
  function assertApply(c, mapping, params) {
    if (!security()) return;
    const logical = mapping.logicalName;
    const steps = parseApply(params.get('$apply'), { dialect: 'dataverse', aliases: aliasesOf(params) });
    const reads = steps.flatMap((step) => [
      ...(step.properties ?? []).map((path) => ({ path, method: 'groupby' })),
      ...(step.aggregates ?? []).filter((item) => item.path).map((item) => ({ path: item.path, method: item.method })),
    ]);
    security().assertAggregate(
      c,
      mapping,
      reads.flatMap(({ path, method }) => {
        const target = columnOf(logical, path);
        return target ? [{ ...target, method }] : [];
      }),
    );
    for (const step of steps) if (step.kind === 'filter' && maskedIn(c, logical, step.ast)) throw maskedOperand();
  }
  // The entity and link-entity elements of a FetchXML document, each with the attributes it reads ({ column, method }: the
  // aggregate, "groupby" or none) and the attribute names its conditions (attribute and valueof) and orders compare
  // (operands; a condition's entityname moves it to that alias's frame). all: the frame has <all-attributes/>. Read from the
  // same decoded document the engine runs (parseFetchXml), so character references and entities name the same column here.
  function fetchFrames(xml) {
    const fetch = parseFetchXml(xml);
    const frames = [],
      named = [];
    const truthy = (value) => /^(?:true|1)$/i.test(String(value ?? '').trim());
    const visit = (node, frame) => {
      for (const child of node.children ?? []) {
        if (child.name === 'entity' || child.name === 'link-entity') {
          const next = { entity: child.attrs.name, alias: child.attrs.alias, attributes: [], operands: [], all: false };
          frames.push(next);
          visit(child, next);
        } else if (child.name === 'all-attributes') {
          if (frame) frame.all = true;
        } else if (child.name === 'attribute') {
          if (frame && child.attrs.name)
            frame.attributes.push({
              column: child.attrs.name,
              method: truthy(child.attrs.groupby) ? 'groupby' : child.attrs.aggregate?.toLowerCase(),
            });
        } else {
          if (child.name === 'condition' || child.name === 'order') {
            for (const key of ['attribute', 'valueof'])
              if (child.attrs[key])
                named.push({ frame, entityname: child.attrs.entityname, attribute: child.attrs[key] });
          }
          visit(child, frame);
        }
      }
    };
    visit(fetch, null);
    for (const { frame, entityname, attribute } of named) {
      const owner = entityname
        ? (frames.find((item) => item.alias === entityname) ?? frames.find((item) => item.entity === entityname))
        : frame;
      owner?.operands.push(attribute);
    }
    return {
      aggregate: truthy(fetch.attrs.aggregate),
      distinct: truthy(fetch.attrs.distinct),
      frames: frames.filter((frame) => frame.entity),
    };
  }
  // A FetchXML document's column-security operand rule, for the Web API and SDK reads alike. Aggregates read raw columns: a
  // hidden secured one is refused (403) and a masked one too (400 0x80041155), on the root or any link-entity, as $apply is.
  // A condition or order on a masked column is refused, as $filter and $orderby are, and so is distinct="true" over one (it
  // groups on the clear value, the same equality oracle as groupby). Hidden columns in conditions and orders read null.
  function assertFetchOperands(c, xml) {
    if (!security()) return;
    const { aggregate, distinct, frames } = fetchFrames(xml);
    for (const frame of frames) {
      const target = store.resolveMapping(frame.entity);
      if (aggregate)
        security().assertAggregate(
          c,
          target,
          frame.attributes.map((item) => ({ logical: target.logicalName, ...item })),
        );
      else if (distinct)
        assertUnmasked(
          c,
          target.logicalName,
          (frame.all ? Object.keys(readFieldsOf(target.logicalName)) : frame.attributes.map((item) => item.column)).map(
            (name) => [name],
          ),
        );
      assertUnmasked(
        c,
        target.logicalName,
        frame.operands.map((name) => [name]),
      );
    }
  }
  /**
   * SDK reads (local organization service): the Web API column-security rules for a FetchXML text or OData params read
   * outside the handlers. Throws for a masked operand (400 0x80041155) or a hidden aggregate (403); returns the store
   * options that null the columns the caller cannot read ({ backendRowsMask } or {}).
   */
  function secureInternal(c, logical, { fetchXml = null, params = null, unmask = false } = {}) {
    const fs = security();
    if (!fs) return {};
    const context = { ...internalContext(c), unmasked: unmask === true };
    if (fetchXml != null) assertFetchOperands(context, fetchXml);
    else {
      const p = new URLSearchParams(
        params instanceof URLSearchParams
          ? params
          : Object.entries(params ?? {})
              .filter(([, value]) => value != null)
              .map(([key, value]) => [key, String(value)]),
      );
      const mapping = store.resolveMapping(logical);
      assertUnmaskedQuery(
        context,
        mapping,
        { filter: p.get('$filter'), orderby: p.get('$orderby'), expand: parseExpand(p.get('$expand')) },
        aliasesOf(p),
      );
      if (p.has('$apply')) assertApply(context, mapping, p);
    }
    return context.user && fs.rowMask ? { backendRowsMask: (name) => fs.rowMask(context.user, name) } : {};
  }
  // Formatted FetchXML row: hidden secured columns are nulled on the root and on each link-entity under its alias prefix.
  // An attribute given its own alias keeps that key, which the prefix does not reach, so it is nulled by key.
  function maskFetched(c, mapping, row, info) {
    const fs = security();
    if (!fs) return row;
    // A FetchXML result is a multiple-record read: masking rules apply unless UnMaskedData and CanReadUnmasked All Records.
    const view = { unmask: c.unmasked === true, single: false };
    let out = fs.mask(c.user, mapping.logicalName, row, { view });
    for (const [alias, logical] of Object.entries(info.aliases ?? {}))
      out = fs.mask(c.user, logical, out, { prefix: `${alias}.`, view });
    for (const column of info.columns ?? []) {
      if (!column.aliased || column.aggregate != null || out[column.key] == null) continue;
      const value = fs.maskValue(c.user, column.entity, column.attribute, out[column.key], view);
      if (value === out[column.key]) continue;
      out[column.key] = value;
      for (const key of Object.keys(out)) if (key.startsWith(`${column.key}@`)) delete out[key];
    }
    return out;
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
    const params = collectionParams(c, mapping);
    // A tracked page without $orderby answers in row-version (creation/update) order.
    // The sort is internal: links and context are built from the caller's url, so the order is not echoed.
    if (tracked && !params.has('$orderby')) params.set('$orderby', 'versionnumber asc');
    // The cookie's last order-column values and row id let the store resume after that tuple instead of re-counting the
    // offset (key-set paging), so a cursor row deleted or updated out of the filter since skips nothing.
    // Only this function's own cookies name the last row of the page in this order; an expansion's nested cookie
    // (pageExpansions, which carries countOfRecords) names a row of the unsorted related set and keeps the offset.
    const cookie = offset > 0 ? decodeSkipToken(url.searchParams.get('$skiptoken')) : null;
    const after =
      cookie && cookie.countOfRecords === undefined ? { id: cookie.lastId, values: cookie.orderValues ?? {} } : null;
    const paging = { params, offset, pageSize, after, preferenceApplied: null, nextLink: () => null };
    const options = secured(c, { ...(ids ? { ids } : {}), readInitialFrame: webApiReadFrame(c, true) });
    // The filter resolves field definitions per row; they are derived once for the whole synchronous query.
    const result =
      ids?.length === 0
        ? emptyPage()
        : projectPage(() => store.query(mapping.logicalName, params, c.identity, paging, options));
    const rows = result.value;
    const total = result.paging?.totalCount ?? rows.length;
    const counted = url.searchParams.get('$count') === 'true';
    const body = { '@odata.context': contextFor(c, suffixFor(c, mapping)) };
    if (counted) body['@odata.count'] = Math.min(total, pageCap);
    addMetadataVersion(c, body);
    if (c.include?.(RECORD_COUNT)) body[`@${RECORD_COUNT}`] = counted ? Math.min(total, pageCap) : -1;
    if (c.include?.(RECORD_LIMIT)) body[`@${RECORD_LIMIT}`] = counted ? total > pageCap : false;
    const expand = parseExpand(url.searchParams.get('$expand'));
    body.value = projectPage(() =>
      rows.map((row) =>
        keepAnnotations(formatRow(c, mapping, row, { etag: true, expand, allColumns: true }), c.include),
      ),
    );
    if (result.paging?.moreRecords) {
      const idColumn = mapping.idColumn;
      const cookie = encodeSkipToken({
        pageNumber: offset / pageSize + 2,
        lastId: rows.at(-1)[idColumn],
        firstId: rows[0][idColumn],
        idColumn,
        // A secured column's values never travel in the cookie (they may be hidden or masked for the caller); such a
        // page resumes after the cursor row by id instead.
        orderColumns: (result.paging.order ?? []).filter(
          (column) => !isSecuredField(readDefinition(mapping, column.name.replace(/^_(.+)_value$/, '$1'))),
        ),
      });
      // An extra attribute on the cookie carries the delta token; decodeSkipToken reads the paging attributes around it.
      const token = tracked ? cookie.replace(' />', ` deltatoken="${delta}" />`) : cookie;
      const base = nextBase ?? collectionBase(c, mapping);
      body['@odata.nextLink'] = nextLinkOf(c, base, token);
    } else if (tracked) body['@odata.deltaLink'] = deltaLinkOf(c, collectionBase(c, mapping), delta);
    const applied = preferenceApplied(prefer, { paged: true, tracked });
    return { status: 200, headers: applied ? { 'Preference-Applied': applied } : {}, body };
  }

  // An aggregate alias (a number with no field definition) gets a formatted value in the organization number format, as FetchXML aggregates do.
  function aggregateValues(mapping, row, formatted) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'number' || key.includes('@') || readDefinition(mapping, key)) continue;
      formatted[`${key}${FORMATTED}`] = formattedValue(
        value,
        { dataverseType: Number.isInteger(value) ? 'int' : 'decimal' },
        store.state.settings,
      );
    }
    return formatted;
  }

  function applyPage(c, mapping) {
    assertQueryMembers(c, mapping, c.url.searchParams);
    assertApply(c, mapping, c.url.searchParams);
    const params = new URLSearchParams(c.url.searchParams);
    params.delete('tag');
    const result = store.query(mapping.logicalName, params, c.identity, undefined, secured(c));
    const value = result.value.map((row) =>
      keepAnnotations(aggregateValues(mapping, row, formatRow(c, mapping, row, { etag: false })), c.include),
    );
    const body = {
      '@odata.context': contextFor(c, mapping.entitySet),
      ...(result['@odata.count'] !== undefined ? { '@odata.count': result['@odata.count'] } : {}),
    };
    return { status: 200, body: { ...addMetadataVersion(c, body), value } };
  }

  function fetchXmlPage(c, mapping, xml, { order = 'sorted' } = {}) {
    return projectPage(() => fetchXmlProjectedPage(c, mapping, xml, { order }));
  }

  function fetchXmlProjectedPage(c, mapping, xml, { order = 'sorted' } = {}) {
    if (isElastic(mapping) && /<link-entity\b/i.test(xml))
      throw invalid('Link entities are not supported', '0x80048d0b');
    const logical = mapping.logicalName;
    // Well-formedness first: malformed XML answers before any entity is read.
    try {
      parseXmlDocument(xml);
    } catch (cause) {
      if (cause.code === 'InvalidRequest') throw invalid('Invalid XML.', '0x80040201');
      throw cause;
    }
    const root = /<entity\b[^>]*?\bname\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1];
    if (root == null) throw invalid('Entity Name was not specified in FetchXml String.', '0x80041102');
    if (root !== logical) {
      throw invalid(
        `The entity set name '${mapping.entitySet}' does not match the FetchXml entity '${root}'.`,
        '0x80060888',
      );
    }
    // Every link-entity table is read-authorized up front, so an empty linked table still answers 403; rows are trimmed by rowsFilterOf.
    for (const [, linked] of xml.matchAll(/<link-entity\b[^>]*?\bname\s*=\s*["']([^"']+)["']/gi)) {
      authorize(c, linked, 'read', store.resolveMapping(linked));
    }
    assertFetchOperands(c, xml);
    const fetched = store.fetchXml(xml, c.identity, { metadata: readFieldsOf, ...rowsOptionsOf(c) });
    const info = fetched.columns;
    const columns = (info.columns ?? [])
      .filter((col) => col.alias == null && !col.aliased && !col.aggregate)
      .map((col) => col.attribute);
    if (!info.aggregate && !info.distinct && !columns.includes(mapping.idColumn)) columns.push(mapping.idColumn);
    // FetchXML lists the columns alphabetically with the id, not in attribute order; an aggregate has no column list.
    // A saved query's columns keep the saved attribute order; the id stays last when it is not listed.
    const ordered = order === 'attribute' ? columns : [...columns].sort();
    const listed = columns.length ? `(${ordered.join(',')})` : '';
    const body = { '@odata.context': contextFor(c, `${mapping.entitySet}${listed}`) };
    // returntotalrecordcount="true" answers the count (capped like $count) and, when included, the total and its limit flag.
    const counted =
      /<fetch\b[^>]*?\breturntotalrecordcount\s*=\s*["']true["']/i.test(xml) && fetched.total_record_count >= 0;
    if (counted) body['@odata.count'] = Math.min(fetched.total_record_count, PAGE_CAP);
    addMetadataVersion(c, body);
    if (counted && c.include?.(RECORD_COUNT)) body[`@${RECORD_COUNT}`] = fetched.total_record_count;
    if (counted && c.include?.(RECORD_LIMIT))
      body[`@${RECORD_LIMIT}`] = Boolean(fetched.total_record_count_limit_exceeded);
    body.value = fetched.entities.map((row) =>
      withoutNulls(
        keepAnnotations(
          shapeMoney(mapping, maskFetched(c, mapping, c.formatter.formatFetchRow(row, info), info)),
          c.include,
        ),
      ),
    );
    if (fetched.more_records && c.include?.(MORE_RECORDS)) body[`@${MORE_RECORDS}`] = true;
    // The paging cookie is answered without a Prefer header.
    if (fetched.more_records && fetched.paging_cookie) {
      body[`@${PAGING_COOKIE}`] = webApiPagingCookie(fetched.paging_cookie, Number(info.page ?? 1));
    }
    // Only a FetchXML with a link-entity answers its JSON type with charset=utf-8.
    const joined = /<link-entity\b/i.test(xml);
    return {
      status: 200,
      headers: joined ? { 'Content-Type': 'application/json; odata.metadata=minimal; charset=utf-8' } : undefined,
      body,
    };
  }

  // A tracked table: enabled in its metadata (when the metadata says), and read at organization level, since the delta
  // includes the ids of deleted rows. Anything less answers the privilege error Dataverse gives for a limited reader.
  function assertTableTracking(c, mapping, readFilter) {
    const logical = mapping.logicalName;
    if (trackingFlag(logical, mapping) === false) {
      throw new DataError(`Entity ${logical} isn't enabled for change tracking.`, 400, 'InvalidRequest', {
        innerCode: '0x80072491',
      });
    }
    if (readFilter !== null) {
      throw privilegeDeniedError(c.user, privilegeName('read', principals.privilegeNoun(logical)), logical);
    }
  }

  // Change tracking answers only a plain collection (or a delta of one): no FetchXml, no $apply, and the query options it refuses.
  function assertTracking(c, mapping, readFilter) {
    for (const name of ['fetchXml', 'fetchxml', '$apply']) {
      if (c.url.searchParams.has(name))
        throw invalid(`The "${name}" query parameter isn't supported when Change Tracking is enabled.`, '0x80060888');
    }
    assertTableTracking(c, mapping, readFilter);
    assertTrackable(c);
  }

  async function collection(c) {
    const { mapping, url } = c;
    if (isElastic(mapping) && url.searchParams.has('$expand'))
      throw invalid('Link entities are not supported', '0x80048d0b');
    authorize(c, mapping.logicalName, 'read', mapping);
    const readFilter = filterOf(c, mapping);
    await source(c, mapping, { single: false, id: null });
    const answer = await firstAnswer('query', c, mapping);
    if (answer !== undefined)
      return answer.fetchXml != null
        ? fetchXmlPage(c, mapping, answer.fetchXml, { order: answer.columnOrder })
        : answer;
    assertPredefinedAnswered(url);
    if (tracking(c)) {
      assertTracking(c, mapping, readFilter);
      if (url.searchParams.has('$deltatoken')) return deltaPage(c, mapping);
    }
    const xml = url.searchParams.get('fetchXml') ?? url.searchParams.get('fetchxml');
    if (xml != null) return fetchXmlPage(c, mapping, xml);
    if (url.searchParams.has('$apply')) return applyPage(c, mapping);
    return collectionPage(c, mapping, { tracked: tracking(c) });
  }

  async function countRecords(c) {
    const { mapping, url } = c;
    authorize(c, mapping.logicalName, 'read', mapping);
    await source(c, mapping, { single: false, id: null });
    if (url.searchParams.has('$deltatoken')) {
      assertTableTracking(c, mapping, filterOf(c, mapping));
      const { changed, deleted } = await deltaChanges(c, mapping);
      return { status: 200, body: String(changed.length + deleted.length) };
    }
    // /$count is an Edm.Int32, so a $filter that names a property of the collection is refused (0x80060888).
    const countFilter = url.searchParams.get('$filter');
    if (countFilter != null) {
      for (const [head] of expressionPaths(
        parseODataExpression(countFilter, { dialect: 'dataverse', rejectNotOnQueryFunctions: true }),
      )) {
        if (head && !head.startsWith('@'))
          throw invalid(`Could not find a property named '${head}' on type 'Edm.Int32'.`, '0x80060888');
      }
    }
    const params = new URLSearchParams();
    if (url.searchParams.has('$filter')) params.set('$filter', url.searchParams.get('$filter'));
    params.set('$select', mapping.idColumn);
    assertQueryMembers(c, mapping, params);
    const result = store.query(mapping.logicalName, params, c.identity, undefined, secured(c));
    return { status: 200, body: String(Math.min(result.value.length, isElastic(mapping) ? 500 : PAGE_CAP)) };
  }

  async function getEntity(c) {
    const { mapping } = c;
    await sourceKey(c, mapping);
    return projectPage(() => getEntityResult(c));
  }

  function getEntityResult(c) {
    const { mapping } = c;
    const key = lookupKey(c, mapping, c.route.key);
    if (!key.row && !key.id) throw notFoundRecord(mapping.logicalName, key.text);
    if (
      !key.row &&
      (!store.pluginPipeline ||
        !store.pluginPipelineActive({
          entity: mapping.logicalName,
          operation: 'retrieve',
          bypassCustomPlugins: c.bypassCustomPlugins === true,
          bypassStepIds: c.bypassStepIds,
        }))
    )
      throw notFoundRecord(mapping.logicalName, key.text);
    authorize(c, mapping.logicalName, 'read', mapping, key.row);
    const body = entityBody(c, mapping, key.row?.[mapping.idColumn] ?? key.id, entityParams(c, mapping), {
      allColumns: true,
    });
    const etag = body['@odata.etag'];
    const match = c.headers['if-none-match'];
    if (
      etag &&
      match &&
      !c.url.searchParams.has('$expand') &&
      c.include == null &&
      String(match)
        .split(',')
        .map((item) => item.trim())
        .includes(etag)
    ) {
      // The 304 is an empty text/html answer with no ETag and no OData-Version.
      return { status: 304, headers: { 'Content-Type': 'text/html; charset=utf-8' } };
    }
    // A record read asked for XML or text still answers JSON, streaming.
    const asOther = /application\/xml|text\/plain/i.test(String(c.headers.accept ?? ''));
    return {
      status: 200,
      headers: {
        ...etagOf(body),
        ...appliedHeader(c.prefer),
        ...(asOther ? { 'Content-Type': JSON_STREAMING_CONTENT_TYPE } : {}),
      },
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
      if (!key.includes('@') || key.endsWith(BIND)) data[key] = value;
    }
    assertPayload(mapping, data);
    return data;
  }

  // A create payload: overriddencreatedon sets createdon (UTC, ISO) and is stored under its own name; null is ignored.
  // The rejection of an unparseable date and the stored form are guesses.
  function createPayload(mapping, body) {
    const data = payload(mapping, body);
    const value = body[OVERRIDDEN];
    if (value == null) return data;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw invalid(`The value '${value}' is not a valid date-time for ${OVERRIDDEN}.`, '0x80040203');
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
      if (!rel || key.endsWith(BIND) || !value || typeof value !== 'object') continue;
      if (Object.hasOwn(value, 'id') && Object.hasOwn(value, 'logical_name')) continue;
      if (isElastic(mapping))
        throw invalid('Cannot create related entities. Create has to be called individually for each entity.');
      const target = store.resolveMapping(rel.entity);
      const children = [];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!child || typeof child !== 'object' || Array.isArray(child)) {
          children.push(child);
          continue;
        }
        authorize(c, target.logicalName, 'create', target);
        authorize(c, target.logicalName, 'append', target);
        authorize(c, mapping.logicalName, 'appendto', mapping);
        const childData = await deepPayload(c, target, createPayload(target, child));
        await beforeWrite(c, target, { operation: 'create', data: childData, existing: null, deep: true });
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
      if (nav === 'ownerid') {
        if (!isMember(mapping, nav)) throw undeclared(mapping.entitySet, nav);
        authorize(c, mapping.logicalName, 'assign', mapping, existing ?? undefined);
      }
      if (data[key] === null) continue;
      const ref = refOf(data[key]);
      const target = mappingForSet(ref.set);
      const rel = navigationOf(mapping, nav);
      const row = rowOf(c, target, ref.id, isElastic(target) ? data[`${rel?.from ?? nav}pid`] : null);
      if (!row && isElastic(target) && !ref.id.includes('=') && data[`${rel?.from ?? nav}pid`] == null) {
        authorize(c, target.logicalName, 'appendto', target);
        data[key] = `/${ref.set}(${ref.id})`;
        continue;
      }
      if (!row) throw notFoundRecord(target.logicalName, ref.id);
      authorize(c, target.logicalName, 'appendto', target, row);
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
  // Organization writes retain the rule version once a business date has been populated, including
  // TimeZoneIndependent dates. Audit timestamps do not establish this history. Seeded rows without
  // history are unchanged by reads; a later write can establish it from a currently populated date.
  function timeZoneOnWrite(mapping, input) {
    if (
      input.timezoneruleversionnumber != null ||
      isElastic(mapping) ||
      mapping.isVirtual ||
      mapping.tableType === 'Virtual'
    )
      return {};
    if (metadata?.recordFields && !metadata.recordFields(mapping.logicalName)?.timezoneruleversionnumber) return {};
    const fields = store.fieldDefinitions(mapping.logicalName, fieldsOf);
    return Object.entries(fields).some(
      ([name, definition]) =>
        !['createdon', 'modifiedon', OVERRIDDEN].includes(name) &&
        fieldKind(definition) === 'datetime' &&
        input[name] != null,
    )
      ? { timezoneruleversionnumber: 4 }
      : {};
  }
  // Audit and ownership columns are written by the store after coercion, whether or not the mapping declares them.
  // The store calls this per row it writes, so a deep-inserted child gets the columns of its own table.
  // A created or updated row takes the next org-wide row version (state.rowVersion, persisted): its versionnumber, and the ETag W/"<versionnumber>".
  // Without a user (createInternal when the organization has no SYSTEM user) no audit or ownership columns are written.
  // A portal write (internal entries, c.portal) is made by the site's application user: its observed name, as the store
  // stamps it on rows the portal creates (observed.portalApplicationUser), names createdby and modifiedby. Under enhanced
  // authorization the write runs as the visitor's mapped user (portal-authorization.mjs), whose name the columns keep.
  const portalUser = (c) =>
    c.portal && store.observed?.portalApplicationUser && !store.portalAuthorization?.principalId(c.identity)
      ? {
          id: store.observed.portalApplicationUserId ?? null,
          logical_name: 'systemuser',
          name: store.observed.portalApplicationUser,
        }
      : null;
  const systemColumns = (c, create) => (mapping, input) => ({
    ...(c.user
      ? principals.systemColumns({ user: c.user, caller: c.caller, mapping, owner: ownerOf(input), create })
      : {}),
    ...(portalUser(c) ? { ...(create ? { createdby: portalUser(c) } : {}), modifiedby: portalUser(c) } : {}),
    versionnumber: nextRowVersion(store),
    ...currencyOnWrite(mapping, input),
    ...timeZoneOnWrite(mapping, input),
    ...organizationOnCreate(mapping, create),
  });
  // An organization-owned row records its organization when created (native PreOperation Create Target: organizationid).
  function organizationOnCreate(mapping, create) {
    const organizationId = organizationRecord(store)?.organizationid;
    return create && organizationId && ownershipOf(mapping.logicalName, undefined, mapping) === 'org'
      ? { organizationid: { id: organizationId, logical_name: 'organization' } }
      : {};
  }
  // The main operation (after PreOperation, before the row is stored) runs the synchronous mainOperation hooks on the
  // final row: platform values derived from it, such as the exchange rate and base amounts (dataverse-currency.mjs).
  const mainOperation = (c) =>
    hookList('mainOperation').length
      ? (mapping, operation, row, previous, target) =>
          runHooks('mainOperation', c, mapping, { operation, row, previous, target })
      : undefined;
  const derivedCreateColumns = new WeakMap();
  const createOptions = (c, extra = {}, data) =>
    writeOptions({
      ...extra,
      mainOperation: mainOperation(c),
      pluginAcceptLanguage: c.headers?.get?.('accept-language') ?? c.headers?.['accept-language'] ?? '',
      derivedCreateColumns: derivedCreateColumns.get(data),
      afterPreValidation: phaseValidation(c, extra),
      sdkResponseToken: extra.sdkResponseToken ?? c.sdkResponseToken,
      sdkCreateId: extra.sdkCreateId ?? c.sdkCreateId,
      dataverseHttpReader: c.dataverseHttpReader,
      systemColumns: systemColumns(c, true),
      bypassCustomPlugins: c.bypassCustomPlugins === true || extra.bypassCustomPlugins === true,
      bypassCustomAsync: c.bypassCustomAsync === true || extra.bypassCustomAsync === true,
      bypassStepIds: extra.bypassStepIds ?? c.bypassStepIds,
      deferCommittedEvent: extra.deferCommittedEvent === true,
    });
  // An object extra.systemColumns (an internal writer's kept stamps, e.g. CalculateRollupField's modifiedon) lands over the stamps.
  const updateOptions = (c, extra = {}) => {
    const kept = extra.systemColumns && typeof extra.systemColumns === 'object' ? extra.systemColumns : null;
    const stamps = systemColumns(c, false);
    return writeOptions({
      partitionId: c.partitionId,
      ...extra,
      mainOperation: mainOperation(c),
      afterPreValidation: phaseValidation(c, extra),
      sdkResponseToken: extra.sdkResponseToken ?? c.sdkResponseToken,
      dataverseHttpReader: c.dataverseHttpReader,
      systemColumns: kept ? (mapping, input) => ({ ...stamps(mapping, input), ...kept }) : stamps,
      pluginConcurrencyBehavior: extra.ifMatch != null && extra.ifMatch !== '*' ? 1 : 0,
      pluginAcceptLanguage: c.headers?.get?.('accept-language') ?? c.headers?.['accept-language'] ?? '',
      bypassCustomPlugins: c.bypassCustomPlugins === true || extra.bypassCustomPlugins === true,
      bypassCustomAsync: c.bypassCustomAsync === true || extra.bypassCustomAsync === true,
      bypassStepIds: extra.bypassStepIds ?? c.bypassStepIds,
      deferCommittedEvent: extra.deferCommittedEvent === true,
    });
  };

  async function createData(c, mapping, body) {
    const data = createPayload(mapping, body);
    const logical = mapping.logicalName;
    authorize(c, logical, 'create', mapping);
    if (Object.keys(data).some((key) => key.endsWith(BIND))) authorize(c, logical, 'append', mapping);
    bindsOf(c, mapping, data, null);
    await deepPayload(c, mapping, data);
    // A new row is active (statecode 0) with the default status of that state.
    const derived = {};
    if (!('statecode' in data) && hasStateColumns(mapping)) data.statecode = derived.statecode = 0;
    if (!('statuscode' in data) && hasStateColumns(mapping)) {
      const status = defaultStatus(mapping);
      if (status !== undefined) data.statuscode = derived.statuscode = status;
    }
    derivedCreateColumns.set(data, derived);
    await beforeWrite(c, mapping, { operation: 'create', data, existing: null });
    return data;
  }

  // The state-0 status: the mapping's own default first, else the first status option whose state is 0, else 1 (Active on the probe).
  function defaultStatus(mapping) {
    const fromMapping = mapping.stateStatusDefaults?.[0];
    if (fromMapping !== undefined) return fromMapping;
    const definition = store.fieldDefinition(mapping.logicalName, 'statuscode', fieldsOf);
    return (
      (definition?.statuses ?? definition?.options ?? []).find((option) => String(option?.state) === '0')?.value ?? 1
    );
  }

  // Tables with a state and status pair: every table but an intersect table, whose solution metadata may omit the pair.
  function hasStateColumns(mapping) {
    if (isElastic(mapping)) return false;
    return (
      !mapping.intersect ||
      Boolean(
        mapping.stateStatusDefaults ||
        store.fieldDefinition(mapping.logicalName, 'statecode', fieldsOf) ||
        store.fieldDefinition(mapping.logicalName, 'statuscode', fieldsOf),
      )
    );
  }

  // addressed: the alternate key columns the URL names; an update drops body values for them (the server removes
  // the data that uses the same keys as the key attributes, so a key cannot change through the key that addresses it).
  async function updateData(c, mapping, body, existing, addressed = []) {
    const data = bindsOf(c, mapping, payload(mapping, body), existing);
    delete data[mapping.idColumn];
    for (const name of addressed) delete data[name];
    await beforeWrite(c, mapping, { operation: 'update', data, existing });
    return data;
  }

  // A bare PATCH (Upsert) first asks whether the row exists: a RetrieveMultiple pipeline under the Upsert main operation
  // (native: a QueryExpression on the URL key with no columns and TopCount 2, Query/AppModuleId/IsAppModuleContext
  // inputs). The key lookup already decided create or update; the check only runs the registered read steps.
  function upsertExistenceCheck(c, mapping, key, body) {
    if (!store.pluginPipeline || isElastic(mapping)) return;
    const empty = '00000000-0000-0000-0000-000000000000';
    const keys = key.alternate ?? { [mapping.idColumn]: key.id };
    const literal = (value) =>
      typeof value === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? `'${value.replaceAll("'", "''")}'`
        : String(value);
    const params = {
      $select: mapping.idColumn,
      $filter: Object.entries(keys)
        .map(([name, value]) => `${name} eq ${literal(value)}`)
        .join(' and '),
      $top: '2',
    };
    const sdkQuery = {
      ...odataToSdkQuery(mapping.logicalName, params, store),
      columnSet: { allColumns: false, columns: [] },
    };
    const target = recordToSdkEntity(
      store,
      mapping.logicalName,
      store.normalizeRecord(mapping, payload(mapping, structuredClone(body))),
      {
        allColumns: true,
        submitted: true,
        target: true,
      },
    );
    target.id = key.alternate ? empty : key.id;
    if (key.alternate) target.keyAttributes = { ...key.alternate };
    store.query(mapping.logicalName, params, c.identity, null, {
      sdkQuery,
      bypassCustomPlugins: c.bypassCustomPlugins === true,
      bypassStepIds: c.bypassStepIds,
      readInitialFrame: {
        inputParameters: {
          $type: 'ParameterCollection',
          values: { AppModuleId: { $type: 'Guid', value: empty }, IsAppModuleContext: false },
        },
        delegatedSourceOperation: upsertSourceOperation({
          target,
          acceptLanguage: c.headers?.get?.('accept-language') ?? c.headers?.['accept-language'] ?? '',
          tag: store.pluginSdkTag,
          identity: c.identity,
        }),
      },
    });
  }

  // Upsert semantics per If-Match / If-None-Match; runs inside the caller's transaction and returns { created, id }.
  async function upsertNow(c, mapping, key, body, { ifMatch, ifNoneMatch }) {
    const logical = mapping.logicalName;
    if (ifMatch == null) assertPluginMessageAdmission(store, 'Upsert', c, logical);
    if (key.row && ifNoneMatch === '*') {
      throw new DataError('A record with matching key values already exists.', 412, 'PreconditionFailed', {
        innerCode: '0x80040237',
      });
    }
    // Native PATCH with If-Match on a missing row: 404 0x80040217, worded "Entity '<table>' With Id = <id> Does Not Exist".
    if (!key.row && ifMatch != null) {
      throw new DataError(`Entity '${logical}' With Id = ${key.text} Does Not Exist`, 404, 'NotFound', {
        innerCode: '0x80040217',
      });
    }
    if (isElastic(mapping) && ifMatch == null) {
      const data = bindsOf(c, mapping, payload(mapping, body), key.row);
      if (key.alternate) {
        if (Object.hasOwn(data, 'partitionid') && !samePartition(data.partitionid, key.alternate.partitionid))
          throw invalid('The partitionid value of an elastic table row cannot be changed.');
        Object.assign(data, key.alternate);
      } else data[mapping.idColumn] = key.id;
      authorize(c, logical, key.row ? 'update' : 'create', mapping, key.row ?? undefined);
      if (Object.keys(data).some((name) => name.endsWith(BIND))) authorize(c, logical, 'append', mapping);
      await beforeWrite(c, mapping, { operation: 'upsert', data, existing: key.row });
      const result = await store.elasticUpsertRecordAsync(
        logical,
        key.id ?? data[mapping.idColumn],
        data,
        c.identity,
        (key.row ? updateOptions : createOptions)(c, { ifMatch, ifNoneMatch, partitionId: c.partitionId }),
      );
      await afterWrite(c, mapping, { operation: 'upsert', id: result.row[mapping.idColumn] });
      return { created: result.created, id: result.row[mapping.idColumn] };
    }
    if (ifMatch == null) upsertExistenceCheck(c, mapping, key, body);
    if (key.row) {
      authorize(c, logical, 'update', mapping, key.row);
      // An elastic row's partitionid key is its partition: a body that changes it stays refused (elastic tables), not dropped.
      // The body's values for the URL's alternate key are dropped. The same rule applies to an If-Match: * update through
      // an alternate key, which is a guess: the drop is documented only for Upsert.
      const data = await updateData(
        c,
        mapping,
        body,
        key.row,
        isElastic(mapping) ? [] : Object.keys(key.alternate ?? {}),
      );
      await withKeyViolation(mapping, data, () =>
        store.updateRecordAsync(
          logical,
          key.row[mapping.idColumn],
          data,
          c.identity,
          updateOptions(c, {
            ifMatch,
            ifNoneMatch,
            ...(ifMatch == null ? { preValidationSourceOperation: 'upsert' } : {}),
          }),
        ),
      );
      await afterWrite(c, mapping, { operation: 'update', id: key.row[mapping.idColumn] });
      return { created: false, id: key.row[mapping.idColumn] };
    }
    const data = await createData(c, mapping, body);
    // An upsert create keeps the key values the body sets, even when they differ from the URL, and copies only the
    // missing ones from the URL.
    if (key.alternate)
      for (const [name, value] of Object.entries(key.alternate)) {
        if (!Object.hasOwn(data, name)) data[name] = value;
      }
    // The URL id is the new Entity.Id, not an authored primary-key attribute (native upsert-create Target).
    const createId = !key.alternate && ifMatch == null && !Object.hasOwn(data, mapping.idColumn) ? key.id : null;
    if (!key.alternate && createId === null) data[mapping.idColumn] = key.id;
    const row = await withKeyViolation(mapping, data, () =>
      store.createRecordAsync(
        logical,
        data,
        c.identity,
        createOptions(
          c,
          {
            ifNoneMatch,
            ...(ifMatch == null ? { preValidationSourceOperation: 'upsert' } : {}),
            ...(createId ? { sdkCreateId: createId } : {}),
          },
          data,
        ),
      ),
    );
    await afterWrite(c, mapping, { operation: 'create', id: row[mapping.idColumn] });
    return { created: true, id: row[mapping.idColumn] };
  }

  async function createEntity(c) {
    const { mapping } = c;
    const body = bodyOf(mapping.entitySet, c.body, c);
    const row = await runWrite(async () => {
      const data = await createData(c, mapping, body);
      const created = await withKeyViolation(mapping, data, () =>
        store.createRecordAsync(
          mapping.logicalName,
          data,
          c.identity,
          createOptions(c, { ifNoneMatch: c.headers['if-none-match'] }, data),
        ),
      );
      await afterWrite(c, mapping, { operation: 'create', id: created[mapping.idColumn] });
      return created;
    });
    const id = row[mapping.idColumn];
    if (isElastic(mapping)) c.partitionId = row.partitionid ?? null;
    // 204 names the new row in OData-EntityId; a 201 representation carries the row itself.
    // ServiceClient (UseWebApi) reads the new id only from Location (ConnectionService.cs Command_WebAPIProcess_ExecuteAsync).
    if (!c.prefer.representation) {
      const url = entityUrl(c.origin, c.version, mapping.entitySet, id);
      return { status: 204, headers: { 'OData-EntityId': url, Location: url } };
    }
    // The new row representation answers every column; the 201 carries no ETag (only Preference-Applied).
    const represented = entityBody(c, mapping, id, entityParams(c, mapping), { allColumns: true });
    return { status: 201, headers: appliedHeader(c.prefer), body: represented };
  }

  async function patchEntity(c) {
    const { mapping } = c;
    const body = bodyOf(mapping.entitySet, c.body, c);
    // The key row is read inside the write slot, so concurrent upserts of one new key create once and then update.
    let key;
    const outcome = await runWrite(() => {
      key = lookupKey(c, mapping, c.route.key);
      return upsertNow(c, mapping, key, body, {
        ifMatch: c.headers['if-match'],
        ifNoneMatch: c.headers['if-none-match'],
      });
    });
    // The location names the stored row: the URL key while the row still carries those key values, else its id (an
    // upsert-create keeps the body's differing key values, so the URL key would not find it).
    const stored = key.alternate && rowOf(c, mapping, outcome.id);
    const urlKeyHolds =
      key.alternate &&
      stored &&
      Object.entries(key.alternate).every(
        ([name, value]) => String(stored[name] ?? '').toLowerCase() === String(value ?? '').toLowerCase(),
      );
    const location = entityUrl(
      c.origin,
      c.version,
      mapping.entitySet,
      isElastic(mapping)
        ? recordKey(mapping, { [mapping.idColumn]: outcome.id, partitionid: c.partitionId })
        : urlKeyHolds
          ? key.text
          : outcome.id,
    );
    if (!c.prefer.representation) return { status: 204, headers: { 'OData-EntityId': location, Location: location } };
    // An update answers every column but drops the null ones (as every native PATCH 200 body does); an upsert-create keeps its own column set.
    const represented = outcome.created
      ? entityBody(c, mapping, outcome.id, entityParams(c, mapping))
      : withoutNullColumns(entityBody(c, mapping, outcome.id, entityParams(c, mapping), { allColumns: true }));
    return {
      status: outcome.created ? 201 : 200,
      headers: { ...etagOf(represented), ...appliedHeader(c.prefer) },
      body: represented,
    };
  }

  async function deleteEntity(c) {
    const { mapping } = c;
    // Resolved and authorized inside the write slot, against the row as earlier queued writes left it.
    await runWrite(async () => {
      const key = lookupKey(c, mapping, c.route.key);
      if (!key.row) throw notFoundRecord(mapping.logicalName, key.text);
      authorize(c, mapping.logicalName, 'delete', mapping, key.row);
      await beforeWrite(c, mapping, { operation: 'delete', existing: key.row });
      await store.removeRecordAsync(
        mapping.logicalName,
        key.row[mapping.idColumn],
        c.identity,
        updateOptions(c, { ifMatch: c.headers['if-match'] }),
      );
      await afterWrite(c, mapping, { operation: 'delete', id: key.row[mapping.idColumn] });
    });
    return { status: 204 };
  }

  // Related rows through a relationship, narrowed by a member key and the caller's row filter.
  function relatedRows(c, mapping, row, rel, segmentKey) {
    const target = store.resolveMapping(rel.entity);
    const wanted = segmentKey ? parseKey(segmentKey)?.id : null;
    const rows = store
      .queryContext(c.identity, { metadata: readFieldsOf, backendRowsFilter: rowsFilterOf(c) })
      .related(row, rel)
      .filter((item) => !wanted || sameId(item[target.idColumn], wanted));
    return { target, rows };
  }

  // Navigation collections reach the query hook with c.mapping as the parent and the related mapping as its argument.
  async function getNavigation(c, rel) {
    const { mapping, route } = c;
    const key = parentRow(c, mapping, 'read');
    await source(c, store.resolveMapping(rel.entity), { single: false, id: null });
    const { target, rows } = relatedRows(c, mapping, key.row, rel, route.segmentKey);
    if (rel.many === false) {
      const [row] = rows;
      return row
        ? {
            status: 200,
            body: entityBody(
              { ...c, partitionId: row.partitionid ?? null },
              target,
              row[target.idColumn],
              entityParams(c, target),
            ),
          }
        : { status: 204 };
    }
    const navigation = {
      ...c,
      navigation: { parent: { mapping, id: key.row[mapping.idColumn] }, name: route.segment },
    };
    const answer = await firstAnswer('query', navigation, target);
    if (answer !== undefined) {
      if (answer.fetchXml == null) return answer;
      authorize(c, target.logicalName, 'read', target);
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
    Boolean(readDefinition(mapping, segment)) ||
    (segment === CURRENCY && Object.keys(mapping.fields ?? {}).some((key) => isMoney(mapping, key)));
  function assertProperty(mapping, segment) {
    if (hasProperty(mapping, segment)) return;
    throw invalid(
      `Could not find a property named '${segment}' on type 'Microsoft.Dynamics.CRM.${mapping.logicalName}'.`,
      '0x80060888',
    );
  }

  function readProperty(c, mapping, id, segment) {
    // A path segment that names no column is a missing resource (404 0x80060888), not a bad query option.
    if (!hasProperty(mapping, segment))
      throw new DataError(`Resource not found for the segment '${segment}'`, 404, 'UnknownEntity', {
        httpStatus: 404,
        innerCode: '0x80060888',
        route: true,
      });
    const params = new URLSearchParams({ $select: segment });
    const projected = store.get(mapping.logicalName, id, c.identity, {
      ...secured(c, { id }),
      sdkColumns: { allColumns: false, columns: [segment] },
      project: (_row, key, columns) => {
        const selected = new URLSearchParams(params);
        if (columns?.allColumns) selected.delete('$select');
        else if (columns?.columns) selected.set('$select', columns.columns.join(','));
        return store.queryCore(mapping.logicalName, selected, c.identity, undefined, secured(c, { id: key })).value[0];
      },
    });
    if (!projected) return null;
    // The property and $value routes go through the same read projection as the entity read (column security, masking).
    const formatted = { [mapping.idColumn]: projected[mapping.idColumn] ?? id, [segment]: projected[segment] ?? null };
    projectRow(c, mapping, formatted, [], true);
    return formatted[segment] ?? null;
  }

  async function getProperty(c) {
    const { mapping, route } = c;
    await sourceKey(c, mapping);
    const rel = navigationOf(mapping, route.segment);
    if (rel) return getNavigation(c, rel);
    const key = parentRow(c, mapping, 'read');
    const value = readProperty(c, mapping, key.row[mapping.idColumn], route.segment);
    if (value == null) return { status: 204 };
    return {
      status: 200,
      body: { '@odata.context': contextFor(c, `${mapping.entitySet}(${route.key})/${route.segment}`), value },
    };
  }

  async function getValue(c) {
    await sourceKey(c, c.mapping);
    const key = parentRow(c, c.mapping, 'read');
    // A raw value of an unknown property: Dataverse names the $value segment, not the property.
    if (!hasProperty(c.mapping, c.route.segment)) {
      throw new DataError(
        `The URI segment '$value' is invalid after the segment '${c.route.segment}'.`,
        400,
        'InvalidRequest',
        { innerCode: '0x80060888', route: true },
      );
    }
    const value = readProperty(c, c.mapping, key.row[c.mapping.idColumn], c.route.segment);
    return value == null ? { status: 204 } : { status: 200, body: String(value) };
  }

  async function writeProperty(c, segment, value) {
    const { mapping } = c;
    const key = parentRow(c, mapping, 'update');
    await runWrite(async () => {
      const data = await updateData(c, mapping, { [segment]: value }, key.row);
      await store.updateRecordAsync(mapping.logicalName, key.row[mapping.idColumn], data, c.identity, updateOptions(c));
      await afterWrite(c, mapping, { operation: 'update', id: key.row[mapping.idColumn] });
    });
    return { status: 204 };
  }

  function putProperty(c) {
    if (navigationOf(c.mapping, c.route.segment)) throw methodNotAllowed(c.method);
    const body = bodyOf(c.mapping.entitySet, c.body, c);
    if (!('value' in body)) throw invalid('A property value is required: { "value": ... }.', '0x0');
    return writeProperty(c, c.route.segment, body.value);
  }

  function deleteProperty(c) {
    if (navigationOf(c.mapping, c.route.segment)) throw methodNotAllowed(c.method);
    return writeProperty(c, c.route.segment, null);
  }

  function navigationCount(c) {
    const rel = navigationOf(c.mapping, c.route.segment);
    if (!rel || rel.many === false) throw noResource(c);
    const key = parentRow(c, c.mapping, 'read');
    const { rows } = relatedRows(c, c.mapping, key.row, rel);
    return { status: 200, body: String(Math.min(rows.length, PAGE_CAP)) };
  }

  function getRef(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (!rel) throw noResource(c);
    const key = parentRow(c, mapping, 'read');
    const { target, rows } = relatedRows(c, mapping, key.row, rel);
    const link = (row) => ({ '@odata.id': entityUrl(c.origin, c.version, target.entitySet, row[target.idColumn]) });
    // A single-valued $ref answers the $ref context.
    if (rel.many === false)
      return rows[0]
        ? { status: 200, body: { '@odata.context': contextFor(c, '$ref'), ...link(rows[0]) } }
        : { status: 204 };
    return { status: 200, body: { '@odata.context': contextFor(c, 'Collection($ref)'), value: rows.map(link) } };
  }

  async function postRef(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (!rel || rel.many === false) throw methodNotAllowed(c.method);
    const ref = refOf(bodyOf(mapping.entitySet, c.body, c)['@odata.id']);
    const target = store.resolveMapping(rel.entity);
    const parent = parentRow(c, mapping, 'appendto');
    const child = rowOf(c, target, ref.id);
    if (!child) throw notFoundRecord(target.logicalName, ref.id);
    authorize(c, target.logicalName, 'append', target, child);
    // The shared association pipeline (associationSteps), authorized above; changeAssociationRecord, not store.associate:
    // that one opens its own transaction, which would queue behind this one.
    await runWrite(() =>
      drive(
        associationSteps(
          c,
          mapping.logicalName,
          parent.row[mapping.idColumn],
          route.segment,
          [child[target.idColumn]],
          true,
          { authorized: true, writeOptions: { partitionId: c.partitionId } },
        ),
      ),
    );
    return { status: 204 };
  }

  async function putRef(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (!rel || rel.many !== false) throw methodNotAllowed(c.method);
    const ref = refOf(bodyOf(mapping.entitySet, c.body, c)['@odata.id']);
    const parent = parentRow(c, mapping, 'update');
    await runWrite(async () => {
      const data = await updateData(c, mapping, { [`${route.segment}${BIND}`]: `/${ref.set}(${ref.id})` }, parent.row);
      await store.updateRecordAsync(
        mapping.logicalName,
        parent.row[mapping.idColumn],
        data,
        c.identity,
        updateOptions(c),
      );
      await afterWrite(c, mapping, {
        operation: 'update',
        id: parent.row[mapping.idColumn],
        relationship: route.segment,
      });
    });
    return { status: 204 };
  }

  async function deleteRef(c) {
    const { mapping, route } = c;
    const rel = navigationOf(mapping, route.segment);
    if (!rel) throw noResource(c);
    if (rel.many === false) {
      const parent = parentRow(c, mapping, 'update');
      await runWrite(async () => {
        const data = await updateData(c, mapping, { [`${route.segment}${BIND}`]: null }, parent.row);
        await store.updateRecordAsync(
          mapping.logicalName,
          parent.row[mapping.idColumn],
          data,
          c.identity,
          updateOptions(c),
        );
        await afterWrite(c, mapping, {
          operation: 'update',
          id: parent.row[mapping.idColumn],
          relationship: route.segment,
        });
      });
      return { status: 204 };
    }
    const parent = parentRow(c, mapping, 'appendto');
    const target = store.resolveMapping(rel.entity);
    const childId =
      route.kind === 'navigationRef'
        ? parseKey(route.targetKey)?.id
        : refOf(c.url.searchParams.get('$id'), { urlKey: true }).id;
    const child = rowOf(c, target, childId);
    if (!child) throw notFoundRecord(target.logicalName, childId);
    authorize(c, target.logicalName, 'append', target, child);
    await runWrite(() =>
      drive(
        associationSteps(
          c,
          mapping.logicalName,
          parent.row[mapping.idColumn],
          route.segment,
          [child[target.idColumn]],
          false,
          { authorized: true, writeOptions: { partitionId: c.partitionId } },
        ),
      ),
    );
    return { status: 204 };
  }

  function targetsOf(c) {
    const targets = c.body?.Targets;
    if (!Array.isArray(targets) || !targets.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
      throw invalid('The Targets parameter must be an array of objects.');
    }
    return targets;
  }

  // Native refuses a bulk message before any write: no targets, or a target typed as another table (the message reads 'none' there).
  // Assumed: UpdateMultiple and UpsertMultiple take the same refusals as CreateMultiple.
  function refuseBulkTargets(mapping, message, targets) {
    if (targets.length === 0)
      throw new DataError('Custom state is not set for entity type crmbaseentity.', 400, 'InvalidRequest', {
        innerCode: '0x80040216',
      });
    const typed = `Microsoft.Dynamics.CRM.${mapping.logicalName}`;
    if (
      targets.some(
        (target) => target['@odata.type'] !== undefined && String(target['@odata.type']).replace(/^#/, '') !== typed,
      )
    ) {
      throw new DataError(
        `The '${message}' method does not support entities of type 'none'. MessageProcessorCache returned MessageProcessor.Empty. `,
        400,
        'InvalidRequest',
        { innerCode: '0x80040800' },
      );
    }
  }

  // Elastic bulk requests commit each successful target independently and continue after failures.
  // Error codes of individual targets remain native CRUD errors.
  async function elasticBulk(c) {
    const { mapping, route } = c;
    const targets = targetsOf(c);
    refuseBulkTargets(mapping, route.name, targets);
    const ids = [],
      failures = [];
    let firstError;
    for (const [index, target] of targets.entries()) {
      try {
        const reference = target['@odata.id'] == null ? null : refOf(target['@odata.id']);
        if (reference && reference.set !== mapping.entitySet)
          throw invalid('The target does not belong to the bound table.');
        const text = reference?.id ?? target[mapping.idColumn];
        const alternate = text == null ? null : parseKey(text)?.alternate;
        const item = { ...c, partitionId: alternate?.partitionid ?? target.partitionid ?? null };
        await runWrite(async () => {
          if (route.name === 'CreateMultiple') {
            const data = await createData(item, mapping, target);
            const row = await store.createRecordAsync(
              mapping.logicalName,
              data,
              c.identity,
              createOptions(item, {}, data),
            );
            ids.push(row[mapping.idColumn]);
            await afterWrite(item, mapping, { operation: 'create', id: row[mapping.idColumn] });
          } else {
            if (text == null) throw invalid(`The ${mapping.idColumn} property is required.`);
            const key = lookupKey(item, mapping, String(text));
            if (route.name === 'DeleteMultiple') {
              if (!key.row) throw notFoundRecord(mapping.logicalName, key.text);
              authorize(item, mapping.logicalName, 'delete', mapping, key.row);
              await beforeWrite(item, mapping, { operation: 'delete', existing: key.row });
              await store.removeRecordAsync(
                mapping.logicalName,
                key.row[mapping.idColumn],
                c.identity,
                updateOptions(item),
              );
              await afterWrite(item, mapping, { operation: 'delete', id: key.row[mapping.idColumn] });
            } else {
              await upsertNow(item, mapping, key, target, {
                ifMatch: route.name === 'UpdateMultiple' ? '*' : undefined,
              });
            }
          }
        });
      } catch (error) {
        if (!(error instanceof DataError)) throw error;
        firstError ??= error;
        failures.push({ RequestIndex: index, Id: target[mapping.idColumn] ?? null, StatusCode: error.status ?? 400 });
      }
    }
    if (firstError)
      throw new DataError(firstError.message, firstError.status, firstError.code, {
        ...firstError.details,
        bulkApiErrorDetails: failures,
      });
    return route.name === 'CreateMultiple'
      ? {
          status: 200,
          body: { '@odata.context': contextFor(c, 'Microsoft.Dynamics.CRM.CreateMultipleResponse'), Ids: ids },
        }
      : { status: 204 };
  }

  async function boundAction(c) {
    const { mapping, route } = c;
    if (route.key == null && route.name === 'DeleteMultiple' && !isElastic(mapping)) return deleteMultipleRefusal(c);
    assertPluginMessageAdmission(store, route.name, c, mapping.logicalName);
    if (route.key != null) throw noResource(c);
    if (
      isElastic(mapping) &&
      ['CreateMultiple', 'UpdateMultiple', 'UpsertMultiple', 'DeleteMultiple'].includes(route.name)
    )
      return elasticBulk(c);
    if (route.name === 'CreateMultiple' || route.name === 'UpdateMultiple') return standardBulk(c);
    if (route.name === 'UpsertMultiple') {
      const targets = targetsOf(c);
      refuseBulkTargets(mapping, route.name, targets);
      // A target names its record by @odata.id or by its primary key column.
      const texts = targets.map((target) =>
        target['@odata.id'] == null ? String(target[mapping.idColumn] ?? '') : refOf(target['@odata.id']).id,
      );
      const seen = new Set(),
        creates = [],
        updates = [];
      for (const [index, target] of targets.entries()) {
        const folded = texts[index].toLowerCase();
        if (seen.has(folded)) throw invalid('Duplicate key in Targets.', '0x80040203'); // native message text is a guess
        seen.add(folded);
        const key = lookupKey(c, mapping, texts[index]);
        const values = { ...target };
        delete values['@odata.id'];
        if (key.row) updates.push({ ...values, [mapping.idColumn]: key.row[mapping.idColumn] });
        else creates.push(values);
      }
      // Natively UpsertMultiple runs no pipeline of its own: the new records go through the CreateMultiple pipeline,
      // then the existing ones through UpdateMultiple, whose message input carries ConcurrencyBehavior (recorded corpus).
      await runWrite(async () => {
        if (creates.length) await bulkWrite(c, false, creates, { delegated: true });
        if (updates.length) await bulkWrite(c, true, updates, { concurrencyBehavior: 0, delegated: true });
      });
      return { status: 204 };
    }
    throw noResource(c);
  }

  // DeleteMultiple is available on elastic tables only: a standard table runs its PreValidation, then refuses.
  async function deleteMultipleRefusal(c) {
    const { mapping } = c;
    const targets = targetsOf(c);
    refuseBulkTargets(mapping, 'DeleteMultiple', targets);
    const rows = targets.map((target) => {
      const text = target['@odata.id'] == null ? target[mapping.idColumn] : refOf(target['@odata.id']).id;
      if (text == null) throw invalid(`The ${mapping.idColumn} property is required.`);
      const key = lookupKey(c, mapping, String(text));
      if (!key.row) throw notFoundRecord(mapping.logicalName, key.text);
      authorize(c, mapping.logicalName, 'delete', mapping, key.row);
      return key.row;
    });
    await runWrite(async () =>
      refuseDeleteMultiple(store, { mapping, rows, identity: c.identity, options: updateOptions(c) }),
    );
  }

  // Both HTTP and the synchronous SDK enter the same grouped plug-in pipeline.
  // HTTP keeps its payload/lookup grammar and awaits record hooks and webhooks.
  async function standardBulk(c) {
    const { mapping, route } = c,
      update = route.name === 'UpdateMultiple',
      raw = targetsOf(c);
    refuseBulkTargets(mapping, route.name, raw);
    const result = await runWrite(() => bulkWrite(c, update, raw));
    if (update) return { status: 204 };
    const outputs = result.outputParameters?.values;
    let ids = result.ids;
    if (outputs) {
      ids = undefined;
      if (Object.hasOwn(outputs, 'Ids')) {
        if (outputs.Ids?.$type !== 'GuidArray' || !Array.isArray(outputs.Ids.values))
          throw new DataError(
            'CreateMultiple output Ids requires a typed Guid array.',
            501,
            'LocalPluginOutputUnsupported',
          );
        ids = outputs.Ids.values.map((value) => (typeof value === 'string' ? value : value.value));
      }
    }
    return {
      status: 200,
      body: {
        '@odata.context': contextFor(c, 'Microsoft.Dynamics.CRM.CreateMultipleResponse'),
        ...(ids === undefined ? {} : { Ids: ids }),
      },
    };
  }

  // The grouped CreateMultiple/UpdateMultiple pipeline over Web API targets, inside the caller's write.
  async function bulkWrite(c, update, raw, { concurrencyBehavior, delegated = false } = {}) {
    const { mapping } = c;
    const targets = [];
    for (const target of raw) {
      const text = target[mapping.idColumn];
      if (update && text == null) throw invalid(`The ${mapping.idColumn} property is required.`);
      const existing = update ? lookupKey(c, mapping, String(text)).row : null;
      if (update && !existing) throw notFoundRecord(mapping.logicalName, String(text));
      const data = update ? await updateData(c, mapping, target, existing) : await createData(c, mapping, target);
      const id = update ? existing[mapping.idColumn] : data[mapping.idColumn];
      delete data[mapping.idColumn];
      const encoded = recordToSdkEntity(store, mapping.logicalName, store.normalizeRecord(mapping, data, c.identity));
      delete encoded.attributes[mapping.idColumn];
      targets.push({ ...encoded, id: id ?? '00000000-0000-0000-0000-000000000000' });
    }
    return executeBulkRecordsAsync({
      store,
      entity: mapping.logicalName,
      operation: update ? 'updatemultiple' : 'createmultiple',
      targets,
      identity: c.identity,
      bypassCustomPlugins: c.bypassCustomPlugins === true,
      bypassCustomAsync: c.bypassCustomAsync === true,
      bypassStepIds: c.bypassStepIds,
      authorize: (operation, values, previous) => {
        authorize(c, mapping.logicalName, operation, mapping, previous ?? values);
        authorizeLookups(c, mapping, values);
      },
      write: async (_update, id, data, options) => {
        const row = await withKeyViolation(mapping, data, () =>
          update
            ? store.updateRecordAsync(mapping.logicalName, id, data, c.identity, updateOptions(c, options))
            : store.createRecordAsync(mapping.logicalName, data, c.identity, createOptions(c, options, data)),
        );
        options.postWriteEffects.push(() =>
          afterWrite(c, mapping, { operation: update ? 'update' : 'create', id: row[mapping.idColumn] }),
        );
        return row;
      },
      ...(concurrencyBehavior === undefined ? {} : { concurrencyBehavior }),
      delegated,
    });
  }

  // A verb a record does not take. PUT and POST on a record have their own native 0x80060888 messages; others are the generic 405.
  const unsupportedVerbError = (c) => {
    if (c.route.kind === 'entity' && c.method === 'PUT') {
      return new DataError(`Operation not supported on ${c.mapping.logicalName}`, 405, 'MethodNotAllowed', {
        httpStatus: 405,
        innerCode: '0x80060888',
        route: true,
      });
    }
    if (c.route.kind === 'entity' && c.method === 'POST') {
      return new DataError(
        'Unmapped Request found, PathTemplate:~/entityset/key, HttpVerb:POST',
        405,
        'MethodNotAllowed',
        { httpStatus: 405, innerCode: '0x80060888' },
      );
    }
    return methodNotAllowed(c.method);
  };
  // Allow on a keyed 405 lists the methods of the record, per attempted method.
  const RECORD_ALLOW = {
    HEAD: 'POST,OPTIONS,GET,HEAD,POST',
    OPTIONS: 'POST,OPTIONS,GET,HEAD,POST',
    PUT: 'GET,PATCH,DELETE,OPTIONS,GET,HEAD,POST',
    POST: 'GET,PUT,PATCH,DELETE,OPTIONS,GET,HEAD,POST',
  };
  const unsupportedVerb = (c) => {
    const error = unsupportedVerbError(c);
    if (c.route.kind === 'entity' && RECORD_ALLOW[c.method])
      error.details = { ...error.details, allow: RECORD_ALLOW[c.method] };
    return error;
  };

  const verbs = (c, table) => {
    const run = table[c.method];
    if (!run) throw unsupportedVerb(c);
    return run(c);
  };

  // The stream hook sees property and value routes on any verb, before the route's own verbs run.
  const streamOr = async (c, otherwise) => {
    const answer = await firstAnswer('stream', c);
    return answer !== undefined ? answer : otherwise();
  };

  async function dispatch(c) {
    switch (c.route.kind) {
      case 'collection':
        return verbs(c, { GET: collection, POST: createEntity });
      case 'count':
        return verbs(c, { GET: countRecords });
      case 'entity':
        return verbs(c, { GET: getEntity, PATCH: patchEntity, DELETE: deleteEntity });
      case 'property':
        return streamOr(c, () => verbs(c, { GET: getProperty, PUT: putProperty, DELETE: deleteProperty }));
      case 'member':
        return verbs(c, { GET: getProperty, PUT: putProperty, DELETE: deleteProperty });
      case 'value':
        return streamOr(c, () => verbs(c, { GET: getValue }));
      case 'navigationCount':
        return verbs(c, { GET: navigationCount });
      case 'ref':
        return verbs(c, { GET: getRef, POST: postRef, PUT: putRef, DELETE: deleteRef });
      case 'navigationRef':
        return verbs(c, { DELETE: deleteRef });
      case 'boundAction':
        return verbs(c, { POST: boundAction });
      default:
        throw noResource(c);
    }
  }

  // ---- Internal writes: the organization mutation pipeline for every caller that is not a Web API request
  // Callers: the SDK IOrganizationService (local-organization-service.mjs: CLR plug-ins and the flow Dataverse connector), the
  // portal /_api and portal forms, activity messages, and note, attachment and SharePoint rows (dataverse-files.mjs
  // createThroughPipeline). Each entry runs the Web API rules below in the caller's store transaction (none of its own).
  //
  // Context c: { user?, userId?, identity?, caller?, requestId?, portal? }. Without c.user, c.userId names the acting
  // systemuser (an SDK backend profile) and resolves to that user, else to the organization SYSTEM user; c.portal acts as
  // the SYSTEM user and stamps the site's observed application user (observed.portalApplicationUser) as createdby/modifiedby.
  // Options: authorized (the caller has authorized the write itself: explicit backend grants or portal table permissions;
  // principals.authorize is skipped), writeOptions (extra store write options, e.g. sdkResponseToken, portalRequest,
  // metadata, coerce), partitionId (elastic rows), sync and deferred.
  // sync: the entry returns its result instead of a promise, for a synchronous caller (an SDK call inside the store's
  // synchronous plug-in pipeline). Every hook still runs inline and in order, so the synchronous rule hooks (business rules,
  // calculated and formula refusal, currency, state transitions, duplicates, column security, rollup marking, cascade, system
  // columns) take effect exactly as on the Web API. A beforeWrite hook is a pre-operation rule: one that answers a promise
  // (an asynchronous Power Fx adapter, attachment storage) cannot finish before the store write, so the call is refused with
  // 501 SdkAsyncPreOperationUnsupported naming the hook's module, inside the caller's savepoint and before the store write.
  // An external (main-operation) promise, an asynchronous virtual-table provider, is refused the same way inside the savepoint,
  // which rolls the store write back. An afterWrite promise (audit association rows, a real-time classic
  // workflow) is pushed to `deferred`, finishes after the call returns, and the caller reports its failure
  // (SDK_DEFERRED_EFFECT). ponytail: the afterWrite remainder runs outside the call's savepoint; hook classes declared at
  // registration would let the pipeline move such hooks wholly to post-commit work.
  function* writeHooks(name, ...args) {
    if (name === 'afterWrite') yield* writeHooks('external', ...args);
    for (const hook of hookList(name)) {
      const execution = pluginExecutionLifetime(store, pluginInvocationDepth(store), undefined, { recordHook: true });
      let value;
      try {
        value = execution.run(() => hook(...args));
        if (typeof value?.then === 'function')
          value = Promise.resolve(value).then(
            (answer) => {
              execution.close();
              return answer;
            },
            (error) => {
              execution.close('refused');
              throw error;
            },
          );
        else execution.close();
      } catch (error) {
        execution.close('refused');
        throw error;
      }
      yield { name, hook, value, execution };
    }
  }
  // A "store" step is the store write itself (yielded by createSteps/updateSteps/removeSteps): its value goes back into the
  // steps. On the synchronous drive it is the stored row (data.mjs createRecord: the plug-in pipeline posts I/O steps through
  // the synchronous I/O bridge); on the asynchronous drive it is the promise of data.mjs createRecordAsync, awaited here.
  function drive(steps, { sync = false, deferred = [] } = {}) {
    if (sync) {
      let sent;
      for (let step = steps.next(); ; step = steps.next(sent)) {
        if (step.done) return step.value;
        const { name, hook, value, execution } = step.value;
        sent = value;
        if (typeof value?.then !== 'function') continue;
        if (name === 'afterWrite') {
          deferred.push(value);
          continue;
        }
        execution?.close('refused');
        value.catch?.(() => {}); // refused below: its own failure is not reported a second time
        const module = hooks.moduleOf?.(hook) ?? (hook.name || 'an unnamed record hook');
        throw new DataError(
          `The ${name === 'external' ? 'main-operation' : 'pre-operation'} record hook of ${module} is asynchronous; a synchronous SDK write cannot wait for it.`,
          501,
          'SdkAsyncPreOperationUnsupported',
        );
      }
    }
    return (async () => {
      let sent;
      for (let step = steps.next(); ; step = steps.next(sent)) {
        if (step.done) return step.value;
        sent = await step.value.value;
      }
    })();
  }
  const systemUser = () => {
    const organizationId = organizationRecord(store)?.organizationid;
    return organizationId ? (principals.byId?.(uuidV5(organizationId, 'systemuser:SYSTEM')) ?? null) : null;
  };
  const internalContext = (c) => {
    if (c.user) return c;
    if (c.userId != null) return { ...c, user: principals.byId?.(c.userId) ?? systemUser() };
    if (c.portal) return { ...c, user: systemUser() };
    return c;
  };
  // Platform validation after PreValidation observes the current Target, while
  // preserving the established earlier beforeWrite extension hook contract.
  function phaseValidation(c, extra) {
    if (!hooks.list('afterPreValidation').length && !extra.afterPreValidation) return undefined;
    return (entity, operation, target, previous) => {
      extra.afterPreValidation?.(entity, operation, target, previous);
      return drive(
        writeHooks('afterPreValidation', c, store.resolveMapping(entity), {
          operation,
          data: structuredClone(target),
          existing: previous ? structuredClone(previous) : null,
        }),
        { sync: true },
      );
    };
  }
  // Hooks see the caller's context; the audit columns name its user, or SYSTEM when it has none.
  const actorOf = (c) => (c.user ? c : { ...c, user: systemUser() });
  // append on the table and appendTo on each looked-up row of { id, logical_name } lookups.
  function authorizeLookups(c, mapping, data) {
    const lookups = Object.entries(data).filter(
      ([column, value]) =>
        !LOOKUP_SYSTEM.has(column) &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value.id != null &&
        value.logical_name != null,
    );
    if (lookups.length) authorize(c, mapping.logicalName, 'append', mapping);
    for (const [, value] of lookups) {
      let target;
      try {
        target = store.resolveMapping(value.logical_name);
      } catch {
        continue;
      }
      // The primary key index answers the target row; a table without one is scanned.
      const keyed = typeof value.id === 'string' ? store.primaryKeySubset(target, [value.id]) : null;
      const row = keyed
        ? keyed[0]
        : store.tableRows(target.logicalName).find((r) => guidKey(r[target.idColumn]) === guidKey(value.id));
      authorize(c, target.logicalName, 'appendto', target, row);
    }
  }
  // The stored row a write addresses, as the hooks' `existing`; the store write itself checks the caller's identity.
  const existingRow = (mapping, id, partitionId) => {
    const rows = store.tableRows(mapping.logicalName);
    const row = rows[store.rowIndex(mapping, rows, id, partitionId === undefined ? {} : { partitionId })];
    if (!row) throw notFoundRecord(mapping.logicalName, id);
    return cloneStateData(row);
  };

  /**
   * Creates one internal row (a row a message, an SDK call, a connector action or a portal surface builds, not a Web API
   * request body) through the Web API create rules; returns the stored row. Applied exactly as on a Web API create:
   * create authorization, append on the table and appendTo on each looked-up row, the state-0 statecode/statuscode defaults
   * (hasStateColumns/defaultStatus), the beforeWrite/afterWrite hooks, createOptions write options (coerce, metadata,
   * dataverseWebApi, bypassCustomPlugins, plug-in steps in the store), the owner from an ownerid lookup, audit columns, the
   * row version, base currency and time zone rule version (systemColumns), and the 412 alternate-key answer (withKeyViolation).
   * Differs from a Web API create:
   * - lookups are { id, logical_name } values (a portal payload's @odata.bind keys go to the store as they are): an unknown
   *   lookup table is skipped and a missing looked-up row is checked for appendTo at table depth instead of answering 404;
   *   ownerid takes no assign check (no bind to authorize);
   * - createPayload's body rules (annotation and system-column filtering, overriddencreatedon) and deep insert do not apply;
   * - without a user (see internalContext) nothing is authorized (the caller runs the admin pipeline and checked organization
   *   privileges itself) and the audit columns name the organization SYSTEM user; options.authorized skips authorization too;
   * - no store transaction of its own and no If-None-Match unless writeOptions carries it.
   */
  function createInternal(c, logical, data, options = {}) {
    const context = internalContext(c);
    return traced(
      context,
      'create',
      logical,
      null,
      options,
      () => data,
      () => drive(createSteps(context, logical, data, options), options),
    );
  }
  function* createSteps(
    c,
    logical,
    data,
    { authorized = false, writeOptions: extra = {}, sync = false, postWriteEffects },
  ) {
    const mapping = store.resolveMapping(logical);
    if (c.user && !authorized) {
      authorize(c, mapping.logicalName, 'create', mapping);
      authorizeLookups(c, mapping, data);
    }
    const derived = {};
    if (!('statecode' in data) && hasStateColumns(mapping)) data.statecode = derived.statecode = 0;
    if (!('statuscode' in data) && hasStateColumns(mapping)) {
      const status = defaultStatus(mapping);
      if (status !== undefined) data.statuscode = derived.statuscode = status;
    }
    derivedCreateColumns.set(data, derived);
    yield* writeHooks('beforeWrite', c, mapping, { operation: 'create', data, existing: null });
    const write = sync ? store.createRecord : store.createRecordAsync;
    const row = yield {
      name: 'store',
      value: withKeyViolation(mapping, data, () =>
        write.call(store, mapping.logicalName, data, c.identity ?? {}, createOptions(actorOf(c), extra, data)),
      ),
    };
    if (postWriteEffects)
      postWriteEffects.push((options) =>
        drive(writeHooks('afterWrite', c, mapping, { operation: 'create', id: row[mapping.idColumn], sync }), options),
      );
    else yield* writeHooks('afterWrite', c, mapping, { operation: 'create', id: row[mapping.idColumn], sync });
    return row;
  }

  /**
   * Updates one row through the Web API update rules: update authorization on the stored row, append/appendTo for
   * { id, logical_name } lookups, the beforeWrite/afterWrite hooks with the stored row as `existing`, updateOptions (modifiedby,
   * row version, currency, time zone) and withKeyViolation. id is a primary key or a store key text (alternate keys).
   * Returns the stored row. Same context, options and differences as createInternal; the primary key column is never written.
   */
  function updateInternal(c, logical, id, data, options = {}) {
    const context = internalContext(c);
    return traced(
      context,
      'update',
      logical,
      id,
      options,
      () => data,
      () => drive(updateSteps(context, logical, id, data, options), options),
    );
  }
  function* updateSteps(
    c,
    logical,
    id,
    data,
    { authorized = false, writeOptions: extra = {}, partitionId, sync = false, postWriteEffects },
  ) {
    const mapping = store.resolveMapping(logical);
    const existing = existingRow(mapping, id, partitionId);
    if (c.user && !authorized) {
      authorize(c, mapping.logicalName, 'update', mapping, existing);
      authorizeLookups(c, mapping, data);
    }
    delete data[mapping.idColumn];
    yield* writeHooks('beforeWrite', c, mapping, { operation: 'update', data, existing });
    const write = sync ? store.updateRecord : store.updateRecordAsync;
    const row = yield {
      name: 'store',
      value: withKeyViolation(mapping, data, () =>
        write.call(
          store,
          mapping.logicalName,
          id,
          data,
          c.identity ?? {},
          updateOptions(actorOf(c), { ...(partitionId === undefined ? {} : { partitionId }), ...extra }),
        ),
      ),
    };
    if (postWriteEffects)
      postWriteEffects.push((options) =>
        drive(
          writeHooks('afterWrite', c, mapping, { operation: 'update', id: existing[mapping.idColumn], sync }),
          options,
        ),
      );
    else yield* writeHooks('afterWrite', c, mapping, { operation: 'update', id: existing[mapping.idColumn], sync });
    return row;
  }

  /** Deletes one row through the Web API delete rules: delete authorization, the hooks, updateOptions (cascaded rows). */
  function removeInternal(c, logical, id, options = {}) {
    const context = internalContext(c);
    return traced(context, 'delete', logical, id, options, undefined, () =>
      drive(removeSteps(context, logical, id, options), options),
    );
  }
  function* removeSteps(c, logical, id, { authorized = false, writeOptions: extra = {}, partitionId, sync = false }) {
    const mapping = store.resolveMapping(logical);
    const existing = existingRow(mapping, id, partitionId);
    if (c.user && !authorized) authorize(c, mapping.logicalName, 'delete', mapping, existing);
    yield* writeHooks('beforeWrite', c, mapping, { operation: 'delete', existing });
    const write = sync ? store.removeRecord : store.removeRecordAsync;
    const result = yield {
      name: 'store',
      value: write.call(
        store,
        mapping.logicalName,
        id,
        c.identity ?? {},
        updateOptions(actorOf(c), { ...(partitionId === undefined ? {} : { partitionId }), ...extra }),
      ),
    };
    yield* writeHooks('afterWrite', c, mapping, { operation: 'delete', id: existing[mapping.idColumn], sync });
    return result;
  }

  /**
   * Associates (associateInternal) or disassociates (disassociateInternal) one row with related rows through a
   * collection-valued navigation, under the Web API $ref rules; every caller (the Web API $ref routes, the SDK
   * Associate/Disassociate, the portal /_api $ref) runs these steps:
   * - appendTo on the row and append on each related row, unless the caller
   *   is unauthenticated (see internalContext) or options.authorized;
   * - the beforeWrite hooks ({ operation, data: { relationship, id: relatedId }, existing }) and afterWrite hooks
   *   ({ operation, id, relationship, relatedId }) once per related row (audit rows, security rules, committed work);
   * - the Associate/Disassociate plug-in stages 10, 20 and 40 (store.pluginPipeline, with Target, Relationship and
   *   RelatedEntities; skipped for c.bypassCustomPlugins) around store.changeAssociationRecord, which applies the
   *   relationship rules and the caller identity's store permissions (portal table permissions).
   * options: authorized, writeOptions (partitionId, portalRequest, sdkResponseToken), sync, deferred (as createInternal), and
   * write: a caller-supplied write that replaces the plug-in stages and changeAssociationRecord (the SDK service's
   * executeAssociation, which runs the stages with its explicit grants); with write, the related rows are not looked up.
   * Signature: associateInternal(c, logical, id, navigation, relatedIds, options) -> null (or a promise of null without sync).
   */
  function associateInternal(c, logical, id, navigation, relatedIds, options = {}) {
    const context = internalContext(c);
    return traced(
      context,
      'associate',
      logical,
      id,
      options,
      () => ({ navigation, relatedIds }),
      () => drive(associationSteps(context, logical, id, navigation, [relatedIds].flat(), true, options), options),
    );
  }
  /** The Disassociate counterpart of associateInternal: same context, arguments, options and rules. */
  function disassociateInternal(c, logical, id, navigation, relatedIds, options = {}) {
    const context = internalContext(c);
    return traced(
      context,
      'disassociate',
      logical,
      id,
      options,
      () => ({ navigation, relatedIds }),
      () => drive(associationSteps(context, logical, id, navigation, [relatedIds].flat(), false, options), options),
    );
  }
  function* associationSteps(
    c,
    logical,
    id,
    navigation,
    relatedIds,
    associate,
    {
      authorized = false,
      writeOptions: extra = {},
      write = null,
      sync = false,
      effectiveAssociation,
      associationParameters: suppliedParameters,
    },
  ) {
    let mapping = store.resolveMapping(logical);
    const operation = associate ? 'associate' : 'disassociate';
    const { partitionId, sdkResponseToken, portalRequest } = extra;
    let existing = existingRow(mapping, id, partitionId ?? undefined);
    let rowId = existing[mapping.idColumn];
    let rel = null,
      target = null;
    if (!write) {
      rel = navigationOf(mapping, navigation);
      if (!rel || (rel.many === false && !suppliedParameters))
        throw new DataError(
          `'${navigation}' is not a collection-valued navigation of ${mapping.logicalName}; set a single-valued one through its lookup.`,
          400,
          'InvalidAssociation',
        );
      target = store.resolveMapping(rel.entity);
      const related = relatedIds.map((relatedId) => existingRow(target, relatedId));
      if (c.user && !authorized) {
        authorize(c, mapping.logicalName, rel.many === false ? 'append' : 'appendto', mapping, existing);
        for (const row of related)
          authorize(c, target.logicalName, rel.many === false ? 'appendto' : 'append', target, row);
      }
    }
    for (const relatedId of relatedIds)
      yield* writeHooks('beforeWrite', c, mapping, {
        operation,
        data: { relationship: navigation, id: relatedId },
        existing,
      });
    // Without sync each stage's post and the referencing row's update steps are awaited (drive), never the synchronous bridge.
    if (write) yield { name: 'store', value: write() };
    else {
      // Assumed: the Relationship schema name falls back to the navigation name when the mapping names none.
      const parameters = suppliedParameters
        ? cloneStateData(suppliedParameters)
        : {
            Target: { $type: 'EntityReference', logicalName: mapping.logicalName, id: rowId, name: null },
            Relationship: { $type: 'Relationship', schemaName: rel.schemaName ?? navigation, primaryEntityRole: null },
            RelatedEntities: {
              $type: 'EntityReferenceCollection',
              values: relatedIds.map((relatedId) => ({
                $type: 'EntityReference',
                logicalName: target.logicalName,
                id: relatedId,
                name: null,
              })),
            },
          };
      const originalBinding = {
          entity: mapping.logicalName,
          navigation,
          schemaName: parameters.Relationship.schemaName,
          role: parameters.Relationship.primaryEntityRole,
          relatedEntity: target.logicalName,
        },
        holder = cloneStateData(existing),
        inherited = store.pluginInTransaction;
      let finalFrame;
      // Natively a Web API many-to-many association first reads the intersect row of each pair: a RetrieveMultiple of
      // the intersect table with this FetchExpression runs its own pipeline before Associate (recorded corpus).
      if (
        !suppliedParameters &&
        operation === 'associate' &&
        rel.intersect?.entity &&
        store.pluginPipeline &&
        store.pluginPipelineActive({
          entity: rel.intersect.entity,
          operation: 'retrievemultiple',
          bypassCustomPlugins: c.bypassCustomPlugins,
          bypassStepIds: c.bypassStepIds,
        })
      )
        for (const relatedId of relatedIds) {
          const braced = (value) => '{' + String(value).toUpperCase() + '}';
          const xml =
            '<fetch distinct="false" useraworderby="false" no-lock="false" mapping="logical">' +
            `<entity name="${rel.intersect.entity}"><filter type="and">` +
            `<condition attribute="${rel.intersect.from}" operator="eq" value="${braced(rowId)}" />` +
            `<condition attribute="${rel.intersect.to}" operator="eq" value="${braced(relatedId)}" />` +
            '</filter></entity></fetch>';
          // The platform's own check: the caller's read permission on the intersect table does not apply.
          store.retrieveMultipleOperation(
            rel.intersect.entity,
            { $type: 'FetchExpression', query: xml },
            { ...(c.identity ?? {}), admin: true },
            () => ({
              value: store
                .tableRows(rel.intersect.entity)
                .filter(
                  (row) =>
                    guidKey(row[rel.intersect.from]) === guidKey(rowId) &&
                    guidKey(row[rel.intersect.to]) === guidKey(relatedId),
                ),
            }),
            'value',
            undefined,
            { bypassStepIds: c.bypassStepIds, bypassCustomPlugins: c.bypassCustomPlugins === true },
          );
        }
      const phase = function* (stage) {
        if (
          !store.pluginPipeline ||
          !store.pluginPipelineActive({
            entity: mapping.logicalName,
            operation,
            bypassCustomPlugins: c.bypassCustomPlugins,
            bypassStepIds: c.bypassStepIds,
          })
        )
          return;
        if (stage !== 10) store.pluginInTransaction = !isElastic(mapping);
        const context = {
          entity: mapping.logicalName,
          operation,
          stage,
          associationParameters: parameters,
          ...(rel.intersect ? { intersectEntity: rel.intersect.entity } : {}),
          record: holder,
          identity: c.identity ?? {},
          changedAttributes: [],
          bypassStepIds: c.bypassStepIds,
          bypassCustomPlugins: c.bypassCustomPlugins,
          portalRequest: portalRequest === true,
          ...(sync ? {} : { awaitIo: true }),
        };
        const frame = yield {
          name: 'store',
          value: store.pluginPipeline(context),
        };
        finalFrame = frame;
        if (stage === 40) handoffPluginResponse(store, operation, mapping.logicalName, frame, sdkResponseToken);
      };
      try {
        yield* phase(10);
        yield* phase(20);
        const sameBinding =
          parameters.Target?.logicalName === originalBinding.entity &&
          String(parameters.Relationship?.schemaName ?? '').toLowerCase() ===
            originalBinding.schemaName.toLowerCase() &&
          (parameters.Relationship?.primaryEntityRole ?? null) === (originalBinding.role ?? null) &&
          parameters.RelatedEntities?.values?.every(
            (reference) => reference.logicalName === originalBinding.relatedEntity,
          );
        const effective = associationRequestBinding(store, parameters, c.identity ?? {}, {
          navigationFallback: true,
          allowLocalIds: !suppliedParameters,
          ...(sameBinding ? { preferredNavigation: originalBinding.navigation } : {}),
        });
        mapping = effective.mapping;
        rel = effective.rel;
        navigation = effective.navigation;
        rowId = effective.id;
        relatedIds = effective.related.values.map((reference) => reference.id);
        existing = existingRow(mapping, rowId, partitionId ?? undefined);
        target = store.resolveMapping(rel.entity);
        const related = relatedIds.map((relatedId) => existingRow(target, relatedId));
        if (c.user && !authorized) {
          authorize(c, mapping.logicalName, rel.many === false ? 'append' : 'appendto', mapping, existing);
          for (const row of related)
            authorize(c, target.logicalName, rel.many === false ? 'appendto' : 'append', target, row);
        }
        for (const key of Object.keys(holder)) delete holder[key];
        Object.assign(holder, cloneStateData(existing));
        const change = sync ? store.changeAssociationRecord : store.changeAssociationRecordAsync;
        let writeMapping = mapping,
          writeId = rowId,
          writeNavigation = navigation,
          writeRelated = relatedIds;
        if (rel.many === false) {
          const reverse = Object.entries(store.relationshipsFor(target, c.identity ?? {})).filter(
            ([name, candidate]) =>
              name === rel.partner &&
              candidate.schemaName === rel.schemaName &&
              candidate.entity === mapping.logicalName &&
              candidate.many !== false &&
              !candidate.intersect,
          );
          if (reverse.length !== 1)
            throw new DataError(
              'Association replacement requires its source-defined collection partner.',
              501,
              'LocalSdkRelationshipUnsupported',
            );
          writeMapping = target;
          writeId = relatedIds[0];
          writeNavigation = reverse[0][0];
          writeRelated = [rowId];
        }
        for (const relatedId of writeRelated)
          yield {
            name: 'store',
            value: change.call(
              store,
              writeMapping.logicalName,
              writeId,
              writeNavigation,
              relatedId,
              c.identity ?? {},
              associate,
              updateOptions(actorOf(c), extra),
            ),
          };
        yield* phase(40);
        store.recordCommittedEvent(mapping.logicalName, operation, holder, [], {
          target: {},
          associationParameters: parameters,
          identity: c.identity ?? {},
          frame: finalFrame ?? {},
          messageEvent: true,
          bypassCustomAsync: c.bypassCustomAsync === true,
          bypassStepIds: c.bypassStepIds,
        });
      } finally {
        store.pluginInTransaction = inherited;
      }
    }
    if (write && effectiveAssociation?.mapping) {
      mapping = effectiveAssociation.mapping;
      rowId = effectiveAssociation.id;
      navigation = effectiveAssociation.navigation;
      relatedIds = effectiveAssociation.relatedIds;
    }
    for (const relatedId of relatedIds)
      yield* writeHooks('afterWrite', c, mapping, { operation, id: rowId, relationship: navigation, relatedId });
    return null;
  }

  /**
   * Reads one stored row for a non-Web API reader (SDK Retrieve) through the shared read projection: the computed
   * (calculated and formula) columns, then every project hook (column security, masking unless options.unmask, image
   * columns), applied to the row before the store's Retrieve plug-in steps see it. Synchronous. Returns the store's answer
   * (null when absent); getOptions (sdkColumns, sdkResponseToken, skipPluginRead) pass to store.get. Authorization is the
   * caller's: the SDK service checks its explicit grants first.
   */
  // A virtual table is never read from its local mirror here: handlers.virtualProviders (set by
  // dataverse-virtual-providers.mjs) answers the provider's synchronous retrieveSync or refuses with 501.
  function readInternal(c, logical, id, options = {}) {
    const context = internalContext(c);
    return traced(context, 'retrieve', logical, id, { sync: true }, undefined, () =>
      readRecord(context, logical, id, options),
    );
  }
  function readRecord(context, logical, id, { unmask = false, partitionId, ...getOptions } = {}) {
    const mapping = store.resolveMapping(logical);
    return store.get(mapping.logicalName, id, context.identity ?? {}, {
      ...getOptions,
      ...(partitionId === undefined ? {} : { partitionId }),
      readRow: (key) => {
        const virtual = handlers.virtualProviders?.readSync(context, mapping.logicalName, { single: true, id: key });
        return virtual
          ? (virtual.rows[0] ?? null)
          : store.get(mapping.logicalName, key, context.identity ?? {}, {
              skipPluginRead: true,
              ...(partitionId === undefined ? {} : { partitionId }),
            });
      },
      project: (row) =>
        projectInternal(context, mapping.logicalName, withComputedInPlace(mapping, row), { unmask, single: true }),
    });
  }
  // The computed (calculated and formula) columns of a read copy, computed from the stored row: every one when the copy is
  // the stored row's clone, else only those the copy carries.
  function withComputedInPlace(mapping, row, stored = row) {
    const computed = store.computedColumns(mapping.logicalName);
    if (!computed || !stored) return row;
    const read = store.withComputed(mapping.logicalName, [stored])[0];
    for (const column of computed.keys()) if (stored === row || Object.hasOwn(row, column)) row[column] = read[column];
    return row;
  }
  /** The project hooks over one stored-shape row (SDK RetrieveMultiple rows, whose computed columns the store query fills). */
  function projectInternal(c, logical, row, { unmask = false, single = false } = {}) {
    const context = internalContext(c),
      mapping = store.resolveMapping(logical);
    runHooks(
      'project',
      { ...context, unmasked: unmask === true, url: context.url ?? new URL('http://localhost/') },
      mapping,
      row,
      { single: single === true },
    );
    return row;
  }
  /** Column security and masking over a FetchXML answer's raw rows (root and link-entity aliases), as a Web API FetchXML read. */
  function projectFetchedInternal(c, logical, answer) {
    if (!security() || !Array.isArray(answer?.entities)) return answer;
    const context = internalContext(c),
      mapping = store.resolveMapping(logical),
      info = answer.columns ?? {};
    answer.entities = answer.entities.map((row) => maskFetched(context, mapping, row, info));
    return answer;
  }

  /**
   * The read projection every read route uses, exported for reads outside the Web API (SDK Retrieve and
   * RetrieveMultiple): context { user, identity, url? }, logical, a row shaped as a Web API read; options
   * { select (column list kept, with the id), unmask (UnMaskedData), single (a Retrieve; false for RetrieveMultiple) }.
   * Applies computed columns, column security, then masking rules, in place, and returns the row.
   */
  function readProjection(context, logical, row, { select = null, unmask = false, single = true } = {}) {
    const mapping = store.resolveMapping(logical);
    if (store.computedColumns(mapping.logicalName)) {
      const rows = store.tableRows(mapping.logicalName);
      withComputedInPlace(mapping, row, rows[store.rowIndex(mapping, rows, row[mapping.idColumn])] ?? null);
    }
    if (Array.isArray(select)) {
      const keep = new Set([...select, mapping.idColumn]);
      for (const key of Object.keys(row)) if (!keep.has(key.split('@')[0])) delete row[key];
    }
    projectRow(
      { ...context, unmasked: unmask === true, url: context.url ?? new URL('http://localhost/') },
      mapping,
      row,
      [],
      single === true,
    );
    return row;
  }

  const handlers = {
    projectRow: readProjection,
    createInternal,
    updateInternal,
    removeInternal,
    associateInternal,
    disassociateInternal,
    readInternal,
    projectInternal,
    projectFetchedInternal,
    secureInternal,
    async handle(ctx) {
      checkQuery(ctx.url, { nativeSyntax: Boolean(ctx.dataverseHttpReader) });
      const mapping = mappingForSet(ctx.route.set);
      const c = {
        ...ctx,
        mapping,
        unmasked: ctx.url.searchParams.get('UnMaskedData') === 'true',
        include: ctx.prefer.annotations == null ? null : annotationMatcher(ctx.prefer.annotations),
        // Money formatted values carry the organization currency symbol, "$" when none is configured.
        formatter: createWebApiFormatter({
          store,
          identity: ctx.identity,
          metadata: readFieldsOf,
          formatting: {
            ...store.state.settings,
            currencySymbol: baseCurrency()?.currencysymbol ?? store.state.settings.currencySymbol ?? '$',
          },
        }),
      };
      if (isElastic(mapping)) {
        const alternate = ctx.route.key == null ? null : parseKey(ctx.route.key)?.alternate;
        const raw = ctx.url.searchParams.get('partitionId');
        const parameter = raw?.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : raw;
        c.partitionId =
          alternate?.partitionid ??
          (ctx.method === 'GET' || ctx.method === 'DELETE' ? parameter : ctx.body?.partitionid) ??
          null;
      }
      const operation = WEB_API_OPERATION[c.route.kind]?.[ctx.method] ?? String(ctx.method).toLowerCase();
      const tracing = store.traces?.enabled === true;
      const response = await traced(
        c,
        operation,
        mapping.logicalName,
        tracing ? routeRecordId(c.route) : null,
        { dispatch: true },
        tracing ? () => dispatchInput(c) : undefined,
        async (span) => {
          bypassEvents(span, c);
          const answer = await dispatch(c);
          dispatchAnswer(span, c, mapping, answer);
          return answer;
        },
      );
      if (isElastic(mapping) && ctx.method !== 'GET' && ctx.method !== 'DELETE' && response?.status < 400)
        response.headers = {
          ...response.headers,
          'x-ms-session-token': `mirage:${mapping.logicalName}:${store.state.rowVersion ?? 0}`,
        };
      return response;
    },
    // Unsubscribes the change log from the store; the API calls it when it closes.
    close: () => {
      changes.close();
      if (store.recordPipeline === handlers) delete store.recordPipeline;
    },
  };
  // The organization's internal write and read entries, for callers that hold only the store (the SDK bridge of a CLR
  // plug-in, the flow Dataverse connector, the portal /_api and forms). One organization owns a store.
  store.recordPipeline = handlers;
  return handlers;
}
