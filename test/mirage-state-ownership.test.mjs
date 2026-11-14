// @test-kind contract: a Mirage state file's ownership, reuse and refusal rules for live and dead runtime records
import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { start, miragePaths, ownedSessions, updateOwnedSessions } from '../lense/commands/mirage.mjs';
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
