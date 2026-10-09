import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileBodyCache } from '../lense/file-cache.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-body-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return (name, body) => { const file = path.join(dir, name); fs.writeFileSync(file, body); return file; };
}

test('served-body cache reuses transforms, notices replacement, and invalidates explicit saves', (t) => {
  const write = fixture(t);
  const file = write('app.js', 'before');
  const cache = new FileBodyCache();
  let calls = 0;
  const transform = (body) => { calls++; return Buffer.concat([body, Buffer.from(' map')]); };
  assert.equal(cache.read(file, 'map', transform).toString(), 'before map');
  assert.equal(cache.read(file, 'map', transform).toString(), 'before map');
  assert.equal(calls, 1);
  const replacement = write('replacement.js', 'after!');
  fs.renameSync(replacement, file);
  assert.equal(cache.read(file, 'map', transform).toString(), 'after! map');
  assert.equal(calls, 2);
  cache.invalidate([file]);
  cache.read(file, 'map', transform);
  assert.equal(calls, 3);
  assert.equal(cache.read(file).toString(), 'after!', 'raw and source-mapped variants stay separate');
  fs.unlinkSync(file);
  assert.throws(() => cache.read(file));
  assert.equal(cache.entries.size, 0);
  assert.equal(cache.bytes, 0);
});

test('served-body LRU limits total bytes, individual entries and empty-file count', (t) => {
  const write = fixture(t);
  const cache = new FileBodyCache({ maxBytes: 10, maxEntryBytes: 8, maxEntries: 2 });
  const a = write('a', 'aaaaa'), b = write('b', 'bbbbb'), c = write('c', 'ccccc');
  cache.read(a); cache.read(b); cache.read(a); cache.read(c);
  assert.equal(cache.bytes, 10);
  assert.deepEqual([...cache.entries.values()].map(e => e.file), [a, c]);
  cache.read(write('large', 'large uncached asset'));
  assert.equal(cache.bytes, 10);
  cache.read(write('empty1', '')); cache.read(write('empty2', '')); cache.read(write('empty3', ''));
  assert.equal(cache.entries.size, 2);
  assert.equal(cache.bytes, 0);
  cache.clear();
  assert.equal(cache.entries.size, 0);
});

test('a file changed during transformation is not retained under an old stamp', (t) => {
  const write = fixture(t);
  const file = write('app.js', 'first');
  const cache = new FileBodyCache();
  cache.read(file, 'racing', (body) => { fs.writeFileSync(file, 'second value'); return body; });
  assert.equal(cache.entries.size, 0);
  assert.equal(cache.read(file, 'racing').toString(), 'second value');
});
