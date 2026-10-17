import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFixture} from './fixture.mjs';
import {loadConfig} from '../lense/config.mjs';
import {catalogueArgs,cliArgs} from '../lense/commands/mirage.mjs';
const cli=fileURLToPath(new URL('../bin/paqvilo.mjs',import.meta.url));

test('catalogue start applies linked configuration only by flag or catalogue, and rejects an unknown link', {timeout:150000}, async()=>{
  const fixture=createFixture(),root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'paqvilo-feedback-preset-'))),config=path.join(root,'catalogue.json');
  const portal=path.join(root,'portal');fs.cpSync(fixture.dir,portal,{recursive:true});fixture.cleanup();
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PAQVILO_')&&!key.startsWith('GIT_')));
  const run=(...args)=>spawnSync(process.execPath,[cli,'mirage',...args,'--config',config],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:120000});
  const catalog={sites:{fixture:{source:portal,environments:{local:'http://127.0.0.1:8787'},mirage:{port:0,preset:'tiny',solutionRoots:[],dataPacks:['./pack.mjs']}}}};
  const writePack=link=>fs.writeFileSync(path.join(root,'pack.mjs'),`export default {id:'tiny',name:'Tiny',description:'Invented linked configuration',matches:()=>true,configurationPresets:[{id:'tiny-config',name:'Tiny configuration',platformOverrides:{QueryLinkEntityLimit:30}}],presets:()=>({tiny:{name:'Tiny',configurationPreset:${JSON.stringify(link)},tables:{}}})};`);
  fs.writeFileSync(config,JSON.stringify(catalog));writePack('tiny-config');
  const stop=()=>{const result=run('stop','--site','fixture','--json');assert.equal(result.status,0,result.stdout+result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.offline,false);assert.ok(report.writesFiles.some(file=>file.endsWith('sessions.json')));};
  try{
    const initialized=run('init','--site','fixture','--json');assert.equal(initialized.status,0,initialized.stdout+initialized.stderr);const project=JSON.parse(initialized.stdout);assert.equal(project.offline,true);assert.deepEqual(project.writesFiles,[project.file]);
    const inspected=spawnSync(process.execPath,[cli,'lense','mirage','inspect','--site','fixture','--json','--config',config],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(inspected.status,0,inspected.stdout+inspected.stderr);const inventory=JSON.parse(inspected.stdout);assert.equal(inventory.command,'mirage');assert.equal(inventory.action,'inspect');assert.equal(inventory.offline,true);assert.deepEqual(inventory.writesFiles,[]);assert.ok(Array.isArray(inventory.errors));
    const interactive=run('dev','--site','fixture','--json');assert.equal(interactive.status,1);assert.equal(JSON.parse(interactive.stdout).ok,false);assert.match(JSON.parse(interactive.stdout).error.message,/interactive/);
    for(const flag of [false,true]){
      const result=run('start','--site','fixture',...(flag?['--apply-configuration']:[]),'--json');
      assert.equal(result.status,0,result.stdout+result.stderr);const started=JSON.parse(result.stdout);
      assert.equal(started.offline,false);assert.equal(started.runtimeWrites,true);assert.ok(started.writesFiles.includes(started.stateFile));assert.ok(started.writesFiles.some(file=>file.endsWith('sessions.json')));assert.ok(started.writesFiles.every(file=>fs.existsSync(file)));
      const status=await (await fetch(started.url+'/__sim/api/status')).json();
      assert.equal(status.activeConfigurationPreset?.id??null,flag?'tiny-config':null);
      stop();
    }
    // The dev launcher shares this argument construction with start. It must
    // retain an explicit flag even when the catalogue requests data-only.
    catalog.sites.fixture.mirage.presetConfiguration='data-only';fs.writeFileSync(config,JSON.stringify(catalog));
    const cfg=await loadConfig({config,site:'fixture'},env),effective=catalogueArgs(cfg,{'apply-configuration':true});
    assert.ok(cliArgs(cfg,'dev',effective).values.includes('--apply-configuration'));
    writePack('missing-config');
    const bad=run('start','--site','fixture','--apply-configuration','--json');
    assert.equal(bad.status,1,bad.stdout+bad.stderr);assert.match(bad.stdout+bad.stderr,/missing-config/);const failure=JSON.parse(bad.stdout);assert.equal(failure.offline,false);assert.ok(failure.writesFiles.some(file=>file.endsWith('.log')));
  }finally{stop();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
