// @test-kind unproven: local model of designer calculated-column XAML (lib/calculated-xaml.mjs) beyond the hosted replay cases in parity/cases/dataverse-calculated; each test the hosted evidence proves carries its own tag.
// Designer calculated-column XAML (lib/calculated-xaml.mjs, lib/dataverse-calculated.mjs), the exported Formulas text served
// unchanged (lib/solution-formulas.mjs), the definition-time refusal (lib/dataverse-metadata-tables.mjs) and the cascade
// metadata of an export (lib/solution-schema.mjs, lib/dataverse-metadata-relationships.mjs). Every schema is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatedDefinitionError,
  compileCalculatedXaml,
  isCalculatedXaml,
  runCalculatedXaml,
} from '../lib/calculated-xaml.mjs';
import { entityXml, relationshipsXml, solutionWebApi } from './support/solution-web-api.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

// ---- An invented designer-shaped formula: Activity > Workflow > ConditionSequence > branches.
const NS =
  'xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:mcwc="clr-namespace:Microsoft.Crm.Workflow.ClientActivities;assembly=Microsoft.Crm.Workflow" xmlns:mxswa="clr-namespace:Microsoft.Xrm.Sdk.Workflow.Activities;assembly=Microsoft.Xrm.Sdk.Workflow" xmlns:sco="clr-namespace:System.Collections.ObjectModel;assembly=mscorlib" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"';
const activity = (kind, args, props = '') =>
  `<mxswa:ActivityReference AssemblyQualifiedName="Microsoft.Crm.Workflow.Activities.${kind}, Microsoft.Crm.Workflow" DisplayName="${kind}"><mxswa:ActivityReference.Arguments>${args}</mxswa:ActivityReference.Arguments>${props ? `<mxswa:ActivityReference.Properties>${props}</mxswa:ActivityReference.Properties>` : ''}</mxswa:ActivityReference>`;
const arg = (key, text) => `<InArgument x:Key="${key}">${text}</InArgument>`;
const out = (variable) => `<OutArgument x:Key="Result">[${variable}]</OutArgument>`;
const literal = (type, text, variable) =>
  activity(
    'EvaluateExpression',
    arg('ExpressionOperator', 'CreateCrmType') +
      arg(
        'Parameters',
        `[New Object() { Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.${type}, &quot;${text}&quot; }]`,
      ) +
      out(variable),
  );
const expression = (operator, parameters, variable) =>
  activity(
    'EvaluateExpression',
    arg('ExpressionOperator', operator) +
      arg('Parameters', `[New Object() { ${parameters.join(', ')} }]`) +
      out(variable),
  );
const get = (column, variable, entity = 'primaryEntity') =>
  `<mxswa:GetEntityProperty Attribute="${column}" Entity="[InputEntities(&quot;${entity}&quot;)]" EntityName="x_item" Value="[${variable}]" />`;
const set = (column, variable) =>
  '<Sequence DisplayName="SetAttributeValueStep">' +
  '<Assign To="[CreatedEntities(&quot;primaryEntity#Temp&quot;)]" Value="[New Entity(&quot;x_item&quot;)]" />' +
  '<Assign To="[CreatedEntities(&quot;primaryEntity#Temp&quot;).Id]" Value="[InputEntities(&quot;primaryEntity&quot;).Id]" />' +
  `<mxswa:SetEntityProperty Attribute="${column}" Entity="[CreatedEntities(&quot;primaryEntity#Temp&quot;)]" EntityName="x_item" Value="[${variable}]" />` +
  '<mcwc:SetAttributeValue Entity="[CreatedEntities(&quot;primaryEntity#Temp&quot;)]" EntityName="x_item" />' +
  '<Assign To="[InputEntities(&quot;primaryEntity&quot;)]" Value="[CreatedEntities(&quot;primaryEntity#Temp&quot;)]" />' +
  '</Sequence>';
const branch = (condition, body) =>
  activity(
    'ConditionBranch',
    arg('Condition', condition),
    `<mxswa:ActivityReference x:Key="Then" AssemblyQualifiedName="Microsoft.Crm.Workflow.Activities.Composite, Microsoft.Crm.Workflow"><mxswa:ActivityReference.Properties><sco:Collection x:Key="Activities">${body}</sco:Collection></mxswa:ActivityReference.Properties></mxswa:ActivityReference><x:Null x:Key="Else" />`,
  );
// One unconditional branch that computes `steps` and sets the column from `result`.
const formula = (column, steps, result, variables = []) =>
  `<Activity x:Class="XrmWorkflow00000000000000000000000000000000" ${NS}><mxswa:Workflow>` +
  activity(
    'ConditionSequence',
    arg('Wait', 'False'),
    `<sco:Collection x:Key="Variables"><Variable Default="False" Name="True" />${variables.map((name) => `<Variable Name="${name}" />`).join('')}</sco:Collection>` +
      `<sco:Collection x:Key="Activities">${branch('[True]', steps + set(column, result))}</sco:Collection>`,
  ) +
  '</mxswa:Workflow></Activity>';
const evaluate = (
  xaml,
  row,
  { column = 'x_value', related = () => null, now = Date.parse('2026-03-01T12:00:00Z') } = {},
) => {
  const { program, unsupported } = compileCalculatedXaml(xaml);
  assert.equal(unsupported, undefined);
  return runCalculatedXaml(program, { row, column, related, now: () => now });
};

// @test-kind observation: designer saves of summary-F6 DATA-04c2 (paqvilo-developer hosted-f6 runs dc2ka/dc2kb, the same start and end on row k1): DiffIn functions count UTC unit boundaries (675 hours, 5 Sunday-based weeks, 2 months), AddMonths clamps to the month end; Now stays a local model
test('the date, text and current-time functions', () => {
  const diff = (operator) =>
    formula('x_value', get('x_start', 'a') + get('x_end', 'b') + expression(operator, ['a', 'b'], 'r'), 'r');
  const row = { x_start: '2026-01-31T22:30:00Z', x_end: '2026-03-01T01:15:00Z' };
  assert.equal(evaluate(diff('DiffInMinutes'), row), 40_485);
  assert.equal(evaluate(diff('DiffInHours'), row), 675);
  assert.equal(evaluate(diff('DiffInWeeks'), row), 5);
  assert.equal(evaluate(diff('DiffInMonths'), row), 2);
  assert.equal(evaluate(diff('DiffInYears'), row), 0);
  const shift = (operator) =>
    formula(
      'x_value',
      literal('Integer', '1', 'n') +
        expression('SelectFirstNonNull', ['n'], 'w') +
        get('x_start', 'd') +
        expression(operator, ['w', 'd'], 'r'),
      'r',
    );
  assert.equal(evaluate(shift('AddMonths'), row), '2026-02-28T22:30:00.000Z');
  assert.equal(evaluate(shift('SubtractDays'), row), '2026-01-30T22:30:00.000Z');
  assert.equal(evaluate(shift('AddYears'), row), '2027-01-31T22:30:00.000Z');
  const now = formula('x_value', expression('Now', [], 'r'), 'r');
  assert.equal(evaluate(now, {}), '2026-03-01T12:00:00.000Z');
  assert.equal(compileCalculatedXaml(now).program.usesNow, true);
});

test('text conditions, Or and a related row read through the lookup named in the entity key', () => {
  const xaml =
    `<Activity x:Class="XrmWorkflow00000000000000000000000000000000" ${NS}><mxswa:Workflow>` +
    activity(
      'ConditionSequence',
      arg('Wait', 'False'),
      '<sco:Collection x:Key="Variables"><Variable Default="False" Name="c" /><Variable Default="False" Name="d" /><Variable Default="False" Name="e" /></sco:Collection>' +
        '<sco:Collection x:Key="Activities">' +
        get('x_name', 'n', 'related_x_parentid#x_parent') +
        literal('String', 'inv', 'p') +
        activity(
          'EvaluateCondition',
          arg('ConditionOperator', 'BeginsWith') +
            arg('Parameters', '[New Object() { p }]') +
            arg('Operand', '[n]') +
            out('c'),
        ) +
        activity(
          'EvaluateCondition',
          arg('ConditionOperator', 'Null') + '<x:Null x:Key="Parameters" />' + arg('Operand', '[n]') + out('d'),
        ) +
        activity(
          'EvaluateLogicalCondition',
          arg('LogicalOperator', 'Or') + arg('LeftOperand', '[c]') + arg('RightOperand', '[d]') + out('e'),
        ) +
        branch('[e]', set('x_value', 'n')) +
        '</sco:Collection>',
    ) +
    '</mxswa:Workflow></Activity>';
  const reads = [];
  const related = (lookup, table) => {
    reads.push([lookup, table]);
    return { x_name: 'Invented parent' };
  };
  assert.equal(evaluate(xaml, { x_parentid: { id: 'p' } }, { related }), 'Invented parent');
  assert.deepEqual(reads, [['x_parentid', 'x_parent']]);
  assert.equal(evaluate(xaml, {}, { related: () => ({ x_name: 'Other' }) }), null, 'no branch holds: null');
  assert.deepEqual(compileCalculatedXaml(xaml).program.reads, [
    { lookup: 'x_parentid', table: 'x_parent', column: 'x_name' },
  ]);
});

test('shapes outside the subset answer unsupported with the reason, never a guess', () => {
  const cases = [
    ['<Formula><Constant Value="1"/></Formula>', null],
    [formula('x_value', expression('TrimBoth', ['a', 'b'], 'r'), 'r'), /TrimBoth is outside the supported subset/],
    [formula('x_value', '<WriteLine Text="x" />', 'r'), /<WriteLine>, which is outside the supported subset/],
    [
      formula(
        'x_value',
        '<Assign To="[CreatedEntities(&quot;other&quot;)]" Value="[New Entity(&quot;x_item&quot;)]" />',
        'r',
      ),
      /assigns outside the designer forms/,
    ],
    [formula('x_value', get('x_amount', 'a', 'related_bad'), 'a'), /not a related entity/],
  ];
  for (const [xaml, reason] of cases) {
    if (reason === null) assert.equal(isCalculatedXaml(xaml), false);
    else assert.match(compileCalculatedXaml(xaml).unsupported, reason);
  }
  // A formula that sets another column is refused when it runs.
  const other = formula('x_other', get('x_amount', 'a'), 'a');
  assert.throws(() => evaluate(other, { x_amount: 1 }), /sets x_other, not x_value/);
});

// @test-kind security: untrusted FormulaDefinition XAML is read with the non-resolving reader and bounded in size, element count and nesting; nothing is evaluated as code.
test('formula XAML is bounded and never resolves declarations or evaluates expressions', () => {
  assert.match(
    compileCalculatedXaml(`<!DOCTYPE a [<!ENTITY e SYSTEM "file:///etc/passwd">]><Activity ${NS}/>`).unsupported,
    /external declarations are not supported/,
  );
  assert.match(
    compileCalculatedXaml(`<Activity ${NS}>${' '.repeat(1024 * 1024)}</Activity>`).unsupported,
    /longer than/,
  );
  assert.match(
    compileCalculatedXaml(
      `<Activity ${NS}><mxswa:Workflow>${'<Sequence>'.repeat(20)}${'<x:Null/>'.repeat(20_001)}${'</Sequence>'.repeat(20)}</mxswa:Workflow></Activity>`,
    ).unsupported,
    /more than 20000 elements/,
  );
  let nested = set('x_value', 'r');
  for (let depth = 0; depth < 80; depth += 1) nested = `<Sequence>${nested}</Sequence>`;
  assert.match(
    compileCalculatedXaml(`<Activity ${NS}><mxswa:Workflow>${nested}</mxswa:Workflow></Activity>`).unsupported,
    /nests deeper than 64/,
  );
  // A VB expression in a parameter list is not a literal form: refused, not run.
  const code = formula('x_value', expression('Concat', ['System.IO.File.Delete("x")'], 'r'), 'r');
  assert.match(compileCalculatedXaml(code).unsupported, /outside the supported literal forms|takes variables/);
});

// ---- Web API over an invented Solution

const EXPORTED = formula(
  'xy_value',
  get('xy_amount', 'a') +
    expression('SelectFirstNonNull', ['a'], 'b') +
    literal('Decimal', '2', 'l') +
    expression('SelectFirstNonNull', ['l'], 'm') +
    expression('Multiply', ['b', 'm'], 'r'),
  'r',
).replaceAll('><', '>\r\n  <');
const BARE = formula(
  'xy_value',
  get('xy_amount', 'a') + literal('Decimal', '2', 'l') + expression('Multiply', ['a', 'l'], 'r'),
  'r',
);

async function session(t, { relationships = [], tables = ['xy_item'] } = {}) {
  const files = {};
  for (const table of tables)
    files[`Entities/${table}/Entity.xml`] = entityXml({
      table,
      set: `${table}s`,
      name: 'xy_name',
      attributes: [
        ['xy_name', 'nvarchar'],
        ...(table === 'xy_item'
          ? [
              ['xy_amount', 'decimal', '<Accuracy>2</Accuracy>'],
              [
                'xy_value',
                'decimal',
                '<Accuracy>2</Accuracy><SourceType>1</SourceType><FormulaDefinitionFileName>/Formulas/xy_item-xy_value.xaml</FormulaDefinitionFileName>',
              ],
            ]
          : []),
        ...relationships.filter((r) => r.referencing === table).map((r) => [r.lookup, 'lookup']),
      ],
    });
  files['Entities/xy_item/Formulas/xy_item-xy_value.xaml'] = EXPORTED;
  if (relationships.length) files['Other/Relationships/relationships.xml'] = relationshipsXml(relationships);
  const api = await solutionWebApi(files);
  ownedFixture(t).add(() => api.close());
  return api;
}

// @test-kind observation: hosted import round trip 2026-11-26 (workbench hosted-f6 import-roundtrip-1795722792122.json, one run): after a Solution import every calculated and rollup FormulaDefinition equals its exported Formulas file byte for byte (CRLF, pretty-printed, no XML declaration); the invented file is typed here.
test('an exported calculated column serves its Formulas file unchanged as the FormulaDefinition', async (t) => {
  const { call } = await session(t);
  const read = await call(
    "EntityDefinitions(LogicalName='xy_item')/Attributes(LogicalName='xy_value')/Microsoft.Dynamics.CRM.DecimalAttributeMetadata?$select=FormulaDefinition,SourceType",
  );
  assert.equal(read.status, 200);
  assert.equal(read.body.FormulaDefinition, EXPORTED);
  assert.equal(read.body.SourceType, 1);
  const created = await call('xy_items', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: { xy_name: 'one', xy_amount: 2.34 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.xy_value, 4.68, 'the pretty-printed export evaluates as stored');
});

// @test-kind observation: hosted creates 2026-11-26 (workbench hosted-f6 derived-create-1795720540775.json and derived-create-1795720594806.json): a calculated definition whose Multiply, Subtract, Concat or AddDays reads a CreateCrmType literal directly was refused 400 0x80060424 "The <column> field has an invalid XAML formula definition."; the same formula with the literal wrapped in SelectFirstNonNull was accepted; the invented formula is typed here.
test('creating a calculated column refuses a bare literal operand and accepts the wrapped one', async (t) => {
  const { call } = await session(t);
  const body = (name, xaml) => ({
    '@odata.type': 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata',
    SchemaName: name,
    DisplayName: { LocalizedLabels: [{ Label: name, LanguageCode: 1033 }] },
    RequiredLevel: { Value: 'None' },
    Precision: 2,
    SourceType: 1,
    FormulaDefinition: xaml,
  });
  const refused = await call("EntityDefinitions(LogicalName='xy_item')/Attributes", {
    method: 'POST',
    body: body('xy_bare', BARE),
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, '0x80060424');
  assert.equal(refused.body.error.message, 'The xy_bare field has an invalid XAML formula definition.');
  const accepted = await call("EntityDefinitions(LogicalName='xy_item')/Attributes", {
    method: 'POST',
    body: body('xy_wrapped', EXPORTED),
  });
  assert.equal(accepted.status, 204);
  assert.equal(calculatedDefinitionError(EXPORTED), null);
});

const RELATIONSHIP = (schemaName, referenced, lookup, cascade) => ({
  schemaName,
  type: 'OneToMany',
  referencing: 'xy_item',
  referenced,
  lookup,
  cascade,
});
const PARENTAL = { Assign: 'Cascade', Delete: 'Cascade', Reparent: 'Cascade', Share: 'Cascade', Unshare: 'Cascade' };
const relationshipBody = (schemaName, referenced, lookup, cascade) => ({
  '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
  SchemaName: schemaName,
  ReferencedEntity: referenced,
  ReferencingEntity: 'xy_child',
  CascadeConfiguration: cascade,
  Lookup: {
    '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata',
    SchemaName: lookup,
    DisplayName: { LocalizedLabels: [{ Label: lookup, LanguageCode: 1033 }] },
  },
});

// Tables created through the metadata Web API (only those take new relationships there), the first parental to xy_parent.
async function metadataTables(t) {
  const { call } = await session(t);
  for (const schema of ['xy_parent', 'xy_tag', 'xy_child']) {
    const created = await call('EntityDefinitions', {
      method: 'POST',
      body: {
        '@odata.type': '#Microsoft.Dynamics.CRM.EntityMetadata',
        SchemaName: schema,
        DisplayName: { LocalizedLabels: [{ Label: schema, LanguageCode: 1033 }] },
        DisplayCollectionName: { LocalizedLabels: [{ Label: `${schema}s`, LanguageCode: 1033 }] },
        OwnershipType: 'UserOwned',
        IsActivity: false,
        HasActivities: false,
        HasNotes: false,
        Attributes: [
          {
            '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
            SchemaName: `${schema}name`,
            DisplayName: { LocalizedLabels: [{ Label: 'Name', LanguageCode: 1033 }] },
            IsPrimaryName: true,
            MaxLength: 100,
          },
        ],
      },
    });
    assert.equal(created.status, 204, JSON.stringify(created.body));
  }
  const first = await call('RelationshipDefinitions', {
    method: 'POST',
    body: relationshipBody('xy_parent_child', 'xy_parent', 'xy_parentid', PARENTAL),
  });
  assert.equal(first.status, 204, JSON.stringify(first.body));
  return call;
}

// @test-kind observation: hosted probe 2026-11-26 (workbench hosted-f6 probe-second-parental-1795720410415.json, one run): a second Delete-Cascade relationship on a table that already has a parental one answered 400 0x80047007 "Entity: <child> is parented to Entity with id: <parent MetadataId> and name <parent>. Cannot create another parental relation with Entity: <new parent>"; the invented tables are typed here.
test('a second parental relationship is refused with the platform text naming the existing parent', async (t) => {
  const call = await metadataTables(t);
  const parent = await call("EntityDefinitions(LogicalName='xy_parent')?$select=MetadataId");
  const refused = await call('RelationshipDefinitions', {
    method: 'POST',
    body: relationshipBody('xy_tag_child', 'xy_tag', 'xy_tagid', PARENTAL),
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, '0x80047007');
  assert.equal(
    refused.body.error.message,
    `Entity: xy_child is parented to Entity with id: ${parent.body.MetadataId} and name xy_parent. Cannot create another parental relation with Entity: xy_tag`,
  );
});

// @test-kind compatibility: Learn "Microsoft Dataverse table relationships" (Parental table relationships): a further relationship from the same table is allowed with the Not Parental options (Cascade None, RemoveLink or Restrict).
test('a second, referential relationship from a parented table is accepted', async (t) => {
  const call = await metadataTables(t);
  const referential = await call('RelationshipDefinitions', {
    method: 'POST',
    body: relationshipBody('xy_tag_child', 'xy_tag', 'xy_tagid', { Assign: 'NoCascade', Delete: 'RemoveLink' }),
  });
  assert.equal(referential.status, 204, JSON.stringify(referential.body));
});

// @test-kind compatibility: Learn "Microsoft Dataverse table relationships" (Parental table relationships): a relationship is parental when any one of its actions is in the Parental column (Delete: Cascade All), and no new relationship may have such an action while its related table already has a parental relationship.
test('a second relationship whose only cascading action is Delete is parental and refused', async (t) => {
  const call = await metadataTables(t);
  const refused = await call('RelationshipDefinitions', {
    method: 'POST',
    body: relationshipBody('xy_tag_child', 'xy_tag', 'xy_tagid', {
      Assign: 'NoCascade',
      Delete: 'Cascade',
      Reparent: 'NoCascade',
      Share: 'NoCascade',
      Unshare: 'NoCascade',
    }),
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, '0x80047007');
});

// An out-of-range stored amount in AddDays(amount, date), on a whole-number column any writer of the table can set.
const SHIFT = formula('xy_due', get('xy_n', 'n') + get('xy_when', 'd') + expression('AddDays', ['n', 'd'], 'r'), 'r');

// @test-kind unproven: Dataverse dates lie in 1753-01-01 to 9999-12-31 (Learn "Date and time column behavior and format"); a date function whose result falls outside that range is assumed to read null, the platform's answer is uncaptured.
test('a date function result outside the Dataverse date range reads null', () => {
  const at = { xy_when: '2026-01-01T00:00:00Z' };
  const run = (n, operator = 'AddDays') =>
    evaluate(
      formula('xy_due', get('xy_n', 'n') + get('xy_when', 'd') + expression(operator, ['n', 'd'], 'r'), 'r'),
      { ...at, xy_n: n },
      { column: 'xy_due' },
    );
  assert.equal(run(2_147_483_647), null);
  assert.equal(run(-2_147_483_647), null);
  assert.equal(run(2_147_483_647, 'AddMonths'), null);
  assert.equal(run(9_000_000, 'AddYears'), null);
  assert.equal(run(2_912_443), null, 'past 9999-12-31');
  assert.equal(run(1), '2026-01-02T00:00:00.000Z');
  assert.equal(run(2_912_442), '9999-12-31T00:00:00.000Z', 'the last day in range');
});

// @test-kind security: a value one caller stores in an ordinary column cannot make the calculated column fail the create or any read of the table; the failure stays in that column of that row and is reported.
test('an out-of-range stored value never fails a read of the table', async (t) => {
  const api = await solutionWebApi({
    'Entities/xy_item/Entity.xml': entityXml({
      table: 'xy_item',
      set: 'xy_items',
      name: 'xy_name',
      attributes: [
        ['xy_name', 'nvarchar'],
        ['xy_n', 'int'],
        ['xy_when', 'datetime'],
        [
          'xy_due',
          'datetime',
          '<SourceType>1</SourceType><FormulaDefinitionFileName>/Formulas/xy_item-xy_due.xaml</FormulaDefinitionFileName>',
        ],
      ],
    }),
    'Entities/xy_item/Formulas/xy_item-xy_due.xaml': SHIFT,
  });
  ownedFixture(t).add(() => api.close());
  for (const [name, n] of [
    ['ordinary', 1],
    ['hostile', 2_147_483_647],
  ]) {
    const created = await api.call('xy_items', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: { xy_name: name, xy_n: n, xy_when: '2026-01-01T00:00:00Z' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
  const list = await api.call('xy_items?$select=xy_name,xy_due&$orderby=xy_name');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(
    list.body.value.map((row) => [row.xy_name, row.xy_due]),
    [
      ['hostile', null],
      ['ordinary', '2026-01-02T00:00:00Z'],
    ],
  );
  const filtered = await api.call('xy_items?$select=xy_name&$filter=xy_due ne null');
  assert.equal(filtered.status, 200);
  assert.deepEqual(
    filtered.body.value.map((row) => row.xy_name),
    ['ordinary'],
  );
});

// @test-kind observation: hosted export and metadata read 2026-11-26 (workbench hosted-f6 exports/export-1 customizations.xml and metadata-run1-1795721153437.json): a relationship created with Assign "Active" exports <CascadeAssign>ActiveOnly</CascadeAssign> and the metadata Web API answers CascadeConfiguration.Assign "Active".
test('an exported ActiveOnly cascade reads as Active', async (t) => {
  const { call } = await session(t, {
    tables: ['xy_item', 'xy_parent'],
    relationships: [
      RELATIONSHIP('xy_parent_item', 'xy_parent', 'xy_parentid', {
        Assign: 'ActiveOnly',
        Delete: 'RemoveLink',
        Share: 'UserOwned',
      }),
    ],
  });
  const read = await call(
    "RelationshipDefinitions(SchemaName='xy_parent_item')/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=CascadeConfiguration",
  );
  assert.equal(read.status, 200);
  assert.equal(read.body.CascadeConfiguration.Assign, 'Active');
  assert.equal(read.body.CascadeConfiguration.Share, 'UserOwned');
});
