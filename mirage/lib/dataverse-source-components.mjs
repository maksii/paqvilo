// Source metadata rows share the Dataverse record pipeline. Source files remain
// immutable: local writes are sparse, persisted deltas over a source snapshot.
import { isDeepStrictEqual, types } from 'node:util';
import { standardTableDef } from './dataverse-standard.mjs';
import { ensureSolutionComponentMapping, withSolutionAppMembers } from './dataverse-solution-components.mjs';
import { copyPlainGraph } from './state-clone.mjs';

const lower = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const copy = copyPlainGraph;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const system = (name) =>
  /^__sim/.test(name) ||
  /^(?:createdon|createdby|createdonbehalfby|modifiedon|modifiedby|modifiedonbehalfby|versionnumber)$/.test(name);
const keyOf = (table, id) => `${table}/${lower(id)}`;
const idOf = (table) => (table === 'systemform' ? 'formid' : `${table}id`);
const WORKFLOW = 'workflow';
const settingsOf = (state) =>
  ((state.dataverse ??= {}).sourceSolutionComponents ??= { version: 1, baseline: {}, overlays: {} });
function deltaOf(source, row, idColumn) {
  const values = {},
    unset = [];
  for (const name of new Set([...Object.keys(source ?? {}), ...Object.keys(row ?? {})])) {
    if (name === idColumn || system(name) || isDeepStrictEqual(source?.[name], row?.[name])) continue;
    if (!own(row, name)) unset.push(name);
    else values[name] = copy(row[name]);
  }
  return { values, unset };
}
const applyDelta = (source, delta) => {
  if (delta === null) return null;
  const row = { ...copy(source), ...copy(delta?.values ?? {}) };
  for (const name of delta?.unset ?? []) delete row[name];
  return row;
};

export function createSourceSolutionComponentStorage({ store, components, entityId }) {
  // Workflow rows have one writer, dataverse-workflows.mjs (exported activation state and activation rows): materializing the
  // Draft source shape here would revert them on every state replacement. Workflow components still count for app membership.
  const selectedOf = (state) =>
    new Map(
      withSolutionAppMembers(components() ?? [], state, entityId)
        .filter((component) => component.logical !== WORKFLOW)
        .map((component) => [keyOf(component.logical, component.id), component]),
    );
  // The baseline records which keys came from source. Their source rows are derived again from the accepted
  // source, never persisted: every row write copies and compares each state section, so source XML kept there
  // made a single write proportional to the size of the whole solution.
  const sourceComponents = new WeakMap();
  const sourceComponentsOf = (state) => {
    const baseline = settingsOf(state).baseline;
    if (!sourceComponents.has(baseline)) sourceComponents.set(baseline, selectedOf(state));
    return sourceComponents.get(baseline);
  };
  const observe = (event) => {
    const settings = settingsOf(store.state),
      idColumn = idOf(event.entity),
      key = keyOf(event.entity, event.row[idColumn]);
    const before = settings.baseline[key];
    if (!before) return;
    if (store.state.dataverse?.solutionPayloads?.[lower(event.row[idColumn])]?.layers.some((layer) => layer.active))
      return;
    const component = before.row ? null : sourceComponentsOf(store.state).get(key);
    const source = before.row ?? (component && { ...component.row, [idColumn]: lower(component.id) });
    settings.overlays[key] = event.operation === 'delete' ? null : deltaOf(source, event.row, idColumn);
  };
  const unsubscribe = store.addMutationObserver(observe, {
    matches: (event) =>
      Boolean(
        store.state.dataverse?.sourceSolutionComponents?.baseline?.[keyOf(event.entity, event.row[idOf(event.entity)])],
      ),
  });
  const materialize = (state = store.state) => {
    const settings = settingsOf(state),
      previous = settings.baseline;
    const selected = selectedOf(state);
    const staleByTable = new Map();
    for (const [key, before] of Object.entries(previous)) {
      if (selected.has(key) || before.component.logical === WORKFLOW) continue;
      // An explicitly imported solution layer can still own the same record.
      if (state.dataverse.solutionPayloads?.[lower(before.component.id)]?.layers.length) continue;
      const table = before.component.logical;
      if (!staleByTable.has(table)) staleByTable.set(table, new Set());
      staleByTable.get(table).add(lower(before.component.id));
    }
    for (const [table, stale] of staleByTable) {
      const idColumn = idOf(table);
      state.tables[table] = (state.tables[table] ?? []).filter((row) => !stale.has(lower(row[idColumn])));
    }
    // One index per metadata table avoids scanning every form/view for every
    // component. Deletions are compacted after all keyed replacements, so their
    // positions cannot invalidate later lookups or reorder retained local rows.
    const indexes = new Map(),
      deleted = Symbol('deleted source component'),
      compact = new Set();
    const indexOf = (table, rows, idColumn) => {
      if (!indexes.has(table)) {
        const index = new Map();
        for (let offset = 0; offset < rows.length; offset++) {
          const id = lower(rows[offset][idColumn]);
          if (!index.has(id)) index.set(id, offset);
        }
        indexes.set(table, index);
      }
      return indexes.get(table);
    };
    const next = {};
    for (const [key, component] of selected) {
      const table = component.logical,
        idColumn = idOf(table),
        id = lower(component.id);
      const source = { ...copy(component.row), [idColumn]: id };
      const rows = (state.tables[table] ??= []),
        positions = indexOf(table, rows, idColumn),
        index = positions.get(id),
        current = index === undefined ? undefined : rows[index];
      const before = previous[key];
      if (state.dataverse.solutionPayloads?.[id]?.layers.some((layer) => layer.active)) {
        // An active imported layer owns the row; its source row stays recorded for the delta taken once the
        // layer is removed.
        next[key] = { component: { logical: component.logical, id: component.id }, row: source };
        ensureSolutionComponentMapping(state, component, standardTableDef);
        continue;
      }
      if (!own(settings.overlays, key) && current)
        settings.overlays[key] = deltaOf(before?.row ?? source, current, idColumn);
      let row = applyDelta(source, settings.overlays[key]);
      if (row && current)
        for (const [name, value] of Object.entries(current)) if (system(name)) row[name] = copy(value);
      if (row && current && !isDeepStrictEqual(row, current)) {
        state.rowVersion = Math.max(state.rowVersion ?? 0, Number(current.__simVersion ?? 0)) + 1;
        row.__simVersion = state.rowVersion;
        if (current.versionnumber !== undefined) row.versionnumber = state.rowVersion;
      } else if (row && current) {
        // A restored row keeps its identity/version, but its equal XML need
        // not retain another physical string beside the accepted source.
        if (!types.isProxy(current))
          for (const [name, value] of Object.entries(row)) {
            const descriptor = Object.getOwnPropertyDescriptor(current, name);
            if (typeof value === 'string' && descriptor?.writable && descriptor.value === value) current[name] = value;
          }
        row = current;
      }
      if (index !== undefined) {
        rows[index] = row ?? deleted;
        if (!row) {
          compact.add(table);
          positions.delete(id);
        }
      } else if (row) {
        positions.set(id, rows.length);
        rows.push(row);
      }
      // A reconciled key always has an overlay, so a later restart never needs the previous source row to tell
      // local edits from source changes.
      if (row && !own(settings.overlays, key)) settings.overlays[key] = { values: {}, unset: [] };
      ensureSolutionComponentMapping(state, component, standardTableDef);
      next[key] = { component: { logical: component.logical, id: component.id } };
    }
    for (const table of compact) state.tables[table] = state.tables[table].filter((row) => row !== deleted);
    settings.baseline = next;
    sourceComponents.set(next, selected);
    store.rowIndexes = null;
    return state;
  };
  return { materialize, close: unsubscribe };
}
