// Virtual table writes that roll back: an asynchronous provider in a synchronous SDK write,
// upsert-create keys, changeset rollback without a transaction contract and a nested standard parent.
import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION } from "../lib/dataverse-virtual-providers.mjs";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { localOrganizationService } from "../lib/local-organization-service.mjs";

const A = "77777777-7777-4777-8777-777777777771", B = "77777777-7777-4777-8777-777777777772";
const KEY = "77777777-7777-4777-8777-7777777777e1", NEW = "77777777-7777-4777-8777-7777777777f9";
const APP = "77777777-7777-4777-8777-777777777777";
const mappings = {
  x_ext: { logicalName: "x_ext", entitySet: "x_exts", idColumn: "x_extid", nameColumn: "x_name", isVirtual: true,
    fields: { x_name: { dataverseType: "nvarchar" }, x_code: { dataverseType: "nvarchar" }, x_parentid: { dataverseType: "lookup" } },
    relationships: { x_parentid: { entity: "x_parent", from: "x_parentid", to: "x_parentid", many: false } },
    alternateKeys: [{ name: "x_code_key", attributes: ["x_code"] }] },
  x_parent: { logicalName: "x_parent", entitySet: "x_parents", idColumn: "x_parentid", nameColumn: "x_name", fields: { x_name: { dataverseType: "nvarchar" } } },
};

async function setup(t, overrides = {}) {
  const external = new Map([[A, { x_extid: A, x_name: "Alpha", x_code: "A1" }], [B, { x_extid: B, x_name: "Beta", x_code: "B1" }]]);
  const calls = [], diagnostics = [];
  const provider = {
    retrieveMultiple: async () => [...external.values()].map((row) => ({ ...row })),
    retrieve: async (id) => (external.has(id) ? { ...external.get(id) } : null),
    create: (row) => { calls.push(["create", row]); const id = row.x_extid ?? NEW; external.set(id, { ...row, x_extid: id }); return { ...row, x_extid: id }; },
    update: (id, patch) => { calls.push(["update", id, patch]); Object.assign(external.get(id), patch); return { ...external.get(id) }; },
    delete: (id) => { calls.push(["delete", id]); external.delete(id); },
  };
  for (const [name, fn] of Object.entries(overrides)) provider[name] = fn === null ? undefined : fn(external, calls);
  for (const name of Object.keys(provider)) if (provider[name] === undefined) delete provider[name];
  const variable = `PAQ_VIRTUAL_ROLLBACK_${process.pid}_${Math.random().toString(36).slice(2).toUpperCase()}`;
  process.env[variable] = "invented-secret";
  const state = emptyState();
  Object.assign(state.mappings, structuredClone(mappings));
  state.tables.x_ext = [...external.values()].map((row) => ({ ...row }));
  state.tables.x_parent = [];
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({ enabled: true, tds: { enabled: false }, applications: [{ appId: APP, displayName: "Invented", secretEnvironmentVariable: variable, roles: ["System Administrator"] }] });
  const installed = { ...EXTENSION, install: (api) => EXTENSION.install(api, { virtualTableProviders: { x_ext: provider }, diagnostic: (entry) => diagnostics.push(entry) }) };
  const server = await startDataverseApi({ store, settings, log: () => {}, extensions: [...EXTENSIONS.filter((e) => e.name !== EXTENSION.name), installed] });
  t.after(async () => { delete process.env[variable]; await server.close(); });
  const token = (await (await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, { method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP, client_secret: "invented-secret", scope: `${server.origin}/.default` }) })).json()).access_token;
  const request = async (method, path, body, headers = {}) => {
    const raw = typeof body === "string";
    const response = await fetch(`${server.origin}/api/data/v9.2${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, text: await response.text() };
  };
  await request("GET", "/x_exts");
  const local = (id) => store.state.tables.x_ext.find((row) => row.x_extid === id);
  return { store, request, external, calls, diagnostics, local };
}

const changeset = (parts) => {
  const part = (p, i) => `Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: ${i + 1}\r\n\r\n${p.method} /api/data/v9.2${p.path} HTTP/1.1\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(p.body)}\r\n`;
  return `--batch_x\r\nContent-Type: multipart/mixed;boundary=changeset_x\r\n\r\n${parts.map((p, i) => `--changeset_x\r\n${part(p, i)}`).join("")}--changeset_x--\r\n--batch_x--\r\n`;
};
const failOnB = (external, calls) => (id, patch) => { calls.push(["update", id, patch]); if (id === B) throw new Error("invented outage"); Object.assign(external.get(id), patch); return { ...external.get(id) }; };

// A plain function answering a promise (not detectable before a call): without a declared updateSync the SDK write never calls it.
test("an SDK write to a provider without a synchronous write operation answers 501 before any provider call", async (t) => {
  const { store, calls, local, external } = await setup(t, { update: (ext, list) => (id, patch) => { list.push(["update", id, patch]); return Promise.resolve().then(() => { Object.assign(ext.get(id), patch); return { ...ext.get(id) }; }); } });
  const service = localOrganizationService(store, { userId: store.state.tables.systemuser[0].systemuserid, evidence: "invented", grants: [{ entity: "x_ext", operations: ["read", "update"] }] });
  assert.throws(() => service.update("x_ext", A, { x_name: "SdkAsync" }), { status: 501, code: "SdkAsyncPreOperationUnsupported" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(local(A).x_name, "Alpha");
  assert.equal(external.get(A).x_name, "Alpha");
  assert.deepEqual(calls, []);
});

test("an upsert-create passes the caller's primary key to the provider and keeps it; a repeated upsert updates", async (t) => {
  const { request, calls, local } = await setup(t, { create: (ext, list) => (row) => { list.push(["create", row]); ext.set(row.x_extid ?? NEW, { ...row }); return { ...row, x_extid: NEW }; } });
  assert.equal((await request("PATCH", `/x_exts(${KEY})`, { x_name: "Upserted", x_code: "U1" })).status, 204);
  assert.equal(calls[0][1].x_extid, KEY);
  assert.equal(local(KEY)?.x_name, "Upserted");
  assert.equal(local(NEW), undefined);
  assert.equal((await request("PATCH", `/x_exts(${KEY})`, { x_name: "Again" })).status, 204);
  assert.deepEqual(calls.map(([name]) => name), ["create", "update"]);
  assert.equal(local(KEY).x_name, "Again");
});

test("an upsert-create by alternate key creates once; a repeated upsert by the same key updates", async (t) => {
  const { request, calls, local } = await setup(t);
  assert.equal((await request("PATCH", "/x_exts(x_code='K1')", { x_name: "Keyed" })).status, 204);
  assert.equal((await request("PATCH", "/x_exts(x_code='K1')", { x_name: "Keyed again" })).status, 204);
  assert.deepEqual(calls.map(([name]) => name), ["create", "update"]);
  assert.equal(local(NEW).x_name, "Keyed again");
});

// A provider without the transaction contract (begin, commit, rollback) is not enlisted: no platform step calls an inverse
// operation, so its earlier write stays and the rollback names the row (dataverse-virtual-providers.mjs, Transactions).
test("a changeset whose second provider call fails leaves the first write of a provider without a transaction contract and reports it", async (t) => {
  const { request, external, local, diagnostics, calls } = await setup(t, { update: failOnB });
  const response = await request("POST", "/$batch", changeset([{ method: "PATCH", path: `/x_exts(${A})`, body: { x_name: "A-new" } }, { method: "PATCH", path: `/x_exts(${B})`, body: { x_name: "B-new" } }]),
    { "content-type": "multipart/mixed;boundary=batch_x" });
  assert.equal(response.status, 400);
  assert.equal(local(A).x_name, "Alpha");
  assert.equal(external.get(A).x_name, "A-new", "no inverse call undoes the provider's write");
  assert.deepEqual(calls.map(([name, id]) => [name, id]), [["update", A], ["update", B]]);
  assert.deepEqual(diagnostics.filter((d) => d.code === "VIRTUAL_PROVIDER_EFFECT_UNCOMPENSATED").map((d) => [d.id, d.operation]), [[A, "update"]]);
});

test("a changeset effect without an inverse provider operation is reported uncompensated, naming the row", async (t) => {
  const { request, external, diagnostics } = await setup(t, { update: failOnB, delete: null });
  const response = await request("POST", "/$batch", changeset([{ method: "POST", path: "/x_exts", body: { x_name: "Created", x_code: "C1" } }, { method: "PATCH", path: `/x_exts(${B})`, body: { x_name: "B-new" } }]),
    { "content-type": "multipart/mixed;boundary=batch_x" });
  assert.equal(response.status, 400);
  assert.equal(external.has(NEW), true);
  assert.deepEqual(diagnostics.filter((d) => d.code === "VIRTUAL_PROVIDER_EFFECT_UNCOMPENSATED").map((d) => [d.id, d.operation]), [[NEW, "create"]]);
});

test("a virtual row created with a nested standard parent passes the parent to the provider as a reference", async (t) => {
  const { request, calls, store } = await setup(t);
  assert.equal((await request("POST", "/x_exts", { x_name: "Gamma", x_code: "G1", x_parentid: { x_name: "Nested parent" } })).status, 204);
  const parent = store.state.tables.x_parent.find((row) => row.x_name === "Nested parent");
  assert.ok(parent, "the nested parent was created through the pipeline");
  assert.deepEqual([calls[0][1].x_parentid.id, calls[0][1].x_parentid.logical_name], [parent.x_parentid, "x_parent"]);
});

test("an SDK write calls the provider's declared updateSync and mirrors its row inline", async (t) => {
  const { store, calls, local } = await setup(t, { updateSync: (ext, list) => (id, patch) => { list.push(["updateSync", id, patch]); Object.assign(ext.get(id), patch); return { ...ext.get(id) }; } });
  const service = localOrganizationService(store, { userId: store.state.tables.systemuser[0].systemuserid, evidence: "invented", grants: [{ entity: "x_ext", operations: ["read", "update"] }] });
  service.update("x_ext", A, { x_name: "SdkSync" });
  assert.deepEqual(calls.map(([name]) => name), ["updateSync"]);
  assert.equal(local(A).x_name, "SdkSync");
});
