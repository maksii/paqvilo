// @test-kind contract: rebuilding a local source form preserves the persisted comparison baseline while carrying its unsaved draft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';

test('a rebuilt form compares its carried draft with the persisted row', () => {
  const original = { sampleid: '10000000-0000-4000-8000-000000000001', name: 'Stored' };
  const record = { ...original, name: 'Draft carried to another form' };
  const runtime = createFormClientRuntime({
    table: {
      entity: 'sample',
      idColumn: 'sampleid',
      nameColumn: 'name',
      fields: { name: { name: 'name', type: 'text' } },
    },
    form: { attributes: ['name'], tabs: [] },
    record,
    initialRecord: original,
    read: (name) => record[name],
    write: (name, value) => {
      record[name] = value;
    },
    isDirty: () => true,
    controlNames: (name) => (name ? [name] : ['name']),
    controlField: (name) => name,
    notification() {},
  });
  const name = runtime.formContext.getAttribute('name');
  assert.equal(name.getIsDirty(), true, 'carrying a draft must not make that draft the persisted baseline');
  original.name = 'Changed outside the runtime';
  name.setValue('Stored');
  assert.equal(name.getIsDirty(), false, 'the runtime owns its original persisted snapshot');
  assert.equal(
    runtime.formContext.data.entity.getIsDirty(),
    true,
    'restoring the field retains the existing entity dirty latch',
  );
});
