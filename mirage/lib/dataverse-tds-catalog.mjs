// Dataverse TDS (SQL) catalog: the columns the read-only SQL endpoint exposes for each store table,
// and how a Web API formatted row projects onto those SQL column names.
// Docs: "Use SQL to query data" and "How Dataverse SQL differs from Transact-SQL" (tds-spike.md section 4).
import { FORMATTED, LOOKUP_LOGICAL } from "./webapi-format.mjs";
import { DataError } from "./data-error.mjs";
import { relationshipsOf } from "./dataverse-standard.mjs";

// ponytail: fixed lengths for the synthesized name columns; the endpoint's real lengths are not documented.
const TEXT_LENGTH = 100;
const LOOKUP_NAME_LENGTH = 160;
const TYPE_LENGTH = 64;
const CHOICE_NAME_LENGTH = 100;
const MAX = -1; // nvarchar(max): multi-line text.
const TEXT_TYPES = new Set(["nvarchar", "string", "text", "textarea", "email", "entityname"]);
const MEMO_TYPES = new Set(["memo", "ntext"]);
const CHOICE_TYPES = new Set(["picklist", "state", "status"]);
// customer and owner are polymorphic: the `<x>type` column is unverified in the docs (tds-spike.md), emitted anyway.
const POLYMORPHIC = new Set(["customer", "owner"]);
const LOOKUP_TYPES = new Set(["lookup", ...POLYMORPHIC]);
// [sqlType, precision, scale]. Money is decimal(19,4); datetime is UTC.
const SCALAR = {
  int: ["int"], integer: ["int"], bigint: ["bigint"], bit: ["bit"], boolean: ["bit"],
  datetime: ["datetime"], float: ["float", 53], double: ["float", 53], money: ["money", 19, 4],
  uniqueidentifier: ["uniqueidentifier"], primarykey: ["uniqueidentifier"],
};

const column = (name, sqlType, source, { length = null, precision = null, scale = null, nullable = true } = {}) =>
  ({ name, sqlType, length, precision, scale, nullable, source });

// SQL columns for one Dataverse column; [] when the endpoint does not expose it (file, image, multi-select, partylist, virtual, ...).
function columnsOf(name, def) {
  const raw = String(def?.dataverseType ?? def?.type ?? "nvarchar").toLowerCase();
  const plain = { kind: "attribute", attribute: name };
  if (LOOKUP_TYPES.has(raw)) {
    const attribute = `_${name}_value`;
    const columns = [
      column(name, "uniqueidentifier", { kind: "attribute", attribute }),
      column(`${name}name`, "nvarchar", { kind: "lookupName", attribute }, { length: LOOKUP_NAME_LENGTH }),
    ];
    if (POLYMORPHIC.has(raw)) columns.push(column(`${name}type`, "nvarchar", { kind: "lookupType", attribute }, { length: TYPE_LENGTH }));
    return columns;
  }
  const choice = CHOICE_TYPES.has(raw) || (Array.isArray(def?.options) && (raw === "int" || raw === "integer"));
  if (choice) {
    return [
      column(name, "int", plain),
      column(`${name}name`, "nvarchar", { kind: "choiceName", attribute: name }, { length: CHOICE_NAME_LENGTH }),
    ];
  }
  if (TEXT_TYPES.has(raw)) return [column(name, "nvarchar", plain, { length: def?.maxLength ?? TEXT_LENGTH })];
  if (MEMO_TYPES.has(raw)) return [column(name, "nvarchar", plain, { length: MAX })];
  if (raw === "decimal" || raw === "numeric") return [column(name, "decimal", plain, { precision: 38, scale: def?.precision ?? 2 })];
  const scalar = SCALAR[raw];
  if (!scalar) return [];
  const [sqlType, precision = null, scale = null] = scalar;
  return [column(name, sqlType, plain, { precision, scale })];
}

/**
 * Catalog of the store's tables the SQL endpoint exposes. Tables are keyed by lowercase logical name.
 * Virtual tables (isVirtual or dataSourceId) are outside the endpoint and skipped.
 * metadataFields(logical) and metadata(logical) are optional field-definition sources, merged over the mapping's fields.
 */
export function buildCatalog({ store, metadataFields, metadata }) {
  const tables = new Map();
  for (const [logical, mapping] of Object.entries(store.state.mappings ?? {})) {
    if (mapping.isVirtual || mapping.dataSourceId) continue;
    const fields = { ...store.fieldDefinitions(logical, metadataFields), ...(metadata?.(logical) ?? {}) };
    const idColumn = mapping.idColumn;
    const columns = [column(idColumn, "uniqueidentifier", { kind: "attribute", attribute: idColumn }, { nullable: false })];
    for (const [name, def] of Object.entries(fields)) {
      if (name === idColumn || name.includes("@")) continue;
      columns.push(...columnsOf(name.toLowerCase(), def));
    }
    // Lookups the relationships name but the field definitions don't (a standard table's lookup) get their columns too.
    const named = new Set(columns.map((c) => c.name));
    for (const rel of Object.values(relationshipsOf(store, logical, mapping.relationships))) {
      const name = String(rel?.from ?? "").toLowerCase();
      if (rel?.many !== false || !name || named.has(name) || name.includes("@")) continue;
      named.add(name);
      columns.push(...columnsOf(name, { dataverseType: "lookup" }));
    }
    const key = logical.toLowerCase();
    tables.set(key, { logicalName: key, entitySet: mapping.entitySet, idColumn, columns });
  }
  return { tables };
}

/**
 * One store row as SQL columns, from its Web API formatted row. Lookup and choice names come from the
 * FormattedValue annotations; a polymorphic type from the lookuplogicalname annotation. A plain column the
 * formatted row omits falls back to the store row.
 */
export function projectRow(table, storeRow, formatted) {
  const row = {};
  for (const { name, source } of table.columns) {
    const { kind, attribute } = source;
    if (kind === "lookupName" || kind === "choiceName") row[name] = formatted[`${attribute}${FORMATTED}`] ?? null;
    else if (kind === "lookupType") row[name] = formatted[`${attribute}${LOOKUP_LOGICAL}`] ?? null;
    else if (Object.hasOwn(formatted, attribute)) row[name] = formatted[attribute] ?? null;
    else row[name] = storeRow?.[attribute.replace(/^_(.+)_value$/, "$1")] ?? null;
  }
  return row;
}

// The docs list no INFORMATION_SCHEMA views and no metadata functions among the supported SQL surface, so none are emitted.
export function informationSchema() {
  throw new DataError(
    "INFORMATION_SCHEMA is not supported by the Dataverse SQL endpoint: metadata views and functions are not available.",
    400,
    "NotSupported",
  );
}
