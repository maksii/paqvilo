import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { interceptOrigin, interceptOrigins } from '../lense/intercept.mjs';
import { fakeBrowser } from './fake-browser.mjs';

const ORIGIN = 'https://portal.example.com';
const URL = `${ORIGIN}/form`;
const pause = (tab, extra = {}, request = {}) =>
  tab.cdp.emit('Fetch.requestPaused', {
    requestId: 'paused',
    frameId: 'main',
    resourceType: 'Document',
    ...extra,
    request: { url: URL, method: 'POST', headers: {}, ...request },
  });

test('attachment setup runs before Fetch and disposes its own hooks on target release', async () => {
  const fake = fakeBrowser(),
    tab = fake.openTab();
  let cleaned = 0;
  const detach = await interceptOrigin(fake.context, ORIGIN, (route) => route.fallback(), {
    onAttach: async ({ cdp, configure, page }) => {
      assert.equal(page, tab.page);
      assert.equal(
        fake.sent.some(({ method }) => method === 'Fetch.enable'),
        false,
      );
      await configure('Page.addScriptToEvaluateOnNewDocument', { source: '/* owned test bootstrap */' });
      cdp.on('Runtime.executionContextCreated', () => {});
      return () => {
        cleaned++;
        cdp.removeAllListeners('Runtime.executionContextCreated');
      };
    },
  });
  await detach();
  await detach();
  assert.equal(cleaned, 1);
  assert.equal(tab.cdp.listenerCount('Runtime.executionContextCreated'), 0);
});

test('draft cancellation bindings are bounded and removed after normal or failed setup', async () => {
  for (const fail of [false, true]) {
    const fake = fakeBrowser(),
      tab = fake.openTab(),
      errors = [];
    const send = tab.cdp.send;
    tab.cdp.send = async (method, params) => {
      if (fail && method === 'Fetch.enable') throw new Error('fixture setup failure');
      const result = await send(method, params);
      return method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'owned-draft-script' } : result;
    };
    const opening = interceptOrigin(fake.context, ORIGIN, (route) => route.fallback(), {
      onError: (error) => errors.push(error),
    });
    if (fail) await assert.rejects(opening, /fixture setup failure/);
    else {
      const detach = await opening;
      const name = fake.sent.find((item) => item.method === 'Runtime.addBinding').name;
      tab.page.url = () => ORIGIN + '/form';
      tab.cdp.emit('Runtime.bindingCalled', { name, payload: 'cancelled' });
      tab.cdp.emit('Runtime.bindingCalled', { name, payload: 'cancelled' });
      assert.equal(errors.length, 1, 'one owned repair can emit at most one cancellation warning');
      assert.equal(errors[0].code, 'reload_required');
      await detach();
    }
    const name = fake.sent.find((item) => item.method === 'Runtime.addBinding').name;
    assert.equal(tab.cdp.listenerCount('Runtime.bindingCalled'), 0);
    assert.ok(fake.sent.some((item) => item.method === 'Runtime.removeBinding' && item.name === name));
    assert.ok(
      fake.sent.some(
        (item) =>
          item.method === 'Page.removeScriptToEvaluateOnNewDocument' && item.identifier === 'owned-draft-script',
      ),
    );
  }
});

test('only acknowledged fulfillments publish a proof; cancellation and protocol rejection never publish', async () => {
  for (const outcome of ['acknowledged', 'rejected', 'aborted']) {
    const fake = fakeBrowser(),
      tab = fake.openTab(),
      published = [];
    const nativeSend = tab.cdp.send;
    tab.cdp.send = (method, params) =>
      method === 'Fetch.fulfillRequest' && outcome === 'rejected'
        ? Promise.reject(new Error('Invented navigation cancellation'))
        : nativeSend(method, params);
    const acknowledgments = [];
    const detach = await interceptOrigin(
      fake.context,
      ORIGIN,
      async (route) => {
        if (outcome === 'aborted') await route.abort();
        acknowledgments.push(await route.fulfill({ body: '<p>Invented</p>', provenance: { proofId: 'invented' } }));
      },
      { onAttach: () => ({ publishProvenance: (_event, proof) => published.push(proof) }) },
    );
    pause(tab);
    await setImmediate();
    assert.deepEqual(acknowledgments, [outcome === 'acknowledged']);
    assert.equal(published.length, outcome === 'acknowledged' ? 1 : 0);
    await detach();
  }
});

test('page ownership is admitted before attaching CDP or changing cache and CSP', async () => {
  const b = fakeBrowser(),
    user = b.openTab(`${ORIGIN}/existing`),
    owned = b.openTab();
  let attachments = 0;
  const attach = b.context.newCDPSession;
  b.context.newCDPSession = async (page) => {
    attachments++;
    assert.equal(page, owned.page);
    return attach(page);
  };
  const dispose = await interceptOrigin(b.context, ORIGIN, async (route) => route.fallback(), {
    ownsPage: (page) => page === owned.page,
    bypassCSP: true,
  });
  b.context.emit('page', b.openTab(`${ORIGIN}/user-popup`).page);
  b.context.emit('page', user.page);
  await setImmediate();
  assert.equal(attachments, 1);
  assert.equal(user.cdp.listenerCount('Fetch.requestPaused'), 0);
  assert.equal(
    b.sent.filter((command) => command.method === 'Network.setCacheDisabled' && command.cacheDisabled).length,
    1,
  );
  assert.equal(
    b.sent.filter((command) => command.method === 'Network.setBypassServiceWorker' && command.bypass).length,
    1,
  );
  await dispose();
  assert.equal(owned.cdp.listenerCount('Fetch.requestPaused'), 0);
  assert.equal(b.context.listenerCount('page'), 0);
  assert.equal(
    b.sent.filter((command) => command.method === 'Network.setBypassServiceWorker' && command.bypass === false).length,
    1,
  );
});

test('all configured origins share one interceptor and foreign origins pass through', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  const other = 'https://second.example.com';
  const seen = [];
  const dispose = await interceptOrigins(b.context, [ORIGIN, other, `${ORIGIN}/`], async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ body: 'local' });
  });
  try {
    const enabled = b.sent.filter((s) => s.method === 'Fetch.enable');
    assert.equal(enabled.length, 1);
    assert.deepEqual(enabled[0].patterns, [{ urlPattern: `${ORIGIN}/*` }, { urlPattern: `${other}/*` }]);
    for (const [i, url] of [`${ORIGIN}/first`, `${other}/second`, `${other}.foreign.example/third`].entries()) {
      pause(tab, { requestId: `multi-${i}` }, { url, method: 'GET' });
      await setImmediate();
    }
    assert.deepEqual(seen, [`${ORIGIN}/first`, `${other}/second`]);
    assert.equal(b.answers('multi-0')[0].method, 'Fetch.fulfillRequest');
    assert.equal(b.answers('multi-1')[0].method, 'Fetch.fulfillRequest');
    assert.equal(b.answers('multi-2')[0].method, 'Fetch.continueRequest');
  } finally {
    await dispose();
  }
  assert.equal(b.sent.filter((s) => s.method === 'Fetch.disable').length, 1);
});

test('interception and popup reload require the exact origin', async () => {
  const b = fakeBrowser();
  const tab = b.openTab(`${ORIGIN}.other.example/form`);
  let handled = 0;
  await interceptOrigin(b.context, `${ORIGIN}/`, async () => handled++);
  assert.equal(tab.page.reloads, 0);
  pause(tab, {}, { url: `${ORIGIN}.other.example/form` });
  await setImmediate();
  assert.equal(handled, 0);
  assert.equal(b.answers('paused')[0].method, 'Fetch.continueRequest');
});

test('a page announced twice gets one interception session', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, async () => {});
  b.context.emit('page', tab.page);
  await setImmediate();
  assert.equal(b.sent.filter((s) => s.method === 'Fetch.enable').length, 1);
});

test('binary postDataEntries are replayed without UTF-8 corruption', async () => {
  const b = fakeBrowser({ [URL]: { body: 'done' } });
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, async (route) => route.fulfill({ response: await route.fetch() }));
  const bytes = Buffer.from([0xff, 0x00, 0x80, 0x31]);
  pause(
    tab,
    {},
    {
      hasPostData: true,
      postData: 'incorrect text',
      postDataEntries: [
        { bytes: bytes.subarray(0, 2).toString('base64') },
        { bytes: bytes.subarray(2).toString('base64') },
      ],
    },
  );
  await setImmediate();
  assert.deepEqual(b.fetched[0].data, bytes);
});

test('an omitted body is fetched with the Network request ID', async () => {
  const b = fakeBrowser({ [URL]: { body: 'done' } });
  const tab = b.openTab();
  const send = tab.cdp.send;
  tab.cdp.send = async (method, params) => {
    if (method === 'Network.getRequestPostData') {
      assert.equal(params.requestId, 'network-id');
      return { postData: 'a=1&b=2' };
    }
    return send(method, params);
  };
  await interceptOrigin(b.context, ORIGIN, async (route) => route.fulfill({ response: await route.fetch() }));
  pause(tab, { networkId: 'network-id' }, { hasPostData: true });
  await setImmediate();
  assert.equal(b.fetched[0].data, 'a=1&b=2');
});

test('an unavailable body never causes an empty replay', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, async (route) => route.fetch());
  pause(tab, {}, { hasPostData: true });
  await setImmediate();
  assert.equal(b.fetched.length, 0);
  assert.equal(b.answers('paused')[0].method, 'Fetch.continueRequest');
});

test('a handler failure after a POST was sent cannot repeat the POST', async () => {
  const b = fakeBrowser({ [URL]: { body: 'saved' } });
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, async (route) => {
    await route.fetch();
    throw new Error('rewrite failed');
  });
  pause(tab);
  await setImmediate();
  assert.equal(b.fetched.length, 1);
  assert.deepEqual(
    b.answers('paused').map((s) => s.method),
    ['Fetch.failRequest'],
  );
});

test('a paused request receives only one terminal answer', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  await interceptOrigin(b.context, ORIGIN, async (route) => {
    await route.fulfill({ body: 'done' });
    await route.fallback();
    await route.abort();
  });
  pause(tab);
  await setImmediate();
  assert.deepEqual(
    b.answers('paused').map((s) => s.method),
    ['Fetch.fulfillRequest'],
  );
});

test('edited responses remove stale body validators, apply overrides, and release API response memory', async () => {
  const b = fakeBrowser({
    [URL]: {
      headers: {
        'content-type': 'text/plain',
        'Content-Encoding': 'gzip',
        'Content-Length': '100',
        etag: 'old',
        digest: 'old',
        'cache-control': 'public, max-age=86400',
      },
      body: 'old',
    },
  });
  const tab = b.openTab();
  let disposed = 0;
  const fetch = b.context.request.fetch;
  b.context.request.fetch = async (...args) => ({ ...(await fetch(...args)), dispose: async () => disposed++ });
  await interceptOrigin(b.context, ORIGIN, async (route) =>
    route.fulfill({
      response: await route.fetch(),
      status: 201,
      headers: { 'Content-Type': 'text/html', 'Content-Length': '999' },
      body: 'new body',
    }),
  );
  pause(tab);
  await setImmediate();
  const [answer] = b.answers('paused');
  const headers = Object.fromEntries(answer.responseHeaders.map((h) => [h.name.toLowerCase(), h.value]));
  assert.equal(answer.responseCode, 201);
  assert.equal(headers['content-type'], 'text/html');
  assert.equal(headers['content-length'], '8');
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers.etag, undefined);
  assert.equal(headers.digest, undefined);
  assert.equal(headers['content-encoding'], undefined);
  assert.equal(disposed, 1);
});

test('responses that forbid bodies never replay payload bytes', async () => {
  for (const status of [204, 205, 304]) {
    const b = fakeBrowser();
    const tab = b.openTab();
    await interceptOrigin(b.context, ORIGIN, async (route) => route.fulfill({ status, body: 'must not be sent' }));
    pause(tab);
    await setImmediate();
    assert.equal(b.answers('paused')[0].body, '');
    assert.ok(!b.answers('paused')[0].responseHeaders.some((h) => h.name.toLowerCase() === 'content-length'));
  }
});

test('disposing an overlay restores browser cache and CSP and stops new attachments', async () => {
  const b = fakeBrowser();
  b.openTab();
  const dispose = await interceptOrigin(b.context, ORIGIN, async () => {}, { bypassCSP: true });
  assert.ok(b.sent.some((s) => s.method === 'Page.setBypassCSP' && s.enabled));
  await dispose();
  assert.ok(b.sent.some((s) => s.method === 'Page.setBypassCSP' && s.enabled === false));
  assert.ok(b.sent.some((s) => s.method === 'Network.setCacheDisabled' && s.cacheDisabled === false));
  assert.ok(b.sent.some((s) => s.method === 'Network.setBypassServiceWorker' && s.bypass === false));
  assert.ok(b.sent.some((s) => s.method === 'Fetch.disable'));
  b.context.emit('page', b.openTab().page);
  await setImmediate();
  assert.equal(b.sent.filter((s) => s.method === 'Fetch.enable').length, 1);
});

test('a DevTools command that never answers cannot hold the release open, and is named', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const b = fakeBrowser();
  const tab = b.openTab();
  const answer = tab.cdp.send;
  tab.cdp.send = (method, params) =>
    method === 'Fetch.disable' ? (b.sent.push({ method }), new Promise(() => {})) : answer(method, params);
  const errors = [];
  const dispose = await interceptOrigin(b.context, ORIGIN, async () => {}, {
    onError: (error) => errors.push(error.message),
  });
  let released = false;
  const disposal = dispose().then(() => {
    released = true;
  });
  for (let i = 0; i < 20 && !released; i++) {
    await setImmediate();
    t.mock.timers.tick(5_000);
  }
  await disposal;
  assert.deepEqual(errors, ['Releasing development interception: Fetch.disable did not answer within 5000 ms']);
  // the remaining restore steps still ran after the unanswered command
  assert.ok(b.sent.some((s) => s.method === 'Network.setCacheDisabled' && s.cacheDisabled === false));
});

test('interception setup fails, instead of waiting forever, when a DevTools command never answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const b = fakeBrowser();
  const tab = b.openTab();
  const answer = tab.cdp.send;
  tab.cdp.send = (method, params) => (method === 'Fetch.enable' ? new Promise(() => {}) : answer(method, params));
  let outcome;
  const ready = interceptOrigin(b.context, ORIGIN, async () => {}, { onError: () => {} }).then(
    () => {
      outcome = 'ready';
    },
    (error) => {
      outcome = error.message;
    },
  );
  for (let i = 0; i < 20 && !outcome; i++) {
    await setImmediate();
    t.mock.timers.tick(5_000);
  }
  await ready;
  assert.match(outcome, /Could not enable development interception: Fetch\.enable did not answer within 10000 ms/);
});

test('CSP is preserved unless bypass is explicitly requested', async () => {
  const b = fakeBrowser();
  b.openTab();
  const dispose = await interceptOrigin(b.context, ORIGIN, async () => {});
  await dispose();
  assert.ok(!b.sent.some((s) => s.method === 'Page.setBypassCSP'));
});

test('disposing while a POST is fetched aborts the original before interception is disabled', async () => {
  const b = fakeBrowser({ [URL]: { body: 'saved' } });
  const tab = b.openTab();
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const dispose = await interceptOrigin(b.context, ORIGIN, async (route) => {
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response });
  });
  pause(tab);
  await setImmediate();
  await dispose();
  finish();
  await setImmediate();
  assert.deepEqual(
    b.answers('paused').map((s) => s.method),
    ['Fetch.failRequest'],
  );
  assert.ok(
    b.sent.findIndex((s) => s.method === 'Fetch.failRequest') < b.sent.findIndex((s) => s.method === 'Fetch.disable'),
  );
});

test('an API response arriving after shutdown is released without answering twice', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  let finish;
  let disposed = 0;
  b.context.request.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const dispose = await interceptOrigin(b.context, ORIGIN, async (route) =>
    route.fulfill({ response: await route.fetch() }),
  );
  pause(tab);
  await setImmediate();
  await dispose();
  finish({
    dispose: async () => {
      disposed++;
    },
    body: () => {
      throw new Error('must not read a stopped response');
    },
  });
  await setImmediate();
  assert.equal(disposed, 1);
  assert.deepEqual(
    b.answers('paused').map((s) => s.method),
    ['Fetch.failRequest'],
  );
});

test('shutdown before replay starts never sends an API request', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  let continueHandler;
  const pending = new Promise((resolve) => {
    continueHandler = resolve;
  });
  const dispose = await interceptOrigin(b.context, ORIGIN, async (route) => {
    await pending;
    await route.fetch();
  });
  pause(tab);
  await setImmediate();
  await dispose();
  continueHandler();
  await setImmediate();
  assert.equal(b.fetched.length, 0);
  assert.deepEqual(
    b.answers('paused').map((s) => s.method),
    ['Fetch.failRequest'],
  );
});

test('closing tabs immediately releases their interception listeners and CDP sessions', async () => {
  const b = fakeBrowser();
  const tabs = Array.from({ length: 50 }, () => b.openTab());
  let detached = 0;
  tabs.forEach((tab) => {
    tab.cdp.detach = async () => {
      detached++;
    };
  });
  const dispose = await interceptOrigin(b.context, ORIGIN, async () => {});
  tabs.forEach((tab) => tab.page.emit('close'));
  await setImmediate();
  assert.equal(detached, 50);
  assert.ok(tabs.every((tab) => tab.cdp.listenerCount('Fetch.requestPaused') === 0));
  assert.ok(tabs.every((tab) => tab.page.listenerCount('domcontentloaded') === 0));
  const restored = b.sent.filter((command) => command.method === 'Fetch.disable').length;
  await Promise.all([dispose(), dispose()]);
  assert.equal(b.sent.filter((command) => command.method === 'Fetch.disable').length, restored);
  assert.equal(detached, 50);
});

test('failed interception setup rejects readiness, restores settings and detaches', async () => {
  const b = fakeBrowser();
  const tab = b.openTab();
  const send = tab.cdp.send;
  let detached = 0;
  tab.cdp.detach = async () => {
    detached++;
  };
  tab.cdp.send = async (method, params) => {
    if (method === 'Fetch.enable') throw new Error('target setup failed');
    return send(method, params);
  };
  await assert.rejects(
    interceptOrigin(b.context, ORIGIN, async () => {}, { bypassCSP: true }),
    /Could not enable development interception: target setup failed/,
  );
  assert.equal(detached, 1);
  assert.equal(tab.cdp.listenerCount('Fetch.requestPaused'), 0);
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.ok(b.sent.some((command) => command.method === 'Page.setBypassCSP' && command.enabled === false));
  assert.equal(b.context.listenerCount('page'), 0);
});

test('a live tab CDP attachment failure rejects readiness and removes the page listener', async () => {
  const b = fakeBrowser();
  b.openTab();
  b.context.newCDPSession = async () => {
    throw new Error('CDP unavailable');
  };
  await assert.rejects(
    interceptOrigins(b.context, [ORIGIN], async () => {}),
    /Could not attach development interception: CDP unavailable/,
  );
  assert.equal(b.context.listenerCount('page'), 0);
});

test('one failed initial tab releases all concurrent multi-origin attachments', async () => {
  const b = fakeBrowser();
  const tabs = [b.openTab(), b.openTab(), b.openTab()];
  const detached = new Set();
  tabs.forEach((tab) => {
    tab.cdp.detach = async () => detached.add(tab);
  });
  const send = tabs[1].cdp.send;
  tabs[1].cdp.send = async (method, params) => {
    if (method === 'Fetch.enable') throw new Error('one tab failed');
    return send(method, params);
  };
  await assert.rejects(
    interceptOrigins(b.context, [ORIGIN, 'https://second.example.com'], async () => {}),
    /one tab failed/,
  );
  assert.equal(detached.size, tabs.length);
  assert.equal(b.context.listenerCount('page'), 0);
  for (const tab of tabs) {
    assert.equal(tab.cdp.listenerCount('Fetch.requestPaused'), 0);
    assert.equal(tab.page.listenerCount('close'), 0);
    assert.equal(tab.page.listenerCount('domcontentloaded'), 0);
  }
});

test('later tab failures call onError through the single-origin wrapper without leaking listeners', async () => {
  const b = fakeBrowser();
  b.openTab();
  let reported;
  const errorReported = new Promise((resolve) => {
    reported = resolve;
  });
  const dispose = await interceptOrigin(b.context, ORIGIN, async () => {}, {
    onError: (error) => {
      reported(error);
      throw new Error('reporting callback failed');
    },
  });
  const tab = b.openTab();
  const send = tab.cdp.send;
  let detached = 0;
  tab.cdp.detach = async () => {
    detached++;
  };
  tab.cdp.send = async (method, params) => {
    if (method === 'Fetch.enable') throw new Error('later tab failed');
    return send(method, params);
  };
  b.context.emit('page', tab.page);
  assert.match((await errorReported).message, /later tab failed/);
  await setImmediate();
  assert.equal(detached, 1);
  assert.equal(tab.cdp.listenerCount('Fetch.requestPaused'), 0);
  assert.equal(tab.page.listenerCount('close'), 0);
  await dispose();
  assert.equal(b.context.listenerCount('page'), 0);
});

test('tab closure during attachment or setup stays a harmless race', async () => {
  for (const phase of ['attach', 'configure']) {
    const b = fakeBrowser();
    const tab = b.openTab();
    let closed = false;
    tab.page.isClosed = () => closed;
    if (phase === 'attach')
      b.context.newCDPSession = async () => {
        closed = true;
        throw new Error('page closed');
      };
    else {
      const send = tab.cdp.send;
      tab.cdp.send = async (method, params) => {
        if (method === 'Fetch.enable') {
          closed = true;
          throw new Error('page closed');
        }
        return send(method, params);
      };
    }
    const dispose = await interceptOrigins(b.context, [ORIGIN], async () => {}, {
      onError: () => assert.fail('closed pages must not report setup errors'),
    });
    assert.equal(tab.cdp.listenerCount('Fetch.requestPaused'), 0);
    assert.equal(tab.page.listenerCount('close'), 0);
    await dispose();
    assert.equal(b.context.listenerCount('page'), 0);
  }
});

test('a later frame-tree timeout is target-scoped and healthy draft tabs retain interception and retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const b = fakeBrowser(),
    healthy = [b.openTab(), b.openTab()];
  healthy.forEach((tab, index) => {
    tab.page.draft = `unsaved ${index}`;
  });
  const errors = [],
    failed = [];
  const dispose = await interceptOrigins(b.context, [ORIGIN], (route) => route.fulfill({ body: 'overlaid' }), {
    onError: (error) => errors.push(error),
    onTargetError: (error, page) => {
      failed.push({ error, page });
    },
  });
  const broken = b.openTab();
  const send = broken.cdp.send;
  broken.cdp.send = (method, params) => (method === 'Page.getFrameTree' ? new Promise(() => {}) : send(method, params));
  b.context.emit('page', broken.page);
  for (let i = 0; i < 10 && !failed.length; i++) {
    await setImmediate();
    t.mock.timers.tick(10000);
  }
  await setImmediate();
  assert.equal(errors.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].page, broken.page);
  assert.equal(failed[0].error.scope, 'target');
  assert.equal(failed[0].error.phase, 'Page.getFrameTree');
  assert.equal(broken.cdp.listenerCount('Fetch.requestPaused'), 0);
  for (const [index, tab] of healthy.entries()) {
    assert.equal(tab.page.draft, `unsaved ${index}`);
    tab.pause(`healthy-${index}`, URL);
  }
  const retry = b.openTab();
  b.context.emit('page', retry.page);
  await setImmediate();
  retry.pause('retry', URL);
  await setImmediate();
  for (const id of ['healthy-0', 'healthy-1', 'retry']) assert.equal(b.answers(id)[0].method, 'Fetch.fulfillRequest');
  assert.equal(b.fetched.length, 0);
  await dispose();
});

test('inspecting and fulfilling an unchanged response obtains its bytes only once', async () => {
  const b = fakeBrowser({ [URL]: { body: 'original document' } });
  const tab = b.openTab();
  const fetch = b.context.request.fetch;
  let bodyReads = 0;
  b.context.request.fetch = async (...args) => {
    const response = await fetch(...args);
    return {
      ...response,
      body: async () => {
        bodyReads++;
        return response.body();
      },
    };
  };
  await interceptOrigin(b.context, ORIGIN, async (route) => {
    const response = await route.fetch();
    assert.equal(await response.text(), 'original document');
    assert.equal(await response.text(), 'original document');
    await route.fulfill({ response });
  });
  pause(tab);
  await setImmediate();
  assert.equal(bodyReads, 1);
  assert.equal(Buffer.from(b.answers('paused')[0].body, 'base64').toString(), 'original document');
});

test('bodyless responses never request an API response body', async () => {
  for (const [method, status] of [
    ['HEAD', 200],
    ['GET', 204],
    ['GET', 205],
    ['GET', 304],
  ]) {
    const b = fakeBrowser();
    const tab = b.openTab();
    let bodyReads = 0;
    const response = {
      status: () => status,
      headersArray: () => [],
      body: async () => {
        bodyReads++;
        throw new Error('body must not be loaded');
      },
    };
    await interceptOrigin(b.context, ORIGIN, (route) => route.fulfill({ response }));
    pause(tab, {}, { method });
    await setImmediate();
    assert.equal(bodyReads, 0);
    assert.equal(b.answers('paused')[0].method, 'Fetch.fulfillRequest');
    assert.equal(b.answers('paused')[0].body, '');
  }
});
