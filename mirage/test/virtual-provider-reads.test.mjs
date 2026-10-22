// Virtual table reads (Task 28): collection and single Web API reads call the provider's retrieveMultiple/retrieve with the
// documented request shape and answer through the shared read path; a providerless virtual table answers 501 unless it
// declares fallback 'local'. Invented x_ schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION } from "../lib/dataverse-virtual-providers.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";
import { localOrganizationService } from "../lib/local-organization-service.mjs";

const A = "77777777-7777-4777-8777-777777777771";
const B = "77777777-7777-4777-8777-777777777772";
const mappings = {
  x_ext: { logicalName: "x_ext", entitySet: "x_exts", idColumn: "x_extid", nameColumn: "x_name", isVirtual: true,
    fields: { x_name: { dataverseType: "nvarchar" }, x_value: { dataverseType: "int" } } },
  x_bare: { logicalName: "x_bare", entitySet: "x_bares", idColumn: "x_bareid", nameColumn: "x_name", isVirtual: true, fields: { x_name: { dataverseType: "nvarchar" } } },
  x_kept: { logicalName: "x_kept", entitySet: "x_kepts", idColumn: "x_keptid", nameColumn: "x_name", isVirtual: true, fields: { x_name: { dataverseType: "nvarchar" } } },
  x_sync: { logicalName: "x_sync", entitySet: "x_syncs", idColumn: "x_syncid", nameColumn: "x_name", isVirtual: true, fields: { x_name: { dataverseType: "nvarchar" } } },
};

async function setup(t) {
  const calls = [];
  const rows = [{ x_extid: A, x_name: "Alpha", x_value: 1 }, { x_extid: B, x_name: "Beta", x_value: 5 }];
  const provider = {
    retrieveMultiple: async (request, ctx) => { calls.push(["retrieveMultiple", request, ctx.operation]); return rows; },
    retrieve: async (id) => { calls.push(["retrieve", id]); return rows.find((row) => row.x_extid === id) ?? null; },
  };
  // A provider with the optional synchronous reads the SDK uses (Learn custom-ve-data-providers: Retrieve and RetrieveMultiple
  // are served by the provider).
  const syncRows = [{ x_syncid: A, x_name: "Sync alpha" }];
  const syncProvider = {
    retrieveSync: (ctx, id) => { calls.push(["retrieveSync", id, ctx.operation]); return syncRows.find((row) => row.x_syncid === id) ?? null; },
    retrieveMultipleSync: (ctx, request) => { calls.push(["retrieveMultipleSync", request, ctx.operation]); return syncRows; },
  };
  const diagnostics = [];
  let api = null;
  const extension = { ...EXTENSION, install: (target, options) => { api = target; return EXTENSION.install(target, options); } };
  // Stale local mirror rows: an SDK read must never answer them.
  const stale = (id) => [{ [id]: B, x_name: "stale local row" }];
  const fixture = await contractModuleFixture(t, { mappings, tables: { x_ext: stale("x_extid"), x_bare: stale("x_bareid"), x_kept: [], x_sync: stale("x_syncid") }, extension,
    options: { virtualTableProviders: { x_ext: provider, x_sync: syncProvider }, virtualTables: { x_kept: { fallback: "local" } }, diagnostic: (entry) => diagnostics.push(entry) } });
  return { ...fixture, api, calls, rows, syncRows, diagnostics };
}

const SDK_USER = "77777777-7777-4777-8777-777777777790";
const sdkOf = (store) => localOrganizationService(store, { userId: SDK_USER, evidence: "invented test grant",
  grants: ["x_ext", "x_bare", "x_kept", "x_sync"].map((entity) => ({ entity, operations: ["read", "create"] })) });
const refusal = (status, code) => (error) => error.status === status && error.code === code;
const fetchOf = (table) => `<fetch><entity name="${table}"><attribute name="x_name"/></entity></fetch>`;

test("a collection read asks retrieveMultiple with the request shape and answers its rows through $filter, $select and $top", async (t) => {
  const { request, json, calls } = await setup(t);
  const body = await json(await request("GET", "/x_exts?$select=x_name&$filter=x_value gt 2&$orderby=x_name desc&$top=1"), 200);
  assert.deepEqual(calls[0], ["retrieveMultiple", { select: "x_name", filter: "x_value gt 2", orderby: "x_name desc", top: 1 }, "retrieveMultiple"]);
  assert.equal(body.value.length, 1);
  assert.equal(body.value[0].x_name, "Beta");
  assert.equal(body.value[0].x_value, undefined, "$select projects the provider row");
});

test("a single read calls retrieve; a row the provider no longer has answers 404", async (t) => {
  const { request, json, calls, rows } = await setup(t);
  const one = await json(await request("GET", `/x_exts(${A})?$select=x_name`), 200);
  assert.equal(one.x_name, "Alpha");
  assert.deepEqual(calls.at(-1), ["retrieve", A]);
  rows[0].x_name = "Alpha changed";
  assert.equal((await json(await request("GET", `/x_exts(${A})/x_name`), 200)).value, "Alpha changed", "the property read asks the provider too");
  rows.splice(0, 1);
  await json(await request("GET", `/x_exts(${A})`), 404);
});

test("a virtual table without a provider answers 501 VirtualProviderMissing on reads and writes", async (t) => {
  const { request, json, diagnostics } = await setup(t);
  const read = await json(await request("GET", "/x_bares"), 501);
  assert.match(read.error.message, /no data provider/);
  await json(await request("GET", `/x_bares(${A})`), 501);
  await json(await request("POST", "/x_bares", { x_name: "Refused" }), 501);
  const missing = diagnostics.filter((entry) => entry.code === "VIRTUAL_PROVIDER_MISSING");
  assert.deepEqual(missing.map((entry) => [entry.table, entry.severity]), [["x_bare", "error"]]);
});

test("a declared fallback 'local' stores and reads rows locally and the capability record says so", async (t) => {
  const { request, json, api, diagnostics } = await setup(t);
  const created = await json(await request("POST", "/x_kepts", { x_name: "Local" }), 201);
  const listed = await json(await request("GET", "/x_kepts"), 200);
  assert.deepEqual(listed.value.map((row) => row.x_keptid), [created.x_keptid]);
  assert.equal(diagnostics.filter((entry) => entry.code === "VIRTUAL_PROVIDER_LOCAL_FALLBACK").length, 1);
  const record = EXTENSION.describe(api);
  const level = (name) => record.operations.find((operation) => operation.name === name);
  assert.equal(level("Retrieve").level, "behaviour");
  assert.equal(level("RetrieveMultiple").level, "behaviour");
  assert.equal(level("Create").level, "contract", "the registered provider has no create");
  assert.match(level("LocalFallback").reason, /x_kept/);
});

test("SDK reads and writes of a providerless virtual table answer 501 VirtualProviderMissing and never the local mirror", async (t) => {
  const { store } = await setup(t);
  const sdk = sdkOf(store);
  const missing = refusal(501, "VirtualProviderMissing");
  assert.throws(() => sdk.get("x_bare", B), missing);
  assert.throws(() => sdk.query("x_bare", {}), missing);
  assert.throws(() => sdk.fetch(fetchOf("x_bare")), missing);
  assert.throws(() => sdk.create("x_bare", { x_name: "sdk" }), missing);
  assert.deepEqual(store.tableRows("x_bare").map((row) => row.x_name), ["stale local row"], "the refused create stored nothing");
});

test("SDK reads of a provider-backed virtual table go to retrieveSync/retrieveMultipleSync, else 501 SdkVirtualReadUnsupported", async (t) => {
  const { store, calls, syncRows } = await setup(t);
  const sdk = sdkOf(store);
  const unsupported = refusal(501, "SdkVirtualReadUnsupported");
  // The provider has async retrieve/retrieveMultiple only: no SDK read answers the stale mirror.
  assert.throws(() => sdk.get("x_ext", B), unsupported);
  assert.throws(() => sdk.query("x_ext", {}), unsupported);
  assert.throws(() => sdk.fetch(fetchOf("x_ext")), unsupported);
  // The synchronous provider answers its current rows.
  syncRows[0].x_name = "Sync alpha changed at provider";
  assert.equal(sdk.get("x_sync", A).x_name, "Sync alpha changed at provider");
  assert.deepEqual(calls.at(-1), ["retrieveSync", A, "retrieve"]);
  assert.deepEqual(sdk.query("x_sync", { $select: "x_name", $top: "1" }).value.map((row) => row.x_name), ["Sync alpha changed at provider"]);
  assert.deepEqual(calls.at(-1), ["retrieveMultipleSync", { select: "x_name", filter: null, orderby: null, top: 1 }, "retrieveMultiple"]);
  assert.throws(() => sdk.get("x_sync", B), refusal(404, "NotFound"), "a row the provider does not have is not found, whatever the mirror holds");
  assert.throws(() => sdk.fetch(fetchOf("x_sync")), unsupported);
});

test("SDK reads of a declared fallback 'local' table read the local rows", async (t) => {
  const { store, request, json } = await setup(t);
  const created = await json(await request("POST", "/x_kepts", { x_name: "Local" }), 201);
  const sdk = sdkOf(store);
  assert.equal(sdk.get("x_kept", created.x_keptid).x_name, "Local");
  assert.deepEqual(sdk.query("x_kept", {}).value.map((row) => row.x_name), ["Local"]);
});
