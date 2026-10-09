import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectProjectBoundary } from '../scripts/project-boundary.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/paqvilo.mjs');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });

test('public command namespaces select Lense and Mirage independently', () => {
  for (const product of ['lense', 'mirage']) {
    const result = run(product, '--help');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(product, 'i'));
  }
  const invalid = run('dev', '--json');
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'UNKNOWN_PRODUCT');
  const inventory = run('mirage', 'liquid-inventory', '--portal', path.join(root, 'examples/project/portal'), '--json');
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.doesNotThrow(() => JSON.parse(inventory.stdout));
  const status = run('mirage', 'status', '--json');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).action, 'status');
});

test('core project contains no private business dependency and the guard detects reintroduction', (t) => {
  assert.deepEqual(inspectProjectBoundary(root), []);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-boundary-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'mirage/packs'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'mirage/server.mjs'), 'const table = "ema_secret";');
  assert.deepEqual(inspectProjectBoundary(fixture), [
    'mirage/server.mjs: project-specific identifier',
    'mirage/packs: project packs must be external',
  ]);
});

test('default Mirage discovery has no project packs and embedded registration is explicit', async (t) => {
  const { discoverPacks, presetLibrary, genericPresets } = await import('../mirage/lib/preset-registry.mjs');
  assert.deepEqual(await discoverPacks(), []);
  const { builtinPresets } = await import('../mirage/lib/presets.mjs');
  assert.deepEqual(Object.keys(builtinPresets), Object.keys(genericPresets()));
  const { createSimulator } = await import('../mirage/server.mjs');
  const { DataStore } = await import('../mirage/lib/data.mjs');
  const { signInHeaders } = await import('../mirage/testing/session.mjs');
  const module = path.join(root, 'examples/project/pack/pack.mjs');
  const packs = await discoverPacks({ explicit: [{ module }] });
  const store = new DataStore();
  await store.applyPreset('example-demo', { generatedPresets: presetLibrary({ packs }) });
  const simulator = await createSimulator({ sourceDir: path.join(root, 'examples/project/portal'), initial: store.snapshot(), dataPacks: [{ module }], watch: false, port: 0 });
  t.after(() => simulator.close());
  const anonymous = await fetch(simulator.url);
  assert.equal(anonymous.status, 200);
  assert.match(await anonymous.text(), /Anonymous/);
  const response = await fetch(simulator.url, { headers: signInHeaders(simulator, '11111111-1111-4111-8111-111111111111') });
  assert.match(await response.text(), /Alex Example/);
  assert.deepEqual(await discoverPacks(), [], 'loading a project does not change global discovery');
});

test('an external preset library persists compactly and resolves after restart while edited bodies survive', async (t) => {
  const { DataStore } = await import('../mirage/lib/data.mjs');
  const { discoverPacks, presetLibrary } = await import('../mirage/lib/preset-registry.mjs');
  const { migrateScenarioState } = await import('../mirage/lib/state-migration.mjs');
  const packs = await discoverPacks({ explicit: [{ module: path.join(root, 'examples/project/pack/pack.mjs') }] });
  const library = presetLibrary({ packs });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-external-presets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const store = await new DataStore({ file, presetLibrary: library, state: { presets: structuredClone(library) } }).init();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.presets['example-demo'].builtin, true);
  assert.equal(saved.presets['example-demo'].tables, undefined);
  const restarted = await new DataStore({ file, presetLibrary: library }).init();
  await restarted.applyPreset('example-demo');
  assert.equal(restarted.snapshot().tables.contact[0].fullname, 'Alex Example');
  const edited = structuredClone(library['example-demo']);
  edited.tables.contact[0].fullname = 'Project-specific edit';
  const current = { presets: { 'example-demo': library['example-demo'], mine: edited }, tables: {} };
  const migrated = migrateScenarioState(current, { latest: { tables: {} }, presetLibrary: library }).state;
  assert.equal(migrated.presets['example-demo'].tables, undefined);
  assert.equal(migrated.presets.mine.tables.contact[0].fullname, 'Project-specific edit');
  assert.equal(store.snapshot().tables.contact, undefined);
});

test('project generators receive their own count names and invalid counts fail before writing', async (t) => {
  const { runDataCommand } = await import('../mirage/lib/data-generation.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-generator-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const module = path.join(directory, 'pack.mjs');
  fs.writeFileSync(module, `export default {
    id: 'counts-example', name: 'Counts example', description: 'Invented dimensions',
    matches: () => true, presets: () => ({}),
    dataset: ({ counts }) => ({ tables: {}, mappings: {}, provenance: { measures: counts } }),
  };`);
  const state = path.join(directory, 'state.json');
  const args = { pack: 'counts-example', 'pack-module': [module], state, count: ['customers=3', 'orders=12'] };
  const result = await runDataCommand(['generate'], args);
  assert.deepEqual(result.measures, { customers: 3, orders: 12 });
  const before = fs.readFileSync(state, 'utf8');
  for (const count of [['orders=-1'], ['orders=2', 'orders=3'], ['constructor=4'], ['orders=NaN']]) {
    await assert.rejects(runDataCommand(['generate'], { ...args, count }), /count|non-negative/);
    assert.equal(fs.readFileSync(state, 'utf8'), before);
  }
});
