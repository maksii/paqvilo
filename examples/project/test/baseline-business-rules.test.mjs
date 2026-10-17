import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {metadataXml} from 'paqvilo/lense/dataverse/provision.mjs';
import {businessRuleXaml,businessRuleClientData} from '../baseline/business-rules.mjs';
import {ruleFingerprint} from '../baseline/provision.mjs';

// The toolkit parser rejects XAML property-element names (Type.Member), which are valid XML: rename them before parsing.
const wellFormed=xaml=>metadataXml(xaml.replace(/^<\?xml[^>]*\?>/,'').replace(/(<\/?[\w:-]+)\.(?=\w)/g,'$1_'));
const {businessRules}=JSON.parse(fs.readFileSync(new URL('../baseline/dataverse/extras.json',import.meta.url),'utf8'));

test('business rule fingerprints match exported fixture XAML after platform serialization',()=>{
 const directory=new URL('../baseline/solution/Workflows/',import.meta.url);
 const workflows=fs.readdirSync(directory).filter(name=>name.endsWith('.xaml')).map(name=>fs.readFileSync(new URL(name,directory),'utf8'));
 for(const rule of businessRules){
  const stored=workflows.find(xaml=>xaml.includes('XrmWorkflow'+rule.id.replaceAll('-','')));
  assert.ok(stored,rule.name);
  assert.equal(ruleFingerprint(stored),ruleFingerprint(businessRuleXaml(rule)),rule.name);
 }
});

test('business rule fingerprints retain comparison and assignment literals, message text and action order',()=>{
 const rule={id:'12345678-1234-4567-8123-123456789abc',name:'Synthetic literals',table:'exa_record',when:{field:'exa_flag',equals:true},guard:{field:'exa_count',greaterThan:3},actions:[{type:'setValue',field:'exa_text',value:'  A "quoted" value  '},{type:'setDefault',field:'exa_number',value:42},{type:'error',field:'exa_text',message:'  A < B & C  '}],otherwise:[{type:'clearValue',field:'exa_text'}]};
 const fingerprint=value=>ruleFingerprint(businessRuleXaml(value)),before=fingerprint(rule);
 const changes=[
  value=>value.when.equals=false,
  value=>value.guard.greaterThan=4,
  value=>value.actions[0].value=' A "quoted" value  ',
  value=>value.actions[1].value=43,
  value=>value.actions[1].value='42',
  value=>value.actions[2].message='A < B & C',
  value=>value.actions[2].field='exa_number',
  value=>value.actions.reverse(),
  value=>value.otherwise=[],
 ];
 for(const change of changes){const changed=structuredClone(rule);change(changed);assert.notEqual(fingerprint(changed),before,change.toString());}
 const xaml=businessRuleXaml(rule);
 const serialized=xaml.replaceAll('xmlns:mxswa=','xmlns:wf=').replaceAll('mxswa:','wf:').replaceAll('xmlns:x=','xmlns:xx=').replaceAll('x:','xx:').replaceAll('&quot;','&#34;').replaceAll('[New Object()','[ New\n Object()').replaceAll('DisplayName="EvaluateExpression"','DisplayName="Generated designer label"').replace(/LabelId="[^"]+"/g,'LabelId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"').replace(/></g,'>\n  <');
 assert.equal(ruleFingerprint(serialized),before);
 assert.equal(ruleFingerprint(null),null);
 assert.throws(()=>ruleFingerprint('<broken>'),/XML|FetchXML/);
 assert.throws(()=>ruleFingerprint('<Activity/>'),/no executable Workflow/);
});

test('baseline business rules render well-formed XAML and executable client code',()=>{
 assert.equal(businessRules.length,9);
 for(const rule of businessRules){
  const id=rule.id.replace(/-/g,'');
  const xaml=businessRuleXaml(rule);
  assert.doesNotThrow(()=>wellFormed(xaml),rule.name);
  assert.ok(xaml.includes(`x:Class="XrmWorkflow${id}"`),rule.name);
  for(const action of [...rule.actions,...(rule.otherwise??[])]) assert.match(xaml,new RegExp(`(Attribute|ControlId)="${action.field}"`),`${rule.name} ${action.type}`);
  assert.ok(xaml.includes(`Attribute="${rule.when.field}"`),rule.name);
  assert.equal(xaml.includes('ConditionBranchStep3'),Boolean(rule.otherwise?.length),rule.name);
  const client=businessRuleClientData(rule);
  const code=client.match(/^<clientdata><labels><\/labels><clientcode><!\[CDATA\[([\s\S]*)\]\]><\/clientcode><\/clientdata>$/)?.[1];
  assert.ok(code?.startsWith(`function pbl_${id}(eventContext)`),rule.name);
  const fn=new Function(`${code};return pbl_${id};`)();
  assert.equal(typeof fn,'function');
  for(const field of new Set([rule.when.field,...rule.actions.map(a=>a.field)])) assert.ok(code.includes(`attributes.get(${JSON.stringify(field)})`),`${rule.name} ${field}`);
 }
});

test('baseline business rule client code applies actions and otherwise branches',()=>{
 const run=(rule,values)=>{
  const id=rule.id.replace(/-/g,''),calls=[];
  const attr=name=>({getValue:()=>values[name]??null,setValue:v=>calls.push([name,'value',v]),setRequiredLevel:v=>calls.push([name,'required',v]),controls:[{setVisible:v=>calls.push([name,'visible',v]),setDisabled:v=>calls.push([name,'disabled',v]),setNotification:m=>calls.push([name,'error',m]),clearNotification:()=>calls.push([name,'clear'])}]});
  const ctx={getFormContext:()=>({data:{entity:{attributes:{get:attr}}},ui:{getFormType:()=>1}})};
  const Mscrm={BusinessRules:{Utility:{isNull:v=>v==null},ErrorHandlerFactory:{getHandler:e=>({handleError(){throw e;}})}}};
  new Function('Mscrm',`${businessRuleClientData(rule).match(/CDATA\[([\s\S]*)\]\]>/)[1]};return pbl_${id};`)(Mscrm)(ctx);
  return calls;
 };
 const [hide,lock,require,dflt,set,error,clear,allForms,form]=businessRules;
 assert.deepEqual(run(hide,{pqvd_flag:false}),[['pqvd_hiddenbyrule','visible',false]]);
 assert.deepEqual(run(hide,{pqvd_flag:true}),[['pqvd_hiddenbyrule','visible',true]]);
 assert.deepEqual(run(lock,{pqvd_flag:true}),[['pqvd_lockedbyrule','disabled',true]]);
 assert.deepEqual(run(require,{pqvd_text:'require'}),[['pqvd_requiredbyrule','required','required']]);
 assert.deepEqual(run(require,{pqvd_text:'x'}),[['pqvd_requiredbyrule','required','none']]);
 assert.deepEqual(run(dflt,{}),[['pqvd_defaultbyrule','value','rule default']]);
 assert.deepEqual(run(set,{pqvd_flag:false}),[]);
 assert.deepEqual(run(set,{pqvd_flag:true}),[['pqvd_setbyrule','value','set by rule']]);
 assert.deepEqual(run(error,{pqvd_ruleerror:501}),[['pqvd_ruleerror','error','Rule error must be 500 or less']]);
 assert.deepEqual(run(error,{pqvd_ruleerror:500}),[['pqvd_ruleerror','clear']]);
 assert.deepEqual(run(clear,{pqvd_flag:false,pqvd_setbyrule:'x'}),[['pqvd_setbyrule','value',null]]);
 assert.deepEqual(run(clear,{pqvd_flag:true,pqvd_setbyrule:'x'}),[]);
 assert.deepEqual(run(allForms,{pqvd_text:'all-forms',pqvd_recommended:'x'}),[['pqvd_recommended','required','required']]);
 assert.deepEqual(run(form,{pqvd_text:'form-scope',pqvd_recommended:'x'}),[['pqvd_recommended','visible',false]]);

});

test('baseline business rules declare entity, all-forms and form scopes',()=>{
 const [,,,,,,clear,allForms,form]=businessRules;
 assert.deepEqual(businessRules.map(r=>r.scope),['entity','entity','entity','entity','entity','entity','entity','all-forms','form']);
 const {forms}=JSON.parse(fs.readFileSync(new URL('../baseline/dataverse/extras.json',import.meta.url),'utf8'));
 assert.equal(form.formId,forms.find(f=>f.name==='Baseline Item'&&f.type===2).id);
 assert.equal(allForms.formId,undefined);
 const xaml=businessRuleXaml(clear);
 assert.ok(xaml.includes(`<mxswa:SetEntityProperty Attribute="pqvd_setbyrule" Entity="[CreatedEntities(&quot;primaryEntity#Temp&quot;)]" EntityName="pqvd_baselineitem" Value="[Nothing]">`));
 assert.ok(!xaml.includes('CreateCrmType</InArgument><InArgument x:TypeArguments="s:Object[]" x:Key="Parameters">[New Object() { Microsoft.Xrm.Sdk.Workflow.WorkflowPropertyType.String'),'clear assigns no literal');
});
