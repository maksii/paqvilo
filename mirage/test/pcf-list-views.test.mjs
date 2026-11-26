// @test-kind observation: a code-component list with two views binds its first view and hosts the control in the list's grid, whose own toolbar draws the view dropdown for two or more views whatever the manifest declares, live captures paqvilo-developer pcf-parity summary-F section 4 (runs fa and fb views-list-ny and views-itemlist-ny, 2026-11-26; corrects summary-C, whose r2 and r3 captures saved only the component's markup), and an authored entitylist block on a code-component list renders only its body (summary-C, raw r2 and r3 authored-list-ny), replayed on invented loopback fixtures
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, serialize } from 'parse5';
import { createSimulator } from '../server.mjs';
import { rowsDatasetControl, writeFixtureFiles } from './support/pcf-fixture-files.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const rankView = 'b1000000-0000-4000-8000-000000000001';
const nameView = 'b1000000-0000-4000-8000-000000000002';
const rowId = (index) => 'b2000000-0000-4000-8000-' + String(index).padStart(12, '0');
const column = (name, type) =>
  `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type></attribute>`;
// The captured item list's two views differ in their order; here they also differ in their filter and layout, so the
// rows and columns show which view the data set is bound to.
const savedQuery = (id, name, filter, cells) =>
  `<savedquery><savedqueryid>${id}</savedqueryid><querytype>0</querytype><LocalizedNames><LocalizedName description="${name}" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="tst_row"><attribute name="tst_rowid"/><attribute name="tst_title"/><attribute name="tst_rank"/>${filter}</entity></fetch></fetchxml><layoutxml><grid><row>${cells.map((cell) => `<cell name="${cell}" width="100"/>`).join('')}</row></grid></layoutxml></savedquery>`;
const viewEntry = (id, label) =>
  `{"Type":"View","ViewId":"${id}","DisplayName":[{"Type":"LanguageResources","LCID":1033,"Value":"${label}"}]}`;

/** The list "Items" (code component on, page size 2) with the given views, rendered by `template` on the home page. */
async function listSite(t, { template, views }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-list-views-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  // adx_view is the list's first view, as in the captured list YAML.
  const list = `adx_entitylistid: items\nadx_name: Items\nadx_entityname: tst_row\nadx_pagesize: 2\nadx_iscodecomponent: true\nadx_view: ${views[0][0]}\nadx_views: '{"Type":"ViewMetadata","Views":[${views.map(([id, label]) => viewEntry(id, label)).join(',')}]}'`;
  await writeFixtureFiles(root, {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: List site',
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': template,
    'portal/Items.list.yml': list,
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/tst_row/Entity.xml': `<Entity><Name>tst_row</Name><EntityInfo><entity><attributes>${column('tst_rowid', 'primarykey')}${column('tst_title', 'nvarchar')}${column('tst_rank', 'int')}</attributes></entity></EntityInfo><CustomControlDefaultConfigs><CustomControlDefaultConfig><CustomControlDefaultConfigXml><customControl name="tst_Synthetic.Rows" formFactor="0"/></CustomControlDefaultConfigXml></CustomControlDefaultConfig></CustomControlDefaultConfigs></Entity>`,
    [`solution/Entities/tst_row/SavedQueries/${rankView}.xml`]: savedQuery(
      rankView,
      'Rows by rank (saved query)',
      '<order attribute="tst_rank"/><filter><condition attribute="tst_rank" operator="gt" value="2"/></filter>',
      ['tst_title', 'tst_rank'],
    ),
    [`solution/Entities/tst_row/SavedQueries/${nameView}.xml`]: savedQuery(
      nameView,
      'Rows by name (saved query)',
      '<order attribute="tst_title"/>',
      ['tst_title'],
    ),
    ...rowsDatasetControl("ComponentFramework.registerControl('Synthetic.Rows',class{});"),
  });
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    watch: false,
    initial: {
      tables: {
        tst_row: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((tst_title, index) => ({
          tst_rowid: rowId(index + 1),
          tst_title,
          tst_rank: index + 1,
        })),
      },
      mappings: { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid', nameColumn: 'tst_title' } },
      settings: { permissionMode: 'permissive' },
    },
  });
  ownedFixture(t).add(() => app.close());
  const html = await (await fetch(app.url + '/')).text();
  return { app, html };
}

/** The page markup without its script elements (Mirage's runtime scripts name grid classes and attributes). */
function markup(html) {
  const document = parse(html);
  const pending = [document];
  while (pending.length) {
    const node = pending.pop();
    if (node.childNodes) node.childNodes = node.childNodes.filter((child) => child.nodeName !== 'script');
    pending.push(...(node.childNodes ?? []));
    if (node.content) pending.push(node.content);
  }
  return serialize(document);
}

/** The mount specification the rendered code component hands to the client host. */
function mountSpec(html) {
  const start = html.indexOf('__paqviloPcf.mount(') + '__paqviloPcf.mount('.length;
  return JSON.parse(html.slice(start, html.indexOf(', document.currentScript', start)));
}

test('a code-component list with two views binds the first view and hosts the control in its grid with both views for the toolbar', async (t) => {
  const { app, html } = await listSite(t, {
    template: "{% include 'entity_list' key:'Items' %}",
    views: [
      [rankView, 'Items by rank'],
      [nameView, 'Items by name'],
    ],
  });
  assert.match(html, /data-pcf-schema="tst_Synthetic\.Rows"/);
  const [binding] = mountSpec(html).datasets;
  // getViewId() is the first view and getTitle() its saved query name, not the list's display name for it.
  assert.deepEqual([binding.viewId, binding.viewName, binding.pageSize], [rankView, 'Rows by rank (saved query)', 2]);
  assert.deepEqual(
    binding.columns.map((entry) => entry.name),
    ['tst_title', 'tst_rank'],
  );
  // The control sits in the list's grid (summary-F section 4: the list's own toolbar draws the view dropdown, in the
  // list display names, and the grid runtime draws it for the marked host); the page renders no select of its own.
  const host =
    /<div class="entity-grid entitylist" data-pcf-view-host="" data-selected-view="([^"]+)" data-view-layouts="([^"]+)">/.exec(
      markup(html),
    );
  assert.ok(host, 'the control is hosted in the list grid');
  assert.equal(host[1], rankView);
  const layouts = JSON.parse(Buffer.from(host[2], 'base64').toString('utf8'));
  assert.deepEqual(
    layouts.map((layout) => [layout.Id, layout.Configuration.ViewDisplayName]),
    [
      [rankView, 'Items by rank'],
      [nameView, 'Items by name'],
    ],
  );
  assert.doesNotMatch(markup(html), /<select/);
  // Choosing a view rebinds the data set to that view's own columns, title and signed configuration.
  assert.deepEqual(
    binding.views.map((view) => [view.viewId, view.viewName, view.columns.map((entry) => entry.name)]),
    [
      [rankView, 'Rows by rank (saved query)', ['tst_title', 'tst_rank']],
      [nameView, 'Rows by name (saved query)', ['tst_title']],
    ],
  );
  assert.equal(binding.views[0].secure, binding.secure);
  const rows = async (secure) => {
    const response = await fetch(app.url + binding.service, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
      body: JSON.stringify({
        base64SecureConfiguration: secure,
        sortExpression: 'tst_title ASC',
        search: '',
        page: 1,
        pageSize: 2,
        pcfFilter: '',
        timezoneOffset: 300,
        entityName: 'tst_row',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    return [body.MoreRecords, body.Records.map((record) => record.Id)];
  };
  // The grid service answers the first view's rows: its filter (rank above 2), at the list's page size; the second
  // view's configuration reads the second view (no filter).
  assert.deepEqual(await rows(binding.secure), [true, [rowId(3), rowId(4)]]);
  assert.deepEqual(await rows(binding.views[1].secure), [true, [rowId(1), rowId(2)]]);
  assert.ok(!app.state().diagnostics.some((entry) => entry.code === 'PCF_NATIVE_DATASET_UNSUPPORTED'));
});

test('an authored entitylist block on a code-component list renders only its body, with no code component host', async (t) => {
  const { app, html } = await listSite(t, {
    template:
      '<main>{% entitylist id:\'items\' %}<p class="authored">authored block, {{ entitylist.views.size }} views</p>{% endentitylist %}</main>',
    views: [[rankView, 'Items by rank']],
  });
  assert.match(html, /<main><p class="authored">authored block, 1 views<\/p><\/main>/);
  assert.doesNotMatch(
    html,
    /__paqviloPcf\.mount\(|pcf-host\.js|data-pcf-schema|data-pcf-control|_pcfwebresource|PcfControlConfig/,
  );
  assert.doesNotMatch(markup(html), /entity-grid|EntityListControl|data-mirage-component="codecomponent"|<table/);
  assert.ok(!app.state().diagnostics.some((entry) => entry.code === 'PCF_NATIVE_DATASET_UNSUPPORTED'));
});
