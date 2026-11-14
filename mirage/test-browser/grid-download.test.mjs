// @test-kind contract: a Bootstrap 5 list's download button starts an Excel export that the browser saves as a workbook file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { sharedBrowser, accountListAccess } from './shared-browser.mjs';

const chrome = sharedBrowser({ headless: true });

const require = createRequire(import.meta.url);
const SITE = '7c2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c5f';
const CONTACT = 'c3000000-0000-4000-8000-000000000021';
const LIST = '3d000000-0000-4000-8000-000000000021';
const account = (index) => ({
  accountid: `a3000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
  name: `Account ${index}`,
});

// A Bootstrap 5 site with one account list whose toolbar offers the download action (its settings enable it).
async function launch(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'grid-download-browser-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const jquery = await fs.readFile(
    path.join(path.dirname(require.resolve('jquery/package.json')), 'dist', 'jquery.min.js'),
  );
  const settings = { ViewActions: [{ Type: 'CrmEntityFormView-DownloadAction' }] };
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Accounts`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: list',
    'ListPage.pagetemplate.yml': 'adx_pagetemplateid: list\nadx_webtemplateid: listcontent',
    'ListContent.webtemplate.yml': 'adx_webtemplateid: listcontent\nadx_name: List content',
    'ListContent.webtemplate.source.html': `<script src="/jquery.min.js"></script><script src="/resource/powerappsportal/dist/app.BootstrapV5.bundle.js"></script>{% include 'entity_list' key: 'Accounts' %}`,
    'Accounts.list.yml': `adx_entitylistid: ${LIST}\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 3\nadx_searchenabled: true\nadx_settings: '${JSON.stringify(settings)}'`,
    'jquery.min.js.webfile.yml':
      'adx_webfileid: jquery\nadx_name: jquery.min.js\nadx_partialurl: jquery.min.js\nadx_parentpageid: home\nfilename: jquery.min.js',
    'sitesetting.yml':
      '- adx_sitesettingid: 5e300000-0000-4000-8000-000000000021\n  adx_name: Site/BootstrapV5Enabled\n  adx_value: "true"',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  await fs.writeFile(path.join(dir, 'jquery.min.js'), jquery);
  const initial = {
    version: 1,
    mappings: { account: { entitySet: 'accounts', idColumn: 'accountid', nameColumn: 'name' } },
    tables: {
      contact: [{ contactid: CONTACT, fullname: 'Grace' }],
      account: [account(1), account(2), account(3), account(4)],
    },
    ...accountListAccess(CONTACT),
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), initial, watch: false });
  let context;
  ownedFixture(t).add(() => context?.close());
  ownedFixture(t).add(() => app.close());
  context = await chrome.browser.newContext({ acceptDownloads: true });
  await signInContext(context, app, CONTACT, { roles: ['Member'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(`${app.url}/`);
  return { page, grid: page.locator('.entity-grid'), errors };
}

test('a list download button starts an .xlsx download whose file is a ZIP workbook', async (t) => {
  const { page, grid, errors } = await launch(t);
  await grid.locator('tbody tr').first().waitFor();
  const download = page.waitForEvent('download');
  await grid.locator('.entitylist-download').click();
  const file = await download;
  assert.match(file.suggestedFilename(), /\.xlsx$/);
  const saved = await fs.readFile(await file.path());
  // An .xlsx file is a ZIP archive, which starts with the local file header signature "PK".
  assert.equal(saved.subarray(0, 2).toString('latin1'), 'PK');
  assert.deepEqual(errors, []);
});
