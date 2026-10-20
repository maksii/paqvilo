// Solution-only composition. Power Pages imports, contact sessions and live bridges are absent.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import chokidar from 'chokidar';
import { createSetupHandler } from '../../lense/setup/server.mjs';
import { DataStore } from './data.mjs';
import { runtimeSettings, runtimeCapabilities } from './runtime-config.mjs';
import { simulationSettings, simulationReport } from './simulation-settings.mjs';
import { createSimulationPersistence } from './simulation-persistence.mjs';
import { discoverPacks } from './preset-registry.mjs';
import { initialOrganizationState } from './organization-bootstrap.mjs';
import { loadOrganizationSources } from './solution-runtime-source.mjs';
import { solutionWatchFilter } from './solution-roots.mjs';
import { dataverseSettings, dataverseStatus } from './dataverse-settings.mjs';
import { createOrganizationRuntime } from './dataverse-organization.mjs';
import { startDataverseApi } from './dataverse-api.mjs';
import { createModelDrivenRecordService } from './dataverse-model-driven.mjs';
import { createStaffSessions, createStaffSessionHandler } from './staff-session.mjs';
import { createModelDrivenData } from './model-driven/data.mjs';
import { createModelDrivenHandler } from './model-driven/http.mjs';
import { appCatalogue, solutionApps } from './model-driven/catalogue.mjs';
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
import { pluginHandlers, pluginCatalogue } from './exported-plugins.mjs';
import { pluginRuntimeDescriptors } from './plugin-clr.mjs';
import { overlayRegisteredSteps } from './dataverse-plugin-registration.mjs';
import { operationHandlers } from './exported-operations.mjs';
import { operationCatalogue, validateOperationOverrides } from './operation-catalogue.mjs';
import { workflowHandlers, workflowsWithActivation } from './dataverse-workflows.mjs';
import { customApiHandlers } from './dataverse-customapi.mjs';
import { addonHandlers } from './dataverse-addon-common.mjs';
import { sourceOrganizationExtensions } from './source-organization-extensions.mjs';
import { createOrganizationBackend } from './organization-backend.mjs';
import { ensureCertificate } from './dataverse-tls.mjs';

const fail = (message, status = 400, code = 'RuntimeRequestInvalid') => Object.assign(new Error(message), { status, code });
const assets = new Set(['index.html', 'app.mjs', 'style.css', 'persona-picker.mjs', 'persona-picker.css', 'persona-manager.mjs']);
const sharedAssets = new Set(['persona-search.mjs', 'persona-picker-view.mjs']);
const mime = file => file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
const json = (res, status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(status === 204 ? undefined : stringifyExactJson(value)); };
async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw fail('Send application/json.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw fail('Request exceeds 8 MiB.', 413); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid JSON request.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Provide a JSON object.');
  return value;
}

export async function createStandaloneRuntime(options = {}) {
  const runtime = runtimeSettings(options.runtime), simulation = simulationSettings(options.simulation);
  const modelDriven = modelDrivenSettings(options.modelDriven);
  if (runtime.kind === 'power-pages') throw new Error('The standalone host requires a model-driven or dataverse-api runtime.');
  if (options.sourceDir) throw new Error('Standalone runtimes select solutionRoots without a Power Pages sourceDir.');
  const host = options.host ?? '127.0.0.1', port = runtimePort(options.port, 0);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('The simulator binds only to loopback.');
  const projectRoot = options.projectRoot ?? process.cwd(), solutionRoots = options.solutionRoots ?? [];
  const stateFile = options.stateFile, diagnostics = [], csrf = randomBytes(32).toString('hex');
  const lcid = options.project?.lcid ?? options.dataverse?.localeId ?? 1033;
  let sources = await loadOrganizationSources({ solutionRoots, solutionOrder: options.solutionOrder, lcid,
    cacheFile: stateFile && !simulation ? path.join(path.dirname(stateFile), 'cache', 'solution-sources.json') : undefined });
  const packs = await discoverPacks({ project: options.project, explicit: options.dataPacks, packs: options.packs });
  const boot = initialOrganizationState({ solutionData: sources.solutionData, packs, environmentVariables: options.environmentVariables });
  const storageAdapter = await createSimulationPersistence({ settings: simulation, packs, stateFile });
  const store = new DataStore({ file: stateFile, state: options.initial ? { ...boot.state, ...options.initial,
    mappings: { ...boot.state.mappings, ...options.initial.mappings }, tables: { ...boot.state.tables, ...options.initial.tables } } : boot.state,
    presetLibrary: boot.presetLibrary, storageAdapter, persistence: options.persistence, platform: options.platform });
  let organization, dataverse, watcher, backend, sourceComponents, server, localOrigin, closing, watchedSourceSignature;
  const requests = new Set();
  let mutation = Promise.resolve();
  const change = fn => { const next = mutation.then(fn); mutation = next.catch(() => {}); return next; };
  const diagnostic = entry => { diagnostics.push(entry); if (diagnostics.length > 500) diagnostics.shift(); };
  const overlay = createSolutionMetadataOverlay({ appsOf: solutionApps }), metadata = () => overlay(sources.metadata, store.state);
  const settings = dataverseSettings({ enabled: runtime.kind === 'dataverse-api', ...(options.dataverse ?? {}), localeId: lcid });
  const registeredPlugins = pluginHandlers(packs), descriptors = pluginRuntimeDescriptors(packs), runtimes = new Map(), handlers = operationHandlers(packs);
  const pluginSteps = () => pluginCatalogue({ plugins: organization ? overlayRegisteredSteps(sources.metadata.plugins, store) : sources.metadata.plugins,
    handlers: registeredPlugins, runtimes, descriptors, overrides: store.state.simulator?.operations ?? {} });
  const workflows = () => workflowsWithActivation(sources.workflows, organization ? store : null);
  const operations = () => [...operationCatalogue({ workflows: workflows(), handlers, overrides: store.state.simulator?.operations ?? {} }), ...pluginSteps()];
  const cloudFlow = id => {
    const workflow = workflows().get(id); if (!workflow) return null;
    const item = operations().find(entry => entry.kind === 'cloud-flow' && entry.processId === id);
    return { definition: workflow.definition?.properties?.definition ?? workflow.definition?.definition, mode: item?.mode ?? 'placeholder',
      steps: item?.configuration?.steps, serviceProfile: handlers.flowIdentities.get(id) };
  };
  if (runtime.kind === 'dataverse-api' && !settings.enabled) throw new Error('A dataverse-api runtime requires its HTTP API to be enabled.');
  const caps = { ...runtimeCapabilities(runtime), dataverseApi: settings.enabled, setup: true, records: true, staff: true,
    personas: false, liveBridge: false, portalRendering: false };
  const links = () => ({ administration: '/_sim/', setup: '/_setup/', modelDriven: caps.modelDriven ? '/main.aspx' : null,
    powerPages: null, dataverseApi: dataverse?.origin ?? null });
  const policy = () => storageAdapter?.report(store.state) ?? simulationReport();
  const dvSummary = () => dataverseStatus(settings, dataverse ?? organization ?? {});
  const config = () => ({ ...store.state.simulator, runtime, simulation, dataverse: dvSummary(), permissionMode: store.state.settings.permissionMode });
  const recordCapabilities = () => Object.fromEntries(Object.keys(store.state.mappings).map(name => [name,
    store.storageAdapter?.recordCapabilities(name) ?? { create: true, update: true, delete: true }]));
  const status = () => ({ csrf, runtime, capabilities: caps, links: links(), simulation: policy(), sourceDir: null, solutionRoots,
    recordCapabilities: recordCapabilities(),
    stateFile: simulation?.level === 'dry-run' ? null : stateFile ?? null, revision: store.revision, mode: 'local', reloading: false,
    dataverse: dvSummary(), diagnostics: { total: diagnostics.length }, project: options.project ?? null });
  const exposed = () => ({ csrf, config: config(), status: { ...status(), tableCounts: Object.fromEntries(Object.entries(store.state.tables).map(([name, rows]) => [name, rows.length])) },
    runtime, capabilities: caps, links: links(), simulation: policy(), dataverse: dvSummary(),
    recordCapabilities: recordCapabilities(),
    summaryMode: true, mappings: Object.entries(store.snapshot({ sections: ['mappings'] }).mappings)
      .map(([logicalName, mapping]) => ({ logicalName, ...mapping })), diagnostics: [...sources.metadata.diagnostics, ...diagnostics], presets: [] });
  const close = () => closing ??= (async () => {
    const errors = [];
    const cleanup = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
    await cleanup(() => watcher?.close());
    const stopped = server?.listening ? new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) : Promise.resolve();
    await cleanup(() => dataverse?.close());
    await Promise.allSettled([...requests]);
    await cleanup(() => mutation);
    await cleanup(() => backend?.close?.());
    await cleanup(() => sourceComponents?.close());
    await cleanup(() => organization?.close());
    server?.closeAllConnections(); await stopped;
    if (errors.length) throw new AggregateError(errors, 'Standalone runtime cleanup failed.');
  })();
  try {
    await store.init();
    await store.replaceState(applySolutionData(store.snapshot(), sources.solutionData, { webApiTables: Object.keys(sources.solutionData.mappings), environmentVariables: options.environmentVariables, presetLibrary: boot.presetLibrary }));
    if (options.preset && (options.presetMode !== 'bootstrap' || !store.state.simulator.startupPreset)) await store.applyPreset(options.preset);
    const extensions = await sourceOrganizationExtensions({ layers: sources.solutionData.layers, plugins: sources.metadata.plugins,
      customApis: customApiHandlers(packs), pluginHandlers: registeredPlugins, workflowHandlers: workflowHandlers(packs),
      workflowOverrides: () => store.state.dataverse?.workflowOverrides ?? {}, cloudFlow, diagnostic, addonHandlers: addonHandlers(packs),
      timeoutMs: () => (store.state.dataverse?.environment?.pluginTimeoutSeconds ?? settings.pluginTimeoutSeconds) * 1000 });
    organization = await createOrganizationRuntime({ store, settings, change, schema: () => sources.schema,
      metadataFields: logical => metadata().entities?.[logical]?.fields, log: options.log ?? (() => {}), extensions });
    sourceComponents = createSourceSolutionComponentStorage({ store, components: () => sources.metadata.sourceComponents,
      entityId: (logical, state) => state.mappings[logical] ? uuidV5(organization.organizationId, `entity:${logical}`) : null });
    await store.transact(() => sourceComponents.materialize());
    backend = await createOrganizationBackend({ store, items: pluginSteps, handlers: registeredPlugins, runtimes, descriptors,
      operations, workflows, identities: () => handlers.flowIdentities, diagnostic, systemJobs: () => true });
    const sessions = createStaffSessions({ organization: () => organization, port: () => server?.address()?.port ?? port });
    const sessionHandler = createStaffSessionHandler({ sessions, csrf: () => csrf, json, readBody });
    let catalogueCache;
    const catalogue = () => {
      const current = metadata();
      if (catalogueCache?.metadata !== current || catalogueCache?.revision !== store.revision)
        catalogueCache = { metadata: current, revision: store.revision,
          value: appCatalogue({ metadata: current, mappings: store.state.mappings, providers: [], defaultApp: runtime.defaultApp,
            clientExtensions: clientExtensionCatalogue(sources.clientResources, modelDriven) }) };
      return catalogueCache.value;
    };
    // Validate an explicitly selected app before opening any listener.
    catalogue();
    const recordService = createModelDrivenRecordService({ organization, origin: () => localOrigin });
    const data = createModelDrivenData({ store, catalogue, recordService });
    const model = createModelDrivenHandler({ catalogue, data, csrf: () => csrf, json, readBody, change, read: organization.read, principal: req => sessions.resolve(req),
      clientAssets: () => modelDriven.trustedExtensions ? sources.clientResources.assets : new Map() });
    const dataverseAdmin = createDataverseAdmin({ store, getDataverse: () => dataverse ?? { ...organization, requests: () => [] },
      dataverseConfig: settings, dataverseSummary: dvSummary, json, jsonObjectBody: readBody, change });
    const admin = createRuntimeAdminRouter({ store, json, jsonObjectBody: readBody, change, csrf: () => csrf, status, state: exposed,
      configuration: config, simulation: policy, diagnostics: () => ({ diagnostics }), staffSession: sessionHandler, dataverseAdmin,
      configure: async patch => {
        if (Object.keys(patch).some(key => key !== 'operations')) throw fail('Change runtime configuration in Setup and restart this instance.', 409, 'RuntimeRestartRequired');
        const overrides = validateOperationOverrides(patch.operations, operations());
        await store.transact(() => { store.state.simulator.operations = overrides; }); return exposed();
      },
      shutdown: () => { options.onShutdown?.(); return close(); } });
    const setup = await createSetupHandler({ directory: projectRoot, ...(options.setup ?? (options.project?.configFile ? { project: options.project.configFile } : {})),
      runtime: { product: 'Mirage', ...runtime, capabilities: caps } });
    server = http.createServer((req, res) => {
      const handle = async () => {
        if (closing) throw fail('The runtime is stopping.', 503);
        res.setHeader('x-content-type-options', 'nosniff');
        if (req.headers.host !== new URL(localOrigin).host) throw fail('Invalid Host header.', 403);
        if (req.headers.origin && req.headers.origin !== localOrigin) throw fail('Cross-origin requests are not allowed.', 403);
        if (req.headers['sec-fetch-site'] === 'cross-site' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) throw fail('Cross-site writes are not allowed.', 403);
        const url = new URL(req.url, localOrigin);
        if (await setup(req, res)) return;
        if (await admin(req, res, url)) return;
        if (/^\/(?:_sim|__sim)\/api\/operations$/.test(url.pathname) && req.method === 'GET') { json(res, 200, { items: operations() }); return; }
        if (caps.modelDriven && await model(req, res, url)) return;
        if (['GET', 'HEAD'].includes(req.method) && /^\/(?:_sim|__sim)(?:\/|$)/.test(url.pathname)) {
          const file = url.pathname.replace(/^\/(?:_sim|__sim)\/?/, '') || 'index.html';
          if (!assets.has(file) && !sharedAssets.has(file)) throw fail('Resource not found.', 404);
          res.writeHead(200, { 'content-type': mime(file), 'cache-control': 'no-store' });
          res.end(req.method === 'HEAD' ? undefined : await fs.readFile(new URL(sharedAssets.has(file) ? `./${file}` : `../admin/${file}`, import.meta.url))); return;
        }
        if (url.pathname === '/' && ['GET', 'HEAD'].includes(req.method)) { res.writeHead(302, { location: caps.modelDriven ? '/main.aspx' : '/_sim/' }); res.end(); return; }
        throw fail('Resource not found.', 404);
      };
      const task = handle().catch(error => { diagnostic({ code: error.code ?? 'RuntimeError', message: error.message }); if (!res.headersSent) json(res, error.status ?? 500, { error: { code: error.code ?? 'RuntimeError', message: error.message } }); else res.destroy(); });
      requests.add(task); task.finally(() => requests.delete(task)).catch(() => {});
    });
    storageAdapter?.activate(store.state);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
    localOrigin = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
    if (settings.enabled) {
      const certificate = settings.tls ? await ensureCertificate(options.dataverseCertificateFile ?? (stateFile && !simulation ? path.join(path.dirname(stateFile), 'dataverse-ca.pem') : null)) : null;
      dataverse = await startDataverseApi({ organization, host, tls: certificate && { key: certificate.key, cert: certificate.cert } });
    }
    const reload = () => change(async () => {
      // Settle backend work while holding the host queue before publishing a new source snapshot.
      // The adapter's async publication context excludes unrelated store writers from the policy bypass.
      await backend?.settle();
      const next = await loadOrganizationSources({ solutionRoots, solutionOrder: options.solutionOrder, lcid });
      const apply = async () => {
        const previous = sources;
        try {
          await store.transact(() => {
            sources = next; store.state = applySolutionData(store.state, next.solutionData, { webApiTables: Object.keys(next.solutionData.mappings), environmentVariables: options.environmentVariables, presetLibrary: boot.presetLibrary }); sourceComponents.materialize();
          }, { isolated: true });
        } catch (error) { sources = previous; throw error; }
      };
      if (storageAdapter) await storageAdapter.bootstrap(apply, () => store.state); else await apply();
      if (watcher && watchedSourceSignature !== sourceSignature()) await restartWatcher();
    });
    const sourceSignature = () => JSON.stringify((sources.solutionData.layers ?? []).map(layer => [layer.type, layer.dir]));
    async function restartWatcher() {
      if (closing) return;
      const previous = watcher, previousSignature = watchedSourceSignature;
      let timer, releaseReady;
      const checkpoint = stateFile && path.resolve(stateFile);
      const pathKey = file => process.platform === 'win32' ? file.toLowerCase() : file;
      const checkpointKey = checkpoint && pathKey(checkpoint);
      const cacheDirectory = checkpoint && !simulation ? path.join(path.dirname(checkpoint), 'cache') : null;
      const ignored = solutionWatchFilter({ roots: solutionRoots, layers: sources.solutionData.layers,
        exclude: [cacheDirectory, ...(storageAdapter?.report(store.state).targets.map(target => target.file) ?? [])] });
      const watched = chokidar.watch(solutionRoots, { ignoreInitial: true,
        ignored: (file, stats) => {
          const absolute = pathKey(path.resolve(file));
          return Boolean(checkpointKey && (absolute === checkpointKey || absolute.startsWith(checkpointKey + '.'))) || ignored(file, stats);
        },
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });
      watcher = watched; watchedSourceSignature = sourceSignature();
      watched.on('all', () => { if (closing) return; clearTimeout(timer); timer = setTimeout(() => reload().catch(error => diagnostic({ code: 'RELOAD_FAILED', message: error.message })), 100); });
      watched.on('error', error => diagnostic({ code: 'WATCH_ERROR', message: error.message }));
      const stop = watched.close.bind(watched); watched.close = () => { clearTimeout(timer); releaseReady?.(); return stop(); };
      try {
        await new Promise((resolve, reject) => {
          const clean = () => { watched.off('ready', ready); watched.off('error', failed); releaseReady = null; };
          const ready = () => { clean(); resolve(); };
          const failed = error => { clean(); reject(error); };
          releaseReady = ready;
          watched.once('ready', ready); watched.once('error', failed);
        });
      } catch (error) {
        await watched.close().catch(() => {});
        watcher = previous; watchedSourceSignature = previousSignature;
        throw error;
      }
      if (closing) await watched.close();
      await previous?.close();
    }
    if (options.watch !== false && solutionRoots.length) await restartWatcher();
    return { url: localOrigin, origin: localOrigin, adminUrl: `${localOrigin}/_sim/`, port: server.address().port, store, runtime,
      organization, get dataverse() { return dataverse; }, state: exposed, status, reload, close,
      live: { status: () => ({ enabled: false, connected: false, liveWrites: 'disabled' }) },
      identityProvider: { available: false, origin: null, port: null } };
  } catch (error) { try { await close(); } catch (cleanupError) { diagnostic({ code: 'CLEANUP_FAILED', message: cleanupError.message }); } throw error; }
}
