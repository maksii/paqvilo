import test from 'node:test';
import assert from 'node:assert/strict';
import { startMcpServer } from '../mcp-stdio.mjs';

test(
  'missing bridge executable rejects initialization without an unhandled process error',
  { timeout: 2000 },
  async () => {
    const client = startMcpServer({ command: 'paqvilo-invented-missing-bridge-executable-7f20' });
    await assert.rejects(client.initialize(), /failed to start/);
    await client.close();
    await assert.rejects(client.listTools(), /failed to start/);
  },
);

test('bridge exit rejects every outstanding request promptly and rejects future reads', { timeout: 3000 }, async () => {
  const client = startMcpServer({ command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(23),50)'] });
  const pending = Promise.allSettled([client.initialize(), client.listTools(), client.callTool('pending', {}, 60000)]);
  const results = await pending;
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /process exited \(23\)/);
  }
  await assert.rejects(client.listTools(), /process exited/);
  await client.close();
});

test(
  'explicit close rejects pending calls, is idempotent and leaves no grace timer after cooperative exit',
  { timeout: 2000 },
  async () => {
    const client = startMcpServer({
      command: process.execPath,
      args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],
    });
    const pending = client.callTool('pending', {}, 60000);
    const rejected = assert.rejects(pending, /client closed/);
    const first = client.close(),
      second = client.close();
    assert.strictEqual(first, second);
    await Promise.all([first, rejected]);
    await assert.rejects(client.initialize(), /client closed/);
  },
);
