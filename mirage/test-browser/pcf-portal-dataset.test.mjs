// @test-kind observation: Power Pages dataset PCF on lists, subgrids and the Liquid tag, live capture paqvilo-developer pcf-parity summary-C (r2 list-ny, item-list-ny, qf-list-ny, lq-dataset-ny; r1/r2 subgrid-actions-ny) replayed on invented loopback fixtures
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { signInContext } from '../testing/session.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const viewId = 'd0000000-0000-4000-8000-000000000003';
const quickFindId = 'd0000000-0000-4000-8000-000000000004';
const formId = 'd0000000-0000-4000-8000-000000000005';
const rowId = (index) => 'd1000000-0000-4000-8000-' + String(index).padStart(12, '0');
const contactId = 'd3000000-0000-4000-8000-000000000001';
const currencyId = 'd6000000-0000-4000-8000-000000000001';
const parentId = 'd7000000-0000-4000-8000-000000000001';
const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
const labels = (text) => `<labels><label description="${text}" languagecode="1033"/></labels>`;
const attr = (name, type, extra = '') =>
  `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type><displaynames><displayname description="${name.replace('tst_', '')}" languagecode="1033"/></displaynames>${extra}</attribute>`;
const options = (entries) =>
  `<optionset><options>${entries.map(([value, text]) => `<option value="${value}">${labels(text)}</option>`).join('')}</options></optionset>`;
const rowAttributes =
  attr('tst_rowid', 'primarykey') +
  attr('tst_title', 'nvarchar', '<DisplayMask>PrimaryName|ValidForForm</DisplayMask>') +
  attr('tst_rank', 'int') +
  attr('tst_whole', 'int') +
  attr('tst_decimal', 'decimal') +
  attr('tst_money', 'money') +
  attr('tst_flag', 'bit') +
  attr(
    'tst_choice',
    'picklist',
    options([
      [970840000, 'Red'],
      [970840001, 'Green'],
    ]),
  ) +
  attr(
    'tst_choices',
    'multiselectpicklist',
    options([
      [970840000, 'Red'],
      [970840001, 'Green'],
      [970840002, 'Blue'],
    ]),
  ) +
  attr('tst_dateonly', 'datetime', '<Format>date</Format><Behavior>2</Behavior>') +
  attr('tst_dateutc', 'datetime', '<Format>datetime</Format><Behavior>1</Behavior>') +
  attr('tst_datetzi', 'datetime', '<Format>datetime</Format><Behavior>3</Behavior>') +
  attr('tst_contact', 'lookup') +
  attr('tst_parentid', 'lookup') +
  attr('tst_notes', 'ntext') +
  attr('transactioncurrencyid', 'lookup');
const valueRow = {
  tst_whole: 34567,
  tst_decimal: 1234.5,
  tst_money: 1234.56,
  tst_flag: true,
  tst_choice: 970840001,
  tst_choices: [970840000, 970840002],
  tst_dateonly: '2026-03-15',
  tst_dateutc: '2026-03-15T14:05:00Z',
  tst_datetzi: '2026-03-15T14:05:00',
  tst_contact: { id: contactId, logical_name: 'contact', name: 'Demo Developer' },
  transactioncurrencyid: { id: currencyId, logical_name: 'transactioncurrency' },
};
const allColumns = [
  'tst_title',
  'tst_whole',
  'tst_decimal',
  'tst_money',
  'tst_flag',
  'tst_choice',
  'tst_choices',
  'tst_dateonly',
  'tst_dateutc',
  'tst_datetzi',
  'tst_contact',
  'ct.emailaddress1',
];
const viewXml = (id, name, columns, queryType = 0, order = 'tst_title') =>
  `<savedquery><savedqueryid>${id}</savedqueryid><querytype>${queryType}</querytype><LocalizedNames><LocalizedName description="${name}" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="tst_row">${columns
    .filter((column) => !column.includes('.'))
    .map((column) => `<attribute name="${column}"/>`)
    .join(
      '',
    )}<attribute name="tst_rowid"/><order attribute="${order}"/><link-entity name="contact" from="contactid" to="tst_contact" alias="ct" link-type="outer"><attribute name="emailaddress1"/></link-entity></entity></fetch></fetchxml><layoutxml><grid><row>${columns.map((column) => `<cell name="${column}" width="120"/>`).join('')}</row></grid></layoutxml></savedquery>`;
// The grid records every lifecycle call with its updatedProperties; window.ds is the first data set.
const bundle = `ComponentFramework.registerControl('Synthetic.Grid',class{
init(context,notify,state,container){window.parameters=context.parameters;window.ds=context.parameters.rows||context.parameters.first;window.events=[{kind:'init',props:[]}];this.container=container;if(window.onGridInit)window.onGridInit(window.ds);}
updateView(context){window.events.push({kind:'updateView',props:[...context.updatedProperties]});const ds=window.ds;
this.container.textContent=ds.loading?'loading':ds.errorMessage||ds.sortedRecordIds.map(id=>ds.records[id].getFormattedValue('tst_title')).join(',');}
destroy(){}});`;
const manifest = (datasets) =>
  `<manifest><control namespace="Synthetic" constructor="Grid" control-type="standard">${datasets}<resources><code path="bundle.js"/></resources></control></manifest>`;
const recordsDataset =
  '<data-set name="rows"><property-set name="primaryColumn" display-name-key="Primary column" of-type="SingleLine.Text" usage="bound" required="false"/></data-set>';

/**
 * A portal with the dataset control tst_Synthetic.Grid as the table's grid control on the list "All rows" (page size
 * 3), on the subgrid of a parent form, or in the Liquid tag; options replace the views, data, visitor and settings.
 */
async function datasetPortal(t, options = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-portal-dataset-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const host = options.host ?? 'list';
  const source = {
    list: "<html><body>{% include 'entity_list' key:'All rows' %}</body></html>",
    subgrid: "<html><body>{% entityform name:'Parent form' %}</body></html>",
    liquid: `<html><body>{% codecomponent name:tst_Synthetic.Grid rows:'${viewId}' %}</body></html>`,
  }[host];
  const listView = options.listView ?? viewId;
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Dataset site',
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Details.webpage.yml':
      'adx_webpageid: details\nadx_name: Details\nadx_partialurl: details\nadx_isroot: true',
    'portal/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': source,
    'portal/Rows.list.yml': `adx_entitylistid: rows\nadx_name: All rows\nadx_entityname: tst_row\nadx_view: ${listView}\nadx_pagesize: ${options.listPageSize ?? 3}\nadx_iscodecomponent: true\nadx_webpagefordetailsview: details\nadx_idquerystringparametername: id`,
    'portal/Parent.basicform.yml':
      'adx_entityformid: parent-basic\nadx_name: Parent form\nadx_entityname: tst_parent\nadx_formname: Parent\nadx_mode: 100000001',
    'portal/Parent.basicform.basicformmetadata.yml':
      'adx_entityformmetadataid: parent-subgrid\nadx_entityform: parent-basic\nadx_type: 100000003\nadx_subgrid_name: children\nadx_controlstyle: 756150001',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/tst_row/Entity.xml': `<Entity><Name>tst_row</Name><EntityInfo><entity Name="tst_row"><EntitySetName>tst_rows</EntitySetName><attributes>${rowAttributes}</attributes></entity></EntityInfo><CustomControlDefaultConfigs><CustomControlDefaultConfig><CustomControlDefaultConfigXml><customControl name="tst_Synthetic.Grid" formFactor="0"/></CustomControlDefaultConfigXml></CustomControlDefaultConfig></CustomControlDefaultConfigs></Entity>`,
    'solution/Entities/contact/Entity.xml': `<Entity><Name>contact</Name><EntityInfo><entity Name="contact"><LocalizedNames><LocalizedName description="Contact" languagecode="1033"/></LocalizedNames><attributes>${attr('contactid', 'primarykey')}${attr('fullname', 'nvarchar')}${attr('emailaddress1', 'nvarchar', '<Format>email</Format>')}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/tst_parent/Entity.xml': `<Entity><Name>tst_parent</Name><EntityInfo><entity Name="tst_parent"><attributes>${attr('tst_parentid', 'primarykey')}${attr('tst_label', 'nvarchar', '<DisplayMask>PrimaryName|ValidForForm</DisplayMask>')}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/tst_parent/FormXml/main/parent-form.xml': `<systemform><formid>{${formId}}</formid><type>2</type><LocalizedNames><LocalizedName description="Parent" languagecode="1033"/></LocalizedNames><form><tabs><tab name="general"><columns><column><sections><section name="main"><rows><row><cell><control id="children" indicationOfSubgrid="true"><parameters><TargetEntityType>tst_row</TargetEntityType><ViewId>${viewId}</ViewId><RelationshipName>${options.relationship ?? 'tst_parent_rows'}</RelationshipName><RecordsPerPage>3</RecordsPerPage>${options.subgridParameters ?? ''}</parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="children"><customControl name="tst_Synthetic.Grid" formFactor="0"><parameters><data-set name="rows"><ViewId>${viewId}</ViewId><TargetEntityType>tst_row</TargetEntityType></data-set></parameters></customControl></controlDescription></controlDescriptions></form></systemform>`,
    [`solution/Entities/tst_row/SavedQueries/${viewId}.xml`]: viewXml(
      viewId,
      'Rows view',
      options.columns ?? allColumns,
      0,
      options.viewOrder,
    ),
    [`solution/Entities/tst_row/SavedQueries/${quickFindId}.xml`]: viewXml(
      quickFindId,
      'Quick Find Rows',
      ['tst_title'],
      4,
    ),
    'solution/Controls/tst_Synthetic.Grid/ControlManifest.xml': manifest(options.datasets ?? recordsDataset),
    'solution/Controls/tst_Synthetic.Grid/ControlManifest.xml.data.xml':
      '<CustomControl><Name>tst_Synthetic.Grid</Name></CustomControl>',
    'solution/Controls/tst_Synthetic.Grid/bundle.js': bundle,
    ...options.files,
  };
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const rows =
    options.rows ??
    names.map((tst_title, index) => ({
      tst_rowid: rowId(index + 1),
      tst_title,
      tst_rank: 7 - index,
      tst_parentid: { id: parentId, logical_name: 'tst_parent' },
      ...(index === 0 ? valueRow : {}),
    }));
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    port: 0,
    watch: false,
    ...(options.pcf ? { pcf: options.pcf } : {}),
    initial: {
      tables: {
        tst_row: rows,
        tst_parent: [{ tst_parentid: parentId, tst_label: 'Parent' }],
        contact: [{ contactid: contactId, fullname: 'Demo Developer', emailaddress1: 'demo@example.test' }],
        transactioncurrency: [{ transactioncurrencyid: currencyId, currencysymbol: '$', currencyprecision: 2 }],
        ...options.extraTables,
      },
      mappings: {
        tst_row: {
          entitySet: 'tst_rows',
          idColumn: 'tst_rowid',
          nameColumn: 'tst_title',
          relationships: {
            tst_parentid: { entity: 'tst_parent', from: 'tst_parentid', to: 'tst_parentid', many: false },
            // The many-to-many relationship through the intersect table tst_link (N:N subgrid).
            tst_parent_links: {
              entity: 'tst_parent',
              from: 'tst_rowid',
              to: 'tst_parentid',
              many: true,
              intersect: { entity: 'tst_link', from: 'tst_rowid', to: 'tst_parentid' },
            },
          },
        },
        tst_parent: {
          entitySet: 'tst_parents',
          idColumn: 'tst_parentid',
          nameColumn: 'tst_label',
          relationships: {
            tst_parent_rows: { entity: 'tst_row', from: 'tst_parentid', to: 'tst_parentid', many: true },
            tst_parent_links: {
              entity: 'tst_row',
              from: 'tst_parentid',
              to: 'tst_rowid',
              many: true,
              intersect: { entity: 'tst_link', from: 'tst_parentid', to: 'tst_rowid' },
            },
          },
        },
        tst_link: { entitySet: 'tst_links', idColumn: 'tst_linkid' },
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        transactioncurrency: { entitySet: 'transactioncurrencies', idColumn: 'transactioncurrencyid' },
      },
      permissions: options.permissions ?? [],
      settings: { permissionMode: options.permissionMode ?? 'permissive' },
    },
  });
  ownedFixture(t).add(() => app.close());
  const context = await browser.newContext({ timezoneId: 'America/New_York', locale: 'en-US' });
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage(),
    errors = [],
    requests = [],
    bodies = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!/^\/(_api|_services)\//.test(url.pathname)) return;
    requests.push(request.method() + ' ' + url.pathname);
    if (url.pathname.startsWith('/_services/')) bodies.push({ path: url.pathname, body: request.postDataJSON() });
  });
  if (options.initScript) await page.addInitScript(options.initScript);
  if (options.signIn) await signInContext(context, app, options.signIn.contactId, options.signIn);
  await page.goto(app.url + (host === 'subgrid' ? `/?id=${parentId}` : '/'));
  // Every data set load settles once (the host traces dataset:loaded or dataset:failed), with or without an updateView.
  await page.waitForFunction(settledLoads, options.loads ?? 1, { timeout: 20000 });
  return { app, page, errors, requests, bodies };
}

/** The number of dataset loads the page's host has settled (inspect() lifecycle dataset:* stages), at least `count`. */
function settledLoads(count) {
  const stages = (globalThis.__paqviloPcf?.inspect() ?? []).flatMap((entry) => entry.lifecycle ?? []);
  return stages.filter((item) => item.stage.startsWith('dataset:')).length >= count;
}

/**
 * Run one dataset action in the page and wait until the load it starts settles. Without `expectUpdate` the action
 * starts no load: a refresh follows, and every updateView before the refresh's own is reported.
 */
const act = (page, action, expectUpdate = true) =>
  page.evaluate(
    async ({ action, expectUpdate }) => {
      const loads = () =>
        (globalThis.__paqviloPcf?.inspect() ?? [])
          .flatMap((entry) => entry.lifecycle ?? [])
          .filter((item) => item.stage.startsWith('dataset:')).length;
      const before = window.events.length,
        settledBefore = loads();
      const ds = window.ds;
      const result = await new Function('ds', `return (async () => { ${action} })()`)(ds);
      if (!expectUpdate) ds.refresh();
      await new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (loads() > settledBefore) resolve();
          else if (Date.now() - started > 10000) reject(new Error('no settled dataset load'));
          else setTimeout(poll, 10);
        };
        poll();
      });
      const events = window.events.slice(before).map((event) => event.props);
      return {
        result: result === undefined ? '$undefined' : result,
        props: expectUpdate ? events : events.slice(0, -1),
        rows: ds.sortedRecordIds.map((id) => ds.records[id].getFormattedValue('tst_title')),
        paging: {
          first: ds.paging.firstPageNumber,
          last: ds.paging.lastPageNumber,
          previous: ds.paging.hasPreviousPage,
          next: ds.paging.hasNextPage,
          total: ds.paging.totalResultCount,
          size: ds.paging.pageSize,
        },
        error: ds.error,
        message: ds.errorMessage,
      };
    },
    { action, expectUpdate },
  );

test('a list data set binds the first view: captured columns, values and named reference, rows from the grid service', async (t) => {
  const { page, errors, requests, bodies } = await datasetPortal(t);
  const shape = await page.evaluate(() => {
    const ds = window.ds,
      record = ds.records[ds.sortedRecordIds[0]];
    const columns = ds.columns.map(({ attributes, ...column }) => ({ ...column, attributes: Boolean(attributes) }));
    const value = (name) => {
      const raw = record.getValue(name);
      return raw instanceof Date ? 'Date ' + raw.toISOString() : raw;
    };
    return {
      columns,
      events: window.events,
      title: ds.getTitle(),
      view: ds.getViewId(),
      entity: ds.getTargetEntityType(),
      sorting: ds.sorting,
      paging: { ...ds.paging },
      filter: ds.filtering.getFilter() === undefined,
      capabilities: ds.getDataSetCapabilities(),
      reference: record.getNamedReference(),
      primaryName: typeof record.getFormattedPrimaryName,
      dirty: record.isDirty(),
      valid: record.isValid(),
      errorCode: ds.errorCode === undefined,
      selectedParameters: [window.parameters.rows_Selected.type, window.parameters.rows_SelectedItems.type],
      parameterNames: Object.keys(window.parameters).filter((name) => /rows|primaryColumn/.test(name)),
      propertySet: window.parameters.primaryColumn,
      timezoneOffset: new Date().getTimezoneOffset(),
      values: Object.fromEntries(
        ds.columns
          .filter((column) => column.name)
          .map((column) => [column.name, [value(column.name), record.getFormattedValue(column.name)]]),
      ),
    };
  });
  assert.deepEqual(shape.columns.slice(0, 2), [
    {
      name: null,
      displayName: 'primaryColumn',
      dataType: 'SingleLine.Text',
      alias: 'primaryColumn',
      order: -1,
      visualSizeFactor: 1,
      attributes: false,
    },
    {
      name: 'tst_title',
      displayName: 'title',
      dataType: 'SingleLine.Text',
      alias: 'tst_title',
      order: 1,
      visualSizeFactor: 1,
      attributes: true,
    },
  ]);
  assert.deepEqual(
    shape.columns.map((column) => [column.name, column.dataType]),
    [
      [null, 'SingleLine.Text'],
      ['tst_title', 'SingleLine.Text'],
      ['tst_whole', 'Whole.None'],
      ['tst_decimal', 'Decimal'],
      ['tst_money', 'Money'],
      ['tst_flag', 'TwoOptions'],
      ['tst_choice', 'OptionSet'],
      ['tst_choices', 'multiselectpicklist'],
      ['tst_dateonly', 'DateAndTime.DateOnly'],
      ['tst_dateutc', 'DateAndTime.DateAndTime'],
      ['tst_datetzi', 'DateAndTime.DateAndTime'],
      ['tst_contact', 'lookup'],
      ['ct.emailaddress1', 'SingleLine.Email'],
    ],
  );
  assert.equal(shape.columns.at(-1).displayName, 'emailaddress1 (Contact)');
  assert.deepEqual(shape.values, {
    tst_title: ['Alpha', 'Alpha'],
    tst_whole: [34567, '34567'],
    tst_decimal: [1234.5, '1234.5'],
    tst_money: [1234.56, '$1,234.56'],
    tst_flag: [true, 'true'],
    tst_choice: ['970840001', 'Green'],
    tst_choices: [[970840000, 970840002], 'Red; Blue'],
    tst_dateonly: ['Date 2026-03-15T00:00:00.000Z', '3/15/2026'],
    tst_dateutc: ['Date 2026-03-15T14:05:00.000Z', '3/15/2026 10:05 AM'],
    // A time-zone-independent value is shifted by the browser zone when formatted, as captured.
    tst_datetzi: ['Date 2026-03-15T14:05:00.000Z', '3/15/2026 10:05 AM'],
    tst_contact: [{ etn: 'contact', id: { guid: contactId }, name: 'Demo Developer' }, 'Demo Developer'],
    'ct.emailaddress1': ['demo@example.test', 'demo@example.test'],
  });
  assert.deepEqual(shape.events, [
    { kind: 'init', props: [] },
    { kind: 'updateView', props: [] },
    { kind: 'updateView', props: ['dataset', 'Items', 'records'] },
  ]);
  assert.deepEqual([shape.title, shape.view, shape.entity], ['Rows view', viewId, 'tst_row']);
  assert.deepEqual(shape.sorting, [{ name: 'tst_title', sortDirection: 0 }]);
  assert.deepEqual(
    [
      shape.paging.totalResultCount,
      shape.paging.hasNextPage,
      shape.paging.pageSize,
      shape.paging.firstPageNumber,
      shape.paging.lastPageNumber,
    ],
    [7, true, 3, 1, 1],
  );
  assert.equal(shape.filter, true);
  assert.deepEqual(shape.capabilities, {
    canCreateNewRecords: true,
    canPaginate: true,
    isEditable: true,
    isFilterable: true,
    isSortable: true,
    hasRecordNavigation: false,
  });
  assert.deepEqual(shape.reference, { etn: 'tst_rows', id: { guid: rowId(1) }, name: 'tst_row' });
  assert.equal(shape.primaryName, 'undefined');
  assert.deepEqual([shape.dirty, shape.valid, shape.errorCode], [false, true, true]);
  assert.deepEqual(shape.selectedParameters, ['Object', 'DataSet']);
  // The property-set is a parameter of its own, before the data set (summary-C2, Q-093).
  assert.deepEqual(shape.parameterNames, ['rows_Selected', 'rows_SelectedItems', 'primaryColumn', 'rows']);
  assert.deepEqual([shape.propertySet.type, shape.propertySet.raw], ['String', null]);
  // Rows never come from the portal Web API; the request has the captured members (summary-C2, Q-090).
  assert.ok(!requests.some((request) => request.includes('/_api/tst_rows')), requests.join('\n'));
  const [grid] = bodies.filter((entry) => entry.path.startsWith('/_services/entity-grid-data.json/'));
  assert.deepEqual(Object.keys(grid.body), [
    'base64SecureConfiguration',
    'sortExpression',
    'search',
    'page',
    'pageSize',
    'pcfFilter',
    'timezoneOffset',
    'entityName',
  ]);
  assert.deepEqual(
    [grid.body.sortExpression, grid.body.search, grid.body.page, grid.body.pageSize, grid.body.pcfFilter],
    ['tst_title ASC', '', 1, 3, ''],
  );
  assert.equal(grid.body.entityName, 'tst_row');
  assert.equal(grid.body.timezoneOffset, shape.timezoneOffset);
  assert.deepEqual(errors, []);
});

test('list paging, sorting, filtering, selection, columns and links follow the captured sequence', async (t) => {
  const { page, errors, bodies } = await datasetPortal(t, {
    columns: ['tst_title', 'tst_whole', 'tst_choice', 'tst_contact'],
  });
  const steps = [];
  const posted = {};
  const step = async (label, action, expectUpdate) => {
    const before = bodies.length;
    steps.push([label, await act(page, action, expectUpdate)]);
    posted[label] = bodies.slice(before).map((entry) => entry.body);
  };
  await step('sort', "ds.sorting = [{ name: 'tst_title', sortDirection: 1 }]; ds.refresh();");
  await step('sort back', "ds.sorting = [{ name: 'tst_title', sortDirection: 0 }]; ds.refresh();");
  await step(
    'greater',
    "ds.filtering.setFilter({ filterOperator: 0, conditions: [{ attributeName: 'tst_whole', conditionOperator: 2, value: '0' }] }); ds.refresh();",
  );
  await step(
    'like',
    "ds.filtering.setFilter({ filterOperator: 0, conditions: [{ attributeName: 'tst_title', conditionOperator: 6, value: '%o%' }] }); ds.refresh();",
  );
  await step(
    'eq or null',
    "ds.filtering.setFilter({ filterOperator: 1, conditions: [{ attributeName: 'tst_title', conditionOperator: 0, value: 'Bravo' }, { attributeName: 'tst_choice', conditionOperator: 12, value: '' }] }); ds.refresh();",
  );
  await step(
    'in',
    "ds.filtering.setFilter({ filterOperator: 0, conditions: [{ attributeName: 'tst_choice', conditionOperator: 8, value: ['970840001'] }] }); ds.refresh();",
  );
  const filter = await page.evaluate(() => window.ds.filtering.getFilter());
  await step('clear', 'ds.filtering.clearFilter(); ds.refresh();');
  const cleared = await page.evaluate(() => window.ds.filtering.getFilter());
  await step('page size', 'ds.paging.setPageSize(2); ds.refresh();');
  await step('next', 'ds.paging.loadNextPage();');
  await step('previous', 'ds.paging.loadPreviousPage();');
  await step('exact', 'ds.paging.loadExactPage(2);');
  await step('next only', 'ds.paging.loadNextPage(true);');
  await step('reset', 'ds.paging.reset();');
  await step(
    'select',
    'ds.setSelectedRecordIds([ds.sortedRecordIds[0]]); return ds.getSelectedRecordIds().length;',
    false,
  );
  await step('clear selection', 'ds.clearSelectedRecordIds(); return ds.getSelectedRecordIds().length;', false);
  await step('add existing column', "ds.addColumn('tst_whole'); ds.refresh(); return ds.columns.length;");
  await step(
    'link',
    "ds.linking.addLinkedEntity({ name: 'contact', from: 'contactid', to: 'tst_contact', linkType: 'outer', alias: 'pqlink' }); ds.refresh(); return ds.linking.getLinkedEntities();",
  );
  await step('open', 'return ds.openDatasetItem(ds.records[ds.sortedRecordIds[0]].getNamedReference());', false);
  const view = Object.fromEntries(steps.map(([label, value]) => [label, value]));
  // The captured request members per action (summary-C2, Q-090): one sort column, the pcfFilter FetchXML with
  // percent signs as &#37;, the page; added columns and links change nothing.
  const member = (label, name) => posted[label].map((body) => body[name]);
  assert.deepEqual(member('sort', 'sortExpression'), ['tst_title DESC']);
  assert.deepEqual(member('greater', 'pcfFilter'), [
    '<filter type="and"><condition attribute="tst_whole" operator="gt" value="0"/></filter>',
  ]);
  assert.deepEqual(member('like', 'pcfFilter'), [
    '<filter type="and"><condition attribute="tst_title" operator="like" value="&#37;o&#37;"/></filter>',
  ]);
  assert.deepEqual(member('eq or null', 'pcfFilter'), [
    '<filter type="or"><condition attribute="tst_title" operator="eq" value="Bravo"/><condition attribute="tst_choice" operator="null"/></filter>',
  ]);
  assert.deepEqual(member('in', 'pcfFilter'), [
    '<filter type="and"><condition attribute="tst_choice" operator="in"><value>970840001</value></condition></filter>',
  ]);
  assert.deepEqual(member('clear', 'pcfFilter'), ['']);
  assert.deepEqual(
    ['page size', 'next', 'previous', 'exact', 'next only', 'reset'].map((label) => posted[label][0].page),
    [1, 2, 2, 2, 3, 1],
  );
  const { base64SecureConfiguration: _secure, ...reloaded } = posted['reset'][0];
  for (const label of ['add existing column', 'link']) {
    const { base64SecureConfiguration: _same, ...body } = posted[label][0];
    assert.deepEqual(body, { ...reloaded, page: 1 }, label);
  }
  assert.deepEqual(view.sort.props, [['dataset', 'sortorder', 'records']]);
  assert.deepEqual(view.sort.rows, ['Golf', 'Foxtrot', 'Echo']);
  assert.deepEqual(view['sort back'].rows, ['Alpha', 'Bravo', 'Charlie']);
  assert.deepEqual(view.greater.props, [['dataset', 'filter', 'records']]);
  assert.equal(view.greater.paging.total, 1);
  assert.deepEqual(view.like.rows, ['Bravo', 'Echo', 'Foxtrot']);
  assert.equal(view['eq or null'].paging.total, 6);
  assert.deepEqual(view.in.rows, ['Alpha']);
  assert.deepEqual(filter, {
    filterOperator: 0,
    conditions: [{ attributeName: 'tst_choice', conditionOperator: 8, value: ['970840001'] }],
  });
  assert.equal(cleared, null);
  assert.deepEqual(view['page size'].props, [['dataset', 'records']]);
  assert.deepEqual(view['page size'].rows, ['Alpha', 'Bravo']);
  // loadNextPage() loads only the next page but keeps firstPageNumber 1 and hasPreviousPage false.
  assert.deepEqual(view.next.props, [['dataset', 'page', 'records']]);
  assert.deepEqual(
    [view.next.rows, view.next.paging.first, view.next.paging.last, view.next.paging.previous],
    [['Charlie', 'Delta'], 1, 2, false],
  );
  // loadPreviousPage() then reloads the same page.
  assert.deepEqual([view.previous.rows, view.previous.props], [['Charlie', 'Delta'], [['dataset', 'page', 'records']]]);
  assert.deepEqual(
    [view.exact.rows, view.exact.paging.first, view.exact.paging.last, view.exact.paging.previous],
    [['Charlie', 'Delta'], 2, 2, true],
  );
  assert.deepEqual(
    [view['next only'].rows, view['next only'].paging.first, view['next only'].paging.last],
    [['Echo', 'Foxtrot'], 3, 3],
  );
  assert.deepEqual([view.reset.rows, view.reset.paging.first, view.reset.paging.last], [['Alpha', 'Bravo'], 1, 1]);
  assert.deepEqual([view.select.result, view.select.props], [1, []]);
  assert.deepEqual([view['clear selection'].result, view['clear selection'].props], [0, []]);
  assert.deepEqual(
    [view['add existing column'].result, view['add existing column'].props],
    [5, [['dataset', 'records']]],
  );
  assert.deepEqual(view.link.props, [['dataset', 'linking', 'records']]);
  assert.deepEqual(view.link.result, [
    { name: 'contact', from: 'contactid', to: 'tst_contact', linkType: 'outer', alias: 'pqlink' },
  ]);
  // openDatasetItem returns undefined and does not navigate, although the list has a details page.
  assert.equal(view.open.result, '$undefined');
  assert.equal(new URL(page.url()).pathname, '/');
  assert.deepEqual(errors, []);
});

test('a list record saves its JSON-encoded change through the grid update service; newRecord rejects', async (t) => {
  const { app, page, errors, bodies } = await datasetPortal(t, { columns: ['tst_title', 'tst_notes'] });
  const write = await page.evaluate(async () => {
    const record = window.ds.records[window.ds.sortedRecordIds[0]];
    const set = record.setValue('tst_notes', 'dataset write');
    const isPromise = set instanceof Promise;
    await set;
    const changes = record.getChanges();
    const dirty = record.isDirty();
    const saved = await record.save();
    let rejected = null;
    await window.ds.newRecord().catch((error) => (rejected = error.name + ': ' + error.message));
    return { isPromise, changes, dirty, same: saved === record, after: record.isDirty(), rejected };
  });
  assert.deepEqual(write, {
    isPromise: true,
    changes: { tst_notes: '"dataset write"' },
    dirty: true,
    same: true,
    after: true,
    rejected: "TypeError: Cannot read properties of null (reading 'getRecordId')",
  });
  assert.equal(
    app.store.snapshot().tables.tst_row.find((row) => row.tst_rowid === rowId(1)).tst_notes,
    'dataset write',
  );
  // The captured save body (summary-C2, Q-090) plus Mirage's signed list configuration.
  const [save] = bodies.filter((entry) => entry.path.startsWith('/_services/entity-grid-update-entity/'));
  const { base64SecureConfiguration, ...body } = save.body;
  assert.deepEqual(body, {
    Id: rowId(1),
    EntityName: 'tst_row',
    Attributes: [{ Name: 'tst_notes', Value: '"dataset write"' }],
  });
  assert.equal(typeof base64SecureConfiguration, 'string');
  assert.deepEqual(errors, []);
});

test('a subgrid data set lists the parent rows sorted by the primary name, refuses setValue and does not navigate', async (t) => {
  const { page, errors, bodies } = await datasetPortal(t, {
    host: 'subgrid',
    columns: ['tst_title', 'tst_rank'],
    viewOrder: 'tst_rank',
    rows: [
      ...names.slice(0, 5).map((tst_title, index) => ({
        tst_rowid: rowId(index + 1),
        tst_title,
        tst_rank: 5 - index,
        tst_parentid: { id: parentId, logical_name: 'tst_parent' },
      })),
      { tst_rowid: rowId(9), tst_title: 'Aardvark of another parent', tst_rank: 0 },
    ],
  });
  const subgrid = await page.evaluate(() => {
    const ds = window.ds,
      record = ds.records[ds.sortedRecordIds[0]];
    let thrown = null;
    try {
      record.setValue('tst_title', 'x');
    } catch (error) {
      thrown = error.name + ': ' + error.message;
    }
    return {
      rows: ds.sortedRecordIds.map((id) => ds.records[id].getValue('tst_title')),
      total: ds.paging.totalResultCount,
      sorting: ds.sorting,
      thrown,
      save: record.save() === undefined,
      open: ds.openDatasetItem(record.getNamedReference()) === undefined,
      capabilities: ds.getDataSetCapabilities(),
    };
  });
  // The view orders by rank (Echo first); the platform sorts by the primary name.
  assert.deepEqual(subgrid.rows, ['Alpha', 'Bravo', 'Charlie']);
  assert.equal(subgrid.total, 5);
  assert.deepEqual(subgrid.sorting, [{ name: 'tst_title', sortDirection: 0 }]);
  assert.equal(subgrid.thrown, "TypeError: Cannot read properties of null (reading 'isValid')");
  assert.deepEqual([subgrid.save, subgrid.open], [true, true]);
  assert.equal(subgrid.capabilities.hasRecordNavigation, false);
  // The subgrid posts entity-subgrid-data.json with the list members plus the parent row id (summary-C2, Q-090).
  const [grid] = bodies.filter((entry) => entry.path.startsWith('/_services/entity-subgrid-data.json/'));
  assert.deepEqual(
    [grid.body.sortExpression, grid.body.entityName, grid.body.entityId],
    ['tst_title ASC', 'tst_row', parentId],
  );
  assert.equal(new URL(page.url()).searchParams.get('id'), parentId);
  // The subgrid payload carries its parent form record (for mode.contextInfo, packet 02).
  const html = await page.content();
  const start = html.indexOf('__paqviloPcf.mount(') + '__paqviloPcf.mount('.length;
  const spec = JSON.parse(html.slice(start, html.indexOf(', document.currentScript', start)));
  assert.deepEqual(spec.datasets[0].context, { entityTypeName: 'tst_parent', entityId: parentId });
  assert.deepEqual(errors, []);
});

test('a list with two data sets binds the first; a Quick Find list view mounts without rows', async (t) => {
  const two = await datasetPortal(t, {
    datasets: '<data-set name="first"/><data-set name="second"/>',
    loads: 2,
  });
  const datasets = await two.page.evaluate(() => ({
    events: window.events.map((event) => event.props),
    first: window.parameters.first.sortedRecordIds.length,
    second: window.parameters.second.sortedRecordIds.length,
    secondColumns: window.parameters.second.columns.length,
    parameters: Object.keys(window.parameters)
      .filter((name) => name.includes('_Selected'))
      .sort(),
  }));
  assert.deepEqual(datasets.events, [
    [],
    [],
    ['dataset', 'Items', 'records'],
    ['second_dataset', 'second_Items', 'second_records'],
  ]);
  assert.deepEqual([datasets.first, datasets.second, datasets.secondColumns], [3, 0, 0]);
  assert.deepEqual(datasets.parameters, [
    'first_Selected',
    'first_SelectedItems',
    'second_Selected',
    'second_SelectedItems',
  ]);
  const quickFind = await datasetPortal(t, { listView: quickFindId });
  const found = await quickFind.page.evaluate(() => ({
    view: window.ds.getViewId(),
    title: window.ds.getTitle(),
    columns: window.ds.columns.map((column) => column.name),
    rows: window.ds.sortedRecordIds.length,
    events: window.events.map((event) => event.props),
    state: [window.ds.loading, window.ds.error, window.ds.errorMessage, window.ds.errorCode === undefined],
  }));
  // After the 500 the data set stays loading with no error and no updateView (summary-C2, Q-091).
  assert.deepEqual(found, {
    view: quickFindId,
    title: 'Quick Find Rows',
    columns: [null, 'tst_title'],
    rows: 0,
    events: [[], []],
    state: [true, false, '', true],
  });
  // The other data set posts the same grid with an empty sort and a null search (summary-C2, item list).
  const second = two.bodies.filter((entry) => entry.path.startsWith('/_services/entity-grid-data.json/'))[1].body;
  assert.deepEqual([second.sortExpression, second.search, second.pcfFilter], ['', null, '']);
  assert.deepEqual([...two.errors, ...quickFind.errors], []);
});

test('the Liquid tag binds no data set: no view, the property-set column, an error after the first load', async (t) => {
  const { page, errors, requests } = await datasetPortal(t, { host: 'liquid' });
  const liquid = await page.evaluate(() => {
    const ds = window.ds;
    const thrown = (call) => {
      try {
        call();
        return null;
      } catch (error) {
        return error.name + ': ' + error.message;
      }
    };
    return {
      columns: ds.columns,
      rows: ds.sortedRecordIds,
      sorting: ds.sorting,
      error: [ds.error, ds.errorMessage, ds.loading],
      entity: ds.getTargetEntityType(),
      view: thrown(() => ds.getViewId()),
      title: thrown(() => ds.getTitle()),
      filter: ds.filtering.getFilter() === undefined,
      paging: [ds.paging.pageSize, ds.paging.totalResultCount],
      selected: Object.keys(window.parameters).filter((name) => name.includes('_Selected')),
      events: window.events.map((event) => event.props),
    };
  });
  assert.deepEqual(liquid, {
    columns: [
      {
        name: null,
        displayName: 'primaryColumn',
        dataType: 'SingleLine.Text',
        alias: 'primaryColumn',
        order: -1,
        visualSizeFactor: 1,
      },
    ],
    rows: [],
    sorting: [],
    error: [true, "Cannot read properties of undefined (reading '0')", false],
    entity: undefined,
    view: "TypeError: Cannot read properties of undefined (reading '0')",
    title: "TypeError: Cannot read properties of undefined (reading '0')",
    filter: true,
    paging: [25, -1],
    selected: ['rows_Selected', 'rows_SelectedItems'],
    events: [[], [], ['dataset', 'Items']],
  });
  // Paging and sorting only change the local state; their updateView omits "records" (and is [] without a reason).
  assert.deepEqual((await act(page, 'ds.paging.loadNextPage();')).props, [['dataset', 'page']]);
  assert.deepEqual((await act(page, "ds.sorting = [{ name: 'x', sortDirection: 1 }]; ds.refresh();")).props, [
    ['dataset', 'sortorder'],
  ]);
  assert.deepEqual((await act(page, 'ds.paging.setPageSize(2); ds.refresh();')).props, [[]]);
  assert.ok(!requests.some((request) => /tst_rows|entity-grid-data/.test(request)), requests.join('\n'));
  assert.deepEqual(errors, []);
});

// @test-kind unproven: a selection restored in init before the first load is kept until the load prunes it (not captured)
test('a selection restored in init before the first load keeps the ids the first page holds', async (t) => {
  const { page, errors } = await datasetPortal(t, {
    initScript: `window.onGridInit = (ds) => ds.setSelectedRecordIds(['{${rowId(2).toUpperCase()}}', 'd9999999-0000-4000-8000-000000000009']);`,
  });
  assert.deepEqual(await page.evaluate(() => window.ds.getSelectedRecordIds()), [rowId(2)]);
  assert.deepEqual(errors, []);
});

// @test-kind security: list dataset rows, links and saves follow the grid services' table permissions for the visitor
test('dataset reads, links and saves follow the visitor table permissions through the grid services', async (t) => {
  const options = {
    columns: ['tst_title'],
    permissionMode: 'enforce',
    permissions: [{ id: 'rows', entity: 'tst_row', scope: 'global', roles: ['Reader'], operations: ['read'] }],
    files: { 'portal/Reader.webrole.yml': 'adx_webroleid: reader\nadx_name: Reader\n' },
  };
  // Anonymous: the Reader grant does not apply; the grid service answers AccessDenied and no row reaches the control.
  // The data set then stays loading without records or an error (summary-C2, Q-094).
  const anonymous = await datasetPortal(t, options);
  assert.deepEqual(
    await anonymous.page.evaluate(() => [window.ds.loading, window.ds.error, window.ds.sortedRecordIds.length]),
    [true, false, 0],
  );
  // A signed-in Reader reads the rows. A link to a table without a read grant never reaches the server (the request has
  // no link member, summary-C2), so none of that table's values reach the control.
  const reader = await datasetPortal(t, { ...options, signIn: { contactId, roles: ['Reader'] } });
  assert.deepEqual(await reader.page.evaluate(() => window.ds.sortedRecordIds.length), 3);
  const linked = await act(
    reader.page,
    "ds.linking.addLinkedEntity({ name: 'contact', from: 'contactid', to: 'tst_contact', linkType: 'outer', alias: 'pqlink' }); ds.addColumn('fullname', 'pqlink'); ds.refresh(); return ds.sortedRecordIds.map((id) => ds.records[id].getValue('pqlink.fullname'));",
  );
  assert.deepEqual([linked.error, linked.rows.length, linked.result], [false, 3, [null, null, null]]);
  // Without a write grant the save is refused and the row keeps its value.
  const refused = await datasetPortal(t, { ...options, signIn: { contactId, roles: ['Reader'] } });
  const outcome = await refused.page.evaluate(async () => {
    const record = window.ds.records[window.ds.sortedRecordIds[0]];
    await record.setValue('tst_title', 'Changed');
    return record.save().then(
      () => 'saved',
      (error) => error.message,
    );
  });
  assert.equal(outcome, 'PCF dataset grid service returned HTTP 403');
  assert.equal(
    refused.app.store.snapshot().tables.tst_row.find((row) => row.tst_rowid === rowId(1)).tst_title,
    'Alpha',
  );
  assert.deepEqual([...anonymous.errors, ...reader.errors, ...refused.errors], []);
});

// @test-kind contract: the local pcf.liquidDatasetBinding "view" setting keeps Paqvilo's explicit Liquid binding through the portal Web API
test('the local Liquid view binding reads the tag argument view through the portal Web API', async (t) => {
  const { app, page, errors, requests } = await datasetPortal(t, {
    host: 'liquid',
    pcf: { liquidDatasetBinding: 'view' },
    columns: ['tst_title', 'tst_contact'],
    files: {
      'portal/sitesetting.yml':
        '- adx_sitesettingid: a\n  adx_name: Webapi/tst_row/enabled\n  adx_value: true\n- adx_sitesettingid: b\n  adx_name: Webapi/tst_row/fields\n  adx_value: tst_rowid,tst_title,tst_contact\n- adx_sitesettingid: c\n  adx_name: Webapi/contact/enabled\n  adx_value: true\n- adx_sitesettingid: d\n  adx_name: Webapi/contact/fields\n  adx_value: contactid,emailaddress1',
    },
  });
  const local = await page.evaluate(() => ({
    rows: window.ds.sortedRecordIds.map((id) => window.ds.records[id].getValue('tst_title')),
    contact: window.ds.records[window.ds.sortedRecordIds[0]].getValue('tst_contact'),
    view: window.ds.getViewId(),
  }));
  assert.deepEqual(local.rows.slice(0, 2), ['Alpha', 'Bravo']);
  assert.deepEqual(local.contact, { id: { guid: contactId }, etn: 'contact', name: 'Demo Developer' });
  assert.equal(local.view, viewId);
  assert.ok(requests.some((request) => request.startsWith('GET /_api/tst_rows')));
  assert.ok(app.state().diagnostics.some((entry) => entry.code === 'PCF_LIQUID_DATASET_LOCAL'));
  assert.deepEqual(errors, []);
});

// @test-kind contract: the dataset reports the page size the grid service applied (Mirage's grid caps a requested size above 50 to the list's own, at most 250), never the size it asked for
test('dataset paging reports the page size the grid service applied', async (t) => {
  const many = (count) =>
    Array.from({ length: count }, (_, index) => ({
      tst_rowid: rowId(index + 1),
      tst_title: 'Row ' + String(index + 1).padStart(3, '0'),
    }));
  const hundred = await datasetPortal(t, { listPageSize: 100, rows: many(120), columns: ['tst_title'] });
  const resized = await act(hundred.page, 'ds.paging.setPageSize(75); ds.refresh();');
  assert.deepEqual([resized.paging.size, resized.rows.length, resized.paging.next], [100, 100, true]);
  const large = await datasetPortal(t, { listPageSize: 300, rows: many(260), columns: ['tst_title'] });
  const capped = await large.page.evaluate(() => [
    window.ds.paging.pageSize,
    window.ds.sortedRecordIds.length,
    window.ds.paging.hasNextPage,
  ]);
  assert.deepEqual(capped, [250, 250, true]);
  assert.deepEqual([...hundred.errors, ...large.errors], []);
});

// @test-kind observation: a data set without read permission, live captures paqvilo-developer pcf-parity summary-C2 (Q-094, capture d1 and d2 list-denied-ny.json, subgrid-denied-ny.json)
test('a list or subgrid data set without read permission stays loading with no records, error or updateView', async (t) => {
  const state = (page) =>
    page.evaluate(() => ({
      loading: window.ds.loading,
      error: window.ds.error,
      message: window.ds.errorMessage,
      code: window.ds.errorCode === undefined,
      records: window.ds.sortedRecordIds.length,
      total: window.ds.paging.totalResultCount,
      events: window.events.map((event) => event.props),
      mounted: Boolean(document.querySelector('[data-pcf-schema]')),
    }));
  const denied = {
    loading: true,
    error: false,
    message: '',
    code: true,
    records: 0,
    total: -1,
    events: [[], []],
    mounted: true,
  };
  const list = await datasetPortal(t, { columns: ['tst_title'], permissionMode: 'enforce', permissions: [] });
  assert.deepEqual(await state(list.page), denied);
  // The subgrid's form record is readable; its rows are not.
  const subgrid = await datasetPortal(t, {
    host: 'subgrid',
    columns: ['tst_title'],
    permissionMode: 'enforce',
    permissions: [{ id: 'parents', entity: 'tst_parent', scope: 'global', operations: ['read'] }],
  });
  assert.deepEqual(await state(subgrid.page), denied);
  assert.deepEqual([...list.errors, ...subgrid.errors], []);
});

// @test-kind observation: a dataset PCF on an N:N subgrid mounts and lists the related rows, live captures paqvilo-developer pcf-parity summary-C2 (N:N subgrid, capture f1 and f2 nn-subgrid-ny.json)
test('an N:N subgrid data set mounts and lists the rows linked through the intersect table', async (t) => {
  const { page, errors, bodies } = await datasetPortal(t, {
    host: 'subgrid',
    relationship: 'tst_parent_links',
    columns: ['tst_title'],
    extraTables: {
      tst_link: [
        { tst_linkid: 'd9000000-0000-4000-8000-000000000001', tst_parentid: parentId, tst_rowid: rowId(1) },
        { tst_linkid: 'd9000000-0000-4000-8000-000000000002', tst_parentid: parentId, tst_rowid: rowId(3) },
      ],
    },
  });
  const nn = await page.evaluate(() => ({
    rows: window.ds.sortedRecordIds.map((id) => window.ds.records[id].getValue('tst_title')),
    total: window.ds.paging.totalResultCount,
    error: window.ds.error,
  }));
  assert.deepEqual(nn, { rows: ['Alpha', 'Charlie'], total: 2, error: false });
  // The same subgrid request members: the relationship travels only in the signed configuration.
  const [grid] = bodies.filter((entry) => entry.path.startsWith('/_services/entity-subgrid-data.json/'));
  assert.deepEqual(Object.keys(grid.body), [
    'base64SecureConfiguration',
    'sortExpression',
    'search',
    'page',
    'pageSize',
    'pcfFilter',
    'timezoneOffset',
    'entityName',
    'entityId',
  ]);
  assert.deepEqual([grid.body.entityName, grid.body.entityId], ['tst_row', parentId]);
  assert.deepEqual(errors, []);
});

const rankViewId = 'd0000000-0000-4000-8000-000000000006';
const viewEntry = (id, label) =>
  `{"Type":"View","ViewId":"${id}","DisplayName":[{"Type":"LanguageResources","LCID":1033,"Value":"${label}"}]}`;

/** The toolbar's views, the bound data set's view and columns and the lifecycle of every instance so far. */
const viewState = (page) =>
  page.evaluate(() => ({
    toolbar: [...document.querySelectorAll('.entity-grid .view-toolbar .view-select [role="menuitem"]')].map((item) =>
      item.textContent.trim(),
    ),
    selected: document.querySelector('.entity-grid .view-toolbar .selected-view .title')?.textContent.trim(),
    view: [window.ds.getViewId(), window.ds.getTitle()],
    columns: window.ds.columns.filter((column) => column.name).map((column) => column.name),
    rows: window.ds.sortedRecordIds.length,
    error: window.ds.error,
    events: window.events.map((event) => event.kind + JSON.stringify(event.props)),
    instances: window.__paqviloPcf
      .inspect()
      .map((entry) => [
        entry.state,
        entry.lifecycle.map((item) => item.stage).filter((stage) => !stage.startsWith('dataset:')),
      ]),
  }));

/** Chooses a toolbar view by its position and waits for the new instance's first load to settle. */
async function chooseView(page, index, loads) {
  await page.evaluate((position) => {
    const grid = document.querySelector('.entity-grid[data-pcf-view-host]');
    grid.querySelector('.view-toolbar .selected-view').click();
    grid.querySelectorAll('.view-toolbar .view-select [role="menuitem"]')[position].click();
  }, index);
  await page.waitForFunction(settledLoads, loads);
}

// @test-kind observation: paqvilo-developer pcf-parity summary-F section 4 (runs fa and fb, views-list-ny, views-itemlist-ny and views-subgrid-ny, 2026-11-26): the list's or subgrid's own toolbar draws the view dropdown for two views (a subgrid with its view picker on), also for a control whose manifest declares no view options; choosing a view destroys the control and initialises a new one whose data set reports that view, with init, updateView [] and updateView ['dataset','Items','records'], also for the view already shown
test('a list or subgrid with two views draws its own view dropdown and choosing a view remounts the control on it', async (t) => {
  const files = {
    [`solution/Entities/tst_row/SavedQueries/${rankViewId}.xml`]: viewXml(
      rankViewId,
      'Rows by rank',
      ['tst_title', 'tst_rank'],
      0,
      'tst_rank',
    ),
    'portal/Rows.list.yml': `adx_entitylistid: rows
adx_name: All rows
adx_entityname: tst_row
adx_view: ${viewId}
adx_pagesize: 3
adx_iscodecomponent: true
adx_views: '{"Type":"ViewMetadata","Views":[${viewEntry(viewId, 'All rows by title')},${viewEntry(rankViewId, 'All rows by rank')}]}'`,
  };
  const hosts = [
    ['list', ['All rows by title', 'All rows by rank']],
    ['subgrid', ['Rows view', 'Rows by rank']],
  ];
  for (const [host, labels] of hosts) {
    const { page, errors } = await datasetPortal(t, {
      host,
      files,
      subgridParameters: `<EnableViewPicker>true</EnableViewPicker><ViewIds>{${viewId.toUpperCase()}},{${rankViewId.toUpperCase()}}</ViewIds>`,
    });
    const initial = await viewState(page);
    assert.deepEqual(initial.toolbar, labels, host);
    assert.equal(initial.selected, labels[0], host);
    assert.deepEqual(initial.view, [viewId, 'Rows view'], host);
    await chooseView(page, 1, 2);
    const switched = await viewState(page);
    assert.equal(switched.selected, labels[1], host);
    assert.deepEqual(switched.view, [rankViewId, 'Rows by rank'], host);
    assert.deepEqual(switched.columns, ['tst_title', 'tst_rank'], host);
    assert.deepEqual([switched.rows, switched.error], [3, false], host);
    assert.deepEqual(switched.events, ['init[]', 'updateView[]', 'updateView["dataset","Items","records"]'], host);
    assert.deepEqual(
      switched.instances,
      [
        ['ready', ['init', 'updateView', 'updateView:dataset']],
        ['destroyed', ['init', 'updateView', 'updateView:dataset', 'destroy']],
      ],
      host,
    );
    // The view already shown remounts too.
    await chooseView(page, 1, 3);
    const again = await viewState(page);
    assert.deepEqual(again.view, [rankViewId, 'Rows by rank'], host);
    assert.deepEqual(
      again.instances.map(([state]) => state),
      ['ready', 'destroyed', 'destroyed'],
      host,
    );
    assert.deepEqual(errors, [], host);
  }
});

// @test-kind unproven: the view picker of an ordinary (non code component) subgrid is not captured (pcf-parity summary-F section 4 captured it on a code component subgrid only); Mirage keeps such a subgrid on its default view
test('an ordinary subgrid with its view picker on keeps its default view and draws no view dropdown', async (t) => {
  const picker = `<EnableViewPicker>true</EnableViewPicker><ViewIds>{${viewId.toUpperCase()}},{${rankViewId.toUpperCase()}}</ViewIds>`;
  const { page } = await datasetPortal(t, {
    host: 'subgrid',
    loads: 0,
    subgridParameters: picker,
    files: {
      [`solution/Entities/tst_row/SavedQueries/${rankViewId}.xml`]: viewXml(
        rankViewId,
        'Rows by rank',
        ['tst_title', 'tst_rank'],
        0,
        'tst_rank',
      ),
      'solution/Entities/tst_row/Entity.xml': `<Entity><Name>tst_row</Name><EntityInfo><entity Name="tst_row"><EntitySetName>tst_rows</EntitySetName><attributes>${rowAttributes}</attributes></entity></EntityInfo></Entity>`,
      'solution/Entities/tst_parent/FormXml/main/parent-form.xml': `<systemform><formid>{${formId}}</formid><type>2</type><LocalizedNames><LocalizedName description="Parent" languagecode="1033"/></LocalizedNames><form><tabs><tab name="general"><columns><column><sections><section name="main"><rows><row><cell><control id="children" indicationOfSubgrid="true"><parameters><TargetEntityType>tst_row</TargetEntityType><ViewId>${viewId}</ViewId><RelationshipName>tst_parent_rows</RelationshipName><RecordsPerPage>3</RecordsPerPage>${picker}</parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform>`,
    },
  });
  await page.waitForFunction(() => document.querySelectorAll('.entity-grid tbody tr').length === 3);
  assert.deepEqual(
    await page.evaluate(() => ({
      select: document.querySelectorAll('.view-select').length,
      pcf: document.querySelectorAll('[data-pcf-view-host]').length,
    })),
    { select: 0, pcf: 0 },
  );
});
