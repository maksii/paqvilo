import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { profileFixture } from '../test/fixtures/deployment-profiles.mjs';

test(
  'Environment controls select, pin, disable optional sections and restore defaults',
  { timeout: 45000 },
  async (t) => {
    const fixture = await profileFixture(t);
    const app = await createSimulator({ ...fixture, watch: false });
    fixture.onCleanup(() => app.close());
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    fixture.onCleanup(() => browser.close());
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(app.url + '/_sim/#environment');
    await page.locator('#deployment-profile-id').waitFor();
    assert.equal(await page.locator('#deployment-profile-id').inputValue(), 'dev');
    assert.equal(await page.locator('[data-profile-section="pages"]').isDisabled(), true);
    await page.locator('#deployment-profile-id').selectOption('test');
    await page.locator('[data-profile-section="connectionReferences"]').uncheck();
    await page.getByRole('button', { name: 'Apply and pin locally' }).click();
    await page.getByText('Deployment profile pinned locally.', { exact: true }).waitFor();
    assert.equal(app.portal.snippets.Greeting, 'Test');
    assert.equal(app.state().config.deploymentProfilePin.profile, 'test');
    assert.equal(app.state().data.connectionreference.length, 0);
    await page.reload();
    await page.locator('#deployment-profile-id').waitFor();
    assert.equal(await page.locator('#deployment-profile-id').inputValue(), 'test');
    assert.equal(await page.locator('[data-profile-section="connectionReferences"]').isChecked(), false);
    await page.getByRole('button', { name: 'Use configured defaults' }).click();
    await page.getByText('Configured profile defaults restored.', { exact: true }).waitFor();
    assert.equal(app.portal.snippets.Greeting, 'Development');
    assert.equal(await page.locator('#deployment-profile-id').inputValue(), 'dev');
    assert.match(await (await fetch(app.url)).text(), /Development/);
    assert.deepEqual(errors, []);
  },
);
