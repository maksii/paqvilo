// Shared pure AST utilities for source certificates. These do not load a parser.
import { createHash } from 'node:crypto';

const normalize = (value) =>
  Array.isArray(value)
    ? value.map(normalize)
    : !value || typeof value !== 'object'
      ? value
      : Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !['loc', 'range', 'start', 'end', 'raw'].includes(key))
            .map(([key, item]) => [key, normalize(item)]),
        );

export const hashAst = (value) =>
  createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');

export function isLiteralNode(node) {
  if (node?.type === 'Literal')
    return (
      node.value === null ||
      typeof node.value === 'string' ||
      typeof node.value === 'boolean' ||
      (typeof node.value === 'number' && Number.isFinite(node.value))
    );
  if (node?.type === 'ArrayExpression') return node.elements.every((item) => item && isLiteralNode(item));
  if (node?.type === 'ObjectExpression')
    return node.properties.every(
      (item) =>
        item.type === 'Property' &&
        item.kind === 'init' &&
        !item.computed &&
        !item.method &&
        !item.shorthand &&
        !['__proto__', 'constructor', 'prototype'].includes(item.key.name ?? item.key.value) &&
        isLiteralNode(item.value),
    );
  return false;
}
