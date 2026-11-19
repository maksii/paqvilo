// @test-kind contract: Paqvilo's acceptance runner rules for proving an authored read abort, on invented CDP and page records
import test from 'node:test';
import assert from 'node:assert/strict';
import { oneProofPerRecord, reconcileIntentionalReadAbort } from '../lib/intentional-abort.mjs';
// intentional-abort.mjs RECEIPT_SKEW_MS: how far apart the runner's two receipts of one send may lie.
const RECEIPT_SKEW_MS = 250;

function example() {
  const origin = 'http://127.0.0.1:8888',
    start = Date.parse('2026-10-07T12:00:00.000Z');
  const failure = {
    kind: 'network',
    requestKey: '7',
    url: origin + '/items?kind=current',
    method: 'GET',
    errorText: 'net::ERR_ABORTED',
  };
  const before = {
    requestId: 'old',
    path: '/items?kind=current',
    method: 'GET',
    frameId: 'frame',
    loaderId: 'document',
    startedAt: new Date(start).toISOString(),
    failure: 'net::ERR_ABORTED',
    failedAt: start + 200,
  };
  return {
    failure,
    origin,
    resources: [{ order: 7, type: 'xhr', started: start, finished: false }],
    cdpRecords: [
      before,
      {
        ...before,
        requestId: 'new',
        startedAt: new Date(start + 210).toISOString(),
        failure: undefined,
        status: 200,
        finishedTimestamp: 42,
      },
      {
        path: '/table.js',
        type: 'Script',
        startedAt: new Date(start - 100).toISOString(),
        status: 200,
        finishedTimestamp: 40,
      },
    ],
    sourceAborts: [
      {
        method: 'GET',
        url: failure.url,
        sentAt: start,
        at: start + 199,
        readyState: 1,
        stack: 'Error\n at reload (' + origin + '/table.js:5:6)',
      },
    ],
  };
}
test('Authored cancellation requires the same aborted read, loaded caller and one completed replacement', () => {
  const f = example(),
    proof = reconcileIntentionalReadAbort(f.failure, f);
  assert.equal(proof.replacementRequestId, 'new');
  assert.equal(proof.classification, 'source-cancelled-read');
  assert.equal(proof.browserResponseConsumptionObserved, false);
  for (const alter of [
    (f) => (f.failure.method = 'POST'),
    (f) => (f.failure.errorText = 'net::ERR_FAILED'),
    (f) => (f.sourceAborts = []),
    (f) => (f.sourceAborts[0].readyState = 4),
    (f) => (f.sourceAborts[0].url += '&other=1'),
    (f) => (f.sourceAborts[0].stack = 'Error at unknown'),
    (f) => (f.sourceAborts[0].sentAt -= 2000),
    (f) => (f.cdpRecords[1].status = 403),
    (f) => (f.cdpRecords[1].loaderId = 'other'),
    (f) => (f.cdpRecords[1].frameId = 'other'),
    (f) => delete f.cdpRecords[1].finishedTimestamp,
    (f) => f.cdpRecords.push({ ...f.cdpRecords[1], requestId: 'ambiguous' }),
    (f) => (f.resources[0].finished = true),
    (f) => (f.cdpRecords[0].failedAt -= 1000),
    (f) => (f.cdpRecords[2].startedAt = new Date(f.sourceAborts[0].at + 1000).toISOString()),
  ]) {
    const changed = example();
    alter(changed);
    assert.equal(reconcileIntentionalReadAbort(changed.failure, changed), null);
  }
});
// A wall clock stepped back between two polls (lab night medium-20261119 saw ~1 s steps on WSL) makes the later poll's
// wallTime earlier: the browser's monotonic timestamps still name the earliest completed read after the abort.
test('A wall clock stepped back between two replacement polls keeps the earlier started one as the replacement', () => {
  const f = example();
  const start = Date.parse(f.cdpRecords[0].startedAt);
  Object.assign(f.cdpRecords[1], { startedAt: new Date(start + 1500).toISOString(), startedTimestamp: 10.21 });
  f.cdpRecords.push({
    ...f.cdpRecords[1],
    requestId: 'later-poll',
    startedAt: new Date(start + 1100).toISOString(),
    startedTimestamp: 10.6,
  });
  assert.equal(reconcileIntentionalReadAbort(f.failure, f).replacementRequestId, 'new');
  f.cdpRecords[3].startedTimestamp = 10.21;
  assert.equal(reconcileIntentionalReadAbort(f.failure, f), null, 'two equally early polls stay ambiguous');
});
// The runner's Playwright request event and its receipt of the CDP send are runner readings; the page's send and abort are
// page readings; the browser's are CDP readings. A wall clock step between two of them (lab night medium-20261119 saw ~1 s
// steps on WSL) moves their wall difference by the step; each process's monotonic readings do not move.
test("A wall clock stepped between the browser's send and the runner's request event still binds the aborted read", () => {
  const f = example();
  f.cdpRecords[0].observedTicks = 1000;
  // Recorded 20 ms after the runner received the send, after a 1.2 s backward step.
  f.resources[0].started -= 1180;
  Object.defineProperty(f.resources[0], 'startedTicks', { value: 1020, writable: true });
  assert.equal(reconcileIntentionalReadAbort(f.failure, f).replacementRequestId, 'new');
  // Both are receipts of one send through one connection: the request event may also come first, never far apart.
  f.resources[0].startedTicks = 1000 - RECEIPT_SKEW_MS;
  assert.equal(reconcileIntentionalReadAbort(f.failure, f).replacementRequestId, 'new');
  f.resources[0].startedTicks = 1000 - RECEIPT_SKEW_MS - 1;
  assert.equal(reconcileIntentionalReadAbort(f.failure, f), null);
  f.resources[0].startedTicks = 1000 + RECEIPT_SKEW_MS + 1;
  assert.equal(reconcileIntentionalReadAbort(f.failure, f), null);
});
test('An aborted copy of the same read sent 2 s earlier is another send, not a second candidate', () => {
  const f = example();
  f.cdpRecords[0].observedTicks = 3000;
  Object.defineProperty(f.resources[0], 'startedTicks', { value: 3001 });
  // A navigation-cancelled copy of the same read, received 2 s before this one.
  f.cdpRecords.push({
    ...f.cdpRecords[0],
    requestId: 'cancelled-copy',
    startedAt: new Date(Date.parse(f.cdpRecords[0].startedAt) - 2000).toISOString(),
    observedTicks: 1000,
  });
  assert.equal(reconcileIntentionalReadAbort(f.failure, f).requestId, 'old');
});
test('One browser record proves at most one failure; two failures bound to it prove neither', () => {
  const proof = (requestId) => ({ requestId });
  const [a, b, c] = [proof('a'), proof('b'), proof('b')];
  assert.deepEqual(oneProofPerRecord([a, b, c]), [a]);
  assert.deepEqual(
    oneProofPerRecord([a, b], new Set(['a'])),
    [b],
    'a record an earlier proof used proves nothing more',
  );
});
test("A page wall clock stepped between send() and abort() keeps the abort's place among the browser's readings", () => {
  const stepped = (step) => {
    const f = example();
    Object.assign(f.cdpRecords[0], { startedTimestamp: 10, failedTimestamp: 10.2 });
    Object.assign(f.cdpRecords[1], { startedTimestamp: 10.21 });
    Object.assign(f.cdpRecords[2], { startedTimestamp: 9.9 });
    // send() took 0.1 ms; abort() came 199 ms after the send began and the replacement 11 ms later, both after the wall
    // clock stepped by `step`.
    Object.assign(f.sourceAborts[0], { sendStartTicks: 500, sendEndTicks: 500.1, abortTicks: 699 });
    f.sourceAborts[0].at += step;
    f.cdpRecords[1].startedAt = new Date(Date.parse(f.cdpRecords[1].startedAt) + step).toISOString();
    return f;
  };
  for (const step of [-1200, 1200]) {
    const f = stepped(step);
    assert.equal(reconcileIntentionalReadAbort(f.failure, f).replacementRequestId, 'new', `step ${step} ms`);
  }
  for (const [reason, alter] of [
    ['the failure precedes the abort', (f) => (f.sourceAborts[0].abortTicks = 702.1)],
    ['the abort precedes the send', (f) => (f.sourceAborts[0].abortTicks = 499)],
    ['the replacement started before the abort', (f) => (f.cdpRecords[1].startedTimestamp = 10.19)],
    ['the caller script started after the abort', (f) => (f.cdpRecords[2].startedTimestamp = 10.3)],
  ]) {
    const f = stepped(0);
    alter(f);
    assert.equal(reconcileIntentionalReadAbort(f.failure, f), null, reason);
  }
});
test('Protocol delivery latency cannot turn a proven authored cancellation into a hanging read', () => {
  const f = example();
  f.cdpRecords[0].failedAt += 5000;
  assert.equal(reconcileIntentionalReadAbort(f.failure, f).replacementRequestId, 'new');
});
test('Authored DataTables polling aborts of redirected portal fetch pages are intentional reads; other failures stay failures', () => {
  const origin = 'http://127.0.0.1:8888',
    start = Date.parse('2026-10-07T12:00:00.000Z');
  const query = '?id=change&type=getProducts&isAppId=false';
  const scenario = () => {
    const failure = {
      kind: 'network',
      requestKey: '146',
      url: origin + '/fetchactivities' + query,
      method: 'GET',
      errorText: 'net::ERR_ABORTED',
    };
    const read = { method: 'GET', frameId: 'frame', loaderId: 'document', type: 'XHR' };
    return {
      failure,
      origin,
      resources: [{ order: 146, type: 'xhr', started: start + 70, finished: false }],
      cdpRecords: [
        {
          ...read,
          requestId: 'aborted',
          path: '/fetchactivities' + query,
          startedAt: new Date(start).toISOString(),
          failure: 'net::ERR_ABORTED',
          failedAt: start + 650,
        },
        // The replacement read was redirected to the trailing-slash page.
        {
          ...read,
          requestId: 'replacement',
          path: '/fetchactivities/' + query,
          startedAt: new Date(start + 684).toISOString(),
          status: 200,
          finishedTimestamp: 50,
        },
        // Polling continues with later reads of the same page.
        {
          ...read,
          requestId: 'next-poll',
          path: '/fetchactivities/' + query,
          startedAt: new Date(start + 5000).toISOString(),
          status: 200,
          finishedTimestamp: 60,
        },
        {
          path: '/scripts/datatables.min.js',
          type: 'Script',
          startedAt: new Date(start - 2000).toISOString(),
          status: 200,
          finishedTimestamp: 10,
        },
        {
          path: '/scripts/jquery.min.js',
          type: 'Script',
          startedAt: new Date(start - 3000).toISOString(),
          status: 200,
          finishedTimestamp: 9,
        },
      ],
      sourceAborts: [
        {
          method: 'GET',
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
  assert.equal(proof.classification, 'source-cancelled-read');
  assert.equal(proof.replacementRequestId, 'replacement');
  assert.deepEqual(proof.sourceScripts, ['/scripts/jquery.min.js', '/scripts/datatables.min.js']);
  for (const alter of [
    // No authored abort observed: a genuinely failed read.
    (f) => (f.sourceAborts = []),
    // The only later read targets another record.
    (f) => f.cdpRecords.splice(1, 2, { ...f.cdpRecords[1], path: '/fetchactivities/?id=other' }),
    // The replacement failed.
    (f) => f.cdpRecords.splice(1, 2, { ...f.cdpRecords[1], status: 500 }),
    // Two equally early replacements are ambiguous.
    (f) => (f.cdpRecords[2].startedAt = f.cdpRecords[1].startedAt),
    // Another page or a cross-origin read is never reconciled.
    (f) => (f.failure.url = 'http://elsewhere.invalid/fetchactivities' + query),
  ]) {
    const changed = scenario();
    alter(changed);
    assert.equal(reconcileIntentionalReadAbort(changed.failure, changed), null);
  }
});

test("The runner's request record may trail the browser's send by the measured lag, never precede it", async () => {
  const { REQUEST_EVENT_LAG } = await import('../lib/intentional-abort.mjs');
  const at = (lag) => {
    const f = example();
    f.resources[0].started += lag;
    return reconcileIntentionalReadAbort(f.failure, f)?.replacementRequestId ?? null;
  };
  // Lags up to 1625 ms have been measured, so a 1 s window is too short.
  assert.equal(at(1625), 'new');
  assert.equal(at(REQUEST_EVENT_LAG.afterMs), 'new');
  assert.equal(at(REQUEST_EVENT_LAG.afterMs + 1), null);
  assert.equal(at(-REQUEST_EVENT_LAG.beforeMs - 1), null);
  // Two aborted copies inside the window leave the read unbound.
  const f = example();
  f.resources[0].started += 1500;
  f.cdpRecords.push({
    ...f.cdpRecords[0],
    requestId: 'older',
    startedAt: new Date(Date.parse(f.cdpRecords[0].startedAt) - 1000).toISOString(),
  });
  assert.equal(reconcileIntentionalReadAbort(f.failure, f), null);
});
