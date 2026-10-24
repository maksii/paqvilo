import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { prepareProject } from '../lense/project-scaffold.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';

const toolkit=fileURLToPath(new URL('../',import.meta.url));
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PAQVILO_')&&key!=='NODE_TEST_CONTEXT'));
async function project(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'init-acceptance-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await prepareProject(root,{name:'acceptance-fixture',noVscode:true,...options});
  await fs.mkdir(path.join(root,'node_modules'));
  await fs.symlink(toolkit,path.join(root,'node_modules/paqvilo'),process.platform==='win32'?'junction':'dir');
  return root;
}
async function run(root,args=['tools/test-browser.mjs'],timeout=60000){
  return withProcessSlot(async () => {
  const child=spawn(process.execPath,args,{cwd:root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const timer=setTimeout(()=>child.kill(),timeout);
  try{return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,output}));});}
  finally{clearTimeout(timer);}
  });
}
async function fixture(root,site='portal'){
  const directory=path.join(root,'test-browser/fixtures',site);
  await fs.mkdir(path.join(directory,'web-pages'),{recursive:true});
  await fs.writeFile(path.join(directory,'website.yml'),'adx_websiteid: fixture\nadx_name: Synthetic');
  await fs.writeFile(path.join(directory,'Home.webpage.yml'),'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /');
  await fs.writeFile(path.join(directory,'Home.webpage.copy.html'),'<h1>Owned fixture content</h1>');
}

test('untouched source-free pack tests and smoke remain lightweight; strict requires declared executed cases',async t=>{
  const root=await project(t);
  const [unit,starter,strict]=await Promise.all([run(root,['--test','pack/test/pack.test.mjs']),run(root),run(root,['tools/test-browser.mjs','--strict'])]);
  assert.equal(unit.code,0,unit.output);
  assert.equal(starter.code,0,starter.output);
  assert.equal(strict.code,1,strict.output);assert.match(strict.output,/Missing: portal/);
  await fixture(root);
  const [smoke,smokeStrict]=await Promise.all([run(root),run(root,['tools/test-browser.mjs','--strict'])]);
  assert.equal(smoke.code,0,smoke.output);
  assert.equal(smokeStrict.code,1,'HTTP 200 does not count as meaningful acceptance');assert.match(smokeStrict.output,/Missing: portal/);
  assert.deepEqual((await fs.readdir(path.join(root,'test-browser/fixtures/portal'))).sort(),['.gitkeep','Home.webpage.copy.html','Home.webpage.yml','website.yml','web-pages'].sort(),'smoke state stays outside fixture sources');
});

test('strict reporter counts structured successful site cases and rejects skips, TODOs, filters and current-catalogue drift',async t=>{
  const declared=root=>path.join(root,'test-browser/declared.test.mjs'),root=await project(t,{noPack:true}),file=declared(root);
  const body=options=>`import assert from 'node:assert/strict'; import {acceptanceTest} from '../support/site.mjs'; acceptanceTest('portal','synthetic assertion',()=>assert.equal(2+2,4),${options});`;
  const unexecuted=Promise.all(['{skip:true}','{todo:true}'].map(async options=>{
    const other=await project(t,{noPack:true});await fs.writeFile(declared(other),body(options));
    return [options,await run(other,['tools/test-browser.mjs','--strict'])];
  }));
  await fs.writeFile(file,body('{}'));
  const initial=await Promise.all([run(root,['tools/test-browser.mjs','--strict']),run(root,['tools/test-browser.mjs','--strict','--test-name-pattern=unmatched-case'])]);
  let result=initial[0]; const filtered=initial[1];
  assert.equal(result.code,0,result.output);assert.equal(filtered.code,1,filtered.output);
  for(const [options,skipped] of await unexecuted){assert.equal(skipped.code,1,options+skipped.output);assert.match(skipped.output,/Missing: portal/,options);}
  // Effective personal catalogue changes must join the gate without regeneration.
  await fs.writeFile(path.join(root,'paqvilo.config.local.yml'),YAML.stringify({sites:{extra:{source:'missing',environments:{local:'http://127.0.0.1:1'}}}}));
  result=await run(root,['tools/test-browser.mjs','--strict']);assert.equal(result.code,1,result.output);assert.match(result.output,/Missing: extra/);
  await fs.appendFile(file,"\nacceptanceTest('extra','second owned assertion',()=>assert.ok('content'.includes('tent')));\n");
  const [both,tap]=await Promise.all([run(root,['tools/test-browser.mjs','--strict']),run(root,['tools/test-browser.mjs','--strict','--test-reporter=tap'])]);
  assert.equal(both.code,0,both.output);
  assert.notEqual(tap.code,0);assert.match(tap.output,/owns the test reporter/);
  await fs.rm(file);await fs.rm(path.join(root,'test-browser/smoke.test.mjs'));
  const [empty,emptyStrict]=await Promise.all([run(root),run(root,['tools/test-browser.mjs','--strict'])]);
  assert.equal(empty.code,0,'empty discovery remains valid for starter checks');
  assert.equal(emptyStrict.code,1,'empty discovery cannot pass strict');
});

test('a malformed nonempty fixture fails rather than silently skipping in lightweight or strict validation',async t=>{
  const root=await project(t,{noPack:true});
  await fs.writeFile(path.join(root,'test-browser/fixtures/portal/website.yml'),'adx_websiteid: [broken');
  for(const result of await Promise.all([[],['--strict']].map(args=>run(root,['tools/test-browser.mjs',...args])))){assert.notEqual(result.code,0,result.output);assert.match(result.output,/fail 1|failed|malformed|parse/i);}
});

test('site-bound recipe applies distinct platform and deployment defaults and attaches intended configured or dynamic origins',async t=>{
  const root=await project(t,{noPack:true});
  const config=path.join(root,'synthetic.config.yml'),sites={};
  for(const [index,site]of ['alpha','beta'].entries()){
    await fixture(root,site);
    const source=path.join(root,'test-browser/fixtures',site);
    await fs.writeFile(path.join(source,'Home.webpage.copy.html'),'<h1>{{ snippets.Greeting }}</h1>');
    await fs.writeFile(path.join(source,'Greeting.contentsnippet.yml'),'adx_contentsnippetid: greeting\nadx_name: Greeting\nadx_value: Exported');
    await fs.writeFile(path.join(root,`${site}.json`),JSON.stringify({adx_contentsnippet:[{adx_contentsnippetid:'greeting',adx_value:`${site} profile content`}]}));
    sites[site]={source:path.relative(root,source),defaultEnv:'local',environments:{local:'http://127.0.0.1:1'},mirage:{port:0,solutionRoots:[],platform:{QueryLinkEntityLimit:8+index,evidence:'Invented test configuration; no hosted behavior claimed'},confinePortalPages:index===0,deploymentProfiles:{default:'local',profiles:{local:{pages:`${site}.json`}}}}};
  }
  await fs.writeFile(config,YAML.stringify({sourceRoot:'.',defaultSite:'alpha',sites}));
  const {siteMirage,attachSite}=await import(pathToFileURL(path.join(root,'support/site.mjs')));
  const apps=[];t.after(async()=>{for(const app of apps)await app.close();});
  for(const [index,site]of ['alpha','beta'].entries()){
    const context=await siteMirage(site,{config:pathToFileURL(config)});
    const app=await context.createSimulator({stateFile:path.join(root,`${site}-state.json`),port:0,watch:false});apps.push(app);
    assert.match(await(await fetch(app.url)).text(),new RegExp(`${site} profile content`));
    assert.equal(app.state().config.confinePortalPages,index===0);
    const attached=await attachSite(site,{config:pathToFileURL(config),origin:app.url});
    assert.equal(attached.origin,app.url);assert.equal((await attached.platformSettings()).find(row=>row.key==='QueryLinkEntityLimit').value,8+index);
    sites[site].mirage.port=Number(new URL(app.url).port);
  }
  await fs.writeFile(config,YAML.stringify({sourceRoot:'.',defaultSite:'alpha',sites}));
  await assert.rejects(attachSite('alpha',{config:pathToFileURL(config),origin:apps[1].url}),/does not match the selected catalogue site/);
  await assert.rejects(attachSite('unknown',{config:pathToFileURL(config),origin:apps[0].url}),/configured site/);
  for(const [index,site]of ['alpha','beta'].entries()){
    const attached=await attachSite(site,{config:pathToFileURL(config)});
    assert.equal(attached.origin,apps[index].url);assert.equal(typeof attached.close,'undefined','attachment cannot stop caller-owned runtime');
    assert.match(await(await fetch(apps[index].url)).text(),new RegExp(`${site} profile content`));
  }
});
