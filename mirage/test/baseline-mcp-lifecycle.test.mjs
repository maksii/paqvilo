// @test-kind contract: Paqvilo's MCP stdio client settles every pending call and clears its own timers when its bridge fails, exits or is closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMcpServer } from '../mcp-stdio.mjs';
import { calledFrom } from './support/timer-origin.mjs';

// The pending calls below would otherwise wait for their 60-second call timeout. The runner's --test-timeout is the
// hang guard; the rejection messages and the cleared timers prove the calls did not wait for that timeout.
const CALL_TIMEOUT_MS = 60_000;
const MCP_CLIENT = new URL('../mcp-stdio.mjs', import.meta.url).href;

// Records the timers the MCP client itself arms, and every handle cleared. Other code in the process (an earlier
// test's connection, the runner) arms timers too; they are not the client's and are not counted.
function clientTimers(t) {
  const armed = [],
    cleared = new Set();
  const { setTimeout: schedule, clearTimeout: cancel } = globalThis;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...rest) => {
    const handle = schedule(callback, delay, ...rest);
    if (calledFrom(MCP_CLIENT, import.meta.url)) armed.push(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => {
    cleared.add(handle);
    return cancel(handle);
  });
  return { armed: () => armed.length, uncleared: () => armed.filter((handle) => !cleared.has(handle)).length };
}

test('missing bridge executable rejects initialization without an unhandled process error', async (t) => {
  const timers = clientTimers(t);
  const client = startMcpServer({ command: 'paqvilo-invented-missing-bridge-executable-7f20' });
  await assert.rejects(client.initialize(), /failed to start/);
  await client.close();
  await assert.rejects(client.listTools(), /failed to start/);
  // The initialize call timer and the close guard.
  assert.deepEqual({ armed: timers.armed(), uncleared: timers.uncleared() }, { armed: 2, uncleared: 0 });
});

test('bridge exit rejects every outstanding request promptly and rejects future reads', async (t) => {
  const timers = clientTimers(t);
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
  // One call timer per pending request, all cleared by the exit.
  assert.deepEqual({ armed: timers.armed(), uncleared: timers.uncleared() }, { armed: 3, uncleared: 0 });
  await assert.rejects(client.listTools(), /process exited/);
  await client.close();
});

test('explicit close rejects pending calls, is idempotent and leaves no grace timer after cooperative exit', async (t) => {
  const timers = clientTimers(t);
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
  // The call timer and the close guard.
  assert.deepEqual({ armed: timers.armed(), uncleared: timers.uncleared() }, { armed: 2, uncleared: 0 });
  await assert.rejects(client.initialize(), /client closed/);
});
