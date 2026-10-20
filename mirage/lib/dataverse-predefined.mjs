// Predefined queries for the simulated Dataverse Web API: `savedQuery=<id>` (system views) and
// `userQuery=<id>` (saved Advanced Find queries). The query hook answers with the stored FetchXML,
// which the records layer runs. Invented schema and GUIDs only.
import { randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { contextUrl } from "./dataverse-odata.mjs";
import { relationshipsOf } from "./dataverse-standard.mjs";

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
  // unverified: the appnotification table is not in the standard table reference capture; SendAppNotification writes these rows.
  appnotification: {
    entitySet: "appnotifications", idColumn: "appnotificationid", nameColumn: "title",
    fields: { appnotificationid: GUID, title: TEXT, body: TEXT, icontype: INT, priority: INT, toasttype: INT, expiry: INT, recipient: LOOKUP, ownerid: LOOKUP, owninguser: LOOKUP, owningteam: LOOKUP, owningbusinessunit: LOOKUP },
  },
};

const idOf = (value) => String(value ?? "").trim().replace(/^\{(.*)\}$/, "$1").toLowerCase();
const GUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  const rel = parentMapping ? relationshipsOf(api.store, parentMapping.logicalName, parentMapping.relationships)[nav.name] : undefined;
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

// RetrieveExchangeRate (Learn): the exchangerate of a transactioncurrency row, read under the caller's privileges and row access.
const CSDL_EXCHANGE_RATE = `<ComplexType Name="RetrieveExchangeRateResponse"><Property Name="ExchangeRate" Type="Edm.Decimal" /></ComplexType>
<Function Name="RetrieveExchangeRate">
  <Parameter Name="TransactionCurrencyId" Type="Edm.Guid" Nullable="false" />
  <ReturnType Type="mscrm.RetrieveExchangeRateResponse" Nullable="false" />
</Function>`;
function retrieveExchangeRate(api) {
  return async (c) => {
    const id = c.params?.TransactionCurrencyId;
    if (!GUID_TEXT.test(idOf(id))) throw new DataError("TransactionCurrencyId must be a GUID.", 400, "InvalidRequest"); // unverified: message text
    const { principals, store } = api;
    principals.authorize({ user: c.user, entity: "transactioncurrency", operation: "read" });
    const row = store.tableRows("transactioncurrency").find((r) => idOf(r.transactioncurrencyid) === idOf(id));
    if (!row) throw notFound("transactioncurrency", id);
    principals.authorize({ user: c.user, entity: "transactioncurrency", operation: "read", row });
    // unverified: the response property name; the base currency row carries exchangerate 1 when none is stored.
    return { status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, "Microsoft.Dynamics.CRM.RetrieveExchangeRateResponse"), ExchangeRate: Number(row.exchangerate ?? 1) } };
  };
}

// SendAppNotification (Learn): creates an appnotification row for Recipient. No toast is delivered. The row is the only effect.
// unverified: the Recipient wire shape (systemuserid), the defaults for IconType, Priority and ToastType, and the response body.
const CSDL_APP_NOTIFICATION = `<ComplexType Name="SendAppNotificationResponse" />
<Action Name="SendAppNotification">
  <Parameter Name="Title" Type="Edm.String" Nullable="false" />
  <Parameter Name="Recipient" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="ToastType" Type="Edm.Int32" />
  <Parameter Name="Actions" Type="Collection(mscrm.crmbaseentity)" />
  <Parameter Name="Body" Type="Edm.String" />
  <Parameter Name="Priority" Type="Edm.Int32" />
  <Parameter Name="IconType" Type="Edm.Int32" />
  <Parameter Name="Expiry" Type="Edm.Int32" />
  <Parameter Name="OverrideContent" Type="mscrm.crmbaseentity" />
  <ReturnType Type="mscrm.SendAppNotificationResponse" Nullable="false" />
</Action>`;
function sendAppNotification(api) {
  return async (c) => {
    const body = typeof c.body === "string" ? JSON.parse(c.body || "{}") : (c.body ?? {});
    if (!body.Title) throw new DataError("Title is required.", 400, "InvalidRequest"); // unverified: message text
    const recipientId = body.Recipient?.systemuserid;
    if (!GUID_TEXT.test(idOf(recipientId))) throw new DataError("Recipient must name a systemuser.", 400, "InvalidRequest"); // unverified: message text
    if (!api.principals.byId(recipientId)) throw notFound("systemuser", recipientId);
    await api.change(() => api.store.transact(() => {
      api.principals.authorize({ user: c.user, entity: "appnotification", operation: "write" });
      api.store.createRecord("appnotification", {
        appnotificationid: randomUUID(), title: body.Title, body: body.Body ?? null,
        icontype: body.IconType ?? 0, priority: body.Priority ?? 1, toasttype: body.ToastType ?? 0, expiry: body.Expiry ?? null, // unverified: defaults
        recipient: { id: recipientId, logical_name: "systemuser", name: "" },
      }, c.identity);
    }, { isolated: true }));
    return { status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, "Microsoft.Dynamics.CRM.SendAppNotificationResponse") } };
  };
}

// Install and reset share the seed; reset runs on every reseed (/_sim/ reset, state import) through the store only.
export function reset(api) {
  return api.store.transact(() => seed(api.store));
}

export function install(api) {
  api.recordHooks.add("query", (c, mapping) => {
    const savedId = c.url.searchParams.get("savedQuery");
    const userId = c.url.searchParams.get("userQuery");
    if (savedId == null && userId == null) return undefined;
    // unverified: a request naming both parameters; savedQuery is answered here.
    // The addressed set is read-checked here too, since the records layer may run this hook before its own check.
    api.principals.authorize({ user: c.user, entity: mapping.logicalName, operation: "read", mapping });
    // A query id that is not a GUID fails the parse before any lookup: native answers 500 with code 0x0.
    // unverified: userQuery is assumed to parse its id the same way (only savedQuery was observed).
    if (!GUID_TEXT.test(idOf(savedId ?? userId))) {
      throw new DataError("Guid should contain 32 digits with 4 dashes (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).", 500, "InvalidRequest", { innerCode: "0x0" });
    }
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
    // observed: parity case views.system: a saved query's context lists its columns in the saved attribute order.
    return { fetchXml: withRelationship(api, c, query.fetchXml), ...(savedId != null ? { columnOrder: "attribute" } : {}) };
  });
  api.registry.register({ name: "RetrieveExchangeRate", kind: "function", binding: "unbound", handle: retrieveExchangeRate(api), csdl: CSDL_EXCHANGE_RATE });
  api.registry.register({ name: "SendAppNotification", kind: "action", binding: "unbound", handle: sendAppNotification(api), csdl: CSDL_APP_NOTIFICATION });
  // Seeding is queued on the store; returning it lets an awaited install see the mappings.
  return reset(api);
}
