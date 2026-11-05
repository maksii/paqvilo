// @test-kind contract: model-driven panel updates retain their established coalescing boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelDrivenPanelSources } from '../lense/model-driven-panel.mjs';

test('an empty panel completes before a later update is queued', async () => {
  const panel = await createModelDrivenPanelSources({ assets: new Map(), layers: [] });
  const first = panel.update();
  let second;
  queueMicrotask(() =>
    queueMicrotask(() => {
      second = panel.update();
    }),
  );
  await first;
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(second);
  assert.notStrictEqual(first, second);
  await second;
});
