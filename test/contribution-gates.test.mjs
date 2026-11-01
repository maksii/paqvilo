// @test-kind tooling: git hooks, change-scope gate selection and CI receipts of the contribution workflow
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { validateCommitMessage } from '../scripts/conventional-commit.mjs';
import {
  classifyChanges as completeScope,
  preCommitScripts,
  githubScope,
  suitesForScope,
  ciLanes,
} from '../.github/scripts/change-scope.mjs';
import { tempDirSync } from './fixture.mjs';

const classifyChanges = (files) => {
  const { runtime, package: packaged, dependencies } = completeScope(files);
  return { runtime, package: packaged, dependencies };
};

test('commit gates accept Conventional Commits and reject malformed subjects/bodies', () => {
  for (const message of [
    'feat: add preview',
    'fix(lense)!: change contract\n\nBREAKING CHANGE: explicit identity required',
    'revert: undo change',
    'perf(mirage): speed up rendering',
  ])
    assert.doesNotThrow(() => validateCommitMessage(message));
  for (const message of ['', 'fix bug', 'fix: ', 'fix(scope) change', ' fix: change'])
    assert.throws(() => validateCommitMessage(message), /Use <type>\[optional scope\]\[!\]: <description>/, message);
  assert.throws(() => validateCommitMessage('feat: change\nbody without blank line'), /blank line/);
});

test('secondary edits skip runtime jobs but packaged documentation retains release checks', () => {
  assert.deepEqual(classifyChanges(['docs/coverage.md', 'README.md']), {
    runtime: false,
    package: true,
    dependencies: false,
  });
  for (const file of [
    'mirage/README.md',
    'mirage/docs/operations.md',
    'examples/company-operations/plugins/README.md',
    'AGENTS.md',
    'LICENSE',
    'NOTICE',
  ]) {
    assert.deepEqual(classifyChanges([file]), { runtime: false, package: true, dependencies: false }, file);
  }
  assert.deepEqual(classifyChanges(['site/index.html', '.github/ISSUE_TEMPLATE/bug.yml']), {
    runtime: false,
    package: false,
    dependencies: false,
  });
  for (const file of [
    'lense/cli.mjs',
    'mirage/lib/server.mjs',
    'test/cli.test.mjs',
    '.github/workflows/ci.yml',
    '.github/scripts/change-scope.mjs',
    'new-runtime/index.mjs',
    '.env.example',
  ])
    assert.equal(classifyChanges([file]).runtime, true, file);
  assert.equal(classifyChanges(['mirage/package-lock.json']).dependencies, true);
  // Documents that suites assert against (settings tables, documented error codes) select those suites.
  for (const [file, suites] of [
    ['docs/configuration.md', ['mirage']],
    ['mirage/docs/dataverse-api.md', ['mirage']],
    ['docs/lense.md', ['lense']],
  ]) {
    assert.equal(classifyChanges([file]).runtime, true, file);
    assert.deepEqual(suitesForScope(completeScope([file])), suites, file);
  }
});

test('description, title, base and source events validate the same complete PR diff with a stable required gate', (t) => {
  const { root, env: fixtureEnv, git, write } = fixture(t);
  write('README.md', '# Invented toolkit\n');
  git('add', '.');
  git('commit', '-qm', 'test: initial PR base');
  const base = git('rev-parse', 'HEAD');
  write('package.json', JSON.stringify({ name: 'invented-toolkit', type: 'module' }));
  write('lense/runtime.mjs', 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'test: shared runtime change');
  const head = git('rev-parse', 'HEAD');
  const event = {
    action: 'edited',
    pull_request: { base: { sha: base }, head: { sha: head } },
    changes: { body: { from: 'Previous description' } },
  };
  const eventFile = path.join(root, 'event.json'),
    output = path.join(root, 'output');
  const run = (payload, forced = false) => {
    fs.writeFileSync(eventFile, JSON.stringify(payload));
    fs.writeFileSync(output, '');
    const env = {
      ...fixtureEnv,
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_OUTPUT: output,
      VALIDATE_ALL: String(forced),
    };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../.github/scripts/change-scope.mjs', import.meta.url))],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env,
      },
    );
    return { ...result, output: fs.readFileSync(output, 'utf8') };
  };
  const synchronized = run({ ...event, action: 'synchronize' });
  assert.equal(synchronized.status, 0, synchronized.stderr);
  const scope = JSON.parse(synchronized.stdout);
  assert.equal(scope.runtime, true);
  assert.equal(scope.quality, true);
  assert.equal(scope.package, true);
  assert.equal(scope.smoke, true);
  assert.deepEqual(suitesForScope(scope), ['lense', 'mirage', 'examples']);
  for (const edited of [
    event,
    { ...event, changes: {} },
    { ...event, changes: { body: null } },
    { ...event, changes: { title: { from: 'Previous title' } } },
    { ...event, changes: { ...event.changes, title: { from: 'Previous title' } } },
    { ...event, changes: { base: { ref: { from: 'previous' } } } },
    { ...event, changes: { ...event.changes, unknown: {} } },
  ]) {
    const result = run(edited);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), scope);
    assert.equal(result.output, synchronized.output, 'every PR edit retains the applicable source lanes');
  }
  const unavailable = run({ ...event, pull_request: { ...event.pull_request, base: { sha: 'a'.repeat(40) } } });
  assert.notEqual(unavailable.status, 0, 'description edits fail closed when the source diff is unavailable');
  assert.match(unavailable.stderr, /Cannot determine changed files/);
  const forced = run(event, true);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(JSON.parse(forced.stdout).full, true);
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.concurrency.group, 'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  assert.equal(ci.jobs.gate.name, 'CI gate');
  assert.ok(ci.on.pull_request.types.includes('edited'), 'title and base changes must remain validated');
  const title = ci.jobs.changes.steps.find((step) => step.run === 'node scripts/conventional-commit.mjs --title');
  assert.equal(title.if, "github.event_name == 'pull_request'");
  assert.equal(title.env.PR_TITLE, '${{ github.event.pull_request.title }}');
});

test('the stable required CI gate rejects failed, cancelled or skipped applicable lanes', () => {
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.jobs.gate.name, 'CI gate');
  assert.equal(ci.jobs.gate.if, 'always()');
  assert.deepEqual(ci.jobs.gate.needs, ['changes', 'checks', 'test', 'browser', 'windows', 'sdk-linux', 'package']);
  const command = ci.jobs.gate.steps.find((step) => step.name === 'Require every job to succeed').run;
  assert.match(command, /^node -e ".*"$/);
  const script = command.slice('node -e "'.length, -1);
  const required = {
    SCOPE_RESULT: 'success',
    QUALITY: 'true',
    PACKAGE: 'true',
    RUNTIME: 'true',
    SMOKE_REQUIRED: 'true',
    SDK_REQUIRED: 'true',
    CHECKS: 'success',
    TESTS: 'success',
    BROWSER: 'success',
    WINDOWS: 'success',
    SDK: 'success',
    SMOKE: 'success',
  };
  const run = (env) => {
    const result = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    return result.status;
  };
  assert.equal(run(required), 0);
  for (const lane of ['SCOPE_RESULT', 'CHECKS', 'TESTS', 'BROWSER', 'WINDOWS', 'SDK', 'SMOKE'])
    for (const result of ['failure', 'cancelled', 'skipped'])
      assert.equal(run({ ...required, [lane]: result }), 1, `${lane} cannot qualify with ${result}`);
  assert.equal(
    run({
      ...required,
      QUALITY: 'false',
      PACKAGE: 'false',
      RUNTIME: 'false',
      SMOKE_REQUIRED: 'false',
      SDK_REQUIRED: 'false',
      CHECKS: 'skipped',
      TESTS: 'skipped',
      BROWSER: 'skipped',
      WINDOWS: 'skipped',
      SDK: 'skipped',
      SMOKE: 'skipped',
    }),
    0,
    'only inapplicable lanes may be skipped',
  );
});

test('commits use fast quality checks before scoped pre-push validation', () => {
  assert.deepEqual(preCommitScripts(['README.md']), ['quality', 'release:check']);
  assert.deepEqual(preCommitScripts(['mirage/docs/operations.md', 'docs/faq.md']), ['quality', 'release:check']);
  assert.deepEqual(preCommitScripts(['site/style.css']), ['quality', 'site:build']);
  assert.deepEqual(preCommitScripts(['docs/assets/overview.svg', 'README.md']), [
    'quality',
    'release:check',
    'site:build',
  ]);
  assert.deepEqual(preCommitScripts(['.github/workflows/pages.yml']), ['quality', 'site:build']);
  assert.deepEqual(preCommitScripts(['.github/ISSUE_TEMPLATE/bug.yml', 'SECURITY.md']), ['quality']);
  assert.deepEqual(preCommitScripts([]), []);
  for (const files of [
    ['README.md', 'lense/cli.mjs'],
    ['package.json'],
    ['new-runtime/index.mjs'],
    ['scripts/git-hooks.mjs'],
  ]) {
    assert.deepEqual(preCommitScripts(files), ['quality', 'release:check']);
  }
  assert.deepEqual(preCommitScripts(['lense/cli.mjs', 'site/index.html']), ['quality', 'release:check', 'site:build']);
  assert.deepEqual(preCommitScripts(['scripts/build-site.mjs']), ['quality', 'release:check', 'site:build']);
  assert.deepEqual(preCommitScripts(['templates/project/README.md']), ['quality', 'release:check']);
});

test('documentation CI retains required CodeQL configurations without scheduling runtime suites', () => {
  const read = (name) =>
    YAML.parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const ci = read('ci');
  const security = read('security');
  const runtime = "needs.changes.outputs.runtime == 'true'";
  for (const name of ['test', 'windows', 'browser']) assert.equal(ci.jobs[name].if, runtime, name);
  assert.equal(ci.jobs.package.if, "needs.changes.outputs.smoke == 'true'");
  assert.equal(ci.jobs.checks.steps.find((step) => step.name === 'Install locked dependencies').if, undefined);
  assert.equal(security.jobs.codeql.if, "needs.changes.outputs.codeql == 'true'");
  const documentation = completeScope(['docs/faq.md']);
  assert.equal(documentation.runtime, false);
  assert.equal(documentation.quality, true);
  assert.equal(documentation.codeql, true);
  assert.deepEqual(JSON.parse(documentation.languages), ['actions', 'csharp', 'javascript-typescript']);
  assert.match(security.jobs['dependency-review'].if, /needs\.changes\.outputs\.dependencies == 'true'/);
  for (const workflow of [ci, security]) {
    assert.equal(workflow.jobs.gate.if, 'always()');
    assert.equal(workflow.on.pull_request.paths, undefined, 'required gates must report on documentation PRs');
    assert.ok(workflow.on.pull_request.branches.includes('0.9.8'), 'release PRs must receive both gates');
  }
});

function fixture(t) {
  const root = tempDirSync('paqvilo-gates-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  // A runner's global identity, hooks, signing or line-ending configuration must not change the fixture's commits.
  // One file append instead of a Git process per setting.
  fs.appendFileSync(
    path.join(root, '.git', 'config'),
    '[user]\n\tname = Fixture\n\temail = fixture@example.test\n[core]\n\thooksPath = .no-hooks\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n',
  );
  const write = (name, contents) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  return { root, env, git, write };
}

test('PR scope excludes unrelated base-branch code but includes both sides of renames', (t) => {
  const { root, env, git, write } = fixture(t);
  const script = fileURLToPath(new URL('../.github/scripts/change-scope.mjs', import.meta.url));
  write('README.md', '# Guide\n');
  write('runtime.mjs', 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const initial = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'topic');
  write('README.md', '# Updated guide\n');
  git('commit', '-qam', 'docs');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '--detach', initial);
  write('runtime.mjs', 'export const value = 2;\n');
  git('commit', '-qam', 'unrelated runtime change');
  const base = git('rev-parse', 'HEAD');
  const classify = (event, extra = {}) => {
    write('event.json', JSON.stringify(event));
    write('output.txt', '');
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: {
        ...env,
        GITHUB_EVENT_PATH: path.join(root, 'event.json'),
        GITHUB_OUTPUT: path.join(root, 'output.txt'),
        GITHUB_EVENT_NAME: 'pull_request',
        VALIDATE_ALL: 'false',
        ...extra,
      },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(classify({ pull_request: { base: { sha: base }, head: { sha: head } } }).runtime, false);
  git('checkout', 'topic');
  fs.mkdirSync(path.join(root, 'docs'));
  git('mv', 'runtime.mjs', 'docs/runtime.md');
  git('commit', '-qm', 'rename');
  const renamed = git('rev-parse', 'HEAD');
  assert.equal(classify({ before: head }, { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: renamed }).runtime, true);
  assert.equal(classify({ pull_request: { base: { sha: head }, head: { sha: renamed } } }).runtime, true);
  assert.equal(classify({}, { GITHUB_EVENT_NAME: 'workflow_dispatch' }).runtime, true);
  assert.equal(classify({ before: head }, { VALIDATE_ALL: 'true' }).runtime, true);
});

function hookFixture(t, { classifier, readyDependencies = false } = {}) {
  const { root, env, git, write } = fixture(t);
  for (const name of [
    'scripts/git-hooks.mjs',
    'scripts/ensure-dependencies.mjs',
    'scripts/check-test-tags.mjs',
    '.github/scripts/change-scope.mjs',
  ]) {
    write(name, fs.readFileSync(new URL(`../${name}`, import.meta.url)));
  }
  if (classifier) write('.github/scripts/change-scope.mjs', classifier);
  if (readyDependencies)
    write(
      'scripts/ensure-dependencies.mjs',
      'export const dependencyReadiness = () => ({ ready: true }); export const browserExecutable = async () => ({ path: null });',
    );
  write('package.json', '{"type":"module"}');
  write('README.md', 'original');
  write('SECURITY.md', 'original');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const run = (extra = {}) =>
    spawnSync(process.execPath, [path.join(root, 'scripts/git-hooks.mjs'), 'pre-commit'], {
      cwd: root,
      env: { ...env, npm_execpath: '', ...extra },
      encoding: 'utf8',
      windowsHide: true,
    });
  const assertCleaned = () =>
    assert.deepEqual(fs.readdirSync(path.join(root, '.paqvilo', 'hooks')), [], 'owned snapshots were cleaned');
  return { root, env, git, write, run, assertCleaned };
}

test('README-only hook isolates staged sources and gate selection from unstaged edits', (t) => {
  const { root, git, write, run, assertCleaned } = hookFixture(t, { readyDependencies: true });
  write('README.md', 'staged');
  git('add', 'README.md');
  write('README.md', 'unstaged');
  write('.github/scripts/change-scope.mjs', 'export const preCommitScripts = () => [];');
  const npmCli = path.join(root, 'fake-npm.mjs');
  write(
    'fake-npm.mjs',
    `import fs from 'node:fs';
    fs.writeFileSync(process.env.HOOK_RESULT, JSON.stringify({
      args: process.argv.slice(2), readme: fs.readFileSync('README.md', 'utf8'), cwd: process.cwd()
    }));
    if (!['quality', 'release:check'].includes(process.argv[3])) process.exit(1);
  `,
  );
  const resultFile = path.join(root, 'result.json');
  const result = run({ npm_execpath: npmCli, HOOK_RESULT: resultFile });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.deepEqual(receipt.args, ['run', 'release:check']);
  assert.equal(receipt.readme, 'staged');
  assert.equal(fs.existsSync(receipt.cwd), false, 'owned snapshot was cleaned');
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'unstaged');
  assert.equal(git('show', ':README.md'), 'staged');
  assertCleaned();
});

test('staged path leading whitespace remains unknown and receives full validation', (t) => {
  const { root, git, write, run, assertCleaned } = hookFixture(t, { readyDependencies: true });
  // A legitimate directory name, including on Windows. Trimming the NUL output
  // would turn this into the documentation allowlist's docs/ path.
  const unknown = ' docs/runtime.mjs';
  write(unknown, 'export const value = 1;');
  git('add', '--', unknown);
  const resultFile = path.join(root, 'result.jsonl');
  const npmCli = path.join(root, 'fake-npm.mjs');
  write(
    'fake-npm.mjs',
    `import fs from 'node:fs';
    fs.appendFileSync(process.env.HOOK_RESULT, JSON.stringify(process.argv.slice(2)) + '\\n');
  `,
  );
  const result = run({ npm_execpath: npmCli, HOOK_RESULT: resultFile });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    fs
      .readFileSync(resultFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [
      ['run', 'quality'],
      ['run', 'release:check'],
    ],
  );
  assertCleaned();
});

test('no-check hook needs no npm or dependencies and still removes its snapshot', (t) => {
  const { git, write, run, assertCleaned } = hookFixture(t, {
    classifier: 'export const preCommitScripts = () => [];',
  });
  write('SECURITY.md', 'updated policy');
  git('add', 'SECURITY.md');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no applicable checks/);
  assertCleaned();
});

test('no-check hook rejects an index changed during staged gate selection', (t) => {
  const classifier = `import { spawnSync } from 'node:child_process';
    export function preCommitScripts() {
      const result = spawnSync('git', ['add', '--', 'late.md'], { windowsHide: true });
      if (result.status !== 0) throw new Error('Fixture could not update the staged index');
      return [];
    }
  `;
  const { git, write, run, assertCleaned } = hookFixture(t, { classifier });
  write('SECURITY.md', 'updated policy');
  write('late.md', 'concurrent edit');
  git('add', 'SECURITY.md');
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /staged index changed during validation/);
  assert.equal(git('show', ':late.md'), 'concurrent edit', 'guard preserves the changed contributor index');
  assertCleaned();
});

test('literal and package imports expand suites while isolated overlays remain Lense-only', (t) => {
  const { root, write } = fixture(t);
  write('package.json', JSON.stringify({ name: 'paqvilo', exports: { './lense': './lense/api.mjs' } }));
  write('lense/private.mjs', 'export const value = 1;');
  write('lense/shared.mjs', 'export const value = 2;');
  write('lense/api.mjs', "export { value } from './shared.mjs';");
  write('mirage/lib/runtime.mjs', "import { value } from '../../lense/shared.mjs';");
  write('examples/project/test/api.test.mjs', "import { value } from 'paqvilo/lense';");
  assert.deepEqual(suitesForScope(completeScope(['lense/private.mjs'], { root })), ['lense']);
  assert.deepEqual(suitesForScope(completeScope(['lense/shared.mjs'], { root })), ['lense', 'mirage', 'examples']);
  assert.deepEqual(suitesForScope(completeScope(['lense/panel-ui.mjs'], { root })), ['lense']);
  assert.deepEqual(suitesForScope(completeScope(['mirage/admin/app.mjs'], { root })), ['lense', 'mirage']);
  assert.deepEqual(suitesForScope(completeScope(['test/panel.test.mjs'], { root })), ['lense']);
  assert.deepEqual(suitesForScope(completeScope(['mirage/test/sdk.test.mjs'], { root })), ['mirage']);
  assert.deepEqual(suitesForScope(completeScope(['unclassified/file.mjs'], { root })), ['lense', 'mirage', 'examples']);
});

test('quoted file, directory and template references select the suites that read or spawn them', (t) => {
  const { root, write } = fixture(t);
  write('package.json', JSON.stringify({ name: 'paqvilo' }));
  write('mirage/lib/assets/icon.svg', '<svg/>');
  write(
    'mirage/lib/server.mjs',
    "export const icon = new URL('./assets/icon.svg', import.meta.url); export const url = './';",
  );
  write('mirage/lib/other.mjs', 'export {};');
  write('mirage/tool.mjs', 'export {};');
  write('bin/cli.mjs', 'export const run = (tool) => new URL(`../mirage/${tool}.mjs`, import.meta.url);');
  write('test/server.test.mjs', "import '../mirage/lib/server.mjs';");
  write('test/cli.test.mjs', "const cli = new URL('../bin/cli.mjs', import.meta.url);");
  write(
    'examples/project/test/fixture.test.mjs',
    "const fixtures = new URL('../../../mirage/lib/assets/', import.meta.url);",
  );
  write('mirage/test/guide.test.mjs', "const guide = new URL('../../docs/guide.md', import.meta.url);");
  write('docs/guide.md', '# Invented guide\n');
  write('docs/other.md', '# Unread guide\n');
  assert.deepEqual(suitesForScope(completeScope(['mirage/lib/assets/icon.svg'], { root })), [
    'lense',
    'mirage',
    'examples',
  ]);
  assert.deepEqual(suitesForScope(completeScope(['mirage/tool.mjs'], { root })), ['lense', 'mirage']);
  assert.deepEqual(
    suitesForScope(completeScope(['mirage/lib/other.mjs'], { root })),
    ['mirage'],
    "a bare './' is a URL",
  );
  assert.deepEqual(suitesForScope(completeScope(['docs/guide.md'], { root })), ['mirage']);
  assert.equal(completeScope(['docs/guide.md'], { root }).runtime, true);
  assert.deepEqual(suitesForScope(completeScope(['docs/other.md'], { root })), []);
  assert.equal(completeScope(['docs/other.md'], { root }).runtime, false);
});

test('main, explicit full, scheduled and manual runs select every gate', () => {
  for (const [eventName, event, env] of [
    ['push', {}, { GITHUB_REF: 'refs/heads/main' }],
    ['workflow_dispatch', {}, {}],
    ['pull_request', {}, { VALIDATE_ALL: 'true' }],
    ['schedule', {}, {}],
  ]) {
    const scope = githubScope(event, eventName, env);
    assert.equal(scope.full, true);
    assert.deepEqual(suitesForScope(scope), ['lense', 'mirage', 'examples']);
    assert.equal(scope.smoke, true);
  }
});

test('workflow matrices use selected suites on the pinned runtime and shared local commands', () => {
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  for (const [name, kind, lanes] of [
    ['test', 'unit', 'units'],
    ['windows', 'unit', 'units'],
    ['browser', 'browser', 'browsers'],
  ]) {
    assert.equal(ci.jobs[name].strategy.matrix.include, `\${{ fromJSON(needs.changes.outputs.${lanes}) }}`);
    for (const step of ['ci:prepare', 'ci:verify'])
      assert.match(
        ci.jobs[name].steps.find((entry) => entry.run?.includes(step)).run,
        new RegExp(
          `--${kind} .*\\$\\{\\{ matrix\\.shard && format\\('--shard \\{0\\}', matrix\\.shard\\) \\|\\| '' \\}\\}`,
        ),
      );
    // Every selected suite keeps its lane, and a sharded suite keeps every shard exactly once.
    for (const suite of ['lense', 'mirage', 'examples']) {
      const shards = ciLanes(kind, [suite]).map((lane) => [lane.suite, lane.shard]);
      const total = shards.length;
      assert.deepEqual(
        shards,
        total === 1 ? [[suite, undefined]] : shards.map((_, index) => [suite, `${index + 1}/${total}`]),
        `${kind} ${suite}`,
      );
    }
  }
  assert.ok(ciLanes('unit', ['mirage']).length > 1, 'the longest suite is sharded');
  for (const name of ['test', 'windows', 'browser']) {
    assert.equal(ci.jobs[name].strategy.matrix.node, undefined);
    assert.equal(
      ci.jobs[name].steps.find((step) => step.uses?.startsWith('actions/setup-node@')).with['node-version-file'],
      '.node-version',
    );
    assert.ok(ci.jobs[name].steps.some((step) => step.run?.includes('ci:prepare')));
    assert.ok(ci.jobs[name].steps.some((step) => step.run?.includes('ci:verify')));
  }
  const siteBuild = ci.jobs.checks.steps.find((step) => step.run === 'npm run site:build');
  assert.equal(siteBuild?.if, "needs.changes.outputs.site == 'true'");
  assert.equal(completeScope(['site/style.css']).site, true);
  assert.equal(completeScope([], { full: true }).site, true);
  assert.equal(completeScope(['lense/panel-ui.mjs']).site, false);
  assert.equal(ci.on.workflow_call.inputs.full.default, true);
  assert.equal(ci.on.workflow_dispatch.inputs.full.default, true);
});

test('verification receipts require an identical tree, toolchain, browser, fixtures and selected scope', async () => {
  const { matchingVerification } = await import('../scripts/ci.mjs');
  const identity = {
    tree: 'abc',
    node: 'v24.22.1',
    npm: '11.19.1',
    platform: 'win32',
    arch: 'x64',
    chromium: 'fixture:100:200',
    tedious: '20.3.8',
    clrSdk: 'digest',
    dotnet: '10.0.113',
    nodeOptions: '',
  };
  const scope = { lense: true },
    receipt = { identity, scope, full: false };
  assert.equal(matchingVerification(receipt, identity, scope), true);
  for (const field of Object.keys(identity))
    assert.equal(matchingVerification(receipt, { ...identity, [field]: 'changed' }, scope), false, field);
  assert.equal(matchingVerification(receipt, identity, { mirage: true }), false);
  assert.equal(matchingVerification({ ...receipt, full: true }, identity, { mirage: true }), true);
  assert.equal(
    matchingVerification({ ...receipt, full: true }, identity, { ...scope, full: true }),
    false,
    'an explicit full validation must execute again even for the identical source tree',
  );
  assert.equal(matchingVerification(receipt, null, scope), false);
});

test('starting a validation revokes previous evidence even when the rerun fails', async (t) => {
  const { consumeVerificationReceipt, matchingVerification } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-verification-receipt-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'verification.json');
  const identity = { tree: 'previously-passing-tree' };
  const scope = { lense: true };
  const passed = { identity, scope, full: true };
  fs.writeFileSync(file, JSON.stringify(passed));
  assert.throws(() => {
    assert.deepEqual(consumeVerificationReceipt(file), passed);
    throw new Error('a suite failed during the rerun');
  }, /suite failed/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(matchingVerification(consumeVerificationReceipt(file), identity, scope), false);
});

test('malformed validation evidence is revoked', async (t) => {
  const { consumeVerificationReceipt } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-malformed-receipt-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'verification.json');
  const malformed = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(malformed, '{incomplete receipt');
  } finally {
    fs.closeSync(malformed);
  }
  assert.equal(consumeVerificationReceipt(file), undefined);
  assert.equal(fs.existsSync(file), false, 'malformed evidence is revoked too');
});

test('every PR retains all main CodeQL configurations regardless of changed languages or an empty diff', () => {
  const main = completeScope([], { full: true });
  assert.equal(main.codeql, true);
  assert.deepEqual(JSON.parse(main.languages), ['actions', 'csharp', 'javascript-typescript']);
  for (const files of [
    ['lense/panel-ui.mjs'],
    ['.github/workflows/ci.yml'],
    ['examples/project/Plugin.cs'],
    ['site/style.css'],
    ['docs/faq.md', 'README.md'],
    [],
  ]) {
    const scope = completeScope(files);
    assert.equal(scope.codeql, true, JSON.stringify(files));
    assert.equal(scope.languages, main.languages, JSON.stringify(files));
  }
  assert.deepEqual(suitesForScope(completeScope(['lense/panel-ui.mjs'])), ['lense']);
  assert.deepEqual(suitesForScope(completeScope(['docs/faq.md'])), []);
  assert.deepEqual(suitesForScope(completeScope([])), []);
  const security = YAML.parse(fs.readFileSync(new URL('../.github/workflows/security.yml', import.meta.url), 'utf8'));
  assert.equal(security.jobs.codeql.strategy.matrix.language, '${{ fromJSON(needs.changes.outputs.languages) }}');
  const analysis = security.jobs.codeql.steps.find((step) => step.uses?.startsWith('github/codeql-action/analyze@'));
  assert.equal(analysis.with.category, '/language:${{ matrix.language }}');
});

test('CI and security run required gates for baseline PRs targeting 0.9.8', () => {
  for (const file of ['ci', 'security']) {
    const workflow = YAML.parse(fs.readFileSync(new URL(`../.github/workflows/${file}.yml`, import.meta.url), 'utf8'));
    assert.ok(workflow.on.pull_request.branches.includes('0.9.8'), file);
    assert.ok(workflow.on.pull_request.branches.includes('main'), file);
  }
});

test('the pre-push hook refuses a different pushed commit and allows branch deletions without validating source', (t) => {
  const { root, env, git, write } = hookFixture(t, { readyDependencies: true });
  const resultFile = path.join(root, 'push.json');
  const npmCli = path.join(root, 'fake-npm.mjs');
  write(
    'fake-npm.mjs',
    "import fs from 'node:fs'; fs.writeFileSync(process.env.HOOK_RESULT, JSON.stringify(process.argv.slice(2)));",
  );
  git('add', 'fake-npm.mjs');
  git('commit', '-qm', 'test: prepare fake push command');
  const run = (input) =>
    spawnSync(process.execPath, [path.join(root, 'scripts/git-hooks.mjs'), 'pre-push'], {
      cwd: root,
      input,
      env: { ...env, npm_execpath: npmCli, HOOK_RESULT: resultFile },
      encoding: 'utf8',
      windowsHide: true,
    });
  const other = run(`refs/heads/topic ${'a'.repeat(40)} refs/heads/topic ${'b'.repeat(40)}\n`);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /checked-out commit/);
  assert.equal(fs.existsSync(resultFile), false);
  const deleted = run(`(delete) ${'0'.repeat(40)} refs/heads/topic ${'b'.repeat(40)}\n`);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(fs.existsSync(resultFile), false);
  const current = run(`refs/heads/topic ${git('rev-parse', 'HEAD')} refs/heads/topic ${'b'.repeat(40)}\n`);
  assert.equal(current.status, 0, current.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), ['run', 'ci:verify', '--']);
});

test('CI command rejects conflicting, incomplete and unknown options before running validation', () => {
  const script = fileURLToPath(new URL('../scripts/ci.mjs', import.meta.url));
  for (const args of [
    ['verify', '--unit', '--browser'],
    ['verify', '--suite'],
    ['verify', '--full', '--suite', 'lense'],
    ['verify', '--unknown'],
  ]) {
    // Rejection precedes any validation; the guard only ends a regression that starts validating this checkout.
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.status, 1, args.join(' '));
    assert.doesNotMatch(result.stdout, /CI selection|completed without errors/);
  }
});

test('public entrypoints and project scaffolding retain installed-package smoke before merge', () => {
  for (const file of [
    'lense/cli.mjs',
    'lense/api.mjs',
    'lense/project-scaffold.mjs',
    'mirage/api.mjs',
    'mirage/cli.mjs',
    'bin/paqvilo.mjs',
  ])
    assert.equal(completeScope([file]).smoke, true, file);
  assert.equal(completeScope(['lense/panel-ui.mjs']).smoke, false);
});

test('fully staged validation uses the exact index tree and fails closed on worktree or untracked changes', async (t) => {
  const { validationTree } = await import('../scripts/ci.mjs');
  const { root, git, write } = fixture(t);
  write('tracked.txt', 'first');
  git('add', '.');
  git('commit', '-qm', 'test: initial tree');
  const first = validationTree({ directory: root });
  assert.equal(first, git('rev-parse', 'HEAD^{tree}'));
  write('tracked.txt', 'second');
  assert.equal(validationTree({ directory: root, allowStaged: true }), null, 'unstaged bytes cannot be qualified');
  git('add', 'tracked.txt');
  assert.equal(validationTree({ directory: root }), null, 'ordinary pre-push still requires clean HEAD');
  const staged = validationTree({ directory: root, allowStaged: true });
  assert.equal(staged, git('write-tree'));
  assert.notEqual(staged, first);
  write('untracked.txt', 'untracked');
  assert.equal(validationTree({ directory: root, allowStaged: true }), null);
  fs.unlinkSync(path.join(root, 'untracked.txt'));
  git('commit', '-qm', 'test: committed verified tree');
  assert.equal(
    validationTree({ directory: root }),
    staged,
    'the final logical commit matches the verified staged tree',
  );
});

test('pre-push rejects both unstaged and staged differences from pushed HEAD, including main', (t) => {
  const { root, env, git, write } = hookFixture(t, { readyDependencies: true });
  git('branch', '-M', 'main');
  const cli = path.join(root, 'fake-npm.mjs');
  write('fake-npm.mjs', 'process.exit(99);');
  git('add', 'fake-npm.mjs');
  git('commit', '-qm', 'test: fake npm');
  const run = () =>
    spawnSync(process.execPath, [path.join(root, 'scripts/git-hooks.mjs'), 'pre-push'], {
      cwd: root,
      input: `refs/heads/main ${git('rev-parse', 'HEAD')} refs/heads/main ${'0'.repeat(40)}\n`,
      env: { ...env, npm_execpath: cli },
      encoding: 'utf8',
      windowsHide: true,
    });
  write('README.md', 'updated');
  for (const staged of [false, true]) {
    if (staged) git('add', 'README.md');
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /clean worktree and index/);
  }
});

test('SDK fixtures reject stale DLL bytes and compiler pinning matches every CLR-capable CI lane', async (t) => {
  const { verifyClrSdk } = await import('../scripts/ci.mjs');
  const { root, write } = fixture(t);
  write('fixture.dll', 'invented stale SDK bytes');
  assert.throws(() => verifyClrSdk(path.join(root, 'fixture.dll')), /DLL digest mismatch/);
  const pin = JSON.parse(fs.readFileSync(new URL('../global.json', import.meta.url), 'utf8'));
  // Servicing patches of the pinned feature band are accepted; another band, minor or major is refused.
  assert.deepEqual(pin.sdk, { version: '10.0.114', rollForward: 'latestPatch', allowPrerelease: false });
  const { dotnetSatisfies } = await import('../scripts/ci.mjs');
  assert.equal(dotnetSatisfies('10.0.114', '10.0.114'), true);
  assert.equal(dotnetSatisfies('10.0.114', '10.0.120'), true);
  for (const other of ['10.0.113', '10.0.200', '10.1.100', '11.0.114', '10.0.114-preview.1', ''])
    assert.equal(dotnetSatisfies('10.0.114', other), false, other);
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  for (const name of ['test', 'windows', 'browser']) {
    const setup = ci.jobs[name].steps.find((step) => step.uses?.startsWith('actions/setup-dotnet@'));
    assert.equal(setup.if, "matrix.suite != 'lense'");
    assert.equal(setup.with['global-json-file'], 'global.json');
    assert.match(setup.uses, /@[a-f0-9]{40}$/);
  }
});

test('staged fixture imports use staged toolkit sources and locked registry dependencies', (t) => {
  const { root, git, write, run, assertCleaned } = hookFixture(t, { readyDependencies: true });
  write('.gitignore', 'node_modules/\n');
  write(
    'package.json',
    JSON.stringify({ name: 'paqvilo', type: 'module', exports: { './contract': './contract.mjs' } }),
  );
  write('contract.mjs', "export const value = 'staged';");
  for (const project of ['examples/project', 'examples/company-operations']) {
    write(
      project + '/package.json',
      JSON.stringify({ name: 'invented-fixture', type: 'module', dependencies: { paqvilo: 'file:../..' } }),
    );
    write(project + '/check.mjs', "export { value } from 'paqvilo/contract';");
    const modules = path.join(root, project, 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(root, path.join(modules, 'paqvilo'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const sdk = 'mirage/test-sdk/dynamics-web-api';
  write(
    sdk + '/package.json',
    JSON.stringify({ name: 'invented-sdk', type: 'module', dependencies: { 'invented-registry': '1.0.0' } }),
  );
  write(
    sdk + '/package-lock.json',
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/invented-registry': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/invented-registry/-/invented-registry-1.0.0.tgz',
        },
      },
    }),
  );
  write(
    sdk + '/node_modules/invented-registry/package.json',
    JSON.stringify({ name: 'invented-registry', version: '1.0.0', type: 'module', exports: './index.mjs' }),
  );
  write(sdk + '/node_modules/invented-registry/index.mjs', "export const vendor = 'invented registry dependency';");
  write(sdk + '/check.mjs', "export { vendor } from 'invented-registry';");
  git('add', '.');
  write('contract.mjs', "export const value = 'UNSTAGED';");
  const cli = path.join(root, 'fake-npm.mjs');
  write(
    'fake-npm.mjs',
    `import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url';
    const snapshot = fs.realpathSync('.');
    for (const project of ['examples/project','examples/company-operations']) {
      assert.equal(fs.realpathSync(path.join(project,'node_modules/paqvilo')), snapshot);
      assert.equal((await import(pathToFileURL(path.resolve(project,'check.mjs')).href)).value, 'staged');
    }
    assert.equal((await import(pathToFileURL(path.resolve('${sdk}/check.mjs')).href)).vendor, 'invented registry dependency');
  `,
  );
  const result = run({ npm_execpath: cli });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'contract.mjs'), 'utf8'), "export const value = 'UNSTAGED';");
  assert.equal(
    fs.readFileSync(path.join(root, sdk, 'node_modules/invented-registry/index.mjs'), 'utf8'),
    "export const vendor = 'invented registry dependency';",
  );
  assertCleaned();
});

test('Windows examples require the verified CLR fixture independently of Mirage lanes', async () => {
  const { requiresClrFixture } = await import('../scripts/ci.mjs');
  for (const suite of ['mirage', 'examples', 'all']) assert.equal(requiresClrFixture(suite, 'win32'), true);
  for (const suite of ['lense', 'quality']) assert.equal(requiresClrFixture(suite, 'win32'), false);
  for (const suite of ['mirage', 'examples', 'all']) assert.equal(requiresClrFixture(suite, 'linux'), false);
  const source = fs.readFileSync(new URL('../scripts/ci.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(requiresClrFixture\(suite\)\) await clrFixture\(\)/);
  assert.match(
    source,
    /if \(requiresClrFixture\(suite\)\) \{[\s\S]*?verifyClrSdk\(sdk\);[\s\S]*?environment\('PAQ_TEST_XRM_SDK', sdk\)/,
  );
});

test('full and applicable scoped PR runs require locked SDK clients on Windows and Linux', async () => {
  const { fullSdkGate } = await import('../scripts/ci.mjs');
  assert.equal(fullSdkGate(completeScope([], { full: true }), 'win32'), true);
  assert.equal(fullSdkGate(completeScope([], { full: true }), 'linux'), true);
  assert.equal(fullSdkGate(completeScope(['lense/panel-ui.mjs']), 'win32'), false);
  assert.equal(fullSdkGate(completeScope(['package.json']), 'win32'), true);
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  // Exactly one Mirage leg (the first shard, or the whole suite) prepares and runs the SDK clients.
  const once = "matrix.suite == 'mirage' && (!matrix.shard || startsWith(matrix.shard, '1/'))";
  const step = ci.jobs.windows.steps.find((step) => step.run === 'node scripts/ci.mjs sdk');
  assert.equal(step?.if, `${once} && needs.changes.outputs.sdk == 'true'`);
  const prepare = ci.jobs.windows.steps.find((step) => step.name === 'Release port 80 for the ServiceClient gate');
  assert.equal(prepare?.if, `${step.if} && runner.environment == 'github-hosted'`);
  assert.equal(prepare.shell, 'pwsh');
  assert.ok(ci.jobs.windows.steps.indexOf(prepare) < ci.jobs.windows.steps.indexOf(step));
  assert.match(prepare.run, /net stop http \/y/);
  assert.match(prepare.run, /Port 80 is still held/);
  assert.ok(
    ci.jobs.windows.steps.some((step) =>
      step.run?.includes(`${once} && needs.changes.outputs.sdk == 'true' && '--sdk'`),
    ),
  );
  const { validationSteps } = await import('../scripts/ci.mjs');
  const sdkSteps = (scope, platform) =>
    validationSteps(scope, [], {}, platform).filter((step) => step.label === 'sdk gates');
  assert.deepEqual(sdkSteps(completeScope([], { full: true }), 'win32')[0]?.commands, [['scripts/ci.mjs', 'sdk']]);
  assert.deepEqual(sdkSteps(completeScope([], { full: true }), 'linux')[0]?.commands, [['scripts/ci.mjs', 'sdk']]);
  assert.deepEqual(sdkSteps(completeScope(['lense/panel-ui.mjs']), 'win32'), []);
  const source = fs.readFileSync(new URL('../scripts/ci.mjs', import.meta.url), 'utf8');
  assert.match(source, /cert-auth\/Gate\/Gate\.csproj', '--locked-mode'/);
});

test('example preparation removes stale local dependencies without following junctions and prepared imports match the lock', async (t) => {
  const { resetExampleModules, requireExampleBrowserDependency } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-example-deps-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, 'checkout'),
    project = path.join(checkout, 'examples/project');
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched');
  fs.symlinkSync(outside, path.join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  resetExampleModules(checkout);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'untouched');
  assert.equal(fs.existsSync(path.join(project, 'node_modules')), false);
  const install = (base, version) => {
    const packageDirectory = path.join(base, 'node_modules/playwright-core');
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: 'playwright-core', version }));
  };
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  fs.writeFileSync(
    path.join(checkout, 'npm-shrinkwrap.json'),
    JSON.stringify({ packages: { 'node_modules/playwright-core': { version: '1.64.1' } } }),
  );
  install(checkout, '1.64.1');
  install(project, '1.63.0');
  assert.throws(() => requireExampleBrowserDependency('examples/project', checkout), /resolved Playwright/);
  resetExampleModules(checkout);
  assert.doesNotThrow(() => requireExampleBrowserDependency('examples/project', checkout));
});

test('Git status probes fail closed without refreshing the index with optional locks', async (t) => {
  const { checkedGitStatus, validationTree } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-git-status-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => checkedGitStatus(directory), /Cannot determine Git worktree status/);
  assert.throws(() => checkedGitStatus(path.join(directory, 'missing')), /Cannot determine Git worktree status/);
  assert.equal(validationTree({ directory }), null);
  const init = spawnSync('git', ['init', '--quiet'], { cwd: directory, windowsHide: true });
  assert.equal(init.status, 0);
  assert.equal(checkedGitStatus(directory), '');
  const lock = path.join(directory, '.git/index.lock');
  fs.writeFileSync(lock, 'another operation owns this lock');
  assert.equal(checkedGitStatus(directory), '');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another operation owns this lock');
  for (const file of ['scripts/ci.mjs', 'scripts/git-hooks.mjs', '.github/scripts/change-scope.mjs']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const calls = [...source.matchAll(/spawnSync\(\s*'git',\s*([^\n]+)/g)];
    assert.ok(calls.length > 0, file);
    for (const call of calls) assert.match(call[1], /^\['--no-optional-locks'/, file);
  }
});

test('package export targets replace every wildcard using the literal imported subpath', (t) => {
  const { root, write } = fixture(t);
  write(
    'package.json',
    JSON.stringify({ name: 'paqvilo', exports: { './generated/*': './lense/generated/*/copy/*.mjs' } }),
  );
  write('lense/generated/$&/copy/$&.mjs', 'export const value = 1;');
  write('examples/project/test/generated.test.mjs', "import { value } from 'paqvilo/generated/$&';");
  assert.deepEqual(suitesForScope(completeScope(['lense/generated/$&/copy/$&.mjs'], { root })), ['lense', 'examples']);
});
