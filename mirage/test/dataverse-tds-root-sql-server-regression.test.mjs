// @test-kind parity: Exact SQL Server engine outcomes are repeated in fixtures/tds-root-sql-server-expressions-v1.json.
// @parity-evidence: fixtures/tds-root-sql-server-expressions-v1.json binds both executions and the official image.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { executeBatch } from '../lib/dataverse-tds-sql-eval.mjs';

const evidenceBytes = readFileSync(new URL('./fixtures/tds-root-sql-server-expressions-v1.json', import.meta.url));
const evidence = JSON.parse(evidenceBytes);
const options = { catalog: { tables: new Map() }, scan: async () => [] };
// SQL_VARIANT_PROPERTY is retained as source evidence but is not implemented by this evaluator.
const cases = [
  ...evidence.results,
  ...evidence.literalControls.results.filter((item) => item.id !== 'literal-type-2147483648'),
];

for (const item of cases) {
  test(`SQL Server engine: ${item.id}`, async () => {
    assert.equal(
      createHash('sha256').update(evidenceBytes).digest('hex'),
      'f0d39ba1897e7c09b16188a3c38c551381175fed1111aebd314af6088fb5a581',
    );
    const [first, second] = item.captures;
    assert.deepEqual(first, second);
    assert.equal(first.query, item.query);
    if (first.outcome === 'sql-error') {
      await assert.rejects(executeBatch(item.query, options), { number: first.errors[0].number });
      return;
    }
    const actual = await executeBatch(item.query, options);
    const expected = first.resultSets[0];
    const cell = expected.rows[0][0];
    const value = actual.resultSets[0].rows[0][0];
    assert.equal(actual.resultSets[0].columns[0].type, expected.columns[0].sqlType);
    if (cell.kind === 'sql-decimal') {
      assert.equal(actual.resultSets[0].columns[0].precision, expected.columns[0].precision);
      assert.equal(actual.resultSets[0].columns[0].scale, expected.columns[0].scale);
    }
    assert.equal(
      value && typeof value === 'object' && 'decimal' in value ? value.decimal : value,
      cell.kind === 'sql-decimal' ? cell.exact : cell.kind === 'System.Int32' ? Number(cell.exact) : cell.value,
    );
  });
}
