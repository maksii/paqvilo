// @test-kind parity: generic interpreter date-error and native Canvas rollover use their respective repeated evidence and host contexts.
// @parity-evidence: power-fx-official-20261108-five-corrections-context-v1.json and canvas-form-reset-native.json bind the original formula and native explicit-en-US formula, respectively.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { powerFxEngine } from '../lib/power-fx.mjs';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const genericBytes = readFileSync(
  new URL('./fixtures/power-fx-official-20261108-five-corrections-context-v1.json', import.meta.url),
);
const canvasBytes = readFileSync(new URL('./fixtures/canvas-form-reset-native.json', import.meta.url));
const generic = JSON.parse(genericBytes),
  canvas = JSON.parse(canvasBytes);
const run = (expr, host) => powerFxEngine.evaluateSync(expr, { host }).value;
test('repeated generic interpreter captures reject month 13', () => {
  assert.equal(hash(genericBytes), '81bbbdfe45a0298010600bbcb9146d7fb16b618df7e43e1fd2edc5e32bc9b3c2');
  const expr = generic.source.cases.find((x) => x.index === 75).expression;
  const results = generic.runs.map((r) => r.results.find((x) => x.expression === expr));
  assert.equal(results.length, 2);
  for (const row of results) {
    assert.equal(row.phase, 'evaluation');
    assert.equal(row.type, 'BooleanValue');
    assert.equal(row.value, true);
  }
  assert.equal(
    run(expr, { now: () => Date.parse('2013-07-15T20:02:00Z'), timeZone: 'America/Los_Angeles', numberIsFloat: false }),
    true,
  );
});
test('native Canvas explicitly en-US normalizes month 13', () => {
  assert.equal(hash(canvasBytes), 'c25852ab3809dbe7813925668f1575385f84e1f158e2804b58105b6cb2d67453');
  assert.equal(canvas.captures[0].scalar.DateError, 'Paqvilo DateError=false');
  assert.equal(canvas.captures[1].scalar.Date, 'Paqvilo Date=2025-01-01;parts=2025,1,1');
  const host = { app: 'canvas', language: 'en-US' };
  assert.equal(run('IsError(DateValue("13/01/2024","en-US"))', host), false);
  const expr = 'Text(DateValue("13/01/2024","en-US"),"yyyy-mm-dd","en-US")';
  assert.equal(run(expr, host), '2025-01-01');
});
