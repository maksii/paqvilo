// Host-side tracing helpers shared by the Power Pages host (server.mjs), the standalone runtime and the Dataverse Web API
// listener (docs/design/tracing.md): the session key of a root, the response headers that name a root's trace, the
// explicit anonymous identity of a root that has not authenticated yet, and the client set of an SSE channel.
import { finished } from 'node:stream';

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

const STALLED_WRITES = 3;

/**
 * The clients of one Server-Sent Events channel (D-R2-19): sseClients({ onEmpty }) -> { add(res), send(message), end(),
 * size, [Symbol.iterator] }. A response is kept until it finishes or closes (node:stream finished, which also calls back
 * for a response that closes later); add refuses a response that already closed (returns false). A client whose write
 * returns false three times in a row is dropped and destroyed, so a stalled reader never makes the server buffer without
 * bound. onEmpty runs whenever the last client leaves (a channel that observes a source only while someone listens).
 */
export function sseClients({ onEmpty } = {}) {
  const clients = new Map(); // res -> consecutive writes that returned false
  const drop = (res) => {
    if (clients.delete(res) && !clients.size) onEmpty?.();
  };
  return {
    get size() {
      return clients.size;
    },
    [Symbol.iterator]: () => clients.keys(),
    add(res) {
      if (res.destroyed || res.writableEnded) return false;
      clients.set(res, 0);
      finished(res, () => drop(res));
      return true;
    },
    send(message) {
      for (const [res, stalled] of clients) {
        if (res.destroyed || res.writableEnded) drop(res);
        else if (res.write(message)) clients.set(res, 0);
        else if (stalled + 1 >= STALLED_WRITES) {
          drop(res);
          res.destroy();
        } else clients.set(res, stalled + 1);
      }
    },
    end() {
      for (const res of [...clients.keys()]) {
        drop(res);
        res.end();
      }
    },
  };
}
