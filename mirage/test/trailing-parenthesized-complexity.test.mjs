// @test-kind security: live response identifier parsing avoids repeated scans on malformed headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trailingParenthesized } from '../lib/trailing-parenthesized.mjs';

test('response identifier uses the first opening parenthesis after the prior close', () => {
  assert.equal(trailingParenthesized('prefix(a(b)'), 'a(b');
  assert.equal(trailingParenthesized('prefix()'), undefined);
  assert.equal(trailingParenthesized(`${'('.repeat(100_000)}!`), undefined);
});
