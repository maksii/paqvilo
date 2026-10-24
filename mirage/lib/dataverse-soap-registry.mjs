// SOAP responses for registry operations. The shape of a response comes from the operation's own CSDL (the text $metadata
// lists, registry.csdlFragments), so each Results member is written with its declared type: Edm primitives as typed scalars,
// collections as ArrayOf arrays, entities as a:Entity and a:EntityReference, and complex types as DataContract objects with
// their members in DataContract order (base members first, each class alphabetical). Values come from the Web API body
// the handler returns. Pure: the caller passes the entity converter (entityFrom in dataverse-soap.mjs).
import { DataError } from "./data-error.mjs";
import { NS, encodeValue, parseXml } from "./dataverse-soap-xml.mjs";
import { xmlEscapeAttribute } from "./fetchxml-engine.mjs";

const esc = (value) => xmlEscapeAttribute(String(value));
const notSimulated = (type) => new DataError(`A registry result of type ${type ?? "(untyped)"} is not simulated for SOAP.`, 501, "NotImplemented", { innerCode: "0x80040216" });

// Contract namespaces of the SDK assemblies (Microsoft.Xrm.Sdk.dll, Microsoft.Crm.Sdk.Proxy.dll): the
// Microsoft.Crm.Sdk.Messages classes (RolePrivilege, AuditDetailCollection, every *Response) use crm/2011 (NS.g), and the
// Microsoft.Xrm.Sdk classes use xrm/2011 (NS.a). A name neither list covers has no SDK class: the Dynamics CLR namespace
// is assumed as its DataContract default.
const CRM_TYPES = new Set(["AuditDetail", "AuditDetailCollection", "AttributeAuditDetail", "RelationshipAuditDetail", "AuditPartitionDetail", "RolePrivilege", "PrivilegeDepth"]);
const XRM_TYPES = new Set(["Entity", "EntityCollection", "EntityReference", "OptionSetValue", "Money", "AliasedValue", "OrganizationResponse"]);
const DYNAMICS_NS = "http://schemas.datacontract.org/2004/07/Microsoft.Dynamics.CRM"; // assumed DataContract default for a Dynamics type
const namespaceOf = (name) => {
  if (CRM_TYPES.has(name) || name.endsWith("Response")) return NS.g;
  if (XRM_TYPES.has(name)) return NS.a;
  return DYNAMICS_NS;
};
const PREFIX_OF = new Map(Object.entries(NS).map(([prefix, uri]) => [uri, prefix]));
// A prefix for a namespace: the envelope declares every NS entry; any other namespace is declared where it is used.
const qualified = (uri) => (PREFIX_OF.has(uri) ? { prefix: PREFIX_OF.get(uri), decl: "" } : { prefix: "x", decl: ` xmlns:x="${uri}"` });

// Edm primitive types and the SOAP scalar each one encodes as (encodeValue's type names).
const EDM = new Map([
  ["Edm.String", "string"], ["Edm.Int32", "int"], ["Edm.Int64", "long"], ["Edm.Boolean", "boolean"], ["Edm.Guid", "guid"],
  ["Edm.DateTimeOffset", "dateTime"], ["Edm.DateTime", "dateTime"], ["Edm.Double", "double"], ["Edm.Decimal", "decimal"], ["Edm.Binary", "base64"],
]);
// Array item names (Serialization/Arrays) for each scalar: ArrayOfstring, ArrayOfint, ArrayOfbase64Binary, ...
const ARRAY_ITEM = new Map([["string", "string"], ["int", "int"], ["long", "long"], ["boolean", "boolean"], ["guid", "guid"], ["dateTime", "dateTime"], ["double", "double"], ["decimal", "decimal"], ["base64", "base64Binary"]]);
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

const attrOf = (node, name) => node.attrs.find((a) => a.name === name)?.value;
// "mscrm.account", "Microsoft.Dynamics.CRM.account" and "#Microsoft.Dynamics.CRM.account" name the same table or type.
const localOf = (qname) => (qname == null ? null : String(qname).replace(/^#?(?:mscrm|Microsoft\.Dynamics\.CRM)\./, ""));
const collectionItem = (type) => /^Collection\((.+)\)$/.exec(type ?? "")?.[1] ?? null;

// Complex types of the registry's CSDL, by name: { base, properties: [{ name, type }] }. Memoized on the registry until its CSDL changes.
const indexes = new WeakMap();
export function complexTypesOf(registry) {
  const text = registry.csdlFragments();
  const known = indexes.get(registry);
  if (known?.text === text) return known.types;
  const types = new Map();
  for (const node of parseXml(`<Schema>${text}</Schema>`).children) {
    if (node.name !== "ComplexType") continue;
    types.set(attrOf(node, "Name"), {
      base: localOf(attrOf(node, "BaseType")),
      properties: node.children.filter((c) => c.name === "Property").map((c) => ({ name: attrOf(c, "Name"), type: attrOf(c, "Type") })),
    });
  }
  indexes.set(registry, { text, types });
  return types;
}

// DataContract member order: the base class's members first, then this class's, each alphabetical (SDK docs).
function membersOf(types, name) {
  const def = types.get(name);
  if (!def) return [];
  const own = [...def.properties].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [...membersOf(types, def.base), ...own];
}

// The declared return type of an operation's own CSDL (for example "mscrm.RetrieveAuditPartitionListResponse").
export function returnTypeOf(op) {
  const schema = parseXml(`<Schema>${op.csdl ?? ""}</Schema>`);
  const declaration = schema.children.find((c) => c.name === "Function" || c.name === "Action");
  const ret = declaration?.children.find((c) => c.name === "ReturnType");
  return ret ? attrOf(ret, "Type") : null;
}

// The entity table a logical name (or entity set) names, or null when none does.
function entityLogical(api, name) {
  if (!name) return null;
  try {
    return api.store.resolveMapping(name).logicalName;
  } catch {
    return null;
  }
}

// What a declared type (or, without one, the value itself) is: { kind: edm|array|entity|complex, ... }.
function kindOf(ctx, type, value) {
  const item = collectionItem(type);
  if (item) return { kind: "array", item };
  if (type && EDM.has(type)) return { kind: "edm", edm: EDM.get(type) };
  const name = localOf(type);
  if (name === "OptionSetValue" || name === "Money") return { kind: "xrm", name };
  if (name && ctx.types.has(name)) return { kind: "complex", name };
  if (name === "crmbaseentity") return { kind: "entity", logical: null }; // abstract: the row names its own table
  if (name && entityLogical(ctx.api, name)) return { kind: "entity", logical: entityLogical(ctx.api, name) };
  return inferredKind(ctx, value);
}

// Without a declared type the JSON value decides: a scalar, an array, an entity reference or row, or a complex object.
function inferredKind(ctx, value) {
  if (Array.isArray(value)) return { kind: "array", item: null };
  if (typeof value === "string") return { kind: "edm", edm: "string" };
  if (typeof value === "boolean") return { kind: "edm", edm: "boolean" };
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return { kind: "edm", edm: "double" };
    return { kind: "edm", edm: value >= INT_MIN && value <= INT_MAX ? "int" : "long" };
  }
  if (value && typeof value === "object") {
    const odataType = localOf(value["@odata.type"]);
    if (value["@odata.id"] !== undefined) return { kind: "entity", logical: null };
    if (odataType && ctx.types.has(odataType)) return { kind: "complex", name: odataType };
    if (odataType && entityLogical(ctx.api, odataType)) return { kind: "entity", logical: entityLogical(ctx.api, odataType) };
  }
  return { kind: "unknown" };
}

// One value as the element `name`. typed: the element carries xsi:type (a Results value, or a member that is polymorphic).
function elementOf(ctx, name, type, value, typed) {
  if (value === null || value === undefined) return encodeValue(name, null);
  const kind = kindOf(ctx, type, value);
  switch (kind.kind) {
    case "edm": return scalarXml(name, kind.edm, value, typed);
    case "array": return arrayXml(ctx, name, kind.item, value, typed);
    case "entity": return entityXml(ctx, name, kind.logical, value);
    case "complex": return complexXml(ctx, name, kind.name, value, typed);
    // OptionSetValue { Value } and Money { Value }: the Web API writes the bare number or the { Value } object.
    case "xrm": {
      const raw = typeof value === "object" && "Value" in value ? value.Value : value;
      return kind.name === "Money" ? encodeValue(name, { type: "Money", value: raw }) : encodeValue(name, { type: "OptionSetValue", value: raw });
    }
    default: throw notSimulated(type);
  }
}

function scalarXml(name, edm, value, typed) {
  if (typed) return encodeValue(name, { type: edm, value });
  return `<${name}>${esc(value)}</${name}>`;
}

// An entity reference (a value with @odata.id) or a Web API row as a:EntityReference or a:Entity.
function entityXml(ctx, name, logical, value) {
  if (localOf(value["@odata.type"]) === "expando") {
    const attributes = new Map();
    for (const [key, raw] of Object.entries(value).filter(([key]) => !key.startsWith("@"))) {
      if (raw == null) { attributes.set(key, null); continue; }
      const kind = inferredKind(ctx, raw);
      if (kind.kind !== "edm") throw notSimulated("expando member");
      attributes.set(key, { type: kind.edm, value: raw });
    }
    return encodeValue(name, { type: "Entity", logicalName: "expando", id: "00000000-0000-0000-0000-000000000000", attributes });
  }
  if (value["@odata.id"] !== undefined) {
    const ref = /^([^(]+)\((.+)\)$/.exec(String(value["@odata.id"]).split("/").pop());
    if (!ref) throw notSimulated("EntityReference");
    return encodeValue(name, { type: "EntityReference", logicalName: entityLogical(ctx.api, ref[1]), id: ref[2], name: null });
  }
  const table = logical ?? entityLogical(ctx.api, localOf(value["@odata.type"]));
  if (!table) throw notSimulated("Entity");
  return encodeValue(name, ctx.entityOf(table, value));
}

// Array: ArrayOf<Item> in Serialization/Arrays for scalars, ArrayOf<Name> in the item's contract namespace for types.
function arrayXml(ctx, name, item, value, typed) {
  if (!Array.isArray(value)) throw notSimulated(item);
  const first = value.find((v) => v !== null && v !== undefined);
  const kind = first === undefined ? kindOf(ctx, item, undefined) : kindOf(ctx, item, first);
  let local;
  let uri;
  let items;
  if (kind.kind === "edm") {
    local = ARRAY_ITEM.get(kind.edm);
    uri = NS.f;
    const q = qualified(uri);
    items = value.map((v) => (v == null ? `<${q.prefix}:${local} i:nil="true"/>` : `<${q.prefix}:${local}${q.decl}>${esc(v)}</${q.prefix}:${local}>`));
  } else if (kind.kind === "complex") {
    local = kind.name;
    uri = namespaceOf(local);
    items = value.map((v) => elementOf(ctx, local, `${local}`, v, false));
  } else if (kind.kind === "entity") {
    local = "Entity";
    uri = NS.a;
    items = value.map((v) => (v == null ? `<a:Entity i:nil="true"/>` : entityXml(ctx, "a:Entity", kind.logical, v)));
  } else throw notSimulated(item);
  const q = qualified(uri);
  const arrayName = `ArrayOf${local}`;
  const open = typed ? `<${name} i:type="${q.prefix}:${arrayName}"${q.decl}>` : `<${name}>`;
  return `${open}${items.join("")}</${name}>`;
}

// A complex object as the element `name`, members in DataContract order. A value whose @odata.type names a derived
// type (AttributeAuditDetail under AuditDetail) is written as that type.
function complexXml(ctx, name, typeName, value, typed) {
  const derived = localOf(value["@odata.type"]);
  const concrete = derived && ctx.types.has(derived) ? derived : typeName;
  const polymorphic = concrete !== typeName;
  const uri = namespaceOf(concrete);
  const q = qualified(uri);
  const members = membersOf(ctx.types, concrete).map((p) => elementOf(ctx, p.name, p.type, value[p.name], false)).join("");
  const head = typed || polymorphic ? `<${name} i:type="${q.prefix}:${concrete}" xmlns="${uri}"${q.decl}>` : `<${name} xmlns="${uri}">`;
  return `${head}${members}</${name}>`;
}

const kvpXml = (key, valueXml) => `<a:KeyValuePairOfstringanyType><b:key>${esc(key)}</b:key>${valueXml}</a:KeyValuePairOfstringanyType>`;

/**
 * The Results of a registry operation's response: { results: Map(key -> { rawValueXml }), responseName }. responseName is the
 * declared complex response type (its SDK class, for example RetrieveUsersPrivilegesThroughTeamsResponse), or null when the
 * operation declares none. body: the Web API body the handler returned (annotations and @-keys are not results).
 * entityOf(logicalName, row): the SDK Entity of a Web API row (the caller's conversion, dataverse-soap.mjs entityFrom).
 */
export function resultsOf({ api, registry, op, body, entityOf }) {
  const ctx = { api, types: complexTypesOf(registry), entityOf };
  const returns = returnTypeOf(op);
  const responseName = ctx.types.has(localOf(returns)) && localOf(returns).endsWith("Response") ? localOf(returns) : null;
  const declared = new Map(responseName ? membersOf(ctx.types, responseName).map((p) => [p.name, p.type]) : []);
  const results = new Map();
  if (op.soapResult && localOf(returns) === "crmbaseentity") {
    results.set(op.soapResult, { rawValueXml: kvpXml(op.soapResult, entityXml(ctx, "b:value", null, body)) });
    return { results, responseName };
  }
  const rows = Object.entries(body ?? {}).filter(([key]) => !key.startsWith("@"));
  // A function returning a collection of table rows answers one EntityCollection (the SDK's Results member for it).
  const rowTable = entityLogical(api, localOf(collectionItem(returns)));
  if (!responseName && rowTable && Array.isArray(body?.value)) {
    const collection = { type: "EntityCollection", entityName: rowTable, entities: body.value.map((row) => entityOf(rowTable, row)), moreRecords: false, pagingCookie: null, totalRecordCount: -1, totalRecordCountLimitExceeded: false, minActiveRowVersion: "-1" };
    results.set("EntityCollection", { rawValueXml: kvpXml("EntityCollection", encodeValue("b:value", collection)) });
    return { results, responseName };
  }
  for (const [key, value] of rows) {
    results.set(key, { rawValueXml: kvpXml(key, elementOf(ctx, "b:value", declared.get(key) ?? null, value, true)) });
  }
  return { results, responseName };
}
