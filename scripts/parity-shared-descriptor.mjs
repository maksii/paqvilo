// Bounded shared parity descriptor: the literal is frozen at runtime and its
// sole references are the module guard and the per-case guard.
export const SHARED = '__paqParityShared';
export const FREEZE = '__paqParityFreeze';
export function sharedParityDescriptor(ast) {
  const declarations = ast.body.filter(
    (n) => n.type === 'VariableDeclaration' && n.declarations.some((d) => d.id?.name === SHARED),
  );
  if (!declarations.length) return null;
  if (declarations.length !== 1 || declarations[0].kind !== 'const' || declarations[0].declarations.length !== 1)
    throw new Error('invalid shared parity descriptor');
  const decl = declarations[0].declarations[0],
    init = decl.init;
  if (
    init?.type !== 'CallExpression' ||
    init.callee?.name !== FREEZE ||
    init.arguments.length !== 1 ||
    init.arguments[0]?.type !== 'ArrayExpression' ||
    init.arguments[0].elements.length !== 1
  )
    throw new Error('invalid shared parity descriptor');
  const imports = ast.body.filter(
    (n) => n.type === 'ImportDeclaration' && n.specifiers.some((s) => s.local.name === FREEZE),
  );
  if (
    imports.length !== 1 ||
    !imports[0].source.value.endsWith('/scripts/qualify-parity.mjs') ||
    !imports[0].specifiers.some((s) => s.imported?.name === 'freezeParityDescriptor' && s.local.name === FREEZE) ||
    !imports[0].specifiers.some(
      (s) => s.imported?.name === 'parityCaseBindings' && s.local.name === '__paqParityCaseBindings',
    )
  )
    throw new Error('invalid shared parity descriptor import');
  const sharedRefs = [],
    freezeRefs = [];
  function visit(node, parent) {
    if (node.type === 'Identifier' && node.name === SHARED) sharedRefs.push({ node, parent });
    if (node.type === 'Identifier' && node.name === FREEZE) freezeRefs.push({ node, parent });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.filter((x) => x?.type).forEach((x) => visit(x, node));
      else if (value?.type) visit(value, node);
    }
  }
  visit(ast, null);
  const refs = sharedRefs.filter((x) => x.node !== decl.id);
  if (
    sharedRefs.length !== 3 ||
    freezeRefs.length !== 2 ||
    refs.length !== 2 ||
    !refs.some(
      (x) =>
        x.parent?.type === 'CallExpression' &&
        x.parent.callee?.name === '__paqParityBindings' &&
        x.parent.arguments[1] === x.node,
    ) ||
    !refs.some(
      (x) =>
        x.parent?.type === 'CallExpression' &&
        x.parent.callee?.name === '__paqParityCaseBindings' &&
        x.parent.arguments[4] === x.node,
    )
  )
    throw new Error('unsafe shared parity descriptor reference');
  const topGuard = refs.find((x) => x.parent.callee.name === '__paqParityBindings').parent;
  const guardStatement = ast.body.find((node) => node.type === 'ExpressionStatement' && node.expression === topGuard);
  if (
    !guardStatement ||
    ast.body.indexOf(imports[0]) >= ast.body.indexOf(declarations[0]) ||
    ast.body.indexOf(declarations[0]) >= ast.body.indexOf(guardStatement)
  )
    throw new Error('invalid shared parity descriptor order');
  return { declaration: declarations[0], data: init.arguments[0], refs: refs.map((x) => x.node), import: imports[0] };
}
