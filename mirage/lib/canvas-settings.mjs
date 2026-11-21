// The `canvas` settings contract: validation only, no canvas source reader. canvas-source.mjs re-exports canvasSettings;
// settings-contracts.mjs registers it on the config-load path.

/** Validates the project `canvas` key: { enabled?: boolean, sources?: string[] }. Registered by settings-contracts.mjs. */
export function canvasSettings(value, label = 'canvas') {
  if (value == null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!['enabled', 'sources', 'codeComponents'].includes(key))
      throw new Error(`Unknown ${label} key '${key}'; expected enabled, sources or codeComponents`);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    throw new Error(`${label}.enabled must be true or false`);
  if (value.codeComponents !== undefined && typeof value.codeComponents !== 'boolean')
    throw new Error(`${label}.codeComponents must be true or false`);
  if (
    value.sources !== undefined &&
    (!Array.isArray(value.sources) || value.sources.some((source) => typeof source !== 'string' || !source.trim()))
  )
    throw new Error(`${label}.sources must be an array of non-empty paths`);
  return {
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.codeComponents !== undefined ? { codeComponents: value.codeComponents } : {}),
    ...(value.sources !== undefined ? { sources: [...value.sources] } : {}),
  };
}
