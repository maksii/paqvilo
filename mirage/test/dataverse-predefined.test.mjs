// Predefined queries (savedQuery / userQuery) answered as FetchXML by the query hook. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { createPrincipals, ensureSecurityModel, ownerColumns } from "../lib/dataverse-security.mjs";
import { install, reset } from "../lib/dataverse-predefined.mjs";

const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const BASIC_OID = "aaaaaaaa-0000-4000-8000-000000000002";
const WIDGET = "11111111-0000-4000-8000-000000000001";
const SAVED = "22222222-0000-4000-8000-000000000001";
const USER_QUERY = "33333333-0000-4000-8000-000000000001";
const OTHER_QUERY = "33333333-0000-4000-8000-000000000002";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const SETTINGS = {
  organizationId: ORG,
  tenantId: "tenant-test",
  uniqueName: "testorg",
  friendlyName: "Test Org",
  version: "9.2.25041.00000",
  users: [
    { objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] },
    { objectId: BASIC_OID, upn: "basic@example.test", displayName: "Basic", roles: ["Basic User"] },
  ],
};
const text = { dataverseType: "nvarchar" };
const lookup = { dataverseType: "lookup" };
const SAVED_FETCH = '<fetch><entity name="widget"><attribute name="name" /></entity></fetch>';
const GADGET_FETCH = '<fetch><entity name="gadget"><attribute name="name" /></entity></fetch>';

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    relationships: { widget_gadgets: { entity: "gadget", from: "widgetid", to: "widgetid", many: true } },
    fields: { name: text, ownerid: lookup, owninguser: lookup, owningteam: lookup, owningbusinessunit: lookup },
  };
  state.mappings.gadget = {
    logicalName: "gadget", entitySet: "gadgets", idColumn: "gadgetid", nameColumn: "name",
    fields: { name: text, widgetid: lookup },
  };
  for (const logical of ["widget", "gadget"]) state.tables[logical] = [];
  state.tables.widget.push({ widgetid: WIDGET, name: "Sprocket" });
  state.tables.gadget.push({ gadgetid: "44444444-0000-4000-8000-000000000001", name: "Gizmo", widgetid: WIDGET });
  return state;
}

// Builds the store, the hook (install runs before the security model, so userquery privileges are generated), and principals.
async function setup({ schema = null, rows = {}, mappings = {} } = {}) {
  const state = fixtureState();
  Object.assign(state.mappings, mappings);
  const store = new DataStore({ state });
  const hooks = {};
  const api = {
    recordHooks: { add: (name, fn) => { hooks[name] = fn; } },
    store,
    registry: { register() {} },
    schema: () => schema,
    principals: null,
  };
  install(api);
  for (const [logical, list] of Object.entries(rows)) store.state.tables[logical] = list;
  await ensureSecurityModel(store, SETTINGS);
  api.principals = createPrincipals(store, SETTINGS);
  const admin = api.principals.byObjectId(ADMIN_OID);
  const basic = api.principals.byObjectId(BASIC_OID);
  // Calls the query hook the way the records layer does. A navigation collection passes the parent as c.mapping and
  // c.navigation, and the related set as the hook's mapping argument.
  const query = (user, set, { savedQuery, userQuery, navigation } = {}) => {
    const url = new URL(`/api/data/v9.2/${set}`, "http://127.0.0.1:5555");
    if (savedQuery != null) url.searchParams.set("savedQuery", savedQuery);
    if (userQuery != null) url.searchParams.set("userQuery", userQuery);
    const mapping = store.resolveMapping(set);
    if (!navigation) return hooks.query({ user, url, route: { kind: "collection", set }, mapping }, mapping);
    const parent = store.resolveMapping(navigation.set);
    const c = {
      user,
      url,
      route: { kind: "property", set: navigation.set, key: navigation.id, segment: navigation.name },
      mapping: parent,
      navigation: { parent: { mapping: parent, id: navigation.id }, name: navigation.name },
    };
    return hooks.query(c, mapping);
  };
  return { store, api, hooks, admin, basic, query };
}

function failure(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected an error");
}

test("install seeds userquery and savedquery as dataverse-only mappings", async () => {
  const t = await setup();
  for (const logical of ["savedquery", "userquery"]) {
    const mapping = t.store.state.mappings[logical];
    assert.equal(mapping.userConfigured, true);
    assert.equal(mapping.dataverseOnly, true);
  }
  assert.equal(t.store.state.mappings.userquery.entitySet, "userqueries");
  assert.equal(t.store.state.mappings.userquery.fields.ownerid.dataverseType, "lookup");
});

test("install never rewrites an existing Solution savedquery mapping", async () => {
  const solution = {
    logicalName: "savedquery", entitySet: "savedqueries", idColumn: "savedqueryid", fields: { savedqueryid: text },
    relationships: {}, solution: true,
  };
  const t = await setup({ mappings: { savedquery: structuredClone(solution) } });
  assert.deepEqual(t.store.state.mappings.savedquery, solution);
});

test("savedQuery answers with the savedquery row's FetchXML", async () => {
  const t = await setup({
    rows: { savedquery: [{ savedqueryid: SAVED, name: "All widgets", returnedtypecode: "widget", fetchxml: SAVED_FETCH }] },
  });
  const result = await t.query(t.admin, "widgets", { savedQuery: SAVED });
  assert.deepEqual(result, { fetchXml: SAVED_FETCH, columnOrder: "attribute" });
});

test("savedQuery falls back to a Solution view from the schema, read-only", async () => {
  const t = await setup({
    schema: { views: [{ id: SAVED, entity: "widget", fetchXml: SAVED_FETCH }] },
  });
  assert.deepEqual(await t.query(t.admin, "widgets", { savedQuery: SAVED }), { fetchXml: SAVED_FETCH, columnOrder: "attribute" });
});

test("a savedQuery for another entity answers 400 0x80041128", async () => {
  const t = await setup({
    rows: { savedquery: [{ savedqueryid: SAVED, name: "Gadgets", returnedtypecode: "gadget", fetchxml: GADGET_FETCH }] },
  });
  const error = await failure(() => t.query(t.admin, "widgets", { savedQuery: SAVED }));
  assert.equal(error.status, 400);
  assert.equal(error.details.innerCode, "0x80041128");
});

test("an unknown savedQuery answers 404 0x80040217", async () => {
  const t = await setup();
  const error = await failure(() => t.query(t.admin, "widgets", { savedQuery: MISSING }));
  assert.equal(error.status, 404);
  assert.equal(error.details.innerCode, "0x80040217");
  assert.equal(error.message, `savedquery With Id = ${MISSING} Does Not Exist`);
});

test("a savedQuery id that is not a GUID answers 500 code 0x0 before any lookup", async () => {
  const t = await setup();
  const error = await failure(() => t.query(t.admin, "widgets", { savedQuery: "bad" }));
  assert.equal(error.status, 500);
  assert.equal(error.details.innerCode, "0x0");
  assert.equal(error.message, "Guid should contain 32 digits with 4 dashes (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).");
  const braced = await failure(() => t.query(t.admin, "widgets", { savedQuery: `{${MISSING}}` }));
  assert.equal(braced.status, 404, "a braced GUID passes the GUID check and fails the lookup");
});

test("userQuery answers with the owner's query, and Basic depth hides other users' queries", async () => {
  const t = await setup();
  const owned = ownerColumns(t.store, { id: t.basic.systemuserid, logical_name: "systemuser" });
  const adminOwned = ownerColumns(t.store, { id: t.admin.systemuserid, logical_name: "systemuser" });
  t.store.state.tables.userquery = [
    { userqueryid: USER_QUERY, name: "Mine", returnedtypecode: "widget", fetchxml: SAVED_FETCH, ...owned },
    { userqueryid: OTHER_QUERY, name: "Theirs", returnedtypecode: "widget", fetchxml: SAVED_FETCH, ...adminOwned },
  ];
  assert.deepEqual(await t.query(t.basic, "widgets", { userQuery: USER_QUERY }), { fetchXml: SAVED_FETCH });
  const denied = await failure(() => t.query(t.basic, "widgets", { userQuery: OTHER_QUERY }));
  assert.equal(denied.status, 403);
  assert.deepEqual(await t.query(t.admin, "widgets", { userQuery: OTHER_QUERY }), { fetchXml: SAVED_FETCH });
});

test("an unknown userQuery answers 404 and a userQuery for another entity answers 400", async () => {
  const t = await setup();
  const missing = await failure(() => t.query(t.admin, "widgets", { userQuery: MISSING }));
  assert.equal(missing.status, 404);
  const owned = ownerColumns(t.store, { id: t.admin.systemuserid, logical_name: "systemuser" });
  t.store.state.tables.userquery = [{ userqueryid: USER_QUERY, name: "Gadgets", returnedtypecode: "gadget", fetchxml: GADGET_FETCH, ...owned }];
  const mismatch = await failure(() => t.query(t.admin, "widgets", { userQuery: USER_QUERY }));
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.details.innerCode, "0x80041128");
});

const GADGETS_OF_WIDGET = `<fetch><entity name="gadget"><filter type="and"><condition attribute="widgetid" operator="eq" value="${WIDGET}" /></filter><attribute name="name" /></entity></fetch>`;

test("a navigation collection adds the parent link as a FetchXML condition", async () => {
  const t = await setup({
    rows: { savedquery: [{ savedqueryid: SAVED, name: "Gadgets", returnedtypecode: "gadget", fetchxml: GADGET_FETCH }] },
  });
  const result = await t.query(t.admin, "gadgets", { savedQuery: SAVED, navigation: { set: "widgets", id: WIDGET, name: "widget_gadgets" } });
  assert.equal(result.fetchXml, GADGETS_OF_WIDGET);
});

test("a navigation collection takes its parent from the navigation context, without c.mapping", async () => {
  const t = await setup({
    rows: { savedquery: [{ savedqueryid: SAVED, name: "Gadgets", returnedtypecode: "gadget", fetchxml: GADGET_FETCH }] },
  });
  const url = new URL(`/api/data/v9.2/widgets(${WIDGET})/widget_gadgets?savedQuery=${SAVED}`, "http://127.0.0.1:5555");
  const c = {
    user: t.admin,
    url,
    route: { kind: "property", set: "widgets", key: WIDGET, segment: "widget_gadgets" },
    navigation: { parent: { mapping: t.store.resolveMapping("widgets"), id: WIDGET }, name: "widget_gadgets" },
  };
  assert.deepEqual(t.hooks.query(c, t.store.resolveMapping("gadgets")), { fetchXml: GADGETS_OF_WIDGET, columnOrder: "attribute" });
});

test("a navigation predefined query that names no collection-valued relationship answers 400, never every row", async () => {
  const t = await setup({
    rows: { savedquery: [{ savedqueryid: SAVED, name: "Gadgets", returnedtypecode: "gadget", fetchxml: GADGET_FETCH }] },
  });
  const url = new URL(`/api/data/v9.2/widgets(${WIDGET})/widget_nope?savedQuery=${SAVED}`, "http://127.0.0.1:5555");
  const route = { kind: "property", set: "widgets", key: WIDGET, segment: "widget_nope" };
  const navigation = { parent: { mapping: t.store.resolveMapping("widgets"), id: WIDGET }, name: "widget_nope" };
  const gadgets = t.store.resolveMapping("gadgets");
  for (const c of [{ user: t.admin, url, route, navigation }, { user: t.admin, url, route }]) {
    const error = failure(() => t.hooks.query(c, gadgets));
    assert.equal(error.status, 400);
    assert.equal(error.message, "Predefined queries are only supported on collection-valued navigation properties.");
  }
  t.store.state.mappings.widget.relationships.widget_owner = { entity: "gadget", from: "widgetid", to: "widgetid", many: false };
  const single = { ...navigation, name: "widget_owner" };
  assert.equal(failure(() => t.hooks.query({ user: t.admin, url, route, navigation: single }, gadgets)).status, 400);
});

test("install registers the hook and returns its seeding, so awaiting install means the mappings exist", async () => {
  const store = new DataStore({ state: emptyState() });
  const hooks = {};
  // A write already queued on the store delays the seeding, so only an awaited install sees it done.
  const earlier = store.transact(() => new Promise((resolve) => setTimeout(resolve, 20)));
  await install({ store, registry: { register() {} }, recordHooks: { add: (name, fn) => { hooks[name] = fn; } } });
  assert.equal(typeof hooks.query, "function");
  assert.equal(store.state.mappings.savedquery?.entitySet, "savedqueries");
  assert.equal(store.state.mappings.userquery?.entitySet, "userqueries");
  await earlier;
});

test("no predefined query parameter leaves the request to the records layer", async () => {
  const t = await setup();
  assert.equal(await t.query(t.admin, "widgets"), undefined);
});

test("reset(api) re-seeds the saved and user query mappings and tables after a wipe", async () => {
  const { store, api } = await setup();
  for (const logical of ["savedquery", "userquery"]) {
    delete store.state.mappings[logical];
    delete store.state.tables[logical];
  }
  await reset(api);
  assert.equal(store.state.mappings.savedquery.entitySet, "savedqueries");
  assert.equal(store.state.mappings.userquery.entitySet, "userqueries");
  assert.deepEqual(store.state.tables.savedquery, []);
  assert.deepEqual(store.state.tables.userquery, []);
});

// RetrieveExchangeRate and SendAppNotification, registered by install and called through the registry. Invented GUIDs only.
const CURRENCY = "55555555-0000-4000-8000-000000000001";
async function messageSetup() {
  const state = emptyState();
  state.mappings.transactioncurrency = {
    logicalName: "transactioncurrency", entitySet: "transactioncurrencies", idColumn: "transactioncurrencyid", nameColumn: "currencyname",
    fields: { transactioncurrencyid: { dataverseType: "uniqueidentifier" }, currencyname: text, exchangerate: { dataverseType: "decimal" }, ownerid: lookup, owninguser: lookup, owningteam: lookup, owningbusinessunit: lookup },
    relationships: {},
  };
  state.tables.transactioncurrency = [{ transactioncurrencyid: CURRENCY, currencyname: "Euro", exchangerate: 1.25 }];
  const store = new DataStore({ state });
  const ops = [];
  const api = { store, registry: { register: (op) => ops.push(op) }, recordHooks: { add() {} }, change: (fn) => fn(), principals: null };
  await install(api);
  await ensureSecurityModel(store, SETTINGS);
  api.principals = createPrincipals(store, SETTINGS);
  return {
    store, op: (name) => ops.find((o) => o.name === name),
    admin: api.principals.byObjectId(ADMIN_OID), basic: api.principals.byObjectId(BASIC_OID),
  };
}
const ORIGIN_URL = "http://127.0.0.1:5555";

test("RetrieveExchangeRate answers the exchange rate of a currency, and refuses an unknown or malformed id", async () => {
  const t = await messageSetup();
  const rate = t.op("RetrieveExchangeRate");
  assert.equal(rate.csdl.includes('<Parameter Name="TransactionCurrencyId" Type="Edm.Guid" Nullable="false" />'), true);
  const res = await rate.handle({ origin: ORIGIN_URL, version: "v9.2", user: t.admin, params: { TransactionCurrencyId: CURRENCY } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ExchangeRate, 1.25);
  await assert.rejects(rate.handle({ origin: ORIGIN_URL, version: "v9.2", user: t.admin, params: { TransactionCurrencyId: MISSING } }), (e) => e.status === 404);
  await assert.rejects(rate.handle({ origin: ORIGIN_URL, version: "v9.2", user: t.admin, params: { TransactionCurrencyId: "not-a-guid" } }), (e) => e.status === 400);
});

test("SendAppNotification writes one appnotification row for a systemuser, and a caller without write on the table is refused", async () => {
  const t = await messageSetup();
  const send = t.op("SendAppNotification");
  const recipient = { systemuserid: t.admin.systemuserid };
  const res = await send.handle({ origin: ORIGIN_URL, version: "v9.2", user: t.admin, identity: { admin: true }, body: { Title: "Hello", Body: "Details", Recipient: recipient, IconType: 1, Priority: 2, Expiry: 60 } });
  assert.equal(res.status, 200);
  assert.equal(t.store.state.tables.appnotification.length, 1);
  assert.equal(t.store.state.tables.appnotification[0].title, "Hello");
  await assert.rejects(send.handle({ origin: ORIGIN_URL, version: "v9.2", user: t.basic, body: { Title: "Denied", Recipient: recipient } }), (e) => e.status === 403);
  assert.equal(t.store.state.tables.appnotification.length, 1, "a refused call writes no row");
  await assert.rejects(send.handle({ origin: ORIGIN_URL, version: "v9.2", user: t.admin, body: { Recipient: recipient } }), (e) => e.status === 400);
  await assert.rejects(send.handle({ origin: ORIGIN_URL, version: "v9.2", user: t.admin, body: { Title: "x", Recipient: { systemuserid: MISSING } } }), (e) => e.status === 404);
});
