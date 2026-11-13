// @test-kind contract: a dedicated browser that went away while dev stops is not a cleanup failure; one still connected is
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { chromium } from 'playwright-core';
import { openBrowser } from '../lense/browser.mjs';
import { developStandalone } from '../lense/standalone-mirage.mjs';
import { captureConsoleOutput } from './helpers/mirage-session-doubles.mjs';

// Chromium on Linux answers calls made while it exits with this text (observed on the hosted Ubuntu runner and in WSL).
const LINUX_COOKIES =
  'browserContext.cookies: Protocol error (Storage.getCookies): Browser context management is not supported.';
const CLOSED = 'browserContext.close: Target page, context or browser has been closed';
const startupProgress = { phase() {}, complete() {}, fail() {}, close() {} };

// Resolves once the run listens for SIGINT on the source. The run registers its close listeners before that listener,
// so the session-cookie keeper and dev's own stop listener are both attached when this resolves.
async function untilSigintListened(source) {
  while (source.listenerCount('SIGINT') === 0) await once(source, 'newListener');
}

// A launched persistent context double. `gone()` puts the double in the state Chromium is in while it exits
// (`connected` decides isConnected(), `open` whether a page is left), with the cookie read and the close both failing.
function launchedContext(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-closed-browser-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const page = Object.assign(new EventEmitter(), {
    goto: () => new Promise(() => {}),
    url: () => 'http://127.0.0.1:4100/_sim/',
    isClosed: () => false,
    close: async () => {},
  });
  const browser = Object.assign(new EventEmitter(), { isConnected: () => true });
  let pages = [page];
  const context = Object.assign(new EventEmitter(), {
    browser: () => browser,
    pages: () => pages,
    newPage: async () => page,
    cookies: async () => [],
    addCookies: async () => {},
    close: async () => {},
  });
  t.mock.method(chromium, 'launchPersistentContext', async () => context);
  const open = (cfg) =>
    openBrowser(
      {
        configDir: dir,
        siteName: 'test',
        envName: 'dev',
        origin: cfg.origin,
        browser: { channel: 'chromium', headless: true },
      },
      { profileDir: path.join(dir, 'profile') },
    );
  const gone = ({ connected, open = connected }) => {
    browser.isConnected = () => connected;
    pages = open ? [page] : [];
    context.cookies = async () => {
      throw new Error(LINUX_COOKIES);
    };
    context.close = async () => {
      throw new Error(CLOSED);
    };
  };
  return { open, gone };
}

function run(open, source) {
  return developStandalone(
    { runtime: { kind: 'power-pages' }, browser: {} },
    { startup: startupProgress },
    { url: 'http://127.0.0.1:4100' },
    { open, source },
  );
}

test('a browser that disconnected while dev stops ends dev with status 0 and no notice', async (t) => {
  const source = new EventEmitter();
  const { open, gone } = launchedContext(t);
  const { output, restore } = captureConsoleOutput();
  try {
    const running = run(open, source);
    await untilSigintListened(source);
    gone({ connected: false });
    source.emit('SIGINT');
    assert.equal(await running, 0);
    assert.deepEqual(output.errors, []);
  } finally {
    restore();
  }
});

test('a close that fails because the last window already closed ends dev with status 0 and no notice', async (t) => {
  const source = new EventEmitter();
  const { open, gone } = launchedContext(t);
  const { output, restore } = captureConsoleOutput();
  try {
    const running = run(open, source);
    await untilSigintListened(source);
    gone({ connected: true, open: false });
    source.emit('SIGINT');
    assert.equal(await running, 0);
    assert.deepEqual(output.errors, []);
  } finally {
    restore();
  }
});

test('a close that fails while the browser is still connected is a cleanup failure', async (t) => {
  const source = new EventEmitter();
  const { open, gone } = launchedContext(t);
  const { output, restore } = captureConsoleOutput();
  try {
    const running = run(open, source);
    await untilSigintListened(source);
    gone({ connected: true });
    source.emit('SIGINT');
    await assert.rejects(running, (error) => {
      assert.equal(error.message, 'Standalone browser cleanup failed.');
      assert.deepEqual(
        error.errors.map((cause) => cause.message),
        [CLOSED],
      );
      return true;
    });
    assert.deepEqual(output.errors, [`Session cookies were not saved: ${LINUX_COOKIES}`]);
  } finally {
    restore();
  }
});

test('an interrupted standalone session still reports a browser that does not close', async () => {
  const source = new EventEmitter();
  const controller = new AbortController();
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    goto: () => new Promise(() => {}),
    url: () => 'about:blank',
    close: async () => {},
    mainFrame: () => ({}),
    waitForLoadState: () => new Promise(() => {}),
    evaluate: () => new Promise(() => {}),
  });
  const context = Object.assign(new EventEmitter(), {
    browser: () => null,
    pages: () => [page],
    newPage: async () => page,
  });
  const open = async () => {
    controller.abort(new Error('Code App development stopped.'));
    return {
      context,
      attached: false,
      close: async () => {
        throw new Error('invented');
      },
    };
  };
  const { restore } = captureConsoleOutput();
  try {
    await assert.rejects(
      developStandalone(
        { runtime: { kind: 'code-app' }, browser: {} },
        { startup: startupProgress },
        { url: 'http://127.0.0.1:4100' },
        { open, signal: controller.signal, source },
      ),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Standalone browser cleanup failed/);
        assert.deepEqual(
          error.errors.map((cause) => cause.message),
          ['invented'],
        );
        return true;
      },
    );
  } finally {
    restore();
  }
});
