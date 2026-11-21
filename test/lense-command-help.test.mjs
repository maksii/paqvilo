// @test-kind contract: command help exposes only its accepted flags without loading configuration or executing runtime operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LENSE_COMMAND_OPTIONS } from '../lense/cli-options.mjs';
import { boundedCommand } from './helpers/bounded-command.mjs';
import { tempDirSync } from './fixture.mjs';

const cli = fileURLToPath(new URL('../lense/cli.mjs', import.meta.url));
const bin = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const guard = new URL('./cli-help-guard.mjs', import.meta.url).href;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));

function fixture(t) {
  const cwd = tempDirSync('paqvilo-selected-help-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return (args, entry = cli) => boundedCommand(t, process.execPath, ['--import', guard, entry, ...args], { cwd, env });
}

test('all Lense commands expose their own complete option set under the side-effect guard', async (t) => {
  const run = fixture(t);
  for (const [command, accepted] of Object.entries(LENSE_COMMAND_OPTIONS)) {
    const result = await run([command, '--help']);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    const usage = command === 'agent' ? JSON.parse(result.stdout).usage : result.stdout;
    const prefix = command === 'mirage' ? 'paqvilo mirage' : `paqvilo lense ${command}`;
    assert.ok(usage.startsWith(`${prefix} — `), command);
    assert.ok(usage.includes(`Usage: ${prefix}`), command);
    const flags = [...usage.matchAll(/^ {2}--([\w-]+)/gm)].map((match) => match[1]);
    assert.deepEqual(new Set(flags), new Set([...accepted, 'json', 'help']), command);
    assert.doesNotMatch(usage, /\nCommands\n/);
  }
});

test('selected help keeps JSON envelopes and short help while excluding unrelated command options', async (t) => {
  const run = fixture(t);
  const human = await run(['resources', '-h']);
  const json = await run(['resources', '--help', '--json']);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(json.status, 0, json.stderr);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.usage.trimEnd(), human.stdout.trimEnd());
  assert.deepEqual(
    { ...envelope, usage: undefined },
    {
      schemaVersion: 1,
      command: 'help',
      offline: true,
      ok: true,
      usage: undefined,
      writesFiles: [],
      errors: [],
    },
  );
  assert.match(human.stdout, /^ {2}--page /m);
  assert.doesNotMatch(human.stdout, /^ {2}--(?:browser|sign-in-timeout|debug-port)\b/m);
  const invalid = await run(['resources', '--invented-option', '--help']);
  assert.notEqual(invalid.status, 0);
});

test('public trace help advertises identity-provider and SharePoint without loading their runtimes', async (t) => {
  const result = await fixture(t)(['mirage', 'trace', '--help'], bin);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--host [^\n]*\|identity-provider\|sharepoint/);
  assert.match(
    result.stdout,
    /power-pages\|standalone\|model-driven\|canvas\|code-app\|dataverse-api\|tds\|soap\|job\|sim/,
  );
});

test('public model-driven help describes dev session duration and JSON reports without agent-only descriptions', async (t) => {
  const cwd = tempDirSync('paqvilo-model-driven-help-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const action of ['inspect', 'dev']) {
    const result = await boundedCommand(t, process.execPath, [bin, 'lense', 'model-driven', action, '--help'], {
      cwd,
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Usage: paqvilo lense model-driven ${action} \\[options\\]`));
    assert.match(result.stdout, /--project <file>\s+project file declaring the selected Solution sources/);
    assert.match(
      result.stdout,
      /--timeout <ms>\s+dev: stop the session after 1\.\.3600000 milliseconds \(not supported by inspect\)/,
    );
    assert.match(
      result.stdout,
      /--output <file>\s+dev: write a JSON session report when the session stops \(not supported by inspect\)/,
    );
    assert.match(result.stdout, /--json\s+inspect: print its report as JSON/);
    assert.doesNotMatch(result.stdout, /agent screenshot|PNG destination|agent operation/);
  }
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('model-driven help without an action names dev as the default action', async (t) => {
  const cwd = tempDirSync('paqvilo-model-driven-help-');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = await boundedCommand(t, process.execPath, [bin, 'lense', 'model-driven', '--help'], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage: paqvilo lense model-driven inspect\|dev \[options\] \(default: dev\)$/m);
  const dev = await boundedCommand(t, process.execPath, [bin, 'lense', 'model-driven', 'dev', '--help'], { cwd, env });
  assert.doesNotMatch(dev.stdout, /\(default: dev\)/);
});
