import { cloneStateData } from './state-clone.mjs';
// Business process flows (workflow category 4) in the Dataverse API: an inventory of the definitions and the creation of instance rows.
//
// A flow's definition is a workflow row of category 4, primaryentity = the table it runs on. Its instance table is named by the
// definition's uniquename and lives in the store like any other table. dataverse-misc-messages.mjs already answers
// RetrieveProcessInstances, RetrieveActivePath and SetProcess (SetProcess is the internal-only 501 stub), so this module
// registers no message: it adds the inventory and the instance rows that those messages read.
//
// Inventory (level inventory): every category-4 workflow row is listed as { workflowid, name, uniquename, primaryentity, stages }.
// The stage list is read only when it is simple: a clientdata JSON object with a stages array, or an XAML document with stage
// elements (at most 64 elements deep), each with an id and a name. Otherwise stages is [] and the flow reports
// BPF_DEFINITION_UNPARSED once.
//
// Instances (level contract: no runtime path calls createInstance; a caller invokes it directly): createInstance
// inserts one row in the table named by the uniquename, at the first stage, through api.records.createInternal with
// the admin identity, in a nested transaction: awaited inside an open write it joins that write and rolls back with it;
// on its own it is one committed transaction. A missing table reports BPF_INSTANCE_TABLE_MISSING and creates nothing.
// An inactive flow reports BPF_DEFINITION_NOT_ACTIVE.
// A beforeWrite hook on each instance table handles a write that sets activestageid: the stage must belong to the
// instance's process, or the write answers 400 with innerCode 0x80040203. An update that moves the instance also
// maintains traversedpath (comma-separated stage ids): a stage new to the path is appended, and an earlier stage of the
// path truncates it there. Finish, abandon and reactivate (statecode and statuscode) are not modelled.
//
// Assumption: the clientdata shape (a stages array of { stageid, stagename, entityname }); a live designer export was not read.
// Assumption: the instance primary key (businessprocessflowinstanceid unless the mapping names one) and the lookup
// bpf_<primaryentity>id on the instance row follow the existing message code.
// ponytail: the inventory is re-parsed on every call (no parse cache). Fine for the definition counts a site holds.
// ponytail: a stage with no entity name takes the flow's primary entity.
// ponytail: an instance row takes the store's default statecode and statuscode; no operation here sets them.
import { DataError } from './data-error.mjs';
import { uuidV5 } from './dataverse-security.mjs';
import { parseSolutionXml } from './solution-xml.mjs';
import { onceReporter } from './dataverse-addon-common.mjs';

const BPF_CATEGORY = 4;
const MAX_DEPTH = 64;
const STATE_ACTIVATED = 1;
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const OPERATIONS = ['BusinessProcessFlowInventory', 'BusinessProcessFlowInstance'];
const OPERATION_LEVELS = { BusinessProcessFlowInventory: 'inventory', BusinessProcessFlowInstance: 'contract' };

const bare = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const isGuid = (value) => GUID.test(value);
const localName = (name) => String(name).split(':').pop().toLowerCase();
const attr = (node, name) => Object.entries(node.attrs ?? {}).find(([key]) => localName(key) === name)?.[1];

// Per-API state: one WeakMap entry per installed API. Never module-global mutable state.
const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api)) states.set(api, { reporter: onceReporter() });
  return states.get(api);
}

// Diagnostics: once per code and flow, then never again until reset.
const report = (state, entry) => state.reporter.report(entry, `${entry.code}\u0000${entry.workflowId}`);

// ---- Stage list

function jsonOf(text) {
  const source = String(text ?? '').trim();
  if (!source.startsWith('{')) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

// The stage elements of a XAML document, in document order. null when the document is not readable or nests too deep.
function xamlStages(xaml) {
  let root;
  try {
    root = parseSolutionXml(xaml);
  } catch {
    return null;
  }
  const found = [];
  let tooDeep = false;
  const walk = (node, depth) => {
    if (depth >= MAX_DEPTH) {
      tooDeep = true;
      return;
    }
    for (const child of node.children ?? []) {
      if (child.name.startsWith('#')) continue;
      if (localName(child.name) === 'stage')
        found.push({
          id: attr(child, 'stageid') ?? attr(child, 'id'),
          name: attr(child, 'stagename') ?? attr(child, 'name'),
          entity: attr(child, 'entityname') ?? attr(child, 'entity'),
        });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return tooDeep ? null : found;
}

// The stages of a flow as { id, name, entity }, or null when no simple, complete stage list is present.
function stagesOf(row, primaryentity) {
  const json = jsonOf(row.clientdata);
  let entries = null;
  if (Array.isArray(json?.stages)) {
    entries = json.stages.map((stage) => ({
      id: stage?.stageid ?? stage?.id,
      name: stage?.stagename ?? stage?.name,
      entity: stage?.entityname ?? stage?.entity,
    }));
  } else if (row.xaml) {
    entries = xamlStages(row.xaml);
  }
  if (!entries?.length || !entries.every((entry) => isGuid(bare(entry.id)) && String(entry.name ?? '').trim()))
    return null;
  return entries.map((entry) => ({
    id: bare(entry.id),
    name: String(entry.name).trim(),
    entity: String(entry.entity ?? primaryentity)
      .trim()
      .toLowerCase(),
  }));
}

// ---- Inventory

// Every category-4 workflow row, with its activation kept internal. Unparsed flows report BPF_DEFINITION_UNPARSED.
function definitionsOf(store, state) {
  return store
    .tableRows('workflow')
    .filter((row) => Number(row.category) === BPF_CATEGORY)
    .map((row) => {
      const workflowid = bare(row.workflowid);
      const name = row.name ?? null;
      const primaryentity =
        String(row.primaryentity ?? '')
          .trim()
          .toLowerCase() || null;
      const stages = primaryentity ? stagesOf(row, primaryentity) : null;
      if (!stages)
        report(state, {
          code: 'BPF_DEFINITION_UNPARSED',
          workflowId: workflowid,
          name,
          message: `Business process flow '${name}' has no primary entity or no simple stage list; its stages are not inventoried.`,
        });
      return {
        workflowid,
        name,
        uniquename: row.uniquename ?? null,
        primaryentity,
        stages: stages ?? [],
        activated: Number(row.statecode) === STATE_ACTIVATED,
      };
    });
}

const publicOf = ({ activated, ...definition }) => definition;

// ---- Instances

/**
 * createInstance(api, workflowid, targetId): inserts one instance of the flow for the record targetId (a GUID) at its first
 * stage. Resolves to the new row, or null with a diagnostic when nothing is created (missing or inactive flow, no instance
 * table, unparsed stages). The row is written through api.change and store.createRecord in a nested transaction: inside an open
 * write it joins that write (and rolls back with it), otherwise it commits on its own.
 */
export async function createInstance(api, workflowid, targetId) {
  const state = stateOf(api);
  const target = bare(targetId);
  if (!isGuid(target)) throw new TypeError('createInstance needs the target record id as a GUID.');
  const id = bare(workflowid);
  const definition = definitionsOf(api.store, state).find((entry) => entry.workflowid === id);
  if (!definition) {
    report(state, {
      code: 'BPF_DEFINITION_MISSING',
      workflowId: id,
      message: `No business process flow ${id} is in the store.`,
    });
    return null;
  }
  if (!definition.activated) {
    report(state, {
      code: 'BPF_DEFINITION_NOT_ACTIVE',
      workflowId: id,
      name: definition.name,
      message: `Business process flow '${definition.name}' is not activated; no instance is created.`,
    });
    return null;
  }
  const first = definition.stages[0];
  if (!first) return null; // the unparsed diagnostic was reported when the inventory was read
  const table = String(definition.uniquename ?? '').toLowerCase();
  if (!table || !Object.hasOwn(api.store.state.mappings, table)) {
    report(state, {
      code: 'BPF_INSTANCE_TABLE_MISSING',
      workflowId: id,
      name: definition.name,
      table,
      message: `Business process flow '${definition.name}' has no instance table '${definition.uniquename}' in the store; no instance is created.`,
    });
    return null;
  }
  const mapping = api.store.state.mappings[table];
  const logical = mapping.logicalName ?? table;
  const pk = mapping.idColumn ?? 'businessprocessflowinstanceid';
  return api.change(() =>
    api.store.transact(
      async () => {
        const rows = api.store.tableRows(logical);
        const taken = new Set(rows.map((row) => String(row[pk]).toLowerCase()));
        let ordinal = rows.length;
        let rowId;
        do rowId = uuidV5(id, `instance:${target}:${++ordinal}`);
        while (taken.has(rowId));
        const row = await api.records.createInternal(
          { identity: { admin: true } },
          logical,
          {
            [pk]: rowId,
            businessprocessflowinstanceid: rowId,
            processid: id,
            activestageid: first.id,
            traversedpath: first.id,
            [`bpf_${definition.primaryentity}id`]: target,
          },
          { authorized: true },
        );
        return cloneStateData(row);
      },
      { nested: true },
    ),
  );
}

// ---- Instance writes

const flowRows = (store) => store.tableRows('workflow').filter((row) => Number(row.category) === BPF_CATEGORY);
const isInstanceTable = (store, logical) =>
  flowRows(store).some((row) => String(row.uniquename ?? '').toLowerCase() === logical);

// The stage ids of a process: its simple stage list, and the processstage rows that the stage messages read for it.
function stageIdsOf(store, processId) {
  const row = flowRows(store).find((flow) => bare(flow.workflowid) === processId);
  const parsed = row
    ? stagesOf(
        row,
        String(row.primaryentity ?? '')
          .trim()
          .toLowerCase(),
      )
    : null;
  const native = store.tableRows('processstage').filter((stage) => bare(stage.processid) === processId);
  return new Set([...(parsed ?? []).map((stage) => stage.id), ...native.map((stage) => bare(stage.processstageid))]);
}

// The traversed path of an instance row: its comma-separated stage ids, or its current stage when the path is empty.
function traversedOf(row) {
  const path = String(row.traversedpath ?? '')
    .split(',')
    .map((id) => bare(id.trim()))
    .filter(Boolean);
  if (path.length || !row.activestageid) return path;
  return [bare(row.activestageid)];
}

// The path after a move to a stage: a stage already on the path truncates it there, any other stage is appended.
function movedPath(path, stage) {
  const at = path.indexOf(stage);
  return at < 0 ? [...path, stage] : path.slice(0, at + 1);
}

const foreignStage = (stage, processId) =>
  new DataError(`Stage '${stage}' is not a stage of business process flow '${processId}'.`, 400, 'InvalidRequest', {
    innerCode: '0x80040203',
  });

// beforeWrite on an instance table: a write that sets activestageid must name a stage of the instance's process.
// An update that moves the instance also sets traversedpath from the path it had.
function checkInstanceWrite(store, mapping, { operation, data, existing }) {
  if (operation === 'delete' || !data || !Object.hasOwn(data, 'activestageid')) return;
  if (!isInstanceTable(store, mapping.logicalName)) return;
  const stage = bare(data.activestageid);
  if (operation === 'update' && stage === bare(existing?.activestageid)) return;
  const processId = bare(data.processid ?? existing?.processid);
  if (!stageIdsOf(store, processId).has(stage)) throw foreignStage(stage, processId);
  if (operation === 'update') data.traversedpath = movedPath(traversedOf(existing), stage).join(',');
}

// ---- Extension

/** install(api, { diagnostic }): exposes api.businessProcessFlows = { list(), for(table), diagnostics() }. */
function install(api, { diagnostic } = {}) {
  const state = stateOf(api);
  state.reporter = onceReporter(diagnostic ?? api.diagnostic ?? null);
  api.recordHooks.add('beforeWrite', (c, mapping, info) => checkInstanceWrite(api.store, mapping, info));
  const list = () => definitionsOf(api.store, state).map(publicOf);
  api.businessProcessFlows = {
    list,
    for: (table) => {
      const logical = String(table ?? '').toLowerCase();
      return list().filter((flow) => flow.primaryentity === logical);
    },
    diagnostics: () => {
      list();
      return [...state.reporter.diagnostics];
    },
  };
}

function reset(api) {
  const state = stateOf(api);
  state.reporter.clear();
}

/** Capability record for the capability registry. */
function describe() {
  return {
    name: 'dataverse-bpf',
    version: 1,
    kind: 'dataverse-extension',
    level: 'contract',
    operations: OPERATIONS,
    operationLevels: OPERATION_LEVELS,
    requires: ['workflow:category=4'],
    principal: 'caller',
    stateOwner: 'store',
    lifecycle: 'per-request',
  };
}

export const EXTENSION = { name: 'dataverse-bpf', install, reset, describe };
