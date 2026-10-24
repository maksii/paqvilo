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

/** Formula text of the columns whose effective metadata has the requested source type. */
export function derivedColumnsOf(api, logical, sourceType) {
  const result = {};
  for (const [name, definition] of Object.entries(api.store.fieldDefinitions(logical, api.metadataFields) ?? {})) {
    const column = { ...definition, ...(definition?.columnMetadata ?? {}) };
    const type = column.sourceType ?? column.SourceType;
    if (Number(type !== null && typeof type === 'object' ? type.Value : type) === sourceType)
      result[name.toLowerCase()] = column.formulaDefinition ?? column.FormulaDefinition ?? '';
  }
  return result;
}
