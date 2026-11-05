// @test-kind contract: persona catalog rendering preserves exact canonical grouped and other-contact membership at scale
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
    const { app, initial } = await personaFixture(t, { count: 1000, curated, groupCount: 20 });
    const before = performance.now(),
      response = await fetch(app.url + '/SignIn'),
      html = await response.text(),
      renderMs = performance.now() - before;
    assert.equal(response.status, 200);
    const missing = Array.from({ length: curated }, (_, index) => `person-${index + 1}`).filter(
      (key) => !html.includes(`data-persona-row="${key}"`),
    );
    assert.deepEqual(missing, [], 'the grouped sign-in page renders every curated persona');
    const expectedCurated = Array.from({ length: curated }, (_, index) => `person-${index + 1}`),
      expectedPack = Array.from({ length: 5 }, (_, index) => `person-${curated + index + 1}`),
      expectedOther = initial.tables.contact
        .slice(curated + 5)
        .map((contact) => `@contact:${String(contact.contactid).toLowerCase()}`),
      expectedCanonical = [...expectedCurated, ...expectedPack, ...expectedOther];
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(app.url + '/_sim/#identity');
    const picker = page.locator('#browser-persona-picker');
    const signInKeys = await page.evaluate((source) => {
      const documentCopy = new DOMParser().parseFromString(source, 'text/html');
      return [...documentCopy.querySelectorAll('.persona-groups [data-persona-row]')].map((node) =>
        node.getAttribute('data-persona-row'),
      );
    }, html);
    assert.equal(signInKeys.length, 1000);
    assert.equal(new Set(signInKeys).size, 1000);
    assert.deepEqual(signInKeys.sort(), expectedCanonical.sort());
    await picker.locator('[data-persona-result-count]').filter({ hasText: '1000 of 1000' }).waitFor();
    const rows = await picker.locator('[data-persona-row]').count();
    const groupedKeys = await picker
        .locator('.persona-groups > details:not([data-persona-group="__other"]) [data-persona-row]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-persona-row'))),
      otherKeys = await picker
        .locator('.persona-groups > [data-persona-group="__other"] [data-persona-row]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-persona-row')));
    assert.deepEqual(groupedKeys.length, curated + expectedPack.length);
    assert.deepEqual(groupedKeys.sort(), [...expectedCurated, ...expectedPack].sort());
    assert.deepEqual(otherKeys.length, expectedOther.length);
    assert.deepEqual(otherKeys.sort(), expectedOther.sort());
    const canonicalKeys = [...groupedKeys, ...otherKeys];
    assert.equal(canonicalKeys.length, 1000);
    assert.equal(new Set(canonicalKeys).size, 1000);
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
