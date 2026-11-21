// @test-kind contract: a request that runs a data pack's cloud flow or server logic handler ends when the handler returns nothing or never settles
import test from 'node:test';
import assert from 'node:assert/strict';
import { packHandlerAnswer } from '../lib/pack-handler-answer.mjs';

/** A clock whose one timer fires only when the test fires it. */
function ownedClock() {
  const armed = new Set();
  return {
    armed,
    setTimeout: (fire, ms) => {
      const timer = { fire, ms };
      armed.add(timer);
      return timer;
    },
    clearTimeout: (timer) => armed.delete(timer),
  };
}

const flow = { kind: 'cloudFlows', name: 'Invented Flow', describe: 'the flow response { status, body }' };

test('the answer of a handler that settles is returned and its guard is released', async () => {
  const clock = ownedClock();
  const answer = { status: 200, body: { ok: true } };
  assert.equal(await packHandlerAnswer(flow, async () => answer, { clock }), answer);
  assert.equal(await packHandlerAnswer(flow, () => answer, { clock }), answer, 'a synchronous handler too');
  assert.equal(clock.armed.size, 0);
});

test('a handler that never settles ends its request with 504 at the limit, naming the handler', async () => {
  const clock = ownedClock();
  let calls = 0;
  const pending = packHandlerAnswer(flow, () => (calls++, new Promise(() => {})), { clock });
  const refused = assert.rejects(pending, (error) => {
    assert.equal(error.status, 504);
    assert.equal(error.code, 'PackHandlerTimeout');
    assert.equal(
      error.message,
      'The data pack\'s cloudFlows handler for "Invented Flow" did not answer within 120 s. A handler must return or throw; this request no longer waits for it.',
    );
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    [...clock.armed].map(({ ms }) => ms),
    [120_000],
  );
  [...clock.armed][0].fire();
  await refused;
  assert.equal(calls, 1);
  assert.equal(clock.armed.size, 0, 'the fired guard is released');
});

test('a handler that returns nothing or null is refused by name, not by a missing property; any other value is its answer', async () => {
  const clock = ownedClock();
  assert.equal(await packHandlerAnswer(flow, () => 'done', { clock }), 'done');
  assert.equal(await packHandlerAnswer(flow, () => 0, { clock }), 0);
  for (const [value, got] of [
    [undefined, 'nothing'],
    [null, 'null'],
  ])
    await assert.rejects(
      packHandlerAnswer(flow, () => value, { clock }),
      (error) => {
        assert.equal(error.status, 500);
        assert.equal(error.code, 'PackHandlerAnswerInvalid');
        assert.equal(
          error.message,
          `The data pack's cloudFlows handler for "Invented Flow" returned ${got}; it must return the flow response { status, body }.`,
        );
        return true;
      },
    );
  assert.equal(clock.armed.size, 0);
});

test('what a handler throws or rejects with is passed on unchanged', async () => {
  const clock = ownedClock();
  const failure = Object.assign(new Error('invented handler failure'), { status: 409 });
  await assert.rejects(
    packHandlerAnswer(
      flow,
      () => {
        throw failure;
      },
      { clock },
    ),
    (error) => error === failure,
  );
  await assert.rejects(
    packHandlerAnswer(flow, () => Promise.reject(failure), { clock }),
    (error) => error === failure,
  );
  assert.equal(clock.armed.size, 0);
});

test('a handler that rejects after its request stopped waiting raises no unhandled rejection', async (t) => {
  const clock = ownedClock();
  const late = Promise.withResolvers();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const refused = assert.rejects(
    packHandlerAnswer(flow, () => late.promise, { clock }),
    /did not answer within 120 s/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  [...clock.armed][0].fire();
  await refused;
  late.reject(new Error('invented late rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test('a server logic handler may return nothing: only its time is bounded', async () => {
  const clock = ownedClock();
  assert.equal(
    await packHandlerAnswer({ kind: 'serverLogics', name: 'invented', usable: () => true }, () => undefined, { clock }),
    undefined,
  );
});
