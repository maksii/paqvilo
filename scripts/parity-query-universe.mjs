// Source-only evaluator for the bounded literal query matrix; it never runs test code.
const fail = () => {
  throw Object.assign(new Error('unsupported-query-universe'), { qualificationCode: 'unsupported-query-universe' });
};
function value(node, scope = new Map()) {
  if (node?.type === 'Literal' && ['string', 'number', 'boolean'].includes(typeof node.value)) return node.value;
  if (node?.type === 'Identifier' && scope.has(node.name)) return scope.get(node.name);
  if (node?.type === 'TemplateLiteral')
    return node.quasis
      .map((part, index) => part.value.cooked + (node.expressions[index] ? value(node.expressions[index], scope) : ''))
      .join('');
  if (node?.type === 'ArrayExpression') return node.elements.map((item) => value(item, scope));
  fail();
}
export function queryUniverse(array) {
  if (array?.type !== 'ArrayExpression') fail();
  const rows = [];
  for (const node of array.elements) {
    if (node?.type !== 'SpreadElement') {
      rows.push({ binding: value(node), source: node });
      continue;
    }
    const call = node.argument,
      member = call?.callee,
      arrow = call?.arguments?.[0];
    if (
      call?.type !== 'CallExpression' ||
      call.arguments.length !== 1 ||
      member?.type !== 'MemberExpression' ||
      member.computed ||
      member.property.name !== 'map' ||
      member.object?.type !== 'ArrayExpression' ||
      arrow?.type !== 'ArrowFunctionExpression' ||
      arrow.async ||
      arrow.params.length !== 1 ||
      arrow.body.type !== 'ArrayExpression'
    )
      fail();
    for (const entry of member.object.elements) {
      const input = value(entry),
        parameter = arrow.params[0],
        scope = new Map();
      if (parameter.type === 'Identifier') scope.set(parameter.name, input);
      else if (
        parameter.type === 'ArrayPattern' &&
        Array.isArray(input) &&
        parameter.elements.length === input.length &&
        parameter.elements.every((item) => item?.type === 'Identifier')
      )
        parameter.elements.forEach((item, index) => scope.set(item.name, input[index]));
      else fail();
      rows.push({ binding: value(arrow.body, scope), source: entry });
    }
  }
  if (
    rows.length !== 63 ||
    rows.some(
      ({ binding }) =>
        !Array.isArray(binding) ||
        binding.length !== 4 ||
        typeof binding[0] !== 'string' ||
        typeof binding[1] !== 'string' ||
        typeof binding[2] !== 'number' ||
        typeof binding[3] !== 'string',
    )
  )
    fail();
  return rows;
}
