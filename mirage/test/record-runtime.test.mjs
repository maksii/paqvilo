import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { defineLazyPreset } from '../lib/preset-registry.mjs';
import { pagedRecordsOf } from '../lib/record-tables.mjs';
import { createSimulator } from '../server.mjs';
import { exactNumeric } from '../lib/exact-numeric.mjs';
import { readStateFile } from '../lib/state-storage.mjs';

const admin = { admin: true };
const library = () => {
  const presets = {};
  defineLazyPreset(presets, 'invented', {
    name: 'Invented stream',
    createOwned({ records }) {
      function* rows() {
        for (let i = 0; i < 6000; i++)
          yield { itemid: 'row-' + i, name: 'Invented ' + i, quantity: i, nested: { value: i } };
      }
      return {
        mappings: { item: { idColumn: 'itemid', entitySet: 'items', nameColumn: 'name' } },
        tables: { item: records.table(rows(), { primaryKey: 'itemid' }) },
      };
    },
  });
  return presets;
};

test('streamed presets retain CRUD, query, FetchXML, isolated rollback, checkpoint and restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invented-record-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json'),
    presets = library();
  const store = new DataStore({ file, presetLibrary: presets });
  t.after(() => store.closeRecordStorage());
  await store.init();
  await store.applyPreset('invented', { returnSnapshot: false });
  assert.ok(pagedRecordsOf(store.state.tables.item));
  assert.match(await fs.readFile(file, 'utf8'), /^\{"\$paqvilo":"mirage-state-journal-v2"\}/);
  assert.equal(store.get('items', 'row-5000', admin).name, 'Invented 5000');
  assert.deepEqual(
    store.query('items', { $select: 'name', $filter: 'quantity ge 5998' }, admin).value.map((row) => row.name),
    ['Invented 5998', 'Invented 5999'],
  );
  const fetch = store.fetchXml(
    '<fetch count="2"><entity name="item"><attribute name="name"/><filter><condition attribute="quantity" operator="ge" value="5998"/></filter></entity></fetch>',
    admin,
  );
  assert.deepEqual(
    fetch.entities.map((row) => row.name),
    ['Invented 5998', 'Invented 5999'],
  );
  const snapshot = store.snapshot({ tables: ['item'] });
  await store.update('items', 'row-5000', { name: 'Changed' }, admin);
  assert.equal(snapshot.tables.item[5000].name, 'Invented 5000');
  assert.equal(pagedRecordsOf(snapshot.tables.item), undefined);
  await assert.rejects(
    store.transact(
      async () => {
        await store.update('items', 'row-5000', { name: 'Rolled back' }, admin);
        throw Error('Invented abort');
      },
      { isolated: true },
    ),
    /Invented abort/,
  );
  assert.equal(store.get('items', 'row-5000', admin).name, 'Changed');
  await store.create('items', { itemid: 'added', name: 'Added' }, admin);
  await store.remove('items', 'row-2', admin);
  await store.compact();
  const restarted = new DataStore({ file, presetLibrary: presets });
  t.after(() => restarted.closeRecordStorage());
  await restarted.init();
  assert.ok(pagedRecordsOf(restarted.state.tables.item));
  assert.equal(restarted.state.tables.item.length, 6000);
  assert.equal(restarted.get('items', 'row-5000', admin).name, 'Changed');
  assert.equal(restarted.get('items', 'added', admin).name, 'Added');
  assert.equal(restarted.get('items', 'row-2', admin), null);
  await restarted.update('items', 'added', { name: 'After restart' }, admin);
  assert.equal(restarted.get('items', 'added', admin).name, 'After restart');
  const publicRead = await readStateFile(file);
  assert.equal(pagedRecordsOf(publicRead.tables.item), undefined);
  assert.equal(structuredClone(publicRead).tables.item.length, 6000);
});

test('failed compaction retains held rows and durable state and removes unpublished page files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invented-record-compact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json'),
    store = new DataStore({ file, presetLibrary: library() });
  t.after(() => store.closeRecordStorage());
  await store.init();
  await store.applyPreset('invented', { returnSnapshot: false });
  const rows = store.state.tables.item,
    held = rows[200],
    before = await fs.readFile(file),
    pages = (await fs.readdir(file + '.records')).filter((name) => name.endsWith('.pages'));
  const prepare = store.storage.prepareCheckpoint.bind(store.storage);
  store.storage.prepareCheckpoint = async () => {
    throw Error('Invented compaction checkpoint');
  };
  await assert.rejects(store.compact(), /Invented compaction checkpoint/);
  assert.equal(store.state.tables.item, rows);
  assert.equal(rows[200], held);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(
    (await fs.readdir(file + '.records')).filter((name) => name.endsWith('.pages')),
    pages,
  );
  store.storage.prepareCheckpoint = prepare;
  await store.compact();
  assert.equal(store.state.tables.item, rows);
  assert.equal(rows[200], held);
  held.name = 'After compact';
  await store.save();
  assert.equal((await readStateFile(file)).tables.item[200].name, 'After compact');
});

test('failed writes roll back without further page writes and preserve the key index while the disk remains unwritable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invented-record-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json'),
    store = new DataStore({ file, presetLibrary: library() });
  t.after(() => store.closeRecordStorage());
  await store.init();
  await store.applyPreset('invented', { returnSnapshot: false });
  const held = store.state.tables.item[100],
    before = await fs.readFile(file),
    writer = store.recordSession.writer(),
    io = writer.io;
  let writes = 0;
  writer.io = {
    ...io,
    writeSync() {
      writes++;
      throw Error('Invented disk full');
    },
  };
  await assert.rejects(
    store.update('items', 'row-100', { name: 'Failed edit', quantity: 9 }, admin),
    /Invented disk full/,
  );
  assert.equal(held.name, 'Invented 100');
  assert.deepEqual(pagedRecordsOf(store.state.tables.item).primaryPositions('itemid', 'row-100'), [100]);
  const failedWrites = writes;
  assert.equal(store.get('items', 'row-101', admin).name, 'Invented 101');
  assert.equal(writes, failedWrites, 'Reads never flush failed pending data.');
  assert.deepEqual(await fs.readFile(file), before);
  writer.io = io;
  await store.update('items', 'row-100', { name: 'Retried edit' }, admin);
  assert.equal((await readStateFile(file)).tables.item[100].name, 'Retried edit');
});

test('an in-memory streamed store can bind a persistence file without leaving references to its temporary directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invented-record-binding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DataStore({ presetLibrary: library() });
  t.after(() => store.closeRecordStorage());
  await store.applyPreset('invented', { returnSnapshot: false });
  const held = store.state.tables.item[50],
    file = path.join(root, 'bound.json');
  store.file = file;
  await store.init();
  assert.equal(store.state.tables.item[50], held);
  assert.equal(store.recordSession.directory, await fs.realpath(file + '.records'));
  const reopened = new DataStore({ file });
  t.after(() => reopened.closeRecordStorage());
  await reopened.init();
  assert.equal(reopened.get('items', 'row-50', admin).name, 'Invented 50');
});

test('a foreign record directory cannot be committed as an unreadable local state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invented-record-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = new DataStore({ presetLibrary: library() });
  t.after(() => source.closeRecordStorage());
  await source.applyPreset('invented', { returnSnapshot: false });
  const file = path.join(root, 'state.json'),
    destination = new DataStore({ file });
  t.after(() => destination.closeRecordStorage());
  await destination.init();
  const before = await fs.readFile(file);
  await assert.rejects(destination.replaceState(source.state), { code: 'InvalidRecordStorage' });
  assert.deepEqual(await fs.readFile(file), before);
  await destination.replaceState(source.snapshot(), { returnSnapshot: false });
  assert.equal((await readStateFile(file)).tables.item.length, 6000);
});

test('saved record presets fork privately without decoding every saved row during unrelated writes or reapplication', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invented-record-presets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DataStore({ file: path.join(root, 'state.json'), presetLibrary: library() });
  t.after(() => store.closeRecordStorage());
  await store.init();
  await store.applyPreset('invented', { returnSnapshot: false });
  store.state.presets.saved = {
    name: 'Saved',
    userConfigured: true,
    tables: { item: pagedRecordsOf(store.state.tables.item).fork() },
  };
  await store.save();
  let reads = 0;
  const read = store.recordSession.readRow.bind(store.recordSession);
  store.recordSession.readRow = (...args) => {
    if (++reads > 50) throw Error('Unexpected saved-body scan');
    return read(...args);
  };
  await store.update('items', 'row-100', { name: 'Changed' }, admin);
  await store.applyPreset('saved', { returnSnapshot: false });
  assert.equal(store.get('items', 'row-100', admin).name, 'Invented 100');
  assert.ok(reads <= 50);
  assert.ok(pagedRecordsOf(store.state.tables.item));
});

test('related reads and lookup labels use bounded primary-key subsets with security and duplicate ordering intact', async (t) => {
  const store = new DataStore({
    state: {
      mappings: {
        parent: { idColumn: 'id', nameColumn: 'name' },
        child: {
          idColumn: 'id',
          relationships: { parent: { entity: 'parent', from: 'parentid', to: 'id', many: false } },
        },
      },
      tables: { parent: [], child: [{ id: 'child', parentid: 'id-70000' }] },
      permissions: [{ entity: 'parent', scope: 'contact', field: 'contactid', roles: ['Member'] }],
    },
  });
  t.after(() => store.closeRecordStorage());
  const context = store.recordContext();
  const preset = {};
  defineLazyPreset(preset, 'parents', {
    name: 'Invented parents',
    createOwned({ records }) {
      function* rows() {
        for (let i = 0; i < 80000; i++) yield { id: 'id-' + i, name: 'Parent ' + i, contactid: 'person' };
        yield { id: 'id-70000', name: 'Last duplicate', contactid: 'other' };
      }
      return { tables: { parent: records.table(rows(), { primaryKey: 'id' }) } };
    },
  });
  const { resolvePreset } = await import('../lib/presets.mjs');
  store.state.tables.parent = resolvePreset(store.state, 'parents', preset, context).tables.parent;
  const session = store.recordSession,
    read = session.readRow.bind(session);
  let reads = 0;
  session.readRow = (...args) => {
    reads++;
    return read(...args);
  };
  const identity = { id: 'person', roles: ['Member'] },
    query = store.queryContext(identity);
  const related = query.related(store.state.tables.child[0], store.state.mappings.child.relationships.parent);
  assert.deepEqual(
    related.map((row) => row.name),
    ['Parent 70000'],
  );
  assert.equal(query.lookupName({ logical_name: 'parent', id: 'id-70000' }), 'Last duplicate');
  assert.equal(query.lookupName({ logical_name: 'parent', id: 'ID-70000' }), 'Last duplicate');
  assert.ok(reads <= 3, 'Only selected rows are decoded, including the permitted and denied duplicates.');
  assert.equal(query.lookupName({ logical_name: 'parent', id: null }), undefined);
});

test('public preset previews stay ordinary arrays and loopback startup keeps streamed storage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invented-record-server-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'website.yml'), 'adx_websiteid: invented\nadx_name: Invented stream');
  const entry = Object.getOwnPropertyDescriptor(library(), 'invented').get;
  assert.equal(pagedRecordsOf(entry().tables.item), undefined);
  assert.equal(structuredClone(entry()).tables.item.length, 6000);
  const pack = {
    id: 'invented-stream',
    name: 'Invented stream',
    description: 'Invented',
    matches: () => true,
    presets: () => ({
      invented: {
        name: 'Invented stream',
        createOwned({ records }) {
          return {
            mappings: { item: { idColumn: 'itemid', entitySet: 'items' } },
            tables: {
              item: records.table(
                [{ itemid: 'one', name: 'Invented', exact: exactNumeric('9223372036854775807', 'Int64') }],
                { primaryKey: 'itemid' },
              ),
            },
          };
        },
      },
    }),
  };
  const sim = await createSimulator({
    sourceDir: root,
    stateFile: path.join(root, 'state.json'),
    watch: false,
    packs: [pack],
    preset: 'invented',
  });
  t.after(() => sim.close());
  assert.ok(pagedRecordsOf(sim.store.state.tables.item));
  assert.equal(sim.store.get('items', 'one', admin).name, 'Invented');
  const status = await fetch(sim.url + '/_sim/api/status');
  assert.equal(status.status, 200);
  await status.arrayBuffer();
  const exported = await fetch(sim.url + '/_sim/api/state/export');
  assert.equal(exported.status, 200);
  const text = await exported.text();
  assert.match(text, /"exact":9223372036854775807/);
  assert.equal(JSON.parse(text).tables.item[0].name, 'Invented');
});
