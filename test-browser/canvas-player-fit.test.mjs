// @test-kind contract: the player's own zoom fits the stage to the window; it is not the app's scale-to-fit setting
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { signInContext } from '../mirage/testing.mjs';
import { canvasPlayerFixture } from '../mirage/test/canvas-player-fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

test('the default zoom fits the 1366 px stage beside the inspector, and 100% restores it', async (t) => {
  const sim = await canvasPlayerFixture(t, 'directory');
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await signInContext(context, sim, 'alex');
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const ready = Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/_apps/api/canvas/invented') && response.request().method() === 'GET',
    ),
    page.waitForResponse(
      (response) => response.url().endsWith('/_apps/canvas/api/invented') && response.request().method() === 'GET',
    ),
  ]);
  await page.goto(`${sim.url}/_apps/canvas/invented`);
  await ready;
  await page.waitForFunction(() => !document.querySelector('[data-testid="canvas-start"]').disabled);
  const started = page.waitForResponse(
    (response) => response.url().endsWith('/_apps/api/canvas/invented') && response.request().method() === 'POST',
  );
  await page.getByTestId('canvas-start').click();
  assert.equal((await started).ok(), true);
  await page.locator('[data-control="Next"]').waitFor();

  const scroller = page.locator('.stage-scroll');
  const surface = page.locator('.canvas-surface');
  const overflow = () => scroller.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  const fitted = await overflow();
  assert.ok(fitted.scroll <= fitted.client, JSON.stringify(fitted));
  const transform = await surface.evaluate((el) => getComputedStyle(el).transform);
  const scale = Number(/^matrix\(([^,]+)/.exec(transform)?.[1]);
  assert.ok(scale > 0 && scale < 1, transform);

  const right = await page.locator('[data-control="UnsafeText"]').boundingBox();
  const box = await scroller.boundingBox();
  assert.ok(right && box);
  assert.ok(right.x + right.width <= box.x + box.width, 'the right part of the app is inside the visible scroller');

  const next = page.waitForResponse(
    (response) => response.url().endsWith('/_apps/api/canvas/invented') && response.request().method() === 'POST',
  );
  await page.locator('[data-control="Next"]').click();
  assert.equal((await next).ok(), true);
  await page.locator('[data-control="Return"]').waitFor();

  await page.getByTestId('canvas-zoom').selectOption('1');
  assert.equal(await surface.evaluate((el) => getComputedStyle(el).transform), 'none');
  assert.equal(await surface.evaluate((el) => el.getBoundingClientRect().width), 1366);
  const full = await overflow();
  assert.ok(full.scroll > full.client, JSON.stringify(full));
  assert.deepEqual(pageErrors, []);
});
