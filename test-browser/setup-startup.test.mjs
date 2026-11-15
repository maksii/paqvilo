// @test-kind contract: setup view choices made before configuration readiness survive the controlled startup boundary.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startSetupServer } from '../lense/setup/server.mjs';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

let browser;
before(async () => {
  const channel = process.env.PAQVILO_BROWSER;
  browser = await chromium.launch(browserLaunchOptions({ headless: true, ...(channel ? { channel } : {}) }));
});
after(() => browser?.close());

async function heldSetup(t, stage = 'status') {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-setup-startup-'));
  const owner = ownedFixture(t);
  owner.remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const server = await startSetupServer({ directory, processEnv: {} });
  owner.add(() => server.close());
  const context = await browser.newContext();
  owner.add(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let release, reached;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    reached = resolve;
  });
  owner.add(() => release());
  await context.route(`**/_setup/api/${stage}`, async (route) => {
    reached();
    await gate;
    await route.continue();
  });
  await page.goto(server.url);
  await requested;
  assert.match(await page.locator('#content').innerText(), /Loading project configuration/);
  return { page, release, errors };
}

test('All settings selected while initial status is held becomes the first ready view', async (t) => {
  const { page, release, errors } = await heldSetup(t);
  const all = page.getByRole('button', { name: 'All settings' });
  await all.click();
  assert.equal(await all.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('form[data-form=create]').count(), 0, 'configuration remains gated');
  release();
  await page.locator('form[data-form=create]').waitFor();
  assert.equal(await all.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('form[data-form=quick-create]').count(), 0);
  assert.deepEqual(errors, []);
});

test('All settings waits for initial export discovery before rendering its create form', async (t) => {
  const { page, release, errors } = await heldSetup(t, 'quick');
  const all = page.getByRole('button', { name: 'All settings' });
  await all.click();
  assert.equal(await all.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('form[data-form=create]').count(), 0, 'discovery remains gated');
  release();
  await page.locator('form[data-form=create]').waitFor();
  assert.equal(await all.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
});

test('the latest quick and all selection wins across initial status readiness', async (t) => {
  const { page, release, errors } = await heldSetup(t);
  const all = page.getByRole('button', { name: 'All settings' });
  const quick = page.getByRole('button', { name: 'Quick setup' });
  await all.click();
  await quick.click();
  assert.equal(await quick.getAttribute('aria-pressed'), 'true');
  assert.equal(await all.getAttribute('aria-pressed'), 'false');
  release();
  await page.locator('form[data-form=quick-create]').waitFor();
  assert.equal(await page.locator('form[data-form=create]').count(), 0);
  await all.click();
  await page.locator('form[data-form=create]').waitFor();
  await quick.click();
  await page.locator('form[data-form=quick-create]').waitFor();
  assert.equal(await quick.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
});
