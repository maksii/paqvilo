import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DataStore} from 'paqvilo/mirage/lib/data.mjs';
import {recordToSdkEntity} from 'paqvilo/mirage/lib/plugin-clr.mjs';
import {applyNativeDataSnapshot,compareRecordedContexts,contextFromNativeCapture,recordedPluginPayloads,validateNativeReadWitness,nativeRegistrationFingerprint,compareRecordedPluginArtifacts,prepareNativeReplayPlugins} from '../mirage-runtime.mjs';

const id='10000000-0000-0000-0000-000000000001';
async function sourceFixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-native-source-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5}));
 const exportRoot=path.join(root,'exports'),sdkRoot=path.join(root,'sdk'),sdkAssembly=path.join(sdkRoot,'Sdk.dll'),cacheRoot=path.join(root,'cache');
 await fs.mkdir(exportRoot);await fs.mkdir(sdkRoot);await fs.writeFile(sdkAssembly,'invented SDK bytes');
 return {root,exportRoot,sdkRoot,sdkAssembly,cacheRoot,options:{exportRoot,sdkAssembly,cacheRoot,context:{initiatingUserId:id,organizationId:id,businessUnitId:id},serviceProfiles:[{userId:id,evidence:'Invented source fixture',grants:[{entity:'widget',operations:['read']}]}]}};
}

test('Native replay receipts use a bounded opened source handle and reject pathname replacement',async t=>{
 const fixture=await sourceFixture(t),originalOpen=fs.open;
 const replacement=path.join(fixture.root,'replacement.dll');await fs.writeFile(replacement,'replacement SDK');
 const receipt=await prepareNativeReplayPlugins(fixture.options);
 assert.equal(receipt.receipt.sdkSha256,createHash('sha256').update('invented SDK bytes').digest('hex'));
 let opened;
 fs.open=async function(file,...args){const handle=await originalOpen(file,...args);if(file===fixture.sdkAssembly){opened=handle;await fs.rename(file,file+'.retained');await fs.rename(replacement,file);}return handle;};
 try{await assert.rejects(prepareNativeReplayPlugins(fixture.options),/regular DLL/);assert.equal(opened.fd,-1);}finally{fs.open=originalOpen;}
});

test('Native replay rejects source replacement during reading and closes its original handle',async t=>{
 const fixture=await sourceFixture(t),originalOpen=fs.open;let opened;
 const replacement=path.join(fixture.root,'replacement.dll');await fs.writeFile(replacement,'replacement SDK');
 fs.open=async function(file,...args){const handle=await originalOpen(file,...args);if(file===fixture.sdkAssembly){opened=handle;const read=handle.read.bind(handle);let replaced=false;handle.read=async args=>{if(!replaced){replaced=true;await fs.rename(file,file+'.retained');await fs.rename(replacement,file);}return read(args);};}return handle;};
 try{await assert.rejects(prepareNativeReplayPlugins(fixture.options),/changed during preparation/);assert.equal(opened.fd,-1);}finally{fs.open=originalOpen;}
});

test('Native replay refuses sources growing past the 32 MiB limit on the opened handle',async t=>{
 const fixture=await sourceFixture(t),originalOpen=fs.open;let opened,total=0;
 const growing=await originalOpen(fixture.sdkAssembly,'r+');
 fs.open=async function(file,...args){const handle=await originalOpen(file,...args);if(file===fixture.sdkAssembly){opened=handle;const read=handle.read.bind(handle);let grew=false;handle.read=async args=>{if(!grew){grew=true;await growing.truncate(32*1024*1024+100);}const answer=await read(args);total+=answer.bytesRead;return answer;};}return handle;};
 try{await assert.rejects(prepareNativeReplayPlugins(fixture.options),/regular DLL/);assert.equal(total,32*1024*1024+1);assert.equal(opened.fd,-1);}finally{fs.open=originalOpen;await growing.close();}
});

test('Native replay rejects SDK directory links introduced between validation and opening',async t=>{
 const fixture=await sourceFixture(t),originalOpen=fs.open,originalRealpath=fs.realpath;let opened,replaced=false;
 fs.realpath=async function(directory,...args){const actual=await originalRealpath(directory,...args);if(directory===fixture.sdkRoot&&!replaced){replaced=true;await fs.rename(fixture.sdkRoot,fixture.sdkRoot+'.retained');await fs.symlink(fixture.sdkRoot+'.retained',fixture.sdkRoot,process.platform==='win32'?'junction':'dir');}return actual;};
 fs.open=async function(file,...args){const handle=await originalOpen(file,...args);if(file===path.join(fixture.sdkRoot+'.retained','Sdk.dll'))opened=handle;return handle;};
 try{await assert.rejects(prepareNativeReplayPlugins(fixture.options),/symlink|directory changed/);assert.equal(replaced,true);assert.equal(opened.fd,-1);}finally{fs.open=originalOpen;fs.realpath=originalRealpath;}
});

test('Native replay copies the exact assembly bytes that matched the receipt without reopening the export',async t=>{
 const fixture=await sourceFixture(t),directory=path.join(fixture.exportRoot,'PluginAssemblies');await fs.mkdir(directory);
 const assembly=path.join(directory,'Original.dll'),originalBytes=Buffer.from('invented original DLL');await fs.writeFile(assembly,originalBytes);
 const replacement=path.join(fixture.root,'replacement.dll');await fs.writeFile(replacement,'unverified replacement DLL');
 const typeId='20000000-0000-0000-0000-000000000001',stepId='30000000-0000-0000-0000-000000000001';
 await fs.writeFile(path.join(directory,'Original.xml'),`<ImportExportXml><PluginAssembly PluginAssemblyId="${id}" Name="Invented.Original"><FileName>/PluginAssemblies/Original.dll</FileName><PluginType PluginTypeId="${typeId}" TypeName="Invented.Original"/></PluginAssembly><SdkMessageProcessingStep SdkMessageProcessingStepId="${stepId}"><PluginTypeId>${typeId}</PluginTypeId><MessageName>Create</MessageName><PrimaryEntity>widget</PrimaryEntity><Stage>20</Stage><Rank>1</Rank><Mode>0</Mode></SdkMessageProcessingStep></ImportExportXml>`);
 const originalMkdir=fs.mkdir;let replacements=0;
 fs.mkdir=async function(directory,...args){if(directory===fixture.cacheRoot){await fs.rename(assembly,assembly+'.retained');await fs.rename(replacement,assembly);replacements++;}return originalMkdir(directory,...args);};
 try{
  await assert.rejects(prepareNativeReplayPlugins({...fixture.options,expectedAssemblyHashes:{'Invented.Original':createHash('sha256').update(originalBytes).digest('hex')}}),error=>['LocalPluginClrBuild','LocalPluginClrUnavailable'].includes(error.code));
  assert.equal(replacements,1);assert.deepEqual(await fs.readFile(path.join(fixture.cacheRoot,'trusted-originals','Original.dll')),originalBytes);
 }finally{fs.mkdir=originalMkdir;}
});

test('Native snapshot defaults, exact lookup targets and independent SDK RowVersion survive a selected projection',()=>{
 const store=new DataStore({state:{mappings:{item:{entitySet:'items',idColumn:'itemid',fields:{principal:{type:'lookup',targets:['contact']}}}},tables:{item:[]},relationships:{},permissions:[],plugins:[],settings:{permissionMode:'enforce'}}});
 applyNativeDataSnapshot(store,{tables:{item:[{itemid:id,title:'Native default',_principal_value:id,statecode:0}]},projections:{},dataSnapshotHash:'proof'},{rowVersions:{item:{[id]:'123456789'}}});
 assert.deepEqual(store.state.tables.item[0].principal,{id,logical_name:'contact'});assert.equal(store.state.tables.item[0].statecode,0);
 const sdk=recordToSdkEntity(store,'item',{itemid:id,title:'Native default'},{columns:['title']});
 assert.equal(sdk.rowVersion,'123456789');assert.deepEqual(sdk.attributes,{title:'Native default'});
});

test('Malformed projection snapshots do not partially replace local data',()=>{
 const store=new DataStore({state:{mappings:{item:{entitySet:'items',idColumn:'itemid'}},tables:{item:[{itemid:id,title:'Original'}]},relationships:{},settings:{permissionMode:'permissive'}}});const before=store.snapshot();
 assert.throws(()=>applyNativeDataSnapshot(store,{tables:{item:[{itemid:id,title:'Changed'}]},projections:{unknown:[]}}),/exact imported relationship/);
 assert.deepEqual(store.snapshot(),before);
});
test('Frozen lookup target annotations preserve source provenance and reject metadata conflicts atomically',()=>{
 const store=new DataStore({state:{mappings:{item:{entitySet:'items',idColumn:'itemid',fields:{principal:{type:'lookup',targets:['contact']}}}},tables:{item:[]},relationships:{},settings:{permissionMode:'permissive'}}});
 applyNativeDataSnapshot(store,{tables:{item:[{itemid:id,_createdby_value:id,'_createdby_value@Microsoft.Dynamics.CRM.lookuplogicalname':'systemuser'}]},projections:{}});
 assert.deepEqual(store.state.tables.item[0].createdby,{id,logical_name:'systemuser'});const before=store.snapshot();
 assert.throws(()=>applyNativeDataSnapshot(store,{tables:{item:[{itemid:id,_principal_value:id,'_principal_value@Microsoft.Dynamics.CRM.lookuplogicalname':'account'}]},projections:{}}),/conflicts/);assert.deepEqual(store.snapshot(),before);
});

test('Context comparison preserves volatile differences explicitly and ignores object key order',()=>{
 const native={MessageName:'RetrieveMultiple',input:{Query:{type:'FetchExpression',xml:'<fetch />'},AppModuleId:{type:'Guid',value:id}},RequestId:id};
 const local={...native,input:{AppModuleId:{value:id,type:'Guid'},Query:{xml:'<fetch />',type:'FetchExpression'}},RequestId:'10000000-0000-0000-0000-000000000002'};
 const comparison=compareRecordedContexts(native,local);assert.equal(comparison.stableEqual,true);assert.equal(comparison.fullSnapshotEqual,false);assert.ok(comparison.generatedFields.includes('RequestId'));
 local.input.Query.xml='<fetch distinct="true" />';assert.deepEqual(compareRecordedContexts(native,local).differences.map(change=>change.field),['input']);
});
test('Generated context values still require matching presence and runtime type',()=>{
 const native={RequestId:id,OperationCreatedOn:'/Date(123)/',parents:[{CorrelationId:id,OperationId:id,OperationCreatedOn:'/Date(123)/'}]};
 const local={RequestId:'10000000-0000-0000-0000-000000000002',OperationCreatedOn:'/Date(456)/',parents:[{CorrelationId:'10000000-0000-0000-0000-000000000002',OperationId:id,OperationCreatedOn:'/Date(456)/'}]};
 assert.equal(compareRecordedContexts(native,local).stableEqual,true);
 for(const mutate of [x=>delete x.RequestId,x=>x.RequestId='invalid',x=>x.OperationCreatedOn=456,x=>x.parents[0].CorrelationId=null]){const changed=structuredClone(local);mutate(changed);assert.equal(compareRecordedContexts(native,changed).stableEqual,false);}
});

test('Only a well-shaped generated span value is excluded from shared-variable comparison',()=>{
 const native={schemaVersion:1,sharedVariables:{'pqvd.lab.operation':{type:'String',value:id,truncated:false},'pqvd.lab.span':{type:'String',value:id,truncated:false},custom:{type:'String',value:'same',truncated:false}}};
 const local=structuredClone(native);local.sharedVariables['pqvd.lab.span'].value='10000000-0000-0000-0000-000000000002';assert.equal(compareRecordedContexts(native,local).stableEqual,true);
 for(const mutate of [x=>x.sharedVariables.custom.value='changed',x=>x.sharedVariables['pqvd.lab.operation'].value='changed',x=>x.sharedVariables['pqvd.lab.span'].type='Guid',x=>x.schemaVersion=2]){const changed=structuredClone(local);mutate(changed);assert.equal(compareRecordedContexts(native,changed).stableEqual,false);}
});

test('Source Context7 profiles preserve only safe observed portal inputs and user-agent presence',()=>{
 const capture={interfaceVersion:7,UserId:id,InitiatingUserId:id,OrganizationId:id,BusinessUnitId:id,SecondaryEntityName:'none',organizationName:{value:'observed'},input:{AppModuleId:{type:'Guid',value:id},IsAppModuleContext:{type:'Boolean',value:false},Query:{type:'FetchExpression',xml:'private query'}},extensions:{context5:{values:{initiatingUserAgentPresent:true}},context6:{observed:true,values:{environmentId:{value:'observed-environment'},tenantId:{value:id}}},context7:{observed:true,values:{IsApplicationUser:true}}}};
 const context=contextFromNativeCapture(capture);assert.equal(context.secondaryEntityName,'none');assert.deepEqual(context.portalInputParameters,{AppModuleId:{$type:'Guid',value:id},IsAppModuleContext:false});assert.equal(context.initiatingUserAgentPresent,true);assert.ok(!JSON.stringify(context).includes('private query'));
});
test('Native event replay rejects missing, reordered-number and modified payload parts',()=>{
 const content=JSON.stringify({artifact:'Incoming query',text:'Unicode \ud83d\ude00'}),checksum=createHash('sha256').update(content).digest('hex');
 const split=content.indexOf('Unicode'),parts=[content.slice(0,split),content.slice(split)].map((pqvd_payloadtext,index)=>({pqvd_eventkey:'test-event',pqvd_partnumber:index+1,pqvd_partcount:2,pqvd_payloadhash:checksum,pqvd_payloadtext}));
 assert.deepEqual(recordedPluginPayloads([...parts].reverse()),[JSON.parse(content)]);
 assert.throws(()=>recordedPluginPayloads(parts.slice(1)),/incomplete/);
 assert.throws(()=>recordedPluginPayloads(parts.map(part=>({...part,pqvd_partnumber:1}))),/inconsistent/);
 assert.throws(()=>recordedPluginPayloads(parts.map((part,index)=>({...part,pqvd_payloadtext:part.pqvd_payloadtext+(index?'tamper':'')}))),/checksum/);
});
test('Complete read qualification requires frozen data, versions, permission graph, memberships and registration',()=>{
 const fields=['permissionSnapshotHash','membershipSnapshotHash','dataSnapshotHash','rowVersionSnapshotHash'],before={...Object.fromEntries(fields.map(field=>[field,'a'.repeat(64)])),complete:true},witness={before,after:{...before},registrationSha256:'b'.repeat(64)},receipt={registrationSha256:'b'.repeat(64)};
 assert.equal(validateNativeReadWitness(witness,receipt,before).verified,true);
 for(const field of fields){const changed=structuredClone(witness);changed.after[field]='c'.repeat(64);assert.deepEqual(validateNativeReadWitness(changed,receipt,before).reasons,[field]);}
 assert.equal(validateNativeReadWitness(undefined,receipt,before).verified,false);assert.deepEqual(validateNativeReadWitness(witness,{registrationSha256:'c'.repeat(64)},before).reasons,['registrationSha256']);
 assert.equal(validateNativeReadWitness(witness,receipt).verified,false);
 assert.deepEqual(validateNativeReadWitness({...witness,after:{...before,complete:false}},receipt,before).reasons,['sourceCompleteness']);
});
test('Registration witness ignores discovery clocks and OData annotations but retains actual configuration and step state',()=>{
 const native={schemaVersion:1,capturedAt:'old',applicationUserId:id,steps:[{sdkmessageprocessingstepid:id,statecode:0,configuration:'fixture','@odata.etag':'W/123'}],filters:[],messages:[],images:[]};const changed=structuredClone(native);changed.capturedAt='new';changed.steps[0]['@odata.etag']='W/456';assert.equal(nativeRegistrationFingerprint(native),nativeRegistrationFingerprint(changed));
 for(const mutate of [x=>x.steps[0].statecode=1,x=>x.steps[0].configuration='changed',x=>x.steps[0].rank=99]){const changed=structuredClone(native);mutate(changed);assert.notEqual(nativeRegistrationFingerprint(native),nativeRegistrationFingerprint(changed));}
});
test('Original plugin artifact qualification binds actual assembly identity, content and durable mode',()=>{
 const native={schemaVersion:1,assemblyIdentity:{name:'Invented',version:'1.0.0.0',moduleVersionId:id},operationId:id,artifact:'Query',content:{physicalQueryHash:'hash',query:{xml:'<fetch />'},actorBinding:'Native'},durability:'Transactional',captureTime:'2026-10-13T13:49:04.9764884Z',spanId:id,parentSpanId:null};const local={...structuredClone(native),captureTime:'2026-10-13T14:19:37.2730431Z',spanId:'10000000-0000-0000-0000-000000000002'};
 assert.equal(compareRecordedPluginArtifacts(native,local).stableEqual,true);
 for(const mutate of [x=>x.assemblyIdentity.moduleVersionId='10000000-0000-0000-0000-000000000002',x=>x.content.actorBinding='Changed',x=>x.durability='Changed',x=>x.spanId=null]){const changed=structuredClone(local);mutate(changed);assert.equal(compareRecordedPluginArtifacts(native,changed).stableEqual,false);}
});
