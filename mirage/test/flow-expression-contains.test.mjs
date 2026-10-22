// Task 70: contains() on an array compares values (exact numerics by value, strings and objects by value); on a string it
// finds a substring and on an object a key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFlowValue } from '../lib/flow-runtime.mjs';

const state = () => ({ input: { list: [9007199254740993n], tags: ['a', 'b'] }, variables: {}, parameters: {}, results: {}, items: [] });
const value = expression => resolveFlowValue(expression, state());

test('contains() on arrays uses value equality', () => {
  assert.equal(value('@contains(createArray(9007199254740993), 9007199254740993)'), true, 'exact integers above 2^53 compare by value');
  assert.equal(value("@contains(json('[9007199254740993, 2]'), json('9007199254740993'))"), true);
  assert.equal(value("@contains(json('[1.50]'), 1.5)"), true);
  assert.equal(value("@contains(json('[{\"a\":1}]'), json('{\"a\":1}'))"), true, 'objects compare member-wise');
  assert.equal(value("@contains(createArray('a', 'b'), 'b')"), true);
  assert.equal(value("@contains(createArray('a', 'b'), 'B')"), false);
  assert.equal(value('@contains(createArray(1, 2), 3)'), false);
  assert.equal(value("@contains('invented text', 'ted t')"), true);
  assert.equal(value("@contains(json('{\"k\":1}'), 'k')"), true);
});
