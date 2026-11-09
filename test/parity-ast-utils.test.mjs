// @test-kind tooling: source-certificate AST hashes and literal admission retain their exact boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashAst, isLiteralNode } from '../scripts/parity-ast-utils.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('AST hashing removes only location and raw metadata recursively', () => {
  const node = {
    type: 'Example',
    loc: { start: 1 },
    range: [1, 9],
    value: [{ type: 'Literal', value: 'kept', raw: "'kept'", start: 2, end: 8 }],
    nested: { raw: 'ignored', name: 'kept' },
  };
  const normalized = { type: 'Example', value: [{ type: 'Literal', value: 'kept' }], nested: { name: 'kept' } };
  assert.equal(hashAst(node), digest(normalized));
  assert.equal(hashAst({ ...node, loc: { start: 99 }, range: [9, 99] }), hashAst(node));
  assert.notEqual(hashAst({ ...node, nested: { name: 'changed' } }), hashAst(node));
  assert.throws(() => hashAst(undefined), TypeError);
});

test('literal admission permits bounded literals and rejects executable or unsafe forms', () => {
  const literal = (value) => ({ type: 'Literal', value });
  const property = (key, value, extra = {}) => ({
    type: 'Property',
    kind: 'init',
    computed: false,
    method: false,
    shorthand: false,
    key: { type: 'Identifier', name: key },
    value,
    ...extra,
  });
  const valid = {
    type: 'ObjectExpression',
    properties: [property('value', { type: 'ArrayExpression', elements: [literal(null), literal('x'), literal(3)] })],
  };
  assert.equal(isLiteralNode(valid), true);
  for (const value of [Infinity, NaN, /pattern/, 1n, undefined]) assert.equal(isLiteralNode(literal(value)), false);
  assert.equal(isLiteralNode({ type: 'ArrayExpression', elements: [null] }), false);
  assert.equal(isLiteralNode({ type: 'Identifier', name: 'input' }), false);
  for (const key of ['__proto__', 'constructor', 'prototype'])
    assert.equal(isLiteralNode({ type: 'ObjectExpression', properties: [property(key, literal(1))] }), false);
  for (const extra of [{ computed: true }, { method: true }, { shorthand: true }, { kind: 'get' }])
    assert.equal(isLiteralNode({ type: 'ObjectExpression', properties: [property('safe', literal(1), extra)] }), false);
  assert.equal(isLiteralNode({ type: 'ObjectExpression', properties: [{ type: 'SpreadElement' }] }), false);
});
