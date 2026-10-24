// Record messages (Merge, InitializeFrom, CalculateRollupField, IsValidStateTransition,
// FormatAddress). Handlers are called directly through a fake registry.
// Fixtures use the stored shapes: lookups are { id, logical_name, name } objects and exported
// column facts sit under columnMetadata.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { DataError } from "../lib/data-error.mjs";
import { install } from "../lib/dataverse-record-messages.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const VERSION = "v9.2";
const CLOCK = Date.parse("2026-10-19T12:00:00.000Z");
const ACCOUNT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ACCOUNT_B = "aaaaaaaa-0000-4000-8000-00000000000b";
const ACCOUNT_C = "aaaaaaaa-0000-4000-8000-00000000000c";
const ACCOUNT_D = "aaaaaaaa-0000-4000-8000-00000000000d";
const CONTACT_1 = "cccccccc-0000-4000-8000-000000000001";
const CONTACT_2 = "cccccccc-0000-4000-8000-000000000002";
const INCIDENT_1 = "dddddddd-0000-4000-8000-000000000001";
const INCIDENT_2 = "dddddddd-0000-4000-8000-000000000002";
const WIDGET = "bbbbbbbb-0000-4000-8000-000000000001";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const USER = { systemuserid: "aaaaaaaa-0000-4000-8000-000000000001", denied: false };
const text = { dataverseType: "nvarchar" };
const lookup = { dataverseType: "lookup" };
const rollupFormula = '<fetch aggregate="true"><entity name="contact"><attribute name="contactid" alias="contactcount" aggregate="count"/>'
  + '<filter><condition attribute="parentaccountid" operator="eq" value="{id}"/></filter></entity></fetch>';
const ref = (id, logical, name) => ({ id, logical_name: logical, name });
const refId = (value) => (value && typeof value === "object" ? value.id : value);
const statusOptions = [
  { value: 1, label: "Active", state: 0 },
  { value: 2, label: "Inactive", state: 1 },
  { value: 3, label: "Parked", state: 0, TransitionData: [1] },
];

function fixtureState() {
  const state = emptyState();
  state.mappings.account = {
    logicalName: "account", entitySet: "accounts", idColumn: "accountid", nameColumn: "name",
    relationships: {
      account_contacts: { entity: "contact", from: "accountid", to: "parentaccountid", many: true },
      parentaccountid: { entity: "account", from: "parentaccountid", to: "accountid", many: false },
    },
    fields: {
      name: text, telephone1: text, revenue: { dataverseType: "money" }, masterid: lookup, parentaccountid: lookup, ownerid: lookup,
      statecode: {
        dataverseType: "int",
        options: [{ value: 0, label: "Active", invariantName: "Active" }, { value: 1, label: "Inactive", invariantName: "Inactive" }],
      },
      statuscode: { dataverseType: "picklist", options: statusOptions },
      contactcount: { dataverseType: "int", columnMetadata: { sourceType: 2, formulaDefinition: rollupFormula } },
    },
  };
  state.mappings.contact = {
    logicalName: "contact", entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname",
    relationships: {
      parentaccountid: { entity: "account", from: "parentaccountid", to: "accountid", many: false },
      referredby: { entity: "account", from: "referredby", to: "accountid", many: false },
    },
    fields: {
      fullname: text, emailaddress1: { dataverseType: "nvarchar", columnMetadata: { validForCreate: false } },
      parentaccountid: lookup, referredby: lookup, statecode: { dataverseType: "int" },
    },
  };
  state.mappings.incident = {
    logicalName: "incident", entitySet: "incidents", idColumn: "incidentid", nameColumn: "title",
    fields: { title: text, statecode: { dataverseType: "int" } },
  };
  state.mappings.widget = { logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", fields: { name: text } };
  for (const logical of ["account", "contact", "incident", "widget", "entitymap", "attributemap"]) state.tables[logical] = [];
  state.tables.entitymap = [{ entitymapid: "e1", sourceentityname: "account", targetentityname: "contact" }];
  state.tables.attributemap = [
    { entitymapid: ref("e1", "entitymap", "Account to contact"), sourceattributename: "name", targetattributename: "fullname" },
    { entitymapid: ref("e1", "entitymap", "Account to contact"), sourceattributename: "telephone1", targetattributename: "emailaddress1" },
    { entitymapid: ref("e1", "entitymap", "Account to contact"), sourceattributename: "masterid", targetattributename: "referredby" },
  ];
  return state;
}

function setup({ fieldSecurity = null } = {}) {
  const state = fixtureState();
  state.tables.account.push(
    { accountid: ACCOUNT_A, name: "Alpha", telephone1: null, revenue: 100, masterid: null, parentaccountid: ref(ACCOUNT_C, "account", "Gamma"), statecode: 0, statuscode: 1 },
    { accountid: ACCOUNT_B, name: "Beta", telephone1: "555-0199", revenue: 250, masterid: null, parentaccountid: ref(ACCOUNT_C, "account", "Gamma"), statecode: 0, statuscode: 1 },
    { accountid: ACCOUNT_C, name: "Gamma", telephone1: null, revenue: 0, masterid: null, parentaccountid: null, statecode: 0, statuscode: 1 },
    { accountid: ACCOUNT_D, name: "Delta", telephone1: null, revenue: 0, masterid: null, parentaccountid: null, statecode: 0, statuscode: 1 },
  );
  state.tables.contact.push(
    { contactid: CONTACT_1, fullname: "Ann", emailaddress1: "ann@example.test", parentaccountid: ref(ACCOUNT_B, "account", "Beta"), referredby: null, statecode: 0 },
    { contactid: CONTACT_2, fullname: "Bo", emailaddress1: "bo@example.test", parentaccountid: ref(ACCOUNT_A, "account", "Alpha"), referredby: null, statecode: 0 },
  );
  state.tables.incident.push(
    { incidentid: INCIDENT_1, title: "Printer", statecode: 0 },
    { incidentid: INCIDENT_2, title: "Printer again", statecode: 0 },
  );
  const store = new DataStore({ state });
  const ops = new Map();
  const authorized = [];
  const principals = {
    authorize: (options) => {
      authorized.push(options);
      if (options.user.denied) throw new DataError("Privilege denied", 403, "PermissionDenied");
    },
  };
  install({ registry: { register: (op) => ops.set(op.name, op) }, store, change: (fn) => fn(), principals, clock: () => CLOCK, fieldSecurity });
  const call = async (name, { user = USER, ...rest } = {}) => ops.get(name).handle({
    method: "POST", origin: ORIGIN, version: VERSION, user, caller: user,
    identity: { admin: true, id: user.systemuserid }, params: {}, ...rest,
  });
  const row = (table, id, idColumn) => store.state.tables[table].find((item) => item[idColumn] === id);
  return { store, ops, authorized, call, row };
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

const typed = (logical, key, id) => ({ "@odata.type": `Microsoft.Dynamics.CRM.${logical}`, [key]: id });
const moniker = (set, id) => ({ "@odata.id": `${ORIGIN}/api/data/${VERSION}/${set}(${id})` });
const mergeBody = (overrides = {}) => ({
  Target: typed("account", "accountid", ACCOUNT_A),
  Subordinate: typed("account", "accountid", ACCOUNT_B),
  PerformParentingChecks: false,
  ...overrides,
});

test("install registers the five messages as unbound operations with CSDL", () => {
  const t = setup();
  assert.deepEqual([...t.ops.keys()].sort(), ["CalculateRollupField", "FormatAddress", "InitializeFrom", "IsValidStateTransition", "Merge"]);
  assert.equal(t.ops.get("Merge").kind, "action");
  assert.equal(t.ops.get("Merge").binding, "unbound");
  assert.equal(t.ops.get("InitializeFrom").kind, "function");
  for (const [name, tag] of [["Merge", "Action"], ["InitializeFrom", "Function"], ["CalculateRollupField", "Function"], ["IsValidStateTransition", "Function"], ["FormatAddress", "Function"]]) {
    assert.match(t.ops.get(name).csdl, new RegExp(`<${tag} Name="${name}"`), `${name} declares its CSDL`);
  }
  assert.match(t.ops.get("InitializeFrom").csdl, /<EnumType Name="TargetFieldType">/);
});

test("Merge fills the target's empty values, applies UpdateContent, moves children and deactivates the subordinate", async () => {
  const t = setup();
  const res = await t.call("Merge", {
    body: mergeBody({ UpdateContent: { "@odata.type": "Microsoft.Dynamics.CRM.account", name: "Alpha Merged" } }),
  });
  assert.equal(res.status, 204);
  const target = t.row("account", ACCOUNT_A, "accountid");
  assert.equal(target.name, "Alpha Merged", "UpdateContent overrides the target");
  assert.equal(target.telephone1, "555-0199", "a null target value takes the subordinate's value");
  assert.equal(target.revenue, 100, "a populated target value is kept");
  const subordinate = t.row("account", ACCOUNT_B, "accountid");
  assert.equal(subordinate.statecode, 1);
  assert.equal(refId(subordinate.masterid), ACCOUNT_A);
  assert.equal(refId(t.row("contact", CONTACT_1, "contactid").parentaccountid), ACCOUNT_A, "the child row moves to the target");
  assert.equal(refId(t.row("contact", CONTACT_2, "contactid").parentaccountid), ACCOUNT_A, "a row already on the target is unchanged");
});

test("Merge rejects tables outside the list and entity objects without a key", async () => {
  const t = setup();
  const unsupported = await failure(t.call("Merge", {
    body: mergeBody({ Target: typed("widget", "widgetid", WIDGET), Subordinate: typed("widget", "widgetid", WIDGET) }),
  }));
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.details.innerCode, "0x80040203");
  const untyped = await failure(t.call("Merge", {
    body: mergeBody({ Target: { accountid: ACCOUNT_A } }),
  }));
  assert.equal(untyped.status, 400);
  assert.equal(untyped.message, "EdmEntityObject passed should have the key property value set.");
});

test("Merge requires PerformParentingChecks", async () => {
  const t = setup();
  const body = { Target: typed("account", "accountid", ACCOUNT_A), Subordinate: typed("account", "accountid", ACCOUNT_B) };
  const error = await failure(t.call("Merge", { body }));
  assert.equal(error.status, 400);
  assert.equal(error.message, "The PerformParentingChecks parameter is required.");
  assert.equal(t.row("account", ACCOUNT_B, "accountid").statecode, 0, "nothing is written");
});

test("Merge with PerformParentingChecks refuses two different parents and writes nothing; without it the merge proceeds", async () => {
  const t = setup();
  t.row("account", ACCOUNT_B, "accountid").parentaccountid = ref(ACCOUNT_D, "account", "Delta");
  const error = await failure(t.call("Merge", { body: mergeBody({ PerformParentingChecks: true }) }));
  assert.equal(error.status, 400);
  assert.equal(t.row("account", ACCOUNT_B, "accountid").statecode, 0, "no write happens after the parenting check fails");
  assert.equal(refId(t.row("contact", CONTACT_1, "contactid").parentaccountid), ACCOUNT_B);

  const res = await t.call("Merge", { body: mergeBody({ PerformParentingChecks: false }) });
  assert.equal(res.status, 204);
  assert.equal(refId(t.row("contact", CONTACT_1, "contactid").parentaccountid), ACCOUNT_A);
});

test("Merge authorizes both records for update and the moved children for append, and writes nothing when denied", async () => {
  const t = setup();
  const body = mergeBody();
  await t.call("Merge", { body });
  assert.deepEqual(t.authorized.filter((item) => item.operation === "update").map((item) => item.entity), ["account", "account"]);
  assert.ok(t.authorized.some((item) => item.entity === "contact" && item.operation === "append"));

  const denied = setup();
  const error = await failure(denied.call("Merge", { body, user: { ...USER, denied: true } }));
  assert.equal(error.code, "PermissionDenied");
  assert.equal(denied.row("account", ACCOUNT_B, "accountid").statecode, 0, "no write happens before authorization");
});

test("Merge ignores UpdateContent for incident", async () => {
  const t = setup();
  const res = await t.call("Merge", {
    body: {
      Target: typed("incident", "incidentid", INCIDENT_1),
      Subordinate: typed("incident", "incidentid", INCIDENT_2),
      UpdateContent: { "@odata.type": "Microsoft.Dynamics.CRM.incident", title: "Replaced" },
      PerformParentingChecks: false,
    },
  });
  assert.equal(res.status, 204);
  assert.equal(t.row("incident", INCIDENT_1, "incidentid").title, "Printer", "the incident target keeps its title");
  assert.equal(t.row("incident", INCIDENT_2, "incidentid").statecode, 1);
});

test("Merge applies a lookup bind in UpdateContent", async () => {
  const t = setup();
  await t.call("Merge", {
    body: mergeBody({ UpdateContent: { "parentaccountid@odata.bind": `accounts(${ACCOUNT_D})` } }),
  });
  assert.equal(refId(t.row("account", ACCOUNT_A, "accountid").parentaccountid), ACCOUNT_D);
});

test("InitializeFrom returns the mapped columns with the parental bind and echoes the Prefer it was sent", async () => {
  const t = setup();
  const params = { EntityMoniker: moniker("accounts", ACCOUNT_A), TargetEntityName: "contact", TargetFieldType: "All" };
  const res = await t.call("InitializeFrom", { method: "GET", params, prefer: { representation: true } });
  assert.equal(res.status, 200);
  assert.equal(res.headers["Preference-Applied"], "return=representation");
  const bare = await t.call("InitializeFrom", { method: "GET", params });
  assert.equal(bare.headers["Preference-Applied"], undefined, "no Prefer, no Preference-Applied");
  assert.equal(res.body["@odata.type"], "#Microsoft.Dynamics.CRM.contact");
  assert.equal(res.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#contacts/$entity`);
  assert.equal(res.body["parentaccountid@odata.bind"], `accounts(${ACCOUNT_A})`);
  assert.equal(res.body.fullname, "Alpha");
  assert.equal(res.body.emailaddress1, undefined, "the source telephone is null on the fixture row");
});

test("InitializeFrom turns a stored lookup into its navigation bind", async () => {
  const t = setup();
  t.row("account", ACCOUNT_A, "accountid").masterid = ref(ACCOUNT_B, "account", "Beta");
  const res = await t.call("InitializeFrom", {
    method: "GET",
    params: { EntityMoniker: moniker("accounts", ACCOUNT_A), TargetEntityName: "contact", TargetFieldType: "All" },
  });
  assert.equal(res.body["referredby@odata.bind"], `accounts(${ACCOUNT_B})`);
  assert.equal(res.body.referredby, undefined, "the lookup object is not copied raw");
});

test("InitializeFrom filters by TargetFieldType in its enum name, numeric and qualified forms", async () => {
  const t = setup();
  t.row("account", ACCOUNT_A, "accountid").telephone1 = "555-0100";
  const initialize = (TargetFieldType) => t.call("InitializeFrom", {
    method: "GET",
    params: { EntityMoniker: moniker("accounts", ACCOUNT_A), TargetEntityName: "contact", TargetFieldType },
  });
  for (const value of ["ValidForCreate", 1, "1", "Microsoft.Dynamics.CRM.TargetFieldType'ValidForCreate'"]) {
    const res = await initialize(value);
    assert.equal(res.body.emailaddress1, undefined, `${value}: a column not valid for create is dropped`);
    assert.equal(res.body.fullname, "Alpha");
  }
  for (const value of ["All", 0, "ValidForUpdate", 2, 3]) {
    const res = await initialize(value);
    assert.equal(res.body.emailaddress1, "555-0100", `${value}: a column valid for create is kept`);
  }
  const bad = await failure(initialize(4));
  assert.equal(bad.status, 400);
});

test("InitializeFrom honours SkipParentalRelationshipMapping and rejects bad input", async () => {
  const t = setup();
  const skipped = await t.call("InitializeFrom", {
    method: "GET",
    params: { EntityMoniker: moniker("accounts", ACCOUNT_A), TargetEntityName: "contact", TargetFieldType: "All", SkipParentalRelationshipMapping: true },
  });
  assert.equal(skipped.body["parentaccountid@odata.bind"], undefined);
  const badType = await failure(t.call("InitializeFrom", {
    method: "GET",
    params: { EntityMoniker: moniker("accounts", ACCOUNT_A), TargetEntityName: "contact", TargetFieldType: "Bogus" },
  }));
  assert.equal(badType.status, 400);
  const missing = await failure(t.call("InitializeFrom", {
    method: "GET",
    params: { EntityMoniker: moniker("accounts", MISSING), TargetEntityName: "contact", TargetFieldType: "All" },
  }));
  assert.equal(missing.status, 404);
});

test("InitializeFrom does not copy secured source columns the caller cannot read", async () => {
  const calls = [];
  const t = setup({
    fieldSecurity: {
      mask: (user, logical, row) => {
        calls.push([user.systemuserid, logical]);
        return logical === "account" ? { ...row, telephone1: null } : row;
      },
    },
  });
  t.row("account", ACCOUNT_A, "accountid").telephone1 = "555-0100";
  const res = await t.call("InitializeFrom", {
    method: "GET",
    params: { EntityMoniker: moniker("accounts", ACCOUNT_A), TargetEntityName: "contact", TargetFieldType: "All" },
  });
  assert.equal(res.body.emailaddress1, undefined, "the masked source value is not copied");
  assert.equal(res.body.fullname, "Alpha");
  assert.deepEqual(calls.map(([, logical]) => logical), ["account", "contact"]);
  assert.equal(calls[0][0], USER.systemuserid);
});

test("CalculateRollupField recomputes the aggregate and stores the value with its date and state", async () => {
  const t = setup();
  t.row("contact", CONTACT_1, "contactid").parentaccountid = ref(ACCOUNT_A, "account", "Alpha");
  const res = await t.call("CalculateRollupField", {
    method: "GET",
    params: { Target: moniker("accounts", ACCOUNT_A), FieldName: "contactcount" },
  });
  assert.equal(res.status, 200);
  const stored = t.row("account", ACCOUNT_A, "accountid");
  assert.equal(stored.contactcount, 2);
  assert.equal(stored.contactcount_state, 1);
  assert.equal(stored.contactcount_date, new Date(CLOCK).toISOString());
  assert.equal(res.body.contactcount, 2);
});

test("CalculateRollupField reads under the read privilege and keeps modifiedon", async () => {
  const t = setup();
  t.row("account", ACCOUNT_A, "accountid").modifiedon = "2026-01-02T00:00:00.000Z";
  await t.call("CalculateRollupField", {
    method: "GET",
    params: { Target: moniker("accounts", ACCOUNT_A), FieldName: "contactcount" },
  });
  assert.ok(t.authorized.some((item) => item.entity === "account" && item.operation === "read"));
  assert.ok(!t.authorized.some((item) => item.operation === "update"));
  assert.equal(t.row("account", ACCOUNT_A, "accountid").modifiedon, "2026-01-02T00:00:00.000Z");
});

test("CalculateRollupField returns only the id, the column, its date and state, through the field mask", async () => {
  const t = setup({
    fieldSecurity: { mask: (user, logical, row) => ({ ...row, contactcount: null }) },
  });
  const res = await t.call("CalculateRollupField", {
    method: "GET",
    params: { Target: moniker("accounts", ACCOUNT_A), FieldName: "contactcount" },
  });
  assert.deepEqual(Object.keys(res.body).sort(), ["@odata.context", "accountid", "contactcount", "contactcount_date", "contactcount_state"].sort());
  assert.equal(res.body.contactcount, null, "a secured rollup value is masked in the response");
  assert.equal(t.row("account", ACCOUNT_A, "accountid").contactcount, 1, "the stored value is still written");
});

test("CalculateRollupField rejects a column without a rollup definition", async () => {
  const t = setup();
  const error = await failure(t.call("CalculateRollupField", {
    method: "GET",
    params: { Target: moniker("accounts", ACCOUNT_A), FieldName: "name" },
  }));
  assert.equal(error.status, 400);
  assert.equal(error.details.innerCode, "0x80040203");
});

test("IsValidStateTransition checks the status option's state, its TransitionData and the statecode name", async () => {
  const t = setup();
  const check = (status, state) => t.call("IsValidStateTransition", {
    method: "GET",
    params: { Entity: moniker("accounts", ACCOUNT_A), NewState: state, NewStatus: status },
  });
  assert.equal((await check(2, "1")).body.IsValid, true);
  assert.equal((await check(2, "0")).body.IsValid, false, "the state must match the status option");
  assert.equal((await check(2, "Inactive")).body.IsValid, true, "the statecode label is accepted");
  assert.equal((await check(1, "Inactive")).body.IsValid, false);

  t.row("account", ACCOUNT_A, "accountid").statuscode = 3;
  assert.equal((await check(1, "0")).body.IsValid, true, "TransitionData allows Active");
  assert.equal((await check(2, "1")).body.IsValid, false, "TransitionData does not allow Inactive");

  const unknown = await failure(check(9, "0"));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.details.innerCode, "0x8004F00E");
});

test("FormatAddress lays out the US form and rejects a missing part", async () => {
  const t = setup();
  const res = await t.call("FormatAddress", {
    method: "GET",
    params: { Line1: "1 Example Road", City: "Testville", StateOrProvince: "TS", PostalCode: "00000", Country: "Testland" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.Address, "1 Example Road\r\nTestville, TS 00000\r\nTestland");
  const error = await failure(t.call("FormatAddress", { method: "GET", params: { Line1: "1 Example Road" } }));
  assert.equal(error.status, 400);
});
