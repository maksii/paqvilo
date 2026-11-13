// @test-kind contract: a standalone Mirage browser closes under the same signal guard as the dev and portal shutdown paths
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { developStandalone } from '../lense/standalone-mirage.mjs';
import { captureConsoleOutput, openLatch } from './helpers/mirage-session-doubles.mjs';

// A fake browser context whose page stays on the _sim page.
function standaloneContext() {
  const context = new EventEmitter();
  const page = Object.assign(new EventEmitter(), {
    goto: () => new Promise(() => {}),
    url: () => 'http://127.0.0.1:4100/_sim/',
    isClosed: () => false,
    close: async () => {},
  });
  context.browser = () => null;
  context.pages = () => [page];
  context.newPage = async () => page;
  return context;
}

// Resolves once the run listens for SIGINT on the source. The run registers its context close listener in the same
// block, before the SIGINT listener, so both are attached when this resolves.
async function untilSigintListened(source) {
  while (source.listenerCount('SIGINT') === 0) await once(source, 'newListener');
}

const startupProgress = { phase() {}, complete() {}, fail() {}, close() {} };

// @test-kind contract: a repeated Ctrl+C while the standalone browser closes must not end the process before the close settles
test('a repeated stop signal while the standalone browser closes is absorbed until the close settles', async () => {
  const source = new EventEmitter();
  const { output, restore } = captureConsoleOutput();
  const closing = openLatch();
  const closeReleased = openLatch();
  let closes = 0;
  try {
    const context = standaloneContext();
    const open = async () => ({
      context,
      attached: false,
      close: async () => {
        closes++;
        closing.open();
        await closeReleased.promise;
      },
    });
    const run = developStandalone(
      { runtime: { kind: 'power-pages' }, browser: {} },
      { startup: startupProgress },
      { url: 'http://127.0.0.1:4100' },
      { open, source },
    );
    await untilSigintListened(source);
    context.emit('close');
    await closing.promise;
    source.emit('SIGINT');
    source.emit('SIGTERM');
    assert.ok(source.listenerCount('SIGINT') > 0, 'the stop must keep a SIGINT listener while it is pending');
    assert.equal(closes, 1);
    closeReleased.open();
    assert.equal(await run, 0);
    assert.equal(closes, 1);
    assert.deepEqual(output.errors, ['stopping…']);
    assert.equal(source.listenerCount('SIGINT'), 0);
    assert.equal(source.listenerCount('SIGTERM'), 0);
  } finally {
    closeReleased.open();
    restore();
  }
});

// @test-kind contract: a first Ctrl+C while the standalone browser is open ends the run and closes the browser once, with no repeated-signal notice
test('a first Ctrl+C while the standalone browser is open stops the run and closes the browser once', async () => {
  const source = new EventEmitter();
  const { output, restore } = captureConsoleOutput();
  let closes = 0;
  try {
    const context = standaloneContext();
    const open = async () => ({
      context,
      attached: false,
      close: async () => {
        closes++;
      },
    });
    const run = developStandalone(
      { runtime: { kind: 'power-pages' }, browser: {} },
      { startup: startupProgress },
      { url: 'http://127.0.0.1:4100' },
      { open, source },
    );
    await untilSigintListened(source);
    source.emit('SIGINT');
    assert.equal(await run, 0);
    assert.equal(closes, 1);
    assert.deepEqual(output.errors, []);
  } finally {
    restore();
  }
});
