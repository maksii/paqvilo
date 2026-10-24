// Solution component messages over the Web API: AddSolutionComponent, RemoveSolutionComponent and the dependency functions
// (RetrieveDependentComponents, RetrieveRequiredComponents, RetrieveDependenciesForDelete, RetrieveDependenciesForUninstall,
// RetrieveMissingDependencies). Registered by dataverse-solutions.mjs install.
// Also here: patches (CloneAsPatch, CloneAsSolution), upgrades (StageSolution, StageAndUpgrade[Async], DeleteAndPromote[Async]),
// UninstallSolutionAsync, async component adds, async export and DownloadSolutionExportData, RetrieveMissingComponents and the
// preferred solution. Registered by lifecycleOperations; they take the archive reader, importer and exporter as tools.
// Also here: the managed layers (RemoveActiveCustomization, RemoveActiveCustomizations, BulkRemoveActiveCustomizationsAsync) and
// RetrieveMissingDependenciesWithMetadata, registered by layerOperations and installSolutionMessages.
// The privileges these messages require, their refusal texts and codes, and the asyncoperation operationtype of their jobs are
// guesses unless a comment says otherwise: the platform documents few of them.
//
// Dependencies are derived from the store, not stored: a column depends on its table, a lookup on its target table and a
// picklist column on its global option set; a relationship depends on both tables and on its lookup column.
// Components are the same set the solution archive reads (entity, attribute, relationship, optionset) with the
// componenttype codes of the solutioncomponent table. Writes run in one isolated transaction.
import { randomUUID } from 'node:crypto';
import { registerInternalMessage } from './dataverse-addon-common.mjs';
import { DataError } from './data-error.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { SECURITY_LAYERS, uuidV5 } from './dataverse-security.mjs';
import { organizationRecord } from './organization-context.mjs';
import {
  requireMetadataPrivilege,
  addSolutionComponents,
  componentObjectId,
  solutionRowOf,
  SOLUTION_COMPONENT_TYPE,
  DEFAULT_SOLUTION,
  assertUnpatched,
  boundFields,
  dropGlobalSet,
  dropRelationship,
  lastMetadataSeq,
  managedLayerId,
  layerStack,
  activeOnTop,
  projectManagedFlags,
} from './dataverse-metadata-relationships.mjs';
import { createColumn, dropColumn, dropTable, updateTable } from './dataverse-metadata-tables.mjs';
import { removeSolutionAssetLayers, reassignSolutionAssetLayers } from './dataverse-solution-assets.mjs';
import {
  payloadComponentsOf,
  PAYLOAD_COMPONENTS,
  removeSolutionPayloads,
  reassignSolutionPayloads,
} from './dataverse-solution-components.mjs';

const lower = (value) => String(value ?? '').toLowerCase();
const DEPENDENCY_TYPE_INTERNAL = 1; // dependency table: "Solution Internal"
const DEP_NAMESPACE = '8a4e2d10-5c3b-4f7a-b9e1-0d6c2a7f4e95';
const SOLUTION_TABLES = new Set(['solution', 'publisher', 'importjob', 'solutioncomponent']);
const notFound = (message, code) => new DataError(message, 404, code);
const invalid = (message) => new DataError(message, 400, 'InvalidRequest');

// Every component the store holds, with its key, componenttype code and object id (a metadata component's MetadataId in the
// store's organization, componentObjectId).
export function componentsOf(state, organizationId = organizationRecord(state)?.organizationid) {
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.kind}|${lower(entry.logical)}|${lower(entry.name ?? '')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      ...entry,
      key,
      id: entry.id ?? componentObjectId(entry, organizationId),
      type: entry.type ?? SOLUTION_COMPONENT_TYPE[entry.kind] ?? PAYLOAD_COMPONENTS[entry.kind],
    });
  };
  for (const [logical, mapping] of Object.entries(state.mappings ?? {})) {
    if (SOLUTION_TABLES.has(logical)) continue; // the solution service tables are not solution components
    push({ kind: 'entity', logical, name: null });
    for (const name of Object.keys(mapping.fields ?? {}))
      if (name !== mapping.idColumn) push({ kind: 'attribute', logical, name });
    for (const key of mapping.alternateKeys ?? [])
      if (!key.builtIn) push({ kind: 'key', logical, name: key.name, attributes: key.attributes });
    for (const [nav, rel] of Object.entries(mapping.relationships ?? {})) {
      if (rel.many !== false && !rel.intersect) continue; // a 1:N relationship is written once, from its referencing side
      const schemaName = rel.schemaName ?? (rel.intersect ? rel.intersect.entity : `${logical}_${nav}`);
      push({ kind: 'relationship', logical, name: schemaName, rel: { ...rel, nav } });
    }
  }
  for (const name of Object.keys(state.dataverse?.globalOptionSets ?? {}))
    push({ kind: 'optionset', logical: name, name: null });
  for (const component of payloadComponentsOf(state)) push(component);
  return out;
}

// The dependency edges between components: { dependent, required }. Only edges whose ends both exist are kept.
export function dependenciesOf(state, components = componentsOf(state)) {
  const byKey = new Map(components.map((c) => [c.key, c]));
  const at = (kind, logical, name = null) => byKey.get(`${kind}|${lower(logical)}|${lower(name ?? '')}`) ?? null;
  const edges = [];
  const link = (dependent, required) => {
    if (dependent && required && dependent !== required) edges.push({ dependent, required });
  };
  for (const c of components) {
    if (c.kind === 'attribute') {
      const field = state.mappings[c.logical]?.fields?.[c.name] ?? {};
      link(c, at('entity', c.logical));
      if (field.dataverseType === 'lookup' && field.targets?.[0]) link(c, at('entity', field.targets[0]));
      if (field.globalOptionSet) link(c, at('optionset', field.globalOptionSet));
    } else if (c.kind === 'relationship') {
      link(c, at('entity', c.logical));
      link(c, at('entity', c.rel.entity));
      if (c.rel.from && !c.rel.intersect) link(c, at('attribute', c.logical, c.rel.from));
    } else if (c.kind === 'key') {
      link(c, at('entity', c.logical));
      for (const name of c.attributes ?? []) link(c, at('attribute', c.logical, name));
    } else if (c.entity) {
      link(c, at('entity', c.entity));
    }
  }
  return edges;
}

// A dependency row as the dependency table shows it.
function dependencyRow(edge) {
  const { dependent, required } = edge;
  return {
    dependencyid: uuidV5(DEP_NAMESPACE, `${dependent.id}|${required.id}`),
    dependencytype: DEPENDENCY_TYPE_INTERNAL,
    dependentcomponentobjectid: dependent.id,
    dependentcomponenttype: dependent.type,
    requiredcomponentobjectid: required.id,
    requiredcomponenttype: required.type,
  };
}

const collection = (ctx, rows) => ({
  status: 200,
  body: {
    '@odata.context': contextUrl(ctx.origin, ctx.version, 'Collection(Microsoft.Dynamics.CRM.dependency)'),
    value: rows.map(dependencyRow),
  },
});

const componentOf = (components, id, type) => {
  const found = components.find((c) => c.id === lower(id) && c.type === Number(type));
  if (!found) throw notFound(`The solution component ${id} of type ${type} does not exist.`, 'NotFound');
  return found;
};
const requireText = (value, name) => {
  if (value === undefined || value === null || value === '') throw invalid(`${name} is required.`);
  return String(value);
};
// The component ids, types and names a solution contains, from its solutioncomponent rows.
const membersOf = (store, solutionid) =>
  store.state.tables.solutioncomponent?.filter((r) => lower(r.solutionid) === lower(solutionid)) ?? [];
function solutionOrThrow(store, uniquename) {
  const row = solutionRowOf(store, uniquename);
  if (!row) throw notFound(`Solution with UniqueName '${uniquename}' does not exist.`, 'NotFound');
  return row;
}
// Components a solution holds, as component records.
function solutionComponents(store, components, uniquename) {
  const row = solutionOrThrow(store, uniquename);
  const ids = new Set(membersOf(store, row.solutionid).map((r) => lower(r.objectid)));
  return components.filter((c) => ids.has(c.id));
}
// The transitive closure of required components of a set of components (AddRequiredComponents).
function requiredClosure(edges, start) {
  const seen = new Map(start.map((c) => [c.key, c]));
  const queue = [...start];
  while (queue.length) {
    const current = queue.shift();
    for (const edge of edges) {
      if (edge.dependent.key !== current.key || seen.has(edge.required.key)) continue;
      seen.set(edge.required.key, edge.required);
      queue.push(edge.required);
    }
  }
  return [...seen.values()];
}

// ---- Patches, upgrades, staging, async export and the preferred solution
// A patch is a solution row whose parentsolutionid is its parent's id and whose uniquename is the parent's. A holding
// solution (the upgrade staged by StageAndUpgrade) is named <uniquename>_Upgrade.
// Membership is the solutioncomponent rows under each solution's own id, so a patch holds its own components.
// The upgrade and uninstall paths remove the definitions a removed managed solution introduced (planRemoval, applyRemoval).

export const HOLDING_SUFFIX = '_Upgrade';
// asyncoperation.operationtype of the solution jobs; ImportSolutionAsync (203) is in dataverse-solutions.mjs.
export const OPERATION_TYPE = { export: 202, deleteAndPromote: 207, uninstall: 208, stageAndUpgrade: 211 };
const VERSION_DEFAULT = '1.0.0.0';
const tableOf = (store, name) => (store.state.tables[name] ??= []);
const rowsOf = (store, name) => store.state.tables[name] ?? [];
const stampOf = (api) => new Date(api.clock?.() ?? Date.now()).toISOString();
const removeWhere = (list, predicate) => {
  for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i])) list.splice(i, 1);
};
const requireVersion = (value) => {
  const text = requireText(value, 'VersionNumber');
  if (!/^\d+(\.\d+){0,3}$/.test(text)) throw invalid(`VersionNumber ${text} is not a solution version.`);
  return text;
};
function versionParts(text) {
  const parts = String(text ?? VERSION_DEFAULT)
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}
// major.minor.build.revision, compared numerically part by part.
function compareVersions(a, b) {
  const x = versionParts(a),
    y = versionParts(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The base solution (not a patch) with a unique name.
function baseOrThrow(store, uniquename) {
  const row = rowsOf(store, 'solution').find(
    (s) => lower(s.uniquename) === lower(uniquename) && s.parentsolutionid == null,
  );
  if (!row) throw notFound(`Solution with UniqueName '${uniquename}' does not exist.`, 'NotFound');
  return row;
}
const holdingOf = (store, uniquename) =>
  rowsOf(store, 'solution').find((s) => lower(s.uniquename) === lower(uniquename + HOLDING_SUFFIX)) ?? null;
const patchesOf = (store, solutionid) =>
  rowsOf(store, 'solution').filter(
    (s) => s.parentsolutionid != null && lower(s.parentsolutionid) === lower(solutionid),
  );
const isDefaultSolution = (row) => lower(row.uniquename) === lower(DEFAULT_SOLUTION);

// The components a solution holds, as archive entries ({ kind, logical, name }), from its solutioncomponent rows. The export
// archive reads it (dataverse-solutions.mjs buildSolutionArchive), so a patch exports its own components.
export function entriesOfSolution(state, solutionid) {
  const byId = new Map(componentsOf(state).map((c) => [lower(c.id), c]));
  const out = [];
  for (const row of state.tables.solutioncomponent ?? []) {
    if (lower(row.solutionid) !== lower(solutionid)) continue;
    const component = byId.get(lower(row.objectid));
    if (component) out.push({ kind: component.kind, logical: component.logical, name: component.name ?? null });
  }
  return out;
}

// solutioncomponent rows for a solution id (a patch or a holding solution as well as a base solution).
export function addMemberRows(store, solutionid, components) {
  const rows = tableOf(store, 'solutioncomponent');
  for (const component of components) {
    const objectid = lower(component.id);
    if (
      rows.some(
        (r) =>
          lower(r.solutionid) === lower(solutionid) &&
          lower(r.objectid) === objectid &&
          r.componenttype === component.type,
      )
    )
      continue;
    rows.push({
      solutioncomponentid: randomUUID(),
      solutionid,
      objectid,
      componenttype: component.type,
      rootcomponentbehavior: 0,
      ismetadata: true,
    });
  }
}

const componentById = (components, id, logicalName) => {
  const wanted = lower(id);
  const found = components.find(
    (c) =>
      lower(c.id) === wanted &&
      (!logicalName || lower(c.logical) === lower(logicalName) || lower(c.name ?? '') === lower(logicalName)),
  );
  if (!found) throw notFound(`The solution component ${id} does not exist.`, 'NotFound');
  return found;
};

// The solution a component message writes to. SolutionId addresses a patch directly (assumed: native patch addressing is not
// documented); otherwise SolutionUniqueName names the base solution.
function targetOf(store, body) {
  if (body.SolutionId) {
    const row = rowsOf(store, 'solution').find((s) => lower(s.solutionid) === lower(body.SolutionId));
    if (!row) throw notFound(`Solution with Id ${body.SolutionId} does not exist.`, 'NotFound');
    return row;
  }
  return baseOrThrow(store, requireText(body.SolutionUniqueName, 'SolutionUniqueName'));
}

// Preferred solution per user. usersettings has no preferred solution column in the standard tables, so the store keeps
// state.dataverse.preferredSolutions[systemuserid] = solutionid.
function callerKey(ctx) {
  const id = ctx.caller?.systemuserid;
  if (!id) throw new DataError('A preferred solution needs an authenticated caller.', 403, 'PrivilegeDenied');
  return lower(id);
}
const solutionEntity = (row) => ({
  solutionid: row.solutionid,
  uniquename: row.uniquename,
  friendlyname: row.friendlyname ?? row.uniquename,
  version: row.version ?? null,
  ismanaged: row.ismanaged === true,
});

// Components a staged zip brings that the store lacks: a relationship whose table is in neither the store nor the zip
// (MissingComponent). Only relationships are checked; lookup targets on columns are not read.
function missingOf(store, archive) {
  const known = (logical) =>
    store.state.mappings?.[logical] !== undefined ||
    archive.entities.some((e) => lower(e.logicalName) === lower(logical));
  const detail = (type, logical, schemaName, solution) => ({
    DisplayName: schemaName ?? logical,
    Id: componentObjectId(
      { kind: type === 10 ? 'relationship' : 'entity', logical, name: type === 10 ? schemaName : null },
      organizationRecord(store)?.organizationid,
    ),
    ParentDisplayName: null,
    ParentId: null,
    ParentSchemaName: null,
    SchemaName: schemaName ?? logical,
    Solution: solution ?? null,
    Type: type,
  });
  const out = [];
  for (const rel of archive.relationships) {
    const tables =
      rel.type === 'one-to-many' ? [rel.referencingEntity, rel.referencedEntity] : [rel.entity1, rel.entity2];
    const dependent = detail(10, tables[0], rel.schemaName, archive.solution.uniqueName);
    for (const table of tables) {
      if (!table || known(table)) continue;
      out.push({ DependentComponent: dependent, RequiredComponent: detail(1, table, table, null) });
    }
  }
  return out;
}

function stagingResults(store, archive) {
  const missing = missingOf(store, archive);
  const previous =
    rowsOf(store, 'solution').find(
      (s) => lower(s.uniquename) === lower(archive.solution.uniqueName) && s.parentsolutionid == null,
    ) ?? null;
  const publisher = archive.solution.publisher ?? {};
  return {
    MissingDependencies: missing.map((m) => ({
      CanResolveMissingDependency: false,
      DependentComponentDisplayName: m.DependentComponent.DisplayName,
      DependentComponentId: m.DependentComponent.Id,
      DependentComponentParentDisplayName: null,
      DependentComponentParentSchemaName: null,
      DependentComponentSchemaName: m.DependentComponent.SchemaName,
      DependentComponentType: String(m.DependentComponent.Type),
      RequiredComponentDisplayName: m.RequiredComponent.DisplayName,
      RequiredComponentId: m.RequiredComponent.Id,
      RequiredComponentParentDisplayName: null,
      RequiredComponentParentSchemaName: null,
      RequiredComponentSchemaName: m.RequiredComponent.SchemaName,
      RequiredComponentType: String(m.RequiredComponent.Type),
      RequiredSolutionName: null,
      MissingPackages: [],
    })),
    // SolutionComponentDetails member values are guesses (the names and type names are the zip's own; Attributes left empty)
    SolutionComponentsDetails: [
      ...archive.entities.map((e) => ({ ComponentName: e.logicalName, ComponentTypeName: 'entity', Attributes: [] })),
      ...archive.relationships.map((r) => ({
        ComponentName: r.schemaName,
        ComponentTypeName: 'relationship',
        Attributes: [],
      })),
      ...archive.optionSets.map((s) => ({ ComponentName: s.name, ComponentTypeName: 'optionset', Attributes: [] })),
    ],
    SolutionDetails: {
      HasPendingUpgrade: false,
      IsCabFile: false,
      IsManaged: archive.solution.managed === true,
      IsPatchSolution: false,
      IsPrerequisitesExport: false,
      PreviousIsManaged: previous ? previous.ismanaged === true : null,
      PreviousPatchSolutionsNames: [],
      PreviousPublisherFriendlyName: null,
      PreviousPublisherUniqueName: null,
      PreviousSolutionFriendlyName: previous?.friendlyname ?? null,
      PreviousSolutionUniqueName: previous?.uniquename ?? null,
      PreviousSolutionVersion: previous?.version ?? null,
      PublisherFriendlyName: publisher.friendlyName ?? null,
      PublisherUniqueName: publisher.uniqueName ?? null,
      SolutionDescription: archive.solution.description ?? null,
      SolutionFriendlyName: archive.solution.friendlyName ?? archive.solution.uniqueName,
      SolutionUniqueName: archive.solution.uniqueName,
      SolutionVersion: archive.solution.version,
    },
    SolutionValidationResults: [],
    StageSolutionStatus: 1, // Passed is returned whatever the missing dependencies (their native status is not known)
  };
}

// Patch and holding promotion. promotable checks both solutions exist; promote removes the base solution and its patches with
// their membership and the definitions they introduced (planRemoval, applyRemoval), then renames the holding solution to the
// base's unique name.
function promotable(store, uniquename) {
  const base = baseOrThrow(store, uniquename);
  const holding = holdingOf(store, uniquename);
  if (!holding)
    throw new DataError(
      `The ${uniquename} solution doesn’t have an upgrade that is ready to be applied.`,
      400,
      'InvalidRequest',
      { innerCode: '0x8004853B' },
    );
  return { base, holding };
}
// The objectids a solution holds (its solutioncomponent rows), lower-cased.
const heldBy = (store, solutionid) => new Set(membersOf(store, solutionid).map((r) => lower(r.objectid)));
// Metadata id of a table or column: the id the metadata reader gives it (dataverse-metadata.mjs metadataIdOf). Managed layers are keyed by it.
export const metadataIdOf = managedLayerId;

// The plan for removing a set of solutions (uninstall deletes a managed solution's components; DeleteAndPromote deletes the
// base solution and its patches). A component is removed when a removed solution holds it, no solution outside the removed ones
// and the Default solution holds it (keptIds counts as holding), and the removed solutions introduced it (componentOrigin). A
// table's columns that no other solution holds go with it. A component another component depends on, and that stays, blocks the
// removal (0x8004F01D). Pure: the plan is checked before anything is written, so a blocked removal writes nothing.
function planRemoval(store, removing, keptIds = new Set()) {
  const defaults = new Set(
    rowsOf(store, 'solution')
      .filter(isDefaultSolution)
      .map((s) => lower(s.solutionid)),
  );
  const members = rowsOf(store, 'solutioncomponent');
  const held = new Set(keptIds);
  for (const r of members)
    if (!removing.has(lower(r.solutionid)) && !defaults.has(lower(r.solutionid))) held.add(lower(r.objectid));
  const origin = store.state.dataverse?.componentOrigin ?? {};
  const components = componentsOf(store.state);
  const byId = new Map(components.map((c) => [lower(c.id), c]));
  const removedIds = new Set();
  for (const r of members) {
    const id = lower(r.objectid);
    if (removing.has(lower(r.solutionid)) && !held.has(id) && removing.has(lower(origin[id] ?? ''))) removedIds.add(id);
  }
  const removedTables = new Set(
    [...removedIds]
      .map((id) => byId.get(id))
      .filter((c) => c?.kind === 'entity')
      .map((c) => lower(c.logical)),
  );
  for (const c of components)
    if (c.kind === 'attribute' && removedTables.has(lower(c.logical)) && !held.has(lower(c.id)))
      removedIds.add(lower(c.id));
  const blocking = dependenciesOf(store.state, components).filter(
    (e) => removedIds.has(lower(e.required.id)) && !removedIds.has(lower(e.dependent.id)),
  );
  if (blocking.length)
    throw new DataError('Solution dependencies exist, cannot uninstall.', 400, 'InvalidRequest', {
      innerCode: '0x8004F01D',
    });
  return { removing, defaults, removedIds, byId };
}
// Applies a plan inside the caller's transaction: membership first, then the definitions in dependency order (relationships,
// columns of the tables that stay, tables, option sets no column is bound to). The origins and managed layers of the removed
// components go too.
function applyRemoval(api, plan) {
  const { store } = api;
  const state = store.state;
  removeWhere(
    tableOf(store, 'solutioncomponent'),
    (r) =>
      plan.removing.has(lower(r.solutionid)) ||
      (plan.defaults.has(lower(r.solutionid)) && plan.removedIds.has(lower(r.objectid))),
  );
  removeWhere(tableOf(store, 'solution'), (s) => plan.removing.has(lower(s.solutionid)));
  const removed = [...plan.removedIds].map((id) => plan.byId.get(id)).filter(Boolean);
  const dropping = new Set(removed.filter((c) => c.kind === 'entity').map((c) => lower(c.logical)));
  removeSolutionPayloads(state, plan.removing);
  removeSolutionAssetLayers(state, [...plan.removing]);
  for (const c of removed)
    if (c.kind === 'key' && state.mappings[c.logical])
      state.mappings[c.logical].alternateKeys = (state.mappings[c.logical].alternateKeys ?? []).filter(
        (key) => lower(key.name) !== lower(c.name),
      );
  for (const c of removed) if (c.kind === 'relationship') dropRelationship(api, c.name);
  for (const c of removed)
    if (c.kind === 'attribute' && !dropping.has(lower(c.logical)) && state.mappings[c.logical]?.fields?.[c.name])
      dropColumn(api, c.logical, c.name);
  for (const c of removed) if (c.kind === 'entity' && state.mappings[c.logical]) dropTable(api, c.logical);
  for (const c of removed)
    if (c.kind === 'optionset' && boundFields(api, c.logical).length === 0) dropGlobalSet(api, c.logical);
  const origin = state.dataverse?.componentOrigin ?? {};
  for (const id of plan.removedIds) delete origin[id];
  popLayers(api, plan.removing, removed);
}
// Removes the removed solutions' layers from every managed stack (uninstalling a managed solution lets the
// managed solution below it take effect; only that layer is removed). A removed
// component's stack goes with it. When the top changed and no unmanaged customization sits on top, the new top definition is
// restored into live metadata; an emptied stack leaves the remaining definition unmanaged. A Solution security role or field
// security profile (SECURITY_LAYERS kinds) gets the grants of the layer below unless it was changed after its last import
// (activeOnTop); its last layer removes the component, its grants and its user/team associations.
function popLayers(api, removing, removed = []) {
  const state = api.store.state;
  const layers = state.dataverse?.managedLayers ?? {};
  const gone = new Set(removed.map((c) => managedLayerId(api, c.kind, c.logical, c.kind === 'entity' ? null : c.name)));
  for (const [id, layer] of Object.entries(layers)) {
    if (gone.has(id)) {
      delete layers[id];
      continue;
    }
    const stack = layerStack(layer);
    const kept = stack.filter((entry) => !removing.has(lower(entry.solutionid)));
    if (kept.length === stack.length) continue;
    const topChanged = kept.at(-1) !== stack.at(-1);
    layer.stack = kept;
    const security = SECURITY_LAYERS[layer.kind];
    if (security) {
      if (!kept.length) {
        security.remove(api.store, layer.logical);
        delete layers[id];
      } else if (topChanged && !layer.activeOnTop)
        layer.applied = security.apply(api.store, layer.logical, kept.at(-1).body ?? []);
      continue;
    }
    if (!kept.length) {
      delete layers[id];
      continue;
    }
    if (topChanged && LAYER_KINDS.has(layer.kind) && restorable(api, layer) && !activeOnTop(api, layer))
      restoreLayer(api, null, layer);
  }
  projectManagedFlags(api);
}
// The live definition a restore replaces exists: the column, or a table the metadata API owns (updateTable's guard).
function restorable(api, layer) {
  const mapping = api.store.state.mappings[layer.logical];
  if (!mapping) return false;
  return layer.kind === 'attribute'
    ? Object.hasOwn(mapping.fields ?? {}, layer.name)
    : mapping.dataverseMetadata?.createdByMetadataApi === true;
}
function promote(api, uniquename) {
  const { store } = api;
  const { base, holding } = promotable(store, uniquename);
  const removing = new Set([base, ...patchesOf(store, base.solutionid)].map((s) => lower(s.solutionid)));
  applyRemoval(api, planRemoval(store, removing, heldBy(store, holding.solutionid)));
  // Retained components now belong to the promoted managed layer. Keeping the
  // deleted base owner would strand their definitions on a later uninstall.
  const origin = store.state.dataverse?.componentOrigin ?? {};
  const held = heldBy(store, holding.solutionid);
  for (const id of held) if (removing.has(lower(origin[id]))) origin[id] = holding.solutionid;
  holding.uniquename = base.uniquename;
  holding.modifiedon = stampOf(api);
  return holding.solutionid;
}

// Uninstall (UninstallSolutionAsync). Only a managed solution is uninstalled; its base and patches leave with the
// definitions they introduced (planRemoval). Plan first, so a blocked uninstall writes nothing.
function planUninstall(store, uniquename) {
  const base = baseOrThrow(store, uniquename);
  if (base.ismanaged !== true)
    throw invalid(`Solution ${uniquename} is not managed; only a managed solution is uninstalled.`);
  return planRemoval(store, new Set([base, ...patchesOf(store, base.solutionid)].map((s) => lower(s.solutionid))));
}

// Staged upgrade (StageAndUpgrade): the zip imports as the holding solution, and the base solution stays until
// DeleteAndPromote applies the upgrade. The holding solution carries the zip's own version.
export const holdingArchive = (archive) => ({
  ...archive,
  solution: { ...archive.solution, uniqueName: archive.solution.uniqueName + HOLDING_SUFFIX },
});
// The checks a holding (staged upgrade) import must pass before it writes: the base solution exists, no upgrade is pending and the
// zip is a higher version than the base. Errors use the documented codes; their status is a guess.
export function assertStageable(store, archive) {
  const name = archive.solution.uniqueName;
  const base = rowsOf(store, 'solution').find((s) => lower(s.uniquename) === lower(name) && s.parentsolutionid == null);
  if (!base)
    throw new DataError(
      `Cannot find the data for the previous version of the holding solution: [${name}].`,
      400,
      'InvalidRequest',
      { innerCode: '0x8004F083' },
    );
  if (holdingOf(store, name))
    throw new DataError(
      'This solution has a pending upgrade. Please complete the upgrade before proceeding',
      400,
      'InvalidRequest',
      { innerCode: '0x8004F086' },
    );
  if (compareVersions(archive.solution.version, base.version) <= 0)
    throw new DataError(
      'The import solution must have a higher version than the existing solution it is upgrading.',
      400,
      'InvalidRequest',
      { innerCode: '0x80048541' },
    );
}
const asyncResponse = (ctx, fragment, body) => ({
  status: 200,
  body: { '@odata.context': contextUrl(ctx.origin, ctx.version, fragment), ...body },
});

// Operations that need the archive reader and importer of dataverse-solutions.mjs, passed in as tools (no import cycle).
function lifecycleOperations(api, tools) {
  const { store } = api;
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const edges = () => dependenciesOf(store.state, componentsOf(store.state));
  const all = () => componentsOf(store.state);
  const ops = [];

  // Patches (CloneAsPatch) and roll-up (CloneAsSolution).
  ops.push({
    name: 'CloneAsPatch',
    kind: 'action',
    binding: 'unbound',
    signature: {
      params: [
        ['ParentSolutionUniqueName', 'Edm.String'],
        ['DisplayName', 'Edm.String'],
        ['VersionNumber', 'Edm.String'],
      ],
      response: [['SolutionId', 'Edm.Guid']],
    },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
      const body = ctx.body ?? {};
      const parent = baseOrThrow(store, requireText(body.ParentSolutionUniqueName, 'ParentSolutionUniqueName'));
      const displayName = requireText(body.DisplayName, 'DisplayName');
      const version = requireVersion(body.VersionNumber);
      if (parent.ismanaged === true)
        throw invalid(`Solution ${parent.uniquename} is managed; a patch is created from an unmanaged solution.`);
      const [major, minor] = versionParts(version),
        [parentMajor, parentMinor] = versionParts(parent.version);
      if (major !== parentMajor || minor !== parentMinor)
        throw invalid(`The patch version ${version} must have the same major.minor number as ${parent.version}.`);
      // A patch is higher than the parent and than every patch already made.
      const floor = patchesOf(store, parent.solutionid).reduce(
        (max, p) => (compareVersions(p.version, max) > 0 ? p.version : max),
        parent.version,
      );
      if (compareVersions(version, floor) <= 0)
        throw invalid(`The patch version ${version} must be higher than ${floor}.`);
      let id = null;
      await write(() => {
        const row = {
          solutionid: randomUUID(),
          uniquename: parent.uniquename,
          friendlyname: displayName,
          version,
          ismanaged: false,
          publisherid: parent.publisherid ?? null,
          description: null,
          parentsolutionid: parent.solutionid,
          createdon: stampOf(api),
          modifiedon: stampOf(api),
        };
        tableOf(store, 'solution').push(row);
        id = row.solutionid;
      });
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.CloneAsPatchResponse', { SolutionId: id });
    },
  });

  ops.push({
    name: 'CloneAsSolution',
    kind: 'action',
    binding: 'unbound',
    signature: {
      params: [
        ['ParentSolutionUniqueName', 'Edm.String'],
        ['DisplayName', 'Edm.String'],
        ['VersionNumber', 'Edm.String'],
      ],
      response: [['SolutionId', 'Edm.Guid']],
    },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
      const body = ctx.body ?? {};
      const parent = baseOrThrow(store, requireText(body.ParentSolutionUniqueName, 'ParentSolutionUniqueName'));
      const displayName = requireText(body.DisplayName, 'DisplayName');
      const version = requireVersion(body.VersionNumber);
      if (parent.ismanaged === true)
        throw invalid(`Solution ${parent.uniquename} is managed; only an unmanaged solution is cloned.`);
      const [a, b] = versionParts(version),
        [c, d] = versionParts(parent.version);
      if (!(a > c || (a === c && b > d)))
        throw invalid(`The solution version ${version} must have a higher major.minor number than ${parent.version}.`);
      // The patches roll up into the base solution, which becomes the new version.
      await write(() => {
        const patchIds = new Set(patchesOf(store, parent.solutionid).map((p) => lower(p.solutionid)));
        const members = tableOf(store, 'solutioncomponent');
        const held = new Set(
          members
            .filter((r) => lower(r.solutionid) === lower(parent.solutionid))
            .map((r) => `${lower(r.objectid)}|${r.componenttype}`),
        );
        for (const r of members) {
          if (!patchIds.has(lower(r.solutionid))) continue;
          const key = `${lower(r.objectid)}|${r.componenttype}`;
          if (held.has(key)) continue; // a duplicate is dropped with its patch below
          r.solutionid = parent.solutionid;
          held.add(key);
        }
        removeWhere(members, (r) => patchIds.has(lower(r.solutionid)));
        reassignSolutionAssetLayers(store.state, [...patchIds], parent.solutionid);
        reassignSolutionPayloads(store.state, patchIds, parent.solutionid);
        removeWhere(tableOf(store, 'solution'), (s) => patchIds.has(lower(s.solutionid)));
        // The transaction works on its own copy: update the row as it is inside it, not the one read before it.
        const row = rowsOf(store, 'solution').find((s) => s.solutionid === parent.solutionid);
        Object.assign(row, { version, friendlyname: displayName, modifiedon: stampOf(api) });
      });
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.CloneAsSolutionResponse', { SolutionId: parent.solutionid });
    },
  });

  // Upgrade (StageAndUpgrade, StageAndUpgradeAsync, DeleteAndPromote, DeleteAndPromoteAsync).
  ops.push({
    name: 'StageAndUpgrade',
    kind: 'action',
    binding: 'unbound',
    signature: {
      params: [
        ['OverwriteUnmanagedCustomizations', 'Edm.Boolean'],
        ['PublishWorkflows', 'Edm.Boolean'],
        ['CustomizationFile', 'Edm.Binary'],
        ['ImportJobId', 'Edm.Guid'],
      ],
      response: [['SolutionId', 'Edm.Guid']],
    },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
      const body = ctx.body ?? {};
      const archive = tools.readArchive(body.CustomizationFile);
      assertStageable(store, archive);
      const jobId = typeof body.ImportJobId === 'string' && body.ImportJobId ? body.ImportJobId : randomUUID();
      await tools.importArchive(holdingArchive(archive), {
        overwrite: body.OverwriteUnmanagedCustomizations === true,
        jobId,
        origin: ctx.origin,
        version: ctx.version,
        caller: ctx.caller,
      });
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.StageAndUpgradeResponse', {
        SolutionId: holdingOf(store, archive.solution.uniqueName).solutionid,
      });
    },
  });
  ops.push({
    name: 'StageAndUpgradeAsync',
    kind: 'action',
    binding: 'unbound',
    signature: {
      params: [
        ['OverwriteUnmanagedCustomizations', 'Edm.Boolean'],
        ['PublishWorkflows', 'Edm.Boolean'],
        ['CustomizationFile', 'Edm.Binary'],
        ['ImportJobId', 'Edm.Guid'],
      ],
      response: [
        ['ImportJobKey', 'Edm.String'],
        ['AsyncOperationId', 'Edm.Guid'],
      ],
    },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
      const body = ctx.body ?? {};
      const archive = tools.readArchive(body.CustomizationFile);
      assertStageable(store, archive);
      const jobId = typeof body.ImportJobId === 'string' && body.ImportJobId ? body.ImportJobId : randomUUID();
      const asyncId = await api.systemJob(
        {
          name: `Stage upgrade ${archive.solution.uniqueName}`,
          operationtype: OPERATION_TYPE.stageAndUpgrade,
          callerId: ctx.caller.systemuserid,
        },
        () =>
          tools.importArchive(holdingArchive(archive), {
            overwrite: body.OverwriteUnmanagedCustomizations === true,
            jobId,
            origin: ctx.origin,
            version: ctx.version,
            caller: ctx.caller,
          }),
      );
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.StageAndUpgradeAsyncResponse', { AsyncOperationId: asyncId });
    },
  });
  ops.push({
    name: 'DeleteAndPromote',
    kind: 'action',
    binding: 'unbound',
    signature: { params: [['UniqueName', 'Edm.String']], response: [['SolutionId', 'Edm.Guid']] },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
      requireMetadataPrivilege(api, ctx, 'prvDeleteSolution', 'solution');
      const name = requireText(ctx.body?.UniqueName, 'UniqueName');
      promotable(store, name);
      let id = null;
      await write(() => {
        id = promote(api, name);
      });
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.DeleteAndPromoteResponse', { SolutionId: id });
    },
  });
  ops.push({
    name: 'DeleteAndPromoteAsync',
    kind: 'action',
    binding: 'unbound',
    signature: { params: [['UniqueName', 'Edm.String']], response: [['AsyncOperationId', 'Edm.Guid']] },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
      requireMetadataPrivilege(api, ctx, 'prvDeleteSolution', 'solution');
      const name = requireText(ctx.body?.UniqueName, 'UniqueName');
      promotable(store, name);
      const asyncId = await api.systemJob(
        {
          name: `Delete and promote ${name}`,
          operationtype: OPERATION_TYPE.deleteAndPromote,
          callerId: ctx.caller.systemuserid,
        },
        async () => {
          await write(() => promote(api, name));
        },
      );
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.DeleteAndPromoteAsyncResponse', { AsyncOperationId: asyncId });
    },
  });

  // Uninstall (UninstallSolutionAsync). The supported job runs with operationtype 208.
  // The separate internal-only UninstallSolution declaration is registered at installation below.
  ops.push({
    name: 'UninstallSolutionAsync',
    kind: 'action',
    binding: 'unbound',
    signature: { params: [['SolutionUniqueName', 'Edm.String']], response: [['AsyncOperationId', 'Edm.Guid']] },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvDeleteSolution', 'solution');
      const name = requireText(ctx.body?.SolutionUniqueName, 'SolutionUniqueName');
      planUninstall(store, name);
      const asyncId = await api.systemJob(
        { name: `Uninstall ${name}`, operationtype: OPERATION_TYPE.uninstall, callerId: ctx.caller.systemuserid },
        async () => {
          await write(() => applyRemoval(api, planUninstall(store, name)));
        },
      );
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.UninstallSolutionAsyncResponse', { AsyncOperationId: asyncId });
    },
  });

  // Component membership, async (AddComponentToSolutionAsync, AddComponentsToSolutionAsync).
  ops.push({
    name: 'AddComponentToSolutionAsync',
    kind: 'action',
    binding: 'unbound',
    signature: {
      params: [
        ['LogicalName', 'Edm.String'],
        ['Id', 'Edm.Guid'],
        ['SolutionUniqueName', 'Edm.String'],
        ['AddRequiredComponents', 'Edm.Boolean'],
      ],
      response: [['AsyncOperationId', 'Edm.Guid']],
    },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
      const body = ctx.body ?? {};
      const target = targetOf(store, body);
      assertUnpatched(store, target);
      const component = componentById(all(), requireText(body.Id, 'Id'), body.LogicalName);
      const chosen = body.AddRequiredComponents === true ? requiredClosure(edges(), [component]) : [component];
      const asyncId = await api.systemJob(
        { name: `Add component to ${target.uniquename}`, operationtype: null, callerId: ctx.caller.systemuserid },
        async () => {
          await write(() => addMemberRows(store, target.solutionid, chosen));
        },
      );
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.AddComponentToSolutionAsyncResponse', {
        AsyncOperationId: asyncId,
      });
    },
  });
  ops.push({
    name: 'AddComponentsToSolutionAsync',
    kind: 'action',
    binding: 'unbound',
    signature: {
      params: [
        ['SolutionComponentParameters', 'mscrm.AddComponentToSolutionParametersCollection'],
        ['SolutionUniqueName', 'Edm.String'],
        ['ContinueOnError', 'Edm.Boolean'],
      ],
      response: [['AsyncOperationId', 'Edm.Guid']],
    },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
      const body = ctx.body ?? {};
      const target = targetOf(store, body);
      assertUnpatched(store, target);
      const components = all();
      const picked = [];
      for (const item of body.SolutionComponentParameters?.ParameterCollection ?? []) {
        let component;
        try {
          component = componentById(components, requireText(item.Id, 'Id'), item.LogicalName);
        } catch (error) {
          if (body.ContinueOnError === true) continue; // ContinueOnError skips a component that fails
          throw error;
        }
        picked.push(...(item.AddRequiredComponents === true ? requiredClosure(edges(), [component]) : [component]));
      }
      const asyncId = await api.systemJob(
        { name: `Add components to ${target.uniquename}`, operationtype: null, callerId: ctx.caller.systemuserid },
        async () => {
          await write(() => addMemberRows(store, target.solutionid, picked));
        },
      );
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.AddComponentsToSolutionAsyncResponse', {
        AsyncOperationId: asyncId,
      });
    },
  });

  // Async export and download (ExportSolutionAsync, DownloadSolutionExportData). The finished zip is kept per export job.
  ops.push({
    name: 'ExportSolutionAsync',
    kind: 'action',
    binding: 'unbound',
    signature: {
      params: [
        ['SolutionName', 'Edm.String'],
        ['Managed', 'Edm.Boolean'],
      ],
      response: [
        ['AsyncOperationId', 'Edm.Guid'],
        ['ExportJobId', 'Edm.Guid'],
      ],
    },
    async handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvExportCustomization', 'solution');
      const name = requireText(ctx.body?.SolutionName, 'SolutionName');
      const row = baseOrThrow(store, name);
      assertUnpatched(store, row);
      const managed = ctx.body?.Managed === true;
      const exportJobId = randomUUID();
      const asyncId = await api.systemJob(
        { name: `Export ${name}`, operationtype: OPERATION_TYPE.export, callerId: ctx.caller.systemuserid },
        async () => {
          const zip = tools.exportArchive(row, { managed });
          await write(() => {
            ((store.state.dataverse ??= {}).exportJobs ??= {})[lower(exportJobId)] = {
              solutionName: row.uniquename,
              managed,
              file: zip.toString('base64'),
            };
          });
        },
      );
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.ExportSolutionAsyncResponse', {
        AsyncOperationId: asyncId,
        ExportJobId: exportJobId,
      });
    },
  });
  ops.push({
    name: 'DownloadSolutionExportData',
    kind: 'action',
    binding: 'unbound',
    signature: { params: [['ExportJobId', 'Edm.Guid']], response: [['ExportSolutionFile', 'Edm.Binary']] },
    handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvExportCustomization', 'solution');
      const id = requireText(ctx.body?.ExportJobId, 'ExportJobId');
      const job = store.state.dataverse?.exportJobs?.[lower(id)];
      if (!job) throw notFound(`The solution export job ${id} does not exist or has not finished.`, 'NotFound');
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.DownloadSolutionExportDataResponse', {
        ExportSolutionFile: job.file,
      });
    },
  });

  // Staging (StageSolution). Reads the zip and reports; nothing is written to the store.
  ops.push({
    name: 'StageSolution',
    kind: 'action',
    binding: 'unbound',
    csdl: STAGE_SOLUTION_CSDL,
    handle(ctx) {
      requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
      const archive = tools.readArchive(ctx.body?.CustomizationFile);
      const uploadId = ctx.body?.StageSolutionUploadId || randomUUID();
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.StageSolutionResponse', {
        StageSolutionResults: { ...stagingResults(store, archive), StageSolutionUploadId: uploadId },
      });
    },
  });
  ops.push({
    name: 'RetrieveMissingComponents',
    kind: 'function',
    binding: 'unbound',
    signature: {
      params: [['CustomizationFile', 'Edm.Binary']],
      response: [['MissingComponents', 'Collection(mscrm.MissingComponent)']],
    }, // how a binary file travels on a GET is a guess
    handle(ctx) {
      const archive = tools.readArchive(ctx.params?.CustomizationFile ?? ctx.body?.CustomizationFile);
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.RetrieveMissingComponentsResponse', {
        MissingComponents: missingOf(store, archive),
      });
    },
  });

  // Preferred solution (GetPreferredSolution, SetPreferredSolution, PreferredSolutionUsedBy). Default: the Default solution.
  ops.push({
    name: 'GetPreferredSolution',
    kind: 'function',
    binding: 'unbound',
    signature: { returns: 'mscrm.crmbaseentity' },
    handle(ctx) {
      const preferred = store.state.dataverse?.preferredSolutions?.[callerKey(ctx)];
      const row = (preferred && rowsOf(store, 'solution').find((s) => lower(s.solutionid) === lower(preferred))) ??
        rowsOf(store, 'solution').find(isDefaultSolution) ?? {
          solutionid: null,
          uniquename: DEFAULT_SOLUTION,
          friendlyname: 'Default Solution',
          version: '1.0',
          ismanaged: false,
        };
      return asyncResponse(ctx, 'solutions/$entity', solutionEntity(row));
    },
  });
  ops.push({
    name: 'SetPreferredSolution',
    kind: 'action',
    binding: 'unbound',
    signature: { params: [['SolutionId', 'Edm.Guid']] },
    async handle(ctx) {
      const key = callerKey(ctx);
      const id = requireText(ctx.body?.SolutionId, 'SolutionId');
      const row = rowsOf(store, 'solution').find((s) => lower(s.solutionid) === lower(id));
      if (!row) throw notFound(`Solution with Id ${id} does not exist.`, 'NotFound');
      if (row.ismanaged === true)
        throw invalid(`Solution ${row.uniquename} is managed; the preferred solution is unmanaged.`);
      await write(() => {
        ((store.state.dataverse ??= {}).preferredSolutions ??= {})[key] = row.solutionid;
      });
      return undefined;
    },
  });
  ops.push({
    name: 'PreferredSolutionUsedBy',
    kind: 'function',
    binding: 'unbound',
    signature: {
      params: [['SolutionId', 'Edm.Guid']],
      response: [
        ['NumberOfAssociatedUsers', 'Edm.Int32'],
        ['PreferredSolutionDetails', 'mscrm.PreferredSolutionDetails'],
      ],
    },
    handle(ctx) {
      const id = lower(requireText(ctx.params?.SolutionId, 'SolutionId'));
      const users = Object.entries(store.state.dataverse?.preferredSolutions ?? {})
        .filter(([, solution]) => lower(solution) === id)
        .map(([user]) => user);
      const AssociatedUsers = users.map((user) => {
        const row = rowsOf(store, 'systemuser').find((u) => lower(u.systemuserid) === user);
        return { FirstName: row?.firstname ?? null, LastName: row?.lastname ?? null, SystemUserId: user }; // the systemuser name columns are a guess
      });
      return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.PreferredSolutionUsedByResponse', {
        NumberOfAssociatedUsers: users.length,
        PreferredSolutionDetails: { AssociatedUsers },
      });
    },
  });
  return ops;
}

// The complex and enum types the solution operations name in their responses and parameters, as the native CSDL declares them
// (StageSolutionResults, MissingComponent, PreferredSolutionDetails, DependencyMetadataCollection, the bulk remove
// parameters and AddComponentToSolutionParametersCollection). Declared once, by the StageSolution declaration below; the other
// operations name them by type.
const SOLUTION_TYPES_CSDL = `
<ComplexType Name="StageSolutionResults"><Property Name="StageSolutionUploadId" Type="Edm.Guid" /><Property Name="SolutionComponentsDetails" Type="Collection(mscrm.SolutionComponentDetails)" /><Property Name="SolutionDetails" Type="mscrm.SolutionDetails" /><Property Name="MissingDependencies" Type="Collection(mscrm.MissingDependency)" /><Property Name="StageSolutionStatus" Type="mscrm.StageSolutionStatus" /><Property Name="SolutionValidationResults" Type="Collection(mscrm.SolutionValidationResult)" /></ComplexType>
<ComplexType Name="MissingComponent"><Property Name="RequiredComponent" Type="mscrm.ComponentDetail" /><Property Name="DependentComponent" Type="mscrm.ComponentDetail" /></ComplexType>
<ComplexType Name="PreferredSolutionDetails"><Property Name="AssociatedUsers" Type="Collection(mscrm.UserName)" /></ComplexType>
<ComplexType Name="DependencyMetadataCollection"><Property Name="DependencyMetadataInfoCollection" Type="Collection(mscrm.DependencyMetadataInfo)" /></ComplexType>
<ComplexType Name="BulkRemoveActiveCustomizationsParameters"><Property Name="ContinueOnError" Type="Edm.Boolean" /><Property Name="SolutionComponentReferences" Type="Collection(mscrm.SolutionComponentReference)" /></ComplexType>
<ComplexType Name="AddComponentToSolutionParametersCollection"><Property Name="ParameterCollection" Type="Collection(mscrm.AddComponentToSolutionParameters)" /></ComplexType>
<ComplexType Name="SolutionComponentDetails"><Property Name="ComponentName" Type="Edm.String" Unicode="false" /><Property Name="Attributes" Type="mscrm.Collection_String_String" /><Property Name="ComponentTypeName" Type="Edm.String" Unicode="false" /><Property Name="IsPresentInOrg" Type="mscrm.PresentInOrg" /></ComplexType>
<ComplexType Name="SolutionDetails"><Property Name="SolutionUniqueName" Type="Edm.String" Unicode="false" /><Property Name="SolutionFriendlyName" Type="Edm.String" Unicode="false" /><Property Name="SolutionDescription" Type="Edm.String" Unicode="false" /><Property Name="PublisherUniqueName" Type="Edm.String" Unicode="false" /><Property Name="PublisherFriendlyName" Type="Edm.String" Unicode="false" /><Property Name="PreviousSolutionUniqueName" Type="Edm.String" Unicode="false" /><Property Name="PreviousSolutionFriendlyName" Type="Edm.String" Unicode="false" /><Property Name="PreviousPublisherUniqueName" Type="Edm.String" Unicode="false" /><Property Name="PreviousPublisherFriendlyName" Type="Edm.String" Unicode="false" /><Property Name="IsPatchSolution" Type="Edm.Boolean" /><Property Name="IsManaged" Type="Edm.Boolean" /><Property Name="PreviousIsManaged" Type="Edm.Boolean" /><Property Name="SolutionVersion" Type="Edm.String" Unicode="false" /><Property Name="PreviousSolutionVersion" Type="Edm.String" Unicode="false" /><Property Name="PreviousPatchSolutionsNames" Type="Collection(Edm.String)" Unicode="false" /><Property Name="IsPrerequisitesExport" Type="Edm.Boolean" /><Property Name="HasPendingUpgrade" Type="Edm.Boolean" /><Property Name="IsCabFile" Type="Edm.Boolean" /></ComplexType>
<ComplexType Name="MissingDependency"><Property Name="RequiredComponentSchemaName" Type="Edm.String" Unicode="false" /><Property Name="RequiredComponentDisplayName" Type="Edm.String" Unicode="false" /><Property Name="RequiredComponentParentSchemaName" Type="Edm.String" Unicode="false" /><Property Name="RequiredComponentParentDisplayName" Type="Edm.String" Unicode="false" /><Property Name="RequiredComponentId" Type="Edm.Guid" /><Property Name="RequiredSolutionName" Type="Edm.String" Unicode="false" /><Property Name="RequiredComponentType" Type="Edm.String" Unicode="false" /><Property Name="DependentComponentSchemaName" Type="Edm.String" Unicode="false" /><Property Name="DependentComponentDisplayName" Type="Edm.String" Unicode="false" /><Property Name="DependentComponentParentSchemaName" Type="Edm.String" Unicode="false" /><Property Name="DependentComponentParentDisplayName" Type="Edm.String" Unicode="false" /><Property Name="DependentComponentType" Type="Edm.String" Unicode="false" /><Property Name="DependentComponentId" Type="Edm.Guid" /><Property Name="MissingPackages" Type="Collection(mscrm.MissingPackage)" /><Property Name="CanResolveMissingDependency" Type="Edm.Boolean" /></ComplexType>
<EnumType Name="StageSolutionStatus"><Member Name="Failed" Value="0" /><Member Name="Passed" Value="1" /></EnumType>
<ComplexType Name="SolutionValidationResult"><Property Name="SolutionValidationResultType" Type="mscrm.SolutionValidationResultType" /><Property Name="Message" Type="Edm.String" Unicode="false" /><Property Name="ErrorCode" Type="Edm.Int32" /><Property Name="AdditionalInfo" Type="Edm.String" Unicode="false" /></ComplexType>
<ComplexType Name="ComponentDetail"><Property Name="Type" Type="Edm.Int32" /><Property Name="SchemaName" Type="Edm.String" Unicode="false" /><Property Name="DisplayName" Type="Edm.String" Unicode="false" /><Property Name="Id" Type="Edm.Guid" /><Property Name="ParentSchemaName" Type="Edm.String" Unicode="false" /><Property Name="ParentDisplayName" Type="Edm.String" Unicode="false" /><Property Name="ParentId" Type="Edm.Guid" /><Property Name="Solution" Type="Edm.String" Unicode="false" /></ComplexType>
<ComplexType Name="UserName"><Property Name="FirstName" Type="Edm.String" Unicode="false" /><Property Name="LastName" Type="Edm.String" Unicode="false" /><Property Name="SystemUserId" Type="Edm.Guid" /></ComplexType>
<ComplexType Name="DependencyMetadataInfo"><Property Name="requiredcomponentobjectid" Type="Edm.Guid" /><Property Name="requiredcomponentdisplayname" Type="Edm.String" Unicode="false" /><Property Name="requiredcomponenttype" Type="Edm.Int32" /><Property Name="requiredcomponentname" Type="Edm.String" Unicode="false" /><Property Name="requiredcomponenttypename" Type="Edm.String" Unicode="false" /><Property Name="requiredcomponentbasesolutionid" Type="Edm.Guid" /><Property Name="requiredcomponentbasesolutionname" Type="Edm.String" Unicode="false" /><Property Name="requiredcomponentbasesolutionuniquename" Type="Edm.String" Unicode="false" /><Property Name="requiredcomponentbasesolutionversion" Type="Edm.String" Unicode="false" /><Property Name="requiredcomponentparentid" Type="Edm.Guid" /><Property Name="requiredcomponentparentdisplayname" Type="Edm.String" Unicode="false" /><Property Name="dependentcomponentobjectid" Type="Edm.Guid" /><Property Name="dependentcomponentdisplayname" Type="Edm.String" Unicode="false" /><Property Name="dependentcomponenttype" Type="Edm.Int32" /><Property Name="dependentcomponentname" Type="Edm.String" Unicode="false" /><Property Name="dependentcomponenttypename" Type="Edm.String" Unicode="false" /><Property Name="dependentcomponentbasesolutionid" Type="Edm.Guid" /><Property Name="dependentcomponentbasesolutionname" Type="Edm.String" Unicode="false" /><Property Name="dependentcomponentbasesolutionuniquename" Type="Edm.String" Unicode="false" /><Property Name="dependentcomponentbasesolutionversion" Type="Edm.String" Unicode="false" /><Property Name="dependentcomponentparentid" Type="Edm.Guid" /><Property Name="dependentcomponentparentdisplayname" Type="Edm.String" Unicode="false" /><Property Name="dependencyid" Type="Edm.Guid" /><Property Name="dependencytype" Type="Edm.Int32" /><Property Name="dependencytypename" Type="Edm.String" Unicode="false" /><Property Name="isdependencyremovalenabled" Type="Edm.Boolean" /><Property Name="dependentcomponententitysetname" Type="Edm.String" Unicode="false" /><Property Name="dependentcomponententitylogicalname" Type="Edm.String" Unicode="false" /><Property Name="requiredcomponententitylogicalname" Type="Edm.String" Unicode="false" /></ComplexType>
<ComplexType Name="SolutionComponentReference"><Property Name="Id" Type="Edm.Guid" /><Property Name="LogicalName" Type="Edm.String" Unicode="false" /></ComplexType>
<ComplexType Name="AddComponentToSolutionParameters"><Property Name="AddRequiredComponents" Type="Edm.Boolean" /><Property Name="IncludeChildComponents" Type="Edm.Boolean" /><Property Name="IncludeEntityMetadata" Type="Edm.Boolean" /><Property Name="Id" Type="Edm.Guid" /><Property Name="LogicalName" Type="Edm.String" Unicode="false" /></ComplexType>
<ComplexType Name="Collection_String_String"><Property Name="Count" Type="Edm.Int32" /><Property Name="Keys" Type="Collection(Edm.String)" Nullable="false" Unicode="false" /><Property Name="Values" Type="Collection(Edm.String)" Nullable="false" Unicode="false" /></ComplexType>
<EnumType Name="PresentInOrg"><Member Name="False" Value="0" /><Member Name="True" Value="1" /><Member Name="Unknown" Value="2" /></EnumType>
<ComplexType Name="MissingPackage"><Property Name="AppName" Type="Edm.String" Unicode="false" /><Property Name="Version" Type="Edm.String" Unicode="false" /><Property Name="PackageName" Type="Edm.String" Unicode="false" /><Property Name="ResolutionAction" Type="mscrm.MissingPackageResolutionAction" /><Property Name="ResolutionActionValue" Type="Edm.String" Unicode="false" /><Property Name="IsFirstParty" Type="Edm.Boolean" /></ComplexType>
<EnumType Name="SolutionValidationResultType"><Member Name="Info" Value="0" /><Member Name="Warning" Value="1" /><Member Name="Error" Value="2" /></EnumType>
<EnumType Name="MissingPackageResolutionAction"><Member Name="Install" Value="0" /><Member Name="Update" Value="1" /><Member Name="Ignore" Value="2" /></EnumType>
`;
// StageSolution is the operation that declares the complex types above, so its declaration comes with them.
const STAGE_SOLUTION_CSDL = `${SOLUTION_TYPES_CSDL}
<ComplexType Name="StageSolutionResponse"><Property Name="StageSolutionResults" Type="mscrm.StageSolutionResults" /></ComplexType>
<Action Name="StageSolution"><Parameter Name="CustomizationFile" Type="Edm.Binary" Nullable="false" /><Parameter Name="StageSolutionUploadId" Type="Edm.Guid" /><ReturnType Type="mscrm.StageSolutionResponse" Nullable="false" /></Action>`;

// RetrieveMissingDependenciesWithMetadata: the DependencyMetadataInfo columns, with the documented component type names.
const TYPE_NAME = { entity: 'Entity', attribute: 'Attribute', relationship: 'Relationship', optionset: 'OptionSet' };
const entitySetOf = (store, logical) => store.state.mappings[logical]?.entitySet ?? null;
// One DependencyMetadataInfo: the required and the dependent component, each with its base solution (componentOrigin), and the
// dependency row that links them. The base solution is the managed solution that introduced the component, when one did.
function dependencyMetadataInfo(store, edge, baseOf) {
  const side = (c) => {
    const base = baseOf(c.id);
    return {
      objectid: c.id,
      displayname: c.name ?? c.logical,
      type: c.type,
      name: c.name ?? c.logical,
      typename: TYPE_NAME[c.kind],
      solutionid: base?.solutionid ?? null,
      solutionname: base?.friendlyname ?? null,
      solutionuniquename: base?.uniquename ?? null,
      solutionversion: base?.version ?? null,
      entitylogical: c.logical ?? null,
    };
  };
  const req = side(edge.required),
    dep = side(edge.dependent);
  return {
    requiredcomponentobjectid: req.objectid,
    requiredcomponentdisplayname: req.displayname,
    requiredcomponenttype: req.type,
    requiredcomponentname: req.name,
    requiredcomponenttypename: req.typename,
    requiredcomponentbasesolutionid: req.solutionid,
    requiredcomponentbasesolutionname: req.solutionname,
    requiredcomponentbasesolutionuniquename: req.solutionuniquename,
    requiredcomponentbasesolutionversion: req.solutionversion,
    requiredcomponentparentid: null,
    requiredcomponentparentdisplayname: null,
    dependentcomponentobjectid: dep.objectid,
    dependentcomponentdisplayname: dep.displayname,
    dependentcomponenttype: dep.type,
    dependentcomponentname: dep.name,
    dependentcomponenttypename: dep.typename,
    dependentcomponentbasesolutionid: dep.solutionid,
    dependentcomponentbasesolutionname: dep.solutionname,
    dependentcomponentbasesolutionuniquename: dep.solutionuniquename,
    dependentcomponentbasesolutionversion: dep.solutionversion,
    dependentcomponentparentid: null,
    dependentcomponentparentdisplayname: null,
    dependencyid: dependencyRow(edge).dependencyid,
    dependencytype: DEPENDENCY_TYPE_INTERNAL,
    dependencytypename: 'Solution Internal',
    isdependencyremovalenabled: false,
    dependentcomponententitysetname: entitySetOf(store, dep.entitylogical),
    dependentcomponententitylogicalname: dep.entitylogical,
    requiredcomponententitylogicalname: req.entitylogical,
  };
}

// Managed layers. A managed import pushes the managed definition of each table and column it brings
// onto the component's ordered stack (state.dataverse.managedLayers, keyed by metadata id; dataverse-solutions.mjs apply;
// keys and relationships get an ownership-only stack). The unmanaged customization on top is active when the import kept an
// existing definition, or when a metadata change came after the layer's last managed write. Removing the active customization
// restores the top managed definition. Only a table or a column has a restorable layer.
const LAYER_KINDS = new Set(['entity', 'attribute']);
function layerOf(api, kind, id) {
  const layer = api.store.state.dataverse?.managedLayers?.[lower(id)];
  if (!LAYER_KINDS.has(kind))
    throw new DataError(
      `RemoveActiveCustomizations is not supported for components of type ${kind}.`,
      400,
      'InvalidRequest',
      { innerCode: '0x8004F059' },
    ); // status is a guess
  if (!layer || layer.kind !== kind || !layerStack(layer).length)
    throw new DataError(
      `RemoveActiveCustomization is not supported for solution layer {'${id}'} because it is not Active layer.`,
      400,
      'InvalidRequest',
      { innerCode: '0x8004F076' },
    ); // status is a guess
  return layer;
}
// Restores the top managed definition, through the overwrite path of the import: a column is replaced, a table is updated in
// place. ctx is the request (null inside an uninstall or promote: no request URL is answered).
function restoreLayer(api, ctx, layer) {
  const c = { api, origin: ctx?.origin ?? '', version: ctx?.version ?? 'v9.2', headers: {}, caller: ctx?.caller };
  const key = `LogicalName='${layer.logical}'`;
  const body = layerStack(layer).at(-1).body;
  if (layer.kind === 'attribute') {
    delete api.store.state.mappings[layer.logical].fields[layer.name];
    createColumn(c, key, structuredClone(body));
  } else updateTable(c, key, structuredClone(body));
  layer.activeOnTop = false;
  layer.seq = lastMetadataSeq(api);
}
// The removal the three operations share: false when nothing sits on top of the layer, otherwise the layer is restored (true).
function removeActive(api, ctx, kind, id) {
  const layer = layerOf(api, kind, id);
  if (!activeOnTop(api, layer)) return false;
  restoreLayer(api, ctx, layer);
  projectManagedFlags(api);
  return true;
}
// The layers of one component, bottom first, as msdyn_componentlayer rows: one per managed solution, then the Active
// (unmanaged) layer when a customization sits on top. Dataverse serves these through the msdyn_componentlayer
// virtual table; the function name, the row columns kept here and the msdyn_order numbering are this simulator's own.
function componentLayers(api, kind, id) {
  const layer = api.store.state.dataverse?.managedLayers?.[lower(id)];
  if (!layer || (kind && layer.kind !== kind)) return [];
  const solutions = rowsOf(api.store, 'solution');
  const nameOf = (solutionid) => solutions.find((s) => lower(s.solutionid) === lower(solutionid))?.uniquename ?? null;
  const row = (solution, version, order) => ({
    msdyn_componentid: lower(id),
    msdyn_solutioncomponentname: layer.kind,
    msdyn_name: layer.name ?? layer.logical,
    msdyn_solutionname: solution,
    msdyn_solutionversion: version,
    msdyn_order: order,
  });
  const rows = layerStack(layer).map((entry, index) => row(nameOf(entry.solutionid), entry.version ?? null, index + 1));
  if (rows.length && activeOnTop(api, layer)) rows.push(row('Active', null, rows.length + 1));
  return rows;
}

function layerOperations(api) {
  const { store } = api;
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const privilege = (ctx) => requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
  return [
    {
      name: 'RemoveActiveCustomization',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['LogicalName', 'Edm.String'],
          ['Id', 'Edm.Guid'],
        ],
        response: [['Success', 'Edm.Boolean']],
      },
      async handle(ctx) {
        privilege(ctx);
        const kind = lower(requireText(ctx.body?.LogicalName, 'LogicalName'));
        const id = requireText(ctx.body?.Id, 'Id');
        let Success = false;
        await write(() => {
          Success = removeActive(api, ctx, kind, id);
        });
        return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.RemoveActiveCustomizationResponse', { Success });
      },
    },
    {
      name: 'RemoveActiveCustomizations',
      kind: 'function',
      binding: 'unbound', // undocumented; the native declaration is a function
      signature: {
        params: [
          ['SolutionComponentName', 'Edm.String'],
          ['ComponentId', 'Edm.Guid'],
        ],
        response: [['Result', 'Edm.Boolean']],
      },
      async handle(ctx) {
        privilege(ctx);
        const kind = lower(requireText(ctx.params?.SolutionComponentName, 'SolutionComponentName'));
        const id = requireText(ctx.params?.ComponentId, 'ComponentId');
        let Result = false;
        await write(() => {
          Result = removeActive(api, ctx, kind, id);
        });
        return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.RemoveActiveCustomizationsResponse', { Result });
      },
    },
    {
      name: 'BulkRemoveActiveCustomizationsAsync',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [['BulkRemoveActiveCustomizationsParameters', 'mscrm.BulkRemoveActiveCustomizationsParameters']],
        response: [['AsyncOperationId', 'Edm.Guid']],
      },
      async handle(ctx) {
        privilege(ctx);
        const params = ctx.body?.BulkRemoveActiveCustomizationsParameters ?? ctx.body ?? {};
        const continueOnError = params.ContinueOnError === true;
        const references = (params.SolutionComponentReferences ?? []).map((ref) => ({
          kind: lower(requireText(ref.LogicalName, 'LogicalName')),
          id: requireText(ref.Id, 'Id'),
        }));
        // The references are checked when the request arrives; with ContinueOnError a failing reference is skipped in the job instead.
        if (!continueOnError) for (const ref of references) layerOf(api, ref.kind, ref.id);
        const asyncId = await api.systemJob(
          { name: 'Bulk remove active customizations', operationtype: null, callerId: ctx.caller.systemuserid },
          async () => {
            await write(() => {
              for (const ref of references) {
                try {
                  removeActive(api, ctx, ref.kind, ref.id);
                } catch (error) {
                  if (!continueOnError) throw error;
                }
              }
            });
          },
        );
        return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.BulkRemoveActiveCustomizationsAsyncResponse', {
          AsyncOperationId: asyncId,
        });
      },
    },
    {
      name: 'RetrieveComponentLayers',
      kind: 'function',
      binding: 'unbound', // simulator-only, see componentLayers
      signature: {
        params: [
          ['ComponentId', 'Edm.Guid'],
          ['SolutionComponentName', 'Edm.String'],
        ],
        response: [['Layers', 'Collection(mscrm.crmbaseentity)']],
      },
      async handle(ctx) {
        privilege(ctx);
        const id = requireText(ctx.params?.ComponentId, 'ComponentId').replace(/[{}']/g, '');
        const kind = ctx.params?.SolutionComponentName
          ? lower(String(ctx.params.SolutionComponentName).replace(/'/g, ''))
          : null;
        return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.RetrieveComponentLayersResponse', {
          Layers: componentLayers(api, kind, id),
        });
      },
    },
  ];
}

export function installSolutionMessages(api, tools = {}) {
  const { store } = api;
  const all = () => componentsOf(store.state);
  const edges = () => dependenciesOf(store.state, all());
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));

  const operations = [
    {
      name: 'UpdateSolutionComponent',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['ComponentId', 'Edm.Guid'],
          ['ComponentType', 'Edm.Int32'],
          ['SolutionUniqueName', 'Edm.String'],
          ['IncludedComponentSettingsValues', 'Collection(Edm.String)'],
        ],
      },
      async handle(ctx) {
        // The setting values are opaque platform strings; persist them per membership, without inventing their interpretation.
        requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
        const input = ctx.body ?? {};
        const solution = solutionOrThrow(store, requireText(input.SolutionUniqueName, 'SolutionUniqueName'));
        if (solution.ismanaged === true) throw invalid('Only components of an unmanaged solution can be updated.');
        assertUnpatched(store, solution);
        const component = componentOf(
          all(),
          requireText(input.ComponentId, 'ComponentId'),
          requireText(input.ComponentType, 'ComponentType'),
        );
        const membership = membersOf(store, solution.solutionid).find(
          (row) => lower(row.objectid) === lower(component.id) && Number(row.componenttype) === component.type,
        );
        if (!membership) throw notFound('The component does not belong to the specified solution.', 'NotFound');
        const settings = input.IncludedComponentSettingsValues;
        if (!Array.isArray(settings) || settings.some((value) => typeof value !== 'string'))
          throw invalid('IncludedComponentSettingsValues must be a collection of strings.');
        await write(() => {
          const values = ((store.state.dataverse ??= {}).solutionComponentSettings ??= {});
          values[lower(membership.solutioncomponentid)] = [...settings];
        });
        return { status: 204 };
      },
    },
    {
      name: 'AddSolutionComponent',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['ComponentId', 'Edm.Guid'],
          ['ComponentType', 'Edm.Int32'],
          ['SolutionUniqueName', 'Edm.String'],
          ['AddRequiredComponents', 'Edm.Boolean'],
        ],
        response: [['id', 'Edm.Guid']],
      },
      async handle(ctx) {
        requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
        const body = ctx.body ?? {};
        const solution = requireText(body.SolutionUniqueName, 'SolutionUniqueName');
        const components = all();
        const component = componentOf(
          components,
          requireText(body.ComponentId, 'ComponentId'),
          requireText(body.ComponentType, 'ComponentType'),
        );
        solutionOrThrow(store, solution);
        assertUnpatched(store, baseOrThrow(store, solution));
        const chosen = body.AddRequiredComponents === true ? requiredClosure(edges(), [component]) : [component];
        let id = null;
        await write(() => {
          addSolutionComponents(api, solution, chosen, { defaultSolution: false });
          const row = solutionRowOf(store, solution);
          id =
            store.state.tables.solutioncomponent.find(
              (r) => lower(r.solutionid) === lower(row.solutionid) && lower(r.objectid) === lower(component.id),
            )?.solutioncomponentid ?? null;
          // Never a false success: a component that wrote no solutioncomponent row is refused and the write rolls back.
          if (id == null)
            throw invalid(
              `The solution component ${component.id} of type ${component.type} cannot be added to a solution.`,
            );
        });
        return {
          status: 200,
          body: {
            '@odata.context': contextUrl(
              ctx.origin,
              ctx.version,
              'Microsoft.Dynamics.CRM.AddSolutionComponentResponse',
            ),
            id,
          },
        };
      },
    },
    {
      name: 'RemoveSolutionComponent',
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: [
          ['SolutionComponent', 'mscrm.solutioncomponent'],
          ['ComponentType', 'Edm.Int32'],
          ['SolutionUniqueName', 'Edm.String'],
        ],
        response: [['id', 'Edm.Guid']],
      },
      async handle(ctx) {
        requireMetadataPrivilege(api, ctx, 'prvImportCustomization', 'solution');
        const body = ctx.body ?? {};
        const solution = requireText(body.SolutionUniqueName, 'SolutionUniqueName');
        const sc = body.SolutionComponent ?? {};
        const objectId = sc.objectid ?? sc.ObjectId ?? null;
        const componentId = lower(requireText(sc.solutioncomponentid ?? sc.objectid, 'SolutionComponent'));
        const type = Number(requireText(body.ComponentType, 'ComponentType'));
        const row = solutionOrThrow(store, solution);
        assertUnpatched(store, baseOrThrow(store, solution));
        await write(() => {
          const rows = store.state.tables.solutioncomponent ?? [];
          const index = rows.findIndex(
            (r) =>
              lower(r.solutionid) === lower(row.solutionid) &&
              r.componenttype === type &&
              (lower(r.solutioncomponentid) === componentId ||
                lower(r.objectid) === componentId ||
                lower(r.objectid) === lower(objectId)),
          );
          if (index < 0) throw notFound(`The solution component does not exist in solution ${solution}.`, 'NotFound');
          rows.splice(index, 1);
        });
        return {
          status: 200,
          body: {
            '@odata.context': contextUrl(
              ctx.origin,
              ctx.version,
              'Microsoft.Dynamics.CRM.RemoveSolutionComponentResponse',
            ),
          },
        };
      },
    },
  ];

  // Dependency functions (RetrieveDependentComponents and siblings; each returns a collection of dependency rows).
  const functions = [
    {
      name: 'RetrieveDependentComponents',
      kind: 'function',
      binding: 'unbound',
      signature: {
        params: [
          ['ObjectId', 'Edm.Guid'],
          ['ComponentType', 'Edm.Int32'],
        ],
        returns: 'Collection(mscrm.dependency)',
      },
      handle(ctx) {
        const component = componentOf(
          all(),
          requireText(ctx.params?.ObjectId, 'ObjectId'),
          requireText(ctx.params?.ComponentType, 'ComponentType'),
        );
        return collection(
          ctx,
          edges().filter((e) => e.required.key === component.key),
        );
      },
    },
    {
      name: 'RetrieveRequiredComponents',
      kind: 'function',
      binding: 'unbound',
      signature: {
        params: [
          ['ObjectId', 'Edm.Guid'],
          ['ComponentType', 'Edm.Int32'],
        ],
        returns: 'Collection(mscrm.crmbaseentity)',
      }, // parameters assumed to match RetrieveDependentComponents
      handle(ctx) {
        const component = componentOf(
          all(),
          requireText(ctx.params?.ObjectId, 'ObjectId'),
          requireText(ctx.params?.ComponentType, 'ComponentType'),
        );
        return collection(
          ctx,
          edges().filter((e) => e.dependent.key === component.key),
        );
      },
    },
    {
      name: 'RetrieveDependenciesForDelete',
      kind: 'function',
      binding: 'unbound',
      signature: {
        params: [
          ['ObjectId', 'Edm.Guid'],
          ['ComponentType', 'Edm.Int32'],
        ],
        returns: 'Collection(mscrm.dependency)',
      }, // the components that depend on the component; contract assumed
      handle(ctx) {
        const component = componentOf(
          all(),
          requireText(ctx.params?.ObjectId, 'ObjectId'),
          requireText(ctx.params?.ComponentType, 'ComponentType'),
        );
        return collection(
          ctx,
          edges().filter((e) => e.required.key === component.key),
        );
      },
    },
    {
      name: 'RetrieveDependenciesForUninstall',
      kind: 'function',
      binding: 'unbound',
      signature: { params: [['SolutionUniqueName', 'Edm.String']], returns: 'Collection(mscrm.dependency)' }, // contract assumed
      handle(ctx) {
        const solution = requireText(ctx.params?.SolutionUniqueName, 'SolutionUniqueName');
        const components = all();
        const inside = new Set(solutionComponents(store, components, solution).map((c) => c.key));
        return collection(
          ctx,
          edges().filter((e) => inside.has(e.required.key) && !inside.has(e.dependent.key)),
        );
      },
    },
    {
      name: 'RetrieveMissingDependencies',
      kind: 'function',
      binding: 'unbound',
      signature: { params: [['SolutionUniqueName', 'Edm.String']], returns: 'Collection(mscrm.crmbaseentity)' }, // contract assumed
      handle(ctx) {
        const solution = requireText(ctx.params?.SolutionUniqueName, 'SolutionUniqueName');
        const components = all();
        const inside = new Set(solutionComponents(store, components, solution).map((c) => c.key));
        return collection(
          ctx,
          edges().filter((e) => inside.has(e.dependent.key) && !inside.has(e.required.key)),
        );
      },
    },
    {
      name: 'RetrieveMissingDependenciesWithMetadata',
      kind: 'function',
      binding: 'unbound', // undocumented; the contract is the native CSDL
      signature: {
        params: [
          ['SolutionUniqueName', 'Edm.String'],
          ['SkipManagedDependencies', 'Edm.Boolean'],
        ],
        response: [['DependencyMetadataCollection', 'mscrm.DependencyMetadataCollection']],
      },
      handle(ctx) {
        const solution = requireText(ctx.params?.SolutionUniqueName, 'SolutionUniqueName');
        const skipManaged =
          ctx.params?.SkipManagedDependencies === true || lower(ctx.params?.SkipManagedDependencies) === 'true';
        const components = all();
        const inside = new Set(solutionComponents(store, components, solution).map((c) => c.key));
        // The base solution of a component: the solution that introduced it (componentOrigin), by its id.
        const origin = store.state.dataverse?.componentOrigin ?? {};
        const baseOf = (id) =>
          rowsOf(store, 'solution').find((s) => lower(s.solutionid) === lower(origin[lower(id)] ?? '')) ?? null;
        const found = edges()
          .filter((e) => inside.has(e.dependent.key) && !inside.has(e.required.key))
          .filter((e) => !(skipManaged && baseOf(e.required.id)?.ismanaged === true));
        return asyncResponse(ctx, 'Microsoft.Dynamics.CRM.RetrieveMissingDependenciesWithMetadataResponse', {
          DependencyMetadataCollection: {
            DependencyMetadataInfoCollection: found.map((e) => dependencyMetadataInfo(store, e, baseOf)),
          },
        });
      },
    },
  ];
  for (const op of [...operations, ...functions, ...lifecycleOperations(api, tools), ...layerOperations(api)])
    api.registry.register(op);
  // The synchronous action is internal-only. Its native signature stays visible through the shared internal-message
  // fallback and an explicit project override; no public synchronous semantics are invented.
  // https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/uninstallsolution
  registerInternalMessage(api, {
    name: 'UninstallSolution',
    kind: 'action',
    binding: 'unbound',
    signature: { params: [['SolutionUniqueName', 'Edm.String']] },
  });
}
