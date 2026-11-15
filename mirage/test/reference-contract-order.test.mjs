// @test-kind contract: the injected reference bridge retains request ordering relative to response observers.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compareReferenceContracts } from '../reference-parity.mjs';

test('the next bridge request begins before queued response observer work', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'paqvilo-reference-order-'));
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ config: { mode: 'local', pageMode: 'local', endpoints: [] }, status: {}, data: {} }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const events = [];
    let count = 0;
    const bridge = {
      request: async () => {
        const n = ++count;
        events.push(`bridge${n}`);
        return {
          get status() {
            if (n === 1) queueMicrotask(() => events.push('status-marker'));
            return 200;
          },
          body: '{}',
        };
      },
    };
    const localSession = {
      origin,
      session: async () => ({ signedIn: false }),
      request: async () => ({ status: 200, text: async () => '{}' }),
    };
    await compareReferenceContracts({
      localUrl: origin,
      origin: 'https://reference.invalid',
      contracts: [
        { id: 'one', path: '/_api/one' },
        { id: 'two', path: '/_api/two' },
      ],
      outputDir: directory,
      bridge,
      localSession,
    });
    assert.deepEqual(events, ['bridge1', 'bridge2', 'status-marker', 'status-marker']);
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
    await rm(directory, { recursive: true, force: true });
  }
});
