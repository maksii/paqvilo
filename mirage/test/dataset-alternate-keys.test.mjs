import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset } from '../lib/dataset-generator.mjs';
import { mergeDataset } from '../lib/data-generation.mjs';
import { DataStore } from '../lib/data.mjs';
import { failDuplicateSeededKeys } from '../lib/dataverse-metadata-tables.mjs';
import { exactNumeric } from '../lib/exact-numeric.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = (attributes = ['code'], indexStatus = 'Active') => ({ name: 'sample_key', attributes, indexStatus });
const state = (rows = [], keys = [key()], collation = 'CI_AI') => ({
  mappings: { sample: { idColumn: 'sampleid', entitySet: 'samples', alternateKeys: keys } },
  tables: { sample: rows },
  permissions: [],
  settings: { collation },
});
const duplicate = (error) =>
  error.code === 'DuplicateRecord' && error.status === 412 && error.details.innerCode === '0x80040237';
const metadata = (keys = [key()]) => ({
  optionSets: {},
  targets: {},
  tables: {
    sample: {
      primaryIdAttribute: 'sampleid',
      keys,
      attributes: {
        sampleid: { name: 'sampleid', type: 'primarykey' },
        code: { name: 'code', type: 'nvarchar', maxLength: 40 },
      },
    },
  },
});

test('generation and additive merge reject active duplicate keys before returning a fragment or changed state', () => {
  const options = {
    schema: metadata(),
    counts: { sample: 2 },
    rules: { sample: { code: { kind: 'constant', value: 'same' } } },
  };
  assert.throws(() => generateDataset(options), duplicate);
  const original = state([{ sampleid: id(1), code: 'existing' }]),
    before = structuredClone(original);
  const fragment = { tables: { sample: [{ sampleid: id(2), code: 'EXISTING' }] } };
  assert.throws(() => mergeDataset(original, fragment), duplicate);
  assert.deepEqual(original, before);
  assert.deepEqual(fragment.tables.sample[0], { sampleid: id(2), code: 'EXISTING' });
  assert.throws(
    () =>
      mergeDataset(state(), {
        tables: {
          sample: [
            { sampleid: id(1), code: 'one' },
            { sampleid: id(2), code: 'ONE' },
          ],
        },
      }),
    duplicate,
  );
  assert.throws(
    () =>
      mergeDataset(state(), fragment, { basePreset: { tables: { sample: [{ sampleid: id(1), code: 'existing' }] } } }),
    duplicate,
  );
});

test('generation compares supplied existing rows and preserves primary-key additive idempotency', () => {
  const options = {
    schema: metadata(),
    counts: { sample: 1 },
    rules: { sample: { code: { kind: 'constant', value: 'same' } } },
  };
  assert.throws(
    () => generateDataset({ ...options, existing: { sample: [{ sampleid: id(1), code: 'SAME' }] } }),
    duplicate,
  );
  const fragment = generateDataset(options);
  assert.deepEqual(generateDataset({ ...options, existing: fragment.tables }), fragment);
  const original = state([
    { sampleid: fragment.tables.sample[0].sampleid, code: 'kept' },
    { sampleid: id(2), code: 'same' },
  ]);
  const merged = mergeDataset(original, fragment);
  assert.equal(merged.state.tables.sample[0].code, 'kept');
  assert.deepEqual(merged.report.generated.sample, { added: 0, alreadyPresent: 1 });
});

test('inactive keys and nullable or empty composite members do not enforce uniqueness', () => {
  const rows = [null, undefined, ''].flatMap((code, index) => [
    { sampleid: id(index * 2 + 1), code },
    { sampleid: id(index * 2 + 2), code },
  ]);
  assert.equal(mergeDataset(state(), { tables: { sample: rows } }).state.tables.sample.length, 6);
  for (const indexStatus of ['Pending', 'InProgress', 'Failed']) {
    const result = generateDataset({
      schema: metadata([key(['code'], indexStatus)]),
      counts: { sample: 2 },
      rules: { sample: { code: { kind: 'constant', value: 'same' } } },
    });
    assert.equal(mergeDataset(state([], [key(['code'], indexStatus)]), result).state.tables.sample.length, 2);
  }
  const composite = state([{ sampleid: id(1), code: 'same' }], [key(['code', 'region'])]);
  assert.doesNotThrow(() =>
    mergeDataset(composite, { tables: { sample: [{ sampleid: id(2), code: 'same', region: null }] } }),
  );
});

test('collation is shared between offline preflight and indexed runtime create/update', async () => {
  for (const collation of ['CI_AI', 'CI_AS']) {
    const original = state([{ sampleid: id(1), code: 'caf\u00e9' }], [key()], collation);
    const fragment = { tables: { sample: [{ sampleid: id(2), code: 'CAFE' }] } };
    const store = await new DataStore({ state: original }).init();
    if (collation === 'CI_AI') {
      assert.throws(() => mergeDataset(original, fragment), duplicate);
      await assert.rejects(store.create('sample', fragment.tables.sample[0], { admin: true }), duplicate);
    } else {
      assert.equal(mergeDataset(original, fragment).state.tables.sample.length, 2);
      await store.create('sample', fragment.tables.sample[0], { admin: true });
      await assert.rejects(store.update('sample', id(2), { code: 'CAF\u00c9' }, { admin: true }), duplicate);
      assert.equal(store.state.tables.sample[1].code, 'CAFE');
    }
  }
  const options = {
    schema: metadata(),
    counts: { sample: 1 },
    rules: { sample: { code: { kind: 'constant', value: 'CAFE' } } },
    existing: { sample: [{ sampleid: id(1), code: 'caf\u00e9' }] },
  };
  assert.throws(() => generateDataset(options), duplicate);
  assert.equal(generateDataset({ ...options, collation: 'CI_AS' }).tables.sample.length, 1);
});

test('unambiguous composite tuples do not collide when member text contains NUL separators', async () => {
  const original = state([{ sampleid: id(1), code: 'a\0b', region: 'c' }], [key(['code', 'region'])]);
  const row = { sampleid: id(2), code: 'a', region: 'b\0c' };
  assert.equal(mergeDataset(original, { tables: { sample: [row] } }).state.tables.sample.length, 2);
  const store = await new DataStore({ state: original }).init();
  await store.transact(async () => {
    store.createRecord('sample', row, { admin: true });
    assert.throws(() => store.createRecord('sample', { ...row, sampleid: id(3) }, { admin: true }), duplicate);
  });
  assert.equal(store.state.tables.sample.length, 2);
});

test('lookup GUID wrappers, exact numeric digits and established scalar coercions retain uniqueness semantics', async () => {
  for (const [left, right] of [
    [{ id: `{${id(7).toUpperCase()}}`, logical_name: 'sample' }, `(${id(7)})`],
    [{ value: 1, label: 'one' }, true],
    [exactNumeric('9007199254740993', 'Int64'), '9007199254740993'],
  ]) {
    const original = state([{ sampleid: id(1), code: left }]);
    // References are checked separately by mergeDataset; call the shared runtime path for lookup wrappers.
    const store = await new DataStore({ state: original }).init();
    await assert.rejects(store.create('sample', { sampleid: id(2), code: right }, { admin: true }), duplicate);
    assert.throws(() => mergeDataset(original, { tables: { sample: [{ sampleid: id(2), code: right }] } }), duplicate);
  }
  const original = state([{ sampleid: id(1), code: exactNumeric('9007199254740993', 'Int64') }]);
  assert.equal(
    mergeDataset(original, {
      tables: { sample: [{ sampleid: id(2), code: exactNumeric('9007199254740992', 'Int64') }] },
    }).state.tables.sample.length,
    2,
  );
});

test('repeated uniqueness checks inside one transaction reuse the scoped key index', async () => {
  const store = await new DataStore({ state: state() }).init();
  let reads = 0;
  const rows = Array.from({ length: 500 }, (_, index) => ({
    sampleid: id(index + 1),
    get code() {
      reads++;
      return `code-${index}`;
    },
  }));
  await store.transact(() => {
    for (let index = 0; index < 100; index++)
      assert.throws(
        () =>
          store.assertAlternateKeys(
            store.state.mappings.sample,
            { sampleid: id(900), code: `CODE-${index}` },
            rows,
            -1,
          ),
        duplicate,
      );
  });
  assert.ok(reads >= 500 && reads < 1000, `expected one build and bounded bucket checks, got ${reads} field reads`);
});

test('seeded index activation uses the same configured collation and unambiguous tuples atomically', async () => {
  for (const collation of ['CI_AI', 'CI_AS']) {
    const definition = key();
    delete definition.indexStatus;
    const store = await new DataStore({
      state: state(
        [
          { sampleid: id(1), code: 'caf\u00e9' },
          { sampleid: id(2), code: 'CAFE' },
        ],
        [definition],
        collation,
      ),
    }).init();
    const before = structuredClone(store.state);
    await assert.rejects(
      store.transact(() => {
        failDuplicateSeededKeys({ store });
        throw new Error('Rollback activation');
      }),
      /Rollback activation/,
    );
    assert.deepEqual(store.state, before);
    const diagnostics = [];
    await store.transact(() => failDuplicateSeededKeys({ store }, (entry) => diagnostics.push(entry)));
    assert.equal(
      store.state.mappings.sample.alternateKeys[0].indexStatus,
      collation === 'CI_AI' ? 'Failed' : undefined,
    );
    assert.equal(diagnostics.length, collation === 'CI_AI' ? 1 : 0);
  }
  const definition = key(['code', 'region']);
  delete definition.indexStatus;
  const store = await new DataStore({
    state: state(
      [
        { sampleid: id(1), code: 'a\u0001s:b', region: 'c' },
        { sampleid: id(2), code: 'a', region: 'b\u0001s:c' },
      ],
      [definition],
    ),
  }).init();
  await store.transact(() => failDuplicateSeededKeys({ store }));
  assert.equal(store.state.mappings.sample.alternateKeys[0].indexStatus, undefined);
});

test('typed datetime and decimal keys normalize identically for offline merge, activation and runtime uniqueness', async () => {
  for (const [type, values] of [
    ['datetime', ['2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T02:00:00+02:00']],
    ['decimal', [{ value: '1' }, { value: '1.00' }]],
  ]) {
    const original = state([{ sampleid: id(1), code: values[0] }]);
    original.mappings.sample.fieldMetadata = { code: { dataverseType: type } };
    const before = structuredClone(original);
    assert.throws(
      () => mergeDataset(original, { tables: { sample: [{ sampleid: id(2), code: values[1] }] } }),
      duplicate,
    );
    assert.deepEqual(original, before);
    const store = await new DataStore({ state: original }).init();
    await assert.rejects(store.create('sample', { sampleid: id(2), code: values[1] }, { admin: true }), duplicate);
    original.tables.sample = values.map((code, index) => ({ sampleid: id(index + 1), code }));
    delete original.mappings.sample.alternateKeys[0].indexStatus;
    const diagnostics = [];
    failDuplicateSeededKeys({ store: { state: original } }, (entry) => diagnostics.push(entry));
    assert.equal(original.mappings.sample.alternateKeys[0].indexStatus, 'Failed');
    assert.equal(diagnostics[0].code, 'ALTERNATE_KEY_DUPLICATES');
  }
});

test('datetime generation catches equivalent timestamp spellings and existing instants before returning a fragment', () => {
  const schema = metadata();
  schema.tables.sample.attributes.code.type = 'datetime';
  const values = ['2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T02:00:00+02:00'];
  assert.throws(
    () => generateDataset({ schema, counts: { sample: 3 }, rules: { sample: { code: { kind: 'one-of', values } } } }),
    duplicate,
  );
  assert.throws(
    () =>
      generateDataset({
        schema,
        counts: { sample: 1 },
        rules: { sample: { code: { kind: 'constant', value: values[1] } } },
        existing: { sample: [{ sampleid: id(1), code: values[2] }] },
      }),
    duplicate,
  );
});

test('runtime uniqueness index identity includes source kinds when metadata changes inside one transaction', async () => {
  const original = state([{ sampleid: id(1), code: '2026-01-01' }]);
  original.mappings.sample.fields = { code: { dataverseType: 'nvarchar' } };
  const store = await new DataStore({ state: original }).init();
  const before = structuredClone(store.state);
  await assert.rejects(
    store.transact(() => {
      store.createRecord('sample', { sampleid: id(2), code: '2026-01-01T00:00:00Z' }, { admin: true });
      store.state.mappings.sample.fields.code.dataverseType = 'datetime';
      assert.throws(
        () => store.createRecord('sample', { sampleid: id(3), code: '2026-01-01T02:00:00+02:00' }, { admin: true }),
        duplicate,
      );
      throw new Error('restore changed metadata and rows');
    }),
    /restore changed metadata/,
  );
  assert.deepEqual(store.state, before);
});
