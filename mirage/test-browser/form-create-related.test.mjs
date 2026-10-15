import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';

// Invented schema: a record form with a Create related record action whose target form opens
// in a modal, and the record state hiding the inapplicable state action.
test('create related record opens the target form dialog; the record state hides its state action', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-create-related-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const actions = [
    { Type: 'DeactivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Close entry' }] },
    { Type: 'ActivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Reopen entry' }] },
    { Type: 'CreateRelatedRecordAction', ButtonLabel: [{ LCID: 1033, Value: 'Add note' }], ButtonTooltip: [{ LCID: 1033, Value: 'Add a related note' }], EntityFormId: 'note-form', ShowModal: 1, TargetType: 0 },
  ];
  const files = {
    'website.yml': 'adx_websiteid: 11111111-2222-4333-8444-555555555555\nadx_name: Related fixture',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Entry" %}',
    'Entry.basicform.yml': `adx_entityformid: entry-form\nadx_name: Entry\nadx_entityname: sample\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: row\nadx_settings: ${JSON.stringify(JSON.stringify({ Actions: actions }))}`,
    'Note.basicform.yml': 'adx_entityformid: note-form\nadx_name: Note\nadx_entityname: sample\nadx_mode: 100000000',
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const id = '00000000-0000-4000-8000-000000000001';
  const fields = [{ name: 'title', label: 'Title', type: 'text' }];
  const app = await createSimulator({ sourceDir: root, watch: false, initial: {
    mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid', nameColumn: 'title', fieldMetadata: {
      title: { dataverseType: 'nvarchar' },
      statecode: { dataverseType: 'state', states: [{ value: 0, defaultStatus: 100 }, { value: 1, defaultStatus: 300 }] },
      statuscode: { dataverseType: 'status', statuses: [{ value: 100, state: 0 }, { value: 300, state: 1 }] },
    } } },
    tables: { sample: [{ sampleid: id, title: 'Original', statecode: 0, statuscode: 100 }] },
    permissions: [{ entity: 'sample', scope: 'global', roles: ['Editor'], operations: ['read', 'update', 'create'] }],
    settings: { permissionMode: 'enforce', 'Webapi/sample/enabled': false, 'Site/BootstrapV5Enabled': 'true' },
    simulator: { componentSchemas: { 'entry-form': { entity: 'sample', fields }, 'note-form': { entity: 'sample', fields } }, endpoints: [], mode: 'local', pageMode: 'local', live: { origin: null } },
  } });
  t.after(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage();
  const response = await page.goto(`${app.url}/?row=${id}`);
  const html = await response.text();
  // Server markup: both state buttons, no hidden marker; the form dialog with an empty frame.
  assert.match(html, /<button class="activate-link btn btn-default btn" data-url="[^"]*" href="[^"]*" type="button">Reopen entry<\/button>/);
  assert.match(html, /class="modal fade modal-form modal-form-createrecord" data-(?:bs-)?backdrop="static" data-filtercriteriaid="[0-9a-f-]{36}" role="dialog" tabindex="-1"><div class="modal-lg modal-dialog">/);
  assert.match(html, /CreateRelatedRecordActionLink&quot;:\{&quot;Modal&quot;:\{\},&quot;EntityForm&quot;:\{&quot;Id&quot;:&quot;note-form&quot;,&quot;LogicalName&quot;:&quot;adx_entityform&quot;,&quot;KeyAttributes&quot;:\[\]\},&quot;Target&quot;:0,&quot;Type&quot;:29,&quot;Label&quot;:&quot;Add note&quot;,&quot;Tooltip&quot;:&quot;Add a related note&quot;,&quot;Enabled&quot;:true/);
  // The app bundle hides the state action the active record rules out.
  assert.equal(await page.locator('button.activate-link.hidden').count(), 1);
  assert.equal(await page.locator('button.activate-link').getAttribute('style'), 'display: none;');
  assert.equal(await page.locator('button.deactivate-link.hidden').count(), 0);
  // The action opens the dialog on the target form with the record and the page language.
  await page.locator('button.create-related-record-link').click();
  const modal = page.locator('section.modal-form-createrecord');
  await modal.waitFor({ state: 'visible' });
  const src = await modal.locator('iframe').getAttribute('src');
  assert.equal(src, `/_portal/modal-form-template-path/11111111-2222-4333-8444-555555555555?id=${id}&entityformid=note-form&languagecode=1033`);
  assert.equal(await modal.getAttribute('aria-label'), ' Create related record');
});
