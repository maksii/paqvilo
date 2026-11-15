// @test-kind contract: the dev command reports a browser that fails to close and exits non-zero
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { closeDevBrowser, createDevStop, devExitCode, develop, launchUnderStop } from '../lense/commands/dev.mjs';

function keepExitCode(t) {
  const saved = process.exitCode;
  process.exitCode = undefined;
  t.after(() => {
    process.exitCode = saved;
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a browser close that fails is reported once with its first line and fails the command', async (t) => {
  keepExitCode(t);
  const lines = [];
  const failed = await closeDevBrowser(
    async () => {
      throw new Error('first line\nsecond line');
    },
    { report: (line) => lines.push(line) },
  );
  assert.equal(failed, true, 'the close failure is returned to develop, which fails the command');
  assert.deepEqual(lines, ['browser cleanup failed: first line'], 'one line with the first line of the error');
  assert.equal(process.exitCode, 1, 'the process exits non-zero');
});

test('a browser that closes reports nothing and leaves the exit code alone', async (t) => {
  keepExitCode(t);
  const lines = [];
  const failed = await closeDevBrowser(async () => {}, { report: (line) => lines.push(line) });
  assert.equal(failed, false, 'a clean close is not a failure');
  assert.deepEqual(lines, [], 'nothing is reported');
  assert.equal(process.exitCode, undefined, 'the exit code is untouched');
});

test('an interrupt while the browser launches closes the launched browser and skips the session', async () => {
  const source = new EventEmitter();
  const devStop = createDevStop({ source });
  let resolveOpen;
  const open = () =>
    new Promise((resolve) => {
      resolveOpen = resolve;
    });
  const closed = [];
  const launching = launchUnderStop(open, devStop, {
    closeBrowser: async (close) => {
      closed.push(close);
    },
  });
  source.emit('SIGINT');
  const close = async () => {};
  resolveOpen({ close });
  assert.equal(await launching, null, 'the interrupted launch resolves to no session');
  assert.deepEqual(closed, [close], 'the launched browser is closed');
  assert.equal(source.listenerCount('SIGINT'), 0, 'the SIGINT listener is released');
  assert.equal(source.listenerCount('SIGTERM'), 0, 'the SIGTERM listener is released');
});

test('a stop requested before the launch skips it', async () => {
  const source = new EventEmitter();
  const devStop = createDevStop({ source });
  source.emit('SIGINT');
  let launches = 0;
  const result = await launchUnderStop(async () => {
    launches += 1;
    return { close: async () => {} };
  }, devStop);
  assert.equal(result, null, 'no session is handed over');
  assert.equal(launches, 0, 'the browser is not launched');
  assert.equal(source.listenerCount('SIGINT'), 0, 'the SIGINT listener is released');
  assert.equal(source.listenerCount('SIGTERM'), 0, 'the SIGTERM listener is released');
});

test('an interrupted launch closes its browser under the shutdown guard', async (t) => {
  t.mock.method(console, 'error', () => {});
  const source = new EventEmitter();
  const devStop = createDevStop({ source });
  const opened = deferred();
  const closing = deferred();
  const closeCalled = deferred();
  const launching = launchUnderStop(() => opened.promise, devStop, {
    closeBrowser: async () => {
      closeCalled.resolve();
      await closing.promise;
    },
  });
  source.emit('SIGINT');
  opened.resolve({ close: async () => {} });
  await closeCalled.promise;
  assert.ok(source.listenerCount('SIGINT') > 0, 'a second SIGINT is still handled while the browser closes');
  source.emit('SIGINT');
  closing.resolve();
  assert.equal(await launching, null, 'the interrupted launch resolves to no session');
  assert.equal(source.listenerCount('SIGINT'), 0, 'the SIGINT listener is released');
  assert.equal(source.listenerCount('SIGTERM'), 0, 'the SIGTERM listener is released');
});

test('repeated stop signals while the browser launches are handled until the launched browser is closed', async () => {
  const source = new EventEmitter();
  const exits = [];
  const devStop = createDevStop({ source, exit: (code) => exits.push(code) });
  const opened = deferred();
  const closed = [];
  const launching = launchUnderStop(() => opened.promise, devStop, {
    closeBrowser: async (close) => {
      closed.push(close);
    },
  });
  source.emit('SIGINT');
  assert.ok(source.listenerCount('SIGINT') > 0, 'the second Ctrl+C is still handled while the browser launches');
  source.emit('SIGINT');
  assert.deepEqual(exits, [], 'the second signal is absorbed');
  const close = async () => {};
  opened.resolve({ close });
  assert.equal(await launching, null, 'the interrupted launch resolves to no session');
  assert.deepEqual(closed, [close], 'the launched browser is closed once');
  assert.equal(source.listenerCount('SIGINT'), 0, 'the SIGINT listener is released');
  assert.equal(source.listenerCount('SIGTERM'), 0, 'the SIGTERM listener is released');
});

test('an interrupted launch whose browser does not close records a failed exit', async (t) => {
  keepExitCode(t);
  t.mock.method(console, 'error', () => {});
  const source = new EventEmitter();
  const devStop = createDevStop({ source });
  const opened = deferred();
  const reported = [];
  const launching = launchUnderStop(() => opened.promise, devStop, {
    closeBrowser: (close) => closeDevBrowser(close, { report: (line) => reported.push(line) }),
  });
  source.emit('SIGINT');
  opened.resolve({
    close: async () => {
      throw new Error('browser stayed open');
    },
  });
  assert.equal(await launching, null, 'the interrupted launch resolves to no session');
  assert.equal(reported.length, 1, 'the failed close is reported once');
  assert.ok(reported[0].startsWith('browser cleanup failed:'), reported[0]);
  assert.equal(process.exitCode, 1, 'the recorded failure makes the command exit non-zero');
});

test('a launch that finishes without an interrupt hands over the browser and keeps the stop armed', async (t) => {
  const source = new EventEmitter();
  const devStop = createDevStop({ source });
  t.after(() => devStop.release());
  const opened = { close: async () => {} };
  let closeCalls = 0;
  const result = await launchUnderStop(async () => opened, devStop, {
    closeBrowser: async () => {
      closeCalls += 1;
    },
  });
  assert.equal(result, opened, 'the opened browser is handed over');
  assert.equal(closeCalls, 0, 'the browser is not closed');
  assert.equal(source.listenerCount('SIGINT'), 1, 'the SIGINT listener stays armed for the session');
  source.emit('SIGTERM');
  await devStop.stopped;
  assert.equal(devStop.requested(), true, 'a later SIGTERM requests the stop');
});

test('a failed launch releases the stop and rethrows', async () => {
  const source = new EventEmitter();
  const devStop = createDevStop({ source });
  await assert.rejects(
    launchUnderStop(async () => {
      throw new Error('invented');
    }, devStop),
    /invented/,
    'the launch error reaches the caller',
  );
  assert.equal(source.listenerCount('SIGINT'), 0, 'the SIGINT listener is released');
  assert.equal(source.listenerCount('SIGTERM'), 0, 'the SIGTERM listener is released');
});

test('an interrupted Code App run with a runtime failure exits 0 as a stop the user asked for', () => {
  assert.equal(devExitCode({ failure: true }, { codeAppSignal: AbortSignal.abort() }), 0);
});

test('a runtime failure without an interrupt exits 1', () => {
  assert.equal(devExitCode({ failure: true }, {}), 1);
});

test('a dev run without a runtime failure exits 0', () => {
  assert.equal(devExitCode(undefined, {}), 0);
});

test('an already aborted Code App signal requests the stop at once', () => {
  const source = new EventEmitter();
  const controller = new AbortController();
  controller.abort();
  const devStop = createDevStop({ codeAppSignal: controller.signal, source });
  assert.equal(devStop.requested(), true, 'the stop is requested before anything is armed');
  devStop.release();
});

test('an interrupt during the dev browser launch closes it and ends dev with 0', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const source = new EventEmitter();
  const launchStarted = deferred();
  const launched = deferred();
  let closeCalls = 0;
  const running = develop(
    { mirageTarget: { origin: 'http://127.0.0.1:1', browser: { debugPort: null } } },
    { url: null },
    {
      open: () => {
        launchStarted.resolve();
        return launched.promise;
      },
      source,
    },
  );
  await launchStarted.promise;
  source.emit('SIGINT');
  launched.resolve({
    close: async () => {
      closeCalls += 1;
    },
  });
  assert.equal(await running, 0, 'the interrupted launch ends dev with exit code 0');
  assert.equal(closeCalls, 1, 'the launched browser is closed once');
  assert.equal(source.listenerCount('SIGINT'), 0, 'the SIGINT listener is released');
  assert.equal(source.listenerCount('SIGTERM'), 0, 'the SIGTERM listener is released');
});
