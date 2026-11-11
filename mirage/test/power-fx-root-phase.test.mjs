// @test-kind contract: Mirage's float-literal parser mode and parse cache are designed behaviour; the official Check and Eval outcomes of the phase formulas are replay cases in suite root-phase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { powerFxEngine } from '../lib/power-fx.mjs';
test('float literal overflow is refused by Check and Eval before IfError evaluates', () => {
  const expression = 'IfError(1e400, 2)';
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
