// @test-kind contract: a standalone Mirage browser closes under the same signal guard as the dev and portal shutdown paths
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { developStandalone } from '../lense/standalone-mirage.mjs';
import { captureConsoleOutput, openLatch } from './helpers/mirage-session-doubles.mjs';

// A fake browser context whose page stays on the _sim page; opens the latch when the run attaches its first once listener.
function standaloneContext(listening) {
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
  context.once = function once(event, listener) {
    EventEmitter.prototype.once.call(this, event, listener);
    listening.open();
    return this;
  };
  return context;
}

const startupProgress = { phase() {}, complete() {}, fail() {}, close() {} };

// @test-kind contract: a repeated Ctrl+C while the standalone browser closes must not end the process before the close settles
test('a repeated stop signal while the standalone browser closes is absorbed until the close settles', async () => {
  const noop = () => {};
  process.on('SIGINT', noop);
  process.on('SIGTERM', noop);
  const { output, restore } = captureConsoleOutput();
  const closing = openLatch();
  const closeReleased = openLatch();
  const listening = openLatch();
  let closes = 0;
  try {
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const context = standaloneContext(listening);
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
      { open },
    );
    await listening.promise;
    context.emit('close');
    await closing.promise;
    process.emit('SIGINT');
    process.emit('SIGTERM');
    assert.ok(process.listenerCount('SIGINT') > before, 'the stop must keep a SIGINT listener while it is pending');
    assert.equal(closes, 1);
    closeReleased.open();
    assert.equal(await run, 0);
    assert.equal(closes, 1);
    assert.deepEqual(output.errors, ['stopping…']);
    assert.equal(process.listenerCount('SIGINT'), before);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  } finally {
    closeReleased.open();
    restore();
    process.off('SIGINT', noop);
    process.off('SIGTERM', noop);
  }
});

// @test-kind contract: a first Ctrl+C while the standalone browser is open ends the run and closes the browser once, with no repeated-signal notice
test('a first Ctrl+C while the standalone browser is open stops the run and closes the browser once', async () => {
  const { output, restore } = captureConsoleOutput();
  const listening = openLatch();
  let closes = 0;
  try {
    const context = standaloneContext(listening);
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
      { open },
    );
    await listening.promise;
    process.emit('SIGINT');
    assert.equal(await run, 0);
    assert.equal(closes, 1);
    assert.deepEqual(output.errors, []);
  } finally {
    restore();
  }
});
