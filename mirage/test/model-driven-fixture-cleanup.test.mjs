import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test(
  'model-driven fixture closes its simulator before retrying a locked Solution file',
  { timeout: 20000, skip: process.platform !== 'win32' && 'Windows exclusive file handles prevent deletion' },
  () => {
    // A fresh process installs the observer before Node's recursive rm loads its internal unlink reference.
    const program = `
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import path from 'node:path';
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      import readline from 'node:readline';
      const unlink = fs.unlink;
      let lockedFile, held, closed = false, observedBusy = false;
      fs.unlink = (file, callback) => unlink(file, (error) => {
        if (String(file) === lockedFile && ['EBUSY', 'EPERM'].includes(error?.code)) {
          if (!closed) throw new Error('Removal began before simulator closed');
          observedBusy = true;
          held.stdin.end('release\\n');
        }
        callback(error);
      });
      const { modelDrivenFixture } = await import(${JSON.stringify(new URL('./model-driven-fixture.mjs', import.meta.url).href)});
      const hooks = [], context = { after: (hook) => hooks.push(hook) };
      const fixture = await modelDrivenFixture(context, { defer: true });
      const simulator = await fixture.start();
      const close = simulator.close.bind(simulator);
      simulator.close = async () => { await close(); closed = true; };
      lockedFile = path.join(fixture.solutionDir, 'held.txt');
      held = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$stream = [System.IO.File]::Open($env:PAQVILO_FIXTURE_LOG, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); try { [Console]::WriteLine("holding"); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }'],
        { env: { ...process.env, PAQVILO_FIXTURE_LOG: lockedFile }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const finished = once(held, 'close');
      const lines = readline.createInterface({ input: held.stdout });
      try {
        const [line] = await once(lines, 'line');
        if (line !== 'holding') throw new Error('Lock holder failed to initialize');
        await hooks[0]();
        if (!closed || !observedBusy) throw new Error('Did not observe close followed by a busy removal');
        const [code] = await finished;
        if (code !== 0) throw new Error('Lock holder failed');
        try { await fsp.stat(fixture.root); throw new Error('Fixture directory remains'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      } finally {
        held.stdin.end();
        if (held.exitCode === null && held.signalCode === null) held.kill();
        await finished;
        lines.close();
        if (!closed) await close();
        await fsp.rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  },
);
