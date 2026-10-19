// Record messages (Merge, InitializeFrom, CalculateRollupField, IsValidStateTransition,
// FormatAddress) on an invented schema. Handlers are called directly through a fake registry.
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
const CONTACT_1 = "cccccccc-0000-4000-8000-000000000001";
const CONTACT_2 = "cccccccc-0000-4000-8000-000000000002";
const WIDGET = "bbbbbbbb-0000-4000-8000-000000000001";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const USER = { systemuserid: "aaaaaaaa-0000-4000-8000-000000000001", denied: false };
const text = { dataverseType: "nvarchar" };
const lookup = { dataverseType: "lookup" };
const rollupFormula = '<fetch aggregate="true"><entity name="contact"><attribute name="contactid" alias="contactcount" aggregate="count"/>'
  + '<filter><condition attribute="parentaccountid" operator="eq" value="{id}"/></filter></entity></fetch>';

function fixtureState() {
  const state = emptyState();
  state.mappings.account = {
    logicalName: "account", entitySet: "accounts", idColumn: "accountid", nameColumn: "name",
    relationships: { account_contacts: { entity: "contact", from: "accountid", to: "parentaccountid", many: true } },
    fields: {
      name: text, telephone1: text, revenue: { dataverseType: "money" }, masterid: lookup,
      statecode: { dataverseType: "int" }, ownerid: lookup,
      statuscode: {
        dataverseType: "picklist",
        options: [
          { value: 1, label: "Active", state: 0 },
          { value: 2, label: "Inactive", state: 1 },
          { value: 3, label: "Parked", state: 0, TransitionData: [1] },
        ],
      },
      contactcount: { dataverseType: "int", SourceType: 2, formulaDefinition: rollupFormula },
    },
  };
  state.mappings.contact = {
    logicalName: "contact", entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname",
    relationships: { parentaccountid: { entity: "account", from: "parentaccountid", to: "accountid", many: false } },
    fields: { fullname: text, emailaddress1: { dataverseType: "nvarchar", validForCreate: false }, parentaccountid: lookup, statecode: { dataverseType: "int" } },
  };
  state.mappings.widget = { logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", fields: { name: text } };
  for (const logical of ["account", "contact", "widget", "entitymap", "attributemap"]) state.tables[logical] = [];
  state.tables.entitymap = [{ entitymapid: "e1", sourceentityname: "account", targetentityname: "contact" }];
  state.tables.attributemap = [
    { entitymapid: "e1", sourceattributename: "name", targetattributename: "fullname" },
    { entitymapid: "e1", sourceattributename: "telephone1", targetattributename: "emailaddress1" },
  ];
  return state;
}

function setup() {
  const state = fixtureState();
  state.tables.account.push(
    { accountid: ACCOUNT_A, name: "Alpha", telephone1: null, revenue: 100, masterid: null, statecode: 0, statuscode: 1 },
    { accountid: ACCOUNT_B, name: "Beta", telephone1: "555-0199", revenue: 250, masterid: null, statecode: 0, statuscode: 1 },
  );
  state.tables.contact.push(
    { contactid: CONTACT_1, fullname: "Ann", emailaddress1: "ann@example.test", parentaccountid: ACCOUNT_B, statecode: 0 },
    { contactid: CONTACT_2, fullname: "Bo", emailaddress1: "bo@example.test", parentaccountid: ACCOUNT_A, statecode: 0 },
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
  install({ registry: { register: (op) => ops.set(op.name, op) }, store, change: (fn) => fn(), principals, clock: () => CLOCK });
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
// Lookups written through @odata.bind are stored as { id, logical_name, name } references.
const refId = (value) => (value && typeof value === "object" ? value.id : value);

test("install registers the five messages as unbound operations", () => {
  const t = setup();
  assert.deepEqual([...t.ops.keys()].sort(), ["CalculateRollupField", "FormatAddress", "InitializeFrom", "IsValidStateTransition", "Merge"]);
  assert.equal(t.ops.get("Merge").kind, "action");
  assert.equal(t.ops.get("Merge").binding, "unbound");
  assert.equal(t.ops.get("InitializeFrom").kind, "function");
});

test("Merge fills the target's empty values, applies UpdateContent, moves children and deactivates the subordinate", async () => {
  const t = setup();
  const res = await t.call("Merge", {
    body: {
      Target: typed("account", "accountid", ACCOUNT_A),
      Subordinate: typed("account", "accountid", ACCOUNT_B),
      UpdateContent: { "@odata.type": "Microsoft.Dynamics.CRM.account", name: "Alpha Merged" },
      PerformParentingChecks: false,
    },
  });
  assert.equal(res.status, 204);
  const target = t.row("account", ACCOUNT_A, "accountid");
  assert.equal(target.name, "Alpha Merged", "UpdateContent overrides the target");
  assert.equal(target.telephone1, "555-0199", "a null target value takes the subordinate's value");
  assert.equal(target.revenue, 100, "a populated target value is kept");
  const subordinate = t.row("account", ACCOUNT_B, "accountid");
  assert.equal(subordinate.statecode, 1);
  assert.equal(subordinate.masterid, ACCOUNT_A);
  assert.equal(refId(t.row("contact", CONTACT_1, "contactid").parentaccountid), ACCOUNT_A, "the child row moves to the target");
  assert.equal(refId(t.row("contact", CONTACT_2, "contactid").parentaccountid), ACCOUNT_A, "a row already on the target is unchanged");
});

test("Merge rejects tables outside the list and entity objects without a key", async () => {
  const t = setup();
  const unsupported = await failure(t.call("Merge", {
    body: { Target: typed("widget", "widgetid", WIDGET), Subordinate: typed("widget", "widgetid", WIDGET) },
  }));
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.details.innerCode, "0x80040203");
  const untyped = await failure(t.call("Merge", {
    body: { Target: { accountid: ACCOUNT_A }, Subordinate: typed("account", "accountid", ACCOUNT_B) },
  }));
  assert.equal(untyped.status, 400);
  assert.equal(untyped.message, "EdmEntityObject passed should have the key property value set.");
});

test("Merge authorizes both records for update and the moved children for append, and writes nothing when denied", async () => {
  const t = setup();
  const body = { Target: typed("account", "accountid", ACCOUNT_A), Subordinate: typed("account", "accountid", ACCOUNT_B) };
  await t.call("Merge", { body });
  assert.deepEqual(t.authorized.filter((item) => item.operation === "update").map((item) => item.entity), ["account", "account"]);
  assert.ok(t.authorized.some((item) => item.entity === "contact" && item.operation === "append"));

  const denied = setup();
  const error = await failure(denied.call("Merge", { body, user: { ...USER, denied: true } }));
  assert.equal(error.code, "PermissionDenied");
  assert.equal(denied.row("account", ACCOUNT_B, "accountid").statecode, 0, "no write happens before authorization");
});

test("InitializeFrom returns the mapped columns with the parental bind and the Preference-Applied header", async () => {
  const t = setup();
  const res = await t.call("InitializeFrom", {
    method: "GET",
    params: { EntityMoniker: moniker("accounts", ACCOUNT_A), TargetEntityName: "contact", TargetFieldType: "All" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers["Preference-Applied"], "return=representation");
  assert.equal(res.body["@odata.type"], "#Microsoft.Dynamics.CRM.contact");
  assert.equal(res.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#contacts/$entity`);
  assert.equal(res.body["parentaccountid@odata.bind"], `accounts(${ACCOUNT_A})`);
  assert.equal(res.body.fullname, "Alpha");
  assert.equal(res.body.emailaddress1, undefined, "the source telephone is null on the fixture row");
});

test("InitializeFrom filters by TargetFieldType, honours SkipParentalRelationshipMapping and rejects bad input", async () => {
  const t = setup();
  t.row("account", ACCOUNT_A, "accountid").telephone1 = "555-0100";
  const forCreate = await t.call("InitializeFrom", {
    method: "GET",
    params: { EntityMoniker: moniker("accounts", ACCOUNT_A), TargetEntityName: "contact", TargetFieldType: "ValidForCreate" },
  });
  assert.equal(forCreate.body.emailaddress1, undefined, "a column not valid for create is dropped");
  assert.equal(forCreate.body.fullname, "Alpha");
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

test("CalculateRollupField recomputes the aggregate and stores the value with its date and state", async () => {
  const t = setup();
  t.row("contact", CONTACT_1, "contactid").parentaccountid = ACCOUNT_A;
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

test("CalculateRollupField rejects a column without a rollup definition", async () => {
  const t = setup();
  const error = await failure(t.call("CalculateRollupField", {
    method: "GET",
    params: { Target: moniker("accounts", ACCOUNT_A), FieldName: "name" },
  }));
  assert.equal(error.status, 400);
  assert.equal(error.details.innerCode, "0x80040203");
});

test("IsValidStateTransition checks the status option's state and its TransitionData", async () => {
  const t = setup();
  const check = (status, state) => t.call("IsValidStateTransition", {
    method: "GET",
    params: { Entity: moniker("accounts", ACCOUNT_A), NewState: state, NewStatus: status },
  });
  assert.deepEqual((await check(2, "1")).body.IsValid, true);
  assert.deepEqual((await check(2, "0")).body.IsValid, false, "the state must match the status option");

  t.row("account", ACCOUNT_A, "accountid").statuscode = 3;
  const parked = (status, state) => t.call("IsValidStateTransition", {
    method: "GET",
    params: { Entity: moniker("accounts", ACCOUNT_A), NewState: state, NewStatus: status },
  });
  assert.equal((await parked(1, "0")).body.IsValid, true, "TransitionData allows Active");
  assert.equal((await parked(2, "1")).body.IsValid, false, "TransitionData does not allow Inactive");

  const unknown = await failure(check(9, "0"));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.details.innerCode, "0x80044331");
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
