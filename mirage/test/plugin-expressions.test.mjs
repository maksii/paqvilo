import test from "node:test";
import assert from "node:assert/strict";
import { DataStore } from "../lib/data.mjs";

const member = { contactId: "c1", roles: ["Member"] };
function store() {
  return new DataStore({ state: {
    mappings: {
      item: { entitySet: "items", idColumn: "itemid", relationships: {
        details: { entity: "detail", from: "itemid", to: "itemid", many: true },
        groups: { entity: "group", from: "itemid", to: "groupid", many: true,
          intersect: { entity: "edge", from: "itemid", to: "groupid" } },
      } },
      detail: { entitySet: "details", idColumn: "detailid" },
      group: { entitySet: "groups", idColumn: "groupid" },
      edge: { entitySet: "edges", idColumn: "edgeid" },
    },
    tables: {
      item: [{ itemid: "own", owner: "c1" }, { itemid: "foreign", owner: "c2" }],
      detail: [
        { detailid: "visible", itemid: "own", owner: "c1", name: "Visible" },
        { detailid: "hidden", itemid: "own", owner: "c2", name: "Hidden" },
        { detailid: "unrelated", itemid: "foreign", owner: "c1", name: "Unrelated" },
      ],
      group: [{ groupid: "visible", owner: "c1" }, { groupid: "hidden", owner: "c2" }],
      edge: [
        { edgeid: "e1", itemid: "own", groupid: "visible", secret: "Private edge" },
        { edgeid: "e2", itemid: "own", groupid: "hidden", secret: "Private edge" },
      ],
    },
    permissions: ["item", "detail", "group"].map(entity => ({
      entity, roles: ["Member"], operations: ["read"], scope: "contact", field: "owner",
    })),
    settings: { permissionMode: "enforce" },
  } });
}
const related = (data, parent, relationship, column, identity = member) =>
  data.evaluate({ op: "related", args: ["items", parent, relationship, ...(column ? [column] : [])] }, { identity });

test("related traverses declared direct relationships and trims targets by the caller's permissions", () => {
  const data = store();
  assert.deepEqual(related(data, "own", "details"), [data.snapshot().tables.detail[0]]);
  assert.deepEqual(related(data, "own", "details", "name"), ["Visible"]);
  assert.deepEqual(related(data, ["own"], "details", "name"), [{ parentId: "own", record: "Visible" }]);
  assert.deepEqual(related(data, "own", "details", "name", { admin: true }), ["Visible", "Hidden"]);
  assert.throws(() => related(data, "foreign", "details"), error => error.code === "PermissionDenied");
});

test("related uses mapped intersections without granting reads of their private rows", () => {
  const data = store(), before = data.snapshot();
  assert.deepEqual(related(data, "own", "groups", "groupid"), ["visible"]);
  assert.deepEqual(data.rows("edge", member), []);
  assert.throws(() => data.get("edge", "e1", member), error => error.code === "PermissionDenied");
  assert.throws(() => data.query("edge", {}, member), error => error.code === "PermissionDenied");
  assert.deepEqual(data.snapshot(), before, "relationship evaluation grants no permissions or mutates state");
});

test("related rejects unknown relationships even when matching lookup columns exist", () => {
  const data = store();
  for (const identity of [member, { admin: true }]) {
    assert.throws(() => related(data, "own", "detail", undefined, identity),
      error => error.code === "MissingRelationship" && error.status === 400);
  }
  delete data.state.mappings.item.relationships.details;
  assert.throws(() => related(data, "own", "details"), error => error.code === "MissingRelationship");
});
