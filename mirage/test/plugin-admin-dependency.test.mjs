import test from 'node:test';
import {ORDINARY_CLR_TIMEOUT_MS} from './fixtures/clr-budget.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pluginFixture,pluginId} from './plugin-fixture.mjs';
import {createSimulator} from '../server.mjs';


import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
test('Actual admin mock and disabled modes suppress original CLR loopback dependency calls',{skip:process.platform!=='win32'||!process.env.PAQ_TEST_XRM_SDK},async t=>{
 const worker=new Worker('const {parentPort}=require("node:worker_threads");const http=require("node:http");let requests=0;const server=http.createServer((q,r)=>{requests++;r.end("Owned loopback dependency executed");});server.listen(0,"127.0.0.1",()=>parentPort.postMessage({port:server.address().port}));parentPort.on("message",m=>{if(m.kind==="count")parentPort.postMessage({count:requests});});',{eval:true});t.after(()=>worker.terminate());const [{port}]=await once(worker,'message');const count=async()=>{worker.postMessage({kind:'count'});return (await once(worker,'message'))[0].count;};
 const fixture=await pluginFixture(t),initial=fixture.app.store.snapshot();await fixture.app.close();
 for(let n=4;n<=11;n++){const file=path.join(fixture.solution,'SdkMessageProcessingSteps',pluginId(n)+'.xml');await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace('<StateCode>0</StateCode>','<StateCode>1</StateCode>'));}
 const sdk=path.resolve(process.env.PAQ_TEST_XRM_SDK),source=path.join(fixture.dir,'Dependency.cs'),assembly=path.join(fixture.dir,'Invented.WidgetRules.dll');
 await fs.writeFile(source,'using System;using System.Net;using Microsoft.Xrm.Sdk;namespace Invented.WidgetRules {public sealed class Validate:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];using(var client=new WebClient())target["fx_note"]=client.DownloadString("http://127.0.0.1:'+port+'/owned-fixture");}}}');
 const build=spawnSync(path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:library','/out:'+assembly,'/reference:'+sdk,'/reference:System.Runtime.Serialization.dll',source],{encoding:'utf8',windowsHide:true});assert.equal(build.status,0,build.stdout+build.stderr);
 const user='10000000-0000-0000-0000-000000000001',descriptor={trust:'execute-local-assembly',root:fixture.dir,assembly:path.basename(assembly),typeName:'Invented.WidgetRules.Validate',sdkRoot:path.dirname(sdk),sdkAssembly:path.basename(sdk),cacheRoot:path.join(fixture.dir,'cache'),context:{initiatingUserId:user,organizationId:user,businessUnitId:user},serviceProfile:{userId:user,evidence:'Invented loopback dependency admin-mode fixture',grants:[]},timeoutMs:ORDINARY_CLR_TIMEOUT_MS},pack=path.join(fixture.dir,'dependency-pack.mjs');
 await fs.writeFile(pack,'export default {id:"invented-plugin-dependency",name:"Invented dependency",description:"Owned loopback dependency admin fixture",matches:()=>true,presets:()=>({}),pluginRuntimes:'+JSON.stringify({[pluginId(3)]:descriptor})+'};');
 const app=await createSimulator({sourceDir:fixture.portal,solutionRoots:[fixture.solution],initial,watch:false,dataPacks:[{id:'invented-plugin-dependency',module:pack}]});t.after(()=>app.close());
 const key='plugin-step:'+pluginId(3),admin=body=>fetch(app.url+'/__sim/api/operations/'+encodeURIComponent(key),{method:'PATCH',headers:{'content-type':'application/json','x-sim-csrf':app.state().csrf},body:JSON.stringify(body)}),write=title=>fetch(app.url+'/_api/fx_widgets',{method:'POST',headers:{'content-type':'application/json',__RequestVerificationToken:app.state().csrf},body:JSON.stringify({fx_title:title})});
 assert.equal((await count()),0);assert.equal((await admin({mode:'clr'})).status,200);assert.equal((await write('Original CLR phase')).status,204);assert.equal(await count(),1);assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_note,'Owned loopback dependency executed');
 const hostsBefore=app.state().diagnostics.filter(n=>n.code==='PLUGIN_CLR_HOST_STARTED').length;assert.equal(hostsBefore,1);
 assert.equal((await admin({mode:'mock',body:{target:{fx_note:'Exact admin mock result'}}})).status,200);assert.equal((await write('Mock phase')).status,204);assert.equal(await count(),1);assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_note,'Exact admin mock result');assert.equal(app.store.snapshot().simulator.operations[key].mode,'mock');
 assert.equal((await admin({mode:'disabled'})).status,200);assert.equal((await write('Disabled phase')).status,204);assert.equal(await count(),1);assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_note,undefined);assert.equal(app.store.snapshot().simulator.operations[key].mode,'disabled');
 const starts=app.state().diagnostics.filter(n=>n.code==='PLUGIN_CLR_HOST_STARTED'),stops=app.state().diagnostics.filter(n=>n.code==='PLUGIN_CLR_HOST_STOPPED');assert.equal(starts.length,1);assert.equal(stops.length,1);assert.ok(stops.every(n=>n.absenceVerified));
 const report={schemaVersion:1,generatedAt:new Date().toISOString(),nativeCalls:0,externalCalls:0,ownedLoopbackDependencyCalls:await count(),hostsStarted:starts.length,hostsAbsent:true,originalClr:true,mockSavedAndExecuted:true,disabledSavedAndSkipped:true};assert.equal(report.ownedLoopbackDependencyCalls,1);assert.equal(report.hostsStarted,1);
});
