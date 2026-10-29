import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { awaitWritesBeforeDocument, DOCUMENT_REQUEST_PATTERN } from '../lib/navigation-settle.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Page /a starts a script write (PATCH /write) and a slow read (GET /read) on load and links
// to /b; it can also issue a synchronous request that is answered with a redirect. The server
// holds /write until the test releases it (`holdWrite`) and records whether each response
// finished or the client closed it first. With `syncRedirect`, /b is answered while the
// synchronous request still waits for its redirect.
async function fixture(t, { holdWrite = true, pause = true, timeout = 60_000, syncRedirect = false } = {}) {
  const outcomes = [];
  const requests = [];
  const write = deferred(),
    writeClosed = deferred(),
    documentPaused = deferred(),
    redirectRequested = deferred(),
    documentAnswered = deferred();
  t.after(() => write.resolve());
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === '/a')
      return res.end(
        "<!doctype html><title>A</title><a id='next' href='/b'>next</a><script>" +
          "fetch('/write', { method: 'PATCH', body: '{}' }).then(() => sessionStorage.setItem('saved', '1'));" +
          "fetch('/read');" +
          "document.getElementById('next').addEventListener('click', () => setTimeout(() => { var x = new XMLHttpRequest(); x.open('GET', '/redirect', false); x.send(); window.synchronous = x.status; }, 20));" +
          '</script>',
      );
    if (url.pathname === '/b') {
      if (!syncRedirect) return res.end('<!doctype html><title>B</title>');
      return redirectRequested.promise.then(() =>
        res.end('<!doctype html><title>B</title>', () => documentAnswered.resolve()),
      );
    }
    if (url.pathname === '/redirect') {
      redirectRequested.resolve();
      return documentAnswered.promise.then(() => res.writeHead(301, { location: '/target' }).end());
    }
    if (url.pathname === '/target') return res.end('ok');
    res.on('close', () => {
      outcomes.push({ path: url.pathname, finished: res.writableFinished });
      if (url.pathname === '/write') writeClosed.resolve();
    });
    if (url.pathname === '/write')
      return (holdWrite ? write.promise : Promise.resolve()).then(() => {
        if (!res.destroyed) {
          res.statusCode = 204;
          res.end();
        }
      });
    // Reads never hold a navigation; this one stays slow.
    setTimeout(() => {
      if (!res.destroyed) res.end();
    }, 400);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    // A preconnected socket that never sent a request would hold server.close open.
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage();
  t.after(() => page.context().close());
  // The runner's bookkeeping: CDP Network records and paused document requests.
  const cdp = await page.context().newCDPSession(page);
  const records = new Map();
  const parents = new Map();
  for (const name of ['Page.frameAttached', 'Page.frameNavigated'])
    cdp.on(name, (event) => {
      const frameId = event.frameId ?? event.frame?.id;
      const parentId = event.parentFrameId ?? event.frame?.parentId;
      if (frameId && parentId) parents.set(frameId, parentId);
    });
  cdp.on('Network.requestWillBeSent', (event) =>
    records.set(event.requestId, {
      frameId: event.frameId,
      method: event.request.method,
      type: event.type,
      path: new URL(event.request.url).pathname,
    }),
  );
  cdp.on(
    'Network.loadingFinished',
    (event) => records.get(event.requestId) && (records.get(event.requestId).finishedTimestamp = event.timestamp),
  );
  cdp.on(
    'Network.loadingFailed',
    (event) => records.get(event.requestId) && (records.get(event.requestId).failure = event.errorText),
  );
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  const waits = [];
  if (pause) {
    cdp.on('Fetch.requestPaused', (event) => {
      if (new URL(event.request.url).pathname === '/b') documentPaused.resolve();
      awaitWritesBeforeDocument(
        event.frameId,
        () => [...records.values()],
        () => parents,
        { timeout },
      )
        .then((wait) => wait && waits.push(wait))
        .finally(() => cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {}));
    });
    await cdp.send('Fetch.enable', { patterns: [DOCUMENT_REQUEST_PATTERN] });
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    page,
    outcomes,
    requests,
    waits,
    origin,
    releaseWrite: write.resolve,
    writeClosed: writeClosed.promise,
    documentPaused: documentPaused.promise,
  };
}

test("a navigation waits until the replaced document's in-flight script write settles", async (t) => {
  const { page, outcomes, requests, waits, origin, releaseWrite, documentPaused } = await fixture(t);
  const write = page.waitForRequest((request) => request.url().endsWith('/write'));
  await page.goto(origin + '/a');
  await write;
  await page.evaluate(() => {
    // Remove the synchronous request this test does not exercise.
    const link = document.getElementById('next');
    link.replaceWith(link.cloneNode(true));
  });
  // A Playwright click returns only after the navigation proceeds; a page click lets the test hold it first.
  await page.evaluate(() => document.getElementById('next').click());
  // The paused navigation holds its document request while the write is held.
  await documentPaused;
  assert.equal(requests.includes('/b'), false);
  releaseWrite();
  await page.waitForURL(origin + '/b');
  // The write completed in the old document before it was replaced; reads do not hold navigation.
  assert.equal(waits.length, 1);
  assert.deepEqual(waits[0].writes, ['PATCH /write']);
  assert.equal(waits[0].settled, true);
  assert.deepEqual(
    outcomes.find((row) => row.path === '/write'),
    { path: '/write', finished: true },
  );
  assert.equal(await page.evaluate(() => sessionStorage.getItem('saved')), '1');
});

test('without the pause the browser abandons the write; the wait itself is bounded', async (t) => {
  const plain = await fixture(t, { pause: false });
  const write = plain.page.waitForRequest((request) => request.url().endsWith('/write'));
  await plain.page.goto(plain.origin + '/a');
  await write;
  await plain.page.evaluate(() => {
    const link = document.getElementById('next');
    link.replaceWith(link.cloneNode(true));
  });
  await plain.page.click('#next');
  await plain.page.waitForURL(plain.origin + '/b');
  // The server records the abandoned response when the client closes it.
  await plain.writeClosed;
  assert.deepEqual(
    plain.outcomes.find((row) => row.path === '/write'),
    { path: '/write', finished: false },
  );

  // The write stays held, so only the 300ms bound ends the wait.
  const bounded = await fixture(t, { timeout: 300 });
  const slow = bounded.page.waitForRequest((request) => request.url().endsWith('/write'));
  await bounded.page.goto(bounded.origin + '/a');
  await slow;
  await bounded.page.evaluate(() => {
    const link = document.getElementById('next');
    link.replaceWith(link.cloneNode(true));
  });
  await bounded.page.click('#next');
  await bounded.page.waitForURL(bounded.origin + '/b');
  assert.equal(bounded.waits.length, 1);
  assert.equal(bounded.waits[0].settled, false);
  assert.ok(bounded.waits[0].waitedMs >= 300, `waited ${bounded.waits[0].waitedMs} ms`);
});

test('pausing only documents lets a redirected synchronous request finish while its frame navigates', async (t) => {
  const { page, requests, origin } = await fixture(t, { holdWrite: false, syncRedirect: true });
  const written = page.waitForEvent('requestfinished', (request) => request.url().endsWith('/write'));
  await page.goto(origin + '/a');
  // No write remains in flight to hold the navigation.
  await written;
  // The click starts the navigation; the page then sends a synchronous request answered with a
  // redirect only after /b was answered, so the redirect arrives while the frame navigates.
  await page.click('#next');
  await page.waitForURL(origin + '/b');
  assert.ok(requests.includes('/target'), `requests: ${requests.join(', ')}`);
});
