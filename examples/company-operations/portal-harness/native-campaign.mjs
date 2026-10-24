import {readFile,writeFile,mkdir,stat,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {loadConnection,connectedClient} from 'paqvilo/dataverse';
import {buildBlueprint} from '../portal-security/blueprint.mjs';
import {buildQualificationDomain,qualificationRoleMasks} from '../portal-security/qualification-domain.mjs';
import {beginRoleLease,setLeasedRoles,recoverRoleLease} from './native-role-lease.mjs';
import {openNativeBrowser} from './native-browser.mjs';
import {stable} from './core.mjs';
import {savePrivateJson} from './private-journal.mjs';
import {captureNativeSnapshot,snapshotHash} from './native-capture.mjs';
import {captureNativeRegistry} from './native-registry.mjs';
import {nativeRegistrationFingerprint,recordedPluginPayloads} from '../plugins/mirage-runtime.mjs';

const load=async file=>JSON.parse(await readFile(file,'utf8'));
const digest=value=>createHash('sha256').update(stable(value)).digest('hex');
/** The coordinator uses one explicit actor lock across campaign directories.
 * A stale file is retained for verified process-dead recovery; never auto-steal
 * it or restore another running collector's membership lease. */
export async function withNativeCampaignWorkerLease(config,work) {
 const {workerLock,siteId,contactId}=config,guid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
 if(!guid.test(siteId??'')||!guid.test(contactId??'')||typeof workerLock!=='string'||!path.isAbsolute(workerLock)||workerLock.includes('\0')||path.basename(workerLock)!==`${siteId.toLowerCase()}-${contactId.toLowerCase()}.native-campaign.lock.json`)throw new Error('Native campaign requires an explicit shared actor workerLock with its site/contact filename.');
 await mkdir(path.dirname(workerLock),{recursive:true});
 const owner=randomUUID(),lease={kind:'NativeCampaignWorkerLease',owner,pid:process.pid,siteId,contactId,startedAt:new Date().toISOString()};
 await savePrivateJson(workerLock,lease,{exclusive:true});
 try{return await work();}finally{
  const actual=JSON.parse(await readFile(workerLock,'utf8'));
// eslint-disable-next-line no-unsafe-finally -- Ownership drift must prevent cleanup of a foreign lease even after an operation failure.
  if(stable(actual)!==stable(lease))throw new Error('Native campaign worker lock ownership changed; recovery refused.');
  await unlink(workerLock);
 }
}
export async function campaignStopRequested(stopFile) {
 if(stopFile===undefined)return false;
 if(typeof stopFile!=='string'||!path.isAbsolute(stopFile)||stopFile.includes('\0'))throw new Error('Campaign stopFile must be an explicit absolute local path.');
 try{return (await stat(stopFile)).isFile();}catch(error){if(error.code==='ENOENT')return false;throw error;}
}
export function continuationCases(capture,manifest) {
 const plans=[...(manifest.cases??[]),...(manifest.stressCases??[])],pending=new Set();
 for(const request of capture.requests??[]){const plan=plans.find(plan=>plan.id===request.caseId);if(!plan)throw new Error('Continuation request is outside the frozen query catalogue.');
  if(request.lane==='liquid'){const result=capture.liquidPages?.find(page=>page.operationId===request.operationId);if(result?.outcome==='success'&&result.more===true)pending.add(plan.id);}
  else if(request.lane==='webapi'){const response=capture.results?.find(result=>result.operationId===request.operationId&&result.lane==='webapi');let body;try{body=JSON.parse(response?.body);}catch{ /* Optional payload or browser capability is unavailable. */ }
   if(response?.status===200&&Array.isArray(body?.value)&&(body['@odata.nextLink']||body.value.length===plan.pageSize))pending.add(plan.id);
  }
 }
 return [...pending].sort();
}
export function pendingCampaignMasks(domain,journal,maxMasks) {
 if(!Number.isInteger(maxMasks)||maxMasks<1||maxMasks>4096)throw new Error('Explicit campaign batch size required.');
 if(journal.domainHash!==domain.domainHash)throw new Error('Campaign source domain changed; create a new campaign.');
 const completed=new Set(journal.masks.filter(row=>row.state==='collected').map(row=>row.mask));
 return [...qualificationRoleMasks(domain)].filter(row=>!completed.has(row.mask)).slice(0,maxMasks);
}
export function campaignFrozenWitnesses({snapshot,siteComponentsSha256,registrationSha256,assemblies}) {
 if(!snapshot.complete)throw new Error('Native campaign requires a complete source fixture snapshot.');
 return {nativeConfiguration:digest({permissionSnapshotHash:snapshot.permissionSnapshotHash,registrationSha256,assemblies}),
  nativeMemberships:snapshot.membershipSnapshotHash,nativeFixtures:digest({dataSnapshotHash:snapshot.dataSnapshotHash,rowVersionSnapshotHash:snapshot.rowVersionSnapshotHash}),
  nativeSettings:siteComponentsSha256,nativeTemplates:siteComponentsSha256};
}
export function nativeAssemblyIdentityMatches(actual,expected) {
 // Installation availability is a prerequisite, not a field emitted by CLR.
 return expected?.available === true && ['name','version','moduleVersionId'].every(field =>
  typeof actual?.[field] === 'string' && actual[field].length > 0 && actual[field] === expected[field]);
}
function assertCaptureSource(capture,frozen) {
 const qualification=capture.qualification;
 if(!qualification?.sourcesStable||!qualification.registrationStable||!qualification.portalActorVerified||!Array.isArray(qualification.physical)||qualification.physical.length!==capture.requests?.length||qualification.physical.some(row=>!Array.isArray(row.errors)||row.errors.length))throw new Error('Native capture did not preserve complete source/registration/actor witnesses.');
 if(!capture.archive?.sha256||!capture.history?.operations)throw new Error('Native campaign requires immutable archive and persisted per-operation history.');
 if(qualification.registrationSha256!==frozen.registrationSha256||['before','after'].some(side=>qualification.siteComponentsSha256?.[side]!==frozen.siteComponentsSha256))throw new Error('Native campaign frozen source/registration witness changed.');
 for(const payload of recordedPluginPayloads(capture.backendEvents)){const actual=payload.assemblyIdentity,expected=frozen.assemblies.find(row=>row.assemblyIdentity.name===actual?.name);if(!expected||!nativeAssemblyIdentityMatches(actual,expected.assemblyIdentity))throw new Error('Native recording assembly identity changed during the campaign.');}
}
function assertFrozenCapture(capture,frozen) {
 assertCaptureSource(capture,frozen);
 if(!capture.qualification.snapshotComparison?.stable)throw new Error('Native capture fixture/rowversion snapshot changed.');
 for(const field of ['permissionSnapshotHash','dataSnapshotHash','rowVersionSnapshotHash'])if(['before','after'].some(side=>capture.qualification.snapshotHashes?.[field]?.[side]!==frozen.snapshot[field]))throw new Error('Native campaign frozen permission/data witness changed.');
}
export function nativeCampaignContinuationPolicy(value='per-page') {
 if(!['per-page','mask-window'].includes(value))throw new Error('Native campaign continuation policy must be explicit per-page or mask-window.');
 if(value==='mask-window')throw new Error('Shared-mask collection is not implemented in this collector; use per-page.');
 return value;
}
async function clearRestoredCache(config,journalFile) {
 const browser=await openNativeBrowser(config.browser),journal={kind:'NativeCampaignCacheRestore',startedAt:new Date().toISOString(),actions:[{name:'clearConfig',status:'pending'},{name:'clearCache',status:'planned'}]},save=()=>savePrivateJson(journalFile,journal);
 await savePrivateJson(journalFile,journal,{exclusive:true});
 try{await browser.run(`async(page)=>{await page.goto(${JSON.stringify(config.portalOrigin+'/_services/about')},{waitUntil:'domcontentloaded'});await page.locator('input[name=clearConfig]').click();return{cleared:true};}`);journal.actions[0].status='completed';journal.actions[1].status='pending';await save();
  await browser.run(`async(page)=>{await page.goto(${JSON.stringify(config.portalOrigin+'/_services/about')},{waitUntil:'domcontentloaded'});page.once('dialog',dialog=>dialog.accept());await page.locator('input[name=clearCache]').click({timeout:90000});return{cleared:true};}`,120000);journal.actions[1].status='completed';journal.finishedAt=new Date().toISOString();await save();
 }finally{await browser.close();}
}
/** Native collection only: replay qualification is a separate strict evidence gate.
 * Each bounded invocation restores original memberships and portal caches. */
export async function runNativeCampaign(config,{runChild=defaultChild}={}) {
 if(config.allowNativeRoleMutation!==true)throw new Error('Native campaign requires explicit role mutation authorization in its private job configuration.');
 return withNativeCampaignWorkerLease(config,()=>runOwnedNativeCampaign(config,{runChild}));
}
async function runOwnedNativeCampaign(config,{runChild}) {
 nativeCampaignContinuationPolicy(config.continuationPolicy);
 await campaignStopRequested(config.stopFile);
 const [manifest,schema,catalogue]=await Promise.all([load(config.manifest),load(config.schema),load(config.catalogue)]),blueprint=buildBlueprint(schema,catalogue),domain=buildQualificationDomain({blueprint,schema,catalogue,manifest,witnesses:config.witnesses??{}});
 if(domain.missingNativeWitnesses.length)throw new Error('Native campaign requires all five declared frozen configuration witnesses.');
 const directory=path.resolve(config.campaignDir);await mkdir(directory,{recursive:true});const journalFile=path.join(directory,'campaign.json');let journal;
 try{journal=await load(journalFile);}catch(error){if(error.code!=='ENOENT')throw error;journal={schemaVersion:1,kind:'NativeRoleReadCampaign',domainHash:domain.domainHash,inputHash:domain.inputHash,startedAt:new Date().toISOString(),masks:[],batches:[],state:'planned'};await savePrivateJson(journalFile,journal,{exclusive:true});await writeFile(path.join(directory,'domain.json'),JSON.stringify(domain,null,2),{flag:'wx'});}
 const selected=pendingCampaignMasks(domain,journal,config.maxMasksPerBatch),save=()=>savePrivateJson(journalFile,journal);
 const api=connectedClient(await loadConnection(config.connection)),deployment=await load(config.deployment);
 for(const interrupted of journal.batches.filter(batch=>batch.state!=='restored')){
  // The existing lease is authoritative for recovery. Unknown membership
  // drift is rejected by recoverRoleLease; no completed evidence is replaced.
  await recoverRoleLease(api,path.join(directory,interrupted.id+'-role-lease.json'));
  await clearRestoredCache(config,path.join(directory,interrupted.id+'-recovery-cache-'+Date.now()+'.json'));
  interrupted.state='restored';interrupted.recoveredAt=new Date().toISOString();await save();
 }
 const snapshot=await captureNativeSnapshot(api,{siteId:config.siteId,contactId:config.contactId,catalogue,overlays:await Promise.all(config.overlays.map(load)),resolvedIds:deployment.resolvedIds??{}});
 const components=await api.list(`powerpagecomponents?$select=powerpagecomponentid,powerpagecomponenttype,name,statecode,statuscode,content,_powerpagesiteid_value&$filter=_powerpagesiteid_value eq ${config.siteId}`),logicalComponents=components.map(row=>Object.fromEntries(Object.entries(row).filter(([field])=>!field.startsWith('@')))).sort((a,b)=>a.powerpagecomponentid.localeCompare(b.powerpagecomponentid));
 const registration=await captureNativeRegistry(api,await load(config.nativeRegistration)),registrationSha256=nativeRegistrationFingerprint(registration),receipt=await load(config.assemblyReceipt),assemblies=[];
 for(const expected of receipt.hashes){const actual=await api.list(`pluginassemblies?$select=name,content&$filter=name eq '${expected.name.replaceAll("'","''")}'`);if(actual.length!==1||createHash('sha256').update(Buffer.from(actual[0].content,'base64')).digest('hex')!==expected.sha256)throw new Error('Native assembly bytes changed before campaign activation.');assemblies.push(expected);}
 const frozen={snapshot,siteComponentsSha256:snapshotHash(logicalComponents),registrationSha256,assemblies};
 if(stable(campaignFrozenWitnesses(frozen))!==stable(config.witnesses))throw new Error('Native campaign five source witnesses changed; create a new frozen campaign configuration.');
 const batch={id:'batch-'+Date.now(),startedAt:new Date().toISOString(),selectedMasks:selected.map(row=>row.mask),state:'preflight'};journal.batches.push(batch);await save();
 const roleFile=path.join(directory,batch.id+'-role-lease.json');await beginRoleLease(api,{siteId:config.siteId,contactId:config.contactId,roleIds:domain.businessRoles.map(role=>role.id),journalFile:roleFile});
 try{batch.state='active';journal.state='collecting';await save();for(const roles of selected){if(await campaignStopRequested(config.stopFile)){batch.stopRequestedAt=new Date().toISOString();journal.state='graceful-stop-requested';await save();break;}await setLeasedRoles(api,roleFile,roles.roleIds);const record={mask:roles.mask,roleCodes:roles.roleCodes,batch:batch.id,state:'pending',attempts:[]};journal.masks.push(record);await save();
  const folder=path.join(directory,batch.id,'m'+roles.mask);await mkdir(folder,{recursive:true});let cases=[...manifest.cases,...(manifest.stressCases??[]),...(manifest.odataVariants??[]),...(manifest.odataPositiveVariants??[])].map(plan=>plan.id),page=1;
  while(cases.length){if(page>20)throw new Error('Native paging exceeded the frozen domain bound; preserve evidence and enlarge the explicit domain before continuing.');const outputDir=path.join(folder,'page-'+page),job={...config,outputDir,caseIds:cases,page,persistHistory:true,businessRoleNames:domain.businessRoles.map(role=>role.name),expectedBusinessRoleNames:roles.roleNames,campaign:{directory,domainHash:domain.domainHash,mask:roles.mask,roleCodes:roles.roleCodes,page}};
   const jobFile=path.join(folder,'page-'+page+'-config.json');await writeFile(jobFile,JSON.stringify(job,null,2),{flag:'wx'});record.attempts.push({page,outputDir,state:'pending'});await save();await runChild(jobFile);const capture=await load(path.join(outputDir,'capture.json'));assertFrozenCapture(capture,frozen);record.attempts.at(-1).state='archived';record.attempts.at(-1).archiveSha256=capture.archive.sha256;record.attempts.at(-1).physicalRequests=capture.requests.length;
   // OData-only reads have no FetchXML continuation contract in this manifest.
   cases=continuationCases({...capture,requests:capture.requests.filter(request=>request.authoredFetchXml)},manifest);await save();page++;
  }
  record.state='collected';record.finishedAt=new Date().toISOString();record.artifactHash=digest(record.attempts);await save();
 }
 }finally{await recoverRoleLease(api,roleFile);batch.state='memberships-restored';await save();await clearRestoredCache(config,path.join(directory,batch.id+'-restore-cache.json'));batch.state='restored';batch.finishedAt=new Date().toISOString();journal.state='paused-between-batches';await save();}
 return{directory,domainHash:domain.domainHash,collectedMasks:new Set(journal.masks.filter(row=>row.state==='collected').map(row=>row.mask)).size,totalMasks:domain.roleMaskCount,qualification:'native-collection-only',baselineRestored:true};
}
async function defaultChild(file){await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(path.dirname(fileURLToPath(import.meta.url)),'native-batch-prototype.mjs'),file],{stdio:['ignore','ignore','inherit']});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Native campaign child failed; private evidence preserved.')));});}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){if(!process.argv[2])throw new Error('Private native campaign configuration path required.');console.log(JSON.stringify(await runNativeCampaign(await load(process.argv[2]))));}
