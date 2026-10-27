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

test('reopening a running app reflects its current resolution without changing it', { timeout: 60000 }, async (t) => {
  const sim = await canvasPlayerFixture(t, 'directory');
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, sim, 'alex');
  const page = await context.newPage();
  await page.goto(`${sim.url}/_apps/canvas/invented`);
  await page.getByTestId('canvas-resolution').selectOption('390x844');
  await page.getByTestId('canvas-start').click();
  await page.locator('[data-control="Next"]').waitFor();
  await page.reload();
  await page.locator('[data-control="Next"]').waitFor();
  assert.equal(await page.getByTestId('canvas-resolution').inputValue(), '390x844');
  assert.deepEqual((await (await context.request.get(`${sim.url}/_apps/api/canvas/invented`)).json()).viewport, {
    width: 390,
    height: 844,
  });
  const result = await page.evaluate(async () => {
    const response = await fetch('/_apps/api/canvas/invented', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': document.body.dataset.csrf },
      body: JSON.stringify({ action: 'resize', width: 777, height: 555 }),
    });
    return response.ok;
  });
  assert.equal(result, true);
  await page.reload();
  await page.locator('[data-control="Next"]').waitFor();
  assert.equal(await page.getByTestId('canvas-resolution').inputValue(), '777x555');
  const started = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'start',
  );
  await page.getByTestId('canvas-start').click();
  await started;
  assert.deepEqual((await (await context.request.get(`${sim.url}/_apps/api/canvas/invented`)).json()).viewport, {
    width: 777,
    height: 555,
  });
});

test('failed input without a snapshot restores the last observed control value', { timeout: 60000 }, async (t) => {
  const sim = await canvasPlayerFixture(t, 'directory');
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, sim, 'alex');
  const page = await context.newPage();
  await page.goto(`${sim.url}/_apps/canvas/invented`);
  await page.getByTestId('canvas-start').click();
  const input = page.locator('[data-control="SearchBox"]');
  await input.waitFor();
  await page.route('**/_apps/api/canvas/invented', async (route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'input') {
      return route.fulfill({ status: 403, json: { error: { code: 'Refused', message: 'Invented refusal' } } });
    }
    await route.continue();
  });
  const response = page.waitForResponse(
    (result) => result.request().method() === 'POST' && result.request().postDataJSON()?.action === 'input',
  );
  await input.fill('unaccepted');
  await input.press('Tab');
  assert.equal((await response).status(), 403);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="canvas-status"]')?.textContent === 'Invented refusal',
  );
  assert.equal(await input.inputValue(), '');
  assert.equal(
    (await (await context.request.get(`${sim.url}/_apps/api/canvas/invented`)).json()).screens
      .find((screen) => screen.current)
      .controls.find((row) => row.name === 'SearchBox').properties.Text,
    '',
  );
});
