// @test-kind tooling: finite browser workflows retain operation guards and drain timed-out work before fixture removal, without sleeps or retries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { workflowSteps } from './helpers/workflow-step.mjs';

function parentFixture() {
  const entered = Promise.withResolvers(),
    finish = Promise.withResolvers();
  const controller = new AbortController();
  const hooks = [];
  const context = { signal: controller.signal, after: (hook) => hooks.push(hook) };
  const parent = {
    async test(name, options, body) {
      assert.equal(name, 'invented operation');
      assert.equal(options.timeout, 300_000);
      const running = body(context);
      running.catch(() => {});
      entered.resolve();
      const timedOut = await finish.promise;
      if (!timedOut) await running.catch(() => {});
      for (const hook of hooks) await hook();
    },
  };
  return { parent, context, controller, entered, finish };
}

test('a complete step keeps its operation guard and does not cancel its resources', async () => {
  const f = parentFixture();
  let aborted = false,
    observed = false;
  const step = workflowSteps(f.parent, {
    guardMs: 300_000,
    abort: () => {
      aborted = true;
    },
  });
  const running = step('invented operation', async (signal) => {
    assert.equal(signal, f.context.signal);
    observed = true;
    return { acquired: true };
  });
  await f.entered.promise;
  f.finish.resolve();
  assert.deepEqual(await running, { acquired: true });
  assert.equal(observed, true);
  assert.equal(aborted, false);
});

test('a stopped step closes its resources and drains its body before fixture removal and failure', async () => {
  const f = parentFixture();
  const body = Promise.withResolvers(),
    started = Promise.withResolvers();
  let removed = false,
    drained = false,
    aborted = false;
  ownedFixture(f.context).remove(() => {
    assert.equal(drained, true);
    removed = true;
  });
  const step = workflowSteps(f.parent, {
    guardMs: 300_000,
    abort() {
      assert.equal(removed, false);
      aborted = true;
      body.reject(new Error('owned browser closed'));
      return true;
    },
  });
  const running = step('invented operation', async () => {
    started.resolve();
    try {
      await body.promise;
    } finally {
      drained = true;
    }
  });
  const rejected = assert.rejects(running, /Workflow step did not complete/);
  await started.promise;
  f.controller.abort();
  f.finish.resolve(true);
  await rejected;
  assert.equal(aborted, true);
  assert.equal(removed, true);
});

test('a timed-out acquisition without a handle does not trap cleanup and its late continuation stays cancelled', async () => {
  const f = parentFixture();
  const acquired = Promise.withResolvers(),
    started = Promise.withResolvers(),
    ended = Promise.withResolvers();
  let used = false;
  const step = workflowSteps(f.parent, { guardMs: 300_000, abort: () => false });
  const running = step('invented operation', async (signal) => {
    started.resolve();
    try {
      await acquired.promise;
      signal.throwIfAborted();
      used = true;
    } finally {
      ended.resolve();
    }
  });
  const rejected = assert.rejects(running, /Workflow step did not complete/);
  await started.promise;
  f.controller.abort();
  f.finish.resolve(true);
  await rejected;
  acquired.resolve();
  await ended.promise;
  assert.equal(used, false);
});
