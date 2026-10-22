// Record hierarchy (lib/dataverse-hierarchy.mjs): the four directions, the depth bound, the cycle guard, both lookup shapes,
// the metadata and explicit hierarchy sources, install diagnostics and describe. Invented x_ schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION, resolveHierarchy, validateHierarchies } from "../lib/dataverse-hierarchy.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";

// Invented tree, levels 1 to 4:  ROOT -> B, E;  B -> C;  E -> F;  C -> D.
// The loop is injected through the root's lookup: ROOT's parent is D, so ROOT -> D -> C -> B -> ROOT.
const id = (n) => `10000000-0000-4000-8000-00000000000${n}`;
const ROOT = id(1);
const B = id(2);
const E = id(3);
const C = id(4);
const F = id(5);
const D = id(6);
const PLAIN_ROOT = id(7);
const PLAIN_CHILD = id(8);
const MISSING = id(9);
const sorted = (ids) => [...ids].sort();

const mappings = {
  x_node: {
    logicalName: "x_node", entitySet: "x_nodes", idColumn: "x_nodeid", nameColumn: "x_name",
    relationships: { x_parentid: { entity: "x_node", from: "x_parentid", to: "x_nodeid", many: false, hierarchical: true } },
    fields: { x_name: { dataverseType: "nvarchar" }, x_parentid: { dataverseType: "uniqueidentifier" } },
  },
  // Self-lookup without the IsHierarchical flag: not a hierarchy.
  x_plain: {
    logicalName: "x_plain", entitySet: "x_plains", idColumn: "x_plainid", nameColumn: "x_name",
    relationships: { x_parentid: { entity: "x_plain", from: "x_parentid", to: "x_plainid", many: false } },
    fields: { x_name: { dataverseType: "nvarchar" }, x_parentid: { dataverseType: "uniqueidentifier" } },
  },
};
const tables = {
  x_node: [
    { x_nodeid: ROOT, x_name: "Invented root", x_parentid: D, statecode: 0 },
    { x_nodeid: B, x_name: "Invented branch", x_parentid: { id: ROOT, logical_name: "x_node", name: "Invented root" }, statecode: 0 },
    { x_nodeid: E, x_name: "Invented second branch", x_parentid: ROOT.toUpperCase(), statecode: 0 },
    { x_nodeid: C, x_name: "Invented leaf parent", x_parentid: B, statecode: 0 },
    { x_nodeid: F, x_name: "Invented second leaf", x_parentid: { id: E }, statecode: 0 },
    { x_nodeid: D, x_name: "Invented deepest", x_parentid: C, statecode: 0 },
  ],
  x_plain: [
    { x_plainid: PLAIN_ROOT, x_name: "Invented plain root", x_parentid: null, statecode: 0 },
    { x_plainid: PLAIN_CHILD, x_name: "Invented plain child", x_parentid: PLAIN_ROOT, statecode: 0 },
  ],
};

// The fixture returns the HTTP handle; the internal api that the module installs on is captured through a wrapper of install.
async function setup(t, options = {}) {
  const diagnostics = [];
  const captured = {};
  const extension = { ...EXTENSION, install: (api, opts) => { captured.api = api; return EXTENSION.install(api, opts); } };
  const fixture = await contractModuleFixture(t, {
    mappings, tables, extension,
    options: { diagnostic: (entry) => diagnostics.push(entry), ...options },
  });
  return { ...fixture, api: captured.api, diagnostics };
}

test("validateHierarchies normalises a valid explicit map and rejects bad entries", () => {
  assert.deepEqual(validateHierarchies(undefined), {});
  assert.deepEqual(validateHierarchies({ X_Plain: "X_ParentId" }), { x_plain: "x_parentid" });
  assert.throws(() => validateHierarchies([]), TypeError);
  assert.throws(() => validateHierarchies({ x_plain: "x parent" }), TypeError);
  assert.throws(() => validateHierarchies({ "1bad": "x_parentid" }), TypeError);
  assert.throws(() => validateHierarchies({ x_plain: 7 }), TypeError);
});

test("under and eq-or-under walk the descendants of a root across a cycle, each record once", async (t) => {
  const { api } = await setup(t);
  assert.deepEqual(sorted(api.hierarchy.resolve("x_node", ROOT, "under")), sorted([B, E, C, F, D]));
  assert.deepEqual(sorted(api.hierarchy.resolve("x_node", ROOT, "eq-or-under")), sorted([ROOT, B, E, C, F, D]));
  assert.deepEqual(sorted(api.hierarchy.resolve("x_node", F, "under")), []);
  assert.deepEqual(sorted(api.hierarchy.resolve("x_node", F, "eq-or-under")), [F]);
});

test("above and eq-or-above walk the ancestors of a record, stopping at the cycle", async (t) => {
  const { api } = await setup(t);
  assert.deepEqual(sorted(api.hierarchy.resolve("x_node", D, "above")), sorted([C, B, ROOT]));
  assert.deepEqual(sorted(api.hierarchy.resolve("x_node", D, "eq-or-above")), sorted([D, C, B, ROOT]));
  assert.deepEqual(sorted(api.hierarchy.resolve("x_node", F, "above")), sorted([E, ROOT, D, C, B]));
});

test("a root that is not a row yields an empty set", async (t) => {
  const { api } = await setup(t);
  assert.deepEqual(sorted(api.hierarchy.resolve("x_node", MISSING, "under")), []);
  assert.deepEqual(sorted(api.hierarchy.resolve("x_node", MISSING, "eq-or-above")), []);
});

test("the depth bound stops the walk once, reports HIERARCHY_DEPTH_EXCEEDED once and never throws", async (t) => {
  const { store, diagnostics } = await setup(t);
  const found = resolveHierarchy(store, "x_node", "x_parentid", ROOT, "under", { maxDepth: 2, diagnostic: (entry) => diagnostics.push(entry) });
  assert.deepEqual(sorted(found), sorted([B, E, C, F]));
  assert.equal(diagnostics.filter((entry) => entry.code === "HIERARCHY_DEPTH_EXCEEDED").length, 1);
  assert.equal(diagnostics.find((entry) => entry.code === "HIERARCHY_DEPTH_EXCEEDED").maxDepth, 2);
});

test("the cycle guard reports HIERARCHY_CYCLE for a loop that reaches the root", async (t) => {
  const { store, diagnostics } = await setup(t);
  resolveHierarchy(store, "x_node", "x_parentid", ROOT, "under", { diagnostic: (entry) => diagnostics.push(entry) });
  assert.equal(diagnostics.filter((entry) => entry.code === "HIERARCHY_CYCLE").length, 1);
});

test("object and bare-GUID lookups resolve to the same records", () => {
  const fake = (lookup) => ({
    state: { mappings: { x_node: { idColumn: "x_nodeid" } } },
    tableRows: () => [{ x_nodeid: ROOT }, { x_nodeid: B, x_parentid: lookup(ROOT) }, { x_nodeid: C, x_parentid: lookup(B) }],
  });
  const bare = resolveHierarchy(fake((value) => value), "x_node", "x_parentid", ROOT, "eq-or-under");
  const objects = resolveHierarchy(fake((value) => ({ id: value, logical_name: "x_node", name: "Invented" })), "x_node", "x_parentid", ROOT, "eq-or-under");
  assert.deepEqual(sorted(bare), sorted([ROOT, B, C]));
  assert.deepEqual(sorted(objects), sorted(bare));
});

test("a table is hierarchical only through a self-referencing IsHierarchical relationship", async (t) => {
  const { api, diagnostics } = await setup(t);
  assert.deepEqual(api.hierarchy.isHierarchical("x_node"), { column: "x_parentid" });
  assert.equal(api.hierarchy.isHierarchical("x_plain"), null);
  assert.equal(api.hierarchy.isHierarchical("x_unknown"), null);
  assert.equal(api.hierarchy.resolve("x_plain", PLAIN_ROOT, "under"), null);
  assert.equal(api.hierarchy.resolve("x_node", ROOT, "under").size, 5);
  assert.equal(diagnostics.filter((entry) => entry.code === "HIERARCHY_NOT_QUERYABLE").length, 0);
});

test("an explicit hierarchies map makes a flagless self-lookup hierarchical", async (t) => {
  const { api } = await setup(t, { hierarchies: { x_plain: "x_parentid" } });
  assert.deepEqual(api.hierarchy.isHierarchical("x_plain"), { column: "x_parentid" });
  assert.deepEqual(sorted(api.hierarchy.resolve("x_plain", PLAIN_ROOT, "under")), [PLAIN_CHILD]);
  assert.deepEqual(sorted(api.hierarchy.resolve("x_plain", PLAIN_CHILD, "above")), [PLAIN_ROOT]);
});

test("install reports no HIERARCHY_NOT_QUERYABLE diagnostic; the query operators are wired by the runtime", async (t) => {
  const { diagnostics } = await setup(t, { hierarchies: { x_plain: "x_parentid" } });
  assert.equal(diagnostics.filter((entry) => entry.code === "HIERARCHY_NOT_QUERYABLE").length, 0);
});

test("an unknown direction is a programming error, not a data answer", () => {
  const store = { state: { mappings: {} }, tableRows: () => [] };
  assert.throws(() => resolveHierarchy(store, "x_node", "x_parentid", ROOT, "sideways"), TypeError);
});

test("describe lists the resolver directions at behaviour and the query operators at contract", () => {
  const record = EXTENSION.describe();
  assert.equal(record.name, "dataverse-hierarchy");
  const level = (name) => record.operations.find((operation) => operation.name === name)?.level;
  for (const name of ["resolve:under", "resolve:eq-or-under", "resolve:above", "resolve:eq-or-above"]) assert.equal(level(name), "behaviour");
  for (const name of ["query:under", "query:eq-or-under", "query:above", "query:eq-or-above", "query:not-under"]) assert.equal(level(name), "contract");
});
