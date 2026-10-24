import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { developStandalone } from '../lense/standalone-mirage.mjs';
import { startupProgress } from '../lense/startup-progress.mjs';

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
            timer = setTimeout(() => reject(Error('Closing the owned tab did not stop dev.')), 1000);
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
