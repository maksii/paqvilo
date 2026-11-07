// Simulated Dataverse column (field) security: profile matrix, team profiles, field sharing, administrator bypass,
// write errors, aliased projection, aggregates, api.fieldSecurity and RetrievePrincipalAttributePrivileges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createModelDrivenRecordService } from '../lib/dataverse-model-driven.mjs';
import { createPrincipals, ensureSecurityModel, uuidV5 } from '../lib/dataverse-security.mjs';
import {
  ensureFieldSecurity,
  fieldSecurity,
  isSecuredField,
  SYSTEM_ADMINISTRATOR_PROFILE_ID,
} from '../lib/dataverse-fls.mjs';

const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const BASIC_OID = 'aaaaaaaa-0000-4000-8000-000000000002';
const OUTSIDER_OID = 'aaaaaaaa-0000-4000-8000-000000000003';
const NOROLE_OID = 'aaaaaaaa-0000-4000-8000-000000000004';
const TEAM = 'bbbbbbbb-0000-4000-8000-000000000001';
const PROFILE = 'dddddddd-0000-4000-8000-000000000001';
const TEAM_PROFILE = 'dddddddd-0000-4000-8000-000000000002';
const W1 = 'cccccccc-0000-4000-8000-000000000001';
const W2 = 'cccccccc-0000-4000-8000-000000000002';
const MGR = 'eeeeeeee-0000-4000-8000-000000000001';
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [
    { objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] },
    { objectId: BASIC_OID, upn: 'basic@example.test', displayName: 'Basic', roles: ['Basic User'] },
    { objectId: OUTSIDER_OID, upn: 'outsider@example.test', displayName: 'Outsider', roles: ['Basic User'] },
    { objectId: NOROLE_OID, upn: 'norole@example.test', displayName: 'No role', roles: [] },
  ],
};
const ANNOTATION = 'secret@OData.Community.Display.V1.FormattedValue';
const MGR_ANNOTATION = '_manager_value@OData.Community.Display.V1.FormattedValue';

const text = { dataverseType: 'nvarchar' };

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: 'widget',
    entitySet: 'widgets',
    idColumn: 'widgetid',
    nameColumn: 'name',
    fields: {
      name: text,
      secret: { ...text, columnMetadata: { isSecured: true } },
      grade: { ...text, dataverseMetadata: { isSecured: true } },
      label: { ...text, columnMetadata: { isSecured: true }, dataverseMetadata: { isSecured: false } },
      manager: { dataverseType: 'lookup', columnMetadata: { isSecured: true } },
    },
  };
  state.tables.widget = [
    { widgetid: W1, name: 'w1', secret: 's1', grade: 'A', label: 'x', _manager_value: MGR },
    { widgetid: W2, name: 'w2', secret: 's2', grade: 'B', label: 'y', _manager_value: MGR },
  ];
  return state;
}

async function setup(metadataFields) {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const ops = [],
    hooks = {};
  // Runtime shape: settings.organizationId is null; install reads the GUID from the organization row.
  const api = {
    store,
    principals,
    metadataFields,
    settings: { ...SETTINGS, organizationId: null },
    change: (fn) => fn(),
    registry: { register: (op) => ops.push(op) },
    recordHooks: {
      add: (n, fn) => {
        hooks[n] = fn;
      },
    },
  };
  await fieldSecurity.install(api);
  const add = (table, row) => store.transact(() => store.state.tables[table].push(row));
  const mapping = store.state.mappings.widget;
  const user = (oid) => principals.byObjectId(oid);
  const formatted = (id) => ({
    widgetid: id,
    name: 'w',
    secret: 's1',
    [ANNOTATION]: 's1',
    grade: 'A',
    label: 'x',
    _manager_value: MGR,
    [MGR_ANNOTATION]: 'Bob',
  });
  const grant = (flags) =>
    add('fieldpermission', {
      fieldpermissionid: randomUUID(),
      fieldsecurityprofileid: { id: PROFILE },
      entityname: 'widget',
      attributelogicalname: 'secret',
      cancreate: 0,
      canread: 0,
      canupdate: 0,
      canreadunmasked: 0,
      ...flags,
    });
  const write = (operation, u, data, existing) =>
    hooks.beforeWrite({ user: u, target: existing ? { id: existing.widgetid } : undefined }, mapping, {
      operation,
      data,
      existing,
    });
  const project = (u, row) => {
    hooks.project({ user: u }, mapping, row);
    return row;
  };
  // Lookups name systemuser GUIDs, not the Entra object ids the settings use.
  const sid = (oid) => principals.byObjectId(oid).systemuserid;
  return { store, principals, api, ops, hooks, add, grant, user, sid, formatted, write, project, mapping };
}

test('source-only secured metadata governs root, linked, aggregate and write paths without portal Webapi mappings', async () => {
  const source = {
    secret: { dataverseType: 'nvarchar', isSecured: true },
    manager: { dataverseType: 'lookup', isSecured: true },
  };
  const t = await setup((logical) => (logical === 'widget' ? source : undefined));
  delete t.mapping.fields.secret;
  delete t.mapping.fields.manager;
  const basic = t.user(BASIC_OID);
  assert.equal(t.project(basic, t.formatted(W1)).secret, null);
  assert.equal(t.api.fieldSecurity.canWrite(basic, 'widget', 'secret', 'create'), false);
  assert.throws(
    () => t.write('update', basic, { secret: 'Denied' }, t.store.tableRows('widget')[0]),
    (error) => error.status === 403,
  );
  assert.equal(
    t.api.fieldSecurity.mask(
      basic,
      'widget',
      { 'linked.widgetid': W1, 'linked.secret': 'Hidden' },
      { prefix: 'linked.' },
    )['linked.secret'],
    null,
  );
  assert.throws(
    () => t.api.fieldSecurity.assertAggregate({ user: basic }, t.mapping, ['secret']),
    (error) => error.status === 403,
  );
  t.mapping.fields.secret = { dataverseMetadata: { IsSecured: false } };
  assert.equal(
    t.api.fieldSecurity.canRead(basic, 'widget', 'secret'),
    true,
    'Explicit runtime security overrides remain authoritative.',
  );
});

test('catalogue field rights reuse one metadata snapshot and immediately recheck changed security', async () => {
  let calls = 0;
  const source = { source_secret: { isSecured: true } };
  const f = await setup(() => {
    calls++;
    return source;
  });
  const basic = f.user(BASIC_OID),
    admin = f.user(ADMIN_OID),
    fields = ['name', 'secret', 'grade', 'label', 'manager', 'source_secret'];
  for (const user of [basic, admin]) {
    calls = 0;
    const bulk = f.api.fieldSecurity.capabilities(user, 'widget', fields, W1);
    assert.equal(calls, 1, 'One table metadata read, irrespective of field count or rights.');
    for (const name of fields)
      assert.deepEqual(bulk[name], {
        read: f.api.fieldSecurity.canRead(user, 'widget', name, W1),
        create: f.api.fieldSecurity.canWrite(user, 'widget', name, 'create'),
        update: f.api.fieldSecurity.canWrite(user, 'widget', name, 'update', W1),
      });
  }
  await f.add('systemuserprofiles', {
    systemuserprofileid: randomUUID(),
    systemuserid: f.sid(BASIC_OID),
    fieldsecurityprofileid: PROFILE,
  });
  await f.grant({ canread: 4 });
  assert.deepEqual(f.api.fieldSecurity.capabilities(basic, 'widget', ['secret']).secret, {
    read: true,
    create: false,
    update: false,
  });
  await f.store.transact(() => {
    f.store.state.tables.fieldpermission[0].canread = 0;
  });
  assert.equal(f.api.fieldSecurity.capabilities(basic, 'widget', ['secret']).secret.read, false);
  source.source_secret.isSecured = false;
  assert.equal(f.api.fieldSecurity.capabilities(basic, 'widget', ['source_secret']).source_secret.read, true);
});

test('wide model-driven capabilities derive source metadata once per table and recheck source security', async () => {
  let calls = 0;
  const source = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [
      'column' + index,
      { dataverseType: 'nvarchar', isSecured: index === 0 },
    ]),
  );
  const f = await setup(() => {
    calls++;
    return source;
  });
  const fields = { ...source };
  const service = createModelDrivenRecordService({
    organization: { store: f.store, principals: f.principals, api: f.api },
    principal: () => f.user(BASIC_OID),
  });
  calls = 0;
  const before = service.capabilities('widget', {}, { fields });
  assert.ok(calls <= 2, `Expected at most two table metadata derivations, received ${calls}`);
  assert.equal(before.fields.column0.secured, true);
  assert.equal(before.fields.column0.read, false);
  const compact = service.capabilities('widget', {}, { fields, compact: true });
  assert.deepEqual(compact, before);
  assert.equal(JSON.stringify(compact), JSON.stringify(before));
  assert.ok(new Set(Object.values(compact.fields)).size <= 2, 'Private export rights reuse only boolean combinations.');
  assert.ok(Object.isFrozen(compact.fields.column1));
  assert.notEqual(before.fields.column1, before.fields.column2, 'Public field rights remain independently mutable.');
  const raw = f.api.fieldSecurity.capabilities(f.user(BASIC_OID), 'widget', ['column1', 'column2']);
  assert.notEqual(raw.column1, raw.column2, 'Public field-security API retains separate values.');
  source.column0 = { dataverseType: 'nvarchar', isSecured: false };
  calls = 0;
  const after = service.capabilities('widget', {}, { fields });
  assert.ok(calls <= 2);
  assert.equal(after.fields.column0.secured, false);
  assert.equal(after.fields.column0.read, after.read);
});

test('seeds dataverse-only field security mappings and the System Administrator profile once', async () => {
  const { store } = await setup();
  await ensureFieldSecurity(store);
  for (const logical of [
    'fieldsecurityprofile',
    'fieldpermission',
    'systemuserprofiles',
    'teamprofiles',
    'principalobjectattributeaccess',
  ]) {
    assert.equal(store.state.mappings[logical].dataverseOnly, true, logical);
    assert.equal(store.state.mappings[logical].userConfigured, true, logical);
  }
  const profiles = store
    .tableRows('fieldsecurityprofile')
    .filter((p) => p.fieldsecurityprofileid === SYSTEM_ADMINISTRATOR_PROFILE_ID);
  assert.equal(profiles.length, 1);
});

test('install seeds the field security tables itself and exposes api.fieldSecurity', async () => {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  const ops = [];
  const api = {
    store,
    principals: createPrincipals(store, SETTINGS),
    settings: SETTINGS,
    change: (fn) => fn(),
    registry: { register: (op) => ops.push(op) },
    recordHooks: { add() {} },
  };
  await fieldSecurity.install(api);
  assert.equal(store.state.mappings.fieldpermission.dataverseOnly, true);
  assert.equal(
    store.tableRows('fieldsecurityprofile').filter((p) => p.fieldsecurityprofileid === SYSTEM_ADMINISTRATOR_PROFILE_ID)
      .length,
    1,
  );
  assert.deepEqual(ops.map((o) => o.entity).sort(), ['systemuser', 'team']);
  assert.deepEqual(Object.keys(api.fieldSecurity).sort(), [
    'assertAggregate',
    'canRead',
    'canWrite',
    'capabilities',
    'diagnostics',
    'mask',
    'maskValue',
    'maskedFor',
    'maskedOperand',
    'rowMask',
  ]);
});

test('IsSecured is read from either spelling and an { Value } wrapper; dataverseMetadata overrides columnMetadata', () => {
  assert.equal(isSecuredField({ dataverseMetadata: { IsSecured: true } }), true);
  assert.equal(isSecuredField({ dataverseMetadata: { IsSecured: { Value: true } } }), true);
  assert.equal(
    isSecuredField({ dataverseMetadata: { IsSecured: { Value: false } }, columnMetadata: { isSecured: true } }),
    false,
  );
  assert.equal(isSecuredField({ dataverseMetadata: { isSecured: false }, columnMetadata: { IsSecured: true } }), false);
  assert.equal(isSecuredField({ columnMetadata: { IsSecured: true } }), true);
  assert.equal(isSecuredField({ columnMetadata: { isSecured: true } }), true);
  assert.equal(
    isSecuredField({ isSecured: true }),
    true,
    'Provenance-free Solution mappings retain their source security flag.',
  );
  assert.equal(
    isSecuredField({ isSecured: true, dataverseMetadata: { IsSecured: false } }),
    false,
    'An explicit API metadata override still wins.',
  );
  assert.equal(isSecuredField({ name: 'plain' }), false);
});

test('profile matrix: a secured column reads as null without canread and keeps its value with canread 4', async () => {
  const t = await setup();
  const basic = t.user(BASIC_OID);
  // Basic user holds no profile yet: secured, graded and lookup columns are nulled, annotations removed, unsecured kept.
  const denied = t.project(basic, t.formatted(W1));
  assert.equal(denied.secret, null);
  assert.equal(Object.hasOwn(denied, ANNOTATION), false);
  assert.equal(denied.grade, null);
  assert.equal(denied.label, 'x');
  assert.equal(denied.name, 'w');
  assert.equal(denied._manager_value, null);
  assert.equal(Object.hasOwn(denied, MGR_ANNOTATION), false);
  // A profile with canread 4 on secret and manager, linked to the basic user.
  await t.add('fieldsecurityprofile', { fieldsecurityprofileid: PROFILE, name: 'Reader' });
  await t.add('systemuserprofiles', {
    systemuserprofileid: randomUUID(),
    systemuserid: { id: t.sid(BASIC_OID) },
    fieldsecurityprofileid: { id: PROFILE },
  });
  await t.grant({ canread: 4 });
  await t.grant({ attributelogicalname: 'grade', canread: 0 });
  await t.grant({ attributelogicalname: 'manager', canread: 4 });
  const allowed = t.project(basic, t.formatted(W1));
  assert.equal(allowed.secret, 's1');
  assert.equal(allowed[ANNOTATION], 's1');
  assert.equal(allowed.grade, null);
  assert.equal(allowed._manager_value, MGR);
  assert.equal(allowed[MGR_ANNOTATION], 'Bob');
});

test('source fieldMetadata security survives provenance removal and thin explicit field definitions', async () => {
  const t = await setup(),
    basic = t.user(BASIC_OID);
  t.mapping.fieldMetadata = { secret: { dataverseType: 'nvarchar', isSecured: true } };
  t.mapping.fields = { secret: { dataverseType: 'nvarchar' } };
  assert.equal(t.project(basic, t.formatted(W1)).secret, null);
  assert.throws(
    () => t.write('update', basic, { secret: 'Denied' }, { widgetid: W1 }),
    (error) => error.status === 403,
  );
  assert.equal(t.api.fieldSecurity.canRead(basic, 'widget', 'secret'), false);
  t.mapping.fields.secret.dataverseMetadata = { IsSecured: false };
  assert.equal(
    t.api.fieldSecurity.canRead(basic, 'widget', 'secret'),
    true,
    'An explicit metadata override remains authoritative.',
  );
});

test('team profiles reach the members of the team and nobody else', async () => {
  const t = await setup();
  await t.add('teamprofiles', {
    teamprofileid: randomUUID(),
    teamid: { id: TEAM },
    fieldsecurityprofileid: { id: TEAM_PROFILE },
  });
  await t.add('fieldsecurityprofile', { fieldsecurityprofileid: TEAM_PROFILE, name: 'Team reader' });
  await t.add('teammembership', {
    teammembershipid: randomUUID(),
    systemuserid: { id: t.sid(BASIC_OID) },
    teamid: { id: TEAM },
  });
  await t.add('fieldpermission', {
    fieldpermissionid: randomUUID(),
    fieldsecurityprofileid: { id: TEAM_PROFILE },
    entityname: 'widget',
    attributelogicalname: 'secret',
    canread: 4,
    cancreate: 0,
    canupdate: 0,
    canreadunmasked: 0,
  });
  assert.equal(t.project(t.user(BASIC_OID), t.formatted(W1)).secret, 's1');
  assert.equal(t.project(t.user(OUTSIDER_OID), t.formatted(W1)).secret, null);
});

test('field sharing grants read to one record and the principal named in the share only', async () => {
  const t = await setup();
  const basic = t.user(BASIC_OID);
  await t.add('principalobjectattributeaccess', {
    principalobjectattributeaccessid: randomUUID(),
    objectid: { id: W1 },
    attributeid: uuidV5(ORG, 'attribute:widget:secret'),
    principalid: { id: t.sid(BASIC_OID) },
    readaccess: true,
    updateaccess: false,
  });
  assert.equal(t.project(basic, t.formatted(W1)).secret, 's1');
  assert.equal(t.project(basic, t.formatted(W2)).secret, null);
  assert.equal(t.project(t.user(OUTSIDER_OID), t.formatted(W1)).secret, null);
});

test('writes: create needs cancreate, update needs canupdate or an update share, errors carry the inner codes', async () => {
  const t = await setup();
  const basic = t.user(BASIC_OID);
  const w1 = t.store.tableRows('widget')[0];
  assert.throws(
    () => t.write('create', basic, { secret: 'x' }),
    (e) => {
      assert.equal(e.status, 403);
      assert.equal(e.details.innerCode, '0x8004f502');
      assert.match(e.message, /does not have create permissions to a secret secured field on entity widget/);
      return true;
    },
  );
  assert.throws(
    () => t.write('update', basic, { secret: 'x' }, w1),
    (e) => e.details.innerCode === '0x8004f507',
  );
  // A secured lookup written through its @odata.bind form needs the same permission.
  assert.throws(
    () => t.write('create', basic, { 'manager@odata.bind': '/systemusers(x)' }),
    (e) => e.details.innerCode === '0x8004f502',
  );
  // Writes without secured keys never need a permission.
  t.write('create', basic, { name: 'fine' });
  await t.add('fieldsecurityprofile', { fieldsecurityprofileid: PROFILE, name: 'Editor' });
  await t.add('systemuserprofiles', {
    systemuserprofileid: randomUUID(),
    systemuserid: { id: t.sid(BASIC_OID) },
    fieldsecurityprofileid: { id: PROFILE },
  });
  await t.grant({ cancreate: 4, canupdate: 4 });
  t.write('create', basic, { secret: 'x' });
  t.write('update', basic, { secret: 'x' }, w1);
  // An update share with updateaccess passes on its record only.
  await t.add('principalobjectattributeaccess', {
    principalobjectattributeaccessid: randomUUID(),
    objectid: { id: W2 },
    attributeid: uuidV5(ORG, 'attribute:widget:secret'),
    principalid: { id: t.sid(BASIC_OID) },
    readaccess: false,
    updateaccess: true,
  });
  const w2 = t.store.tableRows('widget')[1];
  assert.throws(
    () => t.write('update', t.user(OUTSIDER_OID), { secret: 'x' }, w2),
    (e) => e.details.innerCode === '0x8004f507',
  );
  t.write('update', basic, { secret: 'x' }, w2);
});

test('System Administrator users bypass every secured column', async () => {
  const t = await setup();
  const admin = t.user(ADMIN_OID);
  assert.equal(t.project(admin, t.formatted(W1)).secret, 's1');
  t.write('create', admin, { secret: 'x' });
  t.write('update', admin, { secret: 'x' }, t.store.tableRows('widget')[0]);
});

test('RetrievePrincipalAttributePrivileges reports the profile permissions and checks the caller can read the principal', async () => {
  const t = await setup();
  const op = (kind) => t.ops.find((o) => o.name === 'RetrievePrincipalAttributePrivileges' && o.entity === kind);
  const call = (kind, id, caller) => op(kind).handle({ user: caller, target: { mapping: { logicalName: kind }, id } });
  assert.ok(op('systemuser') && op('team'));
  await t.add('fieldsecurityprofile', { fieldsecurityprofileid: PROFILE, name: 'Editor' });
  await t.add('systemuserprofiles', {
    systemuserprofileid: randomUUID(),
    systemuserid: { id: t.sid(BASIC_OID) },
    fieldsecurityprofileid: { id: PROFILE },
  });
  await t.grant({ canread: 4, cancreate: 4, canreadunmasked: 1 });
  // Own record: no read check. Its AttributeId derives from the organization row, not settings.organizationId (null).
  const body = call('systemuser', t.sid(BASIC_OID), t.user(BASIC_OID)).body;
  assert.deepEqual(body.AttributePrivileges, [
    {
      AttributeId: uuidV5(ORG, 'attribute:widget:secret'),
      CanCreate: 4,
      CanRead: 4,
      CanReadUnMasked: 1,
      CanUpdate: 0,
    },
  ]);
  // An administrator reads any principal.
  assert.deepEqual(call('systemuser', t.sid(OUTSIDER_OID), t.user(ADMIN_OID)).body.AttributePrivileges, []);
  assert.deepEqual(call('team', TEAM, t.user(ADMIN_OID)).body.AttributePrivileges, []);
  // A caller without roles cannot read another principal's field permissions.
  assert.throws(
    () => call('systemuser', t.sid(BASIC_OID), t.user(NOROLE_OID)),
    (e) => e.status === 403,
  );
});

test('api.fieldSecurity.mask copies a row; canRead and canWrite follow the same grants', async () => {
  const t = await setup();
  const { mask, canRead, canWrite } = t.api.fieldSecurity;
  const basic = t.user(BASIC_OID),
    admin = t.user(ADMIN_OID);
  const row = t.formatted(W1);
  const masked = mask(basic, 'widget', row);
  assert.notEqual(masked, row);
  assert.equal(masked.secret, null);
  assert.equal(masked._manager_value, null);
  assert.equal(Object.hasOwn(masked, MGR_ANNOTATION), false);
  assert.equal(masked.name, 'w');
  assert.equal(row.secret, 's1', 'the source row is not mutated');
  assert.equal(mask(admin, 'widget', row).secret, 's1');
  assert.deepEqual(mask(basic, 'nosuch', { a: 1 }), { a: 1 });
  assert.equal(canRead(basic, 'widget', 'secret'), false);
  assert.equal(canRead(basic, 'widget', 'name'), true);
  assert.equal(canRead(basic, 'widget', 'nosuch'), true);
  assert.equal(canWrite(basic, 'widget', 'secret', 'create'), false);
  assert.equal(canWrite(basic, 'widget', 'name', 'create'), true);
  // A field share on W1 grants read on that record only, and only when the record id is named.
  await t.add('principalobjectattributeaccess', {
    principalobjectattributeaccessid: randomUUID(),
    objectid: { id: W1 },
    attributeid: uuidV5(ORG, 'attribute:widget:secret'),
    principalid: { id: t.sid(BASIC_OID) },
    readaccess: true,
    updateaccess: false,
  });
  assert.equal(canRead(basic, 'widget', 'secret', W1), true);
  assert.equal(canRead(basic, 'widget', 'secret', W2), false);
  assert.equal(canRead(basic, 'widget', 'secret'), false);
});

test('aliased link columns are masked by prefix and secured aggregates are refused', async () => {
  const t = await setup();
  const { mask, assertAggregate } = t.api.fieldSecurity;
  const basic = t.user(BASIC_OID);
  const linked = mask(
    basic,
    'widget',
    {
      'w2.widgetid': W2,
      'w2.secret': 'S3CRET',
      'w2.name': 'n',
      'w2._manager_value': MGR,
      [`w2._manager_value@OData.Community.Display.V1.FormattedValue`]: 'Bob',
    },
    { prefix: 'w2.' },
  );
  assert.equal(linked['w2.secret'], null);
  assert.equal(linked['w2.name'], 'n');
  assert.equal(linked['w2._manager_value'], null);
  assert.equal(
    Object.keys(linked).some((k) => k.includes('@')),
    false,
  );
  assert.throws(
    () => assertAggregate({ user: basic }, t.mapping, ['secret']),
    (e) => e.status === 403 && e.details.innerCode === '0x8004f508',
  );
  assert.doesNotThrow(() => assertAggregate({ user: basic }, t.mapping, ['name']));
  assert.doesNotThrow(() => assertAggregate({ user: t.user(ADMIN_OID) }, t.mapping, ['secret']));
});

test('reset(api) re-seeds the field security tables and the System Administrator profile after a wipe', async () => {
  const t = await setup();
  delete t.store.state.mappings.fieldpermission;
  delete t.store.state.tables.fieldsecurityprofile;
  await fieldSecurity.reset(t.api);
  assert.equal(t.store.state.mappings.fieldpermission.dataverseOnly, true);
  assert.equal(
    t.store.state.tables.fieldsecurityprofile.filter(
      (p) => p.fieldsecurityprofileid === SYSTEM_ADMINISTRATOR_PROFILE_ID,
    ).length,
    1,
  );
});
