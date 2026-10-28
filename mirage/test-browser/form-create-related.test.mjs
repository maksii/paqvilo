import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { parse } from 'parse5';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// A record form with a Create related record action whose target form opens
// in a modal, and the record state hiding the inapplicable state action.
test('create related record opens the target form dialog; the record state hides its state action', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'native-create-related-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const actions = [
    { Type: 'DeactivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Close entry' }] },
    { Type: 'ActivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Reopen entry' }] },
    {
      Type: 'CreateRelatedRecordAction',
      ButtonLabel: [{ LCID: 1033, Value: 'Add note' }],
      ButtonTooltip: [{ LCID: 1033, Value: 'Add a related note' }],
      EntityFormId: 'note-form',
      ShowModal: 1,
      TargetType: 0,
    },
  ];
  const files = {
    'website.yml': 'adx_websiteid: 11111111-2222-4333-8444-555555555555\nadx_name: Related fixture',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Entry" %}',
    'Entry.basicform.yml': `adx_entityformid: entry-form\nadx_name: Entry\nadx_entityname: sample\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: row\nadx_settings: ${JSON.stringify(JSON.stringify({ Actions: actions }))}`,
    'Note.basicform.yml': 'adx_entityformid: note-form\nadx_name: Note\nadx_entityname: sample\nadx_mode: 100000000',
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const id = '00000000-0000-4000-8000-000000000001';
  const fields = [{ name: 'title', label: 'Title', type: 'text' }];
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    initial: {
      mappings: {
        sample: {
          entitySet: 'samples',
          idColumn: 'sampleid',
          nameColumn: 'title',
          fieldMetadata: {
            title: { dataverseType: 'nvarchar' },
            statecode: {
              dataverseType: 'state',
              states: [
                { value: 0, defaultStatus: 100 },
                { value: 1, defaultStatus: 300 },
              ],
            },
            statuscode: {
              dataverseType: 'status',
              statuses: [
                { value: 100, state: 0 },
                { value: 300, state: 1 },
              ],
            },
          },
        },
      },
      tables: { sample: [{ sampleid: id, title: 'Original', statecode: 0, statuscode: 100 }] },
      permissions: [{ entity: 'sample', scope: 'global', roles: ['Editor'], operations: ['read', 'update', 'create'] }],
      settings: { permissionMode: 'enforce', 'Webapi/sample/enabled': false, 'Site/BootstrapV5Enabled': 'true' },
      simulator: {
        componentSchemas: { 'entry-form': { entity: 'sample', fields }, 'note-form': { entity: 'sample', fields } },
        endpoints: [],
        mode: 'local',
        pageMode: 'local',
        live: { origin: null },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage();
  const response = await page.goto(`${app.url}/?row=${id}`);
  const html = await response.text();
  // Server markup: both state buttons, no hidden marker; the form dialog with an empty frame.
  const descendants = (root) => {
    const nodes = [],
      pending = [root];
    while (pending.length) {
      const node = pending.pop();
      if (node.tagName) nodes.push(node);
      pending.push(...(node.childNodes ?? []));
    }
    return nodes;
  };
  const nodes = descendants(parse(html)),
    attribute = (node, name) => node.attrs.find((attr) => attr.name === name)?.value;
  const hasClass = (node, name) => (attribute(node, 'class') ?? '').split(/\s+/).includes(name);
  const activate = nodes.filter((node) => node.tagName === 'button' && hasClass(node, 'activate-link'));
  const deactivate = nodes.filter((node) => node.tagName === 'button' && hasClass(node, 'deactivate-link'));
  assert.equal(activate.length, 1);
  assert.equal(deactivate.length, 1);
  assert.equal(attribute(activate[0], 'class'), 'activate-link btn btn-default btn');
  assert.equal(attribute(activate[0], 'type'), 'button');
  assert.equal(typeof attribute(activate[0], 'data-url'), 'string');
  assert.equal(typeof attribute(activate[0], 'href'), 'string');
  assert.equal(activate[0].childNodes.map((node) => node.value ?? '').join(''), 'Reopen entry');
  for (const button of [...activate, ...deactivate]) {
    assert.equal(hasClass(button, 'hidden'), false);
    assert.equal(attribute(button, 'style'), undefined);
  }
  const dialogs = nodes.filter((node) => node.tagName === 'section' && hasClass(node, 'modal-form-createrecord'));
  assert.equal(dialogs.length, 1);
  const dialog = dialogs[0];
  assert.equal(attribute(dialog, 'class'), 'modal fade modal-form modal-form-createrecord');
  assert.equal(attribute(dialog, 'data-bs-backdrop') ?? attribute(dialog, 'data-backdrop'), 'static');
  assert.match(attribute(dialog, 'data-filtercriteriaid'), /^[0-9a-f-]{36}$/i);
  assert.equal(attribute(dialog, 'role'), 'dialog');
  assert.equal(attribute(dialog, 'tabindex'), '-1');
  assert.equal(
    attribute(
      dialog.childNodes.find((node) => node.tagName),
      'class',
    ),
    'modal-lg modal-dialog',
  );
  const initialFrame = descendants(dialog).find((node) => node.tagName === 'iframe');
  assert.equal(attribute(initialFrame, 'src'), 'about:blank');
  const layout = JSON.parse(
    attribute(
      nodes.find((node) => attribute(node, 'data-form-layout')),
      'data-form-layout',
    ),
  );
  const action = layout.CreateRelatedRecordActionLink;
  assert.deepEqual(
    {
      Modal: action.Modal,
      EntityForm: action.EntityForm,
      Target: action.Target,
      Type: action.Type,
      Label: action.Label,
      Tooltip: action.Tooltip,
      Enabled: action.Enabled,
    },
    {
      Modal: {},
      EntityForm: { Id: 'note-form', LogicalName: 'adx_entityform', KeyAttributes: [] },
      Target: 0,
      Type: 29,
      Label: 'Add note',
      Tooltip: 'Add a related note',
      Enabled: true,
    },
  );
  // The app bundle hides the state action the active record rules out.
  assert.equal(await page.locator('button.activate-link.hidden').count(), 1);
  assert.equal(await page.locator('button.activate-link').getAttribute('style'), 'display: none;');
  assert.equal(await page.locator('button.deactivate-link.hidden').count(), 0);
  // The action opens the dialog on the target form with the record and the page language.
  await page.locator('button.create-related-record-link').click();
  const modal = page.locator('section.modal-form-createrecord');
  await modal.waitFor({ state: 'visible' });
  const src = await modal.locator('iframe').getAttribute('src');
  assert.equal(
    src,
    `/_portal/modal-form-template-path/11111111-2222-4333-8444-555555555555?id=${id}&entityformid=note-form&languagecode=1033`,
  );
  assert.equal(await modal.getAttribute('aria-label'), ' Create related record');
  // The click sets the frame source and shows the dialog in one step; the frame commits its document later.
  const child = await (await modal.locator('iframe').elementHandle()).contentFrame();
  await child.waitForURL(app.url + src);
  await child.locator('#title').waitFor();
  const target = await child.locator('script[data-paqvilo-mirage-form-config]').evaluate((node) => {
    const config = JSON.parse(node.textContent);
    return { kind: config.kind, formId: config.formId, operation: config.operation };
  });
  assert.deepEqual(
    target,
    { kind: 'entityform', formId: 'note-form', operation: 'create' },
    'the dialog renders the target insert form instead of inheriting the parent edit form',
  );
  assert.equal(
    await child
      .locator('[data-form-layout]')
      .evaluate((node) => JSON.parse(node.getAttribute('data-form-layout')).EntityName),
    'sample',
  );
});
