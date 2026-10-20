import path from 'node:path';
// Executable Solution assets are project code and require an explicit trust decision.
export function modelDrivenSettings(value, label = 'modelDriven', base = process.cwd()) {
  if (value == null) return { trustedExtensions: false };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!['trustedExtensions', 'clientSources'].includes(key)) throw new Error(`Unknown ${label} key '${key}'`);
  if (value.trustedExtensions !== undefined && typeof value.trustedExtensions !== 'boolean') throw new Error(`${label}.trustedExtensions must be true or false`);
  if (value.clientSources !== undefined && (!Array.isArray(value.clientSources) || value.clientSources.length > 128 || value.clientSources.some(source => typeof source !== 'string' || !source.trim() || source.length > 4096 || /[\x00-\x1f]/.test(source)))) throw new Error(`${label}.clientSources must be an ordered array of at most 128 local source paths`);
  return { trustedExtensions: value.trustedExtensions === true,
    ...(value.clientSources !== undefined ? { clientSources: [...new Set(value.clientSources.map(source => path.resolve(base, source)))] } : {}) };
}
