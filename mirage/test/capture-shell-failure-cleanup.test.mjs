// @test-kind contract: a locally created capture runtime remains cleanup-owned when initialization fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inventedProjectFixture } from './fixtures/source-site.mjs';
import { captureShell } from '../capture-shell.mjs';

for (const phase of ['snapshot', 'replaceState', 'configure']) {
  test(`shell capture closes its runtime after ${phase} fails`, async (t) => {
    const root = await inventedProjectFixture(t, 'paqvilo-capture-cleanup-');
    const config = path.join(root, 'paqvilo.config.yml');
    await fs.appendFile(config, '    mirage:\n      port: 0\n');
    let closed = 0;
    const fail = () => {
      throw new Error(`invented ${phase} failure`);
    };
    const runtime = {
      store: {
        snapshot: phase === 'snapshot' ? fail : () => ({ simulator: {} }),
        replaceState: phase === 'replaceState' ? fail : async () => {},
      },
      live: { configure: phase === 'configure' ? fail : () => {} },
      close: async () => {
        closed++;
      },
    };
    await assert.rejects(
      captureShell({
        config,
        site: 'invented',
        cdp: 'http://127.0.0.1:9222',
        createLocalSimulator: async () => runtime,
      }),
      new RegExp(`invented ${phase} failure`),
    );
    assert.equal(closed, 1);
  });
}
