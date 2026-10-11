import { portalField } from './importer.mjs';
import { settingsJson } from './native-services.mjs';
import { DataError } from './data.mjs';

/** Actions are resolved again from the exported component, never from client configuration. */
export function nativeFormActions(component) {
  const settings = settingsJson(portalField(component ?? {}, 'settings') ?? '', 'form settings');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new DataError('Native form settings must be an object.', 501, 'FormActionConfigurationInvalid');
  const actions = settings?.Actions ?? [];
  if (Object.hasOwn(settings ?? {}, 'Actions') && (!Array.isArray(settings.Actions) || actions.some(action => !action || typeof action !== 'object' || Array.isArray(action) || typeof action.Type !== 'string')))
    throw new DataError('Native form Actions must be an array of action definitions with a Type.', 501, 'FormActionConfigurationInvalid');
  return actions;
}

export const NATIVE_STATE_ACTIONS = Object.freeze({
  deactivate: { type: 'DeactivateAction', button: 'DeactivateButton', label: 'Deactivate', state: 1 },
  activate: { type: 'ActivateAction', button: 'ActivateButton', label: 'Activate', state: 0 },
});

/** A managed table's status values are not necessarily the standard 1/2 pair. */
export function nativeActionStateValues(entity, action, { metadata, store, schema } = {}) {
  const fields = metadata?.entities?.[entity]?.fields ?? {};
  const definition = name => fields[name] ?? store?.fieldDefinition?.(entity, name) ?? schema?.fields?.find(field => field.name === name);
  const state = NATIVE_STATE_ACTIONS[action]?.state;
  const stateField = definition('statecode'), statusField = definition('statuscode');
  const selected = (stateField?.states ?? stateField?.options ?? []).find(option => Number(option.value) === state);
  const statuses = (statusField?.statuses ?? statusField?.options ?? []).filter(option => Number(option.state) === state);
  const status = selected?.defaultStatus == null
    ? statuses.length === 1 ? statuses[0] : null
    : statuses.find(option => Number(option.value) === Number(selected.defaultStatus));
  return selected && status ? { statecode: state, statuscode: Number(status.value) } : null;
}
