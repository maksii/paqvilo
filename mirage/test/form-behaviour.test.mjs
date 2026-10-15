import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { formCreateAllowed } from '../lib/form-service.mjs';
import { formErrorPanel, createAccessDeniedForm } from '../lib/form-error-presentation.mjs';
import { nativeFormPostbackDescriptor } from '../lib/native-postback.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { formWriteError } from '../lib/form-error-presentation.mjs';

const store = (permissions, permissionMode = 'enforce') => new DataStore({ state: { version: 1, mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } }, tables: { widget: [] }, permissions, plugins: [], settings: { permissionMode } } });

test('a create form needs a Create table permission of any scope for the identity', () => {
  const grants = [
    { id: 'p1', entity: 'widget', operations: ['read'], roles: ['Readers'] },
    { id: 'p2', entity: 'widget', operations: ['read', 'create'], scope: 'contact', roles: ['Editors'] },
  ];
  assert.equal(formCreateAllowed(store(grants), 'widget', { contactId: 'c1', roles: ['Editors'] }), true);
  assert.equal(formCreateAllowed(store(grants), 'widget', { contactId: 'c1', roles: ['Readers'] }), false);
  assert.equal(formCreateAllowed(store(grants), 'widget', { contactId: 'c1', roles: [] }), false);
  assert.equal(formCreateAllowed(store(grants), 'widget', {}), false);
  assert.equal(formCreateAllowed(store([], 'permissive'), 'widget', {}), true);
  assert.equal(formCreateAllowed(store([]), 'widget', { admin: true }), true);
});

test('a column placed twice on a form is declared once for its postback', () => {
  // A column placed twice on the form posts only through its first rendered cell.
  const descriptor = nativeFormPostbackDescriptor({ kind: 'entityform', formId: 'f1', fields: [{ name: 'notes' }, { name: 'title' }, { name: 'notes' }], actions: [{ button: 'InsertButton', action: 'submit' }] });
  assert.deepEqual(descriptor.fields.map(field => field.name), ['notes', 'title']);
});

test('a plugin rejection surfaces its message in the Bootstrap 5 danger panel', () => {
  const id = '30000000-0000-4000-8000-000000000001';
  const step = { id, name: 'Invented', enabled: true, entity: 'widget', message: 'Create', stage: 10, rank: 1, mode: 0, typeName: 'Invented', assemblyId: 'Invented', supportedDeployment: 0, images: [], filteringAttributes: [] };
  const handlers = new Map([[id, ({ target, reject }) => { if (target.title === 'fail') reject('Widget rejected <here>'); }]]);
  let failure;
  try { runPluginPhase({ items: pluginCatalogue({ plugins: { steps: [step] }, handlers }), handlers, entity: 'widget', operation: 'create', stage: 10, target: { title: 'fail' }, record: { title: 'fail' } }); }
  catch (error) { failure = error; }
  failure.nativeFormWriteFailure = true;
  const outcome = formWriteError(failure);
  assert.equal(outcome.message, 'Widget rejected <here>');
  assert.equal(formErrorPanel(outcome, { v5: true, closeButton: '<input id="btnCloseMessage">' }),
    '<div id="MessagePanel" class="message alert alert-danger" role="alert"><input id="btnCloseMessage"><span id="MessageLabel" aria-live="polite" aria-atomic="true"><p class="text-danger"><span class="fa fa-exclamation-triangle" aria-hidden="true"></span> Widget rejected &lt;here&gt;</p></span></div>');
  assert.equal(formErrorPanel({ message: 'm', markup: 'paragraph' }, { v5: true }), '<div id="MessagePanel" class="message alert alert-danger" role="alert"><span id="MessageLabel"><p>m</p></span></div>');
});

test('a denied create form keeps its panel and shows the access-denied snippet', () => {
  const html = createAccessDeniedForm({ ids: { wrapper: 'EntityFormControl_x', panel: 'EntityFormPanel', view: 'EntityFormControl_x_EntityFormView' }, formName: 'Widget', defaultButton: 'InsertButton' });
  assert.equal(html, `<div id="EntityFormControl_x"><div id="EntityFormPanel" class="crmEntityFormView" data-form-name="Widget" onkeypress="javascript:return WebForm_FireDefaultButton(event, 'InsertButton')" role="form" aria-label="Basic Form"><div id="EntityFormControl_x_EntityFormView" class="entity-form"><div><div class="xrm-editable-html xrm-attribute"><div class="xrm-attribute-value"><div class='alert alert-block alert-danger'><span class='fa fa-lock' aria-hidden='true'></span>You don't have the appropriate permissions.</div></div></div></div></div><div class="actions"></div></div></div>`);
});

test('a multipart WebForms postback decodes its text controls and carries selected files', async () => {
  const { multipartControls } = await import('../lib/native-postback.mjs');
  // An empty file input as a browser posts it.
  const part = (name, extra, value) => `------WebKitFormBoundaryX\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n${value}\r\n`;
  const raw = part('__EVENTTARGET', '', 'ctl00$Update') + part('title', '', 'a & b') + part('upload', '; filename=""\r\nContent-Type: application/octet-stream', '') + '------WebKitFormBoundaryX--\r\n';
  const controls = await multipartControls(Buffer.from(raw), 'multipart/form-data; boundary=----WebKitFormBoundaryX');
  assert.deepEqual([...controls], [['__EVENTTARGET', 'ctl00$Update'], ['title', 'a & b']]);
  assert.deepEqual(controls.files, []);
  const body = new FormData();
  body.set('upload', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
  const withFile = new Request('http://local/', { method: 'POST', body });
  // A chosen file (the attach-file control) travels as a base64 attachment.
  const posted = await multipartControls(Buffer.from(await withFile.arrayBuffer()), withFile.headers.get('content-type'));
  assert.deepEqual(posted.files, [{ field: 'upload', name: 'x.txt', type: 'text/plain', content: Buffer.from('x').toString('base64') }]);
  await assert.rejects(multipartControls(Buffer.from('nope'), 'multipart/form-data; boundary=zzz'), { code: 'InvalidNativePostback' });
});

test('a trusted plugin handler receives its registered pre- and post-images', () => {
  const id = '30000000-0000-4000-8000-000000000002', seen = [];
  const step = { id, name: 'Invented', enabled: true, entity: 'widget', message: 'Update', stage: 40, rank: 1, mode: 0, typeName: 'Invented', assemblyId: 'Invented', supportedDeployment: 0, filteringAttributes: [],
    images: [{ name: 'pre', alias: 'pre', type: 0, attributes: ['title'] }, { name: 'post', alias: 'post', type: 1, attributes: [] }] };
  const handlers = new Map([[id, ({ preImage, postImage }) => { seen.push(preImage, postImage); }]]);
  const items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  assert.equal(items[0].unsupported, null);
  runPluginPhase({ items, handlers, entity: 'widget', operation: 'update', stage: 40, target: { title: 'new' }, record: { title: 'new', code: 'c' }, previous: { title: 'old', code: 'c' } });
  assert.deepEqual(seen, [{ title: 'old' }, { title: 'new', code: 'c' }]);
});

test('a save whose form stays visible re-renders the posted values; a hidden form does not', async () => {
  const { nativePostbackResponse } = await import('../lib/native-form-submission.mjs');
  const context = { kind: 'entityform', formId: 'f1' }, values = { title: 'posted' };
  assert.deepEqual(nativePostbackResponse({ result: { outcome: { type: 'message', message: 'Saved', hideForm: false } }, context, values }).state,
    { ...context, values, outcome: { type: 'message', message: 'Saved', hideForm: false }, savedId: null, savedName: null });
  assert.equal(nativePostbackResponse({ result: { outcome: { type: 'message', message: 'Saved', hideForm: true } }, context, values }).state.values, undefined);
  assert.deepEqual(nativePostbackResponse({ result: { outcome: { type: 'redirect', url: '/next/?id=1' } }, context, values }), { status: 302, location: '/next/?id=1' });
});
