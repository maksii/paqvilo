import { DataError } from './data-error.mjs';

// Constructor text is execution input, never public catalogue/index content.
const settings = new WeakMap();
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const key = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
export function recordStepConstructorSettings(step, value) {
  settings.set(step, { ...value });
  return step;
}
export const hasStepConstructorSettings = (step) => settings.has(step);
export function copyStepConstructorSettings(source, target) {
  if (settings.has(source)) settings.set(target, settings.get(source));
  return target;
}
export const stepConstructorSettings = (step) => ({ ...settings.get(step) });

/** Current registration rows take precedence over descriptor fallbacks. Secure
 * text absent from an export can still be supplied by the trusted descriptor.
 * A custom API main operation (mainOperation) has no step registration: native
 * constructs it with null unsecure and secure configuration, whatever the
 * descriptor supplies. A step row whose secure configuration row is absent (the
 * state after a Solution import, which never exports secure text) or holds no
 * text constructs with null secure configuration unless the descriptor supplies it. */
export function runtimeConstructorSettings(store, stepId, supplied, descriptor, { mainOperation = false } = {}) {
  if (mainOperation) return { unsecureConfiguration: null, secureConfiguration: null };
  const result = {
    unsecureConfiguration: descriptor.unsecureConfiguration ?? null,
    secureConfiguration: descriptor.secureConfiguration ?? null,
    ...supplied,
  };
  const row = store
    ?.tableRows?.('sdkmessageprocessingstep')
    .find((value) => key(value.sdkmessageprocessingstepid) === key(stepId));
  if (row && own(row, 'configuration')) result.unsecureConfiguration = row.configuration ?? null;
  if (row && own(row, 'sdkmessageprocessingstepsecureconfigid')) {
    const id = key(row.sdkmessageprocessingstepsecureconfigid);
    const secure = id
      ? store
          .tableRows('sdkmessageprocessingstepsecureconfig')
          .find((value) => key(value.sdkmessageprocessingstepsecureconfigid) === id)
      : null;
    if (secure && own(secure, 'secureconfig')) result.secureConfiguration = secure.secureconfig ?? null;
    else if (!id || !own(descriptor, 'secureConfiguration')) result.secureConfiguration = null;
  }
  // Configuration columns are text: anything else is a corrupt local row, not a value the platform could pass.
  if (Object.values(result).some((value) => value !== null && typeof value !== 'string'))
    throw new DataError(
      'Plug-in constructor configuration rows must hold text or null.',
      500,
      'LocalPluginConfigurationInvalid',
    );
  return result;
}
