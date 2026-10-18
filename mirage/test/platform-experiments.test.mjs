import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DataStore} from '../lib/data.mjs';
import {createSimulator} from '../server.mjs';
import {platformSettingEntries,validatePlatformOverrides} from '../lib/platform-settings.mjs';
import {dispatchSdkCall} from '../lib/plugin-clr.mjs';
import {applyPortalOverrides} from '../lib/portal-overrides.mjs';
import {applyExperiment,validateExperimentPresets} from '../lib/experiment-presets.mjs';
import {id,xml,initial,fixture} from './fixtures/platform-experiments.mjs';

test('platform budgets are per-store, preserve aggregate semantics and validate values',async()=>{
 const a=new DataStore({state:initial()}),b=new DataStore({state:initial()});
 assert.throws(()=>a.fetchXml(xml(16)),e=>e.details.innerCode==='0x8004430d');
 await a.replaceState({...a.snapshot(),simulator:{...a.state.simulator,platformOverrides:{QueryLinkEntityLimit:30,AggregateQueryRecordLimit:1}}});
 assert.equal(a.fetchXml(xml(16)).entities.length,1);assert.throws(()=>b.fetchXml(xml(16)));
 const query={$type:'QueryExpression',entityName:'item',columnSet:{columns:['itemid']},linkEntities:Array.from({length:16},(_,i)=>({$type:'LinkEntity',linkFromEntityName:'item',linkToEntityName:'item',linkFromAttributeName:'itemid',linkToAttributeName:'itemid',entityAlias:'j'+i}))};
 const call=store=>dispatchSdkCall({store,profile:{userId:id,evidence:'Invented test-only backend grants',grants:[{entity:'item',operations:['read']}]},message:{method:'RetrieveMultiple',userId:id,arguments:[query]}});
 assert.equal(call(a).entities.length,1);assert.throws(()=>call(b),e=>e.details.innerCode==='0x8004430d');
 const next=a.snapshot();next.tables.item.push({itemid:'10000000-0000-4000-8000-000000000002'});await a.replaceState(next);
 assert.throws(()=>a.fetchXml('<fetch aggregate="true"><entity name="item"><attribute name="itemid" alias="total" aggregate="count"/></entity></fetch>'),e=>e.code==='AggregateQueryRecordLimit');
 assert.throws(()=>validatePlatformOverrides({QueryLinkEntityLimit:'30'}));assert.throws(()=>validatePlatformOverrides({QueryLinkEntityLimit:0}));assert.throws(()=>validatePlatformOverrides(JSON.parse('{"__proto__":1}')));
 assert.match(platformSettingEntries(a.state).find(x=>x.key==='QueryLinkEntityLimit').access,/support/);
 const legacy=initial();legacy.settings.fetchJoinRowLimit=9;assert.equal(platformSettingEntries(legacy).find(x=>x.key==='FetchJoinRowLimit').value,9);
});
test('snippet name overrides cover localized values and removal, while reset preserves original translations',()=>{
 const source={snippets:{Greeting:'Default'},settings:{},snippetTranslations:{fr:{Greeting:'Bonjour'}}};
 assert.equal(applyPortalOverrides(source,{snippets:{Greeting:'Override'}}).snippetTranslations.fr.Greeting,'Override');
 assert.ok(!Object.hasOwn(applyPortalOverrides(source,{snippets:{Greeting:null}}).snippetTranslations.fr,'Greeting'));
 assert.equal(applyPortalOverrides(source,{}).snippetTranslations.fr.Greeting,'Bonjour');assert.equal(source.snippetTranslations.fr.Greeting,'Bonjour');
});
test('configuration presets preserve role, operation, identity, routing and data configuration',()=>{
 const state=initial();state.simulator.portalOverrides={roles:{local:{name:'Local role'}}};state.simulator.operations={local:{mode:'mock'}};state.simulator.live={origin:'https://reference.example.test',allowWrites:false};
 const next=applyExperiment(state,{id:'only-config',name:'Only configuration',platformOverrides:{QueryLinkEntityLimit:30},portalOverrides:{settings:{Feature:'True'},snippets:{Greeting:'Alternative'}}});
 for(const key of ['identity','operations','live'])assert.deepEqual(next.simulator[key],state.simulator[key]);assert.deepEqual(next.tables,state.tables);assert.deepEqual(next.simulator.portalOverrides.roles,state.simulator.portalOverrides.roles);
 assert.equal(state.simulator.platformOverrides,undefined);
});
test('organization attachment policies enforce base64 size, extensions and MIME on create/update without altering existing data',async()=>{
 const state=initial();state.tables.organization=[{maxuploadfilesize:8,blockedattachments:'EXE;cmd',blockedmimetypes:'application/x-bad'}];
 const store=new DataStore({state});
 await assert.rejects(store.create('annotation',{filename:'a.exe',documentbody:'YQ=='}),e=>e.code==='AttachmentTypeBlocked');
 await assert.rejects(store.create('annotation',{filename:'a.txt',documentbody:'YWFhYWFhYQ=='}),e=>e.code==='AttachmentTooLarge');
 const row=await store.create('annotation',{filename:'a.txt',mimetype:'text/plain',documentbody:'YQ=='});
 await assert.rejects(store.update('annotation',row.annotationid,{mimetype:'application/x-bad'}),e=>e.code==='AttachmentTypeBlocked');
 assert.equal(store.tableRows('annotation')[0].mimetype,'text/plain');
 const next=store.snapshot();next.simulator.platformOverrides={BlockedAttachments:'',MaxUploadFileSize:20,AllowedMimeTypes:'text/plain'};await store.replaceState(next);
 await store.create('annotation',{filename:'a.exe',mimetype:'text/plain',documentbody:'YWFhYWFhYQ=='});
 assert.equal(store.tableRows('annotation').length,2);
});
test('two runtimes share sources but isolate configuration, presets, reload, restart and invalid imports',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mirage-experiments-'));await fixture(root);let a,b;
 t.after(async()=>{await a?.close();await b?.close();await fs.rm(root,{recursive:true,force:true});});
 const first={sourceDir:root,stateFile:path.join(root,'state-a.json'),initial:initial(),watch:false};a=await createSimulator(first);b=await createSimulator({...first,stateFile:path.join(root,'state-b.json')});
 const workspace=await(await fetch(a.url+'/__sim/api/state')).json();
 const request=async(url,route,method,body)=>{const response=await fetch(url+'/__sim/api'+route,{method,headers:{'content-type':'application/json','x-sim-csrf':url===a.url?workspace.csrf:(await(await fetch(b.url+'/__sim/api/state')).json()).csrf},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
 const revision=async()=> {const value=(await fetch(a.url+'/__sim/api/state').then(r=>r.json())).status.revision;assert.equal(typeof value,'number');return value;};
 const initialRevision=await revision();await request(a.url,'/experiments/source-defaults/apply','POST',{});assert.equal(await revision(),initialRevision,'applying defaults already in effect does not reload');
 assert.equal((await request(a.url,'/platform-settings','PATCH',{QueryLinkEntityLimit:30})).status,200);
 assert.equal((await request(a.url,'/portal-settings/Feature%2FExample','PATCH',{value:'True'})).status,200);
 await request(a.url,'/portal-snippets/Greeting','PATCH',{value:'Override greeting'});
 assert.match(await(await fetch(a.url)).text(),/Override greeting/);assert.match(await(await fetch(b.url)).text(),/Source greeting/);
 const query='/_api/items?fetchXml='+encodeURIComponent(xml(16)),auth=sim=>({headers:{cookie:sim.signIn(id).cookieHeader}}),answer=await fetch(a.url+query,auth(a));assert.equal(answer.status,200,await answer.text());assert.equal((await fetch(b.url+query,auth(b))).status,400);
 const p={id:'scenario-a',name:'Scenario A',platformOverrides:{QueryLinkEntityLimit:30},portalOverrides:{settings:{'Feature/Example':'True'},snippets:{Greeting:'Override greeting'}}};
 const beforeSave=await revision();
 assert.equal((await request(a.url,'/experiments','POST',p)).status,201);
 assert.equal(await revision(),beforeSave,'saving an unapplied preset does not reload portal pages');
 assert.equal((await request(a.url,'/experiments/source-defaults/apply','POST',{})).status,200);assert.match(await(await fetch(a.url)).text(),/Source greeting/);
 await request(a.url,'/experiments/scenario-a/apply','POST',{});assert.match(await(await fetch(a.url)).text(),/Override greeting/);
 const beforeRepeat=await revision();await request(a.url,'/experiments/scenario-a/apply','POST',{});assert.equal(await revision(),beforeRepeat,'reapplying the same settings does not reload portal pages');
 const before=await fs.readFile(path.join(root,'sitesetting.yml'),'utf8');assert.match(before,/False/);
 assert.equal((await request(a.url,'/experiments','POST',{...p,id:'bad',platformOverrides:{QueryLinkEntityLimit:-1}})).status,400);
 assert.equal((await request(a.url,'/experiments/missing','GET')).status,404);assert.equal((await request(a.url,'/experiments/scenario-a/apply','DELETE')).status,405);assert.equal((await request(a.url,'/experiments/scenario-a','GET')).status,200);
 const stateBefore=await fs.readFile(path.join(root,'state-a.json'),'utf8');assert.equal((await request(a.url,'/platform-settings','PATCH',{QueryLinkEntityLimit:5001})).status,400);assert.equal(await fs.readFile(path.join(root,'state-a.json'),'utf8'),stateBefore);
 await fs.writeFile(path.join(root,'content-snippets/Greeting.contentsnippet.value.html'),'Updated source greeting');await request(a.url,'/reload','POST',{});await request(b.url,'/reload','POST',{});
 assert.match(await(await fetch(a.url)).text(),/Override greeting/);assert.match(await(await fetch(b.url)).text(),/Updated source greeting/);
 await request(a.url,'/experiments/webapi-disabled/apply','POST',{});assert.equal((await fetch(a.url+query,auth(a))).status,404);await request(a.url,'/experiments/scenario-a/apply','POST',{});
 await a.close();a=await createSimulator(first);assert.match(await(await fetch(a.url)).text(),/Override greeting/);assert.equal((await fetch(a.url+query,auth(a))).status,200);
 assert.equal(await fs.readFile(path.join(root,'sitesetting.yml'),'utf8'),before);
});


test('attachment policy checks plugin mutations and leaves untouched legacy files editable',async()=>{
 const state=initial();state.simulator.platformOverrides={BlockedAttachments:'exe'};
 const store=new DataStore({state});
 const row=await store.create('annotation',{filename:'safe.txt',documentbody:'YQ=='});
 const next=store.snapshot();next.plugins=[{entity:'annotation',operations:['update'],set:{filename:'blocked.exe'}}];await store.replaceState(next);
 await assert.rejects(store.update('annotation',row.annotationid,{subject:'Unrelated field'}),e=>e.code==='AttachmentTypeBlocked');
 assert.equal(store.tableRows('annotation')[0].filename,'safe.txt');
 const legacy=store.snapshot();legacy.plugins=[];legacy.tables.annotation[0].filename='legacy.exe';await store.replaceState(legacy);
 await store.update('annotation',row.annotationid,{subject:'Still editable'});
 assert.equal(store.tableRows('annotation')[0].subject,'Still editable');
});


test('saved-state presets reject malformed values, mismatched IDs and builtin replacement',()=>{
 for(const presets of [null,{broken:null},{wrong:{id:'different',name:'Example'}},{'source-defaults':{id:'source-defaults',name:'Spoofed',platformOverrides:{QueryLinkEntityLimit:99}}}]){
  assert.throws(()=>validateExperimentPresets(presets),e=>e.status===400);
  const state=initial();state.simulator.experimentPresets=presets;assert.throws(()=>new DataStore({state}),e=>e.status===400);
 }
});
