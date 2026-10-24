import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { fixture, initial } from '../test/fixtures/platform-experiments.mjs';

test(
  'a failed lazy configuration link marks its preset immediately and repeated attempts retain one diagnostic',
  { timeout: 30000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-preset-link-ui-'));
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
      await page.locator('#confirm').getByRole('button', { name: 'Apply preset', exact: true }).click();
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
