// @test-kind contract: script-callsite provenance of an unchanged document survives the DevTools re-attach sequence Chromium reports while a cancelled navigation is answered (executionContextsCleared, then executionContextCreated for the same document), exercised with an invented page and script on a loopback server
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { isRegistryCall, scriptProvenancePage } from './helpers/script-provenance-page.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const source =
  'window.makeWidget=function(id){const node=document.createElement("button");node.id=id;document.body.append(node);};\n' +
  'makeWidget("created");\n';
const html = '<!doctype html><html><body><script src="/widget.js"></script></body></html>';

/**
 * The page and its attachment session. `reattach({ clears })` replays the sequence Chromium sends when it re-attaches
 * the tab's DevTools session on the unchanged document, as observed with the forced race of browser-attachment.test.mjs:
 * Runtime.executionContextsCleared, Runtime.executionContextCreated for the same context id, then Debugger.scriptParsed
 * again for every script of that context with its earlier script id. `clears: 2` clears twice before the context
 * returns. It resolves with the answer of the transport's claim of that document. `dropNext()` makes the next script-callsite notification reach no
 * listener, as Chromium drops one during a re-attach.
 */
async function reattachFixture(t) {
  let cdp,
    dropArmed = false;
  const claimWaiters = [],
    contexts = [],
    scripts = [],
    dropped = Promise.withResolvers();
  const fx = await scriptProvenancePage(t, browser, {
    html,
    source,
    onSession(session, transport) {
      cdp = session;
      const send = cdp.send.bind(cdp);
      cdp.send = async (method, params) => {
        const answer = await send(method, params);
        if (isRegistryCall(method, params, transport.domSlot))
          for (const resolve of claimWaiters.splice(0)) resolve(answer);
        return answer;
      };
      const emit = cdp.emit.bind(cdp);
      cdp.emit = (event, payload) => {
        if (dropArmed && event === 'Runtime.bindingCalled' && payload?.name?.startsWith('__paqviloDomEvent_')) {
          dropArmed = false;
          dropped.resolve(payload);
          return false;
        }
        return emit(event, payload);
      };
      cdp.on('Runtime.executionContextCreated', ({ context: execution }) => {
        if (execution.auxData?.isDefault && execution.origin === fx.origin) contexts.push(execution);
      });
      cdp.on('Debugger.scriptParsed', (event) => scripts.push(event));
    },
  });
  await fx.page.goto(fx.origin);
  assert.equal((await fx.verdict('created')).sourceRefs[0]?.relationship, 'created-by');
  const unchanged = contexts.at(-1);
  assert.ok(unchanged, 'the document reported its default context');
  return {
    ...fx,
    dropNext() {
      dropArmed = true;
      return dropped.promise;
    },
    reattach({ clears = 1 } = {}) {
      const claimed = new Promise((resolve) => claimWaiters.push(resolve));
      for (let clear = 0; clear < clears; clear++) cdp.emit('Runtime.executionContextsCleared', {});
      cdp.emit('Runtime.executionContextCreated', { context: unchanged });
      for (const event of scripts.filter(({ executionContextId }) => executionContextId === unchanged.id))
        cdp.emit('Debugger.scriptParsed', event);
      return claimed;
    },
  };
}

for (const dropped of [false, true])
  test(`an unchanged document re-reported after its execution contexts are cleared keeps proving script callsites${dropped ? ', including one whose notification was dropped' : ''}`, async (t) => {
    const fx = await reattachFixture(t);
    if (dropped) {
      const notification = fx.dropNext();
      await fx.page.evaluate(() => window.makeWidget('dropped'));
      await notification;
      assert.deepEqual((await fx.query('dropped')).availability, [{ reason: 'creation-proof-pending' }]);
    }
    assert.ok(
      (await fx.reattach({ clears: dropped ? 2 : 1 }))?.result?.objectId,
      'the transport claims the unchanged document again',
    );
    await fx.page.evaluate(() => window.makeWidget('after'));
    const packet = await fx.verdict('after');
    assert.equal(packet.sourceRefs[0]?.relationship, 'created-by', JSON.stringify(packet));
    assert.equal(packet.sourceRefs[0].ref, 'web-files/widget.js');
    if (dropped) {
      // The page resolves callsites in the order the transport received them, and the dropped one was received first.
      const recovered = await fx.query('dropped');
      assert.equal(recovered.sourceRefs[0]?.relationship, 'created-by', JSON.stringify(recovered));
      assert.equal(recovered.sourceRefs[0].ref, 'web-files/widget.js');
    }
  });

// @test-kind security: the re-claim after a re-attach reaches only the registry the bootstrap installed; a page that
// tried to replace the registry or its claim captures nothing
test('a page that tries to replace the registry or its claim cannot capture the re-claim', async (t) => {
  const fx = await reattachFixture(t);
  const replaced = await fx.page.evaluate((slot) => {
    'use strict';
    window.captured = [];
    const capture = (value) => window.captured.push(String(value));
    for (const attempt of [
      () => {
        window[slot].claim = capture;
      },
      () => Object.defineProperty(window, slot, { value: { claim: capture } }),
      () => {
        window[slot] = { claim: capture };
      },
      () => Object.defineProperty(window[slot], 'claim', { value: capture }),
      () => Object.defineProperty(Object.prototype, 'claim', { configurable: true, get: () => capture }),
      () => Object.defineProperty(Object.prototype, slot, { configurable: true, get: () => ({ claim: capture }) }),
    ])
      try {
        attempt();
      } catch {
        // A refused replacement is the expected outcome.
      }
    return window[slot].claim === capture;
  }, fx.transport.domSlot);
  assert.equal(replaced, false, 'the registry keeps its own claim');
  assert.ok((await fx.reattach())?.result?.objectId, 'the transport claims the registry the bootstrap installed');
  assert.deepEqual(await fx.page.evaluate(() => window.captured), []);
});

test('an authored debugger statement never pauses a page whose provenance uses the DevTools debugger', async (t) => {
  const fx = await scriptProvenancePage(t, browser, {
    html: '<!doctype html><html><body><script>debugger;window.afterDebugger=true;</script><script src="/widget.js"></script></body></html>',
    source,
  });
  await fx.page.goto(fx.origin);
  assert.equal((await fx.verdict('created')).sourceRefs[0]?.relationship, 'created-by');
  assert.equal(await fx.page.evaluate(() => window.afterDebugger), true);
  await fx.page.evaluate(() => {
    // eslint-disable-next-line no-debugger -- the authored statement under test
    debugger;
    window.makeWidget('after');
  });
  assert.equal((await fx.verdict('after')).sourceRefs[0]?.relationship, 'created-by');
});

test('a document restored from the back/forward cache keeps proving script callsites and is not reported', async (t) => {
  // Playwright disables the back/forward cache by default; an attached browser keeps it.
  const cached = await chromium.launch({
    ...browserLaunchOptions({ headless: true }),
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
  const reports = [],
    calls = [],
    waiters = [];
  const settle = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const fx = await scriptProvenancePage(t, cached, {
    html,
    source,
    onSession(cdp, transport) {
      const send = cdp.send.bind(cdp);
      cdp.send = async (method, params) => {
        const answer = await send(method, params);
        if (isRegistryCall(method, params, transport.domSlot) || isRegistryCall(method, params, transport.slot)) {
          calls.push(method);
          settle();
        }
        return answer;
      };
    },
    onError(error) {
      reports.push(error.message);
      settle();
    },
  });
  ownedFixture(t).add(() => cached.close());
  await fx.page.goto(fx.origin + '/first');
  assert.equal((await fx.verdict('created')).sourceRefs[0]?.relationship, 'created-by');
  await fx.page.evaluate(() => window.addEventListener('pageshow', (event) => (window.restored = event.persisted)));
  await fx.page.goto(fx.origin + '/second');
  await fx.verdict('created');
  const before = calls.length;
  // A restore fires no load event, so the test waits for the restored address instead of goBack's load.
  await fx.page.evaluate(() => history.back());
  await fx.page.waitForFunction(() => location.pathname === '/first');
  if ((await fx.page.evaluate(() => window.restored)) !== true) {
    // Playwright's Chromium build has no back/forward cache, also with the flag removed; Edge has one.
    t.skip('this browser did not restore the document from the back/forward cache');
    return;
  }
  // Both transports claim the first document again, unless one reports it instead.
  while (calls.length < before + 2 && !reports.length) await new Promise((resolve) => waiters.push(resolve));
  assert.deepEqual(reports, [], 'a restore is not a reused window');
  await fx.page.evaluate(() => window.makeWidget('later'));
  const later = await fx.verdict('later');
  assert.equal(later.sourceRefs[0]?.relationship, 'created-by', JSON.stringify(later));
  assert.equal(later.sourceRefs[0].ref, 'web-files/widget.js');
});
