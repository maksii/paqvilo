import { liveDataverseSettings } from './live-dataverse-settings.mjs';
import { createRecordCapabilitiesSummary } from './record-capabilities-summary.mjs';
import { statusResponseChunks } from './status-response.mjs';
// Solution-only composition. Power Pages imports, contact sessions and live bridges are absent.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { watchSources } from './source-watcher.mjs';
import { createSetupHandler } from '../../lense/setup/server.mjs';
import { DataStore } from './data.mjs';
import { runtimeSettings, runtimeCapabilities } from './runtime-config.mjs';
import { simulationSettings, simulationReport } from './simulation-settings.mjs';
import { createSimulationPersistence } from './simulation-persistence.mjs';
import { discoverPacks } from './preset-registry.mjs';
import { initialOrganizationState } from './organization-bootstrap.mjs';
import { loadOrganizationSources } from './solution-runtime-source.mjs';
import { assertReloadableScan } from './solution-schema.mjs';
import { solutionWatchFilter } from './solution-roots.mjs';
import { dataverseSettings, dataverseStatus } from './dataverse-settings.mjs';
import { createModelDrivenRecordService, createModelDrivenWebApi } from './dataverse-model-driven.mjs';
import { createStaffSessions, createStaffSessionHandler } from './staff-session.mjs';
import { createModelDrivenData, storeCatalogue } from './model-driven/data.mjs';
import { createModelDrivenHandler, routes as MODEL_DRIVEN_ROUTES } from './model-driven/http.mjs';
import { offlineSessionState } from './model-driven/offline.mjs';
import { canvasAppNames, solutionApps } from './model-driven/catalogue.mjs';
import { createSolutionMetadataOverlay } from './dataverse-solution-metadata.mjs';
import { createSourceSolutionComponentStorage } from './dataverse-source-components.mjs';
import { applySolutionData } from './solution-data.mjs';
import { createRuntimeAdminRouter } from './runtime-admin.mjs';
import { createDataverseAdmin } from './dataverse-admin.mjs';
import { stringifyExactJson } from './exact-numeric.mjs';
import { uuidV5 } from './dataverse-security.mjs';
import { runtimePort } from './runtime-port.mjs';
import { modelDrivenSettings } from './model-driven-settings.mjs';
import { clientExtensionCatalogue } from './model-driven-resources.mjs';
import { validateOperationOverrides } from './operation-catalogue.mjs';
import { ensureCertificate } from './dataverse-tls.mjs';
import { platformSettingEntries } from './platform-settings.mjs';
import {
  composeOrganizationHost,
  traceMethods,
  providerDescriptors,
  inventorySummary,
  codeAppDataverse,
  codeAppConnectors,
  persistentLevel,
  hostSurfaces,
  graphBindings,
  activeDeploymentProfile,
  simApiRoutes,
  modelDrivenAppsOf,
  appTraceSurface,
  staffActor,
} from './organization-host.mjs';
import { deploymentProfilesSummary } from './deployment-profiles.mjs';
import { createCanvasHandler } from './canvas-http.mjs';
import { createCanvasRuntime } from './canvas-runtime.mjs';
import { createCodeAppsHandler, authorityTokenIssuer } from './code-apps-http.mjs';
import { codeAppSettings, loadCodeApps } from './code-apps-config.mjs';
import { createRequestContext, runWithRequest, correlationOf } from './request-context.mjs';
import { createMessagingRoutes, routes as MESSAGING_ROUTES } from './sim-messaging-routes.mjs';
import { createFlowRoutes, routes as FLOW_ROUTES } from './sim-flow-routes.mjs';
import { createTraceChannel, createTraceRoutes, routes as TRACE_ROUTES } from './sim-trace-routes.mjs';
import { recordHttpError, statusFromHttp } from './trace-store.mjs';
import { ANONYMOUS_ROOT, setTraceHeaders } from './trace-hosts.mjs';
import { buildSourceGraph } from './source-graph.mjs';
import { scenarioSettings } from './capability-report.mjs';
import { ADMIN_CSP, adminAssetFile, adminAssetType, diagnosticsByCode as byCode } from './runtime-admin.mjs';
import { createDashboardRoutes, routes as DASHBOARD_ROUTES } from './sim-dashboard-routes.mjs';
import { createPackRoutes, routes as PACK_ROUTES } from './sim-pack-routes.mjs';
import {
  createEnvironmentRoutes,
  environmentVariableTable,
  applyEnvironmentOverride,
  routes as ENVIRONMENT_ROUTES,
} from './sim-environment-routes.mjs';
import { docsLinks } from './docs-links.mjs';
import { writeJsonChunks } from './json-response.mjs';

const fail = (message, status = 400, code = 'RuntimeRequestInvalid') =>
  Object.assign(new Error(message), { status, code });
const toolkitPackage = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const DOCS = docsLinks(toolkitPackage.version, toolkitPackage.repository?.url ?? toolkitPackage.repository);
// A /_sim/api write traced as an administration action (D-R3-7): not a trace route (the store's own settings, clear and
// flush) and not a run-starting flow route, whose root sim-flow-routes.mjs opens (POST /flow-runs, POST
// /flow-triggers/<id>, the HTTP Request trigger invoke path).
const SIM_ACTION =
  /^\/(?:_sim|__sim)\/api\/(?!trace(?:\/|$)|flow-runs$|flow-triggers\/[^/]+$|flow-triggers\/[^/]+\/triggers\/[^/]+\/paths\/invoke$)/;
const SIM_ACTOR = Object.freeze({ kind: 'system', id: null, name: 'simulator' });
const writeJson = (res, status, value, headers = {}, { chunks } = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  if (chunks && status !== 204) return writeJsonChunks(res, chunks);
  res.end(status === 204 ? undefined : stringifyExactJson(value));
};
async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw fail('Send application/json.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw fail('Request exceeds 8 MiB.', 413);
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail('Invalid JSON request.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Provide a JSON object.');
  return value;
}

export async function createStandaloneRuntime(options = {}) {
  if (options.sourceMaps !== undefined && typeof options.sourceMaps !== 'boolean')
    throw fail('sourceMaps must be true or false.');
  const startedAt = performance.now(),
    bootstrapTimings = {};
  const startupPhase = (phase) => {
    try {
      Promise.resolve(options.onStartup?.({ phase, elapsedMs: Math.round(performance.now() - startedAt) })).catch(
        () => {},
      );
    } catch {
      /* progress observer only */
    }
  };
  startupPhase('configuration');
  const runtime = runtimeSettings(options.runtime),
    simulation = simulationSettings(options.simulation);
  const modelDriven = modelDrivenSettings(options.modelDriven);
  if (runtime.kind === 'power-pages')
    throw new Error('The standalone host requires a model-driven or dataverse-api runtime.');
  if (options.sourceDir) throw new Error('Standalone runtimes select solutionRoots without a Power Pages sourceDir.');
  const host = options.host ?? '127.0.0.1',
    port = runtimePort(options.port, 0);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('The simulator binds only to loopback.');
  const projectRoot = options.projectRoot ?? process.cwd(),
    solutionRoots = options.solutionRoots ?? [];
  const watchedRoots = [...new Set([...solutionRoots, ...(modelDriven.clientSources ?? [])])];
  const stateFile = options.stateFile,
    diagnostics = [],
    csrf = randomBytes(32).toString('hex');
  const presetMode = options.presetMode ?? 'always';
  if (!['always', 'bootstrap'].includes(presetMode)) throw new Error('presetMode must be bootstrap or always');
  const stateExisted = stateFile
    ? await fs.stat(stateFile).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      )
    : false;
  const startupPreset = {
    name: options.preset ?? null,
    mode: presetMode,
    applied: Boolean(options.preset && (presetMode === 'always' || !stateExisted)),
  };
  const lcid = options.project?.lcid ?? options.dataverse?.localeId ?? 1033;
  bootstrapTimings.configurationMs = Math.round(performance.now() - startedAt);
  let seedStarted = performance.now();
  startupPhase('solution-import');
  // Durable local files (source cache, certificate, watcher cache) follow the one persistence rule (organization-host.mjs).
  const durable = Boolean(stateFile) && persistentLevel(simulation?.level ?? null);
  const sourceCacheFile = durable ? path.join(path.dirname(stateFile), 'cache', 'solution-sources.json') : undefined;
  // Resource import diagnostics reach the runtime diagnostics once the sink exists (sourceDiagnostic below).
  const early = [];
  let sourceDiagnostic = (entry) => early.push(entry);
  let sources = await loadOrganizationSources({
    solutionRoots,
    solutionOrder: options.solutionOrder,
    modelDriven,
    lcid,
    cacheFile: sourceCacheFile,
    projectRoot,
    diagnostic: (entry) => sourceDiagnostic(entry),
  });
  bootstrapTimings.sourcesMs = Math.round(performance.now() - seedStarted);
  bootstrapTimings.solutionCache = { ...sources.scan.cache?.stats, processHits: sources.scan.cache?.processHits };
  seedStarted = performance.now();
  const packs = await discoverPacks({ project: options.project, explicit: options.dataPacks, packs: options.packs });
  bootstrapTimings.packsMs = Math.round(performance.now() - seedStarted);
  seedStarted = performance.now();
  startupPhase('preset-library');
  const boot = initialOrganizationState({
    solutionData: sources.solutionData,
    packs,
    environmentVariables: options.environmentVariables,
  });
  bootstrapTimings.presetLibraryMs = Math.round(performance.now() - seedStarted);
  seedStarted = performance.now();
  const storageAdapter = await createSimulationPersistence({ settings: simulation, packs, stateFile });
  // Host clock/ids/scheduler (runtime-clock.mjs) drive the store, the organization and its backend; defaults are wall time.
  const clock = typeof options.clock === 'function' ? { now: options.clock } : (options.clock ?? undefined);
  const store = new DataStore({
    unpublished: true,
    file: stateFile,
    state: options.initial
      ? {
          ...boot.state,
          ...options.initial,
          mappings: { ...boot.state.mappings, ...options.initial.mappings },
          tables: { ...boot.state.tables, ...options.initial.tables },
        }
      : boot.state,
    presetLibrary: boot.presetLibrary,
    storageAdapter,
    persistence: options.persistence,
    platform: options.platform,
    ...(clock ? { clock } : {}),
    ...(options.ids ? { ids: options.ids } : {}),
  });
  bootstrapTimings.stateSeedMs = Math.round(performance.now() - seedStarted);
  let organization,
    dataverse,
    managedIdentity,
    watcher,
    backend,
    sourceComponents,
    server,
    localOrigin,
    closing,
    watchedSourceSignature,
    codeAppRecords = [];
  // The mounted /_sim/api routers' prefixes (status `routes`): the runtime admin router's own list, set where it is mounted.
  let adminRoutes = [];
  let managedIdentityHeaderShown = false;
  const requests = new Set();
  let mutation = Promise.resolve();
  const change = (fn) => {
    const next = mutation.then(fn);
    mutation = next.catch(() => {});
    return next;
  };
  const diagnostic = (entry) => {
    diagnostics.push(entry);
    if (diagnostics.length > 500) diagnostics.shift();
  };
  sourceDiagnostic = diagnostic;
  early.splice(0).forEach(diagnostic);
  const overlay = createSolutionMetadataOverlay({ appsOf: solutionApps }),
    metadata = () => overlay(sources.metadata, store.state);
  const settings = dataverseSettings({
    enabled: runtime.kind === 'dataverse-api',
    ...(options.dataverse ?? {}),
    localeId: lcid,
  });
  const liveSettings = liveDataverseSettings(settings, projectRoot, () => store);
  if (runtime.kind === 'dataverse-api' && !settings.enabled)
    throw new Error('A dataverse-api runtime requires its HTTP API to be enabled.');
  // The shared organization composition (organization-host.mjs): handler maps, memoised catalogues, providers, backend and API.
  const EMPTY = Object.freeze({});
  const caps = {
    ...runtimeCapabilities(runtime),
    ...(modelDriven.enabled === false ? { modelDriven: false } : {}),
    dataverseApi: settings.enabled,
    setup: true,
    records: true,
    staff: true,
    personas: false,
    liveBridge: false,
    portalRendering: false,
  };
  // Host surfaces registered in the capability registry under their legacy status keys (summary() reads them back).
  const surfaces = () => hostSurfaces({ host: 'standalone', dataverseApi: caps.dataverseApi });
  const organizationHost = await composeOrganizationHost({
    store,
    packs,
    runtime,
    surfaces,
    inventory: () => sources.inventory,
    localOrigin: () => localOrigin,
    codeApps: () => codeAppRecords,
    projectRoot,
    config: {
      connections: options.connections,
      secrets: options.secrets,
      providers: options.providers,
      localServices: options.localServices,
      canvas: options.canvas,
      connectorScripts: options.connectorScripts,
    },
    stateFile,
    simulation,
    sources: {
      readMetadata: (fn, options) => overlay.withReadEpoch(fn, options),
      plugins: () => sources.metadata.plugins,
      workflows: () => sources.workflows,
      layers: () => sources.solutionData.layers,
    },
    sourcesKey: () => sources,
    overrides: () => store.state.simulator?.operations ?? EMPTY,
    workflowOverrides: () => store.state.dataverse?.workflowOverrides ?? {},
    diagnostic,
    timeoutMs: () => (store.state.dataverse?.environment?.pluginTimeoutSeconds ?? settings.pluginTimeoutSeconds) * 1000,
    clock,
    ids: options.ids,
    scheduler: options.scheduler,
    trace: options.trace,
  });
  const { operations, traces } = organizationHost;
  // Every JSON answer of 400 or more of this host's routers is its request root's error (recordHttpError, D-R3-4).
  const json = (res, status, value, ...rest) => {
    if (status >= 400)
      recordHttpError(traces.current(), status, { code: value?.error?.code, message: value?.error?.message });
    return writeJson(res, status, value, ...rest);
  };
  const codeApps = codeAppSettings(options.codeApps);
  const links = () => ({
    administration: '/_sim/',
    setup: '/_setup/',
    modelDriven: caps.modelDriven ? '/main.aspx' : null,
    powerPages: null,
    dataverseApi: dataverse?.origin ?? null,
  });
  const policy = () => organizationHost.simulationReport(storageAdapter?.report(store.state) ?? simulationReport());
  const managedIdentityList = () => [
    ...(settings.managedIdentities ?? []),
    ...(store.state.dataverse?.managedIdentities ?? []),
  ];
  const managedIdentitySummary = ({ reveal = false } = {}) => {
    if (!managedIdentity) return { enabled: false };
    const env = managedIdentity.env(),
      mode = settings.managedIdentity?.mode ?? 'appservice';
    const shown = reveal && mode === 'appservice' && !managedIdentityHeaderShown;
    if (shown) managedIdentityHeaderShown = true;
    return {
      enabled: true,
      mode,
      endpoint: mode === 'appservice' ? env.IDENTITY_ENDPOINT : env.IMDS_ENDPOINT,
      header: shown ? env.IDENTITY_HEADER : null,
    };
  };
  const dvSummary = () => ({
    ...dataverseStatus(settings, dataverse ?? organization ?? {}),
    managedIdentity: managedIdentitySummary(),
  });
  const config = () => ({
    ...store.state.simulator,
    runtime,
    simulation,
    dataverse: dvSummary(),
    platformSettings: platformSettingEntries(store.state),
    permissionMode: store.state.settings.permissionMode,
  });
  // Deployment profile (deployment-profiles.mjs): loaded as the Power Pages host does, after state restore (a saved pin wins).
  let profile = null;
  const loadProfile = () =>
    activeDeploymentProfile({
      deploymentProfiles: options.deploymentProfiles,
      projectRoot,
      pin: store.state.simulator?.deploymentProfilePin ?? null,
    });
  const environmentOverrides = () => ({
    ...profile?.environmentVariables,
    ...options.environmentVariables,
    ...store.state.simulator?.environmentVariables,
  });
  const solutionDataOptions = (next) => ({
    webApiTables: Object.keys(next.solutionData.mappings),
    environmentVariables: environmentOverrides(),
    connectionReferences: profile?.connectionReferences ?? [],
    presetLibrary: boot.presetLibrary,
  });
  const recordCapabilities = createRecordCapabilitiesSummary(store);
  const status = ({ reuseCapabilities = false } = {}) => ({
    csrf,
    runtime,
    ...organizationHost.capabilityStatus({ reuse: reuseCapabilities }),
    links: links(),
    simulation: policy(),
    sourceDir: null,
    solutionRoots,
    inventory: inventorySummary(sources.inventory),
    providers: providerDescriptors(organizationHost.providers),
    services: organizationHost.providers.serviceFixtures?.describe() ?? [],
    startupPreset,
    bootstrap: { timings: { ...bootstrapTimings } },
    recordCapabilities: recordCapabilities({ reuse: reuseCapabilities }),
    stateFile: simulation?.level === 'dry-run' ? null : (stateFile ?? null),
    revision: store.revision,
    mode: 'local',
    reloading: false,
    dataverse: dvSummary(),
    platformSettings: platformSettingEntries(store.state),
    diagnostics: { total: diagnostics.length, byCode: byCode(diagnostics) },
    project: options.project ?? null,
    docs: DOCS,
    // Imported model-driven apps and the /_sim/api route prefixes this host mounts (the admin app reads them instead of probing).
    modelDrivenApps: modelDrivenAppsOf(sources.metadata),
    routes: simApiRoutes(
      MESSAGING_ROUTES,
      FLOW_ROUTES,
      TRACE_ROUTES,
      DASHBOARD_ROUTES,
      PACK_ROUTES,
      ENVIRONMENT_ROUTES,
      HOST_API_ROUTES,
      adminRoutes,
    ),
    // Admin-adjacent routes outside /_sim/api (model-driven/http.mjs routes): full paths, never probed by the admin app.
    adminAdjacentRoutes: MODEL_DRIVEN_ROUTES,
    // The /_sim/events?channels=... channels this host streams.
    eventChannels: ['trace'],
  });
  const exposed = () => ({
    csrf,
    config: config(),
    status: {
      ...status(),
      tableCounts: Object.fromEntries(Object.entries(store.state.tables).map(([name, rows]) => [name, rows.length])),
    },
    runtime,
    capabilities: organizationHost.capabilityStatus().capabilities,
    links: links(),
    simulation: policy(),
    dataverse: dvSummary(),
    recordCapabilities: recordCapabilities(),
    summaryMode: true,
    mappings: Object.entries(store.snapshot({ sections: ['mappings'] }).mappings).map(([logicalName, mapping]) => ({
      logicalName,
      ...mapping,
    })),
    diagnostics: [
      ...sources.metadata.diagnostics,
      ...sources.scan.diagnostics.filter((item) => item.severity === 'error' && !item.inventory),
      ...diagnostics,
    ],
    presets: [],
  });
  const preflight = ({ scenario = null, strict = false } = {}) =>
    organizationHost.preflight({
      simulation,
      scenario,
      strict,
      diagnostics: profile?.diagnostics ?? [],
      graph: buildSourceGraph({
        scan: sources.scan,
        metadata: sources.metadata,
        solutionData: sources.solutionData,
        workflows: sources.workflows,
        clientResources: sources.clientResources,
        mappings: store.snapshot({ sections: ['mappings'] }).mappings,
        bindings: graphBindings({ environmentVariables: options.environmentVariables, profile }),
      }),
    });
  const HOST_API = [
    [
      '/preflight',
      (url) =>
        preflight({
          strict: url.searchParams.get('strict') === 'true',
          scenario: url.searchParams.get('requires')
            ? scenarioSettings({
                id: url.searchParams.get('scenario') ?? 'request',
                requires: url.searchParams.getAll('requires'),
              })
            : null,
        }),
    ],
    ['/operations', () => ({ items: operations() })],
    // Every staff session's mobile offline summary (model-driven/offline.mjs); empty until the model-driven handler exists.
    ['/model-driven/offline', () => ({ items: offlineSessions() })],
  ];
  let offlineSessions = () => [];
  let model;
  const HOST_API_ROUTES = HOST_API.map(([prefix]) => prefix);
  const close = () =>
    (closing ??= (async () => {
      const errors = [];
      const cleanup = async (fn) => {
        try {
          await fn();
        } catch (error) {
          errors.push(error);
        }
      };
      await cleanup(() => watcher?.close());
      const stopped = server?.listening
        ? new Promise((resolve) => {
            server.close(resolve);
            server.closeIdleConnections();
          })
        : Promise.resolve();
      await Promise.allSettled([...requests]);
      await cleanup(() => mutation);
      await cleanup(() => sourceComponents?.close());
      await cleanup(() => model?.close());
      // One close order (organization-host.mjs): backend, organization, API, managed identity.
      await cleanup(() => organizationHost.close());
      await cleanup(() => store.closeRecordStorage());
      server?.closeAllConnections();
      await stopped;
      if (errors.length) throw new AggregateError(errors, 'Standalone runtime cleanup failed.');
    })());
  try {
    let stageAt = performance.now();
    startupPhase('state-restore');
    await store.init();
    bootstrapTimings.stateRestoreMs = Math.round(performance.now() - stageAt);
    stageAt = performance.now();
    bootstrapTimings.stateRestore = {
      existed: stateExisted,
      journal: store.storage?.journal ?? false,
      bytes: stateFile ? ((await fs.stat(stateFile).catch(() => null))?.size ?? 0) : 0,
    };
    startupPhase('state-composition');
    profile = await loadProfile();
    await organizationHost.loadCanvas();
    await store.initialize(() =>
      store.replaceState(
        applySolutionData(store.state, sources.solutionData, {
          ...solutionDataOptions(sources),
          owned: store.isInitializing(),
        }),
        {
          returnSnapshot: false,
          cloneInput: false,
          skipSaveIfUnchanged: true,
        },
      ),
    );
    bootstrapTimings.stateCompositionMs = Math.round(performance.now() - stageAt);
    stageAt = performance.now();
    startupPhase('preset');
    if (startupPreset.applied) await store.applyPreset(options.preset, { returnSnapshot: false });
    bootstrapTimings.presetMs = Math.round(performance.now() - stageAt);
    stageAt = performance.now();
    startupPhase('organization');
    organization = await organizationHost.createOrganization({
      initializing: true,
      settings: liveSettings,
      change,
      schema: () => sources.schema,
      metadataFields: (logical) => metadata().entities?.[logical]?.fields,
      log: options.log ?? (() => {}),
    });
    bootstrapTimings.organizationMs = Math.round(performance.now() - stageAt);
    sourceComponents = createSourceSolutionComponentStorage({
      store,
      components: () => sources.metadata.sourceComponents,
      entityId: (logical, state) =>
        state.mappings[logical] ? uuidV5(organization.organizationId, `entity:${logical}`) : null,
    });
    await store.initialize(() => {
      sourceComponents.materialize();
    });
    backend = await organizationHost.createBackend();
    const sessions = createStaffSessions({
      organization: () => organization,
      port: () => server?.address()?.port ?? port,
    });
    const sessionHandler = createStaffSessionHandler({ sessions, csrf: () => csrf, json, readBody });
    const catalogue = storeCatalogue({
      store,
      metadata,
      options: (current) => ({
        lazy: true,
        metadata: current,
        mappings: store.state.mappings,
        providers: [],
        defaultApp: runtime.defaultApp,
        settings: store.state.settings,
        clientExtensions: clientExtensionCatalogue(sources.clientResources, modelDriven),
        canvasApps: canvasAppNames(organizationHost),
      }),
    });
    // Validate an explicitly selected app before opening any listener.
    if (caps.modelDriven && runtime.defaultApp) catalogue();
    const recordService = createModelDrivenRecordService({ organization, origin: () => localOrigin });
    const data = createModelDrivenData({
      store,
      catalogue,
      recordService,
      readMetadata: (fn) => overlay.withReadEpoch(fn, { valid: () => store.isUnmodifiedRead() }),
    });
    // Canvas apps run headlessly as the selected staff user (canvas-runtime.mjs): Dataverse through the engine's data
    // sources as that user, writes in the host change slot, connectors through the project connections.
    const canvasRuntime = createCanvasRuntime({
      apps: organizationHost.canvasApps,
      evaluator: () => organizationHost.providers.powerFx,
      api: () => organization.api,
      caller: (principal) => {
        const user = organization.principals.byId(principal?.principalId);
        return user ? { user } : null;
      },
      transact: (fn) => change(() => organization.runOwned(() => organization.runAtomic(fn))),
      connectors: codeAppConnectors(organizationHost.connectors, options.connections ?? {}),
      diagnostic,
    });
    const canvas = createCanvasHandler({
      apps: organizationHost.canvasApps,
      enabled: () => organizationHost.canvas.enabled,
      diagnostic,
      runtime: canvasRuntime,
      principal: (req) => {
        const principal = sessions.resolve(req);
        return principal.kind === 'staff' ? principal : null;
      },
      csrf: () => csrf,
      traces,
      traceActor: (principal) => staffActor(organization, principal),
    });
    codeAppRecords = loadCodeApps(codeApps, projectRoot, { bindings: options.connections ?? {} });
    for (const app of codeAppRecords) for (const entry of app.diagnostics) diagnostic({ ...entry, app: app.name });
    const code = createCodeAppsHandler({
      apps: () => (codeAppRecords = loadCodeApps(codeApps, projectRoot, { bindings: options.connections ?? {} })),
      sessions,
      user: (id) => organization.principals.byId(id),
      organization: {
        get origin() {
          return dataverse?.origin ?? localOrigin;
        },
        organizationId: organization.organizationId,
        environmentId: organization.environmentId,
        tenantId: organization.tenantId,
      },
      issueToken: (input) => {
        if (!dataverse)
          throw Object.assign(
            new Error('Code app tokens need the Dataverse API; enable dataverse in the runtime settings.'),
            { status: 501, code: 'DataverseApiDisabled' },
          );
        return authorityTokenIssuer({ issueAccessToken: dataverse.issueAccessToken, origin: dataverse.origin })(input);
      },
      dataverse: codeAppDataverse({ organization, change, origin: () => dataverse?.origin ?? localOrigin }),
      connectors: codeAppConnectors(organizationHost.connectors, options.connections ?? {}),
      csrf: () => csrf,
      traces,
      diagnostic,
    });
    model = createModelDrivenHandler({
      streamMetadata: true,
      workerMetadata: true,
      sourceMaps: options.sourceMaps ?? true,
      diagnostic,
      catalogue,
      data,
      csrf: () => csrf,
      json,
      readBody,
      change,
      read: (fn) => organization.read(() => overlay.withReadEpoch(fn)),
      principal: (req) => sessions.resolve(req),
      traces,
      traceActor: (principal) => staffActor(organization, principal),
      webApi: createModelDrivenWebApi({ organization: () => organization }),
      offlineState: offlineSessionState(store, change),
      clientAssets: () =>
        modelDriven.trustedExtensions
          ? sources.clientResources.assets
          : new Map([...sources.clientResources.assets].filter(([, asset]) => asset.passive === true)),
    });
    offlineSessions = model.offlineSessions;
    const dataverseAdmin = createDataverseAdmin({
      store,
      getDataverse: () => dataverse ?? { ...organization, requests: () => [] },
      dataverseConfig: settings,
      dataverseSummary: dvSummary,
      managedIdentitySummary,
      managedIdentityList,
      json,
      jsonObjectBody: readBody,
      change,
    });
    // GET /_sim/api/preflight and /_sim/api/operations: one [prefix, handler] table; HOST_API_ROUTES is read from it.
    const hostApi = async (req, res, url) => {
      const route = /^\/(?:_sim|__sim)\/api(\/[a-z-]+(?:\/[a-z-]+)?)$/.exec(url.pathname)?.[1];
      const handle = req.method === 'GET' && HOST_API.find(([prefix]) => prefix === route)?.[1];
      if (!handle) return false;
      json(res, 200, await handle(url));
      return true;
    };
    const admin = createRuntimeAdminRouter({
      store,
      json,
      jsonObjectBody: readBody,
      change,
      csrf: () => csrf,
      status: () => status({ reuseCapabilities: true }),
      statusChunks: (value) => statusResponseChunks(value, recordCapabilities),
      state: exposed,
      configuration: config,
      simulation: policy,
      diagnostics: () => ({ diagnostics, byCode: byCode(diagnostics) }),
      staffSession: sessionHandler,
      dataverseAdmin,
      configure: async (patch) => {
        if (Object.keys(patch).some((key) => key !== 'operations'))
          throw fail('Change runtime configuration in Setup and restart this instance.', 409, 'RuntimeRestartRequired');
        // validateOperationOverrides throws on an invalid map and returns nothing: the validated map is the patch itself.
        validateOperationOverrides(patch.operations);
        const overrides = patch.operations ?? {};
        for (const key of Object.keys(overrides))
          if (!operations().some((item) => item.key === key))
            throw fail(`Unknown operation ${key}.`, 404, 'OperationNotFound');
        // A step switched to clr gets its CLR runtime prepared before the choice is stored.
        await organizationHost.applyOperationOverrides(overrides, () =>
          store.transact(() => {
            store.state.simulator.operations = overrides;
          }),
        );
        return exposed();
      },
      shutdown: () => {
        options.onShutdown?.();
        return close();
      },
    });
    adminRoutes = admin.routes;
    // /_sim/api/messages and /_sim/api/outbox (sim-messaging-routes.mjs) answer before the generic admin router.
    const messagingRoutes = createMessagingRoutes({ api: organization.api, csrf: () => csrf });
    const flowRoutes = createFlowRoutes({
      api: organization.api,
      csrf: () => csrf,
      origin: { host: 'standalone', portal: null, preset: null },
    });
    const traceRoutes = createTraceRoutes({ traces, csrf: () => csrf, json });
    const traceChannel = createTraceChannel(traces);
    // GET /_sim/api/dashboard (sim-dashboard-routes.mjs): the shared topology plus this host's listener and request count.
    const dashboardRoutes = createDashboardRoutes({
      host: organizationHost,
      docs: DOCS,
      extras: () => ({
        runtime: {
          simulationLevel: simulationReport(simulation).level,
          revision: null,
          reloading: false,
          localOrigin,
          stateFile:
            simulation?.level === 'dry-run' || !stateFile
              ? null
              : path.relative(projectRoot, stateFile).split(path.sep).join('/'),
          projectRoot: '.',
        },
        nodes: [
          {
            id: 'host:model-driven',
            kind: 'host',
            label: 'Model-driven apps',
            status: caps.modelDriven ? 'listening' : 'disabled',
            detail: { path: caps.modelDriven ? '/main.aspx' : null },
            link: '#dataverse',
          },
          {
            id: 'host:setup',
            kind: 'host',
            label: 'Setup workspace',
            status: 'listening',
            detail: { path: '/_setup/' },
          },
          { id: 'host:admin', kind: 'host', label: 'Administration', status: 'listening', detail: { path: '/_sim/' } },
          // Staff administer the runtime and open its model-driven, canvas and code apps.
          {
            id: 'client:staff',
            kind: 'client',
            label: 'Staff browser',
            status: 'ready',
            detail: {},
            link: '#dataverse',
          },
        ],
        // The model-driven shell calls /_apps/api on this origin, in process; it does not use the Web API listener.
        edges: [
          { from: 'client:staff', to: 'host:model-driven', kind: 'http', status: 'listening', label: 'browser' },
          {
            from: 'host:model-driven',
            to: 'org:store',
            kind: 'process',
            status: 'ready',
            label: 'records and Web API messages, in the app',
          },
          {
            from: 'host:model-driven',
            to: 'app:canvas',
            kind: 'process',
            status: 'ready',
            label: 'embedded canvas apps',
          },
          { from: 'client:staff', to: 'host:admin', kind: 'http', status: 'listening', label: 'administer' },
          { from: 'client:staff', to: 'host:setup', kind: 'http', status: 'listening', label: 'configure' },
        ],
        configuration: {
          settingsKeys: options.configuredSettings ?? null,
          ports: { portal: null, identityProvider: null },
        },
        // No source reload revision here (reloads: null); inFlight leaves out this dashboard request itself.
        activity: {
          inFlight: Math.max(0, requests.size - 1),
          diagnostics: { total: diagnostics.length, byCode: byCode(diagnostics) },
          reloads: null,
        },
      }),
    });
    // GET /_sim/api/packs (sim-pack-routes.mjs): no portal here, so matched is null.
    const packRoutes = createPackRoutes({
      packs,
      registration: { project: options.project, dataPacks: options.dataPacks, packs: options.packs },
      projectRoot,
      state: () => store.state,
      library: () => boot.presetLibrary,
      simulation: policy,
    });
    // /_sim/api/environment (sim-environment-routes.mjs): Solution environment variables and local overrides; deployment
    // profile files are read by the Power Pages host only.
    const environmentRoutes = createEnvironmentRoutes({
      csrf: () => csrf,
      change,
      json,
      jsonObjectBody: readBody,
      environment: {
        definitions: () => environmentVariableTable(store, { secrets: organization.api?.secrets ?? null }),
        profiles: () =>
          profile
            ? deploymentProfilesSummary(profile.config, profile)
            : { supported: false, reason: 'No deploymentProfiles are configured for this runtime.' },
        setOverride: async (schemaName, value) => {
          await store.transact(() =>
            applyEnvironmentOverride(store, store.state, schemaName, value, {
              secrets: organization.api?.secrets ?? null,
            }),
          );
          return environmentVariableTable(store, { secrets: organization.api?.secrets ?? null }).definitions.find(
            (item) => item.schemaName === schemaName,
          );
        },
        extra: () => ({
          solutionRoots,
          live: { supported: false, reason: 'The live bridge belongs to the Power Pages host.' },
        }),
      },
    });
    const setup = await createSetupHandler({
      directory: projectRoot,
      ...(options.setup ?? (options.project?.configFile ? { project: options.project.configFile } : {})),
      runtime: { product: 'Mirage', ...runtime, capabilities: caps },
    });
    server = http.createServer((req, res) => {
      const handle = async () => {
        if (closing) throw fail('The runtime is stopping.', 503);
        res.setHeader('x-content-type-options', 'nosniff');
        if (req.headers.host !== new URL(localOrigin).host) throw fail('Invalid Host header.', 403);
        if (req.headers.origin && req.headers.origin !== localOrigin)
          throw fail('Cross-origin requests are not allowed.', 403);
        if (req.headers['sec-fetch-site'] === 'cross-site' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))
          throw fail('Cross-site writes are not allowed.', 403);
        const url = new URL(req.url, localOrigin);
        if (await setup(req, res)) return;
        // GET /_sim/events?channels=trace: the trace channel, with the frames the Power Pages host streams.
        if (/^\/(?:_sim|__sim)\/events$/.test(url.pathname)) {
          if (req.method !== 'GET') throw fail('Method not allowed.', 405, 'MethodNotAllowed');
          // The client may have gone while setup awaited: a closed response joins no channel.
          if (res.destroyed) return;
          if (!(url.searchParams.get('channels') ?? '').split(',').includes('trace'))
            throw fail('This host streams the trace channel only (channels=trace).', 400, 'UnsupportedEventChannel');
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.write(`event: ready\ndata: ${store.revision}\n\n`);
          traceChannel(res);
          return;
        }
        if (
          (await messagingRoutes(req, res, url)) ||
          (await flowRoutes(req, res, url)) ||
          (await traceRoutes(req, res, url)) ||
          (await dashboardRoutes(req, res, url)) ||
          (await packRoutes(req, res, url))
        )
          return;
        if (await environmentRoutes(req, res, url)) return;
        if ((await admin(req, res, url)) || (await hostApi(req, res, url))) return;
        // Reserved app surfaces answer before the model-driven handler, which refuses every other /_apps/* path.
        if (canvas(req, res, url)) return;
        if (await code(req, res, url)) return;
        if (caps.modelDriven && (await model(req, res, url))) return;
        if (['GET', 'HEAD'].includes(req.method) && /^\/(?:_sim|__sim)(?:\/|$)/.test(url.pathname)) {
          // The page answers /_sim and /_sim/ only (as on Power Pages); /_sim/index.html falls under the asset pattern and 404s.
          const file = url.pathname.replace(/^\/(?:_sim|__sim)\/?/, ''),
            index = file === '';
          const source = index ? new URL('../admin/index.html', import.meta.url) : await adminAssetFile(file);
          if (!source) throw fail('Resource not found.', 404);
          res.writeHead(200, {
            'content-type': adminAssetType(index ? 'index.html' : file),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...(index ? { 'content-security-policy': ADMIN_CSP } : {}),
          });
          res.end(req.method === 'HEAD' ? undefined : await fs.readFile(source));
          return;
        }
        if (url.pathname === '/' && ['GET', 'HEAD'].includes(req.method)) {
          res.writeHead(302, { location: caps.modelDriven ? '/main.aspx' : '/_sim/' });
          res.end();
          return;
        }
        throw fail('Resource not found.', 404);
      };
      // The http root span of this host (docs/design/tracing.md). App surfaces name their host and module (model-driven,
      // canvas, code-app; appTraceSurface), any other path the standalone host. The root starts explicitly anonymous with
      // no session (this host has no visitor sign-in), so a header-named parent never lends it another visitor's actor or
      // session; the app handlers name the staff user once they resolve the session. Administration actions (a /_sim/api
      // write) are `sim` roots acting as the simulator; reads, setup, the trace routes and the run-starting flow routes
      // (sim-flow-routes.mjs opens their roots) open none.
      const pathname = String(req.url ?? '/').split('?')[0];
      const adminPath = /^\/(?:_sim|__sim|_setup)(?:\/|$)/.test(pathname);
      const simAction = adminPath && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && SIM_ACTION.test(pathname);
      const surface = adminPath ? null : appTraceSurface(pathname);
      const span =
        traces.enabled && (!adminPath || simAction)
          ? traces.start({
              kind: 'http',
              name: `${req.method} ${pathname}`,
              module: simAction ? 'sim' : (surface?.module ?? null),
              operation: req.method,
              origin: { host: simAction ? 'sim' : (surface?.host ?? 'standalone'), portal: null, preset: null },
              ...(simAction ? { actor: SIM_ACTOR, session: ANONYMOUS_ROOT.session } : ANONYMOUS_ROOT),
              attributes: { routeFamily: pathname.split('/')[1] || 'root' },
              ...traces.fromHeaders(req.headers),
            })
          : null;
      setTraceHeaders(res, span);
      let failure;
      res.on('close', () => {
        const status = res.writableFinished ? res.statusCode : 499;
        span?.end({
          status: statusFromHttp(status),
          error: status >= 400 ? failure : undefined,
          attributes: { statusCode: status },
        });
      });
      // One request context per call (x-ms-correlation-request-id when given) inside this runtime's pack registries.
      const context = createRequestContext({
        organization,
        correlationId: correlationOf(req.headers['x-ms-correlation-request-id']) ?? undefined,
        traceId: span?.traceId ?? null,
        spanId: span?.spanId ?? null,
      });
      const task = organizationHost
        .run(() => traces.run(span, () => runWithRequest(context, handle)))
        .catch((error) => {
          failure = error;
          diagnostic({ code: error.code ?? 'RuntimeError', message: error.message });
          if (!res.headersSent)
            json(res, error.status ?? 500, { error: { code: error.code ?? 'RuntimeError', message: error.message } });
          else res.destroy();
        });
      requests.add(task);
      task.finally(() => requests.delete(task)).catch(() => {});
    });
    storageAdapter?.activate(store.state);
    store.completeInitialization();
    startupPhase('listener');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    localOrigin = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
    if (settings.enabled) {
      const certificate = settings.tls
        ? await ensureCertificate(
            options.dataverseCertificateFile ??
              (durable ? path.join(path.dirname(stateFile), 'dataverse-ca.pem') : null),
          )
        : null;
      dataverse = await organizationHost.startApi({
        host,
        tls: certificate && { key: certificate.key, cert: certificate.cert },
        managedIdentities: managedIdentityList,
        managedIdentityMode: settings.managedIdentity?.mode ?? 'appservice',
        secretDirectory: path.join(projectRoot, '.paqvilo', 'mirage'),
      });
      managedIdentity = organizationHost.managedIdentity;
    }
    // Backend work settles before the host queue is taken, as server.mjs does: a job that calls api.change would otherwise
    // wait on the queue this reload holds while the reload waits on the job. The adapter's async publication context
    // excludes unrelated store writers from the policy bypass.
    const reload = async () => {
      await backend?.settle();
      return change(async () => {
        const next = await loadOrganizationSources({
          solutionRoots,
          solutionOrder: options.solutionOrder,
          modelDriven,
          lcid,
          cacheFile: sourceCacheFile,
          projectRoot,
          diagnostic,
        });
        assertReloadableScan(sources.scan, next.scan);
        const nextProfile = await loadProfile();
        const apply = async () => {
          const previous = { sources, profile };
          try {
            // One isolated transaction: Solution data, source components and the re-registered source modules (custom APIs,
            // duplicate rules, workflows, plug-in registrations) commit together or not at all.
            await store.transact(
              async () => {
                sources = next;
                profile = nextProfile;
                store.state = applySolutionData(store.state, next.solutionData, solutionDataOptions(next));
                sourceComponents.materialize();
                await organizationHost.refreshSources();
              },
              { isolated: true },
            );
          } catch (error) {
            ({ sources, profile } = previous);
            throw error;
          }
        };
        if (storageAdapter) await storageAdapter.bootstrap(apply, () => store.state);
        else await apply();
        if (watcher && watchedSourceSignature !== sourceSignature()) await restartWatcher();
      });
    };
    const sourceSignature = () =>
      JSON.stringify((sources.solutionData.layers ?? []).map((layer) => [layer.type, layer.dir]));
    async function restartWatcher() {
      if (closing) return;
      const previous = watcher,
        previousSignature = watchedSourceSignature;
      let timer, releaseReady;
      const checkpoint = stateFile && path.resolve(stateFile);
      const pathKey = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
      const checkpointKey = checkpoint && pathKey(checkpoint);
      const cacheDirectory = checkpoint && durable ? path.join(path.dirname(checkpoint), 'cache') : null;
      // A <Library>@<version>.js clientSources entry is a file root (watched as that file), never a directory layer.
      const ignored = solutionWatchFilter({
        roots: watchedRoots,
        layers: [
          ...sources.solutionData.layers,
          ...(modelDriven.clientSources ?? [])
            .filter((source) => !/[.]js$/i.test(source))
            .map((dir) => ({ type: 'directory', dir })),
        ],
        exclude: [cacheDirectory, ...(storageAdapter?.report(store.state).targets.map((target) => target.file) ?? [])],
      });
      const watched = watchSources(watchedRoots, {
        ignoreInitial: true,
        ignored: (file, stats) => {
          const absolute = pathKey(path.resolve(file));
          return (
            Boolean(checkpointKey && (absolute === checkpointKey || absolute.startsWith(checkpointKey + '.'))) ||
            ignored(file, stats)
          );
        },
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });
      watcher = watched;
      watchedSourceSignature = sourceSignature();
      watched.on('all', () => {
        if (closing) return;
        clearTimeout(timer);
        timer = setTimeout(
          () => reload().catch((error) => diagnostic({ code: 'RELOAD_FAILED', message: error.message })),
          100,
        );
      });
      watched.on('error', (error) => diagnostic({ code: 'WATCH_ERROR', message: error.message }));
      const stop = watched.close.bind(watched);
      watched.close = () => {
        clearTimeout(timer);
        releaseReady?.();
        return stop();
      };
      try {
        await new Promise((resolve, reject) => {
          const clean = () => {
            watched.off('ready', ready);
            watched.off('error', failed);
            releaseReady = null;
          };
          const ready = () => {
            clean();
            resolve();
          };
          const failed = (error) => {
            clean();
            reject(error);
          };
          releaseReady = ready;
          watched.once('ready', ready);
          watched.once('error', failed);
        });
      } catch (error) {
        await watched.close().catch(() => {});
        watcher = previous;
        watchedSourceSignature = previousSignature;
        throw error;
      }
      if (closing) await watched.close();
      bootstrapTimings.watcher =
        watched.nativeWatchCount?.() > 0
          ? { backend: 'windows-recursive', handles: watched.nativeWatchCount() }
          : { backend: 'chokidar', directories: Object.keys(watched.getWatched?.() ?? {}).length };
      await previous?.close();
    }
    if (options.watch !== false && watchedRoots.length) await restartWatcher();
    bootstrapTimings.listenerMs = Math.round(performance.now() - startedAt);
    bootstrapTimings.startupMs = bootstrapTimings.listenerMs;
    bootstrapTimings.memory = { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed };
    startupPhase('listener-ready');
    return {
      url: localOrigin,
      origin: localOrigin,
      adminUrl: `${localOrigin}/_sim/`,
      port: server.address().port,
      store,
      runtime,
      organization,
      get dataverse() {
        return dataverse;
      },
      state: exposed,
      csrf,
      status,
      reload,
      close,
      preflight,
      settle: () => organizationHost.settle(),
      // The trace store's read and settings methods (docs/design/tracing.md).
      trace: traceMethods(traces),
      live: { status: () => ({ enabled: false, connected: false, liveWrites: 'disabled' }) },
      identityProvider: { available: false, origin: null, port: null },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      diagnostic({ code: 'CLEANUP_FAILED', message: cleanupError.message });
    }
    throw error;
  }
}
