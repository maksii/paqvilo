// Simulated Dataverse record handlers: collections, single rows, properties,
// navigation, $ref, paging, writes and bound actions. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DataStore, emptyState } from "../lib/data.mjs";
import { createPrincipals, ensureSecurityModel } from "../lib/dataverse-security.mjs";
import { parseDataverseRoute, parsePrefer } from "../lib/dataverse-odata.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const VERSION = "v9.2";
const ORG = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const ADMIN_OID = "aaaaaaaa-0000-4000-8000-000000000001";
const BASIC_OID = "aaaaaaaa-0000-4000-8000-000000000002";
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

const lookup = { dataverseType: "lookup" };
const text = { dataverseType: "nvarchar" };

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    alternateKeys: [{ name: "widget_code", attributes: ["code"] }],
    relationships: {
      widget_gadgets: { entity: "gadget", from: "widgetid", to: "widgetid", many: true },
      widget_tags: { entity: "tag", from: "widgetid", to: "tagid", many: true, intersect: { entity: "widget_tag", from: "widgetid", to: "tagid" } },
    },
    fields: {
      name: text, code: text, price: { dataverseType: "money" }, status: { dataverseType: "picklist" },
      statecode: { dataverseType: "int" }, statuscode: { dataverseType: "int" }, ownerid: lookup,
    },
  };
  state.mappings.gadget = {
    logicalName: "gadget", entitySet: "gadgets", idColumn: "gadgetid", nameColumn: "name",
    relationships: { widgetid: { entity: "widget", from: "widgetid", to: "widgetid", many: false } },
    fields: { name: text, widgetid: lookup },
  };
  state.mappings.tag = { logicalName: "tag", entitySet: "tags", idColumn: "tagid", nameColumn: "name", fields: { name: text } };
  state.mappings.widget_tag = {
    logicalName: "widget_tag", entitySet: "widget_tags", idColumn: "widget_tagid", fields: { widgetid: lookup, tagid: lookup },
  };
  for (const logical of ["widget", "gadget", "tag", "widget_tag"]) state.tables[logical] = [];
  return state;
}

async function setup() {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const handlers = createRecordHandlers({ store, change: (fn) => fn(), principals, metadataFields: () => undefined });
  const admin = principals.byObjectId(ADMIN_OID);
  const basic = principals.byObjectId(BASIC_OID);
  const send = async (method, path, { user = admin, body, headers = {} } = {}) => {
    const url = new URL(path, ORIGIN);
    const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    return handlers.handle({
      method,
      route: parseDataverseRoute(url.pathname),
      url,
      origin: ORIGIN,
      version: VERSION,
      prefer: parsePrefer(lowered.prefer),
      headers: lowered,
      body,
      user,
      caller: user,
      identity: { admin: true, id: user.systemuserid, systemUserId: user.systemuserid },
      requestId: "test",
    });
  };
  return { store, principals, send, admin, basic };
}

// POST a row and return its id from OData-EntityId.
async function create(t, set, body, user = t.admin) {
  const res = await t.send("POST", `/api/data/${VERSION}/${set}`, { body, user });
  assert.equal(res.status, 204);
  return /\(([^()]+)\)$/.exec(res.headers["OData-EntityId"])[1];
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

const lowerId = (value) => String(value?.id ?? value).toLowerCase();
const annotate = (name) => ({ prefer: `odata.include-annotations="${name}"` });

test("collection GET returns context, etags, the id under $select and no annotations by default", async () => {
  const t = await setup();
  const first = await create(t, "widgets", { name: "Alpha", price: 12.5 });
  await create(t, "widgets", { name: "Beta", price: 3 });
  const res = await t.send("GET", `/api/data/${VERSION}/widgets?$select=name`);
  assert.equal(res.status, 200);
  assert.equal(res.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(name)`);
  assert.equal(res.body.value.length, 2);
  for (const row of res.body.value) {
    assert.ok(row.widgetid, "primary id is returned even when not selected");
    assert.match(row["@odata.etag"], /^W\/"/);
    assert.ok(!Object.keys(row).some((key) => key.includes("FormattedValue")));
  }
  assert.ok(res.body.value.some((row) => row.widgetid === first));
});

test("formatted-value annotations appear only when requested", async () => {
  const t = await setup();
  await create(t, "widgets", { name: "Alpha", price: 12.5 });
  const plain = await t.send("GET", `/api/data/${VERSION}/widgets?$select=price`);
  assert.ok(!Object.keys(plain.body.value[0]).some((key) => key.includes("FormattedValue")));
  const annotated = await t.send("GET", `/api/data/${VERSION}/widgets?$select=price`, {
    headers: annotate("OData.Community.Display.V1.FormattedValue"),
  });
  assert.ok(Object.keys(annotated.body.value[0]).some((key) => key.includes("FormattedValue")));
});

test("$count is capped at 5000 and totalrecordcount annotations follow $count", async () => {
  const t = await setup();
  for (let i = 0; i < 5001; i += 1) t.store.state.tables.widget.push({ widgetid: randomUUID(), name: `n${i}`, ownerid: null });
  const res = await t.send("GET", `/api/data/${VERSION}/widgets?$count=true&$select=name`, {
    headers: { prefer: "odata.include-annotations=\"Microsoft.Dynamics.CRM.totalrecordcount,Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded\"" },
  });
  assert.equal(res.body["@odata.count"], 5000);
  assert.equal(res.body["@Microsoft.Dynamics.CRM.totalrecordcount"], 5000);
  assert.equal(res.body["@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"], true);
  const plain = await t.send("GET", `/api/data/${VERSION}/widgets/$count`);
  assert.equal(plain.body, "5000");
});

test("maxpagesize pages through rows with $skiptoken until no nextLink remains", async () => {
  const t = await setup();
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(await create(t, "widgets", { name: `P${i}` }));
  const headers = { prefer: "odata.maxpagesize=2" };
  const seen = [];
  let res = await t.send("GET", `/api/data/${VERSION}/widgets?$select=name`, { headers });
  assert.equal(res.headers["Preference-Applied"], "odata.maxpagesize=2");
  for (let page = 0; page < 3; page += 1) {
    seen.push(...res.body.value.map((row) => row.widgetid));
    if (!res.body["@odata.nextLink"]) break;
    const next = new URL(res.body["@odata.nextLink"]);
    assert.match(next.search, /\$skiptoken=/);
    res = await t.send("GET", next.pathname + next.search, { headers });
  }
  assert.equal(res.body["@odata.nextLink"], undefined, "the last page has no nextLink");
  assert.deepEqual(seen.sort(), ids.sort());
});

test("unsupported query options are rejected", async () => {
  const t = await setup();
  const error = await failure(t.send("GET", `/api/data/${VERSION}/widgets?$skip=1`));
  assert.equal(error.status, 400);
  assert.equal(error.code, "UnsupportedQuery");
  assert.equal(error.message, "The query parameter $skip is not supported");
});

test("unknown entity set answers 404 with the Dataverse segment error", async () => {
  const t = await setup();
  const error = await failure(t.send("GET", `/api/data/${VERSION}/nothings`));
  assert.equal(error.status, 404);
  assert.equal(error.details.innerCode, "0x8006088a");
  assert.equal(error.message, "Resource not found for the segment 'nothings'.");
});

test("entity GET by GUID and by alternate key, with 404 for a missing row", async () => {
  const t = await setup();
  const id = await create(t, "widgets", { name: "Keyed", code: "W-1" });
  const byId = await t.send("GET", `/api/data/${VERSION}/widgets(${id})?$select=name`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(name)/$entity`);
  assert.equal(byId.body.name, "Keyed");
  const byKey = await t.send("GET", `/api/data/${VERSION}/widgets(code='W-1')`);
  assert.equal(byKey.body.widgetid, id);
  const missing = await failure(t.send("GET", `/api/data/${VERSION}/widgets(${MISSING})`));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, `widget With Id = ${MISSING} Does Not Exist`);
});

test("matching If-None-Match answers 304 with the etag", async () => {
  const t = await setup();
  const id = await create(t, "widgets", { name: "Tagged" });
  const first = await t.send("GET", `/api/data/${VERSION}/widgets(${id})`);
  const etag = first.headers.ETag;
  assert.match(etag, /^W\/"/);
  const again = await t.send("GET", `/api/data/${VERSION}/widgets(${id})`, { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
});

test("POST creates with OData-EntityId, honours return=representation and binds absolute references", async () => {
  const t = await setup();
  const widget = await create(t, "widgets", { name: "Parent" });
  const res = await t.send("POST", `/api/data/${VERSION}/gadgets`, {
    body: { name: "Child", "widgetid@odata.bind": `${ORIGIN}/api/data/${VERSION}/widgets(${widget})` },
  });
  assert.equal(res.status, 204);
  const gadget = /\(([^()]+)\)$/.exec(res.headers["OData-EntityId"])[1];
  assert.equal(t.store.state.tables.gadget.find((row) => row.gadgetid === gadget).widgetid.id, widget);
  const represented = await t.send("POST", `/api/data/${VERSION}/widgets`, {
    body: { name: "Shown" }, headers: { prefer: "return=representation" },
  });
  assert.equal(represented.status, 201);
  assert.equal(represented.headers["Preference-Applied"], "return=representation");
  assert.equal(represented.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets/$entity`);
  assert.equal(represented.body.name, "Shown");
});

test("ownership defaults set ownerid to the caller when the mapping has ownerid", async () => {
  const t = await setup();
  const id = await create(t, "widgets", { name: "Mine" }, t.basic);
  const row = t.store.state.tables.widget.find((item) => item.widgetid === id);
  assert.equal(lowerId(row.ownerid), t.basic.systemuserid.toLowerCase());
});

test("PATCH updates, enforces If-Match and If-None-Match, and rejects stale etags", async () => {
  const t = await setup();
  const id = await create(t, "widgets", { name: "Old" });
  const updated = await t.send("PATCH", `/api/data/${VERSION}/widgets(${id})`, { body: { name: "New" } });
  assert.equal(updated.status, 204);
  assert.equal(t.store.state.tables.widget.find((row) => row.widgetid === id).name, "New");

  const missingIfMatch = await failure(t.send("PATCH", `/api/data/${VERSION}/widgets(${MISSING})`, { body: { name: "x" }, headers: { "if-match": "*" } }));
  assert.equal(missingIfMatch.status, 404);
  assert.equal(missingIfMatch.message, `widget With Id = ${MISSING} Does Not Exist`);

  const exists = await failure(t.send("PATCH", `/api/data/${VERSION}/widgets(${id})`, { body: { name: "x" }, headers: { "if-none-match": "*" } }));
  assert.equal(exists.status, 412);
  assert.equal(exists.details.innerCode, "");

  const stale = await failure(t.send("PATCH", `/api/data/${VERSION}/widgets(${id})`, { body: { name: "x" }, headers: { "if-match": 'W/"1"' } }));
  assert.equal(stale.status, 412);
  assert.equal(stale.details.innerCode, "0x80060882");
});

test("PATCH with an alternate key upserts and echoes the key form", async () => {
  const t = await setup();
  const res = await t.send("PATCH", `/api/data/${VERSION}/widgets(code='K-9')`, { body: { name: "Keyed" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers["OData-EntityId"], `${ORIGIN}/api/data/${VERSION}/widgets(code='K-9')`);
  assert.equal(t.store.state.tables.widget.find((row) => row.code === "K-9").name, "Keyed");
});

test("properties: PUT, GET, $value and DELETE set and clear a value", async () => {
  const t = await setup();
  const id = await create(t, "widgets", { name: "Start", price: 4 });
  assert.equal((await t.send("PUT", `/api/data/${VERSION}/widgets(${id})/name`, { body: { value: "Put" } })).status, 204);
  const prop = await t.send("GET", `/api/data/${VERSION}/widgets(${id})/name`);
  assert.equal(prop.body.value, "Put");
  assert.equal(prop.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(${id})/name`);
  const raw = await t.send("GET", `/api/data/${VERSION}/widgets(${id})/name/$value`);
  assert.deepEqual(raw, { status: 200, body: "Put" });
  assert.equal((await t.send("DELETE", `/api/data/${VERSION}/widgets(${id})/price`)).status, 204);
  assert.equal((await t.send("GET", `/api/data/${VERSION}/widgets(${id})/price`)).status, 204);
  const unknown = await failure(t.send("GET", `/api/data/${VERSION}/widgets(${id})/nosuch`));
  assert.equal(unknown.status, 400);
  assert.match(unknown.message, /Could not find a property named/);
});

test("single-valued navigation returns the target entity, or 204 when unset", async () => {
  const t = await setup();
  const widget = await create(t, "widgets", { name: "Owner" });
  const linked = await create(t, "gadgets", { name: "Linked", "widgetid@odata.bind": `/widgets(${widget})` });
  const bare = await create(t, "gadgets", { name: "Bare" });
  const res = await t.send("GET", `/api/data/${VERSION}/gadgets(${linked})/widgetid?$select=name`);
  assert.equal(res.body.name, "Owner");
  assert.equal(res.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(name)/$entity`);
  assert.equal((await t.send("GET", `/api/data/${VERSION}/gadgets(${bare})/widgetid`)).status, 204);
});

test("collection navigation and $ref cover N:N associate, list and disassociate", async () => {
  const t = await setup();
  const widget = await create(t, "widgets", { name: "Tagged" });
  const gadget = await create(t, "gadgets", { name: "Under", "widgetid@odata.bind": `/widgets(${widget})` });
  const navigated = await t.send("GET", `/api/data/${VERSION}/widgets(${widget})/widget_gadgets?$select=name`);
  assert.deepEqual(navigated.body.value.map((row) => row.gadgetid), [gadget]);
  assert.match(navigated.body["@odata.context"], /#gadgets\(name\)$/);

  const tag = await create(t, "tags", { name: "red" });
  const associated = await t.send("POST", `/api/data/${VERSION}/widgets(${widget})/widget_tags/$ref`, {
    body: { "@odata.id": `${ORIGIN}/api/data/${VERSION}/tags(${tag})` },
  });
  assert.equal(associated.status, 204);
  const listed = await t.send("GET", `/api/data/${VERSION}/widgets(${widget})/widget_tags/$ref`);
  assert.equal(listed.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#Collection($ref)`);
  assert.deepEqual(listed.body.value, [{ "@odata.id": `${ORIGIN}/api/data/${VERSION}/tags(${tag})` }]);
  assert.equal((await t.send("GET", `/api/data/${VERSION}/widgets(${widget})/widget_tags/$count`)).body, "1");

  const removed = await t.send("DELETE", `/api/data/${VERSION}/widgets(${widget})/widget_tags(${tag})/$ref`);
  assert.equal(removed.status, 204);
  assert.deepEqual((await t.send("GET", `/api/data/${VERSION}/widgets(${widget})/widget_tags/$ref`)).body.value, []);
});

test("DELETE removes the row, then GET answers 404", async () => {
  const t = await setup();
  const id = await create(t, "widgets", { name: "Gone" });
  assert.equal((await t.send("DELETE", `/api/data/${VERSION}/widgets(${id})`)).status, 204);
  const after = await failure(t.send("GET", `/api/data/${VERSION}/widgets(${id})`));
  assert.equal(after.status, 404);
});

test("CreateMultiple returns Ids; DeleteMultiple is not implemented", async () => {
  const t = await setup();
  const res = await t.send("POST", `/api/data/${VERSION}/widgets/Microsoft.Dynamics.CRM.CreateMultiple`, {
    body: { Targets: [{ "@odata.type": "#Microsoft.Dynamics.CRM.widget", name: "a" }, { name: "b" }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#Microsoft.Dynamics.CRM.CreateMultipleResponse`);
  assert.equal(res.body.Ids.length, 2);
  const deleted = await failure(t.send("POST", `/api/data/${VERSION}/widgets/Microsoft.Dynamics.CRM.DeleteMultiple`, { body: { Targets: [] } }));
  assert.equal(deleted.status, 501);
});

test("count route returns a text count", async () => {
  const t = await setup();
  await create(t, "widgets", { name: "one" });
  await create(t, "widgets", { name: "two" });
  assert.deepEqual(await t.send("GET", `/api/data/${VERSION}/widgets/$count`), { status: 200, body: "2" });
});

test("FetchXML collection omits null columns and reports more records only when requested", async () => {
  const t = await setup();
  await create(t, "widgets", { name: "First", price: 1 });
  await create(t, "widgets", { name: "Second" });
  const fetchXml = '<fetch count="1"><entity name="widget"><attribute name="name"/><attribute name="price"/></entity></fetch>';
  const path = `/api/data/${VERSION}/widgets?fetchXml=${encodeURIComponent(fetchXml)}`;
  const plain = await t.send("GET", path);
  assert.equal(plain.body.value.length, 1);
  assert.equal(plain.body["@Microsoft.Dynamics.CRM.morerecords"], undefined);
  const withPage = await t.send("GET", path, { headers: annotate("Microsoft.Dynamics.CRM.morerecords") });
  assert.equal(withPage.body["@Microsoft.Dynamics.CRM.morerecords"], true);
  const nameOnly = await t.send("GET", `/api/data/${VERSION}/widgets?fetchXml=${encodeURIComponent('<fetch><entity name="widget"><attribute name="price"/></entity></fetch>')}`);
  assert.ok(nameOnly.body.value.every((row) => !("price" in row) || row.price !== null));
  const mismatch = await failure(t.send("GET", `/api/data/${VERSION}/gadgets?fetchXml=${encodeURIComponent(fetchXml)}`));
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.details.innerCode, "0x80060888");
});

test("Basic User sees only owned widgets and is denied others and unprivileged tables", async () => {
  const t = await setup();
  const adminWidget = await create(t, "widgets", { name: "Admin's" });
  const mine = await create(t, "widgets", { name: "Basic's" }, t.basic);
  const list = await t.send("GET", `/api/data/${VERSION}/widgets?$select=name`, { user: t.basic });
  assert.deepEqual(list.body.value.map((row) => row.widgetid), [mine]);
  const denied = await failure(t.send("GET", `/api/data/${VERSION}/widgets(${adminWidget})`, { user: t.basic }));
  assert.equal(denied.status, 403);
  assert.equal(denied.details.innerCode, "0x80048306");
  // tags are organization-owned: Basic User has no create privilege on them.
  const noPrivilege = await failure(t.send("POST", `/api/data/${VERSION}/tags`, { body: { name: "x" }, user: t.basic }));
  assert.equal(noPrivilege.status, 403);
  assert.equal(noPrivilege.details.innerCode, "0x80040220");
});
