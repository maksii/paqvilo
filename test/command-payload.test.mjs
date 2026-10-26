import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { persistCommandPayload, pruneCommandPayloads, MAX_COMMAND_PAYLOAD_BYTES } from '../lense/command-payload.mjs';
import { tempDirSync } from './fixture.mjs';

function fixture(t) {
  const root = tempDirSync('paqvilo-command-payload-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, '.paqvilo', 'commands') };
}
const payload = (name = 'invented') =>
  Buffer.from(JSON.stringify([[path.resolve('bin/paqvilo.mjs'), 'mirage', 'stop', '--site', name]]));
const filename = (directory, bytes) =>
  path.join(directory, `stop-${createHash('sha256').update(bytes).digest('hex')}.json`);

test('command payload publication is confined, byte-exact, content-addressed and idempotent', (t) => {
  const { directory } = fixture(t);
  const bytes = payload('Unicode Ω and quotes " $ % !');
  const file = persistCommandPayload(directory, bytes);
  assert.equal(file, filename(directory, bytes));
  assert.ok(path.isAbsolute(file));
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(persistCommandPayload(directory, bytes), file);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
  assert.equal(fs.statSync(file).nlink, 1);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
});

test('invalid, oversized and non-UTF8 command payloads fail before creating storage without exposing input', (t) => {
  const { directory } = fixture(t);
  for (const bytes of [
    null,
    'not a buffer',
    Buffer.alloc(0),
    Buffer.alloc(MAX_COMMAND_PAYLOAD_BYTES + 1),
    Buffer.from([0xff]),
    Buffer.from('private-value: invalid-json'),
  ]) {
    assert.throws(
      () => persistCommandPayload(directory, bytes),
      (error) => error.code === 'COMMAND_PAYLOAD_INVALID' && !error.message.includes('private-value'),
    );
    assert.equal(fs.existsSync(directory), false);
  }
  assert.throws(() => persistCommandPayload('relative/commands', payload()), { code: 'COMMAND_PAYLOAD_DIRECTORY' });
  assert.throws(() => persistCommandPayload(directory + '\0hidden', payload()), { code: 'COMMAND_PAYLOAD_DIRECTORY' });
});

test('existing nonmatching payload and directory targets are preserved instead of overwritten', (t) => {
  const { directory } = fixture(t);
  fs.mkdirSync(directory, { recursive: true });
  const bytes = payload();
  const file = filename(directory, bytes);
  fs.writeFileSync(file, 'user content');
  assert.throws(() => persistCommandPayload(directory, bytes), { code: 'COMMAND_PAYLOAD_CONFLICT' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'user content');
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => persistCommandPayload(directory, bytes), { code: 'COMMAND_PAYLOAD_CONFLICT' });
  assert.ok(fs.statSync(file).isDirectory());
});

test('failed publication preserves a regular user file that replaced the temporary inode', (t) => {
  const { directory } = fixture(t);
  let replaced;
  t.mock.method(fs, 'linkSync', (temporary) => {
    const replacement = path.join(directory, 'user-replacement.tmp');
    fs.writeFileSync(replacement, 'unfamiliar user content');
    fs.unlinkSync(temporary);
    fs.renameSync(replacement, temporary);
    replaced = temporary;
    throw Object.assign(new Error('Injected publication failure'), { code: 'EIO' });
  });
  assert.throws(() => persistCommandPayload(directory, payload()), { code: 'COMMAND_PAYLOAD_WRITE' });
  assert.ok(replaced);
  assert.equal(fs.readFileSync(replaced, 'utf8'), 'unfamiliar user content');
  assert.deepEqual(fs.readdirSync(directory), [path.basename(replaced)]);
});

test('descriptor-first reuse rejects a pathname replaced after acquisition and preserves both files', (t) => {
  const { directory } = fixture(t);
  const bytes = payload('descriptor race');
  const file = persistCommandPayload(directory, bytes);
  const displaced = path.join(directory, 'displaced-original.json');
  const open = fs.openSync,
    stat = fs.lstatSync;
  let acquired = false,
    preOpenChecks = 0;
  t.mock.method(fs, 'lstatSync', (name, ...args) => {
    if (String(name) === file && !acquired) preOpenChecks++;
    return stat(name, ...args);
  });
  t.mock.method(fs, 'openSync', (name, ...args) => {
    const handle = open(name, ...args);
    if (String(name) === file && !acquired) {
      acquired = true;
      fs.renameSync(file, displaced);
      fs.writeFileSync(file, 'unfamiliar replacement');
    }
    return handle;
  });
  assert.throws(() => persistCommandPayload(directory, bytes), { code: 'COMMAND_PAYLOAD_CONFLICT' });
  assert.equal(acquired, true);
  assert.equal(preOpenChecks, 0, 'no pathname admission check precedes descriptor acquisition');
  assert.deepEqual(fs.readFileSync(displaced), bytes);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unfamiliar replacement');
});

test('oversized descriptor targets are refused before any payload bytes are read', (t) => {
  const { directory } = fixture(t);
  const bytes = payload('oversized existing');
  fs.mkdirSync(directory, { recursive: true });
  const file = filename(directory, bytes);
  fs.writeFileSync(file, Buffer.alloc(MAX_COMMAND_PAYLOAD_BYTES + 1));
  let reads = 0;
  t.mock.method(fs, 'readSync', () => {
    reads++;
    throw Error('No oversized descriptor read is permitted');
  });
  assert.throws(() => persistCommandPayload(directory, bytes), { code: 'COMMAND_PAYLOAD_CONFLICT' });
  assert.equal(reads, 0);
  assert.equal(fs.statSync(file).size, MAX_COMMAND_PAYLOAD_BYTES + 1);
});

for (const phase of ['fast reuse', 'collision reuse', 'publication']) {
  test(`directory identity is admitted again after ${phase} even when a junction preserves the same payload inode`, (t) => {
    const { root, directory } = fixture(t);
    const bytes = payload('directory replacement ' + phase);
    const file = filename(directory, bytes);
    const displaced = path.join(root, 'displaced-commands');
    if (phase !== 'publication') persistCommandPayload(directory, bytes);
    const replaceDirectory = () => {
      fs.renameSync(directory, displaced);
      fs.symlinkSync(displaced, directory, process.platform === 'win32' ? 'junction' : 'dir');
      fs.writeFileSync(path.join(displaced, 'user-marker.txt'), 'preserve unfamiliar files');
    };
    if (phase === 'publication') {
      const link = fs.linkSync;
      t.mock.method(fs, 'linkSync', (from, to) => {
        link(from, to);
        replaceDirectory();
      });
    } else {
      const open = fs.openSync;
      let targetOpens = 0;
      t.mock.method(fs, 'openSync', (name, ...args) => {
        if (String(name) !== file) return open(name, ...args);
        targetOpens++;
        if (phase === 'collision reuse' && targetOpens === 1)
          throw Object.assign(new Error('Invented absent initial lookup'), { code: 'ENOENT' });
        replaceDirectory();
        return open(name, ...args);
      });
    }
    assert.throws(() => persistCommandPayload(directory, bytes), { code: 'COMMAND_PAYLOAD_DIRECTORY' });
    assert.ok(fs.lstatSync(directory).isSymbolicLink());
    assert.deepEqual(fs.readFileSync(path.join(displaced, path.basename(file))), bytes);
    assert.equal(fs.readFileSync(path.join(displaced, 'user-marker.txt'), 'utf8'), 'preserve unfamiliar files');
  });
}

test('trusted parent aliases resolve to one canonical store while linked commands folders are refused', (t) => {
  const { root } = fixture(t);
  const parent = path.join(root, 'actual-state');
  fs.mkdirSync(parent);
  const alias = path.join(root, 'state-alias');
  fs.symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const bytes = payload();
  const file = persistCommandPayload(path.join(alias, 'commands'), bytes);
  assert.equal(file, filename(path.join(parent, 'commands'), bytes));
  assert.equal(persistCommandPayload(path.join(parent, 'commands'), bytes), file);
  const aliasedFile = path.join(alias, 'commands', path.basename(file));
  assert.deepEqual(pruneCommandPayloads(path.join(alias, 'commands'), [file], [aliasedFile]), []);
  assert.deepEqual(pruneCommandPayloads(path.join(parent, 'commands'), [aliasedFile], []), [file]);
  const linkedFolder = path.join(parent, 'commands-link');
  fs.symlinkSync(path.join(parent, 'commands'), linkedFolder, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => persistCommandPayload(linkedFolder, bytes), { code: 'COMMAND_PAYLOAD_DIRECTORY' });
});

test('payload writes reject linked targets and hard-linked user files', (t) => {
  const { root, directory } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(directory, { recursive: true });
  const bytes = payload(),
    file = filename(directory, bytes);
  fs.symlinkSync(outside, file, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => persistCommandPayload(directory, bytes), { code: 'COMMAND_PAYLOAD_CONFLICT' });
  fs.unlinkSync(file);
  const userFile = path.join(outside, 'keep.json');
  fs.writeFileSync(userFile, bytes);
  fs.linkSync(userFile, file);
  assert.throws(() => persistCommandPayload(directory, bytes), { code: 'COMMAND_PAYLOAD_CONFLICT' });
  assert.deepEqual(fs.readFileSync(userFile), bytes);
});

test(
  'concurrent identical publishers reuse the completed canonical payload after temporary hard links retire',
  { timeout: 10000 },
  async (t) => {
    const { directory } = fixture(t);
    const bytes = payload('shared publication');
    const start = new SharedArrayBuffer(4);
    const workers = Array.from(
      { length: 6 },
      () =>
        new Worker(
          `
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    (async () => {
      const { persistCommandPayload } = await import(workerData.module);
      const unlink = fs.unlinkSync;
      fs.unlinkSync = (file) => {
        if (String(file).endsWith('.tmp')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
        return unlink(file);
      };
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.start), 0, 0);
      try { parentPort.postMessage({ file: persistCommandPayload(workerData.directory, Buffer.from(workerData.bytes)) }); }
      catch (error) { parentPort.postMessage({ error: error.code }); }
    })();
  `,
          {
            eval: true,
            workerData: {
              module: new URL('../lense/command-payload.mjs', import.meta.url).href,
              directory,
              bytes,
              start,
            },
          },
        ),
    );
    t.after(() => Promise.all(workers.map((worker) => worker.terminate())));
    const ready = [],
      outcomes = [];
    for (const worker of workers) {
      ready.push(
        new Promise((resolve, reject) => {
          worker.once('error', reject);
          worker.on('message', (message) => {
            if (message.ready) resolve();
          });
        }),
      );
      outcomes.push(
        new Promise((resolve, reject) => {
          worker.once('error', reject);
          worker.on('message', (message) => {
            if (message.file || message.error) resolve(message);
          });
        }),
      );
    }
    await Promise.all(ready);
    Atomics.store(new Int32Array(start), 0, 1);
    Atomics.notify(new Int32Array(start), 0);
    const results = await Promise.all(outcomes);
    assert.ok(
      results.every((result) => result.file === filename(directory, bytes)),
      JSON.stringify(results),
    );
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise((resolve) => {
            if (worker.threadId === -1) resolve();
            else worker.once('exit', resolve);
          }),
      ),
    );
    assert.deepEqual(fs.readdirSync(directory), [path.basename(filename(directory, bytes))]);
    assert.deepEqual(fs.readFileSync(filename(directory, bytes)), bytes);
    assert.equal(fs.statSync(filename(directory, bytes)).nlink, 1);
  },
);

test('pruning only releases explicitly named intact payloads without remaining owners', (t) => {
  const { root, directory } = fixture(t);
  const released = persistCommandPayload(directory, payload('released'));
  const retained = persistCommandPayload(directory, payload('retained'));
  const inflight = persistCommandPayload(directory, payload('inflight'));
  const outside = path.join(root, path.basename(released));
  const userFile = path.join(directory, 'notes.json');
  const temporary = path.join(directory, '.stop-user.tmp');
  fs.writeFileSync(outside, 'outside user file');
  fs.writeFileSync(userFile, 'user notes');
  fs.writeFileSync(temporary, 'user temporary file');
  const refs = process.platform === 'win32' ? [retained.toUpperCase()] : [retained];
  assert.deepEqual(
    pruneCommandPayloads(
      directory,
      [released, released, retained, outside, userFile, temporary, '../escape', null],
      refs,
    ),
    [released],
  );
  assert.ok(fs.existsSync(retained));
  assert.ok(fs.existsSync(inflight), 'unregistered in-flight payload is never swept');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside user file');
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'user notes');
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'user temporary file');
  assert.deepEqual(pruneCommandPayloads(directory, [released], []), []);
  assert.deepEqual(pruneCommandPayloads(directory, [retained], []), [retained]);
  assert.deepEqual(pruneCommandPayloads(path.join(root, 'absent'), [], []), []);
});

test('pruning preserves tampered payloads, directories, links and files outside exact storage', (t) => {
  const { root, directory } = fixture(t);
  const corrupt = persistCommandPayload(directory, payload('corrupt'));
  fs.writeFileSync(corrupt, 'user replaced content');
  const linked = filename(directory, payload('link'));
  const outside = path.join(root, 'user');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const folder = filename(directory, payload('directory'));
  fs.mkdirSync(folder);
  const hardlinked = filename(directory, payload('hardlink'));
  const userFile = path.join(root, 'user.json');
  fs.writeFileSync(userFile, payload('hardlink'));
  fs.linkSync(userFile, hardlinked);
  assert.deepEqual(pruneCommandPayloads(directory, [corrupt, linked, folder, hardlinked], []), []);
  assert.equal(fs.readFileSync(corrupt, 'utf8'), 'user replaced content');
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(fs.existsSync(hardlinked));
  const alias = path.join(root, 'commands-alias');
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pruneCommandPayloads(alias, [path.join(alias, path.basename(corrupt))], []), {
    code: 'COMMAND_PAYLOAD_DIRECTORY',
  });
});
