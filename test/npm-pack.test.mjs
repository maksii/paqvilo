// @test-kind tooling: npm pack metadata remains usable across npm 11 and npm 12 without accepting ambiguous archives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { packedPackage } from '../scripts/npm-pack.mjs';

test('npm 12 package-name maps and npm 11 arrays preserve complete archive metadata', () => {
  const report = { filename: 'invented-sdk-1.0.0.tgz', integrity: 'sha512-invented', files: [{ path: 'index.js' }] };
  for (const value of [[report], { 'invented-sdk': report }])
    assert.deepEqual(packedPackage(JSON.stringify(value)), report);
});

test('empty, multiple and nonlocal npm pack results fail before an archive is accessed', () => {
  for (const value of [
    null,
    [],
    {},
    [{ filename: 'a.tgz' }, { filename: 'b.tgz' }],
    { a: { filename: 'a.tgz' }, b: { filename: 'b.tgz' } },
    { a: {} },
    { a: { filename: '../a.tgz' } },
    { a: { filename: 'folder\\a.tgz' } },
  ])
    assert.throws(() => packedPackage(JSON.stringify(value)), /Expected one npm pack result/);
});
