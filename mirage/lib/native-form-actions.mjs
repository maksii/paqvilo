import { portalField } from './importer.mjs';
import { settingsJson } from './native-services.mjs';
import { DataError, parseFetchXml } from './data.mjs';
import { planFetch } from './fetchxml-engine.mjs';
import { serializePermissionFetchXml } from './permission-query.mjs';
import { contextualViewFetchXml } from './platform.mjs';
import { escapeXmlAttribute } from './paging-validation.mjs';

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
    'Native record actions require a supported action type, a filter criterion and a read provider.',
    501,
    'FormActionFilterUnsupported',
  );
// A criterion that cannot be evaluated hides the action and refuses its request (403): fail closed, with the reason.
const criterionRefused = (reason) =>
  new DataError(
    `The action's filter criteria cannot be evaluated: ${reason} The action is not offered.`,
    403,
    'FormActionFilterUnsupported',
  );

/*
 * The criterion as a FetchXML document: a full <fetch>, or a bare <filter> fragment (a filter on the form table, as the
 * filter designer's criterion reads; LOCAL MODEL: the hosted evaluation of a fragment is not captured, and the legacy
 * FormConfiguration.DisableActionsBasedOnFilterCriteria parsed only a full fetch).
 */
function criterionFetchXml(filter, entity) {
  const text = filter.trim();
  if (/^<filter[\s/>]/i.test(text))
    return `<fetch><entity name="${escapeXmlAttribute(entity)}">${text}</entity></fetch>`;
  return text;
}

/** Evaluate the selected record against an exported action criterion using regular table permissions. */
function nativeFormActionQuery(filter, { entity, idColumn, recordId, identity, context }) {
  let plan;
  try {
    const bound = contextualViewFetchXml(criterionFetchXml(filter, entity), { ...context, identity });
    plan = planFetch(parseFetchXml(bound));
  } catch (error) {
    throw criterionRefused(`it is not a valid FetchXML query or filter (${error.message}).`);
  }
  const { fetch, root, links, aggregate } = plan;
  const aggregates = [root, ...links].some((node) =>
    node.children.some(
      ({ name, attrs }) =>
        name === 'attribute' && (attrs.aggregate || attrs.rowaggregate || attrs.dategrouping || attrs.groupby),
    ),
  );
  // An aggregate criterion has no per-record answer locally: the hosted evaluation of one is not captured, and the legacy
  // evaluator dropped its attributes but kept the aggregate query (LOCAL MODEL: refused).
  if (aggregate || aggregates)
    throw criterionRefused('an aggregate or grouped FetchXML criterion has no per-record result (not captured).');
  if (root.attrs.name.toLowerCase() !== entity.toLowerCase())
    throw criterionRefused(`it queries ${root.attrs.name}, not the form table ${entity}.`);
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
  if (typeof filter !== 'string') throw criterionRefused('it is not a FetchXML string.');
  // Live mode evaluates through the live read provider (the connected portal's Web API), as local mode through the store.
  if (scope.available === false || typeof scope.readProvider?.fetchXml !== 'function') throw filterUnsupported();
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
  // ReopenOpportunity: open with In Progress (1) for a partner-created opportunity, else the partner portal's Accepted
  // status (100000003, OpportunityStatusCode in the legacy CoreDataAdapter); a table without that status reason refuses.
  'reopen-opportunity': {
    source: (state) => state !== 0,
    refusal: 'The opportunity is already open.',
    type: 'ReopenOpportunityAction',
    table: 'opportunity',
    label: 'Reopen',
    state: 0,
    status: (row) => (row?.adx_partnercreated === true ? 1 : 100000003),
    message: 'The opportunity has been reopened.',
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
  // ActivateQuote: SetState Active (1), In Progress (2) (QuoteState/QuoteStatusCode of the legacy CoreDataAdapter).
  'activate-quote': {
    source: (state) => state === 0,
    refusal: 'Only a draft quote can be activated.',
    type: 'ActivateQuoteAction',
    table: 'quote',
    label: 'Activate Quote',
    state: 1,
    status: 2,
    message: 'The quote has been activated.',
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
  // QualifyLead: the legacy EntityActionController checks Write on the lead and Create on contact, account and opportunity,
  // and its CoreDataAdapter qualifies with every record created, the "US Dollar" currency (else the first currency) and
  // the Qualified status (3), whatever the dialog posts.
  'qualify-lead': {
    source: (state) => state === 0,
    refusal: 'The lead is not open.',
    type: 'QualifyLeadAction',
    table: 'lead',
    label: 'Qualify',
    creates: ['contact', 'account', 'opportunity'],
    message: 'The lead has been qualified.',
    messages: ({ recordId, currencyId }) => [
      {
        method: 'POST',
        url: `leads(${recordId})/Microsoft.Dynamics.CRM.QualifyLead`,
        payload: {
          CreateAccount: true,
          CreateContact: true,
          CreateOpportunity: true,
          ...(currencyId
            ? {
                OpportunityCurrencyId: {
                  '@odata.type': 'Microsoft.Dynamics.CRM.transactioncurrency',
                  transactioncurrencyid: currencyId,
                },
              }
            : {}),
          Status: 3,
        },
      },
    ],
    currency: true,
  },
  // UpdatePipelinePhase (legacy EntityActionController.UpdatePipelinePhase): the dialog posts a Sales Stage option, its
  // label as the step name and a description; the opportunity takes stepname and salesstage, and a note on it records
  // "Updated Pipeline Phase: <step name>" with the description as its text. The legacy link shows only on an open one.
  'update-pipeline-phase': {
    source: (state) => state === 0,
    refusal: 'The opportunity is not open.',
    type: 'UpdatePipelinePhaseAction',
    table: 'opportunity',
    label: 'Update Pipeline Phase',
    message: 'The pipeline phase has been updated.',
    pipeline: true,
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

/** The opportunity's Sales Stage options ({ value, label }) for the Update Pipeline Phase dialog, from metadata. */
export function pipelinePhaseOptions(entity, { metadata, store, schema } = {}) {
  const field =
    metadata?.entities?.[entity]?.fields?.salesstage ??
    store?.fieldDefinition?.(entity, 'salesstage') ??
    schema?.fields?.find((item) => item.name === 'salesstage');
  return (field?.options ?? [])
    .map((option) => ({
      value: Number(option.value),
      label: String(
        option.label ?? option.labels?.[1033] ?? Object.values(option.labels ?? {})[0] ?? option.value ?? '',
      ),
    }))
    .filter((option) => Number.isSafeInteger(option.value));
}

// The note's text column (annotation.notetext) holds at most 100,000 characters (Learn annotation table reference), as
// the notes dialog's textarea limits it.
const PIPELINE_DESCRIPTION_MAX = 100_000;
const pipelineRefused = (message) => new DataError(message, 400, 'FormActionPipelinePhaseInvalid');
// A posted Sales Stage: an integer, or the decimal digits of one (the select posts its option value as text).
function postedStage(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * The posted pipeline phase ({ salesStage, description }) as the writes the legacy action makes: the step name is the
 * option's label (the dialog posts the selected option's text). A missing, empty or non-integer stage, one that is not
 * an option, and a missing, blank or too long description (the dialog marks it required) are refused before any write.
 */
export function pipelinePhaseWrites(entity, posted, context = {}) {
  const stage = postedStage(posted?.salesStage);
  const option = stage == null ? null : pipelinePhaseOptions(entity, context).find((item) => item.value === stage);
  if (!option) throw pipelineRefused("The pipeline phase must be one of the opportunity's Sales Stage options.");
  const description = posted?.description;
  if (typeof description !== 'string' || !description.trim())
    throw pipelineRefused('The Description of Update field is required.');
  if (description.length > PIPELINE_DESCRIPTION_MAX)
    throw pipelineRefused(
      `The Description of Update exceeds the maximum length of ${PIPELINE_DESCRIPTION_MAX.toLocaleString('en-US')} characters.`,
    );
  return {
    update: { stepname: option.label, salesstage: option.value },
    note: { subject: `Updated Pipeline Phase: ${option.label}`, notetext: description },
  };
}

/** The record action key (NATIVE_STATE_ACTIONS) of an exported Basic Form action type, or null. */
export function nativeStateActionKey(type) {
  return Object.entries(NATIVE_STATE_ACTIONS).find(([, spec]) => spec.type === type)?.[0] ?? null;
}

/** A managed table's status values are not necessarily the standard 1/2 pair. `context.row`: the record a status rule reads. */
export function nativeActionStateValues(entity, action, context = {}) {
  const spec = NATIVE_STATE_ACTIONS[action];
  const status = typeof spec?.status === 'function' ? spec.status(context.row) : spec?.status;
  return stateValues(entity, spec?.state, status, context);
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
