// Dataverse metadata for the simulated Web API: EntityDefinitions, Attributes, Keys,
// RelationshipDefinitions and GlobalOptionSetDefinitions. A Solution schema table wins over the
// store mapping of the same name; virtual tables are read-only fallbacks. Shapes follow
// webapi-contract.md section 1 ($metadata CSDL) and section 8 (RetrieveMetadataChanges).
import { isDateOnlyField } from "./dataverse-values.mjs";
import { createHash } from "node:crypto";
import { attributeMetadata } from "./attribute-metadata.mjs";
import { tableFields } from "./solution-schema.mjs";
import { pluralizeEntitySetName, standardTable } from "./solution-standard.mjs";
import { ACCESS_RIGHTS, ownershipOf, ownershipTypeName, privilegeId, privilegeName, privilegeNounOf } from "./dataverse-security.mjs";
import { expiredVersionStamp } from "./dataverse-changes.mjs";
import { DataError } from "./data-error.mjs";
import { relationshipsOf, standardFields, standardGlobalOptionSets, standardTableDef } from "./dataverse-standard.mjs";
import { MANAGED_MEMBERS } from "./dataverse-soap-contracts.mjs";
import { platformCsdl } from "./dataverse-operation-contracts.mjs";

const PREFIX = /^[a-z0-9]+_/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_TYPE_CODES = {
  account: 1, contact: 2, opportunity: 3, lead: 4, annotation: 5, systemuser: 8, team: 9, businessunit: 10,
  organization: 1019, privilege: 1023, role: 1036, systemuserroles: 1037, roleprivileges: 1024, teamroles: 2021,
  teammembership: 1038, queue: 2020, transactioncurrency: 9105, task: 4212, email: 4202, phonecall: 4210,
  appointment: 4201, activitypointer: 4200, webresource: 9333, savedquery: 1039, systemform: 1030, solution: 7100,
};
// dataverseType -> [AttributeType, @odata.type stem, AttributeTypeName]. Multi-select reports AttributeType Virtual.
const TYPES = {
  nvarchar: ["String", "String", "StringType"], string: ["String", "String", "StringType"],
  memo: ["Memo", "Memo", "MemoType"], ntext: ["Memo", "Memo", "MemoType"],
  int: ["Integer", "Integer", "IntegerType"], integer: ["Integer", "Integer", "IntegerType"],
  bigint: ["BigInt", "BigInt", "BigIntType"], decimal: ["Decimal", "Decimal", "DecimalType"],
  float: ["Double", "Double", "DoubleType"], double: ["Double", "Double", "DoubleType"],
  money: ["Money", "Money", "MoneyType"],
  bit: ["Boolean", "Boolean", "BooleanType"], boolean: ["Boolean", "Boolean", "BooleanType"],
  datetime: ["DateTime", "DateTime", "DateTimeType"],
  // Owner and customer are LookupAttributeMetadata with their own AttributeType and AttributeTypeName.
  lookup: ["Lookup", "Lookup", "LookupType"], customer: ["Customer", "Lookup", "CustomerType"],
  owner: ["Owner", "Lookup", "OwnerType"],
  picklist: ["Picklist", "Picklist", "PicklistType"], state: ["State", "State", "StateType"],
  status: ["Status", "Status", "StatusType"],
  multiselectpicklist: ["Virtual", "MultiSelectPicklist", "MultiSelectPicklistType"],
  primarykey: ["Uniqueidentifier", "UniqueIdentifier", "UniqueidentifierType"],
  uniqueidentifier: ["Uniqueidentifier", "UniqueIdentifier", "UniqueidentifierType"],
  entityname: ["EntityName", "EntityName", "EntityNameType"],
  // File and image columns: FileAttributeMetadata / ImageAttributeMetadata. attribute-metadata.mjs is portal-visible, so they live here.
  file: ["Virtual", "File", "FileType"], image: ["Virtual", "Image", "ImageType"],
  partylist: ["PartyList", "Lookup", "PartyListType"], managedproperty: ["ManagedProperty", "ManagedProperty", "ManagedPropertyType"],
};
// Columns built from the compact shape even when exported (no file/image branch in attribute-metadata.mjs).
const COMPACT_TYPES = new Set(["file", "image", "partylist", "managedproperty"]);
// EntityFilters flags (RetrieveEntity): Default and Entity are 1, All is 15.
const ENTITY_FILTERS = { default: 1, entity: 1, attributes: 2, privileges: 4, relationships: 8, all: 15 };
// DeletedMetadataFilters flags (Web API enum: no Entity member, Default stands for entities; Microsoft Learn cache-schema-data).
const DELETED_FILTERS = { default: 1, attribute: 2, relationship: 4, label: 8, optionset: 16, all: 31 };
// Deleted kinds in filter order: [DeletedMetadata key, filter bit, change-log kind].
const DELETED_KINDS = [["Default", 1, "entity"], ["Attribute", 2, "attribute"], ["Relationship", 4, "relationship"], ["OptionSet", 16, "optionset"]];
// SecurityPrivilegeMetadata.PrivilegeType by right; the rights of a table follow dataverse-security.mjs (organization-owned: no Assign or Share).
const PRIVILEGE_TYPE = { Create: 1, Read: 2, Write: 3, Delete: 4, Assign: 5, Share: 6, Append: 7, AppendTo: 8 };
const ORGANIZATION_RIGHTS = ["Create", "Read", "Write", "Delete", "Append", "AppendTo"];
// Organization.ExpireSubscriptionsInDays, default 90 (Microsoft Learn cache-schema-data). The simulator does not read the org setting.
const EXPIRE_DAYS = 90;
const DAY_MS = 86400000;
// ServerVersionStamp / ClientVersionStamp text: "<seq>!MM/dd/yyyy HH:mm:ss" (UTC).
const STAMP = /^(\d+)!(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const CHANGE_TRACKING = "Org.OData.Capabilities.V1.ChangeTracking";
// RelationshipMetadataBase properties (Microsoft Learn RelationshipMetadataBase EntityType, with MetadataBase's MetadataId and
// HasChanged): what an uncast RelationshipDefinitions query returns.
const RELATIONSHIP_BASE = ["MetadataId", "HasChanged", "IntroducedVersion", "IsCustomizable", "IsCustomRelationship", "IsManaged", "IsValidForAdvancedFind", "RelationshipType", "SchemaName", "SecurityTypes"];
// SecurityTypes (flags enum, Learn) by RelationshipBehavior. Native captures show exactly these pairs: 0 None, 1 Append, 2 ParentChild.
const RELATIONSHIP_SECURITY = ["None", "Append", "ParentChild"];
// Native AssociatedMenuConfiguration of one relationship (unverified: a single live sample; Behavior and Order vary by relationship).
const associatedMenu = () => ({ Behavior: "DoNotDisplay", Group: "Details", Label: { LocalizedLabels: [], UserLocalizedLabel: null }, Order: null, AvailableOffline: true, Icon: null, IsCustomizable: false, MenuId: null, QueryApi: null, ViewId: "00000000-0000-0000-0000-000000000000" });
// Shape keys a mapping's dataverseMetadata may not replace.
const OVERRIDE_SKIP = new Set(["@odata.type", "MetadataId", "LogicalName", "EntityLogicalName", "AttributeType", "AttributeTypeName", "HasChanged", "IsAuditEnabled", "IsSecured"]);
const REQUIRED = { none: "None", systemrequired: "SystemRequired", applicationrequired: "ApplicationRequired", required: "ApplicationRequired" };
const REQUIRED_NAMES = ["None", "SystemRequired", "ApplicationRequired", "Recommended"]; // AttributeRequiredLevel, by number
const READ_ONLY = new Set(["createdon", "modifiedon", "createdby", "modifiedby", "versionnumber", "owninguser", "owningteam", "owningbusinessunit"]);
// Columns every standard table has (solution exports omit them); owner columns only for user-owned tables.
// Principal tables (systemuser, team) derive from the mscrm.principal base type, whose key is ownerid.
const SYSTEM_COLUMNS = {
  createdon: { dataverseType: "datetime", label: "Created On", schemaName: "CreatedOn" },
  modifiedon: { dataverseType: "datetime", label: "Modified On", schemaName: "ModifiedOn" },
  createdby: { dataverseType: "lookup", targets: ["systemuser"], label: "Created By", schemaName: "CreatedBy" },
  modifiedby: { dataverseType: "lookup", targets: ["systemuser"], label: "Modified By", schemaName: "ModifiedBy" },
  statecode: { dataverseType: "state", label: "Status", schemaName: "StateCode", options: [{ value: 0, label: "Active" }, { value: 1, label: "Inactive" }] },
  statuscode: { dataverseType: "status", label: "Status Reason", schemaName: "StatusCode", statuses: [{ value: 1, label: "Active", state: 0 }, { value: 2, label: "Inactive", state: 1 }] },
  versionnumber: { dataverseType: "bigint", label: "Version Number", schemaName: "VersionNumber" },
};
const OWNER_COLUMNS = {
  ownerid: { dataverseType: "owner", targets: ["systemuser", "team"], label: "Owner", schemaName: "OwnerId" },
  owninguser: { dataverseType: "lookup", targets: ["systemuser"], label: "Owning User", schemaName: "OwningUser" },
  owningteam: { dataverseType: "lookup", targets: ["team"], label: "Owning Team", schemaName: "OwningTeam" },
  owningbusinessunit: { dataverseType: "lookup", targets: ["businessunit"], label: "Owning Business Unit", schemaName: "OwningBusinessUnit" },
};
const PRINCIPAL_TABLES = new Set(["systemuser", "team"]);
const FILTER_KEYWORDS = new Set(["and", "or", "not", "eq", "ne", "true", "false", "null"]);

const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
const own = (object, key) => (object && Object.hasOwn(object, key) ? object[key] : null);
const listOf = (value) => (value == null ? [] : (Array.isArray(value) ? value : String(value).split(","))).map((item) => String(item).trim()).filter(Boolean);
const castName = (cast) => String(cast).replace(/^#/, "").replace(/^Microsoft\.Dynamics\.CRM\./, "");
// Casts accepted on Attributes: the AttributeMetadata derived EntityTypes of the captured CSDL (metadata.xml). The leaf types
// this module emits (TYPES stems) match by exact type; the Enum base matches its enum stems; the base matches every column.
// Owner and Customer have no derived type in the CSDL (their columns are LookupAttributeMetadata), so casting to them is unknown.
// ponytail: a stem added to TYPES is accepted here automatically; a CSDL type this module never emits matches no column.
const ENUM_STEMS = new Set(["Picklist", "MultiSelectPicklist", "State", "Status", "EntityName"]);
const ATTRIBUTE_CASTS = new Set([
  "AttributeMetadata", "EnumAttributeMetadata", "ManagedPropertyAttributeMetadata",
  ...Object.values(TYPES).map(([, stem]) => `${stem}AttributeMetadata`),
]);
const castMatches = (name, attribute) => {
  if (name === "AttributeMetadata") return true;
  if (name === "EnumAttributeMetadata") return ENUM_STEMS.has(stemOf(attribute));
  return attribute["@odata.type"] === `#Microsoft.Dynamics.CRM.${name}`;
};
const keyName = (text) => /^(?:LogicalName|SchemaName)=['"]?([^'")]+)['"]?$/i.exec(String(text))?.[1]?.toLowerCase() ?? null;
const unsupported = (message) => Object.assign(new Error(message), { status: 400, code: "UnsupportedQuery" });
const xmlEscape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
// csdl writer: xmlElement(tag, attrs, ...children) returns indented lines; null attributes are skipped, children may nest.
function xmlElement(tag, attrs, ...children) {
  const text = Object.entries(attrs).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${xmlEscape(v)}"`).join("");
  const body = children.flat(Infinity);
  return body.length ? [`<${tag}${text}>`, ...body.map((line) => `  ${line}`), `</${tag}>`] : [`<${tag}${text} />`];
}
const xmlFixed = (text) => text.split("\n").filter(Boolean);
const labelText = (block) => block?.UserLocalizedLabel?.Label ?? null;
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const KEYS = "OData.Community.Keys.V1";
const DESCRIPTION = "Org.OData.Core.V1.Description";
const COMPUTED = "Org.OData.Core.V1.Computed";
// Edm primitive per AttributeMetadata type stem (attribute-metadata.mjs mapping); lookups are Guids behind _<name>_value.
const EDM = {
  UniqueIdentifier: "Edm.Guid", Lookup: "Edm.Guid",
  String: "Edm.String", Memo: "Edm.String", EntityName: "Edm.String", MultiSelectPicklist: "Edm.String",
  Integer: "Edm.Int32", Picklist: "Edm.Int32", State: "Edm.Int32", Status: "Edm.Int32",
  BigInt: "Edm.Int64", Decimal: "Edm.Decimal", Money: "Edm.Decimal", Double: "Edm.Double",
  Boolean: "Edm.Boolean", DateTime: "Edm.DateTimeOffset",
};
const stemOf = (attribute) => attribute["@odata.type"].replace(/^#Microsoft\.Dynamics\.CRM\./, "").replace(/AttributeMetadata$/, "");
// Change log: state.dataverse.metadataLog, appended by the metadata writers (the service reads it through changeLog).
// One entry per changed item: { seq, at, op, kind, logical, name }
//   seq      integer, 1-based, strictly increasing: a writer appends with last seq + 1. The server stamp is the last seq.
//   at       when the change happened (ISO string, Date or epoch ms); its UTC time is the time part of the stamp.
//   op       'add' | 'change' | 'delete'
//   kind     'entity' | 'attribute' | 'relationship' | 'optionset'
//   logical  table logical name for entity and attribute entries, else null
//   name     attribute LogicalName, relationship SchemaName or option set Name
// MetadataIds are derived here, so writers log names only. Entries are never trimmed; a stamp below the first entry is expired.
// Change responses keep these base keys; each expansion is filtered by the query section named here.
const CHANGE_KEYS = new Set(["@odata.type", "MetadataId", "LogicalName", "HasChanged"]);
const NESTED = { Attributes: "AttributeQuery", Keys: "KeyQuery", OneToManyRelationships: "RelationshipQuery", ManyToOneRelationships: "RelationshipQuery", ManyToManyRelationships: "RelationshipQuery" };
const ALIASES = { AttributeTypeCode: "AttributeType" };

function uuidV5(namespace, name) {
  const text = String(namespace ?? "");
  const ns = GUID.test(text) ? Buffer.from(text.replace(/-/g, ""), "hex") : createHash("sha1").update(text).digest().subarray(0, 16);
  const hash = createHash("sha1").update(ns).update(String(name), "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Localized label block; labels is an lcid-keyed object (Solution exports), fallback a plain text.
function labelBlock(labels, fallback, lcid) {
  const entries = Object.entries(labels ?? {})
    .filter(([code, text]) => /^\d+$/.test(code) && text !== undefined && text !== null && text !== "")
    .map(([code, text]) => [Number(code), String(text)]);
  if (!entries.length && fallback) entries.push([lcid, String(fallback)]);
  const label = ([code, text]) => ({ Label: text, LanguageCode: code, IsManaged: false, MetadataId: null, HasChanged: null });
  const user = entries.find(([code]) => code === lcid) ?? entries[0];
  return { LocalizedLabels: entries.map(label), UserLocalizedLabel: user ? label(user) : null };
}

// LabelLanguages=<lcid,...>: keeps only those LocalizedLabels entries, anywhere in the shape. No languages = unchanged.
function limitLabels(value, languages) {
  const wanted = listOf(languages).map(Number);
  if (!wanted.length) return value;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const out = {};
    for (const [key, child] of Object.entries(node)) {
      out[key] = key === "LocalizedLabels" && Array.isArray(child) ? child.filter((label) => wanted.includes(label.LanguageCode)) : walk(child);
    }
    return out;
  };
  return walk(value);
}

// Flag enum value: a number, a flag name list ("Attributes,Relationships") or the enum form Microsoft.Dynamics.CRM.Type'All'. Absent = fallback.
function flagBits(value, table, fallback, type) {
  if (value == null || value === "") return fallback;
  if (/^\d+$/.test(String(value))) return Number(value);
  let bits = 0;
  for (const part of String(value).split(/[,|+\s]+/).filter(Boolean)) {
    const bit = table[part.replace(/^Microsoft\.Dynamics\.CRM\.\w+/i, "").replace(/'/g, "").toLowerCase()];
    if (!bit) throw unsupported(`Unknown ${type} value '${part}'.`);
    bits |= bit;
  }
  return bits;
}
const entityFilterBits = (value) => flagBits(value, ENTITY_FILTERS, ENTITY_FILTERS.entity, "EntityFilters");
const deletedBits = (value) => flagBits(value, DELETED_FILTERS, 0, "DeletedMetadataFilters"); // absent: no deleted items (the docs need both a stamp and a filter)

// ManagedProperty flags arrive as booleans or as { Value } (BooleanManagedProperty); a missing value is false.
const boolOf = (value) => (value !== null && typeof value === "object" ? value.Value === true : value === true);
const auditFlag = (value, canBeChanged, name) => ({ Value: boolOf(value), CanBeChanged: canBeChanged, ManagedPropertyLogicalName: name });

// Mapping dataverseMetadata: a key the shape already has takes the mapping's value (identity keys excluded).
function withOverrides(shape, overrides) {
  for (const [key, value] of Object.entries(overrides ?? {})) if (!OVERRIDE_SKIP.has(key) && Object.hasOwn(shape, key)) shape[key] = value;
  return shape;
}

const optionOf = (o, lcid) => ({
  Value: o.value,
  Label: labelBlock(o.labels, o.label ?? String(o.value), lcid),
  Description: labelBlock(o.descriptionLabels, null, lcid),
  Color: o.color ?? null,
  IsManaged: false,
  ExternalValue: null,
  ParentValues: [],
  Tag: null,
  IsHidden: false,
  MetadataId: null,
  HasChanged: null,
  ...(o.state !== undefined ? { State: o.state } : {}),
});

// $filter over metadata: eq/ne, and/or/not, parentheses, string/number/GUID/boolean/null and
// enum literals (Namespace.Type'Member'). '+' separates tokens outside string literals.
const TOKEN = /^[\s+]*(?:(\()|(\))|'((?:[^']|'')*)'|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\w-])|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w.]*(?:\/[A-Za-z_]\w*)*)(?:'((?:[^']|'')*)')?)/i;

function toToken(m) {
  if (m[1]) return { t: "(" };
  if (m[2]) return { t: ")" };
  if (m[3] !== undefined) return { t: "lit", v: m[3].replace(/''/g, "'") };
  if (m[4]) return { t: "lit", v: m[4] };
  if (m[5]) return { t: "lit", v: Number(m[5]) };
  if (m[7] !== undefined) return { t: "lit", v: m[7].replace(/''/g, "'") };
  return { t: "id", v: m[6] };
}

function tokenize(text) {
  const tokens = [];
  let rest = text;
  while (/[^\s+]/.test(rest)) {
    const m = TOKEN.exec(rest);
    if (!m) throw unsupported(`Unsupported $filter syntax: ${text}`);
    tokens.push(toToken(m));
    rest = rest.slice(m[0].length);
  }
  return tokens;
}

function parseFilter(text) {
  const tokens = tokenize(text);
  let i = 0;
  const fail = () => {
    throw unsupported(`Unsupported $filter expression: ${text}`);
  };
  const word = (w) => tokens[i]?.t === "id" && tokens[i].v === w;
  const orExpr = () => {
    let node = andExpr();
    while (word("or")) { i++; node = { op: "or", a: node, b: andExpr() }; }
    return node;
  };
  const andExpr = () => {
    let node = notExpr();
    while (word("and")) { i++; node = { op: "and", a: node, b: notExpr() }; }
    return node;
  };
  const notExpr = () => {
    if (word("not")) { i++; return { op: "not", a: notExpr() }; }
    return comparison();
  };
  const comparison = () => {
    if (tokens[i]?.t === "(") {
      i++;
      const node = orExpr();
      if (tokens[i]?.t !== ")") fail();
      i++;
      return node;
    }
    const left = tokens[i];
    const op = tokens[i + 1];
    if (left?.t !== "id" || FILTER_KEYWORDS.has(left.v) || op?.t !== "id" || !["eq", "ne"].includes(op.v)) fail();
    i += 2;
    const right = tokens[i++];
    const path = left.v.split("/");
    if (right?.t === "lit") return { op: op.v, path, value: right.v };
    if (right?.t === "id" && ["true", "false", "null"].includes(right.v)) return { op: op.v, path, value: right.v === "null" ? null : right.v === "true" };
    return fail();
  };
  const node = orExpr();
  if (i !== tokens.length) fail();
  return node;
}

function equal(a, b) {
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  if (typeof a === "string" && typeof b === "string" && GUID.test(a) && GUID.test(b)) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function evaluate(node, item) {
  if (node.op === "and") return evaluate(node.a, item) && evaluate(node.b, item);
  if (node.op === "or") return evaluate(node.a, item) || evaluate(node.b, item);
  if (node.op === "not") return !evaluate(node.a, item);
  const value = node.path.reduce((current, key) => (current == null ? undefined : current[key]), item);
  const same = equal(value, node.value);
  return node.op === "eq" ? same : !same;
}

// RetrieveMetadataChanges conditions: Value.Type picks the coercion; Guid and enum text compare through equal().
// A plain JSON value (Web API) is taken as it is; a typed { Type, Value } is coerced by its type.
function coerceValue(value) {
  if (Array.isArray(value)) return value.map(coerceValue);
  if (value === null || typeof value !== "object") return value ?? null;
  const type = String(value.Type ?? "");
  const raw = value.Value ?? null;
  if (type.endsWith("[]")) return listOf(raw);
  if (/Boolean$/.test(type)) return String(raw).toLowerCase() === "true";
  if (/(Int16|Int32|Int64|Decimal|Double)$/.test(type)) return Number(raw);
  return raw;
}

// Nested Value properties (RequiredLevel/Value style) compare by their Value.
const unwrap = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) && "Value" in value ? value.Value : value);
const nodesOf = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

function conditionMatches(item, c) {
  const actual = unwrap(item[ALIASES[c.PropertyName] ?? c.PropertyName]);
  const want = coerceValue(c.Value);
  switch (c.ConditionOperator) {
    case "Equals": return equal(actual, want);
    case "NotEquals": return !equal(actual, want);
    case "In": return [want].flat().some((v) => equal(actual, v));
    case "NotIn": return ![want].flat().some((v) => equal(actual, v));
    case "GreaterThan": return actual > want;
    case "LessThan": return actual < want;
    default: throw unsupported(`Unsupported metadata condition: ${c.ConditionOperator}`);
  }
}

// Conditions and nested Filters combine under the one FilterOperator (And when absent). Nothing to test matches every item.
function matchesAll(item, criteria) {
  const conditions = nodesOf(criteria?.Conditions);
  const filters = nodesOf(criteria?.Filters);
  if (!conditions.length && !filters.length) return true;
  const results = [
    ...conditions.map((c) => conditionMatches(item, c)),
    ...filters.map((f) => matchesAll(item, f)),
  ];
  const or = String(criteria.FilterOperator ?? "And").toLowerCase() === "or" || String(criteria.FilterOperator) === "1";
  return or ? results.some(Boolean) : results.every(Boolean);
}

// ManagedProperty<T> members (MANAGED_MEMBERS, the table the SOAP writer shares) are objects in the JSON too: a plain value
// becomes { Value, CanBeChanged, ManagedPropertyLogicalName }. Members already in that shape are left as they are.
function managedMembers(meta, contracts) {
  for (const contract of contracts) {
    for (const [name, logical] of Object.entries(MANAGED_MEMBERS[contract] ?? {})) {
      const value = meta[name];
      if (value === undefined || (value !== null && typeof value === "object")) continue;
      meta[name] = { Value: value, CanBeChanged: true, ManagedPropertyLogicalName: logical };
    }
  }
  return meta;
}

// One requested item: null when its Criteria fails; else the base keys plus the requested properties (all when none are named).
function projectChange(item, section) {
  if (!matchesAll(item, section?.Criteria)) return null;
  const props = section?.Properties ?? { AllProperties: true };
  const names = listOf(props.PropertyNames);
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (CHANGE_KEYS.has(key) || props.AllProperties === true || names.includes(key)) out[key] = value;
  }
  if (typeof out["@odata.type"] === "string") out["@odata.type"] = out["@odata.type"].replace("#Microsoft.Dynamics.CRM.", "#Microsoft.Dynamics.CRM.Complex");
  return out;
}

const CSDL_TYPES = `<EntityType Name="crmbaseentity" Abstract="true" />
<EntityType Name="expando" BaseType="mscrm.crmbaseentity" OpenType="true" />
<EntityType Name="crmmodelbaseentity" Abstract="true" />
<EntityType Name="principal" BaseType="mscrm.crmbaseentity" Abstract="true">
  <Key>
    <PropertyRef Name="ownerid" />
  </Key>
  <Property Name="ownerid" Type="Edm.Guid" Nullable="false" />
</EntityType>















<EnumType Name="SchemaType">
  <Member Name="Standard" />
  <Member Name="Core" />
  <Member Name="Full" />
  <Member Name="Uno" />
</EnumType>



<ComplexType Name="MetadataConditionValue">
  <Property Name="Type" Type="Edm.String" />
  <Property Name="Value" Type="Edm.String" />
</ComplexType>


<ComplexType Name="MetadataQueryExpression">
  <Property Name="Properties" Type="mscrm.MetadataPropertiesExpression" />
  <Property Name="Criteria" Type="mscrm.MetadataFilterExpression" />
</ComplexType>`;

// Bound to the role table, so emitted only when that table exists.
const CSDL_ROLE_ACTIONS = `<Action Name="AddPrivilegesRole" IsBound="true">
  <Parameter Name="entity" Type="mscrm.role" Nullable="false" />
  <Parameter Name="Privileges" Type="Collection(mscrm.RolePrivilege)" />
</Action>`;

// Bound to the systemuser table, so emitted only when that table exists.
const CSDL_USER_FUNCTIONS = `<Function Name="RetrieveUserPrivileges" IsBound="true">
  <Parameter Name="entity" Type="mscrm.systemuser" Nullable="false" />
  <ReturnType Type="mscrm.RetrieveUserPrivilegesResponse" Nullable="false" />
</Function>
<Function Name="RetrievePrincipalAccess" IsBound="true">
  <Parameter Name="entity" Type="mscrm.systemuser" Nullable="false" />
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <ReturnType Type="mscrm.RetrievePrincipalAccessResponse" Nullable="false" />
</Function>`;

const CSDL_OPERATIONS = `<Function Name="WhoAmI">
  <ReturnType Type="mscrm.WhoAmIResponse" Nullable="false" />
</Function>
<Function Name="RetrieveMetadataChanges">
  <Parameter Name="Query" Type="mscrm.EntityQueryExpression" />
  <Parameter Name="ClientVersionStamp" Type="Edm.String" />
  <Parameter Name="DeletedMetadataFilters" Type="mscrm.DeletedMetadataFilters" Nullable="false" />
  <ReturnType Type="mscrm.RetrieveMetadataChangesResponse" Nullable="false" />
</Function>
<Function Name="RetrieveVersion">
  <ReturnType Type="mscrm.RetrieveVersionResponse" Nullable="false" />
</Function>
<Function Name="RetrieveCurrentOrganization">
  <Parameter Name="AccessType" Type="mscrm.EndpointAccessType" Nullable="false" />
  <ReturnType Type="mscrm.RetrieveCurrentOrganizationResponse" Nullable="false" />
</Function>
<Function Name="RetrieveTotalRecordCount">
  <Parameter Name="EntityNames" Type="Collection(Edm.String)" />
  <ReturnType Type="mscrm.RetrieveTotalRecordCountResponse" Nullable="false" />
</Function>
<Action Name="CreateMultiple" IsBound="true">
  <Parameter Name="entityset" Type="Collection(mscrm.crmbaseentity)" Nullable="false" />
  <Parameter Name="Targets" Type="Collection(mscrm.crmbaseentity)" Nullable="false" />
  <ReturnType Type="mscrm.CreateMultipleResponse" Nullable="false" />
</Action>
<Action Name="UpdateMultiple" IsBound="true">
  <Parameter Name="entityset" Type="Collection(mscrm.crmbaseentity)" Nullable="false" />
  <Parameter Name="Targets" Type="Collection(mscrm.crmbaseentity)" Nullable="false" />
</Action>
<Action Name="UpsertMultiple" IsBound="true">
  <Parameter Name="entityset" Type="Collection(mscrm.crmbaseentity)" Nullable="false" />
  <Parameter Name="Targets" Type="Collection(mscrm.crmbaseentity)" Nullable="false" />
</Action>
<Action Name="DeleteMultiple" IsBound="true">
  <Parameter Name="entityset" Type="Collection(mscrm.crmbaseentity)" Nullable="false" />
  <Parameter Name="Targets" Type="Collection(mscrm.crmbaseentity)" Nullable="false" />
</Action>
<Action Name="GrantAccess">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="PrincipalAccess" Type="mscrm.PrincipalAccess" />
</Action>
<Action Name="ModifyAccess">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="PrincipalAccess" Type="mscrm.PrincipalAccess" />
</Action>
<Action Name="RevokeAccess">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="Revokee" Type="mscrm.crmbaseentity" Nullable="false" />
</Action>`;

const CSDL_IMPORTS = `<FunctionImport Name="WhoAmI" Function="mscrm.WhoAmI" IncludeInServiceDocument="false" />
<FunctionImport Name="RetrieveVersion" Function="mscrm.RetrieveVersion" IncludeInServiceDocument="false" />
<FunctionImport Name="RetrieveCurrentOrganization" Function="mscrm.RetrieveCurrentOrganization" IncludeInServiceDocument="false" />
<FunctionImport Name="RetrieveTotalRecordCount" Function="mscrm.RetrieveTotalRecordCount" IncludeInServiceDocument="false" />
<FunctionImport Name="RetrieveMetadataChanges" Function="mscrm.RetrieveMetadataChanges" IncludeInServiceDocument="false" />
<ActionImport Name="GrantAccess" Action="mscrm.GrantAccess" />
<ActionImport Name="ModifyAccess" Action="mscrm.ModifyAccess" />
<ActionImport Name="RevokeAccess" Action="mscrm.RevokeAccess" />`;

// changeLog: the metadataLog array (or a function returning it), see the entry shape above. extraCsdl: CSDL text appended to $metadata
// (the registry's csdlFragments()). clock: ms epoch; the seeded stamp (seq 0) is dated at creation, and expiry is measured from it.
export function createMetadataService({ organizationId, schema, mappings, lcid = 1033, virtualTables, globalOptionSets, changeLog, extraCsdl, clock = () => Date.now() }) {
  const read = (source) => (typeof source === "function" ? source() : source) ?? null;
  const schemaRoot = () => read(schema);
  const mappingRoot = () => read(mappings) ?? {};
  const virtualRoot = () => read(virtualTables) ?? {};
  // relationshipsOf reads only state.mappings; the service has the mappings, not the store.
  const storeOf = () => ({ state: { mappings: mappingRoot() } });
  const baseAt = clock();
  const metadataIdOf = (kind, ...parts) => uuidV5(organizationId, `${kind}:${parts.join(":")}`);

  function logicalNames() {
    const names = [...Object.keys(schemaRoot()?.tables ?? {}), ...Object.keys(mappingRoot()), ...Object.keys(virtualRoot().tables ?? {})];
    return [...new Set(names.map((name) => name.toLowerCase()))].sort();
  }

  // One table as the service sees it: Solution schema table first, then store mapping, then virtual table.
  function source(name) {
    const logical = String(name ?? "").toLowerCase();
    const root = schemaRoot();
    const s = own(root?.tables, logical);
    const mapping = own(mappingRoot(), logical);
    const virtual = own(virtualRoot().tables, logical);
    const m = mapping ?? virtual?.mapping ?? null;
    if (!s && !m) return null;
    const std = standardTable(logical);
    // Standard file (standard-tables-plan 3.1): Solution export > standard file > mapping. Its fields go under the Solution's.
    const def = standardTableDef(logical);
    const thin = m?.fields ?? {};
    // API-created columns (customColumns, reapplied onto the mapping) stay above the standard columns.
    const custom = Object.fromEntries(Object.entries(thin).filter(([, f]) => f?.columnMetadata?.isManaged === false && f?.columnMetadata?.isCustomizable === true));
    return {
      logical,
      s,
      m,
      def,
      lcid,
      isVirtual: s ? Boolean(s.isVirtual) : !mapping,
      // One ownership answer per table, shared with the security model: 'user' | 'org'.
      ownership: ownershipOf(logical, s, m),
      // A Solution export that omits ownership takes the standard table's.
      ownershipType: !s?.ownership && def ? def.ownershipType : ownershipTypeName(logical, s, m),
      entitySet: s?.entitySetName ?? m?.entitySet ?? std?.entitySet ?? pluralizeEntitySetName(logical),
      idColumn: s?.primaryIdAttribute ?? m?.idColumn ?? std?.primaryIdAttribute ?? `${logical}id`,
      primaryName: s?.primaryNameAttribute ?? def?.primaryNameAttribute ?? m?.nameColumn ?? std?.primaryNameAttribute ?? null,
      fields: s ? { ...standardFields(logical), ...tableFields(root, logical) } : { ...thin, ...standardFields(logical), ...custom },
    };
  }

  function sourceFor(key) {
    const text = String(key ?? "").trim();
    const named = keyName(text);
    if (named) return source(named);
    if (GUID.test(text)) {
      const hit = logicalNames().find((name) => metadataIdOf("entity", name).toLowerCase() === text.toLowerCase());
      return hit ? source(hit) : null;
    }
    return source(text);
  }

  function entityOf(src) {
    const dm = src.m?.dataverseMetadata ?? {};
    // TableType: the mapping's (elastic tables come from a create body or the standard file); Standard otherwise.
    const elastic = (src.m?.tableType ?? src.def?.tableType) === "Elastic";
    const shape = {
      TableType: elastic ? "Elastic" : "Standard",
      MetadataId: metadataIdOf("entity", src.logical),
      LogicalName: src.logical,
      SchemaName: src.s?.schemaName ?? src.def?.schemaName ?? dm.schemaName ?? capitalize(src.logical),
      EntitySetName: src.entitySet,
      LogicalCollectionName: src.s?.logicalCollectionName ?? src.def?.logicalCollectionName ?? src.m?.logicalCollectionName ?? src.entitySet,
      PrimaryIdAttribute: src.idColumn,
      PrimaryNameAttribute: src.primaryName,
      ObjectTypeCode: dm.ObjectTypeCode ?? objectTypeCode(src.logical),
      OwnershipType: src.ownershipType,
      IsCustomEntity: PREFIX.test(src.logical),
      // Solution says so, else the standard table (the nine activitypointer-derived tables); false otherwise.
      IsActivity: Boolean(src.s?.isActivity ?? src.def?.isActivity),
      IsIntersect: Boolean(src.s?.isIntersect || src.m?.intersect),
      IsValidForAdvancedFind: true,
      IsPrivate: false,
      HasChanged: null,
      // Labels the 1.9 writer stores are dataverseMetadata.labels = { DisplayName, DisplayCollectionName, Description } of lcid maps.
      DisplayName: labelBlock(src.s?.labels ?? src.def?.labels ?? dm.labels?.DisplayName, src.m?.label ?? capitalize(src.logical), lcid),
      DisplayCollectionName: labelBlock(src.s?.collectionLabels ?? src.def?.collectionLabels ?? dm.labels?.DisplayCollectionName, src.m?.collectionLabel ?? capitalize(src.entitySet), lcid),
      Description: labelBlock(dm.labels?.Description ?? null, null, lcid),
      // Opt-in per table (Microsoft Learn use-change-tracking): the flag marks the entity set in $metadata when annotations=true.
      ChangeTrackingEnabled: boolOf(src.s?.changeTrackingEnabled ?? src.m?.changeTrackingEnabled ?? false),
      // Microsoft Learn optimistic-concurrency: enabled by default for custom tables. System-table support varies;
      // a supplied Solution/mapping fact wins and an unknown system table is not asserted enabled or disabled.
      IsOptimisticConcurrencyEnabled: src.s?.isOptimisticConcurrencyEnabled ?? src.m?.isOptimisticConcurrencyEnabled
        ?? (PREFIX.test(src.logical) && !src.isVirtual && !elastic ? true : null),
      IsAuditEnabled: auditFlag(dm.IsAuditEnabled ?? false, true, "isauditenabled"), // unverified: table default when the mapping says nothing
    };
    // Elastic tables take no charts, duplicate detection or N:N relationships (Learn, create-edit-elastic-tables).
    if (elastic) Object.assign(shape, { CanCreateCharts: false, IsDuplicateDetectionEnabled: false, CanManyToMany: false });
    return withOverrides(shape, dm);
  }

  function synthesize(src, name, def, { attrType, typeName, type, id }) {
    const custom = PREFIX.test(name);
    const readOnly = READ_ONLY.has(name);
    const required = REQUIRED[def.requiredLevel] ?? (id ? "SystemRequired" : def.required ? "ApplicationRequired" : "None");
    const meta = {
      AttributeOf: null,
      AttributeType: attrType,
      AttributeTypeName: { Value: typeName },
      ColumnNumber: null,
      Description: labelBlock(null, null, lcid),
      DisplayName: labelBlock(def.labels, def.label ?? name, lcid),
      EntityLogicalName: src.logical,
      HasChanged: null,
      IsCustomAttribute: custom,
      IsCustomizable: { Value: true, CanBeChanged: custom, ManagedPropertyLogicalName: "iscustomizable" },
      // unverified: defaults and logical names are not in Microsoft Learn (only the property types); native capture not yet taken for columns.
      IsRenameable: { Value: true, CanBeChanged: custom, ManagedPropertyLogicalName: "isrenameable" },
      IsSortableEnabled: { Value: false, CanBeChanged: custom, ManagedPropertyLogicalName: "canmodifyissortablesettings" },
      IsGlobalFilterEnabled: { Value: false, CanBeChanged: custom, ManagedPropertyLogicalName: "canmodifyglobalfiltersettings" },
      CanModifyAdditionalSettings: { Value: true, CanBeChanged: custom, ManagedPropertyLogicalName: "canmodifyadditionalsettings" },
      IsManaged: false,
      IsPrimaryId: id,
      IsPrimaryName: name === src.primaryName,
      IsValidForAdvancedFind: !id,
      IsValidForCreate: def.validForCreate ?? (name === "statecode" ? false : !readOnly),
      IsValidForRead: def.validForRead ?? true,
      IsValidForUpdate: def.validForUpdate ?? !(id || readOnly),
      LogicalName: name,
      RequiredLevel: { Value: required, CanBeChanged: true, ManagedPropertyLogicalName: "canmodifyrequirementlevelsettings" },
      SchemaName: def.schemaName ?? capitalize(name),
    };
    if (["String", "Memo"].includes(attrType)) meta.MaxLength = def.maxLength ?? null;
    if (["Integer", "BigInt", "Decimal", "Double", "Money"].includes(attrType)) Object.assign(meta, { MinValue: def.minValue ?? null, MaxValue: def.maxValue ?? null });
    if (["Decimal", "Double", "Money"].includes(attrType)) meta.Precision = def.precision ?? (attrType === "Money" ? 2 : null);
    if (attrType === "DateTime") {
      Object.assign(meta, {
        Format: isDateOnlyField(def) ? "DateOnly" : "DateAndTime",
        DateTimeBehavior: { Value: def.dateTimeBehavior ?? "UserLocal" },
        // Custom, changeable columns only (Learn: CreatedOn/ModifiedOn report False). unverified: logical name.
        CanChangeDateTimeBehavior: { Value: custom && !readOnly, CanBeChanged: custom, ManagedPropertyLogicalName: "canmodifydatetimebehavior" },
      });
    }
    if (["Lookup", "Customer", "Owner"].includes(attrType)) {
      const defaults = { Owner: ["systemuser", "team"], Customer: ["account", "contact"] }[attrType] ?? [];
      meta.Targets = def.targets ?? def.lookupTargets ?? defaults;
    }
    if (["picklist", "multiselectpicklist", "state", "status"].includes(type)) meta.OptionSet = optionSetOf(src, name, type, def);
    return meta;
  }

  function optionSetOf(src, name, type, def) {
    const options = type === "state" ? (def.states ?? def.options) : type === "status" ? (def.statuses ?? def.options) : def.options;
    return {
      MetadataId: metadataIdOf("optionset", src.logical, name),
      Name: `${src.logical}_${name}`,
      OptionSetType: type === "state" ? "State" : type === "status" ? "Status" : "Picklist",
      IsGlobal: false,
      IsCustomOptionSet: false,
      IsManaged: false,
      HasChanged: null,
      Options: (options ?? []).map((o) => optionOf(o, lcid)),
    };
  }

  // Full AttributeMetadata from exported column facts when present, else the compact shape from the field.
  function attributeOf(src, name, def) {
    const id = name === src.idColumn;
    // ownerid is the owner lookup whatever type the export or mapping gives it.
    const type = id ? "primarykey" : name === "ownerid" ? "owner" : String(def.columnMetadata?.type ?? def.dataverseType ?? "nvarchar").toLowerCase();
    const [attrType, stem, typeName] = TYPES[type] ?? TYPES.nvarchar;
    const facts = def.columnMetadata ?? {};
    const compact = COMPACT_TYPES.has(type);
    const exported = def.columnMetadata && !compact ? attributeMetadata(src.logical, name, def, { primaryName: src.primaryName, lcid }) : null;
    const meta = exported ?? synthesize(src, name, compact ? { ...def, labels: def.labels ?? facts.labels, requiredLevel: def.requiredLevel ?? facts.requiredLevel } : def, { attrType, typeName, type, id });
    // attribute-metadata.mjs reports RequiredLevel as its number; the Web API names it (synthesize and the docs use the name).
    if (typeof meta.RequiredLevel?.Value === "number") meta.RequiredLevel = { ...meta.RequiredLevel, Value: REQUIRED_NAMES[meta.RequiredLevel.Value] };
    const custom = PREFIX.test(name);
    const dm = def.dataverseMetadata ?? {};
    // unverified: file default size and mapping keys (maxSizeInKB, canStoreFullImage, isPrimaryImage, globalOptionSet) are assumed, not documented.
    if (type === "file") meta.MaxSizeInKB = facts.maxSizeInKB ?? null;
    if (type === "image") Object.assign(meta, { MaxSizeInKB: facts.maxSizeInKB ?? 10240, CanStoreFullImage: facts.canStoreFullImage ?? false, IsPrimaryImage: facts.isPrimaryImage ?? null });
    meta.IsSecured = boolOf(dm.IsSecured ?? facts.isSecured ?? meta.IsSecured ?? false);
    meta.IsAuditEnabled = { CanBeChanged: custom, ManagedPropertyLogicalName: "canmodifyauditsettings", ...meta.IsAuditEnabled, Value: boolOf(dm.IsAuditEnabled ?? meta.IsAuditEnabled?.Value ?? false) };
    // Global binding: the mapping's globalOptionSet, or the 1.9 writer's columnMetadata.optionSet ({ isGlobal, name }).
    const globalName = def.globalOptionSet ?? (facts.optionSet?.isGlobal ? facts.optionSet.name : null);
    if (globalName) meta.GlobalOptionSet = globalNamed(globalName);
    if (meta.GlobalOptionSet) meta.OptionSet = meta.GlobalOptionSet;
    const shaped = Object.assign(withOverrides(meta, dm), {
      "@odata.type": `#Microsoft.Dynamics.CRM.${stem}AttributeMetadata`,
      MetadataId: metadataIdOf("attribute", src.logical, name),
      AttributeType: attrType,
    });
    return managedMembers(shaped, ["AttributeMetadata", `${stem}AttributeMetadata`]);
  }

  function attributesOf(src) {
    const defaults = src.isVirtual ? {} : { ...SYSTEM_COLUMNS, ...(src.ownership === "user" ? OWNER_COLUMNS : {}) };
    const all = { [src.idColumn]: { dataverseType: "primarykey" }, ...defaults, ...src.fields };
    const list = Object.entries(all).map(([name, def]) => attributeOf(src, name, def));
    // Without an explicit value, the only image column of a table is its primary image.
    const images = list.filter((a) => a["@odata.type"] === "#Microsoft.Dynamics.CRM.ImageAttributeMetadata");
    for (const image of images) image.IsPrimaryImage ??= images.length === 1;
    return list;
  }

  // One column by logical name or MetadataId text; null when the table has none.
  function attributeIn(src, key) {
    const text = String(key ?? "").trim();
    const named = keyName(text) ?? (GUID.test(text) ? null : text.toLowerCase());
    return attributesOf(src).find((a) => (named ? a.LogicalName === named : String(a.MetadataId).toLowerCase() === text.toLowerCase())) ?? null;
  }

  function keysOf(src) {
    // The Solution schema keeps a table's keys keyed by name (solution-schema.mjs); mapping alternateKeys are an array.
    const list = src.s ? Object.values(src.s.keys ?? {}) : (src.m?.alternateKeys ?? []);
    return list.map((k) => ({
      "@odata.type": "#Microsoft.Dynamics.CRM.EntityKeyMetadata",
      MetadataId: metadataIdOf("key", src.logical, k.name),
      LogicalName: k.name,
      SchemaName: k.schemaName ?? k.name,
      EntityLogicalName: src.logical,
      KeyAttributes: [...k.attributes],
      // indexStatus and asyncJob are written by DeactivateEntityKey and ReactivateEntityKey (dataverse-metadata-messages.mjs).
      EntityKeyIndexStatus: k.indexStatus ?? "Active",
      AsyncJob: k.asyncJob ?? "00000000-0000-0000-0000-000000000000",
      IsCustomizable: { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: "iscustomizable" },
      IsManaged: false,
      DisplayName: labelBlock(k.labels, k.name, lcid),
      HasChanged: null,
    }));
  }

  // Relationship records are normalized once: 1:N (referenced side owns the collection nav) and N:N.
  // Schema relationships come first; mapping relationships fill the same SchemaName.
  function relationshipRecords() {
    const records = new Map();
    const add = (rel) => {
      const key = rel.schemaName.toLowerCase();
      const prev = records.get(key);
      if (!prev) records.set(key, rel);
      else for (const [k, v] of Object.entries(rel)) prev[k] ??= v;
    };
    for (const rel of Object.values(schemaRoot()?.relationships ?? {})) {
      if (rel.type === "one-to-many") {
        add({ type: "1:N", schemaName: rel.schemaName, referencedEntity: rel.referencedEntity, referencedAttribute: rel.referencedAttribute, referencingEntity: rel.referencingEntity, referencingAttribute: rel.referencingAttribute, referencedNav: rel.referencedNavigation, referencingNav: rel.referencingNavigation, relationshipBehavior: rel.relationshipBehavior, ...(rel.isHierarchical ? { hierarchical: true } : {}) });
      } else if (rel.type === "many-to-many") {
        add({ type: "N:N", schemaName: rel.schemaName, intersectEntity: rel.intersectEntity, entity1: rel.entity1, attribute1: rel.attribute1, nav1: rel.navigation1, entity2: rel.entity2, attribute2: rel.attribute2, nav2: rel.navigation2 });
      }
    }
    for (const logical of logicalNames())
      for (const [nav, rel] of Object.entries(relationshipsOf(storeOf(), logical, source(logical).m?.relationships))) add(fromMapping(logical, nav, rel));
    return [...records.values()];
  }

  function fromMapping(logical, nav, rel) {
    // Writer-stored labels (relationship writer: displayLabels / descriptionLabels on the mapping relationship) travel with the record.
    const labels = { displayLabels: rel.displayLabels, descriptionLabels: rel.descriptionLabels, relationshipBehavior: rel.relationshipBehavior };
    const schemaName = relationshipSchemaName(logical, nav, rel);
    if (rel.intersect) {
      return { ...labels, type: "N:N", schemaName, intersectEntity: rel.intersect.entity, entity1: logical, attribute1: rel.intersect.from, nav1: nav, entity2: rel.entity, attribute2: rel.intersect.to, nav2: rel.partner ?? null };
    }
    if (!rel.many) {
      // Lookup on this table: the table is the referencing side.
      return { ...labels, type: "1:N", schemaName, referencedEntity: rel.entity, referencedAttribute: rel.to, referencingEntity: logical, referencingAttribute: rel.from, referencedNav: rel.partner ?? null, referencingNav: nav, cascade: rel.cascade, hierarchical: rel.hierarchical === true };
    }
    return { ...labels, type: "1:N", schemaName, referencedEntity: logical, referencedAttribute: rel.from, referencingEntity: rel.entity, referencingAttribute: rel.to, referencedNav: nav, referencingNav: rel.partner ?? null, cascade: rel.cascade, hierarchical: rel.hierarchical === true };
  }

  // unverified: relationship labels are not RelationshipMetadataBase properties in Microsoft Learn; they are carried as DisplayName/Description
  // when the relationship writer stored them, and the uncast base projection leaves them out.
  const relationshipLabels = (r) => (r.displayLabels || r.descriptionLabels
    ? { DisplayName: labelBlock(r.displayLabels, null, lcid), Description: labelBlock(r.descriptionLabels, null, lcid) }
    : {});

  // RelationshipMetadataBase members (Learn), as native returns them. Native IsCustomizable is { Value: true, CanBeChanged: true }
  // on every relationship sampled, system and custom alike.
  function relationshipBaseOf(r, { custom, type, security }) {
    return {
      MetadataId: metadataIdOf("relationship", r.schemaName),
      HasChanged: null,
      IntroducedVersion: "1.0.0.0", // unverified: native shows "1.0.0.0" and "1.0" on system relationships
      IsCustomizable: { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: "iscustomizable" },
      IsCustomRelationship: custom,
      IsManaged: false,
      IsValidForAdvancedFind: true,
      RelationshipType: type,
      SchemaName: r.schemaName,
      SecurityTypes: security,
    };
  }

  function oneToManyShape(r) {
    const cascade = r.cascade ?? {};
    const behavior = Number.isInteger(r.relationshipBehavior) ? r.relationshipBehavior : 0;
    return {
      "@odata.type": "#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
      ...relationshipBaseOf(r, { custom: PREFIX.test(r.referencingAttribute ?? ""), type: "OneToManyRelationship", security: RELATIONSHIP_SECURITY[behavior] ?? "None" }),
      ReferencedEntity: r.referencedEntity,
      ReferencedAttribute: r.referencedAttribute,
      ReferencingEntity: r.referencingEntity,
      ReferencingAttribute: r.referencingAttribute,
      ReferencedEntityNavigationPropertyName: r.referencedNav ?? null,
      ReferencingEntityNavigationPropertyName: r.referencingNav ?? null,
      IsHierarchical: r.hierarchical === true,
      AssociatedMenuConfiguration: associatedMenu(),
      CascadeConfiguration: { Assign: "NoCascade", Delete: cascade.delete ?? "RemoveLink", Archive: "NoCascade", Merge: "NoCascade", Reparent: "NoCascade", Share: "NoCascade", Unshare: "NoCascade", RollupView: "NoCascade" },
      DenormalizedAttributeName: null, // unverified: native null on the samples taken
      EntityKey: null,
      IsDenormalizedLookup: null,
      IsRelationshipAttributeDenormalized: false,
      RelationshipAttributes: [],
      RelationshipBehavior: behavior,
      ...relationshipLabels(r),
    };
  }

  function manyToManyShape(r) {
    return {
      "@odata.type": "#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
      ...relationshipBaseOf(r, { custom: PREFIX.test(r.intersectEntity ?? ""), type: "ManyToManyRelationship", security: "None" }),
      IntersectEntityName: r.intersectEntity,
      Entity1LogicalName: r.entity1,
      Entity1IntersectAttribute: r.attribute1,
      Entity1NavigationPropertyName: r.nav1 ?? null,
      Entity1AssociatedMenuConfiguration: associatedMenu(),
      Entity2LogicalName: r.entity2,
      Entity2IntersectAttribute: r.attribute2,
      Entity2NavigationPropertyName: r.nav2 ?? null,
      Entity2AssociatedMenuConfiguration: associatedMenu(),
      ...relationshipLabels(r),
    };
  }

  const relationshipShape = (r) => (r.type === "N:N" ? manyToManyShape(r) : oneToManyShape(r));
  // Uncast RelationshipDefinitions are typed RelationshipMetadataBase: only its properties.
  const relationshipBase = (r) => Object.fromEntries(RELATIONSHIP_BASE.filter((k) => k in r).map((k) => [k, r[k]]));
  const oneToManyOf = (logical) => relationshipRecords().filter((r) => r.type === "1:N" && r.referencedEntity === logical).map(oneToManyShape);
  const manyToOneOf = (logical) => relationshipRecords().filter((r) => r.type === "1:N" && r.referencingEntity === logical).map(oneToManyShape);
  const manyToManyOf = (logical) => relationshipRecords().filter((r) => r.type === "N:N" && (r.entity1 === logical || r.entity2 === logical)).map(manyToManyShape);

  const EXPANSIONS = {
    Attributes: (src) => attributesOf(src),
    Keys: (src) => keysOf(src),
    OneToManyRelationships: (src) => oneToManyOf(src.logical),
    ManyToOneRelationships: (src) => manyToOneOf(src.logical),
    ManyToManyRelationships: (src) => manyToManyOf(src.logical),
  };

  const globalOptionSetOf = (set) => ({
    "@odata.type": "#Microsoft.Dynamics.CRM.OptionSetMetadata",
    MetadataId: metadataIdOf("optionset", set.name),
    Name: set.name,
    DisplayName: labelBlock(set.displayLabels, set.name, lcid),
    Description: labelBlock(set.descriptionLabels, null, lcid),
    OptionSetType: { picklist: "Picklist", boolean: "Boolean", state: "State", status: "Status" }[set.type] ?? "Picklist",
    IsGlobal: true,
    IsCustomOptionSet: true,
    IsManaged: false,
    Options: (set.options ?? set.statuses ?? set.states ?? []).map((o) => optionOf(o, lcid)),
    HasChanged: null,
  });

  // Solution global sets first, then the sets created through the Web API (state.dataverse.globalOptionSets) that the schema does not name.
  // Two stored shapes are read: the Web API one (Name, DisplayName, OptionSetType, Options [{ Value, Label }]) and the relationship/option-set
  // writer's (name, displayLabels, descriptionLabels, type 'picklist', options [{ value, label, labels }]). // unverified: the writer's shape
  const storedSetOf = (set) => {
    const name = set.Name ?? set.name;
    const block = (value, fallback) => (value && typeof value === "object" ? value : labelBlock(null, value ?? fallback, lcid));
    const option = (o) => (o.Label && typeof o.Label === "object"
      ? o
      : optionOf({ value: o.Value ?? o.value, label: o.Label ?? o.label ?? String(o.Value ?? o.value), labels: o.labels }, lcid));
    return {
      "@odata.type": "#Microsoft.Dynamics.CRM.OptionSetMetadata",
      MetadataId: set.MetadataId ?? metadataIdOf("optionset", name),
      Name: name,
      DisplayName: set.DisplayName !== undefined ? block(set.DisplayName, name) : labelBlock(set.displayLabels, name, lcid),
      Description: set.Description !== undefined ? block(set.Description, null) : labelBlock(set.descriptionLabels, null, lcid),
      OptionSetType: set.OptionSetType ?? { picklist: "Picklist", boolean: "Boolean", state: "State", status: "Status" }[set.type] ?? "Picklist",
      IsGlobal: true,
      // The standard file's sets (standardGlobalOptionSets) are platform sets, not created ones.
      IsCustomOptionSet: !standardGlobalOptionSets()[name],
      IsManaged: false,
      Options: (set.Options ?? set.options ?? []).map(option),
      HasChanged: null,
    };
  };
  const globalSets = () => {
    const schemaSets = Object.values(schemaRoot()?.optionSets ?? {}).map(globalOptionSetOf);
    const names = new Set(schemaSets.map((set) => set.Name.toLowerCase()));
    const stored = Object.values(read(globalOptionSets) ?? {})
      .filter((set) => (set?.Name ?? set?.name) && !names.has(String(set.Name ?? set.name).toLowerCase()))
      .map(storedSetOf);
    return [...schemaSets, ...stored];
  };
  const globalNamed = (name) => globalSets().find((set) => set.Name.toLowerCase() === String(name).toLowerCase()) ?? null;
  function selectMetadata(item, select) {
    const names = listOf(select);
    if (!names.length) return item;
    const out = {};
    for (const key of ["@odata.type", "MetadataId"]) if (key in item) out[key] = item[key];
    for (const name of names) {
      const top = name.split("/")[0];
      if (top in item) out[top] = item[top];
    }
    // Entity() materializes these navigation arrays only for an explicit $expand. A sibling scalar $select
    // must not discard them; this also covers expanded empty collections without inventing missing metadata.
    for (const name of Object.keys(EXPANSIONS)) if (Object.hasOwn(item, name)) out[name] = item[name];
    return out;
  }

  const matchKey = (item, key) => {
    const named = keyName(key);
    if (named) return item.LogicalName === named;
    return GUID.test(String(key)) && String(item.MetadataId).toLowerCase() === String(key).toLowerCase();
  };

  // $metadata: EDMX 4.0 from the same tables as the metadata shapes. Annotations are opt-in.
  function csdlDocument(annotations) {
    const names = logicalNames();
    const known = new Set(names);
    const tables = new Map(names.map((logical) => {
      const src = source(logical);
      const attributes = attributesOf(src);
      return [logical, { src, attributes, lookups: attributes.filter((a) => stemOf(a) === "Lookup") }];
    }));
    const lookupOf = (logical, name) => tables.get(logical)?.lookups.find((a) => a.LogicalName === name);
    // Single-valued navigation is named after its lookup; a polymorphic lookup adds the target table.
    const singleNav = (lookup, target) => ((lookup.Targets ?? []).length > 1 ? `${lookup.LogicalName}_${target}` : lookup.LogicalName);
    const oneToMany = relationshipRecords().filter((r) => r.type === "1:N" && known.has(r.referencingEntity) && known.has(r.referencedEntity));
    const manyToMany = relationshipRecords().filter((r) => r.type === "N:N" && known.has(r.entity1) && known.has(r.entity2));
    const navs = new Map(names.map((logical) => [logical, []]));
    for (const [logical, { lookups }] of tables) {
      for (const lookup of lookups) {
        // Owner points at the abstract principal: one ownerid navigation; principal tables inherit it.
        if (lookup.AttributeType === "Owner") {
          if (!PRINCIPAL_TABLES.has(logical)) navs.get(logical).push({ name: lookup.LogicalName, target: null, type: "mscrm.principal", lookup: lookup.LogicalName, partner: null });
          continue;
        }
        for (const target of lookup.Targets ?? []) {
          if (!known.has(target)) continue;
          const rel = oneToMany.find((r) => r.referencingEntity === logical && r.referencingAttribute === lookup.LogicalName && r.referencedEntity === target);
          navs.get(logical).push({ name: singleNav(lookup, target), target, type: `mscrm.${target}`, lookup: lookup.LogicalName, partner: rel?.schemaName ?? null });
        }
      }
    }
    // Collection navigation sits on the referenced table, named by its relationship; N:N uses the schema name on both sides.
    for (const r of oneToMany) {
      const lookup = lookupOf(r.referencingEntity, r.referencingAttribute);
      navs.get(r.referencedEntity).push({ name: r.schemaName, target: r.referencingEntity, type: `Collection(mscrm.${r.referencingEntity})`, partner: lookup ? singleNav(lookup, r.referencedEntity) : r.referencingAttribute });
    }
    for (const r of manyToMany) {
      navs.get(r.entity1).push({ name: r.schemaName, target: r.entity2, type: `Collection(mscrm.${r.entity2})`, partner: r.schemaName });
      navs.get(r.entity2).push({ name: r.schemaName, target: r.entity1, type: `Collection(mscrm.${r.entity1})`, partner: r.schemaName });
    }
    const edm = (a) => (a.Format === "DateOnly" && stemOf(a) === "DateTime" ? "Edm.Date" : (EDM[stemOf(a)] ?? "Edm.String"));
    const alternateKeys = (src) => {
      const keys = keysOf(src);
      if (!keys.length) return [];
      const records = keys.map((k) => {
        const refs = k.KeyAttributes.map((attr) => xmlElement("Record", { Type: `${KEYS}.PropertyRef` },
          xmlElement("PropertyValue", { Property: "Alias", String: attr }),
          xmlElement("PropertyValue", { Property: "Name", PropertyPath: attr })));
        return xmlElement("Record", { Type: `${KEYS}.AlternateKey` }, xmlElement("PropertyValue", { Property: "Key" }, xmlElement("Collection", {}, refs)));
      });
      return xmlElement("Annotation", { Term: `${KEYS}.AlternateKeys` }, xmlElement("Collection", {}, records));
    };
    // Native $metadata: activitypointer is abstract, and each activity table derives from it and declares only its own columns.
    const activityColumns = known.has("activitypointer") ? new Set(tables.get("activitypointer").attributes.map((a) => a.LogicalName)) : null;
    const typeLines = names.map((logical) => {
      const { src, attributes: all } = tables.get(logical);
      const entity = entityOf(src);
      const derived = Boolean(activityColumns) && entity.IsActivity && logical !== "activitypointer";
      const attributes = derived ? all.filter((a) => !activityColumns.has(a.LogicalName)) : all;
      const properties = attributes.map((a) => {
        const lookup = stemOf(a) === "Lookup";
        const id = a.LogicalName === src.idColumn;
        return { name: lookup ? `_${a.LogicalName}_value` : a.LogicalName, type: edm(a), id, scale: ["Decimal", "Money"].includes(stemOf(a)), computed: lookup || id, label: labelText(a.DisplayName) };
      }).sort(byName).map((p) => xmlElement("Property", { Name: p.name, Type: p.type, Nullable: p.id ? "false" : null, Scale: p.scale ? "Variable" : null },
        annotations && p.label ? xmlElement("Annotation", { Term: DESCRIPTION, String: p.label }) : [],
        annotations && p.computed ? xmlElement("Annotation", { Term: COMPUTED, Bool: "true" }) : []));
      const navigation = navs.get(logical).sort(byName).map((n) => xmlElement("NavigationProperty", { Name: n.name, Type: n.type, Partner: n.partner },
        n.lookup ? xmlElement("ReferentialConstraint", { Property: `_${n.lookup}_value`, ReferencedProperty: n.target ? tables.get(n.target).src.idColumn : "ownerid" }) : []));
      const label = labelText(entity.DisplayName);
      // Native $metadata: a principal (systemuser, team) derives from the abstract mscrm.principal and declares the ownerid key
      // again, as activity tables declare their activityid key; its own id column stays an ordinary property.
      const principal = PRINCIPAL_TABLES.has(logical);
      const base = derived ? "mscrm.activitypointer" : "mscrm.crmbaseentity";
      return xmlElement("EntityType", { Name: logical, BaseType: principal ? "mscrm.principal" : base, Abstract: logical === "activitypointer" ? "true" : null },
        xmlElement("Key", {}, xmlElement("PropertyRef", { Name: principal ? "ownerid" : src.idColumn })),
        annotations && label ? xmlElement("Annotation", { Term: DESCRIPTION, String: label }) : [],
        annotations ? alternateKeys(src) : [],
        properties, navigation);
    });
    // Polymorphic owner navigation has no entity set; only concrete targets are bound.
    // Change-tracked tables (EntityMetadata.ChangeTrackingEnabled) mark their entity set when annotations are on.
    const sets = names.map((logical) => xmlElement("EntitySet", { Name: tables.get(logical).src.entitySet, EntityType: `mscrm.${logical}` },
      annotations && entityOf(tables.get(logical).src).ChangeTrackingEnabled === true
        ? xmlElement("Annotation", { Term: CHANGE_TRACKING }, xmlElement("Record", {}, xmlElement("PropertyValue", { Property: "Supported", Bool: "true" })))
        : [],
      navs.get(logical).filter((n) => n.target).map((n) => xmlElement("NavigationPropertyBinding", { Path: n.name, Target: tables.get(n.target).src.entitySet }))));
    // Registry fragments (operation CSDL of extension and built-in operations) join the schema after the built-in operations.
    const extraText = String(read(extraCsdl) ?? "");
    // Each unbound extension function or action (its declaration has no IsBound) gets an import in the container, where the
    // service lists it: FunctionImport for a Function, ActionImport for an Action.
    const extraImports = [...extraText.matchAll(/<(Function|Action) Name="(\w+)"(?![^>]*IsBound)/g)].map(([, tag, name]) => (tag === "Action"
      ? `<ActionImport Name="${name}" Action="mscrm.${name}" />`
      : `<FunctionImport Name="${name}" Function="mscrm.${name}" IncludeInServiceDocument="false" />`));
    const platformFragments = platformCsdl([CSDL_TYPES, known.has("systemuser") ? CSDL_USER_FUNCTIONS : "", known.has("role") ? CSDL_ROLE_ACTIONS : "", CSDL_OPERATIONS, extraText].join("\n"), { queryFunctions: true });
    const schemaLines = xmlElement("Schema", { Namespace: "Microsoft.Dynamics.CRM", Alias: "mscrm", xmlns: "http://docs.oasis-open.org/odata/ns/edm" },
      xmlFixed(platformFragments), typeLines,
      xmlElement("EntityContainer", { Name: "System" }, sets, xmlFixed(CSDL_IMPORTS), xmlFixed(extraImports.join("\n"))));
    return ['<?xml version="1.0" encoding="utf-8"?>', ...xmlElement("edmx:Edmx", { Version: "4.0", "xmlns:edmx": "http://docs.oasis-open.org/odata/ns/edmx" }, xmlElement("edmx:DataServices", {}, schemaLines))].join("\n") + "\n";
  }

  // Full metadata of one table: the source of every RetrieveMetadataChanges answer.
  const fullEntity = (logical) => {
    const src = source(logical);
    return {
      "@odata.type": "#Microsoft.Dynamics.CRM.EntityMetadata",
      ...entityOf(src),
      Attributes: attributesOf(src),
      Keys: keysOf(src),
      OneToManyRelationships: oneToManyOf(logical),
      ManyToOneRelationships: manyToOneOf(logical),
      ManyToManyRelationships: manyToManyOf(logical),
      Privileges: privilegesOf(src),
    };
  };

  // Privileges (EntityFilters bit 4, or named in a RetrieveMetadataChanges query): the table's rights as dataverse-security seeds them,
  // with its ids and names. User-owned tables get all four depths; organization-owned tables get global only.
  function privilegesOf(src) {
    const user = src.ownership === "user";
    return (user ? Object.keys(ACCESS_RIGHTS) : ORGANIZATION_RIGHTS).map((right) => {
      const name = privilegeName(right, privilegeNounOf(src.logical, src.s, src.m));
      return {
        CanBeBasic: user, CanBeDeep: user, CanBeGlobal: true, CanBeLocal: user,
        CanBeEntityReference: false, CanBeParentEntityReference: false,
        Name: name, PrivilegeId: privilegeId(organizationId, name), PrivilegeType: PRIVILEGE_TYPE[right],
      };
    });
  }

  // Change log -> RetrieveMetadataChanges. The server stamp is the last seq with the UTC time of its entry (seq 0 = the seeded state, dated at creation).
  const logOf = () => read(changeLog) ?? [];
  const latestOf = () => logOf().reduce((top, e) => (e.seq > top.seq ? e : top), { seq: 0, at: baseAt });
  const stampTime = (at) => {
    const d = new Date(at);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };
  const stampOf = () => {
    const top = latestOf();
    return `${top.seq}!${stampTime(top.at)}`;
  };
  // ClientVersionStamp -> the sequence it names. Expired (0x80044352): before the log start, after the server's sequence, or older than EXPIRE_DAYS.
  function sinceOf(text) {
    const m = STAMP.exec(String(text ?? "").trim());
    if (!m) throw new DataError("ClientVersionStamp is not a version stamp.", 400, "InvalidRequest"); // unverified: message
    const [, seqText, mo, d, y, h, mi, s] = m;
    const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    const seqs = logOf().map((e) => e.seq);
    const logStart = seqs.length ? Math.min(...seqs) - 1 : 0;
    const seq = Number(seqText);
    if (seq < logStart || seq > latestOf().seq || clock() - at > EXPIRE_DAYS * DAY_MS) throw expiredVersionStamp();
    return seq;
  }
  // The entries after `since` (null: a full read), indexed for the item builder. Deletes are kept apart: they are reported only with a stamp.
  function changeIndex(since) {
    const index = { full: since === null, entities: new Set(), attributes: new Set(), relationships: new Set(), optionSets: new Set(), deleted: [] };
    for (const e of logOf()) {
      if (since !== null && e.seq <= since) continue;
      if (e.op === "delete") index.deleted.push(e);
      else if (e.kind === "entity") index.entities.add(e.logical);
      else if (e.kind === "attribute") index.attributes.add(`${e.logical}.${String(e.name).toLowerCase()}`);
      else if (e.kind === "relationship") index.relationships.add(String(e.name).toLowerCase());
      else if (e.kind === "optionset") index.optionSets.add(String(e.name).toLowerCase());
    }
    return index;
  }
  // One table's item. A changed table returns its own properties with HasChanged true, and all children with their own flag.
  // An unchanged table whose children changed returns those children with HasChanged true and HasChanged false on itself.
  // Null when nothing changed, unless its Privileges were named in the query (they are returned regardless of the stamp).
  function changeOf(logical, query, index, wantsPrivileges) {
    const item = fullEntity(logical);
    const full = index.full;
    const own = full || index.entities.has(logical);
    const attrChanged = (a) => full || index.attributes.has(`${logical}.${a.LogicalName}`)
      || (a.GlobalOptionSet != null && index.optionSets.has(String(a.GlobalOptionSet.Name).toLowerCase()));
    const relChanged = (r) => full || index.relationships.has(String(r.SchemaName).toLowerCase());
    const out = {
      ...item,
      HasChanged: own,
      Attributes: item.Attributes.filter((a) => own || attrChanged(a)).map((a) => ({ ...a, HasChanged: attrChanged(a) })),
      Keys: own ? item.Keys.map((k) => ({ ...k, HasChanged: full })) : [],
    };
    for (const key of ["OneToManyRelationships", "ManyToOneRelationships", "ManyToManyRelationships"]) {
      out[key] = item[key].filter((r) => own || relChanged(r)).map((r) => ({ ...r, HasChanged: relChanged(r) }));
    }
    const childChanged = [...out.Attributes, ...out.OneToManyRelationships, ...out.ManyToOneRelationships, ...out.ManyToManyRelationships].some((c) => c.HasChanged);
    if (!own && !childChanged && !wantsPrivileges) return null;
    const shaped = projectChange(out, query);
    if (!shaped) return null;
    for (const [key, section] of Object.entries(NESTED)) {
      if (Array.isArray(shaped[key])) shaped[key] = shaped[key].map((child) => projectChange(child, query?.[section])).filter(Boolean);
    }
    return shaped;
  }
  // The stored entries of the requested kinds as GUIDs, keyed like DeletedMetadataCollection (the docs give Guid values per filter key).
  const idOfChange = (e) => (e.kind === "entity" ? metadataIdOf("entity", e.logical)
    : e.kind === "attribute" ? metadataIdOf("attribute", e.logical, e.name)
      : e.kind === "relationship" ? metadataIdOf("relationship", e.name) : metadataIdOf("optionset", e.name));
  function deletedOf(index, bits) {
    const keys = [];
    const values = [];
    for (const [name, bit, kind] of DELETED_KINDS) {
      if (!(bits & bit)) continue;
      const ids = [...new Set(index.deleted.filter((e) => e.kind === kind).map(idOfChange))];
      if (ids.length) { keys.push(name); values.push(ids); }
    }
    return { Count: keys.length, IsReadOnly: false, Keys: keys, Values: values };
  }

  return {
    metadataId: metadataIdOf,

    objectTypeCode: (logical) => objectTypeCode(logical),

    versionStamp: () => stampOf(),

    entities() {
      return logicalNames().map((name) => entityOf(source(name)));
    },

    entity(key, { expand, labelLanguages } = {}) {
      const src = sourceFor(key);
      if (!src) return null;
      const out = entityOf(src);
      for (const nav of listOf(expand)) if (EXPANSIONS[nav]) out[nav] = EXPANSIONS[nav](src);
      return limitLabels(out, labelLanguages);
    },

    attributes(name, { cast, key, select, expand, labelLanguages } = {}) {
      // An unknown cast is a query syntax error (400 0x80060888), checked before the table is looked up.
      // route: native answers this with one REQ_ID header (dataverseError), not the engine's two.
      if (cast && !ATTRIBUTE_CASTS.has(castName(cast))) throw new DataError("Bad Request - Error in query syntax.", 400, "InvalidRequest", { innerCode: "0x80060888", route: true });
      const src = sourceFor(name);
      if (!src) return null;
      let list = attributesOf(src);
      if (cast) list = list.filter((a) => castMatches(castName(cast), a));
      if (key) list = list.filter((a) => matchKey(a, key));
      const keep = listOf(select).length ? [...listOf(select), ...listOf(expand)] : null;
      const shaped = keep ? list.map((a) => selectMetadata(a, keep)) : list;
      // Once the URL casts to the exact metadata type it supplies the expected OData type. Keep the discriminator
      // for polymorphic base casts (EnumAttributeMetadata / AttributeMetadata), where it still carries information.
      const expectedType = cast ? `#Microsoft.Dynamics.CRM.${castName(cast)}` : null;
      return limitLabels(shaped.map((attribute) => {
        if (!expectedType || attribute["@odata.type"] !== expectedType) return attribute;
        const { "@odata.type": _type, ...rest } = attribute;
        return rest;
      }), labelLanguages);
    },

    // Attributes(...)/Microsoft.Dynamics.CRM.<Type>AttributeMetadata/OptionSet (or /GlobalOptionSet) → OptionSetMetadata; null when absent.
    attributeOptionSet(entityKey, attributeKey, { global = false, select, labelLanguages } = {}) {
      const src = sourceFor(entityKey);
      const attribute = src && attributeIn(src, attributeKey);
      const set = attribute ? (global ? attribute.GlobalOptionSet : attribute.OptionSet) : null;
      return set ? limitLabels(selectMetadata(set, select), labelLanguages) : null;
    },

    // RetrieveEntity(EntityFilters=@f,LogicalName=@n,MetadataId=@m,RetrieveAsIfPublished=@r) → { EntityMetadata }; key is a name, Name= text or MetadataId.
    // The filter bits pick the collections: Attributes (+ Keys), Relationships, Privileges (4). // unverified: Keys under the Attributes bit.
    retrieveEntityResponse(key, entityFilters, { labelLanguages } = {}) {
      const src = sourceFor(key);
      if (!src) return null;
      const bits = entityFilterBits(entityFilters);
      const out = { "@odata.type": "#Microsoft.Dynamics.CRM.EntityMetadata", ...entityOf(src) };
      if (bits & 2) Object.assign(out, { Attributes: attributesOf(src), Keys: keysOf(src) });
      if (bits & 4) Object.assign(out, { Privileges: privilegesOf(src) });
      if (bits & 8) Object.assign(out, { OneToManyRelationships: oneToManyOf(src.logical), ManyToOneRelationships: manyToOneOf(src.logical), ManyToManyRelationships: manyToManyOf(src.logical) });
      return { EntityMetadata: limitLabels(out, labelLanguages) };
    },

    // RetrieveAttribute(EntityLogicalName=@e,LogicalName=@n,MetadataId=@m,...) → { AttributeMetadata }; without an entity only a MetadataId can resolve.
    retrieveAttributeResponse(entityKey, attributeKey, { labelLanguages } = {}) {
      const sources = entityKey != null ? [sourceFor(entityKey)] : GUID.test(String(attributeKey ?? "")) ? logicalNames().map((n) => source(n)) : [];
      for (const src of sources) {
        const hit = src && attributeIn(src, attributeKey);
        if (hit) return { AttributeMetadata: limitLabels(hit, labelLanguages) };
      }
      return null;
    },

    // Under $select a key carries only the selected properties and MetadataId, without @odata.type (native omits it).
    keys(name, { select } = {}) {
      const src = sourceFor(name);
      if (!src) return null;
      const list = keysOf(src);
      return listOf(select).length ? list.map((k) => { const { "@odata.type": _type, ...rest } = selectMetadata(k, select); return rest; }) : list;
    },

    manyToOne: (name) => manyToOneOf(String(name).toLowerCase()),
    oneToMany: (name) => oneToManyOf(String(name).toLowerCase()),
    manyToMany: (name) => manyToManyOf(String(name).toLowerCase()),

    // RelationshipDefinitions(SchemaName=...): uncast, the RelationshipMetadataBase properties (as the list does); with a cast, the derived shape.
    relationship(schemaName, { cast } = {}) {
      const wanted = (keyName(schemaName) ?? String(schemaName)).toLowerCase();
      const hit = relationshipRecords().find((r) => r.schemaName.toLowerCase() === wanted);
      if (!hit) return null;
      const shape = relationshipShape(hit);
      if (cast) return shape["@odata.type"] === `#Microsoft.Dynamics.CRM.${castName(cast)}` ? shape : null;
      return relationshipBase(shape);
    },

    relationships({ cast } = {}) {
      const all = relationshipRecords().map(relationshipShape);
      if (cast) return all.filter((r) => r["@odata.type"] === `#Microsoft.Dynamics.CRM.${castName(cast)}`);
      // Uncast RelationshipDefinitions are typed RelationshipMetadataBase: only its properties.
      return all.map(relationshipBase);
    },

    globalOptionSets: ({ labelLanguages } = {}) => limitLabels(globalSets(), labelLanguages),

    globalOptionSet(name, { labelLanguages } = {}) {
      const wanted = String(name).toLowerCase();
      const hit = globalSets().find((set) => set.Name.toLowerCase() === wanted) ?? null;
      return limitLabels(hit, labelLanguages);
    },

    serviceDocument(origin, version) {
      const value = logicalNames()
        .map((name) => source(name).entitySet)
        .sort()
        .map((name) => ({ name, kind: "EntitySet", url: name }));
      return { "@odata.context": `${origin}/api/data/${version}/$metadata`, value };
    },

    filterMetadata(items, filterText) {
      const text = String(filterText ?? "");
      if (!/[^\s+]/.test(text)) return items;
      // Functions (startswith, contains, ...) are not simulated over metadata; Dataverse answers 501 0x8006088a.
      const call = /(?<![\w/.])(?!(?:and|or|not)\b)([A-Za-z_]\w*)\s*\(/i.exec(text.replace(/'(?:[^']|'')*'/g, "''"));
      if (call) throw new DataError(`The "${call[1]}" function isn't supported for Metadata Entities.`, 501, "UnsupportedQueryFunction");
      const ast = parseFilter(text);
      return items.filter((item) => evaluate(ast, item));
    },

    selectMetadata,

    csdl(_origin, { annotations = false } = {}) {
      return csdlDocument(annotations);
    },

    // RetrieveMetadataChanges(Query=@q,ClientVersionStamp=@s,DeletedMetadataFilters=@d). No stamp: every table, all children (a full read).
    // With a stamp: the items changed after it; DeletedMetadata only when the filters are also given.
    retrieveMetadataChanges(query = null, { clientVersionStamp = null, labelLanguages = null, deletedMetadataFilters = null } = {}) {
      const serverVersionStamp = stampOf();
      const since = clientVersionStamp == null || String(clientVersionStamp) === "" ? null : sinceOf(clientVersionStamp);
      const index = changeIndex(since);
      // Privileges come back whenever they are named, even for an unchanged table (Microsoft Learn retrieve-detect-changes-metadata).
      const wantsPrivileges = listOf(query?.Properties?.PropertyNames).includes("Privileges");
      const EntityMetadata = logicalNames().map((name) => changeOf(name, query, index, wantsPrivileges)).filter(Boolean);
      // LabelQuery.FilterLanguages limits the labels of every returned item (the argument wins when a caller passes one).
      const languages = labelLanguages ?? query?.LabelQuery?.FilterLanguages ?? null;
      return {
        ServerVersionStamp: serverVersionStamp,
        DeletedMetadata: since === null ? { Count: 0, IsReadOnly: false, Keys: [], Values: [] } : deletedOf(index, deletedBits(deletedMetadataFilters)),
        EntityMetadata: limitLabels(EntityMetadata, languages),
      };
    },
  };
}

// A relationship's SchemaName when the mapping gives none: N:N takes its intersect table, 1:N is "<table>_<nav>". Writers share this default.
export function relationshipSchemaName(logical, nav, rel) {
  return rel.schemaName ?? (rel.intersect ? rel.intersect.entity : `${logical}_${nav}`);
}

// Standard codes are fixed; a custom table gets a stable code in 10000-59999 from its logical name.
export function objectTypeCode(logical) {
  const name = String(logical).toLowerCase();
  if (Object.hasOwn(OBJECT_TYPE_CODES, name)) return OBJECT_TYPE_CODES[name];
  return 10000 + (createHash("sha1").update(name).digest().readUInt32BE(0) % 50000);
}
