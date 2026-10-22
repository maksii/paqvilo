// Upsert and delete resolve their target row inside the write slot: concurrent requests see the writes queued before them.
// Invented schema and GUIDs only; the record handlers run without HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { createPrincipals, ensureSecurityModel } from "../lib/dataverse-security.mjs";
import { parseDataverseRoute, parsePrefer } from "../lib/dataverse-odata.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { createChangeLog } from "../lib/dataverse-changes.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const ADMIN_OID = "77777777-7777-4777-8777-777777777731";
const SETTINGS = {
  organizationId: "77777777-7777-4777-8777-777777777730", tenantId: "tenant-test", uniqueName: "inventedorg", friendlyName: "Invented Org",
  version: "9.2.25041.00000", users: [{ objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] }],
};

async function setup() {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
    alternateKeys: [{ name: "x_item_code", attributes: ["x_code"] }],
    fields: { x_name: { dataverseType: "nvarchar" }, x_code: { dataverseType: "nvarchar" } }, relationships: {},
  };
  state.tables.x_item = [];
  const store = new DataStore({ state });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const handlers = createRecordHandlers({ store, change: (fn) => fn(), principals, metadataFields: () => undefined, changes: createChangeLog(store) });
  const admin = principals.byObjectId(ADMIN_OID);
  const send = (method, path, { body, headers = {} } = {}) => {
    const url = new URL(`/api/data/v9.2/${path}`, ORIGIN);
    return handlers.handle({
      method, route: parseDataverseRoute(url.pathname), url, origin: ORIGIN, version: "v9.2", prefer: parsePrefer(headers.prefer), headers, body,
      user: admin, caller: admin, identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid }, requestId: "test",
    }).then((response) => response.status, (error) => error.status ?? error);
  };
  return { store, send };
}

test("two concurrent upserts of one new alternate key create once and update once, never 412", async () => {
  const { store, send } = await setup();
  const statuses = await Promise.all([
    send("PATCH", "x_items(x_code='K-1')", { body: { x_name: "first" } }),
    send("PATCH", "x_items(x_code='K-1')", { body: { x_name: "second" } }),
  ]);
  assert.deepEqual(statuses, [204, 204]);
  const rows = store.state.tables.x_item.filter((row) => row.x_code === "K-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].x_name, "second", "the second upsert updated the row the first created");
  // With a representation the two outcomes are told apart: one create (201), one update (200).
  const represented = await Promise.all(["third", "fourth"].map((x_name) => send("PATCH", "x_items(x_code='K-2')", { body: { x_name }, headers: { prefer: "return=representation" } })));
  assert.deepEqual(represented.sort(), [200, 201]);
  assert.equal(store.state.tables.x_item.filter((row) => row.x_code === "K-2").length, 1);
});

test("concurrent delete and update of one row resolve in request order", async () => {
  const { store, send } = await setup();
  assert.equal(await send("PATCH", "x_items(x_code='K-3')", { body: { x_name: "kept" } }), 204);
  const id = store.state.tables.x_item[0].x_itemid;
  // Delete first: the update queued behind it finds no row (If-Match: * forbids an upsert create).
  assert.deepEqual(await Promise.all([
    send("DELETE", `x_items(${id})`),
    send("PATCH", `x_items(${id})`, { body: { x_name: "late" }, headers: { "if-match": "*" } }),
  ]), [204, 404]);
  assert.equal(store.state.tables.x_item.length, 0);
  // Update first, then delete: both succeed and the row is gone.
  assert.equal(await send("PATCH", "x_items(x_code='K-4')", { body: { x_name: "again" } }), 204);
  const next = store.state.tables.x_item[0].x_itemid;
  assert.deepEqual(await Promise.all([
    send("PATCH", `x_items(${next})`, { body: { x_name: "updated" }, headers: { "if-match": "*" } }),
    send("DELETE", `x_items(${next})`),
  ]), [204, 204]);
  assert.equal(store.state.tables.x_item.length, 0);
});
