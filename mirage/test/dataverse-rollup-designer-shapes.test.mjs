// Designer rollup shapes beyond the unfiltered Count: definition checks at column create, the filter subset the hosted
// runs exercised, and hierarchical stale marks. Values over the hosted dataset are replay cases (dataverse-rollup/designer-f6).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EXTENSION, parseRollupFormula } from '../lib/dataverse-rollup.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const P1 = 'f6a00000-0000-4000-8000-000000000001';
const P2 = 'f6a00000-0000-4000-8000-000000000002';
const P3 = 'f6a00000-0000-4000-8000-000000000003';
const P4 = 'f6a00000-0000-4000-8000-000000000004';
const CHILD = 'f6a00000-0000-4000-8000-000000000011';
const DESIGNER_EXPORT = new URL(
  '../../examples/project/baseline/solution/Entities/pqvd_baselineparent/Formulas/pqvd_baselineparent-pqvd_rollup.xaml',
  import.meta.url,
);

// The repository's invented designer Count, moved onto the test schema; `aggregate` and `attribute` reshape its Aggregate.
async function designer({ aggregate = 'Count', attribute = 'test_childid', hierarchy = null, target = '' } = {}) {
  let text = (await fs.readFile(DESIGNER_EXPORT, 'utf8'))
    .replaceAll('pqvd_baselineparent_baselineitem', 'test_parent_child')
    .replaceAll('pqvd_parentid', 'test_parentid')
    .replaceAll('pqvd_baselineitemid', attribute)
    .replaceAll('pqvd_baselineitem', 'test_child')
    .replace('>Count<', `>${aggregate}<`);
  if (hierarchy) text = text.replace('Default="[Nothing]"', `Default="${hierarchy}"`);
  if (target) text = text.replace(/(<mcwc:SetAttributeValue [^>]*\/>)/, `$1${target}`);
  return text;
}

// A filter in the hosted designer layout: read a child column, build a literal, compare (the result is the first Boolean).
const filterTarget = ({ operator = 'GreaterThan', literal = '"10"', logical = null } = {}) => {
  const reference = (kind) =>
    `AssemblyQualifiedName="Microsoft.Crm.Workflow.Activities.${kind}, Microsoft.Crm.Workflow, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35" DisplayName="${kind}"`;
  const condition = (result) =>
    `<mxswa:ActivityReference ${reference('EvaluateCondition')}><mxswa:ActivityReference.Arguments>` +
    `<InArgument x:TypeArguments="mxsq:ConditionOperator" x:Key="ConditionOperator">${operator}</InArgument>` +
    `<InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { F_3 }]</InArgument>` +
    `<InArgument x:TypeArguments="x:Object" x:Key="Operand">[F_2]</InArgument>` +
    `<OutArgument x:TypeArguments="x:Boolean" x:Key="Result">[${result}]</OutArgument>` +
    `</mxswa:ActivityReference.Arguments></mxswa:ActivityReference>`;
  const combined = logical
    ? condition('F_4') +
      condition('F_5') +
      `<mxswa:ActivityReference ${reference('EvaluateLogicalCondition')}><mxswa:ActivityReference.Arguments>` +
      `<InArgument x:TypeArguments="mxsq:LogicalOperator" x:Key="LogicalOperator">${logical}</InArgument>` +
      `<InArgument x:TypeArguments="x:Boolean" x:Key="LeftOperand">[F_4]</InArgument>` +
      `<InArgument x:TypeArguments="x:Boolean" x:Key="RightOperand">[F_5]</InArgument>` +
      `<OutArgument x:TypeArguments="x:Boolean" x:Key="Result">[F_1]</OutArgument>` +
      `</mxswa:ActivityReference.Arguments></mxswa:ActivityReference>`
    : condition('F_1');
  return (
    `<mxswa:GetEntityProperty Attribute="x_amount" Entity="[InputEntities(&quot;primaryEntity&quot;)]" EntityName="test_child" Value="[F_2]" />` +
    `<mxswa:ActivityReference ${reference('EvaluateExpression')}><mxswa:ActivityReference.Arguments>` +
    `<InArgument x:TypeArguments="x:String" x:Key="ExpressionOperator">CreateCrmType</InArgument>` +
    `<InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.Decimal, ${literal} }]</InArgument>` +
    `<OutArgument x:TypeArguments="x:Object" x:Key="Result">[F_3]</OutArgument>` +
    `</mxswa:ActivityReference.Arguments></mxswa:ActivityReference>` +
    combined
  );
};
const withVariables = (text) =>
  text.replace(
    '<Sequence DisplayName="Target">',
    '<Sequence DisplayName="Target"><Sequence.Variables><Variable x:TypeArguments="x:Boolean" Default="False" Name="F_1" /></Sequence.Variables>',
  );

// @test-kind observation: hosted definitions 2026-11-26 (paqvilo-developer hosted-f6 derived-create runs, summary-F6 DATA-04c): a rollup column whose designer Aggregate says Min or Max is refused at create with 400 0x80060417 "FormulaDefinition is not valid Xaml"; Minimum and Maximum are accepted
test('a rollup definition with Min or Max is refused at column create; Minimum and Maximum are stored', async (t) => {
  const { request } = await contractModuleFixture(t, {
    extension: EXTENSION,
    mappings: {
      test_parent: { logicalName: 'test_parent', entitySet: 'test_parents', idColumn: 'test_parentid', fields: {} },
      test_child: {
        logicalName: 'test_child',
        entitySet: 'test_children',
        idColumn: 'test_childid',
        fields: { x_amount: { dataverseType: 'decimal' } },
      },
    },
  });
  const create = async (name, aggregate) =>
    request('POST', "/EntityDefinitions(LogicalName='test_parent')/Attributes", {
      '@odata.type': 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata',
      SchemaName: name,
      DisplayName: { LocalizedLabels: [{ Label: name, LanguageCode: 1033 }] },
      RequiredLevel: { Value: 'None' },
      SourceType: 2,
      FormulaDefinition: await designer({ aggregate, attribute: 'x_amount' }),
    });
  for (const [name, aggregate] of [
    ['test_rmin', 'Min'],
    ['test_rmax', 'Max'],
  ]) {
    const refused = await create(name, aggregate);
    assert.equal(refused.status, 400, aggregate);
    assert.deepEqual((await refused.json()).error, {
      code: '0x80060417',
      message: 'FormulaDefinition is not valid Xaml',
    });
  }
  for (const [name, aggregate] of [
    ['test_rminimum', 'Minimum'],
    ['test_rmaximum', 'Maximum'],
  ]) {
    const created = await create(name, aggregate);
    assert.equal(created.status, 204, await created.text());
  }
});

// @test-kind contract: Mirage reads only the designer filter forms the hosted runs exercised (summary-F6 DATA-04c and DATA-04c2: the designer's eight condition operators over option set, Boolean, number and date literals, joined by And); any other form reads state 2 with ROLLUP_UNSUPPORTED instead of a guessed value
test('the designer filter subset is the observed one; other operators and Or are unsupported', async () => {
  const parse = async (options) =>
    parseRollupFormula(
      withVariables(await designer({ aggregate: 'Sum', attribute: 'x_amount', target: filterTarget(options) })),
    );
  assert.deepEqual((await parse({})).filter, {
    kind: 'condition',
    operator: 'GreaterThan',
    column: 'x_amount',
    type: 'number',
    values: [10],
  });
  assert.equal((await parse({ logical: 'And' })).filter.kind, 'and');
  assert.equal((await parse({ operator: 'LessThan' })).filter.operator, 'LessThan');
  assert.match((await parse({ operator: 'Like' })).unsupported, /operator Like/);
  assert.match((await parse({ logical: 'Or' })).unsupported, /Or/);
  assert.match((await parse({ literal: '"2026-01-01", "DateTime"' })).unsupported, /literal/);
  assert.match(parseRollupFormula(await designer({ aggregate: 'Median' })).unsupported, /Count, Sum, Average/);
});

// @test-kind contract: a hierarchical designer rollup counts the parent and its descendants, and Mirage marks every ancestor whose value includes a changed child or a moved row for the mass recalculation
test('a hierarchical rollup marks every ancestor when a child or a row of the hierarchy moves', async (t) => {
  const formula = await designer({ aggregate: 'Sum', attribute: 'x_amount', hierarchy: 'test_parent_parent' });
  const { api, request, json } = await contractModuleFixture(t, {
    extension: EXTENSION,
    mappings: {
      test_parent: {
        logicalName: 'test_parent',
        entitySet: 'test_parents',
        idColumn: 'test_parentid',
        fields: {
          x_total: { dataverseType: 'decimal', columnMetadata: { sourceType: 2, formulaDefinition: formula } },
          test_parentparentid: { dataverseType: 'lookup', targets: ['test_parent'] },
        },
        relationships: {
          test_parentparentid: {
            entity: 'test_parent',
            from: 'test_parentparentid',
            to: 'test_parentid',
            many: false,
            schemaName: 'test_parent_parent',
          },
        },
      },
      test_child: {
        logicalName: 'test_child',
        entitySet: 'test_children',
        idColumn: 'test_childid',
        fields: {
          x_amount: { dataverseType: 'decimal' },
          test_parentid: { dataverseType: 'lookup', targets: ['test_parent'] },
        },
        relationships: {
          test_parentid: {
            entity: 'test_parent',
            from: 'test_parentid',
            to: 'test_parentid',
            many: false,
            schemaName: 'test_parent_child',
          },
        },
      },
    },
    tables: {
      test_parent: [
        { test_parentid: P1 },
        { test_parentid: P2, test_parentparentid: { id: P1, logical_name: 'test_parent' } },
        { test_parentid: P3, test_parentparentid: { id: P2, logical_name: 'test_parent' } },
        { test_parentid: P4 },
      ],
      test_child: [{ test_childid: CHILD, x_amount: 5, test_parentid: { id: P3, logical_name: 'test_parent' } }],
    },
  });
  const stale = () => [P1, P2, P3, P4].map((id) => api.rollups.isStale('test_parent', id, 'x_total'));
  const settle = async () => {
    for (const id of [P1, P2, P3, P4]) await api.rollups.recalculate('test_parent', id, 'x_total');
  };
  await settle();
  assert.deepEqual(
    [P1, P2, P3, P4].map((id) => api.store.tableRows('test_parent').find((row) => row.test_parentid === id).x_total),
    [5, 5, 5, 0],
  );
  const minimal = { prefer: 'return=minimal' };
  await json(await request('PATCH', `/test_children(${CHILD})`, { x_amount: 6 }, minimal), 204);
  assert.deepEqual(stale(), [true, true, true, false]);
  await settle();
  await json(
    await request(
      'PATCH',
      `/test_parents(${P3})`,
      { 'test_parentparentid@odata.bind': `/test_parents(${P4})` },
      minimal,
    ),
    204,
  );
  assert.deepEqual(stale(), [true, true, false, true], 'the old ancestors and the new one');
  await settle();
  assert.equal((await api.rollups.recalculate('test_parent', P4, 'x_total')).value, 6);
  assert.equal((await api.rollups.recalculate('test_parent', P1, 'x_total')).value, 0);
});

// @test-kind unproven: assumed that a rollup value is stored at the column Precision as calculated columns are (hosted summary-F6 shows precision 2 rounding for calculated columns; the recorded rollup values needed no rounding); the sum itself is exact decimal arithmetic
test('rollup sums and averages are exact decimals rounded to the column precision', async (t) => {
  const column = (precision) => ({
    dataverseType: 'decimal',
    precision,
    columnMetadata: { sourceType: 2, formulaDefinition: null, precision },
  });
  const formulas = {
    x_sum: await designer({ aggregate: 'Sum', attribute: 'x_amount' }),
    x_average: await designer({ aggregate: 'Average', attribute: 'x_amount' }),
    x_average4: await designer({ aggregate: 'Average', attribute: 'x_amount' }),
  };
  const fields = Object.fromEntries(
    Object.entries({ x_sum: 2, x_average: 2, x_average4: 4 }).map(([name, precision]) => {
      const definition = column(precision);
      definition.columnMetadata.formulaDefinition = formulas[name];
      return [name, definition];
    }),
  );
  const child = (id, parent, amount) => ({
    test_childid: id,
    x_amount: amount,
    test_parentid: { id: parent, logical_name: 'test_parent' },
  });
  const { api } = await contractModuleFixture(t, {
    extension: EXTENSION,
    mappings: {
      test_parent: { logicalName: 'test_parent', entitySet: 'test_parents', idColumn: 'test_parentid', fields },
      test_child: {
        logicalName: 'test_child',
        entitySet: 'test_children',
        idColumn: 'test_childid',
        fields: {
          x_amount: { dataverseType: 'decimal' },
          test_parentid: { dataverseType: 'lookup', targets: ['test_parent'] },
        },
        relationships: {
          test_parentid: {
            entity: 'test_parent',
            from: 'test_parentid',
            to: 'test_parentid',
            many: false,
            schemaName: 'test_parent_child',
          },
        },
      },
    },
    tables: {
      test_parent: [{ test_parentid: P1 }, { test_parentid: P2 }],
      test_child: [
        child(CHILD, P1, 0.1),
        child('f6a00000-0000-4000-8000-000000000012', P1, 0.2),
        child('f6a00000-0000-4000-8000-000000000013', P2, 10),
        child('f6a00000-0000-4000-8000-000000000014', P2, 0),
        child('f6a00000-0000-4000-8000-000000000015', P2, null),
      ],
    },
  });
  const value = async (id, name) => (await api.rollups.recalculate('test_parent', id, name)).value;
  assert.equal(await value(P1, 'x_sum'), 0.3);
  assert.equal(await value(P1, 'x_average'), 0.15);
  assert.equal(await value(P2, 'x_average'), 3.33, 'a null child counts as 0: 10 / 3');
  assert.equal(await value(P2, 'x_average4'), 3.3333);
  assert.equal(await value(P2, 'x_sum'), 10);
});
