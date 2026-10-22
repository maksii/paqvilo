// A Web API write runs its record hooks inside its own transaction. A real-time classic workflow handler may change any
// row directly, so a throw must roll its edits back and a success must persist them, in memory and in a journal-format
// state file. The platform rows the hooks write (workflowlog, N:N audit) are journaled. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { workflowExtension, workflowHandlers } from "../lib/dataverse-workflows.mjs";

const APP_ID = "77777777-7777-4777-8777-777777777701";
const SECRET_VAR = "PAQVILO_WRITE_HOOK_ROLLBACK_SECRET";
const WIDGET = "77777777-7777-4777-8777-777777777711";
const OTHER = "77777777-7777-4777-8777-777777777712";
const TAG = "77777777-7777-4777-8777-777777777713";
const WF = (n) => `77777777-7777-4777-8777-7777777778${String(n).padStart(2, "0")}`;
const REFUSAL = "Invented handler refusal";

const fact = (id, overrides) => ({
  id, name: `Invented ${id.slice(-2)}`, uniquename: null, category: 0, type: 1, mode: 1, scope: 4, ondemand: false, subprocess: false,
  triggeroncreate: false, triggerondelete: false, triggeronupdateattributelist: null, primaryentity: "x_widget", state: 1,
  runas: 0, istransacted: true, asyncautodelete: false, syncworkflowlogonfailure: false, xaml: "<Activity />", clientdata: null,
  ...overrides,
});
const FACTS = [
  fact(WF(1), { triggeronupdateattributelist: "note" }), // real-time: edits x_other, then throws
  fact(WF(2), { triggeronupdateattributelist: "name" }), // real-time: edits x_other and succeeds
];
const otherRow = (store) => store.state.tables.x_other.find((row) => row.x_otherid === OTHER);
const HANDLERS = workflowHandlers([{
  id: "invented-rollback-pack",
  workflows: {
    [WF(1)]: async ({ api }) => { otherRow(api.store).note = "leak"; throw new Error(REFUSAL); },
    [WF(2)]: async ({ api }) => { otherRow(api.store).note = "handled"; return { message: "handled" }; },
  },
}]);

function state() {
  const value = emptyState();
  const text = { dataverseType: "nvarchar" };
  value.mappings.x_widget = {
    logicalName: "x_widget", entitySet: "x_widgets", idColumn: "x_widgetid", nameColumn: "name", userConfigured: true,
    dataverseMetadata: { IsAuditEnabled: { Value: true } }, fields: { name: text, note: text },
    relationships: { x_widget_tags: { entity: "x_tag", from: "x_widgetid", to: "x_tagid", many: true, intersect: { entity: "x_widget_tag", from: "x_widgetid", to: "x_tagid" } } },
  };
  value.mappings.x_other = { logicalName: "x_other", entitySet: "x_others", idColumn: "x_otherid", nameColumn: "note", userConfigured: true, fields: { note: text }, relationships: {} };
  value.mappings.x_tag = { logicalName: "x_tag", entitySet: "x_tags", idColumn: "x_tagid", nameColumn: "name", userConfigured: true, fields: { name: text }, relationships: {} };
  value.mappings.x_widget_tag = { logicalName: "x_widget_tag", entitySet: "x_widget_tags", idColumn: "x_widget_tagid", userConfigured: true, fields: { x_widgetid: { dataverseType: "lookup" }, x_tagid: { dataverseType: "lookup" } }, relationships: {} };
  value.tables.x_widget = [{ x_widgetid: WIDGET, name: "alpha", note: "kept" }];
  value.tables.x_other = [{ x_otherid: OTHER, note: "original" }];
  value.tables.x_tag = [{ x_tagid: TAG, name: "tag" }];
  value.tables.x_widget_tag = [];
  return value;
}

// file: a journal-format state file (every save appends once the threshold is 0); none: memory only, as dry-run.
async function fixture(t, file = null) {
  process.env[SECRET_VAR] = "rollback-secret";
  t.after(() => { delete process.env[SECRET_VAR]; });
  const persistence = { journalThresholdBytes: 0 };
  const store = await new DataStore({ state: state(), ...(file ? { file, persistence } : {}) }).init();
  const settings = dataverseSettings({ enabled: true, applications: [{ appId: APP_ID, displayName: "Rollback app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }] });
  const api = await startDataverseApi({ store, settings, log: () => {}, extensions: [...EXTENSIONS, workflowExtension({ facts: FACTS, handlers: HANDLERS, diagnostic: () => {} })] });
  t.after(() => api.close());
  await store.transact(() => { store.state.tables.organization[0].isauditenabled = true; });
  const token = await (await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${api.origin}/.default` }),
  })).json();
  const call = (method, suffix, body) => fetch(`${api.origin}/api/data/v9.2/${suffix}`, {
    method, signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token.access_token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const reload = async () => new DataStore({ file, persistence }).init();
  return { store, api, call, reload, persistence };
}

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "write-hook-rollback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, "state.json");
}

async function refusedHandlerRollsBack(store, call) {
  const before = store.snapshotDigest();
  const response = await call("PATCH", `x_widgets(${WIDGET})`, { note: "changed" });
  const error = (await response.json()).error;
  assert.equal(response.status, 400);
  assert.equal(error.message, REFUSAL);
  assert.equal(otherRow(store).note, "original", "the handler's edit of another row rolls back");
  assert.equal(store.state.tables.x_widget[0].note, "kept");
  assert.equal(store.snapshotDigest(), before);
}

test("memory only: a real-time handler that edits another row and throws answers 400 and leaves the row unchanged", async (t) => {
  const { store, call } = await fixture(t);
  await refusedHandlerRollsBack(store, call);
});

test("journal file: a refused handler leaves nothing behind, and a successful handler, its workflowlog and an N:N audit row survive a reload", async (t) => {
  const file = await workspace(t);
  const { store, call, reload } = await fixture(t, file);
  await refusedHandlerRollsBack(store, call);
  // The journal is in use for ordinary writes.
  const modes = []; store.onSave = (timing) => modes.push(timing.mode);
  const associated = await call("POST", `x_widgets(${WIDGET})/x_widget_tags/$ref`, { "@odata.id": `http://localhost/api/data/v9.2/x_tags(${TAG})` });
  assert.equal(associated.status, 204, await associated.clone().text());
  assert.deepEqual(modes, ["journal"], "an associate without a handler stays on the row journal");
  const renamed = await call("PATCH", `x_widgets(${WIDGET})`, { name: "beta" });
  assert.equal(renamed.status, 204, await renamed.clone().text());
  assert.equal(otherRow(store).note, "handled");
  const audits = store.state.tables.audit.filter((row) => row.objectid?.id === WIDGET && row.action === 33).length;
  assert.equal(audits, 1, "one associate audit row");
  const logs = store.state.tables.workflowlog.filter((row) => row.regardingobjectid?.id === WIDGET && row.message === "handled").length;
  assert.equal(logs, 1);

  // Row audit for committed events is appended after the commit; let it land before the reload.
  await store.flushCommittedEvents(); await store.queue;
  const restarted = await reload();
  assert.equal(otherRow(restarted).note, "handled", "a handler's edit of another row persists");
  assert.equal(restarted.state.tables.x_widget[0].name, "beta");
  assert.equal(restarted.state.tables.x_widget[0].note, "kept");
  assert.equal(restarted.state.tables.audit.filter((row) => row.objectid?.id === WIDGET && row.action === 33).length, audits);
  assert.equal(restarted.state.tables.workflowlog.filter((row) => row.regardingobjectid?.id === WIDGET && row.message === "handled").length, logs);
  assert.deepEqual(restarted.snapshot(), store.snapshot());
});
