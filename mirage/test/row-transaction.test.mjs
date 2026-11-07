import test from 'node:test';
import assert from 'node:assert/strict';
import { RowTransaction } from '../lib/row-transaction.mjs';
import { DataStore } from '../lib/data.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordPageSession, pagedRecordsOf, materializeRecord } from '../lib/record-tables.mjs';

const seed = () => ({ tables: { item: [{ itemid: 'one', name: 'original' }] } });

test('row mutations retain own prototype-named columns without modifying prototypes, including rollback', () => {
  for (const transaction of [false, true]) {
    const store = new DataStore({ state: seed() });
    const rows = store.state.tables.item,
      original = structuredClone(rows);
    if (transaction) store.rowTransaction = new RowTransaction(store);
    store.mutateRow(
      'item',
      rows,
      0,
      JSON.parse('{"__proto__":{"polluted":true},"constructor":"column","name":"changed"}'),
    );
    assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
    assert.equal(Object.hasOwn(rows[0], '__proto__'), true);
    assert.equal(rows[0].constructor, 'column');
    assert.equal(rows[0].polluted, undefined);
    if (transaction) {
      const promoted = structuredClone(store.state);
      store.rowTransaction.rollback(promoted);
      assert.deepEqual(promoted.tables.item, original);
      store.rowTransaction.rollback();
      assert.deepEqual(rows, original);
    }
  }
  assert.equal({}.polluted, undefined);
});

test('row helpers reject inherited, negative and noninteger indices before mutation', () => {
  for (const transaction of [false, true]) {
    const store = new DataStore({ state: seed() }),
      rows = store.state.tables.item;
    if (transaction) store.rowTransaction = new RowTransaction(store);
    const before = structuredClone(store.state);
    for (const index of ['__proto__', 'constructor', '0', -1, 0.5, 1, NaN]) {
      assert.throws(() => store.mutateRow('item', rows, index, { polluted: true }), RangeError);
      assert.throws(() => store.writeRow('item', rows, index, { polluted: true }), RangeError);
      assert.throws(() => store.removeRow('item', rows, index), RangeError);
    }
    assert.deepEqual(store.state, before);
    assert.equal({}.polluted, undefined);
  }
});

test('replacement, insertion and removal roll back against original or promoted state in reverse order', () => {
  const store = { state: seed() },
    before = structuredClone(store.state),
    rows = store.state.tables.item;
  const transaction = new RowTransaction(store);
  transaction.set('item', rows, 0, { itemid: 'one', name: 'replacement' });
  transaction.insert('item', rows, 1, { itemid: 'two' });
  transaction.remove('item', rows, 0);
  const promoted = structuredClone(store.state);
  assert.deepEqual(transaction.rollback(promoted), before);
  assert.deepEqual(transaction.rollback(), before);
});

test('one private snapshot per paged table and transaction rolls back every row operation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-row-snapshots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new RecordPageSession(root);
  t.after(() => session.close());
  const rows = session.from(
    Array.from({ length: 5000 }, (_, i) => ({ itemid: 'item-' + i, name: 'original ' + i })),
    { primaryKey: 'itemid' },
  );
  const paged = pagedRecordsOf(rows),
    fork = paged.fork.bind(paged);
  let forks = 0;
  paged.fork = () => {
    forks++;
    return fork();
  };
  const store = { state: { tables: { item: rows } } },
    held = rows[10],
    before = Array.from(rows, (row) => materializeRecord(row));
  const transaction = new RowTransaction(store);
  transaction.mutate('item', rows, 10, { name: 'mutated' });
  transaction.set('item', rows, 20, { itemid: 'replacement', name: 'set' });
  transaction.insert('item', rows, rows.length, { itemid: 'created', name: 'inserted' });
  transaction.remove('item', rows, 30);
  transaction.mutate('item', rows, 3000, { name: 'again' });
  assert.equal(forks, 1, 'Every operation on one table shares the first snapshot.');
  transaction.rollback();
  assert.deepEqual(
    Array.from(rows, (row) => materializeRecord(row)),
    before,
  );
  assert.equal(rows[10], held);
  assert.equal(held.name, 'original 10');
  assert.deepEqual(paged.primaryPositions('itemid', 'created'), []);
  assert.deepEqual(paged.primaryPositions('itemid', 'item-30'), [30]);
});

test('section comparison yields to the event loop and keeps the reusable section bookkeeping', async () => {
  const mappings = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [
      'x_table' + i,
      { columns: Object.fromEntries(Array.from({ length: 30 }, (_, c) => ['x_col' + c, { type: 'String' }])) },
    ]),
  );
  const store = { state: { tables: {}, mappings, settings: { theme: 'invented' } }, revision: 0 };
  const transaction = new RowTransaction(store);
  store.state.settings.theme = 'changed';
  let turned = false;
  setImmediate(() => (turned = true));
  const entries = [];
  for await (const entry of transaction.changes({ quantum: 1000 })) entries.push(entry);
  assert.equal(turned, true, 'Another event-loop turn ran while the sections were compared.');
  assert.ok(transaction.comparison.pauses >= 6);
  assert.equal(transaction.comparison.visited, 1 + 200 * 32 + 1, 'Each object of both sections is visited once.');
  assert.deepEqual(entries, [{ op: 'section', key: 'settings', value: store.state.settings }]);
  const reusable = transaction.reusableSections();
  assert.deepEqual([...reusable.sections.keys()], ['mappings']);
  assert.equal(reusable.sections.get('mappings').value, mappings);
  assert.deepEqual(reusable.sections.get('mappings').copy, mappings);
});
