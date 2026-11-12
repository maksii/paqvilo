// @test-kind contract: the capture screenshot is bounded by a hang guard that a slow host does not trip, designed by Paqvilo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pageRunner, runnerOptions } from '../baseline-capture.mjs';
import { withContextRoutes } from './support/context-routes.mjs';

const origin = 'http://127.0.0.1:4010';
const topFrame = { parentFrame: () => null };
const png = Buffer.from('invented-png');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Resolves only when the test releases it. Like Playwright, it rejects when its own timeout option elapses.
function gatedScreenshot(reached) {
  return ({ timeout }) =>
    new Promise((resolve, reject) => {
      if (timeout) setTimeout(() => reject(new Error(`page.screenshot: Timeout ${timeout}ms exceeded.`)), timeout);
      reached.resolve({ release: () => resolve(png) });
    });
}

// A page that serves one scenario-free capture: every other call the runner makes answers with an empty result.
function runnerPage(screenshot) {
  const context = withContextRoutes(
    Object.assign(new EventEmitter(), {
      async newPage() {
        return page;
      },
    }),
  );
  const page = Object.assign(new EventEmitter(), {
    context: () => context,
    async route() {},
    async unroute() {},
    async setViewportSize() {},
    async waitForTimeout() {},
    async waitForLoadState() {},
    async evaluate() {
      return false;
    },
    async title() {
      return '';
    },
    async close() {},
    url: () => origin + '/',
    mainFrame: () => topFrame,
    frames: () => [],
    screenshot,
  });
  return page;
}

// Starts a capture whose screenshot is still pending, advances the mocked clock, then releases the page.
async function captureWithPageDelay(t, { scenarioTimeout, delayMs }) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reached = deferred();
  const page = runnerPage(gatedScreenshot(reached));
  const scenario = {
    id: 'invented/screenshot',
    steps: [],
    expect: {},
    ...(scenarioTimeout === undefined ? {} : { timeout: scenarioTimeout }),
  };
  const pending = pageRunner(
    page,
    runnerOptions({ scenario, origin, ids: {}, matrix: { settle: { timeout: 0 } }, allowWrites: false }),
  );
  const { release } = await reached.promise;
  t.mock.timers.tick(delayMs);
  release();
  return pending;
}

test('a screenshot that takes 45 s succeeds under the default screenshot guard', async (t) => {
  const { summary, raw } = await captureWithPageDelay(t, { delayMs: 45_000 });
  assert.deepEqual(
    summary.problems.filter((problem) => problem.startsWith('screenshot')),
    [],
    JSON.stringify(summary.problems),
  );
  assert.equal(raw.screenshot, png.toString('base64'));
});

test('an explicit short scenario timeout fails a stuck screenshot with the guard message', async (t) => {
  const { summary, raw } = await captureWithPageDelay(t, { scenarioTimeout: 1, delayMs: 45_000 });
  assert.ok(
    summary.problems.includes('screenshot: screenshot guard expired after 1000 ms without a screenshot'),
    JSON.stringify(summary.problems),
  );
  assert.equal(raw.screenshot, undefined);
});
