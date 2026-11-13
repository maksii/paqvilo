// @test-kind compatibility: attribute checks ignore properties inherited by DOMStringMap
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { personaFixture } from '../test/fixtures/persona-catalog.mjs';
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
// @test-kind compatibility: attribute checks must ignore properties inherited by DOMStringMap
test('persona actions ignore inherited dataset properties', async (t) => {
  const { app } = await personaFixture(t);
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  await page.goto(app.url + '/_sim/#identity');
  const picker = page.locator('#browser-persona-picker');
  await picker.locator('[data-persona-result-count]').filter({ hasText: '60 of 60' }).waitFor();
  await picker.locator('[data-persona-query]').fill('synthetic account reviewer');
  await picker.locator('[data-persona-result-count]').filter({ hasText: '1 of 60' }).waitFor();
  await page.evaluate(() => {
    Object.getPrototypeOf(document.body.dataset).personaClear = 'inherited';
  });
  await picker.locator('[data-persona-pin="person-1"]').first().click();
  assert.equal(await picker.locator('[data-persona-query]').inputValue(), 'synthetic account reviewer');
  assert.equal(await picker.locator('[data-persona-shortcuts="pinned"] [data-persona-row]').count(), 1);
});
