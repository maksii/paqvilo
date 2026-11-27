// @test-kind observation: hosted session F5 served an uploaded code site in a real browser (four runs, captures code-site-serve-a..d): on the root and on an application route the landing page's scripts run (the inline one with the response nonce under the platform default policy), a raw HTML file's inline script does not run, and WebAssembly.instantiateStreaming fails on the application/octet-stream type
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true, args: ['--disable-background-networking'] }));
});
after(() => browser?.close());

const LANDING =
  '<!doctype html><html><head><title>Invented landing</title><script type="module" src="/assets/app.js"></script></head>' +
  '<body><div id="root"></div><script>document.documentElement.dataset.inline = \'ran\';</script></body></html>';
const APP = [
  'document.documentElement.dataset.app = location.pathname;',
  "WebAssembly.instantiateStreaming(fetch('/assets/feature.wasm')).then(",
  "  () => { document.documentElement.dataset.wasm = 'ok'; },",
  '  (error) => { document.documentElement.dataset.wasm = error.name; },',
  ');',
].join('\n');

async function codeSite(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-browser-code-site-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'powerpages.config.json': JSON.stringify({
      siteName: 'Invented code site',
      compiledPath: 'dist',
      defaultLandingPage: 'index.html',
    }),
    'dist/index.html': LANDING,
    'dist/assets/app.js': APP,
    'dist/assets/feature.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  };
  for (const [relative, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), contents);
  }
  const sim = await createSimulator({
    sourceDir: root,
    port: 0,
    watch: false,
    requirePortalSource: true,
    observed: { defaultContentSecurityPolicy: 'platform', evidence: 'Invented code site capture' },
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

test('the landing page runs on the root and on application routes; a raw HTML file keeps its inline script blocked', async (t) => {
  const sim = await codeSite(t);
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  const state = (name) => page.evaluate((key) => document.documentElement.dataset[key] ?? null, name);
  for (const route of ['/', '/dashboard/settings']) {
    const response = await page.goto(sim.url + route);
    assert.equal(response.status(), 200, route);
    await page.waitForFunction(() => document.documentElement.dataset.wasm);
    assert.equal(await state('inline'), 'ran', route);
    assert.equal(await state('app'), route);
    assert.equal(await state('wasm'), 'TypeError', route);
    assert.equal(await page.evaluate(() => window.Microsoft?.Dynamic365?.Portal?.isSpaSite), 'True', route);
  }
  const raw = await page.goto(sim.url + '/index.html');
  assert.equal(raw.status(), 200);
  await page.waitForFunction(() => document.documentElement.dataset.wasm);
  assert.equal(await state('app'), '/index.html');
  assert.equal(await state('inline'), null, 'the raw file carries a nonce its inline script does not have');
  assert.equal(await page.evaluate(() => window.Microsoft?.Dynamic365?.Portal?.isSpaSite ?? null), null);
});
