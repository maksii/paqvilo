import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { discoveries } from '../lense/commands/mirage.mjs';
import { tempDir } from './fixture.mjs';

test('status prunes discoveries of exited runtimes and keeps live records', async (t) => {
  const discoveryRoot = await tempDir('paqvilo-dead-discovery-');
  t.after(() => fs.rm(discoveryRoot, { recursive: true, force: true }));
  // The largest PID the process APIs accept is above every platform's limit (Linux PID_MAX_LIMIT is 2^22; Windows
  // PIDs index a handle table far below 2^31), so it names no live process. An exited child's PID could already be
  // reused by another process when the record is checked, Windows reusing PIDs soonest.
  const dead = 2 ** 31 - 1;
  const file = (pid) => path.join(discoveryRoot, `session-${pid}.json`);
  for (const pid of [dead, process.pid])
    await fs.writeFile(file(pid), JSON.stringify({ pid, url: 'http://127.0.0.1:9/', sourceDir: discoveryRoot }));
  const sessions = await discoveries({ discoveryRoot }, { probe: false });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].pid, process.pid);
  await assert.rejects(fs.access(file(dead)), { code: 'ENOENT' });
  await fs.access(file(process.pid));
});
