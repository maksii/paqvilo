import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileSupersededRead,
  correlateNetworkConsole,
} from "../lib/request-evidence.mjs";
const fixture = () => {
  const identity = { contactId: "local-contact", roles: ["Manager"] };
  const request = {
    method: "GET",
    path: "/_api/examples?fetchXml=%3Cfetch%20count%3D%221%22%2F%3E",
    startedAt: "2026-10-07T12:00:00.000Z",
    parentTrace: "parent",
    identity,
  };
  const cdpRecords = [
    {
      ...request,
      requestId: "xhr",
      loaderId: "old",
      frameId: "main",
      type: "XHR",
    },
    {
      method: "GET",
      path: "/current/",
      startedAt: "2026-10-07T12:00:00.100Z",
      requestId: "doc",
      loaderId: "new",
      frameId: "main",
      type: "Document",
      status: 200,
      finishedTimestamp: 10,
    },
  ];
  const audit = {
    items: [
      {
        id: "server",
        parentId: "parent",
        correlationId: "parent",
        identity,
        method: "GET",
        path: "/_api/examples",
        query: { fetchXml: '<fetch count="1"/>' },
        startedAt: "2026-10-07T12:00:00.010Z",
        status: 200,
        outcome: "success",
        durationMs: 10,
      },
    ],
  };
  return { request, cdpRecords, audit, origin: "http://127.0.0.1:8888" };
};
test("Superseded read needs exact independent server proof, identity, trace and newer completed same-frame document", () => {
  const f = fixture(),
    proof = reconcileSupersededRead(f.request, f);
  assert.equal(proof.serverAuditId, "server");
  assert.equal(proof.browserResponseConsumptionObserved, false);
  assert.equal(proof.browserFinalEventAbsent, true);
  assert.equal(proof.outcome, "superseded");
  for (const mutate of [
    (f) => f.cdpRecords.pop(),
    (f) => (f.cdpRecords[1].frameId = "other"),
    (f) => (f.cdpRecords[1].loaderId = "old"),
    (f) => delete f.cdpRecords[1].finishedTimestamp,
    (f) => (f.audit.items[0].query.fetchXml = "<different/>"),
    (f) => (f.audit.items[0].status = 499),
    (f) => (f.audit.items[0].outcome = "error"),
    (f) => delete f.audit.items[0].durationMs,
    (f) => f.audit.items.push({ ...f.audit.items[0], id: "ambiguous" }),
    (f) => (f.cdpRecords[0].failure = "net::ERR_ABORTED"),
    (f) => (f.request.method = "PATCH"),
    (f) => (f.request.method = "POST"),
    (f) => (f.request.path = "https://live.example/_api/examples?fetchXml=x"),
    (f) =>
      (f.audit.items[0].identity = { contactId: "other", roles: ["Manager"] }),
    (f) => (f.audit.items[0].parentId = "other"),
    (f) => (f.audit.items[0].startedAt = "2026-10-07T12:00:02.000Z"),
    (f) => (f.request.path += "&fetchXml=x"),
  ]) {
    const denied = fixture();
    mutate(denied);
    assert.equal(reconcileSupersededRead(denied.request, denied), null);
  }
});
test("Static orphan requires same actual resource type and URL successfully loaded in replacement document; API never uses this proof", () => {
  const f = fixture();
  f.audit.items = [];
  f.request.path = "/jquery.js";
  f.cdpRecords[0].path = "/jquery.js";
  f.cdpRecords[0].type = "Script";
  f.cdpRecords.push({
    ...f.cdpRecords[0],
    requestId: "new-script",
    loaderId: "new",
    startedAt: "2026-10-07T12:00:00.200Z",
    status: 200,
    finishedTimestamp: 11,
  });
  assert.equal(
    reconcileSupersededRead(f.request, f).proof,
    "same-resource-reloaded",
  );
  assert.equal(
    reconcileSupersededRead(f.request, f).olderServerCompletionObserved,
    false,
  );
  for (const mutate of [
    (f) => (f.cdpRecords[2].status = 404),
    (f) => (f.cdpRecords[2].type = "Fetch"),
    (f) => (f.cdpRecords[2].loaderId = "other"),
    (f) => delete f.cdpRecords[2].finishedTimestamp,
    (f) => (f.cdpRecords[0].type = "XHR"),
    (f) => {
      f.request.path = "/_api/file.js";
      f.cdpRecords[0].path = f.request.path;
      f.cdpRecords[2].path = f.request.path;
    },
  ]) {
    const copy = structuredClone(f);
    mutate(copy);
    assert.equal(reconcileSupersededRead(copy.request, copy), null);
  }
});
test("A jQuery script load (XHR with a numeric _ cache-buster) is proven only by its reloaded script or style copy", () => {
  const f = fixture();
  f.audit.items = [];
  f.request.path = "/scripts/core.js?_=1001";
  f.cdpRecords[0].path = f.request.path;
  f.cdpRecords.push({
    ...f.cdpRecords[0],
    path: "/scripts/core.js?_=2002",
    requestId: "new-xhr",
    loaderId: "new",
    startedAt: "2026-10-07T12:00:00.200Z",
    status: 200,
    mimeType: "application/javascript",
    finishedTimestamp: 11,
  });
  const proof = reconcileSupersededRead(f.request, f);
  assert.equal(proof.proof, "same-resource-reloaded");
  assert.equal(proof.resourceType, "XHR");
  assert.equal(proof.cacheBusterIgnored, "_");
  assert.equal(proof.reloadedMimeType, "application/javascript");
  assert.equal(proof.olderServerCompletionObserved, false);
  for (const mutate of [
    (f) => (f.cdpRecords[2].mimeType = "application/json"),
    (f) => delete f.cdpRecords[2].mimeType,
    (f) => (f.cdpRecords[2].path = "/scripts/core.js?_=2002&v=2"),
    (f) => (f.cdpRecords[2].type = "Script"),
    (f) => (f.cdpRecords[2].status = 500),
    (f) => {
      f.request.path = "/scripts/core.js";
      f.cdpRecords[0].path = f.request.path;
    },
    (f) => {
      f.request.path = "/scripts/core.js?_=now";
      f.cdpRecords[0].path = f.request.path;
    },
    (f) => {
      f.request.path = "/_api/core.js?_=1001";
      f.cdpRecords[0].path = f.request.path;
      f.cdpRecords[2].path = "/_api/core.js?_=2002";
    },
  ]) {
    const copy = structuredClone(f);
    mutate(copy);
    assert.equal(reconcileSupersededRead(copy.request, copy), null);
  }
});
test("Old page can issue a read while its replacing document is still loading; completion must follow that read", () => {
  const f = fixture();
  f.cdpRecords[0].startedTimestamp = 10.05;
  f.cdpRecords[0].startedAt = "2026-10-07T12:00:00.050Z";
  f.cdpRecords[1].startedAt = "2026-10-07T12:00:00.040Z";
  f.cdpRecords[1].finishedTimestamp = 10.1;
  f.cdpRecords.push({
    type: "Document",
    loaderId: "old",
    frameId: "main",
    startedAt: "2026-10-07T11:59:59.000Z",
    finishedTimestamp: 9,
  });
  assert.equal(
    reconcileSupersededRead(f.request, f).proof,
    "exact-server-audit",
  );
  f.cdpRecords[1].finishedTimestamp = 10.04;
  assert.equal(reconcileSupersededRead(f.request, f), null);
});
test("A destroyed child frame needs a current frame tree, replaced parent and identical completed child document", () => {
  const f = fixture();
  f.request.path = "/scripts/snippets?_=123";
  f.cdpRecords[0].path = f.request.path;
  f.cdpRecords[0].frameId = "child-old";
  f.cdpRecords[0].startedTimestamp = 10;
  f.cdpRecords[1] = {
    ...f.cdpRecords[1],
    frameId: "child-new",
    path: "/modal?form=one",
    finishedTimestamp: 11,
  };
  f.audit.items[0].path = "/scripts/snippets";
  f.audit.items[0].query = { _: "123" };
  f.cdpRecords.push(
    {
      type: "Document",
      frameId: "parent",
      loaderId: "parent-old",
      path: "/page",
      startedAt: "2026-10-07T11:59:58.000Z",
      status: 200,
      finishedTimestamp: 8,
    },
    {
      type: "Document",
      frameId: "child-old",
      loaderId: "old",
      path: "/modal?form=one",
      startedAt: "2026-10-07T11:59:59.000Z",
      status: 200,
      finishedTimestamp: 9,
    },
    {
      type: "Document",
      frameId: "parent",
      loaderId: "parent-new",
      path: "/page?canonical=1",
      startedAt: "2026-10-07T12:00:00.050Z",
      status: 200,
      finishedTimestamp: 10.5,
    },
  );
  f.frameEvents = [
    {
      event: "frameNavigated",
      frameId: "child-old",
      parentFrameId: "parent",
      loaderId: "old",
    },
  ];
  f.currentFrames = [
    { id: "parent", loaderId: "parent-new" },
    { id: "child-new", parentId: "parent", loaderId: "new" },
  ];
  const proof = reconcileSupersededRead(f.request, f);
  assert.equal(proof.proof, "exact-server-audit");
  assert.equal(proof.replacedChildFrame.currentFrameTreeObserved, true);
  assert.equal(proof.browserResponseConsumptionObserved, false);
  for (const mutate of [
    (f) =>
      f.currentFrames.push({
        id: "child-old",
        parentId: "parent",
        loaderId: "old",
      }),
    (f) => (f.currentFrames = []),
    (f) => (f.frameEvents = []),
    (f) => (f.cdpRecords[1].path = "/modal?form=other"),
    (f) => (f.currentFrames[1].parentId = "other"),
    (f) => (f.cdpRecords[4].status = 500),
    (f) => delete f.cdpRecords[4].finishedTimestamp,
    (f) => (f.request.method = "POST"),
  ]) {
    const copy = structuredClone(f);
    mutate(copy);
    assert.equal(reconcileSupersededRead(copy.request, copy), null);
  }
});
test("Observed server trace disambiguates identical reads without relaxing identity or query matching", () => {
  const f = fixture();
  f.cdpRecords[0].serverTraceId = "server";
  f.audit.items.push({ ...f.audit.items[0], id: "another" });
  assert.equal(reconcileSupersededRead(f.request, f).serverAuditId, "server");
  f.cdpRecords[0].serverTraceId = "absent";
  assert.equal(reconcileSupersededRead(f.request, f), null);
});
test("Only zero-argument browser HTTP diagnostics correlate; script errors, missing HTTP proof and other resources remain errors", () => {
  const message = {
    text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
    argumentCount: 0,
    url: "http://127.0.0.1:8888/missing.woff",
  };
  const failures = [
    { kind: "http", method: "GET", url: message.url, status: 404 },
  ];
  assert.equal(
    correlateNetworkConsole(message, failures).response,
    failures[0],
  );
  for (const invalid of [
    { ...message, argumentCount: 1 },
    { ...message, url: message.url + "?different=1" },
    { ...message, text: "Uncaught TypeError: unavailable" },
    {
      ...message,
      text: "Failed to load resource: the server responded with a status of 500 (Server Error)",
    },
  ])
    assert.equal(correlateNetworkConsole(invalid, failures), null);
  assert.equal(correlateNetworkConsole(message, []), null);
});

test("A portal page read that the replacing document issued again and completed is superseded; API reads are not", () => {
  const f = fixture();
  f.audit.items = [];
  f.request.path = "/fetchbanner/?scope=header";
  f.cdpRecords[0].path = f.request.path;
  f.cdpRecords.push({
    ...f.cdpRecords[0],
    requestId: "reissued",
    loaderId: "new",
    startedAt: "2026-10-07T12:00:00.400Z",
    status: 200,
    finishedTimestamp: 12,
  });
  const proof = reconcileSupersededRead(f.request, f);
  assert.equal(proof.proof, "same-read-reissued");
  assert.equal(proof.reissuedRequestId, "reissued");
  assert.equal(proof.olderServerCompletionObserved, false);
  for (const mutate of [
    (f) => {
      f.request.path = "/_api/banners";
      f.cdpRecords[0].path = f.request.path;
      f.cdpRecords[2].path = f.request.path;
    },
    (f) => (f.cdpRecords[2].path = "/fetchbanner/?scope=footer"),
    (f) => delete f.cdpRecords[2].finishedTimestamp,
    (f) => (f.cdpRecords[2].status = 500),
    (f) => (f.cdpRecords[2].loaderId = "other"),
    (f) => f.cdpRecords.push({ ...f.cdpRecords[2], requestId: "twice" }),
  ]) {
    const copy = structuredClone(f);
    mutate(copy);
    assert.equal(reconcileSupersededRead(copy.request, copy), null);
  }
});
