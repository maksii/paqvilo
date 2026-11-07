import test from 'node:test';
import assert from 'node:assert/strict';
import { startMcpServer } from '../mcp-stdio.mjs';

// The pending calls below would otherwise wait for their 60-second call timeout, and close() would wait out its 5-second
// kill grace: the bound is below the first, and the timer count proves the grace and call timers were cleared rather
// than relying on wall-clock speed (a loaded runner may take seconds to start a child).
const CALL_TIMEOUT_MS = 60_000,
  BOUND = { timeout: CALL_TIMEOUT_MS / 2 };
const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

test('missing bridge executable rejects initialization without an unhandled process error', BOUND, async () => {
  const before = timers();
  const client = startMcpServer({ command: 'paqvilo-invented-missing-bridge-executable-7f20' });
  await assert.rejects(client.initialize(), /failed to start/);
  await client.close();
  await assert.rejects(client.listTools(), /failed to start/);
  assert.equal(timers(), before, 'no timer outlives the failed start');
});

test('bridge exit rejects every outstanding request promptly and rejects future reads', BOUND, async () => {
  const before = timers();
  const client = startMcpServer({ command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(23),50)'] });
  const pending = Promise.allSettled([
    client.initialize(),
    client.listTools(),
    client.callTool('pending', {}, CALL_TIMEOUT_MS),
  ]);
  const results = await pending;
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /process exited \(23\)/);
  }
  assert.equal(timers(), before, 'the exit cleared the pending call timer');
  await assert.rejects(client.listTools(), /process exited/);
  await client.close();
});

test(
  'explicit close rejects pending calls, is idempotent and leaves no grace timer after cooperative exit',
  BOUND,
  async () => {
    const before = timers();
    const client = startMcpServer({
      command: process.execPath,
      args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],
    });
    const pending = client.callTool('pending', {}, CALL_TIMEOUT_MS);
    const rejected = assert.rejects(pending, /client closed/);
    const first = client.close(),
      second = client.close();
    assert.strictEqual(first, second);
    await Promise.all([first, rejected]);
    assert.equal(timers(), before, 'the cooperative exit cleared the grace and call timers');
    await assert.rejects(client.initialize(), /client closed/);
  },
);
