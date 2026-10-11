import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {canonicalClrDirectory,readClrDependency,prepareClrRuntime} from '../lib/plugin-clr.mjs';
import {DataStore} from '../lib/data.mjs';
import {pluginCatalogue,runPluginPhase} from '../lib/exported-plugins.mjs';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-clr-files-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5}));return root;}
test('CLR dependency reads preserve bytes and reject traversal, nonfiles and oversized files',async t=>{
 const root=await fixture(t);await fs.writeFile(path.join(root,'Original.dll'),'original bytes');assert.equal((await readClrDependency(root,'Original.dll')).bytes.toString(),'original bytes');await assert.rejects(readClrDependency(root,'../Original.dll'),/escaped/);await assert.rejects(readClrDependency(root,'.'),/escaped/);await fs.mkdir(path.join(root,'Directory.dll'));await assert.rejects(readClrDependency(root,'Directory.dll'),/regular DLL/);const h=await fs.open(path.join(root,'Large.dll'),'wx');await h.truncate(32*1024*1024+1);await h.close();await assert.rejects(readClrDependency(root,'Large.dll'),/regular DLL/);
 // A file that grows after fstat still has a bounded same-handle read.
 const growing=path.join(root,'Growing.dll');await fs.writeFile(growing,'initial');const open=fs.open;let opened,readTotal=0;
 fs.open=async function(file,...args){const handle=await open(file,...args);if(file===growing){opened=handle;const read=handle.read.bind(handle);let grew=false;handle.read=async args=>{if(!grew){grew=true;await fs.truncate(growing,32*1024*1024+100);}const result=await read(args);readTotal+=result.bytesRead;return result;};}return handle;};
 try{await assert.rejects(readClrDependency(root,'Growing.dll'),/regular DLL/);assert.equal(readTotal,32*1024*1024+1);assert.equal(opened.fd,-1);}finally{fs.open=open;}
});
test('CLR directory canonical spelling accepts a real directory while actual directory links remain forbidden',async t=>{
 const root=await fixture(t),target=path.join(root,'MixedCaseCache');await fs.mkdir(target);assert.equal(await canonicalClrDirectory(target),await fs.realpath(target));if(process.platform==='win32'){assert.notEqual(path.resolve(target.toLowerCase()),await fs.realpath(target));assert.equal(await canonicalClrDirectory(target.toLowerCase()),await fs.realpath(target));}
 const link=path.join(root,'LinkedCache');await fs.symlink(target,link,process.platform==='win32'?'junction':'dir');await assert.rejects(canonicalClrDirectory(link),/symlink/);await fs.writeFile(path.join(target,'Dependency.dll'),'linked bytes');await assert.rejects(readClrDependency(root,'LinkedCache/Dependency.dll'),/symlinks/);
});
test('CLR opened-file identity rejects replacement before validation and closes the original handle',async t=>{
 const root=await fixture(t),file=path.join(root,'Original.dll');await fs.writeFile(file,'original');const original=fs.open;let opened;
 fs.open=async function(p,...args){const h=await original(p,...args);if(p===file){opened=h;await fs.rename(file,file+'.retained');await fs.writeFile(file,'replacement');}return h;};
 try{await assert.rejects(readClrDependency(root,'Original.dll'),/regular DLL/);assert.equal(opened.fd,-1);}finally{fs.open=original;}
});
test('CLR opened-file read rejects a pathname replaced during reading without reopening its replacement',async t=>{
 const root=await fixture(t),file=path.join(root,'Original.dll');await fs.writeFile(file,'original');const original=fs.open;let readBytes,opened;
 fs.open=async function(p,...args){const h=await original(p,...args);if(p===file){opened=h;const read=h.read.bind(h);let replaced=false;h.read=async args=>{if(!replaced){replaced=true;await fs.rename(file,file+'.retained');await fs.writeFile(file,'replacement');}const result=await read(args);if(result.bytesRead)readBytes=Buffer.from(args.buffer.subarray(0,result.bytesRead));return result;};}return h;};
 try{await assert.rejects(readClrDependency(root,'Original.dll'),/changed during preparation/);assert.equal(readBytes.toString(),'original');assert.equal(opened.fd,-1);}finally{fs.open=original;}
});
test('Actual original CLR case-variant cache compiles once, runs verified snapshot bytes and removes snapshots after success, fault, timeout and nesting',{skip:process.platform!=='win32'||!process.env.PAQ_TEST_XRM_SDK},async t=>{
 const root=await fixture(t),sdk=path.resolve(process.env.PAQ_TEST_XRM_SDK),source=path.join(root,'Original.cs'),assembly=path.join(root,'Original.dll'),cache=path.join(root,'MixedCaseCache');await fs.mkdir(cache);
 await fs.writeFile(source,'using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Original:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];if(target.GetAttributeValue<string>("title")=="fault")throw new InvalidPluginExecutionException("ordinary owned fault");if(target.GetAttributeValue<string>("title")=="timeout")System.Threading.Thread.Sleep(5000);if(target.GetAttributeValue<string>("title")=="nested"){var service=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var child=new Entity("widget");child["title"]="ordinary";service.Create(child);}target["title"]="saved by original";}}}');
 const compiler=path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),build=spawnSync(compiler,['/nologo','/target:library','/out:'+assembly,'/reference:'+sdk,source],{shell:false,windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(build.status,0,build.stdout+build.stderr);
 const user='10000000-0000-0000-0000-000000000001',runtime=await prepareClrRuntime({trust:'execute-local-assembly',root,assembly:'Original.dll',typeName:'Invented.Original',sdkRoot:path.dirname(sdk),sdkAssembly:path.basename(sdk),cacheRoot:cache.toLowerCase(),timeoutMs:700,serviceProfile:{userId:user,evidence:'Invented local file lifecycle regression',grants:[{entity:'widget',operations:['read','create']}]},context:{initiatingUserId:user,organizationId:'50000000-0000-0000-0000-000000000001',businessUnitId:'60000000-0000-0000-0000-000000000001'}});
 assert.equal(path.dirname(runtime.directory),await fs.realpath(cache));const step={id:'30000000-0000-0000-0000-000000000001',name:'Ordinary original',enabled:true,typeName:runtime.descriptor.typeName,assemblyId:'invented',entity:'widget',message:'Create',stage:20,rank:1,mode:0,supportedDeployment:0,filteringAttributes:[],images:[]},runtimes=new Map([[step.id,runtime]]),items=pluginCatalogue({plugins:{steps:[step]},runtimes,overrides:{['plugin-step:'+step.id]:{mode:'clr'}}}),store=new DataStore({state:{version:1,mappings:{widget:{entitySet:'widgets',idColumn:'widgetid'}},tables:{widget:[]},plugins:[],settings:{permissionMode:'permissive'}}}),notes=[];
 store.setPluginPipeline(ctx=>runPluginPhase({...ctx,store,items,runtimes,diagnostic:n=>notes.push(n)}));assert.equal((await store.create('widget',{title:'ordinary'},{admin:true})).title,'saved by original');await assert.rejects(store.create('widget',{title:'fault'},{admin:true}),/ordinary owned fault/);assert.equal(store.snapshot().tables.widget.length,1);await assert.rejects(store.create('widget',{title:'timeout'},{admin:true}),/timeout|deadline/i);assert.equal(store.snapshot().tables.widget.length,1);assert.equal((await store.create('widget',{title:'nested'},{admin:true})).title,'saved by original');assert.equal(store.snapshot().tables.widget.length,3);assert.ok(!(await fs.readdir(cache)).some(n=>n.startsWith('clr-run-')),JSON.stringify({files:await fs.readdir(cache),notes:notes.filter(n=>['PLUGIN_CLR_CLEANUP','PLUGIN_CLR_HOST_STOPPED'].includes(n.code))}));const stops=notes.filter(n=>n.code==='PLUGIN_CLR_HOST_STOPPED');assert.equal(stops.length,5);assert.ok(stops.every(n=>n.absenceVerified));
 // A later pathname replacement cannot change bytes already copied for this invocation.
 const cachedAssembly=runtime.files[0].path,originalBytes=await fs.readFile(cachedAssembly),write=syncFs.writeFileSync;let replaced=false;
 syncFs.writeFileSync=function(file,...args){const result=write(file,...args);if(!replaced&&path.basename(file)==='Original.dll'&&path.basename(path.dirname(file)).startsWith('clr-run-')){replaced=true;write(cachedAssembly,'changed cached original');}return result;};
 try{assert.equal((await store.create('widget',{title:'ordinary'},{admin:true})).title,'saved by original');}finally{syncFs.writeFileSync=write;}
 assert.equal(replaced,true);await assert.rejects(store.create('widget',{title:'ordinary'},{admin:true}),/Trusted CLR bytes changed/);await fs.writeFile(cachedAssembly,originalBytes);
 // Cleanup failure is finite and reported without replacing the original plugin fault.
 const unlink=syncFs.unlinkSync;syncFs.unlinkSync=function(file){if(path.basename(path.dirname(file)).startsWith('clr-run-')){const error=new Error('Invented busy fixture');error.code='EBUSY';error.syscall='unlink';throw error;}return unlink(file);};
 try{await assert.rejects(store.create('widget',{title:'fault'},{admin:true}),/ordinary owned fault/);}finally{syncFs.unlinkSync=unlink;}
 assert.ok(notes.some(n=>n.code==='PLUGIN_CLR_CLEANUP'&&n.message==='Owned CLR snapshot cleanup failed: EBUSY (unlink)'));
 for(const name of (await fs.readdir(cache)).filter(n=>n.startsWith('clr-run-'))){const owned=path.resolve(cache,name);assert.equal(path.dirname(owned),path.resolve(cache));await fs.rm(owned,{recursive:true,force:true,maxRetries:5});}
 assert.ok(!(await fs.readdir(cache)).some(n=>n.startsWith('clr-run-')));const allStops=notes.filter(n=>n.code==='PLUGIN_CLR_HOST_STOPPED');assert.equal(allStops.length,7);assert.ok(allStops.every(n=>n.absenceVerified));
 await fs.writeFile(assembly,'changed original');await assert.rejects(store.create('widget',{title:'ordinary'},{admin:true}),/Trusted CLR bytes changed/);assert.ok(!(await fs.readdir(cache)).some(n=>n.startsWith('clr-run-')));
});
