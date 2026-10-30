import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  RecordFileLease,
  collectRecordGarbage,
  stateRecordOwner,
  openRecordReader,
  claimRecordDirectory,
} from '../lib/record-file-lease.mjs';
import { RecordPageSession } from '../lib/record-tables.mjs';
import { encodeRecordReferences, decodeRecordReferences, restoreRecordReferences } from '../lib/record-state.mjs';

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

const owned = (t, prefix) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
// A journal entry: references leave the state as descriptors and return as placeholders.
const persisted = (rows) =>
  JSON.stringify(encodeRecordReferences({ op: 'section', key: 'state', value: { tables: { item: rows } } }));
const decoded = (text) => decodeRecordReferences(JSON.parse(text));
const marker = (directory) => JSON.parse(fs.readFileSync(path.join(directory, '.record-owner.json'), 'utf8'));

test('a state and its record directory load together after moving and refuse another state', async (t) => {
  const root = owned(t, 'invented-record-move-');
  fs.mkdirSync(path.join(root, 'first'));
  const first = path.join(root, 'first', 'state.json');
  const session = new RecordPageSession(first + '.records', { stateOwner: first });
  const entry = persisted(session.from([{ id: 'kept', value: 'Retained' }], { primaryKey: 'id' }));
  session.close();
  fs.renameSync(path.join(root, 'first'), path.join(root, 'moved'));
  const moved = path.join(root, 'moved', 'state.json');
  const restored = await restoreRecordReferences(decoded(entry).value, moved + '.records', { stateOwner: moved });
  t.after(() => restored.session.close());
  assert.equal(restored.state.tables.item[0].value, 'Retained');
  assert.equal(restored.session.ownedDirectory, true);
  assert.equal(marker(moved + '.records').state, stateRecordOwner(moved), 'The marker follows its state.');
  const fresh = new RecordPageSession(moved + '.records', { stateOwner: moved });
  t.after(() => fresh.close());
  assert.equal(fresh.ownerKey, restored.session.ownerKey);
  assert.throws(
    () => new RecordPageSession(moved + '.records', { stateOwner: path.join(root, 'other.json') }),
    /different state/,
  );
  const foreign = JSON.parse(entry);
  foreign.recordRefs[0].table.owner = 'f'.repeat(64);
  await assert.rejects(
    restoreRecordReferences(decodeRecordReferences(foreign).value, moved + '.records', { stateOwner: moved }),
    /different state/,
  );
});

test('a directory published before owner keys loads after moving and migrates its marker', async (t) => {
  const root = owned(t, 'invented-record-legacy-');
  fs.mkdirSync(path.join(root, 'first'));
  const first = path.join(root, 'first', 'state.json'),
    directory = first + '.records';
  const session = new RecordPageSession(directory, { stateOwner: first });
  const entry = persisted(session.from([{ id: 'legacy', value: 'Earlier' }], { primaryKey: 'id' }));
  session.close();
  const identity = path.join(fs.realpathSync.native(path.dirname(first)), 'state.json');
  const legacyKey = createHash('sha256')
    .update(process.platform === 'win32' ? identity.toLowerCase() : identity)
    .digest('hex');
  fs.writeFileSync(path.join(directory, '.record-owner.json'), JSON.stringify({ format: 1, key: legacyKey }));
  const legacy = JSON.parse(entry),
    descriptor = legacy.recordRefs[0].table;
  delete descriptor.owner;
  delete descriptor.aliases;
  for (const file of descriptor.files) {
    const bytes = fs.readFileSync(path.join(directory, file.name)).subarray(0, file.prefix.bytes);
    file.prefix = {
      format: 1,
      bytes: file.prefix.bytes,
      pages: file.prefix.pages,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  fs.renameSync(path.join(root, 'first'), path.join(root, 'moved'));
  const moved = path.join(root, 'moved', 'state.json');
  const restored = await restoreRecordReferences(decodeRecordReferences(legacy).value, moved + '.records', {
    stateOwner: moved,
  });
  t.after(() => restored.session.close());
  const rows = restored.state.tables.item;
  assert.equal(rows[0].value, 'Earlier');
  assert.deepEqual(marker(moved + '.records'), { format: 2, key: legacyKey, state: stateRecordOwner(moved) });
  const republished = restored.session.describe(rows);
  assert.equal(republished.owner, legacyKey);
  assert.equal(republished.aliases, false);
  assert.ok(republished.files.every((file) => file.prefix.format === 2));
});

test(
  'state identity resolves the letter case and short name of an existing state file',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = owned(t, 'invented-record-identity-');
    const file = path.join(root, 'Invented Long State Name.json');
    fs.writeFileSync(file, '{}');
    const short = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${file}") do @echo %~sI`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      windowsHide: true,
    }).trim();
    for (const alias of [file.toUpperCase(), short])
      assert.equal(stateRecordOwner(alias), stateRecordOwner(file), alias);
  },
);

test('owner publication without hard links creates the marker exclusively once', (t) => {
  const root = owned(t, 'invented-record-links-');
  const io = {
    ...fs,
    linkSync() {
      throw Object.assign(Error('Invented filesystem without hard links'), { code: 'EPERM' });
    },
  };
  const first = claimRecordDirectory(root, { io });
  assert.equal(first.owned, true);
  assert.deepEqual(marker(root), { format: 2, key: first.key });
  assert.deepEqual(fs.readdirSync(root), ['.record-owner.json']);
  fs.rmSync(path.join(root, '.record-owner.json'));
  let published = false;
  const exclusive = {
    ...io,
    openSync(file, flags, mode) {
      // Another runtime publishes between this runtime's listing and its exclusive create.
      if (flags === 'wx' && file.endsWith('.record-owner.json') && !published) {
        published = true;
        fs.writeFileSync(file, JSON.stringify({ format: 2, key: 'a'.repeat(64) }), { flag: 'wx' });
      }
      return fs.openSync(file, flags, mode);
    },
  };
  assert.deepEqual(claimRecordDirectory(root, { io: exclusive }), { key: 'a'.repeat(64), owned: true });
  assert.deepEqual(marker(root), { format: 2, key: 'a'.repeat(64) });
  const session = new RecordPageSession(root, { ownerKey: 'a'.repeat(64) });
  t.after(() => session.close());
  assert.equal(session.ownedDirectory, true);
  const denied = owned(t, 'invented-record-denied-');
  assert.throws(
    () =>
      claimRecordDirectory(denied, {
        io: {
          ...io,
          linkSync() {
            throw Object.assign(Error('Invented denied link'), { code: 'EIO' });
          },
        },
      }),
    /Invented denied link/,
  );
  assert.deepEqual(fs.readdirSync(denied), []);
});

test('stale temporaries of exited processes are removed, and an unmarked directory reports its ownership', async (t) => {
  const root = owned(t, 'invented-record-leftovers-');
  const exited = spawnSync(process.execPath, ['-e', '']).pid;
  const stale = [
    `${exited}-${randomUUID()}.sort`,
    `${exited}-${randomUUID()}.lease.tmp`,
    `${exited}-${randomUUID()}.owner.tmp`,
    `${randomUUID()}.sort`,
    `${randomUUID()}-${randomUUID()}.lease.tmp`,
  ];
  const live = `${process.pid}-${randomUUID()}.sort`;
  for (const name of [...stale, live]) fs.writeFileSync(path.join(root, name), 'Invented');
  const session = new RecordPageSession(root);
  t.after(() => session.close());
  assert.equal(session.ownedDirectory, true, 'Crash leftovers no longer leave the directory unowned.');
  assert.deepEqual(fs.readdirSync(root).sort(), ['.record-owner.json', live].sort());
  for (const name of stale) fs.writeFileSync(path.join(root, name), 'Invented');
  assert.deepEqual(await collectRecordGarbage(root, []), { removed: stale.length, retained: 1 });
  assert.deepEqual(fs.readdirSync(root).sort(), ['.record-owner.json', live].sort());
  const unmarked = owned(t, 'invented-record-unmarked-');
  fs.writeFileSync(path.join(unmarked, randomUUID() + '.pages'), 'Invented');
  const reader = new RecordPageSession(unmarked);
  t.after(() => reader.close());
  assert.equal(reader.ownedDirectory, false);
  assert.equal(reader.info().ownership, 'missing-owner-marker');
});
