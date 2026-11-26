// @test-kind unproven: local calculation of the unfiltered child Count shape from the repository's invented designer export
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EXTENSION, parseRollupFormula } from '../lib/dataverse-rollup.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const PARENT = 'be000000-0000-4000-8000-000000000001';
const OTHER = 'be000000-0000-4000-8000-000000000002';
const CHILD = 'be000000-0000-4000-8000-000000000003';
const ANOTHER = 'be000000-0000-4000-8000-000000000004';
const DESIGNER_EXPORT = new URL(
  '../../examples/project/baseline/solution/Entities/pqvd_baselineparent/Formulas/pqvd_baselineparent-pqvd_rollup.xaml',
  import.meta.url,
);

test('a designer-exported one-to-many Count recalculates and goes stale when a child moves', async (t) => {
  const exported = await fs.readFile(DESIGNER_EXPORT, 'utf8');
  const formula = exported
    .replaceAll('pqvd_baselineparent_baselineitem', 'test_parent_child')
    .replaceAll('pqvd_parentid', 'test_parentid')
    .replaceAll('pqvd_baselineitem', 'test_child');
  assert.deepEqual(parseRollupFormula(formula), {
    child: 'test_child',
    link: 'test_parentid',
    active: false,
    aggregate: 'count',
    attribute: 'test_childid',
    unsupported: null,
  });
  assert.match(parseRollupFormula(formula.replace('>Count</', '>Sum</')).unsupported, /child Count/);

  const { request, json, store } = await contractModuleFixture(t, {
    extension: EXTENSION,
    mappings: {
      test_parent: {
        logicalName: 'test_parent',
        entitySet: 'test_parents',
        idColumn: 'test_parentid',
        fields: {
          child_count: { dataverseType: 'int', columnMetadata: { sourceType: 2, formulaDefinition: formula } },
        },
      },
      test_child: {
        logicalName: 'test_child',
        entitySet: 'test_children',
        idColumn: 'test_childid',
        fields: { test_parentid: { dataverseType: 'lookup', targets: ['test_parent'] } },
        relationships: {
          test_parentid: { entity: 'test_parent', from: 'test_parentid', to: 'test_parentid', many: false },
        },
      },
    },
    tables: {
      test_parent: [{ test_parentid: PARENT }, { test_parentid: OTHER }],
      test_child: [
        { test_childid: CHILD, test_parentid: PARENT },
        { test_childid: ANOTHER, test_parentid: OTHER },
      ],
    },
  });
  const parent = () => store.tableRows('test_parent').find((row) => row.test_parentid === PARENT);
  const rollup = `/CalculateRollupField(Target=@target,FieldName=@field)?${new URLSearchParams({
    '@target': JSON.stringify({ '@odata.id': `test_parents(${PARENT})` }),
    '@field': "'child_count'",
  })}`;
  assert.equal((await json(await request('GET', rollup), 200)).child_count, 1);
  assert.equal(parent().child_count_state, 1);
  await json(
    await request('PATCH', `/test_children(${CHILD})`, { 'test_parentid@odata.bind': `/test_parents(${OTHER})` }),
    200,
  );
  assert.equal(parent().child_count_state, 0);
  assert.equal((await json(await request('GET', rollup), 200)).child_count, 0);
});
