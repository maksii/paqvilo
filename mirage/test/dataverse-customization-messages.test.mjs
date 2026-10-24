// Customization messages: ribbons, forms, unpublished reads and themes, through the registered operations and SOAP dispatch.
// The systemform and theme mappings are the Dataverse standard names.
import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { DataStore, emptyState } from "../lib/data.mjs";
import { ensureSecurityModel, createPrincipals } from "../lib/dataverse-security.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { createChangeLog } from "../lib/dataverse-changes.mjs";
import { createOperationRegistry } from "../lib/dataverse-operations.mjs";
import { handleSoap } from "../lib/dataverse-soap.mjs";
import { NS } from "../lib/dataverse-soap-xml.mjs";
import { install } from "../lib/dataverse-customization-messages.mjs";
import { componentsOf } from "../lib/dataverse-solution-messages.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const BASIC_OID = "aaaaaaaa-0000-4000-8000-000000000002";
const FORM_MAIN = "bbbbbbbb-0000-4000-8000-000000000001";
const FORM_QUICK = "bbbbbbbb-0000-4000-8000-000000000002";
const THEME_OLD = "cccccccc-0000-4000-8000-000000000001";
const THEME_NEW = "cccccccc-0000-4000-8000-000000000002";
const UNKNOWN = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "dddddddd-0000-4000-8000-000000000001";
const CLOCK = Date.parse("2026-10-20T09:00:00Z");
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
  users: [
    { objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] },
    { objectId: BASIC_OID, upn: "basic@example.test", displayName: "Basic", roles: ["Basic User"] },
  ],
};

// Mappings and rows the operations read: a custom table, a form table and a theme table.
function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: "contoso_widget", entitySet: "contoso_widgets", idColumn: "contoso_widgetid", nameColumn: "contoso_name",
    fields: { contoso_name: { dataverseType: "nvarchar" } },
  };
  state.mappings.systemform = {
    logicalName: "systemform", entitySet: "systemforms", idColumn: "formid", nameColumn: "name",
    fields: {
      name: { dataverseType: "nvarchar" }, objecttypecode: { dataverseType: "nvarchar" }, type: { dataverseType: "int" },
      formid: { dataverseType: "uniqueidentifier" }, formxml: { dataverseType: "nvarchar" },
    },
  };
  state.mappings.theme = {
    logicalName: "theme", entitySet: "themes", idColumn: "themeid", nameColumn: "name",
    fields: { name: { dataverseType: "nvarchar" }, isdefaulttheme: { dataverseType: "bit" } },
  };
  state.tables.contoso_widget = [];
  state.tables.systemform = [
    { formid: FORM_MAIN, name: "Contoso main", objecttypecode: "contoso_widget", type: 2, formxml: "<form main />" },
    { formid: FORM_QUICK, name: "Contoso quick", objecttypecode: "contoso_widget", type: 4, formxml: "<form quick />" },
  ];
  state.mappings.mobileofflineprofile = {
    logicalName: "mobileofflineprofile", entitySet: "mobileofflineprofiles", idColumn: "mobileofflineprofileid", nameColumn: "name",
    fields: { name: { dataverseType: "nvarchar" } },
  };
  state.tables.mobileofflineprofile = [{ mobileofflineprofileid: PROFILE_ID, name: "Contoso offline" }];
  state.tables.theme = [
    { themeid: THEME_OLD, name: "Old", isdefaulttheme: true },
    { themeid: THEME_NEW, name: "New", isdefaulttheme: false },
  ];
  return state;
}

async function setup() {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const change = (fn) => fn();
  const records = createRecordHandlers({ store, change, principals, metadataFields: () => undefined, changes, clock: () => CLOCK });
  const api = {
    store, change, principals, records, changes, settings: SETTINGS, clock: () => CLOCK, log: () => {},
    metadata: null, metadataFields: () => undefined, registry: createOperationRegistry(),
  };
  install(api);
  const admin = principals.byObjectId(ADMIN_OID);
  const basic = principals.byObjectId(BASIC_OID);
  const find = (name, { kind = "function", binding = "unbound", entity } = {}) => api.registry.find({ name, kind, binding, entity });
  // A call as the router builds it: context with the caller, the URL, the parameters and the bound target.
  const call = (name, { user = admin, kind, binding, entity, params = {}, body = {}, target, query = "" } = {}) => {
    const op = find(name, { kind, binding, entity });
    assert.ok(op, `${name} is registered`);
    const url = new URL(`${ORIGIN}/api/data/v9.2/systemforms${query}`);
    return op.handle({ method: "POST", url, origin: ORIGIN, version: "v9.2", user, caller: user, identity: { admin: true, id: user.systemuserid }, params, body, target, requestId: "test" });
  };
  const send = (xml, { user = admin } = {}) => handleSoap({
    method: "POST", headers: {}, bodyText: xml, user, caller: user,
    identity: { admin: true, id: user.systemuserid, systemUserId: user.systemuserid },
    origin: ORIGIN, version: "v9.2", requestId: "test",
  }, api);
  const formsMapping = store.state.mappings.systemform, themeMapping = store.state.mappings.theme;
  return { store, api, admin, basic, find, call, send, formsMapping, themeMapping };
}

test("InstantiateFilters copies templates for the bound user, validates atomically, and checks create privilege", async () => {
  const t = await setup();
  const id = "bbbbbbbb-0000-4000-8000-000000000005";
  t.store.state.mappings.savedquery = { logicalName: "savedquery", entitySet: "savedqueries", idColumn: "savedqueryid", fields: {} };
  t.store.state.mappings.userquery = { logicalName: "userquery", entitySet: "userqueries", idColumn: "userqueryid", fields: {} };
  await ensureSecurityModel(t.store, SETTINGS);
  t.store.state.tables.savedquery = [{ savedqueryid: id, name: "Invented offline template", fetchxml: "<fetch><entity name='contoso_widget'/></fetch>", returnedtypecode: "contoso_widget", querytype: 16 }];
  const invoke = (body, user = t.admin) => t.call("InstantiateFilters", { kind: "action", binding: "entity", entity: "systemuser", user, target: { id: user.systemuserid }, body });
  await assert.rejects(invoke({ TemplateCollection: [{ savedqueryid: id }, { savedqueryid: UNKNOWN }] }), (error) => error.status === 404);
  assert.equal(t.store.state.tables.userquery?.length ?? 0, 0);
  assert.equal((await invoke({ TemplateCollection: [{ savedqueryid: id }] })).status, 204);
  const personal = t.store.state.tables.userquery[0];
  assert.equal(personal.fetchxml, t.store.state.tables.savedquery[0].fetchxml);
  assert.equal(personal.ownerid.id, t.admin.systemuserid);
  assert.equal(personal.querytype, 16);
  // Basic users normally own personal queries; remove the grant to prove the message uses the privilege check.
  const privileges = t.api.principals.privileges;
  t.api.principals.privileges = () => new Map();
  try {
    await assert.rejects(invoke({ TemplateCollection: [{ savedqueryid: id }] }), (error) => error.status === 403);
    assert.equal(t.store.state.tables.userquery.length, 1);
  } finally {
    t.api.principals.privileges = privileges;
  }
});

// The inner XML of a base64 zip that holds one entry (stored or deflated, as zipOf writes it).
function unzipOne(base64) {
  const buf = Buffer.from(base64, "base64");
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "a local file header");
  const method = buf.readUInt16LE(8), size = buf.readUInt32LE(18), nameLength = buf.readUInt16LE(26), extraLength = buf.readUInt16LE(28);
  const data = buf.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + size);
  return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
}

const EMPTY_RIBBON_MARKER = /<RibbonDiffXml>.*<CommandDefinitions \/>/;

test("RetrieveApplicationRibbon and RetrieveEntityRibbon return a zipped empty RibbonDiffXml", async () => {
  const t = await setup();
  const app = await t.call("RetrieveApplicationRibbon");
  assert.equal(app.status, 200);
  assert.match(app.body["@odata.context"], /RetrieveApplicationRibbonResponse$/);
  assert.match(unzipOne(app.body.CompressedApplicationRibbonXml), EMPTY_RIBBON_MARKER);
  const entity = await t.call("RetrieveEntityRibbon", { params: { EntityName: "contoso_widget", RibbonLocationFilter: "Microsoft.Dynamics.CRM.RibbonLocationFilters'All'" } });
  assert.equal(entity.status, 200);
  assert.match(unzipOne(entity.body.CompressedEntityXml), EMPTY_RIBBON_MARKER);
});

test("RetrieveEntityRibbon refuses a filter outside the enum and an unknown table", async () => {
  const t = await setup();
  await assert.rejects(t.call("RetrieveEntityRibbon", { params: { EntityName: "contoso_widget", RibbonLocationFilter: "9" } }), { status: 400, details: { innerCode: "0x80040203" } });
  await assert.rejects(t.call("RetrieveEntityRibbon", { params: { EntityName: "contoso_missing", RibbonLocationFilter: 7 } }), { status: 404 });
  await assert.rejects(t.call("RetrieveEntityRibbon", { params: { RibbonLocationFilter: 7 } }), { status: 400 });
});

test("the ribbon update messages answer 204 with no effect", async () => {
  const t = await setup();
  const params = { ComponentId: THEME_OLD, ComponentType: 80, SolutionUniqueName: "Contoso" };
  const before = structuredClone(t.store.state.tables);
  assert.equal((await t.call("UpdateRibbonClientMetadata", { kind: "action", params })).status, 204);
  assert.equal((await t.call("QueueUpdateRibbonClientMetadata", { kind: "action", params })).status, 204);
  assert.deepEqual(t.store.state.tables, before);
});

test("RetrieveFilteredForms returns the forms of one table and form type", async () => {
  const t = await setup();
  const res = await t.call("RetrieveFilteredForms", {
    binding: "collection", entity: "systemform", target: { mapping: t.formsMapping },
    params: { EntityLogicalName: "contoso_widget", FormType: 2, User: t.admin.systemuserid },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.value.map((f) => f.formid), [FORM_MAIN]);
});

test("RetrieveFilteredForms refuses a missing User and an unknown user", async () => {
  const t = await setup();
  const base = { binding: "collection", entity: "systemform", target: { mapping: t.formsMapping } };
  await assert.rejects(t.call("RetrieveFilteredForms", { ...base, params: { EntityLogicalName: "contoso_widget", FormType: 2 } }), { status: 400 });
  await assert.rejects(t.call("RetrieveFilteredForms", { ...base, params: { EntityLogicalName: "contoso_widget", FormType: 2, User: UNKNOWN } }), { status: 404 });
});

test("CopySystemForm creates a form from the source and writes into a named destination", async () => {
  const t = await setup();
  const target = { mapping: t.formsMapping, id: FORM_MAIN, row: t.store.state.tables.systemform[0] };
  const created = await t.call("CopySystemForm", { kind: "action", binding: "entity", entity: "systemform", target });
  assert.equal(created.status, 200);
  assert.equal(created.body.formxml, "<form main />");
  assert.equal(t.store.state.tables.systemform.length, 3);
  const copy = t.store.state.tables.systemform[2];
  assert.notEqual(copy.formid, FORM_MAIN);
  // The destination named in Target is overwritten and keeps its own id.
  await t.call("CopySystemForm", { kind: "action", binding: "entity", entity: "systemform", target, body: { Target: { formid: FORM_QUICK } } });
  const dest = t.store.state.tables.systemform.find((f) => f.formid === FORM_QUICK);
  assert.equal(dest.formxml, "<form main />");
  assert.equal(t.store.state.tables.systemform.length, 3);
});

test("CopySystemForm refuses an unknown destination and a caller without create privilege", async () => {
  const t = await setup();
  const target = { mapping: t.formsMapping, id: FORM_MAIN, row: t.store.state.tables.systemform[0] };
  await assert.rejects(t.call("CopySystemForm", { kind: "action", binding: "entity", entity: "systemform", target, body: { Target: { formid: UNKNOWN } } }), { status: 404 });
  await assert.rejects(t.call("CopySystemForm", { user: t.basic, kind: "action", binding: "entity", entity: "systemform", target }), { status: 403, code: "PrivilegeDenied" });
});

test("RetrieveUnpublished and RetrieveUnpublishedMultiple return the current rows", async () => {
  const t = await setup();
  const target = { mapping: t.formsMapping, id: FORM_QUICK, row: t.store.state.tables.systemform[1] };
  const one = await t.call("RetrieveUnpublished", { binding: "entity", entity: "systemform", target });
  assert.equal(one.status, 200);
  assert.equal(one.body.formid, FORM_QUICK);
  const many = await t.call("RetrieveUnpublishedMultiple", { binding: "collection", entity: "systemform", target: { mapping: t.formsMapping }, query: "?$select=name&$filter=type eq 4" });
  assert.deepEqual(many.body.value.map((f) => f.name), ["Contoso quick"]);
});

test("PublishTheme makes one theme the default and refuses a caller without write privilege", async () => {
  const t = await setup();
  const target = { mapping: t.themeMapping, id: THEME_NEW, row: t.store.state.tables.theme[1] };
  assert.equal((await t.call("PublishTheme", { kind: "action", binding: "entity", entity: "theme", target })).status, 204);
  const defaults = Object.fromEntries(t.store.state.tables.theme.map((th) => [th.themeid, th.isdefaulttheme]));
  assert.deepEqual(defaults, { [THEME_OLD]: false, [THEME_NEW]: true });
  await assert.rejects(t.call("PublishTheme", { user: t.basic, kind: "action", binding: "entity", entity: "theme", target }), { status: 403, code: "PrivilegeDenied" });
});

test("RetrieveEntityRibbon over SOAP goes through the generic OrganizationRequest dispatch", async () => {
  const t = await setup();
  const decl = Object.entries(NS).map(([p, uri]) => `xmlns:${p}="${uri}"`).join(" ");
  const value = (type, inner) => `<b:value i:type="${type}">${inner}</b:value>`;
  const pair = (key, valueXml) => `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${valueXml}</a:KeyValuePairOfstringanyType>`;
  const xml = `<s:Envelope ${decl}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:RetrieveEntityRibbonRequest"><a:Parameters>`
    + pair("EntityName", value("c:string", "contoso_widget")) + pair("RibbonLocationFilter", value("c:string", "All"))
    + `</a:Parameters><a:RequestName>RetrieveEntityRibbon</a:RequestName></request></Execute></s:Body></s:Envelope>`;
  const res = await t.send(xml);
  assert.equal(res.status, 200, res.body);
  const encoded = /<b:key>CompressedEntityXml<\/b:key><b:value[^>]*>([^<]+)</.exec(res.body)?.[1];
  assert.ok(encoded, "CompressedEntityXml is in the response");
  assert.match(unzipOne(encoded), EMPTY_RIBBON_MARKER);
});

test("UpdateRibbonClientMetadata is declared without parameters, as in the native metadata", async () => {
  const t = await setup();
  assert.match(t.find("UpdateRibbonClientMetadata", { kind: "action" }).csdl, /<Action Name="UpdateRibbonClientMetadata"\s*(?:\/>|>\s*<\/Action>)/);
});

test("ValidateUnpublished answers 204 for a profile, 404 for a missing one and 400 for another table", async () => {
  const t = await setup();
  const profile = { "@odata.type": "Microsoft.Dynamics.CRM.mobileofflineprofile", mobileofflineprofileid: PROFILE_ID };
  assert.equal((await t.call("ValidateUnpublished", { kind: "action", body: { Target: profile } })).status, 204);
  await assert.rejects(t.call("ValidateUnpublished", { kind: "action", body: { Target: { mobileofflineprofileid: UNKNOWN } } }), { status: 404 });
  await assert.rejects(t.call("ValidateUnpublished", { kind: "action", body: { Target: { "@odata.type": "Microsoft.Dynamics.CRM.systemform", formid: FORM_MAIN } } }), { status: 400 });
  await assert.rejects(t.call("ValidateUnpublished", { kind: "action", body: {} }), { status: 400 });
});

test("IsComponentCustomizable reports an invented column's IsCustomizable and 404s an unknown component", async () => {
  const t = await setup();
  t.store.state.mappings.contoso_widget.fields.contoso_name.columnMetadata = { isCustomizable: false };
  const component = componentsOf(t.store.state).find((x) => x.kind === "attribute" && x.logical === "contoso_widget" && x.name === "contoso_name");
  assert.ok(component, "the column is a solution component");
  const res = await t.call("IsComponentCustomizable", { params: { ComponentId: component.id, ComponentType: component.type } });
  assert.equal(res.status, 200);
  assert.equal(res.body.IsComponentCustomizable, false);
  await assert.rejects(t.call("IsComponentCustomizable", { params: { ComponentId: UNKNOWN, ComponentType: 2 } }), { status: 404 });
});

test("SubstituteForAttribute and SubstituteForComponent answer Success and require their parameters", async () => {
  const t = await setup();
  const attribute = await t.call("SubstituteForAttribute", { kind: "action", body: { AttributeName: "contoso_name", AttributeContent: "x", SubStore: "y" } });
  assert.deepEqual(attribute.body.Result, { Message: "", Status: "Success" });
  await assert.rejects(t.call("SubstituteForAttribute", { kind: "action", body: { AttributeName: "contoso_name", AttributeContent: "x" } }), { status: 400 });
  const component = await t.call("SubstituteForComponent", { kind: "action", body: { Entity: { "@odata.id": "x" }, SubStore: "y" } });
  assert.equal(component.body.Result.Status, "Success");
  await assert.rejects(t.call("SubstituteForComponent", { kind: "action", body: { SubStore: "y" } }), { status: 400 });
});
