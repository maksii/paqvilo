import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {replayStore} from './replay.mjs';
import {savePrivateJson} from './private-journal.mjs';
import {validateRoleReplayCell} from './mirage-role-replay.mjs';
import {prepareNativeReplayPlugins,applyNativeDataSnapshot,contextFromNativeCapture,recordedPluginPayloads,nativeRegistrationFingerprint,replayNativeReadBatch,validateFinalQueryObserverWitness} from '../plugins/mirage-runtime.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const guid=value=>typeof value==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);

/** Membership and account scope come from the actual frozen contact/site data,
 * including the authenticated default role. Seed persona roles are not an oracle. */
export function frozenReplayIdentity(snapshot){
 if(!guid(snapshot?.contactId)||!guid(snapshot?.siteId)||!Array.isArray(snapshot.siteMemberships)||!Array.isArray(snapshot.permissions))throw new Error('Signed-in replay requires frozen native contact/site membership evidence.');
 const contacts=snapshot.tables?.contact?.filter(row=>row.contactid===snapshot.contactId);if(contacts?.length!==1)throw new Error('Frozen native actor is missing or ambiguous.');
 const roles=snapshot.permissions.filter(row=>row.powerpagecomponenttype===11&&row.statecode===0&&row._powerpagesiteid_value===snapshot.siteId);
 const assigned=snapshot.siteMemberships.filter(row=>row.statecode===0&&row._powerpagesiteid_value===snapshot.siteId);
 if(assigned.some(row=>!roles.some(role=>role.powerpagecomponentid===row.powerpagecomponentid)))throw new Error('Frozen memberships do not resolve to active roles in this site.');
 const defaults=roles.filter(row=>JSON.parse(row.content).authenticatedusersrole===true);
 const roleIds=[...new Set([...assigned,...defaults].map(row=>row.powerpagecomponentid))].sort();
 const actor=snapshot.actorBinding?.actor;if(actor&&actor.contactid!==snapshot.contactId)throw new Error('Frozen actor binding identifies a different Contact.');
 const contact=actor??contacts[0];let account=contact._parentcustomerid_value??contact.parentcustomerid?.id;
 const customer=snapshot.actorBinding?.customer;
 if(customer&&(customer.id!==account||!guid(customer.id)||!['account','contact'].includes(customer.type)||customer.row?.[customer.type+'id']!==customer.id))throw new Error('Frozen typed customer row does not match its actual actor lookup.');
 const annotation=customer?.type??contact['_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname']??contact.parentcustomerid?.logical_name;
 if(account!=null&&(!guid(account)||annotation&&!['account','contact'].includes(annotation)))throw new Error('Frozen customer lookup requires an Account/Contact-typed source.');
 if(annotation==='contact')account=null;
 if(account!=null&&!annotation&&((snapshot.tables.account??[]).filter(row=>row.accountid===account).length!==1||(snapshot.tables.contact??[]).some(row=>row.contactid===account))){
  if(snapshot.permissions.some(row=>row.powerpagecomponenttype===18&&row.statecode===0&&JSON.parse(row.content).scope===756150002))throw new Error('Account-scoped replay requires a source-qualified Account customer lookup.');
  account=null;
 }
 return {id:snapshot.contactId,contactId:snapshot.contactId,roleIds,roles:roles.filter(row=>roleIds.includes(row.powerpagecomponentid)).map(row=>row.name),roleSource:'memberships',...(account?{accountId:account}:{})};
}

async function jsonReceipt(file,{sha256,limit=64*1024*1024}={}){
 if(!path.isAbsolute(file)||sha256!==undefined&&!/^[a-f\d]{64}$/.test(sha256))throw new Error('Replay inputs require absolute local files and valid SHA256 receipts.');
 const bytes=await boundedBytes(file,limit),actual=sha(bytes);if(sha256!==undefined&&actual!==sha256)throw new Error('Replay input bytes do not match the immutable receipt.');
 return {value:JSON.parse(bytes.toString('utf8')),sha256:actual,bytes};
}
export async function boundedReplayBytes(file,limit=64*1024*1024){
 const handle=await fs.open(file,'r');let bytes;
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size>limit)throw new Error('Replay input must be a bounded regular file.');const chunks=[];let size=0;for(;;){const buffer=Buffer.alloc(Math.min(65536,limit-size+1)),{bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;if(size>limit)throw new Error('Replay input grew beyond its bound.');chunks.push(buffer.subarray(0,bytesRead));}bytes=Buffer.concat(chunks,size);}finally{await handle.close();}
 return bytes;
}
const boundedBytes=boundedReplayBytes;
async function archiveBytes(directory,bytes){
 const digest=sha(bytes),file=path.join(directory,digest+'.bin'),temporary=path.join(directory,digest+'.'+randomUUID()+'.tmp');await fs.mkdir(directory,{recursive:true});let handle;
 try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;try{await fs.link(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;if(sha(await boundedBytes(file,bytes.length))!==digest)throw new Error('An immutable replay input archive changed.');}}finally{await handle?.close();await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 return {file,sha256:digest};
}
async function input(spec,archive){if(!spec||!/^[a-f\d]{64}$/.test(spec.sha256??''))throw new Error('Every replay input requires an absolute local file and immutable SHA256 receipt.');const receipt=await jsonReceipt(spec.file,{sha256:spec.sha256});return {value:receipt.value,archive:await archiveBytes(archive,receipt.bytes)};}
export async function loadReplayCellInputs(job,cell,{archiveRoot}={}){
 const loaded=Object.fromEntries(await Promise.all(Object.entries({...job.inputs,...cell.inputs}).map(async([key,spec])=>{if(!spec||!/^[a-f\d]{64}$/.test(spec.sha256??''))throw new Error('Every replay input requires its immutable receipt.');const receipt=await jsonReceipt(spec.file,{sha256:spec.sha256});return [key,{value:receipt.value,archive:archiveRoot?await archiveBytes(archiveRoot,receipt.bytes):undefined}];})));
 return {inputs:Object.fromEntries(Object.entries(loaded).map(([key,receipt])=>[key,receipt.value])),inputArchives:Object.fromEntries(Object.entries(loaded).filter(([,receipt])=>receipt.archive).map(([key,receipt])=>[key,receipt.archive]))};
}
export function replayRoleWitness(job,cell,inputs){return job.roleCampaign?validateRoleReplayCell({contract:job.roleCampaign,cell,inputs,identityFor:frozenReplayIdentity}):null;}
export async function replayCells(job){
 if(job.cellsDirectory!==undefined){if(job.cells!==undefined||!path.isAbsolute(job.cellsDirectory)||!Number.isInteger(job.expectedCells)||job.expectedCells<1||job.expectedCells>4096)throw new Error('Append-only cells require an absolute cellsDirectory and explicit expectedCells, without a static cells array.');
  const rows=[];for(const item of await fs.readdir(job.cellsDirectory,{withFileTypes:true})){if(item.isSymbolicLink())throw new Error('Replay cell specifications cannot be symbolic links.');if(!item.isFile()||!item.name.endsWith('.json'))continue;const receipt=await jsonReceipt(path.join(job.cellsDirectory,item.name),{limit:65536});rows.push({...receipt.value,specificationSha256:receipt.sha256});}return rows.sort((a,b)=>a.id.localeCompare(b.id));}
 return job.cells;
}
export function replayCellShard(id,count){if(typeof id!=='string'||!Number.isInteger(count)||count<1||count>10)throw new Error('Replay shards require a cell ID and one to ten processes.');return parseInt(sha(Buffer.from(id)).slice(0,8),16)%count;}
export async function replayRuntimeFingerprint({archiveRoot,onArchive}={}){
 const toolkit=path.dirname(await fs.realpath(fileURLToPath(import.meta.resolve('paqvilo/mirage/lib/data.mjs')))),project=path.dirname(fileURLToPath(import.meta.url)),files=[];
 async function visit(directory){for(const item of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isSymbolicLink())throw new Error('Replay runtime sources cannot be symbolic links.');if(item.isDirectory())await visit(file);else if(item.isFile()&&/\.(mjs|cs|json)$/.test(item.name))files.push({file,name:'toolkit/mirage/lib/'+path.relative(toolkit,file).replaceAll('\\','/')});}}
 await visit(toolkit);
 for(const relative of ['../plugins/mirage-runtime.mjs','../portal-security/qualification-domain.mjs','mirage-liquid-replay.mjs','mirage-webapi-replay.mjs','mirage-campaign-replay.mjs','mirage-replay-shards.mjs','mirage-role-replay.mjs','replay.mjs','private-journal.mjs','core.mjs','parity.mjs'])files.push({file:path.resolve(project,relative),name:'project/'+relative.replaceAll('../','')});
 const receipts=await Promise.all(files.sort((a,b)=>a.name.localeCompare(b.name)).map(async item=>{const bytes=await boundedBytes(item.file,32*1024*1024);if(archiveRoot)await archiveBytes(archiveRoot,bytes);return {file:item.name,sha256:sha(bytes)};}));
 const digest=sha(Buffer.from(stable(receipts)));if(archiveRoot){const manifest=await archiveBytes(archiveRoot,Buffer.from(stable({runtimeSha256:digest,files:receipts})));onArchive?.(manifest);}return digest;
}
async function replayCell({job,cell,inputs,cacheRoot}){
 if(inputs.nativePages){if(!Array.isArray(inputs.nativePages)||!inputs.nativePages.length||inputs.nativePages.length>20)throw new Error('Replay page set must be nonempty and bounded.');const roleWitness=replayRoleWitness(job,cell,inputs),parts=[];for(const[index,page]of inputs.nativePages.entries())parts.push(await replayCell({job:{...job,roleCampaign:undefined},cell,inputs:{...inputs,nativePages:undefined,...page},cacheRoot:path.join(cacheRoot,'page-'+index)}));return {parts,pages:parts.flatMap(part=>part.pages),physicalReads:parts.reduce((sum,part)=>sum+part.physicalReads,0),qualifiedReads:parts.reduce((sum,part)=>sum+part.qualifiedReads,0),qualificationScope:parts[0]?.qualificationScope,roleWitness,sourceWitness:{verified:parts.every(part=>part.sourceWitness.verified)},wireSourceWitness:{verified:parts.every(part=>part.wireSourceWitness.verified)},allQualified:parts.every(part=>part.allQualified)&&(!roleWitness||roleWitness.complete),fullSdkCollectionQualified:parts.every(part=>part.fullSdkCollectionQualified),allRuntimeFaultCodesQualified:parts.every(part=>part.allRuntimeFaultCodesQualified)};}
 if(!Array.isArray(job.selectedStepIds)||!job.selectedStepIds.length||job.selectedStepIds.some(id=>!guid(id)))throw new Error('Original DLL replay requires explicit nonempty native step identities.');
 const {schema,catalogue,overlay,observed,serviceProfiles,assemblyReceipt,snapshotBefore:snapshot,snapshotAfter:after,capture,registrationBefore:registration,registrationAfter,siteBefore:site,siteAfter}=inputs;
 if(!Array.isArray(assemblyReceipt)||!assemblyReceipt.length||assemblyReceipt.some(row=>row.allMatch!==true||row.installedHash!==row.exportedHash||row.installedHash!==job.expectedAssemblyHashes?.[row.identity?.name]))throw new Error('Actual installed/exported native assembly receipts do not match this cohort.');
 const identity=frozenReplayIdentity(snapshot),afterIdentity=frozenReplayIdentity(after);
 if(stable(identity)!==stable(afterIdentity))throw new Error('Native actor, account or site memberships changed during capture.');
 const registrationSha256=nativeRegistrationFingerprint(registration);if(registrationSha256!==nativeRegistrationFingerprint(registrationAfter))throw new Error('Native registration changed during capture.');
 const payloads=recordedPluginPayloads(capture.backendEvents),portal=payloads.find(payload=>payload.context?.extensions?.context2?.values?.IsPortalsClientCall===true||payload.context?.IsPortalsClientCall===true);
 const context=portal?contextFromNativeCapture(portal.context):job.context;
 if(!context)throw new Error('Backendless capture requires an explicit frozen caller profile; expected absence cannot supply one.');
 for(const payload of payloads){const values=payload.context?.extensions?.context2?.values;const actor=values?.PortalsContactId??payload.context?.PortalsContactId;if(actor!==identity.contactId)throw new Error('Native backend actor does not match frozen contact evidence.');}
 const reconstructed=replayStore({schema,catalogue,overlay,nativeComponents:snapshot.permissions,roles:identity.roles,contactId:identity.contactId,nativeRelationships:inputs.nativeRelationships,observed});
 const store=reconstructed.store;applyNativeDataSnapshot(store,snapshot);
 const binding=await prepareNativeReplayPlugins({exportRoot:job.exportRoot,nativeRegistration:registration,context,serviceProfiles,sdkAssembly:job.sdkAssembly,proxyAssembly:job.proxyAssembly,cacheRoot,expectedAssemblyHashes:job.expectedAssemblyHashes,selectedStepIds:job.selectedStepIds,persistentHost:true,expectedRegistrationHash:registrationSha256});
 try{binding.bind(store);
 const settings=Object.fromEntries(site.filter(row=>row.powerpagecomponenttype===9&&row.statecode===0&&/^Webapi\//i.test(row.name)).map(row=>[row.name,JSON.parse(row.content).value]));
 const templates=site.filter(row=>row.powerpagecomponenttype===8&&row.statecode===0&&row.name.startsWith('CO Query ')).map(row=>({name:row.name,source:JSON.parse(row.content).source}));
 const dispatchers=site.filter(row=>row.powerpagecomponenttype===8&&row.statecode===0&&row.name==='CO Permission Lab Liquid Dispatcher');
 const datasetVersion=dispatchers.length===1?/assign dataset_version = '([^']+)'/.exec(JSON.parse(dispatchers[0].content).source)?.[1]:null;if(!datasetVersion)throw new Error('Frozen dispatcher dataset input is missing or ambiguous.');
 const finalObserverWitness=inputs.observerCalibration?validateFinalQueryObserverWitness(inputs.observerCalibration):undefined;
 const roleWitness=replayRoleWitness(job,cell,inputs);
 const result=await replayNativeReadBatch({binding,store,identity,capture,webApiPortal:{settings,observed},liquidReplay:{portal:{settings,observed},templates,datasetVersion},finalObserverWitness,sourceWitness:{before:snapshot,after,registrationSha256,siteComponents:{before:site,after:siteAfter}}});return {...result,roleWitness,allQualified:result.allQualified&&(!roleWitness||roleWitness.complete)};}finally{await binding.close();}
}

/** Offline only: no connector/client/browser/PAC dependency or live mutation.
 * Each cell has immutable native file receipts and an isolated local state. A
 * killed attempt is replayed; completed receipts survive in append-only files. */
export async function runMirageReplayCampaign(job,{replay=replayCell}={}){
 if(job?.schemaVersion!==1||!path.isAbsolute(job.outputRoot??'')||!path.isAbsolute(job.cacheRoot??''))throw new Error('An explicit bounded replay job and absolute owned output/cache directories are required.');
 let cells=await replayCells(job);if(!Array.isArray(cells)||!cells.length&&!job.cellsDirectory||cells.length>4096||job.expectedCells!==undefined&&cells.length>job.expectedCells)throw new Error('Replay requires a bounded physical cell set.');
 if(job.shard!==undefined){const {index,count}=job.shard;if(!Number.isInteger(index)||!Number.isInteger(count)||count<1||count>10||index<0||index>=count)throw new Error('Invalid process shard declaration.');cells=cells.filter(cell=>replayCellShard(cell.id,count)===index);}
 if(new Set(cells.map(cell=>cell.id)).size!==cells.length||cells.some(cell=>!/^[a-z\d][a-z\d_.-]{0,80}$/i.test(cell.id)))throw new Error('Replay cell identities must be unique bounded file-safe names.');
 const output=path.resolve(job.outputRoot),runtimeSha256=await replayRuntimeFingerprint(),jobSha256=sha(Buffer.from(stable(job))),lease=path.join(output,'worker.lock');await fs.mkdir(output,{recursive:true});
 const owner=randomUUID();await savePrivateJson(lease,{owner,pid:process.pid,startedAt:new Date().toISOString()},{exclusive:true});
 const ledgerFile=path.join(output,'replay.json');let ledger;const roleMasks=new Set(),runOwners=new Map(),operationOwners=new Map();
 try{
  try{ledger=JSON.parse(await boundedBytes(ledgerFile,64*1024*1024));}catch(error){if(error.code!=='ENOENT')throw error;ledger={schemaVersion:1,kind:'OfflineOriginalDllWireReplay',jobSha256,runtimeSha256,cells:[],startedAt:new Date().toISOString()};}
  if(ledger.jobSha256!==jobSha256||ledger.runtimeSha256!==runtimeSha256)throw new Error('Replay job or local runtime changed; use a new output directory to retain old evidence.');
  const archives=path.join(output,'inputs');if(await replayRuntimeFingerprint({archiveRoot:path.join(output,'runtime-sources'),onArchive:receipt=>{ledger.runtimeSourceArchive=receipt;}})!==runtimeSha256)throw new Error('Runtime changed while archiving source inputs.');await savePrivateJson(ledgerFile,ledger);
  if(ledger.cells.some(entry=>!cells.some(cell=>cell.id===entry.id)))throw new Error('A previously recorded replay cell was removed from the append-only source.');
  for(const cell of cells){const inputSha256=sha(Buffer.from(stable(cell))),previous=ledger.cells.filter(entry=>entry.id===cell.id).at(-1);if(previous&&previous.inputSha256!==inputSha256)throw new Error('An existing replay cell specification changed; use a new output directory.');
   // Recheck every pinned source input even when resuming an already completed
   // result. A stale file path/hash label cannot preserve qualification.
   const {inputs,inputArchives}=await loadReplayCellInputs(job,cell,{archiveRoot:archives}),roleWitness=replayRoleWitness(job,cell,inputs);
   if(roleWitness){if(roleMasks.has(roleWitness.mask))throw new Error('A role mask was declared more than once.');roleMasks.add(roleWitness.mask);for(const[id,owners]of [[roleWitness.runIds,runOwners],[roleWitness.operationIds,operationOwners]])for(const value of id){if(owners.has(value)&&owners.get(value)!==cell.id)throw new Error('Native Run/operation identities were reused across role masks.');owners.set(value,cell.id);}}
   if(previous?.state==='complete'&&(!job.retryUnqualified||previous.allQualified)){
   if(path.dirname(previous.resultFile)!==output)throw new Error('Completed result escaped its owned output.');const bytes=await boundedBytes(previous.resultFile,64*1024*1024);if(sha(bytes)!==previous.resultSha256)throw new Error('Completed replay result no longer matches its immutable receipt.');const result=JSON.parse(bytes);if(stable(result.roleWitness??null)!==stable(roleWitness)||roleWitness&&result.pages?.length!==roleWitness.physicalReads)throw new Error('Resumed role proof does not match actual current pinned memberships/page inputs.');continue;}
   const attempt=randomUUID(),entry={id:cell.id,attempt,state:'running',startedAt:new Date().toISOString(),inputSha256};ledger.cells.push(entry);await savePrivateJson(ledgerFile,ledger);
   try{
    entry.inputArchives=inputArchives;await savePrivateJson(ledgerFile,ledger);
    for(const part of inputs.nativePages??[inputs])for(const key of ['schema','catalogue','observed','serviceProfiles','assemblyReceipt','snapshotBefore','snapshotAfter','capture','registrationBefore','registrationAfter','siteBefore','siteAfter'])if((part[key]??inputs[key])===undefined)throw new Error('Required frozen replay input is missing: '+key);
    if(await replayRuntimeFingerprint()!==runtimeSha256)throw new Error('Local replay runtime changed before this cell; use a new output directory.');
    const result=await replay({job,cell,inputs,cacheRoot:path.resolve(job.cacheRoot,cell.id)}),file=path.join(output,`${cell.id}.${attempt}.json`);if(roleWitness&&(stable(result.roleWitness)!==stable(roleWitness)||result.pages?.length!==roleWitness.physicalReads||result.allQualified&&(!roleWitness.complete||result.pages.some(page=>page.qualified!==true))))throw new Error('Role replay result does not cover its exact native physical page set.');
    if(await replayRuntimeFingerprint()!==runtimeSha256)throw new Error('Local replay runtime changed during this cell; no result can be qualified.');
    const bytes=Buffer.from(JSON.stringify(result,null,2)+'\n');await savePrivateJson(file,result,{exclusive:true});
    Object.assign(entry,{state:'complete',resultFile:file,resultSha256:sha(bytes),physicalReads:result.physicalReads,qualifiedReads:result.qualifiedReads,allQualified:result.allQualified===true,roleWitness,allRuntimeFaultCodesQualified:result.allRuntimeFaultCodesQualified===true,finishedAt:new Date().toISOString()});
   }catch(error){Object.assign(entry,{state:'failed',errorCode:error.code??error.name,finishedAt:new Date().toISOString()});await savePrivateJson(ledgerFile,ledger);throw error;}
   await savePrivateJson(ledgerFile,ledger);
  }
  const latest=cells.map(cell=>ledger.cells.filter(entry=>entry.id===cell.id).at(-1)),qualified=latest.filter(entry=>entry.allQualified).length,expectedCells=job.expectedCells??cells.length;return {pid:process.pid,jobSha256,runtimeSha256,expectedCells,cells:latest.length,complete:latest.filter(entry=>entry.state==='complete').length,qualified,allQualified:qualified===expectedCells,coverageScope:job.roleCampaign?'Frozen native role-mask lattice':'Physical-only diagnostic; exhaustive roles unqualified',exhaustiveRoleCoverageQualified:Boolean(job.roleCampaign)&&!job.shard&&expectedCells===4096&&roleMasks.size===4096&&qualified===4096,physicalReads:latest.reduce((sum,entry)=>sum+(entry.physicalReads??0),0),qualifiedReads:latest.reduce((sum,entry)=>sum+(entry.qualifiedReads??0),0),ledgerFile};
 }finally{let actual;try{actual=JSON.parse(await boundedBytes(lease,65536));}catch{}if(actual?.owner===owner)await fs.unlink(lease);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--job')throw new Error('Usage: node mirage-campaign-replay.mjs --job <private offline job.json>');
 console.log(JSON.stringify(await runMirageReplayCampaign(JSON.parse(await boundedBytes(path.resolve(args[1]),65536)))));
}
