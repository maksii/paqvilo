import test from 'node:test';
import assert from 'node:assert/strict';
import { listModel } from '../lib/native-services.mjs';

const view = { id: 'view-a', entity: 'sample_item', name: 'Selected view', fields: [{ name: 'sample_name' }] };
const metadata = { views: [view, { ...view, id: 'view-b' }], entities: {} };
const store = { resolveMapping: () => ({ idColumn: 'sample_itemid', nameColumn: 'sample_name' }) };
const model = (views) =>
  listModel({
    metadata,
    store,
    list: { id: 'list-a', name: 'List', entityName: 'sample_item', metadata: { adx_views: views } },
  });

test('exported list view arrays and wrapper variants preserve the actual selected Solution view', () => {
  for (const value of [
    [{ ViewId: 'view-a' }],
    { Views: [{ ViewId: 'view-a' }] },
    { views: [{ ViewId: 'view-a' }] },
    [{ viewId: 'view-a' }],
    [{ id: 'view-a' }],
    [{ value: 'view-a' }],
    ['view-a'],
  ]) {
    for (const encoded of [value, JSON.stringify(value)]) {
      const selected = model(encoded);
      assert.equal(selected.approximated, false);
      assert.equal(selected.views[0].id, 'view-a');
      assert.equal(selected.views[0].name, 'Selected view');
    }
  }
});

test('invalid, conflicting and unexported list view identifiers never guess an available Solution view', () => {
  for (const value of [
    null,
    7,
    { Views: {} },
    [null],
    [{ ViewId: [] }],
    [{ ViewId: 'unknown' }],
    [{ ViewId: 'view-a', id: 'view-b' }],
  ]) {
    const selected = model(JSON.stringify(value));
    assert.equal(selected.approximated, true);
    assert.equal(selected.views[0].id, 'list-a');
    assert.equal(selected.views[0].approximated, true);
  }
  assert.throws(() => model('[invalid'), /Grid views JSON is malformed/);
});
