// Knowledge version and view, rollup, virtual table event, composite data source, certificate credential, managed identity
// subject, business process flow and SetProcess messages over HTTP. Invented schema (contoso_widget, new_samplevirtual,
// new_samplebpf) and invented GUIDs only; loopback only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { uuidV5 } from "../lib/dataverse-security.mjs";
import { createAsyncPluginRunner } from "../lib/plugin-async.mjs";
import { pluginCatalogue } from "../lib/exported-plugins.mjs";

const APP_ID = "22222222-2222-2222-2222-222222222222";
const SECRET_VAR = "PAQVILO_MISC_MESSAGES2_SECRET";
const TENANT = "00112233-4455-6677-8899-aabbccddeeff";
const CRM = "Microsoft.Dynamics.CRM.";
const ART_V1 = "e1000000-0000-4000-8000-000000000001";
const ART_VIEW = "e1000000-0000-4000-8000-000000000002";
const LANG_FR = "f1000000-0000-4000-8000-000000000001";
const LANG_EN = "f1000000-0000-4000-8000-000000000002";
const LANG_UNKNOWN = "f1000000-0000-4000-8000-0000000000ff";
const ACCOUNT_A = "a2000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "a2000000-0000-4000-8000-00000000000b";
const ACCOUNT_C = "a2000000-0000-4000-8000-00000000000c";
const ACT_A = "b2000000-0000-4000-8000-00000000000a";
const ACT_B = "b2000000-0000-4000-8000-00000000000b";
const ACT_C = "b2000000-0000-4000-8000-00000000000c";
const VIRTUAL = "c2000000-0000-4000-8000-000000000001";
const WIDGET_ONE = "d2000000-0000-4000-8000-000000000001";
const WIDGET_TWO = "d2000000-0000-4000-8000-000000000002";
const MANAGED = "e2000000-0000-4000-8000-000000000001";
const PLUGIN_ASSEMBLY = "f2000000-0000-4000-8000-000000000001";
const THUMB = "AB".repeat(20);
const WORKFLOW = "91000000-0000-4000-8000-000000000001";
const STAGE_ONE = "92000000-0000-4000-8000-000000000001";
const STAGE_TWO = "92000000-0000-4000-8000-000000000002";
const STAGE_THREE = "92000000-0000-4000-8000-000000000003";
const INSTANCE_OLD = "93000000-0000-4000-8000-000000000001";
const INSTANCE_NEW = "93000000-0000-4000-8000-000000000002";
const SECRET_NAME = "misc-messages2-secret";

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: "contoso_widget", entitySet: "contoso_widgets", idColumn: "contoso_widgetid", nameColumn: "name", userConfigured: true,
    fields: { name: { dataverseType: "nvarchar" } }, relationships: {},
  };
  state.tables.contoso_widget = [];
  state.mappings.new_samplevirtual = {
    logicalName: "new_samplevirtual", entitySet: "new_samplevirtuals", idColumn: "new_samplevirtualid", isVirtual: true, userConfigured: true,
    fields: { name: { dataverseType: "nvarchar" } }, relationships: {},
  };
  state.mappings.new_samplebpf = {
    logicalName: "new_samplebpf", entitySet: "new_samplebpfs", idColumn: "new_samplebpfid", userConfigured: true,
    fields: { bpf_contoso_widgetid: { dataverseType: "uniqueidentifier" }, activestageid: { dataverseType: "uniqueidentifier" }, traversedpath: { dataverseType: "nvarchar" } },
    relationships: {},
  };
  state.tables.new_samplebpf = [];
  state.tables.virtualentitymetadata = [{ virtualentitymetadataid: VIRTUAL, name: "new_samplevirtual", isonexternalcreatedenabled: true, isonexternalupdatedenabled: true, isonexternaldeletedenabled: true, ischangedfieldsenabledforupdateevent: false }];
  return state;
}

describe("dataverse misc messages 2: knowledge, rollup, virtual events, composite data sources, certificates, FIC, BPF and SetProcess", () => {
  let api;
  let store;
  let origin;
  let appToken;

  before(async () => {
    process.env[SECRET_VAR] = SECRET_NAME;
    store = await new DataStore({ state: fixtureState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      tenantId: TENANT,
      applications: [{ appId: APP_ID, displayName: "Misc 2 app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
    });
    api = await startDataverseApi({ store, settings, log: () => {}, extensions: EXTENSIONS });
    origin = api.origin;
    await store.transact(() => {
      const tables = store.state.tables;
      tables.knowledgearticle = [
        { knowledgearticleid: ART_V1, title: "Version one", rootarticleid: ART_V1, majorversionnumber: 1, minorversionnumber: 0, islatestversion: true, languagelocaleid: LANG_EN, statecode: 1, statuscode: 2, content: "v1" },
        { knowledgearticleid: ART_VIEW, title: "Viewed", rootarticleid: ART_VIEW, majorversionnumber: 1, minorversionnumber: 0, islatestversion: true, statecode: 1, statuscode: 2 },
      ];
      tables.knowledgearticleviews = [];
      tables.languagelocale = [{ languagelocaleid: LANG_FR, localeid: 1036, code: "fr-FR" }, { languagelocaleid: LANG_EN, localeid: 1033, code: "en-US" }];
      tables.account = [
        { accountid: ACCOUNT_A, name: "Parent account" },
        { accountid: ACCOUNT_B, name: "Child account", parentaccountid: ACCOUNT_A },
        { accountid: ACCOUNT_C, name: "Unrelated account" },
      ];
      tables.activitypointer = [
        { activityid: ACT_A, subject: "On parent", regardingobjectid: ACCOUNT_A, regardingobjectidtype: "account" },
        { activityid: ACT_B, subject: "On child", regardingobjectid: ACCOUNT_B, regardingobjectidtype: "account" },
        { activityid: ACT_C, subject: "On unrelated", regardingobjectid: ACCOUNT_C, regardingobjectidtype: "account" },
      ];
      tables.virtualentitymetadata = [{ virtualentitymetadataid: VIRTUAL, name: "new_samplevirtual", isonexternalcreatedenabled: true, isonexternalupdatedenabled: true, isonexternaldeletedenabled: true, ischangedfieldsenabledforupdateevent: false }];
      tables.managedidentity = [{ managedidentityid: MANAGED, name: "contoso identity" }];
      tables.pluginassembly = [{ pluginassemblyid: PLUGIN_ASSEMBLY, name: "Contoso.Plugins", managedidentityid: MANAGED }];
      tables.workflow = [{ workflowid: WORKFLOW, name: "Contoso flow", category: 4, primaryentity: "contoso_widget", statecode: 1, uniquename: "new_samplebpf" }];
      tables.processstage = [
        { processstageid: STAGE_ONE, processid: WORKFLOW, stagename: "Qualify" },
        { processstageid: STAGE_TWO, processid: WORKFLOW, stagename: "Develop" },
        { processstageid: STAGE_THREE, processid: WORKFLOW, stagename: "Close" },
      ];
      tables.new_samplebpf = [
        { new_samplebpfid: INSTANCE_OLD, bpf_contoso_widgetid: WIDGET_ONE, processid: WORKFLOW, activestageid: STAGE_ONE, traversedpath: STAGE_ONE, modifiedon: "2026-10-01T09:00:00Z" },
        { new_samplebpfid: INSTANCE_NEW, bpf_contoso_widgetid: WIDGET_ONE, processid: WORKFLOW, activestageid: STAGE_TWO, traversedpath: `${STAGE_THREE},${STAGE_ONE}`, modifiedon: "2026-10-05T09:00:00Z" },
      ];
      tables.contoso_widget = [{ contoso_widgetid: WIDGET_ONE, name: "One" }, { contoso_widgetid: WIDGET_TWO, name: "Two" }];
    });
    appToken = await clientToken();
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  async function clientToken() {
    const response = await fetch(`${origin}/${TENANT}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${origin}/.default` }),
    });
    return (await response.json()).access_token;
  }

  const call = (path, { method = "GET", body } = {}) =>
    fetch(`${origin}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${appToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const webApi = (suffix) => `/api/data/v9.2/${suffix}`;
  const encoded = (value) => encodeURIComponent(typeof value === "string" ? value : JSON.stringify(value));
  const ref = (set, id) => ({ "@odata.id": `${set}(${id})` });

  async function errorOf(response, status) {
    const text = await response.text();
    assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${text}`);
    return { message: JSON.parse(text).error.message, text };
  }

  it("IncrementKnowledgeArticleViewCount adds to the day row and the article total", async () => {
    const path = (count) =>
      webApi(`IncrementKnowledgeArticleViewCount(Source=@s,ViewDate=@d,Location=@l,Count=@c)?@s=${encoded(ref("knowledgearticles", ART_VIEW))}&@d=${encoded("2026-10-20T10:00:00Z")}&@l=1&@c=${count}`);
    const first = await call(path(3));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).knowledgearticleview, 3);
    const second = await (await call(path(2))).json();
    assert.equal(second.knowledgearticleview, 5, "same article, UTC day and location add to one row");
    const article = store.state.tables.knowledgearticle.find((row) => row.knowledgearticleid === ART_VIEW);
    assert.equal(article.knowledgearticleviews, 5);
    assert.equal(store.state.tables.knowledgearticleviews.length, 1);
  });

  it("CreateKnowledgeArticleVersion makes a major version latest; a translation to an unknown locale is 0x80061400", async () => {
    const version = await call(webApi("CreateKnowledgeArticleVersion"), { method: "POST", body: { Source: ref("knowledgearticles", ART_V1), IsMajor: true } });
    assert.equal(version.status, 200, await version.clone().text());
    const fresh = await version.json();
    assert.equal(fresh.majorversionnumber, 2);
    assert.equal(fresh.minorversionnumber, 0);
    assert.equal(fresh.rootarticleid, ART_V1);
    assert.equal(fresh.islatestversion, true);
    assert.equal(store.state.tables.knowledgearticle.find((row) => row.knowledgearticleid === ART_V1).islatestversion, false);

    const unknown = await call(webApi("CreateKnowledgeArticleTranslation"), {
      method: "POST", body: { Source: ref("knowledgearticles", ART_V1), Language: ref("languagelocales", LANG_UNKNOWN), IsMajor: false },
    });
    assert.match((await errorOf(unknown, 400)).text, /0x80061400/);

    const translated = await call(webApi("CreateKnowledgeArticleTranslation"), {
      method: "POST", body: { Source: ref("knowledgearticles", ART_V1), Language: ref("languagelocales", LANG_FR), IsMajor: false },
    });
    assert.equal(translated.status, 200);
    const copy = await translated.json();
    assert.equal(copy.languagelocaleid, LANG_FR);
    assert.equal(copy.isprimary, false);
    assert.match((await errorOf(await call(webApi("CreateKnowledgeArticleTranslation"), {
      method: "POST", body: { Source: ref("knowledgearticles", ART_V1), Language: ref("languagelocales", LANG_FR), IsMajor: false },
    }), 400)).text, /0x80061403/);
  });

  it("Rollup Related returns activities of the account and its child account; an invalid type is 0x80040234", async () => {
    const query = { "@odata.type": "Microsoft.Dynamics.CRM.QueryExpression", EntityName: "activitypointer", ColumnSet: { AllColumns: false, Columns: ["subject"] } };
    const rollupPath = (type, target = ref("accounts", ACCOUNT_A)) =>
      webApi(`Rollup(Target=@t,Query=@q,RollupType=@r)?@t=${encoded(target)}&@q=${encoded(query)}&@r=${encoded(type)}`);
    const relatedResponse = await call(rollupPath(`${CRM}RollupType'Related'`));
    assert.equal(relatedResponse.status, 200, await relatedResponse.clone().text());
    const related = await relatedResponse.json();
        assert.deepEqual(related.value.map((row) => row.activityid).sort(), [ACT_A, ACT_B].sort());
    // activitypointer takes Related or Extended for an account, so None is refused as an invalid type.
    assert.match((await errorOf(await call(rollupPath("0")), 400)).text, /0x80040234/);
    assert.match((await errorOf(await call(rollupPath("Bogus")), 400)).text, /0x80040234/);
  });

  it("OnExternalUpdated refuses a non-virtual table and accepts a virtual one with 204", async () => {
    const path = webApi("OnExternalUpdated");
    const plain = await call(path, { method: "POST", body: { Target: ref("contoso_widgets", WIDGET_ONE), ChangedFields: [] } });
    assert.match((await errorOf(plain, 400)).text, /0x80040203/);
    const changed = await call(path, { method: "POST", body: { Target: ref("new_samplevirtuals", VIRTUAL), ChangedFields: ["name"] } });
    assert.match((await errorOf(changed, 400)).text, /0x80073019/, "changed fields are not enabled for this table");
    store.state.tables.virtualentitymetadata[0].ischangedfieldsenabledforupdateevent = true;
    const accepted = await call(path, { method: "POST", body: { Target: ref("new_samplevirtuals", VIRTUAL), ChangedFields: ["name"] } });
    assert.equal(accepted.status, 204);
    store.state.tables.virtualentitymetadata[0].ischangedfieldsenabledforupdateevent = false;
  });

  it("external virtual events dispatch their snapshot asynchronously and leave external rows untouched", async () => {
    const observed = [];
    const step = { id: VIRTUAL, name: "Invented external observer", entity: "new_samplevirtual", message: "OnExternalCreated", enabled: true, stage: 40, rank: 1, mode: 1, typeName: "Invented.External", assemblyId: PLUGIN_ASSEMBLY, supportedDeployment: 0, filteringAttributes: [], images: [] };
    const handlers = new Map([[step.typeName, event => { observed.push(event.context); }]]);
    const items = () => pluginCatalogue({ plugins: { steps: [step] }, handlers });
    const runner = createAsyncPluginRunner({ store, items, handlers, runtimes: new Map() });
    try {
      const response = await call(webApi("new_samplevirtuals/Microsoft.Dynamics.CRM.OnExternalCreated"), { method: "POST", body: { Target: { "@odata.type": CRM + "new_samplevirtual", new_samplevirtualid: VIRTUAL, name: "External snapshot" } } });
      assert.equal(response.status, 204, await response.clone().text());
      await runner.drain();
      assert.equal(observed.length, 1);
      assert.equal(observed[0].MessageName, "OnExternalCreated");
      assert.equal(observed[0].Mode, 1);
      assert.equal(observed[0].InputParameters.Target.name, "External snapshot");
      assert.deepEqual(store.tableRows("new_samplevirtual"), []);
      store.state.tables.virtualentitymetadata[0].isonexternalcreatedenabled = false;
      const disabled = await call(webApi("OnExternalCreated"), { method: "POST", body: { Target: ref("new_samplevirtuals", VIRTUAL) } });
      assert.match((await errorOf(disabled, 400)).text, /0x80090309/);
    } finally { store.state.tables.virtualentitymetadata[0].isonexternalcreatedenabled = true; await runner.close(); }
  });

  it("undocumented platform contracts remain discoverable with explicit implementation errors", async () => {
    const metadata = await (await call(webApi("$metadata"))).text();
    for (const name of ["_Downloademailasattachment", "_InvokeHideReserveEntities", "_SyncKnowledgeManagementSettings", "cascadeAsync_SuccessAPI"]) {
      assert.ok(metadata.includes(`Action Name="${name}"`), name);
      const response = await call(webApi(name), { method: "POST", body: {} });
      assert.match((await errorOf(response, 501)).text, /no configured local implementation/);
    }
    assert.ok(metadata.includes('Property Name="emailRecordData" Type="Edm.String"'));
  });

  it("UpsertCompositeDataSource links a child and RetrieveAllCompositeDataSources returns both", async () => {
    const upsert = await call(webApi("UpsertCompositeDataSource"), {
      method: "POST",
      body: {
        ParentDisplayName: "Parent source", ParentSchemaName: "new_ParentSource", ParentParameterKey: "parentKey", ParentApiId: "/api/parent", ParentValue: "parent-value",
        ChildDisplayName: "Child source", ChildSchemaName: "new_ChildSource", ChildParameterKey: "childKey", ChildValue: "child-value",
      },
    });
    assert.equal(upsert.status, 204);
    const all = await (await call(webApi(`RetrieveAllCompositeDataSources(ParentSchemaName='new_ParentSource')`))).json();
    assert.deepEqual(all.value.map((row) => row.schemaname).sort(), ["new_ChildSource", "new_ParentSource"]);
    const parent = all.value.find((row) => row.schemaname === "new_ParentSource");
    assert.equal(parent.environmentvariabledefinition_environmentvariablevalue[0].value, "parent-value");
    const both = await (await call(webApi("RetrieveCompositeDataSource(ParentSchemaName='new_ParentSource',ChildSchemaName='new_ChildSource')"))).json();
    assert.equal(both.value.length, 2);
    const missing = await call(webApi("RetrieveAllCompositeDataSources(ParentSchemaName='new_Nothing')"));
    assert.match((await errorOf(missing, 404)).text, /0x80095004/);
  });

  it("certificate credentials are added, listed and removed; a missing one is 0x8005e239", async () => {
    const add = (thumbprint) => call(webApi("AddCertificateCredential"), { method: "POST", body: { thumbprint, entityId: MANAGED, entityLogicalName: "managedidentity" } });
    assert.equal((await add(THUMB)).status, 204);
    assert.equal((await add(THUMB)).status, 204, "the same thumbprint again is a no-op");
    const listed = await (await call(webApi("GetCertificateCredential"), { method: "POST", body: { entityLogicalName: "managedidentity", entityId: MANAGED } })).json();
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0].thumbprint, THUMB);
    const certificateCredentialId = uuidV5(MANAGED, `cc:${THUMB}`);
    const remove = (id) => call(webApi("RemoveCertificateCredential"), { method: "POST", body: { entityLogicalName: "managedidentity", entityId: MANAGED, certificateCredentialId: id } });
    assert.equal((await remove(certificateCredentialId)).status, 204);
    assert.match((await errorOf(await remove(certificateCredentialId), 404)).text, /0x8005e239/);
    assert.match((await errorOf(await add("not-hex"), 400)).text, /0x8005e23a/);
  });

  it("GetComponentManagedIdentityFIC builds the eid1 subject with the encoded tenant id", async () => {
    const response = await call(webApi(`GetComponentManagedIdentityFIC(ComponentName='PluginAssembly',ComponentId=${PLUGIN_ASSEMBLY})`));
    assert.equal(response.status, 200);
    const { FICSubject } = await response.json();
    // .NET byte order for the tenant id: 33 22 11 00 55 44 77 66 88 99 aa bb cc dd ee ff, base64url without padding.
    const encodedTenant = Buffer.from("33221100554477668899aabbccddeeff", "hex").toString("base64url");
    assert.match(FICSubject, new RegExp(`^/eid1/c/pub/t/${encodedTenant}/a/qzXoWDkuqUa3l6zM5mM0Rw/n/plugin/e/Default-${TENANT}/h/[0-9a-f]{64}$`));
  });

  it("RetrieveProcessInstances orders by modifiedon and RetrieveActivePath follows traversedpath", async () => {
    const instances = await (await call(webApi(`RetrieveProcessInstances(EntityId=${WIDGET_ONE},EntityLogicalName='contoso_widget')`))).json();
    assert.deepEqual(instances.value.map((row) => row.new_samplebpfid), [INSTANCE_NEW, INSTANCE_OLD]);
    assert.equal(instances.value[0].processstageid, STAGE_TWO);
    const path = await (await call(webApi(`RetrieveActivePath(ProcessInstanceId=${INSTANCE_NEW})`))).json();
    assert.deepEqual(path.value.map((row) => row.processstageid), [STAGE_THREE, STAGE_ONE, STAGE_TWO]);
    const unknown = await call(webApi(`RetrieveActivePath(ProcessInstanceId=${WIDGET_TWO})`));
    assert.match((await errorOf(unknown, 404)).text, /0x80060370/);
  });

  it("SetProcess is in $metadata and answers 501 0x80040216 by default; the new messages are declared in $metadata", async () => {
    const metadata = await (await call(webApi("$metadata"))).text();
    for (const name of ["IncrementKnowledgeArticleViewCount", "CreateKnowledgeArticleVersion", "CreateKnowledgeArticleTranslation", "Rollup", "OnExternalUpdated",
      "UpsertCompositeDataSource", "RetrieveCompositeDataSource", "RetrieveAllCompositeDataSources", "AddCertificateCredential", "GetCertificateCredential",
      "RemoveCertificateCredential", "GetComponentManagedIdentityFIC", "RetrieveProcessInstances", "RetrieveActivePath", "SetProcess"]) {
      assert.match(metadata, new RegExp(`Name="${name}"`), `${name} is declared`);
    }
    const set = await call(webApi("SetProcess"), { method: "POST", body: {} });
    const error = await errorOf(set, 501);
    assert.match(error.text, /0x80040216/);
    assert.match(error.message, /SetProcess is for internal use only and is not simulated\./);
  });
});
