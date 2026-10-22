import { isOrganizationTable } from './dataverse-security.mjs';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
const key = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();

/** Data presets own only their explicit organization sections. The core table
 * catalogue and bootstrap flags identify platform/source rows; no project names are inferred here.
 * Explicit preset entries retain their existing replacement semantics. */
export function preserveOrganizationPresetSections(previous, preset, next) {
  next.mappings ??= {};
  next.tables ??= {};
  for (const [name, mapping] of Object.entries(previous.mappings ?? {})) {
    const ownsRows = isOrganizationTable(name) || mapping.dataverseOnly === true || mapping.standardTable === true || mapping.modelDrivenSource === true;
    const ownsSchema = ownsRows || mapping.metadataSources?.length || mapping.dataverseMetadata?.createdByMetadataApi === true;
    if (ownsSchema && !own(preset.mappings, name)) next.mappings[name] = structuredClone(mapping);
    if (ownsRows && !own(preset.tables, name) && own(previous.tables, name)) next.tables[name] = structuredClone(previous.tables[name]);
  }
  // Rows the Solution sources seeded (previous.dataverse.sourceSeeded) stay when a preset replaces their table, as the next
  // source refresh re-seeds them: the preset's rows win by id and keep their place; the Solution's other rows keep theirs.
  // The plug-in seeder records its ids under `plugin:<table>` (dataverse-plugin-registration.mjs); both keys name the table.
  const seededByTable = {};
  for (const [entry, ids] of Object.entries(previous.dataverse?.sourceSeeded ?? {}))
    if (Array.isArray(ids)) (seededByTable[entry.replace(/^plugin:/, '')] ??= []).push(...ids);
  for (const [name, ids] of Object.entries(seededByTable)) {
    if (!own(preset.tables, name) || !ids.length) continue;
    const idColumn = (next.mappings[name] ?? previous.mappings?.[name])?.idColumn ?? `${name}id`;
    const seeded = new Set(ids.map(key)), byId = new Map((next.tables[name] ?? []).map(row => [key(row[idColumn]), row]));
    const merged = (previous.tables?.[name] ?? []).flatMap(row => {
      const id = key(row[idColumn]);
      if (byId.has(id)) { const replaced = byId.get(id); byId.delete(id); return [replaced]; }
      return seeded.has(id) ? [structuredClone(row)] : [];
    });
    next.tables[name] = [...merged, ...byId.values()];
  }
  return next;
}
