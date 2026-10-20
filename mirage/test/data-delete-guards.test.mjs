import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';

test('delete guards are synchronous, isolated from live rows and removable', async () => {
  const state = emptyState();
  state.mappings.x_item = { idColumn: 'x_itemid', fields: { name: { dataverseType: 'nvarchar' } } };
  state.tables.x_item = [{ x_itemid: 'invented-id', name: 'Kept' }];
  const store = new DataStore({ state });
  assert.throws(() => store.addDeleteGuard(async () => {}), error => error.code === 'InvalidDeleteGuard');
  const stop = store.addDeleteGuard(event => {
    event.row.name = 'Must not leak';
    return Promise.reject(Error('Asynchronous guard'));
  });
  await assert.rejects(store.remove('x_item', 'invented-id', { admin: true }), error => error.code === 'InvalidDeleteGuard');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.tableRows('x_item')[0].name, 'Kept');
  stop();
  await store.remove('x_item', 'invented-id', { admin: true });
  assert.equal(store.tableRows('x_item').length, 0);
});
