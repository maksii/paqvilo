// The organization composition both hosts share (server.mjs for Power Pages, standalone-runtime.mjs for Solution-only
// runtimes): pack handler maps, the memoised operation catalogues, the providers object, the organization runtime, its
// backend, the Dataverse API with managed identity, operation-mode selection (CLR prepared on demand), settle and close.
// Host-specific parts (portal renderer, personas, live bridge, watcher, status payloads) stay in the hosts.
import path from 'node:path';
import { pluginHandlers, pluginCatalogue } from './exported-plugins.mjs';
import { pluginRuntimeDescriptors, prepareClrRuntime, closeClrHostPool } from './plugin-clr.mjs';
import { overlayRegisteredSteps } from './dataverse-plugin-registration.mjs';
import { operationHandlers, describe as serverLogicDescribe } from './exported-operations.mjs';
import { operationCatalogue } from './operation-catalogue.mjs';
import { workflowHandlers, workflowsWithActivation } from './dataverse-workflows.mjs';
import { customApiHandlers, powerFxRequirements } from './dataverse-customapi.mjs';
import { addonHandlers } from './dataverse-addon-common.mjs';
import { sourceOrganizationExtensions } from './source-organization-extensions.mjs';
import { createOrganizationRuntime } from './dataverse-organization.mjs';
import { createOrganizationBackend } from './organization-backend.mjs';
import { startDataverseApi } from './dataverse-api.mjs';
import { createManagedIdentityEndpoints } from './dataverse-managed-identity.mjs';
import { createConnectorRuntime } from './connector-runtime.mjs';
import { createHostFlowRuns } from './flow-runs.mjs';
import { assertProvider, createStorageRouter, preflightProvider, storageSettings } from './storage-provider.mjs';
import { createLocalDiskStorage } from './storage-local-disk.mjs';
import { createMemoryStorage } from './storage-memory.mjs';
import { createLocalMessageBus, createServiceBusEmulatorBus, mappedEntities, messagingSettings, QUEUE_MESSAGE_TABLE, DEAD_LETTER_SUFFIX } from './message-bus.mjs';
import { createAzuriteStorage } from './storage-azurite.mjs';
import { createOutbox, OUTBOX_TABLE } from './outbox.mjs';
import { createSecretResolver } from './secret-resolver.mjs';
import { createServiceFixtureRegistry } from './service-fixtures.mjs';
import { createPowerFxEvaluator } from './canvas-power-fx.mjs';
import { localServiceSettings, describeLocalServices, preflightLocalServices } from './local-services.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { runWithPackRegistries } from './extensions.mjs';
import { runWithQueryResolvers } from './dataverse-conditions.mjs';
import { createCapabilityRegistry, packCapabilityRecords } from './capability-registry.mjs';
import { buildPreflightReport } from './capability-report.mjs';
import { attachmentBody as storedAttachmentBody } from './dataverse-storage-routing.mjs';
import { ATTACHMENT_COLUMNS } from './dataverse-files.mjs';
import { guidKey } from './dataverse-values.mjs';
import { organizationRecord } from './organization-context.mjs';
import { clockFunction, systemClock, systemIds } from './runtime-clock.mjs';
import { packDirectory } from './preset-registry.mjs';
import { DataError } from './data-error.mjs';
import { dataverseSettings } from './dataverse-settings.mjs';
import { runtimeSettings } from './runtime-config.mjs';
import { resolveDeploymentProfiles, loadDeploymentProfiles } from './deployment-profiles.mjs';
import { readCanvasSources } from './canvas-source.mjs';
import { MODEL_DRIVEN_CAPABILITY_RECORDS } from './model-driven/catalogue.mjs';
import { customConnectorsOf } from './custom-connector.mjs';
import { describe as flowTriggersDescribe } from './flow-triggers.mjs';
import { DataStore, emptyState } from './data.mjs';
import { buildSourceGraph, canvasRequirementRows } from './source-graph.mjs';
import { describeCanvasRuntime } from './canvas-runtime.mjs';
import { hostnameOf, isLoopbackUrl } from './dataverse-webhooks.mjs';
const originOf = text => { try { return text ? new URL(String(text)).origin : null; } catch { return null; } };
import { organizationPrincipalContext } from './dataverse-principal-context.mjs';
import { parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';
import { currentRequest } from './request-context.mjs';
import { initialOrganizationState } from './organization-bootstrap.mjs';

const canonical = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
// The reserved /_apps/ surfaces both hosts mount and their fidelity levels (canvas-http.mjs with canvas-runtime.mjs: the
// apps' logic runs headlessly, rendering is the canvas:rendering requirement; code-apps-http.mjs).
const APP_SURFACES = Object.freeze({ canvas: 'behaviour', codeApps: 'contract' });
const definitionOf = workflow => workflow?.definition?.properties?.definition ?? workflow?.definition?.definition;

/**
 * Whether a simulation level keeps durable local files (state, blobs, caches, certificates). Only `dry-run` is memory-only;
 * `simulation`, `deep` and the legacy configuration without a level (null) persist. Both hosts decide through this helper.
 */
export const persistentLevel = level => level !== 'dry-run';
/** The private state directory of a runtime: the state file's folder at a persistent level, else null (memory only). */
export const stateDirectoryOf = ({ stateFile = null, simulation = null } = {}) =>
  stateFile && persistentLevel(simulation?.level ?? null) ? path.dirname(path.resolve(stateFile)) : null;

// Instantiated pack providers per providers object: closed in reverse creation order by closeProviders, settled by settleProviders.
const lifecycles = new WeakMap();
const PACK_KIND = /^pack:([^/]+)\/(.+)$/;
const factoryFailure = (pack, kind, error) => Object.assign(new Error(`Pack ${pack} ${kind} factory failed: ${error.message}`),
  { code: 'PROVIDER_FACTORY_FAILED', pack, cause: error });

/**
 * Ownership of what a pack factory creates is registered before anything validates it, so a composition failure closes it
 * through closeCreated: adopt() registers the returned value (a promise is registered as its eventual value, settled and closed
 * once it resolves), and the factory's `own(resource)` registers a resource ({ settle?(), close?() }) it opened itself, so a
 * factory that throws after opening one still has it closed.
 */
function adopt(created, name, value) {
  if (value && typeof value.then === 'function') {
    const pending = Promise.resolve(value);
    pending.catch(() => {});
    created.push({ name, item: { settle: async () => (await pending.catch(() => null))?.settle?.(), close: async () => (await pending.catch(() => null))?.close?.() } });
  } else if (value && (typeof value === 'object' || typeof value === 'function') && !created.some(entry => entry.item === value)) created.push({ name, item: value });
  return value;
}
// A resource is registered once: a factory that passes its returned instance through own() is closed once.
const owner = (created, name) => resource => { if (resource && !created.some(entry => entry.item === resource)) created.push({ name: `${name}/owned`, item: resource }); return resource; };

/**
 * The pack factory for a provider entry: `pack:<packId>/<name>` reads that pack's export entry `name`; any other kind reads
 * the export entry named after the kind in any pack (azurite storage never gets here: core instantiates it). null when none.
 */
function packFactory(packs, exportName, kind) {
  const match = PACK_KIND.exec(kind);
  const pack = match ? packs.find(item => item?.id === match[1]) : null;
  const found = match ? (pack ? collectPackExport([pack], exportName).get(match[2]) : null) : collectPackExport(packs, exportName).get(kind);
  return found ? { factory: found.value, pack: found.pack } : null;
}

/**
 * Builds the providers object once from validated config and packs. Every key is present; a provider that is not
 * configured is null. config: { connections, secrets, providers, localServices }. stateDirectory anchors local storage; when it
 * is not given it is derived from { stateFile, simulation } (stateDirectoryOf). organizationUri() names the organization in bus
 * messages (the Dataverse origin, else the host's local origin).
 *
 * Pack factories (pack `storageProviders`, `messageProviders`, `outboxHandlers`) are called once here, synchronously:
 * - storage `pack:<packId>/<name>` (`azurite` is the core Blob REST transport, storage-azurite.mjs, reading its connection
 *   string from `env`):
 *   factory({ id, kind, settings, stateDirectory, clock, ids }) → a storage provider whose descriptor.id equals id;
 * - messaging `pack:<packId>/<name>` (`servicebus-emulator` is the core AMQP bus, message-bus.mjs createServiceBusEmulatorBus,
 *   unless a pack exports a `servicebus-emulator` factory):
 *   factory({ id, kind, settings, store, clock, ids, organizationUri }) → a bus with send() and an optional preflight()
 *   → { ready, reason? } (providerRequirements); it joins `messaging.buses[id]`;
 * - outbox `kind: 'pack:<packId>'`: each entry of that pack's `outboxHandlers` is factory({ name, clock, ids }) → an observer
 *   (a function, or { observe(entry), settle?(), close?() }) that sees every committed capture after it is captured.
 * Every factory input also carries `own(resource)`, which registers a resource the factory opened ({ settle?(), close?() }).
 * A factory that throws (or returns an invalid provider) fails composition with PROVIDER_FACTORY_FAILED naming the pack; the
 * instances created before it, the rejected instance itself and every resource it registered with own() are settled and
 * closed (closeCreated, reverse creation order) before the failure propagates; a rejected instance is never returned.
 */
export async function composeProviders(options) {
  const created = [];
  try { return buildProviders(options, created); } catch (error) {
    await closeCreated(created).catch(cleanup => options.diagnostic?.({ code: cleanup.code, severity: 'error', providers: cleanup.providers, message: cleanup.message }));
    throw error;
  }
}

function buildProviders({ store, packs = [], config = {}, stateDirectory, stateFile = null, simulation = null, clock = systemClock, ids = systemIds,
  diagnostic = () => {}, organizationUri = () => null, env = process.env }, created) {
  if (stateDirectory === undefined) stateDirectory = stateDirectoryOf({ stateFile, simulation });
  const now = clockFunction(clock);
  const instantiate = (exportName, id, entry, input, check) => {
    const found = packFactory(packs, exportName, entry.kind);
    if (!found) return null;
    let instance;
    try {
      instance = adopt(created, `${exportName}/${id}`, found.factory({ ...input, own: owner(created, `${exportName}/${id}`) }));
      if (instance && typeof instance.then === 'function') {
        // ponytail: factories are synchronous; a provider opens connections lazily on first use.
        throw new TypeError('the factory returned a promise; return the provider and open connections on first use');
      }
      check(instance);
    } catch (error) {
      const failure = factoryFailure(found.pack, exportName, error);
      diagnostic({ code: 'PROVIDER_FACTORY_FAILED', severity: 'error', pack: found.pack, provider: id, message: failure.message });
      throw failure;
    }
    return instance;
  };
  const storageConfig = storageSettings(config.providers ?? {}, 'providers', { stateDirectory: stateDirectory ?? undefined });
  // Local-disk providers live under the state directory (<stateDir>/blobs); a runtime without one (dry-run, in-memory) gets
  // the in-memory provider (storage-memory.mjs) under the same id, so its routes are ready and bytes are lost on restart.
  const instances = {};
  for (const [id, entry] of Object.entries(storageConfig.storage)) {
    if (entry.kind === 'local-disk') {
      const root = entry.root ?? (stateDirectory ? path.join(stateDirectory, 'blobs', ...(id === 'local' ? [] : [id])) : null);
      instances[id] = root ? createLocalDiskStorage({ root, id, clock: now, ids: () => ids.uuid() }) : createMemoryStorage({ id, clock: now, ids });
      created.push({ name: `storage/${id}`, item: instances[id] });
      continue;
    }
    // Core Blob REST transport (storage-azurite.mjs); its connection string is read from env here, never stored.
    if (entry.kind === 'azurite') {
      instances[id] = createAzuriteStorage({ id, settings: entry, env, clock: now });
      created.push({ name: `storage/${id}`, item: instances[id] });
      continue;
    }
    const provider = instantiate('storageProviders', id, entry, { id, kind: entry.kind, settings: structuredClone(entry), stateDirectory, clock: now, ids }, value => {
      assertProvider(value);
      if (value.descriptor.id !== id) throw new TypeError(`the provider declares id '${value.descriptor.id}', expected '${id}'`);
    });
    if (provider) instances[id] = provider;
    else diagnostic({ code: 'PROVIDER_NOT_REGISTERED', severity: 'warning', provider: id, kind: entry.kind,
      message: `Storage provider '${id}' (${entry.kind}) has no pack storageProviders factory; its routes answer PROVIDER_NOT_READY.` });
  }
  const storage = createStorageRouter({ config: storageConfig, providers: instances, counters: () => store?.counters ?? null });
  let annotations;
  try { annotations = storage.forRoute('annotations'); } catch { annotations = null; }
  const powerFxAdapter = collectPackExport(packs, 'powerFx').get('adapter')?.value;
  const localServices = config.localServices ? localServiceSettings(config.localServices) : null;
  // providers.messaging: the local bus with the validated settings (endpoint mappings, retry), the other declared buses by id
  // (local-queue ids share the local table; pack and emulator kinds come from pack factories) and the organization URI that
  // service endpoint messages carry (dataverse-webhooks.mjs messagingOf, serviceEndpointTarget).
  const messagingConfig = messagingSettings(config.providers?.messaging);
  const localBus = (id, entry) => createLocalMessageBus({ store, clock: { now }, ids, retry: entry.retry, id,
    ...(entry.lockDurationMs ? { lockDurationMs: entry.lockDurationMs } : {}) });
  const bus = localBus('local', messagingConfig.local);
  const buses = { local: bus };
  for (const [id, entry] of Object.entries(messagingConfig)) {
    if (id === 'local' || id === 'endpoints') continue;
    if (entry.kind === 'local-queue') { buses[id] = localBus(id, entry); continue; }
    let instance = instantiate('messageProviders', id, entry, { id, kind: entry.kind, settings: structuredClone(entry), store, clock: { now }, ids, organizationUri },
      value => {
        if (!value || typeof value.send !== 'function') throw new TypeError('the bus has no send(entity, message) function');
        if (value.preflight !== undefined && typeof value.preflight !== 'function') throw new TypeError('the bus preflight must be a function when present');
      });
    // servicebus-emulator without a pack factory: the core AMQP transport, linked to the entities the endpoints map to it.
    if (!instance && entry.kind === 'servicebus-emulator') {
      instance = createServiceBusEmulatorBus({ id, settings: entry, entities: mappedEntities(messagingConfig, id) });
      created.push({ name: `messageProviders/${id}`, item: instance });
    }
    if (instance) buses[id] = instance;
    else diagnostic({ code: 'PROVIDER_NOT_REGISTERED', severity: 'warning', provider: id, kind: entry.kind,
      message: `Messaging provider '${id}' (${entry.kind}) has no pack messageProviders factory; endpoints mapped to it are not delivered.` });
  }
  const messaging = Object.freeze({ bus, buses: Object.freeze(buses), settings: messagingConfig, get organizationUri() { return organizationUri(); } });
  const outbox = composeOutbox({ store, packs, config, now, ids, storage: annotations, diagnostic, created });
  const providers = Object.freeze({
    storage,
    messaging,
    outbox,
    connectors: createConnectorRuntime({ store, connections: config.connections ?? {}, packs, diagnostic, clock: { now }, messaging: () => bus, stateDirectory, trustedScripts: config.connectorScripts ?? [] }),
    secrets: config.secrets ? createSecretResolver({ secrets: config.secrets, clock: now, diagnostic }) : null,
    serviceFixtures: createServiceFixtureRegistry({ packs, diagnostic }),
    powerFx: createPowerFxEvaluator(powerFxAdapter === undefined ? {} : { adapter: powerFxAdapter }),
    localServices: localServices && Object.freeze({ settings: localServices, describe: () => describeLocalServices(localServices) }),
  });
  lifecycles.set(providers, { created, storage: storageConfig });
  return providers;
}

/**
 * The outbox: capture-only (outbox.mjs). `providers.outbox.kind: 'pack:<packId>'` adds that pack's `outboxHandlers` as
 * post-capture observers: each sees every captured entry once the capture's transaction has committed (a capture rolled back
 * with its caller is never observed). An observer cannot replace or veto capture; its failure is OUTBOX_HANDLER_FAILED.
 */
function composeOutbox({ store, packs, config, now, ids, storage, diagnostic, created }) {
  const settings = config.providers?.outbox ?? {};
  const base = createOutbox({ store, clock: { now }, ids, storage, ...(settings.retention ? { retention: settings.retention } : {}) });
  const kind = settings.kind ?? 'local';
  if (kind === 'local') return base;
  const packId = kind.slice('pack:'.length), pack = packs.find(item => item?.id === packId);
  const handlers = pack ? [...collectPackExport([pack], 'outboxHandlers')] : [];
  if (!handlers.length) {
    const failure = Object.assign(new Error(`providers.outbox.kind ${kind} names no pack with outboxHandlers.`), { code: 'PROVIDER_NOT_REGISTERED', pack: packId });
    diagnostic({ code: 'PROVIDER_NOT_REGISTERED', severity: 'error', pack: packId, provider: 'outbox', message: failure.message });
    throw failure;
  }
  const observers = handlers.map(([name, { value: factory }]) => {
    let observer;
    try {
      observer = adopt(created, `outboxHandlers/${name}`, factory({ name, clock: { now }, ids, own: owner(created, `outboxHandlers/${name}`) }));
      if (typeof observer === 'function') observer = { observe: observer };
      if (!observer || typeof observer.observe !== 'function') throw new TypeError('the handler returned neither a function nor { observe }');
    } catch (error) {
      const failure = factoryFailure(packId, 'outboxHandlers', error);
      diagnostic({ code: 'PROVIDER_FACTORY_FAILED', severity: 'error', pack: packId, provider: 'outbox', message: failure.message });
      throw failure;
    }
    return { name, observer };
  });
  const pending = new Set();
  // After the capture's transaction settles (store.queue: its outermost transaction, nested or not), observe the entry if
  // its row was committed. ponytail: an entry that retention drops before the queue settles is not observed.
  const observe = entry => {
    const task = store.queue.then(async () => {
      const committed = base.get(entry.id);
      if (!committed) return;
      for (const { name, observer } of observers) {
        try { await observer.observe(structuredClone(committed)); }
        catch (error) { diagnostic({ code: 'OUTBOX_HANDLER_FAILED', severity: 'warning', pack: packId, handler: name, entry: entry.id, message: error.message }); }
      }
    }).finally(() => pending.delete(task));
    pending.add(task);
  };
  const outbox = Object.create(base);
  outbox.descriptor = Object.freeze({ ...base.descriptor, observers: Object.freeze(observers.map(({ name }) => `${packId}/${name}`)) });
  outbox.capture = async (...args) => { const entry = await base.capture(...args); observe(entry); return entry; };
  outbox.settle = async () => { while (pending.size) await Promise.all([...pending]); };
  created.push({ name: 'outbox', item: { settle: outbox.settle } });
  return outbox;
}

// An instantiated provider is satisfied only when its preflight() answers ready; without preflight() it is declared: status
// placeholder (resolution by 'declared'), never satisfied.
const instantiatedRow = (id, label, probe) => (probe
  ? { id, reachable: probe.ready, message: probe.ready ? null : `${label} is not ready: ${probe.reason}` }
  : { id, reachable: false, status: 'placeholder', resolution: { by: 'declared' }, message: `${label} is instantiated but declares no preflight(); its reachability is not probed.` });

/**
 * Preflight provider rows ({ id, reachable, message, status? }) of a providers object: an instantiated storage or messaging
 * provider is reachable when its optional preflight() answers { ready: true } within 2 s, and declared (status placeholder,
 * never satisfied) when it has no preflight() (Azurite storage is always instantiated by core and probes with an authorized
 * List Containers; the Service Bus emulator bus is instantiated by core and probes with a SASL connection and a link per mapped
 * entity, reading its variable from `env`; variables are named, never their values); any other declared provider that is not
 * instantiated is missing. Both the running host's preflight and composeHostDescription use it.
 */
export async function providerRequirements({ providers, env = process.env }) {
  const rows = [];
  for (const entry of providers?.storage?.describe?.().providers ?? []) {
    const id = `provider:storage/${entry.id}`;
    if (entry.ready) { rows.push(instantiatedRow(id, `Storage provider '${entry.id}'`, await providers.storage.preflight?.(entry.id) ?? null)); continue; }
    rows.push({ id, reachable: false, message: `Storage provider '${entry.id}' is declared but not available.` });
  }
  for (const [providerId, entry] of Object.entries(providers?.messaging?.settings ?? {})) {
    if (providerId === 'local' || providerId === 'endpoints' || entry.kind === 'local-queue') continue;
    const id = `provider:messaging/${providerId}`;
    const bus = providers.messaging.buses?.[providerId];
    // preflight({ env }): the core emulator bus reads its connection string variable from this environment for the probe.
    if (bus) { rows.push(instantiatedRow(id, `Messaging provider '${providerId}'`, await preflightProvider(typeof bus.preflight === 'function' ? { preflight: () => bus.preflight({ env }) } : bus))); continue; }
    rows.push({ id, reachable: false, message: `Messaging provider '${providerId}' is declared but not available.` });
  }
  return rows;
}

const closeFailure = (failures, verb) => Object.assign(new AggregateError(failures.map(({ error }) => error),
  `Provider ${verb} failed: ${failures.map(({ name, step, error }) => `${name} ${step}: ${error.message}`).join('; ')}`),
{ code: verb === 'close' ? 'PROVIDER_CLOSE_FAILED' : 'PROVIDER_SETTLE_FAILED', providers: [...new Set(failures.map(({ name }) => name))] });

/**
 * Settles then closes created instances ({ name, item }) in reverse creation order, settle and close attempted separately per
 * instance. Instances whose close failed stay in `created` for a retry; failures aggregate into one PROVIDER_CLOSE_FAILED.
 */
async function closeCreated(created) {
  const failures = [], kept = [];
  for (const entry of created.splice(0).reverse()) {
    // A provider kept after a failed close was already settled; a retry only closes it.
    for (const step of entry.settled ? ['close'] : ['settle', 'close']) {
      try { await entry.item?.[step]?.(); entry.settled = true; } catch (error) {
        failures.push({ name: entry.name, step, error });
        if (step === 'close') kept.unshift(entry);
      }
    }
  }
  created.push(...kept);
  if (failures.length) throw closeFailure(failures, 'close');
}

/** Settles every instantiated pack provider (pending outbox observations, provider settle()); failures aggregate. */
export async function settleProviders(providers) {
  const failures = [];
  for (const { name, item } of lifecycles.get(providers)?.created ?? []) {
    try { await item?.settle?.(); } catch (error) { failures.push({ name, step: 'settle', error }); }
  }
  if (failures.length) throw closeFailure(failures, 'settle');
}

/** Closes every instantiated provider in reverse creation order (closeCreated); a failed close is retried by the next call. */
export async function closeProviders(providers) {
  const created = lifecycles.get(providers)?.created;
  if (created) await closeCreated(created);
}

/** Descriptors of a providers object for status payloads: what is configured and its level, never a value or secret. */
export function providerDescriptors(providers) {
  if (!providers) return {};
  const safe = fn => { try { return fn(); } catch (error) { return { error: error.code ?? 'ProviderDescribeFailed' }; } };
  return {
    storage: providers.storage ? safe(() => providers.storage.describe()) : null,
    messaging: providers.messaging ? { ...(providers.messaging.bus?.descriptor ?? { id: 'local' }), endpoints: Object.keys(providers.messaging.settings?.endpoints ?? {}).length,
      buses: Object.keys(providers.messaging.buses ?? {}) } : null,
    outbox: providers.outbox?.descriptor ?? null,
    connectors: providers.connectors ? safe(() => providers.connectors.providers()) : null,
    secrets: providers.secrets ? { keys: providers.secrets.keys().length } : null,
    serviceFixtures: providers.serviceFixtures ? safe(() => providers.serviceFixtures.describe()) : null,
    powerFx: providers.powerFx ? safe(() => providers.powerFx.describe()) : null,
    localServices: providers.localServices ? safe(() => providers.localServices.describe()) : null,
  };
}

/** Counts of Solution inventory records per component and level (sources.inventory). */
export function inventorySummary(records = []) {
  const components = {};
  for (const record of records) {
    const entry = (components[record.component] ??= { count: 0, levels: {} });
    entry.count += 1;
    entry.levels[record.level ?? 'inventory'] = (entry.levels[record.level ?? 'inventory'] ?? 0) + 1;
  }
  return { total: records.length, components };
}

/**
 * The host surfaces of a runtime under their legacy status keys (capability registry summary()). One rule for both hosts
 * and composeHostDescription: the Power Pages host serves personas, the live bridge and portal rendering; the standalone host
 * does not. dataverseApi is the validated Dataverse HTTP API switch of that host.
 */
export function hostSurfaces({ host = 'standalone', dataverseApi = false } = {}) {
  const portal = host === 'power-pages';
  return { dataverseApi: Boolean(dataverseApi), setup: true, records: true, staff: true, personas: portal, liveBridge: portal, portalRendering: portal };
}

/** Whether a host's Dataverse HTTP API is enabled, from the raw `dataverse` option, as each host validates it. */
export function dataverseApiEnabled({ host = 'standalone', runtime, dataverse = null } = {}) {
  const input = dataverse && typeof dataverse === 'object' && !Array.isArray(dataverse) ? dataverse : null;
  if (host === 'power-pages') return dataverseSettings({ ...(input ?? (dataverse === true ? {} : { enabled: false })) }).enabled;
  return dataverseSettings({ enabled: runtimeSettings(runtime).kind === 'dataverse-api', ...(input ?? {}) }).enabled;
}

/**
 * The source graph bindings (source-graph.mjs) of a runtime: the active deployment profile's environment variable values and
 * connection reference bindings (deployment-profiles.mjs loadDeploymentProfiles output, or null), with the configured
 * environmentVariables winning. All three graph builders (Power Pages, standalone, offline preflight) use it.
 */
export function graphBindings({ environmentVariables = {}, profile = null } = {}) {
  return { environmentVariables: { ...(profile?.environmentVariables ?? {}), ...(environmentVariables ?? {}) }, connectionReferences: profile?.connectionReferences ?? [] };
}

/** Loads the deployment profile a runtime starts with (the configured default, or the pinned one); null when none is configured. */
export async function activeDeploymentProfile({ deploymentProfiles, projectRoot = process.cwd(), sourceDir, pin = null } = {}) {
  if (!deploymentProfiles?.profiles || !Object.keys(deploymentProfiles.profiles).length) return null;
  const config = resolveDeploymentProfiles(deploymentProfiles, projectRoot, { sourceDir: sourceDir ?? projectRoot, sourceRoot: projectRoot });
  return Object.assign(await loadDeploymentProfiles(config, pin), { config });
}

/** Status `routes`: the /_sim/api prefixes of the routers a host mounts (each router's `routes` export), in mounting order, unique. */
export const simApiRoutes = (...lists) => [...new Set(lists.flat())];
/** Status `modelDrivenApps`: the imported model-driven apps of the Solution metadata as { id, uniqueName, name }. */
export const modelDrivenAppsOf = metadata => (metadata?.modelDrivenApps ?? []).map(({ id, uniqueName, name }) => ({ id, uniqueName, name }));

/**
 * Canvas apps for /_apps/canvas/ (canvas-http.mjs) from the inventory's canvasapp records; `tree` (canvas-source.mjs
 * canvasTree: screens and components with their controls) is what canvas-runtime.mjs hosts.
 */
export function canvasAppsOf(records = []) {
  return records.filter(record => record.component === 'canvasapp' && record.name).map(record => ({
    uniqueName: record.name,
    source: {
      app: { name: record.displayName ?? record.name, version: record.version ?? null, schemaVersion: record.canvas?.schemaVersion ?? null },
      screens: record.tree?.screens ?? (record.canvas?.screens ?? []).map(name => ({ name })),
      components: record.tree?.components ?? (record.canvas?.components ?? []).map(name => ({ name })), tree: record.tree ?? null,
      dataSources: record.canvas?.dataSources ?? [], formulas: record.canvas?.formulas ?? [], diagnostics: record.canvas?.diagnostics ?? record.diagnostics ?? [],
    },
  }));
}

/**
 * The code-app Dataverse proxy (code-apps-http.mjs `dataverse`): one Web API call through the organization record
 * handlers as the selected staff user. Reads run in a read transaction; writes take the host change slot atomically.
 */
export function codeAppDataverse({ organization, change, origin }) {
  return async ({ method, path: pathname, search = '', headers = {}, body, principal }) => {
    const url = new URL(pathname + search, origin() ?? 'http://organization.local');
    const route = parseDataverseRoute(url.pathname);
    if (!route) throw new DataError('Resource not found.', 404, 'NotFound');
    const user = organization.principals.byId(principal.principalId);
    const call = () => organization.records.handle({ method, url, origin: url.origin, version: route.version ?? 'v9.2', route, prefer: parsePrefer(headers.prefer),
      headers, body, ...organizationPrincipalContext(organization.store, user), requestId: currentRequest()?.correlationId ?? organization.ids.uuid() });
    return method === 'GET' ? organization.read(call) : change(() => organization.runOwned(() => organization.runAtomic(call)));
  };
}

/**
 * The code-app connector call (code-apps-http.mjs `connectors`): the power.config.json reference key binds a project
 * connection of the same id, else the connector's built-in provider. undefined (answered 501) when nothing implements it.
 */
export function codeAppConnectors(connectors, connections = {}) {
  return async ({ reference, operationId, body, principal }) => {
    const connectorId = reference.apiId ?? reference.key;
    const connectionId = Object.hasOwn(connections, reference.key) ? reference.key : null;
    const connection = connectors.resolve({ connectorId, connectionId });
    if (!connectors.supports(connectorId, operationId, connection.provider)) return undefined;
    return connectors.invoke({ connectorId, operationId, parameters: body ?? {}, connection,
      context: { caller: 'code-app', initiatingUserId: principal?.principalId ?? null, correlationId: currentRequest()?.correlationId ?? null } });
  };
}

/**
 * composeOrganizationHost(options) → Promise<host> (a composition failure closes the providers it created first). Options:
 *   store, packs (discoverPacks result), config ({ connections, secrets, providers, localServices }), stateDirectory,
 *   sources: { plugins(), workflows(), layers() } closures over the current Solution sources; sourcesKey(): a value whose
 *   identity changes when sources reload (an array is compared item by item); overrides(): the operations overrides (a
 *   stable object between commits); portalOperations(): portal or null;
 *   workflowOverrides(), timeoutMs(), diagnostic, clock, ids, scheduler, prepareRuntime (default prepareClrRuntime);
 *   runtime (runtimeSettings output), surfaces(): the host surfaces as { legacyKey: enabled } (capability summary keys),
 *   inventory(): the Solution inventory records, localOrigin(): the host's own origin once it listens, codeApps(): the loaded
 *   code app records (code-apps-config.mjs loadCodeApps) that topology() counts; projectRoot: the base of the relative pack paths it reports.
 * The host builds handler maps and providers at once; createBackend, createOrganization and startApi run when the host is
 * ready for them (the portal host creates its backend before its organization). The steps below share one context `c`:
 * hostContext (inputs, handler maps, providers, canvas, flow runs, lifecycle state), hostCatalogues, hostRegistry,
 * hostLifecycle and hostReports.
 */
export async function composeOrganizationHost(options) {
  const c = await hostContext(options);
  hostCatalogues(c);
  c.registry = hostRegistry(c);
  const host = {
    packs: c.packs, handlers: c.handlers, descriptors: c.descriptors, runtimes: c.runtimes, providers: c.providers, connectors: c.connectors,
    pluginSteps: c.pluginSteps, workflows: c.workflows, operations: c.operations, cloudFlow: c.cloudFlow,
    /**
     * Runs fn with this runtime's pack registries (expression operators, shell conventions) and query resolvers in scope:
     * hierarchy operators of portal FetchXML, Liquid and Web API queries resolve through this store's hierarchy module.
     */
    run: fn => runWithQueryResolvers(c.queryResolvers, () => (c.packs.registries ? runWithPackRegistries(c.packs.registries, fn) : fn())),
    /** Project canvas state: { enabled, records, diagnostics }. */
    canvas: c.canvas,
    /** Canvas apps for /_apps/canvas/: Solution inventory and project canvas.sources records. */
    canvasApps: () => canvasAppsOf(c.allInventory()),
    /** The host's capability registry (memoised with the catalogues). */
    capabilities: c.registry,
    ...hostLifecycle(c),
    ...hostReports(c),
  };
  for (const name of ['organization', 'backend', 'dataverse', 'managedIdentity']) Object.defineProperty(host, name, { get: () => c[name], enumerable: true });
  return host;
}

/** Step 1: the shared context: inputs, handler maps, providers (pack factories called once), canvas, flow runs and state. */
async function hostContext({ store, packs = [], config = {}, stateDirectory, stateFile = null, simulation = null, sources, sourcesKey = () => null,
  overrides = () => ({}), portalOperations = () => null, workflowOverrides = () => ({}), timeoutMs = () => 120000, diagnostic = () => {},
  clock = null, ids = null, scheduler = null, prepareRuntime = prepareClrRuntime, runtime, surfaces = () => ({}), inventory = () => [],
  localOrigin = () => null, codeApps = () => [], projectRoot = null, env = process.env }) {
  if (stateDirectory === undefined) stateDirectory = stateDirectoryOf({ stateFile, simulation });
  const c = { store, packs, config, stateDirectory, simulation, sources, sourcesKey, overrides, portalOperations, workflowOverrides, timeoutMs, diagnostic,
    clock, ids, scheduler, prepareRuntime, runtime, surfaces, codeApps, projectRoot,
    handlers: { operations: operationHandlers(packs), plugins: pluginHandlers(packs), workflows: workflowHandlers(packs), customApis: customApiHandlers(packs), addons: addonHandlers(packs) },
    descriptors: pluginRuntimeDescriptors(packs), runtimes: new Map(),
    organization: null, backend: null, dataverse: null, managedIdentity: null, epoch: 0, closing: null, installed: [], topologyMemo: null, extensions: null,
    // Project canvas configuration (canvas-source.mjs canvasSettings): enabled (default true) and the records of canvas.sources,
    // read once by loadCanvas(); a missing path is CANVAS_SOURCE_MISSING and a missing preflight requirement.
    canvas: { enabled: config.canvas?.enabled !== false, records: [], diagnostics: [] } };
  c.providers = await composeProviders({ store, packs, config, stateDirectory, clock: clock ?? store.clock ?? systemClock, ids: ids ?? store.ids ?? systemIds, diagnostic, env,
    organizationUri: () => c.dataverse?.origin ?? localOrigin() ?? null });
  // The composed providers are closed when the rest of the context fails to build, so a failed host leaks none.
  try { return hostContextRest(c, { store, clock, ids, scheduler, diagnostic, inventory }); } catch (error) {
    await closeProviders(c.providers).catch(cleanup => diagnostic({ code: cleanup.code, severity: 'error', providers: cleanup.providers, message: cleanup.message }));
    throw error;
  }
}
function hostContextRest(c, { store, clock, ids, scheduler, diagnostic, inventory }) {
  c.allInventory = () => [...(inventory() ?? []), ...c.canvas.records];
  c.connectors = c.providers.connectors;
  // Solution custom connectors (custom-connector.mjs) follow the current inventory (memoised on its identity, so the
  // connector registry re-registers only after a sources reload); canvas records never carry a connector.
  let customKey, customValue;
  c.connectors.useCustomConnectors(() => { const records = inventory(); if (records !== customKey) { customKey = records; customValue = customConnectorsOf(records ?? []); } return customValue; });
  // Cloud flow runs (flow-runs.mjs): attached to the organization api once it exists; waits replay through cloudFlow.
  c.flowRuns = createHostFlowRuns({ store, clock, ids, scheduler, diagnostic, approvals: c.connectors.approvals, flowOf: id => c.cloudFlow(id), stateDirectory: c.stateDirectory });
  // store.hierarchyResolver is set by the organization runtime once its hierarchy module is installed; until then none.
  c.queryResolvers = { get hierarchy() {
    const resolve = store.hierarchyResolver;
    return resolve ? (table, attribute, id, mode) => resolve(table, id, mode) : null;
  } };
  return c;
}

/**
 * Step 2: the catalogues, memoised on the committed store revision, the sources and overrides identities and the CLR runtimes
 * epoch; inside an isolated transaction they are rebuilt, since its uncommitted writes are not in the revision.
 */
function hostCatalogues(c) {
  const { store, sources, handlers, overrides } = c;
  c.memo = build => {
    let key = null, value;
    return () => {
      const next = [store.revision, overrides(), Boolean(c.organization), c.epoch, ...[c.sourcesKey()].flat()];
      if (store.isolatedCount || !key || next.some((part, index) => part !== key[index])) { value = build(); key = store.isolatedCount ? null : next; }
      return value;
    };
  };
  c.pluginSteps = c.memo(() => pluginCatalogue({ plugins: c.organization ? overlayRegisteredSteps(sources.plugins(), store) : sources.plugins(),
    handlers: handlers.plugins, runtimes: c.runtimes, descriptors: c.descriptors, overrides: overrides() ?? {} }));
  c.workflows = () => workflowsWithActivation(sources.workflows(), c.organization ? store : null);
  c.operations = c.memo(() => [...operationCatalogue({ portal: c.portalOperations() ?? undefined, workflows: c.workflows(), handlers: handlers.operations,
    overrides: overrides() ?? {}, connectors: c.connectors }), ...c.pluginSteps()]);
  // The exported cloud flow an ExecuteWorkflow call or a trigger runs; one canonical process id rule for both hosts.
  c.cloudFlow = id => {
    const workflow = c.workflows().get(canonical(id)) ?? c.workflows().get(id);
    if (!workflow) return null;
    const item = c.operations().find(entry => entry.kind === 'cloud-flow' && canonical(entry.processId) === canonical(id));
    return { definition: definitionOf(workflow), mode: item?.mode ?? 'placeholder', steps: item?.configuration?.steps,
      serviceProfile: handlers.operations.flowIdentities.get(canonical(id)), connectors: c.connectors, secrets: c.providers.secrets,
      connectionReferences: workflow.definition?.properties?.connectionReferences };
  };
}

/**
 * Step 3: the one capability registry of this host, rebuilt with the catalogues: host surfaces, the installed modules
 * (describe(api) sees what this runtime wired), operations, providers, services, inventory and pack records. A record
 * name another source already used is kept once (first wins), so a pack cannot shadow a module.
 */
function hostRegistry(c) {
  const { providers, diagnostic } = c;
  return c.memo(() => {
    const result = createCapabilityRegistry({ runtime: c.runtime });
    const seen = new Set();
    const add = record => {
      if (!record?.name || seen.has(record.name)) return;
      try { result.add(record); seen.add(record.name); }
      catch (error) { diagnostic({ code: 'CAPABILITY_RECORD_INVALID', name: record.name, message: error.message }); }
    };
    for (const [name, enabled] of Object.entries(c.surfaces())) add({ name, kind: 'host-surface', level: 'behaviour', enabled: enabled !== false, operations: [] }); // host surfaces stay behaviour records; the gaps they do not run are requirement rows (preflight-host-surfaces)
    for (const [name, level] of Object.entries(APP_SURFACES))
      add({ name, kind: 'host-surface', level, operations: [], ...(name === 'canvas' && !c.canvas.enabled ? { enabled: false, reason: 'CANVAS_DISABLED' } : {}) });
    if (c.canvas.enabled) add(describeCanvasRuntime({ evaluatorLevel: providers.powerFx?.describe?.().level }));
    for (const record of MODEL_DRIVEN_CAPABILITY_RECORDS) add(record);
    const api = c.organization?.api ?? null;
    for (const entry of c.installed) add(entry.describe?.(api) ?? { name: entry.name, kind: 'organization-module', level: 'inventory', operations: [], requires: [],
      principal: 'none', stateOwner: 'unknown', lifecycle: { install: true, reset: Boolean(entry.reset), close: Boolean(entry.close) } });
    for (const item of c.operations()) if (!seen.has(item.key)) { try { result.fromOperations([item]); seen.add(item.key); } catch (error) { diagnostic({ code: 'CAPABILITY_RECORD_INVALID', name: item.key, message: error.message }); } }
    for (const record of providers.connectors.describe()) add({ ...record, name: `connector:${record.name}`, kind: 'provider' });
    for (const record of providerRecords(providers)) add(record);
    for (const record of providers.serviceFixtures?.describe?.() ?? []) add({ ...record, kind: 'service' });
    if (api?.flowRuns?.describe) add(api.flowRuns.describe());
    add(serverLogicDescribe()); // the portal server-logic bridge levels (exported-operations.mjs)
    add(flowTriggersDescribe());
    const records = c.allInventory();
    for (const [name, item] of new Map(records.map(item => [`${item.component}:${item.name}`, item])))
      add({ name, kind: 'inventory', component: item.component, level: item.level ?? 'inventory', ...(item.reason ? { reason: item.reason } : {}) });
    for (const record of packCapabilityRecords(c.packs)) add(record);
    return result;
  });
}

/** Step 4: the lifecycle methods: backend, extensions, canvas sources, source refresh, organization, API, overrides, close. */
function hostLifecycle(c) {
  const { store, handlers, providers, diagnostic, runtimes } = c;
  const lifecycle = {
    async createBackend() {
      c.backend = await createOrganizationBackend({ store, items: c.pluginSteps, handlers: handlers.plugins, runtimes, descriptors: c.descriptors, operations: c.operations,
        workflows: c.workflows, identities: () => handlers.operations.flowIdentities, diagnostic, scheduler: c.scheduler, systemJobs: () => Boolean(c.organization),
        connectors: c.connectors, secrets: providers.secrets,
        // Queue and topic service endpoints (contracts 2, 5, 6) deliver through providers.messaging (= api.providers.messaging).
        messaging: () => c.organization?.api?.providers?.messaging ?? providers.messaging ?? null });
      return c.backend;
    },
    /**
     * The organization extension list (EXTENSIONS plus the Solution source modules), read from the current sources without
     * installing anything. createOrganization installs this list; composeHostDescription describes it.
     */
    async loadExtensions() {
      c.extensions ??= await sourceOrganizationExtensions({ layers: () => c.sources.layers?.() ?? [], plugins: () => c.sources.plugins?.(), customApis: handlers.customApis,
        pluginHandlers: handlers.plugins, workflowHandlers: handlers.workflows, workflowOverrides: c.workflowOverrides, cloudFlow: c.cloudFlow, diagnostic,
        addonHandlers: handlers.addons, timeoutMs: c.timeoutMs });
      if (!c.organization) { c.installed = c.extensions; c.epoch++; }
      return c.extensions;
    },
    /** Reads the project canvas.sources once (canvas-source.mjs readCanvasSources); their records join the inventory. */
    async loadCanvas() {
      const result = await readCanvasSources(c.config.canvas?.sources ?? [], { projectRoot: c.projectRoot ?? process.cwd() });
      Object.assign(c.canvas, result);
      for (const entry of result.diagnostics) diagnostic(entry);
      c.epoch++;
      return c.canvas;
    },
    /**
     * Re-registers the Solution source modules (custom APIs, duplicate rules, classic workflow definitions and activations,
     * plug-in registrations) from the current sources in one store transaction (source-organization-extensions.mjs
     * refresh). Both hosts call it in their reload change slot right after the Solution data is applied; a no-op before
     * the organization exists. Returns the change summary.
     */
    async refreshSources() {
      if (!c.organization || !c.installed.refresh) return null;
      const result = await c.installed.refresh();
      c.epoch++;
      return result;
    },
    async createOrganization({ settings, change, schema, metadataFields, log = () => {} }) {
      await lifecycle.loadExtensions();
      c.installed = c.extensions;
      c.organization = await createOrganizationRuntime({ store, settings, change, schema, metadataFields, log, extensions: c.extensions, providers, packs: c.packs, diagnostic,
        ...(c.clock ? { clock: c.clock } : {}), ...(c.ids ? { ids: c.ids } : {}), ...(c.scheduler ? { scheduler: c.scheduler } : {}) });
      c.flowRuns.attach(c.organization.api);
      // Jobs saved before a restart run once the organization exists (the backend created first waits on systemJobs).
      c.backend?.resume();
      return c.organization;
    },
    /** Starts the Dataverse API (and managed identity endpoints) over the organization. */
    async startApi({ host: listenHost, tls = null, beforeListen, managedIdentities = () => [], managedIdentityMode = 'appservice', secretDirectory }) {
      c.dataverse = await startDataverseApi({ organization: c.organization, host: listenHost, tls, beforeListen, managedIdentity: req => c.managedIdentity?.handle(req) ?? null });
      c.managedIdentity = createManagedIdentityEndpoints({ authority: { issueManagedIdentityToken: c.dataverse.issueManagedIdentityToken },
        settings: { get managedIdentities() { return managedIdentities(); } }, origin: c.dataverse.origin,
        secretFile: managedIdentityMode === 'arc' ? secretDirectory : undefined });
      return c.dataverse;
    },
    applyOperationOverrides: (next, commit) => applyOperationOverrides(c, next, commit),
    settle: async () => { await c.backend?.settle(); await settleProviders(providers); },
    resume: () => c.backend?.resume(),
    /** One close order: backend (drains committed work, closes CLR hosts), flow run wait timers, organization, API, managed identity. */
    // A close that failed is not memoised: the next close() retries only the providers whose close failed.
    close: () => (c.closing ??= (async () => {
      const failures = [];
      const attempt = async fn => { try { await fn(); } catch (error) { failures.push(error); } };
      const steps = c.closedOnce ? [] : [() => c.backend?.close(), () => c.flowRuns.close(), () => c.organization?.close(), () => c.dataverse?.close(),
        () => c.managedIdentity?.close()];
      c.closedOnce = true;
      for (const step of [...steps, () => closeProviders(providers)]) await attempt(step);
      if (failures.length) throw new AggregateError(failures, 'Organization host cleanup failed.');
    })().catch(error => { c.closing = null; throw error; })),
  };
  return lifecycle;
}

/**
 * Applies an operations overrides map: CLR runtimes the new map selects are prepared first (refused when the item has
 * no trusted descriptor), commit() stores the map, and runtimes it no longer selects are closed. A failed commit
 * closes what was prepared. Both hosts go through here, so a runtime switch to clr always prepares.
 */
async function applyOperationOverrides(c, next, commit) {
  const { runtimes, diagnostic } = c;
  const steps = c.pluginSteps().filter(item => item.kind === 'plugin-step'), prepared = new Map();
  try {
    for (const item of steps) {
      if (next?.[item.key]?.mode !== 'clr' || runtimes.has(item.id)) continue;
      if (!item.clrAvailable) throw new DataError('No explicitly trusted CLR descriptor is registered for this exact exported plugin step/type.', 409, 'LocalPluginClrUnavailable');
      if (item.unsupported) throw new DataError(item.unsupported, 409, 'LocalPluginUnsupported');
      prepared.set(item.id, await c.prepareRuntime(c.descriptors.get(item.id)));
    }
    for (const [id, runtime] of prepared) runtimes.set(id, runtime);
    c.epoch++;
    await commit();
  } catch (error) {
    for (const [id, runtime] of prepared) { runtimes.delete(id); closeClrHostPool({ runtime, diagnostic }); }
    c.epoch++;
    throw error;
  }
  for (const item of steps) {
    const runtime = runtimes.get(item.id);
    if (runtime && next?.[item.key]?.mode !== 'clr') { runtimes.delete(item.id); closeClrHostPool({ runtime, diagnostic }); }
  }
  c.epoch++;
  // Recurrence and connector trigger hosts follow the new operation modes (flow-triggers.mjs syncTriggers).
  await c.backend?.triggerRunner?.syncTriggers?.();
}

/** Step 5: the read-side reports: simulation report, dashboard topology, capability status, preflight and note bodies. */
function hostReports(c) {
  const { store, providers, canvas } = c;
  return {
    /**
     * A simulation report (simulation-persistence.mjs report) with the private blob directory listed as a target when an
     * explicit persistent level keeps file and note bytes under <stateDir>/blobs.
     */
    simulationReport(report) {
      if (!report || !c.simulation || !persistentLevel(c.simulation.level) || !c.stateDirectory) return report;
      return { ...report, targets: [...(report.targets ?? []), { kind: 'blobs', packId: null, file: path.join(c.stateDirectory, 'blobs'), tables: [] }] };
    },
    /**
     * The shared part of GET /_sim/api/dashboard (sim-dashboard-routes.mjs): { runtime, nodes, edges, activity } from the
     * registry, providers, configuration, the Dataverse listener and cheap table counts. Memoised on the store revision, the
     * counters tick and a 5-second time bucket; never reads a secret value, connection settings or a service endpoint URL beyond its hostname.
     */
    topology: () => {
      // A 5-second time bucket refreshes counts that change with time alone (message locks and schedules, overdue waits).
      const key = [store.revision, store.counters?.tick ?? 0, c.organization, c.dataverse, c.epoch, Math.floor((store.clock ?? systemClock).now() / 5000)];
      if (store.isolatedCount || !c.topologyMemo || key.some((part, index) => part !== c.topologyMemo.key[index]))
        c.topologyMemo = { key, value: organizationTopology({ store, runtime: c.runtime, registry: c.registry(), providers, config: c.config, organization: c.organization,
          dataverse: c.dataverse, managedIdentity: c.managedIdentity, pluginSteps: c.pluginSteps(), operations: c.operations(), inventory: c.allInventory(),
          canvasEnabled: canvas.enabled, codeApps: c.codeApps() ?? [], packs: c.packs, layers: c.sources.layers?.() ?? [], projectRoot: c.projectRoot }) };
      return structuredClone(c.topologyMemo.value);
    },
    /** Status payload fields: the legacy boolean summary and the registry report. */
    capabilityStatus: () => {
      const current = c.registry(), capabilities = current.summary();
      // The app surfaces report their fidelity level under their legacy keys, not a boolean.
      // A surface switched off in the configuration (canvas.enabled false) reports 'disabled'.
      for (const name of Object.keys(APP_SURFACES)) { const record = current.get(name); capabilities[name] = record?.enabled === false ? 'disabled' : record?.level ?? capabilities[name]; }
      return { capabilities, capabilityReport: current.report() };
    },
    /**
     * The preflight report (capability-report.mjs) of this running host: its live operations (with /_sim/ overrides), packs,
     * registry, local-service probes and storage readiness. graph: the source graph rebuilt with the active profile bindings.
     */
    async preflight({ simulation: level = c.simulation, graph = null, portal = null, scenario = null, strict = false, diagnostics = [], env = process.env } = {}) {
      const localServices = c.config.localServices ? await preflightLocalServices(c.config.localServices, { env }) : [];
      // Missing project canvas sources are requirements of the source graph (kind canvas-source).
      // Project canvas apps get the canvas:app/<name> rows Solution apps get (source-graph.mjs canvasRequirementRows), once each.
      const known = new Set((graph?.requirements?.() ?? []).map(row => row.id));
      const missing = [...canvas.diagnostics.filter(entry => entry.code === 'CANVAS_SOURCE_MISSING')
        .map(entry => ({ id: `canvas-source:${entry.source}`, kind: 'canvas-source', source: entry.source, status: 'missing', reason: entry.code })),
      ...canvasRequirementRows(canvas.records).filter(row => !known.has(row.id))];
      const sourceGraph = missing.length ? Object.create(graph ?? null, { requirements: { value: () => [...(graph?.requirements?.() ?? []), ...missing] } }) : graph;
      return buildPreflightReport({ runtime: c.runtime, simulation: level, registry: c.registry(), graph: sourceGraph, operations: c.operations(), packs: c.packs, localServices,
        portal, scenario, strict, diagnostics: [...diagnostics, ...canvas.diagnostics],
        providers: [...await providerRequirements({ providers, env }), ...powerFxRequirements(store, providers.powerFx)] });
    },
    /**
     * A note's or attachment's body as base64 for portal readers: the stored row (by id) inline, else read from its storage
     * provider (dataverse-storage-routing.mjs). row needs only its id; null when the row has no body. options.strict: a
     * missing stored object throws 404 STORAGE_OBJECT_MISSING (a $value read) instead of reading as null.
     */
    async attachmentBody(logical, row, options = {}) {
      const column = ATTACHMENT_COLUMNS[logical];
      if (!column || !row) return null;
      const idColumn = logical === 'annotation' ? 'annotationid' : 'activitymimeattachmentid';
      const stored = store.tableRows(logical).find(item => guidKey(item[idColumn]) === guidKey(row[idColumn])) ?? row;
      return c.organization ? storedAttachmentBody(c.organization.api, logical, stored, options) : stored[column] ?? null;
    },
  };
}

/**
 * composeHostDescription(options) → description: the listener-free composition the offline preflight shares with the running
 * hosts. It runs composeOrganizationHost over an in-memory store (no state directory, no organization, no backend, no
 * listener), so the host surfaces, organization modules, operations, connectors, providers (pack factories included), outbox,
 * service fixtures, inventory (with project canvas.sources) and storage readiness are the facts a running host of the same
 * configuration reports. Options:
 *   sources: loadOrganizationSources output ({ scan, metadata, solutionData, workflows, inventory, ... }); portal: the imported
 *   portal or null; operationPortal: the portal with Solution operations (operation-catalogue.mjs withSolutionOperations) or null;
 *   config: { connections, secrets, providers, localServices, canvas, environmentVariables, dataverse }; packs: discoverPacks
 *   output; deploymentProfile: the active profile (activeDeploymentProfile / loadDeploymentProfiles output) or null;
 *   host: 'power-pages' | 'standalone' (default from runtime.kind); runtime; simulation (simulationSettings output);
 *   projectRoot; diagnostic.
 * Returns { runtime, host, surfaces, registry, operations, providers, bindings, graph, canvas, preflight({ scenario, strict,
 * env, diagnostics }), close() }. A pack provider factory that throws rejects with PROVIDER_FACTORY_FAILED. The caller closes it.
 * The one difference from GET /_sim/api/preflight: operation modes are the source defaults (no /_sim/ overrides).
 */
export async function composeHostDescription({ sources = {}, config = {}, packs = [], deploymentProfile = null, host, runtime, simulation = null,
  projectRoot = process.cwd(), portal = null, operationPortal = null, diagnostic = () => {}, env = process.env, preset = null } = {}) {
  const settings = runtimeSettings(runtime);
  host ??= settings.kind === 'power-pages' ? 'power-pages' : 'standalone';
  const surfaces = hostSurfaces({ host, dataverseApi: dataverseApiEnabled({ host, runtime: settings, dataverse: config.dataverse }) });
  // A startup preset is applied as a fresh running host applies it (standalone-runtime.mjs), so rows the preset seeds
  // (service endpoints, plug-in types) resolve here as they do on that host.
  const boot = preset && sources.solutionData ? initialOrganizationState({ solutionData: sources.solutionData, packs, environmentVariables: config.environmentVariables }) : null;
  const store = await new DataStore(boot ? { state: boot.state, presetLibrary: boot.presetLibrary } : { state: emptyState() }).init();
  if (preset) await store.applyPreset(preset, { returnSnapshot: false });
  const composed = await composeOrganizationHost({ store, packs, runtime: settings, config, stateDirectory: null, projectRoot, diagnostic, env,
    surfaces: () => surfaces, inventory: () => sources.inventory ?? [], portalOperations: () => operationPortal,
    sources: { plugins: () => sources.metadata?.plugins, workflows: () => sources.workflows ?? new Map(), layers: () => sources.solutionData?.layers ?? [] } });
  try {
    await composed.loadExtensions();
    await composed.loadCanvas();
    // The organization modules install over the in-memory store as on a running host (no backend, no listener), so each
    // module's describe(api) reports the level the running host of this configuration reports.
    const input = config.dataverse && typeof config.dataverse === 'object' && !Array.isArray(config.dataverse) ? config.dataverse : {};
    await composed.createOrganization({ settings: dataverseSettings({ ...input, enabled: surfaces.dataverseApi }), change: fn => fn(),
      schema: () => sources.schema, metadataFields: logical => sources.metadata?.entities?.[logical]?.fields });
  } catch (error) { await composed.close().catch(() => {}); throw error; }
  const bindings = graphBindings({ environmentVariables: config.environmentVariables, profile: deploymentProfile });
  // The boot mappings a running host starts its store with (standalone-runtime.mjs), so dashboard rows see the catalogue's tables.
  const mappings = sources.solutionData ? { ...initialOrganizationState({ solutionData: sources.solutionData, packs }).state.mappings, ...config.initial?.mappings } : null;
  const graph = sources.scan ? buildSourceGraph({ ...sources, portal, bindings, mappings }) : null;
  return {
    runtime: settings, host, surfaces, bindings, graph, canvas: composed.canvas,
    registry: composed.capabilities(), operations: composed.operations(), providers: providerDescriptors(composed.providers),
    preflight: ({ scenario = null, strict = false, env = process.env, diagnostics = [] } = {}) => composed.preflight({ simulation, graph, portal, scenario, strict, env,
      diagnostics: [...(deploymentProfile?.diagnostics ?? []), ...diagnostics] }),
    close: () => composed.close(),
  };
}

/** Capability records of the configured storage, messaging, outbox, Power Fx and local-service providers. */
function providerRecords(providers) {
  const records = [];
  for (const entry of providers.storage?.describe?.().providers ?? [])
    records.push({ name: `provider:storage/${entry.id}`, kind: 'provider', providerKind: entry.kind, level: entry.ready ? entry.level : 'inventory',
      operations: entry.ready ? entry.operations : [], requires: entry.requires ?? [], ...(entry.stateOwner ? { stateOwner: entry.stateOwner } : {}),
      ...(entry.ready ? {} : { reason: 'Declared but not available in this runtime.' }) });
  if (providers.messaging?.bus?.descriptor) records.push({ ...providers.messaging.bus.descriptor, kind: 'provider' });
  // Every other declared messaging provider: its instantiated bus descriptor, else the declared kind at inventory.
  for (const [id, entry] of Object.entries(providers.messaging?.settings ?? {})) {
    if (id === 'local' || id === 'endpoints') continue;
    const instance = providers.messaging.buses?.[id], descriptor = instance?.descriptor;
    records.push(instance ? { level: 'behaviour', operations: [], requires: [], ...(descriptor ?? {}), name: `provider:messaging/${id}`, kind: 'provider', providerKind: entry.kind }
      : { name: `provider:messaging/${id}`, kind: 'provider', providerKind: entry.kind, level: 'inventory', operations: [], requires: [], reason: 'Declared but not available in this runtime.' });
  }
  if (providers.outbox?.descriptor) records.push({ ...providers.outbox.descriptor, kind: 'provider' });
  if (providers.powerFx?.describe) records.push(providers.powerFx.describe());
  if (providers.localServices?.describe) records.push(...providers.localServices.describe());
  return records;
}

const ASYNC_STATES = ['ready', 'suspended', 'locked', 'completed'];
const tally = (items, keyOf) => { const result = {}; for (const item of items) { const key = keyOf(item); result[key] = (result[key] ?? 0) + 1; } return result; };
const portOf = text => { try { return text ? Number(new URL(text).port) || null : null; } catch { return null; } };
const attempt = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

/**
 * The shared dashboard topology: Dataverse listener, organization core and modules, providers, connections,
 * web hook targets, local services, fixtures and apps, plus activity from cheap counters and single passes over the bus,
 * outbox, flow run and asyncoperation tables. Safe facts only: counts, names, levels, ports and hostnames. Each builder
 * below adds its nodes and edges to the shared graph and returns the facts `activity` needs.
 */
function organizationTopology(input) {
  const { store, runtime } = input;
  const nodes = [], edges = [], ids = new Set();
  const counters = store.counters?.snapshot() ?? {};
  const context = { ...input, nodes, clock: store.clock ?? systemClock, counters,
    node: (id, kind, label, status, detail = {}, extra = {}) => { if (ids.has(id)) return; ids.add(id); nodes.push({ id, kind, label, status, ...extra, detail }); },
    edge: (from, to, kind, status, label = '') => edges.push({ from, to, kind, status, label }),
    rows: name => store.state?.tables?.[name] ?? [],
    count: name => counters[name] ?? 0 };
  hostNodes(context);
  const org = orgNodes(context), providers = providerNodes(context);
  externalNodes(context);
  moduleEdges(context);
  return {
    runtime: { kind: runtime?.kind ?? null, clock: context.clock === systemClock ? 'system' : 'fixed', storeRevision: store.revision },
    nodes, edges, configuration: topologyConfiguration(context), activity: topologyActivity(context, { ...org, ...providers }),
  };
}

/** Dataverse Web API listener, TDS (it listens even when logins are refused) and managed identity (reveal-free). */
function hostNodes({ node, edge, organization, dataverse, managedIdentity }) {
  const tdsSetting = organization?.settings?.tds?.enabled;
  const tdsLogins = typeof tdsSetting === 'function' ? Boolean(tdsSetting()) : tdsSetting !== false;
  if (!dataverse) {
    node('host:dataverse-api', 'host', 'Dataverse Web API', 'disabled', { reason: 'The Dataverse HTTP API is not enabled for this runtime.' }, { link: '#dataverse' });
    return;
  }
  node('client:api', 'client', 'Web API clients', 'ready', { note: 'Applications that call the Web API through the local authority.' }, { link: '#dataverse' });
  node('host:dataverse-api', 'host', 'Dataverse Web API', 'listening', { origin: dataverse.origin, tlsOrigin: dataverse.tlsOrigin ?? null,
    managedIdentity: { enabled: Boolean(managedIdentity) } }, { link: '#dataverse' });
  node('host:tds', 'host', 'TDS endpoint', dataverse.tdsPort == null ? 'disabled' : tdsLogins ? 'listening' : 'disabled',
    { port: dataverse.tdsPort ?? null, loginsAccepted: dataverse.tdsPort != null && tdsLogins }, { link: '#dataverse' });
  edge('client:api', 'host:dataverse-api', 'http', 'listening', 'Web API');
  if (dataverse.tdsPort != null) edge('client:api', 'host:tds', 'http', tdsLogins ? 'listening' : 'disabled', 'TDS');
  if (dataverse.tdsPort != null) edge('host:tds', 'org:store', 'process', tdsLogins ? 'ready' : 'disabled', 'records as the caller');
  edge('host:dataverse-api', 'org:store', 'process', 'ready', 'records');
}

// Parts with no connection at runtime, and why (the map shows them unconnected on purpose).
const STARTUP_ONLY = Object.freeze({ 'dataverse-bpf': 'Models business process flows; nothing calls it while the runtime runs yet.', 'dataverse-addon-handlers': 'Wires pack message handlers in at startup; nothing calls it while the runtime runs.',
  'dataverse-plugin-registration-solution': 'Seeds plug-in registrations from the Solutions at startup and refresh; nothing calls it while the runtime runs.' });
const UNCALLED_FIXTURES = Object.freeze({ aiBuilder: 'Registered, but nothing calls it: AI Builder messages are answered by pack handlers.',
  copilot: 'Registered, but nothing calls it: Copilot Studio messages are answered by pack handlers.',
  powerBi: 'Called only by the powerbi Liquid tag of a Power Pages site.' });

/** Organization core: the store, the fixed pipeline nodes and every installed organization module. */
function orgNodes({ node, edge, nodes, rows, count, store, clock, organization, registry, pluginSteps, operations, dataverse: _dataverse }) {
  node('org:store', 'org', 'Organization store', organization ? 'ready' : 'declared', { revision: store.revision, tables: Object.keys(store.state?.tables ?? {}).length,
    clock: clock === systemClock ? 'system' : 'fixed' }, { link: '#capabilities' });
  const steps = pluginSteps.filter(item => item.kind === 'plugin-step');
  const executable = steps.filter(item => !['placeholder', 'disabled'].includes(item.mode) && !item.unsupported);
  node('org:plugins', 'org', 'Plug-in steps', !steps.length ? 'disabled' : executable.length ? 'ready' : 'placeholder',
    { steps: steps.length, byMode: tally(steps, item => item.mode), executions: count('plugins.executions'), failures: count('plugins.failures') }, { link: '#operations' });
  const classic = rows('workflow').filter(row => Number(row.category) === 0 && Number(row.type ?? 1) === 1);
  node('org:workflows', 'org', 'Classic workflows', classic.length ? 'ready' : 'disabled',
    { definitions: classic.length, activated: classic.filter(row => Number(row.statecode) === 1).length }, { link: '#operations' });
  const flows = operations.filter(item => item.kind === 'cloud-flow');
  const runs = tally(rows('flowrun'), row => row.status ?? 'Unknown');
  const overdueWaits = attempt(() => organization?.api?.flowRuns?.waits({ state: 'overdue' }).length ?? 0, 0);
  node('org:flows', 'org', 'Cloud flows', !flows.length ? 'disabled' : flows.some(item => item.mode !== 'placeholder') ? 'ready' : 'placeholder',
    { flows: flows.length, byMode: tally(flows, item => item.mode), runs }, { link: '#flows' });
  const scheduler = attempt(() => store.scheduler?.status?.() ?? null, null);
  const asyncRows = rows('asyncoperation');
  const poisoned = asyncRows.filter(row => Number(row.statecode) === 3 && Number(row.statuscode) === 31).length;
  const jobs = { pending: attempt(() => store.committedJobs?.pending?.() ?? 0, 0), scheduled: scheduler?.scheduled ?? 0, running: scheduler?.running ?? 0,
    failures: store.committedJobErrors?.length ?? 0, poisoned };
  node('org:jobs', 'org', 'Background jobs', store.committedJobs || scheduler ? 'ready' : 'declared',
    { ...jobs, scheduler: scheduler && { manual: scheduler.manual, closed: scheduler.closed, executed: scheduler.executed, faults: scheduler.faults, failures: scheduler.failures },
      recentErrors: (store.committedJobErrors ?? []).slice(-5).map(({ kind, code }) => ({ kind, code })) }, { link: '#flows' });
  edge('org:store', 'org:plugins', 'process', 'ready', 'pipeline');
  edge('org:plugins', 'org:store', 'process', 'ready', 'SDK calls');
  edge('org:plugins', 'org:jobs', 'process', 'ready', 'async steps');
  edge('org:jobs', 'org:flows', 'process', flows.length ? 'ready' : 'disabled', 'row triggers');
  // Classic workflows (dataverse-workflows.mjs): real-time ones run in the save hook, background ones as committed jobs.
  edge('org:store', 'org:workflows', 'process', 'ready', 'runs on save');
  edge('org:workflows', 'org:jobs', 'process', 'ready', 'background');
  for (const record of registry.list({ kind: 'organization-module' }))
    node(`org:${record.name}`, 'org-module', record.name, record.level === 'inventory' ? 'placeholder' : 'ready',
      { stateOwner: record.stateOwner ?? null, operations: record.operations?.length ?? 0, ...(STARTUP_ONLY[record.name] ? { note: STARTUP_ONLY[record.name] } : {}) }, { level: record.level, link: '#capabilities' });
  // Security: every record read and write checks the caller's roles and row access (dataverse-security.mjs principals) and
  // column security (dataverse-fls.mjs); audited tables write audit rows while the organization has auditing turned on.
  const has = id => nodes.some(item => item.id === id), audited = organizationRecord(store)?.isauditenabled;
  const auditing = (audited && typeof audited === 'object' ? audited.Value : audited) === true;
  node('org:security', 'org', 'Security roles', organization ? 'ready' : 'declared', { roles: rows('role').length, users: rows('systemuser').length, teams: rows('team').length },
    { link: '#dataverse' });
  edge('org:store', 'org:security', 'process', 'ready', 'access checks');
  if (has('org:dataverse-fls')) edge('org:store', 'org:dataverse-fls', 'process', 'ready', 'column security');
  if (has('org:dataverse-audit')) edge('org:store', 'org:dataverse-audit', 'process', auditing ? 'ready' : 'disabled', auditing ? 'audit rows' : 'auditing off');
  return { runs, overdueWaits, jobs, asyncRows };
}

/** Storage routes, the message bus (one pass over its table) and the outbox. Storage counts are writes since start. */
function providerNodes({ node, edge, rows, count, clock, providers, store, config = {} }) {
  const storage = attempt(() => providers.storage?.describe?.() ?? null, null);
  const storageActivity = (storage?.providers ?? []).map(entry => ({ id: entry.id, writes: count(`storage.${entry.id}.writes`), deletes: count(`storage.${entry.id}.deletes`),
    bytesWritten: count(`storage.${entry.id}.bytesWritten`) }));
  if (storage) {
    node('provider:storage', 'provider', 'Storage', storage.providers.some(entry => entry.ready) ? 'ready' : 'declared',
      { providers: storage.providers.map(({ id, kind, level, ready, routes }) => ({ id, kind, level: level ?? null, ready, routes, ...storageActivity.find(item => item.id === id) })) },
      { link: '#services' });
    for (const [route, target] of Object.entries(storage.routes ?? {})) {
      const entry = storage.providers.find(item => item.id === target);
      const ready = target === 'export' || (entry?.ready && (entry.kind !== 'azurite' || (entry.level === 'behaviour' && entry.health?.ready !== false)));
      node(`provider:storage-route:${route}`, 'provider', route, ready ? 'ready' : entry ? 'declared' : 'missing', { provider: target, kind: target === 'export' ? 'export' : entry?.kind ?? null }, { link: '#services' });
      edge('provider:storage', `provider:storage-route:${route}`, 'storage', ready ? 'ready' : 'declared', target);
    }
    // Core Blob REST transport (storage-azurite.mjs): level behaviour with a usable connection string, contract (declared only) without.
    // Status from each provider's health() (last request or preflight): ready, error (endpoint failed or refused the key),
    // missing (no usable connection string) or declared (not contacted yet); the reasons go in the detail.
    const azurite = storage.providers.filter(entry => entry.kind === 'azurite');
    if (azurite.length) {
      const states = azurite.map(entry => ({ id: entry.id, ready: entry.health?.ready ?? null, reason: entry.health?.reason ?? null }));
      const status = states.some(state => state.ready === false) ? (azurite.some(entry => entry.level !== 'behaviour') ? 'missing' : 'error')
        : states.every(state => state.ready === true) ? 'ready' : 'declared';
      node('external:azurite', 'external', 'Azurite', status, { providers: states.map(state => state.id), health: states }, { link: '#services' });
      // Each route that targets an Azurite provider writes there.
      const used = Object.entries(storage.routes ?? {}).filter(([, target]) => azurite.some(item => item.id === target));
      for (const [route, target] of used) {
        const entry = azurite.find(item => item.id === target);
        edge(`provider:storage-route:${route}`, 'external:azurite', 'storage', entry.level === 'behaviour' ? status : 'missing', entry.level === 'behaviour' ? 'Blob REST' : 'no connection string');
      }
      // Configured but no route writes there: the provider exists and stays unused.
      if (!used.length) edge('provider:storage', 'external:azurite', 'storage', 'declared', 'configured, no route uses it');
    }
  }
  const at = clock.now(), messageStats = {}, messages = { active: 0, locked: 0, scheduled: 0, deadLettered: 0, entities: 0 };
  for (const row of rows(QUEUE_MESSAGE_TABLE)) {
    const entity = String(row.entity ?? ''), dead = entity.endsWith(DEAD_LETTER_SUFFIX);
    const state = dead ? 'deadLettered' : row.locktoken != null && row.lockeduntil > at ? 'locked' : row.visibleat > at ? 'scheduled' : 'active';
    const stats = (messageStats[dead ? entity.slice(0, -DEAD_LETTER_SUFFIX.length) : entity] ??= { active: 0, locked: 0, scheduled: 0, deadLettered: 0 });
    stats[state] += 1; messages[state] += 1;
  }
  if (providers.messaging) {
    const descriptor = providers.messaging.bus?.descriptor ?? { id: 'local' };
    const endpoints = providers.messaging.settings?.endpoints ?? {};
    node('provider:messaging', 'provider', 'Message bus', 'ready', { id: descriptor.id ?? null, kind: descriptor.kind ?? null, endpoints: Object.keys(endpoints).length },
      { level: descriptor.level, link: '#services' });
    for (const target of new Set(Object.values(endpoints).map(value => String(value)))) {
      const entity = target.slice(target.indexOf('/') + 1);
      messageStats[entity] ??= { active: 0, locked: 0, scheduled: 0, deadLettered: 0 };
      node(`provider:messaging-endpoint:${entity}`, 'provider', entity, 'ready', { provider: target.slice(0, target.indexOf('/')), ...messageStats[entity] }, { link: '#services' });
      edge('provider:messaging', `provider:messaging-endpoint:${entity}`, 'bus', 'ready', entity);
    }
    if (Object.keys(endpoints).length) edge('org:plugins', 'provider:messaging', 'bus', 'ready', 'service endpoints');
    // A Service Bus emulator bus sends over AMQP to the emulator, which runs outside Paqvilo.
    if (descriptor.kind === 'servicebus-emulator' || Object.values(providers.messaging.settings?.providers ?? config.providers?.messaging ?? {}).some(entry => entry?.kind === 'servicebus-emulator')) {
      node('external:servicebus-emulator', 'external', 'Service Bus emulator', 'declared', {}, { link: '#services' });
      edge('provider:messaging', 'external:servicebus-emulator', 'bus', 'declared', 'AMQP');
    }
  }
  messages.entities = Object.keys(messageStats).length;
  const outboxStates = tally(rows(OUTBOX_TABLE), row => row.state ?? 'unknown');
  const outbox = { queued: outboxStates.queued ?? 0, delivered: outboxStates.delivered ?? 0, failed: outboxStates.failed ?? 0,
    pendingDeletes: store.state?.simulator?.outboxPendingDeletes?.length ?? 0 };
  if (providers.outbox) {
    node('provider:outbox', 'provider', 'Outbox', 'ready', outbox, { level: providers.outbox.descriptor?.level, link: '#services' });
  }
  return { storageActivity, messages, outbox };
}

/**
 * Web hook targets (one node per hostname; listening only when the delivery rule isLoopbackUrl contacts it), connectors and
 * connections (id, provider, principal kind; never settings), secrets (count only), local services, fixtures, Power Fx and apps.
 */
function externalNodes({ node, edge, nodes, rows, config, providers, inventory, codeApps, operations, dataverse, canvasEnabled = true }) {
  const webhooks = rows('serviceendpoint').filter(row => Number(row.contract) === 8)
    .map(row => ({ name: row.name ?? null, host: hostnameOf(row.url), loopback: isLoopbackUrl(row.url) }));
  if (webhooks.length) Object.assign(nodes.find(item => item.id === 'org:plugins').detail, { webhooks });
  for (const host of new Set(webhooks.map(item => item.host).filter(Boolean))) {
    const targets = webhooks.filter(item => item.host === host), loopback = targets.some(item => item.loopback);
    node(`external:webhook:${host}`, 'external', host, loopback ? 'listening' : 'declared', { endpoints: targets.length, loopback }, { link: '#flows' });
    edge('org:plugins', `external:webhook:${host}`, 'webhook', loopback ? 'listening' : 'declared', loopback ? 'web hook' : 'not contacted');
  }
  const connectorProviders = attempt(() => providers.connectors?.providers?.() ?? [], []);
  node('provider:connectors', 'provider', 'Connectors', connectorProviders.length ? 'ready' : 'disabled',
    { providers: connectorProviders.map(item => ({ id: item.id, level: item.level ?? null, operations: Array.isArray(item.operations) ? item.operations.length : item.operations ?? 0 })) },
    { link: '#services' });
  edge('org:flows', 'provider:connectors', 'process', operations.some(item => item.kind === 'cloud-flow') ? 'ready' : 'disabled', 'actions');
  // connector-runtime.mjs: the Dataverse connector writes through the record pipeline; shared_servicebus sends to the local bus.
  edge('provider:connectors', 'org:store', 'process', 'ready', 'Dataverse connector');
  if (providers.messaging) edge('provider:connectors', 'provider:messaging', 'bus', 'ready', 'Service Bus connector');
  for (const [id, connection] of Object.entries(config.connections ?? {})) {
    const principal = connection?.principal == null ? 'none' : typeof connection.principal === 'string' ? 'named' : 'inline';
    node(`connection:${id}`, 'connection', id, 'declared', { provider: connection?.provider ?? null, connector: connection?.connector ?? null, principal }, { link: '#services' });
    edge('provider:connectors', `connection:${id}`, 'reads', 'declared', connection?.provider ?? '');
    // A URL rewrite that points at a declared local service sends this connection's calls there.
    const targets = Object.values(connection?.settings?.rewrites ?? {}).map(originOf).filter(Boolean);
    for (const [service, settings] of Object.entries(config.localServices ?? {}))
      if (targets.includes(originOf(settings?.baseUrl ?? settings?.blob))) edge(`connection:${id}`, `provider:local-service:${service}`, 'http', 'declared', 'rewritten URL');
  }
  node('provider:secrets', 'provider', 'Secret references', providers.secrets ? 'ready' : 'disabled', { keys: providers.secrets ? attempt(() => providers.secrets.keys().length, 0) : 0 },
    { link: '#environment' });
  edge('org:flows', 'provider:secrets', 'reads', 'ready', 'secret parameters');
  if (providers.secrets) {
    node('external:keyvault', 'external', 'Key Vault', 'placeholder', { note: 'References resolve locally; no vault is contacted.' }, { link: '#environment' });
    edge('provider:secrets', 'external:keyvault', 'reads', 'placeholder', 'not contacted');
  }
  for (const record of attempt(() => providers.localServices?.describe?.() ?? [], [])) {
    const id = record.name.slice('local-service:'.length);
    node(`provider:local-service:${id}`, 'provider', id, 'declared', { service: record.service ?? null, required: record.required ?? false }, { level: record.level, link: '#services' });
    edge('host:admin', `provider:local-service:${id}`, 'http', 'declared', 'preflight probe');
    const external = record.service === 'service-bus' ? ['external:servicebus-emulator', 'Service Bus emulator']
      : record.service === 'azure-storage' ? ['external:azurite', 'Azurite']
        : nodes.some(item => item.id === `external:webhook:${hostnameOf(config.localServices?.[id]?.baseUrl)}`) ? [`external:webhook:${hostnameOf(config.localServices[id].baseUrl)}`] : null;
    if (!external) continue;
    if (external[1]) node(external[0], 'external', external[1], 'declared', {}, { link: '#services' });
    edge(`provider:local-service:${id}`, external[0], record.service === 'service-bus' ? 'bus' : 'http', 'declared', 'health probe');
  }
  for (const record of attempt(() => providers.serviceFixtures?.describe?.() ?? [], [])) {
    const service = record.name.replace(/^service:/, ''), levels = tally(record.operations ?? [], item => item.level);
    node(`provider:service-fixture:${service}`, 'provider', service, levels.behaviour || levels.fixture ? 'ready' : 'disabled', { operations: levels, ...(UNCALLED_FIXTURES[service] ? { note: UNCALLED_FIXTURES[service] } : {}) }, { link: '#services' });
  }
  const powerFx = attempt(() => providers.powerFx?.describe?.() ?? null, null);
  if (powerFx) node('provider:powerfx', 'provider', 'Power Fx', 'ready', { name: powerFx.name ?? null }, { level: powerFx.level, link: '#services' });
  // App surfaces: canvas apps from the Solution inventory, code apps from the host configuration.
  const canvas = inventory.filter(record => record.component === 'canvasapp');
  node('app:canvas', 'app', 'Canvas apps', canvas.length && canvasEnabled ? 'ready' : 'disabled', { apps: canvas.length, enabled: canvasEnabled }, { level: 'inventory', link: '#capabilities' });
  node('app:code', 'app', 'Code apps', codeApps.length ? 'ready' : 'disabled', { apps: codeApps.length }, { level: 'contract', link: '#capabilities' });
  // What the apps use: staff open them; their table sources read and write records as that person (roles, column security,
  // plug-ins), canvas formulas run on Power Fx and connector sources call the project's connections (canvas-runtime.mjs,
  // code-apps-http.mjs). A connection binds when its id equals the data source name or connection reference key.
  const bound = names => [...new Set(names)].filter(name => Object.hasOwn(config.connections ?? {}, name));
  // Without apps the connections are still drawn, switched off (the dashboard route marks edges of disabled nodes).
  const on = canvas.length && canvasEnabled ? 'ready' : 'disabled', needs = component => !canvas.length || canvas.some(record => (record.dependencies ?? []).some(item => item.component === component));
  edge('client:staff', 'app:canvas', 'http', on, 'staff session');
  if (needs('table')) edge('app:canvas', 'org:store', 'process', on, 'records as the user');
  if (powerFx) edge('app:canvas', 'provider:powerfx', 'process', on, 'formulas');
  if (needs('connector')) edge('app:canvas', 'provider:connectors', 'process', on, 'connector calls');
  for (const id of bound(canvas.flatMap(record => (record.canvas?.dataSources ?? []).map(item => item.name)))) edge('app:canvas', `connection:${id}`, 'reads', on, 'data source');
  const references = codeApps.flatMap(app => app.connectionReferences ?? []), code = codeApps.length ? 'ready' : 'disabled';
  edge('client:staff', 'app:code', 'http', code, 'staff session');
  edge('app:code', 'org:store', 'process', code, 'records as the user');
  edge('app:code', 'host:dataverse-api', 'http', codeApps.length && dataverse ? 'ready' : 'disabled', dataverse ? 'tokens' : 'tokens need the Web API');
  if (references.length || !codeApps.length) edge('app:code', 'provider:connectors', 'process', code, 'connector calls');
  for (const key of bound(references.map(item => item.key))) edge('app:code', `connection:${key}`, 'reads', code, 'connection reference');
}

// What each organization module is reached from and what it calls, traced to its module: `store` hooks run inside the
// records layer on save or query (recordHooks), `api` messages and routes are dispatched by the Web API host itself
// (dataverse-api.mjs operationCall and addRoute, not records.handle), and `jobs` is api.systemJob or the store scheduler.
// [from, to, label]; short names: store, api, jobs, admin, powerfx, secrets, outbox, flows, plugins, messaging, route:<name>;
// anything else is a module name (org:<name>). An edge is drawn only when both ends exist.
const MODULE_EDGES = Object.freeze([
  ['store', 'dataverse-standard', 'defaults on create'], ['store', 'dataverse-predefined', 'saved and user views'], ['api', 'dataverse-predefined', 'Web API message'],
  ['api', 'dataverse-activitypointer', 'activity view'], ['api', 'activity-messages', 'Web API message'], ['activity-messages', 'outbox', 'SendEmail'],
  ['api', 'record-messages', 'Web API message'], ['record-messages', 'dataverse-rollup', 'CalculateRollupField'],
  ['record-messages', 'dataverse-state-transitions', 'IsValidStateTransition'], ['api', 'dataverse-files', 'file upload'], ['store', 'dataverse-files', 'runs on save'],
  ['store', 'dataverse-storage-routing', 'files and notes'], ['dataverse-storage-routing', 'route:dataverseFiles', 'file columns'],
  ['dataverse-storage-routing', 'route:annotations', 'note bodies'], ['sharepoint-documents', 'route:sharepointDocuments', 'documents'],
  ['store', 'dataverse-elastic', 'table rules'], ['api', 'dataverse-elastic', 'Web API message'], ['api', 'dataverse-search', 'search'],
  ['store', 'dataverse-virtual-providers', 'virtual rows'], ['store', 'dataverse-data-messages', 'recycle bin'], ['api', 'dataverse-data-messages', 'Web API message'],
  ['dataverse-data-messages', 'jobs', 'imports'], ['api', 'dataverse-misc-messages', 'Web API message'], ['store', 'dataverse-misc-messages', 'virtual entity events'], ['store', 'dataverse-currency', 'runs on save'],
  ['store', 'dataverse-hierarchy', 'hierarchy queries'],
  ['api', 'dataverse-fls', 'Web API message'], ['api', 'dataverse-audit', 'change history'], ['store', 'dataverse-security-messages', 'runs on save'],
  ['api', 'dataverse-security-messages', 'sharing messages'], ['api', 'dataverse-security-messages2', 'team messages'], ['dataverse-security-messages2', 'jobs', 'background'],
  ['api', 'dataverse-customapi', 'custom API'], ['store', 'dataverse-customapi', 'low-code plug-ins'], ['dataverse-customapi', 'powerfx', 'Power Fx functions'],
  ['dataverse-customapi', 'plugins', 'plug-in type'], ['store', 'dataverse-business-rules', 'runs on save'], ['store', 'dataverse-calculated', 'runs on save'],
  ['store', 'dataverse-formula', 'runs on save'], ['dataverse-formula', 'powerfx', 'formula columns'], ['store', 'dataverse-rollup', 'runs on save'],
  ['dataverse-rollup', 'jobs', 'hourly recalculation'], ['store', 'dataverse-cascade', 'cascades'], ['store', 'dataverse-state-transitions', 'runs on save'],
  ['store', 'dataverse-duplicates', 'runs on save'], ['api', 'dataverse-duplicates', 'Web API message'], ['dataverse-duplicates', 'jobs', 'bulk detection'],
  ['store', 'dataverse-plugin-registration', 'checks registrations'], ['api', 'dataverse-plugin-registration', 'Web API message'],
  ['dataverse-plugin-registration', 'messaging', 'endpoint check'], ['api', 'dataverse-workflows', 'ExecuteWorkflow'], ['dataverse-workflows', 'flows', 'run flow'], ['api', 'dataverse-addon-ai', 'Web API message'],
  ['api', 'dataverse-addon-pva', 'Web API message'], ['api', 'dataverse-addon-d365', 'Web API message'], ['dataverse-addon-d365', 'jobs', 'bulk mail'], ['dataverse-addon-d365', 'activity-messages', 'SendEmail per recipient'],
  ['api', 'dataverse-addon-flows', 'Web API message'], ['dataverse-addon-flows', 'flow-runs', 'cancel runs'], ['store', 'flow-triggers', 'row changes'],
  ['flow-triggers', 'jobs', 'queued triggers'], ['flow-triggers', 'connectors', 'connector triggers'], ['flow-triggers', 'flows', 'starts'], ['admin', 'flow-triggers', 'HTTP trigger'], ['flows', 'flow-runs', 'run history'],
  ['flow-runs', 'jobs', 'wait timers'], ['admin', 'flow-runs', 'runs and waits'],
  ['api', 'dataverse-async', 'Web API message'], ['store', 'dataverse-async', 'job rules'], ['dataverse-async', 'jobs', 'system jobs'],
  ['api', 'dataverse-addon-workqueues', 'Web API message'], ['api', 'dataverse-calendar-messages', 'Web API message'],
  ['api', 'dataverse-solutions', 'Web API message'], ['dataverse-solutions', 'jobs', 'import'], ['api', 'dataverse-metadata-tables', 'metadata changes'],
  ['dataverse-metadata-tables', 'jobs', 'key index'], ['api', 'dataverse-metadata-relationships', 'metadata changes'], ['api', 'dataverse-metadata-messages', 'Web API message'],
  ['dataverse-metadata-messages', 'jobs', 'background'], ['api', 'dataverse-customization-messages', 'Web API message'], ['api', 'dataverse-org-messages', 'Web API message'],
  ['dataverse-org-messages', 'secrets', 'secret environment variables'], ['dataverse-org-messages', 'powerfx', 'ExecuteFxExpression'], ['api', 'dataverse-app-messages', 'Web API message'],
  ['api', 'dataverse-addon-git', 'Web API message'], ['dataverse-addon-git', 'jobs', 'background'], ['api', 'dataverse-addon-featurecontrol', 'Web API message'],
  ['api', 'usersettings', 'user settings'],
  // Administration (runtime-admin.mjs, sim-messaging-routes.mjs) and setup (lense/setup/server.mjs relays its status views).
  ['admin', 'store', 'records and state'], ['admin', 'outbox', 'outbox'], ['admin', 'messaging', 'queue messages'], ['setup', 'admin', 'reads status'],
  ['admin', 'connectors', 'connection sign-in and approvals'], ['admin', 'webapi-listener', 'request log'],
  ['outbox', 'route:annotations', 'email attachments'],
]);
const SHORT = Object.freeze({ store: 'org:store', api: 'host:dataverse-api', 'webapi-listener': 'host:dataverse-api', connectors: 'provider:connectors', jobs: 'org:jobs', admin: 'host:admin', setup: 'host:setup', powerfx: 'provider:powerfx',
  secrets: 'provider:secrets', outbox: 'provider:outbox', flows: 'org:flows', plugins: 'org:plugins', messaging: 'provider:messaging' });
const moduleId = name => SHORT[name] ?? (name.startsWith('route:') ? `provider:storage-route:${name.slice(6)}` : `org:${name}`);
function moduleEdges({ edge, nodes, dataverse }) {
  const ids = new Set(nodes.map(item => item.id));
  // Web API messages run in every Web API handler (dataverse-model-driven.mjs builds one over the same registry): from the
  // listener when it runs, else from the model-driven apps' in-app Web API.
  const messages = dataverse ? 'host:dataverse-api' : 'host:model-driven';
  for (const [from, to, label] of MODULE_EDGES) {
    const a = from === 'api' ? messages : moduleId(from), b = moduleId(to);
    // Host nodes (administration, setup) are added by the host; the dashboard route drops edges whose ends are absent.
    if ((ids.has(a) || a.startsWith('host:')) && (ids.has(b) || b.startsWith('host:'))) edge(a, b, 'process', 'ready', label);
  }
  // TriggerServiceEndpointCheck posts to loopback web hooks (dataverse-plugin-registration.mjs).
  for (const hook of nodes) if (hook.id.startsWith('external:webhook:') && hook.status === 'listening' && ids.has('org:dataverse-plugin-registration'))
    edge('org:dataverse-plugin-registration', hook.id, 'webhook', 'listening', 'endpoint check');
}

/**
 * Configuration summary: pack ids with their module directory relative to the project root, Solution layers and the
 * Dataverse listener ports. The host adds settingsKeys (names only) and its own ports.
 */
function topologyConfiguration({ packs, layers, projectRoot, dataverse }) {
  return {
    packs: packs.map(pack => { const directory = packDirectory(pack); return { id: pack.id, module: directory && projectRoot ? path.relative(projectRoot, directory).split(path.sep).join('/') || '.' : null }; }),
    solutionLayers: layers.map(layer => ({ solution: typeof layer.solution === 'string' ? layer.solution : layer.name ?? layer.solution?.uniqueName ?? null,
      version: layer.version ?? layer.solution?.version ?? null, type: layer.type ?? null })),
    ports: { dataverseApi: portOf(dataverse?.origin), dataverseTls: portOf(dataverse?.tlsOrigin), tds: dataverse?.tdsPort ?? null },
  };
}

/** Activity: counters since start plus the table passes the builders made. dataverseRequests counts data-plane requests only. */
function topologyActivity({ count, counters, dataverse }, { runs, overdueWaits, jobs, asyncRows, storageActivity, messages, outbox }) {
  return {
    dataverseRequests: { total: count('dataverseRequests'), failed: count('dataverseRequests.failed'), other: count('dataverseRequests.other'),
      recent: dataverse ? dataverse.requests().slice(-20).map(({ at, method, path: route, status, ms }) => ({ at: typeof at === 'number' ? new Date(at).toISOString() : at ?? null, method, path: route, status, ms })) : [] },
    plugins: { executions: count('plugins.executions'), failures: count('plugins.failures') },
    flows: { running: runs.Running ?? 0, succeeded: runs.Succeeded ?? 0, failed: (runs.Failed ?? 0) + (runs.TimedOut ?? 0), cancelled: runs.Cancelled ?? 0,
      waiting: runs.Waiting ?? 0, overdueWaits },
    jobs,
    asyncOperations: { byState: tally(asyncRows, row => ASYNC_STATES[Number(row.statecode)] ?? 'unknown') },
    messages, outbox,
    webhooks: { delivered: count('webhooks.delivered'), failed: count('webhooks.failed'), notContacted: count('webhooks.notContacted') },
    storage: { byProvider: storageActivity },
    counters,
  };
}
