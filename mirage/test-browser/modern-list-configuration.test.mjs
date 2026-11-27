// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01d (lists.json, lists-bs3.json and map.json, runs a and b, 2026-11-26): a modern list include is pages-native-container with pages-grid, its grid reads GET /_services/portal/GetListViewConfiguration/<list> and the entity-grid-data pages with odataFilterQuery and nlSearchFilter, a map list included as modern renders its view's grid, and the page-control tag form renders nothing; replayed on invented loopback fixtures
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext, signInHeaders } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '71000000-0000-4000-8000-000000000001';
const CONTACT = '71000000-0000-4000-8000-000000000002';
const LIST = '71000000-0000-4000-8000-000000000003';
const MAP_LIST = '71000000-0000-4000-8000-000000000004';
const CALENDAR_LIST = '71000000-0000-4000-8000-000000000005';
const PLAIN_LIST = '71000000-0000-4000-8000-000000000006';
const COMPONENT_LIST = '71000000-0000-4000-8000-000000000007';
const VIEW_ALL = '71000000-0000-4000-8000-000000000011',
  VIEW_RANK = '71000000-0000-4000-8000-000000000012';
const savedQuery = (id, name, order) =>
  `<savedquery><savedqueryid>{${id}}</savedqueryid><returnedtypecode>x_spot</returnedtypecode><querytype>0</querytype><LocalizedNames><LocalizedName description="${name}" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="x_spot"><attribute name="x_spotid"/><attribute name="x_name"/><attribute name="x_rank"/>${order}</entity></fetch></fetchxml><layoutxml><grid name="resultset" object="10" jump="x_name" select="1" icon="1" preview="1"><row name="result" id="x_spotid"><cell name="x_name" width="200"/><cell name="x_rank" width="100"/></row></grid></layoutxml></savedquery>`;
const SOLUTION = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedSpots</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'Entities/x_spot/Entity.xml':
    '<Entity><Name>x_spot</Name><EntityInfo><entity Name="x_spot"><EntitySetName>x_spots</EntitySetName><PrimaryIdAttribute>x_spotid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_spotid"><Name>x_spotid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute><attribute PhysicalName="x_rank"><Name>x_rank</Name><Type>int</Type><displaynames><displayname description="Rank" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
  [`Entities/x_spot/SavedQueries/{${VIEW_ALL}}.xml`]: savedQuery(VIEW_ALL, 'All spots', '<order attribute="x_name"/>'),
  [`Entities/x_spot/SavedQueries/{${VIEW_RANK}}.xml`]: savedQuery(
    VIEW_RANK,
    'Spots by rank',
    '<order attribute="x_rank" descending="true"/>',
  ),
};
const PAGES_GRID = (list) =>
  `<pages-grid list-id="${list}" table-style="" row-style="" header-style="" table-stripes="" ai-insights-enabled="false" ai-insights-title="AI Insights" ai-insights-expanded="true" ai-custom-prompt="" ai-chart-types="" ai-summary-heading-style="" ai-summary-content-style="" ai-insights-style="" ai-insights-position="top" nl-search-enabled="false" enable-streaming="true" name="Grid_1"></pages-grid></pages-native-container>`;

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

async function launch(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'modern-list-configuration-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const solutionDir = path.join(dir, 'solution');
  for (const [name, body] of Object.entries(SOLUTION)) {
    await fs.mkdir(path.dirname(path.join(solutionDir, name)), { recursive: true });
    await fs.writeFile(path.join(solutionDir, name), body);
  }
  const page = (id, url, copy) => [
    [
      `${id}.webpage.yml`,
      `adx_webpageid: ${id}\nadx_name: ${id}\nadx_partialurl: ${url}\nadx_isroot: true\nadx_pagetemplateid: shell`,
    ],
    [`${id}.webtemplate.yml`, `adx_webtemplateid: ${id}\nadx_name: ${id}`],
    [`${id}.webtemplate.source.html`, copy],
  ];
  const files = Object.fromEntries([
    ['website.yml', `adx_websiteid: ${SITE}\nadx_name: Invented spots`],
    ['Shell.pagetemplate.yml', 'adx_pagetemplateid: shell\nadx_webtemplateid: home'],
    ...page('home', '/', "{% include 'entity_list' key: 'Spots' isModern: 'true' %}"),
    ['Map.pagetemplate.yml', 'adx_pagetemplateid: map\nadx_webtemplateid: map'],
    ['Control.pagetemplate.yml', 'adx_pagetemplateid: control\nadx_webtemplateid: control'],
    ['Dates.pagetemplate.yml', 'adx_pagetemplateid: dates\nadx_webtemplateid: dates'],
    [
      'dates.webpage.yml',
      'adx_webpageid: dates\nadx_name: Dates\nadx_partialurl: dates\nadx_isroot: true\nadx_pagetemplateid: dates',
    ],
    ['dates.webtemplate.yml', 'adx_webtemplateid: dates\nadx_name: Dates'],
    [
      'dates.webtemplate.source.html',
      "{% include 'entity_list' key: 'Spot calendar' isModern: 'true' %}{% include 'entity_list' key: 'Spot grid' isModern: 'true' %}",
    ],
    [
      'map.webpage.yml',
      'adx_webpageid: map\nadx_name: Map\nadx_partialurl: map\nadx_isroot: true\nadx_pagetemplateid: map',
    ],
    ['map.webtemplate.yml', 'adx_webtemplateid: map\nadx_name: Map'],
    [
      'map.webtemplate.source.html',
      "{% include 'entity_list' key: 'Spot map' isModern: 'true' %}{% include 'entity_list' key: 'Spot calendar' isModern: 'true' %}{% include 'entity_list' key: 'Spot plain' %}",
    ],
    [
      'control.webpage.yml',
      'adx_webpageid: control\nadx_name: Control\nadx_partialurl: control\nadx_isroot: true\nadx_pagetemplateid: control',
    ],
    ['control.webtemplate.yml', 'adx_webtemplateid: control\nadx_name: Control'],
    [
      'control.webtemplate.source.html',
      `<main>{% entitylist id: '${LIST}', pp_page_control: true %}{% endentitylist %}</main>`,
    ],
    [
      'Spots.list.yml',
      [
        `adx_entitylistid: ${LIST}`,
        'adx_name: Spots',
        'adx_entityname: x_spot',
        'adx_pagesize: 3',
        `adx_view: ${VIEW_ALL}`,
        `adx_views: '{"Type":"ViewMetadata","Views":[{"Type":"View","ViewId":"${VIEW_ALL}","DisplayName":[{"Type":"LanguageResources","LCID":1033,"Value":"All spots"}]},{"Type":"View","ViewId":"${VIEW_RANK}","DisplayName":[{"Type":"LanguageResources","LCID":1033,"Value":"Spots by rank"}]}]}'`,
        'adx_searchenabled: true',
        `adx_settings: '{"Type":"CrmEntityFormView-GridMetadata","ItemActions":[{"Type":"CrmEntityFormView-DeleteAction"}],"ExtendedItemActions":[{"Type":"WorkflowAction","Workflow":{"Id":"71000000-0000-4000-8000-000000000099","LogicalName":"workflow"}}]}'`,
      ].join('\n'),
    ],
    [
      'Spot-calendar.list.yml',
      `adx_entitylistid: ${CALENDAR_LIST}\nadx_name: Spot calendar\nadx_entityname: x_spot\nadx_pagesize: 3\nadx_view: ${VIEW_ALL}\nadx_calendar_enabled: true\nadx_calendar_startdatefieldname: x_name\nadx_calendar_summaryfieldname: x_name`,
    ],
    [
      'Spot-grid.list.yml',
      `adx_entitylistid: ${COMPONENT_LIST}\nadx_name: Spot grid\nadx_entityname: x_spot\nadx_pagesize: 3\nadx_view: ${VIEW_ALL}\nadx_iscodecomponent: true`,
    ],
    [
      'Spot-plain.list.yml',
      `adx_entitylistid: ${PLAIN_LIST}\nadx_name: Spot plain\nadx_entityname: x_spot\nadx_view: ${VIEW_ALL}`,
    ],
    [
      'Spot-map.list.yml',
      `adx_entitylistid: ${MAP_LIST}\nadx_name: Spot map\nadx_entityname: x_spot\nadx_pagesize: 3\nadx_view: ${VIEW_RANK}\nadx_map_enabled: true\nadx_map_latitudefieldname: x_rank\nadx_map_longitudefieldname: x_rank`,
    ],
  ]);
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const app = await createSimulator({
    sourceDir: dir,
    initial: {
      version: 1,
      mappings: { x_spot: { entitySet: 'x_spots', idColumn: 'x_spotid', nameColumn: 'x_name' } },
      tables: {
        contact: [{ contactid: CONTACT, fullname: 'Invented Contact', statecode: 0 }],
        x_spot: Array.from({ length: 5 }, (_, index) => ({
          x_spotid: `71000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
          x_name: `Spot ${index + 1}`,
          x_rank: index + 1,
          statecode: 0,
        })),
      },
      permissions: [{ id: 'x_spot', entity: 'x_spot', scope: 'global', roles: ['Member'], operations: ['read'] }],
      settings: { permissionMode: 'enforce' },
    },
    watch: false,
    port: 0,
    solutionRoots: [solutionDir],
  });
  ownedFixture(t).add(() => app.close());
  return app;
}

/** A signed-in page of the fixture site that records the configuration and grid data requests it sends. */
async function openSignedIn(t, app, pathname) {
  const context = await browser.newContext({ viewport: { width: 800, height: 2000 } });
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, CONTACT, { roles: ['Member'] });
  const page = await context.newPage();
  const errors = [],
    calls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^\/_services\/(portal\/GetListViewConfiguration|entity-grid-data\.json)\//.test(url.pathname))
      calls.push([request.method(), url.pathname, request.method() === 'POST' ? request.postDataJSON() : null]);
  });
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.fallback() : route.abort()));
  await page.goto(`${app.url}${pathname}`);
  return { page, errors, calls };
}

test('a modern list is pages-native-container with pages-grid and reads its configuration and data as hosted', async (t) => {
  const app = await launch(t);
  const session = signInHeaders(app, CONTACT, { roles: ['Member'] });
  const html = await (await fetch(app.url + '/', { headers: session })).text();
  assert.match(html, /<pages-native-container><div id="list_[^"]+" class="pp-modern-list"/);
  assert.ok(html.includes(PAGES_GRID(LIST)), 'the pages-grid element names the list');
  assert.doesNotMatch(html, /class="entitylist"|data-view-layouts/);
  // The configuration route: the captured keys, indented with CRLF, the layouts without their queries.
  const response = await fetch(`${app.url}/_services/portal/GetListViewConfiguration/${LIST}`, { headers: session });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const text = await response.text();
  assert.match(text, /^\{\r\n {2}"filterenabled": false,\r\n/);
  const configuration = JSON.parse(text);
  assert.deepEqual(Object.keys(configuration), [
    'filterenabled',
    'getDataUrl',
    'getAiInsightsUrl',
    'layouts',
    'defaultViewId',
    'modalFormTemplateUrl',
  ]);
  assert.deepEqual(
    [configuration.getDataUrl, configuration.getAiInsightsUrl, configuration.defaultViewId],
    [`/_services/entity-grid-data.json/${SITE}`, `/_services/entity-grid-ai-summary.json/${SITE}`, VIEW_ALL],
  );
  assert.equal(configuration.modalFormTemplateUrl, `/_portal/modal-form-template-path/${SITE}`);
  assert.deepEqual(
    configuration.layouts.map((layout) => [
      Object.keys(layout),
      layout.Id,
      layout.SortExpression,
      layout.Configuration.ViewDisplayName,
      layout.Configuration.ViewName,
      layout.Configuration.FetchXml,
      layout.Configuration.LayoutXml,
      layout.Configuration.ItemActionLinks.map((link) => link.Type),
    ]),
    [
      [
        [
          'Configuration',
          'Base64SecureConfiguration',
          'ViewName',
          'Columns',
          'ColumnsTotalWidth',
          'SortExpression',
          'Id',
        ],
        VIEW_ALL,
        'x_name ASC',
        'All spots',
        null,
        null,
        null,
        [4],
      ],
      [
        [
          'Configuration',
          'Base64SecureConfiguration',
          'ViewName',
          'Columns',
          'ColumnsTotalWidth',
          'SortExpression',
          'Id',
        ],
        VIEW_RANK,
        'x_rank DESC',
        'Spots by rank',
        null,
        null,
        null,
        [4],
      ],
    ],
  );
  // The page reads the configuration, then the data pages with the hosted modern list's body.
  const { page, errors, calls } = await openSignedIn(t, app, '/');
  await page.waitForFunction(() => document.querySelectorAll('pages-native-container tbody tr').length === 5);
  assert.deepEqual(
    calls.map(([method, pathname]) => [method, pathname]),
    [
      ['GET', `/_services/portal/GetListViewConfiguration/${LIST}`],
      ['POST', `/_services/entity-grid-data.json/${SITE}`],
      ['POST', `/_services/entity-grid-data.json/${SITE}`],
    ],
  );
  const [, , first] = calls[1];
  assert.deepEqual(Object.keys(first), [
    'base64SecureConfiguration',
    'sortExpression',
    'search',
    'page',
    'pageSize',
    'filter',
    'metaFilter',
    'timezoneOffset',
    'customParameters',
    'odataFilterQuery',
    'nlSearchFilter',
  ]);
  assert.deepEqual(
    { ...first, base64SecureConfiguration: undefined, timezoneOffset: undefined },
    {
      base64SecureConfiguration: undefined,
      sortExpression: 'x_name ASC',
      search: '',
      page: 1,
      pageSize: 3,
      filter: null,
      metaFilter: '',
      timezoneOffset: undefined,
      customParameters: [],
      odataFilterQuery: '',
      nlSearchFilter: '',
    },
  );
  assert.equal(calls[2][2].page, 2);
  assert.deepEqual(errors, []);
});

test('a map list included as modern renders its view as a modern grid, and the page-control tag form renders nothing', async (t) => {
  const app = await launch(t);
  const session = signInHeaders(app, CONTACT, { roles: ['Member'] });
  const map = await (await fetch(app.url + '/map/', { headers: session })).text();
  assert.ok(map.includes(PAGES_GRID(MAP_LIST)));
  assert.doesNotMatch(map, /entity-list-map|pp-map-list/);
  const configuration = await (
    await fetch(`${app.url}/_services/portal/GetListViewConfiguration/${MAP_LIST}`, { headers: session })
  ).json();
  assert.deepEqual(
    configuration.layouts.map((layout) => layout.Id),
    [VIEW_RANK],
  );
  const control = await (await fetch(app.url + '/control/', { headers: session })).text();
  assert.match(control, /<main><\/main>/);
});

// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01f (modernlists.json, runs a and b, 2026-11-27): a calendar list and a dataset code component list included as modern render pages-native-container with pages-grid, read GetListViewConfiguration (their view's layouts) and the entity-grid-data pages, and the page loads no calendar resources and no code component
test('a calendar and a dataset code component list included as modern render and read the modern grid of their view', async (t) => {
  const app = await launch(t);
  const session = signInHeaders(app, CONTACT, { roles: ['Member'] });
  const html = await (await fetch(app.url + '/dates/', { headers: session })).text();
  assert.ok(html.includes(PAGES_GRID(CALENDAR_LIST)), 'calendar list');
  assert.ok(html.includes(PAGES_GRID(COMPONENT_LIST)), 'code component list');
  assert.doesNotMatch(html, /data-view="calendar"|\/Areas\/EntityList\/|_pcfwebresource|class="entitylist"/);
  for (const list of [CALENDAR_LIST, COMPONENT_LIST]) {
    const configuration = await (
      await fetch(`${app.url}/_services/portal/GetListViewConfiguration/${list}`, { headers: session })
    ).json();
    assert.deepEqual(
      [configuration.defaultViewId, configuration.layouts.map((layout) => layout.Id)],
      [VIEW_ALL, [VIEW_ALL]],
    );
  }
  const { page, errors, calls } = await openSignedIn(t, app, '/dates/');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('pages-native-container')].every((c) => c.querySelectorAll('tbody tr').length === 5),
  );
  assert.deepEqual(
    [...new Set(calls.map(([, pathname]) => pathname))].sort(),
    [
      `/_services/entity-grid-data.json/${SITE}`,
      `/_services/portal/GetListViewConfiguration/${CALENDAR_LIST}`,
      `/_services/portal/GetListViewConfiguration/${COMPONENT_LIST}`,
    ].sort(),
  );
  assert.equal(await page.locator('[data-view="calendar"], [data-calendar-nav]').count(), 0);
  // A header sort leads with the chosen column and keeps the view's order after it (hosted: "x_text DESC,x_name ASC").
  const [sortRequest] = await Promise.all([
    page.waitForRequest((request) => request.url().includes('/_services/entity-grid-data.json/')),
    page.locator('pages-native-container').first().locator('thead th[data-logical-name="x_rank"] button').click(),
  ]);
  assert.equal(sortRequest.postDataJSON().sortExpression, 'x_rank ASC,x_name ASC');
  assert.deepEqual(errors, []);
});

// @test-kind security: hosted answers for an anonymous visitor and for a list not included as a modern list are not captured (hosted-f2 summary-F2 LIST-01d captured a signed-in visitor of a modern include), so the configuration route fails closed with inferred refusals: 404 with an empty object unless a source includes the list as a modern list the local adapter serves, 403 AccessDenied unless the visitor may read its table
test('the list configuration is served only for a served modern include and a visitor who may read its table', async (t) => {
  const app = await launch(t);
  const session = signInHeaders(app, CONTACT, { roles: ['Member'] });
  const read = async (list, headers = session) => {
    const response = await fetch(`${app.url}/_services/portal/GetListViewConfiguration/${list}`, { headers });
    return [response.status, response.status === 200 ? 'configuration' : await response.text()];
  };
  assert.deepEqual(await read(LIST), [200, 'configuration']);
  // Anonymous: no read permission on the table.
  assert.deepEqual(await read(LIST, {}), [403, '{"AccessDenied":true}']);
  assert.deepEqual(await read(MAP_LIST, {}), [403, '{"AccessDenied":true}']);
  // A calendar list included as modern is a served modern include (hosted-f2 summary-F2 LIST-01f): the same read check.
  assert.deepEqual(await read(CALENDAR_LIST), [200, 'configuration']);
  assert.deepEqual(await read(CALENDAR_LIST, {}), [403, '{"AccessDenied":true}']);
  // Included as a classic list only.
  assert.deepEqual(await read(PLAIN_LIST), [404, '{}']);
  assert.deepEqual(await read('71000000-0000-4000-8000-0000000000ff'), [404, '{}']);
});
