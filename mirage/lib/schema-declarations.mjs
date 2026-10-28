// Project-owned declaration text from imported metadata. No runtime code,
// business labels, table prefixes or generated dependencies are embedded.
import { tableFields } from './solution-schema.mjs';
import { inspectionBudget, chargeSchemaOptions } from './inspection-budget.mjs';

const plain = (value) => value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const name = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value) && !['constructor', 'prototype'].includes(value);
const choiceTypes = new Set(['picklist', 'state', 'status']);
const stringTypes = new Set([
  'primarykey',
  'uniqueidentifier',
  'nvarchar',
  'varchar',
  'string',
  'text',
  'memo',
  'ntext',
  'entityname',
  'datetime',
  'date',
]);

/** Return deterministic .d.ts text for local fixture authoring, plus explicit unresolved-type diagnostics. */
export function generateSchemaDeclarations(schema, { tables = Object.keys(schema?.tables ?? {}) } = {}) {
  if (
    !plain(schema?.tables) ||
    !Array.isArray(tables) ||
    tables.length > 1000 ||
    tables.some((table) => !name(table) || !Object.hasOwn(schema.tables, table))
  )
    throw new TypeError('Schema declarations require imported tables and at most 1000 explicit logical table names.');
  const selected = [...new Set(tables)].sort(),
    diagnostics = [],
    tableLines = [],
    choiceLines = [],
    primaryLines = [];
  let columns = 0,
    optionCount = 0;
  const charge = inspectionBudget(1000000, 'Schema declarations');
  const metadata = { ...schema, targets: schema.targets ?? {}, optionSets: schema.optionSets ?? {} };
  for (const table of selected) {
    const source = schema.tables[table];
    if (
      !plain(source.attributes) ||
      Object.values(source.attributes).some((attribute) => !plain(attribute) || !name(attribute.name))
    )
      throw new TypeError('Schema declaration columns must have logical names and metadata objects.');
    chargeSchemaOptions(source, metadata, charge);
    const fields = tableFields(metadata, table, { provenance: false });
    const primary = source.primaryIdAttribute ?? table + 'id';
    if (!name(primary)) throw new TypeError('Schema primary IDs must be logical names.');
    if (!source.primaryIdAttribute) diagnostics.push({ code: 'SCHEMA_PRIMARY_ID_INFERRED', table, column: primary });
    fields[primary] ??= { dataverseType: 'uniqueidentifier', isPrimaryId: true, required: true };
    tableLines.push(`  ${JSON.stringify(table)}: {`);
    choiceLines.push(`  ${JSON.stringify(table)}: {`);
    primaryLines.push(`  ${JSON.stringify(table)}: ${JSON.stringify(primary)};`);
    for (const column of Object.keys(fields).sort()) {
      if (++columns > 10000) throw new RangeError('Schema declarations exceed the 10000-column limit.');
      const field = fields[column],
        type = field.dataverseType;
      let declaration;
      if (stringTypes.has(type)) declaration = 'string';
      else if (['bit', 'boolean'].includes(type)) declaration = 'boolean';
      else if (['int', 'integer', 'float', 'double'].includes(type)) declaration = 'number';
      else if (['decimal', 'money', 'bigint'].includes(type)) declaration = 'number | ExactNumeric';
      else if (choiceTypes.has(type) || type === 'multiselectpicklist') {
        const options = [...new Set((field.options ?? []).map((option) => option.value))].sort((a, b) => a - b);
        optionCount += options.length;
        if (optionCount > 100000 || options.some((option) => !Number.isSafeInteger(option)))
          throw new RangeError('Schema choice declarations exceed their bounded numeric option contract.');
        const attribute = source.attributes[column];
        const globalSet = attribute?.optionSetName ? metadata.optionSets[attribute.optionSetName.toLowerCase()] : null;
        const knownClosed =
          !field.optionSetOpen &&
          (Array.isArray(attribute?.optionSet?.options) ||
            Array.isArray(attribute?.optionSet?.states) ||
            Array.isArray(attribute?.optionSet?.statuses) ||
            (globalSet && !globalSet.open && Array.isArray(globalSet.options)));
        const closedEmpty = !options.length && knownClosed;
        const unresolved = field.optionSetOpen || (!options.length && !knownClosed);
        const union = unresolved ? 'number' : closedEmpty ? 'never' : options.join(' | ');
        if (unresolved) diagnostics.push({ code: 'SCHEMA_OPTIONS_UNRESOLVED', table, column });
        choiceLines.push(`    ${JSON.stringify(column)}: ${union};`);
        declaration =
          type === 'multiselectpicklist'
            ? closedEmpty
              ? '"" | ReadonlyArray<never>'
              : `string | ReadonlyArray<Choice<${union}>>`
            : `Choice<${union}>`;
      } else if (['lookup', 'customer', 'owner'].includes(type)) {
        const targets = [...new Set(field.targets ?? [])].sort();
        if (targets.some((target) => !name(target)))
          throw new TypeError('Schema lookup targets must be logical names.');
        if (!targets.length) diagnostics.push({ code: 'SCHEMA_LOOKUP_TARGETS_UNRESOLVED', table, column });
        declaration = `Lookup<${targets.length ? targets.map((target) => JSON.stringify(target)).join(' | ') : 'string'}>`;
      } else {
        declaration = 'unknown';
        diagnostics.push({
          code: 'SCHEMA_TYPE_UNSUPPORTED',
          table,
          column,
          type: typeof type === 'string' ? type : null,
        });
      }
      const required = column === primary || field.required;
      tableLines.push(
        `    ${column === primary || field.validForUpdate === false ? 'readonly ' : ''}${JSON.stringify(column)}${required ? '' : '?'}: ${declaration}${required ? '' : ' | null'};`,
      );
    }
    tableLines.push('  };');
    choiceLines.push('  };');
  }
  const declarations = [
    '// Generated from selected local Solution metadata. Types do not execute or validate runtime data.',
    'export interface ExactNumeric { readonly $type: "DataverseNumeric"; readonly numericType: "Int64" | "Decimal" | "Money" | "Literal"; readonly value: string; }',
    'export type Choice<T extends number> = T | { value: T; label?: string };',
    'export interface Lookup<T extends string> { id: string; logical_name: T; }',
    'export interface Tables {',
    ...tableLines,
    '}',
    'export interface Choices {',
    ...choiceLines,
    '}',
    'export interface PrimaryIds {',
    ...primaryLines,
    '}',
    'export type TableName = keyof Tables;',
    'export type Row<T extends TableName> = Tables[T];',
    'export type FixtureRow<T extends TableName> = Partial<Tables[T]> & Pick<Tables[T], PrimaryIds[T] & keyof Tables[T]>;',
    '',
  ].join('\n');
  if (Buffer.byteLength(declarations) > 2000000)
    throw new RangeError('Schema declarations exceed the 2 MB output limit.');
  return { schemaVersion: 1, declarations, diagnostics };
}
