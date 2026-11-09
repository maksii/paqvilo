// @test-kind tooling: SOAP SDK value qualification must retain the exact source assertions and reviewed facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { analyzeSoapValueInputs, qualifySoapValues } from '../scripts/qualify-soap-values.mjs';
import { soapValueRegionsValid } from '../scripts/parity-soap-value-regions.mjs';
import { describeParitySource, parityAstHash } from '../scripts/qualify-parity.mjs';
const file = 'mirage/test/dataverse-soap-xml.test.mjs';
const capsule = JSON.parse(
  fs.readFileSync(new URL('../mirage/test/fixtures/dataverse-soap-sdk-values-20261109.json', import.meta.url)),
);
const baseline = execFileSync('git', ['show', `${capsule.baseline}:${file}`], { encoding: 'utf8' });
const reference = JSON.parse(
  fs.readFileSync(new URL('../mirage/test/fixtures/dataverse-soap-sdk-interop-46-candidate.json', import.meta.url)),
);

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const proof = {
  facts: capsule.source.map((s, i) => ({
    id: `sdk-value-${s.id.split(':')[1]}`,
    sha256: hash(s.expected),
    pointer: `/runs/0/facts/${i}`,
  })),
};
function analyze(source = baseline, data = capsule, p = proof) {
  return analyzeSoapValueInputs({ file, baseline, source, proof: p, capsule: data, reference });
}
test('value analyzer binds each exact original assertion and expected projection', () => {
  const result = analyze();
  assert.equal(result.regions.length, 3);
  assert.deepEqual(
    result.regions.map((r) => r.assertionIndex),
    [1, 1, 1],
  );
  assert.equal(result.edits.length, 3);
});
test('value analyzer rejects changed source, sibling, type, input facts and source identity', () => {
  const i = baseline.indexOf("test('ColumnSet encodes");
  const sibling =
    baseline.slice(0, i) +
    baseline
      .slice(i)
      .replace(
        "type: 'ColumnSet', allColumns: false, columns: ['name', 'createdon']",
        "type: 'ColumnSet', allColumns: true, columns: ['name', 'createdon']",
      );
  assert.notEqual(sibling, baseline);
  assert.throws(() => analyze(sibling));
  for (const mutate of [
    (c) => (c.source[0].expected.values = [1, 4]),
    (c) => (c.source[1].id = 'other'),
    (c) => (c.runs[1].facts[2].value = '1'),
    (c) => (c.source[0].assertionSha256 = '0'.repeat(64)),
    (c) => (c.runs[0].interopRun.results.find((r) => r.id === 17).direct.sdkType = 'System.String'),
    (c) => (c.interopInputs.find((r) => r.id === 21).expected.value = '123'),
    (c) => (c.interopInputs.find((r) => r.id === 21).xmlDirect += ' '),
    (c) => (c.runs[1].columnSetRaw.stdout = 'forged'),
    (c) => (c.runs[0].receiptSha256 = '0'.repeat(64)),
    (c) => (c.columnSetProducer.source += ' '),
  ]) {
    const c = structuredClone(capsule);
    mutate(c);
    assert.throws(() => analyze(baseline, c));
  }
});
test('value-region guard rejects leaked or replaced markers and proof bindings', () => {
  const { regions, edits } = analyze();
  let source = baseline;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  source = "import { assertSoapValueProof as __paqSoapValueProof } from '../../scripts/qualify-parity.mjs';\n" + source;
  const descriptor = { valueRegions: regions, proofs: [{ mode: 'official-package', facts: proof.facts }] },
    tool = '/tool/qualify-parity.mjs';
  const valid = (s = source, d = descriptor) =>
    soapValueRegionsValid(
      describeParitySource(s, file),
      d,
      file,
      tool,
      parityAstHash,
      () => tool,
      () => capsule,
    );
  assert.equal(valid(), true);
  assert.equal(valid(source.replace('"sdk-value-406"', '"forged"')), false);
  assert.equal(valid(source + '\nconst leak = __paqSoapValueProof;\n'), false);
  const changed = structuredClone(descriptor);
  changed.proofs[0].facts.pop();
  assert.equal(valid(source, changed), false);
});
test('value writer refuses a qualifier from another checkout', () => {
  assert.throws(() => qualifySoapValues({ root: process.cwd() + '/not-a-checkout' }));
});
