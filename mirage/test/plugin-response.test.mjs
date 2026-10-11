import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {captureSdkResponse,handoffPluginResponse} from '../lib/plugin-response.mjs';
import {DataStore} from '../lib/data.mjs';
import {dispatchSdkCall,prepareClrRuntime} from '../lib/plugin-clr.mjs';
import {pluginCatalogue,runPluginPhase} from '../lib/exported-plugins.mjs';
const user='10000000-0000-0000-0000-000000000001',id='20000000-0000-0000-0000-000000000001',changed='20000000-0000-0000-0000-000000000002',nestedId='20000000-0000-0000-0000-000000000003';
const frame=values=>({outputParameters:{$type:'ParameterCollection',values}}),typed=(type,value)=>({$type:type,value});
const profile={userId:user,evidence:'Invented original response caller source',grants:['secondary','bulkitem','audit'].map(entity=>({entity,operations:['read','create','update','delete']})),bulkTables:[{entity:'bulkitem',tableType:'standard',evidence:'Invented explicit standard bulk capability',messages:['CreateMultiple','UpdateMultiple']}]};
const data=()=>new DataStore({state:{version:1,mappings:Object.fromEntries(['widget','secondary','bulkitem','audit'].map(entity=>[entity,{entitySet:entity+'s',idColumn:entity+'id'}])),tables:{widget:[],secondary:[{secondaryid:id,title:'Read stored'}],bulkitem:[],audit:[]},permissions:[],plugins:[],settings:{permissionMode:'enforce'}}});

test('Response capture isolates exact nested invocation, store and entity, and snapshots final values',()=>{
 const store={},other={};let source;
 const result=captureSdkResponse(store,'create','widget',token=>{
  handoffPluginResponse(store,'update','widget',frame({wrong:'message'}),token);handoffPluginResponse(store,'create','other',frame({wrong:'entity'}),token);handoffPluginResponse(other,'create','widget',frame({wrong:'store'}),token);
  const inner=captureSdkResponse(store,'create','widget',innerToken=>{handoffPluginResponse(store,'create','widget',frame({id:'inner'}),innerToken);handoffPluginResponse(store,'create','widget',frame({id:'wrong outer token'}),token);return 'inner value';});assert.equal(inner.results.id,'inner');
  source=frame({custom:typed('Money','12.5')});handoffPluginResponse(store,'create','widget',source,token);source.outputParameters.values.custom.value='999';handoffPluginResponse(store,'create','widget',frame({id:'Bare nested operation'}));return 'outer value';
 });
 assert.deepEqual(result,{value:'outer value',results:{custom:typed('Money','12.5')}});
 assert.equal(captureSdkResponse(store,'create','widget',()=>1).results,undefined);
});

test('Failed and later asynchronous handoffs cannot contaminate another caller',async()=>{
 const store={};assert.throws(()=>captureSdkResponse(store,'create','widget',token=>{handoffPluginResponse(store,'create','widget',frame({id:'failed'}),token);throw Error('Failure');}),/Failure/);
 let queued;captureSdkResponse(store,'create','widget',token=>{queued=Promise.resolve().then(()=>handoffPluginResponse(store,'create','widget',frame({id:'late'}),token));});await queued;
 assert.equal(captureSdkResponse(store,'create','widget',()=>2).results,undefined);
});

test('Without plugins SDK defaults, DataStore rows and backend bulk result shapes remain unchanged',async()=>{
 const store=data(),invoke=(method,args)=>dispatchSdkCall({store,profile,message:{method,userId:user,arguments:args}}),entity={$type:'Entity',logicalName:'secondary',id:changed,attributes:{title:'Ordinary'}};
 assert.deepEqual(invoke('Create',[entity]),typed('Guid',changed));
 const request=(requestName,values)=>({$type:'OrganizationRequest',requestName,parameters:{$type:'ParameterCollection',values}});
 const retrieved=invoke('Execute',[request('Retrieve',{Target:{$type:'EntityReference',logicalName:'secondary',id},ColumnSet:{$type:'ColumnSet',columns:['title']}})]);assert.equal(retrieved.results.Entity.attributes.title,'Read stored');assert.deepEqual(Object.keys(retrieved.results),['Entity']);
 const row=await store.create('widget',{title:'Public row'},{admin:true});assert.ok(row.widgetid);assert.equal(row.title,'Public row');assert.ok(!Object.hasOwn(row,'results'));
 const bulk=invoke('Execute',[request('CreateMultiple',{Targets:{$type:'EntityCollection',entities:[{$type:'Entity',logicalName:'bulkitem',id:'00000000-0000-0000-0000-000000000000',attributes:{title:'Bulk'}}]}})]);assert.equal(bulk.results.Ids.$type,'GuidArray');assert.equal(bulk.results.Ids.values.length,1);
});

test('A bare same-table nested project operation cannot replace the SDK caller response',()=>{
 const store=data();store.setPluginPipeline(context=>{
  if(context.operation!=='create')return {};
  if(context.stage===20&&context.target.title==='Outer')store.createRecord('secondary',{title:'Bare child'},{admin:true});
  if(context.stage===40&&context.target.title==='Bare child')return frame({id:typed('Guid',changed),custom:'Only child'});
  return {};
 });
 const result=dispatchSdkCall({store,profile,message:{method:'Create',userId:user,arguments:[{$type:'Entity',logicalName:'secondary',id:'00000000-0000-0000-0000-000000000000',attributes:{title:'Outer'}}]}});
 const rows=store.snapshot().tables.secondary;assert.equal(result.value,rows.find(row=>row.title==='Outer').secondaryid);assert.notEqual(result.value,changed);assert.ok(rows.some(row=>row.title==='Bare child'));
});

test('Cascaded same-table child Delete outputs do not become root SDK Delete Results',()=>{
 const store=data();store.state.mappings.secondary.relationships={children:{entity:'secondary',many:true,from:'secondaryid',to:'parentid',cascade:{delete:'Cascade'}}};store.state.tables.secondary.push({secondaryid:changed,title:'Child',parentid:id});
 store.setPluginPipeline(context=>context.operation==='delete'&&context.stage===40&&context.record.secondaryid===changed?frame({custom:'Child output'}):{});
 const result=dispatchSdkCall({store,profile,message:{method:'Execute',userId:user,arguments:[{$type:'OrganizationRequest',requestName:'Delete',parameters:{$type:'ParameterCollection',values:{Target:{$type:'EntityReference',logicalName:'secondary',id}}}}]}});
 assert.deepEqual(result.results,{});assert.deepEqual(store.snapshot().tables.secondary,[]);
});

test('Original DLL SDK callers receive post-operation Results, deletions, typed custom values and isolated nested/failing responses',{skip:process.platform!=='win32'||!process.env.PAQ_TEST_XRM_SDK},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-original-response-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5}));
 const sdk=path.resolve(process.env.PAQ_TEST_XRM_SDK),source=path.join(root,'ResponseOriginal.cs'),assembly=path.join(root,'ResponseOriginal.dll');
 await fs.writeFile(source,`using System;using System.ServiceModel;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;using Microsoft.Xrm.Sdk.Query;
namespace Invented {
public sealed class Caller:IPlugin {static Entity Row(string table,string mode){var row=new Entity(table);row["title"]=mode;return row;}static void Custom(OrganizationResponse r){if(((Money)r.Results["money"]).Value!=12.5m||(decimal)r.Results["decimal"]!=123.456789m||(long)r.Results["long"]!=9007199254740993L||((OptionSetValueCollection)r.Results["choices"])[1].Value!=4||r.Results["null"]!=null)throw new Exception("Custom result types lost");}
public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];var mode=target.GetAttributeValue<string>("title");var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
if(mode=="replace"||mode=="parent-failure"){if(s.Create(Row("secondary","replace"))!=new Guid("${changed}"))throw new Exception("Direct Create output ignored");var r=(CreateResponse)s.Execute(new CreateRequest{Target=Row("secondary","replace")});if(r.id!=new Guid("${changed}")||(string)r.Results["BusinessEntity"]!="Ordinary custom key")throw new Exception("Named Create output ignored");Custom(r);if(mode=="parent-failure")throw new InvalidPluginExecutionException("Parent failed after returned response");}
else if(mode=="deleted"){var expected=new CreateResponse().id;if(s.Create(Row("secondary","delete"))!=expected)throw new Exception("Deleted direct id differs from installed SDK getter default");var r=(CreateResponse)s.Execute(new CreateRequest{Target=Row("secondary","delete")});if(r.Results.Contains("id")||r.id!=expected)throw new Exception("Deleted named id was reseeded");Custom(r);}
else if(mode=="mistyped"){var sample=new CreateResponse();sample.Results["id"]="mistyped";Type expected=null;try{var ignored=sample.id;}catch(Exception e){expected=e.GetType();}if(expected==null)throw new Exception("Installed SDK getter unexpectedly accepted wrong type");var r=(CreateResponse)s.Execute(new CreateRequest{Target=Row("secondary","mistyped")});try{var ignored=r.id;throw new Exception("Wrong response type accepted");}catch(InvalidCastException e){if(e.GetType()!=expected)throw;}if((string)r.Results["id"]!="mistyped")throw new Exception("Raw mistyped result was lost");Custom(r);}
else if(mode=="nested"){var r=(CreateResponse)s.Execute(new CreateRequest{Target=Row("secondary","nested")});if(r.id!=new Guid("${changed}"))throw new Exception("Nested response replaced outer response");Custom(r);}
else if(mode=="child-failure"){bool failed=false;try{s.Create(Row("secondary","reject"));}catch(FaultException<OrganizationServiceFault>){failed=true;}if(!failed)throw new Exception("Child failure missing");var r=(CreateResponse)s.Execute(new CreateRequest{Target=Row("secondary","replace")});if(r.id!=new Guid("${changed}"))throw new Exception("Failed response polluted next invocation");Custom(r);}
else if(mode=="bulk"){var r=(CreateMultipleResponse)s.Execute(new CreateMultipleRequest{Targets=new EntityCollection(new[]{Row("bulkitem","Bulk first"),Row("bulkitem","Bulk second")})});if(r.Ids.Length!=2||r.Ids[0]!=new Guid("${changed}")||r.Ids[1]!=new Guid("${nestedId}"))throw new Exception("Bulk output ignored");Custom(r);}
else if(mode=="read"){var one=(RetrieveResponse)s.Execute(new RetrieveRequest{Target=new EntityReference("secondary",new Guid("${id}")),ColumnSet=new ColumnSet("title")});if(one.Entity.GetAttributeValue<string>("title")!="Handler changed"||((OptionSetValue)one.Results["last"]).Value!=7)throw new Exception("Mixed Retrieve result lost");Custom(one);var q=new QueryExpression("secondary"){ColumnSet=new ColumnSet("title")};var many=(RetrieveMultipleResponse)s.Execute(new RetrieveMultipleRequest{Query=q});if(many.EntityCollection.Entities[0].GetAttributeValue<string>("title")!="Handler changed"||((OptionSetValue)many.Results["last"]).Value!=7)throw new Exception("Mixed query result lost");Custom(many);}
else throw new Exception("Unknown invented scenario");target["status"]="passed:"+mode;((ITracingService)services.GetService(typeof(ITracingService))).Trace("Original caller passed {0}",mode);}}
public sealed class Results:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var output=c.OutputParameters;output["money"]=new Money(12.5m);output["decimal"]=123.456789m;output["long"]=9007199254740993L;output["choices"]=new OptionSetValueCollection{new OptionSetValue(2),new OptionSetValue(4)};output["null"]=null;
if(c.MessageName=="Create"){var mode=((Entity)c.InputParameters["Target"]).GetAttributeValue<string>("title");output["BusinessEntity"]="Ordinary custom key";if(mode=="delete")output.Remove("id");else if(mode=="mistyped")output["id"]="mistyped";else output["id"]=new Guid(c.PrimaryEntityName=="audit"?"${nestedId}":"${changed}");if(mode=="reject")throw new InvalidPluginExecutionException("Invented child failed");if(mode=="nested"){var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var audit=new Entity("audit");audit["title"]="Nested saved";if(s.Create(audit)!=new Guid("${nestedId}"))throw new Exception("Nested result ignored");}}
else if(c.MessageName=="CreateMultiple")output["Ids"]=new[]{new Guid("${changed}"),new Guid("${nestedId}")};
else{var e=c.MessageName=="Retrieve"?(Entity)output["BusinessEntity"]:((EntityCollection)output["BusinessEntityCollection"]).Entities[0];if(c.OwningExtension.Name=="Last observer"){if(e.GetAttributeValue<string>("title")!="Handler changed")throw new Exception("Ranked read became stale");output["last"]=new OptionSetValue(7);}else e["title"]="CLR changed";}}}
}`);
 const compiler=path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),build=spawnSync(compiler,['/nologo','/target:library','/out:'+assembly,'/reference:'+sdk,'/reference:System.ServiceModel.dll','/reference:System.Runtime.Serialization.dll',source],{shell:false,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(build.status,0,build.stdout+build.stderr);
 const descriptor=typeName=>({trust:'execute-local-assembly',root,assembly:path.basename(assembly),typeName:'Invented.'+typeName,sdkRoot:path.dirname(sdk),sdkAssembly:path.basename(sdk),cacheRoot:path.join(root,'cache'),serviceProfile:profile,context:{initiatingUserId:user,organizationId:'50000000-0000-0000-0000-000000000001',businessUnitId:'60000000-0000-0000-0000-000000000001'},timeoutMs:5000});
 const caller=await prepareClrRuntime(descriptor('Caller')),responder=await prepareClrRuntime(descriptor('Results')),steps=[],runtimes=new Map(),handlers=new Map();let sequence=200;
 const step=(entity,message,stage,rank,typeName,name)=>{const row={id:'30000000-0000-0000-0000-'+String(++sequence).padStart(12,'0'),enabled:true,assemblyId:'invented-response',entity,message,stage,rank,typeName:'Invented.'+typeName,name,mode:0,supportedDeployment:0,filteringAttributes:[],images:[]};steps.push(row);runtimes.set(row.id,typeName==='Caller'?caller:responder);return row;};
 step('widget','Create',20,1,'Caller','Caller');for(const entity of ['secondary','audit'])step(entity,'Create',40,1,'Results','Result writer');step('bulkitem','CreateMultiple',40,1,'Results','Bulk writer');
 for(const message of ['Retrieve','RetrieveMultiple']){step('secondary',message,40,1,'Results','First observer');const middle=step('secondary',message,40,2,'Results','Project handler');runtimes.delete(middle.id);handlers.set(middle.id,context=>{if(message==='Retrieve'){context.entityResult.attributes.title='Handler changed';return {entityResult:context.entityResult};}context.collection.entities[0].attributes.title='Handler changed';return {collection:context.collection};});step('secondary',message,40,3,'Results','Last observer');}
 const items=pluginCatalogue({plugins:{steps},runtimes,handlers,overrides:Object.fromEntries(steps.filter(row=>runtimes.has(row.id)).map(row=>['plugin-step:'+row.id,{mode:'clr'}]))}),notes=[];
 const stores=[];for(const mode of ['replace','deleted','mistyped','nested','child-failure','bulk','read','parent-failure']){
  const store=data();stores.push(store);store.setPluginPipeline(context=>runPluginPhase({...context,store,items,runtimes,handlers,diagnostic:note=>notes.push(note)}),context=>items.some(item=>item.entity===context.entity&&item.message.toLowerCase()===context.operation));const before=store.snapshot();
  if(mode==='parent-failure'){await assert.rejects(store.create('widget',{title:mode},{admin:true}),/Parent failed/);assert.deepEqual(store.snapshot(),before);continue;}
  let row;try{row=await store.create('widget',{title:mode},{admin:true});}catch(error){error.message='Scenario '+mode+': '+error.message;throw error;}assert.equal(row.status,'passed:'+mode);assert.ok(row.widgetid);assert.ok(!Object.hasOwn(row,'results'));
  assert.ok(!store.snapshot().tables.secondary.some(record=>record.secondaryid===changed));if(mode==='nested')assert.equal(store.snapshot().tables.audit.length,1);if(mode==='child-failure')assert.ok(!store.snapshot().tables.secondary.some(record=>record.title==='reject'));if(mode==='bulk'){assert.equal(store.snapshot().tables.bulkitem.length,2);assert.ok(!store.snapshot().tables.bulkitem.some(record=>[changed,nestedId].includes(record.bulkitemid)));}if(mode==='read')assert.equal(store.snapshot().tables.secondary[0].title,'Read stored');
 }
 const hosts=notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STOPPED');assert.ok(hosts.length>=20);assert.ok(hosts.every(note=>note.absenceVerified));
 if(process.env.PAQ_TEST_CLR_EVIDENCE){const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');await fs.writeFile(path.resolve(process.env.PAQ_TEST_CLR_EVIDENCE)+'.caller-response.json',JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),scope:'Actual compiled invented original DLL callers; no native organization execution',sourceSha256:await hash(source),assemblySha256:await hash(assembly),sdkSha256:await hash(sdk),ownedHosts:{started:notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STARTED').length,stopped:hosts.length,allAbsenceVerified:hosts.every(note=>note.absenceVerified)},scenarios:['Create direct and named replaced id','Create deleted id installed SDK getter default','Mistyped named id installed SDK getter exception','Typed custom response keys','Nested SDK response isolation','Failed child isolation','CreateMultiple replaced Ids','Mixed ranked read caller results','Parent rollback after returned response'],nativeQualified:false},null,2)+'\n',{flag:'wx'});}
});
