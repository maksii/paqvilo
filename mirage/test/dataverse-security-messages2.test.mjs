// Shared links and ResetInheritedAccess in dataverse-security-messages2.mjs: a link token is random per record and rights, so only
// GenerateSharedLink can produce one, and the reset needs the administrator role and changes only the share rows its FetchXml selects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { DataError } from '../lib/data-error.mjs';
import { parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { createRecordHandlers, createRecordHooks } from '../lib/dataverse-records.mjs';
import {
  createPrincipals,
  ensureSecurityModel,
  ownerColumns,
  parseAccessMask,
  uuidV5,
} from '../lib/dataverse-security.mjs';
import { install } from '../lib/dataverse-security-messages2.mjs';

const ORIGIN = 'https://org.example.test';
const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const BASIC_OID = 'aaaaaaaa-0000-4000-8000-000000000002';
const INHERITED_MASK = 135069719;
const ADMIN_SHARE = '11111111-1111-4111-8111-111111111111';
const BASIC_SHARE = '22222222-2222-4222-8222-222222222222';
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [
    { objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] },
    { objectId: BASIC_OID, upn: 'basic@example.test', displayName: 'Basic', roles: ['Basic User'] },
  ],
};

function vaultState() {
  const state = emptyState();
  state.mappings.vault = {
    logicalName: 'vault',
    entitySet: 'vaults',
    idColumn: 'vaultid',
    nameColumn: 'name',
    ownership: 'UserOwned',
    fields: { name: { dataverseType: 'nvarchar' } },
  };
  state.tables.vault = [];
  return state;
}

// The records layer and the messages under test over an invented schema, with an administrator and a Basic User.
async function harness() {
  const store = new DataStore({ state: vaultState() });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const hooks = createRecordHooks();
  const handlers = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    metadataFields: () => undefined,
    hooks,
    fieldSecurity: () => undefined,
  });
  const operations = new Map();
  install({
    store,
    principals,
    settings: SETTINGS,
    change: (fn) => fn(),
    registry: { register: (operation) => operations.set(operation.name, operation) },
    recordHooks: hooks,
    metadataFields: () => undefined,
  });
  const send = async (method, path, user, body) => {
    const url = new URL(`/api/data/v9.2${path}`, ORIGIN);
    try {
      return await handlers.handle({
        method,
        route: parseDataverseRoute(url.pathname),
        url,
        origin: ORIGIN,
        version: 'v9.2',
        prefer: parsePrefer(undefined),
        headers: {},
        body,
        user,
        caller: user,
        identity: { admin: true, id: user.systemuserid, systemUserId: user.systemuserid },
        requestId: 'test',
      });
    } catch (error) {
      if (error instanceof DataError) return { status: error.status, details: error.details };
      throw error;
    }
  };
  return {
    store,
    send,
    admin: principals.byObjectId(ADMIN_OID),
    basic: principals.byObjectId(BASIC_OID),
    invoke: (name, user, { params, body, target } = {}) =>
      operations.get(name).handle({
        user,
        caller: user,
        params,
        body,
        target,
        identity: { admin: true, id: user.systemuserid },
        origin: ORIGIN,
        version: 'v9.2',
      }),
  };
}

const idOf = (response) => /\(([^)]+)\)$/.exec(response.headers?.['OData-EntityId'] ?? '')?.[1];
const targetOf = (id) => ({ '@odata.id': `vaults(${id})` });
const sharesFetch = (principal) =>
  `<fetch><entity name="principalobjectaccess"><attribute name="principalobjectaccessid"/><filter><condition attribute="principalid" operator="eq" value="${principal}"/></filter></entity></fetch>`;

async function createVault(t, name) {
  return idOf(await t.send('POST', '/vaults', t.admin, { name }));
}

// One share row per user on its own vault, both carrying the inherited rights that ResetInheritedAccess clears.
async function seedShares(t) {
  const adminVault = await createVault(t, 'admin vault');
  const basicVault = await createVault(t, 'basic vault');
  const share = (id, principal, objectid) => ({
    principalobjectaccessid: id,
    principalid: { id: principal, logical_name: 'systemuser' },
    objectid,
    objecttypecode: 'vault',
    accessrightsmask: 0,
    inheritedaccessrightsmask: INHERITED_MASK,
  });
  await t.store.transact(() => {
    const shares = (t.store.state.tables.principalobjectaccess ??= []);
    shares.push(
      share(ADMIN_SHARE, t.admin.systemuserid, adminVault),
      share(BASIC_SHARE, t.basic.systemuserid, basicVault),
    );
  });
}

const inheritedMaskOf = (t, principal) =>
  t.store.state.tables.principalobjectaccess.find((share) => share.principalid.id === principal)
    .inheritedaccessrightsmask;

// The administrator role check refuses with 0x80090432: the Basic User changes nothing and the rows keep their inherited rights.
// @test-kind security: ResetInheritedAccess rewrites the inherited rights of share rows, so a caller without the administrator role must be refused.
test('ResetInheritedAccess refuses a Basic User and leaves every share row with its inherited rights', async () => {
  const t = await harness();
  await seedShares(t);
  await assert.rejects(
    t.invoke('ResetInheritedAccess', t.basic, { params: { FetchXml: sharesFetch(t.admin.systemuserid) } }),
    (error) => error.status === 403 && error.details?.innerCode === '0x80090432',
  );
  assert.equal(inheritedMaskOf(t, t.admin.systemuserid), INHERITED_MASK);
  assert.equal(inheritedMaskOf(t, t.basic.systemuserid), INHERITED_MASK);
});

// The FetchXml selects the share rows to reset: a filter on one principal clears that row and no other.
// @test-kind security: the FetchXml filter is the only scope of the reset, so an administrator's query must leave the other principal's share row alone.
test('ResetInheritedAccess as an administrator resets only the share rows its FetchXml selects', async () => {
  const t = await harness();
  await seedShares(t);
  const response = await t.invoke('ResetInheritedAccess', t.admin, {
    params: { FetchXml: sharesFetch(t.admin.systemuserid) },
  });
  assert.equal(response.status, 200);
  assert.equal(inheritedMaskOf(t, t.admin.systemuserid), 0);
  assert.equal(inheritedMaskOf(t, t.basic.systemuserid), INHERITED_MASK);
});

// A missing FetchXml, malformed XML and a query on another table are refused with the usual bad-parameter error, and reset nothing.
// @test-kind security: a reset whose scope cannot be read from the FetchXml must refuse, not fall back to every share row.
test('ResetInheritedAccess refuses a missing or malformed FetchXml with 400 and changes no share row', async () => {
  const t = await harness();
  await seedShares(t);
  const queries = [undefined, "<fetch><entity name='principalobjectaccess'>", "<fetch><entity name='vault'/></fetch>"];
  for (const FetchXml of queries) {
    await assert.rejects(
      t.invoke('ResetInheritedAccess', t.admin, { params: { FetchXml } }),
      (error) => error.status === 400,
    );
  }
  assert.equal(inheritedMaskOf(t, t.admin.systemuserid), INHERITED_MASK);
  assert.equal(inheritedMaskOf(t, t.basic.systemuserid), INHERITED_MASK);
});

// The link for one record and rights is stored once: the owner's repeat call returns the same URL and adds no team row.
// @test-kind security: a link token that is only a function of the record id would let anyone mint the link, so the owner's repeat call must return the stored one.
test('GenerateSharedLink returns the same link for the same record and rights', async () => {
  const t = await harness();
  const id = await createVault(t, 'vault');
  const generate = () =>
    t.invoke('GenerateSharedLink', t.admin, { body: { Target: targetOf(id), SharedRights: 'ReadAccess' } });
  const first = await generate();
  const second = await generate();
  assert.equal(first.status, 200);
  assert.equal(second.body.Response, first.body.Response);
  assert.equal((t.store.state.tables.team ?? []).filter((team) => team.sharelinkqualifier != null).length, 1);
});

// A token derived from the record id is not a live link, so the forger's grant is refused and its read stays 403.
// @test-kind security: a token that anyone can compute from the record id must grant nothing, and the forger must keep no read access.
test('a shared-link token computed from the record id is refused and grants no access', async () => {
  const t = await harness();
  const id = await createVault(t, 'vault');
  await t.invoke('GenerateSharedLink', t.admin, { body: { Target: targetOf(id), SharedRights: 'ReadAccess' } });
  const mask = parseAccessMask('ReadAccess');
  const forged = `${ORIGIN}/main.aspx?etn=vault&id=${id}&sharedlink=${uuidV5(id, `sharedlink:${mask}`)}`;
  assert.equal((await t.send('GET', `/vaults(${id})?$select=name`, t.basic)).status, 403);
  await assert.rejects(
    t.invoke('GrantAccessUsingSharedLink', t.basic, { body: { RecordUrlWithSharedLink: forged } }),
    (error) => error.status === 400,
  );
  assert.equal((await t.send('GET', `/vaults(${id})?$select=name`, t.basic)).status, 403);
});

// The genuine link grants read to the caller; after RevokeSharedLink the same URL is refused.
// @test-kind security: the owner's genuine link is the only grant path, so it must grant read and stop granting once revoked.
test('the genuine shared link grants read, and after RevokeSharedLink it is refused', async () => {
  const t = await harness();
  const id = await createVault(t, 'vault');
  const generated = await t.invoke('GenerateSharedLink', t.admin, {
    body: { Target: targetOf(id), SharedRights: 'ReadAccess' },
  });
  const url = generated.body.Response;
  const granted = await t.invoke('GrantAccessUsingSharedLink', t.basic, { body: { RecordUrlWithSharedLink: url } });
  assert.equal(granted.status, 204);
  assert.equal((await t.send('GET', `/vaults(${id})?$select=name`, t.basic)).status, 200);
  const revoked = await t.invoke('RevokeSharedLink', t.admin, {
    body: { Target: targetOf(id), SharedRights: 'ReadAccess' },
  });
  assert.equal(revoked.status, 204);
  await assert.rejects(
    t.invoke('GrantAccessUsingSharedLink', t.basic, { body: { RecordUrlWithSharedLink: url } }),
    (error) => error.status === 400,
  );
});

const OWNED_VAULT = 'cccccccc-0000-4000-8000-000000000003';
const ownedVaultOf = (t) => t.store.state.tables.vault.find((row) => row.vaultid === OWNED_VAULT);

async function seedBasicVault(t, versionnumber) {
  await t.store.transact(() => {
    (t.store.state.tables.vault ??= []).push({
      vaultid: OWNED_VAULT,
      name: 'basic vault',
      versionnumber,
      ...ownerColumns(t.store, { id: t.basic.systemuserid, logical_name: 'systemuser' }),
    });
  });
}

// @test-kind contract: a reassigned row goes through the store update path, so its version advances and audit sees the new owner.
test('ReassignObjectsOwner moves an owned row to the new owner and advances its version', async () => {
  const t = await harness();
  await seedBasicVault(t, 7);
  const response = await t.invoke('ReassignObjectsOwner', t.admin, {
    body: {
      FromPrincipal: { '@odata.id': `systemusers(${t.basic.systemuserid})` },
      ToPrincipal: { '@odata.id': `systemusers(${t.admin.systemuserid})` },
    },
  });
  assert.equal(response.status, 204);
  assert.equal(Number(ownedVaultOf(t).versionnumber), 8);
  assert.equal(ownedVaultOf(t).ownerid.id, t.admin.systemuserid);
  assert.equal(ownedVaultOf(t).owninguser.id, t.admin.systemuserid);
});

// @test-kind contract: a row ReassignObjectsOwner moves is stamped with the caller as modifiedby, as a write the caller makes is.
test('ReassignObjectsOwner stamps the caller as modifiedby on the row it moves', async () => {
  const t = await harness();
  await seedBasicVault(t, 7);
  const response = await t.invoke('ReassignObjectsOwner', t.admin, {
    body: {
      FromPrincipal: { '@odata.id': `systemusers(${t.basic.systemuserid})` },
      ToPrincipal: { '@odata.id': `systemusers(${t.admin.systemuserid})` },
    },
  });
  assert.equal(response.status, 204);
  assert.equal(String(ownedVaultOf(t).modifiedby?.id ?? ownedVaultOf(t).modifiedby), t.admin.systemuserid);
  assert.equal(Number(ownedVaultOf(t).versionnumber), 8);
});

const TEAM_OF_ADMIN = 'dddddddd-0000-4000-8000-000000000004';
const TEAM_SHARE = 'dddddddd-0000-4000-8000-000000000007';
const SALES_UNIT = 'eeeeeeee-0000-4000-8000-000000000005';
const VAULT_OF_TEAM = 'cccccccc-0000-4000-8000-000000000006';
const teamTarget = () => ({ id: TEAM_OF_ADMIN, logical_name: 'team' });
const SALES_BODY = { BusinessUnit: { '@odata.id': `businessunits(${SALES_UNIT})` } };
const teamRowOf = (t) => t.store.state.tables.team.find((team) => team.teamid === TEAM_OF_ADMIN);
const teamVaultOf = (t) => t.store.state.tables.vault.find((row) => row.vaultid === VAULT_OF_TEAM);
const teamStateOf = (t) => JSON.stringify([t.store.state.tables.team, t.store.state.tables.vault]);

// The administrator's team owns one vault, and the Sales business unit exists. The Basic User reads the team through a share
// row (ReadAccess) but holds no write on it, so both the CRUD write and the message meet a row they can see and cannot change.
async function seedAdminTeam(t) {
  await t.store.transact(() => {
    (t.store.state.tables.principalobjectaccess ??= []).push({
      principalobjectaccessid: TEAM_SHARE,
      principalid: { id: t.basic.systemuserid, logical_name: 'systemuser' },
      objectid: TEAM_OF_ADMIN,
      objecttypecode: 'team',
      accessrightsmask: parseAccessMask('ReadAccess'),
      inheritedaccessrightsmask: 0,
    });
    (t.store.state.tables.businessunit ??= []).push({ businessunitid: SALES_UNIT, name: 'Sales' });
    (t.store.state.tables.team ??= []).push({
      teamid: TEAM_OF_ADMIN,
      name: 'admin team',
      teamtype: 0,
      ...ownerColumns(t.store, { id: t.admin.systemuserid, logical_name: 'systemuser' }),
    });
    (t.store.state.tables.vault ??= []).push({
      vaultid: VAULT_OF_TEAM,
      name: 'team vault',
      versionnumber: 5,
      ...ownerColumns(t.store, { id: TEAM_OF_ADMIN, logical_name: 'team' }),
    });
  });
}

// A Basic User's PATCH of the same team is refused with the code the message must give too.
// @test-kind security: SetParentTeam moves another user's team, so it must refuse a caller the team row refuses, and move nothing.
test('SetParentTeam refuses a Basic User on another user team with the CRUD refusal code and moves no row', async () => {
  const t = await harness();
  await seedAdminTeam(t);
  const before = teamStateOf(t);
  const crud = await t.send('PATCH', `/teams(${TEAM_OF_ADMIN})`, t.basic, { name: 'taken' });
  assert.equal(crud.status, 403);
  const refused = await t.invoke('SetParentTeam', t.basic, { body: SALES_BODY, target: teamTarget() }).catch((e) => e);
  assert.equal(refused.status, 403);
  assert.equal(refused.details?.innerCode, crud.details?.innerCode);
  assert.equal(teamStateOf(t), before);
});

// @test-kind security: an administrator's SetParentTeam moves the team and the rows it owns, each through the store update.
test('SetParentTeam as an administrator moves the team and its owned rows and advances their versions', async () => {
  const t = await harness();
  await seedAdminTeam(t);
  const response = await t.invoke('SetParentTeam', t.admin, { body: SALES_BODY, target: teamTarget() });
  assert.equal(response.status, 204);
  assert.equal(teamRowOf(t).businessunitid.id, SALES_UNIT);
  assert.equal(teamVaultOf(t).owningbusinessunit.id, SALES_UNIT);
  assert.equal(Number(teamVaultOf(t).versionnumber), 6);
});

// @test-kind contract: a row a team move carries to its business unit is stamped with the caller as modifiedby.
test('SetParentTeam stamps the caller as modifiedby on each owned row it moves', async () => {
  const t = await harness();
  await seedAdminTeam(t);
  const response = await t.invoke('SetParentTeam', t.admin, { body: SALES_BODY, target: teamTarget() });
  assert.equal(response.status, 204);
  assert.equal(String(teamVaultOf(t).modifiedby?.id ?? teamVaultOf(t).modifiedby), t.admin.systemuserid);
  assert.equal(Number(teamVaultOf(t).versionnumber), 6);
});
