import {randomBytes,randomUUID} from 'node:crypto';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {saveProtectedState,loadProtectedState} from 'paqvilo/dataverse';
import {savePrivateJson} from './private-journal.mjs';

const purpose='native-test-identities';
const guid=value=>typeof value==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const settingTargets={
 'Authentication/Registration/LocalLoginEnabled':true,
 'Authentication/Registration/EmailConfirmationEnabled':false,
 'Authentication/Registration/ProfileRedirectEnabled':false,
};
const sameSetting=(actual,before)=>actual.powerpagecomponentid===before.powerpagecomponentid&&actual.name===before.name&&actual.powerpagecomponenttype===9&&actual._powerpagesiteid_value===before._powerpagesiteid_value&&actual.statecode===before.statecode&&actual.statuscode===before.statuscode;

/** Credentials belong only to new disposable contacts. The supported portal
 * registration/password workflow consumes them in memory; neither SDK
 * impersonation nor copying a connected account establishes authentication. */
export async function prepareNativeAuthCredentialVault({file,count=10,cohortId=randomUUID()}){
 if(!path.isAbsolute(file)||!file.split(/[\\/]/).includes('.paqvilo')||!Number.isInteger(count)||count<1||count>10||!guid(cohortId))throw new Error('Native auth requires an absolute ignored vault, owned cohort GUID and 1..10 identities.');
 const entries=Array.from({length:count},(_,index)=>{
  const username=`co-auth-${cohortId.slice(0,8)}-${String(index+1).padStart(2,'0')}`;
  return{index:index+1,contactId:randomUUID(),username,email:`${username}@example.invalid`,password:'Q1!'+randomBytes(40).toString('base64url'),authenticationVerified:false};
 });
 const receipt=await saveProtectedState(file,{schemaVersion:1,kind:'OwnedNativeAuthCohort',cohortId,createdAt:new Date().toISOString(),entries},{purpose});
 return{...receipt,cohortId,count,contacts:entries.map(({index,contactId})=>({index,contactId})),qualification:'Generated credentials only; native authentication is unverified.'};
}
export async function loadNativeAuthCredentialVault(file){
 const state=await loadProtectedState(file,{purpose});
 if(state?.schemaVersion!==1||state.kind!=='OwnedNativeAuthCohort'||!guid(state.cohortId)||!Array.isArray(state.entries)||state.entries.length<1||state.entries.length>10||state.entries.some(entry=>!guid(entry.contactId)||typeof entry.password!=='string'||typeof entry.username!=='string'))throw new Error('Native auth vault content contract failed.');
 return state;
}

/** Boolean-only management profile. Authentication providers, client secrets,
 * password hashes, reset emails and the connected work identity are untouched. */
export async function inspectNativeAuthProfile(client,{siteId,expectedOrganisationId}){
 if(!guid(siteId)||!guid(expectedOrganisationId))throw new Error('Native auth profile requires exact site/organisation identities.');
 const who=await client.get('WhoAmI');if(who.OrganizationId!==expectedOrganisationId)throw new Error('Native auth organisation differs.');
 const rows=await client.list(`powerpagecomponents?$select=powerpagecomponentid,powerpagecomponenttype,name,statecode,statuscode,content,_powerpagesiteid_value&$filter=_powerpagesiteid_value eq ${siteId} and powerpagecomponenttype eq 9 and (${Object.keys(settingTargets).map(name=>`name eq '${name}'`).join(' or ')})`);
 const entries=Object.entries(settingTargets).map(([name,value])=>{
  const matches=rows.filter(row=>row.name===name&&row.statecode===0);
  if(matches.length!==1||matches[0]._powerpagesiteid_value!==siteId||!matches[0]['@odata.etag'])throw new Error('Native authentication Boolean setting is absent/ambiguous or lacks an ETag.');
  const before=matches[0],content=JSON.parse(before.content);
  if(!/^(true|false)$/i.test(String(content.value)))throw new Error('Native authentication setting is not a Boolean.');
  return{id:before.powerpagecomponentid,name,before,plannedContent:JSON.stringify({...content,value:String(value)}),status:'planned'};
 });
 return{schemaVersion:1,kind:'OwnedNativeAuthBooleanProfile',siteId,expectedOrganisationId,targets:settingTargets,entries,qualification:'Plan only; cache refresh and actual local sign-in require separate native witnesses.'};
}

export async function applyNativeAuthProfile(client,plan,journalFile){
 if(plan?.kind!=='OwnedNativeAuthBooleanProfile'||!guid(plan.siteId)||!guid(plan.expectedOrganisationId)||plan.entries.length!==3||new Set(plan.entries.map(entry=>entry.name)).size!==3||plan.entries.some(entry=>!(entry.name in settingTargets)||entry.before.name!==entry.name||JSON.parse(entry.plannedContent).value!==String(settingTargets[entry.name])))throw new Error('Native auth profile plan contract failed.');
 const who=await client.get('WhoAmI');if(who.OrganizationId!==plan.expectedOrganisationId)throw new Error('Native auth profile organisation differs.');
 const journal={...structuredClone(plan),startedAt:new Date().toISOString(),state:'preflight'},save=()=>savePrivateJson(journalFile,structuredClone(journal));
 await savePrivateJson(journalFile,journal,{exclusive:true});
 for(const entry of journal.entries){
  const endpoint=`powerpagecomponents(${entry.id})`,actual=await client.get(endpoint);
  if(!sameSetting(actual,entry.before)||actual.content!==entry.before.content||!actual['@odata.etag'])throw new Error('Native auth profile source changed before activation.');
  entry.status='pending';await save();
  if(actual.content!==entry.plannedContent)await client.request(endpoint,{method:'PATCH',body:{content:entry.plannedContent},ifMatch:actual['@odata.etag']});
  const after=await client.get(endpoint);if(!sameSetting(after,entry.before)||after.content!==entry.plannedContent)throw new Error('Native auth profile readback failed.');
  entry.status='active';await save();
 }
 journal.state='active';journal.activatedAt=new Date().toISOString();await save();return journal;
}
export async function restoreNativeAuthProfile(client,journalFile){
 const journal=JSON.parse(await readFile(journalFile,'utf8'));
 if(journal.kind!=='OwnedNativeAuthBooleanProfile')throw new Error('Native auth restoration requires its owned journal.');
 const who=await client.get('WhoAmI');if(who.OrganizationId!==journal.expectedOrganisationId)throw new Error('Native auth restoration organisation differs.');
 const save=()=>savePrivateJson(journalFile,structuredClone(journal));
 for(const entry of [...journal.entries].reverse()){
  const endpoint=`powerpagecomponents(${entry.id})`,actual=await client.get(endpoint);
  if(!sameSetting(actual,entry.before)||![entry.before.content,entry.plannedContent].includes(actual.content)||!actual['@odata.etag'])throw new Error('Native auth restoration refused foreign setting drift.');
  entry.status='restore-pending';await save();
  if(actual.content!==entry.before.content)await client.request(endpoint,{method:'PATCH',body:{content:entry.before.content},ifMatch:actual['@odata.etag']});
  const restored=await client.get(endpoint);if(!sameSetting(restored,entry.before)||restored.content!==entry.before.content)throw new Error('Native auth restoration readback failed.');
  entry.status='restored';await save();
 }
 journal.state='restored';journal.restoredAt=new Date().toISOString();await save();return journal;
}

export function verifyNativeAuthCanary({contactId,siteId,membershipContactId,portalIdentity,backendPayloads,expectedRoleIds,nativeMemberships}){
 if(!guid(contactId)||!guid(siteId)||membershipContactId!==contactId||portalIdentity?.contactId!==contactId||!Array.isArray(backendPayloads)||!backendPayloads.length||!Array.isArray(expectedRoleIds)||!Array.isArray(nativeMemberships))return{qualified:false,reason:'missing-native-identity-or-query-witness'};
 // expectedRoleIds is the complete explicit membership set, including any
 // auxiliary runner roles. Implicit authenticated/default roles need separate
 // source policy evidence; a subset cannot establish a role-bound canary.
 if(expectedRoleIds.some(role=>!guid(role))||new Set(expectedRoleIds).size!==expectedRoleIds.length||nativeMemberships.some(role=>!guid(role.powerpagecomponentid)||role._powerpagesiteid_value!==siteId||role.statecode!==0))return{qualified:false,reason:'invalid-native-membership-witness'};
 const actualRoles=new Set(nativeMemberships.map(role=>role.powerpagecomponentid));
 if(actualRoles.size!==nativeMemberships.length||actualRoles.size!==expectedRoleIds.length||expectedRoleIds.some(role=>!actualRoles.has(role)))return{qualified:false,reason:'native-membership-mismatch'};
 for(const payload of backendPayloads){const values=payload.context?.extensions?.context2?.values??payload.context;
  if(values?.IsPortalsClientCall!==true||values?.PortalsContactId!==contactId||payload.content?.actorBinding!=='RuntimePortalsContactMatched')return{qualified:false,reason:'backend-runtime-actor-mismatch'};
 }
 return{qualified:true,scope:'Actual authenticated contact and exact explicit native memberships; separate cache/query/row/default-role/config proofs remain required.'};
}

/** Task-owned headed Edge only: no extension attachment, copied cookies,
 * storageState files, real work credentials or shared authentication contexts. */
export async function openNativeAuthBrowserPool({modulePath,capacity=10}){
 if(!path.isAbsolute(modulePath)||!Number.isInteger(capacity)||capacity<1||capacity>10)throw new Error('Native auth browser pool requires an explicit module and 1..10 contexts.');
 const library=await import(pathToFileURL(modulePath).href),chromium=library.chromium??library.default?.chromium;
 if(!chromium?.launch)throw new Error('Configured native browser dependency has no Chromium launcher.');
 const browser=await chromium.launch({channel:'msedge',headless:false});
 const contexts=[];
 try{for(let index=0;index<capacity;index++){const context=await browser.newContext();contexts.push({index:index+1,context,page:await context.newPage()});}}
 catch{await browser.close();throw new Error('Owned native browser context isolation failed.');}
 return{contexts,qualification:'Isolated owned browser contexts only; each native identity remains unverified until its canary.',close:()=>browser.close()};
}
