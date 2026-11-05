// @test-kind security: Liquid whitespace control handles long template literals without repeated suffix scans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../lib/liquid-engine.mjs';

test('left whitespace control trims only final spaces and tabs', () => {
  // Base e66e7154 normalizes the trim marker in the emitted token.
  assert.deepEqual([...tokenize('before \t{{- x }}')], ['before', '{{ x }}']);
  const literal = `${' '.repeat(100_000)}x`;
  assert.equal(tokenize(`${literal}{{- x }}`)[0], literal);
  assert.equal(tokenize('before\n \t{{- x }}')[0], 'before\n');
});
