// @test-kind contract: Paqvilo's own panel design: Overrides lists every request of the page by where it came from with counts that agree with its lists, and Inspect says how much of the page is identified, what it did not read and which controls have no source
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { panelSession } from './helpers/panel-session.mjs';

// Routed entirely by page.route; nothing listens on this loopback port.
const origin = 'http://127.0.0.1:11131';
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const PAGE =
  '<!doctype html><html><head><script src="/scripts/app.js"></script></head><body><main>' +
  '<img id="logo" src="/images/logo.png" style="width:10px;height:10px">' +
  '<input type="hidden" name="inv_name"><input id="inv_name_visible" name="inv_name">' +
  '<iframe id="frame" src="/frame"></iframe></main></body></html>';
const FRAME = '<!doctype html><body><input id="inv_frame_only"></body>';

const requests = (exportReason = 'out-of-scope') => ({
  total: 9,
  truncated: false,
  counts: { local: 1, document: 1, export: 2, 'portal-data': 1, 'platform-asset': 2, external: 1, unidentified: 1 },
  items: [
    {
      url: origin + '/scripts/app.js',
      method: 'GET',
      type: 'script',
      status: 200,
      class: 'local',
      rel: 'web-files/app.js',
      kind: 'web-file',
      count: 1,
    },
    { url: origin + '/', method: 'GET', type: 'document', status: 200, class: 'document', count: 1 },
    {
      url: origin + '/images/logo.png',
      method: 'GET',
      type: 'image',
      status: 200,
      class: 'export',
      rel: 'web-files/logo.png',
      kind: 'web-file',
      reason: exportReason,
      count: 1,
    },
    {
      url: origin + '/old.css',
      method: 'GET',
      type: 'stylesheet',
      status: 200,
      class: 'export',
      rel: 'web-files/old.css',
      kind: 'web-file',
      reason: exportReason === 'mirage' ? 'mirage' : 'paused',
      count: 1,
    },
    {
      url: origin + '/_api/inv_entries',
      method: 'GET',
      type: 'fetch',
      status: 200,
      class: 'portal-data',
      platform: 'web-api',
      count: 1,
    },
    {
      url: 'https://content.powerapps.com/resource/powerappsportal/dist/app.bundle-1a2b3c.js',
      method: 'GET',
      type: 'script',
      status: 200,
      class: 'platform-asset',
      platform: 'app.bundle.js',
      count: 2,
    },
    { url: 'https://cdn.invented.test', method: 'GET', type: 'font', status: 200, class: 'external', count: 1 },
    {
      url: origin + '/missing.js',
      method: 'GET',
      type: 'script',
      status: 404,
      class: 'unidentified',
      reason: 'not-found',
      count: 1,
    },
  ],
});

const report = {
  path: '/',
  page: { pageName: 'Invented home', url: '/', pageTemplateName: 'Invented layout' },
  assets: [{ url: '/images/logo.png', name: 'Logo', ref: 'web-files/logo.png', evidence: 'rendered-asset' }],
  renderedControls: [
    {
      tag: 'input',
      id: 'inv_name_visible',
      name: 'inv_name',
      field: 'inv_entry.inv_name',
      evidence: 'rendered-and-source',
    },
    { tag: 'input', name: 'inv_alone', evidence: 'rendered-unmapped', candidates: [] },
    {
      tag: 'input',
      name: 'inv_shared',
      evidence: 'rendered-unmapped',
      candidates: ['inv_a.inv_shared', 'inv_b.inv_shared'],
    },
    { tag: 'select', id: 'inv_frame_only', evidence: 'rendered-conflict', candidates: [] },
  ],
  elementSourceLimits: {
    truncated: true,
    renderedTruncated: true,
    markupOmittedSourceCount: 1,
    markupOmittedSources: ['web-templates/huge.html'],
  },
  // Two frames of the page were cross-origin or sandboxed (lense/source-inspection.mjs inspectRenderedPage).
  inputLimits: { inaccessibleFrames: 2 },
};

async function openPanel(t, { tab, extra = {} }) {
  const { state, page } = await panelSession(t, browser, origin);
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/__paqvilo/api/')) {
      const action = url.pathname.split('/').at(-1);
      return route.fulfill({ json: action === 'inspect' ? { ok: true, version: 1, report } : { ok: true } });
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
    return route.fulfill({ contentType: 'text/plain', body: '' });
  });
  await page.goto(origin + '/');
  await page.frameLocator('#frame').locator('#inv_frame_only').waitFor({ state: 'attached' });
  const runtime = { active: true, version: 1, mode: 'live-sources', status: { site: 'Invented site' } };
  Object.assign(state, { ui: { open: true, tab }, inspection: runtime, ...extra });
  await page.evaluate(xrayUi, { origin, token: state.token });
  await page.evaluate(panelUi, state);
  return { state, page, panel: (selector) => page.locator('#paqvilo-panel').locator(selector) };
}

/** Visible text and attributes that break the panel's wording rules (the rules of panel-text-lint.test.mjs). */
const lint = (page) =>
  page.evaluate(() => {
    const root = document.getElementById('paqvilo-panel').shadowRoot;
    const found = [];
    const code = /\b[a-z]+(?:-[a-z]+){2,}\b|\b[A-Z]+(?:_[A-Z]+)+\b|\b[a-z]+-[a-z]+:/;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data.trim();
      if (!text || !node.parentElement?.getClientRects().length || node.parentElement.closest('.path, style')) continue;
      if (code.test(text)) found.push(`text: ${text}`);
    }
    // A path's tooltip is the full path by design, and the selection's details are the evidence renderer's own.
    for (const element of root.querySelectorAll('[title]:not(.path):not([data-selected-identity] *)'))
      if (element.getAttribute('title').trim() === element.textContent.trim())
        found.push(`title repeats its text: ${element.outerHTML.slice(0, 160)}`);
    return found;
  });

const overrides = {
  items: [
    {
      group: 'js',
      kind: 'web-file',
      rel: 'web-files/app.js',
      url: '/scripts/app.js',
      differs: true,
      canDiff: true,
      canPause: true,
    },
  ],
  paused: [
    {
      group: 'paused',
      kind: 'web-file',
      rel: 'web-files/old.css',
      url: '/old.css',
      paused: true,
      canPause: true,
      edited: true,
    },
  ],
  notApplied: [
    {
      kind: 'page-js',
      group: 'not-applied',
      state: 'differs-not-applied',
      rel: 'web-pages/about/About.en-US.webpage.custom_javascript.js',
      differs: true,
      applied: false,
      reason: 'out-of-scope',
      canDiff: false,
      canPause: false,
      edited: false,
    },
  ],
  insync: [
    { kind: 'page-css', group: 'insync', rel: 'web-pages/home/Home.en-US.webpage.custom_css.css', differs: false },
  ],
  pausedElsewhere: 2,
  requests: requests(),
};

test('Overrides lists every request of the page by where it came from, and selects the element that loads one', async (t) => {
  const { page, panel } = await openPanel(t, { tab: 'overrides', extra: overrides });
  const summary = panel('[data-requests-summary]');
  await summary.waitFor();
  assert.equal(
    await summary.innerText(),
    '9 requests: 1 from your sources, 1 page, 2 in your sources, not laid over, 1 portal data, 2 portal runtime, 1 other site, 1 unidentified',
  );
  // Files of your sources that were not laid over are open, each with why; they open like every file row.
  const exported = panel('[data-group="requests-export"] .row');
  assert.equal(await exported.count(), 2);
  const logo = exported.filter({ hasText: 'logo' });
  assert.match(await logo.locator('.sub').last().innerText(), /not laid over: Local files is set to changed vs Git/);
  assert.equal(await logo.locator('button.main[data-act=open]').getAttribute('title'), 'Open logo.png in the editor');
  assert.equal(await logo.locator('[data-act=copy]').count(), 1);
  assert.match(await exported.filter({ hasText: 'old' }).innerText(), /not laid over: the override is paused/);
  assert.match(
    await panel('[data-group="requests-unidentified"] .row').innerText(),
    /missing\.js[\s\S]*HTTP 404 · not found/,
  );
  // The other classes are folded with their count; opening one shows its requests in words.
  const data = panel('[data-group="requests-portal-data"]');
  assert.equal(await data.locator('.row').count(), 0);
  await data.locator('[data-act=fold]').click();
  assert.match(await data.locator('.row').innerText(), /fetch · Web API · HTTP 200/);
  const runtime = panel('[data-group="requests-platform-asset"]');
  await runtime.locator('[data-act=fold]').click();
  assert.match(await runtime.locator('.row').innerText(), /2 requests[\s\S]*app\.bundle\.js/);
  assert.deepEqual(await lint(page), []);
  // The image that loads logo.png is on the page: its row selects it in X-ray, and Inspect shows the selection.
  const loader = logo.getByRole('button', { name: 'Select the element that loads logo.png' });
  await loader.click();
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').__px.selectedNode()?.id === 'logo');
  await panel('[data-selected-identity]').waitFor();
  assert.equal(await panel('[role=tab][aria-selected=true]').getAttribute('data-v'), 'runtime');
  // A file the page does not load from an element (a fetch) has no such button.
  await panel('[role=tab][data-v=overrides]').click();
  await panel('[data-group="requests-portal-data"] .row').waitFor();
  assert.equal(await panel('[data-group="requests-portal-data"] [data-act=select-loader]').count(), 0);
  // A script in the head is not rendered and is still selectable.
  await panel('[data-group="requests-local"] [data-act=fold]').click();
  await panel('[data-group="requests-local"] [data-act=select-loader]').click();
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').__px.selectedNode()?.localName === 'script');
});

test('the Overrides counts and filters agree with the lists, and blocks not applied say why', async (t) => {
  const { panel } = await openPanel(t, { tab: 'overrides', extra: overrides });
  const filters = panel('.filters [data-act=filter]');
  await filters.first().waitFor();
  assert.deepEqual(
    await filters.evaluateAll((nodes) => nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim())),
    ['All 4', 'Edited 1', 'Differs from deployed 2'],
  );
  const listed = () =>
    panel('.body .row[data-rel]:not([data-request])').evaluateAll((rows) =>
      rows
        .filter((row) => !row.closest('.group')?.querySelector('[data-id="page-files"]'))
        .map((row) => row.dataset.rel),
    );
  // Paused overrides and blocks the same as deployed are folded or open per group; open them all to count rows.
  for (const id of ['insync'])
    if ((await panel(`[data-act=fold][data-id="${id}"]`).getAttribute('aria-expanded')) === 'false')
      await panel(`[data-act=fold][data-id="${id}"]`).click();
  assert.equal((await listed()).length, 4);
  await filters.filter({ hasText: 'Differs' }).click();
  assert.deepEqual(await listed(), ['web-files/app.js', 'web-pages/about/About.en-US.webpage.custom_javascript.js']);
  await filters.filter({ hasText: 'Edited' }).click();
  assert.deepEqual(await listed(), ['web-files/old.css']);
  await filters.filter({ hasText: 'All' }).click();
  const notApplied = panel('.row[data-rel="web-pages/about/About.en-US.webpage.custom_javascript.js"]');
  assert.match(await notApplied.innerText(), /differs from deployed[\s\S]*not laid over: same as Git/);
  assert.match(await panel('[data-act=fold][data-id="not-applied"]').innerText(), /Differs from deployed, not applied/);
  assert.match(await panel('.body').innerText(), /2 more overrides are paused on other pages\./);
});

test('under Mirage, Overrides lists the page requests that Mirage served from your sources', async (t) => {
  const { page, panel } = await openPanel(t, {
    tab: 'overrides',
    extra: {
      mirageMode: true,
      items: [],
      paused: [],
      insync: [],
      notApplied: [],
      pausedElsewhere: 0,
      requests: requests('mirage'),
    },
  });
  await panel('[data-requests-summary]').waitFor();
  assert.match(await panel('.body .empty').innerText(), /Mirage renders this page from your sources/);
  assert.match(await panel('[data-requests-summary]').innerText(), /2 served by Mirage/);
  const served = panel('[data-group="requests-export"]');
  assert.match(await served.locator('[data-act=fold]').innerText(), /Served by Mirage/);
  assert.equal(await served.locator('.row').count(), 2);
  assert.match(await served.locator('.row').first().innerText(), /served by Mirage/);
  assert.deepEqual(await lint(page), []);
});

test('Inspect says how much of the page is identified, what it did not read and which controls have no source', async (t) => {
  const { page, panel } = await openPanel(t, { tab: 'runtime', extra: { requests: requests() } });
  const limits = panel('[data-inspection-limits]');
  await limits.waitFor();
  assert.match(
    await limits.innerText(),
    /^Not everything was read\. Only part of the page was read: it has more elements or controls than Inspect reads\. 2 frames could not be read: the browser keeps cross-origin and sandboxed frames closed to the page \(open a frame in its own tab to inspect it\)\. 1 source file too large to search was skipped: huge\.html\.$/,
  );
  // Identification runs only when asked.
  const card = panel('[data-identification]');
  assert.match(await card.innerText(), /Checks every element of this page \(about [\d,]+ elements\)/);
  await card.getByRole('button', { name: 'Check identification' }).click();
  const line = card.locator('[data-coverage-summary]');
  await line.waitFor();
  assert.match(
    await line.innerText(),
    /^[\d,]+ elements: [\d,]+ identified, [\d,]+ inside an identified element, [\d,]+ not identified(?:, [\d,]+ likely)?(?:, [\d,]+ in conflict)?$/,
  );
  const sample = card.locator('[data-coverage-sample]').first();
  const tag = await sample.locator('.name > span').first().innerText();
  await sample.getByRole('button', { name: new RegExp(`^Select ${tag} element 1 in X-ray$`) }).click();
  assert.equal(await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectedNode()?.localName), tag);
  // Rendered controls without a source are listed, each with why; several claims are a conflict.
  const unmatched = panel('[data-group="runtime-rendered-unmatched"] .row');
  assert.deepEqual(await unmatched.locator('.name > span:first-child').allInnerTexts(), [
    'inv_alone',
    'inv_shared',
    'inv_frame_only',
  ]);
  assert.deepEqual(await unmatched.locator('.c').allInnerTexts(), ['not found', 'conflict', 'conflict']);
  assert.match(await unmatched.nth(1).innerText(), /matches several columns: inv_a\.inv_shared, inv_b\.inv_shared/);
  assert.match(await unmatched.nth(2).innerText(), /the page address names more than one form/);
  // Locate finds the visible control, not the hidden input of the same name, and searches accessible frames.
  await panel('[data-group="runtime-rendered"] [data-act=inspect-locate]').click();
  assert.match(await page.locator('#inv_name_visible').evaluate((node) => node.style.outline), /solid 3px|3px solid/);
  assert.equal(await page.locator('input[type=hidden]').evaluate((node) => node.style.outline), '');
  await unmatched.nth(2).locator('[data-act=inspect-locate]').click();
  assert.match(
    await page
      .locator('#frame')
      .evaluate((frame) => frame.contentDocument.getElementById('inv_frame_only').style.outline),
    /solid 3px|3px solid/,
  );
  // A web file the page loads selects the element that loads it.
  await panel('[data-group="runtime-assets"]')
    .getByRole('button', { name: 'Select the element that loads Logo' })
    .click();
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').__px.selectedNode()?.id === 'logo');
  assert.deepEqual(await lint(page), []);
});
