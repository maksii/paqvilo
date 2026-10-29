import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';
// Quick setup first run, as a person without configuration knowledge does it: open setup in a folder that only holds a
// portal export, create the project from what was found, start the local preview, open it, and stop it.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import YAML from 'yaml';
import { startSetupServer } from '../lense/setup/server.mjs';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Keep the nominal portal origin occupied while each preview asks the runtime to
// bind its own ephemeral port. This exercises allocation without a probe-close race.
async function ownPorts(config, t) {
  const document = YAML.parse(await fs.readFile(config, 'utf8'));
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  ownedFixture(t).add(
    () => new Promise((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve()))),
  );
  const { port } = occupied.address();
  for (const site of Object.values(document.sites)) {
    site.environments.local = `http://127.0.0.1:${port}`;
    site.mirage.port = 0;
    if (site.mirage.dataverse?.port) site.mirage.dataverse.port = 0;
  }
  await fs.writeFile(config, YAML.stringify(document));
  return { occupied, port };
}
// Waits for the started preview, or fails at once with the reason the page shows when it could not start.
// A status poll that times out on a loaded host shows a recoverable notice and keeps trying; it is not a failure.
async function started(run) {
  const running = run.getByText(/Your preview is running on this computer/);
  const failed = run.getByRole('alert').filter({ hasText: /The preview could not start/ });
  await running.or(failed).first().waitFor({ timeout: 180_000 });
  assert.equal(await running.count(), 1, await run.innerText());
}
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

async function setupFixture(t, prefix) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), prefix));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }));
  await fs.cp(path.join(root, 'examples/project/portal'), path.join(directory, 'exports', 'site'), {
    recursive: true,
  });
  const config = path.join(directory, 'paqvilo.config.yml');
  // Whatever the run leaves behind, the preview this test may have started is stopped.
  ownedFixture(t).add(async () =>
    spawnSync(process.execPath, [path.join(root, 'bin/paqvilo.mjs'), 'mirage', 'stop', '--config', config, '--json'], {
      cwd: directory,
      windowsHide: true,
      timeout: 60_000,
    }),
  );
  const server = await startSetupServer({ directory, processEnv: {} });
  ownedFixture(t).add(() => server.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url);
  return { directory, config, page, errors };
}

test(
  'quick setup creates a project from a found export, starts, opens and stops its preview',
  { timeout: 240_000 },
  async (t) => {
    const { config, page, errors } = await setupFixture(t, 'paqvilo-quick-run-');
    const create = page.locator('form[data-form=quick-create]');
    assert.match(await create.innerText(), /we found 1 website export/);
    assert.equal(await create.getByLabel(/Power Pages website/).isChecked(), true);
    await create.getByRole('button', { name: 'Create project' }).click();
    await page.locator('#quick-files.is-done').waitFor();
    const written = YAML.parse(await fs.readFile(config, 'utf8')),
      name = written.defaultSite;
    assert.equal(written.sites[name].source, 'exports/site');
    assert.equal(written.sites[name].mirage.simulation.level, 'dry-run');
    assert.match(await page.locator('#quick-files .quick-summary').innerText(), /Website: exports\/site/);
    assert.equal(written.sites[name].environments.local, `http://127.0.0.1:${written.sites[name].mirage.port}`);
    const blocked = await ownPorts(config, t);

    await page.locator('#quick-run').getByRole('button', { name: 'Start preview' }).click();
    await started(page.locator('#quick-run'));
    const website = await page
      .locator('#quick-run')
      .getByRole('link', { name: /Open website/ })
      .getAttribute('href');
    assert.notEqual(Number(new URL(website).port), blocked.port);
    assert.equal(blocked.occupied.listening, true);
    assert.equal((await fetch(website)).status, 200, 'the opened website answers');

    await page.locator('#quick-run').getByRole('button', { name: 'Stop' }).click();
    await page.locator('#quick-run').getByRole('button', { name: 'Start preview' }).waitFor({ timeout: 60_000 });
    await assert.rejects(
      fetch(website, { signal: AbortSignal.timeout(5000) }),
      /fetch failed/,
      'the stopped preview no longer answers',
    );
    assert.deepEqual(errors, []);
  },
);

test(
  'All settings creates a project from what to run and the found exports, and starts it from Start & check',
  { timeout: 240_000 },
  async (t) => {
    const { directory, config, page, errors } = await setupFixture(t, 'paqvilo-all-run-');
    await page.getByRole('button', { name: 'All settings' }).click();
    const create = page.locator('form[data-form=create]');
    assert.match(await create.innerText(), /found in this folder: 1 website export/);
    await create.locator('input[name=part][value=api]').check();
    await create.getByRole('button', { name: 'Create settings file' }).click();
    await page
      .locator('#notice')
      .filter({ hasText: /^Saved\. Created/ })
      .waitFor();
    const written = YAML.parse(await fs.readFile(config, 'utf8')),
      name = written.defaultSite,
      site = written.sites[name];
    assert.equal(site.source, 'exports/site');
    assert.equal(site.mirage.runtime.kind, 'power-pages');
    assert.equal(site.mirage.dataverse.enabled, true, 'the ticked Web API is switched on');

    // A data module registered by its path stays a path when the Sample data form is saved, so it keeps the id it declares.
    await fs.mkdir(path.join(directory, 'pack'));
    await fs.writeFile(path.join(directory, 'pack', 'pack.mjs'), '// invented placeholder module\n');
    const plain = { ...written };
    plain.sites[name].mirage.dataPacks = ['./pack/pack.mjs'];
    await fs.writeFile(config, YAML.stringify(plain));
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await page
      .getByRole('navigation', { name: 'Setup stages' })
      .getByRole('link', { name: /Sample data/ })
      .click();
    const form = page.locator(`form[data-form=data][data-site="${name}"]`);
    await page.waitForFunction(
      () => document.querySelector('form[data-form=data] [name=packs]')?.value === './pack/pack.mjs',
    );
    await form.locator('[name=presetMode]').selectOption('bootstrap');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await page
      .locator('#notice')
      .filter({ hasText: /^Saved\./ })
      .waitFor();
    const saved = YAML.parse(await fs.readFile(config, 'utf8')).sites[name];
    assert.deepEqual(saved.mirage.dataPacks, ['./pack/pack.mjs']);
    assert.equal(saved.mirage.presetMode, 'bootstrap');
    delete saved.mirage.dataPacks;
    await fs.writeFile(config, YAML.stringify({ ...plain, sites: { [name]: saved } }));
    const blocked = await ownPorts(config, t);
    await page.getByRole('button', { name: 'Refresh status' }).click();

    await page
      .getByRole('navigation', { name: 'Setup stages' })
      .getByRole('link', { name: /Start & check/ })
      .click();
    const run = page.locator('#guidance-run');
    await run.getByRole('button', { name: 'Start preview' }).click();
    await started(run);
    const website = await run.getByRole('link', { name: /Open website/ }).getAttribute('href');
    assert.notEqual(Number(new URL(website).port), blocked.port);
    assert.equal(blocked.occupied.listening, true);
    assert.equal((await fetch(website)).status, 200);
    assert.match(await run.innerText(), /Dataverse Web API for your scripts and tests/);
    await run.getByRole('button', { name: 'Stop' }).click();
    await run.getByRole('button', { name: 'Start preview' }).waitFor({ timeout: 60_000 });
    assert.deepEqual(errors, []);
  },
);
