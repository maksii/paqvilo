import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerRuntimeShutdown } from '../mirage/lib/runtime-shutdown.mjs';

test('detached runtime survives stdin EOF and explicit stop closes once and removes owned discovery', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-shutdown-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const discovery = path.join(directory, 'owned.json');
  await fs.writeFile(discovery, '{}');
  const owner = new EventEmitter();
  const input = new EventEmitter();
  let closes = 0;
  const exits = [];
  const shutdown = registerRuntimeShutdown({
    owner,
    input,
    discovery,
    close: async () => {
      closes++;
    },
    exit: (code) => exits.push(code),
  });
  input.emit('end');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 0, 'EOF is normal for a detached runtime');
  assert.deepEqual(exits, []);
  assert.equal(await fs.readFile(discovery, 'utf8'), '{}');
  input.emit('data', 'stop\n');
  await shutdown.stop();
  await shutdown.stop();
  assert.equal(closes, 1);
  assert.deepEqual(exits, [0]);
  await assert.rejects(fs.stat(discovery), { code: 'ENOENT' });
  assert.equal(owner.listenerCount('SIGINT'), 0);
  assert.equal(owner.listenerCount('SIGTERM'), 0);
  assert.equal(input.listenerCount('data'), 0);
});
