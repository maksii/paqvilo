// @test-kind contract: a dedicated browser that went away while dev stops is not a cleanup failure; one still connected is
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { openBrowser } from '../lense/browser.mjs';
import { developStandalone } from '../lense/standalone-mirage.mjs';
import { captureConsoleOutput, openLatch } from './helpers/mirage-session-doubles.mjs';

// Chromium on Linux answers calls made while it exits with this text (observed on the hosted Ubuntu runner and in WSL).
const LINUX_COOKIES =
  'browserContext.cookies: Protocol error (Storage.getCookies): Browser context management is not supported.';
const CLOSED = 'browserContext.close: Target page, context or browser has been closed';
const startupProgress = { phase() {}, complete() {}, fail() {}, close() {} };

// A launched persistent context double. `gone()` puts the double in the state Chromium is in while it exits
// (`connected` decides isConnected(), `open` whether a page is left), with the cookie read and the close both failing.
function launchedContext(t, listening) {
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
  // The session-cookie keeper registers the first 'close' listener inside openBrowser; dev's own stop listener is the second.
  let closeListeners = 0;
  context.once = function once(event, listener) {
    EventEmitter.prototype.once.call(this, event, listener);
    if (event === 'close' && ++closeListeners === 2) listening.open();
    return this;
  };
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

function run(open) {
  return developStandalone(
    { runtime: { kind: 'power-pages' }, browser: {} },
    { startup: startupProgress },
    { url: 'http://127.0.0.1:4100' },
    { open },
  );
}

test('a browser that disconnected while dev stops ends dev with status 0 and no notice', async (t) => {
  const listening = openLatch();
  const { open, gone } = launchedContext(t, listening);
  const { output, restore } = captureConsoleOutput();
  try {
    const running = run(open);
    await listening.promise;
    gone({ connected: false });
    process.emit('SIGINT');
    assert.equal(await running, 0);
    assert.deepEqual(output.errors, []);
  } finally {
    restore();
  }
});

test('a close that fails because the last window already closed ends dev with status 0 and no notice', async (t) => {
  const listening = openLatch();
  const { open, gone } = launchedContext(t, listening);
  const { output, restore } = captureConsoleOutput();
  try {
    const running = run(open);
    await listening.promise;
    gone({ connected: true, open: false });
    process.emit('SIGINT');
    assert.equal(await running, 0);
    assert.deepEqual(output.errors, []);
  } finally {
    restore();
  }
});

test('a close that fails while the browser is still connected is a cleanup failure', async (t) => {
  const listening = openLatch();
  const { open, gone } = launchedContext(t, listening);
  const { output, restore } = captureConsoleOutput();
  try {
    const running = run(open);
    await listening.promise;
    gone({ connected: true });
    process.emit('SIGINT');
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
