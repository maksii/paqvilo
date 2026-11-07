// Platform render failures that stop a native form at a cell, the reference entity read-only form
// of a multistep step and server-rendered auto-generated steps ("gadget"/"holder" tables).
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';
import { createWebFormSessions } from '../lib/form-service.mjs';
import { decodeNativeViewState, nativeFormControlIds } from '../lib/native-postback.mjs';
import { RENDER_ABORT_MARKER } from '../lib/platform.mjs';
import { webFormsForm } from '../lib/platform-manifest.mjs';
import fs from 'node:fs';
import { makeTemporaryDirectorySync } from '../testing/owned-fixture.mjs';

const HOLDER = 'a0000000-0000-4000-8000-000000000001';
const FORM = 'f0000000-0000-4000-8000-000000000002';
const v5 = { 'Site/BootstrapV5Enabled': 'true' };
const store = {
  resolveMapping: (entity) =>
    entity === 'holder'
      ? { entitySet: 'holders', idColumn: 'holderid', nameColumn: 'name' }
      : {
          entitySet: 'gadgets',
          idColumn: 'gadgetid',
          relationships: { gadget_holder: { from: 'holderid', entity: 'holder', many: false } },
        },
  get: async (entity, id) =>
    entity === 'holder' && id === HOLDER
      ? { holderid: HOLDER, name: 'Holder One', code: 'H-1', statecode: 0, statuscode: 1 }
      : null,
  query: async () => ({ value: [] }),
};
const gadgetFields = [
  { name: 'name', label: 'Name', dataverseType: 'nvarchar', maxLength: 100, required: true },
  { name: 'code', label: 'Code', dataverseType: 'nvarchar', maxLength: 40 },
  { name: 'notes', label: 'Notes', dataverseType: 'memo' },
];
const section = (name, rows) => ({
  name,
  label: name,
  showLabel: true,
  columns: [{ width: '100%', sections: [{ name, label: name, showLabel: true, rows }] }],
});
const ALERT = (message) =>
  `<div class="alert alert-block alert-danger"><p class="text-danger"><span class="fa fa-exclamation-triangle" aria-hidden="true"></span> ${message}</p></div> </div>`;
const esc = (text) => text.replace(/[$.*+?()[\]{}|\\]/g, '\\$&');

test("a multistep step shows the reference record's read-only form first and fails at the first clashing control", async () => {
  const portal = {
    website: { id: 'site' },
    forms: [],
    lists: [],
    pages: [],
    records: [],
    settings: v5,
    websiteLanguages: [{ lcid: 1033, isDefault: true }],
    advancedForms: [{ id: 'wiz', name: 'Wizard', metadata: {} }],
  };
  const stepMetadata = {
    adx_setentityreference: true,
    adx_referenceentitysourcetype: 100000000,
    adx_referenceentitylogicalname: 'holder',
    adx_referencequerystringname: 'holderid',
    adx_referencequerystringisprimarykey: true,
    adx_referencetargetlookupattributelogicalname: 'holderid',
    adx_referenceentityshowreadonlyform: true,
    adx_referenceentityreadonlyformname: 'Holder main',
  };
  const schemas = {
    wiz: {
      initialStepId: 'one',
      steps: [
        {
          stepId: 'one',
          entity: 'gadget',
          mode: 100000000,
          formName: 'Gadget create',
          metadata: stepMetadata,
          fields: gadgetFields,
          layout: [section('create', [[{ name: 'notes' }], [{ name: 'name' }], [{ name: 'code' }]])],
        },
      ],
    },
    ReadOnlyFormView_holder: {
      entity: 'holder',
      title: 'Holder main',
      fields: [
        { name: 'name', label: 'Name', dataverseType: 'nvarchar', required: true },
        { name: 'code', label: 'Code', dataverseType: 'nvarchar' },
      ],
      layout: [section('general', [[{ name: 'name' }], [{ name: 'code' }]])],
    },
  };
  const html = await renderComponent(
    'webform',
    'Wizard',
    { request: { params: { holderid: HOLDER } } },
    { portal, store, schemas, webFormSessions: createWebFormSessions(), webFormOwner: () => 'visitor:a' },
  );
  const ids = nativeFormControlIds('webform', 'wiz');
  // The read-only view: the step's control names, no layout configuration, the record's state.
  assert.match(
    html,
    new RegExp(
      `<div id="WebFormPanel"[^>]*><div id="ReadOnlyFormView_holder" class="form-readonly entity-form read-only" readonly="readonly"><input type="hidden" name="${esc(ids.buttons)}ReadOnlyFormView_holder\\$ReadOnlyFormView_holder_EntityName" id="ReadOnlyFormView_holder_EntityName" value="holder">`,
    ),
  );
  assert.match(
    html,
    /id="ReadOnlyFormView_holder_EntityState" value="0"><input[^>]*id="ReadOnlyFormView_holder_EntityStatus" value="1"><span id="ReadOnlyFormView_holder_EntityLayoutConfig"><\/span><div id="ValidationSummaryReadOnlyFormView_holder"/,
  );
  assert.match(
    html,
    new RegExp(
      `<input name="${esc(ids.buttons)}ReadOnlyFormView_holder\\$name" type="text" value="Holder One"[^>]*readonly="readonly"`,
    ),
  );
  // The step's own view follows; "notes" (no clash) renders, "name" fails and nothing follows but the actions.
  const view = html.slice(html.indexOf('<div id="EntityFormView"'));
  assert.match(view, /<span id="EntityFormView_EntityLayoutConfig" data-form-layout=/);
  assert.match(view, /<textarea name="[^"]*\$EntityFormView\$notes"/);
  assert.match(
    view,
    new RegExp(
      `<td colspan="1" rowspan="1" class="clearfix cell text form-control-cell"><div class="table-info required"><label for="name" id="name_label" class="field-label">Name</label><div class="validators">${ALERT('An entry with the same key already exists.')}<div class="actions"><div class="col-md-6 clearfix"><div role="group" class="btn-group entity-action-button"><input type="button" name="[^"]*\\$NextButton"[^>]*id="NextButton"[^>]*></div></div></div> </td></tr></tbody></table></fieldset></div></div></div></div></div></div></div><script`,
    ),
  );
  // The view, panel, row and control stay open; the page is cut after the marker.
  assert.ok(html.endsWith(RENDER_ABORT_MARKER));
  assert.equal(view.includes('id="code"'), false);
  assert.equal(view.includes('frm_pref_'), false);
  assert.equal((view.match(/class="actions"/g) ?? []).length, 1);
});

async function gadget({ mode = 100000000, metadata = {}, cells, postback = null, params = {}, solution = undefined }) {
  const portal = {
    website: { id: 'site' },
    forms: [{ id: FORM, name: 'Gadget', mode, metadata: { adx_entityformid: FORM, ...metadata } }],
    lists: [],
    pages: [],
    records: [],
    settings: v5,
    websiteLanguages: [{ lcid: 1033, isDefault: true }],
  };
  const schemas = { [FORM]: { entity: 'gadget', title: 'Gadget', fields: gadgetFields, layout: cells } };
  const gadgetStore = {
    ...store,
    get: async (entity, id) =>
      entity === 'gadget' ? { gadgetid: id, name: 'Existing', statecode: 0, statuscode: 1 } : store.get(entity, id),
    allowed: () => true,
  };
  return renderComponent(
    'entityform',
    'Gadget',
    { user: { id: 'u', contactId: 'u' }, request: { params } },
    { portal, store: gadgetStore, schemas, nativePostbackState: postback, ...(solution ? { metadata: solution } : {}) },
  );
}

test('an inline web resource fails the form at its cell with the actions inside the cell', async () => {
  const html = await gadget({
    mode: 100000001,
    params: { id: 'g1' },
    metadata: { adx_renderwebresourcesinline: true },
    cells: [
      section('main', [
        [{ name: 'name' }],
        [{ type: 'webresource', id: 'WebResource_logo', url: 'logo.svg', label: 'Logo' }],
        [{ name: 'code' }],
      ]),
    ],
  });
  assert.match(html, /id="name" class="text form-control "/);
  assert.match(
    html,
    new RegExp(
      `<td colspan="1" rowspan="1" class="clearfix cell web-resource-cell"><div class="table-info">${ALERT('Unable to find control with id &#39;WebResource_logo&#39; that is associated with the Label &#39;&#39;.')}<div class="actions"><input type="button" name="[^"]*\\$UpdateButton"[^>]*></div> </td></tr></tbody></table></fieldset></div></div></div></div></div></div></div><script`,
    ),
  );
  assert.ok(html.endsWith(RENDER_ABORT_MARKER));
  // The WebForms wrapper keeps only the closing tags that directly follow the control and writes
  // them after the form's closing fields, then ends the form.
  const page = webFormsForm({ content: `<div class="copy">${html}</div>\n</div><p>Not rendered</p>` });
  assert.equal(page.includes('<p>Not rendered</p>'), false);
  assert.match(page, /<div class="aspNetHidden">[^]*?<\/div><\/div>\n<\/div><\/form>$/);
  assert.equal(html.includes('id="code"'), false);
  assert.equal(html.includes('frm_pref_'), false);
});

test('auto-generated steps render one tab per page with the Next submit button inside the view and the state in the view state', async () => {
  const cells = [
    section('general', [[{ name: 'name' }]]),
    section('related', [
      [
        {
          type: 'quickform',
          id: 'quickview_holder',
          lookup: 'holderid',
          entity: 'holder',
          schema: { formName: 'Holder quick view', fields: [{ name: 'name' }] },
        },
      ],
    ]),
    section('last', [[{ name: 'code' }]]),
  ];
  const metadata = {
    adx_autogeneratesteps: true,
    adx_nextbuttontext: 'Next tab',
    adx_nextbuttoncssclass: 'btn btn-primary tab-next',
    adx_previousbuttontext: 'Back',
  };
  const ids = nativeFormControlIds('entityform', FORM);
  const first = await gadget({ metadata, cells });
  assert.deepEqual(
    [...first.matchAll(/tab-title">([^<]*)</g)].map((m) => m[1]),
    ['general'],
  );
  assert.match(
    first,
    new RegExp(
      `</div></div></div><input type="submit" name="${esc(ids.names)}NextButton" value="Next tab" onclick="javascript:WebForm_DoPostBackWithOptions\\(new WebForm_PostBackOptions\\(&quot;[^&]*\\$NextButton&quot;, &quot;&quot;, true, &quot;&quot;, &quot;&quot;, false, false\\)\\)" id="NextButton" class="btn btn-primary tab-next form-action-container-left"></div><div class="actions"></div></div>`,
    ),
  );
  assert.equal(first.includes('PreviousButton'), false);
  assert.equal(first.includes('InsertButton'), false);
  assert.equal(first.includes('frm_pref_'), false);
  assert.equal(first.includes('onkeypress="javascript:return WebForm_FireDefaultButton'), false);
  const state = decodeNativeViewState(/data-pp-viewstate="([^"]*)"/.exec(first)[1]);
  assert.deepEqual(state, { form: FORM, autoStep: 0, values: {} });
  // The second tab (a postback): its quick view has no record yet, so the platform fails the form there.
  const second = await gadget({
    metadata,
    cells,
    postback: {
      kind: 'entityform',
      formId: FORM,
      autoStep: 1,
      values: { name: 'Typed on tab one' },
      outcome: { type: 'none' },
    },
  });
  assert.deepEqual(
    [...second.matchAll(/tab-title">([^<]*)</g)].map((m) => m[1]),
    ['related'],
  );
  assert.match(
    second,
    new RegExp(
      `<td colspan="1" rowspan="1" class="clearfix cell crmquickform-cell"><div class="table-info">${ALERT('Unable to find control with id &#39;quickview_holder&#39; that is associated with the Label &#39;&#39;.')}<div class="actions"></div> </td></tr></tbody></table></fieldset></div></div></div></div></div></div></div><script`,
    ),
  );
  assert.equal(second.includes('NextButton'), false);
  assert.deepEqual(decodeNativeViewState(/data-pp-viewstate="([^"]*)"/.exec(second)[1]), {
    form: FORM,
    autoStep: 1,
    values: { name: 'Typed on tab one' },
  });
  // The last tab: Previous inside the view, the Insert button in the actions, the carried values on the record.
  const last = await gadget({
    metadata,
    cells: [cells[0], cells[2]],
    postback: {
      kind: 'entityform',
      formId: FORM,
      autoStep: 1,
      values: { name: 'Typed on tab one' },
      outcome: { type: 'none' },
    },
  });
  assert.deepEqual(
    [...last.matchAll(/tab-title">([^<]*)</g)].map((m) => m[1]),
    ['last'],
  );
  assert.match(
    last,
    /<input type="submit" name="[^"]*\$PreviousButton" value="Back" onclick="[^"]*false, &quot;&quot;, &quot;&quot;, false, false\)\)" id="PreviousButton" class="btn btn-default form-action-container-left"><\/div><div class="actions"><input type="button" name="[^"]*\$InsertButton"/,
  );
  assert.match(last, /onkeypress="javascript:return WebForm_FireDefaultButton\(event, 'InsertButton'\)"/);
});

test('the view state payload accepts only its own shape and string values', () => {
  assert.equal(decodeNativeViewState('/wEabc'), null);
  assert.equal(decodeNativeViewState(Buffer.from('{"v":1}').toString('base64')), null);
  const forged =
    '/wE' +
    Buffer.from(
      JSON.stringify({
        v: 1,
        form: 'f',
        autoStep: -2,
        values: { ok: 'x', __proto__: 'y', 'bad name': 'z', nested: { a: 1 } },
      }),
    ).toString('base64');
  assert.deepEqual(decodeNativeViewState(forged), { form: 'f', autoStep: 0, values: { ok: 'x' } });
});

// Not observed natively, so a guess: inline rendering embeds an HTML web resource's body
// content in the cell; any other type fails the form (the SVG test above).
test('an inline HTML web resource embeds its body content and does not fail the form', async (t) => {
  const os = await import('node:os');
  const path = await import('node:path');
  const root = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'mirage-webresource-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'WebResources'));
  fs.writeFileSync(
    path.join(root, 'WebResources', 'banner.html'),
    '<!DOCTYPE html><html><head><title>B</title></head><body><h2 class="banner">Banner</h2></body></html>',
  );
  const html = await gadget({
    mode: 100000001,
    params: { id: 'g1' },
    metadata: { adx_renderwebresourcesinline: true },
    solution: { roots: [root], entities: {} },
    cells: [
      section('main', [
        [{ name: 'name' }],
        [{ type: 'webresource', id: 'WebResource_banner', url: 'banner.html', label: 'Banner' }],
        [{ name: 'code' }],
      ]),
    ],
  });
  assert.match(
    html,
    /<label for="WebResource_banner" class="field-label">Banner<\/label><\/div><div class="control"><literal id="WebResource_banner"><h2 class="banner">Banner<\/h2><\/literal><\/div>/,
  );
  assert.match(html, /id="code"/);
  assert.equal(html.endsWith(RENDER_ABORT_MARKER), false);
});
