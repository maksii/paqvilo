// Predefined queries for the simulated Dataverse Web API: `savedQuery=<id>` (system views) and
// `userQuery=<id>` (saved Advanced Find queries). The query hook answers with the stored FetchXML,
// which the records layer runs. Invented schema and GUIDs only.
import { DataError } from "./data-error.mjs";

const TEXT = "nvarchar", INT = "int", GUID = "uniqueidentifier", LOOKUP = "lookup";
// Seeded only when absent: a Solution mapping (for example a Solution savedquery) is never rewritten.
const SEEDED = {
  savedquery: {
    entitySet: "savedqueries", idColumn: "savedqueryid", nameColumn: "name",
    fields: { savedqueryid: GUID, name: TEXT, returnedtypecode: TEXT, fetchxml: TEXT, querytype: INT, statecode: INT },
  },
  // unverified: user-owned (ownerid marks it), so Basic User gets Basic depth on it through the privilege model.
  userquery: {
    entitySet: "userqueries", idColumn: "userqueryid", nameColumn: "name",
    fields: { userqueryid: GUID, name: TEXT, returnedtypecode: TEXT, fetchxml: TEXT, ownerid: LOOKUP, owninguser: LOOKUP, owningteam: LOOKUP, owningbusinessunit: LOOKUP },
  },
};

const idOf = (value) => String(value ?? "").trim().replace(/^\{(.*)\}$/, "$1").toLowerCase();
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { id, innerCode: "0x80040217" });
const xmlEscape = (value) => String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function seed(store) {
  for (const [logical, def] of Object.entries(SEEDED)) {
    if (store.state.mappings[logical]) continue;
    store.state.mappings[logical] = {
      logicalName: logical,
      entitySet: def.entitySet,
      idColumn: def.idColumn,
      nameColumn: def.nameColumn,
      userConfigured: true,
      dataverseOnly: true,
      fields: Object.fromEntries(Object.entries(def.fields).map(([field, type]) => [field, { dataverseType: type }])),
      relationships: {},
    };
    store.state.tables[logical] ??= [];
  }
}

// Stored query text for `savedQuery`: the savedquery row first, then the Solution views (read-only).
function savedQueryOf(api, id) {
  const row = api.store.tableRows("savedquery").find((r) => idOf(r.savedqueryid) === idOf(id));
  if (row) return { returned: row.returnedtypecode, fetchXml: row.fetchxml };
  const view = (api.schema?.()?.views ?? []).find((v) => idOf(v.id) === idOf(id));
  if (view) return { returned: view.entity, fetchXml: view.fetchXml };
  throw notFound("savedquery", id);
}

// `userQuery`: the privilege is checked before the lookup; the row check (Basic depth on an owned row) follows it.
function userQueryOf(api, c, id) {
  const { principals, store } = api;
  principals.authorize({ user: c.user, entity: "userquery", operation: "read" });
  const row = store.tableRows("userquery").find((r) => idOf(r.userqueryid) === idOf(id));
  if (!row) throw notFound("userquery", id);
  principals.authorize({ user: c.user, entity: "userquery", operation: "read", row });
  return { returned: row.returnedtypecode, fetchXml: row.fetchxml };
}

// Navigation collection (`parent(<id>)/<relationship>/?savedQuery=`): add the parent's link as a FetchXML condition.
// The records layer sets c.navigation = { parent: { mapping, id }, name } for these; any other property route
// (or an unknown or single-valued relationship) is refused, never answered with the unfiltered set.
// ponytail: many-to-many (intersect) relationships are not modelled; the parent link is assumed non-null (the id column).
function withRelationship(api, c, fetchXml) {
  if (c.route?.kind !== "property") return fetchXml;
  const nav = c.navigation;
  const parentMapping = nav?.parent?.mapping;
  const rel = parentMapping?.relationships?.[nav.name];
  if (!rel || rel.many === false) {
    throw new DataError("Predefined queries are only supported on collection-valued navigation properties.", 400, "InvalidRequest", { innerCode: "0x80060888" });
  }
  if (rel.intersect) throw new DataError("Many-to-many predefined query navigation is not supported.", 501, "NotImplemented");
  const parentId = idOf(nav.parent.id);
  const parent = api.store.tableRows(parentMapping.logicalName).find((r) => idOf(r[parentMapping.idColumn]) === parentId);
  if (!parent) throw notFound(parentMapping.logicalName, nav.parent.id);
  const filter = `<filter type="and"><condition attribute="${rel.to}" operator="eq" value="${xmlEscape(parent[rel.from])}" /></filter>`;
  return fetchXml.replace(/<entity\b([^>]*?)(\/?)>/i, (_, attrs, selfClosing) => `<entity${attrs}>${filter}${selfClosing ? "</entity>" : ""}`);
}

export function install(api) {
  api.recordHooks.add("query", (c, mapping) => {
    const savedId = c.url.searchParams.get("savedQuery");
    const userId = c.url.searchParams.get("userQuery");
    if (savedId == null && userId == null) return undefined;
    // unverified: a request naming both parameters; savedQuery is answered here.
    // The addressed set is read-checked here too, since the records layer may run this hook before its own check.
    api.principals.authorize({ user: c.user, entity: mapping.logicalName, operation: "read", mapping });
    const query = savedId != null ? savedQueryOf(api, savedId) : userQueryOf(api, c, userId);
    // unverified: the entity-name mismatch answer (0x80041128) is documented for FetchXML, not confirmed for this path.
    if (String(query.returned ?? "").toLowerCase() !== mapping.logicalName) {
      throw new DataError(
        "The entity name specified in fetchxml does not match the entity name specified in the Entity or Query Expression.",
        400,
        "InvalidRequest",
        { innerCode: "0x80041128" },
      );
    }
    return { fetchXml: withRelationship(api, c, query.fetchXml) };
  });
  // Seeding is queued on the store; returning it lets an awaited install see the mappings.
  return api.store.transact(() => seed(api.store));
}
