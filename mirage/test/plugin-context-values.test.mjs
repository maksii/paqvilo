import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DataStore} from '../lib/data.mjs';
import {clrContext,recordToSdkEntity,prepareClrRuntime} from '../lib/plugin-clr.mjs';
import {pluginCatalogue,runPluginPhase} from '../lib/exported-plugins.mjs';
import {localOrganizationService} from '../lib/local-organization-service.mjs';
const user='10000000-0000-0000-0000-000000000001',id='20000000-0000-0000-0000-000000000001',replacement='20000000-0000-0000-0000-000000000002';
const choiceField={type:'multiselectpicklist',options:[{value:1,label:'First'},{value:2,label:'Second'},{value:3,label:'Third'}]};
const profile={userId:user,evidence:'Invented SDK context and choices contract',grants:[{entity:'widget',operations:['read']},{entity:'secondary',operations:['read','update']}]};
const data=()=>new DataStore({state:{version:1,mappings:{widget:{entitySet:'widgets',idColumn:'widgetid',fields:{options:choiceField}},secondary:{entitySet:'secondaries',idColumn:'secondaryid',fields:{options:choiceField}}},tables:{widget:[],secondary:[{secondaryid:id,options:'1, 2'}]},permissions:[],plugins:[],settings:{permissionMode:'enforce'}}});
const typed=(type,value)=>({$type:type,value});
const evidence=async(suffix,{source,assembly,sdk,hosts,assertions})=>{if(!process.env.PAQ_TEST_CLR_EVIDENCE)return;const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex'),file=path.resolve(process.env.PAQ_TEST_CLR_EVIDENCE)+suffix;await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),scope:'Actual compiled invented original DLL; no native organization execution',originalSourceSha256:await hash(source),originalAssemblySha256:await hash(assembly),sdkAssemblySha256:await hash(sdk),ownedHosts:{stopped:hosts.length,allAbsenceVerified:hosts.every(note=>note.absenceVerified)},assertions,nativeQualified:false},null,2)+'\n',{flag:'wx'});};
const base=(store,operation,frame={})=>({runtime:{descriptor:{context:{initiatingUserId:user,organizationId:user,businessUnitId:user},serviceProfile:profile}},store,step:{id:'30000000-0000-0000-0000-000000000001',images:[]},entity:'widget',operation,target:{title:'Ordinary'},record:{widgetid:id,bulkIds:[id,replacement]},previous:null,frame,depth:1});

test('System Create output begins at PostOperation and later-ranked output replacements survive',()=>{
 const args=base(data(),'create');
 for(const stage of [10,20])assert.deepEqual(clrContext({...args,stage}).outputParameters.values,{});
 args.frame.outputParameters.values={probe:typed('OptionSetValue',2),id:typed('Guid',replacement)};
 const post=clrContext({...args,stage:40});assert.deepEqual(post.outputParameters.values,{probe:typed('OptionSetValue',2),id:typed('Guid',id)});
 args.frame.outputParameters={...post.outputParameters,values:{...post.outputParameters.values,id:typed('Guid',replacement)}};
 assert.equal(clrContext({...args,stage:40}).outputParameters.values.id.value,replacement);
 delete args.frame.outputParameters.values.id;assert.ok(!Object.hasOwn(clrContext({...args,stage:40}).outputParameters.values,'id'));
});

for(const operation of ['retrieve','retrievemultiple','createmultiple','updatemultiple'])test(operation+' retains custom outputs and first main-operation results across ranks',()=>{
 const store=data(),frame={entity:recordToSdkEntity(store,'widget',{widgetid:id}),collection:{$type:'EntityCollection',entities:[]},targets:[],records:[],previousRecords:[]},args=base(store,operation,frame);
 assert.deepEqual(clrContext({...args,stage:20}).outputParameters.values,{});
 frame.outputParameters.values.probe=typed('Int64','9007199254740993');
 const first=clrContext({...args,stage:40}).outputParameters.values;
 assert.deepEqual(first.probe,typed('Int64','9007199254740993'));
 const systemKey={retrieve:'BusinessEntity',retrievemultiple:'BusinessEntityCollection',createmultiple:'Ids'}[operation];
 if(systemKey){assert.ok(Object.hasOwn(first,systemKey));const changed=structuredClone(first[systemKey]);changed.changedByPostPlugin=true;frame.outputParameters.values[systemKey]=changed;if(operation==='retrieve')frame.entity=changed;if(operation==='retrievemultiple')frame.collection=changed;assert.equal(clrContext({...args,stage:40}).outputParameters.values[systemKey].changedByPostPlugin,true);}
 frame.outputParameters.values.later='retained';assert.equal(clrContext({...args,stage:40}).outputParameters.values.later,'retained');
});

test('Source choices retain SDK collection typing in stored arrays, comma strings, projections and nulls',()=>{
 const store=data(),convert=value=>recordToSdkEntity(store,'widget',{widgetid:id,options:value}).attributes.options;
 const expected={$type:'OptionSetValueCollection',values:[typed('OptionSetValue',1),typed('OptionSetValue',2)]};
 assert.deepEqual(convert([1,2]),expected);assert.deepEqual(convert('1, 2'),expected);assert.deepEqual(convert([{value:1},'2']),expected);
 assert.deepEqual(convert([]),{$type:'OptionSetValueCollection',values:[]});assert.deepEqual(convert(''),{$type:'OptionSetValueCollection',values:[]});assert.equal(convert(null),null);
 assert.deepEqual(recordToSdkEntity(store,'widget',{widgetid:id,options:[1,2]},{allColumns:false,columns:['widgetid']}).attributes,{widgetid:typed('Guid',id)});
 assert.deepEqual(recordToSdkEntity(store,'widget',{widgetid:id,untyped:[1,2]}).attributes.untyped,[1,2]);
 for(const invalid of [[true],[1.2],[2147483648],['invalid'],{unexpected:1}])assert.throws(()=>convert(invalid),/SDK choices require/);
});

test('Backend choices writes require exact source type, Int32 values and declared options before mutation',()=>{
 const store=data(),service=localOrganizationService(store,profile),before=store.snapshot();
 for(const value of [[true],[2147483648],[1.5],['1'],[4],[{value:1}]])assert.throws(()=>service.update('secondary',id,{options:value}),/source-valid Int32/);
 assert.throws(()=>service.update('secondary',id,{untyped:[1,2]}),/Backend deep writes/);assert.deepEqual(store.snapshot(),before);
 service.update('secondary',id,{options:[2,3]});assert.deepEqual(service.get('secondary',id).options,[2,3]);
 service.update('secondary',id,{options:[]});assert.deepEqual(service.get('secondary',id).options,[]);
});

test('Original DLL receives stage-correct results and typed Target, images, SDK choices writes and reload',{skip:process.platform!=='win32'||!process.env.PAQ_TEST_XRM_SDK},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-context-values-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5}));
 const sdk=path.resolve(process.env.PAQ_TEST_XRM_SDK),source=path.join(root,'ContextValues.cs'),assembly=path.join(root,'ContextValues.dll');
 await fs.writeFile(source,`using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;
namespace Invented {public sealed class ContextValues:IPlugin {static void Options(Entity e,int a,int b){var v=e.GetAttributeValue<OptionSetValueCollection>("options");if(v==null||v.Count!=2||v[0].Value!=a||v[1].Value!=b)throw new InvalidPluginExecutionException("Choices lost SDK collection type");}
public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var trace=(ITracingService)services.GetService(typeof(ITracingService));var target=(Entity)c.InputParameters["Target"];
if(c.Stage<40&&c.OutputParameters.Contains("id"))throw new InvalidPluginExecutionException("System output appeared before main operation");
if(c.Stage==10){Options(target,1,2);c.OutputParameters["custom"]=new OptionSetValue(3);}
if(c.Stage==20){if(((OptionSetValue)c.OutputParameters["custom"]).Value!=3)throw new InvalidPluginExecutionException("Custom pre output lost");Options(target,1,2);target["options"]=new OptionSetValueCollection{new OptionSetValue(2),new OptionSetValue(3)};var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var before=s.Retrieve("secondary",new Guid("${id}"),new ColumnSet("options"));Options(before,1,2);before["options"]=new OptionSetValueCollection{new OptionSetValue(3),new OptionSetValue(1)};s.Update(before);Options(s.Retrieve("secondary",new Guid("${id}"),new ColumnSet("options")),3,1);}
if(c.Stage==40){if(((OptionSetValue)c.OutputParameters["custom"]).Value!=3)throw new InvalidPluginExecutionException("Custom post output lost");if(c.OwningExtension.Name=="Post reader"){if((Guid)c.OutputParameters["id"]!=new Guid("${replacement}"))throw new InvalidPluginExecutionException("Post output replacement lost");}else{if((Guid)c.OutputParameters["id"]!=c.PrimaryEntityId)throw new InvalidPluginExecutionException("Main operation output not populated");Options(c.PostEntityImages["after"],2,3);var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);Options(s.Retrieve("widget",c.PrimaryEntityId,new ColumnSet("options")),2,3);c.OutputParameters["id"]=new Guid("${replacement}");}}
trace.Trace("Typed context stage {0} {1}",c.Stage,c.OwningExtension.Name);}}}`);
 const compiler=path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),build=spawnSync(compiler,['/nologo','/target:library','/out:'+assembly,'/reference:'+sdk,source],{shell:false,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(build.status,0,build.stdout+build.stderr);
 const runtime=await prepareClrRuntime({trust:'execute-local-assembly',root,assembly:path.basename(assembly),typeName:'Invented.ContextValues',sdkRoot:path.dirname(sdk),sdkAssembly:path.basename(sdk),cacheRoot:path.join(root,'cache'),serviceProfile:profile,context:{initiatingUserId:user,organizationId:'50000000-0000-0000-0000-000000000001',businessUnitId:'60000000-0000-0000-0000-000000000001'},timeoutMs:2500});
 const common={enabled:true,assemblyId:'invented',typeName:'Invented.ContextValues',entity:'widget',message:'Create',rank:1,mode:0,supportedDeployment:0,filteringAttributes:[]};
 const steps=[10,20,40,40].map((stage,index)=>({...common,id:'30000000-0000-0000-0000-'+String(index+1).padStart(12,'0'),stage,rank:index===3?2:1,name:index===3?'Post reader':'Context writer',images:stage===40?[{alias:'after',name:'after',type:1,attributes:['options']}]:[]}));
 const runtimes=new Map(steps.map(step=>[step.id,runtime])),items=pluginCatalogue({plugins:{steps},runtimes,overrides:Object.fromEntries(steps.map(step=>['plugin-step:'+step.id,{mode:'clr'}]))}),store=data(),notes=[];
 store.setPluginPipeline(context=>runPluginPhase({...context,store,items,runtimes,diagnostic:note=>notes.push(note)}));
 const row=await store.create('widget',{title:'Ordinary',options:'1, 2'},{admin:true});assert.deepEqual(row.options,[2,3]);assert.deepEqual(store.snapshot().tables.secondary[0].options,[3,1]);
 const hosts=notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STOPPED');assert.equal(hosts.length,4);assert.ok(hosts.every(note=>note.absenceVerified));assert.equal(notes.filter(note=>note.code==='PLUGIN_STEP_CLR_EXECUTED').length,4);
 await evidence('.context-values.json',{source,assembly,sdk,hosts,assertions:['Create system id absent at stages 10/20 and populated at first stage 40','Custom outputs retained across stages','Later ranked CLR output id replacement remains visible','Source-typed choices in Target, post image, SDK Retrieve, SDK Update and reload']});
});

test('Original Retrieve and RetrieveMultiple CLR observers see intervening ranked handler results and custom outputs',{skip:process.platform!=='win32'||!process.env.PAQ_TEST_XRM_SDK},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-ranked-read-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5}));
 const sdk=path.resolve(process.env.PAQ_TEST_XRM_SDK),source=path.join(root,'RankedRead.cs'),assembly=path.join(root,'RankedRead.dll');
 await fs.writeFile(source,`using System;using Microsoft.Xrm.Sdk;
namespace Invented {public sealed class RankedRead:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));if(c.Stage==20){if(c.OutputParameters.Count!=0)throw new Exception("Premature system output");c.OutputParameters["custom"]="PreOperation custom";return;}
if((string)c.OutputParameters["custom"]!="PreOperation custom")throw new Exception("PreOperation custom output lost");var e=c.MessageName=="Retrieve"?(Entity)c.OutputParameters["BusinessEntity"]:((EntityCollection)c.OutputParameters["BusinessEntityCollection"]).Entities[0];
if(c.OwningExtension.Name=="Read last"){if(e.GetAttributeValue<string>("title")!="Handler changed"||(string)c.OutputParameters["postCustom"]!="PostOperation custom")throw new Exception("Ranked result or custom output became stale");}
else{e["title"]="CLR changed";c.OutputParameters["postCustom"]="PostOperation custom";}((ITracingService)services.GetService(typeof(ITracingService))).Trace("Ranked original {0} {1}",c.MessageName,c.OwningExtension.Name);}}}`);
 const compiler=path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),build=spawnSync(compiler,['/nologo','/target:library','/out:'+assembly,'/reference:'+sdk,source],{shell:false,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(build.status,0,build.stdout+build.stderr);
 const runtime=await prepareClrRuntime({trust:'execute-local-assembly',root,assembly:path.basename(assembly),typeName:'Invented.RankedRead',sdkRoot:path.dirname(sdk),sdkAssembly:path.basename(sdk),cacheRoot:path.join(root,'cache'),serviceProfile:profile,context:{initiatingUserId:user,organizationId:'50000000-0000-0000-0000-000000000001',businessUnitId:'60000000-0000-0000-0000-000000000001'},timeoutMs:2500});
 const store=data(),notes=[];store.state.tables.secondary[0].title='Stored original';
 const steps=[],runtimes=new Map(),handlers=new Map();let sequence=100;
 for(const message of ['Retrieve','RetrieveMultiple'])for(const spec of [{stage:20,rank:1,name:'Read pre'},{stage:40,rank:1,name:'Read first'},{stage:40,rank:2,name:'Read handler',handler:true},{stage:40,rank:3,name:'Read last'}]){
  const step={...spec,id:'30000000-0000-0000-0000-'+String(++sequence).padStart(12,'0'),enabled:true,assemblyId:'invented-ranked-read',typeName:'Invented.RankedRead',entity:'secondary',message,mode:0,supportedDeployment:0,filteringAttributes:[],images:[]};steps.push(step);
  if(spec.handler)handlers.set(step.id,context=>{if(message==='Retrieve'){const entityResult=context.entityResult;assert.equal(entityResult.attributes.title,'CLR changed');entityResult.attributes.title='Handler changed';return {entityResult};}const collection=context.collection;assert.equal(collection.entities[0].attributes.title,'CLR changed');collection.entities[0].attributes.title='Handler changed';return {collection};});
  else runtimes.set(step.id,runtime);
 }
 const items=pluginCatalogue({plugins:{steps},runtimes,handlers,overrides:Object.fromEntries(steps.filter(step=>!step.handler).map(step=>['plugin-step:'+step.id,{mode:'clr'}]))});
 store.setPluginPipeline(context=>runPluginPhase({...context,store,items,runtimes,handlers,diagnostic:note=>notes.push(note)}));
 assert.equal(store.get('secondary',id,{admin:true}).title,'Handler changed');assert.equal(store.query('secondary',{}, {admin:true}).value[0].title,'Handler changed');
 assert.equal(store.snapshot().tables.secondary[0].title,'Stored original');const hosts=notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STOPPED');assert.equal(hosts.length,6);assert.ok(hosts.every(note=>note.absenceVerified));
 await evidence('.ranked-read-outputs.json',{source,assembly,sdk,hosts,assertions:['Retrieve and RetrieveMultiple custom pre/post outputs retained','Intervening ranked handler result reaches later original CLR observer','Post-read changes affect returned values while stored rows remain unchanged']});
});
