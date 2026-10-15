import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBusinessRule, businessRuleMetadata, applicableBusinessRules } from '../lib/business-rules.mjs';

// Invented rules in the designer's XAML shape (table "sample").
const NS = 'xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:mcwc="c" xmlns:mcwo="o" xmlns:mxswa="w" xmlns:sco="s" xmlns:x="x"';
const ref = (name) => `mxswa:ActivityReference AssemblyQualifiedName="Microsoft.Crm.Workflow.Activities.${name}, Microsoft.Crm.Workflow, Version=9.0.0.0"`;
const literal = (type, value, out) => `<${ref('EvaluateExpression')}><mxswa:ActivityReference.Arguments><InArgument x:Key="ExpressionOperator">CreateCrmType</InArgument><InArgument x:Key="Parameters">[New Object() { Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.${type}, "${value}" }]</InArgument><OutArgument x:Key="Result">[${out}]</OutArgument></mxswa:ActivityReference.Arguments></mxswa:ActivityReference>`;
const branch = (condition, actions) => `<${ref('ConditionBranch')}><mxswa:ActivityReference.Arguments><InArgument x:Key="Condition">[${condition}]</InArgument></mxswa:ActivityReference.Arguments><mxswa:ActivityReference.Properties><${ref('Composite')} x:Key="Then"><mxswa:ActivityReference.Properties><sco:Collection x:Key="Activities">${actions}</sco:Collection></mxswa:ActivityReference.Properties></mxswa:ActivityReference></mxswa:ActivityReference.Properties></mxswa:ActivityReference>`;
const rule = ({ field, operator, type, value, then, otherwise = '' }) => `<Activity ${NS}><mxswa:Workflow><${ref('ConditionSequence')}><mxswa:ActivityReference.Properties><sco:Collection x:Key="Activities">`
  + `<mxswa:GetEntityProperty Attribute="${field}" EntityName="sample" Value="[v1]" />${type ? literal(type, value, 'v2') : ''}`
  + `<${ref('EvaluateCondition')}><mxswa:ActivityReference.Arguments><InArgument x:Key="ConditionOperator">${operator}</InArgument><InArgument x:Key="Parameters">[New Object() { ${type ? 'v2' : ''} }]</InArgument><InArgument x:Key="Operand">[v1]</InArgument><OutArgument x:Key="Result">[c]</OutArgument></mxswa:ActivityReference.Arguments></mxswa:ActivityReference>`
  + branch('c', then) + (otherwise ? branch('True', otherwise) : '') + '</sco:Collection></mxswa:ActivityReference.Properties></mxswa:ActivityReference></mxswa:Workflow></Activity>';
const setValue = (field, type, value, kind = 'SetAttributeValue') => `<Sequence><Assign />${type ? literal(type, value, 's1') : ''}<mxswa:SetEntityProperty Attribute="${field}" EntityName="sample" Value="[${type ? 's1' : 'Nothing'}]" /><mcwc:${kind} EntityName="sample" /></Sequence>`;

test('business rules evaluate the designer condition branches and their effects', () => {
  const visibility = rule({ field: 'active', operator: 'Equal', type: 'Boolean', value: 'False',
    then: '<Sequence><mcwc:SetVisibility ControlId="notes" IsVisible="False" /></Sequence>',
    otherwise: '<Sequence><mcwc:SetVisibility ControlId="notes" IsVisible="True" /></Sequence>' });
  assert.deepEqual(evaluateBusinessRule(visibility, { active: false }), [{ type: 'visibility', field: 'notes', visible: false }]);
  assert.deepEqual(evaluateBusinessRule(visibility, { active: true }), [{ type: 'visibility', field: 'notes', visible: true }]);

  const limit = rule({ field: 'score', operator: 'GreaterThan', type: 'Integer', value: '10',
    then: '<Sequence><mcwc:SetMessage ControlId="score"><mcwc:SetMessage.StepLabels><mcwo:StepLabel Description="Too high" LanguageCode="1033" /></mcwc:SetMessage.StepLabels></mcwc:SetMessage></Sequence>'
      + '<Sequence><mcwc:SetDisplayMode ControlId="title" IsReadOnly="True" /></Sequence><Sequence><mcwc:SetFieldRequiredLevel ControlId="reason" RequiredLevel="Required" /></Sequence>' });
  assert.deepEqual(evaluateBusinessRule(limit, { score: 11 }), [
    { type: 'error', field: 'score', message: 'Too high' }, { type: 'lock', field: 'title', locked: true }, { type: 'required', field: 'reason', level: 'Required' }]);
  assert.deepEqual(evaluateBusinessRule(limit, { score: 10 }), []);
  assert.deepEqual(evaluateBusinessRule(limit, {}), [], 'an empty operand never satisfies a comparison');

  const values = rule({ field: 'title', operator: 'Null', then: setValue('title', 'String', 'say ""hi""', 'SetDefaultValue') + setValue('code', null, null) });
  assert.deepEqual(evaluateBusinessRule(values, { title: '' }), [{ type: 'setDefault', field: 'title', value: 'say "hi"' }, { type: 'setValue', field: 'code', value: null }]);
  assert.deepEqual(evaluateBusinessRule(values, { title: 'x' }), []);

  assert.throws(() => evaluateBusinessRule(rule({ field: 'a', operator: 'Like', type: 'String', value: 'x', then: '' }), { a: 'x' }), /Unsupported business rule operator Like/);
  assert.throws(() => evaluateBusinessRule(rule({ field: 'a', operator: 'Null', then: '<mcwc:Recommend ControlId="a" />' }), {}), /Unsupported business rule element mcwc:Recommend/);
});

test('business rule metadata selects active rules by entity, all-forms and one-form scope', () => {
  const data = (id, scope, form = '', state = 1) => `<Workflow WorkflowId="{${id}}" Name="R"><Category>2</Category><StateCode>${state}</StateCode><PrimaryEntity>sample</PrimaryEntity><ProcessTriggerScope>${scope}</ProcessTriggerScope>${form ? `<ProcessTriggerFormId>{${form}}</ProcessTriggerFormId>` : ''}</Workflow>`;
  const ids = ['00000000-0000-4000-8000-00000000000' + 1, '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004'];
  const form = 'AAAAAAAA-0000-4000-8000-000000000001';
  const rules = [data(ids[0], 2), data(ids[1], 1), data(ids[2], 1, form), data(ids[3], 2, '', 0)].map(businessRuleMetadata);
  assert.deepEqual(rules.map((item) => [item.scope, item.active]), [['entity', true], ['all-forms', true], ['form', true], ['entity', false]]);
  assert.deepEqual(applicableBusinessRules(rules, { entity: 'sample' }).map((item) => item.id), [ids[0]]);
  assert.deepEqual(applicableBusinessRules(rules, { entity: 'sample', formId: form }).map((item) => item.id), ids.slice(0, 3));
  assert.deepEqual(applicableBusinessRules(rules, { entity: 'sample', formId: 'bbbbbbbb-0000-4000-8000-000000000001' }).map((item) => item.id), ids.slice(0, 2));
  assert.equal(businessRuleMetadata('<Workflow WorkflowId="{x}"><Category>0</Category></Workflow>'), null);
});
