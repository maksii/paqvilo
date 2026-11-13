// @test-kind contract: a route answer is ignored only when its page or context is gone
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerRoute } from '../lib/closed-route.mjs';

const routeOn = (page) => ({ request: () => ({ frame: () => ({ page: () => page }) }) });
const pageWith = (closed) => ({ isClosed: () => closed });
const failure = new Error('anything');
const isFailure = (error) => error === failure;

test('a failed answer resolves when its page is closed, whatever the error text', async () => {
  await assert.doesNotReject(answerRoute(routeOn(pageWith(true)), () => Promise.reject(failure)));
});

test('a failed answer rethrows when its page is open, even when the text names a closed target', async () => {
  const closedTarget = new Error('Target page, context or browser has been closed');
  await assert.rejects(
    answerRoute(routeOn(pageWith(false)), () => Promise.reject(closedTarget)),
    (error) => error === closedTarget,
  );
});

test('a failed answer rethrows when its page is open', async () => {
  await assert.rejects(
    answerRoute(routeOn(pageWith(false)), () => Promise.reject(failure)),
    isFailure,
  );
});

test('a failed answer resolves when its context is closed, while its page is open', async () => {
  const contextClosed = () => true;
  await assert.doesNotReject(answerRoute(routeOn(pageWith(false)), () => Promise.reject(failure), { contextClosed }));
});

test('a failed answer rethrows while its context is open', async () => {
  const contextClosed = () => false;
  await assert.rejects(
    answerRoute(routeOn(pageWith(false)), () => Promise.reject(failure), { contextClosed }),
    isFailure,
  );
});

test('a route whose page cannot be reached is not treated as closed, so its failure is rethrown', async () => {
  const frameless = {
    request: () => ({
      frame: () => {
        throw failure;
      },
    }),
  };
  const closedCheckFails = {
    isClosed: () => {
      throw failure;
    },
  };
  const pageless = { request: () => ({ frame: () => ({ page: () => closedCheckFails }) }) };
  await assert.rejects(
    answerRoute(frameless, () => Promise.reject(failure)),
    isFailure,
  );
  await assert.rejects(
    answerRoute(pageless, () => Promise.reject(failure)),
    isFailure,
  );
});

test('a route whose page cannot be reached is answered when its context is closed', async () => {
  const frameless = {
    request: () => ({
      frame: () => {
        throw failure;
      },
    }),
  };
  const contextClosed = () => true;
  await assert.doesNotReject(answerRoute(frameless, () => Promise.reject(failure), { contextClosed }));
});

test('a synchronous throw from the answer is handled like a rejection', async () => {
  await assert.rejects(
    answerRoute(routeOn(pageWith(false)), () => {
      throw failure;
    }),
    isFailure,
  );
  await assert.doesNotReject(
    answerRoute(routeOn(pageWith(true)), () => {
      throw failure;
    }),
  );
});

test('a successful answer resolves and runs the action once', async () => {
  let calls = 0;
  await answerRoute(routeOn(pageWith(false)), () => {
    calls += 1;
  });
  assert.equal(calls, 1);
});
