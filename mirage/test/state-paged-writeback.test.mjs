import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pagedRecordsOf } from '../lib/record-tables.mjs';
import { StateStorage } from '../lib/state-storage.mjs';
import { createSimulator } from '../server.mjs';

const admin = { admin: true };
const pack = {
  id: 'invented-paged-writeback',
  name: 'Invented paged writeback',
  description: 'Invented',
  matches: () => true,
  presets: () => ({
    pagedItems: {
      name: 'Invented paged items',
      createOwned({ records }) {
        function* rows() {
          for (let i = 0; i < 3000; i++) yield { itemid: 'row-' + i, name: 'Invented ' + i };
        }
        return {
          mappings: { item: { idColumn: 'itemid', entitySet: 'items', nameColumn: 'name' } },
          tables: { item: records.table(rows(), { primaryKey: 'itemid' }) },
        };
      },
    },
    settingsOnly: { name: 'Invented settings only', settings: { permissionMode: 'permissive' } },
  }),
};

// The persisted table stays a record-page reference rather than resident rows.
async function storedItemIsPaged(file) {
  const storage = new StateStorage(file);
  try {
    const state = await storage.load();
    return Boolean(storage.recordReferences && pagedRecordsOf(state.tables.item));
  } finally {
    storage.recordSession?.close();
  }
}

test('settings-only presets keep paged tables on their pages, at runtime and at startup', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invented-paged-writeback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'website.yml'), 'adx_websiteid: invented\nadx_name: Invented writeback');
  const stateFile = path.join(root, 'state.json');
  const start = (preset) =>
    createSimulator({ sourceDir: root, stateFile, watch: false, packs: [pack], preset, presetMode: 'always' });
  const sim = await start('pagedItems');
  let open = true;
  t.after(() => open && sim.close());
  assert.ok(pagedRecordsOf(sim.store.state.tables.item), 'The startup preset stores the table on pages.');
  await sim.applyPreset('settingsOnly');
  assert.equal(sim.store.state.settings.permissionMode, 'permissive');
  assert.ok(pagedRecordsOf(sim.store.state.tables.item), 'A settings-only preset must not materialize pages.');
  assert.equal(sim.store.get('items', 'row-2999', admin).name, 'Invented 2999');
  open = false;
  await sim.close();
  assert.ok(await storedItemIsPaged(stateFile));

  const restarted = await start('settingsOnly');
  t.after(() => restarted.close());
  assert.ok(pagedRecordsOf(restarted.store.state.tables.item), 'The startup preset path keeps pages too.');
  assert.equal(restarted.store.get('items', 'row-0', admin).name, 'Invented 0');
  assert.ok(await storedItemIsPaged(stateFile));
});
