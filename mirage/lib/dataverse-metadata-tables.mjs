// Dataverse metadata writes over the Web API: tables (EntityDefinitions POST, PUT, DELETE), columns
// (Attributes POST, PUT, DELETE), alternate keys (Keys POST, DELETE) and the PublishXml/PublishAllXml actions.
// Each write needs its metadata privilege (prv*Entity / prv*Attribute, held by System Administrator and System Customizer).
// Created tables are userConfigured, dataverseOnly store mappings flagged createdByMetadataApi; seeded and Solution tables
// keep their table-level writes read-only. Columns created here (isManaged: false, isCustomizable: true) may be added to any
// table; they are kept in state.dataverse.customColumns and reapplied onto the mapping (reapplyCustomColumns) so a Solution
// refresh keeps them. Shapes follow the Web API table and column articles; items marked unverified are
// not confirmed against the service. Choice storage follows the canonical shape in dataverse-metadata-relationships.mjs.
import { DataError } from "./data-error.mjs";
import { createMetadataService } from "./dataverse-metadata.mjs";
import { removeRelationshipsOf, assignValue, optionFrom, requireMetadataPrivilege, logMetadataChange, withSolutionMembership } from "./dataverse-metadata-relationships.mjs";
import { grantTablePrivileges, revokeTablePrivileges, uuidV5 } from "./dataverse-security.mjs";
import { pluralizeEntitySetName } from "./solution-standard.mjs";
import { assertElasticColumn, assertElasticKey, assertElasticTable, builtInKey, isElastic, SYSTEM_ATTRIBUTES, tableTypeOf } from "./dataverse-elastic.mjs";

// unverified: customization prefix of 2 to 8 letters, then an underscore and a name (the quote and space forms are refused).
const SCHEMA_NAME = /^[A-Za-z][A-Za-z0-9]{1,7}_[A-Za-z0-9_]+$/;
const GUID = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;
const LOGICAL_KEY = /^LogicalName='([^']+)'$/i;
// GlobalOptionSetDefinitions(Name='x') or GlobalOptionSetDefinitions(<MetadataId>), the two forms the bind documents.
const GLOBAL_BIND = /GlobalOptionSetDefinitions\((?:Name=['"]([^'"]+)['"]|\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?)\)/i;
const WRITE_PATH = /^\/api\/data\/v[\d.]+\/(?:EntityDefinitions(?:[(/]|$)|Publish(?:All)?Xml$)/;
const PUBLISH = new Set(["PublishXml", "PublishAllXml"]);
const OWNERSHIP_TYPES = new Set(["UserOwned", "OrganizationOwned"]);
const DEFAULT_LCID = 1033;
const MAX_KEYS = 10;
const MAX_KEY_COLUMNS = 16;
const MAX_KEY_BYTES = 900; // unverified: SQL index limit for an alternate key, per Microsoft Learn
// Column types an alternate key may use (Web API docs: whole number, decimal, single line of text, date time, lookup, option set).
const KEY_TYPES = new Set(["nvarchar", "int", "decimal", "datetime", "lookup", "picklist"]);
// Bytes a key column takes toward the 900-byte limit. unverified: per-type widths.
const KEY_BYTES = {
  nvarchar: (f) => 2 * (f.columnMetadata?.maxLength ?? 100), int: () => 4, decimal: () => 17, datetime: () => 8, lookup: () => 16, picklist: () => 4,
};
// @odata.type -> dataverseType. Double, File and Image column facts are unverified.
const COLUMN_TYPES = {
  StringAttributeMetadata: "nvarchar",
  MemoAttributeMetadata: "memo",
  IntegerAttributeMetadata: "int",
  BigIntAttributeMetadata: "bigint",
  DecimalAttributeMetadata: "decimal",
  DoubleAttributeMetadata: "float",
  MoneyAttributeMetadata: "money",
  BooleanAttributeMetadata: "bit",
  DateTimeAttributeMetadata: "datetime",
  PicklistAttributeMetadata: "picklist",
  MultiSelectPicklistAttributeMetadata: "multiselectpicklist",
  FileAttributeMetadata: "file",
  ImageAttributeMetadata: "image",
};
// Columns whose writable numeric and text properties PUT may change (unverified: which properties Dataverse accepts per type).
const NUMERIC = new Set(["int", "bigint", "decimal", "float", "money"]);
const TEXT = new Set(["nvarchar", "memo"]);
// Owner columns of a user-owned table, stored like the seeded security tables.
const OWNER_FIELDS = {
  ownerid: { dataverseType: "owner", targets: ["systemuser", "team"] },
  owninguser: { dataverseType: "lookup", targets: ["systemuser"] },
  owningteam: { dataverseType: "lookup", targets: ["team"] },
  owningbusinessunit: { dataverseType: "lookup", targets: ["businessunit"] },
};
const VERB = { POST: "Create", PUT: "Write", DELETE: "Delete" };

// Error text and inner codes come from the gap review; the messages and statuses are unverified.
const fail = (message, status = 400, code = "InvalidRequest", innerCode) => new DataError(message, status, code, innerCode ? { innerCode } : undefined);
const schemaNameError = (name, type) => fail(`The schema name ${name} for type ${type} is invalid or missing.Custom attribute, entity, entitykey, option set and relationship names must start with a valid customization prefix.`, 400, "InvalidRequest", "0x80044366");
const attributeExists = (name, table) => fail(`Attribute ${name} already exists for entity ${table}.`, 400, "InvalidRequest", "0x80060304");
const entitySetExists = (set) => fail(`An entity with the specified entity set name ${set} already exists.`, 400, "InvalidRequest", "0x8006089B");

const requireText = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw fail(`${name} is required.`);
  return value.trim();
};
const lower = (value) => String(value ?? "").toLowerCase();
const guidOf = (text) => GUID.exec(String(text ?? "").trim())?.[1].toLowerCase() ?? null;
const typeOf = (attr) => String(attr?.["@odata.type"] ?? "").replace(/^#?Microsoft\.Dynamics\.CRM\./, "");
const ids = (api) => createMetadataService({ organizationId: api.settings.organizationId, schema: api.schema ?? null, mappings: () => api.store.state.mappings });
const urlOf = (c, path) => `${c.origin}/api/data/${c.version}/${path}`;
// MSCRM.MergeLabels is case-insensitive in the name and the value, as the relationships module reads it.
const mergeHeader = (headers = {}) => Object.entries(headers)
  .some(([name, value]) => lower(name) === "mscrm.mergelabels" && lower(value) === "true");
const mergeLabels = (existing = {}, incoming, merge) => (incoming === undefined ? existing : merge ? { ...existing, ...incoming } : incoming);
const requiredLevelOf = (value) => String((typeof value === "string" ? value : value?.Value) ?? "None").toLowerCase();

// Label complex type -> { languageCode: text }. Only LocalizedLabels is read. Undefined when the property is absent.
function labelMap(label) {
  if (label === undefined || label === null) return undefined;
  if (!Array.isArray(label.LocalizedLabels)) throw fail("A label needs a LocalizedLabels array."); // unverified
  return Object.fromEntries(label.LocalizedLabels.map((item) => [String(item.LanguageCode ?? DEFAULT_LCID), String(item.Label ?? "")]));
}

function requireLabel(label, name) {
  const map = labelMap(label);
  if (!map || !Object.keys(map).length) throw fail(`${name} is required.`); // unverified
  return map;
}

function nextObjectTypeCode(mappings) {
  const codes = Object.values(mappings).map((m) => m.dataverseMetadata?.ObjectTypeCode).filter(Number.isInteger);
  return Math.max(9999, ...codes) + 1;
}

// The global set a bind names, by Name or by MetadataId. The set must exist in the store or the schema.
function globalNameOf(api, bind) {
  const m = GLOBAL_BIND.exec(String(bind));
  if (!m) throw fail("GlobalOptionSet@odata.bind must name a global option set by Name or MetadataId."); // unverified
  const org = api.settings.organizationId;
  const schema = typeof api.schema === "function" ? api.schema() : api.schema;
  const known = [
    ...Object.values(api.store.state.dataverse?.globalOptionSets ?? {}).map((set) => set.name),
    ...Object.values(schema?.optionSets ?? {}).map((set) => set.name),
  ];
  const wanted = m[1] ? (name) => lower(name) === lower(m[1]) : (name) => uuidV5(org, `optionset:${name}`).toLowerCase() === guidOf(m[2]);
  const name = known.find(wanted);
  if (!name) throw fail(`Global option set ${m[1] ?? m[2]} does not exist.`, 404, "NotFound"); // unverified
  return name;
}

// Picklist facts: a global bind, or local options. Option values use the shared rule (null takes the next free value).
function optionSetOf(api, attr) {
  const bind = attr["GlobalOptionSet@odata.bind"];
  if (bind) return { isGlobal: true, name: globalNameOf(api, bind) };
  const options = attr.OptionSet?.Options;
  if (!Array.isArray(options)) throw fail("A picklist column needs OptionSet.Options or GlobalOptionSet@odata.bind."); // unverified
  const list = [];
  for (const option of options) list.push(optionFrom(option, assignValue(list, option.Value)));
  return { options: list };
}

// Column definition as the read side expects it: dataverseType plus columnMetadata facts (attribute-metadata.mjs).
function columnField(api, attr, dataverseType, schemaName, primary) {
  const facts = {
    type: dataverseType,
    schemaName,
    labels: labelMap(attr.DisplayName) ?? {},
    descriptionLabels: labelMap(attr.Description) ?? {},
    requiredLevel: requiredLevelOf(attr.RequiredLevel),
    isCustomField: true,
    isManaged: false, isCustomizable: true, // origin: created through the metadata API (as relationships are)
    ...(primary ? { isPrimaryName: true } : {}),
  };
  const field = { dataverseType };
  const range = { minValue: attr.MinValue ?? null, maxValue: attr.MaxValue ?? null };
  switch (dataverseType) {
    case "nvarchar":
      Object.assign(facts, { maxLength: attr.MaxLength ?? null, format: String(attr.FormatName?.Value ?? attr.FormatName ?? "Text").toLowerCase() });
      break;
    case "memo":
      facts.maxLength = attr.MaxLength ?? null;
      break;
    case "int":
    case "bigint":
      Object.assign(facts, range);
      break;
    case "decimal":
    case "float":
    case "money":
      Object.assign(facts, range, { precision: attr.Precision ?? null });
      break;
    case "datetime":
      facts.format = String(attr.Format ?? "DateAndTime").toLowerCase();
      field.dateTimeBehavior = attr.DateTimeBehavior?.Value ?? "UserLocal";
      break;
    case "bit":
      facts.optionSet = {
        options: [optionFrom(attr.OptionSet?.TrueOption ?? {}, 1), optionFrom(attr.OptionSet?.FalseOption ?? {}, 0)],
      };
      facts.appDefaultValue = attr.DefaultValue === true ? "1" : "0";
      break;
    case "picklist":
    case "multiselectpicklist":
      facts.optionSet = optionSetOf(api, attr);
      if (facts.optionSet.isGlobal) field.globalOptionSet = facts.optionSet.name;
      break;
    case "file":
    case "image":
      facts.maxSizeInKB = attr.MaxSizeInKB ?? null; // unverified: File and Image column facts
      break;
  }
  return { ...field, columnMetadata: facts };
}

// API-created columns: state.dataverse.customColumns[table][column] is the source of truth, mapping.fields is its copy.
const customBucket = (state, logical) => ((state.dataverse ??= {}).customColumns ??= {})[logical] ??= {};
function remember(state, logical, mapping, name, field) {
  mapping.fields[name] = field;
  customBucket(state, logical)[name] = structuredClone(field);
}

// Origin guard: only a column this API created (isManaged: false, isCustomizable: true) may be changed or deleted.
// Solution and seeded columns carry no such pair. Returns the stored source definition.
function customColumnOf(api, logical, mapping, name) {
  const facts = mapping.fields[name]?.columnMetadata;
  if (facts?.isManaged !== false || facts?.isCustomizable !== true) {
    throw fail(`${name} is a managed Solution or system column and cannot be changed or deleted.`); // unverified
  }
  const bucket = customBucket(api.store.state, logical);
  bucket[name] ??= structuredClone(mapping.fields[name]);
  return bucket[name];
}

// Re-applies every stored custom column onto its table's mapping fields. Call after a Solution reload, inside a store
// transaction: a reloaded mapping has its Solution fields only, and the custom columns come back from customColumns.
export function reapplyCustomColumns(store) {
  const state = store.state;
  for (const [logical, bucket] of Object.entries(state.dataverse?.customColumns ?? {})) {
    const mapping = state.mappings[logical];
    if (!mapping) continue;
    mapping.fields ??= {};
    for (const [name, field] of Object.entries(bucket)) mapping.fields[name] = structuredClone(field);
  }
}

// Adds one column to a mapping and returns its logical name. A File column also gets <col>_name.
// system: an elastic table's own column (partitionid, ttlinseconds): managed, not customizable, and no SchemaName prefix.
function addColumn(api, mapping, table, attr, { primary = false, system = false } = {}) {
  const type = typeOf(attr);
  // A lookup is a relationship: its column comes from RelationshipDefinitions, not from an Attributes write.
  if (/LookupAttributeMetadata$/.test(type)) {
    throw fail("A lookup column is created with a one-to-many relationship: POST RelationshipDefinitions or CreatePolymorphicLookupAttribute.", 400, "InvalidRequest"); // unverified
  }
  const dataverseType = COLUMN_TYPES[type];
  if (!dataverseType) throw fail(`${type || "A column without a type"} is not supported by the simulator.`, 501, "NotImplemented"); // unverified
  const schemaName = requireText(attr.SchemaName, "SchemaName");
  if (!system && !SCHEMA_NAME.test(schemaName)) throw schemaNameError(schemaName, "Attribute");
  const name = schemaName.toLowerCase();
  const taken = (n) => Object.hasOwn(mapping.fields, n) || n === mapping.idColumn;
  if (taken(name) || (dataverseType === "file" && taken(`${name}_name`))) throw attributeExists(name, table);
  const field = columnField(api, attr, dataverseType, schemaName, primary);
  if (system) field.columnMetadata = { ...field.columnMetadata, isCustomField: false, isManaged: true, isCustomizable: false };
  remember(api.store.state, table, mapping, name, field);
  if (dataverseType === "file") {
    remember(api.store.state, table, mapping, `${name}_name`, {
      dataverseType: "nvarchar",
      columnMetadata: { type: "nvarchar", schemaName: `${schemaName}_Name`, labels: {}, descriptionLabels: {}, requiredLevel: "none", isCustomField: true, isManaged: false, isCustomizable: true, maxLength: 300 }, // unverified: name column size
    });
  }
  logMetadataChange(api, "add", "attribute", table, name);
  return name;
}

// Table key or LogicalName='x' -> logical name. Null when no mapping has that name or GUID.
function tableNameOf(api, key) {
  const text = String(key ?? "").trim();
  const named = LOGICAL_KEY.exec(text);
  if (named) return named[1].toLowerCase();
  const guid = guidOf(text);
  if (!guid) return null;
  const service = ids(api);
  return Object.keys(api.store.state.mappings).find((name) => service.metadataId("entity", name).toLowerCase() === guid) ?? null;
}

function anyTable(api, key) {
  const logical = tableNameOf(api, key);
  const mapping = logical ? api.store.state.mappings[logical] : undefined;
  if (!mapping) throw fail(`${key} does not exist.`, 404, "NotFound"); // unverified
  return { logical, mapping };
}

// Table-level writes (PUT, DELETE, keys) go to tables this API created: userConfigured, dataverseOnly, createdByMetadataApi.
function userTable(api, key) {
  const found = anyTable(api, key);
  const { mapping, logical } = found;
  if (mapping.dataverseOnly !== true || mapping.dataverseMetadata?.createdByMetadataApi !== true) {
    throw fail(`${logical} is a system or solution table and cannot be changed through the Web API.`); // unverified
  }
  return found;
}

function columnNamed(api, logical, mapping, attributeId) {
  const service = ids(api);
  const name = Object.keys(mapping.fields).find((n) => service.metadataId("attribute", logical, n).toLowerCase() === guidOf(attributeId));
  if (!name) throw fail(`Attribute ${attributeId} does not exist.`, 404, "NotFound"); // unverified
  return name;
}

const entityIdUrl = (c, logical) => urlOf(c, `EntityDefinitions(${ids(c.api).metadataId("entity", logical)})`);
const attributeIdUrl = (c, logical, name) => urlOf(c, `EntityDefinitions(${ids(c.api).metadataId("entity", logical)})/Attributes(${ids(c.api).metadataId("attribute", logical, name)})`);

export function createTable(c, body) {
  const { api } = c;
  const schemaName = requireText(body.SchemaName, "SchemaName");
  if (!SCHEMA_NAME.test(schemaName)) throw schemaNameError(schemaName, "Entity");
  const logical = schemaName.toLowerCase();
  const labels = {
    DisplayName: requireLabel(body.DisplayName, "DisplayName"),
    DisplayCollectionName: requireLabel(body.DisplayCollectionName, "DisplayCollectionName"),
    Description: labelMap(body.Description) ?? {},
  };
  if (!OWNERSHIP_TYPES.has(body.OwnershipType)) throw fail("OwnershipType must be UserOwned or OrganizationOwned."); // unverified
  for (const flag of ["IsActivity", "HasActivities", "HasNotes"]) {
    if (typeof body[flag] !== "boolean") throw fail(`${flag} is required.`); // unverified
  }
  const attributes = body.Attributes;
  if (!Array.isArray(attributes)) throw fail("Attributes must contain the primary name column."); // unverified
  const primaries = attributes.filter((a) => a?.IsPrimaryName === true);
  if (primaries.length !== 1 || typeOf(primaries[0]) !== "StringAttributeMetadata") {
    throw fail("Attributes must contain exactly one StringAttributeMetadata with IsPrimaryName true."); // unverified
  }
  const tableType = tableTypeOf(body.TableType);
  if (tableType === "Elastic") assertElasticTable(body);
  const { mappings } = api.store.state;
  if (Object.hasOwn(mappings, logical)) throw fail(`An entity named ${logical} already exists.`); // unverified
  const entitySet = pluralizeEntitySetName(logical);
  if (Object.values(mappings).some((m) => m.entitySet === entitySet)) throw entitySetExists(entitySet);

  const mapping = {
    logicalName: logical,
    entitySet,
    idColumn: `${logical}id`,
    nameColumn: null,
    ownership: body.OwnershipType,
    tableType,
    fields: body.OwnershipType === "UserOwned" ? { ...OWNER_FIELDS } : {},
    relationships: {},
    userConfigured: true,
    dataverseOnly: true,
    dataverseMetadata: {
      schemaName,
      labels,
      IsAuditEnabled: false,
      ObjectTypeCode: nextObjectTypeCode(mappings),
      IsActivity: body.IsActivity,
      HasActivities: body.HasActivities,
      HasNotes: body.HasNotes,
      createdByMetadataApi: true,
    },
  };
  logMetadataChange(api, "add", "entity", logical);
  mapping.nameColumn = addColumn(api, mapping, logical, primaries[0], { primary: true });
  for (const attr of attributes) if (attr !== primaries[0]) addColumn(api, mapping, logical, attr);
  if (isElastic(mapping)) {
    for (const attr of SYSTEM_ATTRIBUTES) addColumn(api, mapping, logical, attr, { system: true });
    mapping.alternateKeys = [builtInKey(mapping.idColumn)];
  }
  mappings[logical] = mapping;
  (api.store.state.tables ??= {})[logical] ??= [];
  grantTablePrivileges(api.store, api.settings.organizationId, logical); // Dataverse creates the table's privileges with it
  return { status: 204, headers: { "OData-EntityId": entityIdUrl(c, logical) } };
}

export function updateTable(c, key, body) {
  const { logical, mapping } = userTable(c.api, key);
  if (body.SchemaName !== undefined && String(body.SchemaName).toLowerCase() !== logical) throw fail(`The schema name of ${logical} cannot change.`); // unverified
  if (body.OwnershipType !== undefined && body.OwnershipType !== mapping.ownership) throw fail("OwnershipType cannot change."); // unverified
  const merge = mergeHeader(c.headers);
  const dm = mapping.dataverseMetadata ?? {};
  const labels = { ...(dm.labels ?? {}) };
  for (const name of ["DisplayName", "DisplayCollectionName", "Description"]) {
    if (body[name] !== undefined) labels[name] = mergeLabels(labels[name], labelMap(body[name]), merge);
  }
  const flags = Object.fromEntries(["IsActivity", "HasActivities", "HasNotes"].filter((f) => typeof body[f] === "boolean").map((f) => [f, body[f]]));
  mapping.dataverseMetadata = { ...dm, labels, ...flags };
  logMetadataChange(c.api, "change", "entity", logical);
  return { status: 204 };
}

function deleteTable(c, key) {
  const { logical } = userTable(c.api, key);
  dropTable(c.api, logical);
  return { status: 204 };
}

// Removes a table and its rows, relationships and privileges, with no guard: the caller has checked it may go (the DELETE
// route, or a solution uninstall or upgrade inside its store transaction).
export function dropTable(api, logical) {
  removeRelationshipsOf(api, logical); // relationships on either side go with the table
  revokeTablePrivileges(api.store, api.settings.organizationId, logical); // before the mapping goes: its names come from it
  delete api.store.state.mappings[logical];
  delete api.store.state.tables?.[logical];
  delete api.store.state.dataverse?.customColumns?.[logical];
  logMetadataChange(api, "delete", "entity", logical);
}

// Columns may be added to any table, Solution and seeded tables included (Dataverse allows custom columns there).
export function createColumn(c, key, body) {
  const { logical, mapping } = anyTable(c.api, key);
  mapping.fields ??= {};
  if (isElastic(mapping)) assertElasticColumn(body);
  const name = addColumn(c.api, mapping, logical, body);
  const url = attributeIdUrl(c, logical, name);
  return { status: 204, headers: { "OData-EntityId": url, ...(mapping.fields[name].columnMetadata.type === "file" ? { Location: url } : {}) } }; // unverified: Location on File
}

// PUT replaces the writable properties; the ones the body omits keep their stored value.
function updateColumn(c, key, attributeId, body) {
  const { logical, mapping } = anyTable(c.api, key);
  const name = columnNamed(c.api, logical, mapping, attributeId);
  const field = customColumnOf(c.api, logical, mapping, name);
  const facts = field.columnMetadata;
  if (body.SchemaName !== undefined && String(body.SchemaName).toLowerCase() !== name) throw fail(`The schema name of ${name} cannot change.`); // unverified
  const merge = mergeHeader(c.headers);
  if (body.DisplayName !== undefined) facts.labels = mergeLabels(facts.labels, labelMap(body.DisplayName), merge);
  if (body.Description !== undefined) facts.descriptionLabels = mergeLabels(facts.descriptionLabels, labelMap(body.Description), merge);
  if (body.RequiredLevel !== undefined) facts.requiredLevel = requiredLevelOf(body.RequiredLevel);
  if (body.MaxLength !== undefined) {
    if (!TEXT.has(field.dataverseType)) throw fail(`MaxLength applies to text columns, not ${name}.`); // unverified
    facts.maxLength = Number(body.MaxLength);
  }
  if (body.MinValue !== undefined || body.MaxValue !== undefined) {
    if (!NUMERIC.has(field.dataverseType)) throw fail(`MinValue and MaxValue apply to numeric columns, not ${name}.`); // unverified
    if (body.MinValue !== undefined) facts.minValue = body.MinValue;
    if (body.MaxValue !== undefined) facts.maxValue = body.MaxValue;
  }
  if (body.FormatName !== undefined) {
    if (field.dataverseType !== "nvarchar") throw fail(`FormatName applies to text columns, not ${name}.`); // unverified
    facts.format = String(body.FormatName?.Value ?? body.FormatName).toLowerCase();
  }
  mapping.fields[name] = structuredClone(field);
  logMetadataChange(c.api, "change", "attribute", logical, name);
  return { status: 204 };
}

function deleteColumn(c, key, attributeId) {
  const { logical, mapping } = anyTable(c.api, key);
  const name = columnNamed(c.api, logical, mapping, attributeId);
  const facts = customColumnOf(c.api, logical, mapping, name).columnMetadata;
  if (facts.isPrimaryName) throw fail("The primary name column cannot be deleted."); // unverified
  if ((mapping.alternateKeys ?? []).some((k) => k.attributes.includes(name))) throw fail(`${name} is used by an alternate key.`); // unverified
  dropColumn(c.api, logical, name);
  return { status: 204 };
}

// Removes a column (and a file column's _name companion), its bucket entries and row values, with no guard. An alternate key
// that names the column goes with it. The caller has checked the column may go.
export function dropColumn(api, logical, name) {
  const mapping = api.store.state.mappings[logical];
  const facts = mapping.fields?.[name]?.columnMetadata ?? {};
  const bucket = customBucket(api.store.state, logical);
  const removed = [name, ...(facts.type === "file" ? [`${name}_name`] : [])];
  if (mapping.alternateKeys) mapping.alternateKeys = mapping.alternateKeys.filter((k) => !k.attributes.includes(name));
  for (const column of removed) {
    delete mapping.fields[column];
    delete bucket[column];
    for (const row of api.store.state.tables?.[logical] ?? []) delete row[column];
  }
  logMetadataChange(api, "delete", "attribute", logical, name);
}

function createKey(c, key, body) {
  const { api } = c;
  const { logical, mapping } = userTable(api, key);
  if (isElastic(mapping)) assertElasticKey();
  const schemaName = requireText(body.SchemaName, "SchemaName");
  if (!SCHEMA_NAME.test(schemaName)) throw schemaNameError(schemaName, "EntityKey");
  const name = schemaName.toLowerCase();
  const keys = mapping.alternateKeys ?? [];
  if (keys.length >= MAX_KEYS) throw fail(`A table can have at most ${MAX_KEYS} alternate keys.`); // unverified
  if (keys.some((k) => k.name === name)) throw fail(`An alternate key named ${name} already exists.`); // unverified
  const attributes = Array.isArray(body.KeyAttributes) ? body.KeyAttributes.map((a) => String(a).toLowerCase()) : [];
  if (!attributes.length || attributes.length > MAX_KEY_COLUMNS) throw fail(`A key needs 1 to ${MAX_KEY_COLUMNS} columns.`); // unverified
  for (const attribute of attributes) {
    const field = mapping.fields[attribute];
    if (!field || !KEY_TYPES.has(field.dataverseType)) throw fail(`${attribute} cannot be used in an alternate key.`); // unverified
  }
  const bytes = attributes.reduce((sum, attribute) => sum + KEY_BYTES[mapping.fields[attribute].dataverseType](mapping.fields[attribute]), 0);
  if (bytes > MAX_KEY_BYTES) throw fail(`The key is ${bytes} bytes; a key can be at most ${MAX_KEY_BYTES} bytes.`); // unverified
  mapping.alternateKeys = [...keys, { name, schemaName, attributes, labels: labelMap(body.DisplayName) ?? {} }];
  logMetadataChange(api, "change", "entity", logical);
  const keyId = ids(api).metadataId("key", logical, name);
  return { status: 204, headers: { "OData-EntityId": urlOf(c, `EntityDefinitions(${ids(api).metadataId("entity", logical)})/Keys(${keyId})`) } };
}

function deleteKey(c, key, keyId) {
  const { api } = c;
  const { logical, mapping } = userTable(api, key);
  const keys = mapping.alternateKeys ?? [];
  const found = keys.find((k) => guidOf(ids(api).metadataId("key", logical, k.name)) === guidOf(keyId));
  if (!found) throw fail(`Key ${keyId} does not exist.`, 404, "NotFound"); // unverified
  if (found.builtIn) throw fail(`${found.name} is the built-in key of an elastic table and cannot be deleted.`); // unverified: LC-E1c
  mapping.alternateKeys = keys.filter((k) => k !== found);
  logMetadataChange(api, "change", "entity", logical);
  return { status: 204 };
}

// PublishXml and PublishAllXml are accepted and do nothing: changes already apply to the simulated model.
function publish(c) {
  if (c.method !== "POST") throw fail(`${c.method} is not supported for ${c.route.name}.`, 405, "MethodNotAllowed"); // unverified
  if (c.route.name === "PublishXml" && typeof c.body?.ParameterXml !== "string") throw fail("ParameterXml is required."); // unverified
  return { status: 204 };
}

// Privilege for a write: table writes need prv*Entity, column and key writes prv*Attribute (keys: unverified).
const privilegeFor = (method, segment) => (VERB[method] ? `prv${VERB[method]}${segment ? "Attribute" : "Entity"}` : null);

export function install(api) {
  api.addRoute((pathname, method) => method !== "GET" && WRITE_PATH.test(pathname), (c) => handleMetadataWrite({ ...c, api }));
}

// runs on every reseed (/_sim/ reset, state import) inside the change queue: the store only, never api.change.
// The custom columns are kept in state.dataverse.customColumns; a reset mapping gets them back from there.
export function reset(api) {
  return api.store.transact(() => reapplyCustomColumns(api.store));
}

/** Dispatches one metadata write. The privilege is checked first; each change then runs in one store transaction. */
export async function handleMetadataWrite(c) {
  const { api, method, route } = c;
  if (route.kind === "function") {
    if (!PUBLISH.has(route.name)) throw fail(`${route.name} is not a metadata action.`, 404, "NotFound"); // unverified
    if (method === "POST") requireMetadataPrivilege(api, c, "prvWriteEntity", route.name); // unverified: publishing needs the customizer write privilege
    return publish(c);
  }
  if (route.set !== "EntityDefinitions") throw fail(`${route.set} is not a metadata resource.`, 404, "NotFound"); // unverified
  if (c.body !== undefined && (typeof c.body !== "object" || c.body === null || Array.isArray(c.body))) throw fail("The request body must be a JSON object."); // unverified
  const body = c.body ?? {};
  const { segment, key, segmentKey } = route;
  const privilege = privilegeFor(method, segment);
  if (privilege) requireMetadataPrivilege(api, c, privilege, "EntityDefinitions");
  // Every write first re-applies the custom columns, so a mapping reset by a Solution reload gets them back.
  const write = (fn) => api.change(() => api.store.transact(() => { reapplyCustomColumns(api.store); return withSolutionMembership(api, c.headers, fn); }));
  if (!segment && !key && method === "POST") return write(() => createTable(c, body));
  if (!segment && key && method === "PUT") return write(() => updateTable(c, key, body));
  if (!segment && key && method === "DELETE") return write(() => deleteTable(c, key));
  if (segment === "Attributes" && key && !segmentKey && method === "POST") return write(() => createColumn(c, key, body));
  if (segment === "Attributes" && key && segmentKey && method === "PUT") return write(() => updateColumn(c, key, segmentKey, body));
  if (segment === "Attributes" && key && segmentKey && method === "DELETE") return write(() => deleteColumn(c, key, segmentKey));
  if (segment === "Keys" && key && !segmentKey && method === "POST") return write(() => createKey(c, key, body));
  if (segment === "Keys" && key && segmentKey && method === "DELETE") return write(() => deleteKey(c, key, segmentKey));
  throw fail(`${method} is not supported for ${route.set}${segment ? `/${segment}` : ""}.`, 405, "MethodNotAllowed"); // unverified: PATCH on definitions
}
