// @test-kind observation: native Canvas scalars in fixtures/canvas-form-reset-native.json (pinned by sha256 in the test) record the explicit en-US month-13 normalization; the captures hold derived scalar strings, not per-case inputs and outputs, so the formulas and host are typed here and this is not a replay case. The interpreter counterpart is replay case root-date-profile#case-75.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { powerFxEngine } from '../lib/power-fx.mjs';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const canvasBytes = readFileSync(new URL('./fixtures/canvas-form-reset-native.json', import.meta.url));
const canvas = JSON.parse(canvasBytes);
const run = (expr, host) => powerFxEngine.evaluateSync(expr, { host }).value;
test('native Canvas explicitly en-US normalizes month 13', () => {
  assert.equal(hash(canvasBytes), 'c25852ab3809dbe7813925668f1575385f84e1f158e2804b58105b6cb2d67453');
  assert.equal(canvas.captures[0].scalar.DateError, 'Paqvilo DateError=false');
  assert.equal(canvas.captures[1].scalar.Date, 'Paqvilo Date=2025-01-01;parts=2025,1,1');
  const host = { app: 'canvas', language: 'en-US' };
  assert.equal(run('IsError(DateValue("13/01/2024","en-US"))', host), false);
  const expr = 'Text(DateValue("13/01/2024","en-US"),"yyyy-mm-dd","en-US")';
  assert.equal(run(expr, host), '2025-01-01');
});
