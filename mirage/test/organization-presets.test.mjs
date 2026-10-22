import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveOrganizationPresetSections } from '../lib/organization-presets.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';

test('preset preservation follows ownership flags while explicit entries keep replacement semantics', () => {
  const previous = { mappings: {
    systemuser: { idColumn: 'systemuserid', metadataSources: ['invented-security-source'] },
    organization: { idColumn: 'organizationid' }, role: { idColumn: 'roleid' }, customapi: { idColumn: 'customapiid' },
    new_api: { dataverseOnly: true, dataverseMetadata: { createdByMetadataApi: true } },
    new_source: { metadataSources: ['invented-source'] },
    new_business: { idColumn: 'new_businessid' },
  }, tables: { systemuser: [{ systemuserid: 'staff' }], organization: [{ organizationid: 'organization' }], role: [{ roleid: 'role' }], customapi: [{ customapiid: 'operation' }], new_api: [{ name: 'API data' }], new_source: [{ name: 'Business source row' }], new_business: [{ name: 'Business row' }] } };
  const preset = { mappings: { new_business: { idColumn: 'new_businessid' } }, tables: { new_business: [] } };
  const next = preserveOrganizationPresetSections(previous, preset, structuredClone(preset));
  assert.deepEqual(next.tables.systemuser, previous.tables.systemuser);
  for (const name of ['organization', 'role', 'customapi']) assert.deepEqual(next.tables[name], previous.tables[name], 'Unflagged core-owned mappings do not surrender their rows.');
  assert.deepEqual(next.tables.new_api, previous.tables.new_api);
  assert.deepEqual(next.mappings.new_source, previous.mappings.new_source);
  assert.equal(next.tables.new_source, undefined, 'Source schema ownership does not infer business row ownership.');
  assert.deepEqual(next.tables.new_business, []);
  const explicit = { mappings: { systemuser: { idColumn: 'alternate' } }, tables: { systemuser: [] } };
  const replaced = preserveOrganizationPresetSections(previous, explicit, structuredClone(explicit));
  assert.deepEqual(replaced.tables.systemuser, []);
  assert.deepEqual(replaced.mappings.systemuser, { idColumn: 'alternate' });
  assert.notEqual(next.tables.systemuser, previous.tables.systemuser, 'Preset state owns independent copies.');
});

test('replacing security tables retains only the reserved existing SYSTEM identity and administrator membership', () => {
  const org = '77777777-7777-4777-8777-777777777794', system = uuidV5(org, 'systemuser:SYSTEM'), admin = uuidV5(org, 'role:System Administrator');
  const previous = { mappings: {}, tables: {
    organization: [{ organizationid: org }],
    systemuser: [{ systemuserid: system, fullname: 'SYSTEM' }, { systemuserid: 'old-staff', fullname: 'Removed staff' }],
    role: [{ roleid: admin, name: 'System Administrator' }, { roleid: 'staff-role', name: 'Staff' }],
    systemuserroles: [{ systemuserroleid: 'internal-link', systemuserid: { id: system }, roleid: { id: admin } }, { systemuserroleid: 'revoked-link', systemuserid: { id: 'old-staff' }, roleid: { id: admin } }],
    roleprivileges: [{ roleprivilegeid: 'revoked-grant' }],
  } };
  const preset = { tables: { systemuser: [{ systemuserid: 'new-staff' }], systemuserroles: [], role: [], roleprivileges: [] } };
  const next = preserveOrganizationPresetSections(previous, preset, structuredClone(preset));
  assert.deepEqual(next.tables.systemuser.map(row => row.systemuserid), ['new-staff', system]);
  assert.deepEqual(next.tables.systemuserroles.map(row => row.systemuserroleid), ['internal-link']);
  assert.deepEqual(next.tables.role.map(row => row.roleid), [admin]);
  assert.deepEqual(next.tables.roleprivileges, [], 'revoked non-SYSTEM grants are not re-seeded');
  assert.notEqual(next.tables.systemuser[1], previous.tables.systemuser[0]);
});

test('a preset replacing a plug-in table keeps the steps the Solution seeded under plugin:<table>', () => {
  const step = (id, name) => ({ sdkmessageprocessingstepid: id, name });
  const previous = { mappings: {}, tables: { sdkmessageprocessingstep: [step('a', 'Solution step'), step('b', 'runtime step')] },
    dataverse: { sourceSeeded: { 'plugin:sdkmessageprocessingstep': ['a'] } } };
  const preset = { tables: { sdkmessageprocessingstep: [step('c', 'preset step')] } };
  const next = preserveOrganizationPresetSections(previous, preset, structuredClone(preset));
  assert.deepEqual(next.tables.sdkmessageprocessingstep.map(row => row.name), ['Solution step', 'preset step']);
});
