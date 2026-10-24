// Simulated Dataverse security messages (dataverse-security-messages.mjs and dataverse-security-messages2.mjs): role privileges,
// team membership and conversion, shares and shared links, parent users, the business unit hierarchy, owner reassignment,
// access-team templates, delegation, masked columns and Entra ID user lookups, through the registered operations.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { objectTypeCode } from "../lib/dataverse-metadata.mjs";
import { ACCESS_RIGHTS, createPrincipals, ensureSecurityModel, grantAccess, uuidV5 } from "../lib/dataverse-security.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { addonHandlers } from "../lib/dataverse-addon-common.mjs";
import { seed as seedStandard } from "../lib/dataverse-standard.mjs";
import { ensureTeamTemplates, install, reset } from "../lib/dataverse-security-messages.mjs";
import { install as installMessages2 } from "../lib/dataverse-security-messages2.mjs";

const ORIGIN = "https://org.example.test";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const UNKNOWN = "11111111-1111-4111-8111-111111111111";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const BASIC_OID = "aaaaaaaa-0000-4000-8000-000000000002";
const NOROLE_OID = "aaaaaaaa-0000-4000-8000-000000000003";
const GROUP_OID = "bbbbbbbb-0000-4000-8000-000000000001";
const ROOT = uuidV5(ORG, "businessunit:root");
const CLOCK = Date.UTC(2026, 9, 19, 9, 0, 0);
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
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
    // The owner lookup as a many-to-one relationship: the referencing (many) side is widget.
    relationships: { owner: { entity: "systemuser", from: "ownerid", to: "systemuserid", many: false, schemaName: "contoso_widget_owner", type: "many-to-one" } },
  };
  state.tables.widget = [];
  return state;
}

// standard: the standard tables, seeded first as at server start, so the security seeding grants their privileges. Their
// user-owned tables change which object type codes the reassignment accepts, so only the tests that need them ask for them.
async function setup({ standard = false } = {}) {
  const store = new DataStore({ state: fixtureState() });
  if (standard) await store.transact(() => seedStandard(store));
  await ensureSecurityModel(store, SETTINGS);
  const ops = [], hooks = {};
  // systemJob stands in for the async runner: the work runs at once and its message is recorded.
  const jobs = [];
  const principals = createPrincipals(store, SETTINGS);
  // The production shape: the server's change queue is a mutex, not a transaction. Writes open their own store.transact.
  const change = (fn) => fn();
  const api = {
    store,
    clock: () => CLOCK,
    change,
    principals,
    records: createRecordHandlers({ store, change, principals, clock: () => CLOCK }),
    registry: { register: (op) => ops.push(op) },
    recordHooks: { add: (name, fn) => (hooks[name] = fn) },
    systemJob: async (job, work) => { jobs.push({ ...job, message: await work() }); return job.name; },
  };
  await install(api);
  installMessages2(api);
  const invoke = (op, { user, target, params, body }) => op.handle({
    user, caller: null, target, params, body, identity: { admin: true },
    origin: ORIGIN, version: "v9.2", url: new URL(`${ORIGIN}/api/data/v9.2/`),
  });
  const call = (name, args) => invoke(ops.find((o) => o.name === name), args);
  // The operations registered once per entity (RetrievePrincipalAccessInfo is bound to systemuser and to team).
  const callOn = (name, entity, args) => invoke(ops.find((o) => o.name === name && o.entity === entity), args);
  return { store, hooks, ops, call, callOn, principals, api, jobs };
}

const userOf = (store, oid) => store.tableRows("systemuser").find((u) => u.azureactivedirectoryobjectid === oid);
const on = (store, logical, column, id) => ({ id, row: store.tableRows(logical).find((r) => r[column] === id) });
const denied = (promise) => assert.rejects(promise, (e) => e.status === 403 && e.code === "PrivilegeDenied" && e.details?.innerCode === "0x80040220");
const refused = (inner) => (e) => e.status === 400 && e.details?.innerCode === inner;
const idOf = (value) => (value && typeof value === "object" ? value.id : value);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const pid = (store, name) => store.tableRows("privilege").find((p) => p.name === name).privilegeid;

async function makeRole(store, name) {
  const roleid = uuidV5(ORG, `test-role:${name}`);
  await store.transact(() => store.state.tables.role.push({
    roleid, name, businessunitid: { id: ROOT, logical_name: "businessunit", name: "" }, organizationid: null, isinherited: 1,
  }));
  return roleid;
}

async function makeWidget(store, name, ownerId, ownerType = "systemuser") {
  const widgetid = uuidV5(ORG, `widget:${name}`);
  await store.transact(() => store.state.tables.widget.push({ widgetid, name, ownerid: { id: ownerId, logical_name: ownerType, name: "" } }));
  return widgetid;
}

async function makeTemplate(store, name, { mask, otc = objectTypeCode("widget") }) {
  const teamtemplateid = uuidV5(ORG, `teamtemplate:${name}`);
  await store.transact(async () => {
    await ensureTeamTemplates(store);
    store.state.tables.teamtemplate.push({ teamtemplateid, teamtemplatename: name, objecttypecode: otc, defaultaccessrightsmask: mask, issystem: false });
  }, { isolated: true });
  return teamtemplateid;
}

const noRoleOf = (store) => userOf(store, NOROLE_OID);
const memberOf = (user) => ({ "@odata.type": "#Microsoft.Dynamics.CRM.systemuser", ownerid: user.systemuserid });
const teamRow = (store, teamId) => store.tableRows("team").find((t) => same(t.teamid, teamId));

async function makeTeam(store, name, { teamtype, isdefault = false, aad = null }) {
  const teamid = uuidV5(ORG, `team:${name}`);
  await store.transact(() => store.state.tables.team.push({
    teamid, name, teamtype, isdefault, azureactivedirectoryobjectid: aad, businessunitid: { id: ROOT, logical_name: "businessunit", name: "" }, organizationid: null,
  }));
  return teamid;
}

const grantedNames = (result) => result.body.RolePrivileges.map((p) => `${p.PrivilegeName}:${p.Depth}`).sort();

test("AddPrivilegesRole grants at a depth, RetrieveRolePrivilegesRole reads it back, and a basic user is refused", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
  const target = on(store, "role", "roleid", await makeRole(store, "Reader"));
  const body = { Privileges: [{ Depth: "Local", PrivilegeId: pid(store, "prvReadWidget") }, { Depth: 3, PrivilegeId: pid(store, "prvWriteWidget") }] };
  await denied(call("AddPrivilegesRole", { user: basic, target, body }));
  const added = await call("AddPrivilegesRole", { user: admin, target, body });
  assert.equal(added.status, 204);
  const read = await call("RetrieveRolePrivilegesRole", { user: admin, params: { RoleId: target.id } });
  assert.match(read.body["@odata.context"], /#Microsoft\.Dynamics\.CRM\.RetrieveRolePrivilegesRoleResponse$/);
  assert.deepEqual(grantedNames(read), ["prvReadWidget:Local", "prvWriteWidget:Global"]);
});

test("RemovePrivilegeRole drops one grant by privilege reference and ReplacePrivilegesRole swaps the whole set", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID);
  const target = on(store, "role", "roleid", await makeRole(store, "Editor"));
  await call("AddPrivilegesRole", { user: admin, target, body: { Privileges: [{ Depth: "Local", PrivilegeId: pid(store, "prvReadWidget") }, { Depth: "Deep", PrivilegeId: pid(store, "prvWriteWidget") }] } });
  const writeId = pid(store, "prvWriteWidget");
  assert.equal((await call("RemovePrivilegeRole", { user: admin, target, body: { Privilege: { "@odata.id": `privileges(${writeId})` } } })).status, 204);
  assert.deepEqual(grantedNames(await call("RetrieveRolePrivilegesRole", { user: admin, params: { RoleId: target.id } })), ["prvReadWidget:Local"]);
  await call("ReplacePrivilegesRole", { user: admin, target, body: { Privileges: [{ Depth: "Basic", PrivilegeId: pid(store, "prvDeleteWidget") }] } });
  assert.deepEqual(grantedNames(await call("RetrieveRolePrivilegesRole", { user: admin, params: { RoleId: target.id } })), ["prvDeleteWidget:Basic"]);
});

test("privilege changes write audit actions 57-59 only while organization and role auditing are on", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID);
  const roleId = await makeRole(store, "Audited");
  const target = on(store, "role", "roleid", roleId);
  const readId = pid(store, "prvReadWidget");
  const body = { Privileges: [{ Depth: "Basic", PrivilegeId: readId }] };
  await call("AddPrivilegesRole", { user: admin, target, body });
  assert.equal((store.state.tables.audit ?? []).length, 0);
  await store.transact(() => {
    store.state.tables.organization[0].isauditenabled = true;
    store.state.mappings.role.dataverseMetadata = { IsAuditEnabled: true };
  });
  await call("AddPrivilegesRole", { user: admin, target, body });
  await call("RemovePrivilegeRole", { user: admin, target, body: { Privilege: { privilegeid: readId } } });
  await call("ReplacePrivilegesRole", { user: admin, target, body });
  const rows = store.state.tables.audit.filter((a) => a.objectid.id === roleId);
  assert.deepEqual(rows.map((a) => a.action), [57, 58, 59]);
  assert.ok(rows.every((a) => a.operation === 2 && a.objecttypecode === "role"));
});

test("a privilege denial on systemuser names prvReadUser, the noun the seeded privileges use", async () => {
  const { store } = await setup();
  const principals = createPrincipals(store, SETTINGS);
  const norole = userOf(store, NOROLE_OID);
  assert.throws(() => principals.authorize({ user: norole, entity: "systemuser", operation: "read" }), (e) => /prvReadUser\b/.test(e.message) && !/prvReadSystemuser/.test(e.message));
});

test("team grants reach members at Basic; AddMembersTeam and RemoveMembersTeam change membership", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), norole = userOf(store, NOROLE_OID);
  const teamId = uuidV5(ORG, "team:Sales");
  await store.transact(() => store.state.tables.team.push({ teamid: teamId, name: "Sales", teamtype: 0, businessunitid: { id: ROOT, logical_name: "businessunit", name: "" } }));
  const roleId = await makeRole(store, "Sales Reader");
  await call("AddPrivilegesRole", { user: admin, target: on(store, "role", "roleid", roleId), body: { Privileges: [{ Depth: "Global", PrivilegeId: pid(store, "prvReadWidget") }] } });
  await store.transact(() => store.state.tables.teamroles.push({ teamroleid: uuidV5(teamId, roleId), teamid: { id: teamId }, roleid: { id: roleId } }));
  const team = on(store, "team", "teamid", teamId), member = on(store, "systemuser", "systemuserid", norole.systemuserid);
  const members = { Members: [{ "@odata.type": "Microsoft.Dynamics.CRM.systemuser", ownerid: norole.systemuserid }] };
  assert.equal((await call("AddMembersTeam", { user: admin, target: team, body: members })).status, 204);

  const byName = await call("RetrieveUserPrivilegeByPrivilegeName", { user: admin, target: member, params: { PrivilegeName: "prvReadWidget" } });
  assert.deepEqual(grantedNames(byName), ["prvReadWidget:Basic"]);
  assert.deepEqual(grantedNames(await call("RetrieveTeamPrivileges", { user: admin, target: team })), ["prvReadWidget:Global"]);

  await call("RemoveMembersTeam", { user: admin, target: team, body: members });
  assert.equal(store.state.tables.teammembership.length, 0);
});

test("AddMembersTeam and RemoveMembersTeam take a systemuser reference keyed by systemuserid as well as ownerid", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), norole = userOf(store, NOROLE_OID);
  const teamId = uuidV5(ORG, "team:Keyed");
  await store.transact(() => store.state.tables.team.push({ teamid: teamId, name: "Keyed", teamtype: 0, businessunitid: { id: ROOT, logical_name: "businessunit", name: "" } }));
  const team = on(store, "team", "teamid", teamId);
  const members = { Members: [{ "@odata.type": "Microsoft.Dynamics.CRM.systemuser", systemuserid: norole.systemuserid }] };
  assert.equal((await call("AddMembersTeam", { user: admin, target: team, body: members })).status, 204);
  assert.equal(store.state.tables.teammembership.length, 1);
  assert.ok(same(store.state.tables.teammembership[0].systemuserid.id, norole.systemuserid));
  await call("RemoveMembersTeam", { user: admin, target: team, body: members });
  assert.equal(store.state.tables.teammembership.length, 0);
});

test("AddMembersTeam needs the @odata.type, refuses disabled users and needs prvWriteTeam", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID), norole = userOf(store, NOROLE_OID);
  const teamId = uuidV5(ORG, "team:Ops");
  await store.transact(() => store.state.tables.team.push({ teamid: teamId, name: "Ops", teamtype: 0 }));
  const team = on(store, "team", "teamid", teamId);
  await assert.rejects(call("AddMembersTeam", { user: admin, target: team, body: { Members: [{ ownerid: norole.systemuserid }] } }),
    (e) => e.status === 400 && /EdmEntityObject/.test(e.message));
  await store.transact(() => { norole.isdisabled = true; });
  await assert.rejects(call("AddMembersTeam", { user: admin, target: team, body: { Members: [{ "@odata.type": "Microsoft.Dynamics.CRM.systemuser", ownerid: norole.systemuserid }] } }), refused("0x80048d36"));
  await denied(call("AddMembersTeam", { user: basic, target: team, body: { Members: [] } }));
});

test("an access team cannot be given roles, through the teamroles association write hook", async () => {
  const { store, hooks } = await setup();
  const accessId = uuidV5(ORG, "team:Access"), ownerId = uuidV5(ORG, "team:Owner"), roleId = uuidV5(ORG, "test-role:any");
  await store.transact(() => store.state.tables.team.push({ teamid: accessId, name: "Access", teamtype: 1 }, { teamid: ownerId, name: "Owner", teamtype: 0 }));
  const associate = (teamid, relationship = "teamroles_association") => hooks.beforeWrite({}, { logicalName: "team" },
    { operation: "associate", data: { relationship, id: roleId }, existing: { teamid } });
  assert.throws(() => associate(accessId), refused("0x80048331"));
  assert.doesNotThrow(() => associate(ownerId));
  assert.doesNotThrow(() => associate(accessId, "teammembership_association"));
});

test("RetrieveSharedPrincipalsAndAccess lists the shares and RetrieveAccessOrigin names the owner or the share", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
  const widgetId = await makeWidget(store, "one", admin.systemuserid);
  await grantAccess(store, { target: { id: widgetId, logical: "widget" }, principal: { id: basic.systemuserid }, mask: ACCESS_RIGHTS.Read });
  const Target = { "@odata.id": `widgets(${widgetId})` };
  const shared = await call("RetrieveSharedPrincipalsAndAccess", { user: admin, params: { Target } });
  assert.equal(shared.body.PrincipalAccesses.length, 1);
  assert.equal(shared.body.PrincipalAccesses[0].AccessMask, "ReadAccess");
  assert.equal(shared.body.PrincipalAccesses[0].Principal.ownerid, basic.systemuserid);
  const origin = (principal) => call("RetrieveAccessOrigin", { user: admin, params: { ObjectId: widgetId, LogicalName: "widget", PrincipalId: principal } });
  assert.match((await origin(admin.systemuserid)).body.Response, /object owner/);
  assert.equal((await origin(basic.systemuserid)).body.Response, `PrincipalId has direct poa access to object (${widgetId})`);
  assert.equal((await origin(noRoleOf(store).systemuserid)).body.Response, "Access origin could not be found. Access does not come from POA table or object ownership.");
});

test("RetrieveAccessOrigin names a team that owns the object, and a team that holds a share", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
  const teamId = await makeTeam(store, "origin", { teamtype: 0 });
  await call("AddMembersTeam", { user: admin, target: { id: teamId, row: teamRow(store, teamId) }, body: { Members: [memberOf(basic)] } });
  const owned = await makeWidget(store, "team-owned", teamId, "team");
  const origin = (objectId) => call("RetrieveAccessOrigin", { user: admin, params: { ObjectId: objectId, LogicalName: "widget", PrincipalId: basic.systemuserid } });
  assert.equal((await origin(owned)).body.Response, `PrincipalId is member of team (${teamId}) who is object owner (${owned})`);
  const shared = await makeWidget(store, "team-shared", admin.systemuserid);
  await grantAccess(store, { target: { id: shared, logical: "widget" }, principal: { id: teamId, logical_name: "team" }, mask: ACCESS_RIGHTS.Read });
  assert.equal((await origin(shared)).body.Response, `PrincipalId is member of team (${teamId}) who has poa access to object (${shared})`);
});

test("SetParentSystemUser refuses a manager loop, including self, with 0x80041d25 and changes nothing", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID), norole = noRoleOf(store);
  const setParent = (user, parent) => call("SetParentSystemUser", {
    user: admin, target: on(store, "systemuser", "systemuserid", user.systemuserid), body: { Parent: { "@odata.id": `systemusers(${parent.systemuserid})` }, KeepChildUsers: true },
  });
  await setParent(basic, admin); // basic reports to admin
  await assert.rejects(setParent(admin, basic), refused("0x80041d25")); // admin cannot report to its own report
  await assert.rejects(setParent(admin, admin), refused("0x80041d25"));
  assert.ok(!userOf(store, ADMIN_OID).parentsystemuserid, "the refused writes left the admin without a parent");
  await setParent(norole, basic); // a chain without a loop is accepted
  assert.equal(userOf(store, NOROLE_OID).parentsystemuserid.id, basic.systemuserid);
});

test("AddMembersTeam and RemoveMembersTeam refuse Entra group teams (0x80040208) and the default team (0x8004830B)", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
  const groupTeam = await makeTeam(store, "group", { teamtype: 2 });
  const defaultTeam = await makeTeam(store, "default", { teamtype: 0, isdefault: true });
  for (const name of ["AddMembersTeam", "RemoveMembersTeam"]) {
    await assert.rejects(call(name, { user: admin, target: { id: groupTeam, row: teamRow(store, groupTeam) }, body: { Members: [memberOf(basic)] } }), refused("0x80040208"));
    await assert.rejects(call(name, { user: admin, target: { id: defaultTeam, row: teamRow(store, defaultTeam) }, body: { Members: [memberOf(basic)] } }), refused("0x8004830B"));
  }
  assert.equal(store.tableRows("teammembership").filter((m) => same(idOf(m.teamid), groupTeam) || same(idOf(m.teamid), defaultTeam)).length, 0);
});

test("invalid arguments are refused with InvalidArgument 0x80040203, not the generic code", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID);
  const roleId = await makeRole(store, "depth");
  const Privileges = [{ PrivilegeId: pid(store, "prvReadRole"), Depth: "Nearby" }];
  await assert.rejects(call("AddPrivilegesRole", { user: admin, target: { id: roleId }, body: { Privileges } }), refused("0x80040203"));
  const basic = userOf(store, BASIC_OID);
  await assert.rejects(call("SetParentSystemUser", { user: admin, target: on(store, "systemuser", "systemuserid", basic.systemuserid), body: { Parent: { "@odata.id": `systemusers(${admin.systemuserid})` } } }), refused("0x80040203"));
});

test("RetrieveAadUserRoles reads as SYSTEM: a caller without prvReadRole gets the rows, RetrieveBusinessHierarchyBusinessUnit still needs prvReadBusinessUnit", async () => {
  const { store, call } = await setup();
  const norole = noRoleOf(store);
  const roles = await call("RetrieveAadUserRoles", { user: norole, params: { DirectoryObjectId: BASIC_OID } });
  const basicRole = roles.body.value.find((r) => r.name === "Basic User");
  assert.ok(basicRole, "the Basic User role comes back for a caller with no roles");
  assert.equal(roles.body["@odata.context"].endsWith("#roles"), true);
  assert.ok("_businessunitid_value" in basicRole);
  assert.equal("businessunitid" in basicRole, false);
  await denied(call("RetrieveBusinessHierarchyBusinessUnit", { user: norole, target: { id: ROOT } }));
});

test("the AddUserToRecordTeam action declares its ReturnType in CSDL, and the other actions declare none", async () => {
  const { ops } = await setup();
  const csdl = (name) => ops.find((o) => o.name === name).csdl ?? "";
  assert.match(csdl("AddUserToRecordTeam"), /<Action Name="AddUserToRecordTeam"[\s\S]*<ReturnType Type="mscrm\.AddUserToRecordTeamResponse" Nullable="false" \/>/);
  assert.doesNotMatch(csdl("AddMembersTeam"), /ReturnType/);
});

test("SetParentSystemUser sets the parent for a user with prvWriteSystemUser; KeepChildUsers false moves the children to the former parent", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID), norole = userOf(store, NOROLE_OID);
  const parentOf = (id) => ({ "@odata.id": `systemusers(${id})` });
  const setParent = (user, target, body) => call("SetParentSystemUser", { user, target: on(store, "systemuser", "systemuserid", target.systemuserid), body });
  assert.equal((await setParent(admin, basic, { Parent: parentOf(admin.systemuserid), KeepChildUsers: true })).status, 204);
  assert.equal(idOf(userOf(store, BASIC_OID).parentsystemuserid), admin.systemuserid);
  await setParent(admin, norole, { Parent: parentOf(basic.systemuserid), KeepChildUsers: true });
  assert.equal(idOf(userOf(store, NOROLE_OID).parentsystemuserid), basic.systemuserid);
  await setParent(admin, basic, { Parent: parentOf(admin.systemuserid), KeepChildUsers: false });
  assert.equal(idOf(userOf(store, NOROLE_OID).parentsystemuserid), admin.systemuserid);
  await assert.rejects(setParent(admin, basic, { Parent: parentOf(admin.systemuserid) }), (e) => e.status === 400);
  await denied(setParent(basic, norole, { Parent: parentOf(basic.systemuserid), KeepChildUsers: true }));
});

test("RetrieveBusinessHierarchyBusinessUnit returns the unit and its descendants", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), childId = uuidV5(ORG, "businessunit:child");
  await store.transact(() => store.state.tables.businessunit.push({ businessunitid: childId, name: "Child", parentbusinessunitid: { id: ROOT, logical_name: "businessunit", name: "" } }));
  const result = await call("RetrieveBusinessHierarchyBusinessUnit", { user: admin, target: on(store, "businessunit", "businessunitid", ROOT) });
  assert.deepEqual(result.body.value.map((b) => b.businessunitid).sort(), [ROOT, childId].sort());
});

test("ensureTeamTemplates seeds the teamtemplate table and its privileges once", async () => {
  const { store } = await setup();
  await store.transact(() => ensureTeamTemplates(store), { isolated: true });
  await store.transact(() => ensureTeamTemplates(store), { isolated: true });
  const mapping = store.state.mappings.teamtemplate;
  assert.equal(mapping.userConfigured, true);
  assert.equal(mapping.dataverseOnly, true);
  assert.equal(mapping.entitySet, "teamtemplates");
  assert.deepEqual(store.state.tables.teamtemplate, []);
  assert.equal(store.state.tables.privilege.filter((p) => p.name === "prvReadTeamTemplate").length, 1);
});

test("AddUserToRecordTeam creates one system-managed access team that shares the template rights, and reuses it", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
  const widgetId = await makeWidget(store, "shared", admin.systemuserid);
  const templateId = await makeTemplate(store, "Widget read-write", { mask: ACCESS_RIGHTS.Read | ACCESS_RIGHTS.Write });
  const args = { user: admin, target: on(store, "systemuser", "systemuserid", basic.systemuserid), body: { Record: { "@odata.id": `widgets(${widgetId})` }, TeamTemplate: { "@odata.id": `teamtemplates(${templateId})` } } };
  const first = await call("AddUserToRecordTeam", args);
  assert.equal(first.status, 200);
  const second = await call("AddUserToRecordTeam", args);
  assert.equal(second.body.AccessTeamId, first.body.AccessTeamId);
  const teamId = first.body.AccessTeamId;
  assert.equal(store.state.tables.team.filter((t) => t.systemmanaged === true).length, 1);
  assert.equal(store.state.tables.teammembership.filter((m) => same(idOf(m.teamid), teamId)).length, 1);
  const share = store.state.tables.principalobjectaccess.find((s) => same(idOf(s.principalid), teamId));
  assert.equal(share.accessrightsmask, ACCESS_RIGHTS.Read | ACCESS_RIGHTS.Write);
  assert.equal(share.objectid, widgetId);

  assert.equal((await call("RemoveUserFromRecordTeam", { ...args, body: { Record: args.body.Record, TeamTemplate: args.body.TeamTemplate } })).status, 204);
  assert.equal(store.state.tables.teammembership.filter((m) => same(idOf(m.teamid), teamId)).length, 0);
  assert.equal(store.state.tables.team.filter((t) => t.systemmanaged === true).length, 1);
});

test("AddUserToRecordTeam refuses a member without Read on the table, a caller without Share, and a template for another table", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID), norole = userOf(store, NOROLE_OID);
  const widgetId = await makeWidget(store, "guarded", admin.systemuserid);
  const templateId = await makeTemplate(store, "Widget read", { mask: ACCESS_RIGHTS.Read });
  const body = { Record: { "@odata.id": `widgets(${widgetId})` }, TeamTemplate: { "@odata.id": `teamtemplates(${templateId})` } };
  await assert.rejects(call("AddUserToRecordTeam", { user: admin, target: on(store, "systemuser", "systemuserid", norole.systemuserid), body }),
    (e) => e.status === 400 && /doesn't have sufficient privileges on the entity/.test(e.message));
  await assert.rejects(call("AddUserToRecordTeam", { user: basic, target: on(store, "systemuser", "systemuserid", basic.systemuserid), body }), (e) => e.status === 403);
  const otherId = await makeTemplate(store, "Account read", { mask: ACCESS_RIGHTS.Read, otc: objectTypeCode("account") });
  await assert.rejects(call("AddUserToRecordTeam", { user: admin, target: on(store, "systemuser", "systemuserid", basic.systemuserid), body: { ...body, TeamTemplate: { "@odata.id": `teamtemplates(${otherId})` } } }),
    (e) => e.status === 400 && /not for the widget table/.test(e.message));
});

test("SetBusinessSystemUser moves the user, drops its roles, and reassigns owned records to ReassignPrincipal, with or without DoNotMoveAllRecords", async () => {
  for (const doNotMoveAllRecords of [false, true]) {
    const { store, call } = await setup();
    const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
    const childId = uuidV5(ORG, "businessunit:child");
    await store.transact(() => store.state.tables.businessunit.push({ businessunitid: childId, name: "Child", parentbusinessunitid: { id: ROOT, logical_name: "businessunit", name: "" } }));
    const widgetId = await makeWidget(store, "owned", basic.systemuserid);
    const result = await call("SetBusinessSystemUser", {
      user: admin, target: on(store, "systemuser", "systemuserid", basic.systemuserid),
      body: { BusinessUnit: { "@odata.id": `businessunits(${childId})` }, ReassignPrincipal: { "@odata.id": `systemusers(${admin.systemuserid})` }, DoNotMoveAllRecords: doNotMoveAllRecords },
    });
    assert.equal(result.status, 204);
    assert.equal(idOf(userOf(store, BASIC_OID).businessunitid), childId);
    assert.equal(store.state.tables.systemuserroles.filter((r) => same(idOf(r.systemuserid), basic.systemuserid)).length, 0);
    const widget = store.state.tables.widget.find((w) => w.widgetid === widgetId);
    assert.equal(idOf(widget.ownerid), admin.systemuserid, `DoNotMoveAllRecords ${doNotMoveAllRecords}`);
    assert.equal(idOf(widget.owningbusinessunit), ROOT);
  }
});

test("RetrieveAadUserRoles and RetrieveAadUserPrivileges resolve a user by Entra object id, and an unknown id is not found", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID);
  const roles = await call("RetrieveAadUserRoles", { user: admin, params: { DirectoryObjectId: BASIC_OID } });
  assert.match(roles.body["@odata.context"], /\/\$metadata#roles$/);
  assert.deepEqual(roles.body.value.map((r) => r.name), ["Basic User"]);
  const privileges = await call("RetrieveAadUserPrivileges", { user: admin, params: { DirectoryObjectId: BASIC_OID } });
  assert.match(privileges.body["@odata.context"], /#Microsoft\.Dynamics\.CRM\.RetrieveAadUserPrivilegesResponse$/);
  assert.ok(grantedNames(privileges).includes("prvReadWidget:Basic"), grantedNames(privileges).join());
  assert.ok(!grantedNames(privileges).some((name) => name.startsWith("prvBulkDelete:")), "no privilege of a role the user does not hold");
  await assert.rejects(call("RetrieveAadUserRoles", { user: admin, params: { DirectoryObjectId: "aaaaaaaa-0000-4000-8000-0000000000ff" } }), (e) => e.status === 404);
});

test("install registers each operation once per bound table, none of them a built-in name, each with CSDL naming it except AddPrivilegesRole", async () => {
  const { ops } = await setup();
  const keys = ops.map((o) => `${o.name}@${o.entity ?? ""}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(ops.length, 49);
  const names = ops.map((o) => o.name);
  assert.ok(!names.includes("RetrieveUserPrivileges") && !names.includes("RetrievePrincipalAccess"));
  for (const name of ["ConvertOwnerTeamToAccessTeam", "ReassignObjectsOwner", "ReassignObjectsSystemUser", "ResetInheritedAccess", "GenerateSharedLink",
    "GrantAccessUsingSharedLink", "RetrieveSharedLinks", "RevokeSharedLink", "RetrieveAadUserSetOfPrivilegesByIds", "RetrieveAadUserSetOfPrivilegesByNames",
    "RetrieveAllChildUsersSystemUser", "RetrieveMaskedAttributesForEntity", "RetrieveUsersPrivilegesThroughTeams", "RetrievePrivilegeSet", "SetParentTeam", "SyncGroupMembersToTeam",
    "CreateAsyncJobToRevokeInheritedAccess", "GrantDelegatedAccess", "ProvisionDelegation", "RetrieveAppsWithDelegatedAccessPermissions",
    "CreateRoleWithPrivilegeCheckerRun", "GetConsentLink", "ConfirmConsentCode", "AddChannelAccessProfilePrivileges", "RetrieveChannelAccessProfilePrivileges"]) {
    assert.equal(names.filter((n) => n === name).length, 1, name);
  }
  for (const op of ops) {
    if (op.name === "AddPrivilegesRole") assert.equal(op.csdl, "");
    else assert.match(op.csdl, new RegExp(`Name="${op.name}"`), op.name);
  }
});

test("a team membership write is visible to the next privilege check, and it moves the store revision", async () => {
  const { store, call, principals } = await setup();
  const admin = userOf(store, ADMIN_OID), norole = userOf(store, NOROLE_OID);
  const roleId = await makeRole(store, "Team Widget Reader");
  await call("AddPrivilegesRole", { user: admin, target: on(store, "role", "roleid", roleId), body: { Privileges: [{ Depth: "Global", PrivilegeId: pid(store, "prvReadWidget") }] } });
  const teamId = uuidV5(ORG, "team:Readers");
  await store.transact(() => store.state.tables.team.push({ teamid: teamId, name: "Readers", teamtype: 0, businessunitid: { id: ROOT, logical_name: "businessunit", name: "" } }));
  await store.transact(() => store.state.tables.teamroles.push({ teamroleid: uuidV5(teamId, roleId), teamid: { id: teamId }, roleid: { id: roleId } }));
  const revision = store.revision;
  await call("AddMembersTeam", { user: admin, target: on(store, "team", "teamid", teamId), body: { Members: [{ "@odata.type": "Microsoft.Dynamics.CRM.systemuser", ownerid: norole.systemuserid }] } });
  assert.ok(store.revision > revision);
  assert.equal(principals.privileges(norole).get("prvReadWidget"), 1, "a team role reaches the member at Basic");
});

test("a refused ReplacePrivilegesRole or AddPrivilegesRole leaves the role's grants exactly as they were", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID);
  const target = on(store, "role", "roleid", await makeRole(store, "All or nothing"));
  await call("AddPrivilegesRole", { user: admin, target, body: { Privileges: [{ Depth: "Local", PrivilegeId: pid(store, "prvReadWidget") }] } });
  const before = grantedNames(await call("RetrieveRolePrivilegesRole", { user: admin, params: { RoleId: target.id } }));
  const unknownSecond = { Privileges: [{ Depth: "Basic", PrivilegeId: pid(store, "prvWriteWidget") }, { Depth: "Basic", PrivilegeId: UNKNOWN }] };
  await assert.rejects(call("ReplacePrivilegesRole", { user: admin, target, body: unknownSecond }), (e) => e.status === 404);
  const badDepth = { Privileges: [{ Depth: "Local", PrivilegeId: pid(store, "prvDeleteWidget") }, { Depth: "Bogus", PrivilegeId: pid(store, "prvWriteWidget") }] };
  await assert.rejects(call("AddPrivilegesRole", { user: admin, target, body: badDepth }), (e) => e.status === 400);
  assert.deepEqual(grantedNames(await call("RetrieveRolePrivilegesRole", { user: admin, params: { RoleId: target.id } })), before);
});

test("SetBusinessSystemUser refuses an unknown or a disabled business unit and changes nothing", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
  const disabledId = uuidV5(ORG, "businessunit:disabled");
  await store.transact(() => store.state.tables.businessunit.push({ businessunitid: disabledId, name: "Disabled", isdisabled: true, parentbusinessunitid: { id: ROOT, logical_name: "businessunit", name: "" } }));
  const widgetId = await makeWidget(store, "kept-owner", basic.systemuserid);
  const args = (unit) => ({
    user: admin, target: on(store, "systemuser", "systemuserid", basic.systemuserid),
    body: { BusinessUnit: { "@odata.id": `businessunits(${unit})` }, ReassignPrincipal: { "@odata.id": `systemusers(${admin.systemuserid})` }, DoNotMoveAllRecords: false },
  });
  await assert.rejects(call("SetBusinessSystemUser", args(uuidV5(ORG, "businessunit:missing"))), (e) => e.status === 404);
  await assert.rejects(call("SetBusinessSystemUser", args(disabledId)), refused("0x8004032d"));
  assert.ok(same(idOf(userOf(store, BASIC_OID).businessunitid), ROOT));
  const widget = store.state.tables.widget.find((w) => w.widgetid === widgetId);
  assert.ok(same(idOf(widget.ownerid), basic.systemuserid));
});

test("install seeds the teamtemplate table before any record-team call, and reset brings it back after a reseed", async () => {
  const store = new DataStore({ state: fixtureState() });
  const api = { store, clock: () => CLOCK, change: (fn) => fn(), registry: { register() {} }, recordHooks: { add() {} } };
  await install(api);
  assert.equal(store.state.mappings.teamtemplate.entitySet, "teamtemplates");
  await ensureSecurityModel(store, SETTINGS);
  assert.equal(store.state.tables.privilege.filter((p) => p.name === "prvReadTeamTemplate").length, 1);
  await store.transact(() => { delete store.state.mappings.teamtemplate; delete store.state.tables.teamtemplate; });
  await reset(api);
  assert.equal(store.state.mappings.teamtemplate.entitySet, "teamtemplates");
  assert.deepEqual(store.state.tables.teamtemplate, []);
});

const sysUser = (id) => `systemusers(${id})`;

test("ConvertOwnerTeamToAccessTeam converts an owner team with no owned records, and refuses one that owns records", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
  const teamId = await makeTeam(store, "Owners", { teamtype: 0 });
  const team = { id: teamId };
  assert.equal((await call("ConvertOwnerTeamToAccessTeam", { user: admin, target: team })).status, 204);
  assert.equal(store.tableRows("team").find((t) => same(t.teamid, teamId)).teamtype, 1);

  const ownerId = await makeTeam(store, "Keeps", { teamtype: 0 });
  await makeWidget(store, "owned-by-team", ownerId, "team");
  await assert.rejects(call("ConvertOwnerTeamToAccessTeam", { user: admin, target: { id: ownerId } }), (e) => e.status === 400);
  assert.equal(store.tableRows("team").find((t) => same(t.teamid, ownerId)).teamtype, 0);
  await denied(call("ConvertOwnerTeamToAccessTeam", { user: basic, target: { id: ownerId } }));
});

test("ReassignObjectsOwner moves the rows a principal owns to another, filtered by objectType, and needs Assign on each row", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID), norole = userOf(store, NOROLE_OID);
  const widgetId = await makeWidget(store, "basic-owned", basic.systemuserid);
  const body = (objectType) => ({
    FromPrincipal: { "@odata.id": sysUser(basic.systemuserid) }, ToPrincipal: { "@odata.id": sysUser(admin.systemuserid) }, objectType,
  });
  // A code for a table that is not user-owned is refused and changes nothing.
  await assert.rejects(call("ReassignObjectsOwner", { user: admin, body: body(1) }), (e) => e.status === 400);
  assert.equal(idOf(store.tableRows("widget").find((w) => same(w.widgetid, widgetId)).ownerid), basic.systemuserid);

  // The caller with no roles holds no Assign on the row: refused, and the owner stays.
  await denied(call("ReassignObjectsOwner", { user: norole, body: body(objectTypeCode("widget")) }));
  assert.equal(idOf(store.tableRows("widget").find((w) => same(w.widgetid, widgetId)).ownerid), basic.systemuserid);

  assert.equal((await call("ReassignObjectsOwner", { user: admin, body: body(objectTypeCode("widget")) })).status, 204);
  const moved = store.tableRows("widget").find((w) => same(w.widgetid, widgetId));
  assert.equal(idOf(moved.ownerid), admin.systemuserid);
  assert.equal(idOf(moved.owninguser), admin.systemuserid);
});

test("ReassignObjectsSystemUser reassigns the bound user's rows to ReassignPrincipal", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
  const widgetId = await makeWidget(store, "bound", basic.systemuserid);
  const target = on(store, "systemuser", "systemuserid", basic.systemuserid);
  const result = await call("ReassignObjectsSystemUser", { user: admin, target, body: { ReassignPrincipal: { "@odata.id": sysUser(admin.systemuserid) } } });
  assert.equal(result.status, 204);
  assert.equal(idOf(store.tableRows("widget").find((w) => same(w.widgetid, widgetId)).ownerid), admin.systemuserid);
});

test("ResetInheritedAccess needs a FetchXml over principalobjectaccess and clears inherited rights on those share rows", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID);
  await store.transact(() => store.state.tables.principalobjectaccess.push({
    principalobjectaccessid: uuidV5(ORG, "poa:1"), objectid: uuidV5(ORG, "widget:x"), objecttypecode: "widget",
    principalid: { id: admin.systemuserid, logical_name: "systemuser" }, accessrightsmask: 1, inheritedaccessrightsmask: 4,
  }));
  await assert.rejects(call("ResetInheritedAccess", { user: admin, params: { FetchXml: "<fetch><entity name='widget' /></fetch>" } }), (e) => e.status === 400);
  const ok = await call("ResetInheritedAccess", { user: admin, params: { FetchXml: "<fetch><entity name='principalobjectaccess'/></fetch>" } });
  assert.equal(ok.status, 200);
  assert.match(ok.body.ResetInheritedAccessResponse, /inherited access/);
  assert.equal(store.tableRows("principalobjectaccess")[0].inheritedaccessrightsmask, 0);
});

test("shared links: GenerateSharedLink needs Share, GrantAccessUsingSharedLink grants the caller, RevokeSharedLink removes both", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID), norole = userOf(store, NOROLE_OID);
  const widgetId = await makeWidget(store, "shared", admin.systemuserid);
  const Target = { "@odata.id": `widgets(${widgetId})` };

  await denied(call("GenerateSharedLink", { user: norole, body: { Target, SharedRights: "ReadAccess" } }));
  const generated = await call("GenerateSharedLink", { user: admin, body: { Target, SharedRights: "ReadAccess" } });
  assert.equal(generated.status, 200);
  const url = generated.body.Response;
  assert.match(url, /sharedlink=/);

  const listed = await call("RetrieveSharedLinks", { user: admin, params: { Target } });
  assert.equal(listed.body.value.length, 1);

  // A URL with no live link is refused.
  await assert.rejects(call("GrantAccessUsingSharedLink", { user: basic, body: { RecordUrlWithSharedLink: `${ORIGIN}/main.aspx?etn=widget` } }), (e) => e.status === 400);
  assert.equal((await call("GrantAccessUsingSharedLink", { user: basic, body: { RecordUrlWithSharedLink: url } })).status, 204);
  const share = store.tableRows("principalobjectaccess").find((s) => same(s.principalid.id, basic.systemuserid) && same(s.objectid, widgetId));
  assert.equal(Number(share.accessrightsmask), ACCESS_RIGHTS.Read);

  assert.equal((await call("RevokeSharedLink", { user: admin, body: { Target, SharedRights: "ReadAccess" } })).status, 204);
  assert.equal(store.tableRows("principalobjectaccess").some((s) => same(s.principalid.id, basic.systemuserid)), false);
  assert.equal((await call("RetrieveSharedLinks", { user: admin, params: { Target } })).body.value.length, 0);
});

test("RetrieveAadUserSetOfPrivileges by names and by ids read the user found by Entra object id; an unknown id is not found", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), norole = userOf(store, NOROLE_OID);
  const byNames = await call("RetrieveAadUserSetOfPrivilegesByNames", { user: admin, params: { DirectoryObjectId: ADMIN_OID, PrivilegeNames: ["prvReadWidget"] } });
  assert.deepEqual(grantedNames(byNames), ["prvReadWidget:Global"]);
  const byIds = await call("RetrieveAadUserSetOfPrivilegesByIds", { user: admin, params: { DirectoryObjectId: ADMIN_OID, PrivilegeIds: [pid(store, "prvReadWidget")] } });
  assert.deepEqual(grantedNames(byIds), ["prvReadWidget:Global"]);
  await denied(call("RetrieveAadUserSetOfPrivilegesByNames", { user: norole, params: { DirectoryObjectId: ADMIN_OID, PrivilegeNames: ["prvReadWidget"] } }));
  await assert.rejects(call("RetrieveAadUserSetOfPrivilegesByNames", { user: admin, params: { DirectoryObjectId: "cccccccc-0000-4000-8000-000000000009", PrivilegeNames: [] } }), (e) => e.status === 404);
});

test("RetrieveAllChildUsersSystemUser lists every user under the manager at any depth, not the manager", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID), norole = userOf(store, NOROLE_OID);
  await store.transact(() => {
    basic.parentsystemuserid = { id: admin.systemuserid, logical_name: "systemuser", name: "" };
    norole.parentsystemuserid = { id: basic.systemuserid, logical_name: "systemuser", name: "" };
  });
  const result = await call("RetrieveAllChildUsersSystemUser", { user: admin, target: on(store, "systemuser", "systemuserid", admin.systemuserid) });
  const ids = result.body.value.map((u) => same(u.systemuserid, basic.systemuserid) ? "basic" : same(u.systemuserid, norole.systemuserid) ? "norole" : u.systemuserid);
  assert.deepEqual(ids.sort(), ["basic", "norole"]);
});

test("RetrieveMaskedAttributesForEntity lists the masked columns of a table from its masking rules, and none for a table without rules", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID);
  await store.transact(() => (store.state.tables.attributemaskingrule ??= []).push({
    attributemaskingruleid: uuidV5(ORG, "mask:1"), attributelogicalname: "name", entityname: "widget", maskingruleid: uuidV5(ORG, "rule:1"),
  }));
  const masked = await call("RetrieveMaskedAttributesForEntity", { user: admin, params: { EntityLogicalName: "widget" } });
  assert.deepEqual(masked.body.AttributeLogicalNames, ["name"]);
  const none = await call("RetrieveMaskedAttributesForEntity", { user: admin, params: { EntityLogicalName: "gadget" } });
  assert.deepEqual(none.body.AttributeLogicalNames, []);
  await assert.rejects(call("RetrieveMaskedAttributesForEntity", { user: admin, params: {} }), (e) => e.status === 400);
});

test("RetrieveUsersPrivilegesThroughTeams returns the team-role privileges at Basic, and nothing the user holds directly", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), norole = userOf(store, NOROLE_OID);
  const teamId = await makeTeam(store, "Readers", { teamtype: 0 });
  const roleId = uuidV5(ORG, "role:Team Reader");
  await store.transact(() => store.state.tables.role.push({ roleid: roleId, name: "Team Reader", businessunitid: { id: ROOT, logical_name: "businessunit", name: "" }, organizationid: null, isinherited: 1 }));
  await call("AddPrivilegesRole", { user: admin, target: on(store, "role", "roleid", roleId), body: { Privileges: [{ Depth: "Global", PrivilegeId: pid(store, "prvReadWidget") }] } });
  await store.transact(() => store.state.tables.teamroles.push({ teamroleid: uuidV5(teamId, roleId), teamid: { id: teamId }, roleid: { id: roleId } }));
  await call("AddMembersTeam", { user: admin, target: { id: teamId }, body: { Members: [{ "@odata.type": "Microsoft.Dynamics.CRM.systemuser", ownerid: norole.systemuserid }] } });
  const result = await call("RetrieveUsersPrivilegesThroughTeams", { user: admin, target: on(store, "systemuser", "systemuserid", norole.systemuserid), params: {} });
  assert.deepEqual(grantedNames(result), ["prvReadWidget:Basic"]);
  const admins = await call("RetrieveUsersPrivilegesThroughTeams", { user: admin, target: on(store, "systemuser", "systemuserid", admin.systemuserid), params: {} });
  assert.equal(admins.body.RolePrivileges.length, 0);
});

test("RetrievePrivilegeSet returns every privilege row as a collection", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID);
  const result = await call("RetrievePrivilegeSet", { user: admin, target: { mapping: store.resolveMapping("privilege") } });
  assert.match(result.body["@odata.context"], /#privileges$/);
  assert.equal(result.body.value.length, store.tableRows("privilege").length);
  assert.equal(result.body.value.find((p) => p.name === "prvReadWidget").privilegeid, pid(store, "prvReadWidget"));
});

test("SetParentTeam moves a team to a business unit and its owned records with it, unless DoNotMoveAllRecords, and refuses a disabled unit", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), norole = userOf(store, NOROLE_OID);
  const childId = uuidV5(ORG, "businessunit:child");
  const disabledId = uuidV5(ORG, "businessunit:disabled");
  await store.transact(() => store.state.tables.businessunit.push(
    { businessunitid: childId, name: "Child", parentbusinessunitid: { id: ROOT, logical_name: "businessunit", name: "" } },
    { businessunitid: disabledId, name: "Disabled", isdisabled: true, parentbusinessunitid: { id: ROOT, logical_name: "businessunit", name: "" } },
  ));
  const teamId = await makeTeam(store, "Moving", { teamtype: 0 });
  const widgetId = uuidV5(ORG, "widget:team-owned");
  await store.transact(() => store.state.tables.widget.push({ widgetid: widgetId, name: "team-owned", ownerid: { id: teamId, logical_name: "team", name: "" } }));
  const target = { id: teamId };
  const BusinessUnit = (id) => ({ "@odata.id": `businessunits(${id})` });

  await denied(call("SetParentTeam", { user: norole, target, body: { BusinessUnit: BusinessUnit(childId) } }));
  await assert.rejects(call("SetParentTeam", { user: admin, target, body: { BusinessUnit: BusinessUnit(disabledId) } }), refused("0x8004032d"));

  assert.equal((await call("SetParentTeam", { user: admin, target, body: { BusinessUnit: BusinessUnit(childId), DoNotMoveAllRecords: true } })).status, 204);
  assert.equal(idOf(store.tableRows("team").find((t) => same(t.teamid, teamId)).businessunitid), childId);
  assert.equal(idOf(store.tableRows("widget").find((w) => same(w.widgetid, widgetId)).owningbusinessunit), undefined);

  assert.equal((await call("SetParentTeam", { user: admin, target, body: { BusinessUnit: BusinessUnit(childId) } })).status, 204);
  assert.equal(idOf(store.tableRows("widget").find((w) => same(w.widgetid, widgetId)).owningbusinessunit), childId);
});

test("SyncGroupMembersToTeam sets the members of an Entra group team from the users' group ids, and refuses a team that is not a group", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID), norole = userOf(store, NOROLE_OID);
  const groupTeam = await makeTeam(store, "Entra group", { teamtype: 2, aad: GROUP_OID });
  const plainTeam = await makeTeam(store, "Plain", { teamtype: 0 });
  const setGroups = (groups) => store.transact(() => { store.state.tables.systemuser.find((u) => same(u.systemuserid, basic.systemuserid)).azureactivedirectorygroupids = groups; });
  await setGroups([GROUP_OID]);
  const members = () => store.tableRows("teammembership").filter((m) => same(idOf(m.teamid), groupTeam)).map((m) => idOf(m.systemuserid));

  await denied(call("SyncGroupMembersToTeam", { user: norole, target: { id: groupTeam } }));
  await assert.rejects(call("SyncGroupMembersToTeam", { user: admin, target: { id: plainTeam } }), (e) => e.status === 400);

  assert.equal((await call("SyncGroupMembersToTeam", { user: admin, target: { id: groupTeam } })).status, 204);
  assert.deepEqual(members().map((id) => same(id, basic.systemuserid)), [true]);

  await setGroups([]);
  await call("SyncGroupMembersToTeam", { user: admin, target: { id: groupTeam } });
  assert.deepEqual(members(), []);
});

const DA = "dddddddd-0000-4000-8000-000000000001";
const RUN = "eeeeeeee-0000-4000-8000-000000000001";
const CONN = "ffffffff-0000-4000-8000-000000000001";
const CAP = "cccccccc-0000-4000-8000-000000000001";
const shareRow = (store, objectId, principalId) => store.tableRows("principalobjectaccess")
  .find((r) => same(r.objectid, objectId) && same(idOf(r.principalid), principalId));

test("CreateAsyncJobToRevokeInheritedAccess queues a RevokeInheritedAccess job that clears the inherited rights of the relationship's referencing rows", async () => {
  const { store, call, jobs } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
  const widgetId = await makeWidget(store, "inherited", basic.systemuserid);
  await grantAccess(store, { target: { id: widgetId, logical: "widget" }, principal: { id: basic.systemuserid, logical_name: "systemuser" }, mask: ACCESS_RIGHTS.Read });
  await store.transact(() => { shareRow(store, widgetId, basic.systemuserid).inheritedaccessrightsmask = 4; });

  const body = { RelationshipSchema: "contoso_widget_owner" };
  assert.equal((await call("CreateAsyncJobToRevokeInheritedAccess", { user: admin, body })).status, 204);
  assert.deepEqual(jobs.map((j) => [j.name, j.message]), [["RevokeInheritedAccess", "Inherited access revoked."]]);
  assert.equal(shareRow(store, widgetId, basic.systemuserid).inheritedaccessrightsmask, 0);

  await denied(call("CreateAsyncJobToRevokeInheritedAccess", { user: basic, body }));
  await assert.rejects(call("CreateAsyncJobToRevokeInheritedAccess", { user: admin, body: { RelationshipSchema: "contoso_missing" } }), refused("0x80040203"));
  await assert.rejects(call("CreateAsyncJobToRevokeInheritedAccess", { user: admin, body: {} }), refused("0x80040203"));
  assert.equal(jobs.length, 1);
});

test("RetrievePrincipalAccessInfo reports the rights a team holds on a widget, and none for a user without a grant", async () => {
  const { store, callOn } = await setup();
  const admin = userOf(store, ADMIN_OID), norole = userOf(store, NOROLE_OID);
  const widgetId = await makeWidget(store, "access-info", admin.systemuserid);
  const teamId = await makeTeam(store, "Readers", { teamtype: 0 });
  // A team's share counts only where the team holds the privilege through a role: a Basic read role here.
  const role = uuidV5(ORG, "role:readers");
  const ref = (logical, id) => ({ id, logical_name: logical, name: "" });
  await store.transact(() => {
    store.state.tables.role.push({ roleid: role, name: "Readers", businessunitid: ref("businessunit", ROOT), organizationid: null });
    store.state.tables.roleprivileges.push({ roleprivilegeid: uuidV5(role, "read"), roleid: ref("role", role), privilegeid: ref("privilege", pid(store, "prvReadWidget")), privilegedepthmask: 1 });
    store.state.tables.teamroles.push({ teamroleid: uuidV5(teamId, "role"), teamid: ref("team", teamId), roleid: ref("role", role) });
  });
  await grantAccess(store, { target: { id: widgetId, logical: "widget" }, principal: { id: teamId, logical_name: "team" }, mask: ACCESS_RIGHTS.Read });
  const params = { ObjectId: widgetId, EntityName: "widget" };
  const info = async (entity, target, user = admin) => JSON.parse((await callOn("RetrievePrincipalAccessInfo", entity, { user, target: { id: target }, params })).body.AccessInfo);

  assert.deepEqual(await info("team", teamId), { AccessRights: "ReadAccess" });
  assert.deepEqual(await info("systemuser", norole.systemuserid), { AccessRights: "None" });
  await denied(callOn("RetrievePrincipalAccessInfo", "systemuser", { user: norole, target: { id: admin.systemuserid }, params }));
  await assert.rejects(callOn("RetrievePrincipalAccessInfo", "systemuser", { user: admin, target: { id: admin.systemuserid }, params: { ObjectId: CAP, EntityName: "widget" } }), (e) => e.status === 404);
});

test("ProvisionDelegation creates the delegated authorization and its team once, and GrantDelegatedAccess shares a record with that team", async () => {
  const { store, call } = await setup({ standard: true });
  const admin = userOf(store, ADMIN_OID), norole = userOf(store, NOROLE_OID);
  const widgetId = await makeWidget(store, "delegated", admin.systemuserid);
  const widgetOwned = await makeWidget(store, "delegated-owned", admin.systemuserid);
  const delegation = { delegatedauthorization: { delegatedauthorizationid: DA, name: "Partner" } };
  const teamId = uuidV5(DA, "delegation:team");

  const first = await call("ProvisionDelegation", { user: admin, body: delegation });
  assert.equal(first.status, 200);
  assert.equal(first.body.teamid, teamId);
  assert.equal((await call("ProvisionDelegation", { user: admin, body: delegation })).body.teamid, teamId);
  assert.equal(store.tableRows("team").filter((t) => same(t.teamid, teamId)).length, 1);
  assert.equal(store.tableRows("delegatedauthorization").filter((d) => same(d.delegatedauthorizationid, DA)).length, 1);
  await denied(call("ProvisionDelegation", { user: norole, body: delegation }));

  const grant = (target, owneraccess) => call("GrantDelegatedAccess", {
    user: admin, body: { delegatedauthorization: { "@odata.id": `DelegatedAuthorizations(${DA})` }, target: { "@odata.id": `widgets(${target})` }, owneraccess },
  });
  assert.equal((await grant(widgetId, false)).status, 204);
  assert.equal(shareRow(store, widgetId, teamId).accessrightsmask, ACCESS_RIGHTS.Read);
  assert.equal((await grant(widgetOwned, true)).status, 204);
  const owner = ["Read", "Write", "Append", "AppendTo", "Delete", "Share", "Assign"].reduce((mask, right) => mask | ACCESS_RIGHTS[right], 0);
  assert.equal(shareRow(store, widgetOwned, teamId).accessrightsmask, owner);
  await assert.rejects(call("GrantDelegatedAccess", { user: admin, body: { delegatedauthorization: { "@odata.id": `DelegatedAuthorizations(${CAP})` }, target: { "@odata.id": `widgets(${widgetId})` } } }), (e) => e.status === 404);
});

test("RetrieveAppsWithDelegatedAccessPermissions answers an empty collection and refuses a cloud that is not an integer", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID);
  const result = await call("RetrieveAppsWithDelegatedAccessPermissions", { user: admin, body: { cloud: 0 } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.value, []);
  await assert.rejects(call("RetrieveAppsWithDelegatedAccessPermissions", { user: admin, body: { cloud: "x" } }), refused("0x80040203"));
});

test("CreateRoleWithPrivilegeCheckerRun builds a role from the run's privilege-check logs at their depths", async () => {
  const { store, call } = await setup({ standard: true });
  const admin = userOf(store, ADMIN_OID);
  const readWidget = pid(store, "prvReadWidget"), writeWidget = pid(store, "prvWriteWidget");
  const log = (name, privilegeId, { depth, checktype = 1 }) => ({
    privilegecheckerlogid: uuidV5(RUN, name), privilegecheckerrunid: { id: RUN, logical_name: "privilegecheckerrun", name: "" },
    checkedprivilege: { id: privilegeId, logical_name: "privilege", name: "" }, privilegedepth: depth, checktype,
  });
  await store.transact(() => {
    const logs = store.state.tables.privilegecheckerlog;
    logs.push(log("local", readWidget, { depth: 1 }), log("deep", readWidget, { depth: 2 }));
    logs.push(log("refused-check", writeWidget, { depth: 3, checktype: 2 }), log("depth-4", writeWidget, { depth: 4 }));
  });

  const result = await call("CreateRoleWithPrivilegeCheckerRun", { user: admin, target: { id: RUN }, body: { PrivilegeCheckerRunId: RUN, RoleName: "Checked role" } });
  assert.equal(result.status, 200);
  const roleId = result.body.RoleId;
  assert.equal(store.tableRows("role").find((r) => same(r.roleid, roleId)).name, "Checked role");
  const grants = store.tableRows("roleprivileges").filter((p) => same(idOf(p.roleid), roleId));
  // One grant: the deep check (depth 2, mask 4) wins over the local one (depth 1, mask 2). The depth-4 and checktype-2 logs are skipped.
  assert.deepEqual(grants.map((p) => [idOf(p.privilegeid), p.privilegedepthmask]), [[readWidget, 4]]);
  await assert.rejects(call("CreateRoleWithPrivilegeCheckerRun", { user: admin, target: { id: RUN }, body: { PrivilegeCheckerRunId: CAP, RoleName: "Other" } }), refused("0x80040203"));
});

test("GetConsentLink and ConfirmConsentCode answer for a connection instance the caller can write, and never store the code", async () => {
  const { store, call } = await setup({ standard: true });
  const admin = userOf(store, ADMIN_OID), norole = userOf(store, NOROLE_OID);
  await store.transact(() => store.state.tables.connectioninstance.push({
    connectioninstanceid: CONN, name: "Connector", connectionstatus: null, ownerid: { id: admin.systemuserid, logical_name: "systemuser", name: "" },
  }));

  const link = await call("GetConsentLink", { user: admin, target: { id: CONN }, body: { redirectUrl: "https://localhost/cb" } });
  assert.equal(link.status, 200);
  assert.equal(link.body.redirectUrl, "https://localhost/cb");
  assert.equal(link.body.principalId, admin.systemuserid);
  assert.match(link.body.consentLink, new RegExp(`/consent/${CONN}\\?redirect_uri=https%3A%2F%2Flocalhost%2Fcb$`));
  await denied(call("GetConsentLink", { user: norole, target: { id: CONN }, body: { redirectUrl: "https://localhost/cb" } }));

  await assert.rejects(call("ConfirmConsentCode", { user: admin, target: { id: CONN }, body: { code: "" } }), refused("0x80040203"));
  assert.equal((await call("ConfirmConsentCode", { user: admin, target: { id: CONN }, body: { code: "invented-code" } })).status, 204);
  const row = store.tableRows("connectioninstance").find((r) => same(r.connectioninstanceid, CONN));
  assert.equal(row.connectionstatus, JSON.stringify([{ status: "Connected" }]));
  assert.ok(!JSON.stringify(store.state.tables.connectioninstance).includes("invented-code"));
});

test("the internal-only channel and sync messages are registered per bound table and answer 501 by default; a dataverseMessages pack handler replaces them", async () => {
  const { store, ops, call, callOn, api } = await setup();
  const admin = userOf(store, ADMIN_OID);
  assert.deepEqual(ops.filter((o) => o.name === "RetrievePrincipalSyncAttributeMappings").map((o) => o.entity).sort(), ["systemuser", "team"]);
  assert.deepEqual(ops.filter((o) => o.name === "RetrievePrincipalAccessInfo").map((o) => o.entity).sort(), ["systemuser", "team"]);

  const refusedNotSimulated = (name) => (e) => e.status === 501 && e.code === "NotImplemented" && e.details?.innerCode === "0x80040216"
    && e.message === `${name} is for internal use only and is not simulated.`;
  await assert.rejects(call("AddChannelAccessProfilePrivileges", { user: admin, body: { ChannelAccessProfileId: CAP, Privileges: [] } }), refusedNotSimulated("AddChannelAccessProfilePrivileges"));
  await assert.rejects(call("RetrieveChannelAccessProfilePrivileges", { user: admin, params: { ChannelAccessProfileId: CAP } }), refusedNotSimulated("RetrieveChannelAccessProfilePrivileges"));
  await assert.rejects(callOn("RetrievePrincipalSyncAttributeMappings", "team", { user: admin, target: { id: CAP } }), refusedNotSimulated("RetrievePrincipalSyncAttributeMappings"));

  api.addonHandlers = addonHandlers([{ id: "invented-pack", dataverseMessages: {
    RetrieveChannelAccessProfilePrivileges: async (ctx) => ({ ChannelAccessProfile: { channelaccessprofileid: ctx.args.ChannelAccessProfileId } }),
  } }]);
  const result = await call("RetrieveChannelAccessProfilePrivileges", { user: admin, params: { ChannelAccessProfileId: CAP } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ChannelAccessProfile.channelaccessprofileid, CAP);
});
