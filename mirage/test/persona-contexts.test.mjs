import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createPersonaContexts } from '../lib/persona-contexts.mjs';
import { personaContextSettings } from '../lib/persona-context-settings.mjs';
import { loadConfig } from '../../lense/config.mjs';
import os from 'node:os';
import path from 'node:path';

test('context launches serialize duplicate starts, fingerprint definitions and clean failed snapshots', async()=>{
  let starts=0;const directories=[],closed=[];
  const manager=createPersonaContexts({maxInstances:2,snapshot:async file=>{directories.push(path.dirname(file));await fs.writeFile(file,'fixture');},start:async({definition})=>{
    if(definition.id==='broken')throw Error('Synthetic start failure');
    starts++;return {url:'http://127.0.0.1:'+starts,close:async()=>closed.push(starts)};
  }});
  try{
    await assert.rejects(manager.open({id:'broken',label:'Broken'}),/Synthetic start failure/);assert.equal(manager.list().items.length,0);await assert.rejects(fs.stat(directories[0]));
    const [first,second]=await Promise.all([manager.open({id:'one',label:'One'}),manager.open({id:'one',label:'One'})]);assert.equal(starts,1);assert.equal(first.id,second.id);assert.equal(second.created,false);
    assert.ok(directories.every(directory=>directory.startsWith(path.join(process.cwd(),'.paqvilo','persona-runtimes')+path.sep)));
    const scenario=await manager.open({id:'one',label:'One'},{scenario:'another-start-page'});assert.equal(scenario.id,first.id);assert.equal(starts,1);
    const updated=await manager.open({id:'one',label:'Updated'});assert.notEqual(updated.id,first.id);
    await assert.rejects(manager.open({id:'three',label:'Three'}),e=>e.code==='PersonaContextLimit');
    await manager.stop(first.id);assert.equal(manager.list().items.length,1);
    await assert.rejects(manager.open({id:'one',label:'One'},{instanceKey:'../escape'}),/instanceKey/);
  }finally{await manager.close();}
  for(const directory of directories)await assert.rejects(fs.stat(directory));assert.equal(closed.length,2);
  await assert.rejects(manager.open({id:'one',label:'One'}),/closed/);
});

test('catalogue/default context limits are validated and resolved for CLI runtimes',async t=>{
  for(const value of [null,[],{unknown:1},{maxInstances:-1},{maxInstances:1.5},{maxInstances:33}])assert.throws(()=>personaContextSettings(value),/personaContexts/);
  assert.deepEqual(personaContextSettings({maxInstances:0}),{maxInstances:0});
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'persona-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'paqvilo.config.yml');await fs.writeFile(file,`defaults:\n  mirage:\n    personaContexts:\n      maxInstances: 2\nsites:\n  demo:\n    source: portal\n    environments:\n      dev: https://example.test\n`);
  const cfg=await loadConfig({config:file,site:'demo'}, {}, {checkSource:false});assert.deepEqual(cfg.mirageConfig.personaContexts,{maxInstances:2});
  await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace('maxInstances: 2','maxInstances: -1'));await assert.rejects(loadConfig({config:file,site:'demo'}, {}, {checkSource:false}),/maxInstances/);
});
