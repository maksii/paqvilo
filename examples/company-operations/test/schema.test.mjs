import test from 'node:test';
import assert from 'node:assert/strict';
import { readManifest,compileManifest } from 'paqvilo/dataverse';

test('company manifest has complete schema inventory and protected role anchors',async()=>{
  const manifest=await readManifest(new URL('../dataverse/manifest.json',import.meta.url));
  assert.equal(manifest.tables.length,27);
  assert.equal(manifest.tables.filter(t=>!t.existing).length,24);
  assert.equal(manifest.choices.length,26);
  assert.equal(manifest.relationships.length,71);
  assert.equal(manifest.tables.reduce((n,t)=>n+t.keys.length,0),27);
  assert.equal(manifest.relationships.filter(r=>r.kind==='oneToMany'&&r.child==='pqvd_accesspermission'&&r.lookup.name.endsWith('principalid')).length,12);
  assert.equal(manifest.tables.find(t=>t.name==='pqvd_employmentterms').entitySetName,'pqvd_employmenttermrecords');
  assert.equal(manifest.tables.find(t=>t.name==='pqvd_chainnode').ownership,'user');
  assert.ok(manifest.relationships.filter(r=>r.kind==='oneToMany').every(r=>r.cascade.Delete==='Restrict'));
  const nullable=manifest.relationships.filter(r=>r.child==='pqvd_testoperation'&&['pqvd_runid','pqvd_runnercontactid'].includes(r.lookup.name));
  assert.ok(nullable.every(r=>r.lookup.required==='none'));
});

test('deep path and later extensions keep their declared solution ownership',async()=>{
  const manifest=await readManifest(new URL('../dataverse/manifest.json',import.meta.url));
  const chain=['pqvd_accesspermission','account','pqvd_orgcontact','pqvd_employment','pqvd_assignment','pqvd_servicerequest','pqvd_workorder','pqvd_worktask','pqvd_checklistitem','pqvd_inspection','pqvd_finding'];
  for(let i=1;i<chain.length;i++) assert.ok(manifest.relationships.some(r=>r.parent===chain[i-1]&&r.child===chain[i]));
  const plan=compileManifest(manifest);
  const trigger=plan.actions.find(a=>a.key==='column:pqvd_crudprobe.pqvd_triggernonce');
  assert.equal(trigger.solution,'PaqviloBehaviorPlugins');
  assert.equal(plan.actions.find(a=>a.key==='relationship:pqvd_testoperation_results').solution,'PaqviloBehaviorPlugins');
  const canary=manifest.relationships.find(r=>r.name==='pqvd_testrun_canaryequipments');
  assert.equal(canary.solution,'PaqviloBehaviorPlugins');
  assert.equal(canary.lookup.required,'none');
  const names=plan.actions.map(a=>a.key);assert.equal(names.length,new Set(names).size);
  assert.ok(plan.actions.filter(a=>a.kind==='key').every(a=>a.solution));
  assert.ok(manifest.scope.remaining.includes('Named forms/views'));
});
