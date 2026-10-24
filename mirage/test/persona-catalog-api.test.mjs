import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { personaFixture,contactId } from './fixtures/persona-catalog.mjs';
import { createSimulator } from '../server.mjs';
import { connectRuntime } from '../testing/runtime.mjs';
import { createPersonaSession } from '../testing/personas.mjs';

test('catalogue API joins pack/state entries, native groups work without JavaScript and state management uses CAS',async t=>{
  const f=await personaFixture(t),{app,call}=f;
  const {value:report}=await call('/personas');
  assert.equal(report.enabled,true);assert.equal(report.personas.length,55);assert.equal(report.other.length,5);assert.equal(report.total,60);
  assert.equal(report.skipped,2);assert.equal(report.diagnostics.filter(d=>d.code==='PERSONA_CATALOG_CONTACT_MISSING').length,1);
  assert.equal(report.personas[0].account.name,'Synthetic Account');assert.equal(report.personas[0].default,true);
  assert.deepEqual(report.personas[0].roles,['Reviewer']);
  const response=await fetch(app.url+'/SignIn');const html=await response.text();assert.equal(response.status,200);
  assert.match(html,/data-persona-group="group-0"/);assert.match(html,/Other contacts/);assert.match(html,/name="personaKey" value="person-1"/);
  const bad=await call('/persona-catalog','PUT',{catalog:report.stateCatalog,expectedDigest:'stale'});assert.equal(bad.response.status,409);
  const catalog=structuredClone(report.stateCatalog);catalog.personas[0].label='Local label';
  const saved=await call('/persona-catalog','PUT',{catalog,expectedDigest:report.catalogDigest});assert.equal(saved.response.status,200);assert.equal(saved.value.personas.find(p=>p.key==='person-1').label,'Local label');
  await app.close();
  const restarted=await createSimulator({...f,stateFile:f.stateFile,packs:[f.pack],watch:false});f.onCleanup(()=>restarted.close());
  const again=await fetch(restarted.url+'/_sim/api/personas').then(r=>r.json());assert.equal(again.personas.find(p=>p.key==='person-1').label,'Local label');
});

test('persona shortcuts reject unsafe redirects and require a CSRF post',async t=>{
  const {app,call}=await personaFixture(t);
  const unknown=await fetch(app.url+'/_sim/sign-in?persona=person-01');assert.equal(unknown.status,404);assert.match(await unknown.text(),/person-1/);
  for(const path of ['https://example.test/','//example.test/','/%2fexample.test/','/\\example.test/']){
    const response=await fetch(app.url+'/_sim/sign-in?persona=person-1&returnUrl='+encodeURIComponent(path));assert.equal(response.status,400,path);
    const html=await response.text();assert.match(html,/returnUrl must be a relative path/);assert.match(html,/<title>Invalid returnUrl<\/title>/);assert.match(html,/<h1>Invalid returnUrl<\/h1>/);assert.doesNotMatch(html,/Portal rendering needs attention/);
  }
  const invalid=await call('/personas/launch','POST',{personaKey:'person-1',returnUrl:'https://other.example/'});assert.equal(invalid.response.status,400);assert.match(invalid.value.error.message,/^returnUrl must be a relative path/);
  const target=app.url+'/_sim/sign-in?persona=person-1&returnUrl=%2F%3Fwelcome%3D1';
  const get=await fetch(target);assert.equal(get.status,200);assert.match(await get.text(),/name="personaKey" value="person-1"/);
  const padded=await fetch(app.url+'/_sim/sign-in?persona=%20person-1%09');assert.equal(padded.status,200);assert.match(await padded.text(),/name="personaKey" value="person-1"/);
  const rejected=await fetch(app.url+'/_sim/sign-in',{method:'POST',body:new URLSearchParams({personaKey:'person-1'}),redirect:'manual'});assert.equal(rejected.status,403);
  const signed=await fetch(app.url+'/_sim/sign-in',{method:'POST',body:new URLSearchParams({personaKey:'person-1',ReturnUrl:'/?welcome=1',__RequestVerificationToken:app.csrf}),redirect:'manual'});
  assert.equal(signed.status,302);assert.equal(signed.headers.get('location'),app.url+'/?welcome=1');assert.ok(signed.headers.get('set-cookie'));
  const missingCsrf=await fetch(app.url+'/_sim/api/personas/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({personaKey:'person-1'})});assert.equal(missingCsrf.status,403);
});

test('isolated contexts reuse setup, preserve parent and support stop/restart and resource limits',async t=>{
  const {app,call}=await personaFixture(t,{personaContexts:{maxInstances:2}});
  const {response,value:one}=await call('/personas/launch','POST',{personaKey:'person-2'});assert.equal(response.status,200,JSON.stringify(one));assert.equal(one.isolated,true);assert.notEqual(one.origin,app.url);
  assert.equal(one.contactId,contactId(2));assert.equal(one.browser.locale,'fr-FR');
  const child=await fetch(one.origin+'/_sim/api/state?summary=1').then(r=>r.json());assert.equal(child.config.environmentVariables.sample_Url,'Context variable');assert.equal(child.config.deploymentProfilePin.profile,'test');
  assert.match(await fetch(one.url,{headers:{cookie:one.cookieHeader}}).then(r=>r.text()),/Context greeting/);
  assert.match(await fetch(app.url).then(r=>r.text()),/Development/);assert.equal(app.state().config.environmentVariables?.sample_Url,undefined);
  const shared=(await call('/personas/launch','POST',{personaKey:'person-2'})).value;assert.equal(shared.id,one.id);
  const separate=(await call('/personas/launch','POST',{personaKey:'person-2',instanceKey:'test-2'})).value;assert.notEqual(separate.origin,one.origin);
  const full=await call('/personas/launch','POST',{personaKey:'person-2',instanceKey:'test-3'});assert.equal(full.response.status,409);
  assert.equal((await call('/persona-runtimes')).value.items.length,2);
  assert.equal((await call('/persona-runtimes/'+one.id,'DELETE')).response.status,200);
  await assert.rejects(fetch(one.origin));
  const again=await call('/personas/launch','POST',{scenario:'review-flow'});assert.equal(again.response.status,200);assert.equal(again.value.path,'/?scenario=review');
  await app.close();await assert.rejects(fetch(separate.origin));await assert.rejects(fetch(again.value.origin));
});

test('public testing clients resolve personas and scenarios for independent parallel visitors',async t=>{
  const {app}=await personaFixture(t);
  const runtime=await connectRuntime({origin:app.url});
  assert.equal((await runtime.personas()).total,60);
  const [first,second]=await Promise.all([
    runtime.createSession({personaKey:'person-1'}),
    createPersonaSession({origin:app.url,personaKey:'person-2',instanceKey:'automated'})
  ]);
  try {
    assert.equal((await first.session()).contactId,contactId(1));assert.equal((await second.session()).contactId,contactId(2));
    assert.equal(first.origin,app.url);assert.notEqual(second.origin,app.url);
    assert.match(await second.request('/').then(r=>r.text()),/Context greeting/);
    assert.equal((await runtime.personaRuntimes()).items.length,1);
  }finally{await first.close();await second.close();}
  const entries=await runtime.personaRuntimes();await runtime.stopPersonaRuntime(entries.items[0].id);assert.equal((await runtime.personaRuntimes()).items.length,0);
});

test('scenario presets affect only the copy; failed persona selection disposes a new copy',async t=>{
  const {app,call}=await personaFixture(t);
  await app.store.transact(()=>{
    app.store.state.presets.sparse={name:'Sparse synthetic data',userConfigured:true,tables:{contact:[{contactid:contactId(1),fullname:'Preset contact'}],account:[]}};
    app.store.state.personaCatalog.scenarios.push({id:'sparse-good',label:'Sparse',group:'group-0',persona:'person-1',preset:'sparse'});
    app.store.state.personaCatalog.scenarios.push({id:'sparse-missing',label:'Missing contact',group:'group-0',persona:'person-2',preset:'sparse'});
  });
  const good=await call('/personas/launch','POST',{scenario:'sparse-good'});assert.equal(good.response.status,200);assert.equal(good.value.isolated,true);
  const child=await fetch(good.value.origin+'/_sim/api/state').then(r=>r.json());assert.equal(child.data.contact.length,1);assert.equal(app.store.state.tables.contact.length,60);
  const failed=await call('/personas/launch','POST',{scenario:'sparse-missing'});assert.equal(failed.response.status,404);assert.equal((await call('/persona-runtimes')).value.items.length,1);
  const both=await call('/personas/launch','POST',{personaKey:'person-1',scenario:'sparse-good'});assert.equal(both.response.status,400);
});

test('context variables override all casing variants and a child refuses a different setup',async t=>{
  const {app,call}=await personaFixture(t);
  await app.store.transact(()=>{
    app.store.state.simulator.environmentVariables={sample_url:'First',sample_Url:'Second'};
    app.store.state.personaCatalog.contexts.push({id:'different',label:'Different',environmentVariables:{sample_Url:'Different'}});
    app.store.state.personaCatalog.personas[2].context='different';
  });
  const {value:opened}=await call('/personas/launch','POST',{personaKey:'person-2'});
  const state=await fetch(opened.origin+'/_sim/api/state?summary=1').then(r=>r.json());assert.deepEqual(state.config.environmentVariables,{sample_Url:'Context variable'});assert.equal(app.store.state.simulator.environmentVariables.sample_url,'First');
  const refused=await fetch(opened.origin+'/_sim/api/personas/launch',{method:'POST',headers:{'content-type':'application/json','x-sim-csrf':state.csrf},body:JSON.stringify({personaKey:'person-3'})});assert.equal(refused.status,409);assert.match((await refused.json()).error.message,/parent runtime/);
});

test('isolated setups follow the parent source-watch setting without losing local overrides',async t=>{
  const {app,call,sourceDir}=await personaFixture(t,{watch:true});
  const {value:opened}=await call('/personas/launch','POST',{personaKey:'person-2'});
  await fs.writeFile(path.join(sourceDir,'web-templates/Main.webtemplate.source.html'),'<html><body><h1>Updated {{ snippets.Greeting }}</h1></body></html>');
  const deadline=Date.now()+8000;let parent='',child='';
  while(Date.now()<deadline){
    [parent,child]=await Promise.all([fetch(app.url).then(r=>r.text()),fetch(opened.origin).then(r=>r.text())]);
    if(parent.includes('Updated Development')&&child.includes('Updated Context greeting'))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.match(parent.match(/<h1>(.*?)<\/h1>/)?.[1]??'',/Updated Development/);assert.match(child.match(/<h1>(.*?)<\/h1>/)?.[1]??'',/Updated Context greeting/);
});

test('native catalogue sign-in honors startPath unless a return URL was explicitly requested',async t=>{
  const {app}=await personaFixture(t);
  await app.store.transact(()=>{app.store.state.personaCatalog.personas[0].startPath='/?persona-default=1';});
  const submit=returnUrl=>fetch(app.url+'/SignIn',{method:'POST',body:new URLSearchParams({personaKey:'person-1',ReturnUrl:returnUrl,__RequestVerificationToken:app.csrf}),redirect:'manual'});
  const native=await fetch(app.url+'/SignIn').then(r=>r.text());assert.match(native,/name="ReturnUrl" value=""/);
  assert.equal((await submit('')).headers.get('location'),app.url+'/?persona-default=1');
  const explicit=await fetch(app.url+'/SignIn?ReturnUrl=%2F').then(r=>r.text());assert.match(explicit,/name="ReturnUrl" value="\/"/);assert.equal((await submit('/')).headers.get('location'),app.url+'/');
});

