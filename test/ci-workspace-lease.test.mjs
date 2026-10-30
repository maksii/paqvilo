import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireCiWorkspaceLease, assertOwnedCiState } from '../scripts/ci-workspace-lease.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { loadCatalogue } from '../lense/config.mjs';

const variable = 'PAQ_CI_WORKSPACE_LEASE';
function checkout(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paq-ci-lease-'));
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

test('a terminated owner retains its lease until its workers can be inspected', async (t) => {
  const directory = checkout(t);
  const { child, closed } = await owner(t, directory);
  await assert.rejects(acquireCiWorkspaceLease(directory, {}), /already owns/);
  child.kill();
  await closed;
  await assert.rejects(acquireCiWorkspaceLease(directory, {}), /verify its workers have stopped/);
  assert.equal(fs.existsSync(path.join(directory, '.paqvilo/ci/workspace.lock/owner.json')), true);
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
