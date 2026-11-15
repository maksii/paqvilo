import test from 'node:test';
import assert from 'node:assert/strict';
import { observedConfig } from '../lib/project-config.mjs';
import { canvasDisplayGeometry } from '../lib/canvas-display.mjs';

test('canvas display observations require evidence, known fields and bounded values', () => {
  assert.deepEqual(observedConfig({ canvasDisplay: { sample: { scaleToFit: true } }, evidence: 'invented fixture' }), {
    canvasDisplay: { sample: { scaleToFit: true } },
    evidence: 'invented fixture',
  });
  assert.throws(() => observedConfig({ canvasDisplay: { sample: { scaleToFit: true } } }), /evidence/);
  for (const policy of [
    { x: 1 },
    { designWidth: 0 },
    { designHeight: 8193 },
    { lockOrientation: 'yes' },
    { orientation: 'Sideways' },
  ])
    assert.throws(() => observedConfig({ canvasDisplay: { sample: policy }, evidence: 'invented fixture' }));
});
test('display geometry uses only explicit scaling and orientation observations', () => {
  assert.deepEqual(canvasDisplayGeometry({}, 390, 844), {
    logicalWidth: 390,
    logicalHeight: 844,
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
    scaling: false,
    orientationLocked: false,
    incomplete: false,
  });
  const scaled = canvasDisplayGeometry(
    { designWidth: 800, designHeight: 400, scaleToFit: true, lockAspectRatio: true },
    390,
    844,
  );
  assert.deepEqual(
    [scaled.logicalWidth, scaled.logicalHeight, scaled.scaleX, scaled.scaleY, scaled.offsetX, scaled.offsetY],
    [800, 400, 0.4875, 0.4875, 0, 324.5],
  );
  assert.deepEqual(
    [
      canvasDisplayGeometry({ lockOrientation: true, orientation: 'Landscape' }, 390, 844).logicalWidth,
      canvasDisplayGeometry({ lockOrientation: true, orientation: 'Landscape' }, 390, 844).logicalHeight,
    ],
    [844, 390],
  );
  const stretch = canvasDisplayGeometry(
    { designWidth: 800, designHeight: 400, scaleToFit: true, lockAspectRatio: false },
    400,
    800,
  );
  assert.deepEqual([stretch.scaleX, stretch.scaleY, stretch.offsetX, stretch.offsetY], [0.5, 2, 0, 0]);
  const rotatedDesign = canvasDisplayGeometry(
    { designWidth: 400, designHeight: 800, scaleToFit: true, lockOrientation: true, orientation: 'Landscape' },
    390,
    844,
  );
  assert.deepEqual([rotatedDesign.logicalWidth, rotatedDesign.logicalHeight], [800, 400]);
  assert.equal(canvasDisplayGeometry({ scaleToFit: true }, 390, 844).incomplete, true);
});
