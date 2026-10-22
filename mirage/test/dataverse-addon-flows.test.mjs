// Desktop flow messages (lib/dataverse-addon-flows.mjs) over HTTP: run with a pack handler, run without one, cancel, save as,
// leave group and the flow machine groups. Invented flow, machine and group rows, loopback only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { addonHandlerExtension, addonHandlers } from "../lib/dataverse-addon-common.mjs";
import { install } from "../lib/dataverse-addon-flows.mjs";
import { createFlowRunStore } from "../lib/flow-runs.mjs";

const APP_ID = "66666666-6666-6666-6666-666666666666";
const SECRET_VAR = "PAQVILO_FLOWS_SECRET";
const VERSION = "v9.2";
const id = (n) => `a1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const W = { run: id(1), handled: id(2), cancel: id(3), saveAs: id(4), addRequired: id(5), runs: id(6) };
const S = { running: id(10), done: id(11), paused: id(12) };
const G = { busy: id(20), empty: id(21), leave: id(22) };
const M = { leave: id(30), busy: id(31) };
const MODULE = id(40);
const SOLUTION = id(50);

const SEED = {
  workflow: [
    { workflowid: W.run, name: "Invented flow run", statecode: 1, statuscode: 2, category: 6 },
    { workflowid: W.handled, name: "Invented flow with handler", statecode: 1, statuscode: 2 },
    { workflowid: W.cancel, name: "Invented flow cancel", statecode: 1, statuscode: 2 },
    { workflowid: W.saveAs, name: "Invented flow to copy", statecode: 1, statuscode: 2, uniquename: "contoso_copy" },
    { workflowid: W.addRequired, name: "Invented flow in solution", statecode: 1, statuscode: 2 },
    { workflowid: W.runs, name: "Invented flow with runs", statecode: 1, statuscode: 2 },
  ],
  flowsession: [
    { flowsessionid: S.running, regardingobjectid: W.cancel, statuscode: 2, statecode: 0, triggertype: 3 },
    { flowsessionid: S.done, regardingobjectid: W.cancel, statuscode: 4, statecode: 1, triggertype: 3 },
    { flowsessionid: S.paused, regardingobjectid: W.cancel, statuscode: 1, statecode: 0, triggertype: 3 },
  ],
  flowmachinegroup: [
    { flowmachinegroupid: G.busy, name: "Invented busy group", statecode: 0, statuscode: 1 },
    { flowmachinegroupid: G.empty, name: "Invented empty group", statecode: 0, statuscode: 1 },
    { flowmachinegroupid: G.leave, name: "Invented group to leave", statecode: 0, statuscode: 1 },
  ],
  flowmachine: [
    { flowmachineid: M.leave, name: "Invented machine", flowmachinegroupid: G.leave, statecode: 0, statuscode: 1 },
    { flowmachineid: M.busy, name: "Invented machine in busy group", flowmachinegroupid: G.busy, statecode: 0, statuscode: 1 },
  ],
  desktopflowmodule: [{ desktopflowmoduleid: MODULE, name: "Invented module", statecode: 0, statuscode: 1 }],
  solution: [{ solutionid: SOLUTION, uniquename: "contoso_solution", statecode: 0, statuscode: 1 }],
  solutioncomponent: [{ solutioncomponentid: id(60), solutionid: SOLUTION, objectid: W.addRequired, componenttype: 29 }],
  flowrun: [{ flowrunid: id(70), workflowid: W.runs, name: "Invented run", status: "Running" }],
};

const handlerPack = {
  id: "flows-pack",
  dataverseMessages: {
    RunDesktopFlow: async (ctx) => ({ status: "Succeeded", outputs: { echo: ctx.args.inputs ?? null } }),
  },
};

describe("desktop flow messages over HTTP", () => {
  let api;
  let store;
  let token;

  // A started API with the given packs and the seed rows. Returns its store and token; the main API's pair is kept in the vars.
  async function start(packs) {
    process.env[SECRET_VAR] = "flows-secret";
    const seeded = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [{ appId: APP_ID, displayName: "Flows app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
    });
    const started = await startDataverseApi({
      store: seeded,
      settings,
      log: () => {},
      extensions: [...EXTENSIONS, addonHandlerExtension(addonHandlers(packs))],
    });
    const response = await fetch(`${started.origin}/${started.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${started.origin}/.default` }),
    });
    const accessToken = (await response.json()).access_token;
    await seeded.transact(() => {
      for (const [logical, rows] of Object.entries(SEED)) {
        seeded.state.tables[logical] ??= [];
        seeded.state.tables[logical].push(...rows);
      }
    });
    return { started, accessToken, store: seeded };
  }

  before(async () => {
    const withPack = await start([handlerPack]);
    api = withPack.started;
    token = withPack.accessToken;
    store = withPack.store;
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  // A bound call: POST <entitySet>(<id>)/Microsoft.Dynamics.CRM.<name>. Returns the status and the JSON body.
  async function call(set, key, name, body = {}) {
    const result = await fetch(`${api.origin}/api/data/${VERSION}/${set}(${key})/Microsoft.Dynamics.CRM.${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await result.text();
    return { status: result.status, body: text ? JSON.parse(text) : null };
  }
  const rowOf = (logical, pk, value) => store.state.tables[logical].find((row) => row[pk] === value);
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
  };

  it("every flow message is declared in $metadata", async () => {
    const metadata = await (await fetch(`${api.origin}/api/data/${VERSION}/$metadata`, { headers: { authorization: `Bearer ${token}` } })).text();
    for (const name of ["RunDesktopFlow", "CancelDesktopFlowRun", "SaveAsDesktopFlow", "LeaveGroup", "GetHostedRpaCapacity", "RetrieveConnectorSettings"]) {
      assert.match(metadata, new RegExp(`Name="${name}"`), name);
    }
    assert.match(metadata, /Name="RunDesktopFlowResponse"/);
  });

  it("run creates a session and the pack handler completes it", async () => {
    const result = await call("workflows", W.handled, "RunDesktopFlow", { inputs: '{"a":1}', connectionType: 1, timeout: 60 });
    assert.equal(result.status, 200);
    assert.match(result.body.flowsessionId, /^[0-9a-f-]{36}$/);
    assert.equal(result.body.licenseCheck.code, "ValidLicenseCoverage");
    const session = () => rowOf("flowsession", "flowsessionid", result.body.flowsessionId);
    assert.equal(session().regardingobjectid, W.handled);
    assert.equal(session().triggertype, 3);
    assert.ok(await waitFor(() => session().statuscode !== 2), "the session leaves Running");
    assert.equal(session().statuscode, 4);
    assert.equal(session().outputs, '{"echo":"{\\"a\\":1}"}');
    assert.ok(session().completedon);
  });

  it("run without a handler is FeatureNotEnabled", async () => {
    const bare = await start([]);
    try {
      const result = await fetch(`${bare.started.origin}/api/data/${VERSION}/workflows(${W.run})/Microsoft.Dynamics.CRM.RunDesktopFlow`, {
        method: "POST",
        headers: { authorization: `Bearer ${bare.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ connectionType: 1 }),
      });
      const body = await result.json();
      assert.equal(result.status, 400);
      assert.equal(body.error.message, "This operation couldn't be completed because this feature isn’t enabled for your organization.");
    } finally {
      await bare.started.close();
    }
  });

  it("cancel sets Cancelled only from Paused, Running or Waiting", async () => {
    const result = await call("flowsessions", S.running, "CancelDesktopFlowRun");
    assert.equal(result.status, 204);
    assert.equal(rowOf("flowsession", "flowsessionid", S.running).statuscode, 7);
    assert.ok(rowOf("flowsession", "flowsessionid", S.running).completedon);
    assert.equal((await call("flowsessions", S.paused, "CancelDesktopFlowRun")).status, 204);
    assert.equal((await call("flowsessions", S.done, "CancelDesktopFlowRun")).status, 400);
    assert.equal(rowOf("flowsession", "flowsessionid", S.done).statuscode, 4);
  });

  it("save as clones the flow under a new id and name", async () => {
    const result = await call("workflows", W.saveAs, "SaveAsDesktopFlow", { desktopFlowName: "Invented copy" });
    assert.equal(result.status, 200);
    const copy = rowOf("workflow", "workflowid", result.body.workflowId);
    assert.equal(copy.name, "Invented copy");
    assert.equal(copy.statecode, 0);
    assert.notEqual(copy.workflowid, W.saveAs);
    assert.ok(rowOf("workflow", "workflowid", W.saveAs), "the source stays");
    const module = await call("desktopflowmodules", MODULE, "SaveAsDesktopFlowModule", { desktopFlowModuleName: "Invented module copy" });
    assert.equal(module.status, 200);
    assert.equal(rowOf("desktopflowmodule", "desktopflowmoduleid", module.body.desktopflowmoduleid).name, "Invented module copy");
  });

  it("add required components adds the flow to its solutions with the required components", async () => {
    const result = await call("workflows", W.addRequired, "AddRequiredDesktopFlowComponentsToSolutions");
    assert.equal(result.status, 204);
    assert.equal(store.state.tables.solutioncomponent.filter((row) => row.objectid === W.addRequired).length, 1);
  });

  it("cancel all cloud flow runs cancels the open runs of the flow", async () => {
    const result = await call("workflows", W.runs, "CancelAllCloudFlowRuns");
    assert.equal(result.status, 204);
    assert.equal(rowOf("flowrun", "flowrunid", id(70)).status, "Cancelled");
  });

  it("leave group creates a default group and moves the machine to it", async () => {
    const result = await call("flowmachines", M.leave, "LeaveGroup");
    assert.equal(result.status, 204);
    const machine = rowOf("flowmachine", "flowmachineid", M.leave);
    assert.notEqual(machine.flowmachinegroupid, G.leave);
    assert.ok(rowOf("flowmachinegroup", "flowmachinegroupid", machine.flowmachinegroupid), "the new group exists");
  });

  it("delete flow machine group refuses a group that still has machines", async () => {
    const busy = await call("flowmachinegroups", G.busy, "DeleteFlowMachineGroup");
    assert.equal(busy.status, 400);
    assert.ok(rowOf("flowmachinegroup", "flowmachinegroupid", G.busy));
    const empty = await call("flowmachinegroups", G.empty, "DeleteFlowMachineGroup");
    assert.equal(empty.status, 204);
    assert.equal(rowOf("flowmachinegroup", "flowmachinegroupid", G.empty), undefined);
  });
});

describe("cancel all cloud flow runs is one write", () => {
  it("a fault after the flow run store cancels nothing: the cancel rolls back with the row write", async () => {
    const state = emptyState();
    state.tables.workflow = [{ workflowid: W.runs, name: "Invented flow with runs", statecode: 1, statuscode: 2 }];
    state.tables.flowrun = [{ flowrunid: id(71), workflowid: W.runs, name: "Invented open row", status: "Running" }];
    const store = await new DataStore({ state }).init();
    const flowRuns = createFlowRunStore({ store, diagnostic: () => {} });
    const run = await flowRuns.start({ processId: W.runs });
    // The second step cannot read a row: the poisoned row is appended after the flow run cancel, so the row loop throws.
    const cancelAll = flowRuns.cancelAll;
    flowRuns.cancelAll = async (processId) => {
      const count = await cancelAll(processId);
      const poisoned = { flowrunid: id(72), name: "Invented poisoned row", status: "Running" };
      Object.defineProperty(poisoned, "workflowid", { enumerable: true, get() { throw new Error("Invented fault"); } });
      store.state.tables.flowrun.push(poisoned);
      return count;
    };
    const registered = new Map();
    const api = { store, clock: () => 0, change: (fn) => fn(), flowRuns, registry: { register: (spec) => registered.set(spec.name, spec) } };
    install(api);
    await assert.rejects(registered.get("CancelAllCloudFlowRuns").handle({ target: { id: W.runs } }), /Invented fault/);
    assert.equal(flowRuns.get(run.id).status, "Running", "the flow run cancel rolled back");
    assert.equal(store.state.tables.flowrun.find((row) => row.flowrunid === id(71)).status, "Running");
  });
});
