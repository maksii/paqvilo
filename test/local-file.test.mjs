import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLocalFile, readLocalFileSync } from '../lense/local-file.mjs';

test('descriptor reads preserve bytes and reject oversize, directories and escaping roots', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const file = path.join(source, 'file.txt'); fs.writeFileSync(file, '\uFEFFsafe\r\n');
  for (const read of [readLocalFile, readLocalFileSync]) {
    assert.equal((await read(file, { root: source, maxBytes: 20, encoding: 'utf8' })), '\uFEFFsafe\r\n');
    await assert.rejects(async () => read(file, { maxBytes: 2 }), /read limit/);
    await assert.rejects(async () => read(source), /regular/);
    await assert.rejects(async () => read(file, { root: path.join(root, 'other') }), /ENOENT/);
  }
  const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'outside');
  await assert.rejects(readLocalFile(outside, { root: source }), /outside/);
  assert.throws(() => readLocalFileSync(outside, { root: source }), /outside/);
});

test('path replacement after opening never returns replacement bytes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'file'); fs.writeFileSync(file, 'original');
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
    fs.renameSync(file, file + '.new'); fs.writeFileSync(file, 'new replacement');
    return descriptor;
  });
  assert.throws(() => readLocalFileSync(file), /changed/);
});

test('a file growing during a descriptor read is bounded and rejected', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-grow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'file'); fs.writeFileSync(file, 'safe');
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    let grew = false;
    handle.read = async (...input) => {
      assert.ok(input[0].length <= 5, 'only the initial size plus one is allocated');
      if (!grew) { grew = true; fs.appendFileSync(file, 'x'.repeat(10000)); }
      return read(...input);
    };
    return handle;
  });
  await assert.rejects(readLocalFile(file, { maxBytes: 10 }), /changed/);
});
