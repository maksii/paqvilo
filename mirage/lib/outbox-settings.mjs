// The `providers.outbox` settings contract: validation only, no outbox. outbox.mjs registers it when it loads;
// settings-contracts.mjs registers it on the config-load path.

const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** Validates `providers.outbox`: { kind: 'local' | 'pack:<id>' = 'local', retention?: 1..1000000 }. */
export function outboxSettings(value, label = 'providers.outbox') {
  if (value === undefined) value = {};
  if (!isPlain(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!['kind', 'retention'].includes(key))
      throw new Error(`Unknown ${label} key '${key}'; expected kind or retention`);
  const kind = value.kind ?? 'local';
  if (typeof kind !== 'string' || (kind !== 'local' && !/^pack:[a-z0-9][a-z0-9._-]*$/.test(kind)))
    throw new Error(`${label}.kind must be local or pack:<id>`);
  if (
    value.retention !== undefined &&
    (!Number.isInteger(value.retention) || value.retention < 1 || value.retention > 1_000_000)
  )
    throw new Error(`${label}.retention must be an integer from 1 through 1000000`);
  return { kind, ...(value.retention !== undefined ? { retention: value.retention } : {}) };
}
