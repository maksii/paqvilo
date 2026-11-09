// @test-kind parity: exact decimal-mode bounds and underflow formulas match two Microsoft Check and Eval processes.
// @parity-evidence: power-fx-root-decimal-official.json binds decimal parser context, check versus evaluation results, inputs, independent processes, producer and official package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCorpusProof } from '../test-support/power-fx-corpus-proof.mjs';
import { powerFxEngine } from '../lib/power-fx.mjs';
const bytes = readFileSync(new URL('./fixtures/power-fx-root-decimal-official.json', import.meta.url));
const evidence = JSON.parse(bytes);
// @test-kind tooling: keep the captured universe and repeated process binding fixed.
test('decimal corpus is bound to independent processes', () => {
  assertCorpusProof(bytes, evidence, '488c6fb45307aa8273be4fcdb507b15ca79fefa471c082638111c70fb1819fc0');
});
for (const expected of evidence.runs[0].results) {
  test(`official decimal parser: ${expected.expression}`, () => {
    const host = { numberIsFloat: false, language: 'en-US', timeZone: 'America/Los_Angeles' };
    const check = powerFxEngine.checkSync(expected.expression, { host });
    assert.equal(check.ok, expected.phase === 'evaluation');
    if (expected.phase === 'evaluation')
      assert.equal(powerFxEngine.evaluateSync(expected.expression, { host }).value, expected.value);
    else assert.throws(() => powerFxEngine.evaluateSync(expected.expression, { host }), /Numeric value is too large/);
  });
}
