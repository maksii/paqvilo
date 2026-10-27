import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MIRAGE_COMMANDS, MIRAGE_TOOLS } from '../mirage/tool-registry.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { tempDirSync } from './fixture.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PAQVILO_|GIT_)/i.test(key)));
const run = (args, options = {}) =>
  withProcessSlot(
    () =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [cli, ...args],
          { env, encoding: 'utf8', windowsHide: true, timeout: 30000, ...options },
          (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
        );
      }),
  );

test('root flags reject trailing arguments and diagnostics use the requested stream', async () => {
  const cases = [
    ['--version', 'unexpected'],
    ['--help', '--bogus'],
    ['--version', '--json'],
    ['doctor', '--json'],
    ['doctor', '--setup', '--browser', '', '--json'],
    ['doctor', '--setup', '--config', 'absent.yml', '--browser', 'unknown', '--json'],
    ['unknown\nкоманда', '--json'],
    ['--json'],
    ['', '--json'],
    ['lense', '', '--json'],
    ['dataverse', '', '--json'],
    ['doctor', '--help', '--bogus', '--json'],
    ['mirage', '--help', '--bogus', '--json'],
    ['mirage', 'help', '--bogus', '--json'],
    ['mirage', '--help', '--bogus'],
  ];
  const results = await Promise.all(cases.map((args) => run(args)));
  for (const [index, args] of cases.entries()) {
    const result = results[index];
    assert.equal(result.status, 1, JSON.stringify(args));
    if (args.includes('--json')) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      assert.equal(typeof report.error.code, 'string');
      assert.equal(result.stderr, '');
    } else {
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /\n\s+at /);
    }
  }
  assert.match(JSON.parse(results[5].stdout).error.message, /--browser must be/);
});

test('all public command help is successful without configuration or local state', async (t) => {
  const cwd = tempDirSync('paqvilo-help-contract-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const commands = [
    [],
    ['lense'],
    ['mirage'],
    ['dataverse'],
    ...['init', 'setup', 'doctor'].map((name) => [name, '--help']),
    ...['dev', 'list', 'use', 'doctor', 'map', 'status', 'audit', 'resources', 'verify', 'agent', 'model-driven'].map(
      (name) => ['lense', name, '--help'],
    ),
    ...MIRAGE_COMMANDS.map((name) => ['mirage', name, '--help']),
  ];
  const results = await Promise.all(commands.map((args) => run(args, { cwd })));
  for (const [index, args] of commands.entries()) {
    assert.equal(results[index].status, 0, `${args.join(' ')}: ${results[index].stderr}`);
    assert.ok(results[index].stdout.trim(), args.join(' '));
    assert.equal(results[index].stderr, '', args.join(' '));
  }
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('public Mirage tool help rejects malformed requests without running the tool', async () => {
  const commands = Object.keys(MIRAGE_TOOLS);
  const results = await Promise.all(commands.map((name) => run(['mirage', name, '--help', '--unknown', '--json'])));
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 1, commands[index]);
    assert.equal(JSON.parse(result.stdout).ok, false, commands[index]);
    assert.equal(result.stderr, '', commands[index]);
  }
  const positional = await run(['mirage', 'liquid-conformance', '--help', 'unexpected']);
  assert.equal(positional.status, 1);
  assert.equal(positional.stdout, '');
  assert.match(positional.stderr, /Unexpected argument/);
});

test('option terminators keep literal help and JSON values out of dispatcher control flow', async (t) => {
  const cwd = tempDirSync('paqvilo-terminator-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const cases = [
    ['mirage', 'query-inventory', '--', '--help'],
    ['doctor', '--', '--help'],
    ['init', '--', '--json', 'extra'],
    ['lense', 'invented', '--help', '--json'],
    ['mirage', 'inspekt', '--help'],
  ];
  const results = await Promise.all(cases.map((args) => run(args, { cwd })));
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 1, `${cases[index].join(' ')}: ${result.stdout} ${result.stderr}`);
    if (index === 3) assert.equal(JSON.parse(result.stdout).error.code, 'unknown_command');
    else {
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.trim());
    }
  }
  assert.ok(!fs.existsSync(path.join(cwd, '--json')));
});

test('shell quoting preserves spaced Cyrillic and metacharacter paths', async (t) => {
  const cwd = tempDirSync('paqvilo-shell-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = path.join(cwd, 'OneDrive - Example', "Проєкт [1] & O'Brien # $;!");
  const quote =
    process.platform === 'win32'
      ? (value) => `'${value.replaceAll("'", "''")}'`
      : (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const command = [process.execPath, cli, 'init', target, '--name', 'shell-example', '--json'].map(quote).join(' ');
  const program = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const args =
    process.platform === 'win32'
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(
            `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & ${command}; exit $LASTEXITCODE`,
            'utf16le',
          ).toString('base64'),
        ]
      : ['-c', command];
  const result = await withProcessSlot(
    () =>
      new Promise((resolve) => {
        execFile(
          program,
          args,
          { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 },
          (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
        );
      }),
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).directory, target);
  assert.ok(fs.existsSync(path.join(target, 'paqvilo.config.yml')));
});
