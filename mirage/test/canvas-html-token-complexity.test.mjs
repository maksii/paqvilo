// @test-kind security: the browser HTML sanitizer tokenizes malformed unbounded markup without repeated scans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../lib/canvas-player.js', import.meta.url), 'utf8');
const start = source.indexOf('function* safeHtmlTokens(');
const end = source.indexOf('  // Generate safe tags', start);
assert.ok(start >= 0 && end > start);
const tokenize = runInNewContext(`(${source.slice(start, end).trim()})`);

test('HTML sanitizer keeps token order for malformed and completed markup', () => {
  assert.deepEqual(Array.from(tokenize('a<!--x--><b>z</b><oops')), ['a', '<!--x-->', '<b>', 'z', '</b>', '<', 'oops']);
  assert.equal(Array.from(tokenize('<!--'.repeat(30_000))).join(''), '<!--'.repeat(30_000));
});
