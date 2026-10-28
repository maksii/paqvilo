// Test-file fixtures: one browser per file, an isolated context per test.
import fs from 'node:fs/promises';
import http from 'node:http';
import { before, after } from 'node:test';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { ownedFixture, drainFixture } from '../testing/owned-fixture.mjs';

/**
 * Launches one browser for the calling test file; `page(t)` opens a fresh context that closes with the test, among the
 * test's ownedFixture closers and so before its directories are removed (node:test runs t.after hooks first in, first out).
 */
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
      ownedFixture(t).add(() => context.close());
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
 * Serves `handler` on an ephemeral loopback port until the test ends. It closes among the test's ownedFixture closers,
 * dropping keep-alive sockets that a browser context still open at that point would otherwise hold.
 */
export async function loopbackServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => closeServer(server));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Reads a simulator's admin state once before a page times its first render. The first read in a process builds the
 * organization runtime (lazy modules and system tables: about 1 s idle, over 8 s on a loaded host), which admin view
 * tests do not measure and which would otherwise consume their short per-step timeouts.
 */
export async function warmState(app) {
  const response = await fetch(app.url + '/__sim/api/state');
  if (!response.ok) throw new Error(`Simulator state returned HTTP ${response.status}`);
  await response.arrayBuffer();
}

/** A page in a fresh context on a warmed simulator; the context, the simulator and its directory close with the test. */
export async function adminPage(t, browser, app, directory) {
  let context;
  const fixture = ownedFixture(t);
  fixture.add(() => context?.close());
  fixture.add(() => app.close());
  fixture.remove(() => fs.rm(directory, { recursive: true, force: true }));
  context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await warmState(app);
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { page, errors };
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
  after(() => drainFixture(cleanups.toReversed()));
  return {
    after: (cleanup) => {
      cleanups.push(cleanup);
    },
  };
}
