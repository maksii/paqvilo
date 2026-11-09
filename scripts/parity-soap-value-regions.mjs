// Typed-value sibling markers are separate from accepted SOAP namespace markers.
import { createHash } from 'node:crypto';
const marker = '__paqSoapValueProof';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function uses(node) {
  let n = node.type === 'Identifier' && node.name === marker ? 1 : 0;
  for (const v of Object.values(node)) for (const c of Array.isArray(v) ? v : [v]) if (c?.type) n += uses(c);
  return n;
}
function markerCall(stmt, id) {
  const c = stmt.expression,
    u = c?.arguments?.[0];
  return (
    stmt.type === 'ExpressionStatement' &&
    c?.type === 'CallExpression' &&
    c.callee?.name === marker &&
    c.arguments.length === 2 &&
    u?.type === 'MemberExpression' &&
    !u.computed &&
    u.object?.type === 'MetaProperty' &&
    u.object.meta?.name === 'import' &&
    u.object.property?.name === 'meta' &&
    u.property?.name === 'url' &&
    c.arguments[1]?.type === 'Literal' &&
    c.arguments[1].value === id
  );
}
function factValid(descriptor, region, readCapsule) {
  const proofs = descriptor.proofs.filter((p) =>
    p.facts.some((f) => f.id === region.factId && f.sha256 === digest(region.expected)),
  );
  if (proofs.length !== 1 || proofs[0].mode !== 'official-package') return false;
  const capsule = readCapsule(proofs[0]);
  return (
    capsule.baseline === region.baselineCommit &&
    capsule.baselineSourceSha256 === region.baselineSourceSha256 &&
    Array.isArray(capsule.source) &&
    capsule.source.filter(
      (item) =>
        item.id === region.baselineId &&
        item.idx === region.assertionIndex &&
        item.assertionSha256 === region.assertionSha256 &&
        digest(item.expected) === digest(region.expected),
    ).length === 1
  );
}
function regionValid(model, descriptor, region, hash, readCapsule) {
  const rows = model.registrations.filter((r) => r.titleExpressionSha256 === region.titleExpressionSha256);
  if (rows.length !== 1 || rows[0].callback.body.type !== 'BlockStatement') return false;
  const body = rows[0].callback.body,
    blocks = body.body.filter((s) => s.type === 'BlockStatement' && s.body[0]?.expression?.callee?.name === marker);
  if (blocks.length !== 1 || blocks[0].body.length !== 2) return false;
  const [call, assertion] = blocks[0].body;
  if (!markerCall(call, region.factId) || assertion.type !== 'ExpressionStatement') return false;
  if (!rows[0].assertions.some((a) => a.node === assertion.expression && a.sha256 === region.assertionSha256))
    return false;
  const restored = { ...body, body: body.body.map((s) => (s === blocks[0] ? assertion : s)) };
  return hash(restored) === region.originalBodyAstSha256 && factValid(descriptor, region, readCapsule);
}
export function soapValueRegionsValid(model, descriptor, file, tool, hash, resolveImport, readCapsule) {
  const regions = descriptor.valueRegions,
    imports = model.ast.body.filter(
      (n) => n.type === 'ImportDeclaration' && n.specifiers.some((s) => s.local.name === marker),
    ),
    count = uses(model.ast);
  if (!regions) return imports.length === 0 && count === 0;
  if (
    !Array.isArray(regions) ||
    !regions.length ||
    imports.length !== 1 ||
    resolveImport(file, imports[0].source.value) !== tool
  )
    return false;
  if (!imports[0].specifiers.some((s) => s.imported?.name === 'assertSoapValueProof' && s.local.name === marker))
    return false;
  if (
    new Set(regions.map((r) => r.factId)).size !== regions.length ||
    new Set(regions.map((r) => r.titleExpressionSha256)).size !== regions.length ||
    count !== regions.length + 1
  )
    return false;
  return regions.every((r) => regionValid(model, descriptor, r, hash, readCapsule));
}
