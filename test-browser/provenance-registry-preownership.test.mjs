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

/**
 * The inspected page with what each transport sent to a registry (`calls`: the claim secrets), what the page's
 * lookalikes captured (`captured`) and the reported losses (`reports`). `until(condition)` waits for the next of these.
 */
async function observedPage(t, page = html) {
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
  const reported = (text) => reports.some((message) => message.includes(text));
  const fx = await scriptProvenancePage(t, browser, {
    html: page,
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
  return { ...fx, captured, reports, calls, until, reported };
}

for (const mode of ['iframe', 'iframe-write', 'popup'])
  test(`a page that pre-owns the registry slots through ${mode} captures nothing and obtains no writer`, async (t) => {
    const fx = await observedPage(t);
    const { captured, calls, until } = fx;
    const unverified = (kind) =>
      fx.reported(
        `a page script holds the place of the ${kind} provenance registry in a document, so provenance for that document is not recorded`,
      );
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

test("a document that takes over the window of its frame's initial empty document is reported and never claimed", async (t) => {
  const fx = await observedPage(t);
  // Touching the frame's window before its document commits gives the initial empty document its context, so Chromium
  // keeps that Window, with what the page put there, for the same-origin document.
  await fx.page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.src = '/child';
    document.body.append(frame);
    frame.contentWindow.inventedPreparedBeforeCommit = true;
  });
  const took = (kind) =>
    fx.reported(
      `a document took over the window of its frame's initial empty document, so its ${kind} provenance is not recorded`,
    );
  await fx.until(() => took('script') && took('page'));
  const child = fx.page.frames().find((frame) => frame !== fx.page.mainFrame());
  await child.waitForURL(fx.origin + '/child');
  assert.deepEqual(
    await child.evaluate(
      ({ dom, portal }) => ({
        prepared: window.inventedPreparedBeforeCommit,
        registries: [Object.hasOwn(window, dom), Object.hasOwn(window, portal)],
      }),
      { dom: fx.transport.domSlot, portal: fx.transport.slot },
    ),
    { prepared: true, registries: [false, false] },
    'the document kept the prepared window and has no registry',
  );
  assert.equal(fx.calls.length, 2, 'only the top document was claimed');
  assert.deepEqual(fx.captured, []);
});

const took = (fx, kind) =>
  fx.reported(
    `a document took over the window of its frame's initial empty document, so its ${kind} provenance is not recorded`,
  );
const child = '<!doctype html><html><body><p>Invented child</p></body></html>';
const markup = {
  static: '<iframe src="/child"></iframe><iframe src="/child"></iframe><iframe src="/child"></iframe>',
  named:
    '<iframe name="first" src="/child"></iframe><iframe name="second" src="/child"></iframe><iframe name="third" src="/child"></iframe>',
  id: '<iframe id="first" src="/child"></iframe><iframe id="second" src="/child"></iframe><iframe id="third" src="/child"></iframe>',
};

// Reading the page's global for the registry must not touch its frames' windows: a frame window materialized before the
// frame's document commits makes Chromium keep that window for the document, where no bootstrap runs.
for (const mode of ['static', 'named', 'id', 'script', 'popup'])
  test(`${mode} frames and popups whose first document loads directly are claimed through their own registries`, async (t) => {
    const frames = markup[mode] ? 3 : 1;
    const top = markup[mode]
      ? (path) => (path === '/child' ? child : html.replace('</body>', markup[mode] + '</body>'))
      : (path) => (path === '/child' ? child : html);
    const fx = await observedPage(t, top);
    const opened = mode === 'popup' ? fx.page.waitForEvent('popup') : null;
    if (mode === 'popup') await fx.page.evaluate(() => window.open('/child'));
    if (mode === 'script')
      await fx.page.evaluate(() => {
        const frame = document.createElement('iframe');
        frame.src = '/child';
        document.body.append(frame);
      });
    // Each document is claimed once per registry, unless a transport reports it instead.
    await fx.until(() => fx.calls.length >= 2 * (1 + frames) || fx.reports.length > 0);
    assert.deepEqual(fx.reports, [], 'no document took over a reused window');
    assert.equal(fx.calls.length, 2 * (1 + frames));
    const targets = opened ? [await opened] : fx.page.frames().filter((frame) => frame !== fx.page.mainFrame());
    for (const target of targets)
      assert.deepEqual(
        await target.evaluate(({ dom, portal }) => [Object.hasOwn(window, dom), Object.hasOwn(window, portal)], {
          dom: fx.transport.domSlot,
          portal: fx.transport.slot,
        }),
        [true, true],
      );
    assert.deepEqual(fx.captured, []);
  });

test('a touched frame without a target origin is not reported', async (t) => {
  const fx = await observedPage(t);
  // An about:srcdoc document is never instrumented, touched or not.
  await fx.page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<p>Invented srcdoc</p>';
    document.body.append(frame);
    frame.contentWindow.inventedTouched = true;
  });
  // A same-origin frame touched the same way afterwards is reported, once per registry.
  await fx.page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.src = '/child';
    document.body.append(frame);
    frame.contentWindow.inventedTouched = true;
  });
  await fx.until(() => took(fx, 'script') && took(fx, 'page'));
  assert.equal(fx.reports.length, 2, JSON.stringify(fx.reports));
});
