import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { signInContext } from '../mirage/testing.mjs';
import { canvasPlayerFixture } from '../mirage/test/canvas-player-fixture.mjs';

test('resolution changed while Start is pending is applied after startup', { timeout: 60000 }, async (t) => {
  const sim = await canvasPlayerFixture(t, 'directory');
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, sim, 'alex');
  const page = await context.newPage();
  await page.goto(`${sim.url}/_apps/canvas/invented`);
  let release, arrived;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    arrived = resolve;
  });
  t.after(() => release());
  await page.route('**/_apps/api/canvas/invented', async (route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'start') {
      arrived();
      await gate;
    }
    await route.continue();
  });
  await page.getByTestId('canvas-start').click();
  await seen;
  await page.getByTestId('canvas-resolution').selectOption('390x844');
  const resized = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'resize',
  );
  release();
  const response = await resized;
  assert.equal(response.ok(), true);
  await page.waitForFunction(() => document.querySelector('[data-testid="canvas-stage"]')?.style.width === '390px');
  const snapshot = await (await context.request.get(`${sim.url}/_apps/api/canvas/invented`)).json();
  assert.deepEqual(snapshot.viewport, { width: 390, height: 844 });
  assert.equal(
    snapshot.variables.initialWidth,
    1366,
    'OnStart sees the selected resolution at the time Start was clicked',
  );
});
