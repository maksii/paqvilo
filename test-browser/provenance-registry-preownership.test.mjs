// @test-kind security: a page that owns a window before a same-origin document or its own content arrives cannot pose as a provenance registry: the transports send neither secret nor evidence to it, it obtains no writer, and the unverifiable registry is reported
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
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

// Defines a lookalike of both registries on a window the page owns before its document changes. Every lookalike
// method reports what it receives through the `inventedCaptured` binding. Returns the slot names the page found.
const preOwn = (mode) => {
  const names = Object.getOwnPropertyNames(window).filter((name) => /^__paqvilo(Dom|Portal)_/.test(name));
  const capture = (value) => window.inventedCaptured(JSON.stringify(value) ?? String(value));
  const writer = {};
  for (const method of ['resolve', 'resolveMany', 'markLimited', 'pendingCallsites', 'publish', 'retire', 'query'])
    writer[method] = (...args) => {
      capture({ method, args });
      return '';
    };
  const lookalike = (name) => ({
    claim(value) {
      capture({ name, claim: value });
      return writer;
    },
    release(value) {
      capture({ name, release: value });
      return true;
    },
    query() {
      return null;
    },
  });
  if (mode === 'popup') window.preOwned = window.open('');
  else {
    window.preOwnedFrame = document.createElement('iframe');
    document.body.append(window.preOwnedFrame);
    window.preOwned = window.preOwnedFrame.contentWindow;
  }
  for (const name of names)
    Object.defineProperty(window.preOwned, name, { value: lookalike(name), configurable: false, writable: false });
  if (mode === 'iframe-write') {
    window.preOwned.document.open();
    window.preOwned.document.write('<p id="written">Invented</p>');
    window.preOwned.document.close();
  }
  return names;
};

// Navigates the pre-owned window to a same-origin document.
const navigate = (mode) => {
  if (mode === 'popup') window.preOwned.location.href = location.origin + '/child';
  else window.preOwnedFrame.src = '/child';
};

for (const mode of ['iframe', 'iframe-write', 'popup'])
  test(`a page that pre-owns the registry slots through ${mode} captures nothing and obtains no writer`, async (t) => {
    const captured = [],
      reports = [],
      calls = [],
      waiters = [];
    const settle = () => {
      for (const waiter of waiters.splice(0)) waiter();
    };
    const until = async (condition) => {
      while (!condition()) await new Promise((resolve) => waiters.push(resolve));
    };
    const unverified = (kind) =>
      reports.some((message) =>
        message.includes(
          `a page script holds the place of the ${kind} provenance registry in a document, so provenance for that document is not recorded`,
        ),
      );
    const fx = await scriptProvenancePage(t, browser, {
      html,
      source,
      onSession(cdp, transport) {
        const send = cdp.send.bind(cdp);
        cdp.send = async (method, params) => {
          const answer = await send(method, params);
          if (isRegistryCall(method, params, transport.domSlot) || isRegistryCall(method, params, transport.slot)) {
            calls.push(params.arguments[0].value);
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
    await fx.context.exposeBinding('inventedCaptured', (_source, value) => {
      captured.push(value);
      settle();
    });
    await fx.page.goto(fx.origin);
    assert.equal((await fx.verdict('created')).sourceRefs[0]?.relationship, 'created-by');
    const popup = mode === 'popup' ? fx.page.waitForEvent('popup') : null;
    assert.equal((await fx.page.evaluate(preOwn, mode)).length, 2, 'the page found both registry slots');
    if (mode !== 'popup') {
      // The window's current document has a lookalike in both slots: neither transport claims it, both report it.
      await until(() => captured.length > 0 || (unverified('script') && unverified('page')));
      assert.deepEqual(captured, [], 'no lookalike received a secret');
      assert.equal(calls.length, 2, 'only the top document was claimed, once per registry');
    }
    if (mode === 'iframe') {
      await fx.page.evaluate(navigate, mode);
      // The same-origin document that replaces it is claimed through its own verified registries.
      await until(() => calls.length >= 4);
    } else if (mode === 'popup') {
      // Chromium keeps the Window of the popup's initial empty document for the same-origin document, which runs no
      // bootstrap. The next document of the popup is claimed through its own verified registries, after any command
      // the transports issued for the documents before it.
      const opened = await popup;
      await fx.page.evaluate(navigate, mode);
      await opened.waitForURL(fx.origin + '/child');
      await opened.goto(fx.origin + '/next');
      await until(() => calls.length >= 4);
    }
    assert.deepEqual(captured, [], 'no lookalike received a secret, a key, a proof or a descriptor');
    assert.equal(
      calls.every((value) => /^[a-f0-9]{64}$/.test(value)),
      true,
    );
  });
