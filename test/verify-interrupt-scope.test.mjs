// @test-kind contract: work abandoned by an interrupt is settled before verify removes its working folder
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeLateBrowser, createInterruptScope } from '../lense/commands/verify.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('an interrupt rejects the wait with its reason, and settled() waits for the abandoned work', async () => {
  const controller = new AbortController();
  const reason = new Error('Verification was interrupted by SIGINT');
  const scope = createInterruptScope(controller.signal);
  const work = deferred();
  const order = [];
  work.promise.then(() => order.push('work finished'));
  controller.abort(reason);
  const waiting = scope.until(work.promise);
  await assert.rejects(waiting, reason);
  const drained = scope.settled().then(() => order.push('settled'));
  work.resolve('late value');
  await drained;
  assert.deepEqual(order, ['work finished', 'settled'], 'settled() resolves only after the abandoned work');
});

test('a browser that finishes launching after the interrupt is closed before closeLateBrowser returns', async () => {
  const closeCalled = deferred();
  const closeDone = deferred();
  const log = [];
  const late = {
    close: () => {
      closeCalled.resolve();
      return closeDone.promise.then(() => log.push('closed'));
    },
  };
  const running = closeLateBrowser(Promise.resolve(late), undefined).then(() => log.push('returned'));
  await closeCalled.promise;
  // the close has been called and is held: one turn lets a caller that does not wait for it return
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, [], 'closeLateBrowser does not return while the close is pending');
  closeDone.resolve();
  await running;
  assert.deepEqual(log, ['closed', 'returned']);
});

test('a browser the run already closed is not closed again by a late launch', async () => {
  const calls = [];
  const late = { close: () => calls.push('late close') };
  await closeLateBrowser(Promise.resolve(late), () => {});
  assert.deepEqual(calls, []);
});

test('a launch that fails after the interrupt leaves no browser to close', async () => {
  await assert.doesNotReject(closeLateBrowser(Promise.reject(new Error('launch failed')), undefined));
});
