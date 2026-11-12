// @test-kind contract: standalone development runs the configured local application and reports its addresses
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { developStandalone } from '../lense/standalone-mirage.mjs';
import { startupProgress } from '../lense/startup-progress.mjs';

test('standalone dev prints the administration address before it opens the page', async (t) => {
  const lines = [];
  const controller = new AbortController();
  t.mock.method(console, 'log', (line) => {
    lines.push(String(line));
    // Ending the run at the printed opening is the stop under test; the page never finishes loading.
    if (String(line).startsWith('Opening ')) controller.abort();
  });
  const page = new EventEmitter();
  page.goto = () => new Promise(() => {});
  page.isClosed = () => false;
  const context = Object.assign(new EventEmitter(), { browser: () => null, pages: () => [page] });
  const run = developStandalone(
    { runtime: { kind: 'dataverse-api' }, browser: {} },
    { startup: startupProgress({ write() {} }) },
    { url: 'http://127.0.0.1:4321', adminUrl: 'http://127.0.0.1:4322/_sim/' },
    {
      open: async () => ({ context, attached: false, close: async () => {} }),
      signal: controller.signal,
    },
  );
  await run.catch((error) => assert.equal(error.name, 'AbortError'));
  const admin = lines.indexOf('admin       http://127.0.0.1:4322/_sim/');
  const opening = lines.findIndex((line) => line.startsWith('Opening http://127.0.0.1:4321/_sim/'));
  assert.ok(admin >= 0 && admin < opening, lines.join('\n'));
});

for (const phase of ['navigation', 'application'])
  test(`closing an owned attached tab during ${phase} ends standalone dev without closing its browser`, async () => {
    const browser = new EventEmitter(),
      context = new EventEmitter(),
      page = new EventEmitter();
    let closed = false,
      disconnected = 0,
      reached;
    const entered = new Promise((resolve) => {
      reached = resolve;
    });
    const pending = new Promise(() => {});
    browser.isConnected = () => true;
    context.browser = () => browser;
    context.newPage = async () => page;
    page.context = () => context;
    page.isClosed = () => closed;
    page.url = () => 'http://127.0.0.1:1234/main.aspx';
    page.goto = () => {
      if (phase === 'navigation') {
        reached();
        return pending;
      }
      return Promise.resolve();
    };
    page.waitForFunction = () => {
      reached();
      return pending;
    };
    page.evaluate = () => assert.fail('A closed page must not be evaluated for readiness.');
    const events = [],
      progress = startupProgress({ structured: true, write: (line) => events.push(JSON.parse(line)) });
    const run = developStandalone(
      { runtime: { kind: 'model-driven' }, browser: {} },
      { startup: progress },
      { url: 'http://127.0.0.1:1234' },
      {
        open: async () => ({
          context,
          attached: true,
          close: async () => {
            disconnected++;
          },
        }),
      },
    );
    await entered;
    closed = true;
    page.emit('close');
    let timer;
    try {
      assert.equal(
        await Promise.race([
          run,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('Closing the owned tab did not stop dev.')), 60_000);
          }),
        ]),
        0,
      );
    } finally {
      clearTimeout(timer);
      context.emit('close');
      await run;
      progress.close();
    }
    assert.equal(disconnected, 1);
    assert.equal(browser.isConnected(), true);
    assert.equal(
      events.some((event) => event.status === 'complete'),
      false,
    );
    assert.equal(context.listenerCount('close'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
  });

test('a dedicated page closed during start-up ends standalone dev with one line, a closed browser and status 0', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(String(line)));
  const context = new EventEmitter(),
    page = new EventEmitter();
  let closed = false,
    closes = 0,
    reached,
    fail;
  const waiting = new Promise((resolve) => {
    reached = resolve;
  });
  context.browser = () => null;
  context.pages = () => [page];
  page.context = () => context;
  page.isClosed = () => closed;
  page.url = () => 'http://127.0.0.1:1234/main.aspx';
  page.goto = async () => {};
  page.waitForFunction = () => {
    reached();
    return new Promise((_, reject) => {
      fail = reject;
    });
  };
  const run = developStandalone(
    { runtime: { kind: 'model-driven' }, browser: {} },
    { startup: startupProgress({ write() {} }) },
    { url: 'http://127.0.0.1:1234' },
    {
      open: async () => ({
        context,
        attached: false,
        close: async () => {
          closes++;
        },
      }),
    },
  );
  await waiting;
  // Playwright rejects the readiness wait when the page closes.
  closed = true;
  fail(new Error('page.waitForFunction: Target page, context or browser has been closed'));
  assert.equal(await run, 0);
  assert.equal(lines.filter((line) => line === 'browser closed before start-up finished').length, 1);
  assert.equal(closes, 1);
  assert.equal(context.listenerCount('close'), 0);
});

for (const closingFails of [false, true])
  test(`standalone readiness failure closes only its attached tab and disconnects even when tab close ${closingFails ? 'fails' : 'succeeds'}`, async () => {
    const browser = new EventEmitter(),
      context = new EventEmitter(),
      page = new EventEmitter();
    const existingPage = { closed: false };
    let closed = false,
      disconnected = 0,
      closeAttempts = 0;
    browser.isConnected = () => true;
    context.browser = () => browser;
    context.newPage = async () => page;
    context.pages = () => [existingPage, page];
    page.context = () => context;
    page.isClosed = () => closed;
    page.url = () => 'http://127.0.0.1:1234/main.aspx';
    page.goto = async () => {};
    const original = Error('Invented initial application failure');
    page.waitForFunction = async () => {
      throw original;
    };
    page.close = async () => {
      closeAttempts++;
      if (closingFails) throw Error('Invented tab cleanup failure');
      closed = true;
      page.emit('close');
    };
    const progress = startupProgress({ write() {} });
    await assert.rejects(
      developStandalone(
        { runtime: { kind: 'model-driven' }, browser: {} },
        { startup: progress },
        { url: 'http://127.0.0.1:1234' },
        {
          open: async () => ({
            context,
            attached: true,
            close: async () => {
              disconnected++;
            },
          }),
        },
      ),
      (error) => error === original,
    );
    assert.equal(closeAttempts, 1);
    assert.equal(closed, !closingFails);
    assert.equal(disconnected, 1);
    assert.equal(existingPage.closed, false);
    assert.equal(browser.isConnected(), true);
    assert.equal(page.listenerCount('close'), 0);
    assert.equal(context.listenerCount('close'), 0);
  });
