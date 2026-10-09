import test from "node:test";
import assert from "node:assert/strict";
import { awaitNetworkQuiet, frameState, inflightWrites, ofCurrentDocument } from "../lib/navigation-settle.mjs";

// Synthetic CDP Network records and Page frame events; no browser is involved.
const events = [
  { event: "frameNavigated", frameId: "main", loaderId: "L1" },
  { event: "frameAttached", frameId: "child", parentFrameId: "main" },
  { event: "frameNavigated", frameId: "child", parentFrameId: "main", loaderId: "C1" },
  { event: "frameNavigated", frameId: "main", loaderId: "L2" },
  { event: "frameDetached", frameId: "child", reason: "remove" },
  { event: "frameAttached", frameId: "moved", parentFrameId: "main" },
  { event: "frameNavigated", frameId: "moved", parentFrameId: "main", loaderId: "M1" },
  { event: "frameDetached", frameId: "moved", reason: "swap" },
];

test("frame state keeps each frame's current document and removed frames", () => {
  const state = frameState(events);
  assert.deepEqual([...state.loaders], [["main", "L2"], ["child", "C1"], ["moved", "M1"]]);
  assert.deepEqual([...state.detached], ["child"]);
  assert.equal(ofCurrentDocument({ frameId: "main", loaderId: "L2" }, state), true);
  assert.equal(ofCurrentDocument({ frameId: "main", loaderId: "L1" }, state), false);
  assert.equal(ofCurrentDocument({ frameId: "child", loaderId: "C1" }, state), false);
  // A frame swapped into another renderer process continues.
  assert.equal(ofCurrentDocument({ frameId: "moved", loaderId: "M1" }, state), true);
  // Records without a loader, or of frames not yet navigated, count as current.
  assert.equal(ofCurrentDocument({ frameId: "main" }, state), true);
  assert.equal(ofCurrentDocument({ frameId: "new", loaderId: "N1" }, state), true);
});

test("in-flight writes exclude replaced documents and removed frames", () => {
  const parents = new Map([["child", "main"], ["moved", "main"]]);
  const records = [
    { frameId: "main", loaderId: "L1", method: "PATCH", type: "XHR", path: "/_api/contacts(1)" },
    { frameId: "main", loaderId: "L2", method: "POST", type: "Fetch", path: "/save" },
    { frameId: "child", loaderId: "C1", method: "POST", type: "XHR", path: "/child" },
    { frameId: "main", loaderId: "L2", method: "GET", type: "XHR", path: "/read" },
    { frameId: "main", loaderId: "L2", method: "POST", type: "XHR", path: "/done", finishedTimestamp: 1 },
  ];
  assert.deepEqual(inflightWrites(records, "main", parents, frameState(events)).map((row) => row.path), ["/save"]);
  // Without frame state every unfinished write counts.
  assert.deepEqual(inflightWrites(records, "main", parents).map((row) => row.path), ["/_api/contacts(1)", "/save", "/child"]);
});

test("network quiet waits for the current documents' requests, ignores dead and streaming ones, and is bounded", async () => {
  const state = () => frameState(events);
  const records = [
    { frameId: "main", loaderId: "L1", method: "GET", type: "Script", path: "/old.js" },
    { frameId: "main", loaderId: "L2", method: "GET", type: "EventSource", path: "/__sim/events" },
    { frameId: "main", loaderId: "L2", method: "GET", type: "XHR", path: "/__sim/events" },
  ];
  const quiet = await awaitNetworkQuiet(() => records, { frames: state, timeout: 2000, quietMs: 100, poll: 10, ignore: (row) => row.path.startsWith("/__sim/events") });
  assert.equal(quiet.settled, true);
  // A load-time chain: a token read, then a write started after it; both must finish.
  const chain = [{ frameId: "main", loaderId: "L2", method: "GET", type: "XHR", path: "/token" }];
  setTimeout(() => {
    chain[0].finishedTimestamp = 1;
    chain.push({ frameId: "main", loaderId: "L2", method: "PATCH", type: "XHR", path: "/_api/contacts(1)" });
  }, 60);
  setTimeout(() => (chain[1].finishedTimestamp = 2), 160);
  const started = Date.now();
  const waited = await awaitNetworkQuiet(() => chain, { frames: state, timeout: 3000, quietMs: 100, poll: 10 });
  assert.equal(waited.settled, true);
  assert.ok(Date.now() - started >= 250, "quiet only after the write finished and the page stayed idle");
  // A pending navigation (document request) counts whatever its loader; the wait is bounded.
  const bounded = await awaitNetworkQuiet(() => [{ frameId: "main", loaderId: "L9", method: "GET", type: "Document", path: "/next/" }], { frames: state, timeout: 150, quietMs: 50, poll: 10 });
  assert.deepEqual({ settled: bounded.settled, pending: bounded.pending }, { settled: false, pending: ["GET /next/"] });
});

test("a pending document of a frame whose parent document was replaced no longer holds the page busy", async () => {
  // Chromium may report neither the child's removal nor an end for its document request.
  const events = [
    { event: "frameNavigated", frameId: "main", loaderId: "L1" },
    { event: "frameAttached", frameId: "modal", parentFrameId: "main" },
    { event: "frameNavigated", frameId: "main", loaderId: "L2" },
  ];
  const state = () => frameState(events);
  assert.deepEqual([...state().detached], ["modal"]);
  const records = [{ frameId: "modal", loaderId: "M1", method: "GET", type: "Document", path: "/_portal/modal-form-template-path/site" }];
  const quiet = await awaitNetworkQuiet(() => records, { frames: state, timeout: 2000, quietMs: 50, poll: 10 });
  assert.equal(quiet.settled, true);
  // A document still loading in a live frame does hold it.
  events.push({ event: "frameAttached", frameId: "next", parentFrameId: "main" });
  records.push({ frameId: "next", loaderId: "N1", method: "GET", type: "Document", path: "/next/" });
  const busy = await awaitNetworkQuiet(() => records, { frames: state, timeout: 120, quietMs: 50, poll: 10 });
  assert.deepEqual(busy.pending, ["GET /next/"]);
});
