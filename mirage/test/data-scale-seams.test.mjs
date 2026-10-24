// Index and caching seams of the record store (runtime-performance.md, "Write-volume seams"): row indexes with
// a validity check, the per-operation relationship graph, per-table revision counters, key-set paging,
// SDK savepoints, journal section reuse, dirty-table persistence hashing and the service-protection window.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DataStore, emptyState, keysetPage } from "../lib/data.mjs";
import { createPrincipals, ensureSecurityModel, grantAccess, revokeAccess } from "../lib/dataverse-security.mjs";
import { createServiceProtection } from "../lib/dataverse-limits.mjs";
import { createWebApiFormatter } from "../lib/webapi-format.mjs";

const ADMIN = { admin: true };
const gid = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
const itemMapping = () => ({
  logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
  alternateKeys: [{ name: "x_item_code", attributes: ["x_code"] }],
  fields: { x_name: { dataverseType: "nvarchar" }, x_code: { dataverseType: "nvarchar" }, x_rank: { dataverseType: "int" } },
  relationships: { x_children: { entity: "x_child", many: true, from: "x_itemid", to: "x_parentid", cascade: { delete: "Cascade" } } },
});
const childMapping = () => ({
  logicalName: "x_child", entitySet: "x_children", idColumn: "x_childid", nameColumn: "x_name",
  fields: { x_name: { dataverseType: "nvarchar" }, x_parentid: { dataverseType: "lookup" } },
  relationships: { x_parent: { entity: "x_item", many: false, from: "x_parentid", to: "x_itemid", cascade: { delete: "Cascade" } } },
});
function store(rows = [], options = {}) {
  const state = emptyState();
  state.settings.permissionMode = "permissive";
  state.mappings.x_item = itemMapping();
  state.mappings.x_child = childMapping();
  state.tables.x_item = rows;
  state.tables.x_child = [];
  return new DataStore({ state, ...options });
}

test("the primary-key index answers through a validity check after an edit outside the row operations", async () => {
  const s = store([{ x_itemid: gid(1), x_name: "one" }, { x_itemid: gid(2), x_name: "two" }]);
  const rows = s.state.tables.x_item, mapping = s.resolveMapping("x_item");
  assert.equal(s.rowIndex(mapping, rows, gid(2)), 1);
  // Same length, different rows: the cached position no longer carries the key.
  rows.splice(0, 1);
  rows.push({ x_itemid: gid(3), x_name: "three" });
  assert.equal(s.rowIndex(mapping, rows, gid(2)), 0);
  assert.equal(s.rowIndex(mapping, rows, `{${gid(3).toUpperCase()}}`), 1);
  assert.equal(s.rowIndex(mapping, rows, gid(1)), -1);
  // Writes through the row operations keep the index current, including removals before a position.
  await s.transact(() => {
    s.removeRow("x_item", rows, 0);
    s.insertRow("x_item", rows, { x_itemid: gid(4), x_name: "four" });
    s.mutateRow("x_item", rows, 0, { x_itemid: gid(5) });
  }, { incremental: true });
  assert.deepEqual([gid(5), gid(4), gid(3)].map((id) => s.rowIndex(mapping, rows, id)), [0, 1, -1]);
  assert.deepEqual(rows.map((row) => row.x_itemid), [gid(5), gid(4)]);
});

test("bulk creates and key upserts check alternate keys and primary keys through per-transaction indexes", async () => {
  const s = store();
  await s.transact(() => {
    for (let i = 0; i < 200; i++) s.createRecord("x_item", { x_itemid: gid(i), x_name: `n${i}`, x_code: `K${i}` }, ADMIN);
    assert.throws(() => s.createRecord("x_item", { x_name: "dupe", x_code: "k7" }, ADMIN), { code: "DuplicateRecord" });
    assert.throws(() => s.createRecord("x_item", { x_itemid: `{${gid(9).toUpperCase()}}`, x_name: "dupe id" }, ADMIN), { code: "DuplicateRecord" });
    // The key-segment lookup keeps valuesEqual semantics: case and accent folding, braces on GUID keys.
    assert.equal(s.findByKey(s.resolveMapping("x_item"), "x_code='k12'")?.x_itemid, gid(12));
    s.updateRecord("x_item", gid(12), { x_code: "Ké-12" }, ADMIN);
    assert.equal(s.findByKey(s.resolveMapping("x_item"), "x_code='KE-12'")?.x_itemid, gid(12));
    assert.equal(s.findByKey(s.resolveMapping("x_item"), "x_code='K12'"), undefined);
    // Uniqueness keeps the store's equality: case-insensitive, accent-sensitive.
    assert.throws(() => s.updateRecord("x_item", gid(13), { x_code: "KÉ-12" }, ADMIN), { code: "DuplicateRecord" });
    s.updateRecord("x_item", gid(13), { x_code: "ke-12" }, ADMIN);
  }, { incremental: true });
  // A direct edit between transactions is seen: the key indexes live for one transaction only.
  s.state.tables.x_item[3].x_code = "DIRECT";
  await s.transact(() => {
    assert.equal(s.findByKey(s.resolveMapping("x_item"), "x_code='direct'")?.x_itemid, gid(3));
    assert.throws(() => s.createRecord("x_item", { x_name: "clash", x_code: "Direct" }, ADMIN), { code: "DuplicateRecord" });
  }, { incremental: true });
  // Rows whose key column is not a plain string stay searchable (always-scanned list).
  s.state.tables.x_item.push({ x_itemid: gid(500), x_name: "dated", x_code: "2024-01-02" });
  await s.transact(() => {
    assert.equal(s.findByKey(s.resolveMapping("x_item"), "x_code='K40'")?.x_itemid, gid(40));
    assert.equal(s.findByKey(s.resolveMapping("x_item"), "x_code='2024-01-02T00:00:00Z'")?.x_itemid, gid(500));
  }, { incremental: true });
});

test("a cascade delete walks the relationship graph once per table, not once per deleted row", async () => {
  const walks = async (children) => {
    const s = store([{ x_itemid: gid(1), x_name: "parent" }]);
    s.state.tables.x_child = Array.from({ length: children }, (_, i) => ({ x_childid: gid(1000 + i), x_name: `c${i}`, x_parentid: { id: gid(1), logical_name: "x_item" } }));
    let calls = 0;
    const relationshipsFor = s.relationshipsFor.bind(s);
    s.relationshipsFor = (...args) => { calls++; return relationshipsFor(...args); };
    await s.remove("x_item", gid(1), ADMIN);
    assert.equal(s.state.tables.x_child.length, 0);
    return calls;
  };
  assert.equal(await walks(40), await walks(80));
});

test("per-table revisions advance only for the tables a row transaction wrote; other commits advance every table", async () => {
  const s = store([{ x_itemid: gid(1), x_name: "one" }]);
  s.state.tables.x_other = [];
  const items = s.tablesRevision(["x_item"]), others = s.tablesRevision(["x_other"]);
  await s.update("x_item", gid(1), { x_name: "changed" }, ADMIN);
  assert.notEqual(s.tablesRevision(["x_item"]), items);
  assert.equal(s.tablesRevision(["x_other"]), others);
  await s.transact(() => { s.state.settings.note = "full transaction"; });
  assert.notEqual(s.tablesRevision(["x_other"]), others);
});

test("the security index keeps its principals across business and share writes and sees every share", async () => {
  const SETTINGS = { organizationId: gid(900), tenantId: "tenant-test", uniqueName: "inventedorg", friendlyName: "Invented Org", version: "9.2.25041.00000",
    users: [{ objectId: gid(901), upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] }, { objectId: gid(902), upn: "user@example.test", displayName: "User", roles: ["Basic User"] }] };
  const s = new DataStore({ state: (() => { const state = emptyState(); state.mappings.x_item = { ...itemMapping(), ownershipType: "UserOwned" }; state.tables.x_item = []; return state; })() });
  await ensureSecurityModel(s, SETTINGS);
  const principals = createPrincipals(s, SETTINGS);
  const user = principals.byObjectId(gid(902));
  const core = s.tablesRevision(["systemuser", "role", "roleprivileges"]);
  await s.create("x_item", { x_itemid: gid(10), x_name: "business row" }, ADMIN);
  assert.equal(s.tablesRevision(["systemuser", "role", "roleprivileges"]), core, "a business write leaves the principal tables' revision alone");
  assert.equal(principals.byObjectId(gid(902)), user, "the principal index was not rebuilt");
  const shares = s.tablesRevision(["principalobjectaccess"]), saves = [];
  s.onSave = (timing) => saves.push(timing.mode);
  await grantAccess(s, { target: { logical: "x_item", id: gid(10) }, principal: { id: user.systemuserid, logical_name: "systemuser" }, mask: 1 });
  assert.notEqual(s.tablesRevision(["principalobjectaccess"]), shares);
  assert.equal(s.tablesRevision(["systemuser", "role", "roleprivileges"]), core, "a share advances only principalobjectaccess");
  assert.equal(principals.byObjectId(gid(902)), user);
  assert.equal(s.state.tables.principalobjectaccess.length, 1);
  await grantAccess(s, { target: { logical: "x_item", id: gid(10) }, principal: { id: user.systemuserid, logical_name: "systemuser" }, mask: 2 });
  assert.equal(s.state.tables.principalobjectaccess[0].accessrightsmask, 3);
  assert.equal(await revokeAccess(s, { target: { logical: "x_item", id: gid(10) }, principal: { id: user.systemuserid, logical_name: "systemuser" } }), true);
  assert.equal(s.state.tables.principalobjectaccess.length, 0);
});

test("key-set paging resumes after the named row and does not repeat a row inserted before it", async () => {
  const s = store(Array.from({ length: 30 }, (_, i) => ({ x_itemid: gid(i), x_name: `n${String(i).padStart(2, "0")}`, x_rank: i % 7 })));
  const page = (after, offset) => s.query("x_item", { $orderby: "x_rank desc" }, ADMIN, { offset, pageSize: 10, after });
  const first = page(null, 0);
  const second = page(first.value.at(-1).x_itemid, 10);
  assert.deepEqual(second.paging, { nextOffset: 20, moreRecords: true, totalCount: 30, order: [{ name: "x_rank", first: "4", last: "2" }] });
  assert.deepEqual(second.value, s.query("x_item", { $orderby: "x_rank desc" }, ADMIN, { offset: 10, pageSize: 10 }).value, "unchanged data pages identically");
  // A row that sorts on the first page arrives between requests: the offset would repeat a row, the key set does not.
  await s.create("x_item", { x_itemid: gid(99), x_name: "late", x_rank: 6 }, ADMIN);
  const third = page(second.value.at(-1).x_itemid, 20);
  const seen = [...first.value, ...second.value, ...third.value].map((row) => row.x_itemid);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 30);
  assert.equal(third.paging.moreRecords, false);
  // A continuation whose row is gone keeps the offset.
  assert.deepEqual(page(gid(12345), 20).value.map((row) => row.x_itemid), s.query("x_item", { $orderby: "x_rank desc" }, ADMIN, { offset: 20, pageSize: 10 }).value.map((row) => row.x_itemid));
});

test("keysetPage selects the smallest rows after the cursor in sortRows order", () => {
  const rows = [5, 3, 9, 1, 7, 3].map((rank, i) => ({ id: gid(i), rank }));
  const options = { mapping: { idColumn: "id" }, valueOf: (row, p) => row[p[0]], definition: () => ({ dataverseType: "int" }), lookupName: undefined };
  const specs = [{ path: ["rank"], descending: false }];
  const page = keysetPage(rows, specs, options, gid(1), 2);
  // Order: 1, 3 (cursor), 3 (later primary key), 5, 7, 9.
  assert.equal(page.before, 2, "the rows up to and including the cursor row");
  assert.deepEqual(page.rows.map((row) => row.id), [gid(5), gid(0)]);
  assert.equal(keysetPage(rows, specs, options, gid(77), 2), null);
});

test("a failed SDK call inside a pipeline undoes its rows through a savepoint and keeps held references", async () => {
  const s = store([{ x_itemid: gid(1), x_name: "one", x_code: "A" }]);
  const rows = s.state.tables.x_item, first = rows[0];
  await s.transact(() => {
    s.createRecord("x_item", { x_itemid: gid(2), x_name: "kept" }, ADMIN);
    assert.throws(() => s.sdkMutation(() => {
      s.createRecord("x_item", { x_itemid: gid(3), x_name: "undone" }, ADMIN);
      s.updateRecord("x_item", gid(1), { x_name: "undone too" }, ADMIN);
      s.state.settings.sdkMarker = true;
      throw new Error("invented SDK failure");
    }), /invented SDK failure/);
    assert.equal(s.state.tables.x_item, rows);
    assert.deepEqual(rows.map((row) => [row.x_itemid, row.x_name]), [[gid(1), "one"], [gid(2), "kept"]]);
    assert.equal(s.state.settings.sdkMarker, undefined);
    assert.equal(s.rowIndex(s.resolveMapping("x_item"), rows, gid(3)), -1);
  });
  assert.equal(rows[0], first, "the restored row is the object callers already hold");
  assert.equal(first.x_name, "one");
});

test("journaled row transactions reuse the section copy the previous commit proved unchanged", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "data-scale-seams-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json");
  const s = await store([{ x_itemid: gid(1), x_name: "one" }], { file, persistence: { journalThresholdBytes: 0 } }).init();
  await s.update("x_item", gid(1), { x_name: "a" }, ADMIN);
  const copy = s.sectionSnapshot.sections.get("mappings").copy;
  await s.update("x_item", gid(1), { x_name: "b" }, ADMIN);
  assert.equal(s.sectionSnapshot.sections.get("mappings").copy, copy, "the second write reused the first write's mapping copy");
  // A failed write that changed a section restores it, and leaves no copy to reuse.
  await assert.rejects(s.transact(() => { s.state.mappings.x_item.x_marker = 1; s.updateRecord("x_item", gid(1), { x_name: "c" }, ADMIN); throw new Error("rejected"); }, { incremental: true }), /rejected/);
  assert.equal(s.state.mappings.x_item.x_marker, undefined);
  assert.equal(s.sectionSnapshot, null);
  await s.transact(() => { s.state.mappings.x_item.x_marker = 2; s.updateRecord("x_item", gid(1), { x_name: "d" }, ADMIN); }, { incremental: true });
  const restarted = await new DataStore({ file, persistence: { journalThresholdBytes: 0 } }).init();
  assert.equal(restarted.state.mappings.x_item.x_marker, 2);
  assert.equal(restarted.state.tables.x_item[0].x_name, "d");
});

test("an incremental write hands the storage adapter the tables it wrote", async () => {
  const saves = [];
  const adapter = { load: async (state) => state, save: async (state, options) => { saves.push(options.tables ? [...options.tables].sort() : null); } };
  const s = await store([{ x_itemid: gid(1), x_name: "one" }], { storageAdapter: adapter }).init();
  await s.update("x_item", gid(1), { x_name: "two" }, ADMIN);
  await s.transact(() => { s.state.tables.x_child.push({ x_childid: gid(2) }); });
  assert.deepEqual(saves, [["x_item"], null]);
});

test("the service-protection window drops expired entries and still filters after the clock moves back", () => {
  let now = 1_000_000;
  const limits = createServiceProtection({ requestsPer300s: 3, clock: () => now });
  for (let i = 0; i < 3; i++) limits.admit("u").release(1);
  assert.equal(limits.admit("u").ok, false);
  now += 300_000;
  assert.equal(limits.admit("u").ok, true);
  now -= 200_000; // an injected clock may move back
  limits.admit("u").release(1);
  now += 400_000;
  // The earlier, later-stamped request is still in the window; the back-dated one has expired behind it.
  assert.equal(limits.headers("u")["x-ms-ratelimit-burst-remaining-xrm-requests"], "2");
});

test("single-record formatting finds its stored row through the primary-key index, not a table scan per response", () => {
  // Every id read is counted: a per-response table index reads all 5,000 keys for each GET.
  let idReads = 0;
  const s = store(Array.from({ length: 5000 }, (_, i) => ({ x_itemid: gid(i + 1), x_name: `n${i}`, x_code: `K${i}`, x_rank: i })));
  const rows = s.state.tables.x_item;
  for (const row of rows) {
    const value = row.x_itemid;
    Object.defineProperty(row, "x_itemid", { enumerable: true, get() { idReads++; return value; } });
  }
  s.state.tables.x_child = [{ x_childid: gid(900), x_name: "c", x_parentid: gid(42) }];
  const item = s.resolveMapping("x_item"), child = s.resolveMapping("x_child");
  const formatter = createWebApiFormatter({ store: s, metadata: () => undefined });
  // The lookup's FormattedValue is the target row's name; the ETag comes from the stored child row.
  assert.deepEqual(formatter.formatEntity({ x_childid: gid(900), x_name: "c", x_parentid: gid(42) }, child), {
    "@odata.etag": s.etag(s.state.tables.x_child[0]),
    "_x_parentid_value": gid(42),
    "_x_parentid_value@OData.Community.Display.V1.FormattedValue": "n41",
    "_x_parentid_value@Microsoft.Dynamics.CRM.associatednavigationproperty": "x_parent",
    "_x_parentid_value@Microsoft.Dynamics.CRM.lookuplogicalname": "x_item",
    x_childid: gid(900),
    x_name: "c",
  });
  idReads = 0;
  // One formatter per request: each single-record GET formats its own response.
  for (let i = 0; i < 50; i++) {
    const n = ((i * 97) % 5000) + 1;
    assert.equal(createWebApiFormatter({ store: s, metadata: () => undefined }).storedRow(item, gid(n)), rows[n - 1]);
  }
  assert.ok(idReads < 2 * 5000, `50 single-record reads touched ${idReads} primary keys`);
  const request = createWebApiFormatter({ store: s, metadata: () => undefined });
  assert.equal(request.storedRow(item, gid(9999)), null);
  assert.equal(request.storedRow(item, `{${gid(42).toUpperCase()}}`), rows[41]);
});
