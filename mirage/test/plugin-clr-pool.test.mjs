import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Worker,MessageChannel} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {DataStore} from '../lib/data.mjs';
import {prepareClrRuntime,executeClrPlugin,clrContext,closeClrHostPool,clrHostPoolStatus,validateClrDescriptor} from '../lib/plugin-clr.mjs';

const user='10000000-0000-0000-0000-000000000001',rowId='20000000-0000-0000-0000-000000000001';
const available=process.platform==='win32'&&process.env.PAQ_TEST_XRM_SDK;

test('persistent CLR hosts require explicit Boolean opt-in',()=>{
  const descriptor={trust:'execute-local-assembly',root:os.tmpdir(),sdkRoot:os.tmpdir(),cacheRoot:os.tmpdir(),assembly:'Original.dll',sdkAssembly:'Microsoft.Xrm.Sdk.dll',typeName:'Invented.Original',
    serviceProfile:{userId:user,evidence:'Invented backend',grants:[{entity:'widget',operations:['read']}]},context:{initiatingUserId:user,organizationId:user,businessUnitId:user}};
  for(const value of ['true',1,null,{}])assert.throws(()=>validateClrDescriptor({...descriptor,persistentHost:value}),/explicit Boolean/);
  for(const timeoutMs of ['', '1000',null,NaN,Infinity,-Infinity,0,-1,100.5,Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>validateClrDescriptor({...descriptor,timeoutMs}),/positive safe integer/);
    assert.throws(()=>executeClrPlugin({descriptor:{...descriptor,timeoutMs}}, {}, {store:{}}),/positive safe integer/);
  }
  assert.equal(validateClrDescriptor({...descriptor,persistentHost:true}).persistentHost,true);
  assert.deepEqual(clrHostPoolStatus(),[]);
});

test('failed CLR preparation removes only its owned cache directory',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-clr-build-failure-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5}));
  await fs.writeFile(path.join(root,'Original.dll'),'invented assembly');
  await fs.writeFile(path.join(root,'Sdk.dll'),'invented SDK');
  const cacheRoot=path.join(root,'cache');await fs.mkdir(cacheRoot);await fs.writeFile(path.join(cacheRoot,'keep'),'unrelated');
  await assert.rejects(prepareClrRuntime({trust:'execute-local-assembly',root,sdkRoot:root,cacheRoot,assembly:'Original.dll',sdkAssembly:'Sdk.dll',typeName:'Invented.Original',
    serviceProfile:{userId:user,evidence:'Invented backend',grants:[{entity:'widget',operations:['read']}]},context:{initiatingUserId:user,organizationId:user,businessUnitId:user}},
    {compiler:path.join(root,'missing-compiler.exe')}),error=>error.code==='LocalPluginClrBuild');
  assert.deepEqual(await fs.readdir(cacheRoot),['keep']);
});

test('CLR workers reject non-object output and completion with pending SDK calls and kill owned children',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-clr-protocol-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5}));
  const source=path.join(root,'Protocol.cs'),executable=path.join(root,'Protocol.exe');
  await fs.writeFile(source,`using System;public static class Protocol{public static void Main(){var line=Console.ReadLine();
if(line.Contains("pending")){Console.WriteLine("{\\\"kind\\\":\\\"rpc\\\"}");Console.WriteLine("{\\\"kind\\\":\\\"result\\\"}");}
else if(line.Contains("array"))Console.WriteLine("[]");else Console.WriteLine("null");System.Threading.Thread.Sleep(30000);}}`);
  const compiler=path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const build=spawnSync(compiler,['/nologo','/target:exe','/out:'+executable,source],{shell:false,windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  for(const pooled of [false,true])for(const mode of ['null','array','pending'])await t.test(`${pooled?'pooled':'fresh'} ${mode}`,async sub=>{
    const {port1,port2}=new MessageChannel(),signal=new SharedArrayBuffer(4),input={mode};
    const worker=new Worker(new URL(pooled?'../lib/plugin-clr-pool-worker.mjs':'../lib/plugin-clr-worker.mjs',import.meta.url),
      {workerData:{port:port2,signal,executable,input,timeout:5000},transferList:[port2]});
    let pid;
    sub.after(async()=>{if(pid)try{process.kill(pid);}catch{}port1.close();await worker.terminate();});
    const failure=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('No protocol failure received')),10000);
      worker.once('error',error=>{clearTimeout(timer);reject(error);});
      port1.on('message',message=>{if(message.kind==='owned-child')pid=message.pid;if(message.kind==='failure'){clearTimeout(timer);resolve(message);}});
      if(pooled)port1.postMessage({kind:'invoke',invocationId:'invented-invocation',input,timeout:5000});
    });
    assert.equal(failure.code,'LocalPluginProtocol');
    if(pooled)assert.equal(failure.invocationId,'invented-invocation');
    assert.ok(pid>0);
    let alive=true;
    for(let attempt=0;attempt<100&&alive;attempt++){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}if(alive)await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(alive,false,'worker must stop its malformed host');
  });
});

test('pooled process reuse, runtime isolation, snapshot tampering and throwing cleanup diagnostics',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-clr-isolation-')));
  t.after(()=>closeClrHostPool());
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5}));
  const source=path.join(root,'Protocol.cs'),executable=path.join(root,'Protocol.exe');
  await fs.writeFile(source,'using System;public static class Protocol{public static void Main(){while(Console.ReadLine()!=null)Console.WriteLine("{\\\"kind\\\":\\\"result\\\"}");}}');
  const compiler=path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const build=spawnSync(compiler,['/nologo','/target:exe','/out:'+executable,source],{shell:false,windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const hostSourceSha256=hash(await fs.readFile(new URL('../lib/plugin-clr-host.cs',import.meta.url)));
  const makeRuntime=async name=>{
    const directory=path.join(root,name);await fs.mkdir(directory);
    const assembly=path.join(directory,'Original.dll'),host=path.join(directory,'Protocol.exe');
    await fs.writeFile(assembly,'invented assembly bytes');await fs.copyFile(executable,host);
    const files=await Promise.all([assembly,host].map(async file=>({path:file,sha256:hash(await fs.readFile(file))})));
    return {directory,assembly,executable:host,files,allowedFiles:files.map(file=>path.basename(file.path)),
      descriptor:{persistentHost:true,typeName:'Invented.Original',timeoutMs:5000},provenance:{hostSourceSha256}};
  };
  const first=await makeRuntime('first'),second=await makeRuntime('second');
  const invoke=runtime=>executeClrPlugin(runtime,{}, {store:{}});
  assert.equal(invoke(first).executionMode,'pooled-fresh-instance');
  const firstPid=clrHostPoolStatus()[0].pid;invoke(first);assert.equal(clrHostPoolStatus()[0].pid,firstPid);
  invoke(second);const secondPid=clrHostPoolStatus().find(host=>host.pid!==firstPid).pid;
  assert.deepEqual(closeClrHostPool({runtime:first,diagnostic:()=>{throw new Error('Broken diagnostic sink');}}),{closed:1,allAbsenceVerified:true});
  assert.deepEqual(clrHostPoolStatus().map(host=>host.pid),[secondPid]);
  invoke(second);assert.equal(clrHostPoolStatus()[0].pid,secondPid);
  const snapshots=(await fs.readdir(root)).filter(name=>name.startsWith('clr-pool-'));
  assert.equal(snapshots.length,1,'closed runtime must remove its execution snapshot despite diagnostic failure');
  await fs.writeFile(path.join(root,snapshots[0],'Original.dll'),'changed bytes');
  assert.throws(()=>invoke(second),error=>error.code==='LocalPluginSourceChanged');
  assert.deepEqual(clrHostPoolStatus(),[]);
  assert.equal((await fs.readdir(root)).filter(name=>name.startsWith('clr-pool-')).length,0);
  invoke(second);assert.equal(clrHostPoolStatus().length,1,'tampered host must be replaceable by a verified fresh snapshot');
});

test('pooled original DLL gets fresh instance, configuration, context, frame and SDK callbacks; failures close owned hosts', {skip:!available},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-clr-pool-')),sdk=path.resolve(process.env.PAQ_TEST_XRM_SDK),notes=[];
  t.after(()=>{closeClrHostPool({diagnostic:note=>notes.push(note)});});
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'Original.cs'),assembly=path.join(root,'Original.dll');
  await fs.writeFile(source,`using System;using System.Threading;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;
namespace Invented {public sealed class Original:IPlugin {int calls;readonly string config;public Original(string unsecure,string secure){config=unsecure;}
public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];
if(c.SharedVariables.Contains("leak"))throw new InvalidPluginExecutionException("Frame leaked");c.SharedVariables["leak"]=true;
if(config=="sleep")Thread.Sleep(10000);if(config=="reject")throw new InvalidPluginExecutionException("Configured rejection");
var service=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
target["observed"]=service.Retrieve("secondary",new Guid("${rowId}"),new ColumnSet("title")).GetAttributeValue<string>("title");
target["instanceCalls"]=++calls;target["configuration"]=config;target["request"]=c.RequestId.ToString();}}}`);
  const compiler=path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const build=spawnSync(compiler,['/nologo','/target:library','/out:'+assembly,'/reference:'+sdk,source],{shell:false,windowsHide:true,encoding:'utf8',timeout:20000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const runtime=await prepareClrRuntime({trust:'execute-local-assembly',root,assembly:'Original.dll',typeName:'Invented.Original',sdkRoot:path.dirname(sdk),sdkAssembly:path.basename(sdk),cacheRoot:path.join(root,'cache'),persistentHost:true,
    serviceProfile:{userId:user,evidence:'Invented backend',grants:[{entity:'secondary',operations:['read']}]},context:{initiatingUserId:user,organizationId:user,businessUnitId:user},timeoutMs:10000});
  const store=new DataStore({state:{mappings:{widget:{idColumn:'widgetid',entitySet:'widgets'},secondary:{idColumn:'secondaryid',entitySet:'secondaries'}},tables:{widget:[],secondary:[{secondaryid:rowId,title:'First'}]},settings:{permissionMode:'enforce'}}});
  const step={id:user,name:'Invented original',entity:'widget',message:'Create',stage:20,rank:1,images:[]};
  const invoke=()=>executeClrPlugin(runtime,clrContext({runtime,store,step,entity:'widget',operation:'create',stage:20,target:{title:'Input'},record:{widgetid:rowId},frame:{},depth:1}),{store,diagnostic:note=>notes.push(note)});
  runtime.descriptor.unsecureConfiguration='first';const first=invoke();
  assert.equal(first.target.attributes.instanceCalls,1);assert.equal(first.target.attributes.configuration,'first');assert.equal(first.target.attributes.observed,'First');
  const pid=clrHostPoolStatus()[0].pid;assert.ok(pid>0);
  store.state.tables.secondary[0].title='Second';runtime.descriptor.unsecureConfiguration='second';const second=invoke();
  assert.equal(second.target.attributes.instanceCalls,1);assert.equal(second.target.attributes.configuration,'second');assert.equal(second.target.attributes.observed,'Second');
  assert.notEqual(first.target.attributes.request,second.target.attributes.request);
  assert.equal(clrHostPoolStatus()[0].pid,pid);assert.equal(notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STARTED').length,1);
  runtime.descriptor.unsecureConfiguration='reject';assert.throws(invoke,/Configured rejection/);assert.deepEqual(clrHostPoolStatus(),[]);
  assert.equal(notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STOPPED').at(-1).absenceVerified,true);
  runtime.descriptor.unsecureConfiguration='after-rejection';assert.equal(invoke().target.attributes.configuration,'after-rejection');
  runtime.descriptor.unsecureConfiguration='sleep';runtime.descriptor.timeoutMs=1500;assert.throws(invoke,error=>error.code==='LocalPluginTimeout');assert.deepEqual(clrHostPoolStatus(),[]);
  runtime.descriptor.timeoutMs=10000;runtime.descriptor.unsecureConfiguration='recovered';assert.equal(invoke().target.attributes.observed,'Second');
  assert.deepEqual(closeClrHostPool({runtime,diagnostic:note=>notes.push(note)}),{closed:1,allAbsenceVerified:true});assert.deepEqual(clrHostPoolStatus(),[]);
  assert.equal(notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STARTED').length,notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STOPPED').length);
});
