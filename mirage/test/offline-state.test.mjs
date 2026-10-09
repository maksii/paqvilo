import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertOfflineState, stateFileFingerprint } from '../lib/offline-state.mjs';

test('offline state checks discover the owning project outside the installed toolkit', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-project-state-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const discovery = path.join(project, '.paqvilo/simulator');
  await fs.mkdir(discovery, { recursive: true });
  for (const state of [path.join(discovery, 'portal/state.json'), path.join(project, 'custom-state.json')]) {
    await fs.writeFile(path.join(discovery, 'session-1.json'), JSON.stringify({ pid: 1, stateFile: state }));
    await assert.rejects(assertOfflineState(state, { isRunning: () => true }), /Stop the Mirage/);
    await assertOfflineState(state, { isRunning: () => false });
  }
});

test('offline import refuses active matching single/project state and detects file edits', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-offline-state-'));
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
