// @test-kind contract+security: the owned parity capture installs its route check before page creation and keeps owner-close ordering.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { EventEmitter } from 'node:events';
import { openOwnedBrowser } from '../parity-suite.mjs';

test('owned parity capture starts page creation before a later owner close', async (t) => {
  const events = [];
  const sentinel = new Error('deliberate open sentinel');
  let owner,
    closed = false;
  const context = {
    route(pattern, handler) {
      assert.equal(pattern, '**/*');
      assert.equal(typeof handler, 'function');
      events.push('route');
      queueMicrotask(() => queueMicrotask(() => void owner.close()));
      return Promise.resolve();
    },
    newPage() {
      events.push(closed ? 'newPage:closed' : 'newPage:open');
      return Promise.reject(closed ? new Error('closed by owner') : sentinel);
    },
    close() {
      events.push('context.close');
      return Promise.resolve();
    },
  };
  const browser = {
    newContext() {
      return Promise.resolve(context);
    },
    close() {
      closed = true;
      events.push('owner.close');
      return Promise.resolve();
    },
  };
  t.mock.method(chromium, 'launch', () => Promise.resolve(browser));
  owner = await openOwnedBrowser({ channel: 'chromium' });
  await assert.rejects(
    owner.pageDriver('http://127.0.0.1', 'anonymous').source('/safe'),
    (error) => error === sentinel,
  );
  assert.ok(events.indexOf('route') < events.indexOf('newPage:open'));
  assert.ok(events.indexOf('newPage:open') < events.indexOf('owner.close'));
  assert.equal(events.filter((event) => event === 'context.close').length, 1);
});

// @test-kind contract: the owned capture reads response status before asynchronous headers settle.
test('owned parity capture reads status before awaiting response headers', async (t) => {
  const events = [];
  let headersResolved = false;
  const response = {
    status() {
      events.push(headersResolved ? 'status:after' : 'status:before');
      return headersResolved ? 201 : 200;
    },
    allHeaders() {
      events.push('headers:start');
      return Promise.resolve({ 'content-type': 'text/html' }).then((headers) => {
        headersResolved = true;
        events.push('headers:resolved');
        return headers;
      });
    },
    text() {
      return Promise.resolve('fixture');
    },
  };
  const page = new EventEmitter();
  page.exposeBinding = () => Promise.resolve();
  page.addInitScript = () => Promise.resolve();
  page.frames = () => [];
  page.goto = () => Promise.resolve(response);
  page.url = () => 'http://127.0.0.1/safe';
  page.evaluate = () => Promise.resolve(false);
  const cdp = new EventEmitter();
  cdp.send = (method) =>
    Promise.resolve(method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main', loaderId: 'one' } } } : {});
  const context = {
    route(pattern, handler) {
      assert.equal(pattern, '**/*');
      assert.equal(typeof handler, 'function');
      return Promise.resolve();
    },
    newPage() {
      return Promise.resolve(page);
    },
    newCDPSession() {
      return Promise.resolve(cdp);
    },
    close() {
      events.push('context.close');
      return Promise.resolve();
    },
  };
  const browser = { newContext: () => Promise.resolve(context), close: () => Promise.resolve() };
  t.mock.method(chromium, 'launch', () => Promise.resolve(browser));
  const owner = await openOwnedBrowser({ channel: 'chromium' });
  ownedFixture(t).add(() => owner.close());
  const result = await owner
    .pageDriver('http://127.0.0.1', 'anonymous')
    .source('/safe', { quietMs: 0, settleTimeout: 1000 });
  assert.equal(result.status, 200);
  assert.equal(result.body, 'fixture');
  assert.deepEqual(events, ['status:before', 'status:before', 'headers:start', 'headers:resolved', 'context.close']);
});
