import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dependencyReadiness, browserExecutable, prerequisiteReadiness } from '../scripts/ensure-dependencies.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-setup-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), JSON.stringify(value)); };

test('bootstrap matches dependencies regardless of JSON property ordering', () => {
  write('package.json', { dependencies: { a: '^1.0.0', b: '^2.0.0' } });
  write('package-lock.json', { packages: { '': { dependencies: { b: '^2.0.0', a: '^1.0.0' } }, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' } } });
  write('node_modules/a/package.json', { version: '1.0.0' });
  write('node_modules/b/package.json', { version: '2.0.0' });
  assert.equal(dependencyReadiness(root).ready, true);
});

test('bootstrap accepts the distributable shrinkwrap and rejects stale lock copies', (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-shrinkwrap-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const writeJson = (relative, value) => {
    const file = path.join(state, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const lock = { packages: { '': { dependencies: { a: '1.0.0' } }, 'node_modules/a': { version: '1.0.0' } } };
  writeJson('package.json', { dependencies: { a: '1.0.0' } });
  writeJson('package-lock.json', lock);
  writeJson('npm-shrinkwrap.json', lock);
  writeJson('node_modules/a/package.json', { version: '1.0.0' });
  assert.equal(dependencyReadiness(state).ready, true);
  fs.writeFileSync(path.join(state, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } }));
  assert.equal(dependencyReadiness(state).canInstall, false);
  const packed = path.join(state, 'packed');
  fs.mkdirSync(packed);
  fs.writeFileSync(path.join(packed, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0' } }));
  fs.copyFileSync(path.join(state, 'npm-shrinkwrap.json'), path.join(packed, 'npm-shrinkwrap.json'));
  fs.cpSync(path.join(state, 'node_modules'), path.join(packed, 'node_modules'), { recursive: true });
  assert.equal(dependencyReadiness(packed).ready, true);
});

test('bootstrap distinguishes repairable missing dependencies from manifest disagreement', () => {
  write('node_modules/a/package.json', { version: '0.9.0' });
  assert.equal(dependencyReadiness(root).ready, false);
  assert.equal(dependencyReadiness(root).canInstall, true);
  write('package.json', { dependencies: { a: '^3.0.0', b: '^2.0.0' } });
  assert.equal(dependencyReadiness(root).canInstall, false);
});

test('bootstrap requires the Mirage lockfile and installed packages when bundled', () => {
  const install = path.join(root, 'project-with-mirage');
  fs.mkdirSync(install, { recursive: true });
  const put = (relative, value) => {
    const file = path.join(install, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  put('package.json', { dependencies: { tool: '1.0.0' } });
  put('package-lock.json', { packages: { '': { dependencies: { tool: '1.0.0' } }, 'node_modules/tool': { version: '1.0.0' } } });
  put('node_modules/tool/package.json', { version: '1.0.0' });
  put('mirage/package.json', { dependencies: { simulator: '2.0.0' } });
  put('mirage/package-lock.json', { packages: { '': { dependencies: { simulator: '2.0.0' } }, 'node_modules/simulator': { version: '2.0.0' } } });
  let report = dependencyReadiness(install);
  assert.equal(report.ready, false);
  assert.equal(report.canInstall, true);
  assert.equal(report.projects.length, 2);
  put('mirage/node_modules/simulator/package.json', { version: '2.0.0' });
  report = dependencyReadiness(install);
  assert.equal(report.ready, true);
  fs.writeFileSync(path.join(install, 'mirage/package-lock.json'), '{broken');
  report = dependencyReadiness(install);
  assert.equal(report.canInstall, false);
  assert.match(report.reason, /cannot read dependency manifests/);
});

test('bootstrap reports corrupt manifests without a stack trace or installation attempt', () => {
  fs.writeFileSync(path.join(root, 'package.json'), '{broken');
  const result = dependencyReadiness(root);
  assert.equal(result.ready, false);
  assert.equal(result.canInstall, false);
  assert.match(result.reason, /cannot read dependency manifests/);
});

test('offline browser readiness checks only executable presence and distinguishes missing prerequisites', async () => {
  const calls = [];
  const found = await browserExecutable('chrome', { platform: 'linux', exists: (candidate) => { calls.push(candidate); return candidate === '/opt/google/chrome/chrome'; } });
  assert.equal(found.path, '/opt/google/chrome/chrome');
  assert.equal(found.launchVerified, false);
  assert.equal(found.check, 'executable-presence');
  assert.deepEqual(calls, ['/opt/google/chrome/chrome']);
  const missing = await prerequisiteReadiness({ nodeVersion: '20.1.0', probeGit: () => ({ status: 1 }), browser: 'chrome', locateBrowser: async () => ({ channel: 'chrome', path: null, launchVerified: false }) });
  assert.equal(missing.ready, false);
  assert.equal(missing.node.ready, false);
  assert.equal(missing.git.ready, false);
  assert.equal(missing.browser.ready, false);
  const ready = await prerequisiteReadiness({ nodeVersion: '22.0.0', probeGit: () => ({ status: 0, stdout: 'git version test\n' }) });
  assert.equal(ready.ready, true);
  assert.equal(ready.browser, null, 'a dependency readiness check does not claim browser launch readiness');
  await assert.rejects(() => browserExecutable('unsupported'), /--browser must be/);
});

test('setup JSON is offline only and reports readiness without installing', () => {
  const script = fileURLToPath(new URL('../scripts/ensure-dependencies.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const report = run('--check', '--json');
  assert.equal(report.status, 0, report.stderr);
  const value = JSON.parse(report.stdout);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.offline, true);
  assert.equal(value.prerequisites.node.ready, true);
  assert.equal(value.prerequisites.git.ready, true);
  assert.equal(value.prerequisites.browser, null);
  const invalid = run('--json');
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stdout).error, /requires --check/);
});
