// AI Builder, AI function, Copilot and process-mining messages (lib/dataverse-addon-ai.mjs) over HTTP: every message is in
// $metadata, the default errors, the capability probes, the feedback-loop row and a trusted pack override. The message and
// table names are the platform's.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { addonHandlerExtension, addonHandlers } from "../lib/dataverse-addon-common.mjs";

const APP_ID = "66666666-6666-6666-6666-666666666666";
const SECRET_VAR = "PAQVILO_ADDON_AI_SECRET";
const VERSION = "v9.2";
const MODEL = "a1000000-0000-4000-8000-000000000001";
const MISSING = "a1000000-0000-4000-8000-0000000000ff";
const AI_MESSAGES = [
  "Predict", "PredictByReference", "PredictionSchema", "BatchPrediction", "Train", "ScheduleTraining", "UnscheduleTraining",
  "CancelTraining", "QuickTest", "PublishAIConfiguration", "UnpublishAIConfiguration", "SchedulePrediction", "ScheduleRetrain",
  "UnschedulePrediction", "AddToFeedbackLoop", "Analyze", "Ingest", "Share", "AIClassify", "AIExtract", "AIModelPublish", "AIReply",
  "AISentiment", "AISummarize", "AISummarizeRecord", "AITranslate", "SummarizeRecord", "AnalyzeSentiment", "CategorizeText",
  "DetectLanguage", "ExtractKeyPhrases", "ExtractTextEntities", "RecognizeText", "FormPredict", "GeneratePowerFxFormula",
  "InferEntityDefinition", "QueryDvUnstructuredData", "copilotquerytextcontext", "ValidateAIConfiguration", "GetJobStatus",
  "DiscoverFabricAISkills", "DiscoverFabricWorkspaces", "ExecuteWorkIQTask", "GetWorkIQTaskStatus", "McpExecuteWorkIQTask",
  "McpGetWorkIQTaskStatus", "McpCreateTable", "McpUpdateTable", "RunDataProcessingModule", "SetupAiConnection", "QuestionAnalytics",
  "IsPaiEnabled", "IsPmEnabled", "IsCDS3Ready", "copilottextdatastatus",
];

// A started simulated API with its own store and client-credentials token.
async function start(packs, roles = ["System Administrator"]) {
  process.env[SECRET_VAR] = "addon-ai-secret";
  const state = emptyState();
  state.tables.msdyn_aimodel = [{ msdyn_aimodelid: MODEL, msdyn_name: "Invented model" }];
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [{ appId: APP_ID, displayName: "Addon AI app", secretEnvironmentVariable: SECRET_VAR, roles }],
  });
  const api = await startDataverseApi({
    store,
    settings,
    log: () => {},
    extensions: [...EXTENSIONS, addonHandlerExtension(addonHandlers(packs))],
  });
  const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${api.origin}/.default` }),
  });
  const token = (await response.json()).access_token;
  const call = async (path, { method = "POST", body } = {}) => {
    const result = await fetch(`${api.origin}/api/data/${VERSION}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await result.text();
    return { status: result.status, body: text ? JSON.parse(text) : null };
  };
  const metadata = async () => (await fetch(`${api.origin}/api/data/${VERSION}/$metadata`, { headers: { authorization: `Bearer ${token}` } })).text();
  return { api, store, call, metadata };
}

describe("AI add-on messages over HTTP", () => {
  let plain;
  let withPack;

  before(async () => {
    plain = await start([]);
    withPack = await start([
      {
        id: "invented-ai-pack",
        dataverseMessages: {
          Predict: async (ctx) => ({ response: "", responsev2: { invented: ctx.args.version } }),
          AIModelPublish: async () => undefined,
        },
      },
    ]);
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await plain?.api.close();
    await withPack?.api.close();
  });

  it("every AI message is in $metadata", async () => {
    const metadata = await plain.metadata();
    for (const name of AI_MESSAGES) assert.match(metadata, new RegExp(`<(Action|Function) Name="${name}"`), `${name} is in $metadata`);
  });

  it("Predict default is 403 0x80048d06 (no capacity)", async () => {
    const response = await plain.call(`msdyn_aimodels(${MODEL})/Microsoft.Dynamics.CRM.Predict`, { body: { version: "2.0" } });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "0x80048d06");
    assert.match(response.body.error.message, /EntitlementNotAvailable/);
  });

  it("Predict on a missing model is 404", async () => {
    const response = await plain.call(`msdyn_aimodels(${MISSING})/Microsoft.Dynamics.CRM.Predict`, { body: { version: "2.0" } });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "0x80040217");
  });

  it("a pack handler replaces the default and returns responsev2", async () => {
    const response = await withPack.call(`msdyn_aimodels(${MODEL})/Microsoft.Dynamics.CRM.Predict`, { body: { version: "2.0" } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.responsev2, { invented: "2.0" });
  });

  it("IsPaiEnabled default is false", async () => {
    // IsPaiEnabled is an action in the native $metadata (POST), unlike IsCDS3Ready, which is a function.
    const response = await plain.call("IsPaiEnabled", { body: {} });
    assert.equal(response.status, 200);
    assert.equal(response.body.ispaienabled, false);
    assert.equal(response.body.templates, "[]");
  });

  it("feedback loop inserts a row for the model", async () => {
    const response = await plain.call(`msdyn_aimodels(${MODEL})/Microsoft.Dynamics.CRM.AddToFeedbackLoop`, {
      body: { inputName: "Invented input", source: "invented", predictionOutput: "{}", predictionInput: {} },
    });
    assert.equal(response.status, 204);
    const rows = plain.store.state.tables.msdyn_aibfeedbackloop.filter((row) => (row.msdyn_aimodelid?.id ?? row.msdyn_aimodelid) === MODEL);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].msdyn_name, "Invented input");
  });

  it("AIModelPublish (internal-only) answers 501 0x80040216 by default and 204 from a pack handler", async () => {
    const body = { ModelId: MODEL, RunConfigurationId: MODEL, ModelName: "Invented", RunConfiguration: "{}", TemplateId: MODEL, CustomConfiguration: "{}" };
    const response = await plain.call("AIModelPublish", { body });
    assert.equal(response.status, 501);
    assert.equal(response.body.error.code, "0x80040216");
    assert.equal((await withPack.call("AIModelPublish", { body })).status, 204);
  });

  it("feedback loop requires model append-to and feedback create privileges", async () => {
    const basic = await start([], ["Basic User"]);
    try {
      const response = await basic.call(`msdyn_aimodels(${MODEL})/Microsoft.Dynamics.CRM.AddToFeedbackLoop`, { body: { inputName: "Denied" } });
      assert.equal(response.status, 403);
      assert.equal((basic.store.state.tables.msdyn_aibfeedbackloop ?? []).length, 0);
    } finally { await basic.api.close(); }
  });
});
