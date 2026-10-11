import test from 'node:test';
import assert from 'node:assert/strict';
import {DataStore} from '../lib/data.mjs';
import {createFlowTriggerRunner} from '../lib/flow-triggers.mjs';
import {operationCatalogue} from '../lib/operation-catalogue.mjs';
const id='10000000-0000-0000-0000-000000000001',user='20000000-0000-0000-0000-000000000001';
const profile={userId:user,evidence:'Invented explicit flow owner',grants:[{entity:'widget',operations:['read']},{entity:'audit',operations:['read','create']}]};
const source=(message=4,filter="title eq 'Allowed'")=>({properties:{definition:{
 triggers:{row:{type:'OpenApiConnectionWebhook',inputs:{host:{apiId:'/apis/shared_commondataserviceforapps',operationId:'SubscribeWebhookTrigger'},parameters:{'subscriptionRequest/message':message,'subscriptionRequest/entityname':'widget','subscriptionRequest/scope':4,'subscriptionRequest/filteringattributes':'title',...(filter?{'subscriptionRequest/filterexpression':filter}:{})}}}},
 actions:{create:{type:'OpenApiConnection',inputs:{host:{apiId:'/apis/shared_commondataserviceforapps',operationId:'CreateRecord'},parameters:{entityName:'audits','item/message':"@triggerOutputs()['body/SdkMessage']"}}}}
}}});
const data=()=>new DataStore({state:{version:1,mappings:{widget:{entitySet:'widgets',idColumn:'widgetid',fields:{title:{type:'string'},parentid:{type:'lookup'}}},audit:{entitySet:'audits',idColumn:'auditid'}},tables:{widget:[],audit:[]},permissions:[],plugins:[],settings:{permissionMode:'enforce'}}});
function setup(t,{message=4,filter,active=true,overrides={}}={}){const store=data(),workflow={file:'/invented/flow.json',active,activation:{sourceValue:active?1:0},definition:source(message,filter)},workflows=new Map([[id,workflow]]),identities=new Map([[id,profile]]),notes=[];const runner=createFlowTriggerRunner({store,workflows:()=>workflows,identities:()=>identities,items:()=>operationCatalogue({portal:{},workflows,handlers:{flowIdentities:identities},overrides}),diagnostic:n=>notes.push(n)});t.after(()=>runner.close());return {store,workflow,runner,notes};}
test('Activated imported row trigger runs post-save on create and submitted unchanged update, with scalar source filters',async t=>{
 const {store,runner,notes}=setup(t);const row=await store.create('widget',{title:'Allowed'},{admin:true});await runner.drain();assert.equal(store.snapshot().tables.audit[0].message,'Create');
 await store.update('widget',row.widgetid,{description:'Unrelated'},{admin:true});await runner.drain();assert.equal(store.snapshot().tables.audit.length,1);
 await store.update('widget',row.widgetid,{title:'Allowed'},{admin:true});await runner.drain();assert.equal(store.snapshot().tables.audit.length,2);assert.equal(store.snapshot().tables.audit[1].message,'Update');
 await store.update('widget',row.widgetid,{title:'Filtered'},{admin:true});await runner.drain();assert.equal(store.snapshot().tables.audit.length,2);assert.ok(notes.some(n=>n.code==='FLOW_TRIGGER_COMPLETED'));await runner.close();assert.deepEqual(runner.status(),{pending:0,closed:true});
});
test('Rolled-back primary writes emit no flow; committed PreValidation SDK writes retain their events',async t=>{
 const {store,runner}=setup(t,{filter:''});store.setPluginPipeline(({entity,stage})=>{if(entity==='widget'&&stage===20)throw Error('Rejected primary');},({entity})=>entity==='widget');await assert.rejects(store.create('widget',{title:'Rejected'},{admin:true}),/Rejected primary/);await runner.drain();assert.equal(store.snapshot().tables.audit.length,0);
 store.setPluginPipeline(({entity,stage,target})=>{if(entity==='audit'&&stage===10&&target.message==='Rejected'){store.sdkMutation(()=>store.createRecord('widget',{title:'Independent'},{admin:true}));throw Error('Later primary rejection');}},({entity})=>entity==='audit');await assert.rejects(store.create('audit',{message:'Rejected'},{admin:true}),/Later primary rejection/);await runner.drain();assert.equal(store.snapshot().tables.widget.length,1);assert.equal(store.snapshot().tables.audit.length,1);
});
test('Triggered action failure preserves earlier connector write and never rejects committed caller',async t=>{
 const {store,workflow,runner,notes}=setup(t,{filter:''});workflow.definition.properties.definition.actions.failure={type:'Terminate',runAfter:{create:['Succeeded']},inputs:{runStatus:'Failed',runError:{message:'Later flow failure'}}};
 const row=await store.create('widget',{title:'Committed'},{admin:true});await runner.drain();assert.equal(store.snapshot().tables.widget[0].widgetid,row.widgetid);assert.equal(store.snapshot().tables.audit.length,1);assert.ok(notes.some(n=>n.code==='FLOW_TRIGGER_FAILED'));
});
test('Draft sources never auto-enable and explicit source mock or disabled choice remains available',async t=>{
 const {store,runner,notes}=setup(t,{active:false,filter:''});await store.create('widget',{title:'Draft source'},{admin:true});await runner.drain();assert.equal(store.snapshot().tables.audit.length,0);assert.ok(notes.some(n=>n.code==='FLOW_TRIGGER_PLACEHOLDER'));
});
test('Combined deleted trigger uses retained local snapshot and ignores update-only select columns',async t=>{
 const {store,runner}=setup(t,{message:5,filter:''});const row=await store.create('widget',{description:'No selected title'},{admin:true});await runner.drain();await store.remove('widget',row.widgetid,{admin:true});await runner.drain();assert.deepEqual(store.snapshot().tables.audit.map(r=>r.message),['Create','Delete']);
});
test('Explicit mock/disabled choices do not require original activation or backend connection; manual activation is traced',async t=>{
 const key='cloud-flow:'+id,{store,runner,notes,workflow}=setup(t,{active:false,filter:'',overrides:{[key]:{mode:'mock'}}});await store.create('widget',{title:'Mocked draft'},{admin:true});await runner.drain();assert.ok(notes.some(n=>n.code==='FLOW_TRIGGER_MOCK'&&n.sourceActivation===false));assert.equal(store.snapshot().tables.audit.length,0);
 await runner.close();const manual=createFlowTriggerRunner({store,workflows:()=>new Map([[id,workflow]]),identities:()=>new Map([[id,profile]]),items:()=>operationCatalogue({portal:{},workflows:new Map([[id,workflow]]),handlers:{flowIdentities:new Map([[id,profile]])},overrides:{[key]:{mode:'exported',activation:'local-enabled'}}}),diagnostic:n=>notes.push(n)});t.after(()=>manual.close());await store.create('widget',{title:'Explicit local activation'},{admin:true});await manual.drain();assert.equal(store.snapshot().tables.audit.length,1);assert.ok(notes.some(n=>n.code==='FLOW_TRIGGER_ACTIVATION_OVERRIDE'));assert.equal(workflow.active,false);
});
test('Empty source select list means no filter; lookup fields and unknown kinds do not become scalar filters',async t=>{
 const {store,runner,workflow,notes}=setup(t,{filter:''}),parameters=workflow.definition.properties.definition.triggers.row.inputs.parameters;parameters['subscriptionRequest/filteringattributes']='';const row=await store.create('widget',{title:'Initial'},{admin:true});await runner.drain();await store.update('widget',row.widgetid,{description:'No select filter'},{admin:true});await runner.drain();assert.equal(store.snapshot().tables.audit.length,2);
 parameters['subscriptionRequest/filteringattributes']='parentid';await store.update('widget',row.widgetid,{parentid:null},{admin:true});await runner.drain();assert.equal(store.snapshot().tables.audit.length,2);parameters['subscriptionRequest/filteringattributes']='unknown';await store.update('widget',row.widgetid,{unknown:'No metadata'},{admin:true});await runner.drain();assert.ok(notes.some(n=>n.code==='FLOW_TRIGGER_FAILED'&&/field kind/.test(n.error.message)));assert.equal(store.snapshot().tables.audit.length,2);
});
