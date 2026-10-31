// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// The /_sim/ Activity workspace (view-activity.mjs) over the real end-to-end scenario (test/support/trace-scenario.mjs) on
// the Power Pages host: a member's create, a REJECTED create, a page render and a stranger's refused read, each its own
// activity. A developer finds the failed request, reads Why, the steps, its log lines and findings, the rendered
// templates with their source files, and exports the bundle; old #trace / #audit / #logs / #evidence links land on the
// matching Activity content; Escape, Enter, `/` and arrows work; 1,000 retained activities render one page; the phone
// width never scrolls sideways; dark and light follow the system theme.
// PAQVILO_ACTIVITY_SCREENSHOTS=<folder> also saves light, dark and 390 px screenshots (evidence runs only).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { measureView } from './readability.mjs';
import { endedTree, REJECTED, runTraceScenario, STRANGER } from '../test/support/trace-scenario.mjs';

const SHOTS = process.env.PAQVILO_ACTIVITY_SCREENSHOTS;
let browser, run, reject, render, refusal;
before(async () => {
  run = await runTraceScenario({ level: 'full' });
  const { sim, member, stranger, orderId } = run;
  // Each request below is its own activity (no join headers).
  const rejected = await fetch(`${sim.url}/_api/x_orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: member, __requestverificationtoken: sim.csrf },
    body: JSON.stringify({ x_name: `Order ${REJECTED}` }),
  });
  await rejected.text();
  reject = { status: rejected.status, traceId: rejected.headers.get('x-trace-id') };
  const page = await fetch(`${sim.url}/order/?id=${orderId}`, { headers: { cookie: member } });
  await page.text();
  render = { traceId: page.headers.get('x-trace-id') };
  const read = await fetch(`${sim.url}/_api/x_orders(${orderId})`, { headers: { cookie: stranger } });
  await read.text();
  refusal = { status: read.status, traceId: read.headers.get('x-trace-id') };
  await sim.settle();
  for (const id of [reject.traceId, render.traceId, refusal.traceId]) await endedTree(sim.trace, id);
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(async () => {
  await browser?.close();
  await run?.close();
});

/** A new page at `viewport` in `colorScheme`; page errors are collected. */
async function pageOf(t, { width = 1440, height = 1000, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { page, errors };
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) : null);
const inView = (locator) =>
  locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.top < innerHeight && box.bottom > 0;
  });
// How far the view's own content reaches past the viewport (the shell's top bar is measured by the shell's tests).
const sideways = (page) =>
  page.evaluate(() =>
    Math.max(
      0,
      ...[...document.querySelectorAll('#content *')]
        .filter((node) => node.checkVisibility())
        .map((node) => Math.round(node.getBoundingClientRect().right - innerWidth)),
    ),
  );

test('find a failed request, read Why, its steps, log lines and findings, the rendered sources, then export', async (t) => {
  assert.equal(reject.status, 400, 'the REJECTED create is refused by the PreValidation step');
  const { sim } = run;
  const { page, errors } = await pageOf(t);
  // 1. Failed requests only: the result filter is in the address and the list shows only failed activities.
  await page.goto(`${sim.url}/_sim/#activity?result=error`);
  const row = page.locator(`#activity-open-${reject.traceId}`);
  await row.waitFor();
  const results = await page
    .locator('table[data-table="activity-list"] tbody tr[data-activity-row] td:nth-child(2) .ui-badge:first-child')
    .allInnerTexts();
  assert.ok(results.length > 0 && results.every((text) => text === 'error'), results.join());
  await page.locator('#activity-chip-result').waitFor();
  await shot(page, 'activity-1440-light-list');
  // 2. Open it: Why names the refusing plug-in step first, the waterfall draws every step.
  await row.click();
  const why = page.locator('#activity-why');
  await why.waitFor();
  assert.match(await why.innerText(), /^Why: plug-in step “.+” failed: .*REJECTED is refused/);
  assert.match(await page.evaluate(() => location.hash), new RegExp(`^#activity/${reject.traceId}\\?result=error$`));
  const tree = sim.trace.tree(reject.traceId);
  await page
    .locator('ol.ui-waterfall > li')
    .nth(tree.spans.length - 1)
    .waitFor();
  assert.equal(await page.locator('ol.ui-waterfall > li').count(), tree.spans.length);
  await shot(page, 'activity-1440-light-why');
  // Show this step opens the step's drawer with its path from the root.
  await page.locator('#activity-why-step').click();
  const drawer = page.locator('#activity-span-drawer');
  await drawer.waitFor();
  // The link lands on the drawer: focused and scrolled into view once the activity rendered.
  await page.waitForFunction(() => document.activeElement?.id === 'activity-span-drawer');
  assert.equal(await inView(drawer), true);
  assert.ok((await drawer.locator('nav[aria-label="Step path"] li').count()) >= 2);
  // 3. Log & findings: the request's log line is there.
  await page.locator('#activity-detail-tab-log').click();
  await page.getByRole('heading', { name: /^Log lines \(\d+\)$/, level: 4 }).waitFor();
  assert.match(await page.locator('.ui-activity-detail').innerText(), /POST \/_api\/x_orders → 400/);
  // 4. Rendered: the REJECTED create rendered nothing; the page activity names its template files with lines.
  await page.locator('#activity-detail-tab-rendered').click();
  await page.getByText('This activity rendered no page or template.').waitFor();
  await page.evaluate((id) => (location.hash = `#activity/${id}?detail=rendered`), render.traceId);
  const source = page.locator('code.ui-source').first();
  await source.waitFor();
  assert.match(await source.innerText(), /\.webtemplate\.source\.html:\d+$/);
  await shot(page, 'activity-1440-light-rendered');
  // 5. Export bundle: the link carries the filters; its documents hold the activity and its audit entry.
  await page.evaluate(() => (location.hash = '#activity?result=error'));
  const link = page.locator('#activity-export');
  await page.waitForFunction(() => document.querySelector('#activity-export')?.href.includes('result=error'));
  const href = await link.getAttribute('href');
  assert.match(href, /^\/__sim\/api\/activity\/export\?result=error&format=bundle$/);
  const documents = (await (await page.request.get(`${sim.url}${href}`)).text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(documents[0].kind, 'bundle');
  assert.equal(documents.at(-1).kind, 'end');
  assert.ok(documents.some((item) => item.kind === 'activity' && item.trace.traceId === reject.traceId));
  assert.ok(documents.some((item) => item.kind === 'audit' && item.entry.traceId === reject.traceId));
  assert.deepEqual(errors, []);
});

test('old #trace, #audit, #logs and #evidence links land on the matching Activity content', async (t) => {
  const { sim, traceId, tree } = run;
  const { page, errors } = await pageOf(t);
  const step = tree.spans.find((span) => span.kind === 'plugin-step');
  await page.goto(`${sim.url}/_sim/#trace?traceId=${traceId}&spanId=${step.spanId}`);
  await page.locator('#activity-span-drawer').getByRole('heading', { name: step.name, level: 3 }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), `#activity/${traceId}/${step.spanId}`);
  // Lense's "Requests for this page": the request audit filtered by path, each entry opening its activity.
  await page.goto(`${sim.url}/_sim/#audit?path=/order/`);
  await page.getByText('Listing request audit entries: Path is a fact only the audit keeps.').waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#activity?path=%2Forder%2F');
  assert.ok((await page.locator('[id^="activity-audit-"]').count()) > 0);
  await page.goto(`${sim.url}/_sim/#logs`);
  await page.locator('#activity-tabs-tab-log[aria-selected="true"]').waitFor();
  await page.locator('.ui-log-row').first().waitFor();
  assert.match(await page.locator('table[data-table="activity-log"]').innerText(), /startup/);
  await page.goto(`${sim.url}/_sim/#evidence`);
  await page.locator('#activity-tabs-tab-pages[aria-selected="true"]').waitFor();
  await page.locator('table[data-table="activity-pages"]').waitFor();
  assert.deepEqual(errors, []);
});

test('T7: the startup lines are two clicks away, the Log stream tab then Startup, which toggles off (T7)', async (t) => {
  const { sim } = run;
  const { page, errors } = await pageOf(t);
  await page.goto(`${sim.url}/_sim/#activity`);
  await page.locator('#activity-errors').waitFor();
  // Click 1: the Log stream tab; its quick filter is Startup (Result does not apply to log lines).
  await page.locator('#activity-tabs-tab-log').click();
  const startup = page.locator('#activity-startup');
  await startup.waitFor();
  assert.equal(await page.locator('#activity-errors').count(), 0);
  await page.locator('.ui-log-row').first().waitFor();
  // Click 2: only startup lines, in the address and as a chip.
  await startup.click();
  await page.waitForFunction(() => location.hash === '#activity?tab=log&type=startup');
  await page.locator('#activity-chip-type').waitFor();
  await page.locator('#activity-startup[aria-pressed="true"]').waitFor();
  const types = page.locator('table[data-table="activity-log"] tbody tr td:nth-child(2)');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('table[data-table="activity-log"] tbody tr td:nth-child(2)')].every(
      (cell) => cell.innerText.trim() === 'startup',
    ),
  );
  const shown = await types.allInnerTexts();
  assert.ok(shown.length > 0 && shown.every((text) => text.trim() === 'startup'), shown.join());
  // A second click clears it and the other lines come back.
  await startup.click();
  await page.waitForFunction(() => location.hash === '#activity?tab=log');
  await page.locator('#activity-chip-type').waitFor({ state: 'detached' });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('table[data-table="activity-log"] tbody tr td:nth-child(2)')].some(
      (cell) => cell.innerText.trim() !== 'startup',
    ),
  );
  assert.deepEqual(errors, []);
});

// The admin-views D-M-11 table audit (N2b), per visible table: a search box in the table's bar (a page's main list:
// in the page toolbar row), Filters when more than one column sorts, and the bottom bar with the count, rows per page
// and Previous/Next. Activity's tab lists are main lists, as Data records, Flows runs and Backend operations are there
// (handoff-N2a.md G asks for the same list in admin-views); the Stats breakdown is not.
const MAIN_LISTS = [
  'records',
  'flow-runs',
  'operations',
  'activity-list',
  'activity-log',
  'activity-findings',
  'activity-pages',
];
function tableAudit(mainLists) {
  const chrome = document.querySelector('#content .ui-page-chrome');
  const rules = [
    [
      'no search box',
      (wrap, bar, foot, main) =>
        bar?.querySelector('[data-table-search]') || (main && chrome?.querySelector('input[type="search"]')),
    ],
    [
      'no Filters',
      (wrap, bar, foot, main) =>
        wrap.dataset.dataTable === 'records' ||
        wrap.querySelectorAll('thead .ui-sort').length <= 1 ||
        bar?.querySelector('[data-filter-toggle]') ||
        (main && chrome?.querySelector('[data-filter-toggle]')),
    ],
    ['no count', (wrap, bar, foot) => foot?.querySelector('.ui-table-count')],
    ['no rows per page', (wrap, bar, foot) => foot?.querySelector('[data-table-size]')],
    ['no Previous/Next', (wrap, bar, foot) => foot?.querySelectorAll('[data-table-page]').length === 2],
  ];
  return [...document.querySelectorAll('#content .ui-data-table')]
    .filter((wrap) => wrap.checkVisibility())
    .map((wrap) => {
      const parts = [wrap.querySelector(':scope > .ui-table-bar'), wrap.querySelector(':scope > .ui-table-foot')];
      const main = mainLists.includes(wrap.dataset.dataTable);
      return [
        wrap.dataset.dataTable,
        rules.filter(([, holds]) => !holds(wrap, ...parts, main)).map(([problem]) => problem),
      ];
    });
}

test('every Activity tab has its search beside Filters in the toolbar row and the full bottom bar (D-M-11 item 4)', async (t) => {
  const { sim } = run;
  const tables = {
    activities: 'activity-list',
    log: 'activity-log',
    findings: 'activity-findings',
    pages: 'activity-pages',
    stats: 'activity-breakdown',
  };
  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
  ]) {
    const { page, errors } = await pageOf(t, { width, height });
    for (const [tab, id] of Object.entries(tables)) {
      await page.goto(`${sim.url}/_sim/#activity?tab=${tab}`);
      await page.locator(`table[data-table="${id}"] tbody tr`).first().waitFor();
      const where = `${tab} at ${width} px`;
      const parity = await page.evaluate((key) => {
        const box = (node) => node && node.checkVisibility() && node.getBoundingClientRect();
        const toolbar = box(document.querySelector('.ui-page-toolbar'));
        const search = box(document.querySelector('#activity-q'));
        const filters = box(document.querySelector('[data-filter-toggle="activity-filter-drawer"]'));
        const foot = document.querySelector(`[data-data-table="${key}"] > .ui-table-foot`);
        return {
          inToolbar:
            Boolean(toolbar && search && filters) &&
            [search, filters].every((b) => b.top >= toolbar.top && b.bottom <= toolbar.bottom),
          inDrawer: Boolean(document.querySelector('#activity-filter-drawer input[name="q"]')),
          count: foot?.querySelector('.ui-table-count')?.textContent ?? null,
          rows: Boolean(box(foot?.querySelector(`select[data-table-size="${key}"]`))),
          pager: [...(foot?.querySelectorAll(`button[data-table-page="${key}"]`) ?? [])]
            .filter((b) => b.checkVisibility())
            .map((b) => b.textContent),
        };
      }, id);
      assert.equal(parity.inToolbar, true, `${where}: the search and Filters sit in the toolbar row`);
      assert.equal(parity.inDrawer, false, `${where}: no second search in the drawer`);
      assert.match(parity.count ?? '', /^\d+ results?/, `${where}: count`);
      assert.equal(parity.rows, true, `${where}: rows per page`);
      assert.deepEqual(parity.pager, ['Previous', 'Next'], `${where}: Previous/Next`);
      // N2b's audit, unchanged but for Activity's main lists: every table of the tab passes it.
      const audit = await page.evaluate(tableAudit, MAIN_LISTS);
      assert.ok(
        audit.some(([table]) => table === id),
        `${where}: ${id} audited`,
      );
      assert.deepEqual(
        audit.filter(([, problems]) => problems.length),
        [],
        `${where}: ${JSON.stringify(audit)}`,
      );
      if (tab === 'stats')
        assert.equal(
          await page
            .locator('[data-data-table="activity-breakdown"] input[data-table-search="activity-breakdown"]')
            .isVisible(),
          true,
          `${where}: the breakdown's own search`,
        );
    }
    assert.deepEqual(errors, []);
  }
  // The search is the `q=` filter: Enter applies it to the address and the list, and it shows as a chip.
  const { page } = await pageOf(t);
  await page.goto(`${sim.url}/_sim/#activity`);
  await page.locator('table[data-table="activity-list"] tbody tr').first().waitFor();
  await page.locator('#activity-q').fill('REJECTED');
  await page.locator('#activity-q').press('Enter');
  await page.waitForFunction(() => location.hash === '#activity?q=REJECTED');
  await page.locator('#activity-chip-q').waitFor();
  assert.equal(await page.locator('#activity-q').inputValue(), 'REJECTED');
});

test('Escape closes the step then the activity, Enter opens, `/` searches and arrows move between rows', async (t) => {
  const { sim, traceId, tree } = run;
  const { page, errors } = await pageOf(t);
  const leaf = tree.spans.reduce((deepest, span) => (span.depth > deepest.depth ? span : deepest));
  await page.goto(`${sim.url}/_sim/#activity/${traceId}/${leaf.spanId}`);
  const drawer = page.locator('#activity-span-drawer');
  await drawer.getByRole('heading', { name: leaf.name, level: 3 }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'activity-span-drawer');
  // The list sits beside the open activity at 1440 px.
  const [listBox, drawerBox] = await Promise.all([page.locator('.ui-trace-main').boundingBox(), drawer.boundingBox()]);
  assert.ok(listBox.x + listBox.width <= drawerBox.x, 'the list sits left of the activity');
  await drawer.getByRole('link', { name: /^Root step: / }).click();
  await drawer.getByRole('heading', { name: tree.root.name, level: 3 }).waitFor();
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), `activity-span-${tree.root.spanId}`);
  await page.keyboard.press('Escape');
  await page.locator('#activity-detail-title').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => location.hash), '#activity');
  // `/` focuses the search from anywhere outside a field; ↓ moves to the next row, Enter opens it.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await page.waitForFunction(() => document.activeElement?.id === 'activity-q');
  const first = page.locator('[id^="activity-open-"]').first();
  await first.focus();
  await page.keyboard.press('ArrowDown');
  const second = await page.locator('[id^="activity-open-"]').nth(1).getAttribute('id');
  await page.waitForFunction((id) => document.activeElement?.id === id, second);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'activity-detail-title');
  assert.match(await page.evaluate(() => location.hash), /^#activity\/[^/?]+$/);
  assert.deepEqual(errors, []);
});

test('tracing off lists the request audit with a banner; Live shows a new activity without a refresh', async (t) => {
  const { sim, member } = run;
  const { page, errors } = await pageOf(t);
  // Through the runtime's own route (the page's context closes before this test's cleanup runs).
  const settings = async (level) => {
    const response = await fetch(`${sim.url}/_sim/api/trace/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify({ level }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  await settings('off');
  t.after(() => settings('full'));
  await page.goto(`${sim.url}/_sim/#activity`);
  await page
    .getByText('Tracing is off: showing the request audit only; turn it on in ⚙ Settings to see steps.')
    .waitFor();
  assert.ok((await page.locator('table[data-table="activity-list"] tbody tr').count()) > 0, 'never a blank page');
  await settings('full');
  // A new page load reads the settings again (the view keeps them while it is open).
  await page.goto(`${sim.url}/_sim/#activity?live=1`);
  await page.reload();
  await page.getByText('Streaming', { exact: true }).waitFor();
  const read = await fetch(`${sim.url}/_api/x_orders?$top=1`, { headers: { cookie: member } });
  await read.text();
  await page.locator(`#activity-open-${read.headers.get('x-trace-id')}`).waitFor();
  assert.deepEqual(errors, []);
});

test('1,000 retained activities render one page of rows and stay responsive to the next click', async (t) => {
  const { sim } = run;
  // Keep 2,000 activities (the default keeps 500), then record 1,000 more.
  const kept = await fetch(`${sim.url}/_sim/api/trace/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
    body: JSON.stringify({ level: 'full', persist: false, traces: 2000 }),
  });
  assert.equal(kept.status, 200, await kept.text());
  // 1,000 more requests, ten at a time: each is one activity.
  for (let batch = 0; batch < 100; batch++)
    await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const response = await fetch(`${sim.url}/_api/x_orders?$top=${index + 1}`, { headers: { cookie: run.member } });
        await response.text();
      }),
    );
  await sim.settle();
  const { page, errors } = await pageOf(t);
  // Long tasks are recorded as evidence, never asserted (a slow host must not fail this test).
  await page.addInitScript(() => {
    globalThis.longTasks = [];
    new PerformanceObserver((list) =>
      globalThis.longTasks.push(...list.getEntries().map((entry) => entry.duration)),
    ).observe({
      type: 'longtask',
      buffered: true,
    });
  });
  await page.goto(`${sim.url}/_sim/#activity`);
  await page.locator('table[data-table="activity-list"] tbody tr').first().waitFor();
  // One page of rows in the DOM whatever is retained: the work of a render does not grow with the store.
  const total = Number((await page.locator('.ui-table-count').first().innerText()).match(/^(\d+) results/)[1]);
  assert.ok(total >= 1000, `${total} retained`);
  assert.equal(await page.locator('table[data-table="activity-list"] tbody tr').count(), 10);
  await page.locator('[data-table-page="activity-list"][data-delta="1"]').click();
  await page.locator('.ui-table-count', { hasText: 'Page 2 of' }).waitFor();
  await page.locator('#activity-tabs-tab-stats').click();
  await page.locator('#activity-slowest-title').waitFor();
  if (SHOTS)
    console.log(`long tasks over 1,000 activities: ${JSON.stringify(await page.evaluate(() => globalThis.longTasks))}`);
  assert.deepEqual(errors, []);
});

test('at phone width nothing scrolls sideways and step names wrap; dark and light follow the system', async (t) => {
  const { sim } = run;
  const { page, errors } = await pageOf(t, { width: 390, height: 844 });
  await page.goto(`${sim.url}/_sim/#activity`);
  await page.locator('table[data-table="activity-list"]').waitFor();
  assert.equal(await sideways(page), 0);
  await page.locator('table[data-table="activity-list"]').scrollIntoViewIfNeeded();
  await shot(page, 'activity-390-light-list');
  await page.goto(`${sim.url}/_sim/#activity/${reject.traceId}`);
  await page.locator('#activity-why').waitFor();
  await page.locator('#activity-why').scrollIntoViewIfNeeded();
  assert.equal(await sideways(page), 0);
  const cut = await page
    .locator('.ui-waterfall-name')
    .evaluateAll((names) =>
      names.filter((name) => name.scrollWidth > name.clientWidth + 1).map((name) => name.textContent),
    );
  assert.deepEqual(cut, []);
  await shot(page, 'activity-390-light-why');
  // Pages & render: two columns with the actions stacked, inside the frame.
  await page.goto(`${sim.url}/_sim/#activity?tab=pages`);
  const pages = page.locator('table[data-table="activity-pages"]');
  await pages.waitFor();
  await pages.scrollIntoViewIfNeeded();
  assert.equal(await sideways(page), 0);
  assert.equal(
    await page
      .locator('table[data-table="activity-pages"]')
      .evaluate((table) => table.scrollWidth - table.parentElement.clientWidth),
    0,
    'the table fits its frame',
  );
  await shot(page, 'activity-390-light-pages');
  assert.deepEqual(errors, []);

  const luminance = (rgb) => {
    const [r, g, b] = rgb
      .match(/\d+(\.\d+)?/g)
      .slice(0, 3)
      .map((value) => {
        const c = Number(value) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const scheme of ['dark', 'light']) {
    const view = await pageOf(t, { colorScheme: scheme });
    // Each view is read once it finished loading (its ready element), in one synchronous evaluation, so a re-render
    // between finding the element and reading its style cannot hand back a detached element's empty style.
    for (const [hash, selector, ready] of [
      [`#activity/${reject.traceId}`, '.ui-activity-detail', '#activity-why'],
      ['#activity?tab=log', '.ui-activity-panel', '.ui-log-row'],
      ['#flows', '.ui-section', '.ui-section'],
    ]) {
      await view.page.goto(`${sim.url}/_sim/${hash}`);
      await view.page.locator(ready).first().waitFor();
      const { background, color, canvas } = await view.page.evaluate((query) => {
        const node = document.querySelector(query);
        return {
          background: getComputedStyle(node).backgroundColor,
          color: getComputedStyle(node).color,
          canvas: getComputedStyle(document.documentElement).backgroundColor,
        };
      }, selector);
      if (scheme === 'dark') {
        assert.ok(luminance(canvas) < 0.03, `${hash}: dark page ${canvas}`);
        assert.ok(luminance(background) < 0.05, `${hash}: dark ${selector} ${background}`);
        assert.ok(luminance(color) > 0.5, `${hash}: light text ${color}`);
      } else {
        assert.equal(canvas, 'rgb(245, 247, 251)', `${hash}: the light page is unchanged`);
        assert.ok(luminance(background) > 0.85, `${hash}: light ${selector} ${background}`);
      }
    }
    if (scheme === 'dark') {
      await view.page.goto(`${sim.url}/_sim/#activity/${reject.traceId}`);
      await view.page.locator('#activity-why').waitFor();
      await shot(view.page, 'activity-1440-dark-why');
    }
    assert.deepEqual(view.errors, []);
  }
});

// @test-kind contract+security: a hostile audit filter value renders as text, never markup
test('a denied request shows its code and portal code, audit filters narrow, and export downloads', async (t) => {
  const { sim, stranger, orderId } = run;
  const { page, errors } = await pageOf(t);
  // A fresh refusal (the audit keeps the newest 1,000 entries; earlier tests may have pushed older ones out).
  const read = await fetch(`${sim.url}/_api/x_orders(${orderId})`, { headers: { cookie: stranger } });
  await read.text();
  const refused = { status: read.status, traceId: read.headers.get('x-trace-id') };
  await endedTree(sim.trace, refused.traceId);
  // The stranger's refused read: its row names the permission error and the portal code; Request shows the audit entry.
  await page.goto(`${sim.url}/_sim/#activity?result=denied&who=contact:${STRANGER}`);
  const row = page.locator(`tr[data-activity-row="${refused.traceId}"]`);
  await row.waitFor();
  assert.equal(refused.status, 403);
  assert.match(await row.innerText(), /PermissionDenied/);
  assert.match(await row.innerText(), /portal \w+/);
  await page.evaluate((id) => (location.hash = `#activity/${id}?detail=request`), refused.traceId);
  const facts = page.locator('.ui-activity-detail dl.ui-kv').first();
  await page.locator('.ui-activity-detail dt', { hasText: /^Audit id$/ }).waitFor();
  assert.match(await page.locator('.ui-activity-detail').innerText(), /Error\s+\S.*· portal \w+/);
  assert.ok(await facts.count());
  // Audit keys narrow the request audit list: only denied API entries remain.
  await page.goto(`${sim.url}/_sim/#activity?auditKind=api&result=denied`);
  await page.getByText('Listing request audit entries: Audit kind is a fact only the audit keeps.').waitFor();
  const results = await page
    .locator('table[data-table="activity-list"] tbody tr td:nth-child(2) .ui-badge:first-child')
    .allInnerTexts();
  assert.ok(results.length > 0 && results.every((text) => text === 'denied'), results.join());
  // A hostile audit key value is shown as text in the bar, never as markup.
  await page.goto(`${sim.url}/_sim/#activity?auditKind=${encodeURIComponent('<img src=x onerror=window.__pwned=1>')}`);
  await page.locator('#activity-audit-kind option', { hasText: 'not a listed value' }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('#content img').count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  // Export filtered downloads the bundle of the current filters.
  await page.goto(`${sim.url}/_sim/#activity?result=error`);
  await page.locator('#activity-export').waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#activity-export').click()]);
  assert.equal(download.suggestedFilename(), 'simulator-activity-bundle.ndjson');
  assert.deepEqual(errors, []);
});

test('the Log stream filters by type, follows Live and opens a line’s activity; a missing page’s finding links to it', async (t) => {
  const { sim, member } = run;
  const { page, errors } = await pageOf(t);
  const missing = await fetch(`${sim.url}/fx-missing-page/`, { headers: { cookie: member } });
  await missing.text();
  await sim.settle();
  // Findings: the request-time finding of the missing page links to its activity.
  await page.goto(`${sim.url}/_sim/#activity?tab=findings&q=fx-missing-page`);
  const finding = page.locator('.ui-finding', { hasText: '/fx-missing-page/' }).first();
  await page.locator('details.ui-finding-group > summary').first().click();
  await finding.waitFor();
  await finding.getByRole('link', { name: 'Open activity →' }).click();
  await page.locator('#activity-why').waitFor();
  assert.match(
    await page.evaluate(() => location.hash),
    /^#activity\/[^/?]+(\/[^/?]+)?\?q=fx-missing-page&tab=findings$/,
  );
  // Log stream: the type filter keeps one type; Live adds a new line without a refresh; a line opens its activity.
  await page.goto(`${sim.url}/_sim/#activity?tab=log&live=1`);
  await page.getByText('Streaming', { exact: true }).waitFor();
  // The log type is a filter in the drawer.
  await page.locator('[data-filter-toggle="activity-filter-drawer"]').click();
  await page.locator('#activity-log-type').selectOption('request');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => location.hash.includes('type=request'));
  const types = await page.locator('.ui-log-row .ui-badge').allInnerTexts();
  assert.ok(types.length > 0 && types.every((type) => type === 'request'), types.join());
  // The newest line: lines are newest first, so a line that arrives Live becomes the first one.
  const newest = await page.locator('.ui-log-row').first().innerText();
  const read = await fetch(`${sim.url}/_api/x_orders?$top=2`, { headers: { cookie: member } });
  await read.text();
  await page.waitForFunction((text) => document.querySelector('.ui-log-row')?.innerText !== text, newest);
  const line = page.locator('.ui-log-row').first();
  assert.match(await line.innerText(), new RegExp(`GET /_api/x_orders → ${read.status}`));
  await line.getByRole('link', { name: /^Open the activity of log line/ }).click();
  await page.locator('#activity-why').waitFor();
  assert.match(await page.evaluate(() => location.hash), /^#activity\/[^?]+\?tab=log&type=request&live=1$/);
  assert.deepEqual(errors, []);
});

/** The document y of the first element matching `selector` (the Why line, a tab's first row), or null. */
const topOf = (selector) => {
  const node = document.querySelector(selector);
  return node ? Math.round(node.getBoundingClientRect().top + scrollY) : null;
};
/** The first row of each list-like tab (D-M-7: at most 180 px from the top at 1440 × 1000). */
const FIRST_ROW = {
  activities: 'table[data-table="activity-list"] tbody tr',
  log: 'table[data-table="activity-log"] tbody tr',
  findings: 'table[data-table="activity-findings"] tbody tr',
  pages: 'table[data-table="activity-pages"] tbody tr',
};

test('every tab and the open activity start with content, keep prose short and never scroll sideways (D-M-6, D-M-7)', async (t) => {
  const { sim } = run;
  const views = [
    ['activities', '#activity'],
    ['log', '#activity?tab=log'],
    ['findings', '#activity?tab=findings'],
    ['pages', '#activity?tab=pages'],
    ['stats', '#activity?tab=stats'],
    ['detail', `#activity/${reject.traceId}`],
    ['request', `#activity/${reject.traceId}?detail=request`],
    ['rendered', `#activity/${render.traceId}?detail=rendered`],
  ];
  const ready = {
    activities: 'table[data-table="activity-list"] tbody tr',
    log: '.ui-log-row',
    findings: '.ui-finding-group',
    pages: 'table[data-table="activity-pages"] tbody tr',
    stats: '.ui-tile',
    detail: '#activity-why',
    request: '.ui-activity-card h4',
    rendered: 'table[data-table="activity-rendered"]',
  };
  for (const [width, height, scheme] of [
    [1440, 1000, 'light'],
    [1440, 1000, 'dark'],
    [390, 844, 'light'],
  ]) {
    const { page, errors } = await pageOf(t, { width, height, colorScheme: scheme });
    for (const [name, hash] of views) {
      await page.goto(`${sim.url}/_sim/${hash}`);
      await page.locator(ready[name]).first().waitFor();
      await page.evaluate(() => scrollTo(0, 0));
      const measured = await page.evaluate(measureView);
      const detailY = await page.evaluate(topOf, '#activity-why');
      const rowY = FIRST_ROW[name] ? await page.evaluate(topOf, FIRST_ROW[name]) : null;
      const where = `${name} at ${width} px ${scheme}`;
      assert.ok(
        measured.prose <= 280,
        `${where}: ${measured.prose} prose characters: ${JSON.stringify(measured.parts)}`,
      );
      assert.equal(measured.scrollX, false, `${where}: the page scrolls sideways`);
      if (width === 1440) {
        assert.ok(measured.firstY <= 250, `${where}: first content (${measured.first}) at y ${measured.firstY}`);
        if (rowY !== null) assert.ok(rowY <= 180, `${where}: first row at y ${rowY}`);
        if (detailY !== null) assert.ok(detailY <= 250, `${where}: Why at y ${detailY}`);
      }
      // At phone width the first content and the first row sit in the top quarter (211 px of 844).
      if (width === 390) {
        assert.ok(measured.firstY <= 211, `${where}: first content (${measured.first}) at y ${measured.firstY}`);
        if (rowY !== null) assert.ok(rowY <= 211, `${where}: first row at y ${rowY}`);
      }
      await shot(page, `activity-${width}-${scheme}-${name}`);
    }
    assert.deepEqual(errors, []);
  }
});

test('the Filters drawer opens from the toolbar, applies, closes, and its filters stay as chips (D-M-7)', async (t) => {
  const { sim } = run;
  const { page, errors } = await pageOf(t);
  await page.goto(`${sim.url}/_sim/#activity`);
  const toggle = page.locator('[data-filter-toggle="activity-filter-drawer"]');
  const drawer = page.locator('#activity-filter-drawer');
  await toggle.waitFor();
  assert.equal(await drawer.isHidden(), true);
  await toggle.click();
  await drawer.waitFor({ state: 'visible' });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  // A choice applies at once and keeps the drawer open: the list behind it already shows the result.
  await page.locator('#activity-result').selectOption('error');
  await page.waitForFunction(() => location.hash === '#activity?result=error');
  await page.waitForFunction(() => {
    const badges = [
      ...document.querySelectorAll('table[data-table="activity-list"] tbody tr td:nth-child(2) .ui-badge:first-child'),
    ];
    return badges.length > 0 && badges.every((badge) => badge.textContent === 'error');
  });
  assert.equal(await drawer.isVisible(), true, 'a choice keeps the drawer open');
  // Enter in a text field applies and closes it; so do Escape and a click outside the drawer.
  await page.locator('#activity-table').fill('x_orders');
  await page.locator('#activity-table').press('Enter');
  await drawer.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => location.hash === '#activity?result=error&table=x_orders');
  await toggle.click();
  await drawer.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await toggle.click();
  await drawer.waitFor({ state: 'visible' });
  await page.locator('table[data-table="activity-list"] thead').click({ position: { x: 5, y: 5 } });
  await drawer.waitFor({ state: 'hidden' });
  // Apply closes it too.
  await toggle.click();
  await drawer.waitFor({ state: 'visible' });
  await page.locator('#activity-table').fill('x_order');
  await page.locator('#activity-apply').click();
  await drawer.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => location.hash === '#activity?result=error&table=x_order');
  // The active filters show as chips under the toolbar and on the toggle; × removes one, Clear all the rest.
  assert.match(await toggle.innerText(), /^Filters\s*· 2$/);
  await page.locator('#activity-chip-table').click();
  await page.waitForFunction(() => location.hash === '#activity?result=error');
  await page.locator('#activity-clear-all').click();
  // Clear all leaves no chip and an unfiltered address, and the toggle no longer counts filters.
  await page.waitForFunction(() => location.hash === '#activity');
  await page.locator('.ui-chips').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.ui-chip').count(), 0);
  assert.equal(await page.evaluate(() => location.hash), '#activity');
  assert.equal((await toggle.innerText()).trim(), 'Filters');
  // `/` focuses the toolbar's search (D-M-11); the drawer stays closed.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await page.waitForFunction(() => document.activeElement?.id === 'activity-q');
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
});

test('Errors & denied finds what failed in two clicks and toggles off; a Findings header sorts both ways (DV-N4c)', async (t) => {
  const { sim, member, stranger, orderId } = run;
  const { page, errors } = await pageOf(t);
  // A fresh ok read and a fresh refusal: earlier tests pushed the scenario's own activities off the first page.
  const fresh = async (cookie) => {
    const response = await fetch(`${sim.url}/_api/x_orders(${orderId})`, { headers: { cookie } });
    await response.text();
    const traceId = response.headers.get('x-trace-id');
    await endedTree(sim.trace, traceId);
    return { status: response.status, traceId };
  };
  const ok = await fresh(member);
  const denied = await fresh(stranger);
  assert.deepEqual([ok.status, denied.status], [200, 403]);
  await page.goto(`${sim.url}/_sim/#activity`);
  const toggle = page.locator('#activity-errors');
  await page.locator(`#activity-open-${denied.traceId}`).waitFor();
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  // Click 1: only errors and denials, in the address and as a chip.
  await toggle.click();
  await page.waitForFunction(() => location.hash === '#activity?result=error%2Cdenied');
  await page.locator('#activity-chip-result').waitFor();
  await page.locator('#activity-errors[aria-pressed="true"]').waitFor();
  // The list follows the chip once it reloaded: the ok read leaves it.
  await page.locator(`#activity-open-${ok.traceId}`).waitFor({ state: 'detached' });
  await page.locator(`#activity-open-${denied.traceId}`).waitFor();
  const results = await page
    .locator('table[data-table="activity-list"] tbody tr[data-activity-row] td:nth-child(2) .ui-badge:first-child')
    .allInnerTexts();
  assert.ok(results.length > 0 && results.every((text) => text === 'error' || text === 'denied'), results.join());
  // A second click clears the filter and its chip.
  await toggle.click();
  await page.waitForFunction(() => location.hash === '#activity');
  await page.locator('#activity-chip-result').waitFor({ state: 'detached' });
  await page.locator(`#activity-open-${ok.traceId}`).waitFor();
  // T1 from an unfiltered list: Errors & denied, then the refused activity, and Why reads first.
  await toggle.click();
  await page.locator('#activity-chip-result').waitFor();
  await page.locator(`#activity-open-${denied.traceId}`).click();
  await page.locator('#activity-why').waitFor();
  assert.match(await page.locator('#activity-why').innerText(), /^Why: /);
  // A client-side header sorts: Findings by code, then the order flips on a second click.
  await page.evaluate(() => (location.hash = '#activity?tab=findings'));
  const code = page.locator('button[data-table-sort="activity-findings"][data-sort-key="code"]');
  await code.click();
  await page
    .locator('th[aria-sort="ascending"] button[data-table-sort="activity-findings"][data-sort-key="code"]')
    .waitFor();
  await page.locator('button[data-table-sort="activity-findings"][data-sort-key="code"]').click();
  await page
    .locator('th[aria-sort="descending"] button[data-table-sort="activity-findings"][data-sort-key="code"]')
    .waitFor();
  assert.deepEqual(errors, []);
});

test('at phone width a log line takes the row and its action sits under it (DV-N4c-7)', async (t) => {
  const { sim } = run;
  const { page, errors } = await pageOf(t, { width: 390, height: 844 });
  await page.goto(`${sim.url}/_sim/#activity?tab=log`);
  const row = page
    .locator('table[data-table="activity-log"] tbody tr')
    .filter({ has: page.locator('td.ui-actions a') })
    .first();
  await row.waitFor();
  const box = await row.evaluate((tr) => {
    const [line, action] = [tr.children[2], tr.querySelector('td.ui-actions')].map((cell) =>
      cell.getBoundingClientRect(),
    );
    return { line: line.width, lineBottom: line.bottom, actionTop: action.top, width: innerWidth };
  });
  assert.ok(box.line > box.width * 0.75, `the line is ${box.line} px wide of ${box.width}`);
  assert.ok(box.actionTop >= box.lineBottom - 1, 'the action is under the line');
  // The toolbar keeps one row and the tab select shows its longest tab name whole.
  const select = await page.locator('#activity-tab-select').evaluate((node) => {
    const style = getComputedStyle(node);
    const pen = document.createElement('canvas').getContext('2d');
    pen.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const room = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 16;
    return { room, text: Math.max(...[...node.options].map((option) => pen.measureText(option.text).width)) };
  });
  assert.ok(select.text <= select.room, `the tab names need ${select.text} px of ${select.room}`);
  assert.equal(await sideways(page), 0);
  await shot(page, 'activity-390-log-rows');
  assert.deepEqual(errors, []);
});
