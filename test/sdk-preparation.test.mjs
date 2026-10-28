import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { prepareSdkFixtures, requireSdkFixtures, requireSdkSample } from '../scripts/sdk-preparation.mjs';

const pin = '8e42f87026f4c93d7e468f28416f5852375d325a';
const hashed = `msal==1.39.0 --hash=sha256:${'a'.repeat(64)}\n`;
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-sdk-preparation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pythonSource = path.join(root, 'mirage/test-sdk/python-dataverse');
  const sampleSource = path.join(root, 'mirage/test-sdk/webapi-samples');
  fs.mkdirSync(pythonSource, { recursive: true });
  fs.mkdirSync(sampleSource, { recursive: true });
  fs.writeFileSync(path.join(pythonSource, 'requirements.txt'), 'msal==1.39.0\n');
  fs.writeFileSync(path.join(pythonSource, 'requirements.lock.txt'), hashed);
  fs.writeFileSync(path.join(sampleSource, 'PINNED_COMMIT.txt'), `Commit: ${pin}\n`);
  const directory = path.join(root, '.paqvilo/sdk-gates');
  const pythonDirectory = path.join(directory, 'python-dataverse');
  const sample = path.join(directory, 'PowerApps-Samples');
  const python = path.join(
    pythonDirectory,
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const receipt = path.join(pythonDirectory, 'receipt.json');
  const ready = () => {
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, 'invented interpreter fixture');
    fs.mkdirSync(path.join(sample, '.git'), { recursive: true });
    fs.mkdirSync(path.join(sample, 'dataverse/webapi/CSharp-NETx/WebAPIService'), { recursive: true });
    fs.writeFileSync(
      path.join(sample, 'dataverse/webapi/CSharp-NETx/WebAPIService/WebAPIService.csproj'),
      'invented project',
    );
    fs.writeFileSync(
      receipt,
      JSON.stringify({
        lock: sha(path.join(pythonSource, 'requirements.lock.txt')),
        direct: sha(path.join(pythonSource, 'requirements.txt')),
      }),
    );
  };
  return { root, pythonSource, sample, python, receipt, ready };
}

function probes(t, fixture, { head = pin, dirty = '', pythonFailure = false } = {}) {
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    if (command === 'git') {
      const output = args.includes('--show-toplevel') ? fixture.sample : args.includes('HEAD') ? head : dirty;
      return { status: 0, stdout: output, stderr: '' };
    }
    if (args.includes('-c') && pythonFailure)
      return { status: 1, stdout: '', stderr: 'Modified installed wheel file: msal/application.py' };
    return {
      status: 0,
      stdout: args.includes('-c')
        ? JSON.stringify({ implementation: 'CPython', version: '3.13.6', packages: { msal: '1.39.0' } })
        : '',
      stderr: '',
    };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('required SDK preparation rejects missing and stale receipts before executing a client', (t) => {
  const files = fixture(t);
  assert.throws(() => requireSdkFixtures(files.root), /receipt missing/);
  files.ready();
  fs.appendFileSync(path.join(files.pythonSource, 'requirements.lock.txt'), '# changed lock\n');
  assert.throws(() => requireSdkFixtures(files.root), /receipt is stale/);
});

test('SDK preparation refuses unhashed pins and direct requirement drift before downloads', async (t) => {
  const files = fixture(t);
  const execute = () => assert.fail('invalid locks must fail before execution');
  fs.writeFileSync(path.join(files.pythonSource, 'requirements.lock.txt'), 'msal==1.39.0\n');
  await assert.rejects(prepareSdkFixtures({ root: files.root, execute }), /exact pins with SHA256/);
  fs.writeFileSync(path.join(files.pythonSource, 'requirements.lock.txt'), hashed);
  fs.writeFileSync(path.join(files.pythonSource, 'requirements.txt'), 'msal==1.38.0\n');
  await assert.rejects(prepareSdkFixtures({ root: files.root, execute }), /disagree/);
});

test('required SDK preparation verifies installed wheel contents and the pinned clean sample', async (t) => {
  for (const [options, failure] of [
    [{}, null],
    [{ head: '0'.repeat(40) }, /HEAD/],
    [{ dirty: ' M WebAPIService.cs' }, /clean source/],
    [{ pythonFailure: true }, /Modified installed wheel file/],
  ]) {
    await t.test(JSON.stringify(options), (t) => {
      const files = fixture(t);
      files.ready();
      probes(t, files, options);
      if (failure) assert.throws(() => requireSdkFixtures(files.root), failure);
      else assert.doesNotThrow(() => requireSdkFixtures(files.root));
    });
  }
});

test('preparation uses hashed wheels, suppresses pip configuration and restores the locked sample gate', async (t) => {
  const files = fixture(t);
  files.ready();
  probes(t, files);
  const calls = [];
  await prepareSdkFixtures({
    root: files.root,
    execute: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  const install = calls.find((call) => call.args.includes('install'));
  assert.ok(install.args.includes('--require-hashes'));
  assert.ok(install.args.includes('--only-binary=:all:'));
  assert.deepEqual(install.args.slice(install.args.indexOf('--index-url'), -2), [
    '--index-url',
    'https://pypi.org/simple',
  ]);
  assert.equal(install.options.env.PIP_CONFIG_FILE, os.devNull);
  assert.deepEqual(
    Object.keys(install.options.env).filter((name) => /^PIP_/i.test(name)),
    ['PIP_CONFIG_FILE'],
  );
  assert.ok(calls.some((call) => call.command === 'dotnet' && call.args.includes('--locked-mode')));
  assert.ok(calls.some((call) => call.args.includes('check')));
});

test('a failed wheel install stops preparation without publishing a success receipt', async (t) => {
  const files = fixture(t);
  files.ready();
  probes(t, files);
  fs.rmSync(files.receipt);
  const calls = [];
  await assert.rejects(
    prepareSdkFixtures({
      root: files.root,
      execute: (command, args) => {
        calls.push(args);
        return { status: 1 };
      },
    }),
    /SDK preparation failed/,
  );
  assert.equal(fs.existsSync(files.receipt), false);
  assert.equal(calls.length, 1);
});

test('signalled preparation commands cannot publish a success receipt', async (t) => {
  const files = fixture(t);
  files.ready();
  probes(t, files);
  fs.rmSync(files.receipt);
  await assert.rejects(
    prepareSdkFixtures({ root: files.root, execute: () => ({ status: null, signal: 'SIGTERM' }) }),
    /SDK preparation failed/,
  );
  assert.equal(fs.existsSync(files.receipt), false);
});

test('fresh sample preparation fetches only the pinned public source with isolated Git settings', async (t) => {
  const files = fixture(t);
  files.ready();
  fs.rmSync(files.sample, { recursive: true });
  probes(t, files);
  const calls = [];
  await prepareSdkFixtures({
    root: files.root,
    execute: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'git' && args.includes('init')) files.ready();
      return { status: 0 };
    },
  });
  const git = calls.filter((call) => call.command === 'git');
  assert.equal(git.length, 6);
  for (const call of git) {
    assert.ok(call.args.some((argument) => argument.startsWith('core.hooksPath=')));
    assert.equal(call.options.env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : os.devNull);
    assert.equal(call.options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0');
  }
  assert.deepEqual(git.find((call) => call.args.includes('fetch')).args.slice(-6), [
    'fetch',
    '--depth=1',
    '--filter=blob:none',
    '--no-recurse-submodules',
    'origin',
    pin,
  ]);
  assert.ok(git.some((call) => call.args.includes('https://github.com/microsoft/PowerApps-Samples.git')));
  assert.deepEqual(git.at(-1).args.slice(-3), ['checkout', '--detach', pin]);
});

test('real Git fixture checks ignore inherited repository and index redirection', (t) => {
  const files = fixture(t);
  files.ready();
  const originalSpawn = childProcess.spawnSync;
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (args) => {
    const result = originalSpawn(
      'git',
      ['-c', `core.hooksPath=${path.join(files.root, 'empty-hooks')}`, '-C', files.sample, ...args],
      {
        encoding: 'utf8',
        env,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Invented SDK test',
    '-c',
    'user.email=sdk@example.invalid',
    'commit',
    '--no-gpg-sign',
    '-m',
    'Invented fixture',
  ]);
  const head = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(files.root, 'mirage/test-sdk/webapi-samples/PINNED_COMMIT.txt'), `Commit: ${head}\n`);
  const index = path.join(files.root, 'unrelated-index');
  fs.writeFileSync(index, 'preserve this unrelated index');
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT'];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  });
  process.env.GIT_DIR = path.join(files.root, 'missing-other-repository');
  process.env.GIT_WORK_TREE = files.root;
  process.env.GIT_INDEX_FILE = index;
  process.env.GIT_CONFIG_COUNT = '99';
  assert.notEqual(
    originalSpawn('git', ['-C', files.sample, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).status,
    0,
    'the former raw gate probe is redirected by the inherited environment',
  );
  t.mock.method(childProcess, 'spawnSync', (command, args, options) =>
    command === 'git'
      ? originalSpawn(command, args, options)
      : { status: 0, stdout: args.includes('-c') ? '{}' : '', stderr: '' },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.doesNotThrow(() => requireSdkFixtures(files.root));
  fs.rmSync(files.python);
  fs.rmSync(files.receipt);
  assert.doesNotThrow(() => requireSdkSample(files.root), 'the sample-only gate does not require a Python fixture');
  assert.equal(fs.readFileSync(index, 'utf8'), 'preserve this unrelated index');
});

test('SDK preparation rejects linked fixture storage instead of writing outside the checkout', (t) => {
  const files = fixture(t);
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-sdk-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(files.root, '.paqvilo'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => requireSdkFixtures(files.root), /must not be a link/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a failed locked restore revokes the previous preparation receipt', async (t) => {
  const files = fixture(t);
  files.ready();
  probes(t, files);
  await assert.rejects(
    prepareSdkFixtures({ root: files.root, execute: (command) => ({ status: command === 'dotnet' ? 1 : 0 }) }),
    /SDK preparation failed/,
  );
  assert.equal(fs.existsSync(files.receipt), false);
  assert.throws(() => requireSdkFixtures(files.root), /receipt missing/);
});

test('preparation recreates an invalid warm venv within its owned folder', async (t) => {
  const files = fixture(t);
  files.ready();
  const marker = path.join(path.dirname(path.dirname(files.python)), 'stale-package');
  fs.writeFileSync(marker, 'stale interpreter or package');
  let firstInventory = true;
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    if (command === 'git')
      return {
        status: 0,
        stdout: args.includes('--show-toplevel') ? files.sample : args.includes('HEAD') ? pin : '',
        stderr: '',
      };
    if (command === files.python && args.includes('-c') && firstInventory) {
      firstInventory = false;
      return { status: 1, stdout: '', stderr: 'Missing/stale distribution' };
    }
    return { status: 0, stdout: args.includes('-c') ? '{}' : '', stderr: '' };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const calls = [];
  await prepareSdkFixtures({
    root: files.root,
    execute: (command, args) => {
      calls.push(args);
      if (args.includes('venv')) {
        fs.mkdirSync(path.dirname(files.python), { recursive: true });
        fs.writeFileSync(files.python, 'replacement interpreter');
      }
      return { status: 0 };
    },
  });
  assert.equal(fs.existsSync(marker), false);
  assert.ok(calls.some((args) => args.includes('venv')));
  assert.equal(fs.existsSync(files.receipt), true);
});

test('preparation resumes a clean sample after an interrupted fetch', async (t) => {
  const files = fixture(t);
  files.ready();
  probes(t, files);
  const project = path.join(files.sample, 'dataverse/webapi/CSharp-NETx/WebAPIService/WebAPIService.csproj');
  fs.rmSync(project);
  let fail = true;
  let fetches = 0;
  const execute = (command, args) => {
    if (args.includes('fetch')) {
      fetches++;
      if (fail) return { status: 1 };
    }
    if (args.includes('checkout')) fs.writeFileSync(project, 'resumed pinned source');
    return { status: 0 };
  };
  await assert.rejects(prepareSdkFixtures({ root: files.root, execute }), /SDK preparation failed/);
  assert.equal(fs.existsSync(files.receipt), false);
  fail = false;
  await prepareSdkFixtures({ root: files.root, execute });
  assert.equal(fetches, 2);
  assert.equal(fs.existsSync(files.receipt), true);
});
