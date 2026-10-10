import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  parseSolutionXml,
  descendants,
  child,
  childText,
  labelsOf,
  pickLabel,
} from "./solution-xml.mjs";
import { SolutionFileCache, fileStamp, mapLimit } from "./solution-cache.mjs";
import { parsePluginDocument } from './exported-plugins.mjs';
import {
  standardTable,
  standardRelationships,
  pluralizeEntitySetName,
  IMPLICIT_SYSTEM_COLUMNS,
  STANDARD_LOOKUP_TARGETS,
} from "./solution-standard.mjs";

/** Bump when parsed facts change shape so cached results are never reused. */
export const SCHEMA_PARSER_ID = "schema@10";
const IO_CONCURRENCY = 24;
const XML_LIMIT = 128 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", "bin", "obj", ".paqvilo"]);
// Directories of an unpacked solution tree that carry table metadata.
const TREE_DIRS = /^(?:entities|other|optionsets|environmentvariabledefinitions|pluginassemblies|plugintypes|sdkmessageprocessingsteps|sdkmessages)$/i;
// Every standard Dataverse table owns these columns; a definition that exports its
// primary key and all of them is a full table export rather than a column patch.
const STANDARD_COLUMNS = ["createdon", "createdby", "modifiedon", "modifiedby", "statecode", "statuscode"];

const norm = (value) => String(value ?? "").trim().toLowerCase();
const valid = (name) => /^[a-z][\w]*$/i.test(String(name ?? ""));
const bit = (value) => (value === "1" ? true : value === "0" ? false : undefined);
const num = (value) => {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};
const compact = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ""));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const deepText = (node, name) => childText(node, name) ?? descendants(node, name)[0]?.text.trim();

/** Classify a path inside a solution tree (or loose metadata directory). */
export function classifySolutionPath(relative) {
  const p = String(relative).replace(/\\/g, "/");
  let m;
  if (/(?:^|\/)(?:PluginAssemblies|PluginTypes|SdkMessageProcessingSteps|SdkMessages)\/.+\.xml$/i.test(p)) return { kind: 'plugin' };
  if ((m = /(?:^|\/)Entities\/([^/]+)\/Entity\.xml$/i.exec(p))) return { kind: "entity", entityDir: m[1] };
  if ((m = /(?:^|\/)Entities\/([^/]+)\/FormXml\/.+\.xml$/i.exec(p))) return { kind: "form", entityDir: m[1] };
  if ((m = /(?:^|\/)Entities\/([^/]+)\/SavedQueries\/.+\.xml$/i.exec(p))) return { kind: "view", entityDir: m[1] };
  if (/(?:^|\/)OptionSets\/[^/]+\.xml$/i.test(p)) return { kind: "optionset" };
  if (/(?:^|\/)Relationships\/[^/]+\.xml$/i.test(p) || /(?:^|\/)relationships\.xml$/i.test(p)) return { kind: "relationships" };
  if (/(?:^|\/)customizations\.xml$/i.test(p)) return { kind: "customizations" };
  if (/(?:^|\/)Other\/Solution\.xml$/i.test(p) || /^solution\.xml$/i.test(p)) return { kind: "solution" };
  if ((m = /(?:^|\/)environmentvariabledefinitions\/([^/]+)\/environmentvariabledefinition\.xml$/i.exec(p)))
    return { kind: "envdef", envDir: m[1] };
  if ((m = /(?:^|\/)environmentvariabledefinitions\/([^/]+)\/environmentvariablevalues?\.(?:json|xml)$/i.exec(p)))
    return { kind: "envvalue", envDir: m[1] };
  return null;
}
const SCHEMA_KINDS = new Set(["entity", "relationships", "customizations", "optionset", "solution", "envdef", "envvalue", "xml", "plugin"]);

async function manifestOf(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const other = entries.find((e) => e.isDirectory() && !e.isSymbolicLink() && /^other$/i.test(e.name));
  if (!other) return null;
  try {
    const files = await fs.readdir(path.join(dir, other.name), { withFileTypes: true });
    const solution = files.find((e) => e.isFile() && /^solution\.xml$/i.test(e.name));
    return solution ? path.join(dir, other.name, solution.name) : null;
  } catch {
    return null;
  }
}

/** Unpacked solution trees at `dir` or one level below it (Other/Solution.xml present). */
export async function discoverSolutionTrees(dir) {
  const own = await manifestOf(dir);
  if (own) return [{ dir, manifest: own }];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const trees = [];
  for (const entry of entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name))
    .sort((a, b) => compare(a.name, b.name))) {
    const candidate = path.join(dir, entry.name);
    const manifest = await manifestOf(candidate);
    if (manifest) trees.push({ dir: candidate, manifest });
  }
  return trees;
}

async function walkFiles(dir, accept = () => true) {
  const files = [];
  let level = [dir];
  while (level.length) {
    const next = [];
    await mapLimit(level, IO_CONCURRENCY, async (current) => {
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (current !== dir || accept(entry.name)) next.push(file);
        } else if (entry.isFile()) files.push(file);
      }
    });
    level = next;
  }
  return files.sort(compare);
}

// ---------------------------------------------------------------------------
// Parsing (pure; results are JSON-serializable and cached per file)

function optionSetFacts(node) {
  return compact({
    name: node.attrs.Name,
    type: norm(childText(node, "OptionSetType")) || undefined,
    isGlobal: bit(childText(node, "IsGlobal")),
    options: descendants(node, "option").map((o) =>
      compact({ value: Number(o.attrs.value), labels: labelsOf(o) }),
    ),
    states: descendants(node, "state").map((o) =>
      compact({
        value: Number(o.attrs.value),
        labels: labelsOf(o),
        defaultStatus: num(o.attrs.defaultstatus),
        invariantName: o.attrs.invariantname,
      }),
    ),
    statuses: descendants(node, "status").map((o) =>
      compact({ value: Number(o.attrs.value), labels: labelsOf(o), state: num(o.attrs.state) }),
    ),
  });
}

const BEHAVIOR = { 1: "UserLocal", 2: "DateOnly", 3: "TimeZoneIndependent" };

function attributeFacts(node) {
  const t = (name) => childText(node, name);
  const name = norm(t("LogicalName") ?? t("Name") ?? node.attrs.PhysicalName);
  if (!valid(name)) return null;
  const optionSet = child(node, "optionset");
  const displayMask = t("DisplayMask");
  return compact({
    name,
    schemaName: node.attrs.PhysicalName ?? t("Name"),
    type: norm(t("Type")) || "nvarchar",
    requiredLevel: norm(t("RequiredLevel")) || undefined,
    displayMask,
    isPrimaryName: /(?:^|\|)PrimaryName(?:\||$)/i.test(displayMask ?? "") || undefined,
    validForCreate: bit(t("ValidForCreateApi")),
    validForUpdate: bit(t("ValidForUpdateApi")),
    validForRead: bit(t("ValidForReadApi")),
    isSecured: bit(t("IsSecured")),
    isCustomField: bit(t("IsCustomField")),
    isLogical: bit(t("IsLogical")),
    maxLength: num(t("MaxLength")),
    precision: num(t("Accuracy")),
    precisionSource: num(t("AccuracySource")),
    minValue: num(t("MinValue")),
    maxValue: num(t("MaxValue")),
    format: t("Format") || undefined,
    dateTimeBehavior: BEHAVIOR[t("Behavior")],
    autoNumberFormat: t("AutoNumberFormat") || undefined,
    appDefaultValue: t("AppDefaultValue"),
    attributeOf: norm(t("AttributeOf")) || undefined,
    lookupStyle: t("LookupStyle"),
    labels: labelsOf(child(node, "displaynames")),
    optionSetName: t("OptionSetName"),
    optionSet: optionSet ? optionSetFacts(optionSet) : undefined,
  });
}

function entityFacts(node, info) {
  const entityInfo = child(node, "EntityInfo");
  const header = child(entityInfo, "entity") ?? entityInfo;
  const logical = norm(
    header?.attrs?.Name || childText(node, "Name") || childText(node, "LogicalName") || info.entityDir,
  );
  if (!valid(logical)) return null;
  const h = (name) => childText(header, name);
  const attributes = (child(header, "attributes")?.children ?? [])
    .filter((item) => item.name === "attribute")
    .map(attributeFacts)
    .filter(Boolean);
  // Alternate keys (<EntityKeys>): unique column sets, addressable as set(column='value').
  const keys = (child(header, "EntityKeys")?.children ?? [])
    .filter((item) => item.name === "EntityKey")
    .map((key) => {
      const schemaName = childText(key, "Name");
      const name = norm(childText(key, "LogicalName") || schemaName);
      const columns = (child(key, "EntityKeyAttributes")?.children ?? [])
        .filter((item) => item.name === "AttributeName")
        .map((item) => norm(item.text));
      if (!valid(name) || !columns.length || !columns.every(valid)) return null;
      return compact({ name, schemaName, attributes: columns, labels: labelsOf(child(key, "displaynames")) });
    })
    .filter(Boolean);
  const names = new Set(attributes.map((a) => a.name));
  const primaryKey = attributes.find((a) => a.type === "primarykey")?.name;
  const primaryName = attributes.find((a) => a.isPrimaryName)?.name;
  return compact({
    logicalName: logical,
    entitySetName: valid(h("EntitySetName")) ? h("EntitySetName") : undefined,
    logicalCollectionName: valid(h("LogicalCollectionName") ?? h("CollectionName"))
      ? (h("LogicalCollectionName") ?? h("CollectionName"))
      : undefined,
    primaryIdAttribute: norm(h("PrimaryIdAttribute")) || primaryKey,
    primaryNameAttribute: norm(h("PrimaryNameAttribute")) || primaryName,
    ownership: h("OwnershipTypeMask"),
    isActivity: bit(h("IsActivity")),
    // Document management (SharePoint document locations) enabled for the table.
    documentManagement: bit(h("IsDocumentManagementEnabled")),
    isIntersect: bit(h("IsIntersect")),
    labels: labelsOf(child(header, "LocalizedNames")),
    collectionLabels: labelsOf(child(header, "LocalizedCollectionNames")),
    // Virtual tables (a data source, e.g. SharePoint through the virtual connector) have
    // no standard system columns: their definition is complete with the primary key.
    isVirtual: h("DataSourceId") ? true : undefined,
    // A table a solution includes unmodified exports no columns (<entity unmodified="1">).
    unmodified: header?.attrs?.unmodified === "1" && !attributes.length ? true : undefined,
    fullDefinition: Boolean(primaryKey) && (Boolean(h("DataSourceId")) || STANDARD_COLUMNS.every((column) => names.has(column))),
    attributes,
    keys: keys.length ? keys : undefined,
  });
}

/*
 * A multi-table lookup has one single-valued navigation property per target table (Learn,
 * webapi/web-api-navigation-properties#multi-table-lookups). The Note table reference names
 * every annotation.objectid navigation objectid_<table> (objectid_contact, objectid_chat ...)
 * and the knowledgearticle, mspp_website and adx_portalcomment references name
 * sharepointdocumentlocation.regardingobjectid ones regardingobjectid_<table>. Solution
 * exports of these relationships can omit EntityRelationshipRoles; they then get that name
 * instead of the lookup's schema name, which every target table would share (ObjectId).
 */
const MULTI_TABLE_NAVIGATION = new Map([
  ["annotation.objectid", "objectid"],
  ["sharepointdocumentlocation.regardingobjectid", "regardingobjectid"],
]);
const multiTableNavigation = (relationship) => {
  const prefix = MULTI_TABLE_NAVIGATION.get(`${relationship.referencingEntity}.${relationship.referencingAttribute}`);
  return prefix ? `${prefix}_${relationship.referencedEntity}` : undefined;
};

function relationshipFacts(node) {
  const schemaName = node.attrs.Name;
  if (!valid(schemaName) || !node.children.length) return null;
  const t = (name) => deepText(node, name);
  const type = norm(t("EntityRelationshipType"));
  const roles = (child(node, "EntityRelationshipRoles")?.children ?? [])
    .filter((item) => item.name === "EntityRelationshipRole")
    .map((role) =>
      compact({
        roleType: childText(role, "RelationshipRoleType"),
        ordinal: childText(role, "AssociationRoleOrdinal"),
        navigation: childText(role, "NavigationPropertyName"),
        entity: norm(childText(role, "EntityName")) || undefined,
        attribute: norm(childText(role, "IntersectAttribute")) || undefined,
      }),
    );
  if (type === "onetomany") {
    const referencingAttributeSchemaName = t("ReferencingAttributeName") || t("ReferencingAttribute");
    // The relationship's cascade configuration as the Solution XML states it (CascadeType
    // names: Cascade, Active, UserOwned, NoCascade, RemoveLink, Restrict). Solution exports
    // carry Assign, Delete, Archive, Reparent, Share, Unshare and RollupView; Merge is not
    // exported. The data store enforces delete (lib/data.mjs).
    const cascade = compact({
      assign: t("CascadeAssign") || undefined,
      delete: t("CascadeDelete") || undefined,
      archive: t("CascadeArchive") || undefined,
      reparent: t("CascadeReparent") || undefined,
      share: t("CascadeShare") || undefined,
      unshare: t("CascadeUnshare") || undefined,
      rollupView: t("CascadeRollupView") || undefined,
    });
    const facts = compact({
      schemaName,
      type: "one-to-many",
      referencingEntity: norm(t("ReferencingEntityName") || t("ReferencingEntity")),
      referencedEntity: norm(t("ReferencedEntityName") || t("ReferencedEntity")),
      referencingAttribute: norm(referencingAttributeSchemaName),
      referencingAttributeSchemaName,
      referencedAttribute: norm(t("ReferencedAttributeName") || t("ReferencedAttribute")) || undefined,
      referencingNavigation: roles.find((r) => r.roleType === "1")?.navigation,
      referencedNavigation: roles.find((r) => r.roleType === "0")?.navigation,
      isHierarchical: bit(t("IsHierarchical")),
      cascade: Object.keys(cascade).length ? cascade : undefined,
    });
    return valid(facts.referencingEntity) && valid(facts.referencedEntity) && valid(facts.referencingAttribute)
      ? facts
      : null;
  }
  if (type === "manytomany") {
    const byOrdinal = (ordinal, index) => roles.find((r) => r.ordinal === String(ordinal)) ?? roles[index];
    const first = byOrdinal(1, 0),
      second = byOrdinal(2, 1);
    const facts = compact({
      schemaName,
      type: "many-to-many",
      intersectEntity: norm(t("IntersectEntityName")),
      entity1: norm(t("FirstEntityName") || t("Entity1Name") || t("Entity1LogicalName") || first?.entity),
      entity2: norm(t("SecondEntityName") || t("Entity2Name") || t("Entity2LogicalName") || second?.entity),
      attribute1: norm(t("Entity1IntersectAttribute") || t("FirstEntityIntersectAttribute") || first?.attribute) || undefined,
      attribute2: norm(t("Entity2IntersectAttribute") || t("SecondEntityIntersectAttribute") || second?.attribute) || undefined,
      navigation1: first?.navigation,
      navigation2: second?.navigation,
    });
    return valid(facts.intersectEntity) && valid(facts.entity1) && valid(facts.entity2) ? facts : null;
  }
  return null;
}

function solutionFacts(root) {
  const manifest = child(root, "SolutionManifest") ?? root;
  return compact({
    uniqueName: childText(manifest, "UniqueName"),
    version: childText(manifest, "Version"),
    managed: childText(manifest, "Managed"),
    publisherPrefix: childText(child(manifest, "Publisher"), "CustomizationPrefix"),
    rootComponents: descendants(manifest, "RootComponent").map((c) =>
      compact({ type: num(c.attrs.type), schemaName: c.attrs.schemaName, id: c.attrs.id, behavior: num(c.attrs.behavior) }),
    ),
  });
}

function envDefinitionFacts(root, envDir) {
  const t = (name) => childText(root, name);
  return compact({
    schemaName: root.attrs.schemaname ?? envDir,
    labels: labelsOf(child(root, "displayname")),
    defaultDisplayName: child(root, "displayname")?.attrs.default,
    descriptionLabels: labelsOf(child(root, "description")),
    type: num(t("type")),
    defaultValue: t("defaultvalue"),
    isRequired: bit(t("isrequired")),
    secretStore: num(t("secretstore")),
    valueSchema: t("valueschema"),
    introducedVersion: t("introducedversion"),
  });
}

function envValueFacts(text, kind, envDir) {
  const rows = [];
  if (/^\s*[{[]/.test(text)) {
    const json = JSON.parse(text);
    const container = json?.environmentvariablevalues ?? json;
    const values = container?.environmentvariablevalue ?? container;
    for (const row of Array.isArray(values) ? values : [values])
      if (row && typeof row === "object")
        rows.push(
          compact({
            schemaName: row.schemaname ?? envDir,
            valueId: norm(row["@environmentvariablevalueid"] ?? row.environmentvariablevalueid) || undefined,
            value: row.value == null ? undefined : String(row.value),
          }),
        );
    return rows;
  }
  const root = parseSolutionXml(text);
  const values = root.name === "environmentvariablevalue" ? [root] : descendants(root, "environmentvariablevalue");
  for (const node of values)
    rows.push(
      compact({
        schemaName: node.attrs.schemaname ?? envDir,
        valueId: norm(node.attrs.environmentvariablevalueid) || undefined,
        value: childText(node, "value") ?? undefined,
      }),
    );
  return rows;
}

/** Parse one solution document into schema facts. */
export function parseSchemaDocument(text, info = {}) {
  const facts = { entities: [], relationships: [], optionSets: [], envDefinitions: [], envValues: [] };
  if (info.kind === "envvalue") {
    facts.envValues = envValueFacts(text, info.kind, info.envDir);
    return facts;
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("XML external declarations are not supported");
  const root = parseSolutionXml(text, { recover: true });
  if (/<(?:PluginAssembly|PluginType|SdkMessageProcessingStep|SdkMessage)[\s>]/i.test(text)) facts.plugins = parsePluginDocument(text);
  if (root.recovered) facts.recovered = root.recovered;
  if (info.kind === "solution" || root.name === "ImportExportXml" && child(root, "SolutionManifest"))
    facts.solution = solutionFacts(root);
  if (info.kind === "envdef" || root.name === "environmentvariabledefinition") {
    facts.envDefinitions.push(envDefinitionFacts(root, info.envDir));
    return facts;
  }
  const entityNodes = root.name === "Entity" ? [root] : descendants(root, "Entity");
  for (const node of entityNodes) {
    const entity = entityFacts(node, info);
    if (entity) facts.entities.push(entity);
  }
  for (const node of root.name === "EntityRelationship" ? [root] : descendants(root, "EntityRelationship")) {
    const relationship = relationshipFacts(node);
    if (relationship) facts.relationships.push(relationship);
  }
  const globalSets =
    root.name === "optionset" ? [root] : (child(root, "optionsets")?.children ?? []).filter((n) => n.name === "optionset");
  for (const node of globalSets)
    if (node.attrs.Name) facts.optionSets.push(optionSetFacts(node));
  return facts;
}

// ---------------------------------------------------------------------------
// ZIP (in memory; no archive path is written to disk)

export function readSolutionZip(buffer) {
  if (buffer.length > 256 * 1024 * 1024) throw new Error("Solution archive exceeds the 256 MiB limit.");
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("Solution ZIP end directory is missing.");
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6))
    throw new Error("Multi-volume solution archives are not supported.");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("ZIP64 solution archives are not supported.");
  const documents = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid solution ZIP directory.");
    const flags = buffer.readUInt16LE(offset + 8),
      method = buffer.readUInt16LE(offset + 10),
      size = buffer.readUInt32LE(offset + 20),
      uncompressed = buffer.readUInt32LE(offset + 24),
      nameLength = buffer.readUInt16LE(offset + 28),
      extraLength = buffer.readUInt16LE(offset + 30),
      commentLength = buffer.readUInt16LE(offset + 32),
      localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replaceAll("\\", "/");
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.startsWith("/") || name.split("/").includes("..") || /^[a-z]:/i.test(name))
      throw new Error("Solution ZIP contains a traversal path.");
    const classified = classifySolutionPath(name);
    if (!classified || !SCHEMA_KINDS.has(classified.kind)) continue;
    if (flags & 1) throw new Error("Encrypted solution XML entries are not supported.");
    if (uncompressed > XML_LIMIT || size > XML_LIMIT || localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error("Invalid or oversized solution XML entry.");
    const dataOffset = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataOffset + size > buffer.length) throw new Error("Truncated solution XML archive entry.");
    const compressed = buffer.subarray(dataOffset, dataOffset + size);
    let bytes;
    if (method === 0) bytes = compressed;
    else if (method === 8) bytes = inflateRawSync(compressed, { maxOutputLength: XML_LIMIT });
    else throw new Error(`Unsupported ZIP XML compression method ${method}.`);
    if (bytes.length !== uncompressed) throw new Error("Solution ZIP XML size mismatch.");
    documents.push({ name, xml: bytes.toString("utf8"), ...classified });
  }
  return documents;
}

// ---------------------------------------------------------------------------
// Scan: inputs -> layers -> parsed schema documents (cached)

/**
 * Discover and parse the schema-relevant files of the selected solution roots.
 * `order: "explicit"` keeps the root order and orders solution trees inside each
 * root by definition-before-extension; `order: "derived"` applies that rule across
 * all roots (used for automatically discovered roots).
 */
export async function scanSolutionSources(roots = [], { cache, cacheFile, order = "explicit" } = {}) {
  if (typeof roots === "string") roots = [roots];
  cache ??= await SolutionFileCache.open(cacheFile ?? null);
  const diagnostics = [];
  const layers = [];
  const inputs = [];
  for (const [inputIndex, root] of roots.filter(Boolean).entries()) {
    let absolute = path.resolve(root);
    let stat;
    try {
      absolute = await fs.realpath(absolute);
      stat = await fs.stat(absolute);
    } catch (error) {
      inputs.push({ input: absolute, type: "missing" });
      diagnostics.push({ code: "SOLUTION_ROOT_READ_FAILED", source: absolute, message: error.message });
      continue;
    }
    if (stat.isDirectory()) {
      const trees = await discoverSolutionTrees(absolute);
      const input = { input: absolute, type: "directory", trees: [] };
      inputs.push(input);
      if (!trees.length) trees.push({ dir: absolute, manifest: null, loose: true });
      for (const tree of trees) {
        const files = (
          await walkFiles(tree.dir, tree.loose ? () => true : (name) => TREE_DIRS.test(name))
        ).flatMap((file) => {
          const classified = classifySolutionPath(path.relative(tree.dir, file));
          return classified ? [{ path: file, ...classified }] : [];
        });
        input.trees.push(layers.length);
        layers.push({ inputIndex, input: absolute, dir: tree.dir, manifestFile: tree.manifest, loose: Boolean(tree.loose), type: "directory", files });
      }
    } else if (/\.zip$/i.test(absolute)) {
      inputs.push({ input: absolute, type: "zip", trees: [layers.length] });
      layers.push({ inputIndex, input: absolute, dir: absolute, type: "zip", files: [{ path: absolute, kind: "zip" }] });
    } else if (/\.xml$/i.test(absolute)) {
      inputs.push({ input: absolute, type: "xml", trees: [layers.length] });
      layers.push({ inputIndex, input: absolute, dir: path.dirname(absolute), type: "xml", files: [{ path: absolute, kind: classifySolutionPath(path.basename(absolute))?.kind ?? "xml" }] });
    } else {
      inputs.push({ input: absolute, type: "unsupported" });
      diagnostics.push({
        code: "SOLUTION_ROOT_UNSUPPORTED",
        source: absolute,
        message: "Use an unpacked solution directory, XML metadata or solution ZIP.",
      });
    }
  }
  // Stat every candidate once; parsed results are reused for unchanged files.
  const allFiles = layers.flatMap((layer) => layer.files);
  await mapLimit(allFiles, IO_CONCURRENCY * 2, async (file) => {
    try {
      const stamp = await fileStamp(file.path);
      file.stamp = stamp.stamp;
      file.size = stamp.size;
    } catch (error) {
      file.error = error.message;
    }
  });
  const parseFile = async (file) => {
    if (file.error) {
      diagnostics.push({ code: "SOLUTION_XML_READ_FAILED", source: file.path, message: file.error });
      return [];
    }
    if (file.size > XML_LIMIT && file.kind !== "zip") {
      diagnostics.push({ code: "SOLUTION_XML_TOO_LARGE", source: file.path, message: "XML file exceeds the metadata size limit." });
      return [];
    }
    try {
      if (file.kind === "zip") {
        const { value, hash } = await cache.parse(
          file.path,
          SCHEMA_PARSER_ID + ":zip",
          (buffer) =>
            readSolutionZip(buffer).map((entry) => ({
              name: entry.name,
              kind: entry.kind,
              facts: parseSchemaDocument(entry.xml, entry),
              hash: createHash("sha256").update(entry.xml).digest("hex"),
            })),
          { stamp: file.stamp },
          { binary: true },
        );
        return value.map((entry) => ({ file: `${file.path}!/${entry.name}`, kind: entry.kind, facts: entry.facts, hash: entry.hash ?? hash }));
      }
      const { value, hash } = await cache.parse(file.path, SCHEMA_PARSER_ID, (text) => parseSchemaDocument(text, file), { stamp: file.stamp });
      return [{ file: file.path, kind: file.kind, facts: value, hash }];
    } catch (error) {
      diagnostics.push({
        code: file.kind === "envvalue" ? "SOLUTION_ENVVAR_INVALID" : "SOLUTION_XML_INVALID",
        source: file.path,
        message: error.message,
      });
      return [];
    }
  };
  const schemaFiles = allFiles.filter((file) => SCHEMA_KINDS.has(file.kind) || file.kind === "zip");
  const parsed = await mapLimit(schemaFiles, IO_CONCURRENCY, parseFile);
  const byFile = new Map(schemaFiles.map((file, index) => [file, parsed[index]]));
  for (const layer of layers) {
    layer.documents = layer.files.flatMap((file) => byFile.get(file) ?? []);
    const manifest = layer.documents.find((doc) => doc.facts.solution)?.facts.solution;
    if (manifest) layer.solution = manifest;
    layer.name = manifest?.uniqueName ?? path.basename(layer.dir);
  }
  const ordered = orderSolutionLayers(layers, { order, diagnostics });
  ordered.forEach((layer, index) => (layer.index = index));
  return { inputs, layers: ordered, diagnostics, cache, order };
}

/**
 * Definition-before-extension: a layer that exports the full definition of a table
 * (primary key plus the standard system columns) precedes layers that export only
 * columns or a shell of that table. Ties keep root order, then solution name order.
 */
export function orderSolutionLayers(layers, { order = "explicit", diagnostics = [] } = {}) {
  const definitionsOf = (members) => {
    const full = new Set(),
      partial = new Set();
    for (const layer of members)
      for (const doc of layer.documents ?? [])
        for (const entity of doc.facts.entities ?? [])
          (entity.fullDefinition ? full : partial).add(entity.logicalName);
    for (const name of full) partial.delete(name);
    return { full, partial };
  };
  // Stable topological sort; `tie` orders independent nodes, cycles fall back to it.
  const sort = (nodes, definitions, tie, describe) => {
    const before = new Map(nodes.map((node) => [node, new Set()]));
    for (const a of nodes)
      for (const b of nodes)
        if (a !== b && [...definitions.get(a).full].some((name) => definitions.get(b).partial.has(name)))
          before.get(b).add(a);
    const placed = [];
    const done = new Set();
    while (placed.length < nodes.length) {
      const ready = nodes.filter((node) => !done.has(node) && [...before.get(node)].every((dep) => done.has(dep))).sort(tie);
      let next = ready[0];
      if (next === undefined) {
        next = nodes.filter((node) => !done.has(node)).sort(tie)[0];
        diagnostics.push({
          code: "SOLUTION_ORDER_CYCLE",
          layer: describe(next),
          message: "Solution layers define and extend each other's tables; the remaining layers keep name order.",
        });
      }
      done.add(next);
      placed.push(next);
    }
    return placed;
  };
  const inputs = [...new Set(layers.map((layer) => layer.inputIndex))].sort((a, b) => a - b);
  const membersOf = (input) => layers.filter((layer) => layer.inputIndex === input);
  const inputOrder =
    order === "derived"
      ? sort(
          inputs,
          new Map(inputs.map((input) => [input, definitionsOf(membersOf(input))])),
          (a, b) => compare(path.basename(membersOf(a)[0].input).toLowerCase(), path.basename(membersOf(b)[0].input).toLowerCase()) || a - b,
          (input) => membersOf(input)[0].input,
        )
      : inputs;
  const result = [];
  for (const input of inputOrder) {
    const members = membersOf(input);
    result.push(
      ...sort(
        members,
        new Map(members.map((layer) => [layer, definitionsOf([layer])])),
        (a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.dir, b.dir),
        (layer) => layer.dir,
      ),
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Merge layers into one schema

// Documented columns read by portal code (Microsoft Dataverse table reference pages).
const ENVIRONMENT_TABLE_COLUMNS = {
  environmentvariabledefinition: [
    "environmentvariabledefinitionid:primarykey",
    "schemaname:nvarchar:100",
    "displayname:nvarchar:100",
    "description:memo:2000",
    "defaultvalue:memo:2000",
    "type:picklist",
    "isrequired:bit",
    "secretstore:picklist",
    "valueschema:memo:2000",
    "statecode:state",
    "statuscode:status",
  ],
  environmentvariablevalue: [
    "environmentvariablevalueid:primarykey",
    "environmentvariabledefinitionid:lookup",
    "schemaname:nvarchar:100",
    "value:memo:2000",
    "statecode:state",
    "statuscode:status",
  ],
};

const SIMPLE_TYPES = {
  memo: "textarea",
  ntext: "textarea",
  bit: "boolean",
  picklist: "number",
  state: "number",
  status: "number",
  int: "number",
  decimal: "number",
  float: "number",
  money: "number",
  datetime: "date",
  lookup: "lookup",
  customer: "lookup",
  owner: "lookup",
};

/** Combine ordered layers: later layers replace earlier column definitions and table properties they export. */
export function buildSolutionSchema(scan, { lcid = 1033 } = {}) {
  const diagnostics = [...(scan.diagnostics ?? [])];
  const tables = {};
  const relationships = {};
  const optionSets = {};
  const envDefinitions = {};
  const envValues = {};
  const fingerprint = createHash("sha256");
  const ensureTable = (name, origin) =>
    (tables[name] ??= {
      logicalName: name,
      attributes: {},
      labels: {},
      collectionLabels: {},
      sources: [],
      layers: [],
      origin,
    });
  for (const layer of scan.layers) {
    for (const doc of layer.documents) {
      fingerprint.update(doc.file).update("\0").update(doc.hash ?? "").update("\0");
      const { facts } = doc;
      if (facts.recovered)
        diagnostics.push({
          code: "SOLUTION_XML_RECOVERED",
          source: doc.file,
          count: facts.recovered,
          message: "The XML has unbalanced elements; unclosed elements were closed at their parent so metadata could be read. Correct the source file.",
        });
      for (const entity of facts.entities ?? []) {
        const table = ensureTable(entity.logicalName, "solution");
        table.origin = "solution";
        if (!table.sources.includes(doc.file)) table.sources.push(doc.file);
        table.layers.push({ layer: layer.index, solution: layer.name, file: doc.file, fullDefinition: Boolean(entity.fullDefinition), attributes: entity.attributes.length, ...(entity.unmodified ? { unmodified: true } : {}) });
        if (entity.entitySetName) {
          if (table.entitySet && table.entitySet !== entity.entitySetName)
            diagnostics.push({ code: "SOLUTION_MAPPING_OVERRIDE", entity: entity.logicalName, source: doc.file, previous: table.entitySet, message: "A later metadata layer changes the entity set name." });
          table.entitySet = entity.entitySetName;
          table.entitySetFile = doc.file;
        }
        if (entity.logicalCollectionName) table.logicalCollectionName = entity.logicalCollectionName;
        if (entity.primaryIdAttribute) {
          table.primaryIdAttribute = entity.primaryIdAttribute;
          table.primaryIdFile = doc.file;
        }
        if (entity.primaryNameAttribute) {
          table.primaryNameAttribute = entity.primaryNameAttribute;
          table.primaryNameFile = doc.file;
        }
        if (entity.ownership) table.ownership = entity.ownership;
        if (entity.isActivity !== undefined) table.isActivity = entity.isActivity;
        if (entity.documentManagement !== undefined) {
          table.documentManagement = entity.documentManagement;
          table.documentManagementFile = doc.file;
        }
        if (entity.isIntersect) table.isIntersect = true;
        if (entity.isVirtual) table.isVirtual = true;
        Object.assign(table.labels, entity.labels);
        Object.assign(table.collectionLabels, entity.collectionLabels);
        if (entity.fullDefinition && !table.completeFile) table.completeFile = doc.file;
        for (const attribute of entity.attributes) {
          const previous = table.attributes[attribute.name];
          table.attributes[attribute.name] = {
            ...attribute,
            source: doc.file,
            sources: [...(previous?.sources ?? []), doc.file],
          };
        }
        // A later layer replaces the keys it exports again; other keys stay.
        for (const key of entity.keys ?? []) {
          table.keys ??= {};
          const previous = table.keys[key.name];
          table.keys[key.name] = { ...key, source: doc.file, sources: [...(previous?.sources ?? []), doc.file] };
        }
      }
      for (const relationship of facts.relationships ?? []) {
        const key = relationship.schemaName.toLowerCase();
        const previous = relationships[key];
        relationships[key] = { ...relationship, source: doc.file, sources: [...(previous?.sources ?? []), doc.file] };
      }
      for (const optionSet of facts.optionSets ?? [])
        optionSets[norm(optionSet.name)] = { ...optionSet, source: doc.file };
      for (const definition of facts.envDefinitions ?? [])
        envDefinitions[norm(definition.schemaName)] = { ...definition, source: doc.file, layer: layer.index };
      for (const value of facts.envValues ?? [])
        envValues[norm(value.schemaName)] = { ...value, source: doc.file, layer: layer.index };
    }
  }
  // Environment variables are rows of two documented system tables.
  if (Object.keys(envDefinitions).length)
    for (const [name, columns] of Object.entries(ENVIRONMENT_TABLE_COLUMNS)) {
      const table = ensureTable(name, "dataverse-reference");
      const reference = standardTable(name).reference;
      if (!table.sources.includes(reference)) table.sources.push(reference);
      for (const column of columns) {
        const [attribute, type, maxLength] = column.split(":");
        table.attributes[attribute] ??= compact({ name: attribute, type, maxLength: num(maxLength), labels: {}, source: reference, sources: [reference] });
      }
    }
  // Built-in relationships omitted by partial exports (documented; provenance distinct).
  let standardCount = 0;
  if (scan.layers.length)
    for (const relationship of standardRelationships()) {
      const key = relationship.schemaName.toLowerCase();
      const sides =
        relationship.type === "one-to-many"
          ? [relationship.referencingEntity, relationship.referencedEntity]
          : [relationship.entity1, relationship.entity2];
      if (!relationships[key] && sides.some((side) => tables[side])) {
        relationships[key] = { ...relationship, sources: [relationship.source] };
        standardCount++;
      }
    }
  // Document management: enabling it on a table (IsDocumentManagementEnabled) creates the
  // one-to-many relationship <table>_SharePointDocumentLocations from the table to
  // sharepointdocumentlocation.regardingobjectid (navigation regardingobjectid_<table>), as
  // the Learn table references show for knowledgearticle, mspp_website and
  // adx_portalcomment. Tables that already have such a relationship keep theirs.
  let documentLocationCount = 0;
  for (const table of Object.values(tables)) {
    if (table.documentManagement !== true) continue;
    const schemaName = `${table.logicalName}_SharePointDocumentLocations`;
    const existing = Object.values(relationships).some(
      (relationship) =>
        relationship.type === "one-to-many" &&
        relationship.referencingEntity === "sharepointdocumentlocation" &&
        relationship.referencingAttribute === "regardingobjectid" &&
        relationship.referencedEntity === table.logicalName,
    );
    if (existing || relationships[schemaName.toLowerCase()]) continue;
    relationships[schemaName.toLowerCase()] = {
      schemaName,
      type: "one-to-many",
      referencingEntity: "sharepointdocumentlocation",
      referencedEntity: table.logicalName,
      referencingAttribute: "regardingobjectid",
      referencingNavigation: `regardingobjectid_${table.logicalName}`,
      referencedNavigation: schemaName,
      source: table.documentManagementFile,
      sources: [table.documentManagementFile],
      documentManagement: true,
    };
    documentLocationCount++;
  }
  for (const relationship of Object.values(relationships)) {
    if (relationship.type === "one-to-many") {
      ensureTable(relationship.referencingEntity, "relationship");
      ensureTable(relationship.referencedEntity, "relationship");
    } else {
      ensureTable(relationship.entity1, "relationship");
      ensureTable(relationship.entity2, "relationship");
      ensureTable(relationship.intersectEntity, "intersect").isIntersect = true;
    }
  }
  // Table identity: entity set, primary columns and completeness.
  for (const table of Object.values(tables)) {
    const standard = standardTable(table.logicalName);
    if (table.entitySet) table.entitySetSource = "solution";
    else if (table.logicalCollectionName) {
      table.entitySet = table.logicalCollectionName;
      table.entitySetSource = "solution-collection-name";
    } else if (standard) {
      table.entitySet = standard.entitySet;
      table.entitySetSource = "dataverse-reference";
      table.entitySetReference = standard.reference;
    } else {
      table.entitySet = pluralizeEntitySetName(table.logicalName);
      table.entitySetSource = "pluralized";
    }
    if (table.primaryIdAttribute) table.primaryIdSource = "solution";
    else if (standard) {
      table.primaryIdAttribute = standard.primaryIdAttribute;
      table.primaryIdSource = "dataverse-reference";
    } else if (table.isActivity) {
      table.primaryIdAttribute = "activityid";
      table.primaryIdSource = "solution-activity";
    } else {
      table.primaryIdAttribute = table.logicalName + "id";
      table.primaryIdSource = "convention";
    }
    if (table.primaryNameAttribute) table.primaryNameSource = "solution";
    else if (standard?.primaryNameAttribute) {
      table.primaryNameAttribute = standard.primaryNameAttribute;
      table.primaryNameSource = "dataverse-reference";
    }
    table.schemaComplete = Boolean(table.completeFile);
    table.completeness = table.schemaComplete
      ? {
          complete: true,
          source: table.completeFile,
          reason: table.isVirtual
            ? "A selected layer exports this virtual table with its primary key; virtual tables have no standard system columns."
            : "A selected layer exports the primary key and every standard system column of this table.",
        }
      : {
          complete: false,
          reason: table.layers.length
            ? table.layers.every((entry) => entry.unmodified)
              ? "The selected layers include this table unmodified, without its columns; its columns are unknown locally."
              : "The selected layers export only part of this table's columns (no layer contains the primary key and all standard system columns)."
            : "No selected layer exports this table's definition; it is known only from relationships.",
        };
  }
  // Relationship defaults that depend on resolved primary keys.
  for (const relationship of Object.values(relationships)) {
    if (relationship.type === "one-to-many") {
      relationship.referencedAttribute ??= tables[relationship.referencedEntity].primaryIdAttribute;
      relationship.referencingNavigation ??=
        multiTableNavigation(relationship) ?? relationship.referencingAttributeSchemaName ?? relationship.referencingAttribute;
      relationship.referencedNavigation ??= relationship.schemaName;
    } else {
      const self = relationship.entity1 === relationship.entity2;
      if (!relationship.attribute1 || !relationship.attribute2) {
        if (self)
          diagnostics.push({
            code: "SOLUTION_SELF_INTERSECTION_INFERRED",
            entity: relationship.entity1,
            source: relationship.source,
            relationship: relationship.schemaName,
            message: "Self-reference intersection columns use the idone/idtwo convention because this XML omits explicit attributes; verify against source FetchXML or live metadata.",
          });
        relationship.intersectAttributesInferred = true;
      }
      const pk1 = tables[relationship.entity1].primaryIdAttribute,
        pk2 = tables[relationship.entity2].primaryIdAttribute;
      relationship.attribute1 ??= self ? pk1 + "one" : pk1;
      relationship.attribute2 ??= self ? pk2 + "two" : pk2;
      relationship.navigation1 ??= relationship.schemaName;
      relationship.navigation2 ??= relationship.schemaName;
      const intersect = tables[relationship.intersectEntity];
      for (const [attribute, target] of [[relationship.attribute1, relationship.entity1], [relationship.attribute2, relationship.entity2]])
        intersect.attributes[attribute] ??= {
          name: attribute,
          type: "uniqueidentifier",
          requiredLevel: "systemrequired",
          labels: {},
          intersectTarget: target,
          source: relationship.source,
          sources: [relationship.source],
        };
    }
  }
  // Lookup targets come from the relationships that use each lookup column.
  const targets = {};
  for (const relationship of Object.values(relationships))
    if (relationship.type === "one-to-many") {
      const key = relationship.referencingEntity + "/" + relationship.referencingAttribute;
      (targets[key] ??= new Set()).add(relationship.referencedEntity);
    }
  // Environment variables (definitions joined with optional exported values).
  const environmentVariables = Object.values(envDefinitions)
    .sort((a, b) => compare(norm(a.schemaName), norm(b.schemaName)))
    .map((definition) => {
      const value = envValues[norm(definition.schemaName)];
      return compact({
        schemaName: definition.schemaName,
        displayName: pickLabel(definition.labels, lcid) ?? definition.defaultDisplayName,
        description: pickLabel(definition.descriptionLabels, lcid),
        type: definition.type,
        defaultValue: definition.defaultValue,
        isRequired: definition.isRequired,
        secretStore: definition.secretStore,
        valueSchema: definition.valueSchema,
        source: definition.source,
        value: value?.value,
        valueId: value?.valueId,
        valueSource: value?.source,
      });
    });
  for (const [name, value] of Object.entries(envValues))
    if (!envDefinitions[name])
      diagnostics.push({ code: "SOLUTION_ENVVAR_VALUE_ORPHANED", source: value.source, schemaName: value.schemaName, message: "An exported environment variable value has no definition in the selected layers." });
  return {
    lcid,
    layers: scan.layers.map((layer) => compact({
      index: layer.index,
      input: layer.input,
      dir: layer.dir,
      type: layer.type,
      solution: layer.name,
      version: layer.solution?.version,
      managed: layer.solution?.managed,
      publisherPrefix: layer.solution?.publisherPrefix,
      files: layer.files.length,
      documents: layer.documents.length,
    })),
    order: scan.order,
    tables,
    relationships,
    optionSets,
    environmentVariables,
    targets: Object.fromEntries(Object.entries(targets).map(([key, set]) => [key, [...set].sort()])),
    diagnostics,
    standardRelationships: standardCount,
    documentLocationRelationships: documentLocationCount,
    fingerprint: fingerprint.digest("hex"),
  };
}

/** Field definition used by forms, the Web API policy and persisted mapping metadata. */
export function fieldDefinition(schema, tableName, attribute, { lcid = schema.lcid ?? 1033, provenance = true, diagnostics } = {}) {
  const table = schema.tables[tableName];
  const labelText = (labels, fallback) => pickLabel(labels, lcid) ?? fallback;
  const states = (attribute.optionSet?.states ?? []).map((o) => ({
    value: o.value,
    label: labelText(o.labels, String(o.value)),
    defaultStatus: o.defaultStatus,
    invariantName: o.invariantName,
  }));
  const statuses = (attribute.optionSet?.statuses ?? []).map((o) => ({
    value: o.value,
    label: labelText(o.labels, String(o.value)),
    state: o.state,
  }));
  const options = (attribute.optionSet?.options ?? [])
    .map((o) => ({ value: o.value, label: labelText(o.labels, String(o.value)) }))
    .concat(states, statuses);
  const globalSet = attribute.optionSetName ? schema.optionSets[norm(attribute.optionSetName)] : null;
  if (!options.length && globalSet)
    options.push(...(globalSet.options ?? []).map((o) => ({ value: o.value, label: labelText(o.labels, String(o.value)) })));
  if (attribute.optionSetName && !options.length)
    diagnostics?.push({
      code: "SOLUTION_OPTIONSET_UNRESOLVED",
      file: attribute.source,
      entity: tableName,
      field: attribute.name,
      optionSetName: attribute.optionSetName,
      message: `Global option set ${attribute.optionSetName} is not available in the selected solution roots.`,
    });
  const type = attribute.type ?? "nvarchar";
  const lookupTargets =
    schema.targets[tableName + "/" + attribute.name] ??
    (attribute.intersectTarget ? [attribute.intersectTarget] : undefined) ??
    (["lookup", "owner"].includes(type) ? STANDARD_LOOKUP_TARGETS[attribute.name] : undefined);
  const appDefault = attribute.appDefaultValue;
  const defaultValue =
    type === "bit" && /^[01]$/.test(appDefault ?? "")
      ? appDefault === "1"
      : ["picklist", "multiselectpicklist"].includes(type) && /^-?\d+$/.test(appDefault ?? "") && appDefault !== "-1"
        ? Number(appDefault)
        : undefined;
  const optionSetType = attribute.optionSet
    ? ({ bit: "boolean", state: "state", status: "status" }[attribute.optionSet.type] ?? "local")
    : globalSet || attribute.optionSetName
      ? "global"
      : undefined;
  return {
    name: attribute.name,
    ...(attribute.validForCreate !== undefined ? { validForCreate: attribute.validForCreate } : {}),
    ...(attribute.validForUpdate !== undefined ? { validForUpdate: attribute.validForUpdate } : {}),
    label: labelText(attribute.labels, attribute.name),
    dataverseType: type,
    ...(attribute.optionSetName ? { optionSetName: attribute.optionSetName, optionSetSource: globalSet?.source } : {}),
    ...(states.length ? { states } : {}),
    ...(statuses.length ? { statuses } : {}),
    type: SIMPLE_TYPES[type] ?? "text",
    required: ["required", "systemrequired", "applicationrequired"].includes(attribute.requiredLevel),
    maxLength: attribute.maxLength || undefined,
    ...(options.length || ["picklist", "state", "status"].includes(type) ? { options } : {}),
    ...compact({
      schemaName: attribute.schemaName,
      requiredLevel: attribute.requiredLevel,
      validForRead: attribute.validForRead,
      precision: attribute.precision,
      minValue: attribute.minValue,
      maxValue: attribute.maxValue,
      format: attribute.format,
      dateTimeBehavior: attribute.dateTimeBehavior,
      autoNumberFormat: attribute.autoNumberFormat,
      isSecured: attribute.isSecured || undefined,
      defaultValue,
      optionSetType,
      targets: lookupTargets,
      isPrimaryId: table?.primaryIdAttribute === attribute.name || undefined,
      isPrimaryName: table?.primaryNameAttribute === attribute.name || undefined,
      attributeOf: attribute.attributeOf,
      implicit: attribute.implicit,
      ...(provenance ? { source: attribute.source, sources: attribute.sources?.length > 1 ? attribute.sources : undefined } : {}),
    }),
  };
}

/** All field definitions of a table, adding Dataverse columns never written to solution XML when the table is complete. */
export function tableFields(schema, tableName, options = {}) {
  const table = schema.tables[tableName];
  if (!table) return {};
  const fields = {};
  for (const attribute of Object.values(table.attributes))
    fields[attribute.name] = fieldDefinition(schema, tableName, attribute, options);
  // Implicit Dataverse columns (versionnumber) exist on stored tables, not on virtual ones.
  if (table.schemaComplete && !table.isVirtual)
    for (const [name, column] of Object.entries(IMPLICIT_SYSTEM_COLUMNS))
      fields[name] ??= options.provenance === false ? (({ source, ...rest }) => rest)(column) : { ...column };
  return fields;
}
