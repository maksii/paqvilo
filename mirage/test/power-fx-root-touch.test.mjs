// @test-kind parity: the exact IfError expression and callable host controls were reproduced twice with Microsoft's typed ReflectionFunction seam.
// @parity-evidence: power-fx-root-touch-official.json binds both input and output transcripts, call counts, host context and official producer identities; only Touch is supplied by the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { powerFxEngine } from '../lib/power-fx.mjs';
const bytes = readFileSync(new URL('./fixtures/power-fx-root-touch-official.json', import.meta.url));
const evidence = JSON.parse(bytes);
// @test-kind tooling: protect the captured expression universe and independent process bindings.
test('typed Touch corpus is bound to two independent interpreter runs', () => {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '759c066bb5603614ce9b5cffad7ea165796a0044d34509e52cd104d99a2f52af',
  );
  assert.notEqual(evidence.runs[0].processId, evidence.runs[1].processId);
  assert.deepEqual(evidence.runs[0].results, evidence.runs[1].results);
  assert.deepEqual(
    evidence.input.map((row) => row.expression),
    evidence.runs[0].results.map((row) => row.expression),
  );
  assert.deepEqual(
    evidence.runs[0].results.map((row) => row.calls),
    [0, 1, 1, 1],
  );
});
for (const expected of evidence.runs[0].results) {
  test(`official host call count: ${expected.expression}`, () => {
    const calls = [];
    const host = {
      functions: {
        Touch: () => {
          calls.push('touch');
          return 1;
        },
      },
    };
    const result = powerFxEngine.evaluateSync(expected.expression, { host });
    assert.equal(result.value, expected.value);
    assert.equal(calls.length, expected.calls);
  });
}
