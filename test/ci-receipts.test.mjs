// @test-kind tooling: scripts/ci.mjs validation receipts, sharding, concurrency and revocation
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tempDirSync } from './fixture.mjs';

function ciFixture(t) {
  const directory = tempDirSync('paq-ci-receipt-command-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (relative, content) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  for (const file of ['scripts/ci.mjs', 'scripts/ci-workspace-lease.mjs', '.github/scripts/change-scope.mjs'])
    write(file, fs.readFileSync(new URL(`../${file}`, import.meta.url)));
  write(
    'scripts/ensure-dependencies.mjs',
    'export const dependencyReadiness = () => ({ ready: true }); export const browserExecutable = async () => ({ path: null });',
  );
  write(
    'scripts/verified-download.mjs',
    'export function downloadVerifiedArchive() { throw new Error("Unexpected download"); }',
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
  const dotnet = spawnSync('dotnet', ['--version'], { cwd: directory, env, encoding: 'utf8', windowsHide: true });
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

test('a redirected receipt directory is rejected before even invalid verification can delete its receipt', (t) => {
  const { directory, env } = ciFixture(t),
    outside = tempDirSync('paq-external-receipt-');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const receipt = path.join(outside, 'verification.json');
  fs.writeFileSync(receipt, 'other checkout');
  fs.mkdirSync(path.join(directory, '.paqvilo/ci'), { recursive: true });
  fs.symlinkSync(outside, path.join(directory, '.paqvilo/ci/runs'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [path.join(directory, 'scripts/ci.mjs'), 'verify', '--unknown-option'], {
    cwd: directory,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /CI state must stay inside/);
  assert.equal(fs.readFileSync(receipt, 'utf8'), 'other checkout');
});

test('a failed prepared suite revokes an earlier full receipt through the CI command', { timeout: 90_000 }, (t) => {
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
  const result = spawnSync(
    process.execPath,
    [path.join(directory, 'scripts/ci.mjs'), 'verify', '--suite', 'lense', '--unit', '--prepared'],
    { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /Invented suite failure/);
  assert.match(result.stderr, /failed \(37\)/);
  assert.doesNotMatch(result.stdout, /reused|completed without errors/);
  assert.equal(fs.existsSync(receipt), false, 'a previous full pass cannot survive a failed suite rerun');
});

test(
  'unit shards run the package test script over disjoint files that together cover the suite',
  { timeout: 90_000 },
  (t) => {
    const { directory, write, env } = ciFixture(t);
    write('package.json', JSON.stringify({ scripts: { test: 'node --test --test-concurrency=1 test/*.test.mjs' } }));
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      write(
        `test/${name}.test.mjs`,
        `import fs from 'node:fs'; fs.appendFileSync(process.env.SHARD_LOG, ${JSON.stringify(name + '\n')});`,
      );
    env.npm_execpath = write('fake-npm.mjs', 'process.exit(99);');
    const ci = (...args) =>
      spawnSync(process.execPath, [path.join(directory, 'scripts/ci.mjs'), ...args], {
        cwd: directory,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
      });
    const ran = [];
    for (const shard of ['1/2', '2/2']) {
      env.SHARD_LOG = path.join(directory, `shard-${shard[0]}.log`);
      const result = ci('verify', '--suite', 'lense', '--unit', '--prepared', '--shard', shard);
      assert.equal(result.status, 0, result.stderr);
      ran.push(fs.readFileSync(env.SHARD_LOG, 'utf8').trim().split('\n').sort());
    }
    // Shards own sorted file indexes 0, 2, 4 and 1, 3.
    assert.deepEqual(ran, [
      ['a', 'c', 'e'],
      ['b', 'd'],
    ]);
    for (const args of [
      ['--suite', 'lense', '--unit', '--shard', '3/2'],
      ['--suite', 'lense', '--unit', '--shard', '0/2'],
      ['--suite', 'lense', '--unit', '--shard', 'x'],
      ['--suite', 'examples', '--unit', '--shard', '1/2'],
      ['--suite', 'lense', '--shard', '1/2'],
      ['--full', '--shard', '1/2'],
    ]) {
      const result = ci('verify', '--prepared', ...args);
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
  { timeout: 90_000 },
  (t) => {
    const { directory, write, env } = ciFixture(t);
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
    const cached = spawnSync(
      process.execPath,
      [path.join(directory, 'scripts/ci.mjs'), 'verify', '--base', 'HEAD', '--prepared'],
      { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    assert.equal(cached.status, 0, cached.error?.message ?? cached.stdout + cached.stderr);
    assert.match(cached.stdout, /reused full deterministic validation/);
    assert.equal(fs.existsSync(path.join(directory, '.paqvilo/fresh-full-step')), false);
    assert.equal(fs.existsSync(receipt), true, 'the same identity qualifies for scoped reuse');
    const result = spawnSync(
      process.execPath,
      [path.join(directory, 'scripts/ci.mjs'), 'verify', '--full', '--prepared'],
      { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.match(result.stdout + result.stderr, /Invented fresh full-gate failure/);
    assert.equal(fs.readFileSync(path.join(directory, '.paqvilo/fresh-full-step'), 'utf8'), 'executed');
    assert.doesNotMatch(result.stdout, /reused .*deterministic validation/);
    assert.equal(fs.existsSync(receipt), false, 'a failed explicit full run revokes the earlier qualifying receipt');
  },
);

test(
  'cached validation cannot restore a receipt after source changes during dependency audits',
  { timeout: 90_000 },
  (t) => {
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
    const result = spawnSync(
      process.execPath,
      [path.join(directory, 'scripts/ci.mjs'), 'verify', '--base', 'HEAD', '--prepared'],
      { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.match(result.stderr, /changed during dependency audits/);
    assert.equal(fs.readFileSync(path.join(directory, 'README.md'), 'utf8'), 'Changed during audit');
    assert.equal(fs.existsSync(receipt), false, 'a source change during audit revokes previous qualifying evidence');
  },
);

test('validation concurrency follows the contributor setting, else the machine, and stays serial on hosted CI', async () => {
  const { validationJobs } = await import('../scripts/ci.mjs');
  const GiB = 2 ** 30;
  assert.equal(validationJobs({}, undefined, { cpus: 20, memory: 96 * GiB }), 5);
  assert.equal(validationJobs({}, undefined, { cpus: 4, memory: 16 * GiB }), 1);
  assert.equal(validationJobs({}, undefined, { cpus: 32, memory: 8 * GiB }), 2, 'memory bounds a many-core machine');
  assert.equal(validationJobs({ GITHUB_ACTIONS: 'true' }, undefined, { cpus: 20, memory: 96 * GiB }), 1);
  assert.equal(validationJobs({}, '3'), 3);
  assert.equal(validationJobs({ PAQ_CI_JOBS: '2' }, '3'), 2, 'the environment overrides Git configuration');
  for (const value of ['0', '-1', 'two', '1.5'])
    assert.throws(() => validationJobs({ PAQ_CI_JOBS: value }), /positive integer/, value);
});

test('parallel validation runs every step concurrently and reports each failure with its log', async (t) => {
  const { runSteps } = await import('../scripts/ci.mjs');
  const directory = tempDirSync('paq-ci-steps-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = (name, body) => {
    fs.writeFileSync(path.join(directory, name), body);
    return [name];
  };
  // `waits` finishes only once `starts` has begun, so a serial run of the two would fail instead of passing.
  const waits = script(
    'waits.mjs',
    `import fs from 'node:fs';
    const until = Date.now() + 30_000;
    while (!fs.existsSync('started') && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    process.exit(fs.existsSync('started') ? 0 : 3);`,
  );
  const starts = script('starts.mjs', `import fs from 'node:fs'; fs.writeFileSync('started', '');`);
  const fails = script('fails.mjs', `console.error('Invented step failure'); process.exit(7);`);
  const after = script('after.mjs', `import fs from 'node:fs'; fs.writeFileSync('after', '');`);
  const unreached = script('unreached.mjs', `import fs from 'node:fs'; fs.writeFileSync('unreached', '');`);
  const logs = path.join(directory, 'logs');
  await assert.rejects(
    runSteps(
      [
        { label: 'waits', commands: [waits] },
        { label: 'starts', commands: [starts] },
        { label: 'fails', commands: [fails, unreached] },
        { label: 'after failure', commands: [after] },
      ],
      2,
      { cwd: directory, logs },
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
      { cwd: directory, logs },
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
      { cwd: directory, logs },
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
  await Promise.all([runSteps(steps, 2, { cwd: directory }), runSteps(steps, 2, { cwd: directory })]);
  const parent = path.join(directory, '.paqvilo/ci/runs'),
    runs = fs.readdirSync(parent);
  assert.equal(runs.length, 2);
  for (const run of runs)
    for (const label of ['one', 'two'])
      assert.match(fs.readFileSync(path.join(parent, run, 'logs', label + '.log'), 'utf8'), /owned evidence/);
});

test('SDK preparation command installs every npm client and invokes fixture preparation', { timeout: 90_000 }, (t) => {
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
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(preload).href, path.join(directory, 'scripts/ci.mjs'), 'sdk-prepare'],
    {
      cwd: directory,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    },
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

test('verification rejected before identity qualification revokes earlier successful evidence', (t) => {
  const { directory, write, env } = ciFixture(t);
  for (const args of [['--unknown-verification-option'], ['--full', '--unit'], ['--full', '--prepared']]) {
    const receipt = write(
      '.paqvilo/ci/runs/verification.json',
      JSON.stringify({ full: true, identity: { tree: 'earlier-pass' } }),
    );
    const result = spawnSync(process.execPath, [path.join(directory, 'scripts/ci.mjs'), 'verify', ...args], {
      cwd: directory,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      fs.existsSync(receipt),
      false,
      'even an early validation failure revokes the old pass: ' + args.join(' '),
    );
  }
});

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
