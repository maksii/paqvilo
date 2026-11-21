// @test-kind contract: offline state writes refuse a state file that a discovered runtime may hold, judged only on the host that wrote the discovery
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertOfflineState, stateFileFingerprint } from '../lib/offline-state.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('offline state checks discover the owning project outside the installed toolkit', async (t) => {
  const project = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-project-state-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const discovery = path.join(project, '.paqvilo/simulator');
  await fs.mkdir(discovery, { recursive: true });
  for (const state of [path.join(discovery, 'portal/state.json'), path.join(project, 'custom-state.json')]) {
    await fs.writeFile(path.join(discovery, 'session-1.json'), JSON.stringify({ pid: 1, stateFile: state }));
    await assert.rejects(assertOfflineState(state, { isRunning: () => true }), /Stop the Mirage/);
    await assertOfflineState(state, { isRunning: () => false });
  }
});

test('offline import refuses active matching single/project state and detects file edits', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-offline-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = path.join(directory, 'state.json');
  await fs.writeFile(state, '{}');
  const fingerprint = await stateFileFingerprint(state);
  const file = path.join(directory, 'session-123.json');
  await fs.writeFile(file, JSON.stringify({ pid: 123, stateFile: state }));
  await assert.rejects(assertOfflineState(state, { directory, isRunning: () => true }), /Stop the Mirage/);
  await assertOfflineState(state, { directory, isRunning: () => false });
  await fs.writeFile(file, JSON.stringify({ pid: 123, portals: [{ stateFile: state }] }));
  await assert.rejects(assertOfflineState(state, { directory, isRunning: () => true }), /Stop the Mirage/);
  await assertOfflineState(path.join(directory, 'other.json'), { directory, isRunning: () => true });
  await fs.writeFile(state, '{"edited":true}');
  assert.notEqual(await stateFileFingerprint(state), fingerprint);
});

test('a runtime discovered with another host stamp counts as using its state, whatever a local PID says', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-offline-foreign-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = path.join(directory, 'state.json');
  const file = path.join(directory, 'session-123.json');
  const isRunning = () => false;
  await fs.writeFile(file, JSON.stringify({ pid: 123, host: 'linux/other-runner', stateFile: state }));
  await assert.rejects(assertOfflineState(state, { directory, isRunning, host: 'win32/this-runner' }), (error) => {
    assert.equal(
      error.message,
      `Stop the Mirage using this state (${state}) before importing reference records. It was started on linux/other-runner; if it no longer runs there (the host was renamed or removed), delete ${file}.`,
    );
    return true;
  });
  // Stamped with this host, or with no host (an older runtime), the local PID decides as before.
  for (const host of ['win32/this-runner', undefined]) {
    await fs.writeFile(file, JSON.stringify({ pid: 123, host, stateFile: state }));
    await assertOfflineState(state, { directory, isRunning, host: 'win32/this-runner' });
  }
});
