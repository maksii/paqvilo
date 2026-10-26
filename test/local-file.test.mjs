import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLocalFile, readLocalFileSync } from '../lense/local-file.mjs';
import { tempDirSync } from './fixture.mjs';

test(
  'Windows descriptor reads avoid legacy component traversal while retaining every pathname check',
  { skip: process.platform !== 'win32' },
  (t) => {
    const native = fs.realpathSync.native;
    const root = native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-native-read-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, ...Array.from({ length: 12 }, (_, index) => 'nested-' + index));
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'source.txt');
    fs.writeFileSync(file, 'invented bytes');
    const calls = [];
    t.mock.method(fs, 'realpathSync', () => assert.fail('the legacy component walker must not run'));
    fs.realpathSync.native = (target) => {
      calls.push(target);
      return native(target);
    };
    assert.equal(readLocalFileSync(file, { root, expectedRealPath: native(file), encoding: 'utf8' }), 'invented bytes');
    assert.equal(
      calls.filter((target) => target === file).length,
      3,
      'the original pathname is checked before open, before bytes, and after bytes',
    );
    assert.equal(
      calls.filter((target) => target === root).length,
      1,
      'root confinement still uses a resolved physical path',
    );
  },
);

test('an expected canonical pathname refuses a link inserted after caller validation before opening bytes', async (t) => {
  const root = tempDirSync('paqvilo-read-expected-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'),
    hidden = path.join(root, '.paqvilo');
  fs.mkdirSync(source);
  fs.mkdirSync(hidden);
  const file = path.join(source, 'file.txt');
  fs.writeFileSync(file, 'original');
  fs.writeFileSync(path.join(hidden, 'file.txt'), 'invented private bytes');
  const expectedRealPath = fs.realpathSync(file);
  fs.renameSync(source, `${source}-original`);
  fs.symlinkSync(hidden, source, process.platform === 'win32' ? 'junction' : 'dir');
  t.mock.method(fs, 'openSync', () => assert.fail('changed canonical path must be refused before opening'));
  assert.throws(() => readLocalFileSync(file, { root, expectedRealPath }), /changed before reading/);
});

test('descriptor reads preserve bytes and reject oversize, directories and escaping roots', async (t) => {
  const root = tempDirSync('paqvilo-read-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const file = path.join(source, 'file.txt');
  fs.writeFileSync(file, '\uFEFFsafe\r\n');
  for (const read of [readLocalFile, readLocalFileSync]) {
    assert.equal(await read(file, { root: source, maxBytes: 20, encoding: 'utf8' }), '\uFEFFsafe\r\n');
    await assert.rejects(async () => read(file, { maxBytes: 2 }), /read limit/);
    await assert.rejects(
      async () => read(source),
      (error) => /regular/.test(error.message) || ['EISDIR', 'EACCES', 'EPERM'].includes(error.code),
    );
    await assert.rejects(async () => read(file, { root: path.join(root, 'other') }), /ENOENT/);
  }
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  await assert.rejects(readLocalFile(outside, { root: source }), /outside/);
  assert.throws(() => readLocalFileSync(outside, { root: source }), /outside/);
});

test('path replacement after opening never returns replacement bytes', async (t) => {
  const root = tempDirSync('paqvilo-swap-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'original');
  const open = fs.promises.open.bind(fs.promises);
  const mock = t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    await fs.promises.rename(file, file + '.old');
    await fs.promises.writeFile(file, 'replacement');
    return handle;
  });
  await assert.rejects(readLocalFile(file), /changed/);
  mock.mock.restore();
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (...args) => {
    const descriptor = openSync(...args);
    fs.renameSync(file, file + '.new');
    fs.writeFileSync(file, 'new replacement');
    return descriptor;
  });
  assert.throws(() => readLocalFileSync(file), /changed/);
});

test('a file growing during a descriptor read is bounded and rejected', async (t) => {
  const root = tempDirSync('paqvilo-grow-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'safe');
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    let grew = false;
    handle.read = async (...input) => {
      assert.ok(input[0].length <= 5, 'only the initial size plus one is allocated');
      if (!grew) {
        grew = true;
        fs.appendFileSync(file, 'x'.repeat(10000));
      }
      return read(...input);
    };
    return handle;
  });
  await assert.rejects(readLocalFile(file, { maxBytes: 10 }), /changed/);
});

test('adjacent 64-bit file identities cannot collapse into one rounded Number', async (t) => {
  const root = tempDirSync('paqvilo-inode-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'original');
  const openedId = 9007199254740992n,
    replacementId = openedId + 1n;
  assert.equal(Number(openedId), Number(replacementId), 'the numeric stat API loses this identity difference');
  const withIdentity = (stat, id, options) =>
    Object.assign(stat, { dev: options?.bigint ? 1n : 1, ino: options?.bigint ? id : Number(id) });
  const open = fs.promises.open.bind(fs.promises),
    stat = fs.promises.stat.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args),
      descriptorStat = handle.stat.bind(handle);
    handle.stat = async (options) => withIdentity(await descriptorStat(options), openedId, options);
    return handle;
  });
  t.mock.method(fs.promises, 'stat', async (target, options) =>
    withIdentity(await stat(target, options), replacementId, options),
  );
  await assert.rejects(readLocalFile(file), /changed/);
  const fstat = fs.fstatSync,
    statSync = fs.statSync;
  t.mock.method(fs, 'fstatSync', (descriptor, options) => withIdentity(fstat(descriptor, options), openedId, options));
  t.mock.method(fs, 'statSync', (target, options) => withIdentity(statSync(target, options), replacementId, options));
  assert.throws(() => readLocalFileSync(file), /changed/);
});
