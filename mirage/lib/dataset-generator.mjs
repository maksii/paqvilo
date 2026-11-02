// Pure, project-directed generation. Allocate identities before resolving any
// lookups so a local dataset can contain required cycles without write ordering.
import { assertDatasetAlternateKeys } from './alternate-key-values.mjs';
import { createHash } from 'node:crypto';
import { tableFields } from './solution-schema.mjs';
import { scaffoldId } from './scaffold-data.mjs';
import { guidKey, parseDateValue, isDateOnlyField } from './dataverse-values.mjs';

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const object = (value) => value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const name = (value) => /^[a-z][a-z0-9_]*$/.test(value) && !['constructor', 'prototype'].includes(value);
const numeric = new Set(['int', 'integer', 'bigint', 'decimal', 'money', 'double', 'float']);
const integer = new Set(['int', 'integer', 'bigint']);
const choices = new Set(['picklist', 'state', 'status', 'multiselectpicklist']);
const lookups = new Set(['lookup', 'customer', 'owner']);
const text = new Set(['nvarchar', 'varchar', 'string', 'text', 'memo', 'ntext']);
const fail = (field, reason) => {
  throw new Error(`Dataset ${field}: ${reason}`);
};
const random = (key) => createHash('sha256').update(key).digest().readUInt32BE(0) / 0x100000000;
const lookupKey = (row) => `${row.logical_name}:${guidKey(row.id)}`;

function checkedValue(definition, value, label, candidates) {
  const type = definition.dataverseType;
  if (value == null) {
    if (definition.required) fail(label, 'a required column cannot be null');
    return undefined;
  }
  if (lookups.has(type)) return checkedLookupValue(definition, value, label, candidates);
  if (numeric.has(type)) checkNumericValue(definition, value, label);
  else if (choices.has(type)) {
    value = checkedChoiceValue(definition, value, label);
    if (type === 'multiselectpicklist' && value === undefined) return undefined;
  } else checkSimpleValue(definition, value, label);
  return structuredClone(value);
}

function checkedLookupValue(definition, value, label, candidates) {
  if (!object(value) || !guidKey(value.id) || !(definition.targets ?? []).includes(value.logical_name))
    fail(label, 'lookup needs a GUID and an allowed logical_name');
  const match = candidates.byId.get(lookupKey(value));
  if (!match) fail(label, 'lookup does not resolve in generated or supplied existing rows');
  return { id: match.id, logical_name: match.logical_name };
}

function checkNumericValue(definition, value, label) {
  const type = definition.dataverseType;
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer.has(type) && !Number.isSafeInteger(value)))
    fail(label, 'expected a finite number (a safe integer for integer columns)');
  if (
    (definition.minValue !== undefined && value < definition.minValue) ||
    (definition.maxValue !== undefined && value > definition.maxValue)
  )
    fail(label, 'number is outside metadata bounds');
}

function checkedChoiceValue(definition, value, label) {
  if (definition.dataverseType === 'multiselectpicklist') return checkedMultiChoiceValue(definition, value, label);
  validateChoiceEntries(definition, [value], label);
  return value;
}

function checkedMultiChoiceValue(definition, value, label) {
  let selected;
  if (Array.isArray(value)) selected = value;
  else if (typeof value === 'number') selected = [value];
  else if (typeof value === 'string') {
    const tokens = value.trim() ? value.split(',').map((token) => token.trim()) : [];
    if (tokens.some((token) => !/^[+-]?\d+$/.test(token))) fail(label, 'expected comma-separated integer choices');
    selected = tokens.map(Number);
  } else fail(label, 'expected integer choices');
  if (!selected.length) {
    if (definition.required) fail(label, 'a required column cannot be null');
    return undefined;
  }
  validateChoiceEntries(definition, selected, label);
  return selected.join(',');
}

function validateChoiceEntries(definition, selected, label) {
  if (
    !selected.length ||
    selected.some(
      (entry) => !Number.isSafeInteger(entry) || !(definition.options ?? []).some((option) => option.value === entry),
    )
  )
    fail(label, 'choice value is outside the exported option set');
}

function checkSimpleValue(definition, value, label) {
  const type = definition.dataverseType;
  if (['bit', 'boolean'].includes(type)) checkBooleanValue(value, label);
  else if (type === 'uniqueidentifier') checkGuidValue(value, label);
  else if (type === 'datetime') checkDateTimeValue(definition, value, label);
  else if (text.has(type)) checkTextValue(definition, value, label);
  else fail(label, `unsupported column type ${type}`);
}

function checkBooleanValue(value, label) {
  if (typeof value !== 'boolean') fail(label, 'expected a boolean');
}

function checkGuidValue(value, label) {
  if (!guidKey(value)) fail(label, 'expected a GUID');
}

function checkDateTimeValue(definition, value, label) {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && parseDateValue(value);
  if (!parsed) fail(label, 'expected an ISO date or datetime');
  if (isDateOnlyField(definition) && !/^\d{4}-\d{2}-\d{2}$/.test(value))
    fail(label, 'DateOnly requires yyyy-MM-dd without a timestamp');
  const year = new Date(parsed.ms).getUTCFullYear();
  if (year < 1753 || year > 9999) fail(label, 'date is outside Dataverse years 1753 through 9999');
}

function checkTextValue(definition, value, label) {
  if (typeof value !== 'string' || (definition.maxLength && value.length > definition.maxLength))
    fail(label, 'expected text within the metadata length');
}

function defaultValue(definition, index, seed, label) {
  const type = definition.dataverseType;
  if (definition.defaultValue !== undefined) return definition.defaultValue;
  if (numeric.has(type))
    return Math.max(definition.minValue ?? -Infinity, Math.min(definition.maxValue ?? Infinity, 0));
  if (choices.has(type)) return (definition.options ?? [])[index % (definition.options?.length || 1)]?.value;
  if (['bit', 'boolean'].includes(type)) return index % 2 === 0;
  if (type === 'uniqueidentifier') return scaffoldId(seed, `${label}:${index + 1}`);
  if (type === 'datetime') {
    const value = new Date(Date.UTC(2026, 0, 1) + index * 86400000).toISOString();
    return definition.dateTimeBehavior?.toLowerCase() === 'dateonly' || definition.format?.toLowerCase() === 'dateonly'
      ? value.slice(0, 10)
      : value;
  }
  if (text.has(type)) {
    let value = `${label} ${index + 1}`;
    if (definition.format === 'email') value = `row${index + 1}@example.invalid`;
    else if (definition.format === 'url') value = `https://example.invalid/${index + 1}`;
    return value.slice(0, definition.maxLength ?? value.length);
  }
  return undefined;
}

function ruleValue(rule, definition, index, key, candidates, label) {
  if (!object(rule)) fail(label, 'rule must be an object');
  switch (rule.kind) {
    case 'constant':
      return constantRuleValue(rule, label);
    case 'null':
      return undefined;
    case 'one-of':
      return oneOfRuleValue(rule, definition, index, key, candidates, label);
    case 'sequence':
      return sequenceRuleValue(rule, definition, index, label);
    case 'pattern':
      return patternRuleValue(rule, definition, index, label);
    case 'range':
      return rangeRuleValue(rule, definition, key, candidates, label);
    case 'lookup':
      return lookupRuleValue(rule, definition, index, key, candidates, label);
    default:
      fail(label, `unknown rule kind ${rule.kind}`);
  }
}

function constantRuleValue(rule, label) {
  if (!Object.hasOwn(rule, 'value')) fail(label, 'constant needs a value');
  return rule.value;
}

function oneOfRuleValue(rule, definition, index, key, candidates, label) {
  if (!Array.isArray(rule.values) || !rule.values.length) fail(label, 'one-of needs a nonempty values array');
  if (rule.mode !== undefined && !['cycle', 'random'].includes(rule.mode)) fail(label, 'mode must be cycle or random');
  // Validate every configured candidate, including values not sampled by a small run.
  if (index === 0) for (const value of rule.values) checkedValue(definition, value, label, candidates);
  return rule.values[
    rule.mode === 'random' ? Math.floor(random(key) * rule.values.length) : index % rule.values.length
  ];
}

function sequenceRuleValue(rule, definition, index, label) {
  if (!numeric.has(definition.dataverseType)) fail(label, 'sequence requires a numeric column');
  const start = rule.start ?? 1,
    step = rule.step ?? 1;
  if (![start, step].every((value) => typeof value === 'number' && Number.isFinite(value)))
    fail(label, 'sequence start and step must be finite numbers');
  return start + index * step;
}

function patternRuleValue(rule, definition, index, label) {
  if (!text.has(definition.dataverseType)) fail(label, 'pattern requires a text column');
  if (typeof rule.template !== 'string' || rule.template.length > 65536)
    fail(label, 'pattern needs a template of at most 65536 characters');
  const start = rule.start ?? 1,
    step = rule.step ?? 1,
    sequence = start + index * step;
  if (![start, step, sequence].every(Number.isSafeInteger))
    fail(label, 'pattern sequence must stay within safe integers');
  const token = /\{seq(?::([1-9]\d?))?\}/g;
  if (/[{}]/.test(rule.template.replace(token, ''))) fail(label, 'pattern supports only {seq} and {seq:width} tokens');
  return rule.template.replace(token, (_match, width) => {
    if (Number(width ?? 1) > 32) fail(label, 'pattern padding cannot exceed 32 digits');
    return (sequence < 0 ? '-' : '') + String(Math.abs(sequence)).padStart(Number(width ?? 1), '0');
  });
}

function rangeRuleValue(rule, definition, key, candidates, label) {
  if (!numeric.has(definition.dataverseType)) fail(label, 'range requires a numeric column');
  const { min, max } = rule;
  if (![min, max].every((value) => typeof value === 'number' && Number.isFinite(value)) || min > max)
    fail(label, 'range needs finite min <= max');
  checkedValue(definition, min, label, candidates);
  checkedValue(definition, max, label, candidates);
  if (integer.has(definition.dataverseType)) return min + Math.floor(random(key) * (max - min + 1));
  const precision = Math.min(definition.precision ?? 2, 10);
  return Math.max(min, Math.min(max, Number((min + random(key) * (max - min)).toFixed(precision))));
}

function lookupRuleValue(rule, definition, index, key, candidates, label) {
  if (!lookups.has(definition.dataverseType)) fail(label, 'lookup rule requires a lookup column');
  if (rule.mode !== undefined && !['cycle', 'random'].includes(rule.mode)) fail(label, 'mode must be cycle or random');
  if (rule.source !== undefined && !['existing', 'generated', 'any'].includes(rule.source))
    fail(label, 'source must be existing, generated or any');
  if (rule.target !== undefined && !(definition.targets ?? []).includes(rule.target))
    fail(label, 'lookup target is not allowed by metadata');
  const pool = candidates.selected;
  if (!pool.length) fail(label, 'lookup has no candidate rows');
  return pool[rule.mode === 'random' ? Math.floor(random(key) * pool.length) : index % pool.length];
}

/**
 * Generate a mergeDataset-compatible fragment from imported Solution schema.
 * counts selects tables explicitly; rules is { table: { column: { kind, ... } } }.
 * existing supplies lookup candidates and alternate-key collision checks. No inputs mutate.
 */
export function generateDataset({
  schema,
  counts = {},
  rules = {},
  seed = 'dataset-v1',
  existing = {},
  collation = 'CI_AI',
} = {}) {
  const selected = validateDatasetRequest(schema, counts, rules, existing, seed);
  const { fields, tables } = createDatasetTables(schema, selected, counts, seed);
  const pool = collectDatasetCandidates(schema, tables, existing);
  populateDatasetTables({ selected, fields, tables, counts, rules, schema, pool, seed });
  const mappings = createDatasetMappings(schema, selected, fields);
  const merged = mergeDatasetRows(schema, selected, tables, existing);
  assertDatasetAlternateKeys(mappings, merged, selected, collation);
  return { tables, provenance: { generator: 'schema-dataset-v1', seed, counts: structuredClone(counts) } };
}

function validateDatasetRequest(schema, counts, rules, existing, seed) {
  if (!object(schema?.tables) || !object(counts) || !object(rules) || !object(existing))
    throw new Error('Dataset schema.tables, counts, rules and existing must be objects');
  if (typeof seed !== 'string' || !/^[\w.-]{1,64}$/.test(seed))
    throw new Error('Dataset seed must be 1-64 letters, digits, dots, underscores or hyphens');
  const selected = Object.keys(counts).sort((a, b) => Number(a > b) - Number(a < b));
  let total = 0;
  for (const table of selected) {
    if (!name(table) || !own(schema.tables, table)) fail(table, 'unknown table in counts');
    if (!Number.isSafeInteger(counts[table]) || counts[table] < 0 || counts[table] > 100000)
      fail(table, 'count must be an integer from 0 to 100000');
    total += counts[table];
  }
  if (total > 100000) throw new Error('Dataset total count cannot exceed 100000');
  for (const table of Object.keys(rules))
    if (!Object.hasOwn(counts, table) || !object(rules[table]))
      fail(table, 'rules require a selected table and column-rule object');
  return selected;
}

function datasetIdColumn(schema, table) {
  return schema.tables[table].primaryIdAttribute ?? `${table}id`;
}

function createDatasetTables(schema, selected, counts, seed) {
  const fields = Object.fromEntries(
    selected.map((table) => [table, tableFields(schema, table, { provenance: false })]),
  );
  const tables = Object.fromEntries(
    selected.map((table) => [
      table,
      Array.from({ length: counts[table] }, (_, index) => ({
        [datasetIdColumn(schema, table)]: scaffoldId(seed, `dataset:${table}:${index + 1}`),
      })),
    ]),
  );
  return { fields, tables };
}

/* NOSONAR */ function collectDatasetCandidates(schema, tables, existing) {
  const pool = [];
  for (const [source, collection] of [
    ['generated', tables],
    ['existing', existing],
  ])
    for (const [table, rows] of Object.entries(collection)) {
      if (!name(table) || !own(schema.tables, table) || !Array.isArray(rows))
        fail(table, 'candidate rows require a known table and row array');
      for (const row of rows) {
        const id = object(row) ? own(row, datasetIdColumn(schema, table)) : undefined;
        if (!guidKey(id)) fail(table, 'candidate row is missing a GUID primary key');
        pool.push({ id, logical_name: table, source });
      }
    }
  pool.sort((a, b) => `${a.logical_name}:${a.id}`.localeCompare(`${b.logical_name}:${b.id}`, 'en'));
  return pool;
}

function validateTableRules(table, fields, rules, schema) {
  for (const column of Object.keys(own(rules, table) ?? {})) {
    const definition = own(fields[table], column);
    if (
      !definition ||
      definition.isPrimaryId ||
      column === datasetIdColumn(schema, table) ||
      definition.validForCreate === false ||
      definition.attributeOf
    )
      fail(`${table}.${column}`, 'rule targets an unknown, primary, derived or non-creatable column');
    if (!object(rules[table][column])) fail(`${table}.${column}`, 'rule must be an object');
  }
}

function populateTableColumn({ table, column, definition, counts, rules, tables, schema, pool, seed }) {
  const idColumn = datasetIdColumn(schema, table);
  if (column === idColumn || definition.isPrimaryId || definition.validForCreate === false || definition.attributeOf)
    return;
  const rule = own(own(rules, table) ?? {}, column);
  if (!rule && !definition.required) return;
  const label = `${table}.${column}`;
  const candidateRows = lookups.has(definition.dataverseType)
    ? pool.filter((row) => (definition.targets ?? []).includes(row.logical_name))
    : [];
  const candidates = {
    rows: candidateRows,
    byId: new Map(candidateRows.map((row) => [lookupKey(row), row])),
    selected: candidateRows.filter(
      (row) =>
        (!rule?.target || row.logical_name === rule.target) &&
        (!rule?.source || rule.source === 'any' || row.source === rule.source),
    ),
  };
  // Dataverse assigns an unset owner to the calling user, so a required owner needs no exported user/team.
  if (!rule && definition.dataverseType === 'owner' && !candidates.rows.length) return;
  assignColumnValues({ table, column, definition, counts, rule, tables, seed, label, candidates });
}

function assignColumnValues({ table, column, definition, counts, rule, tables, seed, label, candidates }) {
  // Even a zero-row table must not accept malformed configured rules.
  for (let index = 0; index < Math.max(counts[table], rule ? 1 : 0); index++) {
    let value;
    if (rule) value = ruleValue(rule, definition, index, `${seed}:${label}:${index}`, candidates, label);
    else if (lookups.has(definition.dataverseType)) value = candidates.rows[index % candidates.rows.length];
    else value = defaultValue(definition, index, seed, label);
    const checked = checkedValue(definition, value, label, candidates);
    if (checked !== undefined && tables[table][index]) tables[table][index][column] = checked;
  }
}

function populateDatasetTables({ selected, fields, tables, counts, rules, schema, pool, seed }) {
  for (const table of selected) {
    validateTableRules(table, fields, rules, schema);
    for (const [column, definition] of Object.entries(fields[table]))
      populateTableColumn({ table, column, definition, counts, rules, tables, schema, pool, seed });
  }
}

function createDatasetMappings(schema, selected, fields) {
  const mappings = Object.fromEntries(
    selected.map((table) => [
      table,
      {
        idColumn: datasetIdColumn(schema, table),
        fields: fields[table],
        alternateKeys: Object.values(schema.tables[table].keys ?? {}),
      },
    ]),
  );
  return mappings;
}

function mergeDatasetRows(schema, selected, tables, existing) {
  const merged = Object.fromEntries(
    selected.map((table) => {
      const rows = [...(existing[table] ?? [])];
      const seen = new Set(rows.map((row) => guidKey(row[datasetIdColumn(schema, table)])));
      for (const row of tables[table]) if (!seen.has(guidKey(row[datasetIdColumn(schema, table)]))) rows.push(row);
      return [table, rows];
    }),
  );
  return merged;
}
