import{readFile}from'node:fs/promises';
import{readPowerPagesSite,setPowerPagesSiteVisibility}from'paqvilo/dataverse';
import{savePrivateJson}from'./private-journal.mjs';

const guid=value=>typeof value==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
function sameSite(actual,expected){return actual.id===expected.id&&actual.websiteRecordId===expected.websiteRecordId&&actual.websiteUrl===expected.websiteUrl&&actual.name===expected.name&&actual.type===expected.type;}
function targetOptions(target){
 if(!guid(target.managementId)||!guid(target.websiteRecordId)||typeof target.websiteUrl!=='string')throw new Error('Visibility lease requires complete exact demo identities.');
 const url=new URL(target.websiteUrl);if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('Visibility lease requires an exact HTTPS demo origin.');
 return{...target,id:target.managementId,websiteUrl:url.href};
}
export async function inspectNativeVisibilityLease(target,{readSite=readPowerPagesSite}={}){
 const options=targetOptions(target),before=await readSite(options);
 if(before.id!==options.managementId||before.websiteRecordId!==options.websiteRecordId||before.websiteUrl!==options.websiteUrl||before.type!=='Trial'||before.siteVisibility!=='private')throw new Error('Visibility lease requires the exact private trial demo site; no other target can be changed.');
 return{schemaVersion:1,kind:'OwnedNativeTrialVisibilityLease',target:{environment:options.environment,executable:options.executable,managementId:options.managementId,websiteRecordId:options.websiteRecordId,websiteUrl:options.websiteUrl},before,plannedVisibility:'public',state:'planned'};
}
async function observe(plan,expected,{readSite,delay}){
 for(let attempt=0;attempt<12;attempt++){
  const actual=await readSite({...plan.target,id:plan.target.managementId});
  if(!sameSite(actual,plan.before)||!['private','public'].includes(actual.siteVisibility))throw new Error('Visibility lease refused unexpected management identity or state.');
  if(actual.siteVisibility===expected)return actual;
  if(attempt<11)await delay(1500);
 }
 throw new Error('Visibility propagation readback did not reach the journalled state.');
}
const dependencies=options=>({readSite:options.readSite??readPowerPagesSite,setVisibility:options.setVisibility??setPowerPagesSiteVisibility,delay:options.delay??(milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)))});
export async function activateNativeVisibilityLease(plan,file,options={}){
 const dep=dependencies(options),target=targetOptions(plan.target);
 if(plan.kind!=='OwnedNativeTrialVisibilityLease'||plan.before.type!=='Trial'||plan.before.siteVisibility!=='private'||plan.plannedVisibility!=='public'||plan.before.id!==target.managementId||plan.before.websiteRecordId!==target.websiteRecordId||plan.before.websiteUrl!==target.websiteUrl)throw new Error('Visibility activation requires its exact private trial plan.');
 const journal={...structuredClone(plan),startedAt:new Date().toISOString(),state:'preflight'},save=()=>savePrivateJson(file,structuredClone(journal));await savePrivateJson(file,journal,{exclusive:true});
 const actual=await dep.readSite({...target,id:target.managementId});if(!sameSite(actual,journal.before)||actual.siteVisibility!=='private')throw new Error('Visibility changed before the owned activation.');
 journal.state='pending';await save();await dep.setVisibility({...target,id:target.managementId,visibility:'public'});
 journal.readback=await observe(journal,'public',dep);journal.state='active';journal.activatedAt=new Date().toISOString();await save();return journal;
}
export async function restoreNativeVisibilityLease(file,options={}){
 const dep=dependencies(options),journal=JSON.parse(await readFile(file,'utf8'));targetOptions(journal.target);
 if(journal.kind!=='OwnedNativeTrialVisibilityLease'||journal.before.siteVisibility!=='private'||journal.plannedVisibility!=='public')throw new Error('Visibility restoration requires its owned private baseline.');
 const save=()=>savePrivateJson(file,structuredClone(journal)),actual=await dep.readSite({...journal.target,id:journal.target.managementId});
 if(!sameSite(actual,journal.before)||!['private','public'].includes(actual.siteVisibility))throw new Error('Visibility restoration refused foreign management drift.');
 // A timed-out activation can still be queued remotely even when the first
 // read remains private. Send the baseline explicitly for an unresolved or
 // active owned mutation rather than treating that single read as recovery.
 const unresolved=['pending','active','restore-pending'].includes(journal.state);
 journal.state='restore-pending';await save();if(actual.siteVisibility!=='private'||unresolved)await dep.setVisibility({...journal.target,id:journal.target.managementId,visibility:'private'});
 journal.restored=await observe(journal,'private',dep);journal.state='restored';journal.restoredAt=new Date().toISOString();await save();return journal;
}
