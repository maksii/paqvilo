import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasRuntime } from '../lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';

function app(revision, onStart = '=Set(starts, Coalesce(starts, 0) + 1)') {
  return {
    uniqueName: 'invented',
    source: {
      revision,
      tree: { screens: [{ name: 'Home', controls: [] }] },
      dataSources: [{ name: 'Svc', connectorId: 'invented' }],
      formulas: [{ owner: 'App', property: 'OnStart', text: onStart }],
    },
  };
}

test('source revisions evict stale sessions without starting a replacement on read', async () => {
  let current = app('one');
  const runtime = createCanvasRuntime({ apps: () => [current], evaluator: createPowerFxEvaluator() });
  const principal = { kind: 'staff', principalId: 'invented' };
  const first = await runtime.session('invented', principal);
  assert.equal(first.snapshot().sourceRevision, 'one');
  assert.equal(first.snapshot().variables.starts, 1);
  current = app('two');
  assert.equal(runtime.existing('invented', principal), null);
  assert.equal(runtime.size, 0);
  assert.equal(runtime.existing('invented', principal), null);
  const second = await runtime.session('invented', principal);
  assert.notEqual(second, first);
  assert.equal(second.snapshot().sourceRevision, 'two');
  assert.equal(second.snapshot().variables.starts, 1);
  assert.equal(runtime.existing('invented', principal), second);
});

test('undefined revisions keep legacy reuse and removed apps evict sessions', async () => {
  let apps = [app(undefined)];
  const runtime = createCanvasRuntime({ apps: () => apps, evaluator: createPowerFxEvaluator() });
  const first = await runtime.session('invented', null);
  apps = [app(undefined, '=Set(other, true)')];
  assert.equal(await runtime.session('invented', null), first);
  apps = [];
  assert.equal(runtime.existing('invented', null), null);
});

test('a failed old start cannot delete a newer revision session', async () => {
  let unblock, signal;
  const entered = new Promise((resolve) => {
    signal = resolve;
  });
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  let current = app('one', '=Set(reply, Svc.Wait({})); Launch("https://example.test")');
  const runtime = createCanvasRuntime({
    apps: () => [current],
    evaluator: createPowerFxEvaluator(),
    connectors: async () => {
      signal();
      await gate;
      return { statusCode: 200, body: {} };
    },
    launch: () => {
      throw new Error('controlled old start failure');
    },
  });
  const old = runtime.session('invented', null);
  await entered;
  current = app('two');
  const newer = await runtime.session('invented', null);
  assert.equal(newer.snapshot().sourceRevision, 'two');
  unblock();
  await assert.rejects(old, /controlled old start failure/);
  assert.equal(runtime.existing('invented', null), newer);
  assert.equal(runtime.size, 1);
});
