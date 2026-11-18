// @test-kind contract: unknown commands and options are reported the same way by every command group (docs/cli.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MIRAGE_TOOLS, MIRAGE_TOOL_USAGE_EXIT } from '../mirage/tool-registry.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
import { tempDirSync } from './fixture.mjs';

const bin = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const cwd = tempDirSync('paqvilo-unknown-input-');
test.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const run = (args) =>
  withProcessSlot(
    () =>
      new Promise((resolve) =>
        execFile(
          process.execPath,
          [bin, ...args],
          { cwd, env, encoding: 'utf8', windowsHide: true },
          (error, stdout, stderr) =>
            resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr }),
        ),
      ),
  );

// Every command group with subcommands, and the word that names one of its valid subcommands in the message.
const UNKNOWN_COMMANDS = [
  [[], 'lense'],
  [['lense'], 'resources'],
  [['mirage'], 'serve'],
  [['dataverse'], 'plan'],
  [['lense', 'model-driven'], 'inspect'],
  [['lense', 'mirage'], 'stop'],
  [['mirage', 'data'], 'scaffold'],
  [['mirage', 'trace'], 'spans'],
  [['mirage', 'baseline-suite'], 'compare'],
];

test('an unknown command or subcommand is one stderr line naming it and the valid ones, exit 1', async () => {
  const results = await Promise.all(UNKNOWN_COMMANDS.map(([group]) => run([...group, 'invented-bogus'])));
  for (const [index, [group, valid]] of UNKNOWN_COMMANDS.entries()) {
    const { status, stdout, stderr } = results[index];
    const label = [...group, 'invented-bogus'].join(' ');
    assert.equal(status, 1, label);
    assert.equal(stdout, '', label);
    assert.equal(stderr.trimEnd().split('\n').length, 1, `${label}: ${stderr}`);
    assert.match(stderr, /invented-bogus/, label);
    assert.match(stderr, new RegExp(`\\b${valid}\\b`), label);
  }
});

test('lense agent, always JSON, names an unknown action and lists the valid ones', async () => {
  const { status, stdout } = await run(['lense', 'agent', 'invented-bogus']);
  assert.equal(status, 1);
  const { error } = JSON.parse(stdout);
  assert.match(error.message, /"invented-bogus".*sessions/);
});

test('an unknown top-level command with --json is the JSON code unknown_command', async () => {
  const { status, stdout } = await run(['invented-bogus', '--json']);
  assert.equal(status, 1);
  const { error } = JSON.parse(stdout);
  assert.equal(error.code, 'unknown_command');
  assert.match(error.message, /"invented-bogus".*lense/);
});

test('doctor --setup with a --config file that does not exist is the JSON code CONFIG_NOT_FOUND', async () => {
  const { status, stdout } = await run(['doctor', '--setup', '--config', 'invented-missing.yml', '--json']);
  assert.equal(status, 1);
  const { error } = JSON.parse(stdout);
  assert.equal(error.code, 'CONFIG_NOT_FOUND');
  assert.match(error.message, /invented-missing\.yml/);
});

// One command per group that takes --json; every one reports an unknown option as unsupported_option.
const JSON_COMMANDS = [
  ['init'],
  ['setup'],
  ['doctor', '--setup'],
  ['analyze'],
  ['dataverse', 'plan'],
  ['lense', 'list'],
  ['lense', 'model-driven', 'inspect'],
  ['mirage', 'status'],
  ['mirage', 'init'],
  ['mirage', 'serve'],
  ['mirage', 'preflight'],
  ['mirage', 'inspect'],
  ['mirage', 'data', 'generate'],
  ['mirage', 'capture-stylesheets'],
  ['mirage', 'trace', 'list'],
  ...Object.keys(MIRAGE_TOOLS)
    .filter(
      (name) =>
        ![
          'parity-suite',
          'baseline-suite',
          'acceptance',
          'enrich-reference',
          'reference-parity',
          'verify',
          'trace',
        ].includes(name),
    )
    .map((name) => ['mirage', name]),
];
const usageExit = (command) =>
  command[0] === 'mirage' ? (command[1] === 'preflight' ? 2 : (MIRAGE_TOOL_USAGE_EXIT[command[1]] ?? 1)) : 1;

test('every command reports an unknown option with the JSON code unsupported_option and its usage exit code', async () => {
  const results = await Promise.all(JSON_COMMANDS.map((command) => run([...command, '--invented-bogus', '--json'])));
  for (const [index, command] of JSON_COMMANDS.entries()) {
    const { status, stdout } = results[index];
    const label = command.join(' ');
    assert.equal(status, usageExit(command), `${label}: ${stdout}`);
    const document = JSON.parse(stdout);
    assert.equal((document.error ?? document.errors[0]).code, 'unsupported_option', label);
    assert.match((document.error ?? document.errors[0]).message, /--invented-bogus/, label);
  }
});

test('an unknown option beside --help fails exactly as without --help, in every command group', async () => {
  const commands = [
    ...JSON_COMMANDS,
    ['mirage', 'demo'],
    ['lense'],
    ['mirage'],
    ...['parity-suite', 'acceptance', 'verify'].map((name) => ['mirage', name]),
  ];
  const results = await Promise.all(
    commands.flatMap((command) => [
      run([...command, '--invented-bogus']),
      run([...command, '--invented-bogus', '--help']),
    ]),
  );
  for (const [index, command] of commands.entries()) {
    const [alone, withHelp] = results.slice(index * 2, index * 2 + 2);
    const label = command.join(' ');
    assert.notEqual(alone.status, 0, label);
    assert.equal(withHelp.status, alone.status, `${label} --help: ${withHelp.stderr}`);
    assert.equal(withHelp.stdout, '', label);
    assert.match(withHelp.stderr, /--invented-bogus/, label);
    assert.equal(withHelp.stderr.trimEnd().split('\n').length, 1, `${label}: ${withHelp.stderr}`);
  }
});
