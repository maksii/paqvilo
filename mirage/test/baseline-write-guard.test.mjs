// @test-kind security: the baseline write guard aborts every scenario write to the captured origin on the owned page and on popups it
// opens, and passes sign-in traffic and requests to other origins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNetDecision, pageRunner } from '../baseline-capture.mjs';
import { captureDecisionCases } from './support/capture-decision-cases.mjs';
import { withContextRoutes } from './support/context-routes.mjs';

const origin = 'https://portal.invalid';
const identityReferer = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize';
const topFrame = { parentFrame: () => null };

function emitter() {
  const listeners = new Map();
  return {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    off(event, listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((item) => item !== listener),
      );
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    async emit(event, arg) {
      await Promise.all((listeners.get(event) ?? []).map((listener) => listener(arg)));
    },
  };
}

// A route pattern is either the glob Playwright takes for every URL or a predicate over the URL.
const matches = (pattern, requestUrl) =>
  typeof pattern === 'function' ? pattern(new URL(requestUrl)) : pattern === '**/*';

// Plays one request through the routes as Playwright does: the page's routes run first, then the context's, and a
// fallback continues to the next matching handler. An abort is an outcome; a request that no handler aborts reaches
// the network and counts as passed.
async function fire(page, { method, url, headers = {}, navigation = false, topLevel = true }) {
  const request = {
    method: () => method,
    url: () => url,
    headers: () => headers,
    postData: () => null,
    resourceType: () => (navigation ? 'document' : 'fetch'),
    isNavigationRequest: () => navigation,
    frame: () => ({ parentFrame: () => (topLevel ? null : topFrame), page: () => page }),
    failure: () => ({ errorText: 'blockedbyclient' }),
  };
  let outcome = 'passed';
  await page.emit('request', request);
  const handlers = [...page.routes, ...page.context().routes].filter((item) => matches(item.pattern, url));
  for (const { handler } of handlers) {
    let decision = null;
    await handler({
      request: () => request,
      fallback: async () => {
        decision = 'fallback';
      },
      abort: async () => {
        decision = 'aborted';
      },
    });
    if (decision === 'aborted') outcome = 'aborted';
    if (decision !== 'fallback') break;
  }
  await page.emit(outcome === 'aborted' ? 'requestfailed' : 'requestfinished', request);
  page.context().outcomes.push({ method, url, outcome });
  return outcome;
}

function fakePage(context, openedBy) {
  const events = emitter();
  const routes = [];
  const page = {
    ...events,
    routes,
    context: () => context,
    async opener() {
      return openedBy;
    },
    async route(pattern, handler) {
      routes.push({ pattern, handler });
    },
    async unroute(pattern, handler) {
      const index = routes.findIndex((item) => item.pattern === pattern && item.handler === handler);
      if (index >= 0) routes.splice(index, 1);
    },
    async setViewportSize() {},
    async waitForTimeout() {},
    async waitForLoadState() {},
    async evaluate() {
      return false;
    },
    async title() {
      return '';
    },
    async screenshot() {
      return Buffer.alloc(0);
    },
    async close() {},
    url: () => origin + '/',
    closed: false,
    isClosed: () => page.closed,
    mainFrame: () => topFrame,
    frames: () => [],
    locator(selector) {
      return {
        async count() {
          return 0;
        },
        first() {
          return {
            async click() {
              const action = context.actions[selector];
              if (!action) throw new Error('No scripted action for ' + selector);
              await action(page);
            },
          };
        },
      };
    },
  };
  return page;
}

function fakeContext(actions) {
  const events = emitter();
  const context = withContextRoutes({
    ...events,
    actions,
    outcomes: [],
    async newPage() {
      return fakePage(context, null);
    },
  });
  return context;
}

async function runScenario(steps, actions, options = {}) {
  const context = fakeContext(actions);
  const caller = fakePage(context, null);
  const { raw } = await pageRunner(caller, {
    origin,
    scenario: { id: 'invented/write-guard', steps, expect: {} },
    settle: { quietMs: 0 },
    ...options,
  });
  return { context, raw };
}

const outcomeOf = (context, url) => context.outcomes.find((entry) => entry.url === url)?.outcome;

test('a scenario write to another host passes the guard and is not listed as a blocked write', async () => {
  const actions = {
    '#cross': (page) => fire(page, { method: 'POST', url: 'https://login.example.test/common/x' }),
  };
  const { context, raw } = await runScenario([{ click: '#cross', settle: false }], actions);
  assert.equal(outcomeOf(context, 'https://login.example.test/common/x'), 'passed');
  assert.deepEqual(raw.blockedWrites, []);
  assert.deepEqual(raw.identityTraffic, []);
});

test('a popup write to another host passes the guard and is not listed as a blocked write', async () => {
  const actions = {
    '#popup': async (page) => {
      const popup = fakePage(page.context(), page);
      await page.context().emit('page', popup);
      await fire(popup, { method: 'POST', url: 'https://login.example.test/common/x' });
    },
  };
  const { context, raw } = await runScenario([{ click: '#popup', settle: false }], actions);
  assert.equal(outcomeOf(context, 'https://login.example.test/common/x'), 'passed');
  assert.deepEqual(raw.blockedWrites, []);
});

test('a scenario write to the captured origin is aborted and listed on the owned page', async () => {
  const actions = {
    '#write': (page) => fire(page, { method: 'POST', url: origin + '/_api/accounts' }),
  };
  const { context, raw } = await runScenario([{ click: '#write', settle: false }], actions);
  assert.equal(outcomeOf(context, origin + '/_api/accounts'), 'aborted');
  assert.deepEqual(raw.blockedWrites, [{ method: 'POST', path: '/_api/accounts' }]);
});

test('a popup opened by the scenario is guarded: its write is aborted and listed, and its routes are removed', async () => {
  const opened = [];
  const actions = {
    '#popup': async (page) => {
      const popup = fakePage(page.context(), page);
      opened.push(popup);
      await page.context().emit('page', popup);
      await fire(popup, { method: 'POST', url: origin + '/_api/accounts' });
    },
  };
  const { context, raw } = await runScenario([{ click: '#popup', settle: false }], actions);
  assert.equal(outcomeOf(context, origin + '/_api/accounts'), 'aborted');
  assert.deepEqual(raw.blockedWrites, [{ method: 'POST', path: '/_api/accounts' }]);
  assert.equal(opened[0].routes.length, 0);
  assert.equal(context.listenerCount('page'), 0);
  assert.equal(context.listenerCount('close'), 0);
});

test('a login-page POST that is not an identity callback is aborted without write permission', async () => {
  const actions = {
    '#register': (page) => fire(page, { method: 'POST', url: origin + '/Account/Login/Register', navigation: true }),
  };
  const { context, raw } = await runScenario([{ click: '#register', settle: false }], actions);
  assert.equal(outcomeOf(context, origin + '/Account/Login/Register'), 'aborted');
  assert.deepEqual(raw.blockedWrites, [{ method: 'POST', path: '/Account/Login/Register' }]);
});

test('the same login-page POST passes when the run allows writes to its path', async () => {
  const actions = {
    '#register': (page) => fire(page, { method: 'POST', url: origin + '/Account/Login/Register', navigation: true }),
  };
  const { context, raw } = await runScenario([{ click: '#register', settle: false }], actions, {
    allowWrites: true,
    allowPaths: ['^/Account/Login/Register$'],
  });
  assert.equal(outcomeOf(context, origin + '/Account/Login/Register'), 'passed');
  assert.deepEqual(raw.blockedWrites, []);
});

test('a provider callback posted with an identity-host referer passes and is recorded as identity traffic', async () => {
  const actions = {
    '#signin': (page) =>
      fire(page, {
        method: 'POST',
        url: origin + '/signin-openid_1',
        navigation: true,
        headers: { referer: identityReferer },
      }),
  };
  const { context, raw } = await runScenario([{ click: '#signin', settle: false }], actions);
  assert.equal(outcomeOf(context, origin + '/signin-openid_1'), 'passed');
  assert.ok(
    raw.identityTraffic.some(
      (entry) =>
        entry.method === 'POST' && entry.path === '/signin-openid_1' && entry.from === 'login.microsoftonline.com',
    ),
  );
  assert.deepEqual(raw.blockedWrites, []);
});

test('a top-level navigation POST to an identity host passes and is recorded as identity traffic', async () => {
  const actions = {
    '#idp': (page) =>
      fire(page, { method: 'POST', url: 'https://login.microsoftonline.com/tenant/login', navigation: true }),
  };
  const { context, raw } = await runScenario([{ click: '#idp', settle: false }], actions);
  assert.equal(outcomeOf(context, 'https://login.microsoftonline.com/tenant/login'), 'passed');
  assert.ok(
    raw.identityTraffic.some((entry) => entry.host === 'login.microsoftonline.com' && entry.path === '/tenant/login'),
  );
  assert.deepEqual(raw.blockedWrites, []);
});

test('ordinary reads pass the guard on the owned page and across origins', async () => {
  const actions = {
    '#read': async (page) => {
      assert.equal(await fire(page, { method: 'GET', url: origin + '/page', navigation: true }), 'passed');
      assert.equal(await fire(page, { method: 'GET', url: 'https://other.invalid/asset.js' }), 'passed');
    },
  };
  const { raw } = await runScenario([{ click: '#read', settle: false }], actions);
  assert.deepEqual(raw.blockedWrites, []);
});

test('a page the scenario did not open keeps its own routes and is not guarded', async () => {
  const actions = {
    '#other-tab': async (page) => {
      const other = fakePage(page.context(), null);
      await page.context().emit('page', other);
      assert.equal(other.routes.length, 0);
      assert.equal(await fire(other, { method: 'POST', url: origin + '/_api/accounts' }), 'passed');
    },
  };
  const { raw } = await runScenario([{ click: '#other-tab', settle: false }], actions);
  assert.deepEqual(raw.blockedWrites, []);
});

// @test-kind contract: a page the scenario did not open is not observed after it is classified
test('a page the scenario did not open is not observed after it is classified', async () => {
  let other;
  const actions = {
    '#other-tab': async (page) => {
      other = fakePage(page.context(), null);
      await page.context().emit('page', other);
      await fire(other, { method: 'GET', url: origin + '/during', navigation: true });
    },
  };
  const { raw } = await runScenario([{ click: '#other-tab', settle: false }], actions);
  assert.equal(
    raw.requests.some((entry) => entry.url === origin + '/during'),
    false,
  );
  assert.equal(other.listenerCount('request'), 0);
});

test('a popup write issued before its opener is known is aborted and listed', async () => {
  const actions = {
    '#popup': async (page) => {
      const popup = fakePage(page.context(), page);
      let openerKnown;
      const openerGate = new Promise((resolve) => {
        openerKnown = resolve;
      });
      popup.opener = async () => {
        await openerGate;
        return page;
      };
      const handled = page.context().emit('page', popup);
      await fire(popup, { method: 'POST', url: origin + '/_api/accounts' });
      openerKnown();
      await handled;
    },
  };
  const { context, raw } = await runScenario([{ click: '#popup', settle: false }], actions);
  assert.equal(outcomeOf(context, origin + '/_api/accounts'), 'aborted');
  assert.deepEqual(raw.blockedWrites, [{ method: 'POST', path: '/_api/accounts' }]);
});

// Runs one captured write through the owned page's route and the context route, each answering with `error`. Each handler
// settles as 'fulfilled' or with the message of its rejection. `pageClosed` sets the owned page's closed state,
// and `contextClosed` emits the context's close event before either route is answered.
async function settleWriteRoutes(error, { pageClosed = false, contextClosed = false } = {}) {
  const settled = [];
  const actions = {
    '#write': async (page) => {
      page.closed = pageClosed;
      if (contextClosed) await page.context().emit('close');
      const request = {
        method: () => 'POST',
        url: () => origin + '/_api/accounts',
        headers: () => ({}),
        postData: () => null,
        resourceType: () => 'fetch',
        isNavigationRequest: () => false,
        frame: () => ({ parentFrame: () => null, page: () => page }),
        failure: () => ({ errorText: 'blockedbyclient' }),
      };
      const route = {
        request: () => request,
        fallback: () => Promise.reject(error),
        abort: () => Promise.reject(error),
      };
      for (const { handler } of [...page.routes, ...page.context().routes]) {
        settled.push(
          await handler(route).then(
            () => 'fulfilled',
            (failure) => failure.message,
          ),
        );
      }
    },
  };
  await runScenario([{ click: '#write', settle: false }], actions);
  return settled;
}

test('a guarded write whose page closed before the answer does not reject its route handler', async () => {
  const closed = new Error('route.abort: Target page, context or browser has been closed');
  assert.deepEqual(await settleWriteRoutes(closed, { pageClosed: true }), ['fulfilled', 'fulfilled']);
  assert.deepEqual(await settleWriteRoutes(new Error('boom'), { pageClosed: true }), ['fulfilled', 'fulfilled']);
});

test('a route failure on an open page rejects the guard whatever its text', async () => {
  const closed = new Error('route.abort: Target page, context or browser has been closed');
  assert.deepEqual(await settleWriteRoutes(new Error('boom'), { pageClosed: false }), ['boom', 'boom']);
  assert.deepEqual(await settleWriteRoutes(closed, { pageClosed: false }), [closed.message, closed.message]);
});

test('a guarded write answered after its context closed does not reject its route handler', async () => {
  const settled = await settleWriteRoutes(new Error('boom'), { pageClosed: false, contextClosed: true });
  assert.deepEqual(settled, ['fulfilled', 'fulfilled']);
});

// The page guard's outcome for a shared case: the owned page's request goes through the routes, and fire() reports it.
async function pageGuardOutcome(item) {
  let outcome;
  const actions = {
    '#request': async (page) => {
      outcome = await fire(page, item.request);
    },
  };
  await runScenario([{ click: '#request', settle: false }], actions, item.options);
  return outcome;
}

// The browser-level net's request shape: a navigation is a Document, anything else a Fetch.
const netRequest = ({ method, url, navigation, headers }) => ({
  method,
  url,
  headers,
  resourceType: navigation ? 'Document' : 'Fetch',
});

test('the page guard and the browser-level net decide every capture request the same way', async () => {
  for (const item of captureDecisionCases) {
    const { action } = captureNetDecision({ origin, ...item.options })(netRequest(item.request));
    assert.equal(action === 'block', item.block, `${item.name}: the browser-level net`);
    if (item.pageGuard === false) continue;
    const outcome = await pageGuardOutcome(item);
    assert.ok(outcome, `${item.name}: the page guard reached no decision`);
    assert.equal(outcome === 'aborted', item.block, `${item.name}: the page guard`);
  }
});
