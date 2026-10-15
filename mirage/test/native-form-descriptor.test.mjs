import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';
import { nativeFormSubmissionContext, createWebFormSessions } from '../lib/form-service.mjs';
import { parseNativePostback } from '../lib/native-postback.mjs';

const store = { resolveMapping: () => ({ logicalName: 'sample', entitySet: 'samples', idColumn: 'sampleid', relationships: {} }), get: async () => ({ sampleid: 'owned', name: 'Private rendered value', statecode: 0 }), allowed: () => true };
const options = () => ({ store, portal: { forms: [{ id: 'first', name: 'First', mode: 100000001, metadata: { adx_recordidquerystringparametername: 'row' } }, { id: 'second', name: 'Second', mode: 100000001, metadata: {} }], records: [] }, schemas: Object.fromEntries(['first', 'second'].map(id => [id, { entity: 'sample', fields: [{ name: 'name', type: 'text' }, { name: 'readonly', type: 'text', readOnly: true }, { name: 'ownerid', type: 'text' }, { name: 'hidden', type: 'text', hidden: true }] }])) });

test('internal descriptors bind the selected form and resolved record, leaving HTML and JSON configuration unchanged', async () => {
  const o = options(), context = { request: { params: { row: 'owned', recordId: 'forged', stepid: 'forged' } } }, captured = [];
  const plain = await renderComponent('entityform', 'First', context, o);
  const collected = await renderComponent('entityform', 'First', context, { ...o, onNativePostbackDescriptor: item => { captured.push(item); return '<injected>'; } });
  assert.equal(collected, plain);
  assert.deepEqual(captured[0].context, { kind: 'entityform', formId: 'first', entity: 'sample', mode: 100000001, recordId: 'owned', stepId: null, sessionId: null, recordQueryName: 'row' });
  assert.deepEqual(captured[0].descriptor.fields.map(x => x.name), ['name', 'hidden']);
  assert.equal(JSON.stringify(captured).includes('Private rendered value'), false);
  await renderComponent('entityform', 'Second', { request: { params: { id: 'second-owned' } } }, { ...o, onNativePostbackDescriptor: item => captured.push(item) });
  const selected = captured[1].descriptor;
  const result = parseNativePostback([['__EVENTTARGET', selected.actions[0].target], [selected.fields[0].wireName, 'Second only'], [captured[0].descriptor.fields[0].wireName, 'First forged'], ['recordId', 'another']], captured.map(x => x.descriptor));
  assert.equal(result.formId, 'second');
  assert.deepEqual(result.body.values, { name: 'Second only' });
  assert.equal(captured[1].context.recordId, 'second-owned');
});

test('descriptor snapshots cannot mutate fields, rendered actions or server context', async () => {
  const o = options();
  await renderComponent('entityform', 'First', { request: { params: { row: 'owned' } } }, { ...o, onNativePostbackDescriptor: item => {
    assert(Object.isFrozen(item));
    assert.throws(() => { item.context.recordId = 'forged'; }, TypeError);
    assert.throws(() => { item.descriptor.actions[0].target = 'forged'; }, TypeError);
    assert.throws(() => { item.descriptor.fields.push({ name: 'forged' }); }, TypeError);
    assert.throws(() => { item.descriptor.ids.buttons = 'forged'; }, TypeError);
  } });
  assert.equal(o.schemas.first.fields[0].name, 'name');
});

test('descriptors include only controls actually rendered by the selected layout', async () => {
  const o = options(), captured = [];
  o.schemas.first.layout = [{ columns: [{ sections: [{ rows: [[{ name: 'name', id: 'name' }]] }] }] }];
  await renderComponent('entityform', 'First', { request: { params: { row: 'owned' } } }, { ...o, onNativePostbackDescriptor: item => captured.push(item) });
  assert.deepEqual(captured[0].descriptor.fields.map(x => x.name), ['name']);
  o.portal.forms[0].mode = 100000002;
  await renderComponent('entityform', 'First', { request: { params: { row: 'owned' } } }, { ...o, onNativePostbackDescriptor: item => captured.push(item) });
  assert.deepEqual(captured[1].descriptor.fields, []);
  assert.deepEqual(captured[1].descriptor.actions, []);
});

test('advanced descriptors carry the server-selected step/session and only shown navigation actions', async () => {
  const sessions = createWebFormSessions(), session = sessions.create('wizard', 'visitor:one');
  session.current = 'second';
  session.history.push({ stepId: 'first', recordId: 'owned', entity: 'sample' });
  const o = { store, portal: { advancedForms: [{ id: 'wizard', name: 'Wizard', metadata: {} }], records: [] }, schemas: { wizard: { initialStepId: 'first', steps: [{ stepId: 'first', entity: 'sample', mode: 100000000, nextStepId: 'second', fields: [{ name: 'name', type: 'text' }] }, { stepId: 'second', entity: 'sample', mode: 100000001, fields: [{ name: 'name', type: 'text' }], metadata: {} }] } }, webFormSessions: sessions, webFormOwner: () => 'visitor:one' }, captured = [];
  const html = await renderComponent('webform', 'Wizard', { request: { params: { sessionid: session.id, id: 'forged' } } }, { ...o, args: { pp_page_control: true }, onNativePostbackDescriptor: item => captured.push(item) });
  const item = captured[0];
  assert.equal(item.context.stepId, 'second');
  assert.equal(item.context.sessionId, session.id);
  assert.equal(item.context.recordId, 'owned');
  assert.deepEqual(item.descriptor.actions.map(x => x.action), ['previous', 'submit']);
  for (const action of item.descriptor.actions) assert(html.includes(action.target));
  assert(item.descriptor.actions.every(x => x.target.includes('$EntityControls$WebFormControl$')));
  o.schemas.wizard.steps[1].metadata.adx_movepreviouspermitted = false;
  o.schemas.wizard.steps[1].mode = 100000002;
  captured.length = 0;
  await renderComponent('webform', 'Wizard', { request: { params: { sessionid: session.id } } }, { ...o, onNativePostbackDescriptor: item => captured.push(item) });
  assert.deepEqual(captured[0].descriptor.actions, []);
});

test('unavailable forms do not publish descriptors and malformed resolved context is rejected', async () => {
  const captured = [], o = options();
  await renderComponent('entityform', 'First', { request: { params: {} } }, { ...o, onNativePostbackDescriptor: item => captured.push(item) });
  assert.deepEqual(captured, []);
  assert.throws(() => nativeFormSubmissionContext({ kind: 'entityform', formId: 'first', entity: 'sample', mode: 100000001, recordId: { id: 'forged' } }), /must be textual/);
  assert.throws(() => nativeFormSubmissionContext({ kind: 'entityform', formId: 'first', entity: 'sample', mode: 999 }), /mode required/);
});

test('state-action descriptors retain source declaration indices and omit unavailable actions', async () => {
  const o = options(), captured = [];
  o.portal.forms[0].metadata.adx_settings = JSON.stringify({ Actions: [{ Type: 'ActivateAction' }, { Type: 'DeactivateAction' }] });
  o.store = { ...store, resolveMapping: () => ({ logicalName: 'sample', entitySet: 'samples', relationships: {}, fieldMetadata: { statecode: { states: [{ value: 0, defaultStatus: 10 }, { value: 1, defaultStatus: 20 }] }, statuscode: { statuses: [{ value: 10, state: 0 }, { value: 20, state: 1 }] } } }) };
  o.metadata = { entities: { sample: { fields: o.store.resolveMapping().fieldMetadata } } };
  // State actions are the platform's button.*-link action bar posting to /_services/action-*, not postback controls: the descriptor lists no state actions and the bar renders the pair with the inapplicable one hidden.
  const html = await renderComponent('entityform', 'First', { request: { params: { row: 'owned' } } }, { ...o, onNativePostbackDescriptor: item => captured.push(item) });
  assert.deepEqual(captured[0].descriptor.actions.map(({ action }) => action), []);
  assert.match(html, /<button class="activate-link btn btn-default btn hidden" data-url="\/_services\/action-activate\/[^"]*" href="[^"]*" type="button" style="display: none;">Activate<\/button><button class="deactivate-link btn btn-default btn" data-url="\/_services\/action-deactivate\/[^"]*" href="[^"]*" type="button">Deactivate<\/button>/);
  o.store.allowed = () => false;
  const denied = await renderComponent('entityform', 'First', { request: { params: { row: 'owned' } } }, { ...o, onNativePostbackDescriptor: item => captured.push(item) });
  assert.deepEqual(captured[1].descriptor.actions, []);
  assert.doesNotMatch(denied, /activate-link/);
  assert.deepEqual(captured[1].descriptor.fields, []);
});
