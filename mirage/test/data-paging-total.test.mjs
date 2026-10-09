import test from "node:test";
import assert from "node:assert/strict";
import { DataStore } from "../lib/data.mjs";

const makeStore = async (count) =>
  new DataStore({
    state: {
      mappings: { item: { idColumn: "itemid", entitySet: "items" } },
      tables: {
        item: Array.from({ length: count }, (_, i) => ({
          itemid: `item-${String(i).padStart(5, "0")}`,
          name: `Item ${i}`,
        })),
      },
      settings: { permissionMode: "permissive" },
    },
  }).init();

test("paged $top limits the whole result while the page size controls each response", async () => {
  const store = await makeStore(4);
  const first = store.query("item", { $top: "3", $count: "true" }, {}, { offset: 0, pageSize: 1 });
  assert.equal(first.value.length, 1);
  assert.equal(first["@odata.count"], 4);
  // totalCount is the uncapped match count behind @odata.count and the
  // Microsoft.Dynamics.CRM.totalrecordcount(limitexceeded) annotations.
  assert.deepEqual(first.paging, { nextOffset: 1, moreRecords: true, totalCount: 4 });
  const last = store.query("item", { $top: "3" }, {}, { offset: 2, pageSize: 1 });
  assert.equal(last.value.length, 1);
  assert.deepEqual(last.paging, { nextOffset: 3, moreRecords: false, totalCount: 4 });
  const beyondTop = store.query("item", { $top: "3" }, {}, { offset: 3, pageSize: 1 });
  assert.equal(beyondTop.value.length, 0);
  assert.deepEqual(beyondTop.paging, { nextOffset: 3, moreRecords: false, totalCount: 4 });
});

test("public paged counts are capped at 5000 while internal unpaged counts remain full", async () => {
  const store = await makeStore(5005);
  const publicPage = store.query("item", { $count: "true" }, {}, { offset: 0, pageSize: 5000 });
  assert.equal(publicPage.value.length, 5000);
  assert.equal(publicPage["@odata.count"], 5000);
  assert.deepEqual(publicPage.paging, { nextOffset: 5000, moreRecords: true, totalCount: 5005 });
  const nextPage = store.query("item", { $count: "true" }, {}, { offset: 5000, pageSize: 5000 });
  assert.equal(nextPage.value.length, 5);
  assert.equal(nextPage["@odata.count"], 5000);
  assert.equal(nextPage.paging.moreRecords, false);
  const internal = store.query("item", { $count: "true" });
  assert.equal(internal.value.length, 5005);
  assert.equal(internal["@odata.count"], 5005);
});
