// @test-kind contract: every project script answers --help, rejects bad arguments in one line and regenerates committed JSON without a diff.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// hang guard only: a blocked synchronous child cannot be ended by the test runner
const CLI_HANG_GUARD_MS = 170_000;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Any network call and any read of a connection file fails loudly, so a probe that slipped past argument validation
// can neither reach an environment nor read a connection. PROBE_OPTIONS prints the options the script hands to
// parseArgs instead of parsing them.
const trap = [
  "import fs from 'node:fs';",
  "import util from 'node:util';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "const blocked = (file) => String(file?.href ?? file).endsWith('connection.json');",
  'const guard = (fn) => function (file, ...rest) {',
  "  if (blocked(file)) throw new Error('CONNECTION READ BLOCKED');",
  '  return fn.call(this, file, ...rest);',
  '};',
  "for (const target of [fs, fs.promises]) for (const key of ['readFile', 'open']) target[key] = guard(target[key]);",
  "for (const key of ['readFileSync', 'openSync']) fs[key] = guard(fs[key]);",
  'if (process.env.PROBE_OPTIONS)',
  '  util.parseArgs = (config) => {',
  '    const options = Object.entries(config.options ?? {}).map(([name, option]) => [name, option.type]);',
  '    process.stdout.write(JSON.stringify(Object.fromEntries(options)));',
  '    process.exit(0);',
  '  };',
  'syncBuiltinESMExports();',
  "globalThis.fetch = () => { throw new Error('NETWORK BLOCKED'); };",
].join('\n');
const offline = 'data:text/javascript,' + encodeURIComponent(trap);
const run = (script, args, { cwd = projectRoot, env = {} } = {}) =>
  spawnSync(process.execPath, ['--import', offline, path.join(projectRoot, script), ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: CLI_HANG_GUARD_MS,
    env: { ...process.env, ...env },
  });

function assertOneLineFailure(result, pattern) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^[^\n]+\n$/, 'one line on stderr');
  assert.doesNotMatch(result.stderr, /\n\s+at |ERR_PARSE_ARGS|NETWORK BLOCKED|CONNECTION READ BLOCKED/);
  assert.match(result.stderr, pattern);
}

// The options a script accepts, read from the configuration it passes to parseArgs (help is added by cli.mjs).
function acceptedOptions(script) {
  const probe = run(script, [], { env: { PROBE_OPTIONS: '1' } });
  assert.equal(probe.status, 0, probe.stderr);
  const { help, ...options } = JSON.parse(probe.stdout);
  assert.equal(help, 'boolean');
  return options;
}
const documentedOptions = (help) =>
  [...new Set([...help.matchAll(/(?<![\w-])--([a-z][\w-]*)/g)].map((match) => match[1]))].filter(
    (name) => name !== 'help',
  );

const requiresArguments = {
  'baseline/data.mjs': /^Missing an argument\./,
  'baseline/plugins.mjs': /^--connection FILE is required\./,
  'baseline/provision.mjs': /^--connection <private connection\.json> is required\./,
  'deployment/configure.mjs': /^Use --environment https:\/\/YOUR-ENVIRONMENT\.crm\.dynamics\.com\./,
};
// Without arguments these run their real (offline) work or start a loopback server.
const runsWithoutArguments = [
  'baseline/generate.mjs',
  'baseline/site.mjs',
  'code-app/mirage.mjs',
  'code-app/server.mjs',
  'editor-workspace.mjs',
];

for (const script of [...Object.keys(requiresArguments), ...runsWithoutArguments])
  test(`${script} prints usage for --help and rejects an unknown option in one line`, () => {
    const help = run(script, ['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage: node \S+\.mjs/);
    assert.equal(help.stderr, '');
    assertOneLineFailure(run(script, ['--bogus']), /^Unknown option --bogus\. Run it with --help for usage\.\n$/);
  });

for (const [script, pattern] of Object.entries(requiresArguments))
  test(`${script} without arguments fails in one line`, () => assertOneLineFailure(run(script, []), pattern));

for (const script of [...Object.keys(requiresArguments), ...runsWithoutArguments]) {
  test(`${script} help lists exactly the options it accepts`, () => {
    assert.deepEqual(
      documentedOptions(run(script, ['--help']).stdout).sort(),
      Object.keys(acceptedOptions(script)).sort(),
    );
  });
  test(`${script} rejects a missing, unexpected or repeated option value before any connection`, () => {
    for (const [name, type] of Object.entries(acceptedOptions(script)))
      if (type === 'string') {
        assertOneLineFailure(run(script, [`--${name}`]), new RegExp(`^--${name} needs a value\\.`));
        assertOneLineFailure(
          run(script, [`--${name}`, 'x', `--${name}`, 'x']),
          new RegExp(`^--${name} may be given only once\\.`),
        );
      } else {
        assertOneLineFailure(run(script, [`--${name}=yes`]), new RegExp(`^--${name} takes no value\\.`));
        assertOneLineFailure(
          run(script, [`--${name}`, `--${name}`]),
          new RegExp(`^--${name} may be given only once\\.`),
        );
      }
  });
}

test('baseline scripts refuse options of another mode before reading a connection', () => {
  const connection = ['--connection', 'private.connection.json'];
  assertOneLineFailure(run('baseline/plugins.mjs', [...connection, '--verify', '--apply']), /^--verify is read-only/);
  for (const option of [connection, ['--apply'], ['--tester', 'contact']])
    assertOneLineFailure(
      run('baseline/data.mjs', ['catalogue', ...option]),
      new RegExp(`^${option[0]} does not apply to catalogue\\.`),
    );
  assertOneLineFailure(
    run('baseline/data.mjs', ['reset', ...connection, '--out', 'catalogue.json']),
    /^--out does not apply to reset\./,
  );
});

test('usage names each script as it is invoked from the working directory', () => {
  for (const [cwd, invoked] of [
    [projectRoot, 'baseline/plugins.mjs'],
    [path.join(projectRoot, 'baseline'), 'plugins.mjs'],
    [path.dirname(projectRoot), `${path.basename(projectRoot)}/baseline/plugins.mjs`],
  ]) {
    const help = run('baseline/plugins.mjs', ['--help'], { cwd });
    assert.equal(help.status, 0, help.stderr);
    assert.ok(help.stdout.startsWith(`Usage: node ${invoked} --connection FILE`), help.stdout);
    assert.ok(help.stdout.includes(`\n       node ${invoked} --connection FILE --verify`), help.stdout);
  }
});

test('baseline plugins help states what each mode reads and writes', () => {
  const help = run('baseline/plugins.mjs', ['--help']).stdout;
  assert.doesNotMatch(help, /Always rewrites/);
  assert.match(help, /plan \(default\) +reads components\/DataversePlugins\/registrations\.json/);
  assert.match(
    help,
    /--verify +reads baseline\/plugins\.json .*\n.*baseline\/plugins-readback\.json; writes nothing to/,
  );
});

test('baseline data rejects an unknown action and reset without a connection in one line', () => {
  assertOneLineFailure(run('baseline/data.mjs', ['restore']), /^Unknown action restore; use reset or catalogue\./);
  assertOneLineFailure(run('baseline/data.mjs', ['reset']), /^reset requires --connection FILE\./);
});

test('baseline data help states per mode which options are required, and reset refuses a missing --tester', () => {
  const help = run('baseline/data.mjs', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /data\.mjs reset --connection FILE --tester CONTACTID \[--apply\]\n/);
  assert.match(help.stdout, /requires --connection and --tester, --apply is optional/);
  assert.match(help.stdout, /--tester +.*\(required by reset\)/);
  assertOneLineFailure(
    run('baseline/data.mjs', ['reset', '--connection', 'private.connection.json']),
    /^reset requires --tester CONTACTID/,
  );
});

test('configure reports a missing PAC executable in one line before any environment call', () => {
  assertOneLineFailure(
    run('deployment/configure.mjs', [
      '--environment',
      'https://invented.crm.dynamics.com',
      '--pac',
      path.join(projectRoot, 'missing-pac.exe'),
    ]),
    /^PAC CLI not found .*; install PAC or pass --pac FILE\./,
  );
});

test('baseline generators reproduce the committed JSON byte for byte', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-baseline-generated-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const generated = run('baseline/generate.mjs', ['--out', directory]);
  assert.equal(generated.status, 0, generated.stderr);
  for (const file of ['dataverse/manifest.json', 'dataverse/extras.json'])
    assert.equal(
      fs.readFileSync(path.join(directory, file), 'utf8'),
      fs.readFileSync(path.join(projectRoot, 'baseline', file), 'utf8'),
      `baseline/${file} is stale: run baseline/generate.mjs and commit the result`,
    );
  const site = run('baseline/site.mjs', ['--out', path.join(directory, 'site')]);
  assert.equal(site.status, 0, site.stderr);
  assert.equal(
    fs.readFileSync(path.join(directory, 'site-manifest.json'), 'utf8'),
    fs.readFileSync(path.join(projectRoot, 'baseline/site-manifest.json'), 'utf8'),
    'baseline/site-manifest.json is stale: run baseline/site.mjs and commit the result',
  );
});
