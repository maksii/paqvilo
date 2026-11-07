// @test-kind unproven: requests whose sdkmessage has another name (AddMembersTeam -> AddMembers, PublishXml -> Publish) run their steps under the sdkmessage the native filter catalogues list; no native capture of these messages' pipelines yet (NATIVE unpipelined-message-steps)
// Invented tables, identities and steps only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';

const team = '50000000-0000-4000-8000-0000000000a1',
  member = '50000000-0000-4000-8000-0000000000a2';
const step = (n, message, stage, entity) => ({
  id: `30000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  name: `Invented ${message} ${stage}`,
  enabled: true,
  entity,
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Recorder',
  assemblyId: 'invented',
  ...(entity ? {} : { unfiltered: true }),
});

async function fixture(t, steps) {
  const f = await contractModuleFixture(t, {
    tables: {
      team: [{ teamid: team, name: 'Invented team', teamtype: 0, isdefault: false }],
    },
    extension: { name: 'invented-none', install() {} },
  });
  f.store.state.tables.systemuser.push({ systemuserid: member, fullname: 'Invented member', isdisabled: false });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Recorder',
      ({ context }) => {
        seen.push(`${context.MessageName}/${context.Stage}:${Object.keys(context.InputParameters ?? {}).join(',')}`);
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen };
}
const execute = (f, requestName, values) => {
  const userId = f.store.tableRows('systemuser').find((row) => row.applicationid).systemuserid;
  return dispatchSdkCall({
    store: f.store,
    profile: { userId, evidence: 'Invented SDK request caller', grants: [] },
    message: {
      method: 'Execute',
      userId,
      arguments: [{ $type: 'OrganizationRequest', requestName, parameters: { $type: 'ParameterCollection', values } }],
    },
  });
};
const memberships = (f) => f.store.tableRows('teammembership').filter((row) => (row.teamid?.id ?? row.teamid) === team);

test('Web API AddMembersTeam runs the steps registered on AddMembers', async (t) => {
  const f = await fixture(t, [step(1, 'AddMembers', 20, 'team'), step(2, 'AddMembers', 40, 'team')]);
  const added = await f.request('POST', `/teams(${team})/Microsoft.Dynamics.CRM.AddMembersTeam`, {
    Members: [{ '@odata.type': 'Microsoft.Dynamics.CRM.systemuser', systemuserid: member }],
  });
  assert(added.status < 300, await added.text());
  assert.equal(memberships(f).length, 1);
  assert.deepEqual(
    f.seen.map((entry) => entry.split(':')[0]),
    ['AddMembers/20', 'AddMembers/40'],
  );
});

test('SDK AddMembersTeam and RemoveMembersTeam (TeamId, MemberIds) change the team inside the AddMembers and RemoveMembers pipelines', async (t) => {
  const f = await fixture(t, [step(1, 'AddMembers', 20, 'team'), step(2, 'RemoveMembers', 40, 'team')]);
  const values = {
    TeamId: { $type: 'Guid', value: team },
    MemberIds: { $type: 'PrimitiveArray', elementType: 'Guid', values: [{ $type: 'Guid', value: member }] },
  };
  const added = execute(f, 'AddMembersTeam', values);
  assert.equal(added.responseName, 'AddMembersTeam');
  assert.equal(memberships(f).length, 1);
  execute(f, 'RemoveMembersTeam', values);
  assert.equal(memberships(f).length, 0);
  assert.deepEqual(f.seen, ['AddMembers/20:TeamId,MemberIds', 'RemoveMembers/40:TeamId,MemberIds']);
});

test('SDK PublishXml, RetrieveTeamPrivileges and InitializeFrom run synchronously in a plug-in', async (t) => {
  const f = await fixture(t, [step(1, 'Publish', 20, null)]);
  execute(f, 'PublishXml', { ParameterXml: '<importexportxml><entities /></importexportxml>' });
  assert.deepEqual(f.seen, ['Publish/20:ParameterXml']);
  const privileges = execute(f, 'RetrieveTeamPrivileges', { TeamId: { $type: 'Guid', value: team } });
  assert.ok(Object.hasOwn(privileges.results, 'RolePrivileges'));
  const initialized = execute(f, 'InitializeFrom', {
    EntityMoniker: { $type: 'EntityReference', logicalName: 'team', id: team, name: null },
    TargetEntityName: 'team',
    TargetFieldType: { $type: 'OptionSetValue', value: 0 },
  });
  assert.ok(Object.hasOwn(initialized.results, 'Entity'));
});
