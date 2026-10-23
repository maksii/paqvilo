import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const ID = '11111111-1111-4111-8111-111111111111';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await fn()) return; await pause(50); }
  assert.fail('Authored solution metadata did not reload.');
}
for (const level of [null, 'simulation']) test(`standalone watcher ignores runtime/build/DATA outputs and reloads authored XML (${level ?? 'legacy'})`, { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-source-watch-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedWatch</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml': '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><LocalizedNames><LocalizedName description="Before" languagecode="1033"/></LocalizedNames><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
    'pack/data.json': JSON.stringify({ records: [{ x_itemid: ID, x_name: 'Before' }] }),
    'pack/pack.mjs': "export default {id:'invented-watch',name:'Invented watch',description:'Invented watcher fixture',matches:()=>true,presets:()=>({}),dataFiles:[{file:'data.json',tables:{x_item:{path:['records'],idColumn:'x_itemid'}}}]};",
  };
  for (const [relative, content] of Object.entries(files)) { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  const sim = await createSimulator({ projectRoot: root, solutionRoots: [root], runtime: { kind: 'model-driven' },
    // Windows watcher events can retain the on-disk casing while CLI paths differ.
    stateFile: path.join(root, level ? process.platform === 'win32' ? 'OTHER' : 'Other' : '.paqvilo', 'state.json'), packs: [path.join(root, 'pack', 'pack.mjs')],
    initial: { tables: { x_item: [{ x_itemid: ID, x_name: 'Before' }] } },
    ...(level ? { simulation: { level } } : {}), watch: true });
  ownedFixture(t).add(() => sim.close());
  // The root itself is a selected Solution. Runtime checkpoint/cache and pack DATA
  // therefore sit below the watch root and must not be mistaken for authored XML.
  await pause(300);
  await sim.store.update('x_item', ID, { x_name: 'Saved record' }, { admin: true });
  const revision = sim.store.revision;
  for (const relative of ['bin/generated.xml', 'obj/compiled.json', 'Entities/x_item/bin/build.xml']) {
    const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '<generated/>');
  }
  await pause(700);
  assert.equal(sim.store.revision, revision, 'Runtime outputs must not cause source reload/save loops.');
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Saved record');
  const entityFile = path.join(root, 'Entities/x_item/Entity.xml');
  await fs.writeFile(entityFile, files['Entities/x_item/Entity.xml'].replace('description="Before"', 'description="After source edit"'));
  await eventually(async () => {
    const response = await fetch(sim.url + '/_apps/api');
    return (await response.json()).tables.x_item.singular === 'After source edit';
  });
  const reloaded = sim.store.revision;
  await pause(700);
  assert.equal(sim.store.revision, reloaded, 'The reload checkpoint must not trigger another reload.');
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Saved record');
});
