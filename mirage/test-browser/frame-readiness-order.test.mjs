// @test-kind contract: Mirage's own frame load blocker is requested only after the frame's parser-blocking scripts arrived, so their delivery time never counts against its limit; no native behaviour is claimed.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createFrameReadiness } from '../lib/frame-readiness.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

test('a frame whose jQuery arrives late requests the blocker image after it and loads after its ready handler', async (t) => {
  const diagnostics = [],
    readiness = createFrameReadiness({ diagnostic: (item) => diagnostics.push(item) });
  const jquery = await fs.readFile(createRequire(import.meta.url).resolve('jquery/dist/jquery.min.js'));
  // The frame's parser-blocking script is answered only when the test releases it, as a loaded host answers late.
  const scriptRequested = Promise.withResolvers(),
    releaseScript = Promise.withResolvers();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (readiness.handle(req, res, url)) return;
    if (url.pathname === '/jquery.js') {
      scriptRequested.resolve();
      return void releaseScript.promise.then(() =>
        res.writeHead(200, { 'content-type': 'text/javascript' }).end(jquery),
      );
    }
    if (url.pathname === '/sentinel.gif') return res.writeHead(204).end();
    res.writeHead(200, { 'content-type': 'text/html' });
    if (url.pathname !== '/frame') return res.end('<!doctype html><html><body></body></html>');
    // The sentinel image follows the blocker in the markup: the browser looks ahead for images in document order, so
    // once it asks for the sentinel it has passed any blocker image it would fetch ahead of the parser.
    res.end(
      readiness.decorate(
        '<!doctype html><html><head><script src="/jquery.js"></script></head><body><script>$(function(){window.readyAt=performance.now();});</script></body><img hidden alt="" src="/sentinel.gif"></html>',
        { path: '/frame' },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let context;
  ownedFixture(t).add(async () => {
    releaseScript.resolve();
    await context?.close();
    readiness.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  context = await browser.newContext();
  const page = await context.newPage();
  const requested = [];
  const sentinelRequested = Promise.withResolvers();
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    requested.push(
      request.method() + ' ' + (pathname.startsWith('/__sim/frame-ready/') ? '/__sim/frame-ready/' : pathname),
    );
    if (pathname === '/sentinel.gif') sentinelRequested.resolve();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.onload = () => {
      window.loaded = {
        readyAt: frame.contentWindow.readyAt ?? null,
        ordering: frame.contentWindow.__portalSimulation?.frameLoadOrdering ?? null,
      };
    };
    frame.src = '/frame';
    document.body.replaceChildren(frame);
  });
  await scriptRequested.promise;
  await sentinelRequested.promise;
  assert.ok(!requested.includes('GET /__sim/frame-ready/'), JSON.stringify(requested));
  const scriptAnswered = page.waitForResponse((response) => new URL(response.url()).pathname === '/jquery.js');
  releaseScript.resolve();
  await (await scriptAnswered).finished();
  const scriptFinishedAt = requested.length;
  await page.waitForFunction(() => window.loaded);
  assert.ok(requested.indexOf('GET /__sim/frame-ready/') >= scriptFinishedAt, JSON.stringify(requested));
  const loaded = await page.evaluate(() => window.loaded);
  assert.equal(typeof loaded.readyAt, 'number', JSON.stringify(loaded));
  assert.equal(loaded.ordering, 'jquery-ready');
  assert.deepEqual(
    diagnostics.map(({ code, ordering }) => ({ code, ordering })),
    [{ code: 'FRAME_LOAD_ORDERING', ordering: 'jquery-ready' }],
  );
});
