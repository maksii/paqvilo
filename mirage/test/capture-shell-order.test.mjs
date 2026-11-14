// @test-kind contract: capture-shell owns and snapshots an injected simulator at the original await boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inventedProjectFixture } from './fixtures/source-site.mjs';
import { captureShell } from '../capture-shell.mjs';

test('capture snapshots an owned runtime before its queued revocation and closes it on failure', async (t) => {
  const root = await inventedProjectFixture(t, 'paqvilo-capture-order-');
  const config = path.join(root, 'paqvilo.config.yml');
  await fs.appendFile(config, '    mirage:\n      port: 0\n');
  const events = [],
    sentinel = new Error('stop after snapshot');
  let revoked = false;
  const runtime = {
    store: {
      snapshot() {
        events.push(revoked ? 'snapshot-revoked' : 'snapshot-open');
        throw sentinel;
      },
    },
    close: async () => {
      events.push('cleanup');
    },
  };
  await assert.rejects(
    captureShell({
      config,
      site: 'invented',
      cdp: 'http://127.0.0.1:9222',
      createLocalSimulator() {
        queueMicrotask(() =>
          queueMicrotask(() => {
            revoked = true;
            events.push('revoked');
          }),
        );
        return Promise.resolve(runtime);
      },
    }),
    (error) => error === sentinel,
  );
  assert.ok(events.indexOf('snapshot-open') >= 0);
  assert.ok(events.indexOf('snapshot-open') < events.indexOf('revoked'));
  assert.equal(events.filter((event) => event === 'cleanup').length, 1);
});
