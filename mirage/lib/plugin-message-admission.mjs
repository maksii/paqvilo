import { DataError } from './data-error.mjs';
import { pluginStepBypassed } from './plugin-bypass.mjs';

const messages = new Set([
  'create',
  'update',
  'delete',
  'retrieve',
  'retrievemultiple',
  'createmultiple',
  'updatemultiple',
  'associate',
  'disassociate',
]);
// Named platform messages with their own local pipeline (plugin-platform-messages.mjs): issued by a plug-in through the
// SDK, an Update setting statecode (SetStateDynamicEntity) and Web API DeleteMultiple on a standard table (PreValidation
// before the native refusal), and RetrieveExchangeRate, which a Create writing a money value issues at internal stage 25.
// Their other entry points (SOAP, Web API actions) still refuse their steps.
const PLATFORM_MESSAGES = new Set([
  'retrieveexchangerate',
  'assign',
  'setstatedynamicentity',
  'grantaccess',
  'modifyaccess',
  'revokeaccess',
  'retrieveprincipalaccess',
  'retrievesharedprincipalsandaccess',
  'deletemultiple',
]);
// Native accepts steps on these messages but never executes them: the platform runs Upsert as Create/Update,
// UpsertMultiple as CreateMultiple/UpdateMultiple and SetState as SetStateDynamicEntity (recorded native corpus).
const NEVER_EXECUTED_MESSAGES = new Set(['upsert', 'upsertmultiple', 'setstate']);

// Registrations the platform accepts but never executes: unfiltered steps on Upsert, UpsertMultiple and Merge, and
// asynchronous Retrieve steps (native recordings show no execution while those messages ran). They are admitted and
// silently match nothing, never a refusal native would not produce.
export function pluginStepInert(step) {
  const name = String(step.message).toLowerCase();
  return (
    (step.unfiltered === true && ['upsert', 'upsertmultiple', 'merge'].includes(name)) ||
    (name === 'retrieve' && (step.contract?.mode ?? step.mode) === 1)
  );
}

export function pluginMessageHasPipeline(step) {
  const name = String(step.message).toLowerCase();
  return Boolean(
    step.customApi ||
    messages.has(name) ||
    PLATFORM_MESSAGES.has(name) ||
    NEVER_EXECUTED_MESSAGES.has(name) ||
    /^onexternal(created|updated|deleted)$/.test(name),
  );
}

// Record-backed simulations of named platform messages do not execute those
// messages' registered plug-ins. Never silently skip an explicitly chosen step
// while applying the underlying writes. This is an admission failure, not a
// substitute implementation of the missing native message pipeline.
export function assertPluginMessageAdmission(store, message, context = {}, entity) {
  const name = String(message).toLowerCase();
  if (NEVER_EXECUTED_MESSAGES.has(name)) return;
  const pipeline = store?.pluginPipeline;
  const candidates = (pipeline?.steps?.() ?? []).filter(
    (item) =>
      item.enabled &&
      item.contract?.supportedDeployment !== 1 &&
      !['placeholder', 'disabled'].includes(item.mode) &&
      String(item.message).toLowerCase() === name &&
      !item.customApi &&
      !messages.has(name) &&
      !/^onexternal(created|updated|deleted)$/.test(name) &&
      !pluginStepInert(item),
  );
  if (!candidates.length) return;
  const target =
    context.body?.Target ?? context.body?.EntityMoniker ?? context.params?.Target ?? context.params?.EntityMoniker;
  const type = target?.logicalName ?? target?.LogicalName ?? target?.['@odata.type'];
  const requestedEntity =
    entity ??
    context.target?.mapping?.logicalName ??
    context.mapping?.logicalName ??
    (type == null ? null : String(type).replace(/^#?Microsoft\.Dynamics\.CRM\./, ''));
  const logical =
    requestedEntity == null || requestedEntity === 'none'
      ? (requestedEntity ?? null)
      : (store?.resolveMapping?.(requestedEntity)?.logicalName ?? requestedEntity);
  const step = candidates.find(
    (item) =>
      (logical == null || item.entity == null || item.entity === 'none' || item.entity === logical) &&
      !pluginStepBypassed(
        item,
        {
          bypassCustomPlugins:
            (item.contract?.mode === 1 ? context.bypassCustomAsync : context.bypassCustomPlugins) === true,
          bypassStepIds: context.bypassStepIds ?? [],
        },
        pipeline.diagnostic,
      ),
  );
  if (!step) return;
  const details = {
    stepId: step.id,
    messageName: message,
    entity: logical,
    bindingQualification: logical == null ? 'request-table-unresolved' : 'request-table-resolved',
  };
  pipeline.diagnostic?.({ code: 'PLUGIN_MESSAGE_PIPELINE_UNAVAILABLE', severity: 'error', ...details });
  throw new DataError(
    `The ${message} plug-in pipeline is not implemented. Configured step ${step.id} cannot be skipped.${logical == null ? ' The request table binding is unresolved.' : ''}`,
    501,
    'LocalPluginUnsupported',
    details,
  );
}
