// The local trace store: one per organization host, shared by every host of the runtime (docs/design/tracing.md).
// Spans nest through this module's own AsyncLocalStorage; without a current span the organization request context
// (request-context.mjs traceId / spanId) supplies the parent. Async job runners always parent explicitly.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { auditQuery, auditText } from './audit-log.mjs';
import { currentRequest } from './request-context.mjs';
import { mergeTraceSettings, traceSettings } from './trace-settings.mjs';

const REDACTED = '[redacted]';
const STATUSES = ['ok', 'error', 'denied'];
const SORTS = ['start', 'duration', 'spans', 'errors'];
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
// Inbound trace headers name only UUID-shaped ids, so a client can never choose a route name or another reserved word.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Credential-named keys, compared without separators (api_key, x-functions-key, client-secret); `sas` and `sig` only as
// whole keys.
const SECRET_KEY =
  /password|passwd|secret|token|authorization|authentication|cookie|credential|apikey|signature|sharedaccesssignature|authvalue|connectionstring|saskey|sharedaccesskey|accountkey|functionskey|functionkey|^sas$|^sig$/i;
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
const PARENT_HEADER = 'x-sim-parent-trace';
const TRACE_HEADER = 'x-sim-trace-id';
const TRACE_ID_HEADER = 'x-trace-id';

const round = (value) => Math.round(value * 100) / 100;
const validId = (value) => (typeof value === 'string' && ID.test(value) ? value : null);
const secretKey = (key) => SECRET_KEY.test(String(key).replace(/[^A-Za-z0-9]/g, ''));
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
        const cleaned = clean(item, limit, depth + 1, seen);
        if (cleaned !== undefined) result[key] = cleaned;
      }
    }
  }
  seen.delete(value);
  return result;
}

/** A JSON-safe copy of `value` with credential-named keys, bearer tokens and secret conditions redacted, capped at `limitBytes` of JSON. */
export function redactPayload(value, limitBytes = 16_384) {
  const cleaned = clean(value, limitBytes, 0, new WeakSet());
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

const errorOf = (error) =>
  error && typeof error === 'object'
    ? { code: auditText(error.code ?? error.name ?? 'Error', 160), message: auditText(error.message ?? '', 2000) }
    : { code: 'Error', message: auditText(error, 2000) };
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
  for (const method of ['event', 'set', 'setName', 'setActor', 'setEntity', 'setInput', 'output', 'end', 'fail'])
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
    return this;
  }
  set(attributes) {
    this.#core.grow(this.#trace, merge(this.#record.attributes, flat(attributes)));
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
    record.status = STATUSES.includes(status) ? status : record.error ? 'error' : 'ok';
    this.#core.ended(this.#trace, record, this.#start);
    return this;
  }
  fail(error) {
    return this.end({ error: error ?? 'Unknown failure', status: deniedError(error) ? 'denied' : 'error' });
  }
}

const invalid = (key, rule) =>
  Object.assign(new RangeError(`${key} ${rule}.`), { status: 400, code: 'InvalidTraceFilter' });

function parseFilters(filters = {}) {
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
  const order = text('order');
  if (order !== null && !['asc', 'desc'].includes(order)) throw invalid('order', 'must be asc or desc');
  const sort = text('sort');
  if (sort !== null && !SORTS.includes(sort)) throw invalid('sort', 'must be start, duration, spans or errors');
  const span = {
    kind: text('kind'),
    module: text('module'),
    operation: text('operation'),
    entity: text('entity'),
    status: text('status'),
    host: text('host'),
    actorKind: text('actorKind'),
    actorId: get('actorId') === null ? null : actorKey(get('actorId')).trim() || null,
    sessionKey: exact('sessionKey'),
    visitorId: exact('visitorId'),
    portal: exact('portal'),
    search: text('search'),
  };
  return {
    span,
    spanFiltered: Object.values(span).some((value) => value !== null),
    from: time('from'),
    to: time('to'),
    traceId: exact('traceId'),
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

function spanMatches(record, f) {
  return (
    (!f.kind || record.kind === f.kind) &&
    (!f.module || lower(record.module) === f.module) &&
    (!f.operation || lower(record.operation) === f.operation) &&
    (!f.entity || lower(record.entity) === f.entity) &&
    (!f.status || record.status === f.status) &&
    (!f.host || lower(record.origin.host) === f.host) &&
    (!f.actorKind || lower(record.actor.kind) === f.actorKind) &&
    (!f.actorId || actorKey(record.actor.id) === f.actorId) &&
    (!f.sessionKey || record.session.sessionKey === f.sessionKey) &&
    (!f.visitorId || record.session.visitorId === f.visitorId) &&
    (!f.portal || record.origin.portal === f.portal) &&
    (!f.search ||
      [record.name, record.entity, record.error?.code, record.error?.message, JSON.stringify(record.attributes)]
        .join('\n')
        .toLowerCase()
        .includes(f.search))
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
  const listeners = new Map(); // listener -> payloads
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
      status: trace.running ? 'running' : rootRecord.status,
      ended: trace.running === 0,
      durationMs: rootRecord.durationMs,
      totalDurationMs: totalOf(trace),
      spanCount: trace.spans.length,
      droppedSpans: trace.droppedSpans,
      errorCount: trace.errorCount,
      deniedCount: trace.deniedCount,
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
    for (const [listener, payloads] of listeners) {
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
    for (const span of trace.spans) spans.delete(recordOf(span).spanId);
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
  };

  const SORT_KEYS = {
    start: () => 0,
    duration: (trace) => totalOf(trace),
    spans: (trace) => trace.spans.length,
    errors: (trace) => trace.errorCount * 1e6 + trace.deniedCount,
  };
  // The matching traces (internal objects), sorted; summaries are built only for what a caller returns.
  function matchedTraces(f) {
    const rows = [];
    const timed = f.from !== null || f.to !== null;
    const inRange = (start) => (f.from === null || start >= f.from) && (f.to === null || start <= f.to);
    for (const trace of traces.values()) {
      if (f.traceId && trace.traceId !== f.traceId) continue;
      // A trace matches the time range when any of its spans starts in it.
      if (timed) {
        if ((f.from !== null && trace.lastStart < f.from) || (f.to !== null && trace.first > f.to)) continue;
        if (!trace.spans.some((span) => inRange(startOf(span)))) continue;
      }
      if (f.spanFiltered && !trace.spans.some((span) => spanMatches(recordOf(span), f.span))) continue;
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
      for (const span of trace.spans) {
        const record = recordOf(span),
          start = startOf(span);
        if ((f.from !== null && start < f.from) || (f.to !== null && start > f.to)) continue;
        if (f.minDurationMs !== null && !(record.durationMs >= f.minDurationMs)) continue;
        if (f.hasErrors !== null && (record.status === 'error') !== f.hasErrors) continue;
        if (f.parentSpanId && record.parentSpanId !== f.parentSpanId) continue;
        if (f.depth !== null && record.depth !== f.depth) continue;
        if (f.spanFiltered && !spanMatches(record, f.span)) continue;
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
    /** Outbound loopback headers that make the receiving root join the span's trace (trace ids only for an overflow handle). */
    headers(span = store.current()) {
      if (span instanceof Span)
        return { [PARENT_HEADER]: span.spanId, [TRACE_HEADER]: span.traceId, [TRACE_ID_HEADER]: span.traceId };
      return OVERFLOWS.has(span) ? { [TRACE_HEADER]: span.traceId, [TRACE_ID_HEADER]: span.traceId } : {};
    },
    /**
     * { traceId, parentSpanId } from inbound headers (null when absent or not a UUID); spread into start for a root. The
     * trace id is x-trace-id, else x-sim-trace-id; the parent is x-sim-parent-trace.
     */
    fromHeaders(headers = {}) {
      const read = (name) => {
        const raw = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
        const value = Array.isArray(raw) ? raw[0] : raw;
        return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
      };
      return { traceId: read(TRACE_ID_HEADER) ?? read(TRACE_HEADER), parentSpanId: read(PARENT_HEADER) };
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
    /** Trace summaries matching the filters, newest first by default, paged. */
    query(filters = {}) {
      const f = parseFilters(filters);
      return paged(matchedTraces(f), f, (trace) => summarize(trace));
    },
    /** Flat spans matching the filters (also parentSpanId and depth), paged. */
    spans(filters = {}) {
      const f = parseFilters(filters);
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
      const f = parseFilters(filters);
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
     * when payloads is false); returns an unsubscribe function.
     */
    subscribe(listener, { payloads = true } = {}) {
      if (typeof listener !== 'function') throw new TypeError('Trace listeners must be functions.');
      listeners.set(listener, payloads !== false);
      return () => listeners.delete(listener);
    },
    /** Every trace matching the filters (no paging) as trees, with the settings in force. */
    export(filters = {}) {
      const f = parseFilters(filters);
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
    /** Resolves when every persisted line queued so far is written (or has failed). */
    flush() {
      return queue;
    },
  };
  return Object.freeze(store);
}
