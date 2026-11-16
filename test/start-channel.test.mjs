// @test-kind security: the start channel forwards only allow-listed phase records and bounds what a client sends
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openStartChannel } from '../lense/start-channel.mjs';

test('the start channel forwards only allow-listed phase records and bounds what a client sends', async (t) => {
  const channel = await openStartChannel();
  t.after(() => channel.close());
  const socket = net.connect(channel.address);
  t.after(() => socket.destroy());
  const record = (value) => JSON.stringify({ type: 'runtime-startup', ...value });

  // An over-long line, a record with an extra field and an unlisted phase arrive in one chunk, followed by a line
  // that is still incomplete. Only the allow-listed record is forwarded.
  socket.write(
    `${'x'.repeat(40000)}\n` +
      `${record({ phase: 'state-restore', elapsedMs: 20, secret: 'never-forward' })}\n` +
      `${record({ phase: 'untrusted', elapsedMs: 1 })}\n` +
      '{"type":"runtime-startup",',
  );
  // The incomplete line is completed by the next write and is then forwarded in order.
  socket.write('"phase":"organization","elapsedMs":30}\n');
  socket.write(`${record({ phase: 'ready', elapsedMs: 2 })}\n`);

  assert.deepEqual(await channel.next(), { phase: 'state-restore', elapsedMs: 20 });
  assert.deepEqual(await channel.next(), { phase: 'organization', elapsedMs: 30 });
  assert.deepEqual(await channel.next(), { phase: 'ready', elapsedMs: 2 });
});
