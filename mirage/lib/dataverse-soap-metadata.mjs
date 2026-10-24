// Dataverse SOAP metadata messages (Retrieve*Request) answered from the metadata JSON builders in dataverse-metadata.mjs.
// Each handler returns the execute-response descriptor dataverse-soap.mjs builds for other messages ({ name, responseType,
// namespace, results }). Result values are DataContract XML: members in DataContract order (base class first, then
// DataMember Order, then ordinal name, DATA_CONTRACTS), each in its contract namespace, and xsi:type on derived types.
// Limits: the Label/ManagedProperty nested types carry no xsi:type; a condition's multi-value Value (In, NotIn) is read as
// a string list, so numeric lists compare as text.
import { DataError } from "./data-error.mjs";
import { createMetadataService } from "./dataverse-metadata.mjs";
import { DATA_CONTRACTS, ENUM_MEMBERS, MANAGED_MEMBERS } from "./dataverse-soap-contracts.mjs";
import { NS, decodeValue, encodeValue } from "./dataverse-soap-xml.mjs";
import { xmlEscapeAttribute } from "./fetchxml-engine.mjs";
import { handleMetadataWrite } from "./dataverse-metadata-tables.mjs";
import { metadataWriteRoutes } from "./dataverse-metadata-relationships.mjs";
import { parseDataverseRoute, parsePrefer } from "./dataverse-odata.mjs";

export const METADATA_NS = "http://schemas.microsoft.com/xrm/2011/Metadata";

const esc = (value) => xmlEscapeAttribute(String(value));
// Prefix per contract namespace. a is declared on the envelope (xrm/2011/Contracts), so only the others are declared per value.
const PREFIX = { "2011/Metadata": "m", "2011/Contracts": "a", "7.1/Metadata": "m71", "2013/Metadata": "m13", "9.0/Metadata": "m90" };
const NS_DECL = Object.entries(PREFIX).filter(([, p]) => p !== "a").map(([ns, p]) => ` xmlns:${p}="http://schemas.microsoft.com/xrm/${ns}"`).join("");
// Element name of collection items, from the DataContract item names (the Privileges item name is a guess).
const ITEM_ELEMENT = {
  Attributes: "AttributeMetadata",
  Keys: "EntityKeyMetadata",
  Privileges: "SecurityPrivilegeMetadata",
  OneToManyRelationships: "OneToManyRelationshipMetadata",
  ManyToOneRelationships: "OneToManyRelationshipMetadata",
  ManyToManyRelationships: "ManyToManyRelationshipMetadata",
  LocalizedLabels: "LocalizedLabel",
  Options: "OptionMetadata",
};

const typeOf = (value) => {
  const type = value && typeof value === "object" ? value["@odata.type"] : undefined;
  return typeof type === "string" ? type.replace(/^#?Microsoft\.Dynamics\.CRM\./, "") : null;
};
// Base-first chain of contract types: MetadataBase, then the base classes, then the type itself.
const chainOf = (type) => {
  const out = [];
  for (let t = type; t && DATA_CONTRACTS[t]; t = DATA_CONTRACTS[t].base) out.unshift(t);
  return out;
};
// Contract of a JSON object: its @odata.type, else the caller's hint, else inferred from its keys; null when unknown.
const contractOf = (object, hint) => {
  const type = typeOf(object);
  if (type) return type;
  if (hint) return hint;
  if ("LocalizedLabels" in object) return "Label";
  if ("LanguageCode" in object && "Label" in object) return "LocalizedLabel";
  if ("ManagedPropertyLogicalName" in object) return "ManagedProperty";
  return null;
};
// Contract hints for member objects that carry no @odata.type.
const hintFor = (name) => {
  if (name === "CascadeConfiguration") return "CascadeConfiguration";
  if (name.endsWith("AssociatedMenuConfiguration")) return "AssociatedMenuConfiguration";
  if (name === "OptionSet") return "OptionSetMetadata";
  return undefined;
};
const typeAttribute = (type) => (type ? ` i:type="${PREFIX[DATA_CONTRACTS[type]?.ns ?? "2011/Metadata"]}:${type}"` : "");
const elementPrefix = (element) => PREFIX[DATA_CONTRACTS[element]?.ns ?? "2011/Metadata"];

// Members in serialization order: base class first, then DataMember Order and ordinal name inside each class. Unknown
// members go last, which the SDK ignores.
function orderedMembers(object, type) {
  const chain = chainOf(type);
  const place = (name) => {
    for (let level = 0; level < chain.length; level++) {
      const index = DATA_CONTRACTS[chain[level]].members.indexOf(name);
      if (index >= 0) return { level, index, ns: DATA_CONTRACTS[chain[level]].ns };
    }
    return { level: chain.length, index: 0, ns: DATA_CONTRACTS[type]?.ns ?? "2011/Metadata" }; // unknown: last, SDK ignores
  };
  return Object.keys(object).filter((n) => n !== "@odata.type")
    .map((name) => ({ name, ...place(name) }))
    .sort((a, b) => a.level - b.level || a.index - b.index || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Member value as the DataContract reads it. A plain value on a ManagedProperty<T> member becomes the
// { Value, CanBeChanged, ManagedPropertyLogicalName } object; a numeric enum value becomes its member name (ENUM_MEMBERS).
const memberValue = (type, name, value) => {
  const chain = chainOf(type);
  const logical = chain.map((t) => MANAGED_MEMBERS[t]?.[name]).find(Boolean);
  if (logical) return value == null || typeof value === "object" ? value : { Value: value, CanBeChanged: true, ManagedPropertyLogicalName: logical };
  const names = chain.map((t) => ENUM_MEMBERS[`${t}.${name}`]).find(Boolean);
  return typeof value === "number" && names?.[value] !== undefined ? names[value] : value;
};

function childrenXml(object, hint) {
  const type = contractOf(object, hint);
  return orderedMembers(object, type).map(({ name, ns }) => memberXml(name, memberValue(type, name, object[name]), PREFIX[ns])).join("");
}

function memberXml(name, value, prefix) {
  const tag = `${prefix}:${name}`;
  if (value == null) return `<${tag} i:nil="true"/>`;
  // Web API represents EntityKeyMetadata.AsyncJob as a GUID. The SDK contract
  // declares an EntityReference, so SOAP must carry its members rather than text.
  if (name === "AsyncJob" && prefix === "m71" && typeof value === "string") {
    return encodeValue(tag, { type: "EntityReference", id: value, logicalName: "asyncoperation" });
  }
  if (Array.isArray(value)) return `<${tag}>${value.map((item) => itemXml(name, item)).join("")}</${tag}>`;
  if (typeof value === "object") return `<${tag}${typeAttribute(typeOf(value))}>${childrenXml(value, hintFor(name))}</${tag}>`;
  return `<${tag}>${esc(value)}</${tag}>`;
}

function itemXml(name, item) {
  if (item == null) {
    const element = ITEM_ELEMENT[name] ?? "Item";
    return `<${elementPrefix(element)}:${element} i:nil="true"/>`;
  }
  if (typeof item !== "object") {
    const scalar = typeof item === "boolean" ? "boolean" : "string";
    return `<c:${scalar}>${esc(item)}</c:${scalar}>`;
  }
  const type = typeOf(item);
  const element = ITEM_ELEMENT[name] ?? type ?? "Item";
  const prefix = elementPrefix(element);
  return `<${prefix}:${element}${type && type !== element ? typeAttribute(type) : ""}>${childrenXml(item, element)}</${prefix}:${element}>`;
}

// One metadata value as a b:value element; the prefixes are declared on it so every member resolves to its contract namespace.
const valueXml = (value, type = typeOf(value)) =>
  `<b:value${typeAttribute(type)}${NS_DECL}>${childrenXml(value, type)}</b:value>`;
// A DataCollection of entities (xrm/2011/Contracts collection; items keep the collection namespace).
const collectionXml = (items, type = "EntityMetadataCollection") =>
  `<b:value i:type="a:${type}"${NS_DECL}>` +
  items.map((item) => `<a:EntityMetadata${typeAttribute(typeOf(item))}>${childrenXml(item, "EntityMetadata")}</a:EntityMetadata>`).join("") +
  "</b:value>";
// A whole KeyValuePair for the Results collection: the dispatcher writes rawValueXml as is.
const pair = (key, valueXmlText) => ({
  rawValueXml: `<a:KeyValuePairOfstringanyType><b:key>${esc(key)}</b:key>${valueXmlText}</a:KeyValuePairOfstringanyType>`,
});
const reply = (name, key, valueXmlText) => ({
  name,
  responseType: `${name}Response`,
  namespace: NS.a,
  results: new Map([[key, pair(key, valueXmlText)]]),
});

// Decoded parameter: a plain value, a typed { type, value } or a Raw enum node whose text is the name or number.
function scalarOf(value) {
  if (value == null || typeof value !== "object") return value ?? null;
  if (value.type === "Raw") return value.node?.text.trim() || null;
  return value.value ?? null;
}
const textOf = (value) => {
  const scalar = scalarOf(value);
  return scalar == null || scalar === "" ? null : String(scalar);
};
const idOf = (value) => textOf(value)?.toLowerCase() ?? null;
const sameId = (id) => (item) => String(item.MetadataId ?? "").toLowerCase() === id;
const notFound = (what, key) => new DataError(`${what} '${key}' does not exist.`, 404, "NotFound", { innerCode: "0x80040217" });

// EntityQueryExpression (xrm/2011/Metadata) read back into the Web API JSON shape retrieveMetadataChanges takes. Members are
// matched by local name; a nil member is absent. Enums arrive as names or numbers (numbers index these lists).
const LOGICAL_OPERATORS = ["And", "Or"];
// Microsoft.Xrm.Sdk.Metadata.Query.MetadataConditionOperator: Equals 0, NotEquals 1, In 2, NotIn 3, GreaterThan 4, LessThan 5.
const CONDITION_OPERATORS = ["Equals", "NotEquals", "In", "NotIn", "GreaterThan", "LessThan"];
const VALUE_TYPES = { string: "System.String", int: "System.Int32", long: "System.Int64", decimal: "System.Decimal", double: "System.Double", boolean: "System.Boolean", dateTime: "System.DateTime", guid: "System.Guid" };
const SUB_QUERIES = ["AttributeQuery", "RelationshipQuery", "KeyQuery"];
const isNilNode = (node) => node.attrs.some((a) => a.name === "nil" && ["true", "1"].includes(a.value));
const member = (node, name) => (node?.children.find((c) => c.name === name && !isNilNode(c)) ?? null);
const itemsOf = (node) => (node ? node.children.filter((c) => !isNilNode(c)) : []);
const textOfNode = (node) => (node ? node.text.trim() : null);
const enumOf = (node, names) => {
  const text = textOfNode(node);
  if (!text) return null;
  return /^\d+$/.test(text) ? names[Number(text)] ?? text : text;
};
function conditionValueOf(node) {
  if (!node) return null;
  if (node.children.length) return { Type: "System.String[]", Value: node.children.map((c) => c.text.trim()) };
  const decoded = decodeValue(node);
  if (!decoded || decoded.type === "Raw") return { Type: "System.String", Value: node.text.trim() };
  return { Type: VALUE_TYPES[decoded.type] ?? "System.String", Value: decoded.value };
}
const conditionOf = (node) => ({
  PropertyName: textOfNode(member(node, "PropertyName")),
  ConditionOperator: enumOf(member(node, "ConditionOperator"), CONDITION_OPERATORS),
  Value: conditionValueOf(member(node, "Value")),
});
function filterOf(node) {
  return {
    FilterOperator: enumOf(member(node, "FilterOperator"), LOGICAL_OPERATORS) ?? "And",
    Conditions: itemsOf(member(node, "Conditions")).map(conditionOf),
    Filters: itemsOf(member(node, "Filters")).map(filterOf),
  };
}
function propertiesOf(node) {
  if (!node) return null;
  return {
    AllProperties: textOfNode(member(node, "AllProperties")) === "true",
    PropertyNames: itemsOf(member(node, "PropertyNames")).map((c) => c.text.trim()),
  };
}
// One expression (EntityQueryExpression, or an AttributeQuery/RelationshipQuery/KeyQuery expression) with its sub-queries.
function queryOf(node) {
  const out = { Properties: propertiesOf(member(node, "Properties")), Criteria: member(node, "Criteria") ? filterOf(member(node, "Criteria")) : null };
  for (const name of SUB_QUERIES) if (member(node, name)) out[name] = queryOf(member(node, name));
  if (member(node, "LabelQuery")) {
    out.LabelQuery = { FilterLanguages: itemsOf(member(member(node, "LabelQuery"), "FilterLanguages")).map((c) => Number(c.text.trim())) };
  }
  return out;
}

// ---- SOAP typed metadata writes
// A typed metadata parameter (EntityMetadata, AttributeMetadata subtypes, OneToManyRelationshipMetadata, ...) is decoded
// from its XML element into the JSON the Web API metadata writers read: members by element name, @odata.type from
// xsi:type, managed properties as their Value, numbers and booleans as their text says. The write then goes through the
// same route the Web API uses (dataverse-metadata-relationships metadataWriteRoutes, else dataverse-metadata-tables
// handleMetadataWrite), so the privilege checks, validation and store changes are the Web API's own.
const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
const GUID_TEXT = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;

const xsiAttr = (node, name) => node.attrs.find((a) => a.ns === XSI_NS && a.name === name)?.value;
const isNilElement = (node) => ["true", "1"].includes(xsiAttr(node, "nil"));

function scalarOfText(text) {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) return Number(trimmed);
  return text;
}

// The XML element as the Web API JSON. Collections are plural wrappers whose children share one name; a managed
// property element (Value with ManagedPropertyLogicalName) is its Value. ponytail: decimals and dates stay text.
function jsonOfElement(node) {
  if (isNilElement(node)) return null;
  const type = xsiAttr(node, "type");
  const typeName = type ? type.slice(type.indexOf(":") + 1) : null;
  if (node.children.length === 0) return scalarOfText(node.text);
  const names = node.children.map((child) => child.name);
  const value = node.children.find((child) => child.name === "Value");
  if (value && names.includes("ManagedPropertyLogicalName")) return jsonOfElement(value);
  const plural = !typeName && node.name.endsWith("s") && names.every((name) => name === names[0]);
  if (plural) return node.children.map((child) => jsonOfElement(child));
  const out = typeName ? { "@odata.type": `Microsoft.Dynamics.CRM.${typeName}` } : {};
  for (const child of node.children) out[child.name] = jsonOfElement(child);
  return out;
}

// The typed request value of a parameter: the element a Raw decode keeps, or null when nil or absent.
const typedOf = (value) => (value?.type === "Raw" ? jsonOfElement(value.node) : null);

const guidFromHeaders = (headers) => {
  const located = headers?.["OData-EntityId"] ?? "";
  const match = /\(([^()]+)\)\s*$/.exec(located);
  return match && GUID_TEXT.test(match[1]) ? match[1].toLowerCase() : null;
};

function typedReply(name, results = []) {
  return {
    name,
    responseType: `${name}Response`,
    namespace: NS.a,
    results: new Map(results.map(([key, value]) => [key, { type: "guid", value: value ?? null }])),
  };
}

// The Web API route for one metadata write, called in process with the SOAP caller.
async function metadataWriteCall(api, s, method, path, body, headers = {}) {
  const url = new URL(`/api/data/${s.version}/${path}`, s.origin);
  const c = {
    method, url, origin: s.origin, version: s.version, route: parseDataverseRoute(url.pathname), prefer: parsePrefer(""),
    headers, body, user: s.user, caller: s.caller, identity: s.identity, requestId: s.requestId, api,
    bodyBuffer: Buffer.alloc(0),
  };
  const extension = metadataWriteRoutes(api).find((entry) => entry.match(url.pathname, method));
  return extension ? extension.handle(c) : handleMetadataWrite(c);
}

// Writers for the typed metadata requests SOAP clients send. Each names its Web API target and the response members.
function metadataWriteRequests(api, svc) {
  const entityPath = (logical) => `EntityDefinitions(LogicalName='${logical}')`;
  const attributeId = (logical, name) => svc.retrieveAttributeResponse(logical, name)?.AttributeMetadata?.MetadataId ?? null;
  const existingAttributeId = (logical, name) => {
    const id = attributeId(logical, name);
    if (!id) throw new DataError(`Attribute ${name} does not exist for entity ${logical}.`, 404, "NotFound", { innerCode: "0x80040217" }); // native message text is a guess
    return id;
  };
  const merge = (p) => (p.get("MergeLabels")?.value === true ? { "MSCRM.MergeLabels": "true" } : {});
  const textParam = (p, ...names) => {
    for (const name of names) {
      const value = scalarOf(p.get(name));
      if (value != null && value !== "") return String(value);
    }
    return null;
  };
  const required = (value, what) => {
    if (value == null) throw new DataError(`${what} is required.`, 400, "InvalidRequest", { innerCode: "0x80040203" }); // native message text is a guess
    return value;
  };
  return new Map([
    ["CreateEntity", async (p, s) => {
      const body = required(typedOf(p.get("Entity")), "Entity");
      const primary = typedOf(p.get("PrimaryAttribute"));
      const attributes = [...(Array.isArray(body.Attributes) ? body.Attributes : []), ...(primary ? [primary] : [])];
      const hasActivities = p.get("HasActivities")?.value;
      const hasNotes = p.get("HasNotes")?.value;
      const payload = {
        ...body,
        Attributes: attributes,
        ...(typeof hasActivities === "boolean" ? { HasActivities: hasActivities } : {}),
        ...(typeof hasNotes === "boolean" ? { HasNotes: hasNotes } : {}),
      };
      const created = await metadataWriteCall(api, s, "POST", "EntityDefinitions", payload);
      const logical = String(payload.SchemaName ?? "").toLowerCase();
      return typedReply("CreateEntity", [["EntityId", guidFromHeaders(created.headers) ?? svc.entities().find((e) => e.LogicalName === logical)?.MetadataId]]);
    }],
    ["UpdateEntity", async (p, s) => {
      const body = required(typedOf(p.get("Entity")), "Entity");
      const logical = lowerText(body.LogicalName, "LogicalName");
      await metadataWriteCall(api, s, "PUT", entityPath(logical), body, merge(p));
      return typedReply("UpdateEntity");
    }],
    ["DeleteEntity", async (p, s) => {
      await metadataWriteCall(api, s, "DELETE", entityPath(lowerText(textParam(p, "LogicalName"), "LogicalName")));
      return typedReply("DeleteEntity");
    }],
    ["CreateAttribute", async (p, s) => {
      const logical = lowerText(textParam(p, "EntityName"), "EntityName");
      const attribute = required(typedOf(p.get("Attribute")), "Attribute");
      await metadataWriteCall(api, s, "POST", `${entityPath(logical)}/Attributes`, attribute);
      return typedReply("CreateAttribute", [["AttributeId", attributeId(logical, logicalOf(attribute))]]);
    }],
    ["UpdateAttribute", async (p, s) => {
      const logical = lowerText(textParam(p, "EntityName"), "EntityName");
      const attribute = required(typedOf(p.get("Attribute")), "Attribute");
      const id = existingAttributeId(logical, logicalOf(attribute));
      await metadataWriteCall(api, s, "PUT", `${entityPath(logical)}/Attributes(${id})`, attribute, merge(p));
      return typedReply("UpdateAttribute");
    }],
    ["DeleteAttribute", async (p, s) => {
      const logical = lowerText(textParam(p, "EntityLogicalName", "EntityName"), "EntityLogicalName");
      const name = lowerText(textParam(p, "LogicalName"), "LogicalName");
      await metadataWriteCall(api, s, "DELETE", `${entityPath(logical)}/Attributes(${existingAttributeId(logical, name)})`);
      return typedReply("DeleteAttribute");
    }],
    ["CreateOneToMany", async (p, s) => {
      const relationship = required(typedOf(p.get("OneToManyRelationship")), "OneToManyRelationship");
      const lookup = required(typedOf(p.get("Lookup")), "Lookup");
      const created = await metadataWriteCall(api, s, "POST", "RelationshipDefinitions", { ...relationship, Lookup: lookup });
      const referencing = lowerText(relationship.ReferencingEntity, "ReferencingEntity");
      return typedReply("CreateOneToMany", [
        ["RelationshipId", guidFromHeaders(created.headers)],
        ["AttributeId", attributeId(referencing, logicalOf(lookup))],
      ]);
    }],
    ["CreateManyToMany", async (p, s) => {
      const relationship = required(typedOf(p.get("ManyToManyRelationship")), "ManyToManyRelationship");
      const created = await metadataWriteCall(api, s, "POST", "RelationshipDefinitions", relationship);
      return typedReply("CreateManyToMany", [["RelationshipId", guidFromHeaders(created.headers)]]);
    }],
    ["UpdateRelationship", async (p, s) => {
      const relationship = required(typedOf(p.get("Relationship")), "Relationship");
      const schema = lowerText(relationship.SchemaName, "SchemaName");
      await metadataWriteCall(api, s, "PUT", `RelationshipDefinitions(${schema})`, relationship, merge(p));
      return typedReply("UpdateRelationship");
    }],
    ["DeleteRelationship", async (p, s) => {
      await metadataWriteCall(api, s, "DELETE", `RelationshipDefinitions(${lowerText(textParam(p, "Name"), "Name")})`);
      return typedReply("DeleteRelationship");
    }],
    ["CreateOptionSet", async (p, s) => {
      const set = required(typedOf(p.get("OptionSet")), "OptionSet");
      const created = await metadataWriteCall(api, s, "POST", "GlobalOptionSetDefinitions", set);
      return typedReply("CreateOptionSet", [["OptionSetId", guidFromHeaders(created.headers)]]);
    }],
    ["UpdateOptionSet", async (p, s) => {
      const set = required(typedOf(p.get("OptionSet")), "OptionSet");
      await metadataWriteCall(api, s, "PUT", `GlobalOptionSetDefinitions(Name='${lowerText(set.Name, "Name")}')`, set, merge(p));
      return typedReply("UpdateOptionSet");
    }],
    ["DeleteOptionSet", async (p, s) => {
      await metadataWriteCall(api, s, "DELETE", `GlobalOptionSetDefinitions(Name='${lowerText(textParam(p, "Name"), "Name")}')`);
      return typedReply("DeleteOptionSet");
    }],
    ["CreateEntityKey", async (p, s) => {
      const key = required(typedOf(p.get("EntityKey")), "EntityKey");
      const logical = lowerText(textParam(p, "EntityName", "EntityLogicalName") ?? key.EntityLogicalName, "EntityName");
      const created = await metadataWriteCall(api, s, "POST", `${entityPath(logical)}/Keys`, key);
      return typedReply("CreateEntityKey", [["EntityKeyId", guidFromHeaders(created.headers)]]);
    }],
    ["DeleteEntityKey", async (p, s) => {
      const logical = lowerText(textParam(p, "EntityName", "EntityLogicalName"), "EntityName");
      await metadataWriteCall(api, s, "DELETE", `${entityPath(logical)}/Keys(${lowerText(textParam(p, "EntityKeyId"), "EntityKeyId")})`);
      return typedReply("DeleteEntityKey");
    }],
  ]);
}

// A column or table logical name: the LogicalName the SDK sends, else the SchemaName the Web API derives it from.
const logicalOf = (column) => lowerText(column.LogicalName ?? column.SchemaName, "LogicalName");

// Text of a required name, lower case (logical names are lower case in the metadata routes).
function lowerText(value, what) {
  if (value == null || value === "") throw new DataError(`${what} is required.`, 400, "InvalidRequest", { innerCode: "0x80040203" }); // native message text is a guess
  return String(value).toLowerCase();
}

const cache = new WeakMap();

/**
 * Handlers for the metadata request names, keyed by the Execute RequestName (the request type without "Request").
 * Each handler is (parameters Map, c) and returns the response descriptor, or throws DataError.
 */
export function metadataRequests(api) {
  if (cache.has(api)) return cache.get(api);
  const svc = createMetadataService({
    organizationId: api.settings?.organizationId,
    schema: api.schema ?? null,
    mappings: () => api.store.state.mappings,
    virtualTables: () => api.store.virtualTables?.() ?? {},
  });

  const entityNameOf = (p) => {
    const logical = textOf(p.get("LogicalName"));
    if (logical) return logical.toLowerCase();
    const id = idOf(p.get("MetadataId"));
    return id ? svc.entities().find(sameId(id))?.LogicalName ?? null : null;
  };

  const handlers = new Map([
    ["RetrieveEntity", (p) => {
      const name = entityNameOf(p);
      const hit = name && svc.retrieveEntityResponse(name, scalarOf(p.get("EntityFilters")));
      if (!hit) throw notFound("Entity", name ?? "");
      return reply("RetrieveEntity", "EntityMetadata", valueXml(hit.EntityMetadata));
    }],
    ["RetrieveAttribute", (p) => {
      const entity = textOf(p.get("EntityLogicalName"))?.toLowerCase() ?? null;
      const attribute = (textOf(p.get("LogicalName")) ?? textOf(p.get("MetadataId")))?.toLowerCase() ?? null;
      const hit = attribute && svc.retrieveAttributeResponse(entity, attribute);
      if (!hit) throw notFound("Attribute", attribute ?? "");
      return reply("RetrieveAttribute", "AttributeMetadata", valueXml(hit.AttributeMetadata));
    }],
    ["RetrieveAllEntities", (p) => {
      const filters = scalarOf(p.get("EntityFilters"));
      const list = svc.entities().map((entity) => svc.retrieveEntityResponse(entity.LogicalName, filters).EntityMetadata);
      return { name: "RetrieveAllEntities", responseType: "RetrieveAllEntitiesResponse", namespace: NS.a,
        results: new Map([["EntityMetadata", pair("EntityMetadata", collectionXml(list))]]) };
    }],
    ["RetrieveOptionSet", (p) => {
      const name = textOf(p.get("Name"))?.toLowerCase() ?? null;
      const id = idOf(p.get("MetadataId"));
      const hit = svc.globalOptionSets().find((set) => (name && set.Name.toLowerCase() === name) || (id && sameId(id)(set)));
      if (!hit) throw notFound("Option set", name ?? id ?? "");
      return reply("RetrieveOptionSet", "OptionSetMetadata", valueXml(hit));
    }],
    ["RetrieveRelationship", (p) => {
      const name = textOf(p.get("Name"))?.toLowerCase() ?? null;
      const id = idOf(p.get("MetadataId"));
      const all = [
        ...svc.relationships({ cast: "OneToManyRelationshipMetadata" }),
        ...svc.relationships({ cast: "ManyToManyRelationshipMetadata" }),
      ];
      const hit = all.find((r) => (name && r.SchemaName.toLowerCase() === name) || (id && sameId(id)(r)));
      if (!hit) throw notFound("Relationship", name ?? id ?? "");
      return reply("RetrieveRelationship", "RelationshipMetadata", valueXml(hit));
    }],
    ["RetrieveMetadataChanges", (p) => {
      // The Query is an EntityQueryExpression parameter (typed, so Raw); an absent or nil one is a full read.
      const query = p.get("Query");
      const changes = svc.retrieveMetadataChanges(query?.type === "Raw" && query.node ? queryOf(query.node) : null, {
        clientVersionStamp: textOf(p.get("ClientVersionStamp")),
        deletedMetadataFilters: scalarOf(p.get("DeletedMetadataFilters")),
      });
      return {
        name: "RetrieveMetadataChanges",
        responseType: "RetrieveMetadataChangesResponse",
        namespace: NS.a,
        results: new Map([
          ["EntityMetadata", pair("EntityMetadata", collectionXml(changes.EntityMetadata))],
          ["DeletedMetadata", pair("DeletedMetadata", valueXml(changes.DeletedMetadata, null))],
          ["ServerVersionStamp", pair("ServerVersionStamp", encodeValue("b:value", changes.ServerVersionStamp))],
        ]),
      };
    }],
  ]);
  for (const [name, handler] of metadataWriteRequests(api, svc)) handlers.set(name, handler);
  cache.set(api, handlers);
  return handlers;
}
