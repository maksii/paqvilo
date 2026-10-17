import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFixture} from './fixture.mjs';
import {MIRAGE_COMMANDS} from '../mirage/tool-registry.mjs';
const cli=fileURLToPath(new URL('../bin/paqvilo.mjs',import.meta.url));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PAQVILO_')));

test('unknown Mirage commands reject before project and source resolution in an empty directory',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'paqvilo-unknown-mirage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const args of [['mirage','nosuchcommand'],['mirage','nosuchcommand','--project','missing.json'],['lense','mirage','nosuchcommand']]){
    const result=spawnSync(process.execPath,[cli,...args],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(result.status,1);assert.match(result.stderr,/Unknown (?:command|mirage action)/);assert.match(result.stderr,/--help/);assert.doesNotMatch(result.stderr,/does not look like|ENOENT|portal-export/);
  }
  assert.deepEqual(fs.readdirSync(root),[],'unknown commands do not create local project state');
  const typo=spawnSync(process.execPath,[cli,'mirage','strat'],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(typo.status,1);assert.match(typo.stderr,/Closest command: start/);
  const help=spawnSync(process.execPath,[cli,'mirage','--help'],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:15000});
  for(const command of MIRAGE_COMMANDS){assert.ok(typo.stderr.includes(command));assert.ok(help.stdout.includes(command));}
});

test('duplicate source keys gate Sources independently of Lense readiness',t=>{
  const fx=createFixture();t.after(fx.cleanup);
  fx.write('sitesetting.yml','- adx_name: Before\n  adx_value: one\n  adx_name: After\n  adx_value: two\n');
  const config=fx.file('feedback-readiness.json');fs.writeFileSync(config,JSON.stringify({sourceRoot:fx.dir,sites:{invented:{source:'.',environments:{local:'http://127.0.0.1:8787'},mirage:{port:0,solutionRoots:[]}}}}));
  // This is a verdict contract test, not a startup benchmark. Match the other
  // offline CLI tests' bounded deadline when browser suites share a busy worker.
  const run=(...args)=>{
    const result=spawnSync(process.execPath,[cli,'lense','doctor','--config',config,...args],{cwd:fx.dir,env,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.ifError(result.error);
    assert.equal(result.signal,null,result.stderr);
    return result;
  };
  for(const gated of [false,true]){
    const args=gated?['--mirage']:[],json=run(...args,'--json'),report=JSON.parse(json.stdout),site=report.reports[0];
    assert.equal(site.lenseReady,true);assert.equal(site.sourcesReady,false);assert.equal(report.ok,!gated);assert.equal(json.status,gated?1:0);
    if(gated){assert.ok(report.checks.includes('sources'));assert.ok(report.errors.some(error=>error.message.startsWith('Sources:')));assert.equal(report.errors[0].code,'check_failed');}
    const text=run(...args);assert.match(text.stdout,/Lense ready · Sources NOT READY/);assert.doesNotMatch(text.stdout,/Lense NOT READY/);
  }
  const unknown=run('--site','nosuch','--json'),answer=JSON.parse(unknown.stdout);
  assert.equal(unknown.status,1);assert.equal(answer.errors[0].code,'invalid_argument');assert.match(answer.errors[0].message,/nosuch.*invented/);
});
