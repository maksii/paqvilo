import { initializePluginOperation } from './plugin-operation-context.mjs';
import { canonicalTagVariables } from './plugin-request-tag.mjs';
import { cloneStateData } from './state-clone.mjs';
import { imageAttributes } from './plugin-images.mjs';
import { currentRequest } from './request-context.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
  recordToSdkEntity,
  PLUGIN_MAX_DEPTH,
  PLUGIN_DEPTH_MESSAGE,
} from './plugin-clr.mjs';
import { sdkValueToRecord } from './local-organization-service.mjs';
import {
  pluginMessageParameters,
  pluginMessageValues,
  reconcilePluginMessageParameters,
  pluginContextValues,
} from './plugin-message-values.mjs';
import {
  pluginExecutionLifetime,
  pluginInvocationDepth,
  pluginInvocationSdkParent,
  pluginInvocationParent,
} from './plugin-execution-lifetime.mjs';
import { asyncMultiplePluginParent, recordRequestRootChange, selectSdkEntryParent } from './plugin-sdk-parent.mjs';
import { recordPluginTrace } from './plugin-trace.mjs';
import { delegatedPluginParent, upsertSourceOperation } from './plugin-delegation.mjs';
import { populatePluginSystemOutputs } from './plugin-response.mjs';
import { notePluginFault, pluginFailure } from './plugin-fault.mjs';
import { pluginStepBypassed } from './plugin-bypass.mjs';
import { pluginMessageHasPipeline, pluginStepInert } from './plugin-message-admission.mjs';
import {
  bridgeTargetInputs,
  bulkTargetsCollection,
  multipleMessage,
  unbridgeTargetInputs,
} from './plugin-single-multiple.mjs';
import { ownershipOf } from './dataverse-security.mjs';
import {
  recordStepConstructorSettings,
  copyStepConstructorSettings,
  stepConstructorSettings,
} from './plugin-constructor-configuration.mjs';

// A plug-in record is mostly scalar columns: copy those directly and clone only structured values.
const detachedRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return cloneStateData(value);
  const copy = {};
  for (const key of Object.keys(value)) {
    const column = value[key];
    copy[key] = column !== null && typeof column === 'object' ? cloneStateData(column) : column;
  }
  return copy;
};
const executionFrames = new WeakMap();
function preValidationSnapshot(frame, values, images) {
  return {
    $type: 'ExecutionContext',
    values: {
      ...cloneStateData(values),
      InputParameters: cloneStateData(frame.inputParameters),
      OutputParameters: cloneStateData(frame.outputParameters),
      SharedVariables: cloneStateData(frame.sharedVariables),
      ...(images
        ? {
            PreEntityImages: { $type: 'EntityImageCollection', values: cloneStateData(images.preImages) },
            PostEntityImages: { $type: 'EntityImageCollection', values: cloneStateData(images.postImages) },
          }
        : {}),
    },
  };
}
// The plugin-stage span names (tracing): Create account · PostOperation.
const STAGE_NAMES = { 10: 'PreValidation', 20: 'PreOperation', 30: 'MainOperation', 40: 'PostOperation' };
// The message name a plug-in sees for an operation (IPluginExecutionContext.MessageName).
export const messageNameOf = (operation) =>
  ({
    retrievemultiple: 'RetrieveMultiple',
    createmultiple: 'CreateMultiple',
    updatemultiple: 'UpdateMultiple',
    deletemultiple: 'DeleteMultiple',
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
    messages = [],
    messageFilters = [];
  for (const message of nodes(root, 'SdkMessage')) {
    const id = canonical(value(message, 'SdkMessageId')),
      name = value(message, 'Name');
    const availability = numeric(value(message, 'Availability'));
    if (id && name) messages.push({ id, name, ...([0, 1, 2].includes(availability) ? { availability } : {}) });
  }
  for (const filter of nodes(root, 'SdkMessageFilter')) {
    const id = canonical(value(filter, 'SdkMessageFilterId')),
      messageId = lookupId(filter, 'SdkMessageId'),
      entity = canonical(value(filter, 'PrimaryObjectTypeCode')),
      availability = numeric(value(filter, 'Availability'));
    if (id && messageId && entity && [0, 1, 2].includes(availability))
      messageFilters.push({ id, messageId, entity, availability });
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
    steps.push(
      recordStepConstructorSettings(
        {
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
            value(step, 'PluginTypeName') ||
            lookupName(step, 'PluginTypeId') ||
            lookupName(step, 'EventHandler') ||
            null,
          messageId: lookupId(step, 'SdkMessageId') || null,
          message:
            value(step, 'SdkMessageName') || lookupName(step, 'SdkMessageId') || value(step, 'MessageName') || null,
          entity: primary && primary !== 'none' ? primary : null,
          messageFilterId,
          unfiltered,
          stage: numeric(value(step, 'Stage')),
          rank: numeric(value(step, 'Rank')),
          mode: numeric(value(step, 'Mode')),
          supportedDeployment: numeric(value(step, 'SupportedDeployment')),
          ...(numeric(value(step, 'CustomizationLevel')) != null
            ? { customizationLevel: numeric(value(step, 'CustomizationLevel')) }
            : {}),
          enabled: numeric(value(step, 'StateCode') ?? '0') === 0,
          filteringAttributes: String(value(step, 'FilteringAttributes') ?? '')
            .split(',')
            .map(canonical)
            .filter(Boolean),
          impersonatingUserId: lookupId(step, 'ImpersonatingUserId') || null,
          ...(lookupId(step, 'SdkMessageProcessingStepSecureConfigId')
            ? { secureConfigurationId: lookupId(step, 'SdkMessageProcessingStepSecureConfigId') }
            : {}),
          images: nodes(step, 'SdkMessageProcessingStepImage').map((image) => ({
            name: value(image, 'Name') || '',
            alias: value(image, 'EntityAlias') || '',
            type: numeric(value(image, 'ImageType')),
            ...(value(image, 'MessagePropertyName')
              ? { messagePropertyName: value(image, 'MessagePropertyName') }
              : {}),
            attributes: String(value(image, 'Attributes') ?? '')
              .split(',')
              .map(canonical)
              .filter(Boolean),
          })),
        },
        child(step, 'Configuration') || attr(step, 'Configuration') !== undefined
          ? { unsecureConfiguration: child(step, 'Configuration')?.text ?? attr(step, 'Configuration') }
          : {},
      ),
    );
  }
  return { assemblies, types, steps, messages, ...(messageFilters.length ? { messageFilters } : {}) };
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
export function importSolutionPlugins(layers = [], { sdkMessages = {}, businessLogicOwnership = {} } = {}) {
  const maps = {
    assemblies: new Map(),
    types: new Map(),
    steps: new Map(),
    messages: new Map(),
    messageFilters: new Map(),
  };
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
          maps[kind].set(record.id, copyStepConstructorSettings(record, { ...record, sourceFile: document.file }));
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
    const sourceFilter = maps.messageFilters.get(step.messageFilterId);
    const messageAvailability = sourceMessage?.availability ?? observedMessage?.availability;
    const filterAvailability =
      sourceFilter?.availability ?? observedMessage?.filterAvailability?.[step.entity ?? 'none'];
    const resolved = {
      ...step,
      ...(businessLogicOwnership[step.id] ? { bypassOwnership: businessLogicOwnership[step.id] } : {}),
      message,
      ...([0, 1, 2].includes(messageAvailability) ? { messageAvailability } : {}),
      ...([0, 1, 2].includes(filterAvailability) ? { filterAvailability } : {}),
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
    return copyStepConstructorSettings(exported, { ...resolved, unsupported: pluginUnsupported(resolved) });
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
  fingerprint.update(JSON.stringify(businessLogicOwnership));
  return {
    assemblies: [...maps.assemblies.values()],
    types: [...maps.types.values()],
    steps,
    ...(maps.messages.size ||
    Object.values(sdkMessages).some((message) => message.availability != null || message.filterAvailability)
      ? {
          messages: [
            ...Object.entries(sdkMessages).map(([id, message]) => ({ id, ...message })),
            ...maps.messages.values(),
          ],
        }
      : {}),
    ...(maps.messageFilters.size ? { messageFilters: [...maps.messageFilters.values()] } : {}),
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
  plugins.steps = plugins.steps.map((step) =>
    copyStepConstructorSettings(step, { ...step, ...typeSources.get(step.typeName) }),
  );
  plugins.sourceRoots = [...sourceRoots];
  plugins.sourceFiles = [...sourceFiles];
  plugins.fingerprint = createHash('sha256')
    .update(plugins.fingerprint)
    .update(JSON.stringify([...typeSources]))
    .digest('hex');
  return plugins;
}

// An impersonated step runs with the impersonated user as UserId (every handler and the CLR context implement it).
export function pluginUnsupported(step, { images = false } = {}) {
  if (![0, 1].includes(step.mode)) return 'Execution mode is missing or unsupported.';
  const external = /^onexternal(created|updated|deleted)$/.test(String(step.message).toLowerCase());
  const customApi = step.customApi;
  if (
    customApi &&
    (!customApi.allowedCustomProcessingStepType || (customApi.allowedCustomProcessingStepType === 1 && step.mode !== 1))
  )
    return 'The custom API does not allow this processing step execution mode.';
  if (external && (step.mode !== 1 || step.stage !== 40))
    return 'External virtual-table events require asynchronous PostOperation execution.';
  // Native accepts an asynchronous step on any message at stage 40; the message's pipeline decides below.
  if (step.mode === 1 && step.stage !== 40)
    return 'Asynchronous execution supports post-commit stage 40 mutation and external virtual-table event registrations.';
  if (!stages[step.stage]) return 'Only synchronous stages 10, 20 and 40 are simulated.';
  if (!step.message)
    return 'The SDK message name is not exported. Add evidence-backed observed.sdkMessages or exported SDK message metadata; the step label is not used to guess behavior.';
  const inert = pluginStepInert(step);
  if (!inert && !pluginMessageHasPipeline(step)) return 'This message has no configured local execution pipeline.';
  // An unfiltered (global) step runs for every table its message fires on, with that table in the context.
  if (step.unfiltered === true && (step.entity || step.messageFilterId))
    return 'Unfiltered execution requires an explicit null filter.';
  if (!customApi && step.unfiltered !== true && (!step.entity || !/^[a-z][a-z0-9_]*$/i.test(step.entity)))
    return 'An explicit logical table binding is required.';
  if (!Number.isInteger(step.rank)) return 'An explicit execution rank is required.';
  if (step.supportedDeployment === 1) return 'Offline-only client registration is skipped by online/server execution.';
  if (![0, 2].includes(step.supportedDeployment)) return 'Server deployment is missing or unsupported.';
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
  if (pluginStepInert(step)) return false;
  return (
    (step.customApi && (step.customApi.bindingType === 0 ? !entity || entity === 'none' : step.entity === entity)) ||
    step.entity === entity ||
    (step.unfiltered === true &&
      !step.customApi &&
      step.entity == null &&
      step.messageFilterId == null &&
      pluginMessageHasPipeline(step))
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
// Depth. Handlers must return synchronously, so it is balanced within one call stack. Depth past PLUGIN_MAX_DEPTH fails.
// A plug-in type handler's exception is the InvalidPluginExecutionException fault: 0x80040265 with the SubErrorCode native sends.
const pluginFault = (cause, item, stage, depth) =>
  pluginFailure(
    {
      message: cause?.message ?? String(cause),
      errorCode: cause?.errorCode,
      pluginFault: 'InvalidPluginExecutionException',
    },
    { name: item.name, id: item.id, type: item.typeName, traces: [], stage, depth },
    0,
  );
// The registered images of one type set (0 pre, 1 post, 2 both) from source, keyed by alias, limited to their attributes
// (imageAttributes: the handler context's images).
const registeredImages = (item, types, source) =>
  Object.fromEntries(
    (item.images ?? [])
      .filter((spec) => types.includes(spec.type) && source)
      .map((spec) => [spec.alias || spec.name, detachedRecord(imageAttributes(source, spec.attributes))]),
  );
// InputParameters of a CRUD, external event or bulk message (IPluginExecutionContext.InputParameters).
function typedInputParameters({ operation, target, targets, previous, changedAttributes = [] }) {
  if (['create', 'update', 'delete', 'onexternalcreated', 'onexternalupdated', 'onexternaldeleted'].includes(operation))
    return {
      Target: detachedRecord(target),
      ...(operation === 'onexternalupdated'
        ? { PreImage: detachedRecord(previous), ChangedFields: [...changedAttributes] }
        : {}),
    };
  if (['createmultiple', 'updatemultiple'].includes(operation))
    return { Targets: Array.isArray(targets) ? targets.map(detachedRecord) : cloneStateData(targets) };
  return {};
}
// The shared variables of one operation frame (IPluginExecutionContext.SharedVariables), kept as the CLR host's
// ParameterCollection so JavaScript and CLR steps of one operation share them.
const sharedValues = (frame) => frame?.sharedVariables?.values ?? {};
// The business unit of a systemuser row (the execution context's BusinessUnitId), or null.
const businessUnitOf = (store, userId) => {
  const id = canonical(userId);
  if (!id || !store?.state?.tables?.systemuser) return null;
  const row = store.tableRows('systemuser').find((user) => canonical(user.systemuserid) === id);
  return row ? (row.businessunitid?.id ?? row.businessunitid ?? null) : null;
};
// A step span's error (D-R3-19): the plug-in fault identity, with the span status the thrown error gives.
const failStep = (span, failure, identity) =>
  span?.end({
    error: identity ?? failure,
    status: [401, 403].includes(failure?.status) || /denied/i.test(String(failure?.code ?? '')) ? 'denied' : 'error',
  });
// The CLR step span's input and output (D-R3-20): the same shape as a JavaScript step, read from the host bridge context.
const guidOf = (value) => value?.value ?? value ?? null;
const sdkRecord = (value) => (value?.$type === 'Entity' ? sdkValueToRecord(value) : (value ?? null));
const sdkImages = (images) =>
  Object.fromEntries(Object.entries(images ?? {}).map(([alias, image]) => [alias, sdkRecord(image)]));
function clrStepInput({ context, inputParameters, sharedVariables, preImages, postImages }) {
  const parameters = inputParameters?.values ?? {};
  return {
    target: sdkRecord(parameters.Target) ?? (parameters.Targets?.entities ?? []).map(sdkRecord),
    inputParameters: parameters,
    preImages: sdkImages(preImages),
    postImages: sdkImages(postImages),
    sharedVariables: sharedVariables?.values ?? {},
    context: {
      messageName: context.MessageName,
      stage: context.Stage,
      mode: context.Mode,
      depth: context.Depth,
      correlationId: guidOf(context.CorrelationId),
      initiatingUserId: guidOf(context.InitiatingUserId),
      userId: guidOf(context.UserId),
      businessUnitId: guidOf(context.BusinessUnitId),
      isolationMode: context.IsolationMode,
    },
  };
}
// A JavaScript step span's input at level full (D-R3-20): the execution context the handler receives (typedContext), in the
// same shape as a CLR step's (clrStepInput).
function contextStepInput(context, store) {
  const inputs = context.InputParameters ?? {};
  return {
    target: inputs.Target ?? inputs.Targets ?? null,
    inputParameters: inputs,
    preImages: context.PreEntityImages ?? {},
    postImages: context.PostEntityImages ?? {},
    sharedVariables: context.SharedVariables ?? {},
    context: {
      messageName: context.MessageName,
      stage: context.Stage,
      mode: context.Mode,
      depth: context.Depth,
      correlationId: context.CorrelationId ?? null,
      initiatingUserId: context.InitiatingUserId ?? null,
      userId: context.UserId ?? null,
      businessUnitId: businessUnitOf(store, context.InitiatingUserId),
      isolationMode: context.IsolationMode,
    },
  };
}
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
  previousRecords,
  records,
  record,
  previous,
  identity,
  depth,
  trace,
  customApi,
  messageParameters,
  frame,
  associationParameters,
  query,
  columns,
  holder,
  changedAttributes = [],
  bridged = false,
}) {
  const idColumn = entity && !(customApi && entity === 'none') ? store?.resolveMapping(entity)?.idColumn : null;
  const images = (types, source) => registeredImages(item, types, source);
  const preValidationParent =
    stage !== 10 &&
    (item.contract?.mode ?? 0) === 0 &&
    ['create', 'update', 'delete'].includes(operation) &&
    frame?.preValidationContext;
  const parent =
    frame?.delegatedParentContext ??
    (preValidationParent || store?.pluginParentContext || pluginInvocationSdkParent(store));
  initializePluginOperation(frame, store, parent);
  const executing = identity?.systemUserId ?? identity?.id ?? parent?.values?.UserId?.value ?? null;
  // A plug-in's SDK call: the service's user initiates the nested operation (recorded native sdkSurface, readNested).
  const initiating = store?.pluginExecutionUserId ?? parent?.values?.InitiatingUserId?.value ?? executing;
  const result = {
    MessageName: customApi?.name ?? messageNameOf(operation),
    PrimaryEntityName: ['associate', 'disassociate'].includes(operation) ? 'none' : entity,
    ...(operation === 'update' || (customApi && entity === 'none') ? { SecondaryEntityName: 'none' } : {}),
    // A queued DeleteMultiple job names no row (native crud, async, upsert).
    PrimaryEntityId:
      ['associate', 'disassociate'].includes(operation) ||
      (bridged && operation === 'delete' && (item.contract?.mode ?? 0) === 1)
        ? '00000000-0000-0000-0000-000000000000'
        : idColumn
          ? (record[idColumn] ?? (customApi ? '00000000-0000-0000-0000-000000000000' : null))
          : customApi
            ? '00000000-0000-0000-0000-000000000000'
            : null,
    Stage: stage,
    Mode: item.contract?.mode ?? 0,
    Depth: depth,
    InitiatingUserId: initiating,
    UserId: item.impersonatingUserId ?? executing,
    ParentContext: pluginContextValues(parent, store),
    ...(frame?.requestId === undefined ? {} : { RequestId: frame.requestId }),
    ...(frame?.operationId === undefined ? {} : { OperationId: frame.operationId }),
    ...(frame?.correlationId === undefined ? {} : { CorrelationId: frame.correlationId }),
    ...(frame?.createdOnWire === undefined ? {} : { OperationCreatedOn: frame.createdOnWire.value }),
    InputParameters: customApi
      ? pluginMessageValues(messageParameters.inputParameters, store)
      : associationParameters
        ? pluginMessageValues({ values: associationParameters }, store)
        : operation === 'retrievemultiple'
          ? { Query: cloneStateData(query) }
          : operation === 'retrieve'
            ? {
                Target: pluginMessageValues({ values: { value: holder?.target } }, store).value,
                ColumnSet: cloneStateData(columns),
              }
            : ['create', 'update', 'delete', 'onexternalcreated', 'onexternalupdated', 'onexternaldeleted'].includes(
                  operation,
                )
              ? {
                  Target: detachedRecord(target),
                  ...(operation === 'onexternalupdated'
                    ? { PreImage: detachedRecord(previous), ChangedFields: [...changedAttributes] }
                    : {}),
                }
              : ['createmultiple', 'updatemultiple'].includes(operation)
                ? { Targets: Array.isArray(targets) ? targets.map(detachedRecord) : cloneStateData(targets) }
                : {},
    // The main operation's Create id is an output of every PostOperation context, also when earlier stages
    // already gave the frame an (empty) output collection.
    OutputParameters: customApi
      ? pluginMessageValues(messageParameters.outputParameters, store)
      : {
          ...(stage === 40 && operation === 'create' && idColumn ? { id: record[idColumn] } : {}),
          ...(frame?.outputParameters ? pluginMessageValues(frame.outputParameters, store) : {}),
        },
    SharedVariables: pluginMessageValues(frame?.sharedVariables, store),
    IsInTransaction: store?.pluginInTransaction === true,
    IsolationMode: item.isolationMode ?? 2,
    PreEntityImages: images([0, 2], previous),
    PostEntityImages: stage === 40 && operation !== 'delete' ? images([1, 2], record) : {},
    trace,
  };
  if (['createmultiple', 'updatemultiple'].includes(operation)) {
    // A queued bulk job has no pre-image sets unless its registration asks for pre images (native sdkSurface).
    result.PreEntityImagesCollection =
      (item.contract?.mode ?? 0) === 1 && !(item.images ?? []).some((spec) => [0, 2].includes(spec.type))
        ? []
        : (targets ?? []).map((_, index) => images([0, 2], previousRecords?.[index]));
    result.PostEntityImagesCollection = (targets ?? []).map((_, index) =>
      stage === 40 ? images([1, 2], records?.[index]) : {},
    );
  }
  if (frame?.requestTag !== undefined && !frame.inputTagConsumed)
    result.InputParameters = { tag: frame.requestTag, ...result.InputParameters };
  if (frame?.inputParameters) {
    const extras = pluginMessageValues(frame.inputParameters, store);
    result.InputParameters = { ...extras, ...result.InputParameters };
    if (stage === 40 && frame.inputParametersStage === 40) {
      if (['create', 'update'].includes(operation) && frame.inputParameters.values?.Target?.$type === 'Entity')
        result.InputParameters.Target = sdkValueToRecord(frame.inputParameters.values.Target);
      if (
        ['createmultiple', 'updatemultiple'].includes(operation) &&
        frame.inputParameters.values?.Targets?.$type === 'EntityCollection'
      )
        result.InputParameters.Targets = cloneStateData(frame.inputParameters.values.Targets.entities);
    }
  }
  if (frame?.delegatedSourceOperation) {
    const source = frame.delegatedSourceOperation;
    const base = {
      ...result,
      PrimaryEntityId: { $type: 'Guid', value: result.PrimaryEntityId },
      UserId: { $type: 'Guid', value: result.UserId },
      InitiatingUserId: { $type: 'Guid', value: result.InitiatingUserId },
      ParentContext: parent,
    };
    result.ParentContext = pluginContextValues(
      delegatedPluginParent(
        source,
        base,
        store?.pluginExecutionUserId ??
          source.identity?.systemUserId ??
          (source.identity?.admin ? source.identity.id : null) ??
          initiating,
      ),
      store,
    );
  }
  const asyncParent = asyncMultiplePluginParent(frame, bridged ? multipleMessage(operation) : operation, entity);
  if (asyncParent) result.ParentContext = pluginContextValues(asyncParent, store);
  // A main operation reports the step's executing user: an impersonating step's own main operation and a named
  // message's main operation (native crud "Probe: Update 40 impersonated", sdkMessages Assign/30 as SYSTEM).
  if (
    (frame?.delegatedParentContext ? frame.namedMainOperation : item.impersonatingUserId && preValidationParent) &&
    !frame?.delegatedSourceOperation &&
    result.ParentContext
  )
    result.ParentContext.UserId = result.UserId;
  // Every ancestor reports the observing context's IsInTransaction (native: 855 synchronous ancestor samples).
  for (let level = result.ParentContext; level; level = level.ParentContext)
    level.IsInTransaction = result.IsInTransaction;
  if (bridged && store) {
    result.MessageName = messageNameOf(multipleMessage(operation));
    result.InputParameters = bridgedPlainInputs(
      { store, entity, operation, stage, record, frame },
      result.InputParameters,
    );
  }
  return result;
}

// The single Target of a handler's plain InputParameters as the one SDK record of a bridged step's Targets (the
// Target its typed execution context carries, see handlerExecutionContext).
function bridgedPlainInputs({ store, entity, operation, stage, record, frame }, inputs) {
  const { Target: plain = {}, ...rest } = inputs ?? {};
  const primary = store.resolveMapping(entity).idColumn,
    submitted = operation === 'create' && stage === 10;
  return {
    ...rest,
    Targets: [
      operation === 'delete'
        ? { $type: 'EntityReference', logicalName: entity, id: record[primary] }
        : {
            ...recordToSdkEntity(
              store,
              entity,
              { ...plain, ...(submitted && Object.hasOwn(plain, primary) ? {} : { [primary]: record[primary] }) },
              submitted ? { allColumns: false, columns: Object.keys(plain) } : { allColumns: true },
            ),
            id: frame?.inputParameters?.values?.Target?.id ?? record[primary],
          },
    ],
  };
}
// The handler's view back as the single message's plain Target.
function unbridgedPlainInputs(inputs) {
  if (!inputs || !Object.hasOwn(inputs, 'Targets')) return inputs;
  const { Targets: [next] = [], ...rest } = inputs;
  return { ...(next?.$type === 'Entity' ? { Target: sdkValueToRecord(next) } : {}), ...rest };
}

function handlerExecutionContext({
  context,
  before,
  frame,
  store,
  item,
  entity,
  operation,
  targets,
  associationParameters,
  query,
  columns,
  holder,
  record,
  previous,
  previousRecords,
  records,
  customApi,
  messageParameters,
  parent,
  bridged = false,
}) {
  // A bridged step's typed context is the single message's one with Target as one Targets record.
  if (bridged) {
    context = { ...context, InputParameters: unbridgedPlainInputs(context.InputParameters) };
    before = { ...before, inputs: unbridgedPlainInputs(before.inputs) };
  }
  const primary = entity && entity !== 'none' ? store?.resolveMapping(entity).idColumn : null;
  const rawInputs = customApi
    ? reconcilePluginMessageParameters(
        store,
        customApi.bindingType === 1
          ? [...(customApi.parameters ?? []), { uniquename: 'Target', type: 5, logicalentityname: entity }]
          : (customApi.parameters ?? []),
        messageParameters.inputParameters,
        before.inputs,
        context.InputParameters,
      )
    : {
        $type: 'ParameterCollection',
        values:
          associationParameters ??
          (operation === 'retrievemultiple'
            ? { Query: query }
            : operation === 'retrieve'
              ? { Target: holder?.target, ColumnSet: { $type: 'ColumnSet', ...columns } }
              : ['createmultiple', 'updatemultiple'].includes(operation)
                ? {
                    Targets: bulkTargetsCollection(entity, targets, {
                      submitted: context.Stage === 10 && context.Mode !== 1,
                    }),
                  }
                : {
                    Target:
                      operation === 'delete'
                        ? { $type: 'EntityReference', logicalName: entity, id: record[primary] }
                        : {
                            ...recordToSdkEntity(
                              store,
                              entity,
                              {
                                ...context.InputParameters.Target,
                                ...(operation === 'create' &&
                                context.Stage === 10 &&
                                Object.hasOwn(context.InputParameters.Target, primary)
                                  ? {}
                                  : { [primary]: record[primary] }),
                              },
                              operation === 'create' && context.Stage === 10
                                ? { allColumns: false, columns: Object.keys(context.InputParameters.Target) }
                                : { allColumns: true },
                            ),
                            id: frame.inputParameters?.values?.Target?.id ?? record[primary],
                          },
                  }),
      };
  if (!customApi)
    rawInputs.values = {
      ...reconcilePluginMessageParameters(store, [], frame.inputParameters, before.inputs, context.InputParameters)
        .values,
      ...rawInputs.values,
    };
  const imageCollection = (current, source) => ({
    $type: 'EntityImageCollection',
    values: Object.fromEntries(
      Object.entries(current ?? {}).map(([alias, attributes]) => {
        if (attributes == null || attributes.$type === 'Entity') return [alias, cloneStateData(attributes)];
        const spec = (item.images ?? []).find((entry) => (entry.alias || entry.name) === alias);
        const original = recordToSdkEntity(store, entity, imageAttributes(source), {
          allColumns: !spec?.attributes?.length,
          columns: spec?.attributes ?? [],
        });
        // Image Entity.Id is independent of its selected/mutable Attributes.
        // A handler's explicit null edit remains authored data, unlike a null
        // omitted while constructing the initial image snapshot.
        return [alias, { ...original, attributes: recordToSdkEntity(store, entity, attributes).attributes }];
      }),
    ),
  });
  const values = {
    MessageName: context.MessageName,
    PrimaryEntityName: context.PrimaryEntityName,
    Stage: context.Stage,
    Mode: context.Mode,
    Depth: context.Depth,
    IsInTransaction: context.IsInTransaction,
    IsolationMode: context.IsolationMode,
    ...(context.SecondaryEntityName === undefined ? {} : { SecondaryEntityName: context.SecondaryEntityName }),
    InputParameters: rawInputs,
    OutputParameters: reconcilePluginMessageParameters(
      store,
      [],
      frame.outputParameters,
      before.outputs,
      context.OutputParameters,
    ),
    SharedVariables: reconcilePluginMessageParameters(
      store,
      [],
      frame.sharedVariables,
      before.shared,
      context.SharedVariables,
    ),
    ParentContext: parent ?? null,
    PreEntityImages: imageCollection(context.PreEntityImages, previous),
    PostEntityImages: imageCollection(context.PostEntityImages, context.Stage === 40 ? record : null),
  };
  if (['createmultiple', 'updatemultiple'].includes(operation)) {
    values.PreEntityImagesCollection = {
      $type: 'EntityImageCollectionArray',
      values: (context.PreEntityImagesCollection ?? []).map((images, index) =>
        imageCollection(images, previousRecords?.[index]),
      ),
    };
    values.PostEntityImagesCollection = {
      $type: 'EntityImageCollectionArray',
      values: (context.PostEntityImagesCollection ?? []).map((images, index) =>
        imageCollection(images, records?.[index]),
      ),
    };
  }
  for (const name of ['PrimaryEntityId', 'UserId', 'InitiatingUserId', 'RequestId', 'OperationId', 'CorrelationId'])
    if (context[name]) values[name] = { $type: 'Guid', value: context[name] };
  if (context.OperationCreatedOn != null)
    values.OperationCreatedOn =
      frame.createdOnWire && [frame.createdOnWire.value, frame.createdOn].includes(context.OperationCreatedOn)
        ? cloneStateData(frame.createdOnWire)
        : { $type: 'DateTime', value: context.OperationCreatedOn };
  if (item.id)
    values.OwningExtension = {
      $type: 'EntityReference',
      logicalName: 'sdkmessageprocessingstep',
      id: item.id,
      name: item.name ?? null,
    };
  if (frame.delegatedSourceOperation) {
    const source = frame.delegatedSourceOperation;
    values.ParentContext = delegatedPluginParent(
      source,
      values,
      store?.pluginExecutionUserId ??
        source.identity?.systemUserId ??
        (source.identity?.admin ? source.identity.id : null) ??
        context.InitiatingUserId,
    );
  }
  values.ParentContext =
    asyncMultiplePluginParent(frame, bridged ? multipleMessage(operation) : operation, entity) ?? values.ParentContext;
  if (bridged) values.InputParameters = { ...rawInputs, values: bridgeTargetInputs(rawInputs.values, entity) };
  return { $type: 'ExecutionContext', values };
}

// plugintracelog: organization.plugintracelogsetting 1 keeps the rows of failed executions, 2 keeps every execution, 0 keeps none.
// Trace facts survive business rollback independently, as PluginTraceLog does natively.
function writeTraceLog(store, { item, entity, operation, depth, asyncExecution, traces, started, startedAt, error }) {
  recordPluginTrace(store, {
    typeName: item.typeName,
    stepId: item.id,
    messageName: item.customApi?.name ?? messageNameOf(operation),
    entity,
    depth,
    mode: asyncExecution ? 1 : 0,
    traces,
    started,
    startedAt,
    error,
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
      unsupported = pluginUnsupported(step, { images: Boolean(runtime || descriptor || registered) });
    const clrAvailable = Boolean((runtime?.descriptor ?? descriptor)?.typeName === step.typeName);
    return copyStepConstructorSettings(step, {
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
        supportedDeployment: step.supportedDeployment,
        filteringAttributes: step.filteringAttributes,
        assemblyName: step.assemblyName,
        typeName: step.typeName,
        unsupported,
        boundary:
          'Top-level PreValidation SDK requests commit independently; PreOperation/PostOperation and nested PreValidation join the caller transaction. Read observer writes require a serialized readOperation boundary and explicit backend grants; top-level read SDK writes commit independently. CLR requires an explicitly trusted original assembly and a separate project backend security profile.',
      },
    });
  });
}

export function pluginStepMatchesAttributes(item, { store, entity, operation, changedAttributes = [] }) {
  if (!['update', 'updatemultiple'].includes(operation) || !item.filteringAttributes?.length) return true;
  const attributes = new Set(changedAttributes.map(canonical));
  if (store && entity) attributes.add(canonical(store.resolveMapping(entity).idColumn));
  return item.filteringAttributes.some((name) => attributes.has(canonical(name)));
}

function matchingPluginSteps(
  items,
  {
    store,
    entity,
    operation,
    stage,
    changedAttributes = [],
    asyncExecution = false,
    ignoreFiltering = false,
    bypassStepIds = [],
    bypassCustomPlugins = false,
    diagnostic,
    bridgedMessage = null,
  },
) {
  return items.filter(
    (item) =>
      item.enabled &&
      item.contract?.supportedDeployment !== 1 &&
      (item.contract?.mode === 1) === asyncExecution &&
      pluginStepMatchesEntity(item, entity) &&
      (String(item.message).toLowerCase() === operation ||
        (bridgedMessage != null && String(item.message).toLowerCase() === bridgedMessage)) &&
      item.stage === stage &&
      (ignoreFiltering || pluginStepMatchesAttributes(item, { store, entity, operation, changedAttributes })) &&
      !pluginStepBypassed(item, { bypassStepIds, bypassCustomPlugins }, diagnostic),
  );
}

/** The entries the platform puts in every pipeline's SharedVariables (native recordings of Web API and plug-in
 * SDK requests): IsAutoTransact (false for reads), the caller's Accept-Language ('' for a plug-in's SDK request)
 * and, on Create, DefaultsAddedFlag; CreateMultiple carries it when its steps run for a Create or a plug-in requested
 * it, not for a Web API CreateMultiple or UpsertMultiple request (native bulk). */
function platformSharedVariables(operation, acceptLanguage = '', { nested = false, bulkOrigin = false } = {}) {
  return {
    IsAutoTransact: !['retrieve', 'retrievemultiple'].includes(operation),
    AcceptLang: String(acceptLanguage ?? ''),
    ...(operation === 'create' || (operation === 'createmultiple' && (nested || !bulkOrigin))
      ? { DefaultsAddedFlag: true }
      : {}),
  };
}

/** The ChangedEntityTypes key a main operation adds (always with the value 'Update', also for Create and Delete).
 * Natively it lists user-owned tables and association intersects; an organization-owned table is absent. */
function changedEntityType(store, operation, entity, intersectEntity) {
  if (['associate', 'disassociate'].includes(operation)) return intersectEntity ?? null;
  if (!['create', 'update', 'delete', 'createmultiple', 'updatemultiple'].includes(operation) || !store) return null;
  const mapping = store.resolveMapping(entity);
  return ownershipOf(entity, null, mapping) === 'user' ? entity : null;
}

/** Metadata admission is shared by synchronous phases and queued delivery. */
export function pluginPhaseMatches(items, context) {
  return matchingPluginSteps(items, context).length > 0;
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
  intersectEntity,
  record,
  previous,
  identity,
  changedAttributes = [],
  query,
  collection,
  columns,
  holder,
  customApi,
  messageParameters,
  portalRequest = false,
  sdkFromSandbox = false,
  preValidationSourceOperation,
  frameworkInputTarget,
  concurrencyBehavior = 0,
  bulkConcurrencyBehavior,
  inheritsRequestTag = true,
  bulkOrigin = false,
  // A single Create/Update/Delete also runs its paired multiple message's steps (plugin-single-multiple.mjs).
  bridgedMessage = null,
  // A record a bulk message delegates: that message's context of this stage (plugin-bulk.mjs).
  bulkParent = null,
  acceptLanguage = '',
  asyncExecution = false,
  initialFrame,
  bypassStepIds,
  bypassCustomPlugins = false,
  continuePhase = false,
  awaitIo = false,
  diagnostic = () => {},
  onStepExecuted,
}) {
  // A saved row can be reused by a later Delete; its previous request frame
  // must not supply shared variables, correlation or parent context to this one.
  store?.assertPluginTransactionActive?.();
  if (stage === 10 && !continuePhase && !asyncExecution && !['retrieve', 'retrievemultiple'].includes(operation))
    executionFrames.set(record, {});
  const continued = executionFrames.has(record) && !initialFrame && !(stage === 10 && !continuePhase);
  if (initialFrame) executionFrames.set(record, cloneStateData(initialFrame));
  const phaseFrame = executionFrames.get(record) ?? {};
  // A request that entered as a multiple message (plugin-bulk.mjs) formats its Update Targets (plugin-formatted-values.mjs).
  if (bulkOrigin) phaseFrame.bulkOrigin = true;
  // The main operation's InputParameters are the PreValidation view; keep it for a main-operation ParentContext
  // when no PreValidation step produced a snapshot.
  if (stage === 10 && !asyncExecution && ['create', 'update', 'delete'].includes(operation))
    phaseFrame.mainOperationTarget ??= cloneStateData(target ?? {});
  // A record operation a named message's main operation starts (plugin-platform-messages.mjs) runs at that message's
  // depth with its stage-30 context as parent, as a platform main operation's delegated write does.
  const mainOperation = store?.pluginMainOperation;
  if (mainOperation && !asyncExecution && !continued) {
    phaseFrame.delegatedParentContext ??= cloneStateData(mainOperation.context);
    phaseFrame.delegatedDepth ??= mainOperation.depth;
    if (mainOperation.exactDepth) phaseFrame.exactDepth = true;
    if (mainOperation.namedMessage) phaseFrame.namedMainOperation = true;
    // A refused message's per-record PreValidation (DeleteMultiple) has no platform SharedVariables (native bulk).
    if (mainOperation.preValidationOnly) phaseFrame.platformSharedSeeded = true;
    // The request tag is an input of the message, not of the operations it delegates (SDK Upsert keeps it).
    if (!mainOperation.keepsRequestTag) phaseFrame.inputTagConsumed = true;
    delete phaseFrame.delegatedSourceOperation;
  }
  // Records a bulk message delegates, and a bulk message UpsertMultiple delegates, have no tag input (recorded corpus).
  if (!inheritsRequestTag && !continued) phaseFrame.inputTagConsumed = true;
  // Such a record runs under the bulk message's context of the current stage and shares its request identity
  // (native bulk: Create/10 <- CreateMultiple/10, Create/20 <- CreateMultiple/20 <- CreateMultiple/30).
  if (bulkParent && !asyncExecution) {
    phaseFrame.delegatedSourceOperation = bulkParent;
    for (const key of ['requestId', 'operationId', 'correlationId', 'createdOn', 'createdOnWire', 'requestTag'])
      if (bulkParent.frame?.[key] !== undefined && !Object.hasOwn(phaseFrame, key))
        phaseFrame[key] = cloneStateData(bulkParent.frame[key]);
  }
  // Durable jobs must retain the originating operation depth even when no
  // synchronous registration executes. Internal message delegation shares it.
  phaseFrame.operationDepth ??=
    phaseFrame.delegatedDepth ??
    phaseFrame.delegatedSourceOperation?.depth ??
    Math.max(
      pluginExecutionDepth(),
      pluginInvocationDepth(store),
      Number((store?.pluginParentContext ?? pluginInvocationSdkParent(store))?.values?.Depth ?? 0),
    ) + 1;
  // A request a plug-in issued through its IOrganizationService (plugin-clr.mjs InitiatingUserAgent); its asynchronous
  // jobs keep the fact.
  if (!asyncExecution) phaseFrame.sdkIssued ??= Boolean(store?.pluginParentContext || pluginInvocationSdkParent(store));
  executionFrames.set(record, phaseFrame);
  // UpsertMultiple's UpdateMultiple carries ConcurrencyBehavior on the message (dataverse-records.mjs bulkWrite).
  if (operation === 'updatemultiple' && bulkConcurrencyBehavior !== undefined) {
    phaseFrame.inputParameters ??= { $type: 'ParameterCollection', values: {} };
    phaseFrame.inputParameters.values.ConcurrencyBehavior ??= {
      $type: 'ConcurrencyBehavior',
      value: bulkConcurrencyBehavior,
    };
  }
  // Native Update and Delete requests carry ConcurrencyBehavior (Default unless an If-Match row version applies); a named
  // message's main-operation Update has none (concurrencyBehavior null).
  if ((operation === 'update' || (operation === 'delete' && stage === 10)) && concurrencyBehavior !== null) {
    phaseFrame.inputParameters ??= { $type: 'ParameterCollection', values: {} };
    phaseFrame.inputParameters.values.ConcurrencyBehavior ??= {
      $type: 'ConcurrencyBehavior',
      value: concurrencyBehavior,
    };
  }
  if (operation === 'update') {
    if (preValidationSourceOperation === 'upsert' && !phaseFrame.sdkFrameworkSource)
      phaseFrame.sdkFrameworkSource = {
        operation: 'upsert',
        acceptLanguage,
        target: recordToSdkEntity(store, entity, {
          ...(frameworkInputTarget ?? target),
          [store.resolveMapping(entity).idColumn]: record[store.resolveMapping(entity).idColumn],
        }),
      };
  }
  // A bare Web API PATCH runs Create or Update inside an Upsert main operation: PreValidation's parent is that
  // Upsert, whose Target is the one handed to the inner message (native recorder parity corpus, upsert).
  if (
    store &&
    preValidationSourceOperation === 'upsert' &&
    ['create', 'update'].includes(operation) &&
    !asyncExecution
  ) {
    if (stage === 10) {
      const primary = store.resolveMapping(entity).idColumn;
      phaseFrame.delegatedSourceOperation = upsertSourceOperation({
        store,
        entity,
        // An Update Target names its primary key; an upsert-create Target carries it only as Entity.Id.
        target: recordToSdkEntity(
          store,
          entity,
          operation === 'update' ? { ...target, [primary]: record[primary] } : target,
          { allColumns: true, submitted: true, target: true },
        ),
        id: record[primary],
        acceptLanguage,
        tag: phaseFrame.requestTag ?? store.pluginSdkTag,
        identity,
        depth: phaseFrame.operationDepth,
      });
    } else if (phaseFrame.delegatedSourceOperation?.operation === 'upsert') delete phaseFrame.delegatedSourceOperation;
  }
  // The operations an Upsert main operation runs share its request identity (plugin-delegation.mjs).
  if (phaseFrame.delegatedSourceOperation?.operation === 'upsert')
    for (const key of ['requestId', 'operationId', 'correlationId'])
      if (phaseFrame.delegatedSourceOperation.frame?.[key] != null)
        phaseFrame[key] ??= phaseFrame.delegatedSourceOperation.frame[key];
  phaseFrame.suppliedRequestId ??= store?.pluginRequestId;
  phaseFrame.requestId ??=
    phaseFrame.delegatedParentContext?.values?.RequestId?.value ??
    (store?.pluginParentContext ?? pluginInvocationSdkParent(store))?.values?.RequestId?.value ??
    (store?.ids ?? systemIds).uuid();
  if (
    !asyncExecution &&
    stage !== 10 &&
    ['create', 'update', 'delete', 'createmultiple', 'updatemultiple'].includes(operation) &&
    !phaseFrame.inputTagConsumed
  ) {
    if (phaseFrame.inputParameters?.values) {
      delete phaseFrame.inputParameters.values.tag;
      delete phaseFrame.inputParameters.values.FromSandbox;
      // Native Delete PreOperation/PostOperation inputs hold only the Target (Update keeps ConcurrencyBehavior).
      if (operation === 'delete') delete phaseFrame.inputParameters.values.ConcurrencyBehavior;
    }
    phaseFrame.inputTagConsumed = true;
  }
  if (!Object.hasOwn(phaseFrame, 'requestTag')) {
    phaseFrame.requestTag = store?.pluginSdkTag;
    if (phaseFrame.requestTag !== undefined) {
      phaseFrame.sharedVariables ??= { $type: 'ParameterCollection', values: { tag: phaseFrame.requestTag } };
      if (!phaseFrame.inputTagConsumed)
        phaseFrame.inputParameters = {
          $type: 'ParameterCollection',
          values: { tag: phaseFrame.requestTag, ...(phaseFrame.inputParameters?.values ?? {}) },
        };
    }
  }
  if (stage === 10 && !asyncExecution && ['createmultiple', 'updatemultiple'].includes(operation))
    phaseFrame.mainOperationTargets ??= bulkTargetsCollection(entity, cloneStateData(targets ?? []), {
      submitted: true,
    });
  if (
    stage === 10 &&
    !asyncExecution &&
    ['create', 'update', 'delete', 'createmultiple', 'updatemultiple'].includes(operation)
  ) {
    // A sandboxed plug-in's SDK request is marked FromSandbox in its PreValidation (and main operation) inputs.
    if (sdkFromSandbox) {
      phaseFrame.inputParameters ??= { $type: 'ParameterCollection', values: {} };
      phaseFrame.inputParameters.values.FromSandbox ??= true;
    }
    phaseFrame.mainOperationInputs ??= cloneStateData(phaseFrame.inputParameters?.values ?? {});
  }
  if (
    store &&
    operation === 'create' &&
    stage === 20 &&
    phaseFrame?.inputParametersStage === 10 &&
    phaseFrame?.inputParameters?.values?.Target?.$type === 'Entity'
  )
    phaseFrame.inputParameters.values.Target.id = record[store.resolveMapping(entity).idColumn];
  if (
    store &&
    operation === 'update' &&
    stage === 40 &&
    phaseFrame?.inputParametersStage !== 40 &&
    phaseFrame?.inputParameters?.values?.Target?.$type === 'Entity'
  )
    phaseFrame.inputParameters.values.Target.id = record[store.resolveMapping(entity).idColumn];
  if (!asyncExecution && !customApi && !/^onexternal/.test(operation)) {
    // Native pipelines start every SharedVariables collection with the platform's entries (see
    // platformSharedVariables). A plug-in-issued SDK request carries no Accept-Language.
    const nested = Boolean(store?.pluginParentContext || pluginInvocationSdkParent(store)),
      // A record a bulk message delegates keeps only its own message's entries; the platform's belong to the bulk
      // message's collections (native bulk).
      platform =
        bulkOrigin && !['createmultiple', 'updatemultiple'].includes(operation)
          ? operation === 'create'
            ? { DefaultsAddedFlag: true }
            : {}
          : platformSharedVariables(operation, nested ? '' : acceptLanguage || identity?.dataverse?.acceptLanguage, {
              nested,
              bulkOrigin,
            });
    // The PreValidation collection exists before any step ran; remember how many plug-in requests preceded it.
    if (stage === 10) phaseFrame.sdkRequestsBefore ??= store?.pluginSdkRequests ?? 0;
    if (!phaseFrame.platformSharedSeeded) {
      phaseFrame.sharedVariables = {
        $type: 'ParameterCollection',
        values: { ...platform, ...(phaseFrame.sharedVariables?.values ?? {}) },
      };
      phaseFrame.platformSharedSeeded = true;
    }
    // PreValidation shares the main operation's collection (the ParentContext of stages 20 and 40); PreOperation
    // and PostOperation start their own one.
    if (
      stage !== 10 &&
      ['create', 'update', 'delete', 'createmultiple', 'updatemultiple'].includes(operation) &&
      !phaseFrame.mainSharedVariables
    ) {
      const prior = phaseFrame.sharedVariables.values;
      phaseFrame.mainSharedVariables = phaseFrame.sharedVariables;
      // After a PreValidation step's own SDK request, the PreOperation/PostOperation collection reports no
      // Accept-Language (native faults: Create/20 and Create/40 at Depth 1 read '').
      const afterSdkRequest = (store?.pluginSdkRequests ?? 0) > (phaseFrame.sdkRequestsBefore ?? Infinity);
      phaseFrame.sharedVariables = {
        $type: 'ParameterCollection',
        values: {
          ...platform,
          ...(afterSdkRequest ? { AcceptLang: '' } : {}),
          ...(Object.hasOwn(prior, 'tag') ? { tag: prior.tag } : {}),
        },
      };
      phaseFrame.preValidationSharedDetached = true;
    }
    // After the main operation wrote, the request's root collection lists the security-relevant tables it changed,
    // also those of nested plug-in requests (plugin-sdk-parent recordRequestRootChange).
    const table = stage === 40 ? changedEntityType(store, operation, entity, intersectEntity) : null;
    if (table) recordRequestRootChange(store, phaseFrame.requestId, { table });
    if (stage === 40 && !nested && !phaseFrame.delegatedParentContext && !bulkParent) {
      // An HTTP Upsert's framework operation (plugin-sdk-parent selectSdkEntryParent) is the root when present; an
      // upsert-created row's Create main operation is not the root (native upsert: Create/30 has no entry).
      const root = phaseFrame.sdkFrameworkSource
        ? (phaseFrame.sdkFrameworkSource.sharedVariables ??= {
            $type: 'ParameterCollection',
            values: { AcceptLang: phaseFrame.sdkFrameworkSource.acceptLanguage ?? '', IsAutoTransact: false },
          })
        : preValidationSourceOperation === 'upsert'
          ? null
          : ['create', 'update', 'delete', 'createmultiple', 'updatemultiple'].includes(operation)
            ? phaseFrame.mainSharedVariables
            : phaseFrame.sharedVariables;
      if (table && root)
        root.values.ChangedEntityTypes = { ...(root.values.ChangedEntityTypes ?? {}), [table]: 'Update' };
    }
  }
  if (customApi) {
    const frame = executionFrames.get(record) ?? {};
    frame.customApi = customApi;
    messageParameters ??= { inputParameters: frame.inputParameters, outputParameters: frame.outputParameters };
    frame.inputParameters = messageParameters.inputParameters ?? { $type: 'ParameterCollection', values: {} };
    frame.outputParameters = messageParameters.outputParameters ?? { $type: 'ParameterCollection', values: {} };
    executionFrames.set(record, frame);
  }
  const read = ['retrieve', 'retrievemultiple'].includes(operation),
    multiple = operation === 'retrievemultiple',
    bulk = ['createmultiple', 'updatemultiple'].includes(operation),
    association = ['associate', 'disassociate'].includes(operation);
  const bridgedStep = (item) => Number(bridgedMessage != null && String(item.message).toLowerCase() === bridgedMessage);
  const matched = matchingPluginSteps(items, {
    store,
    entity,
    operation,
    stage,
    changedAttributes,
    asyncExecution,
    ignoreFiltering: true,
    bypassStepIds: bypassStepIds ?? initialFrame?.bypassStepIds ?? [],
    bypassCustomPlugins,
    diagnostic,
    bridgedMessage,
  }).sort(
    // At equal rank the requested message's steps run before its paired multiple message's (native corpus: crud,
    // faults, depth single-origin Create/Update/Delete always ran Create > CreateMultiple, whatever the step ids).
    (a, b) => a.rank - b.rank || bridgedStep(a) - bridgedStep(b) || a.id.localeCompare(b.id),
  );
  // Context4 image collections are shared by a stage: they hold the images of every registration of that stage
  // (at PostOperation including queued asynchronous ones). Asynchronous jobs reuse the committed record.
  if (!asyncExecution && !bulk && !customApi) {
    const live = (list) =>
      list.filter(
        (item) =>
          item.mode !== 'disabled' &&
          pluginStepMatchesAttributes(item, { store, entity, operation, changedAttributes }),
      );
    const queued =
      stage === 40
        ? live(
            matchingPluginSteps(items, {
              store,
              entity,
              operation,
              stage,
              changedAttributes,
              asyncExecution: true,
              ignoreFiltering: true,
              bypassStepIds: bypassStepIds ?? [],
              bypassCustomPlugins,
              diagnostic: () => {},
              bridgedMessage,
            }),
          )
        : [];
    phaseFrame.stageImages = {
      ...phaseFrame.stageImages,
      [stage]: {
        registrations: [...live(matched), ...queued].map((item) => item.images ?? []).filter((images) => images.length),
        asynchronous: queued.length > 0,
      },
    };
  }
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
      primary = entity && !(customApi && entity === 'none') ? store.resolveMapping(entity).idColumn : null;
    const values =
      operation === 'create'
        ? { id: { $type: 'Guid', value: record[primary] } }
        : operation === 'createmultiple'
          ? { Ids: { $type: 'GuidArray', values: record.bulkIds.map((value) => ({ $type: 'Guid', value })) } }
          : operation === 'retrieve'
            ? { BusinessEntity: holder.entity }
            : multiple
              ? { BusinessEntityCollection: collection }
              : customApi
                ? (messageParameters?.outputParameters?.values ?? {})
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
  const retainsEmptyPrimaryAttribute = (name, value) =>
    operation === 'create' &&
    stage === 10 &&
    name === store?.resolveMapping(entity).idColumn &&
    value === '00000000-0000-0000-0000-000000000000' &&
    target[name] === value;
  const applyTargetEntity = (next) => {
    if (next?.$type !== 'Entity' || next.logicalName !== entity)
      throw error('A record operation must retain its typed Target Entity.', 'LocalPluginSdkUnsupported', 501);
    const attributes = sdkValueToRecord(next),
      mapping = store?.resolveMapping(entity),
      saved =
        operation === 'update' && mapping
          ? (store
              .tableRows(entity)
              .find((row) => canonical(row[mapping.idColumn]) === canonical(record[mapping.idColumn])) ?? previous)
          : mapping?.recordDefaults;
    for (const name of Object.keys(target)) {
      if (Object.hasOwn(attributes, name)) continue;
      delete target[name];
      if (stage === 40 || name === mapping?.idColumn) continue;
      if (saved && Object.hasOwn(saved, name)) record[name] = cloneStateData(saved[name]);
      else delete record[name];
    }
    for (const [name, value] of Object.entries(attributes)) {
      if (!/^[a-z][a-z0-9_]*$/i.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name.toLowerCase()))
        throw error('Invalid plugin target column.');
      const retainsIdentity = retainsEmptyPrimaryAttribute(name, value);
      target[name] = cloneStateData(value);
      if (stage !== 40 && !retainsIdentity) record[name] = cloneStateData(value);
    }
  };
  // Tracing (docs/design/tracing.md): a plugin-stage span only when steps matched, and one plugin-step span per step that
  // runs (handler, CLR, mock, web hook). The step body runs inside its span, so its SDK calls and writes nest under it.
  const tracing = matched.length && store?.traces?.enabled ? store.traces : null;
  // The record the stage and its steps act on (D-R3-1): the target row's id; a bulk or multi-row message, or an unbound
  // custom API (table 'none'), has none.
  const recordId =
    tracing && !bulk && !multiple && record && entity !== 'none'
      ? (record[store.resolveMapping(entity)?.idColumn] ?? null)
      : null;
  // A step's input at level full (D-R3-20): the target, the input parameters, the registered images by alias and attribute
  // filter, the shared variables and the execution context. A CLR step's comes from the host bridge context (clrStepInput)
  // and a handler's from the context it receives (contextStepInput); this one is for steps that receive none (mock, web hook).
  const stepInput = (item) => {
    const initiating = identity?.systemUserId ?? identity?.id ?? null,
      userId = item.impersonatingUserId ?? initiating;
    return {
      target: target ?? targets ?? null,
      inputParameters: {
        ...typedInputParameters({ operation, target, targets, previous, changedAttributes }),
        ...(association ? associationParameters : {}),
        ...(multiple ? { Query: query } : {}),
        ...(read && !multiple ? { Target: { logicalName: entity, id: recordId }, ColumnSet: columns } : {}),
      },
      preImages: registeredImages(item, [0, 2], previous),
      postImages: stage === 40 && operation !== 'delete' && !read ? registeredImages(item, [1, 2], record) : {},
      sharedVariables: sharedValues(executionFrames.get(record)),
      context: {
        messageName: customApi?.name ?? messageNameOf(operation),
        stage,
        mode: item.contract?.mode ?? 0,
        depth: phaseFrame.operationDepth ?? pluginExecutionDepth() + 1,
        correlationId:
          executionFrames.get(record)?.correlationId ?? store?.flowChain?.id ?? currentRequest()?.correlationId ?? null,
        initiatingUserId: initiating,
        userId,
        businessUnitId: businessUnitOf(store, userId),
        isolationMode: item.isolationMode ?? 2,
      },
    };
  };
  const stepSpan = (item) =>
    tracing?.start({
      kind: 'plugin-step',
      name: item.name ?? item.typeName ?? item.id,
      module: item.mode === 'clr' ? 'clr' : 'plugins',
      // A bridged step runs under its own multiple message (plugin-single-multiple.mjs).
      operation: bridgedStep(item) === 1 ? bridgedMessage : operation,
      entity,
      recordId,
      actor: { kind: 'plugin', id: item.id ?? null, name: item.typeName ?? item.name ?? null },
      attributes: {
        stepId: item.id,
        typeName: item.typeName,
        assemblyName: item.assemblyName,
        mode: item.mode,
        rank: item.rank,
        stage,
        depth: pluginExecutionDepth() + 1,
        sourceFile: item.sourceFile,
      },
      // A CLR or handler step sets its input once its execution context exists.
      ...(item.mode === 'clr' || (item.mode === 'handler' && store) ? {} : { input: () => stepInput(item) }),
    });
  const inSpan = (span, fn) => (span ? tracing.run(span, fn) : fn());
  // The steps from index `from` on; an awaited post returns the promise of the rest (see awaitIo above).
  const run = (from) => {
    for (let index = from; index < matched.length; index++) {
      const item = matched[index],
        bridged = bridgedStep(item) === 1;
      if (operation === 'update') changedAttributes = Object.keys(target ?? {});
      else if (operation === 'updatemultiple')
        changedAttributes = [...new Set((targets ?? []).flatMap((entry) => Object.keys(entry.attributes ?? {})))];
      if (!pluginStepMatchesAttributes(item, { store, entity, operation, changedAttributes })) continue;
      const note = (code, message) => {
        // Skipped, simulated and rejected steps are events on the current (stage or step) span.
        tracing?.current()?.event('plugin', { message, attributes: { code, stepId: item.id } });
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
      };
      if (item.mode === 'disabled') {
        note('PLUGIN_STEP_DISABLED', 'This step is explicitly disabled in local simulator configuration.');
        continue;
      }
      if (item.mode === 'mock') {
        if ((item.configuration?.status ?? 200) >= 400 || item.configuration?.body?.error) {
          const message = item.configuration?.body?.error?.message || 'Explicit plugin mock rejected.';
          note('PLUGIN_STEP_REJECTED', message);
          const failure = error(message, 'PluginValidation');
          notePluginFault(failure, {
            pluginType: item.typeName ?? null,
            step: item.id,
            stage,
            depth: pluginExecutionDepth() + 1,
          });
          throw failure;
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
      if (['handler', 'clr'].includes(item.mode)) store?.ensureReadSnapshot?.();
      // A synchronous web hook posts its context and fails the operation (rolled back) unless the endpoint answers 2xx.
      // Asynchronous web hooks are delivered by plugin-async.mjs after commit.
      if (item.mode === 'webhook') {
        if (!webhooks) throw error('No webhook delivery adapter is configured.', 'LocalPluginUnsupported', 501);
        const frame = executionFrames.get(record);
        initializePluginOperation(
          frame,
          store,
          frame.delegatedParentContext ?? store?.pluginParentContext ?? pluginInvocationSdkParent(store),
        );
        const facts = {
          item,
          entity,
          operation,
          stage,
          target,
          targets,
          previousRecords,
          records,
          associationParameters,
          query,
          columns,
          holder,
          customApi,
          messageParameters,
          initialFrame: executionFrames.get(record),
          asyncExecution,
          record,
          previous,
          identity,
          changedAttributes,
          bridged,
          depth: phaseFrame.operationDepth,
          correlationId: store?.flowChain?.id ?? currentRequest()?.correlationId ?? (store?.ids ?? systemIds).uuid(),
          diagnostic,
        };
        let pending;
        const hook = stepSpan(item);
        try {
          pending = inSpan(hook, () => (awaitIo && webhooks.send ? webhooks.send(facts) : webhooks.sync(facts)));
        } catch (cause) {
          hook?.fail(cause);
          note('PLUGIN_STEP_REJECTED', cause.message);
          throw cause;
        }
        if (typeof pending?.then === 'function')
          return pending.then(
            () => {
              hook?.end();
              onStepExecuted?.(item);
              return run(index + 1);
            },
            (cause) => {
              hook?.fail(cause);
              note('PLUGIN_STEP_REJECTED', cause.message);
              throw cause;
            },
          );
        hook?.end();
        onStepExecuted?.(item);
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
        bridgedSent = null,
        completedContext,
        typed = false,
        nested = false,
        handlerDepth = 0;
      store?.counters?.increment('plugins.executions');
      const span = stepSpan(item);
      // The trace lines of a handler or CLR run, and its timing for plugintracelog. executed: such a run started.
      // A handler's line is also an event on its step span (CLR lines: plugin-clr.mjs, on the current span).
      const traces = [],
        trace = (text) => {
          traces.push(String(text));
          span?.event('trace', { message: String(text) });
        };
      let executed = false,
        started = 0,
        startedAt = null;
      // The step's Depth, for plugintracelog and the fault identity.
      const stepDepth = () =>
        nested
          ? handlerDepth
          : Math.max(
              pluginExecutionDepth(),
              pluginInvocationDepth(store),
              Number(store?.pluginParentContext?.values?.Depth ?? 0),
            ) + 1;
      const journal = (error) =>
        writeTraceLog(store, {
          item,
          entity,
          operation,
          depth: stepDepth(),
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
          const frame = executionFrames.get(record);
          frame.portalContactId =
            portalRequest && !store.pluginParentContext && !identity?.admin
              ? (identity?.contactId ?? identity?.id ?? null)
              : null;
          frame.portalRequest = portalRequest && !store.pluginParentContext && !identity?.admin;
          frame.callerIdentity ??= identity;
          if (read) {
            frame.query = query;
            frame.collection = collection;
            frame.entity = holder?.entity;
            frame.columns = columns;
            frame.retrieveTarget = holder?.target;
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
              bridged,
            });
          span?.setInput(() => clrStepInput(context));
          const answer = inSpan(span, () =>
            executeClrPlugin(runtime, context, {
              store,
              constructorConfiguration: stepConstructorSettings(item),
              diagnostic: (entry) => {
                if (entry.code === 'PLUGIN_CLR_TRACE') traces.push(String(entry.message));
                diagnostic({ ...entry, stepId: item.id, entity, operation, stage });
              },
            }),
          );
          span?.set({ sdkCalls: answer.sdkCalls });
          span?.output(() => ({
            outputParameters: answer.outputParameters?.values ?? {},
            sharedVariables: answer.sharedVariables?.values ?? {},
          }));
          // A bridged multiple step's one Targets record is the single message's Target again.
          if (bridged) {
            const sent = context.inputParameters.values.Targets;
            answer.inputParameters = {
              ...answer.inputParameters,
              values: unbridgeTargetInputs(answer.inputParameters?.values, {
                entity,
                id: (sent.entities ?? sent.values)[0]?.id,
              }),
            };
            answer.target = answer.inputParameters.values.Target;
          }
          frame.sharedVariables = canonicalTagVariables(answer.sharedVariables, frame.requestTag);
          frame.outputParameters = answer.outputParameters;
          frame.inputParameters = answer.inputParameters;
          frame.inputParametersStage = stage;
          // CRUD PreValidation variables belong to the parent context of later
          // stages, while PreOperation and PostOperation share their own collection.
          if (stage === 10 && ['create', 'update', 'delete', 'createmultiple', 'updatemultiple'].includes(operation))
            frame.preValidationContext = preValidationSnapshot(
              frame,
              bridged ? { ...context.context, MessageName: messageNameOf(operation) } : context.context,
              context,
            );
          if (read) {
            if (multiple) {
              const nextQuery = answer.inputParameters?.values?.Query;
              replace(query, nextQuery);
              if (stage === 40 && answer.outputParameters?.values?.BusinessEntityCollection != null) {
                replace(collection, answer.outputParameters.values.BusinessEntityCollection);
                readResultChanged();
              }
            } else {
              const values = answer.inputParameters?.values;
              if (
                values?.Target?.$type !== 'EntityReference' ||
                typeof values?.ColumnSet?.allColumns !== 'boolean' ||
                !Array.isArray(values?.ColumnSet?.columns)
              )
                throw error('Retrieve must retain a typed Target and ColumnSet.', 'LocalPluginQueryUnsupported', 501);
              holder.target = cloneStateData(values.Target);
              replace(columns, { allColumns: values.ColumnSet.allColumns, columns: values.ColumnSet.columns });
              if (stage === 40 && answer.outputParameters?.values?.BusinessEntity != null) {
                holder.entity = cloneStateData(answer.outputParameters.values.BusinessEntity);
                readResultChanged();
              }
            }
            output = {};
          } else if (customApi) {
            frame.inputParameters = answer.inputParameters;
            frame.outputParameters = answer.outputParameters;
            messageParameters.inputParameters = frame.inputParameters;
            messageParameters.outputParameters = frame.outputParameters;
            output = {};
          } else if (bulk) {
            const next = answer.inputParameters?.values?.Targets;
            if (next?.$type !== 'EntityCollection' || !Array.isArray(next.entities))
              throw error('Bulk plugin must retain a typed Targets EntityCollection.');
            targets.splice(0, targets.length, ...cloneStateData(next.entities));
            output = {};
          } else if (association) {
            replace(associationParameters, answer.inputParameters?.values);
            output = {};
          } else if (operation !== 'delete') applyTargetEntity(answer.target);
          if (!read && !customApi && !bulk && !association) output = {};
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
          const sourceFrame = executionFrames.get(record);
          const baseDepth = Math.max(enterPluginExecution(), pluginInvocationDepth(store) + 1);
          handlerDepth = sourceFrame?.delegatedParentContext
            ? Math.max(baseDepth, sourceFrame.delegatedDepth ?? 0, sourceFrame.operationDepth ?? 0)
            : Math.max(
                baseDepth,
                sourceFrame?.operationDepth ?? 0,
                Number((store?.pluginParentContext ?? pluginInvocationSdkParent(store))?.values?.Depth ?? 0) + 1,
              );
          nested = true;
          if (handlerDepth > PLUGIN_MAX_DEPTH) throw new DataError(PLUGIN_DEPTH_MESSAGE, 400, 'LocalPluginDepth');
          executed = true;
          started = performance.now();
          startedAt = new Date((store?.clock ?? systemClock).now()).toISOString();
          // A trusted handler receives its registered images: the pre-image from the stored row, the
          // PostOperation post-image from the saved row, limited to the registered attributes.
          const image = (types, source) => {
            const spec = (item.images ?? []).find((entry) => types.includes(entry.type));
            if (!spec || !source) return undefined;
            return cloneStateData(imageAttributes(source, spec.attributes));
          };
          const handlerFrame = executionFrames.get(record) ?? {};
          executionFrames.set(record, handlerFrame);
          if (store)
            initializePluginOperation(
              handlerFrame,
              store,
              handlerFrame.delegatedParentContext ?? store.pluginParentContext ?? pluginInvocationSdkParent(store),
            );
          const contextArguments = {
            item,
            store,
            entity,
            operation,
            stage,
            target,
            targets,
            previousRecords,
            records,
            record,
            previous,
            identity,
            depth: handlerDepth,
            trace,
            changedAttributes,
            customApi,
            messageParameters,
            frame: handlerFrame,
            associationParameters,
            query,
            columns,
            holder,
            bridged,
          };
          let handlerContext = typed ? typedContext(contextArguments) : undefined;
          const invocationContext = handlerContext ?? (store ? typedContext(contextArguments) : undefined);
          const contextBefore = invocationContext
            ? cloneStateData({
                inputs: invocationContext.InputParameters,
                outputs: invocationContext.OutputParameters,
                shared: invocationContext.SharedVariables,
              })
            : undefined;
          const parent =
            handlerFrame.delegatedParentContext ??
            ((stage !== 10 &&
              !asyncExecution &&
              ['create', 'update', 'delete'].includes(operation) &&
              handlerFrame.preValidationContext) ||
              store?.pluginParentContext ||
              pluginInvocationSdkParent(store));
          const execution = pluginExecutionLifetime(
            store,
            handlerDepth,
            invocationContext && store
              ? () =>
                  handlerExecutionContext({
                    context: invocationContext,
                    before: contextBefore,
                    frame: handlerFrame,
                    store,
                    item,
                    entity,
                    operation,
                    target,
                    targets,
                    associationParameters,
                    query,
                    columns,
                    holder,
                    record,
                    previous,
                    previousRecords,
                    records,
                    customApi,
                    messageParameters,
                    parent,
                    bridged,
                  })
              : undefined,
            {
              sdkParentContext: () =>
                selectSdkEntryParent(pluginInvocationParent(store), handlerFrame.sdkFrameworkSource),
            },
          );
          if (handlerContext && store)
            completedContext = () =>
              handlerExecutionContext({
                context: handlerContext,
                before: contextBefore,
                frame: handlerFrame,
                store,
                item,
                entity,
                operation,
                target,
                targets,
                associationParameters,
                query,
                columns,
                holder,
                record,
                customApi,
                messageParameters,
                parent,
                bridged,
              });
          // The step span's input at level full is the context the handler receives (stepInput without one).
          if (invocationContext) span?.setInput(() => contextStepInput(invocationContext, store));
          try {
            output = inSpan(span, () =>
              execution.run(() =>
                handler({
                  // The operation's shared variables, the same collection as a plug-in type handler's
                  // context.SharedVariables: what a handler leaves there is what later steps of the operation see.
                  sharedVariables: invocationContext?.SharedVariables ?? {},
                  step: cloneStateData(item),
                  entity,
                  operation: bridged ? bridgedMessage : operation,
                  stage,
                  target: cloneStateData(target),
                  // A bridged multiple step's grouped view of the one record (plugin-single-multiple.mjs).
                  ...(bridged
                    ? {
                        targets: cloneStateData(
                          (bridgedSent = bridgedPlainInputs(
                            { store, entity, operation, stage, record, frame: handlerFrame },
                            { Target: target },
                          ).Targets),
                        ),
                        previousRecords: [previous ? cloneStateData(previous) : null],
                        records: stage === 40 ? [cloneStateData(record)] : [],
                      }
                    : {}),
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
                  ...(typed ? { context: handlerContext } : {}),
                  trace,
                  reject: (message) => {
                    throw new DataError(String(message), 400, 'PluginValidation', { declaredValidationMessage: true });
                  },
                }),
              ),
            );
          } finally {
            execution.close();
          }
          if (output?.then) {
            Promise.resolve(output).catch(() => {});
            throw error('Plugin handlers must return synchronously.', 'LocalPluginAsyncHandler');
          }
          if (handlerContext && bridged) {
            const sent = contextBefore.inputs?.Targets?.[0];
            unbridgeTargetInputs(
              { Targets: { $type: 'EntityCollection', entities: handlerContext.InputParameters?.Targets ?? [] } },
              { entity, id: sent?.id },
            );
            handlerContext = {
              ...handlerContext,
              InputParameters: unbridgedPlainInputs(handlerContext.InputParameters),
            };
            contextBefore.inputs = unbridgedPlainInputs(contextBefore.inputs);
          }
          // A step-id handler's sharedVariables edits join the collection as a plug-in type handler's do.
          if (
            handlerContext ||
            (invocationContext && !isDeepStrictEqual(contextBefore.shared, invocationContext.SharedVariables))
          ) {
            handlerFrame.sharedVariables = reconcilePluginMessageParameters(
              store,
              [],
              handlerFrame.sharedVariables,
              contextBefore.shared,
              invocationContext.SharedVariables,
            );
            handlerFrame.sharedVariables = canonicalTagVariables(handlerFrame.sharedVariables, handlerFrame.requestTag);
          }
          if (handlerContext) {
            if (customApi) {
              const inputSpecs =
                customApi.bindingType === 1
                  ? [...(customApi.parameters ?? []), { uniquename: 'Target', type: 5, logicalentityname: entity }]
                  : (customApi.parameters ?? []);
              handlerFrame.inputParameters = messageParameters.inputParameters = reconcilePluginMessageParameters(
                store,
                inputSpecs,
                handlerFrame.inputParameters,
                contextBefore.inputs,
                handlerContext.InputParameters,
              );
              handlerFrame.outputParameters = messageParameters.outputParameters = reconcilePluginMessageParameters(
                store,
                customApi.properties ?? [],
                handlerFrame.outputParameters,
                contextBefore.outputs,
                handlerContext.OutputParameters,
              );
            } else if (store) {
              const specs = ['create', 'update'].includes(operation)
                ? [{ uniquename: 'Target', type: 3, logicalentityname: entity }]
                : bulk
                  ? [{ uniquename: 'Targets', type: 4, logicalentityname: entity }]
                  : association
                    ? [{ uniquename: 'Target', type: 5 }]
                    : read && !multiple
                      ? [{ uniquename: 'Target', type: 5, logicalentityname: entity }]
                      : [];
              let priorInputs =
                handlerFrame.inputParameters ??
                (read
                  ? {
                      $type: 'ParameterCollection',
                      values: multiple
                        ? { Query: query }
                        : {
                            Target: holder.target,
                            ColumnSet: cloneStateData(columns),
                          },
                    }
                  : pluginMessageParameters(store, specs, contextBefore.inputs));
              if (['create', 'update'].includes(operation)) {
                const primary = store.resolveMapping(entity).idColumn;
                const current = recordToSdkEntity(
                  store,
                  entity,
                  {
                    ...contextBefore.inputs.Target,
                    ...(operation === 'create' && stage === 10 && Object.hasOwn(contextBefore.inputs.Target, primary)
                      ? {}
                      : { [primary]: record[primary] }),
                  },
                  operation === 'create' && stage === 10
                    ? { allColumns: false, columns: Object.keys(contextBefore.inputs.Target ?? {}) }
                    : { allColumns: true },
                );
                const priorTarget = handlerFrame.inputParameters?.values?.Target;
                priorInputs = {
                  ...priorInputs,
                  values: {
                    ...priorInputs.values,
                    Target: { ...priorTarget, ...current, id: priorTarget?.id ?? record[primary] },
                  },
                };
              }
              handlerFrame.inputParameters = reconcilePluginMessageParameters(
                store,
                specs,
                priorInputs,
                contextBefore.inputs,
                handlerContext.InputParameters,
              );
              handlerFrame.inputParametersStage = stage;
              handlerFrame.outputParameters = reconcilePluginMessageParameters(
                store,
                [],
                handlerFrame.outputParameters,
                contextBefore.outputs,
                handlerContext.OutputParameters,
              );
              if (['create', 'update'].includes(operation))
                applyTargetEntity(handlerFrame.inputParameters.values.Target);
              else if (bulk) {
                const next = handlerFrame.inputParameters.values.Targets;
                if (next?.$type !== 'EntityCollection' || !Array.isArray(next.entities))
                  throw error('Bulk plugin must retain a typed Targets EntityCollection.');
                targets.splice(0, targets.length, ...cloneStateData(next.entities));
              } else if (association) replace(associationParameters, handlerFrame.inputParameters.values);
              else if (read) {
                const values = handlerFrame.inputParameters.values;
                if (multiple) replace(query, values.Query);
                else {
                  if (
                    values.Target?.$type !== 'EntityReference' ||
                    typeof values.ColumnSet?.allColumns !== 'boolean' ||
                    !Array.isArray(values.ColumnSet?.columns)
                  )
                    throw error(
                      'Retrieve must retain a typed Target and ColumnSet.',
                      'LocalPluginQueryUnsupported',
                      501,
                    );
                  holder.target = cloneStateData(values.Target);
                  replace(columns, values.ColumnSet);
                }
                if (stage === 40) {
                  const outputValues = handlerFrame.outputParameters.values;
                  if (multiple && outputValues.BusinessEntityCollection != null)
                    replace(collection, outputValues.BusinessEntityCollection);
                  else if (!multiple && outputValues.BusinessEntity != null)
                    holder.entity = cloneStateData(outputValues.BusinessEntity);
                  readResultChanged();
                }
              }
            }
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
                  customApi
                    ? ['inputs', 'outputs', 'error']
                    : association
                      ? ['error']
                      : bulk || bridged
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
        if (customApi) {
          const frame = executionFrames.get(record);
          if (output?.inputs !== undefined) {
            if (stage === 40) throw error('Custom API input changes require a pre-operation stage.');
            frame.inputParameters = messageParameters.inputParameters = pluginMessageParameters(
              store,
              customApi.parameters ?? [],
              output.inputs,
            );
          }
          if (output?.outputs !== undefined)
            frame.outputParameters = messageParameters.outputParameters = pluginMessageParameters(
              store,
              customApi.properties ?? [],
              output.outputs,
            );
        }
        if (bulk && output?.targets !== undefined) {
          if (!Array.isArray(output.targets)) throw error('Bulk Targets changes require an array.');
          targets.splice(0, targets.length, ...cloneStateData(output.targets));
          const frame = executionFrames.get(record);
          if (frame?.inputParameters?.values?.Targets)
            frame.inputParameters.values.Targets.entities = cloneStateData(targets);
        }
        if (bridged && output?.targets !== undefined && operation !== 'delete') {
          if (!Array.isArray(output.targets)) throw error('Bulk Targets changes require an array.');
          const { Target: next } = unbridgeTargetInputs(
            { Targets: { $type: 'EntityCollection', entities: output.targets } },
            { entity, id: bridgedSent?.[0]?.id },
          );
          applyTargetEntity(next);
          const frame = executionFrames.get(record);
          if (frame?.inputParameters?.values?.Target?.$type === 'Entity')
            frame.inputParameters.values.Target.attributes = recordToSdkEntity(store, entity, target).attributes;
        }
        if (!multiple && output?.entityResult !== undefined) {
          if (stage !== 40) throw error('Retrieve Entity changes require PostOperation.');
          holder.entity = cloneStateData(output.entityResult);
          readResultChanged();
        }
        if (read && output?.query !== undefined) {
          if (!multiple) throw error('Query changes require RetrieveMultiple.');
          replace(query, output.query);
        }
        if (read && output?.collection !== undefined) {
          if (stage !== 40) throw error('Collection changes require PostOperation.');
          replace(collection, output.collection);
          readResultChanged();
        }
        if (output?.target !== undefined) {
          if (operation === 'delete') throw error('Delete target field changes require a typed reference.');
          if (!output.target || typeof output.target !== 'object' || Array.isArray(output.target))
            throw error('Plugin target must be a field map.');
          for (const [name, value] of Object.entries(output.target)) {
            if (
              !/^[a-z][a-z0-9_]*$/i.test(name) ||
              ['__proto__', 'prototype', 'constructor'].includes(name.toLowerCase())
            )
              throw error('Invalid plugin target column.');
            const retainsIdentity = retainsEmptyPrimaryAttribute(name, value);
            target[name] = cloneStateData(value);
            if (stage !== 40 && !retainsIdentity) record[name] = cloneStateData(value);
          }
          const frame = executionFrames.get(record);
          if (frame?.inputParameters?.values?.Target?.$type === 'Entity')
            frame.inputParameters.values.Target.attributes = recordToSdkEntity(store, entity, target).attributes;
        }
        if (completedContext && stage === 10 && ['create', 'update', 'delete'].includes(operation)) {
          const frame = executionFrames.get(record),
            snapshot = completedContext();
          frame.preValidationContext = preValidationSnapshot(
            frame,
            bridged ? { ...snapshot.values, MessageName: messageNameOf(operation) } : snapshot.values,
          );
        }
        if (executed) journal(null);
        if (executed || item.mode === 'mock') onStepExecuted?.(item);
        if (item.mode !== 'clr')
          note('PLUGIN_STEP_SIMULATED', `Local ${item.mode} completed; compiled .NET was not executed.`);
        // A CLR step's output is the host bridge answer (set above); the others' the frame after the step.
        if (item.mode !== 'clr')
          span?.output(() => ({
            outputParameters:
              executionFrames.get(record)?.outputParameters?.values ??
              (stage === 40 && operation === 'create' && recordId != null ? { id: recordId } : {}),
            sharedVariables: sharedValues(executionFrames.get(record)),
            output: output ?? null,
          }));
        span?.end();
      } catch (cause) {
        const depth = stepDepth();
        // A plug-in type handler's exception surfaces as the documented fault; the write rolls back with the throw.
        const failure = typed && !(cause instanceof DataError) ? pluginFault(cause, item, stage, depth) : cause;
        if (executed) journal(failure);
        store?.counters?.increment('plugins.failures');
        // The fault identity (type, code, OperationStatus, plug-in type, step, stage, depth) travels on the error to every
        // span it fails; this step's span records it.
        const identity = notePluginFault(failure, { pluginType: item.typeName ?? null, step: item.id, stage, depth });
        failStep(span, failure, identity);
        note('PLUGIN_STEP_REJECTED', failure.message);
        throw failure;
      } finally {
        if (nested) leavePluginExecution();
      }
    }
    return cloneStateData(executionFrames.get(record) ?? {});
  };
  if (!tracing) return run(0);
  return tracing.wrap(
    {
      kind: 'plugin-stage',
      name: `${customApi?.name ?? messageNameOf(operation)} ${entity} · ${STAGE_NAMES[stage] ?? `Stage ${stage}`}`,
      module: 'plugins',
      operation,
      entity,
      recordId,
      attributes: { stage, mode: asyncExecution ? 'async' : 'sync', matched: matched.length, asyncExecution },
    },
    () => run(0),
  );
}
