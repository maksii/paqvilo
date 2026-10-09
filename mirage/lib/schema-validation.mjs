// Schema validation of preset and generated rows: every row written into a
// schema-complete table must use columns of the solution's field list and
// option values (and labels) of the column's option set. Data packs check
// their presets against a field index derived from solution XML
// (schemaFieldIndex); `data generate` checks generated rows against the
// bootstrapped state's mapping metadata (fieldIndexFromMappings).
import { tableFields } from "./solution-schema.mjs";

const OPTION_TYPES = new Set(["picklist", "multiselectpicklist", "state", "status"]);

/** Compact index entry for one field: null, or [[value, label], ...] for option columns. */
function fieldEntry(definition) {
  if (!OPTION_TYPES.has(definition.dataverseType)) return null;
  return (definition.options ?? []).map((option) => [option.value, option.label]);
}

/** Index of schema-complete tables from a raw solution schema (importSolutionData().schema). */
export function schemaFieldIndex(schema, tableNames) {
  const tables = {};
  for (const name of [...new Set(tableNames)].sort()) {
    const table = schema.tables[name];
    if (!table?.schemaComplete) continue;
    const fields = {};
    for (const [field, definition] of Object.entries(tableFields(schema, name, { provenance: false }))) fields[field] = fieldEntry(definition);
    tables[name] = { schemaComplete: true, fields: Object.fromEntries(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
  }
  return { tables };
}

/** Index from a bootstrapped state's mappings (Web API tables carry fieldMetadata). */
export function fieldIndexFromMappings(mappings = {}) {
  const tables = {};
  for (const [name, mapping] of Object.entries(mappings)) {
    if (mapping?.schemaComplete !== true || !mapping.fieldMetadata) continue;
    const fields = {};
    for (const [field, definition] of Object.entries(mapping.fieldMetadata)) fields[field] = fieldEntry({ dataverseType: definition.dataverseType, options: definition.options });
    tables[name] = { schemaComplete: true, fields };
  }
  return { tables };
}

const optionValues = (value) => {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(optionValues);
  if (typeof value === "object") return value.value == null ? [] : [{ value: Number(value.value), label: value.label }];
  if (typeof value === "string") return value.split(",").filter(Boolean).map((part) => ({ value: Number(part) }));
  return [{ value: Number(value) }];
};

/**
 * Violations of `tables` ({ table: rows[] }) against `index`. Internal
 * simulator keys (`__sim…`, `@odata…`) are ignored. Each violation:
 * { table, column, kind: "unknown-column" | "option-value" | "option-label",
 *   value?, label?, expected?, rows, sample }.
 */
export function schemaViolations(tables, index, { idColumn = (table) => `${table}id` } = {}) {
  const found = new Map();
  const add = (table, column, kind, row, extra = {}) => {
    const key = [table, column, kind, extra.value ?? "", extra.label ?? ""].join("\u0000");
    const entry = found.get(key) ?? { table, column, kind, ...extra, rows: 0, sample: row[idColumn(table)] ?? null };
    entry.rows++;
    found.set(key, entry);
  };
  for (const [table, rows] of Object.entries(tables)) {
    const definition = index.tables[table];
    if (!definition?.schemaComplete || !Array.isArray(rows)) continue;
    for (const row of rows)
      for (const [column, value] of Object.entries(row)) {
        if (column.startsWith("__") || column.startsWith("@")) continue;
        if (!(column in definition.fields)) {
          add(table, column, "unknown-column", row);
          continue;
        }
        const options = definition.fields[column];
        if (!options) continue;
        for (const option of optionValues(value)) {
          const match = options.find(([candidate]) => candidate === option.value);
          if (!match) add(table, column, "option-value", row, { value: option.value, expected: options.map(([v]) => v) });
          else if (option.label !== undefined && option.label !== match[1]) add(table, column, "option-label", row, { value: option.value, label: option.label, expected: match[1] });
        }
      }
  }
  return [...found.values()].sort((a, b) => (a.table + a.column + a.kind < b.table + b.column + b.kind ? -1 : 1));
}

/** One line per violation, grouped by table/column. */
export function formatViolations(violations) {
  return violations.map((v) =>
    v.kind === "unknown-column"
      ? `${v.table}.${v.column}: unknown column (${v.rows} rows, e.g. ${v.sample})`
      : v.kind === "option-value"
        ? `${v.table}.${v.column}: value ${v.value} outside option set [${v.expected.join(", ")}] (${v.rows} rows)`
        : `${v.table}.${v.column}: label "${v.label}" for ${v.value}, metadata "${v.expected}" (${v.rows} rows)`,
  );
}
