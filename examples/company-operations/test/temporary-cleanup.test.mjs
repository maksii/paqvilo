import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  assertTemporaryDirectory,
  makeTemporaryDirectory,
  ownedFixture,
} from 'paqvilo/mirage/testing/owned-fixture.mjs';

const execFileAsync = promisify(execFile);

async function workspace(t, prefix) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), prefix));
  ownedFixture(t).remove(async () => {
    await fs.rm(await assertTemporaryDirectory(root), { recursive: true, force: true });
  });
  return root;
}

test(
  'the real portal packaging test removes its physical fixture through a linked TEMP',
  { timeout: 90_000 },
  async (t) => {
    const root = await workspace(t, 'paq-packaging-linked-temp-');
    const physical = path.join(root, 'physical-temp');
    const alias = path.join(root, 'linked-temp');
    await fs.mkdir(physical);
    await fs.symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    // This is a separate real test runner, not another worker of the parent runner.
    const env = { ...process.env, TEMP: alias, TMP: alias, TMPDIR: alias };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        '--test-name-pattern=^portal packaging discovers component types and uses valid non-Entity flags$',
        fileURLToPath(new URL('./portal-security.test.mjs', import.meta.url)),
      ],
      {
        env,
        windowsHide: true,
        timeout: 60_000,
        signal: t.signal,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.match(stdout, /# tests 1\r?\n/);
    assert.match(stdout, /# fail 0\r?\n/);
    assert.match(stdout, /# skipped 0\r?\n/);
    assert.deepEqual(await fs.readdir(physical), [], 'the complete packaging fixture was removed after its assertions');
  },
);

test('temporary cleanup rejects physical parent, prefix siblings and traversal before deletion', async (t) => {
  const root = await workspace(t, 'paq-temporary-boundary-');
  const parent = path.join(root, 'owned');
  const sibling = path.join(root, 'owned-sibling');
  const child = path.join(parent, 'child');
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(sibling);
  const sentinel = path.join(sibling, 'preserve.txt');
  await fs.writeFile(sentinel, 'unrelated fixture');
  const alias = path.join(parent, 'redirected-child');
  await fs.symlink(sibling, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const remove = async (directory) => {
    await fs.rm(await assertTemporaryDirectory(directory, { parent }), { recursive: true, force: true });
  };
  for (const directory of [parent, sibling, path.join(child, '..', '..', 'owned-sibling'), alias]) {
    await assert.rejects(remove(directory));
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'unrelated fixture');
    assert.equal((await fs.stat(parent)).isDirectory(), true);
  }
  await remove(child);
  await assert.rejects(fs.stat(child), { code: 'ENOENT' });
});
