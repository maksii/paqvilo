// AddToFeedbackLoop writes its row through the record pipeline: a create hook registered on the feedback table sees the write,
// and a hook that refuses it leaves no row behind.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";

const APP_ID = "66666666-6666-6666-6666-666666666666";
const SECRET_VAR = "PAQVILO_FEEDBACK_PIPELINE_SECRET";
const VERSION = "v9.2";
const MODEL = "a1000000-0000-4000-8000-000000000001";

// A started API whose extensions include a spy on the feedback table's create hook; veto makes the spy refuse the write.
async function start(t, { veto = false } = {}) {
  process.env[SECRET_VAR] = "feedback-pipeline-secret";
  t.after(() => { delete process.env[SECRET_VAR]; });
  const state = emptyState();
  state.tables.msdyn_aimodel = [{ msdyn_aimodelid: MODEL, msdyn_name: "Invented model" }];
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [{ appId: APP_ID, displayName: "Feedback pipeline app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
  });
  const creates = [];
  const spy = {
    name: "invented-feedback-spy",
    install(api) {
      api.recordHooks.add("beforeWrite", (c, mapping, info) => {
        if (mapping.logicalName !== "msdyn_aibfeedbackloop" || info.operation !== "create") return;
        creates.push({ ...info.data });
        if (veto) throw new Error("Invented create hook refuses the feedback row.");
      });
    },
  };
  const api = await startDataverseApi({ store, settings, log: () => {}, extensions: [...EXTENSIONS, spy] });
  t.after(() => api.close());
  const token = (await (await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${api.origin}/.default` }),
  })).json()).access_token;
  const call = async (path, body) => {
    const result = await fetch(`${api.origin}/api/data/${VERSION}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: result.status, text: await result.text() };
  };
  return { store, call, creates };
}

test("AddToFeedbackLoop creates its row through the record pipeline, where a create hook on the feedback table sees it", async (t) => {
  const { store, call, creates } = await start(t);
  const response = await call(`msdyn_aimodels(${MODEL})/Microsoft.Dynamics.CRM.AddToFeedbackLoop`, { inputName: "Invented input", source: "invented", predictionOutput: "{}", predictionInput: {} });
  assert.equal(response.status, 204, response.text);
  assert.equal(creates.length, 1, "the create hook ran once for the feedback row");
  assert.equal(creates[0].msdyn_name, "Invented input");
  const rows = store.state.tables.msdyn_aibfeedbackloop.filter((row) => row.msdyn_name === "Invented input");
  assert.equal(rows.length, 1, "the row is stored");
  assert.ok(rows[0].msdyn_aibfeedbackloopid, "the pipeline assigns the row id");
});

test("a create hook that refuses the feedback row leaves no feedback row behind", async (t) => {
  const { store, call } = await start(t, { veto: true });
  const response = await call(`msdyn_aimodels(${MODEL})/Microsoft.Dynamics.CRM.AddToFeedbackLoop`, { inputName: "Vetoed input" });
  assert.equal(response.status, 500, response.text);
  assert.equal(JSON.parse(response.text).error.code, "0x80040216");
  assert.equal((store.state.tables.msdyn_aibfeedbackloop ?? []).length, 0);
});
