// The source fingerprint walk reads files concurrently; the digest is the documented one (relative path, NUL,
// bytes, NUL, in name order, directories in place), entries that vanish during a walk are left out of both the digest
// and the cached signature, and any other read failure still fails the fingerprint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { settleFileTimes } from './support/file-times.mjs';
import {
  sourceFingerprint,
  cachedSourceFingerprint,
  implementationSourceFingerprint,
  cachedImplementationSourceFingerprint,
} from '../lib/evidence.mjs';

// One file at a time, as the walk was written before its reads ran concurrently.
async function reference(root) {
  const hash = createHash('sha256');
  async function walk(dir) {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (['.git', 'node_modules'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else
        hash
          .update(path.relative(root, file).replaceAll('\\', '/'))
          .update('\0')
          .update(await fs.readFile(file))
          .update('\0');
    }
  }
  await walk(root);
  return hash.digest('hex');
}

async function tree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-walk-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  return root;
}

test('the fingerprint digest keeps name order across files and directories read together', async (t) => {
  const files = { 'b.txt': 'second', 'a/z.txt': 'nested', 'a/b.txt': '', 'A.txt': 'upper', 'c/d/e.txt': 'deep' };
  for (let index = 0; index < 40; index++) files[`many/${String(index).padStart(2, '0')}.txt`] = `file ${index}`;
  const root = await tree(t, { ...files, 'node_modules/x.js': 'excluded' });
  const expected = await reference(root);
  assert.equal(await sourceFingerprint(root), expected);
  assert.equal(await implementationSourceFingerprint(root), expected);
  assert.equal(await cachedSourceFingerprint(root), expected);
  assert.equal(await cachedImplementationSourceFingerprint(root), expected);
});

test('entries removed during a walk are left out, and other read failures still fail the fingerprint', async (t) => {
  const root = await tree(t, { 'keep.txt': 'kept', 'gone/inner.txt': 'removed', 'late.txt': 'removed' });
  const missing = (file) => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  const { readdir, readFile, stat } = fs;
  // The directory and the file disappear after the parent listing named them.
  t.mock.method(fs, 'readdir', (dir, ...rest) =>
    path.basename(dir) === 'gone' ? Promise.reject(missing(dir)) : readdir(dir, ...rest),
  );
  t.mock.method(fs, 'readFile', (file, ...rest) =>
    path.basename(file) === 'late.txt' ? Promise.reject(missing(file)) : readFile(file, ...rest),
  );
  t.mock.method(fs, 'stat', (file, ...rest) =>
    path.basename(file) === 'late.txt' ? Promise.reject(missing(file)) : stat(file, ...rest),
  );
  const expected = createHash('sha256').update('keep.txt').update('\0').update('kept').update('\0').digest('hex');
  assert.equal(await sourceFingerprint(root), expected);
  assert.equal(await cachedImplementationSourceFingerprint(root), expected);
  const denied = Object.assign(new Error('EACCES: keep.txt'), { code: 'EACCES' });
  t.mock.method(fs, 'readFile', (file, ...rest) =>
    path.basename(file) === 'keep.txt' ? Promise.reject(denied) : readFile(file, ...rest),
  );
  await assert.rejects(sourceFingerprint(root), { code: 'EACCES' });
});

test('a fingerprint requested while the same tree is being walked reuses that walk instead of hashing it again', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sim-fingerprint-concurrent-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let n = 0; n < 40; n++) await fs.writeFile(path.join(root, `file-${n}.mjs`), `export const n = ${n};`);
  // Files written moments ago are never trusted from the cache, so the walk is judged as a settled tree.
  settleFileTimes(t);
  const read = fs.readFile;
  let reads = 0;
  t.mock.method(fs, 'readFile', (file, ...rest) => {
    if (String(file).startsWith(root)) reads++;
    return read(file, ...rest);
  });
  const [first, second] = await Promise.all([
    cachedImplementationSourceFingerprint(root),
    cachedImplementationSourceFingerprint(root),
  ]);
  assert.equal(first, second);
  assert.equal(reads, 40, 'every file is hashed once');
});
