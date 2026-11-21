// @test-kind contract: every command-line entry point answers --help, rejects bad arguments in one line and never reaches a live call first.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { errorLine, UsageError } from '../cli.mjs';

// hang guard only: a blocked synchronous child cannot be ended by the test runner
const CLI_HANG_GUARD_MS = 170_000;
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Any network call and any read of a connection file fails loudly, so a probe that slipped past argument validation
// can neither reach an environment nor read the real connection. PROBE_OPTIONS prints the options the script hands to
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
const childOptions = (env = {}) => ({
  cwd: project,
  windowsHide: true,
  env: { ...process.env, PAQVILO_PAC_EXECUTABLE: path.join(project, 'missing-pac.exe'), ...env },
});
const run = (script, args, env) =>
  spawnSync(process.execPath, ['--import', offline, path.join(project, script), ...args], {
    ...childOptions(env),
    encoding: 'utf8',
    timeout: CLI_HANG_GUARD_MS,
  });
// The asynchronous form lets one test run a tool's cases side by side.
const runAsync = (script, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', offline, path.join(project, script), ...args], childOptions());
    const result = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8').on('data', (text) => (result.stdout += text));
    child.stderr.setEncoding('utf8').on('data', (text) => (result.stderr += text));
    child.on('error', reject);
    child.on('close', (status) => resolve({ ...result, status }));
  });

// Entry points whose run without arguments is an argument error.
const requiresArguments = [
  'portal-security/deploy.mjs',
  'portal-security/deep-variant.mjs',
  'portal-security/package.mjs',
  'portal-security/role-variant.mjs',
  'portal-security/bind-tester.mjs',
  'portal-security/odata-permission-diagnostic.mjs',
  'portal-security/permission-order-plan.mjs',
  'portal-security/qualification-plan.mjs',
  'portal-harness/compare-parity.mjs',
  'portal-harness/replay-parity.mjs',
  'portal-harness/mirage-campaign-replay.mjs',
  'portal-harness/mirage-replay-shards.mjs',
  'portal-harness/native-campaign.mjs',
  'portal-harness/native-batch-prototype.mjs',
  'portal-harness/native-prototype.mjs',
  'portal-harness/deploy.mjs',
  'forms/deploy.mjs',
  'forms/import-quickfind.mjs',
  'data/reconcile-seed-headers.mjs',
];
// Entry points whose run without arguments is the real (offline or live) command.
const runsWithoutArguments = [
  'prepare-schema.mjs',
  'prepare-data.mjs',
  'prepare-stress-data.mjs',
  'portal-harness/compile.mjs',
  'plugins/prepare-registration.mjs',
  'plugins/deploy.mjs',
  'plugins/verify-live.mjs',
  'plugins/audit-installation.mjs',
  'plugins/audit-evidence.mjs',
  'plugins/inspect-metadata.mjs',
  'plugins/inspect-operation-errors.mjs',
  'plugins/inspect-trace.mjs',
  'plugins/provision-owner-team.mjs',
  'plugins/update-guard-config.mjs',
  'plugins/upload-assemblies.mjs',
];

function assertOneLineFailure(result, pattern) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^[^\n]+\n$/, 'one line on stderr');
  assert.doesNotMatch(result.stderr, /\n\s+at |ERR_PARSE_ARGS|NETWORK BLOCKED|CONNECTION READ BLOCKED/);
  assert.match(result.stderr, pattern);
}

// The options a script accepts, read from the configuration it passes to parseArgs (help is added by cli.mjs).
function acceptedOptions(script) {
  const probe = run(script, [], { PROBE_OPTIONS: '1' });
  assert.equal(probe.status, 0, probe.stderr);
  const { help, ...options } = JSON.parse(probe.stdout);
  assert.equal(help, 'boolean');
  return options;
}
const documentedOptions = (help) =>
  [...new Set([...help.matchAll(/(?<![\w-])--([a-z][\w-]*)/g)].map((match) => match[1]))].filter(
    (name) => name !== 'help',
  );

for (const script of [...requiresArguments, ...runsWithoutArguments]) {
  test(`${script} prints usage for --help and rejects an unknown option in one line`, () => {
    const help = run(script, ['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage: node \S+\.mjs/);
    assert.equal(help.stderr, '');
    assertOneLineFailure(run(script, ['--bogus']), /^Unknown option --bogus\. Run it with --help for usage\.\n$/);
  });
}

for (const script of requiresArguments)
  test(`${script} without arguments fails in one line`, () => {
    assertOneLineFailure(run(script, []), /Run it with --help for usage\.\n$/);
  });

const site = '11111111-2222-3333-4444-555555555555';
const contact = '99999999-8888-7777-6666-555555555555';
// Under a .paqvilo segment so path confinement passes; never created.
const privateFile = path.join(os.tmpdir(), 'paqvilo-cli-test', '.paqvilo', 'private.json');
const tester = ['--contact', contact, '--site', site];
const roleCountOnly = /^--role-count applies only to --mode roles\./;
const managedResetOnly = /^--allow-managed-reset applies only to --mode baseline or stress\./;
// Option combinations each tool's usage rules out: an option of another mode, a missing selector, an invalid value.
// Every one must fail during argument validation, before a connection file is read or the network is touched.
const refused = {
  'portal-security/bind-tester.mjs': [
    [[...tester, '--role-count', '4'], roleCountOnly],
    [[...tester, '--mode', 'baseline', '--role-count', '4'], roleCountOnly],
    [[...tester, '--mode', 'stress', '--role-count', '4'], roleCountOnly],
    [[...tester, '--mode', 'reset', '--role-count', '12'], roleCountOnly],
    [[...tester, '--mode', 'roles'], /^--mode roles requires --role-count/],
    [[...tester, '--mode', 'roles', '--role-count', '3'], /^--mode roles requires --role-count/],
    [[...tester, '--mode', 'roles', '--role-count', '4', '--allow-managed-reset'], managedResetOnly],
    [[...tester, '--mode', 'reset', '--allow-managed-reset'], managedResetOnly],
    [[...tester, '--mode', 'other'], /^Select --mode/],
    [['--contact', contact, '--site', 'site'], /^Select --mode/],
    [['--site', site, '--apply'], /^Select --mode/],
    [[...tester, '--out', 'evidence'], /stay under ignored \.paqvilo/],
  ],
  'portal-security/deep-variant.mjs': [
    [['--site', site], /requires explicit --apply/],
    [['--apply'], /^Provide --site GUID/],
    [['--site', site, '--apply', '--timeout-seconds', '5'], /^Provide --site GUID/],
    [['--site', site, '--apply', '--out', 'journals'], /^Provide --site GUID/],
    [
      ['--site', site, '--apply', '--restore-journal', privateFile, '--timeout-seconds', '60'],
      /^--timeout-seconds applies only to a new lease/,
    ],
    [
      ['--site', site, '--apply', '--restore-journal', privateFile, '--out', path.dirname(privateFile)],
      /^--out applies only to a new lease/,
    ],
    [['--site', site, '--apply', '--restore-journal', 'journal.json'], /must stay in ignored \.paqvilo/],
  ],
  'portal-security/package.mjs': [
    [['--site', site, '--export'], /^--export requires --apply/],
    [['--apply'], /^--site GUID required/],
    [['--site', 'site', '--apply'], /^--site GUID required/],
  ],
  'portal-security/role-variant.mjs': [
    [['--apply'], /^--role-count is required/],
    [['--role-count', '3', '--apply'], /^--role-count is required/],
  ],
  'portal-security/deploy.mjs': [
    [['--site', site, '--catalogue', 'data/catalogue.json', '--variant', 'parent-only'], /^Unknown option --variant\./],
    [['--catalogue', 'data/catalogue.json', '--apply'], /^--site requires a canonical GUID/],
    [['--site', site, '--apply'], /^--catalogue FILE is required/],
    [['--site', site, '--catalogue', 'data/catalogue.json', '--connection', ''], /^--connection must not be empty/],
  ],
  'portal-security/qualification-plan.mjs': [
    [['--out', privateFile], /^Provide the exact deployed harness --manifest/],
    [['--manifest', 'manifest.json', '--out', 'plan.json'], /under ignored \.paqvilo/],
  ],
  'prepare-schema.mjs': [
    [['--cohort', 'source6'], /^Expected --cohort source4 or source5/],
    [['--cohort', 'source5'], /separate --out file/],
  ],
  'portal-harness/mirage-replay-shards.mjs': [
    [['--job', 'job.json'], /--workers 1\.\.10 are required/],
    [['--job', 'job.json', '--workers', '11'], /--workers 1\.\.10 are required/],
    [['--workers', '2'], /--workers 1\.\.10 are required/],
  ],
  'portal-harness/compare-parity.mjs': [[['a.json'], /^Missing an argument/]],
  'portal-harness/deploy.mjs': [[['config.json'], /^Unexpected argument config\.json/]],
  'forms/deploy.mjs': [[['--apply'], /^--connection FILE is required/]],
  'forms/import-quickfind.mjs': [[['--resume', 'journal.json'], /^--connection FILE is required/]],
};

for (const [script, cases] of Object.entries(refused))
  test(`${script} refuses options its usage rules out before reading a connection or the network`, async () => {
    for (const [index, result] of (await Promise.all(cases.map(([args]) => runAsync(script, args)))).entries())
      assertOneLineFailure(result, cases[index][1]);
  });

for (const script of [...requiresArguments, ...runsWithoutArguments]) {
  test(`${script} help lists exactly the options it accepts`, () => {
    assert.deepEqual(
      documentedOptions(run(script, ['--help']).stdout).sort(),
      Object.keys(acceptedOptions(script)).sort(),
    );
  });
  test(`${script} rejects a missing, unexpected or repeated option value before any connection`, async () => {
    const cases = Object.entries(acceptedOptions(script)).flatMap(([name, type]) =>
      type === 'string'
        ? [
            [[`--${name}`], new RegExp(`^--${name} needs a value\\.`)],
            [[`--${name}`, 'x', `--${name}`, 'x'], new RegExp(`^--${name} may be given only once\\.`)],
          ]
        : [
            [[`--${name}=yes`], new RegExp(`^--${name} takes no value\\.`)],
            [[`--${name}`, `--${name}`], new RegExp(`^--${name} may be given only once\\.`)],
          ],
    );
    for (const [index, result] of (await Promise.all(cases.map(([args]) => runAsync(script, args)))).entries())
      assertOneLineFailure(result, cases[index][1]);
  });
}

test('every --connection help entry continues under its description column', () => {
  let checked = 0;
  for (const script of [...requiresArguments, ...runsWithoutArguments]) {
    const lines = run(script, ['--help']).stdout.split('\n');
    const index = lines.findIndex((line) => /^ {2}--connection FILE +connection with organisationId/.test(line));
    if (index < 0) continue;
    const column = lines[index].indexOf('connection with');
    for (const line of lines.slice(index + 1, index + 3)) assert.match(line, new RegExp(`^ {${column}}\\S`), script);
    checked++;
  }
  assert.ok(checked >= 15, `${checked} helps checked`);
});

test('bind-tester help names the default evidence folder exactly', () => {
  assert.match(
    run('portal-security/bind-tester.mjs', ['--help']).stdout,
    /\.paqvilo\/portal-security\/tester-<first 8 characters of --contact>/,
  );
});

test('qualification-plan names the expected manifest when given the Dataverse schema manifest', () => {
  assertOneLineFailure(
    run('portal-security/qualification-plan.mjs', ['--manifest', 'dataverse/manifest.json', '--out', privateFile]),
    /^Expected a harness manifest \(with cases\), not the Dataverse schema manifest: use the manifest\.json that portal-harness\/compile\.mjs writes/,
  );
});

test('documented argument failures are one line', () => {
  assertOneLineFailure(
    run('portal-security/deploy.mjs', ['--site', '11111111-2222-3333-4444-555555555555']),
    /^--catalogue FILE is required/,
  );
  assertOneLineFailure(run('prepare-schema.mjs', ['--cohort', 'source5']), /separate --out file/);
  assertOneLineFailure(run('portal-security/deploy.mjs', ['--site']), /^--site needs a value\./);
  assertOneLineFailure(run('portal-harness/replay-parity.mjs', ['a.json', 'b.json']), /^Unexpected argument b\.json\./);
  assertOneLineFailure(run('plugins/deploy.mjs', ['--apply', '--apply']), /^--apply may be given only once\./);
});

test('error lines translate parser and file errors and keep the first line of others', () => {
  assert.equal(
    errorLine(
      Object.assign(new Error("Option '--out <value>' argument missing"), {
        code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
      }),
    ),
    '--out needs a value. Run it with --help for usage.',
  );
  assert.equal(
    errorLine(
      Object.assign(new Error("Option '--apply' does not take an argument"), {
        code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
      }),
    ),
    '--apply takes no value. Run it with --help for usage.',
  );
  assert.equal(
    errorLine(
      Object.assign(new Error("ENOENT: no such file or directory, open 'x.json'"), { code: 'ENOENT', path: 'x.json' }),
    ),
    'File not found: x.json. Check the path.',
  );
  assert.equal(
    errorLine(new UsageError('--site GUID required.')),
    '--site GUID required. Run it with --help for usage.',
  );
  assert.equal(errorLine(new Error('first\n    at stack')), 'first');
});
