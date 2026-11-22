// @test-kind security: the start channel forwards only allow-listed phase records and bounds what a client sends
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openStartChannel } from '../lense/start-channel.mjs';
import { privateSocketFolder, unixSocketFolder } from '../mirage/lib/socket-path.mjs';

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
  'the start channel listens in a private /tmp folder when the temporary folder is too long for a Unix socket path',
  {
    skip: process.platform === 'win32' && 'Windows uses a named pipe',
  },
  async (t) => {
    const tmpdir = path.join(os.tmpdir(), 'x'.repeat(120));
    const channel = await openStartChannel({ tmpdir });
    t.after(() => channel.close());
    assert.match(channel.address, new RegExp(`^/tmp/paqvilo-${process.getuid()}/paqvilo-start-[^/]+/channel\\.sock$`));
    assert.ok(Buffer.byteLength(channel.address) <= (process.platform === 'linux' ? 107 : 103));
    const socket = net.connect(channel.address);
    t.after(() => socket.destroy());
    socket.write(`${JSON.stringify({ type: 'runtime-startup', phase: 'ready', elapsedMs: 1 })}\n`);
    assert.deepEqual(await channel.next(), { phase: 'ready', elapsedMs: 1 });
    // A temporary folder that fits, to the byte, is used as it is (the folder, a separator and a 20-byte tail).
    const shared = () => '/tmp/paqvilo-1000';
    const folder = (platform, tmpdir) => unixSocketFolder(20, { platform, tmpdir, shared });
    assert.equal(folder('darwin', '/var/folders/ab/cd/T'), '/var/folders/ab/cd/T');
    assert.equal(folder('darwin', '/' + 'y'.repeat(81)), '/' + 'y'.repeat(81));
    assert.equal(folder('darwin', '/' + 'y'.repeat(82)), '/tmp/paqvilo-1000');
    assert.equal(folder('linux', '/' + 'y'.repeat(85)), '/' + 'y'.repeat(85));
    assert.equal(folder('linux', '/' + 'y'.repeat(86)), '/tmp/paqvilo-1000');
  },
);

test(
  'the private socket folder in /tmp is used only while no other account can enter or replace it',
  { skip: process.platform === 'win32' && 'Windows uses a named pipe' },
  async (t) => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-socket-folder-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const uid = process.getuid();
    const folder = privateSocketFolder({ base, uid });
    assert.equal(folder, path.join(base, `paqvilo-${uid}`));
    assert.equal((await fs.stat(folder)).mode & 0o777, 0o700, 'created closed to other accounts');
    assert.equal(privateSocketFolder({ base, uid }), folder, 'an existing private folder is reused');
    await fs.chmod(folder, 0o755);
    assert.throws(() => privateSocketFolder({ base, uid }), { code: 'SocketFolderUnsafe' }, 'open to other accounts');
    await fs.chmod(folder, 0o700);
    // Another account's folder of that name (here: one this test owns, named for another account id) is not used.
    assert.throws(() => privateSocketFolder({ base, uid: uid + 1 }), { code: 'SocketFolderUnsafe' });
    // A link planted in its place is refused even when it points at a private folder.
    await fs.rm(folder, { recursive: true });
    const elsewhere = path.join(base, 'elsewhere');
    await fs.mkdir(elsewhere, { mode: 0o700 });
    await fs.symlink(elsewhere, folder);
    assert.throws(() => privateSocketFolder({ base, uid }), { code: 'SocketFolderUnsafe' }, 'a link');
    assert.throws(() => privateSocketFolder({ base, uid: null }), /POSIX account id/);
  },
);
