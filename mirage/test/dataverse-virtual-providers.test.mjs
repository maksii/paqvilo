// Virtual tables with external providers (lib/dataverse-virtual-providers.mjs): writes reach the provider and mirror its rows,
// a failing or incomplete provider refuses the write, a table without a provider answers 501 unless it declares the local
// fallback, reads query the provider, the validator and describe.
import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION, validateVirtualTableProviders } from "../lib/dataverse-virtual-providers.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";
import { ownedFixture } from "../testing/owned-fixture.mjs";

const ROW = "55555555-5555-4555-8555-555555555555";
const NEW = "55555555-5555-4555-8555-555555555556";

const mappings = {
  x_thing: {
    logicalName: "x_thing", entitySet: "x_things", idColumn: "x_thingid", nameColumn: "x_name",
    fields: { x_name: { dataverseType: "nvarchar" }, x_value: { dataverseType: "int" } },
  },
  x_bare: {
    logicalName: "x_bare", entitySet: "x_bares", idColumn: "x_bareid", nameColumn: "x_name", isVirtual: true,
    fields: { x_name: { dataverseType: "nvarchar" } },
  },
};
const tables = {
  x_thing: [{ x_thingid: ROW, x_name: "Invented", x_value: 1, statecode: 0, statuscode: 1 }],
  x_bare: [],
};

// An in-memory provider: ops are the provider's operations (validated as a pack export), calls records every call, rows are its source of truth.
function fakeProvider(overrides = {}) {
  const calls = [];
  const rows = new Map([[ROW, { x_thingid: ROW, x_name: "Invented", x_value: 1 }]]);
  const ops = {
    async create(row) {
      calls.push(["create", { ...row }]);
      const created = { ...row, x_thingid: NEW, x_value: row.x_value ?? 0 };
      rows.set(NEW, created);
      return created;
    },
    async update(id, patch) {
      calls.push(["update", id, { ...patch }]);
      const updated = { ...rows.get(id), ...patch };
      rows.set(id, updated);
      return updated;
    },
    async delete(id) {
      calls.push(["delete", id]);
      rows.delete(id);
    },
    async retrieveMultiple(query) {
      calls.push(["retrieveMultiple", query]);
      return [...rows.values()];
    },
    ...overrides,
  };
  return { calls, ops };
}

async function setup(t, { provider = fakeProvider() } = {}) {
  const diagnostics = [];
  // The organization api that install receives is not the one the fixture returns: capture it to reach api.virtualProviders.
  let installed = null;
  const extension = { ...EXTENSION, install: (api, options) => { installed = api; return EXTENSION.install(api, options); } };
  const fixture = await contractModuleFixture(t, {
    mappings, tables, extension,
    options: {
      virtualTableProviders: { x_provider: provider.ops },
      virtualTables: { x_thing: { dataSourceId: "x_provider" } },
      diagnostic: (entry) => diagnostics.push(entry),
    },
  });
  return { ...fixture, api: installed, provider, diagnostics };
}

test("create, update and delete reach the provider and mirror its rows", async (t) => {
  const { request, json, provider, store, diagnostics } = await setup(t);
  await json(await request("POST", "/x_things", { x_name: "Created", x_value: 7 }), 201);
  assert.equal(provider.calls[0][0], "create");
  assert.equal(provider.calls[0][1].x_name, "Created");
  assert.equal(store.state.tables.x_thing.find((row) => row.x_thingid === NEW)?.x_name, "Created");

  await json(await request("PATCH", `/x_things(${ROW})`, { x_value: 9 }), 200);
  assert.deepEqual(provider.calls[1].slice(0, 2), ["update", ROW]);
  assert.equal(provider.calls[1][2].x_value, 9);
  assert.equal(store.state.tables.x_thing.find((row) => row.x_thingid === ROW)?.x_value, 9);

  await json(await request("DELETE", `/x_things(${NEW})`), 204);
  assert.deepEqual(provider.calls[2], ["delete", NEW]);
  assert.equal(store.state.tables.x_thing.some((row) => row.x_thingid === NEW), false);
  assert.equal(diagnostics.length, 0, "a write the provider answers reports nothing");
});

test("a provider that throws fails the write with 400, reports VIRTUAL_PROVIDER_FAILED and stores nothing", async (t) => {
  const provider = fakeProvider({ create: async () => { throw new Error("invented outage"); } });
  const { request, json, store, diagnostics } = await setup(t, { provider });
  await json(await request("POST", "/x_things", { x_name: "Refused" }), 400);
  const failures = diagnostics.filter((entry) => entry.code === "VIRTUAL_PROVIDER_FAILED");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].severity, "error");
  assert.equal(store.state.tables.x_thing.some((row) => row.x_name === "Refused"), false);
});

test("a provider without the matching operation refuses the write with 501 and stores nothing", async (t) => {
  const provider = { ops: { retrieveMultiple: async () => [] }, calls: [] };
  const { request, json, store, diagnostics } = await setup(t, { provider });
  await json(await request("POST", "/x_things", { x_name: "Unwritten" }), 501);
  assert.equal(store.state.tables.x_thing.some((row) => row.x_name === "Unwritten"), false);
  assert.equal(diagnostics.filter((entry) => entry.code === "VIRTUAL_PROVIDER_OPERATION_MISSING").length, 1);
});

// A virtual table's rows come from its data provider, never from a local row; without one the write answers 501.
test("a virtual table without a provider refuses writes with 501 and reports VIRTUAL_PROVIDER_MISSING once", async (t) => {
  const { request, json, store, diagnostics } = await setup(t);
  await json(await request("POST", "/x_bares", { x_name: "Local one" }), 501);
  await json(await request("POST", "/x_bares", { x_name: "Local two" }), 501);
  assert.equal(store.state.tables.x_bare.length, 0);
  const missing = diagnostics.filter((entry) => entry.code === "VIRTUAL_PROVIDER_MISSING");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].table, "x_bare");
  assert.equal(missing[0].severity, "error");
});

test("api.virtualProviders.query returns the provider's rows and passes the query through", async (t) => {
  const { api, provider, diagnostics } = await setup(t);
  const rows = await api.virtualProviders.query("x_thing", { filter: "x_value gt 0", top: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].x_thingid, ROW);
  assert.deepEqual(provider.calls[0], ["retrieveMultiple", { select: null, filter: "x_value gt 0", orderby: null, top: 5 }]);
  assert.equal(api.virtualProviders.for("x_thing").retrieveMultiple, provider.ops.retrieveMultiple);
  await assert.rejects(api.virtualProviders.query("x_bare", {}), { status: 501, code: "VirtualProviderMissing" });
  assert.equal(diagnostics.filter((entry) => entry.code === "VIRTUAL_PROVIDER_MISSING" && entry.table === "x_bare").length, 1);
});

test("validateVirtualTableProviders accepts functions only and rejects unknown operations", () => {
  assert.deepEqual(validateVirtualTableProviders(undefined), {});
  assert.doesNotThrow(() => validateVirtualTableProviders({ x_provider: { retrieveMultiple: async () => [], describe: () => ({}) } }));
  assert.throws(() => validateVirtualTableProviders({ x_provider: { create: "not a function" } }), /create must be a function/);
  assert.throws(() => validateVirtualTableProviders({ x_provider: { retrieve: 1 } }), /retrieve must be a function/);
  assert.throws(() => validateVirtualTableProviders({ x_provider: { retrievemultiple: () => [] } }), /unknown operation/);
  assert.throws(() => validateVirtualTableProviders({ x_provider: () => [] }), /object of provider operations/);
  assert.throws(() => validateVirtualTableProviders([]), /must map/);
});

test("describe(api): operations the registered provider implements are behaviour, the rest and external events contract", async (t) => {
  const { api } = await setup(t);
  const record = EXTENSION.describe(api);
  assert.equal(record.name, "dataverse-virtual-providers");
  assert.equal(record.level, "behaviour");
  assert.deepEqual(record.requires, ["pack:virtualTableProviders"]);
  const level = (name) => record.operations.find((operation) => operation.name === name)?.level;
  for (const name of ["Create", "Update", "Delete", "RetrieveMultiple"]) assert.equal(level(name), "behaviour", name);
  for (const name of ["Retrieve", "OnExternalCreated", "OnExternalUpdated", "OnExternalDeleted"]) assert.equal(level(name), "contract", name);
  assert.equal(EXTENSION.describe().level, "contract", "no provider registered");
});

// Host level (createSimulator standalone, the default EXTENSIONS order, not the fixture, which installs the module last): the
// provider's external write is the last beforeWrite, so a refusal by an earlier hook (here a status transition the pack's
// transitions export does not allow) never reaches provider.update.
test("a PATCH another write hook refuses never calls provider.update (host extension order)", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createSimulator } = await import("../api.mjs");
  const CLIENT = "99999999-9999-4999-8999-999999999999";
  const KEY = `__virtualOrder${process.pid}${Math.random().toString(36).slice(2)}`;
  const calls = (globalThis[KEY] = []);
  ownedFixture(t).add(() => { delete globalThis[KEY]; });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "virtual-order-"));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const attribute = (name, type) => `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>${type}</Type></attribute>`;
  const files = {
    "solution/Other/Solution.xml": "<ImportExportXml><SolutionManifest><UniqueName>InventedVirtual</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>",
    "solution/Entities/x_remote/Entity.xml": `<Entity><Name>x_remote</Name><EntityInfo><entity Name="x_remote"><EntitySetName>x_remotes</EntitySetName>`
      + `<PrimaryIdAttribute>x_remoteid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><DataSourceId>fx_source</DataSourceId><attributes>`
      + `${attribute("x_remoteid", "primarykey")}${attribute("x_name", "nvarchar")}${attribute("statecode", "state")}${attribute("statuscode", "status")}`
      + `</attributes></entity></EntityInfo></Entity>`,
    "pack.mjs": `const calls = globalThis[${JSON.stringify(KEY)}];
export default { id: "invented-virtual", name: "Invented virtual", description: "Invented", matches: () => true, presets: () => ({}),
  transitions: { x_remote: { 1: [2] } },
  virtualTableProviders: { x_remote: {
    create: (row) => { calls.push("create"); return { ...row, x_remoteid: "${ROW}", statecode: 0, statuscode: 1 }; },
    update: (id, patch) => { calls.push("update:" + JSON.stringify(patch)); return null; },
  } } };`,
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  const sim = await createSimulator({ runtime: { kind: "dataverse-api" }, solutionRoots: [path.join(root, "solution")], projectRoot: root,
    dataPacks: [{ module: path.join(root, "pack.mjs") }], port: 0, watch: false, simulation: { level: "dry-run" },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  ownedFixture(t).add(() => sim.close());
  const registered = await fetch(sim.url + "/_sim/api/dataverse/applications", { method: "POST",
    headers: { "content-type": "application/json", "x-sim-csrf": sim.csrf },
    body: JSON.stringify({ appId: CLIENT, displayName: "Invented client", roles: ["System Administrator"] }) });
  assert.equal(registered.status, 201, await registered.clone().text());
  const { secret } = await registered.json();
  const token = await (await fetch(sim.dataverse.authority + "/oauth2/v2.0/token", { method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT, client_secret: secret, scope: sim.dataverse.origin + "/.default" }) })).json();
  const api = (method, suffix, body) => fetch(sim.dataverse.origin + "/api/data/v9.2" + suffix, { method,
    headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });

  const created = await api("POST", "/x_remotes", { x_name: "Remote row" });
  assert.equal(created.status, 204, await created.text());
  assert.deepEqual(calls, ["create"]);
  const refused = await api("PATCH", `/x_remotes(${ROW})`, { statuscode: 5 });
  assert.equal(refused.status, 400, await refused.text());
  assert.deepEqual(calls, ["create"], "the refused write never reached the provider");
  const allowed = await api("PATCH", `/x_remotes(${ROW})`, { statuscode: 2 });
  assert.equal(allowed.status, 204, await allowed.text());
  assert.deepEqual(calls, ["create", 'update:{"statuscode":2}']);
});

test("a Solution table whose DataSourceId lives under dataverseMetadata resolves its provider without a virtualTables declaration", async (t) => {
  const provider = fakeProvider({ async create(row) { provider.calls.push(["create", { ...row }]); return { ...row, x_remoteid: NEW, x_value: row.x_value ?? 0 }; } });
  const solutionMappings = {
    x_remote: {
      logicalName: "x_remote", entitySet: "x_remotes", idColumn: "x_remoteid", nameColumn: "x_name",
      dataverseMetadata: { schemaName: "x_Remote", DataSourceId: "x_provider" },
      fields: { x_name: { dataverseType: "nvarchar" }, x_value: { dataverseType: "int" } },
    },
  };
  const fixture = await contractModuleFixture(t, {
    mappings: solutionMappings, tables: { x_remote: [] }, extension: EXTENSION,
    options: { virtualTableProviders: { x_provider: provider.ops }, diagnostic: () => {} },
  });
  await fixture.json(await fixture.request("POST", "/x_remotes", { x_name: "Created", x_value: 7 }), 201);
  assert.equal(provider.calls[0]?.[0], "create", "the provider keyed by the Solution DataSourceId handled the create");
});
