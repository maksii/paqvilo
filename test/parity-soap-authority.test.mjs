// @test-kind tooling: cumulative SOAP qualification must retain all accepted original proof and source bindings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describeParitySource, parityAstHash } from '../scripts/qualify-parity.mjs';
import {
  compactSoapProof,
  sameSoapProofIdentity,
  soapAuthorityContains,
  soapKindHeaderEnd,
  soapNamespaceRegionsValid,
  soapPriorFactsPreserved,
} from '../scripts/parity-soap-authority.mjs';

function authority() {
  return {
    descriptor: {
      universe: ['original', 'held'],
      dependencies: [{ name: 'VALUES', hash: 'source' }],
      loopAstSha256: 'loop',
      callbackAstSha256: 'body',
      assertionAstSha256: ['one', 'two'],
      tailAstSha256: ['tail'],
      tailXml: ['nil'],
      selectedIndices: [0],
      xml: ['original XML', 'held XML'],
      instances: [{ caseIndex: 0, factIds: ['old'] }],
    },
    binding: { proofs: [{ path: 'old.json', sha256: 'old-sha', facts: [{ id: 'old', sha256: 'original fact' }] }] },
  };
}

test('SOAP authority is monotonic and rejects removed or replaced historical guarantees', () => {
  const prior = authority(),
    added = structuredClone(prior);
  added.descriptor.selectedIndices.push(1);
  added.descriptor.instances.push({ caseIndex: 1, factIds: ['new'] });
  added.binding.proofs.push({ path: 'new.json', sha256: 'new-sha', facts: [{ id: 'new', sha256: 'new fact' }] });
  assert.equal(soapAuthorityContains(added, prior), true);
  assert.equal(soapAuthorityContains(prior, added), false);
  const previousRegion = structuredClone(added);
  previousRegion.binding.namespaceRegions = [{ factId: 'namespace', assertionSha256: 'exact' }];
  const missingRegion = structuredClone(previousRegion);
  missingRegion.binding.namespaceRegions = [];
  assert.equal(soapAuthorityContains(missingRegion, previousRegion), false);
  missingRegion.binding.namespaceRegions = [{ factId: 'namespace', assertionSha256: 'altered' }];
  assert.equal(soapAuthorityContains(missingRegion, previousRegion), false);
  for (const mutate of [
    (x) => x.descriptor.selectedIndices.shift(),
    (x) => (x.descriptor.xml[0] = 'changed XML'),
    (x) => (x.descriptor.instances[0].factIds[0] = 'different'),
    (x) => (x.descriptor.universe[0] = 'different'),
    (x) => (x.descriptor.callbackAstSha256 = 'changed body'),
    (x) => x.binding.proofs.shift(),
    (x) => (x.binding.proofs[0].facts[0].sha256 = 'changed fact'),
  ]) {
    const changed = structuredClone(added);
    mutate(changed);
    assert.equal(soapAuthorityContains(changed, prior), false);
  }
});

test('SOAP cumulative facts retain exact mappings and permit additional proven instances', () => {
  const prior = authority(),
    next = structuredClone(prior.descriptor),
    fresh = structuredClone(prior.binding);
  next.selectedIndices.push(1);
  next.instances.push({ caseIndex: 1, factIds: ['new'] });
  fresh.proofs[0].facts.push({ id: 'new', sha256: 'new fact' });
  assert.equal(soapPriorFactsPreserved(prior, next, fresh), true);
  for (const mutate of [
    (descriptor) => descriptor.instances.shift(),
    (descriptor) => (descriptor.xml[0] = 'changed XML'),
    (descriptor) => (descriptor.dependencies[0].hash = 'changed source'),
    (descriptor, proof) => (proof.proofs[0].facts[0].sha256 = 'replaced fact'),
    (descriptor, proof) => (proof.proofs[0].facts[0].id = 'different'),
  ]) {
    const changed = structuredClone(next),
      changedProof = structuredClone(fresh);
    mutate(changed, changedProof);
    assert.equal(soapPriorFactsPreserved(prior, changed, changedProof), false);
  }
});

test('SOAP proof compaction retains novel facts and recognizes the same full capsule on rerun', () => {
  const prior = authority().binding.proofs;
  const fresh = {
    path: 'new.json',
    sha256: 'new-sha',
    facts: [structuredClone(prior[0].facts[0]), { id: 'new', sha256: 'new fact' }],
  };
  const compact = compactSoapProof(fresh, prior);
  assert.deepEqual(compact.facts, [{ id: 'new', sha256: 'new fact' }]);
  assert.equal(sameSoapProofIdentity(compact, fresh), true);
  assert.equal(sameSoapProofIdentity(compact, { ...fresh, sha256: 'different' }), false);
  assert.deepEqual(compactSoapProof({ ...fresh, facts: [fresh.facts[0]] }, prior).facts, [fresh.facts[0]]);
});

test('SOAP cumulative writer preserves a bounded evidence prefix without accepting code before the kind', () => {
  const kind = '// @test-kind compatibility: invented fixture\n';
  assert.equal(soapKindHeaderEnd(kind + 'test("x", () => {});'), kind.length);
  const prefix = '// @parity-evidence: first SDK process\n// @parity-evidence: repeated SDK process\n';
  assert.equal(soapKindHeaderEnd(prefix + kind), (prefix + kind).length);
  assert.equal(soapKindHeaderEnd('runBeforeGuard();\n' + kind), 0);
  assert.equal(soapKindHeaderEnd('// @test-kind parity: wrong kind\n'), 0);
});

test('SOAP namespace regions bind original bodies, proof facts and exclusive marker references', () => {
  const original = `// @test-kind compatibility: invented SDK namespace fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
test('namespace', () => { const value = { ns: 'urn:test' }; assert.equal(value.ns, 'urn:test'); });`;
  const old = describeParitySource(original, 'sample.test.mjs').registrations[0];
  const guarded = original
    .replace(
      "test('namespace'",
      "import { assertSoapNamespaceProof as __paqSoapNamespaceProof } from '../scripts/qualify-parity.mjs';\ntest('namespace'",
    )
    .replace(
      "assert.equal(value.ns, 'urn:test');",
      "{ __paqSoapNamespaceProof(import.meta.url, 'namespace'); assert.equal(value.ns, 'urn:test'); }",
    );
  const factSha = createHash('sha256').update(JSON.stringify('urn:test')).digest('hex');
  const descriptor = {
    namespaceRegions: [
      {
        titleExpressionSha256: old.titleExpressionSha256,
        originalBodyAstSha256: parityAstHash(old.callback.body),
        assertionSha256: old.assertions[0].sha256,
        baselineId: 'sample.test.mjs:1:0',
        baselineCommit: 'a'.repeat(40),
        baselineSourceSha256: 'b'.repeat(64),
        factId: 'namespace',
        namespace: 'urn:test',
      },
    ],
    proofs: [{ mode: 'official-package', facts: [{ id: 'namespace', sha256: factSha }] }],
  };
  const valid = (source, proof = descriptor) =>
    soapNamespaceRegionsValid(
      describeParitySource(source, 'sample.test.mjs'),
      proof,
      '/repo/sample.test.mjs',
      '/trusted/tool',
      parityAstHash,
      (_file, specifier) => (specifier === '../scripts/qualify-parity.mjs' ? '/trusted/tool' : '/untrusted/tool'),
      () => ({
        baseline: 'a'.repeat(40),
        source: {
          baselineSourceSha256: 'b'.repeat(64),
          tests: [{ id: 'sample.test.mjs:1:0', assertionSha256: old.assertions[0].sha256, assertionIndex: 1 }],
        },
      }),
    );
  assert.equal(valid(guarded), true);
  for (const changed of [
    guarded.replace("'namespace'); assert.equal", "'other'); assert.equal"),
    guarded.replace("assert.equal(value.ns, 'urn:test')", "assert.equal(value.ns, 'urn:other')"),
    guarded.replace("const value = { ns: 'urn:test' }", "const value = { ns: 'urn:other' }"),
    guarded.replace(
      '__paqSoapNamespaceProof(import.meta.url',
      'const leaked = __paqSoapNamespaceProof; __paqSoapNamespaceProof(import.meta.url',
    ),
    guarded.replace('../scripts/qualify-parity.mjs', '../other.mjs'),
    guarded.replace("__paqSoapNamespaceProof(import.meta.url, 'namespace');", ''),
  ]) {
    assert.notEqual(changed, guarded);
    assert.equal(valid(changed), false);
  }
  const altered = structuredClone(descriptor);
  altered.proofs[0].facts[0].sha256 = '0'.repeat(64);
  assert.equal(valid(guarded, altered), false);
});
