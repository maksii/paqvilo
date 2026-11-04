// @test-kind tooling: inventory range parsing preserves greedy operands without repeated delimiter backtracking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { expressionPaths } from '../liquid-inventory.mjs';

test('inventory finds both range operands and handles an unterminated dotted range', () => {
  assert.deepEqual(expressionPaths('(first.value..last.value)'), [
    { root: 'first', member: 'value', dynamicMember: false },
    { root: 'last', member: 'value', dynamicMember: false },
  ]);
  assert.deepEqual(expressionPaths('(first..middle..last)'), [
    { root: 'first', member: 'middle', dynamicMember: false },
    { root: 'last', member: null, dynamicMember: false },
  ]);
  assert.deepEqual(expressionPaths('(' + '.'.repeat(100_000)), []);
});
