// Simulated Dataverse security model: seeding, principal resolution, depth-based
// authorization, role-privilege introspection. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import {
  ACCESS_RIGHTS,
  assignRoles,
  createApplicationUser,
  createPrincipals,
  ensureSecurityModel,
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
  // widget: 8 user-owned rights; region: 6 org-owned rights; ten security tables: 6 each; plus prvActOnBehalfOfAnotherUser.
  assert.equal(t.privilege.length, 8 + 6 + 60 + 1);
  // Admins: every privilege at Global (2 x 75). Basic User: 8 widget rights + Global Read on 11 org-owned tables.
  assert.equal(t.roleprivileges.length, 150 + 8 + 11);
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
  assert.equal(p.authorize({ user: norole, entity: "widget", operation: "read", row: { widgetid: "w" } }), 1);
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
  assert.equal(privs.length, 19);
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
