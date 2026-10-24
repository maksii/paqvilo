// The additive systemColumns store option used by the Dataverse layer: merged after coercion,
// on create and update, and absent from every write that does not pass it.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";

const USER = { id: "aaaaaaaa-0000-4000-8000-000000000001", logical_name: "systemuser", name: "Audit User" };
const IDENTITY = { admin: true };

async function store() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid",
    // owninguser is declared as text so a merged lookup object proves it bypassed coercion.
    fields: { name: { dataverseType: "nvarchar" }, owninguser: { dataverseType: "nvarchar" } },
  };
  state.tables.widget = [];
  return new DataStore({ state }).init();
}

test("createRecord without systemColumns writes only the payload and defaults", async () => {
  const s = await store();
  const row = await s.create("widget", { name: "plain" }, IDENTITY, { coerce: true });
  assert.ok(!("createdby" in row));
  assert.ok(!("owninguser" in row));
});

test("createRecord merges systemColumns after coercion", async () => {
  const s = await store();
  const row = await s.create("widget", { name: "owned" }, IDENTITY, { coerce: true, systemColumns: { createdby: USER, owninguser: USER } });
  assert.deepEqual(row.createdby, USER);
  assert.deepEqual(row.owninguser, USER, "merged lookup object survives the text coercion of the declared column");
  const text = await s.create("widget", { name: "typed", owninguser: "text" }, IDENTITY, { coerce: true });
  assert.equal(text.owninguser, "text");
});

test("updateRecord merges systemColumns through touchRow and leaves other writes alone", async () => {
  const s = await store();
  const row = await s.create("widget", { name: "first" }, IDENTITY, { coerce: true });
  const updated = await s.update("widget", row.widgetid, { name: "second" }, IDENTITY, { coerce: true, systemColumns: { modifiedby: USER } });
  assert.equal(updated.name, "second");
  assert.deepEqual(updated.modifiedby, USER);
  const again = await s.update("widget", row.widgetid, { name: "third" }, IDENTITY, { coerce: true });
  assert.deepEqual(again.modifiedby, USER, "an update without the option keeps the stored column");
});

// A one-to-many relationship: widget.gadgets, gadget.widgetref references the parent.
async function linkedStore(cascade = {}) {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid",
    fields: { name: { dataverseType: "nvarchar" } },
    relationships: { gadgets: { entity: "gadget", from: "widgetid", to: "widgetref", many: true, cascade } },
  };
  state.mappings.gadget = { logicalName: "gadget", entitySet: "gadgets", idColumn: "gadgetid", fields: { name: { dataverseType: "nvarchar" } } };
  state.tables.widget = [];
  state.tables.gadget = [];
  return new DataStore({ state }).init();
}

test("a function systemColumns is evaluated per row with that row's mapping", async () => {
  const s = await linkedStore();
  const seen = [];
  const columns = (mapping) => {
    seen.push(mapping.logicalName);
    return { modifiedby: { ...USER, name: mapping.logicalName } };
  };
  const parent = await s.create("widget", { name: "parent", gadgets: [{ name: "child" }] }, IDENTITY, { coerce: true, systemColumns: columns });
  assert.deepEqual(seen.sort(), ["gadget", "widget"]);
  assert.equal(parent.modifiedby.name, "widget");
  assert.equal(s.state.tables.gadget[0].modifiedby.name, "gadget", "the deep-inserted child gets its own mapping's columns");
  const updated = await s.update("widget", parent.widgetid, { name: "again" }, IDENTITY, { coerce: true, systemColumns: columns });
  assert.equal(updated.modifiedby.name, "widget");
  assert.equal(seen.at(-1), "widget");
});

test("a RemoveLink cascade stamps the child with systemColumns and stays inert without them", async () => {
  const s = await linkedStore({ delete: "RemoveLink" });
  const parent = await s.create("widget", { name: "parent" }, IDENTITY, { coerce: true });
  await s.create("gadget", { name: "linked", widgetref: parent.widgetid }, IDENTITY, { coerce: true });
  await s.remove("widget", parent.widgetid, IDENTITY, { systemColumns: { modifiedby: USER } });
  const [child] = s.state.tables.gadget;
  assert.equal(child.widgetref, null, "the lookup is cleared");
  assert.deepEqual(child.modifiedby, USER, "the caller is stamped as modifiedby");

  const plain = await linkedStore({ delete: "RemoveLink" });
  const other = await plain.create("widget", { name: "other" }, IDENTITY, { coerce: true });
  await plain.create("gadget", { name: "untouched", widgetref: other.widgetid }, IDENTITY, { coerce: true });
  await plain.remove("widget", other.widgetid, IDENTITY, {});
  assert.ok(!("modifiedby" in plain.state.tables.gadget[0]), "no option, no stamp");
});

test("an association through a one-to-many navigation stamps the referencing row", async () => {
  const s = await linkedStore();
  const parent = await s.create("widget", { name: "parent" }, IDENTITY, { coerce: true });
  const child = await s.create("gadget", { name: "child" }, IDENTITY, { coerce: true });
  await s.associate("widget", parent.widgetid, "gadgets", child.gadgetid, IDENTITY, { systemColumns: { modifiedby: USER } });
  assert.equal(s.state.tables.gadget[0].widgetref, parent.widgetid);
  assert.deepEqual(s.state.tables.gadget[0].modifiedby, USER);

  const plain = await linkedStore();
  const p2 = await plain.create("widget", { name: "p2" }, IDENTITY, { coerce: true });
  const c2 = await plain.create("gadget", { name: "c2" }, IDENTITY, { coerce: true });
  await plain.associate("widget", p2.widgetid, "gadgets", c2.gadgetid, IDENTITY);
  assert.equal(plain.state.tables.gadget[0].widgetref, p2.widgetid);
  assert.ok(!("modifiedby" in plain.state.tables.gadget[0]), "no option, no stamp");
});
