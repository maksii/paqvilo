// @test-kind parity: the two unchanged clock expressions match repeated official interpreter execution at the original fixed Pacific instant.
// @parity-evidence: power-fx-root-clock-process-official.json binds source cases, genuine Microsoft package and DLL hashes, two unprivileged process receipts, clock inputs, real monotonic timing, and winter/UTC controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { powerFxEngine } from '../lib/power-fx.mjs';
const bytes = readFileSync(new URL('./fixtures/power-fx-root-clock-process-official.json', import.meta.url));
const proof = JSON.parse(bytes);
const hash = (data) => createHash('sha256').update(data).digest('hex');
// @test-kind tooling: retain proof provenance, independent receipts and the original clock's isolation controls.
test('official clock evidence binds two processes and independent clock controls', () => {
  assert.equal(hash(bytes), 'be50f0c4411e270001fdbc03e28e73525465f84f4e787af742702df1801cff7f');
  assert.deepEqual(
    proof.original.cases.map((row) => row.caseIndex),
    [153, 154],
  );
  assert.equal(proof.package.id, 'Microsoft.PowerApps.CLI');
  assert.equal(proof.package.version, '2.13.1');
  assert.equal(proof.package.sha256, '07654af406781c1676d1bc5712c393fab2276e54f15ff10bb74a1bdef0d27d3f');
  assert.notEqual(proof.runs[0].processId, proof.runs[1].processId);
  assert.deepEqual(proof.runs[0].cases, proof.runs[1].cases);
  for (const { receiptSha256, ...run } of proof.runs) {
    assert.equal(hash(JSON.stringify(run)), receiptSha256);
    assert.equal(run.uid, 65534);
    assert.equal(run.capabilitiesEffective, '0000000000000000');
    assert.equal(run.wallBefore.utc, proof.host.injectedUtc);
    assert.equal(run.wallAfter.utc, proof.host.injectedUtc);
    assert.equal(run.wallBefore.local, '2013-07-15T13:02:00.0000000-07:00');
    assert.ok(run.outerMonotonicElapsedMilliseconds > run.monotonicElapsedMilliseconds);
    assert.ok(run.monotonicElapsedMilliseconds >= 80);
  }
  assert.deepEqual(
    proof.controls.map((row) => row.offset),
    [480, 480, 420, 420],
  );
  assert.deepEqual(
    proof.controls.map((row) => row.composed),
    ['15-07-2013 21:02', '15-07-2013 21:02', '15-07-2013 20:02', '15-07-2013 20:02'],
  );
  for (const row of proof.controls) {
    assert.equal(row.winterExplicit, 480);
    assert.equal(row.summerExplicit, 420);
    assert.equal(row.now, '2013-07-15T13:02:00');
  }
});
for (const row of proof.runs[0].cases) {
  test(`official fixed-clock original case ${row.caseIndex}: ${row.expression}`, () => {
    assert.equal(row.result.phase, 'evaluation');
    assert.equal(row.result.kind, 'value');
    assert.equal(row.result.value, row.expected);
    const host = {
      now: () => Date.parse(proof.host.injectedUtc),
      timeZone: proof.host.timeZone,
      variables: {},
      context: {},
    };
    assert.deepEqual(powerFxEngine.evaluateSync(row.expression, { host }).value, row.expected);
  });
}
