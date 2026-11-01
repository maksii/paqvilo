import test from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitWritesBeforeDocument,
  awaitNetworkQuiet,
  frameState,
  inflightWrites,
  ofCurrentDocument,
} from '../lib/navigation-settle.mjs';

// The waits poll with setTimeout and measure with Date.now. A mocked clock advances them one poll at a time, so every
// elapsed time below is exact instead of a wall-clock bound that a busy runner can miss.
async function onMockedClock(t, wait, poll) {
  let done = false;
  wait.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) {
    t.mock.timers.tick(poll);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return wait;
}

test('a navigation hold honors a settle deadline introduced after the hold starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let deadline = Infinity;
  const wait = awaitWritesBeforeDocument(
    'main',
    () => [{ frameId: 'main', method: 'PATCH', type: 'XHR', path: '/slow' }],
    () => new Map(),
    { timeout: 2000, poll: 5, deadline: () => deadline },
  );
  setTimeout(() => {
    deadline = Date.now() + 30;
  }, 20);
  const result = await onMockedClock(t, wait, 5);
  assert.equal(result.settled, false);
  // The settle deadline introduced at 20 ms expires at 50 ms, long before the 2000 ms hold timeout.
  assert.equal(result.waitedMs, 50, 'the runner must not spend the full hold timeout after settling expires');
});

// Synthetic CDP Network records and Page frame events; no browser is involved.
const events = [
  { event: 'frameNavigated', frameId: 'main', loaderId: 'L1' },
  { event: 'frameAttached', frameId: 'child', parentFrameId: 'main' },
  { event: 'frameNavigated', frameId: 'child', parentFrameId: 'main', loaderId: 'C1' },
  { event: 'frameNavigated', frameId: 'main', loaderId: 'L2' },
  { event: 'frameDetached', frameId: 'child', reason: 'remove' },
  { event: 'frameAttached', frameId: 'moved', parentFrameId: 'main' },
  { event: 'frameNavigated', frameId: 'moved', parentFrameId: 'main', loaderId: 'M1' },
  { event: 'frameDetached', frameId: 'moved', reason: 'swap' },
];

test("frame state keeps each frame's current document and removed frames", () => {
  const state = frameState(events);
  assert.deepEqual(
    [...state.loaders],
    [
      ['main', 'L2'],
      ['child', 'C1'],
      ['moved', 'M1'],
    ],
  );
  assert.deepEqual([...state.detached], ['child']);
  assert.equal(ofCurrentDocument({ frameId: 'main', loaderId: 'L2' }, state), true);
  assert.equal(ofCurrentDocument({ frameId: 'main', loaderId: 'L1' }, state), false);
  assert.equal(ofCurrentDocument({ frameId: 'child', loaderId: 'C1' }, state), false);
  // A frame swapped into another renderer process continues.
  assert.equal(ofCurrentDocument({ frameId: 'moved', loaderId: 'M1' }, state), true);
  // Records without a loader, or of frames not yet navigated, count as current.
  assert.equal(ofCurrentDocument({ frameId: 'main' }, state), true);
  assert.equal(ofCurrentDocument({ frameId: 'new', loaderId: 'N1' }, state), true);
});

test('in-flight writes exclude replaced documents and removed frames', () => {
  const parents = new Map([
    ['child', 'main'],
    ['moved', 'main'],
  ]);
  const records = [
    { frameId: 'main', loaderId: 'L1', method: 'PATCH', type: 'XHR', path: '/_api/contacts(1)' },
    { frameId: 'main', loaderId: 'L2', method: 'POST', type: 'Fetch', path: '/save' },
    { frameId: 'child', loaderId: 'C1', method: 'POST', type: 'XHR', path: '/child' },
    { frameId: 'main', loaderId: 'L2', method: 'GET', type: 'XHR', path: '/read' },
    { frameId: 'main', loaderId: 'L2', method: 'POST', type: 'XHR', path: '/done', finishedTimestamp: 1 },
  ];
  assert.deepEqual(
    inflightWrites(records, 'main', parents, frameState(events)).map((row) => row.path),
    ['/save'],
  );
  // Without frame state every unfinished write counts.
  assert.deepEqual(
    inflightWrites(records, 'main', parents).map((row) => row.path),
    ['/_api/contacts(1)', '/save', '/child'],
  );
});

test("network quiet waits for the current documents' requests, ignores dead and streaming ones, and is bounded", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const state = () => frameState(events);
  const records = [
    { frameId: 'main', loaderId: 'L1', method: 'GET', type: 'Script', path: '/old.js' },
    { frameId: 'main', loaderId: 'L2', method: 'GET', type: 'EventSource', path: '/__sim/events' },
    { frameId: 'main', loaderId: 'L2', method: 'GET', type: 'XHR', path: '/__sim/events' },
  ];
  const quiet = await onMockedClock(
    t,
    awaitNetworkQuiet(() => records, {
      frames: state,
      timeout: 2000,
      quietMs: 100,
      poll: 10,
      ignore: (row) => row.path.startsWith('/__sim/events'),
    }),
    10,
  );
  assert.deepEqual([quiet.settled, quiet.waitedMs], [true, 100], 'nothing current is open: quiet after quietMs');
  // A load-time chain: a token read, then a write started after it; both must finish.
  const chain = [{ frameId: 'main', loaderId: 'L2', method: 'GET', type: 'XHR', path: '/token' }];
  setTimeout(() => {
    chain[0].finishedTimestamp = 1;
    chain.push({ frameId: 'main', loaderId: 'L2', method: 'PATCH', type: 'XHR', path: '/_api/contacts(1)' });
  }, 60);
  setTimeout(() => (chain[1].finishedTimestamp = 2), 160);
  const waited = await onMockedClock(
    t,
    awaitNetworkQuiet(() => chain, { frames: state, timeout: 3000, quietMs: 100, poll: 10 }),
    10,
  );
  assert.equal(waited.settled, true);
  // The write finishes at 160 ms; quiet needs quietMs (100 ms) after that.
  assert.ok(waited.waitedMs >= 260, 'quiet only after the write finished and the page stayed idle');
  // A pending navigation (document request) counts whatever its loader; the wait is bounded.
  const bounded = await onMockedClock(
    t,
    awaitNetworkQuiet(() => [{ frameId: 'main', loaderId: 'L9', method: 'GET', type: 'Document', path: '/next/' }], {
      frames: state,
      timeout: 150,
      quietMs: 50,
      poll: 10,
    }),
    10,
  );
  assert.deepEqual(
    { settled: bounded.settled, pending: bounded.pending, waitedMs: bounded.waitedMs },
    { settled: false, pending: ['GET /next/'], waitedMs: 150 },
  );
});

test('a pending document of a frame whose parent document was replaced no longer holds the page busy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  // Chromium may report neither the child's removal nor an end for its document request.
  const events = [
    { event: 'frameNavigated', frameId: 'main', loaderId: 'L1' },
    { event: 'frameAttached', frameId: 'modal', parentFrameId: 'main' },
    { event: 'frameNavigated', frameId: 'main', loaderId: 'L2' },
  ];
  const state = () => frameState(events);
  assert.deepEqual([...state().detached], ['modal']);
  const records = [
    {
      frameId: 'modal',
      loaderId: 'M1',
      method: 'GET',
      type: 'Document',
      path: '/_portal/modal-form-template-path/site',
    },
  ];
  const quiet = await onMockedClock(
    t,
    awaitNetworkQuiet(() => records, { frames: state, timeout: 2000, quietMs: 50, poll: 10 }),
    10,
  );
  assert.deepEqual([quiet.settled, quiet.waitedMs], [true, 50]);
  // A document still loading in a live frame does hold it.
  events.push({ event: 'frameAttached', frameId: 'next', parentFrameId: 'main' });
  records.push({ frameId: 'next', loaderId: 'N1', method: 'GET', type: 'Document', path: '/next/' });
  const busy = await onMockedClock(
    t,
    awaitNetworkQuiet(() => records, { frames: state, timeout: 120, quietMs: 50, poll: 10 }),
    10,
  );
  assert.deepEqual([busy.settled, busy.pending], [false, ['GET /next/']]);
  // Once the frame swaps to its own renderer, the document's end reaches only that target.
  records.at(-1).handedOff = true;
  const swapped = await onMockedClock(
    t,
    awaitNetworkQuiet(() => records, { frames: state, timeout: 2000, quietMs: 50, poll: 10 }),
    10,
  );
  assert.deepEqual([swapped.settled, swapped.waitedMs], [true, 50]);
});
