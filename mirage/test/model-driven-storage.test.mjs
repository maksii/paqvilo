import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createModelDrivenStorage } from '../lib/model-driven-storage.mjs';

const id = '11111111-2222-4000-8000-000000000001';
const admin = { admin: true };
function fixture() {
  const store = new DataStore({ state: emptyState() });
  const source = {
    invented_component: {
      entity: 'invented_component',
      entitySet: 'invented_components',
      projected: true,
      kind: 'component',
      idColumn: 'invented_componentid',
      nameColumn: 'name',
      fields: {
        invented_componentid: { name: 'invented_componentid', dataverseType: 'uniqueidentifier' },
        name: { name: 'name', dataverseType: 'nvarchar' },
        body: { name: 'body', dataverseType: 'memo' },
      },
      rows: [{ invented_componentid: id, name: 'Source', body: 'Original' }],
    },
  };
  const adapter = createModelDrivenStorage({
    store,
    tables: () => source,
    overlayOf: (table, row, before) => ({
      kind: table.kind,
      id: row[table.idColumn],
      ...Object.fromEntries(
        Object.entries(row).filter(([key, value]) => key !== table.idColumn && value !== before?.[key]),
      ),
    }),
  });
  adapter.materialize();
  return { store, source, adapter };
}

test('source-backed writes stage sparse overlays in the same incremental transaction', async (t) => {
  const { store, adapter, source } = fixture();
  t.after(() => adapter.close());
  await store.update('invented_component', id, { body: 'Changed' }, admin);
  assert.deepEqual(store.state.simulator.modelDriven.records[`component/${id}`], {
    kind: 'component',
    id,
    body: 'Changed',
  });
  assert.equal(source.invented_component.rows[0].body, 'Original');
  const snapshot = store.snapshot();
  await assert.rejects(
    store.transact(
      async () => {
        await store.update('invented_component', id, { name: 'Must roll back' }, admin);
        await store.create('invented_component', { name: 'Also rolled back' }, admin);
        throw Error('later request failed');
      },
      { isolated: true },
    ),
    /later request failed/,
  );
  assert.deepEqual(store.snapshot(), snapshot);
});

test('deletion tombstones roll back and protected source records cannot be removed', async (t) => {
  const { store, adapter, source } = fixture();
  t.after(() => adapter.close());
  const before = store.snapshot();
  source.invented_component.protectedIds = [id];
  await assert.rejects(store.remove('invented_component', id, admin), /active source website/);
  assert.deepEqual(store.snapshot(), before);
  source.invented_component.protectedIds = [];
  await store.remove('invented_component', id, admin);
  assert.equal(store.state.simulator.modelDriven.records[`component/${id}`], null);
});

test('materialization preserves write versions and invalidates stale versions on changed source content', async (t) => {
  const { store, adapter, source } = fixture();
  t.after(() => adapter.close());
  await store.update('invented_component', id, { body: 'Changed' }, admin);
  source.invented_component.rows[0].body = 'Changed';
  const version = store.etag(store.tableRows('invented_component')[0]);
  adapter.materialize();
  assert.equal(store.etag(store.tableRows('invented_component')[0]), version);
  source.invented_component.rows[0].name = 'Source edit';
  adapter.materialize();
  assert.notEqual(store.etag(store.tableRows('invented_component')[0]), version);
});

test('source model changes remove only obsolete source projections', (t) => {
  const { store, adapter, source } = fixture();
  t.after(() => adapter.close());
  store.state.mappings.unrelated = { entitySet: 'unrelateds', idColumn: 'unrelatedid' };
  store.state.tables.unrelated = [{ unrelatedid: id }];
  assert.equal(store.state.mappings.invented_component.ownership, 'OrganizationOwned');
  delete source.invented_component;
  adapter.materialize();
  assert.equal(store.state.mappings.invented_component, undefined);
  assert.equal(store.state.tables.invented_component, undefined);
  assert.equal(store.state.tables.unrelated.length, 1);
});

test('source lookup identity preserves canonical values and versions but target changes invalidate them', (t) => {
  const { store, adapter, source } = fixture();
  t.after(() => adapter.close());
  const table = source.invented_component,
    related = '22222222-2222-4222-8222-222222222222';
  table.fields.parentid = { name: 'parentid', dataverseType: 'lookup', targets: ['invented_parent'] };
  table.rows[0].parentid = related;
  const row = store.tableRows('invented_component')[0];
  row.parentid = { id: related, logical_name: 'invented_parent', name: 'Canonical lookup' };
  row.__simVersion = 7;
  row.versionnumber = 7;
  row.statuscode = 1;
  adapter.materialize();
  assert.equal(store.etag(store.tableRows('invented_component')[0]), 'W/"7"');
  assert.deepEqual(store.tableRows('invented_component')[0].parentid, row.parentid);
  assert.equal(
    store.tableRows('invented_component')[0].statuscode,
    1,
    'A pipeline-supplied status reason survives a thin source projection.',
  );
  table.fields.parentid.targets = ['invented_parent', 'invented_other'];
  table.rows[0].parentid = { id: related, logical_name: 'invented_other' };
  adapter.materialize();
  assert.notEqual(store.etag(store.tableRows('invented_component')[0]), 'W/"7"');
  assert.equal(store.tableRows('invented_component')[0].parentid.logical_name, 'invented_other');
  assert.equal(table.rows[0].parentid.logical_name, 'invented_other', 'Materialization leaves source values intact.');
});

test('protected source deletes reject before root or child plug-ins, cascades and observers, including SDK writes', async (t) => {
  const { store, adapter, source } = fixture();
  t.after(() => adapter.close());
  source.invented_component.protectedIds = [id];
  store.state.mappings.invented_child = {
    logicalName: 'invented_child',
    idColumn: 'invented_childid',
    fields: { parentid: { dataverseType: 'lookup' } },
    relationships: {
      parentid: {
        entity: 'invented_component',
        from: 'parentid',
        to: 'invented_componentid',
        many: false,
        cascade: { delete: 'RemoveLink' },
      },
    },
  };
  store.state.tables.invented_child = Array.from({ length: 512 }, (_, index) => ({
    invented_childid: String(index),
    parentid: id,
  }));
  const before = store.snapshot();
  let phases = 0,
    notifications = 0,
    cascades = 0;
  store.exportedPluginPhase = () => {
    phases++;
  };
  const referencesTo = store.referencesTo.bind(store);
  store.referencesTo = (...args) => {
    cascades++;
    return referencesTo(...args);
  };
  const stop = store.addMutationObserver(() => {
    notifications++;
  });
  t.after(stop);
  const protectedError = (error) => error.code === 'NotImplemented' && error.status === 501;
  await assert.rejects(store.remove('invented_component', id, admin), protectedError);
  assert.throws(() => store.sdkMutation(() => store.removeRecord('invented_component', id, admin)), protectedError);
  assert.deepEqual({ phases, notifications, cascades }, { phases: 0, notifications: 0, cascades: 0 });
  assert.deepEqual(store.snapshot(), before);
  // Closing the projection removes both its early guard and mutation observer.
  adapter.close();
  await store.remove('invented_component', id, admin);
  assert.equal(store.tableRows('invented_component').length, 0);
  assert.equal(
    store.tableRows('invented_child').every((row) => row.parentid === null),
    true,
  );
  assert.equal(store.state.simulator?.modelDriven, undefined);
});
