import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const run = (cwd, ...args) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true });

test('init handles spaced Unicode paths and reports filesystem errors as JSON', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'OneDrive - Example', 'Проєкт & space');
  const result = run(root, 'init', target, '--name', 'example', '--source-root', './Джерела & files', '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(
    YAML.parse(await fs.readFile(path.join(target, 'paqvilo.config.yml'), 'utf8')).sourceRoot,
    './Джерела & files',
  );
  const blocked = path.join(root, 'regular-file');
  await fs.writeFile(blocked, 'kept');
  const failed = run(root, 'init', blocked, '--name', 'example', '--json');
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).ok, false);
  assert.equal(await fs.readFile(blocked, 'utf8'), 'kept');
});

test('setup and demo reject invalid ports before starting or writing', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const setup = run(root, 'setup', '--port', '65536', '--json');
  assert.equal(setup.status, 1);
  assert.match(JSON.parse(setup.stdout).error.message, /0 and 65535/);
  const target = path.join(root, 'demo');
  const demo = run(root, 'mirage', 'demo', '--dir', target, '--debug-port', '65536');
  assert.equal(demo.status, 1);
  assert.match(demo.stderr, /0 and 65535/);
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  const ignored = run(root, 'mirage', 'demo', '--dir', target, '--scaffold', '--headless');
  assert.equal(ignored.status, 1);
  assert.match(ignored.stderr, /--scaffold cannot be combined/);
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
});

test(
  'init reports an unwritable parent directory without changing it',
  {
    skip: process.platform === 'win32' || (typeof process.geteuid === 'function' && process.geteuid() === 0),
  },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-permissions-'));
    t.after(async () => {
      await fs.chmod(root, 0o700);
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.chmod(root, 0o500);
    const result = run(root, 'init', path.join(root, 'project'), '--name', 'example', '--json');
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.error.message, /EACCES|permission denied/i);
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test('blank scaffold and setup options fail before any filesystem changes', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-blank-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const args of [
    ['init', '', '--json'],
    ['init', '   ', '--json'],
    ['init', '--name=', '--json'],
    ['init', '--site', 'valid', '--site', ' ', '--json'],
    ['setup', '--config=', '--json'],
    ['setup', '--project', ' ', '--json'],
    ['setup', '--port=', '--json'],
  ]) {
    const result = run(root, ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(JSON.parse(result.stdout).error.message, /empty or whitespace/);
    assert.equal(result.stderr, '');
    assert.deepEqual(await fs.readdir(root), []);
  }
  const demo = run(root, 'mirage', 'demo', '--dir=');
  assert.equal(demo.status, 1);
  assert.match(demo.stderr, /--dir must not be empty or whitespace/);
  assert.deepEqual(await fs.readdir(root), []);
});
