// @test-kind contract: Paqvilo's acceptance runner rules for proving a superseded read, on invented CDP records and audit rows
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSupersededRead, correlateNetworkConsole } from '../lib/request-evidence.mjs';
// intentional-abort.mjs RECEIPT_SKEW_MS: how far apart the runner's two receipts of one send may lie.
const RECEIPT_SKEW_MS = 250;
const fixture = () => {
  const identity = { contactId: 'local-contact', roles: ['Manager'] };
  const request = {
    method: 'GET',
    path: '/_api/examples?fetchXml=%3Cfetch%20count%3D%221%22%2F%3E',
    startedAt: '2026-10-07T12:00:00.000Z',
    parentTrace: 'parent',
    identity,
  };
  const cdpRecords = [
    {
      ...request,
      requestId: 'xhr',
      loaderId: 'old',
      frameId: 'main',
      type: 'XHR',
    },
    {
      method: 'GET',
      path: '/current/',
      startedAt: '2026-10-07T12:00:00.100Z',
      requestId: 'doc',
      loaderId: 'new',
      frameId: 'main',
      type: 'Document',
      status: 200,
      finishedTimestamp: 10,
    },
  ];
  const audit = {
    items: [
      {
        id: 'server',
        parentId: 'parent',
        correlationId: 'parent',
        identity,
        method: 'GET',
        path: '/_api/examples',
        query: { fetchXml: '<fetch count="1"/>' },
        startedAt: '2026-10-07T12:00:00.010Z',
        status: 200,
        outcome: 'success',
        durationMs: 10,
      },
    ],
  };
  return { request, cdpRecords, audit, origin: 'http://127.0.0.1:8888' };
};
test('Superseded read needs exact independent server proof, identity, trace and newer completed same-frame document', () => {
  const f = fixture(),
    proof = reconcileSupersededRead(f.request, f);
  assert.equal(proof.serverAuditId, 'server');
  assert.equal(proof.browserResponseConsumptionObserved, false);
  assert.equal(proof.browserFinalEventAbsent, true);
  assert.equal(proof.outcome, 'superseded');
  for (const mutate of [
    (f) => f.cdpRecords.pop(),
    (f) => (f.cdpRecords[1].frameId = 'other'),
    (f) => (f.cdpRecords[1].loaderId = 'old'),
    (f) => delete f.cdpRecords[1].finishedTimestamp,
    (f) => (f.audit.items[0].query.fetchXml = '<different/>'),
    (f) => (f.audit.items[0].status = 499),
    (f) => (f.audit.items[0].outcome = 'error'),
    (f) => delete f.audit.items[0].durationMs,
    (f) => f.audit.items.push({ ...f.audit.items[0], id: 'ambiguous' }),
    (f) => (f.cdpRecords[0].failure = 'net::ERR_ABORTED'),
    (f) => (f.request.method = 'PATCH'),
    (f) => (f.request.method = 'POST'),
    (f) => (f.request.path = 'https://live.example/_api/examples?fetchXml=x'),
    (f) => (f.audit.items[0].identity = { contactId: 'other', roles: ['Manager'] }),
    (f) => (f.audit.items[0].parentId = 'other'),
    (f) => (f.audit.items[0].startedAt = '2026-10-07T12:00:02.000Z'),
    (f) => (f.request.path += '&fetchXml=x'),
  ]) {
    const denied = fixture();
    mutate(denied);
    assert.equal(reconcileSupersededRead(denied.request, denied), null);
  }
});
test('Static orphan requires same actual resource type and URL successfully loaded in replacement document; API never uses this proof', () => {
  const f = fixture();
  f.audit.items = [];
  f.request.path = '/jquery.js';
  f.cdpRecords[0].path = '/jquery.js';
  f.cdpRecords[0].type = 'Script';
  f.cdpRecords.push({
    ...f.cdpRecords[0],
    requestId: 'new-script',
    loaderId: 'new',
    startedAt: '2026-10-07T12:00:00.200Z',
    status: 200,
    finishedTimestamp: 11,
  });
  assert.equal(reconcileSupersededRead(f.request, f).proof, 'same-resource-reloaded');
  assert.equal(reconcileSupersededRead(f.request, f).olderServerCompletionObserved, false);
  for (const mutate of [
    (f) => (f.cdpRecords[2].status = 404),
    (f) => (f.cdpRecords[2].type = 'Fetch'),
    (f) => (f.cdpRecords[2].loaderId = 'other'),
    (f) => delete f.cdpRecords[2].finishedTimestamp,
    (f) => (f.cdpRecords[0].type = 'XHR'),
    (f) => {
      f.request.path = '/_api/file.js';
      f.cdpRecords[0].path = f.request.path;
      f.cdpRecords[2].path = f.request.path;
    },
  ]) {
    const copy = structuredClone(f);
    mutate(copy);
    assert.equal(reconcileSupersededRead(copy.request, copy), null);
  }
});
test('A jQuery script load (XHR with a numeric _ cache-buster) is proven only by its reloaded script or style copy', () => {
  const f = fixture();
  f.audit.items = [];
  f.request.path = '/scripts/core.js?_=1001';
  f.cdpRecords[0].path = f.request.path;
  f.cdpRecords.push({
    ...f.cdpRecords[0],
    path: '/scripts/core.js?_=2002',
    requestId: 'new-xhr',
    loaderId: 'new',
    startedAt: '2026-10-07T12:00:00.200Z',
    status: 200,
    mimeType: 'application/javascript',
    finishedTimestamp: 11,
  });
  const proof = reconcileSupersededRead(f.request, f);
  assert.equal(proof.proof, 'same-resource-reloaded');
  assert.equal(proof.resourceType, 'XHR');
  assert.equal(proof.cacheBusterIgnored, '_');
  assert.equal(proof.reloadedMimeType, 'application/javascript');
  assert.equal(proof.olderServerCompletionObserved, false);
  for (const mutate of [
    (f) => (f.cdpRecords[2].mimeType = 'application/json'),
    (f) => delete f.cdpRecords[2].mimeType,
    (f) => (f.cdpRecords[2].path = '/scripts/core.js?_=2002&v=2'),
    (f) => (f.cdpRecords[2].type = 'Script'),
    (f) => (f.cdpRecords[2].status = 500),
    (f) => {
      f.request.path = '/scripts/core.js';
      f.cdpRecords[0].path = f.request.path;
    },
    (f) => {
      f.request.path = '/scripts/core.js?_=now';
      f.cdpRecords[0].path = f.request.path;
    },
    (f) => {
      f.request.path = '/_api/core.js?_=1001';
      f.cdpRecords[0].path = f.request.path;
      f.cdpRecords[2].path = '/_api/core.js?_=2002';
    },
  ]) {
    const copy = structuredClone(f);
    mutate(copy);
    assert.equal(reconcileSupersededRead(copy.request, copy), null);
  }
});
test('Old page can issue a read while its replacing document is still loading; completion must follow that read', () => {
  const f = fixture();
  f.cdpRecords[0].startedTimestamp = 10.05;
  f.cdpRecords[0].startedAt = '2026-10-07T12:00:00.050Z';
  f.cdpRecords[1].startedAt = '2026-10-07T12:00:00.040Z';
  f.cdpRecords[1].finishedTimestamp = 10.1;
  f.cdpRecords.push({
    type: 'Document',
    loaderId: 'old',
    frameId: 'main',
    startedAt: '2026-10-07T11:59:59.000Z',
    finishedTimestamp: 9,
  });
  assert.equal(reconcileSupersededRead(f.request, f).proof, 'exact-server-audit');
  f.cdpRecords[1].finishedTimestamp = 10.04;
  assert.equal(reconcileSupersededRead(f.request, f), null);
});
// A wall clock stepped back between two document loads (lab night medium-20261119 saw ~1 s steps on WSL) makes the later
// document's wallTime older than the page it replaced: the browser's monotonic timestamps still order them.
test('A wall clock stepped back before the replacing document still proves the read superseded by the newest document', () => {
  const f = fixture();
  const at = (offset) => new Date(Date.parse('2026-10-07T12:00:00.000Z') + offset).toISOString();
  Object.assign(f.cdpRecords[0], { startedTimestamp: 9.5 });
  f.cdpRecords[1] = {
    type: 'Document',
    method: 'GET',
    path: '/current/',
    requestId: 'old-doc',
    loaderId: 'old',
    frameId: 'main',
    startedAt: at(-500),
    startedTimestamp: 9,
    status: 200,
    finishedTimestamp: 9.2,
  };
  const document = (loaderId, offset, startedTimestamp) => ({
    ...f.cdpRecords[1],
    requestId: loaderId,
    loaderId,
    startedAt: at(offset),
    startedTimestamp,
    finishedTimestamp: startedTimestamp + 0.05,
  });
  // 'b' starts 100 ms after the read; the clock then steps back 1 s before 'new' starts 200 ms after it.
  f.cdpRecords.push(document('b', 100, 9.6), document('new', 200 - 1000, 9.7));
  const proof = reconcileSupersededRead(f.request, f);
  assert.equal(proof.proof, 'exact-server-audit');
  assert.equal(proof.replacementLoaderId, 'new');
});
const childFrameFixture = () => {
  const f = fixture();
  f.request.path = '/scripts/snippets?_=123';
  f.cdpRecords[0].path = f.request.path;
  f.cdpRecords[0].frameId = 'child-old';
  f.cdpRecords[0].startedTimestamp = 10;
  f.cdpRecords[1] = {
    ...f.cdpRecords[1],
    frameId: 'child-new',
    path: '/modal?form=one',
    finishedTimestamp: 11,
  };
  f.audit.items[0].path = '/scripts/snippets';
  f.audit.items[0].query = { _: '123' };
  f.cdpRecords.push(
    {
      type: 'Document',
      frameId: 'parent',
      loaderId: 'parent-old',
      path: '/page',
      startedAt: '2026-10-07T11:59:58.000Z',
      status: 200,
      finishedTimestamp: 8,
    },
    {
      type: 'Document',
      frameId: 'child-old',
      loaderId: 'old',
      path: '/modal?form=one',
      startedAt: '2026-10-07T11:59:59.000Z',
      status: 200,
      finishedTimestamp: 9,
    },
    {
      type: 'Document',
      frameId: 'parent',
      loaderId: 'parent-new',
      path: '/page?canonical=1',
      startedAt: '2026-10-07T12:00:00.050Z',
      status: 200,
      finishedTimestamp: 10.5,
    },
  );
  f.frameEvents = [
    {
      event: 'frameNavigated',
      frameId: 'child-old',
      parentFrameId: 'parent',
      loaderId: 'old',
    },
  ];
  f.currentFrames = [
    { id: 'parent', loaderId: 'parent-new' },
    { id: 'child-new', parentId: 'parent', loaderId: 'new' },
  ];
  return f;
};
test('A destroyed child frame needs a current frame tree, replaced parent and identical completed child document', () => {
  const f = childFrameFixture();
  const proof = reconcileSupersededRead(f.request, f);
  assert.equal(proof.proof, 'exact-server-audit');
  assert.equal(proof.replacedChildFrame.currentFrameTreeObserved, true);
  assert.equal(proof.browserResponseConsumptionObserved, false);
  for (const mutate of [
    (f) =>
      f.currentFrames.push({
        id: 'child-old',
        parentId: 'parent',
        loaderId: 'old',
      }),
    (f) => (f.currentFrames = []),
    (f) => (f.frameEvents = []),
    (f) => (f.cdpRecords[1].path = '/modal?form=other'),
    (f) => (f.currentFrames[1].parentId = 'other'),
    (f) => (f.cdpRecords[4].status = 500),
    (f) => delete f.cdpRecords[4].finishedTimestamp,
    (f) => (f.request.method = 'POST'),
  ]) {
    const copy = structuredClone(f);
    mutate(copy);
    assert.equal(reconcileSupersededRead(copy.request, copy), null);
  }
});
// The runner's request event, its receipt of the CDP send and of frame events, the browser's wallTime and the server's audit
// start are wall readings of different moments: a step between two of them (lab night medium-20261119 saw ~1 s steps on
// WSL) moves their difference by the step. The runner's monotonic readings (startedTicks, observedTicks) do not move.
test("A wall clock stepped between the browser's send and the runner's request event still binds the pending read", () => {
  const f = fixture();
  f.audit.items = [];
  f.request.path = '/jquery.js';
  Object.assign(f.cdpRecords[0], { path: '/jquery.js', type: 'Script', observedTicks: 5000 });
  f.cdpRecords.push({
    ...f.cdpRecords[0],
    requestId: 'new-script',
    loaderId: 'new',
    startedAt: '2026-10-07T12:00:00.200Z',
    status: 200,
    finishedTimestamp: 11,
  });
  // The runner records its request event 20 ms after it received the send, after a 1.2 s backward step.
  Object.assign(f.request, { startedAt: '2026-10-07T11:59:58.820Z', startedTicks: 5020 });
  assert.equal(reconcileSupersededRead(f.request, f).proof, 'same-resource-reloaded');
  // Both receipts of one send come through one connection, in either order, at most RECEIPT_SKEW_MS apart.
  f.request.startedTicks = 5000 - RECEIPT_SKEW_MS;
  assert.equal(reconcileSupersededRead(f.request, f).proof, 'same-resource-reloaded');
  f.request.startedTicks = 5000 + RECEIPT_SKEW_MS + 1;
  assert.equal(reconcileSupersededRead(f.request, f), null);
  f.request.startedTicks = 5000 - RECEIPT_SKEW_MS - 1;
  assert.equal(reconcileSupersededRead(f.request, f), null);
  // A second identical pending send inside that bound leaves the read unbound.
  f.request.startedTicks = 5020;
  f.cdpRecords.push({ ...f.cdpRecords[0], requestId: 'twin', observedTicks: 5100 });
  assert.equal(reconcileSupersededRead(f.request, f), null);
});
test('An abandoned copy of the same read sent 2 s apart is another send, not a second candidate', () => {
  const f = fixture();
  f.request.startedTicks = 5020;
  f.cdpRecords[0].observedTicks = 5000;
  // DataTables polling: an aborted copy 2 s before and an abandoned one 2 s after, both still without finishedTimestamp.
  f.cdpRecords.push(
    { ...f.cdpRecords[0], requestId: 'aborted-copy', observedTicks: 3000, failure: 'net::ERR_ABORTED' },
    { ...f.cdpRecords[0], requestId: 'abandoned-copy', observedTicks: 7000 },
  );
  assert.equal(reconcileSupersededRead(f.request, f).requestId, 'xhr');
});
test('A wall clock stepped back between the child frame attaching and the read keeps the frame attached before the read', () => {
  const f = childFrameFixture();
  f.request.startedTicks = 5000;
  f.cdpRecords[0].observedTicks = 5000;
  // Observed 500 ms before the read on the runner's monotonic clock, 1.5 s after it on a wall clock stepped back 2 s.
  f.frameEvents = [
    {
      event: 'frameAttached',
      frameId: 'child-old',
      parentFrameId: 'parent',
      observedAt: '2026-10-07T12:00:01.500Z',
      observedTicks: 4500,
    },
  ];
  assert.equal(reconcileSupersededRead(f.request, f).replacedChildFrame.removedFrameId, 'child-old');
  // A frame attached more than 1 s after the read is a different attachment.
  f.frameEvents[0].observedTicks = 6001;
  assert.equal(reconcileSupersededRead(f.request, f), null);
});
test("The server audit id the browser received binds the audit row whatever the server's wall clock read", () => {
  const f = fixture();
  // The server's wall clock read 1.5 s before the runner's request event: a step between the two readings.
  f.audit.items[0].startedAt = '2026-10-07T11:59:58.500Z';
  assert.equal(reconcileSupersededRead(f.request, f), null, 'without the audit id only the wall readings link them');
  f.cdpRecords[0].serverTraceId = 'server';
  assert.equal(reconcileSupersededRead(f.request, f).serverAuditId, 'server');
  f.cdpRecords[0].serverTraceId = 'other';
  assert.equal(reconcileSupersededRead(f.request, f), null);
});
test("The host's monotonic clock links the runner's request start to the loopback server's audit start", () => {
  const f = fixture();
  // The server began 10 ms after the runner's request event on the host's monotonic clock; its wall clock had stepped
  // back 1.5 s in between.
  f.request.startedHostMs = 80000;
  f.sharedHostClock = true;
  Object.assign(f.audit.items[0], { startedAt: '2026-10-07T11:59:58.510Z', startedHostMs: 80010 });
  assert.equal(reconcileSupersededRead(f.request, f).serverAuditId, 'server');
  // An honest clock outside the window: the wall and monotonic readings agree that they are 1.5 s apart.
  Object.assign(f.audit.items[0], { startedHostMs: 81500, startedAt: '2026-10-07T12:00:01.500Z' });
  assert.equal(reconcileSupersededRead(f.request, f), null);
  f.audit.items[0].startedHostMs = 78500;
  assert.equal(reconcileSupersededRead(f.request, f), null);
  // Older audit data without the monotonic reading keeps the wall window.
  delete f.audit.items[0].startedHostMs;
  f.audit.items[0].startedAt = '2026-10-07T12:00:00.010Z';
  assert.equal(reconcileSupersededRead(f.request, f).serverAuditId, 'server');
});
test("Without a proven shared host clock the server's monotonic reading is ignored and the wall window decides", () => {
  const f = fixture();
  // A server in another VM or time namespace: its monotonic reading is unrelated to the runner's.
  f.request.startedHostMs = 80000;
  f.audit.items[0].startedHostMs = 9000000;
  assert.equal(reconcileSupersededRead(f.request, f).serverAuditId, 'server', 'honest wall clocks 10 ms apart');
  f.audit.items[0].startedAt = '2026-10-07T11:59:58.510Z';
  assert.equal(reconcileSupersededRead(f.request, f), null, 'a stepped wall clock refuses, as without the reading');
});
test('Observed server trace disambiguates identical reads without relaxing identity or query matching', () => {
  const f = fixture();
  f.cdpRecords[0].serverTraceId = 'server';
  f.audit.items.push({ ...f.audit.items[0], id: 'another' });
  assert.equal(reconcileSupersededRead(f.request, f).serverAuditId, 'server');
  f.cdpRecords[0].serverTraceId = 'absent';
  assert.equal(reconcileSupersededRead(f.request, f), null);
});
test('Only zero-argument browser HTTP diagnostics correlate; script errors, missing HTTP proof and other resources remain errors', () => {
  const message = {
    text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
    argumentCount: 0,
    url: 'http://127.0.0.1:8888/missing.woff',
  };
  const failures = [{ kind: 'http', method: 'GET', url: message.url, status: 404 }];
  assert.equal(correlateNetworkConsole(message, failures).response, failures[0]);
  for (const invalid of [
    { ...message, argumentCount: 1 },
    { ...message, url: message.url + '?different=1' },
    { ...message, text: 'Uncaught TypeError: unavailable' },
    {
      ...message,
      text: 'Failed to load resource: the server responded with a status of 500 (Server Error)',
    },
  ])
    assert.equal(correlateNetworkConsole(invalid, failures), null);
  assert.equal(correlateNetworkConsole(message, []), null);
});

test('A portal page read that the replacing document issued again and completed is superseded; API reads are not', () => {
  const f = fixture();
  f.audit.items = [];
  f.request.path = '/fetchbanner/?scope=header';
  f.cdpRecords[0].path = f.request.path;
  f.cdpRecords.push({
    ...f.cdpRecords[0],
    requestId: 'reissued',
    loaderId: 'new',
    startedAt: '2026-10-07T12:00:00.400Z',
    status: 200,
    finishedTimestamp: 12,
  });
  const proof = reconcileSupersededRead(f.request, f);
  assert.equal(proof.proof, 'same-read-reissued');
  assert.equal(proof.reissuedRequestId, 'reissued');
  assert.equal(proof.olderServerCompletionObserved, false);
  for (const mutate of [
    (f) => {
      f.request.path = '/_api/banners';
      f.cdpRecords[0].path = f.request.path;
      f.cdpRecords[2].path = f.request.path;
    },
    (f) => (f.cdpRecords[2].path = '/fetchbanner/?scope=footer'),
    (f) => delete f.cdpRecords[2].finishedTimestamp,
    (f) => (f.cdpRecords[2].status = 500),
    (f) => (f.cdpRecords[2].loaderId = 'other'),
    (f) => f.cdpRecords.push({ ...f.cdpRecords[2], requestId: 'twice' }),
  ]) {
    const copy = structuredClone(f);
    mutate(copy);
    assert.equal(reconcileSupersededRead(copy.request, copy), null);
  }
});
