// Performance regression: parent-scope table permissions through a
// many-to-many (intersect) relationship must evaluate by key lookups, not by
// scanning parents x intersect rows for every child. Shapes follow ExampleApp's
// exported change-request grant (change request -> sample_changerequest_product
// -> product -> customer account -> parent account -> application user role).
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore } from "../lib/data.mjs";

const SIZE = 6000;
const BOUND_MS = 5000;
const id = (prefix, n) => `${prefix}-${String(n).padStart(6, "0")}`;

function scaleState() {
  const tables = {
    account: [],
    role: [],
    product: [],
    change: [],
    change_product: [],
  };
  for (let n = 0; n < 60; n++) {
    tables.account.push({ accountid: id("org", n), name: `Org ${n}`, parentaccountid: n < 30 ? null : { id: id("org", n - 30), logical_name: "account" } });
    if (n < 30) tables.role.push({ roleid: id("role", n), userid: n % 10 === 0 ? "me" : `user-${n}`, organisationid: { id: id("org", n), logical_name: "account" } });
  }
  for (let n = 0; n < SIZE; n++) {
    tables.product.push({ productid: id("p", n), customerid: { id: id("org", 30 + (n % 30)), logical_name: "account" } });
    tables.change.push({ changeid: id("c", n), name: `Change ${n}` });
    tables.change_product.push({ change_productid: id("cp", n), changeid: id("c", n), productid: id("p", (n * 7) % SIZE) });
  }
  return {
    mappings: {
      account: { entitySet: "accounts", idColumn: "accountid" },
      role: { entitySet: "roles", idColumn: "roleid" },
      product: { entitySet: "products", idColumn: "productid" },
      change: { entitySet: "changes", idColumn: "changeid" },
      change_product: { entitySet: "change_products", idColumn: "change_productid" },
    },
    tables,
    permissions: [
      { id: "roles", entity: "role", scope: "contact", field: "userid", roles: ["Manager"], operations: ["read"] },
      { id: "orgs", entity: "account", scope: "parent", parentPermissionId: "roles", relationship: { entity: "role", from: "accountid", to: "organisationid" }, roles: ["Manager"], operations: ["read"] },
      { id: "child-orgs", entity: "account", scope: "parent", parentPermissionId: "orgs", relationship: { entity: "account", from: "parentaccountid", to: "accountid" }, roles: ["Manager"], operations: ["read"] },
      { id: "products", entity: "product", scope: "parent", parentPermissionId: "child-orgs", relationship: { entity: "account", from: "customerid", to: "accountid" }, roles: ["Manager"], operations: ["read"] },
      {
        id: "changes",
        entity: "change",
        scope: "parent",
        parentPermissionId: "products",
        relationship: { entity: "product", from: "changeid", to: "productid", intersect: { entity: "change_product", from: "changeid", to: "productid" } },
        roles: ["Manager"],
        operations: ["read"],
      },
    ],
    settings: { permissionMode: "enforce" },
  };
}

test(`parent-scope grants through an intersect table evaluate ${SIZE} rows within ${BOUND_MS} ms`, async () => {
  const store = await new DataStore({ state: scaleState() }).init();
  const identity = { id: "me", contactId: "me", roles: ["Manager"] };
  const started = performance.now();
  const visible = store.rows("change", identity);
  const rowsMs = performance.now() - started;
  // Roles for users "me" exist on organisations 0, 10 and 20; products belong
  // to the child organisations 30, 40 and 50, so 3 of every 30 products and
  // the changes linked to them are visible.
  const expected = scaleState().tables.change_product.filter((edge) => {
    const product = Number(edge.productid.slice(2));
    return [0, 10, 20].includes(product % 30);
  }).length;
  assert.equal(visible.length, expected);
  assert.ok(rowsMs < BOUND_MS, `rows() took ${Math.round(rowsMs)} ms`);
  const fetchStarted = performance.now();
  const fetched = store.fetchXml('<fetch returntotalrecordcount="true"><entity name="change"><attribute name="name"/></entity></fetch>', identity);
  assert.equal(fetched.total_record_count, Math.min(expected, 5000));
  const queried = store.query("change", { $select: "name", $count: "true" }, identity);
  assert.equal(queried["@odata.count"], expected);
  const readMs = performance.now() - fetchStarted;
  assert.ok(readMs < BOUND_MS, `FetchXML and OData reads took ${Math.round(readMs)} ms`);
  // Single-record checks (writes, Liquid entities[...] lookups) stay fast too.
  const single = performance.now();
  for (const row of store.state.tables.change.slice(0, 200)) store.allowed("change", "read", row, identity);
  assert.ok(performance.now() - single < BOUND_MS, "single-row checks build only per-call indexes");
});
