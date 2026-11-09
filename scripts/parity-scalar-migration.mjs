// Source-only certificate for the scalar HTTP matrix. No project code is executed.
import { createRequire } from 'node:module';
import { parityAstHash } from './qualify-parity.mjs';
const { parse } = createRequire(import.meta.url)('espree');
const ast = (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
const fail = () => {
  throw new Error('unsupported-scalar-migration');
};
const eq = (left, right) => parityAstHash(left) === parityAstHash(right);

function evaluate(node, bindings, functions) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'Identifier' && Object.hasOwn(bindings, node.name)) return bindings[node.name];
  if (node?.type === 'TemplateLiteral')
    return node.quasis
      .map(
        (part, index) =>
          part.value.cooked + (node.expressions[index] ? evaluate(node.expressions[index], bindings, functions) : ''),
      )
      .join('');
  if (node?.type === 'ArrayExpression') return node.elements.map((element) => evaluate(element, bindings, functions));
  if (node?.type === 'CallExpression' && node.callee?.type === 'Identifier' && functions.has(node.callee.name)) {
    const fn = functions.get(node.callee.name);
    if (node.arguments.length !== fn.params.length || fn.params.some((param) => param.type !== 'Identifier')) fail();
    const args = node.arguments.map((argument) => evaluate(argument, bindings, functions));
    return evaluate(fn.body, Object.fromEntries(fn.params.map((param, index) => [param.name, args[index]])), new Map());
  }
  fail();
}
function functionsFrom(declarations) {
  const functions = new Map();
  for (const declaration of declarations) {
    if (
      declaration.type !== 'VariableDeclaration' ||
      declaration.kind !== 'const' ||
      declaration.declarations.length !== 1
    )
      fail();
    const item = declaration.declarations[0];
    if (
      item.id.type !== 'Identifier' ||
      item.init?.type !== 'ArrowFunctionExpression' ||
      item.init.async ||
      item.init.body.type !== 'TemplateLiteral'
    )
      fail();
    functions.set(item.id.name, item.init);
  }
  return functions;
}
function parent(tree) {
  const matches = tree.body.filter(
    (item) =>
      item.type === 'ExpressionStatement' &&
      item.expression?.callee?.name === 'test' &&
      item.expression.arguments[0]?.value ===
        'HTTP scalar errors retain native type/format causes and exact numeric tokens without inventing CLR stacks',
  );
  if (matches.length !== 1) fail();
  return matches[0].expression.arguments[1];
}
function findChild(loop) {
  const call = loop?.body?.body?.expression?.argument;
  if (
    call?.type !== 'CallExpression' ||
    call.callee?.object?.name !== 't' ||
    call.callee?.property?.name !== 'test' ||
    call.arguments.length !== 2
  )
    fail();
  return call.arguments[1];
}
const statement = (text) => ast(text).body[0];
export function verifyScalarMigration({ baselineSource, currentSource, producerSource, capsule }) {
  const baseline = ast(baselineSource),
    current = ast(currentSource),
    producer = ast(producerSource);
  const old = parent(baseline),
    now = parent(current),
    a = old.body.body,
    b = now.body.body;
  if (
    !old.async ||
    !now.async ||
    a.length !== 18 ||
    b.length !== 21 ||
    !a.slice(0, 11).every((node, index) => eq(node, b[index])) ||
    !a.slice(14).every((node, index) => eq(node, b[index + 17]))
  )
    fail();
  // These source-derived AST pins cover the reviewed indexed expansion, the
  // entire nested request callback, the count check and the retained local
  // no-stack aggregate. They are public source, not private evidence paths.
  const reviewed = [
    '5470c2013f6b7d40500c391da46fd77fbc811ea533fc0fbee857c286d93bdd86',
    'ef93164e929a61bc4f456c49bfbad75dd2be6cba52960aab420f774eee5df9af',
    'd11b5166008ea9500292c2d688a411c211038d5dd861017974808a71aa843c0e',
    'aa2425774e91b1b51baba4fd28c7daf2c269820f1c4572a07956fe13a9ec643b',
  ];
  if (
    reviewed.some((hash, index) => parityAstHash(b[index + 13]) !== hash) ||
    parityAstHash(a[12]) !== '356c27726ec809e9ff2c4ba42e8be6854993117138dfef4c2fba2b05a0981afa' ||
    parityAstHash(a[13]) !== 'c9163aeb100c25aa10b0af44465f7f2aa9222c4b29d387bf5d78a2339da9deec'
  )
    fail();
  const inline = a[11]?.declarations?.[0];
  const exported = producer.body.filter(
    (node) => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'webApiScalarReaderCases',
  );
  if (inline?.id?.name !== 'cases' || inline.init?.type !== 'ArrayExpression' || exported.length !== 1) fail();
  const helper = exported[0].declaration;
  if (
    helper.params.length ||
    helper.async ||
    helper.body.body.length !== 3 ||
    helper.body.body[2].type !== 'ReturnStatement'
  )
    fail();
  const baseFunctions = functionsFrom(
    baseline.body.filter(
      (node) =>
        node.type === 'VariableDeclaration' &&
        node.declarations.some((item) => ['nativeCause', 'nativeFormat'].includes(item.id.name)),
    ),
  );
  const currentFunctions = functionsFrom(helper.body.body.slice(0, 2));
  if (baseFunctions.size !== 2 || currentFunctions.size !== 2) fail();
  const oldCases = evaluate(inline.init, {}, baseFunctions),
    newCases = evaluate(helper.body.body[2].argument, {}, currentFunctions);
  if (
    oldCases.length !== 17 ||
    JSON.stringify(oldCases) !== JSON.stringify(newCases) ||
    !eq(b[11], statement('const cases = webApiScalarReaderCases();')) ||
    !eq(b[12], statement('const diagnostics = [];'))
  )
    fail();
  const oldChild = findChild(a[13]),
    child = findChild(b[14]);
  if (
    !oldChild.async ||
    !child.async ||
    oldChild.params.length ||
    child.params.length ||
    oldChild.body.body.length !== 7 ||
    child.body.body.length !== 13
  )
    fail();
  const oldBody = oldChild.body.body,
    nowBody = child.body.body;
  const expectedChecks = [
    statement('assert.equal(response.status, expected.status);'),
    statement('assert.equal(error.code, expected.code);'),
    statement('assert.ok(error.message.includes(expected.cause), error.message);'),
  ];
  if (
    !eq(oldBody[0], nowBody[6]) ||
    !eq(oldBody[2], nowBody[8]) ||
    !eq(oldBody[5], nowBody[11]) ||
    !eq(nowBody[7], expectedChecks[0]) ||
    !eq(nowBody[9], expectedChecks[1]) ||
    !eq(nowBody[10], expectedChecks[2]) ||
    !eq(nowBody[12], statement('diagnostics.push(error.message);'))
  )
    fail();
  const expectedOld = [
    statement('assert.equal(response.status, 400);'),
    statement("assert.equal(error.code, '0x80048d19');"),
    statement('assert.ok(error.message.includes(cause), error.message);'),
    statement("assert.equal(error.message.includes('   at '), false);"),
  ];
  if (![oldBody[1], oldBody[3], oldBody[4], oldBody[6]].every((item, index) => eq(item, expectedOld[index]))) fail();
  if (
    !capsule ||
    !Array.isArray(capsule.cases) ||
    capsule.cases.length !== 68 ||
    capsule.captures?.length !== 2 ||
    capsule.captures[0].runSha256 === capsule.captures[1].runSha256
  )
    fail();
  const expected = oldCases.flatMap(([field, token, cause], index) =>
    ['plain', 'bom'].flatMap((encoding) =>
      ['POST', 'PATCH'].map((method) => ({
        id: `reader.${index}.${encoding}.${method}`,
        field,
        token,
        cause,
        encoding,
        method,
      })),
    ),
  );
  for (const item of expected) {
    const matches = capsule.cases.filter((entry) => entry.id === item.id);
    if (
      matches.length !== 1 ||
      Object.entries(item).some(([key, value]) => matches[0][key] !== value) ||
      matches[0].status !== 400 ||
      matches[0].code !== '0x80048d19' ||
      !Array.isArray(matches[0].nativeBodySha256) ||
      matches[0].nativeBodySha256.length !== 2 ||
      matches[0].nativeBodySha256.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))
    )
      fail();
  }
  return {
    baselineParentSha256: parityAstHash(old),
    currentParentSha256: parityAstHash(now),
    baselineLoopSha256: parityAstHash(a[13]),
    currentLoopSha256: parityAstHash(b[14]),
    tuples: oldCases.length,
    cases: expected.length,
    expected,
  };
}
