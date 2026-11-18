// @test-kind contract: a folder without a catalogue never runs the toolkit's sample catalogue as the user's project or writes into the toolkit checkout (lense/config.mjs loadCatalogue), and a missing --config is refused in every command
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { boundedCommand } from './helpers/bounded-command.mjs';
import { hintCommands } from './helpers/mirage-in-process.mjs';
import { tempDirSync } from './fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(root, 'bin', 'paqvilo.mjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
const run = (t, cwd, args) => boundedCommand(t, process.execPath, [bin, ...args], { cwd, env });

function folder(t) {
  const directory = tempDirSync('paqvilo-no-catalogue-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** The toolkit checkout's own settings and state: what a command run elsewhere must never touch. */
function toolkitState() {
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const state = path.join(root, '.paqvilo');
  return {
    env: read(path.join(root, '.env')),
    state: fs.existsSync(state) ? fs.readdirSync(state).sort((a, b) => a.localeCompare(b)) : null,
  };
}

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

test('every command in a folder without a catalogue refuses it as missing and leaves the toolkit checkout untouched', async (t) => {
  const empty = folder(t);
  const before = toolkitState();
  const results = await Promise.all(COMMANDS.map(([args]) => run(t, empty, args)));
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
  assert.deepEqual(toolkitState(), before, 'the toolkit checkout .env and .paqvilo are unchanged');
});

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

test('a --config file that does not exist is refused with one line and a failure exit in every command', async (t) => {
  const empty = folder(t);
  const missing = path.join(empty, 'missing.yml');
  const before = toolkitState();
  const results = await Promise.all(EXPLICIT.map((args) => run(t, empty, [...args, '--config', missing])));
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
  assert.deepEqual(toolkitState(), before);
});

test('a --source run without a catalogue borrows only the sample site defaults; init uses its runtime options', async (t) => {
  const empty = folder(t);
  fs.mkdirSync(path.join(empty, 'portal', 'web-files'), { recursive: true });
  fs.mkdirSync(path.join(empty, 'solution'));
  const before = toolkitState();
  const state = path.join(empty, 'smoke.json');
  const init = await run(t, empty, [
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
  ]);
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
  const site = await run(t, empty, ['lense', 'list', '--source', 'portal', '--site', 'portal']);
  assert.equal(site.status, 1);
  assert.match(site.stderr, /^paqvilo: No catalogue: .+paqvilo\.config\.yml does not exist\./);
  assert.deepEqual(toolkitState(), before);
});
