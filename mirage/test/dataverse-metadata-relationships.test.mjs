// Metadata writes for relationships and choices. The store is seeded with ensureSecurityModel;
// the sample tables are created through the table writer, so their mappings are the runtime shapes. The association
// checks run through the record handlers. Handlers are called directly, not through the router.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { createMetadataService } from "../lib/dataverse-metadata.mjs";
import { metadataWriteOperations, metadataWriteRoutes } from "../lib/dataverse-metadata-relationships.mjs";
import { handleMetadataWrite } from "../lib/dataverse-metadata-tables.mjs";
import { parseDataverseRoute, parsePrefer } from "../lib/dataverse-odata.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { createPrincipals, ensureSecurityModel, seedTablePrivileges, uuidV5 } from "../lib/dataverse-security.mjs";

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
const text = { dataverseType: "nvarchar" };
const label = (value, code = 1033) => ({ LocalizedLabels: [{ Label: value, LanguageCode: code }], UserLocalizedLabel: { Label: value, LanguageCode: code } });
const column = (type, schema, extra = {}) => ({ "@odata.type": `#Microsoft.Dynamics.CRM.${type}AttributeMetadata`, SchemaName: schema, DisplayName: label(schema), ...extra });

// Solution tables stand in for account and contact: not dataverseOnly, so the Web API may not change them.
function fixtureState() {
  const state = emptyState();
  state.mappings.account = { logicalName: "account", entitySet: "accounts", idColumn: "accountid", nameColumn: "name", fields: { name: text }, relationships: {} };
  state.mappings.contact = { logicalName: "contact", entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname", fields: { fullname: text }, relationships: {} };
  for (const logical of Object.keys(state.mappings)) state.tables[logical] = [];
  return state;
}

async function setup() {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const api = { store, change: (fn) => fn(), settings: { organizationId: ORG }, principals, schema: null, addRoute() {} };
  const t = {
    api,
    store,
    routes: metadataWriteRoutes(api),
    ops: Object.fromEntries(metadataWriteOperations(api).map((op) => [op.name, op])),
    admin: principals.byObjectId(ADMIN_OID),
    clerk: principals.byObjectId(CLERK_OID),
  };
  // Choice first: the sample table binds to it.
  await metadata(t, "POST", `/api/data/${VERSION}/GlobalOptionSetDefinitions`, {
    "@odata.type": "#Microsoft.Dynamics.CRM.OptionSetMetadata",
    Name: "sample_colors",
    DisplayName: label("Colors"),
    OptionSetType: "Picklist",
    Options: [{ Label: label("Red"), Value: 727000000 }, { Label: label("Green") }],
  });
  await sampleTable(t, "sample_Bank", [
    column("Picklist", "sample_choice", { OptionSet: { Options: [
      { Value: 1, Label: { LocalizedLabels: [{ Label: "Open", LanguageCode: 1033 }, { Label: "Ouvert", LanguageCode: 1036 }] } },
      { Value: 2, Label: label("Closed") },
    ] } }),
    column("Picklist", "sample_color", { "GlobalOptionSet@odata.bind": "/GlobalOptionSetDefinitions(Name='sample_colors')" }),
  ]);
  // Status and state columns are seeded on solution tables; this table gets the same shape by hand.
  store.state.mappings.sample_bank.fields.statuscode = { dataverseType: "status", statuses: [{ value: 1, label: "Active", state: 0 }] };
  store.state.mappings.sample_bank.fields.statecode = { dataverseType: "state", states: [{ value: 0, label: "Active" }, { value: 1, label: "Inactive" }] };
  await sampleTable(t, "sample_Parent");
  await sampleTable(t, "sample_Other");
  return t;
}

// Creates a table through the table writer as the administrator, then gives it its standard privileges (as the server does).
async function sampleTable(t, schema, attributes = []) {
  const logical = schema.toLowerCase();
  const body = {
    "@odata.type": "#Microsoft.Dynamics.CRM.EntityMetadata",
    SchemaName: schema,
    DisplayName: label(schema),
    DisplayCollectionName: label(`${schema}s`),
    Description: label(schema),
    OwnershipType: "OrganizationOwned",
    IsActivity: false,
    HasActivities: false,
    HasNotes: false,
    Attributes: [column("String", `${schema.split("_")[0]}_Name`, { IsPrimaryName: true, MaxLength: 100 }), ...attributes],
  };
  const res = await handleMetadataWrite({
    api: t.api, method: "POST", url: new URL(`${ORIGIN}/api/data/${VERSION}/EntityDefinitions`), origin: ORIGIN, version: VERSION,
    route: parseDataverseRoute(`/api/data/${VERSION}/EntityDefinitions`), caller: t.admin, headers: {}, body, requestId: "test",
  });
  assert.equal(res.status, 204);
  await seedTablePrivileges(t.store, SETTINGS, logical);
  return logical;
}

// A request to a metadata route; the caller is the administrator unless given.
async function metadata(t, method, path, body, { headers = {}, caller = t.admin } = {}) {
  const url = new URL(path, ORIGIN);
  const hit = t.routes.find((route) => route.match(url.pathname, method));
  assert.ok(hit, `no route for ${method} ${path}`);
  return hit.handle({ method, url, origin: ORIGIN, version: VERSION, body, headers, caller });
}

async function action(t, name, body, { headers = {}, caller = t.admin } = {}) {
  return t.ops[name].handle({ method: "POST", url: new URL(`/api/data/${VERSION}/${name}`, ORIGIN), origin: ORIGIN, version: VERSION, body, headers, caller });
}

// Deletes a column or a table through the table writer, as the administrator.
async function removeThroughTables(t, method, path) {
  const url = new URL(path, ORIGIN);
  return handleMetadataWrite({ api: t.api, method, url, origin: ORIGIN, version: VERSION, route: parseDataverseRoute(url.pathname), caller: t.admin, headers: {}, requestId: "test" });
}

const relationshipPath = () => `/api/data/${VERSION}/RelationshipDefinitions`;
const globalPath = () => `/api/data/${VERSION}/GlobalOptionSetDefinitions`;
const relationshipId = (schema) => uuidV5(ORG, `relationship:${schema}`);
const readService = (t) => createMetadataService({ organizationId: ORG, schema: null, mappings: () => t.store.state.mappings });
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
const parentRelation = (overrides = {}) => oneToMany({
  SchemaName: "sample_bank_parent",
  ReferencedEntity: "sample_parent",
  ReferencedAttribute: "sample_parentid",
  Lookup: { SchemaName: "sample_ParentId", LogicalName: "sample_parentid", DisplayName: label("Parent") },
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
    schemaName: "sample_bank_account", cascade: { Assign: "NoCascade", Delete: "RemoveLink" }, isManaged: false, isCustomizable: true,
  });
  assert.deepEqual(mappings.sample_bank.relationships.sample_accountid, {
    entity: "account", from: "sample_accountid", to: "accountid", many: false, partner: "sample_bank_account",
    schemaName: "sample_bank_account", cascade: { Assign: "NoCascade", Delete: "RemoveLink" }, isManaged: false, isCustomizable: true,
  });
});

test("1:N navigation names come from the explicit properties when given", async () => {
  const t = await setup();
  await metadata(t, "POST", relationshipPath(), oneToMany({
    ReferencingEntityNavigationPropertyName: "bank_account",
    ReferencedEntityNavigationPropertyName: "bank_list",
  }));
  assert.equal(t.store.state.mappings.account.relationships.bank_list.entity, "sample_bank");
  assert.equal(t.store.state.mappings.account.relationships.sample_bank_account, undefined, "the default name is not used as well");
  assert.equal(t.store.state.mappings.sample_bank.relationships.bank_account.entity, "account");
});

test("1:N create rejects a duplicate name, an existing lookup, a second hierarchy and unknown tables", async () => {
  const t = await setup();
  await metadata(t, "POST", relationshipPath(), oneToMany());
  await assert.rejects(metadata(t, "POST", relationshipPath(), oneToMany()), failing(400));
  await assert.rejects(metadata(t, "POST", relationshipPath(), oneToMany({ SchemaName: "other_link", ReferencedEntity: "contact", ReferencedAttribute: "contactid" })), failing(400));
  await metadata(t, "POST", relationshipPath(), oneToMany({ SchemaName: "bank_parent_one", IsHierarchical: true, Lookup: { LogicalName: "sample_parentone" } }));
  await assert.rejects(metadata(t, "POST", relationshipPath(), oneToMany({ SchemaName: "bank_parent_two", IsHierarchical: true, Lookup: { LogicalName: "sample_parenttwo" } })), failing(400));
  await assert.rejects(metadata(t, "POST", relationshipPath(), oneToMany({ SchemaName: "x_y", ReferencedEntity: "missing", Lookup: { LogicalName: "sample_missing" } })), failing(404));
  // a rejected write leaves nothing behind
  assert.equal(t.store.state.mappings.sample_bank.fields.sample_parenttwo, undefined);
  assert.equal(t.store.state.mappings.account.relationships.bank_parent_two, undefined);
});

test("a lookup from a solution table cannot be created: the referencing table must be one this API created", async () => {
  const t = await setup();
  await assert.rejects(metadata(t, "POST", relationshipPath(), oneToMany({ SchemaName: "contact_bank", ReferencedEntity: "sample_parent", ReferencedAttribute: "sample_parentid", ReferencingEntity: "contact", Lookup: { LogicalName: "contact_bankref" } })), failing(400));
  assert.equal(t.store.state.mappings.contact.fields.contact_bankref, undefined);
});

test("N:N create adds an intersect mapping and a navigation entry on each side", async () => {
  const t = await setup();
  const res = await metadata(t, "POST", relationshipPath(), manyToMany());
  assert.equal(res.status, 204);
  const { mappings } = t.store.state;
  assert.deepEqual(mappings.sample_bank_contact_link, {
    logicalName: "sample_bank_contact_link", entitySet: "sample_bank_contact_links", idColumn: "sample_bank_contact_linkid",
    userConfigured: true, dataverseOnly: true, dataverseMetadata: { createdByMetadataApi: true },
    fields: { sample_bankid: { dataverseType: "lookup", targets: ["sample_bank"] }, contactid: { dataverseType: "lookup", targets: ["contact"] } },
    relationships: {},
  });
  assert.equal(mappings.sample_bank.relationships.sample_bank_contact.intersect.entity, "sample_bank_contact_link");
  assert.equal(mappings.contact.relationships.sample_bank_contact.partner, "sample_bank_contact");
  assert.ok(Array.isArray(t.store.state.tables.sample_bank_contact_link));
});

test("self-referencing N:N needs distinct intersect columns and navigation names, then creates and deletes", async () => {
  const t = await setup();
  const self = (overrides = {}) => manyToMany({
    SchemaName: "sample_bank_related", Entity1LogicalName: "sample_bank", Entity2LogicalName: "sample_bank",
    IntersectEntityName: "sample_bank_related_link", Entity1IntersectAttribute: "sample_leftbankid", Entity2IntersectAttribute: "sample_rightbankid",
    Entity1NavigationPropertyName: "sample_left", Entity2NavigationPropertyName: "sample_right", ...overrides,
  });
  await assert.rejects(metadata(t, "POST", relationshipPath(), self({ Entity2IntersectAttribute: "sample_leftbankid" })), failing(400));
  await assert.rejects(metadata(t, "POST", relationshipPath(), self({ Entity2NavigationPropertyName: "sample_left" })), failing(400));
  assert.equal(t.store.state.mappings.sample_bank_related_link, undefined);
  assert.equal((await metadata(t, "POST", relationshipPath(), self())).status, 204);
  const { mappings } = t.store.state;
  assert.deepEqual(Object.keys(mappings.sample_bank_related_link.fields).sort(), ["sample_leftbankid", "sample_rightbankid"]);
  assert.equal(mappings.sample_bank.relationships.sample_left.partner, "sample_right");
  assert.equal(mappings.sample_bank.relationships.sample_right.partner, "sample_left");
  await metadata(t, "DELETE", `${relationshipPath()}(${relationshipId("sample_bank_related")})`);
  assert.equal(mappings.sample_bank_related_link, undefined);
  assert.equal(mappings.sample_bank.relationships.sample_left, undefined);
});

test("PUT changes cascade, DELETE of a 1:N removes its lookup, DELETE of N:N removes the intersect table", async () => {
  const t = await setup();
  await metadata(t, "POST", relationshipPath(), parentRelation());
  await metadata(t, "PUT", `${relationshipPath()}(${relationshipId("sample_bank_parent")})`, { CascadeConfiguration: { Delete: "Cascade" } }, { headers: MERGE });
  assert.equal(t.store.state.mappings.sample_parent.relationships.sample_bank_parent.cascade.Delete, "Cascade");

  await metadata(t, "DELETE", `${relationshipPath()}(${relationshipId("sample_bank_parent")})`);
  assert.equal(t.store.state.mappings.sample_parent.relationships.sample_bank_parent, undefined);
  assert.equal(t.store.state.mappings.sample_bank.fields.sample_parentid, undefined);

  await metadata(t, "POST", relationshipPath(), manyToMany({ Entity2LogicalName: "sample_other", IntersectEntityName: "sample_bank_other_link", SchemaName: "sample_bank_other" }));
  await metadata(t, "DELETE", `${relationshipPath()}(${relationshipId("sample_bank_other")})`);
  assert.equal(t.store.state.mappings.sample_bank_other_link, undefined);
  assert.equal(t.store.state.mappings.sample_other.relationships.sample_bank_other, undefined);
});

test("a custom 1:N to a solution table (account) can be updated and deleted: the origin is the metadata API, not the referenced table", async () => {
  const t = await setup();
  await metadata(t, "POST", relationshipPath(), oneToMany());
  const path = `${relationshipPath()}(${relationshipId("sample_bank_account")})`;
  await metadata(t, "PUT", path, { DisplayName: label("Bank account"), CascadeConfiguration: { Assign: "Cascade", Delete: "Cascade" } }, { headers: MERGE });
  const { mappings } = t.store.state;
  assert.equal(mappings.account.relationships.sample_bank_account.displayLabels[1033], "Bank account");
  assert.equal(mappings.sample_bank.relationships.sample_accountid.cascade.Assign, "Cascade");

  assert.equal((await metadata(t, "DELETE", path)).status, 204);
  assert.equal(mappings.account.relationships.sample_bank_account, undefined);
  assert.equal(mappings.sample_bank.fields.sample_accountid, undefined);
});

test("a solution relationship (seeded, no metadata-API origin) cannot be changed or deleted, and keeps its lookup", async () => {
  const t = await setup();
  const { mappings } = t.store.state;
  // Seeded shape on a custom table and a solution table: no isManaged / isCustomizable markers.
  mappings.sample_bank.fields.sample_solutionid = { dataverseType: "lookup", targets: ["account"] };
  mappings.sample_bank.relationships.sample_solutionid = { entity: "account", from: "sample_solutionid", to: "accountid", many: false, partner: "sample_bank_solution", schemaName: "sample_bank_solution" };
  mappings.account.relationships.sample_bank_solution = { entity: "sample_bank", from: "accountid", to: "sample_solutionid", many: true, partner: "sample_solutionid", schemaName: "sample_bank_solution" };
  const path = `${relationshipPath()}(${relationshipId("sample_bank_solution")})`;
  await assert.rejects(metadata(t, "DELETE", path), failing(400));
  await assert.rejects(metadata(t, "PUT", path, { CascadeConfiguration: { Delete: "Cascade" } }), failing(400));
  assert.ok(mappings.sample_bank.fields.sample_solutionid);
  assert.ok(mappings.account.relationships.sample_bank_solution);
  assert.equal(mappings.sample_bank.relationships.sample_solutionid.cascade, undefined);
});

test("deleting a table cascades its relationships on both sides", async () => {
  const t = await setup();
  await sampleTable(t, "sample_Gone");
  await metadata(t, "POST", relationshipPath(), parentRelation({ ReferencedEntity: "sample_gone", ReferencedAttribute: "sample_goneid", SchemaName: "sample_bank_gone", Lookup: { LogicalName: "sample_goneid" } }));
  await metadata(t, "POST", relationshipPath(), manyToMany({ Entity2LogicalName: "sample_gone", IntersectEntityName: "sample_bank_gone_link", SchemaName: "sample_bank_gone_nn" }));
  const gonePath = `/api/data/${VERSION}/EntityDefinitions(LogicalName='sample_gone')`;
  assert.equal((await removeThroughTables(t, "DELETE", gonePath)).status, 204);
  const { mappings } = t.store.state;
  assert.equal(mappings.sample_gone, undefined);
  assert.equal(mappings.sample_bank.fields.sample_goneid, undefined);
  assert.equal(mappings.sample_bank.relationships.sample_goneid, undefined);
  assert.equal(mappings.sample_bank.relationships.sample_bank_gone_nn, undefined);
  assert.equal(mappings.sample_bank_gone_link, undefined);
});

test("CreateCustomerRelationships writes one customer column with two relationships and returns their ids", async () => {
  const t = await setup();
  const res = await action(t, "CreateCustomerRelationships", {
    Lookup: { SchemaName: "sample_CustomerId", LogicalName: "sample_customerid", DisplayName: label("Customer") },
    OneToManyRelationships: [
      { SchemaName: "sample_bank_customer_parent", ReferencedEntity: "sample_parent", ReferencedAttribute: "sample_parentid", ReferencingEntity: "sample_bank" },
      { SchemaName: "sample_bank_customer_other", ReferencedEntity: "sample_other", ReferencedAttribute: "sample_otherid", ReferencingEntity: "sample_bank" },
    ],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.RelationshipIds, [relationshipId("sample_bank_customer_parent"), relationshipId("sample_bank_customer_other")]);
  assert.equal(res.body.AttributeId, uuidV5(ORG, "attribute:sample_bank:sample_customerid"));
  const field = t.store.state.mappings.sample_bank.fields.sample_customerid;
  assert.equal(field.dataverseType, "customer");
  assert.deepEqual(field.targets, ["sample_parent", "sample_other"]);
  assert.equal(t.store.state.mappings.sample_bank.relationships.sample_customerid_sample_parent.entity, "sample_parent");
  assert.equal(t.store.state.mappings.sample_bank.relationships.sample_customerid_sample_other.entity, "sample_other");

  // deleting one relationship keeps the column for the other target
  await metadata(t, "DELETE", `${relationshipPath()}(${relationshipId("sample_bank_customer_parent")})`);
  assert.ok(t.store.state.mappings.sample_bank.fields.sample_customerid);
  assert.deepEqual(t.store.state.mappings.sample_bank.fields.sample_customerid.targets, ["sample_other"]);
  await assert.rejects(action(t, "CreateCustomerRelationships", { Lookup: { LogicalName: "sample_one" }, OneToManyRelationships: [{ SchemaName: "sample_one_rel", ReferencedEntity: "sample_other", ReferencingEntity: "sample_bank" }] }), failing(400));
});

test("CreatePolymorphicLookupAttribute creates one lookup with a target per relationship", async () => {
  const t = await setup();
  const rel = (schema, referenced, attribute) => ({ SchemaName: schema, ReferencedEntity: referenced, ReferencedAttribute: attribute, ReferencingEntity: "sample_bank" });
  const res = await action(t, "CreatePolymorphicLookupAttribute", {
    Lookup: { SchemaName: "sample_RecordRef", DisplayName: label("Record") },
    OneToManyRelationships: [rel("sample_bank_ref_parent", "sample_parent", "sample_parentid"), rel("sample_bank_ref_other", "sample_other", "sample_otherid"), rel("sample_bank_ref_account", "account", "accountid")],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#Microsoft.Dynamics.CRM.CreatePolymorphicLookupAttributeResponse`);
  assert.equal(res.body.RelationshipIds.length, 3);
  assert.deepEqual(t.store.state.mappings.sample_bank.fields.sample_recordref.targets, ["sample_parent", "sample_other", "account"]);
  await assert.rejects(action(t, "CreatePolymorphicLookupAttribute", { Lookup: { SchemaName: "sample_Dup" }, OneToManyRelationships: [rel("sample_dup_a", "sample_parent", "sample_parentid"), rel("sample_dup_b", "sample_parent", "sample_parentid")] }), failing(400));
  assert.equal(t.store.state.mappings.sample_bank.fields.sample_dup, undefined);
});

test("1:N and N:N associations work through the record handlers once the relationships exist", async () => {
  const t = await setup();
  const store = t.store;
  const records = createRecordHandlers({ store, change: (fn) => fn(), principals: t.api.principals, metadataFields: () => undefined });
  const send = async (method, path, body) => {
    const url = new URL(path, ORIGIN);
    return records.handle({
      method, route: parseDataverseRoute(url.pathname), url, origin: ORIGIN, version: VERSION, prefer: parsePrefer(undefined),
      headers: {}, body, user: t.admin, caller: t.admin, identity: { admin: true, id: t.admin.systemuserid, systemUserId: t.admin.systemuserid }, requestId: "test",
    });
  };

  await metadata(t, "POST", relationshipPath(), oneToMany());
  await metadata(t, "POST", relationshipPath(), manyToMany());
  const accountId = "11111111-0000-4000-8000-000000000001";
  const contactId = "22222222-0000-4000-8000-000000000002";
  store.state.tables.account.push({ accountid: accountId, name: "Acme" });
  store.state.tables.contact.push({ contactid: contactId, fullname: "Casey" });

  const created = await send("POST", `/api/data/${VERSION}/sample_banks`, { sample_name: "Main", "sample_accountid@odata.bind": `/accounts(${accountId})` });
  assert.equal(created.status, 204);
  const bankId = /\(([^()]+)\)$/.exec(created.headers["OData-EntityId"])[1];

  const viaNav = await send("GET", `/api/data/${VERSION}/accounts(${accountId})/sample_bank_account`);
  assert.deepEqual(viaNav.body.value.map((row) => row.sample_bankid), [bankId]);

  const linked = await send("POST", `/api/data/${VERSION}/sample_banks(${bankId})/sample_bank_contact/$ref`, { "@odata.id": `${ORIGIN}/api/data/${VERSION}/contacts(${contactId})` });
  assert.equal(linked.status, 204);
  const contacts = await send("GET", `/api/data/${VERSION}/sample_banks(${bankId})/sample_bank_contact`);
  assert.deepEqual(contacts.body.value.map((row) => row.contactid), [contactId]);
});

test("a relationship read by its MetadataId resolves even without a stored SchemaName; the guard then refuses an unflagged intersect", async () => {
  const t = await setup();
  const { mappings } = t.store.state;
  // A seeded N:N shape: no schemaName on the entries, the intersect named by the default, and no createdByMetadataApi flag.
  mappings.sample_bank.relationships.sample_extra = { entity: "sample_other", from: "sample_bankid", to: "sample_otherid", many: true, partner: "sample_extra_back", intersect: { entity: "sample_extra_link", from: "sample_bankid", to: "sample_otherid" } };
  mappings.sample_other.relationships.sample_extra_back = { entity: "sample_bank", from: "sample_otherid", to: "sample_bankid", many: true, partner: "sample_extra", intersect: { entity: "sample_extra_link", from: "sample_otherid", to: "sample_bankid" } };
  mappings.sample_extra_link = { logicalName: "sample_extra_link", entitySet: "sample_extra_links", idColumn: "sample_extra_linkid", dataverseOnly: true, fields: { sample_bankid: { dataverseType: "lookup", targets: ["sample_bank"] }, sample_otherid: { dataverseType: "lookup", targets: ["sample_other"] } }, relationships: {} };
  t.store.state.tables.sample_extra_link = [];
  const id = readService(t).metadataId("relationship", "sample_extra_link");
  await assert.rejects(metadata(t, "DELETE", `${relationshipPath()}(${id})`), failing(400));
  await assert.rejects(metadata(t, "DELETE", `${relationshipPath()}(${uuidV5(ORG, "relationship:nothing_here")})`), failing(404));
  assert.ok(mappings.sample_extra_link, "the refused delete left the intersect in place");
});

test("global option set: create, base-property update, use from an option action, and delete guarded by use", async () => {
  const t = await setup();
  const set = t.store.state.dataverse.globalOptionSets.sample_colors;
  assert.deepEqual(set.options.map((o) => o.value), [727000000, 727000001]); // the value base is a guess
  assert.equal(set.options[0].label, "Red");

  await metadata(t, "PUT", `${globalPath()}(Name='sample_colors')`, { DisplayName: label("Palette") }, { headers: MERGE });
  assert.equal(set.displayLabels[1033], "Palette");

  const insert = await action(t, "InsertOptionValue", { OptionSetName: "sample_colors", Label: label("Blue") });
  assert.equal(insert.status, 200);
  assert.equal(insert.body.NewOptionValue, 727000002);

  // sample_bank.sample_color is bound to the set: the set cannot go while the column is bound
  await assert.rejects(metadata(t, "DELETE", `${globalPath()}(Name='sample_colors')`), failing(400));
  const colorId = readService(t).metadataId("attribute", "sample_bank", "sample_color");
  assert.equal((await removeThroughTables(t, "DELETE", `/api/data/${VERSION}/EntityDefinitions(LogicalName='sample_bank')/Attributes(${colorId})`)).status, 204);
  await metadata(t, "DELETE", `${globalPath()}(Name='sample_colors')`);
  assert.equal(t.store.state.dataverse.globalOptionSets.sample_colors, undefined);
});

test("a global set create that fails leaves no trace, and a successful create advances the store revision", async () => {
  const t = await setup();
  const before = t.store.revision;
  await assert.rejects(metadata(t, "POST", globalPath(), {
    Name: "sample_sizes", DisplayName: label("Sizes"), Options: [{ Label: label("S"), Value: 5 }, { Label: label("M"), Value: 5 }],
  }), failing(400));
  assert.equal(t.store.state.dataverse.globalOptionSets.sample_sizes, undefined);
  assert.equal(t.store.revision, before);
  await metadata(t, "POST", globalPath(), { Name: "sample_sizes", DisplayName: label("Sizes"), Options: [{ Label: label("S") }] });
  assert.ok(t.store.revision > before);
});

test("InsertOptionValue assigns a value to a local picklist, and UpdateOptionValue merges or replaces labels", async () => {
  const t = await setup();
  const insert = await action(t, "InsertOptionValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice", Label: label("Pending") });
  assert.equal(insert.status, 200);
  assert.equal(insert.body.NewOptionValue, 100000000); // the value base is a guess
  assert.equal(insert.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#Microsoft.Dynamics.CRM.InsertOptionValueResponse`);

  await assert.rejects(action(t, "InsertOptionValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice", Value: 2, Label: label("Dup") }), failing(400));

  const options = t.store.state.mappings.sample_bank.fields.sample_choice.columnMetadata.optionSet.options;
  const merged = await action(t, "UpdateOptionValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice", Value: 1, Label: { LocalizedLabels: [{ Label: "Opened", LanguageCode: 1033 }] } }, { headers: MERGE });
  assert.equal(merged.status, 204);
  assert.deepEqual(options[0].labels, { 1033: "Opened", 1036: "Ouvert" });
  assert.equal(options[0].label, "Opened");

  await action(t, "UpdateOptionValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice", Value: 1, Label: { LocalizedLabels: [{ Label: "Only", LanguageCode: 1033 }] } });
  assert.deepEqual(options[0].labels, { 1033: "Only" });
});

test("DeleteOptionValue removes an unused option, refuses one that rows store, OrderOption reorders, and both reject unknown values", async () => {
  const t = await setup();
  const addr = { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice" };
  await action(t, "InsertOptionValue", { ...addr, Value: 3, Label: label("Third") });
  await assert.rejects(action(t, "OrderOption", { ...addr, Values: [1, 2] }), failing(400));
  const order = await action(t, "OrderOption", { ...addr, Values: [3, 2, 1] });
  assert.equal(order.status, 204);
  const options = () => t.store.state.mappings.sample_bank.fields.sample_choice.columnMetadata.optionSet.options;
  assert.deepEqual(options().map((o) => o.value), [3, 2, 1]);

  t.store.state.tables.sample_bank.push({ sample_bankid: "row-1", sample_name: "Main", sample_choice: "2" });
  await assert.rejects(action(t, "DeleteOptionValue", { ...addr, Value: 2 }), failing(400));
  assert.deepEqual(options().map((o) => o.value), [3, 2, 1]);
  assert.equal((await action(t, "DeleteOptionValue", { ...addr, Value: 3 })).status, 204);
  assert.deepEqual(options().map((o) => o.value), [2, 1]);
  await assert.rejects(action(t, "DeleteOptionValue", { ...addr, Value: 3 }), failing(404));
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

test("relationship and choice writes need the customizer privileges: a basic user is refused and nothing changes", async () => {
  const t = await setup();
  const before = JSON.stringify(t.store.state.mappings);
  await assert.rejects(metadata(t, "POST", relationshipPath(), oneToMany(), { caller: t.clerk }), (e) => e.status === 403 && e.details.innerCode === "0x80040220");
  await assert.rejects(metadata(t, "POST", globalPath(), { Name: "sample_nope", Options: [] }, { caller: t.clerk }), failing(403));
  await assert.rejects(action(t, "InsertOptionValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice", Label: label("Nope") }, { caller: t.clerk }), failing(403));
  assert.equal(JSON.stringify(t.store.state.mappings), before);
});

test("metadata log: relationship, optionset and option-value writes each append their entries, with consecutive seq", async () => {
  const t = await setup();
  const log = () => t.store.state.dataverse.metadataLog;
  const tail = (n) => log().slice(-n).map(({ op, kind, logical, name }) => ({ op, kind, logical, name }));

  await metadata(t, "POST", relationshipPath(), oneToMany());
  assert.deepEqual(tail(2), [
    { op: "add", kind: "attribute", logical: "sample_bank", name: "sample_accountid" },
    { op: "add", kind: "relationship", logical: "sample_bank", name: "sample_bank_account" },
  ]);
  await metadata(t, "POST", relationshipPath(), parentRelation());
  await metadata(t, "PUT", `${relationshipPath()}(${relationshipId("sample_bank_parent")})`, { CascadeConfiguration: { Delete: "Cascade" } }, { headers: MERGE });
  assert.deepEqual(tail(1), [{ op: "change", kind: "relationship", logical: "sample_bank", name: "sample_bank_parent" }]);
  await metadata(t, "DELETE", `${relationshipPath()}(${relationshipId("sample_bank_parent")})`);
  assert.deepEqual(tail(2), [
    { op: "delete", kind: "relationship", logical: "sample_bank", name: "sample_bank_parent" },
    { op: "delete", kind: "attribute", logical: "sample_bank", name: "sample_parentid" },
  ]);

  await metadata(t, "POST", globalPath(), { Name: "sample_sizes", DisplayName: label("Sizes"), Options: [] });
  assert.deepEqual(tail(1), [{ op: "add", kind: "optionset", logical: "sample_sizes", name: null }]);
  await metadata(t, "PUT", `${globalPath()}(Name='sample_sizes')`, { DisplayName: label("Sizes 2") }, { headers: MERGE });
  assert.deepEqual(tail(1), [{ op: "change", kind: "optionset", logical: "sample_sizes", name: null }]);
  await metadata(t, "DELETE", `${globalPath()}(Name='sample_sizes')`);
  assert.deepEqual(tail(1), [{ op: "delete", kind: "optionset", logical: "sample_sizes", name: null }]);

  await action(t, "InsertOptionValue", { OptionSetName: "sample_colors", Label: label("Blue") });
  assert.deepEqual(tail(1), [{ op: "change", kind: "optionset", logical: "sample_colors", name: null }]);
  await action(t, "InsertOptionValue", { EntityLogicalName: "sample_bank", AttributeLogicalName: "sample_choice", Label: label("Pending") });
  assert.deepEqual(tail(1), [{ op: "change", kind: "attribute", logical: "sample_bank", name: "sample_choice" }]);

  const entries = log();
  assert.ok(entries.every((e, i) => i === 0 || e.seq === entries[i - 1].seq + 1), "seq counts up by one");
  assert.ok(entries.every((e) => typeof e.at === "string" && !Number.isNaN(Date.parse(e.at))), "at is an ISO time");
});
