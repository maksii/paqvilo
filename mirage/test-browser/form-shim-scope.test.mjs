// @test-kind observation: native portal observed 2026-11-12 on a developer environment (single capture): `String.prototype.trim` and `document.getElementsByClassName` are replaced only on pages that load the basic-form or multistep-form scripts (crmentityformview.js / webform.js); on a list-only page both are native and `getElementsByClassName` returns an HTMLCollection; the overrides are installed by the form scripts themselves
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { widgetFormFiles, widgetFormState, CONTACT } from '../test/support/widget-form.mjs';
import { accountListAccess } from './shared-browser.mjs';

const require = createRequire(import.meta.url);
const SITE = '7e2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c5f';
const LIST = '3e000000-0000-4000-8000-000000000011';

// An invented list-only site: one account list and no form on any page.
function listFiles(scripts = '') {
  return {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Accounts`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: list',
    'ListPage.pagetemplate.yml': 'adx_pagetemplateid: list\nadx_webtemplateid: listcontent',
    'ListContent.webtemplate.yml': 'adx_webtemplateid: listcontent\nadx_name: List content',
    'ListContent.webtemplate.source.html': `<script src="/jquery.min.js"></script>${scripts}{% include 'entity_list' key: 'Accounts' %}`,
    'Accounts.list.yml': `adx_entitylistid: ${LIST}\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 3\nadx_searchenabled: true`,
    'jquery.min.js.webfile.yml':
      'adx_webfileid: jquery\nadx_name: jquery.min.js\nadx_partialurl: jquery.min.js\nadx_parentpageid: home\nfilename: jquery.min.js',
    'sitesetting.yml':
      '- adx_sitesettingid: 5e300000-0000-4000-8000-000000000012\n  adx_name: Site/BootstrapV5Enabled\n  adx_value: "true"',
  };
}

function listState() {
  return {
    version: 1,
    mappings: { account: { entitySet: 'accounts', idColumn: 'accountid', nameColumn: 'name' } },
    tables: {
      account: [
        { accountid: 'a3000000-0000-4000-8000-000000000001', name: 'Account 1' },
        { accountid: 'a3000000-0000-4000-8000-000000000002', name: 'Account 2' },
      ],
    },
    ...accountListAccess(CONTACT),
  };
}

/** Starts the invented site in a fresh browser context and returns the page, routed to the site only. */
async function openSite(t, { files, initial }) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'form-shim-scope-browser-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const jquery = await fs.readFile(
    path.join(path.dirname(require.resolve('jquery/package.json')), 'dist', 'jquery.min.js'),
  );
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  await fs.writeFile(path.join(dir, 'jquery.min.js'), jquery);
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), initial, watch: false });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, app, CONTACT, { roles: ['Member'] });
  const page = await context.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(`${app.url}/`);
  return page;
}

test('list-only pages keep String.prototype.trim and document.getElementsByClassName native', async (t) => {
  const page = await openSite(t, { files: listFiles(), initial: listState() });
  await page.waitForSelector('.entity-grid tbody tr');
  assert.match(await page.evaluate(() => String.prototype.trim.toString()), /\[native code\]/);
  assert.equal(await page.evaluate(() => document.getElementsByClassName('x') instanceof HTMLCollection), true);
});

test('a page without a form whose markup names crmentityformview.js has the replacements', async (t) => {
  const scripts = '<script src="/xrm-adx/js/crmentityformview.js"></script>';
  const page = await openSite(t, { files: listFiles(scripts), initial: listState() });
  await page.waitForSelector('.entity-grid tbody tr');
  assert.doesNotMatch(await page.evaluate(() => String.prototype.trim.toString()), /\[native code\]/);
  assert.equal(await page.evaluate(() => Array.isArray(document.getElementsByClassName('form-control'))), true);
});

test('basic-form pages install the form shims: getElementsByClassName returns an Array and trim is replaced', async (t) => {
  const page = await openSite(t, { files: widgetFormFiles(), initial: widgetFormState() });
  await page.waitForSelector('#jobtitle');
  assert.equal(await page.evaluate(() => Array.isArray(document.getElementsByClassName('form-control'))), true);
  assert.doesNotMatch(await page.evaluate(() => String.prototype.trim.toString()), /\[native code\]/);
});
