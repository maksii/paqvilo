// @test-kind parity: Two independent Microsoft SQL Server 2022 engine captures establish these exact function results.
// @parity-evidence: fixtures/dataverse-sql-server-function-facts.json SHA-256 e6aa0995861d943219e153b10df0815bd8d62ad7b5c07978f008b02f2f01c9f5; SQL Server engine only, not Dataverse TDS transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { callFunction } from '../lib/dataverse-tds-sql-functions.mjs';

const bytes = readFileSync(new URL('./fixtures/dataverse-sql-server-function-facts.json', import.meta.url));
const facts = JSON.parse(bytes);
const fact = (name) => {
  const entry = facts.results.find((item) => item.case === name);
  assert.ok(entry, `Missing SQL Server capture ${name}`);
  const value = entry.rows[0][0];
  return value.kind === 'System.Int32' ? Number(value.exact) : value.value;
};

test('SQL Server NULL separator and empty separator are equivalent in CONCAT_WS', () => {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'e6aa0995861d943219e153b10df0815bd8d62ad7b5c07978f008b02f2f01c9f5',
  );
  for (const name of ['concat-untyped', 'concat-nvarchar', 'concat-varchar']) {
    assert.equal(callFunction('CONCAT_WS', [null, 'a', 'b']), fact(name), name);
  }
  for (const name of ['concat-empty-nvarchar', 'concat-empty-varchar']) {
    assert.equal(callFunction('CONCAT_WS', ['', 'a', 'b']), fact(name), name);
  }
});

test('SQL Server PATINDEX honors wildcard anchoring and reports the first matched character', () => {
  for (const [name, pattern, input, ctx] of [
    ['patindex-original', 'a_c', 'zabc'],
    ['patindex-leading-percent', '%a_c', 'zabc'],
    ['patindex-trailing-percent', 'a_c%', 'zabc'],
    ['patindex-both-percent', '%a_c%', 'zabc'],
    ['patindex-full', 'a_c', 'abc'],
    ['patindex-inside', 'a_c', 'zabcz'],
    ['patindex-case-ci', '%A_C%', 'zabc', { caseSensitive: false }],
    ['patindex-case-cs', '%A_C%', 'zabc', { caseSensitive: true }],
  ]) {
    assert.equal(callFunction('PATINDEX', [pattern, input], ctx), fact(name), name);
  }
});
