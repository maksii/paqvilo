// @test-kind tooling: documented contributor scripts answer --help and refuse unknown options in one line before any side effect
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { main as parityCases } from '../scripts/parity-cases.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (script, args, env = {}) => {
  const childEnv = { ...process.env, ...env };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete childEnv[name];
  return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: childEnv,
  });
};
const oneLine = (text) => assert.equal(text.trim().split('\n').length, 1, text);
const noStack = (text) => assert.doesNotMatch(text, /\n\s+at |ERR_PARSE_ARGS|ENOENT|node:internal/);

// Each entry: script, a line its help must contain, and the exit code of an unknown option.
const scripts = [
  ['check-test-tags.mjs', /--base <rev>[\s\S]*--event[\s\S]*--report[\s\S]*<file\.\.\.>/, 1],
  ['code-review.mjs', /--check[\s\S]*--write-baseline/, 1],
  ['benchmark-xray.mjs', /--samples <n>[\s\S]*--strict[\s\S]*--json/, 1],
  ['github-admin.mjs', /--apply/, 1],
  [
    'ci.mjs',
    /verify[\s\S]*prepare[\s\S]*fixtures[\s\S]*sdk[\s\S]*sdk-prepare[\s\S]*browser[\s\S]*--suite[\s\S]*--unit[\s\S]*--browser[\s\S]*--shard[\s\S]*--full[\s\S]*--base[\s\S]*--prepared[\s\S]*--quality[\s\S]*--sdk/,
    1,
  ],
  ['audit-dependencies.mjs', /scripts\/dependency-risk-acceptance\.json\. Takes no options/, 1],
  ['ensure-dependencies.mjs', /--check[\s\S]*--json[\s\S]*--browser/, 1],
  ['generate-compat-watchers.mjs', /--check/, 1],
  ['conventional-commit.mjs', /--file <path>[\s\S]*--title/, 1],
  ['project-boundary.mjs', /Takes no options/, 1],
  ['sonar-rules.mjs', /--base <rev>/, 2],
  ['check-workflows.mjs', /--cache-key[\s\S]*--provision/, 1],
  ['release-check.mjs', /Takes no options/, 1],
  ['codeql.mjs', /Takes no options/, 1],
];

for (const [script, usage, unknownExit] of scripts) {
  test(`${script} --help prints usage and an unknown option is one line`, () => {
    const help = run(script, ['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /^Usage: /);
    assert.match(help.stdout, usage);
    assert.equal(help.stderr, '');
    // ci.mjs: the read-only fixtures command answers before the workspace lease; verify would revoke a real receipt.
    const unknown = run(script, script === 'ci.mjs' ? ['fixtures', '--no-such-option'] : ['--no-such-option']);
    assert.equal(unknown.status, unknownExit, unknown.stdout + unknown.stderr);
    oneLine(unknown.stderr);
    noStack(unknown.stderr);
    assert.match(unknown.stderr, /--no-such-option|Use: /);
  });
}

test('github-admin --help prints usage, not the settings plan', () => {
  const help = run('github-admin.mjs', ['--apply', '--help']);
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /"protection"|"settings"/);
});

test('ci.mjs without a known command names every command in one line', () => {
  const result = run('ci.mjs', ['bogus']);
  assert.equal(result.status, 1);
  oneLine(result.stderr);
  assert.match(result.stderr, /prepare, verify, fixtures, sdk, sdk-prepare, browser/);
});

test('check-test-tags refuses --base without a revision, --event without an event, and missing files in one line', () => {
  const base = run('check-test-tags.mjs', ['--base']);
  assert.equal(base.status, 1);
  assert.match(base.stderr, /--base needs a revision/);
  const event = run('check-test-tags.mjs', ['--event'], { GITHUB_EVENT_PATH: undefined });
  assert.equal(event.status, 1);
  assert.match(event.stderr, /GITHUB_EVENT_PATH/);
  const missingEvent = run('check-test-tags.mjs', ['--event'], { GITHUB_EVENT_PATH: 'test/no-such-event.json' });
  assert.equal(missingEvent.status, 1);
  assert.match(missingEvent.stderr, /file not found/);
  const missing = run('check-test-tags.mjs', ['test/no-such-file.test.mjs']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /file not found: test\/no-such-file\.test\.mjs/);
  assert.equal(missing.stdout, '');
  const badRevision = run('check-test-tags.mjs', ['--base', 'invented-missing-revision']);
  assert.equal(badRevision.status, 1);
  for (const result of [base, event, missingEvent, missing, badRevision]) {
    oneLine(result.stderr);
    noStack(result.stderr);
  }
});

test('conventional-commit --file names a missing file in one line', () => {
  const result = run('conventional-commit.mjs', ['--file', 'test/no-such-message.txt']);
  assert.equal(result.status, 1);
  oneLine(result.stderr);
  assert.match(result.stderr, /--file test\/no-such-message\.txt: file not found/);
  noStack(result.stderr);
});

test('conventional-commit refuses an extra argument and --title without PR_TITLE in one line', () => {
  const extra = run('conventional-commit.mjs', ['--title', 'feat: invented title'], { PR_TITLE: 'fix: invented' });
  assert.match(extra.stderr, /Unexpected argument feat: invented title; --title takes no value/);
  const unset = run('conventional-commit.mjs', ['--title'], { PR_TITLE: undefined });
  assert.match(unset.stderr, /--title checks the PR_TITLE environment variable, which is not set/);
  for (const result of [extra, unset]) {
    assert.equal(result.status, 1);
    oneLine(result.stderr);
    noStack(result.stderr);
  }
});

// @test-kind security: an extra argument can never turn the dependency audit into a successful help exit
test('audit-dependencies prints help only for a sole --help or -h and refuses any other argument list', () => {
  for (const flag of ['--help', '-h']) {
    const help = run('audit-dependencies.mjs', [flag]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: /);
  }
  for (const args of [
    ['--help', '--no-such-option'],
    ['--no-such-option', '--help'],
    ['-h', 'extra'],
    ['--help', '--help'],
  ]) {
    const result = run('audit-dependencies.mjs', args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
    assert.match(result.stderr, /unexpected arguments .*; it takes no options/);
    oneLine(result.stderr);
    noStack(result.stderr);
  }
});

test('a repeated single-value option is refused before any side effect', () => {
  const ci = run('ci.mjs', ['fixtures', '--suite', 'mirage', '--suite', 'lense']);
  const pr = run('pr-readiness.mjs', ['--pr', '1', '--pr', '2']);
  const parity = run('parity-cases.mjs', ['report', '--json', '--surface', 'a', '--surface', 'b']);
  const benchmark = run('benchmark.mjs', ['--samples', '2', '--samples', '3']);
  const xray = run('benchmark-xray.mjs', ['--samples', '1', '--samples', '2']);
  assert.match(ci.stderr, /--suite may be given only once/);
  assert.match(pr.stderr, /--pr may be given only once/);
  assert.match(parity.stderr, /--surface may be given only once/);
  assert.equal(benchmark.stderr, 'benchmark: --samples may be given only once\n');
  assert.equal(xray.stderr, 'benchmark-xray: --samples may be given only once\n');
  for (const result of [ci, pr, parity, benchmark, xray]) {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    oneLine(result.stderr);
    noStack(result.stderr);
  }
});

test('parity-cases build names a missing --capture file and its path in one line', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-parity-capture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let stderr = '';
  const code = await parityCases(
    [
      'build',
      '--surface',
      'invented',
      '--suite',
      'missing-capture',
      '--oracle-kind',
      'native',
      '--oracle-name',
      'invented',
      '--oracle-version',
      '1',
      '--oracle-scope',
      'invented scope',
      '--capture',
      'missing.json',
      '--capture',
      'missing-2.json',
      '--out',
      path.join(directory, 'out.json'),
    ],
    { stdout: { write() {} }, stderr: { write: (text) => (stderr += text) }, cwd: directory },
  );
  assert.equal(code, 1);
  assert.equal(
    stderr,
    `parity-cases: --capture missing.json: file not found (${path.join(directory, 'missing.json')})\n`,
  );
  assert.equal(fs.existsSync(path.join(directory, 'out.json')), false);
});

// Every scripts/*.mjs is an entry point unless listed here as a module that only other code imports.
const MODULES = new Map([
  ['audit-observer.mjs', 'npm preload that audit-process.mjs loads with --import under its IPC parent'],
  ['audit-process.mjs', 'npm audit runner imported by audit-dependencies.mjs'],
  ['audit-progress.mjs', 'audit progress guard imported by audit-process.mjs'],
  ['ci-workspace-lease.mjs', 'workspace lease imported by ci.mjs'],
  ['code-review.config.mjs', 'configuration imported by code-review.mjs'],
  ['consumer-tool-smoke.mjs', 'installed-tool checks imported by package-smoke.mjs'],
  ['dependency-risk-acceptance.mjs', 'risk acceptance data imported by audit-dependencies.mjs'],
  ['npm-cli.mjs', 'npm CLI path helper imported by other scripts'],
  ['npm-pack.mjs', 'npm pack result reader imported by other scripts'],
  ['package-dependency-evidence.mjs', 'lockfile comparison imported by package-smoke.mjs'],
  ['script-help.mjs', 'the shared --help helper the entry points import'],
  ['sdk-preparation.mjs', 'SDK fixture preparation imported by ci.mjs'],
  ['smoke-npm.mjs', 'npm runner imported by the smoke scripts'],
  ['smoke-process.mjs', 'child-process guard imported by the smoke scripts'],
  ['trusted-git.mjs', 'Git executable resolver imported by other scripts'],
  ['verified-download.mjs', 'verified archive download imported by ci.mjs'],
]);
const entryPoints = fs
  .readdirSync(path.join(root, 'scripts'))
  .filter((name) => name.endsWith('.mjs') && !MODULES.has(name))
  .sort();

test('every module exemption names an existing script without a main guard', () => {
  for (const name of MODULES.keys()) {
    const source = fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
    assert.doesNotMatch(source, /path\.resolve\(process\.argv\[1\]\)|pathToFileURL\(process\.argv\[1\]\)/, name);
  }
});

// A private checkout: copied scripts and links to the rest, so a script that does real work on --help writes into
// this directory (dist/, .paqvilo/, scripts/) where the listing sees it, never into the shared checkout.
function privateCheckout(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-script-help-'));
  const checkout = path.join(directory, 'checkout');
  const cwd = path.join(directory, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  fs.cpSync(path.join(root, 'scripts'), path.join(checkout, 'scripts'), { recursive: true });
  const links = [];
  const directories = ['.github', 'bin', 'docs', 'examples', 'lense', 'licenses', 'mirage', 'node_modules', 'site'];
  for (const name of [...directories, 'templates', 'test', 'test-browser']) {
    if (!fs.existsSync(path.join(root, name))) continue;
    links.push(path.join(checkout, name));
    fs.symlinkSync(path.join(root, name), links.at(-1), 'junction');
  }
  for (const name of ['package.json', 'package-lock.json', '.node-version', 'sonar-project.properties'])
    if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(checkout, name));
  t.after(() => {
    // Remove the links first so removal never reaches the shared checkout.
    for (const link of links) fs.unlinkSync(link);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { checkout, cwd };
}

function listing(directory) {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const stat = fs.lstatSync(file);
      entries.push(`${path.relative(directory, file)} ${stat.size} ${stat.mtimeMs}`);
      if (entry.isDirectory() && !stat.isSymbolicLink()) walk(file);
    }
  };
  walk(directory);
  return entries.sort();
}

const runAsync = async (file, args, cwd) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [file, ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, SONAR_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
};

for (const script of entryPoints) {
  test(`${script} answers --help and -h with usage and refuses an unknown option, with no side effects`, async (t) => {
    const { checkout, cwd } = privateCheckout(t);
    const before = { checkout: listing(checkout), cwd: listing(cwd) };
    const file = path.join(checkout, 'scripts', script);
    const unknownArgs = script === 'ci.mjs' ? ['fixtures', '--no-such-option'] : ['--no-such-option'];
    const [help, short, unknown] = await Promise.all([
      runAsync(file, ['--help'], cwd),
      runAsync(file, ['-h'], cwd),
      runAsync(file, unknownArgs, cwd),
    ]);
    for (const result of [help, short]) {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /usage/i);
      assert.equal(result.stderr, '');
    }
    assert.notEqual(unknown.status, 0, unknown.stdout + unknown.stderr);
    assert.match(unknown.stdout + unknown.stderr, /--no-such-option/);
    if (unknown.stderr) oneLine(unknown.stderr);
    noStack(unknown.stdout + unknown.stderr);
    assert.deepEqual({ checkout: listing(checkout), cwd: listing(cwd) }, before);
  });
}

// Run directly, an import-only module does no work: it prints nothing, or one line saying what to run instead.
for (const script of MODULES.keys()) {
  test(`${script} run directly prints no stack trace and has no side effects`, async (t) => {
    const { checkout, cwd } = privateCheckout(t);
    const before = { checkout: listing(checkout), cwd: listing(cwd) };
    const result = await runAsync(path.join(checkout, 'scripts', script), ['--help'], cwd);
    const output = result.stdout + result.stderr;
    noStack(output);
    if (output.trim()) oneLine(output);
    if (script === 'audit-observer.mjs') {
      assert.equal(result.status, 1);
      assert.equal(
        result.stderr,
        'audit-observer.mjs is not an entry point: scripts/audit-process.mjs loads it into npm with --import. Run npm run audit:dependencies instead.\n',
      );
    }
    assert.deepEqual({ checkout: listing(checkout), cwd: listing(cwd) }, before);
  });
}
