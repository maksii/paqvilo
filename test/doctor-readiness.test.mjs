import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {createFixture} from './fixture.mjs';
import {resolveDeploymentProfiles,loadDeploymentProfiles} from '../mirage/lib/deployment-profiles.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';

const cli=fileURLToPath(new URL('../bin/paqvilo.mjs',import.meta.url));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PAQVILO_')));
// Asynchronous so that the independent invocations of one test run concurrently.
const doctor=(cwd,...args)=>withProcessSlot(() => new Promise(resolve=>execFile(process.execPath,[cli,'lense','doctor',...args],{cwd,env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:64<<20},(error,stdout,stderr)=>
  resolve({status:error?(typeof error.code==='number'?error.code:null):0,stdout,stderr}))));

test('export-wide profile lint warns on an unbound profile and binding it fails readiness',async t=>{
  const fx=createFixture();t.after(fx.cleanup);
  fx.write('deployment-profiles/valid.yml','adx_contentsnippet: []\n');
  fx.write('deployment-profiles/unused.yml','adx_contentsnippet: []\nadx_contentsnippet: []\nprivate: never-echo-this\n');
  const catalogue=(name,mirage)=>{const file=fx.file(name);fs.writeFileSync(file,JSON.stringify({sourceRoot:fx.dir,sites:{invented:{source:'.',environments:{local:'http://127.0.0.1:8787'},mirage:{port:0,...mirage}}}}));return file;};
  const bound=profile=>catalogue(`profile-lint-${profile}.json`,{solutionRoots:[],deploymentProfiles:{default:'dev',profiles:{dev:{pages:{source:`deployment-profiles/${profile}.yml`}}}}});
  const project=fx.file('project.json');
  fs.writeFileSync(project,JSON.stringify({version:2,portals:[{id:'invented',path:'.',deploymentProfiles:{default:'dev',profiles:{dev:{pages:'deployment-profiles/valid.yml'},other:{pages:'deployment-profiles/unused.yml'}}}}],solutions:[]}));
  const lint=config=>doctor(fx.dir,'--config',config,'--mirage','--lint-profiles','--json');
  const [valid,invalid,projectResult]=await Promise.all([lint(bound('valid')),lint(bound('unused')),lint(catalogue('profile-lint-project.json',{project}))]);
  assert.equal(valid.status,0,valid.stdout+valid.stderr);
  const report=JSON.parse(valid.stdout),diagnostic=report.reports[0].profileDiagnostics[0];
  assert.deepEqual([diagnostic.file,diagnostic.code,diagnostic.line,diagnostic.column,diagnostic.bound],['deployment-profiles/unused.yml','DUPLICATE_KEY',2,1,false]);
  assert.doesNotMatch(valid.stdout,/never-echo-this/);
  assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stdout).reports[0].mirage.ready,false);
  assert.equal(JSON.parse(invalid.stdout).reports[0].profileDiagnostics[0].bound,true);
  assert.doesNotMatch(invalid.stdout,/never-echo-this/);
  assert.equal(projectResult.status,0,projectResult.stdout+projectResult.stderr);
  assert.equal(JSON.parse(projectResult.stdout).reports[0].profileDiagnostics[0].bound,true,'project-owned mappings count as bound');
});

test('duplicate source keys gate Sources independently of Lense readiness',async t=>{
  const fx=createFixture();t.after(fx.cleanup);
  fx.write('sitesetting.yml','- adx_name: Before\n  adx_value: one\n  adx_name: After\n  adx_value: two\n');
  const config=fx.file('sources-readiness.json');fs.writeFileSync(config,JSON.stringify({sourceRoot:fx.dir,sites:{invented:{source:'.',environments:{local:'http://127.0.0.1:8787'},mirage:{port:0,solutionRoots:[]}}}}));
  const run=(...args)=>doctor(fx.dir,'--config',config,...args);
  const [json,gatedJson,text,gatedText,unknown]=await Promise.all([run('--json'),run('--mirage','--json'),run(),run('--mirage'),run('--site','nosuch','--json')]);
  for(const [result,gated] of [[json,false],[gatedJson,true]]){
    const report=JSON.parse(result.stdout),site=report.reports[0];
    assert.equal(site.lenseReady,true);assert.equal(site.sourcesReady,false);assert.equal(report.ok,!gated);assert.equal(result.status,gated?1:0);
    if(gated){assert.ok(report.checks.includes('sources'));assert.ok(report.errors.some(error=>error.message.startsWith('Sources:')));assert.equal(report.errors[0].code,'check_failed');}
  }
  for(const result of [text,gatedText]){assert.match(result.stdout,/Lense ready · Sources NOT READY/);assert.doesNotMatch(result.stdout,/Lense NOT READY/);}
  const answer=JSON.parse(unknown.stdout);
  assert.equal(unknown.status,1);assert.equal(answer.errors[0].code,'invalid_argument');assert.match(answer.errors[0].message,/nosuch.*invented/);
});

test('doctor JSON normalizes nested Mirage errors and aggregates only opted-in gating failures',async t=>{
  const fx=createFixture();t.after(fx.cleanup);
  const config=fx.file('mirage-doctor-catalogue.yml');
  fs.writeFileSync(config,YAML.stringify({sourceRoot:fx.dir,sites:{sample:{source:'.',environments:{local:'http://127.0.0.1:8787'},mirage:{project:'missing-project.yml'}}}}));
  const [optionalRun,gatedRun]=await Promise.all([doctor(fx.dir,'--config',config,'--json'),doctor(fx.dir,'--config',config,'--mirage','--json')]);
  const optional=JSON.parse(optionalRun.stdout);
  assert.equal(optional.ok,true);assert.deepEqual(optional.errors,[]);
  assert.ok(optional.reports[0].mirage.errors.some(error=>error.message.includes('missing-project.yml')));
  const gated=JSON.parse(gatedRun.stdout);
  assert.equal(gated.ok,false);
  assert.ok(gated.errors.some(error=>error.message.includes('missing-project.yml')));
  assert.ok(gated.reports[0].mirage.errors.every(error=>typeof error.code==='string'&&typeof error.message==='string'));
});

test('deployment-profile diagnostics use forward slashes for project-relative paths',async t=>{
  const fx=createFixture();t.after(fx.cleanup);fx.write('profiles/external.json',JSON.stringify({ConnectionReferences:[{LogicalName:'sample_api',ConnectionId:'',ConnectorId:'/connectors/sample'}]}));
  const config=resolveDeploymentProfiles({default:'dev',profiles:{dev:{connectionReferences:'profiles/external.json'}}},fx.dir);
  const active=await loadDeploymentProfiles(config);
  assert.deepEqual(active.diagnostics[0].files,['profiles/external.json']);assert.doesNotMatch(JSON.stringify(active.diagnostics),/\\\\/);
});
