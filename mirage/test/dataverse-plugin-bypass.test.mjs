import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";

const text = { dataverseType: "nvarchar" };

function fixture() {
  const state = emptyState();
  state.mappings.note = { logicalName: "note", entitySet: "notes", idColumn: "noteid", nameColumn: "text", fields: { text } };
  state.tables.note = [{ noteid: "a", text: "one" }];
  return new DataStore({ state });
}

// Plug-in bypass (MSCRM.BypassCustomPluginExecution): Dataverse writes set bypassCustomPlugins; portal writes never do.
test("bypassCustomPlugins skips exported plug-in phases; ordinary writes still run them", async () => {
  const store = fixture();
  let calls = 0;
  store.setPluginPipeline(() => { calls += 1; });
  await store.createRecord("note", { noteid: "b", text: "two" }, { admin: true }, { bypassCustomPlugins: true });
  assert.equal(calls, 0);
  await store.createRecord("note", { noteid: "c", text: "three" }, { admin: true }, {});
  assert.ok(calls > 0);
  assert.deepEqual(store.tableRows("note").map((row) => row.noteid), ["a", "b", "c"]);
});
