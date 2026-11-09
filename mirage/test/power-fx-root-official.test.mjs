// @test-kind parity: exact scalar formulas and runtime error kinds reproduced in two official Microsoft Power Fx interpreter processes.
// @parity-evidence: power-fx-root-official-evidence.json binds both complete inputs, repeated results, host services, producer and official assembly identities; raw transcript hashes identify the private captures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ErrorKind, FxDate, FxError, FxFloat, evaluateFx } from '../lib/power-fx.mjs';
import { isExactNumeric } from '../lib/exact-numeric.mjs';

const bytes = readFileSync(new URL('./fixtures/power-fx-root-official-evidence.json', import.meta.url));
const evidence = JSON.parse(bytes);
// @test-kind tooling: the fixed capsule and repeated-process bindings guard the input and result universe.
test('official evidence retains both bound corpora and independent processes', () => {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '5efbbbbaa911603369143c36b5b9a02dd2e3490cf069b3be45451eb67cc45f6f',
  );
  assert.deepEqual(
    evidence.corpora.map((c) => c.inputs.length),
    [7, 17],
  );
  for (const corpus of evidence.corpora) {
    assert.notEqual(corpus.runs[0].processId, corpus.runs[1].processId);
    assert.deepEqual(corpus.runs[0].results, corpus.runs[1].results);
    assert.deepEqual(
      corpus.inputs.map((r) => r.expression),
      corpus.runs[0].results.map((r) => r.expression),
    );
  }
});
for (const corpus of evidence.corpora) {
  for (const expected of corpus.runs[0].results) {
    test(`official ${corpus.name}: ${expected.expression}`, () => {
      let actual = evaluateFx(expected.expression, {
        host: { language: 'en-US', timeZone: 'America/Los_Angeles' },
      }).value;
      if (expected.kind === 'error') {
        assert.ok(actual instanceof FxError);
        assert.equal(actual.errors[0].Kind, ErrorKind[expected.errors[0].kind]);
        // This invalid-language assertion is specifically about semantic kind, not wording.
        if (expected.errors[0].kind !== 'BadLanguageCode')
          assert.equal(actual.errors[0].Message, expected.errors[0].Message);
      } else {
        if (actual instanceof FxFloat) actual = actual.value;
        if (isExactNumeric(actual)) actual = Number(actual.value);
        // The toolkit uses date-only strings; the official serializer emits midnight.
        const value = actual instanceof FxDate ? expected.value.slice(0, 10) : expected.value;
        if (actual instanceof FxDate) actual = new Date(actual.ms).toISOString().slice(0, 10);
        assert.deepEqual(actual, value);
      }
    });
  }
}
