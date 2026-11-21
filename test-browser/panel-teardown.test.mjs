// @test-kind contract: a removed dev panel leaves no timer, listener, hook or deferred navigation in the page
// The panel and X-ray as they run in a page, drawn by the test itself, with the dev loop's API answered by the test.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createFixture, SITE } from '../test/fixture.mjs';
import { fakeBrowser } from '../test/fake-browser.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { enablePanel, runSessionFlow } from '../lense/panel.mjs';
import { panelUi, removePanelUi } from '../lense/panel-ui.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';

const fx = createFixture();
// The invented portal: every address is the same page.
const server = http.createServer((request, response) =>
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><h1>Invented page</h1>'),
);
let browser, base, statePanel, ORIGIN;
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ORIGIN = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  // The state a real panel draws with; its browser is a fake, so nothing but the test draws into the page.
  statePanel = enablePanel(
    fakeBrowser().context,
    new OverlaySession({
      sourceDir: fx.dir,
      origin: ORIGIN,
      site: structuredClone(SITE),
      sourceMaps: false,
      siteName: 'invented',
      envName: 'local',
    }),
  );
  base = statePanel.stateFor({ url: () => ORIGIN + '/' });
});
after(async () => {
  await statePanel?.dispose();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fx.cleanup();
});

// Runs before the page's own scripts and before the panel exists. The test owns the due time of the panel's deferred
// navigations (the 2 s reload after a tweak, the 50 ms session flow step): it holds their callbacks and runs them itself.
function instrument() {
  const set = window.setTimeout.bind(window),
    clear = window.clearTimeout.bind(window),
    timers = new Map();
  let held = 0;
  window.setTimeout = (fn, delay = 0, ...args) => {
    if (typeof fn !== 'function') return set(fn, delay, ...args);
    if (delay === 2000 || delay === 50) {
      const id = 'held-' + ++held;
      timers.set(id, {
        delay,
        run() {
          timers.delete(id);
          fn(...args);
        },
      });
      return id;
    }
    const id = set(() => {
      timers.delete(id);
      fn(...args);
    }, delay);
    timers.set(id, { delay });
    return id;
  };
  window.clearTimeout = (id) => {
    timers.delete(id);
    if (typeof id === 'number') clear(id);
  };
  /** Delays of the timers that are armed now. */
  window.liveTimers = () => [...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b);
  /** Lets the due time of every held timer pass. */
  window.runHeldTimers = () => {
    for (const timer of [...timers.values()]) timer.run?.();
  };
  window.nativeAttachShadow = Element.prototype.attachShadow;
  const fetch = window.fetch.bind(window);
  window.apiCalls = [];
  window.fetch = (input, init) => {
    const name = /\/__paqvilo\/api\/([^/?]+)/.exec(String(input?.url ?? input))?.[1];
    if (name) window.apiCalls.push(name);
    return fetch(input, init);
  };
  window.xrayToggles = 0;
  document.addEventListener('paqvilo-xray', (event) => {
    if (event.detail?.action === 'toggled') window.xrayToggles++;
  });
  window.submitted = 0;
  HTMLFormElement.prototype.submit = () => void window.submitted++;
}

/** A page of the invented portal; `api(name, route)` may answer a dev loop request, else it gets `{ ok: true }`. */
async function portalPage(t, api = () => null) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(instrument);
  await context.route(ORIGIN + '/__paqvilo/api/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    const body = (await api(name, route)) ?? { ok: true };
    // The page may have aborted the request it no longer waits for.
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
  });
  const page = await context.newPage();
  await page.goto(ORIGIN + '/');
  return page;
}
const draw = async (page, state) => {
  await page.evaluate(xrayUi, state);
  await page.evaluate(panelUi, state);
};
const hookIsNative = (page) => page.evaluate(() => Element.prototype.attachShadow === window.nativeAttachShadow);
// The X-ray answers its shortcut synchronously inside the event dispatch, so one evaluation observes whether any does.
const xrayAnswersShortcut = (page) =>
  page.evaluate(() => {
    const before = window.xrayToggles;
    window.dispatchEvent(
      new KeyboardEvent('keydown', { altKey: true, shiftKey: true, code: 'KeyX', bubbles: true, cancelable: true }),
    );
    return window.xrayToggles - before;
  });
// A panel asks the dev loop to open a source inside the dispatch of the X-ray's request: the count is the live panels.
const panelsAnsweringXray = (page) =>
  page.evaluate(() => {
    const before = window.apiCalls.length;
    document.dispatchEvent(
      new CustomEvent('paqvilo-xray', { detail: { action: 'open', ref: 'web-files/invented.js' } }),
    );
    return window.apiCalls.slice(before);
  });

test('removing the panel clears the reload a tweak armed, and an answer that arrives afterwards arms nothing', async (t) => {
  const first = Promise.withResolvers(),
    late = { arrived: Promise.withResolvers(), release: Promise.withResolvers() };
  let permissionWrites = 0;
  t.after(() => late.release.resolve());
  const page = await portalPage(t, async (name) => {
    if (name === 'tweaks')
      return {
        ok: true,
        personas: [],
        presets: [],
        scenarios: [],
        tables: [],
        permissionMode: 'enforce',
        permissionSource: 'configured',
        session: { supported: false },
        personasAvailable: false,
      };
    if (name !== 'permissions') return null;
    if (++permissionWrites === 1) {
      first.resolve();
      return { ok: true };
    }
    late.arrived.resolve();
    await late.release.promise;
    return { ok: true };
  });
  const runtime = { active: true, version: 1, loading: false, mode: 'local-runtime', status: {} };
  const state = {
    ...base,
    token: 'tweak-session',
    mirageMode: true,
    mirage: runtime,
    inspection: runtime,
    ui: { open: true, tab: 'tweaks' },
  };
  await draw(page, state);
  const permissive = page.locator('#paqvilo-panel [data-act="permissions"][data-v="permissive"]');
  await permissive.click();
  await first.promise;
  // The answered tweak arms the fallback reload; its toast names it.
  await page
    .locator('#paqvilo-panel .toast')
    .getByText('Permissions permissive; reloading ...')
    .waitFor({ state: 'attached' });
  assert.ok((await page.evaluate(() => window.liveTimers())).includes(2000), 'the tweak armed its fallback reload');
  // A second write is still unanswered when the session stops.
  await permissive.click();
  await late.arrived.promise;
  await page.evaluate(removePanelUi, { token: state.token });
  // The removal aborts the unanswered request; its own 120 s guard is cleared once the page has handled that.
  await page.waitForFunction(() => !window.liveTimers().includes(120000));
  assert.deepEqual(
    await page.evaluate(() => window.liveTimers()),
    [],
    'the removed panel leaves no timer armed, neither the reload nor one for the aborted request',
  );
  late.release.resolve();
  // The due time of anything still held passes now; the page stays where it is.
  const href = await page.evaluate(() => {
    window.runHeldTimers();
    return location.href;
  });
  assert.equal(href, ORIGIN + '/');
  assert.equal(await page.locator('h1').innerText(), 'Invented page', 'the document was not replaced');
});

// Inspection on and off again: the X-ray then no longer observes the document, so it cannot notice its host leaving.
const offAgain = (page) =>
  page.evaluate(() => {
    const xray = document.getElementById('paqvilo-xray').__px;
    xray.toggle(true);
    xray.toggle(false);
  });
for (const [what, orphan] of [
  ['removed', () => document.getElementById('paqvilo-xray').remove()],
  ['replaced with the body', () => document.body.replaceWith(document.createElement('body'))],
])
  test(`removing the session restores attachShadow and silences an X-ray whose host the page ${what}`, async (t) => {
    const page = await portalPage(t);
    // The host leaves the document and the next draw creates the X-ray again; then the session stops.
    const redrawn = { ...base, token: 'redrawn-session' };
    await draw(page, redrawn);
    assert.equal(await hookIsNative(page), false, 'the X-ray watches new shadow roots');
    await offAgain(page);
    await page.evaluate(orphan);
    await draw(page, redrawn);
    await page.evaluate(removePanelUi, { token: redrawn.token });
    assert.equal(await hookIsNative(page), true, 'attachShadow is the native method again');
    assert.equal(await xrayAnswersShortcut(page), 0, 'no X-ray listener answers after the removal');

    // The host leaves the document and the session stops with no draw in between.
    const orphaned = { ...base, token: 'orphaned-session' };
    await draw(page, orphaned);
    await offAgain(page);
    await page.evaluate(orphan);
    await page.evaluate(removePanelUi, { token: orphaned.token });
    assert.equal(await hookIsNative(page), true, 'attachShadow is the native method again');
    assert.equal(await xrayAnswersShortcut(page), 0, 'no X-ray listener answers after the removal');
  });

test('removing the session silences a panel whose host the page removed', async (t) => {
  const page = await portalPage(t);
  const lose = () => page.evaluate(() => document.getElementById('paqvilo-panel').remove());
  // The host leaves the document and the next draw creates the panel again; then the session stops.
  const redrawn = { ...base, token: 'redrawn-session' };
  await draw(page, redrawn);
  await lose();
  await draw(page, redrawn);
  assert.deepEqual(await panelsAnsweringXray(page), ['open'], 'one panel is live after the redraw');
  assert.equal(await page.locator('#paqvilo-xray').count(), 1, 'the X-ray of the page stays with the new panel');
  await page.evaluate(removePanelUi, { token: redrawn.token });
  assert.deepEqual(await panelsAnsweringXray(page), [], 'no panel listener answers after the removal');

  // The host leaves the document and the session stops with no draw in between.
  const orphaned = { ...base, token: 'orphaned-session' };
  await draw(page, orphaned);
  await lose();
  await page.evaluate(removePanelUi, { token: orphaned.token });
  assert.deepEqual(await panelsAnsweringXray(page), [], 'no panel listener answers after the removal');
  assert.equal(await hookIsNative(page), true, 'its X-ray went with it');
  assert.deepEqual(await page.evaluate(() => window.liveTimers()), []);
});

test('a session flow whose session is removed before its deferred step neither submits nor navigates', async (t) => {
  const token = { asked: Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(() => token.release.resolve());
  const page = await portalPage(t);
  await page.route(ORIGIN + '/_layout/tokenhtml', async (route) => {
    token.asked.resolve();
    await token.release.promise;
    await route.fulfill({
      contentType: 'text/html',
      body: '<input name="__RequestVerificationToken" value="invented">',
    });
  });
  const flow = {
    logOff: null,
    token: '/_layout/tokenhtml',
    action: '/SignIn?ReturnUrl=%2F',
    fields: { contactId: 'a' },
  };
  const outcome = () =>
    page.evaluate(() => {
      window.runHeldTimers();
      return [window.submitted, location.hash];
    });

  // Sign-in: the session stops while the page still reads the antiforgery token.
  const signIn = page.evaluate(runSessionFlow, flow);
  await token.asked.promise;
  await page.evaluate(removePanelUi, { token: 'first-session' });
  token.release.resolve();
  assert.equal(await signIn, true);
  assert.deepEqual(await page.evaluate(() => window.liveTimers()), [50], 'the form submission is deferred');
  assert.deepEqual(await outcome(), [0, ''], 'the stopped session submits no sign-in form');

  // Sign-out: the session stops before the deferred navigation (a fragment here, so it would show at once).
  assert.equal(await page.evaluate(runSessionFlow, { navigate: '#signed-out' }), true);
  await page.evaluate(removePanelUi, { token: 'second-session' });
  assert.deepEqual(await outcome(), [0, ''], 'the stopped session does not navigate');

  // With its session still running, each flow completes.
  assert.equal(await page.evaluate(runSessionFlow, flow), true);
  assert.equal(await page.evaluate(runSessionFlow, { navigate: '#signed-out' }), true);
  assert.deepEqual(await outcome(), [1, '#signed-out']);
});
