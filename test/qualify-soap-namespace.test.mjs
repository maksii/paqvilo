// @test-kind tooling: namespace qualification binds the original assertion, body and SDK fact without promoting sibling assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeParitySource } from '../scripts/qualify-parity.mjs';
import { analyzeSoapNamespaceInputs, assertSoapNamespaceToolRoot } from '../scripts/qualify-soap-namespace.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const source = `// @test-kind compatibility: invented namespace fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
test('namespace', () => { const x = { ns: 'urn:test' }; assert.ok(true); assert.equal(x.ns, 'urn:test'); });`;
function inputs() {
  const row = describeParitySource(source, 'sample.test.mjs').registrations[0];
  return {
    file: 'sample.test.mjs',
    baseline: source,
    source,
    proof: { facts: [{ id: 'fact', sha256: sha(JSON.stringify('urn:test')) }] },
    capsule: {
      baseline: 'a'.repeat(40),
      source: {
        baselineSourceSha256: sha(source),
        tests: [{ id: row.id, assertionIndex: 1, assertionSha256: row.assertions[1].sha256 }],
      },
      runs: [{ facts: [{ namespace: 'urn:test' }] }, { facts: [{ namespace: 'urn:test' }] }],
    },
  };
}

test('namespace writer selects only the exact original assertion and retains its sibling', () => {
  const input = inputs(),
    result = analyzeSoapNamespaceInputs(input);
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0].factId, 'fact');
  assert.equal(result.edits.length, 1);
  assert.match(result.edits[0].text, /assert\.equal\(x\.ns, 'urn:test'\)/);
  assert.doesNotMatch(result.edits[0].text, /assert\.ok/);
});

test('namespace writer rejects source, context, fact, kind and universe changes', () => {
  for (const mutate of [
    (x) => (x.source = x.source.replace("'urn:test'", "'urn:other'")),
    (x) => (x.capsule.runs[1].facts[0].namespace = 'urn:other'),
    (x) => (x.capsule.source.baselineSourceSha256 = '0'.repeat(64)),
    (x) => (x.capsule.source.tests[0].assertionSha256 = '0'.repeat(64)),
    (x) => (x.proof.facts[0].sha256 = '0'.repeat(64)),
    (x) => x.capsule.source.tests.push(structuredClone(x.capsule.source.tests[0])),
    (x) => (x.baseline = x.baseline.replace('@test-kind compatibility:', '@test-kind security:')),
  ]) {
    const item = inputs();
    mutate(item);
    assert.throws(() => analyzeSoapNamespaceInputs(item));
  }
});

test('namespace writer refuses a qualifier from a different checkout', (t) => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  assert.doesNotThrow(() => assertSoapNamespaceToolRoot(root));
  const parent = fs.realpathSync(os.tmpdir());
  const other = fs.mkdtempSync(path.join(parent, 'paq-soap-other-'));
  assert.ok(path.relative(parent, other) && !path.relative(parent, other).startsWith('..'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.mkdirSync(path.join(other, 'scripts'));
  fs.writeFileSync(path.join(other, 'scripts', 'qualify-parity.mjs'), '// another checkout');
  assert.throws(() => assertSoapNamespaceToolRoot(other), /qualifier does not belong to root/);
});
