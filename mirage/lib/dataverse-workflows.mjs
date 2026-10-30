import { organizationRecord } from './organization-context.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { createRequestContext, currentRequest, runWithRequest } from './request-context.mjs';
// Workflows in the Dataverse API: workflow rows from the Solution's Workflows folder with their activation rows, the
// activation rules on PATCH, ExecuteWorkflow, the run of a classic workflow and the classic triggers on writes (background
// jobs from committed writes, real-time runs inside the write).
//  - A classic workflow (category 0) is XAML. Mirage never interprets it: a run is a trusted pack handler (the `workflows`
//    export), a mock, or a placeholder that ends the job Canceled. Its writes are one store transaction.
//  - A cloud flow (category 5) runs its exported definition through flow-runtime, as a job. Its activation is the workflow
//    row's statecode, which workflowsWithActivation copies onto the exported flow map (the portal trigger path reads that map).
import { systemIds } from './runtime-clock.mjs';
import path from 'node:path';
import { DataError } from './data-error.mjs';
import { invokeTrustedHandler } from './trusted-handler-invocation.mjs';
import { descendants, parseSolutionXml } from './solution-xml.mjs';
import { solutionLayerFiles } from './solution-content-fingerprint.mjs';
import { contextUrl, dataverseError } from './dataverse-odata.mjs';
import { ownerColumns, uuidV5 } from './dataverse-security.mjs';
import { committedJobs, liveJob, stageCommittedJobs, traceJob } from './committed-work.mjs';
import { runTrackedFlow, inspectFlowTrigger } from './flow-runtime.mjs';
import { pluginStepBypassed, pluginBypassOwnership } from './plugin-bypass.mjs';

const CATEGORY_WORKFLOW = 0;
const CATEGORY_MODERN_FLOW = 5;
const TYPE = { definition: 1, activation: 2, template: 3 };
const STATE_ACTIVATED = 1;
const STATUS = { draft: 1, activated: 2 };
const JOB_TYPE = 10; // asyncoperation.operationtype: Workflow
const JOB_STATUS = { succeeded: 30, failed: 31, canceled: 32 };
const LOG_STATUS = { succeeded: 2, failed: 3, canceled: 4 }; // workflowlog.status
const DEPTH_LIMIT = 16; // a chain of workflow runs deeper than this is canceled (0x80044182)
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const workflowBypassFacts = new WeakMap();
const FILE_LIMIT = 1024 * 1024;
const COMMON = [
  'name',
  'uniquename',
  'category',
  'mode',
  'scope',
  'ondemand',
  'subprocess',
  'triggeroncreate',
  'triggerondelete',
  'triggeronupdateattributelist',
  'primaryentity',
  'runas',
  'istransacted',
  'asyncautodelete',
  'syncworkflowlogonfailure',
  'processtriggerscope',
  'processtriggerformid',
];
const PLACEHOLDER_MESSAGE =
  'Simulator: classic workflow XAML is not executed; register a trusted pack workflow handler or a mock.';
const DISABLED_MESSAGE = 'Simulator: classic workflow is disabled in this simulator.';
const PLACEHOLDER_CANCEL = 'Simulator: operation has no local simulation; the job is canceled.';
const DEPTH_MESSAGE =
  'This workflow job was canceled because the workflow that started it included an infinite loop. Correct the workflow logic and try again. For information about workflow logic, see Help.';
const NOT_SUPPORTED_XAML = 'Creating a classic workflow with XAML through the Web API is not supported with Dataverse.';
const EXECUTE_ROUTE = /^\/api\/data\/v[\d.]+\/workflows\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.ExecuteWorkflow$/i;
const EXECUTE_CSDL = `<Action Name="ExecuteWorkflow" IsBound="true">
  <Parameter Name="entity" Type="mscrm.workflow" />
  <Parameter Name="EntityId" Type="Edm.Guid" Nullable="false" />
  <Parameter Name="InputArguments" Type="mscrm.InputArgumentCollection" />
  <ReturnType Type="mscrm.asyncoperation" />
</Action>`;

const bare = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const isGuid = (value) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const sameId = (a, b) => bare(a) === bare(b);
const lookup = (logical, id) => ({ id, logical_name: logical });
const lookupId = (value) => bare(value?.id ?? value);
const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });
const native = (innerCode, message) => new DataError(message, 400, 'InvalidRequest', { innerCode });
const flag = (value) =>
  ['1', 'true'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
const numeric = (value, fallback) =>
  value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value);
const stateOf = (value) => {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text === 'activated') return STATE_ACTIVATED;
  if (text === 'suspended') return 2;
  return numeric(value, 0);
};
const organizationIdOf = (store) => organizationRecord(store)?.organizationid;
const rowsOf = (store, logical) => (store.state.tables[logical] ??= []);
const workflowRow = (store, id) => rowsOf(store, 'workflow').find((row) => sameId(row.workflowid, id)) ?? null;
const activationOf = (store, id) =>
  rowsOf(store, 'workflow').find(
    (row) => Number(row.type) === TYPE.activation && sameId(lookupId(row.parentworkflowid), id),
  ) ?? null;
const activationIdOf = (organizationId, id) => uuidV5(organizationId, `workflow-activation:${bare(id)}`);
const errorNumber = (error) => {
  const code = dataverseError(error, {}).body?.error?.code;
  return /^0x[0-9a-f]+$/i.test(code ?? '') ? Number.parseInt(code, 16) | 0 : 0;
};
// A job ends Canceled when its work throws this error (jobStatus is read by dataverse-async systemJob and runBackgroundJob); failure ends it Failed.
const canceled = (message, innerCode = '0x0') =>
  Object.assign(new DataError(message, 400, 'InvalidRequest', { innerCode }), { jobStatus: JOB_STATUS.canceled });
const failure = (message) => new DataError(message, 400, 'InvalidRequest', { innerCode: '0x0' });

// ---- Solution sources

// A field of a Workflow element: an attribute or a child element, matched without case.
function fieldOf(node, name) {
  const lower = name.toLowerCase();
  const attr = Object.entries(node?.attrs ?? {}).find(([key]) => key.toLowerCase() === lower);
  if (attr) return attr[1];
  const element = (node?.children ?? []).find((item) => item.name.toLowerCase() === lower);
  return element ? element.text.trim() : null;
}

// One companion file of a Workflows folder, matched by base name without case, as text within the size limit.
function companionText(files, fileName) {
  if (!fileName) return null;
  const file = files.get(path.basename(String(fileName).replace(/\\/g, '/')).toLowerCase());
  try {
    return file ? file.read(FILE_LIMIT).toString('utf8') : null;
  } catch {
    return null;
  }
}

/**
 * The workflow facts of the Solution sources: every Workflows/*.data.xml with a WorkflowId, its XAML (classic) or JSON
 * (cloud flow) text. The folder name matches without case, in a directory or a Solution ZIP layer (solutionLayerFiles).
 * Facts are plain values; seedWorkflows turns them into rows.
 */
export async function readSolutionWorkflows(layers = [], { diagnostic = () => {} } = {}) {
  const facts = [];
  for (const layer of layers) {
    if (!layer.dir) continue;
    let files;
    try {
      files = solutionLayerFiles(layer, /^workflows$/i).filter((file) => /^[^/]+\/[^/]+$/.test(file.name));
    } catch (error) {
      diagnostic({ code: 'SOLUTION_LAYER_COMPONENTS_UNREADABLE', source: layer.dir, message: error.message });
      continue;
    }
    const byName = new Map(files.map((file) => [file.name.slice(file.name.indexOf('/') + 1).toLowerCase(), file]));
    for (const file of files) {
      const name = file.name.slice(file.name.indexOf('/') + 1);
      if (!/\.data\.xml$/i.test(name)) continue;
      let xml;
      try {
        xml = parseSolutionXml(file.read(FILE_LIMIT).toString('utf8'));
      } catch {
        continue;
      }
      const node = descendants(xml, 'Workflow')[0] ?? xml;
      const id = bare(fieldOf(node, 'WorkflowId'));
      if (!isGuid(id)) continue;
      const stem = name.replace(/\.data\.xml$/i, '');
      const xaml = companionText(byName, fieldOf(node, 'XamlFileName') ?? (/\.json$/i.test(stem) ? null : stem));
      const json = companionText(byName, fieldOf(node, 'JsonFileName') ?? (/\.json$/i.test(stem) ? stem : null));
      facts.push({
        id,
        name: fieldOf(node, 'Name') ?? fieldOf(node, 'UniqueName') ?? id,
        uniquename: fieldOf(node, 'UniqueName'),
        customizationLevel: numeric(fieldOf(node, 'CustomizationLevel'), null),
        category: numeric(fieldOf(node, 'Category'), json !== null ? CATEGORY_MODERN_FLOW : CATEGORY_WORKFLOW),
        type: numeric(fieldOf(node, 'Type'), TYPE.definition),
        mode: numeric(fieldOf(node, 'Mode'), 0),
        scope: numeric(fieldOf(node, 'Scope'), 4),
        ondemand: flag(fieldOf(node, 'OnDemand')),
        subprocess: flag(fieldOf(node, 'Subprocess')),
        triggeroncreate: flag(fieldOf(node, 'TriggerOnCreate')),
        triggerondelete: flag(fieldOf(node, 'TriggerOnDelete')),
        triggeronupdateattributelist: fieldOf(node, 'TriggerOnUpdateAttributeList') || null,
        primaryentity: fieldOf(node, 'PrimaryEntity') || null,
        state: stateOf(fieldOf(node, 'StateCode')),
        runas: numeric(fieldOf(node, 'RunAs'), 0),
        istransacted: flag(fieldOf(node, 'IsTransacted')),
        asyncautodelete: flag(fieldOf(node, 'AsyncAutodelete')),
        syncworkflowlogonfailure: flag(fieldOf(node, 'SyncWorkflowLogOnFailure')),
        // Business rules (category 2) run on the server only for scope 2 (Entity); the form id scopes a Form rule.
        processtriggerscope: numeric(fieldOf(node, 'ProcessTriggerScope'), null),
        processtriggerformid: isGuid(bare(fieldOf(node, 'ProcessTriggerFormId')))
          ? bare(fieldOf(node, 'ProcessTriggerFormId'))
          : null,
        xaml,
        clientdata: json,
      });
    }
  }
  return facts;
}

// The definition row and, when activated, its activation row (type 2, parentworkflowid = the definition).
function rowsOfFacts(facts, organizationId) {
  const rows = [];
  for (const fact of facts) {
    const activationId = activationIdOf(organizationId, fact.id);
    const active = fact.state === STATE_ACTIVATED;
    const common = Object.fromEntries(COMMON.map((key) => [key, fact[key] ?? null]));
    rows.push({
      workflowid: fact.id,
      workflowidunique: uuidV5(organizationId, `workflowidunique:${fact.id}`),
      ...common,
      type: fact.type,
      statecode: fact.state,
      statuscode: active ? STATUS.activated : STATUS.draft,
      ...(fact.xaml !== null ? { xaml: fact.xaml } : {}),
      ...(fact.clientdata !== null ? { clientdata: fact.clientdata } : {}),
      activeworkflowid: active ? lookup('workflow', activationId) : null,
    });
    if (active) rows.push(activationRowOf(fact, fact.id, activationId, organizationId));
  }
  return rows;
}

// An activation row copies the definition's trigger and execution columns, and points back at it.
function activationRowOf(definition, id, activationId) {
  return {
    workflowid: activationId,
    ...Object.fromEntries(COMMON.map((key) => [key, definition[key] ?? null])),
    type: TYPE.activation,
    parentworkflowid: lookup('workflow', bare(id)),
    statecode: STATE_ACTIVATED,
    statuscode: STATUS.activated,
  };
}

// Solution rows win on reseed: a Solution definition's row, and the activation rows of a Solution definition, are replaced.
// A definition an earlier seed wrote (state.dataverse.sourceSeeded.workflow) that is gone from the sources is removed with its
// activation rows, as a Solution upgrade removes absent components. Returns { added, changed, removed }.
function seedWorkflows(store, facts) {
  const organizationId = organizationIdOf(store);
  const counts = { added: 0, changed: 0, removed: 0 };
  if (!organizationId) return counts;
  const table = rowsOf(store, 'workflow');
  const seeded = ((store.state.dataverse ??= {}).sourceSeeded ??= {});
  const ids = new Set(facts.map((fact) => fact.id));
  const gone = new Set((seeded.workflow ?? []).filter((id) => !ids.has(id)));
  const present = new Set(
    table.filter((row) => Number(row.type) !== TYPE.activation).map((row) => bare(row.workflowid)),
  );
  for (let index = table.length - 1; index >= 0; index -= 1) {
    const row = table[index],
      id = bare(row.workflowid),
      parent = Number(row.type) === TYPE.activation ? lookupId(row.parentworkflowid) : null;
    if (ids.has(id) || (parent && ids.has(parent))) store.removeRow('workflow', table, index);
    else if (gone.has(id) || (parent && gone.has(parent))) {
      store.removeRow('workflow', table, index);
      if (!parent) counts.removed += 1;
    }
  }
  // A gone definition whose row the Solution data import already dropped still counts once (its activation was removed above).
  for (const id of gone) if (!present.has(id)) counts.removed += 1;
  for (const fact of facts) counts[present.has(fact.id) ? 'changed' : 'added'] += 1;
  for (const row of rowsOfFacts(facts, organizationId)) store.insertRow('workflow', table, structuredClone(row));
  seeded.workflow = [...ids];
  return counts;
}

// ---- Activation

// Rules for the workflow table's writes, run inside the write's transaction. Codes are the documented web service error codes.
function workflowWriteRule(c, mapping, { operation, data, existing }) {
  if (operation === 'delete') {
    if (Number(existing?.type) === TYPE.activation) throw native('0x80045004', 'Cannot delete a workflow activation.');
    return;
  }
  if (operation === 'create') {
    if (
      Number(data.type ?? TYPE.definition) === TYPE.definition &&
      Number(data.category ?? CATEGORY_WORKFLOW) === CATEGORY_WORKFLOW
    ) {
      throw invalid(NOT_SUPPORTED_XAML, '0x80040203'); // the native refusal and its code are a guess
    }
    return;
  }
  if (operation !== 'update') return;
  const type = Number(existing.type);
  const state = Number(existing.statecode);
  if (type === TYPE.activation) throw native('0x80045003', 'Cannot update a workflow activation.');
  const onlyState = Object.keys(data).every((key) => key === 'statecode' || key === 'statuscode');
  if (state === STATE_ACTIVATED && !onlyState)
    throw native('0x80045002', 'Cannot update a published workflow definition.');
  if (!('statecode' in data) || Number(data.statecode) === state) return;
  if (Number(data.statecode) === STATE_ACTIVATED) {
    if (type !== TYPE.definition && type !== TYPE.template)
      throw native('0x8004500D', 'Only workflow definition or draft workflow template can be published.');
    const merged = { ...existing, ...data };
    const triggered = merged.triggeroncreate || merged.triggerondelete || merged.triggeronupdateattributelist;
    if (
      Number(merged.category) === CATEGORY_WORKFLOW &&
      Number(merged.mode) === 0 &&
      !merged.ondemand &&
      !merged.subprocess &&
      !triggered
    ) {
      throw native(
        '0x80045018',
        'Automatic workflow cannot be published if no activation parameters have been specified.',
      );
    }
    data.statuscode = STATUS.activated;
  } else {
    data.statuscode = STATUS.draft;
  }
}

// After a write: an activated definition has one activation row and points activeworkflowid at it; a deactivated one has none.
function syncActivation(api, operation, id) {
  const { store } = api;
  if (operation === 'delete') return;
  const row = workflowRow(store, id);
  const organizationId = organizationIdOf(store);
  if (!row || Number(row.type) === TYPE.activation || !organizationId) return;
  const table = rowsOf(store, 'workflow');
  const activation = activationOf(store, id);
  if (Number(row.statecode) === STATE_ACTIVATED) {
    const activationId = activation?.workflowid ?? activationIdOf(organizationId, id);
    if (!activation) store.insertRow('workflow', table, activationRowOf(row, id, activationId));
    store.mutateRow('workflow', table, table.indexOf(row), { activeworkflowid: lookup('workflow', activationId) });
  } else {
    if (activation) store.removeRow('workflow', table, table.indexOf(activation));
    store.mutateRow('workflow', table, table.indexOf(row), { activeworkflowid: null });
  }
}

/**
 * The exported cloud flow map with each flow's `active` taken from its workflow row (statecode 1). Returns the map itself
 * when no row carries a cloud flow, so the portal reads what it read before. Memoized on the store revision.
 */
const overlays = new WeakMap();
export function workflowsWithActivation(workflows, store) {
  const rows = store?.state?.tables?.workflow ?? [];
  if (!rows.length) return workflows;
  const revision = store.dataRevision?.();
  const cached = overlays.get(workflows);
  if (cached && revision !== undefined && cached.revision === revision && cached.store === store) return cached.value;
  const active = new Map();
  for (const row of rows)
    if (Number(row.type) === TYPE.definition && Number(row.category) === CATEGORY_MODERN_FLOW)
      active.set(bare(row.workflowid), Number(row.statecode) === STATE_ACTIVATED);
  const value = new Map(
    [...workflows].map(([id, workflow]) => [id, active.has(id) ? { ...workflow, active: active.get(id) } : workflow]),
  );
  overlays.set(workflows, { revision, store, value });
  return value;
}

// ---- Pack handlers

/** Trusted classic workflow handlers: a pack's `workflows` maps a workflow id or unique name to a function (see docs). */
export function workflowHandlers(packs = []) {
  return new Map([...collectPackExport(packs, 'workflows')].map(([key, { value }]) => [key, value]));
}

// Which run a classic workflow gets: an override (placeholder, mock or disabled), its pack handler, or the placeholder.
// config.overrides is a map or a function returning one, read per run so /_sim/ changes apply at once.
function classicChoice(config, row) {
  const id = bare(row.workflowid);
  const names = [id, String(row.uniquename ?? '').toLowerCase()];
  const overrides = (typeof config.overrides === 'function' ? config.overrides() : config.overrides) ?? {};
  const override = names.map((key) => overrides[key]).find(Boolean);
  if (override?.mode === 'disabled') return { mode: 'disabled' };
  if (override?.mode === 'placeholder') return { mode: 'placeholder' };
  if (override?.mode === 'mock')
    return {
      mode: 'mock',
      status: override.status ?? JOB_STATUS.succeeded,
      message: override.message ?? 'Simulator: mock workflow result.',
    };
  const handler = names.map((key) => config.handlers?.get(key)).find(Boolean);
  return handler ? { mode: 'handler', handler } : { mode: 'placeholder' };
}

// The writes of one run of a classic workflow, inside the caller's transaction. A handler or mock run logs a workflowlog row.
// A throw fails the job (or rejects the request for a real-time run); the caller writes the failure log.
async function runClassic(api, config, run) {
  const { store } = api;
  if (!store.hasOperationContext()) return store.withOperationContext(() => runClassic(api, config, run));
  // run.chain: the chain of the committed write that triggered a background run (its job runs on a later tick).
  const outer = run.chain ?? store.flowChain;
  if ((outer?.depth ?? 0) >= DEPTH_LIMIT) throw canceled(DEPTH_MESSAGE, '0x80044182');
  const choice = classicChoice(config, run.row);
  const id = bare(run.row.workflowid);
  if (choice.mode === 'placeholder' || choice.mode === 'disabled') {
    config.diagnostic?.({
      code: choice.mode === 'disabled' ? 'WORKFLOW_DISABLED' : 'WORKFLOW_PLACEHOLDER',
      workflowId: id,
    });
    if (!run.realtime) throw canceled(choice.mode === 'disabled' ? DISABLED_MESSAGE : PLACEHOLDER_MESSAGE);
    return null;
  }
  const startedon = new Date(api.clock()).toISOString();
  if (choice.mode === 'mock') {
    config.diagnostic?.({
      code: 'WORKFLOW_MOCK',
      workflowId: id,
      message: 'Explicit local mock; the workflow XAML was not executed.',
    });
    if (choice.status === JOB_STATUS.failed) throw failure(choice.message);
    writeLog(store, api, run, { status: LOG_STATUS.succeeded, message: choice.message, startedon });
    return choice.message;
  }
  const trace = [];
  // Each trace() line is also a trace event on the run's workflow span (current here; tracedRun), so it reads in the trace.
  const span = store.traces?.enabled ? store.traces.current() : null;
  const previous = store.flowChain;
  store.flowChain = { id: outer?.id ?? (api.ids ?? systemIds).uuid(), depth: (outer?.depth ?? 0) + 1 };
  let message;
  try {
    const result = await invokeTrustedHandler(
      api,
      choice.handler,
      { workflow: run.row, target: run.target, caller: run.caller, inputs: run.inputs },
      {
        workingTarget: true,
        trace: (text) => {
          trace.push(String(text));
          span?.event('trace', { message: String(text) });
        },
      },
    );
    message = result?.message ?? (trace.join('\n') || null);
  } finally {
    store.flowChain = previous;
  }
  writeLog(store, api, run, { status: LOG_STATUS.succeeded, message, startedon });
  return message;
}

// workflowlog row (a background run is also linked to its asyncoperation). Skipped for a successful async-autodelete run.
function writeLog(store, api, run, { status, message = null, error = null, startedon }) {
  if (run.row.asyncautodelete && status === LOG_STATUS.succeeded) return;
  store.insertRow('workflowlog', rowsOf(store, 'workflowlog'), {
    workflowlogid: (api.ids ?? systemIds).uuid(),
    asyncoperationid: run.jobId ? lookup('asyncoperation', run.jobId) : null,
    status,
    stepname: 'Simulator',
    startedon,
    completedon: new Date(api.clock()).toISOString(),
    regardingobjectid: run.regarding ? lookup(run.regarding.logicalName, run.regarding.id) : null,
    regardingobjecttypecode: run.regarding?.logicalName ?? null,
    message,
    ...(error ? { errorcode: errorNumber(error), errortext: error.message } : {}),
  });
}

// processsession row for a real-time failure whose workflow asks for its log on failure (syncworkflowlogonfailure).
function writeProcessSession(store, api, run, error) {
  rowsOf(store, 'processsession').push({
    processsessionid: (api.ids ?? systemIds).uuid(),
    name: run.row.name,
    stepname: 'Simulator',
    processid: lookup('workflow', bare(run.row.workflowid)),
    regardingobjectid: run.regarding ? lookup(run.regarding.logicalName, run.regarding.id) : null,
    regardingobjecttypecode: run.regarding?.logicalName ?? null,
    errorcode: errorNumber(error),
    errortext: error.message,
    startedon: new Date(api.clock()).toISOString(),
    completedon: new Date(api.clock()).toISOString(),
  });
}

// One workflow span per run (docs/design/tracing.md), nested where it runs: a background run runs inside its job span (the
// system job's, dataverse-async.mjs runJob, or the committed job's, committed-work.mjs traceJob), which is parented by the
// span that queued it. The run's result (the workflow message, or the cloud flow run) is the span output.
function tracedRun(api, run, work, { cloud = false } = {}) {
  const traces = api.store.traces;
  if (!traces?.enabled) return work();
  return traces.wrap(
    {
      kind: 'workflow',
      name: run.row?.name ?? bare(run.row?.workflowid),
      module: cloud ? 'flows' : 'dataverse',
      operation: 'run',
      entity: run.regarding?.logicalName ?? run.target?.logicalName ?? null,
      recordId: run.regarding?.id ?? run.target?.id ?? null,
      attributes: {
        workflowId: bare(run.row?.workflowid),
        processId: bare(run.row?.workflowid),
        processName: run.row?.name ?? null,
        cloud,
        realtime: run.realtime === true,
        jobId: run.jobId ?? null,
      },
      input: () => ({ target: run.target?.row ?? null, inputs: run.inputs ?? {} }),
    },
    async (span) => {
      const result = await work();
      span.output(() => (cloud ? result : { message: result ?? null }));
      return result;
    },
  );
}

// One run, atomic: the handler's writes commit or roll back with it. A failed run records its log outside the rolled-back work.
async function attempt(api, config, run) {
  try {
    return await tracedRun(api, run, () => api.change(() => api.runAtomic(() => runClassic(api, config, run))));
  } catch (error) {
    const choice = classicChoice(config, run.row);
    const logged = choice.mode === 'handler' || choice.mode === 'mock';
    if (logged || (run.realtime && run.row.syncworkflowlogonfailure)) {
      await api.change(() =>
        api.store.transact(() => {
          if (logged)
            writeLog(api.store, api, run, {
              status: LOG_STATUS.failed,
              message: error.message,
              error,
              startedon: new Date(api.clock()).toISOString(),
            });
          if (run.realtime && run.row.syncworkflowlogonfailure) writeProcessSession(api.store, api, run, error);
        }),
      );
    }
    throw error;
  }
}

// A cloud flow run: its exported definition through the flow runtime, under the flow's local choice (exported, mock, or none).
function runCloudFlow(api, config, run) {
  const flow = config.cloudFlow?.(bare(run.row.workflowid)) ?? { mode: 'placeholder' };
  if (flow.mode === 'mock') {
    if (flow.status === JOB_STATUS.failed) throw failure('Simulator: the mock cloud flow failed.');
    return null;
  }
  if (flow.mode !== 'exported' || !flow.definition) throw canceled(PLACEHOLDER_CANCEL);
  const input = { ...structuredClone(run.target.row), SdkMessage: 'Update' }; // the message the flow receives is a guess
  // Not isolated: each connector write is its own SDK boundary, so a later failed action keeps earlier completed writes
  // (the HTTP and trigger paths do the same; mirage/docs/operations.md).
  // Connector actions go through the host's connector runtime and the flow's own connection references. With the host's
  // run store (api.flowRuns) the run is a tracked flowrun that can wait and resume (flow-runtime.mjs runTrackedFlow).
  // The flowrun triggertype text of an ExecuteWorkflow run is a guess.
  return runTrackedFlow({
    runs: api.flowRuns ?? null,
    processId: bare(run.row.workflowid),
    name: flow.name ?? run.row.name ?? null,
    trigger: 'ExecuteWorkflow',
    wrap: (fn) => api.change(() => api.store.transact(async () => await fn(), { cloneResult: false })),
    definition: flow.definition,
    input,
    store: api.store,
    serviceProfile: flow.serviceProfile,
    steps: flow.steps,
    connectors: flow.connectors,
    connectionReferences: flow.connectionReferences,
    secrets: flow.secrets,
    diagnostic: (entry) => config.diagnostic?.({ ...entry, workflowId: bare(run.row.workflowid) }),
  });
}

// ---- ExecuteWorkflow

// The InputArguments collection as a plain object of key to value; the native item shape is a guess.
const inputsOf = (value) =>
  Object.fromEntries(
    (Array.isArray(value) ? value : [])
      .map((item) => [item?.Key ?? item?.key ?? '', item?.Value ?? item?.value ?? null])
      .filter(([key]) => key),
  );

// The cloud flow trigger's declared input names (none for a Dataverse trigger, which takes the row).
const cloudInputNames = (definition) =>
  Object.keys(Object.values(definition?.triggers ?? {})[0]?.inputs?.schema?.properties ?? {});

/** ExecuteWorkflow: validates in the documented order, then starts the run. Returns the Web API body for the asyncoperation id. */
async function executeWorkflow(api, config, c, workflowId, body = {}) {
  const { store } = api;
  api.principals.authorize({
    user: c.user,
    entity: 'workflow',
    operation: 'read',
    mapping: store.resolveMapping('workflow'),
  });
  let row = workflowRow(store, workflowId);
  if (!row) throw native('0x8006040b', 'Workflow does not exist.'); // the 400 status is a guess
  if (Number(row.type) === TYPE.activation) row = workflowRow(store, lookupId(row.parentworkflowid));
  if (!row) throw native('0x8006040b', 'Workflow does not exist.');
  const category = Number(row.category);
  const realtime = category === CATEGORY_WORKFLOW && Number(row.mode) === 1;
  const name = row.name;
  if (category === CATEGORY_WORKFLOW) {
    if (Number(row.statecode) !== STATE_ACTIVATED) throw native('0x80045047', 'Workflow must be in Published state.');
    if (!row.ondemand && !row.subprocess)
      throw native('0x80045046', 'Workflow must be marked as on-demand or child workflow.');
  } else if (category === CATEGORY_MODERN_FLOW) {
    if (!row.ondemand)
      throw native('0x80060479', `Cannot execute Modern Flow '${name}' because it is not marked as on-demand.`);
  } else {
    throw native('0x8006040a', 'Invalid workflow or workflow does not exist.');
  }
  const entityId = body?.EntityId;
  if (entityId === undefined || entityId === null || entityId === '') throw invalid('EntityId is required.');
  const primary = store.resolveMapping(row.primaryentity);
  api.principals.authorize({ user: c.user, entity: primary.logicalName, operation: 'read', mapping: primary });
  const target = isGuid(bare(entityId)) ? store.get(primary.logicalName, bare(entityId), c.identity) : null;
  if (!target)
    throw new DataError(`${primary.logicalName} With Id = ${bare(entityId)} Does Not Exist`, 404, 'NotFound', {
      id: bare(entityId),
    });
  const regarding = { logicalName: primary.logicalName, id: bare(entityId) };
  const inputs = inputsOf(body.InputArguments);
  const caller = c.caller;
  if (category === CATEGORY_MODERN_FLOW) {
    const flow = config.cloudFlow?.(bare(row.workflowid));
    const trigger = flow?.definition ? inspectFlowTrigger(flow.definition) : { kind: 'unknown' };
    if (trigger.kind !== 'dataverse') {
      throw native(
        '0x80060476',
        `Modern Flow '${name}' is not valid for ExecuteWorkflow.  Please select a Flow that triggers whenever a Common Data Service entity is created, updated, or deleted.`,
      );
    }
    const allowed = new Set(cloudInputNames(flow.definition));
    const unsupported = Object.keys(inputs).find((key) => !allowed.has(key));
    if (unsupported !== undefined)
      throw native(
        '0x80060480',
        `Cannot execute Modern Flow '${name}' because '${unsupported}' is not a supported input argument.`,
      );
    const jobId = await api.systemJob(
      {
        name,
        operationtype: JOB_TYPE,
        callerId: caller.systemuserid,
        columns: {
          regardingobjectid: lookup(regarding.logicalName, regarding.id),
          primaryentitytype: regarding.logicalName,
        },
      },
      () =>
        tracedRun(
          api,
          { row, regarding },
          () => runCloudFlow(api, config, { row, target: { row: target }, caller, inputs }),
          { cloud: true },
        ),
    );
    return {
      status: 200,
      body: { '@odata.context': contextUrl(c.origin, c.version, 'asyncoperations/$entity'), asyncoperationid: jobId },
    };
  }
  const run = {
    row,
    target: { logicalName: regarding.logicalName, id: regarding.id, row: target },
    caller,
    inputs,
    regarding,
    realtime,
  };
  const activation = activationOf(store, row.workflowid);
  if (realtime) {
    await attempt(api, config, { ...run, jobId: null });
    return {
      status: 200,
      body: {
        '@odata.context': contextUrl(c.origin, c.version, 'asyncoperations/$entity'),
        asyncoperationid: ZERO_GUID,
      },
    }; // the id of a real-time run is a guess
  }
  // The work runs on a later tick, after the job id is assigned.
  let jobId = null;
  jobId = await api.systemJob(
    {
      name,
      operationtype: JOB_TYPE,
      callerId: caller.systemuserid,
      columns: {
        regardingobjectid: lookup(regarding.logicalName, regarding.id),
        primaryentitytype: regarding.logicalName,
        workflowactivationid: activation ? lookup('workflow', activation.workflowid) : null,
      },
    },
    inRunContext(store, currentRequest()?.correlationId, caller, () => attempt(api, config, { ...run, jobId })),
  );
  return {
    status: 200,
    body: { '@odata.context': contextUrl(c.origin, c.version, 'asyncoperations/$entity'), asyncoperationid: jobId },
  };
}

// ---- CreateWorkflowFromTemplate

// CSDL as the native $metadata has it (bound to workflow, WorkflowName not null, returns workflow).
const TEMPLATE_CSDL = `<Action Name="CreateWorkflowFromTemplate" IsBound="true">
  <Parameter Name="entity" Type="mscrm.workflow" />
  <Parameter Name="WorkflowName" Type="Edm.String" Nullable="false" />
  <ReturnType Type="mscrm.workflow" />
</Action>`;

// A new Draft definition copied from a template row (type 3), named WorkflowName. The XAML or cloud definition is copied as it is.
async function createFromTemplate(api, c) {
  const { store } = api;
  const template = c.target?.row;
  const name = c.body?.WorkflowName;
  if (typeof name !== 'string' || !name) throw invalid('WorkflowName is required.', '0x80040203'); // native message text is a guess
  if (Number(template?.type) !== TYPE.template) throw invalid('Only a workflow template can be copied.', '0x80040203'); // native message text is a guess
  api.principals.authorize({
    user: c.user,
    entity: 'workflow',
    operation: 'create',
    mapping: store.resolveMapping('workflow'),
  });
  const id = (api.ids ?? systemIds).uuid();
  const copy = {
    workflowid: id,
    workflowidunique: (api.ids ?? systemIds).uuid(),
    ...Object.fromEntries(COMMON.map((key) => [key, template[key] ?? null])),
    name,
    type: TYPE.definition,
    statecode: 0,
    statuscode: STATUS.draft,
    activeworkflowid: null,
    ...(template.xaml !== undefined ? { xaml: template.xaml } : {}),
    ...(template.clientdata !== undefined ? { clientdata: template.clientdata } : {}),
  };
  await api.change(() => store.transact(() => store.insertRow('workflow', rowsOf(store, 'workflow'), copy)));
  return {
    status: 200,
    body: {
      '@odata.context': contextUrl(c.origin, c.version, 'workflows/$entity'),
      workflowid: id,
      name,
      statecode: 0,
      statuscode: STATUS.draft,
      type: TYPE.definition,
    },
  };
}

// ---- Triggers

const idOf = (value) => (value === null || value === undefined ? '' : bare(value?.id ?? value));
const lowerNames = (text) =>
  String(text ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

// The activated classic definitions of a table, whatever their trigger (category 0, type 1, statecode 1).
function classicDefinitions(store, entity) {
  return store
    .tableRows('workflow')
    .filter(
      (row) =>
        Number(row.type) === TYPE.definition &&
        Number(row.category) === CATEGORY_WORKFLOW &&
        Number(row.statecode) === STATE_ACTIVATED &&
        String(row.primaryentity ?? '').toLowerCase() === String(entity).toLowerCase(),
    );
}

// create, delete, or an update that submitted one of the trigger's attributes (changed: lower-case names).
function triggerFires(definition, operation, changed) {
  if (operation === 'create') return flag(definition.triggeroncreate);
  if (operation === 'delete') return flag(definition.triggerondelete);
  return (
    operation === 'update' && lowerNames(definition.triggeronupdateattributelist).some((name) => changed.includes(name))
  );
}

// Scope relative to the definition's owner. A seeded definition has no owner columns: its owner is the root business unit.
// A record without owner columns sits in the root business unit too. 1 User, 2 Business Unit, 3 Parent: Child, 4 Organization.
function inScope(store, definition, record) {
  const scope = numeric(definition.scope, 4);
  if (scope === 4) return true;
  const units = store.tableRows('businessunit');
  const root = idOf(units.find((unit) => !idOf(unit.parentbusinessunitid))?.businessunitid);
  const ownerUser = idOf(definition.owninguser);
  const ownerUnit = idOf(definition.owningbusinessunit) || root;
  // A record's user is its owning user; a row written without owner columns is the creator's.
  // ponytail: a later owner change is not seen; add when a record's owner is written by the Web API.
  if (scope === 1) return ownerUser !== '' && (idOf(record.owninguser) || idOf(record.createdby)) === ownerUser;
  const unit = idOf(record.owningbusinessunit) || root;
  if (scope === 2) return unit === ownerUnit;
  // Parent: Child: the owner's unit must lie on the way up from the record's unit.
  let at = unit;
  for (let steps = 0; at && steps <= units.length; steps += 1) {
    if (at === ownerUnit) return true;
    at = idOf(units.find((item) => sameId(item.businessunitid, at))?.parentbusinessunitid);
  }
  return false;
}

// A background classic run gets its own request context: the starting request's correlation as the parent, mode async,
// the run's caller as principal.
const inRunContext = (store, correlationId, principal, fn) => () =>
  runWithRequest(
    createRequestContext({ correlationId: correlationId ?? undefined, clock: store.clock, ids: store.ids }).child({
      mode: 'async',
      principal,
    }),
    fn,
  );

// Background triggers. A committed write (portal or API: the store records both) starts one job per matching definition.
// Selection runs inside the triggering transaction (a data.mjs commit stager): the Ready asyncoperation rows commit or roll
// back with the write, and the store's durable job runner (committed-work.mjs) runs them on a later tick, so the write's
// response never waits. A restart resumes Ready rows; a run whose claim rolls back three times ends Failed.
// The row carries operationtype 10 (Workflow) from staging to completion.
const JOB_KIND = 'workflow';
function workflowLogic(store, definition) {
  const fact = workflowBypassFacts.get(store)?.get(bare(definition.workflowid));
  return {
    ...fact,
    ...definition,
    bypassOwnership:
      store.observed?.businessLogicOwnership?.[bare(definition.workflowid)] ??
      definition.bypassOwnership ??
      fact?.bypassOwnership,
    id: definition.sdkmessageprocessingstepid,
  };
}
function stageBackgroundRuns(api, config, events) {
  const { store } = api;
  const entries = [];
  for (const event of events) {
    if (event.messageEvent) continue;
    const changed = (event.submittedAttributes ?? []).map((name) => String(name).toLowerCase());
    for (const definition of classicDefinitions(store, event.entity)) {
      if (
        Number(definition.mode) !== 0 ||
        !triggerFires(definition, event.operation, changed) ||
        !inScope(store, definition, event.row)
      )
        continue;
      if (
        pluginStepBypassed(
          workflowLogic(store, definition),
          { bypassCustomPlugins: event.bypassCustomAsync === true, bypassStepIds: event.bypassStepIds },
          config.diagnostic ?? undefined,
        )
      )
        continue;
      const mapping = store.resolveMapping(event.entity),
        logical = mapping.logicalName,
        id = bare(event.row?.[mapping.idColumn]);
      const callerId = idOf(definition.owninguser) || idOf(store.tableRows('systemuser')[0]?.systemuserid);
      const activation = activationOf(store, definition.workflowid);
      entries.push({
        definitionId: bare(definition.workflowid),
        callerId,
        chain: event.chain ?? null,
        event,
        columns: {
          name: definition.name,
          operationtype: JOB_TYPE,
          regardingobjectid: lookup(logical, id),
          primaryentitytype: logical,
          workflowactivationid: activation ? lookup('workflow', activation.workflowid) : null,
          ...ownerColumns(store, { id: callerId, logical_name: 'systemuser' }),
        },
      });
    }
  }
  return stageCommittedJobs(store, { kind: JOB_KIND, entries });
}

// One background run: claim the Ready row (Locked, In Progress), run like any classic run (placeholder, handler or mock),
// then complete it Succeeded, Failed or Canceled. A row that left Ready (canceled through the Web API) is not run.
async function runBackgroundJob(api, config, { id, payload, event }) {
  const { store } = api;
  const stamp = () => new Date(api.clock()).toISOString();
  let claimed = false;
  await api.change(() =>
    store.transact(() => {
      const { rows, index } = liveJob(store, id);
      if (index < 0 || Number(rows[index].statecode) !== 0) return;
      Object.assign(rows[index], { statecode: 2, statuscode: 20, startedon: stamp() });
      claimed = true;
    }),
  );
  if (!claimed) return;
  let patch;
  try {
    const definition = workflowRow(store, payload.definitionId);
    if (!definition) throw canceled('The workflow definition is no longer available.');
    const mapping = store.resolveMapping(event.entity),
      logical = mapping.logicalName,
      rowId = bare(event.row?.[mapping.idColumn]);
    const run = {
      row: definition,
      target: { logicalName: logical, id: rowId, row: event.row },
      caller: { systemuserid: payload.callerId },
      inputs: {},
      regarding: { logicalName: logical, id: rowId },
      realtime: false,
      chain: payload.chain ?? null,
      jobId: id,
    };
    const message = await inRunContext(store, event.correlationId ?? payload.chain?.id, run.caller, () =>
      attempt(api, config, run),
    )();
    patch = { statecode: 3, statuscode: JOB_STATUS.succeeded, completedon: stamp(), message: message ?? null };
  } catch (error) {
    patch = {
      statecode: 3,
      statuscode: error?.jobStatus ?? JOB_STATUS.failed,
      completedon: stamp(),
      message: error.message,
      errorcode: errorNumber(error),
    };
  }
  await api.change(() =>
    store.transact(() => {
      const { rows, index } = liveJob(store, id);
      if (index >= 0) Object.assign(rows[index], patch);
    }),
  );
}

// Real-time triggers run inside the write. beforeWrite sees the submitted attributes, which afterWrite does not, so each
// request keeps its pending writes here (last in, first out) until afterWrite takes its own.
const pendingWrites = new WeakMap();
function noteWrite(c, mapping, { operation, data, existing }) {
  if (!c || typeof c !== 'object' || !['create', 'update', 'delete'].includes(operation)) return;
  const list = pendingWrites.get(c) ?? [];
  list.push({
    entity: mapping.logicalName,
    operation,
    changed: operation === 'update' ? Object.keys(data ?? {}).map((name) => name.toLowerCase()) : [],
    existing: existing ?? null,
  });
  pendingWrites.set(c, list);
}

// A real-time run is part of the write: a throw rejects the write, and the write's transaction rolls it back. Only handler and
// mock runs act; a placeholder records its diagnostic and lets the write succeed. Every write through the record hooks runs
// them: Web API, SDK and portal /_api writes alike.
// ponytail: a real-time failure keeps no workflowlog or processsession row (the write's rollback removes them); write them
// outside the rolled-back transaction when syncworkflowlogonfailure must be seen after a refusal.
async function afterWriteTriggers(api, config, c, mapping, { operation, id }) {
  const list = pendingWrites.get(c) ?? [];
  const index = list.findLastIndex((entry) => entry.entity === mapping.logicalName && entry.operation === operation);
  if (index < 0) return;
  const [entry] = list.splice(index, 1);
  const { store } = api;
  const logical = mapping.logicalName;
  const rowId = bare(id);
  const record =
    operation === 'delete'
      ? entry.existing
      : (store.tableRows(logical).find((row) => sameId(row[mapping.idColumn], rowId)) ?? null);
  if (!record) return;
  for (const definition of classicDefinitions(store, logical)) {
    if (
      Number(definition.mode) !== 1 ||
      !triggerFires(definition, operation, entry.changed) ||
      !inScope(store, definition, record)
    )
      continue;
    if (
      pluginStepBypassed(
        workflowLogic(store, definition),
        { bypassCustomPlugins: c.bypassCustomPlugins === true, bypassStepIds: c.bypassStepIds },
        config.diagnostic ?? undefined,
      )
    )
      continue;
    const run = {
      row: definition,
      target: { logicalName: logical, id: rowId, row: record },
      caller: c.caller ?? null,
      inputs: {},
      regarding: { logicalName: logical, id: rowId },
      realtime: true,
      jobId: null,
    };
    // A pack handler may change any state directly: promote the write's row journal to a full backup first (as an executing
    // plug-in step does), so its writes roll back and persist with the request. Core-only runs stay on the journal.
    if (classicChoice(config, definition).mode === 'handler') store.promoteRowTransaction();
    try {
      await runClassic(api, config, run);
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw native('0x80040265', error.message); // the code of a real-time workflow failure is a guess
    }
  }
}

// ---- Run modes for /_sim/

const RUN_MODES = ['handler', 'placeholder', 'mock', 'disabled'];
const MOCK_STATUSES = [JOB_STATUS.succeeded, JOB_STATUS.failed];

/** The stored override for a run mode. handler is the default and stores none. Throws a DataError outside the contract. */
export function runOverride(mode, mock = {}) {
  if (!RUN_MODES.includes(mode))
    throw new DataError(`mode must be one of ${RUN_MODES.join(', ')}.`, 400, 'InvalidRequest');
  if (mode === 'handler') return null;
  if (mode !== 'mock') return { mode };
  const status = mock.status ?? JOB_STATUS.succeeded;
  if (!MOCK_STATUSES.includes(Number(status)))
    throw new DataError('mock.status must be 30 (Succeeded) or 31 (Failed).', 400, 'InvalidRequest');
  if (mock.message !== undefined && typeof mock.message !== 'string')
    throw new DataError('mock.message must be a string.', 400, 'InvalidRequest');
  return { mode, status: Number(status), message: mock.message ?? 'Simulator: mock workflow result.' };
}

/** The classic workflows for the /_sim/ panel: identity, triggers, state and the stored override (null for handler). */
export function classicWorkflowsView(store, overrides = {}) {
  return store
    .tableRows('workflow')
    .filter((row) => Number(row.type) === TYPE.definition && Number(row.category) === CATEGORY_WORKFLOW)
    .map((row) => ({
      workflowid: bare(row.workflowid),
      name: row.name ?? null,
      uniquename: row.uniquename ?? null,
      statecode: Number(row.statecode),
      primaryentity: row.primaryentity ?? null,
      processMode: Number(row.mode) === 1 ? 'real-time' : 'background',
      trigger: {
        create: flag(row.triggeroncreate),
        delete: flag(row.triggerondelete),
        updateAttributes: lowerNames(row.triggeronupdateattributelist),
      },
      override: overrides[bare(row.workflowid)] ?? null,
      bypassOwnership: pluginBypassOwnership(workflowLogic(store, row)),
    }));
}

// ---- Extension

// A store keeps one background-trigger subscription: a restart on the same store replaces the earlier one.
const subscriptions = new WeakMap();
/**
 * The extension for the Dataverse API (server.mjs passes it beside customApiExtension, since the Solution facts and the
 * pack handlers belong to one site). config: facts (readSolutionWorkflows), handlers (workflowHandlers), overrides (a map of
 * workflow id to a run override from runOverride, or a function returning one: read per run), cloudFlow(id) (the exported
 * flow's definition, mode, steps and service profile, or null), diagnostic(entry).
 * install registers ExecuteWorkflow (operation for $metadata and SOAP, route for the id-addressed call), seeds the rows and
 * subscribes the background triggers to the store's committed writes; reset seeds the rows again. Only Dataverse-enabled
 * runtimes install it, so a portal-only runtime never starts a job.
 */
export function workflowExtension(config = {}) {
  const settings = { handlers: new Map(), overrides: {}, cloudFlow: null, diagnostic: null, ...config };
  // facts: the Solution workflow facts, or a getter over the current sources (source-organization-extensions.mjs refresh).
  const factsOf = () => (typeof settings.facts === 'function' ? settings.facts() : settings.facts) ?? [];
  const indexBypass = (api, facts) => {
    workflowBypassFacts.set(api.store, new Map(facts.map((fact) => [bare(fact.id), fact])));
    return facts;
  };
  const seed = (api) =>
    api.store.transact(() => {
      seedWorkflows(api.store, indexBypass(api, factsOf()));
    });
  return {
    name: 'dataverse-workflows',
    describe(api) {
      const ownership = (api?.store ? classicWorkflowsView(api.store) : []).map(
        ({ workflowid, bypassOwnership: { kind, qualification, reason } }) => ({
          workflowid,
          kind,
          qualification,
          ...(reason ? { reason } : {}),
        }),
      );
      return {
        name: 'dataverse-workflows',
        version: 1,
        kind: 'dataverse-extension',
        level: 'contract',
        operations: [{ name: 'ExecuteWorkflow', level: 'contract' }],
        seams: { bypassOwnership: ownership },
      };
    },
    /** Reseeds definitions and activations from facts inside the caller's transaction; returns { workflow: { added, changed, removed } }. */
    sync(api, facts = factsOf()) {
      return { workflow: seedWorkflows(api.store, indexBypass(api, facts)) };
    },
    install(api) {
      api.recordHooks.add('beforeWrite', (c, mapping, info) => {
        if (mapping.logicalName === 'workflow') return workflowWriteRule(c, mapping, info);
        noteWrite(c, mapping, info);
      });
      api.recordHooks.add('afterWrite', (c, mapping, info) => {
        if (mapping.logicalName === 'workflow') syncActivation(api, info.operation, info.id);
        return afterWriteTriggers(api, settings, c, mapping, info);
      });
      // Background runs are durable committed jobs (committed-work.mjs): the stager writes their Ready rows inside the
      // triggering commit, and the store's one job runner runs them FIFO with its recovery and poison rules.
      subscriptions.get(api.store)?.();
      const jobs = committedJobs(api.store);
      const unstage = api.store.addCommitStager((events) => stageBackgroundRuns(api, settings, events));
      const unregister = jobs.register(
        JOB_KIND,
        (job) => traceJob(api.store, job, () => runBackgroundJob(api, settings, job)),
        settings.diagnostic ? { diagnostic: settings.diagnostic } : {},
      );
      subscriptions.set(api.store, () => {
        unstage();
        unregister();
      });
      api.registry.register({
        name: 'ExecuteWorkflow',
        kind: 'action',
        binding: 'entity',
        entity: 'workflow',
        csdl: EXECUTE_CSDL,
        handle: (c) => executeWorkflow(api, settings, c, bare(c.target?.id), c.body),
      });
      api.registry.register({
        name: 'CreateWorkflowFromTemplate',
        kind: 'action',
        binding: 'entity',
        entity: 'workflow',
        csdl: TEMPLATE_CSDL,
        handle: (c) => createFromTemplate(api, c),
      });
      // The id-addressed call. A missing row answers the documented workflow code, which the generic entity lookup would not.
      api.addRoute(
        (pathname, method) =>
          method === 'POST' && EXECUTE_ROUTE.test(pathname) && isGuid(bare(EXECUTE_ROUTE.exec(pathname)[1])),
        (c) => {
          const id = bare(EXECUTE_ROUTE.exec(c.url.pathname)[1]);
          return executeWorkflow(api, settings, c, id, c.body).then((result) => ({
            ...result,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          }));
        },
      );
      return seed(api);
    },
    reset(api) {
      return seed(api);
    },
  };
}
