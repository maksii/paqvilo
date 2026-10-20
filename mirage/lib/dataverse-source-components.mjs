// Source metadata rows share the Dataverse record pipeline. Source files remain
// immutable: local writes are sparse, persisted deltas over a source snapshot.
import { isDeepStrictEqual } from 'node:util';
import { standardTableDef } from './dataverse-standard.mjs';
import { ensureSolutionComponentMapping, withSolutionAppMembers } from './dataverse-solution-components.mjs';

const lower = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const copy = value => structuredClone(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const system = name => /^__sim/.test(name) || /^(?:createdon|createdby|createdonbehalfby|modifiedon|modifiedby|modifiedonbehalfby|versionnumber)$/.test(name);
const keyOf = (table, id) => `${table}/${lower(id)}`;
const idOf = table => table === 'systemform' ? 'formid' : `${table}id`;
const settingsOf = state => ((state.dataverse ??= {}).sourceSolutionComponents ??= { version: 1, baseline: {}, overlays: {} });
function deltaOf(source, row, idColumn) {
  const values = {}, unset = [];
  for (const name of new Set([...Object.keys(source ?? {}), ...Object.keys(row ?? {})])) {
    if (name === idColumn || system(name) || isDeepStrictEqual(source?.[name], row?.[name])) continue;
    if (!own(row, name)) unset.push(name); else values[name] = copy(row[name]);
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
  const observe = event => {
    const settings = settingsOf(store.state), idColumn = idOf(event.entity), key = keyOf(event.entity, event.row[idColumn]);
    const source = settings.baseline[key];
    if (!source) return;
    if (store.state.dataverse?.solutionPayloads?.[lower(event.row[idColumn])]?.layers.some(layer => layer.active)) return;
    settings.overlays[key] = event.operation === 'delete' ? null : deltaOf(source.row, event.row, idColumn);
  };
  const unsubscribe = store.addMutationObserver(observe, { matches: event => Boolean(store.state.dataverse?.sourceSolutionComponents?.baseline?.[keyOf(event.entity, event.row[idOf(event.entity)])]) });
  const materialize = (state = store.state) => {
    const settings = settingsOf(state), previous = settings.baseline;
    const selected = new Map(withSolutionAppMembers(components() ?? [], state, entityId).map(component => [keyOf(component.logical, component.id), component]));
    for (const [key, before] of Object.entries(previous)) {
      if (selected.has(key)) continue;
      // An explicitly imported solution layer can still own the same record.
      if (state.dataverse.solutionPayloads?.[lower(before.component.id)]?.layers.length) continue;
      const table = before.component.logical, idColumn = idOf(table);
      state.tables[table] = (state.tables[table] ?? []).filter(row => lower(row[idColumn]) !== lower(before.component.id));
    }
    const next = {};
    for (const [key, component] of selected) {
      const table = component.logical, idColumn = idOf(table), id = lower(component.id);
      const source = { ...copy(component.row), [idColumn]: id };
      const rows = (state.tables[table] ??= []), index = rows.findIndex(row => lower(row[idColumn]) === id), current = rows[index];
      const before = previous[key];
      if (state.dataverse.solutionPayloads?.[id]?.layers.some(layer => layer.active)) {
        next[key] = { component: { ...copy(component), row: undefined }, row: source };
        ensureSolutionComponentMapping(state, component, standardTableDef);
        continue;
      }
      if (!own(settings.overlays, key) && current) settings.overlays[key] = deltaOf(before?.row ?? source, current, idColumn);
      const row = applyDelta(source, settings.overlays[key]);
      if (row && current) for (const [name, value] of Object.entries(current)) if (system(name)) row[name] = copy(value);
      if (row && current && !isDeepStrictEqual(row, current)) {
        state.rowVersion = Math.max(state.rowVersion ?? 0, Number(current.__simVersion ?? 0)) + 1;
        row.__simVersion = state.rowVersion;
        if (current.versionnumber !== undefined) row.versionnumber = state.rowVersion;
      }
      if (index >= 0) rows.splice(index, 1, ...(row ? [row] : [])); else if (row) rows.push(row);
      ensureSolutionComponentMapping(state, component, standardTableDef);
      next[key] = { component: { ...copy(component), row: undefined }, row: source };
    }
    settings.baseline = next;
    store.rowIndexes = null;
    return state;
  };
  return { materialize, close: unsubscribe };
}
