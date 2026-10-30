// @test-kind contract: Lense X-ray and refresh never show a stale inspection report over a newer navigation
// Response ordering and history navigation.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { panelSession } from './helpers/panel-session.mjs';

// Routed entirely by page.route; nothing listens on this loopback port.
const origin = 'http://127.0.0.1:11111';
const LATE_REPORT_WINDOW_MS = 100;
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
const report = (name) => ({
  page: null,
  webTemplates: [],
  forms: [],
  views: [],
  columns: [],
  components: [],
  tables: [],
  unresolved: [],
  elementSources: [
    { name, selector: '#picked', tag: 'button', kind: 'template', matchKind: 'id', ref: name + '.html' },
  ],
});
async function fixture(t) {
  const { state, page } = await panelSession(t, browser, origin),
    pending = [],
    arrivals = new EventEmitter();
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).pathname === '/__paqvilo/api/inspect') {
      pending.push({ route, body: route.request().postDataJSON() });
      arrivals.emit('request');
      return;
    }
    if (route.request().resourceType() === 'document')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><button id="picked" style="margin-top:180px">Invented control</button>',
      });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(origin);
  state.ui = { open: true, tab: 'runtime' };
  state.inspection = { active: true, version: 1, path: '/', mode: 'live-sources', counts: {} };
  await page.evaluate(xrayUi, state);
  await page.evaluate(panelUi, state);
  const waitForRequest = async (count) => {
    while (pending.length < count) await once(arrivals, 'request');
    assert.equal(pending.length, count);
    return pending[count - 1];
  };
  const answer = async (index, version, name) => {
    await pending[index].route.fulfill({ json: { ok: true, version, report: report(name) } });
  };
  await waitForRequest(1);
  await answer(0, 1, 'Old source');
  await page.waitForFunction(() =>
    document
      .getElementById('paqvilo-xray')
      .__px.identify(document.getElementById('picked'))
      .evidence.source.refs.some((ref) => ref.name === 'Old source'),
  );
  await page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px;
    api.toggle(true);
    api.select(document.getElementById('picked'));
  });
  const identity = () =>
    page.evaluate(() =>
      document
        .getElementById('paqvilo-xray')
        .__px.identify(document.getElementById('picked'))
        .evidence.source.refs.map((ref) => ref.name),
    );
  const update = async (version, path) => {
    state.inspection = { ...state.inspection, version, path };
    await page.evaluate((path) => history.pushState(null, '', path), path);
    await page.evaluate(panelUi, state);
  };
  return { page, pending, waitForRequest, answer, identity, update };
}

test('X-ray clears an older report immediately during a delayed history navigation inspection', async (t) => {
  const { page, waitForRequest, answer, identity, update } = await fixture(t);
  await update(2, '/next/');
  await waitForRequest(2);
  assert.deepEqual(
    await identity(),
    [],
    'old source ownership cannot remain visible while a newer page report is pending',
  );
  assert.doesNotMatch(await page.locator('#paqvilo-xray .card').innerText(), /Old source/);
  await answer(1, 2, 'Current source');
  await page.waitForFunction(() =>
    document
      .getElementById('paqvilo-xray')
      .__px.identify(document.getElementById('picked'))
      .evidence.source.refs.some((ref) => ref.name === 'Current source'),
  );
});

test('a delayed manual refresh clears its old report and cannot overwrite a newer navigation response', async (t) => {
  const { page, waitForRequest, answer, identity, update } = await fixture(t);
  await page.locator('#paqvilo-xray [data-action=refresh]').click();
  const refresh = await waitForRequest(2);
  assert.equal(refresh.body.refresh, true);
  assert.deepEqual(await identity(), [], 'manual refresh also invalidates the old identity immediately');
  await update(3, '/latest/');
  await waitForRequest(3);
  await answer(2, 3, 'Latest source');
  await page.waitForFunction(() =>
    document
      .getElementById('paqvilo-xray')
      .__px.identify(document.getElementById('picked'))
      .evidence.source.refs.some((ref) => ref.name === 'Latest source'),
  );
  const obsolete = page.waitForResponse((response) => new URL(response.url()).pathname === '/__paqvilo/api/inspect');
  await answer(1, 2, 'Obsolete refresh');
  await obsolete;
  // A rejected late report leaves nothing to observe; allow its page handler one short window.
  await page.waitForTimeout(LATE_REPORT_WINDOW_MS);
  assert.deepEqual(await identity(), ['Latest source']);
  assert.doesNotMatch(await page.locator('#paqvilo-xray .card').innerText(), /Old source|Obsolete refresh/);
});
