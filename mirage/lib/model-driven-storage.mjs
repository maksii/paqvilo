// Transactional storage for source-backed model-driven tables. The host supplies
// the export projection and its sparse-overlay conversion; this module never
// writes source files or recompiles a portal inside a database transaction.
import { isDeepStrictEqual } from 'node:util';
import { DataError } from './data-error.mjs';
import { copyPlainGraph } from './state-clone.mjs';

const copy = copyPlainGraph;
// Platform-stamped columns a source export never carries (audit, ownership, row version, the owning organization of
// an organization-owned row) survive re-materialization from source.
const system = (name) =>
  /^__sim/.test(name) ||
  /^(?:createdon|createdby|createdonbehalfby|modifiedon|modifiedby|modifiedonbehalfby|versionnumber|ownerid|owninguser|owningteam|owningbusinessunit|organizationid)$/.test(
    name,
  );
const lookupIdentity = (field, value) => {
  if (!['lookup', 'owner', 'customer'].includes(String(field?.dataverseType ?? field?.type).toLowerCase()))
    return undefined;
  if (value == null) return null;
  const id = value?.id ?? value?.value ?? value;
  const target =
    value?.logical_name ??
    value?.logicalName ??
    value?.entity ??
    (field.targets?.length === 1 ? field.targets[0] : null);
  return { id: String(id).replace(/[{}]/g, '').toLowerCase(), target: target?.toLowerCase() ?? null };
};

export function createModelDrivenStorage({ store, tables, overlayOf }) {
  const owns = (entity) => store.state.mappings[entity]?.modelDrivenSource === true;
  const assertDelete = (table, row) => {
    if (table?.protectedIds?.includes(row[table.idColumn]))
      throw new DataError(
        'The active source website cannot be deleted from its running Mirage instance.',
        501,
        'NotImplemented',
      );
  };
  const stopDeleteGuard = store.addDeleteGuard((event) => {
    if (owns(event.entity)) assertDelete(tables()[event.entity], event.row);
  });
  const observe = (event) => {
    const table = tables()[event.entity];
    if (!table?.projected)
      throw new DataError('Source table projection is unavailable.', 409, 'SourceTableUnavailable');
    const id = event.row[table.idColumn];
    if (event.operation === 'delete') assertDelete(table, event.row);
    const sourceFields = (row) =>
      Object.fromEntries(
        Object.entries(row ?? {}).filter(([name]) => name === table.idColumn || (table.fields[name] && !system(name))),
      );
    store.state.simulator ??= {};
    const settings = (store.state.simulator.modelDriven ??= {});
    settings.records ??= {};
    const key = `${table.kind}/${id}`;
    settings.records[key] =
      event.operation === 'delete'
        ? null
        : {
            ...settings.records[key],
            ...overlayOf(table, sourceFields(event.row), sourceFields(event.previous)),
          };
  };
  const unsubscribe = store.addMutationObserver(observe, { matches: (event) => owns(event.entity) });
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
      // The organization create pipeline supplies a default status reason even
      // for a thin portal export that declares only statecode.
      const preserve = (name) => system(name) || (name === 'statuscode' && !Object.hasOwn(table.fields, name));
      const previousMapping = state.mappings[entity] ?? {};
      const relationships = { ...previousMapping.relationships };
      for (const field of Object.values(table.fields)) {
        if (field.targets?.length !== 1 || relationships[field.name]) continue;
        const target = projections[field.targets[0]] ?? state.mappings[field.targets[0]];
        if (target)
          relationships[field.name] = { entity: field.targets[0], from: field.name, to: target.idColumn, many: false };
      }
      state.mappings[entity] = {
        ...previousMapping,
        modelDrivenSource: true,
        logicalName: entity,
        entitySet: table.entitySet ?? previousMapping.entitySet ?? `${entity}s`,
        idColumn: table.idColumn,
        nameColumn: table.nameColumn,
        ownership: table.ownership ?? previousMapping.ownership ?? 'OrganizationOwned',
        ...(table.tableType ? { tableType: table.tableType } : {}),
        fields: { ...previousMapping.fields, ...copy(table.fields) },
        relationships,
        columnDefaults: {
          ...previousMapping.columnDefaults,
          ...Object.fromEntries(
            Object.values(table.fields)
              .filter((field) => field.defaultValue !== undefined)
              .map((field) => [field.name, copy(field.defaultValue)]),
          ),
        },
      };
      const previous = new Map((state.tables[entity] ?? []).map((row) => [row[table.idColumn], row]));
      state.tables[entity] = table.rows.map((source) => {
        const before = previous.get(source[table.idColumn]);
        const row = {
          ...copy(source),
          ...Object.fromEntries(Object.entries(before ?? {}).filter(([name]) => preserve(name))),
        };
        for (const [name, field] of Object.entries(table.fields)) {
          if (!before || !Object.hasOwn(before, name) || !Object.hasOwn(row, name)) continue;
          const identity = lookupIdentity(field, row[name]);
          if (identity !== undefined && isDeepStrictEqual(identity, lookupIdentity(field, before[name])))
            row[name] = copy(before[name]);
        }
        if (
          before &&
          !isDeepStrictEqual(
            Object.fromEntries(Object.entries(before).filter(([name]) => !preserve(name))),
            Object.fromEntries(Object.entries(row).filter(([name]) => !preserve(name))),
          )
        ) {
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
  return {
    owns,
    materialize,
    close: () => {
      stopDeleteGuard();
      unsubscribe();
    },
  };
}
