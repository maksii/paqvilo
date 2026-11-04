// @test-kind compatibility: preserve the exact trailing slash and equals behavior used by Mirage callers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTrailingCharacter } from '../lib/text-scanning.mjs';

test('stripTrailingCharacter removes only a trailing run of the requested code unit', () => {
  assert.equal(stripTrailingCharacter('', '/'), '');
  assert.equal(stripTrailingCharacter('////', '/'), '');
  assert.equal(stripTrailingCharacter('====', '='), '');
  assert.equal(stripTrailingCharacter('a/b///', '/'), 'a/b');
  assert.equal(stripTrailingCharacter('a=b===', '='), 'a=b');
  assert.equal(stripTrailingCharacter(' /\n', '/'), ' /\n');
  assert.equal(stripTrailingCharacter('value\n///', '/'), 'value\n');
  assert.equal(stripTrailingCharacter('\ud800///', '/'), '\ud800');
  assert.equal(stripTrailingCharacter(`${'/'.repeat(100_000)}x`, '/'), `${'/'.repeat(100_000)}x`);
  assert.equal(stripTrailingCharacter(`x${'/'.repeat(100_000)}`, '/'), 'x');
  assert.equal(stripTrailingCharacter(`x${'='.repeat(100_000)}`, '='), 'x');
});
