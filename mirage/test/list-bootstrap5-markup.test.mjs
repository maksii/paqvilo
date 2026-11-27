// @test-kind unproven: local model of the Power Pages list markup on Bootstrap 5 and Bootstrap 3 sites; tests citing a capture override it
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';
import { gridRecord, buildLayout, actionLinks } from '../lib/native-services.mjs';
import { nativePageRegions } from '../lib/platform-manifest.mjs';
import { boundedMarkup } from './support/bounded-markup.mjs';

// A "widget" table and list on a Bootstrap 5 site (Site/BootstrapV5Enabled) and, for
// contrast, a Bootstrap 3 site.
const SITE = '5a000000-0000-4000-8000-000000000001';
const LIST = '5b000000-0000-4000-8000-000000000001';
const VIEW = '5c000000-0000-4000-8000-000000000001';
const CREATE_PAGE = '5d000000-0000-4000-8000-000000000001';
const fields = {
  widgetid: { name: 'widgetid', dataverseType: 'primarykey', label: 'Widget' },
  name: { name: 'name', dataverseType: 'nvarchar', label: 'Name', isPrimaryName: true },
  stamp: {
    name: 'stamp',
    dataverseType: 'datetime',
    label: 'Stamp',
    format: 'datetime',
    dateTimeBehavior: 'UserLocal',
  },
  regions: {
    name: 'regions',
    dataverseType: 'multiselectpicklist',
    label: 'Regions',
    options: [
      { value: 1, label: 'North' },
      { value: 2, label: 'South' },
    ],
  },
  amount: { name: 'amount', dataverseType: 'decimal', label: 'Amount', precision: 2 },
  statecode: { name: 'statecode', dataverseType: 'state', label: 'Status', options: [{ value: 0, label: 'Active' }] },
  statuscode: {
    name: 'statuscode',
    dataverseType: 'status',
    label: 'Status Reason',
    options: [{ value: 1, label: 'Active' }],
  },
};
const view = {
  id: VIEW,
  entity: 'widget',
  name: 'Active Widgets',
  fetchXml: `<fetch><entity name="widget"><attribute name="name"/><attribute name="stamp"/><attribute name="regions"/><attribute name="amount"/><order attribute="name"/></entity></fetch>`,
  fields: ['name', 'stamp', 'regions', 'amount'].map((name) => ({ name, width: 100 })),
};
const metadata = { entities: { widget: { fields } }, views: [view] };
const settings = {
  ViewActions: [
    {
      Type: 'CrmEntityFormView-CreateAction',
      TargetType: 1,
      RedirectWebpageId: CREATE_PAGE,
      ButtonLabel: [{ LCID: 1033, Value: 'New widget' }],
    },
  ],
  ItemActions: [
    {
      Type: 'CrmEntityFormView-DetailsAction',
      TargetType: 1,
      RedirectWebpageId: CREATE_PAGE,
      ButtonLabel: [{ LCID: 1033, Value: 'View' }],
    },
    {
      Type: 'CrmEntityFormView-DeleteAction',
      ButtonLabel: [{ LCID: 1033, Value: 'Delete' }],
      Confirmation: [{ LCID: 1033, Value: 'Delete this widget?' }],
    },
  ],
  CreateFormDialog: { Size: 1, CssClass: 'widget-dialog', TitleCssClass: 'widget-title' },
};
function portal(v5) {
  return {
    website: { id: SITE },
    websiteLanguages: [{ lcid: 1033, isDefault: true }],
    pages: [{ id: CREATE_PAGE, url: '/widgets/new/' }],
    settings: { 'Site/BootstrapV5Enabled': v5 ? 'true' : 'false' },
    lists: [
      {
        id: LIST,
        name: 'Widgets',
        entityName: 'widget',
        metadata: {
          adx_entitylistid: LIST,
          adx_name: 'Widgets',
          adx_entityname: 'widget',
          adx_view: VIEW,
          adx_pagesize: 5,
          adx_searchenabled: true,
          adx_webpageforcreate: CREATE_PAGE,
          adx_createbuttonlabel: 'New widget',
          adx_settings: JSON.stringify(settings),
        },
      },
    ],
  };
}
const store = { resolveMapping: () => ({ entitySet: 'widgets', idColumn: 'widgetid', nameColumn: 'name' }) };
const render = (v5) =>
  renderComponent(
    'entitylist',
    'Widgets',
    { user: { id: 'current' }, request: { url: 'http://localhost/widgets/' }, key: 'Widgets' },
    { portal: portal(v5), metadata, store, schemas: {}, args: { key: 'Widgets' } },
  );
const layouts = (html) =>
  JSON.parse(Buffer.from(/data-view-layouts="([^"]*)"/.exec(html)[1], 'base64').toString('utf8'));

test('a Bootstrap 5 list renders the platform grid attributes, messages and div dialogs', async () => {
  const { html } = await render(true);
  const grid = /<div class="entity-grid entitylist" [^>]*>/.exec(boundedMarkup(html))[0];
  for (const attribute of [
    'data-id="',
    'data-grid-class=""',
    `data-get-ai-insights-url="/_services/entity-grid-ai-summary.json/${SITE}"`,
    `data-update-url="/_services/entity-grid-update-entity/${SITE}"`,
    'data-mobile-view-enabled="false"',
    'data-enable-streaming="true"',
    'data-nl-search-filter=""',
  ])
    assert.ok(grid.includes(attribute), attribute);
  assert.match(
    html,
    /<div class="view-empty message">There are no records to display\.<\/div><div class="view-empty-maker message">/,
  );
  assert.doesNotMatch(html, /<section|data-dismiss=|sr-only">Close/);
  assert.match(
    html,
    /<div aria-hidden="true" class="modal fade modal-form modal-form-insert widget-dialog" role="dialog" tabindex="-1"><div class="modal-dialog modal-lg">/,
  );
  assert.match(
    html,
    /<h4 class="modal-title widget-title"><span class='fa fa-edit' aria-hidden='true'><\/span> Create<\/h4><button class="btn-close" data-bs-dismiss="modal" type="button">/,
  );
  assert.match(
    html,
    new RegExp(
      `aria-labelledby="modalTitleID_${LIST}"><div class="modal-dialog "><div class="modal-content"><div class="modal-header"><h4 id="modalTitleID_${LIST}"`,
    ),
  );
  assert.match(html, /<div class="modal-body">Delete this widget\?<\/div>/);
  assert.match(html, /modal-resolvecase/);
  // The list's create page is the InsertActionLink beside the configured create action.
  const configuration = layouts(html)[0].Configuration;
  assert.deepEqual(
    [
      configuration.InsertActionLink.Enabled,
      configuration.InsertActionLink.Target,
      configuration.InsertActionLink.Tooltip,
      configuration.InsertActionLink.URL.Path,
    ],
    [true, 2, 'Create', '/widgets/new/'],
  );
  assert.deepEqual(
    configuration.ViewActionLinks.map((action) => [action.Type, action.Tooltip]),
    [[3, 'Create']],
  );
  assert.deepEqual(
    configuration.ItemActionLinks.map((action) => action.Tooltip),
    ['View details', 'Delete'],
  );
  assert.equal(
    configuration.Search.TooltipText,
    'To search on partial text, use the asterisk (*) wildcard character. ',
  );
});

// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01d (lists-bs3.json, runs a and b, 2026-11-26): a Bootstrap 3 list renders the list template of a Bootstrap 5 list with Bootstrap 3 tokens: the same grid attributes and div dialogs, the close button (class close, data-dismiss, sr-only) before the title, and its own create and delete icons
test('a Bootstrap 3 list renders the list template with Bootstrap 3 tokens', async () => {
  const { html } = await render(false);
  assert.match(
    html,
    /^<div class="entitylist"><div class="entity-grid entitylist" data-id="[^"]+" data-column-width-style="" data-defer-loading="false" data-enable-actions="true" data-get-url="\/_services\/entity-grid-data\.json\/[^"]+" data-get-ai-insights-url="\/_services\/entity-grid-ai-summary\.json\/[^"]+" data-update-url="\/_services\/entity-grid-update-entity\/[^"]+" data-grid-class="table-striped" data-select-mode="None" data-selected-view="[^"]+" data-view-layouts="[^"]+" data-user-isauthenticated="true" data-user-parent-account-name="" data-mobile-view-enabled="false" data-ai-insights-enabled="false" data-enable-streaming="true" data-ai-insights-expanded="true" data-is-nl-search-enabled="false" data-ai-insights-position="top" data-nl-search-filter="">/,
  );
  assert.ok(
    html.includes(
      '<div aria-hidden="true" class="modal fade modal-form modal-form-insert widget-dialog" role="dialog" tabindex="-1"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><button class="close" data-dismiss="modal" type="button"><span aria-hidden="true">&times;</span><span class="sr-only">Close</span></button><h4 class="modal-title widget-title"><span class=\'fa fa-pencil-square-o\' aria-hidden=\'true\'></span> Create</h4></div>',
    ),
  );
  assert.match(html, /<h4 class="modal-title "><span class='fa fa-trash-o' aria-hidden='true'><\/span> Delete<\/h4>/);
  assert.match(
    html,
    /<div class="modal-header"><button class="form-close" data-dismiss="modal" tabindex="0" type="button"><span aria-hidden="true">&times;<\/span><span class="sr-only">Close<\/span><\/button><h4 class="modal-title "> Resolve case<\/h4><\/div><div class="form-horizontal modal-body"><div class="form-group"><label class="required control-label col-sm-3">/,
  );
  assert.doesNotMatch(html, /<section|data-bs-|visually-hidden/);
  assert.equal(layouts(html)[0].Configuration.InsertActionLink.Enabled, false);
});

test('grid records follow the service contract: no empty attributes, unformatted strings, culture dates, choices labels', () => {
  const layout = buildLayout({
    view,
    entity: 'widget',
    idColumn: 'widgetid',
    primaryName: 'name',
    metadata,
    configuration: {},
    secure: { t: 'query' },
  });
  const model = { entity: 'widget', idColumn: 'widgetid', primaryName: 'name', view };
  const row = {
    widgetid: '5e000000-0000-4000-8000-000000000001',
    name: 'Sprocket',
    stamp: '2026-03-04T10:30:00Z',
    regions: '1,2',
    amount: null,
    statecode: 0,
    statuscode: 1,
  };
  const context = {
    metadata,
    portal: { settings: { 'DateTime/DateFormat': 'yyyy-MM-dd' } },
    timezoneOffset: -120,
    store: {},
    config: { mode: 'live' },
  };
  const record = gridRecord(row, model, layout, context);
  const byName = Object.fromEntries(record.Attributes.map((attribute) => [attribute.Name, attribute]));
  assert.equal(byName.amount, undefined);
  assert.deepEqual(
    [byName.name.FormattedValue, byName.name.DisplayValue, byName.name.DateTimeBehavior],
    ['', 'Sprocket', null],
  );
  assert.deepEqual([byName.widgetid.FormattedValue, byName.widgetid.DisplayValue], ['', row.widgetid]);
  assert.deepEqual(
    [
      byName.stamp.FormattedValue,
      byName.stamp.DisplayValue,
      byName.stamp.DateTimeFormat,
      byName.stamp.DateTimeBehavior,
    ],
    ['3/4/2026 12:30 PM', '2026-03-04T10:30:00Z', 'DateAndTime', { Value: 'UserLocal', ExtensionData: {} }],
  );
  assert.deepEqual(
    [byName.regions.FormattedValue, byName.regions.DisplayValue, byName.regions.Value],
    [
      'South',
      'North; South',
      [
        { Value: 1, ExtensionData: {} },
        { Value: 2, ExtensionData: {} },
      ],
    ],
  );
  assert.deepEqual(
    [byName.statecode.FormattedValue, byName.statuscode.Value, record.StatusCode],
    ['Active', { Value: 1, ExtensionData: null }, 1],
  );
});

test("item action tooltips default to the platform's titles", () => {
  const actions = actionLinks(settings, { portal: portal(true), requestUrl: 'http://localhost/', website: SITE });
  assert.deepEqual(
    actions.map((action) => [action.Type, action.Tooltip]),
    [
      [3, 'Create'],
      [1, 'View details'],
      [4, 'Delete'],
    ],
  );
});

test('a choice filter in Dropdown selection mode renders one select box', async () => {
  const definition = {
    entity: {
      name: 'widget',
      filters: [
        {
          'adx.id': '1',
          'adx.uiorder': '0',
          'adx.uiname': 'Region',
          'adx.attribute': 'regions',
          'adx.uiselectionmode': 'Dropdown',
          type: 'or',
          conditions: [
            { 'adx.id': '0', uiname: 'North', attribute: 'regions', operator: 'eq', value: '1' },
            { 'adx.id': '1', uiname: 'South', attribute: 'regions', operator: 'eq', value: '2' },
          ],
        },
      ],
    },
  };
  const site = portal(true);
  Object.assign(site.lists[0].metadata, {
    adx_filter_enabled: true,
    adx_filter_definition: JSON.stringify(definition),
  });
  const { html } = await renderComponent(
    'entitylist',
    'Widgets',
    { user: { id: 'current' }, request: { url: 'http://localhost/widgets/' }, key: 'Widgets' },
    { portal: site, metadata, store, schemas: {}, args: { key: 'Widgets' } },
  );
  assert.match(
    html,
    /<label class="entitylist-filter-option-group-label h4" data-filter-id="1" for="dropdown_1">Region<\/label>[\s\S]*?<select class="form-control form-select" name="1" id="dropdown_1"><option value="" label=" "><\/option><option value="0" label="North">North<\/option><option value="1" label="South">South<\/option><\/select>/,
  );
  assert.doesNotMatch(html, /type="checkbox" name="1"/);
});

test('without the create privilege the list keeps its create links disabled; a page control list uses the legacy grid markup', async () => {
  const rulesStore = (operations) => ({
    ...store,
    state: { settings: { permissionMode: 'enforce' } },
    rules: (entity, operation) => (operations.includes(operation) ? [{ id: 'rule' }] : []),
  });
  const renderWith = (operations, args = { key: 'Widgets' }) =>
    renderComponent(
      'entitylist',
      'Widgets',
      { user: { id: 'current' }, request: { url: 'http://localhost/widgets/' }, key: 'Widgets' },
      { portal: portal(true), metadata, store: rulesStore(operations), schemas: {}, args },
    );
  const reader = layouts((await renderWith(['read'])).html)[0].Configuration;
  assert.equal(reader.InsertActionLink.Enabled, false);
  assert.deepEqual(
    reader.ViewActionLinks.filter((link) => link.Type === 3).map((link) => link.Enabled),
    [false],
  );
  const editor = layouts((await renderWith(['read', 'create'])).html)[0].Configuration;
  assert.equal(editor.InsertActionLink.Enabled, true);
  // A list bound to a legacy page: #EntityListControl > .entitylist > div > .entity-grid with the
  // grid messages and section dialogs, and no create page link (live page/bound-entitylist).
  const { html } = await renderWith(['read', 'create'], { key: 'Widgets', pp_page_control: true });
  assert.match(
    html,
    /^<div id="EntityListControl"><div class="entitylist"><div><div class="entity-grid entitylist" data-column-width-style="Percent" data-defer-loading="false" data-enable-actions="true" data-get-url="\/_services\/entity-grid-data\.json\/[^"]+" data-grid-class="" data-mobile-view-enabled="false" data-select-mode="None" data-selected-view="[^"]+" data-update-url="\/_services\/entity-grid-update-entity\/[^"]+" data-user-isauthenticated="true" data-user-parent-account-name="" data-view-layouts="[^"]+"><div class="view-grid"><\/div><div aria-label="There are no records to display\." aria-live="polite" class="view-empty message"/,
  );
  assert.match(
    html,
    /<div class="view-pagination" data-current-page="1" data-pages="1" data-pagesize=""><\/div><section aria-hidden="true" aria-label="Create" class="modal fade modal-form modal-form-insert/,
  );
  assert.doesNotMatch(html, /data-id="|data-get-ai-insights-url/);
  assert.equal(layouts(html)[0].Configuration.InsertActionLink.Enabled, false);
});

test('section grid dialogs of a Bootstrap 3 page control follow their dialog settings: class, size, title, loading text, dismiss text and delete confirmation', async () => {
  const text = (value) => [{ LCID: 1033, Value: value }];
  const configured = {
    ...settings,
    CreateFormDialog: {
      Size: 0,
      CssClass: 'widget-dialog',
      Title: text('Create widget'),
      LoadingMessage: text('Loading create widget...'),
      DismissButtonSrText: text('Close dialog'),
    },
    DetailsFormDialog: {
      Size: 2,
      CssClass: 'widget-dialog',
      Title: text('Widget'),
      LoadingMessage: text('Loading widget...'),
      DismissButtonSrText: text('Close dialog'),
    },
    DeleteDialog: {
      Size: 0,
      CssClass: 'widget-dialog',
      Title: text('Delete widget'),
      PrimaryButtonText: text('OK'),
      CloseButtonText: text('Close'),
      DismissButtonSrText: text('Close dialog'),
    },
  };
  const base = portal(false);
  base.lists[0].metadata.adx_settings = JSON.stringify(configured);
  // A page control keeps the legacy grid with its section dialogs.
  const { html } = await renderComponent(
    'entitylist',
    'Widgets',
    { user: { id: 'current' }, request: { url: 'http://localhost/widgets/' }, key: 'Widgets' },
    { portal: base, metadata, store, schemas: {}, args: { key: 'Widgets', pp_page_control: true } },
  );
  assert.match(
    html,
    /<section aria-hidden="true" aria-label="Create" class="modal fade modal-form modal-form-insert widget-dialog" data-backdrop="static" role="dialog" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h1 class="modal-title" title="Create">Create widget<\/h1><button aria-label="Close" class="form-close" data-dismiss="modal" style="position: absolute; top: 3%;" tabindex="0" title="Close dialog" type="button"><span aria-hidden="true">×<\/span><span class="sr-only">Close dialog<\/span><\/button><\/div><div class="modal-body"><div class="form-loading">Loading create widget\.\.\.<\/div><iframe /,
  );
  assert.match(
    html,
    /aria-label="Widget" class="modal fade modal-form modal-form-details widget-dialog" [^>]*><div class="modal-sm modal-dialog">/,
  );
  assert.match(
    html,
    /aria-label="Delete widget" class="modal fade modal-delete widget-dialog" [^>]*>[^]*?<div class="modal-body">Delete this widget\?<\/div><div class="modal-footer"><button aria-label="OK" class="primary btn btn-primary" tabindex="0" title="OK" type="button">OK<\/button><button aria-label="Close" class="cancel btn btn-default" data-dismiss="modal" tabindex="0" title="Close" type="button">Close<\/button>/,
  );
  // The page control's workflow dialog shows the list's default text with its body HTML-escaped, as every list does
  // (hosted-f2 summary-F2 LIST-01d).
  assert.match(
    html,
    /class="modal fade modal-run-workflow"[^>]*>[^]*?<div class="modal-body">&lt;p&gt;Are you sure you want to run this workflow\?&lt;\/p&gt;<\/div>/,
  );
});

test('a map list without map credentials renders the empty legacy list control inside the server form', async () => {
  const base = portal(true);
  Object.assign(base.lists[0].metadata, {
    adx_map_enabled: true,
    adx_map_latitudefieldname: 'amount',
    adx_map_longitudefieldname: 'amount',
  });
  const { html } = await renderComponent(
    'entitylist',
    'Widgets',
    { user: { id: 'current' }, request: { url: 'http://localhost/widgets/' }, key: 'Widgets' },
    { portal: base, metadata, store, schemas: {}, args: { key: 'Widgets' } },
  );
  assert.equal(
    html,
    `<!--pp-server-list--><div id="EntityListControl_${LIST.replace(/-/g, '')}"><div class="entitylist"></div></div>`,
  );
  // The page wraps it in the WebForms form without event validation, as the platform's list control.
  const form = nativePageRegions({ content: html, action: '/' }).content;
  assert.match(form, /^<form method="post" action="\/" id="liquid_form">/);
  assert.doesNotMatch(form, /__EVENTVALIDATION/);
  // No validators or form controls: no WebUIValidation script (three AXD scripts, live map list).
  assert.equal(form.match(/\.axd\?/g).length, 3);
});

test("a list's own messages and its activate, deactivate and error dialogs come from its settings", async () => {
  const text = (value) => [{ LCID: 1033, Value: value }];
  const configured = portal(true);
  configured.lists[0].metadata.adx_settings = JSON.stringify({
    ...settings,
    EmptyMessage: text('No widgets.'),
    AccessDeniedMessage: text('No access to widgets.'),
    ErrorMessage: text('Widgets failed.'),
    LoadingMessage: text('Loading widgets...'),
    DeactivateDialog: {
      CssClass: 'widget-dialog',
      Title: text('Deactivate widget'),
      DismissButtonSrText: text('Close dialog'),
    },
    ActivateDialog: { CssClass: 'widget-dialog', Title: text('Activate widget') },
    ErrorDialog: {
      CssClass: 'widget-dialog',
      Title: text('Widget error'),
      Body: text('Widget error.'),
      CloseButtonText: text('Close'),
    },
  });
  const { html } = await renderComponent(
    'entitylist',
    'Widgets',
    { user: { id: 'current' }, request: { url: 'http://localhost/widgets/' }, key: 'Widgets' },
    { portal: configured, metadata, store, schemas: {}, args: { key: 'Widgets' } },
  );
  assert.match(html, /<div class="view-empty message">No widgets\.<\/div>/);
  assert.match(
    html,
    /<div class="view-access-denied message">No access to widgets\.<\/div><div class="view-error message">Widgets failed\.<\/div><div class="view-loading message text-center">Loading widgets\.\.\.<\/div>/,
  );
  assert.match(html, /class="modal fade modal-deactivate widget-dialog"[^]*?Deactivate widget[^]*?Close dialog/);
  assert.match(html, /class="modal fade modal-activate widget-dialog"[^]*?Activate widget/);
  assert.match(
    html,
    /class="modal fade modal-error widget-dialog"[^]*?<div class="modal-body">Widget error\.<\/div><div class="modal-footer"><button class="cancel btn btn-default btn btn-default" data-bs-dismiss="modal" type="button">Close<\/button>/,
  );
});

// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01d (map.json, runs a and b): a map list included as modern renders the modern grid of its view, so its render provenance names the modern layout
test('a map list included as modern reports the modern layout to render provenance', async () => {
  const base = portal(true);
  base.lists[0].metadata.adx_map_enabled = true;
  const rendered = [];
  await renderComponent(
    'entitylist',
    'Widgets',
    { user: { id: 'current' }, request: { url: 'http://localhost/widgets/' }, key: 'Widgets', isModern: 'true' },
    {
      portal: base,
      metadata,
      store,
      schemas: {},
      args: { key: 'Widgets', isModern: 'true' },
      onComponentRendered: (component) => rendered.push(component.layout),
    },
  );
  assert.deepEqual(rendered, ['modern']);
});

// A calendar list (start and summary columns) and a dataset code component list whose table names a grid control.
function variantPortal(column) {
  const base = portal(true);
  Object.assign(
    base.lists[0].metadata,
    column === 'calendar'
      ? { adx_calendar_enabled: true, adx_calendar_startdatefieldname: 'stamp', adx_calendar_summaryfieldname: 'name' }
      : { adx_iscodecomponent: true },
  );
  return base;
}
const gridControl = { ...metadata, entities: { widget: { fields, grid: { control: 'x_Invented.Grid' } } } };
async function renderVariant(column, modern) {
  const rendered = [],
    diagnostics = [],
    mounted = [];
  const isModern = modern ? { isModern: 'true' } : {};
  const { html } = await renderComponent(
    'entitylist',
    'Widgets',
    { user: { id: 'current' }, request: { url: 'http://localhost/widgets/' }, key: 'Widgets', ...isModern },
    {
      portal: variantPortal(column),
      metadata: gridControl,
      store,
      schemas: {},
      args: { key: 'Widgets', ...isModern },
      onComponentRendered: (component) => rendered.push(component.layout),
      diagnostic: (entry) => diagnostics.push(entry.code),
      codeComponent: async (spec) => {
        mounted.push(spec.name);
        return `<div data-invented-pcf>__paqviloPcf.mount(${JSON.stringify(spec.name)})</div>`;
      },
    },
  );
  return { html, rendered, diagnostics, mounted };
}

// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01f (modernlists.json, runs a and b, 2026-11-27): a calendar list and a dataset code component list included as modern render pages-native-container with pages-grid and read GetListViewConfiguration and entity-grid-data; the page carries no calendar host or calendar scripts and no code component
test('a calendar or dataset code component list included as modern renders the modern grid of its view', async () => {
  for (const column of ['calendar', 'codecomponent']) {
    const { html, rendered, diagnostics, mounted } = await renderVariant(column, true);
    assert.deepEqual(rendered, ['modern'], column);
    assert.match(html, /^<pages-native-container><div id="list_[^"]+" class="pp-modern-list"/, column);
    assert.ok(html.includes(`<pages-grid list-id="${LIST}" `), column);
    assert.doesNotMatch(html, /data-view="calendar"|class="entitylist|class="entity-grid|data-invented-pcf/, column);
    assert.deepEqual(mounted, [], column);
    assert.ok(!diagnostics.includes('MODERN_LIST_RENDERED_CLASSIC'), column);
  }
});

// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01f (modernlists.json, runs a and b): the same lists included without isModern render the calendar host (data-view="calendar") and the dataset code component, as before
test('a calendar or dataset code component list included without isModern keeps its classic layout', async () => {
  const calendar = await renderVariant('calendar', false);
  assert.deepEqual(calendar.rendered, ['calendar']);
  assert.match(calendar.html, /data-view="calendar"/);
  const component = await renderVariant('codecomponent', false);
  assert.deepEqual(component.mounted, ['x_Invented.Grid']);
  assert.match(component.html, /data-invented-pcf/);
});
