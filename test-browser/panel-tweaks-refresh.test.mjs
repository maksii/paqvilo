// A Tweaks refresh must not remove an open confirmation or move keyboard focus.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { panelSession } from './helpers/panel-session.mjs';

// Routed entirely by page.route; nothing listens on this loopback port.
const origin = 'http://127.0.0.1:11112';
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const tweaks = (permissionMode) => ({
  ok: true,
  permissionMode,
  personas: [],
  presets: [],
  tables: [],
  scenarios: [{ id: 'invented-scenario', name: 'Invented scenario' }],
});

test('a newer Mirage version refreshes Tweaks without removing an open confirmation or its focus', async (t) => {
  const { state, page } = await panelSession(t, browser, origin),
    pending = [],
    arrivals = new EventEmitter();
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).pathname === '/__paqvilo/api/tweaks') {
      pending.push(route);
      arrivals.emit('request');
      return;
    }
    if (route.request().resourceType() === 'document')
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main>Invented page</main>' });
    return route.fulfill({ json: { ok: true } });
  });
  const tweaksRequest = async (count) => {
    while (pending.length < count) await once(arrivals, 'request');
    return pending[count - 1];
  };
  const panel = (selector) => page.locator('#paqvilo-panel').locator(selector);

  await page.goto(origin);
  state.ui = { open: true, tab: 'tweaks' };
  state.mirageMode = true;
  state.mirage = { active: true, version: 1 };
  await page.evaluate(panelUi, state);
  await (await tweaksRequest(1)).fulfill({ json: tweaks('enforce') });
  await panel('[data-act="ask"][data-kind="scenario"]').click();
  const cancel = panel('[data-act="confirm-no"]');
  await cancel.waitFor();
  const cancelFocused = () => cancel.evaluate((node) => node.getRootNode().activeElement === node && node.isConnected);
  assert.equal(await cancelFocused(), true);

  // The runtime reports a newer version; its Tweaks request is held open by the route gate.
  state.mirage = { active: true, version: 2 };
  await page.evaluate(panelUi, state);
  const refresh = await tweaksRequest(2);
  await page.waitForFunction(
    () =>
      document.getElementById('paqvilo-panel').shadowRoot.querySelector('.body').getAttribute('aria-busy') === 'true',
  );
  assert.equal(await panel('[role="alertdialog"]').count(), 1, 'the confirmation stays while Tweaks refresh');
  assert.equal(await cancelFocused(), true, 'keyboard focus stays on the safe action during the refresh');

  await refresh.fulfill({ json: tweaks('permissive') });
  await panel('[data-act="permissions"][data-v="permissive"].on').waitFor();
  assert.equal(await panel('[role="alertdialog"]').count(), 1);
  assert.equal(await cancelFocused(), true, 'the refreshed render keeps focus on the same action');
});
