import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { signInContext } from '../mirage/testing.mjs';
import { fixtureApp } from '../mirage/test/canvas-runtime-fixture.mjs';
import { files, canvasPlayerFixture } from '../mirage/test/canvas-player-fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { canvasContext } from './support/canvas-player-page.mjs';

// @test-kind contract: the player's default resolution is the size the app's source declares
test("the player opens at the app's designed size from Properties.json", async (t) => {
  const app = await fixtureApp({
    ...files,
    'Properties.json': JSON.stringify({ DocumentLayoutWidth: 1024, DocumentLayoutHeight: 768 }),
  });
  const { context, server } = await canvasContext(t, app);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/_apps/canvas/${app.uniqueName}`);
  await page.locator('[data-testid="canvas-start"]:enabled').waitFor();
  assert.equal(await page.getByTestId('canvas-resolution').inputValue(), '1024x768');
});

// @test-kind contract: the player keeps the user's resolution per app in the tab
test('a chosen resolution survives a page reload and a source reload', async (t) => {
  const sim = await canvasPlayerFixture(t, 'directory', { watch: true });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, sim, 'alex');
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const resolution = page.getByTestId('canvas-resolution');
  await page.goto(`${sim.url}/_apps/canvas/invented`);
  await page.locator('[data-testid="canvas-start"]:enabled').waitFor();
  assert.equal(await resolution.inputValue(), '1366x768');

  await resolution.selectOption('1280x720');
  await page.reload();
  await page.locator('[data-testid="canvas-start"]:enabled').waitFor();
  assert.equal(await resolution.inputValue(), '1280x720');

  const file = path.join(sim.fixtureRoot, 'apps/invented/Src/App.pa.yaml');
  const old = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, old.replace('Hello', 'Reloaded'));
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="canvas-status"]')?.textContent === 'Source updated. Start the app again.',
  );
  assert.equal(await resolution.inputValue(), '1280x720');
  assert.deepEqual(pageErrors, []);
});
