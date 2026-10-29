import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { classifyChanges } from '../.github/scripts/change-scope.mjs';
import {
  changedTests,
  localBrowserChannels,
  runSteps,
  runnerTemporaryDirectory,
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
      ['examples --prepared', 'chromium'],
      ['examples --browser --prepared', 'msedge'],
    ],
  );
  const linux = steps(scope, ['mirage', 'lense', 'examples'], {}, 'linux');
  assert.equal(
    labels(linux).some((label) => label.includes('msedge')),
    false,
  );
  assert.equal(linux.find((step) => step.label === 'examples').commands.length, 1);
});

test('local validation runs the Security workflow CodeQL analysis first, except on hosted runners', () => {
  const scope = classifyChanges(['docs/faq.md']);
  assert.equal(labels(steps(scope, []))[0], 'codeql');
  assert.deepEqual(steps(scope, [])[0].commands, [['scripts/codeql.mjs']]);
  assert.equal(labels(steps(scope, [], { env: { GITHUB_ACTIONS: 'true' } })).includes('codeql'), false);
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

test('the changed-test repeat count is configured like the job count', () => {
  assert.equal(validationRepeat({}, undefined), 2);
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
