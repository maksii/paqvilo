// Quick setup first run, as a person without configuration knowledge does it: open setup in a folder that only holds a
// portal export, create the project from what was found, start the local preview, open it, and stop it. Loopback only.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import YAML from 'yaml';
import { startSetupServer } from '../lense/setup/server.mjs';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('quick setup creates a project from a found export, starts, opens and stops its preview', { timeout: 240_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-quick-run-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }));
  await fs.cp(path.join(root, 'examples/project/portal'), path.join(directory, 'exports', 'site'), { recursive: true });
  const config = path.join(directory, 'paqvilo.config.yml');
  // Whatever the run leaves behind, the preview this test may have started is stopped.
  ownedFixture(t).add(async () => spawnSync(process.execPath, [path.join(root, 'bin/paqvilo.mjs'), 'mirage', 'stop', '--config', config, '--json'], { cwd: directory, windowsHide: true, timeout: 60_000 }));
  const server = await startSetupServer({ directory, processEnv: {} }); ownedFixture(t).add(() => server.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true })); ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));

  await page.goto(server.url);
  const create = page.locator('form[data-form=quick-create]');
  assert.match(await create.innerText(), /we found 1 website export/);
  assert.equal(await create.getByLabel(/Power Pages website/).isChecked(), true);
  await create.getByRole('button', { name: 'Create project' }).click();
  await page.locator('#quick-files.is-done').waitFor();
  const written = YAML.parse(await fs.readFile(config, 'utf8')), name = written.defaultSite;
  assert.equal(written.sites[name].source, 'exports/site');
  assert.equal(written.sites[name].mirage.simulation.level, 'dry-run');
  assert.match(await page.locator('#quick-files .quick-summary').innerText(), /Website: exports\/site/);

  await page.locator('#quick-run').getByRole('button', { name: 'Start preview' }).click();
  await page.locator('#quick-run').getByText(/Your preview is running on this computer/).waitFor({ timeout: 180_000 });
  const website = await page.locator('#quick-run').getByRole('link', { name: /Open website/ }).getAttribute('href');
  assert.equal((await fetch(website)).status, 200, 'the opened website answers');

  await page.locator('#quick-run').getByRole('button', { name: 'Stop' }).click();
  await page.locator('#quick-run').getByRole('button', { name: 'Start preview' }).waitFor({ timeout: 60_000 });
  await assert.rejects(fetch(website, { signal: AbortSignal.timeout(5000) }), 'the stopped preview no longer answers');
  assert.deepEqual(errors, []);
});
