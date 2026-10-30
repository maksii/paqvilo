// mirage.trace: the start value of the local trace store (trace-store.mjs). The store holds the live value; the
// `_sim` settings route changes it at run time through mergeTraceSettings without a restart.
const LEVELS = ['off', 'summary', 'full'];
const RANGES = {
  traces: [10, 10_000, 500],
  spansPerTrace: [50, 20_000, 2000],
  payloadBytes: [256, 1_048_576, 16_384],
};
const KEYS = ['level', ...Object.keys(RANGES), 'persist'];

/** Validates mirage.trace ({ level, traces, spansPerTrace, payloadBytes, persist }) and fills its defaults. */
export function traceSettings(value = {}, label = 'mirage.trace') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) throw new Error(`Unknown setting ${label}.${key}`);
  const level = value.level ?? 'summary';
  if (!LEVELS.includes(level)) throw new Error(`${label}.level must be off, summary or full`);
  const result = { level };
  for (const [key, [min, max, fallback]] of Object.entries(RANGES)) {
    const number = value[key] ?? fallback;
    if (!Number.isSafeInteger(number) || number < min || number > max)
      throw new Error(`${label}.${key} must be an integer from ${min} to ${max}`);
    result[key] = number;
  }
  const persist = value.persist ?? false;
  if (typeof persist !== 'boolean') throw new Error(`${label}.persist must be true or false`);
  result.persist = persist;
  return result;
}

/** The settings after a run-time change: `partial` replaces the members it names and is validated like the start value. */
export function mergeTraceSettings(current, partial = {}, label = 'trace') {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new Error(`${label} must be an object`);
  return traceSettings({ ...traceSettings(current, label), ...partial }, label);
}
