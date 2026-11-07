// @test-kind security: compiler error cleanup handles untrusted long incomplete project suffixes without repeated scans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripCsprojSuffix } from '../lib/strip-csproj-suffix.mjs';

test('compiler project suffix cleanup preserves earlier bracketed text', () => {
  assert.equal(stripCsprojSuffix('error [first] text [C:/app.csproj]'), 'error [first] text');
  assert.equal(stripCsprojSuffix(`error ${'['.repeat(100_000)}x`), `error ${'['.repeat(100_000)}x`);
  assert.equal(stripCsprojSuffix('error [file.csproj]\n'), 'error [file.csproj]\n');
});
