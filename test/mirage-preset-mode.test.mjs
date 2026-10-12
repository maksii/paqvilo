import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFixture} from './fixture.mjs';
import {loadCatalogue,loadConfig} from '../lense/config.mjs';
const cli=fileURLToPath(new URL('../bin/paqvilo.mjs',import.meta.url));

test('catalogue bootstrap presets preserve state and print their startup decision', {timeout:150000}, async()=>{
 const fixture=createFixture(),root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'paqvilo-preset-mode-'))),config=path.join(root,'catalogue.json');
 const portal=path.join(root,'portal');fs.cpSync(fixture.dir,portal,{recursive:true});fixture.cleanup();
 const run=(...args)=>spawnSync(process.execPath,[cli,'mirage',...args,'--config',config],{cwd:root,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PAQVILO_')&&!key.startsWith('GIT_'))),encoding:'utf8',windowsHide:true,timeout:120000});
 const catalog={defaults:{mirage:{presetMode:'bootstrap'}},sites:{fixture:{source:portal,environments:{dev:'https://invented.example.test'},mirage:{port:0,preset:'tiny',solutionRoots:[],dataPacks:['./pack.mjs']}}}};
 fs.writeFileSync(config,JSON.stringify(catalog));
 fs.writeFileSync(path.join(root,'pack.mjs'),'export default {id:"tiny",name:"Tiny",description:"Synthetic preset",matches:()=>true,presets:()=>({tiny:{name:"Tiny",mappings:{widget:{idColumn:"widgetid",entitySet:"widgets"}},tables:{widget:[{widgetid:"seed",name:"Seed"}]},settings:{permissionMode:"permissive"}}})};');
 try{
  assert.equal((await loadConfig({config,site:'fixture'})).mirageConfig.presetMode,'bootstrap');
  const first=run('start','--site','fixture','--json');assert.equal(first.status,0,first.stdout+first.stderr);const started=JSON.parse(first.stdout);assert.equal(started.runtime.startupPreset.applied,true);
  assert.equal(run('stop','--site','fixture','--json').status,0);
  const state=JSON.parse(fs.readFileSync(started.stateFile,'utf8'));state.tables.widget.push({widgetid:'local',name:'Local'});fs.writeFileSync(started.stateFile,JSON.stringify(state));
  catalog.defaults.mirage.presetMode='always';catalog.sites.fixture.mirage.presetMode='bootstrap';fs.writeFileSync(config,JSON.stringify(catalog));assert.equal((await loadConfig({config,site:'fixture'})).mirageConfig.presetMode,'bootstrap');
  const second=run('start','--site','fixture','--json');assert.equal(second.status,0,second.stdout+second.stderr);const kept=JSON.parse(second.stdout);assert.equal(kept.runtime.startupPreset.applied,false);
  assert.ok(JSON.parse(fs.readFileSync(kept.stateFile,'utf8')).tables.widget.some(row=>row.widgetid==='local'));
  const text=run('start','--site','fixture');assert.equal(text.status,0,text.stdout+text.stderr);assert.match(text.stdout,/Preset:.*tiny.*kept existing state/);
  const status=run('status');assert.equal(status.status,0,status.stdout+status.stderr);assert.match(status.stdout,/preset tiny: kept existing state/);
  const json=JSON.parse(run('status','--json').stdout);assert.equal(json.sessions.find(s=>s.pid===kept.pid).runtime.startupPreset.applied,false);
  catalog.sites.fixture.mirage.presetMode='invalid';fs.writeFileSync(config,JSON.stringify(catalog));assert.throws(()=>loadCatalogue({config}),/presetMode must be bootstrap or always/);
 }finally{
  catalog.sites.fixture.mirage.presetMode='bootstrap';fs.writeFileSync(config,JSON.stringify(catalog));const stop=run('stop','--site','fixture','--json');assert.equal(stop.status,0,stop.stdout+stop.stderr);fixture.cleanup();fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});
