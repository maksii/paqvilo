// @test-kind security: multipart foreign boundary detection handles long malformed padding without quadratic backtracking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../lib/dataverse-batch.mjs', import.meta.url), 'utf8');
const match = /const FOREIGN_DELIMITER = (\/.*\/);/.exec(source);
test('foreign multipart delimiter requires a complete line', () => {
  assert.ok(match);
  const pattern = runInNewContext(match[1]);
  assert.equal(pattern.test(`--${' '.repeat(100_000)}!`), false);
  assert.equal(pattern.test('--abc--  \t\r\n'), true);
  assert.equal(pattern.test('body\n--abc\n'), true);
});
