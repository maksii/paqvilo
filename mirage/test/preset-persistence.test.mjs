import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { bootstrapPresetLibrary, resolvePreset } from '../lib/presets.mjs';
import { applySolutionData } from '../lib/solution-data.mjs';
import { presetId, presetBody, syntheticPresetPack } from './fixtures/lazy-preset-pack.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const libraryFor = (fixture) => bootstrapPresetLibrary({ packs: [fixture.pack], tables: {}, mappings: {} });

async function stateFile(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-presets-persistence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.json');
}

test('a lazy pack persists only its descriptor and resolves with a fresh library after restart', async (t) => {
  const file = await stateFile(t),
    fixture = syntheticPresetPack(),
    library = libraryFor(fixture);
  await new DataStore({ file, state: { presets: library }, presetLibrary: library }).init();
  const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(persisted.presets[presetId], {
    builtin: true,
    builtinVersion: 1,
    name: 'Tiny builtin',
    description: 'One generated row',
  });
  assert.equal(fixture.loads(), 0, 'persistence must not hydrate a lazy body');
  const fresh = syntheticPresetPack(),
    freshLibrary = libraryFor(fresh);
  const restarted = await new DataStore({ file, presetLibrary: freshLibrary }).init();
  assert.equal(fresh.loads(), 0, 'restart must not eagerly regenerate a builtin');
  assert.deepEqual(resolvePreset(restarted.snapshot(), presetId, freshLibrary).tables, presetBody().tables);
  assert.equal(fresh.loads(), 1);
  await restarted.applyPreset(presetId, { generatedPresets: freshLibrary });
  assert.deepEqual(restarted.snapshot().tables.item, presetBody().tables.item);
  assert.equal(fresh.loads(), 1, 'resolved bodies are memoized');
});

test('stored full bodies under builtin names remain authoritative across restart', async (t) => {
  const file = await stateFile(t),
    fixture = syntheticPresetPack(),
    library = libraryFor(fixture);
  const custom = { name: 'Stored body', tables: { item: [{ itemid: 'stored', name: 'Saved item' }] } };
  // Cover both an explicit pack name and the generic compatibility library.
  const presets = { [presetId]: custom, 'contact-demo': custom };
  await new DataStore({ file, state: { presets }, presetLibrary: library }).init();
  const restarted = await new DataStore({ file, presetLibrary: library }).init();
  for (const name of Object.keys(presets)) {
    assert.deepEqual(restarted.snapshot().presets[name], custom);
    assert.deepEqual(resolvePreset(restarted.snapshot(), name, library), custom);
    await restarted.applyPreset(name, { generatedPresets: library });
    assert.deepEqual(restarted.snapshot().tables.item, custom.tables.item);
  }
});

test('userConfigured builtin edits are never compacted or regenerated after restart', async (t) => {
  const file = await stateFile(t),
    fixture = syntheticPresetPack(),
    library = libraryFor(fixture);
  const edited = {
    ...presetBody(),
    builtin: true,
    userConfigured: true,
    name: 'Edited',
    tables: { item: [{ itemid: 'edited', name: 'Explicit local edit' }] },
  };
  await new DataStore({ file, state: { presets: { [presetId]: edited } }, presetLibrary: library }).init();
  const fresh = syntheticPresetPack(),
    freshLibrary = libraryFor(fresh);
  const restarted = await new DataStore({ file, presetLibrary: freshLibrary }).init();
  assert.deepEqual(resolvePreset(restarted.snapshot(), presetId, freshLibrary), edited);
  await restarted.applyPreset(presetId, { generatedPresets: freshLibrary });
  assert.deepEqual(restarted.snapshot().tables.item, edited.tables.item);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).presets[presetId], edited);
  assert.equal(fresh.loads(), 0, 'an edited body never needs the generated replacement');
});

test('Solution enrichment keeps pack descriptors lazy and hydrates current metadata on demand', () => {
  const fixture = syntheticPresetPack(),
    library = libraryFor(fixture);
  const mapping = {
    entitySet: 'exact_items',
    idColumn: 'itemid',
    inferred: false,
    metadataSources: ['synthetic.xml'],
    relationships: { owner: { entity: 'contact', from: 'ownerid', to: 'contactid' } },
  };
  const metadata = {
    mappings: { item: mapping },
    relationships: {},
    diagnostics: [],
    roots: [],
    stats: {},
    fingerprint: 'synthetic',
  };
  const enriched = applySolutionData({ presets: library, mappings: {}, tables: {} }, metadata, {
    presetLibrary: library,
  });
  assert.equal(fixture.loads(), 0);
  assert.deepEqual(enriched.presets[presetId], {
    builtin: true,
    builtinVersion: 1,
    name: 'Tiny builtin',
    description: 'One generated row',
  });
  const resolved = resolvePreset(enriched, presetId, library);
  assert.deepEqual(resolved.tables, presetBody().tables);
  assert.deepEqual(resolved.mappings.item, mapping);
  assert.equal(fixture.loads(), 1);
});
