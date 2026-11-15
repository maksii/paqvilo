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
    route: async (_pattern, handler) => {
      handlers.add(handler);
    },
    unroute: async (_pattern, handler) => {
      handlers.delete(handler);
    },
    opener: async () => opener,
    isClosed: () => counts.closed > 0,
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
  const closeListeners = new Set();
  const routes = new Map();
  return {
    listeners,
    routes,
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    once: (event, listener) => {
      if (event === 'close') closeListeners.add(listener);
    },
    close: () => {
      for (const listener of closeListeners) listener();
    },
    route: async (pattern, handler) => {
      routes.set(pattern, handler);
    },
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
    fallback: () => {
      calls.push('fallback');
    },
    abort: () => {
      calls.push('abort');
    },
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
  const guard = (route) => {
    refused.push(route);
  };
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
    (route) => {
      refused.push(route.request().method());
    },
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
    (route) => {
      refused.push(route);
    },
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

// @test-kind security: a tab that was already open when a live flow started cannot write while the flow runs
test('a non-GET request from a page that was already open when the flow started is refused', async () => {
  // `other` existed before the guard started, so the context's page event never announces it.
  const other = fakePage(null);
  const context = Object.assign(fakeContext(), { pages: () => [other] });
  const refused = [];
  const owner = fakePage(null);
  const stop = await __testing.guardOpenedPages(
    context,
    owner,
    (route) => {
      refused.push(route.request().method());
    },
    () => {},
  );
  await context.routes.get('**/*')(fakeRoute(other, 'POST'));
  assert.deepEqual(refused, ['POST'], 'the page was open before the flow started, so its write reaches the guard');
  await stop();
  assert.equal(context.routes.size, 0);
});

// @test-kind contract: a popup whose route fails while its opener is still unknown is closed without an unhandled rejection
test('a popup whose opener lookup fails stays under the flow guard without an unhandled rejection', async () => {
  const context = fakeContext();
  const owner = fakePage(null);
  const popup = fakePage(owner);
  let releaseOpener;
  const openerGate = new Promise((resolve) => {
    releaseOpener = resolve;
  });
  let lookedUp;
  const lookup = new Promise((resolve) => {
    lookedUp = resolve;
  });
  popup.opener = () => {
    lookedUp();
    return openerGate.then(() => Promise.reject(new Error('Target page, context or browser has been closed')));
  };
  const unhandled = [];
  const record = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', record);
  try {
    const refused = [];
    const stop = await __testing.guardOpenedPages(
      context,
      owner,
      (route) => {
        refused.push(route);
      },
      () => {},
    );
    const pending = context.open(popup);
    await lookup;
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
  const boom = new Error('boom');
  await assert.rejects(
    handler(failingRoute(owner, closed)),
    /has been closed/,
    'an open flow page rethrows its failure',
  );
  await assert.rejects(handler(failingRoute(popup, closed)), /has been closed/, 'an open popup rethrows its failure');
  await assert.rejects(handler(failingRoute(owner, boom)), /boom/);
  await assert.rejects(handler(failingRoute(popup, boom)), /boom/);
  await owner.close();
  await popup.close();
  await assert.doesNotReject(
    handler(failingRoute(owner, closed)),
    'the closed flow page answers through its own fallback',
  );
  await assert.doesNotReject(handler(failingRoute(owner, boom)), 'a closed flow page ignores any failure text');
  await assert.doesNotReject(handler(failingRoute(popup, closed)), 'a closed popup answers through the flow guard');
  await assert.doesNotReject(handler(failingRoute(popup, boom)), 'a closed popup ignores any failure text');
  await stop();
});

// @test-kind contract: a guarded request answered after its context closed does not reject, even on an open page
test('a guarded request answered after its context closed does not reject', async () => {
  const context = fakeContext();
  const owner = fakePage(null);
  const stop = await __testing.guardOpenedPages(
    context,
    owner,
    (route) => route.abort('blockedbyclient'),
    () => {},
  );
  const boom = new Error('route.abort: boom');
  const failing = {
    request: () => ({ method: () => 'POST', frame: () => ({ page: () => owner }) }),
    fallback: () => Promise.reject(boom),
  };
  await assert.rejects(context.routes.get('**/*')(failing), /boom/, 'an open page rethrows while the context is open');
  context.close();
  await assert.doesNotReject(context.routes.get('**/*')(failing), 'a closed context answers through the flow guard');
  await stop();
});

// @test-kind contract: stop waits for a popup still resolving its opener, closes it, and never registers it
test('stop waits for a popup still resolving its opener, closes it, and never registers it', async () => {
  const context = fakeContext();
  const owner = fakePage(null);
  const opened = [];
  const stop = await __testing.guardOpenedPages(
    context,
    owner,
    () => {},
    (page) => opened.push(page),
  );
  const popup = fakePage(owner);
  let openerRequested;
  const requested = new Promise((resolve) => {
    openerRequested = resolve;
  });
  let releaseOpener;
  const gate = new Promise((resolve) => {
    releaseOpener = resolve;
  });
  popup.opener = () => {
    openerRequested();
    return gate;
  };
  const opening = Promise.all(context.open(popup));
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await requested;
  // only an event this test controls can settle it: one turn lets a version that does not wait run past its wait
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, 'stop is still pending while the popup awaits its opener');
  releaseOpener(owner);
  await stopping;
  assert.equal(popup.counts.closed, 1, 'stop has closed the popup that resumed after stop');
  await opening;
  assert.equal(popup.counts.closed, 1, 'the popup that resumed after stop is closed');
  assert.deepEqual(opened, [], 'onOpened is not called for a popup that resumed after stop');
  assert.equal(context.listeners.size, 0);
});

test('stop waits for a route answer that is still in flight before it unroutes and closes pages', async () => {
  const context = fakeContext();
  const owner = fakePage(null);
  const events = [];
  let releaseAnswer;
  const held = new Promise((resolve) => {
    releaseAnswer = resolve;
  });
  const guard = (route) => {
    events.push('answer-started');
    return held
      .then(() => route.abort('blockedbyclient'))
      .then(() => {
        events.push('answer-finished');
      });
  };
  const unroute = context.unroute;
  context.unroute = async (pattern, handler) => {
    events.push('unroute');
    return unroute(pattern, handler);
  };
  const stop = await __testing.guardOpenedPages(context, owner, guard, () => {});
  const popup = fakePage(owner);
  const close = popup.close;
  popup.close = async () => {
    events.push('closed');
    return close();
  };
  await Promise.all(context.open(popup));
  const answering = context.routes.get('**/*')(fakeRoute(popup));
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  assert.equal(stopped, false, 'stop is still pending while the route answer is held');
  releaseAnswer();
  await stopping;
  await answering;
  assert.deepEqual(events, ['answer-started', 'answer-finished', 'unroute', 'closed']);
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

test('a live flow closes its write net after its page guard and page, also when either of them fails', async () => {
  const run = ({ stopFails = false, closeFails = false } = {}) => {
    const calls = [];
    const step = (name, fails) => async () => {
      calls.push(name);
      if (fails) throw new Error(`${name} failed`);
    };
    const ended = __testing.endFlowPage({ close: step('page close', closeFails) }, step('stop', stopFails), {
      close: step('net close', false),
    });
    return { ended, calls };
  };

  const clean = run();
  await clean.ended;
  assert.deepEqual(clean.calls, ['stop', 'page close', 'net close']);

  const closeFailing = run({ closeFails: true });
  await assert.rejects(closeFailing.ended, /page close failed/);
  assert.deepEqual(closeFailing.calls, ['stop', 'page close', 'net close'], 'the net closes after a failed page close');

  const stopFailing = run({ stopFails: true });
  await assert.rejects(stopFailing.ended, /stop failed/);
  assert.deepEqual(stopFailing.calls, ['stop', 'net close'], 'the net closes after a failed guard stop');

  await __testing.endFlowPage({ close: async () => {} }, null, null);
});
