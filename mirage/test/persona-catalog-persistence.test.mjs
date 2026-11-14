import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from '../lib/data.mjs';
import { validatePack, presetLibrary } from '../lib/preset-registry.mjs';
import { mergeDataset } from '../lib/data-generation.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const catalog = (key = 'one', contact = 1) => ({
  version: 1,
  groups: [{ id: 'users', label: 'Users' }],
  personas: [{ key, contactId: id(contact), group: 'users' }],
});
const pack = (value) => ({
  id: 'synthetic',
  name: 'Synthetic',
  description: 'Synthetic catalogue pack',
  matches: () => true,
  presets: () => ({}),
  ...value,
});

test('pack validation preserves legacy personas and validates only a data-property catalogue', () => {
  validatePack(pack({ personas: [{ contactId: id(1) }] }));
  validatePack(pack({ personaCatalog: catalog() }));
  assert.throws(
    () => validatePack(pack({ personaCatalog: { ...catalog(), version: 2 } })),
    /Data pack synthetic: personaCatalog.version/,
  );
  let invoked = false;
  const getter = pack();
  Object.defineProperty(getter, 'personaCatalog', {
    get() {
      invoked = true;
      return catalog();
    },
  });
  assert.throws(() => validatePack(getter), /must be a data property/);
  assert.equal(invoked, false);
});

test('preset catalogue bodies remain lazy, replace stored metadata and survive restart', async (t) => {
  const directory = await makeTemporaryDirectory(join(tmpdir(), 'mirage-persona-preset-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let loads = 0;
  const library = presetLibrary({
    packs: [
      pack({
        presets: () => ({
          curated: {
            name: 'Curated',
            load() {
              loads++;
              return {
                personaCatalog: catalog(),
                tables: { contact: [{ contactid: id(1), fullname: 'Synthetic Contact' }] },
              };
            },
          },
        }),
      }),
    ],
  });
  const file = join(directory, 'state.json');
  const store = await new DataStore({ file, presetLibrary: library }).init();
  assert.equal(loads, 0);
  await store.applyPreset('curated');
  assert.equal(loads, 1);
  assert.deepEqual(store.state.personaCatalog, catalog());
  store.state.personaCatalog.personas.push({ key: 'local', contactId: id(2), group: 'users' });
  await store.applyPreset('curated');
  assert.equal(store.state.personaCatalog.personas.length, 1);
  const restarted = await new DataStore({ file, presetLibrary: library }).init();
  assert.deepEqual(restarted.state.personaCatalog, catalog());
  const before = restarted.snapshot();
  await assert.rejects(
    restarted.applyPreset('invalid', {
      generatedPresets: { invalid: { personaCatalog: { ...catalog(), version: 7 } } },
    }),
    /Preset invalid: personaCatalog.version/,
  );
  assert.deepEqual(restarted.snapshot(), before);
});

test('dataset catalogues merge by key and group ID while existing entries win', () => {
  const store = new DataStore();
  const state = store.snapshot();
  state.personaCatalog = catalog();
  state.personaCatalog.personas[0].label = 'Local label';
  const generated = catalog('two', 2);
  generated.personas.push({ ...catalog().personas[0], label: 'Generated label' });
  generated.groups[0].label = 'Generated group';
  const result = mergeDataset(state, { tables: {}, personaCatalog: generated }, { packId: 'synthetic' }).state;
  assert.equal(result.personaCatalog.personas.length, 2);
  assert.equal(result.personaCatalog.personas.find((persona) => persona.key === 'one').label, 'Local label');
  assert.equal(result.personaCatalog.groups[0].label, 'Users');
  assert.equal(state.personaCatalog.personas.length, 1, 'input stays unchanged');
});
