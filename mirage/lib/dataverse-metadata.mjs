// Dataverse metadata for the simulated Web API: EntityDefinitions, Attributes, Keys,
// RelationshipDefinitions and GlobalOptionSetDefinitions. A Solution schema table wins over the
// store mapping of the same name; virtual tables are read-only fallbacks. Shapes follow
// webapi-contract.md section 1 ($metadata CSDL) and section 8 (RetrieveMetadataChanges).
import { createHash } from "node:crypto";
import { attributeMetadata } from "./attribute-metadata.mjs";
import { tableFields } from "./solution-schema.mjs";
import { pluralizeEntitySetName, standardTable } from "./solution-standard.mjs";
import { ownershipOf, ownershipTypeName } from "./dataverse-security.mjs";

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
  file: ["File", "File", "FileType"], image: ["Image", "Image", "ImageType"],
};
// Columns built from the compact shape even when exported (no file/image branch in attribute-metadata.mjs).
const COMPACT_TYPES = new Set(["file", "image"]);
// EntityFilters flags (RetrieveEntity): Default and Entity are 1, All is 15.
const ENTITY_FILTERS = { default: 1, entity: 1, attributes: 2, privileges: 4, relationships: 8, all: 15 };
// RelationshipMetadataBase properties: what an uncast RelationshipDefinitions query returns. // unverified: IsCustomRelationship and IsManaged are assumed base properties.
const RELATIONSHIP_BASE = ["MetadataId", "HasChanged", "SchemaName", "RelationshipType", "IsCustomRelationship", "IsManaged"];
// Shape keys a mapping's dataverseMetadata may not replace.
const OVERRIDE_SKIP = new Set(["@odata.type", "MetadataId", "LogicalName", "EntityLogicalName", "AttributeType", "AttributeTypeName", "HasChanged", "IsAuditEnabled", "IsSecured"]);
const REQUIRED = { none: "None", systemrequired: "SystemRequired", applicationrequired: "ApplicationRequired", required: "ApplicationRequired" };
const READ_ONLY = new Set(["createdon", "modifiedon", "createdby", "modifiedby", "versionnumber"]);
// Columns every standard table has (solution exports omit them); owner columns only for user-owned tables.
// Principal tables (systemuser, team) inherit the ownerid key from the mscrm.principal base type.
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
// Version stamp = digest of the whole metadata set plus a fixed date: the simulator keeps no change clock.
const STAMP_DATE = "01/01/2026 00:00:00";
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

// EntityFilters: a number, a flag name list ("Attributes,Relationships") or the enum form Microsoft.Dynamics.CRM.EntityFilters'All'.
function entityFilterBits(value) {
  if (value == null || value === "") return ENTITY_FILTERS.entity;
  if (/^\d+$/.test(String(value))) return Number(value);
  let bits = 0;
  for (const part of String(value).split(/[,|+\s]+/).filter(Boolean)) {
    const bit = ENTITY_FILTERS[part.replace(/^Microsoft\.Dynamics\.CRM\.EntityFilters/i, "").replace(/'/g, "").toLowerCase()];
    if (!bit) throw unsupported(`Unknown EntityFilters value '${part}'.`);
    bits |= bit;
  }
  return bits;
}

const auditFlag = (value, canBeChanged, name) => ({ Value: Boolean(value), CanBeChanged: canBeChanged, ManagedPropertyLogicalName: name });

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
function coerceValue(value) {
  const type = String(value?.Type ?? "");
  const raw = value?.Value ?? null;
  if (type.endsWith("[]")) return listOf(raw);
  if (/Boolean$/.test(type)) return String(raw).toLowerCase() === "true";
  if (/(Int16|Int32|Int64|Decimal|Double)$/.test(type)) return Number(raw);
  return raw;
}

// Nested Value properties (RequiredLevel/Value style) compare by their Value.
const unwrap = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) && "Value" in value ? value.Value : value);

function matchesAll(item, criteria) {
  const conditions = criteria?.Conditions ?? [];
  if (!conditions.length) return true;
  const results = conditions.map((c) => {
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
  });
  return String(criteria.FilterOperator ?? "And").toLowerCase() === "or" ? results.some(Boolean) : results.every(Boolean);
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
<EntityType Name="crmmodelbaseentity" Abstract="true" />
<EntityType Name="principal" BaseType="mscrm.crmbaseentity" Abstract="true">
  <Key>
    <PropertyRef Name="ownerid" />
  </Key>
  <Property Name="ownerid" Type="Edm.Guid" Nullable="false" />
</EntityType>
<ComplexType Name="WhoAmIResponse">
  <Property Name="BusinessUnitId" Type="Edm.Guid" Nullable="false" />
  <Property Name="UserId" Type="Edm.Guid" Nullable="false" />
  <Property Name="OrganizationId" Type="Edm.Guid" Nullable="false" />
</ComplexType>
<ComplexType Name="RetrieveVersionResponse">
  <Property Name="Version" Type="Edm.String" />
</ComplexType>
<ComplexType Name="EndpointCollection">
  <Property Name="Count" Type="Edm.Int32" Nullable="false" />
  <Property Name="IsReadOnly" Type="Edm.Boolean" Nullable="false" />
  <Property Name="Keys" Type="Collection(Edm.String)" />
  <Property Name="Values" Type="Collection(Edm.String)" />
</ComplexType>
<ComplexType Name="OrganizationDetail">
  <Property Name="OrganizationId" Type="Edm.Guid" Nullable="false" />
  <Property Name="FriendlyName" Type="Edm.String" />
  <Property Name="OrganizationVersion" Type="Edm.String" />
  <Property Name="EnvironmentId" Type="Edm.Guid" />
  <Property Name="DatacenterId" Type="Edm.Guid" />
  <Property Name="Geo" Type="Edm.String" />
  <Property Name="TenantId" Type="Edm.Guid" />
  <Property Name="UrlName" Type="Edm.String" />
  <Property Name="UniqueName" Type="Edm.String" />
  <Property Name="OrganizationType" Type="mscrm.OrganizationType" />
  <Property Name="SchemaType" Type="mscrm.SchemaType" />
  <Property Name="State" Type="mscrm.OrganizationState" />
  <Property Name="Endpoints" Type="mscrm.EndpointCollection" />
</ComplexType>
<ComplexType Name="RetrieveCurrentOrganizationResponse">
  <Property Name="Detail" Type="mscrm.OrganizationDetail" />
</ComplexType>
<ComplexType Name="EntityRecordCountCollection">
  <Property Name="Count" Type="Edm.Int32" Nullable="false" />
  <Property Name="IsReadOnly" Type="Edm.Boolean" Nullable="false" />
  <Property Name="Keys" Type="Collection(Edm.String)" />
  <Property Name="Values" Type="Collection(Edm.Int64)" />
</ComplexType>
<ComplexType Name="RetrieveTotalRecordCountResponse">
  <Property Name="EntityRecordCountCollection" Type="mscrm.EntityRecordCountCollection" />
</ComplexType>
<ComplexType Name="RetrievePrincipalAccessResponse">
  <Property Name="AccessRights" Type="Edm.String" />
</ComplexType>
<ComplexType Name="RolePrivilege">
  <Property Name="Depth" Type="Edm.String" />
  <Property Name="PrivilegeId" Type="Edm.Guid" Nullable="false" />
  <Property Name="BusinessUnitId" Type="Edm.Guid" Nullable="false" />
  <Property Name="PrivilegeName" Type="Edm.String" />
  <Property Name="RecordFilterId" Type="Edm.Guid" Nullable="true" />
  <Property Name="RecordFilterUniqueName" Type="Edm.String" />
</ComplexType>
<ComplexType Name="RetrieveUserPrivilegesResponse">
  <Property Name="RolePrivileges" Type="Collection(mscrm.RolePrivilege)" />
</ComplexType>
<ComplexType Name="CreateMultipleResponse">
  <Property Name="Ids" Type="Collection(Edm.Guid)" />
</ComplexType>
<EnumType Name="EndpointAccessType">
  <Member Name="Default" Value="0" />
  <Member Name="Internet" Value="1" />
  <Member Name="Intranet" Value="2" />
</EnumType>
<EnumType Name="OrganizationType">
  <Member Name="Default" />
</EnumType>
<EnumType Name="SchemaType">
  <Member Name="Standard" />
  <Member Name="Core" />
  <Member Name="Full" />
  <Member Name="Uno" />
</EnumType>
<EnumType Name="OrganizationState">
  <Member Name="Enabled" />
  <Member Name="Disabled" />
</EnumType>
<EnumType Name="DeletedMetadataFilters">
  <Member Name="Default" />
  <Member Name="Entity" />
  <Member Name="Attribute" />
  <Member Name="Relationship" />
  <Member Name="Label" />
  <Member Name="OptionSet" />
  <Member Name="All" />
</EnumType>
<ComplexType Name="MetadataPropertiesExpression">
  <Property Name="AllProperties" Type="Edm.Boolean" Nullable="false" />
  <Property Name="PropertyNames" Type="Collection(Edm.String)" />
</ComplexType>
<ComplexType Name="MetadataConditionValue">
  <Property Name="Type" Type="Edm.String" />
  <Property Name="Value" Type="Edm.String" />
</ComplexType>
<ComplexType Name="MetadataConditionExpression">
  <Property Name="PropertyName" Type="Edm.String" />
  <Property Name="ConditionOperator" Type="Edm.String" />
  <Property Name="Value" Type="mscrm.MetadataConditionValue" />
</ComplexType>
<ComplexType Name="MetadataFilterExpression">
  <Property Name="FilterOperator" Type="Edm.String" />
  <Property Name="Conditions" Type="Collection(mscrm.MetadataConditionExpression)" />
</ComplexType>
<ComplexType Name="MetadataQueryExpression">
  <Property Name="Properties" Type="mscrm.MetadataPropertiesExpression" />
  <Property Name="Criteria" Type="mscrm.MetadataFilterExpression" />
</ComplexType>
<ComplexType Name="LabelQueryExpression">
  <Property Name="FilterLanguages" Type="Collection(Edm.Int32)" />
  <Property Name="MissingLabelBehavior" Type="Edm.Int32" />
</ComplexType>
<ComplexType Name="EntityQueryExpression">
  <Property Name="Properties" Type="mscrm.MetadataPropertiesExpression" />
  <Property Name="Criteria" Type="mscrm.MetadataFilterExpression" />
  <Property Name="AttributeQuery" Type="mscrm.MetadataQueryExpression" />
  <Property Name="RelationshipQuery" Type="mscrm.MetadataQueryExpression" />
  <Property Name="KeyQuery" Type="mscrm.MetadataQueryExpression" />
  <Property Name="LabelQuery" Type="mscrm.LabelQueryExpression" />
</ComplexType>
<ComplexType Name="DeletedMetadataCollection">
  <Property Name="Count" Type="Edm.Int32" Nullable="false" />
  <Property Name="IsReadOnly" Type="Edm.Boolean" Nullable="false" />
  <Property Name="Keys" Type="Collection(Edm.String)" />
  <Property Name="Values" Type="Collection(Edm.String)" />
</ComplexType>
<ComplexType Name="ComplexAttributeMetadata">
  <Property Name="LogicalName" Type="Edm.String" />
  <Property Name="SchemaName" Type="Edm.String" />
  <Property Name="MetadataId" Type="Edm.Guid" />
  <Property Name="AttributeType" Type="Edm.String" />
  <Property Name="HasChanged" Type="Edm.Boolean" />
</ComplexType>
<ComplexType Name="ComplexEntityMetadata">
  <Property Name="LogicalName" Type="Edm.String" />
  <Property Name="SchemaName" Type="Edm.String" />
  <Property Name="MetadataId" Type="Edm.Guid" />
  <Property Name="HasChanged" Type="Edm.Boolean" />
  <Property Name="Attributes" Type="Collection(mscrm.ComplexAttributeMetadata)" />
</ComplexType>
<ComplexType Name="RetrieveMetadataChangesResponse">
  <Property Name="ServerVersionStamp" Type="Edm.String" />
  <Property Name="DeletedMetadata" Type="mscrm.DeletedMetadataCollection" />
  <Property Name="EntityMetadata" Type="Collection(mscrm.ComplexEntityMetadata)" />
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
<Action Name="GrantAccess">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
</Action>`;

const CSDL_IMPORTS = `<FunctionImport Name="WhoAmI" Function="mscrm.WhoAmI" IncludeInServiceDocument="false" />
<FunctionImport Name="RetrieveVersion" Function="mscrm.RetrieveVersion" IncludeInServiceDocument="false" />
<FunctionImport Name="RetrieveCurrentOrganization" Function="mscrm.RetrieveCurrentOrganization" IncludeInServiceDocument="false" />
<FunctionImport Name="RetrieveTotalRecordCount" Function="mscrm.RetrieveTotalRecordCount" IncludeInServiceDocument="false" />
<FunctionImport Name="RetrieveMetadataChanges" Function="mscrm.RetrieveMetadataChanges" IncludeInServiceDocument="false" />
<ActionImport Name="GrantAccess" Action="mscrm.GrantAccess" />`;

export function createMetadataService({ organizationId, schema, mappings, lcid = 1033, virtualTables, globalOptionSets }) {
  const read = (source) => (typeof source === "function" ? source() : source) ?? null;
  const schemaRoot = () => read(schema);
  const mappingRoot = () => read(mappings) ?? {};
  const virtualRoot = () => read(virtualTables) ?? {};
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
    return {
      logical,
      s,
      m,
      lcid,
      isVirtual: s ? Boolean(s.isVirtual) : !mapping,
      // One ownership answer per table, shared with the security model: 'user' | 'org'.
      ownership: ownershipOf(logical, s, m),
      ownershipType: ownershipTypeName(logical, s, m),
      entitySet: s?.entitySetName ?? m?.entitySet ?? std?.entitySet ?? pluralizeEntitySetName(logical),
      idColumn: s?.primaryIdAttribute ?? m?.idColumn ?? std?.primaryIdAttribute ?? `${logical}id`,
      primaryName: s?.primaryNameAttribute ?? m?.nameColumn ?? std?.primaryNameAttribute ?? null,
      fields: s ? tableFields(root, logical) : (m?.fields ?? {}),
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
    const shape = {
      MetadataId: metadataIdOf("entity", src.logical),
      LogicalName: src.logical,
      SchemaName: src.s?.schemaName ?? capitalize(src.logical),
      EntitySetName: src.entitySet,
      LogicalCollectionName: src.s?.logicalCollectionName ?? src.m?.logicalCollectionName ?? src.entitySet,
      PrimaryIdAttribute: src.idColumn,
      PrimaryNameAttribute: src.primaryName,
      ObjectTypeCode: objectTypeCode(src.logical),
      OwnershipType: src.ownershipType,
      IsCustomEntity: PREFIX.test(src.logical),
      IsActivity: Boolean(src.s?.isActivity),
      IsIntersect: Boolean(src.s?.isIntersect || src.m?.intersect),
      IsValidForAdvancedFind: true,
      IsPrivate: false,
      HasChanged: null,
      // unverified: dataverseMetadata.labels (written by 1.9) is read as the display-name labels when the schema has none.
      DisplayName: labelBlock(src.s?.labels ?? dm.labels, src.m?.label ?? capitalize(src.logical), lcid),
      DisplayCollectionName: labelBlock(src.s?.collectionLabels, src.m?.collectionLabel ?? capitalize(src.entitySet), lcid),
      Description: labelBlock(null, null, lcid),
      IsAuditEnabled: auditFlag(dm.IsAuditEnabled ?? false, true, "isauditenabled"), // unverified: table default when the mapping says nothing
    };
    return withOverrides(shape, dm);
  }

  function synthesize(src, name, def, { attrType, typeName, type, id }) {
    const custom = PREFIX.test(name);
    const readOnly = id || READ_ONLY.has(name);
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
      IsManaged: false,
      IsPrimaryId: id,
      IsPrimaryName: name === src.primaryName,
      IsValidForAdvancedFind: !id,
      IsValidForCreate: def.validForCreate ?? !readOnly,
      IsValidForRead: def.validForRead ?? true,
      IsValidForUpdate: def.validForUpdate ?? !readOnly,
      LogicalName: name,
      RequiredLevel: { Value: required, CanBeChanged: true, ManagedPropertyLogicalName: "canmodifyrequirementlevelsettings" },
      SchemaName: def.schemaName ?? capitalize(name),
    };
    if (["String", "Memo"].includes(attrType)) meta.MaxLength = def.maxLength ?? null;
    if (["Integer", "BigInt", "Decimal", "Double", "Money"].includes(attrType)) Object.assign(meta, { MinValue: def.minValue ?? null, MaxValue: def.maxValue ?? null });
    if (["Decimal", "Double", "Money"].includes(attrType)) meta.Precision = def.precision ?? (attrType === "Money" ? 2 : null);
    if (attrType === "DateTime") {
      Object.assign(meta, {
        Format: /^dateonly$/i.test(def.format ?? "") ? "DateOnly" : "DateAndTime",
        DateTimeBehavior: { Value: def.dateTimeBehavior ?? "UserLocal" },
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
    const custom = PREFIX.test(name);
    const dm = def.dataverseMetadata ?? {};
    // unverified: file default size and mapping keys (maxSizeInKB, canStoreFullImage, isPrimaryImage, globalOptionSet) are assumed, not documented.
    if (type === "file") meta.MaxSizeInKB = facts.maxSizeInKB ?? null;
    if (type === "image") Object.assign(meta, { MaxSizeInKB: facts.maxSizeInKB ?? 10240, CanStoreFullImage: facts.canStoreFullImage ?? false, IsPrimaryImage: facts.isPrimaryImage ?? null });
    meta.IsSecured = Boolean(dm.IsSecured ?? facts.isSecured ?? meta.IsSecured ?? false);
    meta.IsAuditEnabled = { CanBeChanged: custom, ManagedPropertyLogicalName: "canmodifyauditsettings", ...meta.IsAuditEnabled, Value: Boolean(dm.IsAuditEnabled ?? meta.IsAuditEnabled?.Value ?? false) };
    if (def.globalOptionSet) meta.GlobalOptionSet = globalNamed(def.globalOptionSet);
    return Object.assign(withOverrides(meta, dm), {
      "@odata.type": `#Microsoft.Dynamics.CRM.${stem}AttributeMetadata`,
      MetadataId: metadataIdOf("attribute", src.logical, name),
      AttributeType: attrType,
    });
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
    const list = src.s ? (src.s.keys ?? []) : (src.m?.alternateKeys ?? []);
    return list.map((k) => ({
      "@odata.type": "#Microsoft.Dynamics.CRM.EntityKeyMetadata",
      MetadataId: metadataIdOf("key", src.logical, k.name),
      LogicalName: k.name,
      SchemaName: k.schemaName ?? k.name,
      EntityLogicalName: src.logical,
      KeyAttributes: [...k.attributes],
      EntityKeyIndexStatus: "Active",
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
        add({ type: "1:N", schemaName: rel.schemaName, referencedEntity: rel.referencedEntity, referencedAttribute: rel.referencedAttribute, referencingEntity: rel.referencingEntity, referencingAttribute: rel.referencingAttribute, referencedNav: rel.referencedNavigation, referencingNav: rel.referencingNavigation });
      } else if (rel.type === "many-to-many") {
        add({ type: "N:N", schemaName: rel.schemaName, intersectEntity: rel.intersectEntity, entity1: rel.entity1, attribute1: rel.attribute1, nav1: rel.navigation1, entity2: rel.entity2, attribute2: rel.attribute2, nav2: rel.navigation2 });
      }
    }
    for (const logical of logicalNames())
      for (const [nav, rel] of Object.entries(source(logical).m?.relationships ?? {})) add(fromMapping(logical, nav, rel));
    return [...records.values()];
  }

  function fromMapping(logical, nav, rel) {
    if (rel.intersect) {
      return { type: "N:N", schemaName: rel.schemaName ?? rel.intersect.entity, intersectEntity: rel.intersect.entity, entity1: logical, attribute1: rel.intersect.from, nav1: nav, entity2: rel.entity, attribute2: rel.intersect.to, nav2: rel.partner ?? null };
    }
    const schemaName = rel.schemaName ?? `${logical}_${nav}`;
    if (!rel.many) {
      // Lookup on this table: the table is the referencing side.
      return { type: "1:N", schemaName, referencedEntity: rel.entity, referencedAttribute: rel.to, referencingEntity: logical, referencingAttribute: rel.from, referencedNav: rel.partner ?? null, referencingNav: nav, cascade: rel.cascade };
    }
    return { type: "1:N", schemaName, referencedEntity: logical, referencedAttribute: rel.from, referencingEntity: rel.entity, referencingAttribute: rel.to, referencedNav: nav, referencingNav: rel.partner ?? null, cascade: rel.cascade };
  }

  function oneToManyShape(r) {
    const cascade = r.cascade ?? {};
    return {
      "@odata.type": "#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
      MetadataId: metadataIdOf("relationship", r.schemaName),
      SchemaName: r.schemaName,
      ReferencedEntity: r.referencedEntity,
      ReferencedAttribute: r.referencedAttribute,
      ReferencingEntity: r.referencingEntity,
      ReferencingAttribute: r.referencingAttribute,
      ReferencedEntityNavigationPropertyName: r.referencedNav ?? null,
      ReferencingEntityNavigationPropertyName: r.referencingNav ?? null,
      RelationshipType: "OneToManyRelationship",
      IsCustomRelationship: PREFIX.test(r.referencingAttribute ?? ""),
      IsManaged: false,
      CascadeConfiguration: { Assign: "NoCascade", Delete: cascade.delete ?? "RemoveLink", Merge: "NoCascade", Reparent: "NoCascade", Share: "NoCascade", Unshare: "NoCascade", RollupView: "NoCascade" },
      HasChanged: null,
    };
  }

  function manyToManyShape(r) {
    return {
      "@odata.type": "#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
      MetadataId: metadataIdOf("relationship", r.schemaName),
      SchemaName: r.schemaName,
      IntersectEntityName: r.intersectEntity,
      Entity1LogicalName: r.entity1,
      Entity1IntersectAttribute: r.attribute1,
      Entity1NavigationPropertyName: r.nav1 ?? null,
      Entity2LogicalName: r.entity2,
      Entity2IntersectAttribute: r.attribute2,
      Entity2NavigationPropertyName: r.nav2 ?? null,
      RelationshipType: "ManyToManyRelationship",
      IsCustomRelationship: PREFIX.test(r.intersectEntity ?? ""),
      IsManaged: false,
      HasChanged: null,
    };
  }

  const relationshipShape = (r) => (r.type === "N:N" ? manyToManyShape(r) : oneToManyShape(r));
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
  // unverified: stored shape assumed as 1.10 writes it: Name, DisplayName/Description (string or label block), OptionSetType, Options [{ Value, Label }].
  const storedSetOf = (set) => {
    const block = (value, fallback) => (value && typeof value === "object" ? value : labelBlock(null, value ?? fallback, lcid));
    return {
      "@odata.type": "#Microsoft.Dynamics.CRM.OptionSetMetadata",
      MetadataId: set.MetadataId ?? metadataIdOf("optionset", set.Name),
      Name: set.Name,
      DisplayName: block(set.DisplayName, set.Name),
      Description: block(set.Description, null),
      OptionSetType: set.OptionSetType ?? "Picklist",
      IsGlobal: true,
      IsCustomOptionSet: true,
      IsManaged: false,
      Options: (set.Options ?? []).map((o) => (o.Label && typeof o.Label === "object" ? o : optionOf({ value: o.Value, label: o.Label ?? String(o.Value) }, lcid))),
      HasChanged: null,
    };
  };
  const globalSets = () => {
    const schemaSets = Object.values(schemaRoot()?.optionSets ?? {}).map(globalOptionSetOf);
    const names = new Set(schemaSets.map((set) => set.Name.toLowerCase()));
    const stored = Object.values(read(globalOptionSets) ?? {})
      .filter((set) => set?.Name && !names.has(String(set.Name).toLowerCase()))
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
    const typeLines = names.map((logical) => {
      const { src, attributes } = tables.get(logical);
      const entity = entityOf(src);
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
      // A principal derives its key from mscrm.principal (ownerid); a derived type may not redeclare one.
      const principal = PRINCIPAL_TABLES.has(logical);
      return xmlElement("EntityType", { Name: logical, BaseType: principal ? "mscrm.principal" : "mscrm.crmbaseentity" },
        principal ? [] : xmlElement("Key", {}, xmlElement("PropertyRef", { Name: src.idColumn })),
        annotations && label ? xmlElement("Annotation", { Term: DESCRIPTION, String: label }) : [],
        annotations ? alternateKeys(src) : [],
        properties, navigation);
    });
    // Polymorphic owner navigation has no entity set; only concrete targets are bound.
    const sets = names.map((logical) => xmlElement("EntitySet", { Name: tables.get(logical).src.entitySet, EntityType: `mscrm.${logical}` },
      navs.get(logical).filter((n) => n.target).map((n) => xmlElement("NavigationPropertyBinding", { Path: n.name, Target: tables.get(n.target).src.entitySet }))));
    const schemaLines = xmlElement("Schema", { Namespace: "Microsoft.Dynamics.CRM", Alias: "mscrm", xmlns: "http://docs.oasis-open.org/odata/ns/edm" },
      xmlFixed(CSDL_TYPES), typeLines, known.has("systemuser") ? xmlFixed(CSDL_USER_FUNCTIONS) : [], known.has("role") ? xmlFixed(CSDL_ROLE_ACTIONS) : [], xmlFixed(CSDL_OPERATIONS),
      xmlElement("EntityContainer", { Name: "System" }, sets, xmlFixed(CSDL_IMPORTS)));
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
    };
  };
  const stampOf = () => `${createHash("sha1").update(JSON.stringify(logicalNames().map(fullEntity))).digest().readUInt32BE(0)}!${STAMP_DATE}`;
  function changeOf(logical, query) {
    const item = projectChange(fullEntity(logical), query);
    if (!item) return null;
    for (const [key, section] of Object.entries(NESTED)) {
      if (Array.isArray(item[key])) item[key] = item[key].map((child) => projectChange(child, query?.[section])).filter(Boolean);
    }
    return item;
  }

  return {
    metadataId: metadataIdOf,

    objectTypeCode: (logical) => objectTypeCode(logical),

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
      const src = sourceFor(name);
      if (!src) return null;
      let list = attributesOf(src);
      if (cast) list = list.filter((a) => a["@odata.type"] === `#Microsoft.Dynamics.CRM.${castName(cast)}`);
      if (key) list = list.filter((a) => matchKey(a, key));
      const keep = listOf(select).length ? [...listOf(select), ...listOf(expand)] : null;
      return limitLabels(keep ? list.map((a) => selectMetadata(a, keep)) : list, labelLanguages);
    },

    // Attributes(...)/Microsoft.Dynamics.CRM.<Type>AttributeMetadata/OptionSet (or /GlobalOptionSet) → OptionSetMetadata; null when absent.
    attributeOptionSet(entityKey, attributeKey, { global = false, select, labelLanguages } = {}) {
      const src = sourceFor(entityKey);
      const attribute = src && attributeIn(src, attributeKey);
      const set = attribute ? (global ? attribute.GlobalOptionSet : attribute.OptionSet) : null;
      return set ? limitLabels(selectMetadata(set, select), labelLanguages) : null;
    },

    // RetrieveEntity(EntityFilters=@f,LogicalName=@n,MetadataId=@m,RetrieveAsIfPublished=@r) → { EntityMetadata }; key is a name, Name= text or MetadataId.
    // The filter bits pick the collections: Attributes (+ Keys), Relationships. // unverified: Keys under the Attributes bit.
    // Privileges (bit 4) are not modelled and are left out.
    retrieveEntityResponse(key, entityFilters, { labelLanguages } = {}) {
      const src = sourceFor(key);
      if (!src) return null;
      const bits = entityFilterBits(entityFilters);
      const out = { "@odata.type": "#Microsoft.Dynamics.CRM.EntityMetadata", ...entityOf(src) };
      if (bits & 2) Object.assign(out, { Attributes: attributesOf(src), Keys: keysOf(src) });
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

    keys(name) {
      const src = sourceFor(name);
      return src ? keysOf(src) : null;
    },

    manyToOne: (name) => manyToOneOf(String(name).toLowerCase()),
    oneToMany: (name) => oneToManyOf(String(name).toLowerCase()),
    manyToMany: (name) => manyToManyOf(String(name).toLowerCase()),

    relationship(schemaName) {
      const wanted = (keyName(schemaName) ?? String(schemaName)).toLowerCase();
      const hit = relationshipRecords().find((r) => r.schemaName.toLowerCase() === wanted);
      return hit ? relationshipShape(hit) : null;
    },

    relationships({ cast } = {}) {
      const all = relationshipRecords().map(relationshipShape);
      if (cast) return all.filter((r) => r["@odata.type"] === `#Microsoft.Dynamics.CRM.${castName(cast)}`);
      // Uncast RelationshipDefinitions are typed RelationshipMetadataBase: only its properties.
      return all.map((r) => Object.fromEntries(RELATIONSHIP_BASE.filter((k) => k in r).map((k) => [k, r[k]])));
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
      const ast = parseFilter(text);
      return items.filter((item) => evaluate(ast, item));
    },

    selectMetadata,

    csdl(_origin, { annotations = false } = {}) {
      return csdlDocument(annotations);
    },

    retrieveMetadataChanges(query = null, { clientVersionStamp = null, labelLanguages = null } = {}) {
      const serverVersionStamp = stampOf();
      const unchanged = clientVersionStamp != null && String(clientVersionStamp) === serverVersionStamp;
      return {
        ServerVersionStamp: serverVersionStamp,
        DeletedMetadata: { Count: 0, IsReadOnly: false, Keys: [], Values: [] },
        EntityMetadata: unchanged ? [] : limitLabels(logicalNames().map((name) => changeOf(name, query)).filter(Boolean), labelLanguages),
      };
    },
  };
}

// Standard codes are fixed; a custom table gets a stable code in 10000-59999 from its logical name.
export function objectTypeCode(logical) {
  const name = String(logical).toLowerCase();
  if (Object.hasOwn(OBJECT_TYPE_CODES, name)) return OBJECT_TYPE_CODES[name];
  return 10000 + (createHash("sha1").update(name).digest().readUInt32BE(0) % 50000);
}
