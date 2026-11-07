// @test-kind unproven: local model of cascade delete and assign behaviour; no native capture cited
// Cascade actions (lib/dataverse-cascade.mjs, dataverse-security.mjs): Assign, Share, Unshare and Reparent execute per
// relationship.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION } from '../lib/dataverse-cascade.mjs';
import { DataError } from '../lib/data-error.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { cascadeMappings, systemUserMapping } from './support/parent-child-tables.mjs';

const PARENT = '55555555-5555-4555-8555-555555555501';
const ACTIVE = '55555555-5555-4555-8555-555555555502';
const INACTIVE = '55555555-5555-4555-8555-555555555503';
const OTHER = '55555555-5555-4555-8555-555555555504';
const GRANDCHILD = '55555555-5555-4555-8555-555555555505';
const USER_ONE = '66666666-6666-4666-8666-666666666601';
const USER_TWO = '66666666-6666-4666-8666-666666666602';
const USER_THREE = '66666666-6666-4666-8666-666666666603';

const owner = (id) => ({ id, logical_name: 'systemuser', name: 'Invented user' });
const parentRef = { id: PARENT, logical_name: 'x_parent', name: 'Invented parent' };

// The parent and its children share one relationship cascade; withGrandchild adds a level below the active child.
function mappingsFor(cascade, { withGrandchild = false } = {}) {
  const mappings = { systemuser: systemUserMapping(), ...cascadeMappings(cascade) };
  if (!withGrandchild) return mappings;
  mappings.x_child.relationships.grandchildren = {
    entity: 'x_grandchild',
    many: true,
    from: 'x_childid',
    to: 'x_childid',
    cascade,
  };
  mappings.x_grandchild = {
    logicalName: 'x_grandchild',
    entitySet: 'x_grandchildren',
    idColumn: 'x_grandchildid',
    nameColumn: 'x_name',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_childid: { dataverseType: 'lookup' },
      ownerid: { dataverseType: 'owner' },
    },
  };
  return mappings;
}

function tablesFor({ withGrandchild = false } = {}) {
  return {
    systemuser: [
      { systemuserid: USER_ONE, fullname: 'Invented one', statecode: 0 },
      { systemuserid: USER_TWO, fullname: 'Invented two', statecode: 0 },
      { systemuserid: USER_THREE, fullname: 'Invented three', statecode: 0 },
    ],
    x_parent: [
      { x_parentid: PARENT, x_name: 'Invented parent', ownerid: owner(USER_ONE), statecode: 0, statuscode: 1 },
    ],
    x_child: [
      {
        x_childid: ACTIVE,
        x_name: 'Active child',
        x_parentid: parentRef,
        ownerid: owner(USER_ONE),
        statecode: 0,
        statuscode: 1,
      },
      {
        x_childid: INACTIVE,
        x_name: 'Inactive child',
        x_parentid: parentRef,
        ownerid: owner(USER_ONE),
        statecode: 1,
        statuscode: 2,
      },
      {
        x_childid: OTHER,
        x_name: 'Other child',
        x_parentid: parentRef,
        ownerid: owner(USER_THREE),
        statecode: 0,
        statuscode: 1,
      },
    ],
    ...(withGrandchild
      ? {
          x_grandchild: [
            {
              x_grandchildid: GRANDCHILD,
              x_name: 'Invented grandchild',
              x_childid: { id: ACTIVE, logical_name: 'x_child', name: 'Active child' },
              ownerid: owner(USER_ONE),
              statecode: 0,
            },
          ],
        }
      : {}),
  };
}

async function setup(t, cascade, { options = {}, extension = EXTENSION, withGrandchild = false } = {}) {
  const diagnostics = [];
  const fixture = await contractModuleFixture(t, {
    mappings: mappingsFor(cascade, { withGrandchild }),
    tables: tablesFor({ withGrandchild }),
    extension,
    options: { diagnostic: (entry) => diagnostics.push(entry), ...options },
  });
  return { ...fixture, diagnostics };
}

// Reassigns the parent through the Web API (records layer, so the write hooks run).
const reassign = (request, json, userId) =>
  request('PATCH', `/x_parents(${PARENT})`, { 'ownerid@odata.bind': `/systemusers(${userId})` }).then((response) =>
    json(response, 200),
  );
const ownerOf = (store, table, idColumn, id) =>
  store.state.tables[table].find((row) => row[idColumn] === id)?.ownerid?.id ?? null;

const CASES = [
  ['Cascade', { assign: 'Cascade' }, { [ACTIVE]: USER_TWO, [INACTIVE]: USER_TWO, [OTHER]: USER_TWO }],
  ['Active', { assign: 'Active' }, { [ACTIVE]: USER_TWO, [INACTIVE]: USER_ONE, [OTHER]: USER_TWO }],
  ['UserOwned', { assign: 'UserOwned' }, { [ACTIVE]: USER_TWO, [INACTIVE]: USER_TWO, [OTHER]: USER_THREE }],
  ['NoCascade', { assign: 'NoCascade' }, { [ACTIVE]: USER_ONE, [INACTIVE]: USER_ONE, [OTHER]: USER_THREE }],
  ['RemoveLink', { assign: 'RemoveLink' }, { [ACTIVE]: USER_ONE, [INACTIVE]: USER_ONE, [OTHER]: USER_THREE }],
];

for (const [name, cascade, expected] of CASES) {
  test(`Assign ${name}: reassigning the parent gives the children the new owner as the cascade allows`, async (t) => {
    const { request, json, store, diagnostics } = await setup(t, cascade);
    await reassign(request, json, USER_TWO);
    assert.equal(ownerOf(store, 'x_parent', 'x_parentid', PARENT), USER_TWO);
    for (const [child, owner] of Object.entries(expected))
      assert.equal(ownerOf(store, 'x_child', 'x_childid', child), owner, `child ${child}`);
    assert.equal(diagnostics.filter((entry) => entry.code === 'CASCADE_ASSIGN_DEFAULTED').length, 0);
  });
}

test('Assign Cascade reaches the grandchildren of the children it reassigns', async (t) => {
  const { request, json, store } = await setup(t, { assign: 'Cascade' }, { withGrandchild: true });
  await reassign(request, json, USER_TWO);
  assert.equal(ownerOf(store, 'x_grandchild', 'x_grandchildid', GRANDCHILD), USER_TWO);
});

test('a write that does not change the owner runs no Assign cascade', async (t) => {
  const { request, json, store } = await setup(t, { assign: 'Cascade' });
  await json(await request('PATCH', `/x_parents(${PARENT})`, { x_name: 'Renamed parent' }), 200);
  assert.equal(ownerOf(store, 'x_child', 'x_childid', ACTIVE), USER_ONE);
  assert.equal(ownerOf(store, 'x_child', 'x_childid', OTHER), USER_THREE);
});

test('a failing afterWrite after the cascade, in the same transaction, rolls the cascaded children back', async (t) => {
  const failing = {
    ...EXTENSION,
    install: (api, options) => {
      EXTENSION.install(api, options);
      // Installed after the cascade, so it runs after it in the same write's transaction.
      api.recordHooks.add('afterWrite', (c, mapping) => {
        if (mapping.logicalName === 'x_parent')
          throw new DataError('Invented refusal after the cascade.', 400, 'InvalidRequest');
      });
    },
  };
  const { request, json, store } = await setup(t, { assign: 'Cascade' }, { extension: failing });
  await json(
    await request('PATCH', `/x_parents(${PARENT})`, { 'ownerid@odata.bind': `/systemusers(${USER_TWO})` }),
    400,
  );
  assert.equal(ownerOf(store, 'x_parent', 'x_parentid', PARENT), USER_ONE, 'the parent keeps its owner');
  assert.equal(ownerOf(store, 'x_child', 'x_childid', ACTIVE), USER_ONE, 'the active child is restored');
  assert.equal(ownerOf(store, 'x_child', 'x_childid', INACTIVE), USER_ONE, 'the inactive child is restored');
});

test('a relationship without Assign metadata reports CASCADE_ASSIGN_DEFAULTED once and applies NoCascade', async (t) => {
  const { request, json, store, diagnostics } = await setup(t, undefined);
  await reassign(request, json, USER_TWO);
  await reassign(request, json, USER_THREE);
  const reported = diagnostics.filter((entry) => entry.code === 'CASCADE_ASSIGN_DEFAULTED');
  assert.equal(reported.length, 1, 'once per relationship, not per owner change');
  assert.equal(reported[0].table, 'x_parent');
  assert.equal(reported[0].referencing, 'x_child');
  assert.equal(ownerOf(store, 'x_child', 'x_childid', ACTIVE), USER_ONE);
});

// Sharing the parent through the Web API (GrantAccess, ModifyAccess, RevokeAccess with the documented bodies).
const share = (request, json, action, userId, mask = 'ReadAccess') =>
  request('POST', `/${action}`, {
    Target: { '@odata.type': 'Microsoft.Dynamics.CRM.x_parent', x_parentid: PARENT },
    ...(action === 'RevokeAccess'
      ? { Revokee: { '@odata.type': 'Microsoft.Dynamics.CRM.systemuser', systemuserid: userId } }
      : {
          PrincipalAccess: {
            Principal: { '@odata.type': 'Microsoft.Dynamics.CRM.systemuser', systemuserid: userId },
            AccessMask: mask,
          },
        }),
  }).then((response) => json(response, 204));
// The inherited and direct masks a principal holds on a row (0 / 0 without a share row).
const accessOf = (store, id, userId) => {
  const row = (store.state.tables.principalobjectaccess ?? []).find(
    (entry) =>
      String(entry.objectid).toLowerCase() === id && String(entry.principalid?.id ?? entry.principalid) === userId,
  );
  return row ? [Number(row.accessrightsmask), Number(row.inheritedaccessrightsmask)] : [0, 0];
};
const READ = 1,
  WRITE = 2,
  // Every AccessRights value but Create (Learn: the reparent action leaves CreateAccess alone).
  INHERITABLE = 1 | 2 | 4 | 16 | 65536 | 262144 | 524288;

// @test-kind compatibility: Microsoft Learn "Configure table relationship cascading behavior" (Share and Unshare: Cascade all, Active, UserOwned; the related rows are shared and unshared with the parent)
test('Share and Unshare cascade the parent share to its children as inherited access, as each cascade allows', async (t) => {
  const { request, json, store } = await setup(
    t,
    { assign: 'NoCascade', share: 'Cascade', unshare: 'Cascade' },
    { withGrandchild: true },
  );
  await share(request, json, 'GrantAccess', USER_TWO);
  assert.deepEqual(accessOf(store, PARENT, USER_TWO), [READ, 0], 'the parent holds the direct share');
  for (const child of [ACTIVE, INACTIVE, OTHER, GRANDCHILD])
    assert.deepEqual(accessOf(store, child, USER_TWO), [0, READ], `row ${child} inherits the share`);
  await share(request, json, 'ModifyAccess', USER_TWO, 'ReadAccess,WriteAccess');
  assert.deepEqual(accessOf(store, GRANDCHILD, USER_TWO), [0, READ | WRITE], 'ModifyAccess reaches the grandchild');
  await share(request, json, 'RevokeAccess', USER_TWO);
  for (const row of [PARENT, ACTIVE, INACTIVE, OTHER, GRANDCHILD])
    assert.deepEqual(accessOf(store, row, USER_TWO), [0, 0], `row ${row} is unshared`);

  const active = await setup(t, { assign: 'NoCascade', share: 'Active' });
  await share(active.request, active.json, 'GrantAccess', USER_TWO);
  assert.deepEqual(
    [ACTIVE, INACTIVE, OTHER].map((child) => accessOf(active.store, child, USER_TWO)[1]),
    [READ, 0, READ],
  );
  const owned = await setup(t, { assign: 'NoCascade', share: 'UserOwned' });
  await share(owned.request, owned.json, 'GrantAccess', USER_TWO);
  assert.deepEqual(
    [ACTIVE, INACTIVE, OTHER].map((child) => accessOf(owned.store, child, USER_TWO)[1]),
    [READ, READ, 0],
  );
  const none = await setup(t, { assign: 'NoCascade', share: 'NoCascade' });
  await share(none.request, none.json, 'GrantAccess', USER_TWO);
  assert.deepEqual(accessOf(none.store, ACTIVE, USER_TWO), [0, 0]);
});

// @test-kind compatibility: Microsoft Learn "Configure table relationship cascading behavior" (About the reparent action: a changed parental lookup moves the inherited access rights of the row and its related rows)
test('Reparent gives a re-parented child the new parent owner and shares as inherited access, and drops the old', async (t) => {
  const SECOND = '55555555-5555-4555-8555-555555555506';
  const { request, json, store } = await setup(
    t,
    { assign: 'NoCascade', share: 'Cascade', unshare: 'Cascade', reparent: 'Cascade' },
    { withGrandchild: true },
  );
  await store.transact(() =>
    store.state.tables.x_parent.push({
      x_parentid: SECOND,
      x_name: 'Second parent',
      ownerid: owner(USER_THREE),
      statecode: 0,
      statuscode: 1,
    }),
  );
  await share(request, json, 'GrantAccess', USER_TWO);
  assert.deepEqual(accessOf(store, ACTIVE, USER_TWO), [0, READ]);
  await json(await request('PATCH', `/x_children(${ACTIVE})`, { 'parent@odata.bind': `/x_parents(${SECOND})` }), 200);
  // The first parent's share no longer reaches the moved child or its grandchild; the second parent's owner does.
  for (const row of [ACTIVE, GRANDCHILD]) {
    assert.deepEqual(accessOf(store, row, USER_TWO), [0, 0], `row ${row} loses the old parent's share`);
    assert.deepEqual(accessOf(store, row, USER_THREE), [0, INHERITABLE], `row ${row} inherits the new parent owner`);
  }
  assert.deepEqual(accessOf(store, INACTIVE, USER_TWO), [0, READ], 'a child that stays keeps its inherited share');
});

// @test-kind contract: Paqvilo's describe levels for the cascade extension
test('describe lists every cascade action at behaviour', () => {
  const record = EXTENSION.describe();
  assert.equal(record.name, 'dataverse-cascade');
  assert.equal(record.level, 'behaviour');
  assert.deepEqual(record.requires, ['metadata:relationship cascade']);
  for (const operation of ['CascadeAssign', 'CascadeShare', 'CascadeUnshare', 'CascadeReparent', 'CascadeMerge'])
    assert.equal(record.operationLevels[operation], 'behaviour', operation);
  assert.equal(record.seams, undefined);
});

test('a PATCH that fails with 412 leaves no pre-image: a later write without beforeWrite reassigns no children', async (t) => {
  const { request, json, store } = await setup(t, { assign: 'Cascade' });
  const stale = await request(
    'PATCH',
    `/x_parents(${PARENT})`,
    { 'ownerid@odata.bind': `/systemusers(${USER_TWO})` },
    { 'if-match': 'W/"999999"' },
  );
  await json(stale, 412);
  // The owner changes outside the records pipeline (no hooks), then a property PUT runs afterWrite("update") alone.
  await store.transact(() => store.updateRecord('x_parent', PARENT, { ownerid: owner(USER_TWO) }, { admin: true }));
  assert.equal(ownerOf(store, 'x_parent', 'x_parentid', PARENT), USER_TWO);
  await json(await request('PUT', `/x_parents(${PARENT})/x_name`, { value: 'Renamed after the failure' }), 204);
  assert.equal(ownerOf(store, 'x_child', 'x_childid', ACTIVE), USER_ONE);
  assert.equal(ownerOf(store, 'x_child', 'x_childid', INACTIVE), USER_ONE);
});

// @test-kind unproven+security: local model of the Assign privilege check on cascaded children
test('a caller without Assign on the child table: the cascade refuses and the parent write rolls back', async (t) => {
  const refusing = {
    ...EXTENSION,
    install: (api, options) => {
      const authorize = api.principals.authorize;
      api.principals.authorize = (request) => {
        if (request.entity === 'x_child' && request.operation === 'assign')
          throw new DataError('Invented: no Assign on x_child.', 403, 'PrivilegeDenied', { innerCode: '0x80040220' });
        return authorize.call(api.principals, request);
      };
      t.after(() => {
        api.principals.authorize = authorize;
      });
      EXTENSION.install(api, options);
    },
  };
  const { request, json, store } = await setup(t, { assign: 'Cascade' }, { extension: refusing });
  const refused = await json(
    await request('PATCH', `/x_parents(${PARENT})`, { 'ownerid@odata.bind': `/systemusers(${USER_TWO})` }),
    403,
  );
  assert.equal(refused.error.code, '0x80040220');
  assert.equal(ownerOf(store, 'x_parent', 'x_parentid', PARENT), USER_ONE, 'the parent keeps its owner');
  assert.equal(ownerOf(store, 'x_child', 'x_childid', ACTIVE), USER_ONE);
});
