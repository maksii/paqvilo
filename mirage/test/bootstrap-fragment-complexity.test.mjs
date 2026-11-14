// @test-kind security: Bootstrap target extraction handles long malformed hrefs without repeated regex scans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../lib/bootstrap-plugins-compat.js', import.meta.url), 'utf8');
const start = source.indexOf('function fragmentSelector(');
const end = source.indexOf("  // A trigger's targets", start);
test('Bootstrap fragment selection preserves prior lines and final hash choice', () => {
  assert.ok(start >= 0 && end > start);
  const fragmentSelector = runInNewContext(`(${source.slice(start, end).trim()})`);
  assert.equal(fragmentSelector('prefix\npath#one#two'), 'prefix\n#two');
  assert.equal(fragmentSelector(`a${'x'.repeat(100_000)}`), `a${'x'.repeat(100_000)}`);
  assert.equal(fragmentSelector('path#'), 'path#');
});
