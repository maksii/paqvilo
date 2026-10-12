import test from "node:test";
import assert from "node:assert/strict";
import { migrateScenarioState, mergeAssetManifests } from "../lib/state-migration.mjs";

test("migration adds declared relationships without replacing existing mapping choices", () => {
  const existing = {
    entitySet: "local_items", idColumn: "localid", userConfigured: true,
    relationships: { owner: { entity: "contact", from: "localowner", to: "contactid" } },
  };
  const added = { entity: "group", from: "groupid", to: "groupid", many: false };
  const current = { mappings: { item: existing }, tables: {}, settings: { permissionMode: "enforce" } };
  const latest = { mappings: { item: {
    entitySet: "items", idColumn: "itemid",
    relationships: { owner: { entity: "contact", from: "ownerid", to: "contactid" }, group: added },
  }, group: { entitySet: "groups", idColumn: "groupid" } } };
  const before = structuredClone({ current, latest });
  const { state } = migrateScenarioState(current, { latest });
  assert.deepEqual(state.mappings.item, { ...existing, relationships: { ...existing.relationships, group: added } });
  assert.deepEqual(state.mappings.group, latest.mappings.group);
  assert.deepEqual({ current, latest }, before, "migration does not mutate its inputs");
});

test("migration refreshes conventional inferred entity sets but preserves authored names", () => {
  const cases = [
    [{ entitySet: "categorys", inferred: true }, "categories"],
    [{ entitySet: "custom_categories", inferred: true }, "custom_categories"],
    [{ entitySet: "categorys", inferred: false }, "categorys"],
    [{ entitySet: "categorys", inferred: true, userConfigured: true }, "categorys"],
    [{ entitySet: "categorys", inferred: true, entitySetInferred: false }, "categorys"],
  ];
  for (const [mapping, expected] of cases) {
    const current = { mappings: { category: { ...mapping, idColumn: "localid", nameColumn: "label" } } };
    const { state } = migrateScenarioState(current, { latest: {
      mappings: { category: { entitySet: "categories", idColumn: "categoryid", nameColumn: "name" } },
    } });
    assert.deepEqual(state.mappings.category, { ...current.mappings.category, entitySet: expected });
  }
});

test("migration updates unchanged configured grants while preserving local grants and exported trees", () => {
  const grant = { id: "read", entity: "item", scope: "global", operations: ["read"] };
  const edited = { ...grant, id: "edited", operations: ["read", "update"] };
  const latest = { permissions: [
    { ...grant, roles: ["Member"] },
    { ...grant, id: "edited", roles: ["Member"] },
    { ...grant, id: "new" },
  ] };
  const current = { permissions: [grant, edited, { ...grant, id: "local" }], simulator: { permissionSource: "configured" } };
  const legacy = { permissions: [grant, { ...grant, id: "edited" }] };
  const { state, report } = migrateScenarioState(current, { latest, legacy });
  assert.deepEqual(state.permissions, [latest.permissions[0], edited, current.permissions[2], latest.permissions[2]]);
  assert.deepEqual(report.preservedCustomPermissions, ["edited"]);
  const exported = {
    permissions: [{ ...grant, imported: true }, {
      id: "child", entity: "detail", scope: "parent", parentPermissionId: "read",
      imported: true, roles: ["Member"], relationshipName: "item_details",
    }],
    simulator: { permissionSource: "exported" },
  };
  assert.deepEqual(migrateScenarioState(exported, { latest, legacy }).state.permissions, exported.permissions);
});

test("three-way migration preserves local edits, new records and deletions while refreshing unchanged fields", () => {
  const legacy = { tables: { item: [
    { itemid: "a", name: "Old", count: 1, removedLocally: "old" },
    { itemid: "deleted", name: "Deleted locally" },
    { itemid: "retired", name: "No longer generated" },
  ] } };
  const current = {
    mappings: { item: { idColumn: "itemid", entitySet: "items" } },
    tables: { item: [
      { itemid: "a", name: "Local edit", count: 1, localField: "Keep" },
      legacy.tables.item[2], { itemid: "local", name: "Locally created" },
    ] },
    settings: { permissionMode: "enforce", customSetting: "keep" },
  };
  const latest = { tables: { item: [
    { itemid: "a", name: "New default", count: 2, removedLocally: "new", added: "new field" },
    { itemid: "deleted", name: "Still generated" },
    { itemid: "new", name: "Newly generated" },
  ] }, settings: { permissionMode: "permissive" } };
  const before = structuredClone({ current, legacy, latest });
  const { state, report } = migrateScenarioState(current, { latest, legacy });
  assert.deepEqual(state.tables.item, [
    { itemid: "a", name: "Local edit", count: 2, localField: "Keep", added: "new field" },
    legacy.tables.item[2], current.tables.item[2], latest.tables.item[2],
  ]);
  assert.deepEqual(state.settings, current.settings);
  assert.deepEqual(report.tables, [{ entity: "item", before: 3, after: 4, inserted: 1, updated: 1,
    preservedEdits: 2, preservedDeletions: 1, preservedFields: { name: 1, removedLocally: 1 } }]);
  assert.deepEqual({ current, legacy, latest }, before);
});

test("asset manifest migration retains custom paths and separate origins; baseline wins matching pairs", () => {
  const current = { version: 1, assets: [
    { origin: "https://one.example.test", path: "/shared.css", sha256: "old" },
    { origin: "https://two.example.test", path: "/shared.css", sha256: "other-origin" },
    { origin: "https://one.example.test", path: "/custom.css", sha256: "custom" },
  ] };
  const baseline = { version: 1, assets: [
    { origin: "https://one.example.test", path: "/shared.css", sha256: "fresh" },
    { origin: "https://one.example.test", path: "/new.css", sha256: "new" },
  ] };
  const before = structuredClone({ current, baseline });
  const merged = mergeAssetManifests(current, baseline);
  assert.deepEqual(merged.assets, [baseline.assets[0], current.assets[1], current.assets[2], baseline.assets[1]]);
  merged.assets[0].sha256 = "changed output";
  assert.deepEqual({ current, baseline }, before);
  assert.deepEqual(mergeAssetManifests(null, baseline), baseline);
  assert.throws(() => mergeAssetManifests({ version: 2, assets: [] }, baseline), /Invalid migration asset manifest/);
});
