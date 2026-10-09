import test from "node:test";
import assert from "node:assert/strict";
import { reconcileIntentionalReadAbort } from "../lib/intentional-abort.mjs";

function example() {
  const origin = "http://127.0.0.1:8888",
    start = Date.parse("2026-10-07T12:00:00.000Z");
  const failure = {
    kind: "network",
    requestKey: "7",
    url: origin + "/items?kind=current",
    method: "GET",
    errorText: "net::ERR_ABORTED",
  };
  const before = {
    requestId: "old",
    path: "/items?kind=current",
    method: "GET",
    frameId: "frame",
    loaderId: "document",
    startedAt: new Date(start).toISOString(),
    failure: "net::ERR_ABORTED",
    failedAt: start + 200,
  };
  return {
    failure,
    origin,
    resources: [{ order: 7, type: "xhr", started: start, finished: false }],
    cdpRecords: [
      before,
      {
        ...before,
        requestId: "new",
        startedAt: new Date(start + 210).toISOString(),
        failure: undefined,
        status: 200,
        finishedTimestamp: 42,
      },
      {
        path: "/table.js",
        type: "Script",
        startedAt: new Date(start - 100).toISOString(),
        status: 200,
        finishedTimestamp: 40,
      },
    ],
    sourceAborts: [
      {
        method: "GET",
        url: failure.url,
        sentAt: start,
        at: start + 199,
        readyState: 1,
        stack: "Error\n at reload (" + origin + "/table.js:5:6)",
      },
    ],
  };
}
test("Authored cancellation requires the same aborted read, loaded caller and one completed replacement", () => {
  const f = example(),
    proof = reconcileIntentionalReadAbort(f.failure, f);
  assert.equal(proof.replacementRequestId, "new");
  assert.equal(proof.classification, "source-cancelled-read");
  assert.equal(proof.browserResponseConsumptionObserved, false);
  for (const alter of [
    (f) => (f.failure.method = "POST"),
    (f) => (f.failure.errorText = "net::ERR_FAILED"),
    (f) => (f.sourceAborts = []),
    (f) => (f.sourceAborts[0].readyState = 4),
    (f) => (f.sourceAborts[0].url += "&other=1"),
    (f) => (f.sourceAborts[0].stack = "Error at unknown"),
    (f) => (f.sourceAborts[0].sentAt -= 2000),
    (f) => (f.cdpRecords[1].status = 403),
    (f) => (f.cdpRecords[1].loaderId = "other"),
    (f) => (f.cdpRecords[1].frameId = "other"),
    (f) => delete f.cdpRecords[1].finishedTimestamp,
    (f) => f.cdpRecords.push({ ...f.cdpRecords[1], requestId: "ambiguous" }),
    (f) => (f.resources[0].finished = true),
    (f) => (f.cdpRecords[0].failedAt -= 1000),
    (f) =>
      (f.cdpRecords[2].startedAt = new Date(
        f.sourceAborts[0].at + 1000,
      ).toISOString()),
  ]) {
    const changed = example();
    alter(changed);
    assert.equal(reconcileIntentionalReadAbort(changed.failure, changed), null);
  }
});
test("Protocol delivery latency cannot turn a proven authored cancellation into a hanging read", () => {
  const f = example();
  f.cdpRecords[0].failedAt += 5000;
  assert.equal(
    reconcileIntentionalReadAbort(f.failure, f).replacementRequestId,
    "new",
  );
});
test("Authored DataTables polling aborts of redirected portal fetch pages are intentional reads; other failures stay failures", () => {
  const origin = "http://127.0.0.1:8888",
    start = Date.parse("2026-10-07T12:00:00.000Z");
  const query = "?id=change&type=getProducts&isAppId=false";
  const scenario = () => {
    const failure = { kind: "network", requestKey: "146", url: origin + "/fetchactivities" + query, method: "GET", errorText: "net::ERR_ABORTED" };
    const read = { method: "GET", frameId: "frame", loaderId: "document", type: "XHR" };
    return {
      failure,
      origin,
      resources: [{ order: 146, type: "xhr", started: start + 70, finished: false }],
      cdpRecords: [
        { ...read, requestId: "aborted", path: "/fetchactivities" + query, startedAt: new Date(start).toISOString(), failure: "net::ERR_ABORTED", failedAt: start + 650 },
        // The replacement read was redirected to the trailing-slash page.
        { ...read, requestId: "replacement", path: "/fetchactivities/" + query, startedAt: new Date(start + 684).toISOString(), status: 200, finishedTimestamp: 50 },
        // Polling continues with later reads of the same page.
        { ...read, requestId: "next-poll", path: "/fetchactivities/" + query, startedAt: new Date(start + 5000).toISOString(), status: 200, finishedTimestamp: 60 },
        { path: "/scripts/datatables.min.js", type: "Script", startedAt: new Date(start - 2000).toISOString(), status: 200, finishedTimestamp: 10 },
        { path: "/scripts/jquery.min.js", type: "Script", startedAt: new Date(start - 3000).toISOString(), status: 200, finishedTimestamp: 9 },
      ],
      sourceAborts: [
        {
          method: "GET",
          url: failure.url,
          sentAt: start,
          at: start + 6,
          readyState: 1,
          stack: `Error: Authored XHR abort\n at Object.abort (${origin}/scripts/jquery.min.js:2:82791)\n at De (${origin}/scripts/datatables.min.js:30:48604)`,
        },
      ],
    };
  };
  const proof = reconcileIntentionalReadAbort(scenario().failure, scenario());
  assert.equal(proof.classification, "source-cancelled-read");
  assert.equal(proof.replacementRequestId, "replacement");
  assert.deepEqual(proof.sourceScripts, ["/scripts/jquery.min.js", "/scripts/datatables.min.js"]);
  for (const alter of [
    // No authored abort observed: a genuinely failed read.
    (f) => (f.sourceAborts = []),
    // The only later read targets another record.
    (f) => f.cdpRecords.splice(1, 2, { ...f.cdpRecords[1], path: "/fetchactivities/?id=other" }),
    // The replacement failed.
    (f) => f.cdpRecords.splice(1, 2, { ...f.cdpRecords[1], status: 500 }),
    // Two equally early replacements are ambiguous.
    (f) => (f.cdpRecords[2].startedAt = f.cdpRecords[1].startedAt),
    // Another page or a cross-origin read is never reconciled.
    (f) => (f.failure.url = "http://elsewhere.invalid/fetchactivities" + query),
  ]) {
    const changed = scenario();
    alter(changed);
    assert.equal(reconcileIntentionalReadAbort(changed.failure, changed), null);
  }
});

test("The runner's request record may trail the browser's send by the measured lag, never precede it", async () => {
  const { REQUEST_EVENT_LAG } = await import("../lib/intentional-abort.mjs");
  const at = (lag) => {
    const f = example();
    f.resources[0].started += lag;
    return reconcileIntentionalReadAbort(f.failure, f)?.replacementRequestId ?? null;
  };
  // 1625 ms was the largest lag measured in saved evidence; the old 1 s window rejected it.
  assert.equal(at(1625), "new");
  assert.equal(at(REQUEST_EVENT_LAG.afterMs), "new");
  assert.equal(at(REQUEST_EVENT_LAG.afterMs + 1), null);
  assert.equal(at(-REQUEST_EVENT_LAG.beforeMs - 1), null);
  // Two aborted copies inside the window leave the read unbound.
  const f = example();
  f.resources[0].started += 1500;
  f.cdpRecords.push({ ...f.cdpRecords[0], requestId: "older", startedAt: new Date(Date.parse(f.cdpRecords[0].startedAt) - 1000).toISOString() });
  assert.equal(reconcileIntentionalReadAbort(f.failure, f), null);
});
