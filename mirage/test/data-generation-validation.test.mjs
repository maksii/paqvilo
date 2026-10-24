import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDataset, findDanglingLookups, runDataCommand } from '../lib/data-generation.mjs';

const id = 'abcdef12-3456-4789-abcd-123456789abc';
const state = () => ({
  mappings: {
    sample_parent: { entitySet: 'irregularPeople', idColumn: 'record_key' },
    sample_child: { entitySet: 'irregularChildren', idColumn: 'child_key' },
  },
  tables: { sample_parent: [{ record_key: `{${id.toUpperCase()}}`, name: 'Local edit' }], sample_child: [] },
  permissions: [],
  simulator: {
    identity: { contactId: 'kept', roles: ['Local override'] },
    contactRoles: [{ contactId: 'kept', roleId: 'kept-role' }],
  },
});

test('additive generation and dangling lookup checks use shared decorated GUID identity semantics with custom mappings', () => {
  const original = state(),
    before = structuredClone(original);
  const fragment = {
    tables: {
      sample_parent: [{ record_key: id, name: 'Generated replacement' }],
      sample_child: [{ child_key: 'one', parent_ref: { id: `(${id.toUpperCase()})`, logical_name: 'sample_parent' } }],
    },
  };
  const merged = mergeDataset(original, fragment);
  assert.equal(merged.state.tables.sample_parent.length, 1);
  assert.equal(merged.state.tables.sample_parent[0].name, 'Local edit');
  assert.deepEqual(merged.report.generated.sample_parent, { added: 0, alreadyPresent: 1 });
  assert.deepEqual(findDanglingLookups(merged.state), []);
  assert.deepEqual(merged.state.simulator, original.simulator);
  assert.deepEqual(original, before, 'merge remains detached from caller state');
  assert.equal(mergeDataset(merged.state, fragment).report.generated.sample_child.added, 0);
  assert.throws(
    () =>
      mergeDataset(original, {
        tables: {
          sample_child: [{ child_key: 'broken', parent_ref: { id: 'not-present', logical_name: 'sample_parent' } }],
        },
      }),
    /unresolved lookup/,
  );
});

test('malformed dataset, base and existing state shapes fail with source-specific diagnostics before mutation', () => {
  const original = state(),
    before = structuredClone(original);
  const invalid = [
    [null, /Dataset must be a dataset object/],
    [{ tables: [] }, /Dataset.tables must be an object/],
    [{ tables: { sample_child: { child_key: 'one' } } }, /row arrays/],
    [{ tables: { sample_child: [null] } }, /rows must be objects/],
    [{ tables: { sample_child: Array(1) } }, /rows must be objects/],
    [{ permissions: { id: 'bad' } }, /permission objects/],
    [{ permissions: [null] }, /permission objects/],
    [{ permissions: Array(1) }, /permission objects/],
    [{ mappings: { sample_child: null } }, /mapping objects/],
    [{ mappings: { sample_child: { idColumn: 'bad name' } } }, /idColumn must be a valid name/],
    [JSON.parse('{"tables":{"__proto__":[]}}'), /valid table names/],
  ];
  for (const [fragment, expected] of invalid)
    assert.throws(
      () => mergeDataset(original, fragment),
      (error) => error.name === 'Error' && expected.test(error.message),
    );
  assert.throws(
    () => mergeDataset(original, {}, { basePreset: { tables: [] } }),
    /Base preset.tables must be an object/,
  );
  assert.throws(() => mergeDataset({ ...original, tables: [] }, {}), /State.tables must be an object/);
  assert.deepEqual(original, before);
});

test('data command rejects extra positional arguments before loading packs or writing state', async () => {
  for (const action of ['generate', 'scaffold'])
    await assert.rejects(
      runDataCommand([action, 'unexpected'], { state: 'unused-state.json', pack: 'unused-pack' }),
      /unexpected positional arguments/,
    );
  await assert.rejects(runDataCommand(['generate'], { rows: '3' }), /--rows is supported only by data scaffold/);
  for (const name of ['pack', 'pack-module', 'count', 'materialize-persona-memberships'])
    await assert.rejects(
      runDataCommand(['scaffold'], { [name]: 'fixture' }),
      new RegExp(`--${name} is supported only by data generate`),
    );
});

test('inherited object names remain own dataset keys without mutating prototype functions', () => {
  const names = Object.getOwnPropertyNames(Object.prototype).filter(
    (name) => !['__proto__', 'constructor', 'prototype'].includes(name),
  );
  const descriptors = Object.fromEntries(
    names.map((name) => [name, Object.getOwnPropertyDescriptors(Object.prototype[name])]),
  );
  const mappings = Object.fromEntries(names.map((name) => [name, { idColumn: 'id' }]));
  const tables = Object.fromEntries(names.map((name) => [name, [{ id: 'one' }]]));
  const original = { mappings: {}, tables: {}, permissions: [] };
  const merged = mergeDataset(original, { mappings, tables });
  for (const name of names) {
    assert.ok(Object.hasOwn(merged.state.mappings, name), name);
    assert.ok(Object.hasOwn(merged.state.tables, name), name);
    assert.ok(Object.hasOwn(merged.report.generated, name), name);
    assert.deepEqual(merged.report.generated[name], { added: 1, alreadyPresent: 0 });
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype[name]), descriptors[name], name);
  }
  const repeated = mergeDataset(merged.state, { mappings, tables });
  for (const name of names) assert.deepEqual(repeated.report.generated[name], { added: 0, alreadyPresent: 1 });
  assert.deepEqual(original, { mappings: {}, tables: {}, permissions: [] });
  const base = mergeDataset(original, {}, { basePreset: { mappings, tables } });
  for (const name of names) assert.deepEqual(base.report.base[name], { added: 1, alreadyPresent: 0 });
});

test('lookup indexes and primary keys require own values, including object prototype names', () => {
  const original = { mappings: { sample: { idColumn: 'toString' } }, tables: {}, permissions: [] };
  assert.throws(
    () => mergeDataset(original, { tables: { sample: [{ name: 'missing key' }] } }),
    /row without toString/,
  );
  const merged = mergeDataset(original, { tables: { sample: [{ toString: 'one' }] } });
  assert.equal(merged.state.tables.sample[0].toString, 'one');
  const lookups = {
    mappings: { sample: { idColumn: 'id' } },
    tables: { sample: [{ id: 'one', related: { logical_name: 'toString', id: 'absent' } }] },
    permissions: [],
  };
  assert.deepEqual(findDanglingLookups(lookups), [
    { table: 'sample', id: 'one', field: 'related', target: 'toString', value: 'absent' },
  ]);
  assert.deepEqual(findDanglingLookups(lookups, ['toString']), []);
});

test('schema-complete fields use own metadata keys when validating prototype-named row fields', () => {
  const original = {
    mappings: { sample: { idColumn: 'id', schemaComplete: true, fieldMetadata: { id: { dataverseType: 'string' } } } },
    tables: { sample: [] },
    permissions: [],
  };
  assert.throws(
    () => mergeDataset(original, { tables: { sample: [{ id: 'one', toString: 'unmapped' }] } }),
    (error) => error.name === 'Error' && /toString: unknown column/.test(error.message),
  );
  original.mappings.sample.fieldMetadata.toString = { dataverseType: 'string' };
  assert.equal(
    mergeDataset(original, { tables: { sample: [{ id: 'one', toString: 'mapped' }] } }).state.tables.sample[0].toString,
    'mapped',
  );
});
