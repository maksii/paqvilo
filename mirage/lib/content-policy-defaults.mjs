import { externalFrameOrigins } from './content-policy.mjs';

/** Project defaults seed new runtime states; persisted routing remains authoritative. */
export function contentPolicyDefaults(value = {}) {
  const result = {};
  for (const key of ['confinePortalPages', 'externalAssets'])
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
      result[key] = value[key];
    }
  if (value.externalFrameOrigins !== undefined)
    result.externalFrameOrigins = externalFrameOrigins(value.externalFrameOrigins);
  return result;
}
