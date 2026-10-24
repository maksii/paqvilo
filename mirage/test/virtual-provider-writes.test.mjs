// Virtual table writes: the provider is the main operation (stage 30), called after
// the store write passed every local check and inside its transaction. A locally refused write never reaches the provider;
// a provider failure leaves the local row unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION } from "../lib/dataverse-virtual-providers.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";

const A = "77777777-7777-4777-8777-777777777771", B = "77777777-7777-4777-8777-777777777772";
const mappings = {
  x_ext: { logicalName: "x_ext", entitySet: "x_exts", idColumn: "x_extid", nameColumn: "x_name", isVirtual: true,
    fields: { x_name: { dataverseType: "nvarchar" }, x_code: { dataverseType: "nvarchar" } },
    alternateKeys: [{ name: "x_code_key", attributes: ["x_code"] }] },
};

async function setup(t, overrides = () => ({})) {
  const external = new Map([[A, { x_extid: A, x_name: "Alpha", x_code: "A1" }], [B, { x_extid: B, x_name: "Beta", x_code: "B1" }]]);
  const calls = [];
  const provider = {
    retrieveMultiple: async () => [...external.values()].map((row) => ({ ...row })),
    retrieve: async (id) => (external.has(id) ? { ...external.get(id) } : null),
    create: (row) => { calls.push("create"); const id = "77777777-7777-4777-8777-777777777773"; external.set(id, { ...row, x_extid: id }); return { ...row, x_extid: id }; },
    update: (id, patch) => { calls.push("update"); Object.assign(external.get(id), patch); return { ...external.get(id) }; },
    delete: (id) => { calls.push("delete"); external.delete(id); },
    ...overrides(external),
  };
  const fixture = await contractModuleFixture(t, { mappings, tables: { x_ext: [...external.values()].map((row) => ({ ...row })) }, extension: EXTENSION,
    options: { virtualTableProviders: { x_ext: provider }, diagnostic: () => {} } });
  await fixture.request("GET", "/x_exts");
  return { ...fixture, external, calls };
}

test("a stale If-Match PATCH or DELETE and an alternate-key duplicate answer 412 and never reach the provider", async (t) => {
  const { request, external, calls } = await setup(t);
  const before = JSON.stringify([...external.values()]);
  assert.equal((await request("PATCH", `/x_exts(${A})`, { x_name: "Stale" }, { "if-match": 'W/"1"' })).status, 412);
  assert.equal((await request("DELETE", `/x_exts(${B})`, undefined, { "if-match": 'W/"1"' })).status, 412);
  const patch = await request("PATCH", `/x_exts(${A})`, { x_code: "B1" });
  assert.equal(patch.status, 412);
  assert.equal((await patch.json()).error.code, "0x80060892");
  assert.equal((await request("POST", "/x_exts", { x_name: "Gamma", x_code: "A1" })).status, 412);
  assert.deepEqual(calls, [], "no refused write reached the provider");
  assert.equal(JSON.stringify([...external.values()]), before);
});

test("a provider that throws after the local checks leaves the local row unchanged and answers 400", async (t) => {
  const { request, store } = await setup(t, () => ({ update: () => { throw new Error("invented outage"); } }));
  const response = await request("PATCH", `/x_exts(${A})`, { x_name: "Lost" });
  assert.equal(response.status, 400);
  assert.equal(store.state.tables.x_ext.find((row) => row.x_extid === A).x_name, "Alpha");
});

test("a create reaches the provider without the local key and the stored row takes the provider's key", async (t) => {
  let received;
  const { request, store } = await setup(t, (external) => ({ create: (row) => {
    received = row;
    external.set("77777777-7777-4777-8777-777777777774", { ...row, x_extid: "77777777-7777-4777-8777-777777777774" });
    return { ...row, x_extid: "77777777-7777-4777-8777-777777777774" };
  } }));
  const response = await request("POST", "/x_exts", { x_name: "Delta", x_code: "D1" });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(received.x_extid, undefined);
  assert.equal((await response.json()).x_extid, "77777777-7777-4777-8777-777777777774");
  assert.equal(store.state.tables.x_ext.filter((row) => row.x_code === "D1").map((row) => row.x_extid).join(), "77777777-7777-4777-8777-777777777774");
});
