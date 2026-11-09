// @test-kind contract: legacy manifest metadata is validated and admitted from both source directories and archives.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { readCanvasSource, canvasSourceCoverageGaps } from '../lib/canvas-source.mjs';
import { createCanvasApp } from '../lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { msappOf } from './canvas-runtime-fixture.mjs';

const files = {
  'Src/App.fx.yaml': 'App As appinfo:\n',
  'Src/Alpha.fx.yaml': 'Alpha As screen:\n',
  'Src/Zulu.fx.yaml': 'Zulu As screen:\n',
};

// @test-kind parity: two native Canvas player starts used the first legacy CanvasManifest.ScreenOrder entry; exact native source hash and captures bound by canvas-native-input.test.mjs.
// @parity-evidence: current native msapp hash b22a13aa82f398a6290bae806a9c65c52a9009f977a3931d05fb8950d6f54860 and two source-bound draft probes; no explicit App.StartScreen in that source.
test('legacy manifest order selects the native first screen instead of alphabetic file order', async () => {
  const evidence = fs.readFileSync(new URL('./fixtures/canvas-draft-input-native.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(evidence).digest('hex'),
    '53da0137b56a0e32e4c224d8124719991cd1f984d1d1d9a6d7aab3cd9d489fbc',
  );
  const source = await readCanvasSource({
    msapp: msappOf({ ...files, 'CanvasManifest.json': JSON.stringify({ ScreenOrder: ['Zulu', 'Alpha'] }) }),
  });
  assert.deepEqual(source.app.screensOrder, ['Zulu', 'Alpha']);
  const app = createCanvasApp({ app: { uniqueName: 'invented', source }, evaluator: createPowerFxEvaluator() });
  assert.equal((await app.start()).currentScreen, 'Zulu');
});

// @test-kind contract: corrupt legacy manifests remain visible coverage failures rather than silently selecting a default.
test('invalid legacy ScreenOrder is diagnosed as a source coverage gap', async () => {
  for (const manifest of [
    '{',
    '{"ScreenOrder":"Zulu"}',
    '{"ScreenOrder":[1]}',
    '{"ScreenOrder":["Zulu","Zulu"]}',
    '{"ScreenOrder":["Missing"]}',
  ]) {
    const source = await readCanvasSource({ msapp: msappOf({ ...files, 'CanvasManifest.json': manifest }) });
    assert.ok(canvasSourceCoverageGaps(source).some(({ code }) => code === 'CANVAS_SOURCE_MANIFEST_INVALID'));
  }
});
