import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { processIdentities, processIdentity, isAlive } from '../lense/commands/mirage.mjs';

// The process a non-administrator cannot open on this OS: System on Windows, init on POSIX.
const SYSTEM_PID = process.platform === 'win32' ? 4 : 1;

test('batched process identities match single reads for live, missing and system processes', async () => {
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await once(exited, 'exit');
  // An exited child's PID is missing unless the OS already reused it, which the per-PID comparison still covers.
  const pids = [process.pid, exited.pid, SYSTEM_PID];
  const single = new Map(pids.map((pid) => [pid, processIdentity(pid)]));
  // More than one PID takes the batched path; repeats and invalid PIDs are ignored as before.
  const batched = processIdentities([...pids, process.pid, 0, -1, 1.5]);
  assert.deepEqual([...batched.keys()], pids);
  assert.deepEqual(batched, single);
  assert.match(batched.get(process.pid), /\S/, 'a live process has a readable identity');
  if (!isAlive(exited.pid)) assert.equal(batched.get(exited.pid), null, 'a missing process has no identity');
});
