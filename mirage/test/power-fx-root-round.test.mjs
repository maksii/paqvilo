// @test-kind parity: decimal literals around half of the 28-place unit match two official interpreter executions.
// @parity-evidence: power-fx-root-round-official.json binds exact expressions, decimal host, raw result hashes, producer, package and independent processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCorpusProof } from '../test-support/power-fx-corpus-proof.mjs';
import { powerFxEngine } from '../lib/power-fx.mjs';
const bytes = readFileSync(new URL('./fixtures/power-fx-root-round-official.json', import.meta.url));
const evidence = JSON.parse(bytes);
// @test-kind tooling: bind all captured cases to distinct repeated runs.
test('decimal rounding corpus is bound to both official processes', () => {
  assertCorpusProof(bytes, evidence, 'a048ef909fd07c543fc2e858a6c4555171606caef5740352b69610c4146734ab');
});
for (const expected of evidence.runs[0].results) {
  test(`official decimal rounding: ${expected.expression}`, () => {
    assert.equal(expected.phase, 'evaluation');
    assert.equal(
      powerFxEngine.evaluateSync(expected.expression, { host: { numberIsFloat: false, language: 'en-US' } }).value,
      expected.value,
    );
  });
}
