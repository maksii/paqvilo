// @test-kind security+compatibility: Microsoft Learn "Privileges by message": AssignRequest requires prvAssign and prvWrite, GrantAccess/ModifyAccess/RevokeAccess require prvShare; SDK calls are authorized by the run-as profile
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';

// Invented organization: one user-owned widget and an assignee.
const caller = '10000000-0000-4000-8000-000000000001',
  other = '10000000-0000-4000-8000-000000000002',
  id = '20000000-0000-4000-8000-00000000000a';
const profileWith = (operations) => ({
  userId: caller,
  evidence: 'Invented SDK privilege proof',
  grants: [{ entity: 'widget', operations }],
});
const storeOf = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: {
          entitySet: 'widgets',
          idColumn: 'widgetid',
          fields: { title: { type: 'string' }, ownerid: { dataverseType: 'owner' } },
        },
        systemuser: { entitySet: 'systemusers', idColumn: 'systemuserid' },
      },
      tables: {
        widget: [
          {
            widgetid: id,
            title: 'Before',
            statecode: 0,
            statuscode: 1,
            ownerid: { id: caller, logical_name: 'systemuser' },
          },
        ],
        systemuser: [
          { systemuserid: caller, fullname: 'Invented caller' },
          { systemuserid: other, fullname: 'Invented assignee' },
        ],
        principalobjectaccess: [],
      },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
const ref = (logicalName, value) => ({ $type: 'EntityReference', logicalName, id: value, name: null });
const execute = (store, profile, requestName, values) =>
  dispatchSdkCall({
    store,
    profile,
    message: {
      method: 'Execute',
      userId: caller,
      arguments: [
        {
          $type: 'OrganizationRequest',
          requestName,
          parameters: { $type: 'ParameterCollection', values },
        },
      ],
    },
  });
const assign = (store, profile) =>
  execute(store, profile, 'Assign', { Target: ref('widget', id), Assignee: ref('systemuser', other) });
const grant = (store, profile) =>
  execute(store, profile, 'GrantAccess', {
    Target: ref('widget', id),
    PrincipalAccess: { $type: 'PrincipalAccess', principal: ref('systemuser', other), accessMask: 1 },
  });
const denied = (error) => error.code === 'LocalBackendPermissionDenied' && error.status === 403;
const ownerOf = (store) => store.tableRows('widget')[0].ownerid.id;

test('SDK Assign and GrantAccess need the assign and share grants, update alone is denied', () => {
  const store = storeOf(),
    profile = profileWith(['read', 'update']);
  assert.throws(() => assign(store, profile), denied);
  assert.equal(ownerOf(store), caller);
  assert.throws(() => grant(store, profile), denied);
  assert.equal(store.tableRows('principalobjectaccess').length, 0);
});

test('SDK Assign and GrantAccess run with the assign and share grants', () => {
  const store = storeOf(),
    profile = profileWith(['read', 'update', 'assign', 'share']);
  assign(store, profile);
  assert.equal(ownerOf(store), other);
  grant(store, profile);
  assert.equal(store.tableRows('principalobjectaccess').length, 1);
});

test('SDK Assign keeps the Write check: an assign grant without update is denied', () => {
  const store = storeOf(),
    profile = profileWith(['read', 'assign']);
  assert.throws(() => assign(store, profile), denied);
  assert.equal(ownerOf(store), caller);
});
