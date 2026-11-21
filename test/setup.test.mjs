// @test-kind tooling: the setup script resolves Mirage dependencies through the root and matches bootstrap dependencies regardless of key order.
import { makeTemporaryDirectorySync } from '../mirage/testing/owned-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dependencyReadiness,
  browserExecutable,
  prerequisiteReadiness,
  withNpmInstallLock,
} from '../scripts/ensure-dependencies.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner

function project(t) {
  const root = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { root, write };
}

test('npm 12 repairs an installed package using its shipped lock snapshot and removes the temporary lock', (t) => {
  const { root, write } = project(t);
  const snapshot = { name: 'invented-package', lockfileVersion: 3, packages: { '': { version: '1.0.0' } } };
  write('paqvilo-lock.json', snapshot);
  const lock = path.join(root, 'package-lock.json');
  const result = withNpmInstallLock(root, () => {
    assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), snapshot);
    return { status: 0 };
  });
  assert.deepEqual(result, { status: 0 });
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'paqvilo-lock.json'), 'utf8')), snapshot);
  assert.throws(
    () =>
      withNpmInstallLock(root, () => {
        throw new Error('invented install failure');
      }),
    /invented install failure/,
  );
  assert.equal(fs.existsSync(lock), false, 'a failed installation also releases only its temporary lock');
});

test('dependency repair preserves an existing package lock and a lock changed during installation', (t) => {
  const { root, write } = project(t);
  write('paqvilo-lock.json', { snapshot: true });
  write('package-lock.json', { existing: true });
  const lock = path.join(root, 'package-lock.json');
  withNpmInstallLock(root, () => assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), { existing: true }));
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), { existing: true });
  fs.unlinkSync(lock);
  assert.throws(
    () => withNpmInstallLock(root, () => write('package-lock.json', { changed: true })),
    /has been preserved/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), { changed: true });
});

test('repair cleanup preserves a replacement lock even when its bytes match the snapshot', (t) => {
  const { root, write } = project(t);
  write('paqvilo-lock.json', { snapshot: true });
  const lock = path.join(root, 'package-lock.json');
  assert.throws(
    () =>
      withNpmInstallLock(root, () => {
        fs.renameSync(lock, path.join(root, 'previous-lock.json'));
        write('package-lock.json', { snapshot: true });
      }),
    /has been preserved/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), { snapshot: true });
});

// @test-kind security: controlled cleanup ordering proves dependency repair cannot delete a concurrently replaced lock.
test('repair cleanup leaves a lock created after its ownership check untouched', (t) => {
  const { root, write } = project(t);
  write('paqvilo-lock.json', { snapshot: true });
  const lock = path.join(root, 'package-lock.json');
  const readFile = fs.readFileSync;
  let armed = false;
  let replaced = false;
  fs.readFileSync = (file, ...options) => {
    const result = readFile(file, ...options);
    if (armed && (file === lock || typeof file === 'number')) {
      armed = false;
      if (fs.existsSync(lock)) fs.renameSync(lock, path.join(root, 'previous-lock.json'));
      write('package-lock.json', { concurrent: true });
      replaced = true;
    }
    return result;
  };
  try {
    assert.equal(
      withNpmInstallLock(root, () => {
        armed = true;
        return 'installed';
      }),
      'installed',
    );
  } finally {
    fs.readFileSync = readFile;
  }
  assert.equal(replaced, true, 'the replacement is created after the cleanup read');
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), { concurrent: true });
  assert.equal(
    fs.readdirSync(root).some((name) => name.startsWith('.paqvilo-install-lock-')),
    false,
  );
});

test('npm layout resolves Mirage dependencies through the root without a second installation', (t) => {
  const { root: install, write: put } = project(t);
  const lock = {
    packages: { '': { dependencies: { library: '1.0.0' } }, 'node_modules/library': { version: '1.0.0' } },
  };
  put('package.json', { dependencies: { library: '1.0.0' } });
  put('paqvilo-lock.json', lock);
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

test('bootstrap accepts the distributable dependency snapshot and rejects stale lock copies', (t) => {
  const { root: state, write: writeJson } = project(t);
  const lock = { packages: { '': { dependencies: { a: '1.0.0' } }, 'node_modules/a': { version: '1.0.0' } } };
  writeJson('package.json', { dependencies: { a: '1.0.0' } });
  writeJson('package-lock.json', lock);
  writeJson('paqvilo-lock.json', lock);
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
  fs.copyFileSync(path.join(state, 'paqvilo-lock.json'), path.join(packed, 'paqvilo-lock.json'));
  fs.cpSync(path.join(state, 'node_modules'), path.join(packed, 'node_modules'), { recursive: true });
  assert.equal(dependencyReadiness(packed).ready, true);
  fs.renameSync(path.join(packed, 'paqvilo-lock.json'), path.join(packed, 'npm-shrinkwrap.json'));
  assert.equal(dependencyReadiness(packed).ready, true, 'older installed packages retain their legacy lock fallback');
  withNpmInstallLock(packed, () => {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(packed, 'package-lock.json'), 'utf8')), lock);
  });
  assert.equal(fs.existsSync(path.join(packed, 'package-lock.json')), false);
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
    nodeVersion: '26.13.1',
    probeGit: () => ({ status: 0, stdout: 'git version test\n' }),
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.browser, null, 'a dependency readiness check does not claim browser launch readiness');
  await assert.rejects(() => browserExecutable('unsupported'), /--browser must be/);
});

test('bootstrap enforces the supported Node LTS line and security patch floor', async () => {
  for (const [nodeVersion, expected] of [
    ['22.23.4', false],
    ['26.13.0', false],
    ['26.13.1', true],
    ['26.14.0', true],
    ['25.0.0', false],
    ['24.22.3', false],
    ['26.13.1-rc.1', false],
    ['invalid', false],
  ]) {
    const result = await prerequisiteReadiness({
      nodeVersion,
      probeGit: () => ({ status: 0, stdout: 'git version test\n' }),
    });
    assert.equal(result.node.ready, expected, nodeVersion);
    assert.equal(result.node.minimumVersion, '26.13.1');
  }
});

test('setup JSON is offline only and reports readiness without installing', () => {
  const script = fileURLToPath(new URL('../scripts/ensure-dependencies.mjs', import.meta.url));
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: CLI_HANG_GUARD_MS });
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
