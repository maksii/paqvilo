import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { runExportedServerLogic, runExportedCloudFlow, importOperationWorkflows, assertOperationRole, operationHandlers } from '../lib/exported-operations.mjs';
import { validatePack } from '../lib/preset-registry.mjs';
import { createSimulator } from '../server.mjs';

const role = 'd0000000-0000-4000-8000-000000000001';
async function source(t, code) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-operation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logic.js'); await fs.writeFile(file, code);
  return { dir, record: { name: 'sample', file, roleIds: [role] } };
}
function store() {
  return new DataStore({ state: { version: 1, mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } }, tables: { widget: [{ widgetid: 'one', title: 'Synthetic' }] }, permissions: [{ entity: 'widget', scope: 'global', operations: ['read'], roles: ['Reader'] }], settings: { permissionMode: 'enforce' }, plugins: [] } });
}

test('server-logic exported code uses invocation context, local role-scoped reads and connector envelope', async t => {
  const {record} = await source(t, `function post(){ const response=JSON.parse(Server.Connector.Dataverse.RetrieveMultipleRecords('widgets','$select=widgetid,title')); return JSON.stringify({input:JSON.parse(Server.Context.Body),ok:response.IsSuccessStatusCode,rows:JSON.parse(response.Body).value,site:Server.SiteSetting.Get('Sample')}); }`);
  const context = { record, portal: { settings: { Sample: 'setting' } }, store: store(), identity: { roles: ['Reader'], roleIds: [role] }, method: 'POST', body: '{"count":2}' };
  const data = JSON.parse(await runExportedServerLogic(context));
  assert.equal(data.rows[0].title, 'Synthetic'); assert.equal(data.site, 'setting'); assert.equal(data.input.count, 2); assert.equal(data.ok, true);
  const denied = JSON.parse(await runExportedServerLogic({ ...context, identity: { roles: [] } }));
  assert.equal(denied.ok, false); assert.equal(denied.rows, undefined);
  assert.throws(() => assertOperationRole(record, {roleIds: []}), /web roles/);
  assert.doesNotThrow(() => assertOperationRole(record, {roleIds:[role.toUpperCase()]}));
  assert.throws(() => assertOperationRole({roleIds:[]}, {roleIds:[role]}), /web roles/);
});

test('exported server code is bounded and read requests cannot change local records', async t => {
  const fixture = await source(t, 'function get(){while(true){}}');
  await assert.rejects(runExportedServerLogic({ record:fixture.record, portal:{}, store:store(), timeout:100 }), /time|timed out/);
  await fs.writeFile(fixture.record.file, `function get(){return Server.Connector.Dataverse.DeleteRecord('widgets','one');}`);
  const data = store();
  const denied = JSON.parse(await runExportedServerLogic({record:fixture.record,portal:{},store:data}));
  assert.equal(denied.StatusCode, 403);
  assert.equal(data.get('widgets','one',{roles:['Reader']}).title, 'Synthetic');
  await fs.writeFile(fixture.record.file, 'function get(){return Promise.resolve("async result");}');
  assert.equal(await runExportedServerLogic({record:fixture.record,portal:{},store:data}), 'async result');
});

test('exported server CRUD uses local permissions, projection and the DELETE del convention', async t => {
  const fixture = await source(t, `function post(){return Server.Connector.Dataverse.CreateRecord('widgets',Server.Context.Body);}function put(){return Server.Connector.Dataverse.UpdateRecord('widgets',Server.Context.QueryParameters.id,Server.Context.Body);}function del(){return Server.Connector.Dataverse.DeleteRecord('widgets',Server.Context.QueryParameters.id);}function get(){return Server.Connector.Dataverse.RetrieveRecord('widgets','one','$select=title');}`);
  const data = store();
  const state = data.snapshot();
  state.permissions.push({entity:'widget',scope:'global',operations:['create','update','delete','read'],roles:['Editor']});
  await data.replaceState(state);
  const context = {record:fixture.record,portal:{},store:data,identity:{id:'local',roles:['Editor']}};
  const created = JSON.parse(await runExportedServerLogic({...context,method:'POST',body:'{"title":"Created"}'}));
  assert.equal(created.StatusCode,201);
  const id = JSON.parse(created.Body).widgetid;
  assert.ok(id);
  const updated = JSON.parse(await runExportedServerLogic({...context,method:'PUT',query:{id},body:'{"title":"Updated"}'}));
  assert.equal(updated.StatusCode,204);
  assert.equal(data.get('widgets',id,context.identity).title,'Updated');
  const selected = JSON.parse(await runExportedServerLogic(context));
  assert.equal(selected.StatusCode,200);
  assert.equal(JSON.parse(selected.Body).title,'Synthetic');
  const removed = JSON.parse(await runExportedServerLogic({...context,method:'DELETE',query:{id}}));
  assert.equal(removed.StatusCode,204);
  assert.equal(data.get('widgets',id,context.identity),null);
  const denied = JSON.parse(await runExportedServerLogic({...context,identity:{roles:['Reader']},method:'POST',body:'{"title":"Forbidden"}'}));
  assert.equal(denied.StatusCode,403);
  assert.equal(data.rows('widget',context.identity).length,1);
});

test('operation registrations are explicit, validated and ambiguous names fail closed', () => {
  assert.equal(operationHandlers().serverLogics.size, 0);
  assert.throws(() => operationHandlers([{id:'a',serverLogics:{sample(){}}},{id:'b',serverLogics:{Sample(){}}}]), /Ambiguous/);
  const pack = {id:'sample',name:'Synthetic',description:'Synthetic pack',matches:()=>true,presets:()=>({}),serverLogics:{sample:'eval'}};
  assert.throws(() => validatePack(pack), /map exported names to functions/);
});

test('flow definition is selected by exported process id and evaluates only the supported request/response contract', async t => {
  const {dir} = await source(t, '');
  await fs.mkdir(path.join(dir,'Workflows'));
  const definition = {properties:{definition:{triggers:{manual:{type:'Request',kind:'powerpages',inputs:{schema:{properties:{City:{type:'string'}},required:['City']}}}},actions:{reply:{type:'Response',kind:'powerpages',inputs:{statusCode:200,body:{City:"@triggerBody()?['City']"}}}}}}};
  await fs.writeFile(path.join(dir,'Workflows/sample.json'),JSON.stringify(definition));
  await fs.writeFile(path.join(dir,'Workflows/sample.json.data.xml'),`<Workflow WorkflowId="{${role}}"/>`);
  const workflows = await importOperationWorkflows([{dir}]);
  const context = {record:{processId:role},workflows,input:{City:'London'}};
  assert.deepEqual(runExportedCloudFlow(context), {status:200,body:{City:'London'}});
  assert.throws(() => runExportedCloudFlow({...context,input:{}}), /required/);
  assert.throws(() => runExportedCloudFlow({...context,input:{City:42}}), /invalid type/);
  definition.properties.definition.triggers.manual.inputs.schema = { type:'object', additionalProperties:false, required:['items'], properties:{items:{type:'array',items:{type:'object',required:['count'],additionalProperties:false,properties:{count:{type:'integer'},choice:{enum:['A','B']}}}}} };
  workflows.get(role).definition=definition;
  assert.deepEqual(runExportedCloudFlow({...context,input:{items:[{count:2,choice:'A'}]}}).body, {City:null});
  assert.throws(() => runExportedCloudFlow({...context,input:{items:[{count:2.5}]}}), /invalid type/);
  assert.throws(() => runExportedCloudFlow({...context,input:{items:[{}]}}), /required/);
  assert.throws(() => runExportedCloudFlow({...context,input:{items:[{count:2,extra:true}]}}), /undeclared/);
  assert.throws(() => runExportedCloudFlow({...context,input:{items:[{count:2,choice:'C'}]}}), /allowed|enum/);
  definition.properties.definition.actions.connector={type:'OpenApiConnection'};
  workflows.get(role).definition=definition;
  assert.throws(() => runExportedCloudFlow(context), /Request and one Response/);
  assert.throws(() => runExportedCloudFlow({...context,record:{processId:'missing'}}), /no JSON definition/);
});

test('registered HTTP operations enforce exported roles and CSRF and server logic never uses a live bridge', async t => {
  const {dir} = await source(t, '');
  const flow='d0000000-0000-4000-8000-000000000002';
  const files={
    'website.yml':'adx_websiteid: site\nadx_name: Synthetic Operations',
    'Home.webpage.yml':'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml':'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'Main.webtemplate.yml':'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':'<h1>Synthetic</h1>',
    'Runner.webrole.yml':`adx_webroleid: ${role}\nadx_name: Runner`,
    'sample.serverlogic.yml':`adx_serverlogicid: logic\nadx_name: sample\nadx_serverlogic_adx_webrole:\n- ${role}`,
    'sample.js':`function post(){return JSON.stringify({seen:JSON.parse(Server.Context.Body).value});}function get(){return 'ok';}`,
    'Request.cloudflowconsumer.yml':`adx_cloudflowconsumerid: consumer\nadx_name: Sample request\nadx_processid: ${flow}\nadx_flowapiurl: /_api/cloudflow/v1.0/trigger/${flow}\nadx_cloudflowconsumer_adx_webrole:\n- ${role}`,
    'pack.mjs':`export default{id:'synthetic-operations',name:'Synthetic',description:'Invented fixture',matches:()=>true,presets:()=>({}),serverLogics:{sample:({runExportedServerLogic})=>runExportedServerLogic()},cloudFlows:{'Sample request':({input})=>({status:200,body:input})}};`,
  };
  for(const[name,body]of Object.entries(files))await fs.writeFile(path.join(dir,name),body);
  const calls=[],liveBridge={origin:'https://invalid.example',configure(){},status:()=>({connected:true}),async close(){},async request(url){calls.push(url);throw new Error('No live request expected');}};
  const app=await createSimulator({sourceDir:dir,port:0,watch:false,dataPacks:[{module:path.join(dir,'pack.mjs')}],liveBridge,initial:{version:1,tables:{},mappings:{},permissions:[],settings:{permissionMode:'enforce'},plugins:[],simulator:{mode:'local',pageMode:'local',endpoints:[],identityScope:'configured',identity:{id:'person',roles:['Runner'],roleSource:'override'}}}});
  t.after(()=>app.close());
  const token=app.state().csrf;
  const post=(route,headers={})=>fetch(app.url+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({value:7})});
  const logic='/_api/serverlogics/sample',cloud='/_api/cloudflow/v1.0/trigger/'+flow;
  assert.equal((await post(logic)).status,403);assert.equal((await post(cloud)).status,403);
  const authorized={__RequestVerificationToken:token};
  const result=await post(logic,authorized);assert.equal(result.status,200);assert.equal(JSON.parse((await result.json()).data).seen,7);
  const flowResponse=await post(cloud,authorized);assert.equal(flowResponse.status,200);assert.deepEqual(await flowResponse.json(),{value:7});
  const configure=body=>fetch(app.url+'/__sim/api/config',{method:'PATCH',headers:{'content-type':'application/json','x-sim-csrf':token},body:JSON.stringify(body)});
  const switchIdentity=await configure({identity:{id:'person',roles:[],roleSource:'override'}});
  assert.equal(switchIdentity.status,200,await switchIdentity.text());
  assert.equal((await post(logic,authorized)).status,403);assert.equal((await post(cloud,authorized)).status,403);
  assert.equal((await configure({mode:'live',live:{origin:'https://invalid.example'}})).status,200);
  assert.equal((await fetch(app.url+logic)).status,501);assert.deepEqual(calls,[]);
});
