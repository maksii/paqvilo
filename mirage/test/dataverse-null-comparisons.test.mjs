// @test-kind contract: Explicit HTTP comparison semantics are separate from default DataStore/SDK SQL three-valued reads; native HTTP assertions carry their own evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const id = (n) => 'c0000000-0000-4000-8000-' + String(n).padStart(12, '0');
test('Dataverse HTTP equality/null decisions leave default store reads unchanged', async (t) => {
  const f = await contractModuleFixture(t, {
    mappings: {
      sample: {
        entitySet: 'samples',
        idColumn: 'sampleid',
        fields: { name: { dataverseType: 'nvarchar' }, quantity: { dataverseType: 'int' } },
      },
    },
    tables: {
      sample: [
        { sampleid: id(1), name: 'Null', quantity: null },
        { sampleid: id(2), name: 'One', quantity: 1 },
        { sampleid: id(3), name: 'Two', quantity: 2 },
      ],
    },
    extension: { name: 'nullable-fixture', install: () => ({}) },
  });
  const direct = f.store.query('sample', { $filter: 'quantity ne 1' }, { admin: true });
  assert.deepEqual(
    direct.value.map((row) => row.name),
    ['Two'],
  );
  // @test-kind observation: two native owned three-row truth tables in fixtures/dataverse-native-deep-facts.json (44-request cohorts; seven exact outputs, organization identity and six owned absence checks per cohort; response hashes only); requests are typed here, so it is not a replay case.
  await t.test('native HTTP nullable comparison truth table', async () => {
    const bytes = await readFile(new URL('./fixtures/dataverse-native-deep-facts.json', import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      'ee6c0d877b0863af30a9c03fea8e7ece92ba5cd9e542f2d4b4e16a01ca924ad6',
    );
    const proof = JSON.parse(bytes);
    assert.equal(proof.captures.length, 2);
    const expressions = {
      ne1: 'quantity ne 1',
      eq1: 'quantity eq 1',
      notEq1: 'not (quantity eq 1)',
      gt1: 'quantity gt 1',
      notGt1: 'not (quantity gt 1)',
      eqNull: 'quantity eq null',
      neNull: 'quantity ne null',
    };
    assert.equal(Object.keys(expressions).length, 7);
    for (const [label, expression] of Object.entries(expressions)) {
      const response = await f.json(
        await f.request(
          'GET',
          '/samples?' + new URLSearchParams({ $select: 'name,quantity', $filter: expression, $orderby: 'name' }),
        ),
        200,
      );
      assert.deepEqual(
        response.value.map((row) => row.quantity),
        proof.expected.nullComparisons[label],
        label,
      );
      if (label === 'ne1')
        assert.deepEqual(
          response.value.map((row) => [row.name, row.quantity]),
          [
            ['Null', null],
            ['Two', 2],
          ],
        );
    }
  });
  assert.deepEqual(
    f.store.query('sample', { $filter: 'quantity ne 1' }, { admin: true }).value.map((row) => row.name),
    ['Two'],
  );
});
