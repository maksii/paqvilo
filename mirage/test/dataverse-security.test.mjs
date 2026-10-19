// Simulated Dataverse security model: seeding, principal resolution, depth-based
// authorization, role-privilege introspection. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import {
  ACCESS_RIGHTS,
  DEPTH,
  assignRoles,
  createApplicationUser,
  createPrincipals,
  ensureSecurityModel,
  isInteractiveUser,
  ownerColumns,
  privilegeDeniedError,
  privilegeId,
  uuidV5,
} from "../lib/dataverse-security.mjs";

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

const lookupOf = (user) => ({ id: user.systemuserid, logical_name: "systemuser", name: user.fullname });
const denial = (code, inner) => (e) => e.status === 403 && e.code === code && e.details?.innerCode === inner;

test("ensureSecurityModel seeds organization, root unit, roles, SYSTEM user and privileges", async () => {
  const store = await seeded();
  const t = store.state.tables;
  assert.equal(t.organization.length, 1);
  assert.equal(t.businessunit.length, 1);
  assert.equal(t.businessunit[0].businessunitid, ROOT);
  assert.deepEqual(t.role.map((r) => r.name).sort(), ["Basic User", "System Administrator", "System Customizer"]);
  assert.ok(t.systemuser.some((u) => u.fullname === "SYSTEM" && u.systemuserid === uuidV5(ORG, "systemuser:SYSTEM")));
  // widget: 8 user-owned rights; region: 6 org-owned rights; eleven security tables: 6 each; plus prvActOnBehalfOfAnotherUser and prvBypassCustomPlugins.
  assert.equal(t.privilege.length, 8 + 6 + 66 + 2);
  // Admins: every privilege at Global (2 x 82). Basic User: 8 widget rights + Global Read on 12 org-owned tables.
  assert.equal(t.roleprivileges.length, 164 + 8 + 12);
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
  assert.equal(privs.length, 20);
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

test("prvBypassCustomPlugins is seeded for System Administrator and System Customizer only", async () => {
  const store = await seeded();
  const p = createPrincipals(store, SETTINGS);
  const admin = p.resolve({ oid: ADMIN_OID }).user;
  const basic = p.resolve({ oid: BASIC_OID }).user;
  const norole = p.resolve({ oid: NOROLE_OID }).user;
  assert.ok(store.tableRows("privilege").some((r) => r.name === "prvBypassCustomPlugins" && r.privilegeid === privilegeId(ORG, "prvBypassCustomPlugins")));
  assert.equal(p.privileges(admin).get("prvBypassCustomPlugins"), DEPTH.Global);
  assert.equal(p.privileges(basic).has("prvBypassCustomPlugins"), false);
  await assignRoles(store, { systemuserid: norole.systemuserid, roleIds: [uuidV5(ORG, "role:System Customizer")] });
  assert.equal(p.privileges(norole).get("prvBypassCustomPlugins"), DEPTH.Global);
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
  assert.ok(built.message.includes(`roleCount=1, privilegeCount=20, accessMode=0)`), built.message);
  assert.ok(built.message.includes(`(Id=${privilegeId(ORG, "prvCreateRegion")})`), built.message);
  assert.ok(built.message.includes(`context.Caller=${basic.systemuserid}.`), built.message);
});
