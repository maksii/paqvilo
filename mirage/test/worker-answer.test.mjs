// @test-kind tooling: the worker test helper never terminates a worker that answered and forces only on the caller's abort
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { workerAnswer } from './support/worker-answer.mjs';

const ANSWER = "require('node:worker_threads').parentPort.postMessage({ ok: true });";

test('an answered worker is returned after its own exit and is never terminated', async (t) => {
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  assert.deepEqual(await workerAnswer(ANSWER, { eval: true, signal: t.signal }), { ok: true });
  assert.equal(terminate.mock.callCount(), 0);
});

test('a worker that throws rejects with its error and is not terminated', async (t) => {
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  await assert.rejects(workerAnswer("throw new RangeError('invented')", { eval: true }), {
    name: 'RangeError',
    message: 'invented',
  });
  assert.equal(terminate.mock.callCount(), 0);
});

test('a worker that exits without answering rejects with its exit code', async () => {
  await assert.rejects(workerAnswer('process.exit(3)', { eval: true }), /exited \(3\) before it answered/);
});

test('a cancelled wait terminates a worker that is still running', async (t) => {
  const terminate = t.mock.method(Worker.prototype, 'terminate');
  const controller = new AbortController();
  const pending = workerAnswer('for (;;);', { eval: true, signal: controller.signal });
  controller.abort(new Error('invented cancellation'));
  await assert.rejects(pending, { message: 'invented cancellation' });
  assert.equal(terminate.mock.callCount(), 1);
});

test('an abort after the answer does not terminate the worker', async (t) => {
  const terminate = t.mock.method(Worker.prototype, 'terminate', () => Promise.resolve());
  const controller = new AbortController();
  t.mock.method(Worker.prototype, 'emit', function (name, ...args) {
    if (name === 'exit') controller.abort(new Error('invented late cancellation'));
    return EventEmitter.prototype.emit.call(this, name, ...args);
  });
  assert.deepEqual(await workerAnswer(ANSWER, { eval: true, signal: controller.signal }), { ok: true });
  assert.equal(terminate.mock.callCount(), 0);
});
