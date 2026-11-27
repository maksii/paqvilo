// @test-kind compatibility: Associate Current Portal User with Is Activity Party (https://learn.microsoft.com/power-pages/configure/basic-forms#basic-form-attributes-and-relationships, https://learn.microsoft.com/power-pages/configure/load-form-step#associate-the-current-portal-user-with-the-creation-of-a-record) stores the contact as an activityparty row whose participationtypemask is the documented party type of the column (https://learn.microsoft.com/power-apps/developer/data-platform/activityparty-entity); invented schema
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { submitPortalForm, createWebFormSessions } from '../lib/form-service.mjs';
import { recordToSdkEntity } from '../lib/plugin-clr.mjs';
import { sdkValueToRecord } from '../lib/local-organization-service.mjs';

const CONTACT = '0a5e0000-0000-4000-8000-000000000001';
// The party list columns of an invented custom activity and the party type the Learn table gives each column.
const DOCUMENTED = {
  from: 1,
  to: 2,
  cc: 3,
  bcc: 4,
  requiredattendees: 5,
  optionalattendees: 6,
  organizer: 7,
  resources: 10,
  customers: 11,
  related: 13,
};
const partyList = (name, targets) => ({
  name,
  dataverseType: 'partylist',
  type: 'lookup',
  ...(targets ? { targets } : {}),
});

async function setup({ relationships = false, plugins = [] } = {}) {
  const store = await new DataStore({
    state: {
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid' },
        new_visit: { entitySet: 'new_visits', idColumn: 'activityid' },
        activityparty: {
          entitySet: 'activityparties',
          idColumn: 'activitypartyid',
          ...(relationships
            ? {
                relationships: {
                  activityid_new_visit: { entity: 'new_visit', from: 'activityid', to: 'activityid', many: false },
                  partyid_contact: { entity: 'contact', from: 'partyid', to: 'contactid', many: false },
                },
              }
            : {}),
        },
      },
      tables: { contact: [{ contactid: CONTACT, fullname: 'Party contact' }], new_visit: [], activityparty: [] },
      settings: { permissionMode: 'enforce' },
      // The visitor creates the activity; no table permission names activityparty or contact.
      permissions: [{ entity: 'new_visit', scope: 'global', roles: ['Visitor'], operations: ['create', 'read'] }],
      plugins,
    },
  }).init();
  const fields = Object.fromEntries(Object.keys(DOCUMENTED).map((name) => [name, partyList(name)]));
  fields.partners = partyList('partners');
  fields.new_lookup = { name: 'new_lookup', dataverseType: 'lookup', type: 'lookup' };
  return {
    store,
    portal: { forms: [{ id: 'visit', mode: 100000000 }] },
    schemas: { visit: { entity: 'new_visit', fields: [{ name: 'subject' }] } },
    metadata: { entities: { new_visit: { fields } } },
    identity: { id: 'visitor', contactId: CONTACT, roles: ['Visitor'] },
    sessions: createWebFormSessions(),
  };
}

function configure(options, column) {
  options.portal.forms[0].metadata = {
    adx_associatecurrentportaluser: true,
    adx_portaluserlookupattribute: column,
    adx_portaluserlookupattributeisactivityparty: true,
  };
}

const submit = (options, values = { subject: 'Visit' }) => submitPortalForm('entityform', 'visit', { values }, options);

for (const relationships of [false, true]) {
  test(`each party list column records its documented participation type (${relationships ? 'navigations' : 'entity references'})`, async () => {
    const options = await setup({ relationships });
    for (const [column, mask] of Object.entries(DOCUMENTED)) {
      configure(options, column);
      const saved = await submit(options);
      const parties = options.store
        .snapshot()
        .tables.activityparty.filter((row) => String(row.activityid?.id ?? row.activityid) === saved.recordId);
      assert.equal(parties.length, 1, column);
      assert.equal(parties[0].participationtypemask, mask, column);
      assert.equal(String(parties[0].partyid?.id ?? parties[0].partyid).toLowerCase(), CONTACT, column);
      assert.equal(
        options.store.snapshot().tables.new_visit.some((row) => row.activityid === saved.recordId),
        true,
      );
    }
  });
}

test('the participation type must be an option of activityparty.participationtypemask when the model has it', async () => {
  const options = await setup();
  options.store.state.mappings.activityparty.fields = {
    participationtypemask: {
      name: 'participationtypemask',
      dataverseType: 'picklist',
      options: [{ value: 1 }, { value: 2 }],
    },
  };
  configure(options, 'to');
  assert.equal((await submit(options)).operation, 'create');
  configure(options, 'cc');
  const before = options.store.snapshot();
  await assert.rejects(
    submit(options),
    (error) => error.code === 'FormUserAssociationUnresolved' && error.status === 501,
  );
  assert.deepEqual(options.store.snapshot(), before);
});

// @test-kind unproven: native rollback of a failed activityparty write inside the form save is not captured; the local model writes the record and its party row as one unit
test('a failing party row write leaves neither the activity nor a party row', async () => {
  // The relationship check refuses a party row whose contact does not exist.
  const options = await setup({ relationships: true });
  configure(options, 'to');
  const before = options.store.snapshot();
  options.identity = { ...options.identity, contactId: '0a5e0000-0000-4000-8000-0000000000ff' };
  await assert.rejects(submit(options, { subject: 'Orphan' }), (error) => error.nativeFormWriteFailure === true);
  assert.deepEqual(options.store.snapshot(), before);
});

// @test-kind observation: hosted F2 (paqvilo-developer hosted-f2 runs a and b, group visit, ten party list columns of a custom activity): the basic form insert sends one Create, of the activity, whose Target carries the party list column as activityparty entities holding only the contact; the stored parties are the contact with the column's participation type (partners: 12, "Chat Participant") and the activity owner with the Owner type 9; no activityparty Create reaches the pipeline
test('the party list column travels in the Create Target and the owner party is added', async () => {
  const OWNER = '0a5e0000-0000-4000-8000-0000000000a1';
  const options = await setup({ relationships: true });
  options.store.state.mappings.systemuser = { entitySet: 'systemusers', idColumn: 'systemuserid' };
  options.store.state.tables.systemuser = [{ systemuserid: OWNER, fullname: '# Portals-invented' }];
  options.store.state.mappings.activityparty.relationships.partyid_systemuser = {
    entity: 'systemuser',
    from: 'partyid',
    to: 'systemuserid',
    many: false,
  };
  options.store.state.mappings.new_visit.recordDefaults = { ownerid: { id: OWNER, logical_name: 'systemuser' } };
  const seen = [];
  options.store.setPluginPipeline((context) => {
    if (context.stage === 10)
      seen.push({ message: context.operation, entity: context.entity, target: structuredClone(context.target) });
  });
  for (const [column, mask] of [
    ['partners', 12],
    ['to', 2],
  ]) {
    configure(options, column);
    seen.length = 0;
    const saved = await submit(options, { subject: `Visit ${column}` });
    assert.deepEqual(
      seen.map((entry) => `${entry.message} ${entry.entity}`),
      ['create new_visit'],
      column,
    );
    assert.deepEqual(seen[0].target[column], [{ partyid: { id: CONTACT, logical_name: 'contact' } }], column);
    // The SDK Target: Entity[] of activityparty entities, each with only partyid (no participationtypemask, empty id).
    const sdk = recordToSdkEntity(options.store, 'new_visit', seen[0].target, { allColumns: true, target: true });
    assert.equal(sdk.attributes[column].$type, 'SdkArray', column);
    // A CLR step's Target comes back as the same party rows.
    assert.deepEqual(sdkValueToRecord(sdk.attributes[column]), [{ partyid: { id: CONTACT, logical_name: 'contact' } }]);
    assert.equal(sdk.attributes[column].elementType, 'Entity', column);
    assert.deepEqual(
      sdk.attributes[column].values.map((party) => [party.logicalName, party.id, Object.keys(party.attributes)]),
      [['activityparty', '00000000-0000-0000-0000-000000000000', ['partyid']]],
      column,
    );
    assert.deepEqual(
      [
        sdk.attributes[column].values[0].attributes.partyid.logicalName,
        sdk.attributes[column].values[0].attributes.partyid.id,
      ],
      ['contact', CONTACT],
    );
    const stored = options.store.snapshot().tables.new_visit.find((row) => row.activityid === saved.recordId);
    assert.equal(Object.hasOwn(stored, column), false, `${column} is not a stored column`);
    assert.deepEqual(
      options.store
        .snapshot()
        .tables.activityparty.filter((row) => row.activityid?.id === saved.recordId)
        .map((row) => [row.partyid?.logical_name, row.partyid?.id, row.participationtypemask]),
      [
        ['contact', CONTACT, mask],
        ['systemuser', OWNER, 9],
      ],
      column,
    );
  }
});

// @test-kind security: an anonymous visitor cannot be stamped as an activity party, and a visitor cannot post the party list column to name another contact
test('anonymous visitors and posted party values cannot choose the party', async () => {
  const options = await setup();
  configure(options, 'to');
  const before = options.store.snapshot();
  await assert.rejects(
    submit({ ...options, identity: { roles: ['Visitor'] } }),
    (error) => error.code === 'FormSaveContactRequired' && error.status === 401,
  );
  assert.deepEqual(options.store.snapshot(), before);
  // The record write keeps the visitor's table permission check: a contact without Create on the activity writes nothing.
  await assert.rejects(
    submit({ ...options, identity: { ...options.identity, roles: [] } }),
    (error) => error.code === 'PermissionDenied',
  );
  assert.deepEqual(options.store.snapshot(), before);
  options.schemas.visit.fields.push({ name: 'to', type: 'lookup' });
  const other = '0a5e0000-0000-4000-8000-000000000002';
  const saved = await submit(options, { subject: 'Spoof', to: other });
  const parties = options.store.snapshot().tables.activityparty.filter((row) => row.activityid?.id === saved.recordId);
  assert.deepEqual(
    parties.map((row) => [row.partyid?.id, row.participationtypemask]),
    [[CONTACT, 2]],
  );
  assert.equal(saved.record.to, undefined);
});

test('a required party list column on the form is satisfied by the association', async () => {
  const options = await setup();
  configure(options, 'to');
  options.schemas.visit.fields.push({ name: 'to', type: 'lookup', required: true });
  const saved = await submit(options, { subject: 'Required party' });
  assert.equal(saved.operation, 'create');
  assert.equal(saved.record.to, undefined);
  assert.deepEqual(
    options.store
      .snapshot()
      .tables.activityparty.filter((row) => row.activityid?.id === saved.recordId)
      .map((row) => [row.partyid?.id, row.participationtypemask]),
    [[CONTACT, 2]],
  );
  // Other required fields still apply.
  options.schemas.visit.fields[0].required = true;
  await assert.rejects(
    submit(options, {}),
    (error) =>
      error.code === 'FormFieldRequired' && error.details.validationErrors.every((entry) => entry.field === 'subject'),
  );
});

test('columns that are not documented contact party lists are refused before any write', async () => {
  const options = await setup();
  // Email.From-style targets: the column takes queues and users only.
  options.metadata.entities.new_visit.fields.from = partyList('from', ['queue', 'systemuser']);
  const before = options.store.snapshot();
  for (const [column, status, code] of [
    ['new_lookup', 501, 'FormUserAssociationUnsupported'],
    ['from', 400, 'FormUserAssociationInvalid'],
    ['new_absent', 501, 'FormUserAssociationUnresolved'],
  ]) {
    configure(options, column);
    await assert.rejects(submit(options), (error) => error.code === code && error.status === status, column);
  }
  assert.deepEqual(options.store.snapshot(), before);
});

// @test-kind unproven: the hosted permission checks of the party row are not captured; like the current-contact lookup stamp, the local model checks the activity create only and no Append/Append To or activityparty permission
test('the party row needs no visitor permission on activityparty or contact', async () => {
  const options = await setup({ relationships: true });
  options.store.state.settings.associationPermissions = 'enforce';
  configure(options, 'organizer');
  const saved = await submit(options);
  assert.deepEqual(
    options.store
      .snapshot()
      .tables.activityparty.filter((row) => row.activityid?.id === saved.recordId)
      .map((row) => row.participationtypemask),
    [7],
  );
});

// @test-kind contract: without Is Activity Party the configured lookup association is unchanged and writes no party row
test('a lookup association without Is Activity Party writes no activityparty row', async () => {
  const options = await setup();
  options.store.state.mappings.new_visit.relationships = {
    new_visitor: { entity: 'contact', from: 'new_lookup', to: 'contactid', many: false },
  };
  options.schemas.visit.currentUserAssociationField = { name: 'new_lookup', type: 'lookup' };
  options.portal.forms[0].metadata = {
    adx_associatecurrentportaluser: true,
    adx_portaluserlookupattribute: 'new_lookup',
  };
  const saved = await submit(options);
  assert.equal(saved.record.new_lookup.id, CONTACT);
  assert.deepEqual(options.store.snapshot().tables.activityparty, []);
});

// @test-kind unproven: native rollback of a failure after the activity's parties are written is not captured; the parties belong to the record create (no activityparty Create of their own), so a failure later in that create leaves neither the activity nor a party row
test('a failure after the parties are written rolls the activity and its parties back', async () => {
  const options = await setup({ relationships: true });
  configure(options, 'to');
  const before = options.store.snapshot();
  options.store.setPluginPipeline((context) => {
    if (context.entity === 'new_visit' && context.operation === 'create' && context.stage === 40) {
      // The party rows exist inside the create when its PostOperation runs.
      assert.equal(options.store.tableRows('activityparty').length, 1);
      throw Object.assign(new Error('Invented PostOperation refusal'), { status: 400, code: 'PluginValidation' });
    }
  });
  await assert.rejects(submit(options, { subject: 'Refused later' }), (error) => error.nativeFormWriteFailure === true);
  assert.deepEqual(options.store.snapshot(), before);
});
