import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DataError } from './data-error.mjs';
import { parseSolutionXml } from './solution-xml.mjs';
import {clrContext,clrExecutionDepth,executeClrPlugin} from './plugin-clr.mjs';
import {sdkValueToRecord} from './local-organization-service.mjs';
import {populatePluginSystemOutputs} from './plugin-response.mjs';
const executionFrames=new WeakMap();

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
    const primary=canonical(value(step,'PrimaryEntity')||value(step,'PrimaryEntityName')||value(step,'PrimaryEntityTypeCode')||value(step,'PrimaryObjectTypeCode')||value(filter,'PrimaryObjectTypeCode'));
    const messageFilterId=lookupId(step,'SdkMessageFilterId')||null;
    const unfiltered=(primary==='none'||Boolean(filter&&!messageFilterId&&!(filter.text??'').trim()&&!filter.children?.length))&&!messageFilterId;
    steps.push({
      id, name: value(step, 'Name') || id, typeId: lookupId(step, 'PluginTypeId') || lookupId(step, 'EventHandler') || null,
      typeName: value(step, 'PluginTypeName') || lookupName(step, 'PluginTypeId') || lookupName(step, 'EventHandler') || null,
      messageId: lookupId(step, 'SdkMessageId') || null, message: value(step, 'SdkMessageName') || lookupName(step, 'SdkMessageId') || value(step, 'MessageName') || null,
      entity: primary&&primary!=='none'?primary:null,messageFilterId,unfiltered,
      stage: numeric(value(step, 'Stage')), rank: numeric(value(step, 'Rank')), mode: numeric(value(step, 'Mode')),
      supportedDeployment: numeric(value(step, 'SupportedDeployment')), enabled: numeric(value(step, 'StateCode') ?? '0') === 0,
      filteringAttributes: String(value(step, 'FilteringAttributes') ?? '').split(',').map(canonical).filter(Boolean),
      impersonatingUserId: lookupId(step, 'ImpersonatingUserId') || null,
      images: nodes(step, 'SdkMessageProcessingStepImage').map(image => ({ name: value(image, 'Name') || '', alias: value(image, 'EntityAlias') || '', type: numeric(value(image, 'ImageType')), attributes: String(value(image, 'Attributes') ?? '').split(',').map(canonical).filter(Boolean) })),
    });
  }
  return { assemblies, types, steps, messages };
}

/**
 * Well-known SDK message ids: the platform ships the sdkmessage rows, so these ids are the same
 * in every Dataverse organisation (confirmed by the baseline read-back of PAC-exported steps,
 * examples/project/baseline/plugins-readback.json). A project's observed.sdkMessages adds or
 * overrides entries for messages not listed here.
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
    const observedMessage = sdkMessages[step.messageId] ?? (SDK_MESSAGES[step.messageId] ? { name: SDK_MESSAGES[step.messageId], evidence: 'platform SDK message id' } : undefined);
    const message = step.message || sourceMessage?.name || observedMessage?.name || null;
    const resolved = { ...step, message, messageEvidence: step.message ? 'exported-step' : sourceMessage ? 'exported-sdk-message' : observedMessage ? (sdkMessages[step.messageId] ? 'project-observation' : 'platform-sdk-message') : 'unresolved', messageSourceFile: sourceMessage?.sourceFile ?? null, messageObservation: observedMessage?.evidence ?? null, typeName: type?.name ?? step.typeName, typeId: type?.id ?? step.typeId, assemblyId: assembly?.id ?? type?.assemblyId ?? null, assemblyName: assembly?.name ?? null, typeSourceFile: type?.sourceFile ?? null, assemblySourceFile: assembly?.sourceFile ?? null, stageName: stages[step.stage] ?? `Stage ${step.stage ?? 'unknown'}` };
    return { ...resolved, unsupported: pluginUnsupported(resolved) };
  });
  for (const step of steps) if (step.unsupported) diagnostics.push({ code: 'PLUGIN_STEP_UNSUPPORTED', stepId: step.id, sourceFile: step.sourceFile, message: step.unsupported });
  fingerprint.update(JSON.stringify(sdkMessages));
  return { assemblies: [...maps.assemblies.values()], types: [...maps.types.values()], steps, diagnostics, fingerprint: fingerprint.digest('hex') };
}

/** Resolve only an explicitly mapped, confined regular C# source file. */
export async function resolvePluginSourcePath(mapping, defaultRoot) {
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
  return real;
}

/** Explicit source navigation only: inspect file identity, never parse or execute C#. */
export async function resolvePluginSourceFiles(plugins, mappings = {}, defaultRoot) {
  const sourceRoots = new Set(), sourceFiles = new Set();
  const typeSources = new Map();
  for (const [typeName, mapping] of Object.entries(mappings)) {
    let sourceFile = null, issue = null;
    try {
      const real = await resolvePluginSourcePath(mapping, defaultRoot);
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

export function pluginUnsupported(step,{images=false}={}) {
  if (![0,1].includes(step.mode)) return 'Execution mode is missing or unsupported.';
  if(step.mode===1&&(step.stage!==40||!['create','update','delete'].includes(String(step.message).toLowerCase())))return 'Asynchronous execution supports post-commit stage 40 Create/Update/Delete registrations.';
  if (!stages[step.stage]) return 'Only synchronous stages 10, 20 and 40 are simulated.';
  if (!step.message) return 'The SDK message name is not exported. Add evidence-backed observed.sdkMessages or exported SDK message metadata; the step label is not used to guess behavior.';
  if (!['create', 'update', 'delete','retrieve','retrievemultiple','createmultiple','updatemultiple','associate','disassociate'].includes(String(step.message ?? '').toLowerCase())) return 'This message has no configured local execution pipeline.';
  if(step.unfiltered===true&&(step.entity||step.messageFilterId||String(step.message).toLowerCase()!=='retrievemultiple'||step.mode!==0))return 'Unfiltered execution requires an explicit null filter on synchronous RetrieveMultiple.';
  if (step.unfiltered!==true&&(!step.entity || !/^[a-z][a-z0-9_]*$/i.test(step.entity))) return 'An explicit logical table binding is required.';
  if (!Number.isInteger(step.rank)) return 'An explicit execution rank is required.';
  if (![0, 2].includes(step.supportedDeployment)) return 'Server deployment is missing or unsupported.';
  if (step.impersonatingUserId) return 'Impersonated execution requires an explicit identity adapter.';
  if (step.images?.length&&!images) return 'Registered pre/post images require an explicit image adapter.';
  if(images&&(step.images??[]).some(image=>![0,1,2].includes(image.type)||!image.alias&&!image.name))return 'Registered image type or alias is unresolved.';
  if(images&&new Set((step.images??[]).map(image=>image.alias||image.name)).size!==(step.images??[]).length)return 'Registered image aliases must be unique.';
  if (!step.typeName || !step.assemblyId) return 'The exported plugin type or assembly dependency is unresolved.';
  return null;
}

/** Trusted project packs map exact exported step IDs to synchronous functions. */
export function pluginStepMatchesEntity(step,entity){return step.entity===entity||step.unfiltered===true&&step.entity==null&&step.messageFilterId==null&&String(step.message).toLowerCase()==='retrievemultiple'&&(step.contract?.mode??step.mode)===0;}
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

export function pluginCatalogue({ plugins, handlers = new Map(), runtimes = new Map(),descriptors=new Map(), overrides = {} }) {
  return (plugins?.steps ?? []).map(step => {
    const key = `plugin-step:${step.id}`, configuration = overrides[key] ?? null, registered = handlers.has(step.id);
    const runtime=runtimes.get(step.id),descriptor=descriptors.get(step.id),unsupported=pluginUnsupported(step,{images:Boolean(runtime||descriptor||handlers.has(step.id))});
    const clrAvailable=Boolean((runtime?.descriptor??descriptor)?.typeName===step.typeName);
    return { ...step,unsupported,key, kind: 'plugin-step', registered,clrAvailable,clrPrepared:Boolean(runtime),clrProvenance:runtime?.provenance??null, mode: configuration?.mode ?? (registered ? 'handler' : 'placeholder'), configuration, configurable: step.enabled, definitionAvailable: clrAvailable, path: null, contract: { entity: step.entity, message: step.message, stage: step.stage, stageName: step.stageName, rank: step.rank, mode: step.mode, filteringAttributes: step.filteringAttributes, assemblyName: step.assemblyName, typeName: step.typeName, unsupported, boundary: 'Top-level PreValidation SDK requests commit independently; PreOperation/PostOperation and nested PreValidation join the caller transaction. Read observer writes require a serialized readOperation boundary and explicit backend grants; top-level read SDK writes commit independently. CLR requires an explicitly trusted original assembly and a separate project backend security profile.' } };
  });
}

function matchingPluginSteps(items, { entity, operation, stage, changedAttributes = [], asyncExecution = false }) {
  const attributes = new Set(changedAttributes.map(canonical));
  return items.filter(item => item.enabled && (item.contract?.mode === 1) === asyncExecution && pluginStepMatchesEntity(item, entity) && String(item.message).toLowerCase() === operation && item.stage === stage && (!['update', 'updatemultiple'].includes(operation) || !item.filteringAttributes.length || item.filteringAttributes.some(name => attributes.has(name))));
}

/** Handlers and CLR can make arbitrary backend writes. Mocks only change the tracked target or response. */
export function pluginPhaseRequiresCheckpoint(items, context) {
  return matchingPluginSteps(items, context).some(item => ['handler', 'clr'].includes(item.mode) && !item.unsupported);
}

/** A deliberately small synchronous contract. PostOperation can reject, but cannot silently persist target changes. */
export function runPluginPhase({ items, handlers, runtimes=new Map(),store, entity, operation, stage, target, targets, previousRecords, records, associationParameters, record, previous, identity, changedAttributes=[],query,collection,columns,holder,portalRequest=false,asyncExecution=false,initialFrame, diagnostic = () => {} }) {
  // A saved row can be reused by a later Delete; its previous request frame
  // must not supply shared variables, correlation or parent context to this one.
  if(stage===10&&!asyncExecution&&!['retrieve','retrievemultiple'].includes(operation))executionFrames.set(record,{});
  if(initialFrame)executionFrames.set(record,structuredClone(initialFrame));
  const read=['retrieve','retrievemultiple'].includes(operation),multiple=operation==='retrievemultiple',bulk=['createmultiple','updatemultiple'].includes(operation),association=['associate','disassociate'].includes(operation);
  const matched = matchingPluginSteps(items, { entity, operation, stage, changedAttributes, asyncExecution }).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  // Mock/handler read outputs also belong to the SDK response frame. Keep ordinary
  // reads without an executing observer on their existing projection path.
  if(stage===40&&read&&!asyncExecution&&!executionFrames.has(record)&&matched.some(item=>['clr','handler','mock'].includes(item.mode)&&(!item.unsupported||item.mode==='mock')))executionFrames.set(record,{});
  if(stage===40&&store&&!asyncExecution&&executionFrames.has(record)){
    const frame=executionFrames.get(record),primary=store.resolveMapping(entity).idColumn;
    const values=operation==='create'?{id:{$type:'Guid',value:record[primary]}}:operation==='createmultiple'?{Ids:{$type:'GuidArray',values:record.bulkIds.map(value=>({$type:'Guid',value}))}}:operation==='retrieve'?{BusinessEntity:holder.entity}:multiple?{BusinessEntityCollection:collection}:{};
    populatePluginSystemOutputs(frame,values);executionFrames.set(record,frame);
  }
  const replace=(object,value)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw error('Invalid plugin query/collection result.');for(const key of Object.keys(object))delete object[key];Object.assign(object,structuredClone(value));};
  const readResultChanged=()=>{const frame=executionFrames.get(record),key=multiple?'BusinessEntityCollection':'BusinessEntity';if(frame?.outputParameters?.values&&Object.hasOwn(frame.outputParameters.values,key))frame.outputParameters.values[key]=multiple?collection:holder.entity;};
  for (const item of matched) {
    const note = (code, message) => diagnostic({ code, severity: code === 'PLUGIN_STEP_REJECTED' ? 'error' : code === 'PLUGIN_STEP_SIMULATED' ? 'info' : 'warning', stepId: item.id, name: item.name, entity, operation, stage, sourceFile: item.sourceFile, message });
    if(item.mode==='disabled'){note('PLUGIN_STEP_DISABLED','This step is explicitly disabled in local simulator configuration.');continue;}
    if(item.mode==='mock'){if((item.configuration?.status??200)>=400||item.configuration?.body?.error){const message=item.configuration?.body?.error?.message||'Explicit plugin mock rejected.';note('PLUGIN_STEP_REJECTED',message);throw error(message,'PluginValidation');}if(item.unsupported)note('PLUGIN_STEP_SIMULATED','Explicit mock chosen for an unsupported source execution contract; original logic was not executed.');}
    if (item.unsupported&&item.mode!=='mock') { note('PLUGIN_STEP_UNSUPPORTED', item.unsupported); if(['clr','handler'].includes(item.mode))throw error(item.unsupported,'LocalPluginUnsupported',501);continue; }
    if (item.mode === 'placeholder') { note('PLUGIN_STEP_PLACEHOLDER', 'This exported registration was discovered. Its business logic was skipped; configure a local mock or trusted handler.'); continue; }
    let output;
    try {
      if(item.mode==='clr'){
        const runtime=runtimes.get(item.id);if(!runtime||!item.clrAvailable||!store)throw error('No trusted original CLR runtime is registered for this exact exported type/step.','LocalPluginClrUnavailable',501);
        let frame=executionFrames.get(record);if(!frame){frame={};executionFrames.set(record,frame);}if(!frame.sharedVariables){const inherited=store.pluginParentContext?.values?.SharedVariables?.values,tag=store.pluginSdkTag??inherited?.tag;if(tag!==undefined)frame.sharedVariables={$type:'ParameterCollection',values:{tag}};}
        frame.portalContactId=portalRequest&&!store.pluginParentContext&&!identity?.admin?(identity?.contactId??identity?.id??null):null;
        frame.portalRequest=portalRequest&&!store.pluginParentContext&&!identity?.admin;
        if(read){frame.query=query;frame.collection=collection;frame.entity=holder?.entity;frame.columns=columns;}
        if(bulk){frame.targets=targets;frame.previousRecords=previousRecords;frame.records=records;}
        if(association)frame.associationParameters=associationParameters;
        const depth=clrExecutionDepth()+1,context=clrContext({runtime,store,step:item,entity,operation,stage,target,record,previous,frame,depth});
        const answer=executeClrPlugin(runtime,context,{store,diagnostic:entry=>diagnostic({...entry,stepId:item.id,entity,operation,stage})});
        if(Object.hasOwn(frame.sharedVariables?.values??{},'tag')&&answer.sharedVariables?.values?.tag!==frame.sharedVariables.values.tag)throw error('The request tag is immutable.','LocalPluginTagImmutable',409);
        frame.sharedVariables=answer.sharedVariables;frame.outputParameters=answer.outputParameters;
        // CRUD PreValidation variables belong to the parent context of later
        // stages, while PreOperation and PostOperation share their own collection.
        if(stage===10&&['create','update','delete'].includes(operation))frame.preValidationContext={$type:'ExecutionContext',values:{...structuredClone(context.context),InputParameters:structuredClone(answer.inputParameters),OutputParameters:structuredClone(answer.outputParameters),SharedVariables:structuredClone(answer.sharedVariables),PreEntityImages:{$type:'EntityImageCollection',values:structuredClone(context.preImages)},PostEntityImages:{$type:'EntityImageCollection',values:structuredClone(context.postImages)}}};
        if(read){if(multiple){const nextQuery=answer.inputParameters?.values?.Query;if(stage!==40)replace(query,nextQuery);else if(answer.outputParameters?.values?.BusinessEntityCollection!=null){replace(collection,answer.outputParameters.values.BusinessEntityCollection);readResultChanged();}}else if(stage===40&&answer.outputParameters?.values?.BusinessEntity!=null){holder.entity=structuredClone(answer.outputParameters.values.BusinessEntity);readResultChanged();}output={};}
        else if(bulk){const next=answer.inputParameters?.values?.Targets;if(next?.$type!=='EntityCollection'||!Array.isArray(next.entities))throw error('Bulk plugin must retain a typed Targets EntityCollection.');if(stage!==40)targets.splice(0,targets.length,...structuredClone(next.entities));output={};}
        else if(association){if(JSON.stringify(answer.inputParameters?.values)!==JSON.stringify(associationParameters))throw error('Association parameter mutation needs a source-qualified adapter.','LocalPluginSdkUnsupported',501);output={};}
        else if(stage!==40&&operation!=='delete'&&Object.keys(target).some(key=>!Object.hasOwn(answer.target?.attributes??{},key)))throw error('Original plugin removed a Target attribute; target removal requires an explicit mutation adapter.','LocalPluginSdkUnsupported',501);
        if(!read&&!bulk&&!association)output=stage===40||operation==='delete'?{}:{target:sdkValueToRecord(answer.target)};
        diagnostic({code:'PLUGIN_STEP_CLR_EXECUTED',severity:'info',stepId:item.id,entity,operation,stage,sdkCalls:answer.sdkCalls,assemblyFullName:answer.assemblyFullName,sdkFullName:answer.sdkFullName,sourceProvenance:answer.provenance,message:'Original CLR assembly completed with local SDK calls.'});
      }else if (item.mode === 'mock') {
        if ((item.configuration?.status ?? 200) >= 400) throw error(item.configuration?.body?.error?.message || `Plugin mock ${item.name} rejected the write.`, 'PluginValidation');
        output = item.configuration?.body ?? {};
      } else if (item.mode === 'handler') {
        const handler = handlers.get(item.id);
        if (!handler) throw error(`No trusted handler for plugin step ${item.id}.`);
        // A trusted handler receives its registered images: the pre-image from the stored row, the
        // PostOperation post-image from the saved row, limited to the registered attributes.
        const image=(types,source)=>{const spec=(item.images??[]).find(entry=>types.includes(entry.type));if(!spec||!source)return undefined;return structuredClone(spec.attributes.length?Object.fromEntries(spec.attributes.filter(name=>Object.hasOwn(source,name)).map(name=>[name,source[name]])):source);};
        output = handler({ step: structuredClone(item), entity, operation, stage, target: structuredClone(target), record: structuredClone(record), previous: previous ? structuredClone(previous) : null, preImage: image([0,2],previous), postImage: stage===40?image([1,2],record):undefined, identity: structuredClone(identity), changedAttributes: [...changedAttributes],...(association?{associationParameters:structuredClone(associationParameters)}:{}),...(bulk?{targets:structuredClone(targets),previousRecords:structuredClone(previousRecords),records:structuredClone(records)}:{}),...(read?{query:structuredClone(query),collection:structuredClone(collection),columns:structuredClone(columns),entityResult:structuredClone(holder?.entity)}:{}), reject: message => { throw new DataError(String(message), 400, 'PluginValidation', { declaredValidationMessage: true }); } });
        if (output?.then) { Promise.resolve(output).catch(() => {}); throw error('Plugin handlers must return synchronously.', 'LocalPluginAsyncHandler'); }
      } else throw error(`Plugin step mode ${item.mode} has no local execution adapter. Select clr, handler, mock, or disabled.`, 'LocalPluginUnsupported');
      if (output !== undefined && (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).some(key => !(association?['error']:bulk?['targets','error']:read?['query','collection','entityResult','error']:['target','error']).includes(key)))) throw error('Plugin result must contain only supported field/query changes or an error.');
      if (output?.error) throw error(String(output.error.message || 'Plugin rejected the write.'), 'PluginValidation');
      if(bulk&&output?.targets!==undefined){if(stage===40||!Array.isArray(output.targets))throw error('Bulk Targets changes require a pre-operation array.');targets.splice(0,targets.length,...structuredClone(output.targets));}
      if(!multiple&&output?.entityResult!==undefined){if(stage!==40)throw error('Retrieve Entity changes require PostOperation.');holder.entity=structuredClone(output.entityResult);readResultChanged();}
      if(read&&output?.query!==undefined){if(!multiple||stage===40)throw error('Query changes require RetrieveMultiple PreValidation or PreOperation.');replace(query,output.query);}
      if(read&&output?.collection!==undefined){if(stage!==40)throw error('Collection changes require PostOperation.');replace(collection,output.collection);readResultChanged();}
      if (output?.target !== undefined) {
        if (stage === 40 || operation === 'delete') throw error('PostOperation and Delete target changes cannot be persisted by this adapter.');
        if (!output.target || typeof output.target !== 'object' || Array.isArray(output.target)) throw error('Plugin target must be a field map.');
        for (const [name, value] of Object.entries(output.target)) {
          if (!/^[a-z][a-z0-9_]*$/i.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name.toLowerCase())) throw error('Invalid plugin target column.');
          target[name] = structuredClone(value);
          record[name] = structuredClone(value);
        }
      }
      if(item.mode!=='clr')note('PLUGIN_STEP_SIMULATED', `Local ${item.mode} completed; compiled .NET was not executed.`);
    } catch (cause) { note('PLUGIN_STEP_REJECTED', cause.message); throw cause; }
  }
  return structuredClone(executionFrames.get(record)??{});
}
