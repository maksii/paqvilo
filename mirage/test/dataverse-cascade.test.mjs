// Cascade actions (lib/dataverse-cascade.mjs): Assign executes per relationship; Share, Unshare, Reparent and Merge are
// diagnostics only. Invented x_ tables and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION } from "../lib/dataverse-cascade.mjs";
import { DataError } from "../lib/data-error.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";

const PARENT = "55555555-5555-4555-8555-555555555501";
const ACTIVE = "55555555-5555-4555-8555-555555555502";
const INACTIVE = "55555555-5555-4555-8555-555555555503";
const OTHER = "55555555-5555-4555-8555-555555555504";
const GRANDCHILD = "55555555-5555-4555-8555-555555555505";
const USER_ONE = "66666666-6666-4666-8666-666666666601";
const USER_TWO = "66666666-6666-4666-8666-666666666602";
const USER_THREE = "66666666-6666-4666-8666-666666666603";

const owner = (id) => ({ id, logical_name: "systemuser", name: "Invented user" });
const parentRef = { id: PARENT, logical_name: "x_parent", name: "Invented parent" };

// The parent and its children share one relationship cascade; withGrandchild adds a level below the active child.
function mappingsFor(cascade, { withGrandchild = false } = {}) {
  const link = { from: "x_parentid", to: "x_parentid", cascade };
  return {
    systemuser: {
      logicalName: "systemuser", entitySet: "systemusers", idColumn: "systemuserid", nameColumn: "fullname",
      fields: { fullname: { dataverseType: "nvarchar" } },
    },
    x_parent: {
      logicalName: "x_parent", entitySet: "x_parents", idColumn: "x_parentid", nameColumn: "x_name",
      relationships: { children: { entity: "x_child", many: true, ...link } },
      fields: { x_name: { dataverseType: "nvarchar" }, ownerid: { dataverseType: "owner" } },
    },
    x_child: {
      logicalName: "x_child", entitySet: "x_children", idColumn: "x_childid", nameColumn: "x_name",
      relationships: {
        parent: { entity: "x_parent", many: false, ...link },
        ...(withGrandchild ? { grandchildren: { entity: "x_grandchild", many: true, from: "x_childid", to: "x_childid", cascade } } : {}),
      },
      fields: { x_name: { dataverseType: "nvarchar" }, x_parentid: { dataverseType: "lookup" }, ownerid: { dataverseType: "owner" } },
    },
    ...(withGrandchild ? {
      x_grandchild: {
        logicalName: "x_grandchild", entitySet: "x_grandchildren", idColumn: "x_grandchildid", nameColumn: "x_name",
        fields: { x_name: { dataverseType: "nvarchar" }, x_childid: { dataverseType: "lookup" }, ownerid: { dataverseType: "owner" } },
      },
    } : {}),
  };
}

function tablesFor({ withGrandchild = false } = {}) {
  return {
    systemuser: [
      { systemuserid: USER_ONE, fullname: "Invented one", statecode: 0 },
      { systemuserid: USER_TWO, fullname: "Invented two", statecode: 0 },
      { systemuserid: USER_THREE, fullname: "Invented three", statecode: 0 },
    ],
    x_parent: [{ x_parentid: PARENT, x_name: "Invented parent", ownerid: owner(USER_ONE), statecode: 0, statuscode: 1 }],
    x_child: [
      { x_childid: ACTIVE, x_name: "Active child", x_parentid: parentRef, ownerid: owner(USER_ONE), statecode: 0, statuscode: 1 },
      { x_childid: INACTIVE, x_name: "Inactive child", x_parentid: parentRef, ownerid: owner(USER_ONE), statecode: 1, statuscode: 2 },
      { x_childid: OTHER, x_name: "Other child", x_parentid: parentRef, ownerid: owner(USER_THREE), statecode: 0, statuscode: 1 },
    ],
    ...(withGrandchild ? {
      x_grandchild: [{ x_grandchildid: GRANDCHILD, x_name: "Invented grandchild", x_childid: { id: ACTIVE, logical_name: "x_child", name: "Active child" }, ownerid: owner(USER_ONE), statecode: 0 }],
    } : {}),
  };
}

async function setup(t, cascade, { options = {}, extension = EXTENSION, withGrandchild = false } = {}) {
  const diagnostics = [];
  const fixture = await contractModuleFixture(t, {
    mappings: mappingsFor(cascade, { withGrandchild }),
    tables: tablesFor({ withGrandchild }),
    extension,
    options: { diagnostic: (entry) => diagnostics.push(entry), ...options },
  });
  return { ...fixture, diagnostics };
}

// Reassigns the parent through the Web API (records layer, so the write hooks run).
const reassign = (request, json, userId) => request("PATCH", `/x_parents(${PARENT})`, { "ownerid@odata.bind": `/systemusers(${userId})` }).then((response) => json(response, 200));
const ownerOf = (store, table, idColumn, id) => store.state.tables[table].find((row) => row[idColumn] === id)?.ownerid?.id ?? null;

const CASES = [
  ["Cascade", { assign: "Cascade" }, { [ACTIVE]: USER_TWO, [INACTIVE]: USER_TWO, [OTHER]: USER_TWO }],
  ["Active", { assign: "Active" }, { [ACTIVE]: USER_TWO, [INACTIVE]: USER_ONE, [OTHER]: USER_TWO }],
  ["UserOwned", { assign: "UserOwned" }, { [ACTIVE]: USER_TWO, [INACTIVE]: USER_TWO, [OTHER]: USER_THREE }],
  ["NoCascade", { assign: "NoCascade" }, { [ACTIVE]: USER_ONE, [INACTIVE]: USER_ONE, [OTHER]: USER_THREE }],
  ["RemoveLink", { assign: "RemoveLink" }, { [ACTIVE]: USER_ONE, [INACTIVE]: USER_ONE, [OTHER]: USER_THREE }],
];

for (const [name, cascade, expected] of CASES) {
  test(`Assign ${name}: reassigning the parent gives the children the new owner as the cascade allows`, async (t) => {
    const { request, json, store, diagnostics } = await setup(t, cascade);
    await reassign(request, json, USER_TWO);
    assert.equal(ownerOf(store, "x_parent", "x_parentid", PARENT), USER_TWO);
    for (const [child, owner] of Object.entries(expected)) assert.equal(ownerOf(store, "x_child", "x_childid", child), owner, `child ${child}`);
    assert.equal(diagnostics.filter((entry) => entry.code === "CASCADE_ASSIGN_DEFAULTED").length, 0);
  });
}

test("Assign Cascade reaches the grandchildren of the children it reassigns", async (t) => {
  const { request, json, store } = await setup(t, { assign: "Cascade" }, { withGrandchild: true });
  await reassign(request, json, USER_TWO);
  assert.equal(ownerOf(store, "x_grandchild", "x_grandchildid", GRANDCHILD), USER_TWO);
});

test("a write that does not change the owner runs no Assign cascade", async (t) => {
  const { request, json, store } = await setup(t, { assign: "Cascade" });
  await json(await request("PATCH", `/x_parents(${PARENT})`, { x_name: "Renamed parent" }), 200);
  assert.equal(ownerOf(store, "x_child", "x_childid", ACTIVE), USER_ONE);
  assert.equal(ownerOf(store, "x_child", "x_childid", OTHER), USER_THREE);
});

test("a failing afterWrite after the cascade, in the same transaction, rolls the cascaded children back", async (t) => {
  const failing = {
    ...EXTENSION,
    install: (api, options) => {
      EXTENSION.install(api, options);
      // Installed after the cascade, so it runs after it in the same write's transaction.
      api.recordHooks.add("afterWrite", (c, mapping) => {
        if (mapping.logicalName === "x_parent") throw new DataError("Invented refusal after the cascade.", 400, "InvalidRequest");
      });
    },
  };
  const { request, json, store } = await setup(t, { assign: "Cascade" }, { extension: failing });
  await json(await request("PATCH", `/x_parents(${PARENT})`, { "ownerid@odata.bind": `/systemusers(${USER_TWO})` }), 400);
  assert.equal(ownerOf(store, "x_parent", "x_parentid", PARENT), USER_ONE, "the parent keeps its owner");
  assert.equal(ownerOf(store, "x_child", "x_childid", ACTIVE), USER_ONE, "the active child is restored");
  assert.equal(ownerOf(store, "x_child", "x_childid", INACTIVE), USER_ONE, "the inactive child is restored");
});

test("a relationship without Assign metadata reports CASCADE_ASSIGN_DEFAULTED once and applies NoCascade", async (t) => {
  const { request, json, store, diagnostics } = await setup(t, undefined);
  await reassign(request, json, USER_TWO);
  await reassign(request, json, USER_THREE);
  const reported = diagnostics.filter((entry) => entry.code === "CASCADE_ASSIGN_DEFAULTED");
  assert.equal(reported.length, 1, "once per relationship, not per owner change");
  assert.equal(reported[0].table, "x_parent");
  assert.equal(reported[0].referencing, "x_child");
  assert.equal(ownerOf(store, "x_child", "x_childid", ACTIVE), USER_ONE);
});

test("Share, Reparent, Merge and Unshare declared by metadata report NOT_SIMULATED once per table and change nothing", async (t) => {
  const cascade = { assign: "NoCascade", share: "Cascade", unshare: "Active", reparent: "Cascade", merge: "Cascade" };
  const { request, json, store, diagnostics } = await setup(t, cascade);
  const sharesBefore = store.state.tables.principalobjectaccess?.length ?? 0;
  await reassign(request, json, USER_TWO);
  await reassign(request, json, USER_THREE);
  // The default extensions seed standard metadata that declares Share cascades too, so only this test table is counted.
  const codes = diagnostics.filter((entry) => entry.table === "x_parent").map((entry) => entry.code);
  for (const code of ["CASCADE_SHARE_NOT_SIMULATED", "CASCADE_UNSHARE_NOT_SIMULATED", "CASCADE_REPARENT_NOT_SIMULATED", "CASCADE_MERGE_NOT_SIMULATED"]) {
    assert.equal(codes.filter((item) => item === code).length, 1, `${code} once`);
  }
  assert.equal(store.state.tables.principalobjectaccess?.length ?? 0, sharesBefore, "no share row is granted");
});

test("a relationship without declared Share, Reparent, Merge or Unshare reports nothing for them", async (t) => {
  const { diagnostics } = await setup(t, { assign: "NoCascade", share: "NoCascade", merge: "NoCascade" });
  assert.equal(diagnostics.filter((entry) => entry.table === "x_parent" && /NOT_SIMULATED/.test(entry.code)).length, 0);
});

test("describe lists Assign at behaviour and the other cascades at contract, with the seams", () => {
  const record = EXTENSION.describe();
  assert.equal(record.name, "dataverse-cascade");
  assert.equal(record.level, "behaviour");
  assert.deepEqual(record.requires, ["metadata:relationship cascade"]);
  assert.equal(record.operationLevels.CascadeAssign, "behaviour");
  for (const operation of ["CascadeShare", "CascadeUnshare", "CascadeReparent", "CascadeMerge"]) {
    assert.equal(record.operationLevels[operation], "contract", operation);
    assert.ok(record.seams[operation], `${operation} names its seam`);
  }
  assert.ok(record.seams.CascadeShare.includes("grantAccess"));
  assert.ok(record.seams.CascadeMerge.includes("dataverse-record-messages.mjs"));
});

test("a PATCH that fails with 412 leaves no pre-image: a later write without beforeWrite reassigns no children", async (t) => {
  const { request, json, store } = await setup(t, { assign: "Cascade" });
  const stale = await request("PATCH", `/x_parents(${PARENT})`, { "ownerid@odata.bind": `/systemusers(${USER_TWO})` }, { "if-match": 'W/"999999"' });
  await json(stale, 412);
  // The owner changes outside the records pipeline (no hooks), then a property PUT runs afterWrite("update") alone.
  await store.transact(() => store.updateRecord("x_parent", PARENT, { ownerid: owner(USER_TWO) }, { admin: true }));
  assert.equal(ownerOf(store, "x_parent", "x_parentid", PARENT), USER_TWO);
  await json(await request("PUT", `/x_parents(${PARENT})/x_name`, { value: "Renamed after the failure" }), 204);
  assert.equal(ownerOf(store, "x_child", "x_childid", ACTIVE), USER_ONE);
  assert.equal(ownerOf(store, "x_child", "x_childid", INACTIVE), USER_ONE);
});

test("a caller without Assign on the child table: the cascade refuses and the parent write rolls back", async (t) => {
  const refusing = {
    ...EXTENSION,
    install: (api, options) => {
      const authorize = api.principals.authorize;
      api.principals.authorize = (request) => {
        if (request.entity === "x_child" && request.operation === "assign") throw new DataError("Invented: no Assign on x_child.", 403, "PrivilegeDenied", { innerCode: "0x80040220" });
        return authorize.call(api.principals, request);
      };
      t.after(() => { api.principals.authorize = authorize; });
      EXTENSION.install(api, options);
    },
  };
  const { request, json, store } = await setup(t, { assign: "Cascade" }, { extension: refusing });
  const refused = await json(await request("PATCH", `/x_parents(${PARENT})`, { "ownerid@odata.bind": `/systemusers(${USER_TWO})` }), 403);
  assert.equal(refused.error.code, "0x80040220");
  assert.equal(ownerOf(store, "x_parent", "x_parentid", PARENT), USER_ONE, "the parent keeps its owner");
  assert.equal(ownerOf(store, "x_child", "x_childid", ACTIVE), USER_ONE);
});
