// @test-kind contract: the demo copy and its refusal messages are Paqvilo's own designed CLI behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cpSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDemoOptions, prepareDemo } from '../lense/commands/demo.mjs';
import { tempDir, withoutToolkitEnvironment } from './fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { ownStartedRuntimes } from './helpers/mirage-runtimes.mjs';
import { boundedCommand, COMMAND_HANG_GUARD_MS } from './helpers/bounded-command.mjs';
import { countOperations, operationBudget } from './helpers/operation-budget.mjs';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner

test('demo copies an editable project, preserves source edits on repeat and refuses unrelated folders', async (t) => {
  const root = await tempDir('paqvilo-demo-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'example');
  assert.equal((await prepareDemo(directory)).created, true);
  const template = path.join(directory, 'portal/web-files/demo.css');
  await fs.writeFile(template, 'My local changes');
  assert.equal((await prepareDemo(directory)).created, false);
  assert.equal(await fs.readFile(template, 'utf8'), 'My local changes');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const toolkit = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.devDependencies.paqvilo, toolkit.version, 'the copy depends on this published toolkit version');
  assert.match(manifest.devDependencies.yaml, /^\d/);
  assert.match(manifest.devDependencies['playwright-core'], /^\d/);
  const example = JSON.parse(await fs.readFile(new URL('../examples/project/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.devDependencies['@microsoft/power-apps'], example.devDependencies['@microsoft/power-apps']);
  for (const name of ['code-app:mirage', 'code-app:dev']) assert.equal(manifest.scripts[name], example.scripts[name]);
  for (const dependency of ['yaml', 'playwright-core']) {
    assert.equal(manifest.devDependencies[dependency], toolkit.dependencies[dependency]);
    assert.equal(example.devDependencies[dependency], toolkit.dependencies[dependency]);
  }
  const guidance = await fs.readFile(path.join(directory, 'AGENTS.md'), 'utf8');
  assert.match(guidance, /npm run dev/);
  assert.match(guidance, /npm test/);
  assert.doesNotMatch(guidance, /npm run (?:setup|validate)/);
  assert.equal((await fs.readFile(path.join(directory, 'portal/web-files/theme.css'), 'utf8')).includes('\r'), false);
  assert.match(manifest.scripts['dev:debug'], /--debug-port 9222/);
  const workspace = JSON.parse(await fs.readFile(path.join(directory, 'paqvilo-demo.code-workspace'), 'utf8'));
  assert.equal(workspace.folders[0].path, '.');
  const tasks = JSON.parse(await fs.readFile(path.join(directory, '.vscode/tasks.json'), 'utf8'));
  const launch = JSON.parse(await fs.readFile(path.join(directory, '.vscode/launch.json'), 'utf8'));
  const labels = new Set(tasks.tasks.map((task) => task.label));
  for (const configuration of launch.configurations) {
    assert.equal(configuration.type, 'msedge');
    assert.equal(configuration.request, 'attach', 'debugger reuses the toolkit browser');
    if (configuration.preLaunchTask) assert.ok(labels.has(configuration.preLaunchTask));
  }
  for (const task of tasks.tasks) {
    if (task.dependsOn) assert.ok(labels.has(task.dependsOn));
    if (task.isBackground)
      assert.ok(
        new RegExp(task.problemMatcher.background.endsPattern).test(
          'edit a file under the sources and the browser follows.',
        ),
      );
  }
  await fs.writeFile(path.join(directory, '.vscode/tasks.json'), '{"myTask":true}');
  await fs.writeFile(path.join(directory, 'AGENTS.md'), 'My project guidance');
  await fs.unlink(path.join(directory, '.vscode/launch.json'));
  await fs.unlink(path.join(directory, 'paqvilo-demo.code-workspace'));
  await prepareDemo(directory);
  assert.equal(await fs.readFile(path.join(directory, '.vscode/tasks.json'), 'utf8'), '{"myTask":true}');
  assert.equal(await fs.readFile(path.join(directory, 'AGENTS.md'), 'utf8'), 'My project guidance');
  await fs.unlink(path.join(directory, 'AGENTS.md'));
  await prepareDemo(directory);
  assert.equal(await fs.readFile(path.join(directory, 'AGENTS.md'), 'utf8'), guidance);
  await fs.access(path.join(directory, '.vscode/launch.json'));
  await fs.access(path.join(directory, 'paqvilo-demo.code-workspace'));
  const cliDirectory = path.join(root, 'cli-example');
  const scaffold = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url)),
      'mirage',
      'demo',
      '--scaffold',
      '--dir',
      cliDirectory,
    ],
    { cwd: root, encoding: 'utf8', timeout: CLI_HANG_GUARD_MS, windowsHide: true },
  );
  assert.match(scaffold, /No runtime was started/);
  assert.match(scaffold, /paqvilo-demo\.code-workspace/);
  const cliManifest = JSON.parse(await fs.readFile(path.join(cliDirectory, 'package.json'), 'utf8'));
  assert.equal(cliManifest.devDependencies['@microsoft/power-apps'], example.devDependencies['@microsoft/power-apps']);
  for (const name of ['code-app:mirage', 'code-app:dev'])
    assert.equal(cliManifest.scripts[name], example.scripts[name]);
  await fs.access(path.join(cliDirectory, 'code-app/server.mjs'));
  await fs.access(path.join(cliDirectory, 'code-app/solution/Entities/x_item/Entity.xml'));
  assert.deepEqual(await fs.readdir(path.join(directory, '.paqvilo')), ['demo.json']);
  await fs.access(path.join(directory, 'solution/Entities/Account/Entity.xml'));
  await fs.access(path.join(directory, 'metadata/Other/Relationships.xml'));
  await fs.access(path.join(directory, 'components/DataversePlugins/AccountRules.cs'));
  await fs.access(
    path.join(
      directory,
      'solution/PluginAssemblies/PaqviloDemoPlugins-B4700000-0000-4000-8000-370000000001/PaqviloDemoPlugins.dll',
    ),
  );
  for (const output of ['bin', 'obj'])
    await assert.rejects(fs.access(path.join(directory, 'components/DataversePlugins', output)), { code: 'ENOENT' });
  for (const file of [
    'deployment/PaqviloDemoSample.zip',
    'deployment/PaqviloDemoCodeComponents.zip',
    'deployment/demo-data.zip',
    'deployment/configure.mjs',
    'cli.mjs',
    'editor-workspace.mjs',
    'code-solution/Other/Solution.xml',
    'code-app/server.mjs',
    'code-app/mirage.mjs',
    'code-app/app.js',
    'code-app/index.html',
    'code-app/power.config.json',
    'code-app/solution/Other/Solution.xml',
    'code-app/solution/Entities/x_item/Entity.xml',
    'test/baseline-code-app-sdk.test.mjs',
    'components/pcf-field-types/ExampleAccountFields/index.ts',
    'components/pcf-field-types/ExampleAccountFields/ControlManifest.Input.xml',
  ]) {
    await fs.access(path.join(directory, file));
  }
  const fixtures = JSON.parse(await fs.readFile(path.join(directory, 'pack/fixtures.json'), 'utf8'));
  assert.equal(fixtures.account.length, 12);
  assert.equal(fixtures.contact.length, 24);
  const unrelated = path.join(root, 'existing-project');
  await fs.mkdir(unrelated);
  await fs.writeFile(path.join(unrelated, 'important.txt'), 'Keep me');
  await assert.rejects(prepareDemo(unrelated), /No files were changed/);
  assert.deepEqual(await fs.readdir(unrelated), ['important.txt']);
  await assert.rejects(prepareDemo(path.join(unrelated, 'important.txt')), /regular directory/);
});

/** Every file under `directory` with one of the extensions, skipping installed packages. */
async function treeFiles(directory, extensions) {
  const entries = await fs.readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.split(path.sep).includes('node_modules'));
}

test('every relative import in a demo copy resolves inside it and every copied script prints its help', async (t) => {
  const root = await tempDir('paqvilo-demo-');
  const links = [];
  t.after(async () => {
    // Junctions are removed first so the recursive removal never reaches the toolkit checkout.
    for (const link of links) await fs.unlink(link);
    await fs.rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'example');
  await prepareDemo(directory);
  const sources = await treeFiles(directory, ['.mjs', '.js']);
  const unresolved = [];
  for (const file of sources)
    for (const [, specifier] of (await fs.readFile(file, 'utf8')).matchAll(
      /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    )) {
      const target = path.resolve(path.dirname(file), specifier);
      const inside = !path.relative(directory, target).startsWith('..');
      if (!inside || !(await fs.stat(target).catch(() => null)))
        unresolved.push(`${path.relative(directory, file)} -> ${specifier}`);
    }
  assert.deepEqual(unresolved, [], 'relative imports that do not resolve inside the copy');
  // Install the copy's declared packages as links to this checkout, as npm install would provide them.
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const toolkit = fileURLToPath(new URL('..', import.meta.url));
  for (const name of Object.keys(manifest.devDependencies)) {
    const link = path.join(directory, 'node_modules', name);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(name === 'paqvilo' ? toolkit : path.join(toolkit, 'node_modules', name), link, 'junction');
    links.push(link);
  }
  // The entry points are the scripts that parse their arguments with the copy's shared cli().
  const scripts = [];
  for (const file of sources)
    if (
      !file.startsWith(path.join(directory, 'test') + path.sep) &&
      /import\s*\{[^}]*\bcli\b[^}]*\}\s*from\s*'\.{1,2}\/(?:\.\.\/)*cli\.mjs'/.test(await fs.readFile(file, 'utf8'))
    )
      scripts.push(file);
  assert.ok(scripts.length >= 9, scripts.join('\n'));
  for (const script of scripts) {
    const result = spawnSync(process.execPath, [script, '--help'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: CLI_HANG_GUARD_MS,
      windowsHide: true,
    });
    const name = path.relative(directory, script);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /\S/, name);
  }
});

test('an interrupted demo copy leaves no folder behind and the next run succeeds', async (t) => {
  const root = await tempDir('paqvilo-demo-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'example');
  let copies = 0;
  const interrupted = (source, destination, options) => {
    copies += 1;
    if (copies === 3) throw new Error('Simulated interruption during the copy');
    return cpSync(source, destination, options);
  };
  await assert.rejects(prepareDemo(directory, { copy: interrupted }), /Simulated interruption/);
  assert.deepEqual(await fs.readdir(root), [], 'neither the target nor a staging folder remains');
  assert.equal((await prepareDemo(directory)).created, true);
  await fs.access(path.join(directory, '.paqvilo/demo.json'));
});

test('a demo copy fills an empty target folder', async (t) => {
  const root = await tempDir('paqvilo-demo-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'example');
  await fs.mkdir(directory);
  assert.equal((await prepareDemo(directory)).created, true);
  await fs.access(path.join(directory, '.paqvilo/demo.json'));
  assert.deepEqual(await fs.readdir(root), ['example']);
});

test('a leftover partial copy is named in the refusal and is never deleted', async (t) => {
  const root = await tempDir('paqvilo-demo-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'example');
  const leftover = path.join(root, 'example.partial-4242');
  await fs.mkdir(directory);
  await fs.mkdir(leftover);
  await fs.writeFile(path.join(directory, 'important.txt'), 'Keep me');
  await fs.writeFile(path.join(leftover, 'half.txt'), 'partial');
  await assert.rejects(prepareDemo(directory), (error) => {
    assert.match(error.message, /No files were changed/);
    assert.match(error.message, /example\.partial-4242\. It can be deleted\./);
    return true;
  });
  assert.deepEqual(await fs.readdir(directory), ['important.txt']);
  assert.deepEqual(await fs.readdir(leftover), ['half.txt']);
});

const lockedRename = (code) => async () => {
  throw Object.assign(new Error(`${code}: the staging folder is held`), { code });
};

test('a staging folder held briefly by another program is renamed into place after retries', async (t) => {
  const root = await tempDir('paqvilo-demo-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'example');
  const realRename = fs.rename;
  let calls = 0;
  const rename = (from, to) => {
    calls += 1;
    return calls <= 2 ? lockedRename('EPERM')() : realRename(from, to);
  };
  const waits = [];
  const wait = async (ms) => {
    waits.push(ms);
  };
  assert.equal((await prepareDemo(directory, { rename, wait })).created, true);
  await fs.access(path.join(directory, '.paqvilo/demo.json'));
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  assert.deepEqual(await fs.readdir(root), ['example']);
});

test('a staging folder that stays locked fails after five attempts, names both folders and is removed', async (t) => {
  const root = await tempDir('paqvilo-demo-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'example');
  let calls = 0;
  const rename = (...args) => {
    calls += 1;
    return lockedRename('EBUSY')(...args);
  };
  const waits = [];
  const wait = async (ms) => {
    waits.push(ms);
  };
  await assert.rejects(prepareDemo(directory, { rename, wait }), (error) => {
    assert.match(error.message, /after 5 attempts/);
    assert.ok(error.message.includes(directory), 'the message names the target folder');
    assert.match(error.message, /example\.partial-\d+/, 'the message names the staging folder');
    assert.equal(error.cause.code, 'EBUSY');
    return true;
  });
  assert.equal(calls, 5);
  assert.equal(waits.length, 4);
  assert.deepEqual(await fs.readdir(root), [], 'the staging folder is removed');
});

test('a rename failure with another error code is not retried', async (t) => {
  const root = await tempDir('paqvilo-demo-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'example');
  let calls = 0;
  const rename = (...args) => {
    calls += 1;
    return lockedRename('ENOTEMPTY')(...args);
  };
  const waits = [];
  const wait = async (ms) => {
    waits.push(ms);
  };
  await assert.rejects(prepareDemo(directory, { rename, wait }), { code: 'ENOTEMPTY' });
  assert.equal(calls, 1);
  assert.equal(waits.length, 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test('the demo copy answers editor-workspace --help and argument errors before npm install', async (t) => {
  const root = await tempDir('paqvilo-demo-workspace-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'example');
  await prepareDemo(directory);
  const run = (...args) =>
    spawnSync(process.execPath, ['editor-workspace.mjs', ...args], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_HANG_GUARD_MS,
    });
  const help = run('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: node editor-workspace\.mjs/);
  const unknown = run('--bogus');
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr, 'Unknown option --bogus. Run it with --help for usage.\n');
  // Real work needs the toolkit: one line saying how to install it, no module-resolution trace.
  const work = run();
  assert.equal(work.status, 1);
  assert.equal(work.stderr, 'The paqvilo package is not installed in this project. Run npm install first.\n');
  await assert.rejects(fs.access(path.join(directory, 'portal.code-workspace')), { code: 'ENOENT' });
});

// Expected values were captured from the demo parser before it moved to the shared option parsing.
const DEMO_PARSE_TABLE = [
  ['no arguments', [], { values: { dir: './paqvilo-example' }, positionals: [] }],
  ['--dir with a value', ['--dir', './invented'], { values: { dir: './invented' }, positionals: [] }],
  [
    '--browser with a value',
    ['--browser', 'chrome'],
    { values: { dir: './paqvilo-example', browser: 'chrome' }, positionals: [] },
  ],
  [
    '--debug-port with a value',
    ['--debug-port', '9222'],
    { values: { dir: './paqvilo-example', 'debug-port': '9222' }, positionals: [] },
  ],
  ['--headless flag', ['--headless'], { values: { dir: './paqvilo-example', headless: true }, positionals: [] }],
  ['--scaffold flag', ['--scaffold'], { values: { dir: './paqvilo-example', scaffold: true }, positionals: [] }],
  ['-h flag', ['-h'], { values: { dir: './paqvilo-example', help: true }, positionals: [] }],
  ['--help flag', ['--help'], { values: { dir: './paqvilo-example', help: true }, positionals: [] }],
  [
    'a repeated --dir keeps the last value',
    ['--dir', 'one', '--dir', 'two'],
    { values: { dir: 'two' }, positionals: [] },
  ],
  ['an unknown option', ['--bogus'], { error: 'unsupported_option' }],
  ['a missing value', ['--dir'], { error: 'invalid_argument' }],
  ['a positional argument', ['extra'], { error: 'invalid_argument' }],
];

test('demo option parsing keeps its accepted options, defaults, repeated values and errors', () => {
  for (const [name, args, expected] of DEMO_PARSE_TABLE) {
    if (expected.error) {
      assert.throws(() => parseDemoOptions(args), { code: expected.error }, name);
      continue;
    }
    const parsed = parseDemoOptions(args);
    assert.deepEqual({ ...parsed.values }, expected.values, name);
    assert.deepEqual(parsed.positionals, expected.positionals, name);
  }
});

const demoCli = fileURLToPath(new URL('../lense/commands/demo.mjs', import.meta.url));
const DEMO_CLI_TABLE = [
  ['--help', ['--help'], 0, /^Usage: paqvilo mirage demo/],
  ['-h', ['-h'], 0, /^Usage: paqvilo mirage demo/],
  ['a repeated option before --help', ['--dir', 'one', '--dir', 'two', '--help'], 0, /^Usage: paqvilo mirage demo/],
  ['an unknown option', ['--bogus'], 1, '--bogus'],
  ['a missing value', ['--dir'], 1, '--dir'],
  ['a positional argument', ['extra'], 1, 'extra'],
];

test('demo command prints help and parse errors with the same exit codes and messages', () => {
  for (const [name, args, status, expected] of DEMO_CLI_TABLE) {
    const result = spawnSync(process.execPath, [demoCli, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_HANG_GUARD_MS,
    });
    assert.equal(result.status, status, name);
    if (status) {
      // The product's own prefix and the offending token; Node's sentence is not part of the contract.
      assert.ok(result.stderr.startsWith('Mirage demo: '), name);
      assert.ok(result.stderr.includes(expected), name);
    } else {
      assert.match(result.stdout, expected, name);
    }
  }
});

test(
  'every demo start restores the sample dataset and keeps source edits',
  { timeout: operationBudget(4, COMMAND_HANG_GUARD_MS) },
  async (t) => {
    withoutToolkitEnvironment(t);
    const root = await tempDir('paqvilo-demo-reset-');
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const directory = path.join(root, 'example');
    await prepareDemo(directory);
    const config = path.join(directory, 'paqvilo.config.yml');
    // The demo's own catalogue says bootstrap (ordinary `npm run dev` keeps state); the demo's arguments must win.
    assert.match(await fs.readFile(config, 'utf8'), /presetMode: bootstrap/);
    // The arguments the demo command passes to its runtime, read from the command's source.
    const command = await fs.readFile(new URL('../lense/commands/demo.mjs', import.meta.url), 'utf8');
    const literal = /DEMO_PRESET_ARGUMENTS = Object\.freeze\((\[[^\]]*\])\)/.exec(command)[1];
    const presetArguments = JSON.parse(literal.replaceAll("'", '"'));
    const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
    const run = countOperations(t, 4, (...args) =>
      boundedCommand(t, process.execPath, [cli, 'mirage', ...args, '--config', config, '--site', 'example'], {
        cwd: directory,
      }),
    );
    const start = async () => {
      const result = await run('start', '--port', '0', ...presetArguments, '--json');
      ownStartedRuntimes(t, result.stdout);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    const first = await start();
    assert.equal((await run('stop', '--json')).status, 0);
    const state = JSON.parse(await fs.readFile(first.stateFile, 'utf8'));
    const sample = state.tables.contact.length;
    state.tables.contact.push({ contactid: '00000000-0000-4000-8000-0000000000aa', fullname: 'Added locally' });
    await fs.writeFile(first.stateFile, JSON.stringify(state));
    const source = path.join(directory, 'portal/web-files/demo.css');
    await fs.appendFile(source, '\n/* my source edit */\n');
    const second = await start();
    assert.deepEqual(second.runtime.startupPreset, { ...second.runtime.startupPreset, mode: 'always', applied: true });
    assert.equal((await run('stop', '--json')).status, 0);
    const restored = JSON.parse(await fs.readFile(second.stateFile, 'utf8')).tables.contact;
    assert.equal(restored.length, sample);
    assert.ok(!restored.some((row) => row.fullname === 'Added locally'));
    assert.match(await fs.readFile(source, 'utf8'), /my source edit/);
  },
);
