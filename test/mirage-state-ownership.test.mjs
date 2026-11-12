// @test-kind contract: a Mirage state file's ownership, reuse and refusal rules for live and dead runtime records
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { start, miragePaths, updateOwnedSessions, processIdentityAsync } from '../lense/commands/mirage.mjs';
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

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await once(child, 'exit');
  return child.pid;
}

// @test-kind contract: a start refuses a state file that a live runtime with a verified identity owns with other settings, before spawning
test('a start refuses a state file that a live runtime with a verified identity owns with other settings, before spawning', async (t) => {
  const { root, paths, stateFile } = await fixture(t);
  const processIdentity = await processIdentityAsync(process.pid);
  assert.ok(processIdentity, 'the test process has a readable start identity');
  await ownRecord(paths, { processIdentity, stateFile, presetMode: 'always' });
  let spawned = 0;
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile, 'preset-mode': 'bootstrap' },
      {
        paths,
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
  const pid = await deadPid();
  await ownRecord(paths, { pid, processIdentity: 'invented identity', stateFile, presetMode: 'always' });
  let spawned = 0;
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile, 'preset-mode': 'bootstrap' },
      {
        paths,
        spawnRuntime() {
          spawned++;
          return exitedChild(pid);
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
  const processIdentity = await processIdentityAsync(process.pid);
  await ownRecord(paths, { processIdentity, stateFile, presetMode: 'always' });
  const result = await start(
    cfg(root),
    { port: '0', state: stateFile },
    {
      paths,
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
  // The live record is unverified, so the pre-spawn check admits the start; the record callback refuses it.
  await ownRecord(paths, { processIdentity: 'unused identity', stateFile, presetMode: 'always' });
  const before = await fs.readFile(paths.ownershipFile, 'utf8');
  const signals = [];
  const child = { ...exitedChild(await deadPid()), exitCode: null, kill: (signal) => signals.push(signal) };
  await assert.rejects(
    start(
      cfg(root),
      { port: '0', state: stateFile, 'preset-mode': 'bootstrap' },
      {
        paths,
        spawnRuntime: () => child,
        identityOf: async () => 'child identity',
      },
    ),
    /already uses state file/,
  );
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(await fs.readFile(paths.ownershipFile, 'utf8'), before);
});

function exitedChild(pid) {
  return { pid, exitCode: 1, killed: false, unref() {}, kill() {} };
}

function escapeRegExp(value) {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}
