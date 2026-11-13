// @test-kind security: a live flow's popups and frames send no write even when another debugging client resumes them before any page guard
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { ownedFixture, makeTemporaryDirectory, removeFixtureDirectory } from '../testing/owned-fixture.mjs';
import { __testing } from '../acceptance.mjs';
import { closeServer, devToolsActivePort, openResumingClient } from './shared-browser.mjs';

const FLOW_WRITES = ['/form-save', '/popup-save'];
const FOREIGN_WRITE = '/foreign-save';
const AFTER_WRITE = '/after-save';

// The flow's page posts a form into a new window and opens a popup whose script posts over XHR.
const openerPage = `<!doctype html><title>Flow</title><main>Flow page</main>
<form id="save" method="post" action="/form-save" target="form-popup"><input name="a" value="1"></form>
<script>
document.getElementById('save').submit();
window.open('/popup', 'popup');
</script>`;

const popupPage = `<!doctype html><title>Popup</title><script>
fetch('/popup-save', { method: 'POST', body: 'x' }).catch(() => {});
</script>`;

const foreignPage = `<!doctype html><title>Foreign</title><script>
fetch('/foreign-save', { method: 'POST', body: 'x' }).catch(() => {});
</script>`;

const PAGES = { '/': openerPage, '/popup': popupPage, '/foreign': foreignPage };

/** Answers GET requests with their page and records every other request, resolving that write's fate as reached. */
function serve(fates, posts) {
  return (req, res) => {
    if (req.method !== 'GET') {
      posts.push(req.url);
      fates.get(req.url)?.resolve('reached');
      res.writeHead(200).end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGES[req.url] ?? '<!doctype html><title>Other</title>');
  };
}

async function launchOwnedBrowser(profile) {
  const context = await chromium.launchPersistentContext(
    profile,
    browserLaunchOptions({
      headless: true,
      args: [
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-popup-blocking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      ],
    }),
  );
  const port = await devToolsActivePort(profile);
  return { context, cdpUrl: `http://127.0.0.1:${port}` };
}

test('a live flow net stops its page, popups and frames before any page guard, and releases the flow after close', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-write-net-'));
  const fates = new Map([...FLOW_WRITES, FOREIGN_WRITE, AFTER_WRITE].map((write) => [write, Promise.withResolvers()]));
  const posts = [];
  const server = http.createServer(serve(fates, posts));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { context: owner, cdpUrl } = await launchOwnedBrowser(path.join(directory, 'profile'));
  const resuming = await openResumingClient(cdpUrl);
  const flowClient = await chromium.connectOverCDP(cdpUrl);
  let net = null;
  ownedFixture(t).add(async () => {
    await net?.close();
    await flowClient.close();
    await resuming.close();
    await owner.close();
    await closeServer(server);
    await removeFixtureDirectory(directory);
  });

  const flowContext = flowClient.contexts()[0];
  const page = await flowContext.newPage();
  net = await __testing.openFlowWriteNet(cdpUrl, flowContext, page, (request) =>
    fates.get(new URL(request.url).pathname)?.resolve('blocked'),
  );
  const foreign = await owner.newPage();
  await foreign.goto(`${origin}/foreign`);
  await page.goto(`${origin}/`);

  const outcomes = Object.fromEntries(
    await Promise.all(
      [...FLOW_WRITES, FOREIGN_WRITE].map((write) => fates.get(write).promise.then((fate) => [write, fate])),
    ),
  );
  assert.deepEqual(
    outcomes,
    { '/form-save': 'blocked', '/popup-save': 'blocked', '/foreign-save': 'reached' },
    'the flow writes were blocked by the net and the foreign tab write reached the server',
  );
  assert.deepEqual(posts, [FOREIGN_WRITE], 'the server saw no write of the flow');

  await net.close();
  net = null;
  const afterWrite = fates.get(AFTER_WRITE).promise;
  await page.evaluate(() => fetch('/after-save', { method: 'POST', body: 'x' }).then(() => 'sent'));
  assert.equal(await afterWrite, 'reached', 'the flow page write reaches the server once the net is closed');
});
