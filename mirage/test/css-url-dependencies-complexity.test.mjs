// @test-kind security: stylesheet dependency scanning handles malformed repeated URL functions without quadratic rescanning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cssUrlDependencies } from '../lib/css-url-dependencies.mjs';

test('CSS URL captures retain quoted, unquoted, and import semantics', () => {
  assert.deepEqual(cssUrlDependencies('@import url("theme.css"); a{src:url( font.woff )}'), [
    { value: 'theme.css', style: true },
    { value: 'font.woff', style: false },
  ]);
  assert.deepEqual(cssUrlDependencies('url('.repeat(100_000)), []);
  assert.deepEqual(cssUrlDependencies(`url("${'x'.repeat(100_000)})`), [
    { value: `"${'x'.repeat(100_000)}`, style: false },
  ]);
});
