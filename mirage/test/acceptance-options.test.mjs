// @test-kind contract: acceptance option validation and evidence paths are Paqvilo's own CLI and runtime behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAcceptance, __testing } from '../acceptance.mjs';

// @test-kind security: live acceptance evidence keeps parameter names and no query value of the live portal URL
test('live flow URLs in acceptance evidence keep no query value, and local flow URLs are unchanged', () => {
  const live = new URL('https://portal.invalid/profile');
  live.search = new URLSearchParams({
    fetchXml: '<fetch><condition value="alice@example.com"/></fetch>',
    returnUrl: '/profile',
    id: '1234',
    sig: 'signature-value',
    state: 'xyz',
  }).toString();
  live.hash = 'access_token=fragment-token';
  const shown = __testing.failureUrl(live.href, { isLive: true });
  assert.equal(shown, 'https://portal.invalid/profile?fetchXml=…&id=…&returnUrl=…&sig=…&state=…');
  for (const secret of ['alice', 'signature-value', '1234', 'xyz', 'fragment-token', '%3C'])
    assert.ok(!shown.includes(secret), `live evidence URL leaked ${secret}`);
  assert.equal(
    __testing.failureUrl('http://127.0.0.1:4321/profile?id=1234&q=a'),
    'http://127.0.0.1:4321/profile?id=1234&q=a',
  );
});

// @test-kind contract: each acceptance run writes its evidence into its own folder under the output root
test('acceptance runs sharing one output root keep separate evidence folders and never reuse one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-acceptance-evidence-'));
  try {
    const first = await __testing.createRunDirectory(root, new Date('2026-11-12T10:15:30.123Z'));
    const second = await __testing.createRunDirectory(root, new Date('2026-11-12T10:16:00.000Z'));
    assert.equal(path.dirname(first), root);
    assert.notEqual(first, second);
    await fs.writeFile(path.join(first, 'report.json'), '{"run":1}');
    await fs.writeFile(path.join(second, 'report.json'), '{"run":2}');
    assert.equal(await fs.readFile(path.join(first, 'report.json'), 'utf8'), '{"run":1}');
    await assert.rejects(
      __testing.createRunDirectory(root, new Date('2026-11-12T10:15:30.123Z')),
      /Evidence folder .* already exists; choose another --output/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const fakePage = (opener, url = 'about:blank') => {
  const handlers = new Set();
  const counts = { closed: 0 };
  const mainFrame = { location: url, url: () => mainFrame.location };
  const page = Object.assign(new EventEmitter(), {
    handlers,
    counts,
    route: async (_pattern, handler) => void handlers.add(handler),
    unroute: async (_pattern, handler) => void handlers.delete(handler),
    opener: async () => opener,
    url: () => mainFrame.location,
    mainFrame: () => mainFrame,
    close: async () => {
      counts.closed++;
      page.emit('close');
    },
  });
  return page;
};
const fakeContext = () => {
  const listeners = new Set();
  const routes = new Map();
  return {
    listeners,
    routes,
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    route: async (pattern, handler) => void routes.set(pattern, handler),
    unroute: async (pattern, handler) => {
      if (routes.get(pattern) === handler) routes.delete(pattern);
    },
    open: (page) => [...listeners].map((listener) => listener(page)),
  };
};
// A context route sees a request together with the page that issued it; `calls` records how the route was settled.
const fakeRoute = (page, method = 'POST') => {
  const calls = [];
  return {
    calls,
    request: () => ({ method: () => method, frame: () => ({ page: () => page }) }),
    fallback: () => void calls.push('fallback'),
    abort: () => void calls.push('abort'),
  };
};
const navigateFake = (page, href) => {
  page.mainFrame().location = href;
  page.emit('framenavigated', page.mainFrame());
};
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

// @test-kind security: a page opened by a live flow, or by a page the flow opened, gets the flow's request guard before its first await
test('live flow guard covers the popups its pages open and releases pages the flow did not open', async () => {
  const context = fakeContext();
  const refused = [];
  const guard = (route) => void refused.push(route);
  const owner = fakePage(null);
  const opened = [];
  const stop = await __testing.guardOpenedPages(context, owner, guard, (page) => opened.push(page));
  const popup = fakePage(owner);
  const nested = fakePage(popup);
  const other = fakePage(null);
  const foreign = fakePage(other);
  const pending = [...context.open(popup), ...context.open(nested), ...context.open(other), ...context.open(foreign)];
  await Promise.all(pending);
  assert.deepEqual(opened, [popup, nested]);
  assert.ok(context.routes.has('**/*'), 'the guard is a context route, so it covers every page of the context');
  const handler = context.routes.get('**/*');
  const fromNested = fakeRoute(nested);
  await handler(fromNested);
  assert.deepEqual(refused, [fromNested]);
  const fromForeign = fakeRoute(foreign);
  await handler(fromForeign);
  assert.deepEqual(fromForeign.calls, ['fallback'], 'a page the flow did not open is released');
  await stop();
  assert.equal(context.listeners.size, 0);
  assert.equal(context.routes.size, 0);
  assert.equal(popup.counts.closed + nested.counts.closed, 2);
  assert.equal(owner.counts.closed + foreign.counts.closed, 0);
});

// @test-kind security: a non-GET request from a popup of the flow page is refused even as the popup's first request, before its page event
test('the first request of a popup of the flow page is guarded before the page event reports its opener', async () => {
  const context = fakeContext();
  const refused = [];
  const owner = fakePage(null);
  const stop = await __testing.guardOpenedPages(
    context,
    owner,
    (route) => void refused.push(route.request().method()),
    () => {},
  );
  const popup = fakePage(owner);
  await context.routes.get('**/*')(fakeRoute(popup, 'POST'));
  assert.deepEqual(refused, ['POST']);
  await Promise.all(context.open(popup));
  await stop();
});

// @test-kind security: a non-GET request from a page of the context that the flow did not open falls back, and stop removes the context route
test('a non-GET request from an unrelated page of the context falls back, and stop leaves no route behind', async () => {
  const context = fakeContext();
  const refused = [];
  const owner = fakePage(null);
  const stop = await __testing.guardOpenedPages(
    context,
    owner,
    (route) => void refused.push(route),
    () => {},
  );
  const unrelated = fakePage(null);
  await Promise.all(context.open(unrelated));
  const route = fakeRoute(unrelated, 'POST');
  await context.routes.get('**/*')(route);
  assert.deepEqual(route.calls, ['fallback']);
  assert.deepEqual(refused, []);
  await stop();
  assert.equal(context.routes.size, 0);
});

// @test-kind contract: a popup whose route fails while its opener is still unknown is closed without an unhandled rejection
test('a popup whose opener lookup fails stays under the flow guard without an unhandled rejection', async () => {
  const context = fakeContext();
  const owner = fakePage(null);
  const popup = fakePage(owner);
  let releaseOpener;
  const openerGate = new Promise((resolve) => void (releaseOpener = resolve));
  popup.opener = () =>
    openerGate.then(() => Promise.reject(new Error('Target page, context or browser has been closed')));
  const unhandled = [];
  const record = (reason) => void unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    const refused = [];
    const stop = await __testing.guardOpenedPages(
      context,
      owner,
      (route) => void refused.push(route),
      () => {},
    );
    const pending = context.open(popup);
    await nextTick();
    releaseOpener();
    await Promise.all(pending);
    await nextTick();
    assert.deepEqual(unhandled, [], 'a failed opener lookup must not surface as an unhandled rejection');
    await context.routes.get('**/*')(fakeRoute(popup, 'POST'));
    assert.equal(refused.length, 1, 'a popup whose opener is unknown stays guarded');
    await stop();
  } finally {
    process.off('unhandledRejection', record);
  }
});

// @test-kind security: a guarded request whose page closed before its answer leaves the guard fulfilled, and any other route failure still rejects
test('a guarded request whose page closed before the answer does not reject', async () => {
  const context = fakeContext();
  const owner = fakePage(null);
  const stop = await __testing.guardOpenedPages(
    context,
    owner,
    (route) => route.abort('blockedbyclient'),
    () => {},
  );
  const popup = fakePage(owner);
  await Promise.all(context.open(popup));
  const handler = context.routes.get('**/*');
  const failingRoute = (page, error) => ({
    request: () => ({ method: () => 'POST', frame: () => ({ page: () => page }) }),
    continue: () => Promise.reject(error),
    fallback: () => Promise.reject(error),
    abort: () => Promise.reject(error),
  });
  const closed = new Error('route.continue: Target page, context or browser has been closed');
  await assert.doesNotReject(handler(failingRoute(owner, closed)), 'the flow page answers through its own fallback');
  await assert.doesNotReject(handler(failingRoute(popup, closed)), 'a popup answers through the flow guard');
  const boom = new Error('boom');
  await assert.rejects(handler(failingRoute(owner, boom)), /boom/);
  await assert.rejects(handler(failingRoute(popup, boom)), /boom/);
  await stop();
});

// @test-kind contract: the popup evidence entry names the page the popup navigated to, with no query value
test('popup evidence names the page a popup navigates to and keeps no query value', async () => {
  const context = fakeContext();
  const owner = fakePage(null, 'https://example.test/start');
  const popup = fakePage(owner);
  const observation = { popups: [] };
  const stop = await __testing.guardOpenedPages(
    context,
    owner,
    () => {},
    (page, opener) => __testing.recordOpenedPopup(observation, page, opener),
  );
  await Promise.all(context.open(popup));
  navigateFake(popup, 'https://example.test/path?token=secret');
  assert.deepEqual(observation.popups, [{ url: 'https://example.test/path' }]);
  const shown = JSON.stringify(observation);
  assert.ok(!shown.includes('token') && !shown.includes('secret'), `popup evidence leaked a query value: ${shown}`);
  await stop();
});

// @test-kind contract: a popup closed before it navigates keeps an entry labelled with its opener's URL and ignores later navigation
test('a popup closed before it navigates keeps an entry labelled with its opener', async () => {
  const context = fakeContext();
  const owner = fakePage(null, 'https://example.test/start?token=secret');
  const popup = fakePage(owner);
  const observation = { popups: [] };
  const stop = await __testing.guardOpenedPages(
    context,
    owner,
    () => {},
    (page, opener) => __testing.recordOpenedPopup(observation, page, opener),
  );
  await Promise.all(context.open(popup));
  await popup.close();
  navigateFake(popup, 'https://example.test/late');
  assert.deepEqual(observation.popups, [{ url: 'opened by https://example.test/start' }]);
  await stop();
});

test('acceptance rejects unbounded action timeouts and invalid explicit reserves before launching a browser', async () => {
  for (const timeout of [0, -1, NaN, Infinity, '15000'])
    await assert.rejects(runAcceptance({ timeout }), /timeout must be a positive finite number/);
  for (const navigationCommitReserveMs of [-1, NaN, Infinity, 15000, '3000', null])
    await assert.rejects(
      runAcceptance({ navigationCommitReserveMs }),
      /navigationCommitReserveMs must be nonnegative and smaller than timeout/,
    );
});
