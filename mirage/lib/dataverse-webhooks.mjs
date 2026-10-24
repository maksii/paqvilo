import { organizationRecord } from './organization-context.mjs';
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
import { recordToSdkEntity } from './plugin-clr.mjs';

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
function dataContract(value) {
  if (value == null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(dataContract);
  const typed = (type, body) => ({ __type: `${type}:${NS}`, ...body });
  switch (value.$type) {
    case 'Entity':
      return typed('Entity', {
        Attributes: pairs(value.attributes),
        EntityState: null,
        FormattedValues: pairs(value.formattedValues),
        Id: value.id ?? null,
        KeyAttributes: [],
        LogicalName: value.logicalName,
        RelatedEntities: [],
        RowVersion: value.rowVersion ?? null,
      });
    case 'EntityReference':
      return typed('EntityReference', {
        Id: value.id,
        KeyAttributes: [],
        LogicalName: value.logicalName,
        Name: value.name ?? null,
        RowVersion: null,
      });
    case 'OptionSetValue':
    case 'Money':
      return typed(value.$type, { Value: Number(value.value) });
    case 'DateTime': {
      const ms = Date.parse(value.value);
      return Number.isFinite(ms) ? `/Date(${ms})/` : null;
    }
    case 'Guid':
      return value.value == null ? null : String(value.value);
    case 'Decimal':
    case 'Double':
    case 'Int64':
      return Number(value.value);
    // ponytail: any other typed collection is its values in order; the native shape is not known.
    default:
      return Array.isArray(value.values) ? value.values.map(dataContract) : null;
  }
}

/** The RemoteExecutionContext of one step run, with the 27 properties in the documented sample order (ParentContext is null:
 * nested contexts are not built). */
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
  const idColumn = store.resolveMapping(entity).idColumn;
  const org = organizationRecord(store) ?? {};
  const initiating = identity?.systemUserId ?? identity?.id ?? null;
  const user = store.tableRows('systemuser').find((row) => same(row.systemuserid, initiating));
  const entityOf = (row, spec) =>
    dataContract(
      recordToSdkEntity(store, entity, row, { allColumns: !spec.attributes?.length, columns: spec.attributes ?? [] }),
    );
  const images = (row, types) =>
    row
      ? (item.images ?? [])
          .filter((spec) => types.includes(spec.type))
          .map((spec) => ({ key: spec.alias || spec.name, value: entityOf(row, spec) }))
      : [];
  const created = stage === 40 && operation === 'create';
  // Create, update and delete carry the Target. A delete's Target is a reference, not the row. Bulk messages carry no Target here.
  const inputs =
    operation === 'delete'
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
                recordToSdkEntity(store, entity, { [idColumn]: record?.[idColumn], ...target }, { allColumns: true }),
              ),
            },
          ]
        : [];
  return {
    BusinessUnitId: lookup(user?.businessunitid) ?? store.tableRows('businessunit')[0]?.businessunitid ?? null,
    CorrelationId: correlationId,
    Depth: depth,
    InitiatingUserId: initiating,
    InputParameters: inputs,
    // True only for the offline Outlook client, never for a server pipeline.
    IsExecutingOffline: false,
    // A PreValidation step joins a transaction only when one already exists, PreOperation and PostOperation steps run inside
    // it, asynchronous steps never do. store.pluginInTransaction is that pipeline state (data.mjs exportedPluginPhase keeps an inherited one at stage 10).
    IsInTransaction: !asyncExecution && store.pluginInTransaction === true,
    IsOfflinePlayback: false,
    IsolationMode: 1, // as in the documented sample
    MessageName: messageNameOf(operation),
    Mode: asyncExecution ? 1 : 0,
    OperationCreatedOn: `/Date(${(store.clock ?? systemClock).now()})/`,
    OperationId: (store.ids ?? systemIds).uuid(),
    OrganizationId: org.organizationid ?? null,
    OrganizationName: org.name ?? null,
    OutputParameters: created ? [{ key: 'id', value: record[idColumn] }] : [],
    OwningExtension: {
      Id: item.id,
      KeyAttributes: [],
      LogicalName: 'sdkmessageprocessingstep',
      Name: null,
      RowVersion: null,
    },
    ParentContext: null,
    PostEntityImages: stage === 40 && operation !== 'delete' ? images(record, [1, 2]) : [],
    PreEntityImages: images(previous, [0, 2]),
    PrimaryEntityId: record?.[idColumn] ?? previous?.[idColumn] ?? null,
    PrimaryEntityName: entity,
    RequestId: null,
    SecondaryEntityName: 'none',
    SharedVariables: [],
    Stage: stage,
    UserId: item.impersonatingUserId ?? initiating,
  };
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
    'x-ms-dynamics-request-name': messageNameOf(facts.operation),
    'x-ms-correlation-request-id': facts.correlationId,
  };
  const context = remoteExecutionContext(store, facts);
  let body = JSON.stringify(context);
  if (Buffer.byteLength(body) > MAX_BODY) {
    for (const key of ['ParentContext', 'InputParameters', 'PreEntityImages', 'PostEntityImages']) delete context[key];
    body = JSON.stringify(context);
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
export function withAuth({ url, headers, body, auth = null }) {
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
  return { url: target.toString(), headers: next, body };
}

// Connection failures that prove nothing was written. Any other failure once the call started (the 60-second abort, a dropped
// connection) may have delivered the POST: the error says so with details.indeterminate.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

// One delivery with the documented retry: 502, 503 and 504 get exactly one more attempt. Each attempt has the 60-second timeout. The
// response body is ignored, so only the status is returned. send is loopbackFetch (in process and in the bridge worker).
export async function deliver({ url, headers, body }, send) {
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
    await response.arrayBuffer().catch(() => {});
    if (attempt === 1 && [502, 503, 504].includes(response.status)) continue;
    return response.status;
  }
}

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
    return {
      status: syncIo(
        'http-post',
        { ...request, auth: { type: auth?.type ?? null, ref: name ? `env:${name}` : null } },
        { timeoutMs: POST_TIMEOUT },
      ),
    };
  } catch (error) {
    return { status: -1, indeterminate: indeterminate(error) };
  } finally {
    if (name) delete process.env[name];
  }
};
const postAsync = (request) =>
  deliver(withAuth(request), loopbackFetch).then(
    (status) => ({ status }),
    (error) => ({ status: -1, indeterminate: indeterminate(error) }),
  );

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
  const notContacted = (facts, reason, host) =>
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
  const sendToBus = (facts, endpoint, provider, nested) => {
    const { target, context, properties } = messageFor(facts, endpoint, provider);
    return target.bus.send(target.entity, context, { messageId: context.OperationId, properties, nested });
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
            target.bus.send(target.entity, context, { messageId: context.OperationId, properties, nested: !external }),
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
      return postAsync(request).then((status) => webhookAnswered(facts, request, status));
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
            syncIo(
              'amqp-send',
              { provider: bridge, entity: target.entity, body: context, messageId: context.OperationId, properties },
              { timeoutMs: AMQP_TIMEOUT },
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
        target.bus
          .send(target.entity, context, { messageId: context.OperationId, properties, nested: true })
          .catch((error) =>
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
      webhookAnswered(facts, request, postSync(request));
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
      const status = await deliver(withAuth(request), loopbackFetch).catch((error) => {
        count(-1);
        throw error;
      });
      count(status);
      if (!(status >= 200 && status < 300)) throw unavailable();
      return undefined;
    },
  };
}

/** Alias of serviceEndpointDelivery: the name the organization backend calls (without options, contract 8 only). */
export const webhookDelivery = (store, options) => serviceEndpointDelivery(store, options);
