// @test-kind tooling: the local SonarQube rule approximation on an invented Git repository fixture
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTemporaryDirectorySync, removeFixtureDirectory } from '../mirage/testing/owned-fixture.mjs';

const script = fileURLToPath(new URL('../scripts/sonar-rules.mjs', import.meta.url));

function gitFixture(t) {
  const directory = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paq-sonar-rules-'));
  t.after(() => removeFixtureDirectory(directory));
  const globalConfig = path.join(directory, 'gitconfig'),
    repository = path.join(directory, 'repository');
  fs.writeFileSync(globalConfig, '');
  fs.mkdirSync(repository);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !name.startsWith('GIT_CONFIG_')) delete env[name];
  delete env.NODE_TEST_CONTEXT;
  const git = (...args) => {
    const result = spawnSync(
      'git', // NOSONAR: the fixture runs the contributor's Git, as the script under test does
      ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
      { cwd: repository, env, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
    fs.writeFileSync(path.join(repository, file), text);
  };
  const commit = (message) => {
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', message);
  };
  // Runs the script in the fixture repository; each run is its own process, as validation runs it.
  const reported = async (base, files) => {
    const child = spawn(process.execPath, [script, '--base', base], { cwd: repository, env, windowsHide: true });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const [status] = await once(child, 'close');
    const lines = stdout.trim().split(/\r?\n/);
    const summary = lines.findIndex((line) => line.includes('changed JavaScript file(s)'));
    assert.match(lines[summary] ?? '', new RegExp(String.raw`^${files} changed JavaScript file\(s\)`), stdout + stderr);
    const findings = lines.slice(0, summary).map((line) => line.split(' ').slice(0, 2).join(' '));
    assert.equal(status, findings.length ? 1 : 0, stderr);
    return findings;
  };
  git('init', '-q');
  return { git, write, commit, reported };
}

test('only findings the working tree adds are reported, NOSONAR lines excepted, new files whole', async (t) => {
  const { write, commit, reported } = gitFixture(t);
  write('README.md', 'Fixture\n');
  commit('empty');
  write('lib/numbers.mjs', 'export const kept = isNaN(1);\nexport const moved = isFinite(2);\n');
  commit('base');
  write(
    'lib/numbers.mjs',
    [
      'export const kept = isNaN(1);',
      'export const added = isNaN(3);',
      'export const quiet = isFinite(4); // NOSONAR: fixture keeps the global on purpose',
      'export const moved = isFinite(2);',
      '',
    ].join('\n'),
  );
  write('lib/fresh.mjs', 'export const fresh = isNaN(5);\nPromise.resolve(6);\n');
  const untracked = [
    'lib/fresh.mjs:1 unicorn/prefer-number-properties',
    'lib/fresh.mjs:2 @typescript-eslint/no-floating-promises',
  ];

  assert.deepEqual(await reported('HEAD', 2), [...untracked, 'lib/numbers.mjs:2 unicorn/prefer-number-properties']);
  assert.deepEqual(
    await reported('HEAD~1', 2),
    [
      ...untracked,
      'lib/numbers.mjs:1 unicorn/prefer-number-properties',
      'lib/numbers.mjs:2 unicorn/prefer-number-properties',
      'lib/numbers.mjs:4 unicorn/prefer-number-properties',
    ],
    'against a base without the file, the kept and moved lines are findings too',
  );
});

test('test files get only test-scope sonarjs rules, sources the main ones, and an unchanged rename is skipped', async (t) => {
  const { git, write, commit, reported } = gitFixture(t);
  write('lib/old.mjs', 'export const old = isNaN(1);\n');
  commit('base');
  git('mv', 'lib/old.mjs', 'lib/renamed.mjs');
  // Six nested conditions exceed the cognitive complexity limit of 15.
  const tangled = [
    'export function tangled(a) {',
    '  if (a > 0) { if (a > 1) { if (a > 2) { if (a > 3) { if (a > 4) { if (a > 5) return a; } } } } }',
    '  return 0;',
    '}',
  ].join('\n');
  write('lib/tangled.mjs', `${tangled}\n`);
  write(
    'test/scope.test.mjs',
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      tangled,
      'export const n = isNaN(1);',
      "test('asserts', () => assert.equal(tangled(0), 0));",
      "test('asserts', () => assert.equal(tangled(1), 0));",
      '',
    ].join('\n'),
  );

  // The unchanged rename is not counted. sonar-project.properties ignores the empty-test-file rule on this one
  // file only.
  const empty = "import test from 'node:test';\nexport const none = test;\n";
  write('mirage/test/parity-replay.test.mjs', empty);
  write('test/empty.test.mjs', empty);

  assert.deepEqual(await reported('HEAD', 4), [
    'lib/tangled.mjs:1 sonarjs/cognitive-complexity',
    'test/empty.test.mjs:0 sonarjs/no-empty-test-file',
    'test/scope.test.mjs:9 sonarjs/no-duplicate-test-title',
  ]);
});

test('the excluded assertions-in-tests rule is not applied to test files', async (t) => {
  const { write, commit, reported } = gitFixture(t);
  write('README.md', 'Fixture\n');
  commit('base');
  // The assertion is made inside a helper, which the ESLint version of the rule cannot follow.
  write(
    'test/helper.test.mjs',
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      'const expectOne = (value) => assert.equal(value, 1);',
      "test('asserts through a helper', () => {",
      '  expectOne(1);',
      '});',
      '',
    ].join('\n'),
  );

  assert.deepEqual(await reported('HEAD', 1), []);
});
