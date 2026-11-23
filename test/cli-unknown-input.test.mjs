// @test-kind contract: unknown commands and options are reported the same way by every command group (docs/cli.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIRAGE_TOOLS, MIRAGE_TOOL_USAGE_EXIT } from '../mirage/tool-registry.mjs';
import { boundedCommand, COMMAND_HANG_GUARD_MS } from './helpers/bounded-command.mjs';
import { operationBudget } from './helpers/operation-budget.mjs';
import { tempDirSync } from './fixture.mjs';

const bin = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const cwd = tempDirSync('paqvilo-unknown-input-');
// Every command run in the working folder, until it has closed. A test that was cut leaves its commands to its owner,
// which ends them; Windows refuses (EPERM) to remove a folder that a running process has as its working folder, so the
// folder is removed once every command has closed.
const commands = new Set();
test.after(async () => {
  await Promise.allSettled(commands);
  fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
// Every command has its own hang guard, counted from the moment it holds a process slot. A test that runs a batch
// declares the batch's finite budget: on a small loaded host the commands run one at a time, each slow but none hung,
// and the lane's 180 s hang guard would otherwise cut the queue.
const run = (t, args) => {
  const command = boundedCommand(t, process.execPath, [bin, ...args], { cwd, env });
  commands.add(command);
  return command;
};
const commandBatch = (commands) => ({ timeout: operationBudget(commands, COMMAND_HANG_GUARD_MS) });

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

test(
  'an unknown command or subcommand is one stderr line naming it and the valid ones, exit 1',
  commandBatch(UNKNOWN_COMMANDS.length),
  async (t) => {
    const results = await Promise.all(UNKNOWN_COMMANDS.map(([group]) => run(t, [...group, 'invented-bogus'])));
    for (const [index, [group, valid]] of UNKNOWN_COMMANDS.entries()) {
      const { status, stdout, stderr } = results[index];
      const label = [...group, 'invented-bogus'].join(' ');
      assert.equal(status, 1, label);
      assert.equal(stdout, '', label);
      assert.equal(stderr.trimEnd().split('\n').length, 1, `${label}: ${stderr}`);
      assert.match(stderr, /invented-bogus/, label);
      assert.match(stderr, new RegExp(`\\b${valid}\\b`), label);
    }
  },
);

test('lense agent, always JSON, names an unknown action and lists the valid ones', async (t) => {
  const { status, stdout } = await run(t, ['lense', 'agent', 'invented-bogus']);
  assert.equal(status, 1);
  const { error } = JSON.parse(stdout);
  assert.match(error.message, /"invented-bogus".*sessions/);
});

test('an unknown top-level command with --json is the JSON code unknown_command', async (t) => {
  const { status, stdout } = await run(t, ['invented-bogus', '--json']);
  assert.equal(status, 1);
  const { error } = JSON.parse(stdout);
  assert.equal(error.code, 'unknown_command');
  assert.match(error.message, /"invented-bogus".*lense/);
});

test('doctor --setup with a --config file that does not exist is the JSON code CONFIG_NOT_FOUND', async (t) => {
  const { status, stdout } = await run(t, ['doctor', '--setup', '--config', 'invented-missing.yml', '--json']);
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

test(
  'every command reports an unknown option with the JSON code unsupported_option and its usage exit code',
  commandBatch(JSON_COMMANDS.length),
  async (t) => {
    const results = await Promise.all(
      JSON_COMMANDS.map((command) => run(t, [...command, '--invented-bogus', '--json'])),
    );
    for (const [index, command] of JSON_COMMANDS.entries()) {
      const { status, stdout } = results[index];
      const label = command.join(' ');
      assert.equal(status, usageExit(command), `${label}: ${stdout}`);
      const document = JSON.parse(stdout);
      assert.equal((document.error ?? document.errors[0]).code, 'unsupported_option', label);
      assert.match((document.error ?? document.errors[0]).message, /--invented-bogus/, label);
    }
  },
);

// Every command group, run once without --help and once with it.
const HELP_COMMANDS = [
  ...JSON_COMMANDS,
  ['mirage', 'demo'],
  ['lense'],
  ['mirage'],
  ...['parity-suite', 'acceptance', 'verify'].map((name) => ['mirage', name]),
];

test(
  'an unknown option beside --help fails exactly as without --help, in every command group',
  commandBatch(HELP_COMMANDS.length * 2),
  async (t) => {
    const results = await Promise.all(
      HELP_COMMANDS.flatMap((command) => [
        run(t, [...command, '--invented-bogus']),
        run(t, [...command, '--invented-bogus', '--help']),
      ]),
    );
    for (const [index, command] of HELP_COMMANDS.entries()) {
      const [alone, withHelp] = results.slice(index * 2, index * 2 + 2);
      const label = command.join(' ');
      assert.notEqual(alone.status, 0, label);
      assert.equal(withHelp.status, alone.status, `${label} --help: ${withHelp.stderr}`);
      assert.equal(withHelp.stdout, '', label);
      assert.match(withHelp.stderr, /--invented-bogus/, label);
      assert.equal(withHelp.stderr.trimEnd().split('\n').length, 1, `${label}: ${withHelp.stderr}`);
    }
  },
);

// An option of another command or action, each beside --help and without it: the refusal, its JSON and its exit code are
// the same either way (docs/cli.md, argument errors); an option the action takes still shows its help.
const OTHER_ACTION_OPTIONS = [
  [['mirage', 'status', '--port', '1'], '--port is not supported by mirage status'],
  [['mirage', 'stop', '--headed'], '--headed is not supported by mirage stop'],
  [['lense', 'list', '--limit', '5'], '--limit is not supported by list'],
  [['lense', 'status', '--limit', '5'], '--limit is not supported by status'],
  [['lense', 'model-driven', 'inspect', '--headed'], '--headed is not supported by model-driven inspect'],
  [['lense', 'agent', 'events', '--width', '5'], '--width is not supported by agent events'],
];

test(
  'an option of another action beside --help fails exactly as without --help',
  commandBatch(OTHER_ACTION_OPTIONS.length * 3 + 3),
  async (t) => {
    const results = await Promise.all(
      OTHER_ACTION_OPTIONS.flatMap(([args]) => [
        run(t, args),
        run(t, [...args, '--help']),
        run(t, [...args, '--help', '--json']),
      ]),
    );
    for (const [index, [args, message]] of OTHER_ACTION_OPTIONS.entries()) {
      const [alone, withHelp, json] = results.slice(index * 3, index * 3 + 3);
      const label = args.join(' ');
      const agent = args[1] === 'agent';
      assert.equal(alone.status, 1, `${label}: ${alone.stderr}${alone.stdout}`);
      assert.equal(withHelp.status, 1, `${label} --help: ${withHelp.stdout}`);
      assert.equal(json.status, 1, `${label} --help --json`);
      if (agent) assert.equal(withHelp.stdout, alone.stdout, label);
      else {
        assert.equal(withHelp.stderr, alone.stderr, label);
        assert.equal(withHelp.stderr.trimEnd(), `paqvilo: ${message}`, label);
        assert.equal(withHelp.stdout, '', label);
      }
      const document = JSON.parse(json.stdout);
      assert.deepEqual(document.error, { code: 'unsupported_option', message }, label);
    }
    // The options an action takes keep their help, with or without values beside them.
    const [status, list, events] = await Promise.all([
      run(t, ['mirage', 'status', '--help']),
      run(t, ['lense', 'list', '--site', 'invented', '--help']),
      run(t, ['lense', 'agent', 'events', '--limit', '5', '--help']),
    ]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^paqvilo mirage status/);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^paqvilo lense list/);
    assert.equal(events.status, 0, events.stderr);
    assert.equal(JSON.parse(events.stdout).command, 'help');
  },
);
