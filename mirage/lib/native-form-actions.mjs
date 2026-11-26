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
    'Native record actions require a full non-aggregate FetchXML filter on the form table and a local read provider.',
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
  const { fetch, root, links, aggregate } = plan;
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
  // The match reads the record key from each row. A portal read is distinct by default (the permission compiler
  // qualifies it, lib/permission-query.mjs) and a distinct row carries only its selected columns, so select the key.
  if (!projectsId) root.children.push({ name: 'attribute', attrs: { name: idColumn }, children: [] });
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
  if (!nativeFormWorkflowId(action) && !Object.values(NATIVE_STATE_ACTIONS).some(({ type }) => type === action.Type))
    throw filterUnsupported();
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

export const NATIVE_FORM_WORKFLOW = 'WorkflowAction';

export function nativeFormWorkflowId(action) {
  if (action?.Type !== NATIVE_FORM_WORKFLOW || typeof action.WorkflowId !== 'string') return null;
  const id = action.WorkflowId.trim()
    .toLowerCase()
    .replace(/^\{([^{}]+)\}$/, '$1');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
}

/*
 * Basic Form record actions that set the record's state (Learn power-pages/configure/basic-forms, "Basic form action
 * configuration"). Activate and Deactivate apply to any table. The table-specific actions follow the legacy portal's
 * EntityActionController and CoreDataAdapter (Adxstudio, open source): `table` is the only table the action is offered
 * for, `status` the fixed status reason the legacy adapter passes (otherwise the state's default status), and `close`
 * the close activity its Dataverse message creates (CloseIncident: incidentresolution; Win/LoseOpportunity:
 * opportunityclose) in the same write. `resolution` 'posted' takes the visitor's subject and description (Resolve
 * Case); 'configured' the action's DefaultResolution and DefaultResolutionDescription (Close Case).
 */
export const NATIVE_STATE_ACTIONS = Object.freeze({
  deactivate: { type: 'DeactivateAction', button: 'DeactivateButton', label: 'Deactivate', state: 1 },
  activate: { type: 'ActivateAction', button: 'ActivateButton', label: 'Activate', state: 0 },
  'close-case': {
    source: (state) => state === 0,
    refusal: 'The case is not active.',
    type: 'CloseIncidentAction',
    table: 'incident',
    label: 'Close Case',
    state: 1,
    status: 5,
    message: 'The case has been closed.',
    close: { table: 'incidentresolution', lookup: 'incidentid', resolution: 'configured' },
  },
  'resolve-case': {
    source: (state) => state === 0,
    refusal: 'The case is not active.',
    type: 'ResolveCaseAction',
    table: 'incident',
    label: 'Resolve Case',
    state: 1,
    status: 5,
    message: 'The case has been resolved.',
    close: { table: 'incidentresolution', lookup: 'incidentid', resolution: 'posted' },
  },
  'reopen-case': {
    source: (state) => state !== 0,
    refusal: 'The case is already active.',
    type: 'ReopenCaseAction',
    table: 'incident',
    label: 'Reopen Case',
    state: 0,
    message: 'The case has been reopened.',
  },
  'cancel-case': {
    source: (state) => state === 0,
    refusal: 'The case is not active.',
    type: 'CancelCaseAction',
    table: 'incident',
    label: 'Cancel Case',
    state: 2,
    message: 'The case has been canceled.',
    cancelActivities: true,
  },
  'hold-opportunity': {
    source: (state, status) => state === 0 && status !== 2,
    refusal: 'The opportunity is not open or is already on hold.',
    type: 'SetOpportunityOnHoldAction',
    table: 'opportunity',
    label: 'Set On Hold',
    state: 0,
    status: 2,
    message: 'The opportunity has been set on hold.',
  },
  'win-opportunity': {
    source: (state) => state === 0,
    refusal: 'The opportunity is not open.',
    type: 'WinOpportunityAction',
    table: 'opportunity',
    label: 'Close as Won',
    state: 1,
    status: 3,
    message: 'The opportunity has been closed as won.',
    close: { table: 'opportunityclose', lookup: 'opportunityid', subject: 'Opportunity won via Web Portal' },
  },
  'lose-opportunity': {
    source: (state) => state === 0,
    refusal: 'The opportunity is not open.',
    type: 'LoseOpportunityAction',
    table: 'opportunity',
    label: 'Close as Lost',
    state: 2,
    status: 4,
    message: 'The opportunity has been closed as lost.',
    close: { table: 'opportunityclose', lookup: 'opportunityid', subject: 'Opportunity closed as lost via Web Portal' },
  },
  // The Dynamics 365 message actions (legacy EntityActionController): each runs its Dataverse messages as the site's
  // application user after the record's Update right and, for a conversion, the Create right on the new record's table.
  'calculate-opportunity': {
    type: 'CalculateOpportunityAction',
    table: 'opportunity',
    label: 'Calculate Value',
    message: 'The opportunity value has been calculated.',
    messages: ({ recordId }) => [
      { method: 'GET', url: `CalculateActualValueOpportunity(OpportunityId='${recordId}')` },
    ],
  },
  'convert-quote': {
    source: (state) => state === 0 || state === 1,
    refusal: 'Only a draft or active quote can be converted to an order.',
    type: 'ConvertQuoteToOrderAction',
    table: 'quote',
    label: 'Create Order',
    creates: 'salesorder',
    message: 'The order has been created.',
    // The legacy service activates a quote that is not active and wins one that is not won (both read the state before
    // either step), then converts it.
    messages: ({ recordId, state, subject }) => [
      ...(state === 1 ? [] : [{ update: { statecode: 1, statuscode: 2 } }]),
      ...(state === 2
        ? []
        : [
            {
              method: 'POST',
              url: 'WinQuote',
              payload: { QuoteClose: { subject, 'quoteid@odata.bind': `/quotes(${recordId})` }, Status: -1 },
            },
          ]),
      { method: 'GET', url: `ConvertQuoteToSalesOrder(QuoteId='${recordId}')` },
    ],
    subject: 'Quote Closed from Web ',
  },
  'convert-order': {
    source: (state) => state !== 2,
    refusal: 'A canceled order cannot be converted to an invoice.',
    type: 'ConvertOrderToInvoiceAction',
    table: 'salesorder',
    label: 'Create Invoice',
    creates: 'invoice',
    message: 'The invoice has been created.',
    messages: ({ recordId }) => [{ method: 'GET', url: `ConvertSalesOrderToInvoice(SalesOrderId='${recordId}')` }],
  },
  'generate-quote': {
    source: (state) => state === 0,
    refusal: 'The opportunity is not open.',
    type: 'GenerateQuoteFromOpportunityAction',
    table: 'opportunity',
    label: 'Generate Quote',
    creates: 'quote',
    message: 'The quote has been generated.',
    messages: ({ recordId }) => [{ method: 'GET', url: `GenerateQuoteFromOpportunity(OpportunityId='${recordId}')` }],
  },
});

// A table action's record must be in the state its message accepts (the legacy grid shows each link only then, and
// CloseIncident, Win/LoseOpportunity, SetState and the conversions refuse another): refused before any write. The
// InvalidStateTransition inner code 0x8004F00E is the one Mirage's state transitions use; the native code is not captured.
const STATE_REFUSED = '0x8004F00E';
/** Throws when `row`'s state does not allow the table action `key`; actions without a rule accept any state. */
export function assertActionSource(key, row) {
  const spec = NATIVE_STATE_ACTIONS[key];
  if (!spec?.source) return;
  const value = (column) => Number(row?.[column]?.value ?? row?.[column] ?? 0);
  if (!spec.source(value('statecode'), value('statuscode')))
    throw new DataError(spec.refusal, 400, 'InvalidStateTransition', { innerCode: STATE_REFUSED });
}

/** The record action key (NATIVE_STATE_ACTIONS) of an exported Basic Form action type, or null. */
export function nativeStateActionKey(type) {
  return Object.entries(NATIVE_STATE_ACTIONS).find(([, spec]) => spec.type === type)?.[0] ?? null;
}

/** A managed table's status values are not necessarily the standard 1/2 pair. */
export function nativeActionStateValues(entity, action, context = {}) {
  const spec = NATIVE_STATE_ACTIONS[action];
  return stateValues(entity, spec?.state, spec?.status, context);
}

/** The { statecode, statuscode } of `state` with `status`, or its default status (SetState status -1), from metadata. */
export function stateValues(entity, state, fixedStatus, { metadata, store, schema } = {}) {
  const fields = metadata?.entities?.[entity]?.fields ?? {};
  const definition = (name) =>
    fields[name] ?? store?.fieldDefinition?.(entity, name) ?? schema?.fields?.find((field) => field.name === name);
  const stateField = definition('statecode'),
    statusField = definition('statuscode');
  const selected = (stateField?.states ?? stateField?.options ?? []).find((option) => Number(option.value) === state);
  const statuses = (statusField?.statuses ?? statusField?.options ?? []).filter(
    (option) => Number(option.state) === state,
  );
  let status;
  if (fixedStatus != null) status = statuses.find((option) => Number(option.value) === fixedStatus);
  else if (selected?.defaultStatus == null) status = statuses.length === 1 ? statuses[0] : null;
  else status = statuses.find((option) => Number(option.value) === Number(selected.defaultStatus));
  return selected && status ? { statecode: state, statuscode: Number(status.value) } : null;
}

const RESOLUTION_REQUIRED = {
  both: 'The Resolution and Description of Resolution fields are required.',
  subject: 'The Resolution field is required.',
  description: 'The Description of Resolution field is required.',
};
const blank = (value) => typeof value !== 'string' || !value.trim();
// DateTime.Now.ToString(CultureInfo.InvariantCulture): MM/dd/yyyy HH:mm:ss.
export const invariantNow = (now) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
};

/**
 * The close activity a table-specific action creates with its state change, as { table, values }, or null. A Resolve Case
 * without both a subject and a description is refused as the legacy service refuses it (403, before any write).
 */
export function nativeCloseActivity(key, { configured = {}, resolution = null, now = new Date() } = {}) {
  const close = NATIVE_STATE_ACTIONS[key]?.close;
  if (!close) return null;
  if (close.resolution === 'posted') {
    const subject = resolution?.subject,
      description = resolution?.description;
    let missing = null;
    if (blank(subject) && blank(description)) missing = 'both';
    else if (blank(subject)) missing = 'subject';
    else if (blank(description)) missing = 'description';
    if (missing) throw new DataError(RESOLUTION_REQUIRED[missing], 403, 'FormActionResolutionRequired');
    return { table: close.table, lookup: close.lookup, values: { subject, description } };
  }
  // Close Case: the texts the grid posts (the link's DefaultResolution), else the action's, else the legacy defaults.
  const first = (...values) => values.find((value) => !blank(value));
  if (close.resolution === 'configured')
    return {
      table: close.table,
      lookup: close.lookup,
      values: {
        subject: first(resolution?.subject, configured.DefaultResolution) ?? 'Case Closed',
        description:
          first(resolution?.description, configured.DefaultResolutionDescription) ?? 'Case Closed via Web Portal',
      },
    };
  return { table: close.table, lookup: close.lookup, values: { subject: close.subject + invariantNow(now) } };
}
