import { validatePlatformOverrides } from './platform-settings.mjs';

/** Project-supplied organization settings require evidence, unlike local experiments. */
export function platformConfig(value, label = 'mirage.platform') {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const { evidence, ...values } = value;
  if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 4000)
    throw new Error(`${label}.evidence must identify the source of these settings`);
  validatePlatformOverrides(values);
  return {
    ...Object.fromEntries(Object.entries(structuredClone(values)).sort(([left], [right]) => left.localeCompare(right))),
    evidence,
  };
}
export function applyPlatformConfig(state, value) {
  const configured = platformConfig(value);
  if (configured) {
    state.simulator ??= {};
    state.simulator.platformDefaults = configured;
  } else if (state.simulator) delete state.simulator.platformDefaults;
  return state;
}
