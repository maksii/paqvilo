import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { personaFixture } from '../test/fixtures/persona-catalog.mjs';

// Interactive scale comes from server-rendered rows and an indexed filter that only toggles them. Durations depend
// on the machine, so they are reported as diagnostics; the assertions check the mechanism.
test(
  '1000-persona grouped sign-in and admin filtering render every persona once and filter in place',
  { timeout: 60000 },
  async (t) => {
    const curated = 990;
    const { app } = await personaFixture(t, { count: 1000, curated, groupCount: 20 });
    const before = performance.now(),
      response = await fetch(app.url + '/SignIn'),
      html = await response.text(),
      renderMs = performance.now() - before;
    assert.equal(response.status, 200);
    const missing = Array.from({ length: curated }, (_, index) => `person-${index + 1}`).filter(
      (key) => !html.includes(`data-persona-row="${key}"`),
    );
    assert.deepEqual(missing, [], 'the grouped sign-in page renders every curated persona');
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(app.url + '/_sim/#identity');
    const picker = page.locator('#browser-persona-picker');
    await picker.locator('[data-persona-result-count]').filter({ hasText: '1000 of 1000' }).waitFor();
    const rows = await picker.locator('[data-persona-row]').count();
    const [matched, other] = await Promise.all(
      ['person-990', 'person-1'].map((key) => picker.locator(`[data-persona-row="${key}"]`).first().elementHandle()),
    );
    await picker.locator('[data-persona-query]').fill('person-99');
    await picker.locator('[data-persona-result-count]').filter({ hasText: '7 of 1000' }).waitFor();
    assert.equal(await picker.locator('[data-persona-row]').count(), rows, 'filtering never re-renders the rows');
    assert.deepEqual(
      await Promise.all([matched, other].map((row) => row.evaluate((node) => [node.isConnected, node.hidden]))),
      [
        [true, false],
        [true, true],
      ],
      'the filter toggles the existing rows',
    );
    const filterMs = Number(await picker.getAttribute('data-persona-filter-ms'));
    t.diagnostic(JSON.stringify({ renderMs: Math.round(renderMs), filterMs, personas: 1000 }));
  },
);
