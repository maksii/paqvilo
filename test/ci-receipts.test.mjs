import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  for (const file of ['scripts/ci.mjs', '.github/scripts/change-scope.mjs'])
    write(file, fs.readFileSync(new URL(`../${file}`, import.meta.url)));
  write('scripts/ensure-dependencies.mjs', 'export const dependencyReadiness = () => ({ ready: true });');
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
    '.paqvilo/ci/verification.json',
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
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'test: receipt fixture');
    const dotnet = spawnSync('dotnet', ['--version'], { cwd: directory, env, encoding: 'utf8', windowsHide: true });
    const receipt = write(
      '.paqvilo/ci/verification.json',
      JSON.stringify({
        identity: {
          tree: git('rev-parse', 'HEAD^{tree}'),
          node: process.version,
          npm: '1.0.0',
          platform: process.platform,
          arch: process.arch,
          nodeOptions: env.NODE_OPTIONS ?? '',
          playwright: '1.0.0',
          chromium: null,
          tedious: null,
          clrSdk: null,
          dotnet: dotnet.status === 0 ? dotnet.stdout.trim() : null,
        },
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
