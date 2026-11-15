// @test-kind contract: a CLR step's time starts when its host process exists; host creation is bounded by its own hang guard
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';
import { executeClrPlugin, closeClrHostPool, clrHostPoolStatus } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, compileClr } from './fixtures/clr-sdk.mjs';

// The forced schedule: every CLR worker starts its host this long after it was created, past the step's
// 100 ms timeout plus the main thread's 1 s margin.
const START_DELAY_MS = 1_500;

// Every CLR worker the code under test creates runs `entry` first, which then imports the CLR worker it wraps; `exits`
// receives each wrapped worker's exit.
function wrapClrWorkers(entry, workerData = {}, exits = []) {
  const { Worker } = workerThreads;
  const wrapper = new URL(entry, import.meta.url);
  workerThreads.Worker = class extends Worker {
    constructor(url, options) {
      super(wrapper, { ...options, workerData: { ...options.workerData, workerUrl: String(url), ...workerData } });
      // Not events.once: a worker that ends by throwing emits 'error' before 'exit'.
      exits.push(new Promise((resolve) => this.once('exit', resolve)));
    }
  };
  syncBuiltinESMExports();
  return () => {
    workerThreads.Worker = Worker;
    syncBuiltinESMExports();
  };
}

for (const persistentHost of [false, true])
  test(
    `a ${persistentHost ? 'pooled' : 'fresh'} CLR step whose host starts late times out on its host, not before it`,
    { skip: CLR_SKIP },
    async (t) => {
      t.after(() => closeClrHostPool());
      const runtime = await silentHostRuntime(t, { persistentHost, timeoutMs: 100 });
      const restore = wrapClrWorkers('./fixtures/clr-delayed-worker.mjs', { startDelayMs: START_DELAY_MS });
      const notes = [];
      try {
        assert.throws(
          () => executeClrPlugin(runtime, {}, { store: {}, diagnostic: (note) => notes.push(note) }),
          (error) => error.code === 'LocalPluginTimeout',
        );
      } finally {
        restore();
      }
      const started = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STARTED');
      const stopped = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
      assert.equal(started.length, 1, 'the timeout is decided after the host process exists');
      assert.deepEqual(
        stopped.map((note) => [note.pid, note.absenceVerified]),
        [[started[0].pid, true]],
        'the timed-out host is stopped and verified absent',
      );
    },
  );

for (const persistentHost of [false, true])
  test(
    `a ${persistentHost ? 'pooled' : 'fresh'} CLR step times out on the main thread's deadline from its host start when the worker's own timer never fires`,
    { skip: CLR_SKIP },
    async (t) => {
      t.after(() => closeClrHostPool());
      const timeoutMs = 100;
      // The host answers once the gate file exists; the clock below writes it only after the main thread has checked
      // its deadline once since the host started without ending the step.
      const gate = path.join(await fs.realpath(os.tmpdir()), 'paqvilo-clr-gate-' + process.pid + '-' + persistentHost);
      t.after(() => fs.rm(gate, { force: true }));
      const runtime = await silentHostRuntime(
        t,
        { persistentHost, timeoutMs },
        'public static class Gated{public static void Main(){System.Console.ReadLine();while(!System.IO.File.Exists(' +
          JSON.stringify(gate) +
          String.raw`))System.Threading.Thread.Sleep(10);System.Console.WriteLine("{\"kind\":\"result\"}");System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);}}`,
      );
      // The main thread's clock: once the host has started it reads the step's timeout plus the 1 s margin later, so
      // the first deadline check after the start ends the step; any later check opens the gate.
      const now = Date.now;
      let skew = 0,
        checks = -1;
      t.mock.method(Date, 'now', () => {
        if (checks >= 0 && ++checks === 2) syncFs.writeFileSync(gate, '');
        return now.call(Date) + skew;
      });
      const restore = wrapClrWorkers('./fixtures/clr-timerless-worker.mjs');
      const notes = [];
      const diagnostic = (note) => {
        notes.push(note);
        if (note.code !== 'PLUGIN_CLR_HOST_STARTED') return;
        skew = timeoutMs + 1001;
        checks = 0;
      };
      try {
        assert.throws(
          () => executeClrPlugin(runtime, {}, { store: {}, diagnostic }),
          (error) => error.code === 'LocalPluginTimeout',
        );
      } finally {
        restore();
        t.mock.restoreAll();
      }
      const started = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STARTED');
      const stopped = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
      assert.equal(started.length, 1, 'one host started');
      assert.deepEqual(
        stopped.map((note) => [note.pid, note.absenceVerified]),
        [[started[0].pid, true]],
        'the timed-out host is stopped and verified absent',
      );
    },
  );

for (const persistentHost of [false, true])
  test(
    `a ${persistentHost ? 'pooled' : 'fresh'} CLR worker whose host start is refused at once reports it at once`,
    { skip: CLR_SKIP },
    async (t) => {
      t.after(() => closeClrHostPool());
      const runtime = await silentHostRuntime(t, { persistentHost });
      const workers = [];
      const restore = wrapClrWorkers('./fixtures/clr-spawn-refused-worker.mjs', {}, workers);
      const notes = [];
      try {
        assert.throws(
          () => executeClrPlugin(runtime, {}, { store: {}, diagnostic: (note) => notes.push(note) }),
          (error) =>
            error.status === 503 &&
            error.code === 'LocalPluginHostUnavailable' &&
            error.message ===
              (persistentHost ? 'Owned pooled CLR host could not start.' : 'spawn EINVAL (invented refusal)'),
        );
      } finally {
        restore();
      }
      assert.equal(workers.length, 1, 'one worker was created');
      await Promise.all(workers);
      assert.deepEqual(
        notes.filter((note) => /^PLUGIN_CLR_HOST_/.test(note.code)),
        [],
        'no host process existed to start or stop',
      );
      assert.deepEqual(clrHostPoolStatus(), [], 'no pooled host remains');
      assert.deepEqual(
        (await fs.readdir(path.dirname(runtime.directory))).filter((name) => name.startsWith('clr-')),
        [],
        'no execution snapshot remains',
      );
    },
  );

// A host compiled from an invented source in a fresh folder; by default it reads its invocation and never answers it.
async function silentHostRuntime(
  t,
  descriptor,
  code = 'public static class Silent{public static void Main(){System.Console.ReadLine();System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);}}',
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-clr-host-start-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const directory = path.join(root, 'runtime');
  await fs.mkdir(directory);
  const source = path.join(root, 'Silent.cs'),
    executable = path.join(directory, 'Silent.exe'),
    assembly = path.join(directory, 'Original.dll');
  await fs.writeFile(source, code);
  compileClr(source, executable, { target: 'exe' });
  await fs.writeFile(assembly, 'invented assembly bytes');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const files = await Promise.all(
    [assembly, executable].map(async (file) => ({ path: file, sha256: hash(await fs.readFile(file)) })),
  );
  return {
    directory,
    assembly,
    executable,
    files,
    allowedFiles: files.map((file) => path.basename(file.path)),
    descriptor: { typeName: 'Invented.Original', ...descriptor },
    provenance: { hostSourceSha256: hash(await fs.readFile(new URL('../lib/plugin-clr-host.cs', import.meta.url))) },
  };
}
