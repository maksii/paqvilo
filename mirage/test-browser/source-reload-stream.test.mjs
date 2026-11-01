import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { clientRuntime } from '../lib/platform.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(async () => {
  await browser?.close();
});

async function fixture(t) {
  let revision = 1,
    documents = 0;
  const arrivals = [],
    waiters = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/__sim/events') {
      // Hold the actual protocol response until the test advances the source
      // revision. No timer or probabilistic scheduling establishes the gap.
      const announce = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: ready\ndata: ${revision}\n\n`);
      };
      if (waiters.length) waiters.shift()(announce);
      else arrivals.push(announce);
      return;
    }
    if (req.url !== '/') return res.writeHead(404).end();
    documents++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<h1>Revision ${revision}</h1><script>${clientRuntime('invented-token', revision)}</script>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const page = await browser.newPage();
  t.after(async () => {
    await page.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    page,
    origin: `http://127.0.0.1:${server.address().port}`,
    advance: () => {
      revision++;
    },
    documents: () => documents,
    nextStream: () =>
      arrivals.length ? Promise.resolve(arrivals.shift()) : new Promise((resolve) => waiters.push(resolve)),
  };
}

test('a delayed first reload stream catches source changes made after document rendering', async (t) => {
  const app = await fixture(t);
  await app.page.goto(app.origin);
  const announce = await app.nextStream();
  assert.equal(await app.page.evaluate(() => window.__portalSimulation.revision), 1);
  app.advance();
  announce();
  await app.page.waitForFunction(() => window.__portalSimulation?.revision === 2);
  assert.equal(app.documents(), 2, 'one stale document is replaced by its current source revision');
});

test('current ready events preserve the document and a resumed stream reconciles a missed change', async (t) => {
  const app = await fixture(t);
  await app.page.goto(app.origin);
  const first = await app.nextStream();
  await app.page.evaluate(() => {
    window.readyObserved = new Promise((resolve) =>
      window.__portalSimulation.reloadStream.addEventListener('ready', resolve, { once: true }),
    );
  });
  first();
  await app.page.evaluate(() => window.readyObserved.then(() => null));
  assert.equal(app.documents(), 1, 'connecting at the rendered revision must not reload');
  await app.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  app.advance();
  await app.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
  const resumed = await app.nextStream();
  resumed();
  await app.page.waitForFunction(() => window.__portalSimulation?.revision === 2);
  assert.equal(app.documents(), 2);
});
