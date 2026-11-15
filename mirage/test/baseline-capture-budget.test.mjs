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

// A navigation whose response body the test controls. The capture must not return, nor reach its screenshot, while
// that body is still being read; the settle wait is the event that shows the capture is waiting for it.
test('the capture does not return until the response body it is reading has been read', async () => {
  const settleWaits = deferred();
  const bodyRead = deferred();
  const gate = deferred();
  const page = runnerPage(() => Promise.resolve(png));
  page.waitForTimeout = async () => {
    settleWaits.resolve();
    await gate.promise;
  };
  const request = {
    method: () => 'GET',
    url: () => origin + '/data',
    headers: () => ({}),
    postData: () => null,
    resourceType: () => 'document',
    isNavigationRequest: () => true,
    frame: () => ({ parentFrame: () => null, page: () => page }),
    failure: () => null,
  };
  const response = {
    status: () => 200,
    headers: () => ({ 'content-type': 'text/plain' }),
    request: () => request,
    body: () => bodyRead.promise,
  };
  page.goto = async () => {
    page.emit('request', request);
    page.emit('response', response);
    page.emit('requestfinished', request);
  };
  const pending = pageRunner(
    page,
    runnerOptions({
      scenario: { id: 'invented/body', steps: [{ goto: '/data' }], expect: {} },
      origin,
      ids: {},
      matrix: { settle: { quietMs: 0, timeout: 20000 } },
      allowWrites: false,
    }),
  );
  const outcome = await Promise.race([settleWaits.promise.then(() => 'waiting'), pending.then(() => 'returned')]);
  assert.equal(outcome, 'waiting', 'the capture returned before its response body was read');
  bodyRead.resolve(Buffer.from('invented body'));
  gate.resolve();
  const { raw } = await pending;
  assert.equal(raw.requests[0].response.body, 'invented body');
});

// A response whose headers arrived but whose body never ends. The capture waits for that read after it closes its page;
// the test then ends the read the way a closed page does, so the response keeps no body.
test('a response body that never ends does not hold the capture past its page', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const order = [];
  const closeCalled = deferred();
  let rejectBody;
  const body = new Promise((_resolve, reject) => {
    rejectBody = reject;
  });
  const endBody = () => rejectBody(new Error('Target page, context or browser has been closed'));
  t.after(endBody);
  const page = runnerPage(() => Promise.resolve(png));
  page.waitForTimeout = async (ms) => t.mock.timers.tick(ms);
  const request = {
    method: () => 'GET',
    url: () => origin + '/poll',
    headers: () => ({}),
    postData: () => null,
    resourceType: () => 'fetch',
    isNavigationRequest: () => false,
    frame: () => ({ parentFrame: () => null, page: () => page }),
    failure: () => null,
  };
  const response = {
    status: () => 200,
    headers: () => ({ 'content-type': 'text/plain' }),
    request: () => request,
    body: () => body.finally(() => order.push('read settled')),
  };
  page.goto = async () => {
    page.emit('request', request);
    page.emit('response', response);
  };
  page.close = async () => {
    order.push('close');
    closeCalled.resolve();
  };
  let returned = false;
  const pending = pageRunner(
    page,
    runnerOptions({
      scenario: { id: 'invented/long-poll', steps: [{ goto: '/poll' }], expect: {} },
      origin,
      ids: {},
      matrix: { settle: { quietMs: 0, timeout: 1000 } },
      allowWrites: false,
    }),
  ).then((value) => {
    returned = true;
    return value;
  });
  await closeCalled.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false, 'the capture waits for the body read it started');
  endBody();
  const { summary, raw } = await pending;
  assert.ok(summary.settlements.length > 0, 'the capture never settled');
  assert.ok(
    summary.settlements.every((settlement) => !settlement.settled),
    JSON.stringify(summary.settlements),
  );
  assert.equal(raw.requests[0].response.body, null);
  assert.deepEqual(order, ['close', 'read settled']);
});
