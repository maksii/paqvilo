import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from '../lib/data.mjs';
import { loadPack, validatePack } from '../lib/preset-registry.mjs';
import { createSimulationPersistence } from '../lib/simulation-persistence.mjs';
import { simulationSettings } from '../lib/simulation-settings.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const mapping = { entitySet: 'items', idColumn: 'itemid', fields: { itemid: { type: 'guid' }, name: { type: 'text' } } };
const initial = () => ({ version: 1, mappings: { item: mapping }, tables: { item: [] }, settings: { permissionMode: 'permissive' } });
async function workspace(t, level, { io, files, seed = initial() } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'paqvilo-pack-data-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const definition = files ?? [{ file: 'data.json', tables: { item: { path: ['records'], idColumn: 'itemid' } }, newTablesPath: ['newTables'], schemaPath: ['schema'] }];
  for (const file of definition) await fs.writeFile(path.join(directory, file.file), JSON.stringify({ records: [{ itemid: id, name: 'Original', sibling: 'retained' }], schema: {}, newTables: {}, unrelated: { keep: true } }, null, 2));
  const packModule = path.join(directory, 'pack.mjs');
  await fs.writeFile(path.join(directory, 'data-files.json'), JSON.stringify(definition));
  await fs.writeFile(packModule, `import dataFiles from './data-files.json' with { type: 'json' }; export default {id:'invented',name:'Invented',description:'Invented fixture',matches:()=>true,presets:()=>({}),dataFiles};`);
  const pack = await loadPack(packModule), stateFile = path.join(directory, '.runtime', 'state.json');
  const open = async () => {
    const storageAdapter = await createSimulationPersistence({ settings: { level }, packs: [pack], stateFile, io });
    const store = await new DataStore({ file: stateFile, state: seed, storageAdapter }).init();
    storageAdapter.activate(store.state);
    return store;
  };
  return { directory, stateFile, packModule, pack, open, store: await open(), dataFile: path.join(directory, definition[0].file) };
}

test('dry run edits records in memory, refuses schema, and never reads or writes a saved runtime', async t => {
  const { store, open, directory, dataFile, stateFile } = await workspace(t, 'dry-run');
  const readSnapshot = async () => {
    const handle = await fs.open(dataFile, 'r');
    try { return { bytes: await handle.readFile(), info: await handle.stat() }; }
    finally { await handle.close(); }
  };
  const before = await readSnapshot();
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, 'not runtime JSON; dry run must ignore it');
  await store.update('item', id, { name: 'Memory' });
  const created = await store.create('item', { name: 'New memory record' });
  await store.remove('item', created.itemid);
  assert.equal(store.tableRows('item')[0].name, 'Memory');
  assert.equal((await open()).tableRows('item')[0].name, 'Original');
  const after = await readSnapshot();
  assert.deepEqual(after.bytes, before.bytes);
  assert.equal(after.info.mtimeMs, before.info.mtimeMs);
  assert.equal(await fs.readFile(stateFile, 'utf8'), 'not runtime JSON; dry run must ignore it');
  const saved = store.snapshot();
  await assert.rejects(store.transact(() => { store.state.mappings.another = { idColumn: 'anotherid', entitySet: 'anothers' }; }), { code: 'SimulationSchemaDisabled' });
  assert.deepEqual(store.snapshot(), saved);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['.runtime', 'data-files.json', 'data.json', 'pack.mjs']);
});

test('simulation updates the existing DATA file directly and survives a clean restart', async t => {
  const { store, open, dataFile, packModule } = await workspace(t, 'simulation');
  const source = await fs.readFile(packModule);
  await store.update('item', id, { name: 'Persisted' });
  const created = await store.create('item', { name: 'Second' });
  let document = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(document.records[0].name, 'Persisted');
  assert.equal(document.records[0].sibling, 'retained');
  assert.deepEqual(document.unrelated, { keep: true });
  assert.deepEqual(document.schema, {});
  assert.equal(document.records[1].itemid, created.itemid);
  assert.equal((await open()).tableRows('item').length, 2);
  await store.remove('item', id);
  document = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(document.records.length, 1);
  assert.equal((await open()).tableRows('item')[0].itemid, created.itemid);
  assert.deepEqual(await fs.readFile(packModule), source);
});

test('simulation rejects all schema changes and undeclared business tables without partial state', async t => {
  const { store, dataFile } = await workspace(t, 'simulation');
  const before = await fs.readFile(dataFile), saved = store.snapshot();
  await assert.rejects(store.transact(() => { store.state.mappings.item.fields.extra = { type: 'text' }; }), { code: 'SimulationSchemaDisabled' });
  assert.deepEqual(store.snapshot(), saved);
  await assert.rejects(store.transact(() => { store.state.mappings.other = { idColumn: 'otherid', entitySet: 'others' }; store.state.tables.other = []; }), { code: 'SimulationSchemaDisabled' });
  assert.deepEqual(await fs.readFile(dataFile), before);
});

test('an undeclared plug-in secondary business write rolls back its primary record and every file', async t => {
  const seed = initial();
  seed.mappings.other = { idColumn: 'otherid', entitySet: 'others' }; seed.tables.other = [];
  seed.plugins = [{ entity: 'item', operations: ['update'], secondary: [{ entity: 'other', operation: 'create', set: { name: 'Secondary' } }] }];
  const { store, dataFile } = await workspace(t, 'simulation', { seed });
  const before = store.snapshot(), bytes = await fs.readFile(dataFile);
  let events = 0; store.addCommittedEvents(() => events++);
  await assert.rejects(store.update('item', id, { name: 'Must roll back' }), { code: 'SimulationDataTargetRequired' });
  assert.deepEqual(store.snapshot(), before); assert.deepEqual(await fs.readFile(dataFile), bytes);
  assert.equal(events, 0);
});

test('pack identity preserves elastic partition case and canonical GUID equality', async t => {
  const seed = initial(); seed.mappings.item = { ...mapping, tableType: 'Elastic' };
  const { store, dataFile, open } = await workspace(t, 'simulation', { seed });
  await store.transact(() => {
    store.state.tables.item = [{ itemid: id, partitionid: 'Region', name: 'Upper' }, { itemid: id.toUpperCase(), partitionid: 'region', name: 'Lower' }];
  });
  const restarted = await open();
  assert.equal(restarted.tableRows('item').length, 2);
  await restarted.transact(() => { restarted.state.tables.item[1].name = 'One changed partition'; });
  assert.equal(restarted.storageAdapter.report(restarted.state).dirtyRecords, 1);
  assert.equal(JSON.parse(await fs.readFile(dataFile, 'utf8')).records[1].name, 'One changed partition');
  const snapshot = restarted.snapshot();
  await assert.rejects(restarted.transact(() => { restarted.state.tables.item.push({ itemid: `{${id}}`, partitionid: 'Region', name: 'Duplicate' }); }), /duplicate record identity/);
  assert.deepEqual(restarted.snapshot(), snapshot);
});

test('deep simulation stores normalized schema and new-table records in declared existing DATA', async t => {
  const { store, open, dataFile } = await workspace(t, 'deep');
  await store.transact(() => {
    store.state.mappings.extra = { entitySet: 'extras', idColumn: 'extraid', fields: { name: { type: 'text' } } };
    store.state.tables.extra = [{ extraid: id, name: 'Added table' }];
    store.state.dataverse ??= {};
    store.state.dataverse.passwords = { private: 'hashed-only-private-runtime' };
  });
  const document = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(document.schema.mappings.extra.idColumn, 'extraid');
  assert.equal(document.newTables.extra[0].name, 'Added table');
  assert.ok(!JSON.stringify(document).includes('hashed-only-private-runtime'));
  let restarted = await open();
  assert.equal(restarted.tableRows('extra')[0].extraid, id);
  await store.transact(() => { delete store.state.mappings.extra; delete store.state.tables.extra; });
  restarted = await open();
  assert.equal(restarted.state.mappings.extra, undefined);
  assert.equal(JSON.parse(await fs.readFile(dataFile, 'utf8')).newTables.extra, undefined);
});

test('external edits fail CAS and preserve the external file, runtime memory and committed events', async t => {
  const { store, dataFile } = await workspace(t, 'simulation');
  let events = 0; store.addCommittedEvents(() => events++);
  const saved = store.snapshot();
  const external = JSON.parse(await fs.readFile(dataFile, 'utf8')); external.unrelated.external = true;
  await fs.writeFile(dataFile, JSON.stringify(external));
  await assert.rejects(store.update('item', id, { name: 'Lost update' }), { code: 'PackDataConflict' });
  assert.deepEqual(store.snapshot(), saved);
  assert.deepEqual(JSON.parse(await fs.readFile(dataFile, 'utf8')), external);
  assert.equal(events, 0);
});

test('custom API operation definitions require deep simulation and survive from declared schema DATA', async t => {
  for (const level of ['dry-run', 'simulation', 'deep']) {
    const { store, dataFile, stateFile, open } = await workspace(t, level);
    const before = store.snapshot(), bytes = await fs.readFile(dataFile);
    const change = () => store.transact(() => {
      store.state.tables.customapi = [{ customapiid: id, uniquename: 'invented_Operation' }];
      store.state.tables.customapirequestparameter = [{ customapirequestparameterid: id, customapiid: id, uniquename: 'Input', type: 10 }];
      store.state.tables.customapiresponseproperty = [{ customapiresponsepropertyid: id, customapiid: id, uniquename: 'Result', type: 10 }];
    });
    assert.equal(store.storageAdapter.recordCapabilities('customapi').create, level === 'deep');
    if (level !== 'deep') {
      await assert.rejects(change(), { code: 'SimulationSchemaDisabled' });
      assert.deepEqual(store.snapshot(), before);
      assert.deepEqual(await fs.readFile(dataFile), bytes);
    } else {
      await change();
      const schema = JSON.parse(await fs.readFile(dataFile, 'utf8')).schema;
      assert.equal(schema.schemaRecords.customapi[0].uniquename, 'invented_Operation');
      await fs.rm(stateFile);
      const restarted = await open();
      for (const table of ['customapi', 'customapirequestparameter', 'customapiresponseproperty'])
        assert.deepEqual(restarted.state.tables[table], store.state.tables[table]);
    }
  }
});

test('late publication failure rolls back every pack file and memory, and a retry works', async t => {
  let publications = 0, failOnce = true;
  const io = { ...fs, rename: async (...args) => {
    if (failOnce && ++publications === 2) { failOnce = false; throw Object.assign(new Error('Invented I/O failure'), { code: 'EIO' }); }
    return fs.rename(...args);
  } };
  const files = [
    { file: 'first.json', tables: { item: { path: ['records'], idColumn: 'itemid' } } },
    { file: 'second.json', tables: { copy: { path: ['records'], idColumn: 'itemid' } } },
  ];
  const seed = initial(); seed.mappings.copy = { ...mapping, entitySet: 'copies' }; seed.tables.copy = [];
  const { store, directory, dataFile, open } = await workspace(t, 'simulation', { io, files, seed });
  const second = path.join(directory, 'second.json'), before = [await fs.readFile(dataFile), await fs.readFile(second)], snapshot = store.snapshot();
  const change = () => store.transact(() => {
    store.state.tables.item[0].name = 'First write'; store.state.tables.copy[0].name = 'Second write';
  });
  await assert.rejects(change(), /Invented I\/O failure/);
  assert.deepEqual(store.snapshot(), snapshot);
  assert.deepEqual([await fs.readFile(dataFile), await fs.readFile(second)], before);
  await change();
  assert.equal((await open()).tableRows('copy')[0].name, 'Second write');
  assert.ok(!(await fs.readdir(directory)).some(name => /\.paqvilo-.*\.(bak|tmp)$/.test(name)));
});

test('credentials and organization control-plane rows persist privately without a business DATA target', async t => {
  const seed = initial(); seed.mappings.systemuser = { idColumn: 'systemuserid', entitySet: 'systemusers' }; seed.tables.systemuser = [];
  const { store, dataFile, stateFile } = await workspace(t, 'simulation', { seed });
  await store.transact(() => {
    store.state.tables.systemuser.push({ systemuserid: id, fullname: 'Invented Staff' });
    store.state.dataverse ??= {}; store.state.dataverse.passwords = { [id]: { hash: 'private-invented-hash' } };
  });
  assert.ok(!(await fs.readFile(dataFile, 'utf8')).includes('private-invented-hash'));
  assert.ok((await fs.readFile(stateFile, 'utf8')).includes('private-invented-hash'));
});

test('failed persistence never retains elastic writes or independent plug-in writes in memory', async () => {
  for (const isolated of [false, true]) for (const failOperation of [false, true]) {
    let saves = 0, events = 0;
    const state = initial();
    state.mappings.item.tableType = 'Elastic';
    state.tables.item = [{ itemid: id, name: 'Before', partitionid: 'invented' }];
    const store = await new DataStore({ state, storageAdapter: {
      load: value => value,
      save() { saves++; throw Object.assign(new Error('Invented save failure'), { code: 'EIO' }); },
    } }).init();
    const before = store.snapshot(), revision = store.revision;
    store.addCommittedEvents(() => events++);
    await assert.rejects(store.transact(() => {
      const row = store.state.tables.item[0]; row.name = 'Must roll back';
      store.recordCommittedEvent('item', 'update', row, ['name']);
      store.checkpointElastic({ ...store.state.mappings.item, logicalName: 'item', tableType: 'Elastic' }, row);
      if (failOperation) throw new Error('Invented PostOperation rejection');
    }, { isolated }), { code: 'EIO', persistenceFailure: true });
    assert.equal(saves, 1);
    assert.deepEqual(store.snapshot(), before, `isolated=${isolated}, PostOperation=${failOperation}`);
    assert.equal(store.revision, revision);
    await store.flushCommittedEvents(); assert.equal(events, 0);
  }
  const store = await new DataStore({ state: initial(), storageAdapter: {
    load: value => value, save() { throw new Error('Invented independent save failure'); },
  } }).init();
  const before = store.snapshot();
  await assert.rejects(store.transact(() => {
    store.sdkMutation(() => { store.state.tables.item.push({ itemid: id, name: 'Independent' }); });
    throw new Error('Outer rejection');
  }), /Invented independent save failure/);
  assert.deepEqual(store.snapshot(), before);
});

test('pack DATA manifest rejects executable locations, path escapes, overlap and duplicate ownership', async t => {
  const base = { id: 'invented', name: 'Invented', description: 'Invented fixture', matches: () => true, presets: () => ({}) };
  for (const file of ['pack.mjs', '../data.json', 'C:/data.json', '.paqvilo/state.json']) assert.throws(() => validatePack({ ...base, dataFiles: [{ file, tables: { item: { path: [], idColumn: 'itemid' } } }] }));
  assert.throws(() => validatePack({ ...base, dataFiles: [{ file: 'data.json', tables: { item: { path: ['schema'], idColumn: 'itemid' } }, schemaPath: ['schema'] }] }));
  assert.throws(() => simulationSettings({ level: 'unknown' }));
  const { pack, stateFile } = await workspace(t, 'simulation');
  await assert.rejects(createSimulationPersistence({ settings: { level: 'deep' }, packs: [pack, { ...pack }], stateFile }), /module directory|exactly one|more than one/);
});

test('a queued writer cannot borrow a paused source publication to bypass schema policy', async t => {
  const { store, dataFile } = await workspace(t, 'dry-run');
  let release, entered;
  const paused = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const blocker = store.transact(async () => { entered(); await paused; }, { skipSaveIfUnchanged: true });
  await started;
  const forbidden = assert.rejects(store.transact(() => { store.state.mappings.item.fields.fromUnrelatedWriter = { type: 'text' }; }), { code: 'SimulationSchemaDisabled' });
  const source = store.storageAdapter.bootstrap(() => store.transact(() => {
    store.state.mappings.item.fields.fromSelectedSolution = { type: 'text' };
  }), () => store.state);
  release();
  await blocker; await forbidden; await source;
  assert.equal(store.state.mappings.item.fields.fromUnrelatedWriter, undefined);
  assert.deepEqual(store.state.mappings.item.fields.fromSelectedSolution, { type: 'text' });
  await store.update('item', id, { name: 'Ordinary record edit remains allowed' });
  assert.equal(JSON.parse(await fs.readFile(dataFile, 'utf8')).records[0].name, 'Original');
});

test('a rejected source publication cannot poison the schema baseline before its outer transaction rolls back', async t => {
  const { store } = await workspace(t, 'simulation');
  const before = store.snapshot();
  await assert.rejects(store.transact(() => store.storageAdapter.bootstrap(() => {
    store.state.mappings.item.fields.failedSource = { type: 'text' };
    throw new Error('Source validation failed');
  }, () => store.state), { isolated: true }), /Source validation failed/);
  assert.deepEqual(store.snapshot(), before);
  await store.update('item', id, { name: 'Allowed after rollback' });
  assert.equal(store.tableRows('item')[0].name, 'Allowed after rollback');
});

test('continuations scheduled by a completed source publication no longer bypass policy', async t => {
  const { store } = await workspace(t, 'dry-run');
  let release, later;
  const wait = new Promise(resolve => { release = resolve; });
  await store.storageAdapter.bootstrap(() => {
    later = wait.then(() => store.transact(() => { store.state.mappings.item.fields.late = { type: 'text' }; }));
  }, () => store.state);
  const rejected = assert.rejects(later, { code: 'SimulationSchemaDisabled' });
  release(); await rejected;
  assert.equal(store.state.mappings.item.fields.late, undefined);
});
