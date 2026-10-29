import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RecordPageFile } from '../lib/record-page-file.mjs';

function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-record-pages-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'owned.pages');
  const store = RecordPageFile.create(file, options);
  t.after(() => store.close());
  return { root, file, store };
}
const integrity = (error) => error.code === 'StateIntegrity';
// A format 1 receipt names the digest of the complete published prefix.
const fullReceipt = (file, { bytes, pages }) => ({
  format: 1,
  bytes,
  pages,
  sha256: createHash('sha256').update(fs.readFileSync(file).subarray(0, bytes)).digest('hex'),
});

test('published prefixes survive later appends and read-only restoration cannot append', async (t) => {
  const { file, store } = fixture(t);
  const bytes = Buffer.from(JSON.stringify([{ id: 'invented', text: 'Δ 日本語 " \\ \n' }]));
  const first = store.append(1, bytes, 1),
    before = store.descriptor();
  const index = Buffer.alloc(8);
  index.writeUInt32LE(first * 512, 0);
  index.writeUInt32LE(first * 512, 4);
  const second = store.append(2, index, 2),
    after = store.descriptor();
  assert.notDeepEqual(before, after);
  const reader = await RecordPageFile.open(file, before, { writable: true });
  t.after(() => reader.close());
  assert.deepEqual(reader.read(first), bytes);
  assert.throws(() => reader.read(second), integrity);
  assert.throws(() => reader.append(1, bytes, 1), /not writable/);
  assert.deepEqual(reader.descriptor(), before);
  const latest = await RecordPageFile.open(file, after);
  t.after(() => latest.close());
  assert.deepEqual(latest.read(second), index);
  assert.deepEqual(latest.read(first), bytes);
});

test('cache admission and eviction remain bounded and returned bytes are detached', (t) => {
  const { store } = fixture(t, { cacheBytes: 1024 });
  const ids = [];
  for (let index = 0; index < 80; index++) ids.push(store.append(1, Buffer.alloc(250, index), 1));
  for (const [index, id] of ids.entries()) {
    assert.equal(store.read(id)[0], index);
    assert.ok(store.cacheInfo().bytes <= 1024);
  }
  const last = ids.at(-1);
  store.read(last)[0] = 255;
  assert.equal(store.read(last)[0], 79);
  assert.ok(store.cacheInfo().hits >= 2);
  const misses = store.cacheInfo().misses;
  assert.equal(store.read(ids[0])[0], 0);
  assert.equal(store.cacheInfo().misses, misses + 1);
  const oversized = store.append(1, Buffer.alloc(2048, 21), 1);
  store.read(oversized);
  assert.ok(store.cacheInfo().bytes <= 1024);
});

test('tampering is rejected during restoration and uncached page reads', async (t) => {
  const { file, store } = fixture(t, { cacheBytes: 0 });
  const id = store.append(1, Buffer.from('[{"id":"one","body":"invented value"}]'), 1);
  const descriptor = store.descriptor(),
    legacy = fullReceipt(file, descriptor);
  const reader = await RecordPageFile.open(file, descriptor, { cacheBytes: 0 });
  t.after(() => reader.close());
  const target = store.page(id).offset + 5;
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, Buffer.from([255]), 0, 1, target);
  } finally {
    fs.closeSync(fd);
  }
  assert.throws(() => reader.read(id), integrity);
  await assert.rejects(RecordPageFile.open(file, legacy), integrity);
  // A header-chain receipt reads no payload while opening; the payload digest rejects the first read.
  const reopened = await RecordPageFile.open(file, descriptor, { cacheBytes: 0 });
  t.after(() => reopened.close());
  assert.throws(() => reopened.read(id), integrity);
  const header = store.page(id).offset - 48;
  const bytes = fs.readFileSync(file);
  bytes[header + 20] ^= 1;
  fs.writeFileSync(file, bytes);
  await assert.rejects(RecordPageFile.open(file, descriptor), integrity);
});

test('short writes roll back the suffix without changing the preceding receipt', async (t) => {
  let armed = false,
    partial = false;
  const io = {
    ...fs,
    writeSync(fd, bytes, offset, length, position) {
      if (!armed) return fs.writeSync(fd, bytes, offset, length, position);
      if (partial) throw Error('Invented write failure');
      partial = true;
      return fs.writeSync(fd, bytes, offset, Math.min(7, length), position);
    },
  };
  const { file, store } = fixture(t, { io });
  store.append(1, Buffer.from('[{"id":"before"}]'), 1);
  const before = store.descriptor();
  armed = true;
  assert.throws(() => store.append(1, Buffer.from('[{"id":"rejected"}]'), 1), /Invented write failure/);
  armed = false;
  assert.equal(fs.statSync(file).size, before.bytes);
  assert.deepEqual(store.descriptor(), before);
  const reader = await RecordPageFile.open(file, before);
  t.after(() => reader.close());
  assert.match(reader.read(1).toString(), /before/);
  store.append(1, Buffer.from('[{"id":"after"}]'), 1);
  assert.equal(store.descriptor().pages, 2);
});

test('failed durability cannot publish a receipt and rollback failure poisons only the writer', async (t) => {
  let syncFailure = false,
    writeFailure = false;
  const { file, store } = fixture(t, {
    io: {
      ...fs,
      fsyncSync(fd) {
        if (syncFailure) throw Error('Invented flush failure');
        return fs.fsyncSync(fd);
      },
      writeSync(...args) {
        if (writeFailure) throw Error('Invented append failure');
        return fs.writeSync(...args);
      },
      ftruncateSync(...args) {
        if (writeFailure) throw Error('Invented truncate failure');
        return fs.ftruncateSync(...args);
      },
    },
  });
  store.append(1, Buffer.from('[{"id":"durable"}]'), 1);
  const before = store.descriptor();
  store.append(1, Buffer.from('[{"id":"unpublished"}]'), 1);
  syncFailure = true;
  assert.throws(() => store.descriptor(), /Invented flush failure/);
  const reader = await RecordPageFile.open(file, before);
  t.after(() => reader.close());
  assert.match(reader.read(1).toString(), /durable/);
  syncFailure = false;
  writeFailure = true;
  assert.throws(() => store.append(1, Buffer.from('[{}]'), 1), AggregateError);
  assert.throws(() => store.descriptor(), AggregateError);
  assert.throws(() => store.append(1, Buffer.from('[{}]'), 1), AggregateError);
});

test('inventory, bounds, truncation and index widths are verified independently of a matching checksum', async (t) => {
  const { file, store } = fixture(t);
  assert.throws(() => store.append(2, Buffer.alloc(8), 3), /Invalid record page/);
  assert.throws(() => store.append(1, Buffer.from('[]'), 513), /Invalid record page/);
  store.append(2, Buffer.alloc(8), 2);
  const descriptor = store.descriptor();
  await assert.rejects(RecordPageFile.open(file, { ...descriptor, pages: 2 }), integrity);
  await assert.rejects(RecordPageFile.open(file, { ...descriptor, bytes: descriptor.bytes + 1 }), integrity);
  const bytes = fs.readFileSync(file);
  const headerOffset = bytes.length - store.entries[1].length - 48;
  bytes.writeUInt32LE(3, headerOffset + 4);
  fs.writeFileSync(file, bytes);
  const altered = { ...descriptor, sha256: createHash('sha256').update(bytes).digest('hex') };
  await assert.rejects(RecordPageFile.open(file, altered), integrity);
  fs.truncateSync(file, bytes.length - 1);
  await assert.rejects(RecordPageFile.open(file, altered), integrity);
});

test('multiple published prefixes verify in one pass while a later owned append remains outside the reader', async (t) => {
  const { file, store } = fixture(t);
  store.append(1, Buffer.from('[{"id":"first"}]'), 1);
  const before = store.descriptor();
  store.append(1, Buffer.from('[{"id":"second"}]'), 1);
  const after = store.descriptor();
  let appended = false,
    readBytes = 0;
  const io = {
    ...fs,
    read(fd, bytes, offset, length, position, callback) {
      fs.read(fd, bytes, offset, length, position, (error, count) => {
        readBytes += count;
        if (!appended) {
          appended = true;
          store.append(1, Buffer.from('[{"id":"later"}]'), 1);
          store.descriptor();
        }
        callback(error, count);
      });
    },
  };
  const reader = await RecordPageFile.open(file, after, { prefixes: [before, after], io });
  t.after(() => reader.close());
  assert.equal(
    readBytes,
    Buffer.byteLength('PAQVILO-RECORD-PAGES-1\n') + 2 * 48,
    'Prefix verification reads the magic and each page header once, for every table together.',
  );
  assert.equal(reader.descriptor().pages, 2);
  assert.deepEqual(reader.descriptor(), after);
  assert.throws(() => reader.read(3), integrity);
  await assert.rejects(
    RecordPageFile.open(file, after, { prefixes: [{ ...before, headers: '0'.repeat(64) }] }),
    integrity,
  );
  // Receipts of the complete prefix remain readable and are verified byte for byte, once.
  readBytes = 0;
  appended = true;
  const legacyBefore = fullReceipt(file, before),
    legacyAfter = fullReceipt(file, after);
  const legacy = await RecordPageFile.open(file, legacyAfter, { prefixes: [legacyBefore, before], io });
  t.after(() => legacy.close());
  assert.equal(readBytes, after.bytes);
  assert.match(legacy.read(2).toString(), /second/);
  assert.deepEqual(legacy.descriptor(), after, 'A verified legacy file publishes header-chain receipts.');
  await assert.rejects(
    RecordPageFile.open(file, legacyAfter, { prefixes: [{ ...legacyBefore, sha256: '0'.repeat(64) }] }),
    integrity,
  );
});

test('a receipt syncs only bytes written since the last one, and a sealed writer reopens as a reader', (t) => {
  let syncs = 0;
  const { store } = fixture(t, {
    io: {
      ...fs,
      fsyncSync(fd) {
        syncs++;
        return fs.fsyncSync(fd);
      },
    },
  });
  store.append(1, Buffer.from('[{"id":"one"}]'), 1);
  const first = store.descriptor();
  assert.deepEqual(store.descriptor(), first);
  assert.equal(syncs, 1, 'Several tables published from one writer by one commit sync it once.');
  store.append(1, Buffer.from('[{"id":"two"}]'), 1);
  store.descriptor();
  assert.equal(syncs, 2);
  store.seal();
  assert.equal(syncs, 2);
  assert.throws(() => store.append(1, Buffer.from('[{}]'), 1), /not writable/);
  store.suspend();
  assert.match(store.read(2).toString(), /two/);
});
