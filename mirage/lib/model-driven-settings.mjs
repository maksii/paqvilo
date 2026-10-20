// Executable Solution assets are project code and require an explicit trust decision.
export function modelDrivenSettings(value, label = 'modelDriven') {
  if (value == null) return { trustedExtensions: false };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (key !== 'trustedExtensions') throw new Error(`Unknown ${label} key '${key}'`);
  if (value.trustedExtensions !== undefined && typeof value.trustedExtensions !== 'boolean') throw new Error(`${label}.trustedExtensions must be true or false`);
  return { trustedExtensions: value.trustedExtensions === true };
}
