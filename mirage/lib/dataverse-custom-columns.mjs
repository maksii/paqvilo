/** API-authored column definitions remain authoritative above reloaded source
 * defaults. This pure state projection is shared by source composition and
 * metadata writes, without importing the organization or HTTP host. */
export function applyCustomColumns(state) {
  for (const [logical, bucket] of Object.entries(state.dataverse?.customColumns ?? {})) {
    const mapping = state.mappings?.[logical];
    if (!mapping) continue;
    mapping.fields ??= {};
    for (const [name, field] of Object.entries(bucket)) mapping.fields[name] = structuredClone(field);
  }
  return state;
}
