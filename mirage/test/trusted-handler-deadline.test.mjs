// @test-kind contract: an invocation of a data pack's workflows or dataverseMessages handler ends at the limit when the handler never settles, and its lifetime is closed
import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeTrustedHandler } from '../lib/trusted-handler-invocation.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';

/** A clock whose timers fire only when the test fires them. */
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
const turn = () => new Promise((resolve) => setImmediate(resolve));

function childStore() {
  const state = emptyState();
  state.mappings.child = {
    logicalName: 'child',
    entitySet: 'children',
    idColumn: 'childid',
    fields: { title: { dataverseType: 'nvarchar' } },
  };
  state.tables.child = [{ childid: 'abcdef00-0000-4000-8000-000000000001', title: 'Before' }];
  return new DataStore({ state });
}

test('a handler that never settles ends its invocation with 504 naming it, and what it kept no longer reaches the store', async () => {
  const clock = ownedClock();
  const store = childStore();
  const row = store.tableRows('child')[0];
  let retained;
  let calls = 0;
  const refused = assert.rejects(
    invokeTrustedHandler(
      { store },
      (ctx) => {
        calls += 1;
        retained = ctx.target.row;
        return new Promise(() => {});
      },
      { target: { logicalName: 'child', id: row.childid, row } },
      { workingTarget: true, label: 'The data pack\'s workflows handler for "Invented Workflow"', clock },
    ),
    (error) => {
      assert.equal(error.status, 504);
      assert.equal(error.code, 'PackHandlerTimeout');
      assert.equal(
        error.message,
        'The data pack\'s workflows handler for "Invented Workflow" did not answer within 120 s. A handler must return or throw; its invocation has ended.',
      );
      return true;
    },
  );
  await turn();
  assert.deepEqual(
    [...clock.armed].map(({ ms }) => ms),
    [120_000],
  );
  [...clock.armed][0].fire();
  await refused;
  assert.equal(calls, 1);
  assert.equal(clock.armed.size, 0, 'the fired guard is released');
  assert.throws(
    () => {
      retained.title = 'Late';
    },
    { code: 'LocalPluginExecutionExpired' },
  );
  assert.equal(store.tableRows('child')[0].title, 'Before');
});

test('a handler that settles returns its answer and releases its guard; what it throws is passed on', async () => {
  const clock = ownedClock();
  const store = childStore();
  assert.deepEqual(await invokeTrustedHandler({ store }, async () => ({ message: 'done' }), {}, { clock }), {
    message: 'done',
  });
  assert.equal(await invokeTrustedHandler({ store }, () => undefined, {}, { clock }), undefined);
  const failure = new Error('invented handler failure');
  await assert.rejects(
    invokeTrustedHandler(
      { store },
      () => {
        throw failure;
      },
      {},
      { clock },
    ),
    (error) => error === failure,
  );
  assert.equal(clock.armed.size, 0);
});

test('a handler that rejects after its invocation ended raises no unhandled rejection', async (t) => {
  const clock = ownedClock();
  const late = Promise.withResolvers();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const refused = assert.rejects(
    invokeTrustedHandler({ store: childStore() }, () => late.promise, {}, { clock }),
    /^Error: A data pack handler did not answer within 120 s\./,
  );
  await turn();
  [...clock.armed][0].fire();
  await refused;
  late.reject(new Error('invented late rejection'));
  await turn();
  assert.deepEqual(unhandled, []);
});
