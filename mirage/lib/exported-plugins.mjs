import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DataError } from './data-error.mjs';
import { parseSolutionXml } from './solution-xml.mjs';

const canonical = value => String(value ?? '').trim().replace(/[{}]/g, '').toLowerCase();
const nodes = (node, name) => {
  if (!node) return [];
  return [...(node.name?.toLowerCase() === name.toLowerCase() ? [node] : []), ...(node.children ?? []).flatMap(child => nodes(child, name))];
};
const child = (node, name) => node?.children?.find(item => item.name.toLowerCase() === name.toLowerCase());
const attr = (node, name) => node?.attrs?.[Object.keys(node.attrs ?? {}).find(key => key.toLowerCase() === name.toLowerCase())];
const text = (node, name) => child(node, name)?.text.trim();
const value = (node, name) => text(node, name) || attr(node, name);
const lookupId = (node, name) => canonical(value(node, name) || text(child(node, name), name));
const lookupName = (node, name) => text(child(node, name), 'Name');
const numeric = value => value === undefined || value === '' ? null : Number.isInteger(Number(value)) ? Number(value) : null;
const error = (message, code = 'LocalPluginInvalid', status = 400) => new DataError(message, status, code);
const stages = { 10: 'PreValidation', 20: 'PreOperation', 40: 'PostOperation' };

/** Facts only. Configuration values are not indexed or exposed; DLLs and .NET code are never read or executed. */
export function parsePluginDocument(xml) {
  const root = parseSolutionXml(xml);
  const assemblies = [], types = [], steps = [], messages = [];
  for (const message of nodes(root, 'SdkMessage')) {
    const id = canonical(value(message, 'SdkMessageId')), name = value(message, 'Name');
    if (id && name) messages.push({ id, name });
  }
  for (const assembly of nodes(root, 'PluginAssembly')) {
    const id = canonical(value(assembly, 'PluginAssemblyId'));
    if (!id) continue;
    const fullName = value(assembly, 'FullName') ?? null;
    assemblies.push({ id, name: value(assembly, 'Name') ?? fullName?.split(',')[0].trim() ?? '', fullName, version: value(assembly, 'Version') ?? /(?:^|,)\s*Version=([^,]+)/i.exec(fullName ?? '')?.[1] ?? null, isolationMode: numeric(value(assembly, 'IsolationMode')), sourceType: numeric(value(assembly, 'SourceType')), binaryPath: value(assembly, 'FileName') ?? null });
    for (const type of nodes(assembly, 'PluginType')) {
      const typeId = canonical(value(type, 'PluginTypeId'));
      if (typeId) types.push({ id: typeId, assemblyId: id, name: value(type, 'TypeName') || value(type, 'Name') || '', friendlyName: value(type, 'FriendlyName') ?? null });
    }
  }
  for (const type of nodes(root, 'PluginType')) {
    const id = canonical(value(type, 'PluginTypeId'));
    if (id && !types.some(item => item.id === id)) types.push({ id, assemblyId: lookupId(type, 'PluginAssemblyId') || null, name: value(type, 'TypeName') || value(type, 'Name') || '', friendlyName: value(type, 'FriendlyName') ?? null });
  }
  for (const step of nodes(root, 'SdkMessageProcessingStep')) {
    const id = canonical(value(step, 'SdkMessageProcessingStepId'));
    if (!id) continue;
    const filter = child(step, 'SdkMessageFilterId');
    steps.push({
      id, name: value(step, 'Name') || id, typeId: lookupId(step, 'PluginTypeId') || lookupId(step, 'EventHandler') || null,
      typeName: value(step, 'PluginTypeName') || lookupName(step, 'PluginTypeId') || lookupName(step, 'EventHandler') || null,
      messageId: lookupId(step, 'SdkMessageId') || null, message: value(step, 'SdkMessageName') || lookupName(step, 'SdkMessageId') || value(step, 'MessageName') || null,
      entity: canonical(value(step, 'PrimaryEntity') || value(step, 'PrimaryEntityName') || value(step, 'PrimaryEntityTypeCode') || value(step, 'PrimaryObjectTypeCode') || value(filter, 'PrimaryObjectTypeCode')) || null,
      stage: numeric(value(step, 'Stage')), rank: numeric(value(step, 'Rank')), mode: numeric(value(step, 'Mode')),
      supportedDeployment: numeric(value(step, 'SupportedDeployment')), enabled: numeric(value(step, 'StateCode') ?? '0') === 0,
      filteringAttributes: String(value(step, 'FilteringAttributes') ?? '').split(',').map(canonical).filter(Boolean),
      impersonatingUserId: lookupId(step, 'ImpersonatingUserId') || null,
      images: nodes(step, 'SdkMessageProcessingStepImage').map(image => ({ name: value(image, 'Name') || '', alias: value(image, 'EntityAlias') || '', type: numeric(value(image, 'ImageType')), attributes: String(value(image, 'Attributes') ?? '').split(',').map(canonical).filter(Boolean) })),
    });
  }
  return { assemblies, types, steps, messages };
}

/** Selected solution layer order wins, with explicit provenance and no inferred deployed state. */
export function importSolutionPlugins(layers = [], { sdkMessages = {} } = {}) {
  const maps = { assemblies: new Map(), types: new Map(), steps: new Map(), messages: new Map() };
  const diagnostics = [], fingerprint = createHash('sha256');
  for (const layer of layers) for (const document of layer.documents ?? []) {
    const facts = document.facts.plugins;
    if (!facts) continue;
    fingerprint.update(document.file).update(document.hash ?? '');
    for (const kind of Object.keys(maps)) for (const record of facts[kind] ?? []) {
      if (maps[kind].has(record.id)) diagnostics.push({ code: 'PLUGIN_SOURCE_LAYER_SELECTED', id: record.id, sourceFile: document.file, message: 'The last selected solution layer supplies this registration; deployed state is unknown.' });
      maps[kind].set(record.id, { ...record, sourceFile: document.file });
    }
  }
  const steps = [...maps.steps.values()].map(step => {
    const namedTypes = [...maps.types.values()].filter(item => step.typeName && item.name === step.typeName);
    const type = maps.types.get(step.typeId) ?? (namedTypes.length === 1 ? namedTypes[0] : null);
    const assembly = type && maps.assemblies.get(type.assemblyId);
    const sourceMessage = maps.messages.get(step.messageId);
    const observedMessage = sdkMessages[step.messageId];
    const message = step.message || sourceMessage?.name || observedMessage?.name || null;
    const resolved = { ...step, message, messageEvidence: step.message ? 'exported-step' : sourceMessage ? 'exported-sdk-message' : observedMessage ? 'project-observation' : 'unresolved', messageSourceFile: sourceMessage?.sourceFile ?? null, messageObservation: observedMessage?.evidence ?? null, typeName: type?.name ?? step.typeName, typeId: type?.id ?? step.typeId, assemblyId: assembly?.id ?? type?.assemblyId ?? null, assemblyName: assembly?.name ?? null, typeSourceFile: type?.sourceFile ?? null, assemblySourceFile: assembly?.sourceFile ?? null, stageName: stages[step.stage] ?? `Stage ${step.stage ?? 'unknown'}` };
    return { ...resolved, unsupported: pluginUnsupported(resolved) };
  });
  for (const step of steps) if (step.unsupported) diagnostics.push({ code: 'PLUGIN_STEP_UNSUPPORTED', stepId: step.id, sourceFile: step.sourceFile, message: step.unsupported });
  fingerprint.update(JSON.stringify(sdkMessages));
  return { assemblies: [...maps.assemblies.values()], types: [...maps.types.values()], steps, diagnostics, fingerprint: fingerprint.digest('hex') };
}

/** Explicit source navigation only: inspect file identity, never parse or execute C#. */
export async function resolvePluginSourceFiles(plugins, mappings = {}, defaultRoot) {
  const sourceRoots = new Set(), sourceFiles = new Set();
  const typeSources = new Map();
  for (const [typeName, mapping] of Object.entries(mappings)) {
    let sourceFile = null, issue = null;
    try {
      const relative = String(mapping.path ?? '').replace(/\\/g, '/');
      if (!relative.endsWith('.cs') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || /^(?:\.git|\.paqvilo|node_modules|bin|obj)$/i.test(part))) throw new Error('Use a relative .cs path inside the declared source root, excluding local/runtime directories.');
      if (!mapping.root && !defaultRoot) throw new Error('No trusted source root is available for this mapping.');
      const root = await fs.realpath(mapping.root ?? defaultRoot);
      const candidate = path.resolve(root, relative);
      const real = await fs.realpath(candidate);
      const bound = path.relative(root, real);
      if (!bound || bound === '..' || bound.startsWith('..' + path.sep) || path.isAbsolute(bound)) throw new Error('The mapped C# source resolves outside its declared source root.');
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('The mapped C# source must be a regular file of at most 1 MiB.');
      if (!plugins.types.some(type => type.name === typeName)) throw new Error('This exact plugin type is not present in the selected solution exports.');
      sourceFile = real;
      sourceFiles.add(real); sourceRoots.add(path.dirname(real));
    } catch (cause) {
      issue = cause.message;
      plugins.diagnostics.push({ code: 'PLUGIN_SOURCE_UNRESOLVED', typeName, message: issue });
    }
    typeSources.set(typeName, { codeSourceFile: sourceFile, codeSourceEvidence: mapping.evidence, ...(issue ? { codeSourceDiagnostic: issue } : {}) });
  }
  plugins.types = plugins.types.map(type => ({ ...type, ...typeSources.get(type.name) }));
  plugins.steps = plugins.steps.map(step => ({ ...step, ...typeSources.get(step.typeName) }));
  plugins.sourceRoots = [...sourceRoots]; plugins.sourceFiles = [...sourceFiles];
  plugins.fingerprint = createHash('sha256').update(plugins.fingerprint).update(JSON.stringify([...typeSources])).digest('hex');
  return plugins;
}

export function pluginUnsupported(step) {
  if (step.mode !== 0) return step.mode === 1 ? 'Asynchronous plugin execution is not simulated.' : 'Execution mode is missing or unsupported.';
  if (!stages[step.stage]) return 'Only synchronous stages 10, 20 and 40 are simulated.';
  if (!step.message) return 'The SDK message name is not exported. Add evidence-backed observed.sdkMessages or exported SDK message metadata; the step label is not used to guess behavior.';
  if (!['create', 'update', 'delete'].includes(String(step.message ?? '').toLowerCase())) return 'This message has no local CRUD pipeline.';
  if (!step.entity || !/^[a-z][a-z0-9_]*$/i.test(step.entity)) return 'An explicit logical table binding is required.';
  if (!Number.isInteger(step.rank)) return 'An explicit execution rank is required.';
  if (![0, 2].includes(step.supportedDeployment)) return 'Server deployment is missing or unsupported.';
  if (step.impersonatingUserId) return 'Impersonated execution requires an explicit identity adapter.';
  if (step.images?.length) return 'Registered pre/post images require an explicit image adapter.';
  if (!step.typeName || !step.assemblyId) return 'The exported plugin type or assembly dependency is unresolved.';
  return null;
}

/** Trusted project packs map exact exported step IDs to synchronous functions. */
export function pluginHandlers(packs = []) {
  const result = new Map();
  for (const pack of packs) {
    if (pack.pluginSteps === undefined) continue;
    if (!pack.pluginSteps || typeof pack.pluginSteps !== 'object' || Array.isArray(pack.pluginSteps)) throw error(`Data pack ${pack.id}: pluginSteps must map exported step IDs to synchronous functions.`);
    for (const [id, handler] of Object.entries(pack.pluginSteps)) {
      const key = canonical(id);
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(key) || typeof handler !== 'function' || handler.constructor?.name === 'AsyncFunction') throw error(`Data pack ${pack.id}: invalid synchronous plugin step handler.`);
      if (result.has(key)) throw error(`Ambiguous plugin handler for ${key}.`);
      result.set(key, handler);
    }
  }
  return result;
}

export function pluginCatalogue({ plugins, handlers = new Map(), overrides = {} }) {
  return (plugins?.steps ?? []).map(step => {
    const key = `plugin-step:${step.id}`, configuration = overrides[key] ?? null, registered = handlers.has(step.id);
    return { ...step, key, kind: 'plugin-step', registered, mode: configuration?.mode ?? (registered ? 'handler' : 'placeholder'), configuration, configurable: step.enabled && !step.unsupported, definitionAvailable: false, path: null, contract: { entity: step.entity, message: step.message, stage: step.stage, stageName: step.stageName, rank: step.rank, mode: step.mode, filteringAttributes: step.filteringAttributes, assemblyName: step.assemblyName, typeName: step.typeName, unsupported: step.unsupported, boundary: 'All local synchronous stages run in one rollback transaction after portal authorization; compiled .NET is never executed.' } };
  });
}

/** A deliberately small synchronous contract. PostOperation can reject, but cannot silently persist target changes. */
export function runPluginPhase({ items, handlers, entity, operation, stage, target, record, previous, identity, changedAttributes, diagnostic = () => {} }) {
  const attributes = new Set(changedAttributes.map(canonical));
  const matched = items.filter(item => item.enabled && item.entity === entity && String(item.message).toLowerCase() === operation && item.stage === stage && (operation !== 'update' || !item.filteringAttributes.length || item.filteringAttributes.some(name => attributes.has(name)))).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  for (const item of matched) {
    const note = (code, message) => diagnostic({ code, severity: code === 'PLUGIN_STEP_REJECTED' ? 'error' : code === 'PLUGIN_STEP_SIMULATED' ? 'info' : 'warning', stepId: item.id, name: item.name, entity, operation, stage, sourceFile: item.sourceFile, message });
    if (item.unsupported) { note('PLUGIN_STEP_UNSUPPORTED', item.unsupported); continue; }
    if (item.mode === 'placeholder') { note('PLUGIN_STEP_PLACEHOLDER', 'This exported registration was discovered. Its business logic was skipped; configure a local mock or trusted handler.'); continue; }
    let output;
    try {
      if (item.mode === 'mock') {
        if ((item.configuration?.status ?? 200) >= 400) throw error(item.configuration?.body?.error?.message || `Plugin mock ${item.name} rejected the write.`, 'PluginValidation');
        output = item.configuration?.body ?? {};
      } else if (item.mode === 'handler') {
        const handler = handlers.get(item.id);
        if (!handler) throw error(`No trusted handler for plugin step ${item.id}.`);
        output = handler({ step: structuredClone(item), entity, operation, stage, target: structuredClone(target), record: structuredClone(record), previous: previous ? structuredClone(previous) : null, identity: structuredClone(identity), changedAttributes: [...changedAttributes], reject: message => { throw error(message, 'PluginValidation'); } });
        if (output?.then) { Promise.resolve(output).catch(() => {}); throw error('Plugin handlers must return synchronously.', 'LocalPluginAsyncHandler'); }
      } else throw error('Compiled .NET plugin execution is not supported locally.', 'LocalPluginUnsupported');
      if (output !== undefined && (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).some(key => !['target', 'error'].includes(key)))) throw error('Plugin result must contain only target field changes or an error.');
      if (output?.error) throw error(String(output.error.message || 'Plugin rejected the write.'), 'PluginValidation');
      if (output?.target !== undefined) {
        if (stage === 40 || operation === 'delete') throw error('PostOperation and Delete target changes cannot be persisted by this adapter.');
        if (!output.target || typeof output.target !== 'object' || Array.isArray(output.target)) throw error('Plugin target must be a field map.');
        for (const [name, value] of Object.entries(output.target)) {
          if (!/^[a-z][a-z0-9_]*$/i.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name.toLowerCase())) throw error('Invalid plugin target column.');
          target[name] = structuredClone(value);
          record[name] = structuredClone(value);
        }
      }
      note('PLUGIN_STEP_SIMULATED', `Local ${item.mode} completed; compiled .NET was not executed.`);
    } catch (cause) { note('PLUGIN_STEP_REJECTED', cause.message); throw cause; }
  }
}
