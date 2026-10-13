import {readFile} from 'node:fs/promises';
import {savePrivateJson} from './private-journal.mjs';
import {snapshotHash} from './native-capture.mjs';
const sort=ids=>[...new Set(ids)].sort();
const equal=(a,b)=>JSON.stringify(sort(a))===JSON.stringify(sort(b));
const readRoles=async(client,contactId)=>client.list(`contacts(${contactId})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid,_powerpagesiteid_value`);
/** One contact, one explicit role domain, with foreign memberships preserved.
 * The lease rejects unknown-commit ambiguity until its journal is reconciled. */
export async function beginRoleLease(client,{siteId,contactId,roleIds,journalFile}) {
 const components=await client.list(`powerpagecomponents?$select=powerpagecomponentid,powerpagecomponenttype,statecode,_powerpagesiteid_value&$filter=_powerpagesiteid_value eq ${siteId}`);
 if(!roleIds.length||sort(roleIds).length!==roleIds.length||roleIds.some(id=>!components.some(row=>row.powerpagecomponentid===id&&row.powerpagecomponenttype===11&&row.statecode===0)))throw new Error('Role lease requires distinct active target-site role IDs.');
 const baseline=await readRoles(client,contactId),baselineIds=sort(baseline.map(row=>row.powerpagecomponentid));
 const journal={schemaVersion:1,kind:'NativeRoleMaskLease',siteId,contactId,roleIds:sort(roleIds),baseline,baselineIds,expectedIds:baselineIds,sourceHash:snapshotHash(components),startedAt:new Date().toISOString(),entries:[],state:'baseline'};
 await savePrivateJson(journalFile,journal,{exclusive:true});return journal;
}
export async function setLeasedRoles(client,journalFile,selectedIds) {
 const journal=JSON.parse(await readFile(journalFile,'utf8'));
 if(journal.kind!=='NativeRoleMaskLease'||journal.entries.some(entry=>entry.status==='pending'))throw new Error('Role lease requires reconciliation of a pending mutation.');
 if(selectedIds.some(id=>!journal.roleIds.includes(id)))throw new Error('Requested role is outside the frozen role domain.');
 const save=()=>savePrivateJson(journalFile,journal);
 const actual=sort((await readRoles(client,journal.contactId)).map(row=>row.powerpagecomponentid));
 if(!equal(actual,journal.expectedIds))throw new Error('Contact memberships changed outside the role lease.');
 const desired=sort([...journal.baselineIds.filter(id=>!journal.roleIds.includes(id)),...selectedIds]);
 for(const action of [...actual.filter(id=>journal.roleIds.includes(id)&&!desired.includes(id)).map(id=>({id,method:'DELETE'})),...desired.filter(id=>!actual.includes(id)).map(id=>({id,method:'POST'}))]){
  const next=sort(action.method==='POST'?[...journal.expectedIds,action.id]:journal.expectedIds.filter(id=>id!==action.id));
  const entry={...action,beforeIds:journal.expectedIds,nextIds:next,status:'pending',time:new Date().toISOString()};journal.entries.push(entry);await save();
  await client.request(`contacts(${journal.contactId})/powerpagecomponent_mspp_webrole_contact${action.method==='DELETE'?`(${action.id})`:''}/$ref`,{method:action.method,...(action.method==='POST'?{body:{'@odata.id':client.url(`powerpagecomponents(${action.id})`)}}:{})});
  const readback=sort((await readRoles(client,journal.contactId)).map(row=>row.powerpagecomponentid));
  if(!equal(readback,next))throw new Error('Role lease readback mismatch.');entry.status='verified';journal.expectedIds=next;await save();
 }
 journal.state=equal(desired,journal.baselineIds)?'baseline':'active';journal.selectedIds=sort(selectedIds);await save();return journal;
}
export async function recoverRoleLease(client,journalFile,{restore=true}={}) {
 const journal=JSON.parse(await readFile(journalFile,'utf8'));if(journal.kind!=='NativeRoleMaskLease')throw new Error('Unknown role lease.');
 const pending=journal.entries.filter(entry=>entry.status==='pending');if(pending.length>1)throw new Error('Ambiguous role lease pending history.');
 const actual=sort((await readRoles(client,journal.contactId)).map(row=>row.powerpagecomponentid));
 if(pending.length){const entry=pending[0];if(!equal(actual,entry.beforeIds)&&!equal(actual,entry.nextIds))throw new Error('Unknown role membership drift after interrupted mutation.');journal.expectedIds=actual;entry.status=equal(actual,entry.nextIds)?'verified-after-recovery':'not-committed';await savePrivateJson(journalFile,journal);}
 else if(!equal(actual,journal.expectedIds))throw new Error('Role lease recovery refused membership drift.');
 if(restore){await setLeasedRoles(client,journalFile,journal.baselineIds.filter(id=>journal.roleIds.includes(id)));const restored=JSON.parse(await readFile(journalFile,'utf8'));restored.state='restored';restored.restoredAt=new Date().toISOString();await savePrivateJson(journalFile,restored);return restored;}
 return journal;
}
