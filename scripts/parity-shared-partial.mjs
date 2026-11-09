// Frozen partial descriptors are shared only by a module guard and the exact
// ordered inline regions they describe. No aliases or other uses are allowed.
export const PARTIAL_SHARED = '__paqParityPartialShared';
export const PARTIAL_FREEZE = '__paqParityPartialFreeze';

function property(node, name) {
  if (node?.type !== 'ObjectExpression') return null;
  return node.properties.find(
    (item) => item.type === 'Property' && !item.computed && (item.key.name ?? item.key.value) === name,
  )?.value;
}
function metaUrl(node) {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    node.property?.name === 'url' &&
    node.object?.type === 'MetaProperty' &&
    node.object.meta.name === 'import' &&
    node.object.property.name === 'meta'
  );
}
function requireValid(condition) {
  if (!condition) throw new Error('invalid shared partial descriptor');
}
function literalHashes(node) {
  requireValid(node?.type === 'ArrayExpression' && node.elements.length > 0);
  return node.elements.map((region) => {
    requireValid(region?.type === 'ArrayExpression' && region.elements.length > 0);
    return region.elements.map((item) => {
      requireValid(item?.type === 'Literal' && typeof item.value === 'string' && /^[a-f0-9]{64}$/u.test(item.value));
      return item.value;
    });
  });
}
function sharedNodes(ast) {
  const parents = new Map();
  const identifiers = [];
  function walk(node, parent) {
    if (parent) parents.set(node, parent);
    if (
      node.type === 'Identifier' &&
      [PARTIAL_SHARED, PARTIAL_FREEZE, '__paqParityAssertions', '__paqParityBindings'].includes(node.name)
    )
      identifiers.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.filter((child) => child?.type).forEach((child) => walk(child, node));
      else if (value?.type) walk(value, node);
    }
  }
  walk(ast, null);
  return { parents, identifiers };
}
function enclosingCallback(block, parents) {
  let current = block;
  while (parents.has(current)) {
    current = parents.get(current);
    if (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') return current;
  }
  return null;
}
function importedTest(ast, name) {
  return ast.body.some(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.source.value === 'node:test' &&
      node.specifiers.some(
        (item) =>
          item.local.name === name &&
          (item.type === 'ImportDefaultSpecifier' ||
            (item.type === 'ImportSpecifier' && ['test', 'it'].includes(item.imported.name))),
      ),
  );
}
function reviewRegionReference({ ref, parents, descriptors, ast, astHash }) {
  const member = parents.get(ref);
  requireValid(
    member?.type === 'MemberExpression' &&
      member.object === ref &&
      member.computed &&
      member.property.type === 'Literal' &&
      Number.isInteger(member.property.value),
  );
  const index = member.property.value;
  requireValid(index >= 0 && index < descriptors.length);
  const array = parents.get(member);
  const call = parents.get(array);
  requireValid(
    array?.type === 'ArrayExpression' &&
      array.elements.length === 1 &&
      array.elements[0] === member &&
      call?.type === 'CallExpression' &&
      call.callee?.name === '__paqParityAssertions' &&
      call.arguments.length === 2 &&
      call.arguments[1] === array &&
      metaUrl(call.arguments[0]),
  );
  const statement = parents.get(call);
  const block = parents.get(statement);
  requireValid(
    statement?.type === 'ExpressionStatement' && block?.type === 'BlockStatement' && block.body[0] === statement,
  );
  const callback = enclosingCallback(block, parents);
  const registration = parents.get(callback);
  const registrationStatement = parents.get(registration);
  requireValid(
    callback &&
      registration?.type === 'CallExpression' &&
      registration.arguments[1] === callback &&
      registration.arguments.length === 2 &&
      registration.callee?.type === 'Identifier' &&
      ['test', 'it'].includes(registration.callee.name) &&
      importedTest(ast, registration.callee.name) &&
      registrationStatement?.type === 'ExpressionStatement' &&
      ast.body.includes(registrationStatement) &&
      (block === callback.body || parents.get(block) === callback.body) &&
      astHash(registration.arguments[0]) === descriptors[index].title,
  );
  const hashes = block.body.slice(1).map((item) => {
    const expression = item.type === 'ReturnStatement' ? item.argument : item.expression;
    requireValid(item.type === 'ExpressionStatement' || item.type === 'ReturnStatement');
    return astHash(expression?.type === 'AwaitExpression' ? expression.argument : expression);
  });
  descriptors[index].seen.push(hashes);
  return { call, array, descriptor: descriptors[index].node };
}

export function sharedPartialDescriptors(ast, astHash) {
  const declarations = ast.body.filter(
    (node) => node.type === 'VariableDeclaration' && node.declarations.some((item) => item.id?.name === PARTIAL_SHARED),
  );
  if (!declarations.length) return null;
  requireValid(
    declarations.length === 1 && declarations[0].kind === 'const' && declarations[0].declarations.length === 1,
  );
  const declaration = declarations[0];
  const binding = declaration.declarations[0];
  const init = binding.init;
  requireValid(
    init?.type === 'CallExpression' &&
      init.callee?.name === PARTIAL_FREEZE &&
      init.arguments.length === 1 &&
      init.arguments[0]?.type === 'ArrayExpression' &&
      init.arguments[0].elements.length > 0,
  );
  const data = init.arguments[0];
  const descriptors = data.elements.map((item) => {
    const title = property(item, 'titleExpressionSha256');
    requireValid(title?.type === 'Literal' && typeof title.value === 'string' && /^[a-f0-9]{64}$/u.test(title.value));
    return { node: item, title: title.value, regions: literalHashes(property(item, 'regionHashes')), seen: [] };
  });
  requireValid(new Set(descriptors.map((item) => item.title)).size === descriptors.length);
  const imports = ast.body.filter(
    (node) => node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === PARTIAL_FREEZE),
  );
  requireValid(
    imports.length === 1 &&
      imports[0].source.value.endsWith('/scripts/qualify-parity.mjs') &&
      imports[0].specifiers.some(
        (item) => item.imported?.name === 'freezeParityDescriptor' && item.local.name === PARTIAL_FREEZE,
      ) &&
      imports[0].specifiers.some(
        (item) => item.imported?.name === 'parityAssertions' && item.local.name === '__paqParityAssertions',
      ),
  );
  const bindingImports = ast.body.filter(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.source.value.endsWith('/scripts/qualify-parity.mjs') &&
      node.specifiers.some(
        (item) => item.imported?.name === 'assertParityBindings' && item.local.name === '__paqParityBindings',
      ),
  );
  requireValid(bindingImports.length === 1);

  const { parents, identifiers } = sharedNodes(ast);
  const refs = identifiers.filter((node) => node.name === PARTIAL_SHARED && node !== binding.id);
  const freezeRefs = identifiers.filter((node) => node.name === PARTIAL_FREEZE);
  requireValid(freezeRefs.length === 2 && freezeRefs.includes(init.callee) && refs.length > 1);
  let topGuard;
  const references = [];
  const regionCalls = [];
  for (const ref of refs) {
    const parent = parents.get(ref);
    if (
      parent?.type === 'CallExpression' &&
      parent.callee?.name === '__paqParityBindings' &&
      parent.arguments[1] === ref
    ) {
      requireValid(!topGuard && parent.arguments.length === 2 && metaUrl(parent.arguments[0]));
      topGuard = parent;
      references.push({ node: ref, data });
      continue;
    }
    const region = reviewRegionReference({ ref, parents, descriptors, ast, astHash });
    regionCalls.push(region.call);
    references.push({ node: region.array, data: { type: 'ArrayExpression', elements: [region.descriptor] } });
  }
  const topStatement = ast.body.find((node) => node.type === 'ExpressionStatement' && node.expression === topGuard);
  requireValid(
    topStatement &&
      ast.body.indexOf(imports[0]) < ast.body.indexOf(declaration) &&
      ast.body.indexOf(declaration) < ast.body.indexOf(topStatement),
  );
  requireValid(
    ast.body
      .slice(0, ast.body.indexOf(topStatement))
      .every((node) => node.type === 'ImportDeclaration' || node === declaration),
  );
  const regionImport = imports[0].specifiers.find((item) => item.local.name === '__paqParityAssertions').local;
  const regionUses = identifiers.filter((node) => node.name === '__paqParityAssertions');
  requireValid(
    regionUses.length === regionCalls.length + 1 &&
      regionUses.includes(regionImport) &&
      regionCalls.every((call) => regionUses.includes(call.callee)),
  );
  const guardImport = bindingImports[0].specifiers.find((item) => item.local.name === '__paqParityBindings').local;
  const guardUses = identifiers.filter((node) => node.name === '__paqParityBindings');
  requireValid(
    guardUses.includes(guardImport) &&
      guardUses.includes(topGuard.callee) &&
      guardUses.every(
        (node) =>
          node === guardImport ||
          (parents.get(node)?.type === 'CallExpression' &&
            parents.get(node).callee === node &&
            parents.get(node).arguments.length === 2 &&
            metaUrl(parents.get(node).arguments[0])),
      ),
  );
  for (const descriptor of descriptors)
    requireValid(JSON.stringify(descriptor.seen) === JSON.stringify(descriptor.regions));
  return { declaration, data, references };
}
