import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';

const admin = { admin: true };
const rows = (count) =>
  Array.from({ length: count }, (_, i) => ({ itemid: 'item-' + i, name: 'Original ' + i, text: 'x'.repeat(80) }));
const store = (t, items) => {
  const created = new DataStore({
    ownedState: true,
    state: {
      settings: { permissionMode: 'enforce', note: 'Invented export' },
      mappings: {
        item: { idColumn: 'itemid', entitySet: 'items' },
        page: { idColumn: 'pageid', entitySet: 'pages' },
      },
      tables: { item: items },
    },
  });
  t.after(() => created.close());
  created.state.tables.page = created
    .ensureRecordSession()
    .from([{ pageid: 'paged-0', name: 'Paged' }], { primaryKey: 'pageid' });
  return created;
};

test('an uncontended export encodes plain rows in place without copying them', async (t) => {
  const seen = [];
  const probe = {
    itemid: 'probe',
    toJSON() {
      seen.push(this);
      return { itemid: 'probe', name: 'Probe' };
    },
  };
  const exported = store(t, [probe, ...rows(3)]);
  const text = await exported.exportState((chunks) => [...chunks].join(''));
  assert.deepEqual(seen, [exported.state.tables.item[0]], 'The live row itself is encoded, once.');
  const value = JSON.parse(text);
  assert.deepEqual(value.tables.item[0], { itemid: 'probe', name: 'Probe' });
  assert.deepEqual(value.tables.page, [{ pageid: 'paged-0', name: 'Paged' }]);
  assert.equal(value.settings.note, 'Invented export');
});

test('a write requested during an export runs after copying the unexported rows, and the export stays consistent', async (t) => {
  const exported = store(t, rows(5000));
  const before = JSON.parse(JSON.stringify(exported.snapshot()));
  let written;
  const text = await exported.exportState(
    async (chunks) => {
      const iterator = chunks[Symbol.iterator]();
      const parts = [iterator.next().value];
      // The lease releases this queued write instead of holding it until the export ends.
      written = exported.update('items', 'item-4999', { name: 'Changed' }, admin);
      await written;
      assert.equal(exported.get('items', 'item-4999', admin).name, 'Changed');
      for (let next = iterator.next(); !next.done; next = iterator.next()) parts.push(next.value);
      return parts.join('');
    },
    {
      adjust: (sections) => {
        sections.settings.note = 'Adjusted copy';
      },
    },
  );
  assert.ok(written);
  const value = JSON.parse(text);
  assert.equal(value.tables.item[4999].name, 'Original 4999');
  assert.deepEqual(value.tables, before.tables);
  assert.equal(value.settings.note, 'Adjusted copy');
  assert.equal(exported.state.settings.note, 'Invented export', 'adjust edits only the exported copy.');
});
