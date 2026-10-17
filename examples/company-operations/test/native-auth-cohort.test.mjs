import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectNativeAuthProfile,applyNativeAuthProfile,restoreNativeAuthProfile,verifyNativeAuthCanary} from '../portal-harness/native-auth-cohort.mjs';

const site='10000000-0000-4000-8000-000000000001',org='20000000-0000-4000-8000-000000000001',actor='30000000-0000-4000-8000-000000000001';
const settings=['LocalLoginEnabled','EmailConfirmationEnabled','ProfileRedirectEnabled'];
test('native auth Boolean lease preserves sibling content and recovers an uncertain write without trusting foreign drift',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'paqvilo-auth-'));
 try{
  const records=new Map(settings.map((suffix,index)=>{const id=`40000000-0000-4000-8000-00000000000${index+1}`;return[id,{powerpagecomponentid:id,name:'Authentication/Registration/'+suffix,powerpagecomponenttype:9,statecode:0,statuscode:1,_powerpagesiteid_value:site,content:JSON.stringify({value:index?'true':'false',description:'Preserve'}),'@odata.etag':'W/"1"'}];}));
  let fail=true;const client={list:async()=>structuredClone([...records.values()]),get:async query=>query==='WhoAmI'?{OrganizationId:org}:structuredClone(records.get(/\((.*?)\)/.exec(query)[1])),request:async(query,options)=>{const row=records.get(/\((.*?)\)/.exec(query)[1]);assert.equal(options.ifMatch,row['@odata.etag']);Object.assign(row,options.body,{'@odata.etag':'W/"2"'});if(fail){fail=false;throw new Error('Unknown committed transport outcome');}}};
  const plan=await inspectNativeAuthProfile(client,{siteId:site,expectedOrganisationId:org}),file=path.join(directory,'lease.json');
  await assert.rejects(applyNativeAuthProfile(client,plan,file),/Unknown committed/);
  assert.equal(JSON.parse(await readFile(file,'utf8')).entries[0].status,'pending');
  await restoreNativeAuthProfile(client,file);assert.deepEqual([...records.values()].map(row=>JSON.parse(row.content).value),['false','true','true']);assert.ok([...records.values()].every(row=>JSON.parse(row.content).description==='Preserve'));
  await assert.rejects(applyNativeAuthProfile(client,plan,file),{code:'EEXIST'});
  const next=await inspectNativeAuthProfile(client,{siteId:site,expectedOrganisationId:org}),file2=path.join(directory,'lease2.json');await applyNativeAuthProfile(client,next,file2);records.values().next().value.content='{"value":"unrelated"}';await assert.rejects(restoreNativeAuthProfile(client,file2),/foreign setting drift/);
  await assert.rejects(inspectNativeAuthProfile(client,{siteId:site,expectedOrganisationId:actor}),/organisation differs/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('native authentication canary rejects SDK impersonation and mismatched contacts or roles',()=>{
 const role='40000000-0000-4000-8000-000000000001',extra='40000000-0000-4000-8000-000000000002';
 const sample={contactId:actor,siteId:site,membershipContactId:actor,portalIdentity:{contactId:actor},expectedRoleIds:[role],nativeMemberships:[{powerpagecomponentid:role,_powerpagesiteid_value:site,statecode:0}],backendPayloads:[{context:{extensions:{context2:{values:{IsPortalsClientCall:true,PortalsContactId:actor}}}},content:{actorBinding:'RuntimePortalsContactMatched'}}]};
 assert.equal(verifyNativeAuthCanary(sample).qualified,true);
 for(const altered of[{...sample,portalIdentity:{contactId:site}},{...sample,membershipContactId:site},{...sample,nativeMemberships:[]},{...sample,nativeMemberships:[...sample.nativeMemberships,{powerpagecomponentid:extra,_powerpagesiteid_value:site,statecode:0}]},{...sample,nativeMemberships:[...sample.nativeMemberships,...sample.nativeMemberships]},{...sample,expectedRoleIds:[role,role]},{...sample,nativeMemberships:[{...sample.nativeMemberships[0],_powerpagesiteid_value:org}]},{...sample,nativeMemberships:[{...sample.nativeMemberships[0],statecode:1}]},{...sample,expectedRoleIds:['role']},{...sample,backendPayloads:[]},{...sample,backendPayloads:[{context:{IsPortalsClientCall:false,PortalsContactId:actor},content:{actorBinding:'SDKConfiguredIdentity'}}]}])assert.equal(verifyNativeAuthCanary(altered).qualified,false);
});
