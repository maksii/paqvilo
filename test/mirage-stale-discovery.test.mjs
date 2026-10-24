import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoveries } from '../lense/commands/mirage.mjs';

test('status prunes discoveries of exited runtimes and keeps live records', async (t) => {
  const discoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-dead-discovery-'));
  t.after(() => fs.rm(discoveryRoot, { recursive: true, force: true }));
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true }).pid;
  const file = (pid) => path.join(discoveryRoot, `session-${pid}.json`);
  for (const pid of [dead, process.pid])
    await fs.writeFile(file(pid), JSON.stringify({ pid, url: 'http://127.0.0.1:9/', sourceDir: discoveryRoot }));
  const sessions = await discoveries({ discoveryRoot }, { probe: false });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].pid, process.pid);
  await assert.rejects(fs.access(file(dead)), { code: 'ENOENT' });
  await fs.access(file(process.pid));
});
