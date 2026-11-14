// @test-kind contract: an acknowledged local response is attributed only to the notification of its own request, bounded by count and bytes
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createResponseProofQueue } from '../lense/response-proof-queue.mjs';

const url = 'https://fixture.invalid/script.js?version=invented';
const urlKey = createHash('sha256').update(url).digest('hex');
const event = { networkId: 'actual-request', frameId: 'actual-frame', request: { url } };
const request = { frameId: 'actual-frame', loaderId: 'actual-loader', urlKey };

test('an acknowledged body waits for its actual Network frame, loader and full URL notification', async (t) => {
  const requests = new Map(),
    admitted = [];
  const queue = createResponseProofQueue({
    requests,
    admit: (...args) => {
      admitted.push(args);
      return true;
    },
  });
  t.after(() => queue.clear());
  const proof = { version: 1, proofId: 'invented-proof' };
  assert.equal(await queue.fulfill(event, proof), true);
  assert.equal(admitted.length, 0);
  queue.requested(event.networkId, { ...request, frameId: 'foreign-frame' });
  queue.requested(event.networkId, {
    ...request,
    urlKey: createHash('sha256')
      .update(url + '-other')
      .digest('hex'),
  });
  await Promise.resolve();
  assert.equal(admitted.length, 0);
  requests.set(event.networkId, request);
  queue.requested(event.networkId, request);
  await Promise.resolve();
  assert.deepEqual(admitted, [[request.frameId, request.loaderId, proof, request]]);
  queue.requested(event.networkId, request);
  assert.equal(admitted.length, 1, 'one acknowledgement never replays');
  assert.equal(await queue.fulfill({ ...event, networkId: 'second' }, proof), true);
  queue.requested('second', request);
  queue.clear();
  queue.requested('second', request);
  await Promise.resolve();
  assert.equal(admitted.length, 1);
  assert.equal(await queue.fulfill(event, proof), false);
});

test('evicted acknowledgements never acquire evidence from later requests', async () => {
  const requests = new Map(),
    admitted = [];
  const queue = createResponseProofQueue({ requests, admit: (...args) => admitted.push(args) });
  for (let i = 0; i < 257; i++) await queue.fulfill({ ...event, networkId: String(i) }, { proofId: String(i) });
  queue.requested('0', request);
  queue.requested('256', request);
  await Promise.resolve();
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0][2].proofId, '256');
  queue.clear();
  queue.requested('255', request);
  await Promise.resolve();
  assert.equal(admitted.length, 1, 'a cleared queue admits nothing');
});

test('a frame waits while its acknowledgement is queued, and forget or eviction ends that wait', async () => {
  const requests = new Map(),
    evicted = [];
  const queue = createResponseProofQueue({ requests, admit: () => true, evicted: (frameId) => evicted.push(frameId) });
  assert.equal(queue.waiting('actual-frame'), false);
  await queue.fulfill(event, { proofId: 'queued' });
  assert.equal(queue.waiting('actual-frame'), true);
  assert.equal(queue.waiting('other-frame'), false);
  queue.forget('actual-frame');
  assert.equal(queue.waiting('actual-frame'), false, 'the replaced document no longer holds the frame');
  for (let i = 0; i < 257; i++) await queue.fulfill({ ...event, networkId: String(i) }, { proofId: String(i) });
  assert.deepEqual(evicted, ['actual-frame'], 'the discarded acknowledgement names its frame');
  queue.requested('256', request);
  await Promise.resolve();
  queue.clear();
  assert.equal(queue.waiting('actual-frame'), false);
});

test('an acknowledgement whose network notification trails by any time is still admitted', async (t) => {
  const requests = new Map(),
    admitted = [];
  // The clocks the queue could read are owned here and moved far past any sweep interval.
  let now = performance.now();
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const queue = createResponseProofQueue({ requests, admit: (...args) => admitted.push(args) });
  t.after(() => queue.clear());
  const proof = { version: 1, proofId: 'late-notification' };
  assert.equal(await queue.fulfill(event, proof), true);
  now += 600_000;
  t.mock.timers.tick(600_000);
  queue.requested(event.networkId, request);
  await Promise.resolve();
  assert.deepEqual(admitted, [[request.frameId, request.loaderId, proof, request]]);
});

test('byte bounds discard old metadata and failed admission remains observed without unhandled rejection', async (t) => {
  const requests = new Map(),
    admitted = [];
  const queue = createResponseProofQueue({
    requests,
    admit: (_frame, _loader, proof) => {
      admitted.push(proof.proofId);
      throw new Error('Invented admission failure');
    },
  });
  t.after(() => queue.clear());
  const blob = 'x'.repeat(6 * 1024 * 1024);
  for (let i = 0; i < 3; i++) await queue.fulfill({ ...event, networkId: String(i) }, { proofId: String(i), blob });
  queue.requested('0', request);
  queue.requested('2', request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(admitted, ['2']);
  assert.equal(await queue.fulfill({ ...event, networkId: 'too-large' }, { blob: 'x'.repeat(8 * 1024 * 1024) }), false);
});
