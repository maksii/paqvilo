import { organizationRecord } from './organization-context.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { createRequestContext, currentRequest, runWithRequest } from './request-context.mjs';
// Workflows in the Dataverse API: workflow rows from the Solution's Workflows folder with their activation rows, the
// activation rules on PATCH, ExecuteWorkflow, the run of a classic workflow and the classic triggers on writes (background
// jobs from committed writes, real-time runs inside the write).
//  - A classic workflow (category 0) is designer XAML. A run is, in this order: a /_sim/ override (disabled, placeholder or
//    mock), a trusted pack handler (the `workflows` export), the interpreted XAML when the whole definition is in the
//    supported subset (classic-workflow-xaml.mjs; mode 'xaml'), else a placeholder that ends a background job Canceled
//    (WORKFLOW_PLACEHOLDER, with WORKFLOW_XAML_UNSUPPORTED naming the first step outside the subset). An interpreted run
//    writes through the records pipeline as its run-as user (Learn "Overview of using workflow processes", security
//    context: an event-started background run as the owner, an on-demand one as the user who started it, a real-time one
//    as the owner or the calling user per runas). Its writes are one store transaction, as a handler's are.
//  - A cloud flow (category 5) runs its exported definition through flow-runtime, as a job. Its activation is the workflow
//    row's statecode, which workflowsWithActivation copies onto the exported flow map (the portal trigger path reads that map).
import { clockFunction, stampMs, systemClock, systemIds } from './runtime-clock.mjs';
import path from 'node:path';
import { DataError } from './data-error.mjs';
import { invokeTrustedHandler } from './trusted-handler-invocation.mjs';
import { descendants, parseSolutionXml } from './solution-xml.mjs';
import { FAILED_STEP_CODE, parseClassicWorkflow, runClassicWorkflow } from './classic-workflow-xaml.mjs';
import { organizationPrincipalContext } from './dataverse-principal-context.mjs';
import { solutionLayerFiles } from './solution-content-fingerprint.mjs';
import { contextUrl, dataverseError } from './dataverse-odata.mjs';
import { ownerColumns, uuidV5 } from './dataverse-security.mjs';
import { committedJobs, encodeEvent, liveJob, stageCommittedJobs, traceJob } from './committed-work.mjs';
import v8 from 'node:v8';
import { runTrackedFlow, inspectFlowTrigger } from './flow-runtime.mjs';
import { pluginStepBypassed, pluginBypassOwnership } from './plugin-bypass.mjs';

// A stored date, held across a small backward step of the wall clock (runtime-clock.mjs stampMs).
const stampOf = (api) => new Date(stampMs(api.store, api.clock)).toISOString();

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
const STOP_CANCELED_MESSAGE = 'Simulator: the classic workflow stopped with status Canceled.';
const PLACEHOLDER_CANCEL = 'Simulator: operation has no local simulation; the job is canceled.';
const DEPTH_MESSAGE =
  'This workflow job was canceled because the workflow that started it included an infinite loop. Correct the workflow logic and try again. For information about workflow logic, see Help.';
// The Web API accepts a category-0 definition whose XAML is designer-shaped and refuses the rest (summary-F6 OPS-01d).
const CUSTOM_XAML =
  'This workflow cannot be created, updated or published because it was created outside the Microsoft Dynamics 365 Web application. Your organization does not allow this type of workflow.';
// The wait-until of a waiting or failed classic workflow job without a time (summary-F6 OPS-01d).
const WAIT_FOREVER = '9999-12-30T23:59:59Z';
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
  return /^0x[0-9a-f]+$/i.test(code ?? '') ? Number.parseInt(code, 16) | 0 : 0; // NOSONAR: bitwise coercion wraps to signed 32 bits on purpose
};
// A job ends Canceled when its work throws this error (jobStatus is read by dataverse-async systemJob and runBackgroundJob); failure ends it Failed.
const canceled = (message, innerCode = '0x0') =>
  Object.assign(new DataError(message, 400, 'InvalidRequest', { innerCode }), { jobStatus: JOB_STATUS.canceled });
const failure = (message) => new DataError(message, 400, 'InvalidRequest', { innerCode: '0x0' });
// A real-time run's failure rejects the request: a DataError keeps its own code, anything else answers 0x80040265 with its
// message (the code of a real-time workflow failure is a guess).
const realtimeFailure = (error) => (error instanceof DataError ? error : native('0x80040265', error.message));
// A failed mock run: a real-time one answers as every real-time failure does; a background one fails its job.
const mockFailure = (run, message) => (run.realtime ? realtimeFailure(new Error(message)) : failure(message));

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
  const file = files.get(path.basename(String(fileName).replaceAll('\\', '/')).toLowerCase());
  try {
    return file ? file.read(FILE_LIMIT).toString('utf8') : null;
  } catch {
    return null;
  }
}

function workflowFiles(layer, diagnostic) {
  try {
    return solutionLayerFiles(layer, /^workflows$/i).filter((file) => /^[^/]+\/[^/]+$/.test(file.name));
  } catch (error) {
    diagnostic({ code: 'SOLUTION_LAYER_COMPONENTS_UNREADABLE', source: layer.dir, message: error.message });
    return null;
  }
}

function workflowFact(file, byName) {
  const name = file.name.slice(file.name.indexOf('/') + 1);
  if (!/\.data\.xml$/i.test(name)) return null;
  let xml;
  try {
    xml = parseSolutionXml(file.read(FILE_LIMIT).toString('utf8'));
  } catch {
    return null;
  }
  const node = descendants(xml, 'Workflow')[0] ?? xml;
  const id = bare(fieldOf(node, 'WorkflowId'));
  if (!isGuid(id)) return null;
  const stem = name.replace(/\.data\.xml$/i, '');
  const xaml = companionText(byName, fieldOf(node, 'XamlFileName') ?? (/\.json$/i.test(stem) ? null : stem));
  const json = companionText(byName, fieldOf(node, 'JsonFileName') ?? (/\.json$/i.test(stem) ? stem : null));
  return {
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
    processtriggerscope: numeric(fieldOf(node, 'ProcessTriggerScope'), null),
    processtriggerformid: isGuid(bare(fieldOf(node, 'ProcessTriggerFormId')))
      ? bare(fieldOf(node, 'ProcessTriggerFormId'))
      : null,
    xaml,
    clientdata: json,
  };
}

function workflowFacts(files) {
  const byName = new Map(files.map((file) => [file.name.slice(file.name.indexOf('/') + 1).toLowerCase(), file]));
  const facts = [];
  for (const file of files) {
    const fact = workflowFact(file, byName);
    if (fact) facts.push(fact);
  }
  return facts;
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
    const files = workflowFiles(layer, diagnostic);
    if (files) {
      for (const fact of workflowFacts(files)) facts.push(fact);
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
    if (active) rows.push(activationRowOf(fact, fact.id, activationId));
  }
  return rows;
}

function removeWorkflowRows(store, table, ids, gone, counts) {
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
}

function countMissingWorkflows(gone, present, counts) {
  for (const id of gone) if (!present.has(id)) counts.removed += 1;
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
  let dataverse = store.state.dataverse;
  if (dataverse == null) {
    dataverse = {};
    store.state.dataverse = dataverse;
  }
  let seeded = dataverse.sourceSeeded;
  if (seeded == null) {
    seeded = {};
    dataverse.sourceSeeded = seeded;
  }
  const ids = new Set(facts.map((fact) => fact.id));
  const gone = new Set((seeded.workflow ?? []).filter((id) => !ids.has(id)));
  const present = new Set(
    table.filter((row) => Number(row.type) !== TYPE.activation).map((row) => bare(row.workflowid)),
  );
  removeWorkflowRows(store, table, ids, gone, counts);
  // A gone definition whose row the Solution data import already dropped still counts once (its activation was removed above).
  countMissingWorkflows(gone, present, counts);
  for (const fact of facts) counts[present.has(fact.id) ? 'changed' : 'added'] += 1;
  for (const row of rowsOfFacts(facts, organizationId)) store.insertRow('workflow', table, structuredClone(row));
  seeded.workflow = [...ids];
  return counts;
}

// ---- Activation

// Rules for the workflow table's writes, run inside the write's transaction. Codes are the documented web service error codes.
function workflowUpdateRule(existing, data) {
  const type = Number(existing.type);
  const state = Number(existing.statecode);
  if (type === TYPE.activation) throw native('0x80045003', 'Cannot update a workflow activation.');
  const onlyState = Object.keys(data).every((key) => key === 'statecode' || key === 'statuscode');
  if (state === STATE_ACTIVATED && !onlyState)
    throw native('0x80045002', 'Cannot update a published workflow definition.');
  if (!('statecode' in data) || Number(data.statecode) === state) return;
  updateWorkflowStatus(type, existing, data);
}

function updateWorkflowStatus(type, existing, data) {
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

// A category-0 definition's XAML written through the Web API: designer-shaped XAML (the supported subset without the
// forms the Web API refuses: every Postpone, RetrieveCurrentTime without xml:space="preserve") is accepted; the rest
// answers 400 0x80045040 (summary-F6 OPS-01d). XAML the subset cannot read is refused the same way.
function assertDesignerXaml(row) {
  if (Number(row.type ?? TYPE.definition) !== TYPE.definition) return;
  if (Number(row.category ?? CATEGORY_WORKFLOW) !== CATEGORY_WORKFLOW) return;
  if (row.xaml === undefined || row.xaml === null || row.xaml === '') return;
  const { program } = parseClassicWorkflow(String(row.xaml));
  if (!program || program.webApi.length) throw native('0x80045040', CUSTOM_XAML);
}

// Activation checks each lookup literal of the XAML: a row that does not exist refuses it with 0x80048455 and the map of
// the designer steps around each reference (innermost first, to WorkflowStep0) (summary-F6 OPS-01d).
function assertLookupLiterals(store, row) {
  if (Number(row.category) !== CATEGORY_WORKFLOW || !row.xaml) return;
  const { program } = parseClassicWorkflow(String(row.xaml));
  const steps = [];
  for (const reference of program?.references ?? []) {
    if (referencedRowExists(store, reference)) continue;
    for (const step of reference.steps) if (!steps.includes(step)) steps.push(step);
  }
  if (!steps.length) return;
  const map = steps.map((step) => step + ': InvalidGuidReference').join(' ; ');
  throw native(
    '0x80048455',
    `Error: This workflow has errors and cannot be published. Please remove the errors and try again., Worklfow Id: ${bare(row.workflowid)}, ErrorMap Details: {${map}}`,
  );
}

// Whether the row a lookup literal names exists (a table the organization does not know has none).
function referencedRowExists(store, reference) {
  let mapping;
  try {
    mapping = store.resolveMapping(reference.table);
  } catch {
    return false;
  }
  return store.tableRows(mapping.logicalName).some((item) => sameId(item[mapping.idColumn], reference.id));
}

function workflowWriteRule(c, mapping, { operation, data, existing }, store) {
  if (operation === 'delete') {
    if (Number(existing?.type) === TYPE.activation) throw native('0x80045004', 'Cannot delete a workflow activation.');
    return;
  }
  if (operation === 'create') {
    assertDesignerXaml(data);
    if (Number(data.statecode) === STATE_ACTIVATED) assertLookupLiterals(store, data);
    return;
  }
  if (operation === 'update') {
    workflowUpdateRule(existing, data);
    if ('xaml' in data) assertDesignerXaml({ ...existing, ...data });
    if (Number(data.statecode) === STATE_ACTIVATED && Number(existing.statecode) !== STATE_ACTIVATED)
      assertLookupLiterals(store, { ...existing, ...data });
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

// The parsed XAML of a definition row, kept while the row's XAML text is unchanged. A row without XAML has no reason to report.
const parsedXaml = new WeakMap();
function xamlOf(row) {
  if (row.xaml === null || row.xaml === undefined || row.xaml === '') return { unsupported: null };
  const cached = parsedXaml.get(row);
  if (cached?.xaml === row.xaml) return cached.parsed;
  const parsed = parseClassicWorkflow(row.xaml);
  parsedXaml.set(row, { xaml: row.xaml, parsed });
  return parsed;
}

// Which run a classic workflow gets: an override (placeholder, mock or disabled), its pack handler, its XAML when the whole
// definition is in the supported subset, or the placeholder (with the reason the XAML is not interpreted, when it has some).
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
  if (handler) return { mode: 'handler', handler };
  const { program, unsupported } = xamlOf(row);
  // Learn "Configure workflow stages and steps": real-time workflows cannot use wait conditions (the designer refuses to
  // activate one); a waiting step in a real-time definition is not interpreted.
  if (program?.waits && Number(row.mode) === 1)
    return { mode: 'placeholder', unsupported: 'A real-time workflow cannot use wait conditions or Postpone.' };
  if (program) return { mode: 'xaml', program };
  return unsupported ? { mode: 'placeholder', unsupported } : { mode: 'placeholder' };
}

/** Readiness uses the same local execution choice as a real-time or background run: mode 'xaml' runs, so it is satisfied. */
export function classicWorkflowReadiness(store, config) {
  return store
    .tableRows('workflow')
    .filter(
      (row) =>
        Number(row.type) === TYPE.definition &&
        Number(row.category) === CATEGORY_WORKFLOW &&
        Number(row.statecode) === STATE_ACTIVATED,
    )
    .map((row) => {
      const { mode } = classicChoice(config, row);
      // A trusted handler and interpreted XAML both run the workflow: each names what resolves it (pack or xaml).
      const resolver = { handler: 'pack', xaml: 'xaml' }[mode] ?? null;
      return {
        key: `classic-workflow:${bare(row.workflowid)}`,
        kind: 'classic-workflow',
        mode,
        registered: resolver !== null,
        ...(resolver ? { resolver } : {}),
      };
    });
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
  if (choice.mode === 'placeholder' || choice.mode === 'disabled') return placeholderRun(config, run, choice, id);
  const startedon = stampOf(api);
  if (choice.mode === 'mock') {
    config.diagnostic?.({
      code: 'WORKFLOW_MOCK',
      workflowId: id,
      message: 'Explicit local mock; the workflow XAML was not executed.',
    });
    if (choice.status === JOB_STATUS.failed) throw mockFailure(run, choice.message);
    writeLog(store, api, run, { status: LOG_STATUS.succeeded, message: choice.message, startedon });
    return choice.message;
  }
  const previous = store.flowChain;
  store.flowChain = { id: outer?.id ?? (api.ids ?? systemIds).uuid(), depth: (outer?.depth ?? 0) + 1 };
  let outcome;
  try {
    outcome = await executeChoice(api, run, choice);
  } finally {
    store.flowChain = previous;
  }
  if (choice.mode === 'xaml') return finishInterpreted(store, api, run, outcome);
  if (outcome.status === 'canceled') return stopCanceled(store, api, run, outcome.message, startedon);
  writeLog(store, api, run, { status: LOG_STATUS.succeeded, message: outcome.message, startedon });
  return outcome.message;
}

// An interpreted run's end (summary-F6 OPS-01d). Real-time: no log rows; Stop Canceled refuses the write with 0x80040265
// and the Stop message. Background: one log row per executed step; Stop Canceled ends the job Canceled (3/32) without a
// message; a wait suspends it (run.waiting); a failing step suspends it with its error (run.failed). Earlier writes stay.
function finishInterpreted(store, api, run, outcome) {
  if (run.realtime) {
    if (outcome.status === 'canceled') throw native('0x80040265', outcome.message ?? STOP_CANCELED_MESSAGE);
    return null;
  }
  writeStepLogs(store, api, run, outcome);
  if (outcome.status === 'canceled') run.stopped = { message: null };
  if (outcome.status === 'waiting') run.waiting = outcome;
  if (outcome.status === 'failed') run.failed = outcome;
  return null;
}

// The step log rows of a background run (classic-workflow-xaml.mjs logs): owned by the workflow owner, about the primary
// row. A successful run of an async-autodelete workflow keeps none, as its job is deleted.
function writeStepLogs(store, api, run, outcome) {
  if (run.row.asyncautodelete && outcome.status === 'succeeded') return;
  const owner = definitionOwnerId(store, run.row);
  for (const entry of outcome.logs ?? []) {
    store.insertRow('workflowlog', rowsOf(store, 'workflowlog'), {
      workflowlogid: (api.ids ?? systemIds).uuid(),
      asyncoperationid: run.jobId ? lookup('asyncoperation', run.jobId) : null,
      status: entry.status,
      stepname: entry.stepname,
      activityname: entry.activityname,
      message: entry.message,
      errorcode: entry.errorcode,
      createdon: stampOf(api),
      completedon: entry.status === LOG_STATUS.failed ? null : stampOf(api),
      regardingobjectid: run.regarding ? lookup(run.regarding.logicalName, run.regarding.id) : null,
      regardingobjecttypecode: run.regarding?.logicalName ?? null,
      ...(owner ? ownerColumns(store, { id: owner, logical_name: 'systemuser' }) : {}),
    });
  }
}

// A placeholder or disabled run: its diagnostics (and the reason its XAML is not interpreted); a background job ends Canceled.
function placeholderRun(config, run, choice, id) {
  if (choice.unsupported)
    config.diagnostic?.({ code: 'WORKFLOW_XAML_UNSUPPORTED', workflowId: id, message: choice.unsupported });
  config.diagnostic?.({
    code: choice.mode === 'disabled' ? 'WORKFLOW_DISABLED' : 'WORKFLOW_PLACEHOLDER',
    workflowId: id,
  });
  if (!run.realtime) throw canceled(choice.mode === 'disabled' ? DISABLED_MESSAGE : PLACEHOLDER_MESSAGE);
  return null;
}

// A handler or interpreted run inside the run's flow chain: { status: 'succeeded' | 'canceled', message }. Each trace() line
// is also a trace event on the run's workflow span (current here; tracedRun), so it reads in the trace.
async function executeChoice(api, run, choice) {
  const trace = [];
  const span = api.store.traces?.enabled ? api.store.traces.current() : null;
  const traced = (text) => {
    trace.push(String(text));
    span?.event('trace', { message: String(text) });
  };
  if (choice.mode === 'xaml') return interpretXaml(api, run, choice.program, traced);
  const result = await invokeTrustedHandler(
    api,
    choice.handler,
    { workflow: run.row, target: run.target, caller: run.caller, inputs: run.inputs },
    {
      workingTarget: true,
      label: `The data pack's workflows handler for "${run.row?.name ?? run.row?.workflowid ?? 'this workflow'}"`,
      trace: traced,
    },
  );
  return { status: 'succeeded', message: result?.message ?? (trace.join('\n') || null) };
}

// Stop workflow with status Canceled. A real-time run refuses the operation with the stop message (Learn "Configure
// real-time workflow stages and steps": "When you set the status to canceled, you prevent the operation"); the code of that
// refusal (0x80040265, the plug-in cancel) is a guess. A background run keeps the writes its earlier steps made, logs
// Canceled and marks the run, so attempt ends the job Canceled once those writes have committed.
function stopCanceled(store, api, run, message, startedon) {
  if (run.realtime) throw native('0x80040265', message ?? STOP_CANCELED_MESSAGE);
  writeLog(store, api, run, { status: LOG_STATUS.canceled, message, startedon });
  run.stopped = { message: message ?? STOP_CANCELED_MESSAGE };
  return message;
}

// The run-as user's id (Learn "Overview of using workflow processes", security context): a real-time run as the calling user
// when runas is 1 (Calling User) and as the owner otherwise; a background run as run.caller, which is the owner for an
// event-started job (stageBackgroundRuns) and the starting user for ExecuteWorkflow.
// Hosted runs (summary-F6 OPS-01d): a real-time run with runas 1 (calling user) writes as the request's user, on behalf of
// the principal that called (an impersonating application: createdonbehalfby); with runas 0 as the workflow owner, on
// behalf of no one. An event-started background run writes as the owner whatever runas says; an on-demand run as the
// user who started it (Learn "Overview of using workflow processes"; not hosted-checked).
// A calling-user run without a calling user fails (runAsContext) instead of running as the owner.
function runAsUserId(store, run) {
  const callerId = idOf(run.caller?.systemuserid);
  if (!run.realtime) return callerId || definitionOwnerId(store, run.row);
  if (Number(run.row.runas) !== 1) return definitionOwnerId(store, run.row);
  return (run.portal && portalApplicationUserId(store)) || idOf(run.user?.systemuserid) || callerId;
}

// The calling user of a standard-model portal write (Learn "Power Pages connectivity to a Microsoft Dataverse": a site
// writes as its application user "# Portals-<site name>", an older site as SYSTEM): the site's observed application user
// (observed.portalApplicationUserId, the user the store stamps on rows the portal writes) when that user exists, else
// null, and the run takes the SYSTEM user the portal write itself runs as (dataverse-records.mjs internalContext).
function portalApplicationUserId(store) {
  const id = idOf(store.observed?.portalApplicationUserId);
  return id && store.tableRows('systemuser').some((row) => sameId(row.systemuserid, id)) ? id : null;
}

const userById = (api, id) =>
  api.principals?.byId?.(id) ?? api.store.tableRows('systemuser').find((row) => sameId(row.systemuserid, id));

// The context of an interpreted run's writes: the run-as user through the records pipeline (privileges checked, as the run's
// own security context). A disabled or missing run-as user fails the run, as a deactivated owner's waiting runs fail.
function runAsContext(api, run) {
  const { store } = api;
  const userId = runAsUserId(store, run);
  const user = userById(api, userId);
  if (!user || user.isdisabled === true)
    throw failure(`The classic workflow's run-as user ${userId || '(none)'} is not available.`);
  const onBehalf =
    run.realtime && Number(run.row.runas) === 1 && run.caller?.systemuserid && !sameId(run.caller.systemuserid, userId)
      ? userById(api, idOf(run.caller.systemuserid))
      : null;
  return organizationPrincipalContext(store, user, onBehalf ? { caller: onBehalf } : {});
}

const storedRowOf = (store, mapping, id) => {
  const rows = store.tableRows(mapping.logicalName);
  return rows[store.rowIndex(mapping, rows, id)] ?? null;
};

// One interpreted run (classic-workflow-xaml.mjs) over the primary row as stored now (the trigger's row when it is gone, as for
// a delete). Each write gets its own copy of the run-as context: the record hooks key per-write state on the context object.
function interpretXaml(api, run, program, trace) {
  const { store } = api;
  const context = runAsContext(api, run);
  const write = () => ({ ...context });
  const primary = store.resolveMapping(run.target.logicalName);
  const known = (table) => {
    try {
      return Boolean(store.resolveMapping(table));
    } catch {
      return false;
    }
  };
  const stored = storedRowOf(store, primary, bare(run.target.id));
  // A waiting run resumes against the record as it is now; a record deleted meanwhile ends the job Canceled (local model).
  if (run.resume && !stored) throw canceled('The record this workflow waits on no longer exists.');
  return runClassicWorkflow(
    program,
    {
      primary: {
        logicalName: primary.logicalName,
        id: bare(run.target.id),
        row: stored ?? run.target.row,
      },
      // The store's runtime clock, which the committed-job runner also reads for postponeuntil.
      now: () => clockFunction(store.clock ?? systemClock)(),
      idColumn: (table) => store.resolveMapping(table).idColumn,
      hasTable: known,
      read: (table, id) => {
        const mapping = store.resolveMapping(table);
        const row = storedRowOf(store, mapping, id);
        if (row)
          api.principals.authorize({
            user: context.user,
            entity: mapping.logicalName,
            operation: 'read',
            row,
            mapping,
          });
        return row;
      },
      create: (table, data) => api.records.createInternal(write(), table, data),
      update: (table, id, data) => api.records.updateInternal(write(), table, id, data),
      trace,
    },
    { resume: run.resume ?? null, suspendOnFailure: !run.realtime },
  ).catch((error) => {
    // A real-time run's failing step refuses the triggering write with 0x80040265 and the step's own message. The depth
    // guard of a chain of runs (0x80044182) keeps its own code.
    if (run.realtime && error?.details?.innerCode !== '0x80044182') throw native('0x80040265', error.message);
    throw error;
  });
}

// ---- Waiting runs (Learn "Configure workflow stages and steps": a wait condition pauses a background workflow until its
// criteria are met and it starts again automatically; parallel wait branches with a timeout; SDK Postpone). The job row is
// Suspended (1) / Waiting (10), with postponeuntil for a timeout; its committed-job payload keeps the run's snapshot
// (classic-workflow-xaml.mjs) and the wait kind. The committed-job runner turns a timed row Ready at its postponeuntil, and
// a later committed write of the record wakes a condition wait (wakeWaitingRuns): the run continues at its wait, which reads
// the record again and waits once more when no condition holds yet.
const encodeSnapshot = (snapshot) => v8.serialize(snapshot).toString('base64');
const decodeSnapshot = (text) => v8.deserialize(Buffer.from(text, 'base64'));
const WAITING_STATE = { statecode: 1, statuscode: 10 };

// The row values of a run that suspended: Suspended/Waiting, the timeout, and the payload that resumes it.
function waitingPatch(api, payload, waiting) {
  const until = waiting.wait.until;
  return {
    ...WAITING_STATE,
    // A condition wait has no time: the job waits until 9999-12-30 (summary-F6 OPS-01d). A Postpone's time is local.
    postponeuntil: Number.isFinite(until) ? new Date(until).toISOString() : WAIT_FOREVER,
    message: null,
    data: JSON.stringify({
      ...payload,
      attempts: 0,
      wait: waiting.wait.kind,
      columns: waiting.wait.columns ?? [],
      resume: encodeSnapshot(waiting.snapshot),
    }),
  };
}

// A background run whose step failed (summary-F6 OPS-01d): the job is Suspended / Waiting with error code 0x80044331, the
// step's message as friendlymessage and in the plug-in trace of message, wait-until 9999-12-30; a Resume retries the step.
function failedPatch(payload, failed) {
  const step = failed.logs.find((entry) => entry.status === LOG_STATUS.failed && entry.activityname);
  const name = step?.activityname?.replace(/_step$/, '') ?? 'WorkflowStep0';
  const message = String(failed.error?.message ?? failed.error);
  return {
    ...WAITING_STATE,
    postponeuntil: WAIT_FOREVER,
    errorcode: FAILED_STEP_CODE,
    friendlymessage: message,
    message: `Plugin Trace:\r\n\r\n[${name}]\r\n\r\nError Message:\r\n\r\n${message}`,
    data: JSON.stringify({
      ...payload,
      attempts: 0,
      wait: 'failure',
      columns: [],
      resume: encodeSnapshot(failed.snapshot),
    }),
  };
}

// A committed write of a record wakes the condition waits on it (inside the committing transaction).
// A committed write of a record wakes the condition waits on it that read a column it wrote (summary-F6 OPS-01d: a write
// of another column, or the clock passing a time the condition compares, does not wake it). A delete wakes every wait on
// the record (local model): the run then ends Canceled.
function wakeWaitingRuns(store, events) {
  const touched = events
    .filter((event) => !event.messageEvent && event.entity !== 'asyncoperation' && event.row)
    .map((event) => {
      try {
        const mapping = store.resolveMapping(event.entity);
        const changed =
          event.operation === 'delete'
            ? null
            : new Set((event.submittedAttributes ?? []).map((name) => String(name).toLowerCase()));
        return { entity: mapping.logicalName, id: bare(event.row[mapping.idColumn]), changed };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!touched.length) return null;
  // A Suspended row names its wait's columns; a Locked one (a run in progress) may be about to wait on any wait of its
  // definition: wake() keeps it pending.
  const columnsOf = (row, payload) => {
    if (row.statecode === 1) return payload.wait === 'condition' ? (payload.columns ?? []) : [];
    const program = xamlOf(workflowRow(store, payload.definitionId) ?? {}).program;
    return program?.waitColumns ?? [];
  };
  return committedJobs(store).wake((row, payload) => {
    if (payload.kind !== JOB_KIND) return false;
    const columns = columnsOf(row, payload);
    if (!columns.length) return false;
    return touched.some(
      (record) =>
        record.entity === row.primaryentitytype &&
        record.id === lookupId(row.regardingobjectid) &&
        (record.changed === null || columns.some((column) => record.changed.has(column))),
    );
  });
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
    completedon: stampOf(api),
    regardingobjectid: run.regarding ? lookup(run.regarding.logicalName, run.regarding.id) : null,
    regardingobjecttypecode: run.regarding?.logicalName ?? null,
    message,
    ...(error ? { errorcode: errorNumber(error), errortext: error.message } : {}),
  });
}

// processsession row for a real-time failure whose workflow asks for its log on failure (syncworkflowlogonfailure).
function writeProcessSession(store, api, run, error) {
  store.insertRow('processsession', rowsOf(store, 'processsession'), {
    processsessionid: (api.ids ?? systemIds).uuid(),
    name: run.row.name,
    stepname: 'Simulator',
    processid: lookup('workflow', bare(run.row.workflowid)),
    regardingobjectid: run.regarding ? lookup(run.regarding.logicalName, run.regarding.id) : null,
    regardingobjecttypecode: run.regarding?.logicalName ?? null,
    errorcode: errorNumber(error),
    comments: error.message,
    startedon: stampOf(api),
    completedon: stampOf(api),
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
async function attempt(api, config, run, prepare, verify) {
  const atomic = (fn) => api.change(() => api.runAtomic(fn));
  const execute = async () => {
    verify?.();
    const outcome = await runClassic(api, config, run);
    verify?.();
    return outcome;
  };
  let outcome;
  try {
    if (prepare)
      outcome = await atomic(async () => {
        run = await prepare();
        return tracedRun(api, run, execute);
      });
    else outcome = await tracedRun(api, run, () => atomic(execute));
  } catch (error_) {
    if (!run) throw error_;
    // A simulator source publication that overlapped the run (HTTP 409) is not a workflow failure: the run is refused and
    // rolled back with its own error, and leaves no log or process session.
    if (error_?.code === 'SourceRefreshConflict') throw error_;
    const error = run.realtime ? realtimeFailure(error_) : error_;
    const choice = classicChoice(config, run.row);
    // A real-time interpreted run leaves no log row; its failure rolls back with the write (summary-F6 OPS-01d).
    const logged = choice.mode === 'handler' || choice.mode === 'mock' || (choice.mode === 'xaml' && !run.realtime);
    if (logged || (run.realtime && run.row.syncworkflowlogonfailure)) {
      await api.change(() =>
        api.store.transact(() => {
          if (logged)
            writeLog(api.store, api, run, {
              status: LOG_STATUS.failed,
              message: error.message,
              error,
              startedon: stampOf(api),
            });
          if (run.realtime && run.row.syncworkflowlogonfailure) writeProcessSession(api.store, api, run, error);
        }),
      );
    }
    throw error;
  }
  // A background Stop workflow with status Canceled (stopCanceled): its earlier writes have committed; the job ends Canceled.
  if (run?.stopped) throw canceled(run.stopped.message ?? STOP_CANCELED_MESSAGE);
  return outcome;
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

function executionWorkflow(api, c, workflowId) {
  const { store } = api;
  api.principals.authorize({
    user: c.user,
    entity: 'workflow',
    operation: 'read',
    mapping: store.resolveMapping('workflow'),
  });
  let row = workflowRow(store, workflowId);
  if (!row) throw native('0x8006040b', 'Workflow does not exist.');
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
  return { row, category, realtime, name };
}

function executionTarget(api, c, row, entityId) {
  const { store } = api;
  if (entityId === undefined || entityId === null || entityId === '') throw invalid('EntityId is required.');
  const primary = store.resolveMapping(row.primaryentity);
  api.principals.authorize({ user: c.user, entity: primary.logicalName, operation: 'read', mapping: primary });
  const target = isGuid(bare(entityId)) ? store.get(primary.logicalName, bare(entityId), c.identity) : null;
  if (!target)
    throw new DataError(`${primary.logicalName} With Id = ${bare(entityId)} Does Not Exist`, 404, 'NotFound', {
      id: bare(entityId),
    });
  return { target, regarding: { logicalName: primary.logicalName, id: bare(entityId) } };
}

async function portalListRun(api, config, { workflowId, entity, recordId, authorize, principal }) {
  // The selected row, workflow definition and caller are resolved in the same transaction as the handler.
  const c = await principal(await authorize());
  const { row, realtime } = executionWorkflow(api, c, workflowId);
  if (!realtime || !row.ondemand || bare(row.primaryentity) !== entity || classicChoice(config, row).mode !== 'handler')
    throw new DataError(
      'A portal list requires an on-demand real-time classic workflow with a trusted local handler for its table.',
      501,
      'WorkflowUnsupported',
    );
  return portalWorkflowExecution(api, c, row, recordId);
}

function portalWorkflowExecution(api, c, row, recordId) {
  const { target, regarding } = executionTarget(api, c, row, recordId);
  return {
    row,
    target: { logicalName: regarding.logicalName, id: regarding.id, row: target },
    caller: c.caller,
    inputs: {},
    regarding,
    realtime: true,
    jobId: null,
  };
}

function isPortalFormWorkflow(value, entity) {
  return (
    Number(value?.type) === TYPE.definition &&
    Number(value.category) === CATEGORY_WORKFLOW &&
    Number(value.mode) === 1 &&
    value.ondemand === true &&
    bare(value.primaryentity) === entity
  );
}

function portalFormWorkflow(store, config, workflowId, entity) {
  const source = workflowBypassFacts.get(store)?.get(workflowId);
  if (!isPortalFormWorkflow(source, entity)) return null;
  const row = workflowRow(store, workflowId);
  const handler = config.handlers?.get(workflowId);
  if (!isPortalFormWorkflow(row, entity) || Number(row.statecode) !== STATE_ACTIVATED || !handler) return null;
  return classicChoice(config, row).handler === handler ? row : null;
}

async function portalFormRun(api, config, { authorize, principal }) {
  const { workflowId, entity, recordId, identity } = await authorize();
  const c = await principal(identity);
  if (!portalFormWorkflow(api.store, config, workflowId, entity))
    throw new DataError(
      'A Basic Form workflow requires an exported, published, on-demand real-time workflow with a trusted handler for its ID.',
      501,
      'WorkflowUnsupported',
    );
  const { row } = executionWorkflow(api, c, workflowId);
  return portalWorkflowExecution(api, c, row, recordId);
}

function portalInvitationWorkflow(store, config, workflowId) {
  const row = isGuid(workflowId) ? workflowRow(store, workflowId) : null;
  const handler = config.handlers?.get(workflowId);
  if (
    !row ||
    Number(row.type) !== TYPE.definition ||
    Number(row.category) !== CATEGORY_WORKFLOW ||
    Number(row.statecode) !== STATE_ACTIVATED ||
    Number(row.mode) !== 1 ||
    !row.ondemand ||
    bare(row.primaryentity) !== 'contact' ||
    !handler ||
    classicChoice(config, row).handler !== handler
  )
    return null;
  return row;
}

/** Execute a qualifying contact workflow inside a local invitation redemption transaction. */
async function executePortalInvitationWorkflow(api, config, { workflowId, contactId, principal }) {
  const { store } = api;
  const row = portalInvitationWorkflow(store, config, workflowId);
  if (!row) return false;
  if (!store.inTransaction()) throw new TypeError('Invitation workflow execution requires its redemption transaction.');
  const c = await principal();
  const { target, regarding } = executionTarget(api, c, row, contactId);
  const run = {
    row,
    target: { ...regarding, row: target },
    caller: c.caller,
    inputs: {},
    regarding,
    realtime: true,
    jobId: null,
  };
  await tracedRun(api, run, () => runClassic(api, config, run));
  return true;
}

function validateModernWorkflow(config, row, name, inputs) {
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
}

/** ExecuteWorkflow: validates in the documented order, then starts the run. Returns the Web API body for the asyncoperation id. */
async function executeWorkflow(api, config, c, workflowId, body = {}) {
  const { store } = api;
  const { row, category, realtime, name } = executionWorkflow(api, c, workflowId);
  const entityId = body?.EntityId;
  const { target, regarding } = executionTarget(api, c, row, entityId);
  const inputs = inputsOf(body.InputArguments);
  const caller = c.caller;
  if (category === CATEGORY_MODERN_FLOW) {
    validateModernWorkflow(config, row, name, inputs);
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
    inRunContext(store, currentRequest()?.correlationId, caller, async () => {
      const started = { ...run, jobId };
      const message = await attempt(api, config, started);
      if (started.waiting || started.failed)
        await handOverWaitingRun(api, started, currentRequest()?.correlationId ?? null);
      return message;
    }),
  );
  return {
    status: 200,
    body: { '@odata.context': contextUrl(c.origin, c.version, 'asyncoperations/$entity'), asyncoperationid: jobId },
  };
}

// An on-demand run (an ExecuteWorkflow system job, dataverse-async.mjs) that suspended: its row takes the committed-job
// payload of a background run and the Pausing status, which the system job ends as Suspended/Waiting; from then on the
// committed-job runner wakes and resumes it as any waiting background run.
async function handOverWaitingRun(api, run, correlationId) {
  const { store } = api;
  const event = {
    entity: run.target.logicalName,
    operation: 'update',
    row: run.target.row,
    correlationId,
  };
  const payload = {
    kind: JOB_KIND,
    definitionId: bare(run.row.workflowid),
    callerId: run.caller?.systemuserid ?? null,
    chain: null,
    inputs: run.inputs ?? {},
    event: encodeEvent(event),
  };
  // A failed step hands over as a waiting job too (failedPatch): Suspended / Waiting with its error.
  // The system job ends the row Suspended / Waiting itself (from Pausing); only the other columns are written here.
  const columns = run.failed ? failedPatch(payload, run.failed) : waitingPatch(api, payload, run.waiting);
  delete columns.statecode;
  delete columns.statuscode;
  await api.change(() =>
    store.transact(
      () => {
        const { rows, index } = liveJob(store, run.jobId);
        if (index >= 0) Object.assign(rows[index], { ...columns, statuscode: PAUSING_STATUS });
      },
      { tracked: true },
    ),
  );
  committedJobs(store).watch(run.jobId);
}
const PAUSING_STATUS = 21; // asyncoperation Locked / Pausing: the system job ends it Suspended / Waiting

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

// The user an event-started run acts as: the definition's owner; a seeded definition has none, so the first systemuser.
const definitionOwnerId = (store, definition) =>
  idOf(definition.owninguser) || idOf(store.tableRows('systemuser')[0]?.systemuserid);

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
// Whether a committed event starts a background run of the definition: a background definition whose trigger fires, in
// scope, and not bypassed by the write.
function startsBackgroundRun(store, config, definition, event, changed) {
  if (
    Number(definition.mode) !== 0 ||
    !triggerFires(definition, event.operation, changed) ||
    !inScope(store, definition, event.row)
  )
    return false;
  return !pluginStepBypassed(
    workflowLogic(store, definition),
    { bypassCustomPlugins: event.bypassCustomAsync === true, bypassStepIds: event.bypassStepIds },
    config.diagnostic ?? undefined,
  );
}

function stageBackgroundRuns(api, config, events) {
  const { store } = api;
  const entries = [];
  const systemUser = idOf(store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM')?.systemuserid);
  for (const event of events) {
    if (event.messageEvent) continue;
    const changed = (event.submittedAttributes ?? []).map((name) => String(name).toLowerCase());
    for (const definition of classicDefinitions(store, event.entity)) {
      if (!startsBackgroundRun(store, config, definition, event, changed)) continue;
      const mapping = store.resolveMapping(event.entity),
        logical = mapping.logicalName,
        id = bare(event.row?.[mapping.idColumn]);
      const callerId = definitionOwnerId(store, definition);
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
          // The job is owned by the workflow owner and created by SYSTEM (summary-F6 OPS-01d).
          ...(systemUser ? { createdby: lookup('systemuser', systemUser) } : {}),
        },
      });
    }
  }
  const staged = stageCommittedJobs(store, { kind: JOB_KIND, entries });
  const woken = wakeWaitingRuns(store, events);
  if (!woken) return staged;
  return () => {
    staged?.();
    woken();
  };
}

// One background run: claim the Ready row (Locked, In Progress), run like any classic run (placeholder, handler or mock),
// then complete it Succeeded, Failed or Canceled. A row that left Ready (canceled through the Web API) is not run.
// The job row's end after a run that returned: waiting, failed at a step, or Succeeded.
function runEndPatch(api, payload, run, message) {
  if (run.waiting) return waitingPatch(api, payload, run.waiting);
  if (run.failed) return failedPatch(payload, run.failed);
  return { statecode: 3, statuscode: JOB_STATUS.succeeded, completedon: stampOf(api), message: message ?? null };
}

// The job row's end after a run that threw. An interpreted Stop with status Canceled leaves it without a message
// (summary-F6 OPS-01d).
function runErrorPatch(api, run, error) {
  return {
    statecode: 3,
    statuscode: error?.jobStatus ?? JOB_STATUS.failed,
    completedon: stampOf(api),
    message: run?.stopped ? run.stopped.message : error.message,
    errorcode: run?.stopped ? null : errorNumber(error),
  };
}

async function runBackgroundJob(api, config, { id, payload, event }) {
  const { store } = api;
  const stamp = () => stampOf(api);
  let claimed = false;
  // The claim and the final state find the job row by id inside their transaction: each backs up only the tables it
  // reaches (DataStore#transact `tracked`), not the whole state.
  await api.change(() =>
    store.transact(
      () => {
        const { rows, index } = liveJob(store, id);
        if (index < 0 || Number(rows[index].statecode) !== 0) return;
        Object.assign(rows[index], { statecode: 2, statuscode: 20, startedon: stamp() });
        claimed = true;
      },
      { tracked: true },
    ),
  );
  if (!claimed) return;
  let patch,
    current = null;
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
      inputs: payload.inputs ?? {},
      regarding: { logicalName: logical, id: rowId },
      realtime: false,
      chain: payload.chain ?? null,
      jobId: id,
      // A waiting run's snapshot: the run continues at its wait.
      ...(typeof payload.resume === 'string' ? { resume: decodeSnapshot(payload.resume) } : {}),
    };
    current = run;
    const message = await inRunContext(store, event.correlationId ?? payload.chain?.id, run.caller, () =>
      attempt(api, config, run),
    )();
    patch = runEndPatch(api, payload, run, message);
  } catch (error) {
    patch = runErrorPatch(api, current, error);
  }
  await api.change(() =>
    store.transact(
      () => {
        const { rows, index } = liveJob(store, id);
        if (index >= 0) Object.assign(rows[index], patch);
      },
      { tracked: true },
    ),
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

function realtimeRunForDefinition({ config, c, store, definition, operation, changed, logical, rowId, record }) {
  if (!triggerFires(definition, operation, changed) || !inScope(store, definition, record)) return null;
  if (
    pluginStepBypassed(
      workflowLogic(store, definition),
      { bypassCustomPlugins: c.bypassCustomPlugins === true, bypassStepIds: c.bypassStepIds },
      config.diagnostic ?? undefined,
    )
  )
    return null;
  return {
    row: definition,
    target: { logicalName: logical, id: rowId, row: record },
    caller: c.caller ?? null,
    // The request's own user (the impersonated one when an application calls on someone's behalf).
    user: c.user ?? null,
    // A standard-model portal write (under enhanced authorization c.user is the visitor's mapped user).
    portal: c.portal === true && !store.portalAuthorization?.principalId?.(c.identity),
    inputs: {},
    regarding: { logicalName: logical, id: rowId },
    realtime: true,
    jobId: null,
  };
}

function promoteRealtimeHandler(config, store, definition) {
  if (classicChoice(config, definition).mode === 'handler') store.promoteRowTransaction();
}

function takePendingWrite(c, logical, operation) {
  const list = pendingWrites.get(c) ?? [];
  const index = list.findLastIndex((entry) => entry.entity === logical && entry.operation === operation);
  if (index < 0) return null;
  return list.splice(index, 1)[0];
}

function realtimeDefinitions(store, logical) {
  return classicDefinitions(store, logical).filter((definition) => Number(definition.mode) === 1);
}

function realtimeRecord(store, mapping, operation, logical, rowId, entry) {
  const rows = operation === 'delete' ? null : store.tableRows(logical);
  return operation === 'delete' ? entry.existing : (rows[store.rowPositions(mapping, rows, rowId)?.[0]] ?? null);
}

// A real-time run is part of the write: a throw rejects the write, and the write's transaction rolls it back. Only handler and
// mock runs act; a placeholder records its diagnostic and lets the write succeed. Every write through the record hooks runs
// them: Web API, SDK and portal /_api writes alike.
// ponytail: a real-time failure keeps no workflowlog or processsession row (the write's rollback removes them); write them
// outside the rolled-back transaction when syncworkflowlogonfailure must be seen after a refusal.
async function afterWriteTriggers(api, config, c, mapping, { operation, id }) {
  const entry = takePendingWrite(c, mapping.logicalName, operation);
  if (!entry) return;
  const { store } = api;
  const logical = mapping.logicalName;
  const rowId = bare(id);
  const definitions = realtimeDefinitions(store, logical);
  if (!definitions.length) return;
  // Through the primary-key index: a search of the table would cost every write a full pass.
  const record = realtimeRecord(store, mapping, operation, logical, rowId, entry);
  if (!record) return;
  for (const definition of definitions) {
    const run = realtimeRunForDefinition({
      config,
      c,
      store,
      definition,
      operation,
      changed: entry.changed,
      logical,
      rowId,
      record,
    });
    if (!run) continue;
    // A pack handler may change any state directly: promote the write's row journal to a full backup first (as an executing
    // plug-in step does), so its writes roll back and persist with the request. Core-only runs stay on the journal.
    promoteRealtimeHandler(config, store, definition);
    try {
      await runClassic(api, config, run);
    } catch (error) {
      throw realtimeFailure(error);
    }
  }
}

// ---- Run modes for /_sim/

const RUN_MODES = ['handler', 'placeholder', 'mock', 'disabled'];
const MOCK_STATUSES = new Set([JOB_STATUS.succeeded, JOB_STATUS.failed]);

/** The stored override for a run mode. handler is the default and stores none. Throws a DataError outside the contract. */
export function runOverride(mode, mock = {}) {
  if (!RUN_MODES.includes(mode))
    throw new DataError(`mode must be one of ${RUN_MODES.join(', ')}.`, 400, 'InvalidRequest');
  if (mode === 'handler') return null;
  if (mode !== 'mock') return { mode };
  const status = mock.status ?? JOB_STATUS.succeeded;
  if (!MOCK_STATUSES.has(Number(status)))
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
      api.executePortalListWorkflow = (input) =>
        attempt(api, settings, null, () => portalListRun(api, settings, input), input.verify);
      api.hasPortalFormWorkflow = (workflowId, entity) =>
        Boolean(portalFormWorkflow(api.store, settings, workflowId, entity));
      api.executePortalFormWorkflow = (input) =>
        attempt(api, settings, null, () => portalFormRun(api, settings, input), input.verify);
      api.hasPortalInvitationWorkflow = (workflowId) =>
        Boolean(portalInvitationWorkflow(api.store, settings, workflowId));
      api.executePortalInvitationWorkflow = (input) => executePortalInvitationWorkflow(api, settings, input);
      api.recordHooks.add('beforeWrite', (c, mapping, info) => {
        if (mapping.logicalName === 'workflow') return workflowWriteRule(c, mapping, info, api.store);
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
