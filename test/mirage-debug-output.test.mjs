// @test-kind contract: a detached Mirage daemon's debugger instruction reaches its foreground dev console.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mirageDebugOutput } from '../lense/mirage-debug-output.mjs';
import { withMirageDebugOutput } from '../lense/mirage-debug-output-scope.mjs';
import { stopStarted } from '../lense/commands/mirage.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { captureConsoleOutput, openLatch } from './helpers/mirage-session-doubles.mjs';

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

test('a repeated stop signal while the debug relays close is absorbed, and the started runtimes still stop afterwards', async () => {
  const noop = () => {};
  process.on('SIGINT', noop);
  process.on('SIGTERM', noop);
  const { output, restore } = captureConsoleOutput();
  const relayClosing = openLatch();
  const relayReleased = openLatch();
  let relayCloses = 0;
  let stops = 0;
  try {
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const relay = () => ({
      close: async () => {
        relayCloses++;
        relayClosing.open();
        await relayReleased.promise;
      },
    });
    const portals = [{ site: 'alpha', session: { started: true, pid: 4321, url: 'http://127.0.0.1:4100/' } }];
    const stop = async () => {
      stops++;
      return { stopped: [{ pid: 4321 }], remaining: [] };
    };
    // Same order as runPortals: the debug relays close after the action, then the started runtimes stop.
    const run = (async () => {
      const value = await withMirageDebugOutput([{ log: 'daemon.log' }], async () => 'action-result', { relay });
      await stopStarted(portals, {}, stop);
      return value;
    })();
    await relayClosing.promise;
    process.emit('SIGINT');
    process.emit('SIGTERM');
    assert.ok(
      process.listenerCount('SIGINT') > before,
      'the relay close must keep a SIGINT listener while it is pending',
    );
    assert.equal(relayCloses, 1);
    assert.equal(stops, 0);
    relayReleased.open();
    assert.equal(await run, 'action-result');
    assert.equal(relayCloses, 1);
    assert.equal(stops, 1);
    assert.deepEqual(output.errors, ['stopping…']);
    assert.equal(process.listenerCount('SIGINT'), before);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  } finally {
    relayReleased.open();
    restore();
    process.off('SIGINT', noop);
    process.off('SIGTERM', noop);
  }
});
