// /_sim/api/trace: the read side of the local trace store (trace-store.mjs) plus its run-time settings, a clear and a
// flush. GET /trace (trace summaries), /trace/spans, /trace/stats, /trace/export (streamed attachment), /trace/settings,
// /trace/span/<id> and /trace/id/<traceId> (the tree; /trace/<traceId> also answers a UUID-shaped id) are reads;
// PUT /trace/settings, POST /trace/clear and POST /trace/flush need the simulator CSRF token.
// Filters are the query string, passed to the store as URLSearchParams (sort and order included); an invalid filter is
// the store's RangeError { status: 400, code: 'InvalidTraceFilter', parameter }, answered as { error: { code, message,
// parameter } }. Payloads were redacted when they were captured; nothing is re-read here. Mounted by the host:
// `const traceRoutes = createTraceRoutes({ traces, csrf, json })`, then `if (await traceRoutes(req, res, url)) return;`
// before the generic runtime admin router. createTraceChannel serves the `trace` channel of each host's /_sim/events
// stream.
import { createHash } from 'node:crypto';
import { sseClients } from './trace-hosts.mjs';

const MAX_BODY = 64 * 1024;
const PREFIX = /^\/(?:_sim|__sim)\/api(?=\/|$)/;
const ROUTE = /^\/trace(?:\/(spans|stats|export|settings|clear|flush)|\/span\/([^/]+)|\/id\/([^/]+)|\/([^/]+))?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPORT_LIMIT = 200;
const EXPORT_MAX = 2000;
const QUERY_PAGE = 200;
/** The /_sim/api prefixes this router answers (status `routes`). */
export const routes = Object.freeze(['/trace']);
const failure = (status, code, message, parameter) =>
  Object.assign(new Error(message), { status, code, ...(parameter ? { parameter } : {}) });

function send(res, status, value, headers = {}) {
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw failure(413, 'PayloadTooLarge', 'The request body is too large.');
    chunks.push(bytes);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString('utf8') || '{}');
  } catch {
    throw failure(400, 'InvalidRequest', 'The request body must be JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure(400, 'InvalidRequest', 'The request body must be a JSON object.');
  return value;
}
const segment = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw failure(400, 'InvalidRequest', 'Invalid identifier encoding.');
  }
};

const traceFrame = (event) => `event: trace\ndata: ${JSON.stringify(event)}\n\n`;
/**
 * createTraceChannel(traces, { now, stallMs, defer }) -> attach(res): the `trace` channel of a host's /_sim/events stream,
 * shared by both hosts. attach writes a `connected` frame with the store status, then one payload-free frame per store
 * event until the response finishes or closes; the store is observed only while a client listens, and its flush() waits
 * until the frames reached every client. Client bookkeeping (closed responses never join; every frame is written; a
 * reader that takes nothing for stallMs while the loop is free is dropped) is trace-hosts.mjs sseClients, which takes
 * now, stallMs and defer. traces: the trace store, or a function returning it.
 */
export function createTraceChannel(traces, { now, stallMs, defer } = {}) {
  const store = typeof traces === 'function' ? traces : () => traces;
  let unsubscribe = null;
  const clients = sseClients({
    now,
    stallMs,
    defer,
    onEmpty() {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
  const publish = (event) => clients.send(traceFrame(event));
  return (res) => {
    const t = store();
    if (!t || !clients.add(res)) return;
    unsubscribe ??= t.subscribe(publish, { payloads: false, flush: () => clients.flush() });
    res.write(traceFrame({ type: 'connected', status: t.status() }));
  };
}

// OTLP/JSON ids: a UUID keeps its 32 hex digits as the trace id; anything else is hashed. Span ids are the first 16 hex
// digits of the SHA-256 of the span id, so the same span always maps to the same OTLP id.
const hex = (value, length) =>
  length === 32 && UUID.test(value)
    ? value.replaceAll('-', '').toLowerCase()
    : createHash('sha256').update(String(value)).digest('hex').slice(0, length);
// SERVER, CLIENT, PRODUCER (a web hook or Service Bus delivery), CONSUMER; others INTERNAL (1)
const SPAN_KIND = { http: 2, 'http-out': 3, connector: 3, webhook: 4, job: 5 };
function anyValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: typeof value === 'string' ? value : JSON.stringify(value) };
}
const keyValues = (entries) =>
  entries
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
const nanos = (ms) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();
function otlpSpan(record) {
  const start = Date.parse(record.startedAt);
  return {
    traceId: hex(record.traceId, 32),
    spanId: hex(record.spanId, 16),
    ...(record.parentSpanId ? { parentSpanId: hex(record.parentSpanId, 16) } : {}),
    name: record.name,
    kind: SPAN_KIND[record.kind] ?? 1,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(start + (record.durationMs ?? 0)),
    attributes: keyValues([
      ['mirage.trace_id', record.traceId],
      ['mirage.span_id', record.spanId],
      ['mirage.kind', record.kind],
      ['mirage.module', record.module],
      ['mirage.operation', record.operation],
      ['mirage.entity', record.entity],
      ['mirage.record_id', record.recordId],
      ['mirage.status', record.status],
      ['mirage.level', record.level],
      ['mirage.async', record.async],
      ['mirage.depth', record.depth],
      ['mirage.host', record.origin?.host],
      ['mirage.portal', record.origin?.portal],
      ['mirage.actor.kind', record.actor?.kind],
      ['mirage.actor.id', record.actor?.id],
      ['mirage.session.key', record.session?.sessionKey],
      ['mirage.session.visitor_id', record.session?.visitorId],
      ['mirage.input', record.input],
      ['mirage.output', record.output],
      ...Object.entries(record.attributes ?? {}),
    ]),
    events: (record.events ?? []).map((event) => ({
      timeUnixNano: nanos(start + event.offsetMs),
      name: event.type,
      attributes: keyValues([['message', event.message], ...Object.entries(event.attributes ?? {})]),
    })),
    links: (record.links ?? [])
      .filter((link) => link.spanId)
      .map((link) => ({
        traceId: hex(link.traceId ?? record.traceId, 32),
        spanId: hex(link.spanId, 16),
        attributes: keyValues([['mirage.relation', link.relation]]),
      })),
    status:
      record.status === 'running' || record.status === 'cancelled'
        ? { code: 0 }
        : record.status === 'ok'
          ? { code: 1 }
          : { code: 2, message: record.error?.message ?? record.status },
  };
}

const FORMATS = {
  json: { type: 'application/json; charset=utf-8', file: 'simulator-traces.json' },
  ndjson: { type: 'application/x-ndjson; charset=utf-8', file: 'simulator-traces.ndjson' },
  otlp: { type: 'application/json; charset=utf-8', file: 'simulator-traces.otlp.json' },
};
// GET /trace/export?format=json|ndjson|otlp&limit=N: the matching traces in the list order (sort and order apply),
// at most `limit` (default 200, at most 2000), written one trace at a time with write backpressure.
async function exportTraces(t, filters, res) {
  const format = filters.get('format') || 'json';
  if (!Object.hasOwn(FORMATS, format))
    throw failure(
      400,
      'InvalidTraceFilter',
      `format must be one of json, ndjson, otlp (got ${JSON.stringify(format)}).`,
      'format',
    );
  const limitText = filters.get('limit');
  if (limitText && !(/^\d+$/.test(limitText) && Number(limitText) >= 1 && Number(limitText) <= EXPORT_MAX))
    throw failure(400, 'InvalidTraceFilter', `limit must be an integer from 1 to ${EXPORT_MAX}.`, 'limit');
  const limit = limitText ? Number(limitText) : EXPORT_LIMIT;
  const query = new URLSearchParams(filters);
  for (const key of ['format', 'limit', 'page', 'pageSize']) query.delete(key);
  query.set('pageSize', String(QUERY_PAGE));
  const ids = [];
  let total = 0;
  for (let page = 1; ids.length < limit; page++) {
    query.set('page', String(page));
    const result = t.query(query);
    total = result.total;
    ids.push(...result.items.slice(0, limit - ids.length).map((summary) => summary.traceId));
    if (page >= result.pageCount) break;
  }
  res.writeHead(200, {
    'content-type': FORMATS[format].type,
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${FORMATS[format].file}"`,
    'x-trace-export-matched': String(total),
  });
  const write = (chunk) =>
    res.write(chunk) ||
    new Promise((resolve) => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.on('drain', done);
      res.on('close', done);
    });
  const [open, close] = {
    json: [
      `{"exportedAt":${JSON.stringify(new Date().toISOString())},"settings":${JSON.stringify(t.settings())},"traces":[`,
      ']}',
    ],
    ndjson: ['', ''],
    otlp: [
      '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"paqvilo-mirage"}}]},"scopeSpans":[{"scope":{"name":"paqvilo.mirage.trace"},"spans":[',
      ']}]}]}',
    ],
  }[format];
  await write(open);
  let first = true;
  for (const traceId of ids) {
    if (res.destroyed) return;
    const tree = t.tree(traceId);
    if (!tree) continue; // dropped since the query
    const chunk =
      format === 'json'
        ? JSON.stringify(tree)
        : format === 'ndjson'
          ? `${JSON.stringify({ trace: tree.trace, spans: tree.spans })}\n`
          : tree.spans.map((record) => JSON.stringify(otlpSpan(record))).join(',');
    if (!chunk) continue;
    await write(format !== 'ndjson' && !first ? `,${chunk}` : chunk);
    first = false;
  }
  res.end(close);
}

/**
 * createTraceRoutes({ traces, csrf, json }) -> (req, res, url) => Promise<boolean>. traces: the trace store, or a function
 * returning it (absent: 501 TraceNotConfigured); csrf(): the simulator token; json(res, status, value, headers): the host's
 * JSON writer (defaults to a plain no-store JSON answer). Resolves true when it answered.
 */
export function createTraceRoutes({ traces, csrf, json = send }) {
  const store = typeof traces === 'function' ? traces : () => traces;
  return async (req, res, url) => {
    const prefix = PREFIX.exec(url.pathname);
    if (!prefix) return false;
    const match = ROUTE.exec(url.pathname.slice(prefix[0].length));
    if (!match) return false;
    const [, named, spanId, canonicalId, shortId] = match,
      method = req.method;
    try {
      if (method !== 'GET') {
        const token = csrf();
        if (!token || req.headers['x-sim-csrf'] !== token)
          throw failure(403, 'Forbidden', 'Missing simulator CSRF token.');
      }
      const t = store();
      if (!t) throw failure(501, 'TraceNotConfigured', 'This runtime has no trace store.');
      const filters = url.searchParams;
      if (named === 'settings' && (method === 'GET' || method === 'PUT')) {
        if (method === 'PUT') {
          const partial = await body(req);
          try {
            t.configure(partial);
          } catch (error) {
            throw failure(400, 'InvalidTraceSettings', error.message);
          }
        }
        json(res, 200, { settings: t.settings(), status: t.status() });
        return true;
      }
      if (named === 'clear') {
        if (method !== 'POST') throw failure(405, 'MethodNotAllowed', 'Clear traces with POST.');
        json(res, 200, t.clear());
        return true;
      }
      if (named === 'flush') {
        if (method !== 'POST') throw failure(405, 'MethodNotAllowed', 'Flush traces with POST.');
        await t.flush();
        json(res, 200, t.status());
        return true;
      }
      if (method !== 'GET') throw failure(405, 'MethodNotAllowed', 'Unsupported trace operation.');
      if (!named && !spanId && !canonicalId && !shortId) json(res, 200, t.query(filters));
      else if (named === 'spans') json(res, 200, t.spans(filters));
      else if (named === 'stats') json(res, 200, t.stats(filters));
      else if (named === 'export') await exportTraces(t, filters, res);
      else if (spanId) {
        const record = t.span(segment(spanId));
        if (!record) throw failure(404, 'SpanNotFound', 'No retained span has this id.');
        json(res, 200, record);
      } else {
        const id = segment(canonicalId ?? shortId);
        // /trace/<id> answers UUID-shaped ids only, so a trace id never competes with a named route.
        const tree = canonicalId || UUID.test(id) ? t.tree(id) : null;
        if (!tree)
          throw failure(404, 'TraceNotFound', 'No retained trace has this id; read a trace at /trace/id/<traceId>.');
        json(res, 200, tree);
      }
      return true;
    } catch (error) {
      if (res.headersSent) res.destroy();
      else
        json(res, error.status ?? 500, {
          error: {
            code: error.code ?? 'InternalError',
            message: error.status ? error.message : 'The trace request failed.',
            ...(error.status && error.parameter ? { parameter: error.parameter } : {}),
          },
        });
      return true;
    }
  };
}
