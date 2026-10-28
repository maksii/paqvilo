import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { fixture, initial } from '../test/fixtures/platform-experiments.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test(
  'a failed lazy configuration link marks its preset immediately and repeated attempts retain one diagnostic',
  { timeout: 30000 },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-preset-link-ui-'));
    await fixture(root);
    let app, browser;
    t.after(async () => {
      await browser?.close();
      await app?.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    const pack = {
      id: 'invented-links',
      name: 'Invented links',
      description: 'Synthetic lazy link mismatch',
      matches: () => true,
      configurationPresets: [
        { id: 'declared', name: 'Declared' },
        { id: 'loaded', name: 'Loaded' },
      ],
      presets: () => ({
        mismatch: {
          name: 'Mismatch',
          configurationPreset: 'declared',
          load: () => ({ configurationPreset: 'loaded' }),
        },
      }),
    };
    app = await createSimulator({ sourceDir: root, initial: initial(), packs: [pack], watch: false });
    browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    const page = await browser.newPage();
    await page.goto(app.url + '/_sim/#access');
    await page.locator('#refresh:not([disabled])').waitFor();
    // The scenario picker is a kit section collapsed by default; the failure itself shows in the page notification.
    await page.locator('[data-ui-section="preset-picker"] > summary').click();
    await page.getByLabel('Available preset', { exact: true }).selectOption('mismatch');
    await page.getByLabel('Also apply the data preset’s configuration preset (if provided)').check();
    assert.doesNotMatch(
      await page.locator('#available-preset option[value="mismatch"]').textContent(),
      /invalid configuration link/,
    );
    await page.getByRole('button', { name: 'Apply selected preset', exact: true }).click();
    for (let index = 0; index < 2; index++) {
      // The marked option is already shown after the first attempt, so each attempt waits for its own refusal.
      const refused = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith('/presets/mismatch/apply'),
      );
      await page.locator('#confirm').getByRole('button', { name: 'Apply preset', exact: true }).click();
      assert.equal((await refused).ok(), false);
      await page.waitForFunction(() =>
        document
          .querySelector('#available-preset option[value="mismatch"]')
          ?.textContent.includes('invalid configuration link'),
      );
      await page
        .getByText('Preset mismatch configurationPreset does not match its lazy descriptor', { exact: true })
        .waitFor();
      assert.equal(await page.getByLabel('Available preset', { exact: true }).inputValue(), 'mismatch');
      assert.equal(
        await page.getByLabel('Also apply the data preset’s configuration preset (if provided)').isChecked(),
        true,
      );
    }
    const diagnostics = (await (await fetch(app.url + '/_sim/api/diagnostics')).json()).diagnostics.filter(
      (item) => item.code === 'PACK_CONFIGURATION_PRESET_LINK_INVALID',
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].preset, 'mismatch');
    assert.equal(diagnostics[0].pack, 'invented-links');
  },
);

test('preset picker retains edits made during the initial access view load', { timeout: 30000 }, async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-preset-startup-ui-'));
  await fixture(root);
  let app, browser, releasePersonas, signalPersonas;
  const personasHeld = new Promise((resolve) => (releasePersonas = resolve));
  const personasRequested = new Promise((resolve) => (signalPersonas = resolve));
  t.after(async () => {
    releasePersonas();
    await browser?.close();
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  app = await createSimulator({ sourceDir: root, initial: initial(), watch: false });
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  const page = await browser.newPage();
  await page.route('**/personas', async (route) => {
    signalPersonas();
    await personasHeld;
    await route.continue();
  });
  await page.goto(app.url + '/_sim/#access');
  await personasRequested;
  await page.locator('[data-ui-section="preset-picker"] > summary').click();
  const preset = page.getByLabel('Available preset', { exact: true });
  const initialPreset = await preset.inputValue();
  const option = await page.locator('#available-preset option').last().getAttribute('value');
  assert.ok(option);
  assert.notEqual(option, initialPreset);
  await preset.selectOption(option);
  const includeConfiguration = page.getByLabel('Also apply the data preset’s configuration preset (if provided)');
  await includeConfiguration.check();
  releasePersonas();
  await page.locator('#refresh:not([disabled])').waitFor();
  assert.equal(await preset.inputValue(), option);
  assert.equal(await includeConfiguration.isChecked(), true);
  await page.evaluate(() => (location.hash = 'overview'));
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  await page.evaluate(() => (location.hash = 'access'));
  await page.locator('#refresh:not([disabled])').waitFor();
  await page.locator('[data-ui-section="preset-picker"] > summary').click();
  assert.equal(await preset.inputValue(), initialPreset);
  assert.equal(await includeConfiguration.isChecked(), false);
});
