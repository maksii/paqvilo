import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (left, right) => digest(left) === digest(right);

export function soapKindHeaderEnd(source) {
  const match = /^(?:\s*\/\/\s*@parity-evidence:[^\r\n]*\r?\n)*\s*\/\/\s*@test-kind compatibility:[^\r\n]*\r?\n/u.exec(
    source,
  );
  return match?.[0].length ?? 0;
}

// Both arguments have already passed the source guard and proof-byte verifier.
// Containment is monotonic: a later authority cannot replace an earlier proof,
// selected assertion instance, original universe, or selected XML input.
export function soapAuthorityContains(newer, older) {
  return (
    [
      'universe',
      'dependencies',
      'loopAstSha256',
      'callbackAstSha256',
      'assertionAstSha256',
      'tailAstSha256',
      'tailXml',
    ].every((key) => same(newer.descriptor[key], older.descriptor[key])) &&
    older.descriptor.selectedIndices.every(
      (index) =>
        newer.descriptor.selectedIndices.includes(index) && older.descriptor.xml[index] === newer.descriptor.xml[index],
    ) &&
    older.descriptor.instances.every((instance) => newer.descriptor.instances.some((item) => same(item, instance))) &&
    (older.binding.namespaceRegions ?? []).every((region) =>
      (newer.binding.namespaceRegions ?? []).some((item) => same(item, region)),
    ) &&
    (older.binding.valueRegions ?? []).every((region) =>
      (newer.binding.valueRegions ?? []).some((item) => same(item, region)),
    ) &&
    older.binding.proofs.every((proof) => newer.binding.proofs.some((item) => same(item, proof)))
  );
}

export function soapPriorFactsPreserved(previous, next, fresh) {
  const old = previous.descriptor,
    oldFacts = previous.binding.proofs.flatMap((proof) => proof.facts),
    newFacts = fresh.proofs.flatMap((proof) => proof.facts);
  return (
    [
      'universe',
      'dependencies',
      'loopAstSha256',
      'callbackAstSha256',
      'assertionAstSha256',
      'tailAstSha256',
      'tailXml',
    ].every((key) => same(old[key], next[key])) &&
    old.selectedIndices.every((index) => next.selectedIndices.includes(index) && old.xml[index] === next.xml[index]) &&
    old.instances.every(
      (instance) =>
        next.instances.some((item) => same(item, instance)) &&
        instance.factIds.every((id) =>
          oldFacts.some((fact) => fact.id === id && newFacts.some((candidate) => same(candidate, fact))),
        ),
    )
  );
}

// The old proof remains intact. A new capsule needs only its newly mapped
// facts in the runtime guard; preflight still verifies its complete fact set.
export function compactSoapProof(fresh, priorProofs) {
  const oldFacts = new Set(priorProofs.flatMap((proof) => proof.facts.map((fact) => digest(fact))));
  const novel = fresh.facts.filter((fact) => !oldFacts.has(digest(fact)));
  return { ...fresh, facts: novel.length ? novel : fresh.facts.slice(0, 1) };
}

export function sameSoapProofIdentity(left, right) {
  return same({ ...left, facts: [] }, { ...right, facts: [] });
}

// Namespace regions are sibling assertions outside the value-loop. The outer
// SOAP guard pins the complete module AST and each selected original body.
const namespaceMarker = '__paqSoapNamespaceProof';
function namespaceMarkerUses(node) {
  let count = node.type === 'Identifier' && node.name === namespaceMarker ? 1 : 0;
  for (const value of Object.values(node)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) if (child?.type) count += namespaceMarkerUses(child);
  }
  return count;
}
function namespaceMarkerCall(statement, factId) {
  const call = statement.expression,
    url = call?.arguments?.[0];
  return (
    statement.type === 'ExpressionStatement' &&
    call?.type === 'CallExpression' &&
    call.callee?.name === namespaceMarker &&
    call.arguments.length === 2 &&
    url?.type === 'MemberExpression' &&
    !url.computed &&
    url.object?.type === 'MetaProperty' &&
    url.object.meta?.name === 'import' &&
    url.object.property?.name === 'meta' &&
    url.property?.name === 'url' &&
    call.arguments[1]?.type === 'Literal' &&
    call.arguments[1].value === factId
  );
}
function namespaceFactValid(descriptor, region, readCapsule) {
  const proofs = descriptor.proofs.filter((proof) =>
    proof.facts.some((fact) => fact.id === region.factId && fact.sha256 === digest(region.namespace)),
  );
  if (proofs.length !== 1 || proofs[0].mode !== 'official-package') return false;
  const capsule = readCapsule(proofs[0]);
  return (
    /^[a-f0-9]{40}$/u.test(capsule.baseline ?? '') &&
    capsule.baseline === region.baselineCommit &&
    /^[a-f0-9]{64}$/u.test(capsule.source?.baselineSourceSha256 ?? '') &&
    capsule.source.baselineSourceSha256 === region.baselineSourceSha256 &&
    Array.isArray(capsule.source.tests) &&
    capsule.source.tests.filter(
      (item) =>
        item.id === region.baselineId && item.assertionSha256 === region.assertionSha256 && item.assertionIndex === 1,
    ).length === 1
  );
}
function namespaceRegionValid(model, descriptor, region, hash, readCapsule) {
  const rows = model.registrations.filter((row) => row.titleExpressionSha256 === region.titleExpressionSha256);
  if (rows.length !== 1 || rows[0].callback.body.type !== 'BlockStatement') return false;
  const body = rows[0].callback.body;
  const matches = body.body.filter(
    (statement) =>
      statement.type === 'BlockStatement' && statement.body[0]?.expression?.callee?.name === namespaceMarker,
  );
  if (matches.length !== 1 || matches[0].body.length !== 2) return false;
  const [marker, assertion] = matches[0].body;
  if (!namespaceMarkerCall(marker, region.factId) || assertion.type !== 'ExpressionStatement') return false;
  if (!rows[0].assertions.some((item) => item.node === assertion.expression && item.sha256 === region.assertionSha256))
    return false;
  const restored = { ...body, body: body.body.map((item) => (item === matches[0] ? assertion : item)) };
  return hash(restored) === region.originalBodyAstSha256 && namespaceFactValid(descriptor, region, readCapsule);
}
export function soapNamespaceRegionsValid(model, descriptor, file, tool, hash, resolveImport, readCapsule) {
  const regions = descriptor.namespaceRegions;
  const imports = model.ast.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === namespaceMarker),
  );
  const uses = namespaceMarkerUses(model.ast);
  if (!regions) return imports.length === 0 && uses === 0;
  if (
    !Array.isArray(regions) ||
    !regions.length ||
    imports.length !== 1 ||
    resolveImport(file, imports[0].source.value) !== tool
  )
    return false;
  if (
    !imports[0].specifiers.some(
      (item) => item.imported?.name === 'assertSoapNamespaceProof' && item.local.name === namespaceMarker,
    )
  )
    return false;
  if (
    new Set(regions.map((item) => item.factId)).size !== regions.length ||
    new Set(regions.map((item) => item.titleExpressionSha256)).size !== regions.length ||
    uses !== regions.length + 1
  )
    return false;
  return regions.every((region) => namespaceRegionValid(model, descriptor, region, hash, readCapsule));
}
