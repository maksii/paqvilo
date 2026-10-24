import path from 'node:path';
// Executable Solution assets are project code and require an explicit trust decision.
export function modelDrivenSettings(value, label = 'modelDriven', base = process.cwd()) {
  if (value == null) return { trustedExtensions: false };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!['enabled', 'trustedExtensions', 'clientSources', 'targets'].includes(key))
      throw new Error(`Unknown ${label} key '${key}'`);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    throw new Error(`${label}.enabled must be true or false`);
  if (value.trustedExtensions !== undefined && typeof value.trustedExtensions !== 'boolean')
    throw new Error(`${label}.trustedExtensions must be true or false`);
  if (
    value.clientSources !== undefined &&
    (!Array.isArray(value.clientSources) ||
      value.clientSources.length > 128 ||
      value.clientSources.some(
        // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
        (source) => typeof source !== 'string' || !source.trim() || source.length > 4096 || /[\x00-\x1f]/.test(source),
      ))
  )
    throw new Error(`${label}.clientSources must be an ordered array of at most 128 local source paths`);
  let targets;
  if (value.targets !== undefined) {
    if (!Array.isArray(value.targets) || !value.targets.length || value.targets.length > 32)
      throw new Error(`${label}.targets must contain 1..32 explicit reference targets`);
    const seen = new Set();
    targets = value.targets.map((target, index) => {
      const key = `${label}.targets[${index}]`;
      if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error(`${key} must be an object`);
      for (const name of Object.keys(target))
        if (!['reference', 'startPath', 'resourceMap', 'caution'].includes(name))
          throw new Error(`Unknown ${key} key '${name}'`);
      if (
        typeof target.reference !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]*$/i.test(target.reference) ||
        seen.has(target.reference)
      )
        throw new Error(`${key}.reference must select a distinct reference ID`);
      seen.add(target.reference);
      const startPath = target.startPath ?? '/main.aspx';
      if (
        typeof startPath !== 'string' ||
        !startPath.startsWith('/') ||
        startPath.startsWith('//') ||
        // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
        /[\\\x00-\x20]/.test(startPath)
      )
        throw new Error(`${key}.startPath must be an origin-local path`);
      if (
        target.resourceMap !== undefined &&
        // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
        (typeof target.resourceMap !== 'string' || !target.resourceMap.trim() || /[\x00-\x1f]/.test(target.resourceMap))
      )
        throw new Error(`${key}.resourceMap must be a local file path`);
      if (target.caution !== undefined && typeof target.caution !== 'boolean')
        throw new Error(`${key}.caution must be boolean`);
      return {
        reference: target.reference,
        startPath,
        caution: target.caution === true,
        ...(target.resourceMap !== undefined ? { resourceMap: path.resolve(base, target.resourceMap) } : {}),
      };
    });
  }
  // enabled: false switches the model-driven surface (/main.aspx) off; it is only present when set.
  return {
    ...(value.enabled === false ? { enabled: false } : {}),
    ...(targets ? { targets } : {}),
    trustedExtensions: value.trustedExtensions === true,
    ...(value.clientSources !== undefined
      ? { clientSources: [...new Set(value.clientSources.map((source) => path.resolve(base, source)))] }
      : {}),
  };
}
