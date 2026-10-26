/** Validate a trusted pack's synchronous derived-column overrides without changing export-specific diagnostics. */
export function validateDerivedColumns(map, exportName) {
  if (map === undefined) return {};
  if (!map || typeof map !== 'object' || Array.isArray(map))
    throw new TypeError(`${exportName} must map '<table>.<column>' to functions.`);
  const result = {};
  for (const [key, fn] of Object.entries(map)) {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(key))
      throw new TypeError(`${exportName} key '${key}' must be '<table>.<column>'.`);
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction')
      throw new TypeError(`${exportName}['${key}'] must be a synchronous function (row, ctx) => value.`);
    result[key.toLowerCase()] = fn;
  }
  return result;
}

const enumerableOwn = (value, key) =>
  value !== null && typeof value === 'object' && Object.prototype.propertyIsEnumerable.call(value, key);
// A property of { ...definition, ...columnMetadata } without building the merged copy of every column.
const merged = (definition, metadata, key) =>
  enumerableOwn(metadata, key) ? metadata[key] : enumerableOwn(definition, key) ? definition[key] : undefined;

/** Formula text of the columns whose effective metadata has the requested source type. */
export function derivedColumnsOf(api, logical, sourceType) {
  const result = {};
  for (const [name, definition] of Object.entries(api.store.fieldDefinitions(logical, api.metadataFields) ?? {})) {
    const metadata = definition?.columnMetadata;
    const type = merged(definition, metadata, 'sourceType') ?? merged(definition, metadata, 'SourceType');
    if (Number(type !== null && typeof type === 'object' ? type.Value : type) === sourceType)
      result[name.toLowerCase()] =
        merged(definition, metadata, 'formulaDefinition') ?? merged(definition, metadata, 'FormulaDefinition') ?? '';
  }
  return result;
}
