import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeHeartbeat } from '../scripts/runtime-heartbeat.mjs';

test('runtime heartbeat covers response bodies and reports a blocked operation independently of the UI work', async () => {
  let failures = 0;
  const heartbeat = runtimeHeartbeat('http://127.0.0.1', {
    timeoutMs: 10,
    onFailure: () => failures++,
    fetch: async (_url, { signal }) => ({
      status: 200,
      arrayBuffer: () =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    }),
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(heartbeat.failure, { name: 'TimeoutError' });
    assert.equal(failures, 1);
  } finally {
    clearTimeout(keepAlive);
    await heartbeat.stop();
  }
});

test('stopping an owned heartbeat cancels a pending read without reporting a qualification failure', async () => {
  let release;
  const started = new Promise((resolve) => {
    release = resolve;
  });
  const heartbeat = runtimeHeartbeat('http://127.0.0.1', {
    onFailure: () => assert.fail('Owned cancellation'),
    fetch: async (_url, { signal }) => {
      release();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  await started;
  await heartbeat.stop();
  assert.equal(heartbeat.metrics().heartbeats, 0);
});
