// @test-kind security: the start channel forwards only allow-listed phase records and bounds what a client sends
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openStartChannel } from '../lense/start-channel.mjs';
import { unixSocketFolder, unixSocketPathLimit } from '../mirage/lib/socket-path.mjs';

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

// @test-kind contract: a temporary folder too long for sun_path (a sandbox or CI TMPDIR on macOS) still starts Mirage
test(
  'the start channel listens under /tmp when the temporary folder is too long for a Unix socket path',
  {
    skip: process.platform === 'win32' && 'Windows uses a named pipe',
  },
  async (t) => {
    const tmpdir = path.join(os.tmpdir(), 'x'.repeat(120));
    const channel = await openStartChannel({ tmpdir });
    t.after(() => channel.close());
    assert.match(channel.address, /^\/tmp\/paqvilo-start-[^/]+\/channel\.sock$/);
    assert.ok(Buffer.byteLength(channel.address) <= unixSocketPathLimit());
    const socket = net.connect(channel.address);
    t.after(() => socket.destroy());
    socket.write(`${JSON.stringify({ type: 'runtime-startup', phase: 'ready', elapsedMs: 1 })}\n`);
    assert.deepEqual(await channel.next(), { phase: 'ready', elapsedMs: 1 });
    // A temporary folder that fits, to the byte, is used as it is (the folder, a separator and a 20-byte tail).
    assert.equal(unixSocketFolder(20, { platform: 'darwin', tmpdir: '/var/folders/ab/cd/T' }), '/var/folders/ab/cd/T');
    assert.equal(unixSocketFolder(20, { platform: 'darwin', tmpdir: '/' + 'y'.repeat(81) }), '/' + 'y'.repeat(81));
    assert.equal(unixSocketFolder(20, { platform: 'darwin', tmpdir: '/' + 'y'.repeat(82) }), '/tmp');
    assert.equal(unixSocketFolder(20, { platform: 'linux', tmpdir: '/' + 'y'.repeat(85) }), '/' + 'y'.repeat(85));
    assert.equal(unixSocketFolder(20, { platform: 'linux', tmpdir: '/' + 'y'.repeat(86) }), '/tmp');
  },
);
