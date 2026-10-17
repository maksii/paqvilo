/** Local runtime budget; it is not an observation about the native platform. */
export function renderSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mirage.render must be an object');
  for (const key of Object.keys(value)) if (key !== 'timeLimitMs') throw new Error(`Unknown setting mirage.render.${key}`);
  const timeLimitMs = value.timeLimitMs ?? 60_000;
  if (!Number.isSafeInteger(timeLimitMs) || timeLimitMs < 1 || timeLimitMs > 3_600_000)
    throw new Error('mirage.render.timeLimitMs must be an integer from 1 to 3600000 milliseconds');
  return { timeLimitMs };
}
