// Seeded record defaults, platform AttributeMetadata and user time-zone formatting of the
// native grid data (invented sample_ schema; no business data).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { scanSolutionSources, buildSolutionSchema, tableFields, seedPresetBody } from "../lib/solution-schema.mjs";
import { attributeMetadata } from "../lib/attribute-metadata.mjs";
import { requestTimeZone, userLocalDate, formatDotNetDate } from "../lib/native-services.mjs";

const common = (custom) =>
  `<RequiredLevel>none</RequiredLevel><DisplayMask>ValidForAdvancedFind|ValidForForm|ValidForGrid</DisplayMask><ValidForUpdateApi>1</ValidForUpdateApi><ValidForReadApi>1</ValidForReadApi><ValidForCreateApi>1</ValidForCreateApi><IsCustomField>${custom}</IsCustomField><IsAuditEnabled>${custom}</IsAuditEnabled><IsSecured>0</IsSecured><IntroducedVersion>1.0.0.0</IntroducedVersion><IsCustomizable>1</IsCustomizable><IsRenameable>1</IsRenameable><CanModifySearchSettings>1</CanModifySearchSettings><CanModifyRequirementLevelSettings>1</CanModifyRequirementLevelSettings><CanModifyAdditionalSettings>1</CanModifyAdditionalSettings><SourceType>0</SourceType><IsSearchable>0</IsSearchable><IsFilterable>0</IsFilterable><IsRetrievable>0</IsRetrievable><IsLocalizable>0</IsLocalizable>`;
const attr = (physical, type, extra = "", custom = 1) =>
  `<attribute PhysicalName="${physical}"><Type>${type}</Type><Name>${physical.toLowerCase()}</Name><LogicalName>${physical.toLowerCase()}</LogicalName>${common(custom)}${extra}<displaynames><displayname description="${physical} label" languagecode="1033" /></displaynames></attribute>`;
const options = (values) => `<options>${values.map(([value, text]) => `<option value="${value}" ExternalValue="" IsHidden="0"><labels><label description="${text}" languagecode="1033" /></labels></option>`).join("")}</options>`;
const entity = `<Entity><Name>sample_thing</Name><EntityInfo><entity Name="sample_thing"><LocalizedNames><LocalizedName description="Thing" languagecode="1033" /></LocalizedNames><attributes>
${attr("sample_thingId", "primarykey", "<Descriptions><Description description=\"Unique identifier for entity instances\" languagecode=\"1033\" /></Descriptions>", 0)}
${attr("CreatedOn", "datetime", "<ImeMode>inactive</ImeMode><Format>datetime</Format><CanChangeDateTimeBehavior>0</CanChangeDateTimeBehavior><Behavior>1</Behavior>", 0)}
${attr("ModifiedOn", "datetime", "<Format>datetime</Format><Behavior>1</Behavior>", 0)}
${attr("sample_name", "nvarchar", "<ImeMode>auto</ImeMode><Format>text</Format><MaxLength>100</MaxLength><Length>200</Length>").replace("ValidForGrid</DisplayMask>", "ValidForGrid|PrimaryName|RequiredForForm</DisplayMask>")}
${attr("sample_flag", "bit", `<AppDefaultValue>1</AppDefaultValue><optionset Name="sample_thing_sample_flag"><OptionSetType>bit</OptionSetType><IntroducedVersion>1.0.0.0</IntroducedVersion><IsCustomizable>1</IsCustomizable><displaynames><displayname description="Flag" languagecode="1033" /></displaynames>${options([[1, "Yes"], [0, "No"]])}</optionset>`)}
${attr("sample_color", "picklist", "<AppDefaultValue>100000001</AppDefaultValue><OptionSetName>sample_color</OptionSetName>")}
${attr("sample_code", "nvarchar", "<Format>text</Format><MaxLength>20</MaxLength><AutoNumberFormat>T-{SEQNUM:4}</AutoNumberFormat>")}
${attr("statecode", "state", `<optionset Name="sample_thing_statecode"><OptionSetType>state</OptionSetType><states><state value="0" defaultstatus="1" invariantname="Active"><labels><label description="Active" languagecode="1033" /></labels></state><state value="1" defaultstatus="2" invariantname="Inactive"><labels><label description="Inactive" languagecode="1033" /></labels></state></states></optionset>`, 0)}
${attr("statuscode", "status", `<optionset Name="sample_thing_statuscode"><OptionSetType>status</OptionSetType><statuses><status value="1" state="0"><labels><label description="Active" languagecode="1033" /></labels></status><status value="2" state="1"><labels><label description="Inactive" languagecode="1033" /></labels></status></statuses></optionset>`, 0)}
</attributes></entity></EntityInfo></Entity>`;
const colorSet = `<optionset Name="sample_color" localizedName="Color"><OptionSetType>picklist</OptionSetType><IsGlobal>1</IsGlobal><IntroducedVersion>1.0.0.0</IntroducedVersion><IsCustomizable>1</IsCustomizable><displaynames><displayname description="Color" languagecode="1033" /></displaynames>${options([[100000000, "Red"], [100000001, "Green"]])}</optionset>`;

async function schemaOf(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-data-formatting-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries({ "Entities/sample_thing/Entity.xml": entity, "OptionSets/sample_color.xml": colorSet })) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), body);
  }
  return buildSolutionSchema(await scanSolutionSources([root]));
}

test("seeded preset rows get creation stamps, column defaults, default status reasons and autonumbers", async (t) => {
  const schema = await schemaOf(t);
  const body = seedPresetBody(
    { tables: { sample_thing: [{ sample_thingid: "a", sample_name: "A" }, { sample_thingid: "b", sample_name: "B", sample_flag: false, sample_color: null, statecode: 1 }], other: [{ x: 1 }] } },
    schema,
    { now: Date.UTC(2026, 9, 1, 8, 0, 0) },
  );
  const [a, b] = body.tables.sample_thing;
  assert.deepEqual(
    { createdon: a.createdon, modifiedon: a.modifiedon, flag: a.sample_flag, color: a.sample_color, state: a.statecode, status: a.statuscode, code: a.sample_code },
    { createdon: "2026-10-01T08:00:00Z", modifiedon: "2026-10-01T08:00:00Z", flag: true, color: 100000001, state: 0, status: 1, code: "T-1000" },
  );
  // Explicit values (false, null, an inactive state) win over defaults.
  assert.deepEqual({ flag: b.sample_flag, color: b.sample_color, status: b.statuscode, code: b.sample_code }, { flag: false, color: null, status: 2, code: "T-1001" });
  assert.deepEqual(body.settings.autoNumberSequences, { "sample_thing.sample_code": 1002 });
  assert.deepEqual(body.tables.other, [{ x: 1 }]);
});

test("grid AttributeMetadata follows the exported column facts", async (t) => {
  const schema = await schemaOf(t);
  const fields = tableFields(schema, "sample_thing");
  const of = (name) => attributeMetadata("sample_thing", name, fields[name], { primaryName: "sample_name" });
  const name = of("sample_name");
  assert.equal(name.AttributeTypeName.Value, "StringType");
  assert.deepEqual([name.Format, name.FormatName.Value, name.MaxLength, name.DatabaseLength, name.ImeMode, name.IsPrimaryName, name.IsRequiredForForm, name.CanBeSecuredForRead], [1, "Text", 100, 200, 0, true, true, false]);
  assert.equal(name.DisplayName.UserLocalizedLabel.Label, "sample_name label");
  const pk = of("sample_thingid");
  assert.deepEqual([pk.AttributeType, pk.IsPrimaryId, pk.SchemaName, pk.SourceType, pk.IsAuditEnabled.CanBeChanged, pk.Description.UserLocalizedLabel.Label], [15, true, "sample_thingId", null, false, "Unique identifier for entity instances"]);
  const created = of("createdon");
  assert.deepEqual([created.Format, created.ImeMode, created.DateTimeBehavior.Value, created.CanChangeDateTimeBehavior.Value, created.CanChangeDateTimeBehavior.CanBeChanged], [1, 1, "UserLocal", false, false]);
  const flag = of("sample_flag");
  assert.deepEqual([flag.DefaultValue, flag.OptionSet.OptionSetType, flag.OptionSet.TrueOption.Label.UserLocalizedLabel.Label, flag.OptionSet.FalseOption.ExternalValue], [true, 3, "Yes", ""]);
  const color = of("sample_color");
  assert.deepEqual([color.DefaultFormValue, color.OptionSet.IsGlobal, color.OptionSet.Name, color.OptionSet.Options.map((o) => o.Label.UserLocalizedLabel.Label)], [100000001, true, "sample_color", ["Red", "Green"]]);
  const state = of("statecode");
  assert.deepEqual(state.OptionSet.Options.map((o) => [o.Value, o.DefaultStatus, o.InvariantName, o.ExternalValue]), [[0, 1, "Active", null], [1, 2, "Inactive", null]]);
  assert.deepEqual(of("statuscode").OptionSet.Options.map((o) => [o.Value, o.State]), [[1, 0], [2, 1]]);
  // Platform-generated identifiers are not in an export.
  assert.deepEqual([name.MetadataId, name.ColumnNumber, name.CreatedOn], [null, null, null]);
  assert.equal(attributeMetadata("sample_thing", "x", { dataverseType: "nvarchar" }), null);
});

test("user-local grid dates follow the user's zone with daylight saving", () => {
  const march = new Date("2026-03-04T10:30:00Z");
  const october = new Date("2026-10-14T21:01:26Z");
  assert.equal(formatDotNetDate(userLocalDate(march, { timeZone: "Europe/Kyiv" }), "M/d/yyyy h:mm tt"), "3/4/2026 12:30 PM");
  assert.equal(formatDotNetDate(userLocalDate(october, { timeZone: "Europe/Kyiv" }), "M/d/yyyy h:mm tt"), "10/15/2026 12:01 AM");
  // Without a zone the request's fixed offset applies.
  assert.equal(formatDotNetDate(userLocalDate(march, { timezoneOffset: -180 }), "M/d/yyyy h:mm tt"), "3/4/2026 1:30 PM");
  assert.equal(requestTimeZone({ headers: { cookie: "a=1; timeZoneCode=Europe%2FKyiv" } }, -180), "Europe/Kyiv");
  // A platform zone code is not an IANA name; an offset that differs from this machine's has no zone.
  const now = new Date();
  assert.equal(requestTimeZone({ headers: { cookie: "timeZoneCode=125" } }, now.getTimezoneOffset() + 60, now), null);
  assert.equal(requestTimeZone({ headers: {} }, now.getTimezoneOffset(), now), Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("grid records without item actions or read through parent-scoped permissions report no record privileges", async () => {
  const { gridRecord } = await import("../lib/native-services.mjs");
  const settings = { ItemActions: [{ Type: "CrmEntityFormView-DetailsAction" }] };
  const model = { kind: "subgrid", settings, entity: "sample_child", idColumn: "sample_childid", primaryName: "sample_name", view: { fetchXml: '<fetch><entity name="sample_child"><attribute name="sample_name"/></entity></fetch>' } };
  const layout = { Columns: [{ Type: 0, LogicalName: "sample_name" }] };
  const row = { sample_childid: "c0000000-0000-4000-8000-000000000001", sample_name: "Child", statecode: 0, statuscode: 1 };
  const context = (scope) => ({ metadata: {}, portal: { settings: {} }, identity: { id: "p" }, store: { rules: () => [{ scope }], allowed: () => true, get: () => row } });
  const flags = (record) => [record.CanRead, record.CanWrite, record.CanDelete, record.StateCode, record.StatusCode];
  assert.deepEqual(flags(gridRecord(row, model, layout, context("parent"))), [false, false, false, 0, 0]);
  assert.deepEqual(flags(gridRecord(row, model, layout, context("global"))), [true, true, true, 0, 1]);
  assert.deepEqual(flags(gridRecord(row, { ...model, kind: "list" }, layout, context("parent"))), [true, true, true, 0, 1]);
  // The platform assesses privileges only for grids with item actions (lookup dialogs, lists without ItemActions);
  // an unassessed inactive record reports StateCode 0 while its statecode attribute keeps the value.
  const inactive = { ...row, statecode: 1, statuscode: 2 };
  assert.deepEqual(flags(gridRecord(inactive, { ...model, kind: "list", settings: { ItemActions: [] } }, layout, context("global"))), [false, false, false, 0, 0]);
  assert.deepEqual(flags(gridRecord(inactive, { ...model, kind: "lookup", settings: undefined }, layout, context("global"))), [false, false, false, 0, 0]);
  assert.deepEqual(flags(gridRecord(inactive, { ...model, kind: "list" }, layout, context("global"))), [true, true, true, 1, 2]);
});

test("grid money values carry the record currency's symbol and precision", async () => {
  const { gridRecord } = await import("../lib/native-services.mjs");
  const currencyId = "a4000000-0000-4000-8000-000000000001";
  const metadata = { entities: { sample_thing: { fields: { sample_amount: { name: "sample_amount", dataverseType: "money", precision: 2 }, sample_rate: { name: "sample_rate", dataverseType: "money", precision: 2, precisionSource: 2 } } } } };
  const model = { kind: "list", entity: "sample_thing", idColumn: "sample_thingid", view: { fetchXml: '<fetch><entity name="sample_thing"><attribute name="sample_amount"/><attribute name="sample_rate"/></entity></fetch>' } };
  const layout = { Columns: [{ Type: 0, LogicalName: "sample_amount" }, { Type: 0, LogicalName: "sample_rate" }] };
  const row = { sample_thingid: "t1", sample_amount: 1999.5, sample_rate: 1.23456, transactioncurrencyid: { id: currencyId, name: "Euro" } };
  const store = { get: (entity) => (entity === "transactioncurrency" ? { currencysymbol: "€", currencyprecision: 4 } : row) };
  const record = gridRecord(row, model, layout, { metadata, portal: { settings: {} }, identity: {}, store });
  const formatted = Object.fromEntries(record.Attributes.map((a) => [a.Name, a.FormattedValue]));
  assert.deepEqual([formatted.sample_amount, formatted.sample_rate], ["€1,999.50", "€1.2346"]);
});

test("records created through the store get the same column defaults as seeded rows", async (t) => {
  const { importSolutionData, applySolutionData } = await import("../lib/solution-data.mjs");
  const { DataStore } = await import("../lib/data.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-record-defaults-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries({ "Entities/sample_thing/Entity.xml": entity, "OptionSets/sample_color.xml": colorSet })) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), body);
  }
  const metadata = await importSolutionData([root]);
  const store = new DataStore({ state: applySolutionData({ settings: { permissionMode: "permissive" } }, metadata, { webApiTables: ["sample_thing"] }) });
  const created = await store.create("sample_thing", { sample_name: "Created" }, { admin: true });
  const seeded = seedPresetBody({ tables: { sample_thing: [{ sample_thingid: "s", sample_name: "Seeded" }] } }, metadata.schema).tables.sample_thing[0];
  const pick = (row) => ({ flag: row.sample_flag, color: row.sample_color, state: row.statecode, status: row.statuscode, code: row.sample_code });
  assert.deepEqual(pick(created), { flag: true, color: 100000001, state: 0, status: 1, code: "T-1000" });
  assert.deepEqual(pick(seeded), pick(created));
  assert.ok(created.createdon && created.modifiedon === created.createdon);
});

test("system columns of system tables report managed metadata; custom tables and columns stay unmanaged", () => {
  const states = { type: "state", states: [{ value: 0, labels: { 1033: "Active" }, defaultStatus: 1, invariantName: "Active" }] };
  const column = (facts) => ({ columnMetadata: { type: "state", labels: { 1033: "Status" }, optionSet: states, ...facts } });
  const managedFlags = (metadata) => [metadata.IsManaged, metadata.DisplayName.UserLocalizedLabel.IsManaged, metadata.OptionSet.IsManaged, metadata.OptionSet.Options[0].IsManaged, metadata.OptionSet.Options[0].Label.UserLocalizedLabel.IsManaged];
  assert.deepEqual(managedFlags(attributeMetadata("sample_person", "statecode", column({ isCustomField: false, customTable: false }))), [true, true, true, true, true]);
  assert.deepEqual(managedFlags(attributeMetadata("sample_widget", "statecode", column({ isCustomField: false, customTable: true }))), [false, false, false, false, false]);
  assert.deepEqual(managedFlags(attributeMetadata("sample_person", "sample_extra", column({ isCustomField: true, customTable: false }))), [false, false, false, false, false]);
  const text = (facts) => attributeMetadata("sample_person", "sample_text", { columnMetadata: { type: "nvarchar", labels: { 1033: "Text" }, ...facts } });
  const locks = (m) => [m.IsCustomizable.CanBeChanged, m.IsRenameable.CanBeChanged, m.CanModifyAdditionalSettings.CanBeChanged, m.AutoNumberFormat, m.FormulaDefinition];
  assert.deepEqual(locks(text({ isCustomField: false, customTable: false })), [false, false, false, "", null]);
  assert.deepEqual(locks(text({ isCustomField: true, customTable: true })), [true, true, true, null, ""]);
  const required = (type, facts) => attributeMetadata("sample_person", "x", { columnMetadata: { type, requiredLevel: "systemrequired", ...facts } }).RequiredLevel.CanBeChanged;
  assert.deepEqual([required("primarykey", { customTable: true }), required("state", { isCustomField: false, customTable: false }), required("state", { isCustomField: false, customTable: true })], [false, false, true]);
});
