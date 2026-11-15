// @test-kind tooling: dependency evidence preserves default JavaScript string ordering for lockfile paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { packageDependencyEvidence } from '../scripts/package-dependency-evidence.mjs';

test('dependency differences retain UTF-16 code-unit ordering', () => {
  const paths = ['node_modules/é', 'node_modules/z', 'node_modules/😀', 'node_modules/A', 'node_modules/a'];
  const source = { packages: Object.fromEntries(paths.map((path) => [path, { version: '1.0.0' }])) };
  const result = packageDependencyEvidence(source, { packages: {} }, 'paqvilo');
  assert.deepEqual(
    result.differences.map((item) => item.path),
    [...paths].sort(),
  );
});
