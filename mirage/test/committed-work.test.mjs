import test from 'node:test';
import assert from 'node:assert/strict';
import {DataStore} from '../lib/data.mjs';
import {createAsyncPluginRunner} from '../lib/plugin-async.mjs';
import {createFlowTriggerRunner} from '../lib/flow-triggers.mjs';
import {settleCommittedWork} from '../lib/committed-work.mjs';
import {pluginCatalogue} from '../lib/exported-plugins.mjs';
import {operationCatalogue} from '../lib/operation-catalogue.mjs';
const id='10000000-0000-0000-0000-000000000001',user='20000000-0000-0000-0000-000000000001';
for(const rootEntity of ['widget','audit'])test('Coordinated stop drains '+rootEntity+'→other consumer→original consumer committed work',async()=>{
 const store=new DataStore({state:{version:1,mappings:{widget:{entitySet:'widgets',idColumn:'widgetid'},audit:{entitySet:'audits',idColumn:'auditid'}},tables:{widget:[],audit:[]},permissions:[],plugins:[],settings:{permissionMode:'enforce'}}}),acceptedChains=new Set(),notes=[];
 const step={id,name:'Invented asynchronous producer',enabled:true,entity:'widget',message:'Create',stage:40,rank:1,mode:1,typeName:'Invented',assemblyId:'Invented',supportedDeployment:0,images:[],filteringAttributes:[]},handlers=new Map([[id,context=>{if(context.record.title==='Root')store.sdkMutation(()=>store.createRecord('audit',{title:'Child'},{admin:true}));}]]);
 const trigger={type:'OpenApiConnectionWebhook',inputs:{host:{apiId:'/apis/shared_commondataserviceforapps',operationId:'SubscribeWebhookTrigger'},parameters:{message:1,entityname:'audit',scope:4,filteringattributes:''}}};
 const action={type:'OpenApiConnection',inputs:{host:{apiId:'/apis/shared_commondataserviceforapps',operationId:'CreateRecord'},parameters:{entityName:'widgets','item/title':"@if(equals(triggerBody()?['title'],'Root'),'Root','Done')"}}};
 const workflow={file:'/invented.json',active:true,definition:{properties:{definition:{triggers:{row:trigger},actions:{create:action}}}}},workflows=new Map([[id,workflow]]),identities=new Map([[id,{userId:user,evidence:'Invented backend',grants:[{entity:'audit',operations:['read']},{entity:'widget',operations:['create']}]}]]);

 const flows=createFlowTriggerRunner({store,workflows:()=>workflows,identities:()=>identities,items:()=>operationCatalogue({portal:{},workflows,handlers:{flowIdentities:identities}}),acceptedChains,diagnostic:n=>notes.push(n)}),plugins=createAsyncPluginRunner({store,items:()=>pluginCatalogue({plugins:{steps:[step]},handlers}),handlers,runtimes:new Map(),acceptedChains,diagnostic:n=>notes.push(n)});
 await store.transact(()=>{for(const e of [{entity:rootEntity,operation:'create',row:{[rootEntity+'id']:id,title:'Root'},target:{title:'Root'},submittedAttributes:['title']}])store.recordCommittedEvent(e.entity,e.operation,e.row,e.submittedAttributes,{target:e.target});});await settleCommittedWork(store,[flows,plugins],{close:true});assert.equal(store.snapshot().tables.audit.length,1);assert.equal(store.snapshot().tables.widget.length,rootEntity==='audit'?2:1);assert.deepEqual(flows.status(),{pending:0,closed:true});assert.deepEqual(plugins.status(),{pending:0,closed:true});assert.ok(!notes.some(n=>/FAILED|STOPPED/.test(n.code)));
});
