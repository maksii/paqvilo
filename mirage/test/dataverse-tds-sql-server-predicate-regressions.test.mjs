// @test-kind observation: fixtures/dataverse-sql-server-select-predicate-facts.json (SHA-256 cd04ab0142d877550eec7949ac4b2d2b2e78b416f313bc333d0d2a256957c48d) commits one SQL Server 2022 result set and one file hash, no second run identity, so it is not a replay case; engine only, not Dataverse TDS transport.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { executeBatch } from '../lib/dataverse-tds-sql-eval.mjs';

const bytes = readFileSync(new URL('./fixtures/dataverse-sql-server-select-predicate-facts.json', import.meta.url));
const { results } = JSON.parse(bytes);
const execute = (sql) => executeBatch(sql, { catalog: { tables: new Map() }, scan: () => [] });

test('SQL Server rejects predicates in scalar SELECT output expressions', async () => {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'cd04ab0142d877550eec7949ac4b2d2b2e78b416f313bc333d0d2a256957c48d',
  );
  for (const fact of results.filter((item) => item.outcome === 'sql-error')) {
    await assert.rejects(execute(fact.query), (error) => {
      assert.equal(error.number, fact.errors[0].number, fact.id);
      assert.equal(error.message, fact.errors[0].message, fact.id);
      return true;
    });
  }
});

test('SQL Server allows predicates in CASE, IIF, WHERE and HAVING controls', async () => {
  for (const fact of results.filter((item) => item.outcome === 'result')) {
    const result = await execute(fact.query);
    assert.equal(result.resultSets[0].rows[0][0], Number(fact.resultSets[0].rows[0][0].exact), fact.id);
  }
});
