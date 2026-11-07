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

test('expired or evicted acknowledgements never acquire evidence from later requests', async (t) => {
  const requests = new Map(),
    admitted = [];
  // The queue ages entries by performance.now() and sweeps them with a timer; both are controlled here.
  let now = performance.now();
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queue = createResponseProofQueue({ requests, admit: (...args) => admitted.push(args) });
  t.after(() => queue.clear());
  for (let i = 0; i < 257; i++) await queue.fulfill({ ...event, networkId: String(i) }, { proofId: String(i) });
  queue.requested('0', request);
  queue.requested('256', request);
  await Promise.resolve();
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0][2].proofId, '256');
  now += 3100;
  // Before the sweep runs, a request still refuses an acknowledgement past its age.
  queue.requested('254', request);
  t.mock.timers.tick(3100);
  queue.requested('255', request);
  await Promise.resolve();
  assert.equal(admitted.length, 1);
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
