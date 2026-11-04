// @test-kind security: composite-name placeholder parsing handles long malformed templates in linear time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../lib/pages-client-api.js', import.meta.url), 'utf8');
const start = source.indexOf('function replaceNamePlaceholders(');
const end = source.indexOf('  const warned = new Set();', start);
assert.ok(start >= 0 && end > start);
const replace = runInNewContext(`(${source.slice(start, end).trim()})`);

test('name placeholders preserve empty and nested opening braces', () => {
  assert.equal(
    replace('{} {x} {{y}', (key) => `[${key}]`),
    '{} [x] [{y]',
  );
  assert.equal(
    replace('{'.repeat(100_000), () => 'x'),
    '{'.repeat(100_000),
  );
});
