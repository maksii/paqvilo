// Metadata writes: table create/update/delete, columns, alternate keys, privileges and publish actions. Invented schema
// and loopback origin only. The store is seeded with ensureSecurityModel, so principals, privileges and the seeded
// security tables are the runtime shapes; handlers are called directly, not through the router.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { createMetadataService } from "../lib/dataverse-metadata.mjs";
import { metadataWriteRoutes } from "../lib/dataverse-metadata-relationships.mjs";
import { parseDataverseRoute } from "../lib/dataverse-odata.mjs";
import { handleMetadataWrite, install, reapplyCustomColumns, reset } from "../lib/dataverse-metadata-tables.mjs";
import { createPrincipals, ensureSecurityModel, uuidV5 } from "../lib/dataverse-security.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { createChangeLog } from "../lib/dataverse-changes.mjs";
import { parsePrefer } from "../lib/dataverse-odata.mjs";
import { standardGlobalOptionSets } from "../lib/dataverse-standard.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const VERSION = "v9.2";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const CLERK_OID = "bbbbbbbb-0000-4000-8000-000000000002";
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
  users: [
    { objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] },
    { objectId: CLERK_OID, upn: "clerk@example.test", displayName: "Clerk", roles: ["Basic User"] },
  ],
};
const MERGE = { "MSCRM.MergeLabels": "true" };

const label = (text, code = 1033) => ({ LocalizedLabels: [{ Label: text, LanguageCode: code }] });
const column = (type, schema, extra = {}) => ({ "@odata.type": `#Microsoft.Dynamics.CRM.${type}AttributeMetadata`, SchemaName: schema, DisplayName: label(schema), ...extra });
const primaryName = () => column("String", "new_AccountName", { IsPrimaryName: true, MaxLength: 100, FormatName: { Value: "Text" } });
const tableBody = (extra = {}) => ({
  "@odata.type": "#Microsoft.Dynamics.CRM.EntityMetadata",
  SchemaName: "new_BankAccount",
  DisplayName: label("Bank Account"),
  DisplayCollectionName: label("Bank Accounts"),
  Description: label("Customer bank accounts"),
  OwnershipType: "UserOwned",
  IsActivity: false,
  HasActivities: false,
  HasNotes: false,
  Attributes: [primaryName()],
  ...extra,
});

// A solution table (not dataverseOnly) stands in for Solution content; the security model comes from ensureSecurityModel.
async function fixtureStore() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid",
    fields: {
      name: { dataverseType: "nvarchar" },
      // A Solution column with metadata but no origin pair (isManaged: false, isCustomizable: true).
      code: { dataverseType: "nvarchar", columnMetadata: { type: "nvarchar", schemaName: "Code", labels: {}, descriptionLabels: {}, requiredLevel: "none", isCustomField: true } },
    },
  };
  state.tables.widget = [];
  const store = new DataStore({ state });
  await ensureSecurityModel(store, SETTINGS);
  return store;
}

function fakeApi(store) {
  return { store, change: (fn) => fn(), settings: { organizationId: ORG }, schema: null, addRoute() {}, principals: createPrincipals(store, SETTINGS) };
}

// Routes a request path through the parser, then the handler, as the router will. The caller defaults to the administrator.
async function send(api, method, path, { body, headers = {}, caller = api.principals.byObjectId(ADMIN_OID) } = {}) {
  const url = new URL(path, ORIGIN);
  return handleMetadataWrite({
    api, method, url, origin: ORIGIN, version: VERSION, route: parseDataverseRoute(url.pathname), caller,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body, requestId: "test",
  });
}

const ENTITIES = `/api/data/${VERSION}/EntityDefinitions`;
const entityPath = (logical) => `${ENTITIES}(LogicalName='${logical}')`;
const readService = (store) => createMetadataService({ organizationId: ORG, schema: null, mappings: () => store.state.mappings });

async function createBankAccount(api) {
  return send(api, "POST", ENTITIES, { body: tableBody() });
}

// A global set made through its own Web API route, so its stored shape is the one the writes produce.
async function createGlobalSet(api, name) {
  const route = metadataWriteRoutes(api).find((r) => r.match(`/api/data/${VERSION}/GlobalOptionSetDefinitions`, "POST"));
  return route.handle({ method: "POST", url: new URL(`/api/data/${VERSION}/GlobalOptionSetDefinitions`, ORIGIN), origin: ORIGIN, version: VERSION, body: { Name: name, DisplayName: label(name) }, headers: {}, caller: api.principals.byObjectId(ADMIN_OID) });
}

test("install adds write routes for metadata paths only", () => {
  const routes = [];
  install({ addRoute: (match) => routes.push(match) });
  const [match] = routes;
  assert.equal(match(`/api/data/${VERSION}/EntityDefinitions`, "POST"), true);
  assert.equal(match(`/api/data/${VERSION}/EntityDefinitions(LogicalName='new_x')/Attributes`, "POST"), true);
  assert.equal(match(`/api/data/${VERSION}/PublishXml`, "POST"), true);
  assert.equal(match(`/api/data/${VERSION}/EntityDefinitions`, "GET"), false);
  assert.equal(match(`/api/data/${VERSION}/accounts`, "POST"), false);
});

test("create table: 204 with OData-EntityId and a dataverseOnly mapping flagged as created by the metadata API", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  const result = await createBankAccount(api);
  assert.equal(result.status, 204);
  const id = readService(store).metadataId("entity", "new_bankaccount");
  assert.equal(result.headers["OData-EntityId"], `${ORIGIN}/api/data/${VERSION}/EntityDefinitions(${id})`);
  const mapping = store.state.mappings.new_bankaccount;
  assert.equal(mapping.entitySet, "new_bankaccounts");
  assert.equal(mapping.idColumn, "new_bankaccountid");
  assert.equal(mapping.nameColumn, "new_accountname");
  assert.equal(mapping.userConfigured, true);
  assert.equal(mapping.dataverseOnly, true);
  assert.equal(mapping.dataverseMetadata.createdByMetadataApi, true);
  assert.ok(mapping.dataverseMetadata.ObjectTypeCode >= 10000);
  assert.deepEqual(store.state.tables.new_bankaccount, []);
  assert.equal(mapping.fields.new_accountname.columnMetadata.isPrimaryName, true);
  const entity = readService(store).entity("new_bankaccount");
  assert.equal(entity.EntitySetName, "new_bankaccounts");
  assert.equal(entity.PrimaryNameAttribute, "new_accountname");
  assert.equal(entity.OwnershipType, "UserOwned");
});

test("create table rejects a missing prefix, a quote in the name, a taken entity set and a non-string primary name", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  await assert.rejects(send(api, "POST", ENTITIES, { body: tableBody({ SchemaName: "bankaccount" }) }), { details: { innerCode: "0x80044366" } });
  await assert.rejects(send(api, "POST", ENTITIES, { body: tableBody({ SchemaName: "new_bank'account" }) }), { details: { innerCode: "0x80044366" } });
  store.state.mappings.other = { logicalName: "other", entitySet: "new_bankaccounts", idColumn: "otherid", fields: {} };
  await assert.rejects(createBankAccount(api), { details: { innerCode: "0x8006089B" } });
  delete store.state.mappings.other;
  await assert.rejects(
    send(api, "POST", ENTITIES, { body: tableBody({ Attributes: [column("Memo", "new_Notes", { IsPrimaryName: true })] }) }),
    { status: 400 },
  );
  assert.equal(store.state.mappings.new_bankaccount, undefined);
});

test("columns: each supported type lands in fields with the canonical choice shape; duplicates and lookups are refused", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  await createGlobalSet(api, "new_tagset");
  await createBankAccount(api);
  const attributes = `${entityPath("new_bankaccount")}/Attributes`;
  const types = [
    column("Memo", "new_notes", { MaxLength: 2000 }),
    column("Integer", "new_count", { MinValue: 0, MaxValue: 99 }),
    column("Decimal", "new_ratio", { Precision: 3 }),
    column("Money", "new_balance", { Precision: 2 }),
    column("Boolean", "new_active", { OptionSet: { TrueOption: { Value: 1, Label: label("Yes") }, FalseOption: { Value: 0, Label: label("No") } }, DefaultValue: true }),
    column("DateTime", "new_opened", { Format: "DateOnly", DateTimeBehavior: { Value: "DateOnly" } }),
    column("Picklist", "new_tier", { OptionSet: { Options: [{ Value: 727000000, Label: label("Gold") }, { Value: null, Label: label("Silver") }] } }),
    column("MultiSelectPicklist", "new_tags", { "GlobalOptionSet@odata.bind": "/GlobalOptionSetDefinitions(Name='new_tagset')" }),
    column("File", "new_contract", { MaxSizeInKB: 1024 }),
  ];
  for (const body of types) {
    const result = await send(api, "POST", attributes, { body });
    assert.equal(result.status, 204);
  }
  const fields = store.state.mappings.new_bankaccount.fields;
  assert.equal(fields.new_notes.columnMetadata.type, "memo");
  assert.equal(fields.new_balance.columnMetadata.type, "money");
  assert.equal(fields.new_active.columnMetadata.appDefaultValue, "1");
  assert.equal(fields.new_opened.dateTimeBehavior, "DateOnly");
  assert.deepEqual(fields.new_tier.columnMetadata.optionSet.options.map((o) => [o.value, o.label]), [[727000000, "Gold"], [727000001, "Silver"]]);
  assert.deepEqual(fields.new_tags.columnMetadata.optionSet, { isGlobal: true, name: "new_tagset" });
  assert.equal(fields.new_tags.globalOptionSet, "new_tagset");
  assert.ok(fields.new_contract_name, "File adds the name column");
  const read = readService(store).attributes("new_bankaccount");
  assert.equal(read.find((a) => a.LogicalName === "new_balance")?.AttributeType, "Money");
  await assert.rejects(send(api, "POST", attributes, { body: column("Memo", "new_notes") }), { details: { innerCode: "0x80060304" } });
  // A lookup is a relationship: the documented error points at RelationshipDefinitions. unverified message
  await assert.rejects(send(api, "POST", attributes, { body: column("Lookup", "new_owner") }), { status: 400 });
  await assert.rejects(send(api, "POST", attributes, { body: column("String", "plain") }), { details: { innerCode: "0x80044366" } });
});

test("picklist option values: null takes the next free value, a duplicate explicit value is refused, a quoted bind name is refused", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  await createBankAccount(api);
  const attributes = `${entityPath("new_bankaccount")}/Attributes`;
  const nulls = await send(api, "POST", attributes, { body: column("Picklist", "new_first", { OptionSet: { Options: [{ Value: null, Label: label("A") }, { Value: null, Label: label("B") }] } }) });
  assert.equal(nulls.status, 204);
  assert.deepEqual(store.state.mappings.new_bankaccount.fields.new_first.columnMetadata.optionSet.options.map((o) => o.value), [100000000, 100000001]);
  await assert.rejects(send(api, "POST", attributes, { body: column("Picklist", "new_dup", { OptionSet: { Options: [{ Value: 5, Label: label("A") }, { Value: 5, Label: label("B") }] } }) }), { status: 400 });
  assert.equal(store.state.mappings.new_bankaccount.fields.new_dup, undefined);
  await assert.rejects(send(api, "POST", attributes, { body: column("MultiSelectPicklist", "new_quoted", { "GlobalOptionSet@odata.bind": "/GlobalOptionSetDefinitions(Name='new_a''b')" }) }), { status: 400 });
});

test("global option set bind accepts Name= and the MetadataId form; an unknown MetadataId answers 404", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  await createGlobalSet(api, "new_tagset");
  await createBankAccount(api);
  const attributes = `${entityPath("new_bankaccount")}/Attributes`;
  const byId = `/GlobalOptionSetDefinitions(${uuidV5(ORG, "optionset:new_tagset")})`;
  assert.equal((await send(api, "POST", attributes, { body: column("MultiSelectPicklist", "new_by_id", { "GlobalOptionSet@odata.bind": byId }) })).status, 204);
  assert.deepEqual(store.state.mappings.new_bankaccount.fields.new_by_id.columnMetadata.optionSet, { isGlobal: true, name: "new_tagset" });
  await assert.rejects(send(api, "POST", attributes, { body: column("MultiSelectPicklist", "new_missing", { "GlobalOptionSet@odata.bind": `/GlobalOptionSetDefinitions(${uuidV5(ORG, "optionset:nope")})` }) }), { status: 404 });
  await assert.rejects(send(api, "POST", attributes, { body: column("MultiSelectPicklist", "new_wrong", { "GlobalOptionSet@odata.bind": "/GlobalOptionSetDefinitions(LogicalName='new_tagset')" }) }), { status: 400 });
});

test("MergeLabels keeps other languages on tables and columns; without it the labels are replaced", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  await createBankAccount(api);
  const path = entityPath("new_bankaccount");
  const german = { DisplayName: label("Bankkonto", 1031) };
  await send(api, "PUT", path, { body: tableBody({ ...german }), headers: MERGE });
  assert.deepEqual(store.state.mappings.new_bankaccount.dataverseMetadata.labels.DisplayName, { 1033: "Bank Account", 1031: "Bankkonto" });
  await send(api, "PUT", path, { body: tableBody({ DisplayName: label("Konto", 1031) }) });
  assert.deepEqual(store.state.mappings.new_bankaccount.dataverseMetadata.labels.DisplayName, { 1031: "Konto" });
  const attribute = `${path}/Attributes(${readService(store).metadataId("attribute", "new_bankaccount", "new_accountname")})`;
  await send(api, "PUT", attribute, { body: { DisplayName: label("Name", 1031) }, headers: MERGE });
  assert.deepEqual(store.state.mappings.new_bankaccount.fields.new_accountname.columnMetadata.labels, { 1033: "new_AccountName", 1031: "Name" });
  await assert.rejects(send(api, "PUT", entityPath("widget"), { body: tableBody({ SchemaName: "widget" }) }), { status: 400 });
});

test("column PUT changes the writable properties and refuses a property the column type does not have", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  await createBankAccount(api);
  await send(api, "POST", `${entityPath("new_bankaccount")}/Attributes`, { body: column("Integer", "new_count", { MinValue: 0, MaxValue: 99 }) });
  await send(api, "POST", `${entityPath("new_bankaccount")}/Attributes`, { body: column("Memo", "new_notes", { MaxLength: 500 }) });
  const service = readService(store);
  const countPath = `${entityPath("new_bankaccount")}/Attributes(${service.metadataId("attribute", "new_bankaccount", "new_count")})`;
  const notesPath = `${entityPath("new_bankaccount")}/Attributes(${service.metadataId("attribute", "new_bankaccount", "new_notes")})`;
  assert.equal((await send(api, "PUT", countPath, { body: { MaxValue: 500, RequiredLevel: { Value: "ApplicationRequired" } } })).status, 204);
  const count = store.state.mappings.new_bankaccount.fields.new_count.columnMetadata;
  assert.equal(count.maxValue, 500);
  assert.equal(count.minValue, 0, "an omitted property keeps its value");
  assert.equal(count.requiredLevel, "applicationrequired");
  await send(api, "PUT", notesPath, { body: { MaxLength: 2000 } });
  assert.equal(store.state.mappings.new_bankaccount.fields.new_notes.columnMetadata.maxLength, 2000);
  await assert.rejects(send(api, "PUT", countPath, { body: { MaxLength: 10 } }), { status: 400 });
  await assert.rejects(send(api, "PUT", notesPath, { body: { MinValue: 1 } }), { status: 400 });
});

test("delete column and table remove the definition and its data", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  await createBankAccount(api);
  await send(api, "POST", `${entityPath("new_bankaccount")}/Attributes`, { body: column("Memo", "new_notes") });
  store.state.tables.new_bankaccount.push({ new_bankaccountid: "1", new_notes: "kept" });
  const attribute = `${entityPath("new_bankaccount")}/Attributes(${readService(store).metadataId("attribute", "new_bankaccount", "new_notes")})`;
  assert.equal((await send(api, "DELETE", attribute)).status, 204);
  assert.equal(store.state.mappings.new_bankaccount.fields.new_notes, undefined);
  assert.equal("new_notes" in store.state.tables.new_bankaccount[0], false);
  await assert.rejects(send(api, "DELETE", entityPath("widget")), { status: 400 });
  assert.equal((await send(api, "DELETE", entityPath("new_bankaccount"))).status, 204);
  assert.equal(store.state.mappings.new_bankaccount, undefined);
  assert.equal(store.state.tables.new_bankaccount, undefined);
});

test("alternate keys: allowed types, column, key and 900-byte limits; DELETE removes a key", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  await createBankAccount(api);
  const path = entityPath("new_bankaccount");
  await send(api, "POST", `${path}/Attributes`, { body: column("String", "new_code") });
  await send(api, "POST", `${path}/Attributes`, { body: column("Memo", "new_memo") });
  await send(api, "POST", `${path}/Attributes`, { body: column("String", "new_long1", { MaxLength: 300 }) });
  await send(api, "POST", `${path}/Attributes`, { body: column("String", "new_long2", { MaxLength: 300 }) });
  const keys = `${path}/Keys`;
  const result = await send(api, "POST", keys, { body: { SchemaName: "new_code_key", KeyAttributes: ["new_code"], DisplayName: label("Code") } });
  assert.equal(result.status, 204);
  assert.deepEqual(readService(store).keys("new_bankaccount").map((k) => [k.LogicalName, k.KeyAttributes]), [["new_code_key", ["new_code"]]]);
  await assert.rejects(send(api, "POST", keys, { body: { SchemaName: "new_memo_key", KeyAttributes: ["new_memo"] } }));
  await assert.rejects(send(api, "POST", keys, { body: { SchemaName: "new_wide_key", KeyAttributes: Array(17).fill("new_code") } }));
  // Two 300-character text columns are 2 x 600 bytes, over the 900-byte limit; a single one is 600 bytes and fits.
  await assert.rejects(send(api, "POST", keys, { body: { SchemaName: "new_big_key", KeyAttributes: ["new_long1", "new_long2"] } }), { status: 400 });
  assert.equal((await send(api, "POST", keys, { body: { SchemaName: "new_long_key", KeyAttributes: ["new_long1"] } })).status, 204);
  for (let i = 0; i < 8; i++) await send(api, "POST", keys, { body: { SchemaName: `new_k${i}_key`, KeyAttributes: ["new_code"] } });
  await assert.rejects(send(api, "POST", keys, { body: { SchemaName: "new_eleventh_key", KeyAttributes: ["new_code"] } }));

  const keyId = readService(store).metadataId("key", "new_bankaccount", "new_code_key");
  assert.equal((await send(api, "DELETE", `${path}/Keys(${keyId})`)).status, 204);
  assert.equal(store.state.mappings.new_bankaccount.alternateKeys.some((k) => k.name === "new_code_key"), false);
  await assert.rejects(send(api, "DELETE", `${path}/Keys(${keyId})`), { status: 404 });
});

test("publish actions answer 204; PublishXml needs ParameterXml; PATCH is refused", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  assert.equal((await send(api, "POST", `/api/data/${VERSION}/PublishAllXml`)).status, 204);
  assert.equal((await send(api, "POST", `/api/data/${VERSION}/PublishXml`, { body: { ParameterXml: "<importexportxml/>" } })).status, 204);
  await assert.rejects(send(api, "POST", `/api/data/${VERSION}/PublishXml`, { body: {} }), { status: 400 });
  await createBankAccount(api);
  await assert.rejects(send(api, "PATCH", entityPath("new_bankaccount"), { body: tableBody() }), { status: 405 });
});

test("authorization: a caller without the customizer privileges is refused and the store is unchanged", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  const clerk = api.principals.byObjectId(CLERK_OID);
  const before = JSON.stringify(store.state.mappings);
  await assert.rejects(send(api, "POST", ENTITIES, { body: tableBody(), caller: clerk }), (e) => e.status === 403 && e.details.innerCode === "0x80040220");
  await assert.rejects(send(api, "POST", ENTITIES, { body: tableBody(), caller: null }), { status: 403 });
  assert.equal(JSON.stringify(store.state.mappings), before);
  await createBankAccount(api);
  await assert.rejects(send(api, "DELETE", entityPath("new_bankaccount"), { caller: clerk }), { status: 403 });
  await assert.rejects(send(api, "PUT", entityPath("new_bankaccount"), { body: tableBody(), caller: clerk }), { status: 403 });
  await assert.rejects(send(api, "POST", `${entityPath("new_bankaccount")}/Attributes`, { body: column("Memo", "new_notes"), caller: clerk }), { status: 403 });
  assert.equal(store.state.mappings.new_bankaccount.fields.new_notes, undefined);
  assert.ok(store.state.mappings.new_bankaccount, "the table survives the refused delete");
});

test("seeded security tables: no table-level writes or keys, but a custom column can be added; seeded columns are refused", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  assert.ok(store.state.mappings.role, "ensureSecurityModel seeds the role table");
  await assert.rejects(send(api, "DELETE", entityPath("role")), { status: 400 });
  await assert.rejects(send(api, "PUT", entityPath("systemuser"), { body: tableBody({ SchemaName: "systemuser" }) }), { status: 400 });
  await assert.rejects(send(api, "POST", `${entityPath("systemuser")}/Keys`, { body: { SchemaName: "new_key", KeyAttributes: ["fullname"] } }), { status: 400 });
  assert.ok(store.state.mappings.role, "the role table is still there");
  assert.equal((await send(api, "POST", `${entityPath("systemuser")}/Attributes`, { body: column("String", "new_extra") })).status, 204);
  assert.equal(store.state.mappings.systemuser.fields.new_extra.columnMetadata.isManaged, false);
  const fullname = `${entityPath("systemuser")}/Attributes(${readService(store).metadataId("attribute", "systemuser", "fullname")})`;
  await assert.rejects(send(api, "DELETE", fullname), { status: 400 });
  assert.ok(store.state.mappings.systemuser.fields.fullname, "the seeded column survives the refused delete");
});

test("a custom column on a Solution table: written and read through the records API, kept across a Solution refresh, deletable; Solution columns refused", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  const solutionFields = structuredClone(store.state.mappings.widget.fields);
  const attributes = `${ENTITIES}(LogicalName='widget')/Attributes`;
  const widgetAttribute = (name) => `${ENTITIES}(LogicalName='widget')/Attributes(${readService(store).metadataId("attribute", "widget", name)})`;
  assert.equal((await send(api, "POST", attributes, { body: column("String", "new_code", { MaxLength: 50 }) })).status, 204);
  assert.equal(store.state.mappings.widget.userConfigured, undefined, "the Solution mapping is not flipped to userConfigured");
  assert.equal(store.state.mappings.widget.dataverseOnly, undefined);

  // Records API: create with the custom column, read it back.
  const admin = api.principals.byObjectId(ADMIN_OID);
  const records = createRecordHandlers({ store, change: (fn) => fn(), principals: api.principals, metadataFields: () => undefined, changes: createChangeLog(store) });
  const recordSend = (method, path, body) => {
    const url = new URL(path, ORIGIN);
    return records.handle({ method, route: parseDataverseRoute(url.pathname), url, origin: ORIGIN, version: VERSION, prefer: parsePrefer(undefined), headers: {}, body, user: admin, caller: admin, identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid }, requestId: "test" });
  };
  const created = await recordSend("POST", `/api/data/${VERSION}/widgets`, { name: "Part", new_code: "A-1" });
  assert.equal(created.status, 204);
  const id = /\(([^()]+)\)$/.exec(created.headers["OData-EntityId"])[1];
  assert.equal((await recordSend("GET", `/api/data/${VERSION}/widgets(${id})?$select=new_code`)).body.new_code, "A-1");

  // A Solution refresh resets the mapping's fields to the Solution set: the custom column is gone until reapplied.
  store.state.mappings.widget.fields = structuredClone(solutionFields);
  assert.equal(store.state.mappings.widget.fields.new_code, undefined);
  reapplyCustomColumns(store);
  assert.equal(store.state.mappings.widget.fields.new_code.columnMetadata.isManaged, false);
  assert.equal((await recordSend("GET", `/api/data/${VERSION}/widgets(${id})?$select=new_code`)).body.new_code, "A-1", "the stored value is still there");

  // Solution columns (no origin pair, and the bare seeded name) are refused for update and delete.
  await assert.rejects(send(api, "DELETE", widgetAttribute("code")), { status: 400 });
  await assert.rejects(send(api, "PUT", widgetAttribute("code"), { body: { MaxLength: 10 } }), { status: 400 });
  await assert.rejects(send(api, "DELETE", widgetAttribute("name")), { status: 400 });
  assert.ok(store.state.mappings.widget.fields.code && store.state.mappings.widget.fields.name, "Solution columns survive");

  // The custom column itself is changeable and deletable; a delete is not resurrected by a later reapply.
  assert.equal((await send(api, "PUT", widgetAttribute("new_code"), { body: { MaxLength: 80 } })).status, 204);
  assert.equal(store.state.mappings.widget.fields.new_code.columnMetadata.maxLength, 80);
  assert.equal((await send(api, "DELETE", widgetAttribute("new_code"))).status, 204);
  reapplyCustomColumns(store);
  assert.equal(store.state.mappings.widget.fields.new_code, undefined);
});

test("metadata log: entity and attribute writes append add, change and delete entries in order; a refused write logs nothing", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  const log = () => (store.state.dataverse?.metadataLog ?? []).map(({ seq, op, kind, logical, name }) => ({ seq, op, kind, logical, name }));
  const entity = { op: "add", kind: "entity", logical: "new_bankaccount", name: null };

  await createBankAccount(api);
  assert.deepEqual(log().slice(0, 2), [
    { seq: 1, ...entity },
    { seq: 2, op: "add", kind: "attribute", logical: "new_bankaccount", name: "new_accountname" },
  ]);
  const seqBefore = log().length;

  // entity: change (PUT) and delete
  await send(api, "PUT", entityPath("new_bankaccount"), { body: tableBody({ DisplayName: label("Konto", 1031) }) });
  assert.deepEqual(log().at(-1), { seq: seqBefore + 1, op: "change", kind: "entity", logical: "new_bankaccount", name: null });

  // attribute: add (POST), change (PUT), delete (DELETE)
  const attributes = `${entityPath("new_bankaccount")}/Attributes`;
  await send(api, "POST", attributes, { body: column("Memo", "new_notes") });
  assert.deepEqual(log().at(-1), { seq: seqBefore + 2, op: "add", kind: "attribute", logical: "new_bankaccount", name: "new_notes" });
  const notesId = readService(store).metadataId("attribute", "new_bankaccount", "new_notes");
  await send(api, "PUT", `${attributes}(${notesId})`, { body: { MaxLength: 900 } });
  assert.deepEqual(log().at(-1), { seq: seqBefore + 3, op: "change", kind: "attribute", logical: "new_bankaccount", name: "new_notes" });
  await send(api, "DELETE", `${attributes}(${notesId})`);
  assert.deepEqual(log().at(-1), { seq: seqBefore + 4, op: "delete", kind: "attribute", logical: "new_bankaccount", name: "new_notes" });

  // entity: delete
  await send(api, "DELETE", entityPath("new_bankaccount"));
  assert.deepEqual(log().at(-1), { seq: seqBefore + 5, op: "delete", kind: "entity", logical: "new_bankaccount", name: null });

  // a refused write appends nothing
  const count = log().length;
  await assert.rejects(send(api, "DELETE", entityPath("widget")), { status: 400 });
  assert.equal(log().length, count);
});

test("reset(api) re-applies the stored custom columns onto a mapping that lost them", async () => {
  const state = emptyState();
  state.mappings.widget = { logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", fields: { name: { dataverseType: "nvarchar" } } };
  state.dataverse = { customColumns: { widget: { new_code: { dataverseType: "nvarchar", columnMetadata: { isManaged: false, isCustomizable: true } } } } };
  const store = new DataStore({ state });
  await reset({ store });
  assert.equal(store.state.mappings.widget.fields.new_code.columnMetadata.isManaged, false);
  assert.ok(store.state.mappings.widget.fields.name);
});

test("global set create refuses a name a standard global option set already has, in any case", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  const standard = Object.values(standardGlobalOptionSets())[0].name;
  await assert.rejects(createGlobalSet(api, standard), /already exists/);
  await assert.rejects(createGlobalSet(api, standard.toUpperCase()), /already exists/);
  assert.equal(store.state.dataverse?.globalOptionSets?.[standard], undefined, "no set is stored under the standard name");
  await createGlobalSet(api, "new_tagset");
  assert.ok(store.state.dataverse.globalOptionSets.new_tagset, "an unrelated name still creates");
});

// Records API caller for the table tests: the same handler the Web API routes use, as the given user.
function recordsFor(api, store) {
  const records = createRecordHandlers({ store, change: (fn) => fn(), principals: api.principals, metadataFields: () => undefined, changes: createChangeLog(store) });
  return (user, method, path, body, { admin = false } = {}) => {
    const url = new URL(path, ORIGIN);
    return records.handle({ method, route: parseDataverseRoute(url.pathname), url, origin: ORIGIN, version: VERSION, prefer: parsePrefer(undefined), headers: {}, body, user, caller: user, identity: { admin, id: user.systemuserid, systemUserId: user.systemuserid }, requestId: "test" });
  };
}

test("a table created through the metadata API has its privileges at once: the administrator writes and reads a row, a Basic User is refused", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  assert.equal((await createBankAccount(api)).status, 204);
  const entitySet = store.state.mappings.new_bankaccount.entitySet;
  const admin = api.principals.byObjectId(ADMIN_OID), clerk = api.principals.byObjectId(CLERK_OID);
  const recordSend = recordsFor(api, store);

  const created = await recordSend(admin, "POST", `/api/data/${VERSION}/${entitySet}`, { new_AccountName: "Main" }, { admin: true });
  assert.equal(created.status, 204);
  const id = /\(([^()]+)\)$/.exec(created.headers["OData-EntityId"])[1];
  assert.equal((await recordSend(admin, "GET", `/api/data/${VERSION}/${entitySet}(${id})?$select=new_AccountName`, undefined, { admin: true })).body.new_AccountName, "Main");

  // Basic User holds no grant on the new table: the standard missing-privilege error names the Create privilege.
  const denied = await recordSend(clerk, "POST", `/api/data/${VERSION}/${entitySet}`, { new_AccountName: "Side" }).then(() => null, (e) => e);
  assert.equal(denied?.status, 403);
  assert.equal(denied?.code, "PrivilegeDenied");
  assert.equal(denied?.details?.innerCode, "0x80040220");
  assert.match(denied.message, /prvCreatenew_BankAccount/);
});

test("created table privileges: one set per table, granted to System Administrator and System Customizer, removed when the table is deleted", async () => {
  const store = await fixtureStore();
  const api = fakeApi(store);
  const names = () => store.state.tables.privilege.map((p) => p.name).filter((n) => /new_BankAccount$/.test(n)).sort();
  const grants = () => store.state.tables.roleprivileges.filter((g) => store.state.tables.privilege.some((p) => p.privilegeid === (g.privilegeid?.id ?? g.privilegeid) && /new_BankAccount$/.test(p.name)));
  assert.equal((await createBankAccount(api)).status, 204);
  assert.deepEqual(names(), ["prvAppendTonew_BankAccount", "prvAppendnew_BankAccount", "prvCreatenew_BankAccount", "prvDeletenew_BankAccount", "prvReadnew_BankAccount", "prvWritenew_BankAccount", "prvAssignnew_BankAccount", "prvSharenew_BankAccount"].sort());
  assert.equal(grants().length, 8 * 2, "System Administrator and System Customizer hold each user-owned privilege");

  assert.equal((await send(api, "DELETE", entityPath("new_bankaccount"))).status, 204);
  assert.deepEqual(names(), [], "the privileges are gone with the table");
  assert.equal(grants().length, 0, "and so are the role grants on them");
  assert.ok(store.state.tables.roleprivileges.length > 0, "the built-in grants of other tables remain");
});
