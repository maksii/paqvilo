// Metadata writes: table create/update/delete, columns, alternate keys and publish actions. Invented schema
// and loopback origin only; handlers are called with a fake api object, not through the router.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { createMetadataService } from "../lib/dataverse-metadata.mjs";
import { parseDataverseRoute } from "../lib/dataverse-odata.mjs";
import { handleMetadataWrite, install } from "../lib/dataverse-metadata-tables.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const VERSION = "v9.2";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
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

function fixtureStore() {
  const state = emptyState();
  // A solution table: not dataverseOnly, so the Web API must not change it.
  state.mappings.widget = { logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", fields: { name: { dataverseType: "nvarchar" } } };
  state.tables.widget = [];
  return new DataStore({ state });
}

const fakeApi = (store) => ({ store, change: (fn) => fn(), settings: { organizationId: ORG }, schema: null, addRoute() {} });

// Routes a request path through the parser, then the handler, as the router will.
async function send(api, method, path, { body, headers = {} } = {}) {
  const url = new URL(path, ORIGIN);
  return handleMetadataWrite({
    api, method, url, origin: ORIGIN, version: VERSION, route: parseDataverseRoute(url.pathname),
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body, requestId: "test",
  });
}

const ENTITIES = `/api/data/${VERSION}/EntityDefinitions`;
const entityPath = (logical) => `${ENTITIES}(LogicalName='${logical}')`;
const readService = (store) => createMetadataService({ organizationId: ORG, schema: null, mappings: () => store.state.mappings });

async function createBankAccount(api) {
  return send(api, "POST", ENTITIES, { body: tableBody() });
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

test("create table: 204 with OData-EntityId and a dataverseOnly mapping", async () => {
  const store = fixtureStore();
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
  assert.ok(mapping.dataverseMetadata.ObjectTypeCode >= 10000);
  assert.deepEqual(store.state.tables.new_bankaccount, []);
  assert.equal(mapping.fields.new_accountname.columnMetadata.isPrimaryName, true);
  // Read through the metadata service the Web API exposes (dataverse-metadata.mjs).
  const entity = readService(store).entity("new_bankaccount");
  assert.equal(entity.EntitySetName, "new_bankaccounts");
  assert.equal(entity.PrimaryNameAttribute, "new_accountname");
  assert.equal(entity.OwnershipType, "UserOwned");
});

test("create table rejects a missing prefix, a taken entity set and a non-string primary name", async () => {
  const store = fixtureStore();
  const api = fakeApi(store);
  await assert.rejects(send(api, "POST", ENTITIES, { body: tableBody({ SchemaName: "bankaccount" }) }), { details: { innerCode: "0x80044366" } });
  store.state.mappings.other = { logicalName: "other", entitySet: "new_bankaccounts", idColumn: "otherid", fields: {} };
  await assert.rejects(createBankAccount(api), { details: { innerCode: "0x8006089B" } });
  delete store.state.mappings.other;
  await assert.rejects(
    send(api, "POST", ENTITIES, { body: tableBody({ Attributes: [column("Memo", "new_Notes", { IsPrimaryName: true })] }) }),
    { status: 400 },
  );
  assert.equal(store.state.mappings.new_bankaccount, undefined);
});

test("columns: each supported type lands in fields, duplicates and lookups are refused", async () => {
  const store = fixtureStore();
  const api = fakeApi(store);
  await createBankAccount(api);
  const attributes = `${entityPath("new_bankaccount")}/Attributes`;
  const types = [
    column("Memo", "new_notes", { MaxLength: 2000 }),
    column("Integer", "new_count", { MinValue: 0, MaxValue: 99 }),
    column("Decimal", "new_ratio", { Precision: 3 }),
    column("Money", "new_balance", { Precision: 2 }),
    column("Boolean", "new_active", { OptionSet: { TrueOption: { Value: 1, Label: label("Yes") }, FalseOption: { Value: 0, Label: label("No") } }, DefaultValue: true }),
    column("DateTime", "new_opened", { Format: "DateOnly", DateTimeBehavior: { Value: "DateOnly" } }),
    column("Picklist", "new_tier", { OptionSet: { Options: [{ Value: 727000000, Label: label("Gold") }] } }),
    column("MultiSelectPicklist", "new_tags", { "GlobalOptionSet@odata.bind": "/GlobalOptionSetDefinitions(LogicalName='new_tagset')" }),
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
  assert.deepEqual(fields.new_tags.columnMetadata.optionSet, { isGlobal: true, name: "new_tagset" });
  assert.ok(fields.new_contract_name, "File adds the name column");
  const read = readService(store).attributes("new_bankaccount");
  assert.equal(read.find((a) => a.LogicalName === "new_balance")?.AttributeType, "Money");
  await assert.rejects(send(api, "POST", attributes, { body: column("Memo", "new_notes") }), { details: { innerCode: "0x80060304" } });
  await assert.rejects(send(api, "POST", attributes, { body: column("Lookup", "new_owner") }), { status: 501 });
  await assert.rejects(send(api, "POST", attributes, { body: column("String", "plain") }), { details: { innerCode: "0x80044366" } });
});

test("MergeLabels keeps other languages on tables and columns; without it the labels are replaced", async () => {
  const store = fixtureStore();
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

test("delete column and table remove the definition and its data", async () => {
  const store = fixtureStore();
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

test("alternate keys: allowed types, column and key limits", async () => {
  const store = fixtureStore();
  const api = fakeApi(store);
  await createBankAccount(api);
  const path = entityPath("new_bankaccount");
  await send(api, "POST", `${path}/Attributes`, { body: column("String", "new_code") });
  await send(api, "POST", `${path}/Attributes`, { body: column("Memo", "new_memo") });
  const keys = `${path}/Keys`;
  const result = await send(api, "POST", keys, { body: { SchemaName: "new_code_key", KeyAttributes: ["new_code"], DisplayName: label("Code") } });
  assert.equal(result.status, 204);
  assert.deepEqual(readService(store).keys("new_bankaccount").map((k) => [k.LogicalName, k.KeyAttributes]), [["new_code_key", ["new_code"]]]);
  await assert.rejects(send(api, "POST", keys, { body: { SchemaName: "new_memo_key", KeyAttributes: ["new_memo"] } }));
  await assert.rejects(send(api, "POST", keys, { body: { SchemaName: "new_wide_key", KeyAttributes: Array(17).fill("new_code") } }));
  for (let i = 0; i < 9; i++) await send(api, "POST", keys, { body: { SchemaName: `new_k${i}_key`, KeyAttributes: ["new_code"] } });
  await assert.rejects(send(api, "POST", keys, { body: { SchemaName: "new_eleventh_key", KeyAttributes: ["new_code"] } }));
});

test("publish actions answer 204; PublishXml needs ParameterXml; PATCH is refused", async () => {
  const store = fixtureStore();
  const api = fakeApi(store);
  assert.equal((await send(api, "POST", `/api/data/${VERSION}/PublishAllXml`)).status, 204);
  assert.equal((await send(api, "POST", `/api/data/${VERSION}/PublishXml`, { body: { ParameterXml: "<importexportxml/>" } })).status, 204);
  await assert.rejects(send(api, "POST", `/api/data/${VERSION}/PublishXml`, { body: {} }), { status: 400 });
  await createBankAccount(api);
  await assert.rejects(send(api, "PATCH", entityPath("new_bankaccount"), { body: tableBody() }), { status: 405 });
});
