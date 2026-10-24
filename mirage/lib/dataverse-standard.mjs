// Runtime view of the Microsoft Learn standard table reference (lib/dataverse-standard-tables.json, built by
// scripts/dataverse-standard-tables.mjs). The file holds facts only: names, types, option labels, ownership and
// relationships. The Dataverse layer reads it under Solution metadata, and seed() adds insert-only, dataverseOnly
// stand-in mappings for the standard tables. Nothing here writes into a Solution mapping.
import fs from 'node:fs';
import { tableFields, tableColumnDefaults } from './solution-schema.mjs';
import { builtInKey } from './dataverse-elastic.mjs';

const LCID = 1033;
const FILE = new URL('./dataverse-standard-tables.json', import.meta.url);
const SET_TYPE = { bit: 'boolean', picklist: 'picklist', state: 'state', status: 'status' };
// Self-referencing relationships that are hierarchy-enabled by default (IsHierarchical).
const HIERARCHICAL_STANDARD = new Set(['account_parent_account', 'user_parent_user']);

let file = null;
let schema = null;
let fieldCache = null;
let globalSets = null;

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/** The parsed standard file (commit, licence, source, tables, relationships, optionSets), read once and frozen. */
function loadStandard() {
  return (file ??= deepFreeze(JSON.parse(fs.readFileSync(FILE, 'utf8'))));
}

/**
 * The file as a solution schema, so tableFields and fieldDefinition work unchanged. Lookup targets come from the
 * one-to-many relationships (as buildSolutionSchema derives them). isActivity is derived: an activity table's
 * primary id column is activityid (the nine activitypointer-derived tables).
 */
export function standardSchema() {
  if (schema) return schema;
  const data = loadStandard();
  const tables = {};
  for (const [name, table] of Object.entries(data.tables))
    tables[name] = { ...table, isActivity: table.primaryIdAttribute === 'activityid' };
  const targets = {};
  for (const rel of Object.values(data.relationships))
    if (rel.type === 'one-to-many')
      (targets[`${rel.referencingEntity}/${rel.referencingAttribute}`] ??= new Set()).add(rel.referencedEntity);
  schema = Object.freeze({
    lcid: LCID,
    tables,
    relationships: data.relationships,
    optionSets: data.optionSets,
    targets: Object.fromEntries(Object.entries(targets).map(([key, set]) => [key, [...set].sort()])),
  });
  return schema;
}

/** One standard table (logical name), with isActivity; null when the file does not list it. */
export function standardTableDef(logical) {
  return standardSchema().tables[String(logical ?? '').toLowerCase()] ?? null;
}

/** Field definitions of a standard table, as tableFields builds them for Solution tables. Cached per table; treat as read-only. */
export function standardFields(logical) {
  fieldCache ??= new Map();
  const name = String(logical ?? '').toLowerCase();
  if (!fieldCache.has(name)) fieldCache.set(name, Object.freeze(tableFields(standardSchema(), name)));
  return fieldCache.get(name);
}

/** Standard fields under own (Solution) fields: own keys win, standard fills the rest. */
export function mergeFields(base, own) {
  return { ...base, ...own };
}

let entityIndex = null;

/**
 * Relationships per standard table. A lookup shared by several targets (email.acceptingentityid -> queue and systemuser)
 * would give both navigations one name, so each such navigation is keyed by its target: acceptingentityid_queue.
 */
function relationshipsByEntity() {
  if (entityIndex) return entityIndex;
  const rels = Object.values(loadStandard().relationships);
  const count = new Map();
  for (const rel of rels) {
    if (rel.type !== 'one-to-many') continue;
    const key = `${rel.referencingEntity}|${rel.referencingNavigation}`;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  entityIndex = new Map();
  const add = (entity, rel) => {
    if (!entityIndex.has(entity)) entityIndex.set(entity, []);
    entityIndex.get(entity).push(rel);
  };
  for (const rel of rels) {
    if (rel.type === 'one-to-many') {
      const shared = count.get(`${rel.referencingEntity}|${rel.referencingNavigation}`) > 1;
      const normal = shared
        ? { ...rel, referencingNavigation: `${rel.referencingNavigation}_${rel.referencedEntity}` }
        : rel;
      add(rel.referencingEntity, normal);
      if (rel.referencedEntity !== rel.referencingEntity) add(rel.referencedEntity, normal);
    } else {
      for (const entity of new Set(rel.entities)) add(entity, rel);
    }
  }
  return entityIndex;
}

/**
 * Navigations a standard table gets from the file, in mapping shape (solution-data importSolutionData). Only
 * relationships whose other table satisfies exists(name) are returned. Keyed by navigation name.
 */
export function standardRelationshipsFor(logical, exists = () => true) {
  const name = String(logical ?? '').toLowerCase();
  const tables = standardSchema().tables;
  const pk = (table) => tables[table]?.primaryIdAttribute;
  const out = {};
  for (const rel of relationshipsByEntity().get(name) ?? []) {
    const cascade = rel.cascade ? { cascade: { ...rel.cascade } } : {};
    if (rel.type === 'one-to-many') {
      if (rel.referencingEntity === name && exists(rel.referencedEntity))
        out[rel.referencingNavigation] = {
          entity: rel.referencedEntity,
          from: rel.referencingAttribute,
          to: rel.referencedAttribute,
          many: false,
          schemaName: rel.schemaName,
          type: 'many-to-one',
          partner: rel.referencedNavigation,
          ...cascade,
          ...(HIERARCHICAL_STANDARD.has(rel.schemaName) ? { hierarchical: true } : {}),
        };
      if (rel.referencedEntity === name && exists(rel.referencingEntity))
        out[rel.referencedNavigation] = {
          entity: rel.referencingEntity,
          from: rel.referencedAttribute,
          to: rel.referencingAttribute,
          many: true,
          schemaName: rel.schemaName,
          type: 'one-to-many',
          partner: rel.referencingNavigation,
          ...cascade,
          ...(HIERARCHICAL_STANDARD.has(rel.schemaName) ? { hierarchical: true } : {}),
        };
    } else {
      // sides are keyed by entity name; a self-referencing relationship uses entity1/entity2 instead.
      const side = (k) => rel.sides[rel.entities[k]] ?? rel.sides[`entity${k + 1}`];
      // Index 1 is written before index 0, so a self-referencing relationship keeps the first side's values.
      for (const i of [1, 0]) {
        const other = rel.entities[1 - i];
        if (rel.entities[i] !== name || !exists(other)) continue;
        out[side(i).navigation] = {
          entity: other,
          from: pk(name),
          to: pk(other),
          many: true,
          intersect: {
            entity: rel.intersectEntity,
            from: side(i).intersectAttribute,
            to: side(1 - i).intersectAttribute,
          },
          schemaName: rel.schemaName,
          type: 'many-to-many',
          partner: side(1 - i).navigation,
        };
      }
    }
  }
  return out;
}

/** Global option sets of the standard file, keyed by Name, in the shape state.dataverse.globalOptionSets uses. Read-only. */
export function standardGlobalOptionSets() {
  if (!globalSets) {
    globalSets = {};
    for (const set of Object.values(loadStandard().optionSets))
      globalSets[set.name] = {
        name: set.name,
        type: SET_TYPE[set.type] ?? 'picklist',
        // State and status sets carry their values under states/statuses (the same value and labels shape).
        options: (set.options ?? set.states ?? set.statuses).map((option) => ({
          value: option.value,
          label: option.labels?.[LCID] ?? String(option.value),
          ...(option.labels ? { labels: option.labels } : {}),
        })),
      };
    Object.freeze(globalSets);
  }
  return globalSets;
}

// Create defaults of a standard table: column AppDefaultValue (Yes/No and choice), and the active state with its status.
function standardDefaults(table) {
  const attributes = table.attributes;
  const recordDefaults = tableColumnDefaults(attributes);
  const states = attributes.statecode?.type === 'state' ? (attributes.statecode.optionSet?.states ?? []) : [];
  const valid = states.filter((s) => Number.isInteger(s.value) && Number.isInteger(s.defaultStatus));
  let stateStatusDefaults;
  if (valid.length) {
    stateStatusDefaults = Object.fromEntries(valid.map((s) => [s.value, s.defaultStatus]));
    const active = valid.find((s) => s.value === 0);
    if (active) Object.assign(recordDefaults, { statecode: 0, statuscode: active.defaultStatus });
  }
  return { recordDefaults, stateStatusDefaults };
}

// A thin stand-in mapping, as solution-data mappingFor builds it: names, the id and name columns, the column
// types only (dataverseType), and the create defaults.
function mappingOf(table) {
  const mapping = {
    logicalName: table.logicalName,
    entitySet: table.entitySet,
    idColumn: table.primaryIdAttribute,
    ...(table.primaryNameAttribute ? { nameColumn: table.primaryNameAttribute } : {}),
    userConfigured: true,
    dataverseOnly: true,
    standardTable: true,
    tableType: table.tableType ?? 'Standard', // TableType; "Elastic" for backgroundoperation and appnotification
    ...(table.tableType === 'Elastic' ? { alternateKeys: [builtInKey(table.primaryIdAttribute)] } : {}),
    fields: Object.fromEntries(
      Object.entries(table.attributes).map(([column, a]) => [column, { dataverseType: a.type }]),
    ),
    relationships: {},
  };
  const { recordDefaults, stateStatusDefaults } = standardDefaults(table);
  if (stateStatusDefaults) mapping.stateStatusDefaults = stateStatusDefaults;
  if (Object.keys(recordDefaults).length) mapping.recordDefaults = recordDefaults;
  return mapping;
}

// Create defaults for a table the Solution defines (a standard table without a seeded stand-in): a standard column's
// default fills a column that neither the body nor the mapping's recordDefaults set. Seeded stand-ins carry the same
// defaults already, so this changes nothing for them.
function standardCreateDefaults(c, mapping, info) {
  if (info.operation !== 'create') return;
  const table = standardTableDef(mapping.logicalName);
  if (!table) return;
  const { recordDefaults } = standardDefaults(table);
  for (const [column, value] of Object.entries(recordDefaults)) {
    if (column in info.data || column in (mapping.recordDefaults ?? {})) continue;
    info.data[column] = value;
  }
}

// Field definitions for the record layer: a standard table's columns from the file, with the Solution's own fields
// (own) winning. A seeded stand-in has only thin mapping fields, so only its own definitions richer than { dataverseType }
// count. Cached per own-fields object, table and seeded flag; the result is read-only.
const combinedFields = new WeakMap();
export function fieldsWithStandard(store, logical, own) {
  const name = String(logical ?? '').toLowerCase();
  if (!standardTableDef(name)) return own;
  if (!own) return standardFields(name);
  const seeded = store.state.mappings?.[name]?.standardTable === true;
  const key = `${name}|${seeded}`;
  let byKey = combinedFields.get(own);
  if (!byKey) combinedFields.set(own, (byKey = new Map()));
  if (!byKey.has(key)) {
    const extra = seeded
      ? Object.fromEntries(
          Object.entries(own).filter(([, def]) => Object.keys(def ?? {}).some((k) => k !== 'dataverseType')),
        )
      : own;
    byKey.set(key, mergeFields(standardFields(name), extra));
  }
  return byKey.get(key);
}

/** The navigation a standard table has under segment, when its other table exists in the store (read time; nothing is stored). */
export function standardNavigation(store, logical, segment) {
  const exists = (name) => Boolean(store.state.mappings?.[name]);
  return standardRelationshipsFor(logical, exists)[segment] ?? null;
}

// Standard navigations per store mappings object and table, rebuilt when the number of mappings changes (tables are only added).
const standardNavCache = new WeakMap();
function standardNavsOf(store, name) {
  const mappings = store.state.mappings ?? {};
  const count = Object.keys(mappings).length;
  let byName = standardNavCache.get(mappings);
  if (!byName) standardNavCache.set(mappings, (byName = new Map()));
  const hit = byName.get(name);
  if (hit?.count === count) return hit.value;
  const value = standardRelationshipsFor(name, (other) => Boolean(mappings[other]));
  byName.set(name, { count, value });
  return value;
}

/**
 * A table's relationships as the Dataverse layer reads them: the mapping's own (own, by default the store's mapping) plus
 * the standard navigations the mapping lacks (own wins). Read-only; nothing is stored. dataverse false returns own
 * unchanged, which the portal paths keep reading.
 */
export function relationshipsOf(
  store,
  logical,
  own = store.state.mappings?.[String(logical ?? '').toLowerCase()]?.relationships,
  dataverse = true,
) {
  const base = own ?? {};
  const name = String(logical ?? '').toLowerCase();
  if (!dataverse || !standardTableDef(name)) return base;
  const standard = standardNavsOf(store, name);
  let out = base;
  for (const nav of Object.keys(standard)) {
    if (Object.hasOwn(base, nav)) continue;
    if (out === base) out = { ...base };
    out[nav] = standard[nav];
  }
  return out;
}

/**
 * Insert-only: a standard table without a mapping gets a stand-in mapping and an empty row list. Existing
 * mappings (Solution, user, metadata API) are never read for change, and no rows are created. Seeding twice
 * gives the same state.
 */
export function seed(store) {
  const { state } = store;
  state.mappings ??= {};
  state.tables ??= {};
  const tables = standardSchema().tables;
  const created = Object.keys(tables).filter((name) => !state.mappings[name]);
  for (const name of created) {
    state.mappings[name] = mappingOf(tables[name]);
    state.tables[name] ??= [];
  }
  // Relationships once every standard table has its mapping, so a navigation to a sibling standard table exists.
  const exists = (name) => Boolean(state.mappings[name]);
  for (const name of created) state.mappings[name].relationships = standardRelationshipsFor(name, exists);
  return state;
}

export function install(api) {
  api.recordHooks?.add('beforeWrite', standardCreateDefaults);
  return api.store.transact(() => seed(api.store));
}

export function reset(api) {
  return api.store.transact(() => seed(api.store));
}
