// @test-kind contract: Paqvilo simulation persistence design: pack DATA is authoritative at startup, and a data preset applies at every simulation level (mirage/docs/simulation-levels.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ITEM_ENTITY, startPackSimulator } from './support/simulation-pack-fixture.mjs';
import { createSimulator } from '../api.mjs';
import { createSimulationPersistence } from '../lib/simulation-persistence.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const FILE_ROW = '77777777-7777-4777-8777-0000000000b1',
  PRESET_ROW = '77777777-7777-4777-8777-0000000000b2';
// seed: the startup preset, with a row of its own for the DATA-owned table. mapped: a preset that carries mappings.
const PACK = `export default { id: 'fx-authority', name: 'Invented', description: 'Invented', matches: () => true,
  presets: () => ({
    seed: { name: 'Seed', description: 'x', load: () => ({ tables: { x_item: [{ x_itemid: '${PRESET_ROW}', x_name: 'Preset row' }] } }) },
    mapped: { name: 'Mapped', description: 'x', load: () => ({
      mappings: { x_note: { entitySet: 'x_notes', idColumn: 'x_noteid', relationships: {} } },
      tables: { x_item: [{ x_itemid: '${PRESET_ROW}', x_name: 'Mapped preset row' }] } }) } }),
  dataFiles: [{ file: 'data.json', tables: { x_item: { path: ['items'], idColumn: 'x_itemid' } } }] };`;

async function start(t, level, extra = {}) {
  const files = {
    'solution/Entities/x_item/Entity.xml': ITEM_ENTITY,
    'pack/data.json': JSON.stringify({ items: [{ x_itemid: FILE_ROW, x_name: 'File row' }], sibling: 'kept' }),
    'pack/pack.mjs': PACK,
  };
  const { sim, fixture } = await startPackSimulator(t, files, { simulation: { level }, ...extra });
  const dataFile = path.join(fixture.root, 'pack', 'data.json');
  return { sim, readData: async () => JSON.parse(await fs.readFile(dataFile, 'utf8')) };
}

for (const presetMode of ['bootstrap', 'always'])
  test(`a startup preset (presetMode ${presetMode}) keeps the DATA file's rows, and a write preserves them`, async (t) => {
    const { sim, readData } = await start(t, 'simulation', { preset: 'seed', presetMode });
    const ids = () => sim.store.tableRows('x_item').map((row) => row.x_itemid);
    assert.deepEqual(ids(), [FILE_ROW], 'the DATA file is authoritative for the table it owns');
    await sim.store.update('x_item', FILE_ROW, { x_name: 'Edited file row' }, { admin: true });
    const written = await readData();
    assert.deepEqual(
      written.items.map((row) => [row.x_itemid, row.x_name]),
      [[FILE_ROW, 'Edited file row']],
      "the file's own row survives the first write and no preset row is published over it",
    );
    assert.equal(written.sibling, 'kept');
  });

for (const level of ['dry-run', 'simulation'])
  test(`a preset that carries mappings applies through /_sim/ at level ${level}`, async (t) => {
    const { sim, readData } = await start(t, level);
    const response = await fetch(sim.url + '/_sim/api/presets/mapped/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: '{}',
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(sim.store.state.mappings.x_note?.entitySet, 'x_notes');
    assert.deepEqual(
      sim.store.tableRows('x_item').map((row) => row.x_name),
      ['Mapped preset row'],
    );
    const items = (await readData()).items.map((row) => row.x_name);
    // An explicit apply writes the preset's business rows to the DATA file at simulation; dry run keeps them in memory.
    assert.deepEqual(items, level === 'simulation' ? ['Mapped preset row'] : ['File row']);
    // A later record edit is not refused as a schema change.
    await sim.store.update('x_item', PRESET_ROW, { x_name: 'Edited after apply' }, { admin: true });
  });

const EVIL_API = '77777777-7777-4777-8777-0000000000c1';
// A pack with a schema owner: mapped carries only table mappings, api a custom API definition, both carry the two.
const SCHEMA_PACK = `const note = { x_note: { entitySet: 'x_notes', idColumn: 'x_noteid', relationships: {} } };
const api = { customapi: [{ customapiid: '${EVIL_API}', uniquename: 'x_Evil', name: 'x_Evil', bindingtype: 0, isfunction: false }] };
export default { id: 'fx-schema', name: 'Invented', description: 'Invented', matches: () => true,
  presets: () => ({
    mapped: { name: 'M', description: 'x', load: () => ({ mappings: note }) },
    api: { name: 'A', description: 'x', load: () => ({ tables: api }) },
    both: { name: 'B', description: 'x', load: () => ({ mappings: note, tables: api }) } }),
  dataFiles: [{ file: 'data.json', schemaPath: ['schema'], tables: { x_item: { path: ['items'], idColumn: 'x_itemid' } } }] };`;
const hasNote = (state) => Boolean(state.mappings?.x_note);
const hasApi = (rows) => (rows ?? []).some((row) => row.uniquename === 'x_Evil');

for (const level of ['dry-run', 'simulation', 'deep'])
  for (const preset of ['mapped', 'api', 'both'])
    test(`a ${preset} preset applied through /_sim/ at level ${level} keeps the level's schema rule`, async (t) => {
      const files = {
        'solution/Entities/x_item/Entity.xml': ITEM_ENTITY,
        'pack/data.json': JSON.stringify({ items: [], schema: {} }),
        'pack/pack.mjs': SCHEMA_PACK,
      };
      const options = { simulation: { level } };
      const { sim, fixture } = await startPackSimulator(t, files, options);
      const response = await fetch(`${sim.url}/_sim/api/presets/${preset}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
        body: '{}',
      });
      const text = await response.text();
      const schema = async () =>
        JSON.parse(await fs.readFile(path.join(fixture.root, 'pack', 'data.json'), 'utf8')).schema;
      const carriesApi = preset !== 'mapped',
        carriesNote = preset !== 'api';
      if (level !== 'deep' && carriesApi) {
        // Custom API definitions are schema: refused below deep, and nothing of the preset stays.
        assert.equal(response.status, 403, text);
        assert.equal(JSON.parse(text).error.code, 'SimulationSchemaDisabled');
        assert.equal(hasApi(sim.store.state.tables.customapi), false);
        assert.equal(hasNote(sim.store.state), false);
        assert.deepEqual(await schema(), {});
        return;
      }
      assert.equal(response.status, 200, text);
      assert.equal(hasNote(sim.store.state), carriesNote);
      assert.equal(hasApi(sim.store.state.tables.customapi), carriesApi);
      if (level !== 'deep') {
        // Mappings are declared schema at every level; below deep nothing is written to the schema owner.
        assert.deepEqual(await schema(), {});
        // A later record edit is not refused as a schema change.
        await sim.store.create('x_item', { x_itemid: FILE_ROW, x_name: 'After apply' }, { admin: true });
        return;
      }
      // deep with a schema owner: the schema is written to schemaPath and is authoritative on a restart without the
      // private checkpoint.
      const written = await schema();
      assert.equal(hasNote(written), carriesNote);
      assert.equal(hasApi(written.schemaRecords?.customapi), carriesApi);
      await sim.close();
      await fs.rm(fixture.stateFile, { force: true });
      const restarted = await createSimulator({
        sourceDir: fixture.sourceDir,
        solutionRoots: fixture.solutionRoots,
        projectRoot: fixture.root,
        deploymentProfiles: fixture.deploymentProfiles,
        stateFile: fixture.stateFile,
        port: 0,
        watch: false,
        packs: [path.join(fixture.root, 'pack', 'pack.mjs')],
        ...options,
      });
      ownedFixture(t).add(() => restarted.close());
      assert.equal(hasNote(restarted.store.state), carriesNote);
      assert.equal(hasApi(restarted.store.state.tables.customapi), carriesApi);
    });

test('work a preset application scheduled saves after it ends under the normal schema check', async () => {
  const adapter = await createSimulationPersistence({ settings: { level: 'dry-run' } });
  const state = { version: 1, mappings: {}, tables: {} };
  adapter.activate(state);
  let later;
  await adapter.presetApplication(async () => {
    later = new Promise((resolve) => setImmediate(resolve)).then(() =>
      adapter.save({ ...state, mappings: { x_late: { entitySet: 'x_lates', idColumn: 'x_lateid' } } }),
    );
  });
  await assert.rejects(later, { code: 'SimulationSchemaDisabled' });
});
