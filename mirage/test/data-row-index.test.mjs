// @test-kind contract: the store's row key index stays consistent with its rows (Paqvilo's own data structure)
// The row-key index (data.mjs RowKeyIndex) under removals: a removal marks its slot dead instead of shifting every later
// position (a cascade delete of n rows stays O(n log n)), and every lookup still answers the current ascending positions.
// Invented rows only; a deterministic pseudo-random walk of inserts, removals and key changes is checked against a scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';

const gid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('a row-key index answers the scanned positions after every insert, removal and key change', () => {
  const state = emptyState();
  state.mappings.x_item = { logicalName: 'x_item', entitySet: 'x_items', idColumn: 'x_itemid', fields: {} };
  state.tables.x_item = Array.from({ length: 300 }, (_, i) => ({ x_itemid: gid(i), x_code: `c${i % 40}` }));
  const store = new DataStore({ state });
  const rows = store.state.tables.x_item;
  const entry = store.rowKeyIndex(rows, 'invented-codes', (row) => row.x_code, { wild: true });
  let seed = 7,
    next = 1000;
  const random = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const scanned = (code) => rows.flatMap((row, index) => (row.x_code === code ? [index] : []));
  for (let step = 0; step < 3000; step++) {
    const action = random(10);
    if (action < 5 && rows.length > 1) store.removeRow('x_item', rows, random(rows.length));
    else if (action < 8)
      store.insertRow('x_item', rows, { x_itemid: gid(next++), ...(random(6) ? { x_code: `c${random(40)}` } : {}) });
    else if (rows.length) store.mutateRow('x_item', rows, random(rows.length), { x_code: `c${random(40)}` });
    assert.equal(
      store.rowKeyIndex(rows, 'invented-codes', (row) => row.x_code, { wild: true }),
      entry,
      'kept',
    );
    const code = `c${random(40)}`;
    assert.deepEqual(entry.get(code), scanned(code), `step ${step}: ${code}`);
    assert.deepEqual(
      entry.wild,
      rows.flatMap((row, index) => (row.x_code === undefined ? [index] : [])),
      `step ${step}: wild`,
    );
  }
  for (let i = 0; i < 40; i++) assert.deepEqual(entry.get(`c${i}`), scanned(`c${i}`));
});

test('removing every row of a large table one by one keeps the primary-key lookups exact', () => {
  const state = emptyState();
  state.mappings.x_item = { logicalName: 'x_item', entitySet: 'x_items', idColumn: 'x_itemid', fields: {} };
  state.tables.x_item = Array.from({ length: 5000 }, (_, i) => ({ x_itemid: gid(i) }));
  const store = new DataStore({ state });
  const mapping = store.resolveMapping('x_item'),
    rows = store.state.tables.x_item;
  // Children first, as a cascade walks them: each removal is found through the index and removed at its position.
  for (let i = 0; i < 5000; i += 2) {
    const [position] = store.rowPositions(mapping, rows, gid(i));
    assert.equal(rows[position].x_itemid, gid(i));
    store.removeRow('x_item', rows, position);
  }
  assert.equal(rows.length, 2500);
  for (let i = 1; i < 5000; i += 2) assert.deepEqual(store.rowPositions(mapping, rows, gid(i)), [(i - 1) / 2]);
  assert.deepEqual(store.rowPositions(mapping, rows, gid(0)), []);
});
