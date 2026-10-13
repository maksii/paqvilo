import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {planLateQueryProfile,applyQueryProfile,restoreQueryProfile} from '../portal-harness/native-profile.mjs';
const registry=()=>({messages:[{name:'RetrieveMultiple',sdkmessageid:'rm'}],steps:[[10,1],[20,1],[20,9900],[40,9900]].map(([stage,rank],i)=>({sdkmessageprocessingstepid:String(i),name:'Observer '+i,_eventhandler_value:'observer',_sdkmessageid_value:'rm',_sdkmessagefilterid_value:'table',stage,rank,mode:0,statecode:0,statuscode:1,configuration:JSON.stringify({order:rank})}))});
test('late query profile preserves final stage and refuses ambiguous or foreign observers',()=>{
 const source=registry();source.steps.push({...source.steps[0],sdkmessageprocessingstepid:'foreign',_eventhandler_value:'business'});
 const plan=planLateQueryProfile(source,'observer');assert.equal(plan.changes.length,3);assert.equal(plan.preserved,1);assert.ok(!plan.changes.some(change=>change.id==='2'||change.id==='foreign'));
 source.steps.push({...source.steps[2],sdkmessageprocessingstepid:'duplicate'});assert.throws(()=>planLateQueryProfile(source,'observer'),/one active/);
});
test('journal recovers an interrupted conditional profile mutation and rejects unrelated configuration drift',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'paqvilo-profile-')),file=path.join(dir,'lease.json');
 try {
 const source=registry(),records=new Map(source.steps.map(step=>[step.sdkmessageprocessingstepid,{...step,'@odata.etag':'W/"1"'}]));let fail=true;
 const client={get:async query=>structuredClone(records.get(/\((.*?)\)/.exec(query)[1])),request:async(query,options)=>{const record=records.get(/\((.*?)\)/.exec(query)[1]);assert.equal(options.ifMatch,record['@odata.etag']);Object.assign(record,options.body,{'@odata.etag':'W/"2"'});if(fail){fail=false;throw new Error('transport stopped after commit');}}};
 await assert.rejects(applyQueryProfile(client,planLateQueryProfile(source,'observer'),file),/transport stopped/);
 assert.equal(JSON.parse(await readFile(file,'utf8')).entries[0].status,'pending-disable');assert.equal(records.get('0').statecode,1);
 await restoreQueryProfile(client,file);assert.ok([...records.values()].every(record=>record.statecode===0));
 await assert.rejects(applyQueryProfile(client,planLateQueryProfile(source,'observer'),file),{code:'EEXIST'});
 await applyQueryProfile(client,planLateQueryProfile(source,'observer'),path.join(dir,'lease2.json'));records.get('0').configuration='changed';await assert.rejects(restoreQueryProfile(client,path.join(dir,'lease2.json')),/concurrent identity/);assert.equal(records.get('1').statecode,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
