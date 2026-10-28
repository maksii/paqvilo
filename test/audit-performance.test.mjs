import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import { auditOutput, writeAuditOutput, auditDependencies } from '../scripts/audit-qualification.mjs';

async function fixture(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-audit-qualification-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  await fs.writeFile(path.join(root, '.gitignore'), '.paqvilo/\n');
  const manifest = { name: 'invented-audit', type: 'module', dependencies: { 'invented-dependency': '1.0.0' } };
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': manifest,
      'node_modules/invented-dependency': { version: '1.0.0' },
      'node_modules/other-platform': { version: '1.0.0', os: [process.platform === 'win32' ? 'linux' : 'win32'] },
    },
  };
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json'])
    await fs.writeFile(path.join(root, file), JSON.stringify(lock));
  const installed = path.join(root, 'node_modules/invented-dependency');
  await fs.mkdir(installed, { recursive: true });
  await fs.writeFile(path.join(installed, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  git('add', '.gitignore', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json');
  return { root, env, installed, git };
}

test('benchmark CLI rejects tracked output before probing and preserves source bytes', async (t) => {
  const { root, env } = await fixture(t);
  const file = path.join(root, 'package.json');
  const before = await fs.readFile(file);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/audit-performance.mjs', import.meta.url)),
      '--samples',
      '1',
      '--output',
      'package.json',
    ],
    { cwd: root, env, encoding: 'utf8', windowsHide: true },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /new JSON file under ignored/);
  assert.deepEqual(await fs.readFile(file), before);
});

test('audit qualification ignores inherited Git repository and index redirection', async (t) => {
  const { root, env } = await fixture(t);
  const module = new URL('../scripts/audit-qualification.mjs', import.meta.url).href;
  const index = path.join(root, 'unrelated-index');
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {auditOutput, auditGit} from ${JSON.stringify(module)};
    const root=process.argv[1];
    await auditOutput(root,'.paqvilo/audit/qualified.json');
    const result=auditGit(root,['write-tree'],{encoding:'utf8'});
    if(result.status!==0) throw Error(result.stderr);
    console.log(result.stdout.trim());
  `,
      root,
    ],
    {
      env: { ...env, GIT_DIR: path.join(root, 'missing-repository'), GIT_INDEX_FILE: index },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^[a-f0-9]{40}$/);
  await assert.rejects(fs.stat(index), { code: 'ENOENT' });
});

test('audit storage rejects traversal, linked parents and existing files; writes are exclusive', async (t) => {
  const { root, git } = await fixture(t);
  for (const name of ['.paqvilo/audit/../../../package.json', '.paqvilo/elsewhere.json', '.paqvilo/audit/report.txt'])
    await assert.rejects(auditOutput(root, name), /new JSON file/);
  const output = await auditOutput(root, '.paqvilo/audit/nested/report.json');
  await writeAuditOutput(output, '{"qualified":true}\n');
  await assert.rejects(auditOutput(root, output.file), /already exists/);
  await assert.rejects(writeAuditOutput(output, 'clobbered'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(output.file, 'utf8'), '{"qualified":true}\n');
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(root, '.paqvilo/audit/linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(auditOutput(root, '.paqvilo/audit/linked/report.json'), /ordinary owned directories/);
  assert.deepEqual(await fs.readdir(outside), []);
  const tracked = path.join(root, '.paqvilo/audit/tracked.json');
  await fs.writeFile(tracked, 'tracked source');
  git('add', '--force', '.paqvilo/audit/tracked.json');
  await assert.rejects(auditOutput(root, tracked), /ignored and untracked/);
  assert.equal(await fs.readFile(tracked, 'utf8'), 'tracked source');
  const target = path.join(outside, 'target.json');
  await fs.writeFile(target, 'existing bytes');
  await fs.symlink(
    outside,
    path.join(root, '.paqvilo/audit/leaf-parent'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(auditOutput(root, '.paqvilo/audit/leaf-parent/target.json'), /ordinary owned directories/);
  assert.equal(await fs.readFile(target, 'utf8'), 'existing bytes');
});

test('benchmark qualification rejects stale installed dependencies and fingerprints lock changes', async (t) => {
  const { root, installed } = await fixture(t);
  const first = await auditDependencies(root);
  assert.equal(first.packages, 1, 'nonapplicable platform dependencies are excluded');
  await fs.writeFile(path.join(installed, 'runtime.mjs'), 'export const value = 1;');
  const withCode = await auditDependencies(root);
  assert.notEqual(withCode.sha256, first.sha256);
  await fs.writeFile(path.join(installed, 'runtime.mjs'), 'export const value = 2;');
  assert.notEqual(
    (await auditDependencies(root)).sha256,
    withCode.sha256,
    'same-version installed code changes invalidate the comparison',
  );
  await fs.writeFile(path.join(installed, 'package.json'), '{"version":"2.0.0"}');
  await assert.rejects(auditDependencies(root), /dependencies are not prepared/);
  await fs.writeFile(path.join(installed, 'package.json'), '{"version":"1.0.0"}');
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const target = path.join(root, file);
    const lock = JSON.parse(await fs.readFile(target, 'utf8'));
    lock.packages['node_modules/invented-dependency'].integrity = 'invented-lock-change';
    await fs.writeFile(target, JSON.stringify(lock));
  }
  assert.notEqual((await auditDependencies(root)).sha256, first.sha256);
});

test('benchmark qualification rejects dependency links whose targets can change outside the package', async (t) => {
  const { root, installed } = await fixture(t);
  const outside = path.join(root, 'mutable-outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'runtime.mjs'), 'export const mutable = 1;');
  await fs.symlink(outside, path.join(installed, 'linked-runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(auditDependencies(root), /linked dependency contents/);
});
