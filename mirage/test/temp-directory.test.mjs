import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTemporaryDirectory, makeTemporaryDirectorySync, ownedFixture } from '../testing/owned-fixture.mjs';

test('temporary workspace creators resolve physical parents while retaining distinct complete prefixes', async (t) => {
  const parent = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-temp-parent-'));
  ownedFixture(t).remove(() => fs.rm(parent, { recursive: true, force: true }));
  const physical = path.join(parent, 'physical'),
    alias = path.join(parent, 'alias');
  await fs.mkdir(physical);
  await fs.symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const asynchronous = await makeTemporaryDirectory(path.join(alias, 'asynchronous workspace '));
  const synchronous = makeTemporaryDirectorySync(path.join(alias, 'synchronous workspace '));
  assert.equal(asynchronous, await fs.realpath(asynchronous));
  assert.equal(synchronous, await fs.realpath(synchronous));
  assert.equal(path.dirname(asynchronous), physical);
  assert.equal(path.dirname(synchronous), physical);
  assert.ok(path.basename(asynchronous).startsWith('asynchronous workspace '));
  assert.ok(path.basename(synchronous).startsWith('synchronous workspace '));
  assert.notEqual(asynchronous, synchronous);
  await fs.writeFile(path.join(asynchronous, 'invented.txt'), 'invented');
  assert.equal(await fs.readFile(path.join(alias, path.basename(asynchronous), 'invented.txt'), 'utf8'), 'invented');
});
