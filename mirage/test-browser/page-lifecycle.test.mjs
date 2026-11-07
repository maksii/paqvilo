// @test-kind contract: Paqvilo acceptance API page/context lifecycle observer: failed or pending reads stay visible, settling is bounded and fails closed
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { drainFixture } from '../testing/owned-fixture.mjs';
import { browserLaunchOptions, observePageLifecycle, observeContextLifecycle } from '../acceptance-api.mjs';

// The stateless fixture server and the browser are shared; every test observes its own context.
let server, browser, origin;
// Reads of /held-read stay open until releaseHeldReads().
const heldReads = new Set();
const releaseHeldReads = () => {
  for (const res of heldReads) res.end('done');
  heldReads.clear();
};
before(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    if (req.url.startsWith('/pending') || req.url === '/__sim/events') return;
    if (req.url === '/held-read') return heldReads.add(res);
    if (req.url === '/reset') return req.socket.destroy();
    if (req.url === '/stream-error') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.write('invented failure');
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/child') return res.end(`<script>fetch('/pending-child').catch(()=>{})</script>`);
    if (req.url === '/nested')
      return res.end(
        `<iframe src="http://localhost:${server.address().port}/child"></iframe><script>fetch('/pending-parent').catch(()=>{})</script>`,
      );
    if (req.url === '/replacement-with-read')
      return res.end(`<script>fetch('/pending-replacement').catch(()=>{})</script>`);
    res.end('<p>invented lifecycle fixture</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() =>
  drainFixture([
    () => browser?.close(),
    async () => {
      if (!server) return;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  ]),
);

async function fixture(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  return { origin, context, page };
}

// Drive only the observer's clock. Mocking global timers also pauses Playwright
// protocol timeouts and can deadlock real browser I/O before the next tick.
function observerClock() {
  let now = Date.now(),
    sequence = 0;
  const timers = new Map(),
    admissions = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++sequence,
        at = now + ms;
      timers.set(id, { at, fn });
      admissions.get(at)?.forEach((resolve) => resolve());
      admissions.delete(at);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    waitingAt(at) {
      if ([...timers.values()].some((timer) => timer.at === at)) return Promise.resolve();
      return new Promise((resolve) => admissions.set(at, [...(admissions.get(at) ?? []), resolve]));
    },
    tick(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
    },
  };
}

test('a detached iframe read needs lifecycle evidence at failure time', async (t) => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin });
  t.after(() => observer.dispose());
  await page.goto(origin);
  const childRead = page.waitForRequest((request) => request.url().endsWith('/pending-child'));
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.src = '/child';
    document.body.append(frame);
  });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.readyState === 'complete');
  // The observer records the child read on the same request event, before this waiter resolves.
  await childRead;
  await page.evaluate(() => document.querySelector('iframe').remove());
  const result = await observer.settle({ timeout: 30_000 });
  assert.equal(result.settled, true, JSON.stringify(result));
  assert.equal(result.failures.length + result.supersededReads.length, 1);
  // Chromium versions may deliver the failure before the detach notification.
  // That ordering provides no proof at failure time and must fail closed.
  for (const row of result.failures) {
    assert.equal(row.error, 'net::ERR_ABORTED');
    assert.equal(row.lifecycle, undefined);
  }
  for (const row of result.supersededReads) assert.equal(row.lifecycle.reason, 'frame-detached');
});

test('a replaced postback document separates still-pending reads without claiming completion', async (t) => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin });
  t.after(() => observer.dispose());
  await page.goto(origin);
  const read = page.waitForRequest((request) => request.url().endsWith('/pending-read'));
  await page.evaluate(() => {
    fetch('/pending-read').catch(() => {});
  });
  await read;
  await page.evaluate(() => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/done';
    document.body.append(form);
    form.submit();
  });
  await page.waitForURL(origin + '/done');
  const result = await observer.settle({ timeout: 30_000 });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.ok(result.supersededReads.some((row) => row.lifecycle.reason === 'document-replaced'));
  assert.ok(result.supersededReads.every((row) => row.browserCompletionObserved === false));
});

test('same-document history and fragments leave pending reads visible and bounded', async (t) => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin });
  t.after(() => observer.dispose());
  await page.goto(origin);
  await page.evaluate(() => {
    fetch('/pending?token=secret').catch(() => {});
    location.hash = 'fragment';
    history.pushState({}, '', '/history');
  });
  const result = await observer.settle({ timeout: 250 });
  assert.equal(result.settled, false);
  assert.equal(result.pendingRequests.length, 1);
  assert.deepEqual(result.supersededReads, []);
  // Same-document changes neither settle nor cancel the read: settling ends at its own deadline.
  assert.ok(result.waitedMs >= 250);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('failed live reads and authored aborts stay failed after unrelated navigation', async (t) => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin });
  t.after(() => observer.dispose());
  await page.goto(origin);
  const failed = ['/reset', '/pending-abort'].map((path) =>
    page.waitForEvent('requestfailed', (request) => request.url().endsWith(path)),
  );
  const pendingObserved = page.waitForRequest((request) => request.url().endsWith('/pending-abort'));
  await page.evaluate(async () => {
    await fetch('/reset').catch(() => {});
    window.authoredAbort = new AbortController();
    fetch('/pending-abort', { signal: window.authoredAbort.signal }).catch(() => {});
  });
  await pendingObserved;
  // Abort only after the observer has received the authored read, never after an assumed delay.
  await page.evaluate(() => window.authoredAbort.abort());
  await Promise.all(failed);
  await page.goto(origin + '/other');
  const result = await observer.settle({ timeout: 30_000 });
  assert.equal(result.settled, true);
  assert.equal(result.passed, false);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(result.supersededReads, []);
  assert.ok(result.failures.every((row) => row.outcome === 'network-failure'));
});

test('cancelled and failed writes remain failures, including owned-background lookalikes', async (t) => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin });
  t.after(() => observer.dispose());
  await page.goto(origin);
  const observed = [
    page.waitForEvent('requestfailed', (request) => request.url().endsWith('/reset')),
    page.waitForRequest((request) => request.url().endsWith('/pending-write')),
    page.waitForRequest((request) => request.url().endsWith('/__sim/events')),
  ];
  await page.evaluate(async () => {
    await fetch('/reset', { method: 'POST' }).catch(() => {});
    fetch('/pending-write', { method: 'PATCH' }).catch(() => {});
    fetch('/__sim/events', { method: 'POST' }).catch(() => {});
  });
  await Promise.all(observed);
  await page.goto(origin + '/other');
  const result = await observer.settle({ timeout: 30_000 });
  assert.equal(result.passed, false);
  assert.equal(result.failures.length, 3, JSON.stringify(result));
  assert.ok(result.failures.every((row) => !row.ownedBackground));
  assert.deepEqual(result.supersededReads, []);
});

test('context observer attaches new pages, excludes only owned reads and disposes without closing pages', async (t) => {
  const { origin, context, page } = await fixture(t);
  const observer = await observeContextLifecycle(context, { origin });
  t.after(() => observer.dispose());
  const second = await context.newPage();
  await observer.ready();
  await Promise.all([page.goto(origin), second.goto(origin)]);
  await second.evaluate(() => {
    fetch('/__sim/events').catch(() => {});
  });
  const result = await observer.settle({ timeout: 30_000 });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.pages.length, 2);
  assert.ok(result.pages.some((row) => row.requests.some((request) => request.ownedBackground)));
  await observer.dispose();
  assert.equal(page.isClosed(), false);
  assert.equal(second.isClosed(), false);
});

test('observation overflow fails closed and disposing cannot report successful settling', async (t) => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin, maxRecords: 1 });
  t.after(() => observer.dispose());
  await page.goto(origin);
  await page.evaluate(async () => {
    await fetch('/other');
  });
  const result = await observer.settle({ timeout: 30 });
  assert.equal(result.overflow, true);
  assert.equal(result.passed, false);
  await observer.dispose();
  assert.equal((await observer.settle()).passed, false);
});

test('a streaming HTTP error stays failed when its document is replaced', async (t) => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin });
  t.after(() => observer.dispose());
  await page.goto(origin);
  await page.evaluate(async () => {
    await fetch('/stream-error').catch(() => {});
  });
  await page.goto(origin + '/other');
  const result = await observer.settle({ timeout: 30_000 });
  assert.equal(result.passed, false);
  assert.equal(result.failures.length, 1, JSON.stringify(result));
  assert.equal(result.failures[0].status, 500);
  assert.deepEqual(result.supersededReads, []);
});

test('a page created during context settling joins the same bounded observation', async (t) => {
  const { origin, context, page } = await fixture(t);
  const clock = observerClock();
  const observer = await observeContextLifecycle(context, { origin, clock });
  t.after(() => observer.dispose());
  t.after(releaseHeldReads);
  await page.goto(origin);
  const held = page.waitForRequest((request) => request.url().endsWith('/held-read'));
  await page.evaluate(() => {
    fetch('/held-read').catch(() => {});
  });
  await held;
  // Hold the first page busy and freeze the observer clock. Advancing past the
  // quiet window before creating the real second page reproduces the ordering
  // that previously allowed settlement to finish before page admission.
  const started = clock.now();
  let finished = false;
  const pending = observer.settle({ timeout: 700, quietMs: 300, pollMs: 25 }).then((result) => {
    finished = true;
    return result;
  });
  await clock.waitingAt(started + 25);
  clock.tick(350);
  await Promise.resolve();
  assert.equal(finished, false, 'the held request prevents quiet settlement');
  const late = await context.newPage();
  await observer.ready();
  await late.goto(origin);
  const lateRequest = late.waitForRequest((request) => request.url().endsWith('/pending-late'));
  await late.evaluate(() => {
    fetch('/pending-late').catch(() => {});
  });
  await lateRequest;
  await clock.waitingAt(started + 375);
  clock.tick(350);
  const result = await pending;
  assert.equal(result.settled, false);
  assert.equal(result.passed, false);
  assert.equal(result.pages.length, 2, JSON.stringify(result));
  assert.ok(result.pages.some((page) => page.pendingRequests.some((request) => request.url.endsWith('/pending-late'))));
  assert.equal(result.waitedMs, 700, 'new pages share the original deadline');
  assert.ok(result.waitedMs < 1200, 'new pages share the original timeout');
});

test('nested frame replacement retires predecessor reads and preserves replacement work', async (t) => {
  const { origin, page } = await fixture(t);
  const observer = await observePageLifecycle(page, { origin });
  t.after(() => observer.dispose());
  await page.goto(origin);
  const parentRead = page.waitForRequest((request) => request.url().endsWith('/pending-parent'));
  const childRead = page.waitForRequest((request) => request.url().endsWith('/pending-child'));
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.src = '/nested';
    document.body.append(frame);
  });
  await Promise.all([parentRead, childRead]);
  const parent = page.frame({ url: origin + '/nested' });
  await parent.evaluate(() => {
    history.pushState({}, '', '/nested?history=1');
    location.hash = 'same-document';
  });
  const before = await observer.settle({ timeout: 50, quietMs: 0 });
  assert.equal(before.pendingRequests.filter((request) => /pending-(parent|child)$/.test(request.url)).length, 2);
  assert.equal(before.supersededReads.length, 0);
  await parent.goto(origin + '/replacement-with-read');
  const after = await observer.settle({ timeout: 150, quietMs: 0 });
  assert.equal(after.settled, false);
  assert.ok(after.pendingRequests.some((request) => request.url.endsWith('/pending-replacement')));
  assert.equal(
    after.pendingRequests.some((request) => /pending-(parent|child)$/.test(request.url)),
    false,
  );
  const predecessor = after.requests.find((request) => request.url.endsWith('/pending-parent'));
  assert.ok(['superseded-read', 'network-failure'].includes(predecessor.outcome));
  if (predecessor.outcome === 'superseded-read') assert.equal(predecessor.lifecycle.reason, 'document-replaced');
  else {
    assert.equal(predecessor.error, 'net::ERR_ABORTED');
    assert.equal(predecessor.lifecycle, undefined, 'the parent also requires evidence available at failure time');
  }
  const child = after.requests.find((request) => request.url.endsWith('/pending-child'));
  assert.ok(['superseded-read', 'network-failure'].includes(child.outcome));
  if (child.outcome === 'network-failure') {
    assert.equal(child.error, 'net::ERR_ABORTED');
    assert.equal(child.lifecycle, undefined, 'a later detach never rehabilitates an earlier abort');
  }
});

test('context settling refreshes an earlier quiet page after another page finishes waiting', async (t) => {
  const { origin, context, page } = await fixture(t);
  const clock = observerClock();
  const observer = await observeContextLifecycle(context, { origin, clock });
  t.after(() => observer.dispose());
  const other = await context.newPage();
  await observer.ready();
  await Promise.all([page.goto(origin), other.goto(origin)]);
  t.after(releaseHeldReads);
  const admitted = new Promise((resolve) => {
    const onRequest = (request) => {
      if (request.url !== '/held-read') return;
      server.off('request', onRequest);
      resolve();
    };
    server.on('request', onRequest);
    t.after(() => server.off('request', onRequest));
  });
  const held = other.waitForRequest((request) => request.url().endsWith('/held-read'));
  await other.evaluate(() => {
    fetch('/held-read').catch(() => {});
  });
  await held;
  // The browser's request event can precede server admission. Releasing before
  // the fixture owns the response leaves it open and never emits requestfinished.
  await admitted;
  // The other page keeps the context busy until its held read is released.
  // Advance an exact clock after the context has begun waiting on both pages.
  // The first page completes its quiet window while the other read is still held.
  const started = clock.now();
  const resultPromise = observer.settle({ timeout: 700, quietMs: 75, pollMs: 25 });
  await clock.waitingAt(started + 25);
  clock.tick(75);
  await clock.waitingAt(started + 100);
  await new Promise((resolve) => setImmediate(resolve));
  const late = page.waitForRequest((request) => request.url().endsWith('/pending-after-quiet'));
  await page.evaluate(() => {
    fetch('/pending-after-quiet').catch(() => {});
  });
  await late;
  const finished = other.waitForEvent('requestfinished', (request) => request.url().endsWith('/held-read'));
  releaseHeldReads();
  await finished;
  clock.tick(75);
  await clock.waitingAt(started + 175);
  clock.tick(550);
  const result = await resultPromise;
  assert.equal(result.settled, false);
  assert.equal(result.passed, false);
  assert.ok(
    result.pages.some((row) => row.pendingRequests.some((request) => request.url.endsWith('/pending-after-quiet'))),
    JSON.stringify(result),
  );
});
