// @test-kind contract: each dataverse command's help, accepted options and file diagnostics come from one option table
import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATAVERSE_COMMAND_OPTIONS, DATAVERSE_OPTIONS } from '../lense/cli-options.mjs';
import { privateJson } from '../lense/dataverse/connection.mjs';
import { saveProtectedState } from '../lense/dataverse/index.mjs';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner
const bin = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const dataverseCli = fileURLToPath(new URL('../lense/dataverse/cli.mjs', import.meta.url));
const guard = new URL('./cli-help-guard.mjs', import.meta.url).href;
const commands = Object.keys(DATAVERSE_COMMAND_OPTIONS);
const accepted = (command) => [
  ...DATAVERSE_COMMAND_OPTIONS[command].required,
  ...DATAVERSE_COMMAND_OPTIONS[command].optional,
];
const fixture = {};

// Every child refuses the network and PAC: a diagnostic that reached either would fail with this marker instead.
before(async () => {
  fixture.root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-dataverse-help-'));
  const offline = path.join(fixture.root, 'offline.mjs');
  await fs.writeFile(
    offline,
    "globalThis.fetch = () => { throw new Error('network attempted'); };\n" +
      "process.env.PAQVILO_PAC_EXECUTABLE = 'pac-attempted-missing-executable';\n",
  );
  const inherited = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'node_options')?.[1];
  fixture.env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'node_options')),
    NODE_OPTIONS: [inherited, `--import="${pathToFileURL(offline).href}"`].filter(Boolean).join(' '),
  };
  fixture.connection = path.join(fixture.root, 'connection.json');
  await fs.writeFile(
    fixture.connection,
    JSON.stringify({
      schemaVersion: 1,
      environmentUrl: 'https://invented.example.test',
      tenantId: '11111111-1111-4111-8111-111111111111',
      clientId: '22222222-2222-4222-8222-222222222222',
      credentialSource: 'environment',
      secretEnvironmentVariable: 'PAQVILO_INVENTED_SECRET',
    }),
  );
});
after(() => fixture.root && fs.rm(fixture.root, { recursive: true, force: true }));

const run = (...args) =>
  spawnSync(process.execPath, [bin, 'dataverse', ...args], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: 'utf8',
    timeout: CLI_HANG_GUARD_MS,
    windowsHide: true,
  });
const oneLineFailure = (result, pattern, label) => {
  assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, '', label);
  assert.match(result.stderr, /^paqvilo dataverse: [^\n]+\n$/, label);
  assert.match(result.stderr, pattern, label);
  assert.doesNotMatch(result.stderr, /network attempted|pac-attempted|ENOENT|EEXIST|\bat .+:\d+:\d+/, label);
};
const listedOptions = (help) => [...help.matchAll(/^ {2}--([\w-]+)/gm)].map((match) => match[1]);

test('each dataverse command help describes that command and lists exactly the options it accepts', () => {
  const texts = new Set();
  for (const command of commands) {
    const result = run(command, '--help');
    assert.equal(result.status, 0, command);
    assert.equal(result.stderr, '', command);
    assert.match(result.stdout, new RegExp(String.raw`^paqvilo dataverse ${command} — \S`), command);
    assert.match(result.stdout, /^Live environment: /m, command);
    assert.match(result.stdout, /^Exit codes: 0 success; 1 failure/m, command);
    assert.deepEqual(listedOptions(result.stdout).sort(), [...accepted(command), 'help'].sort(), command);
    texts.add(result.stdout);
  }
  assert.equal(texts.size, commands.length, 'every command has its own help');
});

test('every dataverse command refuses, in one line, exactly the options its help does not list', () => {
  for (const command of commands) {
    const refused = Object.keys(DATAVERSE_OPTIONS).filter((key) => key !== 'help' && !accepted(command).includes(key));
    const args = refused.flatMap((key) =>
      DATAVERSE_OPTIONS[key].type === 'string' ? [`--${key}`, 'x'] : [`--${key}`],
    );
    const result = run(command, ...args);
    oneLineFailure(result, /not valid for dataverse/, command);
    const named = /^paqvilo dataverse: (.+) (?:is|are) not valid for dataverse /.exec(result.stderr)[1].split(', ');
    assert.deepEqual(named.sort(), refused.map((key) => `--${key}`).sort(), command);
    // The help command is named as paqvilo runs where the test runs (lense/command-hint.mjs).
    assert.match(
      result.stderr,
      new RegExp(
        `run (?:npx (?:--no-install )?paqvilo|node \\S*paqvilo\\.mjs) dataverse ${command} --help for its options\\.`,
      ),
      command,
    );
    // The same refusal holds with --help: help never accepts an option the command refuses.
    assert.equal(run(command, ...args, '--help').status, 1, command);
  }
});

test('every dataverse command accepts each option its help lists', () => {
  const values = {
    environment: 'https://invented.example.test',
    solution: 'invented',
    name: 'invented',
    role: 'invented',
  };
  for (const command of commands) {
    const args = accepted(command).flatMap((key) => {
      if (DATAVERSE_OPTIONS[key].type === 'boolean') return [`--${key}`];
      return [`--${key}`, values[key] ?? path.join(fixture.root, 'absent', `${command}-${key}.json`)];
    });
    const result = run(command, ...args.filter((arg) => arg !== '--json'));
    assert.equal(result.status, 1, command);
    assert.doesNotMatch(result.stderr, /not valid for dataverse|network attempted|pac-attempted/, command);
  }
});

test('dataverse command help loads only the help guard modules and performs no file, process or network work', async () => {
  // The help guard refuses every module outside its allow-list; the dataverse entry point is added as the one
  // exception, so an operational import, a file read or a network call during help fails the run.
  const preload = path.join(fixture.root, 'dataverse-help-guard.mjs');
  await fs.writeFile(
    preload,
    `import fs from 'node:fs';\nimport { registerHooks } from 'node:module';\n` +
      `const entry = ${JSON.stringify(pathToFileURL(dataverseCli).href)};\n` +
      `const source = fs.readFileSync(new URL(entry), 'utf8');\n` +
      `await import(${JSON.stringify(guard)});\n` +
      `registerHooks({ load: (url, context, next) => url === entry ? { format: 'module', source, shortCircuit: true } : next(url, context) });\n`,
  );
  for (const command of commands) {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, dataverseCli, command, '-h'], {
      encoding: 'utf8',
      timeout: CLI_HANG_GUARD_MS,
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^paqvilo dataverse ${command} — `), command);
  }
});

test('a missing input file of any dataverse command names its option, its path and what to do', async () => {
  const manifest = path.join(fixture.root, 'manifest.json');
  await fs.writeFile(manifest, '{}');
  const state = path.join(fixture.root, '.paqvilo');
  await fs.mkdir(state, { recursive: true });
  const registration = path.join(state, 'registration.json');
  await fs.writeFile(registration, '{}');
  const valid = {
    connection: fixture.connection,
    manifest,
    catalogue: manifest,
    solution: 'invented',
    out: path.join(fixture.root, 'absent', 'out.zip'),
    registration,
    'secret-file': path.join(state, 'secret.txt'),
  };
  const inputs = ['connection', 'manifest', 'catalogue', 'registration', 'secret-file'];
  let cases = 0;
  for (const command of commands) {
    const { required, optional } = DATAVERSE_COMMAND_OPTIONS[command];
    const creates = ['register', 'connect'].includes(command) ? ['connection'] : [];
    for (const option of [...required, ...optional].filter((key) => inputs.includes(key) && !creates.includes(key))) {
      // connect admits only paths under .paqvilo, so its missing file lies there too.
      const missing = path.join(command === 'connect' ? '.paqvilo' : '', 'absent', `${option}.json`);
      const selected = { ...valid, [option]: missing };
      if (command === 'connect') selected.connection = path.join(state, `${command}-connection.json`);
      const args = required.flatMap((key) => [`--${key}`, selected[key]]);
      if (!required.includes(option)) args.push(`--${option}`, missing);
      const result = run(command, ...args);
      const expected = `--${option} ${missing} does not exist; check the path.`;
      oneLineFailure(
        result,
        new RegExp(expected.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)),
        `${command} --${option}`,
      );
      cases++;
    }
  }
  assert.equal(cases, 25);
  const directory = run('plan', '--manifest', fixture.root);
  oneLineFailure(directory, /--manifest .+ is a directory; give a file path\./, 'directory');
});

test('an exclusive --out that already exists is refused before contacting Dataverse', async () => {
  const existing = path.join(fixture.root, 'existing.json');
  await fs.writeFile(existing, 'kept');
  const manifest = path.join(fixture.root, 'manifest.json');
  await fs.writeFile(manifest, '{}');
  for (const args of [
    ['apply', '--manifest', manifest],
    ['scope-solutions', '--manifest', manifest],
    ['data-apply', '--catalogue', manifest],
    ['export', '--solution', 'invented'],
  ]) {
    const result = run(...args, '--connection', fixture.connection, '--out', existing);
    oneLineFailure(result, /existing\.json already exists; choose another path or remove it\.$/m, args[0]);
  }
  assert.equal(await fs.readFile(existing, 'utf8'), 'kept');
});

test('exclusive private JSON reports an existing file by path and keeps its EEXIST code', async () => {
  const file = path.join(fixture.root, 'exclusive.json');
  await privateJson(file, { first: true }, true);
  await assert.rejects(privateJson(file, { second: true }, true), {
    code: 'EEXIST',
    message: `${file} already exists; choose another path or remove it.`,
  });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { first: true });
});

test(
  'exclusive protected state reports an existing file by path and keeps its EEXIST code',
  { skip: process.platform !== 'win32' && 'protected state requires Windows DPAPI' },
  async () => {
    const file = path.join(fixture.root, '.paqvilo', 'protected.json');
    await saveProtectedState(file, { first: true }, { purpose: 'invented' });
    await assert.rejects(saveProtectedState(file, { second: true }, { purpose: 'invented' }), {
      code: 'EEXIST',
      message: `${file} already exists; choose another path or remove it.`,
    });
  },
);

test('connect names the option whose path lies outside .paqvilo and the rule it breaks', async () => {
  const state = path.join(fixture.root, '.paqvilo');
  await fs.mkdir(state, { recursive: true });
  const outside = path.join(fixture.root, 'secret.txt');
  const result = run(
    'connect',
    '--registration',
    path.join(state, 'registration.json'),
    '--secret-file',
    outside,
    '--connection',
    path.join(state, 'outside-test-connection.json'),
  );
  oneLineFailure(
    result,
    /--secret-file .+secret\.txt is outside an ignored \.paqvilo directory; .+move it there/,
    'connect',
  );
  assert.doesNotMatch(result.stderr, /Connection and registration state/);
});
