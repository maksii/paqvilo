// Shared source-shape checks for explicitly bounded evaluator witnesses.
import { hashAst } from './parity-ast-utils.mjs';

export function verifySqlWitnessSource(ast, options) {
  const declarations = ast.body.flatMap((node) =>
    node.type === 'VariableDeclaration' && node.kind === 'const'
      ? node.declarations.filter((item) => item.id?.name === options.binding)
      : [],
  );
  const loops = ast.body.filter((node) => node.type === 'ForOfStatement' && node.right?.name === options.binding);
  let references = 0;
  function visit(node) {
    if (node.type === 'Identifier' && node.name === options.binding) references++;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'key' && node.type === 'Property' && !node.computed) continue;
      if (key === 'property' && node.type === 'MemberExpression' && !node.computed) continue;
      if (Array.isArray(value)) value.filter((item) => item?.type).forEach((item) => visit(item));
      else if (value?.type) visit(value);
    }
  }
  visit(ast);
  const array = declarations[0]?.init,
    tuple = array?.elements?.[options.tupleIndex];
  if (
    declarations.length !== 1 ||
    loops.length !== 1 ||
    references !== 2 ||
    array?.type !== 'ArrayExpression' ||
    array.elements.length !== options.count ||
    hashAst(array) !== options.arraySha256 ||
    hashAst(loops[0]) !== options.loopSha256 ||
    (options.tupleSha256 && hashAst(tuple) !== options.tupleSha256)
  )
    throw Object.assign(new Error(options.error), { qualificationCode: options.error });
  return { array, tuple, loop: loops[0] };
}
