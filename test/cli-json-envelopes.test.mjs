import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile,spawn} from 'node:child_process';
import http from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {createFixture} from './fixture.mjs';
import {AGENT_ACTIONS} from '../lense/commands/agent.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';

const cli=fileURLToPath(new URL('../bin/paqvilo.mjs',import.meta.url));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PAQVILO_')));
// Asynchronous so that the independent invocations of one test run concurrently.
const run=(...args)=>withProcessSlot(() => new Promise(resolve=>execFile(process.execPath,[cli,...args],{encoding:'utf8',windowsHide:true,timeout:30000,env,maxBuffer:64<<20},(error,stdout,stderr)=>
  resolve({status:error?(typeof error.code==='number'?error.code:null):0,stdout,stderr}))));

test('every bounded agent action has a documented reference section',()=>{
  const documentation=fs.readFileSync(new URL('../docs/lense.md',import.meta.url),'utf8');
  for(const action of AGENT_ACTIONS)assert.ok(documentation.includes('### agent '+action),action);
});

test('offline JSON envelopes disclose map writes, support no-write, and diagnose all lost settings in doctor',async t=>{
  const fx=createFixture();t.after(fx.cleanup);const work=fs.mkdtempSync(path.join(tmpdir(),'paqvilo-offline-envelopes-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
  const config=path.join(work,'catalogue.yml');fs.writeFileSync(config,YAML.stringify({sourceRoot:fx.dir,sites:{sample:{source:'.',environments:{local:'http://127.0.0.1:8787'}}}}));
  fx.write('sitesetting.yml','- adx_name: Webapi/a/fields\n  adx_value: a\n  adx_name: Webapi/b/fields\n  adx_value: b\n  adx_name: Webapi/c/fields\n  adx_value: c\n');
  const commands=[['map',['--no-write']],['doctor',[]],['resources',[]],['audit',[]],['list',[]],['status',[]]],limits=['0','501','x'];
  const results=await Promise.all([
    ...commands.map(([command,options])=>run('lense',command,'--config',config,'--json',...options)),
    run('lense','doctor','--config',config,'--mirage','--json'),
    ...limits.map(value=>run('lense','resources','--config',config,'--json','--limit',value)),
  ]);
  for(const [index,[command]] of commands.entries()){
    const report=JSON.parse(results[index].stdout);
    for(const key of ['schemaVersion','command','ok','offline','writesFiles','errors'])assert.ok(Object.hasOwn(report,key),command+' '+key);
    assert.ok(report.errors.every(error=>typeof error?.code==='string'&&typeof error.message==='string'),command);
    if(command==='map'){assert.deepEqual(report.writesFiles,[]);assert.ok(!fs.existsSync(path.join(work,'.paqvilo','mapping-sample-local.json')));}
    if(command==='doctor'){assert.equal(report.reports[0].sourceDiagnostics.length,2);assert.ok(report.reports[0].warnings.some(message=>message.includes('Webapi/a/fields')));}
  }
  const gated=JSON.parse(results[commands.length].stdout);assert.equal(gated.ok,false);assert.ok(gated.reports[0].errors.some(error=>error.message.includes('Webapi/a/fields')));
  const messages=results.slice(commands.length+1).map(result=>JSON.parse(result.stdout).error.message);assert.equal(new Set(messages).size,1);assert.match(messages[0],/integer from 1 to 500/);
  const written=JSON.parse((await run('lense','map','--config',config,'--json')).stdout);assert.equal(written.writesFiles.length,2);assert.ok(written.writesFiles.every(file=>fs.existsSync(file)));
});

test('CLI envelopes expose stable argument/session/strict codes and consistent nested write arrays',async t=>{
  const fx=createFixture();t.after(fx.cleanup);
  fx.write('unmapped.js','window.unmapped=true;');
  const config=fx.file('envelope-codes.json');fs.writeFileSync(config,JSON.stringify({sourceRoot:fx.dir,sites:{sample:{source:'.',environments:{local:'http://127.0.0.1:8787'}}}}));
  const cases=[
    [['resources','--limit','0'],'invalid_argument'],
    [['resources','--kind','unknown'],'invalid_argument'],
    [['resources','--width','800'],'unsupported_option'],
    [['resources','--not-a-real-option'],'unsupported_option'],
    [['doctor','unexpected'],'invalid_argument'],
    [['agent','status','--session',fx.file('missing-session.json')],'session_not_found'],
  ];
  const [strictRun,...results]=await Promise.all([run('lense','audit','--strict','--config',config,'--json'),...cases.map(([args])=>run('lense',...args,'--config',config,'--json'))]);
  for(const [index,[args,expected]] of cases.entries()){
    const result=results[index],report=JSON.parse(result.stdout);
    assert.equal(result.status,1);assert.equal(report.error.code,expected,JSON.stringify(report));assert.equal(report.errors[0].code,expected);
    if(args[0]==='agent')assert.equal(report.action,'status');
  }
  const strict=JSON.parse(strictRun.stdout);
  assert.equal(strict.ok,false);assert.ok(strict.errors.some(error=>error.code==='strict_failed'&&error.gaps>0));
  assert.ok(strict.reports.length>0);assert.ok(strict.reports.every(report=>Array.isArray(report.writesFiles)));
});

test('offline CLI distinguishes explicit unknown selectors from invalid configured defaults',async t=>{
  const fx=createFixture();t.after(fx.cleanup);
  const valid={sourceRoot:fx.dir,sites:{sample:{source:'.',environments:{local:'http://127.0.0.1:8787'}}}};
  const write=(name,catalogue)=>{const file=fx.file(name);fs.writeFileSync(file,JSON.stringify(catalogue));return file;};
  const configs={valid:write('selectors-valid.json',valid),site:write('selectors-site.json',{...valid,defaultSite:'missing'}),env:write('selectors-env.json',{...valid,sites:{sample:{...valid.sites.sample,defaultEnv:'missing'}}})};
  const cases=[];
  for(const command of ['list','map','resources']){
    cases.push([command,configs.valid,['--site','missing'],'invalid_argument'],[command,configs.valid,['--site','sample','--env','missing'],'invalid_argument']);
    cases.push([command,configs.site,[],'configuration_error'],[command,configs.env,[],'configuration_error']);
  }
  const results=await Promise.all(cases.map(([command,config,args])=>run('lense',command,'--config',config,...args,'--json')));
  for(const [index,[command,config,args,expected]] of cases.entries()){
    const result=results[index],report=JSON.parse(result.stdout),label=[command,path.basename(config),...args].join(' ');
    assert.equal(result.status,1,label);
    assert.equal(report.errors[0].code,expected,label+' '+JSON.stringify(report));
    assert.equal(report.ok,false,label);
  }
});

test('every JSON command failure has a truthful envelope and status retains comparison rows',async t=>{
  const fx=createFixture();ownedFixture(t).remove(fx.cleanup);
  const server=http.createServer((_req,res)=>res.writeHead(403).end('denied'));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  ownedFixture(t).add(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const config=fx.file('audit-contract.yml');fs.writeFileSync(config,YAML.stringify({sourceRoot:fx.dir,sites:{sample:{source:'.',environments:{local:`http://127.0.0.1:${server.address().port}`}}}}));
  const commands=['list','map','status','doctor','audit','resources','verify','mirage','agent'];
  const [invalidRun,...results]=await Promise.all([run('lense','list','--config',config,'--site','missing','--json'),...commands.map(command=>run('lense',command,'--json','--not-a-real-option'))]);
  for(const [index,command] of commands.entries()){
    const result=results[index],report=JSON.parse(result.stdout);
    assert.equal(result.status,1,command);assert.equal(report.ok,false,command);
    assert.ok(Array.isArray(report.writesFiles)&&report.errors.length>0,command);
    assert.ok(report.errors.every(error=>typeof error.code==='string'&&typeof error.message==='string'),command);
  }
  const child=spawn(process.execPath,[cli,'lense','status','--config',config,'--json'],{windowsHide:true,env});
  let output='',stderr='';child.stdout.on('data',chunk=>(output+=chunk));child.stderr.on('data',chunk=>(stderr+=chunk));
  const [code]=await once(child,'close');assert.equal(code,1,output+stderr);
  const report=JSON.parse(output);assert.equal(report.ok,false);assert.equal(report.offline,false);
  assert.ok(report.results.length>0);assert.ok(report.errors.length>0);assert.ok(!Object.hasOwn(report,'0'));
  const invalid=JSON.parse(invalidRun.stdout);assert.equal(invalid.ok,false);assert.equal(invalid.errors[0].code,'invalid_argument');
});
