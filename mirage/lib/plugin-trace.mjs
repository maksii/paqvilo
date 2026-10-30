import { organizationRecord } from './organization-context.mjs';
import { currentRequest } from './request-context.mjs';
import { systemClock, systemIds } from './runtime-clock.mjs';

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
    messageblock: traces.length ? traces.join('\n') : null,
    exceptiondetails: error ? String(error.message ?? error) : null,
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
