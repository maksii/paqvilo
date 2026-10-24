import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { personaFixture } from '../test/fixtures/persona-catalog.mjs';

test(
  '1000-persona grouped sign-in and admin filtering stay within interactive budgets',
  { timeout: 60000 },
  async (t) => {
    const { app } = await personaFixture(t, { count: 1000, curated: 990, groupCount: 20 });
    const before = performance.now(),
      response = await fetch(app.url + '/SignIn'),
      html = await response.text(),
      renderMs = performance.now() - before;
    assert.equal(response.status, 200);
    assert.ok(html.includes('person-990'));
    assert.ok(renderMs < 500, `Sign-in took ${renderMs.toFixed(1)} ms`);
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(app.url + '/_sim/#identity');
    const picker = page.locator('#browser-persona-picker');
    await picker.locator('[data-persona-result-count]').filter({ hasText: '1000 of 1000' }).waitFor();
    await picker.locator('[data-persona-query]').fill('person-99');
    await picker.locator('[data-persona-result-count]').filter({ hasText: '7 of 1000' }).waitFor();
    const filterMs = Number(await picker.getAttribute('data-persona-filter-ms'));
    assert.ok(filterMs < 100, `Filtering took ${filterMs} ms`);
    t.diagnostic(JSON.stringify({ renderMs: Math.round(renderMs), filterMs, personas: 1000 }));
  },
);
