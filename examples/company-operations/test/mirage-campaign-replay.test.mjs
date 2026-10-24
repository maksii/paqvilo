import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {frozenReplayIdentity,runMirageReplayCampaign} from '../portal-harness/mirage-campaign-replay.mjs';
const actor='10000000-0000-0000-0000-000000000001',site='20000000-0000-0000-0000-000000000001',role='30000000-0000-0000-0000-000000000001',defaultRole='30000000-0000-0000-0000-000000000002',account='40000000-0000-0000-0000-000000000001';
const snapshot=()=>({contactId:actor,siteId:site,tables:{contact:[{contactid:actor,_parentcustomerid_value:account,'_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname':'account'}]},siteMemberships:[{powerpagecomponentid:role,_powerpagesiteid_value:site,statecode:0}],permissions:[{powerpagecomponentid:role,_powerpagesiteid_value:site,powerpagecomponenttype:11,statecode:0,name:'Scoped role',content:'{}'},{powerpagecomponentid:defaultRole,_powerpagesiteid_value:site,powerpagecomponenttype:11,statecode:0,name:'Authenticated role',content:'{"authenticatedusersrole":true}'}]});
test('campaign identity uses exact native site memberships, default role and typed actual account lookup',()=>{
 const source=snapshot(),identity=frozenReplayIdentity(source);assert.deepEqual(identity.roleIds,[role,defaultRole]);assert.equal(identity.accountId,account);
 const foreign=structuredClone(source);foreign.siteMemberships[0]._powerpagesiteid_value='20000000-0000-0000-0000-000000000002';assert.deepEqual(frozenReplayIdentity(foreign).roleIds,[defaultRole]);
 for(const [change,expected] of [[s=>s.tables.contact=[],/missing or ambiguous/],[s=>s.tables.contact.push(s.tables.contact[0]),/missing or ambiguous/],[s=>s.tables.contact[0]['_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname']='team',/Account\/Contact-typed/],[s=>s.permissions[0].statecode=1,/do not resolve to active roles/]]){const invalid=structuredClone(source);change(invalid);assert.throws(()=>frozenReplayIdentity(invalid),expected);}
 const external=structuredClone(source);external.actorBinding={actor:{contactid:actor,_parentcustomerid_value:account},customer:{type:'account',id:account,row:{accountid:account,name:'External actual customer'}}};assert.equal(frozenReplayIdentity(external).accountId,account);
 external.actorBinding.customer.type='contact';external.actorBinding.customer.row={contactid:account};assert.equal(frozenReplayIdentity(external).accountId,undefined);
 external.actorBinding.customer.row.contactid=actor;assert.throws(()=>frozenReplayIdentity(external),/typed customer/);
 const unknown=structuredClone(source);delete unknown.tables.contact[0]['_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname'];assert.equal(frozenReplayIdentity(unknown).accountId,undefined);
 unknown.permissions.push({powerpagecomponenttype:18,statecode:0,content:'{"scope":756150002}'});assert.throws(()=>frozenReplayIdentity(unknown),/Account-scoped/);
});
test('offline campaign resumes immutable completed receipts and rejects input/job/result changes or another worker',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'paq-offline-replay-'));try{
  const file=path.join(dir,'fixture.json'),bytes=Buffer.from('{}');await fs.writeFile(file,bytes,{flag:'wx'});const spec={file,sha256:createHash('sha256').update(bytes).digest('hex')};
  const inputs=Object.fromEntries(['schema','catalogue','observed','serviceProfiles','assemblyReceipt','snapshotBefore','snapshotAfter','capture','registrationBefore','registrationAfter','siteBefore','siteAfter'].map(key=>[key,spec]));
  const job={schemaVersion:1,outputRoot:path.join(dir,'output'),cacheRoot:path.join(dir,'cache'),inputs,cells:[{id:'mask-0',inputs:{}},{id:'mask-1',inputs:{}}]},calls=[];
  const replay=async({cell})=>{calls.push(cell.id);return {physicalReads:2,qualifiedReads:2,allQualified:true,allRuntimeFaultCodesQualified:false};};
  const first=await runMirageReplayCampaign(job,{replay});assert.equal(first.qualified,2);assert.equal(first.physicalReads,4);await runMirageReplayCampaign(job,{replay});assert.deepEqual(calls,['mask-0','mask-1']);
  await assert.rejects(runMirageReplayCampaign({...job,cells:[...job.cells,{id:'mask-2',inputs:{}}]},{replay}),/job or local runtime changed/);
  await fs.writeFile(path.join(job.outputRoot,'worker.lock'),'{}',{flag:'wx'});await assert.rejects(runMirageReplayCampaign(job,{replay}),error=>error.code==='EEXIST');await fs.unlink(path.join(job.outputRoot,'worker.lock'));
  const ledger=JSON.parse(await fs.readFile(first.ledgerFile)),result=ledger.cells[0].resultFile;await fs.appendFile(result,'tamper');await assert.rejects(runMirageReplayCampaign(job,{replay}),/immutable receipt/);
  const invalid={...job,outputRoot:path.join(dir,'changed-input')};await fs.appendFile(file,' ');await assert.rejects(runMirageReplayCampaign(invalid,{replay}),/input bytes/);assert.deepEqual(calls,['mask-0','mask-1']);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('runtime receipts resolve an installed toolkit from an external project without checkout-relative paths',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'paq-external-worker-'));try{
  await fs.mkdir(path.join(directory,'portal-harness'));await fs.mkdir(path.join(directory,'plugins'));await fs.mkdir(path.join(directory,'portal-security'));await fs.mkdir(path.join(directory,'node_modules'));
  const source=fileURLToPath(new URL('../portal-harness/',import.meta.url));
  for(const file of ['mirage-campaign-replay.mjs','mirage-replay-shards.mjs','mirage-role-replay.mjs','mirage-liquid-replay.mjs','mirage-webapi-replay.mjs','replay.mjs','private-journal.mjs','core.mjs','parity.mjs'])await fs.copyFile(path.join(source,file),path.join(directory,'portal-harness',file));
  await fs.copyFile(fileURLToPath(new URL('../portal-security/qualification-domain.mjs',import.meta.url)),path.join(directory,'portal-security','qualification-domain.mjs'));
  await fs.copyFile(fileURLToPath(new URL('../plugins/mirage-runtime.mjs',import.meta.url)),path.join(directory,'plugins/mirage-runtime.mjs'));
  const toolkit=fileURLToPath(new URL('../../../',import.meta.url));await fs.symlink(toolkit,path.join(directory,'node_modules/paqvilo'),process.platform==='win32'?'junction':'dir');
  const module=pathToFileURL(path.join(directory,'portal-harness/mirage-campaign-replay.mjs')).href;
  const result=spawnSync(process.execPath,['--input-type=module','-e',`const {replayRuntimeFingerprint}=await import(${JSON.stringify(module)});console.log(await replayRuntimeFingerprint());`],{encoding:'utf8',timeout:15000,windowsHide:true});assert.equal(result.status,0,result.stderr);assert.match(result.stdout.trim(),/^[a-f\d]{64}$/);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('append-only cell receipts admit newly collected masks without changing prior inputs or overstating coverage',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'paq-append-replay-'));try{
  const cellsDirectory=path.join(directory,'cells');await fs.mkdir(cellsDirectory);const fixture=path.join(directory,'fixture.json');await fs.writeFile(fixture,'{}');const spec={file:fixture,sha256:createHash('sha256').update('{}').digest('hex')};
  const inputs=Object.fromEntries(['schema','catalogue','observed','serviceProfiles','assemblyReceipt','snapshotBefore','snapshotAfter','capture','registrationBefore','registrationAfter','siteBefore','siteAfter'].map(key=>[key,spec])),job={schemaVersion:1,inputs,cellsDirectory,expectedCells:2,outputRoot:path.join(directory,'results'),cacheRoot:path.join(directory,'cache')},seen=[];
  const replay=async({cell})=>{seen.push(cell.id);return {physicalReads:1,qualifiedReads:1,allQualified:true};};
  const empty=await runMirageReplayCampaign(job,{replay});assert.equal(empty.cells,0);assert.equal(empty.allQualified,false);
  const first=path.join(cellsDirectory,'mask-0.json');await fs.writeFile(first,JSON.stringify({id:'mask-0',inputs:{}}),{flag:'wx'});const partial=await runMirageReplayCampaign(job,{replay});assert.equal(partial.qualified,1);assert.equal(partial.allQualified,false);
  await fs.writeFile(path.join(cellsDirectory,'mask-1.json'),JSON.stringify({id:'mask-1',inputs:{}}),{flag:'wx'});const final=await runMirageReplayCampaign(job,{replay});assert.equal(final.allQualified,true);assert.deepEqual(seen,['mask-0','mask-1']);
  await fs.appendFile(first,' ');await assert.rejects(runMirageReplayCampaign(job,{replay}),/cell specification changed/);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
