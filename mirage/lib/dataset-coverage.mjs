// Aggregate project-owned fixture coverage. Values and record identities never
// enter this report; metadata option codes and column names describe its scope.
import { tableFields } from './solution-schema.mjs';
import { guidKey } from './dataverse-values.mjs';
import { inspectionBudget, chargeSchemaMetadata } from './inspection-budget.mjs';

const own = (value, key) => Object.hasOwn(value, key);
const plain = (value) => value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const choices = new Set(['picklist', 'state', 'status', 'multiselectpicklist']);
const lookupTypes = new Set(['lookup', 'customer', 'owner']);
const empty = (value) => value === '' || (Array.isArray(value) && value.length === 0);
const logicalName = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value) && !['constructor', 'prototype'].includes(value);
const invalid = (message) => {
  throw new Error('Dataset coverage: ' + message);
};

function optionMembers(value, multiple, charge) {
  const pending = [{ value, depth: 0 }],
    values = new Set();
  let valid = true,
    checked = 0;
  while (pending.length) {
    charge();
    const entry = pending.pop();
    if (++checked > 10000 || entry.depth > 32) invalid('choice value exceeds the inspection limit');
    if (Array.isArray(entry.value)) {
      charge(entry.value.length);
      if (!multiple || entry.depth > 0) valid = false;
      for (const child of entry.value) pending.push({ value: child, depth: entry.depth + 1 });
      continue;
    }
    const result = inspectOptionScalar(entry.value, multiple, charge, values);
    if (!result) valid = false;
  }
  return { values, valid };
}

function inspectOptionScalar(value, multiple, charge, values) {
  const scalar = plain(value) ? value.value : value;
  let valid = multiple || typeof scalar === 'number';
  if (typeof scalar !== 'number' && typeof scalar !== 'string') return false;
  if (typeof scalar === 'string') charge(scalar.length);
  const parts = typeof scalar === 'string' ? scalar.split(',') : [scalar];
  for (const part of parts) {
    if ((typeof part === 'string' && !/^-?\d+$/.test(part.trim())) || !Number.isSafeInteger(Number(part)))
      valid = false;
    else values.add(Number(part));
  }
  return valid;
}

/* NOSONAR */ function inspectDatasetIndexes(schema, tables, existing, charge) {
  const indexes = new Map();
  let rowsInspected = 0;
  for (const collection of [tables, existing])
    for (const [name, rows] of Object.entries(collection)) {
      if (!logicalName(name) || !own(schema.tables, name) || !Array.isArray(rows))
        invalid('table must have schema metadata and a row array: ' + name);
      if ((rowsInspected += rows.length) > 100000)
        invalid('at most 100000 selected and existing rows may be inspected');
      const primary = schema.tables[name].primaryIdAttribute ?? name + 'id';
      charge(rows.length);
      const ids = indexes.get(name) ?? new Set();
      indexes.set(name, ids);
      for (const row of rows) {
        if (!plain(row)) invalid('rows must be plain objects');
        const id = own(row, primary) ? guidKey(row[primary]) : null;
        if (id) ids.add(id);
      }
    }
  return indexes;
}

function inspectChoice(value, field, options, choice, charge) {
  const members = optionMembers(value, field.dataverseType === 'multiselectpicklist', charge);
  const malformed = !members.valid || (field.dataverseType !== 'multiselectpicklist' && members.values.size !== 1);
  if (malformed) choice.malformedRows++;
  const unlisted = [...members.values].some((option) => !options.has(option));
  if (unlisted) choice.unlistedRows++;
  if (!malformed && (!unlisted || field.optionSetOpen === true))
    for (const option of members.values) if (options.has(option)) options.set(option, options.get(option) + 1);
}

function inspectLookup(value, targets, indexes, lookup) {
  const reference = plain(value) ? value : { id: value };
  const id = guidKey(reference.id);
  const target = reference.logical_name ?? (targets.size === 1 ? targets.values().next().value : null);
  if (!id || (target != null && !targets.has(target))) lookup.invalid++;
  else if (!target) lookup.ambiguous++;
  else if (indexes.get(target)?.has(id)) lookup.resolved++;
  else lookup.dangling++;
}

function inspectColumnValue(row, column, field, state) {
  if (!own(row, column) || row[column] === undefined) {
    state.count.missing++;
    return;
  }
  const value = row[column];
  if (value === null) {
    state.count.null++;
    return;
  }
  if (empty(value)) {
    state.count.empty++;
    return;
  }
  state.count.populated++;
  if (state.choice) inspectChoice(value, field, state.options, state.choice, state.charge);
  if (state.lookup) inspectLookup(value, state.targets, state.indexes, state.lookup);
}

function summarizeColumn(column, field, rows, indexes, charge) {
  const count = { missing: 0, null: 0, empty: 0, populated: 0 };
  const options = new Map((field.options ?? []).map((option) => [option.value, 0]));
  const choice = choices.has(field.dataverseType) ? { unlistedRows: 0, malformedRows: 0 } : null;
  const lookup = lookupTypes.has(field.dataverseType) ? { resolved: 0, dangling: 0, ambiguous: 0, invalid: 0 } : null;
  const targets = lookup ? new Set(field.targets ?? []) : null;
  const state = { count, choice, options, targets, indexes, lookup, charge };
  for (const row of rows) inspectColumnValue(row, column, field, state);
  return {
    type: field.dataverseType,
    required: Boolean(field.required),
    ...count,
    ...(choice
      ? {
          choice: {
            ...choice,
            open: field.optionSetOpen === true,
            options: [...options].sort(([a], [b]) => a - b).map(([value, rowCount]) => ({ value, rows: rowCount })),
          },
        }
      : {}),
    ...(lookup ? { lookup } : {}),
  };
}

function inspectTableIdentity(row, primary, identity, seen) {
  if (!own(row, primary) || row[primary] == null || row[primary] === '') identity.missing++;
  else {
    const id = guidKey(row[primary]);
    if (!id) identity.invalid++;
    else if (seen.has(id)) identity.duplicates++;
    else seen.add(id);
  }
}

function inspectUnknownColumns(row, fields, unknown, counters, charge) {
  for (const column of Object.keys(row)) {
    charge();
    if (++counters.cells > 2000000) invalid('the column inspection limit is exceeded');
    if (!own(fields, column)) unknown.set(column, (unknown.get(column) ?? 0) + 1);
  }
}

function inspectTableRow(row, primary, fields, state) {
  inspectTableIdentity(row, primary, state.identity, state.seen);
  inspectUnknownColumns(row, fields, state.unknown, state.counters, state.charge);
}

function summarizeTable(name, schema, tables, indexes, charge, counters) {
  const rows = tables[name],
    primary = schema.tables[name].primaryIdAttribute ?? name + 'id';
  if (
    !plain(schema.tables[name].attributes) ||
    Object.values(schema.tables[name].attributes).some((attribute) => !plain(attribute) || !logicalName(attribute.name))
  )
    invalid('columns must have logical names and metadata objects');
  chargeSchemaMetadata(name, schema.tables[name], schema, charge);
  const fields = tableFields({ ...schema, targets: schema.targets ?? {}, optionSets: schema.optionSets ?? {} }, name, {
      provenance: false,
    }),
    columns = {};
  if (
    (counters.inspectedColumns += Object.keys(fields).length) > 10000 ||
    (counters.cells += Object.keys(fields).length * rows.length) > 2000000
  )
    invalid('the column inspection limit is exceeded');
  charge(Object.keys(fields).length * rows.length);
  const identity = { missing: 0, invalid: 0, duplicates: 0 },
    seen = new Set(),
    unknown = new Map();
  const rowState = { identity, seen, unknown, counters, charge };
  for (const row of rows) inspectTableRow(row, primary, fields, rowState);
  for (const column of Object.keys(fields).sort((a, b) => Number(a > b) - Number(a < b)))
    columns[column] = summarizeColumn(column, fields[column], rows, indexes, charge);
  return {
    rows: rows.length,
    identity,
    unknownColumns: Object.fromEntries([...unknown].sort(([a], [b]) => a.localeCompare(b))),
    columns,
  };
}

/** Inspect selected local tables against an imported schema, without changing data or inferring business policies. */
export function summarizeDataset({ schema, tables = {}, existing = {} } = {}) {
  if (!plain(schema?.tables) || !plain(tables) || !plain(existing))
    invalid('schema.tables, tables and existing must be objects');
  const charge = inspectionBudget(2000000, 'Dataset coverage');
  const indexes = inspectDatasetIndexes(schema, tables, existing, charge);
  const reports = {};
  const counters = { cells: 0, inspectedColumns: 0 };
  for (const name of Object.keys(tables).sort((a, b) => Number(a > b) - Number(a < b)))
    reports[name] = summarizeTable(name, schema, tables, indexes, charge, counters);
  return { schemaVersion: 1, tables: reports };
}
