// Host-side tracing helpers shared by the Power Pages host (server.mjs), the standalone runtime and the Dataverse Web API
// listener (docs/design/tracing.md): the session key of a root, the response headers that name a root's trace, the
// explicit anonymous identity of a root that has not authenticated yet, the client set of an SSE channel and the traced
// outbound fetch every host and module uses for HTTP it sends.
import { finished } from 'node:stream';
import { auditQuery, auditText } from './audit-log.mjs';
import { recordHttpError } from './trace-store.mjs';

/**
 * The trace session key (D-R2-13): `contact:<id>` when signed in, else `visitor:<id>` when a visitor cookie exists, else
 * null. The visitor id stays a separate session field.
 */
export const traceSessionKey = (contactId, visitorId) =>
  contactId ? `contact:${contactId}` : visitorId ? `visitor:${visitorId}` : null;

/**
 * The identity of a root that has not authenticated (standalone and Dataverse listener roots): explicit, so a header-named
 * parent span never lends the request its actor or session. Spread into traces.start.
 */
export const ANONYMOUS_ROOT = Object.freeze({
  actor: Object.freeze({ kind: 'anonymous', id: null, name: null }),
  session: Object.freeze({ visitorId: null, sessionKey: null }),
});

/**
 * Names the root's trace on the response: X-Trace-Id when the span has a trace (an overflow handle of a full trace has
 * one), X-Sim-Span-Id when it is a recorded span.
 */
export function setTraceHeaders(res, span) {
  if (span?.traceId) res.setHeader('X-Trace-Id', span.traceId);
  if (span?.spanId) res.setHeader('X-Sim-Span-Id', span.spanId);
}

const STALL_MS = 5000;
const CHECK_MS = 1000;

// The stall check runs on a timer and then on the next check phase (setImmediate), so it always follows an I/O poll. It
// is told it ran late (by more than one interval) when the event loop was blocked meanwhile: then no reader could take
// anything, so that stretch never counts towards a stall.
const deferCheck = (interval) => (fn) => {
  const due = Date.now() + interval;
  const timer = setTimeout(() => setImmediate(() => fn({ late: Date.now() - due > interval })), interval);
  timer.unref?.();
};
// The bytes of a response's socket still waiting in libuv's write queue. A large write (a corked burst is one writev)
// leaves writableLength unchanged until the kernel took all of it, while this falls as the peer reads.
const queuedBytes = (res) => {
  const size = res.socket?._handle?.writeQueueSize;
  return typeof size === 'number' ? size : null;
};

/**
 * The clients of one Server-Sent Events channel (D-R2-19, D-R3-18): sseClients({ onEmpty, now, stallMs, defer }) ->
 * { add(res), send(message), flush(), end(), size, [Symbol.iterator] }. A response is kept until it finishes or closes
 * (node:stream finished, which also calls back for a response that closes later); add refuses a response that already
 * closed (returns false). Every frame is written, so a reader that keeps up loses nothing however large a burst is.
 *
 * A write that returns false starts a wait for `drain`. Sending never drops a client: a deferred check does (defer(fn),
 * by default a timer of min(stallMs, 1 s) followed by setImmediate, so it runs after the I/O poll of a responsive loop,
 * never inside a synchronous burst). Each check looks for progress since the last one: the bytes the client has taken
 * off its buffer grew, or its socket's libuv write queue shrank (the peer is reading a large write that has not
 * completed yet). Progress, or a check that ran late because the loop was blocked (defer passes { late: true }),
 * restarts the stall clock (now(), default Date.now); a client still waiting with no progress for more than stallMs
 * (default 5 s) of a free loop is dropped and destroyed; that and a closed response are the only ways a client leaves,
 * each reported to onDrop(res, 'stalled' | 'closed'). A reader
 * whose every frame meets back-pressure (frames larger than the socket's high-water mark) still drains, so it is making
 * progress and stays. So a stalled reader never makes the server buffer without bound, and neither back-pressure nor a
 * blocked event loop (which keeps every reader from draining) ever drops a healthy one. A refused write is still queued:
 * no frame is ever skipped.
 *
 * flush() resolves once every frame sent so far was handed to each client's socket (or the client left). onEmpty runs
 * whenever the last client leaves (a channel that observes a source only while someone listens).
 */
export function sseClients({
  onEmpty,
  onDrop,
  now = Date.now,
  stallMs = STALL_MS,
  defer = deferCheck(Math.min(stallMs, CHECK_MS)),
} = {}) {
  const clients = new Map(); // res -> { waiting, since, written, taken, queued, checking }
  const drop = (res, reason = 'closed') => {
    if (!clients.delete(res)) return;
    onDrop?.(res, reason);
    if (!clients.size) onEmpty?.();
  };
  const kill = (res) => {
    drop(res, 'stalled');
    res.destroy();
  };
  // The bytes the client has taken off its buffer so far (written minus still buffered).
  const taken = (res, state) => state.written - res.writableLength;
  const check = (res, state, { late = false } = {}) => {
    state.checking = false;
    if (clients.get(res) !== state || !state.waiting) return;
    if (res.destroyed || res.writableEnded) return drop(res);
    const done = taken(res, state),
      queued = queuedBytes(res);
    const progress = done > state.taken || (queued !== null && state.queued !== null && queued < state.queued);
    state.taken = done;
    state.queued = queued;
    if (progress || late) state.since = now();
    else if (now() - state.since > stallMs) return kill(res);
    schedule(res, state);
  };
  const schedule = (res, state) => {
    if (state.checking) return;
    state.checking = true;
    defer((info) => check(res, state, info));
  };
  return {
    get size() {
      return clients.size;
    },
    [Symbol.iterator]: () => clients.keys(),
    add(res) {
      if (res.destroyed || res.writableEnded) return false;
      const state = { waiting: false, since: 0, written: 0, taken: 0, queued: null, checking: false };
      clients.set(res, state);
      res.on('drain', () => {
        state.waiting = false;
      });
      finished(res, () => drop(res));
      return true;
    },
    send(message) {
      for (const [res, state] of clients) {
        if (res.destroyed || res.writableEnded) {
          drop(res);
          continue;
        }
        state.written += Buffer.byteLength(message);
        // A refused write is queued by the stream like any other; it only starts the wait for drain.
        if (!res.write(message) && !state.waiting) {
          state.waiting = true;
          state.since = now();
          state.taken = taken(res, state);
          state.queued = queuedBytes(res);
          schedule(res, state);
        }
      }
    },
    flush() {
      return Promise.all(
        [...clients.keys()].map(
          (res) =>
            new Promise((resolve) => {
              if (res.destroyed || res.writableEnded) return resolve();
              const done = () => {
                res.off('close', done);
                resolve();
              };
              res.once('close', done);
              // An SSE comment: readers ignore it; its callback runs once every earlier frame reached the socket.
              res.write(':\n\n', done);
            }),
        ),
      ).then(() => undefined);
    },
    end() {
      for (const res of [...clients.keys()]) {
        drop(res, 'ended');
        res.end();
      }
    },
  };
}

// Response bodies read for a span: text-like content types only (never an event stream), at most the payload limit.
const TEXT_TYPE = /json|xml|javascript|x-www-form-urlencoded|^text\//i;
const JSON_TYPE = /json/i;

// The URL as a span records it: no user name or password, query values through auditQuery (code, sig and credential-
// named parameters hidden), the rest through auditText.
function safeUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { label: auditText(url, 300), url: auditText(url, 2000) };
  }
  const query = parsed.search ? `?${new URLSearchParams(auditQuery(parsed.searchParams))}` : '';
  return {
    label: auditText(`${parsed.host}${parsed.pathname}`, 300),
    url: auditText(`${parsed.origin}${parsed.pathname}${query}`, 2000),
  };
}

const headerObject = (headers) => {
  try {
    return Object.fromEntries(new Headers(headers ?? undefined));
  } catch {
    return {};
  }
};

// A request body as a payload value: JSON text parsed, other strings, URLSearchParams and binary data as they are (the
// store redacts and summarises them); a stream, a Blob or form data only by its kind.
function bodyValue(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    try {
      return /^\s*[[{]/.test(body) ? JSON.parse(body) : body;
    } catch {
      return body;
    }
  }
  if (body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return `[blob ${body.size} bytes]`;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return '[form data]';
  return '[stream]';
}

// The first `limit` bytes of a clone of the response body (the caller still reads the original): { body, truncated? };
// a body that is not text-like is described by its content type and length only.
async function responseBody(response, limit) {
  const type = response.headers.get('content-type') ?? '';
  if (!response.body || !TEXT_TYPE.test(type) || /event-stream/i.test(type)) return {};
  const reader = response.clone().body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).subarray(0, limit).toString('utf8');
  if (size > limit) return { body: text, truncated: true };
  if (JSON_TYPE.test(type))
    try {
      return { body: JSON.parse(text) };
    } catch {
      /* not JSON after all: the text */
    }
  return { body: text };
}

// The provider's own { code, message } from an error body: an OData / Dataverse envelope { error: { code, message } },
// a { code, message } object or an Azure-style { error: 'code', error_description }.
function providerError(body) {
  if (!body || typeof body !== 'object') return {};
  const error = body.error;
  if (error && typeof error === 'object')
    return { code: error.code == null ? undefined : String(error.code), message: error.message ?? undefined };
  if (typeof error === 'string') return { code: error, message: body.error_description ?? body.message ?? undefined };
  return {
    code: body.code == null ? undefined : String(body.code),
    message: typeof body.message === 'string' ? body.message : undefined,
  };
}

/**
 * fetch with an `http-out` span (D-R3-5): resolves the Response (the caller reads its body as usual) or rejects as fetch
 * does. The span is named `<METHOD> <host><path>` (kind `http-out`, module `module`, operation `operation` or the
 * lowercased method) with attributes `method`, `url` (credentials and secret query values hidden) and, once answered,
 * `status`. With forwardHeaders (default) the request carries traces.headers(span), so a loopback receiver joins the
 * trace under this span. At level full and capture 'full' (default) the span input is { method, url, headers, body } and
 * its output { status, headers, body } (a text-like body, at most payloadBytes, read from a clone), both redacted by the
 * store; capture 'none' records neither body (binary uploads, sealed values). A status of 400 or more goes through
 * recordHttpError with the provider's own code and message when its body carries them (else `Http<status>` and the
 * status text); a network failure fails the span with the cause's code (ECONNREFUSED, ...). traces absent or at level
 * off: a plain fetch. fetch: the fetch implementation (default globalThis.fetch); attributes: extra span attributes.
 */
export async function tracedFetch(
  traces,
  {
    module = 'http',
    operation,
    url,
    init = {},
    forwardHeaders = true,
    capture = 'full',
    attributes,
    fetch: fetchImpl = globalThis.fetch,
  } = {},
) {
  if (!traces?.enabled) return fetchImpl(url, init);
  const method = String(init.method ?? 'GET').toUpperCase();
  const where = safeUrl(url);
  const payloads = capture === 'full';
  const span = traces.start({
    kind: 'http-out',
    name: `${method} ${where.label}`,
    module,
    operation: operation ?? method,
    attributes: { ...attributes, method, url: where.url },
    ...(payloads
      ? { input: () => ({ method, url: where.url, headers: headerObject(init.headers), body: bodyValue(init.body) }) }
      : {}),
  });
  const headers = new Headers(init.headers ?? undefined);
  if (forwardHeaders) for (const [name, value] of Object.entries(traces.headers(span))) headers.set(name, value);
  let response;
  try {
    response = await fetchImpl(url, { ...init, headers });
  } catch (error) {
    const cause = error?.cause && typeof error.cause === 'object' ? error.cause : error;
    span.fail({
      code: cause?.code ?? cause?.errors?.[0]?.code ?? error?.code ?? error?.name ?? 'FetchFailed',
      message: cause?.message ?? error?.message ?? String(error),
    });
    throw error;
  }
  span.set({ status: response.status });
  let read = {};
  if (span.enabled && payloads && traces.settings().level === 'full') {
    try {
      read = await responseBody(response, traces.settings().payloadBytes);
    } catch (error) {
      read = { body: `[unreadable body: ${auditText(error?.message ?? error, 200)}]` };
    }
    span.output(() => ({
      status: response.status,
      headers: headerObject(response.headers),
      ...(read.body === undefined ? {} : { body: read.body }),
      ...(read.truncated ? { truncated: true } : {}),
    }));
  }
  if (response.status >= 400) {
    const provider = providerError(read.body);
    recordHttpError(span, response.status, {
      code: provider.code,
      message: provider.message ?? `${response.status} ${response.statusText}`.trim(),
    });
  }
  span.end();
  return response;
}
