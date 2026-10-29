import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  RecordFileLease,
  collectRecordGarbage,
  stateRecordOwner,
  openRecordReader,
} from '../lib/record-file-lease.mjs';
import { RecordPageSession } from '../lib/record-tables.mjs';
import { encodeRecordReferences } from '../lib/record-state.mjs';

test('a file replaced during opening is rejected and its handle is closed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-record-open-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'lease');
  fs.writeFileSync(file, 'Original');
  let closed = 0;
  assert.throws(
    () =>
      openRecordReader(file, {
        ...fs,
        openSync(...args) {
          const fd = fs.openSync(...args);
          fs.renameSync(file, file + '.old');
          fs.writeFileSync(file, 'Replacement');
          return fd;
        },
        closeSync(fd) {
          closed++;
          fs.closeSync(fd);
        },
      }),
    { code: 'StateIntegrity' },
  );
  assert.equal(closed, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Replacement');
});

test('directory aliases share canonical record ownership, leases and publication identity', async (t) => {
  const root = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'invented-record-paths-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'canonical-directory'),
    link = path.join(root, 'directory-alias');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const aliases = [link];
  if (process.platform === 'win32') {
    const short = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${target}") do @echo %~sI`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      windowsHide: true,
    }).trim();
    if (short !== target) aliases.push(short);
  }
  const session = new RecordPageSession(target, { stateOwner: path.join(target, 'state.json') });
  t.after(() => session.close());
  const rows = session.from([{ id: 'invented-row', value: 'Retained' }], { primaryKey: 'id' });
  for (const alias of aliases) {
    assert.equal(stateRecordOwner(path.join(alias, 'state.json')), stateRecordOwner(path.join(target, 'state.json')));
    const reader = new RecordPageSession(alias, { stateOwner: path.join(alias, 'state.json') });
    t.after(() => reader.close());
    assert.equal(reader.directory, target);
    assert.equal(reader.lease.directory, target);
    assert.doesNotThrow(() =>
      encodeRecordReferences({ tables: { item: rows } }, { directory: alias, ownerKey: reader.ownerKey }),
    );
    const [restored] = await reader.restoreMany([session.describe(rows)]);
    assert.equal(restored[0].value, 'Retained');
  }
});

test('collection preserves committed files and every active reader, then reclaims closed and dead owners', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-record-leases-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = Array.from({ length: 4 }, () => randomUUID() + '.pages');
  for (const name of files) fs.writeFileSync(path.join(root, name), 'Invented');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'Keep');
  const first = new RecordFileLease(root),
    second = new RecordFileLease(root);
  t.after(() => {
    first.close();
    second.close();
  });
  first.protect([files[1]]);
  second.protect([files[2]]);
  assert.deepEqual(await collectRecordGarbage(root, [files[0]]), { removed: 1, retained: 3 });
  first.close();
  assert.deepEqual(await collectRecordGarbage(root, [files[0]]), { removed: 1, retained: 2 });
  assert.deepEqual(await collectRecordGarbage(root, [files[0]], { isAlive: () => false }), { removed: 1, retained: 1 });
  assert.equal(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'), 'Keep');
});

test('a failed lease replacement retains its preceding protection and never admits an unprotected writer', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-record-leases-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let fail = false;
  const lease = new RecordFileLease(root, {
    io: {
      ...fs,
      renameSync: (...args) => {
        if (fail) throw Error('Invented replacement');
        return fs.renameSync(...args);
      },
    },
  });
  t.after(() => lease.close());
  const first = randomUUID() + '.pages',
    second = randomUUID() + '.pages';
  lease.protect([first]);
  const before = fs.readFileSync(lease.file, 'utf8');
  fail = true;
  assert.throws(() => lease.protect([second]), /Invented replacement/);
  assert.equal(fs.readFileSync(lease.file, 'utf8'), before);
  assert.deepEqual([...lease.files], [first]);
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);
});
