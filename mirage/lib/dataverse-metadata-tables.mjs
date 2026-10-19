// Dataverse metadata writes over the Web API: tables (EntityDefinitions POST, PUT, DELETE), columns
// (Attributes POST, PUT, DELETE), alternate keys (Keys POST) and the PublishXml/PublishAllXml actions.
// Created tables and columns are userConfigured, dataverseOnly store mappings. Solution tables are
// read-only here. Shapes follow the Web API table and column articles; items marked unverified are
// not confirmed against the service.
import { DataError } from "./data-error.mjs";
import { createMetadataService } from "./dataverse-metadata.mjs";
import { pluralizeEntitySetName } from "./solution-standard.mjs";

const SCHEMA_PREFIX = /^[A-Za-z0-9]+_/;
const GUID = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;
const LOGICAL_KEY = /^LogicalName='([^']+)'$/i;
const GLOBAL_SET = /LogicalName='([^']+)'/i;
const WRITE_PATH = /^\/api\/data\/v[\d.]+\/(?:EntityDefinitions(?:[(/]|$)|Publish(?:All)?Xml$)/;
const PUBLISH = new Set(["PublishXml", "PublishAllXml"]);
const OWNERSHIP_TYPES = new Set(["UserOwned", "OrganizationOwned"]);
const DEFAULT_LCID = 1033;
const MAX_KEYS = 10;
const MAX_KEY_COLUMNS = 16;
// Column types an alternate key may use (Web API docs: whole number, decimal, single line of text, date time, lookup, option set).
const KEY_TYPES = new Set(["nvarchar", "int", "decimal", "datetime", "lookup", "picklist"]);
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
// Owner columns of a user-owned table, stored like the seeded security tables.
const OWNER_FIELDS = {
  ownerid: { dataverseType: "owner", targets: ["systemuser", "team"] },
  owninguser: { dataverseType: "lookup", targets: ["systemuser"] },
  owningteam: { dataverseType: "lookup", targets: ["team"] },
  owningbusinessunit: { dataverseType: "lookup", targets: ["businessunit"] },
};

// Error text and inner codes come from the gap review; the messages and statuses are unverified.
const fail = (message, status = 400, code = "InvalidRequest", innerCode) => new DataError(message, status, code, innerCode ? { innerCode } : undefined);
const schemaNameError = (name, type) => fail(`The schema name ${name} for type ${type} is invalid or missing.Custom attribute, entity, entitykey, option set and relationship names must start with a valid customization prefix.`, 400, "InvalidRequest", "0x80044366");
const attributeExists = (name, table) => fail(`Attribute ${name} already exists for entity ${table}.`, 400, "InvalidRequest", "0x80060304");
const entitySetExists = (set) => fail(`An entity with the specified entity set name ${set} already exists.`, 400, "InvalidRequest", "0x8006089B");

const requireText = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw fail(`${name} is required.`);
  return value.trim();
};
const guidOf = (text) => GUID.exec(String(text ?? "").trim())?.[1].toLowerCase() ?? null;
const typeOf = (attr) => String(attr?.["@odata.type"] ?? "").replace(/^#?Microsoft\.Dynamics\.CRM\./, "");
const ids = (api) => createMetadataService({ organizationId: api.settings.organizationId, schema: api.schema ?? null, mappings: () => api.store.state.mappings });
const urlOf = (c, path) => `${c.origin}/api/data/${c.version}/${path}`;
const mergeHeader = (headers = {}) => String(headers["mscrm.mergelabels"] ?? "").toLowerCase() === "true";
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

function optionSetOf(attr) {
  const bind = attr["GlobalOptionSet@odata.bind"];
  if (bind) {
    const name = GLOBAL_SET.exec(String(bind))?.[1];
    if (!name) throw fail("GlobalOptionSet@odata.bind must name a global option set."); // unverified
    return { isGlobal: true, name };
  }
  const options = attr.OptionSet?.Options;
  if (!Array.isArray(options)) throw fail("A picklist column needs OptionSet.Options or GlobalOptionSet@odata.bind."); // unverified
  return { options: options.map((o) => ({ value: Number(o.Value), labels: labelMap(o.Label) ?? {} })) };
}

// Column definition as the read side expects it: dataverseType plus columnMetadata facts (attribute-metadata.mjs).
function columnField(attr, dataverseType, schemaName, primary) {
  const facts = {
    type: dataverseType,
    schemaName,
    labels: labelMap(attr.DisplayName) ?? {},
    descriptionLabels: labelMap(attr.Description) ?? {},
    requiredLevel: requiredLevelOf(attr.RequiredLevel),
    isCustomField: true,
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
        options: [
          { value: 1, labels: labelMap(attr.OptionSet?.TrueOption?.Label) ?? {} },
          { value: 0, labels: labelMap(attr.OptionSet?.FalseOption?.Label) ?? {} },
        ],
      };
      facts.appDefaultValue = attr.DefaultValue === true ? "1" : "0";
      break;
    case "picklist":
    case "multiselectpicklist":
      facts.optionSet = optionSetOf(attr);
      break;
    case "file":
    case "image":
      facts.maxSizeInKB = attr.MaxSizeInKB ?? null; // unverified: File and Image column facts
      break;
  }
  return { ...field, columnMetadata: facts };
}

// Adds one column to a mapping and returns its logical name. A File column also gets <col>_name.
function addColumn(mapping, table, attr, { primary = false } = {}) {
  const type = typeOf(attr);
  const dataverseType = COLUMN_TYPES[type];
  if (!dataverseType) throw fail(`${type || "A column without a type"} is not supported by the simulator.`, 501, "NotImplemented"); // unverified
  const schemaName = requireText(attr.SchemaName, "SchemaName");
  if (!SCHEMA_PREFIX.test(schemaName)) throw schemaNameError(schemaName, "Attribute");
  const name = schemaName.toLowerCase();
  const taken = (n) => Object.hasOwn(mapping.fields, n) || n === mapping.idColumn;
  if (taken(name) || (dataverseType === "file" && taken(`${name}_name`))) throw attributeExists(name, table);
  mapping.fields[name] = columnField(attr, dataverseType, schemaName, primary);
  if (dataverseType === "file") {
    mapping.fields[`${name}_name`] = {
      dataverseType: "nvarchar",
      columnMetadata: { type: "nvarchar", schemaName: `${schemaName}_Name`, labels: {}, descriptionLabels: {}, requiredLevel: "none", isCustomField: true, maxLength: 300 }, // unverified: name column size
    };
  }
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

// Writes go to userConfigured, dataverseOnly tables only.
function userTable(api, key) {
  const logical = tableNameOf(api, key);
  const mapping = logical ? api.store.state.mappings[logical] : undefined;
  if (!mapping) throw fail(`${key} does not exist.`, 404, "NotFound"); // unverified
  if (mapping.dataverseOnly !== true) throw fail(`${logical} is a solution table and cannot be changed through the Web API.`); // unverified
  return { logical, mapping };
}

function columnNamed(api, logical, mapping, attributeId) {
  const service = ids(api);
  const name = Object.keys(mapping.fields).find((n) => service.metadataId("attribute", logical, n).toLowerCase() === guidOf(attributeId));
  if (!name) throw fail(`Attribute ${attributeId} does not exist.`, 404, "NotFound"); // unverified
  return name;
}

const entityIdUrl = (c, logical) => urlOf(c, `EntityDefinitions(${ids(c.api).metadataId("entity", logical)})`);
const attributeIdUrl = (c, logical, name) => urlOf(c, `EntityDefinitions(${ids(c.api).metadataId("entity", logical)})/Attributes(${ids(c.api).metadataId("attribute", logical, name)})`);

function createTable(c, body) {
  const { api } = c;
  const schemaName = requireText(body.SchemaName, "SchemaName");
  if (!SCHEMA_PREFIX.test(schemaName)) throw schemaNameError(schemaName, "Entity");
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
    },
  };
  mapping.nameColumn = addColumn(mapping, logical, primaries[0], { primary: true });
  for (const attr of attributes) if (attr !== primaries[0]) addColumn(mapping, logical, attr);
  mappings[logical] = mapping;
  (api.store.state.tables ??= {})[logical] ??= [];
  return { status: 204, headers: { "OData-EntityId": entityIdUrl(c, logical) } };
}

function updateTable(c, key, body) {
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
  return { status: 204 };
}

function deleteTable(c, key) {
  const { logical } = userTable(c.api, key);
  delete c.api.store.state.mappings[logical];
  delete c.api.store.state.tables?.[logical];
  return { status: 204 };
}

function createColumn(c, key, body) {
  const { logical, mapping } = userTable(c.api, key);
  const name = addColumn(mapping, logical, body);
  const url = attributeIdUrl(c, logical, name);
  return { status: 204, headers: { "OData-EntityId": url, ...(mapping.fields[name].columnMetadata.type === "file" ? { Location: url } : {}) } }; // unverified: Location on File
}

function updateColumn(c, key, attributeId, body) {
  const { logical, mapping } = userTable(c.api, key);
  const field = mapping.fields[columnNamed(c.api, logical, mapping, attributeId)];
  const facts = field.columnMetadata;
  if (!facts) throw fail("A system column cannot be changed."); // unverified
  const merge = mergeHeader(c.headers);
  if (body.DisplayName !== undefined) facts.labels = mergeLabels(facts.labels, labelMap(body.DisplayName), merge);
  if (body.Description !== undefined) facts.descriptionLabels = mergeLabels(facts.descriptionLabels, labelMap(body.Description), merge);
  if (body.RequiredLevel !== undefined) facts.requiredLevel = requiredLevelOf(body.RequiredLevel);
  return { status: 204 };
}

function deleteColumn(c, key, attributeId) {
  const { logical, mapping } = userTable(c.api, key);
  const name = columnNamed(c.api, logical, mapping, attributeId);
  const facts = mapping.fields[name].columnMetadata;
  if (!facts) throw fail("A system column cannot be deleted."); // unverified
  if (facts.isPrimaryName) throw fail("The primary name column cannot be deleted."); // unverified
  if ((mapping.alternateKeys ?? []).some((k) => k.attributes.includes(name))) throw fail(`${name} is used by an alternate key.`); // unverified
  const removed = [name, ...(facts.type === "file" ? [`${name}_name`] : [])];
  for (const column of removed) {
    delete mapping.fields[column];
    for (const row of c.api.store.state.tables?.[logical] ?? []) delete row[column];
  }
  return { status: 204 };
}

function createKey(c, key, body) {
  const { api } = c;
  const { logical, mapping } = userTable(api, key);
  const schemaName = requireText(body.SchemaName, "SchemaName");
  if (!SCHEMA_PREFIX.test(schemaName)) throw schemaNameError(schemaName, "EntityKey");
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
  mapping.alternateKeys = [...keys, { name, schemaName, attributes, labels: labelMap(body.DisplayName) ?? {} }];
  const keyId = ids(api).metadataId("key", logical, name);
  return { status: 204, headers: { "OData-EntityId": urlOf(c, `EntityDefinitions(${ids(api).metadataId("entity", logical)})/Keys(${keyId})`) } };
}

// PublishXml and PublishAllXml are accepted and do nothing: changes already apply to the simulated model.
function publish(c) {
  if (c.method !== "POST") throw fail(`${c.method} is not supported for ${c.route.name}.`, 405, "MethodNotAllowed"); // unverified
  if (c.route.name === "PublishXml" && typeof c.body?.ParameterXml !== "string") throw fail("ParameterXml is required."); // unverified
  return { status: 204 };
}

export function install(api) {
  api.addRoute((pathname, method) => method !== "GET" && WRITE_PATH.test(pathname), (c) => handleMetadataWrite({ ...c, api }));
}

/** Dispatches one metadata write. Each change runs in one store transaction, so a failed step leaves the model unchanged. */
export async function handleMetadataWrite(c) {
  const { api, method, route } = c;
  if (route.kind === "function") {
    if (!PUBLISH.has(route.name)) throw fail(`${route.name} is not a metadata action.`, 404, "NotFound"); // unverified
    return publish(c);
  }
  if (route.set !== "EntityDefinitions") throw fail(`${route.set} is not a metadata resource.`, 404, "NotFound"); // unverified
  if (c.body !== undefined && (typeof c.body !== "object" || c.body === null || Array.isArray(c.body))) throw fail("The request body must be a JSON object."); // unverified
  const body = c.body ?? {};
  const { segment, key, segmentKey } = route;
  const write = (fn) => api.change(() => api.store.transact(fn));
  if (!segment && !key && method === "POST") return write(() => createTable(c, body));
  if (!segment && key && method === "PUT") return write(() => updateTable(c, key, body));
  if (!segment && key && method === "DELETE") return write(() => deleteTable(c, key));
  if (segment === "Attributes" && key && !segmentKey && method === "POST") return write(() => createColumn(c, key, body));
  if (segment === "Attributes" && key && segmentKey && method === "PUT") return write(() => updateColumn(c, key, segmentKey, body));
  if (segment === "Attributes" && key && segmentKey && method === "DELETE") return write(() => deleteColumn(c, key, segmentKey));
  if (segment === "Keys" && key && !segmentKey && method === "POST") return write(() => createKey(c, key, body));
  throw fail(`${method} is not supported for ${route.set}${segment ? `/${segment}` : ""}.`, 405, "MethodNotAllowed"); // unverified: PATCH on definitions
}
