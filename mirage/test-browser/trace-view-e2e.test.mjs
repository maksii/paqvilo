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
