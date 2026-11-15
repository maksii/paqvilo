// @test-kind contract: an injected identity observer retains its ordering relative to page driver calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runParitySuite } from '../parity-suite.mjs';

test('page driver runs before microtask queued by identity description', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'paqvilo-scenario-order-'));
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: {}, config: {}, data: {}, diagnostics: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const events = [];
    const identity = {
      use: () => null,
      describe() {
        queueMicrotask(() => events.push('identity-marker'));
        return null;
      },
    };
    const side = {
      origin,
      page() {
        events.push('page');
        throw new Error('stop after page');
      },
    };
    const plan = { version: 1, scenarios: [{ id: 'one', kind: 'page-dom', path: '/', questions: [] }] };
    const report = await runParitySuite({
      plan,
      localUrl: origin,
      origin,
      sides: { live: side, local: side },
      identity,
      outDir: directory,
      delayMs: 0,
    });
    assert.equal(report.scenarios[0].verdict, 'error');
    assert.deepEqual(events, ['page', 'identity-marker']);
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
    await rm(directory, { recursive: true, force: true });
  }
});
