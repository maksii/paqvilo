// Metadata writes for relationships and choices, over an invented schema. The api object is a fake built here
// (the registry and hooks are not wired yet); the association checks run through the record handlers.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { metadataWriteOperations, metadataWriteRoutes } from "../lib/dataverse-metadata-relationships.mjs";
import { parseDataverseRoute, parsePrefer } from "../lib/dataverse-odata.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { createPrincipals, ensureSecurityModel, uuidV5 } from "../lib/dataverse-security.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const VERSION = "v9.2";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
  users: [{ objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] }],
};
const text = { dataverseType: "nvarchar" };
const label = (value, code = 1033) => ({ LocalizedLabels: [{ Label: value, LanguageCode: code }], UserLocalizedLabel: { Label: value, LanguageCode: code } });

function fixtureState() {
  const state = emptyState();
  state.mappings.account = {
    logicalName: "account", entitySet: "accounts", idColumn: "accountid", nameColumn: "name", fields: { name: text }, relationships: {},
  };
  state.mappings.contact = {
    logicalName: "contact", entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname", fields: { fullname: text }, relationships: {},
  };
  state.mappings.sample_bank = {
    logicalName: "sample_bank", entitySet: "sample_banks", idColumn: "sample_bankid", nameColumn: "name",
    fields: {
      name: text,
      sample_choice: { dataverseType: "picklist", options: [{ value: 1, label: "Open", labels: { 1033: "Open", 1036: "Ouvert" } }, { value: 2, label: "Closed" }] },
      statuscode: { dataverseType: "status", statuses: [{ value: 1, label: "Active", state: 0 }] },
      statecode: { dataverseType: "state", states: [{ value: 0, label: "Active" }, { value: 1, label: "Inactive" }] },
      sample_color: { dataverseType: "picklist", globalOptionSet: "sample_colors" },
    },
    relationships: {},
  };
  for (const logical of Object.keys(state.mappings)) state.tables[logical] = [];
  return state;
}

async function setup() {
  const store = new DataStore({ state: fixtureState() });
  const api = { store, change: (fn) => fn(), settings: { organizationId: ORG } };
  const routes = metadataWriteRoutes(api);
  const ops = Object.fromEntries(metadataWriteOperations(api).map((op) => [op.name, op]));
  return { api, store, routes, ops };
}

// A request to a metadata route; undefined when no route matches (the router would fall through).
async function metadata(t, method, path, body, headers = {}) {
  const url = new URL(path, ORIGIN);
  const hit = t.routes.find((route) => route.match(url.pathname, method));
  assert.ok(hit, `no route for ${method} ${path}`);
  return hit.handle({ method, url, origin: ORIGIN, version: VERSION, body, headers });
}

async function action(t, name, body, headers = {}) {
  return t.ops[name].handle({ method: "POST", url: new URL(`/api/data/${VERSION}/${name}`, ORIGIN), origin: ORIGIN, version: VERSION, body, headers });
}

const relationshipPath = () => `/api/data/${VERSION}/RelationshipDefinitions`;
const oneToMany = (overrides = {}) => ({
  "@odata.type": "#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
  SchemaName: "sample_bank_account",
  ReferencedEntity: "account",
  ReferencedAttribute: "accountid",
  ReferencingEntity: "sample_bank",
  CascadeConfiguration: { Assign: "NoCascade", Delete: "RemoveLink" },
  Lookup: { "@odata.type": "#Microsoft.Dynamics.CRM.LookupAttributeMetadata", SchemaName: "sample_AccountId", LogicalName: "sample_accountid", DisplayName: label("Account") },
  ...overrides,
});
const manyToMany = (overrides = {}) => ({
  "@odata.type": "#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
  SchemaName: "sample_bank_contact",
  Entity1LogicalName: "sample_bank",
  Entity2LogicalName: "contact",
  IntersectEntityName: "sample_bank_contact_link",
  ...overrides,
});
const relationshipId = (schema) => uuidV5(ORG, `relationship:${schema}`);
const failing = (status) => ({ status });

test("1:N create adds the lookup and both navigation entries, answering 204 with the RelationshipDefinitions id", async () => {
  const t = await setup();
  const res = await metadata(t, "POST", relationshipPath(), oneToMany());
  assert.equal(res.status, 204);
  assert.equal(res.headers["OData-EntityId"], `${ORIGIN}/api/data/${VERSION}/RelationshipDefinitions(${relationshipId("sample_bank_account")})`);
  const { mappings } = t.store.state;
  assert.deepEqual(mappings.sample_bank.fields.sample_accountid, { dataverseType: "lookup", targets: ["account"], label: "Account", schemaName: "sample_AccountId" });
  assert.deepEqual(mappings.account.relationships.sample_bank_account, {
    entity: "sample_bank", from: "accountid", to: "sample_accountid", many: true, partner: "sample_accountid",
    schemaName: "sample_bank_account", cascade: { Assign: "NoCascade", Delete: "RemoveLink" },
  });
  assert.deepEqual(mappings.sample_bank.relationships.sample_accountid, {
    entity: "account", from: "sample_accountid", to: "accountid", many: false, partner: "sample_bank_account",
    schemaName: "sample_bank_account", cascade: { Assign: "NoCascade", Delete: "RemoveLink" },
  });
});

test("1:N navigation names come from the explicit properties when given", async () => {
  const t = await setup();
  await metadata(t, "POST", relationshipPath(), oneToMany({
    ReferencingEntityNavigationPropertyName: "bank_account",
    ReferencedEntityNavigationPropertyName: "bank_list",
  }));
  assert.ok(t.store.state.mappings.account.relationships.bank_list);
  assert.equal(t.store.state.mappings.sample_bank.relationships.bank_account.entity, "account");
});

test("1:N create rejects a duplicate name, an existing lookup, a second hierarchy and unknown tables", async () => {
  const t = await setup();
  await metadata(t, "POST", relationshipPath(), oneToMany());
  await assert.rejects(metadata(t, "POST", relationshipPath(), oneToMany()), failing(400));
  await assert.rejects(metadata(t, "POST", relationshipPath(), oneToMany({ SchemaName: "other_link", ReferencedEntity: "contact", ReferencedAttribute: "contactid" })), failing(400));
  // one hierarchical relationship per table: the first is accepted, the second is refused
  await metadata(t, "POST", relationshipPath(), oneToMany({ SchemaName: "bank_parent_one", IsHierarchical: true, Lookup: { LogicalName: "sample_parentone" } }));
  await assert.rejects(metadata(t, "POST", relationshipPath(), oneToMany({ SchemaName: "bank_parent_two", IsHierarchical: true, Lookup: { LogicalName: "sample_parenttwo" } })), failing(400));
  await assert.rejects(metadata(t, "POST", relationshipPath(), oneToMany({ SchemaName: "x_y", ReferencedEntity: "missing", Lookup: { LogicalName: "sample_missing" } })), failing(404));
  // a rejected write leaves nothing behind
  assert.equal(t.store.state.mappings.sample_bank.fields.sample_parenttwo, undefined);
  assert.equal(t.store.state.mappings.account.relationships.bank_parent_two, undefined);
});

test("N:N create adds an intersect mapping and a navigation entry on each side", async () => {
  const t = await setup();
  const res = await metadata(t, "POST", relationshipPath(), manyToMany());
  assert.equal(res.status, 204);
  const { mappings } = t.store.state;
  assert.deepEqual(mappings.sample_bank_contact_link, {
    logicalName: "sample_bank_contact_link", entitySet: "sample_bank_contact_links", idColumn: "sample_bank_contact_linkid",
    userConfigured: true, dataverseOnly: true,
    fields: { sample_bankid: { dataverseType: "lookup", targets: ["sample_bank"] }, contactid: { dataverseType: "lookup", targets: ["contact"] } },
    relationships: {},
  });
  assert.equal(mappings.sample_bank.relationships.sample_bank_contact.intersect.entity, "sample_bank_contact_link");
  assert.equal(mappings.contact.relationships.sample_bank_contact.partner, "sample_bank_contact");
  assert.ok(Array.isArray(t.store.state.tables.sample_bank_contact_link));
});

test("PUT changes cascade, DELETE of a 1:N removes its lookup, DELETE of N:N removes the intersect table", async () => {
  const t = await setup();
  await metadata(t, "POST", relationshipPath(), oneToMany());
  await metadata(t, "PUT", `${relationshipPath()}(${relationshipId("sample_bank_account")})`, {
    CascadeConfiguration: { Delete: "Cascade" },
  }, { "MSCRM.MergeLabels": "true" });
  assert.equal(t.store.state.mappings.account.relationships.sample_bank_account.cascade.Delete, "Cascade");

  await metadata(t, "DELETE", `${relationshipPath()}(${relationshipId("sample_bank_account")})`);
  assert.equal(t.store.state.mappings.account.relationships.sample_bank_account, undefined);
  assert.equal(t.store.state.mappings.sample_bank.fields.sample_accountid, undefined);

  await metadata(t, "POST", relationshipPath(), manyToMany());
  await metadata(t, "DELETE", `${relationshipPath()}(${relationshipId("sample_bank_contact")})`);
  assert.equal(t.store.state.mappings.sample_bank_contact_link, undefined);
  assert.equal(t.store.state.mappings.contact.relationships.sample_bank_contact, undefined);
});

test("CreateCustomerRelationships writes one customer column with two relationships and returns their ids", async () => {
  const t = await setup();
  const res = await action(t, "CreateCustomerRelationships", {
    Lookup: { SchemaName: "sample_CustomerId", LogicalName: "sample_customerid", DisplayName: label("Customer") },
    OneToManyRelationships: [
      { SchemaName: "sample_bank_customer_account", ReferencedEntity: "account", ReferencedAttribute: "accountid", ReferencingEntity: "sample_bank" },
      { SchemaName: "sample_bank_customer_contact", ReferencedEntity: "contact", ReferencedAttribute: "contactid", ReferencingEntity: "sample_bank" },
    ],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.RelationshipIds, [relationshipId("sample_bank_customer_account"), relationshipId("sample_bank_customer_contact")]);
  assert.equal(res.body.AttributeId, uuidV5(ORG, "attribute:sample_bank:sample_customerid"));
  const field = t.store.state.mappings.sample_bank.fields.sample_customerid;
  assert.equal(field.dataverseType, "customer");
  assert.deepEqual(field.targets, ["account", "contact"]);
  assert.equal(t.store.state.mappings.sample_bank.relationships.sample_customerid_account.entity, "account");
  assert.equal(t.store.state.mappings.sample_bank.relationships.sample_customerid_contact.entity, "contact");

  // deleting one relationship keeps the column for the other target
  await metadata(t, "DELETE", `${relationshipPath()}(${relationshipId("sample_bank_customer_account")})`);
  assert.ok(t.store.state.mappings.sample_bank.fields.sample_customerid);
  assert.deepEqual(t.store.state.mappings.sample_bank.fields.sample_customerid.targets, ["contact"]);
});

test("global option set: create, base-property update, use from an option action, and delete guarded by use", async () => {
  const t = await setup();
  const created = await metadata(t, "POST", `/api/data/${VERSION}/GlobalOptionSetDefinitions`, {
    "@odata.type": "#Microsoft.Dynamics.CRM.OptionSetMetadata",
    Name: "sample_colors",
    DisplayName: label("Colors"),
    OptionSetType: "Picklist",
    Options: [{ Label: label("Red"), Value: 727000000 }, { Label: label("Green") }],
  });
  assert.equal(created.status, 204);
  assert.equal(created.headers["OData-EntityId"], `${ORIGIN}/api/data/${VERSION}/GlobalOptionSetDefinitions(${uuidV5(ORG, "optionset:sample_colors")})`);
  const set = t.store.state.dataverse.globalOptionSets.sample_colors;
  assert.deepEqual(set.options.map((o) => o.value), [727000000, 727000001]); // unverified: the null value base

  await metadata(t, "PUT", `/api/data/${VERSION}/GlobalOptionSetDefinitions(Name='sample_colors')`, { DisplayName: label("Palette") }, { "MSCRM.MergeLabels": "true" });
  assert.equal(set.displayLabels[1033], "Palette");

  const insert = await action(t, "InsertOptionValue", { OptionSetName: "sample_colors", Label: label("Blue") });
  assert.equal(insert.status, 200);
  assert.equal(insert.body.NewOptionValue, 727000002);

  await assert.rejects(metadata(t, "DELETE", `/api/data/${VERSION}/GlobalOptionSetDefinitions(Name='sample_colors')`), failing(400));
  t.store.state.mappings.sample_bank.fields.sample_color.globalOptionSet = undefined;
  await metadata(t, "DELETE", `/api/data/${VERSION}/GlobalOptionSetDefinitions(Name='sample_colors')`);
  assert.equal(t.store.state.dataverse.globalOptionSets.sample_colors, undefined);
});

test("InsertOptionValue assigns a value to a local picklist, and UpdateOptionValue merges or replaces labels", async () => {
  const t = await setup();
  const insert = await action(t, "InsertOptionValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice", Label: label("Pending") });
  assert.equal(insert.status, 200);
  assert.equal(insert.body.NewOptionValue, 100000000); // unverified: the null value base
  assert.equal(insert.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#Microsoft.Dynamics.CRM.InsertOptionValueResponse`);

  await assert.rejects(action(t, "InsertOptionValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice", Value: 2, Label: label("Dup") }), failing(400));

  const options = t.store.state.mappings.sample_bank.fields.sample_choice.options;
  const merged = await action(t, "UpdateOptionValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice", Value: 1, Label: { LocalizedLabels: [{ Label: "Opened", LanguageCode: 1033 }] } }, { "MSCRM.MergeLabels": "true" });
  assert.equal(merged.status, 204);
  assert.deepEqual(options[0].labels, { 1033: "Opened", 1036: "Ouvert" });
  assert.equal(options[0].label, "Opened");

  await action(t, "UpdateOptionValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice", Value: 1, Label: { LocalizedLabels: [{ Label: "Only", LanguageCode: 1033 }] } });
  assert.deepEqual(options[0].labels, { 1033: "Only" });
});

test("DeleteOptionValue removes an option, OrderOption reorders, and both reject unknown values", async () => {
  const t = await setup();
  const addr = { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice" };
  await action(t, "InsertOptionValue", { ...addr, Value: 3, Label: label("Third") });
  await assert.rejects(action(t, "OrderOption", { ...addr, Values: [1, 2] }), failing(400));
  const order = await action(t, "OrderOption", { ...addr, Values: [3, 2, 1] });
  assert.equal(order.status, 204);
  assert.deepEqual(t.store.state.mappings.sample_bank.fields.sample_choice.options.map((o) => o.value), [3, 2, 1]);

  assert.equal((await action(t, "DeleteOptionValue", { ...addr, Value: 2 })).status, 204);
  assert.deepEqual(t.store.state.mappings.sample_bank.fields.sample_choice.options.map((o) => o.value), [3, 1]);
  await assert.rejects(action(t, "DeleteOptionValue", { ...addr, Value: 2 }), failing(404));
});

test("InsertStatusValue needs a StateCode; UpdateStateValue changes a state option's label and default status", async () => {
  const t = await setup();
  const addr = { EntityLogicalName: "sample_bank", AttributeLogicalName: "statuscode" };
  await assert.rejects(action(t, "InsertStatusValue", { ...addr, Label: label("Waiting") }), failing(400));
  const inserted = await action(t, "InsertStatusValue", { ...addr, Label: label("Waiting"), StateCode: 0 });
  assert.equal(inserted.status, 200);
  assert.equal(t.store.state.mappings.sample_bank.fields.statuscode.statuses.at(-1).state, 0);
  assert.equal(t.store.state.mappings.sample_bank.fields.statuscode.statuses.at(-1).value, inserted.body.NewOptionValue);

  const updated = await action(t, "UpdateStateValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "statecode", Value: 1, Label: label("Archived"), DefaultStatusCode: 2 });
  assert.equal(updated.status, 204);
  assert.equal(t.store.state.mappings.sample_bank.fields.statecode.states[1].label, "Archived");
  assert.equal(t.store.state.mappings.sample_bank.fields.statecode.states[1].defaultStatusCode, 2);
});

test("1:N and N:N associations work through the record handlers once the relationships exist", async () => {
  const t = await setup();
  const store = t.store;
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const records = createRecordHandlers({ store, change: (fn) => fn(), principals, metadataFields: () => undefined });
  const admin = principals.byObjectId(ADMIN_OID);
  const send = async (method, path, body) => {
    const url = new URL(path, ORIGIN);
    return records.handle({
      method, route: parseDataverseRoute(url.pathname), url, origin: ORIGIN, version: VERSION, prefer: parsePrefer(undefined),
      headers: {}, body, user: admin, caller: admin, identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid }, requestId: "test",
    });
  };

  await metadata(t, "POST", relationshipPath(), oneToMany());
  await metadata(t, "POST", relationshipPath(), manyToMany());
  const accountId = "11111111-0000-4000-8000-000000000001";
  const contactId = "22222222-0000-4000-8000-000000000002";
  store.state.tables.account.push({ accountid: accountId, name: "Acme" });
  store.state.tables.contact.push({ contactid: contactId, fullname: "Casey" });

  const created = await send("POST", `/api/data/${VERSION}/sample_banks`, { name: "Main", "sample_accountid@odata.bind": `/accounts(${accountId})` });
  assert.equal(created.status, 204);
  const bankId = /\(([^()]+)\)$/.exec(created.headers["OData-EntityId"])[1];

  const viaNav = await send("GET", `/api/data/${VERSION}/accounts(${accountId})/sample_bank_account`);
  assert.deepEqual(viaNav.body.value.map((row) => row.sample_bankid), [bankId]);

  const linked = await send("POST", `/api/data/${VERSION}/sample_banks(${bankId})/sample_bank_contact/$ref`, { "@odata.id": `${ORIGIN}/api/data/${VERSION}/contacts(${contactId})` });
  assert.equal(linked.status, 204);
  const contacts = await send("GET", `/api/data/${VERSION}/sample_banks(${bankId})/sample_bank_contact`);
  assert.deepEqual(contacts.body.value.map((row) => row.contactid), [contactId]);
});
