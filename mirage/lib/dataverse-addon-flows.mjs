// Power Automate desktop flows, flow machines, flow groups, plug-in generators and connector metadata: the 48 Power Automate
// messages of the native base-environment $metadata, plus LeaveGroup on flowmachine. Registered through
// registerAddon (dataverse-addon-common.mjs), so a trusted pack's dataverseMessages handler replaces any of them.
// Store-backed where a behaviour is modelled; every other message answers featureNotEnabled() or the internal-only default.
// Guesses: status values of flowsession and flowrun, the error codes of the rejected cases, and the response detail not in $metadata.
// ponytail: RunDesktopFlow completes on the next tick with the pack's result; no machine, no timeout and no run queue.
// ponytail: flow plug-ins, machines and connector metadata have no store behind them: pack handler or featureNotEnabled only.
import { randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { argsOf, featureNotEnabled, registerAddon, registerInternalMessage, respond } from "./dataverse-addon-common.mjs";
import { isLoopbackUrl, loopbackFetch } from "./dataverse-webhooks.mjs";

const key = (value) => String(value ?? "").toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const invalid = (message) => new DataError(message, 400, "InvalidRequest", { innerCode: "0x80040203" }); // native message not known
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { innerCode: "0x80040217" });
const RUN_OPEN = new Set(["Running", "Waiting", "Paused"]); // flowrun status values are guesses

// The operation list. bound(name, kind, entity, params, out) and unbound(name, kind, params, out); out is { response } or { returns }.
const unbound = (name, kind, params, out = {}) => ({ name, kind, binding: "unbound", signature: { params, ...out } });
const bound = (name, kind, entity, params, out = {}, binding = "entity") => ({ name, kind, binding, entity, signature: { params, ...out } });
const CRM = "mscrm.crmbaseentity";
const COLLECTION = (entity) => `Collection(mscrm.${entity})`;

// Pack or default messages and internal-only messages of the family. The store-backed ones are listed in operations().
const MESSAGES = [
  bound("AddRequiredDesktopFlowComponentsToSolutions", "action", "workflow", []),
  bound("AddRequiredUIElementCollectionComponentsToSolutions", "action", "desktopflowmodule", []),
  unbound("BatchGetFlowMachineStatus", "action", [["machineIds", "Edm.String"], ["version", "Edm.String"]], { response: [["machineStatuses", "Edm.String"]] }),
  unbound("BeginMachineImageProvisioning", "action", [["vmImageDescription", "Edm.String"], ["vmImageName", "Edm.String"], ["machineImageSource", CRM], ["sharedImageGalleryDestination", CRM]], { response: [["flowMachineImageVersionId", "Edm.Guid"], ["flowMachineImageId", "Edm.Guid"]] }),
  bound("CancelAllCloudFlowRuns", "action", "workflow", []),
  bound("CancelDesktopFlowRun", "action", "flowsession", []),
  bound("CreateFlowCredentialApplication", "action", "flowmachinegroup", [["certificate", "Edm.String"], ["password", "Edm.String"], ["applicationId", "Edm.String"], ["sharingtype", "Edm.String"], ["description", "Edm.String"]], { response: [["flowCredentialApplicationId", "Edm.Guid"]] }),
  bound("CreateFlowMachineNetwork", "action", "flowmachinenetwork", [["supportedscenario", "Edm.String"], ["subnet", "Edm.String"], ["type", "Edm.String"], ["name", "Edm.String"], ["extendedproperties", "Edm.String"], ["description", "Edm.String"]], { response: [["flowmachinenetworkid", "Edm.Guid"]] }, "collection"),
  unbound("CreateHostedFlowMachineGroup", "action", [["groupCredentials", "Edm.String"], ["groupManagedVersion", "Edm.String"], ["groupMachineNetworkId", CRM], ["groupUsageType", "Edm.String"], ["groupCapacityCount", "Edm.Int32"], ["groupDomainSetting", "Edm.String"], ["groupMaximumMachineCount", "Edm.Int32"], ["groupName", "Edm.String"], ["groupDescription", "Edm.String"], ["groupImage", "Edm.String"]], { response: [["response", "Edm.String"], ["flowMachineGroupId", "Edm.Guid"]] }),
  bound("CreateProcessWithWfomJson", "action", "workflow", [["Entity", CRM], ["WfomJson", "Edm.String"]]),
  unbound("CreateRpaBox", "action", [["machineImageVersionId", CRM], ["machineNetworkId", CRM], ["machineName", "Edm.String"], ["machineDescription", "Edm.String"]], { response: [["flowMachineId", "Edm.Guid"]] }),
  unbound("CreateVirtualConnectorTable", "action", [["CreateVirtualConnectorTableMetadata", "mscrm.CreateVirtualConnectorTableMetadata"]], { response: [["EntityId", "Edm.Guid"]] }),
  unbound("DeleteAutomatedPlugin", "action", [["pluginid", "Edm.String"]]),
  bound("DeleteFlowMachineGroup", "action", "flowmachinegroup", []),
  unbound("DeleteInstantPlugin", "action", [["FxExpressionUniqueName", "Edm.String"]]),
  unbound("GenerateAutomatedPlugin", "action", [["EntityLogicalName", "Edm.String"], ["MessageName", "Edm.String"], ["SolutionUniqueName", "Edm.String"], ["Context", "Edm.String"], ["Stage", "Edm.Int32"], ["Expression", "Edm.String"], ["Name", "Edm.String"]], { response: [["FxExpressionId", "Edm.Guid"], ["pluginid", "Edm.Guid"]] }),
  unbound("GenerateInstantPlugin", "action", [["Description", "Edm.String"], ["Context", "Edm.String"], ["Parameters", "Edm.String"], ["EntityLogicalName", "Edm.String"], ["SolutionUniqueName", "Edm.String"], ["Expression", "Edm.String"], ["Name", "Edm.String"]], { response: [["FxExpressionId", "Edm.Guid"], ["CustomApiId", "Edm.Guid"], ["msdyn_functionid", "Edm.Guid"]] }),
  unbound("GetHostedRpaCapacity", "function", [], { response: [["hostedGroupCount", "Edm.Int32"], ["hostedMachineGroupsBotCount", "Edm.Int32"], ["availableCapacity", "Edm.Int32"], ["failedToGetCapacity", "Edm.Boolean"], ["isPayGo", "Edm.Boolean"], ["hostedMachineCount", "Edm.Int32"], ["totalEnvironmentAddOns", "Edm.Int32"]] }),
  bound("GetNextRuns", "function", "flowtrigger", [["workflowIds", "Edm.String"], ["runCount", "Edm.Int32"], ["startTime", "Edm.DateTimeOffset"], ["connectionReferenceIds", "Edm.String"], ["triggerIds", "Edm.String"]], { response: [["response", "Edm.String"]] }, "collection"),
  bound("GetNextRunsForFlowTrigger", "function", "flowtrigger", [], { response: [["response", "Edm.String"]] }),
  bound("GetPublicKey", "action", "flowmachinegroup", [], { response: [["groupPublicKey", "Edm.String"], ["groupSecondaryPublicKey", "Edm.String"]] }),
  bound("GetRunMap", "action", "businessprocess", [["continuationToken", "Edm.String"], ["runId", "Edm.Guid"], ["max", "Edm.Int32"]], { response: [["runMap", "Edm.String"], ["continuationToken", "Edm.String"]] }),
  bound("InitializeModernFlowFromAsyncWorkflow", "action", "workflow", [], { returns: "mscrm.workflow" }), // documented "For internal use only."
  bound("ListChildDesktopFlows", "action", "workflow", [], { response: [["childFlows", "Edm.String"]] }),
  bound("ListConnectionReferences", "action", "workflow", [], { response: [["connections", "Edm.String"], ["connectionReferences", "Edm.String"], ["mappingBetweenLogicalNameAndName", "Edm.String"]] }),
  bound("ListCredentialDependencies", "function", "credential", [], { response: [["response", "Edm.String"]] }),
  bound("ListFlowsInFlowGroup", "function", "flowgroup", [], { returns: COLLECTION("crmbaseentity") }),
  unbound("PowerAutomateProxy", "action", [["HttpMethod", "Edm.String"], ["RelativeUrl", "Edm.String"], ["RequestHeaders", "Edm.String"], ["RequestBody", "Edm.String"]], { response: [["HttpStatusCode", "Edm.Int32"], ["ResponseHeaders", "Edm.String"], ["ResponseBody", "Edm.String"]] }),
  unbound("RefreshRpaLicensingCapacity", "action", [], { response: [["response", "Edm.String"]] }),
  unbound("RegisterFlowMachine", "action", [["machineName", "Edm.String"], ["machineDescription", "Edm.String"], ["machineCapacity", "Edm.Int32"], ["agentVersion", "Edm.String"], ["groupPublicKey", "Edm.String"], ["hostingType", "Edm.Int32"], ["targetGroup", CRM], ["pictureInPictureSupport", "Edm.Int32"], ["machineDomain", "Edm.String"]], { response: [["groupId", "Edm.String"], ["machineId", "Edm.String"], ["relayListenKeys", "Edm.String"]] }),
  bound("RemoveFlowFromFlowGroup", "action", "flowgroup", [["workflowId", "Edm.Guid"]]),
  bound("RestartHostedMachine", "action", "flowmachine", []),
  unbound("RetrieveConnectorActions", "action", [["ConnectionReference", CRM]], { returns: COLLECTION("crmbaseentity") }),
  unbound("RetrieveConnectorSettings", "action", [], { returns: COLLECTION("crmbaseentity") }),
  unbound("RetrieveFlowUpdates", "action", [["ObjectId", "Edm.String"]], { returns: COLLECTION("crmbaseentity") }),
  unbound("RetrievePowerAppsConnections", "action", [], { returns: COLLECTION("crmbaseentity") }),
  unbound("RetrievePowerAppsConnectorApis", "action", [], { returns: COLLECTION("crmbaseentity") }),
  bound("RetrieveProcessWithWfomJson", "function", "workflow", [], { response: [["WfomJson", "Edm.String"]] }),
  bound("RotateGroupKey", "action", "flowmachinegroup", []),
  bound("RunDesktopFlow", "action", "workflow", [["timeout", "Edm.Int32"], ["callbackUrl", "Edm.String"], ["connectionName", "Edm.String"], ["inputs", "Edm.String"], ["connectionType", "Edm.Int32"], ["runPriority", "Edm.String"], ["runMode", "Edm.String"]], { response: [["flowsessionId", "Edm.Guid"]] }),
  bound("SaveAsDesktopFlow", "action", "workflow", [["desktopFlowName", "Edm.String"]], { response: [["workflowId", "Edm.Guid"]] }),
  bound("SaveAsDesktopFlowModule", "action", "desktopflowmodule", [["desktopFlowModuleName", "Edm.String"]], { response: [["desktopflowmoduleid", "Edm.Guid"]] }),
  bound("TriggerDesktopFlowRunCallback", "action", "flowsession", [], { response: [["callbackHttpResponseCode", "Edm.Int32"]] }),
  bound("UpdateAccountCredentials", "action", "flowmachinegroup", [["groupCredentials", "Edm.String"]]),
  unbound("UpdateAutomatedPlugin", "action", [["FxExpressionUniqueName", "Edm.String"], ["Name", "Edm.String"], ["SolutionUniqueName", "Edm.String"], ["EntityLogicalName", "Edm.String"], ["MessageName", "Edm.String"], ["Context", "Edm.String"], ["Expression", "Edm.String"], ["Stage", "Edm.Int32"]]),
  bound("UpdateFlowMachineNetwork", "action", "flowmachinenetwork", [["extendedproperties", "Edm.String"], ["name", "Edm.String"], ["description", "Edm.String"]]),
  unbound("UpdateInstantPlugin", "action", [["Name", "Edm.String"], ["Parameters", "Edm.String"], ["EntityLogicalName", "Edm.String"], ["SolutionUniqueName", "Edm.String"], ["Context", "Edm.String"], ["Expression", "Edm.String"], ["FxExpressionUniqueName", "Edm.String"], ["Description", "Edm.String"]]),
  bound("UpdateProcessWithWfomJson", "action", "workflow", [["Entity", CRM], ["WfomJson", "Edm.String"]]),
  // LeaveGroup is the store-backed flowmachine message of the same contract.
  bound("LeaveGroup", "action", "flowmachine", []),
];

const INTERNAL = new Set(["InitializeModernFlowFromAsyncWorkflow"]);

function operations(api) {
  const { store } = api;
  const tableOf = (logical) => (store.state.tables[logical] ??= []);
  const rowOf = (logical, id) => tableOf(logical).find((row) => sameId(row[`${logical}id`], id)) ?? null;
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const stamp = () => new Date(api.clock()).toISOString();
  // Removes by primary key: a row read before the transaction is a copy of the state row, not the state row itself.
  const removeRow = (logical, row) => {
    const list = tableOf(logical);
    const index = list.findIndex((item) => sameId(item[`${logical}id`], row[`${logical}id`]));
    if (index >= 0) list.splice(index, 1);
  };
  // The bound row. The router has already answered 404 for an unknown id (dataverse-api.mjs); this finds the state row to write.
  const boundRow = (c, logical) => {
    const row = rowOf(logical, c.target?.id);
    if (!row) throw notFound(logical, c.target?.id);
    return row;
  };

  // AddRequired*: the target is already a member of its solutions. The required components of a desktop flow are workflow and
  // module rows, which the registry's AddSolutionComponent cannot add (it covers metadata components only), so nothing is added.
  // ponytail: no solution component rows for the required flow components; add when AddSolutionComponent takes workflow rows.
  const addRequired = (logical) => async (c) => {
    boundRow(c, logical);
    return undefined;
  };

  // Clone of a row under a new id and name (SaveAs*). The cloned statecode and statuscode are guesses.
  const saveAs = (logical, nameField, responseKey) => async (c) => {
    const source = boundRow(c, logical);
    const id = randomUUID();
    const name = argsOf(c)[nameField] ?? null;
    await write(() => tableOf(logical).push({ ...source, [`${logical}id`]: id, name, statecode: 0, statuscode: 1 }));
    return { [responseKey]: id };
  };

  // RunDesktopFlow: a session row (Running), then the pack's handler on a later tick, then Succeeded (4) or Failed (8).
  // registerAddon would answer the pack's raw result, so RunDesktopFlow is registered by runDesktopFlow below.
  const runSession = async (c, packed, workflow, sessionId) => {
    const args = argsOf(c);
    let statuscode = 4;
    let outputs = null;
    try {
      const result = await packed.handler({ name: "RunDesktopFlow", args, target: { logicalName: "workflow", id: workflow.workflowid, row: workflow }, caller: c.caller, user: c.user, origin: c.origin, version: c.version, api });
      outputs = result?.outputs ?? null;
      if (result?.status === "Failed") statuscode = 8;
    } catch {
      statuscode = 8;
    }
    await write(() => Object.assign(rowOf("flowsession", sessionId), { statuscode, completedon: stamp(), outputs: outputs === null ? null : JSON.stringify(outputs) }));
    // The callback is posted to loopback only (dataverse-webhooks.mjs isLoopbackUrl); a failed post changes nothing.
    if (args.callbackUrl && isLoopbackUrl(args.callbackUrl)) {
      await loopbackFetch(args.callbackUrl, { method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json" }, body: JSON.stringify({ flowsessionId: sessionId, statuscode }) }).catch(() => {});
    }
  };

  const handlers = {
    AddRequiredDesktopFlowComponentsToSolutions: addRequired("workflow"),
    AddRequiredUIElementCollectionComponentsToSolutions: addRequired("desktopflowmodule"),

    // With the host's flow run store (api.flowRuns, flow-runs.mjs) its Running and Waiting runs are cancelled there, which
    // also stops their wait timers and cancels pending approvals; other open flowrun rows are cancelled in place.
    CancelAllCloudFlowRuns: async (c) => {
      const workflow = boundRow(c, "workflow");
      // One write: the flow run store's writes join it (nested), so a failure in either step cancels nothing.
      await write(async () => {
        if (api.flowRuns) await api.flowRuns.cancelAll(workflow.workflowid);
        for (const run of tableOf("flowrun")) if (sameId(run.workflowid, workflow.workflowid) && RUN_OPEN.has(run.status)) run.status = "Cancelled";
      });
      return undefined;
    },

    // Only a session that is Paused, Running or Waiting (statuscode 1, 2, 3) can be cancelled. The rejection is a guess.
    CancelDesktopFlowRun: async (c) => {
      const session = boundRow(c, "flowsession");
      if (![1, 2, 3].includes(session.statuscode)) throw invalid("The desktop flow run is not active and cannot be cancelled.");
      await write(() => Object.assign(rowOf("flowsession", session.flowsessionid), { statuscode: 7, completedon: stamp() }));
      return undefined;
    },

    DeleteFlowMachineGroup: async (c) => {
      const group = boundRow(c, "flowmachinegroup");
      if (tableOf("flowmachine").some((machine) => sameId(machine.flowmachinegroupid, group.flowmachinegroupid))) {
        throw invalid("The flow machine group still has machines."); // native message and code not known
      }
      await write(() => removeRow("flowmachinegroup", group));
      return undefined;
    },

    LeaveGroup: async (c) => {
      const machine = boundRow(c, "flowmachine");
      const groupId = randomUUID();
      await write(() => {
        tableOf("flowmachinegroup").push({ flowmachinegroupid: groupId, name: "Default", statecode: 0, statuscode: 1 }); // the group name is a guess
        rowOf("flowmachine", machine.flowmachineid).flowmachinegroupid = groupId;
      });
      return undefined;
    },

    SaveAsDesktopFlow: saveAs("workflow", "desktopFlowName", "workflowId"),
    SaveAsDesktopFlowModule: saveAs("desktopflowmodule", "desktopFlowModuleName", "desktopflowmoduleid"),
  };
  return { handlers, boundRow, tableOf, write, stamp, runSession };
}

// RunDesktopFlow: the pack path creates the session before answering. Without a pack handler the call answers 404 for an
// unknown connection reference (connectionType 2), else the feature is not enabled (no machine).
function registerRunDesktopFlow(api, spec, { boundRow, tableOf, write, stamp, runSession }) {
  const name = spec.name;
  api.registry.register({
    ...spec,
    handle: async (c) => {
      const workflow = boundRow(c, "workflow");
      const args = argsOf(c);
      const packed = api.addonHandlers?.get(name);
      if (!packed) {
        const known = tableOf("connectionreference").some((row) => key(row.connectionreferencelogicalname) === key(args.connectionName));
        if (args.connectionType === 2 && args.connectionName && !known) {
          throw new DataError(`Connection reference ${args.connectionName} does not exist.`, 404, "NotFound", { innerCode: "0x80040217" }); // native message not known
        }
        throw featureNotEnabled();
      }
      const sessionId = randomUUID();
      await write(() =>
        tableOf("flowsession").push({
          flowsessionid: sessionId, regardingobjectid: workflow.workflowid, regardingobjecttypecode: "workflow", parentworkflowid: workflow.workflowid,
          triggertype: 3, statuscode: 2, createdon: stamp(), outputs: null,
        }),
      );
      setImmediate(() => runSession(c, packed, workflow, sessionId).catch(() => {}));
      return respond(c, name, { flowsessionId: sessionId, licenseCheck: { code: "ValidLicenseCoverage", message: "Valid License Coverage" } }); // licenseCheck is a guess
    },
  });
}

export function install(api) {
  const ops = operations(api);
  for (const spec of MESSAGES) {
    if (spec.name === "RunDesktopFlow") {
      registerRunDesktopFlow(api, spec, ops);
      continue;
    }
    const handle = ops.handlers[spec.name];
    if (INTERNAL.has(spec.name)) registerInternalMessage(api, { ...spec, handle });
    else registerAddon(api, { ...spec, handle, fallback: featureNotEnabled });
  }
}

export const EXTENSION = { name: "dataverse-addon-flows", install };
