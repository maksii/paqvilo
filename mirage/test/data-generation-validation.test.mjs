// @test-kind contract: Paqvilo's offline data generation and additive merge over paged record state
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDataset, findDanglingLookups, runDataCommand } from '../lib/data-generation.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { defineLazyPreset } from '../lib/preset-registry.mjs';
import { pagedRecordsOf } from '../lib/record-tables.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

test('offline generation preserves paged input, copies a standalone output and closes readers on success and failure', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-paged-generation-')),
    owner = ownedFixture(t),
    file = path.join(root, 'state.json'),
    out = path.join(root, 'copied.json'),
    dataset = path.join(root, 'dataset.json'),
    pack = path.join(root, 'pack.mjs'),
    presets = {};
  owner.remove(() => fs.rm(root, { recursive: true, force: true }));
  defineLazyPreset(presets, 'invented', {
    name: 'Invented records',
    createOwned({ records }) {
      function* rows() {
        for (let index = 0; index < 6000; index++) yield { itemid: 'row-' + index, name: 'Local ' + index };
      }
      return {
        mappings: { item: { idColumn: 'itemid' } },
        tables: { item: records.table(rows(), { primaryKey: 'itemid' }) },
      };
    },
  });
  const source = await new DataStore({ file, presetLibrary: presets }).init();
  owner.add(() => source.closeRecordStorage());
  await source.applyPreset('invented', { returnSnapshot: false });
  source.closeRecordStorage();
  await fs.writeFile(
    pack,
    `import fs from 'node:fs'; export default { id: 'fixture', name: 'Fixture', description: 'Invented rows', matches: () => true, presets: () => ({}), dataset: () => JSON.parse(fs.readFileSync(new URL('./dataset.json', import.meta.url), 'utf8')) };`,
  );
  await fs.writeFile(
    dataset,
    JSON.stringify({
      tables: {
        item: [
          { itemid: 'row-3', name: 'Generated replacement' },
          { itemid: 'new-row', name: 'Added', related: { logical_name: 'item', id: 'row-0' } },
        ],
      },
    }),
  );
  const generate = (output) =>
    runDataCommand(['generate'], {
      pack: 'fixture',
      'pack-module': [pack],
      state: file,
      ...(output ? { out: output } : {}),
    });
  const leases = async (state) => (await fs.readdir(state + '.records')).filter((name) => name.endsWith('.lease'));
  assert.equal((await generate()).rows.item.added, 1);
  assert.deepEqual(await leases(file), []);
  assert.equal((await generate(out)).rows.item.alreadyPresent, 2);
  assert.deepEqual(await leases(file), []);
  assert.deepEqual(await leases(out), []);
  const portal = path.join(root, 'portal'),
    scaffolded = path.join(root, 'scaffolded.json');
  await fs.mkdir(path.join(portal, 'web-pages'), { recursive: true });
  await fs.writeFile(path.join(portal, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented offline source\n');
  await runDataCommand(['scaffold'], { state: file, out: scaffolded, source: portal, profile: 'smoke' });
  assert.deepEqual(await leases(file), []);
  assert.deepEqual(await leases(scaffolded), []);
  for (const target of [file, out, scaffolded]) {
    const restored = await new DataStore({ file: target }).init();
    owner.add(() => restored.closeRecordStorage());
    assert.ok(pagedRecordsOf(restored.state.tables.item));
    assert.equal(restored.state.tables.item.length, 6001);
    assert.equal(restored.state.tables.item[3].name, 'Local 3');
    assert.equal(restored.state.tables.item.at(-1).name, 'Added');
    const preview = mergeDataset(restored.state, { tables: { item: [] } });
    assert.equal(
      pagedRecordsOf(preview.state.tables.item),
      undefined,
      'The public merge still returns detached ordinary arrays.',
    );
    preview.state.tables.item[3].name = 'Preview edit';
    assert.equal(restored.state.tables.item[3].name, 'Local 3');
    restored.closeRecordStorage();
  }
  const before = await fs.readFile(file);
  await fs.writeFile(dataset, JSON.stringify({ tables: { item: [null] } }));
  await assert.rejects(generate(), /rows must be objects/);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(await leases(file), []);
});

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

test('scaffold rows without the mapped key are appended even when existing rows lack the key too', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-scaffold-keys-')),
    owner = ownedFixture(t);
  owner.remove(() => fs.rm(root, { recursive: true, force: true }));
  const portal = path.join(root, 'portal'),
    solution = path.join(root, 'solution'),
    file = path.join(root, 'state.json');
  await fs.mkdir(portal, { recursive: true });
  await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
  await fs.writeFile(path.join(portal, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented scaffold keys\n');
  await fs.writeFile(path.join(portal, 'sitesetting.yml'), '- adx_name: Webapi/x_item/enabled\n  adx_value: "true"\n');
  await fs.writeFile(
    path.join(solution, 'Other', 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>invented</UniqueName></SolutionManifest></ImportExportXml>',
  );
  const attribute = (name, type, extra = '') =>
    `<attribute PhysicalName="${name}"><Type>${type}</Type><LogicalName>${name}</LogicalName>${extra}</attribute>`;
  await fs.writeFile(
    path.join(solution, 'Other', 'Customizations.xml'),
    `<ImportExportXml><Entities><Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><attributes>${attribute('x_itemid', 'primarykey')}${attribute('x_name', 'nvarchar', '<DisplayMask>PrimaryName|ValidForForm</DisplayMask><MaxLength>100</MaxLength>')}</attributes><EntitySetName>x_items</EntitySetName></entity></EntityInfo></Entity></Entities></ImportExportXml>`,
  );
  // The configured mapping names a key that neither the existing row nor the generated rows carry.
  const store = new DataStore({
    file,
    state: {
      mappings: { x_item: { idColumn: 'x_customid', entitySet: 'x_items', userConfigured: true } },
      tables: { x_item: [{ x_name: 'Existing without key' }] },
    },
  });
  await store.init();
  await store.save();
  const result = await runDataCommand(['scaffold'], {
    state: file,
    source: portal,
    'solution-root': [solution],
    profile: 'smoke',
  });
  assert.deepEqual(result.rows.x_item, { added: 3, alreadyPresent: 0 });
  const saved = await new DataStore({ file }).init();
  owner.add(() => saved.closeRecordStorage());
  assert.equal(saved.state.tables.x_item.length, 4);
});

// Saves a state file whose item table is paged on disk, as a large generated state is stored.
async function savePagedState(owner, file, { mappings, tables }) {
  const presetLibrary = {};
  defineLazyPreset(presetLibrary, 'invented', {
    name: 'Invented records',
    createOwned: ({ records }) => ({
      mappings,
      tables: { ...tables, item: records.table(tables.item, { primaryKey: 'itemid' }) },
    }),
  });
  const source = await new DataStore({ file, presetLibrary }).init();
  owner.add(() => source.closeRecordStorage());
  await source.applyPreset('invented', { returnSnapshot: false });
  source.closeRecordStorage();
}
// Runs `data generate` through its public command. The pack returns `fragment`, and the state moves from `file` to `out`.
// The command copies its state with forkTables, so a paged target stays paged during the merge.
async function generateInto(directory, { file, out, fragment }) {
  const dataset = path.join(directory, 'dataset.json'),
    pack = path.join(directory, 'pack.mjs');
  await fs.writeFile(dataset, JSON.stringify(fragment));
  // The pack reads its dataset on every call, so one module serves each generation in this directory.
  await fs.writeFile(
    pack,
    `import fs from 'node:fs';
export default { id: 'fixture', name: 'Fixture', description: 'Invented rows', matches: () => true, presets: () => ({}), dataset: () => JSON.parse(fs.readFileSync(new URL('./dataset.json', import.meta.url), 'utf8')) };`,
  );
  return runDataCommand(['generate'], { pack: 'fixture', 'pack-module': [pack], state: file, out });
}
// Opens a state through its own store, closed when the test ends.
async function openState(owner, file) {
  const store = await new DataStore({ file }).init();
  owner.add(() => store.closeRecordStorage());
  return store.state;
}

test('additive merge into a paged table answers existing keys from its primary key index', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-paged-merge-')),
    owner = ownedFixture(t);
  owner.remove(() => fs.rm(root, { recursive: true, force: true }));
  const rows = Array.from({ length: 40 }, (_, index) => ({ itemid: `row-${index}`, name: `Local ${index}` })),
    fragment = {
      tables: {
        item: [
          { itemid: 'row-3', name: 'Incoming 3' },
          { itemid: 'row-7', name: 'Incoming 7' },
          { itemid: 'row-100', name: 'Added 100' },
          { itemid: 'row-101', name: 'Added 101' },
          { itemid: 'row-102', name: 'Added 102' },
        ],
      },
    };
  const state = (items) => ({ mappings: { item: { idColumn: 'itemid' } }, permissions: [], tables: { item: items } });
  const file = path.join(root, 'state.json'),
    out = path.join(root, 'merged.json'),
    plainFile = path.join(root, 'plain.json'),
    plainOut = path.join(root, 'plain-merged.json');
  await savePagedState(owner, file, { mappings: { item: { idColumn: 'itemid' } }, tables: { item: rows } });
  const proto = Object.getPrototypeOf(pagedRecordsOf((await openState(owner, file)).tables.item)),
    original = { raw: proto.raw, primaryPositions: proto.primaryPositions },
    calls = { raw: 0, primaryPositions: 0 };
  owner.add(() => Object.assign(proto, original));
  proto.raw = function (...args) {
    // The command also reads the table to digest its output after the merge returns; only merge reads count.
    if (new Error().stack.includes('mergeDatasetState')) calls.raw++;
    return original.raw.apply(this, args);
  };
  proto.primaryPositions = function (...args) {
    calls.primaryPositions++;
    return original.primaryPositions.apply(this, args);
  };
  const result = await generateInto(root, { file, out, fragment });
  const reads = calls.raw,
    lookups = calls.primaryPositions;
  assert.deepEqual(result.rows.item, { added: 3, alreadyPresent: 2 });
  const ids = Array.from((await openState(owner, out)).tables.item, (row) => row.itemid);
  assert.deepEqual(ids, [...rows.map((row) => row.itemid), 'row-100', 'row-101', 'row-102']);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(lookups, fragment.tables.item.length, 'Every incoming id is answered by the key index.');
  // The counter sees only merge reads, and the merge reads each row at least once: zero means the stack match broke.
  assert.ok(reads >= rows.length, `${reads} merge reads for ${rows.length} rows`);
  // The merge makes 83 reads for 40 rows today; one more full key scan would add 40 (123), so the bound sits between.
  const readBound = 2 * rows.length + 10;
  assert.ok(reads <= readBound, `${reads} merge reads for ${rows.length} rows, at most ${readBound}`);
  await fs.writeFile(plainFile, JSON.stringify(state(rows.map((row) => ({ ...row })))));
  const plainMerge = await generateInto(root, { file: plainFile, out: plainOut, fragment });
  assert.deepEqual(plainMerge.rows.item, result.rows.item);
  assert.deepEqual(
    Array.from((await openState(owner, plainOut)).tables.item, (row) => row.itemid),
    ids,
  );
});

test('a stored key padded with whitespace answers merges and lookups like its unpadded id', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-padded-keys-')),
    owner = ownedFixture(t);
  owner.remove(() => fs.rm(root, { recursive: true, force: true }));
  const guid = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f',
    stored = [
      { itemid: ` ${guid} `, name: 'Padded' },
      ...Array.from({ length: 20 }, (_, index) => ({ itemid: `row-${index}`, name: `Local ${index}` })),
    ],
    fragment = {
      tables: {
        item: [
          { itemid: guid, name: 'Incoming' },
          { itemid: 'row-new', name: 'Added' },
        ],
      },
    },
    child = [{ childid: 'child-1', parent: { logical_name: 'item', id: guid } }],
    mappings = { item: { idColumn: 'itemid' }, child: { idColumn: 'childid' } };
  // Each variant is a state file: the paged one keeps its item table on disk, the plain one as an array.
  const outcome = async (name, save) => {
    const file = path.join(root, name + '.json'),
      out = path.join(root, name + '-merged.json');
    await save(file);
    const result = await generateInto(root, { file, out, fragment });
    return {
      generated: result.rows.item,
      count: (await openState(owner, out)).tables.item.length,
      dangling: findDanglingLookups(await openState(owner, file), ['child']).length,
    };
  };
  const paged = await outcome('paged', (file) =>
    savePagedState(owner, file, { mappings, tables: { item: stored, child } }),
  );
  const plain = await outcome('plain', (file) =>
    fs.writeFile(
      file,
      JSON.stringify({ mappings, permissions: [], tables: { item: stored.map((row) => ({ ...row })), child } }),
    ),
  );
  assert.deepEqual(paged.generated, { added: 1, alreadyPresent: 1 });
  assert.equal(paged.count, 22);
  assert.equal(paged.dangling, 0);
  assert.deepEqual(paged, plain);
});
