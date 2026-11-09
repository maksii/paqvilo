// @test-kind parity: Two independent SQL Server 2022 engine captures of SELECT alias controls; engine only, not Dataverse TDS transport.
// @parity-evidence: fixtures/dataverse-sql-server-select-alias-facts.json SHA-256 732db466ac7ab9c91e253075524e3ef1b390328a3f2cf31a1a29289931dbe826.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { executeBatch } from '../lib/dataverse-tds-sql-eval.mjs';

const bytes = readFileSync(new URL('./fixtures/dataverse-sql-server-select-alias-facts.json', import.meta.url));
const { results } = JSON.parse(bytes);

test('legacy SELECT aliases preserve the engine column name and scalar value', async () => {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '732db466ac7ab9c91e253075524e3ef1b390328a3f2cf31a1a29289931dbe826',
  );
  for (const fact of results.filter((item) => item.outcome === 'result')) {
    const result = await executeBatch(fact.query, { catalog: { tables: new Map() }, scan: () => [] });
    assert.equal(result.resultSets[0].columns[0].name, fact.resultSets[0].columns[0].name, fact.id);
    assert.equal(result.resultSets[0].rows[0][0], Number(fact.resultSets[0].rows[0][0].exact), fact.id);
  }
});

test('legacy SELECT alias followed by AS is rejected at AS', async () => {
  const fact = results.find((item) => item.id === 'legacy-double-alias');
  await assert.rejects(executeBatch(fact.query, { catalog: { tables: new Map() }, scan: () => [] }), (error) => {
    assert.equal(error.number, fact.errors[0].number);
    assert.equal(error.message, fact.errors[0].message);
    return true;
  });
});
