// Write-volume gate (runtime-performance.md, "Write-volume gate"): bulk creates, key upserts, single-record reads,
// key-set paging with a concurrent insert, a 1,000-child cascade and a deep share graph, each timed at N and 2N rows.
// It asserts the time ratio between the two sizes, never absolute milliseconds: the O(n) paths stay near 2x, and a
// reintroduced per-row table scan (O(n^2)) lands near 4x. Run explicitly, not in the ordinary suite:
//   node --test mirage/test-volume/write-volume.test.mjs
// The record handlers run in process (no HTTP).
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { DEPTH, createPrincipals, ensureSecurityModel, privilegeId, privilegeName, uuidV5 } from "../lib/dataverse-security.mjs";
import { organizationPrincipalContext } from "../lib/dataverse-principal-context.mjs";
import { parseDataverseRoute, parsePrefer } from "../lib/dataverse-odata.mjs";
import { createRecordHandlers } from "../lib/dataverse-records.mjs";
import { createChangeLog } from "../lib/dataverse-changes.mjs";
import { seed as seedStandardTables } from "../lib/dataverse-standard.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const ORG = "77777777-7777-4777-8777-777777777700";
const ADMIN_OID = "77777777-7777-4777-8777-777777777701";
const READER_OID = "77777777-7777-4777-8777-777777777702";
const SETTINGS = {
  organizationId: ORG, tenantId: "tenant-volume", uniqueName: "inventedvolume", friendlyName: "Invented Volume", version: "9.2.25041.00000",
  users: [
    { objectId: ADMIN_OID, upn: "admin@example.test", displayName: "Admin", roles: ["System Administrator"] },
    { objectId: READER_OID, upn: "reader@example.test", displayName: "Reader", roles: [] },
  ],
};
const N = 2500;
const RATIO = 3; // linear work doubles; quadratic work quadruples
const ATTEMPTS = 3; // a noisy host may retry; a quadratic path fails every attempt

async function fixture() {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
    alternateKeys: [{ name: "x_item_code", attributes: ["x_code"] }],
    fields: { x_name: { dataverseType: "nvarchar" }, x_code: { dataverseType: "nvarchar" }, x_rank: { dataverseType: "int" }, ownerid: { dataverseType: "owner" } },
    relationships: { x_children: { entity: "x_child", many: true, from: "x_itemid", to: "x_parentid", cascade: { delete: "Cascade" } } },
  };
  state.mappings.x_child = {
    logicalName: "x_child", entitySet: "x_children", idColumn: "x_childid", nameColumn: "x_name",
    fields: { x_name: { dataverseType: "nvarchar" }, x_parentid: { dataverseType: "lookup" } },
    relationships: { x_parent: { entity: "x_item", many: false, from: "x_parentid", to: "x_itemid", cascade: { delete: "Cascade" } } },
  };
  state.tables.x_item = [];
  state.tables.x_child = [];
  const store = new DataStore({ state });
  // The standard tables give a delete the relationship volume of a real organization (thousands of relationships).
  await store.transact(() => seedStandardTables(store));
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const handlers = createRecordHandlers({ store, change: (fn) => fn(), principals, metadataFields: () => undefined, changes: createChangeLog(store) });
  const as = (user) => {
    const context = organizationPrincipalContext(store, user);
    return async (method, path, { body, headers = {} } = {}) => {
      const url = new URL(path.startsWith("http") ? path : `/api/data/v9.2/${path}`, ORIGIN);
      const response = await handlers.handle({ method, route: parseDataverseRoute(url.pathname), url, origin: ORIGIN, version: "v9.2",
        prefer: parsePrefer(headers.prefer), headers, body, user, caller: user, identity: context.identity, requestId: "volume" });
      assert.ok(response.status < 400, `${method} ${path} answered ${response.status}`);
      return response.body;
    };
  };
  const admin = principals.byObjectId(ADMIN_OID), reader = principals.byObjectId(READER_OID);
  return { store, principals, admin, reader, send: as(admin), read: as(reader) };
}

const targets = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ x_name: `Item ${from + i}`, x_code: `K${from + i}`, x_rank: (from + i) % 97 }));
async function timed(fn) {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}
// Times `run(size)` on fresh fixtures at N and 2N; passes when one attempt stays under the ratio.
async function scales(name, run, { ratio = RATIO } = {}) {
  const observed = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const small = await run(N), large = await run(2 * N);
    observed.push(`${Math.round(small)} -> ${Math.round(large)} ms`);
    if (large / Math.max(small, 1) < ratio) return;
  }
  assert.fail(`${name} grew faster than linearly from ${N} to ${2 * N} rows: ${observed.join("; ")}`);
}

test("CreateMultiple stays linear in the number of targets (primary and alternate key indexes)", async () => {
  await scales("CreateMultiple", async (n) => {
    const { send, store } = await fixture();
    const ms = await timed(() => send("POST", "x_items/Microsoft.Dynamics.CRM.CreateMultiple", { body: { Targets: targets(n) } }));
    assert.equal(store.state.tables.x_item.length, n);
    return ms;
  });
});

test("UpsertMultiple by alternate key stays linear in the number of targets", async () => {
  await scales("UpsertMultiple", async (n) => {
    const { send, store } = await fixture();
    await send("POST", "x_items/Microsoft.Dynamics.CRM.CreateMultiple", { body: { Targets: targets(n) } });
    const ms = await timed(() => send("POST", "x_items/Microsoft.Dynamics.CRM.UpsertMultiple", {
      body: { Targets: Array.from({ length: n }, (_, i) => ({ "@odata.id": `x_items(x_code='K${i}')`, x_name: `Updated ${i}` })) } }));
    assert.equal(store.state.tables.x_item.length, n);
    assert.ok(store.state.tables.x_item.every((row) => row.x_name.startsWith("Updated")));
    return ms;
  });
});

test("single-record reads stay constant in the table size (index before the row-security filter)", async () => {
  await scales("single-record read", async (n) => {
    const { send, store, principals, admin } = await fixture();
    const { Ids: ids } = await send("POST", "x_items/Microsoft.Dynamics.CRM.CreateMultiple", { body: { Targets: targets(n) } });
    const filter = principals.readFilter({ user: admin, entity: "x_item" }) ?? (() => true);
    const { identity } = organizationPrincipalContext(store, admin);
    return timed(() => {
      for (let i = 0; i < 2000; i++) {
        const id = ids[(i * 37) % n];
        const [row] = store.query("x_item", { $select: "x_name,x_itemid" }, identity, undefined, { id, dialect: "dataverse", backendRowsFilter: (name, candidate) => filter(candidate) }).value;
        assert.equal(row.x_itemid, id);
      }
    });
  }, { ratio: 1.6 });
});

test("key-set paging visits every row once despite a concurrent insert, at a linear cost per page", async () => {
  await scales("paging", async (n) => {
    const { send } = await fixture();
    await send("POST", "x_items/Microsoft.Dynamics.CRM.CreateMultiple", { body: { Targets: targets(n) } });
    const seen = [];
    let next = "x_items?$select=x_name&$orderby=x_rank", pages = 0, inserted = false;
    const ms = await timed(async () => {
      while (next) {
        const page = await send("GET", next, { headers: { prefer: "odata.maxpagesize=500" } });
        pages++;
        seen.push(...page.value.map((row) => row.x_itemid));
        next = page["@odata.nextLink"];
        // A row that sorts before the cursor arrives after the first page: the offset would repeat a row.
        if (!inserted) { inserted = true; await send("POST", "x_items", { body: { x_name: "Late", x_code: "LATE", x_rank: 0 } }); }
      }
    });
    assert.equal(seen.length, n);
    assert.equal(new Set(seen).size, n);
    return ms / pages;
  });
});

test("a cascade delete of a 1,000-child tree stays linear in the number of children", async () => {
  await scales("cascade delete", async (n) => {
    const children = Math.round(n / 2.5); // 1,000 children at N; 2,000 at 2N
    const { send, store } = await fixture();
    const { Ids: [parent] } = await send("POST", "x_items/Microsoft.Dynamics.CRM.CreateMultiple", { body: { Targets: targets(1) } });
    await send("POST", "x_children/Microsoft.Dynamics.CRM.CreateMultiple", {
      body: { Targets: Array.from({ length: children }, (_, i) => ({ x_name: `Child ${i}`, "x_parent@odata.bind": `/x_items(${parent})` })) } });
    const ms = await timed(() => send("DELETE", `x_items(${parent})`));
    assert.equal(store.state.tables.x_child.length, 0);
    return ms;
  });
});

test("a reader of a deep share graph sees every shared row at a linear cost", async () => {
  await scales("share graph read", async (n) => {
    const { store, principals, admin, reader, read } = await fixture();
    const noun = principals.privilegeNoun("x_item");
    const role = uuidV5(ORG, "role:volume-share-reader"), teams = Array.from({ length: 12 }, (_, i) => uuidV5(ORG, `team:volume-${i}`));
    const ref = (logical, id) => ({ id, logical_name: logical });
    await store.transact(() => {
      const tables = store.state.tables;
      // Basic read only: the reader sees a row through a share with one of its teams.
      tables.role.push({ roleid: role, name: "Volume share reader", businessunitid: reader.businessunitid, organizationid: ref("organization", ORG) });
      tables.roleprivileges.push({ roleprivilegeid: uuidV5(role, "read"), roleid: ref("role", role), privilegeid: ref("privilege", privilegeId(ORG, privilegeName("read", noun))), privilegedepthmask: DEPTH.Basic });
      tables.systemuserroles.push({ systemuserroleid: uuidV5(role, reader.systemuserid), systemuserid: ref("systemuser", reader.systemuserid), roleid: ref("role", role) });
      for (const team of teams) {
        tables.team.push({ teamid: team, name: `Volume team ${team.slice(-4)}`, teamtype: 0, businessunitid: reader.businessunitid, organizationid: ref("organization", ORG) });
        tables.teammembership.push({ teammembershipid: uuidV5(team, reader.systemuserid), systemuserid: ref("systemuser", reader.systemuserid), teamid: ref("team", team) });
      }
      for (let i = 0; i < n; i++) {
        const id = uuidV5(ORG, `volume-row:${i}`);
        tables.x_item.push({ x_itemid: id, x_name: `Shared ${i}`, x_code: `S${i}`, x_rank: i % 97, ownerid: ref("systemuser", admin.systemuserid), statecode: 0, statuscode: 1 });
        // Every second row is shared; the others stay invisible to the reader.
        if (i % 2 === 0) tables.principalobjectaccess.push({ principalobjectaccessid: uuidV5(id, "share"), principalid: ref("team", teams[i % teams.length]), objectid: id, objecttypecode: "x_item", accessrightsmask: 1, inheritedaccessrightsmask: 0 });
      }
    });
    let visible = 0;
    const ms = await timed(async () => {
      let next = "x_items?$select=x_name";
      while (next) {
        const page = await read("GET", next, { headers: { prefer: "odata.maxpagesize=5000" } });
        visible += page.value.length;
        next = page["@odata.nextLink"];
      }
    });
    assert.equal(visible, n / 2);
    return ms;
  });
});
