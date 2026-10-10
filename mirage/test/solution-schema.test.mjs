import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  scanSolutionSources,
  buildSolutionSchema,
  tableFields,
  classifySolutionPath,
} from "../lib/solution-schema.mjs";
import { importSolutionData, applySolutionData, solutionSeedRows, sourceRecordId } from "../lib/solution-data.mjs";
import { pluralizeEntitySetName, standardTable } from "../lib/solution-standard.mjs";
import { discoverSolutionRoots, resolveSolutionRoots, solutionWatchFilter } from "../lib/solution-roots.mjs";
import { SolutionFileCache, shareSolutionParses } from "../lib/solution-cache.mjs";
import { DataStore } from "../lib/data.mjs";
import { bootstrapReport, formatReport, resolveReportInputs } from "../bootstrap-report.mjs";

const STANDARD = ["createdon", "createdby", "modifiedon", "modifiedby", "statecode", "statuscode"];
const attribute = (name, type, extra = "") =>
  `<attribute PhysicalName="${name}"><Type>${type}</Type><Name>${name}</Name><LogicalName>${name.toLowerCase()}</LogicalName>${extra}</attribute>`;
const label = (text) => `<labels><label description="${text}" languagecode="1033" /><label description="${text} (fr)" languagecode="1036" /></labels>`;
/** Entity.xml; `full` adds the primary key and every standard system column. */
const entityXml = (name, { set, full = false, attributes = "", primaryName = "sample_name", extra = "" } = {}) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><LocalizedNames><LocalizedName description="${name} label" languagecode="1033" /></LocalizedNames><attributes>${
    full
      ? attribute(name + "Id", "primarykey") +
        STANDARD.map((column) => attribute(column, column === "statecode" ? "state" : column === "statuscode" ? "status" : column.endsWith("by") ? "lookup" : "datetime")).join("") +
        attribute(primaryName, "nvarchar", "<RequiredLevel>required</RequiredLevel><DisplayMask>PrimaryName|ValidForForm</DisplayMask><MaxLength>100</MaxLength>")
      : ""
  }${attributes}</attributes>${set ? `<EntitySetName>${set}</EntitySetName>` : ""}${extra}</entity></EntityInfo></Entity>`;
const oneToMany = (schema, child, parent, lookup, navigation = true) =>
  `<EntityRelationship Name="${schema}"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>${child}</ReferencingEntityName><ReferencedEntityName>${parent}</ReferencedEntityName><ReferencingAttributeName>${lookup}</ReferencingAttributeName>${
    navigation
      ? `<EntityRelationshipRoles><EntityRelationshipRole><NavigationPropertyName>${lookup}</NavigationPropertyName><RelationshipRoleType>1</RelationshipRoleType></EntityRelationshipRole><EntityRelationshipRole><NavigationPropertyName>${schema}</NavigationPropertyName><RelationshipRoleType>0</RelationshipRoleType></EntityRelationshipRole></EntityRelationshipRoles>`
      : ""
  }</EntityRelationship>`;
const manyToMany = (schema, first, second, intersect) =>
  `<EntityRelationship Name="${schema}"><EntityRelationshipType>ManyToMany</EntityRelationshipType><FirstEntityName>${first}</FirstEntityName><SecondEntityName>${second}</SecondEntityName><IntersectEntityName>${intersect}</IntersectEntityName><EntityRelationshipRoles><EntityRelationshipRole><NavigationPropertyName>${schema}_first</NavigationPropertyName><AssociationRoleOrdinal>1</AssociationRoleOrdinal></EntityRelationshipRole><EntityRelationshipRole><NavigationPropertyName>${schema}_second</NavigationPropertyName><AssociationRoleOrdinal>2</AssociationRoleOrdinal></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship>`;
const solution = (name) =>
  `<ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName><Version>1.0.0.0</Version><Managed>2</Managed><Publisher><CustomizationPrefix>sample</CustomizationPrefix></Publisher><RootComponents /></SolutionManifest></ImportExportXml>`;

async function tree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-solution-schema-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  return fs.realpath(root);
}

test("solution paths are classified for table metadata, forms, views and environment variables", () => {
  assert.equal(classifySolutionPath("Entities/sample_Item/Entity.xml").kind, "entity");
  assert.equal(classifySolutionPath("Entities/sample_Item/FormXml/main/{a}.xml").kind, "form");
  assert.equal(classifySolutionPath("Entities/sample_Item/SavedQueries/{b}.xml").kind, "view");
  assert.equal(classifySolutionPath("Other/Relationships/sample_item.xml").kind, "relationships");
  assert.equal(classifySolutionPath("Other/Solution.xml").kind, "solution");
  assert.deepEqual(classifySolutionPath("environmentvariabledefinitions/sample_Url/environmentvariabledefinition.xml"), { kind: "envdef", envDir: "sample_Url" });
  assert.equal(classifySolutionPath("environmentvariabledefinitions/sample_Url/environmentvariablevalues.json").kind, "envvalue");
  assert.equal(classifySolutionPath("WebResources/script.js"), null);
});

test("entity sets come from Entity.xml, then the documented catalogue, then pluralization", async (t) => {
  const root = await tree(t, {
    "Entities/sample_epiversions/Entity.xml": entityXml("sample_epiversions", { set: "sample_epiversionses", full: true }),
    "Entities/sample_box/Entity.xml": entityXml("sample_box", { extra: "<LogicalCollectionName>sample_boxcollection</LogicalCollectionName>" }),
    "Entities/sample_category/Entity.xml": entityXml("sample_category"),
    "Entities/Webresource/Entity.xml": entityXml("webresource"),
    "Entities/sample_activity/Entity.xml": entityXml("sample_activity", { extra: "<IsActivity>1</IsActivity>" }),
    "Other/Relationships/sample_category.xml": `<EntityRelationships>${manyToMany("sample_category_box", "sample_category", "sample_box", "sample_category_box")}</EntityRelationships>`,
  });
  const schema = buildSolutionSchema(await scanSolutionSources([root]));
  const table = (name) => schema.tables[name];
  assert.deepEqual([table("sample_epiversions").entitySet, table("sample_epiversions").entitySetSource], ["sample_epiversionses", "solution"]);
  assert.deepEqual([table("sample_box").entitySet, table("sample_box").entitySetSource], ["sample_boxcollection", "solution-collection-name"]);
  assert.deepEqual([table("webresource").entitySet, table("webresource").entitySetSource], ["webresourceset", "dataverse-reference"]);
  assert.equal(table("webresource").primaryIdAttribute, "webresourceid");
  assert.deepEqual([table("sample_category").entitySet, table("sample_category").entitySetSource], ["sample_categories", "pluralized"]);
  assert.deepEqual([table("sample_category").primaryIdAttribute, table("sample_category").primaryIdSource], ["sample_categoryid", "convention"]);
  assert.deepEqual([table("sample_activity").primaryIdAttribute, table("sample_activity").primaryIdSource], ["activityid", "solution-activity"]);
  // Intersect tables use the documented plural rule as well.
  assert.equal(table("sample_category_box").entitySet, "sample_category_boxes");
  assert.equal(table("sample_category_box").isIntersect, true);
  for (const [name, plural] of [["sample_epifhirpayloads", "sample_epifhirpayloadses"], ["sample_box", "sample_boxes"], ["sample_batch", "sample_batches"], ["sample_category", "sample_categories"], ["sample_day", "sample_days"], ["sample_section", "sample_sections"]])
    assert.equal(pluralizeEntitySetName(name), plural);
  assert.equal(standardTable("languagelocale").entitySet, "languagelocale");
  assert.match(standardTable("incident").reference, /^https:\/\/learn\.microsoft\.com\/dynamics365\//);
});

test("column metadata keeps types, requirement, option sets, lookups, behaviours and provenance", async (t) => {
  const columns = [
    attribute("sample_Choice", "picklist", `<RequiredLevel>applicationrequired</RequiredLevel><AppDefaultValue>100000001</AppDefaultValue><optionset Name="sample_item_sample_choice"><OptionSetType>picklist</OptionSetType><options><option value="100000000">${label("First")}</option><option value="100000001">${label("Second")}</option></options></optionset><displaynames><displayname description="Choice" languagecode="1033" /></displaynames>`),
    attribute("sample_Flag", "bit", `<AppDefaultValue>1</AppDefaultValue><optionset Name="sample_item_sample_flag"><OptionSetType>bit</OptionSetType><options><option value="0">${label("No")}</option><option value="1">${label("Yes")}</option></options></optionset>`),
    attribute("sample_Shared", "picklist", "<OptionSetName>sample_sharedchoice</OptionSetName>"),
    attribute("sample_Amount", "decimal", "<Accuracy>2</Accuracy><MinValue>0</MinValue><MaxValue>100</MaxValue>"),
    attribute("sample_Due", "datetime", "<Format>date</Format><Behavior>2</Behavior>"),
    attribute("sample_Number", "nvarchar", "<AutoNumberFormat>ExampleApp-{SEQNUM:6}</AutoNumberFormat><MaxLength>20</MaxLength><IsSecured>1</IsSecured><ValidForCreateApi>0</ValidForCreateApi><ValidForUpdateApi>0</ValidForUpdateApi><ValidForReadApi>1</ValidForReadApi>"),
    attribute("sample_ParentId", "lookup"),
  ].join("");
  const root = await tree(t, {
    "Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items", full: true, attributes: columns }),
    "Entities/sample_parent/Entity.xml": entityXml("sample_parent", { set: "sample_parents", full: true }),
    "OptionSets/sample_sharedchoice.xml": `<optionset Name="sample_sharedchoice"><OptionSetType>picklist</OptionSetType><IsGlobal>1</IsGlobal><options><option value="7">${label("Shared")}</option></options></optionset>`,
    "Other/Relationships/sample_item.xml": `<EntityRelationships>${oneToMany("sample_parent_item", "sample_item", "sample_parent", "sample_ParentId")}</EntityRelationships>`,
  });
  const schema = buildSolutionSchema(await scanSolutionSources([root]), { lcid: 1036 });
  const fields = tableFields(schema, "sample_item");
  assert.deepEqual(fields.sample_choice.options, [{ value: 100000000, label: "First (fr)" }, { value: 100000001, label: "Second (fr)" }]);
  assert.equal(fields.sample_choice.requiredLevel, "applicationrequired");
  assert.equal(fields.sample_choice.required, true);
  assert.equal(fields.sample_choice.defaultValue, 100000001);
  assert.equal(fields.sample_choice.optionSetType, "local");
  assert.equal(fields.sample_flag.type, "boolean");
  assert.equal(fields.sample_flag.defaultValue, true);
  assert.equal(fields.sample_flag.optionSetType, "boolean");
  assert.deepEqual(fields.sample_shared.options, [{ value: 7, label: "Shared (fr)" }]);
  assert.equal(fields.sample_shared.optionSetType, "global");
  assert.match(fields.sample_shared.optionSetSource, /sample_sharedchoice\.xml$/);
  assert.deepEqual([fields.sample_amount.precision, fields.sample_amount.minValue, fields.sample_amount.maxValue], [2, 0, 100]);
  assert.deepEqual([fields.sample_due.format, fields.sample_due.dateTimeBehavior, fields.sample_due.type], ["date", "DateOnly", "date"]);
  assert.equal(fields.sample_number.autoNumberFormat, "ExampleApp-{SEQNUM:6}");
  assert.deepEqual([fields.sample_number.validForCreate, fields.sample_number.validForUpdate, fields.sample_number.validForRead, fields.sample_number.isSecured], [false, false, true, true]);
  assert.deepEqual(fields.sample_parentid.targets, ["sample_parent"]);
  assert.deepEqual(fields.createdby.targets, ["systemuser"]);
  assert.equal(fields.sample_itemid.isPrimaryId, true);
  assert.equal(fields.sample_name.isPrimaryName, true);
  assert.equal(fields.statecode.dataverseType, "state");
  // A complete table also lists the column Dataverse never writes into solution XML.
  assert.equal(fields.versionnumber.implicit, true);
  assert.match(fields.sample_choice.source, /Entity\.xml$/);
});

test("relationships expose navigation properties, partners and intersect columns in mappings", async (t) => {
  const root = await tree(t, {
    "Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items", full: true }),
    "Entities/sample_parent/Entity.xml": entityXml("sample_parent", { set: "sample_parents", full: true }),
    "Other/Relationships.xml": `<EntityRelationships>${oneToMany("sample_parent_item", "sample_item", "sample_parent", "sample_ParentId")}${oneToMany("sample_parent_item_bare", "sample_item", "sample_parent", "sample_OtherParent", false)}${manyToMany("sample_item_parent", "sample_item", "sample_parent", "sample_item_parent")}${manyToMany("sample_item_item", "sample_item", "sample_item", "sample_item_item")}</EntityRelationships>`,
  });
  const data = await importSolutionData([root]);
  const item = data.mappings.sample_item.relationships;
  assert.deepEqual(item.sample_ParentId, { entity: "sample_parent", from: "sample_parentid", to: "sample_parentid", many: false, schemaName: "sample_parent_item", type: "many-to-one", partner: "sample_parent_item" });
  assert.deepEqual(data.mappings.sample_parent.relationships.sample_parent_item, { entity: "sample_item", from: "sample_parentid", to: "sample_parentid", many: true, schemaName: "sample_parent_item", type: "one-to-many", partner: "sample_ParentId" });
  // Without roles the referencing navigation is the lookup's schema name (case kept).
  assert.equal(item.sample_OtherParent.from, "sample_otherparent");
  assert.equal(data.mappings.sample_parent.relationships.sample_parent_item_bare.to, "sample_otherparent");
  assert.deepEqual(item.sample_item_parent_first.intersect, { entity: "sample_item_parent", from: "sample_itemid", to: "sample_parentid" });
  assert.equal(item.sample_item_parent_first.partner, "sample_item_parent_second");
  assert.deepEqual(data.mappings.sample_parent.relationships.sample_item_parent_second.intersect, { entity: "sample_item_parent", from: "sample_parentid", to: "sample_itemid" });
  assert.deepEqual(item.sample_item_item_first.intersect, { entity: "sample_item_item", from: "sample_itemidone", to: "sample_itemidtwo" });
  assert.deepEqual(data.relationships.sample_item_parent, {
    schemaName: "sample_item_parent", type: "many-to-many", intersectEntity: "sample_item_parent", entity1: "sample_item", entity2: "sample_parent",
    attribute1: "sample_itemid", attribute2: "sample_parentid", navigation1: "sample_item_parent_first", navigation2: "sample_item_parent_second",
    source: data.relationships.sample_item_parent.source, intersectAttributesInferred: true,
  });
  assert.equal(data.mappings.sample_item_parent.intersect, true);
  assert.equal(data.schema.tables.sample_item_parent.attributes.sample_itemid.intersectTarget, "sample_item");
});

test("layers order definitions before extensions, later layers replace columns and provenance is kept", async (t) => {
  // Names deliberately sort the extending solution first.
  const root = await tree(t, {
    "A_Extension/Other/Solution.xml": solution("A_Extension"),
    "A_Extension/Entities/sample_item/Entity.xml": entityXml("sample_item", { attributes: attribute("sample_Name", "nvarchar", "<MaxLength>400</MaxLength>") + attribute("sample_Extra", "memo") }),
    "Z_Core/Other/Solution.xml": solution("Z_Core"),
    "Z_Core/Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items", full: true }),
    "Z_Core/WebResources/ignored.xml": "<not-metadata/>",
  });
  const scan = await scanSolutionSources([root]);
  assert.deepEqual(scan.layers.map((layer) => layer.name), ["Z_Core", "A_Extension"]);
  const schema = buildSolutionSchema(scan);
  const table = schema.tables.sample_item;
  assert.equal(table.entitySet, "sample_items");
  assert.equal(table.attributes.sample_name.maxLength, 400);
  assert.equal(table.attributes.sample_name.sources.length, 2);
  assert.match(table.attributes.sample_name.source, /A_Extension/);
  assert.deepEqual(table.layers.map((layer) => [layer.solution, layer.fullDefinition]), [["Z_Core", true], ["A_Extension", false]]);
  assert.equal(table.schemaComplete, true);
  assert.ok(!scan.layers.some((layer) => layer.files.some((file) => /WebResources/.test(file.path))));
  // Explicit root order wins across roots; a root without Solution.xml is one loose layer.
  const other = await tree(t, { "Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_itemsx" }) });
  const explicit = buildSolutionSchema(await scanSolutionSources([other, root]));
  assert.equal(explicit.tables.sample_item.entitySet, "sample_items");
  assert.ok(explicit.diagnostics.some((d) => d.code === "SOLUTION_MAPPING_OVERRIDE"));
  assert.equal(buildSolutionSchema(await scanSolutionSources([root, other])).tables.sample_item.entitySet, "sample_itemsx");
  const derived = await scanSolutionSources([other, root], { order: "derived" });
  assert.deepEqual(derived.layers.map((layer) => layer.name), ["Z_Core", "A_Extension", path.basename(other)]);
});

test("partial table exports never claim complete column coverage", async (t) => {
  const root = await tree(t, {
    "Entities/sample_partial/Entity.xml": entityXml("sample_partial", { set: "sample_partials", attributes: attribute("sample_partialId", "primarykey") + attribute("sample_name", "nvarchar") }),
  });
  const schema = buildSolutionSchema(await scanSolutionSources([root]));
  assert.equal(schema.tables.sample_partial.schemaComplete, false);
  assert.match(schema.tables.sample_partial.completeness.reason, /only part/);
  assert.equal(tableFields(schema, "sample_partial").versionnumber, undefined);
});

test("alternate keys import into mappings with their columns and defining file; later layers replace a key", async (t) => {
  const key = (schemaName, columns, text = schemaName) =>
    `<EntityKey><Name>${schemaName}</Name><LogicalName>${schemaName.toLowerCase()}</LogicalName><IntroducedVersion>1.0</IntroducedVersion><EntityKeyAttributes>${columns
      .map((column) => `<AttributeName>${column}</AttributeName>`)
      .join("")}</EntityKeyAttributes><displaynames><displayname description="${text}" languagecode="1033" /></displaynames></EntityKey>`;
  const core = await tree(t, {
    "Other/Solution.xml": solution("Core"),
    "Entities/sample_item/Entity.xml": entityXml("sample_item", {
      set: "sample_items",
      full: true,
      attributes: attribute("sample_code", "nvarchar") + attribute("sample_eunumber", "nvarchar") + attribute("sample_emanumber", "nvarchar"),
      extra: `<EntityKeys>${key("sample_CodeKey", ["sample_code"])}${key("sample_NumbersKey", ["sample_eunumber", "sample_emanumber"], "Numbers")}</EntityKeys>`,
    }),
    "Entities/sample_plain/Entity.xml": entityXml("sample_plain", { set: "sample_plains", full: true }),
  });
  const feature = await tree(t, {
    "Other/Solution.xml": solution("Feature"),
    "Entities/sample_item/Entity.xml": entityXml("sample_item", {
      attributes: attribute("sample_version", "int"),
      extra: `<EntityKeys>${key("sample_CodeKey", ["sample_code", "sample_version"])}${key("sample_VersionKey", ["sample_version"])}</EntityKeys>`,
    }),
  });
  const coreFile = path.join(core, "Entities", "sample_item", "Entity.xml");
  const featureFile = path.join(feature, "Entities", "sample_item", "Entity.xml");
  const metadata = await importSolutionData([core, feature]);
  assert.deepEqual(metadata.mappings.sample_item.alternateKeys, [
    { name: "sample_codekey", schemaName: "sample_CodeKey", attributes: ["sample_code", "sample_version"], source: featureFile },
    { name: "sample_numberskey", schemaName: "sample_NumbersKey", attributes: ["sample_eunumber", "sample_emanumber"], source: coreFile },
    { name: "sample_versionkey", schemaName: "sample_VersionKey", attributes: ["sample_version"], source: featureFile },
  ]);
  assert.equal(metadata.mappings.sample_plain.alternateKeys, undefined);
  assert.deepEqual(metadata.schema.tables.sample_item.keys.sample_codekey.sources, [coreFile, featureFile]);
  assert.deepEqual(metadata.schema.tables.sample_item.keys.sample_numberskey.labels, { 1033: "Numbers" });
  // The keys reach the simulator state, where the Web API key lookup reads them.
  const state = applySolutionData({ mappings: {}, tables: {}, permissions: [], settings: {} }, metadata, { webApiTables: ["sample_item"] });
  assert.deepEqual(state.mappings.sample_item.alternateKeys, metadata.mappings.sample_item.alternateKeys);
  state.tables.sample_item = [{ sample_itemid: "11111111-1111-4111-8111-111111111111", sample_code: "A1", sample_version: 2 }];
  const store = await new DataStore({ state }).init();
  // As for /_api/sample_items(sample_code='A1',sample_version=2).
  assert.equal(store.findByKey(store.resolveMapping("sample_items"), "sample_code='A1',sample_version=2")?.sample_itemid, "11111111-1111-4111-8111-111111111111");
});

test("environment variables import definitions and values into documented tables with stable IDs", async (t) => {
  const root = await tree(t, {
    "Other/Solution.xml": solution("Vars"),
    "environmentvariabledefinitions/sample_ServiceUrl/environmentvariabledefinition.xml":
      '<environmentvariabledefinition schemaname="sample_ServiceUrl"><displayname default="Service URL"><label description="Service URL" languagecode="1033" /></displayname><type>100000000</type><isrequired>0</isrequired><secretstore>0</secretstore><defaultvalue>https://default.example</defaultvalue></environmentvariabledefinition>',
    "environmentvariabledefinitions/sample_ServiceUrl/environmentvariablevalues.json":
      '{"environmentvariablevalues":{"environmentvariablevalue":{"@environmentvariablevalueid":"8caecfd4-aebb-ee11-a569-000d3aaa0ed0","value":"https://service.example"}}}',
    "environmentvariabledefinitions/sample_Flag/environmentvariabledefinition.xml":
      '<environmentvariabledefinition schemaname="sample_Flag"><displayname default="Flag" /><type>100000002</type></environmentvariabledefinition>',
    "environmentvariabledefinitions/sample_Orphan/environmentvariablevalues.json": '{"environmentvariablevalues":{"environmentvariablevalue":{"value":"x"}}}',
  });
  const data = await importSolutionData([root]);
  assert.deepEqual(data.environmentVariables.map((v) => [v.schemaName, v.value ?? null]), [["sample_Flag", null], ["sample_ServiceUrl", "https://service.example"]]);
  assert.ok(data.diagnostics.some((d) => d.code === "SOLUTION_ENVVAR_VALUE_ORPHANED"));
  assert.equal(data.mappings.environmentvariabledefinition.entitySet, "environmentvariabledefinitions");
  assert.equal(data.mappings.environmentvariablevalue.idColumn, "environmentvariablevalueid");
  assert.equal(data.mappings.environmentvariablevalue.relationships.EnvironmentVariableDefinitionId.entity, "environmentvariabledefinition");
  const seeds = solutionSeedRows(data, { environmentVariables: { sample_flag: "true" } });
  assert.equal(seeds.environmentvariabledefinition[1].environmentvariabledefinitionid, sourceRecordId("environmentvariabledefinition", "sample_ServiceUrl"));
  assert.match(sourceRecordId("environmentvariabledefinition", "x"), /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.deepEqual(seeds.environmentvariablevalue.map((row) => [row.schemaname, row.value]), [["sample_Flag", "true"], ["sample_ServiceUrl", "https://service.example"]]);
  // Rows are seeded, refreshed and removed with the source; other rows are untouched.
  let state = applySolutionData({ mappings: {}, tables: { environmentvariablevalue: [{ environmentvariablevalueid: "local", value: "kept" }] }, permissions: [], settings: {} }, data);
  assert.equal(state.tables.environmentvariabledefinition.length, 2);
  assert.equal(state.tables.environmentvariablevalue.length, 2);
  const without = { ...data, environmentVariables: data.environmentVariables.filter((v) => v.schemaName !== "sample_ServiceUrl") };
  state = applySolutionData(state, without);
  assert.deepEqual(state.tables.environmentvariabledefinition.map((row) => row.schemaname), ["sample_Flag"]);
  assert.deepEqual(state.tables.environmentvariablevalue, [{ environmentvariablevalueid: "local", value: "kept" }]);
});

test("Web API tables receive complete column metadata on their mapping; user mappings stay untouched", async (t) => {
  const root = await tree(t, {
    "Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items", full: true }),
    "Entities/sample_partial/Entity.xml": entityXml("sample_partial", { set: "sample_partials", attributes: attribute("sample_name", "nvarchar") }),
    "Entities/sample_other/Entity.xml": entityXml("sample_other", { set: "sample_others", full: true }),
  });
  const data = await importSolutionData([root]);
  const state = applySolutionData(
    { mappings: { sample_other: { entitySet: "custom", idColumn: "x", userConfigured: true }, stale: { entitySet: "old", idColumn: "oldid", metadataSources: ["old.xml"], relationships: {} } }, tables: {}, permissions: [], settings: {} },
    data,
    { webApiTables: ["sample_item", "sample_partial", "sample_other"] },
  );
  assert.equal(state.mappings.sample_item.schemaComplete, true);
  assert.equal(state.mappings.sample_item.fieldMetadata.sample_name.maxLength, 100);
  assert.equal(state.mappings.sample_item.fieldMetadata.sample_name.source, undefined);
  assert.equal(state.mappings.sample_partial.schemaComplete, false);
  assert.equal(state.mappings.sample_other.entitySet, "custom");
  assert.equal(state.mappings.sample_other.fieldMetadata, undefined);
  assert.equal(state.mappings.stale.inferred, true);
  assert.ok(state.simulator.importDiagnostics.some((d) => d.code === "SOLUTION_MAPPING_REMOVED" && d.entity === "stale"));
  const removed = applySolutionData(state, data, { webApiTables: [] });
  assert.equal(removed.mappings.sample_item.fieldMetadata, undefined);
  assert.equal(removed.mappings.sample_item.schemaComplete, undefined);
});

test("parsed files are cached by file identity and re-read after any change", async (t) => {
  const root = await tree(t, { "Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items", full: true }) });
  const cacheFile = path.join(root, "..", path.basename(root) + "-cache.json");
  t.after(() => fs.rm(cacheFile, { force: true }));
  let scan = await scanSolutionSources([root], { cacheFile });
  await scan.cache.save();
  assert.equal(scan.cache.stats.misses, 1);
  scan = await scanSolutionSources([root], { cacheFile });
  assert.deepEqual(scan.cache.stats, { hits: 1, misses: 0 });
  const file = path.join(root, "Entities/sample_item/Entity.xml");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, original.replace("sample_items", "sample_xtems"));
  scan = await scanSolutionSources([root], { cacheFile });
  assert.equal(scan.cache.stats.misses, 1);
  assert.equal(buildSolutionSchema(scan).tables.sample_item.entitySet, "sample_xtems");
  // A corrupt cache is ignored rather than trusted.
  await fs.writeFile(cacheFile, "{not json");
  assert.equal((await SolutionFileCache.open(cacheFile)).entries.size, 0);
});

test("unbalanced XML is recovered with a diagnostic instead of dropping the layer", async (t) => {
  const root = await tree(t, {
    "Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items" }).replace("</attributes>", "<attribute><LogicalName>sample_x</LogicalName></attributes>"),
  });
  const schema = buildSolutionSchema(await scanSolutionSources([root]));
  assert.equal(schema.tables.sample_item.entitySet, "sample_items");
  assert.ok(schema.diagnostics.some((d) => d.code === "SOLUTION_XML_RECOVERED"));
});

test("solution repositories are discovered next to the portal repository without name conventions", async (t) => {
  const workspace = await tree(t, {
    "portal-repo/.git/HEAD": "ref: refs/heads/main",
    "portal-repo/site/website.yml": "adx_name: Site",
    "zz-core/Core/Other/Solution.xml": solution("Core"),
    "zz-core/Core/Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items", full: true }),
    "aa-feature/Feature/Other/Solution.xml": solution("Feature"),
    "aa-feature/Feature/Entities/sample_item/Entity.xml": entityXml("sample_item", { attributes: attribute("sample_extra", "nvarchar") }),
    "docs-only/readme.md": "not a solution",
  });
  const roots = await discoverSolutionRoots(path.join(workspace, "portal-repo", "site"), { cacheFile: path.join(workspace, "discovery-cache.json") });
  assert.deepEqual(roots.map((root) => path.basename(root)), ["zz-core", "aa-feature"]);
});

test("the watch filter matches layers whose root was given in another spelling (8.3 short name, junction)", async (t) => {
  // chokidar reports paths in the spelling a root was given (the Windows 8.3 short form
  // of os.tmpdir(), a junction or symbolic link), while scanned layer directories are real paths.
  const given = await fs.mkdtemp(path.join(os.tmpdir(), "pp-watch-spelling-"));
  const alias = given + "-alias";
  t.after(async () => {
    await fs.rm(alias, { force: true });
    await fs.rm(given, { recursive: true, force: true });
  });
  for (const [name, body] of Object.entries({
    "Core/Other/Solution.xml": solution("Core"),
    "Core/Entities/contact/Entity.xml": entityXml("contact", { set: "contacts" }),
    "Core/Entities/contact/FormXml/main/form.xml": "<forms />",
  })) {
    await fs.mkdir(path.dirname(path.join(given, name)), { recursive: true });
    await fs.writeFile(path.join(given, name), body);
  }
  await fs.symlink(given, alias, "junction");
  const real = await fs.realpath(given);
  for (const root of [given, alias]) {
    const scan = await scanSolutionSources([root]);
    assert.equal(scan.layers[0].dir, path.join(real, "Core"));
    const ignored = solutionWatchFilter({ sourceDir: path.join(real, "..", "portal-elsewhere"), roots: [root], layers: buildSolutionSchema(scan).layers });
    for (const spelling of [root, real]) {
      assert.equal(ignored(path.join(spelling, "Core", "Entities", "contact", "FormXml", "main", "form.xml"), { isFile: () => true }), false, spelling);
      assert.equal(ignored(path.join(spelling, "Core", "WebResources", "x.js"), { isFile: () => true }), true, spelling);
    }
  }
});

test("the portal's own repository is not a sibling solution root when reached through another spelling", async (t) => {
  const workspace = await tree(t, {
    "portal-repo/.git/HEAD": "ref: refs/heads/main",
    "portal-repo/site/website.yml": "adx_name: Site",
    "portal-repo/Portal/Other/Solution.xml": solution("Portal"),
    "zz-core/Core/Other/Solution.xml": solution("Core"),
    "zz-core/Core/Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items", full: true }),
  });
  await fs.symlink(path.join(workspace, "portal-repo"), path.join(workspace, "portal-alias"), "junction");
  t.after(() => fs.rm(path.join(workspace, "portal-alias"), { force: true }));
  for (const repo of ["portal-repo", "portal-alias"]) {
    const roots = await discoverSolutionRoots(path.join(workspace, repo, "site"), { cacheFile: path.join(workspace, "discovery-cache.json") });
    assert.deepEqual(roots.map((root) => path.basename(root)), ["zz-core"], repo);
  }
});

test("watching includes selected metadata, PCF resources and workflow definitions", () => {
  const sourceDir = path.resolve("C:/portal/site");
  const root = path.resolve("C:/solutions/repo");
  const ignored = solutionWatchFilter({ sourceDir, roots: [root], layers: [{ type: "directory", dir: path.join(root, "Core") }] });
  const at = (...parts) => path.join(root, ...parts);
  assert.equal(ignored(path.join(sourceDir, "web-pages", "x.yml")), false);
  assert.equal(ignored(path.join(sourceDir, ".git", "HEAD")), true);
  assert.equal(ignored(at("Core", "Entities", "sample_item", "Entity.xml"), { isFile: () => true }), false);
  assert.equal(ignored(at("Core", "Other", "Relationships", "x.xml"), { isFile: () => true }), false);
  assert.equal(ignored(at("Core", "WebResources")), true);
  assert.equal(ignored(at('Core', 'Controls', 'tst_Synthetic.Editor', 'bundle.js'), { isFile: () => true }), false);
  assert.equal(ignored(at('Core', 'Controls', 'tst_Synthetic.Editor', 'source.ts'), { isFile: () => true }), true);
  assert.equal(ignored(at('Core', 'Workflows', 'sample.json'), { isFile: () => true }), false);
  assert.equal(ignored(at("Core", "Entities", "sample_item", "notes.txt"), { isFile: () => true }), true);
  assert.equal(ignored(at("NewSolution")), false);
  assert.equal(ignored(at("NewSolution", "Other")), false);
  assert.equal(ignored(at("NewSolution", "Other", "Solution.xml")), false);
  assert.equal(ignored(at("NewSolution", "src")), true);
  assert.equal(ignored(at("README.md"), { isFile: () => true }), true);
  const withState = solutionWatchFilter({ sourceDir, roots: [root], layers: [], exclude: [path.join(sourceDir, ".state")] });
  assert.equal(withState(path.join(sourceDir, ".state", "state.json")), true);
  assert.equal(withState(path.join(sourceDir, "web-pages")), false);
  // Skip rules apply below a watched base, never to the names of its ancestors.
  const nested = solutionWatchFilter({
    sourceDir: path.resolve("C:/work/.paqvilo/export/site"),
    roots: [path.resolve("C:/build/bin/solutions")],
    layers: [{ type: "directory", dir: path.resolve("C:/build/bin/solutions/Core") }],
  });
  assert.equal(nested(path.resolve("C:/work/.paqvilo/export/site/web-pages/x.yml")), false);
  assert.equal(nested(path.resolve("C:/work/.paqvilo/export/site/node_modules/x.js")), true);
  assert.equal(nested(path.resolve("C:/build/bin/solutions/Core/Entities/sample_item/Entity.xml"), { isFile: () => true }), false);
  assert.equal(nested(path.resolve("C:/build/bin/solutions/Core/Entities/obj/x.xml"), { isFile: () => true }), true);
  assert.equal(nested(path.resolve("C:/build/bin/solutions/New/Other/Solution.xml")), false);
});

test("virtual tables are complete with their primary key; a table included unmodified has unknown columns", async (t) => {
  const root = await tree(t, {
    // Example: SharePoint-connector virtual tables (DataProviderId/DataSourceId) have no system columns.
    "Entities/sample_Committees/Entity.xml": entityXml("sample_Committees", {
      set: "sample_committeeses",
      attributes: attribute("sample_CommitteesId", "primarykey") + attribute("sample_title", "nvarchar") + attribute("sample_created", "datetime"),
      extra: "<DataProviderId>{b581d5dc-72e1-ea11-a81e-000d3af5fff1}</DataProviderId><DataSourceId>{7f35272f-3edc-4a06-a841-843e13682e0f}</DataSourceId>",
    }),
    // A virtual table without its primary key stays partial.
    "Entities/sample_Partial/Entity.xml": entityXml("sample_Partial", {
      attributes: attribute("sample_title", "nvarchar"),
      extra: "<DataSourceId>{7f35272f-3edc-4a06-a841-843e13682e0f}</DataSourceId>",
    }),
    // A solution that includes a table without changes exports <entity unmodified="1"> and no columns.
    "Entities/SharePointDocument/Entity.xml": '<Entity><Name>SharePointDocument</Name><EntityInfo><entity Name="SharePointDocument" unmodified="1"><attributes /></entity></EntityInfo></Entity>',
  });
  const schema = buildSolutionSchema(await scanSolutionSources([root]));
  const virtual = schema.tables.sample_committees;
  assert.equal(virtual.isVirtual, true);
  assert.equal(virtual.schemaComplete, true);
  assert.match(virtual.completeness.reason, /virtual table with its primary key/);
  // Standard system columns are not implied for a virtual table.
  const fields = tableFields(schema, "sample_committees");
  assert.ok(fields.sample_title);
  for (const column of ["createdon", "modifiedon", "statecode", "versionnumber"]) assert.equal(fields[column], undefined, column);
  assert.equal(schema.tables.sample_partial.schemaComplete, false);
  const stub = schema.tables.sharepointdocument;
  assert.equal(stub.schemaComplete, false);
  assert.deepEqual(stub.layers.map((layer) => layer.unmodified), [true]);
  assert.match(stub.completeness.reason, /unmodified, without its columns; its columns are unknown locally/);
});

test("documented built-in relationships join partial exports with Microsoft Learn provenance", async (t) => {
  const root = await tree(t, {
    "Entities/Contact/Entity.xml": entityXml("Contact", { attributes: attribute("sample_Extra", "nvarchar") }),
    "Entities/Account/Entity.xml": entityXml("Account", { attributes: attribute("sample_Other", "nvarchar") }),
  });
  const data = await importSolutionData([root]);
  const relationship = (key) => {
    const value = data.relationships[key];
    assert.ok(value, key);
    return value;
  };
  const oneToManyShape = (value) => [value.referencingEntity, value.referencedEntity, value.referencingAttribute, value.referencingNavigation, value.referencedNavigation];
  assert.deepEqual(oneToManyShape(relationship("account_activitypointers")), ["activitypointer", "account", "regardingobjectid", "regardingobjectid_account", "Account_ActivityPointers"]);
  assert.deepEqual(oneToManyShape(relationship("contact_activitypointers")), ["activitypointer", "contact", "regardingobjectid", "regardingobjectid_contact", "Contact_ActivityPointers"]);
  assert.deepEqual(oneToManyShape(relationship("contact_master_contact")), ["contact", "contact", "masterid", "masterid", "contact_master_contact"]);
  assert.deepEqual(oneToManyShape(relationship("incident_customer_accounts")), ["incident", "account", "customerid", "customerid_account", "incident_customer_accounts"]);
  assert.deepEqual(oneToManyShape(relationship("incident_customer_contacts")), ["incident", "contact", "customerid", "customerid_contact", "incident_customer_contacts"]);
  assert.deepEqual(oneToManyShape(relationship("account_sharepointdocumentlocation")), ["sharepointdocumentlocation", "account", "regardingobjectid", "regardingobjectid_account", "Account_SharepointDocumentLocation"]);
  assert.match(relationship("account_activitypointers").source, /^https:\/\/learn\.microsoft\.com\/.*\/activitypointer$/);
  assert.match(relationship("incident_customer_contacts").source, /^https:\/\/learn\.microsoft\.com\/.*\/incident$/);
  // Enhanced data model web role memberships (N:N between powerpagecomponent and contact).
  const memberships = relationship("powerpagecomponent_mspp_webrole_contact");
  assert.deepEqual([memberships.type, memberships.entity1, memberships.entity2, memberships.intersectEntity, memberships.attribute1, memberships.attribute2], ["many-to-many", "powerpagecomponent", "contact", "powerpagecomponent_mspp_webrole_contact", "powerpagecomponentid", "contactid"]);
  assert.deepEqual(data.mappings.contact.relationships.powerpagecomponent_mspp_webrole_contact.intersect, { entity: "powerpagecomponent_mspp_webrole_contact", from: "contactid", to: "powerpagecomponentid" });
  // Merged contacts navigate both ways on contact.
  assert.equal(data.mappings.contact.relationships.masterid.many, false);
  assert.equal(data.mappings.contact.relationships.contact_master_contact.many, true);
  // Only relationships touching an exported table are added.
  assert.equal(data.relationships.knowledgearticle_sharepointdocumentlocations, undefined);
});

test("solution roots resolve alike for serve and bootstrap-report: CLI, catalogue, then discovery; derived unless explicit", async (t) => {
  const workspace = await tree(t, {
    "portal-repo/.git/HEAD": "ref: refs/heads/main",
    "portal-repo/site/website.yml": "adx_name: Site",
    "zz-core/Core/Other/Solution.xml": solution("Core"),
    "zz-core/Core/Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items", full: true }),
    "aa-feature/Feature/Other/Solution.xml": solution("Feature"),
    "aa-feature/Feature/Entities/sample_item/Entity.xml": entityXml("sample_item", { attributes: attribute("sample_extra", "nvarchar") }),
  });
  const site = path.join(workspace, "portal-repo", "site");
  const core = path.join(workspace, "zz-core");
  const feature = path.join(workspace, "aa-feature");
  const cli = await resolveSolutionRoots({ sourceDir: site, explicitRoots: [feature, core] });
  assert.deepEqual([cli.source, cli.order, cli.roots], ["cli", "derived", [feature, core]]);
  // Listed roots are a set: derived order layers the definition first.
  assert.deepEqual((await scanSolutionSources(cli.roots, { order: cli.order })).layers.map((layer) => layer.name), ["Core", "Feature"]);
  const explicit = await resolveSolutionRoots({ sourceDir: site, explicitRoots: [feature, core], explicitOrder: "explicit" });
  assert.equal(explicit.order, "explicit");
  assert.deepEqual((await scanSolutionSources(explicit.roots, { order: explicit.order })).layers.map((layer) => layer.name), ["Feature", "Core"]);
  // The catalogue site's mirage roots and order (lense/config.mjs mirageConfig).
  const catalogue = await resolveSolutionRoots({ sourceDir: site, catalogue: { solutionRoots: [core], solutionOrder: "explicit" } });
  assert.deepEqual([catalogue.source, catalogue.order, catalogue.roots], ["catalogue", "explicit", [core]]);
  assert.equal((await resolveSolutionRoots({ sourceDir: site, catalogue: { solutionRoots: [core] } })).order, "derived");
  // CLI roots take precedence over the catalogue; an empty catalogue list falls back to discovery.
  assert.equal((await resolveSolutionRoots({ sourceDir: site, explicitRoots: [feature], catalogue: { solutionRoots: [core] } })).source, "cli");
  const discovered = await resolveSolutionRoots({ sourceDir: site, catalogue: { solutionRoots: [] }, cacheFile: path.join(workspace, "discovery-cache.json") });
  assert.deepEqual([discovered.source, discovered.order, discovered.roots.map((root) => path.basename(root))], ["discovered", "derived", ["zz-core", "aa-feature"]]);
  await assert.rejects(resolveSolutionRoots({ sourceDir: site, explicitRoots: [core], explicitOrder: "alphabetical" }), /--solution-order must be derived or explicit/);
});

test("case relationships come from Learn and document management creates <table>_SharePointDocumentLocations", async (t) => {
  const managed = "<IsDocumentManagementEnabled>1</IsDocumentManagementEnabled>";
  const root = await tree(t, {
    // Second and Third grants: case notes, activities, email, portal comments and document
    // locations; sample_shortage and incident have document management enabled.
    "Entities/Incident/Entity.xml": entityXml("Incident", { attributes: attribute("sample_Extra", "nvarchar"), extra: managed }),
    "Entities/sample_shortage/Entity.xml": entityXml("sample_shortage", { set: "sample_shortages", full: true, extra: managed }),
    "Entities/sample_plain/Entity.xml": entityXml("sample_plain", { set: "sample_plains", full: true, extra: "<IsDocumentManagementEnabled>0</IsDocumentManagementEnabled>" }),
    // Catalogue relationships join when one of their tables is exported (annotation here).
    "Entities/Annotation/Entity.xml": entityXml("Annotation", { attributes: attribute("sample_Note", "nvarchar") }),
    // Account keeps its documented Account_SharepointDocumentLocation relationship.
    "Entities/Account/Entity.xml": entityXml("Account", { attributes: attribute("sample_Other", "nvarchar"), extra: managed }),
  });
  const schema = buildSolutionSchema(await scanSolutionSources([root]));
  const shape = (key) => {
    const relationship = schema.relationships[key];
    assert.ok(relationship, key);
    return [relationship.schemaName, relationship.referencingEntity, relationship.referencedEntity, relationship.referencingAttribute, relationship.referencingNavigation, relationship.referencedNavigation];
  };
  assert.deepEqual(shape("incident_activitypointers"), ["Incident_ActivityPointers", "activitypointer", "incident", "regardingobjectid", "regardingobjectid_incident", "Incident_ActivityPointers"]);
  assert.deepEqual(shape("incident_annotation"), ["Incident_Annotation", "annotation", "incident", "objectid", "objectid_incident", "Incident_Annotation"]);
  assert.deepEqual(shape("incident_emails"), ["Incident_Emails", "email", "incident", "regardingobjectid", "regardingobjectid_incident_email", "Incident_Emails"]);
  assert.deepEqual(shape("incident_adx_portalcomments"), ["incident_adx_portalcomments", "adx_portalcomment", "incident", "regardingobjectid", "regardingobjectid_incident_adx_portalcomment", "incident_adx_portalcomments"]);
  assert.deepEqual(shape("adx_portalcomment_annotations"), ["adx_portalcomment_Annotations", "annotation", "adx_portalcomment", "objectid", "objectid_adx_portalcomment", "adx_portalcomment_Annotations"]);
  assert.match(schema.relationships.incident_emails.source, /^https:\/\/learn\.microsoft\.com\/dynamics365\/.*\/incident$/);
  // Derived from IsDocumentManagementEnabled, with the defining Entity.xml as provenance.
  assert.deepEqual(shape("incident_sharepointdocumentlocations"), ["incident_SharePointDocumentLocations", "sharepointdocumentlocation", "incident", "regardingobjectid", "regardingobjectid_incident", "incident_SharePointDocumentLocations"]);
  assert.deepEqual(shape("sample_shortage_sharepointdocumentlocations"), ["sample_shortage_SharePointDocumentLocations", "sharepointdocumentlocation", "sample_shortage", "regardingobjectid", "regardingobjectid_sample_shortage", "sample_shortage_SharePointDocumentLocations"]);
  assert.match(schema.relationships.sample_shortage_sharepointdocumentlocations.source, /sample_shortage.Entity\.xml$/);
  assert.equal(schema.relationships.sample_shortage_sharepointdocumentlocations.referencedAttribute, "sample_shortageid");
  assert.equal(schema.relationships.sample_plain_sharepointdocumentlocations, undefined);
  assert.equal(schema.relationships.account_sharepointdocumentlocations, undefined);
  assert.equal(schema.relationships.account_sharepointdocumentlocation.schemaName, "Account_SharepointDocumentLocation");
  assert.equal(schema.documentLocationRelationships, 2);
});

test("while a share is open several caches of one process parse a Solution root once", async (t) => {
  const root = await tree(t, {
    "Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items", full: true }),
    "Entities/sample_other/Entity.xml": entityXml("sample_other", { set: "sample_others", full: true }),
  });
  // `serve --project` starts every portal inside one share: the second portal's cache
  // (its own state directory) takes the first portal's parses.
  const share = shareSolutionParses();
  let first, second;
  try {
    first = await scanSolutionSources([root], { cache: new SolutionFileCache() });
    second = await scanSolutionSources([root], { cache: new SolutionFileCache() });
    // Each consumer gets its own copy.
    for (const document of first.layers[0].documents) for (const entity of document.facts.entities ?? []) entity.entitySetName = "changed";
    assert.equal(buildSolutionSchema(second).tables.sample_item.entitySet, "sample_items");
    const third = await scanSolutionSources([root], { cache: new SolutionFileCache() });
    assert.equal(buildSolutionSchema(third).tables.sample_item.entitySet, "sample_items");
    // A changed file is parsed again although the share holds its previous result.
    const file = path.join(root, "Entities/sample_item/Entity.xml");
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("sample_items", "sample_renamed"));
    const changed = await scanSolutionSources([root], { cache: new SolutionFileCache() });
    assert.deepEqual(changed.cache.stats, { hits: 1, misses: 1 });
    assert.equal(buildSolutionSchema(changed).tables.sample_item.entitySet, "sample_renamed");
  } finally {
    share.close();
  }
  assert.deepEqual(first.cache.stats, { hits: 0, misses: 2 });
  assert.deepEqual(second.cache.stats, { hits: 2, misses: 0 });
  assert.equal(second.cache.processHits, 2);
  // Outside a share every cache parses for itself.
  const alone = await scanSolutionSources([root], { cache: new SolutionFileCache() });
  assert.deepEqual(alone.cache.stats, { hits: 0, misses: 2 });
  assert.equal(alone.cache.processHits, 0);
});

test("one-to-many relationships keep the Solution's cascade configuration on the relationship, both navigation sides and the bootstrap report", async (t) => {
  // Other/Relationships XML states one CascadeType per kind (Learn: CascadeConfiguration).
  const cascading = (schema, lookup, values) =>
    oneToMany(schema, "sample_item", "sample_parent", lookup).replace(
      "<ReferencingAttributeName>",
      `${Object.entries(values).map(([kind, value]) => `<Cascade${kind}>${value}</Cascade${kind}>`).join("")}<ReferencingAttributeName>`,
    );
  const quiet = { Assign: "NoCascade", Reparent: "NoCascade", Share: "NoCascade", Unshare: "NoCascade" };
  const relationships = (restrict) =>
    `<EntityRelationships>${cascading("sample_parent_item_cascade", "sample_CascadeParent", { Assign: "Cascade", Delete: "Cascade", Archive: "Cascade", Reparent: "Cascade", Share: "Cascade", Unshare: "Cascade", RollupView: "NoCascade" })}${cascading("sample_parent_item_removelink", "sample_LinkParent", { ...quiet, Delete: "RemoveLink", Archive: "RemoveLink" })}${cascading("sample_parent_item_restrict", "sample_RestrictParent", { ...quiet, Delete: restrict, Archive: "Restrict" })}${oneToMany("sample_parent_item_unstated", "sample_item", "sample_parent", "sample_PlainParent")}</EntityRelationships>`;
  const core = await tree(t, {
    "Other/Solution.xml": solution("Core"),
    "Entities/sample_item/Entity.xml": entityXml("sample_item", { set: "sample_items", full: true }),
    "Entities/sample_parent/Entity.xml": entityXml("sample_parent", { set: "sample_parents", full: true }),
    "Other/Relationships/sample_parent.xml": relationships("Restrict"),
  });
  const data = await importSolutionData([core]);
  assert.deepEqual(data.relationships.sample_parent_item_cascade.cascade, { assign: "Cascade", delete: "Cascade", archive: "Cascade", reparent: "Cascade", share: "Cascade", unshare: "Cascade", rollupView: "NoCascade" });
  const sides = (schema, lookup) => [data.relationships[schema].cascade?.delete, data.mappings.sample_item.relationships[lookup].cascade?.delete, data.mappings.sample_parent.relationships[schema].cascade?.delete];
  assert.deepEqual(sides("sample_parent_item_cascade", "sample_CascadeParent"), ["Cascade", "Cascade", "Cascade"]);
  assert.deepEqual(sides("sample_parent_item_removelink", "sample_LinkParent"), ["RemoveLink", "RemoveLink", "RemoveLink"]);
  assert.deepEqual(sides("sample_parent_item_restrict", "sample_RestrictParent"), ["Restrict", "Restrict", "Restrict"]);
  assert.deepEqual(data.mappings.sample_parent.relationships.sample_parent_item_restrict.cascade, { assign: "NoCascade", delete: "Restrict", archive: "Restrict", reparent: "NoCascade", share: "NoCascade", unshare: "NoCascade" });
  // A relationship whose XML states no cascade has none (the store applies its default).
  assert.equal("cascade" in data.relationships.sample_parent_item_unstated, false);
  assert.equal("cascade" in data.mappings.sample_item.relationships.sample_PlainParent, false);
  assert.equal("cascade" in data.mappings.sample_parent.relationships.sample_parent_item_unstated, false);
  // The runtime state's mappings carry it (the data store reads delete from them).
  const state = applySolutionData({ version: 1, mappings: {}, tables: {}, simulator: {} }, data);
  assert.equal(state.mappings.sample_parent.relationships.sample_parent_item_restrict.cascade.delete, "Restrict");
  assert.equal(state.mappings.sample_item.relationships.sample_CascadeParent.cascade.delete, "Cascade");
  // A later layer's definition replaces the relationship, cascade included.
  const feature = await tree(t, { "Other/Solution.xml": solution("Feature"), "Other/Relationships/sample_parent.xml": relationships("RemoveLink") });
  const layered = await importSolutionData([core, feature], { order: "explicit" });
  assert.equal(layered.relationships.sample_parent_item_restrict.cascade.delete, "RemoveLink");
  assert.equal(layered.mappings.sample_parent.relationships.sample_parent_item_restrict.cascade.delete, "RemoveLink");
  // The bootstrap report lists each relationship's cascade and counts the delete behaviours.
  const portal = await tree(t, {
    "website.yml": "adx_name: Cascade Site\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033",
    "websitelanguage.yml": "- adx_websitelanguageid: lang-en\n  adx_name: English",
    "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main",
    "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main",
    "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "web-templates/Main.webtemplate.source.html": "<p>home</p>",
  });
  const report = await bootstrapReport(await resolveReportInputs({ source: portal, "solution-root": [core] }), { noCache: true });
  assert.deepEqual(report.summary.cascadeDelete, { Cascade: 1, RemoveLink: 1, Restrict: 1, unstated: 1 });
  assert.deepEqual(report.relationships.find((rel) => rel.schemaName === "sample_parent_item_restrict").cascade.delete, "Restrict");
  assert.match(formatReport(report), /one-to-many delete behaviour: Cascade 1, RemoveLink 1, Restrict 1, unstated 1/);
});
