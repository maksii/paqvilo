// @test-kind tooling: scripts/ci.mjs validation receipts, sharding, concurrency and revocation
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tempDirSync } from './fixture.mjs';
import { boundedCommand, COMMAND_HANG_GUARD_MS } from './helpers/bounded-command.mjs';
import { operationBudget, countOperations } from './helpers/operation-budget.mjs';

function ciFixture(t) {
  const directory = tempDirSync('paq-ci-receipt-command-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const write = (relative, content) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  for (const file of [
    'scripts/ci.mjs',
    'scripts/ci-workspace-lease.mjs',
    'scripts/npm-cli.mjs',
    '.github/scripts/change-scope.mjs',
    // The lane stop and signal helpers that scripts/ci.mjs imports.
    'lense/code-app-dev-stop.mjs',
    'lense/signal-forwarding.mjs',
    'lense/cli-options.mjs',
  ])
    write(file, fs.readFileSync(new URL(`../${file}`, import.meta.url)));
  // Identity reads start PowerShell on Windows. Every lease and lane identity here is a fixture value, because the
  // subject of this file is the receipt and lane sequencing, not the identity of a process.
  write(
    'lense/process-identity.mjs',
    `export function isAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false;
     try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
   export const processIdentity = (pid) => (isAlive(pid) ? 'fixture:' + pid : null);
   export const processIdentityAsync = async (pid) => processIdentity(pid);
   export async function endRecordedWindowsProcess() { return 'refused'; }`,
  );
  write(
    'scripts/ensure-dependencies.mjs',
    'export const dependencyReadiness = () => ({ ready: true }); export const browserExecutable = async () => ({ path: null });',
  );
  write(
    'scripts/verified-download.mjs',
    'export function ensureVerifiedArchive() { throw new Error("Unexpected download"); } export function extractZipOnWindows() { throw new Error("Unexpected extraction"); }',
  );
  const env = { ...process.env, GITHUB_ACTIONS: 'false' };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  delete env.PAQ_TEST_XRM_SDK;
  // Inherited, this makes a nested `node --test` skip every file and still exit 0.
  delete env.NODE_TEST_CONTEXT;
  return { directory, write, env };
}

function commitReceiptFixture({ directory, env }, message) {
  const git = (...args) => {
    const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=.no-hooks', ...args], {
      cwd: directory,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: COMMAND_HANG_GUARD_MS,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', message);
  return git;
}

function receiptFixtureIdentity({ directory, env }, git) {
  const dotnet = spawnSync('dotnet', ['--version'], {
    cwd: directory,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: COMMAND_HANG_GUARD_MS,
  });
  return {
    tree: git('rev-parse', 'HEAD^{tree}'),
    node: process.version,
    npm: '1.0.0',
    platform: process.platform,
    arch: process.arch,
    nodeOptions: env.NODE_OPTIONS ?? '',
    playwright: '1.0.0',
    browserChannel: 'chromium',
    browserExecutable: null,
    browserHeadlessShell: null,
    localBrowsers: (process.platform === 'win32' ? ['chromium', 'msedge'] : ['chromium'])
      .map((channel) => `${channel}:null:null`)
      .join('|'),
    tedious: null,
    clrSdk: null,
    dotnet: dotnet.status === 0 ? dotnet.stdout.trim() : null,
  };
}

test('a redirected receipt directory is rejected before even invalid verification can delete its receipt', async (t) => {
  const { directory, env } = ciFixture(t),
    outside = tempDirSync('paq-external-receipt-');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const receipt = path.join(outside, 'verification.json');
  fs.writeFileSync(receipt, 'other checkout');
  fs.mkdirSync(path.join(directory, '.paqvilo/ci'), { recursive: true });
  fs.symlinkSync(outside, path.join(directory, '.paqvilo/ci/runs'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await boundedCommand(
    t,
    process.execPath,
    [path.join(directory, 'scripts/ci.mjs'), 'verify', '--unknown-option'],
    {
      cwd: directory,
      env,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /CI state must stay inside/);
  assert.equal(fs.readFileSync(receipt, 'utf8'), 'other checkout');
});

test('a failed prepared suite revokes an earlier full receipt through the CI command', async (t) => {
  const { directory, write, env } = ciFixture(t);
  const npmCli = write(
    'fake-npm.mjs',
    `import assert from 'node:assert/strict';
    assert.deepEqual(process.argv.slice(2), ['run', 'test']);
    console.error('Invented suite failure');
    process.exit(37);
  `,
  );
  const receipt = write(
    '.paqvilo/ci/runs/verification.json',
    JSON.stringify({ identity: { tree: 'previously-passing-tree' }, scope: { lense: true }, full: true }),
  );
  env.npm_execpath = npmCli;
  const result = await boundedCommand(
    t,
    process.execPath,
    [path.join(directory, 'scripts/ci.mjs'), 'verify', '--suite', 'lense', '--unit', '--prepared'],
    { cwd: directory, env },
  );
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /Invented suite failure/);
  assert.match(result.stderr, /failed \(37\)/);
  assert.doesNotMatch(result.stdout, /reused|completed without errors/);
  assert.equal(fs.existsSync(receipt), false, 'a previous full pass cannot survive a failed suite rerun');
});

// Eleven CI commands: 2 shards, 2 overshards, 1 empty glob and 6 invalid arguments.
test(
  'unit shards run the package test script over disjoint files that together cover the suite',
  { timeout: operationBudget(11, COMMAND_HANG_GUARD_MS) },
  async (t) => {
    const { directory, write, env } = ciFixture(t);
    write('package.json', JSON.stringify({ scripts: { test: 'node --test --test-concurrency=1 test/*.test.mjs' } }));
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      write(
        `test/${name}.test.mjs`,
        `import fs from 'node:fs'; fs.appendFileSync(process.env.SHARD_LOG, ${JSON.stringify(name + '\n')});`,
      );
    write(
      'test/nested/default-discovery-sentinel.test.mjs',
      `import fs from 'node:fs'; fs.appendFileSync(process.env.SHARD_LOG, 'DEFAULT-DISCOVERY-RAN\\n');`,
    );
    env.npm_execpath = write('fake-npm.mjs', 'process.exit(99);');
    const ci = countOperations(t, 11, (...args) =>
      boundedCommand(t, process.execPath, [path.join(directory, 'scripts/ci.mjs'), ...args], { cwd: directory, env }),
    );
    const ran = [];
    for (const shard of ['1/2', '2/2']) {
      env.SHARD_LOG = path.join(directory, `shard-${shard[0]}.log`);
      const result = await ci('verify', '--suite', 'lense', '--unit', '--prepared', '--shard', shard);
      assert.equal(result.status, 0, result.stderr);
      ran.push(fs.readFileSync(env.SHARD_LOG, 'utf8').trim().split('\n').sort());
    }
    // Shards own sorted file indexes 0, 2, 4 and 1, 3.
    assert.deepEqual(ran, [
      ['a', 'c', 'e'],
      ['b', 'd'],
    ]);
    for (const shard of ['6/6', '1/6']) {
      env.SHARD_LOG = path.join(directory, `overshard-${shard.replace('/', '-')}.log`);
      const result = await ci('verify', '--suite', 'lense', '--unit', '--prepared', '--shard', shard);
      const executedFixtures = fs.existsSync(env.SHARD_LOG)
        ? fs.readFileSync(env.SHARD_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean)
        : [];
      if (result.status !== 1 || executedFixtures.length)
        t.diagnostic(JSON.stringify({ shard, exit: result.status, executedFixtures }));
      assert.equal(result.status, 1, `${shard}: ${result.stderr}`);
      assert.match(result.stderr, /shards exceed the 5 matched test files/);
      assert.doesNotMatch(result.stdout, /^> .*\btest\b/m, 'an invalid shard must not launch the test script');
      assert.equal(fs.existsSync(env.SHARD_LOG), false, 'an invalid shard must not fall through to default discovery');
    }
    write('package.json', JSON.stringify({ scripts: { test: 'node --test --test-concurrency=1 missing/*.test.mjs' } }));
    env.SHARD_LOG = path.join(directory, 'empty-glob.log');
    const empty = await ci('verify', '--suite', 'lense', '--unit', '--prepared', '--shard', '1/1');
    assert.equal(empty.status, 1, empty.stderr);
    assert.match(empty.stderr, /test glob matched no files/);
    assert.doesNotMatch(empty.stdout, /^> .*\btest\b/m, 'an empty glob must be rejected before Node starts');
    assert.equal(fs.existsSync(env.SHARD_LOG), false);
    for (const args of [
      ['--suite', 'lense', '--unit', '--shard', '3/2'],
      ['--suite', 'lense', '--unit', '--shard', '0/2'],
      ['--suite', 'lense', '--unit', '--shard', 'x'],
      ['--suite', 'examples', '--unit', '--shard', '1/2'],
      ['--suite', 'lense', '--shard', '1/2'],
      ['--full', '--shard', '1/2'],
    ]) {
      const result = await ci('verify', '--prepared', ...args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, /--shard|--full/, args.join(' '));
    }
  },
);

test('Chromium system libraries are installed only where root is available without a prompt', async () => {
  const { chromiumInstallArguments } = await import('../scripts/ci.mjs');
  assert.deepEqual(
    chromiumInstallArguments('linux', () => true),
    ['node_modules/playwright-core/cli.js', 'install', '--with-deps', 'chromium'],
  );
  assert.deepEqual(
    chromiumInstallArguments('linux', () => false),
    ['node_modules/playwright-core/cli.js', 'install', 'chromium'],
  );
  assert.deepEqual(
    chromiumInstallArguments('win32', () => true),
    ['node_modules/playwright-core/cli.js', 'install', 'chromium'],
  );
});

test(
  'explicit full validation executes fresh steps even with an identical earlier full receipt',
  { timeout: operationBudget(2, COMMAND_HANG_GUARD_MS) },
  async (t) => {
    const { directory, write, env } = ciFixture(t);
    // The full run reaches the validation lanes, where local Windows validation creates paqvilo-validation-temporary
    // under its temporary directory (runnerTemporaryDirectory in scripts/ci.mjs). The commands get a temporary
    // directory inside the fixture, ignored by its .gitignore, so the fixture's removal covers what they create.
    env.TEMP = env.TMP = path.join(directory, '.paqvilo', 'temporary');
    fs.mkdirSync(env.TEMP, { recursive: true });
    // Keep the command fixture small: its full plan has the CodeQL and SDK gates,
    // with readiness supplied by invented fixtures. Production lane selection is
    // independently covered by the contribution-gate and parity suites.
    write(
      '.github/scripts/change-scope.mjs',
      'export const classifyChanges = (_files, { full = false } = {}) => ({ full, codeql: true }); export const suitesForScope = () => [];',
    );
    write('scripts/sdk-preparation.mjs', 'export function requireSdkFixtures() {}');
    write(
      'scripts/codeql.mjs',
      'import fs from "node:fs"; fs.writeFileSync(".paqvilo/fresh-full-step", "executed"); console.error("Invented fresh full-gate failure"); process.exitCode = 42;',
    );
    write('.gitignore', '.paqvilo/\nnode_modules/\n');
    write('package.json', '{}');
    write('node_modules/playwright-core/package.json', JSON.stringify({ name: 'playwright-core', version: '1.0.0' }));
    write(
      'node_modules/playwright-core/index.js',
      'exports.chromium = { executablePath: () => require("node:path").join(__dirname, "missing-browser") };',
    );
    env.npm_execpath = write(
      'fake-npm.mjs',
      'if(process.argv[2]==="--version") console.log("1.0.0"); else if(process.argv.slice(2).join(" ")!=="run audit:dependencies"&&process.argv.slice(2,4).join(" ")!=="audit signatures") process.exit(99);',
    );
    env.PAQ_CI_BROWSER = 'chromium';
    env.PAQ_CI_REPEAT = '0';
    env.PAQ_CI_JOBS = '1';
    const git = commitReceiptFixture({ directory, env }, 'test: full receipt fixture');
    const receipt = write(
      '.paqvilo/ci/runs/verification.json',
      JSON.stringify({
        full: true,
        identity: receiptFixtureIdentity({ directory, env }, git),
      }),
    );
    const ci = countOperations(t, 2, (...args) =>
      boundedCommand(t, process.execPath, [path.join(directory, 'scripts/ci.mjs'), ...args], { cwd: directory, env }),
    );
    const cached = await ci('verify', '--base', 'HEAD', '--prepared');
    assert.equal(cached.status, 0, cached.error?.message ?? cached.stdout + cached.stderr);
    assert.match(cached.stdout, /reused full deterministic validation/);
    assert.equal(fs.existsSync(path.join(directory, '.paqvilo/fresh-full-step')), false);
    assert.equal(fs.existsSync(receipt), true, 'the same identity qualifies for scoped reuse');
    const result = await ci('verify', '--full', '--prepared');
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.match(result.stdout + result.stderr, /Invented fresh full-gate failure/);
    assert.equal(fs.readFileSync(path.join(directory, '.paqvilo/fresh-full-step'), 'utf8'), 'executed');
    assert.doesNotMatch(result.stdout, /reused .*deterministic validation/);
    assert.equal(fs.existsSync(receipt), false, 'a failed explicit full run revokes the earlier qualifying receipt');
  },
);

test('cached validation cannot restore a receipt after source changes during dependency audits', async (t) => {
  const { directory, write, env } = ciFixture(t);
  write('.gitignore', '.paqvilo/\nnode_modules/\n');
  write('README.md', 'Previously verified source');
  write('package.json', '{}');
  write('node_modules/playwright-core/package.json', JSON.stringify({ name: 'playwright-core', version: '1.0.0' }));
  write(
    'node_modules/playwright-core/index.js',
    'exports.chromium = { executablePath: () => require("node:path").join(__dirname, "missing-browser") };',
  );
  env.npm_execpath = write(
    'fake-npm.mjs',
    `import fs from 'node:fs';
    if (process.argv[2] === '--version') console.log('1.0.0');
    else if (process.argv.slice(2).join(' ') === 'run audit:dependencies') fs.writeFileSync('README.md', 'Changed during audit');
    else if (process.argv.slice(2, 4).join(' ') !== 'audit signatures') process.exit(99);
  `,
  );
  const git = commitReceiptFixture({ directory, env }, 'test: receipt fixture');
  const receipt = write(
    '.paqvilo/ci/runs/verification.json',
    JSON.stringify({
      identity: receiptFixtureIdentity({ directory, env }, git),
      full: true,
    }),
  );
  const result = await boundedCommand(
    t,
    process.execPath,
    [path.join(directory, 'scripts/ci.mjs'), 'verify', '--base', 'HEAD', '--prepared'],
    { cwd: directory, env },
  );
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /changed during dependency audits/);
  assert.equal(fs.readFileSync(path.join(directory, 'README.md'), 'utf8'), 'Changed during audit');
  assert.equal(fs.existsSync(receipt), false, 'a source change during audit revokes previous qualifying evidence');
});

test('validation concurrency follows the contributor setting, else the machine, and stays serial on hosted CI', async () => {
  const { validationJobs } = await import('../scripts/ci.mjs');
  const GiB = 2 ** 30;
  assert.equal(validationJobs({}, null, { cpus: 20, memory: 96 * GiB }), 5);
  assert.equal(validationJobs({}, null, { cpus: 4, memory: 16 * GiB }), 1);
  assert.equal(validationJobs({}, null, { cpus: 32, memory: 8 * GiB }), 2, 'memory bounds a many-core machine');
  assert.equal(validationJobs({ GITHUB_ACTIONS: 'true' }, null, { cpus: 20, memory: 96 * GiB }), 1);
  assert.equal(validationJobs({}, '3'), 3);
  assert.equal(validationJobs({ PAQ_CI_JOBS: '2' }, '3'), 2, 'the environment overrides Git configuration');
  for (const value of ['0', '-1', 'two', '1.5'])
    assert.throws(() => validationJobs({ PAQ_CI_JOBS: value }), /positive integer/, value);
});

// @test-kind tooling: real validation subprocesses share the machine budget rather than each multiplying its process pool.
test('parallel validation budgets fixture processes across every lane and command', async (t) => {
  const { runSteps } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-ci-process-budget-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const helper = new URL('../mirage/test/process-slots.mjs', import.meta.url).href;
  fs.writeFileSync(
    path.join(directory, 'probe.mjs'),
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { withProcessSlot, PROCESS_SLOTS } from ${JSON.stringify(helper)};
    assert.equal(process.env.PAQ_TEST_PROCESS_SLOTS, '1');
    assert.equal(PROCESS_SLOTS, 1);
    const gate = Promise.withResolvers(), starts = [];
    const first = withProcessSlot(() => { starts.push('first'); return gate.promise; });
    const second = withProcessSlot(() => { starts.push('second'); });
    const beforeRelease = [...starts];
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(beforeRelease, ['first']);
    assert.deepEqual(starts, ['first', 'second']);
    fs.writeFileSync(process.argv[2], 'finished');
  `,
  );
  const steps = ['alpha', 'beta'].map((label) => ({
    label,
    commands: [1, 2].map((command) => ['probe.mjs', `${label}-${command}.done`]),
  }));
  await runSteps(steps, 2, {
    cwd: directory,
    logs: path.join(directory, 'logs'),
    cpus: 8,
    laneIdentity: async (pid) => 'fixture:' + pid,
  });
  for (const label of ['alpha', 'beta'])
    for (const command of [1, 2])
      assert.equal(fs.readFileSync(path.join(directory, `${label}-${command}.done`), 'utf8'), 'finished');
});

// @test-kind tooling: the validation runner preserves parallel execution, all lanes and failure diagnostics.
test('parallel validation runs every step concurrently and reports each failure with its log', async (t) => {
  const { runSteps } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-ci-steps-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = (name, body) => {
    fs.writeFileSync(path.join(directory, name), body);
    return [name];
  };
  // `waits` finishes only once `starts` has begun, however long a loaded host takes to start it; a serial run of the two
  // never finishes and is reported by the runner's hang guard. It ends with this test process, so a lane left behind
  // by an abandoned test does not outlive it.
  const waits = script(
    'waits.mjs',
    `import fs from 'node:fs';
    while (!fs.existsSync('started')) {
      try { process.kill(Number(process.argv[2]), 0); } catch { process.exit(3); }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }`,
  );
  const starts = script('starts.mjs', `import fs from 'node:fs'; fs.writeFileSync('started', '');`);
  const fails = script('fails.mjs', `console.error('Invented step failure'); process.exit(7);`);
  const after = script('after.mjs', `import fs from 'node:fs'; fs.writeFileSync('after', '');`);
  const unreached = script('unreached.mjs', `import fs from 'node:fs'; fs.writeFileSync('unreached', '');`);
  const logs = path.join(directory, 'logs');
  await assert.rejects(
    runSteps(
      [
        { label: 'waits', commands: [[...waits, String(process.pid)]] },
        { label: 'starts', commands: [starts] },
        { label: 'fails', commands: [fails, unreached] },
        { label: 'after failure', commands: [after] },
      ],
      2,
      { cwd: directory, logs, laneIdentity: async (pid) => 'fixture:' + pid },
    ),
    { message: 'Validation failed: fails.' },
  );
  assert.ok(fs.existsSync(path.join(directory, 'after')), 'a failed step does not stop the remaining steps');
  assert.equal(fs.existsSync(path.join(directory, 'unreached')), false, 'a failed command ends its own step');
  assert.match(fs.readFileSync(path.join(logs, 'fails.log'), 'utf8'), /Invented step failure/);
});

test('a deleted failed-step log cannot prevent collecting the remaining lane results', async (t) => {
  const { runSteps } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-ci-missing-log-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logs = path.join(directory, 'logs');
  fs.writeFileSync(
    path.join(directory, 'fail.mjs'),
    `import fs from 'node:fs';fs.unlinkSync(${JSON.stringify(path.join(logs, 'failed.log'))});process.exit(7);`,
  );
  fs.writeFileSync(
    path.join(directory, 'pass.mjs'),
    `import fs from 'node:fs';fs.writeFileSync(process.argv[2],'finished');`,
  );
  await assert.rejects(
    runSteps(
      [
        { label: 'failed', commands: [['fail.mjs']] },
        { label: 'peer', commands: [['pass.mjs', 'peer.done']] },
        { label: 'remaining', commands: [['pass.mjs', 'remaining.done']] },
      ],
      2,
      { cwd: directory, logs, laneIdentity: async (pid) => 'fixture:' + pid },
    ),
    /Validation failed: failed/,
  );
  assert.equal(fs.readFileSync(path.join(directory, 'peer.done'), 'utf8'), 'finished');
  assert.equal(fs.readFileSync(path.join(directory, 'remaining.done'), 'utf8'), 'finished');
});

test('an unavailable step log still runs every command and collects every lane result', async (t) => {
  const { runSteps } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-ci-log-open-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logs = path.join(directory, 'logs');
  fs.mkdirSync(path.join(logs, 'blocked.log'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'pass.mjs'),
    `import fs from 'node:fs';fs.writeFileSync(process.argv[2],'finished');`,
  );
  await assert.rejects(
    runSteps(
      [
        { label: 'blocked', commands: [['pass.mjs', 'blocked.ran']] },
        { label: 'peer', commands: [['pass.mjs', 'peer.ran']] },
        { label: 'remaining', commands: [['pass.mjs', 'remaining.ran']] },
      ],
      2,
      { cwd: directory, logs, laneIdentity: async (pid) => 'fixture:' + pid },
    ),
    /Validation failed: blocked/,
  );
  for (const name of ['blocked', 'peer', 'remaining'])
    assert.equal(fs.readFileSync(path.join(directory, name + '.ran'), 'utf8'), 'finished');
});

test('default parallel logs belong to separate invocations and retain earlier evidence', async (t) => {
  const { runSteps } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-ci-owned-logs-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'pass.mjs'), `console.log('owned evidence');`);
  const steps = [
    { label: 'one', commands: [['pass.mjs']] },
    { label: 'two', commands: [['pass.mjs']] },
  ];
  const laneIdentity = async (pid) => 'fixture:' + pid;
  await Promise.all([
    runSteps(steps, 2, { cwd: directory, laneIdentity }),
    runSteps(steps, 2, { cwd: directory, laneIdentity }),
  ]);
  const parent = path.join(directory, '.paqvilo/ci/runs'),
    runs = fs.readdirSync(parent);
  assert.equal(runs.length, 2);
  for (const run of runs)
    for (const label of ['one', 'two'])
      assert.match(fs.readFileSync(path.join(parent, run, 'logs', label + '.log'), 'utf8'), /owned evidence/);
});

test('SDK preparation command installs every npm client and invokes fixture preparation', async (t) => {
  const { directory, write, env } = ciFixture(t);
  write('global.json', JSON.stringify({ sdk: { version: '10.0.114' } }));
  const preload = write(
    'pinned-dotnet.mjs',
    `import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const original = cp.spawnSync;
    cp.spawnSync = (command, args, options) => command === 'dotnet' && args[0] === '--version'
      ? { status: 0, stdout: '10.0.114\\n' } : original(command, args, options);
    syncBuiltinESMExports();`,
  );
  env.npm_execpath = write(
    'fake-npm.mjs',
    `import fs from 'node:fs';
    fs.appendFileSync('prepared-npm.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');`,
  );
  write(
    'scripts/sdk-preparation.mjs',
    `import fs from 'node:fs';
    export async function prepareSdkFixtures({ root, execute }) {
      if (root !== process.cwd() || typeof execute !== 'function') throw new Error('Preparation lost its owner');
      fs.writeFileSync('sdk-fixtures-prepared', 'complete');
    }`,
  );
  const result = await boundedCommand(
    t,
    process.execPath,
    ['--import', pathToFileURL(preload).href, path.join(directory, 'scripts/ci.mjs'), 'sdk-prepare'],
    { cwd: directory, env },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const calls = fs
    .readFileSync(path.join(directory, 'prepared-npm.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((args) => (args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : '.')),
    ['.', 'mirage', 'mirage/test-sdk/tds', 'mirage/test-sdk/dynamics-web-api', 'mirage/test-sdk/cert-auth'],
  );
  assert.equal(fs.readFileSync(path.join(directory, 'sdk-fixtures-prepared'), 'utf8'), 'complete');
});

test('receipt browser identity follows the selected channel and changes when its executable changes', async (t) => {
  const { verificationBrowser, matchingVerification } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-ci-browser-receipt-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'invented-edge');
  fs.writeFileSync(executable, 'invented browser v1');
  const locate = async (channel) => ({ path: channel === 'msedge' ? executable : null });
  const headless = path.join(directory, 'invented-headless-shell');
  fs.writeFileSync(headless, 'invented headless browser v1');
  const locateHeadless = () => headless;
  const chromium = await verificationBrowser({ env: {}, platform: 'win32', locate, locateHeadless });
  const edge = await verificationBrowser({ env: { PAQ_CI_BROWSER: 'msedge' }, platform: 'win32', locate });
  assert.equal(chromium.channel, 'chromium');
  assert.equal(edge.channel, 'msedge');
  assert.notEqual(chromium.executable, edge.executable);
  const scope = { lense: true };
  fs.appendFileSync(headless, ' changed headless bytes');
  const headlessChanged = await verificationBrowser({ env: {}, platform: 'win32', locate, locateHeadless });
  assert.notEqual(headlessChanged.headlessShell, chromium.headlessShell);
  assert.equal(matchingVerification({ identity: chromium, scope }, headlessChanged, scope), false);
  assert.equal(edge.headlessShell, null);
  const receipt = { identity: chromium, scope };
  assert.equal(matchingVerification(receipt, edge, scope), false, 'another channel cannot reuse the receipt');
  fs.appendFileSync(executable, ' changed browser bytes');
  const updated = await verificationBrowser({ env: { PAQ_CI_BROWSER: 'msedge' }, platform: 'win32', locate });
  assert.notEqual(updated.executable, edge.executable);
  assert.equal(matchingVerification({ identity: edge, scope }, updated, scope), false);
});

// Three verify commands, one per rejected argument set.
test(
  'verification rejected before identity qualification revokes earlier successful evidence',
  { timeout: operationBudget(3, COMMAND_HANG_GUARD_MS) },
  async (t) => {
    const { directory, write, env } = ciFixture(t);
    const verify = countOperations(t, 3, (...args) =>
      boundedCommand(t, process.execPath, [path.join(directory, 'scripts/ci.mjs'), 'verify', ...args], {
        cwd: directory,
        env,
      }),
    );
    for (const args of [['--unknown-verification-option'], ['--full', '--unit'], ['--full', '--prepared']]) {
      const receipt = write(
        '.paqvilo/ci/runs/verification.json',
        JSON.stringify({ full: true, identity: { tree: 'earlier-pass' } }),
      );
      const result = await verify(...args);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(
        fs.existsSync(receipt),
        false,
        'even an early validation failure revokes the old pass: ' + args.join(' '),
      );
    }
  },
);

test('matching cached receipts lose qualification when an SDK fixture disappears or TLS tools stop working', async (t) => {
  const { verificationFixturesReady, matchingVerification } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-ci-mutable-fixture-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'prepared-sdk-fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ prepared: true }));
  const scope = { mirage: true, sdk: true },
    identity = { tree: 'unchanged-source-tree' };
  const receipt = { full: true, identity };
  let tlsAvailable = true;
  const checks = {
    suite() {},
    sdk() {
      assert.equal(JSON.parse(fs.readFileSync(fixture, 'utf8')).prepared, true);
    },
    tls() {
      if (!tlsAvailable) throw new Error('Required TLS tools unavailable');
    },
  };
  const qualified = async () =>
    matchingVerification(receipt, identity, scope) &&
    (await verificationFixturesReady(scope, ['mirage'], { platform: 'linux' }, checks));
  assert.equal(await qualified(), true);
  fs.rmSync(fixture);
  assert.equal(matchingVerification(receipt, identity, scope), true, 'the old source receipt alone still matches');
  assert.equal(await qualified(), false, 'missing SDK fixture invalidates receipt reuse');
  fs.writeFileSync(fixture, JSON.stringify({ prepared: false }));
  assert.equal(await qualified(), false, 'corrupt SDK fixture invalidates receipt reuse');
  fs.writeFileSync(fixture, JSON.stringify({ prepared: true }));
  tlsAvailable = false;
  assert.equal(await qualified(), false, 'missing TLS clients invalidate receipt reuse');
  for (const [unrelatedScope, suites] of [
    [{ lense: true }, ['lense']],
    [{}, []],
  ]) {
    assert.equal(
      await verificationFixturesReady(
        unrelatedScope,
        suites,
        {},
        {
          suite() {},
          sdk() {
            assert.fail('unrelated verification cannot require SDK clients');
          },
          tls() {
            assert.fail('unrelated verification cannot require TLS clients');
          },
        },
      ),
      true,
    );
  }
});

test('all-CPU analysis drains other work and runs alone while ordinary lanes retain concurrency', async () => {
  const { runStepBatches, validationSteps } = await import('../scripts/ci.mjs');
  const plan = validationSteps({ codeql: true }, [], { browser: false, env: { GITHUB_ACTIONS: 'false' } });
  assert.equal(plan.find((step) => step.label === 'codeql').exclusive, true);
  const before = Promise.withResolvers(),
    beforeRelease = Promise.withResolvers();
  const scanner = Promise.withResolvers(),
    scannerRelease = Promise.withResolvers();
  const tails = Promise.withResolvers(),
    tailsRelease = Promise.withResolvers();
  const active = new Set(),
    completed = [];
  let tailCount = 0;
  const running = runStepBatches(
    [{ label: 'before' }, { label: 'scanner', exclusive: true }, { label: 'one' }, { label: 'two' }],
    2,
    async (step) => {
      active.add(step.label);
      if (step.label === 'before') {
        before.resolve();
        await beforeRelease.promise;
      } else if (step.label === 'scanner') {
        assert.deepEqual([...active], ['scanner']);
        scanner.resolve();
        await scannerRelease.promise;
      } else {
        assert.equal(active.has('scanner'), false);
        if (++tailCount === 2) tails.resolve();
        await tailsRelease.promise;
      }
      active.delete(step.label);
      completed.push(step.label);
    },
  );
  await before.promise;
  assert.deepEqual([...active], ['before']);
  beforeRelease.resolve();
  await scanner.promise;
  assert.deepEqual(completed, ['before']);
  assert.equal(tailCount, 0);
  scannerRelease.resolve();
  await tails.promise;
  assert.deepEqual([...active].sort(), ['one', 'two']);
  tailsRelease.resolve();
  await running;
  assert.deepEqual(completed.slice(0, 2), ['before', 'scanner']);
  assert.deepEqual(completed.slice(2).sort(), ['one', 'two']);
});

test('a failed exclusive analysis still runs the remaining functional lanes and reports failure', async (t) => {
  const { runSteps } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-ci-exclusive-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'fail.mjs'), 'process.exit(7);');
  fs.writeFileSync(path.join(directory, 'after.mjs'), "import fs from 'node:fs';fs.writeFileSync('after', '');");
  await assert.rejects(
    runSteps(
      [
        { label: 'scanner', exclusive: true, commands: [['fail.mjs']] },
        { label: 'functional', commands: [['after.mjs']] },
      ],
      2,
      { cwd: directory, laneIdentity: async (pid) => 'fixture:' + pid },
    ),
    { message: 'Validation failed: scanner.' },
  );
  assert.equal(fs.existsSync(path.join(directory, 'after')), true);
});
