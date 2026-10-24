// A preset that carries Solution-seeded control-plane tables (plug-in registrations, service endpoints, Dataverse Functions,
// masking rules) applies at level simulation: these tables are private runtime state, never pack DATA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { profileFixture } from './fixtures/deployment-profiles.mjs';

const ENTITY = '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>';
const extra = {
  serviceendpoint: "[{ serviceendpointid: '77777777-7777-4777-8777-0000000000e1', name: 'q', contract: 2, path: 'x-q' }]",
  fxexpression: "[{ fxexpressionid: '77777777-7777-4777-8777-0000000000e2', name: 'x_F', uniquename: 'x_F', expression: '1', statecode: 0 }]",
  maskingrule: "[{ maskingruleid: '77777777-7777-4777-8777-0000000000e3', name: 'x_M', regularexpression: '.', maskedcharacter: '*' }]",
  sdkmessageprocessingstep: "[{ sdkmessageprocessingstepid: '77777777-7777-4777-8777-0000000000e4', name: 'preset step', stage: 40, mode: 0, statecode: 1 }]",
};

test('a preset with control-plane tables applies at level simulation and another preset replaces them', { timeout: 120000 }, async t => {
  const fx = await profileFixture(t);
  const seeded = Object.entries(extra).map(([table, rows]) => `${table}: ${rows}`).join(', ');
  const emptied = Object.keys(extra).map(table => `${table}: []`).join(', ');
  const PACK = `export default { id: 'fx', name: 'I', description: 'I', matches: () => true,
    presets: () => ({ seed: { name: 'S', description: 'x', load: () => ({ tables: { x_item: [], ${seeded} } }) },
      other: { name: 'O', description: 'x', load: () => ({ tables: { x_item: [], ${emptied} } }) } }),
    dataFiles: [{ file: 'data.json', tables: { x_item: { path: ['items'], idColumn: 'x_itemid' } } }] };`;
  const files = { 'solution/Entities/x_item/Entity.xml': ENTITY, 'pack/data.json': JSON.stringify({ items: [] }), 'pack/pack.mjs': PACK };
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(fx.root, name)), { recursive: true });
    await fs.writeFile(path.join(fx.root, name), text);
  }
  const sim = await createSimulator({ sourceDir: fx.sourceDir, solutionRoots: fx.solutionRoots, projectRoot: fx.root, deploymentProfiles: fx.deploymentProfiles,
    stateFile: fx.stateFile, port: 0, watch: false, simulation: { level: 'simulation' }, packs: [path.join(fx.root, 'pack', 'pack.mjs')], preset: 'seed',
    dataverse: { enabled: true, port: 0, tls: false, tds: { enabled: false } } });
  t.after(() => sim.close());
  const counts = () => Object.fromEntries(Object.keys(extra).map(table => [table, sim.store.tableRows(table).length]));
  assert.deepEqual(counts(), { serviceendpoint: 1, fxexpression: 1, maskingrule: 1, sdkmessageprocessingstep: 1 });
  const response = await fetch(sim.url + '/_sim/api/presets/other/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf }, body: '{}' });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(counts(), { serviceendpoint: 0, fxexpression: 0, maskingrule: 0, sdkmessageprocessingstep: 0 }, 'the preset replaced the runtime rows');
});
