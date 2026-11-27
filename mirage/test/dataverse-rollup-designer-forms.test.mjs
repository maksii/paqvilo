// Rollup definitions in the form the classic rollup designer saves them (opened from the Maker column panel): Boolean
// literals "1"/"0", UTC date literals, several checked options in one Equal or NotEqual, the designer's eight condition
// operators, source filters on a hierarchy and a hierarchical rollup of the source table's own column. The XAML layout
// follows the designer saves of summary-F6 DATA-04c2 on an invented schema; the values over the hosted dataset are replay
// cases (dataverse-rollup/designer-dc2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION, parseRollupFormula } from '../lib/dataverse-rollup.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const V = ', Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35';
const NS = [
  'xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"',
  `xmlns:mcwc="clr-namespace:Microsoft.Crm.Workflow.ClientActivities;assembly=Microsoft.Crm.Workflow${V}"`,
  'xmlns:mva="clr-namespace:Microsoft.VisualBasic.Activities;assembly=System.Activities, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35"',
  `xmlns:mxs="clr-namespace:Microsoft.Xrm.Sdk;assembly=Microsoft.Xrm.Sdk${V}"`,
  `xmlns:mxsq="clr-namespace:Microsoft.Xrm.Sdk.Query;assembly=Microsoft.Xrm.Sdk${V}"`,
  `xmlns:mxswa="clr-namespace:Microsoft.Xrm.Sdk.Workflow.Activities;assembly=Microsoft.Xrm.Sdk.Workflow${V}"`,
  'xmlns:s="clr-namespace:System;assembly=mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089"',
  'xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089"',
  'xmlns:this="clr-namespace:"',
  'xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"',
].join(' ');
const CLASS = 'XrmWorkflow00000000000000000000000000000000';
const NULL_TYPE =
  '<InArgument x:TypeArguments="s:Type"><mxswa:ReferenceLiteral x:TypeArguments="s:Type"><x:Null /></mxswa:ReferenceLiteral></InArgument>';
const reference = (kind, args) =>
  `<mxswa:ActivityReference AssemblyQualifiedName="Microsoft.Crm.Workflow.Activities.${kind}, Microsoft.Crm.Workflow${V}" DisplayName="${kind}"><mxswa:ActivityReference.Arguments>${args}</mxswa:ActivityReference.Arguments></mxswa:ActivityReference>`;
const read = (table, column, into) =>
  `<mxswa:GetEntityProperty Attribute="${column}" Entity="[InputEntities(&quot;primaryEntity&quot;)]" EntityName="${table}" Value="[${into}]"><mxswa:GetEntityProperty.TargetType>${NULL_TYPE}</mxswa:GetEntityProperty.TargetType></mxswa:GetEntityProperty>`;
const variable = (name, type = 'x:Object') =>
  `<Variable x:TypeArguments="${type}"${type === 'x:Boolean' ? ' Default="False"' : ''} Name="${name}" />`;

// A filter program in the designer's numbering: the result Boolean first, then the And results, then per condition its
// Boolean, the column value and its literals. conditions: [{ column, operator, literals: [[type, text, extra?]] }].
function program(table, conditions, prefix) {
  let n = 0;
  const next = () => `${prefix}_${++n}`;
  const result = next();
  const ands = conditions.slice(2).map(() => next());
  const vars = [variable(result, 'x:Boolean'), ...ands.map((name) => variable(name, 'x:Boolean'))];
  let body = '';
  const results = [];
  for (const condition of conditions) {
    const outcome = conditions.length === 1 ? result : next();
    if (conditions.length > 1) vars.push(variable(outcome, 'x:Boolean'));
    const value = next();
    vars.push(variable(value));
    body += read(table, condition.column, value);
    const literals = (condition.literals ?? []).map(([type, text, extra]) => {
      const name = next();
      vars.push(variable(name));
      body += reference(
        'EvaluateExpression',
        '<InArgument x:TypeArguments="x:String" x:Key="ExpressionOperator">CreateCrmType</InArgument>' +
          `<InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.${type}, "${text}"${extra ? `, "${extra}"` : ''} }]</InArgument>` +
          '<InArgument x:TypeArguments="s:Type" x:Key="TargetType"><mxswa:ReferenceLiteral x:TypeArguments="s:Type" Value="x:Object" /></InArgument>' +
          `<OutArgument x:TypeArguments="x:Object" x:Key="Result">[${name}]</OutArgument>`,
      );
      return name;
    });
    body += reference(
      'EvaluateCondition',
      `<InArgument x:TypeArguments="mxsq:ConditionOperator" x:Key="ConditionOperator">${condition.operator}</InArgument>` +
        (literals.length
          ? `<InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { ${literals.join(', ')} }]</InArgument>`
          : '<x:Null x:Key="Parameters" />') +
        `<InArgument x:TypeArguments="x:Object" x:Key="Operand">[${value}]</InArgument>` +
        `<OutArgument x:TypeArguments="x:Boolean" x:Key="Result">[${outcome}]</OutArgument>`,
    );
    results.push(outcome);
  }
  let left = results[0];
  results.slice(1).forEach((right, index) => {
    const into = index === results.length - 2 ? result : ands[index];
    body += reference(
      'EvaluateLogicalCondition',
      '<InArgument x:TypeArguments="mxsq:LogicalOperator" x:Key="LogicalOperator">And</InArgument>' +
        `<InArgument x:TypeArguments="x:Boolean" x:Key="LeftOperand">[${left}]</InArgument>` +
        `<InArgument x:TypeArguments="x:Boolean" x:Key="RightOperand">[${right}]</InArgument>` +
        `<OutArgument x:TypeArguments="x:Boolean" x:Key="Result">[${into}]</OutArgument>`,
    );
    left = into;
  });
  return { vars, body, used: n };
}

/** A designer rollup: { hierarchy, source: conditions, child: true|false, target: conditions, operator, table, column }. */
function designerRollup({
  hierarchy = null,
  source = [],
  child = true,
  target = [],
  operator,
  table = 'test_child',
  column,
}) {
  const p = 'RollupRuleStep1';
  const sourceProgram = source.length ? program('test_parent', source, p) : { vars: [], body: '', used: 0 };
  const sourceVars = [
    variable('HierarchicalRelationshipName', 'x:String').replace('/>', `Default="${hierarchy ?? '[Nothing]'}" />`),
  ];
  const sourceSequence = `<Sequence DisplayName="Source"><Sequence.Variables>${[...sourceVars, ...sourceProgram.vars].join('')}</Sequence.Variables>${sourceProgram.body}</Sequence>`;
  let targetSequence = '<Sequence DisplayName="Target" />';
  let used = sourceProgram.used;
  if (child) {
    const link =
      '<mcwc:SetAttributeValue DisplayName="test_child.test_parentid.test_parent_child" Entity="[CreatedEntities(&quot;relatedlinked_test_parent_child#test_parentid#test_child#Temp&quot;)]" EntityName="test_child" />';
    const targetProgram = target.length ? program('test_child', target, `${p}`) : null;
    // The designer numbers the target after the source: shift the names past the source's.
    const shift = (text) => text.replace(new RegExp(`${p}_(\\d+)`, 'g'), (_, k) => `${p}_${Number(k) + used}`);
    targetSequence = targetProgram
      ? `<Sequence DisplayName="Target"><Sequence.Variables>${shift(targetProgram.vars.join(''))}</Sequence.Variables>${link}${shift(targetProgram.body)}</Sequence>`
      : `<Sequence DisplayName="Target">${link}</Sequence>`;
    used += targetProgram?.used ?? 0;
  }
  const out = `${p}_${used + 1}`;
  const value = `${p}_${used + 2}`;
  const aggregate =
    `<Sequence DisplayName="Aggregate"><Sequence.Variables>${variable(out)}${variable(value)}</Sequence.Variables>` +
    read(table, column, value) +
    reference(
      'EvaluateExpression',
      `<InArgument x:TypeArguments="x:String" x:Key="ExpressionOperator">${operator}</InArgument>` +
        `<InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { ${value} }]</InArgument>` +
        `<InArgument x:TypeArguments="s:Type" x:Key="TargetType"><mxswa:ReferenceLiteral x:TypeArguments="s:Type"><x:Null /></mxswa:ReferenceLiteral></InArgument>` +
        `<OutArgument x:TypeArguments="x:Object" x:Key="Result">[${out}]</OutArgument>`,
    ) +
    '</Sequence>';
  return (
    `<?xml version="1.0" encoding="utf-16"?><Activity x:Class="${CLASS}" ${NS}><x:Members>` +
    '<x:Property Name="InputEntities" Type="InArgument(scg:IDictionary(x:String, mxs:Entity))" />' +
    '<x:Property Name="CreatedEntities" Type="InArgument(scg:IDictionary(x:String, mxs:Entity))" /></x:Members>' +
    `<this:${CLASS}.InputEntities><InArgument x:TypeArguments="scg:IDictionary(x:String, mxs:Entity)" /></this:${CLASS}.InputEntities>` +
    `<this:${CLASS}.CreatedEntities><InArgument x:TypeArguments="scg:IDictionary(x:String, mxs:Entity)" /></this:${CLASS}.CreatedEntities>` +
    '<mva:VisualBasic.Settings>Assembly references and imported namespaces for internal implementation</mva:VisualBasic.Settings>' +
    `<mxswa:Workflow><Sequence DisplayName="${p}">${sourceSequence}${targetSequence}${aggregate}</Sequence></mxswa:Workflow></Activity>`
  );
}

const option = (value) => ['OptionSetValue', String(value), 'Picklist'];
const yes = ['Boolean', '1'];
const no = ['Boolean', '0'];
const condition = (column, operator, ...literals) => ({ column, operator, literals });

// @test-kind contract: the parsed rule model Mirage builds from the rollup designer's forms; the XAML here is generated in the designer's layout on an invented schema, so the recorded designer text and its hosted values are proven by the dataverse-rollup/designer-dc2 replay cases, not by this test
test('the rollup designer forms parse into rules', () => {
  const listed = parseRollupFormula(
    designerRollup({
      target: [condition('x_category', 'Equal', option(1), option(3)), condition('x_flag', 'Equal', yes, no)],
      operator: 'Count',
      column: 'test_childid',
    }),
  );
  assert.equal(listed.unsupported, null);
  assert.deepEqual(listed.filter, {
    kind: 'and',
    left: { kind: 'condition', operator: 'Equal', column: 'x_category', type: 'number', values: [1, 3] },
    right: { kind: 'condition', operator: 'Equal', column: 'x_flag', type: 'boolean', values: [true, false] },
  });
  const ranges = parseRollupFormula(
    designerRollup({
      target: [
        condition('x_qty', 'Null'),
        condition('x_amount', 'LessThan', ['Decimal', '100']),
        condition('x_due', 'LessEqual', ['DateTime', '2026-01-01T00:00:00Z']),
        condition('x_category', 'NotEqual', option(2)),
      ],
      operator: 'Minimum',
      column: 'x_due',
    }),
  );
  assert.equal(ranges.unsupported, null);
  assert.deepEqual(
    [ranges.filter.left.left.left, ranges.filter.left.left.right, ranges.filter.left.right, ranges.filter.right],
    [
      { kind: 'condition', operator: 'Null', column: 'x_qty' },
      { kind: 'condition', operator: 'LessThan', column: 'x_amount', type: 'number', values: [100] },
      { kind: 'condition', operator: 'LessEqual', column: 'x_due', type: 'date', values: [Date.UTC(2026, 0, 1)] },
      { kind: 'condition', operator: 'NotEqual', column: 'x_category', type: 'number', values: [2] },
    ],
  );
  assert.equal(ranges.aggregate, 'min');
  const sourced = parseRollupFormula(
    designerRollup({
      hierarchy: 'test_parent_parent',
      source: [condition('x_include', 'Equal', yes)],
      operator: 'Count',
      column: 'test_childid',
    }),
  );
  assert.equal(sourced.unsupported, null);
  assert.deepEqual(
    [sourced.hierarchy, sourced.sourceTable, sourced.sourceFilter],
    [
      'test_parent_parent',
      'test_parent',
      { kind: 'condition', operator: 'Equal', column: 'x_include', type: 'boolean', values: [true] },
    ],
  );
  const own = parseRollupFormula(
    designerRollup({
      hierarchy: 'test_parent_parent',
      child: false,
      operator: 'Sum',
      table: 'test_parent',
      column: 'x_own',
    }),
  );
  assert.deepEqual(
    { self: own.self, table: own.table, child: own.child, aggregate: own.aggregate, attribute: own.attribute },
    { self: true, table: 'test_parent', child: null, aggregate: 'sum', attribute: 'x_own' },
  );
});

// @test-kind contract: forms the designer does not offer stay unsupported (state 2 with ROLLUP_UNSUPPORTED) instead of a guessed value: a source filter without a hierarchy, no related table without a hierarchy, several literals on a comparison, mixed literal types
test('designer forms outside the observed ones are unsupported', () => {
  const unsupported = (spec) =>
    parseRollupFormula(designerRollup({ operator: 'Count', column: 'test_childid', ...spec })).unsupported;
  assert.match(unsupported({ source: [condition('x_include', 'Equal', yes)] }), /without a hierarchy/);
  assert.match(unsupported({ child: false, table: 'test_parent', column: 'x_own' }), /no related table/);
  assert.match(
    unsupported({ target: [condition('x_amount', 'GreaterThan', ['Decimal', '1'], ['Decimal', '2'])] }),
    /more than one literal/,
  );
  assert.match(unsupported({ target: [condition('x_amount', 'Equal', ['Decimal', '1'], yes)] }), /mixes literal types/);
  assert.match(unsupported({ target: [condition('x_amount', 'Like', ['Decimal', '1'])] }), /operator Like/);
});

const P1 = 'dc2a0000-0000-4000-8000-000000000001';
const P2 = 'dc2a0000-0000-4000-8000-000000000002';
const P3 = 'dc2a0000-0000-4000-8000-000000000003';

function hierarchyFixture(t, fields) {
  return contractModuleFixture(t, {
    extension: EXTENSION,
    mappings: {
      test_parent: {
        logicalName: 'test_parent',
        entitySet: 'test_parents',
        idColumn: 'test_parentid',
        fields: {
          ...fields,
          x_own: { dataverseType: 'decimal' },
          x_include: { dataverseType: 'bit' },
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
        fields: { test_parentid: { dataverseType: 'lookup', targets: ['test_parent'] } },
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
        { test_parentid: P1, x_own: 1, x_include: true },
        { test_parentid: P2, x_own: 2, x_include: true, test_parentparentid: { id: P1, logical_name: 'test_parent' } },
        { test_parentid: P3, x_own: 4, x_include: true, test_parentparentid: { id: P2, logical_name: 'test_parent' } },
      ],
    },
  });
}

// @test-kind contract: a write to a row of the source table marks the self-hierarchy rollup and a source-filtered hierarchical rollup of that row and of every ancestor whose value includes it, when it writes a column the rollup reads, for Mirage's mass recalculation (the platform recalculates in its own job)
test('a source-table write marks the self-hierarchy and source-filtered rollups of the row and its ancestors', async (t) => {
  const own = designerRollup({
    hierarchy: 'test_parent_parent',
    child: false,
    operator: 'Sum',
    table: 'test_parent',
    column: 'x_own',
  });
  const filtered = designerRollup({
    hierarchy: 'test_parent_parent',
    source: [condition('x_include', 'Equal', yes)],
    operator: 'Count',
    column: 'test_childid',
  });
  const { api, request, json } = await hierarchyFixture(t, {
    x_total: { dataverseType: 'decimal', columnMetadata: { sourceType: 2, formulaDefinition: own } },
    x_count: { dataverseType: 'int', columnMetadata: { sourceType: 2, formulaDefinition: filtered } },
  });
  const ids = [P1, P2, P3];
  const settle = async () => {
    for (const id of ids)
      for (const column of ['x_total', 'x_count']) await api.rollups.recalculate('test_parent', id, column);
  };
  const stale = (column) => ids.map((id) => api.rollups.isStale('test_parent', id, column));
  await settle();
  assert.deepEqual(
    ids.map((id) => api.store.tableRows('test_parent').find((row) => row.test_parentid === id).x_total),
    [7, 6, 4],
  );
  await json(await request('PATCH', `/test_parents(${P2})`, { x_own: 3 }, { prefer: 'return=minimal' }), 204);
  assert.deepEqual(stale('x_total'), [true, true, false]);
  // The source-filtered Count does not read x_own; a write of the column its source filter reads marks it.
  assert.deepEqual(stale('x_count'), [false, false, false]);
  await json(await request('PATCH', `/test_parents(${P2})`, { x_include: false }, { prefer: 'return=minimal' }), 204);
  assert.deepEqual(stale('x_count'), [true, true, false]);
  await settle();
  assert.deepEqual(
    ids.map((id) => api.store.tableRows('test_parent').find((row) => row.test_parentid === id).x_total),
    [8, 7, 4],
  );
  assert.deepEqual([...stale('x_total'), ...stale('x_count')], Array(6).fill(false));
});
