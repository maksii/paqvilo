// Browser flows over the default WebForms postback: state actions, the attach-file control's
// multipart post, rich text and auto-generated steps (invented loopback fixture, "sample" table).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';

const ID = '00000000-0000-4000-8000-000000000001';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-postback-flows-'));
  const files = {
    'website.yml': 'adx_websiteid: flows-site\nadx_name: Invented postback flows',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Steps.webpage.yml': 'adx_webpageid: steps\nadx_name: Steps\nadx_partialurl: steps\nadx_parentpageid: home\nadx_pagetemplateid: steps-template',
    'Attach.webpage.yml': 'adx_webpageid: attach\nadx_name: Attach\nadx_partialurl: attach\nadx_parentpageid: home\nadx_pagetemplateid: attach-template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Steps.pagetemplate.yml': 'adx_pagetemplateid: steps-template\nadx_webtemplateid: steps-web\nadx_usewebsiteheaderandfooter: true',
    'Attach.pagetemplate.yml': 'adx_pagetemplateid: attach-template\nadx_webtemplateid: attach-web\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<!doctype html><html><body>{% entityform name: "Entry" %}</body></html>',
    'StepsWeb.webtemplate.yml': 'adx_webtemplateid: steps-web\nadx_name: Steps web',
    'StepsWeb.webtemplate.source.html': '<!doctype html><html><body>{% entityform name: "Stepped" %}</body></html>',
    'AttachWeb.webtemplate.yml': 'adx_webtemplateid: attach-web\nadx_name: Attach web',
    'AttachWeb.webtemplate.source.html': '<!doctype html><html><body>{% entityform name: "Attach" %}</body></html>',
    'Entry.basicform.yml': `adx_entityformid: entry\nadx_name: Entry\nadx_entityname: sample\nadx_mode: 100000001\nadx_recordidquerystringparametername: row\nadx_settings: ${JSON.stringify(JSON.stringify({ Actions: [{ Type: 'DeactivateAction', ButtonLabel: 'Close entry' }, { Type: 'ActivateAction', ButtonLabel: 'Reopen entry' }] }))}`,
    'Stepped.basicform.yml': 'adx_entityformid: stepped\nadx_name: Stepped\nadx_entityname: sample\nadx_mode: 100000000\nadx_autogeneratesteps: true\nadx_nextbuttontext: Next tab\nadx_successmessage: Saved all tabs\nadx_hideformonsuccess: false',
    'Attach.basicform.yml': 'adx_entityformid: attach\nadx_name: Attach\nadx_entityname: sample\nadx_mode: 100000000\nadx_attachfile: true\nadx_attachfilestoragelocation: 756150000\nadx_successmessage: Attached\nadx_hideformonsuccess: false',
  };
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const fields = [{ name: 'title', label: 'Title', type: 'text', required: true }, { name: 'description', label: 'Description', type: 'textarea' }];
  const tab = (name, field) => ({ name, label: name, showLabel: true, columns: [{ width: '100%', sections: [{ name, label: name, rows: [[{ name: field }]] }] }] });
  const app = await createSimulator({ sourceDir: root, watch: false, initial: {
    mappings: {
      sample: { entitySet: 'samples', idColumn: 'sampleid', nameColumn: 'title', fieldMetadata: {
        title: { dataverseType: 'nvarchar' }, description: { dataverseType: 'memo' },
        statecode: { dataverseType: 'state', states: [{ value: 0, defaultStatus: 1 }, { value: 1, defaultStatus: 2 }] },
        statuscode: { dataverseType: 'status', statuses: [{ value: 1, state: 0 }, { value: 2, state: 1 }] },
      } },
      annotation: { entitySet: 'annotations', idColumn: 'annotationid' },
    },
    tables: { sample: [{ sampleid: ID, title: 'Original', statecode: 0, statuscode: 1 }], annotation: [] },
    settings: { permissionMode: 'permissive' },
    simulator: { componentSchemas: { entry: { entity: 'sample', fields: [fields[0]] }, stepped: { entity: 'sample', fields, layout: [tab('first', 'title'), tab('second', 'description')] }, attach: { entity: 'sample', fields: [fields[0]] } } },
  } });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(async () => { await browser.close(); await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const context = await browser.newContext();
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  const page = await context.newPage(), errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.isNavigationRequest()) posts.push(request); });
  const postback = () => page.waitForResponse(item => item.request().isNavigationRequest() && item.request().method() === 'POST');
  return { app, page, errors, posts, postback };
}

test('state actions post the page back without the editable values and re-render the other action', async t => {
  const { app, page, errors, posts, postback } = await fixture(t);
  await page.goto(`${app.url}/?row=${ID}`);
  await page.locator('#title').fill('Not saved by the action');
  // The action bar (entityform.js) posts the record reference as JSON to /_services/action-* and
  // reloads; the page itself is never posted back, so the edited title is not saved.
  const action = (name) => page.waitForResponse((item) => item.url().includes('/_services/action-' + name + '/') && item.request().method() === 'POST');
  let response = action('deactivate');
  await page.locator('button.deactivate-link').click();
  assert.equal((await response).status(), 204);
  await page.waitForLoadState('load');
  await page.locator('button.activate-link:not(.hidden)').waitFor();
  let record = await app.store.get('sample', ID, { roles: ['Editor'] });
  assert.deepEqual([record.title, record.statecode, record.statuscode], ['Original', 1, 2]);
  assert.equal(posts.length, 0, 'state actions never post the page back');
  response = action('activate');
  await page.locator('button.activate-link').click();
  assert.equal((await response).status(), 204);
  await page.waitForLoadState('load');
  await page.locator('button.deactivate-link:not(.hidden)').waitFor();
  record = await app.store.get('sample', ID, { roles: ['Editor'] });
  assert.deepEqual([record.statecode, record.statuscode], [0, 1]);
  assert.deepEqual(errors, []);
});

test('auto-generated steps move with Next and Previous and the last tab saves every tab', async t => {
  const { app, page, errors, posts, postback } = await fixture(t);
  await page.goto(`${app.url}/steps/`);
  assert.equal(await page.locator('h2.tab-title').innerText(), 'first');
  // The step buttons render as thin bars (live: ~2 px), so the clicks are dispatched as the matrix does.
  const press = (id) => page.locator(id).dispatchEvent('click');
  // Client validation stops an empty required tab before any postback.
  await press('#NextButton');
  await page.locator('#ValidationSummaryEntityFormControl_stepped_EntityFormView li').first().waitFor();
  assert.equal(posts.length, 0);
  await page.locator('#title').fill('Tab one');
  let response = postback();
  await press('#NextButton');
  assert.equal((await response).status(), 200);
  await page.locator('h2.tab-title').filter({ hasText: 'second' }).waitFor();
  const posted = new URLSearchParams(posts[0].postData());
  assert.equal(posted.get('__EVENTTARGET'), '');
  assert.equal(posted.get('ctl00$ContentContainer$EntityFormControl_stepped$EntityFormControl_stepped_EntityFormView$NextButton'), 'Next tab');
  assert.equal(app.store.snapshot().tables.sample.length, 1, 'Next saves nothing');
  response = postback();
  await press('#PreviousButton');
  await response;
  await page.locator('h2.tab-title').filter({ hasText: 'first' }).waitFor();
  assert.equal(await page.locator('#title').inputValue(), 'Tab one');
  response = postback();
  await press('#NextButton');
  await response;
  await page.locator('#description').fill('Tab two');
  response = postback();
  await page.locator('#InsertButton').click();
  assert.equal((await response).status(), 200);
  await page.locator('#MessageLabel').filter({ hasText: 'Saved all tabs' }).waitFor();
  const created = app.store.snapshot().tables.sample.find(row => row.title === 'Tab one');
  assert.equal(created.description, 'Tab two');
  assert.deepEqual(errors, []);
});

test('the attach-file control uploads through the file API and posts the annotation ids with the page', async t => {
  const { app, page, errors, posts, postback } = await fixture(t);
  const fileApi = [];
  page.on('request', request => { if (request.url().includes('/_api/file/')) fileApi.push(`${request.method()} ${new URL(request.url()).pathname} ${[...new URL(request.url()).searchParams.keys()].join(',')}`); });
  await page.goto(`${app.url}/attach/`);
  await page.locator('#title').fill('With a file');
  await page.locator('#AttachFile').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('attached text') });
  const response = postback();
  await page.locator('#InsertButton').click();
  assert.equal((await response).status(), 200);
  await page.locator('#MessageLabel').filter({ hasText: 'Attached' }).waitFor();
  // Live order: initialise, then the block, then the postback with the ids and an empty file input.
  assert.deepEqual(fileApi, ['POST /_api/file/InitializeFileUpload/note formId,formType,regardingId', 'PUT /_api/file/UploadFileBlock/note chunkSize,fileSize,formId,formType,noteId,offset']);
  assert.match(posts[0].headers()['content-type'], /^multipart\/form-data/);
  const body = posts[0].postData() ?? '';
  assert.match(body, /name="[^"]*AttachFile"; filename=""/);
  assert.match(body, /AttachFile_HiddenField_AnnotationIds"\r\n\r\n\["[0-9a-f-]{36}"\]/);
  const note = app.store.snapshot().tables.annotation[0];
  assert.equal(note.filename, 'note.txt');
  assert.equal(Buffer.from(note.documentbody, 'base64').toString(), 'attached text');
  assert.deepEqual(errors, []);
});

test('a failed attachment save preserves the selected file in the browser for retry', async t => {
  const { app, page, errors, postback } = await fixture(t);
  let uploadRequests = 0;
  page.on('request', request => { if (request.url().includes('/_api/file/')) uploadRequests++; });
  await page.goto(`${app.url}/attach/`);
  await page.locator('#title').fill('Retry with retained file');
  await page.locator('#AttachFile').setInputFiles({ name: '<draft>.txt', mimeType: 'text/plain', buffer: Buffer.from('retained text') });
  await page.waitForFunction(() => Boolean(document.getElementById('AttachFile_HiddenField_AnnotationIds')?.value));
  const stagedIds = await page.locator('#AttachFile_HiddenField_AnnotationIds').inputValue();
  let rejected = false;
  app.store.setPluginPipeline(({ entity, stage }) => { if (entity === 'annotation' && stage === 20) { rejected = true; throw new Error('Synthetic note failure'); } });
  let response = postback();
  await page.locator('#InsertButton').click();
  assert.equal((await response).status(), 200);
  await page.locator('#newdivforfileinfo .filename').filter({ hasText: '<draft>.txt' }).waitFor();
  assert.equal(rejected, true);
  assert.equal(await page.locator('#AttachFile_HiddenField_AnnotationIds').inputValue(), stagedIds);
  await page.waitForFunction(() => document.getElementById('UploadButton')?.disabled === true);
  assert.equal(await page.locator('#UploadButton').isDisabled(), true);
  assert.equal(app.store.state.tables.annotation.length, 0);
  app.store.setPluginPipeline(() => {}, () => false);
  response = postback();
  await page.locator('#InsertButton').click();
  assert.equal((await response).status(), 200);
  await page.locator('#MessageLabel').filter({ hasText: 'Attached' }).waitFor();
  assert.equal(app.store.state.tables.annotation.length, 1);
  assert.equal(Buffer.from(app.store.state.tables.annotation[0].documentbody, 'base64').toString(), 'retained text');
  assert.equal(uploadRequests, 2, 'Retry reuses the completed upload without uploading the file again');
  assert.deepEqual(errors, []);
});
