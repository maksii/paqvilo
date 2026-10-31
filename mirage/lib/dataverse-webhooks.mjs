import { asyncMultipleJobParent, asynchronousParentChain } from './plugin-sdk-parent.mjs';
import { organizationRecord } from './organization-context.mjs';
import { recordHttpError, statusFromHttp } from './trace-store.mjs';
// Webhooks. A plug-in step whose eventhandler is a service endpoint with contract 8 (Webhook) POSTs the
// RemoteExecutionContext JSON to the endpoint URL, with the documented headers and authentication.
//
// LOOPBACK ONLY: Mirage contacts an endpoint only when its URL host is localhost, 127.0.0.0/8, ::1, or a name every address of
// which resolves to loopback (loopbackFetch). Any other URL is never contacted: the step records WEBHOOK_NOT_CONTACTED and the
// operation continues. A loopback endpoint that cannot be reached fails the step: a sync step fails the operation ("Endpoint
// unavailable"), an async step gets a Failed System Job. Redirects are refused: a loopback endpoint that answers 3xx fails the step instead of
// being re-POSTed to another host (loopbackFetch). Contracts 2 (Queue), 5 (Topic) and 6 (Queue Persistent) are sent to the message
// bus (message-bus.mjs) when a messaging provider is configured and providers.messaging.endpoints maps the endpoint; without a
// provider they are skipped. Every other contract (OneWay, Rest, TwoWay, Event Hub, Event Grid, ...) is not simulated.
//
// A synchronous step runs inside the operation and fails it when its post fails. On the asynchronous pipeline (every HTTP-driven write:
// data.mjs createRecordAsync) the post is awaited in process (send). On the synchronous SDK drive (a plug-in's own SDK call) the
// post runs on the synchronous I/O bridge (sync-io-bridge.mjs, a worker thread; sync). Asynchronous steps run after commit
// (plugin-async.mjs afterCommit).
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { syncIo } from './sync-io-bridge.mjs';
import { systemClock, systemIds } from './runtime-clock.mjs';
import { DataError } from './data-error.mjs';
import { messageNameOf } from './exported-plugins.mjs';
import { clrContext, recordToSdkEntity } from './plugin-clr.mjs';
import { imageAttributes } from './plugin-images.mjs';
import { PLATFORM_TYPES } from './dataverse-operation-contracts.mjs';
import { delegatedPluginParent } from './plugin-delegation.mjs';
import { bridgeTargetInputs, multipleMessage } from './plugin-single-multiple.mjs';
import { exactNumeric, stringifyExactJson } from './exact-numeric.mjs';

const LOOPBACK = /^(?:(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
const WEBHOOK_CONTRACT = 8;
const MAX_BODY = 256 * 1024; // above 256 KB four optional properties are removed and the size header is sent
const NS = 'http://schemas.microsoft.com/xrm/2011/Contracts';
const same = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
const lookup = (value) => (value !== null && typeof value === 'object' ? value.id : value) ?? null;

/** The hostname of a URL alone (null when it does not parse), so no path, query or credential reaches a diagnostic or the dashboard. */
export const hostnameOf = (text) => {
  try {
    return new URL(String(text)).hostname || null;
  } catch {
    return null;
  }
};

/** The one loopback guard: http or https to localhost, *.localhost, 127.0.0.0/8 or ::1. TriggerServiceEndpointCheck uses it too. */
export function isLoopbackUrl(text) {
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && LOOPBACK.test(url.hostname);
  } catch {
    return false;
  }
}

// A failed synchronous webhook shows the documented "Endpoint unavailable" error; the inner code is a guess.
const unavailable = () => new DataError('Endpoint unavailable', 400, 'InvalidRequest', { innerCode: '0x80040265' });

// Whether every address a URL's host resolves to is loopback (127.0.0.0/8 or ::1). localhost and IP literals answer without a
// lookup; any other name (*.localhost) is resolved, because a resolver may answer it with a routable address.
async function loopbackAddresses(text, lookup) {
  const host = new URL(text).hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)) return null;
  const addresses = await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => !/^127\./.test(address) && address !== '::1'))
    throw unavailable();
  return addresses;
}

/** The one outbound helper: throws (synchronously) for a non-loopback URL before any network call, rejects a host name that
 * resolves to any non-loopback address, pins the checked addresses for that connection, and refuses redirects.
 * `lookup` (default dns.promises.lookup) is injectable for tests. */
export function loopbackFetch(url, { lookup = dns.promises.lookup, ...init } = {}) {
  if (!isLoopbackUrl(url)) throw unavailable();
  return loopbackAddresses(String(url), lookup).then((addresses) =>
    addresses ? fetchAtAddresses(url, init, addresses) : fetch(url, { ...init, redirect: 'error' }),
  );
}

// Native fetch cannot accept a pinned DNS lookup without an external dispatcher. Only DNS-checked *.localhost names use
// this transport; literal addresses keep fetch. Keep the original URL for HTTP Host and HTTPS certificate/SNI checks.
function fetchAtAddresses(url, init, addresses) {
  const request = new Request(url, init);
  return new Promise((resolve, reject) => {
    const send = request.url.startsWith('https:') ? https.request : http.request;
    const outgoing = send(
      request.url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        signal: request.signal,
        lookup: (_host, options, done) =>
          options.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family),
      },
      (incoming) => {
        if ([301, 302, 303, 307, 308].includes(incoming.statusCode)) {
          incoming.resume();
          reject(new TypeError('fetch failed', { cause: new Error('Unexpected redirect') }));
          return;
        }
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2)
          headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        const empty = request.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
        let body = incoming;
        const decoders = new Map([
          ['gzip', createGunzip],
          ['deflate', createInflate],
          ['br', createBrotliDecompress],
        ]);
        const decode = decoders.get(headers.get('content-encoding'));
        if (decode && !empty) {
          body = decode();
          incoming.on('error', (error) => body.destroy(error));
          body.on('close', () => incoming.destroy());
          incoming.pipe(body);
        }
        if (empty) incoming.resume();
        const response = new Response(empty ? null : Readable.toWeb(body), {
          status: incoming.statusCode,
          statusText: incoming.statusMessage,
          headers,
        });
        Object.defineProperty(response, 'url', { value: request.url });
        resolve(response);
      },
    );
    outgoing.on('error', (error) => reject(request.signal.aborted ? request.signal.reason : error));
    if (request.body) {
      const body = Readable.fromWeb(request.body);
      body.on('error', (error) => outgoing.destroy(error));
      outgoing.on('close', () => body.destroy());
      body.pipe(outgoing);
    } else outgoing.end();
  });
}

// DataContract JSON: collections are {key, value} arrays and entities or references carry __type. Typed values follow the
// SDK's contract namespace; the money, option set and collection shapes are guesses.
const pairs = (object) => Object.entries(object ?? {}).map(([key, value]) => ({ key, value: dataContract(value) }));
const queryContracts = new Map(PLATFORM_TYPES.map((entry) => [entry[1].Name, entry]));
// The SDK wire codec uses camelCase and symbolic enums; derive the public
// property names and enum values from the same documented structural contracts
// used by the Web API metadata, rather than inventing a second operator table.
function queryContract(value, type) {
  const contract = queryContracts.get(type);
  if (!contract)
    throw new DataError(
      `The webhook query type ${type} has no structural contract.`,
      501,
      'LocalWebhookContextUnsupported',
    );
  const fields = new Set(['$type']);
  const result = {
    ...({
      ColumnSet: { AllColumns: false, Columns: [], AttributeExpressions: [] },
      FilterExpression: { AnyAllFilterLinkEntity: null, FilterOperator: 0, Conditions: [], Filters: [] },
      ConditionExpression: { CompareColumns: false, EntityName: null },
      OrderExpression: { Alias: null, EntityName: null },
      PagingInfo: { ReturnRecordCountLessThanMarv: false },
      QueryExpression: { Distinct: false, NoLock: false },
    }[type] ?? {}),
  };
  for (const [kind, property] of contract.slice(2)) {
    if (kind !== 'Property') continue;
    const field = property.Name[0].toLowerCase() + property.Name.slice(1);
    fields.add(field);
    let item = value[field];
    if (property.Name === 'Operator' || property.Name === 'FilterOperator') {
      fields.add('operatorName');
      item = value.operatorName ?? item;
    }
    if (property.Name === 'OrderType') {
      fields.add('descending');
      item = value.descending == null ? (item ?? 'Ascending') : value.descending ? 'Descending' : 'Ascending';
    }
    if (item === undefined) continue;
    const convert = (entry, declared) => {
      if (entry == null) return null;
      const name = declared.replace(/^mscrm\./, ''),
        spec = queryContracts.get(name);
      if (spec?.[0] === 'EnumType') {
        const member = spec
          .slice(2)
          .find(
            ([, attributes]) =>
              attributes.Name === entry || (typeof entry === 'number' && Number(attributes.Value) === entry),
          );
        if (!member) throw new DataError(`Unknown webhook query ${name} value.`, 501, 'LocalWebhookContextUnsupported');
        return Number(member[1].Value);
      }
      return name !== 'Object' && spec?.[0] === 'ComplexType' ? queryContract(entry, name) : dataContract(entry);
    };
    const collection = /^Collection\((.+)\)$/.exec(property.Type);
    result[property.Name] = collection
      ? item.map((entry) => convert(entry, collection[1]))
      : convert(item, property.Type);
  }
  for (const field of Object.keys(value))
    if (!fields.has(field))
      throw new DataError(
        `The webhook query property ${type}.${field} has no structural contract.`,
        501,
        'LocalWebhookContextUnsupported',
      );
  return result;
}
function dataContract(value, polymorphic = true) {
  if (value == null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map((item) => dataContract(item));
  const typed = (type, body) => ({ ...(polymorphic ? { __type: `${type}:${NS}` } : {}), ...body });
  switch (value.$type) {
    case 'Entity':
      return typed('Entity', {
        Attributes: pairs(value.attributes),
        EntityState: null,
        FormattedValues: pairs(value.formattedValues),
        Id: value.id ?? null,
        KeyAttributes: pairs(value.keyAttributes),
        LogicalName: value.logicalName,
        RelatedEntities: [],
        RowVersion: value.rowVersion ?? null,
      });
    case 'EntityReference':
      return typed('EntityReference', {
        Id: value.id,
        KeyAttributes: pairs(value.keyAttributes),
        LogicalName: value.logicalName,
        Name: value.name ?? null,
        RowVersion: value.rowVersion ?? null,
      });
    case 'EntityCollection':
      return typed('EntityCollection', {
        Entities: (value.entities ?? []).map((entity) => dataContract(entity, false)),
        EntityName: value.entityName ?? null,
        MinActiveRowVersion: value.minActiveRowVersion ?? null,
        MoreRecords: value.moreRecords ?? false,
        PagingCookie: value.pagingCookie ?? null,
        TotalRecordCount: value.totalRecordCount ?? -1,
        RecordCountLessThanMarv: value.recordCountLessThanMarv ?? 0,
        TotalRecordCountLimitExceeded: value.totalRecordCountLimitExceeded ?? false,
      });
    case 'Relationship':
      return typed('Relationship', {
        SchemaName: value.schemaName,
        PrimaryEntityRole: value.primaryEntityRole == null ? null : value.primaryEntityRole === 'Referenced' ? 1 : 0,
      });
    case 'ColumnSet':
      return typed('ColumnSet', queryContract({ allColumns: false, columns: [], ...value }, 'ColumnSet'));
    case 'FetchExpression':
      return typed('FetchExpression', { Query: value.query });
    case 'QueryExpression':
      return typed('QueryExpression', queryContract(value, 'QueryExpression'));
    case 'QueryByAttribute':
      for (const field of Object.keys(value))
        if (
          !['$type', 'entityName', 'attributes', 'values', 'columnSet', 'orders', 'pageInfo', 'topCount'].includes(
            field,
          )
        )
          throw new DataError(
            `The webhook query property QueryByAttribute.${field} has no structural contract.`,
            501,
            'LocalWebhookContextUnsupported',
          );
      return typed('QueryByAttribute', {
        EntityName: value.entityName,
        Attributes: [...(value.attributes ?? [])],
        Values: (value.values ?? []).map((item) => dataContract(item)),
        ColumnSet: value.columnSet ? queryContract(value.columnSet, 'ColumnSet') : null,
        Orders: (value.orders ?? []).map((order) => queryContract(order, 'OrderExpression')),
        PageInfo: value.pageInfo ? queryContract(value.pageInfo, 'PagingInfo') : null,
        TopCount: value.topCount ?? null,
      });
    case 'ExecutionContext':
      return Object.fromEntries(
        Object.entries(value.values ?? {}).map(([key, item]) => [
          key,
          key === 'OperationCreatedOn' && item?.$type === 'DateTime'
            ? `/Date(${operationTimeEpoch(item.value)})/`
            : dataContract(item),
        ]),
      );
    case 'ParameterCollection':
      return pairs(value.values);
    case 'EntityImageCollection':
      return Object.entries(value.values ?? {}).map(([key, image]) => ({ key, value: dataContract(image, false) }));
    case 'EntityReferenceCollection':
      return (value.values ?? []).map((reference) => dataContract(reference));
    case 'EntityImageCollectionArray':
    case 'SdkArray':
    case 'GuidArray':
    case 'PrimitiveArray':
      return (value.values ?? []).map((item) => dataContract(item));
    case 'OptionSetValueCollection':
      return (value.values ?? []).map((item) =>
        dataContract(item?.$type ? item : { $type: 'OptionSetValue', value: item }),
      );
    case 'AliasedValue':
      return typed('AliasedValue', {
        AttributeLogicalName: value.attributeLogicalName,
        EntityLogicalName: value.entityLogicalName,
        Value: dataContract(value.value),
      });
    case 'OptionSetValue':
      return typed(value.$type, { Value: Number(value.value) });
    case 'ConcurrencyBehavior':
      if (![0, 1, 2].includes(value.value))
        throw new DataError('Unsupported SDK ConcurrencyBehavior value.', 501, 'LocalWebhookContextUnsupported');
      return value.value;
    case 'Money':
      return typed('Money', { Value: exactNumeric(value.value, 'Money') });
    case 'DateTime': {
      const ms = Date.parse(value.value);
      return Number.isFinite(ms) ? `/Date(${ms})/` : null;
    }
    case 'Guid':
      return value.value == null ? null : String(value.value);
    case 'Double':
      return Number(value.value);
    case 'Decimal':
    case 'Int64':
      return exactNumeric(value.value, value.$type);
    default:
      if (!value.$type)
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dataContract(item)]));
      throw new DataError(
        `The webhook context cannot serialize SDK value ${value.$type}.`,
        501,
        'LocalWebhookContextUnsupported',
      );
  }
}

// Pipeline creation times use UTC components even when the SDK wire carries
// DateTimeKind.Unspecified. Do not reinterpret those components in host local
// time; general authored DateTime attribute values keep their separate codec.
function operationTimeEpoch(value) {
  const text = typeof value === 'string' ? value : '';
  const epoch = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? text : text + 'Z');
  if (!Number.isFinite(epoch))
    throw new DataError('The pipeline operation creation time is unavailable.', 501, 'LocalWebhookContextUnsupported');
  return epoch;
}

// An asynchronous job's OperationCreatedOn is an Unspecified DateTime: DataContractJsonSerializer appends the zero
// offset (native asynchronous web hook payloads: '/Date(1793373678000+0000)/').
const operationCreatedOn = (value) => `/Date(${operationTimeEpoch(value)}+0000)/`;
const guidOf = (value) => (value !== null && typeof value === 'object' ? (value.value ?? null) : (value ?? null));

/** One RemoteExecutionContext frame (the 30 documented properties) from an SDK ExecutionContext's values. */
function remoteFrame(values) {
  if (!values) return null;
  return {
    BusinessUnitId: guidOf(values.BusinessUnitId),
    CorrelationId: guidOf(values.CorrelationId),
    Depth: values.Depth,
    InitiatingUserAgent: values.InitiatingUserAgent ?? null,
    InitiatingUserAzureActiveDirectoryObjectId: guidOf(values.InitiatingUserAzureActiveDirectoryObjectId),
    InitiatingUserId: guidOf(values.InitiatingUserId),
    InputParameters: pairs(values.InputParameters?.values),
    IsExecutingOffline: false,
    IsInTransaction: values.IsInTransaction === true,
    IsOfflinePlayback: false,
    IsolationMode: values.IsolationMode,
    MessageName: values.MessageName,
    Mode: values.Mode,
    OperationCreatedOn: operationCreatedOn(values.OperationCreatedOn?.value ?? values.OperationCreatedOn),
    OperationId: guidOf(values.OperationId),
    OrganizationId: guidOf(values.OrganizationId),
    OrganizationName: values.OrganizationName ?? null,
    OutputParameters: pairs(values.OutputParameters?.values),
    OwningExtension: dataContract(values.OwningExtension, false),
    ParentContext: remoteFrame(values.ParentContext?.values),
    PostEntityImages: dataContract(values.PostEntityImages ?? { $type: 'EntityImageCollection', values: {} }),
    PreEntityImages: dataContract(values.PreEntityImages ?? { $type: 'EntityImageCollection', values: {} }),
    PrimaryEntityId: guidOf(values.PrimaryEntityId),
    PrimaryEntityName: values.PrimaryEntityName,
    RequestId: guidOf(values.RequestId),
    SecondaryEntityName: values.SecondaryEntityName ?? 'none',
    SharedVariables: pairs(values.SharedVariables?.values),
    Stage: values.Stage,
    UserAzureActiveDirectoryObjectId: guidOf(values.UserAzureActiveDirectoryObjectId),
    UserId: guidOf(values.UserId),
  };
}

/** An asynchronous Create, Update or Delete web hook reports the context the CLR pipeline builds for the same job
 * (plugin-clr.mjs clrContext): identities with their Entra object ids and user agent, SYSTEM for Delete, the
 * organization's unique name, the asynchronous parent chain, the Create 'id' output and the platform's
 * AsynchronousStepPrimaryName image (native crud, async, upsert, bulk, ownerAndState web hook payloads). Only the
 * Update ConcurrencyBehavior input is absent from the remote contract. */
function asyncRecordContext(store, facts, initiating) {
  const { item, entity, operation, stage, target = {}, record, previous, identity, depth } = facts;
  const frame = facts.initialFrame;
  frame.callerIdentity ??= identity;
  // The job runs under its request's correlation (x-ms-correlation-request-id), as the delivery does.
  frame.correlationId ??= facts.correlationId;
  const answer = clrContext({
    runtime: { descriptor: { context: {}, serviceProfile: { userId: initiating } } },
    store,
    step: { ...item, isolationMode: 1, contract: { ...item.contract, mode: 1 } },
    entity,
    operation,
    stage,
    target,
    record,
    previous,
    frame,
    depth,
    // A bridged multiple step runs the single operation under its multiple message (plugin-single-multiple.mjs).
    bridged: facts.bridged === true,
  });
  const { ConcurrencyBehavior: _, ...inputs } = answer.inputParameters.values;
  return remoteFrame({
    ...answer.context,
    InputParameters: { $type: 'ParameterCollection', values: inputs },
    OutputParameters: answer.outputParameters,
    SharedVariables: answer.sharedVariables,
    PreEntityImages: { $type: 'EntityImageCollection', values: answer.preImages },
    PostEntityImages: { $type: 'EntityImageCollection', values: answer.postImages },
  });
}

/** The RemoteExecutionContext of one step run, with the documented sample
 * properties and typed message parameters. */
export function remoteExecutionContext(store, facts) {
  const {
    item,
    entity,
    operation,
    stage,
    target = {},
    record,
    previous,
    identity,
    depth,
    correlationId,
    asyncExecution,
  } = facts;
  const idColumn = entity && entity !== 'none' ? store.resolveMapping(entity).idColumn : null;
  const frame = facts.initialFrame ?? facts.frame ?? {};
  const preValidationParent =
    !asyncExecution &&
    stage !== 10 &&
    (item.contract?.mode ?? 0) === 0 &&
    ['create', 'update', 'delete'].includes(operation)
      ? frame.preValidationContext
      : null;
  const org = organizationRecord(store) ?? {};
  const initiating = identity?.systemUserId ?? identity?.id ?? null;
  if (asyncExecution && facts.initialFrame && !facts.customApi && ['create', 'update', 'delete'].includes(operation))
    return asyncRecordContext(store, facts, initiating);
  const user = store.tableRows('systemuser').find((row) => same(row.systemuserid, initiating));
  const entityOf = (row, spec) =>
    dataContract(
      recordToSdkEntity(store, entity, imageAttributes(row), {
        allColumns: !spec.attributes?.length,
        columns: spec.attributes ?? [],
      }),
      false,
    );
  // An image on another message property (Merge SubordinateId) holds that record's row (frame.imageRows).
  const images = (row, types) =>
    (item.images ?? [])
      .filter((spec) => types.includes(spec.type))
      .map((spec) => {
        const rows = spec.messagePropertyName && frame.imageRows?.[spec.messagePropertyName];
        return [spec, rows ? (types.includes(1) ? rows.record : rows.previous) : row];
      })
      .filter(([, source]) => source)
      .map(([spec, source]) => ({ key: spec.alias || spec.name, value: entityOf(source, spec) }));
  const created = stage === 40 && operation === 'create';
  // Message-specific parameter collections retain the SDK's different Target,
  // Targets, Query and Custom API contracts.
  const inputValues =
    facts.messageParameters?.inputParameters?.values ?? (facts.customApi ? frame.inputParameters?.values : undefined);
  let inputs = inputValues
    ? pairs(inputValues)
    : facts.associationParameters
      ? pairs(facts.associationParameters)
      : ['createmultiple', 'updatemultiple'].includes(operation)
        ? pairs({
            Targets: { $type: 'EntityCollection', entities: facts.targets ?? frame.targets ?? [], totalRecordCount: 0 },
          })
        : operation === 'retrievemultiple'
          ? pairs({ Query: facts.query ?? frame.query })
          : operation === 'retrieve'
            ? pairs({
                Target: facts.holder?.target ??
                  frame.retrieveTarget ?? { $type: 'EntityReference', logicalName: entity, id: record?.[idColumn] },
                ColumnSet: { $type: 'ColumnSet', ...(facts.columns ?? frame.columns ?? {}) },
              })
            : operation === 'delete'
              ? [
                  {
                    key: 'Target',
                    value: {
                      __type: `EntityReference:${NS}`,
                      Id: record[idColumn],
                      KeyAttributes: [],
                      LogicalName: entity,
                      Name: null,
                      RowVersion: null,
                    },
                  },
                ]
              : ['create', 'update'].includes(operation)
                ? [
                    {
                      key: 'Target',
                      value: dataContract(
                        recordToSdkEntity(
                          store,
                          entity,
                          { [idColumn]: record?.[idColumn], ...target },
                          { allColumns: true },
                        ),
                      ),
                    },
                  ]
                : [];
  if (frame.inputParameters?.values) {
    if (frame.inputParametersStage === stage) inputs = pairs(frame.inputParameters.values);
    else {
      const known = new Set(inputs.map((entry) => entry.key));
      inputs.push(
        ...pairs(Object.fromEntries(Object.entries(frame.inputParameters.values).filter(([name]) => !known.has(name)))),
      );
    }
  }
  // A bridged multiple step (plugin-single-multiple.mjs) receives the single Target as one Targets record.
  if (facts.bridged) {
    const sdkTarget =
      operation === 'delete'
        ? { $type: 'EntityReference', logicalName: entity, id: record?.[idColumn] }
        : frame.inputParametersStage === stage && frame.inputParameters?.values?.Target?.$type === 'Entity'
          ? frame.inputParameters.values.Target
          : recordToSdkEntity(store, entity, { [idColumn]: record?.[idColumn], ...target }, { allColumns: true });
    inputs = [
      ...inputs.filter((entry) => entry.key !== 'Target'),
      ...pairs(bridgeTargetInputs({ Target: sdkTarget }, entity)),
    ];
  }
  const outputs =
    facts.messageParameters?.outputParameters?.values ??
    frame.outputParameters?.values ??
    (created
      ? { id: record[idColumn] }
      : stage === 40 && operation === 'createmultiple'
        ? { Ids: { $type: 'GuidArray', values: record.bulkIds ?? [] } }
        : stage === 40 && operation === 'retrieve'
          ? { BusinessEntity: facts.holder?.entity ?? frame.entity }
          : stage === 40 && operation === 'retrievemultiple'
            ? { BusinessEntityCollection: facts.collection ?? frame.collection }
            : {});
  const context = {
    BusinessUnitId: lookup(user?.businessunitid) ?? store.tableRows('businessunit')[0]?.businessunitid ?? null,
    CorrelationId: frame.correlationId ?? correlationId,
    Depth: depth,
    InitiatingUserId: initiating,
    InputParameters: inputs,
    // True only for the offline Outlook client, never for a server pipeline.
    IsExecutingOffline: false,
    // A PreValidation step joins a transaction only when one already exists, PreOperation and PostOperation steps run inside
    // it, asynchronous steps never do. store.pluginInTransaction is that pipeline state (data.mjs exportedPluginPhase keeps an inherited one at stage 10).
    IsInTransaction: !asyncExecution && store.pluginInTransaction === true,
    IsOfflinePlayback: false,
    IsolationMode: 1, // native crud: a web hook context has IsolationMode 1
    MessageName: facts.customApi?.name ?? messageNameOf(facts.bridged ? multipleMessage(operation) : operation),
    Mode: asyncExecution ? 1 : 0,
    OperationCreatedOn:
      asyncExecution && frame.asyncOperation
        ? operationCreatedOn(frame.asyncOperation.createdOn)
        : `/Date(${frame.createdOn == null ? (store.clock ?? systemClock).now() : operationTimeEpoch(frame.createdOn)})/`,
    OperationId:
      (asyncExecution && frame.asyncOperation ? frame.asyncOperation.id : frame.operationId) ??
      (store.ids ?? systemIds).uuid(),
    OrganizationId: org.organizationid ?? null,
    // The unique name, as in every plug-in context (plugin-clr.mjs).
    OrganizationName: store.state?.dataverse?.uniqueName ?? org.name ?? null,
    OutputParameters: pairs(outputs),
    OwningExtension: {
      Id: item.id,
      KeyAttributes: [],
      LogicalName: 'sdkmessageprocessingstep',
      Name: null,
      RowVersion: null,
    },
    ParentContext: dataContract(
      frame.delegatedParentContext ?? preValidationParent ?? store.pluginParentContext ?? null,
    ),
    PostEntityImages: stage === 40 && operation !== 'delete' ? images(record, [1, 2]) : [],
    PreEntityImages: images(previous, [0, 2]),
    PrimaryEntityId:
      ['associate', 'disassociate'].includes(operation) || (facts.bridged && asyncExecution && operation === 'delete')
        ? '00000000-0000-0000-0000-000000000000'
        : (record?.[idColumn] ??
          previous?.[idColumn] ??
          (facts.customApi ? '00000000-0000-0000-0000-000000000000' : null)),
    PrimaryEntityName: ['associate', 'disassociate'].includes(operation)
      ? 'none'
      : entity || (facts.customApi ? 'none' : entity),
    RequestId: frame.requestId ?? null,
    SecondaryEntityName: 'none',
    SharedVariables: pairs(frame.sharedVariables?.values),
    Stage: stage,
    UserId: item.impersonatingUserId ?? initiating,
  };
  if (frame.delegatedSourceOperation) {
    const source = frame.delegatedSourceOperation;
    context.ParentContext = dataContract(
      delegatedPluginParent(
        source,
        context,
        store.pluginExecutionUserId ?? source.identity?.systemUserId ?? source.identity?.id ?? initiating,
      ),
    );
  }
  // A bridged multiple reports the single operation's frames, another asynchronous message its synchronous caller chain,
  // relabelled as the job (plugin-sdk-parent.mjs).
  const guid = (value) => ({ $type: 'Guid', value });
  const job = {
    MessageName: context.MessageName,
    Depth: context.Depth,
    PrimaryEntityId: guid(context.PrimaryEntityId),
    IsolationMode: context.IsolationMode,
    OwningExtension: { $type: 'EntityReference', logicalName: 'sdkmessageprocessingstep', id: item.id, name: null },
    OperationId: guid(context.OperationId),
    OperationCreatedOn: frame.createdOnWire,
  };
  const chain =
    asyncMultipleJobParent(frame, facts.bridged ? multipleMessage(operation) : operation, entity, job) ??
    (asyncExecution && !context.ParentContext && frame.asyncOperation
      ? asynchronousParentChain(frame.asyncCallerParent, job)
      : null);
  if (chain) context.ParentContext = remoteFrame(chain.values);
  return context;
}

// The authentication values. The stored format is not documented: XML settings as the Plug-in Registration Tool writes them,
// a JSON object, or key/value text. Plain text is one value (the WebhookKey code).
function authPairs(text) {
  const value = String(text ?? '').trim();
  try {
    if (value.startsWith('<'))
      return [...value.matchAll(/<setting\s+name="([^"]*)"\s+value="([^"]*)"/g)].map((match) => [match[1], match[2]]);
    if (value.startsWith('{')) return Object.entries(JSON.parse(value)).map(([key, item]) => [key, String(item)]);
  } catch {
    return [];
  }
  return value
    .split(/[&\r\n]+/)
    .filter(Boolean)
    .map((part) => {
      const at = part.search(/[=:]/);
      return at < 0 ? ['code', part.trim()] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    });
}

// The POST for one step run: the URL, the documented headers, the JSON body, and the endpoint's authentication as { type, value }
// (withAuth applies it).
function requestOf(store, endpoint, facts) {
  const url = new URL(endpoint.url);
  const org = organizationRecord(store) ?? {};
  const headers = {
    'content-type': 'application/json',
    'x-ms-dynamics-organization': String(org.domainname ?? org.name ?? ''), // the environment's domain name; the fallback to the organization name is a guess
    'x-ms-dynamics-entity-name': facts.entity ?? '',
    'x-ms-dynamics-request-name': facts.customApi?.name ?? messageNameOf(facts.operation),
    'x-ms-correlation-request-id': facts.correlationId,
  };
  const context = remoteExecutionContext(store, facts);
  let body = stringifyExactJson(context);
  if (Buffer.byteLength(body) > MAX_BODY) {
    for (const key of ['ParentContext', 'InputParameters', 'PreEntityImages', 'PostEntityImages']) delete context[key];
    body = stringifyExactJson(context);
    headers['x-ms-dynamics-msg-size-exceeded'] = 'true'; // only the header's presence is documented; the value is a guess
  }
  return {
    url: url.toString(),
    headers,
    body,
    auth: { type: Number(endpoint.authtype), value: endpoint.authvalue ?? '' },
  };
}

/** The request as it is sent: the endpoint's authentication applied to the URL or headers (WebhookKey ?code=, HttpHeader,
 * HttpQueryString). The one rule for every drive: the asynchronous pipeline applies it in process; the
 * synchronous I/O bridge worker applies it after resolving the value's env: reference itself (sync-io-worker.mjs), so no
 * authentication value crosses the thread boundary. */
export function withAuth({ url, headers, body, auth = null, capture = 0 }) {
  const target = new URL(url),
    next = { ...headers },
    values = authPairs(auth?.value);
  switch (Number(auth?.type)) {
    case 4:
      target.searchParams.set('code', values.find(([key]) => key === 'code')?.[1] ?? values[0]?.[1] ?? '');
      break; // WebhookKey: ?code=<value>
    case 5:
      for (const [key, value] of values) next[key] = value;
      break; // HttpHeader
    case 6:
      for (const [key, value] of values) target.searchParams.append(key, value);
      break; // HttpQueryString
  }
  return { url: target.toString(), headers: next, body, capture };
}

// Connection failures that prove nothing was written. Any other failure once the call started (the 60-second abort, a dropped
// connection) may have delivered the POST: the error says so with details.indeterminate.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

// One delivery with the documented retry: 502, 503 and 504 get exactly one more attempt. Each attempt has the 60-second timeout. The
// response body is ignored, so only the status is returned; with capture (a byte count, set by a trace at level full) the
// answer is { status, body } with the first capture characters of the last response's text. send is loopbackFetch (in
// process and in the bridge worker).
export async function deliver({ url, headers, body, capture = 0 }, send) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await send(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      if (error instanceof DataError) throw error; // refused before any network call (the loopback guard)
      const code = error?.cause?.code ?? error?.code;
      throw new DataError(
        `The web hook POST got no answer: ${String(error?.cause?.message ?? error?.message ?? error)}`,
        504,
        'WebhookNoAnswer',
        { indeterminate: !NOT_SENT.has(code) },
      );
    }
    const received = capture > 0 ? await response.text().catch(() => '') : await response.arrayBuffer().catch(() => {});
    if (attempt === 1 && [502, 503, 504].includes(response.status)) continue;
    return capture > 0 ? { status: response.status, body: received.slice(0, capture) } : response.status;
  }
}
// A delivery answer as { status, body?, indeterminate? }: deliver answers a status, or { status, body } with capture.
const answerOf = (answer) => (typeof answer === 'number' ? { status: answer } : (answer ?? { status: -1 }));
// A captured body as a payload: JSON text parsed, any other text as it is (the trace store redacts and caps it).
const jsonOrText = (value) => {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

// The bridge deadlines: a web hook has at most two attempts of 60 seconds each; an emulator send has 5-second steps
// (connection, link, transfer). A post answers { status } (-1 when no answer came) and indeterminate when it may have been
// delivered all the same (the bridge deadline, the 60-second abort or a dropped connection after the request was written).
const POST_TIMEOUT = 125_000,
  AMQP_TIMEOUT = 20_000;
const indeterminate = (error) => error?.code === 'SyncIoTimeout' || error?.details?.indeterminate === true;
// The bridge message carries the authentication as an env: reference to a variable of the shared process environment
// (SHARE_ENV) that lives for this call only; the worker reads the value itself, as it does for a Service Bus connection string.
const postSync = ({ auth, ...request }) => {
  const name = auth?.value ? `PAQVILO_SYNC_IO_AUTH_${randomUUID().replaceAll('-', '')}` : null;
  if (name) process.env[name] = String(auth.value);
  try {
    return answerOf(
      syncIo(
        'http-post',
        { ...request, auth: { type: auth?.type ?? null, ref: name ? `env:${name}` : null } },
        { timeoutMs: POST_TIMEOUT },
      ),
    );
  } catch (error) {
    return { status: -1, indeterminate: indeterminate(error) };
  } finally {
    if (name) delete process.env[name];
  }
};
const postAsync = (request) =>
  deliver(withAuth(request), loopbackFetch).then(answerOf, (error) => ({
    status: -1,
    indeterminate: indeterminate(error),
  }));

// Queue (2), Topic (5) and Queue Persistent (6): the serviceendpoint contracts the message bus carries.
const BUS_CONTRACTS = new Set([2, 5, 6]);
const BUS_ENTITY = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,259}(?:\/[A-Za-z0-9._~-]{1,260}){0,2}$/; // message-bus.mjs ENTITY

/** The messaging provider in the one shape delivery reads: `{ bus, buses?, settings: { endpoints }, organizationUri? }`
 * (api.providers.messaging), a bare bus (endpoints from bus.settings), or a getter of either. Null when none is configured. */
export function messagingOf(provider) {
  const value = typeof provider === 'function' ? provider() : provider;
  if (!value || typeof value !== 'object') return null;
  const bus = typeof value.send === 'function' ? value : value.bus;
  if (!bus || typeof bus.send !== 'function') return null;
  return {
    bus,
    buses: value.buses ?? {},
    endpoints: value.settings?.endpoints ?? bus.settings?.endpoints ?? {},
    organizationUri: value.organizationUri ?? null,
  };
}

/** The bus and entity a service endpoint row maps to (providers.messaging.endpoints, keyed by serviceendpointid or name), or null. */
export function serviceEndpointTarget(messaging, endpoint) {
  if (!messaging || !endpoint) return null;
  const entries = Object.entries(messaging.endpoints ?? {});
  const target = (entries.find(([key]) => same(key, endpoint.serviceendpointid)) ??
    entries.find(([key]) => endpoint.name != null && key === endpoint.name))?.[1];
  const slash = typeof target === 'string' ? target.indexOf('/') : -1;
  if (slash <= 0) return null;
  const providerId = target.slice(0, slash);
  const bus = messaging.buses?.[providerId] ?? (providerId === (messaging.bus.id ?? 'local') ? messaging.bus : null);
  return bus ? { bus, providerId, entity: target.slice(slash + 1) } : null;
}

// A target whose bus is a network broker (the Service Bus emulator, or a pack bus that exports syncIo): it cannot join the store
// transaction, so its message is sent when the step runs and a rollback does not withdraw it.
const externalBus = (target) => target?.bus?.descriptor?.kind === 'servicebus-emulator' || Boolean(target?.bus?.syncIo);

/**
 * The delivery adapter the plug-in pipeline calls (exported-plugins.mjs runPluginPhase, plugin-async.mjs).
 * - send() (a synchronous step on the asynchronous pipeline) and sync() (the same step on the synchronous SDK drive, through
 *   the I/O bridge) apply one rule: the step fails its operation (the transaction rolls back) when a contacted web hook answers
 *   outside 2xx ("Endpoint unavailable") or a bus send fails (ServiceEndpointFailed naming the step). A step the simulator
 *   cannot contact (a non-loopback or missing endpoint) is recorded as WEBHOOK_NOT_CONTACTED and the operation continues.
 *   A post that cannot be recalled (a web hook, an emulator send) and whose operation later rolls back is recorded as
 *   SERVICE_ENDPOINT_SENT_BEFORE_ROLLBACK.
 * - afterCommit() sends a bus contract to its bus; it resolves to { canceled: message } for any other contract than 8 and for
 *   an endpoint it did not contact (the
 *   caller writes a Canceled System Job: an uncontacted step never counts or reports as delivered), and
 *   rejects for a contacted endpoint that answers outside 2xx (a Failed System Job). Otherwise it resolves to undefined.
 * Diagnostics carry the endpoint host only, never its path, query or authvalue.
 */
export function serviceEndpointDelivery(store, { bus = null, messaging = bus } = {}) {
  const endpointOf = (item) =>
    store.tableRows('serviceendpoint').find((row) => same(row.serviceendpointid, item.serviceEndpointId)) ?? null;
  const CANCELED = 'Simulator: endpoint not delivered (loopback webhooks only)';
  // A step whose endpoint was not contacted never reports delivery: its System Job is Canceled with this message.
  const NOT_CONTACTED = 'Simulator: endpoint not contacted (loopback webhooks only)';
  // Dashboard counters (runtime-counters.mjs): webhooks.delivered (2xx), webhooks.failed (other status), webhooks.notContacted.
  const count = (status) =>
    store.counters?.increment(
      status === null
        ? 'webhooks.notContacted'
        : status >= 200 && status < 300
          ? 'webhooks.delivered'
          : 'webhooks.failed',
    );
  // The id of the step's primary row (its record, else the pre-image or target), for the span's recordId.
  const recordIdOf = (facts) => {
    let idColumn;
    try {
      idColumn = store.resolveMapping(facts.entity).idColumn;
    } catch {
      return null;
    }
    const id = facts.record?.[idColumn] ?? facts.previous?.[idColumn] ?? facts.target?.[idColumn] ?? null;
    return id == null ? null : String(id);
  };
  // Tracing (docs/design/tracing.md): one http-out span per POST, named by the URL path only (never the query, which can carry
  // the WebhookKey code, nor the authentication value); the request forwards traces.headers() of the span so
  // a loopback receiver joins the trace. post(request) answers { status } or a status, synchronously or as a promise.
  // At level full the span input is the request as built before the authentication is applied ({ url, headers, body }: the
  // RemoteExecutionContext; no code, header or query value of the endpoint's authentication), and its output the receiver's
  // answer { status, body } (the first payloadBytes of its text, read on every drive through deliver's capture).
  const outbound = (facts, request, post) => {
    const traces = store.traces;
    if (!traces?.enabled) return post(request);
    const url = new URL(request.url);
    const settings = traces.settings();
    const capture = settings.level === 'full' ? settings.payloadBytes : 0;
    const span = traces.start({
      kind: 'http-out',
      name: `POST ${url.pathname}`,
      module: 'webhooks',
      operation: 'post',
      entity: facts.entity ?? null,
      recordId: recordIdOf(facts),
      attributes: {
        host: url.hostname,
        path: url.pathname,
        contract: WEBHOOK_CONTRACT,
        stepId: facts.item?.id ?? null,
        stepName: facts.item?.name ?? null,
        mode: facts.asyncExecution ? 'async' : 'sync',
      },
      input: () => ({ url: `${url.origin}${url.pathname}`, headers: request.headers, body: jsonOrText(request.body) }),
    });
    const answered = (answer) => {
      const { status, body, indeterminate: unknown } = answerOf(answer);
      if (body !== undefined) span.output(() => ({ status, body: jsonOrText(body) }));
      // A delivery succeeds only with a 2xx answer; 401/403 are denied (statusFromHttp), any other answer an error.
      const attributes = { statusCode: status ?? null, ...(unknown ? { indeterminate: true } : {}) };
      if (status >= 400)
        recordHttpError(span, status, { code: `Http${status}`, message: `The web hook answered ${status}.` });
      else if (!(status >= 200 && status < 300))
        span.end({
          status: statusFromHttp(status) === 'denied' ? 'denied' : 'error',
          attributes,
          error:
            status === -1
              ? { code: 'WebhookNoAnswer', message: 'The web hook POST got no answer.' }
              : { code: `Http${status}`, message: `The web hook answered ${status}.` },
        });
      span.end({ attributes });
      return answer;
    };
    let answer;
    try {
      answer = post({ ...request, capture, headers: { ...request.headers, ...traces.headers(span) } });
    } catch (error) {
      span.fail(error);
      throw error;
    }
    return typeof answer?.then === 'function'
      ? answer.then(answered, (error) => {
          span.fail(error);
          throw error;
        })
      : answered(answer);
  };
  const notContacted = (facts, reason, host) => {
    store.traces?.current()?.event('webhook', {
      message: 'Endpoint not contacted (loopback webhooks only).',
      attributes: { code: 'WEBHOOK_NOT_CONTACTED', reason, host },
    });
    facts.diagnostic?.({
      code: 'WEBHOOK_NOT_CONTACTED',
      severity: 'warning',
      stepId: facts.item.id,
      name: facts.item.name,
      entity: facts.entity,
      operation: facts.operation,
      stage: facts.stage,
      reason,
      host,
      message:
        'The simulator contacts only loopback webhook endpoints. The endpoint was not called and nothing was delivered; the operation continues.',
    });
  };
  const notDelivered = (facts, reason) =>
    facts.diagnostic?.({
      code: 'WEBHOOK_NOT_DELIVERED',
      severity: 'warning',
      stepId: facts.item.id,
      name: facts.item.name,
      entity: facts.entity,
      operation: facts.operation,
      stage: facts.stage,
      reason,
      message: 'Only web hook (contract 8) endpoints are simulated; this endpoint was skipped.',
    });
  // The request to send, or null when nothing is sent: a contract other than 8 is skipped, and a missing or non-loopback endpoint is
  // not contacted (the step succeeds, recorded as not contacted).
  const requestFor = (facts) => {
    const endpoint = endpointOf(facts.item);
    if (endpoint && Number(endpoint.contract) !== WEBHOOK_CONTRACT) {
      count(null);
      notDelivered(facts, 'contract-not-simulated');
      return null;
    }
    if (!endpoint) {
      count(null);
      notContacted(facts, 'missing-endpoint', null);
      return null;
    }
    if (!isLoopbackUrl(endpoint.url)) {
      count(null);
      notContacted(facts, 'non-loopback', hostnameOf(endpoint.url));
      return null;
    }
    return requestOf(store, endpoint, facts);
  };
  // The bus that carries this step's endpoint (contract 2, 5 or 6 with a configured provider), else null.
  const busOf = (endpoint) =>
    endpoint && BUS_CONTRACTS.has(Number(endpoint.contract)) ? messagingOf(messaging) : null;
  // One message per step run: the RemoteExecutionContext body with the documented listener properties (organization, calling and initiating
  // user, table, request name). An unmapped endpoint is never dropped silently: SERVICE_ENDPOINT_UNMAPPED and a thrown error (a sync
  // step fails the operation, an async step's System Job is Failed). The native property names (claim URIs) are not reproduced.
  const messageFor = (facts, endpoint, provider) => {
    const target = serviceEndpointTarget(provider, endpoint);
    if (!target) {
      facts.diagnostic?.({
        code: 'SERVICE_ENDPOINT_UNMAPPED',
        severity: 'error',
        stepId: facts.item.id,
        name: facts.item.name,
        entity: facts.entity,
        operation: facts.operation,
        stage: facts.stage,
        endpointId: endpoint.serviceendpointid ?? null,
        endpointName: endpoint.name ?? null,
        contract: Number(endpoint.contract),
        message:
          'No providers.messaging.endpoints entry maps this service endpoint (by id or name) to a declared provider; the message was not sent.',
      });
      throw new DataError(
        `Service endpoint '${endpoint.name ?? endpoint.serviceendpointid}' (contract ${Number(endpoint.contract)}) has no providers.messaging.endpoints mapping; the message was not sent.`,
        400,
        'InvalidRequest',
        { innerCode: '0x80040265' },
      );
    }
    const context = remoteExecutionContext(store, facts);
    const properties = {
      organizationUri: provider.organizationUri,
      callingUser: context.UserId,
      initiatingUser: context.InitiatingUserId,
      entity: facts.entity ?? null,
      requestName: context.MessageName,
    };
    // A send the bus would refuse fails here, synchronously, so a sync step fails its operation instead of committing without
    // the message. These mirror message-bus.mjs send(): its entity name (entityName/ENTITY), properties and messageId checks.
    const invalidSend =
      !BUS_ENTITY.test(String(target.entity)) ||
      Object.values(properties).some((item) => item !== null && typeof item === 'object') ||
      typeof context.OperationId !== 'string' ||
      !context.OperationId ||
      context.OperationId.length > 128;
    if (invalidSend) {
      facts.diagnostic?.({
        code: 'SERVICE_ENDPOINT_SEND_FAILED',
        severity: 'error',
        stepId: facts.item.id,
        message: `The message bus refuses the message for service endpoint '${endpoint.name ?? endpoint.serviceendpointid}'.`,
      });
      throw unavailable();
    }
    return { target, context, properties };
  };
  // Tracing: one `webhook` span per Service Bus send (D-R3-5), attribute transport 'servicebus', with the queue or topic, the
  // provider and the message id; at level full its input is the message (the RemoteExecutionContext body and the listener
  // properties). send() is the bus send, synchronous or a promise; its failure fails the span.
  const busOutbound = (facts, endpoint, { target, context, properties }, send) => {
    const traces = store.traces;
    if (!traces?.enabled) return send();
    const contract = Number(endpoint.contract);
    const span = traces.start({
      kind: 'webhook',
      name: `Send ${target.providerId}/${target.entity}`,
      module: 'webhooks',
      operation: 'send',
      entity: facts.entity ?? null,
      recordId: recordIdOf(facts),
      attributes: {
        transport: 'servicebus',
        contract,
        channel: contract === 5 ? 'topic' : 'queue',
        provider: target.providerId,
        queue: target.entity,
        external: externalBus(target),
        serviceEndpointId: endpoint.serviceendpointid ?? null,
        serviceEndpoint: endpoint.name ?? null,
        stepId: facts.item?.id ?? null,
        stepName: facts.item?.name ?? null,
        mode: facts.asyncExecution ? 'async' : 'sync',
        messageId: context.OperationId,
      },
      input: () => ({ entity: target.entity, messageId: context.OperationId, properties, body: context }),
    });
    let result;
    try {
      result = traces.run(span, send);
    } catch (error) {
      span.fail(error);
      throw error;
    }
    // The bus receipt (never the message again): its id, sequence number and whether it was a duplicate.
    const sent = (value) => {
      if (value && typeof value === 'object')
        span.set({ sequenceNumber: value.sequenceNumber ?? null, duplicate: value.duplicate ?? null });
      span.end();
    };
    if (typeof result?.then !== 'function') {
      sent(result);
      return result;
    }
    return result.then(
      (value) => {
        sent(value);
        return value;
      },
      (error) => {
        span.fail(error);
        throw error;
      },
    );
  };
  const sendToBus = (facts, endpoint, provider, nested) => {
    const message = messageFor(facts, endpoint, provider);
    const { target, context, properties } = message;
    return busOutbound(facts, endpoint, message, () =>
      target.bus.send(target.entity, context, { messageId: context.OperationId, properties, nested }),
    );
  };
  // A synchronous step's failed bus send fails its operation; the native error code, status and text are guesses.
  const sendFailed = (facts, endpoint, cause) => {
    if (cause instanceof DataError && cause.code === 'InvalidRequest') return cause; // unmapped or refused before any send (diagnosed there)
    const step = facts.item.name ?? facts.item.id,
      name = endpoint.name ?? endpoint.serviceendpointid;
    facts.diagnostic?.({
      code: 'SERVICE_ENDPOINT_SEND_FAILED',
      severity: 'error',
      stepId: facts.item.id,
      name: facts.item.name,
      entity: facts.entity,
      operation: facts.operation,
      stage: facts.stage,
      message: String(cause?.message ?? cause),
    });
    return new DataError(
      `Synchronous service endpoint step '${step}' could not post to service endpoint '${name}': ${String(cause?.message ?? cause)}`,
      400,
      'ServiceEndpointFailed',
      { innerCode: '0x80040265' },
    );
  };
  // A post that left the process (a web hook, an emulator send) cannot be recalled: when the operation rolls back afterwards, say
  // so (https://learn.microsoft.com/power-apps/developer/data-platform/work-data-azure-solution).
  // A post that got no answer after it may have been written (indeterminate: the bridge deadline, the 60-second abort, a dropped
  // connection) is noted the same way: the receiver may still have it (SERVICE_ENDPOINT_SEND_INDETERMINATE).
  const sentBeforeRollback = (facts, target, { indeterminate: unknown = false } = {}) =>
    store.onRollback?.((error) =>
      facts.diagnostic?.({
        code: unknown ? 'SERVICE_ENDPOINT_SEND_INDETERMINATE' : 'SERVICE_ENDPOINT_SENT_BEFORE_ROLLBACK',
        severity: 'warning',
        stepId: facts.item.id,
        name: facts.item.name,
        entity: facts.entity,
        operation: facts.operation,
        stage: facts.stage,
        target,
        cause: String(error?.message ?? error),
        ...(unknown ? { indeterminate: true } : {}),
        message: unknown
          ? 'The operation rolled back after this synchronous step got no answer to a post that may have been delivered; a delivered message cannot be recalled.'
          : 'The operation rolled back after this synchronous step posted its message; a posted message cannot be recalled.',
      }),
    );
  // The emulator target of a bus step, as the bridge addresses it (bus.syncIo), or null for a bus in this process.
  // The bus's syncIo ({ id, connectionString: 'env:NAME', amqpPort }): the core emulator bus, or a pack bus with the same shape.
  const bridged = (target) => target.bus.syncIo ?? null;
  // Whether the step cannot be delivered in any form (a contract other than 8 the bus does not carry), so its async job is Canceled.
  const notSimulated = (item) => {
    const endpoint = endpointOf(item);
    return Boolean(endpoint) && Number(endpoint.contract) !== WEBHOOK_CONTRACT && !busOf(endpoint);
  };
  const webhookAnswered = (facts, request, { status, indeterminate: unknown = false }) => {
    count(status);
    if (!(status >= 200 && status < 300)) {
      if (unknown) sentBeforeRollback(facts, hostnameOf(request.url), { indeterminate: true });
      throw unavailable();
    }
    sentBeforeRollback(facts, hostnameOf(request.url));
  };
  return {
    notSimulated,
    /** A synchronous step on the asynchronous pipeline: undefined when nothing leaves the process, else a promise the pipeline
     * awaits before the next step (a rejection fails the operation). */
    send(facts) {
      const endpoint = endpointOf(facts.item),
        provider = busOf(endpoint);
      if (provider) {
        let message;
        try {
          message = messageFor(facts, endpoint, provider);
        } catch (cause) {
          throw sendFailed(facts, endpoint, cause);
        }
        const { target, context, properties } = message,
          external = externalBus(target);
        // A bus in this process joins the running transaction (nested), so a rollback takes the message too.
        return Promise.resolve()
          .then(() =>
            busOutbound(facts, endpoint, message, () =>
              target.bus.send(target.entity, context, {
                messageId: context.OperationId,
                properties,
                nested: !external,
              }),
            ),
          )
          .then(
            () => {
              if (external) sentBeforeRollback(facts, `${target.providerId}/${target.entity}`);
            },
            (cause) => {
              throw sendFailed(facts, endpoint, cause);
            },
          );
      }
      const request = requestFor(facts);
      if (!request) return undefined;
      return outbound(facts, request, postAsync).then((status) => webhookAnswered(facts, request, status));
    },
    /** A synchronous step on the synchronous SDK drive: the post runs on the I/O bridge and this call returns when it answered. */
    sync(facts) {
      const endpoint = endpointOf(facts.item),
        provider = busOf(endpoint);
      if (provider) {
        let message;
        try {
          message = messageFor(facts, endpoint, provider);
        } catch (cause) {
          throw sendFailed(facts, endpoint, cause);
        }
        const { target, context, properties } = message,
          bridge = bridged(target);
        if (bridge) {
          try {
            busOutbound(facts, endpoint, message, () =>
              syncIo(
                'amqp-send',
                { provider: bridge, entity: target.entity, body: context, messageId: context.OperationId, properties },
                { timeoutMs: AMQP_TIMEOUT },
              ),
            );
          } catch (cause) {
            if (indeterminate(cause))
              sentBeforeRollback(facts, `${target.providerId}/${target.entity}`, { indeterminate: true });
            throw sendFailed(facts, endpoint, cause);
          }
          sentBeforeRollback(facts, `${target.providerId}/${target.entity}`);
          return;
        }
        // A bus in this process (the local bus) writes its row before send() returns, inside the running transaction.
        // ponytail: a pack bus without syncIo is not awaited on this drive; its failure is a diagnostic only. A pack bus takes
        // part in synchronous steps by exporting syncIo in the core emulator bus's shape.
        Promise.resolve(
          busOutbound(facts, endpoint, message, () =>
            target.bus.send(target.entity, context, { messageId: context.OperationId, properties, nested: true }),
          ),
        ).catch((error) =>
          facts.diagnostic?.({
            code: 'SERVICE_ENDPOINT_SEND_FAILED',
            severity: 'error',
            stepId: facts.item.id,
            message: error.message,
          }),
        );
        return;
      }
      const request = requestFor(facts);
      if (!request) return;
      webhookAnswered(facts, request, outbound(facts, request, postSync));
    },
    async afterCommit(delivered) {
      const facts = { ...delivered, asyncExecution: true }; // after commit: the asynchronous delivery (Mode 1, no transaction)
      const endpoint = endpointOf(facts.item),
        provider = busOf(endpoint);
      if (provider) {
        await sendToBus({ ...facts, asyncExecution: true }, endpoint, provider, false);
        return undefined;
      }
      if (notSimulated(facts.item)) {
        requestFor(facts);
        return { canceled: CANCELED };
      }
      const request = requestFor(facts);
      if (!request) return { canceled: NOT_CONTACTED };
      const { status } = answerOf(
        await outbound(facts, request, (sent) => deliver(withAuth(sent), loopbackFetch)).catch((error) => {
          count(-1);
          throw error;
        }),
      );
      count(status);
      if (!(status >= 200 && status < 300)) throw unavailable();
      return undefined;
    },
  };
}

/** Alias of serviceEndpointDelivery: the name the organization backend calls (without options, contract 8 only). */
export const webhookDelivery = (store, options) => serviceEndpointDelivery(store, options);

/**
 * IServiceEndpointNotificationService.Execute from a plug-in (plugin-sdk-messages.mjs): posts the plug-in's RemoteExecutionContext
 * (serialized by the CLR host with the official DataContractJsonSerializer) to a web hook endpoint on the synchronous I/O bridge,
 * under the rule of a synchronous step: a contacted endpoint answering outside 2xx fails the call ("Endpoint unavailable"); a
 * non-loopback endpoint is not contacted (WEBHOOK_NOT_CONTACTED). Answers null: the web hook's response body is not returned.
 * Other contracts (Service Bus queues, topics, Event Hub, two-way listeners) are not posted from a plug-in locally (501).
 */
export function notifyServiceEndpoint(store, endpointId, body, diagnostic = () => {}) {
  const endpoint = store.tableRows('serviceendpoint').find((row) => same(row.serviceendpointid, endpointId));
  if (!endpoint)
    throw new DataError(`serviceendpoint With Id = ${endpointId} Does Not Exist`, 404, 'NotFound', {
      innerCode: '0x80040217',
    });
  if (Number(endpoint.contract) !== WEBHOOK_CONTRACT)
    throw new DataError(
      `Service endpoint contract ${Number(endpoint.contract)} is not posted from a plug-in locally; only web hooks (contract 8) are.`,
      501,
      'LocalPluginSdkUnsupported',
    );
  if (!isLoopbackUrl(endpoint.url)) {
    diagnostic({
      code: 'WEBHOOK_NOT_CONTACTED',
      severity: 'warning',
      reason: 'non-loopback',
      host: hostnameOf(endpoint.url),
      message: 'The simulator contacts only loopback webhook endpoints. The endpoint was not called.',
    });
    return null;
  }
  const context = JSON.parse(body),
    org = organizationRecord(store) ?? {};
  const { status } = postSync({
    url: new URL(endpoint.url).toString(),
    headers: {
      'content-type': 'application/json',
      'x-ms-dynamics-organization': String(org.domainname ?? org.name ?? ''),
      'x-ms-dynamics-entity-name': context.PrimaryEntityName ?? '',
      'x-ms-dynamics-request-name': context.MessageName ?? '',
      'x-ms-correlation-request-id': context.CorrelationId ?? '',
    },
    body,
    auth: { type: Number(endpoint.authtype), value: endpoint.authvalue ?? '' },
  });
  store.counters?.increment(status >= 200 && status < 300 ? 'webhooks.delivered' : 'webhooks.failed');
  if (!(status >= 200 && status < 300)) throw unavailable();
  return null;
}
