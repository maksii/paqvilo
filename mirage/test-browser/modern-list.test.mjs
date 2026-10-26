import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { PAGES_CLIENT_API_SCRIPT } from '../lib/platform.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const SITE = '77777777-7777-4777-8777-777777777701';
const CONTACT = '77777777-7777-4777-8777-777777777702';
const LIST = '77777777-7777-4777-8777-777777777703';
const item = (index) => ({
  x_itemid: `77777777-7777-4777-8777-7777777778${String(index).padStart(2, '0')}`,
  x_name: `Item ${index}`,
  x_rank: index,
  statecode: 0,
});
const VIEW_ALL = '77777777-7777-4777-8777-777777777711',
  VIEW_TOP = '77777777-7777-4777-8777-777777777712';
const savedQuery = (id, name, fetch) =>
  `<savedquery><savedqueryid>{${id}}</savedqueryid><returnedtypecode>x_item</returnedtypecode><querytype>0</querytype><LocalizedNames><LocalizedName description="${name}" languagecode="1033"/></LocalizedNames><fetchxml>${fetch}</fetchxml><layoutxml><grid name="resultset" object="10" jump="x_name" select="1" icon="1" preview="1"><row name="result" id="x_itemid"><cell name="x_name" width="200"/><cell name="x_rank" width="100"/></row></grid></layoutxml></savedquery>`;
// The list features of the modern list (views, search, sort and actions) come from a Solution view pair and list settings.
const SOLUTION = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedLists</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'Entities/x_item/Entity.xml':
    '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute><attribute PhysicalName="x_rank"><Name>x_rank</Name><Type>int</Type><displaynames><displayname description="Rank" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
  [`Entities/x_item/SavedQueries/{${VIEW_ALL}}.xml`]: savedQuery(
    VIEW_ALL,
    'All items',
    '<fetch><entity name="x_item"><attribute name="x_itemid"/><attribute name="x_name"/><attribute name="x_rank"/><order attribute="x_name"/></entity></fetch>',
  ),
  [`Entities/x_item/SavedQueries/{${VIEW_TOP}}.xml`]: savedQuery(
    VIEW_TOP,
    'Top items',
    '<fetch><entity name="x_item"><attribute name="x_itemid"/><attribute name="x_name"/><attribute name="x_rank"/><filter><condition attribute="x_rank" operator="ge" value="5"/></filter><order attribute="x_rank" descending="true"/></entity></fetch>',
  ),
};
const FEATURE_LIST = [
  `adx_view: ${VIEW_ALL}`,
  `adx_views: '{"Views":[{"ViewId":"${VIEW_ALL}","DisplayName":"All items"},{"ViewId":"${VIEW_TOP}","DisplayName":"Top items"}]}'`,
  'adx_searchenabled: true',
  `adx_settings: '{"ItemActions":[{"Type":"CrmEntityFormView-DeleteAction"}],"ViewActions":[{"Type":"CrmEntityFormView-DownloadAction"}]}'`,
].join('\n');

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

// One x_item list (page size 3) included twice on the home page, as a modern and a classic list.
async function launch(t, { operations = ['read'], features = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modern-list-browser-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const solutionDir = path.join(dir, 'solution');
  if (features)
    for (const [name, body] of Object.entries(SOLUTION)) {
      await fs.mkdir(path.dirname(path.join(solutionDir, name)), { recursive: true });
      await fs.writeFile(path.join(solutionDir, name), body);
    }
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented lists`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: list',
    'ListPage.pagetemplate.yml': 'adx_pagetemplateid: list\nadx_webtemplateid: listcontent',
    'ListContent.webtemplate.yml': 'adx_webtemplateid: listcontent\nadx_name: List content',
    'ListContent.webtemplate.source.html': `<div id="modern">{% include 'entity_list' key: 'Items' isModern: 'true' %}</div><div id="classic">{% include 'entity_list' key: 'Items' %}</div>
<script>window.loadedPages=[];window.clicked=[];Microsoft.PowerPages.onPagesClientApiReady(function($pages){var list=$pages.currentPage.lists.getAll().find(function(l){return l.isModern;});
list.on('loaded',function(e){window.loadedPages.push(e.rows.length);var column=list.getColumn('x_name');if(column)column.setHeader(column.getDisplayName()+' *');});
list.on('rowclick',function(e){window.clicked.push(e.row.getId());});window.pagesReady=true;});</script>`,
    'Items.list.yml': `adx_entitylistid: ${LIST}\nadx_name: Items\nadx_entityname: x_item\nadx_pagesize: 3${features ? '\n' + FEATURE_LIST : ''}`,
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const initial = {
    version: 1,
    mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' } },
    tables: {
      contact: [{ contactid: CONTACT, fullname: 'Invented Contact', statecode: 0 }],
      x_item: Array.from({ length: 7 }, (_, index) => item(index + 1)),
    },
    permissions: [{ id: 'x_item', entity: 'x_item', scope: 'global', roles: ['Member'], operations }],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      identity: { id: CONTACT, contactId: CONTACT, roles: ['Member'] },
      live: { origin: null },
      endpoints: [],
    },
  };
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    initial,
    watch: false,
    port: 0,
    ...(features ? { solutionRoots: [solutionDir] } : {}),
  });
  ownedFixture(t).add(() => app.close());
  const context = await browser.newContext({ viewport: { width: 800, height: 120 } });
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, CONTACT, { roles: ['Member'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bodies = [];
  page.on(
    'request',
    (request) => request.url().includes('/_services/entity-grid-data.json/') && bodies.push(request.postDataJSON()),
  );
  // The client API comes from the host (inline beside the platform bundles, else at PAGES_CLIENT_API_SCRIPT), never from a test route.
  const script = await fetch(app.url + PAGES_CLIENT_API_SCRIPT);
  const served = [[script.status, script.headers.get('content-type')]];
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.fallback() : route.abort()));
  await page.goto(`${app.url}/`);
  await page.waitForFunction(() => window.pagesReady === true);
  return { page, errors, bodies, served, app };
}

test('a modern list continues the secured list query on scroll and publishes rows through $pages', async (t) => {
  const { page, errors, bodies, served } = await launch(t);
  assert.ok(
    served.some(([status, type]) => status === 200 && /javascript/.test(type)),
    JSON.stringify(served),
  );
  const modern = page.locator('#modern [data-pp-modern-list]');
  await modern.locator('tbody tr').first().waitFor();
  // The first page holds the list's page size; later pages follow while the end of the list is in view.
  assert.equal((await page.evaluate(() => window.loadedPages))[0], 3);
  // Scrolling to the end loads the next pages until the query has no more records: every scroll to the sentinel
  // publishes one more loaded page, and a sentinel still in view continues by itself.
  for (let attempt = 0; attempt < 2 && (await modern.locator('tbody tr').count()) < 7; attempt++) {
    const loaded = await page.evaluate(() => window.loadedPages.length);
    await modern.locator('[data-pp-modern-list-more]').scrollIntoViewIfNeeded();
    await page.waitForFunction((loaded) => window.loadedPages.length > loaded, loaded);
  }
  assert.deepEqual(
    await modern.locator('tbody tr td:first-child').allInnerTexts(),
    Array.from({ length: 7 }, (_, index) => `Item ${index + 1}`),
  );
  assert.deepEqual(await page.evaluate(() => window.loadedPages), [3, 6, 7]);
  // One secured query continued page by page (the classic list on the page posts its own first page).
  assert.deepEqual(
    bodies.filter((body) => body.page > 1).map((body) => [body.page, body.pageSize]),
    [
      [2, 3],
      [3, 3],
    ],
  );
  // The column header change from the loaded handler is idempotent (get methods return the source data).
  assert.equal(await modern.locator('thead th').first().innerText(), 'x_name *');

  const lists = await page.evaluate(() =>
    window.__paqviloPages.currentPage.lists.getAll().map((list) => ({
      modern: list.isModern,
      rows: list.rows.length,
      columns: list.columns.length,
      column: list.getColumn('x_name') === undefined,
    })),
  );
  assert.deepEqual(lists, [
    { modern: true, rows: 7, columns: 1, column: false },
    { modern: false, rows: 0, columns: 0, column: true },
  ]);
  await modern.locator('tbody tr').nth(1).locator('td').first().click();
  assert.deepEqual(await page.evaluate(() => window.clicked), [item(2).x_itemid]);
  assert.deepEqual(errors, []);
});

test('a modern list without read permission shows the access-denied message', async (t) => {
  const { page, errors } = await launch(t, { operations: ['update'] });
  await page.locator('#modern .view-access-denied:not([hidden])').waitFor();
  assert.equal(await page.locator('#modern tbody tr').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.loadedPages), []);
  assert.deepEqual(errors, []);
});

test('a modern list searches, sorts, switches views and runs the delete action through the classic grid engine', async (t) => {
  const { page, errors, bodies, app } = await launch(t, { operations: ['read', 'delete'], features: true });
  const modern = page.locator('#modern [data-pp-modern-list]');
  // Every expected row list is only produced by the restarted query, so it marks that query as applied.
  const until = (expected) =>
    page.waitForFunction(
      (expected) =>
        JSON.stringify(
          [...document.querySelectorAll('#modern [data-pp-modern-list] tbody tr td:first-child')].map(
            (cell) => cell.innerText,
          ),
        ) === JSON.stringify(expected),
      expected,
    );
  await until(['Item 1', 'Item 2', 'Item 3']);
  // The toolbar comes from the list definition: a view selector over both views, the search box and the download action.
  assert.deepEqual(await modern.locator('[data-pp-modern-list-view] option').allInnerTexts(), [
    'All items',
    'Top items',
  ]);
  assert.equal(await modern.locator('[data-pp-modern-list-actions] [data-action-type="8"]').count(), 1);
  // Sorting: the header toggles the view's own order (x_name ASC) to descending.
  await modern.locator('thead th').first().locator('button').click();
  await until(['Item 7', 'Item 6', 'Item 5']);
  assert.equal(bodies.at(-1).sortExpression, 'x_name DESC');
  // Search: the grid's search parameter over the view's text columns.
  await modern.locator('[data-pp-modern-list-search]').fill('Item 3');
  await modern.locator('[data-pp-modern-list-search]').press('Enter');
  await until(['Item 3']);
  assert.equal(bodies.at(-1).search, 'Item 3');
  // A second view: its own filter and order, the search cleared.
  await modern.locator('[data-pp-modern-list-search]').fill('');
  await modern.locator('[data-pp-modern-list-search]').press('Enter');
  await modern.locator('[data-pp-modern-list-view]').selectOption(VIEW_TOP);
  await until(['Item 7', 'Item 6', 'Item 5']);
  assert.deepEqual((await modern.locator('thead th').allInnerTexts()).slice(0, 2), ['Name *', 'Rank']);
  // The delete item action posts to the grid delete route after the confirmation, then the list restarts.
  page.once('dialog', (dialog) => dialog.accept());
  await modern.locator('tbody tr').nth(1).locator('[data-action-type="4"]').click();
  await until(['Item 7', 'Item 5']);
  assert.equal(
    app.store.tableRows('x_item').some((row) => row.x_name === 'Item 6'),
    false,
  );
  assert.deepEqual(errors, []);
});
