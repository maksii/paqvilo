import { organizationRecord } from './organization-context.mjs';
import { currentRequest } from './request-context.mjs';
import { systemClock, systemIds } from './runtime-clock.mjs';

const MESSAGE_BLOCK_LIMIT = 10240;
// The platform frames a fault row's exceptiondetails end with (native traceFaults: identical in every fault row of both captures).
const FAULT_FRAME_SUFFIX = [
  'at Microsoft.Xrm.RemotePlugin.Grpc.SandboxFabricGrpcClient.ExecutePluginInternal(IRemotePluginRequest pluginRequest, ExecuteRequest executeRequest, Guid executionId, ISandboxFabricDuplexCommunicationHandler communicationHandler, Boolean returnTraceInfo, Guid organizationId, SandboxFabricCallTracker sandboxFabricCallTracker) +0x5d7',
  'at Microsoft.Xrm.RemotePlugin.Grpc.SandboxFabricGrpcClient.ExecutePlugin(IRemotePluginRequest pluginRequest, IPluginExecutionContext executionContext, IPluginTracingService pluginTracingService, ISandboxFabricDuplexCommunicationHandler communicationHandler, ISet`1 earlySerializedPropertiesList, SandboxFabricCallTracker sandboxFabricCallTracker, ISandboxMemoryStreamProvider memoryStreamProvider) +0x327',
  'at Microsoft.Xrm.RemotePlugin.Grpc.SandboxFabricCodeUnit.ExecutePlugin(ILifetimeScope scope, IExecutionContext context, ISandboxFabricDuplexCommunicationHandler communicationHandler, ISandboxClientSettings sandboxClientSettings, SandboxFabricCallTracker& sandboxFabricCallTracker, ISandboxFabricGrpcClient sandboxFabricGrpcClient, ISandboxMemoryStreamProvider memoryStreamProvider) +0x16',
  'at Microsoft.Xrm.RemotePlugin.Grpc.SandboxFabricCodeUnit.Execute(ILifetimeScope scope, IExecutionContext context, SandboxFabricCallTracker& sandboxFabricCallTracker, ISandboxMemoryStreamProvider memoryStreamProvider) +0x107',
  'at Castle.Proxies.Invocations.ISandboxFabricCodeUnit_Execute.InvokeMethodOnTarget() +0x13',
  'at Castle.DynamicProxy.AbstractInvocation.Proceed() +0x2d',
  'at Microsoft.Xrm.RemotePlugin.Client.Interceptors.SandboxFabricPluginTraceInterceptor.Intercept(IInvocation invocation, IExecutionContext context, SandboxFabricCallTracker sandboxFabricCallTracker) +0x1f',
]
  .map((frame) => `\r\n${frame}`)
  .join('');
const lookupKey = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();

/** The native typename is assembly-qualified: '<TypeName>, <AssemblyName>, Version=<version>, Culture=<culture>, PublicKeyToken=<token>'.
 * Without an assembly row the names the caller knows are kept. */
export function qualifiedTypeName(store, { typeName, assemblyId, assemblyName } = {}) {
  if (!typeName) return typeName ?? null;
  const rows = store?.state?.tables?.pluginassembly ?? [];
  const row =
    rows.find((value) => assemblyId && lookupKey(value.pluginassemblyid) === lookupKey(assemblyId)) ??
    rows.find((value) => assemblyName && value.name === assemblyName);
  if (!row) return assemblyName ? `${typeName}, ${assemblyName}` : typeName;
  return `${typeName}, ${row.name}, Version=${row.version ?? 'null'}, Culture=${row.culture ?? 'neutral'}, PublicKeyToken=${row.publickeytoken ?? 'null'}`;
}

/** PluginTraceLog is diagnostic evidence and survives the business transaction. */
export function recordPluginTrace(
  store,
  {
    typeName,
    stepId,
    messageName,
    entity,
    depth,
    mode = 0,
    traces,
    started,
    startedAt,
    error,
    correlationId,
    requestId,
    configuration,
    secureConfiguration,
    constructorDuration,
  },
) {
  const level = Number(organizationRecord(store)?.plugintracelogsetting ?? 0);
  if (!store?.state?.mappings?.plugintracelog || level === 0 || (level === 1 && !error)) return;
  store.appendPluginTraceLog({
    plugintracelogid: (store.ids ?? systemIds).uuid(),
    typename: typeName ?? null,
    messagename: messageName,
    primaryentity: entity,
    // Native traceFaults (two captures): the step's Trace calls are joined with CRLF and the LAST 10240 characters are kept.
    messageblock: traces.length ? traces.join('\r\n').slice(-MESSAGE_BLOCK_LIMIT) : null,
    // A fault row names the OrganizationServiceFault it surfaced as, then the platform frames; a success row is ''.
    exceptiondetails: !error
      ? ''
      : error.details?.innerCode === '0x80040265'
        ? `System.ServiceModel.FaultException\`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]: ${error.message}${FAULT_FRAME_SUFFIX}`
        : String(error.message ?? error),
    depth,
    mode,
    operationtype: 1,
    pluginstepid: stepId ? { id: stepId, logical_name: 'sdkmessageprocessingstep' } : null,
    performanceexecutionduration: Math.round(performance.now() - started),
    performanceexecutionstarttime: startedAt,
    performanceconstructorduration: constructorDuration ?? 0,
    // Native traceFaults: the CorrelationId of the step's execution context; the request's correlation only without one.
    correlationid: correlationId ?? currentRequest()?.correlationId ?? store.flowChain?.id ?? null,
    requestid: requestId ?? null,
    configuration: configuration ?? null,
    secureconfiguration: secureConfiguration ?? null,
    createdon: new Date((store.clock ?? systemClock).now()).toISOString(),
  });
}
