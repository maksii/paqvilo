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
// Native accepts steps on these messages but never executes them: the platform runs Upsert as Create/Update,
// UpsertMultiple as CreateMultiple/UpdateMultiple and SetState as SetStateDynamicEntity (recorded native corpus).
const NEVER_EXECUTED_MESSAGES = new Set(['upsert', 'upsertmultiple', 'setstate']);

// Registrations the platform accepts but never executes: unfiltered steps on Upsert and UpsertMultiple (native
// recordings show no execution while those messages ran). They are admitted and silently match nothing, never a refusal
// native would not produce. Global Merge steps run on a mergeable table (recorded native mergeAccount; Merge refuses
// other tables before any step) and asynchronous Retrieve steps once the read commits (recorded native readAsync).
export function pluginStepInert(step) {
  const name = String(step.message).toLowerCase();
  return step.unfiltered === true && ['upsert', 'upsertmultiple'].includes(name);
}

// Every other named message runs a generic pipeline at the entry points that perform it (Web API actions and functions,
// the SOAP requests relayed to them, Web API sharing and Merge, SOAP Assign: plugin-platform-messages.mjs
// runEntryMessage). A message no local entry point performs never fires, so its step never runs.
export function pluginMessageHasPipeline(step) {
  return Boolean(step.customApi || String(step.message ?? '').trim());
}

// Record-backed simulations of named platform messages do not execute those
// messages' registered plug-ins. Never silently skip an explicitly chosen step
// while applying the underlying writes. This is an admission failure, not a
// substitute implementation of the missing native message pipeline.
export function assertPluginMessageAdmission(store, message, context = {}, entity) {
  const selected = pluginEntryStep(store, message, context, entity, { resolved: true });
  if (!selected) return;
  const { step, logical } = selected,
    pipeline = store.pluginPipeline;
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

/**
 * The registered step a named message's entry point would execute for the request (context: request body/params,
 * bypass choices; entity: the request table), or null: enabled, server-deployed, not inert, not a record, custom API or
 * never-executed message. resolved: answer { step, logical } with the canonical table.
 */
export function pluginEntryStep(store, message, context = {}, entity, { resolved = false } = {}) {
  const name = String(message).toLowerCase();
  if (NEVER_EXECUTED_MESSAGES.has(name)) return null;
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
  if (!candidates.length) return null;
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
  if (!step) return null;
  return resolved ? { step, logical } : step;
}
