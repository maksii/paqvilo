// Second set of simulated Dataverse security messages (dataverse-security-messages2.mjs): owner reassignment, team conversion,
// team business units and group sync, shared links, Entra object id privileges, the user hierarchy, team-derived privileges and
// masked columns. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { objectTypeCode } from "../lib/dataverse-metadata.mjs";
import { ACCESS_RIGHTS, createPrincipals, ensureSecurityModel, grantAccess, uuidV5 } from "../lib/dataverse-security.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { addonHandlers } from "../lib/dataverse-addon-common.mjs";
import { seed as seedStandard } from "../lib/dataverse-standard.mjs";
import { install as installMessages } from "../lib/dataverse-security-messages.mjs";
import { install as installMessages2 } from "../lib/dataverse-security-messages2.mjs";

const ORIGIN = "https://org.example.test";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const BASIC_OID = "aaaaaaaa-0000-4000-8000-000000000002";
const NOROLE_OID = "aaaaaaaa-0000-4000-8000-000000000003";
const GROUP_OID = "bbbbbbbb-0000-4000-8000-000000000001";
const ROOT = uuidV5(ORG, "businessunit:root");
const CLOCK = Date.UTC(2026, 9, 20, 9, 0, 0);
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
  const ops = [];
  const principals = createPrincipals(store, SETTINGS);
  // The production shape: the server's change queue is a mutex, not a transaction. Writes open their own store.transact.
  const change = (fn) => fn();
  // systemJob stands in for the async runner: the work runs at once and its message is recorded.
  const jobs = [];
  const api = {
    store,
    clock: () => CLOCK,
    change,
    principals,
    records: createRecordHandlers({ store, change, principals, clock: () => CLOCK }),
    registry: { register: (op) => ops.push(op) },
    recordHooks: { add: () => {} },
    systemJob: async (job, work) => { jobs.push({ ...job, message: await work() }); return job.name; },
  };
  await installMessages(api);
  installMessages2(api);
  const invoke = (op, { user, target, params, body }) => op.handle({
    user, caller: null, target, params, body, identity: { admin: true },
    origin: ORIGIN, version: "v9.2", url: new URL(`${ORIGIN}/api/data/v9.2/`),
  });
  const call = (name, args) => invoke(ops.find((o) => o.name === name), args);
  // The operations registered once per entity (RetrievePrincipalAccessInfo is bound to systemuser and to team).
  const callOn = (name, entity, args) => invoke(ops.find((o) => o.name === name && o.entity === entity), args);
  return { store, ops, call, callOn, principals, api, jobs };
}

const userOf = (store, oid) => store.tableRows("systemuser").find((u) => u.azureactivedirectoryobjectid === oid);
const on = (store, logical, column, id) => ({ id, row: store.tableRows(logical).find((r) => r[column] === id) });
const denied = (promise) => assert.rejects(promise, (e) => e.status === 403 && e.code === "PrivilegeDenied" && e.details?.innerCode === "0x80040220");
const refused = (inner) => (e) => e.status === 400 && e.details?.innerCode === inner;
const idOf = (value) => (value && typeof value === "object" ? value.id : value);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const pid = (store, name) => store.tableRows("privilege").find((p) => p.name === name).privilegeid;
const grantedNames = (result) => result.body.RolePrivileges.map((p) => `${p.PrivilegeName}:${p.Depth}`).sort();
const sysUser = (id) => `systemusers(${id})`;

async function makeWidget(store, name, owner) {
  const widgetid = uuidV5(ORG, `widget:${name}`);
  await store.transact(() => store.state.tables.widget.push({ widgetid, name, ownerid: { id: owner.id, logical_name: owner.logical_name ?? "systemuser", name: "" } }));
  return widgetid;
}

async function makeTeam(store, name, { teamtype, aad = null }) {
  const teamid = uuidV5(ORG, `team:${name}`);
  await store.transact(() => store.state.tables.team.push({
    teamid, name, teamtype, azureactivedirectoryobjectid: aad, businessunitid: { id: ROOT, logical_name: "businessunit", name: "" }, organizationid: null,
  }));
  return teamid;
}

test("ConvertOwnerTeamToAccessTeam converts an owner team with no owned records, and refuses one that owns records", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID);
  const teamId = await makeTeam(store, "Owners", { teamtype: 0 });
  const team = { id: teamId };
  assert.equal((await call("ConvertOwnerTeamToAccessTeam", { user: admin, target: team })).status, 204);
  assert.equal(store.tableRows("team").find((t) => same(t.teamid, teamId)).teamtype, 1);

  const ownerId = await makeTeam(store, "Keeps", { teamtype: 0 });
  await makeWidget(store, "owned-by-team", { id: ownerId, logical_name: "team" });
  await assert.rejects(call("ConvertOwnerTeamToAccessTeam", { user: admin, target: { id: ownerId } }), (e) => e.status === 400);
  assert.equal(store.tableRows("team").find((t) => same(t.teamid, ownerId)).teamtype, 0);
  await denied(call("ConvertOwnerTeamToAccessTeam", { user: basic, target: { id: ownerId } }));
});

test("ReassignObjectsOwner moves the rows a principal owns to another, filtered by objectType, and needs Assign on each row", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID), basic = userOf(store, BASIC_OID), norole = userOf(store, NOROLE_OID);
  const widgetId = await makeWidget(store, "basic-owned", { id: basic.systemuserid });
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
  const widgetId = await makeWidget(store, "bound", { id: basic.systemuserid });
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
  const widgetId = await makeWidget(store, "shared", { id: admin.systemuserid });
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

test("RetrievePrivilegeSet returns the privilege rows as a collection", async () => {
  const { store, call } = await setup();
  const admin = userOf(store, ADMIN_OID);
  const result = await call("RetrievePrivilegeSet", { user: admin, target: { mapping: store.resolveMapping("privilege") } });
  assert.ok(result.body.value.some((p) => p.name === "prvReadWidget"));
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

test("install registers each second-set operation once, each with CSDL naming it", async () => {
  const { ops } = await setup();
  const names = ops.map((o) => o.name);
  const mine = ["ConvertOwnerTeamToAccessTeam", "ReassignObjectsOwner", "ReassignObjectsSystemUser", "ResetInheritedAccess", "GenerateSharedLink",
    "GrantAccessUsingSharedLink", "RetrieveSharedLinks", "RevokeSharedLink", "RetrieveAadUserSetOfPrivilegesByIds", "RetrieveAadUserSetOfPrivilegesByNames",
    "RetrieveAllChildUsersSystemUser", "RetrieveMaskedAttributesForEntity", "RetrieveUsersPrivilegesThroughTeams", "RetrievePrivilegeSet", "SetParentTeam", "SyncGroupMembersToTeam",
    "CreateAsyncJobToRevokeInheritedAccess", "GrantDelegatedAccess", "ProvisionDelegation", "RetrieveAppsWithDelegatedAccessPermissions",
    "CreateRoleWithPrivilegeCheckerRun", "GetConsentLink", "ConfirmConsentCode", "AddChannelAccessProfilePrivileges", "RetrieveChannelAccessProfilePrivileges"];
  for (const name of mine) {
    assert.equal(names.filter((n) => n === name).length, 1, name);
    assert.match(ops.find((o) => o.name === name).csdl, new RegExp(`Name="${name}"`));
  }
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
  const widgetId = await makeWidget(store, "inherited", { id: basic.systemuserid });
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
  const widgetId = await makeWidget(store, "access-info", { id: admin.systemuserid });
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
  const widgetId = await makeWidget(store, "delegated", { id: admin.systemuserid });
  const widgetOwned = await makeWidget(store, "delegated-owned", { id: admin.systemuserid });
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

test("The internal-only channel and sync messages are in $metadata and answer 501 by default; a dataverseMessages pack handler replaces them", async () => {
  const { store, ops, call, callOn, api } = await setup();
  const admin = userOf(store, ADMIN_OID);
  for (const name of ["AddChannelAccessProfilePrivileges", "RetrieveChannelAccessProfilePrivileges"]) {
    assert.match(ops.find((o) => o.name === name).csdl, new RegExp(`Name="${name}"`));
  }
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
