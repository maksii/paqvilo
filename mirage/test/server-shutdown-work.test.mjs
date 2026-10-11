import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {createSimulator} from '../server.mjs';
test('Stop rejects new HTTP writes and drains an accepted streaming mutation plus its automatic imported flow',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-shutdown-flow-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const flow='10000000-0000-0000-0000-000000000001';
 const files={'website.yml':'adx_websiteid: invented\nadx_name: Invented Shutdown',
 'enabled.sitesetting.yml':'adx_name: Webapi/widget/enabled\nadx_value: true',
 'fields.sitesetting.yml':'adx_name: Webapi/widget/fields\nadx_value: title',
 'pack.mjs':`export default{id:'invented-trigger',name:'Invented',description:'Invented',matches:()=>true,presets:()=>({}),flowIdentities:{'${flow}':{userId:'20000000-0000-0000-0000-000000000001',evidence:'Invented',grants:[{entity:'widget',operations:['read']},{entity:'audit',operations:['create']}]}}};`};for(const[file,source]of Object.entries(files))await fs.writeFile(path.join(dir,file),source);await fs.mkdir(path.join(dir,'Workflows'));
 const definition={properties:{definition:{triggers:{row:{type:'OpenApiConnectionWebhook',inputs:{host:{apiId:'/apis/shared_commondataserviceforapps',operationId:'SubscribeWebhookTrigger'},parameters:{message:1,entityname:'widget',scope:4,filteringattributes:''}}}},actions:{create:{type:'OpenApiConnection',inputs:{host:{apiId:'/apis/shared_commondataserviceforapps',operationId:'CreateRecord'},parameters:{entityName:'audits','item/title':"@triggerBody()['title']"}}}}}}};await fs.writeFile(path.join(dir,'Workflows/flow.json'),JSON.stringify(definition));await fs.writeFile(path.join(dir,'Workflows/flow.json.data.xml'),`<Workflow WorkflowId="${flow}" Name="Invented automatic flow"><StateCode>1</StateCode></Workflow>`);
 const app=await createSimulator({sourceDir:dir,solutionRoots:[dir],port:0,watch:false,stateFile:path.join(dir,'.paqvilo/state.json'),dataPacks:[{module:path.join(dir,'pack.mjs')}],initial:{version:1,mappings:{widget:{entitySet:'widgets',idColumn:'widgetid'},audit:{entitySet:'audits',idColumn:'auditid'}},tables:{widget:[],audit:[]},plugins:[],permissions:[{entity:'widget',scope:'global',operations:['create'],roles:['Editor']}],settings:{permissionMode:'enforce'},simulator:{mode:'local',pageMode:'local',identityScope:'configured',identity:{id:'caller',roles:['Editor'],roleSource:'override'}}}});t.after(()=>app.close());
 const accepted=once(app.server,'request'),request=http.request(app.url+'/_api/widgets',{method:'POST',headers:{'content-type':'application/json',__RequestVerificationToken:app.state().csrf}}),response=new Promise((resolve,reject)=>{request.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);});request.write('{"title":');await accepted;
 const stopped=app.close();const late=await fetch(app.url+'/_api/widgets',{method:'POST',headers:{'content-type':'application/json',__RequestVerificationToken:app.state().csrf},body:JSON.stringify({title:'Late rejected'})});assert.equal(late.status,503);request.end('"Accepted before stop"}');assert.equal(await response,204);await stopped;
 const saved=JSON.parse(await fs.readFile(path.join(dir,'.paqvilo/state.json'),'utf8'));assert.equal(saved.tables.widget.length,1);assert.equal(saved.tables.widget[0].title,'Accepted before stop');assert.equal(saved.tables.audit.length,1);assert.equal(saved.tables.audit[0].title,'Accepted before stop');assert.ok(app.state().diagnostics.some(n=>n.code==='FLOW_TRIGGER_COMPLETED'));
});
