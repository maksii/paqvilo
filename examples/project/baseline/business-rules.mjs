import { createHash } from 'node:crypto';

// Business rule authoring for the baseline fixture (workflow category 2: XAML + client data).
// Mirrors designer-generated rules: one ConditionSequence whose first branch holds `actions` and whose
// optional second branch (condition [True]) holds `otherwise`.
const CRM = 'Microsoft.Crm.Workflow, Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35';
const SDK = 'Version=9.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35';
const NET = 'Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089';
const NAMESPACES = `xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:mcwc="clr-namespace:Microsoft.Crm.Workflow.ClientActivities;assembly=${CRM}" xmlns:mcwo="clr-namespace:Microsoft.Crm.Workflow.ObjectModel;assembly=Microsoft.Crm, ${SDK}" xmlns:mva="clr-namespace:Microsoft.VisualBasic.Activities;assembly=System.Activities, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35" xmlns:mxs="clr-namespace:Microsoft.Xrm.Sdk;assembly=Microsoft.Xrm.Sdk, ${SDK}" xmlns:mxsq="clr-namespace:Microsoft.Xrm.Sdk.Query;assembly=Microsoft.Xrm.Sdk, ${SDK}" xmlns:mxswa="clr-namespace:Microsoft.Xrm.Sdk.Workflow.Activities;assembly=Microsoft.Xrm.Sdk.Workflow, ${SDK}" xmlns:s="clr-namespace:System;assembly=mscorlib, ${NET}" xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib, ${NET}" xmlns:sco="clr-namespace:System.Collections.ObjectModel;assembly=mscorlib, ${NET}" xmlns:srs="clr-namespace:System.Runtime.Serialization;assembly=System.Runtime.Serialization, ${NET}" xmlns:this="clr-namespace:" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"`;
const DICT = 'scg:IDictionary(x:String, mxs:Entity)';
const PRIMARY = '[InputEntities(&quot;primaryEntity&quot;)]';
const TEMP = '[CreatedEntities(&quot;primaryEntity#Temp&quot;)]';

const xml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const vbString = (value) => `"${String(value).replace(/"/g, '""')}"`;
const compact = (id) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error(`Business rule id must be a GUID: ${id}`);
  return id.replace(/-/g, '').toLowerCase();
};
const ref = (name) => `mxswa:ActivityReference AssemblyQualifiedName="Microsoft.Crm.Workflow.Activities.${name}, ${CRM}"`;

// CreateCrmType parameters and XAML target type for a literal that is compared or assigned.
function crmType(value) {
  if (typeof value === 'boolean') return { params: `Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.Boolean, ${vbString(value ? 'True' : 'False')}`, type: 'x:Boolean' };
  if (Number.isInteger(value)) return { params: `Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.Integer, ${vbString(value)}`, type: 'x:Int32' };
  if (typeof value === 'string') return { params: `Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.String, ${vbString(value)}, "String"`, type: 'x:String' };
  throw new Error(`Unsupported business rule literal ${JSON.stringify(value)}`);
}
const createCrmType = (value, result) => {
  const { params, type } = crmType(value);
  return `<${ref('EvaluateExpression')} DisplayName="EvaluateExpression"><mxswa:ActivityReference.Arguments><InArgument x:TypeArguments="x:String" x:Key="ExpressionOperator">CreateCrmType</InArgument><InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { ${xml(params)} }]</InArgument><InArgument x:TypeArguments="s:Type" x:Key="TargetType"><mxswa:ReferenceLiteral x:TypeArguments="s:Type" Value="${type}" /></InArgument><OutArgument x:TypeArguments="x:Object" x:Key="Result">[${result}]</OutArgument></mxswa:ActivityReference.Arguments></mxswa:ActivityReference>`;
};

// One comparison: the attribute value into `value`, the result into `result`.
function compare({ field, ...test }, table, ruleName, value, literal, result) {
  const vars = [`<Variable x:TypeArguments="x:Object" Name="${value}" />`];
  let activities = `<mxswa:GetEntityProperty Attribute="${xml(field)}" Entity="${PRIMARY}" EntityName="${xml(table)}" Value="[${value}]"><mxswa:GetEntityProperty.TargetType><InArgument x:TypeArguments="s:Type"><mxswa:ReferenceLiteral x:TypeArguments="s:Type"><x:Null /></mxswa:ReferenceLiteral></InArgument></mxswa:GetEntityProperty.TargetType></mxswa:GetEntityProperty>`;
  const OPERATORS = { equals: 'Equal', notEqual: 'NotEqual', greaterThan: 'GreaterThan' };
  const key = Object.keys(OPERATORS).find((k) => k in test);
  let operator, parameters = '<x:Null x:Key="Parameters" />';
  if (test.isNull === true) operator = 'Null';
  else if (test.notNull === true) operator = 'NotNull';
  else if (key && (key !== 'greaterThan' || typeof test.greaterThan === 'number')) {
    operator = OPERATORS[key];
    vars.push(`<Variable x:TypeArguments="x:Object" Name="${literal}" />`);
    activities += createCrmType(test[key], literal);
    parameters = `<InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { ${literal} }]</InArgument>`;
  } else throw new Error(`Unsupported business rule condition in ${ruleName}`);
  activities += `<${ref('EvaluateCondition')} DisplayName="EvaluateCondition"><mxswa:ActivityReference.Arguments><InArgument x:TypeArguments="mxsq:ConditionOperator" x:Key="ConditionOperator">${operator}</InArgument>${parameters}<InArgument x:TypeArguments="x:Object" x:Key="Operand">[${value}]</InArgument><OutArgument x:TypeArguments="x:Boolean" x:Key="Result">[${result}]</OutArgument></mxswa:ActivityReference.Arguments></mxswa:ActivityReference>`;
  return { vars, activities };
}

// `when` alone, or `when` AND `guard` (the rule's no-op test on its target, e.g. "not already set"), joined as the
// workflow designer joins conditions: EvaluateLogicalCondition And.
function condition(rule) {
  const out = 'ConditionBranchStep2_condition';
  if (!rule.guard) {
    const { vars, activities } = compare(rule.when, rule.table, rule.name, 'ConditionBranchStep2_1', 'ConditionBranchStep2_2', out);
    return { vars: [`<Variable x:TypeArguments="x:Boolean" Default="False" Name="${out}" />`, ...vars], activities };
  }
  const left = compare(rule.when, rule.table, rule.name, 'ConditionBranchStep2_1', 'ConditionBranchStep2_2', 'ConditionBranchStep2_3');
  const right = compare(rule.guard, rule.table, rule.name, 'ConditionBranchStep2_4', 'ConditionBranchStep2_5', 'ConditionBranchStep2_6');
  const and = `<${ref('EvaluateLogicalCondition')} DisplayName="EvaluateLogicalCondition"><mxswa:ActivityReference.Arguments><InArgument x:TypeArguments="mxsq:LogicalOperator" x:Key="LogicalOperator">And</InArgument><InArgument x:TypeArguments="x:Boolean" x:Key="LeftOperand">[ConditionBranchStep2_3]</InArgument><InArgument x:TypeArguments="x:Boolean" x:Key="RightOperand">[ConditionBranchStep2_6]</InArgument><OutArgument x:TypeArguments="x:Boolean" x:Key="Result">[${out}]</OutArgument></mxswa:ActivityReference.Arguments></mxswa:ActivityReference>`;
  const flag = (name) => `<Variable x:TypeArguments="x:Boolean" Default="False" Name="${name}" />`;
  return { vars: [flag(out), flag('ConditionBranchStep2_3'), flag('ConditionBranchStep2_6'), ...left.vars, ...right.vars], activities: left.activities + right.activities + and };
}

// Stable label id per rule and step, so re-rendering a rule yields identical XAML.
const labelId = (seed) => createHash('sha1').update(seed).digest('hex').slice(0, 32).replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12})$/, '$1-$2-5$3-8$4-$5');

function action(table, a, step, ruleId) {
  const control = `ControlId="${xml(a.field)}" ControlType="standard" Entity="${PRIMARY}" EntityName="${xml(table)}"`;
  switch (a.type) {
    case 'visibility': return `<Sequence DisplayName="SetVisibilityStep${step}"><mcwc:SetVisibility ${control} IsVisible="${a.visible ? 'True' : 'False'}" /></Sequence>`;
    case 'lock': return `<Sequence DisplayName="SetDisplayModeStep${step}"><mcwc:SetDisplayMode ${control} IsReadOnly="${a.locked ? 'True' : 'False'}" /></Sequence>`;
    case 'required': return `<Sequence DisplayName="SetFieldRequiredLevelStep${step}"><mcwc:SetFieldRequiredLevel ${control} RequiredLevel="${a.required ? 'Required' : 'None'}" /></Sequence>`;
    case 'setValue':
    case 'setDefault': {
      const name = a.type === 'setValue' ? 'SetAttributeValue' : 'SetDefaultValue', v = `${name}Step${step}_1`;
      return `<Sequence DisplayName="${name}Step${step}"><Sequence.Variables><Variable x:TypeArguments="x:Object" Name="${v}" /></Sequence.Variables><Assign x:TypeArguments="mxs:Entity" To="${TEMP}" Value="[New Entity(&quot;${xml(table)}&quot;)]" /><Assign x:TypeArguments="s:Guid" To="[CreatedEntities(&quot;primaryEntity#Temp&quot;).Id]" Value="[InputEntities(&quot;primaryEntity&quot;).Id]" />${createCrmType(a.value, v)}<mxswa:SetEntityProperty Attribute="${xml(a.field)}" Entity="${TEMP}" EntityName="${xml(table)}" Value="[${v}]"><mxswa:SetEntityProperty.TargetType><InArgument x:TypeArguments="s:Type"><mxswa:ReferenceLiteral x:TypeArguments="s:Type" Value="${crmType(a.value).type}" /></InArgument></mxswa:SetEntityProperty.TargetType></mxswa:SetEntityProperty><mcwc:${name} DisplayName="${name}Step${step}" Entity="${TEMP}" EntityName="${xml(table)}" /><Assign x:TypeArguments="mxs:Entity" To="${PRIMARY}" Value="${TEMP}" /></Sequence>`;
    }
    // Learn's "Clear" variant of Set Field Value: assign Nothing with no CreateCrmType step.
    case 'clearValue': return `<Sequence DisplayName="SetAttributeValueStep${step}"><Assign x:TypeArguments="mxs:Entity" To="${TEMP}" Value="[New Entity(&quot;${xml(table)}&quot;)]" /><Assign x:TypeArguments="s:Guid" To="[CreatedEntities(&quot;primaryEntity#Temp&quot;).Id]" Value="[InputEntities(&quot;primaryEntity&quot;).Id]" /><mxswa:SetEntityProperty Attribute="${xml(a.field)}" Entity="${TEMP}" EntityName="${xml(table)}" Value="[Nothing]"><mxswa:SetEntityProperty.TargetType><InArgument x:TypeArguments="s:Type"><mxswa:ReferenceLiteral x:TypeArguments="s:Type"><x:Null /></mxswa:ReferenceLiteral></InArgument></mxswa:SetEntityProperty.TargetType></mxswa:SetEntityProperty><mcwc:SetAttributeValue DisplayName="SetAttributeValueStep${step}" Entity="${TEMP}" EntityName="${xml(table)}" /><Assign x:TypeArguments="mxs:Entity" To="${PRIMARY}" Value="${TEMP}" /></Sequence>`;
    case 'error': return `<Sequence DisplayName="SetMessageStep${step}"><mcwc:SetMessage ControlId="${xml(a.field)}" Entity="${PRIMARY}" EntityName="${xml(table)}" Level="[Nothing]"><mcwc:SetMessage.StepLabels><mcwo:StepLabel Description="${xml(a.message)}" LabelId="${labelId(`${ruleId}:${step}`)}" LanguageCode="1033" /></mcwc:SetMessage.StepLabels></mcwc:SetMessage></Sequence>`;
    default: throw new Error(`Unsupported business rule action ${a.type}`);
  }
}

const branch = (rule, step, test, actions, first, description) => `<${ref('ConditionBranch')} DisplayName="ConditionBranchStep${step}"><mxswa:ActivityReference.Arguments><InArgument x:TypeArguments="x:Boolean" x:Key="Condition">[${test}]</InArgument></mxswa:ActivityReference.Arguments><mxswa:ActivityReference.Properties><mxswa:ActivityReference x:Key="Then" AssemblyQualifiedName="Microsoft.Crm.Workflow.Activities.Composite, ${CRM}" DisplayName="ConditionBranchStep${step}"><mxswa:ActivityReference.Properties><sco:Collection x:TypeArguments="Variable" x:Key="Variables" /><sco:Collection x:TypeArguments="Activity" x:Key="Activities">${actions.map((a, i) => action(rule.table, a, first + i, rule.id)).join('')}</sco:Collection></mxswa:ActivityReference.Properties></mxswa:ActivityReference><x:Null x:Key="Else" /><x:String x:Key="Description">${xml(description)}</x:String></mxswa:ActivityReference.Properties></mxswa:ActivityReference>`;

export function businessRuleXaml(rule) {
  const id = compact(rule.id), cls = `XrmWorkflow${id}`, otherwise = rule.otherwise ?? [];
  const { vars, activities } = condition(rule);
  let body = activities + branch(rule, 2, 'ConditionBranchStep2_condition', rule.actions, 1, rule.name);
  if (otherwise.length) {
    vars.push('<Variable x:TypeArguments="x:Boolean" Default="False" Name="True" />', '<Variable x:TypeArguments="x:Object" Name="ConditionBranchStep3_1" />');
    body += createCrmType(true, 'ConditionBranchStep3_1') + branch(rule, 3, 'True', otherwise, rule.actions.length + 1, '');
  }
  return `<?xml version="1.0" encoding="utf-16"?><Activity x:Class="${cls}" ${NAMESPACES}><x:Members><x:Property Name="InputEntities" Type="InArgument(${DICT})" /><x:Property Name="CreatedEntities" Type="InArgument(${DICT})" /></x:Members><this:${cls}.InputEntities><InArgument x:TypeArguments="${DICT}" /></this:${cls}.InputEntities><this:${cls}.CreatedEntities><InArgument x:TypeArguments="${DICT}" /></this:${cls}.CreatedEntities><mva:VisualBasic.Settings>Assembly references and imported namespaces for internal implementation</mva:VisualBasic.Settings><mxswa:Workflow><${ref('ConditionSequence')} DisplayName="ConditionStep1"><mxswa:ActivityReference.Arguments><InArgument x:TypeArguments="x:Boolean" x:Key="Wait">False</InArgument></mxswa:ActivityReference.Arguments><mxswa:ActivityReference.Properties><sco:Collection x:TypeArguments="Variable" x:Key="Variables">${vars.join('')}</sco:Collection><sco:Collection x:TypeArguments="Activity" x:Key="Activities">${body}</sco:Collection><x:Boolean x:Key="ContainsElseBranch">False</x:Boolean></mxswa:ActivityReference.Properties></mxswa:ActivityReference></mxswa:Workflow></Activity>`;
}

const isEmpty = (v) => `((${v}) == undefined || (${v}) == null || (${v}) === "")`;
// Client data may be embedded in an HTML script after the XML is decoded.
const scriptLiteral = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

function clientAction(a, v, id) {
  const controls = (call) => `${v}.controls.forEach(function(c,i){c.${call};});`;
  switch (a.type) {
    case 'visibility': return controls(`setVisible(${Boolean(a.visible)})`);
    case 'lock': return controls(`setDisabled(${Boolean(a.locked)})`);
    case 'required': return `${v}.setRequiredLevel('${a.required ? 'required' : 'none'}');`;
    case 'setValue': return `${v}.setValue(${scriptLiteral(a.value)});`;
    case 'clearValue': return `${v}.setValue(null);`;
    case 'setDefault': return `if(formType===1 && ${isEmpty(`${v}.getValue()`)}){${v}.setValue(${scriptLiteral(a.value)});}`;
    case 'error': return controls(`setNotification(${scriptLiteral(a.message)},'${id}')`);
    default: throw new Error(`Unsupported business rule action ${a.type}`);
  }
}

export function businessRuleClientData(rule) {
  const id = compact(rule.id), otherwise = rule.otherwise ?? [], all = [...rule.actions, ...otherwise];
  const fields = [...new Set([rule.when.field, ...all.map((a) => a.field), ...(rule.guard ? [rule.guard.field] : [])])];
  const v = (field) => `v${fields.indexOf(field) + 1}`, value = `v${fields.length + 1}`;
  const check = (c, x) => c.isNull === true ? isEmpty(`(${x})`) : c.notNull === true ? `!${isEmpty(`(${x})`)}` : 'equals' in c ? `(${x}) === (${scriptLiteral(c.equals)})` : 'notEqual' in c ? `(${x}) !== (${scriptLiteral(c.notEqual)})` : `(${x}) != null && (${x}) > (${Number(c.greaterThan)})`;
  const test = check(rule.when, value) + (rule.guard ? ` && ${check(rule.guard, `${v(rule.guard.field)}.getValue()`)}` : '');
  const run = (list) => list.map((a) => clientAction(a, v(a.field), id)).join('');
  // A shown error is cleared once the condition no longer holds, as designer-generated rules do.
  const clear = rule.actions.filter((a) => a.type === 'error').map((a) => `${v(a.field)}.controls.forEach(function(c,i){c.clearNotification('${id}');});`).join('');
  const elseCode = run(otherwise) + clear;
  const formType = all.some((a) => a.type === 'setDefault') ? `var formType=(!Mscrm.BusinessRules.Utility.isNull(eventContext) && typeof eventContext.getFormContext === "function") ? eventContext.getFormContext().ui.getFormType() : Xrm.Page.ui.getFormType();` : '';
  const code = `function pbl_${id}(eventContext){try{var v0=(!Mscrm.BusinessRules.Utility.isNull(eventContext) && typeof eventContext.getFormContext === "function") ? eventContext.getFormContext().data.entity : Xrm.Page.data.entity;${fields.map((f) => `var ${v(f)}=v0.attributes.get(${scriptLiteral(f)});`).join('')}if (${fields.map((f) => isEmpty(v(f))).join(' || ')}){return;}${formType}var ${value}=(v1) ? v1.getValue() : null;if(${test}){${run(rule.actions)}}${elseCode ? `else if(true){${elseCode}}` : ''}}catch (e){Mscrm.BusinessRules.ErrorHandlerFactory.getHandler(e, arguments.callee).handleError();}}`;
  if (code.includes(']]>')) throw new Error('Business rule client code cannot contain a CDATA terminator.');
  return `<clientdata><labels></labels><clientcode><![CDATA[${code}]]></clientcode></clientdata>`;
}

