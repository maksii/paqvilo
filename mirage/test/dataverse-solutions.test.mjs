// Solution export and import over the Dataverse Web API.
// Round trip: a solution built from metadata writes that name it in MSCRM.SolutionUniqueName is exported, then imported into a
// fresh simulator, where the table, columns, option set and relationship exist and the Web API creates a row in the table.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { readSolutionZip } from "../lib/solution-schema.mjs";
import { zipOf, solutionImportJob } from "../lib/dataverse-solutions.mjs";
import { componentObjectId } from "../lib/dataverse-metadata-relationships.mjs";
import { dataverseOrganizationId } from "../lib/dataverse-organization.mjs";
import { uuidV5 } from "../lib/dataverse-security.mjs";

const APP_ID = "55555555-5555-4555-8555-555555555555";
const CLERK_APP_ID = "66666666-6666-4666-8666-666666666666";
const SOLUTION = "new_samplesolution";
// The organization every default-settings server runs as; a metadata component id is its MetadataId in it.
const ORG = dataverseOrganizationId(dataverseSettings({ enabled: true }));
const PUBLISHER = "new_samplepublisher";
const SOLUTION_HEADER = { "MSCRM.SolutionUniqueName": SOLUTION };
const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
const column = (type, schema, extra = {}) => ({ "@odata.type": `#Microsoft.Dynamics.CRM.${type}AttributeMetadata`, SchemaName: schema, DisplayName: label(schema), ...extra });
const primaryName = () => column("String", "new_Name", { IsPrimaryName: true, MaxLength: 100, FormatName: { Value: "Text" } });
const tableBody = (schema, extra = {}) => ({
  "@odata.type": "#Microsoft.Dynamics.CRM.EntityMetadata",
  SchemaName: schema,
  DisplayName: label(schema.replace("new_", "Sample ")),
  DisplayCollectionName: label(`${schema} records`),
  Description: label(""),
  OwnershipType: "OrganizationOwned",
  IsActivity: false,
  HasActivities: false,
  HasNotes: false,
  Attributes: [primaryName()],
  ...extra,
});

let counter = 0;
// One loopback server with an application user holding the given role. capture receives the api object.
async function startServer({ roles = ["System Administrator"], appId = APP_ID } = {}) {
  const secretVariable = `PAQVILO_SOLUTIONS_TEST_SECRET_${++counter}`;
  process.env[secretVariable] = "test-secret-value";
  const store = await new DataStore({ state: emptyState() }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [{ appId, displayName: "Solutions test app", secretEnvironmentVariable: secretVariable, roles }],
  });
  const captured = {};
  const capture = { name: "dataverse-solutions-test-capture", install(api) { captured.api = api; } };
  const server = await startDataverseApi({ store, settings, extensions: [...EXTENSIONS, capture], log: () => {} });
  const token = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: appId, client_secret: process.env[secretVariable], scope: `${server.origin}/.default` }),
  });
  const authorization = `Bearer ${(await token.json()).access_token}`;
  const base = `${server.origin}/api/data/v9.2`;
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization, "content-type": "application/json", accept: "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  };
  return {
    server, store, api: captured.api, request,
    close: async () => {
      delete process.env[secretVariable];
      await server.close();
    },
  };
}

const idOf = (response) => /\(([0-9a-f-]{36})\)/i.exec(response.headers.get("odata-entityid") ?? "")?.[1];
const rowsOf = (store, table) => store.state.tables[table] ?? [];

// Builds the source solution through the metadata API: a table, a text and a picklist column, a global option set and a lookup.
async function buildSourceSolution(source) {
  const { request } = source;
  const publisher = await request("POST", "/publishers", { uniquename: PUBLISHER, friendlyname: "Sample Publisher", customizationprefix: "new", customizationoptionvalueprefix: 10000 });
  assert.equal(publisher.status, 204, JSON.stringify(publisher.json));
  const publisherId = idOf(publisher) ?? (await request("GET", `/publishers?$select=publisherid&$filter=uniquename eq '${PUBLISHER}'`)).json.value[0].publisherid;
  const created = await request("POST", "/solutions", { uniquename: SOLUTION, friendlyname: "Sample Solution", version: "1.0.0.0", "publisherid@odata.bind": `/publishers(${publisherId})` });
  assert.equal(created.status, 204, JSON.stringify(created.json));

  const set = await request("POST", "/GlobalOptionSetDefinitions", {
    "@odata.type": "#Microsoft.Dynamics.CRM.OptionSetMetadata", Name: "new_tier", DisplayName: label("Tier"),
    Options: [{ Value: 100000000, Label: label("Gold") }, { Value: 100000001, Label: label("Silver") }],
  }, SOLUTION_HEADER);
  assert.equal(set.status, 204, JSON.stringify(set.json));

  const widget = await request("POST", "/EntityDefinitions", tableBody("new_widget"), SOLUTION_HEADER);
  assert.equal(widget.status, 204, JSON.stringify(widget.json));
  const code = await request("POST", "/EntityDefinitions(LogicalName='new_widget')/Attributes", column("String", "new_Code", { MaxLength: 20, FormatName: { Value: "Text" } }), SOLUTION_HEADER);
  assert.equal(code.status, 204, JSON.stringify(code.json));
  const tier = await request("POST", "/EntityDefinitions(LogicalName='new_widget')/Attributes", {
    ...column("Picklist", "new_Tier"), "GlobalOptionSet@odata.bind": "GlobalOptionSetDefinitions(Name='new_tier')",
  }, SOLUTION_HEADER);
  assert.equal(tier.status, 204, JSON.stringify(tier.json));

  const category = await request("POST", "/EntityDefinitions", tableBody("new_category"), SOLUTION_HEADER);
  assert.equal(category.status, 204, JSON.stringify(category.json));
  const relationship = await request("POST", "/RelationshipDefinitions", {
    "@odata.type": "#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
    SchemaName: "new_widget_category",
    ReferencedEntity: "new_category",
    ReferencingEntity: "new_widget",
    ReferencedAttribute: "new_categoryid",
    ReferencedEntityNavigationPropertyName: "new_widget_category_ref",
    ReferencingEntityNavigationPropertyName: "new_category",
    Lookup: column("Lookup", "new_CategoryId", { Description: label("") }),
  }, SOLUTION_HEADER);
  assert.equal(relationship.status, 204, JSON.stringify(relationship.json));

  // A table created without the header is not part of the solution.
  const loose = await request("POST", "/EntityDefinitions", tableBody("new_loose"));
  assert.equal(loose.status, 204, JSON.stringify(loose.json));
}

function exportedArchive(json) {
  return Buffer.from(json.ExportSolutionFile, "base64");
}

describe("Solution export and import", { concurrency: false }, () => {
  let source, target, fresh;
  let archive;

  before(async () => {
    source = await startServer();
    await buildSourceSolution(source);
    const exported = await source.request("POST", "/ExportSolution", { SolutionName: SOLUTION, Managed: false });
    assert.equal(exported.status, 200, JSON.stringify(exported.json));
    archive = exportedArchive(exported.json);
  });

  after(async () => {
    for (const s of [source, target, fresh]) await s?.close();
  });

  it("exports a zip of the solution's components only", () => {
    const docs = readSolutionZip(archive);
    const names = docs.map((doc) => doc.name).sort();
    assert.deepEqual(names, ["customizations.xml", "solution.xml"]);
    const customizations = docs.find((doc) => doc.name === "customizations.xml").xml;
    assert.match(customizations, /<entity Name="new_widget">/);
    assert.match(customizations, /<entity Name="new_category">/);
    assert.match(customizations, /PhysicalName="new_Code"/);
    assert.match(customizations, /<OptionSetName>new_tier<\/OptionSetName>/);
    assert.match(customizations, /<EntityRelationship Name="new_widget_category">/);
    assert.doesNotMatch(customizations, /new_loose/, "a table created without the solution header is not exported");
    const manifest = docs.find((doc) => doc.name === "solution.xml").xml;
    assert.match(manifest, /<UniqueName>new_samplesolution<\/UniqueName>/);
    assert.match(manifest, /<CustomizationPrefix>new<\/CustomizationPrefix>/);
    assert.match(manifest, /<Managed>0<\/Managed>/);
  });

  it("imports into a fresh simulator: table, columns, option set, relationship, and a row can be created", async () => {
    target = await startServer();
    const imported = await target.request("POST", "/ImportSolution", { CustomizationFile: archive.toString("base64"), OverwriteUnmanagedCustomizations: false, PublishWorkflows: true });
    assert.equal(imported.status, 204, JSON.stringify(imported.json));

    const mappings = target.store.state.mappings;
    assert.ok(mappings.new_widget, "table new_widget exists");
    assert.ok(mappings.new_widget.fields.new_code, "text column exists");
    assert.equal(mappings.new_widget.nameColumn, "new_name");
    assert.equal(target.store.state.dataverse.globalOptionSets.new_tier.options.length, 2);
    assert.equal(mappings.new_widget.fields.new_tier.globalOptionSet, "new_tier");
    assert.ok(Object.values(mappings.new_widget.relationships).some((rel) => rel.schemaName === "new_widget_category"), "relationship exists");
    assert.equal(rowsOf(target.store, "solution").find((row) => row.uniquename === SOLUTION)?.version, "1.0.0.0");
    assert.equal(rowsOf(target.store, "publisher").find((row) => row.uniquename === PUBLISHER)?.customizationprefix, "new");
    const job = rowsOf(target.store, "importjob").at(-1);
    assert.equal(job.progress, 100);
    assert.match(job.data, /result="succeeded"/);

    const category = await target.request("POST", "/new_categories", { new_name: "Hardware" });
    assert.equal(category.status, 204, JSON.stringify(category.json));
    const categoryId = idOf(category) ?? rowsOf(target.store, "new_category")[0].new_categoryid;
    const widget = await target.request("POST", "/new_widgets", { new_name: "Alpha", new_code: "A-1", "new_category@odata.bind": `/new_categories(${categoryId})` });
    assert.equal(widget.status, 204, JSON.stringify(widget.json));
    const read = await target.request("GET", `/new_widgets(${idOf(widget)})?$select=new_name,new_code`);
    assert.equal(read.json.new_name, "Alpha");
    assert.equal(read.json.new_code, "A-1");
  });

  it("rolls back a failed import completely", async () => {
    fresh = await startServer();
    // The same customizations with a table that has no text primary name appended last: the earlier components must not survive.
    const docs = readSolutionZip(archive);
    const broken = docs.find((doc) => doc.name === "customizations.xml").xml.replace(
      "</Entities>",
      '<Entity><EntityInfo><entity Name="new_broken"><attributes><attribute PhysicalName="new_Code"><LogicalName>new_code</LogicalName><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity></Entities>',
    );
    const zip = zipOf([
      { name: "solution.xml", data: Buffer.from(docs.find((doc) => doc.name === "solution.xml").xml, "utf8") },
      { name: "customizations.xml", data: Buffer.from(broken, "utf8") },
    ]);
    const failed = await fresh.request("POST", "/ImportSolution", { CustomizationFile: zip.toString("base64") });
    assert.equal(failed.status, 400, JSON.stringify(failed.json));
    assert.equal(fresh.store.state.mappings.new_widget, undefined);
    assert.equal(fresh.store.state.mappings.new_category, undefined);
    assert.equal(fresh.store.state.mappings.new_broken, undefined);
    assert.equal(fresh.store.state.dataverse?.globalOptionSets?.new_tier, undefined);
    assert.equal(rowsOf(fresh.store, "solution").length, 0, "no solution row for a failed import");
    assert.match(rowsOf(fresh.store, "importjob").at(-1).data, /result="failed"/);
  });

  it("ImportSolutionAsync returns an AsyncOperationId and completes the job", async () => {
    const asyncTarget = await startServer();
    try {
      const started = await asyncTarget.request("POST", "/ImportSolutionAsync", { CustomizationFile: archive.toString("base64") });
      assert.equal(started.status, 200, JSON.stringify(started.json));
      const { AsyncOperationId, ImportJobKey } = started.json;
      assert.match(AsyncOperationId, /^[0-9a-f-]{36}$/);
      await solutionImportJob(asyncTarget.api, AsyncOperationId);
      const operation = rowsOf(asyncTarget.store, "asyncoperation").find((row) => row.asyncoperationid === AsyncOperationId);
      assert.equal(operation.statecode, 3);
      assert.equal(operation.statuscode, 30);
      assert.ok(asyncTarget.store.state.mappings.new_widget, "the asynchronous import created the table");
      const job = rowsOf(asyncTarget.store, "importjob").find((row) => row.importjobid === ImportJobKey);
      assert.equal(job.progress, 100);
    } finally {
      await asyncTarget.close();
    }
  });

  it("requires prvImportCustomization and prvExportCustomization", async () => {
    const clerk = await startServer({ roles: ["Basic User"], appId: CLERK_APP_ID });
    try {
      const imported = await clerk.request("POST", "/ImportSolution", { CustomizationFile: archive.toString("base64") });
      assert.equal(imported.status, 403, JSON.stringify(imported.json));
      const exported = await clerk.request("POST", "/ExportSolution", { SolutionName: SOLUTION });
      assert.equal(exported.status, 403, JSON.stringify(exported.json));
    } finally {
      await clerk.close();
    }
  });

  it("refuses to export an unknown solution", async () => {
    const response = await source.request("POST", "/ExportSolution", { SolutionName: "new_nosuchsolution" });
    assert.equal(response.status, 404, JSON.stringify(response.json));
  });

  it("zipOf output reads back through the Solution reader", () => {
    const zip = zipOf([{ name: "solution.xml", data: Buffer.from("<ImportExportXml />", "utf8") }]);
    const docs = readSolutionZip(zip);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].xml, "<ImportExportXml />");
  });
});

// Solution component messages and dependency functions, on the same source solution.
describe("Solution component messages", { concurrency: false }, () => {
  let source;
  const componentId = (kind, logical, name = null) => componentObjectId({ kind, logical, name }, ORG);
  const dependencyRows = (json) => json.value;

  before(async () => {
    source = await startServer();
    await buildSourceSolution(source);
  });
  after(async () => {
    await source?.close();
  });

  it("AddSolutionComponent adds a table to the solution, and RemoveSolutionComponent takes it out again", async () => {
    const id = componentId("entity", "new_loose");
    const added = await source.request("POST", "/AddSolutionComponent", { ComponentId: id, ComponentType: 1, SolutionUniqueName: SOLUTION, AddRequiredComponents: false });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    assert.match(added.json.id ?? "", /^[0-9a-f-]{36}$/);
    const solution = rowsOf(source.store, "solution").find((row) => row.uniquename === SOLUTION);
    const member = rowsOf(source.store, "solutioncomponent").find((row) => row.solutionid === solution.solutionid && row.objectid === id);
    assert.equal(member?.componenttype, 1, "a solutioncomponent row of type Entity");
    assert.equal(rowsOf(source.store, "solutioncomponent").some((row) => row.objectid === id && row.solutionid === rowsOf(source.store, "solution").find((s) => s.uniquename === "Default")?.solutionid), false, "AddSolutionComponent does not add the Default solution");
    const exported = readSolutionZip(exportedArchive((await source.request("POST", "/ExportSolution", { SolutionName: SOLUTION })).json));
    assert.match(exported.find((doc) => doc.name === "customizations.xml").xml, /<entity Name="new_loose">/);

    const removed = await source.request("POST", "/RemoveSolutionComponent", { SolutionComponent: { solutioncomponentid: member.solutioncomponentid }, ComponentType: 1, SolutionUniqueName: SOLUTION });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(rowsOf(source.store, "solutioncomponent").some((row) => row.solutioncomponentid === member.solutioncomponentid), false);
    const again = await source.request("POST", "/RemoveSolutionComponent", { SolutionComponent: { solutioncomponentid: member.solutioncomponentid }, ComponentType: 1, SolutionUniqueName: SOLUTION });
    assert.equal(again.status, 404, "removing a component twice is refused");
  });

  it("AddSolutionComponent refuses an unknown component and an unknown solution", async () => {
    const unknown = await source.request("POST", "/AddSolutionComponent", { ComponentId: "00000000-0000-4000-8000-000000000001", ComponentType: 1, SolutionUniqueName: SOLUTION });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
    const noSolution = await source.request("POST", "/AddSolutionComponent", { ComponentId: componentId("entity", "new_widget"), ComponentType: 1, SolutionUniqueName: "new_nosuchsolution" });
    assert.equal(noSolution.status, 404, JSON.stringify(noSolution.json));
  });

  // AddSolutionComponentRequest.ComponentId: for MetadataBase components the component id is the MetadataId.
  it("AddSolutionComponent takes the MetadataId the table definition returns and refuses the old generated component id", async () => {
    const metadataId = (await source.request("GET", "/EntityDefinitions(LogicalName='new_loose')?$select=MetadataId")).json.MetadataId;
    const publisherId = (await source.request("GET", `/publishers?$select=publisherid&$filter=uniquename eq '${PUBLISHER}'`)).json.value[0].publisherid;
    await source.request("POST", "/solutions", { uniquename: "new_idsolution", friendlyname: "Id solution", version: "1.0.0.0", "publisherid@odata.bind": `/publishers(${publisherId})` });
    const added = await source.request("POST", "/AddSolutionComponent", { ComponentId: metadataId, ComponentType: 1, SolutionUniqueName: "new_idsolution", AddRequiredComponents: false });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    const solution = rowsOf(source.store, "solution").find((row) => row.uniquename === "new_idsolution");
    assert.ok(rowsOf(source.store, "solutioncomponent").some((row) => row.solutionid === solution.solutionid && row.objectid === metadataId), "membership is keyed by the MetadataId");
    const dependents = await source.request("GET", `/RetrieveDependentComponents(ObjectId=${metadataId},ComponentType=1)`);
    assert.equal(dependents.status, 200, JSON.stringify(dependents.json));
    // The id the simulator generated before MetadataId became the component id (namespace-derived, not a MetadataId).
    const generated = uuidV5("3f0a9c4e-7b21-4d6e-9a58-1c2e8f0b7d13", "entity|new_loose|");
    assert.notEqual(generated, metadataId);
    const legacy = await source.request("POST", "/AddSolutionComponent", { ComponentId: generated, ComponentType: 1, SolutionUniqueName: "new_idsolution" });
    assert.equal(legacy.status, 404, JSON.stringify(legacy.json));
  });

  it("UpdateSolutionComponent persists selected settings for an existing unmanaged membership only", async () => {
    const objectId = componentObjectId({ kind: "entity", logical: "new_widget", name: null }, ORG);
    const payload = { ComponentId: objectId, ComponentType: 1, SolutionUniqueName: SOLUTION, IncludedComponentSettingsValues: ["IncludeMetadata"] };
    const updated = await source.request("POST", "/UpdateSolutionComponent", payload);
    assert.equal(updated.status, 204, JSON.stringify(updated.json));
    const solution = rowsOf(source.store, "solution").find((row) => row.uniquename === SOLUTION);
    const member = rowsOf(source.store, "solutioncomponent").find((row) => row.solutionid === solution.solutionid && row.objectid === objectId);
    assert.deepEqual(source.store.state.dataverse.solutionComponentSettings[member.solutioncomponentid], ["IncludeMetadata"]);
    const missing = await source.request("POST", "/UpdateSolutionComponent", { ...payload, ComponentId: "00000000-0000-4000-8000-00000000000b" });
    assert.equal(missing.status, 404);
    const invalid = await source.request("POST", "/UpdateSolutionComponent", { ...payload, IncludedComponentSettingsValues: [1] });
    assert.equal(invalid.status, 400);
    assert.deepEqual(source.store.state.dataverse.solutionComponentSettings[member.solutioncomponentid], ["IncludeMetadata"]);
  });

  it("RetrieveDependentComponents lists what depends on a table: its columns, its relationship and the lookup to it", async () => {
    const response = await source.request("GET", `/RetrieveDependentComponents(ObjectId=${componentId("entity", "new_category")},ComponentType=1)`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const rows = dependencyRows(response.json);
    const types = rows.map((row) => row.dependentcomponenttype).sort((a, b) => a - b);
    assert.ok(types.includes(10), "the relationship depends on the table");
    assert.ok(types.includes(2), "the lookup column depends on its target table");
    assert.ok(rows.every((row) => row.requiredcomponentobjectid === componentId("entity", "new_category") && row.dependencytype === 1));
    const unknown = await source.request("GET", "/RetrieveDependentComponents(ObjectId=00000000-0000-4000-8000-000000000002,ComponentType=1)");
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
  });

  it("RetrieveRequiredComponents lists what a relationship needs: both tables and its lookup column", async () => {
    const relationship = componentId("relationship", "new_widget", "new_widget_category");
    const response = await source.request("GET", `/RetrieveRequiredComponents(ObjectId=${relationship},ComponentType=10)`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const required = dependencyRows(response.json).map((row) => row.requiredcomponenttype);
    assert.ok(required.filter((type) => type === 1).length >= 2, "both tables are required");
    assert.ok(required.includes(2), "the lookup column is required");
  });

  it("RetrieveMissingDependencies and RetrieveDependenciesForUninstall report what a solution needs from outside it", async () => {
    const complete = await source.request("GET", `/RetrieveMissingDependencies(SolutionUniqueName='${SOLUTION}')`);
    assert.equal(complete.status, 200, JSON.stringify(complete.json));
    assert.deepEqual(dependencyRows(complete.json), [], "every required component of the solution is in it");
    const category = componentId("entity", "new_category");
    const removed = await source.request("POST", "/RemoveSolutionComponent", {
      SolutionComponent: { objectid: category }, ComponentType: 1, SolutionUniqueName: SOLUTION,
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    const missing = await source.request("GET", `/RetrieveMissingDependencies(SolutionUniqueName='${SOLUTION}')`);
    assert.ok(dependencyRows(missing.json).some((row) => row.requiredcomponentobjectid === category), "the table is now missing");
    const uninstallRows = async () => {
      const uninstall = await source.request("GET", `/RetrieveDependenciesForUninstall(SolutionUniqueName='${SOLUTION}')`);
      assert.equal(uninstall.status, 200, JSON.stringify(uninstall.json));
      return dependencyRows(uninstall.json);
    };
    assert.deepEqual(await uninstallRows(), [], "nothing outside the solution depends on it yet");
    // A relationship created outside the solution, from the loose table to the solution's widget, blocks its uninstall.
    const outside = await source.request("POST", "/RelationshipDefinitions", {
      "@odata.type": "#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
      SchemaName: "new_loose_widget", ReferencedEntity: "new_widget", ReferencingEntity: "new_loose",
      ReferencedAttribute: "new_widgetid", ReferencedEntityNavigationPropertyName: "new_loose_widget_ref",
      ReferencingEntityNavigationPropertyName: "new_widget_loose",
      Lookup: column("Lookup", "new_WidgetLoose", { Description: label("") }),
    });
    assert.equal(outside.status, 204, JSON.stringify(outside.json));
    assert.ok((await uninstallRows()).some((row) => row.requiredcomponentobjectid === componentId("entity", "new_widget")), "the outside relationship is reported");
  });
});

// Solution lifecycle messages: patches and their roll-up, a staged upgrade and its promotion, async export and download,
// uninstall, the preferred solution and AddComponentsToSolutionAsync, on the same schema.
// Patch export lock and roll-up: https://learn.microsoft.com/en-us/power-platform/alm/create-patches-simplify-solution-updates
// Missing upgrade code: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
// Supported uninstall: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/uninstallsolutionasync
describe("Solution lifecycle messages", { concurrency: false }, () => {
  const PATCH_NAME = "Sample patch";
  const componentId = (kind, logical, name = null) => componentObjectId({ kind, logical, name }, ORG);
  const LOOSE = componentId("entity", "new_loose");
  const opened = [];
  const open = async (options) => {
    const server = await startServer(options);
    opened.push(server);
    return server;
  };
  const base64 = (buffer) => buffer.toString("base64");
  const baseRow = (store) => rowsOf(store, "solution").find((s) => s.uniquename === SOLUTION && s.parentsolutionid == null);
  const operationOf = (store, asyncId) => rowsOf(store, "asyncoperation").find((r) => r.asyncoperationid === asyncId);
  let source, v1, managedV1, v2, patchId;

  before(async () => {
    source = await open();
    await buildSourceSolution(source);
    v1 = exportedArchive((await source.request("POST", "/ExportSolution", { SolutionName: SOLUTION, Managed: false })).json);
    managedV1 = exportedArchive((await source.request("POST", "/ExportSolution", { SolutionName: SOLUTION, Managed: true })).json);
  });
  after(async () => {
    for (const server of opened) await server.close();
  });

  it("CloneAsPatch creates a child solution: parent's unique name, parentsolutionid, the requested version", async () => {
    const response = await source.request("POST", "/CloneAsPatch", { ParentSolutionUniqueName: SOLUTION, DisplayName: PATCH_NAME, VersionNumber: "1.0.1.0" });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    patchId = response.json.SolutionId;
    const row = rowsOf(source.store, "solution").find((s) => s.solutionid === patchId);
    assert.equal(row.uniquename, SOLUTION);
    assert.equal(row.parentsolutionid, baseRow(source.store).solutionid);
    assert.equal(row.version, "1.0.1.0");
    assert.equal(row.friendlyname, PATCH_NAME);
    assert.equal(row.ismanaged, false);
  });

  it("CloneAsPatch refuses a version that is not a higher patch of the parent (documented rules; codes unverified)", async () => {
    const otherLine = await source.request("POST", "/CloneAsPatch", { ParentSolutionUniqueName: SOLUTION, DisplayName: "x", VersionNumber: "1.1.0.0" });
    assert.equal(otherLine.status, 400, JSON.stringify(otherLine.json));
    const notHigher = await source.request("POST", "/CloneAsPatch", { ParentSolutionUniqueName: SOLUTION, DisplayName: "x", VersionNumber: "1.0.0.0" });
    assert.equal(notHigher.status, 400, JSON.stringify(notHigher.json));
    const belowPatch = await source.request("POST", "/CloneAsPatch", { ParentSolutionUniqueName: SOLUTION, DisplayName: "x", VersionNumber: "1.0.0.5" });
    assert.equal(belowPatch.status, 400, "a patch must be higher than every existing patch");
    const unknown = await source.request("POST", "/CloneAsPatch", { ParentSolutionUniqueName: "new_nosuchsolution", DisplayName: "x", VersionNumber: "1.0.2.0" });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
    const clerk = await open({ roles: ["Basic User"], appId: CLERK_APP_ID });
    const denied = await clerk.request("POST", "/CloneAsPatch", { ParentSolutionUniqueName: SOLUTION, DisplayName: "x", VersionNumber: "1.0.2.0" });
    assert.equal(denied.status, 403, JSON.stringify(denied.json));
    assert.equal(rowsOf(source.store, "solution").filter((s) => s.parentsolutionid != null).length, 1, "refused patches are not created");
  });

  it("a component added to a patch belongs to the patch; CloneAsSolution rolls the patch into the base solution", async () => {
    const added = await source.request("POST", "/AddComponentToSolutionAsync", { LogicalName: "new_loose", Id: LOOSE, SolutionId: patchId, AddRequiredComponents: false });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    assert.match(added.json.AsyncOperationId, /^[0-9a-f-]{36}$/);
    await solutionImportJob(source.api, added.json.AsyncOperationId);
    assert.equal(operationOf(source.store, added.json.AsyncOperationId).statuscode, 30);
    assert.ok(rowsOf(source.store, "solutioncomponent").some((r) => r.solutionid === patchId && r.objectid === LOOSE), "the patch holds the table");
    const blockedExport = await source.request("POST", "/ExportSolution", { SolutionName: SOLUTION });
    assert.equal(blockedExport.status, 400, JSON.stringify(blockedExport.json));
    assert.equal(blockedExport.json.error.code, "0x80048538", "a base solution cannot be exported while patches exist");
    const beforeRollUp = readSolutionZip(v1);
    assert.doesNotMatch(beforeRollUp.find((d) => d.name === "customizations.xml").xml, /<entity Name="new_loose">/, "a patch's table is not in the base solution");

    const lower = await source.request("POST", "/CloneAsSolution", { ParentSolutionUniqueName: SOLUTION, DisplayName: "Sample solution", VersionNumber: "1.0.5.0" });
    assert.equal(lower.status, 400, "the version must have a higher major.minor (unverified code)");
    const cloned = await source.request("POST", "/CloneAsSolution", { ParentSolutionUniqueName: SOLUTION, DisplayName: "Sample solution", VersionNumber: "1.1.0.0" });
    assert.equal(cloned.status, 200, JSON.stringify(cloned.json));
    assert.equal(cloned.json.SolutionId, baseRow(source.store).solutionid, "the base solution becomes the new version");
    assert.equal(baseRow(source.store).version, "1.1.0.0");
    assert.equal(rowsOf(source.store, "solution").some((s) => s.solutionid === patchId), false, "the patch is rolled up and deleted");
    assert.ok(rowsOf(source.store, "solutioncomponent").some((r) => r.solutionid === baseRow(source.store).solutionid && r.objectid === LOOSE), "the base holds the table now");
    const afterRollUp = readSolutionZip(exportedArchive((await source.request("POST", "/ExportSolution", { SolutionName: SOLUTION })).json));
    assert.match(afterRollUp.find((d) => d.name === "customizations.xml").xml, /<entity Name="new_loose">/);
    assert.match(afterRollUp.find((d) => d.name === "solution.xml").xml, /<Version>1\.1\.0\.0<\/Version>/);
    v2 = exportedArchive((await source.request("POST", "/ExportSolution", { SolutionName: SOLUTION, Managed: false })).json);
  });

  it("StageSolution reports the zip's solution and writes nothing; an invalid zip is refused", async () => {
    const target = await open();
    const staged = await target.request("POST", "/StageSolution", { CustomizationFile: base64(v2) });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const results = staged.json.StageSolutionResults;
    assert.equal(results.SolutionDetails.SolutionUniqueName, SOLUTION);
    assert.equal(results.SolutionDetails.SolutionVersion, "1.1.0.0");
    assert.equal(results.SolutionDetails.IsManaged, false);
    assert.equal(results.SolutionDetails.IsPatchSolution, false);
    assert.match(results.StageSolutionUploadId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(results.MissingDependencies, [], "every table the relationship needs is in the zip");
    assert.equal(rowsOf(target.store, "solution").some((s) => s.uniquename === SOLUTION), false, "staging does not import");
    assert.equal(target.store.state.mappings.new_widget, undefined, "staging creates no table");
    const invalid = await target.request("POST", "/StageSolution", { CustomizationFile: Buffer.from("not a zip").toString("base64") });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
  });

  it("RetrieveMissingComponents lists a relationship whose tables neither the zip nor the store has", async () => {
    const docs = readSolutionZip(v2);
    const emptied = docs.find((doc) => doc.name === "customizations.xml").xml.replace(/<Entities>[\s\S]*<\/Entities>/, "<Entities />");
    const zip = zipOf([
      { name: "solution.xml", data: Buffer.from(docs.find((doc) => doc.name === "solution.xml").xml, "utf8") },
      { name: "customizations.xml", data: Buffer.from(emptied, "utf8") },
    ]);
    const target = await open();
    const missing = await target.request("GET", `/RetrieveMissingComponents(CustomizationFile=@zip)?@zip=${encodeURIComponent(base64(zip))}`);
    assert.equal(missing.status, 200, JSON.stringify(missing.json));
    const schemas = missing.json.MissingComponents.map((m) => m.RequiredComponent.SchemaName).sort();
    assert.deepEqual(schemas, ["new_category", "new_widget"]);
    assert.equal(missing.json.MissingComponents[0].DependentComponent.SchemaName, "new_widget_category");
    const complete = await target.request("GET", `/RetrieveMissingComponents(CustomizationFile=@zip)?@zip=${encodeURIComponent(base64(v2))}`);
    assert.deepEqual(complete.json.MissingComponents, [], "a zip that brings its tables is complete");
  });

  it("StageAndUpgrade stages a holding solution beside the base; DeleteAndPromote applies it and removes the base", async () => {
    const target = await open();
    assert.equal((await target.request("POST", "/ImportSolution", { CustomizationFile: base64(v1) })).status, 204);
    const staged = await target.request("POST", "/StageAndUpgrade", { CustomizationFile: base64(v2), OverwriteUnmanagedCustomizations: false, PublishWorkflows: true });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const holding = rowsOf(target.store, "solution").find((s) => s.uniquename === `${SOLUTION}_Upgrade`);
    assert.equal(holding.solutionid, staged.json.SolutionId);
    assert.equal(holding.version, "1.1.0.0");
    assert.equal(baseRow(target.store).version, "1.0.0.0", "the base solution stays until the upgrade is applied");
    assert.ok(target.store.state.mappings.new_loose, "the holding solution's table exists");

    const promoted = await target.request("POST", "/DeleteAndPromote", { UniqueName: SOLUTION });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
    assert.equal(promoted.json.SolutionId, holding.solutionid, "the holding solution is promoted");
    const named = rowsOf(target.store, "solution").filter((s) => s.uniquename === SOLUTION);
    assert.equal(named.length, 1);
    assert.equal(named[0].version, "1.1.0.0");
    assert.equal(rowsOf(target.store, "solution").some((s) => s.uniquename === `${SOLUTION}_Upgrade`), false);
    const solutionIds = new Set(rowsOf(target.store, "solution").map((s) => s.solutionid));
    assert.ok(rowsOf(target.store, "solutioncomponent").every((r) => solutionIds.has(r.solutionid)), "no membership row points at a removed solution");
    const again = await target.request("POST", "/DeleteAndPromote", { UniqueName: SOLUTION });
    assert.equal(again.status, 400, "there is no holding solution left to promote");
    assert.equal(again.json.error.code, "0x8004853b");
  });

  it("StageAndUpgradeAsync and DeleteAndPromoteAsync return an AsyncOperationId and complete", async () => {
    const target = await open();
    assert.equal((await target.request("POST", "/ImportSolution", { CustomizationFile: base64(v1) })).status, 204);
    const early = await target.request("POST", "/DeleteAndPromoteAsync", { UniqueName: SOLUTION });
    assert.equal(early.status, 400, "no holding solution to promote");
    assert.equal(early.json.error.code, "0x8004853b");
    const staged = await target.request("POST", "/StageAndUpgradeAsync", { CustomizationFile: base64(v2), OverwriteUnmanagedCustomizations: false, PublishWorkflows: true });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    await solutionImportJob(target.api, staged.json.AsyncOperationId);
    assert.equal(operationOf(target.store, staged.json.AsyncOperationId).statuscode, 30);
    const promoted = await target.request("POST", "/DeleteAndPromoteAsync", { UniqueName: SOLUTION });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
    await solutionImportJob(target.api, promoted.json.AsyncOperationId);
    assert.equal(operationOf(target.store, promoted.json.AsyncOperationId).statuscode, 30, operationOf(target.store, promoted.json.AsyncOperationId).message);
    assert.equal(rowsOf(target.store, "solution").find((s) => s.uniquename === SOLUTION).version, "1.1.0.0");
  });

  it("ExportSolutionAsync returns both ids and DownloadSolutionExportData returns the finished zip", async () => {
    const exported = await source.request("POST", "/ExportSolutionAsync", { SolutionName: SOLUTION, Managed: false });
    assert.equal(exported.status, 200, JSON.stringify(exported.json));
    assert.match(exported.json.ExportJobId, /^[0-9a-f-]{36}$/);
    await solutionImportJob(source.api, exported.json.AsyncOperationId);
    assert.equal(operationOf(source.store, exported.json.AsyncOperationId).statuscode, 30);
    const downloaded = await source.request("POST", "/DownloadSolutionExportData", { ExportJobId: exported.json.ExportJobId });
    assert.equal(downloaded.status, 200, JSON.stringify(downloaded.json));
    const docs = readSolutionZip(exportedArchive(downloaded.json));
    assert.deepEqual(docs.map((doc) => doc.name).sort(), ["customizations.xml", "solution.xml"]);
    assert.match(docs.find((doc) => doc.name === "solution.xml").xml, /<UniqueName>new_samplesolution<\/UniqueName>/);
    const unknownJob = await source.request("POST", "/DownloadSolutionExportData", { ExportJobId: "00000000-0000-4000-8000-000000000009" });
    assert.equal(unknownJob.status, 404, "an export job that does not exist (unverified code)");
    const unknownSolution = await source.request("POST", "/ExportSolutionAsync", { SolutionName: "new_nosuchsolution" });
    assert.equal(unknownSolution.status, 404, JSON.stringify(unknownSolution.json));
  });

  it("AddComponentsToSolutionAsync refuses an unknown component unless ContinueOnError skips it", async () => {
    const missingId = "00000000-0000-4000-8000-00000000000a";
    const refused = await source.request("POST", "/AddComponentsToSolutionAsync", {
      SolutionUniqueName: SOLUTION, ContinueOnError: false,
      SolutionComponentParameters: { ParameterCollection: [{ LogicalName: "new_loose", Id: LOOSE }, { LogicalName: "new_nothing", Id: missingId }] },
    });
    assert.equal(refused.status, 404, JSON.stringify(refused.json));
    const skipped = await source.request("POST", "/AddComponentsToSolutionAsync", {
      SolutionUniqueName: SOLUTION, ContinueOnError: true,
      SolutionComponentParameters: { ParameterCollection: [{ LogicalName: "new_loose", Id: LOOSE }, { LogicalName: "new_nothing", Id: missingId }] },
    });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.json));
    await solutionImportJob(source.api, skipped.json.AsyncOperationId);
    assert.equal(operationOf(source.store, skipped.json.AsyncOperationId).statuscode, 30);
  });

  it("UninstallSolutionAsync: refuses an unmanaged solution, is blocked by a dependent outside it, and removes a managed one", async () => {
    const unavailable = await source.request("POST", "/UninstallSolution", { SolutionUniqueName: SOLUTION });
    assert.equal(unavailable.status, 501, "the internal-only synchronous operation follows the documented project override policy");
    assert.match(unavailable.json.error.message, /internal use only/);
    assert.match(source.api.metadata.csdl(), /<Action Name="UninstallSolution">[\s\S]*?<Parameter Name="SolutionUniqueName" Type="Edm.String"/);
    const unmanaged = await source.request("POST", "/UninstallSolutionAsync", { SolutionUniqueName: SOLUTION });
    assert.equal(unmanaged.status, 400, JSON.stringify(unmanaged.json));

    const blocked = await open();
    assert.equal((await blocked.request("POST", "/ImportSolution", { CustomizationFile: base64(managedV1) })).status, 204);
    assert.equal(baseRow(blocked.store).ismanaged, true);
    const { request } = blocked;
    assert.equal((await request("POST", "/EntityDefinitions", tableBody("new_loose"))).status, 204);
    const outside = await request("POST", "/RelationshipDefinitions", {
      "@odata.type": "#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
      SchemaName: "new_loose_category", ReferencedEntity: "new_category", ReferencingEntity: "new_loose",
      ReferencedAttribute: "new_categoryid", ReferencedEntityNavigationPropertyName: "new_loose_category_ref",
      ReferencingEntityNavigationPropertyName: "new_category_loose",
      Lookup: column("Lookup", "new_CategoryLoose", { Description: label("") }),
    });
    assert.equal(outside.status, 204, JSON.stringify(outside.json));
    const before = rowsOf(blocked.store, "solution").length;
    const refused = await request("POST", "/UninstallSolutionAsync", { SolutionUniqueName: SOLUTION });
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.equal(rowsOf(blocked.store, "solution").length, before, "a blocked uninstall writes nothing");

    const removable = await open();
    assert.equal((await removable.request("POST", "/ImportSolution", { CustomizationFile: base64(managedV1) })).status, 204);
    const solutionId = baseRow(removable.store).solutionid;
    assert.equal((await removable.request("POST", "/SetPreferredSolution", { SolutionId: solutionId })).status, 400, "a managed solution cannot be preferred (unverified code)");
    const uninstalled = await removable.request("POST", "/UninstallSolutionAsync", { SolutionUniqueName: SOLUTION });
    assert.equal(uninstalled.status, 200, JSON.stringify(uninstalled.json));
    await solutionImportJob(removable.api, uninstalled.json.AsyncOperationId);
    assert.equal(operationOf(removable.store, uninstalled.json.AsyncOperationId).statuscode, 30);
    assert.equal(baseRow(removable.store), undefined);
    assert.equal(rowsOf(removable.store, "solutioncomponent").some((r) => r.solutionid === solutionId), false);

  });

  it("the preferred solution: the Default solution until one is set; it is per user and counted by PreferredSolutionUsedBy", async () => {
    const initial = await source.request("GET", "/GetPreferredSolution()");
    assert.equal(initial.status, 200, JSON.stringify(initial.json));
    assert.equal(initial.json.uniquename, "Default");
    const set = await source.request("POST", "/SetPreferredSolution", { SolutionId: baseRow(source.store).solutionid });
    assert.equal(set.status, 204, JSON.stringify(set.json));
    const current = await source.request("GET", "/GetPreferredSolution()");
    assert.equal(current.json.uniquename, SOLUTION);
    const used = await source.request("GET", `/PreferredSolutionUsedBy(SolutionId=${baseRow(source.store).solutionid})`);
    assert.equal(used.status, 200, JSON.stringify(used.json));
    assert.equal(used.json.NumberOfAssociatedUsers, 1);
    const unknown = await source.request("POST", "/SetPreferredSolution", { SolutionId: "00000000-0000-4000-8000-00000000000b" });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
  });
});
