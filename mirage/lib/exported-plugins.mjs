import { cloneStateData } from './state-clone.mjs';
import { organizationRecord } from './organization-context.mjs';
import { currentRequest } from './request-context.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { createHash } from 'node:crypto';
import { systemClock, systemIds } from './runtime-clock.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DataError } from './data-error.mjs';
import { parseSolutionXml } from './solution-xml.mjs';
import {
  clrContext,
  enterPluginExecution,
  executeClrPlugin,
  leavePluginExecution,
  pluginExecutionDepth,
} from './plugin-clr.mjs';
import { sdkValueToRecord } from './local-organization-service.mjs';
import { populatePluginSystemOutputs } from './plugin-response.mjs';
import { pluginFailure } from './plugin-fault.mjs';
const executionFrames = new WeakMap();
// The message name a plug-in sees for an operation (IPluginExecutionContext.MessageName).
export const messageNameOf = (operation) =>
  ({
    retrievemultiple: 'RetrieveMultiple',
    createmultiple: 'CreateMultiple',
    updatemultiple: 'UpdateMultiple',
    onexternalcreated: 'OnExternalCreated',
    onexternalupdated: 'OnExternalUpdated',
    onexternaldeleted: 'OnExternalDeleted',
  })[operation] ?? operation[0].toUpperCase() + operation.slice(1);

const canonical = (value) =>
  String(value ?? '')
    .trim()
    .replace(/[{}]/g, '')
    .toLowerCase();
const nodes = (node, name) => {
  if (!node) return [];
  return [
    ...(node.name?.toLowerCase() === name.toLowerCase() ? [node] : []),
    ...(node.children ?? []).flatMap((child) => nodes(child, name)),
  ];
};
const child = (node, name) => node?.children?.find((item) => item.name.toLowerCase() === name.toLowerCase());
const attr = (node, name) =>
  node?.attrs?.[Object.keys(node.attrs ?? {}).find((key) => key.toLowerCase() === name.toLowerCase())];
const text = (node, name) => child(node, name)?.text.trim();
const value = (node, name) => text(node, name) || attr(node, name);
const lookupId = (node, name) => canonical(value(node, name) || text(child(node, name), name));
const lookupName = (node, name) => text(child(node, name), 'Name');
const numeric = (value) =>
  value === undefined || value === '' ? null : Number.isInteger(Number(value)) ? Number(value) : null;
const error = (message, code = 'LocalPluginInvalid', status = 400) => new DataError(message, status, code);
const stages = { 10: 'PreValidation', 20: 'PreOperation', 40: 'PostOperation' };

/** Facts only. Configuration values are not indexed or exposed; DLLs and .NET code are never read or executed. */
export function parsePluginDocument(xml) {
  const root = parseSolutionXml(xml);
  const assemblies = [],
    types = [],
    steps = [],
    messages = [];
  for (const message of nodes(root, 'SdkMessage')) {
    const id = canonical(value(message, 'SdkMessageId')),
      name = value(message, 'Name');
    if (id && name) messages.push({ id, name });
  }
  for (const assembly of nodes(root, 'PluginAssembly')) {
    const id = canonical(value(assembly, 'PluginAssemblyId'));
    if (!id) continue;
    const fullName = value(assembly, 'FullName') ?? null;
    assemblies.push({
      id,
      name: value(assembly, 'Name') ?? fullName?.split(',')[0].trim() ?? '',
      fullName,
      version: value(assembly, 'Version') ?? /(?:^|,)\s*Version=([^,]+)/i.exec(fullName ?? '')?.[1] ?? null,
      isolationMode: numeric(value(assembly, 'IsolationMode')),
      sourceType: numeric(value(assembly, 'SourceType')),
      binaryPath: value(assembly, 'FileName') ?? null,
    });
    for (const type of nodes(assembly, 'PluginType')) {
      const typeId = canonical(value(type, 'PluginTypeId'));
      if (typeId)
        types.push({
          id: typeId,
          assemblyId: id,
          name: value(type, 'TypeName') || value(type, 'Name') || '',
          friendlyName: value(type, 'FriendlyName') ?? null,
        });
    }
  }
  for (const type of nodes(root, 'PluginType')) {
    const id = canonical(value(type, 'PluginTypeId'));
    if (id && !types.some((item) => item.id === id))
      types.push({
        id,
        assemblyId: lookupId(type, 'PluginAssemblyId') || null,
        name: value(type, 'TypeName') || value(type, 'Name') || '',
        friendlyName: value(type, 'FriendlyName') ?? null,
      });
  }
  for (const step of nodes(root, 'SdkMessageProcessingStep')) {
    const id = canonical(value(step, 'SdkMessageProcessingStepId'));
    if (!id) continue;
    const filter = child(step, 'SdkMessageFilterId');
    const primary = canonical(
      value(step, 'PrimaryEntity') ||
        value(step, 'PrimaryEntityName') ||
        value(step, 'PrimaryEntityTypeCode') ||
        value(step, 'PrimaryObjectTypeCode') ||
        value(filter, 'PrimaryObjectTypeCode'),
    );
    const messageFilterId = lookupId(step, 'SdkMessageFilterId') || null;
    const unfiltered =
      (primary === 'none' ||
        Boolean(filter && !messageFilterId && !(filter.text ?? '').trim() && !filter.children?.length)) &&
      !messageFilterId;
    // EventHandler is polymorphic (sdkmessageprocessingstep.eventhandler targets plugintype or serviceendpoint). A service
    // endpoint handler is named by ServiceEndpointId or by EventHandlerTypeCode 4618 (serviceendpoint); an EventHandler with no
    // plug-in type facts is resolved by importSolutionPlugins. The exported element names of a service endpoint step are a guess.
    const handlerType = String(value(step, 'EventHandlerTypeCode') ?? '')
      .trim()
      .toLowerCase();
    const handlerId = lookupId(step, 'EventHandler') || null;
    const serviceEndpointId =
      lookupId(step, 'ServiceEndpointId') ||
      (['4618', 'serviceendpoint'].includes(handlerType) ? handlerId : null) ||
      null;
    steps.push({
      id,
      name: value(step, 'Name') || id,
      typeId: lookupId(step, 'PluginTypeId') || (serviceEndpointId ? null : handlerId),
      serviceEndpointId,
      eventHandlerOnly:
        !serviceEndpointId &&
        !lookupId(step, 'PluginTypeId') &&
        !value(step, 'PluginTypeName') &&
        !lookupName(step, 'EventHandler') &&
        !['4602', 'plugintype'].includes(handlerType) &&
        Boolean(handlerId),
      typeName:
        value(step, 'PluginTypeName') || lookupName(step, 'PluginTypeId') || lookupName(step, 'EventHandler') || null,
      messageId: lookupId(step, 'SdkMessageId') || null,
      message: value(step, 'SdkMessageName') || lookupName(step, 'SdkMessageId') || value(step, 'MessageName') || null,
      entity: primary && primary !== 'none' ? primary : null,
      messageFilterId,
      unfiltered,
      stage: numeric(value(step, 'Stage')),
      rank: numeric(value(step, 'Rank')),
      mode: numeric(value(step, 'Mode')),
      supportedDeployment: numeric(value(step, 'SupportedDeployment')),
      enabled: numeric(value(step, 'StateCode') ?? '0') === 0,
      filteringAttributes: String(value(step, 'FilteringAttributes') ?? '')
        .split(',')
        .map(canonical)
        .filter(Boolean),
      impersonatingUserId: lookupId(step, 'ImpersonatingUserId') || null,
      images: nodes(step, 'SdkMessageProcessingStepImage').map((image) => ({
        name: value(image, 'Name') || '',
        alias: value(image, 'EntityAlias') || '',
        type: numeric(value(image, 'ImageType')),
        attributes: String(value(image, 'Attributes') ?? '')
          .split(',')
          .map(canonical)
          .filter(Boolean),
      })),
    });
  }
  return { assemblies, types, steps, messages };
}

/**
 * Well-known SDK message ids: the platform ships the sdkmessage rows, so these ids are the same
 * in every Dataverse organisation. A project's observed.sdkMessages adds or overrides entries for
 * messages not listed here.
 */
export const SDK_MESSAGES = Object.freeze({
  '9ebdbb1b-ea3e-db11-86a7-000a3a5473e8': 'Create',
  '20bebb1b-ea3e-db11-86a7-000a3a5473e8': 'Update',
  'a1bdbb1b-ea3e-db11-86a7-000a3a5473e8': 'Delete',
  'f2bdbb1b-ea3e-db11-86a7-000a3a5473e8': 'Retrieve',
  '03bebb1b-ea3e-db11-86a7-000a3a5473e8': 'RetrieveMultiple',
});

/** Selected solution layer order wins, with explicit provenance and no inferred deployed state. */
export function importSolutionPlugins(layers = [], { sdkMessages = {} } = {}) {
  const maps = { assemblies: new Map(), types: new Map(), steps: new Map(), messages: new Map() };
  const diagnostics = [],
    fingerprint = createHash('sha256');
  for (const layer of layers)
    for (const document of layer.documents ?? []) {
      const facts = document.facts.plugins;
      if (!facts) continue;
      fingerprint.update(document.file).update(document.hash ?? '');
      for (const kind of Object.keys(maps))
        for (const record of facts[kind] ?? []) {
          if (maps[kind].has(record.id))
            diagnostics.push({
              code: 'PLUGIN_SOURCE_LAYER_SELECTED',
              id: record.id,
              sourceFile: document.file,
              message: 'The last selected solution layer supplies this registration; deployed state is unknown.',
            });
          maps[kind].set(record.id, { ...record, sourceFile: document.file });
        }
    }
  const steps = [...maps.steps.values()].map((exported) => {
    const namedTypes = [...maps.types.values()].filter((item) => exported.typeName && item.name === exported.typeName);
    const type = maps.types.get(exported.typeId) ?? (namedTypes.length === 1 ? namedTypes[0] : null);
    // A bare EventHandler that names no exported plug-in type of the selected layers is resolved against the organization's
    // rows (overlayRegisteredSteps: a serviceendpoint row makes it a service endpoint step, a plugintype row a plug-in step).
    // Until then it is unsupported "handler unresolved", so a missing dependency never runs as a silent pass.
    const { eventHandlerOnly, ...step } =
      !type && exported.eventHandlerOnly ? { ...exported, eventHandlerId: exported.typeId, typeId: null } : exported;
    const assembly = type && maps.assemblies.get(type.assemblyId);
    const sourceMessage = maps.messages.get(step.messageId);
    const observedMessage =
      sdkMessages[step.messageId] ??
      (SDK_MESSAGES[step.messageId]
        ? { name: SDK_MESSAGES[step.messageId], evidence: 'platform SDK message id' }
        : undefined);
    const message = step.message || sourceMessage?.name || observedMessage?.name || null;
    const resolved = {
      ...step,
      message,
      messageEvidence: step.message
        ? 'exported-step'
        : sourceMessage
          ? 'exported-sdk-message'
          : observedMessage
            ? sdkMessages[step.messageId]
              ? 'project-observation'
              : 'platform-sdk-message'
            : 'unresolved',
      messageSourceFile: sourceMessage?.sourceFile ?? null,
      messageObservation: observedMessage?.evidence ?? null,
      typeName: type?.name ?? step.typeName,
      typeId: type?.id ?? step.typeId,
      assemblyId: assembly?.id ?? type?.assemblyId ?? null,
      assemblyName: assembly?.name ?? null,
      typeSourceFile: type?.sourceFile ?? null,
      assemblySourceFile: assembly?.sourceFile ?? null,
      stageName: stages[step.stage] ?? `Stage ${step.stage ?? 'unknown'}`,
    };
    return { ...resolved, unsupported: pluginUnsupported(resolved) };
  });
  // A pending EventHandler is reported where it is resolved against the organization rows (PLUGIN_STEP_UNSUPPORTED at run time).
  for (const step of steps)
    if (step.unsupported && !step.eventHandlerId)
      diagnostics.push({
        code: 'PLUGIN_STEP_UNSUPPORTED',
        stepId: step.id,
        sourceFile: step.sourceFile,
        message: step.unsupported,
      });
  fingerprint.update(JSON.stringify(sdkMessages));
  return {
    assemblies: [...maps.assemblies.values()],
    types: [...maps.types.values()],
    steps,
    diagnostics,
    fingerprint: fingerprint.digest('hex'),
  };
}

/** Resolve only an explicitly mapped, confined regular C# source file. */
export async function resolvePluginSourcePath(mapping, defaultRoot) {
  const relative = String(mapping.path ?? '').replace(/\\/g, '/');
  if (
    !relative.endsWith('.cs') ||
    path.isAbsolute(relative) ||
    relative
      .split('/')
      .some(
        (part) => !part || part === '.' || part === '..' || /^(?:\.git|\.paqvilo|node_modules|bin|obj)$/i.test(part),
      )
  )
    throw new Error('Use a relative .cs path inside the declared source root, excluding local/runtime directories.');
  if (!mapping.root && !defaultRoot) throw new Error('No trusted source root is available for this mapping.');
  const root = await fs.realpath(mapping.root ?? defaultRoot);
  const candidate = path.resolve(root, relative);
  const real = await fs.realpath(candidate);
  const bound = path.relative(root, real);
  if (!bound || bound === '..' || bound.startsWith('..' + path.sep) || path.isAbsolute(bound))
    throw new Error('The mapped C# source resolves outside its declared source root.');
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error('The mapped C# source must be a regular file of at most 1 MiB.');
  return real;
}

/** Explicit source navigation only: inspect file identity, never parse or execute C#. */
export async function resolvePluginSourceFiles(plugins, mappings = {}, defaultRoot) {
  const sourceRoots = new Set(),
    sourceFiles = new Set();
  const typeSources = new Map();
  for (const [typeName, mapping] of Object.entries(mappings)) {
    let sourceFile = null,
      issue = null;
    try {
      const real = await resolvePluginSourcePath(mapping, defaultRoot);
      if (!plugins.types.some((type) => type.name === typeName))
        throw new Error('This exact plugin type is not present in the selected solution exports.');
      sourceFile = real;
      sourceFiles.add(real);
      sourceRoots.add(path.dirname(real));
    } catch (cause) {
      issue = cause.message;
      plugins.diagnostics.push({ code: 'PLUGIN_SOURCE_UNRESOLVED', typeName, message: issue });
    }
    typeSources.set(typeName, {
      codeSourceFile: sourceFile,
      codeSourceEvidence: mapping.evidence,
      ...(issue ? { codeSourceDiagnostic: issue } : {}),
    });
  }
  plugins.types = plugins.types.map((type) => ({ ...type, ...typeSources.get(type.name) }));
  plugins.steps = plugins.steps.map((step) => ({ ...step, ...typeSources.get(step.typeName) }));
  plugins.sourceRoots = [...sourceRoots];
  plugins.sourceFiles = [...sourceFiles];
  plugins.fingerprint = createHash('sha256')
    .update(plugins.fingerprint)
    .update(JSON.stringify([...typeSources]))
    .digest('hex');
  return plugins;
}

// impersonation: a trusted type handler implements the identity (UserId) of an impersonated step.
export function pluginUnsupported(step, { images = false, impersonation = false } = {}) {
  if (![0, 1].includes(step.mode)) return 'Execution mode is missing or unsupported.';
  const external = /^onexternal(created|updated|deleted)$/.test(String(step.message).toLowerCase());
  if (external && (step.mode !== 1 || step.stage !== 40))
    return 'External virtual-table events require asynchronous PostOperation execution.';
  if (
    step.mode === 1 &&
    (step.stage !== 40 ||
      !['create', 'update', 'delete', 'onexternalcreated', 'onexternalupdated', 'onexternaldeleted'].includes(
        String(step.message).toLowerCase(),
      ))
  )
    return 'Asynchronous execution supports post-commit stage 40 CRUD and external virtual-table event registrations.';
  if (!stages[step.stage]) return 'Only synchronous stages 10, 20 and 40 are simulated.';
  if (!step.message)
    return 'The SDK message name is not exported. Add evidence-backed observed.sdkMessages or exported SDK message metadata; the step label is not used to guess behavior.';
  if (
    !external &&
    ![
      'create',
      'update',
      'delete',
      'retrieve',
      'retrievemultiple',
      'createmultiple',
      'updatemultiple',
      'associate',
      'disassociate',
    ].includes(String(step.message ?? '').toLowerCase())
  )
    return 'This message has no configured local execution pipeline.';
  if (
    step.unfiltered === true &&
    (step.entity ||
      step.messageFilterId ||
      String(step.message).toLowerCase() !== 'retrievemultiple' ||
      step.mode !== 0)
  )
    return 'Unfiltered execution requires an explicit null filter on synchronous RetrieveMultiple.';
  if (step.unfiltered !== true && (!step.entity || !/^[a-z][a-z0-9_]*$/i.test(step.entity)))
    return 'An explicit logical table binding is required.';
  if (!Number.isInteger(step.rank)) return 'An explicit execution rank is required.';
  if (![0, 2].includes(step.supportedDeployment)) return 'Server deployment is missing or unsupported.';
  if (step.impersonatingUserId && !impersonation)
    return 'Impersonated execution requires an explicit identity adapter.';
  if (step.images?.length && !images) return 'Registered pre/post images require an explicit image adapter.';
  if (images && (step.images ?? []).some((image) => ![0, 1, 2].includes(image.type) || (!image.alias && !image.name)))
    return 'Registered image type or alias is unresolved.';
  if (
    images &&
    new Set((step.images ?? []).map((image) => image.alias || image.name)).size !== (step.images ?? []).length
  )
    return 'Registered image aliases must be unique.';
  if (step.eventHandlerId && !step.serviceEndpointId && !step.assemblyId)
    return "The step's EventHandler names neither a plug-in type nor a service endpoint of the organization (handler unresolved).";
  // A web hook step (serviceEndpointId) has no plug-in type.
  if (!step.serviceEndpointId && (!step.typeName || !step.assemblyId))
    return 'The exported plugin type or assembly dependency is unresolved.';
  return null;
}

export function pluginStepMatchesEntity(step, entity) {
  return (
    step.entity === entity ||
    (step.unfiltered === true &&
      step.entity == null &&
      step.messageFilterId == null &&
      String(step.message).toLowerCase() === 'retrievemultiple' &&
      (step.contract?.mode ?? step.mode) === 0)
  );
}
// One handler per plug-in type name (pluginTypes) serves every step of that type, including steps the Dataverse API
// registered; pluginSteps handlers are keyed by canonical step id. Validation and the collision message are pack-exports.mjs'.
export function pluginHandlers(packs = []) {
  const entries = [...collectPackExport(packs, 'pluginTypes'), ...collectPackExport(packs, 'pluginSteps')];
  return new Map(entries.map(([key, { value }]) => [key, value]));
}

// Step id first, then the plug-in type name. Step ids are GUIDs and type names cannot contain a hyphen, so the keys never collide.
const handlerOf = (handlers, step) => handlers.get(step.id) ?? handlers.get(step.typeName);
// Nesting of synchronous JavaScript handlers (step id and plug-in type): a write a handler makes runs its own steps one level
// deeper (Depth). The counter is the one CLR steps use (plugin-clr.mjs pluginExecutionDepth), so a JS/CLR chain shares one
// Depth. Handlers must return synchronously, so it is balanced within one call stack. Depth past eight fails.
const HANDLER_DEPTH_LIMIT = 8;
// A plug-in type handler's exception is the InvalidPluginExecutionException fault: 0x80040265 with the SubErrorCode native sends.
const pluginFault = (cause, item) =>
  pluginFailure(
    {
      message: cause?.message ?? String(cause),
      errorCode: cause?.errorCode,
      pluginFault: 'InvalidPluginExecutionException',
    },
    { name: item.name, id: item.id, type: item.typeName, traces: [] },
    0,
  );
// The IPluginExecutionContext-like context a plug-in type handler receives: registered images keyed by alias, and the
// caller or the impersonated user as UserId. Values are copies; the handler cannot change the write through it.
function typedContext({
  item,
  store,
  entity,
  operation,
  stage,
  target,
  targets,
  record,
  previous,
  identity,
  depth,
  trace,
  changedAttributes = [],
}) {
  const idColumn = store?.resolveMapping(entity)?.idColumn;
  const images = (types, source) =>
    Object.fromEntries(
      (item.images ?? [])
        .filter((spec) => types.includes(spec.type) && source)
        .map((spec) => [
          spec.alias || spec.name,
          cloneStateData(
            spec.attributes.length
              ? Object.fromEntries(
                  spec.attributes.filter((name) => Object.hasOwn(source, name)).map((name) => [name, source[name]]),
                )
              : source,
          ),
        ]),
    );
  const initiating = identity?.systemUserId ?? identity?.id ?? null;
  return {
    MessageName: messageNameOf(operation),
    PrimaryEntityName: entity,
    PrimaryEntityId: idColumn ? (record[idColumn] ?? null) : null,
    Stage: stage,
    Mode: item.contract?.mode ?? 0,
    Depth: depth,
    InitiatingUserId: initiating,
    UserId: item.impersonatingUserId ?? initiating,
    InputParameters: [
      'create',
      'update',
      'delete',
      'onexternalcreated',
      'onexternalupdated',
      'onexternaldeleted',
    ].includes(operation)
      ? {
          Target: cloneStateData(target),
          ...(operation === 'onexternalupdated'
            ? { PreImage: cloneStateData(previous), ChangedFields: [...changedAttributes] }
            : {}),
        }
      : ['createmultiple', 'updatemultiple'].includes(operation)
        ? { Targets: cloneStateData(targets) }
        : {},
    OutputParameters: stage === 40 && operation === 'create' && idColumn ? { id: record[idColumn] } : {},
    PreEntityImages: images([0, 2], previous),
    PostEntityImages: stage === 40 && operation !== 'delete' ? images([1, 2], record) : {},
    trace,
  };
}

// plugintracelog: organization.plugintracelogsetting 1 keeps the rows of failed executions, 2 keeps every execution, 0 keeps none.
// The row is written in the phase's own transaction, so a rolled-back write takes its trace with it.
// ponytail: native keeps the trace of a rolled-back execution; this simulator does not.
function writeTraceLog(store, { item, entity, operation, depth, asyncExecution, traces, started, startedAt, error }) {
  const level = Number(organizationRecord(store)?.plugintracelogsetting ?? 0);
  if (!store?.state?.mappings?.plugintracelog || level === 0 || (level === 1 && !error)) return;
  store.insertRow('plugintracelog', (store.state.tables.plugintracelog ??= []), {
    plugintracelogid: (store.ids ?? systemIds).uuid(),
    typename: item.typeName ?? null,
    messagename: messageNameOf(operation),
    primaryentity: entity,
    messageblock: traces.length ? traces.join('\n') : null,
    exceptiondetails: error ? String(error.message ?? error) : null,
    depth,
    mode: asyncExecution ? 1 : 0,
    operationtype: 1,
    pluginstepid: { id: item.id, logical_name: 'sdkmessageprocessingstep' },
    performanceexecutionduration: Math.round(performance.now() - started),
    performanceexecutionstarttime: startedAt,
    correlationid: currentRequest()?.correlationId ?? store.flowChain?.id ?? null,
    createdon: new Date((store.clock ?? systemClock).now()).toISOString(),
  });
}

export function pluginCatalogue({
  plugins,
  handlers = new Map(),
  runtimes = new Map(),
  descriptors = new Map(),
  overrides = {},
}) {
  return (plugins?.steps ?? []).map((step) => {
    const key = `plugin-step:${step.id}`,
      configuration = overrides[key] ?? null,
      registered = handlerOf(handlers, step) !== undefined;
    const runtime = runtimes.get(step.id),
      descriptor = descriptors.get(step.id),
      unsupported = pluginUnsupported(step, {
        images: Boolean(runtime || descriptor || registered),
        impersonation: !handlers.has(step.id) && handlers.has(step.typeName),
      });
    const clrAvailable = Boolean((runtime?.descriptor ?? descriptor)?.typeName === step.typeName);
    return {
      ...step,
      unsupported,
      key,
      kind: 'plugin-step',
      registered,
      clrAvailable,
      clrPrepared: Boolean(runtime),
      clrProvenance: runtime?.provenance ?? null,
      mode: configuration?.mode ?? (step.serviceEndpointId ? 'webhook' : registered ? 'handler' : 'placeholder'),
      configuration,
      configurable: step.enabled,
      definitionAvailable: clrAvailable,
      path: null,
      contract: {
        entity: step.entity,
        message: step.message,
        stage: step.stage,
        stageName: step.stageName,
        rank: step.rank,
        mode: step.mode,
        filteringAttributes: step.filteringAttributes,
        assemblyName: step.assemblyName,
        typeName: step.typeName,
        unsupported,
        boundary:
          'Top-level PreValidation SDK requests commit independently; PreOperation/PostOperation and nested PreValidation join the caller transaction. Read observer writes require a serialized readOperation boundary and explicit backend grants; top-level read SDK writes commit independently. CLR requires an explicitly trusted original assembly and a separate project backend security profile.',
      },
    };
  });
}

function matchingPluginSteps(items, { entity, operation, stage, changedAttributes = [], asyncExecution = false }) {
  const attributes = new Set(changedAttributes.map(canonical));
  return items.filter(
    (item) =>
      item.enabled &&
      (item.contract?.mode === 1) === asyncExecution &&
      pluginStepMatchesEntity(item, entity) &&
      String(item.message).toLowerCase() === operation &&
      item.stage === stage &&
      (!['update', 'updatemultiple'].includes(operation) ||
        !item.filteringAttributes.length ||
        item.filteringAttributes.some((name) => attributes.has(name))),
  );
}

/** Handlers and CLR can make arbitrary backend writes. Mocks only change the tracked target or response. */
export function pluginPhaseRequiresCheckpoint(items, context) {
  return matchingPluginSteps(items, context).some(
    (item) => ['handler', 'clr'].includes(item.mode) && !item.unsupported,
  );
}

/** A deliberately small synchronous contract. PostOperation can reject, but cannot silently persist target changes.
 * awaitIo (the asynchronous pipeline, data.mjs createRecordAsync): a synchronous service endpoint step whose post leaves the
 * process (webhooks.send) suspends the phase, and the phase answers a promise of its frame that runs the later steps after the
 * post answered; a failed post rejects it. Without awaitIo the post runs on the synchronous I/O bridge (webhooks.sync). */
export function runPluginPhase({
  items,
  handlers,
  runtimes = new Map(),
  webhooks = null,
  store,
  entity,
  operation,
  stage,
  target,
  targets,
  previousRecords,
  records,
  associationParameters,
  record,
  previous,
  identity,
  changedAttributes = [],
  query,
  collection,
  columns,
  holder,
  portalRequest = false,
  asyncExecution = false,
  initialFrame,
  awaitIo = false,
  diagnostic = () => {},
}) {
  // A saved row can be reused by a later Delete; its previous request frame
  // must not supply shared variables, correlation or parent context to this one.
  if (stage === 10 && !asyncExecution && !['retrieve', 'retrievemultiple'].includes(operation))
    executionFrames.set(record, {});
  if (initialFrame) executionFrames.set(record, cloneStateData(initialFrame));
  const read = ['retrieve', 'retrievemultiple'].includes(operation),
    multiple = operation === 'retrievemultiple',
    bulk = ['createmultiple', 'updatemultiple'].includes(operation),
    association = ['associate', 'disassociate'].includes(operation);
  const matched = matchingPluginSteps(items, { entity, operation, stage, changedAttributes, asyncExecution }).sort(
    (a, b) => a.rank - b.rank || a.id.localeCompare(b.id),
  );
  // Mock/handler read outputs also belong to the SDK response frame. Ordinary reads
  // without an executing observer keep the plain projection path.
  if (
    stage === 40 &&
    read &&
    !asyncExecution &&
    !executionFrames.has(record) &&
    matched.some(
      (item) => ['clr', 'handler', 'mock'].includes(item.mode) && (!item.unsupported || item.mode === 'mock'),
    )
  )
    executionFrames.set(record, {});
  if (stage === 40 && store && !asyncExecution && executionFrames.has(record)) {
    const frame = executionFrames.get(record),
      primary = store.resolveMapping(entity).idColumn;
    const values =
      operation === 'create'
        ? { id: { $type: 'Guid', value: record[primary] } }
        : operation === 'createmultiple'
          ? { Ids: { $type: 'GuidArray', values: record.bulkIds.map((value) => ({ $type: 'Guid', value })) } }
          : operation === 'retrieve'
            ? { BusinessEntity: holder.entity }
            : multiple
              ? { BusinessEntityCollection: collection }
              : {};
    populatePluginSystemOutputs(frame, values);
    executionFrames.set(record, frame);
  }
  const replace = (object, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw error('Invalid plugin query/collection result.');
    for (const key of Object.keys(object)) delete object[key];
    Object.assign(object, cloneStateData(value));
  };
  const readResultChanged = () => {
    const frame = executionFrames.get(record),
      key = multiple ? 'BusinessEntityCollection' : 'BusinessEntity';
    if (frame?.outputParameters?.values && Object.hasOwn(frame.outputParameters.values, key))
      frame.outputParameters.values[key] = multiple ? collection : holder.entity;
  };
  // The steps from index `from` on; an awaited post returns the promise of the rest (see awaitIo above).
  const run = (from) => {
    for (let index = from; index < matched.length; index++) {
      const item = matched[index];
      const note = (code, message) =>
        diagnostic({
          code,
          severity: code === 'PLUGIN_STEP_REJECTED' ? 'error' : code === 'PLUGIN_STEP_SIMULATED' ? 'info' : 'warning',
          stepId: item.id,
          name: item.name,
          entity,
          operation,
          stage,
          sourceFile: item.sourceFile,
          message,
        });
      if (item.mode === 'disabled') {
        note('PLUGIN_STEP_DISABLED', 'This step is explicitly disabled in local simulator configuration.');
        continue;
      }
      if (item.mode === 'mock') {
        if ((item.configuration?.status ?? 200) >= 400 || item.configuration?.body?.error) {
          const message = item.configuration?.body?.error?.message || 'Explicit plugin mock rejected.';
          note('PLUGIN_STEP_REJECTED', message);
          throw error(message, 'PluginValidation');
        }
        if (item.unsupported)
          note(
            'PLUGIN_STEP_SIMULATED',
            'Explicit mock chosen for an unsupported source execution contract; original logic was not executed.',
          );
      }
      if (item.unsupported && item.mode !== 'mock') {
        note('PLUGIN_STEP_UNSUPPORTED', item.unsupported);
        if (['clr', 'handler'].includes(item.mode)) throw error(item.unsupported, 'LocalPluginUnsupported', 501);
        continue;
      }
      // A synchronous web hook posts its context and fails the operation (rolled back) unless the endpoint answers 2xx.
      // Asynchronous web hooks are delivered by plugin-async.mjs after commit.
      if (item.mode === 'webhook') {
        if (!webhooks) throw error('No webhook delivery adapter is configured.', 'LocalPluginUnsupported', 501);
        const facts = {
          item,
          entity,
          operation,
          stage,
          target,
          targets,
          record,
          previous,
          identity,
          changedAttributes,
          depth: pluginExecutionDepth() + 1,
          correlationId: store?.flowChain?.id ?? currentRequest()?.correlationId ?? (store?.ids ?? systemIds).uuid(),
          diagnostic,
        };
        let pending;
        try {
          pending = awaitIo && webhooks.send ? webhooks.send(facts) : webhooks.sync(facts);
        } catch (cause) {
          note('PLUGIN_STEP_REJECTED', cause.message);
          throw cause;
        }
        if (typeof pending?.then === 'function')
          return pending.then(
            () => run(index + 1),
            (cause) => {
              note('PLUGIN_STEP_REJECTED', cause.message);
              throw cause;
            },
          );
        continue;
      }
      if (item.mode === 'placeholder') {
        note(
          'PLUGIN_STEP_PLACEHOLDER',
          'This exported registration was discovered. Its business logic was skipped; configure a local mock or trusted handler.',
        );
        continue;
      }
      let output,
        typed = false,
        nested = false,
        handlerDepth = 0;
      store?.counters?.increment('plugins.executions');
      // The trace lines of a handler or CLR run, and its timing for plugintracelog. executed: such a run started.
      const traces = [],
        trace = (text) => traces.push(String(text));
      let executed = false,
        started = 0,
        startedAt = null;
      const journal = (error) =>
        writeTraceLog(store, {
          item,
          entity,
          operation,
          depth: nested ? handlerDepth : pluginExecutionDepth() + 1,
          asyncExecution,
          traces,
          started,
          startedAt,
          error,
        });
      try {
        if (item.mode === 'clr') {
          const runtime = runtimes.get(item.id);
          if (!runtime || !item.clrAvailable || !store)
            throw error(
              'No trusted original CLR runtime is registered for this exact exported type/step.',
              'LocalPluginClrUnavailable',
              501,
            );
          let frame = executionFrames.get(record);
          if (!frame) {
            frame = {};
            executionFrames.set(record, frame);
          }
          if (!frame.sharedVariables) {
            const inherited = store.pluginParentContext?.values?.SharedVariables?.values,
              tag = store.pluginSdkTag ?? inherited?.tag;
            if (tag !== undefined) frame.sharedVariables = { $type: 'ParameterCollection', values: { tag } };
          }
          frame.portalContactId =
            portalRequest && !store.pluginParentContext && !identity?.admin
              ? (identity?.contactId ?? identity?.id ?? null)
              : null;
          frame.portalRequest = portalRequest && !store.pluginParentContext && !identity?.admin;
          if (read) {
            frame.query = query;
            frame.collection = collection;
            frame.entity = holder?.entity;
            frame.columns = columns;
          }
          if (bulk) {
            frame.targets = targets;
            frame.previousRecords = previousRecords;
            frame.records = records;
          }
          if (association) frame.associationParameters = associationParameters;
          if (operation === 'onexternalupdated')
            frame.externalEvent = { previous, changedAttributes: [...changedAttributes] };
          executed = true;
          started = performance.now();
          startedAt = new Date((store?.clock ?? systemClock).now()).toISOString();
          const depth = pluginExecutionDepth() + 1,
            context = clrContext({
              runtime,
              store,
              step: item,
              entity,
              operation,
              stage,
              target,
              record,
              previous,
              frame,
              depth,
            });
          const answer = executeClrPlugin(runtime, context, {
            store,
            diagnostic: (entry) => {
              if (entry.code === 'PLUGIN_CLR_TRACE') traces.push(String(entry.message));
              diagnostic({ ...entry, stepId: item.id, entity, operation, stage });
            },
          });
          if (
            Object.hasOwn(frame.sharedVariables?.values ?? {}, 'tag') &&
            answer.sharedVariables?.values?.tag !== frame.sharedVariables.values.tag
          )
            throw error('The request tag is immutable.', 'LocalPluginTagImmutable', 409);
          frame.sharedVariables = answer.sharedVariables;
          frame.outputParameters = answer.outputParameters;
          // CRUD PreValidation variables belong to the parent context of later
          // stages, while PreOperation and PostOperation share their own collection.
          if (stage === 10 && ['create', 'update', 'delete'].includes(operation))
            frame.preValidationContext = {
              $type: 'ExecutionContext',
              values: {
                ...cloneStateData(context.context),
                InputParameters: cloneStateData(answer.inputParameters),
                OutputParameters: cloneStateData(answer.outputParameters),
                SharedVariables: cloneStateData(answer.sharedVariables),
                PreEntityImages: { $type: 'EntityImageCollection', values: cloneStateData(context.preImages) },
                PostEntityImages: { $type: 'EntityImageCollection', values: cloneStateData(context.postImages) },
              },
            };
          if (read) {
            if (multiple) {
              const nextQuery = answer.inputParameters?.values?.Query;
              if (stage !== 40) replace(query, nextQuery);
              else if (answer.outputParameters?.values?.BusinessEntityCollection != null) {
                replace(collection, answer.outputParameters.values.BusinessEntityCollection);
                readResultChanged();
              }
            } else if (stage === 40 && answer.outputParameters?.values?.BusinessEntity != null) {
              holder.entity = cloneStateData(answer.outputParameters.values.BusinessEntity);
              readResultChanged();
            }
            output = {};
          } else if (bulk) {
            const next = answer.inputParameters?.values?.Targets;
            if (next?.$type !== 'EntityCollection' || !Array.isArray(next.entities))
              throw error('Bulk plugin must retain a typed Targets EntityCollection.');
            if (stage !== 40) targets.splice(0, targets.length, ...cloneStateData(next.entities));
            output = {};
          } else if (association) {
            if (JSON.stringify(answer.inputParameters?.values) !== JSON.stringify(associationParameters))
              throw error(
                'Association parameter mutation needs a source-qualified adapter.',
                'LocalPluginSdkUnsupported',
                501,
              );
            output = {};
          } else if (
            stage !== 40 &&
            operation !== 'delete' &&
            Object.keys(target).some((key) => !Object.hasOwn(answer.target?.attributes ?? {}, key))
          )
            throw error(
              'Original plugin removed a Target attribute; target removal requires an explicit mutation adapter.',
              'LocalPluginSdkUnsupported',
              501,
            );
          if (!read && !bulk && !association)
            output = stage === 40 || operation === 'delete' ? {} : { target: sdkValueToRecord(answer.target) };
          diagnostic({
            code: 'PLUGIN_STEP_CLR_EXECUTED',
            severity: 'info',
            stepId: item.id,
            entity,
            operation,
            stage,
            sdkCalls: answer.sdkCalls,
            assemblyFullName: answer.assemblyFullName,
            sdkFullName: answer.sdkFullName,
            sourceProvenance: answer.provenance,
            message: 'Original CLR assembly completed with local SDK calls.',
          });
        } else if (item.mode === 'mock') {
          if ((item.configuration?.status ?? 200) >= 400)
            throw error(
              item.configuration?.body?.error?.message || `Plugin mock ${item.name} rejected the write.`,
              'PluginValidation',
            );
          output = item.configuration?.body ?? {};
        } else if (item.mode === 'handler') {
          const byStep = handlers.get(item.id),
            handler = byStep ?? handlers.get(item.typeName);
          if (!handler) throw error(`No trusted handler for plugin step ${item.id}.`);
          typed = byStep === undefined;
          handlerDepth = enterPluginExecution();
          nested = true;
          if (handlerDepth > HANDLER_DEPTH_LIMIT)
            throw new DataError('Plug-in nested execution depth exceeds eight.', 400, 'LocalPluginDepth');
          executed = true;
          started = performance.now();
          startedAt = new Date((store?.clock ?? systemClock).now()).toISOString();
          // A trusted handler receives its registered images: the pre-image from the stored row, the
          // PostOperation post-image from the saved row, limited to the registered attributes.
          const image = (types, source) => {
            const spec = (item.images ?? []).find((entry) => types.includes(entry.type));
            if (!spec || !source) return undefined;
            return cloneStateData(
              spec.attributes.length
                ? Object.fromEntries(
                    spec.attributes.filter((name) => Object.hasOwn(source, name)).map((name) => [name, source[name]]),
                  )
                : source,
            );
          };
          output = handler({
            step: cloneStateData(item),
            entity,
            operation,
            stage,
            target: cloneStateData(target),
            record: cloneStateData(record),
            previous: previous ? cloneStateData(previous) : null,
            preImage: image([0, 2], previous),
            postImage: stage === 40 ? image([1, 2], record) : undefined,
            identity: cloneStateData(identity),
            changedAttributes: [...changedAttributes],
            ...(association ? { associationParameters: cloneStateData(associationParameters) } : {}),
            ...(bulk
              ? {
                  targets: cloneStateData(targets),
                  previousRecords: cloneStateData(previousRecords),
                  records: cloneStateData(records),
                }
              : {}),
            ...(read
              ? {
                  query: cloneStateData(query),
                  collection: cloneStateData(collection),
                  columns: cloneStateData(columns),
                  entityResult: cloneStateData(holder?.entity),
                }
              : {}),
            ...(typed
              ? {
                  context: typedContext({
                    item,
                    store,
                    entity,
                    operation,
                    stage,
                    target,
                    targets,
                    record,
                    previous,
                    identity,
                    depth: handlerDepth,
                    trace,
                    changedAttributes,
                  }),
                }
              : {}),
            trace,
            reject: (message) => {
              throw new DataError(String(message), 400, 'PluginValidation', { declaredValidationMessage: true });
            },
          });
          if (output?.then) {
            Promise.resolve(output).catch(() => {});
            throw error('Plugin handlers must return synchronously.', 'LocalPluginAsyncHandler');
          }
        } else
          throw error(
            `Plugin step mode ${item.mode} has no local execution adapter. Select clr, handler, mock, or disabled.`,
            'LocalPluginUnsupported',
          );
        if (
          output !== undefined &&
          (!output ||
            typeof output !== 'object' ||
            Array.isArray(output) ||
            Object.keys(output).some(
              (key) =>
                !(
                  association
                    ? ['error']
                    : bulk
                      ? ['targets', 'error']
                      : read
                        ? ['query', 'collection', 'entityResult', 'error']
                        : ['target', 'error']
                ).includes(key),
            ))
        )
          throw error('Plugin result must contain only supported field/query changes or an error.');
        if (output?.error)
          throw error(String(output.error.message || 'Plugin rejected the write.'), 'PluginValidation');
        if (bulk && output?.targets !== undefined) {
          if (stage === 40 || !Array.isArray(output.targets))
            throw error('Bulk Targets changes require a pre-operation array.');
          targets.splice(0, targets.length, ...cloneStateData(output.targets));
        }
        if (!multiple && output?.entityResult !== undefined) {
          if (stage !== 40) throw error('Retrieve Entity changes require PostOperation.');
          holder.entity = cloneStateData(output.entityResult);
          readResultChanged();
        }
        if (read && output?.query !== undefined) {
          if (!multiple || stage === 40)
            throw error('Query changes require RetrieveMultiple PreValidation or PreOperation.');
          replace(query, output.query);
        }
        if (read && output?.collection !== undefined) {
          if (stage !== 40) throw error('Collection changes require PostOperation.');
          replace(collection, output.collection);
          readResultChanged();
        }
        if (output?.target !== undefined) {
          if (stage === 40 || operation === 'delete')
            throw error('PostOperation and Delete target changes cannot be persisted by this adapter.');
          if (!output.target || typeof output.target !== 'object' || Array.isArray(output.target))
            throw error('Plugin target must be a field map.');
          for (const [name, value] of Object.entries(output.target)) {
            if (
              !/^[a-z][a-z0-9_]*$/i.test(name) ||
              ['__proto__', 'prototype', 'constructor'].includes(name.toLowerCase())
            )
              throw error('Invalid plugin target column.');
            target[name] = cloneStateData(value);
            record[name] = cloneStateData(value);
          }
        }
        if (executed) journal(null);
        if (item.mode !== 'clr')
          note('PLUGIN_STEP_SIMULATED', `Local ${item.mode} completed; compiled .NET was not executed.`);
      } catch (cause) {
        // A plug-in type handler's exception surfaces as the documented fault; the write rolls back with the throw.
        const failure = typed && !(cause instanceof DataError) ? pluginFault(cause, item) : cause;
        if (executed) journal(failure);
        store?.counters?.increment('plugins.failures');
        note('PLUGIN_STEP_REJECTED', failure.message);
        throw failure;
      } finally {
        if (nested) leavePluginExecution();
      }
    }
    return cloneStateData(executionFrames.get(record) ?? {});
  };
  return run(0);
}
