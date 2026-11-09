// @test-kind parity: the selected numeric and culture formulas match two official Check and Eval executions with explicitly bound host services.
// @parity-evidence: power-fx-root-phase-official.json retains exact inputs, separate check/evaluation outcomes and diagnostics, host settings, process and producer hashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { powerFxEngine } from '../lib/power-fx.mjs';
const bytes = readFileSync(new URL('./fixtures/power-fx-root-phase-official.json', import.meta.url));
const evidence = JSON.parse(bytes);
// @test-kind tooling: bind the complete captured universe, including unsupported and check-failure outcomes that are not parity claims for Canvas.
test('phase corpus retains independent processes and exact diagnostics', () => {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '69d15f91f9caee25d8d4257ed462b226cd730d18cf51bd055de0665db45d4acc',
  );
  assert.notEqual(evidence.runs[0].processId, evidence.runs[1].processId);
  assert.deepEqual(evidence.runs[0].results, evidence.runs[1].results);
  assert.deepEqual(
    evidence.input.map((row) => row.expression),
    evidence.runs[0].results.map((row) => row.expression),
  );
  assert.equal(evidence.runs[0].results[1].phase, 'check');
  assert.equal(evidence.runs[0].results[1].diagnostics[0].message, 'Numeric value is too large.');
});
for (const index of [0, 2, 3, 4, 5]) {
  const expected = evidence.runs[0].results[index];
  test(`official culture or float evaluation: ${expected.expression}`, () => {
    assert.equal(expected.phase, 'evaluation');
    assert.equal(
      powerFxEngine.evaluateSync(expected.expression, {
        host: { language: 'en-US', timeZone: 'America/Los_Angeles', numberIsFloat: index === 0 ? true : undefined },
      }).value,
      expected.value,
    );
  });
}
test('official float literal overflow fails before IfError evaluates', () => {
  const expression = evidence.runs[0].results[1].expression;
  const host = { numberIsFloat: true };
  assert.equal(powerFxEngine.checkSync(expression, { host }).ok, false);
  assert.throws(() => powerFxEngine.evaluateSync(expression, { host }), /Numeric value is too large/);
});
// @test-kind contract: parsing one host mode must not contaminate the cached parse for another host.
test('numeric parser settings are isolated in the parse cache', () => {
  const expression = 'IfError(1e400, 2)';
  assert.equal(powerFxEngine.evaluateSync(expression).value, 2);
  assert.equal(powerFxEngine.checkSync(expression, { host: { numberIsFloat: true } }).ok, false);
  assert.equal(powerFxEngine.checkSync(expression, { host: { numberIsFloat: false } }).ok, false);
  assert.equal(powerFxEngine.evaluateSync(expression).value, 2);
});
// @test-kind contract: nested expressions use the same parser mode, while text is not parsed as a numeric literal.
test('float parser mode applies inside interpolation only to formulas', () => {
  const host = { numberIsFloat: true };
  assert.equal(powerFxEngine.checkSync('$"{1e400}"', { host }).ok, false);
  assert.equal(powerFxEngine.evaluateSync('"1e400"', { host }).value, '1e400');
});
