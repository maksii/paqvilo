// @test-kind contract: document identity and disposal are toolkit observer guarantees, exercised in real Chromium frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { observeDocumentCommits } from '../lib/document-commits.mjs';
import { sharedBrowser, loopbackServer, eventLog } from './shared-browser.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const browser = sharedBrowser();

test('script-disabled frames retain distinct identities through insertion, movement, replacement and navigation', async (t) => {
  const { origin } = await loopbackServer(t, (_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<h1>Frame fixture</h1><div id="destination"></div>');
  });
  const page = await browser.page(t),
    cdp = await page.context().newCDPSession(page);
  const ready = eventLog(),
    commits = eventLog(),
    errors = [],
    frames = new Map();
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const stop = await observeDocumentCommits(page, cdp, {
    document: (frame, token) => frames.set(frame, token),
    ready: (frame, token) => ready.push({ frame, token }),
    commit: (frame, token) => commits.push({ frame, token }),
  });
  ownedFixture(t).add(() => {
    stop();
    return cdp.detach().catch(() => {});
  });
  await page.goto(origin);
  await ready.until(() => ready.some((row) => row.frame === page.mainFrame()));
  const mutate = async (operation) => {
    const previous = ready.length;
    await page.evaluate(operation);
    await ready.until(() => ready.length > previous);
    const current = ready.at(-1);
    assert.notEqual(current.frame, page.mainFrame());
    assert.equal(frames.get(current.frame), current.token);
    assert.equal(
      new Set(ready.map((row) => row.token)).size,
      ready.length,
      'new documents never inherit a previous token',
    );
    assert.equal(await current.frame.locator('body').innerText(), 'Invented value');
    return current;
  };
  await mutate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'editor';
    frame.sandbox = 'allow-same-origin';
    frame.srcdoc = '<p>Invented value</p>';
    document.body.append(frame);
  });
  await mutate(() => document.querySelector('#destination').append(document.querySelector('#editor')));
  await mutate(() => {
    const previous = document.querySelector('#editor');
    previous.replaceWith(previous.cloneNode());
  });
  const before = ready.at(-1);
  const after = await mutate(() => {
    document.querySelector('#editor').srcdoc = '<p>Invented value</p><!-- replacement -->';
  });
  assert.equal(after.frame, before.frame, 'document replacement keeps the Playwright frame but changes its identity');
  await commits.until(() => commits.some((row) => row.frame === before.frame && row.token === before.token));
  assert.equal(await page.locator('#editor').getAttribute('sandbox'), 'allow-same-origin');
  assert.deepEqual(errors, []);
  stop();
  assert.equal(cdp.listenerCount('Runtime.executionContextCreated'), 0);
  assert.equal(cdp.listenerCount('Runtime.bindingCalled'), 0);
  assert.equal(cdp.listenerCount('Page.frameNavigated'), 0);
  const count = ready.length;
  await page.goto(origin + '/disposed');
  assert.equal(ready.length, count);
});

test('CDP restores a cached document identity without a pageshow listener', async (t) => {
  const { origin } = await loopbackServer(t, (_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<p>Cached document</p>');
  });
  // The observer supports restoration even when an owner enables BFCache explicitly.
  const options = browserLaunchOptions({ headless: true, ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  // Exercise restoration in full Chromium instead of Playwright's default headless shell.
  if (!options.channel) options.channel = 'chromium';
  const owned = await chromium.launch(options);
  ownedFixture(t).add(() => owned.close());
  const page = await owned.newPage(),
    cdp = await page.context().newCDPSession(page);
  const ready = eventLog(),
    commits = [],
    navigation = eventLog();
  cdp.on('Page.frameNavigated', (event) => navigation.push(event));
  const stop = await observeDocumentCommits(page, cdp, {
    document: () => {},
    ready: (_frame, token) => ready.push(token),
    commit: (_frame, token) => commits.push(token),
  });
  ownedFixture(t).add(() => {
    stop();
    return cdp.detach().catch(() => {});
  });
  await page.goto(origin);
  await ready.until(() => ready.length === 1);
  const first = ready[0];
  await page.goto(origin + '/next');
  await ready.until(() => ready.length === 2);
  const second = ready[1];
  const history = await cdp.send('Page.getNavigationHistory');
  await cdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id });
  await ready.until(() => ready.length === 3);
  assert.equal(navigation.at(-1).type, 'BackForwardCacheRestore', 'this exercises an actual cached restore');
  assert.deepEqual(ready, [first, second, first]);
  assert.deepEqual(commits, [first, second]);
  await cdp.send('Page.navigate', { url: origin + '/after-restore' });
  await ready.until(() => ready.length === 4);
  assert.deepEqual(commits, [first, second, first]);
  assert.notEqual(ready[3], first);
});
