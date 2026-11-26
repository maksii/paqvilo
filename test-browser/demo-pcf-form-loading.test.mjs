// @test-kind contract: the demo's PCF account form waits for its code component however long the bundle takes, and reports a bundle that cannot load.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import YAML from 'yaml';
import { prepareDemo } from '../lense/commands/demo.mjs';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { signInContext } from '../mirage/testing.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

const ACCOUNT = 'a4300000-0000-4000-8000-000000001001',
  EDITOR = 'a4300000-0000-4000-8000-000000002001';
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

// Every code component script request: the bundle the component tag's host markup loads from its native
// /_pcfwebresource/ address (as Power Pages writes it), and the copy Mirage's host loads when that one did not register.
const componentScript = (url) =>
  url.pathname.startsWith('/_pcfwebresource/') ||
  (url.pathname.startsWith('/__sim-static/pcf/') && url.pathname.endsWith('.js'));

// The demo's PCF account page for a signed-in editor, with `bundle` deciding every code component script request.
// `host` decides the request for the Mirage component host script; `pageErrors` collects the page's uncaught errors.
// `waitUntil` is the navigation state awaited (the parsed document by default).
async function accountPage(t, bundle, { host = null, pageErrors = null, waitUntil = 'domcontentloaded' } = {}) {
  const demo = path.join(await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-demo-pcf-')), 'demo');
  ownedFixture(t).remove(() => fs.rm(path.dirname(demo), { recursive: true, force: true, maxRetries: 10 }));
  await prepareDemo(demo);
  const { observed } = YAML.parse(await fs.readFile(path.join(demo, 'paqvilo.config.yml'), 'utf8')).sites.example
    .mirage;
  const simulator = await createSimulator({
    sourceDir: path.join(demo, 'portal'),
    watch: false,
    solutionRoots: ['metadata', 'code-solution', 'solution'].map((name) => path.join(demo, name)),
    dataPacks: [{ id: 'example', module: path.join(demo, 'pack/pack.mjs') }],
    preset: 'example-demo',
    observed,
  });
  ownedFixture(t).add(() => simulator.close());
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  await signInContext(context, simulator, EDITOR);
  const page = await context.newPage();
  await page.clock.install();
  if (pageErrors) page.on('pageerror', (error) => pageErrors.push(error));
  await page.route(componentScript, bundle);
  if (host) await page.route('**/__sim-static/pcf-host.js', host);
  // A bundle on its way keeps the document from finishing its load, so at most the parsed document is awaited.
  await page.goto(`${simulator.url}/approach/pcf/account/?id=${ACCOUNT}`, { waitUntil });
  return page;
}

test('the PCF account form becomes ready when its component bundle arrives after any amount of page time', async (t) => {
  let requested, release;
  const arrived = new Promise((resolve) => (requested = resolve)),
    held = new Promise((resolve) => (release = resolve));
  ownedFixture(t).add(() => release());
  // The bundle's script element blocks the parser where the component tag wrote it, so only the response is awaited.
  const page = await accountPage(
    t,
    async (route) => {
      requested();
      await held;
      await route.continue().catch(() => {});
    },
    { waitUntil: 'commit' },
  );
  await arrived;
  // Thirty seconds of the page's own time pass, one timer period at a time, while the bundle is still on its way: the
  // document waits at the component (as on Power Pages) and neither the page nor the host gives up on it.
  for (let period = 0; period < 300; period++) await page.clock.runFor(100);
  assert.equal(await page.evaluate(() => document.readyState), 'loading');
  const status = page.locator('[data-status]');
  assert.equal(await status.evaluate((node) => node.classList.contains('error')), false);
  assert.equal(await page.locator('[data-account-form] [role=alert]').count(), 0);
  release();
  await page.waitForFunction(() => document.querySelector('[data-account-form]')?.dataset.ready === 'true');
  assert.equal(await page.locator('[name=name]').inputValue(), 'Arcwell Services');
});

test('the PCF account form reports a component bundle that cannot load', async (t) => {
  const page = await accountPage(t, (route) => route.abort());
  const failure = page.locator('[data-status].error');
  await failure.waitFor();
  assert.match(await failure.textContent(), /^The PCF control did not load\. /);
  assert.equal(await page.locator('[data-account-form]').getAttribute('data-ready'), 'false');
});

// A bundle that runs but registers no control (as a development build refused by the page script policy does).
test('the PCF account form reports a component its host could not render', async (t) => {
  const page = await accountPage(t, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* registers no control */' }),
  );
  const failure = page.locator('[data-status].error');
  await failure.waitFor();
  assert.match(await failure.textContent(), /^The PCF control did not load\. /);
  assert.equal(await page.locator('[data-account-form]').getAttribute('data-ready'), 'false');
});

test('the PCF account form reports a code component host that did not load', async (t) => {
  const pageErrors = [];
  const page = await accountPage(t, (route) => route.continue(), { host: (route) => route.abort(), pageErrors });
  // The document has parsed, so the container's outcome is already in place; no wait is needed to observe it.
  assert.ok((await page.locator('[data-account-form] [data-mirage-component=codecomponent][role=alert]').count()) > 0);
  assert.deepEqual(pageErrors, []);
  const failure = page.locator('[data-status].error');
  await failure.waitFor();
  assert.match(
    await failure.textContent(),
    /^The PCF control did not load\. The code component host script did not load\./,
  );
  assert.equal(await page.locator('[data-account-form]').getAttribute('data-ready'), 'false');
});
