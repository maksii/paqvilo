import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';
import { renderComponent } from '../lib/platform.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const fields = {
  title: { type: 'text', required: true },
  statecode: { dataverseType: 'state', states: [{ value: 0, defaultStatus: 10 }, { value: 1, defaultStatus: 30 }] },
  statuscode: { dataverseType: 'status', statuses: [{ value: 10, state: 0 }, { value: 30, state: 1 }, { value: 31, state: 1 }] },
};
async function fixture() {
  const store = await new DataStore({ state: {
    mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid', nameColumn: 'title', fieldMetadata: fields } },
    tables: { sample: [{ sampleid: id, title: 'Original', statecode: 0, statuscode: 10 }, { sampleid: other, title: 'Other', statecode: 0, statuscode: 10 }] },
    permissions: [{ entity: 'sample', scope: 'global', roles: ['Editor'], operations: ['read', 'update'] }, { entity: 'sample', scope: 'global', roles: ['Reader'], operations: ['read'] }],
    settings: { permissionMode: 'enforce', 'Webapi/sample/enabled': false },
  } }).init();
  const metadata = { adx_entitysourcetype: 756150001, adx_recordidquerystringparametername: 'row', adx_settings: JSON.stringify({ Actions: [
    { Type: 'DeactivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Close entry' }], SuccessMessage: [{ LCID: 1033, Value: 'Entry closed.' }] },
    { Type: 'ActivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Reopen entry' }] },
  ] }) };
  return { store, portal: { forms: [{ id: 'entry-form', name: 'Entry', mode: 100000001, metadata }], pages: [] }, schemas: { 'entry-form': { entity: 'sample', fields: [{ name: 'title', label: 'Title', type: 'text', required: true }] } }, identity: { id: 'editor', roles: ['Editor'] } };
}
const body = (action, overrides = {}) => ({ action, recordId: id, values: {}, query: { row: id }, ...overrides });
const submit = (options, input) => submitPortalForm('entityform', 'entry-form', input, options);

test('native actions derive default status, skip field validation and keep unrelated values untouched', async () => {
  const options = await fixture();
  const closed = await submit(options, body('deactivate'));
  assert.equal(closed.operation, 'deactivate');
  assert.equal(closed.record.statecode, 1);
  assert.equal(closed.record.statuscode, 30);
  assert.equal(closed.record.title, 'Original');
  assert.deepEqual(closed.outcome, { type: 'message', message: 'Entry closed.', hideForm: false });
  const reopened = await submit(options, body('activate'));
  assert.equal(reopened.record.statecode, 0);
  assert.equal(reopened.record.statuscode, 10);
  assert.equal(reopened.record.title, 'Original');
  options.portal.forms[0].mode = 100000002;
  assert.equal((await submit(options, body('deactivate'))).record.statuscode, 30, 'an explicit action on a read-only form still uses table update permissions');
});

test('native action requests re-resolve configured actions, record source, metadata and permissions', async () => {
  const options = await fixture();
  for (const [input, code] of [
    [body('submit', { values: { title: 'Forged submit' } }), 'FormSubmitNotEnabled'],
    [body('deactivate', { values: { title: 'Forged action' } }), 'FormActionInvalid'],
    [body('deactivate', { attachments: [{ name: 'injected.txt' }] }), 'FormActionInvalid'],
    [body('deactivate', { actionIndex: 1 }), 'FormActionNotEnabled'],
    [body('deactivate', { recordId: other }), 'FormRecordMismatch'],
    [body('deactivate', { query: {} }), 'FormRecordMismatch'],
  ]) await assert.rejects(submit(options, input), error => error.code === code);
  await assert.rejects(submit({ ...options, identity: { id: 'reader', roles: ['Reader'] } }, body('deactivate')), error => error.status === 403);
  const config = JSON.parse(options.portal.forms[0].metadata.adx_settings);
  config.Actions[0].FilterCriteria = '<filter><condition attribute="title" operator="eq" value="Allowed"/></filter>';
  options.portal.forms[0].metadata.adx_settings = JSON.stringify(config);
  await assert.rejects(submit(options, body('deactivate')), error => error.code === 'FormActionFilterUnsupported');
  delete config.Actions[0].FilterCriteria;
  options.portal.forms[0].metadata.adx_settings = JSON.stringify(config);
  options.store.state.mappings.sample.fieldMetadata.statecode.states[1].defaultStatus = 999;
  await assert.rejects(submit(options, body('deactivate')), error => error.code === 'FormActionStateUnresolved');
  assert.equal((await options.store.get('sample', id, options.identity)).statecode, 0);
  assert.equal((await options.store.get('sample', other, options.identity)).statecode, 0);
});

test('native current-user actions cannot select another contact even with broad table grants', async () => {
  const options = await fixture();
  options.portal.forms[0].metadata.adx_entitysourcetype = 756150002;
  options.identity.contactId = id;
  await assert.rejects(submit(options, body('deactivate', { recordId: other, query: { row: other } })), error => error.code === 'FormRecordMismatch');
  assert.equal((await submit(options, body('deactivate'))).recordId, id);
});

test('malformed exported native action settings fail explicitly before rendering or writing', async () => {
  const options = await fixture();
  for (const settings of [null, [], { Actions: null }, { Actions: {} }, { Actions: [null] }, { Actions: [{}] }]) {
    options.portal.forms[0].metadata.adx_settings = JSON.stringify(settings);
    await assert.rejects(submit(options, body('deactivate')), error => error.code === 'FormActionConfigurationInvalid');
    await assert.rejects(renderComponent('entityform', 'Entry', { identity: options.identity, request: { params: { row: id } } }, options), error => error.code === 'FormActionConfigurationInvalid');
  }
  assert.equal((await options.store.get('sample', id, options.identity)).statecode, 0);
});

test('native rendering keeps state action-only forms and does not invent unresolved action controls', async () => {
  const options = await fixture(), diagnostics = [];
  const render = () => renderComponent('entityform', 'Entry', { identity: options.identity, request: { url: `http://localhost/form/?row=${id}`, params: { row: id } } }, { ...options, diagnostic: item => diagnostics.push(item) });
  const active = await render();
  assert.match(active, /id="DeactivateButton" value="Close entry"/);
  assert.doesNotMatch(active, /id="(?:ActivateButton|UpdateButton)"/);
  assert.match(active, /data-pp-action-index="0"/);
  await submit(options, body('deactivate'));
  const inactive = await render();
  assert.match(inactive, /id="ActivateButton" value="Reopen entry"/);
  assert.doesNotMatch(inactive, /id="(?:DeactivateButton|UpdateButton)"/);
  options.store.state.mappings.sample.fieldMetadata.statecode.states = [];
  const unresolved = await render();
  assert.doesNotMatch(unresolved, /id="(?:ActivateButton|UpdateButton)"/);
  assert.equal(diagnostics.at(-1).code, 'FORM_ACTION_UNRESOLVED');
});
