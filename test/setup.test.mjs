import { makeTemporaryDirectorySync } from '../mirage/testing/owned-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dependencyReadiness, browserExecutable, prerequisiteReadiness } from '../scripts/ensure-dependencies.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function project(t) {
  const root = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { root, write };
}

test('npm layout resolves Mirage dependencies through the root without a second installation', (t) => {
  const { root: install, write: put } = project(t);
  const lock = {
    packages: { '': { dependencies: { library: '1.0.0' } }, 'node_modules/library': { version: '1.0.0' } },
  };
  put('package.json', { dependencies: { library: '1.0.0' } });
  put('npm-shrinkwrap.json', lock);
  put('mirage/package.json', { dependencies: { library: '1.0.0' } });
  put('mirage/package-lock.json', lock);
  put('node_modules/library/package.json', { version: '1.0.0', main: 'index.js' });
  fs.writeFileSync(path.join(install, 'node_modules/library/index.js'), 'module.exports = {};');
  assert.equal(dependencyReadiness(install).ready, true);
  put('node_modules/library/package.json', { version: '2.0.0', main: 'index.js' });
  const result = dependencyReadiness(install);
  assert.equal(result.ready, false);
  assert.match(
    result.projects.find((item) => item.name === 'mirage').reason,
    /library.*expected 1.0.0.*resolved 2.0.0/,
  );
});

test('bootstrap matches dependencies regardless of JSON property ordering', (t) => {
  const { root, write } = project(t);
  write('package.json', { dependencies: { a: '^1.0.0', b: '^2.0.0' } });
  write('package-lock.json', {
    packages: {
      '': { dependencies: { b: '^2.0.0', a: '^1.0.0' } },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '2.0.0' },
    },
  });
  write('node_modules/a/package.json', { version: '1.0.0' });
  write('node_modules/b/package.json', { version: '2.0.0' });
  assert.equal(dependencyReadiness(root).ready, true);
});

test('bootstrap accepts the distributable shrinkwrap and rejects stale lock copies', (t) => {
  const { root: state, write: writeJson } = project(t);
  const lock = { packages: { '': { dependencies: { a: '1.0.0' } }, 'node_modules/a': { version: '1.0.0' } } };
  writeJson('package.json', { dependencies: { a: '1.0.0' } });
  writeJson('package-lock.json', lock);
  writeJson('npm-shrinkwrap.json', lock);
  writeJson('node_modules/a/package.json', { version: '1.0.0' });
  fs.writeFileSync(path.join(state, 'node_modules/a/index.js'), 'module.exports = {};');
  assert.equal(dependencyReadiness(state).ready, true);
  fs.writeFileSync(
    path.join(state, 'package-lock.json'),
    JSON.stringify({ packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } }),
  );
  assert.equal(dependencyReadiness(state).canInstall, false);
  const packed = path.join(state, 'packed');
  fs.mkdirSync(packed);
  fs.writeFileSync(path.join(packed, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0' } }));
  fs.copyFileSync(path.join(state, 'npm-shrinkwrap.json'), path.join(packed, 'npm-shrinkwrap.json'));
  fs.cpSync(path.join(state, 'node_modules'), path.join(packed, 'node_modules'), { recursive: true });
  assert.equal(dependencyReadiness(packed).ready, true);
});

test('bootstrap accepts omitted optional fallback packages but rejects installed version drift', (t) => {
  const { root, write } = project(t);
  write('package.json', { dependencies: { required: '1.0.0' } });
  write('package-lock.json', {
    packages: {
      '': { dependencies: { required: '1.0.0' } },
      'node_modules/required': { version: '1.0.0' },
      'node_modules/optional-fallback': { version: '1.0.0', optional: true },
    },
  });
  write('node_modules/required/package.json', { version: '1.0.0' });
  assert.equal(dependencyReadiness(root).ready, true);
  write('node_modules/optional-fallback/package.json', { version: '2.0.0' });
  assert.equal(dependencyReadiness(root).ready, false);
});

test('bootstrap distinguishes repairable missing dependencies from manifest disagreement', (t) => {
  const { root, write } = project(t);
  write('package.json', { dependencies: { a: '^1.0.0', b: '^2.0.0' } });
  write('package-lock.json', {
    packages: {
      '': { dependencies: { a: '^1.0.0', b: '^2.0.0' } },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '2.0.0' },
    },
  });
  write('node_modules/a/package.json', { version: '0.9.0' });
  assert.deepEqual([dependencyReadiness(root).ready, dependencyReadiness(root).canInstall], [false, true]);
  write('package.json', { dependencies: { a: '^3.0.0', b: '^2.0.0' } });
  assert.equal(dependencyReadiness(root).canInstall, false);
});

test('bootstrap requires the Mirage lockfile and installed packages when bundled', (t) => {
  const { root: install, write: put } = project(t);
  put('package.json', { dependencies: { tool: '1.0.0' } });
  put('package-lock.json', {
    packages: { '': { dependencies: { tool: '1.0.0' } }, 'node_modules/tool': { version: '1.0.0' } },
  });
  put('node_modules/tool/package.json', { version: '1.0.0' });
  put('mirage/package.json', { dependencies: { simulator: '2.0.0' } });
  put('mirage/package-lock.json', {
    packages: { '': { dependencies: { simulator: '2.0.0' } }, 'node_modules/simulator': { version: '2.0.0' } },
  });
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

test('bootstrap reports corrupt manifests without a stack trace or installation attempt', (t) => {
  const { root, write } = project(t);
  write('package.json', '{broken');
  const result = dependencyReadiness(root);
  assert.equal(result.ready, false);
  assert.equal(result.canInstall, false);
  assert.match(result.reason, /cannot read dependency manifests/);
});

test('offline browser readiness checks only executable presence and distinguishes missing prerequisites', async () => {
  const calls = [];
  const found = await browserExecutable('chrome', {
    platform: 'linux',
    exists: (candidate) => {
      calls.push(candidate);
      return candidate === '/opt/google/chrome/chrome';
    },
  });
  assert.equal(found.path, '/opt/google/chrome/chrome');
  assert.equal(found.launchVerified, false);
  assert.equal(found.check, 'executable-presence');
  assert.deepEqual(calls, ['/opt/google/chrome/chrome']);
  const missing = await prerequisiteReadiness({
    nodeVersion: '20.1.0',
    probeGit: () => ({ status: 1 }),
    browser: 'chrome',
    locateBrowser: async () => ({ channel: 'chrome', path: null, launchVerified: false }),
  });
  assert.equal(missing.ready, false);
  assert.equal(missing.node.ready, false);
  assert.equal(missing.git.ready, false);
  assert.equal(missing.browser.ready, false);
  const ready = await prerequisiteReadiness({
    nodeVersion: '24.22.1',
    probeGit: () => ({ status: 0, stdout: 'git version test\n' }),
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.browser, null, 'a dependency readiness check does not claim browser launch readiness');
  await assert.rejects(() => browserExecutable('unsupported'), /--browser must be/);
});

test('bootstrap enforces the supported Node LTS line and security patch floor', async () => {
  for (const [nodeVersion, expected] of [
    ['22.23.4', false],
    ['24.22.0', false],
    ['24.22.1', true],
    ['24.23.0', true],
    ['25.0.0', false],
    ['26.12.1', false],
    ['24.22.1-rc.1', false],
    ['invalid', false],
  ]) {
    const result = await prerequisiteReadiness({
      nodeVersion,
      probeGit: () => ({ status: 0, stdout: 'git version test\n' }),
    });
    assert.equal(result.node.ready, expected, nodeVersion);
    assert.equal(result.node.minimumVersion, '24.22.1');
  }
});

test('setup JSON is offline only and reports readiness without installing', () => {
  const script = fileURLToPath(new URL('../scripts/ensure-dependencies.mjs', import.meta.url));
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 150_000 });
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
