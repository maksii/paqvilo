import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runStorageContract } from '../testing.mjs';
import { ProviderError, assertProvider } from '../lib/storage-provider.mjs';
import { createLocalDiskStorage } from '../lib/storage-local-disk.mjs';
import { createMemoryStorage } from '../lib/storage-memory.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function localDisk(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'storage-local-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const storage = createLocalDiskStorage({ root: path.join(root, 'blobs') });
  ownedFixture(t).add(() => storage.close());
  return storage;
}

runStorageContract(test, localDisk, { label: 'local-disk' });
// The in-memory provider (lib/storage-memory.mjs), the default for runtimes without a state directory, on wall time and on a far clock.
runStorageContract(
  test,
  (t) => {
    const storage = assertProvider(createMemoryStorage());
    t.after(() => storage.close());
    return storage;
  },
  { label: 'memory' },
);

// A provider on a fixed clock far from wall time: the contract's SAS expiries come from the same clock.
const farClock = fixedClock(Date.parse('2030-01-01T00:00:00.000Z'));
runStorageContract(
  test,
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'storage-local-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
    const storage = createLocalDiskStorage({ root: path.join(root, 'blobs'), clock: farClock.now });
    ownedFixture(t).add(() => storage.close());
    return storage;
  },
  { label: 'local-disk fixed clock', clock: farClock },
);
runStorageContract(test, () => createMemoryStorage({ clock: farClock }), {
  label: 'memory fixed clock',
  clock: farClock,
});

test('local-disk keeps bytes content-addressed, survives reopen and compacts orphans', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'storage-local-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const blobs = path.join(root, 'blobs');
  const first = createLocalDiskStorage({ root: blobs });
  // Closed explicitly below; also owned so a failed assertion cannot leave it open while the root is removed.
  ownedFixture(t).add(() => first.close());
  const a = await first.put('x/one', Buffer.from('same'));
  const b = await first.put('x/two', Buffer.from('same'));
  assert.equal(a.sha256, b.sha256);
  assert.deepEqual(await fs.readdir(path.join(blobs, 'objects')), [a.sha256]);
  const index = JSON.parse(await fs.readFile(path.join(blobs, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index.entries).sort(), ['x/one', 'x/two']);
  await first.close();

  const second = createLocalDiskStorage({ root: blobs });
  ownedFixture(t).add(() => second.close());
  assert.equal((await second.head('x/one')).etag, a.etag);
  await fs.writeFile(path.join(blobs, 'objects', 'f'.repeat(64)), 'orphan');
  await fs.writeFile(path.join(blobs, 'tmp', 'put-abandoned'), 'partial');
  assert.deepEqual(await second.compact(), { removed: 1, bytes: 6 });
  assert.deepEqual(await fs.readdir(path.join(blobs, 'tmp')), []);
  assert.equal(await second.delete('x/one'), true);
  assert.deepEqual(
    await fs.readdir(path.join(blobs, 'objects')),
    [a.sha256],
    'shared object stays while x/two references it',
  );
  assert.equal(await second.delete('x/two'), true);
  assert.deepEqual(await fs.readdir(path.join(blobs, 'objects')), []);
});

test('local-disk paths never leave the root and SAS uses a configurable base URL', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'storage-local-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const storage = createLocalDiskStorage({
    root,
    ids: () => '/../../../escape',
    sasBaseUrl: 'http://127.0.0.1:5000/_sas/blobs/',
  });
  ownedFixture(t).add(() => storage.close());
  await assert.rejects(
    storage.put('x/key', Buffer.from('x')),
    (e) => e instanceof ProviderError && e.code === 'InvalidKey',
  );
  await assert.rejects(storage.put('../x', Buffer.from('x')), (e) => e.code === 'InvalidKey');
  const url = await storage.sas('x/key', { permission: 'rw' });
  assert.match(url, /^http:\/\/127\.0\.0\.1:5000\/_sas\/blobs\/x\/key\?se=/);
  assert.equal(storage.verifySas(url, { permission: 'w' }).key, 'x/key');
});

test('local-disk enforces maxBytes as TooLarge without publishing a partial object', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'storage-local-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const storage = createLocalDiskStorage({ root, maxBytes: 4 });
  ownedFixture(t).add(() => storage.close());
  await assert.rejects(
    storage.put('x/big', Buffer.from('12345')),
    (e) => e.code === 'TooLarge' && e.status === 413 && e.provider === 'local',
  );
  assert.equal(await storage.head('x/big'), null);
  assert.deepEqual(await fs.readdir(path.join(root, 'tmp')), []);
});
