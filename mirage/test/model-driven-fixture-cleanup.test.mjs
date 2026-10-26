import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { ownedFixture, removeFixtureDirectory } from '../testing/owned-fixture.mjs';

test(
  'model-driven fixture retires a transiently locked solution after its closers drain',
  { timeout: 15000, skip: process.platform !== 'win32' && 'Windows exclusive file handles prevent deletion' },
  async (t) => {
    const hooks = [];
    const context = { after: (callback) => hooks.push(callback) };
    const fixture = await modelDrivenFixture(context, { defer: true });
    const locked = path.join(fixture.solutionDir, 'locked.xml');
    await fs.writeFile(locked, 'invented evidence');
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$stream = [System.IO.File]::Open($env:PAQVILO_TEST_LOCK, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None); try { [Console]::WriteLine("locked"); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }',
      ],
      { env: { ...process.env, PAQVILO_TEST_LOCK: locked }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const closed = once(child, 'close');
    const lines = readline.createInterface({ input: child.stdout });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      lines.close();
      await removeFixtureDirectory(fixture.root);
    });
    assert.equal((await once(lines, 'line', { signal: t.signal }))[0], 'locked');
    await assert.rejects(fs.rm(fixture.root, { recursive: true, force: true }), (error) =>
      ['EBUSY', 'EPERM'].includes(error.code),
    );
    let drained = false;
    ownedFixture(context).add(async () => {
      drained = true;
    });
    const cleanup = hooks[0]();
    assert.equal((await fs.stat(locked)).size, 'invented evidence'.length);
    assert.equal(drained, true);
    child.stdin.end('release\n');
    await cleanup;
    assert.deepEqual(await closed, [0, null]);
    await assert.rejects(fs.stat(fixture.root), { code: 'ENOENT' });
  },
);
