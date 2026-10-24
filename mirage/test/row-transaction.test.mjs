import test from 'node:test';
import assert from 'node:assert/strict';
import { RowTransaction } from '../lib/row-transaction.mjs';
import { DataStore } from '../lib/data.mjs';

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
