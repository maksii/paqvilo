// @test-kind observation: hosted session F3 (two runs, summary-F3.md PAGE-06e) captured the PWAFeature manifest link, the /js/sw.js registration with Service-Worker-Allowed and the unregister script; an invented site replays them in a real browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createSimulator } from '../mirage/server.mjs';
import { ownedFixture, makeTemporaryDirectory, assertTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';

test('an enabled PWAFeature registers the local /js/sw.js worker for the site scope; disabled unregisters it', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-pwa-browser-'));
  ownedFixture(t).remove(async () => {
    const physical = await assertTemporaryDirectory(directory, { directChild: true });
    await fs.rm(physical, { recursive: true, force: true });
  });
  const files = {
    'website.yml': 'adx_websiteid: invented-pwa-site\nadx_name: Invented PWA site',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html': '<p id="invented-copy">Ordinary page</p>',
    'sitesetting.yml': '- adx_sitesettingid: pwa\n  adx_name: PWAFeature\n  adx_value: \'{"status":"enable"}\'',
  };
  for (const [name, source] of Object.entries(files)) {
    const destination = path.join(directory, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, source);
  }
  const app = await createSimulator({
    sourceDir: directory,
    stateFile: path.join(directory, 'state.json'),
    port: 0,
    watch: false,
  });
  ownedFixture(t).add(() => app.close());
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  const browser = await chromium.launch({
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    args: ['--disable-background-networking', '--disable-sync'],
  });
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext();
  const origin = new URL(app.url).origin;
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.fallback() : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(app.url + '/');
  assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'), '/PWAManifest.json');
  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return { scope: ready.scope, script: ready.active.scriptURL };
  });
  assert.equal(registration.scope, origin + '/');
  assert.match(registration.script, /\/js\/sw\.js\?languageCode=\/&version=v[0-9a-f-]{36}$/);
  // The worker handles no request: the page still answers from the simulator.
  await page.reload();
  assert.equal(await page.locator('#invented-copy').textContent(), 'Ordinary page');

  const key = Object.keys(app.portal.settings).find((name) => name.toLowerCase() === 'pwafeature');
  const setting = app.portal.settings[key];
  app.portal.settings[key] =
    setting && typeof setting === 'object' ? { ...setting, value: '{"status":"disable"}' } : '{"status":"disable"}';
  await page.reload();
  assert.equal(await page.locator('link[rel="manifest"]').count(), 0);
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length === 0);
});
