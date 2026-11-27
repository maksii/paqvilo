// @test-kind contract: the request ledger joins interception with the requests a real browser reports, on invented loopback origins
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { OverlaySession } from '../lense/session.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { createFixture, SITE } from '../test/fixture.mjs';
import { ownedFixture, drainFixture } from '../mirage/testing/owned-fixture.mjs';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('real browser: the ledger lists local, platform, external and worker requests, and a multipart post resets it', async (t) => {
  const owner = ownedFixture(t);
  const servers = [];
  owner.add(() =>
    drainFixture(
      servers.map((server) => async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }),
    ),
  );
  const serve = async (handler) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };
  const external = await serve((_request, response) =>
    response.writeHead(200, { 'content-type': 'image/png' }).end(PIXEL),
  );
  const posts = [];
  const origin = await serve((request, response) => {
    if (request.method === 'POST') {
      posts.push(request.url);
      request.resume();
      return request.once('end', () =>
        response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Posted</title>'),
      );
    }
    if (request.url === '/')
      return response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><title>Ledger</title><script src="/scripts/app.js"></script><img src="${external}/pixel.png?id=SECRET-ID"><form method="post" enctype="multipart/form-data" action="/upload"><input type="file" name="upload"><button id="send">Send</button></form><script>const worker = new Worker('/worker.js'); worker.onmessage = () => { window.workerDone = true; }; fetch('/_api/contacts?token=SECRET-TOKEN').then(() => { window.fetched = true; });</script>`,
        );
    if (request.url === '/worker.js')
      return response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end("fetch('/worker-data.json').then(() => postMessage('done'));");
    return response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });

  const fx = createFixture();
  owner.add(() => fx.cleanup());
  const session = new OverlaySession({ origin, sourceDir: fx.dir, site: structuredClone(SITE), sourceMaps: false });
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  // The second server stands for a public third-party host, as a portal's external origins are. A document Lense
  // answers itself has no network address, so the browser counts it as public, and an image from another loopback
  // address is then a public-to-local request under Local Network Access: refused, and its permission check can reach
  // the browser before the document's commit, which terminates the page's renderer (the navigation ends with
  // ERR_ABORTED, or the page crashes). Marking that one server public keeps the checks on and makes the request what
  // the test means it to be.
  const browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      `--ip-address-space-overrides=${new URL(external).host}=public`,
    ],
  });
  owner.add(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  owner.add(session.observeRequests(context));
  owner.add(await interceptOrigin(context, origin, session.route));

  // Each request the assertions read has finished (its response reached the ledger first) before they run.
  const settled = (suffix) =>
    Promise.race(
      ['requestfinished', 'requestfailed'].map((event) =>
        page.waitForEvent(event, { predicate: (request) => request.url().includes(suffix) }),
      ),
    );
  const loaded = ['/scripts/app.js', '/pixel.png', '/worker.js', '/worker-data.json', '/_api/contacts'].map(settled);
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => window.workerDone && window.fetched);
  await Promise.all(loaded);

  const summary = session.requestSummary(page);
  const find = (suffix) => summary.items.find((item) => item.url.includes(suffix));
  assert.deepEqual([find(`${origin}/`).class, find(`${origin}/`).status], ['document', 200]);
  assert.deepEqual([find('/scripts/app.js').class, find('/scripts/app.js').rel], ['local', 'web-files/app.js']);
  assert.deepEqual([find('/_api/contacts').class, find('/_api/contacts').platform], ['portal-data', 'web-api']);
  assert.deepEqual(find(external), {
    url: external,
    method: 'GET',
    type: 'image',
    // The external host answered the image itself.
    status: 200,
    class: 'external',
    count: 1,
  });
  // A dedicated worker's requests are reported for its page; the browser's own resource type is kept.
  assert.deepEqual([find('/worker.js').type, find('/worker.js').status], ['script', 200]);
  assert.equal(find('/worker-data.json').status, 200);
  assert.equal(JSON.stringify(summary).includes('SECRET'), false);
  assert.equal(
    summary.items.reduce((total, item) => total + item.count, 0),
    summary.total,
  );

  // A multipart post that navigates opens a new document: the post reaches the portal once, and its answer is read
  // at the response and accounted like any document of the portal.
  await page.setInputFiles('input[type=file]', {
    name: 'invented.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('invented'),
  });
  await Promise.all([page.waitForURL(`${origin}/upload`, { waitUntil: 'load' }), page.click('#send')]);
  assert.deepEqual(posts, ['/upload']);
  const posted = session.requestSummary(page);
  assert.deepEqual(
    posted.items.filter((item) => item.type === 'document').map((item) => [item.method, item.class, item.reason]),
    [['POST', 'document', undefined]],
  );
  assert.equal(
    posted.items.some((item) => item.url.includes('/scripts/app.js')),
    false,
    'the previous document has no entries left',
  );
  assert.deepEqual(session.pageHits.get(page), []);
});
