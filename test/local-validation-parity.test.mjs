// @test-kind tooling: local validation steps and the hosted CI wiring they mirror, on repository scripts only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { classifyChanges } from '../.github/scripts/change-scope.mjs';
import {
  changedTests,
  localBrowserChannels,
  runSteps,
  runnerTemporaryDirectory,
  unpushedFiles,
  validationRepeat,
  validationSteps,
} from '../scripts/ci.mjs';
import {
  CODEQL_BUNDLE,
  codeqlLanguages,
  dismissedKeys,
  securitySuite,
  undismissedResults,
} from '../scripts/codeql.mjs';

const local = {};
const steps = (scope, suites, options = {}, platform = 'win32') =>
  validationSteps(scope, suites, { env: local, ...options }, platform);
const labels = (list) => list.map((step) => step.label);

test('local Windows validation runs every hosted browser channel of each lane, Linux only Chromium', () => {
  assert.deepEqual(localBrowserChannels('win32'), ['chromium', 'msedge']);
  assert.deepEqual(localBrowserChannels('linux'), ['chromium']);
  const scope = classifyChanges([], { full: true });
  const windows = steps(scope, ['mirage', 'lense', 'examples']);
  for (const suite of ['mirage', 'lense']) {
    const chromium = windows.find((step) => step.label === `${suite} browser`);
    const edge = windows.find((step) => step.label === `${suite} browser msedge`);
    assert.deepEqual(chromium.commands[0].env, { PAQ_CI_BROWSER: 'chromium' });
    assert.deepEqual(edge.commands[0].env, { PAQ_CI_BROWSER: 'msedge' });
    assert.deepEqual(edge.commands[0].args, ['scripts/ci.mjs', 'verify', '--suite', suite, '--browser', '--prepared']);
  }
  // The examples share one installed project, so Edge runs after Chromium inside the same ordered step.
  const examples = windows.find((step) => step.label === 'examples');
  assert.deepEqual(
    examples.commands.map((command) => [command.args.slice(3).join(' '), command.env.PAQ_CI_BROWSER]),
    [
      ['examples --unit --prepared', 'chromium'],
      ['examples --browser --prepared', 'chromium'],
      ['examples --browser --prepared', 'msedge'],
    ],
  );
  const linux = steps(scope, ['mirage', 'lense', 'examples'], {}, 'linux');
  assert.equal(
    labels(linux).some((label) => label.includes('msedge')),
    false,
  );
  assert.equal(linux.find((step) => step.label === 'examples').commands.length, 2);
});

test('local unit lanes run under Node coverage as the hosted SonarQube lanes do; browser and hosted lanes do not', () => {
  const changed = ['test/local-validation-parity.test.mjs'];
  const scope = classifyChanges([], { full: true });
  const covered = (list) =>
    list.flatMap((step) =>
      step.commands
        .filter((command) => command.coverage)
        .map((command) =>
          command.args[0] === 'scripts/ci.mjs'
            ? command.args.slice(3, 5).join(' ')
            : command.args.at(-1).replaceAll('\\', '/'),
        ),
    );
  const all = ['mirage', 'lense', 'examples'];
  assert.deepEqual(covered(steps(scope, all, { changed, repeat: 1 })), [
    'mirage --unit',
    'lense --unit',
    'test/local-validation-parity.test.mjs',
    'examples --unit',
  ]);
  assert.deepEqual(covered(steps(scope, all, { changed, repeat: 1, env: { GITHUB_ACTIONS: 'true' } })), []);
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(JSON.stringify(ci).includes('NODE_V8_COVERAGE'), false, 'hosted CI lanes keep the plain mode');
});

test('a coverage command gets its own directory under the run folder, never the caller value, removed on failure', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-ci-coverage-'));
  ownedFixture(t).remove(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const record = path.join(directory, 'record.mjs');
  fs.writeFileSync(
    record,
    `import fs from 'node:fs'; const value = process.env.NODE_V8_COVERAGE ?? ''; fs.appendFileSync(${JSON.stringify(path.join(directory, 'seen.txt'))}, value + '|' + (value && fs.existsSync(value)) + String.fromCharCode(10)); process.exitCode = Number(process.argv[2]);`,
  );
  const caller = path.join(directory, 'caller-coverage');
  const inherited = process.env.NODE_V8_COVERAGE;
  process.env.NODE_V8_COVERAGE = caller;
  t.after(() => {
    if (inherited === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = inherited;
  });
  const logs = path.join(directory, 'run', 'logs');
  await assert.rejects(
    runSteps(
      [
        {
          label: 'unit',
          commands: [
            { args: [record, '0'], coverage: true },
            { args: [record, '1'], coverage: true },
          ],
        },
        { label: 'plain', commands: [[record, '0']] },
      ],
      1,
      { cwd: directory, logs },
    ),
    /Validation failed: unit\./,
  );
  const seen = fs
    .readFileSync(path.join(directory, 'seen.txt'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split('|'));
  assert.equal(seen.length, 3);
  for (const [value, existed] of seen.slice(0, 2)) {
    assert.equal(path.dirname(value), path.join(directory, 'run'), 'inside the run folder');
    assert.equal(existed, 'true', 'the directory exists while the command runs');
    assert.equal(fs.existsSync(value), false, 'and is gone when it ends, also after a failure');
  }
  assert.notEqual(seen[0][0], seen[1][0], 'each command has a directory of its own');
  assert.deepEqual(seen[2], [caller, 'false'], 'a plain command is left as the caller started it');
  assert.deepEqual(fs.readdirSync(path.join(directory, 'run')), []);
});

test('a coverage run first removes the coverage directories earlier runs left behind, and nothing else', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-ci-coverage-leftover-'));
  ownedFixture(t).remove(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const earlier = path.join(directory, '.paqvilo', 'ci', 'runs', 'run-1-interrupted');
  fs.mkdirSync(path.join(earlier, 'v8-coverage-left'), { recursive: true });
  fs.writeFileSync(path.join(earlier, 'v8-coverage-left', 'coverage-1.json'), '{}');
  fs.mkdirSync(path.join(earlier, 'logs'));
  fs.writeFileSync(path.join(earlier, 'logs', 'unit.log'), 'evidence');
  await runSteps([{ label: 'plain', commands: [['-e', '']] }], 1, { cwd: directory });
  assert.equal(fs.existsSync(path.join(earlier, 'v8-coverage-left')), true, 'a run without coverage leaves them');
  await runSteps([{ label: 'unit', commands: [{ args: ['-e', ''], coverage: true }] }], 1, { cwd: directory });
  assert.deepEqual(fs.readdirSync(earlier), ['logs'], 'the leftover is gone, the earlier logs stay');
  assert.equal(fs.readFileSync(path.join(earlier, 'logs', 'unit.log'), 'utf8'), 'evidence');
});

test('a coverage directory that cannot be removed is left to the next run and does not fail a passed lane', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-ci-coverage-busy-'));
  ownedFixture(t).remove(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const attempts = [];
  const busy = (target) => {
    attempts.push(target);
    throw Object.assign(new Error('Invented busy directory'), { code: 'EBUSY' });
  };
  const lane = [{ label: 'unit', commands: [{ args: ['-e', ''], coverage: true }] }];
  await runSteps(lane, 1, { cwd: directory, removeDirectory: busy });
  assert.equal(attempts.length, 1);
  assert.equal(fs.existsSync(attempts[0]), true, 'the directory stays for the next run');
  await runSteps(lane, 1, { cwd: directory });
  assert.equal(fs.existsSync(attempts[0]), false, 'the next coverage run removes it');
});

test('local validation runs the Security workflow CodeQL analysis first, except on hosted runners', () => {
  const scope = classifyChanges(['docs/faq.md']);
  assert.equal(labels(steps(scope, []))[0], 'codeql');
  assert.deepEqual(steps(scope, [])[0].commands, [['scripts/codeql.mjs']]);
  assert.equal(labels(steps(scope, [], { env: { GITHUB_ACTIONS: 'true' } })).includes('codeql'), false);
});

test('local validation checks test kinds against the default branch, as the hosted change scope does', () => {
  const scope = classifyChanges(['docs/faq.md']);
  const kinds = (options) => steps(scope, [], options).find((step) => step.label === 'test kinds');
  assert.deepEqual(kinds({}).commands, [['scripts/check-test-tags.mjs', '--base', 'origin/main']]);
  assert.deepEqual(kinds({ base: 'origin/0.9.8' }).commands, [
    ['scripts/check-test-tags.mjs', '--base', 'origin/0.9.8'],
  ]);
  assert.equal(labels(steps(scope, [], { env: { GITHUB_ACTIONS: 'true' } })).includes('test kinds'), false);
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.ok(ci.jobs.changes.steps.some((step) => step.run === 'node scripts/check-test-tags.mjs --event'));
});

test('local validation approximates the SonarQube rules on changes from the default branch, hosted CI does not', () => {
  const scope = classifyChanges(['docs/faq.md']);
  const sonar = (options) => steps(scope, [], options).find((step) => step.label === 'sonar rules');
  assert.deepEqual(sonar({}).commands, [['scripts/sonar-rules.mjs', '--base', 'origin/main']]);
  assert.deepEqual(sonar({ base: 'origin/0.9.8' }).commands, [['scripts/sonar-rules.mjs', '--base', 'origin/0.9.8']]);
  assert.equal(labels(steps(scope, [], { env: { GITHUB_ACTIONS: 'true' } })).includes('sonar rules'), false);
  // Hosted runs reach the SonarQube server itself, so no workflow runs the approximation.
  for (const name of ['ci', 'security', 'sonarqube']) {
    const workflow = fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    assert.doesNotMatch(workflow, /sonar-rules/, `${name}.yml`);
  }
  const sonarqube = YAML.parse(fs.readFileSync(new URL('../.github/workflows/sonarqube.yml', import.meta.url), 'utf8'));
  assert.ok(
    Object.values(sonarqube.jobs).some((job) =>
      job.steps?.some((step) => step.uses?.startsWith('SonarSource/sonarqube-scan-action@')),
    ),
    'the hosted gate is the server analysis',
  );
});

test('the package smoke starts from an empty npm cache, as a hosted runner would', () => {
  const smoke = steps(classifyChanges(['bin/paqvilo.mjs']), []).find((step) => step.label === 'package smoke');
  assert.match(smoke.env.npm_config_cache, /[\\/]\.paqvilo[\\/]ci[\\/]npm-cache-smoke$/);
  assert.equal(smoke.commands[0][0], '-e');
  assert.match(smoke.commands[0][1], /rmSync\(process\.env\.npm_config_cache/);
  assert.deepEqual(
    smoke.commands.slice(1).map((command) => command.at(-1)),
    ['cache:package', 'release:smoke'],
  );
});

test('changed test files rerun after their own lane with the package flags, and only when changed', () => {
  const changed = ['test/local-validation-parity.test.mjs', 'mirage/test/temp-directory.test.mjs', 'docs/faq.md'];
  assert.deepEqual(changedTests(changed, 0, 'lense'), []);
  const lense = changedTests(changed, 2, 'lense');
  assert.equal(lense.length, 2);
  assert.equal(lense[0].cwd, path.resolve(import.meta.dirname, '..'));
  assert.ok(lense[0].args.includes('--test-timeout=180000'));
  assert.equal(lense[0].args.at(-1).replaceAll('\\', '/'), 'test/local-validation-parity.test.mjs');
  const mirage = changedTests(changed, 1, 'mirage');
  assert.equal(mirage[0].cwd, path.join(lense[0].cwd, 'mirage'));
  assert.equal(mirage[0].args.at(-1).replaceAll('\\', '/'), 'test/temp-directory.test.mjs');
  assert.deepEqual(changedTests(changed, 2, 'mirage', true), [], 'no changed Mirage browser test');
  const lane = steps(classifyChanges(changed), ['mirage', 'lense'], { changed, repeat: 2 }).find(
    (step) => step.label === 'lense unit',
  );
  assert.equal(lane.commands.length, 3, 'the lane, then two repeated runs');
  assert.ok(
    steps(classifyChanges(changed), ['mirage', 'lense'], { changed, repeat: 2 })
      .filter((step) => step.label.endsWith('msedge'))
      .every((step) => step.commands.length === 1),
  );
});

test('repeated tests come from commits no remote branch contains, not from the whole base diff', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-ci-unpushed-'));
  ownedFixture(t).remove(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  const git = (...args) => {
    const result = spawnSync(
      'git',
      ['-c', 'core.hooksPath=.no-hooks', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
      { cwd: directory, env, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  const commit = (file, message) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), message);
    git('add', '.');
    git('commit', '-qm', message);
  };
  git('init', '-q');
  commit('test/base.test.mjs', 'base');
  commit('test/release.test.mjs', 'release work already on the remote');
  git('update-ref', 'refs/remotes/origin/release', 'HEAD');
  assert.deepEqual(unpushedFiles(directory), []);
  commit('test/pushed-next.test.mjs', 'this push');
  commit('mirage/test/also.test.mjs', 'this push too');
  assert.deepEqual(unpushedFiles(directory).sort(), ['mirage/test/also.test.mjs', 'test/pushed-next.test.mjs']);
});

test('the changed-test repeat count is configured like the job count', () => {
  assert.equal(validationRepeat({}, null), 2);
  assert.equal(validationRepeat({}, '0'), 0);
  assert.equal(validationRepeat({ PAQ_CI_REPEAT: '3' }, '0'), 3);
  for (const value of ['-1', 'two', '1.5']) assert.throws(() => validationRepeat({ PAQ_CI_REPEAT: value }), /integer/);
});

test(
  'Windows validation exposes TEMP through a short alias whose real path differs, as hosted runners do',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const base = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-short-temp-'));
    ownedFixture(t).remove(() => fs.promises.rm(base, { recursive: true, force: true }));
    assert.equal(runnerTemporaryDirectory({ platform: 'win32', env: { GITHUB_ACTIONS: 'true' }, base }), null);
    assert.equal(runnerTemporaryDirectory({ platform: 'linux', env: {}, base }), null);
    const temporary = runnerTemporaryDirectory({ platform: 'win32', env: {}, base });
    const physical = fs.realpathSync.native(temporary);
    assert.equal(physical, path.join(base, 'paqvilo-validation-temporary'));
    // Volumes without 8.3 names keep the long path; with them the alias differs, reproducing RUNNER~1.
    if (temporary !== physical) assert.match(path.basename(temporary), /~\d$/);
  },
);

test('a step command may carry its own environment and working directory', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-ci-command-'));
  ownedFixture(t).remove(() => fs.promises.rm(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'nested'));
  fs.writeFileSync(
    path.join(directory, 'nested', 'record.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync('record.txt', process.env.STEP + ':' + process.env.COMMAND);`,
  );
  await runSteps(
    [
      {
        label: 'record',
        env: { STEP: 'step', COMMAND: 'step' },
        commands: [{ args: ['record.mjs'], env: { COMMAND: 'command' }, cwd: path.join(directory, 'nested') }],
      },
    ],
    1,
    { cwd: directory },
  );
  assert.equal(fs.readFileSync(path.join(directory, 'nested', 'record.txt'), 'utf8'), 'step:command');
});

test('the local CodeQL bundle and suites follow the pinned Security workflow action', () => {
  const security = YAML.parse(fs.readFileSync(new URL('../.github/workflows/security.yml', import.meta.url), 'utf8'));
  const steps = security.jobs.codeql.steps.filter((step) => step.uses?.startsWith('github/codeql-action/'));
  assert.ok(steps.length >= 2);
  // A Dependabot bump of the action changes its bundle; update CODEQL_BUNDLE from its src/defaults.json.
  for (const step of steps) assert.equal(step.uses.split('@')[1], CODEQL_BUNDLE.action, step.uses);
  assert.equal(steps.find((step) => step.uses.includes('/init@')).with.queries, 'security-extended');
  assert.deepEqual(codeqlLanguages(), ['actions', 'csharp', 'javascript-typescript']);
  assert.equal(
    securitySuite('javascript-typescript'),
    'codeql/javascript-queries:codeql-suites/javascript-security-extended.qls',
  );
  for (const [, digest] of Object.values(CODEQL_BUNDLE.assets)) assert.match(digest, /^[a-f0-9]{64}$/);
});

test('only results whose fingerprint GitHub dismissed on the analysed commit are accepted', () => {
  const result = (rule, uri, startLine, lineHash, startColumn = 5) => ({
    ruleId: rule,
    message: { text: 'Invented finding' },
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine, startColumn } } }],
    partialFingerprints: { primaryLocationLineHash: lineHash },
  });
  const sarif = (...results) => ({ runs: [{ results }] });
  const alert = (state, rule, path, start_line, commit_sha = 'analysed') => ({
    state,
    rule: { id: rule },
    most_recent_instance: { commit_sha, location: { path, start_line, start_column: 5 } },
  });
  const analysis = sarif(
    result('js/invented-a', 'lib/a.mjs', 10, 'aaaa:1'),
    result('js/invented-b', 'lib/b.mjs', 20, 'bbbb:1'),
    result('js/invented-c', 'lib/c.mjs', 30, 'cccc:1'),
  );
  const keys = dismissedKeys(
    analysis,
    [
      alert('dismissed', 'js/invented-a', 'lib/a.mjs', 10),
      alert('open', 'js/invented-b', 'lib/b.mjs', 20),
      alert('dismissed', 'js/invented-c', 'lib/c.mjs', 30, 'older-commit'),
    ],
    'analysed',
  );
  assert.equal(keys.size, 1, 'open alerts and instances of another commit are not dismissals');
  // A dismissed result keeps its fingerprint when its line moves; a new result, rule or file does not match.
  const open = undismissedResults(
    sarif(
      result('js/invented-a', 'lib/a.mjs', 42, 'aaaa:1'),
      result('js/invented-a', 'lib/a.mjs', 43, 'aaaa:2'),
      result('js/invented-other', 'lib/a.mjs', 10, 'aaaa:1'),
      result('js/invented-a', 'lib/moved.mjs', 10, 'aaaa:1'),
      { ...result('js/invented-a', 'lib/a.mjs', 10, 'aaaa:1'), partialFingerprints: {} },
    ),
    keys,
  );
  assert.deepEqual(
    open.map(({ rule, file, line }) => [rule, file, line]),
    [
      ['js/invented-a', 'lib/a.mjs', 43],
      ['js/invented-other', 'lib/a.mjs', 10],
      ['js/invented-a', 'lib/moved.mjs', 10],
      ['js/invented-a', 'lib/a.mjs', 10],
    ],
  );
});
