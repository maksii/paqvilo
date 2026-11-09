// @test-kind contract+security: terminal child errors survive identity lookup races; live unverified children cannot become owned sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { start, miragePaths } from '../lense/commands/mirage.mjs';
import { tempDir } from './fixture.mjs';

for (const exitsBeforeIdentity of [true, false])
  test(`startup preserves terminal diagnostics without admitting a live unverified child (${exitsBeforeIdentity})`, async (t) => {
    const root = await tempDir('paq-startup-exit-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cfg = { stateDir: root, runtime: { kind: 'model-driven' }, siteName: 'invented' };
    const paths = miragePaths(cfg);
    let child, closed;
    t.after(async () => {
      if (child?.exitCode === null) child.kill('SIGTERM');
      await closed;
    });
    let failure;
    await assert.rejects(
      start(
        cfg,
        { port: '0' },
        {
          paths,
          spawnRuntime(command, _args, options) {
            child = spawn(
              command,
              [
                '-e',
                exitsBeforeIdentity
                  ? 'console.error("Unknown configuration preset missing-config"); process.exit(1)'
                  : 'setInterval(() => {}, 1000)',
              ],
              options,
            );
            closed = once(child, 'close');
            return child;
          },
          async identityOf(pid) {
            assert.equal(pid, child.pid);
            // An exit event, rather than a sleep, forces the failing ownership-lookup ordering.
            if (exitsBeforeIdentity) await closed;
            return null;
          },
        },
      ),
      (error) => {
        failure = error;
        assert.match(
          error.message,
          exitsBeforeIdentity ? /exited before.*missing-config/s : /Could not verify.*ownership/s,
        );
        return true;
      },
    );
    await closed;
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
    assert.equal(failure.writesFiles.length, 1);
    assert.equal(path.dirname(failure.writesFiles[0]), paths.logRoot);
    assert.equal((await fs.stat(failure.writesFiles[0])).isFile(), true);
    assert.deepEqual(await fs.readdir(paths.discoveryRoot).catch(() => []), []);
    assert.equal(
      await fs.stat(paths.ownershipFile).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
