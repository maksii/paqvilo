import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { validateCommitMessage } from '../scripts/conventional-commit.mjs';
import { classifyChanges, preCommitScripts } from '../.github/scripts/change-scope.mjs';

test('commit gates accept Conventional Commits and reject malformed subjects/bodies', () => {
  for (const message of ['feat: add preview', 'fix(lense)!: change contract\n\nBREAKING CHANGE: explicit identity required', 'revert: undo change', 'perf(mirage): speed up rendering']) assert.doesNotThrow(() => validateCommitMessage(message));
  for (const message of ['', 'fix bug', 'fix: ', 'fix(scope) change', 'feat: change\nbody without blank line', ' fix: change']) assert.throws(() => validateCommitMessage(message));
});

test('secondary edits skip runtime jobs but packaged documentation retains release checks', () => {
  assert.deepEqual(classifyChanges(['docs/coverage.md', 'README.md']), { runtime: false, package: true, dependencies: false });
  for (const file of ['mirage/README.md', 'mirage/docs/dataverse-api.md', 'examples/project/README.md', 'examples/company-operations/plugins/README.md', 'AGENTS.md', 'LICENSE', 'NOTICE']) {
    assert.deepEqual(classifyChanges([file]), { runtime: false, package: true, dependencies: false }, file);
  }
  assert.deepEqual(classifyChanges(['site/index.html', '.github/ISSUE_TEMPLATE/bug.yml']), { runtime: false, package: false, dependencies: false });
  for (const file of ['lense/cli.mjs', 'mirage/lib/server.mjs', 'test/cli.test.mjs', '.github/workflows/ci.yml', '.github/scripts/change-scope.mjs', 'new-runtime/index.mjs', '.env.example']) assert.equal(classifyChanges([file]).runtime, true, file);
  assert.equal(classifyChanges(['mirage/package-lock.json']).dependencies, true);
});

test('local validation reserves runtime suites and package smoke for code, dependencies and unknown paths', () => {
  assert.deepEqual(preCommitScripts(['README.md']), ['release:check']);
  assert.deepEqual(preCommitScripts(['mirage/docs/operations.md', 'docs/faq.md']), ['release:check']);
  assert.deepEqual(preCommitScripts(['site/style.css']), ['site:build']);
  assert.deepEqual(preCommitScripts(['docs/assets/overview.svg', 'README.md']), ['release:check', 'site:build']);
  assert.deepEqual(preCommitScripts(['.github/workflows/pages.yml']), ['site:build']);
  assert.deepEqual(preCommitScripts(['.github/ISSUE_TEMPLATE/bug.yml', 'SECURITY.md']), []);
  assert.deepEqual(preCommitScripts([]), []);
  for (const files of [['README.md', 'lense/cli.mjs'], ['package.json'], ['new-runtime/index.mjs'], ['scripts/git-hooks.mjs']]) {
    assert.deepEqual(preCommitScripts(files), ['validate', 'release:smoke']);
  }
  assert.deepEqual(preCommitScripts(['lense/cli.mjs', 'site/index.html']), ['validate', 'release:smoke', 'site:build']);
  assert.deepEqual(preCommitScripts(['scripts/build-site.mjs']), ['validate', 'release:smoke', 'site:build']);
  assert.deepEqual(preCommitScripts(['templates/project/README.md']), ['validate', 'release:smoke']);
});

test('documentation CI keeps required gates without installing dependencies or scheduling runtime/security suites', () => {
  const read = name => YAML.parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const ci = read('ci');
  const security = read('security');
  const runtime = "needs.changes.outputs.runtime == 'true'";
  for (const name of ['test', 'windows', 'package']) assert.equal(ci.jobs[name].if, runtime, name);
  assert.equal(ci.jobs.checks.steps.find(step => step.name === 'Install locked dependencies').if, runtime);
  assert.equal(security.jobs.codeql.if, runtime);
  assert.match(security.jobs['dependency-review'].if, /needs\.changes\.outputs\.dependencies == 'true'/);
  for (const workflow of [ci, security]) {
    assert.equal(workflow.jobs.gate.if, 'always()');
    assert.equal(workflow.on.pull_request.paths, undefined, 'required gates must report on documentation PRs');
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-gates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'core.hooksPath', '.no-hooks');
  const write = (name, contents) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  return { root, env, git, write };
}

test('PR scope excludes unrelated base-branch code but includes both sides of renames', t => {
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
    const result = spawnSync(process.execPath, [script], { cwd: root, env: {
      ...env, GITHUB_EVENT_PATH: path.join(root, 'event.json'), GITHUB_OUTPUT: path.join(root, 'output.txt'),
      GITHUB_EVENT_NAME: 'pull_request', VALIDATE_ALL: 'false', ...extra,
    }, encoding: 'utf8', windowsHide: true });
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
  for (const name of ['scripts/git-hooks.mjs', 'scripts/ensure-dependencies.mjs', '.github/scripts/change-scope.mjs']) {
    write(name, fs.readFileSync(new URL(`../${name}`, import.meta.url)));
  }
  if (classifier) write('.github/scripts/change-scope.mjs', classifier);
  if (readyDependencies) write('scripts/ensure-dependencies.mjs', 'export const dependencyReadiness = () => ({ ready: true });');
  write('package.json', '{"type":"module"}');
  write('README.md', 'original');
  write('SECURITY.md', 'original');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const run = (extra = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/git-hooks.mjs'), 'pre-commit'], {
    cwd: root, env: { ...env, npm_execpath: '', ...extra }, encoding: 'utf8', windowsHide: true,
  });
  const assertCleaned = () => assert.deepEqual(fs.readdirSync(path.join(root, '.paqvilo', 'hooks')), [], 'owned snapshots were cleaned');
  return { root, env, git, write, run, assertCleaned };
}

test('README-only hook isolates staged sources and gate selection from unstaged edits', t => {
  const { root, git, write, run, assertCleaned } = hookFixture(t);
  write('README.md', 'staged');
  git('add', 'README.md');
  write('README.md', 'unstaged');
  write('.github/scripts/change-scope.mjs', 'export const preCommitScripts = () => [];');
  const npmCli = path.join(root, 'fake-npm.mjs');
  write('fake-npm.mjs', `import fs from 'node:fs';
    fs.writeFileSync(process.env.HOOK_RESULT, JSON.stringify({
      args: process.argv.slice(2), readme: fs.readFileSync('README.md', 'utf8'), cwd: process.cwd()
    }));
    if (process.argv[3] !== 'release:check') process.exit(1);
  `);
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

test('staged path leading whitespace remains unknown and receives full validation', t => {
  const { root, git, write, run, assertCleaned } = hookFixture(t, { readyDependencies: true });
  // A legitimate directory name, including on Windows. Trimming the NUL output
  // would turn this into the documentation allowlist's docs/ path.
  const unknown = ' docs/runtime.mjs';
  write(unknown, 'export const value = 1;');
  git('add', '--', unknown);
  const resultFile = path.join(root, 'result.jsonl');
  const npmCli = path.join(root, 'fake-npm.mjs');
  write('fake-npm.mjs', `import fs from 'node:fs';
    fs.appendFileSync(process.env.HOOK_RESULT, JSON.stringify(process.argv.slice(2)) + '\\n');
  `);
  const result = run({ npm_execpath: npmCli, HOOK_RESULT: resultFile });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(resultFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [['run', 'validate'], ['run', 'release:smoke']]);
  assertCleaned();
});

test('no-check hook needs no npm or dependencies and still removes its snapshot', t => {
  const { git, write, run, assertCleaned } = hookFixture(t);
  write('SECURITY.md', 'updated policy');
  git('add', 'SECURITY.md');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no applicable checks/);
  assertCleaned();
});

test('no-check hook rejects an index changed during staged gate selection', t => {
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
