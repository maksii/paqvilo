// Test-file fixtures: one browser per file, an isolated context per test.
import http from 'node:http';
import { before, after } from 'node:test';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';

/** Launches one browser for the calling test file; `page(t)` opens a fresh context that closes with the test. */
export function sharedBrowser(launchOptions) {
  let browser;
  before(async () => {
    browser = await chromium.launch(browserLaunchOptions(launchOptions));
  });
  after(() => browser?.close());
  return {
    get browser() {
      return browser;
    },
    async page(t, contextOptions) {
      const context = await browser.newContext(contextOptions);
      t.after(() => context.close());
      return context.newPage();
    },
  };
}

/** Closes a fixture server without waiting on browser keep-alive sockets, which can hold `close()` open. */
export function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Serves `handler` on an ephemeral loopback port until the test ends. Register it before the test's browser
 * context so teardown (last in, first out) closes the context first, then drops the server's sockets.
 */
export async function loopbackServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * An array of observed events whose pushes wake `until(predicate)`, so a test awaits the recorded event itself
 * instead of polling on a timer. The bound only turns a missing event into a named failure before the test timeout.
 */
export function eventLog({ timeout = 10_000, message = 'The expected event did not arrive' } = {}) {
  const items = [],
    waiters = new Set();
  const push = items.push.bind(items);
  Object.defineProperties(items, {
    push: {
      value: (...values) => {
        const length = push(...values);
        for (const wake of [...waiters]) wake();
        return length;
      },
    },
    until: {
      value: (predicate) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(check);
            reject(new Error(`${message} within ${timeout} ms`));
          }, timeout);
          const check = () => {
            if (!predicate(items)) return;
            clearTimeout(timer);
            waiters.delete(check);
            resolve(items);
          };
          waiters.add(check);
          check();
        }),
    },
  });
  return items;
}

/** A test-context stand-in whose cleanups run in the file's after hook, for fixtures shared by read-only tests. */
export function fileScope() {
  const cleanups = [];
  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  return {
    after: (cleanup) => {
      cleanups.push(cleanup);
    },
  };
}
