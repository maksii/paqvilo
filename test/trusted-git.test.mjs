// @test-kind security+tooling: trusted Git selection never searches attacker-controlled PATH or relative paths.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveGitExecutable } from '../scripts/trusted-git.mjs';

test('an absolute explicit override resolves to a regular executable file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const candidate = path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git');
  fs.writeFileSync(candidate, 'not invoked', { mode: 0o755 });
  assert.equal(resolveGitExecutable({ env: { PAQVILO_GIT_EXECUTABLE: candidate } }), fs.realpathSync(candidate));
  for (const value of ['git', '', dir, path.join(dir, 'missing')])
    assert.throws(() => resolveGitExecutable({ env: { PAQVILO_GIT_EXECUTABLE: value } }), /PAQVILO_GIT_EXECUTABLE/);
});

test('default lookup ignores attacker-controlled PATH', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untrusted-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git');
  fs.writeFileSync(fake, 'not invoked', { mode: 0o755 });
  const childEnv = { ...process.env, PATH: dir };
  delete childEnv.PAQVILO_GIT_EXECUTABLE;
  const moduleUrl = new URL('../scripts/trusted-git.mjs', import.meta.url).href;
  const child = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {resolveGitExecutable} from ${JSON.stringify(moduleUrl)}; try { console.log(resolveGitExecutable()); } catch (error) { console.log(error.message); }`,
    ],
    { cwd: dir, env: childEnv, encoding: 'utf8' },
  ).trim();
  assert.notEqual(child, fs.realpathSync(fake));
  try {
    const result = resolveGitExecutable({ env: { PATH: dir } });
    assert.notEqual(result, fs.realpathSync(fake));
    assert.ok(path.isAbsolute(result));
  } catch (error) {
    assert.match(error.message, /trusted system location/);
  }
});

test('a non-executable override is rejected on POSIX systems', { skip: process.platform === 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonexecuting-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'git');
  fs.writeFileSync(file, 'not invoked', { mode: 0o600 });
  assert.throws(() => resolveGitExecutable({ env: { PAQVILO_GIT_EXECUTABLE: file } }), /executable regular file/);
});

test('POSIX automatic lookup rejects user-owned or writable ancestors while the explicit override remains allowed', (t) => {
  const fake = path.resolve(path.parse(process.cwd()).root, 'system', 'git');
  const parent = path.dirname(fake);
  let unsafe = null;
  t.mock.method(fs, 'realpathSync', () => fake);
  t.mock.method(fs, 'accessSync', () => {});
  t.mock.method(fs, 'statSync', (name) => ({
    isFile: () => name === fake,
    uid: (unsafe === 'owner' && name === parent) || (unsafe === 'file-owner' && name === fake) ? 1000 : 0,
    mode:
      (unsafe === 'permissions' && name === parent) || (unsafe === 'file-permissions' && name === fake) ? 0o777 : 0o755,
  }));
  assert.equal(resolveGitExecutable({ env: {}, platform: 'linux' }), fake);
  for (unsafe of ['owner', 'permissions', 'file-owner', 'file-permissions']) {
    assert.throws(() => resolveGitExecutable({ env: {}, platform: 'linux' }), /trusted system location/);
    assert.equal(resolveGitExecutable({ env: { PAQVILO_GIT_EXECUTABLE: fake }, platform: 'linux' }), fake);
  }
});
