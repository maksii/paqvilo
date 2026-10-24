// Test-file fixtures: one browser per file, an isolated context per test.
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
