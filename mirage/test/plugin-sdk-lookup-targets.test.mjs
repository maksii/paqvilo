// @test-kind contract: lookup targets derive from one exact metadata relationship; ambiguous or missing metadata refuses explicitly (501)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { recordToSdkEntity } from '../lib/plugin-clr.mjs';

const id = '10000000-0000-4000-8000-000000000001';
function fixture({ field = { dataverseType: 'lookup' }, relationships } = {}) {
  const state = emptyState();
  for (const entity of ['widget', 'parent', 'other']) {
    state.mappings[entity] = { entitySet: entity + 's', idColumn: entity + 'id' };
    state.tables[entity] = entity === 'parent' ? [{ parentid: id }] : [];
  }
  state.mappings.widget.fields = { parentid: field };
  state.mappings.widget.relationships = relationships ?? {
    PascalCaseParent: { entity: 'parent', from: 'parentid', to: 'parentid', many: false },
  };
  return new DataStore({ state });
}
const convert = (store) => recordToSdkEntity(store, 'widget', { widgetid: id, parentid: id }).attributes.parentid;

test('SDK lookup GUID serialization uses one exact source relationship without requiring duplicate field targets', () => {
  const store = fixture();
  try {
    assert.deepEqual(convert(store), { $type: 'EntityReference', logicalName: 'parent', id, name: null });
  } finally {
    store.close();
  }
});

test('lookup relationship derivation keeps ambiguity, reverse, non-primary and polymorphic metadata refusals', async (t) => {
  const exact = { entity: 'parent', from: 'parentid', to: 'parentid', many: false };
  for (const [name, options] of [
    ['no relationship', { relationships: {} }],
    ['reverse collection', { relationships: { reverse: { ...exact, many: true } } }],
    ['non-primary key', { relationships: { alternate: { ...exact, to: 'externalkey' } } }],
    ['unknown target', { relationships: { missing: { ...exact, entity: 'missing' } } }],
    [
      'two targets even though only one has the GUID row',
      { relationships: { exact, other: { ...exact, entity: 'other', to: 'otherid' } } },
    ],
    ['one exact plus an invalid relation', { relationships: { exact, invalid: { ...exact, to: 'externalkey' } } }],
    ['explicit ambiguous targets', { field: { dataverseType: 'lookup', targets: ['parent', 'other'] } }],
    ['explicit empty targets', { field: { dataverseType: 'lookup', targets: [] } }],
    ['owner without target metadata', { field: { dataverseType: 'owner' } }],
    ['customer without target metadata', { field: { dataverseType: 'customer' } }],
  ])
    await t.test(name, () => {
      const store = fixture(options);
      try {
        assert.throws(() => convert(store), { code: 'LocalPluginSdkUnsupported', status: 501 });
      } finally {
        store.close();
      }
    });
});
