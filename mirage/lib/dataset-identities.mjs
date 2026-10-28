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
  const plans = new Map(),
    destinationRows = new Map(),
    fields = new Map(),
    used = new Set();
  const report = { remappedRows: 0, remappedLookups: 0, unverifiedLookups: 0, unusedIdentities: 0 };
  let rowCount = 0,
    identityCount = 0;
  for (const [table, values] of entries(identities, 'identities')) {
    tableOf(table);
    const plan = new Map(),
      targets = new Set();
    for (const [from, to] of entries(values, table)) {
      if (++identityCount > 100_000) invalid('identities', 'at most 100000 substitutions are supported');
      const source = guidKey(from),
        destination = guidKey(to);
      if (!source || !destination) invalid(table, 'substitutions require GUID source and destination identities');
      if (plan.has(source)) invalid(table, 'source identities must be unambiguous after GUID normalization');
      if (targets.has(destination)) invalid(table, 'different sources cannot share a destination identity');
      plan.set(source, destination);
      targets.add(destination);
    }
    plans.set(table, plan);
  }
  for (const section of ['permissions', 'personaRoles', 'personaCatalog', 'simulator', 'plugins'])
    if (identityCount && fragment[section] && Object.keys(fragment[section]).length)
      invalid(section, 'non-row identity sections require their own explicit remapping; supply a row-only fragment');
  for (const [table, rows] of entries(existing, 'existing')) {
    const definition = tableOf(table);
    if (!Array.isArray(rows)) invalid(table, 'existing rows must be an array');
    rowCount += rows.length;
    work(rows.length);
    if (rowCount > 100_000) invalid(table, 'at most 100000 fragment and existing rows are supported');
    const ids = new Set();
    for (const row of rows) {
      const key = object(row) ? guidKey(own(row, definition.primaryIdAttribute)) : null;
      if (!key || ids.has(key)) invalid(table, 'existing rows need distinct GUID primary keys');
      ids.add(key);
    }
    destinationRows.set(table, ids);
  }
  for (const [table, rows] of entries(fragment.tables, 'tables')) {
    const definition = tableOf(table);
    if (!Array.isArray(rows)) invalid(table, 'fragment rows must be an array');
    rowCount += rows.length;
    work(rows.length);
    if (rowCount > 100_000) invalid(table, 'at most 100000 fragment and existing rows are supported');
    const destinations = destinationRows.get(table) ?? new Set(),
      sources = new Set();
    for (const row of rows) {
      const source = object(row) ? guidKey(own(row, definition.primaryIdAttribute)) : null;
      if (!source || sources.has(source)) invalid(table, 'fragment rows need distinct GUID primary keys');
      const destination = plans.get(table)?.get(source) ?? source;
      if (destinations.has(destination)) invalid(table, 'remapped rows collide with another fragment or existing row');
      sources.add(source);
      destinations.add(destination);
    }
    destinationRows.set(table, destinations);
    fields.set(table, new Map());
  }
  const resolvedTargets = new Map();
  const metadata = { ...schema, targets: schema.targets ?? {}, optionSets: schema.optionSets ?? {} };
  for (const table of fields.keys())
    for (const [column, attribute] of entries(tableOf(table).attributes ?? {}, `${table}.attributes`)) {
      if (!object(attribute) || !lookupTypes.has(attribute.type)) continue;
      const sourceTargets = own(metadata.targets, `${table}/${column}`);
      if (Array.isArray(sourceTargets)) work(sourceTargets.length);
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
        work(definition.targets.length);
        resolvedTargets.set(`${table}/${column}`, definition.targets);
      }
    }
  const target = (table, column, logical) => {
    if (!fields.has(table)) return;
    const targets = resolvedTargets.get(`${table}/${column}`) ?? [logical];
    work(targets.length);
    if (!validName(column) || targets.some((candidate) => !validName(candidate)))
      invalid(table, 'relationship metadata must identify exact source columns and target tables');
    const map = fields.get(table);
    if (!map.has(column)) map.set(column, new Set());
    for (const candidate of targets) map.get(column).add(candidate);
  };
  for (const [key, targets] of resolvedTargets) {
    const [table, column] = key.split('/');
    target(table, column, targets[0]);
  }
  for (const [key, targets] of entries(schema.targets ?? {}, 'schema.targets')) {
    const [table, column, extra] = key.split('/');
    if (!fields.has(table)) continue;
    if (extra || !Array.isArray(targets)) invalid(table, 'lookup targets need table/column and a target array');
    work(targets.length);
    for (const logical of targets) target(table, column, logical);
  }
  for (const [, relationship] of entries(schema.relationships ?? {}, 'schema.relationships')) {
    if (!object(relationship)) invalid('relationships', 'expected relationship metadata');
    if (relationship.type === 'one-to-many')
      target(relationship.referencingEntity, relationship.referencingAttribute, relationship.referencedEntity);
    else if (relationship.type === 'many-to-many') {
      target(relationship.intersectEntity, relationship.attribute1, relationship.entity1);
      target(relationship.intersectEntity, relationship.attribute2, relationship.entity2);
    }
  }
  const result = structuredClone(fragment);
  const replacement = (table, source) => {
    const destination = plans.get(table)?.get(source);
    if (destination !== undefined) used.add(JSON.stringify([table, source]));
    return destination ?? source;
  };
  for (const [table, rows] of Object.entries(result.tables)) {
    const definition = tableOf(table),
      attributes = definition.attributes ?? {},
      targetsByField = fields.get(table);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex],
        original = fragment.tables[table][rowIndex];
      const source = guidKey(row[definition.primaryIdAttribute]),
        destination = replacement(table, source);
      if (destination !== source) {
        row[definition.primaryIdAttribute] = destination;
        report.remappedRows++;
      }
      for (const [column, value] of entries(row, table)) {
        if (column === definition.primaryIdAttribute || value == null) continue;
        const logicalColumn = /^_(.+)_value$/.exec(column)?.[1] ?? column;
        const allowed = targetsByField.get(logicalColumn);
        if (!allowed && !lookupTypes.has(own(attributes, logicalColumn)?.type)) continue;
        const raw = object(value) ? value.id : value,
          sourceId = guidKey(raw);
        if (!sourceId) invalid(`${table}.${column}`, 'a lookup needs a GUID identity');
        const alternate = column === logicalColumn ? `_${column}_value` : logicalColumn;
        const other = own(original, alternate);
        if (other != null && guidKey(object(other) ? other.id : other) !== sourceId)
          invalid(`${table}.${column}`, 'logical and Web API lookup representations disagree');
        const logicalValue = own(original, logicalColumn),
          wireValue = own(original, `_${logicalColumn}_value`),
          declaredTargets = [
            object(logicalValue) ? logicalValue.logical_name : undefined,
            object(wireValue) ? wireValue.logical_name : undefined,
            original[`${logicalColumn}@Microsoft.Dynamics.CRM.lookuplogicalname`],
            original[`_${logicalColumn}_value@Microsoft.Dynamics.CRM.lookuplogicalname`],
          ].filter((value) => value !== undefined);
        if (new Set(declaredTargets).size > 1)
          invalid(`${table}.${column}`, 'lookup targets disagree across logical and Web API aliases');
        let logical = declaredTargets[0];
        if (
          logical !== undefined &&
          (typeof logical !== 'string' ||
            !validName(logical) ||
            (allowed?.size ? !allowed.has(logical) : !own(schema.tables, logical)))
        )
          invalid(`${table}.${column}`, 'lookup target does not match selected metadata');
        if (logical === undefined && allowed?.size === 1) logical = [...allowed][0];
        if (logical === undefined) {
          work(allowed?.size ?? 0);
          if ([...(allowed ?? [])].some((candidate) => plans.get(candidate)?.has(sourceId)))
            invalid(`${table}.${column}`, 'polymorphic lookup remapping requires an explicit logical target');
          report.unverifiedLookups++;
          continue;
        }
        const nextId = replacement(logical, sourceId);
        if (nextId !== sourceId) {
          if (!destinationRows.get(logical)?.has(nextId))
            invalid(`${table}.${column}`, 'remapped lookup target is absent from fragment and supplied existing rows');
          row[column] = object(value) ? { ...value, id: nextId } : nextId;
          report.remappedLookups++;
        } else if (!destinationRows.get(logical)?.has(nextId)) report.unverifiedLookups++;
      }
    }
  }
  report.unusedIdentities = identityCount - used.size;
  return { fragment: result, report };
}
