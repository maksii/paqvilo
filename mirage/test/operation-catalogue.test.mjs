import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { operationCatalogue, validateOperationOverrides } from '../lib/operation-catalogue.mjs';
import { operationFixture } from './operation-fixture.mjs';


const flow = 'f0000000-0000-4000-8000-000000000002';
const standalone = 'f0000000-0000-4000-8000-000000000003';

test('catalogue discovery covers consumers and unlinked solution workflows without guessed routes', () => {
  const items = operationCatalogue({portal:{serverLogics:[{id:'logic',name:'Calculate',file:'/invented.js'}],cloudFlows:[{id:'consumer',name:'Echo',processId:flow,path:'/_api/cloudflow/echo'}]},workflows:new Map([[flow,{file:'/echo.json'}],[standalone,{name:'Unlinked',file:'/unlinked.json'}]])});
  assert.equal(items.length,3);
  assert.equal(items[0].mode,'placeholder');
  assert.equal(items[1].mode,'placeholder');
  assert.equal(items[2].path,null);
  assert.equal(items[2].configurable,true);
  assert.equal(items[2].mode,'placeholder');
  assert.equal(items[2].contract.supported,false);
  assert.throws(()=>validateOperationOverrides({'server-logic:logic':{mode:'eval'}}),/mode/);
  assert.throws(()=>validateOperationOverrides({'server-logic:logic':{mode:'mock',status:201.5}}),/integer/);
  assert.throws(()=>validateOperationOverrides({'server-logic:logic':{mode:'mock',url:'https://invalid.example'}}),/Unknown/);
});

test('enhanced solution-only server logic is discovered for the selected website, opt-in and reload follow its real source', async t => {
  const {app,dir}=await operationFixture(t,{solutionComponents:true});
  const items=(await (await fetch(app.url+'/__sim/api/operations')).json()).items;
  const selected=items.filter(item=>item.name==='Solution logic');
  assert.equal(selected.length,1);
  assert.equal(selected[0].mode,'placeholder');
  const configure=await fetch(app.url+'/__sim/api/operations/'+encodeURIComponent(selected[0].key),{method:'PATCH',headers:{'content-type':'application/json','x-sim-csrf':app.csrf},body:'{"mode":"exported"}'});
  assert.equal(configure.status,200);
  assert.deepEqual(JSON.parse((await (await fetch(app.url+selected[0].path)).json()).data),{fromSolution:true});
  const before=app.state().status.sourceFingerprint;
  await fs.writeFile(path.join(dir,'solution/powerpagecomponents/logic/filecontent/logic.sl'),'function get(){return JSON.stringify({reloaded:true});}');
  await app.reload();
  assert.notEqual(app.state().status.sourceFingerprint,before);
  assert.deepEqual(JSON.parse((await (await fetch(app.url+selected[0].path)).json()).data),{reloaded:true});
});

test('discovered placeholders, automatic declarative flows and editable responses stay local and role guarded', async t => {
  const {app}=await operationFixture(t);
  const csrf=app.csrf;
  const admin = (route,method='GET',body) => fetch(app.url+'/__sim/api'+route,{method,headers:{'content-type':'application/json','x-sim-csrf':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const inventory=await (await admin('/operations')).json();
  assert.equal(inventory.items.length,3);
  const logic=inventory.items.find(item=>item.kind==='server-logic');
  assert.equal(logic.mode,'placeholder');
  assert.equal((await fetch(app.url+logic.path)).status,501);
  const echo=inventory.items.find(item=>item.name==='Echo');
  assert.equal(echo.mode,'exported');
  const trigger=body=>fetch(app.url+echo.path,{method:'POST',headers:{'content-type':'application/json',__RequestVerificationToken:csrf},body:JSON.stringify(body)});
  assert.deepEqual(await (await trigger({eventData:JSON.stringify({Message:'Local'})})).json(),{Message:'Local'});
  assert.equal((await trigger({Message:12})).status,400);
  const route='/operations/'+encodeURIComponent(logic.key);
  assert.equal((await fetch(app.url+'/__sim/api'+route,{method:'PATCH',headers:{'content-type':'application/json'},body:'{"mode":"mock"}'})).status,403);
  assert.equal((await admin(route,'PATCH',{mode:'mock',status:200,body:{edited:true}})).status,200);
  assert.deepEqual(JSON.parse((await (await fetch(app.url+logic.path)).json()).data),{edited:true});
  assert.equal((await admin(route,'PATCH',{mode:'exported'})).status,200);
  assert.deepEqual(JSON.parse((await (await fetch(app.url+logic.path)).json()).data),{source:true});
  assert.equal((await admin(route,'DELETE')).status,200);
  assert.equal((await fetch(app.url+logic.path)).status,501);
  assert.equal((await admin('/operations/'+encodeURIComponent('cloud-flow:'+standalone),'PATCH',{mode:'mock'})).status,200);
  const unlinked=(await (await admin('/operations')).json()).items.find(item=>item.processId===standalone);
  assert.equal(unlinked.mode,'mock');
  assert.equal(unlinked.path,null);
  // A mocked flow without a Request trigger still has no route: the trigger answers the local not-implemented error.
  const unrouted=await fetch(app.url+'/_api/cloudflow/v1.0/trigger/'+standalone,{method:'POST',headers:{'content-type':'application/json',__RequestVerificationToken:csrf},body:'{}'});
  assert.equal(unrouted.status,501);assert.equal((await unrouted.json()).error.code,'NotImplemented');
  assert.equal((await admin(route,'PATCH',{mode:'handler'})).status,409);
  assert.equal((await admin('/config','PATCH',{identity:{id:'person',roles:[],roleSource:'override'}})).status,200);
  assert.equal((await trigger({Message:'Blocked'})).status,403);
  assert.equal((await fetch(app.url+logic.path)).status,403);
  assert.equal((await admin('/operations/'+encodeURIComponent(echo.key),'PATCH',{mode:'mock',body:{secret:true}})).status,200);
  assert.equal((await trigger({Message:'Still blocked'})).status,403);
});

test('unlinked Request configuration does not invent an endpoint; activated Dataverse sources require a backend profile',()=>{
  const request={file:'/invented-request.json',active:true,definition:{properties:{definition:{triggers:{request:{type:'Request',kind:'powerpages',inputs:{schema:{type:'object'}}}},actions:{response:{type:'Response',kind:'powerpages',inputs:{statusCode:200,body:'owned'}}}}}}};
  const automatic={file:'/invented-row.json',active:true,definition:{properties:{definition:{triggers:{row:{type:'OpenApiConnectionWebhook',inputs:{host:{apiId:'/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',operationId:'SubscribeWebhookTrigger'},parameters:{'subscriptionRequest/entityname':'widget','subscriptionRequest/message':4,'subscriptionRequest/scope':4,'subscriptionRequest/filteringattributes':''}}}},actions:{message:{type:'Compose',inputs:"@triggerBody()?['SdkMessage']"}}}}}};
  const catalogue=(workflow,handlers)=>operationCatalogue({portal:{},workflows:new Map([[standalone,workflow]]),handlers})[0];
  const sourceOnly=catalogue(request);
  assert.equal(sourceOnly.configurable,true);assert.equal(sourceOnly.path,null);assert.equal(sourceOnly.mode,'placeholder');
  const mocked=operationCatalogue({portal:{},workflows:new Map([[standalone,request]]),overrides:{['cloud-flow:'+standalone]:{mode:'mock'}}})[0];
  assert.equal(mocked.mode,'mock');assert.equal(mocked.path,null);
  assert.equal(catalogue(automatic).mode,'placeholder');
  const handlers={flowIdentities:new Map([[standalone,{userId:'invented-backend'}]])};
  assert.equal(catalogue(automatic,handlers).mode,'exported');
  assert.equal(catalogue({...automatic,active:false},handlers).mode,'placeholder');
  assert.equal(catalogue({...automatic,active:null},handlers).mode,'placeholder');
});
