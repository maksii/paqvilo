import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {planSdkProjectionProbes} from '../sdk-projection-probes.mjs';
const equipmentId='10000000-0000-0000-0000-000000000001',canaryRunId='10000000-0000-0000-0000-000000000002',markerUtc='CO-UTC:2026-10-13T00:00:00.000Z';
test('pure SDK controls independently cover column constructors, authored Fetch flags and caller total-count controls',()=>{
 const plan=planSdkProjectionProbes({equipmentId,canaryRunId,markerUtc});assert.equal(plan.probes.length,21);assert.equal(new Set(plan.probes.map(row=>row.operationId)).size,21);assert.equal(plan.requiresPreparedIntents,true);
 for(const kind of ['QueryExpression','Retrieve','FetchExpression'])for(const columnMode of ['empty','name','pk','all'])assert.equal(plan.probes.filter(row=>row.id===(kind==='QueryExpression'?'QE':kind==='Retrieve'?'Retrieve':'Fetch')+'-'+columnMode).length,1);
 for(const kind of ['QueryExpression','FetchExpression'])assert.deepEqual(plan.probes.filter(row=>row.kind===kind&&row.countFixture).map(row=>row.totalCount),[null,false,true]);
 assert.deepEqual(plan.probes.filter(row=>row.distinct!==undefined).map(row=>row.distinct),[false,true]);assert.equal(plan.probes.filter(row=>row.minActiveRowVersion).length,1);assert.ok(plan.probes.every(row=>row.equipmentId===equipmentId&&row.canaryRunId===canaryRunId));
 for(const invalid of [{equipmentId:'x'},{canaryRunId:'x'},{markerUtc:'x'},{operationId:()=>equipmentId}])assert.throws(()=>planSdkProjectionProbes({equipmentId,canaryRunId,markerUtc,...invalid}));
});

test('actual compiled SDK driver selects TLS 1.2 before reading invalid local input',{skip:process.platform!=='win32'||!process.env.PAQ_TEST_XRM_SDK},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'paq-sdk-transport-'));
 try{
  const project=fileURLToPath(new URL('../SdkProbes/SdkProbes.csproj',import.meta.url));
  const restored=process.env.PAQ_TEST_SDK_PROBES_RESTORED==='1';
  const build=spawnSync('dotnet',['build',project,'--disable-build-servers',...(restored?['--no-restore']:[]),'--configuration','Release','--output',directory,'--property:RestoreLockedMode=true'],{windowsHide:true,encoding:'utf8',timeout:120000});assert.equal(build.status,0,[build.error?.message,build.stdout,build.stderr].filter(Boolean).join('\n'));
  const driver=path.join(directory,'SdkProbes.exe'),source=path.join(directory,'TransportTest.cs'),testExe=path.join(directory,'TransportTest.exe');
  await fs.writeFile(source,'using System;using System.IO;using System.Net;public static class TransportTest{public static int Main(){ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls;Console.SetIn(new StringReader("{invalid\\n"));Console.SetOut(new StringWriter());var exit=SdkProjectionDriver.Main();return exit==2&&ServicePointManager.SecurityProtocol==SecurityProtocolType.Tls12?0:1;}}');
  const compile=spawnSync(path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/out:'+testExe,'/reference:'+driver,source],{windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const result=spawnSync(testExe,[],{windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stdout+result.stderr);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
