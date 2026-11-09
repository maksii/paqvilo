// @test-kind parity: exact original expressions, values and host contexts match two isolated executions of the unmodified Microsoft Power Fx interpreter.
// @parity-evidence: power-fx-batch-official-evidence.json binds both137-request typed transcripts, distinct process receipts and installed Microsoft DLL/MVID/source hashes. The seven supported differing guarantees below correct prior local assumptions; clock-bypass and unsupported-host outcomes remain excluded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FxError, evaluateFx } from '../lib/power-fx.mjs';
import { isExactNumeric } from '../lib/exact-numeric.mjs';

const bytes = await readFile(new URL('./fixtures/power-fx-batch-official-evidence.json', import.meta.url));
const proof = JSON.parse(bytes);
const cases = proof.cases.filter((row) => row.status === 'mismatch' && !row.id.startsWith('matrix-'));
// @test-kind tooling: retain the exact finite original correction universe and separate process identities.
test('the supported correction universe retains all seven original assertion guarantees', () => {
  assert.equal(cases.length, 7);
  assert.notEqual(proof.runs[0].processId, proof.runs[1].processId);
});
for (const row of cases)
  test(`official original-case correction: ${row.expression}`, () => {
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      '401327ef94098a0f50811c769e204fb2225768bda9edb27e8a4f150bb8690e5e',
    );
    const host = { language: row.host.culture, timeZone: row.host.timeZone };
    if (row.host.random !== undefined) host.random = () => row.host.random;
    if (row.host.clock !== 'system-current') host.now = () => Date.parse(row.host.clock);
    const value = evaluateFx(row.expression, { host, values: row.host.values ?? {} }).value;
    let actual = value;
    if (row.projection === 'error-kind') {
      assert.ok(value instanceof FxError);
      actual = value.errors[0].Kind;
    } else if (isExactNumeric(value)) actual = Number(value.value);
    let expected = row.projected;
    if (expected && typeof expected === 'object' && Object.hasOwn(expected, '$decimal')) {
      expected = Number(expected.$decimal);
      assert.ok(Number.isSafeInteger(expected), 'this corpus only unboxes exactly representable integer projections');
    }
    assert.equal(actual, expected);
  });
