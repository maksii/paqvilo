// @test-kind contract: a folder without a catalogue never runs the toolkit's sample catalogue as the user's project or writes into the toolkit checkout (lense/config.mjs loadCatalogue), and a missing --config is refused in every command
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { boundedCommand, COMMAND_HANG_GUARD_MS } from './helpers/bounded-command.mjs';
import { operationBudget } from './helpers/operation-budget.mjs';
import { hintCommands } from './helpers/mirage-in-process.mjs';
import { tempDirSync } from './fixture.mjs';
import { writeRecorder } from './helpers/write-recorder.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(root, 'bin', 'paqvilo.mjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const run = (t, cwd, args, toolkit) =>
  boundedCommand(t, process.execPath, [bin, ...args], { cwd, env: toolkit ? toolkit.env(env) : env });
// Every command has its own hang guard, counted from the moment it holds a process slot. A test that runs a batch
// declares the batch's finite budget: on a small loaded host the commands run one at a time, each slow but none hung,
// and the lane's 180 s hang guard would otherwise cut the queue.
const commandBatch = (commands) => ({ timeout: operationBudget(commands, COMMAND_HANG_GUARD_MS) });

function folder(t) {
  const directory = tempDirSync('paqvilo-no-catalogue-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Records what the commands write to the toolkit checkout's own settings and state, which a command run elsewhere must
 * never touch. The checkout's .paqvilo is also written by the validation lanes running beside this test, so a listing
 * of it before and after cannot tell whose write it was: the commands' own writes are recorded instead.
 */
const toolkitWrites = (t) => writeRecorder(t, [path.join(root, '.env'), path.join(root, '.paqvilo')]);

const escape = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const mirageHint = '--config <catalogue>, --project <file> or --runtime <kind>';

// Every command that reads a catalogue, run in a folder without one: [arguments, the selectors its message offers].
const COMMANDS = [
  [['lense', 'list'], '--config <catalogue>'],
  [['lense', 'doctor'], '--config <catalogue>'],
  [['lense', 'audit'], '--config <catalogue>'],
  [['lense', 'status'], '--config <catalogue>'],
  [['lense', 'map', '--no-write'], '--config <catalogue>'],
  [['lense', 'verify'], '--config <catalogue>'],
  [['lense', 'dev', '--headless'], '--config <catalogue>'],
  [['lense', 'use', 'portal', 'dev'], '--config <catalogue>'],
  [['lense', 'use'], '--config <catalogue>'],
  [['lense', 'analyze'], '--config <catalogue>'],
  [['lense', 'mirage', 'inspect'], mirageHint],
  [['mirage', 'init'], mirageHint],
  [['mirage', 'start'], mirageHint],
  [['mirage', 'inspect'], '--config <catalogue>'],
  [['mirage', 'preflight'], '--config <catalogue>'],
  [['mirage', 'serve', '--port', '0'], '--config <catalogue>'],
  [['mirage', 'data', 'scaffold', '--profile', 'smoke'], '--config <catalogue>'],
  [['mirage', 'bootstrap-report'], '--config <catalogue>'],
];

test(
  'every command in a folder without a catalogue refuses it as missing and leaves the toolkit checkout untouched',
  commandBatch(COMMANDS.length),
  async (t) => {
    const empty = folder(t);
    const toolkit = toolkitWrites(t);
    const results = await Promise.all(COMMANDS.map(([args]) => run(t, empty, args, toolkit)));
    for (const [index, [args, alternatives]] of COMMANDS.entries()) {
      const { status, stdout, stderr } = results[index];
      const label = args.join(' ');
      assert.notEqual(status, 0, `${label}: ${stdout}${stderr}`);
      assert.match(
        stderr,
        new RegExp(
          `No catalogue: ${escape(path.join(empty, 'paqvilo.config.yml'))} does not exist\\. Run in the folder that holds paqvilo\\.config\\.yml, or pass ${escape(alternatives)}\\.`,
        ),
        label,
      );
      assert.doesNotMatch(stdout + stderr, /portal\.example\.test|now working on/, label);
    }
    assert.deepEqual(fs.readdirSync(empty), [], 'nothing is written in the folder either');
    assert.deepEqual(toolkit.writes(), [], 'no command writes the toolkit checkout .env or .paqvilo');
  },
);

// Each command that takes --config, with a file that does not exist: [arguments before --config].
const EXPLICIT = [
  ['lense', 'agent'],
  ['lense', 'agent', 'status', '--session', 'x.json'],
  ['lense', 'list'],
  ['lense', 'use', 'portal', 'dev'],
  ['lense', 'doctor'],
  ['lense', 'analyze'],
  ['lense', 'audit'],
  ['lense', 'resources'],
  ['lense', 'status'],
  ['lense', 'map'],
  ['lense', 'verify'],
  ['lense', 'dev', '--headless'],
  ['lense', 'mirage', 'init'],
  ['lense', 'mirage', 'start'],
  ['lense', 'mirage', 'inspect'],
  ['mirage', 'inspect'],
];

test(
  'a --config file that does not exist is refused with one line and a failure exit in every command',
  commandBatch(EXPLICIT.length),
  async (t) => {
    const empty = folder(t);
    const missing = path.join(empty, 'missing.yml');
    const toolkit = toolkitWrites(t);
    const results = await Promise.all(EXPLICIT.map((args) => run(t, empty, [...args, '--config', missing], toolkit)));
    for (const [index, args] of EXPLICIT.entries()) {
      const { status, stdout, stderr } = results[index];
      const label = args.join(' ');
      assert.notEqual(status, 0, `${label}: ${stdout}${stderr}`);
      // A JSON document (agent, --json) escapes the path's backslashes.
      const named = [missing, JSON.stringify(missing).slice(1, -1)].map(
        (file) => `--config file not found: ${escape(file)}\\. Pass an existing file\\.`,
      );
      assert.match(stdout + stderr, new RegExp(named.join('|')), label);
      assert.doesNotMatch(stdout + stderr, /ENOENT|\n\s+at /, label);
    }
    assert.deepEqual(fs.readdirSync(empty), []);
    assert.deepEqual(toolkit.writes(), []);
  },
);

test('a --source run without a catalogue borrows only the sample site defaults; init uses its runtime options', async (t) => {
  const empty = folder(t);
  fs.mkdirSync(path.join(empty, 'portal', 'web-files'), { recursive: true });
  fs.mkdirSync(path.join(empty, 'solution'));
  const toolkit = toolkitWrites(t);
  const state = path.join(empty, 'smoke.json');
  const init = await run(
    t,
    empty,
    [
      'mirage',
      'init',
      '--source',
      'portal',
      '--solution-root',
      'solution',
      '--port',
      '0',
      '--state',
      'smoke.json',
      '--preset',
      'smoke',
      '--json',
    ],
    toolkit,
  );
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const report = JSON.parse(init.stdout);
  // The project and its state are written in this folder, never in the toolkit checkout.
  assert.equal(report.file, path.join(empty, '.paqvilo', 'mirage', 'portal.project.yml'));
  // --solution-root is the written project's Solution root.
  assert.deepEqual(
    report.solutions.map((solution) => solution.root),
    [path.join(empty, 'solution')],
  );
  const written = YAML.parse(fs.readFileSync(report.file, 'utf8'));
  assert.equal(written.solutions.length, 1);
  // --port, --state and --preset are runtime options: the printed dev command carries them on.
  const [next] = hintCommands(report.next).commands;
  for (const [option, value] of [
    ['--port', '0'],
    ['--state', state],
    ['--preset', 'smoke'],
  ])
    assert.equal(next[next.indexOf(option) + 1], value, option);
  // --source with --site names a catalogue site: there is none here.
  const site = await run(t, empty, ['lense', 'list', '--source', 'portal', '--site', 'portal'], toolkit);
  assert.equal(site.status, 1);
  assert.match(site.stderr, /^paqvilo: No catalogue: .+paqvilo\.config\.yml does not exist\./);
  assert.deepEqual(toolkit.writes(), []);
});
