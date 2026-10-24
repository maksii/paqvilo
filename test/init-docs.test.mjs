import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareProject } from '../lense/project-scaffold.mjs';

test('generated guides link correctly for single/multi/no-pack variants and agree on onboarding and validation', async t => {
  const work=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-init-guides-'));
  t.after(()=>fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  for(const [index,options]of [{},{packs:['alpha','beta'],sites:['one','two']},{noPack:true,noVscode:true}].entries()){
    const directory=path.join(work,String(index));
    const report=await prepareProject(directory,{name:'guides',...options});
    const guides=report.created.filter(name=>name.endsWith('.md'));
    assert.ok(guides.includes('README.md'),JSON.stringify(report.created));
    for(const file of guides){
      const body=await fs.readFile(path.join(directory,file),'utf8');
      assert.doesNotMatch(body,/\{\{[a-zA-Z]+\}\}/,file);
      for(const match of body.matchAll(/\]\(([^)]+)\)/g)){
        if(/^(?:https?:|#)/.test(match[1]))continue;
        const target=path.resolve(directory,path.dirname(file),match[1].split('#')[0]);
        assert.ok((await fs.stat(target)).isFile(),`${file}: ${match[1]}`);
      }
    }
    const manifest=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));
    assert.equal(manifest.scripts['check:project'],'paqvilo init --ready --config ./paqvilo.config.yml');
    assert.match(manifest.scripts['validate:configured'],/check:project.*npm test.*test:browser -- --strict/);
    assert.doesNotMatch(manifest.scripts.setup,/refresh-editor|--browser/);
    assert.doesNotMatch(manifest.scripts.dev,/--browser/);
    assert.ok(report.next.indexOf('npm run configure')>report.next.indexOf('npm run setup'));
    if(!options.noVscode)assert.ok(report.next.indexOf('npm run editor:refresh')>report.next.indexOf('npm run configure'));
    const guide=await fs.readFile(path.join(directory,'README.md'),'utf8');
    for(const phrase of ['Node **24','lockfile','ci failure','version-matched','PAC','configured','source-free','confinePortalPages'])assert.ok(guide.toLowerCase().includes(phrase.toLowerCase()),phrase);
  }
});
