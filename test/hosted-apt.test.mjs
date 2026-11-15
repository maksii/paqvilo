// @test-kind tooling: hosted browser preparation replaces the failed mirror precisely and bounds real apt index transport failures without masking errors.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { prepareHostedApt } from '../scripts/ci.mjs';
import { tempDirSync } from './fixture.mjs';

function plan(options = {}) {
  const writes = new Map();
  prepareHostedApt({
    platform: 'linux',
    env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' },
    uid: 1000,
    read: () => 'http://azure.archive.ubuntu.com/ubuntu\tpriority:1\nhttps://archive.ubuntu.com/ubuntu\tpriority:2\n',
    run: (command, args, options) => {
      if (command === '/usr/bin/apt-config') {
        assert.deepEqual(args, ['dump', 'Acquire::Retries', 'Acquire::http::Timeout', 'Acquire::https::Timeout']);
        return;
      }
      assert.equal(command, '/usr/bin/sudo');
      assert.deepEqual(args.slice(0, 3), ['-n', '--', '/usr/bin/tee']);
      assert.deepEqual(options.stdio, ['pipe', 'ignore', 'inherit']);
      writes.set(args.at(-1), options.input);
    },
    ...options,
  });
  return writes;
}

test('only an exact hosted Azure mirror token changes; priorities and other sources survive', () => {
  const before =
    '# http://azure.archive.ubuntu.com/ubuntu\n http://azure.archive.ubuntu.com/ubuntu priority:1\nhttps://azure.archive.ubuntu.com/ubuntu\tpriority:2\nhttp://azure.archive.ubuntu.com/ubuntu-other priority:3\nhttps://example.invalid/ubuntu priority:4\n';
  const writes = plan({ read: () => before });
  assert.equal(
    writes.get('/etc/apt/apt-mirrors.txt'),
    before
      .replace(' http://azure.archive.ubuntu.com/ubuntu ', ' https://archive.ubuntu.com/ubuntu ')
      .replace('https://azure.archive.ubuntu.com/ubuntu\t', 'https://archive.ubuntu.com/ubuntu\t'),
  );
  assert.match(writes.get('/etc/apt/apt.conf.d/zzz-paqvilo-ci'), /APT::Update::Error-Mode "any"/);
  assert.equal(plan({ platform: 'win32' }).size, 0);
  assert.equal(plan({ env: { GITHUB_ACTIONS: 'false' } }).size, 0);
  assert.equal(plan({ env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' } }).size, 0);
  assert.equal(plan({ env: { GITHUB_ACTIONS: 'true' } }).size, 0);
  let rootWrites = 0;
  plan({
    uid: 0,
    run: (command, args, options) => {
      if (command === '/usr/bin/apt-config') return;
      assert.equal(command, '/usr/bin/tee');
      assert.equal(args.length, 1);
      assert.ok(options.input.length);
      rootWrites++;
    },
  });
  assert.equal(rootWrites, 2);
  assert.equal(plan({ read: () => 'https://archive.ubuntu.com/ubuntu priority:1\n' }).size, 1);
  assert.equal(
    plan({
      read: () => {
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      },
    }).size,
    1,
  );
  assert.throws(
    () =>
      plan({
        read: () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        },
      }),
    /denied/,
  );
  assert.throws(
    () =>
      plan({
        run: () => {
          throw new Error('root write failed');
        },
      }),
    /root write failed/,
  );
});

test('the published runner mirror format keeps trailing slashes and priorities while removing the failed origin', () => {
  // https://github.com/actions/runner-images/blob/fad015e47059f40cf0786dcb4593384f6a0720d3/images/ubuntu/scripts/build/configure-apt-sources.sh
  const mirrors =
    'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n';
  assert.equal(
    plan({ read: () => mirrors }).get('/etc/apt/apt-mirrors.txt'),
    mirrors.replace('http://azure.archive.ubuntu.com/ubuntu/', 'https://archive.ubuntu.com/ubuntu/'),
  );
});

test(
  'an unresponsive loopback apt mirror times out and fails instead of accepting an incomplete index',
  {
    skip: process.platform !== 'linux' && 'apt transport is exercised on Linux',
  },
  async (t) => {
    const directory = tempDirSync('paq-apt-timeout-');
    ownedFixture(t).remove(() => fs.rmSync(directory, { recursive: true, force: true }));
    const parts = path.join(directory, 'apt.conf.d');
    fs.mkdirSync(parts);
    // The image's late-sorting configuration must not override our actual bounds.
    fs.writeFileSync(
      path.join(parts, 'zz-retries'),
      'Acquire::http::Timeout "999";\nAcquire::https::Timeout "999";\nAcquire::Retries "9";\n',
    );
    const bounds = plan().get('/etc/apt/apt.conf.d/zzz-paqvilo-ci');
    fs.writeFileSync(path.join(parts, 'zzz-paqvilo-ci'), bounds);
    const bootstrap = path.join(directory, 'bootstrap.conf');
    fs.writeFileSync(bootstrap, `Dir::Etc::parts "${parts}";\nDir::Etc::main "-";\n`);
    const effective = spawnSync(
      '/usr/bin/apt-config',
      ['dump', 'Acquire::Retries', 'Acquire::http::Timeout', 'Acquire::https::Timeout'],
      {
        env: { ...process.env, APT_CONFIG: bootstrap, LC_ALL: 'C' },
        encoding: 'utf8',
      },
    );
    assert.equal(effective.status, 0, effective.stderr);
    assert.match(effective.stdout, /Acquire::Retries "1"/);
    assert.match(effective.stdout, /Acquire::http::Timeout "20"/);
    assert.match(effective.stdout, /Acquire::https::Timeout "20"/);
    let requests = 0;
    const server = http.createServer(() => {
      requests++;
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ownedFixture(t).add(() => {
      server.closeAllConnections();
      server.close();
    });
    for (const entry of ['lists/partial', 'cache']) fs.mkdirSync(path.join(directory, entry), { recursive: true });
    const source = path.join(directory, 'sources.list');
    fs.writeFileSync(
      source,
      `deb [trusted=yes] http://127.0.0.1:${server.address().port}/unresponsive invented main\n`,
    );
    const configuration = path.join(directory, 'apt.conf');
    // Exercise the installed timeout/error settings with a one-second test budget.
    fs.writeFileSync(
      configuration,
      bounds.replaceAll('"20"', '"1"').replace('Retries "1"', 'Retries "0"') +
        `Dir::Etc::sourcelist "${source}";\nDir::Etc::sourceparts "-";\nDir::State::lists "${directory}/lists";\nDir::Cache "${directory}/cache";\nDebug::NoLocking "true";\n`,
    );
    const child = spawn('/usr/bin/apt-get', ['-c', configuration, 'update'], {
      // apt's messages are matched below, so they must be in the untranslated C locale.
      env: { ...process.env, APT_CONFIG: bootstrap, LC_ALL: 'C' },
    });
    ownedFixture(t).add(() => child.kill());
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const [code] = await once(child, 'close', { signal: t.signal });
    assert.ok(requests > 0, 'apt reached the unresponsive fixture');
    assert.notEqual(code, 0, output);
    assert.match(output, /timed out|Connection failed|Failed to fetch/i);
  },
);
