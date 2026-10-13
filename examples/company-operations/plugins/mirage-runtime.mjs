import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parsePluginDocument,importSolutionPlugins,pluginCatalogue,runPluginPhase} from 'paqvilo/mirage/lib/exported-plugins.mjs';
import {prepareClrRuntime,validateClrDescriptor,canonicalClrDirectory,closeClrHostPool} from 'paqvilo/mirage/lib/plugin-clr.mjs';
import {parseSolutionXml} from 'paqvilo/mirage/lib/solution-xml.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const spanDto=value=>value?.type==='String'&&value.truncated===false&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.value??'')?{...value,value:'[generated span GUID]'}:value;
const generatedGuid=value=>typeof value==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)?'[generated GUID]':value;
const generatedTime=value=>typeof value==='string'&&/^\/Date\(-?\d+\)\/$/.test(value)?'[generated UTC DateTime]':value;
const generatedCaptureTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value)&&Number.isFinite(Date.parse(value))?'[generated UTC capture string]':value;
const child=(node,name)=>node.children?.find(item=>item.name.toLowerCase()===name.toLowerCase());
const value=(node,name)=>child(node,name)?.text??node.attrs?.[name]??null;
async function regular(file){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)throw new Error('Native runtime source must be a bounded regular file.');return fs.readFile(file);}
async function files(root){const answer=[];for(const item of await fs.readdir(root,{withFileTypes:true})){const file=path.join(root,item.name);if(item.isSymbolicLink())throw new Error('Native runtime exports cannot contain symbolic links.');if(item.isDirectory())answer.push(...await files(file));else if(item.isFile())answer.push(file);}return answer;}

export function nativeRegistrationFingerprint(registration){
 const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!key.startsWith('@')).map(([key,item])=>[key,clean(item)])):value;
 const snapshot={schemaVersion:registration.schemaVersion,applicationUserId:registration.applicationUserId};
 for(const [section,key]of [['steps','sdkmessageprocessingstepid'],['filters','sdkmessagefilterid'],['messages','sdkmessageid'],['images','sdkmessageprocessingstepimageid']]){
  if(!Array.isArray(registration[section]))throw new Error('Native registration witness is incomplete.');
  snapshot[section]=registration[section].map(clean).sort((left,right)=>String(left[key]).localeCompare(String(right[key])));
 }
 return hash(Buffer.from(JSON.stringify(canonical(snapshot))));
}

/** This explicit trusted project adapter uses original exported DLL bytes. It
 * never downloads SDK assemblies or contacts Dataverse. Private configuration
 * stays in the returned pack; summaries contain hashes and registration IDs. */
export async function prepareNativeReplayPlugins({exportRoot,nativeSteps=[],nativeRegistration,sdkMessages={},context,
 serviceProfiles,sdkAssembly,proxyAssembly,cacheRoot,expectedAssemblyHashes,selectedStepIds,
 secureConfigurationByStep={},persistentHost=false,expectedRegistrationHash}){
 if(!Array.isArray(serviceProfiles)||!serviceProfiles.length)throw new Error('Explicit backend caller profiles are required.');
 const registrationSha256=nativeRegistration?nativeRegistrationFingerprint(nativeRegistration):null;
 if(expectedRegistrationHash&&registrationSha256!==expectedRegistrationHash)throw new Error('Native registration snapshot does not match the required campaign witness.');
 const root=await fs.realpath(exportRoot),documents=[],configuration=new Map(),exportedFiles=await files(root);
 for(const file of exportedFiles.filter(file=>file.endsWith('.xml'))){
  if(!file.includes(`${path.sep}PluginAssemblies${path.sep}`)&&!file.includes(`${path.sep}SdkMessageProcessingSteps${path.sep}`))continue;
  const bytes=await regular(file),xml=bytes.toString('utf8'),facts=parsePluginDocument(xml);documents.push({file,hash:hash(bytes),facts:{plugins:facts}});
  const document=parseSolutionXml(xml);
  if(document.name==='SdkMessageProcessingStep'){const id=(document.attrs.SdkMessageProcessingStepId??'').replace(/[{}]/g,'').toLowerCase();configuration.set(id,value(document,'Configuration'));}
 }
 if(nativeRegistration){
  const filters=new Map(nativeRegistration.filters.map(filter=>[filter.sdkmessagefilterid,filter]));
  for(const message of nativeRegistration.messages)sdkMessages[message.sdkmessageid]={name:message.name,evidence:'Fresh native SDK message registration snapshot'};
  nativeSteps=nativeRegistration.steps.map(step=>({id:step.sdkmessageprocessingstepid,name:step.name,configuration:step.configuration,
   message:sdkMessages[step._sdkmessageid_value]?.name,entity:filters.get(step._sdkmessagefilterid_value)?.primaryobjecttypecode??'*',
   stage:step.stage,rank:step.rank,mode:step.mode,enabled:step.statecode===0,impersonatingUserId:step._impersonatinguserid_value,
   filteringAttributes:String(step.filteringattributes??'').split(',').filter(Boolean),images:nativeRegistration.images.filter(image=>image._sdkmessageprocessingstepid_value===step.sdkmessageprocessingstepid).map(image=>({name:image.name,alias:image.entityalias,type:image.imagetype,attributes:String(image.attributes??'').split(',').filter(Boolean)}))}));
 }
 const nativeById=new Map(nativeSteps.map(step=>[step.id??step.sdkmessageprocessingstepid,step]));
 const inventory=importSolutionPlugins([{documents}],{sdkMessages});
 inventory.steps=inventory.steps.map(step=>{
  const native=nativeById.get(step.id);if(!native)return step;
  if(native.configuration!==undefined)configuration.set(step.id,native.configuration);
  return {...step,...Object.fromEntries(['name','message','entity','stage','rank','mode','enabled','filteringAttributes','images','impersonatingUserId'].filter(key=>native[key]!==undefined).map(key=>[key,native[key]]))};
 });
 const selected=selectedStepIds?new Set(selectedStepIds):null;
 if(selected)for(const id of selected){const step=inventory.steps.find(step=>step.id===id);if(!step||!step.enabled||nativeRegistration&&!nativeById.has(id))throw new Error('A selected native runtime step is absent or disabled.');}
 const assemblyFiles=new Map(),receipts=[];
 for(const assembly of inventory.assemblies){
  const relative=String(assembly.binaryPath??'').replace(/^[/\\]/,'');
  const file=path.resolve(root,relative),bound=path.relative(root,file);if(bound.startsWith('..')||path.isAbsolute(bound))throw new Error('Assembly export escaped its declared root.');
  const bytes=await regular(file),sha256=hash(bytes),expected=expectedAssemblyHashes?.[assembly.name];
  if(!expected||expected!==sha256)throw new Error('Original assembly bytes do not match the required native receipt.');
  assemblyFiles.set(assembly.id,{file,sha256});receipts.push({assembly:assembly.name,sha256});
 }
 if(!path.isAbsolute(cacheRoot))throw new Error('An explicit absolute owned native runtime cache is required.');
 await fs.mkdir(cacheRoot,{recursive:true});await canonicalClrDirectory(cacheRoot);
 const workRoot=path.resolve(cacheRoot,'trusted-originals');await fs.mkdir(workRoot,{recursive:true});await canonicalClrDirectory(workRoot);
 const proxyBytes=proxyAssembly?await regular(proxyAssembly):null;
 if(proxyBytes)await fs.writeFile(path.join(workRoot,path.basename(proxyAssembly)),proxyBytes);
 const prepared=new Map(),runtimes=new Map(),pluginRuntimes={},overrides={};
 for(const step of inventory.steps){
  if(!step.enabled||selected&&!selected.has(step.id))continue;
  if(!step.typeName||!step.message)throw new Error('A selected native registration has no resolved type or SDK message.');
  const assembly=assemblyFiles.get(step.assemblyId);if(!assembly)throw new Error('A selected native registration has no verified original assembly.');
  const assemblyName=path.basename(assembly.file);await fs.writeFile(path.join(workRoot,assemblyName),await regular(assembly.file));
  const profile=serviceProfiles.find(profile=>profile.userId.toLowerCase()===(context.userId??context.initiatingUserId).toLowerCase());
  if(!profile)throw new Error('The observed runtime caller has no explicit backend grant profile.');
  const descriptor=validateClrDescriptor({trust:'execute-local-assembly',root:workRoot,assembly:assemblyName,typeName:step.typeName,
   sdkRoot:path.dirname(sdkAssembly),sdkAssembly:path.basename(sdkAssembly),dependencies:proxyBytes?[path.basename(proxyAssembly)]:[],cacheRoot:path.resolve(cacheRoot,'hosts'),
   serviceProfile:profile,sdkCallerProfiles:serviceProfiles.filter(item=>item!==profile),context:{...context,...(step.impersonatingUserId?{executionUserId:step.impersonatingUserId}:{})},
   unsecureConfiguration:configuration.get(step.id)??null,secureConfiguration:secureConfigurationByStep[step.id]??null,timeoutMs:10000,persistentHost});
  const key=`${assembly.sha256}/${step.typeName}`;
  if(!prepared.has(key))prepared.set(key,await prepareClrRuntime(descriptor));
  const runtime={...prepared.get(key),descriptor};runtimes.set(step.id,runtime);pluginRuntimes[step.id]=descriptor;overrides[`plugin-step:${step.id}`]={mode:'clr'};
 }
 const pack={id:'company-operations-native-plugins',pluginRuntimes};
 const items=pluginCatalogue({plugins:inventory,runtimes,overrides});
 return {pack,inventory,runtimes,items,receipt:{scope:'Trusted original exported assemblies; local SDK backend',assemblies:receipts,selectedSteps:runtimes.size,registrationSha256,sourceDocuments:documents.map(document=>({file:path.relative(root,document.file).replaceAll('\\','/'),sha256:document.hash})),sdkSha256:hash(await regular(sdkAssembly)),proxySha256:proxyBytes?hash(proxyBytes):null,
  secureConfiguration:'Only explicitly supplied installation-safe fixtures; native secure values are never read or copied'},
  setReadContext(snapshot){const observed=contextFromNativeCapture(snapshot),profile=serviceProfiles.find(profile=>profile.userId.toLowerCase()===observed.userId.toLowerCase());if(!profile)throw new Error('The observed read caller has no explicit backend grant profile.');for(const runtime of runtimes.values()){const executionUserId=runtime.descriptor.context.executionUserId;runtime.descriptor=validateClrDescriptor({...runtime.descriptor,serviceProfile:profile,sdkCallerProfiles:serviceProfiles.filter(item=>item!==profile),context:{...observed,...(executionUserId?{executionUserId}:{})}});}},
  close(diagnostic=()=>{}){for(const runtime of runtimes.values())closeClrHostPool({runtime,diagnostic});},
  bind(store,diagnostic=()=>{}){store.setPluginPipeline(event=>runPluginPhase({...event,store,items,runtimes,diagnostic}),event=>items.some(item=>item.enabled&&item.entity===event.entity&&String(item.message).toLowerCase()===event.operation&&runtimes.has(item.id)));}};
}

export function contextFromNativeCapture(snapshot){
 const extension=snapshot.extensions;
 if(snapshot.interfaceVersion!==7||!extension?.context6?.observed||!extension?.context7?.observed)throw new Error('Complete observed Context7 identity metadata is required.');
 return {userId:snapshot.UserId,initiatingUserId:snapshot.InitiatingUserId,organizationId:snapshot.OrganizationId,businessUnitId:snapshot.BusinessUnitId,
  organizationName:snapshot.organizationName?.value??'',secondaryEntityName:snapshot.SecondaryEntityName??'',interfaceVersion:7,environmentId:extension.context6.values.environmentId.value,
  tenantId:extension.context6.values.tenantId.value,isApplicationUser:extension.context7.values.IsApplicationUser,
  initiatingUserAgentPresent:extension.context5.values.initiatingUserAgentPresent,portalInputParameters:Object.fromEntries(Object.entries(snapshot.input??{}).filter(([name])=>['AppModuleId','IsAppModuleContext','IncludeAnnotations'].includes(name)).map(([name,value])=>[name,value.type==='Guid'?{$type:'Guid',value:value.value}:value.value])),...(snapshot.output?.BusinessEntityCollection?.entities?.length===0&&snapshot.output.BusinessEntityCollection.pagingCookie===''?{emptyFetchPagingCookie:''}:{})};
}

/** Context has generated clocks and IDs. Compare explicit stable fields and
 * classify volatile fields independently; never label full snapshots equal. */
export function compareRecordedContexts(native,local){
 const fields=['schemaVersion','MessageName','PrimaryEntityName','PrimaryEntityId','SecondaryEntityName','Stage','Mode','executionOrder','Depth','IsInTransaction','UserId','InitiatingUserId','BusinessUnitId','OrganizationId','organizationName','IsolationMode','IsExecutingOffline','IsOfflinePlayback','interfaceVersion','extensions','owningExtension','input','output','preImages','postImages','sharedVariables','parents','parentTruncated','CorrelationId','RequestId','OperationId','OperationCreatedOn'];
 const stable=(value,field)=>['CorrelationId','RequestId','OperationId'].includes(field)?generatedGuid(value):field==='OperationCreatedOn'?generatedTime(value):field==='sharedVariables'&&value?{...value,...(Object.hasOwn(value,'pqvd.lab.span')?{'pqvd.lab.span':spanDto(value['pqvd.lab.span'])}:{})}:field==='parents'&&Array.isArray(value)?value.map(parent=>Object.fromEntries(Object.entries(parent).map(([key,item])=>[key,stable(item,key)]))):value;
 const differences=fields.filter(field=>JSON.stringify(canonical(stable(native[field],field)))!==JSON.stringify(canonical(stable(local[field],field)))).map(field=>({field,native:native[field],local:local[field]}));
 return {stableEqual:differences.length===0,differences,generatedFields:['CorrelationId','RequestId','OperationId','OperationCreatedOn','sharedVariables.pqvd.lab.span'],fullSnapshotEqual:false};
}

export function compareRecordedPluginArtifacts(native,local){
 const fields=['schemaVersion','assemblyIdentity','operationId','artifact','content','durability','captureTime','spanId','parentSpanId'];
 const normalize=(value,key)=>key==='captureTime'?generatedCaptureTime(value):['spanId','parentSpanId'].includes(key)?generatedGuid(value):value;
 const differences=fields.filter(field=>JSON.stringify(canonical(normalize(native[field],field)))!==JSON.stringify(canonical(normalize(local[field],field)))).map(field=>({field,native:native[field],local:local[field]}));
 return {stableEqual:differences.length===0,differences,generatedFields:['captureTime','spanId','parentSpanId'],fullSnapshotEqual:false};
}

/** Load frozen native records, including platform defaults absent from seed
 * manifests. Metadata resolves lookup targets; no identity or grant is inferred
 * from the source rows. This is an explicit local snapshot replacement. */
export function applyNativeDataSnapshot(store,snapshot,{rowVersions=snapshot?.rowVersions??{}}={}){
 if(!snapshot?.tables||!snapshot.projections)throw new Error('A complete native data/projection snapshot is required.');
 const tables=structuredClone(store.state.tables),mappings=structuredClone(store.state.mappings);
 for(const[entity,rows]of Object.entries(snapshot.tables)){
  if(!Array.isArray(rows)||rows.length>10000)throw new Error('Native snapshot table exceeds local bounds.');
  const mapping=store.resolveMapping(entity);
  if(rowVersions[entity]){mappings[mapping.logicalName].sdkRowVersionColumn='versionnumber';mappings[mapping.logicalName].fields??={};mappings[mapping.logicalName].fields.versionnumber={type:'bigint'};}
  tables[mapping.logicalName]=rows.map(source=>{
   const row={};for(const[key,value]of Object.entries(source)){
    if(key.startsWith('@')||key.includes('@'))continue;
    const lookup=/^_(.+)_value$/.exec(key),field=lookup?.[1],targets=field&&store.fieldDefinition(entity,field)?.targets,annotation=lookup&&source[`${key}@Microsoft.Dynamics.CRM.lookuplogicalname`];
    if(annotation&&(!/^[a-z][a-z\d_]*$/i.test(annotation)||targets?.length&&!targets.includes(annotation)))throw new Error('Native lookup annotation conflicts with declared target metadata.');
    const target=annotation??(targets?.length===1?targets[0]:null);
    if(lookup&&value!==null&&target)row[field]={id:value,logical_name:target};
    else row[field??key]=value;
   }if(rowVersions[entity]?.[row[mapping.idColumn]]!==undefined)row.versionnumber=rowVersions[entity][row[mapping.idColumn]];return row;
  });
 }
 for(const[schemaName,rows]of Object.entries(snapshot.projections)){
  const relationship=store.state.relationships?.[schemaName];
  if(!relationship?.intersectEntity)throw new Error('Native projection has no exact imported relationship.');
  if(!Array.isArray(rows)||rows.length>10000)throw new Error('Native projection exceeds local bounds.');
  tables[relationship.intersectEntity]=structuredClone(rows);
 }
 store.state.tables=tables;store.state.mappings=mappings;
 Object.defineProperty(store,'nativeReadSnapshot',{value:Object.fromEntries(['permissionSnapshotHash','membershipSnapshotHash','dataSnapshotHash','rowVersionSnapshotHash','contactId','complete'].map(field=>[field,snapshot[field]])),writable:true,configurable:true});
 return {dataSnapshotHash:snapshot.dataSnapshotHash,tableCount:Object.keys(snapshot.tables).length,projectionCount:Object.keys(snapshot.projections).length};
}

export function recordedPluginPayloads(rows){
 const groups=new Map();for(const row of rows??[]){const key=row.pqvd_eventkey;if(!key)throw new Error('Native plugin event key is missing.');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 const answer=[];for(const parts of groups.values()){
  parts.sort((a,b)=>a.pqvd_partnumber-b.pqvd_partnumber);const count=parts[0].pqvd_partcount;
  if(count!==parts.length||parts.some((part,index)=>part.pqvd_partnumber!==index+1||part.pqvd_partcount!==count||part.pqvd_payloadhash!==parts[0].pqvd_payloadhash))throw new Error('Native plugin event parts are incomplete or inconsistent.');
  const text=parts.map(part=>part.pqvd_payloadtext).join('');if(hash(Buffer.from(text))!==parts[0].pqvd_payloadhash)throw new Error('Native plugin payload checksum does not match.');answer.push(JSON.parse(text));
 }return answer;
}

/** Artifact equality is not proof that graph, memberships, data or registration
 * stayed frozen during native capture. Every campaign must supply both reads. */
export function validateNativeReadWitness(witness,receipt,loaded){
 const fields=['permissionSnapshotHash','membershipSnapshotHash','dataSnapshotHash','rowVersionSnapshotHash'],reasons=[];
 if(witness?.before?.complete!==true||witness?.after?.complete!==true||loaded?.complete!==true)reasons.push('sourceCompleteness');
 for(const field of fields){const before=witness?.before?.[field],after=witness?.after?.[field];if(!/^[a-f\d]{64}$/.test(before??'')||before!==after||before!==loaded?.[field])reasons.push(field);}
 if(!/^[a-f\d]{64}$/.test(witness?.registrationSha256??'')||witness.registrationSha256!==receipt?.registrationSha256)reasons.push('registrationSha256');
 return {verified:reasons.length===0,reasons};
}

/** Execute every authored physical read independently through the original DLL
 * binding. The caller supplies the already frozen graph/data/session; this hook
 * never changes native roles, permissions or data, and never feeds a captured
 * expanded query into the local execution path. */
export async function replayNativeReadBatch({binding,store,identity,capture,sourceWitness,progress=()=>{}}){
 const native=recordedPluginPayloads(capture.backendEvents),byOperation=new Map();
 for(const event of native){if(!byOperation.has(event.operationId))byOperation.set(event.operationId,[]);byOperation.get(event.operationId).push(event);}
 const results=new Map(capture.results.filter(result=>result.operationId).map(result=>[result.operationId,result]));
 const liquid=new Map((capture.liquidPages??[]).map(page=>[page.operationId,page]));
 const originalOperations=structuredClone(store.state.tables.pqvd_testoperation),originalEvents=structuredClone(store.state.tables.pqvd_pluginevent),started=Date.now(),pages=[];
 try{for(const request of capture.requests){
  store.state.tables.pqvd_testoperation=structuredClone(originalOperations);store.state.tables.pqvd_pluginevent=structuredClone(originalEvents);
  const expected=byOperation.get(request.operationId)??[],http=results.get(request.operationId),liquidPage=liquid.get(request.operationId);
  const source=request.authoredFetchXml??liquidPage?.authoredFetchXml;
  const root=source?parseSolutionXml(source).children.find(node=>node.name==='entity'):null;
  const table=root?.attrs.name;
  let result,error,captures=[];
  try{
   if(expected.length){binding.setReadContext((expected.find(event=>event.context.Stage===40)??expected[0]).context);}
   if(!source)throw new Error('Authored FetchXML is unavailable; this native query language requires its own witnessed adapter.');
   const tree=parseSolutionXml(source),conditions=[];const visit=node=>{if(node.name==='condition')conditions.push(node);for(const child of node.children??[])visit(child);};visit(tree);
   const marker=conditions.find(node=>node.attrs.value?.startsWith('CO-UTC:'))?.attrs.value;
   if(!marker)throw new Error('Authored operation UTC marker is unavailable.');
   const controller=identity.contactId??identity.id;
   store.state.tables.pqvd_testoperation=store.state.tables.pqvd_testoperation.filter(row=>row.pqvd_testoperationid!==request.operationId);
   store.state.tables.pqvd_testoperation.push({pqvd_testoperationid:request.operationId,pqvd_name:'Native campaign replay intent',pqvd_runid:{id:capture.runId,logical_name:'pqvd_testrun'},pqvd_runnercontactid:{id:controller,logical_name:'contact'},pqvd_markerutc:marker,pqvd_markeroperation:'CO-OP:'+request.operationId,pqvd_roottable:table,pqvd_expectedmessage:'RetrieveMultiple',pqvd_lane:request.lane==='liquid'?183270000:183270001,pqvd_actorprovenance:'PortalRelationshipClaim'});
   result=await store.readOperation(()=>store.fetchXml(source,identity,{portalRequest:true,profile:request.lane==='webapi'?'webapi':'portal'}));
  }catch(cause){error={code:cause.code??'NativeReplayUnsupported',platformCode:cause.details?.innerCode??null,message:cause.message,status:cause.status};}
  captures=recordedPluginPayloads(store.state.tables.pqvd_pluginevent.slice(originalEvents.length));
  const expectedRows=expected.find(event=>event.context.Stage===40)?.context.output?.BusinessEntityCollection;
  const actualRows=captures.find(event=>event.context.Stage===40)?.context.output?.BusinessEntityCollection;
  const contexts=expected.map(event=>{const counterpart=captures.find(local=>local.artifact===event.artifact);return{artifact:event.artifact,...(counterpart?compareRecordedContexts(event.context,counterpart.context):{stableEqual:false,missing:true}),artifactMetadata:counterpart?compareRecordedPluginArtifacts(event,counterpart):{stableEqual:false,missing:true}};});
  const queryExact=expected.length>0&&captures.length===expected.length&&captures.every(local=>local.content?.query?.xml===expected.find(event=>event.artifact===local.artifact)?.content?.query?.xml);
  const rowExact=expectedRows!==undefined&&JSON.stringify(canonical(expectedRows))===JSON.stringify(canonical(actualRows));
  const entry={caseId:request.caseId,variant:request.variant,lane:request.lane,operationId:request.operationId,localCount:result?.entities.length,error,queryExact,rowExact,contexts,capturedEvents:captures.length,nativeEvents:expected.length,backendAbsenceExact:expected.length===0&&captures.length===0,nativeHttpStatus:http?.status,nativeLiquidOutcome:liquidPage?.outcome,qualified:queryExact&&rowExact&&contexts.every(context=>context.stableEqual&&context.artifactMetadata.stableEqual),captures};
  pages.push(entry);await progress({...entry,captures:undefined});
 }}finally{store.state.tables.pqvd_testoperation=originalOperations;store.state.tables.pqvd_pluginevent=originalEvents;}
 const witness=validateNativeReadWitness(sourceWitness,binding.receipt,store.nativeReadSnapshot);
 return {durationMs:Date.now()-started,pages,physicalReads:pages.length,qualifiedReads:pages.filter(page=>page.qualified).length,qualificationScope:'Original CLR query/result/context artifacts; frozen source witness checked separately',sourceWitness:witness,allQualified:witness.verified&&pages.every(page=>page.qualified)};
}
