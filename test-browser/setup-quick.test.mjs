// @test-kind contract: Lense setup quick first run creates a project from a found export and starts, opens and stops its preview
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
import { launchRenderingBrowser } from './helpers/lense-rendering-browser.mjs';
import YAML from 'yaml';
import { startSetupServer } from '../lense/setup/server.mjs';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { recordedRuntimeOwner } from '../test/helpers/mirage-runtimes.mjs';
import { runningRuntimeOrigins } from './helpers/mirage-status.mjs';
import { setupNotice } from './helpers/setup-notice.mjs';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner
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
// No clock bounds the wait: the test's timeout is the hang guard.
async function started(run) {
  const running = run.getByText(/Your preview is running on this computer/);
  const failed = run.getByRole('alert').filter({ hasText: /The preview could not start/ });
  // The first state observed decides; a later poll may redraw a running preview as "starting". If both waits fail
  // (the page or browser closed), the AggregateError is the test's failure.
  const outcome = await Promise.any([running.waitFor().then(() => 'running'), failed.waitFor().then(() => 'failed')]);
  assert.equal(outcome, 'running', await run.innerText().catch((error) => error.message));
}
let browser;
before(async () => {
  browser = await launchRenderingBrowser(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

async function setupFixture(t, prefix, hash = '') {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), prefix));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }));
  await fs.cp(path.join(root, 'examples/project/portal'), path.join(directory, 'exports', 'site'), {
    recursive: true,
  });
  const config = path.join(directory, 'paqvilo.config.yml');
  // Whatever the run leaves behind, the preview this test may have started is stopped.
  ownedFixture(t).add(async () => {
    const runtimes = recordedRuntimeOwner(path.join(directory, '.paqvilo', 'mirage', 'sessions.json'), {
      report: (line) => t.diagnostic(line),
    });
    await runtimes.note();
    spawnSync(process.execPath, [path.join(root, 'bin/paqvilo.mjs'), 'mirage', 'stop', '--config', config, '--json'], {
      cwd: directory,
      windowsHide: true,
      timeout: CLI_HANG_GUARD_MS,
    });
    // Whatever the stop left running, although it may have removed its record.
    await runtimes.end();
  });
  const server = await startSetupServer({ directory, processEnv: {} });
  ownedFixture(t).add(() => server.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url + hash);
  return { directory, config, page, errors };
}

test('quick setup creates a project from a found export, starts, opens and stops its preview', async (t) => {
  const { directory, config, page, errors } = await setupFixture(t, 'paqvilo-quick-run-');
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
  // The project's own records say whether its preview runs; its released port may already answer for another process.
  const running = () => runningRuntimeOrigins(['--config', config], { cwd: directory, signal: t.signal });
  assert.ok((await running()).includes(new URL(website).origin), 'the started preview is recorded as running');

  await page.locator('#quick-run').getByRole('button', { name: 'Stop' }).click();
  await page.locator('#quick-run').getByRole('button', { name: 'Start preview' }).waitFor();
  assert.ok(!(await running()).includes(new URL(website).origin), 'the stopped preview no longer runs');
  assert.deepEqual(errors, []);
});

// @test-kind contract: a Setup repaint waits for the current stage link's click even when a previous release is pending
test('a delayed Refresh release leaves the next pressed stage link in place', async (t) => {
  const { page } = await setupFixture(t, 'paqvilo-refresh-press-', '#overview');
  const link = page.getByRole('navigation', { name: 'Setup stages' }).getByRole('link', { name: /Sample data/ });
  await link.waitFor();

  // Hold the previous click's deferred release until the next pointer press is in progress.
  const held = await page.evaluateHandle(() => {
    const nativeTimeout = globalThis.setTimeout;
    const releases = [];
    globalThis.addEventListener(
      'pointerup',
      () => {
        globalThis.setTimeout = (fn, delay, ...args) => {
          if (delay !== undefined) return nativeTimeout(fn, delay, ...args);
          releases.push(() => fn(...args));
          return 0;
        };
      },
      { capture: true, once: true },
    );
    globalThis.addEventListener('pointerup', () => (globalThis.setTimeout = nativeTimeout), { once: true });
    return releases;
  });
  const status = Promise.withResolvers();
  await page.route(
    '**/_setup/api/status',
    async (route) => {
      await status.promise;
      await route.continue();
    },
    { times: 1 },
  );
  try {
    await page.getByRole('button', { name: 'Refresh status' }).click();
    const box = await link.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const gate = await page.evaluateHandle(() => {
      const reads = new Set(['/_setup/api/quick', '/_setup/api/preview']);
      const parse = Response.prototype.json;
      const channel = new MessageChannel();
      const handled = new Promise((resolve) => {
        channel.port1.onmessage = () => {
          channel.port1.close();
          channel.port2.close();
          resolve();
        };
      });
      Response.prototype.json = async function (...args) {
        const data = await Reflect.apply(parse, this, args);
        if (reads.delete(new URL(this.url).pathname) && !reads.size) {
          Response.prototype.json = parse;
          // Setup's continuations consume both bodies before this browser task runs.
          channel.port2.postMessage(null);
        }
        return data;
      };
      return { handled };
    });
    await held.evaluate(([release]) => release());
    status.resolve();
    await gate.evaluate(({ handled }) => handled);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => location.hash), '#packs', 'the pressed Sample data link opened its stage');
  } finally {
    status.resolve();
  }
});

test('All settings creates a project from what to run and the found exports, and starts it from Start & check', async (t) => {
  const { directory, config, page, errors } = await setupFixture(t, 'paqvilo-all-run-');
  await page.getByRole('button', { name: 'All settings' }).click();
  const create = page.locator('form[data-form=create]');
  assert.match(await create.innerText(), /found in this folder: 1 website export/);
  await create.locator('input[name=part][value=api]').check();
  await create.getByRole('button', { name: 'Create settings file' }).click();
  await setupNotice(page, /^Saved\. Created/);
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
  await setupNotice(page, /^Saved\./);
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
  // The address is listed once a status read of the preview has answered; a busy preview answers a later read.
  await run.getByText(/Dataverse Web API for your scripts and tests/).waitFor();
  await run.getByRole('button', { name: 'Stop' }).click();
  await run.getByRole('button', { name: 'Start preview' }).waitFor();
  assert.deepEqual(errors, []);
});
