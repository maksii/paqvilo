// Transactional storage for source-backed model-driven tables. The host supplies
// the export projection and its sparse-overlay conversion; this module never
// writes source files or recompiles a portal inside a database transaction.
import { isDeepStrictEqual } from 'node:util';
import { DataError } from './data-error.mjs';

const copy = value => structuredClone(value);
const system = name => /^__sim/.test(name) || /^(?:createdon|createdby|createdonbehalfby|modifiedon|modifiedby|modifiedonbehalfby|versionnumber|ownerid|owninguser|owningteam|owningbusinessunit)$/.test(name);

export function createModelDrivenStorage({ store, tables, overlayOf }) {
  const owns = entity => store.state.mappings[entity]?.modelDrivenSource === true;
  const observe = event => {
    const table = tables()[event.entity];
    if (!table?.projected) throw new DataError('Source table projection is unavailable.', 409, 'SourceTableUnavailable');
    const id = event.row[table.idColumn];
    if (event.operation === 'delete' && table.protectedIds?.includes(id))
      throw new DataError('The active source website cannot be deleted from its running Mirage instance.', 501, 'NotImplemented');
    const sourceFields = row => Object.fromEntries(Object.entries(row ?? {}).filter(([name]) => name === table.idColumn || table.fields[name] && !system(name)));
    store.state.simulator ??= {};
    const settings = store.state.simulator.modelDriven ??= {};
    settings.records ??= {};
    const key = `${table.kind}/${id}`;
    settings.records[key] = event.operation === 'delete' ? null : {
      ...settings.records[key], ...overlayOf(table, sourceFields(event.row), sourceFields(event.previous)),
    };
  };
  const unsubscribe = store.addMutationObserver(observe, { matches: event => owns(event.entity) });
  const materialize = (state = store.state) => {
    const projections = tables();
    for (const [entity, mapping] of Object.entries(state.mappings)) {
      if (mapping.modelDrivenSource === true && !projections[entity]?.projected) {
        delete state.mappings[entity];
        delete state.tables[entity];
      }
    }
    for (const [entity, table] of Object.entries(projections)) {
      if (!table.projected) continue;
      const previousMapping = state.mappings[entity] ?? {};
      const relationships = { ...previousMapping.relationships };
      for (const field of Object.values(table.fields)) {
        if (field.targets?.length !== 1 || relationships[field.name]) continue;
        const target = projections[field.targets[0]] ?? state.mappings[field.targets[0]];
        if (target) relationships[field.name] = { entity: field.targets[0], from: field.name, to: target.idColumn, many: false };
      }
      state.mappings[entity] = {
        ...previousMapping, modelDrivenSource: true, logicalName: entity,
        entitySet: table.entitySet ?? previousMapping.entitySet ?? `${entity}s`,
        idColumn: table.idColumn, nameColumn: table.nameColumn,
        ownership: table.ownership ?? previousMapping.ownership ?? 'OrganizationOwned',
        fields: { ...previousMapping.fields, ...copy(table.fields) }, relationships,
        columnDefaults: { ...previousMapping.columnDefaults, ...Object.fromEntries(Object.values(table.fields).filter(field => field.defaultValue !== undefined).map(field => [field.name, copy(field.defaultValue)])) },
      };
      const previous = new Map((state.tables[entity] ?? []).map(row => [row[table.idColumn], row]));
      state.tables[entity] = table.rows.map(source => {
        const before = previous.get(source[table.idColumn]);
        const row = { ...copy(source), ...Object.fromEntries(Object.entries(before ?? {}).filter(([name]) => system(name))) };
        if (before && !isDeepStrictEqual(Object.fromEntries(Object.entries(before).filter(([name]) => !system(name))), Object.fromEntries(Object.entries(row).filter(([name]) => !system(name))))) {
          state.rowVersion = Math.max(state.rowVersion ?? 0, Number(before.__simVersion ?? 0)) + 1;
          row.__simVersion = state.rowVersion;
          if (before.versionnumber !== undefined) row.versionnumber = state.rowVersion;
        }
        return row;
      });
    }
    store.rowIndexes = null;
    return state;
  };
  return { owns, materialize, close: unsubscribe };
}
