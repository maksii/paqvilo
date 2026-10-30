// The /_sim/ trace view over the real end-to-end scenario trace (test/support/trace-scenario.mjs): the deep link
// #trace?traceId=... draws one waterfall row per span of the trace, and a plug-in step's drawer lists its trace events.
// PAQVILO_TRACE_VIEW_SCREENSHOT=<file.png> also saves a screenshot of the waterfall (evidence runs only).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { runTraceScenario } from '../test/support/trace-scenario.mjs';

let browser, run;
before(async () => {
  run = await runTraceScenario({ level: 'full' });
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(async () => {
  await browser?.close();
  await run?.close();
});

test('the trace deep link draws every span of the end-to-end trace and a plug-in step drawer shows its events', async (t) => {
  const { sim, traceId, tree } = run;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${sim.url}/_sim/#trace?traceId=${traceId}`);
  const rows = page.locator('ol.ui-waterfall > li');
  await rows.nth(tree.spans.length - 1).waitFor();
  assert.equal(await rows.count(), tree.spans.length);
  assert.equal(
    await page.locator('ol.ui-waterfall .ui-waterfall-label').first().getAttribute('data-trace-span'),
    tree.root.spanId,
  );
  if (process.env.PAQVILO_TRACE_VIEW_SCREENSHOT)
    await page
      .locator('[data-ui-section="trace:detail"]')
      .screenshot({ path: process.env.PAQVILO_TRACE_VIEW_SCREENSHOT });

  await page.getByRole('button', { name: /^Span Order pre-validation, plugin-step/ }).click();
  const drawer = page.locator('#trace-span-drawer');
  await drawer.getByRole('heading', { name: 'Order pre-validation', level: 3 }).waitFor();
  await drawer.getByText('Pre-validation checked Order one', { exact: false }).waitFor();
  assert.match(await drawer.innerText(), /\btrace\b/);
  assert.match(await page.evaluate(() => location.hash), /&spanId=/);
  assert.deepEqual(errors, []);
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
const inView = (locator) =>
  locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.top < innerHeight && box.bottom > 0;
  });

test('a span deep link lands beside the list, the root is one click up, Escape closes and Enter opens (DV-C-3, DV-C-4, DV-C-16, DV-C-17)', async (t) => {
  const { sim, traceId, tree } = run;
  const { page, errors } = await pageOf(t);
  const leaf = tree.spans.reduce((deepest, span) => (span.depth > deepest.depth ? span : deepest));
  await page.goto(`${sim.url}/_sim/#trace?traceId=${traceId}&spanId=${leaf.spanId}`);
  const drawer = page.locator('#trace-span-drawer');
  await drawer.getByRole('heading', { name: leaf.name, level: 3 }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'trace-span-drawer');
  // The drawer is in view, and so is the trace list beside it (1200 px and wider).
  assert.equal(await inView(drawer), true);
  const list = page.locator('[data-ui-section="trace:list"]');
  assert.equal(await inView(list), true);
  const [listBox, drawerBox] = await Promise.all([list.boundingBox(), drawer.boundingBox()]);
  assert.ok(listBox.x + listBox.width <= drawerBox.x, 'the list sits left of the drawer');
  // Beside the list every waterfall name is readable in full (wrapped, not cut) (DV-Y8-6).
  const names = page.locator('[data-ui-section="trace:detail"] .ui-waterfall-name');
  assert.equal(await names.count(), tree.spans.length);
  assert.deepEqual(
    await names.evaluateAll((items) =>
      items.filter((name) => name.scrollWidth > name.clientWidth + 1).map((name) => name.textContent),
    ),
    [],
  );
  // The path from the root names every ancestor; Root is one click.
  assert.equal(await drawer.locator('nav[aria-label="Span path"] li').count(), leaf.depth + 1);
  await drawer.getByRole('link', { name: /^Root span: / }).click();
  await drawer.getByRole('heading', { name: tree.root.name, level: 3 }).waitFor();
  assert.equal(await inView(drawer), true);
  assert.equal(await drawer.locator('dt:text-is("Parent") + dd').innerText(), 'none (root)');
  // Escape closes the drawer and returns to the span's label.
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), `trace-span-${tree.root.spanId}`);
  // `#trace` alone is the unfiltered list with no open trace; Enter on a row moves to the trace it opens.
  await page.evaluate(() => (location.hash = '#trace?kind=http'));
  await page.locator('#trace-chip-kind').waitFor();
  await page.evaluate(() => (location.hash = '#trace'));
  await page.locator('#trace-chip-kind').waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-ui-section="trace:detail"]').count(), 0);
  const first = page.locator('[id^="trace-open-"]').first();
  await first.focus();
  await page.keyboard.press('Enter');
  await page.locator('ol.ui-waterfall > li').first().waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'trace-detail-title');
  assert.equal(await inView(page.locator('#trace-detail-title')), true);
  assert.deepEqual(errors, []);
});

test('a refused filter is named; the trace store is a Monitor card on the dashboard (D-R3-15, DV-C-19)', async (t) => {
  const { page, errors } = await pageOf(t);
  await page.goto(`${run.sim.url}/_sim/#trace?status=bogus`);
  await page.getByText('The Span status (status) filter value "bogus" is not valid', { exact: false }).waitFor();
  assert.equal(await page.locator('#trace-status').inputValue(), 'bogus');
  await page.getByRole('button', { name: 'Remove the Span status filter' }).click();
  await page.waitForFunction(() => location.hash === '#trace');
  await page.locator('[id^="trace-open-"]').first().waitFor();
  await page.goto(`${run.sim.url}/_sim/#dashboard`);
  await page.locator('[data-node="org:trace"]').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
});

test('at phone width span names wrap instead of being cut, without sideways scrolling (DV-C-16)', async (t) => {
  const { sim, traceId, tree } = run;
  const { page, errors } = await pageOf(t, { width: 390, height: 844 });
  await page.goto(`${sim.url}/_sim/#trace?traceId=${traceId}`);
  const rows = page.locator('ol.ui-waterfall > li');
  await rows.nth(tree.spans.length - 1).waitFor();
  const cut = await page
    .locator('.ui-waterfall-name')
    .evaluateAll((names) =>
      names.filter((name) => name.scrollWidth > name.clientWidth + 1).map((name) => name.textContent),
    );
  assert.deepEqual(cut, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  assert.deepEqual(errors, []);
});

test('the Traces, Dashboard and Flows views follow the dark colour scheme and stay light otherwise (DV-C-18)', async (t) => {
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
  const colours = (page, selector) =>
    page
      .locator(selector)
      .first()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          background: style.backgroundColor,
          color: style.color,
          page: getComputedStyle(document.documentElement).backgroundColor,
        };
      });
  for (const scheme of ['dark', 'light']) {
    const { page, errors } = await pageOf(t, { colorScheme: scheme });
    const views = [
      [`#trace?traceId=${run.traceId}&spanId=${run.tree.root.spanId}`, '#trace-span-drawer'],
      ['#dashboard', '.dm-card'],
      ['#flows', '.ui-section'],
    ];
    for (const [hash, selector] of views) {
      await page.goto(`${run.sim.url}/_sim/${hash}`);
      await page.locator(selector).first().waitFor();
      const { background, color, page: canvas } = await colours(page, selector);
      if (scheme === 'dark') {
        assert.ok(luminance(canvas) < 0.03, `${hash}: dark page ${canvas}`);
        assert.ok(luminance(background) < 0.05, `${hash}: dark ${selector} ${background}`);
        assert.ok(luminance(color) > 0.5, `${hash}: light text ${color}`);
      } else {
        assert.equal(canvas, 'rgb(245, 247, 251)', `${hash}: the light page is unchanged`);
        assert.ok(luminance(background) > 0.85, `${hash}: light ${selector} ${background}`);
      }
    }
    assert.deepEqual(errors, []);
  }
});
