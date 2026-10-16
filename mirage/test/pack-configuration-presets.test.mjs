import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSimulator} from '../server.mjs';
import {configurationPresetReport} from '../lib/experiment-presets.mjs';
import {fixture,initial} from './fixtures/platform-experiments.mjs';

test('pack configuration presets are validated, traceable, immutable and opt-in with a dataset',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'mirage-pack-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fixture(root);
  const pack={id:'synthetic',name:'Synthetic',description:'Invented pack',matches:()=>true,presets:()=>({sample:{name:'Sample',tables:{item:[]},configurationPreset:'synthetic-enabled'}}),configurationPresets:[
    {id:'synthetic-enabled',name:'Enabled',description:'Enables an invented feature',portalOverrides:{settings:{'Feature/Example':'True'},snippets:{Greeting:'Pack greeting'}}},
    {id:'synthetic-disabled',name:'Disabled',platformOverrides:{QueryLinkEntityLimit:30}},
    {id:'synthetic-invalid',name:'Invalid',portalOverrides:{snippets:{Greeting:{invalid:true}}}},
  ]};
  const validation=configurationPresetReport([pack]);assert.equal(validation.presets.length,2);assert.match(validation.diagnostics[0].message,/synthetic.*\[2\].*string/);
  const app=await createSimulator({sourceDir:root,initial:initial(),watch:false,packs:[pack]});t.after(()=>app.close());
  const csrf=(await fetch(app.url+'/__sim/api/state?summary=1').then(r=>r.json())).csrf;
  const call=async(path,body={},method='POST')=>{const response=await fetch(app.url+'/__sim/api'+path,{method,headers:{'content-type':'application/json','x-sim-csrf':csrf},body:JSON.stringify(body)});const result=await response.json();return {status:response.status,result};};
  const listed=await fetch(app.url+'/__sim/api/experiments').then(r=>r.json());assert.equal(listed.filter(p=>p.source==='synthetic').length,2);assert.ok(listed.find(p=>p.id==='synthetic-enabled').readOnly);
  assert.equal((await call('/experiments',{id:'synthetic-enabled',name:'Collision'})).status,409);
  assert.equal((await call('/experiments/synthetic-enabled',{},'DELETE')).status,403);
  assert.equal((await call('/presets/sample/apply')).status,200);assert.match(await fetch(app.url).then(r=>r.text()),/Source greeting/);
  assert.equal((await call('/presets/sample/apply',{applyConfiguration:true})).status,200);assert.match(await fetch(app.url).then(r=>r.text()),/Pack greeting/);
  const status=await fetch(app.url+'/__sim/api/status').then(r=>r.json());assert.equal(status.activeConfigurationPreset.id,'synthetic-enabled');assert.equal(status.activeConfigurationPreset.source,'synthetic');assert.match(status.activeConfigurationPreset.digest,/^[a-f0-9]{64}$/);
  await fetch(app.url+'/_api/items');const audit=await fetch(app.url+'/__sim/api/audit/export').then(r=>r.json());assert.ok(audit.items.some(row=>row.activeConfigurationPreset?.id==='synthetic-enabled'));
  assert.equal((await call('/experiments/source-defaults/apply')).status,200);assert.match(await fetch(app.url).then(r=>r.text()),/Source greeting/);
  assert.ok((await fetch(app.url+'/__sim/api/diagnostics').then(r=>r.json())).diagnostics.some(row=>row.code==='PACK_CONFIGURATION_PRESET_INVALID'));
});
