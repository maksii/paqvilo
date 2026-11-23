// @test-kind observation: markup shapes observed in signed-in captures of six Microsoft Power Pages template sites (replica originals/response and dom, batch 1 and 2) and in raw pages of a live demo portal, 2026-11; every table, column, form and list name and every ID here is invented
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { observePortalNode } from '../lense/portal-node-observation.mjs';
import { resolveInspectionEvidence } from '../lense/inspection-evidence.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const EMPTY = '00000000-0000-0000-0000-000000000000';
const FORM_ID = 'a1b2c3d4-0000-4000-8000-00000000f001';
const HEX = FORM_ID.replaceAll('-', '');
const FORMXML_ID = 'a1b2c3d4-0000-4000-8000-00000000f0f0';
const LIST_ID = 'a1b2c3d4-0000-4000-8000-00000000a001';
const VIEW_ID = 'a1b2c3d4-0000-4000-8000-00000000b001';
const layout = (table) => `<span data-form-layout='{"EntityName":"${table}","Id":"${EMPTY}"}'></span>`;
// A grid's view layouts: base64 JSON with Columns[].LogicalName/Name and Configuration.EntityName, as the portal writes them.
const viewLayouts = (table, columns) =>
  Buffer.from(
    JSON.stringify([
      {
        Configuration: { EntityName: table, ViewId: VIEW_ID },
        Columns: columns.map(([LogicalName, Name]) => ({ LogicalName, Name, Width: 100 })),
        Id: VIEW_ID,
      },
    ]),
  ).toString('base64');

// A basic form as Power Pages renders it: wrapper, custom JavaScript span, panel, form view with its layout span,
// validation summary, a tab title and tab, a section in a fieldset, cells with labels, validators and controls
// (text, lookup with its dialog, date picker, options, a code component host), the actions bar.
const basicForm = (wrapper = 'EntityFormControl_' + HEX, view = wrapper + '_EntityFormView') =>
  `<div id="${wrapper}"><span><script></script></span><div id="EntityFormPanel" class="crmEntityFormView"><div id="${view}" class="entity-form">` +
  `<input type="hidden" id="${view}_EntityName">` +
  layout('sample_entry').replace('<span ', `<span id="${view}_EntityLayoutConfig" `) +
  `<div id="ValidationSummary${view}" class="validation-summary alert"></div>` +
  '<h2 class="tab-title" id="tab-title">General</h2>' +
  '<div data-name="general_tab" class="tab clearfix"><div class="tab-column"><div><fieldset id="fieldset"><table role="presentation" data-name="main_section" class="section"><tbody>' +
  '<tr id="row"><td class="clearfix cell text form-control-cell" id="title-cell"><div class="table-info required"><label for="sample_title" id="sample_title_label">Title</label><div class="validators"><span id="RequiredFieldValidatorsample_title"></span></div></div><div class="control" data-logical-name="sample_title"><input type="text" id="sample_title" class="text form-control"></div></td><td class="cell zero-cell" id="zero-cell"></td></tr>' +
  // A column whose own logical name ends in _name: its input is the column's plain input, not a lookup's display field.
  '<tr><td class="clearfix cell text form-control-cell"><div class="table-info"><label for="sample_short_name" id="sample_short_name_label">Short name</label></div><div class="control" data-logical-name="sample_short_name"><input type="text" id="sample_short_name" class="text form-control"></div></td></tr>' +
  '<tr><td class="clearfix cell lookup form-control-cell"><div class="table-info"><label id="sample_owner_label" class="field-label">Owner</label></div><div class="control" data-logical-name="sample_owner"><div class="input-group"><input type="text" id="sample_owner_name" readonly><input type="hidden" id="sample_owner"><input type="hidden" id="sample_owner_entityname"><button type="button" class="btn btn-default launchentitylookup" id="launch"><span class="fa fa-search" id="launch-icon"></span></button></div>' +
  `<div id="sample_owner_lookupmodal" class="lookup-modal"><div class="entity-lookup" data-lookup-datafieldname="sample_owner"><section class="modal fade modal-lookup"><div class="modal-body"><div class="entity-grid" data-view-layouts="${viewLayouts('sample_target', [['sample_label', 'Label']])}"><div class="view-grid"><table><tbody><tr data-entity="sample_target"><td data-attribute="sample_label" data-th="Label" id="lookup-cell"></td></tr></tbody></table></div></div></div></section></div></div></div></td></tr>` +
  '<tr><td class="clearfix cell datetime form-control-cell"><div class="control" data-logical-name="sample_due"><input type="text" id="sample_due" data-ui="datetimepicker" data-attribute="sample_due"><div class="input-append input-group"><input type="text" id="sample_due_datepicker_description"><span class="input-group-addon btn"><span class="fa fa-calendar" id="calendar-icon"></span></span></div></div></td></tr>' +
  '<tr><td class="clearfix cell"><div class="control" data-logical-name="sample_flag"><span id="sample_flag"><input type="radio" id="sample_flag_0" name="sample_flag"><input type="radio" id="sample_flag_1" name="sample_flag"></span></div></td></tr>' +
  '<tr><td class="clearfix cell"><div class="control" data-logical-name="sample_photo"><div id="PcfControl_0f1e2d3c4b5a69788796a5b4c3d2e1f0"><span id="sample_photo_Container"><script></script>' +
  `<span id="PcfControlConfig_sample_photo" data-pcf-control="{}" pcf-controlcontext='{"UniqueId":"sample_photo_ControlView","ControlId":"sample_photo","ControlName":"sample_Invented.Uploader"}'></span>` +
  '<div id="sample_photo_ControlView"><div class="upload-area"><button type="button" id="upload">Choose</button></div></div></span></div><input type="hidden" id="sample_photo"></div></td></tr>' +
  '</tbody></table></fieldset></div></div></div>' +
  '<div class="frm-g-0a1b" aria-hidden="true"><input type="text" id="frm_pref_0a1b"></div>' +
  '</div><div class="actions"><input type="button" id="InsertButton" value="Submit"></div></div></div>';

// A list as the portal renders it for a Liquid tag (no list ID on the wrapper) or a page record (#EntityListControl),
// with a filter panel EntityList<list id>, toolbar and search, the grid, its messages, pagination and an action dialog.
const listMarkup = ({ filter = false, control = false } = {}) =>
  (control ? '<div id="EntityListControl">' : '') +
  '<div class="entitylist"><div class="row">' +
  (filter
    ? `<div class="filter-vertical"><div id="EntityList${LIST_ID}" class="content-panel entitylist-filter"><ul id="entitylist-filters"><li><input type="radio" id="filter-option" name="0"></li></ul></div></div>`
    : '') +
  `<div class="col-lg-9"><div class="entity-grid entitylist" id="grid" data-view-layouts="${viewLayouts(
    'sample_entry',
    [
      ['sample_title', 'Title'],
      ['sample_due', 'Due'],
    ],
  )}" data-selected-view="${VIEW_ID}">` +
  '<div class="view-toolbar grid-actions"><div class="toolbar-actions"><div class="view-search entitylist-search"><input class="query form-control" id="search"></div></div></div>' +
  '<div class="view-grid"><table><thead><tr><th id="title-header"><a href="#" aria-label="Title" id="title-sort">Title</a></th><th id="due-header"><a href="#" aria-label="Due">Due</a></th></tr></thead>' +
  '<tbody><tr data-entity="sample_entry"><td data-attribute="sample_title" data-th="Title" id="title-value"></td><td data-th="Due" id="due-value"></td></tr></tbody></table></div>' +
  '<div class="view-empty message" id="empty"></div><div class="view-pagination" id="pager"></div>' +
  '<div class="modal fade modal-form modal-form-edit" id="edit-dialog"><div class="modal-body"><iframe data-page="/_portal/modal-form-template-path/invented" src="about:blank" id="edit-frame"></iframe></div></div>' +
  '</div></div></div></div>' +
  (control ? '</div>' : '');

const scope = { documentId: 'real-shape', frameId: 'top', uiEpoch: 1, sourceRevision: 'real-shape-source' };
const columns = ['sample_title', 'sample_short_name', 'sample_owner', 'sample_due', 'sample_flag', 'sample_photo'].map(
  (name) => ({
    entity: 'sample_entry',
    name,
  }),
);
const form = (extra = {}) => ({
  id: FORM_ID,
  kind: 'basic-form',
  entity: 'sample_entry',
  name: 'Invented entry form',
  formXml: {
    id: FORMXML_ID,
    name: 'Invented main form',
    layout: [{ name: 'general_tab', sections: ['main_section'] }],
  },
  ...extra,
});
const list = (extra = {}) => ({
  id: LIST_ID,
  recordId: LIST_ID,
  kind: 'list',
  entity: 'sample_entry',
  name: 'Invented entries',
  viewIds: [VIEW_ID],
  pageReferenced: true,
  ...extra,
});
const bindingsOf = (extra = {}) => ({
  forms: [form()],
  lists: [],
  views: [{ id: VIEW_ID, entity: 'sample_entry', name: 'Invented view' }],
  columns,
  codeComponents: [
    {
      binding: 'native-formxml',
      name: 'sample_Invented.Uploader',
      schemaName: 'sample_Invented.Uploader',
      field: 'sample_photo',
      formId: FORM_ID,
    },
  ],
  ...extra,
});

async function portalPage(t, html) {
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  await page.route('http://127.0.0.1:11893/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>' + html + '</body>' }),
  );
  await page.goto('http://127.0.0.1:11893/');
  // The page's own document stands in for X-ray's: the inspection report describes this document.
  const read = new Function(
    'data',
    `const node=document.querySelector(data.selector);return (${observePortalNode.toString()})(node,{...data.options,bindings:{...data.options.bindings,pageDocument:document}});`,
  );
  const observe = async (selector, bindings = bindingsOf()) => {
    const packet = await page.evaluate(read, { selector, options: { scope, bindings } });
    return {
      packet,
      evidence: resolveInspectionEvidence({ ...packet, mode: 'live', node: { connected: true } }),
    };
  };
  return { page, observe };
}

const owner = ({ evidence }) => ({
  status: evidence.owner.status,
  key: evidence.owner.component?.key,
  label: evidence.owner.evidence?.[0]?.label,
});

test('every part of a rendered form control names its column, and the code component host names its component', async (t) => {
  const { observe } = await portalPage(t, basicForm());
  const column = (name) => 'column:sample_entry:' + name;
  const expectations = [
    ['#sample_title', column('sample_title'), null],
    ['#sample_title_label', column('sample_title'), 'Label of this column'],
    ['#RequiredFieldValidatorsample_title', column('sample_title'), 'Validator of this column'],
    ['#title-cell', column('sample_title'), 'Cell of this column'],
    // A label without for: its ID <column>_label.
    ['#sample_owner_label', column('sample_owner'), 'Label of this column'],
    ['#sample_owner_name', column('sample_owner'), 'Lookup of this column'],
    ['#launch-icon', column('sample_owner'), 'Lookup of this column'],
    // The lookup dialog's grid shows the target table's rows: it is still the lookup's column, not the target's.
    ['#lookup-cell', column('sample_owner'), 'Lookup dialog of this column'],
    ['#sample_due_datepicker_description', column('sample_due'), 'Date picker of this column'],
    ['#calendar-icon', column('sample_due'), 'Date picker of this column'],
    ['#sample_flag_1', column('sample_flag'), 'Option of this column'],
    ['#sample_short_name', column('sample_short_name'), null],
    ['#sample_short_name_label', column('sample_short_name'), 'Label of this column'],
  ];
  assert.notEqual(owner(await observe('#sample_short_name')).label, 'Lookup of this column');
  for (const [selector, key, label] of expectations) {
    const result = owner(await observe(selector));
    assert.equal(result.status, 'exact', selector);
    assert.equal(result.key, key, selector);
    if (label) assert.equal(result.label, label, selector);
  }
  const mounted = await observe('#upload');
  assert.deepEqual(owner(mounted), {
    status: 'exact',
    key: 'pcf:sample_invented.uploader',
    label: 'Code component of this column',
  });
  assert.ok(
    mounted.evidence.enclosing.some((row) => row.component.key === column('sample_photo') && row.status === 'exact'),
    'the code component encloses nothing but sits in its column',
  );
  const withoutManifest = owner(await observe('#upload', bindingsOf({ codeComponents: [] })));
  assert.equal(withoutManifest.key, column('sample_photo'), 'an unknown code component leaves its column as owner');
  assert.equal(withoutManifest.label, 'Code component of this column');
});

test('form chrome, tabs and sections are named parts of their form', async (t) => {
  const { observe } = await portalPage(t, basicForm());
  const formKey = 'basic-form:' + FORM_ID;
  for (const [selector, key] of [
    ['#ValidationSummaryEntityFormControl_' + HEX + '_EntityFormView', formKey + '#validation-summary'],
    ['#InsertButton', formKey + '#actions'],
    ['#frm_pref_0a1b', formKey + '#honeypot'],
    ['#EntityFormControl_' + HEX + '_EntityFormView_EntityLayoutConfig', formKey + '#state'],
    ['#EntityFormControl_' + HEX + ' > span', formKey + '#custom-javascript'],
    ['#tab-title', 'form:' + FORMXML_ID + ':tab:general_tab'],
    ['.tab-column', 'form:' + FORMXML_ID + ':tab:general_tab'],
    ['#fieldset', 'form:' + FORMXML_ID + ':section:main_section'],
    ['#zero-cell', 'form:' + FORMXML_ID + ':section:main_section'],
    ['#EntityFormPanel', formKey],
  ]) {
    const result = owner(await observe(selector));
    assert.equal(result.status, 'exact', selector);
    assert.equal(result.key, key, selector);
  }
  // Without the form's layout in the report a tab is only named by the page: Likely, with the reason shown.
  const unlisted = await observe('.tab-column', bindingsOf({ forms: [form({ formXml: { id: FORMXML_ID } })] }));
  assert.equal(unlisted.evidence.owner.status, 'candidate');
  assert.equal(unlisted.evidence.candidates[0].component.key, 'form:' + FORMXML_ID + ':tab:general_tab');
  assert.equal(unlisted.evidence.candidates[0].label, 'Named by the page; the form layout was not read');
  // A tab the listed layout does not have is not named at all.
  const renamed = await observe(
    '.tab-column',
    bindingsOf({ forms: [form({ formXml: { id: FORMXML_ID, layout: [{ name: 'other_tab', sections: [] }] } })] }),
  );
  assert.equal(renamed.evidence.owner.status, 'unavailable');
});

test("a generic wrapper of the page's own document renders the form its web page record names", async (t) => {
  const { page, observe } = await portalPage(t, basicForm('EntityFormControl', 'EntityFormControl_EntityFormView'));
  const configured = bindingsOf({ pageFormId: FORM_ID });
  const wrapper = await observe('#EntityFormControl', configured);
  assert.deepEqual(owner(wrapper), {
    status: 'exact',
    key: 'basic-form:' + FORM_ID,
    label: 'Form of this web page',
  });
  assert.equal(wrapper.evidence.owner.evidence[0].kind, 'page-configured-component');
  assert.equal(owner(await observe('#sample_owner_label', configured)).key, 'column:sample_entry:sample_owner');
  assert.ok(
    (await observe('#sample_title', configured)).evidence.enclosing.some(
      (row) => row.component.key === 'basic-form:' + FORM_ID && row.status === 'exact',
    ),
  );
  // Without the page's configured form the generic wrapper names nothing.
  assert.equal(owner(await observe('#sample_title')).status, 'unavailable');
  // The page's configuration describes the page's document, not a frame's.
  const frame = await page.evaluate(
    (html) =>
      new Promise((resolve) => {
        const element = document.createElement('iframe');
        element.srcdoc = html;
        element.onload = () => resolve(true);
        document.body.append(element);
      }),
    basicForm('EntityFormControl', 'EntityFormControl_EntityFormView'),
  );
  assert.equal(frame, true);
  const inFrame = await page.evaluate(
    ({ observe, scope, bindings }) => {
      const frameDocument = document.querySelector('iframe').contentDocument;
      const fn = new Function('return ' + observe)();
      return fn(frameDocument.getElementById('sample_title'), {
        scope,
        bindings: { ...bindings, pageDocument: document },
      });
    },
    { observe: observePortalNode.toString(), scope, bindings: configured },
  );
  assert.equal(
    inFrame.facts.some((fact) => fact.proof === 'page-configured-component'),
    false,
    'a frame document never borrows the page record of the top document',
  );
});

test('a page-bound multistep form wrapper with an empty layout ID renders the multistep form its web page record names', async (t) => {
  const WIZARD_ID = 'a1b2c3d4-0000-4000-8000-00000000c001';
  const wizard =
    '<div id="WebFormControl"><div id="WebFormControl_ProgressIndicator"><ol class="progress"><li class="active">First</li></ol></div>' +
    '<div id="WebFormPanel"><div id="EntityFormView" class="entity-form">' +
    layout('sample_entry') +
    '<div data-name="general_tab" class="tab clearfix"><div class="tab-column"><div><fieldset id="fieldset"><table role="presentation" data-name="main_section" class="section"><tbody>' +
    '<tr><td class="clearfix cell text form-control-cell" id="title-cell"><div class="table-info"><label for="sample_title">Title</label></div><div class="control" data-logical-name="sample_title"><input type="text" id="sample_title"></div></td><td class="cell zero-cell" id="zero-cell"></td></tr>' +
    '</tbody></table></fieldset></div></div></div></div></div></div>';
  const { observe } = await portalPage(t, wizard);
  const advanced = {
    id: WIZARD_ID,
    kind: 'advanced-form',
    name: 'Invented wizard',
    entity: 'sample_entry',
    configuredEntities: ['sample_entry'],
    formXml: null,
    formLayouts: [
      {
        id: FORMXML_ID,
        entity: 'sample_entry',
        name: 'Invented main form',
        layout: [{ name: 'general_tab', sections: ['main_section'] }],
      },
    ],
  };
  const configured = bindingsOf({ forms: [advanced], pageWebFormId: WIZARD_ID });
  assert.equal(owner(await observe('#sample_title', configured)).key, 'column:sample_entry:sample_title');
  assert.deepEqual(owner(await observe('#zero-cell', configured)), {
    status: 'exact',
    key: 'form:' + FORMXML_ID + ':section:main_section',
    label: 'Section of this form',
  });
  assert.equal(owner(await observe('.tab-column', configured)).status, 'exact');
  // Without the web page's multistep form the generic wrapper names nothing.
  assert.equal(owner(await observe('#sample_title', bindingsOf({ forms: [advanced] }))).status, 'unavailable');
});

test('a list without a rendered list ID is the one list the page uses for the rendered view; its parts are named', async (t) => {
  const { page, observe } = await portalPage(t, listMarkup());
  const configured = bindingsOf({ lists: [list()] });
  const listKey = 'list:' + LIST_ID;
  const grid = await observe('#grid', configured);
  assert.equal(owner(grid).key, 'view:' + VIEW_ID, 'the grid is its view, as the list renderers name it');
  assert.ok(grid.evidence.enclosing.some((row) => row.component.key === listKey && row.status === 'exact'));
  const wrapper = await observe('.entitylist:not(.entity-grid)', configured);
  assert.equal(owner(wrapper).key, listKey);
  assert.equal(owner(wrapper).label, 'List this page uses, showing this view');
  // Headers and cells: the layout column at their index, checked against the display name the cell shows.
  for (const [selector, name] of [
    ['#title-header', 'sample_title'],
    ['#title-sort', 'sample_title'],
    ['#due-header', 'sample_due'],
    ['#title-value', 'sample_title'],
    ['#due-value', 'sample_due'],
  ])
    assert.equal(owner(await observe(selector, configured)).key, 'column:sample_entry:' + name, selector);
  for (const [selector, part] of [
    ['#search', 'search'],
    ['.view-toolbar', 'toolbar'],
    ['#pager', 'pagination'],
    ['#empty', 'empty'],
    ['#edit-frame', 'action:edit'],
  ])
    assert.equal(owner(await observe(selector, configured)).key, listKey + '#' + part, selector);
  // A list the page does not use, or a second grid showing the same view, names no list.
  assert.equal(
    (await observe('#title-value', bindingsOf({ lists: [list({ pageReferenced: false })] }))).evidence.enclosing.some(
      (row) => row.component.kind === 'list',
    ),
    false,
  );
  await page.evaluate(() => document.body.append(document.querySelector('.entitylist').cloneNode(true)));
  assert.equal(
    (await observe('#title-value', configured)).evidence.enclosing.some((row) => row.component.kind === 'list'),
    false,
    'two grids showing the view cannot both be the one list',
  );
});

test('a filter panel and a page-bound list wrapper name their list record', async (t) => {
  const { observe } = await portalPage(t, listMarkup({ filter: true, control: true }));
  const listKey = 'list:' + LIST_ID;
  // The filter panel's EntityList<list id> identifies the list even when the page uses none.
  const filtered = bindingsOf({ lists: [list({ pageReferenced: false })] });
  assert.equal(owner(await observe('#filter-option', filtered)).key, listKey + '#filter');
  assert.equal(
    (await observe('#title-value', filtered)).evidence.enclosing.find((row) => row.component.kind === 'list')?.status,
    'exact',
  );
  // A generic #EntityListControl renders the list the web page record names.
  const { observe: observeBound } = await portalPage(t, listMarkup({ control: true }));
  const bound = await observeBound(
    '.entitylist:not(.entity-grid)',
    bindingsOf({ lists: [list({ pageReferenced: false })], pageListId: LIST_ID }),
  );
  assert.equal(owner(bound).key, listKey);
  assert.equal(owner(bound).label, 'List of this web page');
});

test('a grid whose view is not in the Solution sources keeps its declared table and column as Likely, with the reason', async (t) => {
  const { observe } = await portalPage(t, listMarkup());
  const missing = bindingsOf({ views: [], columns: [] });
  for (const selector of ['#title-header', '#title-value', '#due-value']) {
    const { evidence } = await observe(selector, missing);
    assert.equal(evidence.owner.status, 'candidate', selector);
    assert.match(evidence.candidates[0].component.key, /^column:sample_entry:sample_(?:title|due)$/, selector);
    assert.equal(evidence.candidates[0].label, 'Named by the page; the view is not in your Solution sources');
    const table = evidence.enclosing.find((row) => row.component.kind === 'table');
    assert.equal(table.status, 'candidate', 'the table is only declared by the page');
  }
});

test('a display label is never a logical name and markers no live portal writes are not read', async (t) => {
  // data-th carries the column's display label; without a layout column at its index it names nothing.
  const { observe } = await portalPage(
    t,
    basicForm() +
      '<div class="entity-grid" id="bare-grid"><div class="view-grid"><table><tbody><tr data-entity="sample_entry"><td data-th="sample_title" id="label-only"></td></tr></tbody></table></div></div>',
  );
  assert.equal((await observe('#label-only')).evidence.owner.status, 'unavailable');
  // Invented markers (data-formid, data-entityname, data-fieldname, data-field) declare nothing on a live page.
  const { observe: observeInvented } = await portalPage(
    t,
    `<div data-formid="${FORM_ID}" data-entityname="sample_entry"><div data-fieldname="sample_title" data-field="sample_title"><input id="invented"></div></div>`,
  );
  const invented = await observeInvented('#invented');
  assert.equal(invented.evidence.owner.status, 'unavailable');
  assert.equal(invented.evidence.enclosing.length, 0);
  // Mirage writes data-pcf-native-field on its own code component hosts; it is read on Mirage pages only.
  const host = `<div id="EntityFormControl_${HEX}"><div id="EntityFormControl_${HEX}_EntityFormView">${layout('sample_entry')}<div data-pcf-native-field="sample_photo"><span id="mirage-host"></span></div></div></div>`;
  const { observe: observeHost } = await portalPage(t, host);
  assert.equal((await observeHost('#mirage-host')).evidence.owner.status, 'unavailable');
  assert.equal(
    owner(await observeHost('#mirage-host', bindingsOf({ mirage: true }))).key,
    'column:sample_entry:sample_photo',
  );
});

test('on Mirage pages the render registry names form parts; the observation adds none of its own', async (t) => {
  const { observe } = await portalPage(t, basicForm());
  const mirage = bindingsOf({ mirage: true });
  for (const selector of [
    '#ValidationSummaryEntityFormControl_' + HEX + '_EntityFormView',
    '.tab-column',
    '#sample_owner_label',
  ])
    assert.equal((await observe(selector, mirage)).evidence.owner.status, 'unavailable', selector);
  assert.equal(owner(await observe('#sample_title', mirage)).key, 'column:sample_entry:sample_title');
});
