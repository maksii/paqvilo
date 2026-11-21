// @test-kind security: Paqvilo's scaffold writes never follow a link a project or another account could have placed
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertScaffoldPath, writeScaffold } from '../lense/scaffold.mjs';

async function physicalTemp(t, parent = os.tmpdir()) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'paqvilo-scaffold-path-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('a link the user or a project created is refused anywhere in a scaffold path', async (t) => {
  const root = await physicalTemp(t);
  const physical = path.join(root, 'physical');
  const alias = path.join(root, 'alias');
  await fs.mkdir(physical);
  await fs.symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    assertScaffoldPath(path.join(alias, 'project'), { directory: true }),
    /Scaffold path must be a regular directory without symbolic links/,
  );
  await assert.rejects(writeScaffold(path.join(alias, 'project'), { 'a.txt': 'x' }), /without symbolic links/);
  assert.deepEqual(await fs.readdir(physical), [], 'nothing was written through the link');
  await assert.rejects(assertScaffoldPath(alias, { directory: true }), /without symbolic links/);
});

// macOS installs /tmp and /var as root-owned links into /private; every temporary folder is reached through them.
const systemTmp = (() => {
  try {
    const info = fsSync.lstatSync('/tmp');
    return process.platform !== 'win32' && info.isSymbolicLink() && info.uid === 0;
  } catch {
    return false;
  }
})();

test(
  'an operating-system link above the project, such as macOS /tmp, does not block scaffolding',
  { skip: !systemTmp && 'this host has no root-owned /tmp link' },
  async (t) => {
    const root = await physicalTemp(t, '/tmp');
    const viaLink = path.join('/tmp', path.basename(root));
    assert.notEqual(viaLink, root, 'the path is reached through the system link');
    const project = path.join(viaLink, 'project');
    assert.equal(await assertScaffoldPath(project, { directory: true }), project);
    const result = await writeScaffold(project, { 'README.md': 'invented\n' });
    assert.deepEqual(result.created, ['README.md']);
    assert.equal(await fs.readFile(path.join(root, 'project', 'README.md'), 'utf8'), 'invented\n');
    // A user link below the system link is still refused.
    await fs.symlink(path.join(root, 'project'), path.join(root, 'alias'), 'dir');
    await assert.rejects(
      assertScaffoldPath(path.join(viaLink, 'alias', 'nested'), { directory: true }),
      /without symbolic links/,
    );
    // Windows reports every owner as 0: no link is a system link there.
    await assert.rejects(
      assertScaffoldPath(project, { directory: true, platform: 'win32' }),
      /without symbolic links: \/tmp$/,
    );
  },
);
