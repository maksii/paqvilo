// @test-kind contract: a Mirage state file's ownership, reuse and refusal rules for live and dead runtime records
import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createStateFolder,
  start,
  miragePaths,
  ownedSessions,
  updateOwnedSessions,
} from '../lense/commands/mirage.mjs';
import { tempDir } from './fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { readyRuntime } from './helpers/mirage-session-doubles.mjs';

const cfg = (root) => ({ stateDir: root, runtime: { kind: 'model-driven' }, siteName: 'invented' });

async function fixture(t) {
  const root = await tempDir('paq-state-owner-');
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const paths = miragePaths({ stateDir: root });
  await fs.mkdir(paths.discoveryRoot, { recursive: true });
  return { root, paths, stateFile: path.resolve(root, 'shared', 'state.json') };
}

// The settings that identityMatches compares for a model-driven start on requested port 0.
const identityFor = (stateFile, presetMode) => ({
  stateFile,
  runtime: { kind: 'model-driven' },
  solutionOrder: 'derived',
  solutionRoots: [],
  requestedPort: '0',
  presetMode,
});

async function ownRecord(paths, { pid = process.pid, processIdentity, stateFile, presetMode = 'always', log }) {
  const discovery = path.join(paths.discoveryRoot, `session-${pid}.json`);
  await updateOwnedSessions(paths, () => [
    { pid, processIdentity, discovery, stateFile, identity: identityFor(stateFile, presetMode), log, ready: true },
  ]);
}

// The start identity this test records for its own process; the start reads it through `identityOf`.
const liveIdentity = async (pid) => (pid === process.pid ? 'live identity' : null);

// Invented PIDs. Tests inject `alive` and `identityOf` for them, so no real process table is read for these numbers.
const CHILD = 4243;
const RIVAL = 777001;
const DEAD = 777002;
const REUSED = 777003;

// @test-kind contract: a start refuses a state file that a live runtime with a verified identity owns with other settings, before spawning
test('a start refuses a state file that a live runtime with a verified identity owns with other settings, before spawning', async (t) => {
  const { root, paths, stateFile } = await fixture(t);
  await ownRecord(paths, { processIdentity: 'live identity', stateFile, presetMode: 'always' });
  let spawned = 0;
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile, 'preset-mode': 'bootstrap' },
      {
        paths,
        identityOf: liveIdentity,
        spawnRuntime() {
          spawned++;
          throw new Error('the refused start must not spawn');
        },
      },
    ),
    new RegExp(
      `Mirage pid ${process.pid} already uses state file ${escapeRegExp(stateFile)} with different settings; stop it with .+ or pass --state <other file>\\.`,
    ),
  );
  assert.equal(spawned, 0);
});

// @test-kind contract: a dead runtime entry on the same state file does not block a start with other settings
test('a dead runtime entry on the same state file does not block a start with other settings', async (t) => {
  const { root, paths, stateFile } = await fixture(t);
  await ownRecord(paths, { pid: DEAD, processIdentity: 'invented identity', stateFile, presetMode: 'always' });
  let spawned = 0;
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile, 'preset-mode': 'bootstrap' },
      {
        paths,
        alive: (pid) => pid === RIVAL,
        spawnRuntime() {
          spawned++;
          return exitedChild(CHILD);
        },
        identityOf: async () => null,
      },
    ),
    /Mirage exited before it became ready/,
  );
  assert.equal(spawned, 1);
});

test('a start removes the records of runtimes that have exited, on any state file, and keeps a live one', async (t) => {
  const { root, paths, stateFile } = await fixture(t);
  const other = path.resolve(root, 'other', 'state.json');
  const record = (pid, file) => ({
    pid,
    processIdentity: `identity ${pid}`,
    discovery: path.join(paths.discoveryRoot, `session-${pid}.json`),
    stateFile: file,
    identity: identityFor(file, 'always'),
    ready: true,
  });
  // Runtimes that were killed leave their records behind: two on this state file, one on another, beside a live one.
  await updateOwnedSessions(paths, () => [
    record(DEAD, stateFile),
    record(DEAD + 10, stateFile),
    record(DEAD + 20, other),
    record(RIVAL, other),
  ]);
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile, 'preset-mode': 'bootstrap' },
      {
        paths,
        alive: (pid) => pid === RIVAL,
        spawnRuntime: () => exitedChild(CHILD),
        identityOf: async (pid) => (pid === RIVAL ? `identity ${RIVAL}` : 'child identity'),
      },
    ),
    /Mirage exited before it became ready/,
  );
  assert.deepEqual(
    (await ownedSessions(paths)).map((item) => item.pid),
    [RIVAL],
  );
});

// @test-kind contract: an identical live runtime on the same state file is still reused without spawning
test('an identical live runtime on the same state file is still reused without spawning', async (t) => {
  const { root, paths, stateFile } = await fixture(t);
  const url = await readyRuntime(t, () => {});
  const discovery = path.join(paths.discoveryRoot, `session-${process.pid}.json`);
  await fs.writeFile(discovery, JSON.stringify({ pid: process.pid, url }));
  await ownRecord(paths, { processIdentity: 'live identity', stateFile, presetMode: 'always' });
  const result = await start(
    cfg(root),
    { port: '0', state: stateFile },
    {
      paths,
      identityOf: liveIdentity,
      spawnRuntime() {
        throw new Error('an identical runtime must be reused, not spawned');
      },
    },
  );
  assert.equal(result.started, false);
  assert.equal(result.pid, process.pid);
  assert.equal(result.url, url);
});

// @test-kind contract: a start that wins the ownership lock after a live runtime claimed the same state file stops its own child
test('a start that wins the ownership lock after a live runtime claimed the same state file stops its own child', async (t) => {
  const { root, paths, stateFile } = await fixture(t);
  const signals = [];
  const child = { ...exitedChild(CHILD), exitCode: null, kill: (signal) => signals.push(signal) };
  // A record that matches this start passes the pre-spawn check unread, and its identity is read only before the lock.
  await ownRecord(paths, { pid: REUSED, processIdentity: 'old identity', stateFile, presetMode: 'bootstrap' });
  // The rival claims the state file while the start reads the identity of REUSED, before the ownership lock is taken.
  // The claim is not in that snapshot, so the record callback first sees it under the lock and refuses the start.
  let claimed = null;
  const identityOf = async (pid) => {
    if (pid === CHILD) return 'child identity';
    if (claimed === null) {
      await ownRecord(paths, { pid: RIVAL, processIdentity: 'rival identity', stateFile, presetMode: 'always' });
      claimed = await fs.readFile(paths.ownershipFile, 'utf8');
    }
    return 'reused identity';
  };
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile, 'preset-mode': 'bootstrap' },
      {
        paths,
        alive: (pid) => pid === RIVAL || pid === REUSED,
        spawnRuntime: () => child,
        identityOf,
      },
    ),
    /already uses state file/,
  );
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(await fs.readFile(paths.ownershipFile, 'utf8'), claimed);
});

// @test-kind contract: a start refused for a concurrent start with the same settings says so, and stops its own child
test('a start that loses to a concurrent start with the same settings names the same settings and stops its own child', async (t) => {
  const { root, paths, stateFile } = await fixture(t);
  const signals = [];
  const child = { ...exitedChild(CHILD), exitCode: null, kill: (signal) => signals.push(signal) };
  // The other command records its runtime after this start found nothing to reuse and spawned its own child.
  let claimed = null;
  const identityOf = async (pid) => {
    if (pid !== CHILD) return 'rival identity';
    await ownRecord(paths, { pid: RIVAL, processIdentity: 'rival identity', stateFile, presetMode: 'always' });
    claimed = await fs.readFile(paths.ownershipFile, 'utf8');
    return 'child identity';
  };
  let refusal;
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile },
      { paths, alive: (pid) => pid === RIVAL, spawnRuntime: () => child, identityOf },
    ),
    (error) => {
      refusal = error.message;
      return true;
    },
  );
  assert.match(
    refusal,
    new RegExp(
      `^Mirage pid ${RIVAL} is already starting \\(or running\\) for state file ${escapeRegExp(stateFile)} with the same settings; wait until it is ready and run the command again to reuse it, or stop it with .+\\.$`,
    ),
  );
  assert.doesNotMatch(refusal, /different settings|--state <other file>/);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(await fs.readFile(paths.ownershipFile, 'utf8'), claimed);
});

// @test-kind contract: a local state folder that cannot be created is reported with the folder, the cause and the next step, before spawning
test('a start whose local state folder is a file names the folder and the file in its way, before spawning', async (t) => {
  const root = await tempDir('paq-state-owner-');
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, '.paqvilo');
  await fs.writeFile(stateDir, 'not a folder');
  const site = cfg(stateDir);
  const paths = miragePaths(site);
  let spawned = 0;
  let failure;
  await assert.rejects(
    start(
      site,
      { port: '0', state: path.resolve(root, 'shared', 'state.json') },
      {
        paths,
        identityOf: async () => null,
        spawnRuntime() {
          spawned++;
          return exitedChild(CHILD);
        },
      },
    ),
    (error) => {
      failure = error;
      return true;
    },
  );
  assert.match(failure.code, /^(ENOTDIR|EEXIST)$/);
  assert.equal(
    failure.message,
    `Cannot create the local state folder ${paths.logRoot}: ${stateDir} exists but is not a folder (${failure.code}). Remove or rename it, or run from a project folder you can write to.`,
  );
  assert.equal(failure.cause.code, failure.code);
  assert.equal(spawned, 0);
});

test('a local state folder that is not writable is reported as such, and other failures pass unchanged', async (t) => {
  const { root } = await fixture(t);
  const folder = path.join(root, 'mirage', 'logs');
  for (const code of ['EACCES', 'EPERM', 'EROFS']) {
    const cause = Object.assign(new Error(`${code}: invented`), { code });
    await assert.rejects(
      createStateFolder(folder, {
        mkdir: async () => {
          throw cause;
        },
      }),
      (error) => {
        assert.equal(
          error.message,
          `Cannot create the local state folder ${folder}: ${root} is not writable (${code}). Allow writing there, or run from a project folder you can write to.`,
        );
        assert.equal(error.code, code);
        assert.equal(error.cause, cause);
        return true;
      },
    );
  }
  const other = Object.assign(new Error('ENOSPC: invented'), { code: 'ENOSPC' });
  await assert.rejects(
    createStateFolder(folder, {
      mkdir: async () => {
        throw other;
      },
    }),
    (error) => error === other,
  );
});

// @test-kind contract: a live record whose PID no longer carries its recorded start identity is stale, so a start neither refuses on it nor keeps it
test('a start drops a live record whose PID was reused instead of refusing on it', async (t) => {
  const { root, paths, stateFile } = await fixture(t);
  await ownRecord(paths, { pid: RIVAL, processIdentity: 'old identity', stateFile, presetMode: 'always' });
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile, 'preset-mode': 'bootstrap' },
      {
        paths,
        alive: (pid) => pid === RIVAL,
        spawnRuntime: () => exitedChild(CHILD),
        identityOf: async (pid) => {
          if (pid === RIVAL)
            assert.equal(
              fsSync.existsSync(`${paths.ownershipFile}.lock`),
              false,
              'identities are read outside the ownership lock',
            );
          return pid === RIVAL ? 'reused identity' : 'child identity';
        },
      },
    ),
    /Mirage exited before it became ready/,
  );
  assert.equal(
    (await ownedSessions(paths)).some((item) => item.pid === RIVAL),
    false,
  );
});

test('a start keeps a live record whose identity cannot be read', async (t) => {
  const { root, paths, stateFile } = await fixture(t);
  await ownRecord(paths, { pid: RIVAL, processIdentity: 'old identity', stateFile, presetMode: 'always' });
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile, 'preset-mode': 'bootstrap' },
      {
        paths,
        alive: (pid) => pid === RIVAL,
        identityOf: async (pid) => {
          if (pid === RIVAL)
            assert.equal(
              fsSync.existsSync(`${paths.ownershipFile}.lock`),
              false,
              'identities are read outside the ownership lock',
            );
          return pid === CHILD ? 'child identity' : null;
        },
        spawnRuntime: () => exitedChild(CHILD),
      },
    ),
    /Mirage exited before it became ready/,
  );
  assert.equal(
    (await ownedSessions(paths)).some((item) => item.pid === RIVAL),
    true,
  );
});

test('a live rival that took over a pre-read PID is refused, not dropped', async (t) => {
  const { root, paths, stateFile } = await fixture(t);
  await ownRecord(paths, { pid: RIVAL, processIdentity: 'old identity', stateFile, presetMode: 'bootstrap' });
  // The unrelated process at RIVAL has ended. A new Mirage got the same PID and claimed the state file after the
  // identity of RIVAL was read and before the ownership lock is taken.
  let replaced = false;
  const identityOf = async (pid) => {
    if (pid === CHILD) return 'child identity';
    if (!replaced) {
      replaced = true;
      await ownRecord(paths, { pid: RIVAL, processIdentity: 'rival identity', stateFile, presetMode: 'always' });
    }
    return 'unrelated identity';
  };
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile, 'preset-mode': 'bootstrap' },
      {
        paths,
        alive: (pid) => pid === RIVAL,
        spawnRuntime: () => exitedChild(CHILD),
        identityOf,
      },
    ),
    /already uses state file/,
  );
});

function exitedChild(pid) {
  return { pid, exitCode: 1, killed: false, unref() {}, kill() {} };
}

function escapeRegExp(value) {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}
