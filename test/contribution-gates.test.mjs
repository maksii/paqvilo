// @test-kind tooling: git hooks, change-scope gate selection and CI receipts of the contribution workflow
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { parse } from 'espree';
import { validateCommitMessage } from '../scripts/conventional-commit.mjs';
import {
  classifyChanges as completeScope,
  preCommitScripts,
  githubScope,
  suitesForScope,
  ciLanes,
} from '../.github/scripts/change-scope.mjs';
import { tempDirSync } from './fixture.mjs';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner

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
    'mirage/docs/object-parity.md',
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
  // A document that tests read selects their suite, and it stays packaged documentation.
  const operations = classifyChanges(['mirage/docs/operations.md']);
  assert.equal(operations.runtime, true);
  assert.equal(operations.package, true);
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

// The hook executes staged copies, including every local module imported by its selected entry points.
function copyLocalModules(sourceRoot, entries, write) {
  const pending = [...entries],
    seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = fs.readFileSync(path.join(sourceRoot, name), 'utf8');
    write(name, source);
    const nodes = [parse(source, { ecmaVersion: 'latest', sourceType: 'module' })];
    while (nodes.length) {
      const node = nodes.pop();
      const specifier =
        node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration'
          ? node.source?.value
          : node.type === 'ImportExpression'
            ? node.source?.value
            : node.type === 'CallExpression' && node.callee?.name === 'require' && node.arguments.length === 1
              ? node.arguments[0].value
              : undefined;
      if (typeof specifier === 'string' && specifier.startsWith('.')) {
        const resolved = path.resolve(sourceRoot, path.dirname(name), specifier);
        const relative = path.relative(sourceRoot, resolved);
        assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
        pending.push(relative);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) nodes.push(...value.filter((item) => item?.type));
        else if (value?.type) nodes.push(value);
      }
    }
  }
  return seen;
}

function hookFixture(t, { classifier, readyDependencies = false } = {}) {
  const { root, env, git, write } = fixture(t);
  copyLocalModules(
    fileURLToPath(new URL('..', import.meta.url)),
    [
      'scripts/git-hooks.mjs',
      'scripts/ensure-dependencies.mjs',
      'scripts/check-test-tags.mjs',
      '.github/scripts/change-scope.mjs',
    ],
    write,
  );
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

test('hook fixture copies the transitive local module closure without installing dependencies', (t) => {
  const sourceRoot = tempDirSync('paqvilo-hook-modules-');
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(sourceRoot, 'nested'));
  fs.writeFileSync(
    path.join(sourceRoot, 'entry.mjs'),
    "import { value } from './nested/first.mjs'; console.log(value);\n",
  );
  fs.writeFileSync(path.join(sourceRoot, 'nested/first.mjs'), "export { value } from './second.mjs';\n");
  fs.writeFileSync(
    path.join(sourceRoot, 'nested/second.mjs'),
    "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const extra = require('./extra.cjs'); const third = await import('./third.mjs'); export const value = third.value + extra;\n",
  );
  fs.writeFileSync(path.join(sourceRoot, 'nested/third.mjs'), "export const value = 'transitive';\n");
  fs.writeFileSync(path.join(sourceRoot, 'nested/extra.cjs'), "module.exports = ' closure';\n");
  const { root, write } = fixture(t);
  const copied = copyLocalModules(sourceRoot, ['entry.mjs'], write);
  assert.deepEqual([...copied].sort(), [
    'entry.mjs',
    path.join('nested', 'extra.cjs'),
    path.join('nested', 'first.mjs'),
    path.join('nested', 'second.mjs'),
    path.join('nested', 'third.mjs'),
  ]);
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  const result = spawnSync(process.execPath, [path.join(root, 'entry.mjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'transitive closure');
});

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

test('staged test-kind checks run without installed dependencies', (t) => {
  const { root, git, write, run, assertCleaned } = hookFixture(t, {
    classifier: 'export const preCommitScripts = () => [];',
  });
  const file = 'test/invented.test.mjs';
  const body = "import test from 'node:test';\ntest('invented', () => {});\n";
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  write(file, body);
  git('add', file);
  const untagged = run();
  assert.equal(untagged.status, 1);
  assert.match(untagged.stderr, /test has no @test-kind/);
  assertCleaned();

  write(file, '// @test-kind tooling: invented isolated hook fixture.\n' + body);
  git('add', file);
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /no applicable checks/);
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  assertCleaned();
});

test('staged test-kind checks ignore unstaged legacy entries and checker edits', (t) => {
  const { root, git, write, run, assertCleaned } = hookFixture(t, {
    classifier: 'export const preCommitScripts = () => [];',
  });
  const file = 'test/invented.test.mjs';
  write(file, "import test from 'node:test';\ntest('invented', () => {});\n");
  git('add', file);
  write('scripts/test-kinds-legacy.json', JSON.stringify([file]));
  const legacyEdit = run();
  assert.equal(legacyEdit.status, 1, legacyEdit.stdout + legacyEdit.stderr);
  assert.match(legacyEdit.stderr, /test has no @test-kind/);
  assertCleaned();

  fs.rmSync(path.join(root, 'scripts', 'test-kinds-legacy.json'));
  write('scripts/check-test-tags.mjs', 'process.exit(0);\n');
  const checkerEdit = run();
  assert.equal(checkerEdit.status, 1, checkerEdit.stdout + checkerEdit.stderr);
  assert.match(checkerEdit.stderr, /test has no @test-kind/);
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
  assert.equal(ci.on.workflow_dispatch?.inputs?.full, undefined);
  assert.equal(githubScope({ inputs: { full: 'false' } }, 'workflow_dispatch', { GITHUB_SHA: 'abc' }).full, true);
});

test('CI dispatch inputs are exactly the inputs the change scope reads', () => {
  const ci = YAML.parse(
    fs.readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8'),
  );
  const scope = fs.readFileSync(fileURLToPath(new URL('../.github/scripts/change-scope.mjs', import.meta.url)), 'utf8');
  const declared = Object.keys(ci.on.workflow_dispatch?.inputs ?? {});
  const read = [...new Set([...scope.matchAll(/\bevent\.inputs\??\.(\w+)/g)].map((match) => match[1]))];
  assert.deepEqual(
    declared.toSorted((a, b) => a.localeCompare(b)),
    read.toSorted((a, b) => a.localeCompare(b)),
  );
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

test('the pre-push hook qualifies an annotated tag by the commit it peels to', (t) => {
  const { root, env, git, write } = hookFixture(t, { readyDependencies: true });
  const resultFile = path.join(root, 'push.json');
  write(
    'fake-npm.mjs',
    "import fs from 'node:fs'; fs.writeFileSync(process.env.HOOK_RESULT, JSON.stringify(process.argv.slice(2)));",
  );
  git('add', 'fake-npm.mjs');
  git('commit', '-qm', 'test: prepare fake push command');
  git('tag', '-a', 'v-current', '-m', 'current release');
  git('tag', '-a', 'v-previous', '-m', 'previous release', 'HEAD~1');
  const push = (ref, oid) =>
    spawnSync(process.execPath, [path.join(root, 'scripts/git-hooks.mjs'), 'pre-push'], {
      cwd: root,
      input: `${ref} ${oid} ${ref} ${'0'.repeat(40)}\n`,
      env: { ...env, npm_execpath: path.join(root, 'fake-npm.mjs'), HOOK_RESULT: resultFile },
      encoding: 'utf8',
      windowsHide: true,
    });
  const current = push('refs/tags/v-current', git('rev-parse', 'refs/tags/v-current'));
  assert.equal(current.status, 0, current.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), ['run', 'ci:verify', '--']);
  fs.rmSync(resultFile);
  const previous = push('refs/tags/v-previous', git('rev-parse', 'refs/tags/v-previous'));
  assert.equal(previous.status, 1);
  assert.match(previous.stderr, /checked-out commit/);
  assert.equal(fs.existsSync(resultFile), false);
  const missing = push('refs/tags/v-missing', 'c'.repeat(40));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not peel to a commit/);
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
      timeout: CLI_HANG_GUARD_MS,
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
  assert.match(source, /if \(requiresClrFixture\(suite\)\) requireClrFixtureFile\(\);/);
  assert.match(
    source,
    /function requireClrFixtureFile\(\) \{[\s\S]*?verifyClrSdk\(sdk\);[\s\S]*?environment\('PAQ_TEST_XRM_SDK', sdk\)/,
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
    const calls = [...source.matchAll(/spawnSync\(\s*'git',(?:[ \t]*\/\/[^\n]*)?\s*([^\n]+)/g)];
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

test('workflow tools pin every supported platform and an unsupported platform names that set', async () => {
  const { assets, workflowTools } = await import('../scripts/check-workflows.mjs');
  const expectedNames = {
    actionlint: {
      'win32-x64': 'actionlint_1.7.12_windows_amd64.zip',
      'linux-x64': 'actionlint_1.7.12_linux_amd64.tar.gz',
      'linux-arm64': 'actionlint_1.7.12_linux_arm64.tar.gz',
      'darwin-x64': 'actionlint_1.7.12_darwin_amd64.tar.gz',
      'darwin-arm64': 'actionlint_1.7.12_darwin_arm64.tar.gz',
    },
    shellcheck: {
      'win32-x64': 'shellcheck-v0.11.0.zip',
      'linux-x64': 'shellcheck-v0.11.0.linux.x86_64.tar.gz',
      'linux-arm64': 'shellcheck-v0.11.0.linux.aarch64.tar.gz',
      'darwin-x64': 'shellcheck-v0.11.0.darwin.x86_64.tar.gz',
      'darwin-arm64': 'shellcheck-v0.11.0.darwin.aarch64.tar.gz',
    },
  };
  const platforms = Object.keys(expectedNames.actionlint);
  assert.deepEqual(Object.keys(assets).sort(), [...platforms].sort());
  const versions = { actionlint: '1.7.12', shellcheck: '0.11.0' };
  for (const platform of platforms) {
    const [os, arch] = platform.split('-');
    assert.equal(workflowTools(os, arch), assets[platform], platform);
    for (const tool of ['actionlint', 'shellcheck']) {
      const [version, url, digest, , archiveName] = assets[platform][tool];
      assert.equal(version, versions[tool], `${tool} ${platform} version`);
      // Only the API asset form receives the token, so every platform downloads through it.
      assert.match(
        url,
        /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/,
        `${tool} ${platform}`,
      );
      assert.match(digest, /^[a-f0-9]{64}$/, `${tool} ${platform} digest`);
      assert.equal(archiveName, expectedNames[tool][platform], `${tool} ${platform} asset`);
    }
  }
  assert.throws(
    () => workflowTools('freebsd', 'x64'),
    (error) => platforms.every((platform) => error.message.includes(platform)) && !/container/.test(error.message),
  );
});

// An invented tool in a temporary cache: its archive bytes are the pin, so nothing here is an upstream release.
function inventedTool(t) {
  const cache = tempDirSync('paqvilo-tool-cache-');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const bytes = Buffer.from('invented workflow tool archive');
  const pin = createHash('sha256').update(bytes).digest('hex');
  const specification = ['1.0.0', 'https://api.github.com/repos/owner/tool/releases/assets/1', pin, 'tool', 'tool.zip'];
  const directory = path.join(cache, `tool-1.0.0-${process.platform}-${process.arch}`);
  const calls = [];
  const replying = (status) => async (url, init) => {
    calls.push({ url, authorization: new Headers(init.headers).get('authorization') });
    return new Response(null, { status });
  };
  return { cache, bytes, specification, directory, calls, replying };
}

test('a provisioned tool with a verified archive and receipt is served without a request', async (t) => {
  const { provision } = await import('../scripts/check-workflows.mjs');
  const { cache, bytes, specification, directory, calls, replying } = inventedTool(t);
  const target = path.join(directory, 'unpacked', 'tool');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(directory, 'tool.zip'), bytes);
  fs.writeFileSync(target, 'invented executable');
  const binary = createHash('sha256').update('invented executable').digest('hex');
  fs.writeFileSync(path.join(directory, 'verified.json'), JSON.stringify({ archive: specification[2], binary }));
  assert.equal(await provision('tool', specification, { cache, fetchImpl: replying(500) }), target);
  assert.deepEqual(calls, []);
});

// A restored archive is re-verified before any receipt is trusted; one that fails its pin is removed and downloaded once.
test('a cached archive that fails its pin is replaced by a verified download before the tool is served', async (t) => {
  const { provision } = await import('../scripts/check-workflows.mjs');
  const { cache, bytes, specification, directory, calls } = inventedTool(t);
  const target = path.join(directory, 'unpacked', 'tool');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(directory, 'tool.zip'), 'tampered archive');
  fs.writeFileSync(target, 'invented executable');
  const binary = createHash('sha256').update('invented executable').digest('hex');
  fs.writeFileSync(path.join(directory, 'verified.json'), JSON.stringify({ archive: specification[2], binary }));
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: new Headers(init.headers).get('authorization') });
    return new Response(bytes);
  };
  assert.equal(await provision('tool', specification, { cache, fetchImpl }), target);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'tool.zip')), bytes);
  assert.deepEqual(calls, [{ url: specification[1], authorization: null }]);
});

test('a tampered cached archive and a tampered download fail before extraction and leave no archive', async (t) => {
  const { provision } = await import('../scripts/check-workflows.mjs');
  const { cache, specification, directory, calls, replying } = inventedTool(t);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'tool.zip'), 'tampered archive');
  const fetchImpl = async (url, init) => {
    calls.push({ url, authorization: new Headers(init.headers).get('authorization') });
    return new Response('tampered download');
  };
  await assert.rejects(provision('tool', specification, { cache, fetchImpl }), {
    message: 'Archive digest mismatch; no unverified content was saved.',
  });
  // Neither the tampered archive nor anything unpacked from it remains.
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(calls.length, 1);
  // A later run finds nothing to trust and downloads again.
  await assert.rejects(provision('tool', specification, { cache, fetchImpl: replying(403) }), {
    message: 'Archive download failed from api.github.com: HTTP 403 (attempt 1).',
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('--provision provisions and verifies both tools and runs neither of them', async () => {
  const { checkWorkflows, workflowTools } = await import('../scripts/check-workflows.mjs');
  const tools = workflowTools();
  const record = (argv) => {
    const provisioned = [];
    const ran = [];
    const options = {
      argv,
      env: { GITHUB_TOKEN: 'invented-test-token' },
      provisionTool: async (name, specification, settings) => {
        provisioned.push([name, specification, settings]);
        return `/invented/${name}`;
      },
      run: (command) => ran.push(command),
    };
    return { provisioned, ran, options };
  };
  const expected = [
    ['actionlint', tools.actionlint, { token: 'invented-test-token' }],
    ['shellcheck', tools.shellcheck, { token: 'invented-test-token' }],
  ];
  const provisionOnly = record(['node', 'scripts/check-workflows.mjs', '--provision']);
  await checkWorkflows(provisionOnly.options);
  assert.deepEqual(provisionOnly.provisioned, expected);
  assert.deepEqual(provisionOnly.ran, []);
  const check = record(['node', 'scripts/check-workflows.mjs']);
  await checkWorkflows(check.options);
  assert.deepEqual(check.provisioned, expected);
  assert.deepEqual(check.ran, ['/invented/actionlint', '/invented/shellcheck']);
});

test('every pinned archive restore goes through the one verified-cache helper', () => {
  for (const [file, count] of [
    ['ci.mjs', 2],
    ['check-workflows.mjs', 1],
  ]) {
    const source = fs.readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8');
    assert.equal(source.match(/\bensureVerifiedArchive\(/g)?.length, count, file);
    assert.doesNotMatch(source, /downloadVerifiedArchive/, file);
  }
});

test('an absent archive is requested from the API with the token and a 403 stops provisioning', async (t) => {
  const { provision } = await import('../scripts/check-workflows.mjs');
  const { cache, specification, directory, calls, replying } = inventedTool(t);
  await assert.rejects(
    provision('tool', specification, { cache, token: 'invented-test-token', fetchImpl: replying(403) }),
    { message: 'Archive download failed from api.github.com: HTTP 403 (attempt 1).' },
  );
  assert.deepEqual(calls, [{ url: specification[1], authorization: 'Bearer invented-test-token' }]);
  assert.deepEqual(fs.readdirSync(directory), []);
});

// A pinned cache is restored before the step that produces it and saved by the step right after it (only saves
// between), on a miss of that restore and only when the files exist, with the same path and a key from step outputs.
const CACHE_PIN = /^actions\/cache(?:\/(restore|save))?@([0-9a-f]{40})$/;
function cachePair(label, steps, path, producer, enabled) {
  const restores = steps.filter(
    (step) => CACHE_PIN.exec(step.uses ?? '')?.[1] === 'restore' && step.with?.path === path,
  );
  const saves = steps.filter((step) => CACHE_PIN.exec(step.uses ?? '')?.[1] === 'save' && step.with?.path === path);
  assert.equal(restores.length, 1, `${label}: one restore of ${path}`);
  assert.equal(saves.length, 1, `${label}: one save of ${path}`);
  const [restore] = restores,
    [save] = saves;
  const restoreAt = steps.indexOf(restore),
    saveAt = steps.indexOf(save);
  assert.ok(restoreAt < producer, `${label}: restores before the producing step`);
  assert.ok(saveAt > producer, `${label}: saves after the producing step`);
  for (const step of steps.slice(producer + 1, saveAt))
    assert.equal(CACHE_PIN.exec(step.uses ?? '')?.[1], 'save', `${label}: only saves between producing and saving`);
  assert.ok(restore.id, `${label}: the restore has an id for its cache-hit output`);
  assert.equal(restore.if, enabled, `${label}: restore condition`);
  assert.equal(
    save.if,
    `${enabled} && steps.${restore.id}.outputs.cache-hit != 'true' && hashFiles('${path}') != ''`,
    `${label}: saved only on a miss, when the files exist`,
  );
  assert.deepEqual(save.with, restore.with, `${label}: the save uses the restore's path and key`);
  assert.deepEqual(Object.keys(restore.with).sort(), ['key', 'path'], `${label}: no restore-keys`);
  assert.doesNotMatch(restore.with.key, /hashFiles/, `${label}: the key does not hash a whole script`);
  assert.match(
    restore.with.key,
    /\$\{\{ steps\.[\w-]+\.outputs\.\w+ \}\}$/,
    `${label}: the key comes from a step output`,
  );
  return { restore, save };
}

test('the workflow token reaches only the step that provisions the pinned workflow tools', async () => {
  const source = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const ci = YAML.parse(source);
  const carriesToken = (env) =>
    Object.entries(env ?? {}).some(
      ([name, value]) => /^(GITHUB|GH)_TOKEN$/.test(name) || /github\.token|secrets\.GITHUB_TOKEN/.test(String(value)),
    );
  assert.equal(carriesToken(ci.env), false, 'workflow env');
  const holders = [];
  for (const [job, definition] of Object.entries(ci.jobs)) {
    assert.equal(carriesToken(definition.env), false, `${job} env`);
    for (const step of definition.steps) if (carriesToken(step.env)) holders.push({ job, step });
  }
  assert.deepEqual(
    holders.map(({ job, step }) => [job, step.name, step.run, step.env]),
    [
      [
        'checks',
        'Provision the pinned workflow tools',
        'node scripts/check-workflows.mjs --provision',
        { GITHUB_TOKEN: '${{ github.token }}' },
      ],
    ],
  );
  const steps = ci.jobs.checks.steps;
  const quality = steps.findIndex((step) => step.run === 'npm run quality');
  const provisioning = steps.indexOf(holders[0].step);
  const restore = steps.findIndex((step) => step.name === 'Restore the pinned workflow tool archives');
  const named = steps.findIndex((step) => step.id === 'tools');
  assert.ok(named >= 0 && named < restore, 'the key is printed before the restore');
  assert.equal(steps[named].run, 'node scripts/check-workflows.mjs --cache-key');
  assert.ok(restore >= 0 && restore < provisioning && provisioning < quality, 'restore, provision, then check');
  const pair = cachePair('ci/checks tools', steps, '.paqvilo/tools/*/*.tar.gz', provisioning, steps[quality].if);
  assert.ok(steps.indexOf(pair.save) < quality, 'saved before the checks that may fail');
  assert.ok(
    Object.values(ci.jobs).every((job) =>
      job.steps.every((step) => !step.run?.includes('npm run quality') || !step.env),
    ),
    'no step that runs npm run quality has an env of its own',
  );
  for (const index of [named, restore, provisioning]) assert.equal(steps[index].if, steps[quality].if);
  const cacheAction = [...new Set(source.match(/actions\/cache(?:\/restore|\/save)?@[0-9a-f]{40}\b/g))].map(
    (reference) => reference.split('@')[1],
  );
  assert.equal(new Set(cacheAction).size, 1, 'one pinned actions/cache commit');
  assert.equal(steps[restore].uses, `actions/cache/restore@${cacheAction[0]}`);
  // The job runs on Linux x64 only, where both pinned tool archives are .tar.gz files.
  assert.equal(ci.jobs.checks['runs-on'], 'ubuntu-24.04');
  const { assets } = await import('../scripts/check-workflows.mjs');
  for (const [, , , , archive] of Object.values(assets['linux-x64'])) assert.match(archive, /\.tar\.gz$/);
  assert.deepEqual(steps[restore].with, {
    path: '.paqvilo/tools/*/*.tar.gz',
    key: 'workflow-tools-${{ runner.os }}-${{ runner.arch }}-${{ steps.tools.outputs.key }}',
  });
});

test('the workflow tool cache key is a digest of the platform pins alone and reads nothing else', async (t) => {
  const { assets, workflowToolsCacheKey } = await import('../scripts/check-workflows.mjs');
  const keys = Object.keys(assets).map((platform) => workflowToolsCacheKey(...platform.split('-')));
  for (const key of keys) assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(new Set(keys).size, keys.length, 'each platform has its own key');
  const directory = tempDirSync('paqvilo-tools-key-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'output');
  fs.writeFileSync(output, 'earlier=kept\n');
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../scripts/check-workflows.mjs', import.meta.url)), '--cache-key'],
    {
      // An unreadable tool cache proves the key is computed without touching it.
      env: { ...process.env, GITHUB_OUTPUT: output, PAQVILO_TOOL_CACHE: path.join(directory, 'absent', 'cache') },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `key=${workflowToolsCacheKey()}\n`);
  assert.equal(fs.readFileSync(output, 'utf8'), `earlier=kept\nkey=${workflowToolsCacheKey()}\n`);
  assert.equal(fs.existsSync(path.join(directory, 'absent')), false);
});

test('every job that prepares fixtures restores the verified fixture archives before preparing', () => {
  const fixtureCaches = {
    ecosystem: {
      path: '.paqvilo/ci/ecosystem/*.tar.gz',
      key: 'ecosystem-fixtures-${{ runner.os }}-${{ steps.fixtures.outputs.ecosystem_key }}',
      output: 'ecosystem',
    },
    sdk: {
      path: '.paqvilo/ci/sdk-reference/sdk.zip',
      key: 'sdk-reference-${{ runner.os }}-${{ steps.fixtures.outputs.sdk_reference_key }}',
      output: 'sdk_reference',
    },
  };
  // Ecosystem archives serve the Linux and Windows unit lanes; the CLR SDK reference serves every Windows lane.
  // `ci:prepare --quality` downloads neither, so the static job needs no fixture cache.
  const expected = {
    'ci/test': ['ecosystem'],
    'ci/browser': ['sdk'],
    'ci/windows': ['ecosystem', 'sdk'],
    'sonarqube/coverage': ['ecosystem'],
  };
  const pins = new Set();
  const found = {};
  for (const name of ['ci', 'security', 'sonarqube']) {
    const source = fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    for (const reference of source.match(/actions\/cache(?:\/restore|\/save)?@[0-9a-f]{40}\b/g) ?? [])
      pins.add(reference.split('@')[1]);
    for (const [job, definition] of Object.entries(YAML.parse(source).jobs)) {
      const prepare = definition.steps.findIndex(
        (step) => step.run?.includes('ci:prepare') && !step.run.includes('--quality'),
      );
      if (prepare < 0) continue;
      // `ci.mjs fixtures` answers for exactly the arguments the prepare step passes, so each cache follows its answer.
      const select = definition.steps.findIndex((step) => step.id === 'fixtures');
      found[`${name}/${job}`] = definition.steps.flatMap((step, index) => {
        const cache = Object.entries(fixtureCaches).find(([, value]) => value.path === step.with?.path?.trim());
        if (!cache || CACHE_PIN.exec(step.uses)?.[1] === 'save') return [];
        assert.equal(CACHE_PIN.exec(step.uses)?.[1], 'restore', `${name}/${job} ${cache[0]} restores only`);
        cachePair(`${name}/${job} ${cache[0]}`, definition.steps, cache[1].path, prepare, step.if);
        assert.ok(index < prepare, `${name}/${job} restores ${cache[0]} before preparing`);
        assert.equal(step.with.key, cache[1].key, `${name}/${job} ${cache[0]} key`);
        assert.ok(select >= 0 && select < index, `${name}/${job} selects its fixtures before restoring ${cache[0]}`);
        assert.equal(step.if, `steps.fixtures.outputs.${cache[1].output} == 'true'`, `${name}/${job} ${cache[0]} if`);
        assert.equal(
          definition.steps[select].run,
          definition.steps[prepare].run.replace('npm run ci:prepare -- ', 'node scripts/ci.mjs fixtures '),
          `${name}/${job} selects fixtures with the prepare arguments`,
        );
        assert.equal(definition.steps[select].if, undefined, `${name}/${job} always selects its fixtures`);
        return [{ fixture: cache[0], uses: step.uses.split('@')[1] }];
      });
    }
  }
  assert.equal(pins.size, 1, 'every actions/cache step uses the one pinned commit');
  const [pin] = pins;
  assert.deepEqual(
    Object.fromEntries(Object.entries(found).map(([job, caches]) => [job, caches.map((cache) => cache.fixture)])),
    expected,
  );
  for (const caches of Object.values(found)) for (const cache of caches) assert.equal(cache.uses, pin);
});

test('ci.mjs fixtures answers for every CI lane what prepare with the same arguments downloads', async () => {
  const { laneFixtures, needsEcosystem, requiresClrFixture } = await import('../scripts/ci.mjs');
  const { ciLanes, browserLanes } = await import('../.github/scripts/change-scope.mjs');
  const suites = ['lense', 'mirage', 'examples'];
  const lanes = [
    ...ciLanes('unit', suites).flatMap((lane) =>
      ['linux', 'win32'].map((platform) => ({ ...lane, kind: 'unit', platform })),
    ),
    ...browserLanes(suites).map((lane) => ({
      ...lane,
      kind: 'browser',
      platform: lane.os.startsWith('windows') ? 'win32' : 'linux',
    })),
  ];
  for (const { suite, shard, kind, platform } of lanes) {
    const args = ['--suite', suite, `--${kind}`, ...(shard ? ['--shard', shard] : [])];
    assert.deepEqual(
      laneFixtures(args, platform),
      {
        ecosystem: needsEcosystem(suite, kind === 'unit', shard ?? null),
        sdk_reference: requiresClrFixture(suite, platform),
      },
      `${args.join(' ')} on ${platform}`,
    );
  }
  const shardsWithEcosystem = ciLanes('unit', ['mirage']).filter(
    (lane) => laneFixtures(['--suite', 'mirage', '--unit', '--shard', lane.shard], 'linux').ecosystem,
  );
  assert.equal(shardsWithEcosystem.length, 1, 'exactly one Mirage unit shard runs the ecosystem import checks');
  assert.deepEqual(laneFixtures(['--suite', 'mirage', '--unit'], 'linux'), { ecosystem: true, sdk_reference: false });
  assert.deepEqual(laneFixtures(['--suite', 'mirage', '--browser', '--shard', '1/2'], 'win32'), {
    ecosystem: false,
    sdk_reference: true,
  });
  // Arguments prepare refuses are refused here too.
  assert.throws(() => laneFixtures(['--suite', 'examples', '--unit', '--shard', '1/2'], 'linux'), /--shard/);
  assert.throws(() => laneFixtures(['--suite', 'none', '--unit'], 'linux'), /^Error: Unknown CI suite: none$/);
  // prepare decides its downloads with the same two functions and the same argument mapping.
  const source = fs.readFileSync(new URL('../scripts/ci.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /if \(requiresClrFixture\(suite\)\) await clrFixture\(\);\n\s+if \(needsEcosystem\(suite, unit, shard\)\) await ecosystemFixtures\(\);/,
  );
  assert.match(
    source,
    /if \(command === 'prepare'\) return \{ handled: true, result: prepareLane\(\.\.\.prepareSelection\(values\)\) \};/,
  );
});

test('ci.mjs fixtures appends its answer to the step outputs', async (t) => {
  const directory = tempDirSync('paqvilo-fixtures-output-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'output');
  fs.writeFileSync(output, 'earlier=kept\n');
  const script = fileURLToPath(new URL('../scripts/ci.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'fixtures', '--suite', 'lense', '--browser'], {
    env: { ...process.env, GITHUB_OUTPUT: output },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const { fixtureCacheKeys } = await import('../scripts/ci.mjs');
  const { ecosystem_key: ecosystem, sdk_reference_key: sdk } = fixtureCacheKeys();
  const answer = `ecosystem=false\nsdk_reference=false\necosystem_key=${ecosystem}\nsdk_reference_key=${sdk}\n`;
  assert.equal(result.stdout, answer);
  assert.equal(fs.readFileSync(output, 'utf8'), 'earlier=kept\n' + answer);
});

test('fixture cache keys are digests of the pinned archive URLs and digests alone', async () => {
  const { fixtureCacheKeys } = await import('../scripts/ci.mjs');
  const keys = fixtureCacheKeys();
  assert.deepEqual(Object.keys(keys), ['ecosystem_key', 'sdk_reference_key']);
  for (const key of Object.values(keys)) assert.match(key, /^[0-9a-f]{64}$/);
  // Rebuilt from the pins as written in ci.mjs: the archive URLs and their SHA-256 digests, nothing else.
  const source = fs.readFileSync(new URL('../scripts/ci.mjs', import.meta.url), 'utf8');
  const sha = (pins) => createHash('sha256').update(JSON.stringify(pins)).digest('hex');
  const ecosystem = [
    ...source.matchAll(/^ {4}'([\w-]+\/[\w-]+)',\n {4}'([0-9a-f]{40})',\n {4}'([0-9a-f]{64})',$/gm),
  ].map(([, repository, commit, digest]) => [`https://codeload.github.com/${repository}/tar.gz/${commit}`, digest]);
  assert.equal(ecosystem.length, 5);
  assert.equal(keys.ecosystem_key, sha(ecosystem));
  const version = /const SDK_VERSION = '([\d.]+)'/.exec(source)[1],
    digest = /const SDK_SHA256 = '([0-9a-f]{64})'/.exec(source)[1];
  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.crmsdk.coreassemblies/${version}/microsoft.crmsdk.coreassemblies.${version}.nupkg`;
  assert.equal(keys.sdk_reference_key, sha([[url, digest]]));
});

test('every third-party workflow action is allowed by the repository admin policy', async () => {
  const { selectedActionsPolicy } = await import('../scripts/github-admin.mjs');
  const allowed = selectedActionsPolicy?.patterns_allowed;
  assert.ok(Array.isArray(allowed), 'github-admin exports the selected-actions policy');
  const matches = (pattern, reference) =>
    pattern.endsWith('*') ? reference.startsWith(pattern.slice(0, -1)) : reference === pattern;
  const uses = [];
  const collectUses = (node) => {
    if (Array.isArray(node)) node.forEach(collectUses);
    else if (node && typeof node === 'object')
      for (const [key, value] of Object.entries(node)) {
        if (key === 'uses' && typeof value === 'string') uses.push(value);
        else collectUses(value);
      }
  };
  const githubRoot = fileURLToPath(new URL('../.github', import.meta.url));
  const definitions = [
    ...fs.readdirSync(path.join(githubRoot, 'workflows')).map((name) => path.join(githubRoot, 'workflows', name)),
    ...(fs.existsSync(path.join(githubRoot, 'actions'))
      ? fs
          .readdirSync(path.join(githubRoot, 'actions'), { recursive: true })
          .map((name) => path.join(githubRoot, 'actions', name))
      : []),
  ].filter((file) => /\.ya?ml$/.test(file));
  for (const file of definitions) collectUses(YAML.parse(fs.readFileSync(file, 'utf8')));
  const thirdParty = uses.filter((reference) => !/^(\.\/|actions\/|github\/)/.test(reference));
  assert.ok(thirdParty.includes('SonarSource/sonarqube-scan-action@4d1dc0c91ee400dcf8a6dddf2f705ac36542e304'));
  assert.deepEqual(
    thirdParty.filter((reference) => !allowed.some((pattern) => matches(pattern, reference))),
    [],
  );
});

test('npm CLI resolution finds the bundled npm in Windows and POSIX Node layouts', async (t) => {
  const ci = await import('../scripts/ci.mjs');
  const audit = await import('../scripts/audit-dependencies.mjs');
  const root = tempDirSync('paqvilo-npm-cli-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const windowsNode = path.join(root, 'windows', 'node.exe');
  const windowsCli = path.join(root, 'windows', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const posixNode = path.join(root, 'posix', 'bin', 'node');
  const posixCli = path.join(root, 'posix', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  for (const cli of [windowsCli, posixCli]) {
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '');
  }
  for (const npmCliPath of [ci.npmCliPath, audit.npmCliPath]) {
    assert.equal(npmCliPath(windowsNode, {}), windowsCli);
    assert.equal(npmCliPath(posixNode, {}), posixCli);
    assert.equal(npmCliPath(posixNode, { npm_execpath: '/custom/npm-cli.js' }), '/custom/npm-cli.js');
  }
});

test('package smoke work directory is removed after success and failure without masking the outcome', async (t) => {
  const { withWorkDirectory } = await import('../scripts/package-smoke.mjs');
  const parent = tempDirSync('paqvilo-smoke-parent-');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const removed = [];
  const reports = [];
  const remove = (directory) => removed.push(directory);
  const report = (message) => reports.push(message);
  const fail = async () => {
    throw new Error('smoke failed');
  };
  assert.equal(await withWorkDirectory(parent, async () => 'ok', { remove, report }), 'ok');
  assert.equal(removed.length, 1, 'success removes the work directory');
  await assert.rejects(withWorkDirectory(parent, fail, { remove, report }), /smoke failed/);
  assert.equal(removed.length, 2, 'failure removes the work directory');
  for (const directory of removed) assert.equal(path.dirname(directory), parent);
  const failingRemove = () => {
    throw new Error('directory is locked');
  };
  await assert.rejects(withWorkDirectory(parent, fail, { remove: failingRemove, report }), /smoke failed/);
  assert.match(reports.at(-1), /directory is locked/);
  await withWorkDirectory(parent, async () => 'kept', { keep: true, remove, report });
  assert.equal(removed.length, 2, 'keep leaves the work directory in place');
  assert.match(reports.at(-1), /Kept smoke work directory/);
});

test('the storage volume lane verifies every functional assertion without wall-clock limits', () => {
  const lane = fileURLToPath(new URL('../mirage/test-volume/state-storage.mjs', import.meta.url));
  const ci = fs.readFileSync(fileURLToPath(new URL('../scripts/ci.mjs', import.meta.url)), 'utf8');
  assert.ok(ci.includes("'mirage/test-volume/state-storage.mjs'"), 'the CI storage lane runs this file');
  const calls = [];
  const visit = (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'verifyStateStorage'
    )
      calls.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.filter((item) => typeof item?.type === 'string').forEach(visit);
      else if (typeof value?.type === 'string') visit(value);
    }
  };
  visit(parse(fs.readFileSync(lane, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }));
  assert.equal(calls.length, 1);
  const [options] = calls[0].arguments;
  assert.equal(options?.type, 'ObjectExpression', 'the lane passes an options object');
  const timeLimits = options.properties.find((property) => property.key?.name === 'timeLimits');
  assert.equal(timeLimits?.value.value, false);
});

test('package cache primer removes its preparation directory after success, failure and with keep', (t) => {
  const script = fileURLToPath(new URL('../scripts/prime-package-cache.mjs', import.meta.url));
  const dir = tempDirSync('paqvilo-prime-cache-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'npm-shrinkwrap.json'), JSON.stringify({ packages: {} }));
  fs.mkdirSync(path.join(dir, 'examples', 'project'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'examples', 'project', 'package.json'), '{}');
  fs.writeFileSync(
    path.join(dir, 'fake-npm.mjs'),
    [
      "import fs from 'node:fs';",
      'const [command] = process.argv.slice(2);',
      "if (command === 'pack') {",
      '  if (process.env.FAKE_NPM_FAIL_PACK) process.exit(1);',
      "  console.log(JSON.stringify([{ filename: 'paqvilo-0.0.0.tgz' }]));",
      "} else if (command === 'install') fs.writeFileSync('package-lock.json', JSON.stringify({ packages: {} }));",
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  const primer = (env) =>
    spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, PAQVILO_KEEP_WORK: '', npm_execpath: path.join(dir, 'fake-npm.mjs'), ...env },
      encoding: 'utf8',
      windowsHide: true,
    });
  const leftovers = () =>
    fs.readdirSync(path.join(dir, '.paqvilo', 'distribution')).filter((name) => name.startsWith('cache-'));
  const success = primer({});
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(leftovers(), []);
  const failure = primer({ FAKE_NPM_FAIL_PACK: '1' });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /Cannot prepare consumer cache/);
  assert.deepEqual(leftovers(), []);
  const kept = primer({ FAKE_NPM_FAIL_PACK: '1', PAQVILO_KEEP_WORK: '1' });
  assert.equal(kept.status, 1);
  assert.equal(leftovers().length, 1);
  assert.ok(kept.stderr.includes(path.join(dir, '.paqvilo', 'distribution', leftovers()[0])));
});
