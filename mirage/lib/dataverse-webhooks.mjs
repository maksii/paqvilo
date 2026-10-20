import { organizationRecord } from './organization-context.mjs';
// Webhooks (Learn: use-webhooks and register-web-hook). A plug-in step whose eventhandler is a service endpoint with contract 8
// (Webhook) POSTs the RemoteExecutionContext JSON to the endpoint URL, with the headers and authentication Learn documents.
//
// LOOPBACK ONLY: Mirage contacts an endpoint only when its URL host is localhost, *.localhost, 127.0.0.0/8 or ::1. Any other URL
// is never contacted, and the step fails as an unreachable endpoint: a sync step fails the operation ("Endpoint unavailable"),
// an async step gets a Failed System Job. Contracts other than 8 (Queue, Topic, Event Hub, ...) are not simulated and are skipped.
//
// A synchronous webhook blocks the caller until the endpoint answers, so its POST runs in a child process (spawnSync). A receiver
// inside Mirage's own process would deadlock. Asynchronous webhooks run in-process, after commit (plugin-async.mjs).
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { messageNameOf } from './exported-plugins.mjs';
import { recordToSdkEntity } from './plugin-clr.mjs';

const LOOPBACK = /^(?:(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
const WEBHOOK_CONTRACT = 8;
const MAX_BODY = 256 * 1024; // Learn: above 256 KB four optional properties are removed and the size header is sent.
const NS = 'http://schemas.microsoft.com/xrm/2011/Contracts';
const same = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
const lookup = (value) => (value !== null && typeof value === 'object' ? value.id : value) ?? null;

/** The one loopback guard: http or https to localhost, *.localhost, 127.0.0.0/8 or ::1. TriggerServiceEndpointCheck uses it too. */
export function isLoopbackUrl(text) {
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && LOOPBACK.test(url.hostname);
  } catch {
    return false;
  }
}

// The endpoint's documented failure. Learn: a failed synchronous webhook shows the "Endpoint unavailable" dialog. The code is unverified (LC-P6b).
const unavailable = () => new DataError('Endpoint unavailable', 400, 'InvalidRequest', { innerCode: '0x80040265' });

// DataContract JSON (Learn's sample): collections are {key, value} arrays and entities or references carry __type.
// Typed values follow the SDK's contract namespace. unverified: the money, option set and collection shapes (LC-P6c).
const pairs = (object) => Object.entries(object ?? {}).map(([key, value]) => ({ key, value: dataContract(value) }));
function dataContract(value) {
  if (value == null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(dataContract);
  const typed = (type, body) => ({ __type: `${type}:${NS}`, ...body });
  switch (value.$type) {
    case 'Entity': return typed('Entity', { Attributes: pairs(value.attributes), EntityState: null, FormattedValues: pairs(value.formattedValues), Id: value.id ?? null, KeyAttributes: [], LogicalName: value.logicalName, RelatedEntities: [], RowVersion: value.rowVersion ?? null });
    case 'EntityReference': return typed('EntityReference', { Id: value.id, KeyAttributes: [], LogicalName: value.logicalName, Name: value.name ?? null, RowVersion: null });
    case 'OptionSetValue': case 'Money': return typed(value.$type, { Value: Number(value.value) });
    case 'DateTime': { const ms = Date.parse(value.value); return Number.isFinite(ms) ? `/Date(${ms})/` : null; }
    case 'Guid': return value.value == null ? null : String(value.value);
    case 'Decimal': case 'Double': case 'Int64': return Number(value.value);
    // ponytail: any other typed collection is its values in order; the native shape is LC-P6c.
    default: return Array.isArray(value.values) ? value.values.map(dataContract) : null;
  }
}

/** The RemoteExecutionContext of one step run, with the 27 properties in Learn's sample order (ParentContext is null:
 * nested contexts are not built). */
export function remoteExecutionContext(store, facts) {
  const { item, entity, operation, stage, target = {}, record, previous, identity, depth, correlationId, asyncExecution } = facts;
  const idColumn = store.resolveMapping(entity).idColumn;
  const org = organizationRecord(store) ?? {};
  const initiating = identity?.systemUserId ?? identity?.id ?? null;
  const user = store.tableRows('systemuser').find((row) => same(row.systemuserid, initiating));
  const entityOf = (row, spec) => dataContract(recordToSdkEntity(store, entity, row, { allColumns: !spec.attributes?.length, columns: spec.attributes ?? [] }));
  const images = (row, types) => (row ? (item.images ?? []).filter((spec) => types.includes(spec.type)).map((spec) => ({ key: spec.alias || spec.name, value: entityOf(row, spec) })) : []);
  const created = stage === 40 && operation === 'create';
  // Create, update and delete carry the Target. A delete's Target is a reference, not the row. Bulk messages carry no Target here.
  const inputs = operation === 'delete' ? [{ key: 'Target', value: { __type: `EntityReference:${NS}`, Id: record[idColumn], KeyAttributes: [], LogicalName: entity, Name: null, RowVersion: null } }]
    : ['create', 'update'].includes(operation) ? [{ key: 'Target', value: dataContract(recordToSdkEntity(store, entity, { [idColumn]: record?.[idColumn], ...target }, { allColumns: true })) }] : [];
  return {
    BusinessUnitId: lookup(user?.businessunitid) ?? store.tableRows('businessunit')[0]?.businessunitid ?? null,
    CorrelationId: correlationId,
    Depth: depth,
    InitiatingUserId: initiating,
    InputParameters: inputs,
    IsExecutingOffline: false,
    IsInTransaction: !asyncExecution,
    IsOfflinePlayback: false,
    IsolationMode: 1, // as Learn's sample
    MessageName: messageNameOf(operation),
    Mode: item.contract?.mode ?? 0,
    OperationCreatedOn: `/Date(${Date.now()})/`,
    OperationId: randomUUID(),
    OrganizationId: org.organizationid ?? null,
    OrganizationName: org.name ?? null,
    OutputParameters: created ? [{ key: 'id', value: record[idColumn] }] : [],
    OwningExtension: { Id: item.id, KeyAttributes: [], LogicalName: 'sdkmessageprocessingstep', Name: null, RowVersion: null },
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

// The authentication values. Learn does not document the stored format (LC-P6a): XML settings as the Plug-in Registration Tool
// writes them, a JSON object, or key/value text. Plain text is one value (the WebhookKey code).
function authPairs(text) {
  const value = String(text ?? '').trim();
  try {
    if (value.startsWith('<')) return [...value.matchAll(/<setting\s+name="([^"]*)"\s+value="([^"]*)"/g)].map((match) => [match[1], match[2]]);
    if (value.startsWith('{')) return Object.entries(JSON.parse(value)).map(([key, item]) => [key, String(item)]);
  } catch {
    return [];
  }
  return value.split(/[&\r\n]+/).filter(Boolean).map((part) => {
    const at = part.search(/[=:]/);
    return at < 0 ? ['code', part.trim()] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  });
}

// The POST for one step run: the URL with its query authentication, Learn's headers, and the JSON body.
function requestOf(store, endpoint, facts) {
  const url = new URL(endpoint.url);
  const org = organizationRecord(store) ?? {};
  const headers = {
    'content-type': 'application/json',
    'x-ms-dynamics-organization': String(org.domainname ?? org.name ?? ''), // Learn: the environment's domain name; unverified fallback to the organization name
    'x-ms-dynamics-entity-name': facts.entity ?? '',
    'x-ms-dynamics-request-name': messageNameOf(facts.operation),
    'x-ms-correlation-request-id': facts.correlationId,
  };
  const context = remoteExecutionContext(store, facts);
  let body = JSON.stringify(context);
  if (Buffer.byteLength(body) > MAX_BODY) {
    for (const key of ['ParentContext', 'InputParameters', 'PreEntityImages', 'PostEntityImages']) delete context[key];
    body = JSON.stringify(context);
    headers['x-ms-dynamics-msg-size-exceeded'] = 'true'; // unverified: Learn gives the header's presence, not its value
  }
  const values = authPairs(endpoint.authvalue);
  switch (Number(endpoint.authtype)) {
    case 4: url.searchParams.set('code', values.find(([key]) => key === 'code')?.[1] ?? values[0]?.[1] ?? ''); break; // WebhookKey: ?code=<value>
    case 5: for (const [key, value] of values) headers[key] = value; break; // HttpHeader
    case 6: for (const [key, value] of values) url.searchParams.append(key, value); break; // HttpQueryString
  }
  return { url: url.toString(), headers, body };
}

// One delivery with Learn's retry: 502, 503 and 504 get exactly one more attempt. Each attempt has the 60-second timeout. The
// response body is ignored, so only the status is returned. Self-contained: the sync path sends its source to a child process.
async function deliver({ url, headers, body }) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(60_000) });
    await response.arrayBuffer().catch(() => {});
    if (attempt === 1 && [502, 503, 504].includes(response.status)) continue;
    return response.status;
  }
}
const CHILD = `${deliver}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  deliver(JSON.parse(input)).then(
    (status) => process.stdout.write(JSON.stringify({ status })),
    (error) => process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) })),
  );
});`;

// A synchronous step blocks until the endpoint answers: at most two attempts of 60 seconds each. The status is -1 when no answer came.
function deliverSync(request) {
  const answer = childProcess.spawnSync(process.execPath, ['-e', CHILD], { input: JSON.stringify(request), encoding: 'utf8', timeout: 125_000, maxBuffer: 64 * 1024, windowsHide: true });
  try { return JSON.parse(answer.stdout).status ?? -1; } catch { return -1; }
}

/**
 * The delivery adapter the plug-in pipeline calls (exported-plugins.mjs runPluginPhase, plugin-async.mjs).
 * - sync() throws only when a contacted endpoint answers outside 2xx (the operation rolls back). A step the simulator cannot
 *   contact (a non-loopback or missing endpoint) is recorded as WEBHOOK_NOT_CONTACTED and the operation continues.
 * - afterCommit() resolves to { canceled: message } for a contract other than 8 (the caller writes a Canceled System Job), and
 *   rejects for a contacted endpoint that answers outside 2xx (a Failed System Job). Otherwise it resolves to undefined.
 * Diagnostics carry the endpoint host only, never its path, query or authvalue.
 */
export function webhookDelivery(store) {
  const endpointOf = (item) => store.tableRows('serviceendpoint').find((row) => same(row.serviceendpointid, item.serviceEndpointId)) ?? null;
  const CANCELED = 'Simulator: endpoint not delivered (loopback webhooks only)'; // the brief's documented-shape message
  // Redacted host: the hostname alone, so no path, query or credential reaches a diagnostic.
  const hostOf = (text) => { try { return new URL(text).hostname || null; } catch { return null; } };
  const notContacted = (facts, reason, host) => facts.diagnostic?.({
    code: 'WEBHOOK_NOT_CONTACTED', severity: 'warning', stepId: facts.item.id, name: facts.item.name, entity: facts.entity, operation: facts.operation, stage: facts.stage,
    reason, host, message: 'The simulator contacts only loopback webhook endpoints. The step was treated as delivered and the endpoint was not called.',
  });
  const notDelivered = (facts, reason) => facts.diagnostic?.({
    code: 'WEBHOOK_NOT_DELIVERED', severity: 'warning', stepId: facts.item.id, name: facts.item.name, entity: facts.entity, operation: facts.operation, stage: facts.stage, reason,
    message: 'Only web hook (contract 8) endpoints are simulated; this endpoint was skipped.',
  });
  // The request to send, or null when nothing is sent: a contract other than 8 is skipped, and a missing or non-loopback endpoint is
  // not contacted (the step succeeds, recorded as not contacted).
  const requestFor = (facts) => {
    const endpoint = endpointOf(facts.item);
    if (endpoint && Number(endpoint.contract) !== WEBHOOK_CONTRACT) { notDelivered(facts, 'contract-not-simulated'); return null; }
    if (!endpoint) { notContacted(facts, 'missing-endpoint', null); return null; }
    if (!isLoopbackUrl(endpoint.url)) { notContacted(facts, 'non-loopback', hostOf(endpoint.url)); return null; }
    return requestOf(store, endpoint, facts);
  };
  // Whether the step is a contract other than 8 (it cannot be delivered in any form, so its async job is Canceled).
  const notSimulated = (item) => { const endpoint = endpointOf(item); return Boolean(endpoint) && Number(endpoint.contract) !== WEBHOOK_CONTRACT; };
  return {
    notSimulated,
    sync(facts) {
      const request = requestFor(facts);
      if (!request) return;
      const status = deliverSync(request);
      if (!(status >= 200 && status < 300)) throw unavailable();
    },
    async afterCommit(facts) {
      if (notSimulated(facts.item)) { requestFor(facts); return { canceled: CANCELED }; }
      const request = requestFor(facts);
      if (!request) return undefined;
      const status = await deliver(request);
      if (!(status >= 200 && status < 300)) throw unavailable();
      return undefined;
    },
  };
}
