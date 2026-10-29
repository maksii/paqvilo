import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RecordFileLease, collectRecordGarbage } from '../lib/record-file-lease.mjs';

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
