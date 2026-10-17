import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pluginFixture,pluginId} from './plugin-fixture.mjs';
import {createSimulator} from '../server.mjs';
import {clrHostPoolStatus} from '../lib/plugin-clr.mjs';

test('CLR mode changes reuse owned hosts, close disabled hosts and preserve another instance',{skip:process.platform!=='win32'||!process.env.PAQ_TEST_XRM_SDK},async t=>{
 const fixture=await pluginFixture(t),initial=fixture.app.store.snapshot();await fixture.app.close();
 const sdk=path.resolve(process.env.PAQ_TEST_XRM_SDK),source=path.join(fixture.dir,'Original.cs'),assembly=path.join(fixture.dir,'Invented.WidgetRules.dll');
 await fs.writeFile(source,'using System;using Microsoft.Xrm.Sdk;namespace Invented.WidgetRules {public sealed class Validate:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));((Entity)c.InputParameters["Target"])["fx_note"]="Original completed";}}}');
 const built=spawnSync(path.join(process.env.WINDIR??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:library','/out:'+assembly,'/reference:'+sdk,source],{encoding:'utf8',windowsHide:true});assert.equal(built.status,0,built.stdout+built.stderr);
 const user='10000000-0000-0000-0000-000000000001',key='plugin-step:'+pluginId(3),descriptor={trust:'execute-local-assembly',root:fixture.dir,assembly:path.basename(assembly),typeName:'Invented.WidgetRules.Validate',sdkRoot:path.dirname(sdk),sdkAssembly:path.basename(sdk),cacheRoot:path.join(fixture.dir,'cache'),persistentHost:true,timeoutMs:10000,context:{initiatingUserId:user,organizationId:user,businessUnitId:user},serviceProfile:{userId:user,evidence:'Invented owned lifecycle fixture',grants:[]}};
 const pack={id:'invented-lifecycle',name:'Invented lifecycle',description:'Owned host lifecycle',matches:()=>true,presets:()=>({}),pluginRuntimes:{[pluginId(3)]:descriptor}};
 const make=()=>createSimulator({sourceDir:fixture.portal,solutionRoots:[fixture.solution],initial,watch:false,packs:[pack]});
 const first=await make();t.after(()=>first.close());const second=await make();t.after(()=>second.close());
 const configure=(app,body,method='PATCH')=>fetch(app.url+'/__sim/api/operations/'+encodeURIComponent(key),{method,headers:{'content-type':'application/json','x-sim-csrf':app.state().csrf},...(body?{body:JSON.stringify(body)}:{})});
 const write=app=>fetch(app.url+'/_api/fx_widgets',{method:'POST',headers:{'content-type':'application/json',__RequestVerificationToken:app.state().csrf},body:JSON.stringify({fx_title:'Owned original'})});
 for(const app of [first,second]){assert.equal((await configure(app,{mode:'clr'})).status,200);assert.equal((await write(app)).status,204);}
 const pids=clrHostPoolStatus().map(host=>host.pid).sort();assert.equal(pids.length,2);assert.notEqual(pids[0],pids[1]);
 assert.equal((await configure(first,{mode:'clr'})).status,200);assert.equal((await write(first)).status,204);assert.deepEqual(clrHostPoolStatus().map(host=>host.pid).sort(),pids,'Saving CLR twice reuses the prepared runtime');
 assert.equal((await configure(first,{mode:'disabled'})).status,200);assert.equal(clrHostPoolStatus().length,1);assert.equal((await write(second)).status,204);
 assert.equal((await configure(first,{mode:'clr'})).status,200);assert.equal((await write(first)).status,204);assert.equal(clrHostPoolStatus().length,2);
 assert.equal((await configure(first,null,'DELETE')).status,200);assert.equal(clrHostPoolStatus().length,1);
 assert.equal((await configure(first,{mode:'clr'})).status,200);assert.equal((await write(first)).status,204);await first.close();assert.equal(clrHostPoolStatus().length,1);assert.equal((await write(second)).status,204);
 await second.close();assert.deepEqual(clrHostPoolStatus(),[]);
 for(const app of [first,second]){const notes=app.state().diagnostics;assert.equal(notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STARTED').length,notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STOPPED').length);assert.ok(notes.filter(note=>note.code==='PLUGIN_CLR_HOST_STOPPED').every(note=>note.absenceVerified));}
});
