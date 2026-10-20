import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createModelDrivenStorage } from '../lib/model-driven-storage.mjs';

const id = '11111111-2222-4000-8000-000000000001';
const admin = { admin: true };
function fixture() {
  const store = new DataStore({ state: emptyState() });
  const source = { invented_component: { entity: 'invented_component', entitySet: 'invented_components', projected: true, kind: 'component', idColumn: 'invented_componentid', nameColumn: 'name', fields: { invented_componentid: { name: 'invented_componentid', dataverseType: 'uniqueidentifier' }, name: { name: 'name', dataverseType: 'nvarchar' }, body: { name: 'body', dataverseType: 'memo' } }, rows: [{ invented_componentid: id, name: 'Source', body: 'Original' }] } };
  const adapter = createModelDrivenStorage({ store, tables: () => source, overlayOf: (table, row, before) => ({ kind: table.kind, id: row[table.idColumn], ...Object.fromEntries(Object.entries(row).filter(([key, value]) => key !== table.idColumn && value !== before?.[key])) }) });
  adapter.materialize();
  return { store, source, adapter };
}

test('source-backed writes stage sparse overlays in the same incremental transaction', async t => {
  const { store, adapter, source } = fixture(); t.after(() => adapter.close());
  await store.update('invented_component', id, { body: 'Changed' }, admin);
  assert.deepEqual(store.state.simulator.modelDriven.records[`component/${id}`], { kind: 'component', id, body: 'Changed' });
  assert.equal(source.invented_component.rows[0].body, 'Original');
  const snapshot = store.snapshot();
  await assert.rejects(store.transact(async () => {
    await store.update('invented_component', id, { name: 'Must roll back' }, admin);
    await store.create('invented_component', { name: 'Also rolled back' }, admin);
    throw Error('later request failed');
  }, { isolated: true }), /later request failed/);
  assert.deepEqual(store.snapshot(), snapshot);
});

test('deletion tombstones roll back and protected source records cannot be removed', async t => {
  const { store, adapter, source } = fixture(); t.after(() => adapter.close());
  const before = store.snapshot();
  source.invented_component.protectedIds = [id];
  await assert.rejects(store.remove('invented_component', id, admin), /active source website/);
  assert.deepEqual(store.snapshot(), before);
  source.invented_component.protectedIds = [];
  await store.remove('invented_component', id, admin);
  assert.equal(store.state.simulator.modelDriven.records[`component/${id}`], null);
});

test('materialization preserves write versions and invalidates stale versions on changed source content', async t => {
  const { store, adapter, source } = fixture(); t.after(() => adapter.close());
  await store.update('invented_component', id, { body: 'Changed' }, admin);
  source.invented_component.rows[0].body = 'Changed';
  const version = store.etag(store.tableRows('invented_component')[0]);
  adapter.materialize();
  assert.equal(store.etag(store.tableRows('invented_component')[0]), version);
  source.invented_component.rows[0].name = 'Source edit';
  adapter.materialize();
  assert.notEqual(store.etag(store.tableRows('invented_component')[0]), version);
});

test('source model changes remove only obsolete source projections', t => {
  const { store, adapter, source } = fixture(); t.after(() => adapter.close());
  store.state.mappings.unrelated = { entitySet: 'unrelateds', idColumn: 'unrelatedid' };
  store.state.tables.unrelated = [{ unrelatedid: id }];
  assert.equal(store.state.mappings.invented_component.ownership, 'OrganizationOwned');
  delete source.invented_component;
  adapter.materialize();
  assert.equal(store.state.mappings.invented_component, undefined);
  assert.equal(store.state.tables.invented_component, undefined);
  assert.equal(store.state.tables.unrelated.length, 1);
});
