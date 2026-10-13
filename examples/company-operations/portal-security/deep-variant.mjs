import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConnection,connectedClient} from '../../../lense/dataverse/index.mjs';
import {privateJson} from '../../../lense/dataverse/connection.mjs';
import {componentId} from './blueprint.mjs';

export const deepVariant='website-it-secondary-service-subtree-disabled';
const legacyUnsafeVariant='website-it-secondary-service-disabled';
export const deepVariantKeys=['SERVICEREQUEST','WORKORDER','WORKTASK','CHECKLISTITEM','INSPECTION','FINDING'].map(table=>'IT-EQUIPMENT-'+table);
export function configureDeepVariant(blueprint) {
  const copy=structuredClone(blueprint);for(const key of deepVariantKeys){const node=copy.nodes.find(n=>n.key===key);if(!node)throw new Error('Expected registered IT secondary subtree node unavailable');node.active=false;}copy.variant=deepVariant;return copy;
}

function validateArchived(siteId,key,before) {
  const id=componentId('permission:'+key);if(!deepVariantKeys.includes(key)||before?.powerpagecomponentid!==id||before._powerpagesiteid_value!==siteId||before.powerpagecomponenttype!==18||before.name!=='CO '+key||before.statecode!==0||before.statuscode!==1||typeof before.content!=='string')throw new Error('Archived deep variant baseline identity is invalid');return id;
}
function validateCurrent(siteId,key,before,current) {
  const id=validateArchived(siteId,key,before);if(current.powerpagecomponentid!==id||current.powerpagecomponenttype!==before.powerpagecomponenttype||current.content!==before.content||current._powerpagesiteid_value!==siteId||current.name!==before.name)throw new Error('Deep variant restore refused concurrent component identity/content drift; inspect private before-state');
  if(!((current.statecode===0&&current.statuscode===1)||(current.statecode===1&&current.statuscode===2)))throw new Error('Deep variant restore refused unqualified live activation state');
}
async function restoreVariantRecords(client,siteId,records,onProgress,variant=deepVariant) {
  // Preflight all archived/live identities before writing; restoration order is
  // root-to-leaf even when activation was interrupted halfway through.
  const plans=[];for(const {key,before}of records){const id=validateArchived(siteId,key,before),current=await client.get(`powerpagecomponents(${id})`);validateCurrent(siteId,key,before,current);plans.push({key,id,before,current});}
  for(const {key,id,before,current}of plans){
    const endpoint=`powerpagecomponents(${id})`;if(current.statecode!==before.statecode){if(!current['@odata.etag'])throw new Error('Deep variant restore requires current ETag');await onProgress({state:'before-restoration',key,id,before:current,etag:current['@odata.etag']});await client.request(endpoint,{method:'PATCH',body:{statecode:before.statecode,statuscode:before.statuscode},ifMatch:current['@odata.etag']});}
    const restored=await client.get(endpoint);validateCurrent(siteId,key,before,restored);if(restored.statecode!==before.statecode||restored.statuscode!==before.statuscode)throw new Error('Deep variant baseline restoration verification failed');await onProgress({state:'node-restored',key,id});
  }
  await onProgress({state:'restored',variant,ids:plans.map(p=>p.id)});return {state:'restored',ids:plans.map(p=>p.id)};
}

export async function restoreDeepVariant(client,journal,{siteId,expectedOrganisationId,onProgress=()=>{}}={}) {
  if(!expectedOrganisationId||journal.organisationId!==expectedOrganisationId||journal.siteId!==siteId||![deepVariant,legacyUnsafeVariant].includes(journal.variant))throw new Error('Recovery journal organisation/site/variant mismatch');
  // The parent-only journal is recovery-only after its observed broad leakage.
  const keys=journal.variant===legacyUnsafeVariant?[deepVariantKeys[0]]:deepVariantKeys,records=keys.map(key=>{const id=componentId('permission:'+key),archived=journal.entries?.find(e=>e.state==='before-activation'&&e.id===id);if(!archived)throw new Error('Recovery journal lacks the exact archived component');return {key,before:archived.before};});
  await onProgress({state:'recovery-preflight',variant:journal.variant,ids:records.map(r=>r.before.powerpagecomponentid)});return restoreVariantRecords(client,siteId,records,onProgress,journal.variant);
}

export async function withDeepVariant(client,siteId,callback,{onProgress=()=>{}}={}) {
  const records=[];for(const key of deepVariantKeys){const id=componentId('permission:'+key),before=await client.get(`powerpagecomponents(${id})`);validateArchived(siteId,key,before);if(!before['@odata.etag'])throw new Error('Deep variant requires current ETag');records.push({key,id,before});await onProgress({state:'before-activation',variant:deepVariant,key,id,before,etag:before['@odata.etag']});}
  let result;
  try {
    // Sequential changes, not an atomic Dataverse transaction. Leaves go first
    // so no active descendant ever loses its currently active ancestor.
    for(const {key,id,before}of [...records].reverse()){
      const endpoint=`powerpagecomponents(${id})`;await onProgress({state:'before-node-deactivation',key,id,etag:before['@odata.etag']});await client.request(endpoint,{method:'PATCH',body:{statecode:1,statuscode:2},ifMatch:before['@odata.etag']});const inactive=await client.get(endpoint);validateCurrent(siteId,key,before,inactive);if(inactive.statecode!==1)throw new Error('Deep variant activation verification failed');await onProgress({state:'node-deactivated',key,id});
    }
    await onProgress({state:'active',variant:deepVariant,ids:records.map(r=>r.id)});result=await callback({variant:deepVariant,ids:records.map(r=>r.id)});
  } finally {
    // After an uncertain activation outcome, read the fixed identity again.
    await restoreVariantRecords(client,siteId,records,onProgress);
  }
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];},siteId=arg('--site'),directory=path.resolve(arg('--out')??'examples/company-operations/.paqvilo/portal-security/deep-variant'),duration=Number(arg('--timeout-seconds')??600);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId??'')||!directory.split(path.sep).includes('.paqvilo')||!Number.isFinite(duration)||duration<10||duration>1800)throw new Error('Provide --site GUID, ignored --out and bounded timeout 10–1800 seconds');
  if(!args.includes('--apply'))throw new Error('This bounded variant runner requires explicit --apply');
  const connection=await loadConnection(arg('--connection')??'.paqvilo/dataverse/provisioning.connection.json'),client=connectedClient(connection);await client.verify(connection.organisationId);
  const recoveryFile=arg('--restore-journal');if(recoveryFile&&!path.resolve(recoveryFile).split(path.sep).includes('.paqvilo'))throw new Error('Recovery journal must stay in ignored .paqvilo');
  await fs.mkdir(directory,{recursive:true});const journalFile=recoveryFile?path.resolve(recoveryFile):path.join(directory,'lease-'+Date.now()+'.json'),releaseFile=journalFile+'.release',journal=recoveryFile?JSON.parse(await fs.readFile(journalFile)):{schemaVersion:1,startedAt:new Date().toISOString(),organisationId:connection.organisationId,siteId,variant:deepVariant,releaseFile,entries:[]};
  let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
  const onProgress=async entry=>{journal.entries.push({...entry,time:new Date().toISOString()});journal.state=entry.state;await privateJson(journalFile,journal);};
  try {
    if(recoveryFile)await restoreDeepVariant(client,journal,{siteId,expectedOrganisationId:connection.organisationId,onProgress});
    else await withDeepVariant(client,siteId,async()=>{console.log(JSON.stringify({state:'active',variant:deepVariant,journal:journalFile,releaseFile,timeoutSeconds:duration}));const deadline=Date.now()+duration*1000;while(!stopped&&Date.now()<deadline){try{await fs.access(releaseFile);break;}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}},{onProgress});
  } catch(error){journal.error={code:error.code??'VARIANT_INTERRUPTED',message:error.message};journal.state='failed-or-drift';throw error;}
  finally {journal.finishedAt=new Date().toISOString();await privateJson(journalFile,journal);}
  console.log(JSON.stringify({state:journal.state,journal:journalFile}));
}
