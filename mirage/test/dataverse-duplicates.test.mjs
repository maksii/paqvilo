// Duplicate detection: seeded duplicate rule tables, the MSCRM.SuppressDuplicateDetection gate on create
// and update, the match operators, and the publish, unpublish and RetrieveDuplicates operations.
// Invented schema and GUIDs only; the registry and hooks are exercised through a fake api.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DataStore, emptyState } from "../lib/data.mjs";
import { DataError } from "../lib/data-error.mjs";
import { install } from "../lib/dataverse-duplicates.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const VERSION = "v9.2";
const ADMIN = { admin: true };
const GATE = { "mscrm.suppressduplicatedetection": "false" };
const DUPLICATE_MESSAGE = "A record was not created or updated because a duplicate of the current record already exists.";
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const text = { dataverseType: "nvarchar" };

function setup() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: "widget", entitySet: "widgets", idColumn: "widgetid", nameColumn: "name",
    fields: { name: text, code: text, statecode: { dataverseType: "int" } },
  };
  state.tables.widget = [];
  const store = new DataStore({ state });
  const ops = [];
  const hooks = {};
  install({ store, registry: { register: (op) => ops.push(op) }, recordHooks: { add: (name, fn) => (hooks[name] = fn) } });
  return {
    store, hooks, mapping: store.state.mappings.widget,
    op: (name) => ops.find((o) => o.name === name),
    rows: () => store.state.tables.widget,
    rules: () => store.state.tables.duplicaterule,
  };
}

// Adds a widget rule with conditions; published unless the test says otherwise.
function addRule(t, rule) {
  const id = randomUUID();
  const published = rule.published ?? true;
  t.rules().push({
    duplicateruleid: id, name: "rule", baseentityname: "widget", matchingentityname: "widget",
    excludeinactiverecords: rule.excludeInactive ?? false, iscasesensitive: rule.caseSensitive ?? false,
    statecode: published ? 1 : 0, statuscode: published ? 2 : 0,
  });
  for (const c of rule.conditions) {
    t.store.state.tables.duplicaterulecondition.push({
      duplicateruleconditionid: randomUUID(), regardingobjectid: id,
      baseattributename: c.base, matchingattributename: c.matching ?? c.base,
      operatorcode: c.op ?? "ExactMatch", operatorparam: c.param ?? null, ignoreblankvalues: c.ignoreBlank ?? false,
    });
  }
  return id;
}

const write = (t, operation, data, headers = GATE, existing) => t.hooks.beforeWrite({ headers }, t.mapping, { operation, data, existing });
const errorOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};
const target = (t, id) => ({ id, row: t.rules().find((r) => r.duplicateruleid === id) });

test("install seeds the duplicate rule tables as dataverseOnly and leaves a mapping it does not own", () => {
  const store = new DataStore({ state: emptyState() });
  store.state.mappings.duplicaterulecondition = { logicalName: "duplicaterulecondition", entitySet: "custom", idColumn: "custom_id", fields: {} };
  install({ store, registry: { register() {} }, recordHooks: { add() {} } });
  const rule = store.state.mappings.duplicaterule;
  assert.equal(rule.dataverseOnly, true);
  assert.equal(rule.userConfigured, true);
  assert.equal(rule.idColumn, "duplicateruleid");
  assert.deepEqual(store.state.tables.duplicaterule, []);
  assert.equal(store.state.mappings.duplicaterulecondition.entitySet, "custom");
  assert.equal(store.state.tables.duplicaterulecondition, undefined);
});

test("install registers the three operations and the beforeWrite hook", () => {
  const t = setup();
  assert.deepEqual(
    ["PublishDuplicateRule", "UnpublishDuplicateRule", "RetrieveDuplicates"].map((name) => {
      const op = t.op(name);
      return [op.name, op.kind, op.binding, op.entity];
    }),
    [
      ["PublishDuplicateRule", "action", "entity", "duplicaterule"],
      ["UnpublishDuplicateRule", "action", "entity", "duplicaterule"],
      ["RetrieveDuplicates", "function", "unbound", undefined],
    ],
  );
  assert.equal(typeof t.hooks.beforeWrite, "function");
});

test("a create or update is checked only when MSCRM.SuppressDuplicateDetection is false", () => {
  const t = setup();
  addRule(t, { conditions: [{ base: "code" }] });
  t.rows().push({ widgetid: ID(10), code: "A1", statecode: 0 }, { widgetid: ID(11), code: "B2", statecode: 0 });
  assert.equal(errorOf(() => write(t, "create", { code: "A1" }, {})), null);
  assert.equal(errorOf(() => write(t, "create", { code: "A1" }, { "mscrm.suppressduplicatedetection": "true" })), null);
  const error = errorOf(() => write(t, "create", { code: "A1" }, { "MSCRM.SuppressDuplicateDetection": "False" }));
  assert.ok(error instanceof DataError);
  assert.equal(error.status, 500);
  assert.equal(error.message, DUPLICATE_MESSAGE);
  assert.deepEqual(error.details, { innerCode: "0x80040333" });
  assert.ok(errorOf(() => write(t, "update", { code: "A1" }, GATE, t.rows()[1])) instanceof DataError);
  assert.equal(errorOf(() => write(t, "delete", {}, GATE, t.rows()[0])), null);
});

test("ExactMatch ignores case unless the rule is case-sensitive", () => {
  const loose = setup();
  addRule(loose, { conditions: [{ base: "code" }] });
  loose.rows().push({ widgetid: ID(10), code: "Abc", statecode: 0 });
  assert.ok(errorOf(() => write(loose, "create", { code: "ABC" })) instanceof DataError);

  const strict = setup();
  addRule(strict, { caseSensitive: true, conditions: [{ base: "code" }] });
  strict.rows().push({ widgetid: ID(10), code: "Abc", statecode: 0 });
  assert.equal(errorOf(() => write(strict, "create", { code: "ABC" })), null);
  assert.ok(errorOf(() => write(strict, "create", { code: "Abc" })) instanceof DataError);
});

test("SameFirst and SameLast compare N characters and never match a shorter value", () => {
  const first = setup();
  addRule(first, { conditions: [{ base: "name", op: "SameFirst", param: 3 }] });
  first.rows().push({ widgetid: ID(10), name: "Contoso Ltd", statecode: 0 }, { widgetid: ID(11), name: "Co", statecode: 0 });
  assert.ok(errorOf(() => write(first, "create", { name: "Conan" })) instanceof DataError);
  assert.equal(errorOf(() => write(first, "create", { name: "Cosmo" })), null);
  assert.equal(errorOf(() => write(first, "create", { name: "Col" })), null);

  const last = setup();
  addRule(last, { conditions: [{ base: "name", op: "SameLast", param: 3 }] });
  last.rows().push({ widgetid: ID(10), name: "Acme Ltd", statecode: 0 });
  assert.ok(errorOf(() => write(last, "create", { name: "Corp Ltd" })) instanceof DataError);
  assert.equal(errorOf(() => write(last, "create", { name: "Corp Inc" })), null);
});

test("operators outside the simulated three are rejected", () => {
  const t = setup();
  addRule(t, { conditions: [{ base: "code", op: 3 }] });
  t.rows().push({ widgetid: ID(10), code: "A1", statecode: 0 });
  const error = errorOf(() => write(t, "create", { code: "A1" }));
  assert.ok(error instanceof DataError);
  assert.equal(error.status, 400);
});

test("blank values never match in a single-condition rule and match only when blanks are not ignored", () => {
  const single = setup();
  addRule(single, { conditions: [{ base: "code" }] });
  single.rows().push({ widgetid: ID(10), code: "", statecode: 0 });
  assert.equal(errorOf(() => write(single, "create", { code: "" })), null);

  const lenient = setup();
  addRule(lenient, { conditions: [{ base: "name" }, { base: "code", ignoreBlank: false }] });
  lenient.rows().push({ widgetid: ID(10), name: "Acme", code: "", statecode: 0 });
  assert.ok(errorOf(() => write(lenient, "create", { name: "Acme" })) instanceof DataError);

  const strict = setup();
  addRule(strict, { conditions: [{ base: "name" }, { base: "code", ignoreBlank: true }] });
  strict.rows().push({ widgetid: ID(10), name: "Acme", code: "", statecode: 0 });
  assert.equal(errorOf(() => write(strict, "create", { name: "Acme" })), null);
});

test("excludeInactiveRecords skips inactive matching rows", () => {
  const excluding = setup();
  addRule(excluding, { excludeInactive: true, conditions: [{ base: "code" }] });
  excluding.rows().push({ widgetid: ID(10), code: "A1", statecode: 1 });
  assert.equal(errorOf(() => write(excluding, "create", { code: "A1" })), null);

  const including = setup();
  addRule(including, { conditions: [{ base: "code" }] });
  including.rows().push({ widgetid: ID(10), code: "A1", statecode: 1 });
  assert.ok(errorOf(() => write(including, "create", { code: "A1" })) instanceof DataError);
});

test("an update is not a duplicate of its own row", () => {
  const t = setup();
  addRule(t, { conditions: [{ base: "code" }] });
  const self = { widgetid: ID(10), code: "A1", statecode: 0 };
  t.rows().push(self, { widgetid: ID(11), code: "B2", statecode: 0 });
  assert.equal(errorOf(() => write(t, "update", { code: "A1" }, GATE, self)), null);
  assert.ok(errorOf(() => write(t, "update", { code: "A1" }, GATE, t.rows()[1])) instanceof DataError);
});

test("only published rules apply, and publishing is limited to five per table", async () => {
  const t = setup();
  const ids = Array.from({ length: 6 }, () => addRule(t, { published: false, conditions: [{ base: "code" }] }));
  t.rows().push({ widgetid: ID(10), code: "A1", statecode: 0 });
  assert.equal(errorOf(() => write(t, "create", { code: "A1" })), null);

  const publish = t.op("PublishDuplicateRule").handle;
  const unpublish = t.op("UnpublishDuplicateRule").handle;
  const statusOf = (id) => t.rules().find((r) => r.duplicateruleid === id).statuscode;

  for (const id of ids.slice(0, 5)) assert.equal((await publish({ target: target(t, id), identity: ADMIN })).status, 200);
  assert.equal(statusOf(ids[0]), 2);
  await assert.rejects(publish({ target: target(t, ids[5]), identity: ADMIN }), (e) => e instanceof DataError && e.status === 400);
  assert.equal(statusOf(ids[5]), 0);
  assert.ok(errorOf(() => write(t, "create", { code: "A1" }, GATE)) instanceof DataError);

  assert.equal((await unpublish({ target: target(t, ids[0]), identity: ADMIN })).status, 204);
  assert.equal(statusOf(ids[0]), 0);
  await publish({ target: target(t, ids[5]), identity: ADMIN });
  assert.equal(statusOf(ids[5]), 2);
});

test("RetrieveDuplicates returns matching rows except the record itself, paged by Count", async () => {
  const t = setup();
  addRule(t, { conditions: [{ base: "code" }] });
  t.rows().push(
    { widgetid: ID(10), code: "X", statecode: 0 },
    { widgetid: ID(20), code: "X", statecode: 0 },
    { widgetid: ID(30), code: "Y", statecode: 0 },
    { widgetid: ID(40), code: "X", statecode: 0 },
  );
  const retrieve = t.op("RetrieveDuplicates").handle;
  const business = { LogicalName: "widget", widgetid: ID(20), code: "X" };
  const all = await retrieve({ params: { BusinessEntity: business, MatchingEntityName: "widget" }, origin: ORIGIN, version: VERSION });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.value.map((r) => r.widgetid), [ID(10), ID(40)]);
  const second = await retrieve({ params: { BusinessEntity: business, MatchingEntityName: "widget", PagingInfo: { Count: 1, PageNumber: 2 } }, origin: ORIGIN, version: VERSION });
  assert.deepEqual(second.body.value.map((r) => r.widgetid), [ID(40)]);
});
