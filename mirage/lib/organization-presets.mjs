import { isOrganizationTable } from './dataverse-security.mjs';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);

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
  return next;
}
