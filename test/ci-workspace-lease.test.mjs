// @test-kind tooling: CI checkout lease and dependency preparation are checked with local fixtures
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireCiWorkspaceLease, assertOwnedCiState, leaseMemberAlive } from '../scripts/ci-workspace-lease.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { loadCatalogue } from '../lense/config.mjs';
import { processIdentity } from '../lense/process-identity.mjs';

const variable = 'PAQ_CI_WORKSPACE_LEASE';
function checkout(t) {
  // The physical path, as the lease records it (macOS's /var is a link into /private).
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-ci-lease-')));
  ownedFixture(t).remove(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function owner(t, directory, environment = {}) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import{acquireCiWorkspaceLease}from ${JSON.stringify(new URL('../scripts/ci-workspace-lease.mjs', import.meta.url).href)};await acquireCiWorkspaceLease(${JSON.stringify(directory)},process.env,{inherit:true});console.log('ready');setInterval(()=>{},1000);`,
    ],
    { env: { ...process.env, [variable]: '', ...environment }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const closed = once(child, 'close');
  ownedFixture(t).add(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  await new Promise((resolve, reject) => {
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('ready\n')) resolve();
    });
    child.stderr.on('data', (chunk) => (errors += chunk));
    child.once('error', reject);
    child.once('exit', () => reject(new Error(errors || 'Lease owner exited before readiness')));
  });
  return { child, closed };
}

test('an independent validation cannot prepare dependencies while a checkout is leased', async (t) => {
  const directory = checkout(t),
    environment = {};
  const release = await acquireCiWorkspaceLease(directory, environment);
  ownedFixture(t).add(release);
  const config = path.join(directory, 'paqvilo.config.yml');
  fs.writeFileSync(config, 'sites: {}\n');
  assert.doesNotThrow(() => loadCatalogue({ config }, environment), 'internal CI state is not a user setting');
  await assert.rejects(acquireCiWorkspaceLease(directory, {}), /already owns this checkout/);
  const finishChild = await acquireCiWorkspaceLease(directory, { ...environment }, { inherit: true });
  await assert.rejects(release(), /workers still own/);
  await finishChild();
  await assert.rejects(acquireCiWorkspaceLease(directory, {}), /already owns this checkout/);
  await release();
  await release();
  await (
    await acquireCiWorkspaceLease(directory, {})
  )();
  assert.equal(environment[variable], undefined);
});

test('a shared CI state junction is rejected without modifying its external target', async (t) => {
  const directory = checkout(t),
    outside = checkout(t);
  fs.mkdirSync(path.join(directory, '.paqvilo'));
  fs.symlinkSync(outside, path.join(directory, '.paqvilo/ci'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(acquireCiWorkspaceLease(directory, {}), /CI state must stay inside/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('writable CI descendants cannot redirect receipts, logs or fixture extraction', (t) => {
  const directory = checkout(t),
    outside = checkout(t),
    state = assertOwnedCiState(directory);
  fs.writeFileSync(path.join(outside, 'verification.json'), 'other checkout receipt');
  for (const part of ['runs', 'sdk-reference', 'ecosystem', 'npm-cache-smoke']) {
    const link = path.join(state, part);
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertOwnedCiState(directory, part), /CI state must stay inside/);
    fs.unlinkSync(link);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'verification.json'), 'utf8'), 'other checkout receipt');
  assert.throws(() => assertOwnedCiState(directory, '../outside'), /plain directory names/);
});

test('preparation unlinks a shared dependency directory without deleting its contents', async (t) => {
  const directory = checkout(t),
    outside = checkout(t),
    sentinel = path.join(outside, 'keep');
  fs.writeFileSync(sentinel, 'other checkout');
  fs.symlinkSync(outside, path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const { resetLinkedDependencyDirectory } = await import('../scripts/ci.mjs');
  resetLinkedDependencyDirectory(directory, directory);
  assert.equal(fs.existsSync(path.join(directory, 'node_modules')), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'other checkout');
  fs.mkdirSync(path.join(directory, 'node_modules'));
  fs.writeFileSync(path.join(directory, 'node_modules', 'owned'), 'retain until npm ci');
  resetLinkedDependencyDirectory(directory, directory);
  assert.equal(fs.existsSync(path.join(directory, 'node_modules', 'owned')), true);
  assert.throws(() => resetLinkedDependencyDirectory(outside, directory), /escaped the owned checkout/);
});

test('separate checkout leases and malformed inherited values do not bypass the owner', async (t) => {
  const first = checkout(t),
    second = checkout(t);
  const release = await acquireCiWorkspaceLease(first, {});
  ownedFixture(t).add(release);
  await (
    await acquireCiWorkspaceLease(second, { [variable]: 'malformed' })
  )();
  await assert.rejects(acquireCiWorkspaceLease(first, { [variable]: 'malformed' }, { inherit: true }), /already owns/);
  await assert.rejects(
    acquireCiWorkspaceLease(
      first,
      { [variable]: JSON.stringify({ root: first, pid: process.pid, token: 'wrong' }) },
      { inherit: true },
    ),
    /already owns/,
  );
});

test('a terminated owner whose worker still runs retains its lease until the worker stops', async (t) => {
  const directory = checkout(t),
    lock = path.join(directory, '.paqvilo/ci/workspace.lock');
  const { child, closed } = await owner(t, directory);
  await assert.rejects(acquireCiWorkspaceLease(directory, {}), /already owns/);
  const worker = await owner(t, directory, { [variable]: fs.readFileSync(path.join(lock, 'owner.json'), 'utf8') });
  child.kill();
  await closed;
  await assert.rejects(acquireCiWorkspaceLease(directory, {}), /verify its workers have stopped/);
  assert.equal(fs.existsSync(path.join(lock, 'owner.json')), true);
  worker.child.kill();
  await worker.closed;
  await (
    await acquireCiWorkspaceLease(directory, {})
  )();
});

test('releasing one generation cannot remove the next owner membership guard', async (t) => {
  const directory = checkout(t),
    lock = path.join(directory, '.paqvilo/ci/workspace.lock');
  const release = await acquireCiWorkspaceLease(directory, {}),
    rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    const answer = rename(source, destination);
    if (source === lock) {
      fs.mkdirSync(path.join(lock, 'membership'), { recursive: true });
      fs.mkdirSync(path.join(lock, 'members'));
      fs.writeFileSync(
        path.join(lock, 'owner.json'),
        JSON.stringify({ root: directory, pid: process.pid, token: 'next-generation' }),
      );
    }
    return answer;
  };
  try {
    await release();
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(fs.existsSync(path.join(lock, 'membership')), true);
});

test('an incomplete lock is retained rather than deleting an unqualified directory', async (t) => {
  const directory = checkout(t),
    lock = path.join(directory, '.paqvilo/ci/workspace.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'keep'), 'unqualified');
  await assert.rejects(acquireCiWorkspaceLease(directory, {}, { inherit: true }), /already owns/);
  assert.equal(fs.readFileSync(path.join(lock, 'keep'), 'utf8'), 'unqualified');
});

test('partial inherited markers acquire a free checkout but cannot enable preparation inside a lease', async (t) => {
  const directory = checkout(t),
    environment = { [variable]: JSON.stringify({ root: directory }) };
  const release = await acquireCiWorkspaceLease(directory, environment, { inherit: true });
  ownedFixture(t).add(release);
  await assert.rejects(acquireCiWorkspaceLease(directory, { ...environment }), /already owns/);
});

test('inherited worker processes keep the parent lease until their handles have closed', async (t) => {
  const directory = checkout(t),
    environment = {};
  const release = await acquireCiWorkspaceLease(directory, environment);
  ownedFixture(t).add(release);
  const { child, closed } = await owner(t, directory, environment);
  await assert.rejects(release(), /workers still own/);
  await assert.rejects(acquireCiWorkspaceLease(directory, {}), /already owns/);
  child.kill();
  await closed;
  await release();
  await (
    await acquireCiWorkspaceLease(directory, {})
  )();
});

test('a worker record whose process ID now names another process does not retain the lease', async (t) => {
  const directory = checkout(t),
    environment = {};
  const release = await acquireCiWorkspaceLease(directory, environment);
  ownedFixture(t).add(release);
  const members = path.join(directory, '.paqvilo/ci/workspace.lock/members'),
    identity = processIdentity(process.pid);
  assert.ok(identity, 'this process has a readable start identity');
  // A running process with this PID but a different start: the worker that recorded it has exited.
  fs.writeFileSync(path.join(members, 'reused.json'), JSON.stringify({ pid: process.pid, identity: `${identity}0` }));
  fs.writeFileSync(path.join(members, 'running.json'), JSON.stringify({ pid: process.pid, identity }));
  await assert.rejects(release(), /workers still own/);
  fs.unlinkSync(path.join(members, 'running.json'));
  await release();
  await (
    await acquireCiWorkspaceLease(directory, {})
  )();
});

// @test-kind tooling: a membership guard whose holder has ended is removed, so a later member joins at once
test('a membership guard left by an ended member is recovered', async (t) => {
  const directory = checkout(t),
    lock = path.join(directory, '.paqvilo/ci/workspace.lock');
  const environment = {};
  const release = await acquireCiWorkspaceLease(directory, environment);
  ownedFixture(t).add(release);
  const ended = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await once(ended, 'exit');
  fs.mkdirSync(path.join(lock, 'membership'));
  fs.writeFileSync(path.join(lock, 'membership', 'owner.json'), JSON.stringify({ pid: ended.pid, identity: '1' }));
  const finishMember = await acquireCiWorkspaceLease(directory, { ...environment }, { inherit: true });
  assert.equal(fs.readdirSync(path.join(lock, 'members')).length, 1, 'the member is recorded');
  assert.equal(fs.existsSync(path.join(lock, 'membership')), false, 'the recovered guard is released');
  await finishMember();
});

// @test-kind tooling: a membership guard whose holder still runs makes a later member wait until the guard is released
test('a member waits for a live membership guard holder', async (t) => {
  const directory = checkout(t),
    lock = path.join(directory, '.paqvilo/ci/workspace.lock');
  const environment = {};
  const release = await acquireCiWorkspaceLease(directory, environment);
  ownedFixture(t).add(release);
  const guard = path.join(lock, 'membership');
  fs.mkdirSync(guard);
  fs.writeFileSync(
    path.join(guard, 'owner.json'),
    JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) }),
  );
  const mkdirSync = fs.mkdirSync;
  let attempts = 0;
  t.mock.method(fs, 'mkdirSync', (target, ...rest) => {
    if (String(target).includes('membership.new-')) attempts += 1;
    return mkdirSync(target, ...rest);
  });
  const joining = acquireCiWorkspaceLease(directory, { ...environment }, { inherit: true });
  // Each attempt is one 10 ms timer, so this waits for the events of the attempts rather than for elapsed time.
  while (attempts < 2) await new Promise(setImmediate);
  assert.deepEqual(fs.readdirSync(path.join(lock, 'members')), [], 'the member has not joined while the guard is held');
  fs.rmSync(guard, { recursive: true, force: true });
  const finishMember = await joining;
  assert.equal(fs.readdirSync(path.join(lock, 'members')).length, 1, 'the member joins once the guard is released');
  await finishMember();
});

// @test-kind tooling: a membership guard whose removal fails part-way never blocks the next member
test('a membership guard whose removal fails part-way never blocks the next member', async (t) => {
  const directory = checkout(t),
    lock = path.join(directory, '.paqvilo/ci/workspace.lock');
  const environment = {};
  const release = await acquireCiWorkspaceLease(directory, environment);
  ownedFixture(t).add(release);
  const rmSync = fs.rmSync;
  let failed = false;
  t.mock.method(fs, 'rmSync', (target, ...rest) => {
    const name = path.basename(String(target));
    if (!failed && name.startsWith('membership') && !name.startsWith('membership.new-')) {
      // The first guard removal loses its holder record and then fails, as a scanner's lock on Windows can.
      failed = true;
      fs.unlinkSync(path.join(target, 'owner.json'));
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    }
    return rmSync(target, ...rest);
  });
  const finishFirst = await acquireCiWorkspaceLease(directory, { ...environment }, { inherit: true });
  assert.equal(failed, true, 'the first guard removal failed');
  const finishSecond = await acquireCiWorkspaceLease(directory, { ...environment }, { inherit: true });
  assert.equal(fs.readdirSync(path.join(lock, 'members')).length, 2, 'both members joined');
  await finishSecond();
  await finishFirst();
});

// A child process that runs until stop(); its start identity is read while it is alive.
async function idler(t) {
  const child = spawn(process.execPath, ['--eval', 'console.log("ready");setInterval(()=>{},1000);'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const exited = once(child, 'exit');
  ownedFixture(t).add(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Idle process exited before readiness')));
  });
  return {
    pid: child.pid,
    identity: processIdentity(child.pid),
    async stop() {
      child.kill();
      await exited;
    },
  };
}

async function endedLeaseClaim(t, directory) {
  const { child, closed } = await owner(t, directory);
  child.kill();
  await closed;
  return `${path.join(directory, '.paqvilo/ci/workspace.lock')}.takeover`;
}

test('a takeover claim left by an ended process is removed and the takeover succeeds', async (t) => {
  const directory = checkout(t);
  const claim = await endedLeaseClaim(t, directory);
  const taker = await idler(t);
  const record = { pid: taker.pid, identity: taker.identity };
  await taker.stop();
  fs.mkdirSync(claim);
  fs.writeFileSync(path.join(claim, 'owner.json'), JSON.stringify(record));
  await (
    await acquireCiWorkspaceLease(directory, {})
  )();
  assert.equal(fs.existsSync(claim), false);
});

test('a takeover claim held by a live process blocks the takeover until that process ends', async (t) => {
  const directory = checkout(t);
  const claim = await endedLeaseClaim(t, directory),
    record = path.join(claim, 'owner.json');
  const taker = await idler(t);
  fs.mkdirSync(claim);
  fs.writeFileSync(record, JSON.stringify({ pid: taker.pid, identity: taker.identity }));
  await assert.rejects(acquireCiWorkspaceLease(directory, {}), /already owns/);
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).pid, taker.pid);
  // A record that cannot be read does not show that its owner has ended, so the claim is still held.
  fs.writeFileSync(record, '{');
  await assert.rejects(acquireCiWorkspaceLease(directory, {}), /already owns/);
  await taker.stop();
  fs.writeFileSync(record, JSON.stringify({ pid: taker.pid, identity: taker.identity }));
  await (
    await acquireCiWorkspaceLease(directory, {})
  )();
  assert.equal(fs.existsSync(claim), false);
});

test('a takeover claim whose PID now names another process does not block the takeover', async (t) => {
  const directory = checkout(t);
  const claim = await endedLeaseClaim(t, directory);
  const taker = await idler(t);
  assert.ok(taker.identity, 'the idle process has a readable start identity');
  fs.mkdirSync(claim);
  fs.writeFileSync(path.join(claim, 'owner.json'), JSON.stringify({ pid: taker.pid, identity: `${taker.identity}0` }));
  await (
    await acquireCiWorkspaceLease(directory, {})
  )();
  assert.equal(fs.existsSync(claim), false);
  await taker.stop();
});

test('a recorded PID reused by a process that ended while its identity was read no longer holds the lease', () => {
  const member = { pid: 4321, identity: 'recorded' };
  const answers = [true, false];
  assert.equal(
    leaseMemberAlive(
      member,
      () => answers.shift(),
      () => null,
    ),
    false,
  );
  // A running process whose identity cannot be read keeps the lease.
  assert.equal(
    leaseMemberAlive(
      member,
      () => true,
      () => null,
    ),
    true,
  );
  assert.equal(
    leaseMemberAlive(
      member,
      () => true,
      () => 'another',
    ),
    false,
  );
});

test('a lane joins the lease when the membership guard is released while its own claim is refused', async (t) => {
  const directory = checkout(t),
    environment = {};
  const release = await acquireCiWorkspaceLease(directory, environment);
  ownedFixture(t).add(release);
  // Two lanes start together: the move of this lane's claim is refused while the other lane holds the guard, and that
  // lane has released it by the time the refusal is inspected.
  const rename = fs.renameSync;
  let refused = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(String(to)) === 'membership' && refused === 0) {
      refused += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  const finish = await acquireCiWorkspaceLease(directory, { ...environment }, { inherit: true });
  assert.equal(refused, 1);
  await finish();
  await release();
});

test('a release waits out a refused move of its folders while another run reads their holder record', async (t) => {
  const directory = checkout(t),
    environment = {};
  const release = await acquireCiWorkspaceLease(directory, environment);
  const lock = path.join(directory, '.paqvilo', 'ci', 'workspace.lock');
  // Windows refuses to move a folder while a file inside it is open, as it is while a waiting run reads the holder
  // record: each move aside is refused once here, as that read would refuse it.
  const move = fs.renameSync,
    refused = [];
  t.mock.method(fs, 'renameSync', (from, to) => {
    const name = path.basename(String(to));
    if (name.includes('.released-') && !refused.includes(String(from))) {
      refused.push(String(from));
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return move(from, to);
  });
  const member = await acquireCiWorkspaceLease(directory, { ...environment }, { inherit: true });
  await member();
  assert.deepEqual(refused, [path.join(lock, 'membership')], 'the member moved its membership guard after one refusal');
  assert.deepEqual(fs.readdirSync(path.join(lock, 'members')), []);
  await release();
  assert.deepEqual(refused, [path.join(lock, 'membership'), lock], 'the owner moved its guard and its lease');
  assert.equal(fs.existsSync(lock), false);
  // A refusal that is not a sharing refusal stays an error.
  const next = await acquireCiWorkspaceLease(directory, {});
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from) === lock && path.basename(String(to)).includes('.released-'))
      throw Object.assign(new Error('EIO: invented failure, rename'), { code: 'EIO' });
    return move(from, to);
  });
  await assert.rejects(next(), { code: 'EIO' });
  t.mock.method(fs, 'renameSync', move);
  await next();
  assert.equal(fs.existsSync(lock), false);
});
