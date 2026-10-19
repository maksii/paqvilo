// Simulated Dataverse column (field) security: profile matrix, team profiles, field sharing,
// administrator bypass, write errors and RetrievePrincipalAttributePrivileges. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DataStore, emptyState } from "../lib/data.mjs";
import { createPrincipals, ensureSecurityModel, uuidV5 } from "../lib/dataverse-security.mjs";
import { ensureFieldSecurity, fieldSecurity, SYSTEM_ADMINISTRATOR_PROFILE_ID } from "../lib/dataverse-fls.mjs";

const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const BASIC_OID = "aaaaaaaa-0000-4000-8000-000000000002";
const OUTSIDER_OID = "aaaaaaaa-0000-4000-8000-000000000003";
const TEAM = "bbbbbbbb-0000-4000-8000-000000000001";
const PROFILE = "dddddddd-0000-4000-8000-000000000001";
const TEAM_PROFILE = "dddddddd-0000-4000-8000-000000000002";
const W1 = "cccccccc-0000-4000-8000-000000000001";
const W2 = "cccccccc-0000-4000-8000-000000000002";
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
  users: [
    { objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] },
    { objectId: BASIC_OID, upn: "basic@example.test", displayName: "Basic", roles: ["Basic User"] },
    { objectId: OUTSIDER_OID, upn: "outsider@example.test", displayName: "Outsider", roles: ["Basic User"] },
  ],
};
const ANNOTATION = "secret@OData.Community.Display.V1.FormattedValue";

const text = { dataverseType: "nvarchar" };

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    fields: {
      name: text,
      secret: { ...text, columnMetadata: { isSecured: true } },
      grade: { ...text, dataverseMetadata: { isSecured: true } },
      label: { ...text, columnMetadata: { isSecured: true }, dataverseMetadata: { isSecured: false } },
    },
  };
  state.tables.widget = [
    { widgetid: W1, name: "w1", secret: "s1", grade: "A", label: "x" },
    { widgetid: W2, name: "w2", secret: "s2", grade: "B", label: "y" },
  ];
  return state;
}

async function setup() {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  await ensureFieldSecurity(store);
  const principals = createPrincipals(store, SETTINGS);
  const ops = [], hooks = {};
  fieldSecurity.install({
    store, principals, settings: SETTINGS,
    registry: { register: (op) => ops.push(op) },
    recordHooks: { add: (n, fn) => { hooks[n] = fn; } },
  });
  const add = (table, row) => store.transact(() => store.state.tables[table].push(row));
  const mapping = store.state.mappings.widget;
  const user = (oid) => principals.byObjectId(oid);
  const formatted = (id) => ({ widgetid: id, name: "w", secret: "s1", [ANNOTATION]: "s1", grade: "A", label: "x" });
  const grant = (flags) => add("fieldpermission", {
    fieldpermissionid: randomUUID(), fieldsecurityprofileid: { id: PROFILE }, entityname: "widget",
    attributelogicalname: "secret", cancreate: 0, canread: 0, canupdate: 0, canreadunmasked: 0, ...flags,
  });
  const write = (operation, u, data, existing) => hooks.beforeWrite({ user: u, target: existing ? { id: existing.widgetid } : undefined }, mapping, { operation, data, existing });
  const project = (u, row) => { hooks.project({ user: u }, mapping, row); return row; };
  // Lookups name systemuser GUIDs, not the Entra object ids the settings use.
  const sid = (oid) => principals.byObjectId(oid).systemuserid;
  return { store, principals, ops, hooks, add, grant, user, sid, formatted, write, project, mapping };
}

test("seeds dataverse-only field security mappings and the System Administrator profile once", async () => {
  const { store } = await setup();
  await ensureFieldSecurity(store);
  for (const logical of ["fieldsecurityprofile", "fieldpermission", "systemuserprofiles", "teamprofiles", "principalobjectattributeaccess"]) {
    assert.equal(store.state.mappings[logical].dataverseOnly, true, logical);
    assert.equal(store.state.mappings[logical].userConfigured, true, logical);
  }
  const profiles = store.tableRows("fieldsecurityprofile").filter((p) => p.fieldsecurityprofileid === SYSTEM_ADMINISTRATOR_PROFILE_ID);
  assert.equal(profiles.length, 1);
});

test("profile matrix: a secured column reads as null without canread and keeps its value with canread 4", async () => {
  const t = await setup();
  const basic = t.user(BASIC_OID);
  // Basic user holds no profile yet: secured and graded columns are nulled, annotations removed, unsecured kept.
  const denied = t.project(basic, t.formatted(W1));
  assert.equal(denied.secret, null);
  assert.equal(Object.hasOwn(denied, ANNOTATION), false);
  assert.equal(denied.grade, null);
  assert.equal(denied.label, "x");
  assert.equal(denied.name, "w");
  // A profile with canread 4 on secret, linked to the basic user.
  await t.add("fieldsecurityprofile", { fieldsecurityprofileid: PROFILE, name: "Reader" });
  await t.add("systemuserprofiles", { systemuserprofileid: randomUUID(), systemuserid: { id: t.sid(BASIC_OID) }, fieldsecurityprofileid: { id: PROFILE } });
  await t.grant({ canread: 4 });
  await t.grant({ attributelogicalname: "grade", canread: 0 });
  const allowed = t.project(basic, t.formatted(W1));
  assert.equal(allowed.secret, "s1");
  assert.equal(allowed[ANNOTATION], "s1");
  assert.equal(allowed.grade, null);
});

test("team profiles reach the members of the team and nobody else", async () => {
  const t = await setup();
  await t.add("teamprofiles", { teamprofileid: randomUUID(), teamid: { id: TEAM }, fieldsecurityprofileid: { id: TEAM_PROFILE } });
  await t.add("fieldsecurityprofile", { fieldsecurityprofileid: TEAM_PROFILE, name: "Team reader" });
  await t.add("teammembership", { teammembershipid: randomUUID(), systemuserid: { id: t.sid(BASIC_OID) }, teamid: { id: TEAM } });
  await t.add("fieldpermission", { fieldpermissionid: randomUUID(), fieldsecurityprofileid: { id: TEAM_PROFILE }, entityname: "widget", attributelogicalname: "secret", canread: 4, cancreate: 0, canupdate: 0, canreadunmasked: 0 });
  assert.equal(t.project(t.user(BASIC_OID), t.formatted(W1)).secret, "s1");
  assert.equal(t.project(t.user(OUTSIDER_OID), t.formatted(W1)).secret, null);
});

test("field sharing grants read to one record and the principal named in the share only", async () => {
  const t = await setup();
  const basic = t.user(BASIC_OID);
  await t.add("principalobjectattributeaccess", {
    principalobjectattributeaccessid: randomUUID(), objectid: { id: W1 },
    attributeid: uuidV5(ORG, "attribute:widget:secret"), principalid: { id: t.sid(BASIC_OID) }, readaccess: true, updateaccess: false,
  });
  assert.equal(t.project(basic, t.formatted(W1)).secret, "s1");
  assert.equal(t.project(basic, t.formatted(W2)).secret, null);
  assert.equal(t.project(t.user(OUTSIDER_OID), t.formatted(W1)).secret, null);
});

test("writes: create needs cancreate, update needs canupdate or an update share, errors carry the inner codes", async () => {
  const t = await setup();
  const basic = t.user(BASIC_OID);
  const w1 = t.store.tableRows("widget")[0];
  assert.throws(() => t.write("create", basic, { secret: "x" }), (e) => {
    assert.equal(e.status, 403);
    assert.equal(e.details.innerCode, "0x8004f502");
    assert.match(e.message, /does not have create permissions to a secret secured field on entity widget/);
    return true;
  });
  assert.throws(() => t.write("update", basic, { secret: "x" }, w1), (e) => e.details.innerCode === "0x8004f507");
  // Writes without secured keys never need a permission.
  t.write("create", basic, { name: "fine" });
  await t.add("fieldsecurityprofile", { fieldsecurityprofileid: PROFILE, name: "Editor" });
  await t.add("systemuserprofiles", { systemuserprofileid: randomUUID(), systemuserid: { id: t.sid(BASIC_OID) }, fieldsecurityprofileid: { id: PROFILE } });
  await t.grant({ cancreate: 4, canupdate: 4 });
  t.write("create", basic, { secret: "x" });
  t.write("update", basic, { secret: "x" }, w1);
  // An update share with updateaccess passes on its record only.
  await t.add("principalobjectattributeaccess", {
    principalobjectattributeaccessid: randomUUID(), objectid: { id: W2 },
    attributeid: uuidV5(ORG, "attribute:widget:secret"), principalid: { id: t.sid(BASIC_OID) }, readaccess: false, updateaccess: true,
  });
  const w2 = t.store.tableRows("widget")[1];
  assert.throws(() => t.write("update", t.user(OUTSIDER_OID), { secret: "x" }, w2), (e) => e.details.innerCode === "0x8004f507");
  t.write("update", basic, { secret: "x" }, w2);
});

test("System Administrator users bypass every secured column", async () => {
  const t = await setup();
  const admin = t.user(ADMIN_OID);
  assert.equal(t.project(admin, t.formatted(W1)).secret, "s1");
  t.write("create", admin, { secret: "x" });
  t.write("update", admin, { secret: "x" }, t.store.tableRows("widget")[0]);
});

test("RetrievePrincipalAttributePrivileges reports the profile permissions of a systemuser or team", async () => {
  const t = await setup();
  const op = (kind) => t.ops.find((o) => o.name === "RetrievePrincipalAttributePrivileges" && o.entity === kind);
  assert.ok(op("systemuser") && op("team"));
  await t.add("fieldsecurityprofile", { fieldsecurityprofileid: PROFILE, name: "Editor" });
  await t.add("systemuserprofiles", { systemuserprofileid: randomUUID(), systemuserid: { id: t.sid(BASIC_OID) }, fieldsecurityprofileid: { id: PROFILE } });
  await t.grant({ canread: 4, cancreate: 4, canreadunmasked: 1 });
  const body = op("systemuser").handle({ target: { mapping: { logicalName: "systemuser" }, id: t.sid(BASIC_OID) } }).body;
  assert.deepEqual(body.AttributePrivileges, [{
    AttributeId: uuidV5(ORG, "attribute:widget:secret"), CanCreate: 4, CanRead: 4, CanReadUnMasked: 1, CanUpdate: 0,
  }]);
  assert.deepEqual(op("systemuser").handle({ target: { mapping: { logicalName: "systemuser" }, id: t.sid(OUTSIDER_OID) } }).body.AttributePrivileges, []);
  assert.deepEqual(op("team").handle({ target: { mapping: { logicalName: "team" }, id: TEAM } }).body.AttributePrivileges, []);
});
