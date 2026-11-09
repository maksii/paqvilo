import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const parse = createRequire(import.meta.url)('espree').parse,
  sha = (x) => createHash('sha256').update(x).digest('hex');
// Explicitly accepted by root for the committed 53-case state only. A later
// authority must be separately reviewed and added; caller input is not trust.
const acceptedAuthorities = Object.freeze({
  a902f37c89e6fb5143735e054f38ec998f0ec493a8d1bf30d1b16b8bc374cb87:
    '17e1ab8097926063f3c83708fc6ad400b3208971a8cf998267b04802c1778346',
});
function check(x) {
  if (!x)
    throw Object.assign(new Error('invalid-frozen-query-authority'), {
      qualificationCode: 'invalid-frozen-query-authority',
    });
}
function literal(n) {
  if (n.type === 'Literal') return n.value;
  if (n.type === 'ArrayExpression') return n.elements.map(literal);
  if (n.type === 'ObjectExpression')
    return Object.fromEntries(
      n.properties.map((p) => {
        check(p.type === 'Property' && !p.computed);
        return [p.key.name ?? p.key.value, literal(p.value)];
      }),
    );
  if (n.type === 'UnaryExpression' && n.operator === '-') return -literal(n.argument);
  throw new Error('unsupported authority expression');
}
export function extractQueryAuthority(source) {
  const ast = parse(String(source), { ecmaVersion: 'latest', sourceType: 'module', range: true }),
    declarations = ast.body
      .filter((x) => x.type === 'VariableDeclaration')
      .flatMap((x) => x.declarations)
      .filter((x) => x.id.name === '__paqQueryDescriptor'),
    calls = ast.body.filter(
      (x) => x.type === 'ExpressionStatement' && x.expression.callee?.name === '__paqQueryBindings',
    );
  check(declarations.length === 1 && calls.length === 1);
  const query = literal(declarations[0].init),
    bindings = literal(calls[0].expression.arguments[1]);
  check(bindings.length === 1);
  return {
    query,
    descriptor: bindings[0],
    queryRange: declarations[0].init.range,
    bindingRange: calls[0].expression.arguments[1].range,
  };
}
export function assertFrozenQueryAuthority({ receiptBytes, pinnedReceiptSha256, trustedSource, currentSource }) {
  check(Object.hasOwn(acceptedAuthorities, pinnedReceiptSha256) && sha(receiptBytes) === pinnedReceiptSha256);
  const receipt = JSON.parse(receiptBytes);
  check(
    receipt.sourceSha256 === acceptedAuthorities[pinnedReceiptSha256] &&
      sha(trustedSource) === receipt.sourceSha256 &&
      receipt.stagedEqualsCommitted === true,
  );
  const frozen = extractQueryAuthority(trustedSource),
    current = extractQueryAuthority(currentSource),
    hash = (x) => sha(JSON.stringify(x));
  check(
    hash(frozen.query) === receipt.queryDescriptorSha256 &&
      frozen.descriptor.queryDescriptorSha256 === receipt.queryDescriptorSha256 &&
      hash(frozen.query.selectedIndices) === hash(receipt.selectedIndices) &&
      hash(frozen.descriptor.proofs) === hash(receipt.proofs) &&
      frozen.descriptor.queryBridgeAuthoritySha256 === receipt.queryBridgeAuthoritySha256,
  );
  check(current.descriptor.queryDescriptorSha256 === hash(current.query));
  check(hash(current.query.universe) === hash(frozen.query.universe));
  check(receipt.selectedIndices.every((i) => current.query.selectedIndices.includes(i)));
  check(receipt.proofs.every((p, i) => hash(p) === hash(current.descriptor.proofs[i])));
  check(current.descriptor.queryBridgeAuthoritySha256 === receipt.queryBridgeAuthoritySha256);
  return true;
}
// Writes require the exact latest externally accepted tree. An identical no-op may
// replay after a write, but cannot confer new case credit.
export function assertQueryWriteAuthority({
  receiptBytes,
  pinnedReceiptSha256,
  trustedSource,
  beforeSource,
  afterSource,
}) {
  assertFrozenQueryAuthority({ receiptBytes, pinnedReceiptSha256, trustedSource, currentSource: beforeSource });
  const receipt = JSON.parse(receiptBytes);
  if (!Buffer.from(beforeSource).equals(Buffer.from(afterSource))) check(sha(beforeSource) === receipt.sourceSha256);
  return true;
}
