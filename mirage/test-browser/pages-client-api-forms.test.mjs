// @test-kind unproven: broad form, value, validator, file and hosted-component models; finite native control guarantees with their sources are checked separately.
// $pages forms, tabs, sections and controls over a rendered native basic form, and the file-column methods over the
// portal Web API.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { signedInSimulatorPage } from './shared-browser.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const SITE = '77777777-7777-4777-8777-777777777701';
const ROW = '77777777-7777-4777-8777-777777777702';
const FORM = '77777777-7777-4777-8777-777777777703';
const CONTACT = '77777777-7777-4777-8777-777777777704';

test('$pages forms bind to the rendered basic form: tabs, sections, values, visibility, required state and validators', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pages-forms-browser-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Example`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: form',
    'FormPage.pagetemplate.yml': 'adx_pagetemplateid: form\nadx_webtemplateid: formcontent',
    'FormContent.webtemplate.yml': 'adx_webtemplateid: formcontent\nadx_name: Form content',
    'FormContent.webtemplate.source.html': '{% entityform name: "Item" %}',
    'Item.basicform.yml': `adx_entityformid: ${FORM}\nadx_name: Item\nadx_entityname: x_item\nadx_mode: 100000001\nadx_recordsourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_onsuccess: 756150000\nadx_successmessage: Saved.`,
    'sitesetting.yml': [
      ['Webapi/x_item/enabled', 'true'],
      ['Webapi/x_item/fields', 'x_name,x_doc'],
    ]
      .map(
        ([name, value], index) =>
          `- adx_sitesettingid: 77777777-7777-4777-8777-77777777779${index}\n  adx_name: ${name}\n  adx_value: "${value}"`,
      )
      .join('\n'),
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const cell = (name) => [{ name }];
  const initial = {
    version: 1,
    mappings: {
      x_item: {
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_doc: { dataverseType: 'file', MaxSizeInKB: 64 } },
      },
      contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    },
    tables: {
      x_item: [{ x_itemid: ROW, x_name: 'One', x_note: 'n', x_flag: false, x_kind: 1 }],
      contact: [{ contactid: CONTACT, fullname: 'Invented Visitor' }],
    },
    permissions: [
      { id: 'items', entity: 'x_item', scope: 'global', roles: ['Member'], operations: ['read', 'update'] },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      live: { origin: null },
      endpoints: [],
      componentSchemas: {
        Item: {
          entity: 'x_item',
          mode: 100000001,
          fields: [
            { name: 'x_name', label: 'Name', maxLength: 20 },
            { name: 'x_count', label: 'Count', dataverseType: 'integer' },
            {
              name: 'x_kind',
              label: 'Kind',
              dataverseType: 'picklist',
              options: [
                { value: 1, label: 'A' },
                { value: 2, label: 'B' },
              ],
            },
            { name: 'x_note', label: 'Note', dataverseType: 'memo' },
            { name: 'x_flag', label: 'Flag', dataverseType: 'boolean' },
          ],
          layout: [
            {
              name: 'general',
              label: 'General',
              showLabel: true,
              columns: [
                {
                  sections: [
                    {
                      name: 'main',
                      label: 'Main',
                      showLabel: true,
                      rows: [cell('x_name'), cell('x_count'), cell('x_kind')],
                    },
                  ],
                },
              ],
            },
            {
              name: 'more',
              label: 'More',
              showLabel: true,
              columns: [
                {
                  sections: [
                    { name: 'extra', label: 'Extra', showLabel: true, rows: [cell('x_note'), cell('x_flag')] },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  };
  const { app, page, errors } = await signedInSimulatorPage(t, browser, { dir, initial, contact: CONTACT });
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(`${app.url}/?id=${ROW}`);

  const read = await page.evaluate(async () => {
    const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
    const forms = $pages.currentPage.forms.getAll();
    const form = $pages.currentPage.forms.getFormByName('Item');
    const name = form.getControlByLogicalName('x_name');
    name.setValue('Changed');
    let tooLong = null;
    try {
      name.setValue('x'.repeat(21));
    } catch (error) {
      tooLong = error.message;
    }
    const kind = form.getControlByLogicalName('x_kind');
    kind.setValue('2');
    const flag = form.getControlByLogicalName('x_flag');
    flag.setValue(true);
    const note = form.getControlByLogicalName('x_note');
    note.setVisible(false);
    form.tabs[1].setVisible(true);
    return {
      count: forms.length,
      sameById: $pages.currentPage.forms.getFormById(form.id)?.name,
      id: form.id,
      multi: form.isMultiStep,
      visible: form.getVisible(),
      controls: form.controls.map((control) => [control.getLogicalName(), control.getType()]),
      tabs: form.tabs.map((tab) => [
        tab.getName(),
        tab.sections.map((section) => [section.getName(), section.controls.map((control) => control.getName())]),
      ]),
      values: [
        name.getValue(),
        document.getElementById('x_name').value,
        kind.getValue(),
        kind.subType,
        flag.getValue(),
        document.getElementById('x_flag').checked,
      ],
      tooLong,
      noteVisible: [note.getVisible(), getComputedStyle(document.getElementById('x_note').closest('td')).display],
      missing: form.getControlByLogicalName('x_unknown'),
    };
  });
  assert.equal(read.count, 1);
  assert.equal(read.sameById, 'Item');
  assert.match(read.id, /^77777777777747778777777777777703$/);
  assert.deepEqual([read.multi, read.visible], [false, true]);
  assert.deepEqual(read.controls, [
    ['x_name', 'String'],
    ['x_count', 'Integer'],
    ['x_kind', 'Picklist'],
    ['x_note', 'Memo'],
    ['x_flag', 'MultipleChoice'],
  ]);
  assert.deepEqual(read.tabs, [
    // Evidence: repeated2026-11-08 native diagnostics and Microsoft getName method source establish rendered labels rather than logical names; all26 source-label relations replay exactly.
    ['general', [['main', ['Name', 'Count', 'Kind']]]],
    ['more', [['extra', ['Note', 'Flag']]]],
  ]);
  assert.deepEqual(read.values, ['Changed', 'Changed', '2', 'Dropdown', true, true]);
  assert.match(read.tooLong, /maximum length 20/);
  assert.deepEqual(read.noteVisible, [false, 'none']);
  assert.equal(read.missing, undefined);

  // setRequired and addValidator register submit-time validators that block the postback and fill the summary.
  const blocked = await page.evaluate(async () => {
    const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
    const form = $pages.currentPage.forms.getFormByName('Item');
    const count = form.getControlByLogicalName('x_count');
    count.setRequired(true, 'Count is needed.');
    // A fresh lookup per call: validators belong to the rendered control, not to one lookup.
    form.getControlByLogicalName('x_name').addValidator('upper', () => true, 'Replaced by the next addition.');
    form
      .getControlByLogicalName('x_name')
      .addValidator('upper', (value) => value === value.toUpperCase(), 'Name must be upper case.');
    const valid = window.Page_ClientValidate('');
    return { valid, required: count.getRequired(), summary: document.querySelector('.validation-summary').textContent };
  });
  assert.equal(blocked.valid, false);
  assert.equal(blocked.required, true);
  assert.match(blocked.summary, /Count is needed\./);
  assert.match(blocked.summary, /Name must be upper case\./);
  const cleared = await page.evaluate(async () => {
    const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
    const form = $pages.currentPage.forms.getFormByName('Item');
    form.getControlByLogicalName('x_name').removeValidator('upper');
    if (window.Page_Validators.some((span) => /upper case|Replaced/.test(span.errormessage)))
      return 'validator left behind';
    form.getControlByLogicalName('x_count').setValue('7');
    return window.Page_ClientValidate('');
  });
  assert.equal(cleared, true);
  await Promise.all([page.waitForEvent('load'), page.locator('#UpdateButton').click()]);
  const row = app.store.state.tables.x_item.find((item) => item.x_itemid === ROW);
  assert.deepEqual([row.x_name, row.x_count, row.x_kind, row.x_flag], ['Changed', 7, 2, true]);

  // A record that does not exist renders the form's wrapper with its message only: the platform client API (host chunk
  // forms.getAll over EntityFormControl_<32 hex> wrappers) still lists it, without controls.
  await page.goto(`${app.url}/?id=77777777-7777-4777-8777-777777777799`);
  const missing = await page.evaluate(async () => {
    const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
    const forms = $pages.currentPage.forms.getAll();
    return {
      message: Boolean(document.querySelector('[id^="EntityFormControl_"] #MessagePanel')),
      forms: forms.map((form) => [form.id, form.controls.length, form.tabs.length, form.name === undefined]),
    };
  });
  assert.equal(missing.message, true);
  assert.equal(missing.forms.length, 1);
  assert.match(missing.forms[0][0], /^77777777777747778777777777777703$/);
  assert.deepEqual(missing.forms[0].slice(1), [0, 0, true]);
  await page.goto(`${app.url}/?id=${ROW}`);

  // File columns through the portal Web API.
  const file = await page.evaluate(async (id) => {
    const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
    await $pages.webAPI.uploadFileToColumn(
      'x_items',
      id,
      'x_doc',
      new File(['file body'], 'notes.txt', { type: 'text/plain' }),
    );
    const blob = await $pages.webAPI.downloadFileFromColumn('x_items', id, 'x_doc');
    return [await blob.text(), blob.type];
  }, ROW);
  assert.deepEqual(file, ['file body', 'text/plain']);
  assert.deepEqual(errors, []);
});

// Full name, rich text and code component cells rendered by platform.mjs (renderComponent: the read-only full name
// composite beside the form's first, middle and last name cells, the rich text hidden value beside its editor, a code
// component over its native input), with the portal client object runtime, the client API script and a real code
// component mounted by the PCF host (code-components-client.js) that observes the change.
async function renderedContactForm() {
  const { renderComponent } = await import('../lib/platform.mjs');
  const fields = [
    { name: 'fullname', label: 'Full name', dataverseType: 'nvarchar', validForCreate: false, validForUpdate: false },
    { name: 'firstname', label: 'First name', dataverseType: 'nvarchar' },
    { name: 'middlename', label: 'Middle name', dataverseType: 'nvarchar' },
    { name: 'lastname', label: 'Last name', dataverseType: 'nvarchar' },
    {
      name: 'x_body',
      label: 'Body',
      dataverseType: 'memo',
      richText: { name: 'MscrmControls.RichTextEditor.RichTextEditorControl' },
    },
    {
      name: 'x_code',
      label: 'Code',
      dataverseType: 'nvarchar',
      codeComponent: {
        name: 'x_Invented.Echo',
        boundAttributes: ['x_code'],
        parameters: { value: { kind: 'binding', column: 'x_code', type: 'SingleLine.Text' } },
      },
    },
  ];
  const specs = [];
  const html = await renderComponent(
    'entityform',
    'Contact',
    {},
    {
      portal: {
        forms: [{ id: 'contact', name: 'Contact', mode: 100000000, metadata: { adx_entityname: 'contact' } }],
        pages: [],
        website: { id: SITE },
        records: [
          {
            kind: 'basicformmetadata',
            adx_entityform: 'contact',
            adx_attributelogicalname: 'x_code',
            adx_type: 100000000,
            adx_controlstyle: 756150001,
          },
        ],
      },
      schemas: {
        Contact: {
          entity: 'contact',
          mode: 100000000,
          fields,
          layout: [
            {
              name: 'general',
              label: 'General',
              columns: [
                { sections: [{ name: 'main', label: 'Main', rows: fields.map((field) => [{ name: field.name }]) }] },
              ],
            },
          ],
        },
      },
      store: { resolveMapping: () => ({ entitySet: 'contacts', idColumn: 'contactid' }), query: () => ({ value: [] }) },
      codeComponent: async (spec) => {
        specs.push(spec);
        // As renderCodeComponent: the mounted binding, then the host script and the mount element.
        spec.onNativeBinding?.({ properties: ['value'] }, {});
        return '<script src="/__sim-static/pcf-host.js"></script><div data-invented-pcf-host></div>';
      },
    },
  );
  assert.equal(specs.length, 1, 'the code component cell is rendered by platform.mjs');
  return { html, spec: specs[0] };
}

// @test-kind observation: the code component field is the live generic control (getValue and setValue throw "Method not implemented.", visible, not disabled, setDisabled changes nothing the component sees), paqvilo-developer pcf-parity capture f1|f2 pages-api and pages-api2; the full name and rich text assertions keep the local model of this file
test('$pages full name, rich text and code component controls read and write their values over platform.mjs output', async (t) => {
  const { html, spec } = await renderedContactForm();
  const { clientPortalObjectRuntime } = await import('../lib/portal-client-object.mjs');
  const page = await browser.newPage();
  ownedFixture(t).add(() => page.context().close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // setIsDirty is the native form script the rendered inputs call on change.
  await page.setContent(html);
  await page.evaluate(() => {
    document.documentElement.lang = 'en-US';
    window.setIsDirty = () => {};
    const form = document.createElement('form');
    form.append(...document.body.childNodes);
    document.body.append(form);
  });
  await page.addScriptTag({
    content: await fs.readFile(new URL('../lib/code-components-client.js', import.meta.url), 'utf8'),
  });
  // A real code component: it shows its bound value and records every updateView the host makes.
  await page.evaluate(
    async (spec) => {
      window.observed = [];
      window.ComponentFramework.registerControl(
        'Invented.Echo',
        class {
          init(context, notify, state, container) {
            this.box = document.createElement('output');
            this.box.id = 'echo';
            // An opaque PCF marker inside a component is not the typed input for the form binding.
            this.box.setAttribute('pcf-controlcontext', '{}');
            container.append(this.box);
            this.box.textContent = context.parameters.value.raw ?? '';
          }
          updateView(context) {
            this.box.textContent = context.parameters.value.raw ?? '';
            window.observed.push(context.parameters.value.raw ?? null);
          }
          getOutputs() {
            return {};
          }
          destroy() {}
        },
      );
      await window.__paqviloPcf.mount(
        {
          id: 'x_code',
          constructor: 'Invented.Echo',
          resources: [],
          properties: [{ name: 'value', 'of-type': 'SingleLine.Text', usage: 'bound' }],
          strings: {},
          args: spec.args,
          identity: { roles: [] },
          mappings: {},
          nativeBinding: spec.nativeBinding,
        },
        document.querySelector('[data-invented-pcf-host]'),
      );
    },
    { args: spec.args, nativeBinding: spec.nativeBinding },
  );
  await page.addScriptTag({ content: clientPortalObjectRuntime({}, { websiteId: SITE, language: 'en-US' }) });
  await page.addScriptTag({
    content: await fs.readFile(new URL('../lib/pages-client-api.js', import.meta.url), 'utf8'),
  });
  const result = await page.evaluate(async () => {
    const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
    const form = $pages.currentPage.forms.getFormByName('Contact');
    const changes = [];
    document.addEventListener('change', (event) => changes.push(event.target.id));
    const full = form.getControlByLogicalName('fullname');
    const before = full.getValue();
    full.setValue({ firstName: 'Grace', middleName: 'B', lastName: 'Hopper' });
    const body = form.getControlByLogicalName('x_body');
    const bodyBefore = body.getValue();
    body.setValue('<p>Changed</p>');
    const stored = document.getElementById('x_body').value;
    const editorText = document.getElementById('x_body_editor').value;
    // A mounted editor (CKEditor or the compatibility editor) answers through its instance.
    let editorData = '<p>From editor</p>';
    window.CKEDITOR = {
      instances: {
        x_body_editor: {
          getData: () => editorData,
          setData: (html) => {
            editorData = html;
          },
        },
      },
    };
    const fromEditor = body.getValue();
    body.setValue('<p>Into editor</p>');
    const code = form.getControlByLogicalName('x_code');
    const threw = (call) => {
      try {
        call();
        return null;
      } catch (error) {
        return error.message;
      }
    };
    const codeGet = threw(() => code.getValue());
    const codeSet = threw(() => code.setValue('After'));
    const codeDisable = code.setDisabled(true);
    let wrongType = null;
    try {
      full.setValue('Grace Hopper');
    } catch (error) {
      wrongType = error.message;
    }
    return {
      before,
      after: full.getValue(),
      composed: document.getElementById('fullname').value,
      parts: ['firstname', 'middlename', 'lastname'].map((id) => document.getElementById(id).value),
      bodyBefore,
      stored,
      editorText,
      fromEditor,
      editorData,
      bodyValue: body.getValue(),
      bodyType: body.getType(),
      code: [codeGet, codeSet, code.getType(), code.getVisible(), codeDisable, code.getDisabled()],
      codeHidden: document.getElementById('x_code').value,
      changes,
      wrongType,
    };
  });
  assert.deepEqual(result.before, { firstName: '', middleName: '', lastName: '' });
  assert.deepEqual(result.after, { firstName: 'Grace', middleName: 'B', lastName: 'Hopper' });
  // The rendered composite's content template is {fullnamefirstname} {fullnamelastname}.
  assert.equal(result.composed, 'Grace Hopper');
  assert.deepEqual(result.parts, ['Grace', 'B', 'Hopper']);
  assert.equal(result.bodyBefore, '');
  assert.equal(result.stored, JSON.stringify('<p>Changed</p>'));
  assert.deepEqual(
    [result.editorText, result.fromEditor, result.editorData, result.bodyValue],
    ['<p>Changed</p>', '<p>From editor</p>', '<p>Into editor</p>', '<p>Into editor</p>'],
  );
  assert.equal(result.bodyType, undefined);
  assert.deepEqual(result.code, [
    'Method not implemented.',
    'Method not implemented.',
    undefined,
    true,
    undefined,
    false,
  ]);
  assert.equal(result.codeHidden, '');
  // Each written box raises change, so the native form posts the parts and the mounted code component sees the value.
  for (const id of ['firstname', 'middlename', 'lastname', 'fullname', 'x_body'])
    assert.ok(result.changes.includes(id), id);
  // setValue and setDisabled reached the component with no updateView after its mount.
  assert.deepEqual(await page.evaluate(() => window.observed), ['']);
  assert.equal(await page.evaluate(() => window.__paqviloPcf.inspect()[0].parameters.value.raw), '');
  assert.match(result.wrongType, /needs an object/);
  assert.deepEqual(errors, []);
});

// @test-kind observation: live portal read 2026-11-18 (single capture, signed-in Edge, read-only page evaluation of $pages.currentPage.forms on a basic form page and on the same page with an unknown record id): getAll lists the EntityFormControl_<32 hex> wrapper with id = the 32 hex digits, getFormById finds it by that id and not by the element ID, and a wrapper showing only the not-found message is listed with name undefined and no controls
test('$pages form ids are the wrapper suffix; message-only wrappers are forms, modal wrappers are not', async (t) => {
  const page = await browser.newPage();
  ownedFixture(t).add(() => page.close());
  const ID = '0123456789abcdef0123456789abcdef';
  const STEP = 'fedcba9876543210fedcba9876543210';
  await page.setContent(
    `<div id="EntityFormControl_${ID}"><div id="EntityFormPanel" class="crmEntityFormView" data-form-name="Item">` +
      `<div id="EntityFormControl_${ID}_EntityFormView"><div class="control" data-logical-name="x_name"><input id="x_name" type="text" class="text"></div></div></div></div>` +
      '<div id="EntityFormControl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"><div id="MessagePanel">Not found.</div></div>' +
      '<div id="EntityFormControl"><div id="EntityFormPanel" class="crmEntityFormView" data-form-name="Modal"></div></div>' +
      `<div id="WebFormControl_${STEP}"><div id="WebFormPanel" class="crmEntityFormView" data-form-name="Steps"></div></div>`,
  );
  await page.addScriptTag({ path: fileURLToPath(new URL('../lib/pages-client-api.js', import.meta.url)) });
  const read = await page.evaluate(
    ([id]) => {
      const forms = globalThis.__paqviloPages.currentPage.forms;
      return {
        all: forms.getAll().map((form) => [form.id, form.name ?? 'undefined', form.controls.length, form.isMultiStep]),
        byId: forms.getFormById(id)?.name,
        byElementId: forms.getFormById(`EntityFormControl_${id}`) ?? 'undefined',
      };
    },
    [ID],
  );
  assert.deepEqual(read.all, [
    [ID, 'Item', 1, false],
    ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'undefined', 0, false],
    [STEP, 'Steps', 0, true],
  ]);
  assert.equal(read.byId, 'Item');
  assert.equal(read.byElementId, 'undefined');
});

// @test-kind observation: saved platform host bundle content.powerapps.com/resource/powerappsportal/controls/host/296.cf0de209ae.chunk.js (paqvilo-developer replica, batch-1/building-permit/originals): hasNextStep/hasPreviousStep are the input#NextButton/#PreviousButton being present and :visible, and goToNextStep/goToPreviousStep throw "No next|previous step available in the multi-step form." otherwise
test('$pages multistep steps follow the visible Next and Previous buttons and throw the platform error without one', async (t) => {
  const page = await browser.newPage();
  ownedFixture(t).add(() => page.close());
  await page.setContent(
    '<div id="WebFormControl_fedcba9876543210fedcba9876543210"><div id="WebFormPanel" class="crmEntityFormView" data-form-name="Steps"></div>' +
      '<input type="button" id="NextButton" value="Submit" style="display:none" onclick="window.clicked = this.value"></div>',
  );
  await page.addScriptTag({ path: fileURLToPath(new URL('../lib/pages-client-api.js', import.meta.url)) });
  const read = await page.evaluate(() => {
    const form = globalThis.__paqviloPages.currentPage.forms.getAll()[0];
    const attempt = (go) => {
      try {
        go();
        return 'no error';
      } catch (error) {
        return error.message;
      }
    };
    const hidden = { next: form.hasNextStep(), goNext: attempt(() => form.goToNextStep()) };
    document.querySelector('#NextButton').style.display = '';
    return {
      hidden,
      shown: { next: form.hasNextStep(), goNext: attempt(() => form.goToNextStep()), clicked: globalThis.clicked },
      previous: { has: form.hasPreviousStep(), go: attempt(() => form.goToPreviousStep()) },
    };
  });
  assert.deepEqual(read, {
    hidden: { next: false, goNext: 'No next step available in the multi-step form.' },
    shown: { next: true, goNext: 'no error', clicked: 'Submit' },
    previous: { has: false, go: 'No previous step available in the multi-step form.' },
  });
});
