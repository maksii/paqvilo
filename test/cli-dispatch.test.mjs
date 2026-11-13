// @test-kind contract: public CLI help and dispatch preserve observable output and owned local state
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MIRAGE_COMMANDS, MIRAGE_TOOLS } from '../mirage/tool-registry.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { forwardTerminationSignals } from '../lense/signal-forwarding.mjs';
import { tempDirSync } from './fixture.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PAQVILO_|GIT_)/i.test(key)));
// Each test runs a bounded number of CLI processes, so the per-test limit never covers a whole command list. A child
// is ended by the test's own signal when the runner stops the test, never by a timer of its own.
const run = (t, args, options = {}) =>
  withProcessSlot(
    () =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [cli, ...args],
          { env, encoding: 'utf8', windowsHide: true, signal: t.signal, ...options },
          (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
        );
      }),
  );

const rootFlagCases = [
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
for (const args of rootFlagCases)
  test(`root flags reject trailing arguments and diagnostics use the requested stream: ${JSON.stringify(args)}`, async (t) => {
    const result = await run(t, args);
    assert.equal(result.status, 1, JSON.stringify(args));
    if (args.includes('--json')) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      assert.equal(typeof report.error.code, 'string');
      assert.equal(result.stderr, '');
      if (args.includes('absent.yml')) assert.match(report.error.message, /--browser must be/);
    } else {
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /\n\s+at /);
    }
  });

const publicCommands = [
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
for (const args of publicCommands)
  test(`public command help succeeds and leaves the owned working directory unchanged: paqvilo ${args.join(' ')}`, async (t) => {
    const cwd = tempDirSync('paqvilo-help-contract-');
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const result = await run(t, args, { cwd });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(result.stdout.trim(), args.join(' '));
    assert.equal(result.stderr, '', args.join(' '));
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

for (const name of Object.keys(MIRAGE_TOOLS))
  test(`public Mirage tool help rejects malformed requests without running the tool: ${name}`, async (t) => {
    const result = await run(t, ['mirage', name, '--help', '--unknown', '--json']);
    assert.equal(result.status, 1, name);
    assert.equal(JSON.parse(result.stdout).ok, false, name);
    assert.equal(result.stderr, '', name);
  });

test('public Mirage tool help rejects a positional argument without running the tool', async (t) => {
  const positional = await run(t, ['mirage', 'liquid-conformance', '--help', 'unexpected']);
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
  const results = await Promise.all(cases.map((args) => run(t, args, { cwd })));
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
          { cwd, env, encoding: 'utf8', windowsHide: true, signal: t.signal },
          (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
        );
      }),
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).directory, target);
  assert.ok(fs.existsSync(path.join(target, 'paqvilo.config.yml')));
});

test('terminal interrupts stay with the child on Windows and on POSIX SIGINT, while POSIX forwards SIGTERM', () => {
  const signals = [];
  const child = { kill: (signal) => signals.push(signal) };

  const windowsSource = new EventEmitter();
  const stopWindows = forwardTerminationSignals(child, { platform: 'win32', source: windowsSource });
  assert.equal(windowsSource.listenerCount('SIGINT'), 1);
  windowsSource.emit('SIGINT');
  assert.deepEqual(signals, []);
  stopWindows();
  assert.equal(windowsSource.listenerCount('SIGINT'), 0);
  assert.equal(windowsSource.listenerCount('SIGBREAK'), 0);

  const posixSource = new EventEmitter();
  const stopPosix = forwardTerminationSignals(child, { platform: 'linux', source: posixSource });
  assert.equal(posixSource.listenerCount('SIGINT'), 1);
  posixSource.emit('SIGINT');
  assert.deepEqual(signals, []);
  posixSource.emit('SIGTERM');
  assert.deepEqual(signals, ['SIGTERM']);
  stopPosix();
  assert.equal(posixSource.listenerCount('SIGINT'), 0);
  assert.equal(posixSource.listenerCount('SIGTERM'), 0);
});
