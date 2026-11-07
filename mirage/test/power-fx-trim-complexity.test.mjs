// @test-kind security: Power Fx trimming preserves ASCII-space semantics on unbounded input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { powerFxEngine } from '../lib/power-fx.mjs';

test('Power Fx Trim and TrimEnds handle long interior space runs', () => {
  const spaces = ' '.repeat(100_000);
  const evaluate = (formula, value) =>
    powerFxEngine.evaluateSync(formula, { host: { variables: {} }, values: { value } }).value;
  assert.equal(evaluate('TrimEnds(value)', `${spaces}x${spaces}y${spaces}`), `x${spaces}y`);
  assert.equal(evaluate('Trim(value)', `${spaces}x${spaces}y${spaces}`), 'x y');
  assert.equal(evaluate('TrimEnds(value)', '\t x \n'), '\t x \n');
});
