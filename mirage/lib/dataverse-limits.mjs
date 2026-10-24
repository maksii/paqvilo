// Service protection limits per user: request count, combined execution time and concurrency,
// over a 300-second sliding window. Errors are 429 with a Retry-After header.
// Limits are documented per web server; the simulator is one server.
import { DataError } from "./data-error.mjs";

const WINDOW_MS = 300000;
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function createServiceProtection({
  requestsPer300s: requestsOption = null,
  executionMsPer300s: executionOption = null,
  concurrentRequests: concurrentOption = null,
  clock = Date.now,
} = {}) {
  // A limit may be a function, read on every request: the admin Environment settings change limits while the simulator runs.
  const limitsNow = () => {
    const read = (value) => (typeof value === "function" ? value() : value);
    return { requestsPer300s: read(requestsOption), executionMsPer300s: read(executionOption), concurrentRequests: read(concurrentOption) };
  };
  // userId -> { requests: admission times, executed: { at, ms } on release, active: in-flight count }
  const users = new Map();

  function stateOf(userId) {
    let s = users.get(userId);
    if (!s) users.set(userId, (s = { requests: [], executed: [], active: 0 }));
    return s;
  }

  // Entries are appended in clock order, so the expired ones lead each list: drop that prefix in place.
  // A clock that moved backwards (an injected test clock) breaks the order; such a user keeps the full filter.
  const expiredPrefix = (list, now, at) => {
    let count = 0;
    while (count < list.length && now - at(list[count]) >= WINDOW_MS) count++;
    if (count) list.splice(0, count);
  };
  function prune(s, now) {
    if (s.unordered) {
      s.requests = s.requests.filter((at) => now - at < WINDOW_MS);
      s.executed = s.executed.filter((e) => now - e.at < WINDOW_MS);
      return;
    }
    expiredPrefix(s.requests, now, (at) => at);
    expiredPrefix(s.executed, now, (e) => e.at);
  }
  const append = (s, list, entry, at) => {
    if (list.length && at < (typeof list.at(-1) === "number" ? list.at(-1) : list.at(-1).at)) s.unordered = true;
    list.push(entry);
  };

  // Retry-After is the seconds until the oldest counted entry leaves the window (rounded up); a guess at the native rule.
  const retryAfter = (oldestAt, now) => Math.max(1, Math.ceil(((oldestAt ?? now) + WINDOW_MS - now) / 1000));

  // Execution time: the retry is the expiry of the first entry whose removal, with every older one, brings the counted
  // time under the limit. Expiring only the oldest entry can leave the user still over it, and the retry then fails again.
  function executionRetryAfter(entries, limit, now) {
    let sum = entries.reduce((total, e) => total + e.ms, 0);
    for (const e of entries) {
      sum -= e.ms;
      if (sum < limit) return retryAfter(e.at, now);
    }
    return retryAfter(entries.at(-1)?.at, now);
  }

  const reject = (message, innerCode, seconds) => ({
    ok: false,
    error: new DataError(message, 429, "ServiceProtection", { innerCode, retryAfter: seconds }),
  });

  return {
    /**
     * Admits one request for the user, or returns the 429 error to send. Call release(durationMs) in a finally block:
     * otherwise the concurrency slot leaks and the user stays throttled. A negative or non-numeric duration counts as 0.
     */
    admit(userId) {
      const { requestsPer300s, executionMsPer300s, concurrentRequests } = limitsNow();
      const now = clock();
      const s = stateOf(userId);
      prune(s, now);
      // Rejected requests are not counted toward the request or execution windows (a guess).
      if (requestsPer300s != null && s.requests.length >= requestsPer300s) {
        return reject(
          `Number of requests exceeded the limit of ${requestsPer300s} over time window of 300 seconds.`,
          "0x80072322",
          retryAfter(s.requests[0], now),
        );
      }
      const executed = s.executed.reduce((sum, e) => sum + e.ms, 0);
      if (executionMsPer300s != null && executed >= executionMsPer300s) {
        // Native may count execution time at admission or completion; this counts at completion.
        return reject(
          `Combined execution time of incoming requests exceeded limit of ${thousands(executionMsPer300s)}  milliseconds over time window of 300 seconds. Decrease number of concurrent requests or reduce the duration of requests and try again later.`,
          "0x80072321",
          executionRetryAfter(s.executed, executionMsPer300s, now),
        );
      }
      if (concurrentRequests != null && s.active >= concurrentRequests) {
        // Retry-After for concurrency is not documented; 1 second is assumed.
        return reject(`Number of concurrent requests exceeded the limit of ${concurrentRequests}.`, "0x80072326", 1);
      }

      append(s, s.requests, now, now);
      s.active += 1;
      let released = false;
      return {
        ok: true,
        release(durationMs = 0) {
          if (released) return;
          released = true;
          s.active -= 1;
          const at = clock();
          append(s, s.executed, { at, ms: Math.max(0, Number(durationMs) || 0) }, at);
        },
      };
    },

    /** Remaining-limit headers for the user; a header is omitted when its limit is disabled. */
    headers(userId) {
      const { requestsPer300s, executionMsPer300s } = limitsNow();
      const now = clock();
      const s = stateOf(userId);
      prune(s, now);
      const out = {};
      if (requestsPer300s != null) {
        out["x-ms-ratelimit-burst-remaining-xrm-requests"] = String(Math.max(0, requestsPer300s - s.requests.length));
      }
      if (executionMsPer300s != null) {
        const used = s.executed.reduce((sum, e) => sum + e.ms, 0);
        // Seconds with two decimals and a thousands separator (1,068.10), as native authenticated responses send it.
        out["x-ms-ratelimit-time-remaining-xrm-requests"] = ((Math.max(0, executionMsPer300s - used) / 1000).toFixed(2)).replace(/^\d+/, thousands);
      }
      return out;
    },
  };
}
