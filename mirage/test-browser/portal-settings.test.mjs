import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';

test('admin edits, removes and resets snippets through controls, rendering and retaining changes locally', { timeout: 45000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-admin-values-'));
  let app, browser;
  t.after(async () => { await browser?.close(); await app?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Test',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html': '<html><body><h1>{{ snippets.Greeting }}</h1></body></html>',
    'content-snippets/Greeting.contentsnippet.yml': 'adx_contentsnippetid: greeting\nadx_name: Greeting',
    'content-snippets/Greeting.contentsnippet.value.html': 'Exported greeting',
  };
  for (const [name, content] of Object.entries(files)) { const file = path.join(directory, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  app = await createSimulator({ sourceDir: directory, stateFile: path.join(directory, 'state.json'), watch: false });
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url + '/_sim/#portal');
  const row = page.locator('tr').filter({ hasText: 'Greeting' });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#editor-json').fill(JSON.stringify({ name: 'Greeting', value: 'Local greeting' }));
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await row.getByText('Local greeting', { exact: true }).waitFor();
  assert.match(await (await fetch(app.url)).text(), /Local greeting/);
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#editor-json').fill(JSON.stringify({ name: 'Greeting', value: null }));
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await row.getByText('Removed locally', { exact: true }).waitFor();
  assert.doesNotMatch(await (await fetch(app.url)).text(), /Local greeting|Exported greeting/);
  await row.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.locator('#confirm-submit').click();
  await row.getByText('Exported greeting', { exact: true }).waitFor();
  assert.match(await (await fetch(app.url)).text(), /Exported greeting/);
  assert.deepEqual(errors, []);
});
