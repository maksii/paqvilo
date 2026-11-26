import { portalField } from './importer.mjs';
import { settingsJson } from './native-services.mjs';
import { DataError, parseFetchXml } from './data.mjs';
import { planFetch } from './fetchxml-engine.mjs';
import { serializePermissionFetchXml } from './permission-query.mjs';
import { contextualViewFetchXml } from './platform.mjs';

/** Actions are resolved again from the exported component, never from client configuration. */
export function nativeFormActions(component) {
  const settings = settingsJson(portalField(component ?? {}, 'settings') ?? '', 'form settings');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new DataError('Native form settings must be an object.', 501, 'FormActionConfigurationInvalid');
  const actions = settings?.Actions ?? [];
  if (
    Object.hasOwn(settings ?? {}, 'Actions') &&
    (!Array.isArray(settings.Actions) ||
      actions.some(
        (action) => !action || typeof action !== 'object' || Array.isArray(action) || typeof action.Type !== 'string',
      ))
  )
    throw new DataError(
      'Native form Actions must be an array of action definitions with a Type.',
      501,
      'FormActionConfigurationInvalid',
    );
  return actions;
}

const filterUnsupported = () =>
  new DataError(
    'Native state actions require a full non-aggregate FetchXML filter on the form table and a local read provider.',
    501,
    'FormActionFilterUnsupported',
  );

/** Evaluate the selected record against an exported action criterion using regular table permissions. */
function nativeFormActionQuery(filter, { entity, idColumn, recordId, identity, context }) {
  let plan;
  try {
    const bound = contextualViewFetchXml(filter, { ...context, identity });
    plan = planFetch(parseFetchXml(bound));
  } catch {
    throw filterUnsupported();
  }
  const { fetch, root, links, aggregate, distinct } = plan;
  const aggregates = [root, ...links].some((node) =>
    node.children.some(
      ({ name, attrs }) =>
        name === 'attribute' && (attrs.aggregate || attrs.rowaggregate || attrs.dategrouping || attrs.groupby),
    ),
  );
  if (aggregate || aggregates || root.attrs.name.toLowerCase() !== entity.toLowerCase()) throw filterUnsupported();
  const fields = root.children.filter((node) => node.name === 'attribute');
  const projectsId =
    !fields.length ||
    root.children.some((node) => node.name === 'all-attributes') ||
    fields.some(({ attrs }) => !attrs.alias && attrs.name.toLowerCase() === idColumn.toLowerCase());
  if (distinct && !projectsId) root.children.push({ name: 'attribute', attrs: { name: idColumn }, children: [] });
  root.children.push({
    name: 'filter',
    attrs: { type: 'and' },
    children: [{ name: 'condition', attrs: { attribute: idColumn, operator: 'eq', value: recordId }, children: [] }],
  });
  return serializePermissionFetchXml(fetch, 0, false);
}

const recordKey = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();

/** Evaluate the selected record against an exported action criterion using regular table permissions. */
export async function nativeFormActionApplies(action, scope) {
  if (!Object.values(NATIVE_STATE_ACTIONS).some(({ type }) => type === action.Type)) throw filterUnsupported();
  const filter = action.FilterCriteria;
  if (!filter) return true;
  if (scope.available === false || typeof filter !== 'string' || typeof scope.readProvider?.fetchXml !== 'function')
    throw filterUnsupported();
  const query = nativeFormActionQuery(filter, scope);
  const result = await scope.readProvider.fetchXml(query, scope.identity);
  return (result.entities ?? result.value ?? []).some(
    (row) => recordKey(row[scope.idColumn]) === recordKey(scope.recordId),
  );
}

export const NATIVE_STATE_ACTIONS = Object.freeze({
  deactivate: { type: 'DeactivateAction', button: 'DeactivateButton', label: 'Deactivate', state: 1 },
  activate: { type: 'ActivateAction', button: 'ActivateButton', label: 'Activate', state: 0 },
});

/** A managed table's status values are not necessarily the standard 1/2 pair. */
export function nativeActionStateValues(entity, action, { metadata, store, schema } = {}) {
  const fields = metadata?.entities?.[entity]?.fields ?? {};
  const definition = (name) =>
    fields[name] ?? store?.fieldDefinition?.(entity, name) ?? schema?.fields?.find((field) => field.name === name);
  const state = NATIVE_STATE_ACTIONS[action]?.state;
  const stateField = definition('statecode'),
    statusField = definition('statuscode');
  const selected = (stateField?.states ?? stateField?.options ?? []).find((option) => Number(option.value) === state);
  const statuses = (statusField?.statuses ?? statusField?.options ?? []).filter(
    (option) => Number(option.state) === state,
  );
  let status;
  if (selected?.defaultStatus == null) status = statuses.length === 1 ? statuses[0] : null;
  else status = statuses.find((option) => Number(option.value) === Number(selected.defaultStatus));
  return selected && status ? { statecode: state, statuscode: Number(status.value) } : null;
}
