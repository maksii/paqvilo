// SOAP Organization service (/XRMServices/2011/Organization.svc/web) answered by the record handlers. Execute carries
// the message; the seven body operations other clients send are accepted too. Each message becomes Web API calls on
// api.records.handle and its result is encoded back. A DataError is a fault whose ErrorCode is the signed inner code.
// Bearer checks and the HTTP socket belong to the router, which passes the resolved user, caller and identity.
import { DataError } from './data-error.mjs';
import { bypassStepIds as parseBypassStepIds } from './plugin-bypass.mjs';
import { assertPluginMessageAdmission } from './plugin-message-admission.mjs';
import { xmlEscapeAttribute } from './fetchxml-engine.mjs';
import {
  NS,
  decodeValue,
  encodeValue,
  envelope,
  fault,
  parseEnvelope,
  assertSoapQueryProperties,
  decodeColumnSet,
} from './dataverse-soap-xml.mjs';
import { fromQueryByAttribute, toFetchXml, toSdkQuery, toSdkValue } from './dataverse-soap-query.mjs';
import { dataverseError, parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';
import { privilegeDeniedError } from './dataverse-security.mjs';
import { fieldKind } from './dataverse-values.mjs';
import { isExactNumeric } from './exact-numeric.mjs';
import { FORMATTED } from './webapi-format.mjs';
import { metadataRequests } from './dataverse-soap-metadata.mjs';
import { relationshipsOf } from './dataverse-standard.mjs';
import { resultsOf } from './dataverse-soap-registry.mjs';
import { associationRequestBinding } from './plugin-association.mjs';
import { captureSdkResponseAsync } from './plugin-response.mjs';
import { soapSdkResults } from './dataverse-soap-sdk-values.mjs';
import { withPluginRequestTag } from './plugin-request-tag.mjs';

const ANNOTATIONS = 'odata.include-annotations="*"';
// ExecuteMultiple faults before running anything past this many requests (SDK docs: "typical" 1,000; a deployment can set its own).
const MAX_BATCH = 1000;
// Same roles as the HTTP bypass header (dataverse-api.mjs BYPASS_ROLES).
const BYPASS_ROLES = new Set(['System Administrator']);
const RETURN_REPRESENTATION = 'return=representation';
const BODY_OPERATIONS = new Set([
  'Create',
  'Retrieve',
  'RetrieveMultiple',
  'Update',
  'Delete',
  'Associate',
  'Disassociate',
]);
const BODY_RESULTS = { Create: 'CreateResult', Retrieve: 'RetrieveResult', RetrieveMultiple: 'RetrieveMultipleResult' };
const LOOKUP_NAME = '@Microsoft.Dynamics.CRM.lookuplogicalname';
const ANNOTATION = (term) => `@Microsoft.Dynamics.CRM.${term}`;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const HEX = /^0x[0-9a-f]+$/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });
const esc = (value) => xmlEscapeAttribute(String(value));
const plain = (name, text) => `<${name}>${esc(text)}</${name}>`;
const refOf = (value) => (value !== null && typeof value === 'object' ? value.id : value) ?? undefined;
const intOrNull = (text) => (text == null ? null : Number(text));
const num = (value) => (value == null ? null : Number(value));
const guid = (value) => ({ type: 'guid', value: value ?? null });
const setOf = (api, logical) => api.store.resolveMapping(logical).entitySet;
const mappingOf = (api, logical) => api.store.resolveMapping(logical);
const primaryOf = (api, logical) => {
  try {
    return api.store.resolveMapping(logical).idColumn;
  } catch {
    return null;
  }
};

// ---- Reading the request tree (dataverse-soap-xml nodes: { ns, name, attrs, children, text, scope })
const kid = (node, ns, name) => node?.children.find((child) => child.ns === ns && child.name === name);
const kids = (node, ns, name) => kid(node, ns, name)?.children ?? [];
const isNilNode = (node) =>
  node.attrs.some((a) => a.ns === NS.i && a.name === 'nil' && ['true', '1'].includes(a.value));
const kidText = (node, ns, name) => {
  const child = kid(node, ns, name);
  return child && !isNilNode(child) ? child.text.trim() : null;
};
// Local-name match, for the few elements whose namespace the SDK does not fix in these tables.
const localText = (node, name) => node?.children.find((child) => child.name === name)?.text.trim() ?? null;
const operatorOf = (text) => (text == null ? null : /^\d+$/.test(text) ? Number(text) : text);

function typeKey(node) {
  const qname = node.attrs.find((a) => a.ns === NS.i && a.name === 'type')?.value;
  if (qname == null) return null;
  const colon = qname.indexOf(':');
  const prefix = colon < 0 ? '' : qname.slice(0, colon);
  const name = qname.slice(colon + 1);
  const uri = node.scope.get(prefix) ?? '';
  const canonicalPrefix = Object.keys(NS).find((key) => NS[key] === uri) ?? prefix;
  return { key: `${canonicalPrefix}:${name}`, name, uri };
}

// OrganizationRequestCollection is xrm/2011 in the Web API docs, xrm/2012 in the SDK's ExecuteMultiple and
// possibly xrm/7.1 for ExecuteTransaction. The SDK's prefix is arbitrary, so the match is by namespace URI and local name.
const REQUEST_COLLECTION_URIS = new Set([NS.a, NS.l, NS.o]);

function valueOf(node) {
  if (!node || isNilNode(node)) return null;
  const type = typeKey(node);
  if (type?.name === 'OrganizationRequestCollection' && REQUEST_COLLECTION_URIS.has(type.uri)) {
    return { type: 'Requests', items: node.children.map(requestOf) };
  }
  switch (type?.key) {
    case 'a:QueryExpression':
      return { type: 'QueryExpression', model: queryModel(node) };
    case 'a:QueryByAttribute':
      return { type: 'QueryByAttribute', model: byAttributeModel(node) };
    case 'a:FetchExpression':
      return { type: 'Fetch', xml: kidText(node, NS.a, 'Query') ?? '' };
    default:
      return decodeValue(node);
  }
}

// An OrganizationRequest (Execute's request, or one item of a collection): the message name and its Parameters.
// The generic OrganizationRequest names its message in RequestName; typed requests carry it in their type name.
function requestOf(node) {
  assertSoapQueryProperties(node, 'OrganizationRequest', { RequestId: 'object' });
  const type = typeKey(node);
  const params = new Map();
  for (const pair of kids(node, NS.a, 'Parameters'))
    params.set(kidText(pair, NS.b, 'key'), valueOf(kid(pair, NS.b, 'value')));
  const name =
    type?.name === 'OrganizationRequest'
      ? kidText(node, NS.a, 'RequestName')
      : (type?.name ?? node.name).replace(/Request$/, '');
  return { name, params };
}

// Body operations: the SDK element children are named after the parameters, so they are mapped to the Execute names.
function bodyRequest(name, node) {
  const get = (local) => valueOf(node.children.find((child) => child.name === local));
  const reference = (logical, id) => ({
    type: 'EntityReference',
    logicalName: logical?.value ?? null,
    id: id?.value ?? null,
  });
  const params = new Map();
  switch (name) {
    case 'Create':
    case 'Update':
      params.set('Target', get('entity'));
      break;
    case 'Retrieve':
      params.set('Target', reference(get('entityName'), get('id')));
      params.set('ColumnSet', decodeColumnSet(node.children.find((child) => child.name === 'columnSet')));
      break;
    case 'RetrieveMultiple':
      params.set('Query', get('query'));
      break;
    case 'Delete':
      params.set('Target', reference(get('entityName'), get('id')));
      break;
    case 'Associate':
    case 'Disassociate': {
      params.set('Target', reference(get('entityName'), get('entityId')));
      const relationship = node.children.find((child) => child.name === 'relationship');
      params.set('Relationship', { type: 'Relationship', schemaName: localText(relationship, 'SchemaName') });
      const related = node.children.find((child) => child.name === 'relatedEntities');
      params.set('RelatedEntities', {
        type: 'EntityReferenceCollection',
        values: (related?.children ?? []).map((item) => ({
          type: 'EntityReference',
          logicalName: localText(item, 'LogicalName'),
          id: localText(item, 'Id'),
        })),
      });
      break;
    }
    default:
      break;
  }
  return { name, params };
}

function criteriaOf(node) {
  if (!node || isNilNode(node)) return { filterOperator: 'And', conditions: [], filters: [] };
  return {
    filterOperator: kidText(node, NS.a, 'FilterOperator') ?? 'And',
    conditions: kids(node, NS.a, 'Conditions').map(conditionOf),
    filters: kids(node, NS.a, 'Filters').map(criteriaOf),
    filterHint: kidText(node, NS.a, 'FilterHint'),
    isQuickFindFilter: ['true', '1'].includes(kidText(node, NS.a, 'IsQuickFindFilter')),
    anyAllFilterLinkEntity:
      kid(node, NS.a, 'AnyAllFilterLinkEntity') && !isNilNode(kid(node, NS.a, 'AnyAllFilterLinkEntity'))
        ? linkOf(kid(node, NS.a, 'AnyAllFilterLinkEntity'))
        : null,
  };
}

function conditionOf(node) {
  return {
    entityName: kidText(node, NS.a, 'EntityName'),
    attributeName: kidText(node, NS.a, 'AttributeName'),
    operator: operatorOf(kidText(node, NS.a, 'Operator')),
    values: kids(node, NS.a, 'Values').map((item) => valueOf(item)),
    compareColumns: ['true', '1'].includes(kidText(node, NS.a, 'CompareColumns')),
  };
}

const ordersOf = (node) =>
  kids(node, NS.a, 'Orders').map((order) => {
    assertSoapQueryProperties(order, 'OrderExpression', { Alias: 'string' });
    return {
      attributeName: kidText(order, NS.a, 'AttributeName'),
      entityName: kidText(order, NS.a, 'EntityName'),
      orderType: operatorOf(kidText(order, NS.a, 'OrderType')),
    };
  });

function columnSetOf(node, name = 'ColumnSet') {
  const set = kid(node, NS.a, name) ?? (name === 'Columns' ? kid(node, NS.a, 'ColumnSet') : null);
  return set ? decodeColumnSet(set) : undefined;
}

function pageInfoOf(node) {
  const page = kid(node, NS.a, 'PageInfo');
  if (!page) return undefined;
  return {
    count: intOrNull(kidText(page, NS.a, 'Count')),
    pageNumber: intOrNull(kidText(page, NS.a, 'PageNumber')),
    pagingCookie: kidText(page, NS.a, 'PagingCookie'),
    returnTotalRecordCount: ['true', '1'].includes(kidText(page, NS.a, 'ReturnTotalRecordCount')),
  };
}

function linkOf(node) {
  assertSoapQueryProperties(node, 'LinkEntity', { ForceSeek: 'string' });
  return {
    linkFromEntityName: kidText(node, NS.a, 'LinkFromEntityName'),
    linkFromAttributeName: kidText(node, NS.a, 'LinkFromAttributeName'),
    linkToEntityName: kidText(node, NS.a, 'LinkToEntityName'),
    linkToAttributeName: kidText(node, NS.a, 'LinkToAttributeName'),
    joinOperator: operatorOf(kidText(node, NS.a, 'JoinOperator')) ?? 'Inner',
    entityAlias: kidText(node, NS.a, 'EntityAlias'),
    columns: columnSetOf(node, 'Columns'),
    linkCriteria: criteriaOf(kid(node, NS.a, 'LinkCriteria')),
    linkEntities: kids(node, NS.a, 'LinkEntities').map(linkOf),
    orders: ordersOf(node),
  };
}

function queryModel(node) {
  assertSoapQueryProperties(node, 'QueryExpression', { ForceSeek: 'string', SubQueryExpression: 'object' });
  return {
    entityName: kidText(node, NS.a, 'EntityName'),
    columnSet: columnSetOf(node),
    criteria: criteriaOf(kid(node, NS.a, 'Criteria')),
    linkEntities: kids(node, NS.a, 'LinkEntities').map(linkOf),
    orders: ordersOf(node),
    distinct: ['true', '1'].includes(kidText(node, NS.a, 'Distinct')),
    noLock: ['true', '1'].includes(kidText(node, NS.a, 'NoLock')),
    dataSource: kidText(node, NS.a, 'DataSource') || undefined,
    queryHints: kidText(node, NS.a, 'QueryHints') || undefined,
    topCount: intOrNull(kidText(node, NS.a, 'TopCount')),
    pageInfo: pageInfoOf(node),
  };
}

function byAttributeModel(node) {
  return {
    entityName: kidText(node, NS.a, 'EntityName'),
    attributes: kids(node, NS.a, 'Attributes').map((item) => item.text.trim()),
    values: kids(node, NS.a, 'Values').map((item) => valueOf(item)),
    columnSet: columnSetOf(node),
    orders: ordersOf(node),
    distinct: ['true', '1'].includes(kidText(node, NS.a, 'Distinct')),
    noLock: ['true', '1'].includes(kidText(node, NS.a, 'NoLock')),
    dataSource: kidText(node, NS.a, 'DataSource') || undefined,
    topCount: intOrNull(kidText(node, NS.a, 'TopCount')),
    pageInfo: pageInfoOf(node),
  };
}

// ---- Identity: the router's user and caller, or the SOAP CallerId / CallerObjectId impersonation
function actingAs(c, api, headers) {
  const objectId = headers.CallerObjectId;
  const byId = headers.CallerId;
  if (!objectId && !byId) return { user: c.user, caller: c.caller, identity: c.identity };
  const { principals } = api;
  if (!principals.canImpersonate(c.caller))
    throw privilegeDeniedError(c.caller, 'prvActOnBehalfOfAnotherUser', 'systemuser');
  const user = objectId ? principals.byObjectId(objectId) : principals.byId(byId);
  if (!user) throw invalid('Invalid argument.');
  if (user.isdisabled === true)
    throw new DataError(`The specified user(Id = ${user.systemuserid}) is disabled.`, 401, 'Disabled', {
      innerCode: '0x80040225',
    });
  return {
    user,
    caller: c.caller,
    identity: {
      ...c.identity,
      id: user.systemuserid,
      systemUserId: user.systemuserid,
      businessUnitId: refOf(user.businessunitid),
      dataverse: { ...c.identity?.dataverse, accessMode: user.accessmode, callerId: c.caller.systemuserid },
    },
  };
}

// ---- Web API calls: each message is one call on the record handlers, with the router's context shape
async function web(
  s,
  method,
  path,
  {
    body,
    query = {},
    prefer = '',
    headers = {},
    sdkQuery,
    sdkColumns,
    sdkTarget,
    sdkCreateId,
    sdkOperation,
    sdkEntity,
  } = {},
) {
  const url = new URL(`/api/data/${s.version}/${path}`, s.origin);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const route = parseDataverseRoute(url.pathname);
  if (!route || route.kind === 'unknown' || route.kind === 'invalid')
    throw invalid(`The SOAP message addressed an unknown resource '${path}'.`, '0x8006088a');
  const call = (sdkResponseToken) =>
    s.api.records.handle({
      method,
      route,
      url,
      origin: s.origin,
      version: route.version,
      prefer: parsePrefer(prefer),
      headers: {
        prefer,
        ...(s.suppressDuplicateDetection === undefined
          ? {}
          : { 'mscrm.suppressduplicatedetection': String(s.suppressDuplicateDetection) }),
        ...(method === 'GET' && s.sessionToken ? { 'mscrm.sessiontoken': s.sessionToken } : {}),
        ...headers,
      },
      body,
      user: s.user,
      caller: s.caller,
      identity: s.identity,
      requestId: s.requestId,
      bypassCustomPlugins: s.bypassCustomPlugins === true,
      bypassCustomAsync: s.bypassCustomAsync === true,
      bypassStepIds: s.bypassStepIds ?? [],
      systemParameters: s.systemParameters,
      sdkQuery,
      sdkColumns,
      sdkTarget,
      sdkCreateId,
      sdkResponseToken,
    });
  const result = sdkOperation ? await captureSoapResponse(s, sdkOperation, sdkEntity, call) : await call(undefined);
  if (result?.headers?.['x-ms-session-token']) s.responseSessionToken = result.headers['x-ms-session-token'];
  return result ?? { status: 204, headers: {} };
}
async function captureSoapResponse(s, operation, entity, execute) {
  const captured = await captureSdkResponseAsync(s.api.store, operation, entity, execute);
  s.sdkResults = captured.results;
  return captured.value;
}

// Lookup columns are set through their navigation (the relationship whose lookup is the column).
function lookupNav(store, mapping, attribute) {
  const relationships = relationshipsOf(store, mapping.logicalName, mapping.relationships);
  if (relationships[attribute]?.many === false) return attribute;
  return (
    Object.keys(relationships).find(
      (nav) => relationships[nav].many === false && relationships[nav].from === attribute,
    ) ?? attribute
  );
}

function jsonValue(v, name) {
  switch (v.type) {
    case 'string':
    case 'guid':
    case 'boolean':
    case 'base64':
      return v.value;
    case 'int':
    case 'decimal':
    case 'double':
    case 'Money':
    case 'OptionSetValue':
      return num(v.value);
    case 'long':
      return typeof v.value === 'string' ? v.value : num(v.value);
    case 'OptionSetValueCollection':
      return v.values.filter((item) => item != null).join(',');
    case 'dateTime':
      if (Number.isNaN(Date.parse(v.value)))
        throw invalid(`The value '${v.value}' is not a valid date-time for ${name}.`);
      return v.value;
    default:
      throw invalid(`Attribute ${name} has a value type '${v.type}' the simulator does not write.`);
  }
}

// Entity attributes as a Web API body: lookups become nav@odata.bind, everything else is a plain property.
function attributesJson(s, entity) {
  if (entity.relatedEntities?.length)
    throw new DataError(
      'SOAP Entity.RelatedEntities requires a qualified graph-write adapter.',
      501,
      'LocalSoapInputUnsupported',
    );
  const mapping = mappingOf(s.api, entity.logicalName);
  const out = {};
  for (const [name, value] of entity.attributes ?? []) {
    const nav = lookupNav(s.api.store, mapping, name);
    if (value?.type === 'EntityReference') {
      if (value.id == null && !value.keyAttributes?.size) out[`${nav}@odata.bind`] = null;
      else if (!value.logicalName) throw invalid(`The lookup ${name} names no entity.`, '0x80048d19');
      else out[`${nav}@odata.bind`] = `/${setOf(s.api, value.logicalName)}(${recordKey(s.api, value, 'lookup')})`;
    } else if (value == null) {
      const lookup =
        fieldKind(s.api.store.fieldDefinition(entity.logicalName, name, s.api.metadataFields)) === 'lookup';
      if (lookup) out[`${nav}@odata.bind`] = null;
      else out[name] = null;
    } else out[name] = jsonValue(value, name);
  }
  return out;
}

const idFromLocation = (location) => {
  const id = /\(([^()]+)\)$/.exec(location ?? '')?.[1];
  if (!id)
    throw new DataError('The service did not name the record it wrote.', 500, 'Unexpected', {
      innerCode: '0x80040216',
    });
  return id;
};

// Typed SOAP value for one column of a row. Lookups arrive separately (see entityFrom).
function typedValue(s, logical, key, value) {
  if (value == null) return null;
  if (isExactNumeric(value)) {
    return {
      type:
        fieldKind(s.api.store.fieldDefinition(logical, key, s.api.metadataFields)) === 'money' ? 'Money' : 'decimal',
      value: value.value,
    };
  }
  const kind = fieldKind(s.api.store.fieldDefinition(logical, key, s.api.metadataFields));
  if (kind === 'choice' && typeof value === 'number') return { type: 'OptionSetValue', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return { type: 'double', value };
    return value >= INT_MIN && value <= INT_MAX ? { type: 'int', value } : { type: 'long', value: String(value) };
  }
  if (value instanceof Date) return { type: 'dateTime', value }; // encoded by dateText, which rejects an invalid Date as a fault
  if (typeof value === 'string') {
    if (key === mappingOf(s.api, logical).idColumn && GUID.test(value)) return { type: 'guid', value };
    if (/date/.test(String(kind)) && /^\d{4}-\d{2}-\d{2}T/.test(value)) return { type: 'dateTime', value };
    return { type: 'string', value };
  }
  return { type: 'string', value: String(value) };
}

// A Web API row (annotations requested) as an SDK Entity.
function entityFrom(s, logical, row) {
  const attributes = new Map();
  const formattedValues = new Map();
  for (const [key, value] of Object.entries(row)) {
    if (key.includes('@')) continue;
    const lookupName = /^_.+_value$/.test(key) ? key.slice(1, -6) : null;
    const target = row[`${key}${LOOKUP_NAME}`];
    if (lookupName != null || target !== undefined) {
      const text = row[`${key}${FORMATTED}`];
      attributes.set(
        lookupName ?? key,
        value == null ? null : { type: 'EntityReference', logicalName: target ?? null, id: value, name: text ?? null },
      );
      continue;
    }
    attributes.set(key, typedValue(s, logical, key, value));
    const text = row[`${key}${FORMATTED}`];
    if (text !== undefined) formattedValues.set(key, text);
  }
  return {
    type: 'Entity',
    logicalName: logical,
    id: row[mappingOf(s.api, logical).idColumn] ?? null,
    attributes,
    formattedValues,
  };
}

function collectionFrom(s, logical, body) {
  const annotation = (term) => body[ANNOTATION(term)];
  return {
    type: 'EntityCollection',
    entityName: logical,
    entities: (body.value ?? []).map((row) => entityFrom(s, logical, row)),
    moreRecords: annotation('morerecords') === true,
    pagingCookie: annotation('fetchxmlpagingcookie') ?? null,
    totalRecordCount: annotation('totalrecordcount') ?? -1,
    totalRecordCountLimitExceeded: annotation('totalrecordcountlimitexceeded') === true,
    minActiveRowVersion: '-1',
  };
}

// The row id: the SDK Entity.Id, else the primary-key attribute the Target carries (SDK clients often set only that).
const requireId = (api, entity, what) => {
  const id =
    entity?.id ??
    (entity?.logicalName ? entity.attributes?.get(mappingOf(api, entity.logicalName).idColumn)?.value : null);
  if (!id) throw invalid(`The ${what} names no record Id.`);
  return id;
};
const recordKey = (api, target, what) =>
  target?.keyAttributes?.size ? keyPredicate(target) : requireId(api, target, what);
const partitionQuery = (s) => (s.partitionId == null ? {} : { partitionId: s.partitionId });

async function createRow(s, entity) {
  const result = await web(s, 'POST', setOf(s.api, entity.logicalName), {
    body: attributesJson(s, entity),
    sdkCreateId: entity.id,
    sdkOperation: 'create',
    sdkEntity: entity.logicalName,
  });
  return idFromLocation(result.headers?.['OData-EntityId']);
}

async function retrieveRow(s, target, columnSet) {
  if (columnSet === null)
    throw new DataError(
      'A nil SOAP Retrieve ColumnSet requires a separately qualified input adapter.',
      501,
      'LocalSoapInputUnsupported',
    );
  const select =
    columnSet && !columnSet.allColumns
      ? { $select: columnSet.columns?.length ? columnSet.columns.join(',') : primaryOf(s.api, target.logicalName) }
      : {};
  const result = await web(s, 'GET', `${setOf(s.api, target.logicalName)}(${recordKey(s.api, target, 'Retrieve')})`, {
    query: { ...select, ...partitionQuery(s), ...(s.unmask ? { UnMaskedData: 'true' } : {}) },
    prefer: ANNOTATIONS,
    sdkColumns: columnSet
      ? { allColumns: columnSet.allColumns === true, columns: [...(columnSet.columns ?? [])] }
      : undefined,
    sdkTarget: toSdkValue(target),
    sdkOperation: 'retrieve',
    sdkEntity: target.logicalName,
  });
  return entityFrom(s, target.logicalName, result.body);
}

async function retrieveMany(s, query) {
  const model = query.type === 'QueryByAttribute' ? fromQueryByAttribute(query.model) : query.model;
  const fetchXml =
    query.type === 'Fetch' ? query.xml : toFetchXml(model, { primaryIdOf: (name) => primaryOf(s.api, name) });
  const logical =
    query.type === 'Fetch' ? /<entity\b[^>]*?\bname\s*=\s*["']([^"']+)["']/i.exec(fetchXml)?.[1] : model.entityName;
  if (!logical) throw invalid('The query names no entity.');
  const result = await web(s, 'GET', setOf(s.api, logical), {
    query: { fetchXml, ...(s.unmask ? { UnMaskedData: 'true' } : {}) },
    prefer: ANNOTATIONS,
    sdkQuery: query.type === 'Fetch' ? undefined : toSdkQuery(query.model, query.type),
    sdkOperation: 'retrievemultiple',
    sdkEntity: logical,
  });
  return collectionFrom(s, logical, result.body);
}

async function updateRow(s, entity) {
  await web(s, 'PATCH', `${setOf(s.api, entity.logicalName)}(${recordKey(s.api, entity, 'Update')})`, {
    body: attributesJson(s, entity),
    headers: { 'if-match': '*' },
    sdkOperation: 'update',
    sdkEntity: entity.logicalName,
  });
}

async function deleteRow(s, target) {
  await web(s, 'DELETE', `${setOf(s.api, target.logicalName)}(${recordKey(s.api, target, 'Delete')})`, {
    query: partitionQuery(s),
    sdkOperation: 'delete',
    sdkEntity: target.logicalName,
  });
}

// Alternate-key addressing: the Target's KeyAttributes as name='value' pairs.
function keyPredicate(target) {
  const pairs = [...(target.keyAttributes ?? [])];
  if (!pairs.length) throw invalid("Upsert needs the Target's Id or its key attributes.");
  return pairs
    .map(([name, item]) => {
      const value = item?.value ?? item;
      const literal = ['guid', 'int', 'long', 'decimal', 'double', 'boolean', 'dateTime'].includes(item?.type)
        ? String(value)
        : `'${String(value).replaceAll("'", "''")}'`;
      return `${name}=${literal}`;
    })
    .join(',');
}

async function upsertRow(s, target) {
  const mapping = mappingOf(s.api, target.logicalName);
  const key = target.id ? target.id : keyPredicate(target);
  const result = await web(s, 'PATCH', `${mapping.entitySet}(${key})`, {
    body: attributesJson(s, target),
    prefer: RETURN_REPRESENTATION,
  });
  return { created: result.status === 201, id: result.body?.[mapping.idColumn] ?? null };
}

async function relate(s, target, relationship, related, remove) {
  const parameters = {
    Target: {
      $type: 'EntityReference',
      logicalName: target?.logicalName,
      id: requireId(s.api, target, 'Associate'),
      name: target?.name ?? null,
    },
    Relationship: {
      $type: 'Relationship',
      schemaName: relationship?.schemaName,
      primaryEntityRole: relationship?.primaryEntityRole ?? null,
    },
    RelatedEntities: {
      $type: 'EntityReferenceCollection',
      values: (related?.values ?? []).map((ref) => ({
        $type: 'EntityReference',
        logicalName: ref.logicalName,
        id: ref.id,
        name: ref.name ?? null,
      })),
    },
  };
  const binding = associationRequestBinding(s.api.store, parameters, s.identity, { navigationFallback: true });
  const url = new URL(
    `/api/data/${s.version}/${binding.mapping.entitySet}(${binding.id})/${binding.navigation}/$ref`,
    s.origin,
  );
  const context = {
    method: remove ? 'DELETE' : 'POST',
    route: parseDataverseRoute(url.pathname),
    url,
    origin: s.origin,
    version: s.version,
    prefer: parsePrefer(''),
    headers: {},
    user: s.user,
    caller: s.caller,
    identity: s.identity,
    requestId: s.requestId,
    bypassCustomPlugins: s.bypassCustomPlugins === true,
    bypassCustomAsync: s.bypassCustomAsync === true,
    bypassStepIds: s.bypassStepIds ?? [],
    systemParameters: s.systemParameters,
  };
  const write = (sdkResponseToken) =>
    s.api.records[remove ? 'disassociateInternal' : 'associateInternal'](
      context,
      binding.entity,
      binding.id,
      binding.navigation,
      binding.related.values.map((ref) => ref.id),
      {
        associationParameters: parameters,
        writeOptions: { sdkResponseToken, ...(s.partitionId == null ? {} : { partitionId: s.partitionId }) },
      },
    );
  // One SOAP message has one RelatedEntities collection and one atomic main
  // operation, even when a later member or PostOperation step refuses it.
  await captureSoapResponse(s, remove ? 'disassociate' : 'associate', binding.entity, (token) => {
    const atomic = () =>
      s.api.runAtomic ? s.api.runAtomic(() => write(token)) : s.api.store.transact(() => write(token));
    return s.api.change ? s.api.change(atomic) : atomic();
  });
}

// ---- Messages: each returns { name, responseType, namespace, results: Map of typed values }
const reply = (name, results = new Map(), namespace = NS.a) => ({
  name,
  responseType: `${name}Response`,
  namespace,
  results,
});

// BypassCustomPluginExecution (a request parameter, per item) needs the privilege the HTTP header needs.
function bypassed(s, params) {
  const plugins = params.get('BypassCustomPluginExecution');
  const businessLogic = params.get('BypassBusinessLogicExecution');
  const bypassStepIds = parseBypassStepIds(s.api.store, params.get('BypassBusinessLogicExecutionStepIds')?.value);
  if (plugins && plugins.type !== 'boolean') throw invalid('BypassCustomPluginExecution requires a Boolean value.');
  if (businessLogic && businessLogic.type !== 'string')
    throw invalid('BypassBusinessLogicExecution requires a String value.');
  const logic = String(businessLogic?.value ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (logic.some((value) => !['customsync', 'customasync'].includes(value)))
    throw invalid('BypassBusinessLogicExecution accepts CustomSync and CustomAsync.');
  const { principals } = s.api;
  const held = (privilege) =>
    principals.privileges(s.caller).has(privilege) ||
    principals.roles(s.caller).some((role) => BYPASS_ROLES.has(role.name));
  if (plugins?.value === true && !held('prvBypassCustomPlugins'))
    throw privilegeDeniedError(s.caller, 'prvBypassCustomPlugins', 'systemuser');
  if ((logic.length || bypassStepIds.length) && !held('prvBypassCustomBusinessLogic'))
    throw privilegeDeniedError(s.caller, 'prvBypassCustomBusinessLogic', 'systemuser');
  return {
    ...s,
    bypassCustomPlugins: plugins?.value === true || logic.includes('customsync'),
    bypassCustomAsync: logic.includes('customasync'),
    bypassStepIds,
    systemParameters: Object.fromEntries(
      ['BypassCustomPluginExecution', 'BypassBusinessLogicExecution', 'BypassBusinessLogicExecutionStepIds']
        .filter((key) => params.has(key))
        .map((key) => [key, params.get(key).value]),
    ),
  };
}

function runRequest(base, request) {
  const tagged = request.params.has('tag') ? { tag: request.params.get('tag')?.value ?? null } : {};
  if (request.params.has('tag') && request.params.get('tag')?.type !== 'string')
    throw invalid('tag requires a String value.');
  return withPluginRequestTag(base.api.store, tagged, () => runRequestCore(base, request));
}
async function runRequestCore(base, { name, params }) {
  const inputs = {
    Create: ['Target'],
    Update: ['Target', 'ConcurrencyBehavior'],
    Delete: ['Target'],
    Retrieve: ['Target', 'ColumnSet'],
    RetrieveMultiple: ['Query'],
    Associate: ['Target', 'Relationship', 'RelatedEntities'],
    Disassociate: ['Target', 'Relationship', 'RelatedEntities'],
    Upsert: ['Target'],
    Assign: ['Target', 'Assignee'],
    SetState: ['EntityMoniker', 'State', 'Status'],
  }[name];
  const optional = [
    'tag',
    'partitionId',
    'SessionToken',
    'BypassCustomPluginExecution',
    'BypassBusinessLogicExecution',
    'BypassBusinessLogicExecutionStepIds',
    'SuppressDuplicateDetection',
    ...(['Retrieve', 'RetrieveMultiple'].includes(name) ? ['UnMaskedData'] : []),
  ];
  if (inputs)
    for (const key of params.keys())
      if (!inputs.includes(key) && !optional.includes(key))
        throw new DataError(`Unsupported SOAP ${name} request parameter: ${key}`, 501, 'LocalSoapInputUnsupported');
  for (const key of ['partitionId', 'SessionToken'])
    if (params.get(key) != null && params.get(key).type !== 'string') throw invalid(`${key} requires a String value.`);
  if (params.get('UnMaskedData') != null && params.get('UnMaskedData').type !== 'boolean')
    throw invalid('UnMaskedData requires a Boolean value.');
  const suppression = params.get('SuppressDuplicateDetection');
  if (params.has('SuppressDuplicateDetection')) {
    if (!['Create', 'Update'].includes(name))
      throw new DataError(
        'SuppressDuplicateDetection is supported only for Create and Update.',
        501,
        'LocalSoapInputUnsupported',
      );
    if (suppression?.type !== 'boolean' || typeof suppression.value !== 'boolean')
      throw invalid('SuppressDuplicateDetection requires a Boolean value.');
  }
  // UnMaskedData: request["UnMaskedData"] = true asks the clear value of masked columns.
  const unmask = [true, 'true'].includes(params.get('UnMaskedData')?.value);
  const s = {
    ...bypassed(base, params),
    partitionId: params.get('partitionId')?.value,
    sessionToken: params.get('SessionToken')?.value,
    unmask,
    suppressDuplicateDetection: suppression?.value,
  };
  const writeReply = (results = new Map()) => {
    if (s.sdkResults !== undefined) results = soapSdkResults(s.sdkResults);
    if (s.responseSessionToken) results.set('x-ms-session-token', { type: 'string', value: s.responseSessionToken });
    return reply(name, results);
  };
  const p = (key) => params.get(key);
  assertPluginMessageAdmission(s.api.store, name, { ...s, params: Object.fromEntries(params) });
  switch (name) {
    case 'Create': {
      const id = await createRow(s, p('Target'));
      return writeReply(new Map([['id', guid(id)]]));
    }
    case 'Retrieve': {
      const row = await retrieveRow(s, p('Target'), p('ColumnSet'));
      return reply(
        name,
        s.sdkResults === undefined
          ? new Map([['Entity', row]])
          : soapSdkResults(s.sdkResults, [['BusinessEntity', 'Entity']]),
      );
    }
    case 'RetrieveMultiple': {
      const rows = await retrieveMany(s, p('Query'));
      return reply(
        name,
        s.sdkResults === undefined
          ? new Map([['EntityCollection', rows]])
          : soapSdkResults(s.sdkResults, [['BusinessEntityCollection', 'EntityCollection']]),
      );
    }
    case 'Update':
      if (params.has('ConcurrencyBehavior'))
        throw new DataError(
          'Authored SDK ConcurrencyBehavior requires a qualified optimistic-concurrency execution adapter.',
          501,
          'LocalSoapInputUnsupported',
        );
      await updateRow(s, p('Target'));
      return writeReply();
    case 'Delete':
      await deleteRow(s, p('Target'));
      return reply(name, s.sdkResults === undefined ? new Map() : soapSdkResults(s.sdkResults));
    case 'Associate':
    case 'Disassociate':
      await relate(s, p('Target'), p('Relationship'), p('RelatedEntities'), name === 'Disassociate');
      return reply(name, s.sdkResults === undefined ? new Map() : soapSdkResults(s.sdkResults));
    case 'Upsert': {
      const target = p('Target');
      const { created, id } = await upsertRow(s, target);
      return writeReply(
        new Map([
          ['RecordCreated', { type: 'boolean', value: created }],
          ['Target', { type: 'EntityReference', logicalName: target.logicalName, id }],
        ]),
      );
    }
    case 'Assign': {
      const target = p('Target');
      const assignee = p('Assignee');
      await web(s, 'PATCH', `${setOf(s.api, target.logicalName)}(${requireId(s.api, target, 'Assign')})`, {
        headers: { 'if-match': '*' },
        body: {
          'ownerid@odata.bind': `/${setOf(s.api, assignee.logicalName)}(${requireId(s.api, assignee, 'Assign assignee')})`,
        },
      });
      return reply(name, new Map(), NS.g);
    }
    case 'SetState': {
      const moniker = p('EntityMoniker');
      const body = { statecode: num(p('State')?.value) };
      if (p('Status')?.value != null) body.statuscode = num(p('Status').value);
      await web(s, 'PATCH', `${setOf(s.api, moniker.logicalName)}(${requireId(s.api, moniker, 'SetState')})`, {
        headers: { 'if-match': '*' },
        body,
      });
      return reply(name, new Map(), NS.g);
    }
    case 'WhoAmI': {
      const dv = s.api.store.state.dataverse ?? {};
      return reply(
        name,
        new Map([
          ['UserId', guid(s.user.systemuserid)],
          ['BusinessUnitId', guid(refOf(s.user.businessunitid))],
          ['OrganizationId', guid(dv.organizationId ?? refOf(s.user.organizationid))],
        ]),
        NS.g,
      );
    }
    case 'RetrieveVersion':
      return reply(name, new Map([['Version', { type: 'string', value: s.api.settings?.version ?? '' }]]), NS.g);
    case 'RetrieveCurrentOrganization': {
      // OrganizationDetail (xrm/2014) members in DataContract order (alphabetical). Unmodelled string members are
      // nil; value-type members (Guid, enums) and Endpoints carry the Web API's values, since SDK clients cannot
      // deserialize a nil value type and read the published endpoints after connecting.
      const dv = s.api.store.state.dataverse ?? {};
      const settings = s.api.settings ?? {};
      const member = (name, text) => (text == null ? `<x14:${name} i:nil="true"/>` : plain(`x14:${name}`, text));
      const endpoint = (type, url) =>
        `<x14:KeyValuePairOfEndpointTypestringyDL0RVHi>${plain('b:key', type)}${plain('b:value', url)}</x14:KeyValuePairOfEndpointTypestringyDL0RVHi>`;
      const detail =
        `<b:value i:type="x14:OrganizationDetail">` +
        member('DatacenterId', settings.datacenterId ?? '00000000-0000-0000-0000-000000000000') +
        `<x14:Endpoints>` +
        endpoint('OrganizationService', `${s.origin}/XRMServices/2011/Organization.svc`) +
        endpoint('OrganizationDataService', `${s.origin}/XRMServices/2011/OrganizationData.svc`) +
        endpoint('WebApplication', `${s.origin}/`) +
        `</x14:Endpoints>` +
        member('EnvironmentId', dv.environmentId ?? settings.environmentId) +
        member('FriendlyName', dv.friendlyName ?? settings.friendlyName ?? '') +
        member('Geo', settings.geo) +
        member('OrganizationId', dv.organizationId ?? settings.organizationId ?? refOf(s.user.organizationid) ?? '') +
        plain('x14:OrganizationType', 'Default') +
        member('OrganizationVersion', dv.version ?? settings.version ?? '') +
        member('SchemaType', settings.schemaType) +
        plain('x14:State', 'Enabled') +
        member('TenantId', dv.tenantId ?? settings.tenantId) +
        member('UniqueName', dv.uniqueName ?? settings.uniqueName ?? '') +
        member('UrlName', settings.urlName) +
        `</b:value>`;
      return reply(
        name,
        new Map([
          [
            'Detail',
            {
              rawValueXml: `<a:KeyValuePairOfstringanyType><b:key>Detail</b:key>${detail}</a:KeyValuePairOfstringanyType>`,
            },
          ],
        ]),
        NS.g,
      );
    }
    case 'ExecuteMultiple':
    case 'ExecuteTransaction': {
      const collection = p('Requests')?.items ?? [];
      const settings = p('Settings')?.node;
      const transaction = name === 'ExecuteTransaction';
      if (!transaction && collection.length > MAX_BATCH) {
        throw invalid(`The ExecuteMultiple request has ${collection.length} requests; the maximum is ${MAX_BATCH}.`); // ponytail: fixed limit; unverified message text
      }
      const continueOnError = !transaction && ['true', '1'].includes(localText(settings, 'ContinueOnError'));
      const returnResponses = transaction
        ? p('ReturnResponses')?.value === true
        : ['true', '1'].includes(localText(settings, 'ReturnResponses'));
      const outcomes = await runMany(s, collection, { continueOnError, transaction });
      const items = outcomes
        .filter((o) => o.error || returnResponses)
        .map((o) => (transaction ? transactionItem(o) : multipleItem(o)));
      // Both collections are DataContract "OrganizationResponseCollection": xrm/7.1 for ExecuteTransaction, xrm/2012 for ExecuteMultiple.
      const collectionType = transaction ? 'o:OrganizationResponseCollection' : 'l:OrganizationResponseCollection';
      const value = {
        rawValueXml: `<a:KeyValuePairOfstringanyType><b:key>Responses</b:key><b:value i:type="${collectionType}">${items.join('')}</b:value></a:KeyValuePairOfstringanyType>`,
      };
      if (transaction) return reply(name, new Map([['Responses', value]]));
      // ExecuteMultipleResponse.IsFaulted: a fault in the batch is reported in the items, not as a SOAP fault.
      return reply(
        name,
        new Map([
          ['IsFaulted', { type: 'boolean', value: outcomes.some((o) => o.error) }],
          ['Responses', value],
        ]),
      );
    }
    default: {
      const extension = metadataRequests(s.api).get(name);
      if (extension) return extension(params, s);
      const generic = await registryRequest(s, name, params);
      if (generic) return generic;
      throw new DataError(`The message '${name}' is not simulated by the SOAP service.`, 501, 'NotImplemented', {
        innerCode: '0x80040216',
      });
    }
  }
}

// A registered Web API action or function named by RequestName (the generic OrganizationRequest). A request whose Target is an
// entity reference (or a reference collection) runs the operation bound to that table first, as the SDK's bound messages do;
// otherwise the unbound one runs. Actions read the body and functions the parameters, so both carry the values. An entity
// reference carries @odata.id and the typed entity keys, the shapes the record messages accept.
async function registryRequest(s, name, params) {
  const registry = s.api.registry;
  const bound = boundOf(s, params);
  const found = (kind, binding, entity) => registry?.find({ name, kind, binding, entity });
  const bindOp = bound
    ? (found('action', bound.binding, bound.entity) ?? found('function', bound.binding, bound.entity))
    : null;
  const op = bindOp ?? found('action', 'unbound') ?? found('function', 'unbound');
  if (!op) return null;
  const binding = bindOp ? bound.binding : 'unbound';
  const action = op.kind === 'action';
  const values = Object.fromEntries(
    [...params]
      .filter(
        ([key]) =>
          ![
            'BypassCustomPluginExecution',
            'BypassBusinessLogicExecution',
            'BypassBusinessLogicExecutionStepIds',
            'tag',
          ].includes(key),
      )
      .map(([key, value]) => [key, plainOf(s, value)]),
  );
  let target;
  let path = name;
  if (binding === 'entity') {
    const mapping = s.api.store.resolveMapping(bound.entity);
    const row = s.api.store.get(bound.entity, bound.id, s.identity, { skipPluginRead: true });
    if (!row)
      throw new DataError(`${bound.entity} With Id = ${bound.id} Does Not Exist`, 404, 'NotFound', { id: bound.id });
    target = { mapping, id: bound.id, row };
    path = `${mapping.entitySet}(${bound.id})/Microsoft.Dynamics.CRM.${name}`;
  } else if (binding === 'collection') {
    target = { mapping: s.api.store.resolveMapping(bound.entity) };
    path = `${target.mapping.entitySet}/Microsoft.Dynamics.CRM.${name}`;
  }
  const result = await op.handle({
    method: action ? 'POST' : 'GET',
    url: new URL(`/api/data/${s.version}/${path}`, s.origin),
    origin: s.origin,
    version: s.version,
    headers: {},
    body: values,
    params: values,
    target,
    user: s.user,
    caller: s.caller,
    identity: s.identity,
    requestId: s.requestId,
    bypassCustomPlugins: s.bypassCustomPlugins === true,
    bypassCustomAsync: s.bypassCustomAsync === true,
    bypassStepIds: s.bypassStepIds ?? [],
    systemParameters: s.systemParameters,
    api: s.api,
  });
  const { results, responseName } = resultsOf({
    api: s.api,
    registry,
    op,
    body: result?.body,
    entityOf: (logical, row) => entityFrom(s, logical, row),
  });
  return { name, responseType: responseName ?? 'OrganizationResponse', namespace: responseName ? NS.g : NS.a, results };
}

// The bound table of a request: an entity reference binds to its row's table (binding "entity"), a reference collection to
// its table's collection operations (binding "collection"). Null when Target is absent or names no table.
function boundOf(s, params) {
  const target = params.get('Target');
  const first = target?.type === 'EntityReferenceCollection' ? target.values[0] : target;
  const logical = first?.logicalName ? primaryTable(s.api, first.logicalName) : null;
  if (!logical) return null;
  // A reference without an Id (an alternate-key reference) cannot name a row: the request runs the unbound operation.
  if (target?.type === 'EntityReference')
    return target.id ? { binding: 'entity', entity: logical, id: target.id } : null;
  return target?.type === 'EntityReferenceCollection' ? { binding: 'collection', entity: logical } : null;
}
// The table a logical name or entity set names; null for a name that is no table (an unbound operation's Target may be anything).
const primaryTable = (api, name) => {
  try {
    return api.store.resolveMapping(name).logicalName;
  } catch {
    return null;
  }
};

// SOAP parameter value to the plain JSON a registry op reads (the Web API body shape: lookups as @odata.id, rows as columns).
function plainOf(s, value) {
  const { api } = s;
  if (value?.type === 'EntityReference') {
    const mapping = api.store.resolveMapping(value.logicalName);
    return {
      '@odata.id': `${mapping.entitySet}(${value.id})`,
      '@odata.type': `Microsoft.Dynamics.CRM.${mapping.logicalName}`,
      [mapping.idColumn]: value.id,
    };
  }
  if (value?.type === 'OptionSetValue') return { Value: value.value };
  if (value?.type === 'EntityReferenceCollection')
    return value.values.map((r) => plainOf(s, { ...r, type: 'EntityReference' }));
  if (value?.type === 'Entity')
    return { ...attributesJson(s, value), '@odata.type': `Microsoft.Dynamics.CRM.${value.logicalName}` };
  if (value?.type === 'EntityCollection') return { value: value.entities.map((e) => plainOf(s, e)) };
  if (value?.type === 'Array') return value.values;
  if (value?.type === 'Raw') return rawPlain(value.node);
  return value?.value ?? null;
}

// A complex request value this simulator has no typed decoder for: its children by name (repeated names are an array).
// The shape a registry handler reads from such a value is assumed.
function rawPlain(node) {
  if (isNilNode(node)) return null;
  if (!node.children.length) return node.text.trim();
  const names = new Set(node.children.map((c) => c.name));
  if (node.children.length > 1 && names.size === 1) return node.children.map(rawPlain);
  return Object.fromEntries(node.children.map((c) => [c.name, rawPlain(c)]));
}

// Each item runs in order. A transaction runs them as one isolated store transaction (runAtomic): the first failure
// rolls back every write and rewinds the change log, and the faulted index travels with the error.
async function runMany(s, items, { continueOnError, transaction }) {
  if (!transaction) return runEach(s, items, { continueOnError, transaction });
  return s.api.runAtomic(() => runEach(s, items, { continueOnError, transaction }));
}

async function runEach(s, items, { continueOnError, transaction }) {
  const outcomes = [];
  for (const [index, request] of items.entries()) {
    if (transaction && (request.name === 'ExecuteMultiple' || request.name === 'ExecuteTransaction')) {
      throw invalid('An ExecuteTransaction cannot contain another ExecuteMultiple or ExecuteTransaction.');
    }
    try {
      // An ExecuteMultipleRequest cannot invoke another; that item faults and the batch goes on as ContinueOnError says.
      if (!transaction && request.name === 'ExecuteMultiple')
        throw invalid('An ExecuteMultiple request cannot contain another ExecuteMultiple request.');
      outcomes.push({ index, response: await runRequest(s, request) });
    } catch (error) {
      if (transaction) {
        if (error && typeof error === 'object') error.faultedRequestIndex = index;
        throw error;
      }
      // Without ContinueOnError processing stops at the faulted item, which is still returned.
      outcomes.push({ index, error });
      if (!continueOnError) break;
    }
  }
  return outcomes;
}

const prefixOf = (namespace) => (namespace === NS.g ? 'g' : 'a');
// A raw value (rawValueXml) is a whole key/value pair already; every other value is encoded as its b:value.
const kvp = (key, valueXml) =>
  `<a:KeyValuePairOfstringanyType><b:key>${esc(key)}</b:key>${valueXml}</a:KeyValuePairOfstringanyType>`;
const resultsXml = (results) =>
  [...results].map(([key, value]) => value.rawValueXml ?? kvp(key, encodeValue('b:value', value))).join('');

// Typed fault members for one item or top-level fault (shared by ExecuteMultiple items and the SOAP fault).
function faultParts(error, c) {
  if (!(error instanceof DataError)) return { code: signed('0x80040216'), message: 'An unexpected error occurred.' };
  let hex = String(error.details?.innerCode ?? '');
  if (!HEX.test(hex))
    hex =
      error.code === 'NotFound'
        ? '0x80040217'
        : (dataverseError(error, { requestId: c.requestId, origin: c.origin }).body?.error?.code ?? '');
  return {
    code: signed(HEX.test(hex) ? hex : '0x80040216'),
    message: error.message || 'An unexpected error occurred.',
  };
}

// Signed 32-bit form of a Dataverse hex code (0x80040217 -> -2147220969).
function signed(hex) {
  const value = Number.parseInt(hex, 16);
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

// ExecuteMultipleResponseItem is xrm/2012: its members (Fault, RequestIndex, Response) are in that namespace too.
function multipleItem(o) {
  if (o.error) {
    const { code, message } = faultParts(o.error, {});
    return (
      `<l:ExecuteMultipleResponseItem><l:Fault><a:ErrorCode>${code}</a:ErrorCode><a:Message>${esc(message)}</a:Message></l:Fault>` +
      `<l:RequestIndex>${o.index}</l:RequestIndex><l:Response i:nil="true"/></l:ExecuteMultipleResponseItem>`
    );
  }
  const r = o.response;
  return (
    `<l:ExecuteMultipleResponseItem><l:Fault i:nil="true"/><l:RequestIndex>${o.index}</l:RequestIndex>` +
    `<l:Response i:type="${prefixOf(r.namespace)}:${r.responseType}"><a:ResponseName>${esc(r.name)}</a:ResponseName>` +
    `<a:Results>${resultsXml(r.results)}</a:Results></l:Response></l:ExecuteMultipleResponseItem>`
  );
}

function transactionItem(o) {
  const r = o.response;
  return (
    `<a:OrganizationResponse i:type="${prefixOf(r.namespace)}:${r.responseType}"><a:ResponseName>${esc(r.name)}</a:ResponseName>` +
    `<a:Results>${resultsXml(r.results)}</a:Results></a:OrganizationResponse>`
  );
}

// Execute response: the result type in the message's own namespace, with its results as key/value pairs.
function executeXml(result) {
  return (
    `<svc:ExecuteResponse><svc:ExecuteResult xmlns:r="${result.namespace}" i:type="r:${result.responseType}">` +
    `${plain('a:ResponseName', result.name)}<a:Results>${resultsXml(result.results)}</a:Results></svc:ExecuteResult></svc:ExecuteResponse>`
  );
}

// Body-operation response: the named result element, when the operation returns one.
function bodyXml(result) {
  const resultName = BODY_RESULTS[result.name];
  const key = { Create: 'id', Retrieve: 'Entity', RetrieveMultiple: 'EntityCollection' }[result.name];
  const value = result.results.has(key)
    ? result.results.get(key)
    : result.name === 'Create'
      ? guid('00000000-0000-0000-0000-000000000000')
      : null;
  const inner = resultName ? encodeValue(`svc:${resultName}`, value) : '';
  return `<svc:${result.name}Response>${inner}</svc:${result.name}Response>`;
}

function faultEnvelope(error, c, api) {
  const { code, message } = faultParts(error, c);
  const at = new Date(api.clock?.() ?? Date.now());
  return fault({
    errorCode: code,
    message,
    timestamp: (Number.isNaN(at.getTime()) ? new Date() : at).toISOString(),
    faultedRequestIndex: error?.faultedRequestIndex,
    errorDetails: error?.details?.bulkApiErrorDetails
      ? new Map([
          ['Plugin.BulkApiErrorDetails', { type: 'string', value: JSON.stringify(error.details.bulkApiErrorDetails) }],
        ])
      : new Map(),
  });
}

/**
 * Answers one SOAP request. `c` carries the router's resolved context: { method, headers, bodyText or bodyBuffer, user, caller, identity,
 * origin, version, requestId }. Returns { status, headers, body } with an XML body; faults are HTTP 500.
 */
export async function handleSoap(c, api) {
  const xml = (status, body) => ({ status, headers: { 'content-type': 'text/xml; charset=utf-8' }, body });
  if (c.method !== 'POST') {
    return {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: `The requested resource does not support http method '${c.method}'.`,
    };
  }
  try {
    // The router passes the raw body bytes; a caller with text already decoded passes bodyText instead.
    const bodyText = c.bodyText ?? (c.bodyBuffer ? Buffer.from(c.bodyBuffer).toString('utf8') : '');
    const parsed = parseEnvelope(bodyText);
    const s = {
      api,
      origin: c.origin,
      version: c.version ?? 'v9.2',
      requestId: c.requestId,
      ...actingAs(c, api, parsed.headers),
    };
    if (parsed.operation === 'Execute') {
      const request = kid(parsed.request, NS.svc, 'request');
      if (!request) throw invalid('Execute has no request element.');
      return xml(200, envelope(executeXml(await runRequest(s, requestOf(request)))));
    }
    if (!BODY_OPERATIONS.has(parsed.operation)) {
      throw new DataError(
        `The operation '${parsed.operation}' is not simulated by the SOAP service.`,
        501,
        'NotImplemented',
        { innerCode: '0x80040216' },
      );
    }
    return xml(200, envelope(bodyXml(await runRequest(s, bodyRequest(parsed.operation, parsed.request)))));
  } catch (error) {
    return xml(500, faultEnvelope(error, c, api));
  }
}
