// The SDK IOrganizationService on the organization record pipeline: synchronous rule hooks run inline, an asynchronous
// hook remainder finishes after the synchronous call and reports SDK_DEFERRED_EFFECT on failure, and without an
// organization the service says it writes the store directly.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { createOrganizationRuntime } from "../lib/dataverse-organization.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { localOrganizationService } from "../lib/local-organization-service.mjs";

const USER = "77777777-7777-4777-8777-0000000000f1";
const profile = { userId: USER, evidence: "invented test grants", grants: [{ entity: "x_item", operations: ["create", "read", "update", "delete"] }] };
const mappings = { x_item: { logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
  fields: { x_name: { dataverseType: "nvarchar" }, statecode: { dataverseType: "state" }, statuscode: { dataverseType: "status" } } } };

async function storeWith(t, extensions = []) {
  const state = emptyState();
  Object.assign(state.mappings, structuredClone(mappings));
  state.tables.x_item = [];
  const store = await new DataStore({ state }).init();
  if (extensions) {
    const organization = await createOrganizationRuntime({ store, settings: dataverseSettings({ enabled: true }), extensions: [...EXTENSIONS, ...extensions] });
    t.after(() => organization.close());
  }
  return store;
}

test("an SDK write runs synchronous rule hooks inline and reports a failed asynchronous remainder as SDK_DEFERRED_EFFECT", async (t) => {
  const seen = [];
  let settle;
  const finished = new Promise((resolve) => { settle = resolve; });
  const invented = { name: "x-invented-hooks", describe: () => ({ name: "x-invented-hooks", level: "contract" }), reset() {},
    install(api) {
      api.recordHooks.add("beforeWrite", (c, mapping, { operation, data }) => {
        if (mapping.logicalName !== "x_item") return;
        seen.push(operation);
        if (data?.x_name === "refused") throw Object.assign(new Error("Invented rule refused the row."), { status: 400 });
      });
      api.recordHooks.add("afterWrite", async (c, mapping) => {
        if (mapping.logicalName !== "x_item") return;
        await null;
        settle();
        throw new Error("invented asynchronous side effect failed");
      });
    } };
  const store = await storeWith(t, [invented]);
  const diagnostics = [];
  const sdk = localOrganizationService(store, profile, undefined, { diagnostic: (note) => diagnostics.push(note) });
  assert.equal(sdk.profile.pipeline.level, "behaviour");
  assert.equal(sdk.profile.pipeline.asyncHookEffects, "contract");
  const row = sdk.create("x_item", { x_name: "kept" });
  assert.deepEqual(seen, ["create"], "the synchronous rule ran inside the call");
  assert.equal(row.statecode, 0, "state defaults");
  assert.equal(typeof row.versionnumber, "number", "row version");
  const system = store.tableRows("systemuser").find((user) => user.fullname === "SYSTEM");
  assert.equal(row.createdby?.id, system.systemuserid, "audit columns: SYSTEM when the profile user is not an organization user");
  assert.throws(() => sdk.create("x_item", { x_name: "refused" }), /Invented rule refused the row/);
  assert.equal(store.tableRows("x_item").filter((r) => r.x_name === "refused").length, 0, "a refusing rule rolls the call back");
  await finished;
  await new Promise((resolve) => setImmediate(resolve));
  const deferred = diagnostics.filter((note) => note.code === "SDK_DEFERRED_EFFECT");
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].entity, "x_item");
  assert.equal(deferred[0].operation, "create");
  assert.match(deferred[0].message, /invented asynchronous side effect failed/);
  assert.equal(store.tableRows("x_item").filter((r) => r.x_name === "kept").length, 1, "the write stands: the deferred effect never reports success or failure of the call");
});

test("without an organization the SDK service writes the store and says so in its description", async (t) => {
  const store = await storeWith(t, null);
  const sdk = localOrganizationService(store, profile);
  assert.equal(sdk.profile.pipeline.level, "inventory");
  const row = sdk.create("x_item", { x_name: "plain" });
  assert.equal(row.versionnumber, undefined, "no organization row version without an organization");
});

test("SDK Retrieve and RetrieveMultiple apply column security like the Web API read projection", async (t) => {
  const { readFixture, CUST } = await import("./read-projection-fixture.mjs");
  const ITEM = "77777777-7777-4777-8777-000000000001";
  const f = await readFixture(t, {
    mappings: { x_item: { logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name",
      fields: { x_name: { dataverseType: "nvarchar" }, x_secret: { dataverseType: "nvarchar", columnMetadata: { isSecured: true } } } } },
    tables: { x_item: [{ x_itemid: ITEM, x_name: "Invented", x_secret: "INVENTED-SECRET", statecode: 0, statuscode: 1 }] },
  });
  const web = await f.json(await f.request("GET", `/x_items(${ITEM})?$select=x_secret`, undefined, {}, CUST), 200);
  assert.equal(web.x_secret, null);
  const customizer = f.store.tableRows("systemuser").find((row) => String(row.applicationid ?? "").toLowerCase() === CUST);
  const sdk = localOrganizationService(f.store, { userId: customizer.systemuserid, evidence: "invented test grants", grants: [{ entity: "x_item", operations: ["read"] }] });
  assert.equal(sdk.get("x_item", ITEM).x_secret, null, "Retrieve");
  assert.equal(sdk.query("x_item", { $select: "x_name,x_secret" }).value[0].x_secret, null, "RetrieveMultiple");
  const fetched = sdk.fetch('<fetch><entity name="x_item"><attribute name="x_secret"/></entity></fetch>');
  assert.equal(fetched.entities[0].x_secret ?? null, null, "FetchXML");
});
