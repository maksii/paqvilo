// @test-kind observation: hosted session F3 (paqvilo-developer hosted-f3 summary-F3.md PAGE-06b, chart, chart-noperm2 and chart-admin captures of runs a and b, 2026-11-27): get-chart-builder answers the chart's aggregate FetchXml with the view's filter, DataJson with the for(;;); prefix and the documented keys, and {"ChartDefinition":"","EntityPermissionDenied":true} without a table permission
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '77777777-7777-4777-8777-777777777c10';
const CHART = '77777777-7777-4777-8777-777777777c20';
const VIEW = '77777777-7777-4777-8777-777777777c21';
const id = (n) => `77777777-7777-4777-8777-7777777779${String(n).padStart(2, '0')}`;
const column = (name, type, label) =>
  `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>${type}</Type><displaynames><displayname description="${label}" languagecode="1033"/></displaynames></attribute>`;
const ENTITY = `<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute>${column('x_name', 'nvarchar', 'Name')}${column('x_category', 'nvarchar', 'Category')}${column('x_amount', 'int', 'Amount')}</attributes></entity></EntityInfo></Entity>`;
const VIEW_XML = `<savedquery><savedqueryid>{${VIEW}}</savedqueryid><querytype>0</querytype><isdefault>1</isdefault><LocalizedNames><LocalizedName description="Active invented items" languagecode="1033"/></LocalizedNames><fetchxml><fetch version="1.0" mapping="logical"><entity name="x_item"><attribute name="x_itemid"/><attribute name="x_name"/><order attribute="x_name" descending="false"/><filter type="and"><condition attribute="statecode" operator="eq" value="0"/></filter></entity></fetch></fetchxml><layoutxml><grid name="resultset" jump="x_name" select="1" icon="1" preview="1"><row name="result" id="x_itemid"><cell name="x_name" width="300"/></row></grid></layoutxml></savedquery>`;
const DATA_DESCRIPTION =
  '<datadefinition><fetchcollection><fetch mapping="logical" aggregate="true"><entity name="x_item"><attribute alias="aggregate_column" name="x_amount" aggregate="sum" /><attribute groupby="true" alias="groupby_column" name="x_category" /></entity></fetch></fetchcollection><categorycollection><category><measurecollection><measure alias="aggregate_column" /></measurecollection></category></categorycollection></datadefinition>';
const PRESENTATION = '<Chart Palette="None"><Series><Series ChartType="Column" /></Series></Chart>';
const escape = (xml) => xml.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const CHART_XML = `<visualization><savedqueryvisualizationid>{${CHART}}</savedqueryvisualizationid><primaryentitytypecode>x_item</primaryentitytypecode><datadescription>${escape(DATA_DESCRIPTION)}</datadescription><presentationdescription>${escape(PRESENTATION)}</presentationdescription><description>Invented sum by category</description><LocalizedNames><LocalizedName description="Invented items by category" languagecode="1033"/></LocalizedNames></visualization>`;

async function chartSite(t, { permissions }) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-chart-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented charts`,
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': '<main>chart</main>',
    'portal/webrole.yml': '- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedCharts</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_item/Entity.xml': ENTITY,
    'solution/Entities/x_item/SavedQueries/active.xml': VIEW_XML,
    [`solution/Entities/x_item/Visualizations/{${CHART}}.xml`]: CHART_XML,
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const row = (n, name, category, amount, statecode = 0) => ({
    x_itemid: id(n),
    x_name: name,
    x_category: category,
    x_amount: amount,
    statecode,
  });
  const sim = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' } },
      tables: {
        x_item: [
          row(1, 'Invented one', 'Alpha', 10),
          row(2, 'Invented two', 'Alpha', 20),
          row(3, 'Invented three', 'Beta', 5),
          row(4, 'Invented four', 'Beta', 8),
          row(5, 'Invented inactive', 'Gamma', 100, 1),
          row(6, 'Invented five', 'Gamma', 3),
        ],
      },
      permissions,
      settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', endpoints: [] },
    },
  });
  ownedFixture(t).add(() => sim.close());
  const builder = async () => {
    const response = await fetch(
      `${sim.url}/_services/visualizations/get-chart-builder?__portalScopeId__=${SITE}&chartId=${CHART}&viewId=${VIEW}`,
      { headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' } },
    );
    assert.match(response.headers.get('content-type'), /^application\/json; charset=utf-8/);
    return { status: response.status, body: await response.json() };
  };
  return { builder };
}

const READ = [{ id: 'items', entity: 'x_item', scope: 'global', roles: ['Anonymous Users'], operations: ['read'] }];

test('get-chart-builder answers the exported chart over the view filter and the visitor rows', async (t) => {
  const { builder } = await chartSite(t, { permissions: READ });
  const { status, body } = await builder();
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), [
    'AttributeMetadata',
    'AttributeMetadataSerialized',
    'ChartDefinition',
    'OuterQuery',
    'Data',
    'DataJson',
    'EntityMetadata',
    'EntityMetadataSerialized',
    'EntityPermissionDenied',
    'EntityPermissionsEnabled',
    'Id',
    'Query',
    'FetchXml',
    'ResourceManagerStringOverrides',
    'ResourceManagerStringOverridesSerialized',
    'ViewDefinition',
  ]);
  assert.equal(
    body.FetchXml,
    '<fetch mapping="logical" aggregate="true">\r\n  <entity name="x_item">\r\n    <attribute name="x_amount" alias="aggregate_column" aggregate="sum" />\r\n    <attribute name="x_category" alias="groupby_column" groupby="true" />\r\n    <filter type="and">\r\n      <condition attribute="statecode" operator="eq" value="0" />\r\n    </filter>\r\n  </entity>\r\n</fetch>',
  );
  assert.equal(
    body.OuterQuery.Query,
    '<fetch mapping="logical" aggregate="true">\r\n  <entity name="x_item">\r\n    <attribute name="x_amount" alias="aggregate_column" aggregate="sum" />\r\n    <attribute name="x_category" alias="groupby_column" groupby="true" />\r\n  </entity>\r\n</fetch>',
  );
  assert.ok(body.DataJson.startsWith('for(;;);'));
  const rows = JSON.parse(body.DataJson.slice('for(;;);'.length));
  const typeCode = String(body.EntityMetadata[0].ObjectTypeCode);
  assert.deepEqual(
    rows.toSorted((a, b) => a.groupby_column.localeCompare(b.groupby_column)),
    [
      ['Alpha', 30],
      ['Beta', 13],
      ['Gamma', 3],
    ].map(([group, sum]) => ({
      RowId: '{00000000-0000-0000-0000-000000000000}',
      RowType: typeCode,
      aggregate_column: sum.toFixed(2),
      aggregate_column_Value: sum,
      groupby_column: group,
      groupby_column_Value: group,
    })),
    'the inactive row is outside the view filter',
  );
  assert.equal(body.Data.length, 3);
  assert.deepEqual(body.Data[0].Attributes[0].Value.AttributeLogicalName, 'x_amount');
  assert.equal(body.EntityPermissionDenied, false);
  assert.equal(body.EntityPermissionsEnabled, true);
  assert.match(body.Id, /^[0-9a-f]{32}$/);
  assert.deepEqual(
    body.AttributeMetadata.map((item) => [item.logicalname, item.entitylogicalname, item.type.Value, item.displayname]),
    [
      ['x_amount', 'x_item', 'IntegerType', 'Amount'],
      ['x_category', 'x_item', 'StringType', 'Category'],
    ],
  );
  const primary = body.ChartDefinition.PrimaryEntityMetadata;
  assert.deepEqual(
    body.AttributeMetadata.map((item) => item.id.rawguid),
    ['x_amount', 'x_category'].map((name) => primary.Attributes.find((item) => item.LogicalName === name).MetadataId),
  );
  assert.equal(body.EntityMetadata[0].Id, primary.MetadataId);
  assert.equal(body.AttributeMetadataSerialized, JSON.stringify(body.AttributeMetadata));
  assert.equal(body.EntityMetadataSerialized, JSON.stringify(body.EntityMetadata));
  assert.equal(body.ResourceManagerStringOverrides.Chart_NoData_Message, 'No data available.');
  const definition = body.ChartDefinition;
  assert.equal(definition.Id, CHART);
  assert.equal(definition.Name, 'Invented items by category');
  assert.equal(definition.Description, 'Invented sum by category');
  assert.equal(definition.PrimaryEntityTypeCode, 'x_item');
  assert.equal(definition.DataDescriptionXml, DATA_DESCRIPTION);
  assert.equal(definition.PresentationDescriptionXml, PRESENTATION);
  assert.equal(definition.PrimaryEntityMetadata.LogicalName, 'x_item');
  assert.ok(definition.PrimaryEntityMetadata.Attributes.some((item) => item.LogicalName === 'x_amount'));
  assert.deepEqual(definition.DataDescription.CategoryCollection, [
    { Alias: null, MeasureCollections: [{ Measures: [{ Alias: 'aggregate_column' }] }] },
  ]);
  const query = definition.Fetch;
  assert.deepEqual(body.Query, query);
  assert.deepEqual(definition.DataDescription.FetchCollection, [query]);
  assert.deepEqual([query.Aggregate, query.NoLock, query.MappingType, query.Entity.Name], [true, true, 0, 'x_item']);
  assert.deepEqual(
    query.Entity.Attributes.map((item) => [item.Name, item.Alias, item.Aggregate, item.GroupBy]),
    [
      ['x_amount', 'aggregate_column', 2, null],
      ['x_category', 'groupby_column', null, true],
    ],
  );
  assert.deepEqual(query.Entity.Filters[0].Conditions[0].Attribute, 'statecode');
  assert.deepEqual([query.Entity.Filters[0].Type, query.Entity.Filters[0].Conditions[0].Operator], [0, 0]);
  const view = body.ViewDefinition;
  assert.equal(
    view.FetchXml,
    `<fetch version="1.0" mapping="logical" savedqueryid="${VIEW}"><entity name="x_item"><attribute name="x_itemid" /><attribute name="x_name" /><order attribute="x_name" descending="false" /><filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter></entity></fetch>`,
  );
  assert.deepEqual([view.Id, view.Name, view.ReturnedTypeCode], [VIEW, 'Active invented items', 'x_item']);
  assert.match(view.LayoutXml, /^<grid name="resultset"/);
  assert.deepEqual([view.Fetch.Version, view.Fetch.NoLock, view.Fetch.Entity.Orders[0].Direction], ['1.0', null, 0]);
});

test('get-chart-builder refuses the chart without a table permission as the hosted service does', async (t) => {
  const { builder } = await chartSite(t, { permissions: [] });
  const { status, body } = await builder();
  assert.equal(status, 200);
  assert.deepEqual(body, { ChartDefinition: '', EntityPermissionDenied: true });
});
