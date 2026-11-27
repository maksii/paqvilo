// @test-kind unproven: local model of interpreted classic workflow designer XAML (real-time and background); no hosted capture of a classic workflow run exists yet
// Classic workflow XAML in the Mirage runtime: the supported subset of designer steps runs through the records pipeline,
// in the run's transaction, under the depth limit; a trusted pack handler still wins; XAML outside the subset keeps the
// placeholder with WORKFLOW_XAML_UNSUPPORTED; and the parser bounds untrusted XAML. Schemas, names and ids are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { classicWorkflowReadiness, workflowExtension, workflowHandlers } from '../lib/dataverse-workflows.mjs';
import { buildPreflightReport } from '../lib/capability-report.mjs';
import { parseClassicWorkflow, runClassicWorkflow } from '../lib/classic-workflow-xaml.mjs';
// The documented local bounds of lib/classic-workflow-xaml.mjs: text length, element count, activity nesting.
const XAML_LIMITS = { length: 1024 * 1024, elements: 20_000, depth: 64 };
import { committedJobs, settleCommittedWork } from '../lib/committed-work.mjs';
import { createScheduler, fixedClock, storeScheduler } from '../lib/runtime-clock.mjs';
import { startAdminApi } from './support/web-api.mjs';
import { createApplicationUser, uuidV5 } from '../lib/dataverse-security.mjs';

const WIDGET = '6c000000-0000-4000-8000-000000000001';
const PARENT = '6c000000-0000-4000-8000-000000000002';
const WF = (n) => `6c000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

// ---- Designer XAML in the exported shape (Activity root, mxswa:Workflow, ActivityReference steps)

const AQN = (name) =>
  `Microsoft.Crm.Workflow.Activities.${name}, Microsoft.Crm.Workflow, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35`;
const q = (text) => text.replaceAll('"', '&quot;');
const PRIMARY = q('[InputEntities("primaryEntity")]');
const created = (key) => q(`[CreatedEntities("${key}")]`);
const NAMESPACES = [
  'xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"',
  'xmlns:mva="clr-namespace:Microsoft.VisualBasic.Activities;assembly=System.Activities"',
  'xmlns:mxs="clr-namespace:Microsoft.Xrm.Sdk;assembly=Microsoft.Xrm.Sdk"',
  'xmlns:mxsq="clr-namespace:Microsoft.Xrm.Sdk.Query;assembly=Microsoft.Xrm.Sdk"',
  'xmlns:mxswa="clr-namespace:Microsoft.Xrm.Sdk.Workflow.Activities;assembly=Microsoft.Xrm.Sdk.Workflow"',
  'xmlns:s="clr-namespace:System;assembly=mscorlib"',
  'xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib"',
  'xmlns:sco="clr-namespace:System.Collections.ObjectModel;assembly=mscorlib"',
  'xmlns:this="clr-namespace:"',
  'xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"',
].join(' ');
const workflowXaml = (...steps) => `<Activity x:Class="XrmWorkflowInvented" ${NAMESPACES}>
  <x:Members>
    <x:Property Name="InputEntities" Type="InArgument(scg:IDictionary(x:String, mxs:Entity))" />
    <x:Property Name="CreatedEntities" Type="InArgument(scg:IDictionary(x:String, mxs:Entity))" />
  </x:Members>
  <this:XrmWorkflowInvented.InputEntities><InArgument x:TypeArguments="scg:IDictionary(x:String, mxs:Entity)" /></this:XrmWorkflowInvented.InputEntities>
  <mva:VisualBasic.Settings>Assembly references and imported namespaces for internal implementation</mva:VisualBasic.Settings>
  <mxswa:Workflow>${steps.join('\n')}</mxswa:Workflow>
</Activity>`;
const literal = (
  type,
  values,
  result,
) => `<mxswa:ActivityReference AssemblyQualifiedName="${AQN('EvaluateExpression')}" DisplayName="EvaluateExpression">
  <mxswa:ActivityReference.Arguments>
    <InArgument x:TypeArguments="x:String" x:Key="ExpressionOperator">CreateCrmType</InArgument>
    <InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.${type}${values.map((value) => `, ${q(`"${value}"`)}`).join('')} }]</InArgument>
    <InArgument x:TypeArguments="s:Type" x:Key="TargetType"><mxswa:ReferenceLiteral x:TypeArguments="s:Type" Value="x:Object" /></InArgument>
    <OutArgument x:TypeArguments="x:Object" x:Key="Result">[${result}]</OutArgument>
  </mxswa:ActivityReference.Arguments>
</mxswa:ActivityReference>`;
const firstNonNull = (
  source,
  result,
) => `<mxswa:ActivityReference AssemblyQualifiedName="${AQN('EvaluateExpression')}" DisplayName="EvaluateExpression">
  <mxswa:ActivityReference.Arguments>
    <InArgument x:TypeArguments="x:String" x:Key="ExpressionOperator">SelectFirstNonNull</InArgument>
    <InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { ${source} }]</InArgument>
    <InArgument x:TypeArguments="s:Type" x:Key="TargetType"><mxswa:ReferenceLiteral x:TypeArguments="s:Type" Value="x:String" /></InArgument>
    <OutArgument x:TypeArguments="x:Object" x:Key="Result">[${result}]</OutArgument>
  </mxswa:ActivityReference.Arguments>
</mxswa:ActivityReference>`;
const getProperty = (
  entity,
  table,
  attribute,
  result,
  type = null,
) => `<mxswa:GetEntityProperty Attribute="${attribute}" Entity="${entity}" EntityName="${table}" Value="[${result}]">
  <mxswa:GetEntityProperty.TargetType><InArgument x:TypeArguments="s:Type">${
    type
      ? `<mxswa:ReferenceLiteral x:TypeArguments="s:Type" Value="${type}" />`
      : '<mxswa:ReferenceLiteral x:TypeArguments="s:Type"><x:Null /></mxswa:ReferenceLiteral>'
  }</InArgument></mxswa:GetEntityProperty.TargetType>
</mxswa:GetEntityProperty>`;
const condition = (
  operator,
  operand,
  parameters,
  result,
) => `<mxswa:ActivityReference AssemblyQualifiedName="${AQN('EvaluateCondition')}" DisplayName="EvaluateCondition">
  <mxswa:ActivityReference.Arguments>
    <InArgument x:TypeArguments="mxsq:ConditionOperator" x:Key="ConditionOperator">${operator}</InArgument>
    ${parameters.length ? `<InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { ${parameters.join(', ')} }]</InArgument>` : '<x:Null x:Key="Parameters" />'}
    <InArgument x:TypeArguments="x:Object" x:Key="Operand">[${operand}]</InArgument>
    <OutArgument x:TypeArguments="x:Boolean" x:Key="Result">[${result}]</OutArgument>
  </mxswa:ActivityReference.Arguments>
</mxswa:ActivityReference>`;
const logical = (
  operator,
  left,
  right,
  result,
) => `<mxswa:ActivityReference AssemblyQualifiedName="${AQN('EvaluateLogicalCondition')}" DisplayName="EvaluateLogicalCondition">
  <mxswa:ActivityReference.Arguments>
    <InArgument x:TypeArguments="mxsq:LogicalOperator" x:Key="LogicalOperator">${operator}</InArgument>
    <InArgument x:TypeArguments="x:Boolean" x:Key="LeftOperand">[${left}]</InArgument>
    <InArgument x:TypeArguments="x:Boolean" x:Key="RightOperand">[${right}]</InArgument>
    <OutArgument x:TypeArguments="x:Boolean" x:Key="Result">[${result}]</OutArgument>
  </mxswa:ActivityReference.Arguments>
</mxswa:ActivityReference>`;
const composite = (
  key,
  steps,
) => `<mxswa:ActivityReference x:Key="${key}" AssemblyQualifiedName="${AQN('Composite')}" DisplayName="${key}">
  <mxswa:ActivityReference.Properties>
    <sco:Collection x:TypeArguments="Variable" x:Key="Variables" />
    <sco:Collection x:TypeArguments="Activity" x:Key="Activities">${steps.join('\n')}</sco:Collection>
  </mxswa:ActivityReference.Properties>
</mxswa:ActivityReference>`;
const branch = (
  test,
  thenSteps,
  elseSteps = null,
) => `<mxswa:ActivityReference AssemblyQualifiedName="${AQN('ConditionBranch')}" DisplayName="ConditionBranchStep">
  <mxswa:ActivityReference.Arguments><InArgument x:TypeArguments="x:Boolean" x:Key="Condition">[${test}]</InArgument></mxswa:ActivityReference.Arguments>
  <mxswa:ActivityReference.Properties>
    ${composite('Then', thenSteps)}
    ${elseSteps ? composite('Else', elseSteps) : '<x:Null x:Key="Else" />'}
    <x:String x:Key="Description">Invented branch</x:String>
  </mxswa:ActivityReference.Properties>
</mxswa:ActivityReference>`;
const conditionSequence = (
  variables,
  steps,
  wait = 'False',
) => `<mxswa:ActivityReference AssemblyQualifiedName="${AQN('ConditionSequence')}" DisplayName="${wait === 'True' ? 'WaitStep' : 'ConditionStep'}">
  <mxswa:ActivityReference.Arguments><InArgument x:TypeArguments="x:Boolean" x:Key="Wait">${wait}</InArgument></mxswa:ActivityReference.Arguments>
  <mxswa:ActivityReference.Properties>
    <sco:Collection x:TypeArguments="Variable" x:Key="Variables">${variables
      .map((name) => `<Variable x:TypeArguments="x:Object" Name="${name}" />`)
      .join('')}</sco:Collection>
    <sco:Collection x:TypeArguments="Activity" x:Key="Activities">${steps.join('\n')}</sco:Collection>
    <x:Boolean x:Key="ContainsElseBranch">False</x:Boolean>
  </mxswa:ActivityReference.Properties>
</mxswa:ActivityReference>`;
// One value of a Set Properties dialog: a literal ({ type, value }) or a value read from an entity ({ read: [entity, table, column, type] }).
const valueSteps = (name, value, index) => {
  const variable = `${name}_${index}`;
  if (value.read)
    return [
      getProperty(...value.read.slice(0, 3), `${variable}_read`, value.read[3]),
      firstNonNull(`${variable}_read`, variable),
    ];
  return [literal(value.type, value.value === null ? [] : [value.value], variable)];
};
const setSteps = (name, key, table, values) =>
  Object.entries(values).flatMap(([column, value], index) => [
    ...valueSteps(name, value, index),
    `<mxswa:SetEntityProperty Attribute="${column}" Entity="${created(key)}" EntityName="${table}" Value="[${name}_${index}]" />`,
  ]);
// Update the primary row (UpdateStep): a temp entity with the primary id, its values, UpdateEntity, the primary entity refreshed.
const updatePrimary = (table, values, name = 'UpdateStep1') => `<Sequence DisplayName="${name}">
  <Assign x:TypeArguments="mxs:Entity" To="${created('primaryEntity#Temp')}" Value="${q(`[New Entity("${table}")]`)}" />
  <Assign x:TypeArguments="s:Guid" To="${q('[CreatedEntities("primaryEntity#Temp").Id]')}" Value="${q('[InputEntities("primaryEntity").Id]')}" />
  ${setSteps(name, 'primaryEntity#Temp', table, values).join('\n')}
  <mxswa:UpdateEntity DisplayName="${name}" Entity="${created('primaryEntity#Temp')}" EntityName="${table}" />
  <Assign x:TypeArguments="mxs:Entity" To="${PRIMARY}" Value="${created('primaryEntity#Temp')}" />
  <Persist />
</Sequence>`;
// Create a row (CreateStep).
const createRow = (table, values, name = 'CreateStep1') => `<Sequence DisplayName="${name}">
  <Assign x:TypeArguments="mxs:Entity" To="${created(`${name}_localParameter#Temp`)}" Value="${q(`[New Entity("${table}")]`)}" />
  ${setSteps(name, `${name}_localParameter#Temp`, table, values).join('\n')}
  <mxswa:CreateEntity EntityId="{x:Null}" DisplayName="${name}" Entity="${created(`${name}_localParameter#Temp`)}" EntityName="${table}" />
  <Assign x:TypeArguments="mxs:Entity" To="${created(`${name}_localParameter`)}" Value="${created(`${name}_localParameter#Temp`)}" />
  <Persist />
</Sequence>`;
const stopWorkflow = (status, message) => `<Sequence DisplayName="StopWorkflowStep1">
  ${literal('String', [message, 'String'], 'StopWorkflowStep1_1')}
  <mxswa:ActivityReference AssemblyQualifiedName="${AQN('ConvertCrmXrmTypes')}" DisplayName="ConvertCrmXrmTypes">
    <mxswa:ActivityReference.Arguments>
      <InArgument x:TypeArguments="x:Object" x:Key="Value">[StopWorkflowStep1_1]</InArgument>
      <InArgument x:TypeArguments="s:Type" x:Key="TargetType"><mxswa:ReferenceLiteral x:TypeArguments="s:Type" Value="x:String" /></InArgument>
      <OutArgument x:TypeArguments="x:Object" x:Key="Result">[StopWorkflowStep1_2]</OutArgument>
    </mxswa:ActivityReference.Arguments>
  </mxswa:ActivityReference>
  <TerminateWorkflow DisplayName="StopWorkflowStep1" Exception="[New Microsoft.Xrm.Sdk.InvalidPluginExecutionException(Microsoft.Xrm.Sdk.OperationStatus.${status}, StopWorkflowStep1_2)]" Reason="[StopWorkflowStep1_2]" />
</Sequence>`;
const optionSet = (value) =>
  `<InArgument x:TypeArguments="mxs:OptionSetValue"><mxswa:ReferenceLiteral x:TypeArguments="mxs:OptionSetValue"><mxs:OptionSetValue ExtensionData="{x:Null}" Value="${value}" /></mxswa:ReferenceLiteral></InArgument>`;
const setState = (
  table,
  state,
  status,
) => `<mxswa:SetState DisplayName="SetStateStep1" Entity="${PRIMARY}" EntityId="${q('[InputEntities("primaryEntity").Id]')}" EntityName="${table}">
  <mxswa:SetState.State>${optionSet(state)}</mxswa:SetState.State>
  <mxswa:SetState.Status>${optionSet(status)}</mxswa:SetState.Status>
</mxswa:SetState>`;

// ---- Fixture: an invented schema, the Web API as a System Administrator application, and the workflow extension

function fact(id, xaml, overrides = {}) {
  return {
    id,
    name: `Invented ${id.slice(-2)}`,
    uniquename: null,
    category: 0,
    type: 1,
    mode: 0,
    scope: 4,
    ondemand: false,
    subprocess: false,
    triggeroncreate: false,
    triggerondelete: false,
    triggeronupdateattributelist: null,
    primaryentity: 'x_widget',
    state: 1,
    runas: 1,
    istransacted: true,
    asyncautodelete: false,
    syncworkflowlogonfailure: false,
    xaml,
    clientdata: null,
    ...overrides,
  };
}

function schema() {
  const state = emptyState();
  const text = { dataverseType: 'nvarchar' };
  const int = { dataverseType: 'int' };
  state.mappings.x_parent = {
    logicalName: 'x_parent',
    entitySet: 'x_parents',
    idColumn: 'x_parentid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: { x_name: text },
    relationships: {},
  };
  state.mappings.x_widget = {
    logicalName: 'x_widget',
    entitySet: 'x_widgets',
    idColumn: 'x_widgetid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: {
      x_name: text,
      x_status: int,
      x_count: int,
      // Only the tests change it: a wait test's own steps never retrigger its workflow.
      x_trigger: int,
      x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] },
      statecode: int,
      statuscode: int,
    },
    relationships: {},
  };
  state.mappings.x_note = {
    logicalName: 'x_note',
    entitySet: 'x_notes',
    idColumn: 'x_noteid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: { x_name: text, x_widgetid: { dataverseType: 'lookup', targets: ['x_widget'] } },
    relationships: {},
  };
  state.tables.x_parent = [{ x_parentid: PARENT, x_name: 'Invented parent' }];
  state.tables.x_widget = [
    { x_widgetid: WIDGET, x_name: 'alpha', x_status: 0, x_count: 0, statecode: 0, statuscode: 1 },
  ];
  state.tables.x_note = [];
  return state;
}

async function fixture(t, facts, { handlers = new Map(), clock = null } = {}) {
  const store = await new DataStore({ state: schema(), ...(clock ? { clock } : {}) }).init();
  // A controlled clock runs the store's jobs on a manual scheduler: timers fire only when the test advances it.
  const scheduler = clock ? storeScheduler(store, createScheduler({ clock, manual: true })) : null;
  if (scheduler) t.after(() => scheduler.close());
  const diagnostics = [];
  const { request } = await startAdminApi(t, store, {
    extensions: [...EXTENSIONS, workflowExtension({ facts, handlers, diagnostic: (entry) => diagnostics.push(entry) })],
  });
  const widget = () => store.tableRows('x_widget').find((row) => row.x_widgetid === WIDGET);
  const jobs = (id) =>
    store
      .tableRows('asyncoperation')
      .filter((row) => row.name === `Invented ${id.slice(-2)}` && row.operationtype === 10);
  const logs = () => store.tableRows('workflowlog');
  // With a manual scheduler, due tasks (the committed-job ticks) run only when the test runs them.
  const settle = async () => {
    for (let round = 0; round < 20; round += 1) {
      await scheduler?.runDue();
      await settleCommittedWork(store, []);
      if (!scheduler || !scheduler.status().pending) return;
    }
  };
  return { store, request, diagnostics, widget, jobs, logs, scheduler, settle };
}

// ---- Execution

// @test-kind observation: hosted session F6, summary-F6 OPS-01d (runs A and B agree): a real-time workflow updates the primary row within the request and a successful real-time run leaves no workflowlog row
test('a real-time workflow on create sets a column of the new row inside the request', async (t) => {
  const xaml = workflowXaml(updatePrimary('x_widget', { x_status: { type: 'Integer', value: '5' } }));
  const { store, request, logs } = await fixture(t, [fact(WF(1), xaml, { mode: 1, triggeroncreate: true })]);
  const response = await request('POST', '/x_widgets', { x_name: 'created' }, { prefer: 'return=representation' });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  assert.equal(response.json.x_status, 5, 'the response already carries the workflow write');
  const row = store.tableRows('x_widget').find((item) => item.x_name === 'created');
  assert.equal(row.x_status, 5);
  assert.deepEqual(
    logs().filter((item) => item.regardingobjectid?.id === row.x_widgetid),
    [],
    'a successful real-time run leaves no workflowlog row',
  );
});

test('a background workflow on update creates a related row from primary and N:1 values; the job succeeds with a log', async (t) => {
  const xaml = workflowXaml(
    createRow('x_note', {
      x_widgetid: { read: [PRIMARY, 'x_widget', 'x_widgetid', 'mxs:EntityReference'] },
      x_name: { read: [q('[InputEntities("related_x_parentid#x_parent")]'), 'x_parent', 'x_name'] },
    }),
  );
  const { store, request, jobs, logs, settle } = await fixture(t, [
    fact(WF(2), xaml, { triggeronupdateattributelist: 'x_parentid' }),
  ]);
  const patched = await request('PATCH', `/x_widgets(${WIDGET})`, { 'x_parentid@odata.bind': `/x_parents(${PARENT})` });
  assert.equal(patched.status, 204, JSON.stringify(patched.json));
  await settle();
  const [job] = jobs(WF(2));
  assert.deepEqual([job.statecode, job.statuscode], [3, 30], job.message);
  const notes = store.tableRows('x_note');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].x_name, 'Invented parent');
  assert.equal(notes[0].x_widgetid?.id, WIDGET);
  const linked = logs().filter((item) => item.asyncoperationid?.id === job.asyncoperationid);
  assert.deepEqual(
    linked.map((item) => item.status),
    [2],
  );
});

test('a condition sequence runs its else-branch and its default branch when the conditions do not hold', async (t) => {
  const xaml = workflowXaml(
    conditionSequence(
      ['C_count', 'C_ten', 'C_big', 'C_name', 'C_alpha', 'C_isAlpha', 'C_both'],
      [
        getProperty(PRIMARY, 'x_widget', 'x_count', 'C_count'),
        literal('Integer', ['10'], 'C_ten'),
        condition('GreaterThan', 'C_count', ['C_ten'], 'C_big'),
        getProperty(PRIMARY, 'x_widget', 'x_name', 'C_name'),
        literal('String', ['ALPHA', 'String'], 'C_alpha'),
        condition('Equal', 'C_name', ['C_alpha'], 'C_isAlpha'),
        logical('And', 'C_big', 'C_isAlpha', 'C_both'),
        // Then: status 1; Else of the same branch: status 2.
        branch(
          'C_both',
          [updatePrimary('x_widget', { x_status: { type: 'Integer', value: '1' } })],
          [updatePrimary('x_widget', { x_status: { type: 'Integer', value: '2' } }, 'UpdateStep2')],
        ),
        // A default branch after a branch that ran is skipped.
        branch('True', [updatePrimary('x_widget', { x_name: { type: 'String', value: 'default' } }, 'UpdateStep3')]),
      ],
    ),
  );
  const { request, widget } = await fixture(t, [
    fact(WF(3), xaml, { mode: 1, triggeronupdateattributelist: 'x_count' }),
  ]);
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_count: 3 })).status, 204);
  assert.deepEqual([widget().x_status, widget().x_name], [2, 'alpha'], 'the else-branch ran; the default was skipped');
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_count: 20 })).status, 204);
  assert.deepEqual(
    [widget().x_status, widget().x_name],
    [1, 'alpha'],
    'string Equal compares without case; the Then branch ran',
  );
});

test('a condition sequence whose branches all fail runs its default branch', async (t) => {
  const xaml = workflowXaml(
    conditionSequence(
      ['D_name'],
      [
        getProperty(PRIMARY, 'x_widget', 'x_name', 'D_name'),
        condition('Null', 'D_name', [], 'D_empty'),
        branch('D_empty', [updatePrimary('x_widget', { x_status: { type: 'Integer', value: '7' } })]),
        branch('True', [updatePrimary('x_widget', { x_status: { type: 'Integer', value: '8' } }, 'UpdateStep2')]),
      ],
    ),
  );
  const { request, widget } = await fixture(t, [
    fact(WF(4), xaml, { mode: 1, triggeronupdateattributelist: 'x_count' }),
  ]);
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_count: 1 })).status, 204);
  assert.equal(widget().x_status, 8);
});

test('Stop workflow Canceled in a real-time run refuses the write with its message and rolls the run back', async (t) => {
  const xaml = workflowXaml(
    updatePrimary('x_widget', { x_status: { type: 'Integer', value: '9' } }),
    conditionSequence(
      ['S_name', 'S_blocked', 'S_match'],
      [
        getProperty(PRIMARY, 'x_widget', 'x_name', 'S_name'),
        literal('String', ['blocked', 'String'], 'S_blocked'),
        condition('BeginsWith', 'S_name', ['S_blocked'], 'S_match'),
        branch('S_match', [stopWorkflow('Canceled', 'Invented: a blocked name is refused.')]),
      ],
    ),
  );
  const { request, widget, store } = await fixture(t, [
    fact(WF(5), xaml, { mode: 1, triggeronupdateattributelist: 'x_name' }),
  ]);
  const refused = await request('PATCH', `/x_widgets(${WIDGET})`, { x_name: 'blocked widget' });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.message, 'Invented: a blocked name is refused.');
  assert.equal(refused.json.error.code, '0x80040265');
  assert.deepEqual([widget().x_name, widget().x_status], ['alpha', 0], 'the write and the earlier step rolled back');
  assert.equal(store.tableRows('workflowlog').length, 0);
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_name: 'allowed' })).status, 204);
  assert.deepEqual([widget().x_name, widget().x_status], ['allowed', 9]);
});

// @test-kind observation: hosted session F6, summary-F6 OPS-01d (runs A and B agree): background Stop Canceled ends the job 3/32 and Stop Succeeded 3/30, both without a message; the earlier steps' writes stay; a Stop is logged with status 2
test('Stop workflow in a background run: Canceled keeps earlier writes and ends the job Canceled; Succeeded skips the rest', async (t) => {
  const canceledXaml = workflowXaml(
    updatePrimary('x_widget', { x_status: { type: 'Integer', value: '3' } }),
    stopWorkflow('Canceled', 'Invented: stopped as canceled.'),
    updatePrimary('x_widget', { x_status: { type: 'Integer', value: '4' } }, 'UpdateStep2'),
  );
  const succeededXaml = workflowXaml(
    stopWorkflow('Succeeded', 'Invented: stopped as succeeded.'),
    updatePrimary('x_widget', { x_name: { type: 'String', value: 'never' } }),
  );
  const { request, widget, jobs, logs, settle } = await fixture(t, [
    fact(WF(6), canceledXaml, { triggeronupdateattributelist: 'x_count' }),
    fact(WF(7), succeededXaml, { triggeronupdateattributelist: 'x_count' }),
  ]);
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_count: 1 })).status, 204);
  await settle();
  const [canceledJob] = jobs(WF(6));
  assert.deepEqual([canceledJob.statecode, canceledJob.statuscode, canceledJob.message], [3, 32, null]);
  assert.equal(widget().x_status, 3, 'the step before Stop committed; the step after it did not run');
  const [succeededJob] = jobs(WF(7));
  assert.deepEqual([succeededJob.statuscode, succeededJob.message], [30, null]);
  assert.equal(widget().x_name, 'alpha');
  const statusOf = (job) =>
    logs()
      .filter((item) => item.asyncoperationid?.id === job.asyncoperationid)
      .map((item) => [item.stepname, item.activityname, item.status]);
  assert.deepEqual(
    statusOf(canceledJob),
    [
      ['Step_1', 'UpdateStep1_step', 2],
      ['Step_1', 'StopWorkflowStep1_step', 2],
    ],
    'one row per executed step; the Stop is logged completed',
  );
  assert.deepEqual(statusOf(succeededJob), [['Step_1', 'StopWorkflowStep1_step', 2]]);
});

test('SetState changes the primary row status in a background run', async (t) => {
  const { request, widget, jobs, settle } = await fixture(t, [
    fact(WF(8), workflowXaml(setState('x_widget', 1, 2)), { triggeronupdateattributelist: 'x_count' }),
  ]);
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_count: 2 })).status, 204);
  await settle();
  assert.equal(jobs(WF(8))[0].statuscode, 30);
  assert.deepEqual([widget().statecode, widget().statuscode], [1, 2]);
});

test('XAML outside the subset keeps the placeholder and reports WORKFLOW_XAML_UNSUPPORTED naming the step', async (t) => {
  const postponed = workflowXaml(
    `<mxswa:Postpone BlockExecution="True" PostponeUntil="[DateTime.UtcNow.AddDays(1)]" />`,
    updatePrimary('x_widget', { x_status: { type: 'Integer', value: '6' } }),
  );
  const child = workflowXaml(
    `<mxswa:ActivityReference AssemblyQualifiedName="${AQN('StartChildWorkflow')}" DisplayName="ChildStep1" />`,
  );
  const { request, widget, jobs, diagnostics, settle } = await fixture(t, [
    fact(WF(9), postponed, { triggeronupdateattributelist: 'x_count' }),
    fact(WF(10), child, { mode: 1, triggeronupdateattributelist: 'x_count' }),
  ]);
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_count: 5 })).status, 204);
  await settle();
  const [job] = jobs(WF(9));
  assert.equal(job.statuscode, 32);
  assert.match(job.message, /classic workflow XAML is not executed/);
  assert.equal(widget().x_status, 0, 'no step of an unsupported definition runs');
  const reported = (id) => diagnostics.filter((entry) => entry.workflowId === id).map((entry) => entry.code);
  assert.deepEqual(reported(WF(9)), ['WORKFLOW_XAML_UNSUPPORTED', 'WORKFLOW_PLACEHOLDER']);
  assert.deepEqual(reported(WF(10)), ['WORKFLOW_XAML_UNSUPPORTED', 'WORKFLOW_PLACEHOLDER']);
  const message = (id) => diagnostics.find((entry) => entry.workflowId === id && entry.message)?.message;
  assert.match(message(WF(9)), /Postpone PostponeUntil/);
  assert.match(message(WF(10)), /Microsoft\.Crm\.Workflow\.Activities\.StartChildWorkflow/);
});

test('a self-triggering workflow stops at the depth limit: real-time refuses the write, background cancels the 17th job', async (t) => {
  const bump = workflowXaml(updatePrimary('x_widget', { x_count: { type: 'Integer', value: '1' } }));
  const realtime = await fixture(t, [fact(WF(11), bump, { mode: 1, triggeronupdateattributelist: 'x_count' })]);
  const refused = await realtime.request('PATCH', `/x_widgets(${WIDGET})`, { x_count: 2 });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, '0x80044182');
  assert.equal(realtime.widget().x_count, 0, 'the whole chain rolled back');

  const background = await fixture(t, [fact(WF(12), bump, { triggeronupdateattributelist: 'x_count' })]);
  assert.equal((await background.request('PATCH', `/x_widgets(${WIDGET})`, { x_count: 2 })).status, 204);
  for (let round = 0; round < 40 && background.jobs(WF(12)).some((job) => job.statecode !== 3); round += 1)
    await background.settle();
  const statuses = background.jobs(WF(12)).map((job) => job.statuscode);
  assert.deepEqual(statuses, [...Array(16).fill(30), 32]);
  assert.match(background.jobs(WF(12)).at(-1).message, /infinite loop/);
});

test('a trusted pack handler still wins over XAML in the supported subset', async (t) => {
  const xaml = workflowXaml(updatePrimary('x_widget', { x_status: { type: 'Integer', value: '5' } }));
  const handlers = workflowHandlers([
    { id: 'invented-pack', workflows: { [WF(13)]: async () => ({ message: 'Invented handler ran' }) } },
  ]);
  const { request, widget, jobs, settle } = await fixture(
    t,
    [fact(WF(13), xaml, { triggeronupdateattributelist: 'x_count' })],
    { handlers },
  );
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_count: 4 })).status, 204);
  await settle();
  assert.deepEqual([jobs(WF(13))[0].statuscode, jobs(WF(13))[0].message], [30, 'Invented handler ran']);
  assert.equal(widget().x_status, 0, 'the XAML did not run');
});

// @test-kind contract: readiness reports the same local execution choice a run makes (Paqvilo's preflight design)
test('readiness reports handler, interpreted XAML and placeholder runs with the run precedence', async (t) => {
  const supported = workflowXaml(updatePrimary('x_widget', { x_status: { type: 'Integer', value: '5' } }));
  const handlers = workflowHandlers([{ id: 'invented-pack', workflows: { [WF(17)]: async () => ({}) } }]);
  const { store } = await fixture(
    t,
    [
      fact(WF(17), supported, { ondemand: true }),
      fact(WF(18), supported, { ondemand: true }),
      fact(WF(19), workflowXaml('<mxswa:Postpone />'), { ondemand: true }),
      fact(WF(20), supported, { ondemand: true }),
    ],
    { handlers },
  );
  const rows = classicWorkflowReadiness(store, { handlers, overrides: { [WF(20)]: { mode: 'placeholder' } } });
  assert.deepEqual(
    rows.map(({ key, mode, registered, resolver }) => [key, mode, registered, resolver ?? null]),
    [
      [`classic-workflow:${WF(17)}`, 'handler', true, 'pack'],
      [`classic-workflow:${WF(18)}`, 'xaml', true, 'xaml'],
      [`classic-workflow:${WF(19)}`, 'placeholder', false, null],
      [`classic-workflow:${WF(20)}`, 'placeholder', false, null],
    ],
  );
  // The preflight report says what resolves each one: the pack's handler, the interpreted XAML, or nothing yet.
  const report = buildPreflightReport({
    runtime: 'standalone',
    operations: rows,
    scenario: { id: 'invented', requires: ['classic-workflow:*'] },
    strict: true,
  });
  assert.deepEqual(
    report.requirements
      .filter(({ kind }) => kind === 'classic-workflow')
      .map(({ id, status, resolution, blocking }) => [id, status, resolution.by, blocking]),
    [
      [`classic-workflow:${WF(17)}`, 'satisfied', 'pack', false],
      [`classic-workflow:${WF(18)}`, 'satisfied', 'xaml', false],
      [`classic-workflow:${WF(19)}`, 'placeholder', null, true],
      [`classic-workflow:${WF(20)}`, 'placeholder', null, true],
    ],
  );
});

// @test-kind compatibility: Learn "Overview of using workflow processes", Security context of workflow processes: a real-time workflow runs as the workflow owner or the user who made the change (Execute As); an event-started background workflow runs as its owner
test('the run-as user of an interpreted run follows runas for real-time runs and the owner for event-started background runs', async (t) => {
  const note = workflowXaml(createRow('x_note', { x_name: { type: 'String', value: 'by workflow' } }));
  const { store, request, settle } = await fixture(t, [
    fact(WF(14), note, { mode: 1, runas: 1, triggeronupdateattributelist: 'x_count' }),
    fact(WF(15), note, { mode: 1, runas: 0, triggeronupdateattributelist: 'x_count' }),
    fact(WF(16), note, { mode: 0, triggeronupdateattributelist: 'x_count' }),
  ]);
  const caller = (await request('GET', '/WhoAmI')).json.UserId;
  const owner = store.tableRows('systemuser')[0].systemuserid;
  assert.notEqual(caller, owner, 'the fixture distinguishes the calling user from the seeded owner');
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_count: 6 })).status, 204);
  await settle();
  const creators = store
    .tableRows('x_note')
    .map((row) => row.createdby?.id)
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    creators,
    [caller, owner, owner].sort((a, b) => a.localeCompare(b)),
  );
});

// A standard-model portal /_api write of x_count, through the internal record pipeline the portal Web API and forms call.
const portalWrite = (store, data) =>
  store.recordPipeline.updateInternal(
    { identity: { admin: true }, portal: true, caller: null, method: 'PATCH', headers: {} },
    'x_widget',
    WIDGET,
    data,
    { authorized: true, writeOptions: { dataverseWebApi: false } },
  );

// @test-kind security: Learn "Power Pages connectivity to a Microsoft Dataverse": a site writes to Dataverse as its application user (# Portals-<site name>), an older site as SYSTEM; a standard-model portal visitor's write runs a calling-user (runas 1) real-time workflow as that identity (the observed application user, else the SYSTEM user the portal write runs as), never as the workflow's owner
test('a calling-user real-time workflow started by a portal write runs as the portal identity, never as the workflow owner', async (t) => {
  const note = workflowXaml(createRow('x_note', { x_name: { type: 'String', value: 'by workflow' } }));
  const { store } = await fixture(t, [
    fact(WF(17), note, { mode: 1, runas: 1, triggeronupdateattributelist: 'x_count' }),
    fact(WF(18), note, { mode: 1, runas: 0, triggeronupdateattributelist: 'x_count' }),
  ]);
  const organizationId = store.tableRows('organization')[0].organizationid;
  const settings = { organizationId, tenantId: 'local' };
  const user = async (name) => {
    const appId = uuidV5(organizationId, `invented-app:${name}`);
    await createApplicationUser(store, settings, { appId, displayName: name, roles: ['System Administrator'] });
    return uuidV5(organizationId, `systemuser:app:${appId}`);
  };
  const owner = await user('Invented owner');
  const application = await user('# Portals-Invented');
  for (const row of store.tableRows('workflow')) row.owninguser = { id: owner, logical_name: 'systemuser' };
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid;
  const creators = () =>
    store
      .tableRows('x_note')
      .splice(0)
      .map((row) => row.createdby?.id)
      .sort((a, b) => a.localeCompare(b));

  // Without an observed application user the portal write runs as SYSTEM, and so does the calling-user run.
  await portalWrite(store, { x_count: 1 });
  assert.deepEqual(
    creators(),
    [owner, system].sort((a, b) => a.localeCompare(b)),
  );

  // With the site's observed application user, the calling-user run writes as that user.
  store.observed = {
    ...store.observed,
    portalApplicationUser: '# Portals-Invented',
    portalApplicationUserId: application,
  };
  await portalWrite(store, { x_count: 2 });
  assert.deepEqual(
    creators(),
    [application, owner].sort((a, b) => a.localeCompare(b)),
  );
});

// ---- Interpreter over a recording host

const recordingHost = (row = {}) => {
  const writes = [];
  return {
    writes,
    host: {
      primary: { logicalName: 'x_widget', id: WIDGET, row: { x_widgetid: WIDGET, ...row } },
      idColumn: (table) => `${table}id`,
      hasTable: (table) => table === 'x_parent',
      read: () => null,
      create: (table, data) => {
        writes.push(['create', table, data]);
        return { [`${table}id`]: PARENT, ...data };
      },
      update: (table, id, data) => {
        writes.push(['update', table, id, data]);
        return { [`${table}id`]: id, ...row, ...data };
      },
      trace: () => {},
    },
  };
};

test('CreateCrmType literals of every supported WorkflowPropertyType reach the written row in store shapes', async () => {
  const { program, unsupported } = parseClassicWorkflow(
    workflowXaml(
      createRow('x_note', {
        x_text: { type: 'String', value: 'say ""hi""' },
        x_flag: { type: 'Boolean', value: 'True' },
        x_whole: { type: 'Integer', value: '-12' },
        x_dec: { type: 'Decimal', value: '1.25' },
        x_float: { type: 'Float', value: '0.5' },
        x_money: { type: 'Money', value: '100.10' },
        x_day: { type: 'DateTime', value: '2026-11-26' },
        x_at: { type: 'DateTime', value: '2026-11-26T10:30:00+02:00' },
        x_choice: { type: 'OptionSetValue', value: '3' },
        x_key: { type: 'Guid', value: PARENT.toUpperCase() },
        x_parentid: { type: 'EntityReference', value: null },
        x_cleared: { type: 'String', value: null },
      }).replace(
        'WorkflowPropertyType.EntityReference }',
        `WorkflowPropertyType.EntityReference, &quot;${PARENT}&quot;, &quot;x_parent&quot; }`,
      ),
    ),
  );
  assert.ok(program, unsupported);
  const { host, writes } = recordingHost();
  assert.deepEqual(await runClassicWorkflow(program, host), {
    status: 'succeeded',
    message: null,
    logs: [{ stepname: 'Step_1', activityname: 'CreateStep1_step', status: 2, errorcode: null, message: null }],
  });
  assert.deepEqual(writes, [
    [
      'create',
      'x_note',
      {
        x_text: 'say "hi"',
        x_flag: true,
        x_whole: -12,
        x_dec: 1.25,
        x_float: 0.5,
        x_money: 100.1,
        x_day: '2026-11-26T00:00:00.000Z',
        x_at: '2026-11-26T08:30:00.000Z',
        x_choice: 3,
        x_key: PARENT,
        x_parentid: { id: PARENT, logical_name: 'x_parent' },
        x_cleared: null,
      },
    ],
  ]);
  // A date that reads differently per time zone, a PartyList and a mixed literal stay outside the subset.
  for (const [type, value, reason] of [
    ['DateTime', '11/26/2026 10:30', /not an ISO 8601 date/],
    ['PartyList', 'x', /PartyList is outside/],
    ['Integer', '1.5', /not an integer/],
  ])
    assert.match(
      parseClassicWorkflow(workflowXaml(literal(type, [value], 'V'))).unsupported,
      reason,
      `${type} ${value}`,
    );
});

test('condition operators compare values, text without case and dates by time; a missing operand only satisfies negations', async () => {
  const cases = [
    ['Equal', 'ALPHA', ['alpha'], true],
    ['NotEqual', 'alpha', ['beta'], true],
    ['GreaterThan', 5, [3], true],
    ['GreaterEqual', 3, [3], true],
    ['LessThan', '2026-01-01T00:00:00Z', ['2026-02-01T00:00:00.000Z'], true],
    ['LessEqual', 4, [3], false],
    ['BeginsWith', 'Alphabet', ['alp'], true],
    ['DoesNotBeginWith', null, ['x'], true],
    ['EndsWith', 'alphabet', ['BET'], true],
    ['DoesNotEndWith', 'alphabet', ['bet'], false],
    ['Contains', 'alphabet', ['hab'], true],
    ['DoesNotContain', 'alphabet', ['zz'], true],
    ['Contains', null, ['a'], false],
    ['Equal', { id: PARENT.toUpperCase(), logical_name: 'x_parent' }, [{ id: PARENT, logical_name: 'x_parent' }], true],
    ['Null', '', [], true],
    ['NotNull', 0, [], true],
  ];
  for (const [operator, operand, parameters, expected] of cases) {
    const { program } = parseClassicWorkflow(
      workflowXaml(
        getProperty(PRIMARY, 'x_widget', 'x_a', 'A'),
        getProperty(PRIMARY, 'x_widget', 'x_b', 'B'),
        condition(operator, 'A', parameters.length ? ['B'] : [], 'R'),
        branch('R', [updatePrimary('x_widget', { x_status: { type: 'Integer', value: '1' } })]),
      ),
    );
    const { host, writes } = recordingHost({ x_a: operand, x_b: parameters[0] ?? null });
    await runClassicWorkflow(program, host);
    assert.equal(writes.length === 1, expected, `${operator} ${JSON.stringify(operand)} ${JSON.stringify(parameters)}`);
  }
});

// ---- Parser bounds (untrusted XAML)

// @test-kind security: untrusted workflow XAML is bounded (length, element count, nesting) and never evaluated beyond its literal forms; a refusal is a reason, not a throw
test('malformed, oversized, deep or expression-bearing XAML is refused with a reason and never runs', async () => {
  const deep = (levels) => {
    let body = updatePrimary('x_widget', { x_status: { type: 'Integer', value: '1' } });
    for (let level = 0; level < levels; level += 1) body = `<Sequence>${body}</Sequence>`;
    return workflowXaml(body);
  };
  const cases = [
    ['<Activity><mxswa:Workflow>', /not readable/],
    [`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///invented">]>${workflowXaml()}`, /not readable/],
    [workflowXaml(`<Sequence>${'x'.repeat(XAML_LIMITS.length)}</Sequence>`), /longer than/],
    [workflowXaml('<Sequence />'.repeat(XAML_LIMITS.elements)), /more than \d+ elements/],
    [deep(XAML_LIMITS.depth + 1), /nests deeper than/],
    [
      workflowXaml(
        `<Assign x:TypeArguments="mxs:Entity" To="${created('k')}" Value="[System.IO.File.ReadAllText(&quot;invented&quot;)]" />`,
      ),
      /not an entity reference/,
    ],
    [
      workflowXaml(literal('String', ['a'], 'V').replace('CreateCrmType', 'Concatenate')),
      /expression operator Concatenate/,
    ],
    [
      workflowXaml(
        `<mxswa:GetEntityProperty Attribute="x_name" Entity="${PRIMARY}" EntityName="x_widget" Value="[Foo.Bar()]" />`,
      ),
      /not a workflow variable/,
    ],
    [`<Workflow />`, /root is <Workflow>/],
    [12, /no XAML/],
  ];
  for (const [xaml, reason] of cases) {
    const parsed = parseClassicWorkflow(xaml);
    assert.equal(parsed.program, undefined, `refused: ${String(xaml).slice(0, 60)}`);
    assert.match(parsed.unsupported, reason);
  }
  // The deepest accepted nesting still parses, and its compiled program is frozen.
  const accepted = parseClassicWorkflow(deep(XAML_LIMITS.depth - 3));
  assert.ok(accepted.program, accepted.unsupported);
  assert.ok(Object.isFrozen(accepted.program.steps[0]));
});

// @test-kind security: an interpreted run only writes through its host; a run that cannot be carried out fails instead of writing elsewhere
test('an interpreted step that addresses another table than its entity fails without a write', async () => {
  const { program } = parseClassicWorkflow(
    workflowXaml(
      updatePrimary('x_widget', { x_status: { type: 'Integer', value: '1' } }).replace(
        'EntityName="x_widget" />',
        'EntityName="x_other" />',
      ),
    ),
  );
  assert.ok(program);
  const writes = [];
  const host = {
    primary: { logicalName: 'x_widget', id: WIDGET, row: { x_widgetid: WIDGET } },
    idColumn: (table) => `${table}id`,
    hasTable: () => true,
    read: () => null,
    create: (table, data) => writes.push(['create', table, data]),
    update: (table, id, data) => writes.push(['update', table, id, data]),
    trace: () => {},
  };
  await assert.rejects(runClassicWorkflow(program, host), { code: 'ClassicWorkflowFailure' });
  assert.deepEqual(writes, []);
});

// ---- Waits (Learn "Configure workflow stages and steps": a wait condition pauses a background workflow until its criteria
// are met and it starts again automatically; parallel wait branches; real-time workflows cannot use wait conditions; SDK
// Postpone PostponeUntil and BlockExecution; Learn "Asynchronous service": a Suspended job turns Ready at its postponeuntil)

const T0 = Date.parse('2026-03-02T09:00:00.000Z');
// Wait until x_status equals `value` (one wait branch per value: a parallel wait), then set x_name to the branch's name.
const waitForStatus = (...values) =>
  conditionSequence(
    values.flatMap((value) => [`Wait${value}_status`, `Wait${value}_value`, `Wait${value}_holds`]),
    values.flatMap((value) => [
      getProperty(PRIMARY, 'x_widget', 'x_status', `Wait${value}_status`),
      literal('Integer', [String(value)], `Wait${value}_value`),
      condition('Equal', `Wait${value}_status`, [`Wait${value}_value`], `Wait${value}_holds`),
      branch(`Wait${value}_holds`, [
        updatePrimary('x_widget', { x_name: { type: 'String', value: `met ${value}` } }, `UpdateStep${value}`),
      ]),
    ]),
    'True',
  );
const postponeUntil = (iso) => [
  literal('DateTime', [iso], 'Timeout_until'),
  `<mxswa:Postpone BlockExecution="True" PostponeUntil="[Timeout_until]" />`,
];
const waitingState = (job) => [job.statecode, job.statuscode];

// @test-kind observation+unproven: hosted session F6, summary-F6 OPS-01d (runs A and B agree): the waiting job is 1/10 with wait-until 9999-12-30, the steps before the wait stay, the rows of the executed steps are written, and a write of the column the condition reads resumes it; that such a write which leaves the condition false keeps it waiting is a local model
test('a background wait condition suspends the job and resumes it when a later write meets it', async (t) => {
  const xaml = workflowXaml(
    updatePrimary('x_widget', { x_count: { type: 'Integer', value: '7' } }, 'UpdateStep1'),
    waitForStatus(5),
  );
  const { request, widget, jobs, logs, settle } = await fixture(t, [
    fact(WF(30), xaml, { triggeronupdateattributelist: 'x_trigger' }),
  ]);
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 })).status, 204);
  await settle();
  let [job] = jobs(WF(30));
  assert.deepEqual(waitingState(job), [1, 10], 'Suspended / Waiting');
  assert.equal(job.postponeuntil, '9999-12-30T23:59:59Z', 'a condition wait waits until 9999-12-30');
  assert.equal(widget().x_count, 7, 'the steps before the wait committed');
  assert.equal(widget().x_name, 'alpha');
  const rows = () => logs().map((item) => [item.activityname, item.status]);
  assert.deepEqual(rows(), [['UpdateStep1_step', 2]], 'the steps run before the wait are logged');
  // A write that does not meet the condition wakes the job; it evaluates the wait again and keeps waiting.
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_status: 3 })).status, 204);
  await settle();
  [job] = jobs(WF(30));
  assert.deepEqual(waitingState(job), [1, 10]);
  assert.equal(widget().x_count, 7, 'the steps before the wait do not run again');
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_status: 5 })).status, 204);
  await settle();
  [job] = jobs(WF(30));
  assert.deepEqual(waitingState(job), [3, 30], 'Completed / Succeeded');
  assert.equal(widget().x_name, 'met 5');
  assert.deepEqual(rows(), [
    ['UpdateStep1_step', 2],
    ['UpdateStep5_step', 2],
  ]);
  assert.equal(jobs(WF(30)).length, 1, 'one job from start to end');
});

// @test-kind compatibility+unproven: Learn "Parallel Wait Branch" defines an alternative wait condition with its own steps; the first branch whose condition holds runs (local model of the choice when several hold)
test('parallel wait branches: the branch whose condition a later write meets runs, the other does not', async (t) => {
  const xaml = workflowXaml(waitForStatus(5, 6));
  const { request, widget, jobs, settle } = await fixture(t, [
    fact(WF(31), xaml, { triggeronupdateattributelist: 'x_trigger' }),
  ]);
  await request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 });
  await settle();
  assert.deepEqual(waitingState(jobs(WF(31))[0]), [1, 10]);
  await request('PATCH', `/x_widgets(${WIDGET})`, { x_status: 6 });
  await settle();
  assert.deepEqual(waitingState(jobs(WF(31))[0]), [3, 30]);
  assert.equal(widget().x_name, 'met 6');
});

// @test-kind unproven: local model of the SDK Postpone (PostponeUntil, BlockExecution) on the runtime clock; every Postpone form was refused at Web API create in hosted session F6 (summary-F6 OPS-01d), so no hosted run of it exists
test('Postpone suspends the job until its time on the runtime clock, then the run continues', async (t) => {
  const clock = fixedClock(T0);
  const xaml = workflowXaml(
    ...postponeUntil('2026-03-02T09:05:00Z'),
    updatePrimary('x_widget', { x_name: { type: 'String', value: 'later' } }),
  );
  const { request, widget, jobs, scheduler, settle } = await fixture(
    t,
    [fact(WF(32), xaml, { triggeronupdateattributelist: 'x_trigger' })],
    { clock },
  );
  await request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 });
  await settle();
  let [job] = jobs(WF(32));
  assert.deepEqual(waitingState(job), [1, 10]);
  assert.equal(job.postponeuntil, '2026-03-02T09:05:00.000Z');
  // A write of the record does not wake a timeout.
  await request('PATCH', `/x_widgets(${WIDGET})`, { x_status: 2 });
  await settle();
  assert.deepEqual(waitingState(jobs(WF(32))[0]), [1, 10]);
  await scheduler.advance(299_999);
  await settle();
  assert.deepEqual(waitingState(jobs(WF(32))[0]), [1, 10], 'not yet due');
  assert.equal(widget().x_name, 'alpha');
  await scheduler.advance(1);
  await settle();
  [job] = jobs(WF(32));
  assert.deepEqual(waitingState(job), [3, 30]);
  assert.equal(widget().x_name, 'later');
  // A time already passed, and a non-blocking Postpone, do not suspend.
  const passed = workflowXaml(
    ...postponeUntil('2026-03-02T08:00:00Z'),
    '<mxswa:Postpone BlockExecution="False" PostponeUntil="[Timeout_until]" />',
    updatePrimary('x_widget', { x_status: { type: 'Integer', value: '9' } }),
  );
  const second = await fixture(t, [fact(WF(33), passed, { triggeronupdateattributelist: 'x_trigger' })], {
    clock: fixedClock(T0),
  });
  await second.request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 });
  await second.settle();
  assert.deepEqual(waitingState(second.jobs(WF(33))[0]), [3, 30]);
  assert.equal(second.widget().x_status, 9);
});

// @test-kind compatibility: Learn "Asynchronous service": Resume changes a Suspended job to Ready and Cancel completes it Canceled; a resumed waiting workflow evaluates its wait again
test('a waiting job resumed through the Web API evaluates its wait again; a canceled one is never woken', async (t) => {
  const { request, widget, jobs, settle } = await fixture(t, [
    fact(WF(34), workflowXaml(waitForStatus(5)), { triggeronupdateattributelist: 'x_trigger' }),
  ]);
  await request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 });
  await settle();
  const id = jobs(WF(34))[0].asyncoperationid;
  // The record already meets the condition, but no write woke the job: a Resume runs it.
  widget().x_status = 5;
  assert.equal((await request('PATCH', `/asyncoperations(${id})`, { statecode: 0 })).status, 204);
  await settle();
  assert.deepEqual(waitingState(jobs(WF(34))[0]), [3, 30]);
  assert.equal(widget().x_name, 'met 5');

  const other = await fixture(t, [
    fact(WF(35), workflowXaml(waitForStatus(5)), { triggeronupdateattributelist: 'x_trigger' }),
  ]);
  await other.request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 });
  await other.settle();
  const waiting = other.jobs(WF(35))[0].asyncoperationid;
  assert.equal((await other.request('PATCH', `/asyncoperations(${waiting})`, { statecode: 3 })).status, 204);
  await other.request('PATCH', `/x_widgets(${WIDGET})`, { x_status: 5 });
  await other.settle();
  assert.deepEqual(waitingState(other.jobs(WF(35))[0]), [3, 32]);
  assert.equal(other.widget().x_name, 'alpha', 'a canceled job does not continue');
});

// @test-kind unproven: a waiting run whose record is deleted ends Canceled when the delete wakes it (local model; the hosted outcome is not captured)
test('deleting the record a run waits on ends its job Canceled', async (t) => {
  const { request, jobs, settle } = await fixture(t, [
    fact(WF(36), workflowXaml(waitForStatus(5)), { triggeronupdateattributelist: 'x_trigger' }),
  ]);
  await request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 });
  await settle();
  assert.equal((await request('DELETE', `/x_widgets(${WIDGET})`)).status, 204);
  await settle();
  const [job] = jobs(WF(36));
  assert.deepEqual(waitingState(job), [3, 32]);
  assert.match(job.message, /no longer exists/);
});

// @test-kind compatibility: Learn "Configure real-time workflow stages and steps": real-time workflows can't use wait conditions; such a definition keeps the placeholder
test('a real-time definition with a wait is not interpreted', async (t) => {
  const { request, widget, diagnostics } = await fixture(t, [
    fact(WF(37), workflowXaml(waitForStatus(5)), { mode: 1, triggeronupdateattributelist: 'x_trigger' }),
  ]);
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 })).status, 204);
  assert.equal(widget().x_name, 'alpha');
  const reason = diagnostics.find((entry) => entry.workflowId === WF(37) && entry.code === 'WORKFLOW_XAML_UNSUPPORTED');
  assert.match(reason.message, /real-time workflow cannot use wait conditions/);
});

// @test-kind unproven: an on-demand (ExecuteWorkflow) run that reaches a Postpone waits as a Suspended system job and continues at its time (local model of the on-demand job's wait)
test('an on-demand run that reaches a Postpone waits and continues at its time', async (t) => {
  const clock = fixedClock(T0);
  const xaml = workflowXaml(
    ...postponeUntil('2026-03-02T09:02:00Z'),
    updatePrimary('x_widget', { x_name: { type: 'String', value: 'on demand' } }),
  );
  const { request, widget, jobs, scheduler, settle } = await fixture(t, [fact(WF(38), xaml, { ondemand: true })], {
    clock,
  });
  const started = await request('POST', `/workflows(${WF(38)})/Microsoft.Dynamics.CRM.ExecuteWorkflow`, {
    EntityId: WIDGET,
  });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  await settle();
  const [job] = jobs(WF(38));
  assert.equal(job.asyncoperationid, started.json.asyncoperationid);
  assert.deepEqual(waitingState(job), [1, 10]);
  assert.equal(job.postponeuntil, '2026-03-02T09:02:00.000Z');
  await scheduler.advance(120_000);
  await settle();
  assert.deepEqual(waitingState(jobs(WF(38))[0]), [3, 30]);
  assert.equal(widget().x_name, 'on demand');
});

// @test-kind contract: a timed waiting job survives a restart: the runner of a new runtime over the same state finds it and runs it at its time
test('a timed waiting job is found again after a restart and runs at its time', async (t) => {
  const clock = fixedClock(T0);
  const xaml = workflowXaml(
    ...postponeUntil('2026-03-02T09:01:00Z'),
    updatePrimary('x_widget', { x_name: { type: 'String', value: 'after restart' } }),
  );
  const first = await fixture(t, [fact(WF(39), xaml, { triggeronupdateattributelist: 'x_trigger' })], { clock });
  await first.request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 });
  await first.settle();
  assert.deepEqual(waitingState(first.jobs(WF(39))[0]), [1, 10]);
  // The same rows in a new store and runtime.
  const state = structuredClone(first.store.state);
  const store = await new DataStore({ state, clock }).init();
  const scheduler = storeScheduler(store, createScheduler({ clock, manual: true }));
  t.after(() => scheduler.close());
  await startAdminApi(t, store, {
    extensions: [
      ...EXTENSIONS,
      workflowExtension({ facts: [fact(WF(39), xaml, { triggeronupdateattributelist: 'x_trigger' })] }),
    ],
  });
  committedJobs(store).resume();
  await scheduler.advance(60_000);
  await settleCommittedWork(store, []);
  const job = store
    .tableRows('asyncoperation')
    .find((row) => row.asyncoperationid === first.jobs(WF(39))[0].asyncoperationid);
  assert.deepEqual(waitingState(job), [3, 30]);
  assert.equal(store.tableRows('x_widget')[0].x_name, 'after restart');
});

// @test-kind unproven: the interpreter's own resume contract: a snapshot continues inside a branch body at the step that suspended, with the variables it had
test('a snapshot resumes inside a branch at the waiting step with its variables', async () => {
  const xaml = workflowXaml(
    literal('String', ['kept', 'String'], 'Kept'),
    conditionSequence(
      ['Outer_status', 'Outer_value', 'Outer_holds'],
      [
        getProperty(PRIMARY, 'x_widget', 'x_status', 'Outer_status'),
        literal('Integer', ['0'], 'Outer_value'),
        condition('Equal', 'Outer_status', ['Outer_value'], 'Outer_holds'),
        branch('Outer_holds', [waitForStatus(5)]),
      ],
    ),
  );
  const { program } = parseClassicWorkflow(xaml);
  assert.ok(program, 'parsed');
  assert.equal(program.waits, true);
  let row = { x_widgetid: WIDGET, x_status: 0, x_name: 'alpha' };
  const updates = [];
  const host = () => ({
    primary: { logicalName: 'x_widget', id: WIDGET, row },
    idColumn: () => 'x_widgetid',
    hasTable: () => true,
    read: () => row,
    create: () => assert.fail('no create'),
    update: (table, id, data) => {
      updates.push(data);
      row = { ...row, ...data };
      return row;
    },
    trace: () => {},
    now: () => T0,
  });
  const waiting = await runClassicWorkflow(program, host());
  assert.equal(waiting.status, 'waiting');
  assert.deepEqual(waiting.wait, { kind: 'condition', until: null, columns: ['x_status'] });
  row = { ...row, x_status: 5 };
  const done = await runClassicWorkflow(program, host(), { resume: waiting.snapshot });
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(updates, [{ x_name: 'met 5' }]);
  assert.ok(waiting.snapshot.vars.some(([name, value]) => name === 'Kept' && value === 'kept'));
});

// @test-kind unproven: the interpreter's own resume contract after a failure: the snapshot of a run that fails in a step without a designer name, inside a branch or at a wait's condition evaluation records that position, so a resumed run does not repeat the writes before it
test('a run that fails outside a designer action step resumes at the failing position without repeating earlier writes', async () => {
  const holds = [
    getProperty(PRIMARY, 'x_widget', 'x_status', 'C_status'),
    literal('Integer', ['0'], 'C_value'),
    condition('Equal', 'C_status', ['C_value'], 'C_holds'),
  ];
  const scenarios = {
    flat: [
      createRow('x_note', { x_name: { type: 'String', value: 'one' } }, 'CreateFirst'),
      createRow('x_note', { x_name: { type: 'String', value: 'two' } }, 'CreateSecond'),
    ],
    branch: [
      createRow('x_note', { x_name: { type: 'String', value: 'one' } }, 'CreateFirst'),
      conditionSequence(
        ['C_status', 'C_value', 'C_holds'],
        [
          ...holds,
          branch('C_holds', [createRow('x_note', { x_name: { type: 'String', value: 'two' } }, 'CreateSecond')]),
        ],
      ),
    ],
    wait: [
      createRow('x_note', { x_name: { type: 'String', value: 'one' } }, 'CreateFirst'),
      conditionSequence(
        ['W_status'],
        [getProperty(PRIMARY, 'x_other', 'x_status', 'W_status'), branch('W_status', [])],
        'True',
      ),
    ],
  };
  for (const [name, steps] of Object.entries(scenarios)) {
    const { program, unsupported } = parseClassicWorkflow(workflowXaml(...steps));
    assert.ok(program, `${name}: ${unsupported}`);
    const writes = [];
    let refuse = true;
    const host = {
      primary: { logicalName: 'x_widget', id: WIDGET, row: { x_widgetid: WIDGET, x_status: 0 } },
      idColumn: (table) => `${table}id`,
      hasTable: () => true,
      read: () => ({ x_widgetid: WIDGET, x_status: 0 }),
      create: (table, data) => {
        if (data.x_name === 'two' && refuse) {
          refuse = false;
          throw new Error('refused once');
        }
        writes.push(data.x_name);
        return { [`${table}id`]: `6c000000-0000-4000-8000-0000000002${String(writes.length).padStart(2, '0')}` };
      },
      update: () => assert.fail('no update'),
      trace: () => {},
      now: () => T0,
    };
    const failed = await runClassicWorkflow(program, host, { suspendOnFailure: true });
    assert.equal(failed.status, 'failed', name);
    assert.notDeepEqual(failed.snapshot.path, [], `${name}: the failing position is recorded`);
    assert.deepEqual(writes, ['one'], name);
    const resumed = await runClassicWorkflow(program, host, { suspendOnFailure: true, resume: failed.snapshot });
    if (name === 'wait') {
      // The wait's evaluation fails again at the same position; the write before it is not repeated.
      assert.equal(resumed.status, 'failed', name);
      assert.deepEqual(resumed.snapshot.path, failed.snapshot.path, name);
      assert.deepEqual(writes, ['one'], name);
    } else {
      assert.equal(resumed.status, 'succeeded', name);
      assert.deepEqual(writes, ['one', 'two'], `${name}: only the failed write runs again`);
    }
  }
});

// A write that meets the wait, committed while the job's run holds its row: at the run's suspension write (`phase`
// 'before-suspend': the row is still Locked) or right after it, before the run ends ('after-suspend'). The gate wraps the
// store's tracked job transactions and fires once, in that exact place; the write wakes as the workflow stager does.
async function gatedWake(t, phase) {
  const { store, request, widget, jobs, settle } = await fixture(t, [
    fact(WF(40), workflowXaml(waitForStatus(5)), { triggeronupdateattributelist: 'x_trigger' }),
  ]);
  const transact = store.transact.bind(store);
  let fired = false;
  const meet = async () => {
    fired = true;
    let woken = null;
    await transact(() => {
      widget().x_status = 5;
      woken = committedJobs(store).wake((row, payload) => payload.kind === 'workflow');
    });
    woken?.();
  };
  store.transact = async (fn, options) => {
    const job = () => jobs(WF(40))[0];
    if (!fired && options?.tracked && phase === 'before-suspend' && job()?.statecode === 2) await meet();
    const result = await transact(fn, options);
    if (!fired && options?.tracked && phase === 'after-suspend' && job()?.statecode === 1) await meet();
    return result;
  };
  t.after(() => {
    store.transact = transact;
  });
  assert.equal((await request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 })).status, 204);
  await settle();
  return { fired, job: jobs(WF(40))[0], widget: widget() };
}

// @test-kind contract: a wake is never lost to a run in progress: a write that meets the wait while the run holds the row (Locked, before it writes Suspended) wakes the job once the run leaves it Suspended
test('a wake that comes while the run still holds its row resumes the job once it waits', async (t) => {
  const { fired, job, widget } = await gatedWake(t, 'before-suspend');
  assert.equal(fired, true, 'the gate fired at the suspension write');
  assert.deepEqual(waitingState(job), [3, 30]);
  assert.equal(widget.x_name, 'met 5');
});

// @test-kind contract: a wake is never lost to the end of the run that suspended: a row made Ready after its suspension write and before that run ended (the tick had already tried it) runs again after the tick
test('a wake between the suspension write and the end of its run resumes the job', async (t) => {
  const { fired, job, widget } = await gatedWake(t, 'after-suspend');
  assert.equal(fired, true, 'the gate fired after the suspension write');
  assert.deepEqual(waitingState(job), [3, 30]);
  assert.equal(widget.x_name, 'met 5');
});

// ---- Hosted designer forms and outcomes (hosted session F6, summary-F6 OPS-01d)

const designerStop = (status, message, number = 7) => `<Sequence DisplayName="StopWorkflowStep${number}: stop">
  <Sequence.Variables><Variable x:TypeArguments="x:Object" Name="StopWorkflowStep${number}_1" /></Sequence.Variables>
  ${literal('String', [message, 'String'], `StopWorkflowStep${number}_1`)}
  <TerminateWorkflow DisplayName="StopWorkflowStep${number}: stop" Exception="[New Microsoft.Xrm.Sdk.InvalidPluginExecutionException(Microsoft.Xrm.Sdk.OperationStatus.${status})]" Reason="[DirectCast(StopWorkflowStep${number}_1, System.String)]" />
</Sequence>`;
const expression = (operator, parameters, result, space = '') =>
  `<mxswa:ActivityReference AssemblyQualifiedName="${AQN('EvaluateExpression')}" DisplayName="EvaluateExpression">
  <mxswa:ActivityReference.Arguments>
    <InArgument x:TypeArguments="x:String" x:Key="ExpressionOperator">${operator}</InArgument>
    <InArgument x:TypeArguments="s:Object[]" x:Key="Parameters"${space}>[New Object() { ${parameters} }]</InArgument>
    <InArgument x:TypeArguments="s:Type" x:Key="TargetType"><mxswa:ReferenceLiteral x:TypeArguments="s:Type"><x:Null /></mxswa:ReferenceLiteral></InArgument>
    <OutArgument x:TypeArguments="x:Object" x:Key="Result">[${result}]</OutArgument>
  </mxswa:ActivityReference.Arguments>
</mxswa:ActivityReference>`;
const PRESERVE = ' xml:space="preserve"';
const unitHost = (row, writes, now = T0) => ({
  primary: { logicalName: 'x_widget', id: WIDGET, row },
  idColumn: (table) => `${table}id`,
  hasTable: () => true,
  read: () => row,
  create: (table, data) => {
    writes.push([table, data]);
    return { ...data, [`${table}id`]: PARENT };
  },
  update: (table, id, data) => {
    writes.push([table, data]);
    return { ...row, ...data };
  },
  trace: () => {},
  now: () => now,
});
const noteStep = (number, steps) => `<Sequence DisplayName="CreateStep${number}: note">
  ${steps.join('\n')}
  <mxswa:CreateEntity EntityId="{x:Null}" DisplayName="CreateStep${number}" Entity="${created('note#Temp')}" EntityName="x_note" />
</Sequence>`;
const newNote = `<Assign x:TypeArguments="mxs:Entity" To="${created('note#Temp')}" Value="${q('[New Entity("x_note")]')}" />`;
const setNote = (column, variable) =>
  `<mxswa:SetEntityProperty Attribute="${column}" Entity="${created('note#Temp')}" EntityName="x_note" Value="[${variable}]" />`;
const parentReference = (idVariable, result) =>
  expression(
    'CreateCrmType',
    `Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.EntityReference, "x_parent", "Invented parent", ${idVariable}, "Lookup"`,
    result,
  );

// @test-kind observation: designer forms of the workflows harvested and created in hosted session F6 (summary-F6 OPS-01d): the Stop with a one-argument exception and Reason [DirectCast(...)], variable defaults other than True/False, Add, RetrieveCurrentTime with xml:space="preserve", a 3-argument CreateCrmType, an EntityReference whose id is a variable, and mxswa:Workflow.Variables
test('the designer forms of Stop, variable defaults, Add, RetrieveCurrentTime, lookups from a variable and Workflow.Variables run', async () => {
  const xaml = workflowXaml(
    `<mxswa:Workflow.Variables><Variable x:TypeArguments="x:String" Default="[Nothing]" Name="Declared" /></mxswa:Workflow.Variables>`,
    noteStep(3, [
      `<Sequence.Variables>
        <Variable x:TypeArguments="x:String" Default="650690dd-dcbc-48d5-aae2-2015fafed850" Name="LabelId" />
        <Variable x:TypeArguments="x:Int32" Default="1033" Name="Language" />
      </Sequence.Variables>`,
      literal('String', ['alpha', 'String'], 'First'),
      literal('String', [' and ', 'String'], 'Second'),
      expression('Add', 'First, Second, LabelId', 'Joined'),
      expression('RetrieveCurrentTime', ' ', 'Now', PRESERVE),
      literal('Guid', [PARENT, 'UniqueIdentifier'], 'ParentId'),
      parentReference('ParentId', 'Parent'),
      newNote,
      setNote('x_name', 'Joined'),
      setNote('x_detail', 'Now'),
      setNote('x_parentid', 'Parent'),
      setNote('x_language', 'Language'),
    ]),
    designerStop('Canceled', 'Invented designer stop'),
  );
  const { program, unsupported } = parseClassicWorkflow(xaml);
  assert.equal(unsupported, undefined);
  assert.deepEqual(program.webApi, [], 'designer-shaped: the Web API accepts it');
  assert.deepEqual(program.references, [{ table: 'x_parent', id: PARENT, steps: ['CreateStep3', 'WorkflowStep0'] }]);
  const writes = [];
  const outcome = await runClassicWorkflow(program, unitHost({ x_widgetid: WIDGET }, writes));
  assert.deepEqual(writes, [
    [
      'x_note',
      {
        x_name: 'alpha and 650690dd-dcbc-48d5-aae2-2015fafed850',
        x_detail: new Date(T0).toISOString(),
        x_parentid: { id: PARENT, logical_name: 'x_parent' },
        x_language: 1033,
      },
    ],
  ]);
  assert.deepEqual([outcome.status, outcome.message], ['canceled', 'Invented designer stop']);
  assert.deepEqual(
    outcome.logs.map(({ stepname, activityname, status, message }) => [stepname, activityname, status, message]),
    [
      ['Step_3', 'CreateStep3_step', 2, null],
      ['Step_7', 'StopWorkflowStep7_step', 2, ''],
    ],
  );
  // Without xml:space="preserve" on its empty parameters, RetrieveCurrentTime runs but the Web API refuses it.
  const unpreserved = parseClassicWorkflow(workflowXaml(expression('RetrieveCurrentTime', ' ', 'Now')));
  assert.deepEqual(unpreserved.program.webApi, ['RetrieveCurrentTime parameters without xml:space="preserve"']);
});

// @test-kind observation: hosted session F6, workflows-create (summary-F6 OPS-01d): activation refuses a lookup literal to a missing row with 400 0x80048455 and the map of the steps around it, innermost first, to WorkflowStep0; a lookup to an existing row activates
test('activation checks lookup literals: a missing row refuses it with 0x80048455 and the map of its steps', async (t) => {
  const missing = 'f6f6f6f6-0000-4000-8000-00000000dead';
  const lookupStep = (id) =>
    conditionSequence(
      [],
      [
        `<mxswa:ActivityReference AssemblyQualifiedName="${AQN('ConditionBranch')}" DisplayName="ConditionBranchStep8">
          <mxswa:ActivityReference.Arguments><InArgument x:TypeArguments="x:Boolean" x:Key="Condition">[True]</InArgument></mxswa:ActivityReference.Arguments>
          <mxswa:ActivityReference.Properties>
            ${composite('Then', [
              noteStep(9, [
                literal('Guid', [id, 'UniqueIdentifier'], 'CreateStep9_5'),
                parentReference('CreateStep9_5', 'CreateStep9_3'),
                newNote,
                setNote('x_parentid', 'CreateStep9_3'),
              ]),
            ])}
            <x:Null x:Key="Else" />
            <x:String x:Key="Description">Invented branch</x:String>
          </mxswa:ActivityReference.Properties>
        </mxswa:ActivityReference>`,
      ],
    ).replace('DisplayName="ConditionStep"', 'DisplayName="ConditionStep7"');
  const { request } = await fixture(t, []);
  const createAndActivate = async (id, xaml) => {
    const response = await request('POST', '/workflows', {
      workflowid: id,
      name: `Invented lookup ${id.slice(-2)}`,
      category: 0,
      type: 1,
      mode: 0,
      primaryentity: 'x_widget',
      scope: 4,
      triggeroncreate: true,
      xaml,
    });
    assert.equal(response.status, 204, JSON.stringify(response.json));
    return request('PATCH', `/workflows(${id})`, { statecode: 1, statuscode: 2 });
  };
  const refused = await createAndActivate(WF(50), workflowXaml(lookupStep(missing)));
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, '0x80048455');
  assert.equal(
    refused.json.error.message,
    `Error: This workflow has errors and cannot be published. Please remove the errors and try again., Worklfow Id: ${WF(50)}, ErrorMap Details: {CreateStep9: InvalidGuidReference ; ConditionBranchStep8: InvalidGuidReference ; ConditionStep7: InvalidGuidReference ; WorkflowStep0: InvalidGuidReference}`,
  );
  assert.equal((await createAndActivate(WF(51), workflowXaml(lookupStep(PARENT)))).status, 204);
});

// @test-kind observation: hosted session F6 (summary-F6 OPS-01d): a condition wait is woken only by a write of a column its condition reads; a write of another column leaves the job waiting even when the condition would now hold
test('a condition wait is not woken by a write of a column its condition does not read', async (t) => {
  const { request, widget, jobs, settle } = await fixture(t, [
    fact(WF(52), workflowXaml(waitForStatus(5)), { triggeronupdateattributelist: 'x_trigger' }),
  ]);
  await request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 });
  await settle();
  assert.deepEqual(waitingState(jobs(WF(52))[0]), [1, 10]);
  // The condition holds now, but only through a value no write submitted; a write of x_name does not wake the wait.
  widget().x_status = 5;
  await request('PATCH', `/x_widgets(${WIDGET})`, { x_name: 'renamed' });
  await settle();
  assert.deepEqual(waitingState(jobs(WF(52))[0]), [1, 10], 'still waiting');
  await request('PATCH', `/x_widgets(${WIDGET})`, { x_status: 5 });
  await settle();
  assert.deepEqual(waitingState(jobs(WF(52))[0]), [3, 30]);
  assert.equal(widget().x_name, 'met 5');
});

// @test-kind observation+unproven: hosted session F6 (summary-F6 OPS-01d) shows a failing background step suspends the job 1/10 with error code -2147204303, its message, wait-until 9999-12-30, earlier writes kept and the failing step logged with status 3; that a Resume retries the failing step is a local model
test('a failing background step suspends the job with its error; a Resume retries that step', async (t) => {
  const xaml = workflowXaml(
    updatePrimary('x_widget', { x_count: { type: 'Integer', value: '4' } }, 'UpdateStep1'),
    createRow('x_note', { x_name: { type: 'String', value: 'x'.repeat(201) } }, 'CreateStep2'),
  );
  const { store, request, widget, jobs, logs, settle } = await fixture(t, [
    fact(WF(53), xaml, { triggeronupdateattributelist: 'x_trigger' }),
  ]);
  store.state.mappings.x_note.fields.x_name.maxLength = 200;
  await request('PATCH', `/x_widgets(${WIDGET})`, { x_trigger: 1 });
  await settle();
  const [job] = jobs(WF(53));
  assert.deepEqual(
    [job.statecode, job.statuscode, job.errorcode, job.postponeuntil],
    [1, 10, -2147204303, '9999-12-30T23:59:59Z'],
  );
  assert.match(job.friendlymessage, /exceeded the maximum allowed length of '200'/);
  assert.equal(widget().x_count, 4, 'the step before the failure stays written');
  const rows = () => logs().map((row) => [row.activityname, row.status, row.errorcode]);
  assert.deepEqual(rows(), [
    ['UpdateStep1_step', 2, null],
    ['CreateStep2_step', 3, -2147204303],
  ]);
  assert.equal((await request('PATCH', `/asyncoperations(${job.asyncoperationid})`, { statecode: 0 })).status, 204);
  await settle();
  assert.deepEqual(waitingState(jobs(WF(53))[0]), [1, 10], 'the retried step fails again');
  assert.deepEqual(rows().at(-1), ['CreateStep2_step', 3, -2147204303], 'the retry is logged');
  assert.equal(rows().length, 3, 'the step before the failure does not run again');
});

// @test-kind observation: hosted F2 state-0 runs s0a and s0b (paqvilo-developer hosted-f2 workflow.json, execute:realtime and execute:background; attach.json for a form save): a real-time workflow's operations inside a portal call run at depth 2 with IsPortalsClientCall true and PortalsContactId the contact; a background workflow job's operations report false and the zero GUID
test("a real-time workflow's writes inside a portal call keep the call's contact; a background job's do not", async (t) => {
  const contact = '0c000000-0000-4000-8000-000000000001';
  const note = workflowXaml(createRow('x_note', { x_name: { type: 'String', value: 'by workflow' } }));
  const { store, settle } = await fixture(t, [
    fact(WF(31), note, { mode: 1, runas: 1, triggeronupdateattributelist: 'x_count' }),
    fact(WF(32), note, { mode: 0, triggeronupdateattributelist: 'x_count' }),
  ]);
  // The visitor's write is authorized by its form; the test asserts only the portal facts its runs carry.
  store.state.settings = { ...store.state.settings, permissionMode: 'permissive' };
  const seen = [];
  const pipeline = store.pluginPipeline;
  const recorder = (context) => {
    if (context.entity === 'x_note' && context.operation === 'create' && context.stage === 10)
      seen.push({ inherited: context.inheritedPortalCall ?? null, asynchronous: context.asyncExecution === true });
    return pipeline?.(context);
  };
  if (pipeline) Object.assign(recorder, { steps: pipeline.steps, diagnostic: pipeline.diagnostic });
  store.setPluginPipeline(recorder);
  // The form's write commits in its own transaction, which starts the background run.
  await store.transact(
    () =>
      store.recordPipeline.updateInternal(
        {
          identity: { id: contact, contactId: contact, roles: [] },
          portal: true,
          caller: null,
          method: 'POST',
          headers: {},
        },
        'x_widget',
        WIDGET,
        { x_count: 7 },
        { authorized: true, writeOptions: { dataverseWebApi: false } },
      ),
    { incremental: true },
  );
  await settle();
  const realtime = seen.filter((entry) => entry.inherited);
  assert.equal(realtime.length, 1, JSON.stringify(seen));
  assert.equal(realtime[0].inherited.contactId, contact);
  // The background job's write carries no portal call.
  assert.equal(seen.filter((entry) => !entry.inherited).length, 1, JSON.stringify(seen));
});
