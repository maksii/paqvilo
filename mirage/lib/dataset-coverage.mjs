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
    const scalar = plain(entry.value) ? entry.value.value : entry.value;
    if (!multiple && typeof scalar !== 'number') valid = false;
    if (typeof scalar !== 'number' && typeof scalar !== 'string') {
      valid = false;
      continue;
    }
    if (typeof scalar === 'string') charge(scalar.length);
    const parts = typeof scalar === 'string' ? scalar.split(',') : [scalar];
    for (const part of parts) {
      if ((typeof part === 'string' && !/^-?\d+$/.test(part.trim())) || !Number.isSafeInteger(Number(part)))
        valid = false;
      else values.add(Number(part));
    }
  }
  return { values, valid };
}

/** Inspect selected local tables against an imported schema, without changing data or inferring business policies. */
export function summarizeDataset({ schema, tables = {}, existing = {} } = {}) {
  if (!plain(schema?.tables) || !plain(tables) || !plain(existing))
    invalid('schema.tables, tables and existing must be objects');
  const indexes = new Map();
  const charge = inspectionBudget(2000000, 'Dataset coverage');
  let rowsInspected = 0,
    cells = 0,
    inspectedColumns = 0;
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
  const reports = {};
  for (const name of Object.keys(tables).sort()) {
    const rows = tables[name],
      primary = schema.tables[name].primaryIdAttribute ?? name + 'id';
    if (
      !plain(schema.tables[name].attributes) ||
      Object.values(schema.tables[name].attributes).some(
        (attribute) => !plain(attribute) || !logicalName(attribute.name),
      )
    )
      invalid('columns must have logical names and metadata objects');
    chargeSchemaMetadata(name, schema.tables[name], schema, charge);
    const fields = tableFields(
        { ...schema, targets: schema.targets ?? {}, optionSets: schema.optionSets ?? {} },
        name,
        { provenance: false },
      ),
      columns = {};
    if (
      (inspectedColumns += Object.keys(fields).length) > 10000 ||
      (cells += Object.keys(fields).length * rows.length) > 2000000
    )
      invalid('the column inspection limit is exceeded');
    charge(Object.keys(fields).length * rows.length);
    const identity = { missing: 0, invalid: 0, duplicates: 0 },
      seen = new Set(),
      unknown = new Map();
    for (const row of rows) {
      if (!own(row, primary) || row[primary] == null || row[primary] === '') identity.missing++;
      else {
        const id = guidKey(row[primary]);
        if (!id) identity.invalid++;
        else if (seen.has(id)) identity.duplicates++;
        else seen.add(id);
      }
      for (const column of Object.keys(row)) {
        charge();
        if (++cells > 2000000) invalid('the column inspection limit is exceeded');
        if (!own(fields, column)) unknown.set(column, (unknown.get(column) ?? 0) + 1);
      }
    }
    for (const column of Object.keys(fields).sort()) {
      const field = fields[column],
        count = { missing: 0, null: 0, empty: 0, populated: 0 };
      const options = new Map((field.options ?? []).map((option) => [option.value, 0]));
      const choice = choices.has(field.dataverseType) ? { unlistedRows: 0, malformedRows: 0 } : null;
      const lookup = lookupTypes.has(field.dataverseType)
        ? { resolved: 0, dangling: 0, ambiguous: 0, invalid: 0 }
        : null;
      const targets = lookup ? new Set(field.targets ?? []) : null;
      for (const row of rows) {
        if (!own(row, column) || row[column] === undefined) {
          count.missing++;
          continue;
        }
        const value = row[column];
        if (value === null) {
          count.null++;
          continue;
        }
        if (empty(value)) {
          count.empty++;
          continue;
        }
        count.populated++;
        if (choice) {
          const members = optionMembers(value, field.dataverseType === 'multiselectpicklist', charge);
          const malformed =
            !members.valid || (field.dataverseType !== 'multiselectpicklist' && members.values.size !== 1);
          if (malformed) choice.malformedRows++;
          const unlisted = [...members.values].some((option) => !options.has(option));
          if (unlisted) choice.unlistedRows++;
          if (!malformed && (!unlisted || field.optionSetOpen === true))
            for (const option of members.values) if (options.has(option)) options.set(option, options.get(option) + 1);
        }
        if (lookup) {
          const reference = plain(value) ? value : { id: value };
          const id = guidKey(reference.id);
          const target = reference.logical_name ?? (targets.size === 1 ? targets.values().next().value : null);
          if (!id || (target != null && !targets.has(target))) lookup.invalid++;
          else if (!target) lookup.ambiguous++;
          else if (indexes.get(target)?.has(id)) lookup.resolved++;
          else lookup.dangling++;
        }
      }
      columns[column] = {
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
    reports[name] = {
      rows: rows.length,
      identity,
      unknownColumns: Object.fromEntries([...unknown].sort(([a], [b]) => a.localeCompare(b))),
      columns,
    };
  }
  return { schemaVersion: 1, tables: reports };
}
