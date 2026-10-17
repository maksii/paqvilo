import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {createFixture,SITE,HOME_ID} from './fixture.mjs';
import {PortalModel} from '../lense/portal-model.mjs';
import {OverlaySession} from '../lense/session.mjs';
import {buildMapping} from '../lense/commands/map.mjs';
import {describeResources,resourceFilters} from '../lense/commands/resources.mjs';
import {AGENT_ACTIONS} from '../lense/commands/agent.mjs';
import {auditResources} from '../lense/resource-audit.mjs';
import {resolveDeploymentProfiles,loadDeploymentProfiles} from '../mirage/lib/deployment-profiles.mjs';

const cli=fileURLToPath(new URL('../bin/paqvilo.mjs',import.meta.url));
const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',windowsHide:true,timeout:30000,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PAQVILO_')))});

test('every bounded agent action has a documented reference section',()=>{
  const documentation=fs.readFileSync(new URL('../docs/lense.md',import.meta.url),'utf8');
  for(const action of AGENT_ACTIONS)assert.ok(documentation.includes('### agent '+action),action);
});

test('map and resources share one thousand-record metadata parse, skip excluded fields and invalidate changed sources',async t=>{
  const fx=createFixture();t.after(fx.cleanup);
  const source=YAML.stringify(Array.from({length:1000},(_,index)=>({adx_entityformmetadataid:'field-'+index,adx_entityform:'form',adx_description:'<p>Text '+index+'</p>'})));
  fx.write('basic-forms/form/Fields.basicformmetadata.yml',source);
  const parse=YAML.parse;let count=0;
  t.mock.method(YAML,'parse',(text,...args)=>{if(text===source)count++;return parse(text,...args);});
  const session=await OverlaySession.create({sourceDir:fx.dir,site:structuredClone(SITE)});
  const mapping=buildMapping(session);assert.equal(mapping.inline.filter(row=>row.kind==='metadata-markup').length,1000);assert.equal(count,1);
  const baseline={available:false,spec:'HEAD'},changed=new Set(),started=performance.now();
  const resources=describeResources(session.cfg,session.model,baseline,changed,resourceFilters({kind:'metadata-markup',limit:10}));
  assert.equal(resources.pagination.total,1000);assert.equal(resources.resources.length,10);assert.equal(count,1,'presence checks reuse the model parse');
  const sourceFile=fx.file('basic-forms/form/Fields.basicformmetadata.yml'),read=fs.readFileSync;let reads=0;
  t.mock.method(fs,'readFileSync',(file,...args)=>{if(String(file)===sourceFile)reads++;return read(file,...args);});
  describeResources(session.cfg,session.model,baseline,changed,resourceFilters({kind:'page'}));
  assert.equal(reads,0,'a page-only query never reads markup source content');assert.equal(count,1);
  fx.write('basic-forms/form/Fields.basicformmetadata.yml',source+'\n');
  let changedParses=0;const currentParse=YAML.parse;
  t.mock.method(YAML,'parse',(text,...args)=>{if(text===source+'\n')changedParses++;return currentParse(text,...args);});
  describeResources(session.cfg,session.model,baseline,changed,resourceFilters({kind:'metadata-markup',limit:10}));
  assert.equal(changedParses,1);assert.equal(reads,1);
  describeResources(session.cfg,session.model,baseline,changed,resourceFilters({kind:'metadata-markup',limit:10}));assert.equal(changedParses,1,'unchanged stamped content is reused on the next run');
  const parseDocument=YAML.parseDocument;let auditParses=0;t.mock.method(YAML,'parseDocument',(text,...args)=>{if(text===source+'\n')auditParses++;return parseDocument(text,...args);});
  auditResources(session.model,session.cfg.site);assert.equal(auditParses,1,'independent duplicate-aware audit parses each YAML document once');
  t.diagnostic(`1000-field resources and cache checks: ${(performance.now()-started).toFixed(1)} ms`);
});

test('offline JSON envelopes disclose map writes, support no-write, and diagnose all lost settings in doctor',t=>{
  const fx=createFixture();t.after(fx.cleanup);const work=fs.mkdtempSync(path.join(tmpdir(),'paqvilo-offline-feedback-'));t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
  const config=path.join(work,'catalogue.yml');fs.writeFileSync(config,YAML.stringify({sourceRoot:fx.dir,sites:{sample:{source:'.',environments:{local:'http://127.0.0.1:8787'}}}}));
  fx.write('sitesetting.yml','- adx_name: Webapi/a/fields\n  adx_value: a\n  adx_name: Webapi/b/fields\n  adx_value: b\n  adx_name: Webapi/c/fields\n  adx_value: c\n');
  for(const [command,options]of [['map',['--no-write']],['doctor',[]],['resources',[]],['audit',[]],['list',[]],['status',[]]]){
    const result=run('lense',command,'--config',config,'--json',...options),report=JSON.parse(result.stdout);
    for(const key of ['schemaVersion','command','ok','offline','writesFiles','errors'])assert.ok(Object.hasOwn(report,key),command+' '+key);
    assert.ok(report.errors.every(error=>error&&typeof error==='object'));
    if(command==='map'){assert.deepEqual(report.writesFiles,[]);assert.ok(!fs.existsSync(path.join(work,'.paqvilo','mapping-sample-local.json')));}
    if(command==='doctor'){assert.equal(report.reports[0].sourceDiagnostics.length,2);assert.ok(report.reports[0].warnings.some(message=>message.includes('Webapi/a/fields')));}
  }
  const gated=JSON.parse(run('lense','doctor','--config',config,'--mirage','--json').stdout);assert.equal(gated.ok,false);assert.ok(gated.reports[0].errors.some(error=>error.message.includes('Webapi/a/fields')));
  const written=JSON.parse(run('lense','map','--config',config,'--json').stdout);assert.equal(written.writesFiles.length,2);assert.ok(written.writesFiles.every(file=>fs.existsSync(file)));
  const messages=['0','501','x'].map(value=>JSON.parse(run('lense','resources','--config',config,'--json','--limit',value).stdout).error.message);assert.equal(new Set(messages).size,1);assert.match(messages[0],/integer from 1 to 500/);
});

test('doctor JSON normalizes nested Mirage errors and aggregates only opted-in gating failures',t=>{
  const fx=createFixture();t.after(fx.cleanup);
  const config=fx.file('audit-doctor-catalogue.yml');
  fs.writeFileSync(config,YAML.stringify({sourceRoot:fx.dir,sites:{sample:{source:'.',environments:{local:'http://127.0.0.1:8787'},mirage:{project:'missing-project.yml'}}}}));
  const optional=JSON.parse(run('lense','doctor','--config',config,'--json').stdout);
  assert.equal(optional.ok,true);assert.deepEqual(optional.errors,[]);
  assert.ok(optional.reports[0].mirage.errors.some(error=>error.message.includes('missing-project.yml')));
  const gated=JSON.parse(run('lense','doctor','--config',config,'--mirage','--json').stdout);
  assert.equal(gated.ok,false);
  assert.ok(gated.errors.some(error=>error.message.includes('missing-project.yml')));
  assert.ok(gated.reports[0].mirage.errors.every(error=>typeof error.code==='string'&&typeof error.message==='string'));
});

test('CLI envelopes expose stable argument/session/strict codes and consistent nested write arrays',t=>{
  const fx=createFixture();t.after(fx.cleanup);
  fx.write('unmapped.js','window.unmapped=true;');
  const config=fx.file('feedback-codes.json');fs.writeFileSync(config,JSON.stringify({sourceRoot:fx.dir,sites:{sample:{source:'.',environments:{local:'http://127.0.0.1:8787'}}}}));
  for(const [args,expected] of [
    [['resources','--limit','0'],'invalid_argument'],
    [['resources','--kind','unknown'],'invalid_argument'],
    [['resources','--width','800'],'unsupported_option'],
    [['resources','--not-a-real-option'],'unsupported_option'],
    [['doctor','unexpected'],'invalid_argument'],
    [['agent','status','--session',fx.file('missing-session.json')],'session_not_found'],
  ]){
    const result=run('lense',...args,'--config',config,'--json'),report=JSON.parse(result.stdout);
    assert.equal(result.status,1);assert.equal(report.error.code,expected,JSON.stringify(report));assert.equal(report.errors[0].code,expected);
    if(args[0]==='agent')assert.equal(report.action,'status');
  }
  const strict=JSON.parse(run('lense','audit','--strict','--config',config,'--json').stdout);
  assert.equal(strict.ok,false);assert.ok(strict.errors.some(error=>error.code==='strict_failed'&&error.gaps>0));
  assert.ok(strict.reports.every(report=>Array.isArray(report.writesFiles)));
});

test('offline CLI distinguishes explicit unknown selectors from invalid configured defaults',t=>{
  const fx=createFixture();t.after(fx.cleanup);
  const valid={sourceRoot:fx.dir,sites:{sample:{source:'.',environments:{local:'http://127.0.0.1:8787'}}}};
  const config=fx.file('feedback-selectors.json');
  const check=(command,args,expected)=>{
    const result=run('lense',command,'--config',config,...args,'--json'),report=JSON.parse(result.stdout);
    assert.equal(result.status,1,command+' '+args.join(' '));
    assert.equal(report.errors[0].code,expected,JSON.stringify(report));
    assert.equal(report.ok,false);
  };
  fs.writeFileSync(config,JSON.stringify(valid));
  for(const command of ['list','map','resources']){
    check(command,['--site','missing'],'invalid_argument');
    check(command,['--site','sample','--env','missing'],'invalid_argument');
  }
  for(const broken of [{...valid,defaultSite:'missing'},{...valid,sites:{sample:{...valid.sites.sample,defaultEnv:'missing'}}}]){
    fs.writeFileSync(config,JSON.stringify(broken));
    for(const command of ['list','map','resources'])check(command,[],'configuration_error');
  }
});

test('deployment-profile diagnostics use forward slashes for project-relative paths',async t=>{
  const fx=createFixture();t.after(fx.cleanup);fx.write('profiles/external.json',JSON.stringify({ConnectionReferences:[{LogicalName:'sample_api',ConnectionId:'',ConnectorId:'/connectors/sample'}]}));
  const config=resolveDeploymentProfiles({default:'dev',profiles:{dev:{connectionReferences:'profiles/external.json'}}},fx.dir);
  const active=await loadDeploymentProfiles(config);
  assert.deepEqual(active.diagnostics[0].files,['profiles/external.json']);assert.doesNotMatch(JSON.stringify(active.diagnostics),/\\\\/);
});

test('duplicate active page URLs warn once and inactive single-extension web files stay inactive in dotted source roots',t=>{
  const fx=createFixture();t.after(fx.cleanup);
  for(const id of ['a','b'])fx.write(`web-pages/${id}/${id}.webpage.yml`,`adx_webpageid: ${id}\nadx_name: Page ${id}\nadx_partialurl: same\nadx_parentpageid: ${HOME_ID}`);
  let model=new PortalModel(fx.dir);assert.equal(model.warnings.filter(message=>message.includes('duplicate page URL')).length,1);
  fx.write('web-pages/b/b.webpage.yml',fx.read('web-pages/b/b.webpage.yml')+'\nadx_statecode: 1');model=new PortalModel(fx.dir);assert.equal(model.warnings.filter(message=>message.includes('duplicate page URL')).length,0);
  const root=fs.mkdtempSync(path.join(tmpdir(),'paqvilo.inactive.feedback.'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'web-files'));fs.mkdirSync(path.join(root,'web-pages'));
  fs.writeFileSync(path.join(root,'website.yml'),'adx_websiteid: site\nadx_name: Invented');fs.writeFileSync(path.join(root,'web-pages/Home.webpage.yml'),'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /');
  fs.writeFileSync(path.join(root,'web-files/a.css'),'body{}');fs.writeFileSync(path.join(root,'web-files/a.css.webfile.yml'),'adx_webfileid: css\nadx_name: a.css\nadx_partialurl: a.css\nadx_parentpageid: home\nstatecode: 1');
  const config=path.join(root,'catalogue.yml');fs.writeFileSync(config,YAML.stringify({sourceRoot:root,sites:{sample:{source:'.',environments:{local:'http://127.0.0.1:8787'}}}}));
  const result=run('lense','audit','--strict','--json','--config',config),report=JSON.parse(result.stdout);assert.equal(result.status,0,JSON.stringify(report));assert.equal(report.reports[0].resources.find(row=>row.relativePath==='web-files/a.css').status,'inactive');
});

test('enhanced optional fields expose presence and language-root rendering separately',t=>{
  const root=fs.mkdtempSync(path.join(tmpdir(),'paqvilo-fields-feedback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const put=(id,type,content)=>{const dir=path.join(root,'powerpagecomponents',id);fs.mkdirSync(dir,{recursive:true});const json=JSON.stringify(content).replaceAll('&','&amp;').replaceAll('<','&lt;');fs.writeFileSync(path.join(dir,'powerpagecomponent.xml'),`<powerpagecomponent powerpagecomponentid="${id}"><name>${id}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><content>${json}</content></powerpagecomponent>`);};
  put('root',2,{isroot:true,partialurl:'/'});put('language',2,{isroot:false,rootwebpageid:'root',partialurl:'/',copy:'<p>Localized</p>'});put('form',15,{});
  const model=new PortalModel(root),report=describeResources({sourceDir:root,site:SITE},model,{available:false,spec:'HEAD'},new Set(),resourceFilters({limit:500}));
  const rootCopy=report.resources.find(row=>row.relativePath?.includes('/root/')&&row.field==='copy'),formScript=report.resources.find(row=>row.relativePath?.includes('/form/')&&row.field==='customjavascript');
  assert.equal(rootCopy.exists,false);assert.equal(rootCopy.renders,false);assert.equal(formScript.exists,false);assert.equal(formScript.preview.eligible,false);
  assert.equal(report.resources.find(row=>row.relativePath?.includes('/language/')&&row.field==='copy').empty,false,'enhanced XML fields keep their component extractor');
});

test('every JSON command failure has a truthful envelope and status retains comparison rows',async t=>{
  const fx=createFixture();t.after(fx.cleanup);
  const server=http.createServer((_req,res)=>res.writeHead(403).end('denied'));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const config=fx.file('audit-contract.yml');fs.writeFileSync(config,YAML.stringify({sourceRoot:fx.dir,sites:{sample:{source:'.',environments:{local:`http://127.0.0.1:${server.address().port}`}}}}));
  for(const command of ['list','map','status','doctor','audit','resources','verify','mirage','agent']){
    const result=run('lense',command,'--json','--not-a-real-option'),report=JSON.parse(result.stdout);
    assert.equal(result.status,1,command);assert.equal(report.ok,false,command);
    assert.ok(Array.isArray(report.writesFiles)&&Array.isArray(report.errors),command);
    assert.ok(report.errors.every(error=>typeof error.code==='string'&&typeof error.message==='string'),command);
  }
  const child=spawn(process.execPath,[cli,'lense','status','--config',config,'--json'],{windowsHide:true,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PAQVILO_')))});
  let output='',stderr='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const [code]=await once(child,'close');assert.equal(code,1,output+stderr);
  const report=JSON.parse(output);assert.equal(report.ok,false);assert.equal(report.offline,false);
  assert.ok(report.results.length>0);assert.ok(report.errors.length>0);assert.ok(!Object.hasOwn(report,'0'));
  const invalid=JSON.parse(run('lense','list','--config',config,'--site','missing','--json').stdout);assert.equal(invalid.ok,false);assert.ok(invalid.errors.length>0);
});
