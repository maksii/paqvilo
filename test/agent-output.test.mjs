// @test-kind contract: agent screenshot output reservation reports file system refusals as one invalid_argument line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { reserveOutput } from '../lense/commands/agent.mjs';
import { tempDir } from './fixture.mjs';

const oneLine = (pattern) => (error) =>
  error.code === 'invalid_argument' && pattern.test(error.message) && !error.message.includes('\n');

test('an output in a drive or file system root is checked without creating the root folder', async () => {
  // Windows refuses mkdir of a drive root with EPERM even with recursive; an existing root entry must instead be
  // reported as an existing output. Nothing is written: the entry already exists.
  const root = path.parse(process.cwd()).root;
  const entries = await fs.readdir(root, { withFileTypes: true });
  const folder = entries.find((entry) => entry.isDirectory());
  assert.ok(folder, `no folder in ${root}`);
  await assert.rejects(reserveOutput(path.join(root, folder.name)), oneLine(/^Screenshot output already exists: /));
});

test('an output folder is created only when missing, and an existing folder is used as is', async (t) => {
  const dir = await tempDir('paqvilo-agent-output-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const output of [path.join(dir, 'proof.png'), path.join(dir, 'new', 'deeper', 'proof.png')]) {
    const handle = await reserveOutput(output);
    await handle.close();
    assert.equal((await fs.stat(output)).size, 0);
  }
});

test('a file where the output folder should be is one invalid_argument line naming the path', async (t) => {
  const dir = await tempDir('paqvilo-agent-output-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'file'), '');
  for (const output of [path.join(dir, 'file', 'proof.png'), path.join(dir, 'file', 'sub', 'proof.png')]) {
    await assert.rejects(
      reserveOutput(output, path.join(dir, 'catalogue.yml')),
      oneLine(/^Cannot write screenshot output file\/(?:sub\/)?proof\.png \(E[A-Z]+\): choose an --output/),
    );
  }
});

test(
  'a folder without write permission is one invalid_argument line naming the path',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX mode bits bind only non-root' : false },
  async (t) => {
    const dir = await tempDir('paqvilo-agent-output-');
    const locked = path.join(dir, 'locked');
    await fs.mkdir(locked, { mode: 0o500 });
    t.after(async () => {
      await fs.chmod(locked, 0o700);
      await fs.rm(dir, { recursive: true, force: true });
    });
    await assert.rejects(
      reserveOutput(path.join(locked, 'proof.png'), path.join(dir, 'catalogue.yml')),
      oneLine(/^Cannot write screenshot output locked\/proof\.png \(EACCES\): choose an --output/),
    );
  },
);
