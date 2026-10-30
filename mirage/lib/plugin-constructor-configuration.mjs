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
 * text absent from an export can still be supplied by the trusted descriptor. */
export function runtimeConstructorSettings(store, stepId, supplied, descriptor) {
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
    if (!id) result.secureConfiguration = null;
    else {
      const secure = store
        .tableRows('sdkmessageprocessingstepsecureconfig')
        .find((value) => key(value.sdkmessageprocessingstepsecureconfigid) === id);
      if (secure && own(secure, 'secureconfig')) result.secureConfiguration = secure.secureconfig ?? null;
      else if (!own(descriptor, 'secureConfiguration'))
        throw new DataError(
          'Registered secure configuration is unavailable; supply it through an explicitly trusted runtime descriptor.',
          501,
          'LocalPluginConfigurationUnavailable',
        );
    }
  }
  if (Object.values(result).some((value) => value !== null && typeof value !== 'string'))
    throw new DataError(
      'Plug-in constructor configuration requires string or null values.',
      501,
      'LocalPluginConfigurationUnsupported',
    );
  return result;
}
