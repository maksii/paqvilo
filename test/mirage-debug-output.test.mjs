// @test-kind contract: a detached Mirage daemon's debugger instruction reaches its foreground dev console.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mirageDebugOutput } from '../lense/mirage-debug-output.mjs';
import { withMirageDebugOutput } from '../lense/mirage-debug-output-scope.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

const line =
  'Mirage plug-in debugger: attach to paqvilo-plugin-host.exe PID 1234 (Invented.Plugin). Waiting before plug-in construction; local debug deadline is 30 minutes.';

async function fixture(t, prefix) {
  const owner = ownedFixture(t);
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), prefix));
  owner.remove(() => fs.rm(root, { recursive: true, force: true }));
  return { owner, root, log: path.join(root, 'startup.log') };
}

test('a newly appended daemon instruction is emitted once, including split writes; old instructions stay historical', async (t) => {
  const { owner, log } = await fixture(t, 'paq-debug-output-');
  await fs.writeFile(log, line + '\n');
  const received = [];
  const relay = mirageDebugOutput(log, (text) => received.push(text));
  owner.add(() => relay.close());
  await fs.appendFile(log, line.slice(0, 70));
  await relay.flush();
  assert.deepEqual(received, []);
  await fs.appendFile(log, line.slice(70) + '\r\n');
  await relay.flush();
  await relay.flush();
  assert.deepEqual(received, [line]);
  await relay.close();
  await fs.appendFile(log, line + '\n');
  await relay.flush();
  assert.deepEqual(received, [line]);
});

// @test-kind security: forwarding a debugger PID must not expose unrelated or malformed daemon log content.
test('unrelated, credential-bearing, oversized and malformed lines are never forwarded', async (t) => {
  const { owner, log } = await fixture(t, 'paq-debug-filter-');
  await fs.writeFile(log, '');
  const received = [];
  const relay = mirageDebugOutput(log, (text) => received.push(text));
  owner.add(() => relay.close());
  await fs.appendFile(
    log,
    'Authorization: Bearer invented-secret\n' +
      line +
      ' secret\n' +
      line.replace('PID 1234', 'PID -1') +
      '\n' +
      'x'.repeat(5000),
  );
  await relay.flush();
  await fs.appendFile(log, line + '\n' + line + '\n');
  await relay.flush();
  assert.deepEqual(received, [line]);
});

test('the dev wrapper retires its watchers when the foreground action fails', async (t) => {
  const { root, log } = await fixture(t, 'paq-debug-close-');
  await fs.writeFile(log, '');
  await assert.rejects(
    withMirageDebugOutput([{ log }, { log }], async () => {
      throw Error('owned dev failure');
    }),
    /owned dev failure/,
  );
  await fs.rename(log, path.join(root, 'retired.log'));
});
