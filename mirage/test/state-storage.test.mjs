import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { readStateFile, stateFileSignature } from '../lib/state-storage.mjs';
import { jsonChunks, parseJsonStream, hashStateFile } from '../lib/state-stream.mjs';

const seed = () => ({
  settings: { permissionMode: 'permissive' },
  mappings: { item: { idColumn: 'itemid', entitySet: 'items' } },
  tables: { item: [{ itemid: 'one', name: 'original' }] },
});
test('NTFS access-only ChangeTime updates are distinct from content and identity changes', () => {
  const original = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n };
  assert.equal(stateFileSignature(original, 'win32'), stateFileSignature({ ...original, ctimeNs: 6n }, 'win32'));
  assert.notEqual(stateFileSignature(original, 'linux'), stateFileSignature({ ...original, ctimeNs: 6n }, 'linux'));
  for (const key of ['dev', 'ino', 'size', 'mtimeNs'])
    assert.notEqual(stateFileSignature(original, 'win32'), stateFileSignature({ ...original, [key]: 99n }, 'win32'));
});

for (const journalThresholdBytes of [0, Number.MAX_SAFE_INTEGER])
  test(`reads, copies and first-attempt restart retain write ownership (threshold ${journalThresholdBytes})`, async (t) => {
    const { file, store } = await workspace(t, seed(), { journalThresholdBytes });
    const modes = [];
    store.onSave = (timing) => modes.push(timing.mode);
    for (let index = 0; index < 20; index++) {
      await store.update('items', 'one', { name: `write-${index}` });
      assert.deepEqual(await readStateFile(file), store.snapshot());
      await fs.copyFile(file, `${file}.copy`);
    }
    const restarted = await new DataStore({ file, persistence: { journalThresholdBytes } }).init();
    assert.deepEqual(restarted.snapshot(), store.snapshot());
    await restarted.update('items', 'one', { name: 'restart' });
    assert.ok(modes.every((mode) => mode === (journalThresholdBytes === 0 ? 'journal' : 'checkpoint')));
    const text = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, text.replace('restart', 'outside'));
    // Force a distinct mtime even on filesystems with coarse timestamp precision.
    const modified = new Date(Date.now() + 2000);
    await fs.utimes(file, modified, modified);
    await assert.rejects(restarted.update('items', 'one', { name: 'lost' }), { code: 'StateConflict' });
  });
async function workspace(t, state = seed(), persistence = { journalThresholdBytes: 0 }) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mirage-stream-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = join(root, 'state.json');
  return { file, store: await new DataStore({ file, state, persistence }).init() };
}

test('streamed JSON preserves scalar/escape/UTF-8 boundaries and own prototype names', async () => {
  const state = JSON.parse(
    '{"__proto__":{"x":1},"constructor":"own","x":[null,true,false,-2.4e-12,"\\"\\\\\\n\\u1234😀"],"empty":{}}',
  );
  const source = [...jsonChunks(state)].join('');
  async function* tiny() {
    for (const char of source) yield char;
  }
  assert.deepEqual(await parseJsonStream(tiny()), state);
  assert.equal({}.x, undefined);
  const scalars = {
    toJSON: 'ordinary column',
    number: new Number(2),
    string: new String('text'),
    boolean: new Boolean(false),
    date: new Date(0),
    missing: undefined,
  };
  assert.equal([...jsonChunks(scalars)].join(''), JSON.stringify(scalars));
  for (const bad of ['[1,]', '{"x":}', '{}{}', '1 2', '[', '', '{"a" 1}', '{"a":1,}', '01', 'truefalse']) {
    await assert.rejects(parseJsonStream([bad]), SyntaxError, bad);
  }
});

test('legacy JSON loads, large checkpoints stream, and digests cover exact committed bytes', async (t) => {
  const { file, store } = await workspace(t);
  assert.equal(store.storage.journal, true);
  assert.equal(await hashStateFile(file), store.persistedDigest);
  await store.update('items', 'one', { name: 'changed' });
  await store.create('items', { itemid: 'two', name: 'second' });
  await store.remove('items', 'one');
  assert.deepEqual(await readStateFile(file), store.snapshot());
  const restarted = await new DataStore({ file }).init();
  assert.deepEqual(restarted.snapshot(), store.snapshot());
  assert.equal(restarted.persistedDigest, store.persistedDigest);
  assert.equal(await hashStateFile(file), store.persistedDigest);
  await fs.writeFile(file, JSON.stringify(seed(), null, 2));
  const legacy = await new DataStore({ file }).init();
  assert.equal(legacy.state.tables.item[0].name, 'original');
});

test('explicitly reinitializing after a JSON replacement cannot append stale journal offsets', async (t) => {
  const { file, store } = await workspace(t);
  await store.update('items', 'one', { name: 'journal edit' });
  await fs.writeFile(file, JSON.stringify(seed()));
  await store.init();
  assert.equal(store.storage.journal, false);
  assert.equal(store.storage.recoveredTail, false);
  await store.update('items', 'one', { name: 'after explicit reload' });
  assert.deepEqual(await readStateFile(file), store.snapshot());
  assert.equal(await hashStateFile(file), store.persistedDigest);
});

test('large metadata and individual records are fragmented without a document-sized string', async (t) => {
  const initial = seed();
  initial.simulator = { labels: Array.from({ length: 10000 }, (_, i) => `label-${i}`) };
  initial.tables.item[0].details = Array.from({ length: 10000 }, (_, i) => ({ key: i, value: 'synthetic' }));
  const { file, store } = await workspace(t, initial);
  assert.deepEqual(await readStateFile(file), store.snapshot());
  const selected = await readStateFile(file, { sections: ['simulator'] });
  assert.deepEqual(selected, { simulator: store.state.simulator });
  await store.update('items', 'one', { details: [...initial.tables.item[0].details, { key: 'last' }] });
  assert.deepEqual(await readStateFile(file), store.snapshot());
});

test('stale and concurrent runtimes cannot replace committed rows', async (t) => {
  const { file, store } = await workspace(t);
  const stale = await new DataStore({ file }).init();
  await store.update('items', 'one', { name: 'first' });
  await assert.rejects(stale.update('items', 'one', { name: 'stale' }), { code: 'StateConflict' });
  assert.equal(stale.state.tables.item[0].name, 'original');
  assert.equal((await readStateFile(file)).tables.item[0].name, 'first');
  const second = await new DataStore({ file }).init();
  const results = await Promise.allSettled([
    store.update('items', 'one', { name: 'racing-a' }),
    second.update('items', 'one', { name: 'racing-b' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'StateConflict');
});

test('external equal-size edits conflict and checksum corruption is rejected at restart', async (t) => {
  const { file, store } = await workspace(t);
  const text = await fs.readFile(file, 'utf8');
  // An equal-size edit inside the file-time tick of the last save keeps every stat field, the documented limit of
  // the external-writer check (Linux stamps ctime from a coarse clock). Edit once that tick has passed.
  const saved = await fs.stat(file, { bigint: true }),
    probe = file + '.tick';
  do await fs.writeFile(probe, '');
  while ((await fs.stat(probe, { bigint: true })).ctimeNs <= saved.ctimeNs);
  await fs.rm(probe);
  await fs.writeFile(file, text.replace('original', 'modified'));
  await assert.rejects(store.update('items', 'one', { name: 'overwrite' }), { code: 'StateConflict' });
  assert.equal(store.state.tables.item[0].name, 'original');
  await assert.rejects(readStateFile(file), { code: 'StateIntegrity' });
});

test('malformed JSON inside a committed transaction cannot masquerade as a torn tail', async (t) => {
  const { file, store } = await workspace(t);
  await store.update('items', 'one', { name: 'changed' });
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace('"op":"set"', '"op":!"set"'));
  await assert.rejects(readStateFile(file), { code: 'StateIntegrity' });
});

test('an incomplete appended transaction is discarded and the next commit repairs the tail', async (t) => {
  const { file, store } = await workspace(t);
  await store.update('items', 'one', { name: 'committed' });
  await fs.appendFile(
    file,
    '{"op":"begin"}\n{"op":"set","table":"item","index":0,"row":{"itemid":"one","name":"torn"}}\n{"op":"com',
  );
  const recovered = await new DataStore({ file }).init();
  assert.equal(recovered.storage.recoveredTail, true);
  assert.equal(recovered.state.tables.item[0].name, 'committed');
  await recovered.update('items', 'one', { name: 'next' });
  assert.equal((await readStateFile(file)).tables.item[0].name, 'next');
  assert.equal(await hashStateFile(file), recovered.persistedDigest);
});

test('checkpoint failure keeps current file and failed multi-row effects roll back without copying unrelated rows', async (t) => {
  const initial = seed();
  initial.plugins = [
    {
      entity: 'item',
      operation: 'update',
      set: {},
      secondary: [
        { entity: 'item', operation: 'create', set: { name: { literal: 'effect' } } },
        { entity: 'item', operation: 'update', match: { itemid: { literal: 'missing' } }, requireMatch: true, set: {} },
      ],
    },
  ];
  const { file, store } = await workspace(t, initial);
  const originalRow = store.state.tables.item[0],
    digest = store.persistedDigest;
  await assert.rejects(store.update('items', 'one', { name: 'denied' }), /cannot find a matching related record/);
  assert.equal(store.state.tables.item.length, 1);
  assert.equal(store.state.tables.item[0], originalRow);
  assert.equal(await hashStateFile(file), digest);
  const prepare = store.storage.prepareCheckpoint;
  store.storage.prepareCheckpoint = async () => {
    throw new Error('synthetic disk full');
  };
  await assert.rejects(store.replaceState(seed()), /synthetic disk full/);
  store.storage.prepareCheckpoint = prepare;
  assert.equal(await hashStateFile(file), digest);
});

test('ordinary writes retain unrelated row identity and report save duration', async (t) => {
  const initial = seed();
  initial.tables.item.push({ itemid: 'two', name: 'untouched' });
  const { store, file } = await workspace(t, initial);
  const untouched = store.state.tables.item[1],
    before = (await fs.stat(file)).size,
    saves = [];
  store.onSave = (timing) => saves.push(timing);
  // A registered but inactive exported-plugin pipeline must not force full copies.
  store.setPluginPipeline(
    () => {
      throw new Error('inactive');
    },
    () => false,
  );
  await store.update('items', 'one', { name: 'small edit' });
  assert.equal(store.state.tables.item[1], untouched);
  assert.equal(saves[0].mode, 'journal');
  assert.ok(saves[0].durationMs >= 0);
  const indexes = store.rowIndexes;
  await store.readOperation(() => store.get('items', 'one'));
  assert.equal(store.rowIndexes, indexes, 'read-only requests retain the primary-key index between writes');
  assert.ok((await fs.stat(file)).size - before < 1024);
  assert.deepEqual(await readStateFile(file), store.snapshot());
});

test('an active trusted handler promotes the rollback boundary without losing earlier changes', async (t) => {
  const { store, file } = await workspace(t);
  const before = store.snapshot();
  store.setPluginPipeline(() => {
    store.state.tables.item[0].name = 'arbitrary handler mutation';
    throw new Error('handler rejected');
  });
  await assert.rejects(store.update('items', 'one', { name: 'attempt' }), /handler rejected/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await readStateFile(file), before);
});

test('large states select journaling automatically and compaction preserves edits and digest', async (t) => {
  const initial = seed(),
    payload = 'p'.repeat(1024);
  initial.tables.item = Array.from({ length: 18000 }, (_, i) => ({ itemid: `item-${i}`, payload }));
  const { store, file } = await workspace(t, initial, {});
  assert.equal(store.storage.journal, true);
  await store.update('items', 'item-17999', { name: 'last' });
  const before = store.snapshot(),
    digest = store.persistedDigest;
  await store.compact();
  assert.notEqual(store.persistedDigest, digest);
  assert.deepEqual(await readStateFile(file), before);
  assert.equal(await hashStateFile(file), store.persistedDigest);
});

test('preset persistence failures keep the prior state and checkpoint intact', async (t) => {
  const { store, file } = await workspace(t);
  const before = store.snapshot(),
    digest = store.persistedDigest;
  const preset = {
    id: 'synthetic',
    name: 'Synthetic replacement',
    tables: { item: [{ itemid: 'replacement', payload: 'x'.repeat(2048) }] },
  };
  store.storage.prepareCheckpoint = async () => {
    throw new Error('Synthetic checkpoint cannot be persisted');
  };
  await assert.rejects(
    store.applyPreset('synthetic', { generatedPresets: { synthetic: preset } }),
    /cannot be persisted/,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.equal(await hashStateFile(file), digest);
});

test('snapshot digests provide bounded optimistic replacement checks', async (t) => {
  const { store } = await workspace(t);
  const expectedDigest = store.snapshotDigest();
  await store.update('items', 'one', { name: 'newer edit' });
  await assert.rejects(store.replaceState(seed(), { expectedDigest }), { code: 'StateConflict' });
  assert.equal(store.state.tables.item[0].name, 'newer edit');
});

test('an in-memory fixture can bind its persistence path before init or its first save', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'mirage-late-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const operation of ['init', 'save']) {
    const store = new DataStore({ state: seed(), persistence: { journalThresholdBytes: 0 } });
    store.file = join(root, `${operation}.json`);
    await store[operation]();
    await store.update('items', 'one', { name: operation });
    assert.equal((await readStateFile(store.file)).tables.item[0].name, operation);
  }
});

test('declarative secondary updates retain same-row response and referenced-row identity', async (t) => {
  const initial = seed();
  initial.tables.item.push({ itemid: 'two', name: 'second' });
  initial.plugins = [
    {
      entity: 'item',
      operation: 'update',
      set: {},
      secondary: [
        {
          entity: 'item',
          operation: 'update',
          match: { itemid: { literal: 'one' } },
          set: { name: { literal: 'secondary value' } },
        },
        {
          entity: 'item',
          operation: 'update',
          match: { itemid: { literal: 'two' } },
          set: { note: { literal: 'updated' } },
        },
      ],
    },
  ];
  const { store, file } = await workspace(t, initial),
    referenced = store.state.tables.item[1];
  const result = await store.update('items', 'one', { name: 'submitted' });
  assert.equal(result.name, 'secondary value');
  assert.equal(store.state.tables.item[1], referenced);
  assert.equal(referenced.note, 'updated');
  assert.deepEqual(await readStateFile(file), store.snapshot());
  const before = store.snapshot();
  store.state.plugins[0].secondary[1].set.note.literal = 'must roll back';
  store.state.plugins[0].secondary.push({
    entity: 'item',
    operation: 'update',
    match: { itemid: { literal: 'missing' } },
    set: {},
    requireMatch: true,
  });
  await assert.rejects(store.update('items', 'one', { name: 'failed' }), /cannot find a matching related record/);
  assert.equal(store.state.tables.item[1], referenced);
  assert.equal(referenced.note, before.tables.item[1].note);
});

test('deferred trusted-handler promotion reconstructs the transaction before earlier core changes', async (t) => {
  const { store, file } = await workspace(t),
    before = store.snapshot();
  store.setPluginPipeline(
    () => {
      store.state.tables.item[0].name = 'handler edit';
      throw new Error('reject');
    },
    ({ operation }) => operation === 'update',
  );
  await assert.rejects(
    store.transact(
      () => {
        store.createRecord('items', { itemid: 'two' });
        store.updateRecord('items', 'one', { name: 'attempt' });
      },
      { incremental: true },
    ),
    /reject/,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await readStateFile(file), before);
});

test('a representation read observer promotes before arbitrary row mutations', async (t) => {
  const { store, file } = await workspace(t),
    before = store.snapshot();
  store.setPluginPipeline(
    () => {
      store.state.tables.item[0].name = 'observer edit';
      throw new Error('observer reject');
    },
    ({ operation }) => operation === 'retrieve',
  );
  await assert.rejects(
    store.transact(
      () => {
        store.updateRecord('items', 'one', { name: 'attempt' });
        return store.get('items', 'one');
      },
      { incremental: true },
    ),
    /observer reject/,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await readStateFile(file), before);
});

test(
  'an atomic external replacement during append is preserved and cannot be adopted by a retry',
  {
    skip:
      process.platform === 'win32'
        ? 'Windows refuses replacement of the open write descriptor; exercised on POSIX'
        : false,
  },
  async (t) => {
    const { file, store } = await workspace(t),
      before = store.snapshot();
    const external = seed();
    external.tables.item[0].name = 'external editor';
    await fs.writeFile(file + '.external', JSON.stringify(external));
    const append = store.storage.appendChanges.bind(store.storage);
    store.storage.appendChanges = (entries) =>
      append(
        (async function* () {
          yield* entries;
          await fs.rename(file + '.external', file);
        })(),
      );
    await assert.rejects(store.update('items', 'one', { name: 'attempt' }), { code: 'StateConflict' });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), external);
    store.storage.appendChanges = append;
    await assert.rejects(store.update('items', 'one', { name: 'retry' }), { code: 'StateConflict' });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), external);
  },
);

test('a failed partially flushed append restores its committed prefix and permits a clean retry', async (t) => {
  const { file, store } = await workspace(t),
    before = store.snapshot(),
    digest = store.persistedDigest;
  const append = store.storage.appendChanges.bind(store.storage);
  store.storage.appendChanges = (entries) =>
    append(
      (async function* () {
        for (const entry of entries)
          yield entry.row ? { ...entry, row: { ...entry.row, padding: 'x'.repeat(100000) } } : entry;
        throw new Error('Synthetic append failure after flush');
      })(),
    );
  await assert.rejects(store.update('items', 'one', { name: 'failed' }), /after flush/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(await hashStateFile(file), digest);
  store.storage.appendChanges = append;
  await store.update('items', 'one', { name: 'retry' });
  assert.deepEqual(await readStateFile(file), store.snapshot());
  assert.equal(await hashStateFile(file), store.persistedDigest);
});

for (const primary of [new Error('Invented write failure'), null])
  test(`save retains both write and lock cleanup failures (${primary === null ? 'null' : 'Error'})`, async (t) => {
    const { file, store } = await workspace(t);
    const before = await fs.readFile(file, 'utf8');
    store.storage.assertUnchanged = async () => {
      // This owned directory makes the cleanup read fail without touching another writer's lock.
      await fs.rm(`${file}.lock`);
      await fs.mkdir(`${file}.lock`);
      throw primary;
    };
    await assert.rejects(store.save(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.equal(error.errors[0], primary);
      assert.ok(error.errors[1] instanceof Error);
      assert.equal(error.persistenceFailure, true);
      return true;
    });
    assert.equal(await fs.readFile(file, 'utf8'), before);
  });
