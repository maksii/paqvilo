// @test-kind contract: the Mirage CLI refuses an invocation for its options or its command before it loads the command modules, and the runtime client loads the catalogue, project and discovery modules only to find a runtime that was not named by its origin; those module graphs are most of each process's start-up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

const tool = (name) => fileURLToPath(new URL(`../${name}.mjs`, import.meta.url));
// The modules a command needs and a refusal does not (cli.mjs loadCommandModules).
const COMMAND_MODULES = [
  'mirage/lib/importer',
  'mirage/lib/liquid',
  'mirage/lib/project-config',
  'mirage/lib/config-keys',
  'mirage/lib/solution-roots',
];
// The modules that find a runtime from a catalogue site or a project file (testing/runtime.mjs connectRuntime).
const DISCOVERY_MODULES = ['lense/config', 'lense/commands/mirage', 'mirage/lib/project-config'];

// Runs a tool with a preload that reports, at exit, which of the watched modules the process resolved.
async function resolvedModules(t, script, args, watched) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-cli-modules-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'record-resolves.mjs');
  await fs.writeFile(
    preload,
    `import { registerHooks } from 'node:module';
const seen = new Set();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const name = /\\/((?:lense|mirage)\\/(?:[\\w-]+\\/)*[\\w-]+)\\.mjs$/.exec(resolved.url)?.[1];
    if (name) seen.add(name);
    return resolved;
  },
});
process.on('exit', () => process.stderr.write('\\nRESOLVED:' + JSON.stringify([...seen]) + '\\n'));
`,
  );
  const { code, stdout, stderr } = await new Promise((resolve) =>
    execFile(
      process.execPath,
      ['--import', pathToFileURL(preload).href, script, ...args],
      { cwd: directory, encoding: 'utf8', windowsHide: true, signal: t.signal },
      (error, output, errors) => resolve({ code: error ? error.code : 0, stdout: output, stderr: errors }),
    ),
  );
  const seen = JSON.parse(/\nRESOLVED:(.*)\n/.exec(stderr)[1]);
  return { code, stdout, stderr, loaded: watched.filter((name) => seen.includes(name)) };
}

test('an invocation refused for an unknown option or command loads no command module; inspect loads them', async (t) => {
  const source = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-cli-modules-source-'));
  ownedFixture(t).remove(() => fs.rm(source, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(source, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Invented home\nadx_partialurl: /\n',
  );
  const cli = (args) => resolvedModules(t, tool('cli'), args, COMMAND_MODULES);
  const [unknownOption, unknownCommand, missingCdp, inspected] = await Promise.all([
    cli(['inspect', '--source', source, '--not-an-option']),
    cli(['capture-shell', '--source', source]),
    cli(['capture-stylesheets', '--source', source]),
    cli(['inspect', '--source', source, '--json']),
  ]);
  assert.equal(unknownOption.code, 1);
  assert.match(unknownOption.stderr, /Unknown option/);
  assert.deepEqual(unknownOption.loaded, []);
  assert.equal(unknownCommand.code, 1);
  assert.match(unknownCommand.stderr, /Unknown command: capture-shell/);
  assert.deepEqual(unknownCommand.loaded, []);
  assert.equal(missingCdp.code, 1);
  assert.match(missingCdp.stderr, /requires --cdp/);
  assert.deepEqual(missingCdp.loaded, []);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.deepEqual(inspected.loaded, COMMAND_MODULES);
});

test('a runtime client given an origin loads no catalogue, project or discovery module; a project file loads discovery', async (t) => {
  const trace = (args) => resolvedModules(t, tool('trace'), args, DISCOVERY_MODULES);
  const project = path.join(
    await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-cli-modules-project-')),
    'mirage.project.yml',
  );
  ownedFixture(t).remove(() => fs.rm(path.dirname(project), { recursive: true, force: true }));
  // An existing project file: a missing one is refused as an input path before discovery.
  await fs.writeFile(project, 'version: 2\n');
  // Port 9 (discard) refuses on loopback: the client reaches its request with the origin alone.
  const [byOrigin, refusedOption, byProject] = await Promise.all([
    trace(['list', '--origin', 'http://127.0.0.1:9', '--json']),
    trace(['list', '--not-an-option', '--json']),
    trace(['list', '--project', project, '--json']),
  ]);
  assert.equal(byOrigin.code, 1);
  assert.equal(JSON.parse(byOrigin.stdout).ok, false);
  assert.deepEqual(byOrigin.loaded, []);
  assert.equal(refusedOption.code, 1);
  assert.equal(JSON.parse(refusedOption.stdout).error.code, 'unsupported_option');
  assert.deepEqual(refusedOption.loaded, []);
  // No runtime serves the project: the client says so after reading the discovery records.
  assert.equal(JSON.parse(byProject.stdout).error.code, 'RuntimeUnreachable');
  assert.deepEqual(byProject.loaded, ['lense/config', 'lense/commands/mirage']);
});

// @test-kind contract: a capture command needs the live HTTPS origin and says so before the runtime prints any startup event
test('a capture without an HTTPS portal origin is refused in one line before the runtime starts', async (t) => {
  const source = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-cli-capture-origin-'));
  ownedFixture(t).remove(() => fs.rm(source, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(source, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Invented home\nadx_partialurl: /\n',
  );
  const args = ['--source', source, '--cdp', 'http://127.0.0.1:9', '--state', path.join(source, 'state.json')];
  for (const command of [
    ['capture-stylesheets', '--stylesheet', '/invented.css'],
    ['capture-snippet-composition', '--parent-snippet', 'Parent', '--child-snippet', 'Child'],
  ]) {
    const { code, stdout, stderr } = await resolvedModules(t, tool('cli'), [...command, ...args], []);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.equal(
      stderr.replace(/\nRESOLVED:.*\n$/, '').trim(),
      `${command[0]} needs the live portal's HTTPS origin: select an --env whose origin is HTTPS or pass --origin https://<portal host>.`,
    );
  }
});

// @test-kind contract: docs/cli.md: a Mirage command keeps the toolkit's JSON codes for a missing catalogue, an unknown command and a repeated option, through paqvilo mirage and mirage/cli.mjs alike
test('a Mirage command in a folder without a catalogue reports the toolkit codes in its JSON envelope', async (t) => {
  const paqvilo = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));
  const cases = [
    [['data', 'scaffold', '--state', 'x.json', '--json'], 'CONFIG_NOT_FOUND'],
    [['serve', '--site', 'sample', '--json'], 'CONFIG_NOT_FOUND'],
    [['doctor', '--site', 'sample', '--json'], 'unknown_command'],
    [['inspect', '--port', '1', '--port', '2', '--json'], 'invalid_argument'],
  ];
  const runs = cases.flatMap(([args, expected]) => [
    resolvedModules(t, paqvilo, ['mirage', ...args], []).then((result) => ({ result, args, expected })),
    resolvedModules(t, tool('cli'), args, []).then((result) => ({ result, args, expected })),
  ]);
  for (const { result, args, expected } of await Promise.all(runs)) {
    assert.equal(result.code, 1, args.join(' '));
    const { ok, error } = JSON.parse(result.stdout);
    assert.equal(ok, false, args.join(' '));
    assert.equal(error.code, expected, `${args.join(' ')}: ${error.message}`);
  }
  // A toolkit command reached through mirage/cli.mjs names the command that runs it.
  const direct = await resolvedModules(t, tool('cli'), ['init', '--site', 'sample', '--json'], []);
  const { error } = JSON.parse(direct.stdout);
  assert.equal(error.code, 'unknown_command');
  assert.match(error.message, /Run paqvilo mirage init\.$/);
});
