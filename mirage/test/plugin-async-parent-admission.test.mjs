import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { recordToSdkEntity } from '../lib/plugin-clr.mjs';

const parentId = '60000000-0000-4000-8000-000000000001';
const childId = '60000000-0000-4000-8000-000000000002';

for (const operation of ['create', 'update'])
  test(`ordinary ${operation} does not enter the SDK parent codec without an admitted observer`, async (t) => {
    const state = emptyState();
    state.mappings.child = {
      entitySet: 'children',
      idColumn: 'childid',
      fields: { parentid: { dataverseType: 'lookup' } },
    };
    state.tables.child = operation === 'update' ? [{ childid: childId, title: 'Before' }] : [];
    const store = new DataStore({ state });
    t.after(() => store.close());
    // This local lookup is permitted without claiming a source-qualified SDK
    // EntityReference target. An admitted SDK adapter must still reject it.
    assert.throws(() => recordToSdkEntity(store, 'child', { parentid: parentId }), {
      code: 'LocalPluginSdkUnsupported',
    });
    if (operation === 'create') await store.create('child', { childid: childId, parentid: parentId }, { admin: true });
    else await store.update('child', childId, { parentid: parentId }, { admin: true });
    assert.equal(store.tableRows('child').length, 1);
    assert.equal(store.tableRows('child')[0].parentid, parentId);
  });
