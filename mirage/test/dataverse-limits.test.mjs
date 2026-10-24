// Service protection limits with an injected clock.
import test from "node:test";
import assert from "node:assert/strict";
import { DataError } from "../lib/data-error.mjs";
import { createServiceProtection } from "../lib/dataverse-limits.mjs";

function fakeClock() {
  let now = 0;
  return { clock: () => now, advance: (ms) => { now += ms; } };
}

function rejectedWith(result) {
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof DataError);
  return result.error;
}

test("request limit rejects over the window and admits again once the oldest entry leaves", () => {
  const t = fakeClock();
  const limits = createServiceProtection({ requestsPer300s: 2, clock: t.clock });
  assert.equal(limits.admit("u1").ok, true);
  t.advance(1000);
  assert.equal(limits.admit("u1").ok, true);
  t.advance(1000);
  const error = rejectedWith(limits.admit("u1"));
  assert.equal(error.status, 429);
  assert.equal(error.code, "ServiceProtection");
  assert.equal(error.details.innerCode, "0x80072322");
  assert.equal(error.message, "Number of requests exceeded the limit of 2 over time window of 300 seconds.");
  assert.equal(error.details.retryAfter, 298);
  t.advance(298000);
  assert.equal(limits.admit("u1").ok, true);
});

test("execution time limit uses released durations and the documented message", () => {
  const t = fakeClock();
  const limits = createServiceProtection({ executionMsPer300s: 1200000, clock: t.clock });
  const first = limits.admit("u1");
  assert.equal(first.ok, true);
  first.release(1200000);
  t.advance(10000);
  const error = rejectedWith(limits.admit("u1"));
  assert.equal(error.details.innerCode, "0x80072321");
  assert.equal(
    error.message,
    "Combined execution time of incoming requests exceeded limit of 1,200,000  milliseconds over time window of 300 seconds. Decrease number of concurrent requests or reduce the duration of requests and try again later.",
  );
  assert.equal(error.details.retryAfter, 290);
  t.advance(290000);
  assert.equal(limits.admit("u1").ok, true);
});

test("execution retry waits until enough released time has expired, not only the oldest entry", () => {
  const t = fakeClock();
  const limits = createServiceProtection({ executionMsPer300s: 1200000, clock: t.clock });
  limits.admit("u1").release(100000);
  t.advance(100000);
  limits.admit("u1").release(1200000);
  t.advance(10000);
  // The first entry leaves at 300 s, but 1,200,000 is still counted until the second leaves at 400 s.
  assert.equal(rejectedWith(limits.admit("u1")).details.retryAfter, 290);
  t.advance(190000);
  assert.equal(limits.admit("u1").ok, false);
  t.advance(100000);
  assert.equal(limits.admit("u1").ok, true);
});

test("execution retry is the first entry's expiry when that alone brings usage under the limit", () => {
  const t = fakeClock();
  const limits = createServiceProtection({ executionMsPer300s: 1200000, clock: t.clock });
  limits.admit("u1").release(700000);
  t.advance(100000);
  limits.admit("u1").release(700000);
  t.advance(10000);
  assert.equal(rejectedWith(limits.admit("u1")).details.retryAfter, 190);
});

test("a negative release duration never lowers usage", () => {
  const limits = createServiceProtection({ executionMsPer300s: 1000, clock: fakeClock().clock });
  limits.admit("u1").release(-500);
  assert.equal(limits.headers("u1")["x-ms-ratelimit-time-remaining-xrm-requests"], "1.00");
});

test("concurrency limit counts in-flight requests until release, and release is idempotent", () => {
  const limits = createServiceProtection({ concurrentRequests: 2, clock: fakeClock().clock });
  const a = limits.admit("u1");
  const b = limits.admit("u1");
  const error = rejectedWith(limits.admit("u1"));
  assert.equal(error.details.innerCode, "0x80072326");
  assert.equal(error.message, "Number of concurrent requests exceeded the limit of 2.");
  assert.equal(error.details.retryAfter, 1);
  a.release(5);
  a.release(5);
  assert.equal(limits.admit("u1").ok, true);
  assert.equal(limits.admit("u1").ok, false);
  b.release(0);
});

test("headers report remaining requests and execution time in seconds", () => {
  const t = fakeClock();
  const limits = createServiceProtection({ requestsPer300s: 10, executionMsPer300s: 2000, clock: t.clock });
  limits.admit("u1").release(500);
  assert.deepEqual(limits.headers("u1"), {
    "x-ms-ratelimit-burst-remaining-xrm-requests": "9",
    "x-ms-ratelimit-time-remaining-xrm-requests": "1.50",
  });
  t.advance(300000);
  assert.deepEqual(limits.headers("u1"), {
    "x-ms-ratelimit-burst-remaining-xrm-requests": "10",
    "x-ms-ratelimit-time-remaining-xrm-requests": "2.00",
  });
});

test("the time remaining header groups thousands in the seconds value", () => {
  const limits = createServiceProtection({ executionMsPer300s: 1200000, clock: fakeClock().clock });
  assert.equal(limits.headers("u1")["x-ms-ratelimit-time-remaining-xrm-requests"], "1,200.00");
});

test("a disabled limit never rejects and its header is omitted", () => {
  const limits = createServiceProtection({ requestsPer300s: 1 });
  assert.equal(limits.admit("u1").ok, true);
  assert.equal(limits.admit("u1").ok, false);
  const unlimited = createServiceProtection();
  for (let i = 0; i < 100; i += 1) assert.equal(unlimited.admit("u1").ok, true);
  assert.deepEqual(unlimited.headers("u1"), {});
});

test("limits are per user", () => {
  const limits = createServiceProtection({ requestsPer300s: 1, clock: fakeClock().clock });
  assert.equal(limits.admit("u1").ok, true);
  assert.equal(limits.admit("u1").ok, false);
  assert.equal(limits.admit("u2").ok, true);
});
