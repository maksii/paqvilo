// Simulated Dataverse security model: seeding, principal resolution, depth-based
// authorization, role-privilege introspection. Invented schema and GUIDs only.
import test from "node:test";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import {
  ACCESS_RIGHTS,
  DEPTH,
  assertCanJoinTeam,
  assertTeamCanHoldRoles,
  assertTeamCanOwn,
  assignRoles,
  baseCurrencyId,
  baseCurrencyRow,
  businessUnitOf,
  createApplicationUser,
  createPrincipals,
  ensureSecurityModel,
  isInteractiveUser,
  ownerColumns,
  ownershipTypeName,
  privilegeDeniedError,
  privilegeName,
  privilegeId,
  grantAccess,
  modifyAccess,
  parseAccessMask,
  privilegeNounOf,
  revokeAccess,
  seedTablePrivileges,
  TEAM_MEMBERSHIP,
  dataverseIdentity,
  setBusinessUnit,
  setHierarchySecurity,
  syncGroupMembership,
  teamsOfUser,
  uuidV5,
} from "../lib/dataverse-security.mjs";
import { seed as seedStandard, standardSchema } from "../lib/dataverse-standard.mjs";

const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const APP_ID = "11111111-2222-4333-8444-555555555555";
const APP_2 = "22222222-3333-4444-8555-666666666666";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const BASIC_OID = "aaaaaaaa-0000-4000-8000-000000000002";
const NOROLE_OID = "aaaaaaaa-0000-4000-8000-000000000003";
const ROOT = uuidV5(ORG, "businessunit:root");
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
  applications: [{ appId: APP_ID, displayName: "Test App", roles: ["System Administrator"] }],
  users: [
    { objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] },
    { objectId: BASIC_OID, upn: "basic@example.test", displayName: "Basic", roles: ["Basic User"] },
    { objectId: NOROLE_OID, upn: "norole@example.test", displayName: "No Role", roles: [] },
  ],
};

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    fields: { name: { dataverseType: "nvarchar" }, ownerid: { dataverseType: "lookup" } },
  };
  state.mappings.region = {
    logicalName: "region", entitySet: "regions", idColumn: "regionid", nameColumn: "name",
    ownership: "OrganizationOwned", fields: { name: { dataverseType: "nvarchar" } },
  };
  state.tables.widget = [];
  state.tables.region = [];
  return state;
}

async function seeded() {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  return store;
}

test("the organization row takes auditing, duplicate detection, locale and base currency from the settings", async () => {
  const store = new DataStore({ state: fixtureState() });
  const { auditing, duplicateDetection, localeId, currencyCode, currencySymbol } = dataverseSettings({ auditing: true, duplicateDetection: false, localeId: 1036, currencyCode: "EUR", currencySymbol: "€" });
  await ensureSecurityModel(store, { ...SETTINGS, auditing, duplicateDetection, localeId, currencyCode, currencySymbol });
  const org = store.tableRows("organization")[0];
  assert.deepEqual([org.isauditenabled, org.isduplicatedetectionenabled, org.localeid, org.languagecode], [true, false, 1036, 1036]);
  const currency = store.tableRows("transactioncurrency")[0];
  assert.deepEqual([currency.isocurrencycode, currency.currencysymbol], ["EUR", "€"]);
});

test("settings without the new keys take the documented defaults: auditing off, detection on, 1033, USD and $", async () => {
  const store = await seeded();
  const org = store.tableRows("organization")[0];
  assert.deepEqual([org.isauditenabled, org.isduplicatedetectionenabled, org.localeid], [false, true, 1033]);
  const currency = store.tableRows("transactioncurrency")[0];
  assert.deepEqual([currency.isocurrencycode, currency.currencysymbol], ["USD", "$"]);
  assert.deepEqual(dataverseSettings({}).currencyCode, "USD");
});

const lookupOf = (user) => ({ id: user.systemuserid, logical_name: "systemuser", name: user.fullname });
const denial = (code, inner) => (e) => e.status === 403 && e.code === code && e.details?.innerCode === inner;

test("system table privileges use the documented names; intersect tables own none", async () => {
  const store = await seeded();
  const names = new Set(store.state.tables.privilege.map((p) => p.name));
  // systemuser is prvReadUser, not prvReadSystemUser; team, role and businessunit keep their SchemaName.
  for (const name of ["prvReadUser", "prvWriteUser", "prvCreateUser", "prvDeleteUser", "prvAppendUser", "prvAppendToUser", "prvReadTeam", "prvReadRole", "prvReadBusinessUnit", "prvReadOrganization"]) assert.ok(names.has(name), name);
  for (const name of names) assert.ok(!/SystemUser|Systemuser/.test(name), name);
  // Intersect tables take the parent's privileges: no prvReadSystemUserRoles, prvReadTeamMembership, and so on.
  for (const name of names) assert.ok(!/(SystemUserRoles|TeamMembership|TeamRoles|RolePrivileges)$/.test(name), name);
  // Custom tables are unchanged: prv<Op><SchemaName>.
  assert.ok(names.has("prvReadWidget") && names.has("prvCreateRegion"));
});

test("ensureSecurityModel seeds organization, root unit, roles, SYSTEM user and privileges", async () => {
  const store = await seeded();
  const t = store.state.tables;
  assert.equal(t.organization.length, 1);
  assert.equal(t.businessunit.length, 1);
  assert.equal(t.businessunit[0].businessunitid, ROOT);
  assert.deepEqual(t.role.map((r) => r.name).sort(), ["Basic User", "System Administrator", "System Customizer"]);
  assert.ok(t.systemuser.some((u) => u.fullname === "SYSTEM" && u.systemuserid === uuidV5(ORG, "systemuser:SYSTEM")));
  // widget: 8 user-owned rights; region: 6 org-owned rights; six org-owned security tables: 6 each. privilege and principalobjectaccess are
  // OwnershipType None (standard file), so they get none; the four intersect tables own none; 19 miscellaneous privileges (17, plus prvExportCustomization and prvImportCustomization).
  assert.equal(t.privilege.length, 8 + 6 + 36 + 19);
  // Admins: every privilege at Global (69), less the three System Administrator only privileges (two bypasses, prvBulkDelete) that System Customizer does not hold (66).
  // Basic User: 8 widget rights + Global Read on 7 org-owned tables (region and the six security tables). Miscellaneous privileges reach no Basic User.
  assert.equal(t.roleprivileges.length, 69 + 66 + 8 + 7);
  assert.ok(!t.roleprivileges.some((rp) => rp.roleid.id === uuidV5(ORG, "role:Basic User") && rp.privilegeid.id === privilegeId(ORG, "prvReadPrincipalObjectAccess")));
  assert.equal(t.transactioncurrency.length, 1);
  assert.equal(t.transactioncurrency[0].currencysymbol, "$");
  assert.equal(store.state.mappings.systemuser.userConfigured, true);
  assert.equal(store.state.mappings.widget.userConfigured, undefined);
});

test("re-running the seed changes nothing and adds only newly configured users", async () => {
  const store = await seeded();
  const before = JSON.stringify(store.snapshot().tables);
  const usersBefore = store.state.tables.systemuser.length;
  await ensureSecurityModel(store, SETTINGS);
  assert.equal(JSON.stringify(store.snapshot().tables), before);

  const late = "aaaaaaaa-0000-4000-8000-000000000009";
  const privilegesBefore = store.state.tables.privilege.length;
  await ensureSecurityModel(store, { ...SETTINGS, users: [...SETTINGS.users, { objectId: late, upn: "late@example.test", roles: ["Basic User"] }] });
  assert.equal(store.state.tables.systemuser.length, usersBefore + 1);
  assert.equal(store.state.tables.privilege.length, privilegesBefore);
});

test("claims resolve to application or interactive users with unknown and disabled reasons", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const app = p.resolve({ appid: APP_ID });
  assert.equal(app.reason, null);
  assert.equal(app.user.applicationid, APP_ID);
  assert.equal(p.resolve({ oid: BASIC_OID }).user.fullname, "Basic");
  assert.equal(p.resolve({ upn: "basic@example.test" }).user.azureactivedirectoryobjectid, BASIC_OID);
  assert.deepEqual(p.resolve({ appid: "99999999-9999-4999-8999-999999999999" }), { user: null, reason: "unknown" });
  await store.transact(() => { p.byObjectId(BASIC_OID).isdisabled = true; });
  assert.equal(p.resolve({ oid: BASIC_OID }).reason, "disabled");
});

test("System Administrator passes every operation and reads unfiltered", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const foreign = { widgetid: "w-foreign", ownerid: { id: "bbbbbbbb-0000-4000-8000-000000000000" } };
  for (const operation of ["read", "create", "update", "delete", "append", "appendto", "assign", "share"]) {
    p.authorize({ user: admin, entity: "widget", operation, row: foreign });
  }
  // Organization-owned tables have no Assign or Share privilege.
  for (const operation of ["read", "create", "update", "delete"]) {
    p.authorize({ user: admin, entity: "region", operation, row: { regionid: "r1" } });
  }
  assert.equal(p.readFilter({ user: admin, entity: "widget" }), null);
});

test("Basic User sees and updates only its own widgets", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const mine = { widgetid: "w-mine", name: "mine", ownerid: lookupOf(basic) };
  const theirs = { widgetid: "w-theirs", name: "theirs", ownerid: lookupOf(admin) };
  await store.transact(() => store.state.tables.widget.push(mine, theirs));

  const keep = p.readFilter({ user: basic, entity: "widget" });
  assert.deepEqual(store.tableRows("widget").filter(keep).map((r) => r.widgetid), ["w-mine"]);
  p.authorize({ user: basic, entity: "widget", operation: "update", row: mine });
  assert.throws(() => p.authorize({ user: basic, entity: "widget", operation: "update", row: theirs }), denial("AccessDenied", "0x80048306"));
});

test("Basic User has Global read on organization-owned tables and no create there", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  assert.equal(p.readFilter({ user: basic, entity: "region" }), null);
  p.authorize({ user: basic, entity: "region", operation: "read", row: { regionid: "r1" } });
  assert.throws(
    () => p.authorize({ user: basic, entity: "region", operation: "create", row: { regionid: "r2" } }),
    (e) => denial("PrivilegeDenied", "0x80040220")(e) && e.details.privilege === "prvCreateRegion",
  );
});

test("a role without the privilege denies with 0x80040220", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const norole = p.resolve({ oid: NOROLE_OID }).user;
  const empty = uuidV5(ORG, "role:Empty");
  await store.transact(() => store.state.tables.role.push({
    roleid: empty, name: "Empty",
    businessunitid: { id: ROOT, logical_name: "businessunit", name: "testorg" },
    organizationid: { id: ORG, logical_name: "organization", name: "Test Org" },
  }));
  await assignRoles(store, { systemuserid: norole.systemuserid, roleIds: [empty] });
  assert.throws(
    () => p.authorize({ user: norole, entity: "widget", operation: "read", row: { widgetid: "w" } }),
    (e) => denial("PrivilegeDenied", "0x80040220")(e) && e.details.privilege === "prvReadWidget" && /is missing prvReadWidget privilege/.test(e.message),
  );
});

test("team membership grants the team roles", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const norole = p.resolve({ oid: NOROLE_OID }).user;
  const team = uuidV5(ORG, "team:Readers");
  const basicRole = uuidV5(ORG, "role:Basic User");
  await store.transact(() => {
    store.state.tables.team.push({ teamid: team, name: "Readers" });
    store.state.tables.teammembership.push({
      teammembershipid: uuidV5(team, norole.systemuserid),
      systemuserid: lookupOf(norole),
      teamid: { id: team, logical_name: "team", name: "Readers" },
    });
    store.state.tables.teamroles.push({
      teamroleid: uuidV5(team, basicRole),
      teamid: { id: team, logical_name: "team", name: "Readers" },
      roleid: { id: basicRole, logical_name: "role", name: "Basic User" },
    });
  });
  // The team role admits rows the team owns; an ownerless row is visible only at Global.
  assert.equal(p.authorize({ user: norole, entity: "widget", operation: "read", row: { widgetid: "w", ownerid: { id: team, logical_name: "team" } } }), 1);
});

test("createApplicationUser and assignRoles add application users by appid", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const id = await createApplicationUser(store, SETTINGS, { appId: APP_2, displayName: "Second App", roles: ["Basic User"] });
  assert.equal(id, uuidV5(ORG, `systemuser:app:${APP_2}`));
  assert.equal(p.resolve({ appid: APP_2 }).user.systemuserid, id);
  assert.deepEqual(p.roles({ systemuserid: id }).map((r) => r.name), ["Basic User"]);
  await assignRoles(store, { systemuserid: id, roleIds: [uuidV5(ORG, "role:System Customizer")] });
  assert.deepEqual(p.roles({ systemuserid: id }).map((r) => r.name).sort(), ["Basic User", "System Customizer"]);
});

test("retrieveUserPrivileges and principalAccess report depths and access flags", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const norole = p.resolve({ oid: NOROLE_OID }).user;
  const mine = { widgetid: "w-mine", ownerid: lookupOf(basic) };
  const theirs = { widgetid: "w-theirs", ownerid: lookupOf(admin) };

  const privs = p.retrieveUserPrivileges(basic.systemuserid);
  assert.equal(privs.length, 15, "8 widget rights and Global Read on the 7 organization-owned tables (region and six security tables)");
  const read = privs.find((x) => x.PrivilegeName === "prvReadWidget");
  assert.equal(read.Depth, "Basic");
  assert.equal(read.BusinessUnitId, ROOT);
  assert.equal(read.RecordFilterId, null);
  assert.equal(read.RecordFilterUniqueName, null);
  assert.equal(privs.find((x) => x.PrivilegeName === "prvReadRegion").Depth, "Global");

  assert.equal(
    p.principalAccess({ user: basic, entity: "widget", row: mine }),
    "ReadAccess, WriteAccess, AppendAccess, AppendToAccess, CreateAccess, DeleteAccess, ShareAccess, AssignAccess",
  );
  assert.equal(p.principalAccess({ user: basic, entity: "widget", row: theirs }), "CreateAccess");
  assert.equal(p.principalAccess({ user: norole, entity: "widget", row: mine }), "None");
  assert.equal(p.canImpersonate(admin), true);
  assert.equal(p.canImpersonate(basic), false);
});

test("shares open a row for the rights in the mask, directly or through a team, until revoked", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const theirs = { widgetid: "aaaaaaaa-0000-4000-8000-00000000c0de", ownerid: lookupOf(admin) };
  const target = { logical: "widget", id: theirs.widgetid };
  const denied = denial("AccessDenied", "0x80048306");
  assert.throws(() => p.authorize({ user: basic, entity: "widget", operation: "read", row: theirs }), denied);
  assert.equal(parseAccessMask("ReadAccess, WriteAccess"), ACCESS_RIGHTS.Read | ACCESS_RIGHTS.Write);
  assert.throws(() => parseAccessMask("FlyAccess"), (e) => e.status === 400);

  await grantAccess(store, { target, principal: { id: basic.systemuserid, logical_name: "systemuser" }, mask: parseAccessMask("ReadAccess, WriteAccess") });
  assert.equal(p.authorize({ user: basic, entity: "widget", operation: "read", row: theirs }), 1);
  assert.equal(p.authorize({ user: basic, entity: "widget", operation: "update", row: theirs }), 1);
  assert.throws(() => p.authorize({ user: basic, entity: "widget", operation: "delete", row: theirs }), denied);
  assert.equal(p.readFilter({ user: basic, entity: "widget" })(theirs), true);
  assert.equal(p.principalAccess({ user: basic, entity: "widget", row: theirs }), "ReadAccess, WriteAccess, CreateAccess");
  // GrantAccess ORs into the existing share: still one row, Read stays with Write.
  await grantAccess(store, { target, principal: { id: basic.systemuserid, logical_name: "systemuser" }, mask: ACCESS_RIGHTS.Read });
  assert.equal(store.state.tables.principalobjectaccess.length, 1);
  assert.equal(p.principalAccess({ user: basic, entity: "widget", row: theirs }), "ReadAccess, WriteAccess, CreateAccess");
  // ModifyAccess replaces the mask.
  await modifyAccess(store, { target, principal: { id: basic.systemuserid, logical_name: "systemuser" }, mask: ACCESS_RIGHTS.Read });
  assert.equal(store.state.tables.principalobjectaccess.length, 1);
  assert.equal(p.principalAccess({ user: basic, entity: "widget", row: theirs }), "ReadAccess, CreateAccess");

  assert.equal(await revokeAccess(store, { target, principal: { id: basic.systemuserid, logical_name: "systemuser" } }), true);
  assert.equal(await revokeAccess(store, { target, principal: { id: basic.systemuserid, logical_name: "systemuser" } }), false);
  assert.throws(() => p.authorize({ user: basic, entity: "widget", operation: "read", row: theirs }), denied);

  // A share with a team reaches its members.
  const teamId = "bbbbbbbb-0000-4000-8000-000000000001";
  await store.transact(() => {
    store.state.tables.team.push({ teamid: teamId, name: "Sharers", businessunitid: null, organizationid: null });
    store.state.tables.teammembership.push({ teammembershipid: "bbbbbbbb-0000-4000-8000-000000000002", systemuserid: lookupOf(basic), teamid: { id: teamId, logical_name: "team", name: "Sharers" } });
  });
  await grantAccess(store, { target, principal: { id: teamId, logical_name: "team" }, mask: ACCESS_RIGHTS.Read });
  assert.equal(store.state.tables.principalobjectaccess[0].principalid.logical_name, "team");
  assert.equal(p.authorize({ user: basic, entity: "widget", operation: "read", row: theirs }), 1);
  assert.throws(() => p.authorize({ user: basic, entity: "widget", operation: "update", row: theirs }), denied);
});

test("P13: a team subject reports its own roles at team depth and its shares; an organization reports rights only on org-owned tables", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const team = uuidV5(ORG, "team:Readers"), empty = uuidV5(ORG, "team:Empty");
  const basicRole = uuidV5(ORG, "role:Basic User");
  await store.transact(() => {
    store.state.tables.team.push({ teamid: team, name: "Readers", businessunitid: { id: ROOT, logical_name: "businessunit" } });
    store.state.tables.team.push({ teamid: empty, name: "Empty", businessunitid: { id: ROOT, logical_name: "businessunit" } });
    store.state.tables.teamroles.push({
      teamroleid: uuidV5(team, basicRole),
      teamid: { id: team, logical_name: "team", name: "Readers" },
      roleid: { id: basicRole, logical_name: "role", name: "Basic User" },
    });
  });
  const theirs = { widgetid: "aaaaaaaa-0000-4000-8000-00000000c0de", ownerid: lookupOf(admin) };
  const own = { widgetid: "aaaaaaaa-0000-4000-8000-00000000c0df", ownerid: { id: team, logical_name: "team" } };
  // Basic at team depth: the team's own rows only; Create is table-level.
  assert.equal(p.teamAccess({ team: { teamid: team }, entity: "widget", row: own }), "ReadAccess, WriteAccess, AppendAccess, AppendToAccess, CreateAccess, DeleteAccess, ShareAccess, AssignAccess");
  assert.equal(p.teamAccess({ team: { teamid: team }, entity: "widget", row: theirs }), "CreateAccess");
  assert.equal(p.teamAccess({ team: { teamid: empty }, entity: "widget", row: own }), "None");
  // A share to the team opens the admin's row for the rights in its mask.
  await grantAccess(store, { target: { logical: "widget", id: theirs.widgetid }, principal: { id: team, logical_name: "team" }, mask: parseAccessMask("ReadAccess") });
  assert.equal(p.teamAccess({ team: { teamid: team }, entity: "widget", row: theirs }), "ReadAccess, CreateAccess");
  assert.equal(p.teamAccess({ team: { teamid: empty }, entity: "widget", row: theirs }), "None", "a share to one team does not reach another");
  // Organization: the org-owned region gets every right but Assign and Share; a user-owned widget gets none.
  assert.equal(p.organizationAccess({ entity: "region" }), "ReadAccess, WriteAccess, AppendAccess, AppendToAccess, CreateAccess, DeleteAccess");
  assert.equal(p.organizationAccess({ entity: "widget" }), "None");
});

test("parseAccessMask accepts known bits and rejects unknown bits, non-integers and empty lists", () => {
  assert.equal(parseAccessMask(ACCESS_RIGHTS.Read | ACCESS_RIGHTS.Share), 1 | 262144);
  assert.equal(parseAccessMask(3), 3);
  for (const bad of [-1, 0, 1.5, NaN, 8, 2 ** 40, "", " , ", "None", "1", undefined])
    assert.throws(() => parseAccessMask(bad), (e) => e.status === 400, String(bad));
});

test("Basic User cannot read the share table, so it cannot list the organization's shares", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  assert.throws(
    () => p.authorize({ user: basic, entity: "principalobjectaccess", operation: "read", row: { principalobjectaccessid: "p1" } }),
    (e) => denial("PrivilegeDenied", "0x80040220")(e) && e.details.privilege === "prvReadPrincipalObjectAccess",
  );
});

test("uuidV5 matches the RFC 4122 example and the access right values are stable", () => {
  assert.equal(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
  assert.equal(ACCESS_RIGHTS.Read, 1);
  assert.equal(ACCESS_RIGHTS.Assign, 524288);
});

// Helpers for the team, business unit and ownership tests below.
const BU_REF = (id) => ({ id, logical_name: "businessunit" });
const ORG_REF = { id: ORG, logical_name: "organization" };

async function makeRole(store, name, grants) {
  const roleId = uuidV5(ORG, `role:${name}`);
  await store.transact(() => {
    store.state.tables.role.push({ roleid: roleId, name, businessunitid: BU_REF(ROOT), organizationid: ORG_REF });
    for (const [privilege, mask] of grants) {
      const privId = privilegeId(ORG, privilege);
      store.state.tables.roleprivileges.push({
        roleprivilegeid: uuidV5(roleId, privId),
        roleid: { id: roleId, logical_name: "role" },
        privilegeid: { id: privId, logical_name: "privilege" },
        privilegedepthmask: mask,
      });
    }
  });
  return roleId;
}

async function makeTeam(store, name, { bu = ROOT, members = [], roles = [] }) {
  const teamId = uuidV5(ORG, `team:${name}`), teamRef = { id: teamId, logical_name: "team", name };
  await store.transact(() => {
    store.state.tables.team.push({ teamid: teamId, name, businessunitid: BU_REF(bu), organizationid: ORG_REF });
    for (const user of members) {
      store.state.tables.teammembership.push({ teammembershipid: uuidV5(teamId, user.systemuserid), systemuserid: lookupOf(user), teamid: teamRef });
    }
    for (const roleId of roles) {
      store.state.tables.teamroles.push({ teamroleid: uuidV5(teamId, roleId), teamid: teamRef, roleid: { id: roleId, logical_name: "role" } });
    }
  });
  return teamId;
}

async function addBusinessUnit(store, name, parent = ROOT) {
  const id = uuidV5(ORG, `businessunit:${name}`);
  await store.transact(() => store.state.tables.businessunit.push({ businessunitid: id, name, parentbusinessunitid: BU_REF(parent), organizationid: ORG_REF }));
  return id;
}

async function addUserIn(store, name, bu) {
  const id = uuidV5(ORG, `systemuser:test:${name}`);
  await store.transact(() => store.state.tables.systemuser.push({
    systemuserid: id, fullname: name, azureactivedirectoryobjectid: uuidV5(ORG, `oid:${name}`), accessmode: 0,
    isdisabled: false, businessunitid: BU_REF(bu), organizationid: ORG_REF,
  }));
  return id;
}

test("a team role at Basic admits team-owned rows to members only, never a member's own row", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const member = p.resolve({ oid: NOROLE_OID }).user;
  const outsider = p.resolve({ oid: BASIC_OID }).user;
  const role = await makeRole(store, "Team Basic", [["prvReadWidget", DEPTH.Basic]]);
  const team = await makeTeam(store, "Readers", { members: [member], roles: [role] });
  const teamRow = { widgetid: "w-team", ownerid: { id: team, logical_name: "team" } };
  const ownRow = { widgetid: "w-own", ownerid: lookupOf(member) };
  await store.transact(() => store.state.tables.widget.push(teamRow, ownRow));

  assert.equal(p.authorize({ user: member, entity: "widget", operation: "read", row: teamRow }), DEPTH.Basic);
  assert.throws(() => p.authorize({ user: member, entity: "widget", operation: "read", row: ownRow }), denial("AccessDenied", "0x80048306"));
  assert.deepEqual(store.tableRows("widget").filter(p.readFilter({ user: member, entity: "widget" })).map((r) => r.widgetid), ["w-team"]);
  // A Basic user who is not in the team sees neither the team's row nor its own row through the team.
  assert.throws(() => p.authorize({ user: outsider, entity: "widget", operation: "read", row: teamRow }), denial("AccessDenied", "0x80048306"));
});

test("a team role at Local or Global admits the member's own row; Basic does not", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const member = p.resolve({ oid: NOROLE_OID }).user;
  const ownRow = { widgetid: "w-own", ownerid: lookupOf(member) };
  await store.transact(() => store.state.tables.widget.push(ownRow));
  const local = await makeRole(store, "Team Local", [["prvReadWidget", DEPTH.Local]]);
  await makeTeam(store, "Local Team", { members: [member], roles: [local] });
  // The member's own row sits in the team's business unit (both are the root unit).
  assert.equal(p.authorize({ user: member, entity: "widget", operation: "read", row: ownRow }), DEPTH.Local);

  const global = await makeRole(store, "Team Global", [["prvReadWidget", DEPTH.Global]]);
  await makeTeam(store, "Global Team", { members: [member], roles: [global] });
  const elsewhere = { widgetid: "w-own-2", ownerid: lookupOf(member), owningbusinessunit: BU_REF(await addBusinessUnit(store, "Far")) };
  await store.transact(() => store.state.tables.widget.push(elsewhere));
  assert.equal(p.authorize({ user: member, entity: "widget", operation: "read", row: elsewhere }), DEPTH.Global);
});

test("a team role at Local admits rows in the team's business unit", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const member = p.resolve({ oid: NOROLE_OID }).user;
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const branch = await addBusinessUnit(store, "Branch");
  const role = await makeRole(store, "Team Local", [["prvReadWidget", DEPTH.Local]]);
  await makeTeam(store, "Branch Team", { bu: branch, members: [member], roles: [role] });
  const inBranch = { widgetid: "w-in", ownerid: lookupOf(admin), owningbusinessunit: BU_REF(branch) };
  const inRoot = { widgetid: "w-root", ownerid: lookupOf(admin), owningbusinessunit: BU_REF(ROOT) };
  await store.transact(() => store.state.tables.widget.push(inBranch, inRoot));

  assert.equal(p.authorize({ user: member, entity: "widget", operation: "read", row: inBranch }), DEPTH.Local);
  assert.throws(() => p.authorize({ user: member, entity: "widget", operation: "read", row: inRoot }), denial("AccessDenied", "0x80048306"));
});

test("retrieveUserPrivileges reports team-role grants at Basic and de-duplicates them", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const member = p.resolve({ oid: NOROLE_OID }).user;
  const teamRole = await makeRole(store, "Team Local", [["prvReadWidget", DEPTH.Local]]);
  await makeTeam(store, "Readers", { members: [member], roles: [teamRole] });
  await makeTeam(store, "Readers Two", { members: [member], roles: [teamRole] });
  const teamOnly = p.retrieveUserPrivileges(member.systemuserid).filter((x) => x.PrivilegeName === "prvReadWidget");
  assert.equal(teamOnly.length, 1);
  assert.equal(teamOnly[0].Depth, "Basic");
  assert.equal(teamOnly[0].BusinessUnitId, ROOT);

  // A direct grant keeps its own depth next to the team grant.
  const directRole = await makeRole(store, "Local Readers", [["prvReadWidget", DEPTH.Local]]);
  await assignRoles(store, { systemuserid: member.systemuserid, roleIds: [directRole] });
  const depths = p.retrieveUserPrivileges(member.systemuserid).filter((x) => x.PrivilegeName === "prvReadWidget").map((x) => x.Depth).sort();
  assert.deepEqual(depths, ["Basic", "Local"]);
});

test("business unit is derived from the owner when owningbusinessunit is missing", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const branch = await addBusinessUnit(store, "Branch");
  const carol = await addUserIn(store, "carol", branch);
  const team = await makeTeam(store, "Branch Team", { bu: branch });

  assert.equal(p.ownerBusinessUnit({ ownerid: lookupOf(admin) }).id, ROOT);
  assert.equal(p.ownerBusinessUnit({ ownerid: { id: carol, logical_name: "systemuser" } }).id, branch);
  assert.equal(p.ownerBusinessUnit({ ownerid: { id: team, logical_name: "team" } }).id, branch);
  assert.equal(p.ownerBusinessUnit({ ownerid: lookupOf(admin), owningbusinessunit: BU_REF(branch) }).id, branch);
  assert.equal(p.ownerBusinessUnit({ ownerid: null }), null);

  // A Local direct grant follows the owner's business unit.
  const reader = p.resolve({ oid: NOROLE_OID }).user;
  const local = await makeRole(store, "Local Readers", [["prvReadWidget", DEPTH.Local]]);
  await assignRoles(store, { systemuserid: reader.systemuserid, roleIds: [local] });
  const rootOwned = { widgetid: "w-root-owner", ownerid: lookupOf(admin) };
  const branchOwned = { widgetid: "w-branch-owner", ownerid: { id: carol, logical_name: "systemuser" } };
  await store.transact(() => store.state.tables.widget.push(rootOwned, branchOwned));
  assert.equal(p.authorize({ user: reader, entity: "widget", operation: "read", row: rootOwned }), DEPTH.Local);
  assert.throws(() => p.authorize({ user: reader, entity: "widget", operation: "read", row: branchOwned }), denial("AccessDenied", "0x80048306"));
});

test("a row with no owner is visible only at Global", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const orphan = { widgetid: "w-orphan", name: "orphan" };
  await store.transact(() => store.state.tables.widget.push(orphan));

  assert.equal(p.readFilter({ user: basic, entity: "widget" })(orphan), false);
  assert.throws(() => p.authorize({ user: basic, entity: "widget", operation: "update", row: orphan }), denial("AccessDenied", "0x80048306"));
  assert.equal(p.authorize({ user: admin, entity: "widget", operation: "update", row: orphan }), DEPTH.Global);
});

test("impersonation adds createdonbehalfby and modifiedonbehalfby only when the caller differs", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const widget = store.state.mappings.widget;
  const lookupField = { dataverseType: "lookup" };
  const mapping = {
    ...widget,
    fields: { ...widget.fields, createdby: lookupField, modifiedby: lookupField, createdonbehalfby: lookupField, modifiedonbehalfby: lookupField },
  };

  const impersonated = p.ownershipDefaults({ user: basic, caller: admin, mapping });
  assert.equal(impersonated.createdonbehalfby.id, admin.systemuserid);
  assert.equal(impersonated.createdby.id, basic.systemuserid);
  assert.equal(p.modifiedBy({ user: basic, caller: admin }).modifiedonbehalfby.id, admin.systemuserid);

  assert.equal(p.ownershipDefaults({ user: basic, caller: basic, mapping }).createdonbehalfby, undefined);
  assert.equal(p.modifiedBy({ user: basic, caller: basic }).modifiedonbehalfby, undefined);
  assert.equal(p.modifiedBy({ user: basic }).modifiedonbehalfby, undefined);

  // The widget mapping declares neither on-behalf field, so the defaults leave them out; owner columns it does not declare go too.
  const plain = p.ownershipDefaults({ user: basic, caller: admin, mapping: widget });
  assert.equal(plain.createdonbehalfby, undefined);
  assert.equal(plain.ownerid.id, basic.systemuserid);
  assert.equal(plain.owninguser, undefined);
});

test("ownerColumns sets the owner trio for a systemuser owner and for a team owner", async () => {
  const store = await seeded();
  const basic = createPrincipals(store, SETTINGS).resolve({ oid: BASIC_OID }).user;
  const branch = await addBusinessUnit(store, "Branch");
  const team = await makeTeam(store, "Branch Team", { bu: branch });

  const user = ownerColumns(store, { id: basic.systemuserid, logical_name: "systemuser" });
  assert.equal(user.ownerid.id, basic.systemuserid);
  assert.equal(user.owninguser.id, basic.systemuserid);
  assert.equal(user.owningteam, null);
  assert.equal(user.owningbusinessunit.id, ROOT);

  const byTeam = ownerColumns(store, { id: team, logical_name: "team" });
  assert.equal(byTeam.ownerid.id, team);
  assert.equal(byTeam.owningteam.id, team);
  assert.equal(byTeam.owninguser, null);
  assert.equal(byTeam.owningbusinessunit.id, branch);
});

test("settings users without objectId get distinct ids derived from the tenant and domain name", async () => {
  const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, {
    ...SETTINGS,
    tenantId: TENANT,
    users: [
      { upn: "Dana@Example.test", roles: ["Basic User"] },
      { domainname: "eli@example.test", fullname: "Eli Example", roles: [] },
    ],
  });
  const users = store.tableRows("systemuser").filter((u) => u.azureactivedirectoryobjectid);
  const dana = users.find((u) => u.domainname === "Dana@Example.test");
  const eli = users.find((u) => u.fullname === "Eli Example");
  assert.equal(dana.azureactivedirectoryobjectid, uuidV5(TENANT, "user:dana@example.test"));
  assert.equal(eli.azureactivedirectoryobjectid, uuidV5(TENANT, "user:eli@example.test"));
  assert.notEqual(dana.systemuserid, eli.systemuserid);
  assert.equal(dana.accessmode, 0);
  assert.equal(dana.internalemailaddress, "Dana@Example.test");
  assert.equal(dana.fullname, "Dana@Example.test");
});

test("a settings user without objectId never throws: a non-GUID tenant uses the fixed namespace", async () => {
  const store = new DataStore({ state: fixtureState() });
  // SETTINGS.tenantId is "tenant-test", which is not a GUID.
  await ensureSecurityModel(store, { ...SETTINGS, users: [{ upn: "Fay@Example.test", roles: [] }] });
  const fay = store.tableRows("systemuser").find((u) => u.domainname === "Fay@Example.test");
  assert.equal(fay.azureactivedirectoryobjectid, uuidV5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "paqvilo-dataverse-user:fay@example.test"));
});

test("isInteractiveUser excludes SYSTEM, application users, disabled users and rows without an Entra id", async () => {
  const store = await seeded();
  const rows = store.tableRows("systemuser");
  const system = rows.find((u) => u.fullname === "SYSTEM");
  const app = rows.find((u) => u.applicationid === APP_ID);
  const basic = rows.find((u) => u.azureactivedirectoryobjectid === BASIC_OID);
  assert.equal(isInteractiveUser(basic), true);
  assert.equal(isInteractiveUser(system), false);
  assert.equal(isInteractiveUser(app), false);
  assert.equal(isInteractiveUser({ ...basic, isdisabled: true }), false);
  assert.equal(isInteractiveUser({ ...basic, azureactivedirectoryobjectid: null }), false);
  assert.equal(isInteractiveUser({ ...basic, accessmode: 4 }), false); // NonInteractive
});

test("the bypass privileges are seeded for System Administrator only, not System Customizer", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const norole = p.resolve({ oid: NOROLE_OID }).user;
  const bypass = ["prvBypassCustomPlugins", "prvBypassCustomBusinessLogic"];
  for (const name of bypass) {
    assert.ok(store.tableRows("privilege").some((r) => r.name === name && r.privilegeid === privilegeId(ORG, name)));
    assert.equal(p.privileges(admin).get(name), DEPTH.Global);
    assert.equal(p.privileges(basic).has(name), false);
  }
  await assignRoles(store, { systemuserid: norole.systemuserid, roleIds: [uuidV5(ORG, "role:System Customizer")] });
  for (const name of bypass) assert.equal(p.privileges(norole).has(name), false, name);
  // System Customizer keeps its other Global miscellaneous privileges.
  assert.equal(p.privileges(norole).get("prvReadEntity"), DEPTH.Global);
});

test("privilegeDeniedError builds the same message as the denial, with the counts and caller filled", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  let thrown = null;
  try {
    p.authorize({ user: basic, entity: "region", operation: "create", row: { regionid: "r2" } });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, "the Basic user must be denied prvCreateRegion");
  const built = privilegeDeniedError(basic, "prvCreateRegion", "region", {
    roleCount: p.roles(basic).length,
    privilegeCount: p.privileges(basic).size,
  });
  assert.equal(built.message, thrown.message);
  assert.equal(built.status, 403);
  assert.equal(built.details.innerCode, "0x80040220");
  assert.ok(built.message.includes(`roleCount=1, privilegeCount=15, accessMode=0)`), built.message);
  assert.ok(built.message.includes(`(Id=${privilegeId(ORG, "prvCreateRegion")})`), built.message);
  assert.ok(built.message.includes(`context.Caller=${basic.systemuserid}.`), built.message);
});

const inner = (code) => (e) => e.status === 400 && e.details?.innerCode === code;

test("access teams cannot own records or hold roles; a disabled user cannot join a team", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const owner = await makeTeam(store, "Owners", {});
  const access = uuidV5(ORG, "team:Access");
  await store.transact(() => store.state.tables.team.push({ teamid: access, name: "Access", teamtype: 1, businessunitid: BU_REF(ROOT), organizationid: ORG_REF }));

  assert.equal(p.authorize({ user: admin, entity: "widget", operation: "assign", row: { widgetid: "w" }, target: { id: owner, logical_name: "team" } }), DEPTH.Global);
  assert.throws(
    () => p.authorize({ user: admin, entity: "widget", operation: "assign", row: { widgetid: "w" }, target: { id: access, logical_name: "team" } }),
    inner("0x80048340"),
  );
  assertTeamCanHoldRoles(store, owner);
  assert.throws(() => assertTeamCanHoldRoles(store, access), inner("0x80048331"));
  assert.throws(() => assertTeamCanOwn(store, access), inner("0x80048340"));
  assertCanJoinTeam(store, basic.systemuserid);
  await store.transact(() => { p.byObjectId(BASIC_OID).isdisabled = true; });
  assert.throws(() => assertCanJoinTeam(store, basic.systemuserid), inner("0x80048d36"));
});

test("a role with isinherited 0 gives its team privileges on team-owned rows only, never on the member's own rows", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const member = p.resolve({ oid: NOROLE_OID }).user;
  const role = await makeRole(store, "Team Only", [["prvReadWidget", DEPTH.Global]]);
  await store.transact(() => { store.state.tables.role.find((r) => r.roleid === role).isinherited = 0; });
  const team = await makeTeam(store, "Team Only Team", { members: [member], roles: [role] });
  const teamRow = { widgetid: "w-team-only", ownerid: { id: team, logical_name: "team" } };
  const ownRow = { widgetid: "w-own-team-only", ownerid: lookupOf(member) };
  await store.transact(() => store.state.tables.widget.push(teamRow, ownRow));

  assert.equal(p.authorize({ user: member, entity: "widget", operation: "read", row: teamRow }), DEPTH.Global);
  assert.throws(() => p.authorize({ user: member, entity: "widget", operation: "read", row: ownRow }), denial("AccessDenied", "0x80048306"));
});

test("an effective principal holds only the privileges both users have, at the lower depth and on rows both admit", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const mine = { widgetid: "w-imp-mine", ownerid: lookupOf(basic) };
  const theirs = { widgetid: "w-imp-theirs", ownerid: lookupOf(admin) };
  await store.transact(() => store.state.tables.widget.push(mine, theirs));

  // Admin acting as Basic: Basic's rows only, at Basic depth.
  const asBasic = p.effectivePrincipal(admin, basic);
  assert.equal(p.privileges(asBasic).get("prvReadWidget"), DEPTH.Basic);
  assert.equal(p.privileges(asBasic).has("prvActOnBehalfOfAnotherUser"), false);
  assert.equal(p.authorize({ user: asBasic, entity: "widget", operation: "update", row: mine }), DEPTH.Basic);
  assert.throws(() => p.authorize({ user: asBasic, entity: "widget", operation: "update", row: theirs }), denial("AccessDenied", "0x80048306"));

  // Basic acting as Admin: the caller lacks Global Create on regions, so the intersection denies it.
  const asAdmin = p.effectivePrincipal(basic, admin);
  assert.equal(p.privileges(asAdmin).has("prvCreateRegion"), false);
  assert.equal(p.privileges(asAdmin).get("prvReadRegion"), DEPTH.Global);
  assert.throws(
    () => p.authorize({ user: asAdmin, entity: "region", operation: "create", row: { regionid: "r3" } }),
    (e) => denial("PrivilegeDenied", "0x80040220")(e) && e.details.privilege === "prvCreateRegion",
  );
  assert.equal(p.effectivePrincipal(admin, admin), admin);
});

test("prvActOnBehalfOfAnotherUser counts only through direct roles, not through a team", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const member = p.resolve({ oid: NOROLE_OID }).user;
  const delegate = await makeRole(store, "Delegate Lite", [["prvActOnBehalfOfAnotherUser", DEPTH.Global]]);
  await makeTeam(store, "Delegates", { members: [member], roles: [delegate] });
  assert.equal(p.canImpersonate(member), false);
  await assignRoles(store, { systemuserid: member.systemuserid, roleIds: [delegate] });
  assert.equal(p.canImpersonate(member), true);
});

test("seedTablePrivileges gives a table created after seeding its privileges once, and is idempotent", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  store.state.mappings.gadget = { logicalName: "gadget", entitySet: "gadgets", idColumn: "gadgetid", fields: { ownerid: { dataverseType: "lookup" } } };
  const privilegesBefore = store.state.tables.privilege.length, grantsBefore = store.state.tables.roleprivileges.length;

  const names = await seedTablePrivileges(store, SETTINGS, "gadget");
  assert.equal(names.length, 8);
  assert.equal(store.state.tables.privilege.length, privilegesBefore + 8);
  // User-owned: System Administrator and System Customizer at Global, Basic User at Basic, on each of the eight rights.
  assert.equal(store.state.tables.roleprivileges.length - grantsBefore, 8 * 3);

  const snapshot = JSON.stringify(store.snapshot().tables);
  await seedTablePrivileges(store, SETTINGS, "gadget");
  assert.equal(JSON.stringify(store.snapshot().tables), snapshot);

  assert.equal(p.authorize({ user: basic, entity: "gadget", operation: "read", row: { gadgetid: "g1", ownerid: lookupOf(basic) } }), DEPTH.Basic);
  assert.equal(p.authorize({ user: admin, entity: "gadget", operation: "delete", row: { gadgetid: "g2" } }), DEPTH.Global);
  await assert.rejects(seedTablePrivileges(store, SETTINGS, "nosuchtable"), (e) => e.status === 404);
});

test("group teams take members from the user's Entra group ids; business units are derived per row", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const member = p.resolve({ oid: NOROLE_OID }).user;
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const GROUP = "cccccccc-0000-4000-8000-000000000001";
  const role = await makeRole(store, "Group Basic", [["prvReadWidget", DEPTH.Basic]]);
  const group = uuidV5(ORG, "team:Group");
  await store.transact(() => {
    store.state.tables.team.push({ teamid: group, name: "Group", teamtype: 2, azureactivedirectoryobjectid: GROUP, businessunitid: BU_REF(ROOT), organizationid: ORG_REF });
    store.state.tables.teamroles.push({ teamroleid: uuidV5(group, role), teamid: { id: group, logical_name: "team" }, roleid: { id: role, logical_name: "role" } });
    store.state.tables.systemuser.find((u) => u.systemuserid === member.systemuserid).azureactivedirectorygroupids = [GROUP];
  });
  assert.deepEqual(teamsOfUser(store, member.systemuserid), [group]);
  const teamRow = { widgetid: "w-group", ownerid: { id: group, logical_name: "team" } };
  await store.transact(() => store.state.tables.widget.push(teamRow));
  assert.equal(p.authorize({ user: member, entity: "widget", operation: "read", row: teamRow }), DEPTH.Basic);

  assert.equal(businessUnitOf(store, { ownerid: lookupOf(admin) }), ROOT);
  assert.equal(businessUnitOf(store, { ownerid: null }), "");
});

test("seeding leaves an imported portal mapping and its rows untouched, and adds only the base currency row", async () => {
  const state = fixtureState();
  state.mappings.transactioncurrency = {
    logicalName: "transactioncurrency", entitySet: "transactioncurrencies", idColumn: "transactioncurrencyid", nameColumn: "currencyname",
    metadataSources: ["solution/customizations.xml"], fields: { currencyname: { dataverseType: "nvarchar" } },
  };
  state.tables.transactioncurrency = [{ transactioncurrencyid: "eeeeeeee-0000-4000-8000-000000000001", currencyname: "Euro" }];
  const mappingBefore = structuredClone(state.mappings.transactioncurrency);
  const store = new DataStore({ state });
  await ensureSecurityModel(store, SETTINGS);

  const mapping = store.state.mappings.transactioncurrency;
  assert.equal(mapping.userConfigured, undefined);
  assert.equal(mapping.dataverseOnly, undefined);
  assert.deepEqual(mapping, mappingBefore);

  const rows = store.state.tables.transactioncurrency;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { transactioncurrencyid: "eeeeeeee-0000-4000-8000-000000000001", currencyname: "Euro" });
  assert.equal(rows[1].transactioncurrencyid, baseCurrencyId(ORG));
  // Seeded rows carry no extra field: portal /_api/ output would show it.
  assert.ok(rows.every((row) => Object.keys(row).every((key) => !key.startsWith("__"))));
  // The base currency is found by id, not by position: the portal's first currency is not the base.
  assert.equal(baseCurrencyRow(store, ORG).currencyname, "Base currency");
  assert.equal(baseCurrencyRow(store, "not-a-guid"), null);
});

test("API-created and seeded user rows are ordinary rows with no extra field", async () => {
  const store = await seeded();
  await createApplicationUser(store, SETTINGS, { appId: APP_2, displayName: "Second App", roles: ["Basic User"] });
  const row = store.state.tables.systemuser.find((u) => u.applicationid === APP_2);
  assert.ok(row);
  assert.ok(store.state.tables.systemuser.find((u) => u.fullname === "SYSTEM"));
  for (const user of store.state.tables.systemuser) assert.ok(Object.keys(user).every((key) => !key.startsWith("__")));
});

const ref = (value) => value?.id ?? value;
const BASIC_ROLE = uuidV5(ORG, "role:Basic User");
const staffRow = (store, id) => store.tableRows("systemuser").find((u) => u.systemuserid === id);

async function addStaff(store, name, { parent = null, bu = ROOT, roles = [] } = {}) {
  const id = uuidV5(ORG, `systemuser:staff:${name}`);
  await store.transact(() => store.state.tables.systemuser.push({
    systemuserid: id, fullname: name, azureactivedirectoryobjectid: uuidV5(ORG, `oid:staff:${name}`), accessmode: 0,
    isdisabled: false, businessunitid: BU_REF(bu), organizationid: ORG_REF,
    parentsystemuserid: parent ? { id: parent, logical_name: "systemuser", name } : null,
  }));
  if (roles.length) await assignRoles(store, { systemuserid: id, roleIds: roles });
  return id;
}

test("team membershiptype values and the Entra alternate key refuse a second team with the same group and type", async () => {
  const store = await seeded();
  assert.deepEqual(TEAM_MEMBERSHIP, { MembersAndGuests: 0, Members: 1, Owners: 2, Guests: 3 });
  assert.deepEqual(store.state.mappings.team.alternateKeys, [
    { name: "team_aadobjectid_membershiptype", attributes: ["azureactivedirectoryobjectid", "membershiptype"] },
  ]);
  const GROUP = "cccccccc-0000-4000-8000-000000000002";
  const base = { teamtype: 2, azureactivedirectoryobjectid: GROUP, businessunitid: BU_REF(ROOT), organizationid: ORG_REF };
  const teams = store.state.tables.team;
  const sales = { ...base, teamid: uuidV5(ORG, "team:Sales"), name: "Sales", membershiptype: TEAM_MEMBERSHIP.Members };
  teams.push(sales);
  const clash = { ...base, teamid: uuidV5(ORG, "team:Sales2"), name: "Sales again", membershiptype: TEAM_MEMBERSHIP.Members };
  assert.throws(() => store.assertAlternateKeys(store.state.mappings.team, clash, teams, -1), (e) => e.status === 412 && e.code === "DuplicateRecord");
  const owners = { ...clash, teamid: uuidV5(ORG, "team:Sales3"), name: "Sales owners", membershiptype: TEAM_MEMBERSHIP.Owners };
  assert.doesNotThrow(() => store.assertAlternateKeys(store.state.mappings.team, owners, teams, -1));
});

test("hierarchy walks the parent lookup up and down, stops at the cap, and reports no hierarchy for a flat table", async () => {
  const store = await seeded();
  const names = ["C0", "C1", "C2", "C3"];
  for (let i = 0; i < names.length; i++) {
    await addStaff(store, names[i], { parent: i ? uuidV5(ORG, `systemuser:staff:${names[i - 1]}`) : null });
  }
  const c = (name) => uuidV5(ORG, `systemuser:staff:${name}`);
  const id = dataverseIdentity(store, staffRow(store, c("C0")));
  assert.deepEqual([...id.userHierarchy(c("C0"))].sort(), [c("C1"), c("C2"), c("C3")].sort());
  assert.deepEqual([...id.hierarchy("systemuser", "parentsystemuserid", c("C3"), "above")].sort(), [c("C0"), c("C1"), c("C2")].sort());
  assert.deepEqual([...id.hierarchy("systemuser", "parentsystemuserid", c("C2"), "eq-or-under")].sort(), [c("C2"), c("C3")].sort());
  assert.equal(id.hierarchy("region", "regionid", "r1", "under"), null);

  store.state.mappings.widget.relationships = {
    widget_parent: { entity: "widget", from: "widgetid", to: "parentwidgetid", many: true, hierarchical: true },
  };
  await store.transact(() => {
    for (let i = 0; i < 105; i++) {
      store.state.tables.widget.push({ widgetid: `w${i}`, parentwidgetid: i ? { id: `w${i - 1}`, logical_name: "widget" } : null });
    }
  });
  const widgets = dataverseIdentity(store, staffRow(store, c("C0")));
  assert.equal(widgets.hierarchy("widget", "parentwidgetid", "w0", "under").size, 100, "the walk stops after 100 levels");
  assert.deepEqual([...widgets.hierarchy("widget", "parentwidgetid", "w2", "above")], ["w1", "w0"]);
  assert.equal(widgets.hierarchy("widget", "parentwidgetid", "w2", "eq-or-above").has("w2"), true);
});

test("standard account hierarchy walks parentaccountid in both directions; the many-to-one side is not the primary key", async () => {
  const store = await standardSeeded();
  const basic = createPrincipals(store, SETTINGS).resolve({ oid: BASIC_OID }).user;
  const r1 = await addStaff(store, "AR1", { parent: basic.systemuserid });
  const r2 = await addStaff(store, "AR2", { parent: r1 });
  const owner = (id) => ({ id, logical_name: "systemuser" });
  const account = (accountid, ownerid, parent) => ({ accountid, name: accountid, ownerid: owner(ownerid), parentaccountid: parent ? { id: parent, logical_name: "account" } : null });
  store.state.tables.account = [account("acc-top", r1), account("acc-child", r2, "acc-top"), account("acc-grand", r2, "acc-child")];
  const id = dataverseIdentity(store, basic);
  assert.deepEqual([...id.hierarchy("account", "accountid", "acc-top", "under")].sort(), ["acc-child", "acc-grand"]);
  assert.deepEqual([...id.hierarchy("account", "accountid", "acc-grand", "above")].sort(), ["acc-child", "acc-top"]);
  assert.equal(id.hierarchy("account", "accountid", "acc-grand", "eq-or-above").has("acc-grand"), true);
});

test("a manager reads and writes a direct report, reads nondirect reports down to the depth, and nothing deeper", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const r1 = await addStaff(store, "R1", { parent: basic.systemuserid });
  const r2 = await addStaff(store, "R2", { parent: r1 });
  const r3 = await addStaff(store, "R3", { parent: r2 });
  const r4 = await addStaff(store, "R4", { parent: r3 });
  const owned = (id, widgetid) => ({ widgetid, ownerid: { id, logical_name: "systemuser" } });
  const rows = { w1: owned(r1, "w1"), w2: owned(r2, "w2"), w3: owned(r3, "w3"), w4: owned(r4, "w4") };
  await store.transact(() => store.state.tables.widget.push(...Object.values(rows)));
  const denied = (fn) => assert.throws(fn, denial("AccessDenied", "0x80048306"));

  denied(() => p.authorize({ user: basic, entity: "widget", operation: "update", row: rows.w1 }));
  await setHierarchySecurity(store, ORG, { enabled: true });
  assert.equal(p.authorize({ user: basic, entity: "widget", operation: "update", row: rows.w1 }), DEPTH.Deep);
  assert.equal(p.authorize({ user: basic, entity: "widget", operation: "read", row: rows.w3 }), DEPTH.Deep);
  denied(() => p.authorize({ user: basic, entity: "widget", operation: "update", row: rows.w2 }));
  denied(() => p.authorize({ user: basic, entity: "widget", operation: "read", row: rows.w4 }));
  const keep = p.readFilter({ user: basic, entity: "widget" });
  assert.deepEqual(store.tableRows("widget").filter(keep).map((r) => r.widgetid), ["w1", "w2", "w3"]);
  assert.equal(p.principalAccess({ user: basic, entity: "widget", row: rows.w2 }), "ReadAccess, CreateAccess");
  assert.equal(p.principalAccess({ user: basic, entity: "widget", row: rows.w1 }).includes("WriteAccess"), true);

  await setHierarchySecurity(store, ORG, { enabled: true, depth: 2 });
  denied(() => p.authorize({ user: basic, entity: "widget", operation: "read", row: rows.w3 }));
  await setHierarchySecurity(store, ORG, { enabled: false });
  denied(() => p.authorize({ user: basic, entity: "widget", operation: "update", row: rows.w1 }));
});

test("a manager needs the Read privilege, and a report must be in the manager's business unit or below it", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  await setHierarchySecurity(store, ORG, { enabled: true });
  const sales = await addBusinessUnit(store, "Sales");
  const sibling = await addBusinessUnit(store, "Sibling");
  const manager = await addStaff(store, "Mgr", { bu: sales, roles: [BASIC_ROLE] });
  const inSales = await addStaff(store, "InSales", { parent: manager, bu: sales });
  const inSibling = await addStaff(store, "InSibling", { parent: manager, bu: sibling });
  const inRoot = await addStaff(store, "InRoot", { parent: manager, bu: ROOT });
  const owned = (id) => ({ widgetid: `w-${id}`, ownerid: { id, logical_name: "systemuser" } });
  await store.transact(() => store.state.tables.widget.push(owned(inSales), owned(inSibling), owned(inRoot)));
  const managerUser = staffRow(store, manager);

  assert.equal(p.authorize({ user: managerUser, entity: "widget", operation: "update", row: owned(inSales) }), DEPTH.Deep);
  const denied = (fn) => assert.throws(fn, denial("AccessDenied", "0x80048306"));
  denied(() => p.authorize({ user: managerUser, entity: "widget", operation: "read", row: owned(inSibling) }));
  denied(() => p.authorize({ user: managerUser, entity: "widget", operation: "read", row: owned(inRoot) }));

  // Without the user-level Read privilege a manager sees nothing of its reports.
  const noRead = await addStaff(store, "NoRead");
  const under = await addStaff(store, "Under", { parent: noRead });
  await store.transact(() => store.state.tables.widget.push(owned(under)));
  assert.throws(
    () => p.authorize({ user: staffRow(store, noRead), entity: "widget", operation: "read", row: owned(under) }),
    denial("PrivilegeDenied", "0x80040220"),
  );
});

test("syncGroupMembership adds the user to group teams in the token, removes it when a group is gone, and keeps owner teams", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const member = p.resolve({ oid: NOROLE_OID }).user;
  const G1 = "cccccccc-0000-4000-8000-000000000011", G2 = "cccccccc-0000-4000-8000-000000000012";
  const group1 = uuidV5(ORG, "team:G1"), group2 = uuidV5(ORG, "team:G2");
  const owner = await makeTeam(store, "Owners", { members: [member] });
  await store.transact(() => {
    store.state.tables.team.push(
      { teamid: group1, name: "G1", teamtype: 2, membershiptype: TEAM_MEMBERSHIP.Members, azureactivedirectoryobjectid: G1, businessunitid: BU_REF(ROOT), organizationid: ORG_REF },
      { teamid: group2, name: "G2", teamtype: 3, membershiptype: TEAM_MEMBERSHIP.Members, azureactivedirectoryobjectid: G2, businessunitid: BU_REF(ROOT), organizationid: ORG_REF },
    );
  });
  const result = await syncGroupMembership(store, member, [G1, G2]);
  assert.deepEqual(result.teamIds.sort(), [group1, group2].sort());
  assert.deepEqual(teamsOfUser(store, member.systemuserid).sort(), [owner, group1, group2].sort());

  await syncGroupMembership(store, member, [G1]);
  assert.deepEqual(teamsOfUser(store, member.systemuserid).sort(), [owner, group1].sort());
  assert.equal(store.tableRows("teammembership").filter((m) => ref(m.teamid) === owner).length, 1);

  await store.transact(() => { staffRow(store, member.systemuserid).isdisabled = true; });
  const disabled = await syncGroupMembership(store, member, [G1]);
  assert.deepEqual(disabled.teamIds, []);
  assert.deepEqual(teamsOfUser(store, member.systemuserid), [owner]);
});

test("SetBusinessSystemUser removes role assignments, moves the user's owned records, and refuses a disabled business unit", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const sales = await addBusinessUnit(store, "Sales");
  const closed = await addBusinessUnit(store, "Closed");
  await store.transact(() => { store.state.tables.businessunit.find((b) => b.businessunitid === closed).isdisabled = true; });
  await store.transact(() => store.state.tables.widget.push({ widgetid: "w-bu", name: "mine", ownerid: lookupOf(basic) }));
  assert.ok(store.tableRows("systemuserroles").some((r) => ref(r.systemuserid) === basic.systemuserid));

  await assert.rejects(
    setBusinessUnit(store, { userId: basic.systemuserid, businessUnitId: closed }),
    (e) => e.status === 400 && e.details?.innerCode === "0x8004032d",
  );
  await setBusinessUnit(store, { userId: basic.systemuserid, businessUnitId: sales });
  assert.equal(ref(staffRow(store, basic.systemuserid).businessunitid), sales);
  assert.equal(store.tableRows("systemuserroles").some((r) => ref(r.systemuserid) === basic.systemuserid), false);
  assert.equal(ref(store.tableRows("widget").find((w) => w.widgetid === "w-bu").owningbusinessunit), sales);
});

test("platform tables: Basic User reads only its own system jobs, cannot write background operations, and creates its own saved views", async () => {
  const state = fixtureState();
  const owned = { ownerid: { dataverseType: "lookup" } };
  for (const [logical, set, id] of [["asyncoperation", "asyncoperations", "asyncoperationid"], ["backgroundoperation", "backgroundoperations", "backgroundoperationid"], ["userquery", "userqueries", "userqueryid"], ["savedquery", "savedqueries", "savedqueryid"]]) {
    state.mappings[logical] = { logicalName: logical, entitySet: set, idColumn: id, nameColumn: "name", userConfigured: true, dataverseOnly: true, fields: owned };
    state.tables[logical] = [];
  }
  const store = new DataStore({ state });
  await ensureSecurityModel(store, SETTINGS);
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const mine = { asyncoperationid: "job-mine", ownerid: lookupOf(basic) };
  const theirs = { asyncoperationid: "job-theirs", ownerid: lookupOf(admin) };

  assert.equal(p.authorize({ user: basic, entity: "asyncoperation", operation: "read", row: mine }), 1);
  assert.throws(
    () => p.authorize({ user: basic, entity: "asyncoperation", operation: "read", row: theirs }),
    denial("AccessDenied", "0x80048306"),
  );
  assert.throws(
    () => p.authorize({ user: basic, entity: "backgroundoperation", operation: "write", row: { backgroundoperationid: "bg", ownerid: lookupOf(basic) } }),
    (e) => denial("PrivilegeDenied", "0x80040220")(e) && e.details.privilege === "prvWriteBackgroundOperation",
  );
  assert.equal(p.authorize({ user: basic, entity: "userquery", operation: "create" }), 1);
  assert.equal(p.privileges(basic).get("prvCreateUserQuery"), DEPTH.Basic);
  // Saved views (SavedQuery) are read at Global; the brief's depths for the other platform tables leave Basic User without a grant.
  assert.equal(p.privileges(basic).get("prvReadSavedQuery"), DEPTH.Global);
  assert.equal(p.privileges(basic).has("prvReadAuditSummary"), false);
  assert.equal(p.privileges(basic).has("prvReadBulkDeleteOperation"), false);
});

test("prvBulkDelete is System Administrator only; the bulk-delete name and the systemuser noun are exported for other modules", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const basic = p.resolve({ oid: BASIC_OID }).user;
  assert.equal(p.privileges(admin).get("prvBulkDelete"), DEPTH.Global);
  assert.equal(p.privileges(basic).has("prvBulkDelete"), false);
  const customizer = uuidV5(ORG, "role:System Customizer");
  assert.equal(store.tableRows("roleprivileges").some((rp) => rp.roleid.id === customizer && rp.privilegeid.id === privilegeId(ORG, "prvBulkDelete")), false);
  assert.equal(privilegeNounOf("systemuser"), "User");
  assert.equal(privilegeNounOf("systemuserroles"), "User");
  assert.equal(privilegeNounOf("savedquery"), "SavedQuery");
  assert.equal(privilegeNounOf("widget", { schemaName: "Widget" }), "Widget");
});

// T5 (standard-tables-plan 4.3): the standard file seeds the tables, and the security model is generated from them.
async function standardSeeded() {
  const store = new DataStore({ state: fixtureState() });
  seedStandard(store);
  await ensureSecurityModel(store, SETTINGS, { schema: standardSchema() });
  return store;
}

test("T5: activity tables use the Activity privileges, notes Note, email templates EmailTemplate, None-owned tables none", async () => {
  const store = await standardSeeded();
  const names = new Set(store.state.tables.privilege.map((p) => p.name));
  for (const table of ["task", "email", "phonecall", "appointment", "activitypointer"]) assert.equal(privilegeNounOf(table), "Activity", table);
  assert.equal(privilegeName("Read", privilegeNounOf("task")), "prvReadActivity");
  assert.equal(privilegeNounOf("annotation"), "Note");
  assert.equal(privilegeNounOf("template"), "EmailTemplate");
  for (const right of ["Create", "Read", "Write", "Delete", "Append", "AppendTo", "Assign", "Share"]) assert.ok(names.has(`prv${right}Activity`), right);
  assert.ok(names.has("prvReadNote") && names.has("prvCreateNote") && names.has("prvReadEmailTemplate"));
  assert.ok(!names.has("prvReadTask") && !names.has("prvCreateEmail") && !names.has("prvReadAnnotation"));
  // OwnershipType None in the standard file: no privileges (and no rows of privilege or principalobjectaccess names).
  assert.ok(![...names].some((name) => /Privilege$|PrincipalObjectAccess$/.test(name)), "none-owned tables have no privileges");
  // Standard OwnershipType names; the security tables keep their platform values.
  assert.equal(ownershipTypeName("organization"), "OrganizationOwned");
  assert.equal(ownershipTypeName("transactioncurrency"), "OrganizationOwned");
  assert.equal(ownershipTypeName("privilege"), "None");
  assert.equal(ownershipTypeName("roleprivileges"), "None");
  assert.equal(ownershipTypeName("principalobjectaccess"), "None");
  assert.equal(ownershipTypeName("account"), "UserOwned");
  assert.equal(ownershipTypeName("systemuser"), "BusinessOwned");
});

test("T5: a Basic User creating a task is checked for prvCreateActivity and holds it at Basic", async () => {
  const store = await standardSeeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  assert.equal(p.privileges(basic).get("prvCreateActivity"), DEPTH.Basic);
  assert.equal(p.privileges(basic).has("prvCreateTask"), false);
  assert.equal(p.authorize({ user: basic, entity: "task", operation: "create" }), DEPTH.Basic);
});

test("T5: System Customizer reads only its own accounts (Basic) but custom tables at Global", async () => {
  const store = await standardSeeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const norole = p.resolve({ oid: NOROLE_OID }).user;
  await assignRoles(store, { systemuserid: norole.systemuserid, roleIds: [uuidV5(ORG, "role:System Customizer")] });
  const customizer = p.resolve({ oid: NOROLE_OID }).user;
  assert.equal(p.privileges(customizer).get("prvReadAccount"), DEPTH.Basic);
  assert.equal(p.privileges(customizer).get("prvReadActivity"), DEPTH.Basic);
  assert.equal(p.privileges(customizer).get("prvReadWidget"), DEPTH.Global);
  assert.throws(() => p.authorize({ user: customizer, entity: "account", operation: "read", row: { accountid: "acc-theirs", ownerid: lookupOf(admin) } }), denial("AccessDenied", "0x80048306"));
  assert.equal(p.authorize({ user: customizer, entity: "widget", operation: "read", row: { widgetid: "w-theirs", ownerid: lookupOf(admin) } }), DEPTH.Global);
});

test("None-owned tables: System Administrator creates and reads activity parties, customer addresses, queue items and environment variable values", async () => {
  const store = await standardSeeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  for (const entity of ["activityparty", "customeraddress", "queueitem", "environmentvariablevalue"]) {
    assert.equal(p.authorize({ user: admin, entity, operation: "create" }), DEPTH.Global, `${entity} create`);
    assert.equal(p.authorize({ user: admin, entity, operation: "read" }), DEPTH.Global, `${entity} read`);
  }
  // Queue items and environment variable values have their own privileges; the parent-following tables have none.
  const names = new Set(store.state.tables.privilege.map((row) => row.name));
  assert.ok(names.has("prvReadQueueItem") && names.has("prvCreateEnvironmentVariableValue"));
  assert.ok(!names.has("prvReadCustomerAddress") && !names.has("prvReadActivityParty"));
});

test("standard plug-in and process tables get privileges named from their Learn SchemaName", async () => {
  const store = await standardSeeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const names = new Set(store.state.tables.privilege.map((row) => row.name));
  for (const name of ["prvCreatePluginAssembly", "prvReadSdkMessageProcessingStep", "prvCreateWorkflow", "prvReadSystemForm", "prvReadKbArticle", "prvReadKnowledgeArticle"])
    assert.ok(names.has(name), name);
  // Without a schema argument the privilege noun still follows the Learn SchemaName (knowledgearticle, not Knowledgearticle).
  for (const entity of ["pluginassembly", "sdkmessageprocessingstep", "workflow", "systemform", "knowledgearticle"])
    assert.equal(p.authorize({ user: admin, entity, operation: "create", mapping: store.resolveMapping(entity) }), DEPTH.Global, entity);
});

test("activity parties follow their activity: a Basic User reads a party only when it can read the activity", async () => {
  const store = await standardSeeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const basic = p.resolve({ oid: BASIC_OID }).user;
  store.state.tables.task = [
    { activityid: "act-own", subject: "mine", ownerid: lookupOf(basic) },
    { activityid: "act-theirs", subject: "theirs", ownerid: lookupOf(admin) },
  ];
  const party = (activity) => ({ activitypartyid: `party-${activity}`, activityid: { id: activity, logical_name: "task" } });
  assert.equal(p.authorize({ user: basic, entity: "activityparty", operation: "read", row: party("act-own") }), DEPTH.Basic);
  assert.throws(() => p.authorize({ user: basic, entity: "activityparty", operation: "read", row: party("act-theirs") }), denial("AccessDenied", "0x80048306"));
  // Without a row (a table-level read) the Activity privilege alone passes at its depth.
  assert.equal(p.authorize({ user: basic, entity: "activityparty", operation: "read" }), DEPTH.Basic);
  // The list filter keeps the party whose activity Basic can read and drops the other.
  const readable = p.readFilter({ user: basic, entity: "activityparty" });
  assert.equal(readable(party("act-own")), true);
  assert.equal(readable(party("act-theirs")), false);
});

test("customer addresses follow their parent account: the row test is the parent's, and a Basic User without the parent is denied", async () => {
  const store = await standardSeeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const basic = p.resolve({ oid: BASIC_OID }).user;
  store.state.tables.account = [
    { accountid: "acc-own", name: "mine", ownerid: lookupOf(basic) },
    { accountid: "acc-theirs", name: "theirs", ownerid: lookupOf(admin) },
  ];
  const address = (parent) => ({ customeraddressid: `addr-${parent}`, parentid: { id: parent, logical_name: "account" }, objecttypecode: "account" });
  assert.equal(p.authorize({ user: basic, entity: "customeraddress", operation: "read", row: address("acc-own") }), DEPTH.Basic);
  assert.throws(() => p.authorize({ user: basic, entity: "customeraddress", operation: "read", row: address("acc-theirs") }), denial("AccessDenied", "0x80048306"));
  const readable = p.readFilter({ user: basic, entity: "customeraddress" });
  assert.equal(readable(address("acc-own")), true);
  assert.equal(readable(address("acc-theirs")), false);
  // Creating a customer address needs the account or contact privilege at table level; Basic User holds the account one.
  assert.equal(p.authorize({ user: basic, entity: "customeraddress", operation: "create" }), DEPTH.Basic);
  // A parent missing from the store is shown to System Administrator only.
  assert.equal(p.readFilter({ user: admin, entity: "customeraddress" })(address("acc-missing")), true);
  assert.equal(p.readFilter({ user: basic, entity: "customeraddress" })(address("acc-missing")), false);
});

test("queue items and environment variable values: Basic User has no grant, administrators have organization depth", async () => {
  const store = await standardSeeded();
  const p = createPrincipals(store, SETTINGS);
  const basic = p.resolve({ oid: BASIC_OID }).user;
  assert.throws(() => p.authorize({ user: basic, entity: "queueitem", operation: "read" }), denial("PrivilegeDenied", "0x80040220"));
  assert.throws(() => p.authorize({ user: basic, entity: "environmentvariablevalue", operation: "create" }), denial("PrivilegeDenied", "0x80040220"));
});

// A Solution table keeps its mixed-case SchemaName on its mapping (dataverseMetadata.schemaName), so every privilege noun uses it.
test("a Solution table's mixed-case SchemaName names its privileges, its access check and the Basic User denial", async () => {
  const state = fixtureState();
  state.mappings.new_bankaccount = {
    logicalName: "new_bankaccount", entitySet: "new_bankaccounts", idColumn: "new_bankaccountid", nameColumn: "new_name",
    fields: { new_name: { dataverseType: "nvarchar" }, ownerid: { dataverseType: "lookup" } },
    dataverseMetadata: { schemaName: "new_BankAccount" },
  };
  state.tables.new_bankaccount = [];
  // Cloned before seeding: the metadata-API variant is seeded from the same unseeded state.
  const createdState = structuredClone(state);
  createdState.mappings.new_bankaccount.dataverseMetadata = { schemaName: "new_BankAccount", createdByMetadataApi: true };
  const store = new DataStore({ state });
  await ensureSecurityModel(store, SETTINGS);
  const names = new Set(store.state.tables.privilege.map((p) => p.name));
  assert.ok(names.has("prvReadnew_BankAccount") && !names.has("prvReadNew_bankaccount"));
  assert.equal(privilegeNounOf("new_bankaccount", undefined, state.mappings.new_bankaccount), "new_BankAccount");
  assert.equal(privilegeNounOf("new_bankaccount", { schemaName: "new_BankAccount" }), "new_BankAccount");

  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  assert.equal(p.privileges(admin).get("prvReadnew_BankAccount"), DEPTH.Global);
  assert.doesNotThrow(() => p.authorize({ user: admin, entity: "new_bankaccount", operation: "read" }));
  assert.match(p.principalAccess({ user: admin, entity: "new_bankaccount" }), /ReadAccess/);

  // A table made through the metadata API is administrator-only: a Basic User's read is refused naming the SchemaName privilege.
  const created = new DataStore({ state: createdState });
  await ensureSecurityModel(created, SETTINGS);
  const pc = createPrincipals(created, SETTINGS);
  const basic = pc.resolve({ oid: BASIC_OID }).user;
  assert.throws(
    () => pc.authorize({ user: basic, entity: "new_bankaccount", operation: "read" }),
    (e) => denial("PrivilegeDenied", "0x80040220")(e) && e.details.privilege === "prvReadnew_BankAccount" && e.message.includes("prvReadnew_BankAccount"),
  );
});

// None-owned platform tables: they take their parent's privilege (Learn: OwnershipType None, with the parent lookup), and the timezone
// tables are open reads. The mapping of each to its parent is unverified: live capture. Administrators pass all ten; a Basic User reads the timezone tables.
test("None-owned platform tables: administrators read each through its parent privilege; a Basic User reads the timezone tables", async () => {
  const store = await standardSeeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user, basic = p.resolve({ oid: BASIC_OID }).user;
  const parents = {
    calendarrule: "calendar", appmodulecomponent: "appmodule", attributemaskingrule: "maskingrule", workflowlog: "workflow",
    activitymimeattachment: "activitypointer", solutioncomponent: "solution", dependency: "solution",
    timezonedefinition: null, timezonerule: null, timezonelocalizedname: null,
  };
  for (const entity of Object.keys(parents)) {
    assert.doesNotThrow(() => p.authorize({ user: admin, entity, operation: "read" }), entity);
    assert.ok(!store.state.tables.privilege.some((row) => row.name === `prvRead${entity}`), `no table privilege of its own: ${entity}`);
  }
  assert.equal(privilegeNounOf("calendarrule", undefined, store.state.mappings.calendarrule), "Calendar");
  assert.equal(privilegeNounOf("solutioncomponent"), "Solution");
  assert.equal(privilegeNounOf("activitymimeattachment"), "Activity");
  for (const entity of ["timezonedefinition", "timezonerule", "timezonelocalizedname"]) {
    assert.doesNotThrow(() => p.authorize({ user: basic, entity, operation: "read" }), entity);
    assert.equal(p.readFilter({ user: basic, entity }), null, `no row filter on ${entity}`);
  }
  // Writes on the timezone tables stay denied: only reads are open.
  assert.throws(() => p.authorize({ user: basic, entity: "timezonerule", operation: "create" }), denial("PrivilegeDenied", "0x80040220"));
});

// Skip sweep 2026-10-20: the None-owned tables added to the standard file, and queue membership, resolve to their parent's privilege noun.
test("skip-sweep None-owned and intersect tables take their parent's privilege noun", () => {
  const parents = {
    postregarding: "post", privilegecheckerlog: "privilegecheckerrun", knowledgearticleviews: "knowledgearticle", processstage: "workflow",
    reportcategory: "report", rollupfield: "metric", duplicaterecord: "duplicaterule", queuemembership: "queue",
    columnmapping: "importmap", picklistmapping: "importmap", lookupmapping: "importmap", ownermapping: "importmap",
    importentitymapping: "importmap", transformationmapping: "importmap", transformationparametermapping: "importmap",
    msdyn_aiconfiguration: "msdyn_aimodel",
  };
  for (const [entity, parent] of Object.entries(parents)) {
    assert.equal(privilegeNounOf(entity), privilegeNounOf(parent), `${entity} follows ${parent}`);
  }
});

// Startup wiring: the Solution schema is passed to seeding and to the principals (dataverse-api), so a check with no schema argument
// names the privilege the way the seeding did. The table's SchemaName differs from its capitalised logical name.
test("a Solution table seeded at startup: the create check with no schema argument uses the same SchemaName as the seeding", async () => {
  const state = fixtureState();
  state.mappings.new_bankaccount = {
    logicalName: "new_bankaccount", entitySet: "new_bankaccounts", idColumn: "new_bankaccountid", nameColumn: "new_name",
    fields: { new_name: { dataverseType: "nvarchar" }, ownerid: { dataverseType: "lookup" } },
  };
  state.tables.new_bankaccount = [];
  const schema = { tables: { new_bankaccount: { logicalName: "new_bankaccount", schemaName: "new_BankAccount" } } };
  const store = new DataStore({ state });
  await ensureSecurityModel(store, SETTINGS, { schema });
  const p = createPrincipals(store, { ...SETTINGS, schema: () => schema });
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  assert.equal(p.privileges(admin).get("prvCreatenew_BankAccount"), DEPTH.Global);
  assert.doesNotThrow(() => p.authorize({ user: admin, entity: "new_bankaccount", operation: "create" }));
  assert.equal(p.privilegeNoun("new_bankaccount"), "new_BankAccount");
});
