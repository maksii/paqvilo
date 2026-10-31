import { organizationRecord } from './organization-context.mjs';
import { currentRequest } from './request-context.mjs';
import { systemClock, systemIds } from './runtime-clock.mjs';

const MESSAGE_BLOCK_LIMIT = 10240;

/** PluginTraceLog is diagnostic evidence and survives the business transaction. */
export function recordPluginTrace(
  store,
  { typeName, stepId, messageName, entity, depth, mode = 0, traces, started, startedAt, error },
) {
  const level = Number(organizationRecord(store)?.plugintracelogsetting ?? 0);
  if (!store?.state?.mappings?.plugintracelog || level === 0 || (level === 1 && !error)) return;
  store.appendPluginTraceLog({
    plugintracelogid: (store.ids ?? systemIds).uuid(),
    typename: typeName ?? null,
    messagename: messageName,
    primaryentity: entity,
    // Native traceFaults (two captures): messageblock keeps the first 10240 characters; a plug-in fault's details name the
    // OrganizationServiceFault it surfaced as (the native stack frames are not reproduced).
    messageblock: traces.length ? traces.join('\n').slice(0, MESSAGE_BLOCK_LIMIT) : null,
    exceptiondetails: error
      ? error.details?.innerCode === '0x80040265'
        ? `System.ServiceModel.FaultException\`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]: ${error.message}`
        : String(error.message ?? error)
      : null,
    depth,
    mode,
    operationtype: 1,
    pluginstepid: stepId ? { id: stepId, logical_name: 'sdkmessageprocessingstep' } : null,
    performanceexecutionduration: Math.round(performance.now() - started),
    performanceexecutionstarttime: startedAt,
    correlationid: currentRequest()?.correlationId ?? store.flowChain?.id ?? null,
    createdon: new Date((store.clock ?? systemClock).now()).toISOString(),
  });
}
