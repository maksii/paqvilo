import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { observeDocumentCommits } from '../lib/document-commits.mjs';
import { eventLog } from './shared-browser.mjs';

const observations = (kind) => eventLog({ timeout: 5000, message: `${kind} observation did not arrive` });
test(
  'document commits follow cross-origin renderer targets, swaps and observer disposal',
  { timeout: 30000 },
  async (t) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/never')) return;
      res.setHeader('content-type', 'text/html');
      res.end(
        req.url === '/'
          ? `<iframe src="http://localhost:${server.address().port}/child"></iframe>`
          : '<p>Observed document</p>',
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(() => browser.close());
    const context = await browser.newContext(),
      page = await context.newPage(),
      cdp = await context.newCDPSession(page),
      documents = observations('Document'),
      commits = observations('Commit'),
      requests = observations('Request'),
      current = new WeakMap();
    page.on('request', (request) => {
      if (request.resourceType() === 'fetch')
        requests.push({ frame: request.frame(), token: current.get(request.frame()), retired: false });
    });
    const dispose = await observeDocumentCommits(page, cdp, {
      document: (frame, token) => {
        current.set(frame, token);
      },
      ready: (frame, token) => {
        documents.push({ frame, token });
      },
      commit: (frame, token) => {
        commits.push({ frame, token });
        for (const row of requests) if (row.frame === frame && row.token === token) row.retired = true;
      },
    });
    const origin = `http://127.0.0.1:${server.address().port}`,
      cross = `http://localhost:${server.address().port}`;
    await page.goto(origin);
    const child = page.frames().find((frame) => frame.parentFrame()),
      currentToken = () => documents.findLast((row) => row.frame === child)?.token;
    await documents.until(() => currentToken());
    const startRead = async (count) => {
      await child.evaluate(() => {
        void fetch('/never').catch(() => {});
      });
      await requests.until(() => requests.length === count);
    };
    const first = currentToken();
    await startRead(1);
    await child.evaluate(() => {
      location.hash = 'same-document';
      history.pushState({}, '', '?history=1');
    });
    // Same-document changes commit nothing; the exact commit sequence asserted below also catches a late one.
    assert.equal(commits.length, 0);
    assert.equal(requests[0].retired, false);
    await child.goto(cross + '/next');
    await commits.until(() => commits.some((row) => row.frame === child && row.token === first));
    // An older token also differs from the predecessor; only the latest ready document establishes replacement.
    await documents.until(() => currentToken() !== first);
    const second = currentToken();
    await startRead(2);
    await child.evaluate((url) => {
      location.href = url;
    }, origin + '/same-process');
    // A script navigation returns before it commits; the next frame navigation waits for it to load.
    await child.waitForURL(origin + '/same-process');
    await commits.until(() => commits.some((row) => row.frame === child && row.token === second));
    await documents.until(() => currentToken() !== second);
    const third = currentToken();
    await startRead(3);
    await child.evaluate((url) => {
      location.href = url;
    }, cross + '/return-to-isolated');
    await child.waitForURL(cross + '/return-to-isolated');
    await commits.until(() => commits.some((row) => row.frame === child && row.token === third));
    await documents.until(() => currentToken() !== third);
    const fourth = currentToken();
    await startRead(4);
    await child.goto(cross + '/isolated-again');
    await commits.until(() => commits.some((row) => row.frame === child && row.token === fourth));
    // Exactly one commit per replaced child document, in order, and none for the main frame.
    assert.deepEqual(
      commits.map((row) => [row.frame === child, row.token]),
      [first, second, third, fourth].map((token) => [true, token]),
    );
    assert.ok(requests.every((row) => row.retired));
    // Bindings are visible to page scripts: malformed payloads must never enter observer state.
    const before = documents.length;
    await page.evaluate(async () => {
      const name = Object.getOwnPropertyNames(window).find((key) => key.startsWith('__paqviloDocumentFrame'));
      for (const value of [null, {}, 'x'.repeat(10000), 'not-a-token']) await window[name](value);
    });
    assert.equal(documents.length, before);
    dispose();
    assert.equal(cdp.listenerCount('Page.frameNavigated'), 0);
    assert.equal(cdp.listenerCount('Runtime.bindingCalled'), 0);
    const retired = documents.length;
    await page.goto(origin + '/after-dispose');
    assert.equal(documents.length, retired);
    const again = observations('Replacement observer document');
    const stop = await observeDocumentCommits(page, cdp, {
      document: () => {},
      ready: (frame, token) => again.push({ frame, token }),
      commit: () => {},
    });
    await page.goto(origin + '/second-observer');
    await again.until(() => again.length > 0);
    assert.equal(documents.length, retired);
    stop();
    assert.equal(cdp.listenerCount('Page.frameNavigated'), 0);
  },
);
