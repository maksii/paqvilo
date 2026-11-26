// The dataset code component's part of a native grid request. A list or subgrid hosting a dataset PCF reads its rows
// through the same grid services as the native grid with the platform's own request members (captured):
// the native sortExpression, page and
// pageSize, and `pcfFilter`, the dataset filter as a FetchXML <filter> string ("" without one). Added columns and links
// never reach the server. Only a grid configuration signed for the dataset host (`pcf: true`) accepts `pcfFilter`; its
// tables and columns are checked against the exported metadata and the visitor's masked columns.

const IDENTIFIER = /^[a-z_][a-z\d_]*$/i;
const OPERATOR = /^[a-z][a-z-]*$/;
const MAX_FILTER = 65536;
const MAX_CHANGES = 100;
const MAX_VALUE = 64 * 1024;

const children = (node, name) => (node?.children ?? []).filter((child) => child.name === name);
function descendants(node, name, out = []) {
  for (const child of node?.children ?? []) {
    if (child.name === name) out.push(child);
    descendants(child, name, out);
  }
  return out;
}

const FILTER_ATTRIBUTES = new Set(['type']);
const CONDITION_ATTRIBUTES = new Set(['attribute', 'entityname', 'operator', 'value']);
// At most 16 nested filter levels, the root filter included (the client host builds the same limit).
const MAX_FILTER_DEPTH = 16;
const onlyAttributes = (node, allowed) => Object.keys(node.attrs).every((name) => allowed.has(name));

/**
 * Validate a dataset filter against the query's tables: filter, condition and value elements only, each with its own
 * attributes only (filter type; condition attribute, entityname, operator, value; value none).
 */
function validateFilter(node, depth, { invalid, columnOf }) {
  if (
    depth >= MAX_FILTER_DEPTH ||
    node.name !== 'filter' ||
    !onlyAttributes(node, FILTER_ATTRIBUTES) ||
    !['and', 'or', undefined].includes(node.attrs.type)
  )
    invalid();
  for (const child of node.children) {
    if (child.name === 'filter') validateFilter(child, depth + 1, { invalid, columnOf });
    else if (child.name === 'condition') {
      const { attribute, entityname, operator } = child.attrs;
      if (
        !onlyAttributes(child, CONDITION_ATTRIBUTES) ||
        !IDENTIFIER.test(attribute ?? '') ||
        !OPERATOR.test(operator ?? '') ||
        !columnOf(entityname, attribute)
      )
        invalid();
      if (
        child.children.some(
          (value) => value.name !== 'value' || value.children.length || Object.keys(value.attrs).length,
        )
      )
        invalid();
    } else invalid();
  }
}

/**
 * Apply a dataset's `pcfFilter` to the grid's FetchXML tree: the filter's conditions may name exported columns of the view's table and
 * its link-entity aliases. `fields(table)` answers a table's exported columns, `masked(table, column)` whether the
 * visitor reads the column masked, `parse(xml)` parses a FetchXML fragment and `invalid()` throws the service's 400, `missing(table, column)` its 500 for a column the table lacks.
 */
export function applyPcfGridFilter(
  fetch,
  pcfFilter,
  { parse, fields, masked = () => false, invalid, missing = invalid },
) {
  if (pcfFilter == null || pcfFilter === '') return;
  if (typeof pcfFilter !== 'string' || pcfFilter.length > MAX_FILTER) invalid();
  const root = children(fetch, 'entity')[0];
  const aliases = new Map(
    descendants(root, 'link-entity')
      .filter((node) => node.attrs.alias)
      .map((node) => [node.attrs.alias, node]),
  );
  const has = (table, column) => Object.hasOwn(fields(table) ?? {}, column);
  // Any exported column of the view's table or of a view link-entity's table can filter the query, as on Power Pages
  // (a column the view does not show included), but none the visitor reads masked: column
  // security keeps its values from leaking through which rows come back.
  const queryable = (alias, column) => {
    const node = alias == null ? root : aliases.get(alias);
    if (!node) return false;
    // A column the table does not have fails the query as the platform's does (500).
    if (!has(node.attrs.name, column)) missing(node.attrs.name, column);
    return !masked(node.attrs.name, column);
  };
  const filter = parse(pcfFilter);
  validateFilter(filter, 0, { invalid, columnOf: (alias, column) => queryable(alias ?? null, column) });
  root.children.push(filter);
}

// Columns a dataset save never writes: record state, ownership, audit and system columns.
const SYSTEM_COLUMNS = new Set([
  'statecode',
  'statuscode',
  'ownerid',
  'owninguser',
  'owningteam',
  'owningbusinessunit',
  'createdon',
  'createdby',
  'createdonbehalfby',
  'modifiedon',
  'modifiedby',
  'modifiedonbehalfby',
  'overriddencreatedon',
  'versionnumber',
  'importsequencenumber',
  'timezoneruleversionnumber',
  'utcconversiontimezonecode',
  'exchangerate',
  'transactioncurrencyid',
  'processid',
  'stageid',
  'traversedpath',
]);
// Attribute types a dataset save does not write until the platform's request shape for them is known: references (lookup, customer, owner, party list), state and status, keys, files and computed types.
const UNWRITABLE_TYPES = new Set([
  'lookup',
  'customer',
  'owner',
  'partylist',
  'state',
  'status',
  'primarykey',
  'uniqueidentifier',
  'file',
  'image',
  'virtual',
  'entityname',
  'managedproperty',
]);

/** Whether a dataset save may write a column: a plain exported, updatable column that is not a system column. */
function pcfWritableColumn(name, field, idColumn) {
  const facts = field?.columnMetadata ?? {};
  // Calculated (1), rollup (2) and formula (3) columns are computed by the platform, whatever ValidForUpdateApi says.
  const computed =
    [1, 2, 3].includes(Number(field?.sourceType ?? facts.sourceType)) || Boolean(facts.formulaDefinition);
  return (
    IDENTIFIER.test(name) &&
    name !== idColumn &&
    Boolean(field) &&
    field.validForUpdate !== false &&
    !field.attributeOf &&
    !field.isLogical &&
    !computed &&
    !SYSTEM_COLUMNS.has(name.toLowerCase()) &&
    !UNWRITABLE_TYPES.has(String(field.dataverseType ?? '').toLowerCase())
  );
}

// Dataverse's own ranges of the numeric attribute types, applied when the export states no MinValue/MaxValue.
const NUMERIC_RANGES = {
  int: [-2147483648, 2147483647],
  integer: [-2147483648, 2147483647],
  bigint: [-9007199254740991, 9007199254740991],
  decimal: [-100000000000, 100000000000],
  float: [-100000000000, 100000000000],
  double: [-100000000000, 100000000000],
  money: [-922337203685477, 922337203685477],
};
/** Whether a number is a finite value inside the column's range (its exported range, else the type's default). */
function inNumericRange(value, field) {
  const range = NUMERIC_RANGES[String(field.dataverseType ?? '').toLowerCase()];
  if (!range) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const min = Number.isFinite(Number(field.minValue)) && field.minValue != null ? Number(field.minValue) : range[0];
  const max = Number.isFinite(Number(field.maxValue)) && field.maxValue != null ? Number(field.maxValue) : range[1];
  return value >= min && value <= max;
}

// One { Name, Value } attribute of a dataset save into `values`: a writable layout column, once, with a JSON primitive.
function readGridAttribute(attribute, values, { fields, columns, idColumn, invalid }) {
  const column = attribute?.Name;
  const encoded = attribute?.Value;
  if (typeof column !== 'string' || Object.hasOwn(values, column)) invalid();
  const field = Object.hasOwn(fields, column) ? fields[column] : null;
  if (!columns.has(column) || !pcfWritableColumn(column, field, idColumn)) invalid();
  if (typeof encoded !== 'string' || encoded.length > MAX_VALUE) invalid();
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    invalid();
  }
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) invalid();
  if (value !== null && !inNumericRange(value, field)) invalid();
  values[column] = value;
}

/**
 * The record update of a dataset save (entity-grid-update-entity), the captured body:
 * `{ Id, EntityName, Attributes: [{ Name, Value }] }` where each Value is the JSON-encoded value the dataset's
 * getChanges() reports. EntityName must be the bound table. Only the bound view's own layout
 * columns (`columns`) that pcfWritableColumn admits and JSON primitives are accepted; the write path coerces the values
 * against the column metadata (MaxLength, precision). Returns `{ id, values }`.
 */
export function pcfGridUpdate(body, { entity, fields, columns, idColumn, invalid }) {
  const id = String(body?.Id ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id) || body?.EntityName !== entity) invalid();
  const attributes = body?.Attributes;
  if (!Array.isArray(attributes) || !attributes.length || attributes.length > MAX_CHANGES) invalid();
  const values = {};
  for (const attribute of attributes) readGridAttribute(attribute, values, { fields, columns, idColumn, invalid });
  return { id, values };
}
