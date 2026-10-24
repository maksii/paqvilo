// Recycle bin (delete hook, Restore, EmptyRecycleBin), the classic import job (ParseImport, TransformImport, ImportRecordsImport)
// and the annotation and attachment block messages, over HTTP through the full extension list.
import { test, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { parseCsv } from "../lib/dataverse-data-messages.mjs";
import { workflowExtension, workflowHandlers } from "../lib/dataverse-workflows.mjs";

const APP_ID = "55555555-5555-5555-5555-555555555555";
const SECRET_VAR = "PAQVILO_DATA_MESSAGES_TEST_SECRET";
const WIDGET = "aaaaaaaa-0000-0000-0000-0000000000b1";
const GONE = "aaaaaaaa-0000-0000-0000-0000000000b2";
const IMPORT = "bbbbbbbb-0000-0000-0000-0000000000c1";
const IMPORT_FILE = "bbbbbbbb-0000-0000-0000-0000000000c2";
const ORG = "dddddddd-0000-0000-0000-000000000001";
const CRM = "Microsoft.Dynamics.CRM.";
const API = "/api/data/v9.2";

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: "contoso_widget", entitySet: "contoso_widgets", idColumn: "contoso_widgetid", nameColumn: "name",
    userConfigured: true, fields: { name: { dataverseType: "nvarchar" }, status: { dataverseType: "int" } }, relationships: {},
  };
  state.tables.contoso_widget = [{ contoso_widgetid: WIDGET, name: "alpha", status: 1 }];
  return state;
}

async function startServer({ extendState = () => {}, extraExtensions = [], roles = ["System Administrator"] } = {}) {
  process.env[SECRET_VAR] = "data-messages-secret";
  const initial = fixtureState(); extendState(initial);
  const store = await new DataStore({ state: initial }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [{ appId: APP_ID, displayName: "Data messages test app", secretEnvironmentVariable: SECRET_VAR, roles }],
  });
  const server = await startDataverseApi({ store, settings, extensions: [...EXTENSIONS, ...extraExtensions], log: () => {} });
  const token = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${server.origin}/.default` }),
  });
  const authorization = `Bearer ${(await token.json()).access_token}`;
  const timed = (init) => ({ ...init, signal: AbortSignal.timeout(5000) });
  return {
    server, store, origin: server.origin,
    get: (path) => fetch(`${server.origin}${API}${path}`, timed({ headers: { authorization } })),
    send: (method, path, body) =>
      fetch(`${server.origin}${API}${path}`, timed({ method, headers: { authorization, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })),
    close: () => server.close(),
  };
}

const target = (logical, key, id) => ({ "@odata.type": `${CRM}${logical}`, [key]: id });
const b64 = (text) => Buffer.from(text).toString("base64");
const mapXml = `<Map Name="Invented map" Source="CSV"><Description>Offline map</Description><EntitiesPerFile>1</EntitiesPerFile><EntityMaps><EntityMap SourceEntityName="Widgets" TargetEntityName="contoso_widget" ProcessCode="Process"><AttributeMaps><AttributeMap><SourceAttributeName>Title</SourceAttributeName><TargetAttributeName>name</TargetAttributeName><ProcessCode>Process</ProcessCode></AttributeMap><AttributeMap><SourceAttributeName>Stage</SourceAttributeName><TargetAttributeName>status</TargetAttributeName><ProcessCode>Process</ProcessCode><PicklistMaps><PicklistMap><SourceValue>Ready</SourceValue><TargetValue>7</TargetValue><ProcessCode>Process</ProcessCode></PicklistMap></PicklistMaps></AttributeMap></AttributeMaps></EntityMap></EntityMaps></Map>`;

test("import maps round-trip their column/picklist metadata and drive persisted CSV writes", async (t) => {
  const h = await startServer(); t.after(() => h.close());
  const imported = await h.send("POST", "/ImportMappingsImportMap", { MappingsXml: mapXml, ReplaceIds: true });
  assert.equal(imported.status, 200, JSON.stringify(await imported.clone().json()));
  const map = await imported.json();
  assert.equal(h.store.state.tables.columnmapping.filter((row) => row.importmapid === map.importmapid).length, 2);
  const exported = await h.send("POST", `/importmaps(${map.importmapid})/${CRM}ExportMappingsImportMap`, { ExportIds: true });
  const xml = (await exported.json()).MappingsXml;
  assert.match(xml, /SourceAttributeName>Title/);
  assert.match(xml, /TargetValue>7/);
  assert.match(xml, new RegExp(map.importmapid));
  const copy = await h.send("POST", "/ImportMappingsImportMap", { MappingsXml: xml, ReplaceIds: true });
  assert.equal(copy.status, 200);
  assert.notEqual((await copy.json()).importmapid, map.importmapid);
  const conflicting = await h.send("POST", "/ImportMappingsImportMap", { MappingsXml: xml, ReplaceIds: false });
  assert.equal(conflicting.status, 400);
  assert.equal(h.store.state.tables.importmap.length, 2, "a key conflict rolls the import back");
  h.store.state.tables.import = [{ importid: IMPORT, name: "Mapped CSV" }];
  h.store.state.tables.importfile = [{ importfileid: IMPORT_FILE, importid: IMPORT, importmapid: map.importmapid, sourceentityname: "Widgets", targetentityname: "contoso_widget", content: "Title;Stage\nMapped;Ready\nRejected;Unknown\n", fielddelimitercode: 4, processingstatus: 1, isfirstrowheader: true }];
  await h.send("POST", `/imports(${IMPORT})/${CRM}ParseImport`, {}); await waitForStatus(h.store, 3);
  await h.send("POST", "/TransformImport", { ImportId: IMPORT }); await waitForStatus(h.store, 8);
  await h.send("POST", `/imports(${IMPORT})/${CRM}ImportRecordsImport`, {}); await waitForStatus(h.store, 11);
  const row = h.store.state.tables.contoso_widget.find((row) => row.name === "Mapped");
  assert.equal(row.status, 7);
  assert.equal(h.store.state.tables.contoso_widget.some((row) => row.name === "Rejected"), false);
  assert.equal(h.store.state.tables.importfile[0].successcount, 1);
  assert.equal(h.store.state.tables.importfile[0].failurecount, 1);
  assert.match(h.store.state.tables.importlog.at(-1).errordescription, /No picklist mapping/);
});

test("imported rows use typed record writes, caller stamps and atomic real-time workflow failures", async (t) => {
  const id = "cccccccc-1111-0000-0000-000000000001";
  const workflow = workflowExtension({ facts: [{ id, name: "Validate imported widget", uniquename: "ValidateImportedWidget", category: 0, type: 1, mode: 1, scope: 4, state: 1, ondemand: true, primaryentity: "contoso_widget", triggeroncreate: true, istransacted: true, xaml: "<Activity />" }], handlers: workflowHandlers([{ id: "invented-validation", workflows: { ValidateImportedWidget: async ({ target }) => {
    if (target.row.name === "Rejected by workflow") throw new Error("Imported widget failed real-time validation");
  } } }]) });
  const h = await startServer({ extraExtensions: [workflow] }); t.after(() => h.close());
  h.store.state.tables.import = [{ importid: IMPORT, name: "Workflow import" }];
  h.store.state.tables.importfile = [{ importfileid: IMPORT_FILE, importid: { id: IMPORT, logical_name: "import" }, targetentityname: "contoso_widget", processingstatus: 8, content: "name,status\nAccepted,7\nRejected by workflow,8\n", isfirstrowheader: true }];
  const submitted = await h.send("POST", `/imports(${IMPORT})/${CRM}ImportRecordsImport`, {});
  assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()));
  await waitForStatus(h.store, 11);
  const row = h.store.state.tables.contoso_widget.find((row) => row.name === "Accepted");
  assert.equal(row.status, 7, "CSV integers are transformed before strict record validation");
  const user = (await (await h.get("/WhoAmI")).json()).UserId;
  assert.equal(row.createdby?.id ?? row.createdby, user);
  assert.equal(h.store.state.tables.contoso_widget.some((row) => row.name === "Rejected by workflow"), false);
  assert.equal(h.store.state.tables.importfile[0].successcount, 1);
  assert.equal(h.store.state.tables.importfile[0].failurecount, 1);
  assert.match(h.store.state.tables.importlog[0].errordescription, /real-time validation/);
});

test("CSV imports enforce secured-column create permissions for a customizer", async (t) => {
  const h = await startServer({ roles: ["System Customizer"], extendState: (state) => { state.mappings.contoso_widget.fields.secret = { dataverseType: "nvarchar", columnMetadata: { isSecured: true } }; } });
  t.after(() => h.close());
  h.store.state.tables.import = [{ importid: IMPORT, name: "Secured import" }];
  h.store.state.tables.importfile = [{ importfileid: IMPORT_FILE, importid: IMPORT, targetentityname: "contoso_widget", processingstatus: 8, content: "name,secret\nRefused,private\n", isfirstrowheader: true }];
  assert.equal((await h.send("POST", `/imports(${IMPORT})/${CRM}ImportRecordsImport`, {})).status, 200);
  await waitForStatus(h.store, 11);
  assert.equal(h.store.state.tables.contoso_widget.some((row) => row.name === "Refused"), false);
  assert.equal(h.store.state.tables.importfile[0].failurecount, 1);
  assert.match(h.store.state.tables.importlog[0].errordescription, /does not have create permissions to a secret secured field on entity contoso_widget/);
});

test("mapped lookup imports enforce AppendTo access instead of assigning inaccessible records directly", async (t) => {
  const h = await startServer({ roles: ["System Customizer"], extendState: (state) => {
    state.mappings.contoso_widget.fields.accountref = { dataverseType: "lookup", targets: ["account"] };
    state.mappings.contoso_widget.relationships.accountref = { entity: "account", from: "accountref", to: "accountid", many: false };
  } }); t.after(() => h.close());
  h.store.state.tables.account = [{ accountid: GONE, name: "Other owner's account", ownerid: IMPORT }];
  h.store.state.tables.importmap = [{ importmapid: IMPORT, name: "Lookup map" }];
  h.store.state.tables.columnmapping = [{ columnmappingid: IMPORT_FILE, importmapid: IMPORT, sourceattributename: "Account", targetattributename: "accountref", targetentityname: "contoso_widget", processcode: 1 }];
  h.store.state.tables.lookupmapping = [{ lookupmappingid: WIDGET, columnmappingid: IMPORT_FILE, lookupsourcecode: 1, lookupentityname: "account", lookupattributename: "name", processcode: 1 }];
  h.store.state.tables.import = [{ importid: IMPORT, name: "Lookup import" }];
  h.store.state.tables.importfile = [{ importfileid: IMPORT_FILE, importid: IMPORT, importmapid: IMPORT, targetentityname: "contoso_widget", processingstatus: 8, content: "Account\nOther owner's account\n", isfirstrowheader: true }];
  assert.equal((await h.send("POST", `/imports(${IMPORT})/${CRM}ImportRecordsImport`, {})).status, 200);
  await waitForStatus(h.store, 11);
  assert.equal(h.store.state.tables.contoso_widget.length, 1, "the refused lookup creates no partial record");
  assert.equal(h.store.state.tables.importfile[0].failurecount, 1);
  assert.match(h.store.state.tables.importlog[0].errordescription, /does not have AppendToAccess right\(s\) for record with ID aaaaaaaa-0000-0000-0000-0000000000b2 of entity account/);
});

test("parsed-file functions return headings, distinct pages and row collections, then refuse disposed parse data", async (t) => {
  const h = await startServer(); t.after(() => h.close());
  h.store.state.tables.importfile = [{ importfileid: IMPORT_FILE, processingstatus: 3, isfirstrowheader: true, content: 'Name\tStage\nFirst\tReady\nSecond\tReady\nThird\tDone\n', fielddelimitercode: 3 }];
  const base = `/importfiles(${IMPORT_FILE})/${CRM}`;
  assert.deepEqual((await (await h.get(base + "GetHeaderColumnsImportFile()")).json()).Columns, ["Name", "Stage"]);
  assert.deepEqual((await (await h.get(base + "GetDistinctValuesImportFile(columnNumber=2,pageNumber=2,recordsPerPage=1)")).json()).Values, ["Done"]);
  const paging = encodeURIComponent(JSON.stringify({ PageNumber: 2, Count: 1 }));
  const parsed = await h.get(`/RetrieveParsedDataImportFile(ImportFileId=${IMPORT_FILE},PagingInfo=@p)?@p=${paging}`);
  assert.equal(parsed.status, 200, JSON.stringify(await parsed.clone().json()));
  assert.deepEqual((await parsed.json()).Values, [{ Items: ["Second", "Ready"] }]);
  h.store.state.tables.importfile[0].processingstatus = 11;
  assert.equal((await h.get(base + "GetHeaderColumnsImportFile()")).status, 400);
  assert.deepEqual(parseCsv("'a;b';c\n", { delimiter: ";", quote: "'" }), [["a;b", "c"]]);
});

test("AutoMapEntity replaces stale mappings with matching names and types, and refuses an unknown map", async (t) => {
  const h = await startServer(); t.after(() => h.close());
  h.store.state.mappings.contoso_other = { logicalName: "contoso_other", entitySet: "contoso_others", idColumn: "contoso_otherid", fields: { name: { dataverseType: "nvarchar" }, status: { dataverseType: "nvarchar" } } };
  h.store.state.tables.entitymap = [{ entitymapid: IMPORT, sourceentityname: "contoso_widget", targetentityname: "contoso_other" }];
  h.store.state.tables.attributemap = [{ attributemapid: IMPORT_FILE, entitymapid: IMPORT, sourceattributename: "stale" }];
  assert.equal((await h.send("POST", "/AutoMapEntity", { EntityMapId: GONE })).status, 404);
  const mapped = await h.send("POST", "/AutoMapEntity", { EntityMapId: IMPORT }); assert.equal(mapped.status, 204, JSON.stringify(await mapped.clone().text()));
  assert.deepEqual(h.store.state.tables.attributemap.map((row) => [row.sourceattributename, row.targetattributename]), [["name", "name"]]);
  const basic = await startServer({ roles: ["Basic User"] }); t.after(() => basic.close());
  assert.equal((await basic.send("POST", "/AutoMapEntity", { EntityMapId: IMPORT })).status, 403);
  const customizer = await startServer({ roles: ["System Customizer"] }); t.after(() => customizer.close());
  customizer.store.state.tables.entitymap = [{ entitymapid: IMPORT, sourceentityname: "contoso_widget", targetentityname: "contoso_widget" }];
  assert.equal((await customizer.send("POST", "/AutoMapEntity", { EntityMapId: IMPORT })).status, 204);
});

test("signed note download works without an API bearer but minting and nonempty FileAttributeName are checked", async (t) => {
  const h = await startServer(); t.after(() => h.close());
  h.store.state.tables.annotation = [{ annotationid: IMPORT_FILE, filename: "note.txt", mimetype: "text/plain", documentbody: b64("anonymous download") }];
  const args = encodeURIComponent(JSON.stringify({ "@odata.id": `annotations(${IMPORT_FILE})` }));
  const mint = await h.get(`/GetFileSasUrl(Target=@t,FileAttributeName='')?@t=${args}`);
  assert.equal(mint.status, 200, JSON.stringify(await mint.clone().json()));
  const result = (await mint.json()).Result;
  const download = await fetch(result.SasUrl, { signal: AbortSignal.timeout(5000) });
  assert.equal(download.status, 200); assert.equal(await download.text(), "anonymous download");
  assert.equal((await h.get(`/GetFileSasUrl(Target=@t,FileAttributeName='documentbody')?@t=${args}`)).status, 400);
  const unauthenticated = await fetch(`${h.origin}${API}/GetFileSasUrl(Target=@t,FileAttributeName='')?@t=${args}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthenticated.status, 401);
});

test("a signed upload PUT reads its bounded anonymous request stream and commits to the target column", async (t) => {
  const h = await startServer({ extendState: (state) => { state.mappings.contoso_widget.fields.attachment = { dataverseType: "file", MaxSizeInKB: 1 }; } });
  t.after(() => h.close());
  const args = encodeURIComponent(JSON.stringify({ "@odata.id": `contoso_widgets(${WIDGET})` }));
  const minted = await h.get(`/GetFileSasUrlForUpload(Target=@t,FileAttributeName='attachment',FileName='stream.txt')?@t=${args}`);
  assert.equal(minted.status, 200, JSON.stringify(await minted.clone().json()));
  const { SasUrl, FileContinuationToken } = (await minted.json()).Result;
  const oversized = await fetch(SasUrl, { method: "PUT", body: Buffer.alloc(1025), signal: AbortSignal.timeout(5000) });
  assert.equal(oversized.status, 400);
  const uploaded = await fetch(SasUrl, { method: "PUT", body: Buffer.from("stream body"), signal: AbortSignal.timeout(5000) });
  assert.equal(uploaded.status, 201);
  const commit = await h.send("POST", "/CommitFileBlocksUpload", { FileName: "stream.txt", MimeType: "text/plain", FileContinuationToken, BlockList: [b64("sas")] });
  assert.equal(commit.status, 200, JSON.stringify(await commit.clone().json()));
  const stored = await h.get(`/contoso_widgets(${WIDGET})/attachment/$value`);
  assert.equal(stored.status, 200); assert.equal(await stored.text(), "stream body");
});

test("a cascade creates one bin snapshot, restores through the root Target, and preserves rows on a key conflict", async (t) => {
  const child = "eeeeeeee-0000-0000-0000-000000000001";
  const h = await startServer({ extendState: (state) => {
    state.mappings.contoso_widget.relationships.children = { entity: "contoso_part", from: "contoso_widgetid", to: "widgetid", many: true, cascade: { delete: "Cascade" } };
    state.mappings.contoso_part = { logicalName: "contoso_part", entitySet: "contoso_parts", idColumn: "contoso_partid", nameColumn: "name", fields: { name: { dataverseType: "nvarchar" }, widgetid: { dataverseType: "lookup", targets: ["contoso_widget"] } } };
    state.tables.contoso_part = [{ contoso_partid: child, name: "Part", widgetid: WIDGET }];
  } }); t.after(() => h.close());
  h.store.state.tables.recyclebinconfig = [{ name: "contoso_widget", statecode: 0, isreadyforrecyclebin: true }];
  assert.equal((await h.send("DELETE", `/contoso_widgets(${WIDGET})`)).status, 204);
  assert.equal(h.store.state.tables.deleteditemreference.length, 1);
  assert.equal(h.store.state.tables.deleteditemreference[0].totalrecords, 2);
  assert.equal(h.store.state.tables.contoso_part.length, 0);
  const query = '<fetch datasource="bin"><entity name="contoso_widget"><attribute name="name"/></entity></fetch>';
  const bin = await h.get(`/contoso_widgets?fetchXml=${encodeURIComponent(query)}`);
  assert.equal(bin.status, 200, JSON.stringify(await bin.clone().json()));
  assert.equal((await bin.json()).value[0].name, "alpha");
  assert.throws(() => h.store.fetchXml(query, { admin: true }), { code: "UnsupportedQuery", message: /Unsupported FetchXML datasource bin/ });
  h.store.state.tables.contoso_widget.push({ contoso_widgetid: WIDGET, name: "Conflict" });
  const conflict = await h.send("POST", "/Restore", { Target: target("contoso_widget", "contoso_widgetid", WIDGET) });
  assert.equal((await conflict.json()).error.code, "0x80049939");
  assert.equal(h.store.state.tables.contoso_part.length, 0);
  h.store.state.tables.contoso_widget = [];
  const restored = await h.send("POST", "/Restore", { Target: { "@odata.id": `contoso_widgets(${WIDGET})`, name: "Restored" } });
  assert.equal(restored.status, 200, JSON.stringify(await restored.clone().json()));
  assert.equal(h.store.state.tables.contoso_widget[0].name, "Restored");
  assert.equal(h.store.state.tables.contoso_part[0].contoso_partid, child);
  assert.equal(h.store.state.tables.deleteditemreference.length, 0);
});

test("retained export reads the separate datasource and internal retention events require an explicit pack", async (t) => {
  const h = await startServer(); t.after(() => h.close());
  h.store.state.dataverse.retained = { contoso_widget: [{ contoso_widgetid: GONE, name: "Archived" }] };
  const response = await h.send("POST", "/ExportRetainedData", { FetchXml: '<fetch><entity name="contoso_widget"><attribute name="name"/></entity></fetch>', LayoutXml: "" });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const id = (await response.json()).ExportedExcelId;
  const workbook = Buffer.from(h.store.state.tables.retaineddataexcel.find((row) => row.retaineddataexcelid === id).excelcontent, "base64").toString();
  assert.match(workbook, /Archived/); assert.doesNotMatch(workbook, /alpha/);
  for (const name of ["BulkRetain", "Retain", "PurgeRetainedContent", "RollbackRetain", "ValidateRetentionConfig"]) {
    const unsupported = await h.send("POST", `/${name}`, {});
    assert.equal(unsupported.status, 501, name);
    assert.equal((await unsupported.json()).error.code, "0x80040216");
  }
  const packed = await startServer({ extraExtensions: [{ name: "test-retention-pack", install: (api) => { api.addonHandlers = new Map([["Retain", { handler: () => ({ EntityCountCollection: { Count: 1 } }) }]]); } }] });
  t.after(() => packed.close());
  assert.equal((await packed.send("POST", "/Retain", {})).status, 200);
});

test("Restore distinguishes alternate-key, removed-choice and missing-lookup conflicts without consuming its snapshot", async (t) => {
  const h = await startServer({ extendState: (state) => {
    state.mappings.contoso_widget.alternateKeys = [{ name: "widget_name", attributes: ["name"] }];
    state.mappings.contoso_widget.fields.status = { dataverseType: "picklist", options: [{ value: 1, label: "Ready" }] };
    state.mappings.contoso_widget.fields.parentid = { dataverseType: "lookup", targets: ["contoso_parent"] };
    state.mappings.contoso_parent = { logicalName: "contoso_parent", entitySet: "contoso_parents", idColumn: "contoso_parentid", fields: { name: { dataverseType: "nvarchar" } } };
    state.tables.contoso_parent = [{ contoso_parentid: IMPORT, name: "Parent" }];
    state.tables.contoso_widget[0].parentid = IMPORT;
    state.tables.recyclebinconfig = [{ name: "contoso_widget", statecode: 0, isreadyforrecyclebin: true }];
  } }); t.after(() => h.close());
  await h.send("DELETE", `/contoso_widgets(${WIDGET})`);
  const restore = async () => (await (await h.send("POST", "/Restore", { Target: target("contoso_widget", "contoso_widgetid", WIDGET) })).json()).error?.code;
  h.store.state.tables.contoso_widget.push({ contoso_widgetid: GONE, name: "alpha" });
  assert.equal(await restore(), "0x80049929");
  h.store.state.tables.contoso_widget = [];
  h.store.state.mappings.contoso_widget.fields.status.options = [{ value: 2, label: "Other" }];
  assert.equal(await restore(), "0x80049949");
  h.store.state.mappings.contoso_widget.fields.status.options = [{ value: 1, label: "Ready" }];
  h.store.state.tables.contoso_parent = [];
  assert.equal(await restore(), "0x80049959");
  assert.equal(h.store.state.tables.deleteditemreference.length, 1);
  assert.equal(h.store.state.tables.contoso_widget.length, 0);
  h.store.state.tables.contoso_parent = [{ contoso_parentid: IMPORT, name: "Parent" }];
  assert.equal(await restore(), undefined);
  assert.equal(h.store.state.tables.contoso_widget[0].parentid, IMPORT);
  assert.equal(h.store.state.tables.deleteditemreference.length, 0);
});

test("retained FetchXML applies the caller's record ownership filter", async (t) => {
  const h = await startServer({ roles: ["Basic User"], extendState: (state) => { state.mappings.contoso_widget.ownership = "UserOwned"; } });
  t.after(() => h.close());
  const user = (await (await h.get("/WhoAmI")).json()).UserId;
  h.store.state.dataverse.retained = { contoso_widget: [{ contoso_widgetid: WIDGET, name: "Own retained", ownerid: user }, { contoso_widgetid: GONE, name: "Other retained", ownerid: IMPORT }] };
  const xml = '<fetch datasource="retained"><entity name="contoso_widget"><attribute name="name"/></entity></fetch>';
  const result = await h.get(`/contoso_widgets?fetchXml=${encodeURIComponent(xml)}`);
  assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
  assert.deepEqual((await result.json()).value.map((row) => row.name), ["Own retained"]);
});

test("retained FetchXML refuses joins and aggregates while the ordinary portal query remains valid", async (t) => {
  const h = await startServer(); t.after(() => h.close());
  h.store.state.dataverse.retained = { contoso_widget: [{ contoso_widgetid: WIDGET, name: "Archived" }] };
  const joined = '<fetch datasource="retained"><entity name="contoso_widget"><attribute name="name"/><link-entity name="contoso_widget" from="contoso_widgetid" to="contoso_widgetid" alias="peer"><attribute name="name"/></link-entity></entity></fetch>';
  const aggregate = '<fetch datasource="retained" aggregate="true"><entity name="contoso_widget"><attribute name="contoso_widgetid" aggregate="count" alias="count"/></entity></fetch>';
  for (const xml of [joined, aggregate]) {
    const result = await h.get(`/contoso_widgets?fetchXml=${encodeURIComponent(xml)}`);
    assert.equal(result.status, 400);
    assert.match((await result.json()).error.message, /one table only/);
    assert.equal((await h.send("POST", "/ExportRetainedData", { FetchXml: xml })).status, 400);
  }
  const portal = h.store.fetchXml(joined.replace(' datasource="retained"', ""), { admin: true });
  assert.equal(portal.entities.length, 1);
  assert.equal(h.store.fetchXml(joined, { admin: true }).entities.length, 0, "portal retained continues to return an empty collection");
});

// Polls until an asynchronous import file reaches the expected processing status.
async function waitForStatus(store, status) {
  for (let i = 0; i < 200; i++) {
    if ((store.state.tables.importfile ?? [])[0]?.processingstatus === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`import file did not reach processingstatus ${status}`);
}

test("recycle eligibility excludes exact elastic and virtual table types", async t => {
  const h = await startServer({ extendState: state => {
    for (const [name, tableType] of Object.entries({ x_standard: 'Standard', x_elastic: 'Elastic', x_virtual: 'Virtual', x_elasticity: 'Elasticity', x_nonvirtual: 'Nonvirtual' })) {
      state.mappings[name] = { ...state.mappings.contoso_widget, logicalName: name, entitySet: `${name}s`, tableType };
      state.tables[name] = [];
    }
  } });
  t.after(() => h.close());
  const response = await h.send('POST', '/GetEntitiesEligibleForRecycleBin', {});
  assert.equal(response.status, 200);
  const names = JSON.parse((await response.json()).Result);
  for (const name of ['x_standard', 'x_elasticity', 'x_nonvirtual']) assert.ok(names.includes(name), name);
  for (const name of ['x_elastic', 'x_virtual']) assert.equal(names.includes(name), false, name);
});

describe("recycle bin: delete hook, Restore and EmptyRecycleBin", () => {
  let h;
  before(async () => {
    h = await startServer();
    h.store.state.tables.recyclebinconfig = [{ recyclebinconfigid: "cccccccc-0000-0000-0000-000000000001", name: "contoso_widget", statecode: 0, isreadyforrecyclebin: true }];
  });
  after(async () => h?.close());

  it("a delete of an enabled table writes a deleteditemreference that Restore turns back into the row under its original id", async () => {
    const deleted = await h.send("DELETE", `/contoso_widgets(${WIDGET})`);
    assert.equal(deleted.status, 204);
    const refs = h.store.state.tables.deleteditemreference;
    assert.equal(refs.length, 1);
    assert.equal(refs[0].deletedobject, WIDGET);
    assert.equal(refs[0].deletedobjectidtype, "contoso_widget");
    assert.equal(refs[0].validforrestore, true);
    const snapshot = JSON.parse(Buffer.from(h.store.state.dataverse.files[refs[0].deletedrecords].data, "base64").toString("utf8"));
    assert.equal(snapshot[0].row.name, "alpha");
    assert.equal(h.store.state.tables.contoso_widget.length, 0);

    const ref = refs[0].deleteditemreferenceid;
    const response = await h.send("POST", "/Restore", { Target: target("deleteditemreference", "deleteditemreferenceid", ref) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, WIDGET);
    assert.equal(h.store.state.tables.contoso_widget[0].contoso_widgetid, WIDGET);
    assert.equal(h.store.state.tables.contoso_widget[0].name, "alpha");
    assert.equal(h.store.state.tables.deleteditemreference.length, 0);
    assert.equal(Object.keys(h.store.state.dataverse.files).length, 0);
  });

  it("Restore answers 404 for an unknown reference and 400 when the reference is not restorable", async () => {
    const missing = await h.send("POST", "/Restore", { Target: target("deleteditemreference", "deleteditemreferenceid", GONE) });
    assert.equal(missing.status, 404);
    h.store.state.tables.deleteditemreference = [{ deleteditemreferenceid: GONE, deletedobject: WIDGET, deletedobjectidtype: "contoso_widget", validforrestore: false }];
    const refused = await h.send("POST", "/Restore", { Target: target("deleteditemreference", "deleteditemreferenceid", GONE) });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.code, "0x80040203");
    h.store.state.tables.deleteditemreference = [];
  });

  it("a delete of a table that is not recycled writes no reference", async () => {
    h.store.state.tables.recyclebinconfig[0].statecode = 1;
    h.store.state.tables.contoso_widget.push({ contoso_widgetid: GONE, name: "beta", status: 2 });
    const response = await h.send("DELETE", `/contoso_widgets(${GONE})`);
    assert.equal(response.status, 204);
    assert.equal(h.store.state.tables.deleteditemreference.length, 0);
    h.store.state.tables.recyclebinconfig[0].statecode = 0;
  });

  it("EmptyRecycleBin deletes every reference and answers the count", async () => {
    h.store.state.tables.contoso_widget.push({ contoso_widgetid: GONE, name: "beta", status: 2 });
    assert.equal((await h.send("DELETE", `/contoso_widgets(${GONE})`)).status, 204);
    assert.equal(h.store.state.tables.deleteditemreference.length, 1);
    const response = await h.send("POST", "/EmptyRecycleBin", {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).DeletedCount, 1);
    assert.equal(h.store.state.tables.deleteditemreference.length, 0);
    assert.equal(Object.keys(h.store.state.dataverse.files ?? {}).length, 0);
  });
});

describe("import: ParseImport, TransformImport and ImportRecordsImport", () => {
  let h;
  before(async () => {
    h = await startServer();
    h.store.state.tables.import = [{ importid: IMPORT, name: "Invented import", modecode: 0 }];
    h.store.state.tables.importfile = [{
      importfileid: IMPORT_FILE, importid: IMPORT, name: "widgets.csv", isfirstrowheader: true, processingstatus: 1,
      targetentityname: "contoso_widget", content: 'name,status\nGamma,3\n"Delta, Inc",4\n',
    }];
  });
  after(async () => h?.close());

  it("the CSV reader handles quotes, doubled quotes and CRLF line ends", () => {
    assert.deepEqual(parseCsv('a,"b, c"\r\n"x ""y""",2\n'), [["a", "b, c"], ['x "y"', "2"]]);
  });

  it("parse, transform and import create the rows and finish the file as Import Complete", async () => {
    const parsed = await h.send("POST", `/imports(${IMPORT})/Microsoft.Dynamics.CRM.ParseImport`, {});
    assert.equal(parsed.status, 200);
    assert.ok((await parsed.json()).asyncoperationid);
    await waitForStatus(h.store, 3);
    assert.equal(h.store.state.tables.importfile[0].totalcount, 2);
    assert.equal(h.store.state.tables.importfile[0].headerrow, "name,status");

    assert.equal((await h.send("POST", "/TransformImport", { ImportId: IMPORT })).status, 200);
    await waitForStatus(h.store, 8);

    assert.equal((await h.send("POST", `/imports(${IMPORT})/Microsoft.Dynamics.CRM.ImportRecordsImport`, {})).status, 200);
    await waitForStatus(h.store, 11);
    const file = h.store.state.tables.importfile[0];
    assert.equal(file.successcount, 2);
    assert.equal(file.failurecount, 0);
    const names = h.store.state.tables.contoso_widget.map((r) => r.name).sort();
    assert.deepEqual(names, ["Delta, Inc", "Gamma", "alpha"]);
  });

  it("an import with no file is refused", async () => {
    const other = "bbbbbbbb-0000-0000-0000-0000000000d1";
    h.store.state.tables.import.push({ importid: other, name: "Empty import" });
    const none = await h.send("POST", `/imports(${other})/Microsoft.Dynamics.CRM.ParseImport`, {});
    assert.equal(none.status, 400);
  });
});

describe("annotation and attachment blocks: chunked upload and download", () => {
  let h;
  before(async () => {
    h = await startServer();
    h.store.state.tables.annotation = [];
    h.store.state.tables.activitymimeattachment = [];
  });
  after(async () => h?.close());

  async function uploadInBlocks(initialize, commit, regarding, chunks) {
    const init = await h.send("POST", `/${initialize}`, { Target: regarding });
    assert.equal(init.status, 200);
    const token = (await init.json()).FileContinuationToken;
    const ids = chunks.map((_, i) => b64(`block-${i}-id`));
    for (let i = 0; i < chunks.length; i++) {
      const block = await h.send("POST", "/UploadBlock", { BlockId: ids[i], BlockData: b64(chunks[i]), FileContinuationToken: token });
      assert.equal(block.status, 204);
    }
    return h.send("POST", `/${commit}`, { BlockList: ids, FileContinuationToken: token, FileName: "notes.txt" });
  }

  it("an attachment uploads in chunks, commits as a new row and downloads back in ranges", async () => {
    const regarding = target("contoso_widget", "contoso_widgetid", WIDGET);
    const commit = await uploadInBlocks("InitializeAttachmentBlocksUpload", "CommitAttachmentBlocksUpload", regarding, ["hello ", "world"]);
    assert.equal(commit.status, 200);
    const answer = await commit.json();
    assert.equal(answer.FileSizeInBytes, 11);
    const row = h.store.state.tables.activitymimeattachment[0];
    assert.equal(row.activitymimeattachmentid, answer.ActivityMimeAttachmentId);
    assert.equal(row.body, b64("hello world"));
    assert.equal(row.objectid?.id ?? row.objectid, WIDGET);

    const init = await h.send("POST", "/InitializeAttachmentBlocksDownload", {
      Target: target("activitymimeattachment", "activitymimeattachmentid", row.activitymimeattachmentid),
    });
    assert.equal(init.status, 200);
    const download = await init.json();
    assert.equal(download.FileSizeInBytes, 11);
    assert.equal(download.FileName, "notes.txt");
    const block = await h.send("POST", "/DownloadBlock", { Offset: 6, BlockLength: 5, FileContinuationToken: download.FileContinuationToken });
    assert.equal(Buffer.from((await block.json()).Data, "base64").toString("utf8"), "world");
  });

  it("an annotation uploads and commits as a new note, and its bytes download back", async () => {
    const regarding = target("contoso_widget", "contoso_widgetid", WIDGET);
    const commit = await uploadInBlocks("InitializeAnnotationBlocksUpload", "CommitAnnotationBlocksUpload", regarding, ["note body"]);
    assert.equal(commit.status, 200);
    const { AnnotationId } = await commit.json();
    const row = h.store.state.tables.annotation.find((r) => r.annotationid === AnnotationId);
    assert.equal(row.documentbody, b64("note body"));
    const init = await h.send("POST", "/InitializeAnnotationBlocksDownload", { Target: target("annotation", "annotationid", AnnotationId) });
    const download = await init.json();
    const block = await h.send("POST", "/DownloadBlock", { Offset: 0, BlockLength: 64, FileContinuationToken: download.FileContinuationToken });
    assert.equal(Buffer.from((await block.json()).Data, "base64").toString("utf8"), "note body");
  });

  it("an upload over organization.maxuploadfilesize answers the attachment size error", async () => {
    const previous = h.store.state.tables.organization;
    h.store.state.tables.organization = [
      { organizationid: ORG, maxuploadfilesize: 1024 },
      { organizationid: h.store.state.dataverse.organizationId, maxuploadfilesize: 8 },
    ];
    const regarding = target("contoso_widget", "contoso_widgetid", WIDGET);
    const init = await h.send("POST", "/InitializeAttachmentBlocksUpload", { Target: regarding });
    const token = (await init.json()).FileContinuationToken;
    const block = await h.send("POST", "/UploadBlock", { BlockId: b64("big-id"), BlockData: b64("0123456789"), FileContinuationToken: token });
    assert.equal(block.status, 400);
    const error = (await block.json()).error;
    assert.equal(error.message, "Attachment file size is too big.");
    assert.equal(error.code, "0x80044a02");
    h.store.state.tables.organization = previous;
  });
});

// Cascade deletes: a Dataverse delete hands the deleted rows to store.recycleDeleted (children first, root last); a portal delete never does.
describe("cascade delete: recycle hand-off is Dataverse-only", () => {
  const PARENT = "aaaaaaaa-0000-0000-0000-0000000000d1";
  const CHILD = "aaaaaaaa-0000-0000-0000-0000000000d2";
  const ADMIN = { admin: true };
  const DATAVERSE = { admin: true, dataverse: { callerId: "aaaaaaaa-0000-0000-0000-0000000000d9" } };
  const CHILDREN = '<fetch><entity name="contoso_part"><attribute name="name"/></entity></fetch>';

  async function cascadeStore() {
    const state = emptyState();
    state.mappings.contoso_widget = {
      logicalName: "contoso_widget", entitySet: "contoso_widgets", idColumn: "contoso_widgetid",
      fields: { name: { dataverseType: "nvarchar" } },
      relationships: { contoso_part_widget: { entity: "contoso_part", from: "contoso_widgetid", to: "contoso_widgetref", many: true, cascade: { delete: "Cascade" } } },
    };
    state.mappings.contoso_part = { logicalName: "contoso_part", entitySet: "contoso_parts", idColumn: "contoso_partid", fields: { name: { dataverseType: "nvarchar" } } };
    state.tables.contoso_widget = [{ contoso_widgetid: PARENT, name: "parent" }];
    state.tables.contoso_part = [{ contoso_partid: CHILD, name: "child", contoso_widgetref: PARENT }];
    return new DataStore({ state }).init();
  }

  it("a Dataverse cascade delete hands the children, then the parent, to recycleDeleted", async () => {
    const s = await cascadeStore();
    const handed = [];
    s.recycleDeleted = (entries, identity) => handed.push({ entries, identity });
    const returned = await s.remove("contoso_widget", PARENT, DATAVERSE, {});
    assert.equal(returned.name, "parent");
    assert.deepEqual(s.state.tables.contoso_part, []);
    assert.equal(handed.length, 1);
    assert.deepEqual(handed[0].entries.map((e) => e.logicalName), ["contoso_part", "contoso_widget"]);
    assert.equal(handed[0].entries[0].row.name, "child");
    assert.equal(handed[0].entries[1].row.name, "parent");
    assert.equal(handed[0].identity, DATAVERSE);
  });

  it("a portal cascade delete returns and cascades as before, and never reaches recycleDeleted", async () => {
    const s = await cascadeStore();
    const handed = [];
    s.recycleDeleted = (entries) => handed.push(entries);
    assert.equal(s.fetchXml(CHILDREN, ADMIN).entities.length, 1, "the child is readable before the delete");
    const returned = await s.remove("contoso_widget", PARENT, ADMIN, {});
    assert.equal(returned.name, "parent");
    assert.deepEqual(s.state.tables.contoso_part, []);
    assert.deepEqual(s.state.tables.contoso_widget, []);
    assert.equal(s.fetchXml(CHILDREN, ADMIN).entities.length, 0, "a portal FetchXML read after the cascade finds no child");
    assert.deepEqual(handed, []);
  });
});
