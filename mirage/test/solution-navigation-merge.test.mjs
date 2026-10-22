// A Solution relationship added after a configured mapping took its relationships from an earlier import still declares its
// navigation (the referencing attribute's schema name when the relationship names none), so an @odata.bind on it is not an
// undeclared property; a mapping that declares its own relationships keeps them. Invented x_ schema only.
import test from "node:test";
import assert from "node:assert/strict";
import { applySolutionData } from "../lib/solution-data.mjs";
import { DataStore } from "../lib/data.mjs";

const ITEM = "77777777-7777-4777-8777-000000000001";
const rel = (from, schemaName) => ({ entity: "x_item", from, to: "x_itemid", many: false, schemaName, type: "many-to-one" });
const metadataWith = (relationships) => ({ diagnostics: [], mappings: {
  x_item: { entitySet: "x_items", idColumn: "x_itemid", relationships: {} },
  x_child: { entitySet: "x_children", idColumn: "x_childid", relationships },
  x_own: { entitySet: "x_owns", idColumn: "x_ownid", relationships },
} });

test("a re-import gives a configured mapping the Solution navigations added since; declared relationships stay", () => {
  const state = { mappings: {
    x_item: { entitySet: "x_items", idColumn: "x_itemid", userConfigured: true },
    x_child: { entitySet: "x_children", idColumn: "x_childid", userConfigured: true },
    x_own: { entitySet: "x_owns", idColumn: "x_ownid", userConfigured: true, relationships: {} },
  }, tables: {} };
  const first = applySolutionData(state, metadataWith({ x_parentid: rel("x_parentid", "x_item_children") })) ?? state;
  const second = applySolutionData(first, metadataWith({ x_parentid: rel("x_parentid", "x_item_children"), x_otherparentid: rel("x_otherparentid", "x_item_otherchildren") })) ?? first;
  assert.deepEqual(Object.keys(second.mappings.x_child.relationships).sort(), ["x_otherparentid", "x_parentid"]);
  assert.deepEqual(second.mappings.x_own.relationships, {});
  const store = new DataStore({ state: { ...second, tables: { x_item: [{ x_itemid: ITEM }], x_child: [] } } });
  const mapping = store.resolveMapping("x_child");
  assert.equal(store.normalizeRecord(mapping, { "x_otherparentid@odata.bind": `/x_items(${ITEM})` }).x_otherparentid.id, ITEM);
  assert.throws(() => store.normalizeRecord(mapping, { "x_OtherParentId@odata.bind": `/x_items(${ITEM})` }),
    (error) => error.status === 400 && error.details?.innerCode === "0x80048d19");
});
