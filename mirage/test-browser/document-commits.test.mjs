import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { observeDocumentCommits } from '../lib/document-commits.mjs';

const until = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Document observation did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
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
      documents = [],
      commits = [],
      requests = [],
      current = new WeakMap();
    page.on('request', (request) => {
      if (request.resourceType() === 'fetch')
        requests.push({ frame: request.frame(), token: current.get(request.frame()), retired: false });
    });
    const dispose = await observeDocumentCommits(page, cdp, {
      document: (frame, token) => {
        current.set(frame, token);
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
    const child = page.frames().find((frame) => frame.parentFrame());
    await until(() => documents.some((row) => row.frame === child));
    const startRead = async (count) => {
      await child.evaluate(() => {
        void fetch('/never').catch(() => {});
      });
      await until(() => requests.length === count);
    };
    const first = documents.find((row) => row.frame === child).token;
    await startRead(1);
    await child.evaluate(() => {
      location.hash = 'same-document';
      history.pushState({}, '', '?history=1');
    });
    await page.waitForTimeout(100);
    assert.equal(commits.length, 0);
    assert.equal(requests[0].retired, false);
    await child.goto(cross + '/next');
    await until(() => commits.some((row) => row.frame === child && row.token === first));
    await until(() => documents.some((row) => row.frame === child && row.token !== first));
    const second = documents.filter((row) => row.frame === child).at(-1).token;
    await startRead(2);
    await child.evaluate((url) => {
      location.href = url;
    }, origin + '/same-process');
    await until(() => commits.some((row) => row.frame === child && row.token === second));
    await until(() => documents.some((row) => row.frame === child && row.token !== second));
    const third = documents.filter((row) => row.frame === child).at(-1).token;
    await startRead(3);
    await child.evaluate((url) => {
      location.href = url;
    }, cross + '/return-to-isolated');
    await until(() => commits.some((row) => row.frame === child && row.token === third));
    await until(() => documents.some((row) => row.frame === child && row.token !== third));
    const fourth = documents.filter((row) => row.frame === child).at(-1).token;
    await startRead(4);
    await child.goto(cross + '/isolated-again');
    await until(() => commits.some((row) => row.frame === child && row.token === fourth));
    assert.equal(commits.filter((row) => row.frame === page.mainFrame()).length, 0);
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
    const again = [];
    const stop = await observeDocumentCommits(page, cdp, {
      document: (frame, token) => again.push({ frame, token }),
      commit: () => {},
    });
    await page.goto(origin + '/second-observer');
    await until(() => again.length > 0);
    assert.equal(documents.length, retired);
    stop();
    assert.equal(cdp.listenerCount('Page.frameNavigated'), 0);
  },
);
