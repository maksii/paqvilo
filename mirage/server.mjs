import http from "node:http";
import { validatePersonaCatalog, mergePersonaCatalogs, resolvePersonaCatalog, personaContactId, personaStartPath } from './lib/persona-catalog.mjs';
import {identityProviderSettings,identityProviderAssets} from './lib/identity-provider-settings.mjs';
import { closestPersonaKeys } from './lib/persona-search.mjs';
import { createPersonaContexts } from './lib/persona-contexts.mjs';
import { personaContextSettings } from './lib/persona-context-settings.mjs';
import { StateStorage } from './lib/state-storage.mjs';
import { nativeRichTextReady } from './lib/richtext-readiness.mjs';
import { renderSettings } from './lib/render-settings.mjs';
import { createSetupHandler } from '../lense/setup/server.mjs';
import {parseExactJson,stringifyExactJson} from './lib/exact-numeric.mjs';
import { attachODataReaderDetails, attachODataJsonSource, odataInvalidJsonDetails } from "./lib/webapi-error-details.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { readLocalFile } from '../lense/local-file.mjs';
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from "node:async_hooks";
import { AuditLog } from "./lib/audit-log.mjs";
import chokidar from "chokidar";
import { resolveDeploymentProfiles, loadDeploymentProfiles, profileSelection, deploymentProfilesSummary } from './lib/deployment-profiles.mjs';
import {
  DataStore,
  parseFetchXml,
  builtinPresets,
  resolvePreset,
  normalizeMockLiquidRecord,
  normalizeMockLiquidFetchXml,
} from "./lib/data.mjs";
import { DATA_MODELS, importPortal, normalizePortalPath } from "./lib/importer.mjs";
import { createPortalRenderer, renderShellResource } from "./lib/liquid.mjs";
import { formContentStyles } from './lib/form-head.mjs';
import { emptyUnmappedLiquidFetchXml, observedLiquidEntityRead } from "./lib/liquid-missing-data.mjs";
import { observedPageQueryValidation } from "./lib/page-query-validation.mjs";
import { observedPageErrorResponse } from "./lib/page-error-presentation.mjs";
import { initialState } from "./lib/bootstrap.mjs";
import { listPresets } from "./lib/presets.mjs";
import { applyPortalOverrides, portalOverrideEntries, validatePortalOverrides } from "./lib/portal-overrides.mjs";
import { platformSettingEntries, validatePlatformOverrides } from './lib/platform-settings.mjs';
import { experimentPresets, experimentId, validateExperiment, validateExperimentPresets, applyExperiment, configurationPresetReport } from './lib/experiment-presets.mjs';
import { inspectPage } from "./lib/page-resources.mjs";
import { enrichReference } from "./enrich-reference.mjs";
import { discoverSourceDependencies, runtimeDependencyPaths, injectRuntimeDependencies, injectRuntimeCompatibility, isHtmlDocument } from "./lib/source-dependencies.mjs";
import { resolveLocalOverrides, injectLocalHead } from './lib/local-overrides.mjs';
import { platformStylesStatus, formStyleDiagnostics } from './lib/platform-styles.mjs';
import { LiveBridge, normalizeLiveRecord } from "./lib/live.mjs";
import { AssetCache } from "./lib/asset-cache.mjs";
import { capturePortalShell } from "./lib/shell-capture.mjs";
import { serverLogicName, serverLogicUnsupported } from "./lib/server-logic.mjs";
import { operationHandlers, assertOperationRole, runExportedServerLogic, runExportedCloudFlow, importOperationWorkflows } from './lib/exported-operations.mjs';
import {createFlowTriggerRunner} from './lib/flow-triggers.mjs';
import { operationCatalogue, validateOperationOverrides, operationPlaceholder, importSolutionOperationSources, withSolutionOperations } from './lib/operation-catalogue.mjs';
import { pluginHandlers, pluginCatalogue, runPluginPhase, pluginStepMatchesEntity } from './lib/exported-plugins.mjs';
import {pluginRuntimeDescriptors,prepareClrRuntime,closeClrHostPool} from './lib/plugin-clr.mjs';
import {createAsyncPluginRunner} from './lib/plugin-async.mjs';
import {settleCommittedWork} from './lib/committed-work.mjs';
import { importCodeComponents, renderCodeComponent } from './lib/code-components.mjs';
import { mergeShellProfile } from "./lib/shell-profile.mjs";
import { captureRichTextAssets } from "./lib/richtext-assets.mjs";
import { captureObservedSnippetComposition } from "./lib/observed-snippet-composition.mjs";
import {
  captureObservedStylesheets,
  resolveObservedStylesheet,
} from "./lib/observed-stylesheets.mjs";
import {
  resolveRichTextConfiguration,
  richTextConfigurationStatus,
} from "./lib/richtext-config.mjs";
import { pageAccess } from "./lib/page-access.mjs";
import { sourceFingerprint, cachedSourceFingerprint, observedEvidence, implementationEvidence } from "./lib/evidence.mjs";
import { verificationWitness, verificationTableSelection } from './lib/verification-witness.mjs';
import { importSolutionMetadata } from "./lib/solution-metadata.mjs";
import { importSolutionData, applySolutionData } from "./lib/solution-data.mjs";
import { scanSolutionSources, buildSolutionSchema } from "./lib/solution-schema.mjs";
import { SolutionFileCache, sourceDirectoryDigest } from "./lib/solution-cache.mjs";
import { resolveUnmatchedRoute, deniedPageRoute, languageRoute, siteMarkerRoute, siteSetting, servicePages, exportedPageFor, loginPath, signInPath, applyObserved, requestTargetUrl } from "./lib/redirects.mjs";
import { authCookieName, createAuthSessions, authRoute, safeReturnUrl, returnUrlParameter, signInContent } from "./lib/auth-session.mjs";
import { createExternalSignIn } from "./lib/sign-in-flow.mjs";
import { authenticationSettings } from "./lib/external-login.mjs";
import { siteHeaders, webFileHeaders, webFileDisposition, tokenHtmlHeaders, notModified, PAGE_CACHE_CONTROL, PAGE_HEADERS, platformResourceHeaders } from "./lib/response-headers.mjs";
import { solutionWatchFilter } from "./lib/solution-roots.mjs";
import { observedConfig } from "./lib/project-config.mjs";
import { runtimePort } from './lib/runtime-port.mjs';
import { createFrameReadiness } from "./lib/frame-readiness.mjs";
import { formWriteError } from "./lib/form-error-presentation.mjs";
import { assertPortalSource, portalSourceDir } from "./lib/source-dialect.mjs";
import { discoverPacks } from "./lib/preset-registry.mjs";
import { collectWebApiErrorTemplates } from "./lib/webapi-error-templates.mjs";
import { injectRuntime, renderComponent, renderQuickForm } from "./lib/platform.mjs";
import { submitPortalForm, createWebFormSessions, webFormSessionOwner } from "./lib/form-service.mjs";
import { resolveNativeFormSubmission, submitNativePostback, nativePostbackResponse } from './lib/native-form-submission.mjs';
import { multipartControls, nativeFormTransport, decodeNativeViewState } from './lib/native-postback.mjs';
import { readVisitor, newVisitor, visitorCookieName } from "./lib/visitor-session.mjs";
import { handleNativeService, antiForgeryCookie } from "./lib/native-services.mjs";
import { antiForgeryHolder, isAspNetScript, webFormsForm, platformShell, bootstrapVariant } from "./lib/platform-manifest.mjs";
import { packEndpoints } from "./lib/extensions.mjs";
import {
  externalFrameOrigins,
  portalContentSecurityPolicy,
} from "./lib/content-policy.mjs";
import {
  buildPermissionModel,
  resolvePortalIdentity,
  membershipsForRoles,
} from "./lib/permissions.mjs";
import { handleWebApi } from "./lib/webapi-handler.mjs";
import { buildSiteTables } from "./lib/site-tables.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Bind evidence to the mirage loaded by this process as well as portal sources.
const implementationFingerprint = await sourceFingerprint(ROOT);
const auditResponse = Symbol("auditResponse");
const mime = (file) =>
  ({
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".pdf": "application/pdf",
  })[path.extname(file).toLowerCase()] || "application/octet-stream";
const error = (message, status = 400, code = "INVALID_REQUEST") =>
  Object.assign(new Error(message), { status, code });
const escaped = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const isWrite = (method) => !["GET", "HEAD", "OPTIONS"].includes(method);
function validateEndpoint(value) {
  if (
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    value.path.startsWith("//") ||
    /[\\\u0000-\u001f]/.test(value.path)
  )
    throw error("Endpoint path must be portal-relative.");
  let decoded;
  try {
    decoded = decodeURIComponent(value.path);
  } catch {
    throw error("Endpoint path has invalid encoding.");
  }
  if (
    decoded.startsWith("/__sim") ||
    decoded.includes("\\") ||
    decoded.split("/").includes("..") ||
    value.path.includes("?") ||
    value.path.includes("#")
  )
    throw error("Endpoint path must be a portal pathname outside /__sim.");
  if (!["local", "live"].includes(value.mode ?? "local"))
    throw error("Endpoint mode must be local or live.");
  if (
    typeof value.method !== "string" ||
    !["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "*"].includes(
      value.method.toUpperCase(),
    )
  )
    throw error("Endpoint method must be an HTTP verb or *.");
  if (
    value.status !== undefined &&
    (!Number.isInteger(value.status) ||
      value.status < 200 ||
      value.status > 599)
  )
    throw error("Endpoint status must be an integer from 200 to 599.");
  if (
    value.entity !== undefined &&
    (typeof value.entity !== "string" || !/^\w+$/.test(value.entity))
  )
    throw error("Endpoint entity must be a logical name or entity set.");
}
async function rawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw error("Request body exceeds 8 MiB.", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req, { allowEmpty = true, odataErrorDetails = false } = {}) {
  const bytes = await rawBody(req);
  if (!bytes.length) {
    if (!allowEmpty) throw Object.assign(error("Passed entity object cannot be null or empty."), { details: { innerCode: "0x80072530" } });
    return {};
  }
  try {
    const source = bytes.toString("utf8"), body = parseExactJson(source);
    return odataErrorDetails ? attachODataJsonSource(body, source) : body;
  } catch {
    throw attachODataReaderDetails(error("Request body must be valid JSON."), odataErrorDetails ? odataInvalidJsonDetails(bytes.toString("utf8")) : null);
  }
}
function json(res, status, value, headers = {}) {
  res[auditResponse] = {
    rowCount: Array.isArray(value?.value)
      ? value.value.length
      : Array.isArray(value)
        ? value.length
        : status < 400 && value && typeof value === "object"
          ? 1
          : undefined,
    error: value?.error,
  };
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(status === 204 ? undefined : stringifyExactJson(value));
}

export async function createSimulator({
  sourceDir,
  stateFile,
  persistence,
  personaContexts: personaContextsOption = {},
  identityProvider: identityProviderOption = {},
  personaInstance = null,
  preset,
  presetMode = 'always',
  port = 0,
  host = "127.0.0.1",
  origin,
  watch = true,
  initial,
  liveBridge,
  solutionRoots = [],
  solutionOrder = "derived",
  environmentVariables = {},
  project = null,
  // The toolkit catalogue takes precedence over a generated runtime project.
  setup = null,
  // Explicit external pack modules for embedded runtimes and project-owned tests.
  dataPacks = [],
  packs = [],
  localOverrides: overridesOption,
  compat = {}, head = {}, projectRoot = process.cwd(),
  deploymentProfile,
  deploymentProfiles,
  onShutdown,
  richTextCompatibility: richTextCompatibilityOverride,
  // Per-site observed configuration ({ loginPath, evidence }; lib/project-config.mjs).
  observed: observedOption = null,
  render: renderOption,
  platform: platformOption = initial?.simulator?.platformDefaults ?? null,
  // `serve` refuses a source with zero recognised pages, naming its layout
  // (lib/source-dialect.mjs); embedded uses (tests, tools) may serve page-less fixtures.
  requirePortalSource = false,
  // Whether this runtime may send any write to the live environment (CLI --allow-live-writes).
  // Without it every live create, update and delete is refused, whatever the /_sim switch says.
  allowLiveWrites = false,
  // The site's data model for a YAML source ("standard" or "enhanced"; lib/importer.mjs): a
  // .powerpages-site export does not record it and defaults to enhanced.
  dataModel,
} = {}) {
  personaContextsOption = personaContextSettings(personaContextsOption);
  const providerSettings=identityProviderSettings(identityProviderOption),providerAssets=identityProviderAssets(providerSettings,projectRoot);
  port = runtimePort(port, 0);
  const render = renderSettings(renderOption);
  const localOverrides = overridesOption ?? resolveLocalOverrides({ compat, head }, projectRoot);
  if (!["127.0.0.1", "localhost", "::1"].includes(host))
    throw error("The simulator binds only to loopback.");
  if (dataModel != null && !DATA_MODELS.includes(dataModel)) throw error(`dataModel must be standard or enhanced, not ${JSON.stringify(dataModel)}.`);
  // A code-site project serves the site in its .powerpages-site/ folder (lib/source-dialect.mjs).
  sourceDir = portalSourceDir(sourceDir);
  const profileConfig = resolveDeploymentProfiles(deploymentProfiles, projectRoot, {sourceDir,sourceRoot:projectRoot});
  if (deploymentProfile && Object.keys(profileConfig.profiles).length) throw error('Use deploymentProfiles or the legacy deploymentProfile option, not both.');
  let persistedPin = initial?.simulator?.deploymentProfilePin ?? null;
  if (stateFile) {
    try { const { readStateFile } = await import('./lib/state-storage.mjs'); persistedPin = (await readStateFile(stateFile, { sections: ['simulator'] })).simulator?.deploymentProfilePin ?? null; }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  if (personaInstance?.deploymentProfile !== undefined) persistedPin = personaInstance.deploymentProfile;
  let activeProfiles = await loadDeploymentProfiles(profileConfig, persistedPin);
  // Bootstrap : portal export + ordered solution layers -> mappings, schemas,
  // permission model. Parsed solution files are cached beside the state file and
  // reused only for files whose size/mtime/ctime/inode are unchanged.
  // Options are validated before any source read starts, so a rejected option leaves no
  // read running against the source directory.
  const observed = observedConfig(observedOption);
  const frameReadiness = createFrameReadiness({ diagnostic: entry => recordDiagnostic(entry) });
  const setupHandler = await createSetupHandler({
    directory: projectRoot,
    ...(setup ?? (project?.configFile ? { project: project.configFile } : {})),
    runtime: { product: 'Mirage', sourceDir },
  });
  const startedAt = performance.now();
  const sourceDigest = sourceDirectoryDigest(sourceDir);
  // Awaited below; a bootstrap failure before then must not leave an unhandled rejection.
  sourceDigest.catch(() => {});
  // Portal imports keep duplicate-copy commit lookups beside the state file
  // (cache/portal-sources.json), so a restart does not ask git again for unchanged files.
  const portalCacheFile = stateFile ? path.join(path.dirname(path.resolve(stateFile)), "cache", "portal-sources.json") : null;
  const importSource = async () => {
    const cache = await SolutionFileCache.open(portalCacheFile);
    const imported = applyObserved(await importPortal(sourceDir, {
      deploymentProfile: activeProfiles.pagesFile ? activeProfiles.profile : deploymentProfile,
      deploymentProfileFile: activeProfiles.pagesFile, dataModel, cache,
    }), observed);
    await cache.save();
    bootstrapTimings.portalCache = { ...cache.stats, file: portalCacheFile };
    return imported;
  };
  const bootstrapTimings = {};
  let sourcePortal = await importSource();
  // A source with zero recognised pages is not a portal: `serve` fails loudly, naming its layout.
  if (requirePortalSource) assertPortalSource(sourcePortal);
  let portal = sourcePortal;
  let solutionMetadata = {
      componentSchemas: {},
      diagnostics: [],
      summary: null,
      fingerprint: "",
    },
    solutionData = {
      mappings: {},
      relationships: {},
      diagnostics: [],
      stats: {},
      roots: [],
      layers: [],
      environmentVariables: [],
      fingerprint: "",
    };
  const solutionCacheFile = stateFile
    ? path.join(path.dirname(path.resolve(stateFile)), "cache", "solution-sources.json")
    : null;
  let operationWorkflows = new Map();
  let solutionOperations = { serverLogics: [], cloudFlows: [] };
  let codeComponents = { controls: new Map(), assets: new Map(), diagnostics: [] };
  async function loadSolutions() {
    if (!solutionRoots.length) return;
    const started = performance.now();
    const cache = await SolutionFileCache.open(solutionCacheFile);
    const scan = await scanSolutionSources(solutionRoots, { cache, order: solutionOrder });
    const schema = buildSolutionSchema(scan);
    operationWorkflows = await importOperationWorkflows(scan.layers);
    solutionOperations = await importSolutionOperationSources(scan.layers, portal.website);
    codeComponents = await importCodeComponents(scan.layers);
    [solutionMetadata, solutionData] = await Promise.all([
      importSolutionMetadata(solutionRoots, { portal, scan, schema, observed }),
      importSolutionData(solutionRoots, { scan, schema }),
    ]);
    await cache.save();
    bootstrapTimings.solutionsMs = Math.round(performance.now() - started);
    bootstrapTimings.solutionCache = { ...cache.stats, processHits: cache.processHits, file: solutionCacheFile };
  }
  await loadSolutions();
  // Project data packs (project.dataPacks) join the built-in pack registry.
  const projectPacks = project?.dataPacks?.length || dataPacks.length || packs.length ? await discoverPacks({ project, portal: sourcePortal, explicit: dataPacks, packs }) : undefined;
  // HTTP endpoints of the packs that serve this portal (built-in and project packs).
  const packConfigurations = configurationPresetReport(projectPacks ?? []);
  const packEndpointList = packEndpoints(projectPacks ?? (await discoverPacks({ portal: sourcePortal })));
  const registeredOperations = operationHandlers(projectPacks ?? []);
  const registeredWebApiErrorTemplates = collectWebApiErrorTemplates(projectPacks ?? []);
  const registeredPluginSteps = pluginHandlers(projectPacks ?? []);
  const registeredPluginDescriptors=pluginRuntimeDescriptors(projectPacks??[]),registeredPluginRuntimes=new Map();
  const operationPortal = () => withSolutionOperations(portal, solutionOperations);
  const pluginSteps = () => pluginCatalogue({ plugins: solutionMetadata.plugins, handlers: registeredPluginSteps,runtimes:registeredPluginRuntimes,descriptors:registeredPluginDescriptors, overrides: config().operations });
  const operations = () => [...operationCatalogue({ portal: operationPortal(), workflows: operationWorkflows, handlers: registeredOperations, overrides: config().operations }), ...pluginSteps()];
  const bootstrapOptions = () => ({ origin, metadata: solutionData, ...(projectPacks ? { packs: projectPacks } : {}) });
  let generatedPresets = initialState(portal, bootstrapOptions()).presets;
  const runtimeFingerprint = implementationFingerprint;
  const calculateFingerprint = async (digest) =>
    createHash("sha256")
      .update(runtimeFingerprint)
      .update(await (digest ?? sourceDirectoryDigest(sourceDir)))
      .update(solutionMetadata.fingerprint ?? "")
      .update(solutionData.fingerprint ?? JSON.stringify(solutionData))
      .update(JSON.stringify([...operationWorkflows]))
      .update(JSON.stringify(solutionOperations))
      .update(JSON.stringify([...codeComponents.controls].map(([name, control]) => [name, control.fingerprint])))
      .update(activeProfiles.fingerprint)
      .digest("hex");
  let fingerprint = await calculateFingerprint(sourceDigest);
  let appliedPermissionModel;
  const webApiTables = () =>
    Object.entries(portal.settings ?? {})
      .filter(([name, value]) => /^Webapi\/[^/]+\/enabled$/i.test(name) && String(value).toLowerCase() === "true")
      .map(([name]) => name.split("/")[1].toLowerCase());
  const applySolutions = (state) =>
    applySolutionData(state, solutionData, {
      presetLibrary: generatedPresets,
      webApiTables: webApiTables(),
      // Local values set in _sim (simulator.environmentVariables) win over project-level overrides.
      environmentVariables: Object.fromEntries(Object.entries({ ...activeProfiles.environmentVariables, ...environmentVariables, ...(state.simulator?.environmentVariables ?? {}) }).map(([name, value]) => [name.toLowerCase(), value])),
      connectionReferences: activeProfiles.connectionReferences,
    });
  const compilePermissions = (state) => {
    const model = buildPermissionModel(portal, state, {
      relationships: solutionData.relationships,
    });
    return {
      model,
      state: {
        ...state,
        permissions: model.permissions,
        settings: { ...state.settings, ...model.settings },
      },
    };
  };
  // Every replacement keeps solution-derived mappings, column metadata and seeded rows current.
  const replaceCompiledState = async (state) => {
    const candidate = compilePermissions(applySolutions(state));
    await store.replaceState(candidate.state);
    appliedPermissionModel = candidate.model;
  };
  if (!['always', 'bootstrap'].includes(presetMode)) throw new Error('presetMode must be bootstrap or always');
  const stateExisted = stateFile ? await fs.stat(stateFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }) : false;
  const startupPreset = { name: preset ?? null, mode: presetMode, applied: Boolean(preset && (presetMode === 'always' || !stateExisted)) };
  const store = await new DataStore({
    file: stateFile,
    persistence,
    presetLibrary: generatedPresets,
    platform: platformOption,
    state: applySolutions(initial ?? initialState(portal, bootstrapOptions())),
  }).init();
  if (personaInstance) Object.assign(store.state.simulator, {mode:'local',pageMode:'local',live:{enabled:false}});
  store.setVirtualTables(siteTables); // read-only site tables (see siteTables)
  store.setObserved(observed); // observed anonymousDataAccess for table permissions
  portal = applyPortalOverrides(sourcePortal, store.snapshot({ sections: ["simulator"] }).simulator?.portalOverrides);
  let sourceDependencies = { ...await discoverSourceDependencies(portal), compat: localOverrides.compat };
  await replaceCompiledState(store.snapshot());
  bootstrapTimings.startupMs = Math.round(performance.now() - startedAt);
  // Resolved project configuration (CLI --project) and the bootstrap inputs in use.
  const projectStatus = () =>
    project
      ? structuredClone(project)
      : { configFile: null, portals: [{ id: null, sourceDir: portal.sourceDir }], solutions: solutionRoots.map((root) => ({ id: null, root })), references: [], dataPacks: [] };
  // Loopback confinement of portal pages: an explicit opt-in (config.confinePortalPages)
  // that adds the loopback policy (externalAssets and externalFrameOrigins are its
  // exceptions) as a separate Content-Security-Policy header; off, portal pages carry
  // only the headers derived from HTTP/* site settings, as the platform sends them.
  const confinementPolicy = () => (config().confinePortalPages === true ? portalContentSecurityPolicy(config()) : null);
  const confinementStatus = () => ({ portalPages: config().confinePortalPages === true, policy: confinementPolicy() });
  const bootstrapStatus = () => ({
    // The source layout (lib/source-dialect.mjs): { dialect, label, imported, evidence }.
    sourceLayout: portal.source ?? null,
    // The site's data model and where it came from (export, assumed or configured).
    dataModel: portal.dataModel ?? portal.format ?? null,
    dataModelSource: portal.dataModelSource ?? null,
    signInPath: signInPath(portal),
    observed,
    solutionOrder,
    solutionRoots,
    layers: (solutionData.layers ?? []).map(({ index, solution, dir, type, version }) => ({ index, solution, dir, type, version })),
    environmentVariables: (solutionData.environmentVariables ?? []).length,
    timings: structuredClone(bootstrapTimings),
  });
  const live =
    liveBridge ??
    new LiveBridge(store.snapshot().simulator?.live ?? { origin }, { writesPermitted: allowLiveWrites === true });
  // The runtime flag governs every bridge, an injected one included: without it no write
  // leaves this runtime, whatever the bridge or the /_sim switch would allow.
  live.writesPermitted = allowLiveWrites === true;
  if (!allowLiveWrites) {
    const request = live.request.bind(live);
    live.request = (pathname, options = {}) => {
      if (!["GET", "HEAD"].includes(String(options.method ?? "GET").toUpperCase()))
        return Promise.reject(
          error(
            "Live writes are disabled for this runtime: start the Mirage with --allow-live-writes (mirage dev and start pass it through) to send create, update or delete requests to the live environment.",
            403,
            "LIVE_WRITES_DISABLED",
          ),
        );
      return request(pathname, options);
    };
  }
  const cache = stateFile
    ? await new AssetCache({
        directory: path.join(path.dirname(path.resolve(stateFile)), "assets"),
        origin: live.origin,
      }).init()
    : null;
  const richTextCompatibility = () => {
    const manifest=cache?.manifest();
    const capturedCore=manifest?.assets.some(asset=>asset.origin===live.origin&&/\/ckeditor\.js(?:\?|$)/i.test(asset.path??''));
    // An explicit external native provider remains usable in embedded tests.
    // An incomplete captured editor must never activate merely from its core file.
    if(richTextCompatibilityOverride===false&&!capturedCore)return false;
    return richTextCompatibilityOverride===true||!nativeRichTextReady(manifest,config().shellProfile,live.origin);
  };
  const evidenceDir = stateFile
    ? path.join(path.dirname(path.resolve(stateFile)), "evidence/latest")
    : null;
  let evidence = null;
  const csrf = randomBytes(32).toString("hex");
  const verificationRuntimeId = randomUUID();
  let revision = 1,
    renderer,
    watcher,
    watcherTimer = null,
    watcherReadyRelease = null,
    mutation = Promise.resolve(),
    closing = false,
    closePromise = null,
    // External sign-in and its local identity provider (lib/sign-in-flow.mjs), set below.
    externalSignIn = null,triggerRunner=null,asyncPluginRunner=null;
  // GET observers may commit SDK writes too. Drain every accepted handler
  // before stopping its services; event-stream handlers finish on registration.
  const activeRequests=new Set();
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(watcherTimer);
    watcherTimer = null;
    watcherReadyRelease?.();
    watcherReadyRelease = null;
    frameReadiness.close();
    closePromise = (async () => {
      await personaRuntimes.close();
      await watcher?.close();
      await reloadPromise?.catch(() => {});
      while(activeRequests.size)await Promise.all([...activeRequests]);
      await mutation;
      await store.queue;
      await settleCommittedWork(store,[triggerRunner,asyncPluginRunner],{close:true});
      for(const runtime of registeredPluginRuntimes.values())closeClrHostPool({runtime,diagnostic:recordDiagnostic});
      for (const event of events) event.end();
      await live.close();
      // The local identity provider lives and ends with its runtime.
      await externalSignIn?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    })();
    return closePromise;
  };
  const events = new Set(),
    diagnostics = [],
    requests = [];
  const audit = new AuditLog(),
    trace = new AsyncLocalStorage();
  store.onSave = ({ durationMs, mode }) => {
    const context = trace.getStore();
    if (context) { context.saveMs = (context.saveMs ?? 0) + durationMs; context.saveMode = mode; }
  };
  // Enforce the visitor's local-only contract at the outbound boundary too:
  // configuration may change while an asynchronous render is in progress.
  for (const method of ['request', 'fetchXml']) if (typeof live[method] === 'function') {
    const invoke = live[method].bind(live);
    live[method] = (...args) => {
      if (trace.getStore()?.localOnly)
        return Promise.reject(error('This visitor requires local Mirage execution.', 409, 'LocalRuntimeRequired'));
      return invoke(...args);
    };
  }
  // Admin live log stream: `log` events on /__sim/events?channels=logs. Nothing is
  // serialized while no administrator is subscribed.
  const logClients = new Set();
  let logSequence = 0;
  const publishLog = (type, payload = {}) => {
    if (!logClients.size) return;
    const message = `event: log\ndata: ${JSON.stringify({ sequence: ++logSequence, type, time: new Date().toISOString(), ...payload })}\n\n`;
    for (const client of logClients) client.write(message);
  };
  audit.subscribe((entry) =>
    publishLog(
      entry.kind === "liquid-fetchxml"
        ? "liquid"
        : ["entity-read", "entity-query"].includes(entry.kind)
          ? "data"
          : "request",
      {
        level:
          entry.outcome === "error"
            ? "error"
            : entry.outcome === "denied"
              ? "warning"
              : "info",
        entry,
      },
    ),
  );
  // Declarative backend rules run inside DataStore transactions; observe their evaluation.
  const evaluatePlugins = store.applyPlugins.bind(store);
  store.applyPlugins = (entity, operation, row, previous, identity) => {
    if (!logClients.size)
      return evaluatePlugins(entity, operation, row, previous, identity);
    const plugins = (store.snapshot({ sections: ["plugins"] }).plugins ?? [])
      .filter(
        (plugin) =>
          plugin.enabled !== false &&
          (plugin.entity === entity || plugin.entity === "*") &&
          (plugin.operations ?? ["create", "update"]).includes(operation),
      )
      .map((plugin) => plugin.id ?? plugin.name ?? "plugin");
    const started = Date.now();
    try {
      const effects = evaluatePlugins(entity, operation, row, previous, identity);
      publishLog("plugin", { level: "info", entity, operation, plugins, outcome: "evaluated", secondaryEffects: effects.length, durationMs: Date.now() - started });
      return effects;
    } catch (cause) {
      publishLog("plugin", { level: "error", entity, operation, plugins, outcome: "rejected", error: { code: cause.code ?? "PLUGIN_ERROR", message: cause.message } });
      throw cause;
    }
  };
  const config = () => {
    const simulator = store.snapshot({ sections: ["simulator"] }).simulator ?? {
      mode: "local",
      pageMode: "local",
      identity: { roles: [] },
      live: { origin },
    };
    return { ...simulator, observed: observed ?? simulator.observed ?? portal.observed ?? null };
  };
  // Sign-in sessions (lib/auth-session.mjs): every portal request (pages,
  // Liquid, FetchXML, /_api, forms, native services) takes its identity from the
  // paqvilo-mirage-auth cookie only and is anonymous without one, whoever the client is. The
  // configured identity is the default persona offered on the sign-in page and the
  // identity of /__sim/api administration requests. simulator.identityScope =
  // "configured" (an explicit opt-in for offline tooling; the earlier name
  // "all-requests" is accepted) gives cookie-less portal requests the configured identity.
  // The cookie is named after the listening port (paqvilo-mirage-auth-<port>): browsers share
  // cookies across ports, and every local runtime keeps its own session.
  const authSessions = createAuthSessions({ name: () => authCookieName(localOrigin ? new URL(localOrigin).port : null) });
  // Advanced form sessions of this runtime (lib/form-service.mjs) and the anonymous visitor
  // cookie that keeps an anonymous visitor's sessions to its browser session.
  const webFormSessions = createWebFormSessions();
  const visitorName = () => visitorCookieName(localOrigin ? new URL(localOrigin).port : null);
  const ANONYMOUS_VISITOR = Object.freeze({ id: null, contactId: null, roles: [], roleSource: "memberships" });
  const sessionIdentity = (session) =>
    !session?.contactId
      ? ANONYMOUS_VISITOR
      : session.roles
        ? { id: session.contactId, contactId: session.contactId, roles: session.roles, roleSource: "override" }
        : { id: session.contactId, contactId: session.contactId, roles: [], roleSource: "memberships" };
  const requestAuth = (req, url) => {
    const session = authSessions.read(req.headers.cookie);
    if (url.pathname.startsWith("/__sim/api")) return { session };
    if (session) return { session, identity: sessionIdentity(session) };
    if (["configured", "all-requests"].includes(config().identityScope)) return { session };
    return { session, identity: ANONYMOUS_VISITOR };
  };
  const currentIdentity = () => {
    const state = store.snapshot({
      sections: ["simulator"],
      tables: ["contact"],
      mappings: ["contact"],
    });
    const fromSession = state.simulator?.mode === "live" ? undefined : trace.getStore()?.auth?.identity;
    const configured = fromSession ?? state.simulator?.identity ?? { id: null, roles: [] };
    const resolved =
      state.simulator?.mode === "live"
        ? configured
        : resolvePortalIdentity(portal, state, configured);
    const { admin: ignoredAdmin, ...selected } = resolved;
    const contactId = selected.contactId ?? selected.id;
    if (!contactId || state.simulator?.mode === "live") return selected;
    const idColumn = state.mappings.contact?.idColumn ?? "contactid";
    const normalize = (value) =>
      String(value ?? "")
        .replace(/[{}]/g, "")
        .toLowerCase();
    const contact = state.tables.contact?.find(
      (row) => normalize(row[idColumn]) === normalize(contactId),
    );
    // A membership session whose contact is gone or inactive is an anonymous visitor.
    const inactive = (row) => Number((row?.statecode && typeof row.statecode === "object" ? row.statecode.value : row?.statecode) ?? 0) !== 0;
    if (fromSession?.roleSource === "memberships" && (!contact || inactive(contact)))
      return resolvePortalIdentity(portal, state, ANONYMOUS_VISITOR);
    if (!contact) return selected;
    const account = contact.parentcustomerid ?? contact._parentcustomerid_value;
    return {
      ...contact,
      name: contact.fullname,
      accountId: typeof account === "object" ? account?.id : account,
      ...selected,
      admin: undefined,
      id: contactId,
      contactId,
      roles: selected.roles ?? [],
    };
  };
  const recordDiagnostic = (d) => {
    diagnostics.push({ ...d, time: new Date().toISOString() });
    if (diagnostics.length > 300) diagnostics.shift();
    publishLog("diagnostic", { level: /error|fail/i.test(`${d.severity ?? ""} ${d.code ?? ""}`) ? "error" : "warning", diagnostic: diagnostics.at(-1) });
  };
  store.setPluginPipeline(context => runPluginPhase({ ...context,store,runtimes:registeredPluginRuntimes, items: pluginSteps(), handlers: registeredPluginSteps, diagnostic: recordDiagnostic }), ({ entity, operation }) => pluginSteps().some(step => step.enabled && pluginStepMatchesEntity(step, entity) && String(step.message).toLowerCase() === operation && (!['retrieve','retrievemultiple'].includes(operation)||!['placeholder','disabled'].includes(step.mode))));
  for(const item of pluginSteps().filter(item=>item.mode==='clr'))try{if(!item.clrAvailable)throw new Error('No exact trusted descriptor');registeredPluginRuntimes.set(item.id,await prepareClrRuntime(registeredPluginDescriptors.get(item.id)));}catch(error){recordDiagnostic({code:'PLUGIN_CLR_PREPARATION_FAILED',stepId:item.id,message:error.message});}
  const acceptedChains=new Set();
  triggerRunner=createFlowTriggerRunner({store,items:operations,workflows:()=>operationWorkflows,identities:()=>registeredOperations.flowIdentities,diagnostic:recordDiagnostic,acceptedChains});
  asyncPluginRunner=createAsyncPluginRunner({store,items:pluginSteps,handlers:registeredPluginSteps,runtimes:registeredPluginRuntimes,diagnostic:recordDiagnostic,acceptedChains});
  const liveMapping = (entity) => {
    const mapping = store.resolveMapping(entity);
    return {
      ...mapping,
      fields:
        solutionMetadata.entities?.[mapping.logicalName]?.fields ??
        mapping.fields ??
        mapping.fieldMetadata,
    };
  };
  const liveJson = async (pathname) => {
    const response = await live.request(pathname, {
      prefer: 'odata.include-annotations="*"',
    });
    if (response.status >= 400)
      throw error(
        `Live data read returned HTTP ${response.status}.`,
        response.status,
        "LIVE_BRIDGE",
      );
    try {
      return JSON.parse(response.body);
    } catch {
      throw error("Live data read did not return JSON.", 502, "LIVE_BRIDGE");
    }
  };
  const auditRead = async (kind, entity, query, identity, fn) => {
    const context = trace.getStore(),
      provider = config().mode;
    const span = audit.begin({
      kind,
      entity,
      query,
      identity,
      provider,
      method: context?.method,
      path: context?.path,
      correlationId: context?.correlationId,
      parentId: context?.spanId,
    });
    try {
      const result = await fn();
      span.finish({
        rowCount: Array.isArray(result?.entities)
          ? result.entities.length
          : Array.isArray(result?.value)
            ? result.value.length
            : result
              ? 1
              : 0,
      });
      return result;
    } catch (cause) {
      span.finish({
        status: cause.status ?? cause.statusCode ?? 500,
        error: cause,
      });
      throw cause;
    }
  };
  const rawReadProvider = {
    async fetchXml(xml, identity, fetchOptions = {}) {
      if (config().mode !== "live")
        return normalizeMockLiquidFetchXml(
          await store.readOperation(() => store.fetchXml(xml, identity, { platformLanguageCode: "en-US", portalRequest: true, right: fetchOptions.right, fetchCache: fetchOptions.fetchCache, diagnostic: fetchOptions.diagnostic })),
          xml,
          liveMapping,
        );
      const entity = parseFetchXml(xml).children.find(
        (n) => n.name === "entity",
      )?.attrs.name;
      if (!entity) throw error("FetchXML requires a root entity.");
      return live.fetchXml(xml, liveMapping(entity));
    },
    async get(entity, id, identity) {
      if (config().mode !== "live")
        return normalizeMockLiquidRecord(
          await store.readOperation(() => store.get(entity, id, identity, { portalRequest: true })),
          liveMapping(entity),
          { mappings: liveMapping },
        );
      const mapping = liveMapping(entity);
      return normalizeLiveRecord(
        await liveJson(`/_api/${mapping.entitySet}(${encodeURIComponent(id)})`),
        mapping,
      );
    },
    async query(entity, params, identity) {
      if (config().mode !== "live") {
        const result = await store.readOperation(() => store.query(entity, params, identity, undefined, { portalRequest: true }));
        const aggregate = Boolean(
          params instanceof URLSearchParams
            ? params.get("$apply")
            : params?.$apply,
        );
        return {
          ...result,
          value: normalizeMockLiquidRecord(result.value, liveMapping(entity), {
            aggregate,
            mappings: liveMapping,
          }),
        };
      }
      const mapping = liveMapping(entity);
      const query = new URLSearchParams(params ?? {});
      const result = await liveJson(
        `/_api/${mapping.entitySet}${query.size ? "?" + query : ""}`,
      );
      if (!Array.isArray(result.value))
        throw error(
          "Live data query did not return a value array.",
          502,
          "LIVE_BRIDGE",
        );
      return {
        ...result,
        value: result.value.map((row) => normalizeLiveRecord(row, mapping)),
      };
    },
  };
  const readProvider = {
    fetchXml: (xml, identity, fetchOptions) =>
      auditRead(
        "liquid-fetchxml",
        /<entity\b[^>]*\bname\s*=\s*["']([^"']+)/i.exec(xml)?.[1],
        xml,
        identity,
        () => rawReadProvider.fetchXml(xml, identity, fetchOptions),
      ),
    get: (entity, id, identity) =>
      auditRead("entity-read", entity, { id }, identity, () =>
        rawReadProvider.get(entity, id, identity),
      ),
    query: (entity, params, identity) =>
      auditRead("entity-query", entity, params, identity, () =>
        rawReadProvider.query(entity, params, identity),
      ),
  };
  const writeFormRecord = async (entity, id, values, identity) => {
    if (config().mode !== "live")
      return id
        ? store.update(entity, id, values, identity, { portalRequest: true })
        : store.create(entity, values, identity, { portalRequest: true });
    const mapping = liveMapping(entity);
    const response = await live.request(
      `/_api/${mapping.entitySet}${id ? `(${encodeURIComponent(id)})` : ""}`,
      {
        method: id ? "PATCH" : "POST",
        body: Buffer.from(JSON.stringify(values)),
        contentType: "application/json",
        prefer: "return=representation",
      },
    );
    if (response.status >= 400)
      throw error(
        `Live form data write returned HTTP ${response.status}.`,
        response.status,
        "LIVE_BRIDGE",
      );
    if (response.body?.length) {
      try {
        return normalizeLiveRecord(JSON.parse(response.body), mapping);
      } catch {
        throw error(
          "Live form data write did not return JSON.",
          502,
          "LIVE_BRIDGE",
        );
      }
    }
    const recordId =
      id ??
      response.headers.entityid ??
      /\(([^)]+)\)$/.exec(response.headers["odata-entityid"] ?? "")?.[1];
    if (!recordId)
      throw error(
        "Live form write succeeded without returning a record identifier.",
        502,
        "LIVE_BRIDGE",
      );
    return { [mapping.idColumn]: recordId };
  };
  const executeServerLogic = async ({ name, method = 'GET', operation, body = '', input = '', query = {} }) => {
    const record = operationPortal().serverLogics.find(record => record.name.toLowerCase() === String(name).toLowerCase());
    const handler = registeredOperations.serverLogics.get(record?.name.toLowerCase());
    if (!record || config().mode === 'live') return null;
    const identity = currentIdentity();
    assertOperationRole(record, identity);
    const item = operations().find(item => item.kind === 'server-logic' && item.id === record.id);
    if (item.mode === 'placeholder') operationPlaceholder(item);
    if(item.mode==='disabled')throw error('This backend operation is explicitly disabled locally.',503);
    if (item.mode === 'mock') {
      if ((item.configuration.status ?? 200) >= 400) throw error('Configured local operation failure.', item.configuration.status, 'LocalOperationMockFailure');
      return JSON.stringify(Object.hasOwn(item.configuration, 'body') ? item.configuration.body : {});
    }
    const context = { record, portal, store, identity, method, operation, body, input, query };
    if (item.mode === 'exported') return runExportedServerLogic(context);
    if (!handler) operationPlaceholder(item);
    const answer = await handler({ ...context, runExportedServerLogic: () => runExportedServerLogic(context) });
    return typeof answer === 'string' ? answer : JSON.stringify(answer ?? null);
  };
  const formSubmissionOptions = (formIdentity, visitor, pageTarget) => {
    const formLanguage = renderer.requestLanguage(pageTarget);
    const associateFormRecord = async (entity, id, navigation, targetId, identity) => {
      const mapping = liveMapping(entity),
        target = liveMapping(mapping.relationships?.[navigation]?.entity);
      const response = await live.request(
        `/_api/${mapping.entitySet}(${encodeURIComponent(id)})/${navigation}/$ref`,
        {
          method: "POST",
          body: Buffer.from(JSON.stringify({ "@odata.id": `${live.origin}/_api/${target.entitySet}(${targetId})` })),
          contentType: "application/json",
        },
      );
      if (response.status >= 400)
        throw error(`Live form association returned HTTP ${response.status}.`, response.status, "LIVE_BRIDGE");
    };
    return {
      portal,
      store,
      identity: formIdentity,
      schemas: {
        ...solutionMetadata.componentSchemas,
        ...config().componentSchemas,
      },
      metadata: solutionMetadata,
      readProvider,
      writeProvider: {
        create: (entity, values, identity) =>
          writeFormRecord(entity, null, values, identity),
        update: writeFormRecord,
        associate: async (entity, id, navigation, targetId, identity) =>
          config().mode !== "live"
            ? store.associate(entity, id, navigation, targetId, identity)
            : associateFormRecord(entity, id, navigation, targetId, identity),
        // A submission's record, associations and notes form one unit. Locally the
        // store transaction restores everything on failure; the live bridge has no
        // transaction, so the records the unit created are deleted again.
        transaction: async (work) => {
          if (config().mode !== "live")
            return store.transact(() =>
              work({
                create: (entity, values, identity) => store.createRecord(entity, values, identity),
                update: (entity, id, values, identity) => store.updateRecord(entity, id, values, identity),
                associate: (entity, id, navigation, targetId, identity) =>
                  store.changeAssociationRecord(entity, id, navigation, targetId, identity, true),
              }),
            );
          const created = [];
          try {
            return await work({
              create: async (entity, values, identity) => {
                const row = await writeFormRecord(entity, null, values, identity);
                const id = row?.[liveMapping(entity).idColumn];
                if (id) created.push({ entity, id });
                return row;
              },
              update: writeFormRecord,
              associate: associateFormRecord,
            });
          } catch (cause) {
            for (const row of created.reverse()) {
              const response = await live
                .request(`/_api/${liveMapping(row.entity).entitySet}(${encodeURIComponent(row.id)})`, { method: "DELETE" })
                .catch(() => ({ status: 0 }));
              if (!(response.status >= 200 && response.status < 300))
                recordDiagnostic({
                  code: "FORM_UNIT_COMPENSATION_FAILED",
                  severity: "error",
                  message: `A live form submission failed after creating ${row.entity} ${row.id}; deleting it again returned HTTP ${response.status}.`,
                });
            }
            throw cause;
          }
        },
      },
      requestUrl: pageTarget.href,
      sessions: webFormSessions,
      owner: webFormSessionOwner(formIdentity, visitor),
      language: {
        lcid: formLanguage.selected?.lcid ?? null,
        defaultLcid: formLanguage.languages.find((entry) => entry.isDefault)?.lcid ?? null,
      },
    };
  };
  const buildRenderer = (source = portal) =>
    createPortalRenderer(source, {
      render,
      observed: config().observed ?? source.observed,
      serverLogic: async ({ name, operation, input }) => {
        try {
          const raw = await executeServerLogic({ name, operation, input });
          if (raw === null) return null;
          let data; try { data = JSON.parse(raw); } catch { data = raw; }
          return { success: true, status_code: 200, data, raw_result: raw };
        } catch (cause) {
          recordDiagnostic({ code: cause.code ?? 'SERVER_LOGIC_FAILED', name, message: cause.message });
          return { success: false, status_code: cause.status ?? 500, data: null, raw_result: '' };
        }
      },
      observationOrigin: live.origin,
      sourceDependencies,
      fetchXml: async (xml, _user, _request, fetchOptions) => {
        const empty = config().mode === "live" ? null : emptyUnmappedLiquidFetchXml(xml, {
          observed: config().observed ?? source.observed,
          resolveMapping: name => store.resolveMapping(name),
        });
        return empty ?? readProvider.fetchXml(xml, currentIdentity(), { ...fetchOptions, diagnostic: entry => recordDiagnostic({...entry,path:_request?.path}) });
      },
      previewFetchXml:(xml,_user,_request,fetchOptions)=>{
        if(config().mode==='live')throw error('A local permission preview cannot qualify remote Liquid execution.',501,'LocalFetchPreviewUnsupported');
        return store.previewPermissionFetchXml(xml,currentIdentity(),fetchOptions);
      },
      entity: async (entity, id) => observedLiquidEntityRead(
        () => readProvider.get(entity, id, currentIdentity()), config().observed ?? source.observed),
      renderComponent: async (kind, args, context) =>
        kind === 'codecomponent' ? renderCodeComponent({ name: args?.name ?? args?.id, args, portal, catalog: codeComponents, metadata: solutionMetadata, language: context?.__language ?? portal.language, identity: currentIdentity(), mappings: store.snapshot({ sections: ['mappings'] }).mappings, diagnostic: entry => recordDiagnostic({ ...entry, path: context?.request?.path }) }) : renderComponent(
          kind,
          typeof args === "string"
            ? args
            : (args?.name ?? args?.id ?? args?.key ?? ""),
          context,
          {
            portal,
            store,
            readProvider,
            args: typeof args === "string" ? { name: args } : (args ?? {}),
            metadata: solutionMetadata,
            codeComponent: spec => renderCodeComponent({ ...spec, portal, catalog: codeComponents, metadata: solutionMetadata, language: context?.__language ?? portal.language, identity: currentIdentity(), mappings: store.snapshot({ sections: ['mappings'] }).mappings, diagnostic: entry => recordDiagnostic({ ...entry, path: context?.request?.path }) }),
            config: config(),
            observed: config().observed ?? portal.observed,
            managedControls:
              config().managedControls ??
              config().shellProfile?.managedControls,
            sourceDependencies,
            richTextCompatibility: richTextCompatibility(),
            schemas: {
              ...solutionMetadata.componentSchemas,
              ...config().componentSchemas,
            },
            renderLiquid: (source, ctx) => renderer.renderString(source, ctx),
            webFormSessions,
            webFormOwner: () => webFormSessionOwner(currentIdentity(), trace.getStore()?.visitor),
            onNativePostbackDescriptor: nativeFormTransport(config().observed ?? portal.observed) === 'postback'
              ? item => trace.getStore()?.nativePostbacks?.push(item) : undefined,
            nativePostbackState: trace.getStore()?.nativePostbackState,
            // Component diagnostics name the page that rendered the component.
            diagnostic: (entry) => recordDiagnostic({ ...entry, path: entry.path ?? context?.request?.path }),
          },
        ),
      user: currentIdentity(),
      shellProfile: config().shellProfile,
    });
  renderer = buildRenderer();
  let localOrigin;
  const exposedState = ({ summary = false } = {}) => {
    const state = summary ? store.summary() : store.snapshot();
    const cfg = config();
    const identityModel = buildPermissionModel(portal, state, {
      relationships: solutionData.relationships,
    });
    const permissionModel = appliedPermissionModel;
    const effectiveIdentity = currentIdentity(),
      visibleCounts = {};
    for (const entity of Object.keys(
      summary ? state.tableCounts : (state.tables ?? {}),
    )) {
      try {
        visibleCounts[entity] = store.rows(entity, effectiveIdentity).length;
      } catch (err) {
        visibleCounts[entity] = `Unavailable: ${err.code ?? err.message}`;
      }
    }
    return {
      csrf,
      config: {
        ...cfg,
        confinePortalPages: cfg.confinePortalPages === true,
        permissionMode: state.settings.permissionMode,
        mappings: Object.entries(state.mappings ?? {}).map(
          ([logicalName, m]) => ({ id: logicalName, logicalName, ...m }),
        ),
        plugins: state.plugins ?? [],
        permissions: state.permissions ?? [],
        presets: Object.entries(state.presets ?? {}).map(([id, p]) => ({
          id,
          ...p,
        })),
        endpoints: cfg.endpoints ?? [],
        operations: operations(),
        portalSettings: portalOverrideEntries(sourcePortal, cfg.portalOverrides, "settings"),
        portalSnippets: portalOverrideEntries(sourcePortal, cfg.portalOverrides, "snippets"),
        portalRoles: portalOverrideEntries(sourcePortal, cfg.portalOverrides, "roles"),
        platformSettings: platformSettingEntries(state),
        experimentPresets: experimentPresets(state, sourcePortal, packConfigurations.presets),
      },
      ...(!summary ? { data: state.tables } : {}),
      status: {
        richTextConfigurations: richTextConfigurationStatus(
          portal,
          cfg.shellProfile?.richTextConfigurations,
          live.origin,
        ),
        tableCounts: summary
          ? state.tableCounts
          : Object.fromEntries(
              Object.entries(state.tables ?? {}).map(([name, rows]) => [
                name,
                rows.length,
              ]),
            ),
        effectiveIdentity,
        permissionModel: {
          applied: true,
          visibleCounts,
          source: permissionModel.source,
          tree: permissionModel.tree,
          webRoles: identityModel.webRoles,
          memberships: identityModel.memberships,
          personas: identityModel.personas,
          diagnostics: [
            ...permissionModel.diagnostics.filter(
              (d) => !d.code.startsWith("PERSONA_"),
            ),
            ...identityModel.diagnostics.filter((d) =>
              d.code.startsWith("PERSONA_"),
            ),
          ],
        },
        sourceDir: portal.sourceDir,
        sourceFingerprint: fingerprint,
        project: projectStatus(), bootstrap: bootstrapStatus(), confinement: confinementStatus(),
        platformStyles: platformStylesStatus(config().shellProfile), localOverrides,
        startupPreset,
        activeConfigurationPreset: config().activeExperiment ?? null,
        profileSelection: deploymentProfilesSummary(profileConfig, activeProfiles),
        ...implementationEvidence(implementationFingerprint, implementationFingerprint),
        format: portal.format,
        site: portal.website.name ?? portal.website.adx_name,
        pages: portal.pages.map((p) => ({
          id: p.id,
          name: p.name,
          url: p.url,
          path: p.url,
          access: pageAccess(portal, p, effectiveIdentity),
        })),
        pageCount: portal.pages.length,
        webRoles: portal.records
          .filter((record) => record.kind === "webrole")
          .map((record) => ({ id: record.id, name: record.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        // Body-free registry listing: lazy pack presets are not generated here.
        availablePresets: listPresets({ state, library: generatedPresets }),
        assetCount: portal.webFiles.length,
        templateCount: new Set(Object.values(portal.templates)).size,
        revision,
        live: live.status(),
        liveWrites: live.status().liveWrites,
        localOrigin,
        parity: {
          verified: false,
          message:
            "Exact parity requires a passing comparison for this route, identity, data and viewport.",
        },
      },
      diagnostics: [
        ...portal.diagnostics,
        ...packConfigurations.diagnostics,
        ...(activeProfiles.diagnostics ?? []),
        ...(cfg.importDiagnostics ?? []),
        ...permissionModel.diagnostics,
        ...diagnostics,
      ],
      requests: [...requests],
    };
  };
  const change = (fn) => {
    const next = mutation.then(fn);
    mutation = next.catch(() => {});
    return next;
  };
  const saveState = async (state) => {
    const previous = { portal, sourcePortal, activeProfiles, sourceDependencies, fingerprint, solutionMetadata, solutionData, operationWorkflows, solutionOperations, codeComponents, generatedPresets };
    const pinChanged = JSON.stringify(state.simulator?.deploymentProfilePin ?? null) !== JSON.stringify(config().deploymentProfilePin ?? null);
    try {
      if (pinChanged) {
        activeProfiles = await loadDeploymentProfiles(profileConfig, state.simulator?.deploymentProfilePin ?? null);
        sourcePortal = await importSource();
        if (requirePortalSource) assertPortalSource(sourcePortal);
      }
      portal = applyPortalOverrides(sourcePortal, state.simulator?.portalOverrides);
      if (pinChanged) {
        sourceDependencies = { ...await discoverSourceDependencies(portal), compat: localOverrides.compat };
        await loadSolutions();
        generatedPresets = initialState(portal, bootstrapOptions()).presets;
        store.presetLibrary = generatedPresets;
        fingerprint = await calculateFingerprint();
      }
      await replaceCompiledState(state);
    } catch (cause) {
      ({ portal, sourcePortal, activeProfiles, sourceDependencies, fingerprint, solutionMetadata, solutionData, operationWorkflows, solutionOperations, codeComponents, generatedPresets } = previous);
      store.presetLibrary = generatedPresets;
      throw cause;
    }
    live.configure(config().live ?? {});
    if (cache) cache.origin = live.origin;
    renderer = buildRenderer();
    revision++;
    for (const event of events)
      event.write(`event: reload\ndata: ${revision}\n\n`);
  };
  const applySelectedPreset = async (name, adjust, { applyConfiguration = false } = {}) => {
    const state = store.snapshot(),
      preset = resolvePreset(state, name, generatedPresets);
    if (!preset) throw error("Preset not found.", 404);
    state.simulator ??= config();
    for (const key of [
      "mappings",
      "tables",
      "permissions",
      "plugins",
      "settings",
    ])
      if (preset[key] !== undefined) state[key] = structuredClone(preset[key]);
    if (preset.personaCatalog !== undefined) state.personaCatalog = validatePersonaCatalog(preset.personaCatalog, 'Preset ' + name);
    if (preset.identity)
      state.simulator.identity = structuredClone(preset.identity);
    if (preset.endpoints)
      state.simulator.endpoints = structuredClone(preset.endpoints);
    if (preset.contactRoles)
      state.simulator.contactRoles = structuredClone(preset.contactRoles);
    if (preset.personaRoles) {
      state.simulator.contactRoles = membershipsForRoles(
        portal,
        preset.personaRoles,
      );
      state.simulator.identity = {
        ...state.simulator.identity,
        roleSource: "memberships",
      };
    }
    if (preset.permissionSource)
      state.simulator.permissionSource = preset.permissionSource;
    // Scenarios adjust persona/permissions in the same state replacement as their preset.
    if (adjust) await adjust(state);
    if (applyConfiguration && preset.configurationPreset) {
      const configuration = experimentPresets(state, sourcePortal, packConfigurations.presets).find(entry=>entry.id===preset.configurationPreset);
      if (!configuration) throw error("Configuration preset not found: "+preset.configurationPreset,404);
      state.simulator = applyExperiment({simulator:state.simulator},configuration).simulator;
    }
    await saveState(state);
    return exposedState();
  };
  const validateConfig = (cfg) => {
    profileSelection(profileConfig, cfg.deploymentProfilePin ?? null);
    validatePlatformOverrides(cfg.platformOverrides);
    validateExperimentPresets(cfg.experimentPresets,packConfigurations.presets.map(p=>p.id));
    validateOperationOverrides(cfg.operations);
    validatePortalOverrides(cfg.portalOverrides);
    externalFrameOrigins(cfg.externalFrameOrigins);
    if (cfg.confinePortalPages !== undefined && typeof cfg.confinePortalPages !== "boolean")
      throw error("confinePortalPages must be true or false.");
    if (
      !["local", "live"].includes(cfg.mode) ||
      !["local", "live"].includes(cfg.pageMode)
    )
      throw error("mode and pageMode must be local or live.");
    if (!cfg.identity || !Array.isArray(cfg.identity.roles))
      throw error("identity.roles must be an array.");
    if (cfg.identity.admin !== undefined)
      throw error(
        "identity.admin is reserved for internal simulator storage operations.",
        400,
        "IDENTITY_CAPABILITY_RESERVED",
      );
    if (cfg.identity.roles.some((role) => typeof role !== "string"))
      throw error("identity.roles must contain role-name strings.");
    if (
      cfg.identity.roleSource &&
      !["memberships", "override"].includes(cfg.identity.roleSource)
    )
      throw error("identity.roleSource must be memberships or override.");
    if (
      cfg.permissionSource &&
      !["configured", "exported", "combined"].includes(cfg.permissionSource)
    )
      throw error("permissionSource must be configured, exported or combined.");
    if (
      cfg.contactRoles &&
      (!Array.isArray(cfg.contactRoles) ||
        cfg.contactRoles.some(
          (assignment) =>
            !assignment ||
            typeof assignment.contactId !== "string" ||
            typeof assignment.roleId !== "string",
        ))
    )
      throw error(
        "contactRoles must contain contactId and roleId assignments.",
      );
    new LiveBridge(cfg.live ?? {});
    if (!Array.isArray(cfg.endpoints))
      throw error("endpoints must be an array.");
  };
  // ---- Admin workspace helpers: personas, permission explanations, page inspection,
  // lightweight status, scenarios and environment configuration.
  const personaKey = (value) =>
    String(value ?? "")
      .replace(/[{}]/g, "")
      .toLowerCase();
  const identitySummary = (identity = currentIdentity()) => ({
    id: identity.id ?? null,
    contactId: identity.contactId ?? null,
    name: identity.name ?? null,
    accountId: identity.accountId ?? null,
    roles: identity.roles ?? [],
    roleIds: identity.roleIds ?? [],
    roleSource: identity.roleSource ?? "override",
  });
  let personaCache;
  const personaReport = () => {
    const key = revision + ':' + store.dataRevision();
    if (personaCache?.key === key && personaCache.portal === portal) return personaCache.value;
    const state = store.snapshot({ sections: ['simulator', 'settings', 'personaCatalog'], tables: ['contact', 'account'], mappings: ['contact', 'account'] });
    const model = buildPermissionModel(portal, state, { relationships: solutionData.relationships });
    const accountMapping = state.mappings?.account ?? {};
    const accounts = new Map((state.tables?.account ?? []).map(row => [personaContactId(row[accountMapping.idColumn ?? 'accountid']), row[accountMapping.nameColumn ?? 'name']]));
    const contactMapping = state.mappings?.contact ?? {};
    const rows = new Map((state.tables?.contact ?? []).map(row => [personaContactId(row[contactMapping.idColumn ?? 'contactid']), row]));
    const contacts = model.personas.map(contact => ({ ...contact, accountName: accounts.get(personaContactId(contact.accountId)) ?? null, email: rows.get(personaContactId(contact.contactId))?.emailaddress1 ?? '' }));
    const catalogs = (projectPacks ?? []).filter(pack => pack.personaCatalog).map(pack => ({ source: 'pack:' + pack.id, catalog: pack.personaCatalog }));
    if (state.personaCatalog) catalogs.push({ source: 'state', state: true, catalog: state.personaCatalog });
    const catalog = resolvePersonaCatalog({ contacts, catalogs, defaultContactId: state.simulator?.identity?.contactId ?? state.simulator?.identity?.id });
    let effective;
    for (const entry of [...catalogs].reverse()) effective = mergePersonaCatalogs(effective, entry.catalog);
    const value = { ...catalog, scope: createHash('sha256').update(sourceDir).digest('hex').slice(0, 20),
      identity: identitySummary(), roleSource: state.simulator?.identity?.roleSource ?? 'override',
      permissionMode: state.settings?.permissionMode ?? 'enforce', permissionSource: state.simulator?.permissionSource ?? 'configured',
      contactMapped: Boolean(state.mappings?.contact), personas: catalog.enabled ? catalog.personas : model.personas,
      webRoles: model.webRoles, memberships: model.memberships, contacts, catalog: effective ?? {version:1,groups:[],personas:[]},
      stateCatalog: state.personaCatalog ?? null,
      catalogDigest: createHash('sha256').update(JSON.stringify(state.personaCatalog ?? null)).digest('hex'),
      presets: listPresets({state:store.snapshot({sections:['presets','mappings']}),library:generatedPresets}).map(entry=>({id:entry.id,name:entry.name,unavailable:entry.unavailable})),
      deploymentProfiles: Object.keys(profileConfig.profiles), contextRuntime: personaInstance ? {id:personaInstance.id ?? null,label: personaInstance.label, ownerOrigin:personaInstance.ownerOrigin, isolated:true} : null };
    personaCache = {key, portal, value}; return value;
  };
  const personasPayload = () => ({ ...personaReport(), session: describeSession(trace.getStore()?.auth?.session), runtimes: personaRuntimes.list() });
  const findPersona = key => {
    const report = personaReport(), persona = report.personas.find(entry => entry.key === key);
    if (!report.enabled || !persona) throw error('Unknown persona "' + key + '". Closest keys: ' + closestPersonaKeys(key, report.personas).join(', '), 404, 'PersonaNotFound');
    return persona;
  };
  const personaRuntimes = createPersonaContexts({ directory:path.join(projectRoot,'.paqvilo','persona-runtimes'), maxInstances: personaInstance ? 0 : (personaContextsOption.maxInstances ?? 4),
    snapshot: file => store.readOperation(async () => {
      if (store.file) { await store.storage.assertUnchanged(); await fs.copyFile(store.file, file); await store.storage.assertUnchanged(); }
      else await new StateStorage(file).prepareCheckpoint(file, store.state);
      if (stateFile) for (const name of ['cache']) {
        const from = path.join(path.dirname(path.resolve(stateFile)), name);
        if (await fs.stat(from).then(() => true, e => {if(e.code === 'ENOENT')return false;throw e;})) await fs.cp(from, path.join(path.dirname(file), name), {recursive:true});
      }
    }),
    start: ({file, definition}) => createSimulator({ sourceDir, stateFile:file, port:0, host, watch, project, dataPacks, packs,
      solutionRoots, solutionOrder, deploymentProfiles, deploymentProfile, projectRoot, localOverrides,
      identityProvider: identityProviderOption,
      environmentVariables, observed: observedOption, render: renderOption, platform: platformOption, dataModel,
      personaInstance: {...definition,ownerOrigin:localOrigin}, preset:definition.preset, presetMode:'always' }),
  });
  const launchPersona = async body => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key=>!['personaKey','scenario','instanceKey','returnUrl'].includes(key)) || Boolean(body.personaKey) === Boolean(body.scenario)) throw error('Choose exactly one personaKey or scenario.',400,'PersonaLaunchInvalid');
    if (body.instanceKey !== undefined && (typeof body.instanceKey !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(body.instanceKey))) throw error('instanceKey must be 1-80 letters, digits, dots, underscores or hyphens.',400,'PersonaLaunchInvalid');
    const report = personaReport();
    const scenario = body.scenario ? report.scenarios.find(entry => entry.id === body.scenario) : null;
    if (body.scenario && !scenario) throw error('Unknown persona scenario',404,'PersonaScenarioNotFound');
    const persona = findPersona(scenario?.persona ?? body.personaKey);
    const contextId = scenario?.context ?? persona.context;
    const definition = contextId ? report.contexts.find(entry => entry.id === contextId) : null;
    const preset = scenario?.preset ?? definition?.preset;
    if (preset && !resolvePreset(store.snapshot({sections:['presets','mappings']}),preset,generatedPresets)) throw error('Preset not found: '+preset,404,'PersonaPresetNotFound');
    if (definition?.deploymentProfile) { try { profileSelection(profileConfig,definition.deploymentProfile); } catch(cause) { throw error(cause.message,400,'PersonaContextProfile'); } }
    const targetPath = personaStartPath(body.returnUrl ?? scenario?.startPath ?? persona.startPath ?? definition?.startPath ?? '/', body.returnUrl === undefined ? 'Persona startPath' : 'returnUrl');
    if (personaInstance && (definition && (definition.id !== personaInstance.id || ['deploymentProfile','environmentVariables','portalOverrides'].some(key=>JSON.stringify(definition[key])!==JSON.stringify(personaInstance[key]))) || preset && preset !== personaInstance.preset)) throw error('Open this setup from the parent runtime: '+personaInstance.ownerOrigin,409,'PersonaContextOwnerRequired');
    if ((definition || preset) && !personaInstance) {
      const opened = await personaRuntimes.open(definition ?? {label:scenario?.label ?? persona.label}, {scenario:scenario?.id, instanceKey:body.instanceKey, preset});
      try {
        const signed = opened.runtime.signIn(persona.contactId);
        const {runtime, ...description} = opened;
        return {...description, personaKey:persona.key, contactId:persona.contactId, path:targetPath, url:opened.origin + targetPath, cookieHeader:signed.cookieHeader, identity:signed.identity};
      } catch(cause) { if(opened.created)await personaRuntimes.stop(opened.id);throw cause; }
    }
    const session = signInSession(persona.contactId);
    return {origin:localOrigin, url:localOrigin + targetPath, path:targetPath, personaKey:persona.key, contactId:persona.contactId,
      isolated:Boolean(personaInstance), browser:definition?.browser ?? {}, cookieHeader:authSessions.name+'='+authSessions.value(session), identity:describeSession(session)};
  };
  const PERMISSION_OPERATIONS = ["read", "create", "update", "delete", "append", "appendTo"];
  /** Why the current persona may or may not use a table, from the applied grant ledger. */
  const tablePermissionSummary = (entity, identity, permissionMode) => {
    const applied = (appliedPermissionModel?.permissions ?? []).filter(
      (rule) => rule.entity === entity || rule.entity === "*",
    );
    const disabled = applied
      .filter((rule) => rule.enabled === false)
      .map((rule) => ({ id: rule.id, name: rule.name ?? rule.id, reason: rule.disabledReason ?? "Disabled" }));
    const operations = {};
    for (const operation of PERMISSION_OPERATIONS) {
      if (permissionMode === "permissive") {
        operations[operation] = { allowed: true, scoped: false, grants: [], reason: "Permission enforcement is permissive: every local identity may use this table." };
        continue;
      }
      let rules = [];
      try {
        rules = store.rules(entity, operation, identity);
      } catch {
        rules = [];
      }
      const grants = rules.map((rule) => ({
        id: rule.id,
        name: rule.name ?? rule.id,
        scope: rule.scope ?? "global",
        provenance: rule.provenance?.type ?? (rule.imported ? "portal-export" : "local-configuration"),
        inheritedRoles: Boolean(rule.inheritedRoles),
      }));
      const global = grants.filter((grant) => grant.scope === "global");
      const roles = (identity.roles ?? []).join(", ") || "no web roles";
      operations[operation] = {
        allowed: grants.length > 0,
        scoped: grants.length > 0 && !global.length,
        grants,
        reason: global.length
          ? `Granted for all records by ${global.map((grant) => grant.name).join(", ")}.`
          : grants.length
            ? `Granted only for related records: ${grants.map((grant) => `${grant.name} (${grant.scope} scope)`).join(", ")}.`
            : applied.some((rule) => rule.enabled !== false)
              ? `No enabled ${operation} grant on this table includes the current roles (${roles}).`
              : "No enabled table permission exists for this table.",
      };
    }
    return { mode: permissionMode === "permissive" ? "permissive" : "enforce", operations, grantCount: applied.length, disabled };
  };
  const inspectionCache = new Map();
  // Page inspection answers with the identity that a portal request for the inspected page,
  // carrying the same cookies, would get (requestAuth): the session, otherwise anonymous.
  const inspectionIdentity = (req, route) => {
    const auth = requestAuth({ headers: req.headers }, new URL(route, "http://mirage.invalid"));
    return auth.identity ? trace.run({ auth }, currentIdentity) : currentIdentity();
  };
  const inspectRoute = (route, identity = currentIdentity()) => {
    const permissionMode = store.snapshot({ sections: ["settings"] }).settings?.permissionMode ?? "enforce";
    const key = JSON.stringify([revision, route, identity.contactId ?? identity.id ?? null, identity.roles ?? [], identity.roleIds ?? [], identity.roleSource ?? null, permissionMode]);
    if (inspectionCache.has(key)) return inspectionCache.get(key);
    const mappings = store.snapshot({ sections: ["mappings"] }).mappings ?? {};
    const report = inspectPage(portal, route, {
      solutionMetadata,
      sourcePortal,
      overrides: config().portalOverrides ?? {},
      identity,
      access: (page) => pageAccess(portal, page, identity),
      mapping: (entity) => mappings[entity] ?? null,
      tablePermissions: (entity) => tablePermissionSummary(entity, identity, permissionMode),
    });
    const value = {
      ...report,
      revision,
      identity: identitySummary(identity),
      permissionMode,
      sourceRoots: [...new Set([sourceDir, ...solutionRoots, ...(solutionMetadata.plugins?.sourceRoots ?? []), ...(report.sourceRoots ?? [])].filter(Boolean))],
    };
    inspectionCache.set(key, value);
    if (inspectionCache.size > 24) inspectionCache.delete(inspectionCache.keys().next().value);
    return value;
  };
  const allDiagnostics = () => [
    ...packConfigurations.diagnostics,
    ...(activeProfiles.diagnostics ?? []),
    ...portal.diagnostics,
    ...(config().importDiagnostics ?? []),
    ...(appliedPermissionModel?.diagnostics ?? []),
    ...(solutionMetadata.diagnostics ?? []),
    ...diagnostics,
  ];
  /** Cheap runtime status for the toolkit panel and tools; no fingerprints are recomputed. */
  const statusPayload = () => {
    const state = store.snapshot({ sections: ["settings", "simulator", "presets"] });
    const byCode = {};
    const all = allDiagnostics();
    for (const item of all) byCode[item.code ?? "OBSERVATION"] = (byCode[item.code ?? "OBSERVATION"] ?? 0) + 1;
    return {
      csrf,
      site: portal.website?.name ?? portal.website?.adx_name ?? null,
      format: portal.format,
      sourceDir: portal.sourceDir,
      solutionRoots,
      stateFile,
      platformStyles: platformStylesStatus(config().shellProfile), localOverrides,
      startupPreset,
      activeConfigurationPreset: config().activeExperiment ?? null,
      deploymentProfile: portal.deploymentProfile ?? null,
      profileSelection: deploymentProfilesSummary(profileConfig, activeProfiles),
      render,
      platformSettings: platformSettingEntries(state),
      observed: config().observed,
      richText: {mode:richTextCompatibility()?'compatibility':'native',nativeReady:nativeRichTextReady(cache?.manifest(),config().shellProfile,live.origin)},
      subgridLabelMarkup: config().observed?.subgridLabelMarkup ?? 'sanitized',
      sourceFingerprint: fingerprint,
      loadedImplementationFingerprint: implementationFingerprint,
      revision,
      reloading: Boolean(reloadPromise),
      pendingReload: Boolean(reloadPromise) && reloadRequested,
      pageCount: portal.pages.length,
      diagnostics: { total: all.length, byCode },
      audit: { retained: audit.entries.length, latestSequence: audit.sequence },
      identity: identitySummary(),
      permissionMode: state.settings?.permissionMode ?? "enforce",
      permissionSource: state.simulator?.permissionSource ?? "configured",
      mode: state.simulator?.mode ?? "local",
      pageMode: state.simulator?.pageMode ?? "local",
      // The local sign-in page (exported LoginPath, else the observed one, else /signin).
      signInPath: signInPath(portal).path,
      // External sign-in: the local identity provider's origin and port, and the site's providers.
      identityProvider: externalSignIn?.status() ?? { available: false, reason: "The local identity provider is not running." },
      // Loopback confinement of local portal pages (opt-in) and its exceptions.
      confinePortalPages: state.simulator?.confinePortalPages === true,
      externalAssets: state.simulator?.externalAssets === true,
      externalFrameOrigins: Array.isArray(state.simulator?.externalFrameOrigins) ? state.simulator.externalFrameOrigins.length : 0,
      presets: listPresets({ state, library: generatedPresets }),
      scenarios: Array.isArray(state.simulator?.scenarios) ? state.simulator.scenarios : [],
      activeScenario: state.simulator?.activeScenario ?? null,
      live: live.status(),
      // "disabled" unless the runtime was started with --allow-live-writes; then "off" or "enabled".
      liveWrites: live.status().liveWrites,
      localOrigin,
      adminUrl: `${localOrigin}/_sim/`,
    };
  };
  const SCENARIO_FIELDS = ["id", "name", "description", "preset", "persona", "permissionMode", "permissionSource"];
  const validateScenario = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw error("A scenario must be a JSON object.");
    for (const key of Object.keys(value))
      if (!SCENARIO_FIELDS.includes(key)) throw error(`Unknown scenario field: ${key}`);
    if (typeof value.id !== "string" || !/^[\w.-]{1,80}$/.test(value.id))
      throw error("Scenario id must have 1-80 letters, numbers, dots, underscores or hyphens.");
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 160)
      throw error("Scenario name is required (at most 160 characters).");
    if (value.description !== undefined && typeof value.description !== "string")
      throw error("Scenario description must be text.");
    if (value.preset !== undefined && value.preset !== null && (typeof value.preset !== "string" || !value.preset))
      throw error("Scenario preset must be a preset ID.");
    if (
      value.persona !== undefined &&
      value.persona !== null &&
      (typeof value.persona !== "object" || Array.isArray(value.persona) || typeof value.persona.contactId !== "string" || !value.persona.contactId || Object.keys(value.persona).some((key) => key !== "contactId"))
    )
      throw error("Scenario persona must be null (anonymous) or { contactId }.");
    if (value.permissionMode !== undefined && !["enforce", "permissive"].includes(value.permissionMode))
      throw error("Scenario permissionMode must be enforce or permissive.");
    if (value.permissionSource !== undefined && !["configured", "exported", "combined"].includes(value.permissionSource))
      throw error("Scenario permissionSource must be configured, exported or combined.");
    if (!value.preset && value.persona === undefined && !value.permissionMode && !value.permissionSource)
      throw error("A scenario must select a preset, a persona or a permission setting.");
    return value;
  };
  /** Persona and permission parts of a scenario, applied to a state before it is saved. */
  const scenarioAdjustment = (scenario) => (state) => {
    state.simulator ??= config();
    if (scenario.persona !== undefined) {
      const contactId = scenario.persona ? personaKey(scenario.persona.contactId) : null;
      if (contactId) {
        const idColumn = state.mappings?.contact?.idColumn ?? "contactid";
        if (!(state.tables?.contact ?? []).some((row) => personaKey(row[idColumn]) === contactId))
          throw error(`Scenario persona ${contactId} is not a local contact after applying the scenario.`, 409, "SCENARIO_PERSONA_UNAVAILABLE");
      }
      state.simulator.identity = contactId
        ? { id: contactId, contactId, roleSource: "memberships", roles: [] }
        : { id: null, roleSource: "memberships", roles: [] };
    }
    if (scenario.permissionMode) state.settings = { ...state.settings, permissionMode: scenario.permissionMode };
    if (scenario.permissionSource) state.simulator.permissionSource = scenario.permissionSource;
    state.simulator.activeScenario = { id: scenario.id, name: scenario.name, appliedAt: new Date().toISOString() };
    validateConfig(state.simulator);
  };
  const ENVIRONMENT_TABLES = { definition: "environmentvariabledefinition", value: "environmentvariablevalue" };
  const tableMapping = (entity) => {
    try {
      return store.resolveMapping(entity);
    } catch {
      return null;
    }
  };
  const lookupId = (value) => personaKey(value && typeof value === "object" ? value.id ?? value.value : value);
  /** Environment variable definitions joined with their current local values, when imported. */
  const environmentVariableTable = () => {
    const definitionMapping = tableMapping(ENVIRONMENT_TABLES.definition);
    const valueMapping = tableMapping(ENVIRONMENT_TABLES.value);
    if (!definitionMapping) return { available: false, valuesMapped: Boolean(valueMapping), definitions: [] };
    const tables = store.snapshot({ tables: [definitionMapping.logicalName, ...(valueMapping ? [valueMapping.logicalName] : [])] }).tables ?? {};
    const values = valueMapping ? tables[valueMapping.logicalName] ?? [] : [];
    const valueFor = (definitionId) =>
      values.find((row) => [row.environmentvariabledefinitionid, row._environmentvariabledefinitionid_value].some((candidate) => lookupId(candidate) === definitionId));
    return {
      available: true,
      valuesMapped: Boolean(valueMapping),
      definitions: (tables[definitionMapping.logicalName] ?? []).map((row) => {
        const definitionId = personaKey(row[definitionMapping.idColumn]);
        const current = valueFor(definitionId);
        return {
          id: definitionId,
          schemaName: row.schemaname ?? row.schemaName ?? null,
          displayName: row.displayname ?? row.displayName ?? row.schemaname ?? null,
          type: row.type ?? null,
          defaultValue: row.defaultvalue ?? null,
          description: row.description ?? null,
          secret: Number(row.secretstore ?? 0) === 1 || Number(row.type) === 100000005,
          valueId: current ? personaKey(current[valueMapping.idColumn]) : null,
          value: current?.value ?? null,
          effectiveValue: current?.value ?? row.defaultvalue ?? null,
          overridden: Object.hasOwn(config().environmentVariables ?? {}, row.schemaname ?? row.schemaName ?? ""),
        };
      }),
    };
  };
  async function largeJsonBody(req, limit = 256 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw error("State import exceeds 256 MiB.", 413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw error("State import must be valid JSON.");
    }
  }
  async function admin(req, res, url) {
    const relative = url.pathname.slice("/__sim/api".length);
    const method = req.method;
    if (method === "GET" && relative === "/page-resources") {
      const route = url.searchParams.get("path") ?? "/";
      if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\")) throw error("A portal-relative page path is required.");
      const report = inspectRoute(route, inspectionIdentity(req, route));
      // view=summary: what a tool needs on every navigation; the full report stays on request.
      if (url.searchParams.get("view") === "summary") {
        const length = (value) => (Array.isArray(value) ? value.length : 0);
        return json(res, 200, {
          path: report.path,
          view: "summary",
          revision: report.revision,
          permissionMode: report.permissionMode,
          sourceRoots: report.sourceRoots,
          page: report.page
            ? { name: report.page.name, pageName: report.page.pageName ?? null, url: report.page.url, title: report.page.title ?? null, access: { allowed: report.page.access?.allowed ?? null, status: report.page.access?.status ?? null, code: report.page.access?.code ?? null, reason: report.page.access?.reason ?? null } }
            : null,
          tables: (report.tables ?? []).map((table) => table.logicalName),
          counts: {
            accessRules: length(report.page?.access?.rules),
            templates: length(report.webTemplates),
            snippets: length(report.snippets),
            settings: length(report.siteSettings),
            forms: length(report.forms),
            views: length(report.views),
            tables: length(report.tables),
            columns: length(report.columns),
            usages: length(report.usages),
            related: length(report.related?.weblinks) + length(report.related?.sitemarkers) + length(report.related?.redirects) + length(report.related?.shortcuts),
            unresolved: length(report.unresolved),
          },
        });
      }
      return json(res, 200, report);
    }
    if (method === "GET" && relative === "/status") return json(res, 200, statusPayload());
    if (method === 'GET' && relative === '/verification-witness') {
      if ([...url.searchParams.keys()].some(key => key !== 'tables') || url.searchParams.getAll('tables').length !== 1)
        throw error('Select explicit logical fixture tables with one tables query parameter.', 400, 'InvalidVerificationSelection');
      const selectedTables = url.searchParams.get('tables').split(',');
      const auth = requestAuth(req, new URL('/', url));
      const witness = await trace.run({ ...trace.getStore(), auth, localOnly: true }, () => store.readOperation(async () => {
        verificationTableSelection(selectedTables, store.state);
        const start = { revision, fingerprint, portal };
        const [currentSource, currentImplementation] = await Promise.all([calculateFingerprint(), cachedSourceFingerprint(ROOT)]);
        if (start.revision !== revision || start.fingerprint !== fingerprint || start.portal !== portal)
          throw error('Runtime source changed while capturing verification evidence.', 409, 'VerificationSourceDrift');
        return verificationWitness({ state: store.state, tables: selectedTables, identity: currentIdentity(), portal,
          runtime: { origin: localOrigin, instanceId: verificationRuntimeId, revision, storeRevision: store.revision, loadedSourceFingerprint: fingerprint,
            currentSourceFingerprint: currentSource, loadedImplementationFingerprint: implementationFingerprint,
            currentImplementationFingerprint: currentImplementation } });
      }));
      return json(res, 200, witness);
    }
    if (method === "GET" && relative === "/operations") return json(res, 200, { items: operations() });
    if (method === 'GET' && relative === '/persona-runtimes') return json(res,200,personaRuntimes.list());
    if (method === "GET" && relative === "/personas") return json(res, 200, personasPayload());
    if (method === "GET" && relative === "/scenarios")
      return json(res, 200, { scenarios: Array.isArray(config().scenarios) ? config().scenarios : [], activeScenario: config().activeScenario ?? null });
    if (method === "GET" && relative === "/environment") {
      let deploymentProfiles = [];
      try {
        deploymentProfiles = (await fs.readdir(path.join(portal.sourceDir, "deployment-profiles")))
          .filter((name) => /\.deployment\.ya?ml$/i.test(name))
          .map((name) => name.replace(/\.deployment\.ya?ml$/i, ""))
          .sort();
      } catch {
        deploymentProfiles = [];
      }
      return json(res, 200, {
        sourceDir: portal.sourceDir,
        solutionRoots,
        live: live.status(),
        deploymentProfile: portal.deploymentProfile ?? null,
        deploymentProfiles,
        profileSelection: deploymentProfilesSummary(profileConfig, activeProfiles),
        profileChanges: (portal.profileChanges ?? []).length,
        environmentVariables: environmentVariableTable(),
        referenceImports: config().referenceImports ?? [],
      });
    }
    if (method === "GET" && relative === "/state/export")
      return json(res, 200, store.snapshot(), {
        "content-disposition": 'attachment; filename="simulator-state.json"',
      });
    if (method === "GET" && relative === "/state") {
      if (evidenceDir)
        try {
          evidence = JSON.parse(
            await fs.readFile(path.join(evidenceDir, "report.json"), "utf8"),
          );
        } catch {
          evidence = null;
        }
      const current = exposedState({
        summary: url.searchParams.get("summary") === "1",
      });
      // Browser adapters/admin assets are read on demand. A startup-only digest
      // cannot detect their edits during a comparison against this process.
      Object.assign(current.status, implementationEvidence(implementationFingerprint, await cachedSourceFingerprint(ROOT)));
      current.status.solutionMetadata = {
        ...solutionMetadata.summary,
        data: solutionData.stats,
        roots: solutionRoots,
      };
      current.diagnostics.push(...solutionMetadata.diagnostics);
      const report = observedEvidence(evidence, current);
      return json(res, 200, {
        ...current,
        assets: cache?.manifest(),
        evidence: report
          ? {
              ...report,
              artifactUrls: {
                live: "/__sim/evidence/live.png",
                local: "/__sim/evidence/local.png",
                difference: "/__sim/evidence/difference.png",
              },
            }
          : null,
      });
    }
    if (method === "GET" && relative === "/diagnostics")
      return json(res, 200, {
        diagnostics: [...packConfigurations.diagnostics, ...portal.diagnostics, ...diagnostics],
        requests,
      });
    if (method === "GET" && relative === "/audit")
      return json(res, 200, audit.list(url.searchParams));
    if (method === "GET" && relative === "/audit/export")
      return json(res, 200, audit.export(url.searchParams), {
        "content-disposition": 'attachment; filename="simulator-audit.json"',
      });
    if (isWrite(method) && req.headers["x-sim-csrf"] !== csrf)
      throw error("Missing simulator CSRF token.", 403);
    const operationRoute = /^\/operations\/([^/]+)$/.exec(relative);
    if (operationRoute && ['PATCH', 'DELETE'].includes(method)) return change(async () => {
      const key = decodeURIComponent(operationRoute[1]);
      const item = operations().find(item => item.key === key);
      if (!item) throw error('This operation is not in the current source exports.', 404);
      if (!item.configurable) throw error(item.kind === 'plugin-step' ? item.unsupported || 'This plugin registration is disabled in the export.' : 'This workflow has no exported portal consumer or trigger route. Add its consumer to the portal sources first.', 409);
      const state = store.snapshot();
      state.simulator ??= config();
      state.simulator.operations = { ...(state.simulator.operations ?? {}) };
      const previousRuntime = registeredPluginRuntimes.get(item.id);
      let preparedRuntime;
      if (method === 'DELETE') delete state.simulator.operations[key];
      else {
        const value = await jsonBody(req);
        validateOperationOverrides({ [key]: value },{pluginStep:item.kind==='plugin-step'?item:undefined});
        if (value.mode === 'handler' && !item.registered) throw error('No trusted project handler is registered for this operation.', 409);
        if(value.mode==='clr'){if(!item.clrAvailable)throw error('No explicitly trusted CLR descriptor is registered for this exact exported plugin step/type.',409);if(item.unsupported)throw error(item.unsupported,409);if(!previousRuntime)preparedRuntime=await prepareClrRuntime(registeredPluginDescriptors.get(item.id));}
        if(value.mode==='handler'&&item.unsupported)throw error(item.unsupported,409);
        if (value.mode === 'exported' && !item.definitionAvailable) throw error('The selected sources do not include this operation definition.', 409);
        state.simulator.operations[key] = value;
      }
      if(preparedRuntime)registeredPluginRuntimes.set(item.id,preparedRuntime);
      try { await saveState(state); }
      catch(cause){
        if(preparedRuntime){registeredPluginRuntimes.delete(item.id);closeClrHostPool({runtime:preparedRuntime,diagnostic:recordDiagnostic});}
        throw cause;
      }
      if(previousRuntime&&state.simulator.operations[key]?.mode!=='clr'){
        registeredPluginRuntimes.delete(item.id);
        closeClrHostPool({runtime:previousRuntime,diagnostic:recordDiagnostic});
      }
      return json(res, 200, { items: operations() });
    });
    if (method === "POST" && relative === "/shutdown") {
      json(res, 202, { accepted: true, message: "Mirage shutdown accepted." });
      setImmediate(() => {
        if (typeof onShutdown === "function")
          Promise.resolve().then(onShutdown).catch(() => close());
        else void close();
      });
      return;
    }
    if (method === "POST" && relative === "/audit/clear")
      return json(res, 200, audit.clear());
    if (method === 'PUT' && relative === '/persona-catalog' || method === 'DELETE' && relative === '/persona-catalog') {
      const body = await jsonBody(req);
      await change(() => store.transact(() => {
        const state = store.state;
        const digest = createHash('sha256').update(JSON.stringify(state.personaCatalog ?? null)).digest('hex');
        if (body?.expectedDigest !== digest) throw error('Persona catalogue changed. Reload before saving.',409,'PersonaCatalogConflict');
        if (method === 'DELETE') delete state.personaCatalog;
        else state.personaCatalog = validatePersonaCatalog(body.catalog, 'State');
      }));
      return json(res,200,personasPayload());
    }
    if (method === 'POST' && relative === '/personas/launch') {
      const result = await launchPersona(await jsonBody(req));
      return json(res,200,result,{'set-cookie':result.cookieHeader+'; Path=/; HttpOnly; SameSite=Lax'});
    }
    if (method === 'DELETE' && relative.startsWith('/persona-runtimes/')) return json(res,200,await personaRuntimes.stop(decodeURIComponent(relative.slice('/persona-runtimes/'.length))));
    if (method === "POST" && relative === "/personas/select")
      return change(async () => {
        const body = await jsonBody(req);
        if (body.contactId !== null && (typeof body.contactId !== "string" || !body.contactId.trim()))
          throw error("Select a local contact ID, or null for an anonymous visitor.");
        const contactId = body.contactId === null ? null : personaKey(body.contactId);
        const state = store.snapshot();
        if (contactId) {
          const idColumn = state.mappings?.contact?.idColumn ?? "contactid";
          const contact = (state.tables?.contact ?? []).find((row) => personaKey(row[idColumn]) === contactId);
          const statecode = contact?.statecode && typeof contact.statecode === "object" ? contact.statecode.value : contact?.statecode;
          if (!contact || Number(statecode ?? 0) !== 0)
            throw error("The selected persona must be an active local contact.", 404, "PERSONA_CONTACT_UNAVAILABLE");
        }
        state.simulator.identity = contactId
          ? { id: contactId, contactId, roleSource: "memberships", roles: [] }
          : { id: null, roleSource: "memberships", roles: [] };
        validateConfig(state.simulator);
        await saveState(state);
        return json(res, 200, personasPayload());
      });
    if (method === "POST" && relative === "/personas")
      return change(async () => {
        const body = await jsonBody(req);
        const mapping = tableMapping("contact");
        if (!mapping) throw error("Map the contact table before creating personas.", 409, "CONTACT_UNMAPPED");
        const text = (value, label, required = false) => {
          if (value === undefined || value === null || value === "") {
            if (required) throw error(`${label} is required.`);
            return null;
          }
          if (typeof value !== "string" || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw error(`${label} must be text of at most 200 characters.`);
          return value.trim();
        };
        const firstname = text(body.firstname, "First name");
        const lastname = text(body.lastname, "Last name", true);
        const email = text(body.emailaddress1, "Email");
        const accountId = text(body.accountId, "Account ID");
        const roleIds = Array.isArray(body.roleIds) ? body.roleIds.map(personaKey) : [];
        const known = new Set(personasPayload().webRoles.map((role) => role.id));
        const unknown = roleIds.filter((roleId) => !known.has(roleId));
        if (unknown.length) throw error(`Unknown exported web-role IDs: ${unknown.join(", ")}`);
        const contactId = randomUUID();
        const values = {
          [mapping.idColumn]: contactId,
          ...(firstname ? { firstname } : {}),
          lastname,
          fullname: [firstname, lastname].filter(Boolean).join(" "),
          ...(email ? { emailaddress1: email } : {}),
          ...(accountId ? { parentcustomerid: { id: personaKey(accountId), logical_name: "account" } } : {}),
        };
        const created = await store.create(mapping.logicalName, values, { admin: true });
        try {
          const state = store.snapshot();
          state.simulator.contactRoles = [
            ...(state.simulator.contactRoles ?? []),
            ...[...new Set(roleIds)].map((roleId) => ({ contactId, roleId })),
          ];
          if (body.select === true) state.simulator.identity = { id: contactId, contactId, roleSource: "memberships", roles: [] };
          validateConfig(state.simulator);
          await saveState(state);
        } catch (cause) {
          await store.remove(mapping.logicalName, contactId, { admin: true }).catch(() => {});
          throw cause;
        }
        return json(res, 201, { contact: created, ...personasPayload() });
      });
    const scenarioRoute = /^\/scenarios(?:\/([^/]+))?(?:\/(apply))?$/.exec(relative);
    if (scenarioRoute && method !== "GET") {
      const id = scenarioRoute[1] && decodeURIComponent(scenarioRoute[1]);
      return change(async () => {
        const scenarios = Array.isArray(config().scenarios) ? config().scenarios : [];
        if (scenarioRoute[2] === "apply" && method === "POST") {
          const scenario = scenarios.find((item) => item.id === id);
          if (!scenario) throw error("Scenario not found.", 404);
          if (scenario.preset) await applySelectedPreset(scenario.preset, scenarioAdjustment(scenario));
          else {
            const state = store.snapshot();
            scenarioAdjustment(scenario)(state);
            await saveState(state);
          }
          return json(res, 200, statusPayload());
        }
        if (!["POST", "PATCH", "DELETE"].includes(method) || scenarioRoute[2] || (method === "POST" && id) || (method !== "POST" && !id))
          throw error("Unsupported scenario operation.", 405);
        const index = scenarios.findIndex((item) => item.id === id);
        const next = [...scenarios];
        if (method === "DELETE") {
          if (index < 0) throw error("Scenario not found.", 404);
          next.splice(index, 1);
        } else {
          const body = await jsonBody(req);
          const value = validateScenario(method === "PATCH" ? { ...scenarios[index], ...body, id } : body);
          if (method === "POST" && scenarios.some((item) => item.id === value.id)) throw error("Scenario already exists.", 409);
          if (method === "PATCH" && index < 0) throw error("Scenario not found.", 404);
          if (value.preset && !listPresets({ state: store.snapshot({ sections: ["presets"] }), library: generatedPresets }).some((preset) => preset.id === value.preset))
            throw error(`Unknown preset: ${value.preset}`, 400, "SCENARIO_PRESET_UNKNOWN");
          if (method === "POST") next.push(value);
          else next[index] = value;
        }
        const state = store.snapshot();
        state.simulator.scenarios = next;
        // Scenario definitions do not change rendered output: persist without reloading pages.
        await replaceCompiledState(state);
        return json(res, method === "POST" ? 201 : 200, { scenarios: next, activeScenario: state.simulator.activeScenario ?? null });
      });
    }
    if (method === 'PUT' && relative === '/environment/profiles')
      return change(async () => {
        const body = await jsonBody(req);
        profileSelection(profileConfig, body);
        const state = store.snapshot();
        if (body === null) delete state.simulator.deploymentProfilePin;
        else state.simulator.deploymentProfilePin = body;
        await saveState(state);
        return json(res, 200, deploymentProfilesSummary(profileConfig, activeProfiles));
      });
    if (method === "POST" && relative === "/environment/reference")
      return change(async () => {
        const body = await jsonBody(req);
        if (typeof body.origin !== "string") throw error("Provide the reference origin to use for live routing.");
        const state = store.snapshot();
        state.simulator.live = { ...(state.simulator.live ?? {}), origin: body.origin };
        validateConfig(state.simulator);
        await saveState(state);
        return json(res, 200, { live: live.status() });
      });
    const variableRoute = /^\/environment\/variables\/([^/]+)$/.exec(relative);
    if (variableRoute && method === "PUT")
      return change(async () => {
        const schemaName = decodeURIComponent(variableRoute[1]);
        const body = await jsonBody(req);
        if (body.value !== null && typeof body.value !== "string") throw error("Environment variable values are text, or null to remove the local value.");
        const definitionMapping = tableMapping(ENVIRONMENT_TABLES.definition);
        const valueMapping = tableMapping(ENVIRONMENT_TABLES.value);
        if (!definitionMapping || !valueMapping)
          throw error("Environment variable tables are not available in this runtime state.", 409, "ENVIRONMENT_VARIABLES_UNAVAILABLE");
        const definition = environmentVariableTable().definitions.find((item) => item.schemaName === schemaName);
        if (!definition) throw error("Environment variable definition not found.", 404);
        // The local value is persisted as an override, so Solution re-seeding keeps it; null
        // removes it and the Solution value (or the definition default) applies again.
        const state = store.snapshot();
        const overrides = { ...(state.simulator.environmentVariables ?? {}) };
        if (body.value === null) delete overrides[schemaName];
        else overrides[schemaName] = body.value;
        state.simulator.environmentVariables = overrides;
        const rows = (state.tables[valueMapping.logicalName] ??= []);
        const index = definition.valueId ? rows.findIndex((row) => personaKey(row[valueMapping.idColumn]) === definition.valueId) : -1;
        if (body.value === null) {
          if (index >= 0) rows.splice(index, 1);
        } else if (index >= 0) rows[index] = { ...rows[index], value: body.value };
        else
          rows.push({
            [valueMapping.idColumn]: randomUUID(),
            schemaname: schemaName,
            value: body.value,
            environmentvariabledefinitionid: definition.id,
          });
        await saveState(state);
        return json(res, 200, environmentVariableTable().definitions.find((item) => item.schemaName === schemaName));
      });
    if (method === "POST" && (relative === "/reference/enrich/validate" || relative === "/reference/enrich")) {
      const body = await jsonBody(req);
      if (relative.endsWith("/validate")) {
        // Run the importer's own plan validation, stopping before the first reference read.
        const stop = Symbol("validated");
        try {
          await enrichReference({ store, origin: live.origin, plan: body.plan, bridge: { fetchXml: async () => { throw stop; } } });
        } catch (cause) {
          if (cause !== stop) throw error(cause.message, cause.status ?? 400, cause.code ?? "ENRICHMENT_PLAN_INVALID");
        }
        return json(res, 200, {
          valid: true,
          entries: body.plan.map((entry) => {
            const mapping = store.resolveMapping(entry.entity);
            return { entity: mapping.logicalName, idColumn: mapping.idColumn, mode: entry.mode ?? "merge", pageSize: entry.pageSize ?? 5000, maxPages: entry.maxPages ?? 10 };
          }),
          live: live.status(),
        });
      }
      if (!live.status().connected || !live.origin)
        throw error("Connect the intended reference browser and select its origin before running an enrichment plan.", 409, "LIVE_NOT_CONNECTED");
      return change(async () => {
        const runtimeStore = {
          resolveMapping: (entity) => store.resolveMapping(entity),
          snapshot: (projection) => store.snapshot(projection),
          snapshotDigest: () => store.snapshotDigest(),
          replaceState: async (state, { expectedSnapshot, expectedDigest } = {}) => {
            if (expectedDigest !== undefined && store.snapshotDigest() !== expectedDigest)
              throw error("Local state changed during reference reads; enrichment was not applied.", 409, "StateConflict");
            if (expectedSnapshot !== undefined && JSON.stringify(store.snapshot()) !== expectedSnapshot)
              throw error("Local state changed during reference reads; enrichment was not applied.", 409, "StateConflict");
            await saveState(state);
          },
        };
        const report = await enrichReference({ store: runtimeStore, origin: live.origin, plan: body.plan, bridge: live });
        return json(res, 200, report);
      });
    }
    if (method === "POST" && relative === "/state/import")
      return change(async () => {
        const imported = await largeJsonBody(req);
        if (!imported || typeof imported !== "object" || Array.isArray(imported))
          throw error("State import must be a simulator state object.");
        // Saved scenario definitions are workspace tooling and survive a state import.
        const scenarios = config().scenarios;
        const next = imported;
        next.simulator = { mode: "local", pageMode: "local", identity: { roles: [] }, endpoints: [], ...(next.simulator ?? {}) };
        if (Array.isArray(scenarios) && !Array.isArray(next.simulator.scenarios)) next.simulator.scenarios = scenarios;
        validateConfig(next.simulator);
        await saveState(next);
        return json(res, 200, { imported: true, revision, tableCounts: store.summary().tableCounts });
      });
    if(relative==='/platform-settings'&&method==='GET')return json(res,200,platformSettingEntries(store.snapshot()));
    if(relative==='/platform-settings'&&method==='PATCH')return change(async()=>{
      const patch=validatePlatformOverrides(await jsonBody(req)),state=store.snapshot();
      state.simulator.platformOverrides={...state.simulator.platformOverrides,...patch};delete state.simulator.activeExperiment;
      await saveState(state);return json(res,200,platformSettingEntries(store.snapshot()));
    });
    if(relative.startsWith('/platform-settings/')&&method==='DELETE')return change(async()=>{
      const key=decodeURIComponent(relative.slice('/platform-settings/'.length));if(!platformSettingEntries(store.snapshot()).some(x=>x.key===key))throw error('Unknown platform setting.',404);
      const state=store.snapshot();delete (state.simulator.platformOverrides??{})[key];delete state.simulator.activeExperiment;await saveState(state);return json(res,200,{reset:key});
    });
    const experimentRoute=/^\/experiments(?:\/([^/]+)(\/apply)?)?$/.exec(relative);
    if(experimentRoute){
      const id=experimentRoute[1]&&experimentId(decodeURIComponent(experimentRoute[1]));
      if(method==='GET'&&!experimentRoute[2]){const presets=experimentPresets(store.snapshot(),sourcePortal,packConfigurations.presets),item=id?presets.find(p=>p.id===id):presets;if(!item)throw error('Experiment not found.',404);return json(res,200,item);}
      return change(async()=>{
        const state=store.snapshot(),presets=experimentPresets(state,sourcePortal,packConfigurations.presets),existing=presets.find(p=>p.id===id);
        if(method==='POST'&&experimentRoute[2]){if(!existing)throw error('Experiment not found.',404);await saveState(applyExperiment(state,existing));return json(res,200,{applied:id});}
        if(method==='POST'&&!id){const p=validateExperiment(await jsonBody(req));if(presets.some(x=>x.id===p.id))throw error('Experiment ID already exists.',409);state.simulator.experimentPresets??={};if(Object.keys(state.simulator.experimentPresets).length>=100)throw error('Experiment preset limit reached.',413);state.simulator.experimentPresets[p.id]=structuredClone(p);await saveState(state);return json(res,201,p);}
        if(method==='DELETE'&&id&&!experimentRoute[2]){if(!existing)throw error('Experiment not found.',404);if(existing.builtin||existing.readOnly)throw error('Built-in and pack configuration presets cannot be deleted.',403);delete state.simulator.experimentPresets[id];await saveState(state);return json(res,200,{deleted:id});}
        throw error('Unsupported experiment operation.',405);
      });
    }
    const portalEntry = /^\/(portal-settings|portal-snippets|portal-roles|portal-access-rules)(?:\/(.+))?$/.exec(relative);
    if (portalEntry) {
      const section = { "portal-settings": "settings", "portal-roles": "roles", "portal-access-rules": "accessRules" }[portalEntry[1]] ?? "snippets";
      const rawName = portalEntry[2] && decodeURIComponent(portalEntry[2]);
      const name = section === "accessRules" && rawName ? personaKey(rawName) : rawName;
      const items = () => portalOverrideEntries(sourcePortal, config().portalOverrides, section);
      if (method === "GET") {
        const item = name ? items().find(entry => entry.id === name) : items();
        if (!item) throw error("Portal value not found.", 404);
        return json(res, 200, item);
      }
      if (!["POST", "PATCH", "DELETE"].includes(method)) throw error("Unsupported portal value operation.", 405);
      return change(async () => {
        const body = method === "DELETE" ? null : await jsonBody(req);
        const key = name ?? (section === "roles" ? body?.id ?? randomUUID() : section === "accessRules" ? personaKey(body?.id ?? randomUUID()) : body?.name);
        if (section === "accessRules" && body?.value) {
          // Rules must target exported pages and effective web roles of this portal.
          const value = body.value;
          if (typeof value.webPageId === "string") value.webPageId = personaKey(value.webPageId);
          if (Array.isArray(value.roleIds)) value.roleIds = value.roleIds.map(personaKey);
          if (!portal.pages.some((page) => page.id === value.webPageId)) throw error("Page access rules must target an exported web page ID.");
          const roleIds = new Set(portal.records.filter((record) => record.kind === "webrole").map((record) => personaKey(record.id)));
          const unknown = (value.roleIds ?? []).filter((roleId) => !roleIds.has(roleId));
          if (unknown.length) throw error(`Unknown web-role IDs: ${unknown.join(", ")}`);
        }
        const state = store.snapshot();
        state.simulator.portalOverrides ??= {};
        delete state.simulator.activeExperiment;
        const entries = state.simulator.portalOverrides[section] ??= {};
        if (method === "DELETE") {
          if (!Object.hasOwn(entries, key)) throw error("Local override not found.", 404);
          delete entries[key];
        } else {
          if (method === "POST" && items().some(entry => entry.id === key && !entry.deleted)) throw error("Portal value already exists.", 409);
          if (method === "PATCH" && !items().some(entry => entry.id === key)) throw error("Portal value not found.", 404);
          if (typeof key !== "string") throw error("Portal values require a name.");
          // Validate on a fresh dictionary before assigning untrusted identifiers.
          validatePortalOverrides({ [section]: Object.fromEntries([[key, body?.value]]) });
          Object.defineProperty(entries, key, { value: body.value, enumerable: true, writable: true, configurable: true });
        }
        await saveState(state);
        return json(res, method === "POST" ? 201 : 200, items().find(entry => entry.id === key) ?? { reset: key });
      });
    }
    if (relative === "/config" && method === "PATCH")
      return change(async () => {
        const patch = await jsonBody(req);
        const state = store.snapshot();
        const allowed = [
          "mode",
          "pageMode",
          "identity",
          "live",
          "componentSchemas",
          "externalAssets",
          "externalFrameOrigins",
          "confinePortalPages",
          "permissionMode",
          "shellProfile",
          "contactRoles",
          "permissionSource",
          "portalOverrides",
          "platformOverrides",
          "operations",
        ];
        for (const key of Object.keys(patch))
          if (!allowed.includes(key))
            throw error(`Unknown configuration field: ${key}`);
        // Live writes need the runtime flag; the /_sim switch alone never enables them.
        if (patch.live?.allowWrites === true && !allowLiveWrites)
          throw error(
            "Live writes are disabled for this runtime: start the Mirage with --allow-live-writes (mirage dev and start pass it through) before allowing create, update or delete requests to the live environment.",
            403,
            "LIVE_WRITES_DISABLED",
          );
        if (patch.permissionMode) {
          state.settings.permissionMode = patch.permissionMode;
          delete patch.permissionMode;
        }
        state.simulator = {
          ...config(),
          ...patch,
          live: { ...config().live, ...patch.live },
        };
        if(patch.platformOverrides||patch.portalOverrides)delete state.simulator.activeExperiment;
        validateConfig(state.simulator);
        if (
          patch.contactRoles ||
          patch.identity?.roleSource === "memberships"
        ) {
          const model = buildPermissionModel(portal, state, {
            relationships: solutionData.relationships,
          });
          const invalid = model.diagnostics.filter(
            (d) => d.code === "PERSONA_MEMBERSHIP_UNRESOLVED",
          );
          const identity = resolvePortalIdentity(
            portal,
            state,
            state.simulator.identity,
          );
          if (
            invalid.length ||
            identity.diagnostics?.some(
              (d) => d.code === "PERSONA_CONTACT_UNAVAILABLE",
            )
          )
            throw error(
              "Contact memberships must reference active local contacts and exported web roles.",
              400,
              "PERSONA_CONFIGURATION_INVALID",
            );
        }
        await saveState(state);
        json(res, 200, exposedState());
      });
    if (relative === "/assets/capture" && method === "POST") {
      if (!cache)
        throw error(
          "Asset capture requires a persisted simulator state directory.",
          409,
        );
      const body = await jsonBody(req);
      if (
        !Array.isArray(body.paths) ||
        !body.paths.length ||
        body.paths.length > 100 ||
        body.paths.some((p) => typeof p !== "string")
      )
        throw error("Provide between 1 and 100 explicit static path strings.");
      const publicPaths = body.paths.filter((p) =>
        p.startsWith("/resource/powerappsportal/"),
      );
      const portalPaths = body.paths.filter((p) => !publicPaths.includes(p));
      const outputs = [];
      if (portalPaths.length)
        outputs.push(await cache.capture(portalPaths, live));
      if (publicPaths.length)
        outputs.push(
          await cache.capturePublic(publicPaths, {
            portalOrigin: live.origin,
            recursive: true,
          }),
        );
      return json(res, 200, {
        captured: outputs.flatMap((o) => o.captured),
        failures: outputs.flatMap((o) => o.failures),
      });
    }
    if (relative === "/assets/capture-snippet-composition" && method === "POST")
      return change(async () => {
        const body = await jsonBody(req);
        if (
          [body.path, body.parentName, body.childName].some(
            (value) => typeof value !== "string" || !value.trim(),
          )
        )
          throw error(
            "Provide a portal page path and both exported snippet names.",
          );
        const report = await captureObservedSnippetComposition(live, {
          portal,
          path: body.path,
          parentName: body.parentName,
          childName: body.childName,
        });
        const state = store.snapshot(),
          profile = { ...config().shellProfile };
        profile.snippetCompositions = [
          ...(Array.isArray(profile.snippetCompositions)
            ? profile.snippetCompositions
            : []
          ).filter((item) => item.parentName !== report.profile.parentName),
          report.profile,
        ];
        state.simulator = { ...config(), shellProfile: profile };
        await saveState(state);
        for (const diagnostic of report.diagnostics)
          recordDiagnostic(diagnostic);
        return json(res, 200, { ...report, applied: true });
      });
    if (relative === "/assets/capture-stylesheets" && method === "POST")
      return change(async () => {
        const body = await jsonBody(req);
        const report = await captureObservedStylesheets(cache, live, {
          portal,
          paths: body.paths,
        });
        if (!report.complete)
          return json(res, 409, { ...report, applied: false });
        const state = store.snapshot();
        const profile = { ...config().shellProfile };
        const selected = new Set(report.baselines.map((item) => item.path));
        profile.observedStylesheets = [
          ...(Array.isArray(profile.observedStylesheets)
            ? profile.observedStylesheets
            : []
          ).filter((item) => !selected.has(item.path)),
          ...report.baselines,
        ];
        state.simulator = { ...config(), shellProfile: profile };
        await saveState(state);
        for (const diagnostic of report.diagnostics)
          recordDiagnostic(diagnostic);
        return json(res, 200, { ...report, applied: true });
      });
    if (relative === "/assets/capture-shell" && method === "POST")
      return change(async () => {
        const body = await jsonBody(req);
        if (typeof body.path !== "string")
          throw error("Provide the portal page path to capture.");
        if (
          body.managedControlPath !== undefined &&
          typeof body.managedControlPath !== "string"
        )
          throw error("Managed control page path must be a string.");
        let observedHtml;
        const report = await capturePortalShell(cache, live, {
          path: body.path,
          portal,
          onObservedHtml: (html) => {
            observedHtml = html;
          },
        });
        if (!report.ready) return json(res, 409, { ...report, applied: false });
        if (body.richText !== undefined && typeof body.richText !== 'boolean') throw error('richText must be boolean.');
        const richText = body.richText === false ? { required: false, skipped: 'DISABLED', complete: true, nativeReady: false, managedControls: {}, diagnostics: [] } : await captureRichTextAssets(cache, live, {
          schemas: {
            ...solutionMetadata.componentSchemas,
            ...config().componentSchemas,
          },
          portal,
          html: observedHtml,
          managedControls:
            config().managedControls ?? config().shellProfile?.managedControls,
          managedControlPath: body.managedControlPath,
          captureConfigurations: true,
        });
        if (Object.keys(richText.managedControls).length)
          report.shellProfile.managedControls = richText.managedControls;
        if (richText.configurationBaselines?.length)
          report.shellProfile.richTextConfigurations =
            richText.configurationBaselines;
        report.richText = richText;
        if (richText.required) report.shellProfile.richTextReadiness = { nativeReady: richText.nativeReady === true, capturedAt: new Date().toISOString(), origin:live.origin };
        report.complete = report.complete && richText.complete;
        const state = store.snapshot();
        report.shellProfile = mergeShellProfile(
          config().shellProfile,
          report.shellProfile,
          { pagePath: body.path },
        );
        state.simulator = { ...config(), shellProfile: report.shellProfile };
        await saveState(state);
        return json(res, report.complete ? 200 : 207, {
          ...report,
          applied: true,
        });
      });
    if (relative === "/live/connect" && method === "POST") {
      const body = await jsonBody(req);
      return json(res, 200, await live.connect(body.cdpUrl));
    }
    if (relative === "/live/disconnect" && method === "POST") {
      await live.close();
      return json(res, 200, live.status());
    }
    if (relative === "/reset" && method === "POST")
      return change(async () => {
        // replaceCompiledState applies the current Solution data to the replacement.
        const next = structuredClone(
          initial ?? initialState(portal, { origin, metadata: solutionData }),
        );
        // Saved scenario definitions are workspace tooling and survive a reset.
        const scenarios = config().scenarios;
        if (Array.isArray(scenarios)) next.simulator = { ...next.simulator, scenarios };
        await saveState(next);
        // Advanced form sessions belong to the reset state: a reset ends them.
        webFormSessions.clear();
        json(res, 200, exposedState());
      });
    if (relative === "/reload" && method === "POST") {
      await reload();
      return json(res, 200, exposedState());
    }
    const record = /^\/records\/([^/]+)(?:\/([^/]+))?$/.exec(relative);
    if (record) {
      const [, entity, id] = record.map((x) => x && decodeURIComponent(x));
      const identity = { admin: true };
      if (
        method === "GET" &&
        !id &&
        (url.searchParams.has("page") ||
          url.searchParams.has("pageSize") ||
          url.searchParams.has("search"))
      ) {
        const pageSize = Math.min(
          100,
          Math.max(
            1,
            Number.parseInt(url.searchParams.get("pageSize"), 10) || 25,
          ),
        );
        const search = (url.searchParams.get("search") ?? "")
          .trim()
          .toLowerCase();
        const rows = store
          .rows(entity, identity)
          .filter(
            (row) =>
              !search || JSON.stringify(row).toLowerCase().includes(search),
          );
        const total = rows.length,
          pageCount = Math.max(1, Math.ceil(total / pageSize)),
          page = Math.min(
            pageCount,
            Math.max(1, Number.parseInt(url.searchParams.get("page"), 10) || 1),
          );
        return json(res, 200, {
          items: rows.slice((page - 1) * pageSize, page * pageSize),
          total,
          page,
          pageSize,
          pageCount,
        });
      }
      if (method === "GET")
        return json(
          res,
          200,
          id
            ? await store.get(entity, id, identity)
            : await store.query(entity, url.searchParams, identity),
        );
      return change(async () => {
        if (method === "POST" && !id)
          return json(
            res,
            201,
            await store.create(entity, await jsonBody(req), identity),
          );
        if (method === "PATCH" && id)
          return json(
            res,
            200,
            await store.update(entity, id, await jsonBody(req), identity),
          );
        if (method === "DELETE" && id) {
          await store.remove(entity, id, identity);
          return json(res, 204, null);
        }
        throw error("Unsupported record operation.", 405);
      });
    }
    const collection =
      /^\/(mappings|plugins|permissions|endpoints|presets)(?:\/([^/]+))?(?:\/(apply))?$/.exec(
        relative,
      );
    if (collection) {
      const [, kind, rawId, action] = collection;
      const id = rawId && decodeURIComponent(rawId);
      if (method === "GET") {
        if (kind === "presets" && id) {
          const preset = resolvePreset(
            store.snapshot({ sections: ["presets", "mappings"] }),
            id,
            generatedPresets,
          );
          if (!preset) throw error("Configuration item not found.", 404);
          return json(res, 200, { id, ...preset });
        }
        const items = exposedState().config[kind];
        const item = id ? items.find((x) => x.id === id) : items;
        if (!item) throw error("Configuration item not found.", 404);
        return json(res, 200, item);
      }
      return change(async () => {
        const state = store.snapshot();
        state.simulator ??= config();
        if (action === "apply" && kind === "presets" && method === "POST") {
          const options = await jsonBody(req);
          if (options.applyConfiguration !== undefined && typeof options.applyConfiguration !== "boolean") throw error("applyConfiguration must be boolean.",400);
          return json(res, 200, await applySelectedPreset(id, undefined, options));
        }
        const body = method === "DELETE" ? null : await jsonBody(req);
        const key = id ?? body?.id ?? body?.logicalName ?? randomUUID();
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw error("Invalid configuration identifier.");
        if (!["POST", "PATCH", "DELETE"].includes(method))
          throw error("Unsupported configuration operation.", 405);
        if (kind === "mappings" || kind === "presets") {
          state[kind] ??= {};
          const exists = Object.hasOwn(state[kind], key);
          if (method === "POST" && exists)
            throw error("Identifier already exists.", 409);
          if (method !== "POST" && !exists)
            throw error("Configuration item not found.", 404);
          if (method === "DELETE") delete state[kind][key];
          else {
            const previous =
              kind === "presets" && method === "PATCH"
                ? resolvePreset(state, key, generatedPresets)
                : state[kind][key];
            const value = { ...(previous ?? {}), ...body };
            if (kind === "presets") value.userConfigured = true;
            delete value.id;
            delete value.logicalName;
            if (kind === "mappings") {
              if (body.logicalName && body.logicalName !== key)
                throw error("Mapping id must equal its logicalName.");
              if (!value.entitySet || !value.idColumn)
                throw error("Mappings require entitySet and idColumn.");
              value.userConfigured = true;
            }
            state[kind][key] = value;
            if (kind === "mappings") {
              state.tables ??= {};
              state.tables[key] ??= [];
            }
          }
        } else {
          const owner = kind === "endpoints" ? state.simulator : state;
          owner[kind] ??= [];
          const index = owner[kind].findIndex((x) => x.id === key);
          if (
            kind === "permissions" &&
            (state.simulator.permissionSource ?? "configured") !== "configured"
          ) {
            const imported =
              owner[kind][index]?.imported ||
              portal.records.some(
                (record) =>
                  record.kind === "tablepermission" && record.id === key,
              );
            if (state.simulator.permissionSource === "exported" || imported)
              throw error(
                "Imported grants are source controlled. Select configured local rules to edit their local copies, or combined mode to add separate local grants.",
                409,
                "SOURCE_PERMISSION_READ_ONLY",
              );
          }
          if (method === "POST" && index >= 0)
            throw error("Identifier already exists.", 409);
          if (method !== "POST" && index < 0)
            throw error("Configuration item not found.", 404);
          if (method === "DELETE") owner[kind].splice(index, 1);
          else {
            const value = { ...(owner[kind][index] ?? {}), ...body, id: key };
            if (kind === "endpoints") validateEndpoint(value);
            if (index < 0) owner[kind].push(value);
            else owner[kind][index] = value;
          }
        }
        await saveState(state);
        json(
          res,
          method === "POST" ? 201 : 200,
          exposedState().config[kind].find((x) => x.id === key) ?? {
            deleted: key,
          },
        );
      });
    }
    throw error("Admin endpoint not found.", 404);
  }
  // Site tables (lib/site-tables.mjs): read-only site components and web
  // role memberships derived from the export and local personas, rebuilt whenever
  // the portal or the store state object is replaced.
  // Registered on the store at load, so Liquid, FetchXML and Web API reads share them.
  function siteTables() {
    const cache = siteTables.cache;
    if (cache?.portal !== portal || cache?.state !== store.state)
      siteTables.cache = { portal, state: store.state, value: buildSiteTables(portal, store.state) };
    return siteTables.cache.value;
  }
  async function api(req, res, url, { forceLocal = false } = {}) {
    const context = trace.getStore();
    if (context) {
      context.entity = /^\/_api\/([\w]+)/.exec(url.pathname)?.[1];
      context.provider = forceLocal ? "local" : config().mode;
    }
    if (!forceLocal && config().mode === "live") return forward(req, res, url);
    // Local portals Web API : routes, query options, annotations,
    // writes and the documented error envelope live in lib/webapi-handler.mjs.
    const identity = currentIdentity();
    return handleWebApi(req, res, url, {
      store,
      webApiErrorTemplates: registeredWebApiErrorTemplates,
      portal: {
        ...portal,
        webApiViews: solutionMetadata.views,
        webApiEntities: solutionMetadata.entities,
        webApiIdentity: identity,
      },
      identity,
      csrf,
      origin: url.origin,
      // Portal scripts address @odata.id targets on the live portal origin.
      origins: [url.origin, live.origin].filter(Boolean),
      metadata: (logical) => solutionMetadata.entities?.[logical]?.fields,
      json,
      jsonBody,
      change,
      onError: (cause, response) => {
        if(cause.details?.permissionDiagnostic)recordDiagnostic({...cause.details.permissionDiagnostic,path:url.pathname});
        if (context) context.error = cause;
        recordDiagnostic({
          code: cause.code ?? "RUNTIME_ERROR",
          message: cause.message,
          path: url.pathname,
          status: response.status,
        });
      },
    });
  }
  async function forward(req, res, url) {
    const context = trace.getStore();
    if (context) context.provider = "live";
    const body = isWrite(req.method) ? await rawBody(req) : undefined;
    const response = await live.request(url.pathname + url.search, {
      method: req.method,
      body,
      contentType: req.headers["content-type"] ?? "application/octet-stream",
      prefer: req.headers.prefer,
      ifMatch: req.headers["if-match"],
      ifNoneMatch: req.headers["if-none-match"],
    });
    let bytes = response.body;
    const headers = response.headers;
    if (headers["content-type"]?.includes("json"))
      try {
        const value = JSON.parse(bytes);
        res[auditResponse] = {
          rowCount: Array.isArray(value?.value)
            ? value.value.length
            : response.status < 400
              ? 1
              : undefined,
          error: value?.error,
        };
      } catch {}
    if (headers["content-type"]?.includes("text/html"))
      bytes = Buffer.from(
        bytes.toString("utf8").replaceAll(live.origin, localOrigin),
      );
    res.writeHead(response.status, { "cache-control": "no-store", ...headers });
    res.end(bytes);
  }
  // Local sign-in, sign-out and the session API (lib/auth-session.mjs; docs:
  // sim-administration.md "Sign-in, sign-out and sessions").
  const signInPersonas = () => personaReport().contacts.filter(contact => contact.active);
  const identityFor = (session) => trace.run({ auth: { identity: sessionIdentity(session) } }, currentIdentity);
  const describeSession = (session, extra = {}) => {
    const identity = identityFor(session);
    const configured = config().identity ?? {};
    return {
      signedIn: Boolean(identity.contactId),
      contactId: identity.contactId ?? null,
      name: identity.name ?? null,
      roles: identity.roles ?? [],
      roleIds: identity.roleIds ?? [],
      roleSource: identity.roleSource ?? "memberships",
      accountId: identity.accountId ?? null,
      defaultPersona: { contactId: configured.contactId ?? configured.id ?? null },
      // The external provider that established this session (null for local sign-in).
      provider: identity.contactId ? (externalSignIn?.sessionProvider(session?.provider) ?? null) : null,
      identityProvider: externalSignIn?.status() ?? { available: false, reason: "The local identity provider is not running." },
      ...extra,
    };
  };
  const sessionCookie = (session) => ({ name: authSessions.name, value: authSessions.value(session), path: "/", httpOnly: true, sameSite: "Lax" });
  async function sessionApi(req, res, url) {
    const relative = url.pathname.slice("/__sim/api/session".length).replace(/\/$/, "");
    const auth = trace.getStore()?.auth ?? {};
    if (req.method === "GET" && relative === "") {
      const requested = returnUrlParameter(url.searchParams);
      return json(res, 200, describeSession(auth.session, { cookie: { name: authSessions.name }, ...(requested ? { returnUrl: safeReturnUrl(requested) } : {}) }));
    }
    // External identities in the local data, with how each was recorded (lib/sign-in-flow.mjs).
    if (req.method === "GET" && relative === "/identities") return json(res, 200, externalSignIn.identities());
    if (req.method !== "POST" || !["/sign-in", "/sign-out", "/roles"].includes(relative)) throw error("Unknown session endpoint.", 404);
    if (req.headers["x-sim-csrf"] !== csrf) throw error("Missing simulator CSRF token.", 403);
    const body = await jsonBody(req);
    // A manual web-role override for this browser's signed-in session ({ roles: null } clears
    // it); it never creates a session.
    if (relative === "/roles") {
      if (!auth.session?.contactId) throw error("Sign this browser in through the portal first.", 409, "SESSION_NOT_SIGNED_IN");
      if (body?.roles !== null && (!Array.isArray(body?.roles) || body.roles.some((role) => typeof role !== "string")))
        throw error("roles must be an array of web-role names, or null to clear the override.");
      const known = new Set((appliedPermissionModel?.webRoles ?? []).map((role) => role.name));
      const unknown = (body.roles ?? []).filter((role) => !known.has(role));
      if (unknown.length) throw error(`Unknown web roles: ${unknown.join(", ")}`, 400, "UNKNOWN_WEB_ROLES");
      const { roles: _previous, ...base } = auth.session;
      const session = body.roles === null ? base : { ...base, roles: [...new Set(body.roles)] };
      return json(res, 200, describeSession(session, { cookie: sessionCookie(session) }), { "set-cookie": authSessions.cookie(session) });
    }
    const returnUrl = safeReturnUrl(body?.returnUrl);
    const session = relative === "/sign-in" ? signInSession(body?.contactId, { roles: body?.roles }) : { contactId: null };
    return json(res, 200, describeSession(session, { returnUrl, cookie: sessionCookie(session) }), { "set-cookie": authSessions.cookie(session) });
  }
  // A session for a contact (an active local contact) or, with roles, a manual role
  // override; shared by POST /_sim/api/session/sign-in and simulator.signIn().
  function signInSession(contactId, { roles } = {}) {
    if (typeof contactId !== "string" || !contactId.trim()) throw error("contactId must be a local contact ID.");
    if (roles !== undefined && (!Array.isArray(roles) || roles.some((role) => typeof role !== "string")))
      throw error("roles must be an array of web-role names.");
    if (roles !== undefined) return { contactId: contactId.trim(), roles: [...new Set(roles)] };
    const persona = signInPersonas().find((item) => personaKey(item.contactId) === personaKey(contactId.trim()));
    if (!persona) throw error("The selected persona must be an active local contact.", 404, "PERSONA_CONTACT_UNAVAILABLE");
    return { contactId: persona.contactId };
  }
  // The sign-in page renders inside the site's shell: website header and footer, and the
  // exported "Login" or "Sign In" site-marker page's title and copy when present.
  const SIGN_IN_MARKER = "<!--paqvilo-mirage-sign-in-content-->";
  let signInShell = null;
  const signInRenderer = () => {
    if (signInShell?.renderer === renderer) return signInShell;
    const exported = ["Login", "Sign In"]
      .map((name) => (portal.siteMarkers ?? []).find((marker) => marker.name === name))
      .filter(Boolean)
      .map((marker) => portal.pages.find((page) => page.id === marker.pageId))
      .find(Boolean);
    const html = (exported?.html ?? "") + SIGN_IN_MARKER;
    const page = {
      id: "paqvilo-mirage-sign-in",
      // The platform's account pages are not site map nodes (live sign-in: data-sitemap-state "/").
      outsideSitemap: true,
      name: exported?.name ?? "Sign in",
      // Outside the site map the layout title is the home page's (live sign-in: "Home").
      title: exported?.title ?? servicePages(portal).home?.title ?? "Sign in",
      url: "/SignIn/",
      parentId: exported?.parentId ?? servicePages(portal).home?.id ?? null,
      pageTemplateId: null,
      html,
      css: exported?.css ?? "",
      js: "",
      summary: "",
      formId: null,
      advancedFormId: null,
      listId: null,
      metadata: { adx_copy: html },
    };
    signInShell = { renderer, page, value: buildRenderer({ ...portal, pages: [page, ...portal.pages] }) };
    return signInShell;
  };
  const anonymousCanRead = (target) => {
    const page = exportedPageFor(portal, new URL(target, localOrigin).pathname);
    if (!page || page.id === servicePages(portal).profile?.id) return false;
    return pageAccess(portal, page, identityFor({ contactId: null })).allowed;
  };
  /** A platform account page (sign-in, invitation redemption) inside the site's shell. */
  async function renderAccountPage(req, res, url, { status = 200, content, route = "sign-in-page" }) {
    const shell = signInRenderer();
    const identity = currentIdentity();
    const rendered = await shell.value.renderPage(shell.page.url, {
      user: identity,
      request: { url: url.href, path: url.pathname, params: Object.fromEntries(url.searchParams), method: req.method },
    });
    for (const diagnostic of rendered.diagnostics ?? []) recordDiagnostic({ ...diagnostic, path: url.pathname });
    let html = String(rendered.html ?? "");
    const marker = html.indexOf(SIGN_IN_MARKER);
    // A content function is an account layout region (the sign-in page, lib/auth-session.mjs
    // signInContent): it replaces the page's main region and receives the rendered page copy.
    const main = marker >= 0 ? html.lastIndexOf('<main id="mainContent">', marker) : -1;
    if (typeof content === "function" && main >= 0) {
      const valueOpen = '<div class="xrm-attribute-value">';
      const valueStart = html.indexOf(valueOpen, main);
      const copy = valueStart >= 0 && valueStart < marker ? html.slice(valueStart + valueOpen.length, marker).trim() : "";
      const mainEnd = html.indexOf("</main>", marker);
      html = html.slice(0, main) + content(copy) + html.slice(mainEnd < 0 ? marker + SIGN_IN_MARKER.length : mainEnd + "</main>".length);
      // Account pages link the platform's account stylesheet after the platform styles (live head).
      html = html.replace(/<link href="[^"]*\/privatemode\.bundle-[^"]*"[^>]*>/,(link) => `${link}<link rel="stylesheet" href="/Areas/Account/css/account.css">`);
    } else {
      const markup = typeof content === "function" ? content("") : content;
      if (marker >= 0) html = html.replace(SIGN_IN_MARKER, () => markup);
      else if (/<body[^>]*>/i.test(html)) html = html.replace(/<body[^>]*>/i, (tag) => tag + markup);
      else html += markup;
    }
    if (rendered.isDocument !== false) {
      html = injectRuntimeDependencies(html, sourceDependencies);
      html = injectLocalHead(injectRuntimeCompatibility(html, sourceDependencies), localOverrides);
      html = injectRuntime(html, csrf, revision, identity, trace.getStore()?.spanId);
    }
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      ...PAGE_HEADERS,
      ...siteHeaders(portal, { confinement: confinementPolicy(), kind: "page" }),
      "x-sim-route": route,
    });
    return res.end(html);
  }
  // The platform's sign-in page: the site's external providers (lib/sign-in-flow.mjs) and,
  // when local sign-in is enabled or the site configures no provider, the local personas.
  async function renderSignIn(req, res, url, { status = 200, returnUrl = "/", error: problem = null, invitationCode = null } = {}) {
    const flags = authenticationSettings(portal);
    const providers = externalSignIn?.signInProviders() ?? [];
    const showPersonas = flags.localLogin || !providers.length;
    const content = (copy) => signInContent({
      copy,
      registerTab: flags.registration && flags.openRegistration,
      redeemTab: flags.registration && flags.invitation && !invitationCode,
      personas: showPersonas ? signInPersonas() : [],
      personaCatalog: showPersonas ? personaReport() : null,
      personaReturnUrl: returnUrlParameter(url.searchParams) || status >= 400 ? returnUrl : null,
      providers,
      showPersonas,
      csrf,
      defaultContactId: personaKey(config().identity?.contactId ?? config().identity?.id) || null,
      returnUrl,
      anonymousUrl: anonymousCanRead(returnUrl) ? returnUrl : "/",
      invitationCode,
      redeemInvitation: providers.length > 0 && !invitationCode && flags.registration && flags.invitation,
      error: problem,
      title: signInRenderer().page.title,
    });
    return renderAccountPage(req, res, url, { status, content, route: "sign-in-page" });
  }
  async function signInForm(req) {
    const bytes = await rawBody(req);
    const type = String(req.headers["content-type"] ?? "application/x-www-form-urlencoded").split(";")[0].trim().toLowerCase();
    if (type === "application/json") {
      try {
        const value = bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      } catch {
        throw error("Request body must be valid JSON.");
      }
    }
    return Object.fromEntries(new URLSearchParams(bytes.toString("utf8")));
  }
  // The sign-in page and the local persona sign-in; sign-out and external sign-in are
  // answered earlier by lib/sign-in-flow.mjs.
  async function authenticate(req, res, url, route) {
    const requested = returnUrlParameter(url.searchParams);
    if (route.kind === "sign-in-post") {
      const form = await signInForm(req);
      const returnUrl = safeReturnUrl(form.ReturnUrl ?? form.returnUrl ?? requested);
      if (!authenticationSettings(portal).localLogin && externalSignIn?.signInProviders().length)
        return renderSignIn(req, res, url, {
          status: 400,
          returnUrl,
          error: "Local sign-in is turned off for this site (Authentication/Registration/LocalLoginEnabled is false): sign in with an external provider.",
        });
      if (form.personaKey) {
        if (form.__RequestVerificationToken !== csrf) throw error('Missing simulator CSRF token.',403);
        const result = await launchPersona({personaKey:form.personaKey,returnUrl:form.ReturnUrl ? personaStartPath(form.ReturnUrl, 'returnUrl') : undefined});
        res.writeHead(302,{location:result.url,'set-cookie':result.cookieHeader+'; Path=/; HttpOnly; SameSite=Lax','cache-control':'no-store'}); return res.end();
      }
      if (personaReport().enabled && form.__RequestVerificationToken !== csrf) throw error('Missing simulator CSRF token.',403);
      const contactId = typeof form.contactId === "string" ? form.contactId.trim() : "";
      const persona = personaKey(contactId) ? signInPersonas().find((item) => personaKey(item.contactId) === personaKey(contactId)) : null;
      if (!persona) return renderSignIn(req, res, url, { status: 400, returnUrl, error: "Choose an active local persona to sign in." });
      res.writeHead(302, { location: returnUrl, "set-cookie": authSessions.cookie({ contactId: persona.contactId }), "cache-control": "no-store", "x-sim-route": "sign-in" });
      return res.end();
    }
    const returnUrl = safeReturnUrl(requested);
    if (currentIdentity().contactId) {
      res.writeHead(302, { location: returnUrl, "cache-control": "no-store", "x-sim-route": "signed-in" });
      return res.end();
    }
    return renderSignIn(req, res, url, { returnUrl, invitationCode: url.searchParams.get("InvitationCode") || null });
  }
  externalSignIn = createExternalSignIn({
    portal: () => portal,
    origin: () => localOrigin,
    csrf,
    sessions: authSessions,
    store,
    personas: signInPersonas,
    personaCatalog: personaReport, identityProvider: {settings:providerSettings,assets:providerAssets},
    webRoles: () => appliedPermissionModel?.webRoles ?? [],
    identity: currentIdentity,
    audit,
    trace,
    diagnostic: recordDiagnostic,
    renderSignIn,
    renderPage: renderAccountPage,
    readBody: rawBody,
  });
  async function handle(req, res) {
    if (req.headers.host !== new URL(localOrigin).host)
      throw error("Invalid Host header.", 403);
    // The one cross-origin request a portal accepts: the identity provider's form post to
    // the reply URL (the local identity provider's origin only).
    if (req.headers.origin && req.headers.origin !== localOrigin && !externalSignIn?.acceptsOrigin(req))
      throw error("Cross-origin requests are not allowed.", 403);
    if (req.headers["sec-fetch-site"] === "cross-site" && isWrite(req.method))
      throw error("Cross-site writes are not allowed.", 403);
    // Both spellings expose the same origin-confined admin with identical CSRF checks.
    if (/^\/_sim(?:\/|\?|$)/.test(req.url)) req.url = req.url.replace(/^\/_sim/, "/__sim");
    const url = requestTargetUrl(req.url, localOrigin);
    if(req.headers['x-paqvilo-local-only']==='true'&&(config().mode==='live'||config().pageMode==='live'||(config().endpoints??[]).some(endpoint=>endpoint.enabled!==false&&endpoint.path===url.pathname&&endpoint.mode==='live')))
      throw error('This visitor requires local Mirage execution.',409,'LocalRuntimeRequired');
    if (frameReadiness.handle(req, res, url)) return;
    // Mirage responses only; portal responses carry the HTTP/* site-setting headers.
    if (url.pathname === "/__sim" || url.pathname.startsWith("/__sim/") || url.pathname.startsWith("/__sim-"))
      res.setHeader("X-Content-Type-Options", "nosniff");
    // Power Pages resolves application-relative links even when authored inside
    // JavaScript. Normalize the app-relative path before ordinary routing.
    if (
      ["GET", "HEAD"].includes(req.method) &&
      /^\/(?:~|%7e)\//i.test(url.pathname)
    ) {
      const target = url.pathname.replace(/^\/(?:~|%7e)\/+/i, "/") + url.search;
      res.writeHead(302, { location: target, "cache-control": "no-store" });
      return res.end();
    }
    // Endpoints contributed by the data packs serving this portal
    // (lib/extensions.mjs); the runtime itself defines none.
    for (const endpoint of packEndpointList) {
      const match = endpoint.pattern.exec(url.pathname);
      if (!match) continue;
      if (!endpoint.methods.includes(req.method))
        throw error(`${endpoint.id} requires ${endpoint.methods.join(" or ")}.`, 405);
      const identity = currentIdentity();
      return endpoint.handle({
        req,
        res,
        url,
        match,
        mode: config().mode,
        identity,
        read: (entity, id) => readProvider.get(entity, id, identity),
        error,
        audit: (entity, rowCount) => {
          res[auditResponse] = { entity, rowCount };
        },
      });
    }
    const formRoute =
      /^\/__sim\/forms\/(entityform|webform)\/([\w-]+)\/submit$/.exec(
        url.pathname,
      );
    if (formRoute) {
      if (req.method !== "POST")
        throw error("Native form submission requires POST.", 405);
      if (req.headers.__requestverificationtoken !== csrf)
        throw error("Missing portal verification token.", 403);
      const body = await jsonBody(req);
      const formIdentity = currentIdentity();
      // An anonymous visitor's advanced form session belongs to its browser session: the
      // first submission without a visitor cookie starts one (lib/visitor-session.mjs).
      let visitor = trace.getStore()?.visitor ?? null;
      if (formRoute[1] === "webform" && !webFormSessionOwner(formIdentity, visitor)) {
        const started = newVisitor(visitorName());
        visitor = started.id;
        res.setHeader("set-cookie", started.cookie);
      }
      const pageTarget = new URL(typeof body?.pageUrl === "string" && body.pageUrl.startsWith("/") ? body.pageUrl : "/", localOrigin);
      return change(async () => {
        const result = await submitPortalForm(
          formRoute[1],
          formRoute[2],
          body,
          formSubmissionOptions(formIdentity, visitor, pageTarget),
        );
        return json(
          res,
          result.operation === "create" ? 201 : 200,
          {
            recordId: result.recordId,
            entity: result.entity,
            operation: result.operation,
            stepId: result.stepId,
            sessionId: result.sessionId,
            name: result.name,
            outcome: result.outcome,
          },
          result.recordId ? { entityid: result.recordId } : {},
        );
      });
    }
    // Browser sign-in sessions : GET /__sim/api/session, POST .../sign-in, .../sign-out.
    if (/^\/__sim\/api\/session(?:\/|$)/.test(url.pathname)) return sessionApi(req, res, url);
    if (url.pathname.startsWith("/__sim/api")) return admin(req, res, url);
    if (url.pathname === "/__sim/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: ready\ndata: ${revision}\n\n`);
      events.add(res);
      // Administrators opt into the runtime log channel; portal pages only receive reloads.
      const logs = (url.searchParams.get("channels") ?? "").split(",").includes("logs");
      if (logs) {
        logClients.add(res);
        res.write(`event: log\ndata: ${JSON.stringify({ sequence: ++logSequence, type: "connected", time: new Date().toISOString(), level: "info", revision })}\n\n`);
      }
      req.on("close", () => {
        events.delete(res);
        logClients.delete(res);
      });
      return;
    }
    if (url.pathname === '/__sim/sign-in') {
      if (req.method === 'POST') {
        const body = await signInForm(req);
        if (body.__RequestVerificationToken !== csrf) throw error('Missing simulator CSRF token.',403);
        const result = await launchPersona({personaKey:body.personaKey,returnUrl:body.ReturnUrl});
        res.writeHead(302,{location:result.url,'set-cookie':result.cookieHeader+'; Path=/; HttpOnly; SameSite=Lax','cache-control':'no-store'});return res.end();
      }
      if (req.method !== 'GET') throw error('Method not allowed',405);
      const persona = findPersona(url.searchParams.get('persona'));
      const report = personaReport();
      const returnUrl = personaStartPath(url.searchParams.get('returnUrl') ?? persona.startPath ?? report.contexts.find(context=>context.id===persona.context)?.startPath ?? '/', url.searchParams.has('returnUrl') ? 'returnUrl' : 'Persona startPath');
      const { renderPersonaPicker } = await import('./lib/persona-picker-view.mjs');
      const content = '<link rel="stylesheet" href="/__sim/persona-picker.css"><h1>Local persona sign-in</h1><p>Review the persona and sign in. This changes this browser’s local session only.</p><form method="post" action="/_sim/sign-in"><input type="hidden" name="__RequestVerificationToken" value="'+csrf+'"><input type="hidden" name="ReturnUrl" value="'+escaped(returnUrl)+'">'+renderPersonaPicker({...report,personas:[persona],other:[],total:1,groups:report.groups.filter(group=>group.id===persona.group).map(group=>({...group,count:1}))},{mode:'signin'})+'</form>';
      return renderAccountPage(req,res,url,{status:200,content,route:'persona-shortcut'});
    }
    if (url.pathname === "/__sim" || url.pathname === "/__sim/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      });
      return res.end(await fs.readFile(path.join(ROOT, "admin/index.html")));
    }
    if (['/__sim/persona-search.mjs','/__sim/persona-picker-view.mjs'].includes(url.pathname)) {
      res.writeHead(200, {'content-type':mime(url.pathname)}); return res.end(await fs.readFile(path.join(ROOT,'lib',path.basename(url.pathname))));
    }
    if (["/__sim/app.mjs", "/__sim/style.css", '/__sim/persona-picker.mjs', '/__sim/persona-picker.css', '/__sim/persona-manager.mjs'].includes(url.pathname)) {
      res.writeHead(200, { "content-type": mime(url.pathname) });
      return res.end(
        await fs.readFile(
          path.join(ROOT, "admin", path.basename(url.pathname)),
        ),
      );
    }
    if (
      /^\/__sim\/evidence\/(live|local|difference)\.png$/.test(url.pathname) &&
      evidenceDir
    ) {
      let bytes;
      try {
        bytes = await fs.readFile(
          path.join(evidenceDir, path.basename(url.pathname)),
        );
      } catch {
        throw error("Evidence image is unavailable.", 404);
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
      return res.end(bytes);
    }
    if (/^\/__sim(?:\/|$)/.test(url.pathname))
      throw error("Simulator resource not found.", 404);
    if (url.pathname === "/_layout/tokenhtml") {
      // Native: a self-closing hidden input plus the anti-forgery cookie token, with the page
      // headers the platform sends on it (lib/response-headers.mjs tokenHtmlHeaders).
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...tokenHtmlHeaders(portal, { confinement: confinementPolicy() }),
        "set-cookie": antiForgeryCookie(csrf),
      });
      return res.end(
        `<input name="__RequestVerificationToken" type="hidden" value="${csrf}" />`,
      );
    }
    const endpoint = (config().endpoints ?? []).find(
      (e) =>
        e.enabled !== false &&
        e.path === url.pathname &&
        (!e.method ||
          e.method === "*" ||
          e.method.toUpperCase() === req.method),
    );
    if (endpoint) {
      if (endpoint.mode === "live") return forward(req, res, url);
      if (
        isWrite(req.method) &&
        req.headers.__requestverificationtoken !== csrf
      )
        throw error("Missing portal verification token.", 403);
      if (endpoint.entity) {
        const shadow = new URL(url);
        shadow.pathname = `/_api/${endpoint.entity}`;
        return api(req, res, shadow, { forceLocal: true });
      }
      return json(res, Number(endpoint.status) || 200, endpoint.body ?? {});
    }
    // Source operations are discovered automatically; executing exported JavaScript
    // requires a trusted pack or an explicit local mode selected in Operations.
    if (url.pathname === '/__sim-static/pcf-host.js') {
      if (!['GET', 'HEAD'].includes(req.method)) throw error('PCF host resources require GET or HEAD.', 405);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : await fs.readFile(new URL('./lib/code-components-client.js', import.meta.url)));
    }
    if (url.pathname.startsWith('/__sim-static/pcf/')) {
      if (!['GET', 'HEAD'].includes(req.method)) throw error('PCF resources require GET or HEAD.', 405);
      const asset = codeComponents.assets.get(url.pathname);
      if (!asset) throw error('This PCF resource is not declared in a selected manifest.', 404);
      const real = await fs.realpath(asset.file);
      if (real !== asset.file || (await fs.stat(real)).size > 8 * 1024 * 1024) throw error('The declared PCF resource changed outside its source boundary.', 404);
      const type = asset.kind === 'code' ? 'text/javascript; charset=utf-8' : asset.kind === 'css' ? 'text/css; charset=utf-8' : asset.kind === 'resx' ? 'application/xml; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : await readLocalFile(real, { root: asset.root, maxBytes: 8 * 1024 * 1024 }));
    }
    const serverLogic = serverLogicName(url.pathname);
    if (serverLogic !== null) {
      if (operationPortal().serverLogics.some(record => record.name.toLowerCase() === serverLogic.toLowerCase()) && config().mode !== 'live') {
        try {
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) throw error('This method cannot execute server logic.', 405);
          if (isWrite(req.method) && req.headers.__requestverificationtoken !== csrf) throw error('Missing portal verification token.', 403, 'Forbidden');
          const raw = await executeServerLogic({ name: serverLogic, method: req.method, body: isWrite(req.method) ? (await rawBody(req)).toString('utf8') : '', query: Object.fromEntries(url.searchParams) });
          if (raw !== null) return json(res, 200, { requestId: randomUUID(), success: true, serverLogicName: serverLogic, data: raw, error: null }, { 'x-sim-route': 'server-logic-local', 'cache-control': 'no-store' });
        } catch (cause) {
          recordDiagnostic({ code: cause.code ?? 'SERVER_LOGIC_FAILED', name: serverLogic, path: url.pathname, message: cause.message });
          return json(res, cause.status ?? 500, { requestId: randomUUID(), success: false, serverLogicName: serverLogic, data: null, error: { code: cause.code ?? 'ServerLogicFailed', message: cause.message } }, { 'x-sim-route': 'server-logic-local', 'cache-control': 'no-store' });
        }
      }
      const answer = serverLogicUnsupported(operationPortal(), serverLogic, req.method);
      recordDiagnostic({ ...answer.diagnostic, path: url.pathname });
      return json(res, answer.status, answer.body, answer.headers);
    }
    const flow = operationPortal().cloudFlows.find(record => record.path && record.path.replace(/\/$/, '').toLowerCase() === url.pathname.replace(/\/$/, '').toLowerCase());
    const flowHandler = flow && registeredOperations.cloudFlows.get(flow.name.toLowerCase());
    if (flow && config().mode !== 'live') {
      if (req.method !== 'POST') throw error('Cloud-flow triggers require POST.', 405);
      if (req.headers.__requestverificationtoken !== csrf) throw error('Missing portal verification token.', 403);
      const identity = currentIdentity(); assertOperationRole(flow, identity);
      const item = operations().find(item => item.kind === 'cloud-flow' && item.id === flow.id);
      if (item.mode === 'placeholder') operationPlaceholder(item);
      if(item.mode==='disabled')throw error('This cloud flow is explicitly disabled locally.',503);
      const bytes = (await rawBody(req)).toString('utf8');
      let input;
      try {
        const parsed = String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(bytes)) : JSON.parse(bytes || '{}');
        input = typeof parsed.eventData === 'string' ? JSON.parse(parsed.eventData) : (parsed.eventData ?? parsed);
      } catch { throw error('Cloud-flow input must be valid JSON.', 400); }
      const context = { record: flow, workflows: operationWorkflows, input, identity, store, portal,serviceProfile:registeredOperations.flowIdentities.get(String(flow.processId??'').replace(/[{}]/g,'').toLowerCase()),steps:item.configuration?.steps,diagnostic:recordDiagnostic };
      if (item.mode === 'handler' && !flowHandler) operationPlaceholder(item);
      const answer = item.mode === 'mock' ? { status: item.configuration.status ?? 200, body: Object.hasOwn(item.configuration, 'body') ? item.configuration.body : {} }
        : item.mode === 'exported' ? await (async()=>{let failure;const value=await store.transact(()=>{try{return runExportedCloudFlow(context);}catch(error){failure=error;return null;}});if(failure)throw failure;return value;})()
        : await flowHandler({ ...context, runExportedCloudFlow: () => runExportedCloudFlow(context) });
      return json(res, answer.status ?? 200, Object.hasOwn(answer, 'body') ? answer.body : answer, { ...answer.headers, 'x-sim-route': 'cloud-flow-local', 'cache-control': 'no-store' });
    }
    // The platform's account stylesheet (account pages): local equivalent.
    if (/^\/areas\/account\/css\/account\.css$/i.test(url.pathname) && ["GET", "HEAD"].includes(req.method)) {
      const body = await fs.readFile(path.join(ROOT, "lib", "account-compat.css"));
      res.writeHead(200, { ...platformResourceHeaders("static", { pathname: url.pathname.toLowerCase(), body, contentType: "text/css; charset=utf-8", frameOptions: siteHeaders(portal)["x-frame-options"] }), "cache-control": "public,max-age=604800", "x-sim-resource-provider": "local-platform-equivalent" });
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    // The platform's stack ranking plug-in (form pages with stack rank cells): local equivalent.
    if (url.pathname === "/xrm-adx/js/jquery.stackranking.js" && ["GET", "HEAD"].includes(req.method)) {
      const body = await fs.readFile(path.join(ROOT, "lib", "stackranking-compat.js"));
      res.writeHead(200, { ...platformResourceHeaders("static", { pathname: url.pathname.toLowerCase(), body, contentType: "application/javascript; charset=utf-8", frameOptions: siteHeaders(portal)["x-frame-options"] }), "x-sim-resource-provider": "local-platform-equivalent" });
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    // Native quick view document (/_portal/quickform-template-path/{websiteId}): the platform
    // serves it through the layout master (live evidence): the layout frame of a document outside
    // the site map (lib/liquid.mjs serviceLayout), the platform chrome and the WebForms content_form
    // around the read-only entity form view (lib/platform.mjs renderQuickForm).
    const quickView = /^\/_portal\/quickform-template-path\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
    const quickSite = String(portal.website?.id ?? portal.website?.adx_websiteid ?? portal.website?.mspp_websiteid ?? "").replace(/[{}]/g, "").toLowerCase();
    if (quickView && config().pageMode !== "live" && quickView[1].toLowerCase() === quickSite) {
      try {
        if (!["GET", "HEAD"].includes(req.method)) throw error("Quick view forms require GET.", 405, "MethodNotAllowed");
        const quickIdentity = currentIdentity();
        const body = await renderQuickForm({ portal, store, readProvider, identity: quickIdentity, params: Object.fromEntries(url.searchParams), metadata: solutionMetadata, schemas: { ...solutionMetadata.componentSchemas, ...config().componentSchemas } });
        const layout = await renderer.serviceLayout(url.pathname + url.search, { user: quickIdentity });
        const resource = (entry) => renderShellResource(entry, "css", { localOnly: true });
        const bootstrapFile = portal.webFiles.find((f) => /\/bootstrap\.min\.css$/i.test(f.url ?? ""));
        const home = servicePages(portal).home ?? { id: null, url: "/", name: "", metadata: {} };
        const sourceStyles = await renderer.contentStylesheets(home, layout.context);
        const quickPlatform = platformShell({ variant: bootstrapVariant(portal.settings), profile: config().shellProfile ?? null, websiteId: quickSite, languageCode: layout.languageCode, bootstrap: sourceStyles.bootstrap || resource(bootstrapFile?.url ?? "/css/bootstrap.min.css"), renderStyles: (paths) => paths.map(resource).join("") });
        const styles = quickPlatform.headStart + quickPlatform.remaining.stylesheets.map(resource).join("") + formContentStyles(sourceStyles.content, config().shellProfile) + layout.head + quickPlatform.headEnd;
        for (const item of formStyleDiagnostics(body, config().shellProfile)) recordDiagnostic({ ...item, path: url.pathname });
        // The form posts back to the document's own path (./{websiteId}?query); only the entity form view script loads.
        const form = webFormsForm({ id: "content_form", action: `./${quickSite}${url.search}`, content: body, validators: true, formScriptPaths: ["/xrm-adx/js/crmentityformview.js"], variant: quickPlatform.variant });
        const document = `<!doctype html>${layout.html}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>${layout.title}</title>${styles}</head>${layout.body}${quickPlatform.bodyOpen}${layout.chrome}${antiForgeryHolder(`/_portal/${quickSite}/Layout/GetAntiForgeryToken`)}${quickPlatform.bodyStart}<div id="content-container" class="container quickform"><div id="content">${form}</div></div>${quickPlatform.afterContent}${quickPlatform.afterFooter}</body></html>`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...PAGE_HEADERS, "x-frame-options": siteHeaders(portal)["x-frame-options"] });
        return res.end(req.method === "HEAD" ? undefined : frameReadiness.decorate(injectLocalHead(document, localOverrides), { path: url.pathname, observed: config().observed ?? portal.observed }));
      } catch (cause) {
        res.writeHead(cause.status ?? 500, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(`<!doctype html><title>Quick view</title><p role="alert">${escaped(cause.message)}</p>`);
      }
    }
    if (await handleNativeService(req, res, url, { portal, store, readProvider, identity: currentIdentity(), csrf, config: config(), schemas: { ...solutionMetadata.componentSchemas, ...config().componentSchemas }, metadata: solutionMetadata, compat: localOverrides.compat, live, liveMapping, change, origin: localOrigin, cache, recordDiagnostic, decorateDocument: html => frameReadiness.decorate(injectLocalHead(html, localOverrides), { path: url.pathname, observed: config().observed ?? portal.observed }), formStyles: async target => { const home = servicePages(portal).home ?? { id: null, url: "/", name: "", metadata: {} }; return renderer.contentStylesheets(home, renderer.contextForPage(home, target, { user: currentIdentity() })); }, renderLiquid: (source, ctx) => renderer.renderString(source, ctx), serviceLayout: (target) => renderer.serviceLayout(target, { user: currentIdentity() }), pageContext: (target) => renderer.contextForPage(servicePages(portal).home ?? { id: "service", url: "/", name: "", title: "", metadata: {} }, target, { user: currentIdentity() }) })) return;
    if (url.pathname.startsWith("/_api/")) return api(req, res, url);
    if (config().pageMode === "live") return forward(req, res, url);
    // Routing and sign-in : repeated slashes collapse before resolution (portal
    // navigation builds "../" + "/page" links and Power Pages resolves them); a website language code
    // prefix is removed with a 302; the local sign-in and sign-out routes answer here.
    if (url.pathname.includes("//")) url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    const language = languageRoute(portal, url, req.method);
    if (language?.kind === "redirect") {
      // The platform's language redirect carries its page caching headers (live 302 to /SignIn).
      const { vary: _languageVary, ...languageHeaders } = PAGE_HEADERS;
      res.writeHead(language.status, { location: language.location, "content-type": "text/html; charset=utf-8", ...languageHeaders, "x-frame-options": siteHeaders(portal)["x-frame-options"], "x-sim-route": "language" });
      return res.end();
    }
    if (language?.kind === "rewrite") url.pathname = language.pathname;
    // /Register is the platform's invitation redemption page (the sign-in page's "Redeem
    // invitation" tab); locally it is the RedeemInvitation route.
    if (/^\/register\/?$/i.test(url.pathname) && !exportedPageFor(portal, url.pathname)) {
      const back = returnUrlParameter(url.searchParams);
      url.pathname = "/Account/Login/RedeemInvitation";
      url.search = back ? `?ReturnUrl=${encodeURIComponent(back)}` : "";
    }
    // External sign-in: ExternalLogin, the provider's response at the reply URL,
    // ExternalLoginCallback, RedeemInvitation, LogOff and the default-provider redirect.
    if (await externalSignIn.route(req, res, url, { language: language?.code ?? null })) return;
    const signInRoute = authRoute(url.pathname, req.method, { loginPath: loginPath(portal) });
    if (signInRoute) return authenticate(req, res, url, signInRoute);
    let formParams = {};
    let nativeEntries = null;
    let nativeFiles = [];
    const nativePostbackEnabled = nativeFormTransport(config().observed ?? portal.observed) === 'postback';
    const postedPage =
      req.method === "POST" &&
      portal.pages.find(
        (page) =>
          normalizePortalPath(page.url) === normalizePortalPath(url.pathname),
      );
    const postedTemplate =
      postedPage &&
      portal.pageTemplates.find(
        (template) => template.id === postedPage.pageTemplateId,
      );
    // Exported Liquid AJAX pages often use POST for DataTables filters. Rendering
    // those pages is a read operation; record mutations remain on the Web API.
    if (postedPage && (postedTemplate?.useHeaderFooter === false || nativePostbackEnabled)) {
      const bytes = await rawBody(req);
      const contentType = (
        req.headers["content-type"] ?? "application/x-www-form-urlencoded"
      )
        .split(";")[0]
        .trim()
        .toLowerCase();
      // A WebForms page whose form carries a file input posts multipart/form-data (live
      // item-edit captures); its text controls decode like the URL-encoded postback.
      const multipart = nativePostbackEnabled && contentType === "multipart/form-data" ? await multipartControls(bytes, req.headers["content-type"]) : null;
      if (contentType === "application/x-www-form-urlencoded" || multipart) {
        const controls = multipart ?? new URLSearchParams(bytes.toString('utf8'));
        if (nativePostbackEnabled && controls.has('__EVENTTARGET')) {
          const tokens = controls.getAll('__RequestVerificationToken');
          if (tokens.length !== 1 || tokens[0] !== csrf) throw error('Missing portal verification token.', 403);
          nativeEntries = [...controls];
          nativeFiles = controls.files ?? [];
          const context = trace.getStore();
          // An auto-generated step form's posted __VIEWSTATE names the tab the page showed and the
          // earlier tabs' values: the page renders that tab first so the postback decodes against it.
          const carried = decodeNativeViewState(controls.get('__VIEWSTATE'));
          if (context && carried) context.nativePostbackState = { kind: 'entityform', formId: carried.form, autoStep: carried.autoStep, values: carried.values, outcome: { type: 'none' } };
          if (context && !context.visitor && !webFormSessionOwner(currentIdentity())) {
            const started = newVisitor(visitorName());
            context.visitor = started.id;
            res.setHeader('set-cookie', started.cookie);
          }
        } else formParams = Object.fromEntries(controls);
      }
      else if (contentType === "application/json") {
        try {
          formParams = bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
        } catch {
          throw error("Request body must be valid JSON.");
        }
        if (
          !formParams ||
          Array.isArray(formParams) ||
          typeof formParams !== "object" ||
          Object.values(formParams).some(
            (value) => value !== null && typeof value === "object",
          )
        )
          throw error("Liquid request parameters must be scalar values.");
      } else
        throw error(
          "Liquid page POST requires URL-encoded or JSON parameters.",
          415,
        );
      if (nativePostbackEnabled && postedTemplate?.useHeaderFooter !== false && !nativeEntries)
        throw error('Native form postback target required.', 400, 'InvalidNativePostback');
    } else if (nativePostbackEnabled && req.method === 'POST' && /^\/_portal\/modal-form-template-path(?:\/[^/]+)?\/?$/i.test(url.pathname)) {
      if (!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) throw error('Native form postback requires URLencoded controls.', 415);
      const controls = new URLSearchParams((await rawBody(req)).toString('utf8'));
      const tokens = controls.getAll('__RequestVerificationToken');
      if (tokens.length !== 1 || tokens[0] !== csrf) throw error('Missing portal verification token.', 403);
      nativeEntries = [...controls];
    } else if (!["GET", "HEAD"].includes(req.method))
      throw error("Use the local Web API for writes.", 405);
    if (
      /^\/_portal\/modal-form-template-path(?:\/[^/]+)?\/?$/i.test(url.pathname)
    ) {
      const normalizeId = (value) =>
        String(value ?? "")
          .replace(/[{}]/g, "")
          .toLowerCase();
      let websiteSegment;
      try {
        websiteSegment = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      } catch {
        throw error("Malformed modal website identifier.");
      }
      const websiteId = normalizeId(websiteSegment);
      if (
        websiteId &&
        websiteId !== "00000000-0000-0000-0000-000000000000" &&
        websiteId !==
          normalizeId(
            portal.website.id ??
              portal.website.adx_websiteid ??
              portal.website.mspp_websiteid,
          )
      )
        throw error("The modal website is not exported by this portal.", 404);
      const requestedForm =
        url.searchParams.get("entityformid") ??
        url.searchParams.get("entityform");
      const definition = portal.forms.find(
        (form) => normalizeId(form.id) === normalizeId(requestedForm),
      );
      if (!requestedForm || !definition)
        throw error("An exported entityformid is required.", 404);
      const requestedPage = url.searchParams.get("pageid");
      const explicitPage = requestedPage
        ? portal.pages.find(
            (page) => normalizeId(page.id) === normalizeId(requestedPage),
          )
        : null;
      if (requestedPage && !explicitPage)
        throw error("The modal parent page is not exported.", 404);
      const formIdentity = currentIdentity();
      if (explicitPage) {
        const access = pageAccess(portal, explicitPage, formIdentity);
        if (!access.allowed)
          throw error(
            access.diagnostics?.[0]?.message || "Page access denied.",
            access.status ?? 403,
            access.code,
          );
      }
      const page = explicitPage ?? {
        id: null,
        parentId: null,
        url: url.pathname,
        name: "Portal form",
        title: "Portal form",
        metadata: {},
      };
      const context = renderer.contextForPage(page, url.pathname + url.search, {
        user: formIdentity,
        languageCode: language?.code ?? null,
      });
      if (!explicitPage) {
        context.page = null;
        context.sitemap.current = null;
      }
      const collected = [];
      const renderModalForm = () => renderComponent("entityform", definition.id, context, {
        portal,
        store,
        readProvider,
        args: { id: definition.id },
        metadata: solutionMetadata,
        config: config(),
        modal: true,
        observed: config().observed ?? portal.observed,
        onNativePostbackDescriptor: nativePostbackEnabled ? item => collected.push(item) : null,
        nativePostbackState: trace.getStore()?.nativePostbackState,
        codeComponent: spec => renderCodeComponent({ ...spec, portal, catalog: codeComponents, metadata: solutionMetadata, language: context?.__language ?? portal.language, identity: formIdentity, mappings: store.snapshot({ sections: ['mappings'] }).mappings, diagnostic: entry => recordDiagnostic({ ...entry, path: url.pathname }) }),
        diagnostic: (entry) => recordDiagnostic({ ...entry, path: url.pathname }),
        sourceDependencies,
        richTextCompatibility: richTextCompatibility(),
        managedControls:
          config().managedControls ?? config().shellProfile?.managedControls,
        schemas: {
          ...solutionMetadata.componentSchemas,
          ...config().componentSchemas,
        },
        renderLiquid: (source, ctx) => renderer.renderString(source, ctx),
      });
      let html = await renderModalForm();
      if (nativeEntries) {
        const submission = resolveNativeFormSubmission(nativeEntries, collected, url.href);
        let response;
        try {
          const { result, context } = await change(() => submitNativePostback(nativeEntries, collected, { ...formSubmissionOptions(formIdentity, trace.getStore()?.visitor, url), attachments: nativeFiles }));
          response = nativePostbackResponse({ result, context, values: submission.body.values });
        } catch (cause) {
          response = nativePostbackResponse({ error: cause, context: submission.context, values: submission.body.values, observed: config().observed ?? portal.observed });
          trace.getStore().error = cause;
          recordDiagnostic({ code: cause.code ?? 'FORM_SAVE_FAILED', message: cause.message, path: url.pathname });
        }
        if (response.location) {
          res.writeHead(response.status, { location: response.location, 'cache-control': 'no-store' });
          return res.end();
        }
        trace.getStore().nativePostbackState = response.state;
        html = await renderModalForm();
        // Form.aspx registers a startup script after ItemSaved: the grid that opened the dialog
        // closes it on "Success"; a lookup's create dialog (?lookup=) receives the saved record.
        if (response.state?.outcome && response.state.outcome.type !== 'error' && !response.state.validationErrors) {
          const message = url.searchParams.get('lookup') ? JSON.stringify({ type: 'Success', name: response.state.savedName ?? '', id: response.state.savedId ?? null }) : 'Success';
          html += `<script type="text/javascript">window.parent.postMessage(${JSON.stringify(message)}, "*");</script>`;
        }
      }
      const resource = (entry, type) =>
        renderShellResource(entry, type, { localOnly: true });
      // Native modal document: the platform bundles in the layout's order with
      // the WebForms resources inside content_form (lib/platform-manifest.mjs). Without a
      // capture the Bootstrap slot is the site's bootstrap.min.css web file, else the
      // platform's /css/bootstrap.min.css.
      const bootstrapFile = portal.webFiles.find((f) => /\/bootstrap\.min\.css$/i.test(f.url));
      const sourceStyles = await renderer.contentStylesheets(explicitPage ?? servicePages(portal).home ?? page, context);
      const modalPlatform = platformShell({
        variant: bootstrapVariant(portal.settings),
        profile: config().shellProfile ?? null,
        websiteId: portal.website.id ?? portal.website.adx_websiteid ?? portal.website.mspp_websiteid,
        languageCode: context.website?.selected_language?.code ?? "en-US",
        bootstrap: sourceStyles.bootstrap || resource(bootstrapFile?.url ?? "/css/bootstrap.min.css", "css"),
        renderStyles: (paths) => paths.map((p) => resource(p, "css")).join(""),
      });
      const remaining = modalPlatform.remaining;
      const styles = remaining.stylesheets.map((p) => resource(p, "css")).join("") + formContentStyles(sourceStyles.content, config().shellProfile);
      const configuredHeadScripts = [...remaining.headScripts, ...remaining.beforeContentScripts];
      const headScripts = configuredHeadScripts.map((p) => resource(p, "js")).join("");
      const aspNetScripts = remaining.bodyScripts.filter(isAspNetScript).map((p) => resource(p, "js")).join("");
      const bodyScripts = [...remaining.bodyScripts.filter((p) => !isAspNetScript(p)), ...remaining.afterFooterScripts]
        .map((p) => resource(p, "js"))
        .join("");
      // The platform's page caching headers (live modal document response).
      const headers = {
        "content-type": "text/html; charset=utf-8",
        ...PAGE_HEADERS,
      };
      Object.assign(headers, siteHeaders(portal, { confinement: confinementPolicy(), kind: "page" }));
      res.writeHead(200, headers);
      // Native modal form page (Form.aspx): content_form wraps the static
      // EntityFormControl; its empty anti-forgery holder uses the portal-scoped URL.
      // The platform serves it through the layout master (live evidence): the layout frame of a
      // document outside the site map (lib/liquid.mjs serviceLayout) and the platform chrome.
      const scopedSite = normalizeId(portal.website.id ?? portal.website.adx_websiteid ?? portal.website.mspp_websiteid);
      const layout = await renderer.serviceLayout(url.pathname + url.search, { user: formIdentity, languageCode: language?.code ?? null });
      const document = injectRuntimeCompatibility(
        `<!doctype html>${layout.html}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>${layout.title}</title>${modalPlatform.headStart}${styles}${headScripts}${layout.head}${modalPlatform.headEnd}</head>${layout.body}${modalPlatform.bodyOpen}${layout.chrome}${antiForgeryHolder(`/_portal/${scopedSite}/Layout/GetAntiForgeryToken`)}${modalPlatform.bodyStart}<div id="content-container" class="container wrapper-body" role="main"><div id="content"><div id="mainContent">${webFormsForm({ id: "content_form", action: url.pathname + url.search, content: html, aspNetScripts })}</div></div></div>${modalPlatform.afterContent}${bodyScripts}${modalPlatform.afterFooter}</body></html>`,
        sourceDependencies, configuredHeadScripts,
      );
      for (const item of formStyleDiagnostics(document, config().shellProfile)) recordDiagnostic({ ...item, path: url.pathname });
      return res.end(
        injectRuntime(
          frameReadiness.decorate(injectLocalHead(document, localOverrides), { path: url.pathname, observed: config().observed ?? portal.observed }),
          csrf,
          revision,
          formIdentity,
          trace.getStore()?.spanId,
        ),
      );
    }
    const localHeadAsset = localOverrides.assets.find(asset => asset.url === url.pathname);
    if (localHeadAsset && ['GET', 'HEAD'].includes(req.method)) {
      const body = await readLocalFile(localHeadAsset.file, { root: localHeadAsset.root, maxBytes: 8 * 1024 * 1024 });
      res.writeHead(200, { 'content-type': localHeadAsset.kind === 'scripts' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-store', 'x-sim-local-only': 'head' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const localRuntimeAssets = new Map([
      ["/__sim-static/vendor/jquery.min.js", createRequire(import.meta.url).resolve('jquery/dist/jquery.min.js')],
      ["/__sim-static/vendor/moment.min.js", createRequire(import.meta.url).resolve('moment/min/moment.min.js')],
      ["/__sim-static/vendor/datetimepicker-compat.js", new URL("./lib/datetimepicker-compat.js", import.meta.url)],
      ["/__sim-static/vendor/bootstrap-plugins-compat.js", new URL("./lib/bootstrap-plugins-compat.js", import.meta.url)],
      ["/__sim-static/vendor/jqueryui-dialog-compat.js", new URL("./lib/jqueryui-dialog-compat.js", import.meta.url)],
      ["/__sim-static/vendor/date-format-compat.js", new URL("./lib/date-format-compat.js", import.meta.url)],
      ["/__sim-static/vendor/footer-spacing-compat.js", new URL("./lib/footer-spacing-compat.js", import.meta.url)],
    ]);
    const fontName = /^\/fonts\/(glyphicons-halflings-regular\.(?:eot|svg|ttf|woff2?))$/i.exec(url.pathname)?.[1];
    const fontRuntimeAsset = fontName
      ? new URL(`./lib/bootstrap-fonts/${fontName}`, import.meta.url)
      : null;
    const runtimeAsset = localRuntimeAssets.get(url.pathname) ??
      (sourceDependencies.jqueryUiDialog && /^\/xrm-adx\/js\/jquery-ui(?:-[\d.]+)?(?:\.min)?\.js$/i.test(url.pathname)
        ? new URL("./lib/jqueryui-dialog-compat.js", import.meta.url)
        : fontRuntimeAsset);
    if (runtimeAsset) {
      if (!["GET", "HEAD"].includes(req.method))
        throw error("Local compatibility assets require GET or HEAD.", 405);
      const body = await fs.readFile(runtimeAsset);
      const fontMime = fontName?.endsWith(".woff2") ? "font/woff2" : fontName?.endsWith(".woff") ? "font/woff" : fontName?.endsWith(".ttf") ? "font/ttf" : fontName?.endsWith(".eot") ? "application/vnd.ms-fontobject" : "image/svg+xml";
      res.writeHead(200, {
        "content-type": fontRuntimeAsset ? fontMime : "application/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "x-sim-resource-provider": "local-compatibility",
      });
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    // Absolute sign-in redirects use the local origin (handle() admits only its Host).
    const routeOptions = { origin: localOrigin };
    const key = normalizePortalPath(url.pathname);
    // A path ending with "/" is looked up as a page first (legacy slash rule); a web file
    // answers only when no page has that URL.
    const pageFirst = url.pathname.endsWith("/") && portal.pages.some((p) => normalizePortalPath(p.url) === key);
    const asset = pageFirst ? null : portal.webFiles.find(
      (f) => normalizePortalPath(f.url) === key,
    );
    // Routing : a denied web file follows the denied-page outcome below.
    const assetAccess = asset ? pageAccess(portal, asset, currentIdentity()) : null;
    const deniedRoute = assetAccess && !assetAccess.allowed ? deniedPageRoute(portal, url, currentIdentity(), assetAccess, routeOptions) : null;
    if (asset && !deniedRoute) {
      const root = await fs.realpath(portal.sourceDir),
        file = await fs.realpath(asset.file);
      const relative = path.relative(root, file);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw error("Asset escaped the export directory.", 403);
      // Web file headers as online (lib/response-headers.mjs): charset on every type, the
      // record's disposition, platform caching, ETag with 304, HTTP/* settings.
      const sendFile = (body, contentType, extra = {}) => {
        const headers = {
          ...siteHeaders(portal, { confinement: confinementPolicy(), kind: "webFile" }),
          ...webFileHeaders({
            body,
            contentType,
            fileName: asset.metadata?.filename ?? asset.metadata?._attachment?.name ?? path.basename(file),
            caching: store.state.settings?.webFileCaching === "revalidate" ? "revalidate" : "platform",
            disposition: webFileDisposition(asset.metadata),
            mimeCharset: portal.observed?.webFileMimeCharset,
          }),
          ...extra,
        };
        res.writeHead(notModified(req.headers, headers) ? 304 : 200, headers);
        return res.end(notModified(req.headers, headers) ? undefined : body);
      };
      const stylesheet = await resolveObservedStylesheet(
        portal,
        asset,
        config().shellProfile?.observedStylesheets,
        { cache, origin: live.origin },
      );
      if (stylesheet.diagnostic) recordDiagnostic(stylesheet.diagnostic);
      if (stylesheet.body)
        return sendFile(stylesheet.body, stylesheet.contentType, {
          "x-sim-resource-provider": "observed-stylesheet",
          "x-sim-source-sha256": stylesheet.baseline.sourceSha256,
          "x-sim-observed-sha256": stylesheet.baseline.sha256,
        });
      const observed = await resolveRichTextConfiguration(
        portal,
        asset,
        config().shellProfile?.richTextConfigurations,
        { cache, origin: live.origin },
      );
      if (observed.diagnostic)
        recordDiagnostic({ ...observed.diagnostic, path: asset.url });
      if (observed.body)
        return sendFile(observed.body, "application/json", {
          "content-type": "application/json",
          "x-sim-resource-provider": "observed-richtext-json",
          "x-sim-source-sha256": observed.baseline.sourceSha256,
          "x-sim-observed-sha256": observed.baseline.sha256,
        });
      return sendFile(await readLocalFile(file, { root, maxBytes: Number.MAX_SAFE_INTEGER }), asset.mimeType || mime(file));
    }
    if (cache && !deniedRoute) {
      const cached = await cache.get(url.pathname + url.search, {
        origin: live.origin,
      });
      if (cached) {
        res.writeHead(cached.status, {
          "cache-control": "no-cache",
          ...cached.headers,
        });
        return res.end(cached.body);
      }
    }
    // Routing (lib/redirects.mjs): page URLs end with "/" (case-insensitive);
    // the "Knowledge Article" site-marker route answers before redirects; unresolved
    // paths try redirects and the canonical slash (URL history only with
    // settings.urlHistoryRedirects = true) before the Page Not Found page (404);
    // denied pages redirect anonymous visitors to sign-in with the Access Denied page
    // as the body and render the Access Denied page (403) for signed-in visitors.
    const pageIdentity = currentIdentity();
    const exportedPage = deniedRoute ? null : portal.pages.find((p) => normalizePortalPath(p.url) === key && (url.pathname.endsWith("/") || key === "/"));
    const markerRoute = exportedPage || deniedRoute ? null : siteMarkerRoute(portal, url);
    const routedPage = exportedPage ?? markerRoute?.page ?? null;
    const access = routedPage ? pageAccess(portal, routedPage, pageIdentity) : null;
    // The Profile site-marker page requires a signed-in user (platform profile page).
    const profile = servicePages(portal).profile;
    const signInRequired = Boolean(routedPage && access?.allowed && profile && routedPage.id === profile.id && !pageIdentity?.contactId);
    const route = deniedRoute ?? (!routedPage ? resolveUnmatchedRoute(portal, url, { readable: (page) => pageAccess(portal, page, pageIdentity).allowed, urlHistory: store.state.settings?.urlHistoryRedirects === true }) : !access.allowed ? deniedPageRoute(portal, url, pageIdentity, access, routeOptions) : signInRequired ? deniedPageRoute(portal, url, pageIdentity, { code: "PROFILE_SIGN_IN_REQUIRED" }, routeOptions) : null);
    if (route?.kind === "redirect" && !route.page) {
      res.writeHead(route.status, { location: route.location, "cache-control": "no-store", "x-sim-route": route.source ?? "redirect" });
      return res.end();
    }
    if (route?.kind === "error") throw error(route.message, route.status, route.code);
    if (route) recordDiagnostic({ code: route.code ?? "PAGE_NOT_FOUND", path: url.pathname, message: `${route.message ? route.message + " " : ""}Rendered the ${route.page.name} page with HTTP ${route.status}.` });
    // Native evidence covers GET page-query validation. Other request methods
    // retain their existing handlers until their validation order is observed.
    const queryValidation = req.method === "GET"
      ? observedPageQueryValidation(url, config().observed ?? portal.observed)
      : null;
    if (queryValidation) throw error(queryValidation.message, queryValidation.status, queryValidation.code);
    const nativeContext = trace.getStore();
    if (nativeEntries && (route || !routedPage || !access?.allowed)) throw error('Native form page is not accessible.', 403);
    const renderCurrentPage = () => {
      if (nativeContext) nativeContext.nativePostbacks = [];
      return renderer.renderPage((route ? route.page.url : markerRoute ? markerRoute.page.url : url.pathname) + url.search, {
      user: pageIdentity,
      // The website language whose code the language route removed from the path .
      languageCode: language?.code ?? null,
      request: {
        url: url.href,
        path: url.pathname,
        params: { ...formParams, ...Object.fromEntries(url.searchParams) },
        method: req.method,
      },
      });
    };
    let rendered = await renderCurrentPage();
    if (nativeEntries) {
      const collected = nativeContext?.nativePostbacks ?? [];
      const submission = resolveNativeFormSubmission(nativeEntries, collected, url.href);
      let response;
      try {
        const { result, context } = await change(() => submitNativePostback(nativeEntries, collected, { ...formSubmissionOptions(pageIdentity, nativeContext?.visitor, url), attachments: nativeFiles }));
        response = nativePostbackResponse({ result, context, values: submission.body.values });
      } catch (cause) {
        response = nativePostbackResponse({ error: cause, context: submission.context, values: submission.body.values, observed: config().observed ?? portal.observed });
        nativeContext.error = cause;
        recordDiagnostic({ code: cause.code ?? 'FORM_SAVE_FAILED', message: cause.message, path: url.pathname });
      }
      if (response.location) {
        res.writeHead(response.status, { location: response.location, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end();
      }
      nativeContext.nativePostbackState = response.state;
      rendered = await renderCurrentPage();
    }
    let html = typeof rendered === "string" ? rendered : rendered.html;
    for (const diagnostic of rendered.diagnostics ?? [])
      recordDiagnostic({ ...diagnostic, path: url.pathname });
    // A component that sends the visitor elsewhere (an advanced form that requires
    // authentication sends an anonymous visitor to sign in) answers for the whole page.
    const componentRedirect = (rendered.diagnostics ?? []).find((entry) => typeof entry.redirect === "string")?.redirect;
    if (componentRedirect) {
      res.writeHead(302, { location: componentRedirect, "cache-control": "no-store", "x-sim-route": "sign-in" });
      return res.end();
    }
    if (typeof html !== "string")
      throw error("Renderer produced no response.", 500);
    const contentType = rendered.contentType ?? "text/html; charset=utf-8";
    // Only HTML documents receive local runtime dependencies. Pages without the website
    // header/footer often return JSON or HTML fragments for the portal's own scripts;
    // the live portal serves their template output verbatim, so prepending scripts
    // would corrupt JSON.parse() and jQuery .load() consumers.
    const isDocument =
      contentType.includes("text/html") && (rendered.isDocument ?? isHtmlDocument(html));
    if (isDocument) {
      html = injectRuntimeDependencies(html, sourceDependencies);
      html = injectLocalHead(injectRuntimeCompatibility(html, sourceDependencies), localOverrides);
      for (const item of formStyleDiagnostics(html, config().shellProfile)) recordDiagnostic({ ...item, path: url.pathname });
      if (localOverrides.assets.length || Object.keys(localOverrides.compat).length) recordDiagnostic({ code: 'LOCAL_ONLY_OVERRIDES', severity: 'info', path: url.pathname, message: 'Project compat switches and local head additions are active.', localOverrides });
    }
    // Page headers: no-cache, no-store, must-revalidate and only the HTTP/* site-setting
    // headers; the loopback policy only with config.confinePortalPages (lib/response-headers.mjs).
    const headers = {
      "content-type": contentType,
      ...PAGE_HEADERS,
      ...siteHeaders(portal, { confinement: confinementPolicy(), kind: "page" }),
    };
    // A redirecting page answer has no Vary header (live sign-in redirect).
    if (route?.kind === "redirect") { delete headers.vary; Object.assign(headers, { location: route.location, "x-sim-route": route.source ?? "redirect" }); }
    // Local compatibility adapters in the document are reported here, not as page attributes;
    // their runtime modes are in window.__portalSimulation.compatibility.
    if (isDocument) {
      const adapters = [...new Set([...html.matchAll(/\/__sim-static\/([\w/.-]+)/g)]
        .map((match) => match[1].slice(match[1].lastIndexOf("/") + 1))
        .filter((name) => name.endsWith("-compat.js"))
        .map((name) => name.slice(0, -10)))];
      if (adapters.length) headers["x-sim-compatibility"] = adapters.join(", ");
    }
    res.writeHead(route?.status ?? rendered.status ?? 200, headers);
    res.end(
      isDocument
        ? injectRuntime(
            html,
            csrf,
            revision,
            pageIdentity,
            trace.getStore()?.spanId,
          )
        : html,
    );
  }
  const server = http.createServer((req, res) => {
    if(closing)return json(res,503,{error:{code:'SIMULATOR_CLOSING',message:'The local runtime is shutting down.'}},{'connection':'close'});
    if (/^\/_setup(?:\/|$)/.test(req.url?.split('?')[0] ?? '')) {
      setupHandler(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: { code: 'SETUP_FAILED', message: 'Setup request failed.' } }); });
      return;
    }
    const started = Date.now();
    let url;
    try {
      url = requestTargetUrl(req.url, "http://local.invalid");
    } catch {
      return json(res, 400, {
        error: { code: "INVALID_REQUEST", message: "Malformed request URL." },
      });
    }
    // /_sim is the same administration surface as /__sim: never audit it as a portal page.
    if (/^\/_sim(?:\/|$)/.test(url.pathname))
      url.pathname = url.pathname.replace(/^\/_sim/, "/__sim");
    // Browser sign-in session of this request (lib/auth-session.mjs).
    const auth = requestAuth(req, url);
    const cfg = config();
    const endpoint = (cfg.endpoints ?? []).find(
      (item) => item.enabled !== false && item.path === url.pathname,
    );
    const kind = url.pathname.startsWith("/__sim/forms/")
      ? "form"
      : url.pathname.startsWith("/_api/") ||
          url.pathname.startsWith("/__sim/artifacts/") ||
          endpoint
        ? "api"
        : "page";
    const tracked =
      !url.pathname.startsWith("/__sim/") || kind === "form" || kind === "api";
    const staticPath =
      /\.(?:js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|pdf|json)$/i.test(
        url.pathname,
      ) ||
      /^\/(?:resource|_pcfwebresource|webresources|_webresource)\//.test(
        url.pathname,
      );
    const parentHeader = req.headers["x-sim-parent-trace"];
    const parent =
      typeof parentHeader === "string" && /^[\da-f-]{36}$/i.test(parentHeader)
        ? audit.entries.find((item) => item.id === parentHeader)
        : null;
    const span =
      tracked && (!staticPath || kind !== "page")
        ? audit.begin({
            kind,
            method: req.method,
            path: url.pathname,
            query: url.searchParams,
            provider:
              endpoint?.mode ?? (kind === "page" ? cfg.pageMode : cfg.mode),
            identity: trace.run({ auth }, currentIdentity),
            entity: /^\/_api\/([\w]+)/.exec(url.pathname)?.[1],
            activeConfigurationPreset: cfg.activeExperiment,
            parentId: parent?.id,
            correlationId: parent?.correlationId,
          })
        : null;
    const context = {
      spanId: span?.id,
      correlationId: span?.correlationId,
      method: req.method,
      path: url.pathname,
      auth,
      localOnly: req.headers['x-paqvilo-local-only'] === 'true',
      visitor: readVisitor(req.headers.cookie, visitorName()),
    };
    if (span) res.setHeader("X-Sim-Trace-Id", span.id);
    res.on("close", () => {
      if (!res.writableFinished)
        span?.finish({
          status: 499,
          error: {
            code: "REQUEST_ABORTED",
            message: "The client closed the request before completion.",
          },
        });
    });
    res.on("finish", () => {
      span?.finish({
        status: res.statusCode,
        ...res[auditResponse],
        provider: context.provider,
        entity: context.entity,
        saveMs: context.saveMs,
        saveMode: context.saveMode,
        error: context.error ?? res[auditResponse]?.error,
        // Portal-shaped error bodies and the simulator's own code are both kept.
        portalError: res[auditResponse]?.error,
        simulatorCode: res.getHeader("x-sim-error-code"),
      });
      if (
        req.url.startsWith("/__sim") &&
        !req.url.startsWith("/__sim/forms/") &&
        !req.url.startsWith("/__sim/artifacts/")
      )
        return;
      requests.push({
        method: req.method,
        path: req.url.split("?")[0],
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
      if (requests.length > 300) requests.shift();
    });
    const invocation=trace
      .run(context, () => handle(req, res))
      .catch((err) => {
        context.error = err;
        if(err.details?.permissionDiagnostic)recordDiagnostic({...err.details.permissionDiagnostic,path:req.url?.split('?')[0]});
        // Administration API errors are answered to their caller; they are not portal runtime observations.
        if (!req.url?.startsWith("/__sim/api"))
          recordDiagnostic({
            code: err.code ?? "RUNTIME_ERROR",
            message: err.message,
            path: req.url?.split("?")[0],
          });
        if (res.headersSent) {
          res.end();
          return;
        }
        const status = err.status ?? err.statusCode ?? 500;
        if (
          req.url.startsWith("/_api/") ||
          req.url.startsWith("/__sim/api") ||
          req.url.startsWith("/__sim/forms/")
        )
          json(res, status, {
            error: {
              code: err.code ?? "SIMULATOR_ERROR",
              message: err.message,
              ...(req.url.startsWith("/__sim/forms/") && Array.isArray(err.details?.validationErrors) ? { validationErrors: err.details.validationErrors } : {}),
            },
            ...(req.url.startsWith('/__sim/forms/entityform/') && formWriteError(err, config().observed ?? portal.observed) ? { postback: formWriteError(err, config().observed ?? portal.observed) } : {}),
          });
        else {
          const presentation = observedPageErrorResponse({ method: req.method, error: err, observed: config().observed ?? portal.observed });
          if (presentation) {
            res.writeHead(presentation.status, presentation.headers);
            return res.end(presentation.body);
          }
          res.writeHead(status, { "content-type": "text/html; charset=utf-8",...(err.code==='REDIRECT_SITE_MARKER_NULL_REFERENCE'&&observed.siteMarkerRedirect==='null-reference'?{'cache-control':PAGE_CACHE_CONTROL}:{}) });
          res.end(
            `<!doctype html><title>Portal simulation diagnostic</title><main style="font:16px system-ui;max-width:900px;margin:50px auto"><h1>Portal rendering needs attention</h1><p>${escaped(err.message)}</p><p><a href="/__sim/">Open simulator admin</a></p></main>`,
          );
        }
      }).finally(()=>activeRequests.delete(invocation));
    activeRequests.add(invocation);
  });
  if (startupPreset.applied) await applySelectedPreset(preset);
  if (personaInstance) {
    const state = store.snapshot(); state.simulator ??= {};
    if (personaInstance.deploymentProfile !== undefined) state.simulator.deploymentProfilePin = personaInstance.deploymentProfile;
    const variables = {...state.simulator.environmentVariables};
    for (const [name,value] of Object.entries(personaInstance.environmentVariables ?? {})) {
      for (const existing of Object.keys(variables)) if (existing.toLowerCase() === name.toLowerCase()) delete variables[existing];
      Object.defineProperty(variables,name,{value,enumerable:true,configurable:true,writable:true});
    }
    state.simulator.environmentVariables = variables;
    state.simulator.portalOverrides = {...state.simulator.portalOverrides,
      settings:{...state.simulator.portalOverrides?.settings,...personaInstance.portalOverrides?.settings},
      snippets:{...state.simulator.portalOverrides?.snippets,...personaInstance.portalOverrides?.snippets}};
    state.simulator.mode='local'; state.simulator.pageMode='local'; state.simulator.live={enabled:false};
    await saveState(state);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, resolve);
  });
  localOrigin = `http://${host === "::1" ? "[::1]" : host}:${server.address().port}`;
  // The local identity provider: its own loopback port on the runtime's host, started with
  // the runtime and closed by close() (Ctrl+C, mirage stop, POST /_sim/api/shutdown).
  try {
    await externalSignIn.start({ host });
  } catch (cause) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw cause;
  }
  let reloadPromise = null,
    reloadRequested = false;
  const changedPaths = new Set();
  let watchedLayers = "";
  const layerSignature = () => JSON.stringify([(solutionData.layers ?? []).map((layer) => layer.dir), solutionMetadata.plugins?.sourceFiles ?? []]);
  async function reload() {
    if (closing) return;
    await settleCommittedWork(store,[triggerRunner,asyncPluginRunner]);
    if (closing) return;
    reloadRequested = true;
    if (reloadPromise) return reloadPromise;
    reloadPromise = (async () => {
      while (reloadRequested && !closing) {
        reloadRequested = false;
        const previous = {
          portal,
          sourcePortal,
          sourceDependencies,
          generatedPresets,
          solutionMetadata,
          solutionData,
          operationWorkflows,
          solutionOperations,
          codeComponents,
          fingerprint,
          renderer,
          activeProfiles,
        };
        try {
          const started = performance.now();
          const changed = [...changedPaths].sort();
          changedPaths.clear();
          activeProfiles = await loadDeploymentProfiles(profileConfig, config().deploymentProfilePin ?? null);
          sourcePortal = await importSource();
          if (requirePortalSource) assertPortalSource(sourcePortal);
          portal = applyPortalOverrides(sourcePortal, config().portalOverrides);
          sourceDependencies = { ...await discoverSourceDependencies(portal), compat: localOverrides.compat };
          await loadSolutions();
          generatedPresets = initialState(portal, bootstrapOptions()).presets;
          store.presetLibrary = generatedPresets;
          // Publish the new source fingerprint and renderer before the recompiled
          // state, so no status read pairs reloaded data with the old fingerprint.
          fingerprint = await calculateFingerprint();
          renderer = buildRenderer();
          await change(() => replaceCompiledState(store.snapshot()));
          diagnostics.length = 0;
          revision++;
          bootstrapTimings.lastReload = { at: new Date().toISOString(), durationMs: Math.round(performance.now() - started), changed: changed.slice(0, 50), changedCount: changed.length };
          recordDiagnostic({
            code: "SOURCES_RELOADED",
            severity: "info",
            revision,
            changed: changed.slice(0, 20),
            message: `Reloaded portal and solution sources (${changed.length} changed path(s)); mappings, schemas and the permission model were recompiled.`,
          });
          if (watch && watchedLayers !== layerSignature()) await restartWatcher();
          for (const event of events)
            event.write(`event: reload\ndata: ${revision}\n\n`);
        } catch (err) {
          portal = previous.portal;
          sourcePortal = previous.sourcePortal;
          sourceDependencies = previous.sourceDependencies;
          generatedPresets = previous.generatedPresets;
          store.presetLibrary = generatedPresets;
          solutionMetadata = previous.solutionMetadata;
          solutionData = previous.solutionData;
          operationWorkflows = previous.operationWorkflows;
          solutionOperations = previous.solutionOperations;
          codeComponents = previous.codeComponents;
          fingerprint = previous.fingerprint;
          renderer = previous.renderer;
          activeProfiles = previous.activeProfiles;
          recordDiagnostic({ code: "RELOAD_FAILED", message: err.message });
          throw err;
        }
      }
    })().finally(() => {
      reloadPromise = null;
    });
    return reloadPromise;
  }
  // Watch : the portal export plus only the table-metadata parts of each
  // solution layer (Entities, Other, OptionSets, environment variables); a change in
  // the set of layers restarts the watcher with the new layer list.
  async function restartWatcher() {
    if (closing) return;
    const previousWatcher = watcher;
    const layers = solutionData.layers ?? [];
    watchedLayers = layerSignature();
    clearTimeout(watcherTimer);
    const pluginSources = [...solutionMetadata.plugins?.sourceFiles ?? [], ...Object.values(profileConfig.profiles).flatMap(sources => Object.values(sources).flat())];
    const pluginSourceKeys = new Set(pluginSources.map(file => path.resolve(file).toLowerCase()));
    const ignoreSource = solutionWatchFilter({ sourceDir, roots: solutionRoots, layers, exclude: stateFile ? [path.dirname(path.resolve(stateFile))] : [] });
    watcher = chokidar.watch([sourceDir, ...solutionRoots, ...pluginSources], {
      ignoreInitial: true,
      ignored: (file, stats) => pluginSourceKeys.has(path.resolve(file).toLowerCase()) ? false : ignoreSource(file, stats),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    const watched = watcher;
    const watchReady = new Promise(resolve => {
      const settled = () => { watched.off('ready',settled); watched.off('error',settled); if(watcherReadyRelease === settled)watcherReadyRelease=null; resolve(); };
      watcherReadyRelease = settled;
      watched.once('ready',settled); watched.once('error',settled);
    });
    watcher.on("all", (_event, file) => {
      if (closing) return;
      if (file) changedPaths.add(file);
      clearTimeout(watcherTimer);
      watcherTimer = setTimeout(() => {
        if (!closing) reload().catch(() => {});
      }, 250);
    });
    watcher.on("error", (err) =>
      recordDiagnostic({ code: "WATCH_ERROR", message: err.message }),
    );
    await watchReady;
    await previousWatcher?.close();
  }
  if (watch) await restartWatcher();
  return {
    server,
    store,
    live,
    get portal() {
      return portal;
    },
    url: localOrigin,
    adminUrl: `${localOrigin}/__sim/`,
    setupUrl: `${localOrigin}/_setup/`,
    // The local identity provider of external sign-in: { available, origin, port, providers, ... }.
    get identityProvider() {
      return externalSignIn.status();
    },
    state: exposedState,
    applyPreset: (name) => change(() => applySelectedPreset(name)),
    // Sign-in for tools and tests that render portal routes as a persona :
    // { cookieHeader: "paqvilo-mirage-auth-<port>=…" for a Cookie request header, identity }.
    signIn: (contactId, options = {}) => {
      const session = signInSession(contactId, options);
      return { cookieHeader: `${authSessions.name}=${authSessions.value(session)}`, identity: describeSession(session) };
    },
    reload,
    close,
  };
}
