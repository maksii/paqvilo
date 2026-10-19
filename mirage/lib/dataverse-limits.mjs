// Service protection limits per user: request count, combined execution time and concurrency,
// over a 300-second sliding window. Errors are 429 with a Retry-After header.
// Limits are documented per web server; the simulator is one server.
import { DataError } from "./data-error.mjs";

const WINDOW_MS = 300000;
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function createServiceProtection({
  requestsPer300s = null,
  executionMsPer300s = null,
  concurrentRequests = null,
  clock = Date.now,
} = {}) {
  // userId -> { requests: admission times, executed: { at, ms } on release, active: in-flight count }
  const users = new Map();

  function stateOf(userId) {
    let s = users.get(userId);
    if (!s) users.set(userId, (s = { requests: [], executed: [], active: 0 }));
    return s;
  }

  function prune(s, now) {
    s.requests = s.requests.filter((at) => now - at < WINDOW_MS);
    s.executed = s.executed.filter((e) => now - e.at < WINDOW_MS);
  }

  // unverified: Retry-After is the seconds until the oldest counted entry leaves the window (rounded up).
  const retryAfter = (oldestAt, now) => Math.max(1, Math.ceil(((oldestAt ?? now) + WINDOW_MS - now) / 1000));

  const reject = (message, innerCode, seconds) => ({
    ok: false,
    error: new DataError(message, 429, "ServiceProtection", { innerCode, retryAfter: seconds }),
  });

  return {
    /** Admits one request for the user, or returns the 429 error to send. Call release(durationMs) when it finishes. */
    admit(userId) {
      const now = clock();
      const s = stateOf(userId);
      prune(s, now);
      // unverified: rejected requests are not counted toward the request or execution windows.
      if (requestsPer300s != null && s.requests.length >= requestsPer300s) {
        return reject(
          `Number of requests exceeded the limit of ${requestsPer300s} over time window of 300 seconds.`,
          "0x80072322",
          retryAfter(s.requests[0], now),
        );
      }
      const executed = s.executed.reduce((sum, e) => sum + e.ms, 0);
      if (executionMsPer300s != null && executed >= executionMsPer300s) {
        // unverified: whether execution time is counted at admission or completion; this counts at completion.
        return reject(
          `Combined execution time of incoming requests exceeded limit of ${thousands(executionMsPer300s)}  milliseconds over time window of 300 seconds. Decrease number of concurrent requests or reduce the duration of requests and try again later.`,
          "0x80072321",
          retryAfter(s.executed[0]?.at, now),
        );
      }
      if (concurrentRequests != null && s.active >= concurrentRequests) {
        // unverified: Retry-After for concurrency is not documented; 1 second is assumed.
        return reject(`Number of concurrent requests exceeded the limit of ${concurrentRequests}.`, "0x80072326", 1);
      }

      s.requests.push(now);
      s.active += 1;
      let released = false;
      return {
        ok: true,
        release(durationMs = 0) {
          if (released) return;
          released = true;
          s.active -= 1;
          s.executed.push({ at: clock(), ms: durationMs });
        },
      };
    },

    /** Remaining-limit headers for the user; a header is omitted when its limit is disabled. */
    headers(userId) {
      const now = clock();
      const s = stateOf(userId);
      prune(s, now);
      const out = {};
      if (requestsPer300s != null) {
        out["x-ms-ratelimit-burst-remaining-xrm-requests"] = String(Math.max(0, requestsPer300s - s.requests.length));
      }
      if (executionMsPer300s != null) {
        const used = s.executed.reduce((sum, e) => sum + e.ms, 0);
        // unverified: the header unit is taken as seconds with two decimals (the value baseHeaders emits).
        out["x-ms-ratelimit-time-remaining-xrm-requests"] = (Math.max(0, executionMsPer300s - used) / 1000).toFixed(2);
      }
      return out;
    },
  };
}
