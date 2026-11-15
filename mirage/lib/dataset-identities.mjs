// Explicit, offline identity substitution. Relationships come from selected metadata,
// never from table prefixes, display labels or GUID-looking business text.
import { guidKey } from './dataverse-values.mjs';
import { fieldDefinition } from './solution-schema.mjs';

const own = (value, key) => (Object.hasOwn(value, key) ? value[key] : undefined);
const object = (value) => value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const lookupTypes = new Set(['lookup', 'customer', 'owner']);
const validName = (value) => /^[a-z][a-z0-9_]*$/.test(value) && !['constructor', 'prototype'].includes(value);
const invalid = (label, reason) => {
  throw new Error(`Dataset identity ${label}: ${reason}`);
};

function buildIdentityPlans(state) {
  for (const [table, values] of state.entries(state.identities, 'identities')) {
    state.tableOf(table);
    const plan = new Map(),
      targets = new Set();
    for (const [from, to] of state.entries(values, table))
      addIdentitySubstitution(state, table, from, to, plan, targets);
    state.plans.set(table, plan);
  }
}

function addIdentitySubstitution(state, table, from, to, plan, targets) {
  if (++state.identityCount > 100_000) invalid('identities', 'at most 100000 substitutions are supported');
  const source = guidKey(from),
    destination = guidKey(to);
  if (!source || !destination) invalid(table, 'substitutions require GUID source and destination identities');
  if (plan.has(source)) invalid(table, 'source identities must be unambiguous after GUID normalization');
  if (targets.has(destination)) invalid(table, 'different sources cannot share a destination identity');
  plan.set(source, destination);
  targets.add(destination);
}

function rejectNonRowIdentitySections(state) {
  for (const section of ['permissions', 'personaRoles', 'personaCatalog', 'simulator', 'plugins'])
    if (state.identityCount && state.fragment[section] && Object.keys(state.fragment[section]).length)
      invalid(section, 'non-row identity sections require their own explicit remapping; supply a row-only fragment');
}

function collectExistingRows(state) {
  for (const [table, rows] of state.entries(state.existing, 'existing')) {
    const definition = state.tableOf(table);
    if (!Array.isArray(rows)) invalid(table, 'existing rows must be an array');
    state.rowCount += rows.length;
    state.work(rows.length);
    if (state.rowCount > 100_000) invalid(table, 'at most 100000 fragment and existing rows are supported');
    const ids = new Set();
    for (const row of rows) {
      const key = object(row) ? guidKey(own(row, definition.primaryIdAttribute)) : null;
      if (!key || ids.has(key)) invalid(table, 'existing rows need distinct GUID primary keys');
      ids.add(key);
    }
    state.destinationRows.set(table, ids);
  }
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ function collectFragmentRows(state) {
  for (const [table, rows] of state.entries(state.fragment.tables, 'tables')) {
    const definition = state.tableOf(table);
    if (!Array.isArray(rows)) invalid(table, 'fragment rows must be an array');
    state.rowCount += rows.length;
    state.work(rows.length);
    if (state.rowCount > 100_000) invalid(table, 'at most 100000 fragment and existing rows are supported');
    const destinations = state.destinationRows.get(table) ?? new Set(),
      sources = new Set();
    for (const row of rows) {
      const source = object(row) ? guidKey(own(row, definition.primaryIdAttribute)) : null;
      if (!source || sources.has(source)) invalid(table, 'fragment rows need distinct GUID primary keys');
      const destination = state.plans.get(table)?.get(source) ?? source;
      if (destinations.has(destination)) invalid(table, 'remapped rows collide with another fragment or existing row');
      sources.add(source);
      destinations.add(destination);
    }
    state.destinationRows.set(table, destinations);
    state.fields.set(table, new Map());
  }
}

function collectResolvedTargets(state) {
  const metadata = { ...state.schema, targets: state.schema.targets ?? {}, optionSets: state.schema.optionSets ?? {} };
  for (const table of state.fields.keys())
    for (const [column, attribute] of state.entries(state.tableOf(table).attributes ?? {}, `${table}.attributes`)) {
      if (!object(attribute) || !lookupTypes.has(attribute.type)) continue;
      const sourceTargets = own(metadata.targets, `${table}/${column}`);
      if (Array.isArray(sourceTargets)) state.work(sourceTargets.length);
      const definition = fieldDefinition(
        metadata,
        table,
        {
          name: column,
          type: attribute.type,
          intersectTarget: attribute.intersectTarget,
        },
        { provenance: false },
      );
      if (definition.targets?.length) {
        state.work(definition.targets.length);
        state.resolvedTargets.set(`${table}/${column}`, definition.targets);
      }
    }
}

function addLookupTarget(state, table, column, logical) {
  if (!state.fields.has(table)) return;
  const targets = state.resolvedTargets.get(`${table}/${column}`) ?? [logical];
  state.work(targets.length);
  if (!validName(column) || targets.some((candidate) => !validName(candidate)))
    invalid(table, 'relationship metadata must identify exact source columns and target tables');
  const map = state.fields.get(table);
  if (!map.has(column)) map.set(column, new Set());
  for (const candidate of targets) map.get(column).add(candidate);
}

function addResolvedLookupTargets(state) {
  for (const [key, targets] of state.resolvedTargets) {
    const [table, column] = key.split('/');
    addLookupTarget(state, table, column, targets[0]);
  }
}

function addSchemaLookupTargets(state) {
  for (const [key, targets] of state.entries(state.schema.targets ?? {}, 'schema.targets')) {
    const [table, column, extra] = key.split('/');
    if (!state.fields.has(table)) continue;
    if (extra || !Array.isArray(targets)) invalid(table, 'lookup targets need table/column and a target array');
    state.work(targets.length);
    for (const logical of targets) addLookupTarget(state, table, column, logical);
  }
}

function addRelationshipLookupTargets(state) {
  for (const [, relationship] of state.entries(state.schema.relationships ?? {}, 'schema.relationships')) {
    if (!object(relationship)) invalid('relationships', 'expected relationship metadata');
    if (relationship.type === 'one-to-many')
      addLookupTarget(
        state,
        relationship.referencingEntity,
        relationship.referencingAttribute,
        relationship.referencedEntity,
      );
    else if (relationship.type === 'many-to-many') {
      addLookupTarget(state, relationship.intersectEntity, relationship.attribute1, relationship.entity1);
      addLookupTarget(state, relationship.intersectEntity, relationship.attribute2, relationship.entity2);
    }
  }
}

function collectRelationshipTargets(state) {
  addResolvedLookupTargets(state);
  addSchemaLookupTargets(state);
  addRelationshipLookupTargets(state);
}

function cloneResultRows(state) {
  state.result = structuredClone(state.fragment);
  // structuredClone preserves aliases, but substitutions are scoped to a table
  // and row. Split those mutable containers before changing any identity; opaque
  // nested data keeps its cloned graph and lookup rewrites replace whole values.
  for (const [table, rows] of Object.entries(state.result.tables)) {
    state.work(rows.length);
    state.result.tables[table] = rows.map((row) => {
      state.work(Object.keys(row).length);
      return { ...row };
    });
  }
}

function replacementFor(state, table, source) {
  const destination = state.plans.get(table)?.get(source);
  if (destination !== undefined) state.used.add(JSON.stringify([table, source]));
  return destination ?? source;
}

function resolveLookupLogicalTarget(state, table, column, logicalColumn, original, allowed, sourceId) {
  const logicalValue = own(original, logicalColumn),
    wireValue = own(original, `_${logicalColumn}_value`),
    declaredTargets = [
      object(logicalValue) ? logicalValue.logical_name : undefined,
      object(wireValue) ? wireValue.logical_name : undefined,
      original[`${logicalColumn}@Microsoft.Dynamics.CRM.lookuplogicalname`],
      original[`_${logicalColumn}_value@Microsoft.Dynamics.CRM.lookuplogicalname`],
    ].filter((item) => item !== undefined);
  if (new Set(declaredTargets).size > 1)
    invalid(`${table}.${column}`, 'lookup targets disagree across logical and Web API aliases');
  let logical = declaredTargets[0];
  if (
    logical !== undefined &&
    (typeof logical !== 'string' ||
      !validName(logical) ||
      (allowed?.size ? !allowed.has(logical) : !own(state.schema.tables, logical)))
  )
    invalid(`${table}.${column}`, 'lookup target does not match selected metadata');
  if (logical === undefined && allowed?.size === 1) logical = [...allowed][0];
  if (logical === undefined) {
    state.work(allowed?.size ?? 0);
    if ([...(allowed ?? [])].some((candidate) => state.plans.get(candidate)?.has(sourceId)))
      invalid(`${table}.${column}`, 'polymorphic lookup remapping requires an explicit logical target');
  }
  return logical;
}

/* NOSONAR */ function rewriteLookupValue(state, table, row, original, column, value, { attributes, targetsByField }) {
  if (value == null) return;
  const logicalColumn = /^_(.+)_value$/.exec(column)?.[1] ?? column;
  const allowed = targetsByField.get(logicalColumn);
  if (!allowed && !lookupTypes.has(own(attributes, logicalColumn)?.type)) return;
  const raw = object(value) ? value.id : value,
    sourceId = guidKey(raw);
  if (!sourceId) invalid(`${table}.${column}`, 'a lookup needs a GUID identity');
  const alternate = column === logicalColumn ? `_${column}_value` : logicalColumn;
  const other = own(original, alternate);
  if (other != null && guidKey(object(other) ? other.id : other) !== sourceId)
    invalid(`${table}.${column}`, 'logical and Web API lookup representations disagree');
  const logical = resolveLookupLogicalTarget(state, table, column, logicalColumn, original, allowed, sourceId);
  if (logical === undefined) {
    state.report.unverifiedLookups++;
    return;
  }
  const nextId = replacementFor(state, logical, sourceId);
  if (nextId !== sourceId) {
    if (!state.destinationRows.get(logical)?.has(nextId))
      invalid(`${table}.${column}`, 'remapped lookup target is absent from fragment and supplied existing rows');
    row[column] = object(value) ? { ...value, id: nextId } : nextId;
    state.report.remappedLookups++;
  } else if (!state.destinationRows.get(logical)?.has(nextId)) state.report.unverifiedLookups++;
}

function rewriteResultTable(state, table, rows) {
  const definition = state.tableOf(table),
    attributes = definition.attributes ?? {},
    targetsByField = state.fields.get(table);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex],
      original = state.fragment.tables[table][rowIndex];
    const source = guidKey(row[definition.primaryIdAttribute]),
      destination = replacementFor(state, table, source);
    if (destination !== source) {
      row[definition.primaryIdAttribute] = destination;
      state.report.remappedRows++;
    }
    for (const [column, value] of state.entries(row, table)) {
      if (column === definition.primaryIdAttribute || value == null) continue;
      rewriteLookupValue(state, table, row, original, column, value, { attributes, targetsByField });
    }
  }
}

/** Remap explicit row IDs and metadata-backed references; return a cloned fragment and a count-only report. */
export function remapDatasetIdentities(fragment, { schema, identities, existing = {} } = {}) {
  if (
    !object(fragment) ||
    !object(fragment.tables) ||
    !object(schema?.tables) ||
    !object(identities) ||
    !object(existing)
  )
    throw new TypeError(
      'Dataset identity remapping needs fragment.tables, schema.tables, identities and existing objects.',
    );
  let remaining = 1_000_000;
  const work = (count = 1) => {
    remaining -= count;
    if (remaining < 0) throw new RangeError('Dataset identity remapping exceeds the 1000000 work-unit budget.');
  };
  const entries = (value, label) => {
    if (!object(value)) invalid(label, 'expected an object');
    const keys = Object.keys(value);
    work(keys.length);
    return keys.map((key) => [key, value[key]]);
  };
  const tableOf = (table) => {
    if (!validName(table) || !object(own(schema.tables, table))) invalid(table, 'unknown metadata table');
    const definition = schema.tables[table];
    if (typeof definition.primaryIdAttribute !== 'string' || !validName(definition.primaryIdAttribute))
      invalid(table, 'exact primary-key metadata is required');
    return definition;
  };
  const state = {
    fragment,
    schema,
    identities,
    existing,
    work,
    entries,
    tableOf,
    plans: new Map(),
    destinationRows: new Map(),
    fields: new Map(),
    resolvedTargets: new Map(),
    used: new Set(),
    report: { remappedRows: 0, remappedLookups: 0, unverifiedLookups: 0, unusedIdentities: 0 },
    rowCount: 0,
    identityCount: 0,
  };
  buildIdentityPlans(state);
  rejectNonRowIdentitySections(state);
  collectExistingRows(state);
  collectFragmentRows(state);
  collectResolvedTargets(state);
  collectRelationshipTargets(state);
  cloneResultRows(state);
  for (const [table, rows] of Object.entries(state.result.tables)) rewriteResultTable(state, table, rows);
  state.report.unusedIdentities = state.identityCount - state.used.size;
  return { fragment: state.result, report: state.report };
}
