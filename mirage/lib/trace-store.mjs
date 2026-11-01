// The local trace store: one per organization host, shared by every host of the runtime (docs/design/tracing.md).
// Spans nest through this module's own AsyncLocalStorage; without a current span the organization request context
// (request-context.mjs traceId / spanId) supplies the parent. Async job runners always parent explicitly.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { auditQuery, auditText, idMatches } from './audit-log.mjs';
import { currentRequest } from './request-context.mjs';
import { mergeTraceSettings, traceSettings } from './trace-settings.mjs';

const REDACTED = '[redacted]';
/** Every span status (D-R3-29): `running` until the span ends, then one of the other four. */
export const SPAN_STATUSES = Object.freeze(['ok', 'error', 'denied', 'cancelled', 'running']);
/** The span kinds of the span model; the `kind` filter refuses any other value (docs/design/tracing.md). */
export const SPAN_KINDS = Object.freeze([
  'http',
  'webapi',
  'dataverse',
  'function',
  'action',
  'batch',
  'part',
  'changeset',
  'bulk',
  'store',
  'permission',
  'plugin-stage',
  'plugin-step',
  'sdk-call',
  'custom-api',
  'secret',
  'http-out',
  'webhook',
  'job',
  'workflow',
  'server-logic',
  'flow-run',
  'flow-action',
  'connector',
  'render',
  'render-template',
  'read',
  'native-service',
  'form',
  'canvas',
  'internal',
]);
const STATUSES = SPAN_STATUSES.filter((status) => status !== 'running');
const SORTS = ['start', 'duration', 'spans', 'errors'];
// The search text of one span (D-R3-15): its metadata, attributes and events, then (level full) its payloads, each part
// bounded so a search never scans more than SEARCH_META + SEARCH_PAYLOAD characters of one span.
const SEARCH_META = 4096;
const SEARCH_PAYLOAD = 8192;
// File and binary columns (D-R3-10): a value under one of these keys, a data URL or a base64 string of more than 1 KB is
// summarised as { bytes, mimetype?, filename?, sha256 } instead of being copied.
const FILE_KEY = /^(?:documentbody|body)$|image/i;
const BASE64 = /^[A-Za-z0-9+/\r\n]+={0,2}$/;
const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[^;,]*)*;base64,/i;
const BASE64_MIN = 1024;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
// Inbound trace headers name only UUID-shaped ids, so a client can never choose a route name or another reserved word.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Credential-named keys, compared without separators (api_key, x-functions-key, client-secret); `sas` and `sig` only as
// whole keys.
const SECRET_KEY =
  /password|passwd|secret|token|authorization|authentication|cookie|credential|apikey|signature|sharedaccesssignature|authvalue|connectionstring|saskey|sharedaccesskey|accountkey|functionskey|functionkey|subscriptionkey|privatekey|^sas$|^sig$/i;
const MAX_EVENTS = 1000;
const MAX_DEPTH = 16;
const MAX_ITEMS = 1000;
const MAX_BUCKETS = 1000;
const MAX_REMEMBERED = 10_000;
const NICE_BUCKETS = [
  1, 5, 10, 50, 100, 500, 1000, 5000, 10_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000,
];
const NO_SESSION = Object.freeze({ visitorId: null, sessionKey: null });
const NO_ORIGIN = Object.freeze({ host: null, portal: null, preset: null });
const SYSTEM_ACTOR = Object.freeze({ kind: 'system', id: null, name: null });
/** The frame types a store listener observes (subscribe's `events` option). */
export const TRACE_EVENTS = Object.freeze(['span-start', 'span-end', 'trace-end']);
const PARENT_HEADER = 'x-sim-parent-trace';
const TRACE_HEADER = 'x-sim-trace-id';
const TRACE_ID_HEADER = 'x-trace-id';
const SPAN_HEADER = 'x-sim-span-id';

const round = (value) => Math.round(value * 100) / 100;
const validId = (value) => (typeof value === 'string' && ID.test(value) ? value : null);
// secretName holds a Key Vault secret's name from a reference (secret spans), never its value, so it stays readable.
const NAME_KEYS = new Set(['secretName']);
const secretKey = (key) => !NAME_KEYS.has(String(key)) && SECRET_KEY.test(String(key).replace(/[^A-Za-z0-9]/g, ''));
const orNull = (value) => (value === undefined || value === null || value === '' ? null : String(value));
const lower = (value) => String(value ?? '').toLowerCase();
const actorKey = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();

/** The span status for an HTTP answer: 401 and 403 are `denied`, other 4xx and 5xx `error`, anything else `ok`. */
export function statusFromHttp(status) {
  const code = Number(status);
  return code === 401 || code === 403 ? 'denied' : code >= 400 ? 'error' : 'ok';
}

// Base64 of binary content: only base64 characters, a whole number of 4-character groups (line breaks aside), and upper
// case, lower case and a digit or + or /, so a long word, hex string or repeated letter is never taken for a file.
const looksBase64 = (text) =>
  BASE64.test(text) &&
  text.replaceAll('\r', '').replaceAll('\n', '').length % 4 === 0 &&
  /[a-z]/.test(text) &&
  /[A-Z]/.test(text) &&
  /[0-9+/]/.test(text);

// { bytes, mimetype?, filename?, sha256 } of a file column value (decoded bytes), or null when the value is not one.
// documentbody is always a file; body and *image* keys hold one when the value is binary, a data URL or base64 of at
// least 64 characters; any other key only when the value is a data URL or base64 longer than 1 KB.
function fileSummary(key, value, siblings) {
  const named = FILE_KEY.test(key);
  let bytes,
    mimetype = null;
  if (named && (value instanceof ArrayBuffer || ArrayBuffer.isView(value)))
    bytes = Buffer.from(value instanceof ArrayBuffer ? value : value.buffer, value.byteOffset ?? 0, value.byteLength);
  else if (typeof value === 'string') {
    const data = DATA_URL.exec(value);
    const text = data ? value.slice(data[0].length) : value;
    const file =
      data ||
      (/^documentbody$/i.test(key) && value !== '') ||
      (text.length >= (named ? 64 : BASE64_MIN + 1) && looksBase64(text));
    if (!file) return null;
    bytes = Buffer.from(text, 'base64');
    mimetype = data?.[1] ?? null;
  } else return null;
  const sibling = (name) => (typeof siblings?.[name] === 'string' ? auditText(siblings[name], 300) : null);
  mimetype = sibling('mimetype') ?? mimetype;
  const filename = sibling('filename') ?? sibling('name');
  return {
    bytes: bytes.length,
    ...(mimetype ? { mimetype } : {}),
    ...(filename && /^(?:documentbody|body)$/i.test(key) ? { filename } : {}),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function clean(value, limit, depth, seen) {
  switch (typeof value) {
    case 'string':
      return auditText(value, limit);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return String(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }
  if (value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof URLSearchParams) return auditQuery(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof Error)
    return { name: value.name, code: clean(value.code, 160, depth, seen), message: auditText(value.message, 2000) };
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth limit]';
  seen.add(value);
  const source = value instanceof Map ? Object.fromEntries(value) : value instanceof Set ? [...value] : value;
  let result;
  if (Array.isArray(source))
    result = source.slice(0, MAX_ITEMS).map((item) => clean(item, limit, depth + 1, seen) ?? null);
  else {
    // A DataContract { key, value } pair whose key names a credential hides its value.
    const pair = typeof source.key === 'string' && 'value' in source && secretKey(source.key);
    result = {};
    for (const key of Object.keys(source).slice(0, MAX_ITEMS)) {
      const item = source[key];
      if ((pair && key === 'value') || secretKey(key)) result[key] = item == null ? item : REDACTED;
      else {
        // A { key, value } pair names its column in key (SOAP attribute collections).
        const column = key === 'value' && typeof source.key === 'string' ? source.key : key;
        const file = item != null && fileSummary(column, item, source);
        const cleaned = file || clean(item, limit, depth + 1, seen);
        if (cleaned !== undefined) result[key] = cleaned;
      }
    }
  }
  seen.delete(value);
  return result;
}

/**
 * A JSON-safe copy of `value` with credential-named keys, bearer tokens and secret conditions redacted, file and binary
 * columns summarised as { bytes, mimetype?, filename?, sha256 }, capped at `limitBytes` of JSON.
 */
export function redactPayload(value, limitBytes = 16_384) {
  const cleaned =
    (typeof value === 'string' && fileSummary('', value, null)) || clean(value, limitBytes, 0, new WeakSet());
  const json = JSON.stringify(cleaned) ?? 'null';
  const bytes = Buffer.byteLength(json);
  if (bytes <= limitBytes) return { value: cleaned ?? null, bytes };
  const preview = Buffer.from(json)
    .subarray(0, Math.max(0, limitBytes - 96))
    .toString('utf8');
  return { value: { truncated: true, bytes, preview }, bytes: limitBytes };
}

function capture(thunk, limit) {
  try {
    return redactPayload(typeof thunk === 'function' ? thunk() : thunk, limit);
  } catch (error) {
    return { value: { captureError: auditText(error?.message ?? error, 500) }, bytes: 0 };
  }
}

function flat(attributes) {
  const result = {};
  if (!attributes || typeof attributes !== 'object') return result;
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (value === undefined) continue;
    result[key] = secretKey(key)
      ? REDACTED
      : typeof value === 'string'
        ? auditText(value, 2000)
        : value === null || typeof value === 'number' || typeof value === 'boolean'
          ? value
          : clean(value, 2048, 0, new WeakSet());
  }
  return result;
}

// The memory estimate (status()) is kept as spans change: a fixed cost per span and per event, plus key and string
// lengths of attributes and messages (JSON only for the rare structured attribute) and the captured payload bytes.
const jsonLength = (value) => (value === undefined ? 0 : (JSON.stringify(value)?.length ?? 0));
const valueBytes = (value) =>
  typeof value === 'string' ? value.length : value !== null && typeof value === 'object' ? jsonLength(value) : 8;
const attributeBytes = (attributes) => {
  let bytes = 0;
  for (const key in attributes) bytes += key.length + valueBytes(attributes[key]);
  return bytes;
};
// Merges flat attributes into a record's attributes; returns the change of the estimate.
const merge = (target, incoming) => {
  let delta = 0;
  for (const key in incoming) {
    if (key in target) delta -= key.length + valueBytes(target[key]);
    delta += key.length + valueBytes(incoming[key]);
    target[key] = incoming[key];
  }
  return delta;
};

// The facts an error keeps besides code and message (D-R3-4, D-R3-19): scalars only, strings capped.
const ERROR_FACTS = ['status', 'type', 'action', 'parameter', 'pluginType', 'step', 'stage', 'depth', 'rolledBack'];
// A plug-in fault keeps its own code and status for the HTTP envelope and carries its trace identity (D-R3-19) as a
// non-enumerable traceError, which every span the error fails records instead.
function errorOf(error, nested = false) {
  if (error?.traceError && typeof error.traceError === 'object' && error.traceError !== error)
    return errorOf(error.traceError, nested);
  if (!error || typeof error !== 'object') return { code: 'Error', message: auditText(error, 2000) };
  const result = {
    code: auditText(error.code ?? error.name ?? 'Error', 160),
    message: auditText(error.message ?? '', 2000),
  };
  for (const key of ERROR_FACTS) {
    const value = key === 'status' ? (error.status ?? error.statusCode) : error[key];
    if (typeof value === 'string') result[key] = auditText(value, 300);
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  if (error.details !== undefined && error.details !== null)
    result.details = clean(error.details, 2048, 0, new WeakSet());
  if (!nested && error.cause && typeof error.cause === 'object') result.cause = errorOf(error.cause, true);
  return result;
}

/**
 * Records a handler's own error answer on span (D-R3-4): for an HTTP status of 400 or more, the span status becomes
 * statusFromHttp(status) and its error { code, message, status, details? }; a lower status changes nothing. The no-op
 * span, an overflow handle and an ended span ignore it. Returns span.
 */
export function recordHttpError(span, status, { code, message, details } = {}) {
  const value = Number(status);
  if (!span?.enabled || !(value >= 400)) return span;
  span.setStatus(statusFromHttp(value));
  span.setError({ code: code ?? `Http${value}`, message: message ?? `HTTP ${value}`, status: value, details });
  return span;
}
const deniedError = (error) =>
  [401, 403].includes(error?.status ?? error?.statusCode) || /denied/i.test(String(error?.code ?? ''));

function actorOf(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    kind: String(value.kind ?? 'system'),
    id: orNull(value.id),
    name: value.name == null ? null : auditText(value.name, 200),
    ...(Array.isArray(value.roles) ? { roles: value.roles.slice(0, 100).map((role) => auditText(role, 200)) } : {}),
  };
}
const requestActor = (request) =>
  request?.initiator?.kind
    ? { kind: String(request.initiator.kind), id: orNull(request.initiator.id), name: null }
    : null;
const sessionOf = (value) =>
  value && typeof value === 'object'
    ? { visitorId: orNull(value.visitorId), sessionKey: orNull(value.sessionKey) }
    : null;
const originOf = (value) =>
  value && typeof value === 'object'
    ? { host: orNull(value.host), portal: orNull(value.portal), preset: orNull(value.preset) }
    : null;
const linksOf = (links) =>
  Array.isArray(links)
    ? links
        .filter((link) => validId(link?.spanId) || validId(link?.traceId))
        .map((link) => ({
          traceId: validId(link.traceId),
          spanId: validId(link.spanId),
          relation: String(link.relation ?? 'triggered'),
        }))
    : [];

// An inert handle: every method does nothing and returns the handle. The shared no-op (traceId null) stands for level
// off; an overflow handle (traceId set, spanId null) stands for every span a full trace refuses.
const OVERFLOWS = new WeakSet();
function inert(traceId) {
  const handle = {
    enabled: false,
    traceId,
    spanId: null,
    parentSpanId: null,
    kind: null,
    name: null,
    module: null,
    operation: null,
    entity: null,
    recordId: null,
    depth: 0,
    async: false,
  };
  for (const method of [
    'event',
    'set',
    'setName',
    'setActor',
    'setEntity',
    'setStatus',
    'setError',
    'setInput',
    'output',
    'end',
    'fail',
  ])
    handle[method] = () => handle;
  return Object.freeze(handle);
}
const NOOP = inert(null);
function overflowOf(trace) {
  if (!trace.overflow) {
    trace.overflow = inert(trace.traceId);
    OVERFLOWS.add(trace.overflow);
  }
  return trace.overflow;
}

let recordOf, startOf;
// A span handle: hook sites hold it; the store keeps the plain record (the D2 span shape) behind it.
class Span {
  #core;
  #trace;
  #record;
  #start;
  #status = null;
  constructor(core, trace, record, start) {
    this.#core = core;
    this.#trace = trace;
    this.#record = record;
    this.#start = start;
  }
  static {
    recordOf = (span) => span.#record;
    startOf = (span) => span.#start;
  }
  get enabled() {
    return true;
  }
  get traceId() {
    return this.#record.traceId;
  }
  get spanId() {
    return this.#record.spanId;
  }
  get parentSpanId() {
    return this.#record.parentSpanId;
  }
  get status() {
    return this.#record.status;
  }
  get kind() {
    return this.#record.kind;
  }
  get name() {
    return this.#record.name;
  }
  get module() {
    return this.#record.module;
  }
  get operation() {
    return this.#record.operation;
  }
  get entity() {
    return this.#record.entity;
  }
  get recordId() {
    return this.#record.recordId;
  }
  get depth() {
    return this.#record.depth;
  }
  get async() {
    return this.#record.async;
  }
  // The set* members change a running span; after end they are ignored.
  setName(name) {
    if (this.#record.status === 'running') this.#record.name = auditText(name ?? '', 300);
    return this;
  }
  setActor(actor) {
    const value = actorOf(actor);
    if (value && this.#record.status === 'running') this.#record.actor = value;
    return this;
  }
  setEntity(entity, recordId = null) {
    if (this.#record.status === 'running') {
      this.#record.entity = orNull(entity);
      this.#record.recordId = orNull(recordId);
      if (this.#record.entity) this.#trace.entities.add(this.#record.entity);
    }
    return this;
  }
  // The status end uses when it is given none (recordHttpError); `running` or an unknown status is ignored.
  setStatus(status) {
    if (this.#record.status === 'running' && STATUSES.includes(status)) this.#status = status;
    return this;
  }
  // The span's error ({ code, message, ...facts }, as for end) while it runs; a later end({ error }) replaces it.
  setError(error) {
    if (this.#record.status === 'running' && error != null) this.#record.error = errorOf(error);
    return this;
  }
  setInput(thunk) {
    return this.#capture('input', thunk);
  }
  #capture(key, thunk) {
    const settings = this.#core.settings();
    if (settings.level === 'full' && this.#record.status === 'running') {
      const captured = capture(thunk, settings.payloadBytes);
      this.#record[key] = captured.value;
      this.#core.grow(this.#trace, captured.bytes);
    }
    return this;
  }
  event(type, { message, attributes } = {}) {
    const record = this.#record;
    if (record.events.length >= MAX_EVENTS) {
      record.attributes.droppedEvents = (record.attributes.droppedEvents ?? 0) + 1;
      return this;
    }
    const entry = { offsetMs: round(this.#core.now() - this.#start), type: String(type) };
    if (message != null) entry.message = auditText(message, 4000);
    if (attributes) entry.attributes = flat(attributes);
    record.events.push(entry);
    this.#core.grow(this.#trace, 96 + (entry.message?.length ?? 0) + attributeBytes(entry.attributes));
    if (record.status !== 'running') this.#core.changed(this.#trace, record);
    return this;
  }
  set(attributes) {
    const value = flat(attributes);
    this.#core.grow(this.#trace, merge(this.#record.attributes, value));
    if ('auditId' in value) this.#core.audited(this);
    if (this.#record.status !== 'running') this.#core.changed(this.#trace, this.#record);
    return this;
  }
  output(thunk) {
    return this.#capture('output', thunk);
  }
  end({ status, error, attributes } = {}) {
    const record = this.#record;
    if (record.status !== 'running') return this;
    if (attributes) this.#core.grow(this.#trace, merge(record.attributes, flat(attributes)));
    if (error != null) record.error = errorOf(error);
    record.durationMs = round(this.#core.now() - this.#start);
    record.status = STATUSES.includes(status) ? status : (this.#status ?? (record.error ? 'error' : 'ok'));
    this.#core.ended(this.#trace, record, this.#start);
    return this;
  }
  fail(error) {
    return this.end({ error: error ?? 'Unknown failure', status: deniedError(error) ? 'denied' : 'error' });
  }
}

// A refused filter: RangeError { status: 400, code: 'InvalidTraceFilter', parameter }, the message starting with the
// filter name; an unknown enum value adds the value it got.
const invalid = (key, rule, got) =>
  Object.assign(new RangeError(`${key} ${rule}${got === undefined ? '' : ` (got ${JSON.stringify(String(got))})`}.`), {
    status: 400,
    code: 'InvalidTraceFilter',
    parameter: key,
  });
const oneOf = (key, value, allowed) => {
  if (value !== null && !allowed.includes(value)) throw invalid(key, `must be one of ${allowed.join(', ')}`, value);
  return value;
};

// The id prefix rule (DV-N4-3) is the audit log's, so traces and audit entries filter alike.
export { idMatches };

// entityNames(name) -> the lowercase table names a table filter stands for (a logical name and its entity set name).
function parseFilters(filters = {}, { entityNames = null } = {}) {
  const get = (key) => {
    const value = filters instanceof URLSearchParams ? filters.get(key) : filters?.[key];
    return value === undefined || value === null || value === '' ? null : value;
  };
  const text = (key) => (get(key) === null ? null : String(get(key)).trim().toLowerCase() || null);
  const exact = (key) => (get(key) === null ? null : String(get(key)).trim() || null);
  const integer = (key, min, max) => {
    const value = get(key);
    if (value === null) return null;
    if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max)
      throw invalid(key, `must be an integer from ${min} to ${max}`);
    return Number(value);
  };
  const time = (key) => {
    const value = get(key);
    if (value === null) return null;
    const ms =
      value instanceof Date
        ? value.getTime()
        : /^\d+(?:\.\d+)?$/.test(String(value))
          ? Number(value)
          : Date.parse(String(value));
    if (!Number.isFinite(ms)) throw invalid(key, 'must be an ISO date-time or epoch milliseconds');
    return ms;
  };
  const minDuration = get('minDurationMs');
  if (minDuration !== null && !(/^\d+(?:\.\d+)?$/.test(String(minDuration)) && Number.isFinite(Number(minDuration))))
    throw invalid('minDurationMs', 'must be a nonnegative number');
  const flag = get('hasErrors');
  if (flag !== null && ![true, false, 'true', 'false', '1', '0'].includes(flag))
    throw invalid('hasErrors', 'must be true or false');
  // result (D-M-2): a comma list of trace results; a trace matches when its summary status (running while a span runs,
  // else the root's status) is one of them.
  const resultList = text('result')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const value of resultList ?? []) oneOf('result', value, SPAN_STATUSES);
  const order = oneOf('order', text('order'), ['desc', 'asc']);
  const sort = oneOf('sort', text('sort'), SORTS);
  const span = {
    kind: oneOf('kind', text('kind'), SPAN_KINDS),
    module: text('module'),
    operation: text('operation'),
    // entity (or its D-M-2 name table): a logical or entity set name, matched as every name of that table.
    entity: tableNames(text('entity') ?? text('table'), entityNames),
    recordId: get('recordId') === null ? null : actorKey(get('recordId')).trim() || null,
    status: oneOf('status', text('status'), SPAN_STATUSES),
    host: text('host'),
    actorKind: text('actorKind'),
    actorId: get('actorId') === null ? null : actorKey(get('actorId')).trim() || null,
    sessionKey: exact('sessionKey'),
    visitorId: exact('visitorId'),
    portal: exact('portal'),
    auditId: exact('auditId'),
    search: text('search'),
  };
  return {
    span,
    spanFiltered: Object.values(span).some((value) => value !== null),
    from: time('from'),
    to: time('to'),
    traceId: exact('traceId'),
    result: resultList?.length ? new Set(resultList) : null,
    minDurationMs: minDuration === null ? null : Number(minDuration),
    hasErrors: flag === null ? null : [true, 'true', '1'].includes(flag),
    parentSpanId: exact('parentSpanId'),
    depth: integer('depth', 0, 10_000),
    page: integer('page', 1, Number.MAX_SAFE_INTEGER),
    pageSize: integer('pageSize', 1, 200),
    order: order ?? 'desc',
    sort: sort ?? 'start',
    bucketMs: integer('bucketMs', 1, Number.MAX_SAFE_INTEGER),
  };
}

const tableNames = (value, entityNames) => {
  if (value === null) return null;
  let names = [value];
  try {
    if (entityNames) names = entityNames(value) ?? names;
  } catch {
    /* an unresolvable name filters as itself */
  }
  return new Set(names.map((name) => String(name).toLowerCase()));
};

/**
 * The lowercase text the `search` filter looks in for a span record: name, kind, module, operation, entity, record id,
 * actor, error, attribute keys and values and event types, messages and attributes (at most 4096 characters), then the
 * captured input and output JSON (at most 8192; present only at level full). trace watch applies it to its frames.
 */
export function searchText(record) {
  const parts = [
    record.name,
    record.kind,
    record.module,
    record.operation,
    record.entity,
    record.recordId,
    record.actor?.name,
    record.actor?.id,
    record.error?.code,
    record.error?.message,
    JSON.stringify(record.attributes),
  ];
  let size = parts.reduce((sum, part) => sum + (part?.length ?? 0), 0);
  for (const event of record.events ?? []) {
    if (size > SEARCH_META) break;
    const attributes = event.attributes ? JSON.stringify(event.attributes) : '';
    parts.push(event.type, event.message, attributes);
    size += event.type.length + (event.message?.length ?? 0) + attributes.length;
  }
  let text = parts
    .filter((part) => part)
    .join('\n')
    .slice(0, SEARCH_META);
  const payload = [record.input, record.output]
    .filter((value) => value !== undefined)
    .map((value) => JSON.stringify(value))
    .join('\n');
  if (payload) text += `\n${payload.slice(0, SEARCH_PAYLOAD)}`;
  return text.toLowerCase();
}

/** Throws the RangeError { status: 400, code: 'InvalidTraceFilter', parameter } that query would throw for filters. */
export function checkTraceFilters(filters = {}) {
  parseFilters(filters);
}

function spanMatches(record, f, searchOf = searchText) {
  return (
    (!f.kind || record.kind === f.kind) &&
    (!f.module || lower(record.module) === f.module) &&
    (!f.operation || lower(record.operation) === f.operation) &&
    (!f.entity || f.entity.has(lower(record.entity))) &&
    (!f.recordId || (record.recordId !== null && idMatches(actorKey(record.recordId), f.recordId))) &&
    (!f.status || record.status === f.status) &&
    (!f.host || lower(record.origin.host) === f.host) &&
    (!f.actorKind || lower(record.actor.kind) === f.actorKind) &&
    (!f.actorId || (record.actor.id !== null && idMatches(actorKey(record.actor.id), f.actorId))) &&
    (!f.sessionKey || idMatches(record.session.sessionKey, f.sessionKey)) &&
    (!f.visitorId || idMatches(record.session.visitorId, f.visitorId)) &&
    (!f.portal || record.origin.portal === f.portal) &&
    (!f.auditId || record.attributes.auditId === f.auditId) &&
    (!f.search || searchOf(record).includes(f.search))
  );
}

const percentile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null;
// { count, errors /* status error */, p50, p95, max } over records; percentiles use ended spans only.
function figures(records) {
  const sorted = records
    .filter((record) => record.durationMs !== null)
    .map((record) => record.durationMs)
    .sort((a, b) => a - b);
  return {
    count: records.length,
    errors: records.filter((record) => record.status === 'error').length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
  };
}
const reference = (record) => ({
  traceId: record.traceId,
  spanId: record.spanId,
  parentSpanId: record.parentSpanId,
  kind: record.kind,
  name: record.name,
  entity: record.entity,
  status: record.status,
  startedAt: record.startedAt,
  durationMs: record.durationMs,
  ...(record.error ? { error: { ...record.error } } : {}),
});
const defaultBucket = (range) => {
  const raw = Math.ceil((range + 1) / 60);
  return NICE_BUCKETS.find((step) => step >= raw) ?? Math.ceil(raw / 3_600_000) * 3_600_000;
};
// A record without its captured payloads (payload-free listener copies).
const bare = ({ input: _input, output: _output, ...rest }) => rest;

/**
 * Creates the trace store. settings: a mirage.trace value (trace-settings.mjs); stateDirectory: the ignored state folder
 * (or a function returning it, read when a trace is persisted); now: epoch milliseconds (wall clock by default).
 */
export function createTraceStore({
  settings: initial = {},
  stateDirectory = null,
  entityNames = null,
  now = () => performance.timeOrigin + performance.now(),
} = {}) {
  let settings = traceSettings(initial);
  let sequence = 0,
    dropped = 0;
  // Store-wide counters over the retained traces, so status() never scans them.
  let running = 0,
    droppedSpans = 0,
    memoryBytes = 0;
  const traces = new Map(); // traceId -> trace, least recently touched first
  const spans = new Map(); // spanId -> Span
  const remembered = new Map(); // key -> { traceId, spanId }, least recently used first
  const listeners = new Map(); // listener -> { payloads, flush, events }
  const audits = new Map(); // audit entry id -> the retained span whose attributes.auditId names it
  const searches = new WeakMap(); // ended span record -> its search text, built by the first search that reads it
  const als = new AsyncLocalStorage();
  const persistence = { written: 0, failures: 0, lastError: null };
  const directories = new Set();
  let queue = Promise.resolve();

  const copy = (record) => structuredClone(record);
  const retained = (trace) => traces.get(trace.traceId) === trace;
  const directoryOf = () => (typeof stateDirectory === 'function' ? stateDirectory() : stateDirectory) || null;
  const totalOf = (trace) => round((trace.running ? Math.max(trace.lastEnd, now()) : trace.lastEnd) - trace.first);

  function summarize(trace, withRoot = true) {
    const rootRecord = recordOf(trace.root),
      kinds = trace.kinds;
    return {
      traceId: trace.traceId,
      sequence: rootRecord.sequence,
      latestSequence: recordOf(trace.spans.at(-1)).sequence,
      startedAt: rootRecord.startedAt,
      // The root's audit entry (Power Pages: the X-Sim-Trace-Id of the request), or null.
      auditId: typeof rootRecord.attributes.auditId === 'string' ? rootRecord.attributes.auditId : null,
      status: trace.running ? 'running' : rootRecord.status,
      ended: trace.running === 0,
      durationMs: rootRecord.durationMs,
      totalDurationMs: totalOf(trace),
      spanCount: trace.spans.length,
      droppedSpans: trace.droppedSpans,
      errorCount: trace.errorCount,
      deniedCount: trace.deniedCount,
      ...(trace.firstError ? { firstError: { ...trace.firstError } } : {}),
      pluginCount: kinds['plugin-step'] ?? 0,
      flowCount: kinds['flow-run'] ?? 0,
      connectorCount: kinds.connector ?? 0,
      dataverseCount: kinds.dataverse ?? 0,
      kinds: { ...kinds },
      entities: [...trace.entities],
      modules: [...trace.modules],
      ...(trace.evicted ? { evicted: true } : {}),
      ...(withRoot ? { root: copy(rootRecord) } : {}),
    };
  }

  const emit = (type, record, summary) => {
    if (!listeners.size) return;
    let full, slim;
    for (const [listener, { payloads, events, traceId }] of listeners) {
      if ((events && !events.has(type)) || (traceId && record.traceId !== traceId)) continue;
      const event = payloads
        ? (full ??= Object.freeze({ type, span: Object.freeze(copy(record)), ...(summary ? { trace: summary } : {}) }))
        : (slim ??= Object.freeze({
            type,
            span: Object.freeze(copy(bare(record))),
            ...(summary ? { trace: { ...summary, root: bare(summary.root) } } : {}),
          }));
      try {
        listener(event);
      } catch {
        /* an observer failure never affects request handling */
      }
    }
  };

  // Persistence: a line carries the spans added since the previous line of the trace (and the spans that line wrote
  // while they still ran). The line is built on a later turn (setImmediate), never inside the end that queued it.
  function persist(trace) {
    if (!settings.persist || trace.persistQueued) return;
    trace.persistQueued = true;
    queue = queue
      .then(() => new Promise((resolve) => setImmediate(resolve)))
      .then(() => {
        trace.persistQueued = false;
        const directory = directoryOf();
        if (!directory) {
          persistence.lastError = 'NoStateDirectory';
          return;
        }
        const fresh = [...trace.partial, ...trace.spans.slice(trace.persisted)];
        if (!fresh.length) return;
        trace.persisted = trace.spans.length;
        trace.partial = fresh.filter((span) => recordOf(span).status === 'running');
        const at = new Date(now()).toISOString();
        const folder = path.join(directory, 'traces');
        const line = `${JSON.stringify({
          persistedAt: at,
          traceId: trace.traceId,
          trace: summarize(trace),
          spans: fresh.map((span) => recordOf(span)),
          complete: trace.running === 0,
        })}\n`;
        return (async () => {
          if (!directories.has(folder)) {
            await fs.mkdir(folder, { recursive: true });
            directories.add(folder);
          }
          await fs.appendFile(path.join(folder, `${at.slice(0, 10)}.ndjson`), line);
          persistence.written++;
        })();
      })
      .catch((error) => {
        persistence.failures++;
        persistence.lastError = auditText(error?.message ?? error, 500);
      });
  }

  const evict = (trace) => {
    traces.delete(trace.traceId);
    for (const span of trace.spans) {
      const record = recordOf(span);
      spans.delete(record.spanId);
      if (audits.get(record.attributes.auditId) === span) audits.delete(record.attributes.auditId);
    }
    dropped++;
    running -= trace.running;
    droppedSpans -= trace.droppedSpans;
    memoryBytes -= trace.bytes;
    // A running trace leaves the store now: it ends for listeners and is persisted with its running spans.
    if (trace.running > 0) {
      trace.evicted = true;
      if (listeners.size) emit('trace-end', recordOf(trace.root), summarize(trace));
      persist(trace);
    }
  };

  const core = {
    now,
    settings: () => settings,
    grow(trace, bytes) {
      trace.bytes += bytes;
      if (retained(trace)) memoryBytes += bytes;
    },
    ended(trace, record, start) {
      trace.running--;
      const kept = retained(trace);
      if (kept) running--;
      if (record.status === 'error') trace.errorCount++;
      // The first span of the trace that ended error or denied (the trace list shows its message).
      if ((record.status === 'error' || record.status === 'denied') && !trace.firstError)
        trace.firstError = {
          spanId: record.spanId,
          kind: record.kind,
          name: record.name,
          status: record.status,
          code: record.error?.code ?? null,
          message: record.error?.message ?? null,
        };
      if (record.status === 'denied') trace.deniedCount++;
      trace.lastEnd = Math.max(trace.lastEnd, start + record.durationMs);
      emit('span-end', record);
      // A trace ends when its last running span ends; a later async segment re-opens it and it ends again. A trace
      // evicted while running is persisted once more when its last span ends.
      if (trace.running === 0 && (kept || trace.evicted)) {
        if (kept && listeners.size) emit('trace-end', recordOf(trace.root), summarize(trace));
        persist(trace);
      }
    },
    // A span that names an audit entry (attributes.auditId): fromHeaders resolves an inbound X-Sim-Trace-Id through it.
    audited(span) {
      const auditId = recordOf(span).attributes.auditId;
      if (typeof auditId === 'string' && traces.has(recordOf(span).traceId)) audits.set(auditId, span);
    },
    // An ended span changed (a late event or attribute): its cached search text is stale.
    changed(trace, record) {
      const text = searches.get(record);
      if (text === undefined) return;
      searches.delete(record);
      core.grow(trace, -text.length);
    },
  };
  // The search text of a span (searchText); cached once the span has ended and counted in the memory estimate.
  const searchOf = (record) => {
    let text = searches.get(record);
    if (text !== undefined) return text;
    text = searchText(record);
    const trace = record.status === 'running' ? null : traces.get(record.traceId);
    if (trace) {
      searches.set(record, text);
      core.grow(trace, text.length);
    }
    return text;
  };

  const SORT_KEYS = {
    start: () => 0,
    duration: (trace) => totalOf(trace),
    spans: (trace) => trace.spans.length,
    errors: (trace) => trace.errorCount * 1e6 + trace.deniedCount,
  };
  // The result filter: the trace's summary status is one of the listed results.
  const resultMatches = (trace, f) =>
    !f.result || f.result.has(trace.running ? 'running' : recordOf(trace.root).status);
  // The matching traces (internal objects), sorted; summaries are built only for what a caller returns.
  function matchedTraces(f) {
    const rows = [];
    const timed = f.from !== null || f.to !== null;
    const inRange = (start) => (f.from === null || start >= f.from) && (f.to === null || start <= f.to);
    for (const trace of traces.values()) {
      if (f.traceId && trace.traceId !== f.traceId) continue;
      if (!resultMatches(trace, f)) continue;
      // A trace matches the time range when any of its spans starts in it.
      if (timed) {
        if ((f.from !== null && trace.lastStart < f.from) || (f.to !== null && trace.first > f.to)) continue;
        if (!trace.spans.some((span) => inRange(startOf(span)))) continue;
      }
      if (f.spanFiltered && !trace.spans.some((span) => spanMatches(recordOf(span), f.span, searchOf))) continue;
      if (f.minDurationMs !== null && totalOf(trace) < f.minDurationMs) continue;
      if (f.hasErrors !== null && trace.errorCount > 0 !== f.hasErrors) continue;
      rows.push(trace);
    }
    const key = SORT_KEYS[f.sort],
      direction = f.order === 'asc' ? 1 : -1;
    return rows
      .map((trace) => [key(trace), recordOf(trace.root).sequence, trace])
      .sort((a, b) => direction * (a[0] - b[0] || a[1] - b[1]))
      .map((row) => row[2]);
  }
  function matchedSpans(f) {
    const rows = [];
    for (const trace of traces.values()) {
      if (f.traceId && trace.traceId !== f.traceId) continue;
      if (!resultMatches(trace, f)) continue;
      for (const span of trace.spans) {
        const record = recordOf(span),
          start = startOf(span);
        if ((f.from !== null && start < f.from) || (f.to !== null && start > f.to)) continue;
        if (f.minDurationMs !== null && !(record.durationMs >= f.minDurationMs)) continue;
        if (f.hasErrors !== null && (record.status === 'error') !== f.hasErrors) continue;
        if (f.parentSpanId && record.parentSpanId !== f.parentSpanId) continue;
        if (f.depth !== null && record.depth !== f.depth) continue;
        if (f.spanFiltered && !spanMatches(record, f.span, searchOf)) continue;
        rows.push(span);
      }
    }
    return rows.sort((a, b) =>
      f.order === 'asc' ? recordOf(a).sequence - recordOf(b).sequence : recordOf(b).sequence - recordOf(a).sequence,
    );
  }
  function paged(rows, f, map) {
    const pageSize = f.pageSize ?? 25,
      pageCount = Math.max(1, Math.ceil(rows.length / pageSize)),
      page = Math.min(f.page ?? 1, pageCount);
    return {
      items: rows.slice((page - 1) * pageSize, page * pageSize).map(map),
      total: rows.length,
      page,
      pageSize,
      pageCount,
      retained: traces.size,
      dropped,
      latestSequence: sequence,
    };
  }
  function treeOf(trace) {
    const flatSpans = trace.spans.map((span) => copy(recordOf(span)));
    const nodes = new Map(flatSpans.map((record) => [record.spanId, { ...record, children: [] }]));
    const children = [];
    for (const node of nodes.values()) {
      const parent = node.parentSpanId && nodes.get(node.parentSpanId);
      (parent ? parent.children : children).push(node);
    }
    const summary = summarize(trace);
    return { trace: summary, root: summary.root, spans: flatSpans, children };
  }

  const store = {
    /** False when the level is off (start returns the shared no-op span). */
    get enabled() {
      return settings.level !== 'off';
    },
    /**
     * Opens a span under the explicit parent, else the current span, else the request context span. A full trace
     * refuses it with the trace's overflow handle.
     */
    start(args = {}) {
      if (settings.level === 'off') return NOOP;
      let parent = null,
        parentSpanId = null,
        named = null,
        request = null;
      const links = linksOf(args.links);
      if (args.parentSpanId !== undefined || args.traceId !== undefined) {
        named = validId(args.traceId);
        parentSpanId = validId(args.parentSpanId);
      } else {
        const current = als.getStore();
        if (OVERFLOWS.has(current)) named = current.traceId;
        else if (current) parent = current;
        else {
          request = currentRequest();
          named = validId(request?.traceId);
          parentSpanId = validId(request?.spanId);
        }
      }
      if (!parent && parentSpanId) {
        // A retained parent decides the trace; an unknown one leaves its id as a link and the span goes under the named
        // trace's root when that trace is retained, else it is a root.
        parent = spans.get(parentSpanId) ?? null;
        if (!parent) {
          if (!links.some((link) => link.spanId === parentSpanId))
            links.push({ traceId: named, spanId: parentSpanId, relation: 'parent-request' });
          parent = (named && traces.get(named)?.root) || null;
        }
      }
      const traceId = parent?.traceId ?? named ?? randomUUID();
      let trace = traces.get(traceId);
      if (trace && trace.spans.length >= settings.spansPerTrace) {
        trace.droppedSpans++;
        droppedSpans++;
        return overflowOf(trace);
      }
      if (trace) traces.delete(traceId);
      else
        trace = {
          traceId,
          spans: [],
          root: null,
          running: 0,
          droppedSpans: 0,
          bytes: 0,
          errorCount: 0,
          firstError: null,
          deniedCount: 0,
          kinds: {},
          entities: new Set(),
          modules: new Set(),
          first: Infinity,
          lastStart: -Infinity,
          lastEnd: -Infinity,
          persisted: 0,
          partial: [],
          persistQueued: false,
          evicted: false,
          overflow: null,
        };
      traces.set(traceId, trace);
      while (traces.size > settings.traces) evict(traces.values().next().value);
      const parentRecord = parent ? recordOf(parent) : null;
      const start = now();
      const record = {
        traceId,
        spanId: randomUUID(),
        parentSpanId: parent?.spanId ?? null,
        sequence: ++sequence,
        kind: String(args.kind ?? 'internal'),
        name: auditText(args.name ?? args.kind ?? '', 300),
        module: orNull(args.module),
        operation: args.operation == null ? null : String(args.operation).toLowerCase(),
        entity: orNull(args.entity),
        recordId: orNull(args.recordId),
        startedAt: new Date(start).toISOString(),
        durationMs: null,
        status: 'running',
        depth: parentRecord ? parentRecord.depth + 1 : 0,
        level: settings.level,
        async: args.async === true,
        actor: actorOf(args.actor) ?? parentRecord?.actor ?? requestActor(request ?? currentRequest()) ?? SYSTEM_ACTOR,
        session: sessionOf(args.session) ?? parentRecord?.session ?? NO_SESSION,
        origin: originOf(args.origin) ?? parentRecord?.origin ?? NO_ORIGIN,
        attributes: flat(args.attributes),
        events: [],
        links,
      };
      let bytes = 512 + attributeBytes(record.attributes);
      if (settings.level === 'full' && args.input !== undefined) {
        const captured = capture(args.input, settings.payloadBytes);
        record.input = captured.value;
        bytes += captured.bytes;
      }
      const span = new Span(core, trace, record, start);
      trace.spans.push(span);
      if (!trace.root || (recordOf(trace.root).parentSpanId !== null && record.parentSpanId === null))
        trace.root = span;
      trace.kinds[record.kind] = (trace.kinds[record.kind] ?? 0) + 1;
      if (record.entity) trace.entities.add(record.entity);
      if (record.module) trace.modules.add(record.module);
      trace.first = Math.min(trace.first, start);
      trace.lastStart = Math.max(trace.lastStart, start);
      trace.running++;
      running++;
      trace.bytes += bytes;
      memoryBytes += bytes;
      spans.set(record.spanId, span);
      if ('auditId' in record.attributes) core.audited(span);
      emit('span-start', record);
      return span;
    },
    /** Runs fn with span (or an overflow handle) as the current span for everything synchronous and awaited inside it. */
    run(span, fn) {
      return span instanceof Span || OVERFLOWS.has(span) ? als.run(span, fn) : fn();
    },
    /** Runs fn outside every current span of this store (the request context is left as it is). */
    detached(fn) {
      return als.exit(fn);
    },
    /** start + run + end (or fail on a throw or rejection); fn receives the span. */
    wrap(args, fn) {
      const span = store.start(args);
      let result;
      try {
        result = store.run(span, () => fn(span));
      } catch (error) {
        span.fail(error);
        throw error;
      }
      if (result && typeof result.then === 'function')
        return result.then(
          (value) => {
            span.end();
            return value;
          },
          (error) => {
            span.fail(error);
            throw error;
          },
        );
      span.end();
      return result;
    },
    /**
     * The current span (this store's stack, else the request context span), the overflow handle of a full trace the
     * request context names without a span, or null.
     */
    current() {
      const span = als.getStore();
      if (span) return span;
      const request = currentRequest();
      const spanId = validId(request?.spanId);
      if (spanId) return spans.get(spanId) ?? null;
      const trace = traces.get(validId(request?.traceId));
      return trace && trace.spans.length >= settings.spansPerTrace ? overflowOf(trace) : null;
    },
    /**
     * Outbound loopback headers that make the receiving root join the span's trace (D-M-4): x-trace-id, and for a
     * recorded span x-sim-parent-trace and x-sim-span-id (the span id). x-sim-trace-id is sent only when the span or a
     * retained ancestor names an audit entry (attributes.auditId), with that audit id, never the trace id. An overflow
     * handle sends x-trace-id (and the audit id of its trace's root).
     */
    headers(span = store.current()) {
      const audited = (start) => {
        for (let at = start; at; at = spans.get(recordOf(at).parentSpanId)) {
          const auditId = recordOf(at).attributes.auditId;
          if (typeof auditId === 'string') return { [TRACE_HEADER]: auditId };
        }
        return {};
      };
      if (span instanceof Span)
        return {
          [PARENT_HEADER]: span.spanId,
          [SPAN_HEADER]: span.spanId,
          [TRACE_ID_HEADER]: span.traceId,
          ...audited(span),
        };
      return OVERFLOWS.has(span) ? { [TRACE_ID_HEADER]: span.traceId, ...audited(traces.get(span.traceId)?.root) } : {};
    },
    /**
     * { traceId, parentSpanId } from inbound headers (null when absent or not a UUID); spread into start for a root. The
     * trace id is x-trace-id only and the parent x-sim-parent-trace. x-sim-trace-id is an audit id (D-M-4), never a trace
     * id: without a parent header, a retained span whose attributes.auditId names it is the parent (its trace unless
     * x-trace-id names one); an unknown audit id is ignored.
     */
    fromHeaders(headers = {}) {
      const read = (name) => {
        const raw = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
        const value = Array.isArray(raw) ? raw[0] : raw;
        return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
      };
      const traceId = read(TRACE_ID_HEADER),
        parentSpanId = read(PARENT_HEADER);
      const audited = parentSpanId ? null : audits.get(read(TRACE_HEADER));
      return audited
        ? { traceId: traceId ?? audited.traceId, parentSpanId: audited.spanId }
        : { traceId, parentSpanId };
    },
    /** Remembers which span a later piece of work (a job, a flow run) belongs to: key -> { traceId, spanId }. */
    remember(key, { traceId, spanId } = {}) {
      const value = { traceId: validId(traceId), spanId: validId(spanId) };
      if (typeof key !== 'string' || !value.traceId) return;
      remembered.delete(key);
      remembered.set(key, value);
      if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
    },
    /** The { traceId, spanId } remembered for key, or null. */
    recall(key) {
      const value = remembered.get(key);
      if (!value) return null;
      remembered.delete(key);
      remembered.set(key, value);
      return { ...value };
    },
    /**
     * Adds one link { traceId, spanId, relation } (relation 'triggered' by default) to the retained span spanId, running
     * or ended: how a job runner, which holds only the recalled { traceId, spanId }, marks its staging span (D-R3-6). An
     * identical { spanId, relation } link, an unknown span, a link without ids and level off are ignored. A linked span
     * that was already persisted is written again in the trace's next line. Returns true when the link was added.
     */
    link(spanId, link = {}) {
      if (settings.level === 'off') return false;
      const span = spans.get(spanId);
      const [value] = linksOf([link]);
      if (!span || !value) return false;
      const record = recordOf(span);
      if (record.links.some((item) => item.spanId === value.spanId && item.relation === value.relation)) return false;
      record.links.push(value);
      const trace = traces.get(record.traceId);
      if (!trace) return true;
      core.grow(trace, 128);
      if (settings.persist && !trace.partial.includes(span) && trace.spans.indexOf(span) < trace.persisted) {
        trace.partial.push(span);
        if (trace.running === 0) persist(trace);
      }
      return true;
    },
    /** Trace summaries matching the filters, newest first by default, paged. */
    query(filters = {}) {
      const f = parseFilters(filters, { entityNames });
      return paged(matchedTraces(f), f, (trace) => summarize(trace));
    },
    /** Flat spans matching the filters (also parentSpanId and depth), paged. */
    spans(filters = {}) {
      const f = parseFilters(filters, { entityNames });
      return paged(matchedSpans(f), f, (span) => copy(recordOf(span)));
    },
    /** One trace: its summary, root, flat spans in sequence order and the nested children tree; null when unknown. */
    tree(traceId) {
      const trace = traces.get(traceId);
      return trace ? treeOf(trace) : null;
    },
    /** One span (a copy), or null. */
    span(spanId) {
      const span = spans.get(spanId);
      return span ? copy(recordOf(span)) : null;
    },
    /** The retained spans from the trace root down to spanId (inclusive); [] when unknown. */
    ancestry(spanId) {
      const chain = [];
      for (let span = spans.get(spanId); span; span = spans.get(recordOf(span).parentSpanId))
        chain.unshift(copy(recordOf(span)));
      return chain;
    },
    /** Duration percentiles and counts by kind, module, entity, operation, actor and status, a timeline and the slowest and failed spans. */
    stats(filters = {}) {
      const f = parseFilters(filters, { entityNames });
      const matched = matchedSpans({ ...f, order: 'asc' });
      const groups = {
        byKind: new Map(),
        byModule: new Map(),
        byEntity: new Map(),
        byOperation: new Map(),
        byActor: new Map(),
        byStatus: new Map(),
      };
      const add = (map, key, record) => {
        if (key === null || key === undefined) return;
        let group = map.get(key);
        if (!group) map.set(key, (group = []));
        group.push(record);
      };
      const finish = (map) => Object.fromEntries([...map].map(([key, group]) => [key, figures(group)]));
      const records = matched.map((span) => recordOf(span));
      for (const record of records) {
        add(groups.byKind, record.kind, record);
        add(groups.byModule, record.module, record);
        add(groups.byEntity, record.entity, record);
        add(groups.byOperation, record.operation, record);
        add(groups.byActor, record.actor.id ? `${record.actor.kind}:${record.actor.id}` : record.actor.kind, record);
        add(groups.byStatus, record.status, record);
      }
      const starts = matched.map((span) => startOf(span));
      const from = f.from ?? (starts.length ? starts.reduce((a, b) => Math.min(a, b)) : null),
        to = f.to ?? (starts.length ? starts.reduce((a, b) => Math.max(a, b)) : null);
      let bucketMs = null;
      const timeline = [];
      if (from !== null && to !== null && to >= from) {
        bucketMs = f.bucketMs ?? defaultBucket(to - from);
        const count = Math.floor((to - from) / bucketMs) + 1;
        if (count > MAX_BUCKETS) throw invalid('bucketMs', `gives more than ${MAX_BUCKETS} buckets for this range`);
        const buckets = Array.from({ length: count }, () => ({ count: 0, errors: 0, durations: [] }));
        matched.forEach((span, index) => {
          const bucket = buckets[Math.floor((starts[index] - from) / bucketMs)];
          if (!bucket) return;
          const record = recordOf(span);
          bucket.count++;
          if (record.status === 'error') bucket.errors++;
          if (record.durationMs !== null) bucket.durations.push(record.durationMs);
        });
        buckets.forEach((bucket, index) =>
          timeline.push({
            bucketStart: new Date(from + index * bucketMs).toISOString(),
            count: bucket.count,
            errors: bucket.errors,
            p95: percentile(
              bucket.durations.sort((a, b) => a - b),
              0.95,
            ),
          }),
        );
      }
      return {
        count: records.length,
        overall: figures(records),
        roots: figures(matchedTraces(f).map((trace) => recordOf(trace.root))),
        from: from === null ? null : new Date(from).toISOString(),
        to: to === null ? null : new Date(to).toISOString(),
        bucketMs,
        ...Object.fromEntries(Object.entries(groups).map(([name, map]) => [name, finish(map)])),
        timeline,
        slowest: records
          .filter((record) => record.durationMs !== null)
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, 10)
          .map(reference),
        errors: records
          .filter((record) => record.status === 'error')
          .reverse()
          .slice(0, 10)
          .map(reference),
      };
    },
    /**
     * Observes { type: 'span-start'|'span-end'|'trace-end', span, trace? } with frozen copies (without input and output
     * when payloads is false); returns an unsubscribe function. flush: an optional () => Promise that flush() awaits
     * (an SSE channel resolves it once its frames reached every client). events: one TRACE_EVENTS type or a list of
     * them the listener receives (default all); traceId: only frames of that trace. No copy is made for a frame no
     * listener takes.
     */
    subscribe(listener, { payloads = true, flush = null, events = null, traceId = null } = {}) {
      if (typeof listener !== 'function') throw new TypeError('Trace listeners must be functions.');
      if (flush !== null && typeof flush !== 'function') throw new TypeError('A listener flush must be a function.');
      const types = events === null ? null : [].concat(events);
      if (types && (!types.length || types.some((type) => !TRACE_EVENTS.includes(type))))
        throw new TypeError(`Trace listener events must be one or more of ${TRACE_EVENTS.join(', ')}.`);
      if (traceId !== null && typeof traceId !== 'string') throw new TypeError('A listener traceId must be a string.');
      listeners.set(listener, {
        payloads: payloads !== false,
        flush,
        events: types && new Set(types),
        traceId: traceId || null,
      });
      return () => listeners.delete(listener);
    },
    /** Every trace matching the filters (no paging) as trees, with the settings in force. */
    export(filters = {}) {
      const f = parseFilters(filters, { entityNames });
      return {
        exportedAt: new Date(now()).toISOString(),
        settings: { ...settings },
        traces: matchedTraces(f).map(treeOf),
      };
    },
    /** Drops every retained trace and remembered key and resets the dropped counter; returns status(). */
    clear() {
      traces.clear();
      spans.clear();
      audits.clear();
      remembered.clear();
      dropped = 0;
      running = 0;
      droppedSpans = 0;
      memoryBytes = 0;
      return store.status();
    },
    /** A copy of the settings in force. */
    settings() {
      return { ...settings };
    },
    /** Applies a partial settings change at run time (validated like mirage.trace); returns the new settings. */
    configure(partial = {}) {
      settings = mergeTraceSettings(settings, partial);
      while (traces.size > settings.traces) evict(traces.values().next().value);
      return store.settings();
    },
    /** Counts, a memory estimate, dropped counters and the persistence state. */
    status() {
      let directory = null;
      try {
        directory = directoryOf();
      } catch {
        /* an unresolved state folder reads as none */
      }
      return {
        level: settings.level,
        enabled: settings.level !== 'off',
        retained: traces.size,
        spans: spans.size,
        running,
        dropped,
        droppedSpans,
        latestSequence: sequence,
        memoryBytes,
        listeners: listeners.size,
        persist: {
          enabled: settings.persist,
          directory: directory ? path.join(directory, 'traces') : null,
          ...persistence,
          lastError: settings.persist && !directory ? 'NoStateDirectory' : persistence.lastError,
        },
      };
    },
    /**
     * Resolves (never rejects) once every persisted line queued so far, and any queued while waiting, is written or has
     * failed, and every subscriber's flush (SSE frames handed to the socket) has settled. Spans still running are not
     * waited for: their trace is persisted when it ends.
     */
    async flush() {
      const subscribers = Promise.allSettled(
        [...listeners.values()].filter(({ flush }) => flush).map(({ flush }) => Promise.resolve().then(flush)),
      );
      for (let pending = null; pending !== queue;) await (pending = queue);
      await subscribers;
    },
  };
  return Object.freeze(store);
}
