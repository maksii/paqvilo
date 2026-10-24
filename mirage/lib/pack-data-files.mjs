const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
const tableName = /^[a-z][a-z0-9_]*$/i;
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const pathOf = (value, label) => {
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string' || !key || unsafe.has(key)))
    throw new Error(`${label} must be an array of safe JSON property names.`);
  return [...value];
};

/** A trusted pack declares existing JSON DATA files explicitly. Executable pack
 * modules, source exports and discovery files are never inferred as write targets.
 * Fixed table ownership uses {path, idColumn}; one optional newTablesPath owns
 * newly created tables in deep simulation. schemaPath holds normalized metadata. */
export function validatePackDataFiles(value, label = 'dataFiles') {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) => {
    const at = `${label}[${index}]`;
    if (
      !plain(entry) ||
      Object.keys(entry).some((key) => !['file', 'tables', 'newTablesPath', 'schemaPath'].includes(key))
    )
      throw new Error(`${at} has unknown data file properties.`);
    if (
      typeof entry.file !== 'string' ||
      !entry.file.trim() ||
      !/\.json$/i.test(entry.file) ||
      /^(?:[a-z]:|[\\/])/i.test(entry.file) ||
      entry.file.split(/[\\/]/).some((part) => part === '..' || part === '.git' || part === '.paqvilo')
    )
      throw new Error(`${at}.file must name an existing relative JSON data file inside the pack.`);
    if (entry.tables !== undefined && !plain(entry.tables))
      throw new Error(`${at}.tables must map logical table names to data locations.`);
    const tables = {};
    for (const [table, owner] of Object.entries(entry.tables ?? {})) {
      if (
        !tableName.test(table) ||
        unsafe.has(table) ||
        !plain(owner) ||
        Object.keys(owner).some((key) => !['path', 'idColumn'].includes(key)) ||
        !tableName.test(owner.idColumn ?? '') ||
        unsafe.has(owner.idColumn)
      )
        throw new Error(`${at}.tables.${table} requires a safe idColumn and JSON path.`);
      tables[table] = { path: pathOf(owner.path, `${at}.tables.${table}.path`), idColumn: owner.idColumn };
    }
    const result = { file: entry.file, tables };
    for (const key of ['newTablesPath', 'schemaPath'])
      if (entry[key] !== undefined) result[key] = pathOf(entry[key], `${at}.${key}`);
    if (!Object.keys(tables).length && !result.newTablesPath && !result.schemaPath)
      throw new Error(`${at} declares no data or schema location.`);
    const paths = [
      ...Object.values(tables).map((owner) => owner.path),
      ...['newTablesPath', 'schemaPath'].filter((key) => result[key]).map((key) => result[key]),
    ];
    for (let a = 0; a < paths.length; a++)
      for (let b = a + 1; b < paths.length; b++) {
        if (paths[a].slice(0, Math.min(paths[a].length, paths[b].length)).every((key, i) => key === paths[b][i]))
          throw new Error(`${at} data and schema locations must not overlap.`);
      }
    return result;
  });
}
