import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { submitPortalForm, createWebFormSessions } from '../lib/form-service.mjs';
import { withNativeFormContactAssociation } from '../lib/native-form-association.mjs';

const identity = { contactId: 'current', roles: ['Member'] };
async function fixture() {
  const store = await new DataStore({
    state: {
      mappings: {
        request: {
          entitySet: 'requests',
          idColumn: 'requestid',
          relationships: {
            creator: { entity: 'contact', from: 'creatorid', to: 'contactid', many: false },
            other: { entity: 'contact', from: 'otherid', to: 'contactid', many: false },
            parent: { entity: 'request', from: 'parentid', to: 'requestid', many: false },
          },
        },
        contact: { entitySet: 'contacts', idColumn: 'contactid' },
      },
      tables: { request: [], contact: [{ contactid: 'current' }, { contactid: 'foreign' }] },
      settings: { permissionMode: 'enforce', associationPermissions: 'enforce' },
      permissions: [
        { entity: 'request', scope: 'global', roles: ['Member'], operations: ['create', 'read', 'update'] },
      ],
    },
  }).init();
  const metadata = { adx_associatecurrentportaluser: true, adx_targetentityportaluserlookupattribute: 'creatorid' };
  const schema = {
    entity: 'request',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'otherid', type: 'lookup' },
    ],
    currentUserAssociationField: { name: 'creatorid', type: 'lookup' },
  };
  const portal = {
    records: [],
    forms: [{ id: 'create', mode: 100000000, metadata }],
    advancedForms: [{ id: 'wizard', metadata: { adx_startnewsessiononload: false } }],
  };
  return {
    store,
    portal,
    identity,
    sessions: createWebFormSessions(),
    schemas: {
      create: schema,
      wizard: { initialStepId: 'one', steps: [{ ...schema, stepId: 'one', mode: 100000000, metadata }] },
    },
  };
}

test('configured basic and advanced form stamps save without visitor Append or Contact grants', async () => {
  const options = await fixture();
  for (const [kind, id, body] of [
    ['entityform', 'create', { values: { title: 'Basic' } }],
    ['webform', 'wizard', { stepId: 'one', values: { title: 'Advanced' } }],
  ]) {
    const saved = await submitPortalForm(kind, id, body, options);
    assert.equal(saved.record.creatorid.id, 'current');
  }
  assert.equal(options.store.state.tables.request.length, 2);
  await assert.rejects(
    options.store.create('request', { title: 'Explicit', 'creator@odata.bind': '/contacts(current)' }, identity),
    { code: 'PermissionDenied' },
  );
  await assert.rejects(
    submitPortalForm('entityform', 'create', { values: { title: 'Foreign client', creatorid: 'foreign' } }, options),
    { code: 'FormFieldNotBound' },
  );
  await assert.rejects(
    submitPortalForm(
      'entityform',
      'create',
      { values: { title: 'Other lookup', 'other@odata.bind': '/contacts(foreign)' } },
      options,
    ),
    { code: 'PermissionDenied' },
  );
  assert.equal(options.store.state.tables.request.length, 2);
});

test('current-contact stamp retains Create denial, target existence, and plugin binding checks', async () => {
  const options = await fixture();
  await assert.rejects(
    submitPortalForm(
      'entityform',
      'create',
      { values: { title: 'No role' } },
      { ...options, identity: { contactId: 'current', roles: [] } },
    ),
    { code: 'PermissionDenied' },
  );
  options.store.state.plugins = [
    {
      entity: 'request',
      operations: ['create'],
      set: { creatorid: { op: 'reference', args: ['contact', 'foreign'] } },
    },
  ];
  await assert.rejects(
    submitPortalForm('entityform', 'create', { values: { title: 'Plugin changes creator' } }, options),
    { code: 'PermissionDenied' },
  );
  options.store.state.plugins = [];
  options.store.state.tables.contact = [{ contactid: 'foreign' }];
  await assert.rejects(
    submitPortalForm('entityform', 'create', { values: { title: 'Missing current contact' } }, options),
    { code: 'InvalidLookup' },
  );
  assert.deepEqual(options.store.state.tables.request, []);
});

test('configured current-contact stamps bind the resolved logical table behind an accepted entity-set alias', async () => {
  const options = await fixture();
  options.schemas.create.entity = 'requests';
  const saved = await submitPortalForm('entityform', 'create', { values: { title: 'Alias-backed form' } }, options);
  assert.equal(saved.record.creatorid.id, 'current');
  assert.equal(options.store.state.tables.request.length, 1);
  await assert.rejects(
    options.store.create(
      'requests',
      { title: 'Ordinary alias binding', 'creator@odata.bind': '/contacts(current)' },
      identity,
    ),
    { code: 'PermissionDenied' },
  );
  assert.equal(options.store.state.tables.request.length, 1);
});

test('ordinary on-save contact metadata does not acquire the configured association exception', async () => {
  const options = await fixture();
  options.portal.forms[0].metadata = {};
  options.schemas.create.fields.push({ name: 'creatorid', type: 'lookup' });
  options.portal.records.push({
    kind: 'basicformmetadata',
    adx_entityform: 'create',
    adx_attributelogicalname: 'creatorid',
    adx_setvalueonsave: true,
    adx_onsavetype: 100000002,
    adx_onsavefromattribute: 'contactid',
  });
  await assert.rejects(submitPortalForm('entityform', 'create', { values: { title: 'Other metadata' } }, options), {
    code: 'PermissionDenied',
  });
  assert.deepEqual(options.store.state.tables.request, []);
});

test('the root form association scope cannot authorize nested creates or a later request', async () => {
  const { store } = await fixture();
  await assert.rejects(
    withNativeFormContactAssociation({ entity: 'request', column: 'creatorid', contactId: 'current' }, () =>
      store.transact(
        () =>
          store.createRecordAsync(
            'request',
            {
              title: 'Root',
              'creator@odata.bind': '/contacts(current)',
              parent: { title: 'Nested', 'creator@odata.bind': '/contacts(current)' },
            },
            identity,
          ),
        { incremental: true },
      ),
    ),
    { code: 'PermissionDenied' },
  );
  assert.deepEqual(store.state.tables.request, []);
  await assert.rejects(
    store.create('request', { title: 'Later', 'creator@odata.bind': '/contacts(current)' }, identity),
    { code: 'PermissionDenied' },
  );
});
