import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { nativeFormPostbackDescriptor, nativeViewStateKey, encodeNativeViewState } from '../lib/native-postback.mjs';
import { nativeFormSubmissionContext, createWebFormSessions } from '../lib/form-service.mjs';
import { resolveNativeFormSubmission, submitNativePostback } from '../lib/native-form-submission.mjs';

function rendered(formId, recordId, extra = {}) {
  const kind = extra.kind ?? 'entityform';
  return {
    descriptor: nativeFormPostbackDescriptor({ kind, formId, fields: [{ name: 'title' }], actions: [{ button: 'UpdateButton', action: 'submit' }], ...extra.descriptor }),
    context: nativeFormSubmissionContext({ kind, formId, entity: 'sample', mode: 100000001, recordId, ...extra.context }),
  };
}
function post(item, title, extra = []) {
  return [['__EVENTTARGET', item.descriptor.actions[0].target], [item.descriptor.fields[0].wireName, title], ...extra];
}
async function fixture() {
  const store = await new DataStore({ state: {
    mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid' } },
    tables: { sample: [{ sampleid: 'first-row', title: 'First' }, { sampleid: 'second-row', title: 'Second' }] },
    settings: { permissionMode: 'enforce' },
    permissions: [{ entity: 'sample', scope: 'global', roles: ['Editor'], operations: ['read', 'update', 'create'] }],
  } }).init();
  const forms = ['first', 'second'].map(id => ({ id, mode: 100000001, metadata: {} }));
  return { store, portal: { forms, records: [] }, schemas: Object.fromEntries(forms.map(f => [f.id, { entity: 'sample', fields: [{ name: 'title', required: true }] }])), identity: { roles: ['Editor'] }, requestUrl: 'http://localhost/edit/?id=first-row' };
}

test('same-page postback selects the exact second form and ignores forged identity/session controls', async () => {
  const options = await fixture(), first = rendered('first', 'first-row'), second = rendered('second', 'second-row');
  const entries = post(second, '<b>Second only</b>', [[first.descriptor.fields[0].wireName, 'Forged first'], ['recordId', 'first-row'], ['stepId', 'forged'], ['sessionid', 'forged'], ['__VIEWSTATE', 'opaque']]);
  const { result, context } = await submitNativePostback(entries, [first, second], options);
  assert.equal(result.recordId, 'second-row');
  assert.equal(context.recordId, 'second-row');
  assert.equal((await options.store.get('sample', 'second-row', options.identity)).title, '<b>Second only</b>');
  assert.equal((await options.store.get('sample', 'first-row', options.identity)).title, 'First');
});

test('decode binds request query to resolved record and removes advanced context from basic forms', () => {
  const item = rendered('first', 'first-row', { context: { recordQueryName: 'row' } });
  const decoded = resolveNativeFormSubmission(post(item, ''), [item], 'http://localhost/edit/?row=forged&stepid=forged&sessionid=forged&view=own');
  assert.deepEqual(decoded.body.query, { row: 'first-row', view: 'own' });
  assert.equal(decoded.body.pageUrl, '/edit/');
  assert.equal(decoded.body.values.title, '');
  assert.equal('stepId' in decoded.body, false);
});

test('a record query parameter the page URL does not carry stays out of the posted query (live Previous keeps ?stepid only)', () => {
  const item = rendered('first', 'first-row', { context: { recordQueryName: 'row' } });
  const decoded = resolveNativeFormSubmission(post(item, ''), [item], 'http://localhost/edit/?view=own');
  assert.deepEqual(decoded.body.query, { view: 'own' });
  assert.equal(decoded.body.recordId, 'first-row');
});

test('service validation and permission rejection remain authoritative without writing', async () => {
  const options = await fixture(), item = rendered('first', 'first-row');
  await assert.rejects(submitNativePostback(post(item, ''), [item], options), /required/i);
  await assert.rejects(submitNativePostback(post(item, 'Denied'), [item], { ...options, identity: { roles: [] } }), /permission|denied/i);
  assert.equal((await options.store.get('sample', 'first-row', options.identity)).title, 'First');
});

test('read-only service cannot be bypassed by a stale writable descriptor', async () => {
  const options = await fixture(), item = rendered('first', 'first-row');
  options.portal.forms[0].mode = 100000002;
  await assert.rejects(submitNativePostback(post(item, 'Forged'), [item], options), error => error.code === 'FormReadOnly');
  assert.equal((await options.store.get('sample', 'first-row', options.identity)).title, 'First');
});

test('advanced postback uses the server-selected session and step rather than posted controls', async () => {
  const options = await fixture(), sessions = createWebFormSessions(), session = sessions.create('wizard', 'visitor:own');
  session.current = 'second';
  session.history.push({ stepId: 'first', entity: 'sample', recordId: 'first-row' });
  const item = rendered('wizard', 'first-row', { kind: 'webform', descriptor: { actions: [{ button: 'PreviousButton', action: 'previous' }] }, context: { stepId: 'second', sessionId: session.id } });
  const config = { ...options, sessions, owner: 'visitor:own', portal: { advancedForms: [{ id: 'wizard', metadata: {} }], records: [] }, schemas: { wizard: { initialStepId: 'first', steps: [{ stepId: 'first', entity: 'sample', mode: 100000001, fields: [{ name: 'title' }] }, { stepId: 'second', entity: 'sample', mode: 100000001, fields: [{ name: 'title' }] }] } } };
  const { result } = await submitNativePostback(post(item, 'Ignored previous', [['stepId', 'first'], ['sessionid', 'foreign']]), [item], config);
  assert.equal(result.operation, 'navigate');
  assert.match(result.outcome.url, /stepid=first/);
  assert.equal(session.current, 'first');
  assert.equal((await options.store.get('sample', 'first-row', options.identity)).title, 'First');
});

test('mismatched or duplicate server contexts reject before provider operations', async () => {
  const item = rendered('first', 'first-row');
  assert.throws(() => resolveNativeFormSubmission(post(item, 'Value'), [{ ...item, context: { ...item.context, formId: 'other' } }], 'http://localhost/'), /differs/);
  assert.throws(() => resolveNativeFormSubmission(post(item, 'Value'), [item, item], 'http://localhost/'), /ambiguous/);
});

test('source numeric fields decode URLencoded tokens exactly and reject malformed or out-of-range text before writes', async () => {
  const options = await fixture();
  const fields = [{ name: 'counter', dataverseType: 'bigint', minValue: '-9223372036854775808', maxValue: '9223372036854775807' }, { name: 'quantity', dataverseType: 'decimal', precision: 10, minimum: '-100000000000', maximum: '100000000000' }];
  options.schemas.first.fields = fields;
  options.store.state.mappings.sample.fields = Object.fromEntries(fields.map(field => [field.name, field]));
  const item = rendered('first', 'first-row', { descriptor: { fields } });
  const entries = [['__EVENTTARGET', item.descriptor.actions[0].target], [item.descriptor.fields[0].wireName, '9223372036854775807'], [item.descriptor.fields[1].wireName, '99999999999.1234567891']];
  await submitNativePostback(entries, [item], options);
  const before = await options.store.get('sample', 'first-row', options.identity);
  assert.equal(before.counter.value, '9223372036854775807');
  assert.equal(before.quantity.value, '99999999999.1234567891');
  await assert.rejects(submitNativePostback(entries.map(pair => pair[0] === item.descriptor.fields[0].wireName ? [pair[0], '9223372036854775808'] : pair), [item], options), error => error.code === 'FormFieldOutOfRange');
  await assert.rejects(submitNativePostback(entries.map(pair => pair[0] === item.descriptor.fields[1].wireName ? [pair[0], 'broken'] : pair), [item], options), error => error.code === 'FormFieldInvalid');
  assert.deepEqual(await options.store.get('sample', 'first-row', options.identity), before);
});

test('declared textarea and boolean values use native successful-control semantics while unposted checkbox remains untouched', async () => {
  const options = await fixture();
  const fields = [{ name: 'title', type: 'textarea' }, { name: 'enabled', type: 'boolean' }];
  options.schemas.first.fields = fields;
  const item = rendered('first', 'first-row', { descriptor: { fields } });
  await submitNativePostback([['__EVENTTARGET', item.descriptor.actions[0].target], [item.descriptor.fields[0].wireName, 'A\r\nB\rC'], [item.descriptor.fields[1].wireName, '0']], [item], options);
  const row = await options.store.get('sample', 'first-row', options.identity);
  assert.equal(row.title, 'A\nB\nC');
  assert.equal(row.enabled, false);
  await submitNativePostback([['__EVENTTARGET', item.descriptor.actions[0].target], [item.descriptor.fields[0].wireName, 'Title']], [item], options);
  assert.equal((await options.store.get('sample', 'first-row', options.identity)).enabled, false);
});

test('state-action postbacks ignore page field controls and preserve the declared action index', () => {
  const item = rendered('first', 'first-row', { descriptor: { actions: [{ button: 'DeactivateButton', action: 'deactivate', actionIndex: 2 }] } });
  const decoded = resolveNativeFormSubmission(post(item, 'Unsaved edit'), [item], 'http://localhost/?id=first-row');
  assert.deepEqual(decoded.body.values, {});
  assert.equal(decoded.body.action, 'deactivate');
  assert.equal(decoded.body.actionIndex, 2);
});

test('an advanced step requiring the captcha rejects the save postback with the captcha message and writes nothing', async () => {
  const options = await fixture(), sessions = createWebFormSessions(), session = sessions.create('wizard', 'visitor:own');
  session.current = 'first';
  const item = rendered('wizard', 'first-row', { kind: 'webform', context: { stepId: 'first', sessionId: session.id } });
  const step = (metadata) => ({ ...options, sessions, owner: 'visitor:own', identity: { contactId: 'c1', roles: ['Editor'] }, portal: { advancedForms: [{ id: 'wizard', metadata: {} }], records: [] }, schemas: { wizard: { initialStepId: 'first', steps: [{ stepId: 'first', entity: 'sample', mode: 100000001, fields: [{ name: 'title' }], metadata }] } } });
  // Signed in with "show captcha for authenticated users": rejected (live multistep-survey step1-submit).
  await assert.rejects(submitNativePostback(post(item, 'Changed'), [item], step({ adx_captcharequired: true, adx_showcaptchaforauthenticatedusers: true })), (error) => error.status === 400 && error.details.validationErrors[0].message === 'Captcha is incorrect, please re-enter captcha.');
  assert.equal((await options.store.get('sample', 'first-row', options.identity)).title, 'First');
  const { nativePostbackResponse } = await import('../lib/native-form-submission.mjs');
  const error = await submitNativePostback(post(item, 'Changed'), [item], step({ adx_captcharequired: true, adx_showcaptchaforauthenticatedusers: true })).catch((e) => e);
  assert.deepEqual(nativePostbackResponse({ error, context: { kind: 'webform' }, values: { title: 'Changed' } }).state.validationErrors.map((e) => e.code), ['CaptchaInvalid']);
  // Signed in without that setting: the captcha is not asked and the step saves.
  const { result } = await submitNativePostback(post(item, 'Changed'), [item], step({ adx_captcharequired: true }));
  assert.notEqual(result, undefined);
});

test('a basic form showing the captcha rejects the save postback with the captcha message and writes nothing', async () => {
  const options = await fixture(), item = rendered('first', 'first-row');
  options.portal.forms[0].metadata = { adx_captcharequired: true, adx_showcaptchaforauthenticatedusers: true };
  await assert.rejects(submitNativePostback(post(item, 'Changed'), [item], options), (error) => error.status === 400 && error.details.validationErrors[0].field === 'captcha');
  assert.equal((await options.store.get('sample', 'first-row', options.identity)).title, 'First');
  // A signed-in visitor is asked only with "show captcha for authenticated users".
  options.portal.forms[0].metadata = { adx_captcharequired: true };
  const { result } = await submitNativePostback(post(item, 'Changed'), [item], { ...options, identity: { contactId: 'c1', roles: ['Editor'] } });
  assert.notEqual(result, undefined);
});

test('a __VIEWSTATE carrying the anti-forgery key exposes it; other values carry none', () => {
  assert.equal(nativeViewStateKey(encodeNativeViewState({ k: 'csrf-1' })), 'csrf-1');
  assert.equal(nativeViewStateKey(encodeNativeViewState({ form: 'f', autoStep: 0, values: {} })), null);
  assert.equal(nativeViewStateKey('/wEopaque'), null);
  assert.equal(nativeViewStateKey(undefined), null);
});
