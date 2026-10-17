import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFixture} from './fixture.mjs';
import {inspectProcessResult} from '../lense/commands/mirage.mjs';

test('Lense Mirage inspect retains invalid-source diagnostic reports and the failing exit status',t=>{
  const fixture=createFixture();t.after(fixture.cleanup);
  fixture.write('broken.sitesetting.yml','adx_name: [unterminated\n');
  const config=fixture.file('inspect-catalogue.yml');
  fs.writeFileSync(config,JSON.stringify({sourceRoot:fixture.dir,sites:{invented:{source:'.',environments:{local:'http://127.0.0.1:8787'}}}}));
  const cli=fileURLToPath(new URL('../lense/cli.mjs',import.meta.url));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PAQVILO_')&&!key.startsWith('GIT_')));
  const result=spawnSync(process.execPath,[cli,'mirage','inspect','--config',config,'--json'],{encoding:'utf8',windowsHide:true,env,timeout:15000});
  assert.equal(result.status,1,result.stdout+result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.command,'mirage');assert.equal(report.action,'inspect');assert.equal(report.ok,false);assert.equal(report.offline,true);assert.deepEqual(report.writesFiles,[]);
  assert.ok(report.pages.length>0);
  assert.ok(report.diagnostics.some(item=>item.code==='invalid-yaml'&&path.basename(item.file)==='broken.sitesetting.yml'));
  assert.ok(report.errors.some(item=>item.code==='invalid-yaml'&&typeof item.message==='string'));
  const human=spawnSync(process.execPath,[cli,'mirage','inspect','--config',config],{encoding:'utf8',windowsHide:true,env,timeout:15000});
  assert.equal(human.status,1);assert.ok(JSON.parse(human.stdout).diagnostics.some(item=>item.code==='invalid-yaml'));
  fs.unlinkSync(fixture.file('broken.sitesetting.yml'));
  const healthy=spawnSync(process.execPath,[cli,'mirage','inspect','--config',config,'--json'],{encoding:'utf8',windowsHide:true,env,timeout:15000});
  assert.equal(healthy.status,0,healthy.stdout+healthy.stderr);assert.equal(JSON.parse(healthy.stdout).ok,true);assert.deepEqual(JSON.parse(healthy.stdout).errors,[]);
});

test('inspection report parsing distinguishes source diagnostics from crashes and corrupt output',()=>{
  const report={sourceDir:'invented',pages:[{id:'home'}],diagnostics:[{code:'invalid-yaml',message:'Broken source'}]};
  assert.equal(inspectProcessResult({status:1,stdout:JSON.stringify(report),stderr:''}).exitCode,1);
  const project={configFile:'invented.yml',portals:[report]};
  assert.equal(inspectProcessResult({status:1,stdout:JSON.stringify(project),stderr:''}).errors[0].code,'invalid-yaml');
  assert.throws(()=>inspectProcessResult({status:1,stdout:'',stderr:'Runtime unavailable'}),/Runtime unavailable/);
  assert.throws(()=>inspectProcessResult({status:1,stdout:JSON.stringify({...report,diagnostics:[]}),stderr:'Runtime unavailable after inspection'}),/Runtime unavailable after inspection/);
  assert.throws(()=>inspectProcessResult({status:0,stdout:'not json'}),/invalid JSON/);
  assert.throws(()=>inspectProcessResult({status:0,stdout:'null'}),/invalid inspection report/);
  assert.throws(()=>inspectProcessResult({status:0,stdout:JSON.stringify({configFile:'invented',portals:[null]})}),/invalid inspection report/);
  assert.throws(()=>inspectProcessResult({status:null,signal:'SIGTERM',stdout:JSON.stringify(report)}),/terminated by SIGTERM/);
});
