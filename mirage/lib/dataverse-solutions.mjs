// Solution export and import over the Dataverse Web API: ExportSolution (synchronous), ImportSolution and ImportSolutionAsync.
// Documented on Learn: web-api reference exportsolution, importsolution, importsolutionasync; ImportJob table (importjob);
// Miscellaneous privileges (prvExportCustomization, prvImportCustomization, held by System Administrator and System Customizer).
//
// Export builds a Solution zip (solution.xml, customizations.xml, [Content_Types].xml) from the components a solution holds:
// state.dataverse.solutionComponents, filled by metadata writes that name the solution in MSCRM.SolutionUniqueName
// (dataverse-metadata-relationships.mjs withSolutionMembership). Import reads the zip with the Solution reader
// (solution-schema.mjs readSolutionZip, parseSchemaDocument) and creates each component through the metadata create
// functions (createTable, createColumn, createOneToMany, createManyToMany, createGlobalSet), so the rows, mappings and
// metadata log match an API-created component. An import runs in one isolated store transaction: a throw discards it.
//
// Patches, staging, upgrades, async export and the preferred solution are in dataverse-solution-messages.mjs.
// A managed import records the managed layer of each table and column it brings (managedLayers, dataverse-solution-messages.mjs).
// Each component the import introduces records its solution (componentOrigin), so uninstall and upgrade remove only what a removed
// managed solution introduced. HoldingSolution imports stage an upgrade. Not modelled: ExportComponentsParams and the Export*Settings
// flags (ignored), workflow activation (PublishWorkflows is accepted and ignored), and the ImportJobKey lookup beyond the
// importjob id. App/form/view/workflow definitions and opaque asset bytes
// persist in bounded, per-solution transport layers; metadata rows share the record store and export retains current edits.
// Error messages and statuses not confirmed on Learn are unverified.
import { randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { DataError } from "./data-error.mjs";
import { contextUrl } from "./dataverse-odata.mjs";
import { readSolutionZip, parseSchemaDocument } from "./solution-schema.mjs";
import { parseSolutionXml, child, childText, labelsOf, pickLabel } from "./solution-xml.mjs";
import { createTable, createColumn, createKey, updateTable, activateKey } from "./dataverse-metadata-tables.mjs";
import { readSolutionAssetEntries, appendSolutionAssetLayer, latestSolutionAssetEntries, solutionAssetLayers } from "./dataverse-solution-assets.mjs";
import { solutionDocumentComponents, applySolutionPayloads, mergeSolutionCustomizationEntries } from "./dataverse-solution-components.mjs";
import { standardTableDef } from './dataverse-standard.mjs';
import { installSolutionMessages, entriesOfSolution, holdingArchive, assertStageable, metadataIdOf, componentsOf, addMemberRows } from "./dataverse-solution-messages.mjs";
import { registerInternalMessage } from "./dataverse-addon-common.mjs";
import { securityDefinitions, mergeInventory } from "./solution-inventory.mjs";
import { importSolutionSecurity } from "./dataverse-security.mjs";
import {
  createOneToMany, createManyToMany, createGlobalSet, requireMetadataPrivilege, addSolutionComponents, assertUnpatched, componentObjectId,
  lastMetadataSeq, managedLayerOf, managedLayerId, layerStack, activeOnTop, projectManagedFlags,
} from "./dataverse-metadata-relationships.mjs";

const DEFAULT_LCID = 1033;
// asyncoperation.operationtype of an ImportSolutionAsync job: 203 "Import Solution Async Operation" (Learn: asyncoperation).
export const IMPORT_SOLUTION_TYPE = 203;
const lower = (value) => String(value ?? "").toLowerCase();
const sameGuid = (a, b) => lower(idOf(a)) === lower(idOf(b));
const idOf = (value) => (value && typeof value === "object" ? value.id : value);
const invalid = (message) => new DataError(message, 400, "InvalidRequest"); // unverified: InvalidRequest code
const stamp = (api) => new Date(api.clock?.() ?? Date.now()).toISOString();
const rowsOf = (store, table) => store.state.tables?.[table] ?? [];

// Seeded Dataverse-only tables: solution, publisher and importjob (Learn: ImportJob table columns). The writable columns named
// here are the ones the simulator reads and writes; the rest of the documented columns are not modelled.
const UUID = { dataverseType: "uniqueidentifier" }, TEXT = { dataverseType: "nvarchar" }, INT = { dataverseType: "int" };
const DT = { dataverseType: "datetime" }, BIT = { dataverseType: "bit" }, LOOKUP = { dataverseType: "lookup" };
const SEEDS = {
  solution: {
    set: "solutions", id: "solutionid", name: "friendlyname",
    fields: { solutionid: UUID, uniquename: TEXT, friendlyname: TEXT, version: TEXT, ismanaged: BIT, publisherid: { dataverseType: "lookup", targets: ["publisher"] }, parentsolutionid: { dataverseType: "lookup", targets: ["solution"] }, description: TEXT, installedon: DT, createdon: DT, modifiedon: DT },
  },
  publisher: {
    set: "publishers", id: "publisherid", name: "friendlyname",
    fields: { publisherid: UUID, uniquename: TEXT, friendlyname: TEXT, customizationprefix: TEXT, customizationoptionvalueprefix: INT, description: TEXT, emailaddress: TEXT, supportingwebsiteurl: TEXT },
  },
  // One row per solution and component (Learn: solutioncomponent). Written by addSolutionComponentRows (metadata writes and imports).
  solutioncomponent: {
    set: "solutioncomponents", id: "solutioncomponentid", name: "solutioncomponentid",
    fields: {
      solutioncomponentid: UUID, solutionid: { dataverseType: "lookup", targets: ["solution"] }, objectid: UUID, componenttype: INT,
      rootcomponentbehavior: INT, ismetadata: BIT,
    },
  },
  importjob: {
    set: "importjobs", id: "importjobid", name: "name",
    fields: {
      importjobid: UUID, name: TEXT, data: TEXT, progress: { dataverseType: "float" }, solutionname: TEXT, solutionid: UUID,
      operationcontext: TEXT, importcontext: TEXT, startedon: DT, completedon: DT,
    },
  },
};

function seedMappings(store) {
  for (const [logical, def] of Object.entries(SEEDS)) {
    const mapping = (store.state.mappings[logical] ??= {
      logicalName: logical, entitySet: def.set, idColumn: def.id, nameColumn: def.name,
      userConfigured: true, dataverseOnly: true, fields: {}, relationships: {},
    });
    for (const [name, type] of Object.entries(def.fields)) mapping.fields[name] ??= type;
    store.state.tables[logical] ??= [];
  }
}

// ---------------------------------------------------------------------------
// Zip (stored or deflated entries, no ZIP64). The reader is solution-schema.mjs readSolutionZip.

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipOf(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x21, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// ---------------------------------------------------------------------------
// XML writing. The shapes are the ones solution-schema.mjs parseSchemaDocument reads back.

const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const el = (name, text) => (text === undefined || text === null || text === "" ? "" : `<${name}>${esc(text)}</${name}>`);
const nilEl = (name, text) => (text === undefined || text === null || text === "" ? `<${name} xsi:nil="true" />` : `<${name}>${esc(text)}</${name}>`);
const XSI = "http://www.w3.org/2001/XMLSchema-instance";
const ORG_VERSION = "9.2.0.0"; // the simulated organization's version, as the export header states it
const labelRows = (tag, labels, row) => `<${tag}>${Object.entries(labels ?? {}).map(([code, text]) => `<${row} description="${esc(text)}" languagecode="${esc(code)}" />`).join("")}</${tag}>`;
const BEHAVIOR_NUMBER = { UserLocal: 1, DateOnly: 2, TimeZoneIndependent: 3 };
const BEHAVIOR_NAME = { 1: "UserLocal", 2: "DateOnly", 3: "TimeZoneIndependent" };
// Web API @odata.type names for the column types the simulator creates through the metadata API.
const ATTRIBUTE_ODATA = {
  nvarchar: "String", memo: "Memo", int: "Integer", bigint: "BigInt", decimal: "Decimal", float: "Double", money: "Money", bit: "Boolean",
  datetime: "DateTime", picklist: "Picklist", multiselectpicklist: "MultiSelectPicklist", file: "File", image: "Image",
};
// Columns Dataverse creates on every table: never part of a solution's customizations.
const SYSTEM_COLUMNS = new Set([
  "createdon", "createdby", "createdonbehalfby", "modifiedon", "modifiedby", "modifiedonbehalfby", "statecode", "statuscode",
  "versionnumber", "ownerid", "owninguser", "owningteam", "owningbusinessunit", "importsequencenumber", "overriddencreatedon",
  "timezoneruleversionnumber", "utcconversiontimezonecode",
]);

function attributeXml(name, field, primary) {
  const f = field.columnMetadata ?? {};
  const type = field.dataverseType;
  const setName = field.globalOptionSet ?? (f.optionSet?.isGlobal ? f.optionSet.name : null);
  const options = f.optionSet?.options ?? [];
  const optionXml = !setName && options.length
    ? `<optionset Name="${esc(f.schemaName ?? name)}"><options>${options.map((o) => `<option value="${Number(o.value)}">${labelRows("labels", o.labels, "label")}</option>`).join("")}</options></optionset>`
    : "";
  // Member order as a Dataverse export writes it: Type, Name, LogicalName, RequiredLevel, DisplayMask, IsCustomField, the labels,
  // then Format, Behavior, MaxLength, MinValue, MaxValue and the option set. Accuracy stays (the reader takes it for precision).
  return `<attribute PhysicalName="${esc(f.schemaName ?? name)}">${[
    el("Type", type),
    el("Name", f.schemaName ?? name),
    el("LogicalName", name),
    el("RequiredLevel", f.requiredLevel),
    primary ? el("DisplayMask", "ValidForForm|ValidForRead|PrimaryName") : "",
    el("IsCustomField", 1),
    labelRows("displaynames", f.labels, "displayname"),
    labelRows("Descriptions", f.descriptionLabels, "Description"),
    el("Format", f.format),
    field.dateTimeBehavior ? el("Behavior", BEHAVIOR_NUMBER[field.dateTimeBehavior] ?? 1) : "",
    f.maxLength != null ? el("MaxLength", f.maxLength) : "",
    f.precision != null ? el("Accuracy", f.precision) : "",
    f.minValue != null ? el("MinValue", f.minValue) : "",
    f.maxValue != null ? el("MaxValue", f.maxValue) : "",
    setName ? el("OptionSetName", setName) : "",
    optionXml,
  ].join("")}</attribute>`;
}

function entityXml(mapping, logical, names) {
  const dm = mapping.dataverseMetadata ?? {};
  const labels = dm.labels ?? {};
  const attributes = [];
  for (const name of names) {
    const field = mapping.fields?.[name];
    if (!field || name === mapping.idColumn) continue;
    const primary = name === mapping.nameColumn;
    if (!primary && (ATTRIBUTE_ODATA[field.dataverseType] === undefined)) continue; // lookups travel as relationships
    attributes.push(attributeXml(name, field, primary));
  }
  // Member order as a Dataverse export writes it: Name (the display and logical names), then EntityInfo/entity with the labels,
  // the attributes and the flags. The primary id and name are not members: the reader takes them from the attributes.
  const displayName = labels.DisplayName?.[DEFAULT_LCID] ?? logical;
  return `<Entity><Name LocalizedName="${esc(displayName)}" OriginalName="${esc(logical)}" /><EntityInfo><entity Name="${esc(logical)}">${[
    labelRows("LocalizedNames", labels.DisplayName, "LocalizedName"),
    labelRows("LocalizedCollectionNames", labels.DisplayCollectionName, "LocalizedName"),
    labelRows("Descriptions", {}, "Description"),
    `<attributes>${attributes.join("")}</attributes>`,
    `<EntityKeys>${(mapping.alternateKeys ?? []).filter(key => !key.builtIn).map(key => `<EntityKey>${el("Name", key.schemaName ?? key.name)}${el("LogicalName", key.name)}${labelRows("displaynames", key.labels, "displayname")}<EntityKeyAttributes>${key.attributes.map(name => el("AttributeName", name)).join("")}</EntityKeyAttributes></EntityKey>`).join("")}</EntityKeys>`,
    el("EntitySetName", mapping.entitySet),
    el("TableType", mapping.tableType ?? dm.TableType),
    el("DataSourceId", dm.DataSourceId),
    el("DataProviderId", dm.DataProviderId),
    typeof dm.ChangeTrackingEnabled === 'boolean' ? el('ChangeTrackingEnabled', dm.ChangeTrackingEnabled ? 1 : 0) : '',
    typeof dm.IsOptimisticConcurrencyEnabled === 'boolean' ? el('IsOptimisticConcurrencyEnabled', dm.IsOptimisticConcurrencyEnabled ? 1 : 0) : '',
    el("OwnershipTypeMask", mapping.ownership ?? "OrganizationOwned"),
    el("IsActivity", dm.IsActivity === true ? 1 : 0),
    el("HasRelatedNotes", dm.HasNotes === true ? 1 : 0),
    el("HasRelatedActivities", 0),
  ].join("")}</entity></EntityInfo></Entity>`;
}

function relationshipSides(state, schemaName) {
  const want = lower(schemaName);
  const hits = [];
  for (const [logical, table] of Object.entries(state.mappings ?? {})) {
    for (const [nav, rel] of Object.entries(table.relationships ?? {})) {
      const name = rel.schemaName ?? (rel.intersect ? rel.intersect.entity : `${logical}_${nav}`);
      if (lower(name) === want) hits.push({ logical, nav, rel });
    }
  }
  return hits;
}

function relationshipXml(state, schemaName, sides) {
  const many = sides.find((side) => side.rel.intersect);
  if (many) {
    const { logical, nav, rel } = many;
    const [first, second] = [
      { entity: logical, navigation: nav, attribute: rel.intersect.from },
      { entity: rel.entity, navigation: rel.partner, attribute: rel.intersect.to },
    ];
    return `<EntityRelationship Name="${esc(schemaName)}">${[
      el("EntityRelationshipType", "ManyToMany"),
      relationshipFactsXml(rel),
      el("IntersectEntityName", rel.intersect.entity),
      el("Entity1LogicalName", first.entity),
      el("Entity2LogicalName", second.entity),
      el("Entity1IntersectAttribute", first.attribute),
      el("Entity2IntersectAttribute", second.attribute),
      `<EntityRelationshipRoles>${[first, second].map((role, index) => `<EntityRelationshipRole>${[
        el("AssociationRoleOrdinal", index + 1), el("EntityName", role.entity), el("NavigationPropertyName", role.navigation), el("IntersectAttribute", role.attribute),
        menuXml(index === 0 ? rel.menu1 : rel.menu2),
      ].join("")}</EntityRelationshipRole>`).join("")}</EntityRelationshipRoles>`,
    ].join("")}</EntityRelationship>`;
  }
  const referencing = sides.find((side) => side.rel.many === false);
  const { logical, nav, rel } = referencing;
  const lookupSchema = state.mappings[logical]?.fields?.[rel.from]?.columnMetadata?.schemaName ?? rel.from;
  // Member order as a Dataverse export writes it. ReferencedAttributeName is kept although a Dataverse export omits it: the
  // reader and createOneToMany take the referenced column from it.
  return `<EntityRelationship Name="${esc(schemaName)}">${[
    el("EntityRelationshipType", "OneToMany"),
    relationshipFactsXml(rel),
    el("IsHierarchical", rel.hierarchical ? 1 : 0),
    el("ReferencingEntityName", logical),
    el("ReferencedEntityName", rel.entity),
    el("ReferencingAttributeName", lookupSchema),
    el("ReferencedAttributeName", rel.to),
    ...Object.entries(rel.cascade ?? {}).map(([key, value]) => el(`Cascade${key[0].toUpperCase()}${key.slice(1)}`, value)),
    `<EntityRelationshipRoles><EntityRelationshipRole>${el("NavigationPropertyName", nav)}${el("RelationshipRoleType", 1)}${menuXml(rel.associatedMenu)}</EntityRelationshipRole><EntityRelationshipRole>${el("NavigationPropertyName", rel.partner)}${el("RelationshipRoleType", 0)}</EntityRelationshipRole></EntityRelationshipRoles>`,
  ].join("")}</EntityRelationship>`;
}

function relationshipFactsXml(rel) {
  return [el('IntroducedVersion', rel.introducedVersion),
    ...Object.entries({ isCustomizable: 'IsCustomizable', isManaged: 'IsManaged', isCustomRelationship: 'IsCustomRelationship', isValidForAdvancedFind: 'IsValidForAdvancedFind' })
      .map(([key, name]) => typeof rel[key] === 'boolean' ? el(name, rel[key] ? 1 : 0) : ''),
    el('RelationshipBehavior', rel.relationshipBehavior), el('SecurityTypes', rel.securityTypes)].join('');
}

function menuXml(menu) {
  if (!menu) return '';
  return [el('NavPaneDisplayOption', menu.behavior), el('NavPaneArea', menu.group), el('NavPaneOrder', menu.order),
    typeof menu.isCustomizable === 'boolean' ? el('IsCustomizable', menu.isCustomizable ? 1 : 0) : '',
    menu.labels ? labelRows('CustomLabels', menu.labels, 'CustomLabel') : ''].join('');
}

function optionSetXml(set) {
  return `<optionset Name="${esc(set.name)}">${[
    el("OptionSetType", "picklist"),
    el("IsGlobal", 1),
    el("IsCustomizable", set.isCustomizable === false ? 0 : 1),
    el('IntroducedVersion', set.introducedVersion),
    labelRows("displaynames", set.displayLabels, "displayname"),
    labelRows("Descriptions", set.descriptionLabels, "Description"),
    `<options>${(set.options ?? []).map((o) => `<option value="${Number(o.value)}"${o.externalValue === undefined ? '' : ` ExternalValue="${esc(o.externalValue)}"`}${o.isHidden === undefined ? '' : ` IsHidden="${o.isHidden ? 1 : 0}"`}>${labelRows("labels", o.labels, "label")}</option>`).join("")}</options>`,
  ].join("")}</optionset>`;
}

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';

// The archive for one solution: its components as recorded by the metadata writes that named it.
function buildSolutionArchive(state, row, { managed = false } = {}) {
  const publisher = rowsOf({ state }, "publisher").find((p) => sameGuid(p.publisherid, row.publisherid));
  const entries = entriesOfSolution(state, row.solutionid); // the solution's own membership rows (a patch exports its own components)
  const intersect = new Set(Object.values(state.mappings ?? {}).flatMap((m) => Object.values(m.relationships ?? {}).map((r) => r.intersect?.entity).filter(Boolean)));
  const attributes = new Map();
  for (const entry of entries) if (entry.kind === "attribute") attributes.set(lower(entry.logical), [...(attributes.get(lower(entry.logical)) ?? []), lower(entry.name)]);
  const roots = [], entities = [], relationships = [], optionSets = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.kind}|${lower(entry.logical)}|${lower(entry.name ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.kind === "entity") {
      const mapping = state.mappings?.[entry.logical];
      if (!mapping || intersect.has(entry.logical)) continue; // an intersect table is written by its relationship
      // The primary name column always travels with its table: the import reads the table's primary name from the archive.
      const members = attributes.get(lower(entry.logical)) ?? [];
      const primary = lower(mapping.nameColumn ?? "");
      entities.push(entityXml(mapping, entry.logical, primary && !members.includes(primary) ? [primary, ...members] : members));
      roots.push(`<RootComponent type="1" schemaName="${esc(entry.logical)}" behavior="0" />`);
    } else if (entry.kind === "relationship") {
      const sides = relationshipSides(state, entry.name);
      if (!sides.length) continue;
      relationships.push(relationshipXml(state, entry.name, sides));
      roots.push(`<RootComponent type="10" schemaName="${esc(entry.name)}" behavior="0" />`);
    } else if (entry.kind === "optionset") {
      const set = state.dataverse?.globalOptionSets?.[entry.logical];
      if (!set) continue;
      optionSets.push(optionSetXml(set));
      roots.push(`<RootComponent type="9" schemaName="${esc(set.name)}" behavior="0" />`);
    }
  }
  for (const member of state.tables.solutioncomponent ?? []) {
    if (!sameGuid(member.solutionid, row.solutionid) || ![26, 29, 60, 61, 62, 80].includes(member.componenttype)) continue;
    roots.push(`<RootComponent type="${member.componenttype}" id="{${esc(member.objectid)}}" behavior="0" />`);
  }
  // The root attributes, the SolutionManifest members (Publisher members too) and MissingDependencies are as a Dataverse export
  // writes them. MissingDependencies stays empty: no dependency is computed at export (RetrieveMissingDependencies does that).
  const manifest = `${XML_HEAD}<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="${DEFAULT_LCID}" generatedBy="Mirage" xmlns:xsi="${XSI}" OrganizationVersion="${ORG_VERSION}" OrganizationSchemaType="Standard" CRMServerServiceabilityVersion="${ORG_VERSION}"><SolutionManifest>${[
    el("UniqueName", row.uniquename),
    labelRows("LocalizedNames", { [DEFAULT_LCID]: row.friendlyname ?? row.uniquename }, "LocalizedName"),
    labelRows("Descriptions", row.description ? { [DEFAULT_LCID]: row.description } : {}, "Description"),
    el("Version", row.version ?? "1.0.0.0"),
    el("Managed", managed ? 1 : 0),
    `<Publisher>${[
      el("UniqueName", publisher?.uniquename ?? "mirage"),
      labelRows("LocalizedNames", { [DEFAULT_LCID]: publisher?.friendlyname ?? publisher?.uniquename ?? "Mirage" }, "LocalizedName"),
      labelRows("Descriptions", {}, "Description"),
      nilEl("EMailAddress", publisher?.emailaddress),
      nilEl("SupportingWebsiteUrl", publisher?.supportingwebsiteurl),
      el("CustomizationPrefix", publisher?.customizationprefix ?? "new"),
      el("CustomizationOptionValuePrefix", publisher?.customizationoptionvalueprefix ?? 10000),
    ].join("")}</Publisher>`,
    `<RootComponents>${roots.join("")}</RootComponents>`,
    "<MissingDependencies />",
  ].join("")}</SolutionManifest></ImportExportXml>`;
  // customizations.xml members in a Dataverse export's order. The ones the simulator does not model are written empty.
  const empty = (name) => `<${name} />`;
  const customizations = `${XML_HEAD}<ImportExportXml xmlns:xsi="${XSI}" OrganizationVersion="${ORG_VERSION}" OrganizationSchemaType="Standard" CRMServerServiceabilityVersion="${ORG_VERSION}">${[
    `<Entities>${entities.join("")}</Entities>`,
    empty("Roles"), empty("Workflows"), empty("FieldSecurityProfiles"), empty("Templates"), empty("EntityMaps"),
    `<EntityRelationships>${relationships.join("")}</EntityRelationships>`,
    empty("OrganizationSettings"),
    `<optionsets>${optionSets.join("")}</optionsets>`,
    empty("CustomControls"), empty("EntityDataProviders"),
    `<Languages><Language>${DEFAULT_LCID}</Language></Languages>`,
  ].join("")}</ImportExportXml>`;
  const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml" /></Types>`;
  latestSolutionAssetEntries(state, row.solutionid); // verify every persisted entry before exporting
  const payload = solutionAssetLayers(state, { solutionIds: [row.solutionid] }).flatMap(layer => layer.entries.map(entry => ({ name: entry.name, data: Buffer.from(entry.content, 'base64') })))
    .filter(entry => !/^(?:solution\.xml|\[Content_Types\]\.xml|Other\/Solution\.xml)$/i.test(entry.name));
  const files = mergeSolutionCustomizationEntries(payload, customizations, state);
  return zipOf([
    { name: "[Content_Types].xml", data: Buffer.from(types, "utf8") },
    { name: "solution.xml", data: Buffer.from(manifest, "utf8") },
    ...files,
  ]);
}

// ---------------------------------------------------------------------------
// Import: read the archive with the Solution reader, then create the components through the metadata create functions.

const NS_NAME = (labels, fallback) => (labels && Object.keys(labels).length ? labels : { [DEFAULT_LCID]: fallback });
const blockOf = (labels) => ({ LocalizedLabels: Object.entries(labels ?? {}).map(([code, Label]) => ({ Label, LanguageCode: Number(code) })) });

function readArchive(base64) {
  if (typeof base64 !== "string" || !base64.trim()) throw invalid("CustomizationFile is required and must be a base64 solution zip.");
  let docs, assetEntries;
  try {
    const bytes = Buffer.from(base64, "base64");
    assetEntries = readSolutionAssetEntries(bytes);
    docs = readSolutionZip(bytes);
  } catch (error) {
    throw new DataError("The solution file is invalid. The compressed file must contain the following files at its root: solution.xml, customizations.xml, and [Content_Types].xml.", 400, "0x80048060"); // Learn: ImportCustomizationsBadZipFileError
  }
  const archive = { manifest: null, entities: [], relationships: [], optionSets: [], assetEntries, payloadComponents: [], inventory: [] };
  for (const entry of assetEntries) {
    // Binary web resources and plug-in assemblies remain opaque. Only XML
    // component declarations are read; declarations/entities are rejected.
    if (/(?:^|\/)(?:customizations\.xml|Entities\/.*\.xml|AppModules\/.*\.xml|AppModuleSiteMaps\/.*\.xml|Workflows\/.*\.xml|WebResources\/[^/]+\.xml)$/i.test(entry.name))
      archive.payloadComponents.push(...solutionDocumentComponents(entry.data.toString('utf8'), entry));
  }
  for (const doc of docs) {
    const facts = parseSchemaDocument(doc.xml, doc);
    if (facts.solution) archive.manifest = { solution: facts.solution, xml: doc.xml };
    archive.entities.push(...(facts.entities ?? []));
    archive.relationships.push(...(facts.relationships ?? []));
    archive.optionSets.push(...(facts.optionSets ?? []));
    archive.inventory.push(...(facts.inventory ?? []).filter((record) => record.component === "role" || record.component === "fieldsecurityprofile"));
  }
  if (!archive.manifest?.solution.uniqueName) throw invalid("The solution file has no solution.xml with a UniqueName."); // unverified
  const root = parseSolutionXml(archive.manifest.xml, { recover: true });
  const manifest = child(root, "SolutionManifest") ?? root;
  const publisher = child(manifest, "Publisher");
  archive.solution = {
    uniqueName: archive.manifest.solution.uniqueName,
    friendlyName: pickLabel(labelsOf(child(manifest, "LocalizedNames")), DEFAULT_LCID),
    version: archive.manifest.solution.version ?? "1.0.0.0",
    managed: archive.manifest.solution.managed === "1",
    description: pickLabel(labelsOf(child(manifest, "Descriptions")), DEFAULT_LCID),
    publisher: {
      uniqueName: childText(publisher, "UniqueName"),
      friendlyName: pickLabel(labelsOf(child(publisher, "LocalizedNames")), DEFAULT_LCID),
      customizationPrefix: childText(publisher, "CustomizationPrefix"),
      optionValuePrefix: Number(childText(publisher, "CustomizationOptionValuePrefix")) || undefined,
    },
  };
  return archive;
}

// Columns the import creates: the supported types, excluding Dataverse's own columns and lookups (relationships make those).
function importableAttributes(entity) {
  return entity.attributes.filter((a) => a.isCustomField !== false && !SYSTEM_COLUMNS.has(a.name) && !a.attributeOf && ATTRIBUTE_ODATA[a.type] !== undefined);
}

function attributeBody(a, primary) {
  const body = {
    "@odata.type": `#Microsoft.Dynamics.CRM.${ATTRIBUTE_ODATA[a.type]}AttributeMetadata`,
    SchemaName: a.schemaName ?? a.name,
    DisplayName: blockOf(NS_NAME(a.labels, a.name)),
    Description: blockOf(a.descriptionLabels ?? {}),
    RequiredLevel: a.requiredLevel ?? "none",
  };
  if (primary) body.IsPrimaryName = true;
  if (a.maxLength != null) body.MaxLength = a.maxLength;
  if (a.precision != null) body.Precision = a.precision;
  if (a.minValue != null) body.MinValue = a.minValue;
  if (a.maxValue != null) body.MaxValue = a.maxValue;
  if (a.type === "nvarchar") body.FormatName = { Value: a.format ?? "Text" };
  if (a.type === "datetime") {
    body.Format = a.format ?? "DateAndTime";
    body.DateTimeBehavior = { Value: a.dateTimeBehavior ?? BEHAVIOR_NAME[1] };
  }
  if (a.type === "picklist" || a.type === "multiselectpicklist") {
    if (a.optionSetName && !a.optionSet) body["GlobalOptionSet@odata.bind"] = `GlobalOptionSetDefinitions(Name='${a.optionSetName}')`;
    else body.OptionSet = { Options: (a.optionSet?.options ?? []).map((o) => ({ Value: o.value, Label: blockOf(o.labels) })) };
  }
  if (a.type === "bit") {
    const option = (value) => ({ Label: blockOf((a.optionSet?.options ?? []).find((o) => o.value === value)?.labels ?? {}) });
    body.OptionSet = { TrueOption: option(1), FalseOption: option(0) };
  }
  return body;
}

function entityBody(entity, attributes) {
  const primaryFact = entity.attributes.find((a) => a.name === entity.primaryNameAttribute) ?? entity.attributes.find((a) => a.isPrimaryName);
  if (!primaryFact || primaryFact.type !== "nvarchar") throw invalid(`The table ${entity.logicalName} has no text primary name column.`); // unverified
  const primary = attributeBody(primaryFact, true);
  const others = attributes.filter((a) => a.name !== primaryFact.name).map((a) => attributeBody(a, false));
  return {
    "@odata.type": "#Microsoft.Dynamics.CRM.EntityMetadata",
    SchemaName: entity.schemaName ?? entity.logicalName,
    DisplayName: blockOf(NS_NAME(entity.labels, entity.logicalName)),
    DisplayCollectionName: blockOf(NS_NAME(entity.collectionLabels ?? entity.labels, entity.logicalName)),
    Description: blockOf({}),
    OwnershipType: /user/i.test(entity.ownership ?? "") ? "UserOwned" : "OrganizationOwned",
    IsActivity: entity.isActivity === true,
    HasActivities: false,
    HasNotes: entity.relatedNotes === true,
    Attributes: [primary, ...others],
  };
}

function globalSetBody(set) {
  return {
    Name: set.name,
    OptionSetType: "picklist",
    DisplayName: blockOf(NS_NAME(set.displayLabels, set.name)),
    Description: blockOf(set.descriptionLabels ?? {}),
    Options: (set.options ?? []).map((o) => ({ Value: o.value, Label: blockOf(o.labels) })),
  };
}

function relationshipBodies(rel) {
  if (rel.type === "one-to-many") {
    return {
      kind: "one-to-many",
      body: {
        SchemaName: rel.schemaName,
        ReferencedEntity: rel.referencedEntity,
        ReferencingEntity: rel.referencingEntity,
        ReferencedAttribute: rel.referencedAttribute,
        ReferencedEntityNavigationPropertyName: rel.referencedNavigation,
        ReferencingEntityNavigationPropertyName: rel.referencingNavigation,
        IsHierarchical: rel.isHierarchical === true,
        ...(rel.cascade ? { CascadeConfiguration: rel.cascade } : {}),
        Lookup: { SchemaName: rel.referencingAttributeSchemaName ?? rel.referencingAttribute, LogicalName: rel.referencingAttribute },
      },
      entity: rel.referencingEntity,
    };
  }
  return {
    kind: "many-to-many",
    body: {
      SchemaName: rel.schemaName,
      Entity1LogicalName: rel.entity1,
      Entity2LogicalName: rel.entity2,
      IntersectEntityName: rel.intersectEntity,
      Entity1IntersectAttribute: rel.attribute1,
      Entity2IntersectAttribute: rel.attribute2,
      Entity1NavigationPropertyName: rel.navigation1,
      Entity2NavigationPropertyName: rel.navigation2,
    },
    entity: rel.entity1,
  };
}

// The managed definition of a table, as a layer keeps it: the properties updateTable restores.
const entityLayerBody = (entity) => ({
  DisplayName: blockOf(NS_NAME(entity.labels, entity.logicalName)),
  DisplayCollectionName: blockOf(NS_NAME(entity.collectionLabels ?? entity.labels, entity.logicalName)),
  Description: blockOf({}),
  IsActivity: entity.isActivity === true,
  HasNotes: entity.relatedNotes === true,
});

// Applies the archive's components in the store (inside the caller's transaction) and returns its members: { kind, logical, name,
// created }. created is true when the import introduced the component (componentOrigin records it). A managed archive also pushes
// its layer onto each component's managed stack (state.dataverse.managedLayers, dataverse-metadata-relationships.mjs): tables and
// columns with their definition, keys and relationships for ownership. Learn solution-layers-alm and update-solutions: the
// incoming definition becomes active when this solution's layer is the top managed layer and no unmanaged customization sits on
// top; OverwriteUnmanagedCustomizations governs only that unmanaged customization (replaced with it, kept on top without it).
function apply(api, archive, { overwrite, origin, version, caller }, log) {
  const { store } = api;
  const state = store.state;
  const c = { api, origin, version, headers: {}, caller };
  const members = [];
  const layers = [];
  const managed = archive.solution.managed === true;
  // The solution's own id when it is already installed (an update replaces its layer in place); a new solution's entries get
  // their id in recordSolution.
  const ownId = (state.tables.solution ?? []).find((s) => lower(s.uniquename) === lower(archive.solution.uniqueName))?.solutionid ?? null;
  // An existing component without a managed stack is an unmanaged definition; with one, the customization above the stack counts.
  const unmanagedOnTop = (kind, logical, name = null) => {
    const layer = managedLayerOf(api, kind, logical, name);
    return layerStack(layer).length ? activeOnTop(api, layer) : true;
  };
  // This import's layer is the top managed layer: pushed on top, or its own entry already the top one.
  const becomesTop = (kind, logical, name = null) => {
    const stack = layerStack(managedLayerOf(api, kind, logical, name));
    const at = ownId ? stack.findIndex((entry) => lower(entry.solutionid) === lower(ownId)) : -1;
    return at === -1 || at === stack.length - 1;
  };
  // Whether an existing definition is replaced by the incoming one.
  const replaces = (kind, logical, name = null) => (managed ? becomesTop(kind, logical, name) && (overwrite || !unmanagedOnTop(kind, logical, name)) : overwrite);
  for (const set of archive.optionSets) {
    const existing = Object.keys(state.dataverse?.globalOptionSets ?? {}).some((name) => lower(name) === lower(set.name));
    if (existing) log.push({ kind: "optionset", name: set.name, action: "kept" });
    else {
      createGlobalSet(api, globalSetBody(set));
      // The metadata writer validates the supported writable contract; exported source facts
      // also survive transport without treating read-only metadata as API create parameters.
      const stored = state.dataverse.globalOptionSets[set.name];
      for (const key of ['introducedVersion', 'isCustomizable', 'externalTypeName', 'parentOptionSetName'])
        if (set[key] !== undefined) stored[key] = structuredClone(set[key]);
      for (const option of stored.options) {
        const source = set.options.find(item => item.value === option.value);
        for (const key of ['externalValue', 'isHidden']) if (source?.[key] !== undefined) option[key] = source[key];
      }
      log.push({ kind: "optionset", name: set.name, action: "created" });
    }
    members.push({ kind: "optionset", logical: set.name, name: null, created: !existing });
  }
  const intersects = new Set(archive.relationships.filter((r) => r.type === "many-to-many").map((r) => r.intersectEntity));
  for (const entity of archive.entities) {
    if (entity.isIntersect || intersects.has(entity.logicalName)) continue;
    const logical = entity.logicalName;
    const attributes = importableAttributes(entity);
    const key = `LogicalName='${logical}'`;
    const existed = state.mappings[logical] !== undefined;
    const outcome = new Map(attributes.map((a) => [a.name, "created"])); // a new table's columns are created with it
    const tableReplaced = existed && managed && replaces("entity", logical) && state.mappings[logical].dataverseMetadata?.createdByMetadataApi === true;
    if (!existed) {
      createTable(c, entityBody(entity, attributes)); // grants the table's privileges too
      log.push({ kind: "entity", name: logical, action: "created" });
    } else {
      if (tableReplaced) updateTable(c, key, entityLayerBody(entity));
      log.push({ kind: "entity", name: logical, action: tableReplaced ? "overwritten" : "kept" });
      const mapping = state.mappings[logical];
      for (const a of attributes) {
        const exists = Object.hasOwn(mapping.fields ?? {}, a.name);
        if (exists && !replaces("attribute", logical, a.name)) {
          outcome.set(a.name, "kept");
          log.push({ kind: "attribute", name: `${logical}.${a.name}`, action: "kept" });
          continue;
        }
        if (exists) delete mapping.fields[a.name]; // overwrite: the solution's definition replaces the unmanaged one; row values stay
        createColumn(c, key, attributeBody(a, false));
        outcome.set(a.name, exists ? "overwritten" : "created");
        log.push({ kind: "attribute", name: `${logical}.${a.name}`, action: exists ? "overwritten" : "created" });
      }
    }
    members.push({ kind: "entity", logical, name: null, created: !existed });
    const mapping = state.mappings[logical];
    if (!existed || overwrite) {
      if (entity.tableType !== undefined) mapping.tableType = entity.tableType;
      if (entity.isVirtual !== undefined) mapping.isVirtual = entity.isVirtual;
      for (const [source, property] of Object.entries({ dataSourceId: 'DataSourceId', dataProviderId: 'DataProviderId', changeTrackingEnabled: 'ChangeTrackingEnabled', isOptimisticConcurrencyEnabled: 'IsOptimisticConcurrencyEnabled' }))
        if (entity[source] !== undefined) (mapping.dataverseMetadata ??= {})[property] = entity[source];
    }
    if (!existed) {
      if (entity.entitySetName) {
        if (Object.entries(state.mappings).some(([name, other]) => name !== logical && lower(other.entitySet) === lower(entity.entitySetName)))
          throw invalid(`The entity set ${entity.entitySetName} already exists.`);
        mapping.entitySet = entity.entitySetName;
      }
      if (entity.primaryIdAttribute) mapping.idColumn = entity.primaryIdAttribute;
    }
    for (const source of attributes) {
      if (outcome.get(source.name) === 'kept') continue;
      const field = mapping.fields[source.name];
      field.columnMetadata = { ...field.columnMetadata, ...structuredClone(source) };
      const bucket = (((state.dataverse ??= {}).customColumns ??= {})[logical] ??= {});
      bucket[source.name] = structuredClone(field);
    }
    for (const sourceKey of entity.keys ?? []) {
      const exists = (mapping.alternateKeys ?? []).some(key => lower(key.name) === lower(sourceKey.name));
      if (!exists) createKey(c, key, { SchemaName: sourceKey.schemaName ?? sourceKey.name, KeyAttributes: sourceKey.attributes, DisplayName: blockOf(sourceKey.labels) });
      members.push({ kind: "key", logical, name: sourceKey.name, created: !exists });
    }
    for (const a of attributes) members.push({ kind: "attribute", logical, name: a.name, created: outcome.get(a.name) === "created" });
    if (managed) {
      const primary = (a) => a.name === entity.primaryNameAttribute || a.isPrimaryName === true; // the primary name column is never removed
      const entityKept = existed && !tableReplaced && unmanagedOnTop("entity", logical);
      layers.push({ kind: "entity", logical, name: null, body: entityLayerBody(entity), customizable: entity.isCustomizable !== false,
        applied: !existed || tableReplaced, kept: entityKept });
      for (const a of attributes.filter((x) => !primary(x))) {
        const kept = outcome.get(a.name) === "kept";
        layers.push({ kind: "attribute", logical, name: a.name, body: attributeBody(a, false), customizable: a.isCustomizable !== false,
          applied: !kept, kept: kept && unmanagedOnTop("attribute", logical, a.name) });
      }
      for (const sourceKey of entity.keys ?? []) layers.push({ kind: "key", logical, name: lower(sourceKey.name), body: null, applied: true, kept: false });
    }
  }
  for (const rel of archive.relationships) {
    const { kind, body, entity } = relationshipBodies(rel);
    const existed = relationshipSides(state, rel.schemaName).length > 0;
    if (existed) {
      log.push({ kind: "relationship", name: rel.schemaName, action: "kept" });
    } else {
      if (kind === "one-to-many") createOneToMany(api, body);
      else createManyToMany(api, body);
      for (const side of relationshipSides(state, rel.schemaName))
        for (const key of ['introducedVersion', 'isCustomizable', 'isManaged', 'isCustomRelationship', 'isValidForAdvancedFind', 'relationshipBehavior', 'securityTypes', 'associatedMenu', 'menu1', 'menu2', 'cascade'])
          if (rel[key] !== undefined) side.rel[key] = structuredClone(rel[key]);
      log.push({ kind: "relationship", name: rel.schemaName, action: "created" });
    }
    members.push({ kind: "relationship", logical: entity, name: rel.schemaName, created: !existed });
    if (managed) layers.push({ kind: "relationship", logical: entity, name: rel.schemaName, body: null, applied: true, kept: false });
  }
  if (managed) {
    const stacks = ((state.dataverse ??= {}).managedLayers ??= {});
    const seq = lastMetadataSeq(api); // the change log after the import: a later change is an active customization
    for (const { kind, logical, name, body, customizable, applied, kept } of layers) {
      const id = managedLayerId(api, kind, logical, name);
      const record = (stacks[id] ??= { kind, logical, name, stack: [], activeOnTop: false, seq });
      const stack = layerStack(record);
      const entry = { solutionid: ownId, version: archive.solution.version ?? null, body, customizable, seq };
      const at = ownId ? stack.findIndex((item) => lower(item.solutionid) === lower(ownId)) : -1;
      if (at >= 0) stack[at] = entry;
      else stack.push(entry);
      // The incoming definition is live: nothing customizes it yet. A kept unmanaged definition stays the active layer.
      if (applied) Object.assign(record, { activeOnTop: false, seq });
      else if (kept) record.activeOnTop = true;
    }
    projectManagedFlags(api);
  }
  return members;
}

// The solution and publisher rows, created or updated, and the membership of the imported components.
function recordSolution(api, archive, members) {
  const { store } = api;
  const info = archive.solution;
  const publisherRows = store.state.tables.publisher;
  let publisher = publisherRows.find((p) => lower(p.uniquename) === lower(info.publisher.uniqueName));
  if (!publisher && info.publisher.uniqueName) {
    publisher = { publisherid: randomUUID(), uniquename: info.publisher.uniqueName };
    publisherRows.push(publisher);
  }
  if (publisher) {
    Object.assign(publisher, {
      friendlyname: info.publisher.friendlyName ?? publisher.friendlyname ?? info.publisher.uniqueName,
      customizationprefix: info.publisher.customizationPrefix ?? publisher.customizationprefix,
      customizationoptionvalueprefix: info.publisher.optionValuePrefix ?? publisher.customizationoptionvalueprefix,
    });
  }
  const solutions = store.state.tables.solution;
  let row = solutions.find((s) => lower(s.uniquename) === lower(info.uniqueName));
  if (!row) {
    row = { solutionid: randomUUID(), uniquename: info.uniqueName, installedon: stamp(api) };
    solutions.push(row);
  }
  Object.assign(row, {
    friendlyname: info.friendlyName ?? info.uniqueName,
    version: info.version,
    ismanaged: info.managed,
    publisherid: publisher?.publisherid ?? null,
    description: info.description ?? null,
    modifiedon: stamp(api),
    createdon: row.createdon ?? stamp(api),
  });
  addSolutionComponents(api, info.uniqueName, members);
  const keyIds = new Set(members.filter(member => member.kind === 'key').map(member => componentObjectId(member, api.settings.organizationId)));
  addMemberRows(store, row.solutionid, componentsOf(store.state, api.settings.organizationId).filter(component => keyIds.has(component.id)));
  // A created component records the solution that introduced it (the base layer an uninstall or upgrade removes). The managed
  // layers this import recorded take the solution too.
  const dv = (store.state.dataverse ??= {});
  const origin = (dv.componentOrigin ??= {});
  for (const member of members) if (member.created) origin[lower(componentObjectId(member, api.settings.organizationId))] = row.solutionid;
  for (const layer of Object.values(dv.managedLayers ?? {})) for (const entry of layerStack(layer)) if (entry.solutionid == null) entry.solutionid = row.solutionid;
  return row;
}

function importLogXml(solution, log, error) {
  const rows = log.map((item) => `<Item kind="${esc(item.kind)}" name="${esc(item.name)}" action="${esc(item.action)}" />`).join("");
  return `${XML_HEAD}<ImportLog solution="${esc(solution)}"${error ? ' result="failed"' : ' result="succeeded"'}>${rows}${error ? `<Error>${esc(error)}</Error>` : ""}</ImportLog>`;
}

// The importjob row: created when the import starts (startedon), completed with its log and progress.
function writeJob(api, { jobId, archive, log, error, progress }) {
  const rows = api.store.state.tables.importjob;
  const solutionName = archive.solution.uniqueName;
  const solution = api.store.state.tables.solution.find((s) => lower(s.uniquename) === lower(solutionName));
  let row = rows.find((r) => sameGuid(r.importjobid, jobId));
  if (!row) {
    row = { importjobid: jobId, startedon: stamp(api) };
    rows.push(row);
  }
  Object.assign(row, {
    name: `Import ${solutionName}`,
    data: importLogXml(solutionName, log, error),
    progress,
    solutionname: solutionName,
    solutionid: solution?.solutionid ?? null,
    completedon: error || progress === 100 ? stamp(api) : null,
  });
  return row;
}

// Runs one import in one isolated transaction. A throw discards the components and rewinds the change log; the import job
// row records the failure in its own transaction, so the log of a failed run stays readable.
async function importArchive(api, archive, { overwrite, jobId, origin, version, caller }) {
  const log = [];
  const revision = api.changes?.current();
  let created = [];
  try {
    await api.change(() => api.store.transact(() => {
      const members = apply(api, archive, { overwrite, origin, version, caller }, log);
      created = members.filter((member) => member.kind === "key" && member.created);
      const solution = recordSolution(api, archive, members);
      appendSolutionAssetLayer(api.store.state, solution.solutionid, archive.assetEntries ?? [], archive.solution);
      // Security roles and field security profiles: the same import as the Solution source seed (dataverse-security.mjs).
      const name = archive.solution.uniqueName;
      const security = securityDefinitions(mergeInventory((archive.inventory ?? []).map((record) => ({ ...record, solution: name }))),
        { managed: archive.solution.managed === true ? new Set([lower(name)]) : new Set() });
      if (security.securityRoles.length || security.fieldSecurityProfiles.length)
        (api.store.state.dataverse ??= {}).securityDiagnostics = importSolutionSecurity(api.store, api.settings.organizationId, security, { solutionId: solution.solutionid });
      applySolutionPayloads(api.store.state, solution.solutionid, archive.payloadComponents ?? [], { overwrite, definitionOf: standardTableDef, entityId: logical => metadataIdOf(api, 'entity', logical) });
      writeJob(api, { jobId, archive, log, progress: 100 });
    }, { isolated: true }));
  } catch (error) {
    await api.store.flushCommittedEvents?.();
    api.changes?.rewind(revision);
    await api.change(() => api.store.transact(() => writeJob(api, { jobId, archive, log: [], error: error.message, progress: 0 })));
    throw error instanceof DataError ? error : invalid(`The solution import failed: ${error.message}`); // unverified: message text
  }
  // The imported keys start Pending; each gets its index job once the import has committed (Learn define-alternate-keys-entity).
  for (const member of created) await activateKey(api, member.logical, lower(member.name), caller?.systemuserid ?? null);
}

// ---------------------------------------------------------------------------
// The module

// Resolves with the asyncoperation row once it is Completed (statecode 3), for tests and tools that wait on an ImportSolutionAsync run.
export async function solutionImportJob(api, asyncId, { timeoutMs = 10000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const row = rowsOf(api.store, "asyncoperation").find((r) => sameGuid(r.asyncoperationid, asyncId));
    if (row?.statecode === 3) return row;
    if (Date.now() > until) throw new Error(`Import ${asyncId} did not complete within ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// The archive an import writes: a HoldingSolution import stages the upgrade (holdingArchive) after its checks pass (assertStageable).
function stagedArchive(api, archive, body) {
  if (body.HoldingSolution !== true) return archive;
  assertStageable(api.store, archive);
  return holdingArchive(archive);
}

export function install(api) {
  seedMappings(api.store);
  const { store } = api;
  installSolutionMessages(api, {
    readArchive,
    importArchive: (archive, options) => importArchive(api, archive, options),
    exportArchive: (row, options) => buildSolutionArchive(store.state, row, options),
  });
  const exportOperation = {
    name: "ExportSolution",
    kind: "action",
    binding: "unbound",
    signature: { params: [["SolutionName", "Edm.String"], ["Managed", "Edm.Boolean"]], response: [["ExportSolutionFile", "Edm.Binary"]] },
    handle(ctx) {
      requireMetadataPrivilege(api, ctx, "prvExportCustomization", "solution");
      const name = String(ctx.body?.SolutionName ?? "").trim();
      if (!name) throw invalid("SolutionName is required."); // unverified
      const row = rowsOf(store, "solution").find((s) => lower(s.uniquename) === lower(name) && s.parentsolutionid == null);
      // Learn: a missing solution fails the export with 0x80048037 (the message is Learn's; the 404 status is unverified).
      if (!row) throw new DataError("An error occurred while exporting a solution. The solution does not exist in this system.", 404, "NotFound", { innerCode: "0x80048037" });
      assertUnpatched(store, row);
      const zip = buildSolutionArchive(store.state, row, { managed: ctx.body?.Managed === true });
      return {
        status: 200,
        body: { "@odata.context": contextUrl(ctx.origin, ctx.version, "Microsoft.Dynamics.CRM.ExportSolutionResponse"), ExportSolutionFile: zip.toString("base64") },
      };
    },
  };
  const importOperation = {
    name: "ImportSolution",
    kind: "action",
    binding: "unbound",
    signature: { params: [["OverwriteUnmanagedCustomizations", "Edm.Boolean"], ["PublishWorkflows", "Edm.Boolean"], ["CustomizationFile", "Edm.Binary"], ["ImportJobId", "Edm.Guid"], ["HoldingSolution", "Edm.Boolean"]] },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, "prvImportCustomization", "solution");
      const body = ctx.body ?? {};
      const archive = readArchive(body.CustomizationFile);
      const target = stagedArchive(api, archive, body);
      const jobId = typeof body.ImportJobId === "string" && body.ImportJobId ? body.ImportJobId : randomUUID();
      await importArchive(api, target, { overwrite: body.OverwriteUnmanagedCustomizations === true, jobId, origin: ctx.origin, version: ctx.version, caller: ctx.caller });
      return undefined; // 204 No Content (Learn: the ImportSolution sample)
    },
  };
  const asyncOperation = {
    name: "ImportSolutionAsync",
    kind: "action",
    binding: "unbound",
    signature: {
      params: [["OverwriteUnmanagedCustomizations", "Edm.Boolean"], ["PublishWorkflows", "Edm.Boolean"], ["CustomizationFile", "Edm.Binary"], ["ImportJobId", "Edm.Guid"], ["HoldingSolution", "Edm.Boolean"]],
      response: [["ImportJobKey", "Edm.String"], ["AsyncOperationId", "Edm.Guid"]],
    },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, "prvImportCustomization", "solution");
      const body = ctx.body ?? {};
      const archive = readArchive(body.CustomizationFile);
      const target = stagedArchive(api, archive, body);
      const jobId = typeof body.ImportJobId === "string" && body.ImportJobId ? body.ImportJobId : randomUUID();
      const overwrite = body.OverwriteUnmanagedCustomizations === true;
      await api.change(() => api.store.transact(() => writeJob(api, { jobId, archive: target, log: [], progress: 0 }), { isolated: true }));
      // The import runs as an asyncoperation job on the shared queue (dataverse-async systemJob): Ready, then Locked, then
      // Completed with Succeeded (30) or Failed (31). The job's own error, when it fails, is the operation's message.
      const asyncId = await api.systemJob({
        name: `Import ${target.solution.uniqueName}`, operationtype: IMPORT_SOLUTION_TYPE, callerId: ctx.caller.systemuserid,
      }, () => importArchive(api, target, { overwrite, jobId, origin: ctx.origin, version: ctx.version, caller: ctx.caller }));
      return {
        status: 200,
        body: {
          "@odata.context": contextUrl(ctx.origin, ctx.version, "Microsoft.Dynamics.CRM.ImportSolutionAsyncResponse"),
          AsyncOperationId: asyncId,
          ImportJobKey: jobId,
        },
      };
    },
  };
  // RetrieveFormattedImportJobResults (Learn: the results are returned in Microsoft Excel format; the import log Mirage writes is
  // the data, unverified). The importjob row is written by the import, so an unknown id is the one error here.
  const formattedResults = {
    name: "RetrieveFormattedImportJobResults",
    kind: "function",
    binding: "unbound",
    signature: { params: [["ImportJobId", "Edm.Guid"]], response: [["FormattedResults", "Edm.String"]] },
    handle(ctx) {
      requireMetadataPrivilege(api, ctx, "prvReadImportJob", "importjob"); // unverified: privilege name from the table privilege pattern
      const id = String(ctx.params?.ImportJobId ?? "");
      const row = rowsOf(store, "importjob").find((r) => sameGuid(r.importjobid, id));
      if (!row) throw new DataError(`importjob With Id = ${id} Does Not Exist`, 404, "0x80040217"); // unverified: Dataverse message text
      return {
        status: 200,
        body: { "@odata.context": contextUrl(ctx.origin, ctx.version, "Microsoft.Dynamics.CRM.RetrieveFormattedImportJobResultsResponse"), FormattedResults: row.data ?? "" },
      };
    },
  };
  for (const op of [exportOperation, importOperation, asyncOperation, formattedResults]) api.registry.register(op);
  // ImportSolutions is internal to the platform (Learn: "For internal use only."), so it answers the not-simulated default.
  // https://learn.microsoft.com/dotnet/api/microsoft.crm.sdk.messages.importsolutionsrequest
  registerInternalMessage(api, {
    name: "ImportSolutions",
    kind: "action",
    binding: "unbound",
    signature: {
      params: [
        ["OverwriteUnmanagedCustomizations", "Edm.Boolean"], ["PublishWorkflows", "Edm.Boolean"], ["CustomizationFiles", "Edm.Binary"],
        ["ImportJobId", "Edm.Guid"], ["ConvertToManaged", "Edm.Boolean"], ["SkipProductUpdateDependencies", "Edm.Boolean"], ["HoldingSolution", "Edm.Boolean"],
      ],
    },
  });
}

export function reset(api) {
  api.store.transact(() => seedMappings(api.store));
}
