import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { parseNativePostback } from '../lib/native-postback.mjs';
import { submitNativePostback } from '../lib/native-form-submission.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';

const identity = { roles: ['Editor'] };
const fields = [
  { name: 'checked', type: 'boolean' },
  { name: 'radio', type: 'boolean', controlClassId: '67fac785-cd58-4f9f-abb3-4b7ddc6ed5ed' },
  { name: 'dropdown', type: 'boolean', controlClassId: '3ef39988-22bb-4f0b-bbbe-64b5a3748aee' },
  { name: 'locked', type: 'boolean', readOnly: true },
  { name: 'disabled', type: 'boolean', disabled: true },
  { name: 'absent', type: 'boolean' },
];
const tab = names => ({ columns: [{ sections: [{ rows: names.map(name => [{ name }]) }] }] });
async function fixture() {
  const store = await new DataStore({ state: {
    mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid' } },
    tables: { sample: [{ sampleid: 'owned', ...Object.fromEntries(fields.map(field => [field.name, true])) }] },
    permissions: [{ entity: 'sample', scope: 'global', roles: identity.roles, operations: ['read', 'update'] }],
    settings: { permissionMode: 'enforce' },
  } }).init();
  return { store, portal: { forms: [{ id: 'entry', name: 'Entry', mode: 100000001, metadata: {} }], records: [] }, schemas: { entry: { entity: 'sample', fields, layout: [tab(fields.filter(field => field.name !== 'absent').map(field => field.name))] } }, identity, requestUrl: 'http://localhost/?id=owned' };
}
async function descriptor(options, nativePostbackState) {
  const captured = [];
  await renderComponent('entityform', 'Entry', { user: identity, request: { params: { id: 'owned' } } }, { ...options, nativePostbackState, onNativePostbackDescriptor: item => captured.push(item) });
  assert.equal(captured.length, 1);
  return captured[0];
}

test('rendered Boolean descriptors preserve absent, disabled and locked fields, while lists retain their own values', async () => {
  const options = await fixture(), item = await descriptor(options), spec = item.descriptor;
  assert.deepEqual(spec.fields.map(field => [field.name, Boolean(field.checkbox)]), [['checked', true], ['radio', false], ['dropdown', false]]);
  const submit = values => submitNativePostback([['__EVENTTARGET', spec.actions[0].target], ...Object.entries(values).map(([name, value]) => [spec.fields.find(field => field.name === name).wireName, value])], [item], options);
  await submit({});
  assert.deepEqual(options.store.state.tables.sample[0], { sampleid: 'owned', checked: false, radio: true, dropdown: true, locked: true, disabled: true, absent: true, modifiedon: options.store.state.tables.sample[0].modifiedon });
  await submit({ checked: 'false', radio: '0', dropdown: '1' });
  const saved = options.store.state.tables.sample[0];
  assert.equal(saved.checked, true, 'a checkbox token is a presence flag');
  assert.equal(saved.radio, false); assert.equal(saved.dropdown, true);
  const before = options.store.snapshot();
  await assert.rejects(submitPortalForm('entityform', 'entry', { recordId: 'owned', values: { checked: 'maybe' } }, options), { code: 'FormFieldInvalid' });
  assert.deepEqual(options.store.snapshot(), before);
  await submitPortalForm('entityform', 'entry', { recordId: 'owned', values: { checked: false } }, options);
  assert.equal(options.store.state.tables.sample[0].checked, false, 'JSON Boolean false is a value, not a checkbox token');
  const deniedBefore = options.store.snapshot();
  await assert.rejects(submitPortalForm('entityform', 'entry', { recordId: 'owned', values: { checked: true } }, { ...options, identity: { roles: [] } }), { code: 'PermissionDenied' });
  assert.deepEqual(options.store.snapshot(), deniedBefore);
});

test('auto-step descriptors default only checkboxes on their rendered tab', async () => {
  const options = await fixture();
  options.portal.forms[0].metadata.adx_autogeneratesteps = true;
  options.schemas.entry.layout = [tab(['checked']), tab(['absent'])];
  const first = await descriptor(options), second = await descriptor(options, { kind: 'entityform', formId: 'entry', autoStep: 1 });
  assert.deepEqual(first.descriptor.fields.map(field => field.name), ['checked']);
  assert.deepEqual(second.descriptor.fields.map(field => field.name), ['absent']);
  const decoded = parseNativePostback([['__EVENTTARGET', second.descriptor.actions.find(action => action.action === 'submit').target]], [second.descriptor]);
  assert.deepEqual(decoded.body.values, { absent: 'false' });
});
