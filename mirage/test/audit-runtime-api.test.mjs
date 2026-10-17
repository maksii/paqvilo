import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createSimulator} from '../api.mjs';
import {readStateFile} from '../lib/state-storage.mjs';

async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-audit-runtime-api-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const files={'website.yml':'adx_websiteid: invented\nadx_name: Runtime audit',
    'Home.webpage.yml':'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml':'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'Main.webtemplate.yml':'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':'<!doctype html><html><body><h1>Invented runtime audit</h1></body></html>'};
  for(const [file,body]of Object.entries(files))await fs.writeFile(path.join(root,file),body);
  const stateFile=path.join(root,'state.json'),initial={settings:{permissionMode:'permissive'},mappings:{contact:{entitySet:'contacts',idColumn:'contactid'},account:{entitySet:'accounts',idColumn:'accountid'}},tables:{contact:[{contactid:'person',fullname:'Invented person',parentcustomerid:{id:'first',logical_name:'account'}}],account:[{accountid:'first',name:'First invented account'},{accountid:'second',name:'Second invented account'}]},simulator:{mode:'local',pageMode:'local',endpoints:[],identity:{id:'person',roles:[]}}};
  const app=await createSimulator({sourceDir:root,stateFile,initial,watch:false,...options});t.after(()=>app.close());
  const call=(route,method='GET',body,headers={})=>fetch(app.url+route,{method,headers:{'x-sim-csrf':app.state().csrf,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {app,root,stateFile,call};
}

test('administration rejects non-object JSON before mutation while profile null remains a supported reset',async t=>{
  const {app,stateFile,call}=await fixture(t),before=app.store.snapshot();
  for(const [route,method]of [['/config','PATCH'],['/personas/select','POST'],['/presets','POST'],['/live/connect','POST']]){
    for(const value of [null,[],false,7,'scalar']){
      const response=await call('/__sim/api'+route,method,value),body=await response.json();
      assert.equal(response.status,400,`${method} ${route} ${JSON.stringify(value)}: ${JSON.stringify(body)}`);
      assert.match(body.error.message,/JSON object/);assert.equal(body.error.stack,undefined);
    }
  }
  assert.deepEqual(app.store.state,before);assert.deepEqual((await readStateFile(stateFile)).tables,before.tables);
  const reset=await call('/__sim/api/environment/profiles','PUT',null);
  assert.equal(reset.status,200,await reset.text());
});

test('invalid encoded administration identifiers return bounded client errors and leave the server available',async t=>{
  const {app,call}=await fixture(t);
  for(const route of ['/records/%E0%A4%A','/presets/%','/operations/%E0%A4%A','/portal-settings/%','/environment/variables/%']){
    const method=route.startsWith('/operations/')?'PATCH':route.startsWith('/environment/')?'PUT':'GET';
    const response=await call('/_sim/api'+route,method,method==='GET'?undefined:{}),body=await response.json();
    assert.equal(response.status,400,route+': '+JSON.stringify(body));assert.match(body.error.message,/encoding/i);assert.equal(body.error.stack,undefined);
  }
  assert.equal((await fetch(app.url+'/_sim/api/status')).status,200);
});

test('invalid externalAssets cannot silently disable confinement or misreport its status',async t=>{
  const {app,stateFile,call}=await fixture(t,{contentPolicyDefaults:{confinePortalPages:true}}),before=app.store.snapshot();
  for(const externalAssets of ['false',1,{},null]){
    const response=await call('/__sim/api/config','PATCH',{externalAssets});
    assert.equal(response.status,400,await response.text());
    assert.deepEqual(app.store.state,before);
    assert.ok((await fetch(app.url)).headers.get('content-security-policy'));
  }
  assert.deepEqual((await readStateFile(stateFile)).simulator,before.simulator);
  const valid=await call('/__sim/api/config','PATCH',{externalAssets:true});assert.equal(valid.status,200,await valid.text());
  assert.equal((await fetch(app.url)).headers.get('content-security-policy'),null);
  assert.equal((await (await fetch(app.url+'/__sim/api/status')).json()).externalAssets,true);
});

test('a legacy non-boolean externalAssets value cannot bypass confinement after restart',async t=>{
  const {app,root,stateFile}=await fixture(t,{contentPolicyDefaults:{confinePortalPages:true}});
  // Older administration APIs accepted this string and persisted it. Keep the
  // saved value readable, but grant the opt-out only for a boolean true.
  app.store.state.simulator.externalAssets='false';await app.store.compact();await app.close();
  const restarted=await createSimulator({sourceDir:root,stateFile,watch:false});t.after(()=>restarted.close());
  const status=await (await fetch(restarted.url+'/_sim/api/status')).json();
  assert.equal(status.confinePortalPages,true);assert.equal(status.externalAssets,false);
  assert.match((await fetch(restarted.url)).headers.get('content-security-policy'),/connect-src 'self'/);
  assert.equal((await readStateFile(stateFile)).simulator.externalAssets,'false','starting the runtime does not silently migrate saved configuration');
});

test('page inspection refreshes account identity after a record edit within the same source revision',async t=>{
  const {app,call}=await fixture(t),session=app.signIn('person',{roles:[]}),headers={cookie:session.cookieHeader};
  const inspect=async()=>{const response=await call('/__sim/api/page-resources?path=%2F','GET',undefined,headers);assert.equal(response.status,200);return response.json();};
  const first=await inspect();assert.equal(first.identity.accountId,'first');
  const changed=await call('/__sim/api/records/contacts/person','PATCH',{parentcustomerid:{id:'second',logical_name:'account'}});assert.equal(changed.status,200,await changed.text());
  const second=await inspect();assert.equal(second.identity.accountId,'second');assert.equal(second.revision,first.revision);
});

test('diagnostics endpoint includes import diagnostics counted by status and exposed state',async t=>{
  const diagnostic={code:'INVENTED_IMPORT_WARNING',severity:'warning',message:'Invented source import warning'};
  const {app,call}=await fixture(t,{initial:{settings:{permissionMode:'permissive'},simulator:{mode:'local',pageMode:'local',endpoints:[],identity:{roles:[]},importDiagnostics:[diagnostic]}}});
  const status=await (await call('/__sim/api/status')).json(),diagnostics=await (await call('/__sim/api/diagnostics')).json();
  assert.equal(status.diagnostics.byCode[diagnostic.code],1);
  assert.deepEqual(diagnostics.diagnostics.filter(item=>item.code===diagnostic.code),[diagnostic]);
  assert.ok(app.state().diagnostics.some(item=>item.code===diagnostic.code));
});

test('reset reuses project confinement defaults while returning runtime changes to their seed',async t=>{
  const {app,call}=await fixture(t,{contentPolicyDefaults:{confinePortalPages:true}});
  assert.ok((await fetch(app.url)).headers.get('content-security-policy'));
  const changed=await call('/__sim/api/config','PATCH',{confinePortalPages:false});assert.equal(changed.status,200,await changed.text());
  assert.equal((await fetch(app.url)).headers.get('content-security-policy'),null);
  const reset=await call('/__sim/api/reset','POST',{});assert.equal(reset.status,200,await reset.text());
  assert.equal(app.state().config.confinePortalPages,true);
  assert.equal(app.state().config.contentPolicySource,'project defaults');
  assert.ok((await fetch(app.url)).headers.get('content-security-policy'));
});

test('both administration aliases use the JSON error contract when the origin is rejected',async t=>{
  const {app}=await fixture(t);
  for(const prefix of ['/_sim/api','/__sim/api'])for(const headers of [{origin:'https://invented.invalid'},{host:'invented.invalid'}]){
    const response=await new Promise((resolve,reject)=>{
      http.get(app.url+prefix+'/status',{headers},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));}).on('error',reject);
    });assert.equal(response.status,403);
    assert.match(response.headers['content-type'],/^application\/json/);
    const body=JSON.parse(response.body);assert.equal(body.error.code,'INVALID_REQUEST');
    assert.match(body.error.message,/origin|Host/);
  }
});

test('failed source reload keeps the applied runtime and a later valid reload recovers',async t=>{
  const {app,root,call}=await fixture(t,{requirePortalSource:true}),before=app.state(),file=path.join(root,'Home.webpage.yml'),source=await fs.readFile(file,'utf8');
  await fs.rm(file);
  await assert.rejects(app.reload(),/recognised pages|recognized pages|No portal|no imported|no recognised|no recognized/i);
  assert.equal(app.state().status.sourceFingerprint,before.status.sourceFingerprint);
  assert.equal(app.state().status.revision,before.status.revision);
  assert.match(await (await fetch(app.url)).text(),/Invented runtime audit/);
  assert.ok((await (await call('/__sim/api/diagnostics')).json()).diagnostics.some(item=>item.code==='RELOAD_FAILED'));
  await fs.writeFile(file,source);await fs.writeFile(path.join(root,'Main.webtemplate.source.html'),'<!doctype html><html><body><h1>Recovered source</h1></body></html>');
  const response=await call('/_sim/api/reload','POST',{});assert.equal(response.status,200,await response.text());
  assert.equal(app.state().status.revision,before.status.revision+1);
  assert.match(await (await fetch(app.url)).text(),/Recovered source/);
});

test('shutdown rejects new requests but drains an accepted record save before its disk state closes',async t=>{
  const {app,stateFile,call}=await fixture(t);
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),saving=new Promise(resolve=>{entered=resolve;}),save=app.store.save.bind(app.store);
  app.store.save=async(...args)=>{entered();await gate;return save(...args);};
  const request=call('/__sim/api/records/contacts/person','PATCH',{fullname:'Saved before close'});
  await saving;const closing=app.close();
  try{
    const unavailable=await fetch(app.url+'/_sim/api/status');assert.equal(unavailable.status,503);
    assert.equal((await unavailable.json()).error.code,'SIMULATOR_CLOSING');
  }finally{release();}
  const completed=await request;assert.equal(completed.status,200,await completed.text());await closing;
  assert.equal((await readStateFile(stateFile)).tables.contact[0].fullname,'Saved before close');
  await app.close();
});

test('portal sessions remain isolated between concurrent runtimes and expire after restart on the same port',async t=>{
  const first=await fixture(t),second=await fixture(t),session=first.app.signIn('person',{roles:[]});
  const read=async(app,cookie=session.cookieHeader)=>{const response=await fetch(app.url+'/_sim/api/session',{headers:{cookie}});assert.equal(response.status,200);return response.json();};
  assert.equal((await read(first.app)).signedIn,true);
  assert.equal((await read(second.app)).signedIn,false);
  const port=Number(new URL(first.app.url).port);await first.app.close();
  const restarted=await createSimulator({sourceDir:first.root,stateFile:first.stateFile,watch:false,port});t.after(()=>restarted.close());
  assert.equal((await read(restarted)).signedIn,false);
});
