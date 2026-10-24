// Simulated Dataverse organization, environment variable, license and deployment messages: happy paths, the documented refusals,
// a privilege denial on a write and one SOAP call through the generic OrganizationRequest.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { seed as seedStandard } from "../lib/dataverse-standard.mjs";
import { ensureSecurityModel, createPrincipals } from "../lib/dataverse-security.mjs";
import { createOperationRegistry } from "../lib/dataverse-operations.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { createChangeLog } from "../lib/dataverse-changes.mjs";
import { handleSoap } from "../lib/dataverse-soap.mjs";
import { NS } from "../lib/dataverse-soap-xml.mjs";
import { runAtomic } from "../lib/dataverse-api.mjs";
import { install } from "../lib/dataverse-org-messages.mjs";
import { addonHandlers } from "../lib/dataverse-addon-common.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const BASIC_OID = "aaaaaaaa-0000-4000-8000-000000000002";
const NOROLE_OID = "aaaaaaaa-0000-4000-8000-000000000003";
const UNKNOWN = "11111111-1111-4111-8111-111111111111";
const SOLUTION = "22222222-2222-4222-8222-222222222222";
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
    { objectId: NOROLE_OID, upn: "norole@example.test", displayName: "No Role", roles: [] },
  ],
};

// The standard catalogue supplies the organization, solution, workflow, systemuser and environment variable tables.
async function setup() {
  const store = new DataStore({ state: emptyState() });
  await store.transact(() => seedStandard(store));
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const records = createRecordHandlers({ store, change: (fn) => fn(), principals, metadataFields: () => undefined, changes });
  const api = {
    store, change: (fn) => fn(), registry: createOperationRegistry(), principals, metadata: null, metadataFields: () => undefined,
    records, changes, settings: SETTINGS, clock: () => CLOCK, log: () => {},
  };
  api.runAtomic = (fn) => runAtomic(api, fn);
  install(api);
  return {
    store, api, principals,
    admin: principals.byObjectId(ADMIN_OID), basic: principals.byObjectId(BASIC_OID), norole: principals.byObjectId(NOROLE_OID),
  };
}

// Calls a registered operation the way the router does: parameters for functions, the body for actions, the target when bound.
// Async, so a refusal the handler throws synchronously arrives as a rejection, as it does through the router.
async function invoke(api, name, { kind = "function", binding = "unbound", entity, user, target, params, body } = {}) {
  const op = api.registry.find({ name, kind, binding, entity });
  assert.ok(op, `${name} is registered`);
  return op.handle({
    user, caller: null, target, params, body, identity: { admin: true },
    origin: ORIGIN, version: "v9.2", url: new URL(`${ORIGIN}/api/data/v9.2/${name}`),
  });
}
const action = (api, name, args) => invoke(api, name, { kind: "action", ...args });

const denied = (promise) => assert.rejects(promise, (e) => e.status === 403 && e.code === "PrivilegeDenied" && e.details?.innerCode === "0x80040220");
const refused = (e) => e.status === 400 && e.details?.innerCode === "0x80040203";
const notFound = (e) => e.status === 404;

// Upserts an environment variable definition (and its value when given) as the administrator.
const upsert = (t, body) => action(t.api, "UpsertEnvironmentVariable", { user: t.admin, body });
const valueOf = (t, schemaName) => invoke(t.api, "RetrieveEnvironmentVariableValue", { user: t.admin, params: { DefinitionSchemaName: schemaName } });

test("RetrieveOrganizationInfo lists the solution rows of the organization", async () => {
  const t = await setup();
  await t.store.transact(() => {
    t.store.state.tables.solution.push({ solutionid: SOLUTION, uniquename: "contosoBase", friendlyname: "Contoso Base", version: "1.0.0.0" });
  });
  const res = await invoke(t.api, "RetrieveOrganizationInfo", { user: t.admin });
  assert.equal(res.status, 200);
  assert.match(res.body["@odata.context"], /RetrieveOrganizationInfoResponse$/);
  assert.equal(res.body.organizationInfo.InstanceType, 13); // not observed natively: a guess
  assert.deepEqual(res.body.organizationInfo.Solutions.map((s) => [s.SolutionUniqueName, s.VersionNumber]), [["contosoBase", "1.0.0.0"]]);
});

test("RetrieveOrganizationResources counts the interactive and non-interactive users and the published workflows", async () => {
  const t = await setup();
  await t.store.transact(() => {
    const workflows = t.store.state.tables.workflow ??= [];
    workflows.push({ workflowid: "33333333-3333-4333-8333-333333333331", statecode: 1 }, { workflowid: "33333333-3333-4333-8333-333333333332", statecode: 1 });
    workflows.push({ workflowid: "33333333-3333-4333-8333-333333333333", statecode: 0 });
  });
  const before = (await invoke(t.api, "RetrieveOrganizationResources", { user: t.admin })).body.OrganizationResources.CurrentNumberOfCustomEntities;
  await t.store.transact(() => {
    t.store.state.mappings.contoso_widget = { logicalName: "contoso_widget", entitySet: "contoso_widgets", idColumn: "contoso_widgetid", fields: {} };
    t.store.state.tables.contoso_widget = [];
  });
  const res = await invoke(t.api, "RetrieveOrganizationResources", { user: t.admin });
  const r = res.body.OrganizationResources;
  assert.equal(r.CurrentNumberOfActiveUsers, 3, "the three seeded interactive users");
  assert.equal(r.CurrentNumberOfNonInteractiveUsers, 1, "the SYSTEM user");
  assert.equal(r.CurrentNumberOfPublishedWorkflows, 2, "the two activated workflows");
  assert.equal(r.CurrentNumberOfCustomEntities, before + 1, "one custom table added");
});

test("IsDataEncryptionActive reports encryption active, as new organizations use it by default", async () => {
  const t = await setup();
  const res = await invoke(t.api, "IsDataEncryptionActive", { user: t.admin });
  assert.equal(res.status, 200);
  assert.equal(res.body.IsActive, true);
});

test("ResetUserFilters accepts an integer QueryType and refuses one that is not", async () => {
  const t = await setup();
  assert.equal((await action(t.api, "ResetUserFilters", { user: t.basic, body: { QueryType: 0 } })).status, 204);
  await assert.rejects(action(t.api, "ResetUserFilters", { user: t.basic, body: { QueryType: "filters" } }), refused);
});

test("RetrieveEnvironmentVariableValue reads the value row, else the default, and matches the schema name without case", async () => {
  const t = await setup();
  await upsert(t, { SchemaName: "new_Greeting", Type: 100000000, DefaultValue: "hello" });
  assert.equal((await valueOf(t, "NEW_GREETING")).body.Value, "hello", "the default until a value is set");
  await upsert(t, { SchemaName: "new_Greeting", Type: 100000000, Value: "hi" });
  assert.equal((await valueOf(t, "new_greeting")).body.Value, "hi", "the value row wins over the default");
  await assert.rejects(valueOf(t, "new_Missing"), notFound);
});

test("RetrieveEnvironmentVariables returns the definitions with their current values, filtered by SchemaNames", async () => {
  const t = await setup();
  await upsert(t, { SchemaName: "new_Alpha", Type: 100000000, Value: "a" });
  await upsert(t, { SchemaName: "new_Beta", Type: 100000001, Value: "2" });
  const all = await invoke(t.api, "RetrieveEnvironmentVariables", { user: t.admin });
  assert.equal(all.body.value.length, 2);
  const one = await invoke(t.api, "RetrieveEnvironmentVariables", { user: t.admin, params: { SchemaNames: ["new_Beta"] } });
  assert.deepEqual(one.body.value.map((row) => [row.schemaname, row.value]), [["new_Beta", "2"]]);
});

test("UpsertEnvironmentVariable creates the definition and its value once, updates them in place, and refuses a bad type or secret store", async () => {
  const t = await setup();
  assert.equal((await upsert(t, { SchemaName: "new_Count", Type: 100000001, DisplayName: "Count", Value: "1" })).status, 204);
  assert.equal((await upsert(t, { SchemaName: "new_Count", Type: 100000001, Value: "7" })).status, 204);
  const definitions = t.store.state.tables.environmentvariabledefinition.filter((d) => d.schemaname === "new_Count");
  const values = t.store.state.tables.environmentvariablevalue.filter((v) => v.schemaname === "new_Count");
  assert.equal(definitions.length, 1, "one definition");
  assert.equal(definitions[0].displayname, "Count", "a later call keeps the display name it does not send");
  assert.deepEqual(values.map((v) => v.value), ["7"], "one value row, updated");
  await assert.rejects(upsert(t, { SchemaName: "new_Count", Type: 5 }), refused);
  await assert.rejects(upsert(t, { SchemaName: "new_Count", Type: 100000000, SecretStore: 1 }), refused);
});

test("UpsertEnvironmentVariable is refused to a user without the write privilege on the definition table", async () => {
  const t = await setup();
  await denied(upsert({ ...t, admin: t.norole }, { SchemaName: "new_Denied", Type: 100000000, Value: "x" }));
  assert.equal(t.store.state.tables.environmentvariabledefinition.some((d) => d.schemaname === "new_Denied"), false);
});

test("RetrieveEnvironmentVariableSecretValue refuses an unknown name and answers a known Key Vault variable as not simulated", async () => {
  const t = await setup();
  await upsert(t, { SchemaName: "new_Vault", Type: 100000000, SecretStore: 0 });
  await assert.rejects(action(t.api, "RetrieveEnvironmentVariableSecretValue", { user: t.admin, body: { EnvironmentVariableName: "new_Vault" } }),
    (e) => e.status === 501 && e.details?.innerCode === "0x80040216");
  await assert.rejects(action(t.api, "RetrieveEnvironmentVariableSecretValue", { user: t.admin, body: { EnvironmentVariableName: UNKNOWN } }), notFound);
});

test("NotifyEnvironmentVariableSecretChange needs both arguments and answers 204 with no state change", async () => {
  const t = await setup();
  await assert.rejects(action(t.api, "NotifyEnvironmentVariableSecretChange", { user: t.admin, body: { KeyVaultUrl: "/subscriptions/x" } }), refused);
  const before = JSON.stringify(t.store.state);
  const res = await action(t.api, "NotifyEnvironmentVariableSecretChange", { user: t.admin, body: { KeyVaultUrl: "/subscriptions/x", SecretName: "db-password" } });
  assert.equal(res.status, 204);
  assert.equal(JSON.stringify(t.store.state), before);
});

test("RetrieveDeploymentLicenseType and RetrieveLicenseInfo answer with the documented shape", async () => {
  const t = await setup();
  const type = await invoke(t.api, "RetrieveDeploymentLicenseType", { user: t.admin });
  assert.equal(type.body.licenseType, "Trial");
  const info = await invoke(t.api, "RetrieveLicenseInfo", { user: t.admin, params: { AccessMode: 0 } });
  assert.equal(info.body.GrantedLicenseCount, 3, "the interactive users hold the granted licenses");
  assert.equal(info.body.AvailableCount, 0);
  await assert.rejects(invoke(t.api, "RetrieveLicenseInfo", { user: t.admin, params: { AccessMode: "all" } }), refused);
});

test("RetrieveUserLicenseInfo answers for a known systemuser and refuses an unknown one", async () => {
  const t = await setup();
  const res = await invoke(t.api, "RetrieveUserLicenseInfo", { kind: "function", binding: "entity", entity: "systemuser", user: t.admin, target: { id: t.basic.systemuserid } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.licenseInfo.ServicePlans, []);
  await assert.rejects(invoke(t.api, "RetrieveUserLicenseInfo", { binding: "entity", entity: "systemuser", user: t.admin, target: { id: UNKNOWN } }), notFound);
});

test("a generic OrganizationRequest dispatches IsDataEncryptionActive over SOAP", async () => {
  const t = await setup();
  const DECL = Object.entries(NS).map(([p, uri]) => `xmlns:${p}="${uri}"`).join(" ");
  const xml = `<s:Envelope ${DECL}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:OrganizationRequest"><a:Parameters/><a:RequestName>IsDataEncryptionActive</a:RequestName></request></Execute></s:Body></s:Envelope>`;
  const res = await handleSoap({
    method: "POST", headers: {}, bodyText: xml, user: t.admin, caller: t.admin,
    identity: { admin: true, id: t.admin.systemuserid, systemUserId: t.admin.systemuserid },
    origin: ORIGIN, version: "v9.2", requestId: "test",
  }, t.api);
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<a:ResponseName>IsDataEncryptionActive<\/a:ResponseName>/);
  assert.match(res.body, /<b:key>IsActive<\/b:key><b:value i:type="c:boolean">true<\/b:value>/);
});

// Settings, encryption key, sample data, SharePoint URLs, license access, social profile, walls, timeline, Fx and the
// SetFeatureStatus internal message.
const APP = "33333333-aaaa-4aaa-8aaa-000000000001";
const SITE = "44444444-aaaa-4aaa-8aaa-000000000001";
const LOCATION = "44444444-aaaa-4aaa-8aaa-000000000002";
const POST_OWN = "55555555-aaaa-4aaa-8aaa-000000000001";
const POST_FOLLOWED = "55555555-aaaa-4aaa-8aaa-000000000002";
const POST_LATER = "55555555-aaaa-4aaa-8aaa-000000000003";
const POST_UNRELATED = "55555555-aaaa-4aaa-8aaa-000000000004";
const SITE_URL = "https://contoso.example/sites/sample";

// Seeds the application (new_sampleapp) that the setting calls name.
const seedApp = (t) => t.store.transact(() => { t.store.state.tables.appmodule = [{ appmoduleid: APP, uniquename: "new_sampleapp", name: "Sample App" }]; });
// Writes setting definitions as the host or a test does (solution parsing is not modelled).
async function defineSettings(t, defs) {
  await t.store.transact(() => {
    const map = (t.store.state.dataverse ??= {}).settingDefinitions ??= {};
    for (const def of defs) map[def.uniquename.toLowerCase()] = def;
  });
}
const readSetting = (t, SettingName, AppUniqueName) => invoke(t.api, "RetrieveSetting", { user: t.admin, params: AppUniqueName ? { SettingName, AppUniqueName } : { SettingName } });
const saveSetting = (t, body, user = t.admin) => action(t.api, "SaveSettingValue", { user, body });
const valueOfSetting = async (t, name, app) => (await readSetting(t, name, app)).body.SettingDetail.Value;

test("RetrieveSetting resolves app value, then environment value, then default by overridable level", async () => {
  const t = await setup();
  await seedApp(t);
  await defineSettings(t, [
    { uniquename: "new_Both", datatype: 1, defaultvalue: "default", isoverridable: true, overridablelevel: 0 },
    { uniquename: "new_OrgOnly", datatype: 1, defaultvalue: "default", isoverridable: true, overridablelevel: 1 },
    { uniquename: "new_AppOnly", datatype: 1, defaultvalue: "default", isoverridable: true, overridablelevel: 2 },
  ]);
  assert.equal(await valueOfSetting(t, "new_Both"), "default");
  await saveSetting(t, { SettingName: "new_Both", Value: "environment" });
  assert.equal(await valueOfSetting(t, "new_Both"), "environment");
  await saveSetting(t, { SettingName: "new_Both", AppUniqueName: "new_sampleapp", Value: "app" });
  assert.equal(await valueOfSetting(t, "new_Both", "new_sampleapp"), "app", "AppAndOrganization: the app value wins for its app");
  assert.equal(await valueOfSetting(t, "new_Both"), "environment", "and the environment value applies without the app");

  await saveSetting(t, { SettingName: "new_OrgOnly", Value: "organization" });
  assert.equal(await valueOfSetting(t, "new_OrgOnly", "new_sampleapp"), "organization", "OrganizationOnly ignores the app");

  assert.equal(await valueOfSetting(t, "new_AppOnly", "new_sampleapp"), "default", "AppOnly: no app value yet, so the default");
  await saveSetting(t, { SettingName: "new_AppOnly", AppUniqueName: "new_sampleapp", Value: "only" });
  assert.equal(await valueOfSetting(t, "new_AppOnly", "new_sampleapp"), "only");
  assert.equal(await valueOfSetting(t, "new_AppOnly"), "default", "AppOnly without the app: the default");
});

test("SaveSettingValue writes an environment value without AppUniqueName and an app value with it, and refuses a wrong type, a disallowed level, a non-overridable setting and a non-admin", async () => {
  const t = await setup();
  await seedApp(t);
  await defineSettings(t, [
    { uniquename: "new_Count", datatype: 0, defaultvalue: "1", isoverridable: true, overridablelevel: 0 },
    { uniquename: "new_Flag", datatype: 2, defaultvalue: "false", isoverridable: true, overridablelevel: 0 },
    { uniquename: "new_OrgOnly", datatype: 1, defaultvalue: "d", isoverridable: true, overridablelevel: 1 },
    { uniquename: "new_Fixed", datatype: 1, defaultvalue: "fixed", isoverridable: false, overridablelevel: 0 },
  ]);
  await assert.rejects(saveSetting(t, { SettingName: "new_Count", Value: "twelve" }), refused);
  assert.equal((await saveSetting(t, { SettingName: "new_Count", Value: "12.5" })).status, 204);
  assert.equal(await valueOfSetting(t, "new_Count"), "12.5");
  assert.equal((await saveSetting(t, { SettingName: "new_Flag", Value: "TRUE" })).status, 204);
  assert.equal(await valueOfSetting(t, "new_Flag"), "true", "a boolean is stored lowercase");
  await assert.rejects(saveSetting(t, { SettingName: "new_Flag", Value: "yes" }), refused);
  await assert.rejects(saveSetting(t, { SettingName: "new_OrgOnly", AppUniqueName: "new_sampleapp", Value: "app" }), refused);
  await assert.rejects(saveSetting(t, { SettingName: "new_Fixed", Value: "changed" }), refused);
  await denied(saveSetting(t, { SettingName: "new_Count", Value: "3" }, t.basic));
});

test("RetrieveSetting refuses an unknown setting or app", async () => {
  const t = await setup();
  await seedApp(t);
  await defineSettings(t, [{ uniquename: "new_Both", datatype: 1, defaultvalue: "d", isoverridable: true, overridablelevel: 0 }]);
  await assert.rejects(readSetting(t, "new_Missing"), notFound);
  await assert.rejects(readSetting(t, "new_Both", "new_noapp"), notFound);
});

test("SetDataEncryptionKey stores the key that RetrieveDataEncryptionKey returns; both refuse a Basic User", async () => {
  const t = await setup();
  const standIn = (await invoke(t.api, "RetrieveDataEncryptionKey", { user: t.admin })).body.EncryptionKey;
  assert.match(standIn, /^[0-9a-f]{8}-[0-9a-f]{4}-/i, "a deterministic stand-in until a key is set");
  await denied(invoke(t.api, "RetrieveDataEncryptionKey", { user: t.basic }));
  await denied(action(t.api, "SetDataEncryptionKey", { user: t.basic, body: { EncryptionKey: "new-key-test", ChangeEncryptionKey: false } }));
  await assert.rejects(action(t.api, "SetDataEncryptionKey", { user: t.admin, body: { EncryptionKey: "new-key-test", ChangeEncryptionKey: "maybe" } }), refused);
  assert.equal((await action(t.api, "SetDataEncryptionKey", { user: t.admin, body: { EncryptionKey: "new-key-test", ChangeEncryptionKey: true } })).status, 204);
  assert.equal((await invoke(t.api, "RetrieveDataEncryptionKey", { user: t.admin })).body.EncryptionKey, "new-key-test");
});

test("InstallSampleData sets organization.sampledataimportid once and UninstallSampleData clears it, admin only", async () => {
  const t = await setup();
  await t.store.transact(() => {
    if (!t.store.state.tables.organization?.length) t.store.state.tables.organization = [{ organizationid: ORG }];
  });
  const sampleImportId = () => t.store.state.tables.organization[0].sampledataimportid;
  await denied(action(t.api, "InstallSampleData", { user: t.basic }));
  assert.equal((await action(t.api, "InstallSampleData", { user: t.admin })).status, 204);
  assert.match(sampleImportId(), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "the import id is set");
  await assert.rejects(action(t.api, "InstallSampleData", { user: t.admin }), refused);
  await denied(action(t.api, "UninstallSampleData", { user: t.basic }));
  assert.equal((await action(t.api, "UninstallSampleData", { user: t.admin })).status, 204);
  assert.equal(sampleImportId(), null);
  await assert.rejects(action(t.api, "UninstallSampleData", { user: t.admin }), refused);
});

test("RetrieveAbsoluteAndSiteCollectionUrl composes parent and relative URLs and blanks the site collection URL without isgridpresent", async () => {
  const t = await setup();
  const seed = (isgridpresent) => t.store.transact(() => {
    t.store.state.tables.sharepointsite = [{ sharepointsiteid: SITE, absoluteurl: SITE_URL, isgridpresent, relativeurl: null }];
    t.store.state.tables.sharepointdocumentlocation = [{
      sharepointdocumentlocationid: LOCATION, relativeurl: "/Shared Documents/", absoluteurl: null,
      parentsiteorlocation: { id: SITE, logical_name: "sharepointsite" },
    }];
  });
  const urls = (entity, id) => invoke(t.api, "RetrieveAbsoluteAndSiteCollectionUrl", { binding: "entity", entity, user: t.admin, target: { id } }).then((r) => r.body);
  await seed(true);
  const location = await urls("sharepointdocumentlocation", LOCATION);
  assert.equal(location.AbsoluteUrl, `${SITE_URL}/Shared Documents/`);
  assert.equal(location.SiteCollectionUrl, SITE_URL);
  await seed(false);
  const site = await urls("sharepointsite", SITE);
  assert.equal(site.AbsoluteUrl, SITE_URL);
  assert.equal(site.SiteCollectionUrl, "", "blank without isgridpresent");
});

test("RetrievePersonalWall returns followed and own posts newest first, paged, with CommentsPerPost comments; RetrieveRecordWall honours SortDirection, Keyword and dates", async () => {
  const t = await setup();
  const me = t.admin.systemuserid;
  const other = t.basic.systemuserid;
  const user = (id) => ({ id, logical_name: "systemuser" });
  await t.store.transact(() => {
    const tables = t.store.state.tables;
    tables.post = [
      { postid: POST_OWN, regardingobjectid: user(me), text: "Own note", createdon: "2026-10-01T10:00:00Z", source: 2, createdby: user(me) },
      { postid: POST_FOLLOWED, regardingobjectid: user(other), text: "Followed note", createdon: "2026-10-02T10:00:00Z", source: 2, createdby: user(other) },
      { postid: POST_LATER, regardingobjectid: user(other), text: "Later about basic", createdon: "2026-10-03T10:00:00Z", source: 1, createdby: user(me) },
      { postid: POST_UNRELATED, regardingobjectid: null, text: "Unrelated", createdon: "2026-10-04T10:00:00Z", source: 2, createdby: user(me) },
    ];
    tables.postfollow = [{ postfollowid: "66666666-aaaa-4aaa-8aaa-000000000001", ownerid: user(me), regardingobjectid: user(other) }];
    tables.postcomment = [
      { postcommentid: "77777777-aaaa-4aaa-8aaa-000000000001", postid: { id: POST_OWN, logical_name: "post" }, text: "first", createdon: "2026-10-01T11:00:00Z" },
      { postcommentid: "77777777-aaaa-4aaa-8aaa-000000000002", postid: { id: POST_OWN, logical_name: "post" }, text: "second", createdon: "2026-10-01T12:00:00Z" },
      { postcommentid: "77777777-aaaa-4aaa-8aaa-000000000003", postid: { id: POST_OWN, logical_name: "post" }, text: "third", createdon: "2026-10-01T13:00:00Z" },
    ];
  });
  const personal = (params) => invoke(t.api, "RetrievePersonalWall", { binding: "collection", entity: "post", user: t.admin, params: { PageNumber: 1, PageSize: 2, CommentsPerPost: 2, ...params } });
  const first = await personal({});
  assert.deepEqual(first.body.value.map((p) => p.postid), [POST_LATER, POST_FOLLOWED]);
  const second = await personal({ PageNumber: 2 });
  assert.deepEqual(second.body.value.map((p) => p.postid), [POST_OWN]);
  assert.deepEqual(second.body.value[0].Post_Comments.map((c) => c.text), ["third", "second"], "the newest CommentsPerPost comments");

  const record = (params) => invoke(t.api, "RetrieveRecordWall", { binding: "collection", entity: "post", user: t.admin, params: { Entity: { "@odata.id": `systemusers(${other})` }, PageNumber: 1, PageSize: 10, CommentsPerPost: 0, ...params } });
  assert.deepEqual((await record({})).body.value.map((p) => p.postid), [POST_LATER, POST_FOLLOWED], "descending by default");
  assert.deepEqual((await record({ SortDirection: true })).body.value.map((p) => p.postid), [POST_FOLLOWED, POST_LATER], "ascending with SortDirection true");
  assert.deepEqual((await record({ Keyword: "later*" })).body.value.map((p) => p.postid), [POST_LATER], "the wildcard keyword, case-insensitive");
  assert.deepEqual((await record({ StartDate: "2026-10-02T12:00:00Z" })).body.value.map((p) => p.postid), [POST_LATER], "StartDate is inclusive");
  assert.deepEqual((await record({ Source: 2 })).body.value.map((p) => p.postid), [POST_FOLLOWED]);
  await assert.rejects(personal({ PageNumber: 0 }), refused);
  await assert.rejects(record({ Entity: { "@odata.id": `systemusers(${UNKNOWN})` } }), notFound);
});

test("GenerateSocialProfile returns the matching profile or creates one; ExecuteFxExpression answers 501 without an evaluator and delegates to api.fxEvaluator", async () => {
  const t = await setup();
  const profiles = () => t.store.state.tables.socialprofile ?? [];
  const generate = (Entity) => action(t.api, "GenerateSocialProfile", { binding: "collection", entity: "socialprofile", user: t.admin, body: { Entity } });
  const first = await generate({ profilename: "New Sample Profile", community: 1 });
  assert.equal(first.status, 200);
  assert.equal(first.body.profilename, "New Sample Profile");
  assert.equal(profiles().length, 1);
  const again = await generate({ profilename: "new sample profile", community: 1 });
  assert.equal(again.body.socialprofileid, first.body.socialprofileid, "the profile name matches the existing row, without case");
  assert.equal(profiles().length, 1);
  await assert.rejects(generate(undefined), refused);

  await assert.rejects(action(t.api, "ExecuteFxExpression", { user: t.admin, body: { expression: "1+1" } }),
    (e) => e.status === 501 && e.details?.innerCode === "0x80040216");
  t.api.fxEvaluator = async ({ expression }) => ({ Result: expression.length });
  const fx = await action(t.api, "ExecuteFxExpression", { user: t.admin, body: { expression: "1+1" } });
  assert.equal(fx.body.Result, 3);
  assert.match(fx.body["@odata.context"], /crmbaseentity$/);
});

test("RetrieveUserApplicationLicenseAccess refuses an unknown application; RetrieveTimelineWallRecords needs FetchXml and a valid RollupType", async () => {
  const t = await setup();
  const access = (ApplicationId) => invoke(t.api, "RetrieveUserApplicationLicenseAccess", { binding: "entity", entity: "systemuser", user: t.admin, target: { id: t.basic.systemuserid }, params: { ApplicationId } });
  await assert.rejects(access(APP), notFound);
  await seedApp(t);
  assert.equal((await access(APP)).body.LicenseAccessInfo, "{}");
  await assert.rejects(access("not-a-guid"), refused);

  const FetchXml = `<fetch><entity name="activitypointer"><all-attributes /></entity></fetch>`;
  const timeline = (params) => invoke(t.api, "RetrieveTimelineWallRecords", { binding: "collection", entity: "activitypointer", user: t.admin, params });
  assert.deepEqual(JSON.parse((await timeline({ FetchXml })).body.TimelineWallRecords), []);
  await assert.rejects(timeline({}), refused);
  await assert.rejects(timeline({ FetchXml, RollupType: 3 }), refused);
});

test("SetFeatureStatus is in $metadata and answers 501 0x80040216 by default; a dataverseMessages pack handler replaces it", async () => {
  const t = await setup();
  assert.match(t.api.registry.csdlFragments(), /<Action Name="SetFeatureStatus">[\s\S]*?Name="FeatureType" Type="Edm.Int32"/);
  await assert.rejects(action(t.api, "SetFeatureStatus", { user: t.admin, body: { FeatureType: 1, Status: true } }),
    (e) => e.status === 501 && e.details?.innerCode === "0x80040216" && e.message === "SetFeatureStatus is for internal use only and is not simulated.");
  t.api.addonHandlers = addonHandlers([{ id: "invented-pack", dataverseMessages: { SetFeatureStatus: async (ctx) => ({ Recorded: ctx.args.FeatureType }) } }]);
  const res = await action(t.api, "SetFeatureStatus", { user: t.admin, body: { FeatureType: 1, Status: true } });
  assert.equal(res.body.Recorded, 1);
});
