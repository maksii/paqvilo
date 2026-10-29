import {
  dataverseEnvironmentValue,
  liveDataverseSettings as composeLiveDataverseSettings,
} from './lib/live-dataverse-settings.mjs';
import { inspectionSummary } from '../lense/inspection-summary.mjs';
import { createRecordCapabilitiesSummary } from './lib/record-capabilities-summary.mjs';
import { statusResponseChunks } from './lib/status-response.mjs';
import {
  createRuntimeAdminRouter,
  ADMIN_CSP,
  adminAssetFile,
  adminAssetType,
  diagnosticsByCode,
} from './lib/runtime-admin.mjs';
import { hostnameOf } from './lib/dataverse-webhooks.mjs';
import { createDashboardRoutes, routes as DASHBOARD_ROUTES } from './lib/sim-dashboard-routes.mjs';
import { createPackRoutes, routes as PACK_ROUTES } from './lib/sim-pack-routes.mjs';
import {
  createEnvironmentRoutes,
  environmentVariableTable as sharedEnvironmentVariableTable,
  applyEnvironmentOverride,
  routes as ENVIRONMENT_ROUTES,
} from './lib/sim-environment-routes.mjs';
import { docsLinks } from './lib/docs-links.mjs';
import { simulationSettings, simulationReport } from './lib/simulation-settings.mjs';
import { createSimulationPersistence } from './lib/simulation-persistence.mjs';
import { dataverseOrganizationId } from './lib/dataverse-organization.mjs';
import { preserveOrganizationPresetSections } from './lib/organization-presets.mjs';
import { createModelDrivenRecordService, createModelDrivenWebApi } from './lib/dataverse-model-driven.mjs';
import { createStaffSessions, createStaffSessionHandler } from './lib/staff-session.mjs';
import { createDataverseAdmin } from './lib/dataverse-admin.mjs';
import { runtimeSettings } from './lib/runtime-config.mjs';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import {
  validatePersonaCatalog,
  mergePersonaCatalogs,
  resolvePersonaCatalog,
  personaContactId,
  personaStartPath,
} from './lib/persona-catalog.mjs';
import { identityProviderSettings, identityProviderAssets } from './lib/identity-provider-settings.mjs';
import { closestPersonaKeys } from './lib/persona-search.mjs';
import { createPersonaContexts } from './lib/persona-contexts.mjs';
import { personaContextSettings } from './lib/persona-context-settings.mjs';
import { StateStorage } from './lib/state-storage.mjs';
import { nativeRichTextReady } from './lib/richtext-readiness.mjs';
import { renderSettings } from './lib/render-settings.mjs';
import { createSetupHandler } from '../lense/setup/server.mjs';
import { parseExactJson, stringifyExactJson, isExactNumeric } from './lib/exact-numeric.mjs';
import {
  attachODataReaderDetails,
  attachODataJsonSource,
  odataInvalidJsonDetails,
} from './lib/webapi-error-details.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocalFile } from '../lense/local-file.mjs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AuditLog } from './lib/audit-log.mjs';
import { watchSources } from './lib/source-watcher.mjs';
import {
  resolveDeploymentProfiles,
  loadDeploymentProfiles,
  profileSelection,
  deploymentProfilesSummary,
} from './lib/deployment-profiles.mjs';
import {
  DataStore,
  parseFetchXml,
  resolvePreset,
  normalizeMockLiquidRecord,
  normalizeMockLiquidFetchXml,
} from './lib/data.mjs';
import { DATA_MODELS, importPortal, normalizePortalPath } from './lib/importer.mjs';
import { createPortalRenderer, renderShellResource } from './lib/liquid.mjs';
import { formContentStyles } from './lib/form-head.mjs';
import { emptyUnmappedLiquidFetchXml, observedLiquidEntityRead } from './lib/liquid-missing-data.mjs';
import { observedPageQueryValidation } from './lib/page-query-validation.mjs';
import { observedPageErrorResponse } from './lib/page-error-presentation.mjs';
import { initialState } from './lib/bootstrap.mjs';
import { contentPolicyDefaults as resolvePolicyDefaults } from './lib/content-policy-defaults.mjs';
import { withFileSourceMap, identityMapUrl } from '../lense/source-map.mjs';
import { runWithSourceDebugging } from './lib/source-debug.mjs';
import { refreshScriptProofLocations, scriptLineStarts } from './lib/render-provenance.mjs';
import { assetKind } from './lib/asset-type.mjs';
import { listPresets } from './lib/presets.mjs';
import {
  applyPortalOverrides,
  bindPortalEnvironment,
  portalOverrideEntries,
  validatePortalOverrides,
} from './lib/portal-overrides.mjs';
import { platformSettingEntries, validatePlatformOverrides } from './lib/platform-settings.mjs';
import { configurationPresetDiagnostics } from './lib/preset-registry.mjs';
import {
  experimentPresets,
  experimentId,
  validateExperiment,
  validateExperimentPresets,
  applyExperiment,
  configurationPresetReport,
  configurationPresetCollisions,
} from './lib/experiment-presets.mjs';
import { inspectPage } from './lib/page-resources.mjs';
import { enrichReference } from './enrich-reference.mjs';
import {
  discoverSourceDependencies,
  injectRuntimeDependencies,
  injectRuntimeCompatibility,
  isHtmlDocument,
} from './lib/source-dependencies.mjs';
import { resolveLocalOverrides, injectLocalHead } from './lib/local-overrides.mjs';
import { platformStylesStatus, formStyleDiagnostics } from './lib/platform-styles.mjs';
import { LiveBridge, normalizeLiveRecord } from './lib/live.mjs';
import { AssetCache } from './lib/asset-cache.mjs';
import { capturePortalShell } from './lib/shell-capture.mjs';
import { serverLogicName, serverLogicUnsupported } from './lib/server-logic.mjs';
import {
  assertOperationRole,
  assertServerLogicEnabled,
  runExportedServerLogic,
  runExportedCloudFlow,
  importOperationWorkflows,
  organizationCustomApi,
} from './lib/exported-operations.mjs';
import { createPortalAuthorization, portalAuthorizationModel } from './lib/portal-authorization.mjs';
import { createPortalDocumentService } from './lib/sharepoint-documents.mjs';
import { renderPortalSearchPage } from './lib/portal-search.mjs';
import {
  validateOperationOverrides,
  operationPlaceholder,
  importSolutionOperationSources,
  withSolutionOperations,
} from './lib/operation-catalogue.mjs';
import { importCodeComponents, renderCodeComponent } from './lib/code-components.mjs';
import { mergeShellProfile } from './lib/shell-profile.mjs';
import { captureRichTextAssets } from './lib/richtext-assets.mjs';
import { captureObservedSnippetComposition } from './lib/observed-snippet-composition.mjs';
import { captureObservedStylesheets, resolveObservedStylesheet } from './lib/observed-stylesheets.mjs';
import { resolveRichTextConfiguration, richTextConfigurationStatus } from './lib/richtext-config.mjs';
import { pageAccess } from './lib/page-access.mjs';
import { cachedImplementationSourceFingerprint, observedEvidence, implementationEvidence } from './lib/evidence.mjs';
import { verificationWitness, verificationTableSelection } from './lib/verification-witness.mjs';
import { importSolutionMetadata, portalMetadataEntities } from './lib/solution-metadata.mjs';
import { canvasAppNames, solutionApps } from './lib/model-driven/catalogue.mjs';
import { createModelDrivenData, storeCatalogue } from './lib/model-driven/data.mjs';
import { createModelDrivenHandler, routes as MODEL_DRIVEN_ROUTES } from './lib/model-driven/http.mjs';
import { offlineSessionState } from './lib/model-driven/offline.mjs';
import { modelDrivenSettings } from './lib/model-driven-settings.mjs';
import { importModelDrivenResources, clientExtensionCatalogue } from './lib/model-driven-resources.mjs';
import { powerPagesTables, managementOverlay } from './lib/model-driven/power-pages.mjs';
import { createModelDrivenStorage } from './lib/model-driven-storage.mjs';
import { createSolutionMetadataOverlay } from './lib/dataverse-solution-metadata.mjs';
import { writeJsonChunks } from './lib/json-response.mjs';
import { createSourceSolutionComponentStorage } from './lib/dataverse-source-components.mjs';
import { importSolutionData, applySolutionData } from './lib/solution-data.mjs';
import { scanSolutionSources, buildSolutionSchema, assertReloadableScan } from './lib/solution-schema.mjs';
import { SolutionFileCache, sourceDirectoryDigest } from './lib/solution-cache.mjs';
import {
  resolveUnmatchedRoute,
  deniedPageRoute,
  languageRoute,
  siteMarkerRoute,
  siteSetting,
  servicePages,
  exportedPageFor,
  loginPath,
  signInPath,
  applyObserved,
  requestTargetUrl,
} from './lib/redirects.mjs';
import {
  authCookieName,
  createAuthSessions,
  authRoute,
  safeReturnUrl,
  returnUrlParameter,
  signInContent,
} from './lib/auth-session.mjs';
import { createExternalSignIn } from './lib/sign-in-flow.mjs';
import {
  composeOrganizationHost,
  providerDescriptors,
  inventorySummary,
  codeAppDataverse,
  codeAppConnectors,
  hostSurfaces,
  graphBindings,
  simApiRoutes,
  modelDrivenAppsOf,
} from './lib/organization-host.mjs';
import { createCanvasHandler } from './lib/canvas-http.mjs';
import { createCanvasRuntime } from './lib/canvas-runtime.mjs';
import { canvasPcfApps } from './lib/canvas-pcf.mjs';
import { createCodeAppsHandler, authorityTokenIssuer } from './lib/code-apps-http.mjs';
import { codeAppSettings, loadCodeApps } from './lib/code-apps-config.mjs';
import { createRequestContext, currentRequest, runWithRequest, correlationOf } from './lib/request-context.mjs';
import { createMessagingRoutes, routes as MESSAGING_ROUTES } from './lib/sim-messaging-routes.mjs';
import { createFlowRoutes, routes as FLOW_ROUTES } from './lib/sim-flow-routes.mjs';
import { buildSourceGraph } from './lib/source-graph.mjs';
import { scenarioSettings } from './lib/capability-report.mjs';
import { environmentVariablePayload } from './lib/secret-resolver.mjs';
import { authenticationSettings } from './lib/external-login.mjs';
import { dataverseSettings, dataverseStatus } from './lib/dataverse-settings.mjs';
import { uuidV5, createApplicationUser } from './lib/dataverse-security.mjs';
import { ensureCertificate } from './lib/dataverse-tls.mjs';
// The RadCaptcha challenge resources (lib/platform.mjs captchaChallenge): a placeholder image and
// half a second of silent 8 kHz audio. No readable challenge is simulated, so CAPTCHA saves fail closed.
const CAPTCHA_IMAGE = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z',
  'base64',
);
const CAPTCHA_AUDIO = (() => {
  const samples = 4000;
  const wav = Buffer.alloc(44 + samples, 0x80);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  return wav;
})();
/** Telerik.Web.UI.WebResource.axd captcha image (type=rca) and audio (type=cah, ranges honoured) as live answers them. */
function captchaResource(req, res, url, portal) {
  const type = url.searchParams.get('type');
  if (type !== 'rca' && type !== 'cah') return false;
  const headers = { 'cache-control': 'private', 'x-frame-options': siteHeaders(portal)['x-frame-options'] };
  if (type === 'rca') {
    res.writeHead(200, { ...headers, 'content-type': 'image/jpeg', 'content-length': CAPTCHA_IMAGE.length });
    res.end(req.method === 'HEAD' ? undefined : CAPTCHA_IMAGE);
    return true;
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const size = CAPTCHA_AUDIO.length;
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 });
    res.end();
    return true;
  }
  const body = CAPTCHA_AUDIO.subarray(start, end + 1);
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'accept-ranges': 'bytes',
    'content-type': 'audio/wav',
    'content-disposition': `attachment; filename=RadCaptcha_Audio_${String(url.searchParams.get('guid') ?? '').slice(0, 8)}.wav`,
    'content-length': body.length,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
/**
 * A native postback's redirect as ASP.NET Response.Redirect writes it (live 302 answers): the
 * page cache headers without Vary, the site's frame option and the "Object moved" body.
 */
function postbackRedirect(res, response, portal) {
  const href = String(response.location).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const body = `<html><head><title>Object moved</title></head><body>\r\n<h2>Object moved to <a href="${href}">here</a>.</h2>\r\n</body></html>\r\n`;
  const { vary: _vary, ...page } = PAGE_HEADERS;
  res.writeHead(response.status, {
    ...page,
    'content-type': 'text/html; charset=utf-8',
    location: response.location,
    'x-frame-options': siteHeaders(portal)['x-frame-options'],
    'content-length': Buffer.byteLength(body),
  });
  return res.end(body);
}
import {
  siteHeaders,
  webFileHeaders,
  webFileDisposition,
  tokenHtmlHeaders,
  notModified,
  PAGE_CACHE_CONTROL,
  PAGE_HEADERS,
  platformResourceHeaders,
} from './lib/response-headers.mjs';
import { solutionWatchFilter } from './lib/solution-roots.mjs';
import { observedConfig } from './lib/project-config.mjs';
import { runtimePort } from './lib/runtime-port.mjs';
import { createFrameReadiness } from './lib/frame-readiness.mjs';
import { formWriteError } from './lib/form-error-presentation.mjs';
import { assertPortalSource, portalSourceDir } from './lib/source-dialect.mjs';
import { discoverPacks, OWNED_PRESET } from './lib/preset-registry.mjs';
import { collectWebApiErrorTemplates } from './lib/webapi-error-templates.mjs';
import {
  injectRuntime,
  renderComponent,
  renderQuickForm,
  captchaRefreshDelta,
  PAGES_CLIENT_API_SCRIPT,
  PAGES_CLIENT_API_FILE,
} from './lib/platform.mjs';
import {
  submitPortalForm,
  createWebFormSessions,
  webFormSessionOwner,
  portalRecordWrites,
} from './lib/form-service.mjs';
import {
  resolveNativeFormSubmission,
  submitNativePostback,
  nativePostbackResponse,
} from './lib/native-form-submission.mjs';
import {
  multipartControls,
  nativeFormTransport,
  decodeNativeViewState,
  nativeViewStateKey,
} from './lib/native-postback.mjs';
import { readVisitor, newVisitor, visitorCookieName } from './lib/visitor-session.mjs';
import { handleNativeService, antiForgeryCookie } from './lib/native-services.mjs';
import {
  antiForgeryHolder,
  isAspNetScript,
  webFormsForm,
  platformShell,
  bootstrapVariant,
} from './lib/platform-manifest.mjs';
import { packEndpoints } from './lib/extensions.mjs';
import { externalFrameOrigins, portalContentSecurityPolicy } from './lib/content-policy.mjs';
import {
  buildPermissionModel,
  resolvePortalIdentity,
  membershipsForRoles,
  portalDocumentAccess,
} from './lib/permissions.mjs';
import { handleWebApi } from './lib/webapi-handler.mjs';
import { buildSiteTables } from './lib/site-tables.mjs';

// Organization.BlockedAttachments default ("Block files by extension":
// https://learn.microsoft.com/power-apps/developer/data-platform/files-images-overview).
const DATAVERSE_BLOCKED_ATTACHMENTS =
  'ade;adp;app;asa;ashx;asmx;asp;bas;bat;cdx;cer;chm;class;cmd;com;config;cpl;crt;csh;dll;exe;fxp;hlp;hta;htr;htw;ida;idc;idq;inf;ins;isp;its;jar;js;jse;ksh;lnk;mad;maf;mag;mam;maq;mar;mas;mat;mau;mav;maw;mda;mdb;mde;mdt;mdw;mdz;msc;msh;msh1;msh1xml;msh2;msh2xml;mshxml;msi;msp;mst;ops;pcd;pif;prf;prg;printer;pst;reg;rem;scf;scr;sct;shb;shs;shtm;shtml;soap;stm;tmp;url;vb;vbe;vbs;vsmacros;vss;vst;vsw;ws;wsc;wsf;wsh;svg';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const toolkitPackage = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const DOCS = docsLinks(toolkitPackage.version, toolkitPackage.repository?.url ?? toolkitPackage.repository);
// Bind evidence to the mirage loaded by this process as well as portal sources. The cached form is the same digest and
// seeds the cache, so the first state read compares file stats instead of hashing the toolkit a second time. The walk
// starts at import, as before, but only a starting runtime waits for it: importing this module does not.
const loadedImplementationFingerprint = cachedImplementationSourceFingerprint(ROOT);
// A failure surfaces in the runtime that awaits it, not as an unhandled rejection of an import that starts none.
loadedImplementationFingerprint.catch(() => {});
const auditResponse = Symbol('auditResponse');
const mime = (file) =>
  ({
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.pdf': 'application/pdf',
  })[path.extname(file).toLowerCase()] || 'application/octet-stream';
const error = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const decodeAdminIdentifier = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw error('Administration identifier has invalid URL encoding.');
  }
};
const escaped = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isWrite = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
function validateEndpoint(value) {
  if (
    typeof value.path !== 'string' ||
    !value.path.startsWith('/') ||
    value.path.startsWith('//') ||
    // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
    /[\\\u0000-\u001f]/.test(value.path)
  )
    throw error('Endpoint path must be portal-relative.');
  let decoded;
  try {
    decoded = decodeURIComponent(value.path);
  } catch {
    throw error('Endpoint path has invalid encoding.');
  }
  if (
    decoded.startsWith('/__sim') ||
    decoded.includes('\\') ||
    decoded.split('/').includes('..') ||
    value.path.includes('?') ||
    value.path.includes('#')
  )
    throw error('Endpoint path must be a portal pathname outside /__sim.');
  if (!['local', 'live'].includes(value.mode ?? 'local')) throw error('Endpoint mode must be local or live.');
  if (
    typeof value.method !== 'string' ||
    !['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', '*'].includes(value.method.toUpperCase())
  )
    throw error('Endpoint method must be an HTTP verb or *.');
  if (value.status !== undefined && (!Number.isInteger(value.status) || value.status < 200 || value.status > 599))
    throw error('Endpoint status must be an integer from 200 to 599.');
  if (value.entity !== undefined && (typeof value.entity !== 'string' || !/^\w+$/.test(value.entity)))
    throw error('Endpoint entity must be a logical name or entity set.');
}
async function rawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw error('Request body exceeds 8 MiB.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req, { allowEmpty = true, odataErrorDetails = false } = {}) {
  const bytes = await rawBody(req);
  if (!bytes.length) {
    if (!allowEmpty)
      throw Object.assign(error('Passed entity object cannot be null or empty.'), {
        details: { innerCode: '0x80072530' },
      });
    return {};
  }
  try {
    const source = bytes.toString('utf8'),
      body = parseExactJson(source);
    return odataErrorDetails ? attachODataJsonSource(body, source) : body;
  } catch {
    throw attachODataReaderDetails(
      error('Request body must be valid JSON.'),
      odataErrorDetails ? odataInvalidJsonDetails(bytes.toString('utf8')) : null,
    );
  }
}
async function jsonObjectBody(req) {
  const body = await jsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error('Request body must be a JSON object.');
  return body;
}
function json(res, status, value, headers = {}, { chunks } = {}) {
  res[auditResponse] = {
    rowCount: Array.isArray(value?.value)
      ? value.value.length
      : Array.isArray(value)
        ? value.length
        : status < 400 && value && typeof value === 'object'
          ? 1
          : undefined,
    error: value?.error,
  };
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  if (chunks && status !== 204) return writeJsonChunks(res, chunks);
  res.end(status === 204 ? undefined : stringifyExactJson(value));
}

const RECORD_OWNERS = Symbol('owned record storage');
export async function createSimulator(options = {}) {
  const runtime = runtimeSettings(options.runtime);
  if (runtime.kind !== 'power-pages') {
    const { createStandaloneRuntime } = await import('./lib/standalone-runtime.mjs');
    return createStandaloneRuntime({ ...options, runtime });
  }
  const owners = new Set();
  try {
    return await createPowerPagesSimulator({ ...options, runtime, [RECORD_OWNERS]: owners });
  } catch (error) {
    // Close every owner; a close failure never hides the startup failure.
    const errors = [];
    for (const owner of owners)
      try {
        owner.closeRecordStorage?.();
      } catch (closeError) {
        errors.push(closeError);
      }
    if (errors.length)
      throw new AggregateError([error, ...errors], 'Simulator startup failed and record storage failed to close', {
        cause: error,
      });
    throw error;
  }
}

async function createPowerPagesSimulator({
  [RECORD_OWNERS]: recordOwners,
  runtime: runtimeOption,
  modelDriven: modelDrivenOption,
  sourceDir,
  stateFile,
  persistence,
  personaContexts: personaContextsOption = {},
  identityProvider: identityProviderOption = {},
  dataverse: dataverseOption = null,
  dataverseCertificateFile = null,
  personaInstance = null,
  preset,
  presetMode = 'always',
  presetConfiguration = 'data-only',
  port = 0,
  host = '127.0.0.1',
  origin,
  watch = true,
  sourceMaps = true,
  initial,
  liveBridge,
  solutionRoots = [],
  solutionOrder = 'derived',
  environmentVariables = {},
  project = null,
  simulation: simulationOption,
  // The toolkit catalogue takes precedence over a generated runtime project.
  setup = null,
  // Explicit external pack modules for embedded runtimes and project-owned tests.
  dataPacks = [],
  packs = [],
  localOverrides: overridesOption,
  compat = {},
  head = {},
  projectRoot = process.cwd(),
  deploymentProfile,
  deploymentProfiles,
  onShutdown,
  onStartup,
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
  importedSources,
  contentPolicyDefaults: policyDefaults = {},
  // Names of the registered settings the caller's configuration authored (config-keys.mjs configuredSettingKeys); null: not known.
  configuredSettings = null,
  // Registered settings this host does not read itself (mirage/lib/config-keys.mjs); persona instances inherit them.
  ...settingOptionsRest
} = {}) {
  const startedAt = performance.now(),
    bootstrapTimings = {};
  const startupPhase = (phase) => {
    try {
      Promise.resolve(onStartup?.({ phase, elapsedMs: Math.round(performance.now() - startedAt) })).catch(() => {});
    } catch {
      /* progress observer only */
    }
  };
  startupPhase('configuration');
  const simulation = simulationSettings(simulationOption ?? project?.simulation);
  // Dry run starts from source and pack DATA in memory. No state, asset, source
  // cache, evidence or certificate file is created by the runtime.
  if (simulation?.level === 'dry-run') stateFile = null;
  policyDefaults = resolvePolicyDefaults(policyDefaults);
  personaContextsOption = personaContextSettings(personaContextsOption);
  const providerSettings = identityProviderSettings(identityProviderOption),
    providerAssets = identityProviderAssets(providerSettings, projectRoot);
  port = runtimePort(port, 0);
  if (typeof sourceMaps !== 'boolean') throw error('sourceMaps must be true or false.');
  const render = renderSettings(renderOption);
  const localOverrides = overridesOption ?? resolveLocalOverrides({ compat, head }, projectRoot);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw error('The simulator binds only to loopback.');
  if (dataModel != null && !DATA_MODELS.includes(dataModel))
    throw error(`dataModel must be standard or enhanced, not ${JSON.stringify(dataModel)}.`);
  // A code-site project serves the site in its .powerpages-site/ folder (lib/source-dialect.mjs).
  sourceDir = portalSourceDir(sourceDir);
  const profileConfig = resolveDeploymentProfiles(deploymentProfiles, projectRoot, {
    sourceDir,
    sourceRoot: projectRoot,
  });
  if (deploymentProfile && Object.keys(profileConfig.profiles).length)
    throw error('Use deploymentProfiles or the legacy deploymentProfile option, not both.');
  let persistedPin = initial?.simulator?.deploymentProfilePin ?? null;
  let restoredState, restoredStorage;
  if (stateFile) {
    const preloadStarted = performance.now();
    try {
      const { StateStorage, readStateFile } = await import('./lib/state-storage.mjs');
      if (!simulation) {
        restoredStorage = new StateStorage(stateFile, persistence);
        restoredState = await restoredStorage.load();
        recordOwners?.add({ closeRecordStorage: () => restoredStorage?.recordSession?.close() });
      }
      persistedPin =
        (restoredState ?? (await readStateFile(stateFile, { sections: ['simulator'] }))).simulator
          ?.deploymentProfilePin ?? null;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
    bootstrapTimings.profilePinMs = Math.round(performance.now() - preloadStarted);
    bootstrapTimings.statePreloadMs = restoredState === undefined ? 0 : bootstrapTimings.profilePinMs;
  }
  if (personaInstance?.deploymentProfile !== undefined) persistedPin = personaInstance.deploymentProfile;
  let activeProfiles = await loadDeploymentProfiles(profileConfig, persistedPin);
  // Bootstrap : portal export + ordered solution layers -> mappings, schemas,
  // permission model. Parsed solution files are cached beside the state file and
  // reused only for files whose size/mtime/ctime/inode are unchanged.
  // Options are validated before any source read starts, so a rejected option leaves no
  // read running against the source directory.
  const observed = observedConfig(observedOption);
  const frameReadiness = createFrameReadiness({ diagnostic: (entry) => recordDiagnostic(entry) });
  const setupHandler = await createSetupHandler({
    directory: projectRoot,
    ...(setup ?? (project?.configFile ? { project: project.configFile } : {})),
    runtime: { product: 'Mirage', sourceDir },
  });
  bootstrapTimings.configurationMs = Math.round(performance.now() - startedAt);
  const sourceDigest = sourceDirectoryDigest(sourceDir);
  // Awaited below; a bootstrap failure before then must not leave an unhandled rejection.
  sourceDigest.catch(() => {});
  // Portal imports keep duplicate-copy commit lookups beside the state file
  // (cache/portal-sources.json), so a restart does not ask git again for unchanged files.
  const portalCacheFile = stateFile
    ? path.join(path.dirname(path.resolve(stateFile)), 'cache', 'portal-sources.json')
    : null;
  const importSource = async (recordOverrides = {}) => {
    startupPhase('portal-import');
    const started = performance.now();
    const cache = await SolutionFileCache.open(portalCacheFile);
    const imported = applyObserved(
      await importPortal(sourceDir, {
        deploymentProfile: activeProfiles.pagesFile ? activeProfiles.profile : deploymentProfile,
        deploymentProfileFile: activeProfiles.pagesFile,
        dataModel,
        cache,
        recordOverrides,
      }),
      observed,
    );
    await cache.save();
    bootstrapTimings.portalCache = { ...cache.stats, file: portalCacheFile };
    bootstrapTimings.portalMs = Math.round(performance.now() - started);
    return imported;
  };
  let sourcePortal =
    importedSources?.sourceDir === sourceDir &&
    importedSources.pagesFile === activeProfiles.pagesFile &&
    importedSources.profilesFingerprint === activeProfiles.fingerprint &&
    importedSources.deploymentProfile === deploymentProfile &&
    importedSources.dataModel === dataModel &&
    !persistedPin &&
    importedSources.portalDigest === (await sourceDigest)
      ? applyObserved(importedSources.portal, observed)
      : await importSource();
  // A source with zero recognised pages is not a portal: `serve` fails loudly, naming its layout.
  if (requirePortalSource) assertPortalSource(sourcePortal);
  let portal = sourcePortal;
  let solutionMetadata = {
      componentSchemas: {},
      diagnostics: [],
      summary: null,
      fingerprint: '',
    },
    solutionData = {
      mappings: {},
      relationships: {},
      diagnostics: [],
      stats: {},
      roots: [],
      layers: [],
      environmentVariables: [],
      fingerprint: '',
    };
  const solutionCacheFile = stateFile
    ? path.join(path.dirname(path.resolve(stateFile)), 'cache', 'solution-sources.json')
    : null;
  let operationWorkflows = new Map();
  let solutionOperations = { serverLogics: [], cloudFlows: [] };
  let codeComponents = { controls: new Map(), assets: new Map(), diagnostics: [] };
  const modelDrivenSettingsValue = modelDrivenSettings(modelDrivenOption);
  let clientResources = { resources: [], assets: new Map(), pcf: { controls: [] } };
  // Source import diagnostics arrive before recordDiagnostic exists; they are buffered and replayed into it.
  const earlySourceDiagnostics = [];
  let sourceDiagnostic = (entry) => earlySourceDiagnostics.push(entry);
  let solutionInventory = [],
    solutionScan = null;
  async function loadSolutions({ reuseImported = false } = {}) {
    if (!solutionRoots.length && !modelDrivenSettingsValue.clientSources?.length) return;
    startupPhase('solution-import');
    const started = performance.now();
    const cache = await SolutionFileCache.open(solutionCacheFile);
    const previous =
      reuseImported &&
      importedSources?.solutionOrder === solutionOrder &&
      JSON.stringify(importedSources.solutionRoots) === JSON.stringify(solutionRoots)
        ? importedSources.solutionScan
        : undefined;
    const scan = await scanSolutionSources(solutionRoots, { cache, order: solutionOrder, previous });
    // Every re-scan (reload, deployment profile pin) is checked against the last accepted scan before anything is assigned;
    // a rejected scan never becomes the baseline.
    if (solutionScan) assertReloadableScan(solutionScan, scan);
    const lcid = project?.lcid ?? dataverseOption?.localeId ?? 1033;
    const schema =
      scan === previous && importedSources?.solutionSchema?.lcid === lcid
        ? importedSources.solutionSchema
        : buildSolutionSchema(scan, { lcid });
    bootstrapTimings.solutionReuse = { scan: scan === previous, schema: schema === importedSources?.solutionSchema };
    operationWorkflows = await importOperationWorkflows(scan.layers);
    solutionOperations = await importSolutionOperationSources(scan.layers, portal.website);
    codeComponents = await importCodeComponents(scan.layers);
    [solutionMetadata, solutionData] = await Promise.all([
      importSolutionMetadata(solutionRoots, {
        portal,
        entities: [...new Set([...Object.keys(schema.tables), ...portalMetadataEntities(portal)])],
        scan,
        schema,
        observed,
        lcid,
      }),
      scan === previous && schema === importedSources?.solutionSchema
        ? importedSources.solutionData
        : importSolutionData(solutionRoots, { scan, schema, lcid }),
    ]);
    solutionMetadata.modelDrivenApps = solutionApps(scan, { lcid, projectRoot });
    clientResources = await importModelDrivenResources(scan.layers, {
      codeComponents,
      clientSources: modelDrivenSettingsValue.clientSources,
      projectRoot,
      diagnostic: (entry) => sourceDiagnostic(entry),
    });
    solutionInventory = scan.inventory ?? [];
    solutionScan = scan;
    solutionMetadata.modelDrivenRibbonDocuments = clientResources.ribbonDocuments;
    solutionMetadata.modelDrivenAppActions = clientResources.appActions;
    await cache.save();
    bootstrapTimings.solutionsMs = Math.round(performance.now() - started);
    bootstrapTimings.solutionCache = { ...cache.stats, processHits: cache.processHits, file: solutionCacheFile };
  }
  await loadSolutions({ reuseImported: true });
  // Project data packs (project.dataPacks) join the built-in pack registry.
  const projectPacks =
    project?.dataPacks?.length || dataPacks.length || packs.length
      ? await discoverPacks({ project, portal: sourcePortal, explicit: dataPacks, packs })
      : undefined;
  // HTTP endpoints of the packs that serve this portal (built-in and project packs).
  const packConfigurations = configurationPresetReport(projectPacks ?? []);
  packConfigurations.diagnostics = configurationPresetDiagnostics(projectPacks ?? [], {
    portal: sourcePortal,
    metadata: solutionData,
  });
  const packEndpointList = packEndpoints(projectPacks ?? (await discoverPacks({ portal: sourcePortal })));
  const registeredWebApiErrorTemplates = collectWebApiErrorTemplates(projectPacks ?? []);
  const operationPortal = () => withSolutionOperations(portal, solutionOperations);
  const bootstrapOptions = () => ({ origin, metadata: solutionData, ...(projectPacks ? { packs: projectPacks } : {}) });
  const presetLibraryStarted = performance.now();
  startupPhase('preset-library');
  const bootstrapState = initialState(portal, bootstrapOptions());
  let generatedPresets = bootstrapState.presets;
  bootstrapTimings.presetLibraryMs = Math.round(performance.now() - presetLibraryStarted);
  const implementationFingerprint = await loadedImplementationFingerprint;
  const runtimeFingerprint = implementationFingerprint;
  const calculateFingerprint = async (digest) =>
    createHash('sha256')
      .update(runtimeFingerprint)
      .update(await (digest ?? sourceDirectoryDigest(sourceDir)))
      .update(solutionMetadata.fingerprint ?? '')
      .update(solutionData.fingerprint ?? JSON.stringify(solutionData))
      .update(JSON.stringify([...operationWorkflows]))
      .update(JSON.stringify(solutionOperations))
      .update(JSON.stringify([...codeComponents.controls].map(([name, control]) => [name, control.fingerprint])))
      .update(activeProfiles.fingerprint)
      .digest('hex');
  let fingerprint = await calculateFingerprint(sourceDigest);
  let appliedPermissionModel;
  const webApiTables = () =>
    Object.entries(portal.settings ?? {})
      .filter(([name, value]) => /^Webapi\/[^/]+\/enabled$/i.test(name) && String(value).toLowerCase() === 'true')
      .map(([name]) => name.split('/')[1].toLowerCase());
  const applySolutions = (state, { owned = false } = {}) =>
    applySolutionData(state, solutionData, {
      owned,
      presetLibrary: generatedPresets,
      webApiTables: webApiTables(),
      // Local values set in _sim (simulator.environmentVariables) win over project-level overrides.
      environmentVariables: Object.fromEntries(
        Object.entries({
          ...activeProfiles.environmentVariables,
          ...environmentVariables,
          ...(state.simulator?.environmentVariables ?? {}),
        }).map(([name, value]) => [name.toLowerCase(), value]),
      ),
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
  const replaceCompiledState = async (
    state,
    { expectedRevision = store.snapshotRevision(state) ?? store.revision } = {},
  ) => {
    const candidate = compilePermissions(
      applySolutions(state, {
        owned: store.isInitializing() || store.snapshotRevision(state) !== undefined,
      }),
    );
    sourceComponentStorage?.materialize(candidate.state);
    managementStorage?.materialize(candidate.state);
    // Source composition produced this private detached candidate; normalization
    // can adopt it without cloning the entire business graph again.
    await store.replaceState(candidate.state, {
      expectedRevision,
      returnSnapshot: false,
      cloneInput: false,
      skipSaveIfUnchanged: true,
    });
    appliedPermissionModel = candidate.model;
  };
  if (!['data-only', 'apply'].includes(presetConfiguration))
    throw new Error('presetConfiguration must be data-only or apply');
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
    name: preset ?? null,
    mode: presetMode,
    applied: Boolean(preset && (presetMode === 'always' || !stateExisted)),
  };
  // Display labels from older runtimes may have leaked into persisted state.
  const policyOrigin = (value) =>
    value === 'runtime state (project default differs)' || value?.startsWith('project defaults')
      ? 'project defaults'
      : 'runtime state';
  const seededInitialState = () => {
    const state = initial ? { ...initial } : { ...bootstrapState };
    const explicitPolicy = ['confinePortalPages', 'externalAssets', 'externalFrameOrigins'].some((key) =>
      Object.hasOwn(initial?.simulator ?? {}, key),
    );
    state.simulator = {
      ...state.simulator,
      ...policyDefaults,
      ...(initial?.simulator ?? {}),
      contentPolicySource: !explicitPolicy && Object.keys(policyDefaults).length ? 'project defaults' : 'runtime state',
    };
    return state;
  };
  const solutionMetadataOverlay = createSolutionMetadataOverlay({ appsOf: solutionApps });
  const modelMetadata = () => solutionMetadataOverlay(solutionMetadata, store.state);
  const storageAdapter = await createSimulationPersistence({
    settings: simulation,
    packs: projectPacks ?? [],
    stateFile,
  });
  const hostClock =
    typeof settingOptionsRest.clock === 'function'
      ? { now: settingOptionsRest.clock }
      : (settingOptionsRest.clock ?? undefined);
  let bootstrapStageAt = performance.now();
  const store = new DataStore({
    unpublished: true,
    ownedState: true,
    file: stateFile,
    persistence,
    storageAdapter,
    presetLibrary: generatedPresets,
    platform: platformOption,
    state: restoredState !== undefined ? { version: 1 } : applySolutions(seededInitialState()),
    // Host clock/ids (runtime-clock.mjs); the defaults are wall time and random GUIDs.
    ...(hostClock ? { clock: hostClock } : {}),
    ...(settingOptionsRest.ids ? { ids: settingOptionsRest.ids } : {}),
  });
  recordOwners?.add(store);
  bootstrapTimings.stateSeedMs = Math.round(performance.now() - bootstrapStageAt);
  // The shared organization composition (lib/organization-host.mjs): handler maps, memoised catalogues, providers,
  // backend, Dataverse API, operation-mode selection and the one close order.
  const NO_OVERRIDES = Object.freeze({});
  const organizationHost = await composeOrganizationHost({
    store,
    packs: projectPacks ?? [],
    runtime: runtimeOption,
    // Host surfaces under their legacy status keys (capability registry summary()).
    surfaces: () => hostSurfaces({ host: 'power-pages', dataverseApi: dataverseConfig.enabled }),
    inventory: () => solutionInventory,
    localOrigin: () => localOrigin ?? null,
    codeApps: () => codeAppRecords,
    projectRoot,
    config: {
      connections: settingOptionsRest.connections,
      secrets: settingOptionsRest.secrets,
      providers: settingOptionsRest.providers,
      localServices: settingOptionsRest.localServices,
      canvas: settingOptionsRest.canvas,
      connectorScripts: settingOptionsRest.connectorScripts,
    },
    // The state directory (file and note bytes under <stateDir>/blobs) follows organization-host.mjs stateDirectoryOf.
    stateFile,
    simulation,
    sources: {
      readMetadata: (fn, options) => solutionMetadataOverlay.withReadEpoch(fn, options),
      plugins: () => solutionMetadata.plugins,
      workflows: () => operationWorkflows,
      layers: () => solutionData?.layers ?? [],
    },
    sourcesKey: () => [portal, solutionMetadata, operationWorkflows, solutionOperations],
    overrides: () => store.state.simulator?.operations ?? NO_OVERRIDES,
    portalOperations: () => operationPortal(),
    workflowOverrides: () => store.state.dataverse?.workflowOverrides ?? {},
    // Provider composition reports before recordDiagnostic exists; sourceDiagnostic buffers those and then forwards.
    diagnostic: (entry) => sourceDiagnostic(entry),
    timeoutMs: () => environmentValue('pluginTimeoutSeconds', dataverseConfig.pluginTimeoutSeconds) * 1000,
    clock: hostClock,
    ids: settingOptionsRest.ids,
    scheduler: settingOptionsRest.scheduler,
  });
  const {
    handlers: { operations: registeredOperations },
    operations,
  } = organizationHost;
  const workflowsView = organizationHost.workflows;
  const codeApps = codeAppSettings(settingOptionsRest.codeApps);
  let startupPresetBody;
  const validateStartupConfiguration = () => {
    if (!startupPreset.applied || presetConfiguration !== 'apply') return;
    const state = store.snapshot({ sections: ['presets', 'mappings', 'simulator'] });
    const selected = resolvePreset(state, preset, generatedPresets, store.recordContext());
    if (!selected) throw error('Preset not found.', 404);
    if (
      selected.configurationPreset &&
      !experimentPresets(state, sourcePortal, packConfigurations.presets).some(
        (entry) => entry.id === selected.configurationPreset,
      )
    )
      throw error('Configuration preset not found: ' + selected.configurationPreset, 404);
    if (
      Object.getOwnPropertyDescriptor(generatedPresets, preset)?.get?.[OWNED_PRESET] &&
      state.presets?.[preset]?.builtin === true &&
      state.presets[preset].userConfigured !== true
    )
      startupPresetBody = selected;
  };
  // Validate new state before init writes it, and loaded state before any enrichment saves.
  if (!stateExisted) validateStartupConfiguration();
  startupPhase('state-restore');
  bootstrapStageAt = performance.now();
  await store.init({ restoredState, restoredStorage });
  // eslint-disable-next-line no-useless-assignment -- Release bootstrap snapshots before long-lived route closures.
  restoredState = restoredStorage = undefined;
  bootstrapTimings.stateRestoreMs =
    Math.round(performance.now() - bootstrapStageAt) + (bootstrapTimings.statePreloadMs ?? 0);
  bootstrapTimings.stateRestore = {
    existed: stateExisted,
    journal: store.storage?.journal ?? false,
    bytes: stateFile ? ((await fs.stat(stateFile).catch(() => null))?.size ?? 0) : 0,
  };
  if (Object.keys(store.state.simulator?.modelDriven?.records ?? {}).length) {
    sourcePortal = await importSource(store.state.simulator.modelDriven.records);
  }
  store.state.simulator.contentPolicySource = policyOrigin(store.state.simulator.contentPolicySource);
  if (stateExisted) validateStartupConfiguration();
  if (personaInstance)
    Object.assign(store.state.simulator, { mode: 'local', pageMode: 'local', live: { enabled: false } });
  store.setSiteTables(siteTables); // read-only site tables (see siteTables)
  store.setObserved(observed); // observed anonymousDataAccess for table permissions
  // Simulated Dataverse API (lib/dataverse-api.mjs): started before the portal listens, closed by close().
  // Managed identity mode uses the same validated configuration on every runtime surface.
  const dataverseInput =
    dataverseOption && typeof dataverseOption === 'object' && !Array.isArray(dataverseOption) ? dataverseOption : null;
  const dataverseConfig = dataverseSettings({
    ...(dataverseInput ?? (dataverseOption === true ? {} : { enabled: false })),
    localeId: project?.lcid ?? dataverseInput?.localeId ?? 1033,
  });
  const managedIdentityMode = dataverseConfig.managedIdentity?.mode ?? 'appservice';
  const managementStorage = createModelDrivenStorage({
    store,
    tables: () => powerPagesTables(portal, modelMetadata()),
    overlayOf: managementOverlay,
  });
  const sourceComponentStorage = createSourceSolutionComponentStorage({
    store,
    components: () => solutionMetadata.sourceComponents,
    entityId: (logical, state) =>
      state.mappings[logical] ? uuidV5(dataverseOrganizationId(dataverseConfig), `entity:${logical}`) : null,
  });
  let appliedManagementRecords = structuredClone(store.state.simulator?.modelDriven?.records ?? {});
  let dataverse = null;
  let organization = null,
    organizationRecords = null,
    portalDocuments = null;
  const staffSessions = createStaffSessions({
    organization: () => organization,
    port: () => (localOrigin ? new URL(localOrigin).port : ''),
  });
  // Managed identity endpoints (lib/dataverse-managed-identity.mjs): created once the listener has its origin.
  let managedIdentity = null;
  let managedIdentityHeaderShown = false;
  // Settings identities first, then the ones added through the admin API (both answer token requests).
  const managedIdentityList = () => [
    ...(dataverseConfig.managedIdentities ?? []),
    ...(store.state.dataverse?.managedIdentities ?? []),
  ];
  // Runtime overrides set in the admin Environment settings (store.state.dataverse.environment). A key the admin never set
  // falls back to the settings value. Auditing and duplicate detection live on the organization row, not here.
  const environmentValue = (key, fallback) => dataverseEnvironmentValue(() => store, key, fallback);
  const liveDataverseSettings = composeLiveDataverseSettings(dataverseConfig, projectRoot, () => store);
  // Self-signed CA for the https listener; the default file sits beside the state file (.paqvilo/). Without a state
  // file the CA stays in memory: a shared temp path would let another local user plant a key.
  const dataverseCertificatePath =
    dataverseCertificateFile ??
    (stateFile ? path.join(path.dirname(path.resolve(stateFile)), 'dataverse-ca.pem') : null);
  let dataverseCertificate = null;
  // The identity header is shown once, as secrets are: only the first admin status read (GET /_sim/api/dataverse) after start
  // carries it. Other state reads, the page's own polling included, always carry null.
  const managedIdentitySummary = ({ reveal = false } = {}) => {
    if (!managedIdentity) return null;
    const { IDENTITY_ENDPOINT, IDENTITY_HEADER, IMDS_ENDPOINT } = managedIdentity.env();
    const appService = managedIdentityMode === 'appservice';
    const shown = appService && reveal && !managedIdentityHeaderShown;
    if (shown) managedIdentityHeaderShown = true;
    return { endpoint: appService ? IDENTITY_ENDPOINT : IMDS_ENDPOINT, header: shown ? IDENTITY_HEADER : null };
  };
  const dataverseSummary = () => ({
    ...dataverseStatus(dataverseConfig, dataverse ?? {}),
    organizationAvailable: Boolean(organization),
    certificateFile: dataverseCertificate?.file ?? null,
    certificateFingerprint: dataverseCertificate?.fingerprint256 ?? null,
    managedIdentity: managedIdentitySummary(),
  });
  // Site settings bound to environment variables take their effective value; Secret ones resolve as the organization's
  // SYSTEM user. portalOverrides.settings still win over both.
  const environmentBound = (source, state) =>
    bindPortalEnvironment(source, state, {
      resolver: organizationHost.providers.secrets,
      principalId: uuidV5(dataverseOrganizationId(dataverseConfig), 'systemuser:SYSTEM'),
      diagnostic: (entry) => sourceDiagnostic(entry),
    });
  portal = applyPortalOverrides(
    await environmentBound(sourcePortal, store.state),
    store.snapshot({ sections: ['simulator'] }).simulator?.portalOverrides,
  );
  bootstrapStageAt = performance.now();
  let sourceDependencies = { ...(await discoverSourceDependencies(portal)), compat: localOverrides.compat };
  bootstrapTimings.dependenciesMs = Math.round(performance.now() - bootstrapStageAt);
  bootstrapStageAt = performance.now();
  startupPhase('state-composition');
  await store.initialize(() => replaceCompiledState(store.state));
  await organizationHost.loadCanvas();
  bootstrapTimings.stateCompositionMs = Math.round(performance.now() - bootstrapStageAt);
  bootstrapTimings.sourceBootstrapMs = Math.round(performance.now() - startedAt);
  // Resolved project configuration (CLI --project) and the bootstrap inputs in use.
  const projectStatus = () =>
    project
      ? structuredClone(project)
      : {
          configFile: null,
          portals: [{ id: null, sourceDir: portal.sourceDir }],
          solutions: solutionRoots.map((root) => ({ id: null, root })),
          references: [],
          dataPacks: [],
        };
  // Loopback confinement of portal pages: an explicit opt-in (config.confinePortalPages)
  // that adds the loopback policy (externalAssets and externalFrameOrigins are its
  // exceptions) as a separate Content-Security-Policy header; off, portal pages carry
  // only the headers derived from HTTP/* site settings, as the platform sends them.
  const confinementPolicy = () => (config().confinePortalPages === true ? portalContentSecurityPolicy(config()) : null);
  const confinementStatus = () => ({
    portalPages: config().confinePortalPages === true,
    policy: confinementPolicy(),
    source: config().contentPolicySource ?? 'runtime state',
  });
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
    layers: (solutionData.layers ?? []).map(({ index, solution, dir, type, version }) => ({
      index,
      solution,
      dir,
      type,
      version,
    })),
    environmentVariables: (solutionData.environmentVariables ?? []).length,
    timings: structuredClone(bootstrapTimings),
  });
  const live =
    liveBridge ??
    new LiveBridge(store.snapshot({ sections: ['simulator'] }).simulator?.live ?? { origin }, {
      writesPermitted: allowLiveWrites === true,
    });
  // The runtime flag governs every bridge, an injected one included: without it no write
  // leaves this runtime, whatever the bridge or the /_sim switch would allow.
  live.writesPermitted = allowLiveWrites === true;
  if (!allowLiveWrites) {
    const request = live.request.bind(live);
    live.request = (pathname, options = {}) => {
      if (!['GET', 'HEAD'].includes(String(options.method ?? 'GET').toUpperCase()))
        return Promise.reject(
          error(
            'Live writes are disabled for this runtime: start the Mirage with --allow-live-writes (mirage dev and start pass it through) to send create, update or delete requests to the live environment.',
            403,
            'LIVE_WRITES_DISABLED',
          ),
        );
      return request(pathname, options);
    };
  }
  const cache = stateFile
    ? await new AssetCache({
        directory: path.join(path.dirname(path.resolve(stateFile)), 'assets'),
        origin: live.origin,
      }).init()
    : null;
  const richTextCompatibility = (cfg = config()) => {
    const manifest = cache?.manifest();
    const capturedCore = manifest?.assets.some(
      (asset) => asset.origin === live.origin && /\/ckeditor\.js(?:\?|$)/i.test(asset.path ?? ''),
    );
    // An explicit external native provider remains usable in embedded tests.
    // An incomplete captured editor must never activate merely from its core file.
    if (richTextCompatibilityOverride === false && !capturedCore) return false;
    return richTextCompatibilityOverride === true || !nativeRichTextReady(manifest, cfg.shellProfile, live.origin);
  };
  const evidenceDir = stateFile ? path.join(path.dirname(path.resolve(stateFile)), 'evidence/latest') : null;
  let evidence = null;
  const csrf = randomBytes(32).toString('hex');
  // Attach-file uploads (/_api/file/*/note): the platform's file API stages each file under an
  // annotation id before the form posts the ids (live: InitializeFileUpload, UploadFileBlock,
  // then the postback's AttachFile_HiddenField_AnnotationIds). Staged files live in memory until
  // the postback takes them.
  // Staging is process-local, bounded to 50 files and one hour; a restart discards pending uploads. The bytes are provider
  // blocks of the annotations storage route under staged/<id>, committed by the last block and read when the form saves.
  // ponytail: an upload abandoned before its last block leaves its uncommitted blocks in the provider's staging area until
  // the provider is reset; add a provider-level block discard when long-running hosts accumulate them.
  const stagedUploads = new Map();
  const stagedStorage = () => organizationHost.providers.storage.forRoute('annotations');
  const stagedKey = (id) => `staged/${id}`;
  const dropStaged = (id) => {
    const entry = stagedUploads.get(id);
    stagedUploads.delete(id);
    if (entry?.blocks?.length)
      Promise.resolve(entry.writing)
        .then(() => stagedStorage().delete(stagedKey(id)))
        .catch(() => {});
  };
  // The staged bytes as base64 once every block is written and committed.
  const stagedContent = async (id, entry) => {
    await entry.writing;
    if (!entry.blocks.length) return '';
    const { body } = await stagedStorage().get(stagedKey(id));
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('base64');
  };
  const uploadOwner = () => {
    const visitor = trace.getStore()?.visitor;
    return visitor ? `${visitor}|${currentIdentity().contactId ?? currentIdentity().id ?? 'anonymous'}` : null;
  };
  // Read staged files only inside the serialized form save. Retain them until
  // validation and persistence succeed, so a failed form can safely retry.
  const stagedAttachments = (controls, { prefix } = {}) => {
    const field = prefix
      ? `${prefix}AttachFile_HiddenField_AnnotationIds`
      : [...controls.keys()].find((key) => /AttachFile_HiddenField_AnnotationIds$/.test(key));
    if (!field || !controls.has(field)) return [];
    let ids;
    try {
      ids = JSON.parse(controls.get(field) || '[]');
    } catch {
      throw error('Staged attachment IDs must be a JSON array.', 400, 'FormAttachmentInvalid');
    }
    if (!Array.isArray(ids) || ids.length > 50 || controls.getAll(field).length !== 1)
      throw error('Staged attachment IDs must be one bounded JSON array.', 400, 'FormAttachmentInvalid');
    if (new Set(ids.map((id) => String(id).toLowerCase())).size !== ids.length)
      throw error('A staged attachment was repeated.', 400, 'FormAttachmentInvalid');
    return ids.map((id) => {
      const entry = stagedUploads.get(String(id).toLowerCase());
      if (
        !entry ||
        !entry.owner ||
        entry.owner !== uploadOwner() ||
        entry.received !== entry.size ||
        Date.now() - entry.created > 3600000
      )
        throw error(
          'A staged attachment is incomplete or no longer available. Upload it again before saving.',
          400,
          'FormAttachmentInvalid',
        );
      return {
        id: String(id).toLowerCase(),
        entry,
        attachment: { field: field.replace(/_HiddenField_AnnotationIds$/, ''), name: entry.name, type: entry.type },
      };
    });
  };
  const submitStagedNativePostback = (entries, collected, options, files) =>
    change(async () => {
      const submission = resolveNativeFormSubmission(entries, collected, options.requestUrl);
      const prefix = collected.find(
        (item) => item.descriptor.kind === submission.kind && item.descriptor.formId === submission.formId,
      )?.descriptor.ids.names;
      const staged =
        submission.body.action === 'submit' ? stagedAttachments(new URLSearchParams(entries), { prefix }) : [];
      for (const item of staged) item.attachment.content = await stagedContent(item.id, item.entry);
      const result = await submitNativePostback(entries, collected, {
        ...options,
        attachments: [...files, ...staged.map((item) => item.attachment)],
      });
      for (const item of staged) if (stagedUploads.get(item.id) === item.entry) dropStaged(item.id);
      return result;
    });
  const retainStagedAttachments = (state, entries, collected) => {
    if (!state) return;
    const prefix = collected.find(
      (item) => item.descriptor.kind === state.kind && item.descriptor.formId === state.formId,
    )?.descriptor.ids.names;
    let staged;
    try {
      staged = stagedAttachments(new URLSearchParams(entries), { prefix });
    } catch {
      staged = [];
    }
    state.stagedAttachments = staged.map(({ id, entry }) => ({ id, name: entry.name, size: entry.size }));
  };
  const verificationRuntimeId = randomUUID();
  let revision = 1,
    renderer,
    watcher,
    watcherTimer = null,
    watcherReadyRelease = null,
    mutation = Promise.resolve(),
    reloadPromise = null,
    closing = false,
    closePromise = null,
    // External sign-in and its local identity provider (lib/sign-in-flow.mjs), set below.
    externalSignIn = null,
    // Stops the model-driven handler's warm metadata compiler thread, set once the handler exists.
    closeModelDriven = null;
  // GET observers may commit SDK writes too. Drain every accepted handler
  // before stopping its services; event-stream handlers finish on registration.
  const activeRequests = new Set();
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(watcherTimer);
    watcherTimer = null;
    watcherReadyRelease?.();
    watcherReadyRelease = null;
    frameReadiness.close();
    closePromise = (async () => {
      const failures = [],
        attempt = async (operation) => {
          try {
            await operation();
          } catch (cause) {
            failures.push(cause);
          }
        };
      await attempt(() => personaRuntimes.close());
      await attempt(() => watcher?.close());
      await reloadPromise?.catch(() => {});
      while (activeRequests.size) await Promise.all([...activeRequests]);
      await attempt(() => mutation);
      await attempt(() => store.queue);
      await attempt(() => closeModelDriven?.());
      // One close order (lib/organization-host.mjs): backend (settles committed work, closes CLR hosts), organization, API, managed identity.
      await attempt(() => organizationHost.close());
      await attempt(() => store.closeRecordStorage());
      for (const event of events) event.end();
      await attempt(() => live.close());
      // The local identity provider lives and ends with its runtime.
      await attempt(() => externalSignIn?.close());
      managementStorage?.close();
      sourceComponentStorage?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (failures.length) throw new AggregateError(failures, 'Runtime shutdown completed with cleanup failures.');
    })().catch((cause) => {
      closePromise = null;
      throw cause;
    });
    return closePromise;
  };
  const events = new Set(),
    diagnostics = [],
    requests = [];
  // Portal requests since start; the ring above keeps the last 300 only. Kept out of store.counters so portal traffic never
  // invalidates the topology memo.
  let portalRequestTotal = 0;
  // The ring keeps paths without their query; a credential route (reset, invitation, confirmation) keeps nothing after its
  // first segment, so a token carried in the path never reaches /_sim/ feeds. ponytail: keyword rule, extend when a site uses other names.
  const ringPath = (url) => {
    const segments = String(url).split('?')[0].split('/');
    const credential = segments.findIndex((segment) => /password|token|secret|invit|confirm|redeem/i.test(segment));
    return credential < 0 ? segments.join('/') : `${segments.slice(0, credential + 1).join('/')}/…`;
  };
  const audit = new AuditLog(),
    trace = new AsyncLocalStorage();
  store.onSave = ({ durationMs, mode }) => {
    const context = trace.getStore();
    if (context) {
      context.saveMs = (context.saveMs ?? 0) + durationMs;
      context.saveMode = mode;
    }
  };
  // Enforce the visitor's local-only contract at the outbound boundary too:
  // configuration may change while an asynchronous render is in progress.
  for (const method of ['request', 'fetchXml'])
    if (typeof live[method] === 'function') {
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
      entry.kind === 'liquid-fetchxml'
        ? 'liquid'
        : ['entity-read', 'entity-query'].includes(entry.kind)
          ? 'data'
          : 'request',
      {
        level: entry.outcome === 'error' ? 'error' : entry.outcome === 'denied' ? 'warning' : 'info',
        entry,
      },
    ),
  );
  // Declarative backend rules run inside DataStore transactions; observe their evaluation.
  const evaluatePlugins = store.applyPlugins.bind(store);
  store.applyPlugins = (entity, operation, row, previous, identity) => {
    if (!logClients.size) return evaluatePlugins(entity, operation, row, previous, identity);
    const plugins = (store.snapshot({ sections: ['plugins'] }).plugins ?? [])
      .filter(
        (plugin) =>
          plugin.enabled !== false &&
          (plugin.entity === entity || plugin.entity === '*') &&
          (plugin.operations ?? ['create', 'update']).includes(operation),
      )
      .map((plugin) => plugin.id ?? plugin.name ?? 'plugin');
    const started = Date.now();
    try {
      const effects = evaluatePlugins(entity, operation, row, previous, identity);
      publishLog('plugin', {
        level: 'info',
        entity,
        operation,
        plugins,
        outcome: 'evaluated',
        secondaryEffects: effects.length,
        durationMs: Date.now() - started,
      });
      return effects;
    } catch (cause) {
      publishLog('plugin', {
        level: 'error',
        entity,
        operation,
        plugins,
        outcome: 'rejected',
        error: { code: cause.code ?? 'PLUGIN_ERROR', message: cause.message },
      });
      throw cause;
    }
  };
  const config = (selectedSimulator) => {
    const simulator = selectedSimulator ??
      store.snapshot({ sections: ['simulator'] }).simulator ?? {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: { origin },
      };
    const matchesDefaults = ['confinePortalPages', 'externalAssets', 'externalFrameOrigins'].every((key) =>
      key === 'externalFrameOrigins'
        ? JSON.stringify([...(simulator[key] ?? [])].sort()) === JSON.stringify([...(policyDefaults[key] ?? [])].sort())
        : (simulator[key] === true) === (policyDefaults[key] === true),
    );
    const origin = policyOrigin(simulator.contentPolicySource);
    const source =
      origin === 'project defaults'
        ? !Object.keys(policyDefaults).length
          ? 'project defaults (no longer configured)'
          : !matchesDefaults
            ? 'runtime state (project default differs)'
            : origin
        : origin;
    return {
      ...simulator,
      contentPolicySource: source,
      observed: observed ?? simulator.observed ?? portal.observed ?? null,
    };
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
  const authSessions = createAuthSessions({
    name: () => authCookieName(localOrigin ? new URL(localOrigin).port : null),
  });
  // Advanced form sessions of this runtime (lib/form-service.mjs) and the anonymous visitor
  // cookie that keeps an anonymous visitor's sessions to its browser session.
  const webFormSessions = createWebFormSessions();
  const visitorName = () => visitorCookieName(localOrigin ? new URL(localOrigin).port : null);
  const ANONYMOUS_VISITOR = Object.freeze({ id: null, contactId: null, roles: [], roleSource: 'memberships' });
  const sessionIdentity = (session) =>
    !session?.contactId
      ? ANONYMOUS_VISITOR
      : session.roles
        ? { id: session.contactId, contactId: session.contactId, roles: session.roles, roleSource: 'override' }
        : { id: session.contactId, contactId: session.contactId, roles: [], roleSource: 'memberships' };
  const requestAuth = (req, url) => {
    const session = authSessions.read(req.headers.cookie);
    if (url.pathname.startsWith('/__sim/api')) return { session };
    if (session) return { session, identity: sessionIdentity(session) };
    if (['configured', 'all-requests'].includes(config().identityScope)) return { session };
    return { session, identity: ANONYMOUS_VISITOR };
  };
  const currentIdentity = () => {
    // Read without copying the contact table on every call: identity resolution copies what it returns (the
    // configured identity in live mode and the matched contact are copied here).
    const state = store.projectionOf({
      sections: ['simulator'],
      tables: ['contact'],
      mappings: ['contact'],
    });
    const fromSession = state.simulator?.mode === 'live' ? undefined : trace.getStore()?.auth?.identity;
    const configured = fromSession ?? state.simulator?.identity ?? { id: null, roles: [] };
    const resolved =
      state.simulator?.mode === 'live' ? structuredClone(configured) : resolvePortalIdentity(portal, state, configured);
    const { admin: ignoredAdmin, ...selected } = resolved;
    const contactId = selected.contactId ?? selected.id;
    if (!contactId || state.simulator?.mode === 'live') return selected;
    const idColumn = state.mappings.contact?.idColumn ?? 'contactid';
    const normalize = (value) =>
      String(value ?? '')
        .replace(/[{}]/g, '')
        .toLowerCase();
    const found = state.tables.contact?.find((row) => normalize(row[idColumn]) === normalize(contactId));
    const contact = found && structuredClone(found);
    // A membership session whose contact is gone or inactive is an anonymous visitor.
    const inactive = (row) =>
      Number((row?.statecode && typeof row.statecode === 'object' ? row.statecode.value : row?.statecode) ?? 0) !== 0;
    if (fromSession?.roleSource === 'memberships' && (!contact || inactive(contact)))
      return resolvePortalIdentity(portal, state, ANONYMOUS_VISITOR);
    if (!contact) return selected;
    const account = contact.parentcustomerid ?? contact._parentcustomerid_value;
    return {
      ...contact,
      name: contact.fullname,
      accountId: typeof account === 'object' ? account?.id : account,
      ...selected,
      admin: undefined,
      id: contactId,
      contactId,
      roles: selected.roles ?? [],
    };
  };
  const recordDiagnostic = (d) => {
    if (d.preset && d.code?.startsWith('PACK_CONFIGURATION_PRESET_LINK')) {
      const previous = diagnostics.findIndex(
        (item) => item.code === d.code && item.pack === d.pack && item.preset === d.preset,
      );
      if (previous >= 0) {
        if (
          diagnostics[previous].descriptorConfigurationPreset === d.descriptorConfigurationPreset &&
          diagnostics[previous].bodyConfigurationPreset === d.bodyConfigurationPreset
        )
          return;
        diagnostics.splice(previous, 1);
      }
    }
    diagnostics.push({ ...d, time: new Date().toISOString() });
    if (diagnostics.length > 300) diagnostics.shift();
    publishLog('diagnostic', {
      level: /error|fail/i.test(`${d.severity ?? ''} ${d.code ?? ''}`) ? 'error' : 'warning',
      diagnostic: diagnostics.at(-1),
    });
  };
  sourceDiagnostic = recordDiagnostic;
  earlySourceDiagnostics.splice(0).forEach(recordDiagnostic);
  await organizationHost.createBackend();

  const liveMapping = (entity) => {
    const mapping = store.resolveMapping(entity);
    return {
      ...mapping,
      fields: solutionMetadata.entities?.[mapping.logicalName]?.fields ?? mapping.fields ?? mapping.fieldMetadata,
    };
  };
  const liveJson = async (pathname) => {
    const response = await live.request(pathname, {
      prefer: 'odata.include-annotations="*"',
    });
    if (response.status >= 400)
      throw error(`Live data read returned HTTP ${response.status}.`, response.status, 'LIVE_BRIDGE');
    try {
      return JSON.parse(response.body);
    } catch {
      throw error('Live data read did not return JSON.', 502, 'LIVE_BRIDGE');
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
      if (config().mode !== 'live')
        return normalizeMockLiquidFetchXml(
          await store.readOperation(() =>
            store.fetchXml(xml, identity, {
              platformLanguageCode: 'en-US',
              portalRequest: true,
              right: fetchOptions.right,
              fetchCache: fetchOptions.fetchCache,
              diagnostic: fetchOptions.diagnostic,
            }),
          ),
          xml,
          liveMapping,
        );
      const entity = parseFetchXml(xml).children.find((n) => n.name === 'entity')?.attrs.name;
      if (!entity) throw error('FetchXML requires a root entity.');
      return live.fetchXml(xml, liveMapping(entity));
    },
    async get(entity, id, identity) {
      if (config().mode !== 'live')
        return normalizeMockLiquidRecord(
          await store.readOperation(() => store.get(entity, id, identity, { portalRequest: true })),
          liveMapping(entity),
          { mappings: liveMapping },
        );
      const mapping = liveMapping(entity);
      return normalizeLiveRecord(await liveJson(`/_api/${mapping.entitySet}(${encodeURIComponent(id)})`), mapping);
    },
    async query(entity, params, identity) {
      if (config().mode !== 'live') {
        const result = await store.readOperation(() =>
          store.query(entity, params, identity, undefined, { portalRequest: true }),
        );
        const aggregate = Boolean(params instanceof URLSearchParams ? params.get('$apply') : params?.$apply);
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
      const result = await liveJson(`/_api/${mapping.entitySet}${query.size ? '?' + query : ''}`);
      if (!Array.isArray(result.value))
        throw error('Live data query did not return a value array.', 502, 'LIVE_BRIDGE');
      return {
        ...result,
        value: result.value.map((row) => normalizeLiveRecord(row, mapping)),
      };
    },
  };
  const readProvider = {
    fetchXml: (xml, identity, fetchOptions) =>
      auditRead('liquid-fetchxml', /<entity\b[^>]*\bname\s*=\s*["']([^"']+)/i.exec(xml)?.[1], xml, identity, () =>
        rawReadProvider.fetchXml(xml, identity, fetchOptions),
      ),
    get: (entity, id, identity) =>
      auditRead('entity-read', entity, { id }, identity, () => rawReadProvider.get(entity, id, identity)),
    query: (entity, params, identity) =>
      auditRead('entity-query', entity, params, identity, () => rawReadProvider.query(entity, params, identity)),
  };
  const writeFormRecord = async (entity, id, values, identity) => {
    if (config().mode !== 'live')
      return store.transact(
        () =>
          id
            ? portalRecordWrites(store, { portalRequest: true }).update(entity, id, values, identity)
            : portalRecordWrites(store, { portalRequest: true }).create(entity, values, identity),
        { incremental: true },
      );
    const mapping = liveMapping(entity);
    const response = await live.request(`/_api/${mapping.entitySet}${id ? `(${encodeURIComponent(id)})` : ''}`, {
      method: id ? 'PATCH' : 'POST',
      body: Buffer.from(JSON.stringify(values)),
      contentType: 'application/json',
      prefer: 'return=representation',
    });
    if (response.status >= 400)
      throw error(`Live form data write returned HTTP ${response.status}.`, response.status, 'LIVE_BRIDGE');
    if (response.body?.length) {
      try {
        return normalizeLiveRecord(JSON.parse(response.body), mapping);
      } catch {
        throw error('Live form data write did not return JSON.', 502, 'LIVE_BRIDGE');
      }
    }
    const recordId =
      id ?? response.headers.entityid ?? /\(([^)]+)\)$/.exec(response.headers['odata-entityid'] ?? '')?.[1];
    if (!recordId) throw error('Live form write succeeded without returning a record identifier.', 502, 'LIVE_BRIDGE');
    return { [mapping.idColumn]: recordId };
  };
  // The site's application user ("# Portals-<site name>"), which server logic's InvokeCustomApi runs as: the observed one
  // (observed.portalApplicationUserId) when the organization has it, else a local application user for this site, created
  // once. The native Portal Application User, Service Writer and Service Deleter roles are not seeded locally, so System
  // Administrator stands in for them.
  const portalApplicationAppId = () =>
    uuidV5(
      organization.organizationId,
      `portal-application:${String(portal.website?.id ?? '')
        .replace(/[{}]/g, '')
        .toLowerCase()}`,
    );
  // The application user id when it exists (observed or local), else null; never writes.
  const existingPortalApplicationUser = () => {
    const known = (id) =>
      id &&
      store
        .tableRows('systemuser')
        .some((row) => String(row.systemuserid).toLowerCase() === String(id).replace(/[{}]/g, '').toLowerCase());
    if (known(store.observed?.portalApplicationUserId))
      return String(store.observed.portalApplicationUserId).replace(/[{}]/g, '').toLowerCase();
    const id = uuidV5(organization.organizationId, `systemuser:app:${portalApplicationAppId()}`);
    return known(id) ? id : null;
  };
  const portalApplicationUser = async () => {
    const existing = existingPortalApplicationUser();
    if (existing) return existing;
    const appId = portalApplicationAppId();
    await createApplicationUser(
      store,
      { organizationId: organization.organizationId, tenantId: organization.tenantId ?? 'local' },
      { appId, displayName: `# Portals-${portal.website?.name ?? 'site'}`, roles: ['System Administrator'] },
    );
    return uuidV5(organization.organizationId, `systemuser:app:${appId}`);
  };
  // Server-object bridges of exported server logic (exported-operations.mjs runExportedServerLogic `services`).
  const serverLogicServices = () => ({
    // Enhanced authorization: the visitor's mapped Dataverse user (impersonation; portal-authorization.mjs), else the application user.
    invokeCustomApi: organizationCustomApi(organization, {
      principal: async () => store.portalAuthorization?.principalId(currentIdentity()) ?? portalApplicationUser(),
      origin: dataverse?.origin ?? localOrigin,
    }),
    triggerFlow: ({ flowId, payload, identity }) =>
      runPortalFlow({
        flow: operationPortal().cloudFlows.find(
          (record) =>
            String(record.processId ?? '')
              .replace(/[{}]/g, '')
              .toLowerCase() === flowId,
        ),
        input: payload,
        identity,
      }),
    httpRewrites: Object.assign(
      {},
      ...Object.values(settingOptionsRest.connections ?? {}).map((connection) => connection?.settings?.rewrites ?? {}),
    ),
    log: (entry) =>
      recordDiagnostic({
        code: 'SERVER_LOGIC_LOG',
        severity: entry.level === 'Error' ? 'error' : entry.level === 'Warn' ? 'warning' : 'info',
        ...entry,
      }),
    diagnostic: (entry) => recordDiagnostic(entry),
  });
  // The portal cloud-flow pipeline (/_api/cloudflow/v1.0/trigger/<guid> and Server.Connector.CloudFlow.TriggerAsync).
  const runPortalFlow = async ({ flow, input, identity }) => {
    if (!flow)
      return { status: 404, body: { error: { code: 'NotFound', message: 'The site has no such cloud flow.' } } };
    try {
      assertOperationRole(flow, identity);
    } catch (cause) {
      return {
        status: cause.status ?? 403,
        body: { error: { code: cause.code ?? 'Forbidden', message: cause.message } },
      };
    }
    const flowHandler = registeredOperations.cloudFlows.get(flow.name.toLowerCase());
    const item = operations().find((item) => item.kind === 'cloud-flow' && item.id === flow.id);
    if (item.mode === 'placeholder') operationPlaceholder(item);
    if (item.mode === 'disabled') throw error('This cloud flow is explicitly disabled locally.', 503);
    const correlationId = currentRequest()?.correlationId ?? null;
    const context = {
      record: flow,
      workflows: workflowsView(),
      input,
      identity,
      store,
      portal,
      serviceProfile: registeredOperations.flowIdentities.get(
        String(flow.processId ?? '')
          .replace(/[{}]/g, '')
          .toLowerCase(),
      ),
      steps: item.configuration?.steps,
      diagnostic: (entry) => recordDiagnostic({ ...entry, correlationId }),
      connectors: organizationHost.connectors,
      context: { correlationId, secrets: organizationHost.providers.secrets },
    };
    if (item.mode === 'handler' && !flowHandler) operationPlaceholder(item);
    return item.mode === 'mock'
      ? {
          status: item.configuration.status ?? 200,
          body: Object.hasOwn(item.configuration, 'body') ? item.configuration.body : {},
        }
      : item.mode === 'exported'
        ? await (async () => {
            let failure;
            const value = await store.transact(async () => {
              try {
                return await runExportedCloudFlow(context);
              } catch (error) {
                failure = error;
                return null;
              }
            });
            if (failure) throw failure;
            return value;
          })()
        : await flowHandler({ ...context, runExportedCloudFlow: () => runExportedCloudFlow(context) });
  };
  const executeServerLogic = async ({ name, method = 'GET', operation, body = '', input = '', query = {} }) => {
    const record = operationPortal().serverLogics.find(
      (record) => record.name.toLowerCase() === String(name).toLowerCase(),
    );
    const handler = registeredOperations.serverLogics.get(record?.name.toLowerCase());
    if (!record || config().mode === 'live') return null;
    assertServerLogicEnabled(portal, (entry) => recordDiagnostic({ ...entry, name: record.name }));
    const identity = currentIdentity();
    assertOperationRole(record, identity);
    const item = operations().find((item) => item.kind === 'server-logic' && item.id === record.id);
    if (item.mode === 'placeholder') operationPlaceholder(item);
    if (item.mode === 'disabled') throw error('This backend operation is explicitly disabled locally.', 503);
    if (item.mode === 'mock') {
      if ((item.configuration.status ?? 200) >= 400)
        throw error('Configured local operation failure.', item.configuration.status, 'LocalOperationMockFailure');
      return JSON.stringify(Object.hasOwn(item.configuration, 'body') ? item.configuration.body : {});
    }
    // The site's application user exists with the site on the platform. Provision the local one here, before the
    // bounded run: its one-time creation is a persisted transaction (host work), never exported-code time, so a first
    // Dataverse.InvokeCustomApi must not spend the run's local time limit on it. Idempotent once it exists.
    await portalApplicationUser();
    const context = {
      record,
      portal,
      store,
      identity,
      method,
      operation,
      body,
      input,
      query,
      environmentVariables: environmentVariablePayload(store.state),
      services: serverLogicServices(),
    };
    if (item.mode === 'exported') return runExportedServerLogic(context);
    if (!handler) operationPlaceholder(item);
    const answer = await handler({ ...context, runExportedServerLogic: () => runExportedServerLogic(context) });
    return typeof answer === 'string' ? answer : JSON.stringify(answer ?? null);
  };
  const formSubmissionOptions = (formIdentity, visitor, pageTarget) => {
    const formLanguage = renderer.requestLanguage(pageTarget);
    const associateFormRecord = async (entity, id, navigation, targetId, _identity) => {
      const mapping = liveMapping(entity),
        target = liveMapping(mapping.relationships?.[navigation]?.entity);
      const response = await live.request(`/_api/${mapping.entitySet}(${encodeURIComponent(id)})/${navigation}/$ref`, {
        method: 'POST',
        body: Buffer.from(JSON.stringify({ '@odata.id': `${live.origin}/_api/${target.entitySet}(${targetId})` })),
        contentType: 'application/json',
      });
      if (response.status >= 400)
        throw error(`Live form association returned HTTP ${response.status}.`, response.status, 'LIVE_BRIDGE');
    };
    return {
      portal,
      store,
      identity: formIdentity,
      // FileStorage/CloudStorageAccount: attachment bytes go to storage route portalCloudAttachments (lib/form-service.mjs).
      cloudAttachments: () => organizationHost.providers.storage.forRoute('portalCloudAttachments'),
      diagnostic: recordDiagnostic,
      schemas: {
        ...solutionMetadata.componentSchemas,
        ...config().componentSchemas,
      },
      metadata: solutionMetadata,
      readProvider,
      writeProvider: {
        create: (entity, values, identity) => writeFormRecord(entity, null, values, identity),
        update: writeFormRecord,
        associate: async (entity, id, navigation, targetId, identity) =>
          config().mode !== 'live'
            ? store.associate(entity, id, navigation, targetId, identity)
            : associateFormRecord(entity, id, navigation, targetId, identity),
        // A submission's record, associations and notes form one unit. Locally the
        // store transaction restores everything on failure; the live bridge has no
        // transaction, so the records the unit created are deleted again.
        transaction: async (work) => {
          if (config().mode !== 'live')
            return store.transact(
              () =>
                work({
                  ...portalRecordWrites(store),
                  associate: (entity, id, navigation, targetId, identity) =>
                    store.changeAssociationRecord(entity, id, navigation, targetId, identity, true),
                }),
              { incremental: true },
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
                .request(`/_api/${liveMapping(row.entity).entitySet}(${encodeURIComponent(row.id)})`, {
                  method: 'DELETE',
                })
                .catch(() => ({ status: 0 }));
              if (!(response.status >= 200 && response.status < 300))
                recordDiagnostic({
                  code: 'FORM_UNIT_COMPENSATION_FAILED',
                  severity: 'error',
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
      provenance: false,
      metadata: solutionMetadata,
      codeCatalogue: codeComponents,
      render,
      observed: config().observed ?? source.observed,
      serverLogic: async ({ name, operation, input }) => {
        try {
          const raw = await executeServerLogic({ name, operation, input });
          if (raw === null) return null;
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
          return { success: true, status_code: 200, data, raw_result: raw };
        } catch (cause) {
          recordDiagnostic({ code: cause.code ?? 'SERVER_LOGIC_FAILED', name, message: cause.message });
          return { success: false, status_code: cause.status ?? 500, data: null, raw_result: '' };
        }
      },
      observationOrigin: live.origin,
      sourceDependencies,
      fetchXml: async (xml, _user, _request, fetchOptions) => {
        const empty =
          config().mode === 'live'
            ? null
            : emptyUnmappedLiquidFetchXml(xml, {
                observed: config().observed ?? source.observed,
                resolveMapping: (name) => store.resolveMapping(name),
              });
        return (
          empty ??
          readProvider.fetchXml(xml, currentIdentity(), {
            ...fetchOptions,
            diagnostic: (entry) => recordDiagnostic({ ...entry, path: _request?.path }),
          })
        );
      },
      previewFetchXml: (xml, _user, _request, fetchOptions) => {
        if (config().mode === 'live')
          throw error(
            'A local permission preview cannot qualify remote Liquid execution.',
            501,
            'LocalFetchPreviewUnsupported',
          );
        return store.previewPermissionFetchXml(xml, currentIdentity(), fetchOptions);
      },
      entity: async (entity, id) =>
        observedLiquidEntityRead(
          () => readProvider.get(entity, id, currentIdentity()),
          config().observed ?? source.observed,
        ),
      renderComponent: async (kind, args, context) => {
        if (kind === 'codecomponent') {
          const bindings = [];
          const html = renderCodeComponent({
            name: args?.name ?? args?.id,
            args,
            portal,
            catalog: codeComponents,
            metadata: solutionMetadata,
            language: context?.__language ?? portal.language,
            identity: currentIdentity(),
            mappings: store.snapshot({ sections: ['mappings'] }).mappings,
            diagnostic: (entry) => recordDiagnostic({ ...entry, path: context?.request?.path }),
            onRendered: (binding) => bindings.push(binding),
          });
          const index = renderer.sourceIndex(context?.__language?.id);
          return {
            html,
            renderProvenance: bindings.map((binding) => ({
              ...binding,
              sourceRefIds: index.metadataIndex.sourceRefsFor([binding.component.key]).map((ref) => ref.id),
            })),
          };
        }
        const progressBindings = [];
        const renderedComponent = await renderComponent(
          kind,
          typeof args === 'string' ? args : (args?.name ?? args?.id ?? args?.key ?? ''),
          context,
          {
            portal,
            store,
            readProvider,
            args: typeof args === 'string' ? { name: args } : (args ?? {}),
            serviceFixtures: organizationHost.providers.serviceFixtures,
            metadata: solutionMetadata,
            codeComponent: (spec) =>
              renderCodeComponent({
                ...spec,
                portal,
                catalog: codeComponents,
                metadata: solutionMetadata,
                language: context?.__language ?? portal.language,
                identity: currentIdentity(),
                mappings: store.snapshot({ sections: ['mappings'] }).mappings,
                diagnostic: (entry) => recordDiagnostic({ ...entry, path: context?.request?.path }),
              }),
            config: config(),
            observed: config().observed ?? portal.observed,
            managedControls: config().managedControls ?? config().shellProfile?.managedControls,
            sourceDependencies,
            richTextCompatibility: richTextCompatibility(),
            schemas: {
              ...solutionMetadata.componentSchemas,
              ...config().componentSchemas,
            },
            renderLiquid: (source, ctx) => renderer.renderString(source, ctx),
            webFormSessions,
            webFormOwner: () => webFormSessionOwner(currentIdentity(), trace.getStore()?.visitor),
            onNativePostbackDescriptor:
              nativeFormTransport(config().observed ?? portal.observed) === 'postback'
                ? (item) => trace.getStore()?.nativePostbacks?.push(item)
                : undefined,
            nativePostbackState: trace.getStore()?.nativePostbackState,
            onProgressRendered: (binding) => progressBindings.push(binding),
            // Component diagnostics name the page that rendered the component.
            diagnostic: (entry) => recordDiagnostic({ ...entry, path: entry.path ?? context?.request?.path }),
          },
        );
        if (!progressBindings.length) return renderedComponent;
        const index = renderer.sourceIndex(context?.__language?.id);
        const renderProvenance = progressBindings.map((binding) => ({
          ...binding,
          sourceRefIds: binding.sourceSelectors.flatMap((selector) => {
            const source = index.source({ id: selector.recordId }, selector.field, selector);
            return source && !source.ambiguous ? [source.id] : [];
          }),
        }));
        return typeof renderedComponent === 'string'
          ? { html: renderedComponent, renderProvenance }
          : { ...renderedComponent, renderProvenance };
      },
      user: currentIdentity(),
      shellProfile: config().shellProfile,
    });
  renderer = buildRenderer();
  let localOrigin;
  const recordCapabilitiesSummary = createRecordCapabilitiesSummary(store);
  const runtimeState = ({ reuseCapabilities = false } = {}) => ({
    runtime: runtimeOption,
    // capabilities: the registry's legacy summary; capabilityReport: its records, missing prerequisites and gaps.
    ...organizationHost.capabilityStatus({ reuse: reuseCapabilities }),
    inventory: inventorySummary(solutionInventory),
    providers: providerDescriptors(organizationHost.providers),
    services: organizationHost.providers.serviceFixtures?.describe() ?? [],
    links: {
      administration: '/_sim/',
      setup: '/_setup/',
      modelDriven: modelDrivenSettingsValue.enabled === false ? null : '/main.aspx',
      powerPages: '/',
      dataverseApi: dataverse?.origin ?? null,
    },
    simulation: organizationHost.simulationReport(storageAdapter?.report(store.state) ?? simulationReport()),
    recordCapabilities: recordCapabilitiesSummary({ reuse: reuseCapabilities }),
  });
  const exposedState = ({ summary = false } = {}) => {
    const state = summary ? store.summary() : store.snapshot();
    const cfg = config();
    const identityModel = buildPermissionModel(portal, state, {
      relationships: solutionData.relationships,
    });
    const permissionModel = appliedPermissionModel;
    const effectiveIdentity = currentIdentity(),
      visibleCounts = {};
    // The counts belong to the principal of the request's session (the signed-in visitor), else the configured persona; a /_sim
    // request carries no visitor identity of its own (requestAuth), so the session's is resolved here.
    const session = trace.getStore()?.auth?.session;
    const countIdentity =
      session && config().mode !== 'live'
        ? trace.run({ ...trace.getStore(), auth: { session, identity: sessionIdentity(session) } }, currentIdentity)
        : effectiveIdentity;
    for (const entity of Object.keys(summary ? state.tableCounts : (state.tables ?? {}))) {
      try {
        // Through the visitor's enhanced-authorization mapping, previewed when no portal request has made it yet (/_sim never
        // provisions it: portal-authorization.mjs filterRules).
        visibleCounts[entity] = store.rowCount(entity, { ...countIdentity, mappingPreview: true });
      } catch (err) {
        visibleCounts[entity] = `Unavailable: ${err.code ?? err.message}`;
      }
    }
    return {
      csrf,
      ...runtimeState(),
      dataverse: dataverseSummary(),
      docs: DOCS,
      config: {
        ...cfg,
        confinePortalPages: cfg.confinePortalPages === true,
        contentPolicySource: cfg.contentPolicySource ?? 'runtime state',
        permissionMode: state.settings.permissionMode,
        mappings: Object.entries(state.mappings ?? {}).map(([logicalName, m]) => ({
          id: logicalName,
          logicalName,
          ...m,
        })),
        plugins: state.plugins ?? [],
        permissions: state.permissions ?? [],
        presets: listPresets({ state, library: generatedPresets }),
        endpoints: cfg.endpoints ?? [],
        operations: operations(),
        portalSettings: portalOverrideEntries(sourcePortal, cfg.portalOverrides, 'settings'),
        portalSnippets: portalOverrideEntries(sourcePortal, cfg.portalOverrides, 'snippets'),
        portalRoles: portalOverrideEntries(sourcePortal, cfg.portalOverrides, 'roles'),
        platformSettings: platformSettingEntries(state),
        experimentPresets: experimentPresets(state, sourcePortal, packConfigurations.presets),
      },
      ...(!summary ? { data: state.tables } : {}),
      status: {
        ...runtimeState(),
        richTextConfigurations: richTextConfigurationStatus(
          portal,
          cfg.shellProfile?.richTextConfigurations,
          live.origin,
        ),
        tableCounts: summary
          ? state.tableCounts
          : Object.fromEntries(Object.entries(state.tables ?? {}).map(([name, rows]) => [name, rows.length])),
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
            ...permissionModel.diagnostics.filter((d) => !d.code.startsWith('PERSONA_')),
            ...identityModel.diagnostics.filter((d) => d.code.startsWith('PERSONA_')),
          ],
        },
        sourceDir: portal.sourceDir,
        solutionRoots,
        sourceFingerprint: fingerprint,
        project: projectStatus(),
        bootstrap: bootstrapStatus(),
        confinement: confinementStatus(),
        platformStyles: platformStylesStatus(config().shellProfile),
        localOverrides,
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
          .filter((record) => record.kind === 'webrole')
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
          message: 'Exact parity requires a passing comparison for this route, identity, data and viewport.',
        },
      },
      diagnostics: [
        ...portal.diagnostics,
        ...packConfigurations.diagnostics,
        ...configurationPresetCollisions(store.state, packConfigurations.presets),
        ...(activeProfiles.diagnostics ?? []),
        ...(cfg.importDiagnostics ?? []),
        ...permissionModel.diagnostics,
        ...diagnostics,
      ],
      requests: [...requests],
    };
  };
  const change = (fn) => {
    const next = mutation.then(async () => {
      const result = await fn();
      if (managementStorage) {
        try {
          await refreshManagementSource();
        } catch (cause) {
          recordDiagnostic({ code: 'MODEL_DRIVEN_SOURCE_REFRESH', message: cause.message });
        }
      }
      return result;
    });
    mutation = next.catch(() => {});
    return next;
  };
  const saveState = async (state, { reload = true } = {}) => {
    // Keep the snapshot's original revision across source/profile I/O. SDK
    // transactions can commit outside the host mutation queue during that work.
    const expectedRevision = store.snapshotRevision(state) ?? store.revision;
    const previous = {
      portal,
      sourcePortal,
      activeProfiles,
      sourceDependencies,
      fingerprint,
      solutionMetadata,
      solutionData,
      operationWorkflows,
      solutionOperations,
      codeComponents,
      clientResources,
      generatedPresets,
      solutionScan,
      solutionInventory,
    };
    const pinChanged =
      JSON.stringify(state.simulator?.deploymentProfilePin ?? null) !==
      JSON.stringify(config().deploymentProfilePin ?? null);
    try {
      const recordsChanged = !isDeepStrictEqual(state.simulator?.modelDriven?.records, config().modelDriven?.records);
      if (
        pinChanged ||
        recordsChanged ||
        (managementStorage && !isDeepStrictEqual(state.simulator?.modelDriven?.records ?? {}, appliedManagementRecords))
      ) {
        activeProfiles = await loadDeploymentProfiles(profileConfig, state.simulator?.deploymentProfilePin ?? null);
        sourcePortal = await importSource(state.simulator?.modelDriven?.records);
        if (requirePortalSource) assertPortalSource(sourcePortal);
      }
      portal = applyPortalOverrides(await environmentBound(sourcePortal, state), state.simulator?.portalOverrides);
      if (pinChanged) {
        sourceDependencies = { ...(await discoverSourceDependencies(portal)), compat: localOverrides.compat };
        await loadSolutions();
        generatedPresets = initialState(portal, bootstrapOptions()).presets;
        store.presetLibrary = generatedPresets;
        fingerprint = await calculateFingerprint();
      }
      await replaceCompiledState(state, { expectedRevision });
    } catch (cause) {
      ({
        portal,
        sourcePortal,
        activeProfiles,
        sourceDependencies,
        fingerprint,
        solutionMetadata,
        solutionData,
        operationWorkflows,
        solutionOperations,
        codeComponents,
        clientResources,
        generatedPresets,
        solutionScan,
        solutionInventory,
      } = previous);
      store.presetLibrary = generatedPresets;
      throw cause;
    }
    live.configure(config().live ?? {});
    if (cache) cache.origin = live.origin;
    if (reload) {
      renderer = buildRenderer();
      revision++;
      for (const event of events) event.write(`event: reload\ndata: ${revision}\n\n`);
    }
    appliedManagementRecords = structuredClone(store.state.simulator?.modelDriven?.records ?? {});
  };
  // Source import happens after the record transaction commits. The short
  // publication transaction checks its overlay snapshot again, so background
  // SDK writes during source I/O cannot be overwritten by rematerialization.
  const refreshManagementSource = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const records = structuredClone(store.state.simulator?.modelDriven?.records ?? {});
      if (isDeepStrictEqual(records, appliedManagementRecords)) return;
      const imported = await importSource(records);
      const nextPortal = applyPortalOverrides(await environmentBound(imported, store.state), config().portalOverrides);
      const dependencies = { ...(await discoverSourceDependencies(nextPortal)), compat: localOverrides.compat };
      const previous = { portal, sourcePortal, sourceDependencies, appliedPermissionModel };
      let published = false;
      try {
        await store.transact(
          async () => {
            if (!isDeepStrictEqual(records, store.state.simulator?.modelDriven?.records ?? {})) return;
            sourcePortal = imported;
            portal = nextPortal;
            sourceDependencies = dependencies;
            await replaceCompiledState(store.snapshot(undefined, { forkTables: true }));
            published = true;
          },
          { isolated: true },
        );
      } catch (cause) {
        ({ portal, sourcePortal, sourceDependencies, appliedPermissionModel } = previous);
        throw cause;
      }
      if (!published) continue;
      appliedManagementRecords = records;
      renderer = buildRenderer();
      revision++;
      for (const event of events) event.write(`event: reload\ndata: ${revision}\n\n`);
      return;
    }
    throw error(
      'Source records changed repeatedly while compiling the local portal. Refresh will retry on the next request.',
      409,
      'SourceRefreshConflict',
    );
  };
  const applySelectedPreset = async (name, adjust, { applyConfiguration = false, returnState = true } = {}) => {
    const preset =
      name === startupPreset.name && startupPresetBody
        ? startupPresetBody
        : resolvePreset(store.state, name, generatedPresets, store.recordContext());
    if (preset === startupPresetBody) startupPresetBody = undefined;
    if (!preset) throw error('Preset not found.', 404);
    const replaced = ['mappings', 'tables', 'permissions', 'plugins', 'settings'].filter(
      (key) => preset[key] !== undefined,
    );
    // Preserve all unspecified state, without copying business sections that
    // this preset replaces. Organization-owned rows are retained explicitly.
    // Paged tables fork their immutable pages instead of materializing rows.
    const state = store.snapshot(
      { sections: Object.keys(store.state).filter((key) => !replaced.includes(key)) },
      { forkTables: true },
    );
    state.simulator ??= config();
    const organizationSections = {
      mappings: store.state.mappings,
      tables: store.state.tables,
      dataverse: store.state.dataverse,
    };
    for (const key of replaced)
      // resolvePreset returned a detached graph owned by this operation.
      if (preset[key] !== undefined) state[key] = preset[key];
    preserveOrganizationPresetSections(organizationSections, preset, state);
    if (preset.personaCatalog !== undefined)
      state.personaCatalog = validatePersonaCatalog(preset.personaCatalog, 'Preset ' + name);
    if (preset.identity) state.simulator.identity = structuredClone(preset.identity);
    if (preset.endpoints) state.simulator.endpoints = structuredClone(preset.endpoints);
    if (preset.contactRoles) state.simulator.contactRoles = structuredClone(preset.contactRoles);
    if (preset.personaRoles) {
      state.simulator.contactRoles = membershipsForRoles(portal, preset.personaRoles);
      state.simulator.identity = {
        ...state.simulator.identity,
        roleSource: 'memberships',
      };
    }
    if (preset.permissionSource) state.simulator.permissionSource = preset.permissionSource;
    // Scenarios adjust persona/permissions in the same state replacement as their preset.
    if (adjust) await adjust(state);
    if (applyConfiguration && preset.configurationPreset) {
      const configuration = experimentPresets(state, sourcePortal, packConfigurations.presets).find(
        (entry) => entry.id === preset.configurationPreset,
      );
      if (!configuration) throw error('Configuration preset not found: ' + preset.configurationPreset, 404);
      state.simulator = applyExperiment({ simulator: state.simulator }, configuration).simulator;
    }
    await saveState(state);
    return returnState ? exposedState() : undefined;
  };
  const validateConfig = (cfg) => {
    profileSelection(profileConfig, cfg.deploymentProfilePin ?? null);
    validatePlatformOverrides(cfg.platformOverrides);
    validateExperimentPresets(cfg.experimentPresets);
    validateOperationOverrides(cfg.operations);
    validatePortalOverrides(cfg.portalOverrides);
    externalFrameOrigins(cfg.externalFrameOrigins);
    for (const key of ['confinePortalPages', 'externalAssets'])
      if (cfg[key] !== undefined && typeof cfg[key] !== 'boolean') throw error(`${key} must be true or false.`);
    if (!['local', 'live'].includes(cfg.mode) || !['local', 'live'].includes(cfg.pageMode))
      throw error('mode and pageMode must be local or live.');
    if (!cfg.identity || !Array.isArray(cfg.identity.roles)) throw error('identity.roles must be an array.');
    if (cfg.identity.admin !== undefined)
      throw error(
        'identity.admin is reserved for internal simulator storage operations.',
        400,
        'IDENTITY_CAPABILITY_RESERVED',
      );
    if (cfg.identity.roles.some((role) => typeof role !== 'string'))
      throw error('identity.roles must contain role-name strings.');
    if (cfg.identity.roleSource && !['memberships', 'override'].includes(cfg.identity.roleSource))
      throw error('identity.roleSource must be memberships or override.');
    if (cfg.permissionSource && !['configured', 'exported', 'combined'].includes(cfg.permissionSource))
      throw error('permissionSource must be configured, exported or combined.');
    if (
      cfg.contactRoles &&
      (!Array.isArray(cfg.contactRoles) ||
        cfg.contactRoles.some(
          (assignment) =>
            !assignment || typeof assignment.contactId !== 'string' || typeof assignment.roleId !== 'string',
        ))
    )
      throw error('contactRoles must contain contactId and roleId assignments.');
    new LiveBridge(cfg.live ?? {});
    if (!Array.isArray(cfg.endpoints)) throw error('endpoints must be an array.');
  };
  // ---- Admin workspace helpers: personas, permission explanations, page inspection,
  // lightweight status, scenarios and environment configuration.
  const personaKey = (value) =>
    String(value ?? '')
      .replace(/[{}]/g, '')
      .toLowerCase();
  const identitySummary = (identity = currentIdentity()) => ({
    id: identity.id ?? null,
    contactId: identity.contactId ?? null,
    name: identity.name ?? null,
    accountId: identity.accountId ?? null,
    roles: identity.roles ?? [],
    roleIds: identity.roleIds ?? [],
    roleSource: identity.roleSource ?? 'override',
  });
  let personaCache;
  const personaReport = () => {
    const key = revision + ':' + store.dataRevision();
    if (personaCache?.key === key && personaCache.portal === portal) return personaCache.value;
    const state = store.snapshot({
      sections: ['simulator', 'settings', 'personaCatalog'],
      tables: ['contact', 'account'],
      mappings: ['contact', 'account'],
    });
    const model = buildPermissionModel(portal, state, { relationships: solutionData.relationships });
    const accountMapping = state.mappings?.account ?? {};
    const accounts = new Map(
      (state.tables?.account ?? []).map((row) => [
        personaContactId(row[accountMapping.idColumn ?? 'accountid']),
        row[accountMapping.nameColumn ?? 'name'],
      ]),
    );
    const contactMapping = state.mappings?.contact ?? {};
    const rows = new Map(
      (state.tables?.contact ?? []).map((row) => [personaContactId(row[contactMapping.idColumn ?? 'contactid']), row]),
    );
    const contacts = model.personas.map((contact) => ({
      ...contact,
      accountName: accounts.get(personaContactId(contact.accountId)) ?? null,
      email: rows.get(personaContactId(contact.contactId))?.emailaddress1 ?? '',
    }));
    const catalogs = (projectPacks ?? [])
      .filter((pack) => pack.personaCatalog)
      .map((pack) => ({ source: 'pack:' + pack.id, catalog: pack.personaCatalog }));
    if (state.personaCatalog) catalogs.push({ source: 'state', state: true, catalog: state.personaCatalog });
    const catalog = resolvePersonaCatalog({
      contacts,
      catalogs,
      defaultContactId: state.simulator?.identity?.contactId ?? state.simulator?.identity?.id,
    });
    let effective;
    for (const entry of [...catalogs].reverse()) effective = mergePersonaCatalogs(effective, entry.catalog);
    const value = {
      ...catalog,
      scope: createHash('sha256').update(sourceDir).digest('hex').slice(0, 20),
      roleSource: state.simulator?.identity?.roleSource ?? 'override',
      permissionMode: state.settings?.permissionMode ?? 'enforce',
      permissionSource: state.simulator?.permissionSource ?? 'configured',
      contactMapped: Boolean(state.mappings?.contact),
      personas: catalog.enabled ? catalog.personas : model.personas,
      webRoles: model.webRoles,
      memberships: model.memberships,
      contacts,
      catalog: effective ?? { version: 1, groups: [], personas: [] },
      stateCatalog: state.personaCatalog ?? null,
      catalogDigest: createHash('sha256')
        .update(JSON.stringify(state.personaCatalog ?? null))
        .digest('hex'),
      presets: listPresets({
        state: store.snapshot({ sections: ['presets', 'mappings'] }),
        library: generatedPresets,
      }).map((entry) => ({ id: entry.id, name: entry.name, unavailable: entry.unavailable })),
      deploymentProfiles: Object.keys(profileConfig.profiles),
      contextRuntime: personaInstance
        ? {
            id: personaInstance.id ?? null,
            label: personaInstance.label,
            ownerOrigin: personaInstance.ownerOrigin,
            isolated: true,
          }
        : null,
    };
    personaCache = { key, portal, value };
    return value;
  };
  const personasPayload = () => ({
    ...personaReport(),
    identity: identitySummary(),
    session: describeSession(trace.getStore()?.auth?.session),
    runtimes: personaRuntimes.list(),
  });
  const findPersona = (key) => {
    const report = personaReport(),
      persona = report.personas.find((entry) => entry.key === key);
    if (!report.enabled || !persona) {
      const closest = closestPersonaKeys(key, report.personas);
      throw error(
        'Unknown persona "' + key + '".' + (closest.length ? ' Closest keys: ' + closest.join(', ') : ''),
        404,
        'PersonaNotFound',
      );
    }
    return persona;
  };
  const personaRuntimes = createPersonaContexts({
    directory: path.join(projectRoot, '.paqvilo', 'persona-runtimes'),
    maxInstances: personaInstance ? 0 : (personaContextsOption.maxInstances ?? 4),
    snapshot: (file) =>
      store.readOperation(async () => {
        if (store.file) {
          await store.storage.assertUnchanged();
          await fs.copyFile(store.file, file);
          await store.storage.assertUnchanged();
        } else await new StateStorage(file).prepareCheckpoint(file, store.state);
        if (stateFile)
          for (const name of ['cache']) {
            const from = path.join(path.dirname(path.resolve(stateFile)), name);
            if (
              await fs.stat(from).then(
                () => true,
                (e) => {
                  if (e.code === 'ENOENT') return false;
                  throw e;
                },
              )
            )
              await fs.cp(from, path.join(path.dirname(file), name), { recursive: true });
          }
      }),
    // A persona instance inherits the parent's registered settings except its own listeners (dataverse) and kind (runtime).
    start: async ({ file, definition }) =>
      createSimulator({
        ...(await import('./lib/config-keys.mjs')).settingOptions(
          {
            ...settingOptionsRest,
            modelDriven: modelDrivenOption,
            simulation: simulationOption,
            sourceMaps,
            contentPolicyDefaults: policyDefaults,
          },
          { exclude: ['dataverse', 'runtime'] },
        ),
        sourceDir,
        stateFile: file,
        port: 0,
        host,
        watch,
        project,
        dataPacks,
        packs,
        solutionRoots,
        solutionOrder,
        deploymentProfiles,
        deploymentProfile,
        projectRoot,
        localOverrides,
        identityProvider: identityProviderOption,
        environmentVariables,
        observed: observedOption,
        render: renderOption,
        platform: platformOption,
        dataModel,
        personaInstance: { ...definition, ownerOrigin: localOrigin },
        preset: definition.preset,
        presetMode: 'always',
      }),
  });
  const launchPersona = async (body) => {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['personaKey', 'scenario', 'instanceKey', 'returnUrl'].includes(key)) ||
      Boolean(body.personaKey) === Boolean(body.scenario)
    )
      throw error('Choose exactly one personaKey or scenario.', 400, 'PersonaLaunchInvalid');
    if (
      body.instanceKey !== undefined &&
      (typeof body.instanceKey !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(body.instanceKey))
    )
      throw error(
        'instanceKey must be 1-80 letters, digits, dots, underscores or hyphens.',
        400,
        'PersonaLaunchInvalid',
      );
    const report = personaReport();
    const scenario = body.scenario ? report.scenarios.find((entry) => entry.id === body.scenario) : null;
    if (body.scenario && !scenario) throw error('Unknown persona scenario', 404, 'PersonaScenarioNotFound');
    const persona = findPersona(scenario?.persona ?? body.personaKey);
    const contextId = scenario?.context ?? persona.context;
    const definition = contextId ? report.contexts.find((entry) => entry.id === contextId) : null;
    const preset = scenario?.preset ?? definition?.preset;
    if (preset && !resolvePreset(store.snapshot({ sections: ['presets', 'mappings'] }), preset, generatedPresets))
      throw error('Preset not found: ' + preset, 404, 'PersonaPresetNotFound');
    if (definition?.deploymentProfile) {
      try {
        profileSelection(profileConfig, definition.deploymentProfile);
      } catch (cause) {
        throw error(cause.message, 400, 'PersonaContextProfile');
      }
    }
    const targetPath = personaStartPath(
      body.returnUrl ?? scenario?.startPath ?? persona.startPath ?? definition?.startPath ?? '/',
      body.returnUrl === undefined ? 'Persona startPath' : 'returnUrl',
    );
    if (
      personaInstance &&
      ((definition &&
        (definition.id !== personaInstance.id ||
          ['deploymentProfile', 'environmentVariables', 'portalOverrides'].some(
            (key) => JSON.stringify(definition[key]) !== JSON.stringify(personaInstance[key]),
          ))) ||
        (preset && preset !== personaInstance.preset))
    )
      throw error(
        'Open this setup from the parent runtime: ' + personaInstance.ownerOrigin,
        409,
        'PersonaContextOwnerRequired',
      );
    if ((definition || preset) && !personaInstance) {
      const opened = await personaRuntimes.open(definition ?? { label: scenario?.label ?? persona.label }, {
        scenario: scenario?.id,
        instanceKey: body.instanceKey,
        preset,
      });
      try {
        const signed = opened.runtime.signIn(persona.contactId);
        const { runtime, ...description } = opened;
        return {
          ...description,
          personaKey: persona.key,
          contactId: persona.contactId,
          path: targetPath,
          url: opened.origin + targetPath,
          cookieHeader: signed.cookieHeader,
          identity: signed.identity,
        };
      } catch (cause) {
        if (opened.created) await personaRuntimes.stop(opened.id);
        throw cause;
      }
    }
    const session = signInSession(persona.contactId);
    return {
      origin: localOrigin,
      url: localOrigin + targetPath,
      path: targetPath,
      personaKey: persona.key,
      contactId: persona.contactId,
      isolated: Boolean(personaInstance),
      browser: definition?.browser ?? {},
      cookieHeader: authSessions.name + '=' + authSessions.value(session),
      identity: describeSession(session),
    };
  };
  const PERMISSION_OPERATIONS = ['read', 'create', 'update', 'delete', 'append', 'appendTo'];
  /** Why the current persona may or may not use a table, from the applied grant ledger. */
  const tablePermissionSummary = (entity, identity, permissionMode) => {
    const applied = (appliedPermissionModel?.permissions ?? []).filter(
      (rule) => rule.entity === entity || rule.entity === '*',
    );
    const disabled = applied
      .filter((rule) => rule.enabled === false)
      .map((rule) => ({ id: rule.id, name: rule.name ?? rule.id, reason: rule.disabledReason ?? 'Disabled' }));
    const operations = {};
    for (const operation of PERMISSION_OPERATIONS) {
      if (permissionMode === 'permissive') {
        operations[operation] = {
          allowed: true,
          scoped: false,
          grants: [],
          reason: 'Permission enforcement is permissive: every local identity may use this table.',
        };
        continue;
      }
      let rules;
      try {
        rules = store.rules(entity, operation, identity);
      } catch {
        rules = [];
      }
      const grants = rules.map((rule) => ({
        id: rule.id,
        name: rule.name ?? rule.id,
        scope: rule.scope ?? 'global',
        provenance: rule.provenance?.type ?? (rule.imported ? 'portal-export' : 'local-configuration'),
        inheritedRoles: Boolean(rule.inheritedRoles),
      }));
      const global = grants.filter((grant) => grant.scope === 'global');
      const roles = (identity.roles ?? []).join(', ') || 'no web roles';
      operations[operation] = {
        allowed: grants.length > 0,
        scoped: grants.length > 0 && !global.length,
        grants,
        reason: global.length
          ? `Granted for all records by ${global.map((grant) => grant.name).join(', ')}.`
          : grants.length
            ? `Granted only for related records: ${grants.map((grant) => `${grant.name} (${grant.scope} scope)`).join(', ')}.`
            : applied.some((rule) => rule.enabled !== false)
              ? `No enabled ${operation} grant on this table includes the current roles (${roles}).`
              : 'No enabled table permission exists for this table.',
      };
    }
    return {
      mode: permissionMode === 'permissive' ? 'permissive' : 'enforce',
      operations,
      grantCount: applied.length,
      disabled,
    };
  };
  const inspectionCache = new Map();
  const renderProofs = new Map();
  const scriptProofs = new Map();
  // Page inspection answers with the identity that a portal request for the inspected page,
  // carrying the same cookies, would get (requestAuth): the session, otherwise anonymous.
  const inspectionIdentity = (req, route) => {
    const auth = requestAuth({ headers: req.headers }, new URL(route, 'http://mirage.invalid'));
    return auth.identity ? trace.run({ auth }, currentIdentity) : currentIdentity();
  };
  const inspectRoute = (route, identity = currentIdentity()) => {
    const permissionMode = store.snapshot({ sections: ['settings'] }).settings?.permissionMode ?? 'enforce';
    const key = JSON.stringify([
      revision,
      store.dataRevision(),
      route,
      identity.contactId ?? identity.id ?? null,
      identity.accountId ?? null,
      identity.roles ?? [],
      identity.roleIds ?? [],
      identity.roleSource ?? null,
      permissionMode,
    ]);
    if (inspectionCache.has(key)) return inspectionCache.get(key);
    const mappings = store.snapshot({ sections: ['mappings'] }).mappings ?? {};
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
      sourceRevision: renderer.sourceIndex().sourceRevision,
      portalSources: renderer.sourceIndex().snapshot(report),
      portalProfile: {
        deploymentProfile: portal.deploymentProfile ?? null,
        deploymentProfileFile: portal.deploymentProfileFile ?? null,
      },
      revision,
      identity: identitySummary(identity),
      permissionMode,
      sourceRoots: [
        ...new Set(
          [
            sourceDir,
            ...solutionRoots,
            ...(solutionMetadata.plugins?.sourceRoots ?? []),
            ...(report.sourceRoots ?? []),
          ].filter(Boolean),
        ),
      ],
    };
    inspectionCache.set(key, value);
    if (inspectionCache.size > 24) inspectionCache.delete(inspectionCache.keys().next().value);
    return value;
  };
  const allDiagnostics = (cfg = config()) => [
    ...packConfigurations.diagnostics,
    ...configurationPresetCollisions(store.state, packConfigurations.presets),
    ...(activeProfiles.diagnostics ?? []),
    ...portal.diagnostics,
    ...(cfg.importDiagnostics ?? []),
    ...(appliedPermissionModel?.diagnostics ?? []),
    ...(solutionMetadata.diagnostics ?? []),
    // Source loader failures (unreadable roots, invalid XML/YAML) stay visible in status; serve continues, preflight blocks.
    ...(solutionScan?.diagnostics ?? []).filter((item) => item.severity === 'error' && !item.inventory),
    ...diagnostics,
  ];
  /** Cheap runtime status for the toolkit panel and tools; no fingerprints are recomputed. */
  const statusPayload = () => {
    const state = store.snapshot({ sections: ['settings', 'simulator'] });
    const cfg = config(state.simulator);
    const all = allDiagnostics(cfg);
    return {
      csrf,
      ...runtimeState({ reuseCapabilities: true }),
      dataverse: dataverseSummary(),
      site: portal.website?.name ?? portal.website?.adx_name ?? null,
      format: portal.format,
      sourceDir: portal.sourceDir,
      solutionRoots,
      stateFile,
      platformStyles: platformStylesStatus(cfg.shellProfile),
      localOverrides,
      startupPreset,
      activeConfigurationPreset: cfg.activeExperiment ?? null,
      deploymentProfile: portal.deploymentProfile ?? null,
      profileSelection: deploymentProfilesSummary(profileConfig, activeProfiles),
      render,
      platformSettings: platformSettingEntries(state),
      observed: cfg.observed,
      richText: {
        mode: richTextCompatibility(cfg) ? 'compatibility' : 'native',
        nativeReady: nativeRichTextReady(cache?.manifest(), cfg.shellProfile, live.origin),
      },
      subgridLabelMarkup: cfg.observed?.subgridLabelMarkup ?? 'sanitized',
      sourceFingerprint: fingerprint,
      loadedImplementationFingerprint: implementationFingerprint,
      revision,
      reloading: Boolean(reloadPromise),
      pendingReload: Boolean(reloadPromise) && reloadRequested,
      pageCount: portal.pages.length,
      diagnostics: { total: all.length, byCode: diagnosticsByCode(all) },
      audit: { retained: audit.entries.length, latestSequence: audit.sequence },
      identity: identitySummary(),
      permissionMode: state.settings?.permissionMode ?? 'enforce',
      permissionSource: state.simulator?.permissionSource ?? 'configured',
      mode: state.simulator?.mode ?? 'local',
      pageMode: state.simulator?.pageMode ?? 'local',
      // The local sign-in page (exported LoginPath, else the observed one, else /signin).
      signInPath: signInPath(portal).path,
      // External sign-in: the local identity provider's origin and port, and the site's providers.
      identityProvider: externalSignIn?.status() ?? {
        available: false,
        reason: 'The local identity provider is not running.',
      },
      // Loopback confinement of local portal pages (opt-in) and its exceptions.
      confinePortalPages: state.simulator?.confinePortalPages === true,
      contentPolicySource: cfg.contentPolicySource ?? 'runtime state',
      externalAssets: state.simulator?.externalAssets === true,
      externalFrameOrigins: Array.isArray(state.simulator?.externalFrameOrigins)
        ? state.simulator.externalFrameOrigins.length
        : 0,
      presets: structuredClone(listPresets({ state: { presets: store.state.presets }, library: generatedPresets })),
      scenarios: Array.isArray(state.simulator?.scenarios) ? state.simulator.scenarios : [],
      activeScenario: state.simulator?.activeScenario ?? null,
      live: live.status(),
      // "disabled" unless the runtime was started with --allow-live-writes; then "off" or "enabled".
      liveWrites: live.status().liveWrites,
      localOrigin,
      adminUrl: `${localOrigin}/_sim/`,
      docs: DOCS,
      // Imported model-driven apps and the /_sim/api route prefixes this host mounts (the admin app reads them instead of probing).
      modelDrivenApps: modelDrivenAppsOf(solutionMetadata),
      routes: simApiRoutes(
        DASHBOARD_ROUTES,
        PACK_ROUTES,
        MESSAGING_ROUTES,
        FLOW_ROUTES,
        coreAdmin.routes,
        PORTAL_ADMIN_ROUTES,
        ENVIRONMENT_ROUTES,
      ),
      // Admin-adjacent routes outside /_sim/api (model-driven/http.mjs routes): full paths, never probed by the admin app.
      adminAdjacentRoutes: MODEL_DRIVEN_ROUTES,
    };
  };
  const SCENARIO_FIELDS = ['id', 'name', 'description', 'preset', 'persona', 'permissionMode', 'permissionSource'];
  const validateScenario = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('A scenario must be a JSON object.');
    for (const key of Object.keys(value))
      if (!SCENARIO_FIELDS.includes(key)) throw error(`Unknown scenario field: ${key}`);
    if (typeof value.id !== 'string' || !/^[\w.-]{1,80}$/.test(value.id))
      throw error('Scenario id must have 1-80 letters, numbers, dots, underscores or hyphens.');
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160)
      throw error('Scenario name is required (at most 160 characters).');
    if (value.description !== undefined && typeof value.description !== 'string')
      throw error('Scenario description must be text.');
    if (value.preset !== undefined && value.preset !== null && (typeof value.preset !== 'string' || !value.preset))
      throw error('Scenario preset must be a preset ID.');
    if (
      value.persona !== undefined &&
      value.persona !== null &&
      (typeof value.persona !== 'object' ||
        Array.isArray(value.persona) ||
        typeof value.persona.contactId !== 'string' ||
        !value.persona.contactId ||
        Object.keys(value.persona).some((key) => key !== 'contactId'))
    )
      throw error('Scenario persona must be null (anonymous) or { contactId }.');
    if (value.permissionMode !== undefined && !['enforce', 'permissive'].includes(value.permissionMode))
      throw error('Scenario permissionMode must be enforce or permissive.');
    if (
      value.permissionSource !== undefined &&
      !['configured', 'exported', 'combined'].includes(value.permissionSource)
    )
      throw error('Scenario permissionSource must be configured, exported or combined.');
    if (!value.preset && value.persona === undefined && !value.permissionMode && !value.permissionSource)
      throw error('A scenario must select a preset, a persona or a permission setting.');
    return value;
  };
  /** Persona and permission parts of a scenario, applied to a state before it is saved. */
  const scenarioAdjustment = (scenario) => (state) => {
    state.simulator ??= config();
    if (scenario.persona !== undefined) {
      const contactId = scenario.persona ? personaKey(scenario.persona.contactId) : null;
      if (contactId) {
        const idColumn = state.mappings?.contact?.idColumn ?? 'contactid';
        if (!(state.tables?.contact ?? []).some((row) => personaKey(row[idColumn]) === contactId))
          throw error(
            `Scenario persona ${contactId} is not a local contact after applying the scenario.`,
            409,
            'SCENARIO_PERSONA_UNAVAILABLE',
          );
      }
      state.simulator.identity = contactId
        ? { id: contactId, contactId, roleSource: 'memberships', roles: [] }
        : { id: null, roleSource: 'memberships', roles: [] };
    }
    if (scenario.permissionMode) state.settings = { ...state.settings, permissionMode: scenario.permissionMode };
    if (scenario.permissionSource) state.simulator.permissionSource = scenario.permissionSource;
    state.simulator.activeScenario = { id: scenario.id, name: scenario.name, appliedAt: new Date().toISOString() };
    validateConfig(state.simulator);
  };

  const tableMapping = (entity) => {
    try {
      return store.resolveMapping(entity);
    } catch {
      return null;
    }
  };

  /** Environment variable definitions joined with their current local values, when imported (sim-environment-routes.mjs). */
  const environmentVariableTable = () =>
    sharedEnvironmentVariableTable(store, { secrets: organization?.api?.secrets ?? null });
  async function largeJsonBody(req, limit = 256 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw error('State import exceeds 256 MiB.', 413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw error('State import must be valid JSON.');
    }
  }
  // Simulated Dataverse administration (/_sim/api/dataverse...). Writes run through store transactions;
  // store.transact is not re-entrant, so each transaction below is a separate call.
  const dataverseAdmin = createDataverseAdmin({
    store,
    getDataverse: () => dataverse ?? organization,
    dataverseConfig,
    dataverseSummary,
    managedIdentitySummary,
    managedIdentityList,
    environmentValue,
    json,
    jsonObjectBody,
    change,
  });

  const staffSession = createStaffSessionHandler({
    sessions: staffSessions,
    csrf: () => csrf,
    json,
    readBody: jsonObjectBody,
  });
  // A web file's bytes from storage route portalWebFiles (WebFiles/StorageLocation AzureBlobStorage); never the export file.
  const cloudWebFile = async (id, name, requestPath) => {
    const unavailable = (message) => {
      recordDiagnostic({ code: 'WEBFILE_CLOUD_STORAGE_UNAVAILABLE', severity: 'error', path: requestPath, message });
      return error(message, 503, 'WEBFILE_CLOUD_STORAGE_UNAVAILABLE');
    };
    let provider;
    try {
      provider = organizationHost.providers.storage.forRoute('portalWebFiles');
    } catch (cause) {
      throw unavailable(
        `WebFiles/StorageLocation is AzureBlobStorage, but storage route portalWebFiles is unavailable: ${cause.message}`,
      );
    }
    if (!provider)
      throw unavailable(
        'WebFiles/StorageLocation is AzureBlobStorage, but storage route portalWebFiles serves the export; set providers.routes.portalWebFiles to a storage provider.',
      );
    try {
      const { body } = await provider.get(
        `webfiles/${String(id).replace(/[{}]/g, '').toLowerCase()}/${name.toLowerCase()}`,
      );
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (cause) {
      throw unavailable(
        `Web file ${name} is not available from storage route portalWebFiles (${cause.code ?? 'Error'}).`,
      );
    }
  };
  // Note and attachment bodies for the portal readers (native services, /_api): inline or from the storage provider.
  const noteAttachmentBody = (logical, row, options) => organizationHost.attachmentBody(logical, row, options);
  // /_sim/api/messages and /_sim/api/outbox (sim-messaging-routes.mjs), created once the organization exists.
  let messagingRoutes = null;
  // /_sim/api/flow-runs and /_sim/api/flow-waits (sim-flow-routes.mjs) answer next to them.
  let flowRoutes = null;
  // The Power Pages part of the dashboard feed: portal listener, identity provider, persona runtimes, live bridge, PCF
  // controls, audit, diagnostics by code, reload revision, deployment profile and the last 20 portal requests.
  const dashboardExtras = () => {
    const all = allDiagnostics();
    const identityProvider = externalSignIn?.status() ?? { available: false };
    const runtimes = personaRuntimes.list().items ?? [];
    const bridge = live.status(),
      settings = config(),
      liveMode = [settings.mode, settings.pageMode].includes('live');
    // Enhanced authorization maps web roles to security roles and contacts to staff users (portal-authorization.mjs).
    const enhanced = portalAuthorizationModel(portal.website).model === 'enhanced';
    const cloudWebFiles =
      String(siteSetting(portal, 'WebFiles/StorageLocation') ?? '')
        .trim()
        .toLowerCase() === 'azureblobstorage';
    const trusted = modelDrivenSettingsValue.enabled !== false && modelDrivenSettingsValue.trustedExtensions === true;
    return {
      runtime: {
        simulationLevel: simulationReport(simulation).level,
        revision,
        reloading: Boolean(reloadPromise),
        localOrigin,
        stateFile:
          simulation?.level === 'dry-run' || !stateFile
            ? null
            : path.relative(projectRoot, stateFile).split(path.sep).join('/'),
        projectRoot: '.',
        deploymentProfile: portal.deploymentProfile ?? null,
      },
      nodes: [
        {
          id: 'client:browser',
          kind: 'client',
          label: 'Portal visitors',
          status: 'ready',
          detail: {},
          link: '#access',
        },
        { id: 'client:staff', kind: 'client', label: 'Staff browser', status: 'ready', detail: {}, link: '#dataverse' },
        {
          id: 'host:portal',
          kind: 'host',
          label: 'Power Pages portal',
          status: 'listening',
          detail: {
            origin: localOrigin,
            pages: portal.pages.length,
            deploymentProfile: portal.deploymentProfile ?? null,
          },
          link: '#overview',
        },
        {
          id: 'host:model-driven',
          kind: 'host',
          label: 'Model-driven apps',
          status: modelDrivenSettingsValue.enabled === false ? 'disabled' : 'listening',
          detail: { path: modelDrivenSettingsValue.enabled === false ? null : '/main.aspx' },
          link: '#dataverse',
        },
        {
          id: 'host:identity-provider',
          kind: 'host',
          label: 'Visitor sign-in provider',
          status: identityProvider.available ? 'listening' : 'disabled',
          detail: {
            port: identityProvider.port ?? null,
            providers: Array.isArray(identityProvider.providers) ? identityProvider.providers.length : 0,
          },
          link: '#access',
        },
        { id: 'host:setup', kind: 'host', label: 'Setup workspace', status: 'listening', detail: { path: '/_setup/' } },
        { id: 'host:admin', kind: 'host', label: 'Administration', status: 'listening', detail: { path: '/_sim/' } },
        {
          id: 'app:pcf',
          kind: 'app',
          label: 'Code components',
          status: codeComponents.controls.size ? 'ready' : 'disabled',
          detail: { controls: codeComponents.controls.size },
          link: '#capabilities',
        },
        {
          id: 'bridge:live',
          kind: 'bridge',
          label: 'Live portal connection',
          status: bridge.connected ? 'ready' : 'disabled',
          detail: { connected: bridge.connected, host: hostnameOf(bridge.origin), liveWrites: bridge.liveWrites },
          link: '#connection',
        },
        ...runtimes.map((item) => ({
          id: `persona-runtime:${item.id}`,
          kind: 'persona-runtime',
          label: item.label ?? item.id,
          status: item.status === 'running' ? 'listening' : 'disabled',
          detail: { context: item.context ?? null, scenario: item.scenario ?? null, createdAt: item.createdAt ?? null },
          link: '#access',
        })),
      ],
      edges: [
        { from: 'client:browser', to: 'host:portal', kind: 'http', status: 'listening', label: 'pages' },
        { from: 'client:staff', to: 'host:model-driven', kind: 'http', status: 'listening', label: 'browser' },
        { from: 'client:staff', to: 'host:admin', kind: 'http', status: 'listening', label: 'administer' },
        { from: 'client:staff', to: 'host:setup', kind: 'http', status: 'listening', label: 'configure' },
        // Liquid, forms and /_api read and write records under table permissions; with enhanced authorization as the mapped staff user.
        {
          from: 'host:portal',
          to: 'org:store',
          kind: 'process',
          status: 'ready',
          label: 'records (table permissions)',
        },
        {
          from: 'host:portal',
          to: 'org:security',
          kind: 'process',
          status: enhanced ? 'ready' : 'disabled',
          label: enhanced ? 'web roles as security roles' : 'enhanced authorization only',
        },
        {
          from: 'host:portal',
          to: 'org:flows',
          kind: 'process',
          status: 'ready',
          label: 'cloud flows (/_api/cloudflow)',
        },
        {
          from: 'host:portal',
          to: 'provider:storage-route:portalWebFiles',
          kind: 'storage',
          status: cloudWebFiles ? 'ready' : 'disabled',
          label: cloudWebFiles ? 'web files' : 'web files (only with cloud storage)',
        },
        {
          from: 'host:portal',
          to: 'provider:storage-route:annotations',
          kind: 'storage',
          status: 'ready',
          label: 'upload staging',
        },
        {
          from: 'host:portal',
          to: 'provider:storage-route:portalCloudAttachments',
          kind: 'storage',
          status: 'ready',
          label: 'form attachments',
        },
        {
          from: 'host:portal',
          to: 'org:sharepoint-documents',
          kind: 'process',
          status: 'ready',
          label: 'document grid',
        },
        {
          from: 'host:portal',
          to: 'provider:service-fixture:powerBi',
          kind: 'process',
          status: 'ready',
          label: 'powerbi tag',
        },
        // Site settings bound to secret environment variables, and server logic calling custom APIs (bindPortalEnvironment, invokeCustomApi).
        { from: 'host:portal', to: 'provider:secrets', kind: 'reads', status: 'ready', label: 'secret site settings' },
        {
          from: 'host:portal',
          to: 'org:dataverse-customapi',
          kind: 'process',
          status: 'ready',
          label: 'server logic actions',
        },
        // A signed-in visitor mapped to a staff user can drive canvas apps (canvasPrincipal, enhanced authorization).
        {
          from: 'client:browser',
          to: 'app:canvas',
          kind: 'http',
          status: enhanced ? 'ready' : 'disabled',
          label: enhanced ? 'visitor apps' : 'visitor apps (enhanced authorization only)',
        },
        // The model-driven shell calls /_apps/api on this origin: records and Web API messages in process as the staff user. It
        // does not use the Web API listener and works with it switched off (dataverse-model-driven.mjs).
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
        // Visitor sign-in: the browser is sent to the provider, the portal reads its discovery, token and userinfo, and its
        // chooser lists the contacts of the store (sign-in-flow.mjs).
        {
          from: 'client:browser',
          to: 'host:identity-provider',
          kind: 'http',
          status: 'listening',
          label: 'sign-in page',
        },
        {
          from: 'host:portal',
          to: 'host:identity-provider',
          kind: 'http',
          status: 'listening',
          label: 'tokens and user info',
        },
        { from: 'host:identity-provider', to: 'org:store', kind: 'process', status: 'ready', label: 'test people' },
        // The live portal connection reads and writes the real portal while the mode or page mode is live (live.mjs).
        {
          from: 'host:portal',
          to: 'bridge:live',
          kind: 'http',
          status: bridge.connected && liveMode ? 'ready' : 'disabled',
          label: 'live pages and data (live mode)',
        },
        { from: 'host:admin', to: 'bridge:live', kind: 'http', status: 'ready', label: 'connect' },
        // Persona runtimes are copies of this runtime on ports of their own: the browser opens them, sign-in and administration start them.
        ...runtimes.flatMap((item) => [
          {
            from: 'client:browser',
            to: `persona-runtime:${item.id}`,
            kind: 'http',
            status: item.status === 'running' ? 'listening' : 'disabled',
            label: 'isolated pages',
          },
          {
            from: 'host:portal',
            to: `persona-runtime:${item.id}`,
            kind: 'process',
            status: 'ready',
            label: 'persona sign-in',
          },
          {
            from: 'host:admin',
            to: `persona-runtime:${item.id}`,
            kind: 'process',
            status: 'ready',
            label: 'start and stop',
          },
        ]),
        // Code components call /_api of the portal page that hosts them, or Xrm.WebApi of a model-driven form (trusted extensions).
        { from: 'app:pcf', to: 'host:portal', kind: 'http', status: 'ready', label: '/_api (table permissions)' },
        {
          from: 'app:pcf',
          to: 'host:model-driven',
          kind: 'http',
          status: trusted ? 'ready' : 'disabled',
          label: trusted ? 'Xrm.WebApi' : 'Xrm.WebApi (trusted extensions only)',
        },
      ],
      configuration: {
        settingsKeys: configuredSettings,
        ports: {
          portal: Number(new URL(localOrigin).port) || null,
          identityProvider: identityProvider.available ? (identityProvider.port ?? null) : null,
        },
      },
      activity: {
        requests: {
          total: portalRequestTotal,
          retained: requests.length,
          recent: requests.slice(-20).map(({ at = null, method, path: route, status, durationMs }) => ({
            at: typeof at === 'number' ? new Date(at).toISOString() : at,
            method,
            path: route,
            status,
            ms: durationMs,
          })),
        },
        diagnostics: { total: all.length, byCode: diagnosticsByCode(all) },
        audit: { retained: audit.entries.length, sequence: audit.sequence, dropped: audit.dropped },
        reloads: { revision, lastReloadAt: bootstrapTimings.lastReload?.at ?? null },
      },
    };
  };
  // GET /_sim/api/dashboard (sim-dashboard-routes.mjs): the shared topology plus this host's listeners, runtimes and rings.
  // Before the organization exists it answers 503 { status: 'starting' }.
  const dashboardRoutes = createDashboardRoutes({
    host: () => (organization ? organizationHost : null),
    docs: DOCS,
    extras: dashboardExtras,
  });
  // GET /_sim/api/packs (sim-pack-routes.mjs): registered packs, matched against the current portal.
  const packRoutes = createPackRoutes({
    packs: projectPacks ?? [],
    registration: { project, dataPacks, packs },
    projectRoot,
    state: () => store.state,
    library: () => generatedPresets,
    simulation: () => organizationHost.simulationReport(storageAdapter?.report(store.state) ?? simulationReport()),
    portal: () => sourcePortal ?? portal ?? null,
  });
  const messaging = async (req, res, url) =>
    (await dashboardRoutes(req, res, url)) ||
    (await packRoutes(req, res, url)) ||
    (organization
      ? (await (messagingRoutes ??= createMessagingRoutes({ api: organization.api, csrf: () => csrf }))(
          req,
          res,
          url,
        )) || (await (flowRoutes ??= createFlowRoutes({ api: organization.api, csrf: () => csrf }))(req, res, url))
      : false);
  // /_sim/api/environment (sim-environment-routes.mjs): variables, local overrides and the deployment profile pin.
  const environmentRoutes = createEnvironmentRoutes({
    csrf: () => csrf,
    change,
    json,
    jsonObjectBody,
    jsonBody,
    environment: {
      definitions: environmentVariableTable,
      profiles: () => deploymentProfilesSummary(profileConfig, activeProfiles),
      setOverride: async (schemaName, value) => {
        const state = store.snapshot(undefined, { forkTables: true });
        applyEnvironmentOverride(store, state, schemaName, value, { secrets: organization?.api?.secrets ?? null });
        await saveState(state);
        return environmentVariableTable().definitions.find((item) => item.schemaName === schemaName);
      },
      selectProfile: async (body) => {
        profileSelection(profileConfig, body);
        const state = store.snapshot(undefined, { forkTables: true });
        if (body === null) delete state.simulator.deploymentProfilePin;
        else state.simulator.deploymentProfilePin = body;
        await saveState(state);
        return deploymentProfilesSummary(profileConfig, activeProfiles);
      },
      extra: async () => {
        let deploymentProfiles;
        try {
          deploymentProfiles = (await fs.readdir(path.join(portal.sourceDir, 'deployment-profiles')))
            .filter((name) => /\.deployment\.ya?ml$/i.test(name))
            .map((name) => name.replace(/\.deployment\.ya?ml$/i, ''))
            .sort();
        } catch {
          deploymentProfiles = [];
        }
        return {
          sourceDir: portal.sourceDir,
          solutionRoots,
          live: live.status(),
          deploymentProfile: portal.deploymentProfile ?? null,
          deploymentProfiles,
          profileChanges: (portal.profileChanges ?? []).length,
          referenceImports: config().referenceImports ?? [],
        };
      },
    },
  });
  // GET /_sim/api/preflight: the live preflight report; the source graph is rebuilt with the active profile bindings.
  const preflight = ({ scenario = null, strict = false } = {}) =>
    organizationHost.preflight({
      preparedCanvas: canvasApps(),
      simulation,
      scenario,
      strict,
      portal,
      diagnostics: activeProfiles.diagnostics ?? [],
      graph: buildSourceGraph({
        scan: solutionScan,
        metadata: solutionMetadata,
        solutionData,
        workflows: operationWorkflows,
        portal,
        clientResources,
        // The model-driven catalogue's tables on this host: the portal provider's site tables plus the store mappings.
        mappings: {
          ...powerPagesTables(portal, modelMetadata()),
          ...store.snapshot({ sections: ['mappings'] }).mappings,
        },
        bindings: graphBindings({ environmentVariables, profile: activeProfiles }),
      }),
    });
  const coreAdmin = createRuntimeAdminRouter({
    store,
    json,
    jsonObjectBody,
    change,
    csrf: () => csrf,
    status: statusPayload,
    statusChunks: (value) => statusResponseChunks(value, recordCapabilitiesSummary),
    dataverseAdmin,
    staffSession,
    simulation: () => organizationHost.simulationReport(storageAdapter?.report(store.state) ?? simulationReport()),
  });
  // One table of [prefix, handler] for the /_sim/api prefixes this host answers after the shared routers: admin() dispatches
  // through it and PORTAL_ADMIN_ROUTES (status `routes`) is read from it. /session is sessionApi, which the request handler
  // also mounts before admin() so the sign-in page keeps its own rules; /__sim/events is not under /_sim/api and is not listed.
  const PORTAL_ADMIN = [
    [
      '/preflight',
      async (req, res, url, relative) => {
        if (relative !== '/preflight' || req.method !== 'GET') throw error('Admin endpoint not found.', 404);
        const scenario = url.searchParams.get('requires')
          ? scenarioSettings({
              id: url.searchParams.get('scenario') ?? 'request',
              requires: url.searchParams.getAll('requires'),
            })
          : null;
        return json(res, 200, await preflight({ scenario, strict: url.searchParams.get('strict') === 'true' }));
      },
    ],
    ['/session', (req, res, url) => sessionApi(req, res, url)],
    // GET /_sim/api/model-driven/offline: every staff session's mobile offline summary (model-driven/offline.mjs).
    [
      '/model-driven/offline',
      (req, res, url, relative) => {
        if (relative !== '/model-driven/offline' || req.method !== 'GET') throw error('Admin endpoint not found.', 404);
        return json(res, 200, { items: modelDrivenHandler.offlineSessions() });
      },
    ],
    ...[
      '/page-resources',
      '/page-provenance',
      '/verification-witness',
      '/operations',
      '/persona-runtimes',
      '/personas',
      '/scenarios',
      '/state',
      '/diagnostics',
      '/audit',
      '/shutdown',
      '/persona-catalog',
      '/reference',
      '/environment',
      '/experiments',
      '/portal-settings',
      '/portal-snippets',
      '/portal-roles',
      '/portal-access-rules',
      '/config',
      '/assets',
      '/live',
      '/reset',
      '/reload',
      '/mappings',
      '/plugins',
      '/permissions',
      '/endpoints',
      '/presets',
    ].map((prefix) => [prefix, portalAdmin]),
  ];
  const PORTAL_ADMIN_ROUTES = PORTAL_ADMIN.map(([prefix]) => prefix);
  async function admin(req, res, url) {
    if (await messaging(req, res, url)) return;
    if (await coreAdmin(req, res, url)) return;
    const relative = url.pathname.slice('/__sim/api'.length);
    const entry = PORTAL_ADMIN.find(([prefix]) => relative === prefix || relative.startsWith(prefix + '/'));
    if (!entry) throw error('Admin endpoint not found.', 404);
    return entry[1](req, res, url, relative);
  }
  async function portalAdmin(req, res, url, relative) {
    const method = req.method;
    if (method === 'GET' && relative === '/page-provenance') {
      const entry = renderProofs.get(url.searchParams.get('proof')) ?? scriptProofs.get(url.searchParams.get('proof'));
      if (!entry || req.headers['x-paqvilo-provenance-access'] !== entry.access)
        throw error('Document provenance is unavailable or retired.', 404);
      return json(res, 200, entry.proof);
    }
    if (method === 'GET' && relative === '/page-resources') {
      const route = url.searchParams.get('path') ?? '/';
      if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\'))
        throw error('A portal-relative page path is required.');
      const report = inspectRoute(route, inspectionIdentity(req, route));
      // view=summary: what a tool needs on every navigation; the full report stays on request.
      if (url.searchParams.get('view') === 'summary') {
        return json(res, 200, inspectionSummary(report));
      }
      return json(res, 200, report);
    }
    if (method === 'GET' && relative === '/verification-witness') {
      if (
        [...url.searchParams.keys()].some((key) => key !== 'tables') ||
        url.searchParams.getAll('tables').length !== 1
      )
        throw error(
          'Select explicit logical fixture tables with one tables query parameter.',
          400,
          'InvalidVerificationSelection',
        );
      const selectedTables = url.searchParams.get('tables').split(',');
      const auth = requestAuth(req, new URL('/', url));
      const witness = await trace.run({ ...trace.getStore(), auth, localOnly: true }, () =>
        store.readOperation(async () => {
          verificationTableSelection(selectedTables, store.state);
          const start = { revision, fingerprint, portal };
          const [currentSource, currentImplementation] = await Promise.all([
            calculateFingerprint(),
            cachedImplementationSourceFingerprint(ROOT),
          ]);
          if (start.revision !== revision || start.fingerprint !== fingerprint || start.portal !== portal)
            throw error(
              'Runtime source changed while capturing verification evidence.',
              409,
              'VerificationSourceDrift',
            );
          return verificationWitness({
            state: store.state,
            tables: selectedTables,
            identity: currentIdentity(),
            portal,
            runtime: {
              origin: localOrigin,
              instanceId: verificationRuntimeId,
              revision,
              storeRevision: store.revision,
              loadedSourceFingerprint: fingerprint,
              currentSourceFingerprint: currentSource,
              loadedImplementationFingerprint: implementationFingerprint,
              currentImplementationFingerprint: currentImplementation,
            },
          });
        }),
      );
      return json(res, 200, witness);
    }
    if (method === 'GET' && relative === '/operations') return json(res, 200, { items: operations() });
    if (method === 'GET' && relative === '/persona-runtimes') return json(res, 200, personaRuntimes.list());
    if (method === 'GET' && relative === '/personas') return json(res, 200, personasPayload());
    if (method === 'GET' && relative === '/scenarios')
      return json(res, 200, {
        scenarios: Array.isArray(config().scenarios) ? config().scenarios : [],
        activeScenario: config().activeScenario ?? null,
      });
    if (await environmentRoutes(req, res, url)) return;
    if (method === 'GET' && relative === '/state/export') {
      // Credential material never leaves the runtime: password hashes are dropped and secrets keep only hint and expiry.
      // Plain table rows stream in place under a read lease rather than from a second full copy.
      return store.exportState(
        (chunks) =>
          json(res, 200, {}, { 'content-disposition': 'attachment; filename="simulator-state.json"' }, { chunks }),
        {
          adjust: (snapshot) => {
            if (snapshot.dataverse)
              snapshot.dataverse = {
                ...snapshot.dataverse,
                passwords: undefined,
                applications: (snapshot.dataverse.applications ?? []).map(({ secrets, ...app }) => ({
                  ...app,
                  secrets: (secrets ?? []).map(({ id, hint, expiresOn }) => ({ id, hint, expiresOn })),
                })),
              };
          },
          project: (item) => (isExactNumeric(item) ? JSON.rawJSON(stringifyExactJson(item)) : item),
        },
      );
    }
    if (method === 'GET' && relative === '/state') {
      if (evidenceDir)
        try {
          evidence = JSON.parse(await fs.readFile(path.join(evidenceDir, 'report.json'), 'utf8'));
        } catch {
          evidence = null;
        }
      const current = exposedState({
        summary: url.searchParams.get('summary') === '1',
      });
      // Browser adapters/admin assets are read on demand. A startup-only digest
      // cannot detect their edits during a comparison against this process.
      Object.assign(
        current.status,
        implementationEvidence(implementationFingerprint, await cachedImplementationSourceFingerprint(ROOT)),
      );
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
                live: '/__sim/evidence/live.png',
                local: '/__sim/evidence/local.png',
                difference: '/__sim/evidence/difference.png',
              },
            }
          : null,
      });
    }
    if (method === 'GET' && relative === '/diagnostics')
      return json(res, 200, {
        diagnostics: allDiagnostics(),
        requests,
      });
    if (method === 'GET' && relative === '/audit') return json(res, 200, audit.list(url.searchParams));
    if (method === 'GET' && relative === '/audit/export')
      return json(res, 200, audit.export(url.searchParams), {
        'content-disposition': 'attachment; filename="simulator-audit.json"',
      });
    if (isWrite(method) && req.headers['x-sim-csrf'] !== csrf) throw error('Missing simulator CSRF token.', 403);
    const operationRoute = /^\/operations\/([^/]+)$/.exec(relative);
    if (operationRoute && ['PATCH', 'DELETE'].includes(method))
      return change(async () => {
        const key = decodeAdminIdentifier(operationRoute[1]);
        const item = operations().find((item) => item.key === key);
        if (!item) throw error('This operation is not in the current source exports.', 404);
        if (!item.configurable)
          throw error(
            item.kind === 'plugin-step'
              ? item.unsupported || 'This plugin registration is disabled in the export.'
              : 'This workflow has no exported portal consumer or trigger route. Add its consumer to the portal sources first.',
            409,
          );
        let value;
        if (method !== 'DELETE') {
          value = await jsonObjectBody(req);
          validateOperationOverrides({ [key]: value }, { pluginStep: item.kind === 'plugin-step' ? item : undefined });
          if (value.mode === 'handler' && !item.registered)
            throw error('No trusted project handler is registered for this operation.', 409);
          if (value.mode === 'clr') {
            if (!item.clrAvailable)
              throw error(
                'No explicitly trusted CLR descriptor is registered for this exact exported plugin step/type.',
                409,
              );
            if (item.unsupported) throw error(item.unsupported, 409);
          }
          if (value.mode === 'handler' && item.unsupported) throw error(item.unsupported, 409);
          if (value.mode === 'exported' && !item.definitionAvailable)
            throw error('The selected sources do not include this operation definition.', 409);
        }
        const next = { ...(store.state.simulator?.operations ?? {}) };
        if (method === 'DELETE') delete next[key];
        else next[key] = value;
        // The host prepares a CLR runtime this choice selects before the choice is stored, and closes one it no longer selects.
        // Reading the body and preparing a trusted runtime can complete pending
        // SDK work. Apply this configuration delta to a fresh snapshot afterwards.
        await organizationHost.applyOperationOverrides(next, async () => {
          for (let attempt = 0; ; attempt++) {
            const state = store.snapshot(undefined, { forkTables: true });
            state.simulator ??= config();
            state.simulator.operations = { ...(state.simulator.operations ?? {}) };
            if (method === 'DELETE') delete state.simulator.operations[key];
            else state.simulator.operations[key] = value;
            try {
              await saveState(state);
              break;
            } catch (cause) {
              // A committed asynchronous plug-in job may advance the store while
              // this replacement queues. Retry only this operation-key delta on
              // fresh state, retaining the job's writes and the revision guard.
              if (cause.code !== 'StateConflict' || attempt >= 2) throw cause;
            }
          }
        });
        return json(res, 200, { items: operations() });
      });
    if (method === 'POST' && relative === '/shutdown') {
      json(res, 202, { accepted: true, message: 'Mirage shutdown accepted.' });
      setImmediate(() => {
        if (typeof onShutdown === 'function')
          Promise.resolve()
            .then(onShutdown)
            .catch(() => close());
        else void close();
      });
      return;
    }
    if (method === 'POST' && relative === '/audit/clear') return json(res, 200, audit.clear());
    if (
      (method === 'PUT' && relative === '/persona-catalog') ||
      (method === 'DELETE' && relative === '/persona-catalog')
    ) {
      const body = await jsonObjectBody(req);
      await change(() =>
        store.transact(() => {
          const state = store.state;
          const digest = createHash('sha256')
            .update(JSON.stringify(state.personaCatalog ?? null))
            .digest('hex');
          if (body?.expectedDigest !== digest)
            throw error('Persona catalogue changed. Reload before saving.', 409, 'PersonaCatalogConflict');
          if (method === 'DELETE') delete state.personaCatalog;
          else state.personaCatalog = validatePersonaCatalog(body.catalog, 'State');
        }),
      );
      return json(res, 200, personasPayload());
    }
    if (method === 'POST' && relative === '/personas/launch') {
      const result = await launchPersona(await jsonObjectBody(req));
      return json(res, 200, result, { 'set-cookie': result.cookieHeader + '; Path=/; HttpOnly; SameSite=Lax' });
    }
    if (method === 'DELETE' && relative.startsWith('/persona-runtimes/'))
      return json(
        res,
        200,
        await personaRuntimes.stop(decodeAdminIdentifier(relative.slice('/persona-runtimes/'.length))),
      );
    if (method === 'POST' && relative === '/personas/select')
      return change(async () => {
        const body = await jsonObjectBody(req);
        if (body.contactId !== null && (typeof body.contactId !== 'string' || !body.contactId.trim()))
          throw error('Select a local contact ID, or null for an anonymous visitor.');
        const contactId = body.contactId === null ? null : personaKey(body.contactId);
        const state = store.snapshot(undefined, { forkTables: true });
        if (contactId) {
          const idColumn = state.mappings?.contact?.idColumn ?? 'contactid';
          const contact = (state.tables?.contact ?? []).find((row) => personaKey(row[idColumn]) === contactId);
          const statecode =
            contact?.statecode && typeof contact.statecode === 'object' ? contact.statecode.value : contact?.statecode;
          if (!contact || Number(statecode ?? 0) !== 0)
            throw error('The selected persona must be an active local contact.', 404, 'PERSONA_CONTACT_UNAVAILABLE');
        }
        state.simulator.identity = contactId
          ? { id: contactId, contactId, roleSource: 'memberships', roles: [] }
          : { id: null, roleSource: 'memberships', roles: [] };
        validateConfig(state.simulator);
        await saveState(state);
        return json(res, 200, personasPayload());
      });
    if (method === 'POST' && relative === '/personas')
      return change(async () => {
        const body = await jsonObjectBody(req);
        const mapping = tableMapping('contact');
        if (!mapping) throw error('Map the contact table before creating personas.', 409, 'CONTACT_UNMAPPED');
        const text = (value, label, required = false) => {
          if (value === undefined || value === null || value === '') {
            if (required) throw error(`${label} is required.`);
            return null;
          }
          // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
          if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f]/.test(value))
            throw error(`${label} must be text of at most 200 characters.`);
          return value.trim();
        };
        const firstname = text(body.firstname, 'First name');
        const lastname = text(body.lastname, 'Last name', true);
        const email = text(body.emailaddress1, 'Email');
        const accountId = text(body.accountId, 'Account ID');
        const roleIds = Array.isArray(body.roleIds) ? body.roleIds.map(personaKey) : [];
        const known = new Set(personasPayload().webRoles.map((role) => role.id));
        const unknown = roleIds.filter((roleId) => !known.has(roleId));
        if (unknown.length) throw error(`Unknown exported web-role IDs: ${unknown.join(', ')}`);
        const contactId = randomUUID();
        const values = {
          [mapping.idColumn]: contactId,
          ...(firstname ? { firstname } : {}),
          lastname,
          fullname: [firstname, lastname].filter(Boolean).join(' '),
          ...(email ? { emailaddress1: email } : {}),
          ...(accountId ? { parentcustomerid: { id: personaKey(accountId), logical_name: 'account' } } : {}),
        };
        const created = await store.create(mapping.logicalName, values, { admin: true });
        try {
          const state = store.snapshot(undefined, { forkTables: true });
          state.simulator.contactRoles = [
            ...(state.simulator.contactRoles ?? []),
            ...[...new Set(roleIds)].map((roleId) => ({ contactId, roleId })),
          ];
          if (body.select === true)
            state.simulator.identity = { id: contactId, contactId, roleSource: 'memberships', roles: [] };
          validateConfig(state.simulator);
          await saveState(state);
        } catch (cause) {
          await store.remove(mapping.logicalName, contactId, { admin: true }).catch(() => {});
          throw cause;
        }
        return json(res, 201, { contact: created, ...personasPayload() });
      });
    const scenarioRoute = /^\/scenarios(?:\/([^/]+))?(?:\/(apply))?$/.exec(relative);
    if (scenarioRoute && method !== 'GET') {
      const id = scenarioRoute[1] && decodeAdminIdentifier(scenarioRoute[1]);
      return change(async () => {
        const scenarios = Array.isArray(config().scenarios) ? config().scenarios : [];
        if (scenarioRoute[2] === 'apply' && method === 'POST') {
          const scenario = scenarios.find((item) => item.id === id);
          if (!scenario) throw error('Scenario not found.', 404);
          if (scenario.preset) await applySelectedPreset(scenario.preset, scenarioAdjustment(scenario));
          else {
            const state = store.snapshot(undefined, { forkTables: true });
            scenarioAdjustment(scenario)(state);
            await saveState(state);
          }
          return json(res, 200, statusPayload());
        }
        if (
          !['POST', 'PATCH', 'DELETE'].includes(method) ||
          scenarioRoute[2] ||
          (method === 'POST' && id) ||
          (method !== 'POST' && !id)
        )
          throw error('Unsupported scenario operation.', 405);
        const index = scenarios.findIndex((item) => item.id === id);
        const next = [...scenarios];
        if (method === 'DELETE') {
          if (index < 0) throw error('Scenario not found.', 404);
          next.splice(index, 1);
        } else {
          const body = await jsonObjectBody(req);
          const value = validateScenario(method === 'PATCH' ? { ...scenarios[index], ...body, id } : body);
          if (method === 'POST' && scenarios.some((item) => item.id === value.id))
            throw error('Scenario already exists.', 409);
          if (method === 'PATCH' && index < 0) throw error('Scenario not found.', 404);
          if (
            value.preset &&
            !listPresets({ state: store.snapshot({ sections: ['presets'] }), library: generatedPresets }).some(
              (preset) => preset.id === value.preset,
            )
          )
            throw error(`Unknown preset: ${value.preset}`, 400, 'SCENARIO_PRESET_UNKNOWN');
          if (method === 'POST') next.push(value);
          else next[index] = value;
        }
        const state = store.snapshot(undefined, { forkTables: true });
        state.simulator.scenarios = next;
        // Scenario definitions do not change rendered output: persist without reloading pages.
        await replaceCompiledState(state);
        return json(res, method === 'POST' ? 201 : 200, {
          scenarios: next,
          activeScenario: state.simulator.activeScenario ?? null,
        });
      });
    }
    if (method === 'POST' && relative === '/environment/reference')
      return change(async () => {
        const body = await jsonObjectBody(req);
        if (typeof body.origin !== 'string') throw error('Provide the reference origin to use for live routing.');
        const state = store.snapshot(undefined, { forkTables: true });
        state.simulator.live = { ...(state.simulator.live ?? {}), origin: body.origin };
        validateConfig(state.simulator);
        await saveState(state);
        return json(res, 200, { live: live.status() });
      });
    if (method === 'POST' && (relative === '/reference/enrich/validate' || relative === '/reference/enrich')) {
      const body = await jsonObjectBody(req);
      if (relative.endsWith('/validate')) {
        // Run the importer's own plan validation, stopping before the first reference read.
        const stop = Symbol('validated');
        try {
          await enrichReference({
            store,
            origin: live.origin,
            plan: body.plan,
            bridge: {
              fetchXml: async () => {
                throw stop;
              },
            },
          });
        } catch (cause) {
          if (cause !== stop) throw error(cause.message, cause.status ?? 400, cause.code ?? 'ENRICHMENT_PLAN_INVALID');
        }
        return json(res, 200, {
          valid: true,
          entries: body.plan.map((entry) => {
            const mapping = store.resolveMapping(entry.entity);
            return {
              entity: mapping.logicalName,
              idColumn: mapping.idColumn,
              mode: entry.mode ?? 'merge',
              pageSize: entry.pageSize ?? 5000,
              maxPages: entry.maxPages ?? 10,
            };
          }),
          live: live.status(),
        });
      }
      if (!live.status().connected || !live.origin)
        throw error(
          'Connect the intended reference browser and select its origin before running an enrichment plan.',
          409,
          'LIVE_NOT_CONNECTED',
        );
      return change(async () => {
        const runtimeStore = {
          resolveMapping: (entity) => store.resolveMapping(entity),
          // The plan writes this snapshot back; paged tables stay forked pages.
          snapshot: (projection) => store.snapshot(projection, { forkTables: true }),
          snapshotDigest: () => store.snapshotDigest(),
          replaceState: async (state, { expectedSnapshot, expectedDigest } = {}) => {
            if (expectedDigest !== undefined && store.snapshotDigest() !== expectedDigest)
              throw error(
                'Local state changed during reference reads; enrichment was not applied.',
                409,
                'StateConflict',
              );
            if (
              expectedSnapshot !== undefined &&
              JSON.stringify(store.snapshot(undefined, { forkTables: true })) !== expectedSnapshot
            )
              throw error(
                'Local state changed during reference reads; enrichment was not applied.',
                409,
                'StateConflict',
              );
            await saveState(state);
          },
        };
        const report = await enrichReference({
          store: runtimeStore,
          origin: live.origin,
          plan: body.plan,
          bridge: live,
        });
        return json(res, 200, report);
      });
    }
    if (method === 'POST' && relative === '/state/import')
      return change(async () => {
        const imported = await largeJsonBody(req);
        if (!imported || typeof imported !== 'object' || Array.isArray(imported))
          throw error('State import must be a simulator state object.');
        // Saved scenario definitions are workspace tooling and survive a state import.
        const scenarios = config().scenarios;
        const next = imported;
        next.simulator = {
          mode: 'local',
          pageMode: 'local',
          identity: { roles: [] },
          endpoints: [],
          ...(next.simulator ?? {}),
        };
        if (Array.isArray(scenarios) && !Array.isArray(next.simulator.scenarios)) next.simulator.scenarios = scenarios;
        validateConfig(next.simulator);
        await saveState(next);
        // As in /reset: an imported state may lack the Dataverse section, and the security rows must be re-seeded.
        if (dataverse) {
          store.state.dataverse ??= { applications: [] };
          store.state.dataverse.applications ??= [];
          await organization.reseed();
        }
        return json(res, 200, { imported: true, revision, tableCounts: store.summary().tableCounts });
      });
    const platformState = () => store.snapshot({ sections: ['simulator', 'settings'], tables: ['organization'] });
    if (relative === '/platform-settings' && method === 'GET')
      return json(res, 200, platformSettingEntries(platformState()));
    if (relative === '/platform-settings' && method === 'PATCH')
      return change(async () => {
        const patch = validatePlatformOverrides(await jsonObjectBody(req)),
          state = store.snapshot(undefined, { forkTables: true });
        state.simulator.platformOverrides = { ...state.simulator.platformOverrides, ...patch };
        delete state.simulator.activeExperiment;
        await saveState(state);
        return json(res, 200, platformSettingEntries(platformState()));
      });
    if (relative.startsWith('/platform-settings/') && method === 'DELETE')
      return change(async () => {
        const key = decodeAdminIdentifier(relative.slice('/platform-settings/'.length));
        if (!platformSettingEntries(platformState()).some((x) => x.key === key))
          throw error('Unknown platform setting.', 404);
        const state = store.snapshot(undefined, { forkTables: true });
        delete (state.simulator.platformOverrides ?? {})[key];
        delete state.simulator.activeExperiment;
        await saveState(state);
        return json(res, 200, { reset: key });
      });
    const experimentRoute = /^\/experiments(?:\/([^/]+)(\/apply)?)?$/.exec(relative);
    if (experimentRoute) {
      const id = experimentRoute[1] && experimentId(decodeAdminIdentifier(experimentRoute[1]));
      if (method === 'GET' && !experimentRoute[2]) {
        const presets = experimentPresets(
            store.snapshot({ sections: ['simulator'] }),
            sourcePortal,
            packConfigurations.presets,
          ),
          item = id ? presets.find((p) => p.id === id) : presets;
        if (!item) throw error('Experiment not found.', 404);
        return json(res, 200, item);
      }
      return change(async () => {
        const state = store.snapshot(undefined, { forkTables: true }),
          presets = experimentPresets(state, sourcePortal, packConfigurations.presets),
          existing = presets.find((p) => p.id === id);
        if (method === 'POST' && experimentRoute[2]) {
          if (!existing) throw error('Experiment not found.', 404);
          const next = applyExperiment(state, existing);
          const settings = (value) => {
            const overrides = value.simulator.portalOverrides ?? {};
            return [
              value.simulator.platformOverrides ?? {},
              { ...overrides, settings: overrides.settings ?? {}, snippets: overrides.snippets ?? {} },
            ];
          };
          const reload = !isDeepStrictEqual(settings(state), settings(next));
          await saveState(next, { reload });
          return json(res, 200, { applied: id });
        }
        if (method === 'POST' && !id) {
          const p = validateExperiment(await jsonObjectBody(req));
          if (presets.some((x) => x.id === p.id)) throw error('Experiment ID already exists.', 409);
          state.simulator.experimentPresets ??= {};
          if (Object.keys(state.simulator.experimentPresets).length >= 100)
            throw error('Experiment preset limit reached.', 413);
          state.simulator.experimentPresets[p.id] = structuredClone(p);
          await saveState(state, { reload: false });
          return json(res, 201, p);
        }
        if (method === 'DELETE' && id && !experimentRoute[2]) {
          const saved = Object.hasOwn(state.simulator.experimentPresets ?? {}, id);
          if (!saved) {
            if (!existing) throw error('Experiment not found.', 404);
            if (existing.builtin || existing.readOnly)
              throw error('Built-in and pack configuration presets cannot be deleted.', 403);
          }
          delete state.simulator.experimentPresets[id];
          await saveState(state, { reload: false });
          return json(res, 200, { deleted: id });
        }
        throw error('Unsupported experiment operation.', 405);
      });
    }
    const portalEntry = /^\/(portal-settings|portal-snippets|portal-roles|portal-access-rules)(?:\/(.+))?$/.exec(
      relative,
    );
    if (portalEntry) {
      const section =
        { 'portal-settings': 'settings', 'portal-roles': 'roles', 'portal-access-rules': 'accessRules' }[
          portalEntry[1]
        ] ?? 'snippets';
      const rawName = portalEntry[2] && decodeAdminIdentifier(portalEntry[2]);
      const name = section === 'accessRules' && rawName ? personaKey(rawName) : rawName;
      const items = () => portalOverrideEntries(sourcePortal, config().portalOverrides, section);
      if (method === 'GET') {
        const item = name ? items().find((entry) => entry.id === name) : items();
        if (!item) throw error('Portal value not found.', 404);
        return json(res, 200, item);
      }
      if (!['POST', 'PATCH', 'DELETE'].includes(method)) throw error('Unsupported portal value operation.', 405);
      return change(async () => {
        const body = method === 'DELETE' ? null : await jsonObjectBody(req);
        const key =
          name ??
          (section === 'roles'
            ? (body?.id ?? randomUUID())
            : section === 'accessRules'
              ? personaKey(body?.id ?? randomUUID())
              : body?.name);
        if (section === 'accessRules' && body?.value) {
          // Rules must target exported pages and effective web roles of this portal.
          const value = body.value;
          if (typeof value.webPageId === 'string') value.webPageId = personaKey(value.webPageId);
          if (Array.isArray(value.roleIds)) value.roleIds = value.roleIds.map(personaKey);
          if (!portal.pages.some((page) => page.id === value.webPageId))
            throw error('Page access rules must target an exported web page ID.');
          const roleIds = new Set(
            portal.records.filter((record) => record.kind === 'webrole').map((record) => personaKey(record.id)),
          );
          const unknown = (value.roleIds ?? []).filter((roleId) => !roleIds.has(roleId));
          if (unknown.length) throw error(`Unknown web-role IDs: ${unknown.join(', ')}`);
        }
        const state = store.snapshot(undefined, { forkTables: true });
        state.simulator.portalOverrides ??= {};
        delete state.simulator.activeExperiment;
        const entries = (state.simulator.portalOverrides[section] ??= {});
        if (method === 'DELETE') {
          if (!Object.hasOwn(entries, key)) throw error('Local override not found.', 404);
          delete entries[key];
        } else {
          if (method === 'POST' && items().some((entry) => entry.id === key && !entry.deleted))
            throw error('Portal value already exists.', 409);
          if (method === 'PATCH' && !items().some((entry) => entry.id === key))
            throw error('Portal value not found.', 404);
          if (typeof key !== 'string') throw error('Portal values require a name.');
          // Validate on a fresh dictionary before assigning untrusted identifiers.
          validatePortalOverrides({ [section]: Object.fromEntries([[key, body?.value]]) });
          Object.defineProperty(entries, key, {
            value: body.value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        await saveState(state);
        return json(res, method === 'POST' ? 201 : 200, items().find((entry) => entry.id === key) ?? { reset: key });
      });
    }
    if (relative === '/config' && method === 'PATCH')
      return change(async () => {
        const patch = await jsonObjectBody(req);
        const state = store.snapshot(undefined, { forkTables: true });
        const allowed = [
          'mode',
          'pageMode',
          'identity',
          'live',
          'componentSchemas',
          'externalAssets',
          'externalFrameOrigins',
          'confinePortalPages',
          'permissionMode',
          'shellProfile',
          'contactRoles',
          'permissionSource',
          'portalOverrides',
          'platformOverrides',
          'operations',
        ];
        for (const key of Object.keys(patch))
          if (!allowed.includes(key)) throw error(`Unknown configuration field: ${key}`);
        // Live writes need the runtime flag; the /_sim switch alone never enables them.
        if (patch.live?.allowWrites === true && !allowLiveWrites)
          throw error(
            'Live writes are disabled for this runtime: start the Mirage with --allow-live-writes (mirage dev and start pass it through) before allowing create, update or delete requests to the live environment.',
            403,
            'LIVE_WRITES_DISABLED',
          );
        if (patch.permissionMode) {
          state.settings.permissionMode = patch.permissionMode;
          delete patch.permissionMode;
        }
        state.simulator = {
          ...state.simulator,
          ...patch,
          ...(['confinePortalPages', 'externalAssets', 'externalFrameOrigins'].some((key) => Object.hasOwn(patch, key))
            ? { contentPolicySource: 'runtime state' }
            : {}),
          live: { ...config().live, ...patch.live },
        };
        if (patch.platformOverrides || patch.portalOverrides) delete state.simulator.activeExperiment;
        validateConfig(state.simulator);
        if (patch.contactRoles || patch.identity?.roleSource === 'memberships') {
          const model = buildPermissionModel(portal, state, {
            relationships: solutionData.relationships,
          });
          const invalid = model.diagnostics.filter((d) => d.code === 'PERSONA_MEMBERSHIP_UNRESOLVED');
          const identity = resolvePortalIdentity(portal, state, state.simulator.identity);
          if (invalid.length || identity.diagnostics?.some((d) => d.code === 'PERSONA_CONTACT_UNAVAILABLE'))
            throw error(
              'Contact memberships must reference active local contacts and exported web roles.',
              400,
              'PERSONA_CONFIGURATION_INVALID',
            );
        }
        await saveState(state);
        json(res, 200, exposedState());
      });
    if (relative === '/assets/capture' && method === 'POST') {
      if (!cache) throw error('Asset capture requires a persisted simulator state directory.', 409);
      const body = await jsonObjectBody(req);
      if (
        !Array.isArray(body.paths) ||
        !body.paths.length ||
        body.paths.length > 100 ||
        body.paths.some((p) => typeof p !== 'string')
      )
        throw error('Provide between 1 and 100 explicit static path strings.');
      const publicPaths = body.paths.filter((p) => p.startsWith('/resource/powerappsportal/'));
      const portalPaths = body.paths.filter((p) => !publicPaths.includes(p));
      const outputs = [];
      if (portalPaths.length) outputs.push(await cache.capture(portalPaths, live));
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
    if (relative === '/assets/capture-snippet-composition' && method === 'POST')
      return change(async () => {
        const body = await jsonObjectBody(req);
        if ([body.path, body.parentName, body.childName].some((value) => typeof value !== 'string' || !value.trim()))
          throw error('Provide a portal page path and both exported snippet names.');
        const report = await captureObservedSnippetComposition(live, {
          portal,
          path: body.path,
          parentName: body.parentName,
          childName: body.childName,
        });
        const state = store.snapshot(undefined, { forkTables: true }),
          profile = { ...config().shellProfile };
        profile.snippetCompositions = [
          ...(Array.isArray(profile.snippetCompositions) ? profile.snippetCompositions : []).filter(
            (item) => item.parentName !== report.profile.parentName,
          ),
          report.profile,
        ];
        state.simulator = { ...state.simulator, shellProfile: profile };
        await saveState(state);
        for (const diagnostic of report.diagnostics) recordDiagnostic(diagnostic);
        return json(res, 200, { ...report, applied: true });
      });
    if (relative === '/assets/capture-stylesheets' && method === 'POST')
      return change(async () => {
        const body = await jsonObjectBody(req);
        const report = await captureObservedStylesheets(cache, live, {
          portal,
          paths: body.paths,
        });
        if (!report.complete) return json(res, 409, { ...report, applied: false });
        const state = store.snapshot(undefined, { forkTables: true });
        const profile = { ...config().shellProfile };
        const selected = new Set(report.baselines.map((item) => item.path));
        profile.observedStylesheets = [
          ...(Array.isArray(profile.observedStylesheets) ? profile.observedStylesheets : []).filter(
            (item) => !selected.has(item.path),
          ),
          ...report.baselines,
        ];
        state.simulator = { ...state.simulator, shellProfile: profile };
        await saveState(state);
        for (const diagnostic of report.diagnostics) recordDiagnostic(diagnostic);
        return json(res, 200, { ...report, applied: true });
      });
    if (relative === '/assets/capture-shell' && method === 'POST')
      return change(async () => {
        const body = await jsonObjectBody(req);
        if (typeof body.path !== 'string') throw error('Provide the portal page path to capture.');
        if (body.managedControlPath !== undefined && typeof body.managedControlPath !== 'string')
          throw error('Managed control page path must be a string.');
        if (body.richText !== undefined && typeof body.richText !== 'boolean') throw error('richText must be boolean.');
        const report = await cache.transaction(
          async (capturedCache) => {
            let observedHtml;
            const report = await capturePortalShell(capturedCache, live, {
              path: body.path,
              portal,
              onObservedHtml: (html) => {
                observedHtml = html;
              },
            });
            if (!report.ready) return report;
            const richText =
              body.richText === false
                ? {
                    required: false,
                    skipped: 'DISABLED',
                    complete: true,
                    nativeReady: false,
                    managedControls: {},
                    diagnostics: [],
                  }
                : await captureRichTextAssets(capturedCache, live, {
                    schemas: {
                      ...solutionMetadata.componentSchemas,
                      ...config().componentSchemas,
                    },
                    portal,
                    html: observedHtml,
                    managedControls: config().managedControls ?? config().shellProfile?.managedControls,
                    managedControlPath: body.managedControlPath,
                    captureConfigurations: true,
                  });
            if (Object.keys(richText.managedControls).length)
              report.shellProfile.managedControls = richText.managedControls;
            if (richText.configurationBaselines?.length)
              report.shellProfile.richTextConfigurations = richText.configurationBaselines;
            report.richText = richText;
            if (richText.required)
              report.shellProfile.richTextReadiness = {
                nativeReady: richText.nativeReady === true,
                capturedAt: new Date().toISOString(),
                origin: live.origin,
              };
            report.complete = report.complete && richText.complete;
            report.shellProfile = mergeShellProfile(config().shellProfile, report.shellProfile, {
              pagePath: body.path,
            });
            return report;
          },
          {
            accept: (report) => report.ready,
            publish: async (report) => {
              const state = store.snapshot(undefined, { forkTables: true });
              state.simulator = { ...state.simulator, shellProfile: report.shellProfile };
              await saveState(state);
            },
          },
        );
        if (!report.ready) return json(res, 409, { ...report, applied: false });
        return json(res, report.complete ? 200 : 207, {
          ...report,
          applied: true,
        });
      });
    if (relative === '/live/connect' && method === 'POST') {
      const body = await jsonObjectBody(req);
      return json(res, 200, await live.connect(body.cdpUrl));
    }
    if (relative === '/live/disconnect' && method === 'POST') {
      await live.close();
      return json(res, 200, live.status());
    }
    if (relative === '/reset' && method === 'POST')
      return change(async () => {
        // replaceCompiledState applies the current Solution data to the replacement.
        const next = structuredClone(seededInitialState());
        // Saved scenario definitions are workspace tooling and survive a reset.
        const scenarios = config().scenarios;
        if (Array.isArray(scenarios)) next.simulator = { ...next.simulator, scenarios };
        // Dataverse registrations survive a reset. Application users are created by the admin API, not by the settings,
        // so their rows and role links are carried over too; reseed() then restores the settings-level security rows.
        if (store.state.dataverse) {
          next.dataverse = store.state.dataverse;
          for (const table of ['systemuser', 'systemuserroles'])
            if (store.state.tables?.[table]) next.tables[table] = store.state.tables[table];
        }
        await saveState(next);
        await organization?.reseed();
        // Advanced form sessions belong to the reset state: a reset ends them.
        webFormSessions.clear();
        json(res, 200, exposedState());
      });
    if (relative === '/reload' && method === 'POST') {
      await reload();
      return json(res, 200, exposedState());
    }
    const collection = /^\/(mappings|plugins|permissions|endpoints|presets)(?:\/([^/]+))?(?:\/(apply))?$/.exec(
      relative,
    );
    if (collection) {
      const [, kind, rawId, action] = collection;
      const id = rawId && decodeAdminIdentifier(rawId);
      if (method === 'GET') {
        if (kind === 'presets' && id) {
          const preset = resolvePreset(store.snapshot({ sections: ['presets', 'mappings'] }), id, generatedPresets);
          if (!preset) throw error('Configuration item not found.', 404);
          return json(res, 200, { id, ...preset });
        }
        const items = exposedState().config[kind];
        const item = id ? items.find((x) => x.id === id) : items;
        if (!item) throw error('Configuration item not found.', 404);
        return json(res, 200, item);
      }
      return change(async () => {
        const state = store.snapshot(undefined, { forkTables: true });
        state.simulator ??= config();
        if (action === 'apply' && kind === 'presets' && method === 'POST') {
          const options = await jsonObjectBody(req);
          if (options.applyConfiguration !== undefined && typeof options.applyConfiguration !== 'boolean')
            throw error('applyConfiguration must be boolean.', 400);
          return json(res, 200, await applySelectedPreset(id, undefined, options));
        }
        const body = method === 'DELETE' ? null : await jsonObjectBody(req);
        const key = id ?? body?.id ?? body?.logicalName ?? randomUUID();
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw error('Invalid configuration identifier.');
        if (!['POST', 'PATCH', 'DELETE'].includes(method)) throw error('Unsupported configuration operation.', 405);
        if (kind === 'mappings' || kind === 'presets') {
          state[kind] ??= {};
          const exists = Object.hasOwn(state[kind], key);
          if (method === 'POST' && exists) throw error('Identifier already exists.', 409);
          if (method !== 'POST' && !exists) throw error('Configuration item not found.', 404);
          if (method === 'DELETE') delete state[kind][key];
          else {
            const previous =
              kind === 'presets' && method === 'PATCH' ? resolvePreset(state, key, generatedPresets) : state[kind][key];
            const value = { ...(previous ?? {}), ...body };
            if (kind === 'presets') value.userConfigured = true;
            delete value.id;
            delete value.logicalName;
            if (kind === 'mappings') {
              if (body.logicalName && body.logicalName !== key) throw error('Mapping id must equal its logicalName.');
              if (!value.entitySet || !value.idColumn) throw error('Mappings require entitySet and idColumn.');
              value.userConfigured = true;
            }
            state[kind][key] = value;
            if (kind === 'mappings') {
              state.tables ??= {};
              state.tables[key] ??= [];
            }
          }
        } else {
          const owner = kind === 'endpoints' ? state.simulator : state;
          owner[kind] ??= [];
          const index = owner[kind].findIndex((x) => x.id === key);
          if (kind === 'permissions' && (state.simulator.permissionSource ?? 'configured') !== 'configured') {
            const imported =
              owner[kind][index]?.imported ||
              portal.records.some((record) => record.kind === 'tablepermission' && record.id === key);
            if (state.simulator.permissionSource === 'exported' || imported)
              throw error(
                'Imported grants are source controlled. Select configured local rules to edit their local copies, or combined mode to add separate local grants.',
                409,
                'SOURCE_PERMISSION_READ_ONLY',
              );
          }
          if (method === 'POST' && index >= 0) throw error('Identifier already exists.', 409);
          if (method !== 'POST' && index < 0) throw error('Configuration item not found.', 404);
          if (method === 'DELETE') owner[kind].splice(index, 1);
          else {
            const value = { ...(owner[kind][index] ?? {}), ...body, id: key };
            if (kind === 'endpoints') validateEndpoint(value);
            if (index < 0) owner[kind].push(value);
            else owner[kind][index] = value;
          }
        }
        await saveState(state);
        json(
          res,
          method === 'POST' ? 201 : 200,
          exposedState().config[kind].find((x) => x.id === key) ?? {
            deleted: key,
          },
        );
      });
    }
    throw error('Admin endpoint not found.', 404);
  }
  // Site tables (lib/site-tables.mjs): read-only site components and web
  // role memberships derived from the export and local personas, rebuilt whenever
  // the portal or the store state object is replaced.
  // Registered on the store at load, so Liquid, FetchXML and Web API reads share them.
  // The site's active website language codes ($pages.languages.getAll; the same filter as liquid.mjs siteLanguages).
  const siteLanguageCodes = () =>
    (portal.websiteLanguages ?? [])
      .filter((language) => language.code && language.published !== false)
      .map((language) => language.code);
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
      context.provider = forceLocal ? 'local' : config().mode;
    }
    if (!forceLocal && config().mode === 'live') return forward(req, res, url);
    // Local portals Web API : routes, query options, annotations,
    // writes and the documented error envelope live in lib/webapi-handler.mjs.
    const identity = currentIdentity();
    return handleWebApi(req, res, url, {
      store,
      attachmentBody: noteAttachmentBody,
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
        if (context) context.error = cause;
        recordDiagnostic({
          ...(cause.details?.permissionDiagnostic ?? { code: cause.code ?? 'RUNTIME_ERROR', message: cause.message }),
          path: url.pathname,
          status: response.status,
        });
      },
    });
  }
  async function forward(req, res, url) {
    const context = trace.getStore();
    if (context) context.provider = 'live';
    const body = isWrite(req.method) ? await rawBody(req) : undefined;
    const response = await live.request(url.pathname + url.search, {
      method: req.method,
      body,
      contentType: req.headers['content-type'] ?? 'application/octet-stream',
      prefer: req.headers.prefer,
      ifMatch: req.headers['if-match'],
      ifNoneMatch: req.headers['if-none-match'],
    });
    let bytes = response.body;
    const headers = response.headers;
    if (headers['content-type']?.includes('json'))
      try {
        const value = JSON.parse(bytes);
        res[auditResponse] = {
          rowCount: Array.isArray(value?.value) ? value.value.length : response.status < 400 ? 1 : undefined,
          error: value?.error,
        };
      } catch {
        /* Non-JSON content follows the ordinary response or script path below. */
      }
    if (headers['content-type']?.includes('text/html'))
      bytes = Buffer.from(bytes.toString('utf8').replaceAll(live.origin, localOrigin));
    res.writeHead(response.status, { 'cache-control': 'no-store', ...headers });
    res.end(bytes);
  }
  // Local sign-in, sign-out and the session API (lib/auth-session.mjs; docs:
  // sim-administration.md "Sign-in, sign-out and sessions").
  const signInPersonas = () => personaReport().contacts.filter((contact) => contact.active);
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
      roleSource: identity.roleSource ?? 'memberships',
      accountId: identity.accountId ?? null,
      defaultPersona: { contactId: configured.contactId ?? configured.id ?? null },
      // The external provider that established this session (null for local sign-in).
      provider: identity.contactId ? (externalSignIn?.sessionProvider(session?.provider) ?? null) : null,
      identityProvider: externalSignIn?.status() ?? {
        available: false,
        reason: 'The local identity provider is not running.',
      },
      ...extra,
    };
  };
  const sessionCookie = (session) => ({
    name: authSessions.name,
    value: authSessions.value(session),
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
  async function sessionApi(req, res, url) {
    const relative = url.pathname.slice('/__sim/api/session'.length).replace(/\/$/, '');
    const auth = trace.getStore()?.auth ?? {};
    if (req.method === 'GET' && relative === '') {
      const requested = returnUrlParameter(url.searchParams);
      return json(
        res,
        200,
        describeSession(auth.session, {
          cookie: { name: authSessions.name },
          ...(requested ? { returnUrl: safeReturnUrl(requested) } : {}),
        }),
      );
    }
    // External identities in the local data, with how each was recorded (lib/sign-in-flow.mjs).
    if (req.method === 'GET' && relative === '/identities') return json(res, 200, externalSignIn.identities());
    if (req.method !== 'POST' || !['/sign-in', '/sign-out', '/roles'].includes(relative))
      throw error('Unknown session endpoint.', 404);
    if (req.headers['x-sim-csrf'] !== csrf) throw error('Missing simulator CSRF token.', 403);
    const body = await jsonBody(req);
    // A manual web-role override for this browser's signed-in session ({ roles: null } clears
    // it); it never creates a session.
    if (relative === '/roles') {
      if (!auth.session?.contactId)
        throw error('Sign this browser in through the portal first.', 409, 'SESSION_NOT_SIGNED_IN');
      if (body?.roles !== null && (!Array.isArray(body?.roles) || body.roles.some((role) => typeof role !== 'string')))
        throw error('roles must be an array of web-role names, or null to clear the override.');
      const known = new Set((appliedPermissionModel?.webRoles ?? []).map((role) => role.name));
      const unknown = (body.roles ?? []).filter((role) => !known.has(role));
      if (unknown.length) throw error(`Unknown web roles: ${unknown.join(', ')}`, 400, 'UNKNOWN_WEB_ROLES');
      const { roles: _previous, ...base } = auth.session;
      const session = body.roles === null ? base : { ...base, roles: [...new Set(body.roles)] };
      return json(res, 200, describeSession(session, { cookie: sessionCookie(session) }), {
        'set-cookie': authSessions.cookie(session),
      });
    }
    const returnUrl = safeReturnUrl(body?.returnUrl);
    const session =
      relative === '/sign-in' ? signInSession(body?.contactId, { roles: body?.roles }) : { contactId: null };
    return json(res, 200, describeSession(session, { returnUrl, cookie: sessionCookie(session) }), {
      'set-cookie': authSessions.cookie(session),
    });
  }
  // A session for a contact (an active local contact) or, with roles, a manual role
  // override; shared by POST /_sim/api/session/sign-in and simulator.signIn().
  function signInSession(contactId, { roles } = {}) {
    if (typeof contactId !== 'string' || !contactId.trim()) throw error('contactId must be a local contact ID.');
    if (roles !== undefined && (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string')))
      throw error('roles must be an array of web-role names.');
    if (roles !== undefined) return { contactId: contactId.trim(), roles: [...new Set(roles)] };
    const persona = signInPersonas().find((item) => personaKey(item.contactId) === personaKey(contactId.trim()));
    if (!persona)
      throw error('The selected persona must be an active local contact.', 404, 'PERSONA_CONTACT_UNAVAILABLE');
    return { contactId: persona.contactId };
  }
  // The sign-in page renders inside the site's shell: website header and footer, and the
  // exported "Login" or "Sign In" site-marker page's title and copy when present.
  const SIGN_IN_MARKER = '<!--paqvilo-mirage-sign-in-content-->';
  let signInShell = null;
  const signInRenderer = () => {
    if (signInShell?.renderer === renderer) return signInShell;
    const exported = ['Login', 'Sign In']
      .map((name) => (portal.siteMarkers ?? []).find((marker) => marker.name === name))
      .filter(Boolean)
      .map((marker) => portal.pages.find((page) => page.id === marker.pageId))
      .find(Boolean);
    const html = (exported?.html ?? '') + SIGN_IN_MARKER;
    const page = {
      id: 'paqvilo-mirage-sign-in',
      // The platform's account pages are not site map nodes (live sign-in: data-sitemap-state "/").
      outsideSitemap: true,
      name: exported?.name ?? 'Sign in',
      // Outside the site map the layout title is the home page's (live sign-in: "Home").
      title: exported?.title ?? servicePages(portal).home?.title ?? 'Sign in',
      url: '/SignIn/',
      parentId: exported?.parentId ?? servicePages(portal).home?.id ?? null,
      pageTemplateId: null,
      html,
      css: exported?.css ?? '',
      js: '',
      summary: '',
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
  async function renderAccountPage(req, res, url, { status = 200, content, route = 'sign-in-page' }) {
    const shell = signInRenderer();
    const renderedRevision = revision;
    const identity = currentIdentity();
    const rendered = await shell.value.renderPage(shell.page.url, {
      user: identity,
      request: { url: url.href, path: url.pathname, params: Object.fromEntries(url.searchParams), method: req.method },
    });
    for (const diagnostic of rendered.diagnostics ?? []) recordDiagnostic({ ...diagnostic, path: url.pathname });
    let html = String(rendered.html ?? '');
    const marker = html.indexOf(SIGN_IN_MARKER);
    // A content function is an account layout region (the sign-in page, lib/auth-session.mjs
    // signInContent): it replaces the page's main region and receives the rendered page copy.
    const main = marker >= 0 ? html.lastIndexOf('<main id="mainContent">', marker) : -1;
    if (typeof content === 'function' && main >= 0) {
      const valueOpen = '<div class="xrm-attribute-value">';
      const valueStart = html.indexOf(valueOpen, main);
      const copy =
        valueStart >= 0 && valueStart < marker ? html.slice(valueStart + valueOpen.length, marker).trim() : '';
      const mainEnd = html.indexOf('</main>', marker);
      html =
        html.slice(0, main) +
        content(copy) +
        html.slice(mainEnd < 0 ? marker + SIGN_IN_MARKER.length : mainEnd + '</main>'.length);
      // Account pages link the platform's account stylesheet after the platform styles (live head).
      html = html.replace(
        /<link href="[^"]*\/privatemode\.bundle-[^"]*"[^>]*>/,
        (link) => `${link}<link rel="stylesheet" href="/Areas/Account/css/account.css">`,
      );
    } else {
      const markup = typeof content === 'function' ? content('') : content;
      if (marker >= 0) html = html.replace(SIGN_IN_MARKER, () => markup);
      else if (/<body[^>]*>/i.test(html)) html = html.replace(/<body[^>]*>/i, (tag) => tag + markup);
      else html += markup;
    }
    if (rendered.isDocument !== false) {
      html = injectRuntimeDependencies(html, sourceDependencies);
      html = injectLocalHead(injectRuntimeCompatibility(html, sourceDependencies), localOverrides);
      html = injectRuntime(html, csrf, renderedRevision, identity, trace.getStore()?.spanId, siteLanguageCodes());
    }
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      ...PAGE_HEADERS,
      ...siteHeaders(portal, { confinement: confinementPolicy(), kind: 'page' }),
      'x-sim-route': route,
    });
    return res.end(html);
  }
  // The platform's sign-in page: the site's external providers (lib/sign-in-flow.mjs) and,
  // when local sign-in is enabled or the site configures no provider, the local personas.
  async function renderSignIn(
    req,
    res,
    url,
    { status = 200, returnUrl = '/', error: problem = null, invitationCode = null } = {},
  ) {
    const flags = authenticationSettings(portal);
    const providers = externalSignIn?.signInProviders() ?? [];
    const showPersonas = flags.localLogin || !providers.length;
    const content = (copy) =>
      signInContent({
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
        anonymousUrl: anonymousCanRead(returnUrl) ? returnUrl : '/',
        invitationCode,
        redeemInvitation: providers.length > 0 && !invitationCode && flags.registration && flags.invitation,
        error: problem,
        title: signInRenderer().page.title,
      });
    return renderAccountPage(req, res, url, { status, content, route: 'sign-in-page' });
  }
  async function signInForm(req) {
    const bytes = await rawBody(req);
    const type = String(req.headers['content-type'] ?? 'application/x-www-form-urlencoded')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (type === 'application/json') {
      try {
        const value = bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch {
        throw error('Request body must be valid JSON.');
      }
    }
    return Object.fromEntries(new URLSearchParams(bytes.toString('utf8')));
  }
  // The sign-in page and the local persona sign-in; sign-out and external sign-in are
  // answered earlier by lib/sign-in-flow.mjs.
  async function authenticate(req, res, url, route) {
    const requested = returnUrlParameter(url.searchParams);
    if (route.kind === 'sign-in-post') {
      const form = await signInForm(req);
      const returnUrl = safeReturnUrl(form.ReturnUrl ?? form.returnUrl ?? requested);
      if (!authenticationSettings(portal).localLogin && externalSignIn?.signInProviders().length)
        return renderSignIn(req, res, url, {
          status: 400,
          returnUrl,
          error:
            'Local sign-in is turned off for this site (Authentication/Registration/LocalLoginEnabled is false): sign in with an external provider.',
        });
      if (form.personaKey) {
        if (form.__RequestVerificationToken !== csrf) throw error('Missing simulator CSRF token.', 403);
        const result = await launchPersona({
          personaKey: form.personaKey,
          returnUrl: form.ReturnUrl ? personaStartPath(form.ReturnUrl, 'returnUrl') : undefined,
        });
        res.writeHead(302, {
          location: result.url,
          'set-cookie': result.cookieHeader + '; Path=/; HttpOnly; SameSite=Lax',
          'cache-control': 'no-store',
        });
        return res.end();
      }
      if (personaReport().enabled && form.__RequestVerificationToken !== csrf)
        throw error('Missing simulator CSRF token.', 403);
      const contactId = typeof form.contactId === 'string' ? form.contactId.trim() : '';
      const persona = personaKey(contactId)
        ? signInPersonas().find((item) => personaKey(item.contactId) === personaKey(contactId))
        : null;
      if (!persona)
        return renderSignIn(req, res, url, {
          status: 400,
          returnUrl,
          error: 'Choose an active local persona to sign in.',
        });
      res.writeHead(302, {
        location: returnUrl,
        'set-cookie': authSessions.cookie({ contactId: persona.contactId }),
        'cache-control': 'no-store',
        'x-sim-route': 'sign-in',
      });
      return res.end();
    }
    const returnUrl = safeReturnUrl(requested);
    if (currentIdentity().contactId) {
      res.writeHead(302, { location: returnUrl, 'cache-control': 'no-store', 'x-sim-route': 'signed-in' });
      return res.end();
    }
    return renderSignIn(req, res, url, { returnUrl, invitationCode: url.searchParams.get('InvitationCode') || null });
  }
  externalSignIn = createExternalSignIn({
    portal: () => portal,
    origin: () => localOrigin,
    csrf,
    sessions: authSessions,
    store,
    personas: signInPersonas,
    personaCatalog: personaReport,
    identityProvider: { settings: providerSettings, assets: providerAssets },
    webRoles: () => appliedPermissionModel?.webRoles ?? [],
    identity: currentIdentity,
    audit,
    trace,
    diagnostic: recordDiagnostic,
    renderSignIn,
    renderPage: renderAccountPage,
    readBody: rawBody,
  });
  const modelDrivenCatalogue = storeCatalogue({
    store,
    metadata: modelMetadata,
    source: () => portal,
    options: (metadata) => ({
      lazy: true,
      portal,
      metadata,
      mappings: store.state.mappings,
      defaultApp: runtimeOption.defaultApp,
      settings: store.state.settings,
      clientExtensions: clientExtensionCatalogue(clientResources, modelDrivenSettingsValue),
      canvasApps: canvasAppNames(organizationHost),
    }),
  });
  const modelDrivenData = createModelDrivenData({
    store,
    catalogue: modelDrivenCatalogue,
    portal: () => portal,
    readMetadata: (fn) => solutionMetadataOverlay.withReadEpoch(fn, { valid: () => store.isUnmodifiedRead() }),
    recordService: {
      get: (...args) => organizationRecords.get(...args),
      retrieve: (...args) => organizationRecords.retrieve(...args),
      query: (...args) => organizationRecords.query(...args),
      list: (...args) => organizationRecords.list(...args),
      write: (input) => organizationRecords.write(input),
      capabilities: (...args) => organizationRecords.capabilities(...args),
    },
    writeRecord: dataverseConfig.enabled ? (input) => dataverse.writeLocalRecord(input) : null,
    saveOverlay: async (key, value) => {
      const state = store.snapshot(undefined, { forkTables: true });
      state.simulator.modelDriven ??= {};
      state.simulator.modelDriven.records = {
        ...state.simulator.modelDriven.records,
        [key]: value === null ? null : { ...state.simulator.modelDriven.records?.[key], ...value },
      };
      await saveState(state);
    },
  });
  const modelDrivenHandler = createModelDrivenHandler({
    streamMetadata: true,
    workerMetadata: true,
    sourceMaps,
    diagnostic: recordDiagnostic,
    catalogue: modelDrivenCatalogue,
    data: modelDrivenData,
    clientAssets: () =>
      modelDrivenSettingsValue.trustedExtensions
        ? clientResources.assets
        : new Map([...clientResources.assets].filter(([, asset]) => asset.passive === true)),
    csrf: () => csrf,
    json,
    readBody: jsonObjectBody,
    change,
    read: (fn) => store.readOperation(() => solutionMetadataOverlay.withReadEpoch(fn)),
    principal: (req) => staffSessions.resolve(req),
    webApi: createModelDrivenWebApi({ organization: () => organization }),
    offlineState: offlineSessionState(store, change),
  });
  closeModelDriven = () => modelDrivenHandler.close();

  // Reserved app surfaces: canvas inventory pages and code apps answer before the model-driven handler.
  // Canvas apps run headlessly (canvas-runtime.mjs) as the staff session's user or, for a signed-in portal visitor, the
  // Dataverse user enhanced authorization maps the contact to (portal-authorization.mjs principal); never SYSTEM.
  const canvasApps = () =>
    canvasPcfApps(organizationHost.canvasApps(), codeComponents, {
      enabled: organizationHost.canvas.codeComponents,
      platformLibraries: clientResources.pcf?.platformLibraries,
      display: config().observed?.canvasDisplay,
      displayEvidence: config().observed?.evidence,
      watch,
    });
  const canvasRuntime = createCanvasRuntime({
    apps: canvasApps,
    evaluator: () => organizationHost.providers.powerFx,
    api: () => organization?.api ?? null,
    caller: (principal) => {
      const user = organization?.principals.byId(principal?.principalId);
      return user ? { user } : null;
    },
    transact: (fn) => change(() => organization.runOwned(() => organization.runAtomic(fn))),
    connectors: codeAppConnectors(organizationHost.connectors, settingOptionsRest.connections ?? {}),
    diagnostic: recordDiagnostic,
  });
  const canvasPrincipal = (req) => {
    const staff = staffSessions.resolve(req);
    if (staff.kind === 'staff') return staff;
    const identity = currentIdentity();
    if (!(identity?.contactId ?? identity?.id)) return null;
    try {
      const user = store.portalAuthorization?.principal(identity)?.user;
      return user ? { kind: 'portal', principalId: user.systemuserid } : null;
    } catch {
      return null;
    } // a visitor enhanced authorization does not map runs nothing
  };
  const canvasHandler = createCanvasHandler({
    apps: canvasApps,
    enabled: () => organizationHost.canvas.enabled,
    diagnostic: recordDiagnostic,
    runtime: canvasRuntime,
    principal: canvasPrincipal,
    csrf: () => csrf,
  });
  let codeAppRecords = loadCodeApps(codeApps, projectRoot, { bindings: settingOptionsRest.connections ?? {} });
  for (const app of codeAppRecords) for (const entry of app.diagnostics) recordDiagnostic({ ...entry, app: app.name });
  const codeAppsHandler = createCodeAppsHandler({
    apps: () =>
      (codeAppRecords = loadCodeApps(codeApps, projectRoot, { bindings: settingOptionsRest.connections ?? {} })),
    sessions: staffSessions,
    user: (id) => {
      if (!organization) throw error('Code apps need the organization runtime.', 503, 'OrganizationUnavailable');
      return organization.principals.byId(id);
    },
    organization: {
      get origin() {
        return dataverse?.origin ?? localOrigin;
      },
      get organizationId() {
        return organization?.organizationId;
      },
      get environmentId() {
        return organization?.environmentId;
      },
      get tenantId() {
        return organization?.tenantId;
      },
    },
    issueToken: (input) => {
      if (!dataverse)
        throw error(
          'Code app tokens need the Dataverse API; enable dataverse in the runtime settings.',
          501,
          'DataverseApiDisabled',
        );
      return authorityTokenIssuer({ issueAccessToken: dataverse.issueAccessToken, origin: dataverse.origin })(input);
    },
    dataverse: (input) =>
      codeAppDataverse({ organization, change, origin: () => dataverse?.origin ?? localOrigin })(input),
    connectors: codeAppConnectors(organizationHost.connectors, settingOptionsRest.connections ?? {}),
    csrf: () => csrf,
    diagnostic: recordDiagnostic,
  });
  async function handle(req, res) {
    // Normalize the admin alias before security checks so rejected requests
    // keep the same JSON error contract for both spellings.
    if (/^\/_sim(?:\/|\?|$)/.test(req.url)) req.url = req.url.replace(/^\/_sim/, '/__sim');
    if (req.headers.host !== new URL(localOrigin).host) throw error('Invalid Host header.', 403);
    // The one cross-origin request a portal accepts: the identity provider's form post to
    // the reply URL (the local identity provider's origin only).
    if (req.headers.origin && req.headers.origin !== localOrigin && !externalSignIn?.acceptsOrigin(req))
      throw error('Cross-origin requests are not allowed.', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site' && isWrite(req.method))
      throw error('Cross-site writes are not allowed.', 403);
    const url = requestTargetUrl(req.url, localOrigin);
    if (
      managementStorage &&
      !isDeepStrictEqual(store.state.simulator?.modelDriven?.records ?? {}, appliedManagementRecords)
    )
      await change(async () => {});
    // Power Pages document control (sharepoint-documents.mjs createPortalDocumentService), local route under /_apps/ (before the model-driven handler, which refuses other /_apps paths).
    if (
      organization?.api?.sharepoint &&
      (await (portalDocuments ??= createPortalDocumentService({
        sharepoint: organization.api.sharepoint,
        store,
        portal: () => portal,
        access: portalDocumentAccess,
        // An unconfigured BlockedAttachments uses the Dataverse organization default list
        // (DATAVERSE_BLOCKED_ATTACHMENTS); the organization row, a catalogue default or an instance override (even empty) replaces it.
        blockedExtensions: () => {
          const entry = platformSettingEntries(store.state).find((item) => item.key === 'BlockedAttachments');
          return String(
            entry.origin === 'Default / not configured' ? DATAVERSE_BLOCKED_ATTACHMENTS : (entry.value ?? ''),
          )
            .split(/[;,\s]+/)
            .map((item) => item.toLowerCase().replace(/^\./, ''))
            .filter(Boolean);
        },
      })).handle(req, res, url, { identity: currentIdentity(), csrf }))
    )
      return;
    if (canvasHandler(req, res, url)) return;
    if (await codeAppsHandler(req, res, url)) return;
    if (modelDrivenSettingsValue.enabled !== false && (await modelDrivenHandler(req, res, url))) return;
    if (
      req.headers['x-paqvilo-local-only'] === 'true' &&
      (config().mode === 'live' ||
        config().pageMode === 'live' ||
        (config().endpoints ?? []).some(
          (endpoint) => endpoint.enabled !== false && endpoint.path === url.pathname && endpoint.mode === 'live',
        ))
    )
      throw error('This visitor requires local Mirage execution.', 409, 'LocalRuntimeRequired');
    if (frameReadiness.handle(req, res, url)) return;
    // Mirage responses only; portal responses carry the HTTP/* site-setting headers.
    if (url.pathname === '/__sim' || url.pathname.startsWith('/__sim/') || url.pathname.startsWith('/__sim-'))
      res.setHeader('X-Content-Type-Options', 'nosniff');
    // Power Pages resolves application-relative links even when authored inside
    // JavaScript. Normalize the app-relative path before ordinary routing.
    if (['GET', 'HEAD'].includes(req.method) && /^\/(?:~|%7e)\//i.test(url.pathname)) {
      const target = url.pathname.replace(/^\/(?:~|%7e)\/+/i, '/') + url.search;
      res.writeHead(302, { location: target, 'cache-control': 'no-store' });
      return res.end();
    }
    // Endpoints contributed by the data packs serving this portal
    // (lib/extensions.mjs); the runtime itself defines none.
    for (const endpoint of packEndpointList) {
      const match = endpoint.pattern.exec(url.pathname);
      if (!match) continue;
      if (!endpoint.methods.includes(req.method))
        throw error(`${endpoint.id} requires ${endpoint.methods.join(' or ')}.`, 405);
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
    const formRoute = /^\/__sim\/forms\/(entityform|webform)\/([\w-]+)\/submit$/.exec(url.pathname);
    if (formRoute) {
      if (req.method !== 'POST') throw error('Native form submission requires POST.', 405);
      if (req.headers.__requestverificationtoken !== csrf) throw error('Missing portal verification token.', 403);
      const body = await jsonBody(req);
      const formIdentity = currentIdentity();
      // An anonymous visitor's advanced form session belongs to its browser session: the
      // first submission without a visitor cookie starts one (lib/visitor-session.mjs).
      let visitor = trace.getStore()?.visitor ?? null;
      if (formRoute[1] === 'webform' && !webFormSessionOwner(formIdentity, visitor)) {
        const started = newVisitor(visitorName());
        visitor = started.id;
        res.setHeader('set-cookie', started.cookie);
      }
      const pageTarget = new URL(
        typeof body?.pageUrl === 'string' && body.pageUrl.startsWith('/') ? body.pageUrl : '/',
        localOrigin,
      );
      return change(async () => {
        const result = await submitPortalForm(
          formRoute[1],
          formRoute[2],
          body,
          formSubmissionOptions(formIdentity, visitor, pageTarget),
        );
        return json(
          res,
          result.operation === 'create' ? 201 : 200,
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
    if (url.pathname.startsWith('/__sim/api')) return admin(req, res, url);
    if (url.pathname === '/__sim/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: ready\ndata: ${revision}\n\n`);
      events.add(res);
      // Administrators opt into the runtime log channel; portal pages only receive reloads.
      const logs = (url.searchParams.get('channels') ?? '').split(',').includes('logs');
      if (logs) {
        logClients.add(res);
        res.write(
          `event: log\ndata: ${JSON.stringify({ sequence: ++logSequence, type: 'connected', time: new Date().toISOString(), level: 'info', revision })}\n\n`,
        );
      }
      req.on('close', () => {
        events.delete(res);
        logClients.delete(res);
      });
      return;
    }
    if (url.pathname === '/__sim/sign-in') {
      if (req.method === 'POST') {
        const body = await signInForm(req);
        if (body.__RequestVerificationToken !== csrf) throw error('Missing simulator CSRF token.', 403);
        const result = await launchPersona({ personaKey: body.personaKey, returnUrl: body.ReturnUrl });
        res.writeHead(302, {
          location: result.url,
          'set-cookie': result.cookieHeader + '; Path=/; HttpOnly; SameSite=Lax',
          'cache-control': 'no-store',
        });
        return res.end();
      }
      if (req.method !== 'GET') throw error('Method not allowed', 405);
      const personaKey = url.searchParams.get('persona')?.trim();
      if (!personaKey) throw error('The persona parameter is required.', 400, 'PersonaParameterRequired');
      const persona = findPersona(personaKey);
      const report = personaReport();
      const returnUrl = personaStartPath(
        url.searchParams.get('returnUrl') ??
          persona.startPath ??
          report.contexts.find((context) => context.id === persona.context)?.startPath ??
          '/',
        url.searchParams.has('returnUrl') ? 'returnUrl' : 'Persona startPath',
      );
      const { renderPersonaPicker } = await import('./lib/persona-picker-view.mjs');
      const content =
        '<link rel="stylesheet" href="/__sim/persona-picker.css"><h1>Local persona sign-in</h1><p>Review the persona and sign in. This changes this browser’s local session only.</p><form method="post" action="/_sim/sign-in"><input type="hidden" name="__RequestVerificationToken" value="' +
        csrf +
        '"><input type="hidden" name="ReturnUrl" value="' +
        escaped(returnUrl) +
        '">' +
        renderPersonaPicker(
          {
            ...report,
            personas: [persona],
            other: [],
            total: 1,
            groups: report.groups
              .filter((group) => group.id === persona.group)
              .map((group) => ({ ...group, count: 1 })),
          },
          { mode: 'signin' },
        ) +
        '</form>';
      return renderAccountPage(req, res, url, { status: 200, content, route: 'persona-shortcut' });
    }
    if (url.pathname === '/__sim' || url.pathname === '/__sim/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': ADMIN_CSP,
        'x-content-type-options': 'nosniff',
      });
      return res.end(await fs.readFile(path.join(ROOT, 'admin/index.html')));
    }
    // Admin assets by pattern (runtime-admin.mjs adminAssetFile): mirage/admin/<name>.mjs|css and the shared lib modules.
    const adminAsset = /^\/__sim\/([^/]+\.(?:mjs|css))$/.exec(url.pathname);
    const adminFile = adminAsset && ['GET', 'HEAD'].includes(req.method) ? await adminAssetFile(adminAsset[1]) : null;
    if (adminFile) {
      res.writeHead(200, {
        'content-type': adminAssetType(adminAsset[1]),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      return res.end(req.method === 'HEAD' ? undefined : await fs.readFile(adminFile));
    }
    if (/^\/__sim\/evidence\/(live|local|difference)\.png$/.test(url.pathname) && evidenceDir) {
      let bytes;
      try {
        bytes = await fs.readFile(path.join(evidenceDir, path.basename(url.pathname)));
      } catch {
        throw error('Evidence image is unavailable.', 404);
      }
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
      });
      return res.end(bytes);
    }
    if (/^\/__sim(?:\/|$)/.test(url.pathname)) throw error('Simulator resource not found.', 404);
    if (url.pathname === '/_layout/tokenhtml') {
      // Native: a self-closing hidden input plus the anti-forgery cookie token, with the page
      // headers the platform sends on it (lib/response-headers.mjs tokenHtmlHeaders).
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        ...tokenHtmlHeaders(portal, { confinement: confinementPolicy() }),
        'set-cookie': antiForgeryCookie(csrf),
      });
      return res.end(`<input name="__RequestVerificationToken" type="hidden" value="${csrf}" />`);
    }
    const endpoint = (config().endpoints ?? []).find(
      (e) =>
        e.enabled !== false &&
        e.path === url.pathname &&
        (!e.method || e.method === '*' || e.method.toUpperCase() === req.method),
    );
    if (endpoint) {
      if (endpoint.mode === 'live') return forward(req, res, url);
      if (isWrite(req.method) && req.headers.__requestverificationtoken !== csrf)
        throw error('Missing portal verification token.', 403);
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
      return res.end(
        req.method === 'HEAD'
          ? undefined
          : await fs.readFile(new URL('./lib/code-components-client.js', import.meta.url)),
      );
    }
    if (url.pathname.startsWith('/__sim-static/pcf/')) {
      if (!['GET', 'HEAD'].includes(req.method)) throw error('PCF resources require GET or HEAD.', 405);
      const asset = codeComponents.assets.get(url.pathname);
      if (!asset) throw error('This PCF resource is not declared in a selected manifest.', 404);
      const real = await fs.realpath(asset.file);
      if (real !== asset.file || (await fs.stat(real)).size > 8 * 1024 * 1024)
        throw error('The declared PCF resource changed outside its source boundary.', 404);
      const type =
        asset.kind === 'code'
          ? 'text/javascript; charset=utf-8'
          : asset.kind === 'css'
            ? 'text/css; charset=utf-8'
            : asset.kind === 'resx'
              ? 'application/xml; charset=utf-8'
              : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(
        req.method === 'HEAD' ? undefined : await readLocalFile(real, { root: asset.root, maxBytes: 8 * 1024 * 1024 }),
      );
    }
    const serverLogic = serverLogicName(url.pathname);
    if (serverLogic !== null) {
      if (
        operationPortal().serverLogics.some((record) => record.name.toLowerCase() === serverLogic.toLowerCase()) &&
        config().mode !== 'live'
      ) {
        try {
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method))
            throw error('This method cannot execute server logic.', 405);
          if (isWrite(req.method) && req.headers.__requestverificationtoken !== csrf)
            throw error('Missing portal verification token.', 403, 'Forbidden');
          const raw = await executeServerLogic({
            name: serverLogic,
            method: req.method,
            body: isWrite(req.method) ? (await rawBody(req)).toString('utf8') : '',
            query: Object.fromEntries(url.searchParams),
          });
          if (raw !== null)
            return json(
              res,
              200,
              { requestId: randomUUID(), success: true, serverLogicName: serverLogic, data: raw, error: null },
              { 'x-sim-route': 'server-logic-local', 'cache-control': 'no-store' },
            );
        } catch (cause) {
          recordDiagnostic({
            code: cause.code ?? 'SERVER_LOGIC_FAILED',
            name: serverLogic,
            path: url.pathname,
            message: cause.message,
          });
          return json(
            res,
            cause.status ?? 500,
            {
              requestId: randomUUID(),
              success: false,
              serverLogicName: serverLogic,
              data: null,
              error: { code: cause.code ?? 'ServerLogicFailed', message: cause.message },
            },
            { 'x-sim-route': 'server-logic-local', 'cache-control': 'no-store' },
          );
        }
      }
      const answer = serverLogicUnsupported(operationPortal(), serverLogic, req.method);
      recordDiagnostic({ ...answer.diagnostic, path: url.pathname });
      return json(res, answer.status, answer.body, answer.headers);
    }
    // The default search page when the export has none at /search/ (portal-search.mjs).
    if (
      /^\/search\/?$/i.test(url.pathname) &&
      req.method === 'GET' &&
      !portal.pages.some((page) => /^\/search\/?$/i.test(page.url ?? ''))
    ) {
      const html = await renderPortalSearchPage({
        portal,
        store,
        readProvider,
        metadata: solutionMetadata,
        config: config(),
        identity: currentIdentity(),
        params: url.searchParams,
        diagnostic: (entry) => recordDiagnostic({ ...entry, path: url.pathname }),
      });
      // The same page response headers as every portal page: site HTTP/* settings, the confinement CSP, nosniff.
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        ...PAGE_HEADERS,
        ...siteHeaders(portal, { confinement: confinementPolicy(), kind: 'page' }),
        'x-sim-route': 'portal-search-local',
      });
      return res.end(html);
    }
    const flow = operationPortal().cloudFlows.find(
      (record) =>
        record.path && record.path.replace(/\/$/, '').toLowerCase() === url.pathname.replace(/\/$/, '').toLowerCase(),
    );
    if (flow && config().mode !== 'live') {
      if (req.method !== 'POST') throw error('Cloud-flow triggers require POST.', 405);
      if (req.headers.__requestverificationtoken !== csrf) throw error('Missing portal verification token.', 403);
      const identity = currentIdentity();
      assertOperationRole(flow, identity);
      const bytes = (await rawBody(req)).toString('utf8');
      let input;
      try {
        const parsed = String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')
          ? Object.fromEntries(new URLSearchParams(bytes))
          : JSON.parse(bytes || '{}');
        input = typeof parsed.eventData === 'string' ? JSON.parse(parsed.eventData) : (parsed.eventData ?? parsed);
      } catch {
        throw error('Cloud-flow input must be valid JSON.', 400);
      }
      const answer = await runPortalFlow({ flow, input, identity });
      return json(res, answer.status ?? 200, Object.hasOwn(answer, 'body') ? answer.body : answer, {
        ...answer.headers,
        'x-sim-route': 'cloud-flow-local',
        'cache-control': 'no-store',
      });
    }
    // The platform's account stylesheet (account pages): local equivalent.
    if (/^\/areas\/account\/css\/account\.css$/i.test(url.pathname) && ['GET', 'HEAD'].includes(req.method)) {
      const file = path.join(ROOT, 'lib', 'account-compat.css');
      const body = await fs.readFile(file);
      // Dated by the local file, as the platform's by its build; conditional requests get 304.
      const headers = {
        ...platformResourceHeaders('static', {
          pathname: url.pathname.toLowerCase(),
          body,
          contentType: 'text/css; charset=utf-8',
          frameOptions: siteHeaders(portal)['x-frame-options'],
          modified: (await fs.stat(file)).mtimeMs,
        }),
        'cache-control': 'public,max-age=604800',
        'x-sim-resource-provider': 'local-platform-equivalent',
      };
      const unchanged = notModified(req.headers, headers);
      res.writeHead(unchanged ? 304 : 200, headers);
      return res.end(req.method === 'HEAD' || unchanged ? undefined : body);
    }
    // The platform's stack ranking plug-in (form pages with stack rank cells): local equivalent.
    if (url.pathname === '/xrm-adx/js/jquery.stackranking.js' && ['GET', 'HEAD'].includes(req.method)) {
      const file = path.join(ROOT, 'lib', 'stackranking-compat.js');
      const body = await fs.readFile(file);
      const headers = {
        ...platformResourceHeaders('static', {
          pathname: url.pathname.toLowerCase(),
          body,
          contentType: 'application/javascript; charset=utf-8',
          frameOptions: siteHeaders(portal)['x-frame-options'],
          modified: (await fs.stat(file)).mtimeMs,
        }),
        'x-sim-resource-provider': 'local-platform-equivalent',
      };
      const unchanged = notModified(req.headers, headers);
      res.writeHead(unchanged ? 304 : 200, headers);
      return res.end(req.method === 'HEAD' || unchanged ? undefined : body);
    }
    // Native quick view document (/_portal/quickform-template-path/{websiteId}): the platform
    // serves it through the layout master (live evidence): the layout frame of a document outside
    // the site map (lib/liquid.mjs serviceLayout), the platform chrome and the WebForms content_form
    // around the read-only entity form view (lib/platform.mjs renderQuickForm).
    const quickView = /^\/_portal\/quickform-template-path\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
    const quickSite = String(
      portal.website?.id ?? portal.website?.adx_websiteid ?? portal.website?.mspp_websiteid ?? '',
    )
      .replace(/[{}]/g, '')
      .toLowerCase();
    if (quickView && config().pageMode !== 'live' && quickView[1].toLowerCase() === quickSite) {
      try {
        if (!['GET', 'HEAD'].includes(req.method))
          throw error('Quick view forms require GET.', 405, 'MethodNotAllowed');
        // The server-rendered URL of a bound frame (it alone carries isprofilepage/lang) is replaced
        // by the platform client after its token request; on a remote portal that abandons this
        // navigation before it commits (live: status 0, none of its resources load). Loopback would
        // answer first, so the answer waits for that replacement.
        // Bound the replacement wait to three seconds; a frame without the platform client loads after that wait.
        if (url.searchParams.has('isprofilepage') && url.searchParams.get('entityid')) {
          let abandoned = false;
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 3000);
            res.once('close', () => {
              abandoned = true;
              clearTimeout(timer);
              resolve();
            });
          });
          if (abandoned) return;
        }
        const quickIdentity = currentIdentity();
        const body = await renderQuickForm({
          portal,
          store,
          readProvider,
          identity: quickIdentity,
          params: Object.fromEntries(url.searchParams),
          metadata: solutionMetadata,
          schemas: { ...solutionMetadata.componentSchemas, ...config().componentSchemas },
        });
        const layout = await renderer.serviceLayout(url.pathname + url.search, { user: quickIdentity });
        const resource = (entry) => renderShellResource(entry, 'css', { localOnly: true });
        const bootstrapFile = portal.webFiles.find((f) => /\/bootstrap\.min\.css$/i.test(f.url ?? ''));
        const home = servicePages(portal).home ?? { id: null, url: '/', name: '', metadata: {} };
        const sourceStyles = await renderer.contentStylesheets(home, layout.context);
        const quickPlatform = platformShell({
          variant: bootstrapVariant(portal.settings),
          profile: config().shellProfile ?? null,
          websiteId: quickSite,
          languageCode: layout.languageCode,
          bootstrap: sourceStyles.bootstrap || resource(bootstrapFile?.url ?? '/css/bootstrap.min.css'),
          renderStyles: (paths) => paths.map(resource).join(''),
        });
        const styles =
          quickPlatform.headStart +
          quickPlatform.remaining.stylesheets.map(resource).join('') +
          formContentStyles(sourceStyles.content, config().shellProfile) +
          layout.head +
          quickPlatform.headEnd;
        for (const item of formStyleDiagnostics(body, config().shellProfile))
          recordDiagnostic({ ...item, path: url.pathname });
        // The form posts back to the document's own path (./{websiteId}?query); only the entity form view script loads.
        const form = webFormsForm({
          id: 'content_form',
          action: `./${quickSite}${url.search}`,
          content: body,
          validators: true,
          formScriptPaths: ['/xrm-adx/js/crmentityformview.js'],
          variant: quickPlatform.variant,
        });
        const document = `<!doctype html>${layout.html}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>${layout.title}</title>${styles}</head>${layout.body}${quickPlatform.bodyOpen}${layout.chrome}${antiForgeryHolder(`/_portal/${quickSite}/Layout/GetAntiForgeryToken`)}${quickPlatform.bodyStart}<div id="content-container" class="container quickform"><div id="content">${form}</div></div>${quickPlatform.afterContent}${quickPlatform.afterFooter}</body></html>`;
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          ...PAGE_HEADERS,
          'x-frame-options': siteHeaders(portal)['x-frame-options'],
        });
        return res.end(
          req.method === 'HEAD'
            ? undefined
            : frameReadiness.decorate(injectLocalHead(document, localOverrides), {
                path: url.pathname,
                observed: config().observed ?? portal.observed,
              }),
        );
      } catch (cause) {
        res.writeHead(cause.status ?? 500, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(`<!doctype html><title>Quick view</title><p role="alert">${escaped(cause.message)}</p>`);
      }
    }
    if (
      await handleNativeService(req, res, url, {
        portal,
        store,
        readProvider,
        identity: currentIdentity(),
        csrf,
        attachmentBody: noteAttachmentBody,
        config: config(),
        schemas: { ...solutionMetadata.componentSchemas, ...config().componentSchemas },
        metadata: solutionMetadata,
        compat: localOverrides.compat,
        live,
        liveMapping,
        change,
        origin: localOrigin,
        cache,
        recordDiagnostic,
        decorateDocument: (html) =>
          frameReadiness.decorate(injectLocalHead(html, localOverrides), {
            path: url.pathname,
            observed: config().observed ?? portal.observed,
          }),
        formStyles: async (target) => {
          const home = servicePages(portal).home ?? { id: null, url: '/', name: '', metadata: {} };
          return renderer.contentStylesheets(home, renderer.contextForPage(home, target, { user: currentIdentity() }));
        },
        renderLiquid: (source, ctx) => renderer.renderString(source, ctx),
        serviceLayout: (target) => renderer.serviceLayout(target, { user: currentIdentity() }),
        pageContext: (target) =>
          renderer.contextForPage(
            servicePages(portal).home ?? { id: 'service', url: '/', name: '', title: '', metadata: {} },
            target,
            { user: currentIdentity() },
          ),
      })
    )
      return;
    const fileApi = /^\/_api\/file\/(InitializeFileUpload|UploadFileBlock)\/note$/i.exec(url.pathname);
    if (fileApi) {
      const answer = (status, body) => {
        // Live: page cache headers and the site frame option; a JSON answer also varies by encoding, the 204 does not.
        const { vary, ...page } = PAGE_HEADERS;
        res.writeHead(status, {
          ...page,
          'x-frame-options': siteHeaders(portal)['x-frame-options'],
          ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8', vary }),
        });
        return res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (req.headers.__requestverificationtoken !== csrf) throw error('Missing portal verification token.', 403);
      const now = Date.now();
      for (const [id, entry] of stagedUploads) if (now - entry.created > 3600000) dropStaged(id);
      if (/^InitializeFileUpload$/i.test(fileApi[1])) {
        if (req.method !== 'POST') throw error('File upload initialisation requires POST.', 405);
        await rawBody(req);
        const name = String(req.headers['x-ms-file-name'] ?? '').trim();
        const size = Number(req.headers['x-ms-file-size']);
        if (!name || !Number.isSafeInteger(size) || size < 0 || size > 8 * 1024 * 1024)
          throw error('The file name and size are required (at most 8 MiB).', 400);
        if (stagedUploads.size >= 50)
          throw error(
            'The local runtime has 50 staged files. Submit pending forms or wait for unused uploads to expire before adding another file.',
            409,
            'StagedUploadLimit',
          );
        const id = randomUUID();
        const token = randomBytes(24).toString('base64');
        if (!trace.getStore().visitor) {
          const visitor = newVisitor(visitorName());
          trace.getStore().visitor = visitor.id;
          res.setHeader('set-cookie', visitor.cookie);
        }
        stagedUploads.set(id, {
          owner: uploadOwner(),
          name,
          size,
          type: String(req.headers['x-ms-file-type'] ?? req.headers['content-type'] ?? 'application/octet-stream'),
          token,
          blocks: [],
          writing: Promise.resolve(),
          received: 0,
          created: now,
        });
        return answer(200, { AnnotationId: id, FileContinuationToken: token });
      }
      if (req.method !== 'PUT') throw error('File block upload requires PUT.', 405);
      const entry = stagedUploads.get(String(url.searchParams.get('noteId') ?? '').toLowerCase());
      if (!entry || entry.owner !== uploadOwner() || req.headers['x-ms-file-continuation-token'] !== entry.token)
        throw error('Unknown file upload.', 404);
      if (Number(url.searchParams.get('offset')) !== entry.received)
        throw error('The file block offset does not continue the upload.', 400);
      const block = await rawBody(req);
      // Reading a slow body yields to other chunks and form postbacks. Recheck
      // ownership and offset before committing, so duplicate chunks cannot append.
      if (stagedUploads.get(String(url.searchParams.get('noteId') ?? '').toLowerCase()) !== entry)
        throw error('Unknown file upload.', 404);
      const noteId = String(url.searchParams.get('noteId') ?? '').toLowerCase();
      if (Date.now() - entry.created > 3600000) {
        dropStaged(noteId);
        throw error('Unknown file upload.', 404);
      }
      if (Number(url.searchParams.get('offset')) !== entry.received)
        throw error('The file block offset does not continue the upload.', 400);
      if (entry.received + block.length > entry.size)
        throw error('The file block exceeds the declared file size.', 400);
      // The offset advances before the provider write, so a duplicate chunk cannot pass the check meanwhile; writes are chained
      // in block order and the last block commits them. A failed write ends the upload.
      const blockId = String(entry.blocks.length).padStart(6, '0');
      entry.blocks.push(blockId);
      entry.received += block.length;
      const last = entry.received === entry.size;
      entry.writing = entry.writing.then(async () => {
        const storage = stagedStorage();
        await storage.put(stagedKey(noteId), block, { blockId });
        if (last) await storage.commit(stagedKey(noteId), entry.blocks, { contentType: entry.type });
      });
      try {
        await entry.writing;
      } catch (cause) {
        if (stagedUploads.get(noteId) === entry) stagedUploads.delete(noteId);
        throw cause;
      }
      return answer(204);
    }
    if (url.pathname.startsWith('/_api/')) return api(req, res, url);
    if (config().pageMode === 'live') return forward(req, res, url);
    // Routing and sign-in : repeated slashes collapse before resolution (portal
    // navigation builds "../" + "/page" links and Power Pages resolves them); a website language code
    // prefix is removed with a 302; the local sign-in and sign-out routes answer here.
    if (url.pathname.includes('//')) url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    const language = languageRoute(portal, url, req.method);
    if (language?.kind === 'redirect') {
      // The platform's language redirect carries its page caching headers (live 302 to /SignIn).
      const { vary: _languageVary, ...languageHeaders } = PAGE_HEADERS;
      res.writeHead(language.status, {
        location: language.location,
        'content-type': 'text/html; charset=utf-8',
        ...languageHeaders,
        'x-frame-options': siteHeaders(portal)['x-frame-options'],
        'x-sim-route': 'language',
      });
      return res.end();
    }
    if (language?.kind === 'rewrite') url.pathname = language.pathname;
    // /Register is the platform's invitation redemption page (the sign-in page's "Redeem
    // invitation" tab); locally it is the RedeemInvitation route.
    if (/^\/register\/?$/i.test(url.pathname) && !exportedPageFor(portal, url.pathname)) {
      const back = returnUrlParameter(url.searchParams);
      url.pathname = '/Account/Login/RedeemInvitation';
      url.search = back ? `?ReturnUrl=${encodeURIComponent(back)}` : '';
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
      req.method === 'POST' &&
      portal.pages.find((page) => normalizePortalPath(page.url) === normalizePortalPath(url.pathname));
    const postedTemplate =
      postedPage && portal.pageTemplates.find((template) => template.id === postedPage.pageTemplateId);
    // Exported Liquid AJAX pages often use POST for DataTables filters. Rendering
    // those pages is a read operation; record mutations remain on the Web API.
    if (postedPage && (postedTemplate?.useHeaderFooter === false || nativePostbackEnabled)) {
      const bytes = await rawBody(req);
      const contentType = (req.headers['content-type'] ?? 'application/x-www-form-urlencoded')
        .split(';')[0]
        .trim()
        .toLowerCase();
      // A WebForms page whose form carries a file input posts multipart/form-data (live
      // item-edit captures); its text controls decode like the URL-encoded postback.
      const multipart =
        nativePostbackEnabled && contentType === 'multipart/form-data'
          ? await multipartControls(bytes, req.headers['content-type'])
          : null;
      if (contentType === 'application/x-www-form-urlencoded' || multipart) {
        const controls = multipart ?? new URLSearchParams(bytes.toString('utf8'));
        if (nativePostbackEnabled && controls.has('__EVENTTARGET')) {
          // The page's own __VIEWSTATE carries the anti-forgery key (lib/platform.mjs viewStateWithKey);
          // a body token, when sent, must match too.
          const tokens = controls.getAll('__RequestVerificationToken');
          const verified = tokens.length
            ? tokens.length === 1 && tokens[0] === csrf
            : nativeViewStateKey(controls.get('__VIEWSTATE')) === csrf;
          if (!verified) throw error('Missing portal verification token.', 403);
          // The captcha refresh is an ASP.NET AJAX partial postback answered with the update panel delta.
          const captchaTarget = /^(.+\$captcha)\$CaptchaLinkButton$/.exec(controls.get('__EVENTTARGET') ?? '');
          if (captchaTarget && /^delta=true$/i.test(String(req.headers['x-microsoftajax'] ?? ''))) {
            const delta = captchaRefreshDelta(captchaTarget[1], url.pathname, controls);
            res.writeHead(200, {
              'cache-control': 'private',
              'content-type': 'text/plain; charset=utf-8',
              vary: 'Accept-Encoding',
              'x-frame-options': siteHeaders(portal)['x-frame-options'],
              'content-length': Buffer.byteLength(delta),
            });
            return res.end(delta);
          }
          nativeEntries = [...controls];
          nativeFiles = controls.files ?? [];
          const context = trace.getStore();
          // An auto-generated step form's posted __VIEWSTATE names the tab the page showed and the
          // earlier tabs' values: the page renders that tab first so the postback decodes against it.
          const carried = decodeNativeViewState(controls.get('__VIEWSTATE'));
          if (context && carried)
            context.nativePostbackState = {
              kind: 'entityform',
              formId: carried.form,
              autoStep: carried.autoStep,
              values: carried.values,
              outcome: { type: 'none' },
            };
          if (context && !context.visitor && !webFormSessionOwner(currentIdentity())) {
            const started = newVisitor(visitorName());
            context.visitor = started.id;
            res.setHeader('set-cookie', started.cookie);
          }
        } else formParams = Object.fromEntries(controls);
      } else if (contentType === 'application/json') {
        try {
          formParams = bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
        } catch {
          throw error('Request body must be valid JSON.');
        }
        if (
          !formParams ||
          Array.isArray(formParams) ||
          typeof formParams !== 'object' ||
          Object.values(formParams).some((value) => value !== null && typeof value === 'object')
        )
          throw error('Liquid request parameters must be scalar values.');
      } else throw error('Liquid page POST requires URL-encoded or JSON parameters.', 415);
      if (nativePostbackEnabled && postedTemplate?.useHeaderFooter !== false && !nativeEntries)
        throw error('Native form postback target required.', 400, 'InvalidNativePostback');
    } else if (
      nativePostbackEnabled &&
      req.method === 'POST' &&
      /^\/_portal\/modal-form-template-path(?:\/[^/]+)?\/?$/i.test(url.pathname)
    ) {
      if (!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))
        throw error('Native form postback requires URLencoded controls.', 415);
      const controls = new URLSearchParams((await rawBody(req)).toString('utf8'));
      // The same rule as a page postback: a body token, or the document's own __VIEWSTATE key.
      const tokens = controls.getAll('__RequestVerificationToken');
      const verified = tokens.length
        ? tokens.length === 1 && tokens[0] === csrf
        : nativeViewStateKey(controls.get('__VIEWSTATE')) === csrf;
      if (!verified) throw error('Missing portal verification token.', 403);
      nativeEntries = [...controls];
    } else if (!['GET', 'HEAD'].includes(req.method)) throw error('Use the local Web API for writes.', 405);
    if (/^\/_portal\/modal-form-template-path(?:\/[^/]+)?\/?$/i.test(url.pathname)) {
      const normalizeId = (value) =>
        String(value ?? '')
          .replace(/[{}]/g, '')
          .toLowerCase();
      let websiteSegment;
      try {
        websiteSegment = decodeURIComponent(url.pathname.split('/')[3] ?? '');
      } catch {
        throw error('Malformed modal website identifier.');
      }
      const websiteId = normalizeId(websiteSegment);
      if (
        websiteId &&
        websiteId !== '00000000-0000-0000-0000-000000000000' &&
        websiteId !== normalizeId(portal.website.id ?? portal.website.adx_websiteid ?? portal.website.mspp_websiteid)
      )
        throw error('The modal website is not exported by this portal.', 404);
      const requestedForm = url.searchParams.get('entityformid') ?? url.searchParams.get('entityform');
      const definition = portal.forms.find((form) => normalizeId(form.id) === normalizeId(requestedForm));
      if (!requestedForm || !definition) throw error('An exported entityformid is required.', 404);
      const requestedPage = url.searchParams.get('pageid');
      const explicitPage = requestedPage
        ? portal.pages.find((page) => normalizeId(page.id) === normalizeId(requestedPage))
        : null;
      if (requestedPage && !explicitPage) throw error('The modal parent page is not exported.', 404);
      const formIdentity = currentIdentity();
      if (explicitPage) {
        const access = pageAccess(portal, explicitPage, formIdentity);
        if (!access.allowed)
          throw error(access.diagnostics?.[0]?.message || 'Page access denied.', access.status ?? 403, access.code);
      }
      const page = explicitPage ?? {
        id: null,
        parentId: null,
        url: url.pathname,
        name: 'Portal form',
        title: 'Portal form',
        metadata: {},
      };
      // A form body and its nested Liquid/styles/layout belong to the source
      // selected before its first asynchronous read, including a postback's
      // existing second render. A concurrent reload must not relabel it.
      const modalRenderer = renderer,
        renderedRevision = revision;
      const context = modalRenderer.contextForPage(page, url.pathname + url.search, {
        user: formIdentity,
        languageCode: language?.code ?? null,
      });
      if (!explicitPage) {
        context.page = null;
        context.sitemap.current = null;
      }
      const collected = [];
      const renderModalForm = () =>
        renderComponent('entityform', definition.id, context, {
          portal,
          store,
          readProvider,
          args: { id: definition.id },
          metadata: solutionMetadata,
          config: config(),
          modal: true,
          observed: config().observed ?? portal.observed,
          onNativePostbackDescriptor: nativePostbackEnabled ? (item) => collected.push(item) : null,
          nativePostbackState: trace.getStore()?.nativePostbackState,
          codeComponent: (spec) =>
            renderCodeComponent({
              ...spec,
              portal,
              catalog: codeComponents,
              metadata: solutionMetadata,
              language: context?.__language ?? portal.language,
              identity: formIdentity,
              mappings: store.snapshot({ sections: ['mappings'] }).mappings,
              diagnostic: (entry) => recordDiagnostic({ ...entry, path: url.pathname }),
            }),
          diagnostic: (entry) => recordDiagnostic({ ...entry, path: url.pathname }),
          sourceDependencies,
          richTextCompatibility: richTextCompatibility(),
          managedControls: config().managedControls ?? config().shellProfile?.managedControls,
          schemas: {
            ...solutionMetadata.componentSchemas,
            ...config().componentSchemas,
          },
          renderLiquid: (source, ctx) => modalRenderer.renderString(source, ctx),
        });
      let html = await renderModalForm();
      if (nativeEntries) {
        const submission = resolveNativeFormSubmission(nativeEntries, collected, url.href);
        let response;
        try {
          const { result, context } = await submitStagedNativePostback(
            nativeEntries,
            collected,
            formSubmissionOptions(formIdentity, trace.getStore()?.visitor, url),
            nativeFiles,
          );
          response = nativePostbackResponse({ result, context, values: submission.body.values });
        } catch (cause) {
          response = nativePostbackResponse({
            error: cause,
            context: submission.context,
            values: submission.body.values,
            observed: config().observed ?? portal.observed,
          });
          trace.getStore().error = cause;
          recordDiagnostic({
            ...(cause.details?.permissionDiagnostic ?? {
              code: cause.code ?? 'FORM_SAVE_FAILED',
              message: cause.message,
            }),
            path: url.pathname,
          });
        }
        if (response.location) return postbackRedirect(res, response, portal);
        retainStagedAttachments(response.state, nativeEntries, collected);
        trace.getStore().nativePostbackState = response.state;
        html = await renderModalForm();
        // Form.aspx registers a startup script after ItemSaved: the grid that opened the dialog
        // closes it on "Success"; a lookup's create dialog (?lookup=) receives the saved record.
        if (response.state?.outcome && response.state.outcome.type !== 'error' && !response.state.validationErrors) {
          const message = url.searchParams.get('lookup')
            ? JSON.stringify({
                type: 'Success',
                name: response.state.savedName ?? '',
                id: response.state.savedId ?? null,
              })
            : 'Success';
          html += `<script type="text/javascript">window.parent.postMessage(${JSON.stringify(message)}, "*");</script>`;
        }
      }
      const resource = (entry, type) => renderShellResource(entry, type, { localOnly: true });
      // Native modal document: the platform bundles in the layout's order with
      // the WebForms resources inside content_form (lib/platform-manifest.mjs). Without a
      // capture the Bootstrap slot is the site's bootstrap.min.css web file, else the
      // platform's /css/bootstrap.min.css.
      const bootstrapFile = portal.webFiles.find((f) => /\/bootstrap\.min\.css$/i.test(f.url));
      const sourceStyles = await modalRenderer.contentStylesheets(
        explicitPage ?? servicePages(portal).home ?? page,
        context,
      );
      const modalPlatform = platformShell({
        variant: bootstrapVariant(portal.settings),
        profile: config().shellProfile ?? null,
        websiteId: portal.website.id ?? portal.website.adx_websiteid ?? portal.website.mspp_websiteid,
        languageCode: context.website?.selected_language?.code ?? 'en-US',
        bootstrap: sourceStyles.bootstrap || resource(bootstrapFile?.url ?? '/css/bootstrap.min.css', 'css'),
        renderStyles: (paths) => paths.map((p) => resource(p, 'css')).join(''),
      });
      const remaining = modalPlatform.remaining;
      const styles =
        remaining.stylesheets.map((p) => resource(p, 'css')).join('') +
        formContentStyles(sourceStyles.content, config().shellProfile);
      const configuredHeadScripts = [...remaining.headScripts, ...remaining.beforeContentScripts];
      const headScripts = configuredHeadScripts.map((p) => resource(p, 'js')).join('');
      const aspNetScripts = remaining.bodyScripts
        .filter(isAspNetScript)
        .map((p) => resource(p, 'js'))
        .join('');
      const bodyScripts = [...remaining.bodyScripts.filter((p) => !isAspNetScript(p)), ...remaining.afterFooterScripts]
        .map((p) => resource(p, 'js'))
        .join('');
      // The platform's page caching headers (live modal document response).
      const headers = {
        'content-type': 'text/html; charset=utf-8',
        ...PAGE_HEADERS,
      };
      Object.assign(headers, siteHeaders(portal, { confinement: confinementPolicy(), kind: 'page' }));
      res.writeHead(200, headers);
      // Native modal form page (Form.aspx): content_form wraps the static
      // EntityFormControl; its empty anti-forgery holder uses the portal-scoped URL.
      // The platform serves it through the layout master (live evidence): the layout frame of a
      // document outside the site map (lib/liquid.mjs serviceLayout) and the platform chrome.
      const scopedSite = normalizeId(
        portal.website.id ?? portal.website.adx_websiteid ?? portal.website.mspp_websiteid,
      );
      const layout = await modalRenderer.serviceLayout(url.pathname + url.search, {
        user: formIdentity,
        languageCode: language?.code ?? null,
      });
      const document = injectRuntimeCompatibility(
        `<!doctype html>${layout.html}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>${layout.title}</title>${modalPlatform.headStart}${styles}${headScripts}${layout.head}${modalPlatform.headEnd}</head>${layout.body}${modalPlatform.bodyOpen}${layout.chrome}${antiForgeryHolder(`/_portal/${scopedSite}/Layout/GetAntiForgeryToken`)}${modalPlatform.bodyStart}<div id="content-container" class="container wrapper-body" role="main"><div id="content"><div id="mainContent">${webFormsForm({ id: 'content_form', action: url.pathname + url.search, content: html, aspNetScripts })}</div></div></div>${modalPlatform.afterContent}${bodyScripts}${modalPlatform.afterFooter}</body></html>`,
        sourceDependencies,
        configuredHeadScripts,
      );
      for (const item of formStyleDiagnostics(document, config().shellProfile))
        recordDiagnostic({ ...item, path: url.pathname });
      return res.end(
        injectRuntime(
          frameReadiness.decorate(injectLocalHead(document, localOverrides), {
            path: url.pathname,
            observed: config().observed ?? portal.observed,
          }),
          csrf,
          renderedRevision,
          formIdentity,
          trace.getStore()?.spanId,
          siteLanguageCodes(),
        ),
      );
    }
    const localHeadAsset = localOverrides.assets.find((asset) => asset.url === url.pathname);
    if (localHeadAsset && ['GET', 'HEAD'].includes(req.method)) {
      const body = await readLocalFile(localHeadAsset.file, { root: localHeadAsset.root, maxBytes: 8 * 1024 * 1024 });
      res.writeHead(200, {
        'content-type':
          localHeadAsset.kind === 'scripts' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
        'cache-control': 'no-store',
        'x-sim-local-only': 'head',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const localRuntimeAssets = new Map([
      ['/__sim-static/vendor/jquery.min.js', createRequire(import.meta.url).resolve('jquery/dist/jquery.min.js')],
      ['/__sim-static/vendor/moment.min.js', createRequire(import.meta.url).resolve('moment/min/moment.min.js')],
      ['/__sim-static/vendor/datetimepicker-compat.js', new URL('./lib/datetimepicker-compat.js', import.meta.url)],
      [
        '/__sim-static/vendor/bootstrap-plugins-compat.js',
        new URL('./lib/bootstrap-plugins-compat.js', import.meta.url),
      ],
      ['/__sim-static/vendor/jqueryui-dialog-compat.js', new URL('./lib/jqueryui-dialog-compat.js', import.meta.url)],
      ['/__sim-static/vendor/date-format-compat.js', new URL('./lib/date-format-compat.js', import.meta.url)],
      ['/__sim-static/vendor/footer-spacing-compat.js', new URL('./lib/footer-spacing-compat.js', import.meta.url)],
      [PAGES_CLIENT_API_SCRIPT, PAGES_CLIENT_API_FILE],
    ]);
    const fontName = /^\/fonts\/(glyphicons-halflings-regular\.(?:eot|svg|ttf|woff2?))$/i.exec(url.pathname)?.[1];
    const fontRuntimeAsset = fontName ? new URL(`./lib/bootstrap-fonts/${fontName}`, import.meta.url) : null;
    const runtimeAsset =
      localRuntimeAssets.get(url.pathname) ??
      (sourceDependencies.jqueryUiDialog && /^\/xrm-adx\/js\/jquery-ui(?:-[\d.]+)?(?:\.min)?\.js$/i.test(url.pathname)
        ? new URL('./lib/jqueryui-dialog-compat.js', import.meta.url)
        : fontRuntimeAsset);
    if (runtimeAsset) {
      if (!['GET', 'HEAD'].includes(req.method)) throw error('Local compatibility assets require GET or HEAD.', 405);
      const body = await fs.readFile(runtimeAsset);
      const fontMime = fontName?.endsWith('.woff2')
        ? 'font/woff2'
        : fontName?.endsWith('.woff')
          ? 'font/woff'
          : fontName?.endsWith('.ttf')
            ? 'font/ttf'
            : fontName?.endsWith('.eot')
              ? 'application/vnd.ms-fontobject'
              : 'image/svg+xml';
      res.writeHead(200, {
        'content-type': fontRuntimeAsset ? fontMime : 'application/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'x-sim-resource-provider': 'local-compatibility',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    // Absolute sign-in redirects use the local origin (handle() admits only its Host).
    const routeOptions = { origin: localOrigin };
    const key = normalizePortalPath(url.pathname);
    // A path ending with "/" is looked up as a page first (legacy slash rule); a web file
    // answers only when no page has that URL.
    const pageFirst = url.pathname.endsWith('/') && portal.pages.some((p) => normalizePortalPath(p.url) === key);
    const asset = pageFirst ? null : portal.webFiles.find((f) => normalizePortalPath(f.url) === key);
    // Routing : a denied web file follows the denied-page outcome below.
    const assetAccess = asset ? pageAccess(portal, asset, currentIdentity()) : null;
    const deniedRoute =
      assetAccess && !assetAccess.allowed
        ? deniedPageRoute(portal, url, currentIdentity(), assetAccess, routeOptions)
        : null;
    if (asset && !deniedRoute) {
      const root = await fs.realpath(portal.sourceDir),
        file = await fs.realpath(asset.file);
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw error('Asset escaped the export directory.', 403);
      // Web file headers as online (lib/response-headers.mjs): charset on every type, the
      // record's disposition, platform caching, ETag with 304, HTTP/* settings.
      const sendFile = (body, contentType, extra = {}) => {
        const headers = {
          ...siteHeaders(portal, { confinement: confinementPolicy(), kind: 'webFile' }),
          ...webFileHeaders({
            body,
            contentType,
            fileName: asset.metadata?.filename ?? asset.metadata?._attachment?.name ?? path.basename(file),
            caching: store.state.settings?.webFileCaching === 'revalidate' ? 'revalidate' : 'platform',
            disposition: webFileDisposition(asset.metadata),
            mimeCharset: portal.observed?.webFileMimeCharset,
          }),
          ...extra,
          'content-length': Buffer.byteLength(body),
        };
        res.writeHead(notModified(req.headers, headers) ? 304 : 200, headers);
        return res.end(notModified(req.headers, headers) ? undefined : body);
      };
      // WebFiles/StorageLocation AzureBlobStorage: the bytes are the object webfiles/<webfileid>/<filename> of storage route
      // portalWebFiles. An unset or export route, a missing provider or object answers WEBFILE_CLOUD_STORAGE_UNAVAILABLE (503);
      // the export file is never served in its place. The object naming of native Azure web file storage is a guess.
      if (
        String(siteSetting(portal, 'WebFiles/StorageLocation') ?? '')
          .trim()
          .toLowerCase() === 'azureblobstorage'
      ) {
        const name = String(asset.metadata?.filename ?? asset.metadata?._attachment?.name ?? path.basename(file));
        return sendFile(await cloudWebFile(asset.id, name, url.pathname), asset.mimeType || mime(name));
      }
      const stylesheet = await resolveObservedStylesheet(portal, asset, config().shellProfile?.observedStylesheets, {
        cache,
        origin: live.origin,
      });
      if (stylesheet.diagnostic) recordDiagnostic(stylesheet.diagnostic);
      if (stylesheet.body)
        return sendFile(stylesheet.body, stylesheet.contentType, {
          'x-sim-resource-provider': 'observed-stylesheet',
          'x-sim-source-sha256': stylesheet.baseline.sourceSha256,
          'x-sim-observed-sha256': stylesheet.baseline.sha256,
        });
      const observed = await resolveRichTextConfiguration(
        portal,
        asset,
        config().shellProfile?.richTextConfigurations,
        { cache, origin: live.origin },
      );
      if (observed.diagnostic) recordDiagnostic({ ...observed.diagnostic, path: asset.url });
      if (observed.body)
        return sendFile(observed.body, 'application/json', {
          'content-type': 'application/json',
          'x-sim-resource-provider': 'observed-richtext-json',
          'x-sim-source-sha256': observed.baseline.sourceSha256,
          'x-sim-observed-sha256': observed.baseline.sha256,
        });
      let body = await readLocalFile(file, { root, maxBytes: Number.MAX_SAFE_INTEGER });
      const originalBody = body;
      let generatedDebugUrl = null;
      const contentType = asset.mimeType || mime(file),
        kind = assetKind(contentType, file);
      let jsonPayload = false;
      if (kind === 'script') {
        try {
          JSON.parse(body.toString('utf8'));
          jsonPayload = true;
        } catch {
          /* Non-JSON content follows the ordinary response or script path below. */
        }
      }
      if (sourceMaps && kind === 'script' && !jsonPayload) {
        body = withFileSourceMap(body, file);
        if (!body.toString('utf8').includes('sourceURL=')) {
          generatedDebugUrl = pathToFileURL(file).href;
          body = Buffer.concat([body, Buffer.from('\n//# sourceURL=' + pathToFileURL(file).href + '\n')]);
        }
      } else if (sourceMaps && kind === 'stylesheet' && !body.toString('utf8').includes('sourceMappingURL=')) {
        const text = body.toString('utf8');
        body = Buffer.concat([
          body,
          Buffer.from(`\n/*# sourceMappingURL=${identityMapUrl(file, text.split(/\r\n?|\n/).length, text)} */\n`),
        ]);
      }
      const proofHeaders = {};
      if (req.method === 'GET' && kind === 'script' && !jsonPayload) {
        const index = renderer.sourceIndex();
        const source = [...index.sources.values()].find(
          (source) => source.rawBytes && source.recordId === String(asset.id).replace(/[{}]/g, '').toLowerCase(),
        );
        if (source && source.contentRevision === createHash('sha256').update(originalBody).digest('hex')) {
          const proofId = randomUUID();
          const { text: _text, file: _file, sourceDir: _root, ...sourceRef } = source;
          const wireText = body.toString('utf8'),
            bom = wireText.startsWith('\uFEFF') ? 1 : 0,
            generated = wireText.slice(bom);
          const script = {
            id: proofId + ':script:0',
            generatedHash: createHash('sha256').update(generated, 'utf8').digest('hex'),
            responseHash: createHash('sha256').update(body).digest('hex'),
            hashAlgorithm: 'sha256-utf8',
            ...scriptLineStarts(generated),
            url: url.pathname,
            mappings: [
              {
                generatedStart: 0,
                generatedEnd: source.text.length - bom,
                sourceRefId: source.id,
                sourceStart: bom,
                sourceEnd: source.text.length,
              },
            ],
            ...(generatedDebugUrl
              ? {
                  debugUrl: generatedDebugUrl,
                  debugUrlKey: createHash('sha256').update(generatedDebugUrl).digest('hex'),
                }
              : {}),
          };
          const access = randomBytes(32).toString('hex');
          scriptProofs.set(proofId, {
            access,
            proof: {
              version: 1,
              channel: 'mirage-resource',
              proofId,
              sourceRevision: index.sourceRevision,
              sourceRefs: [sourceRef],
              scriptProofs: [script],
              bindings: [],
              complete: true,
            },
          });
          while (scriptProofs.size > 128) scriptProofs.delete(scriptProofs.keys().next().value);
          proofHeaders['x-paqvilo-script-proof'] = proofId;
          proofHeaders['x-paqvilo-provenance-access'] = access;
        }
      }
      return sendFile(body, contentType, proofHeaders);
    }
    // The captcha challenge resources answer locally (the asset cache admits no Telerik resource URL).
    if (
      ['GET', 'HEAD'].includes(req.method) &&
      url.pathname.toLowerCase() === '/telerik.web.ui.webresource.axd' &&
      captchaResource(req, res, url, portal)
    )
      return;
    if (cache && !deniedRoute) {
      const cached = await cache.get(url.pathname + url.search, {
        origin: live.origin,
      });
      if (cached) {
        res.writeHead(cached.status, {
          'cache-control': 'no-cache',
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
    // An application-relative path a script wrote unresolved (".../~/xrm-adx/...") redirects to the
    // application root, as ASP.NET does (live map list loader image).
    const appRelative = /\/~(\/.*)$/.exec(url.pathname);
    if (['GET', 'HEAD'].includes(req.method) && appRelative)
      return postbackRedirect(res, { status: 302, location: appRelative[1] }, portal);
    // A missing file under the platform's static areas (calendar loading image, live) is a plain
    // 404 without Vary, not the portal's Page Not Found page.
    if (['GET', 'HEAD'].includes(req.method) && /^\/areas\/.+\.[a-z0-9]+$/i.test(url.pathname)) {
      const { vary: _vary, ...page } = PAGE_HEADERS;
      res.writeHead(404, { ...page, 'content-type': 'text/html; charset=utf-8', 'content-length': 0 });
      return res.end();
    }
    const pageIdentity = currentIdentity();
    const exportedPage = deniedRoute
      ? null
      : portal.pages.find((p) => normalizePortalPath(p.url) === key && (url.pathname.endsWith('/') || key === '/'));
    const markerRoute = exportedPage || deniedRoute ? null : siteMarkerRoute(portal, url);
    const routedPage = exportedPage ?? markerRoute?.page ?? null;
    const access = routedPage ? pageAccess(portal, routedPage, pageIdentity) : null;
    // The Profile site-marker page requires a signed-in user (platform profile page).
    const profile = servicePages(portal).profile;
    const signInRequired = Boolean(
      routedPage && access?.allowed && profile && routedPage.id === profile.id && !pageIdentity?.contactId,
    );
    const route =
      deniedRoute ??
      (!routedPage
        ? resolveUnmatchedRoute(portal, url, {
            readable: (page) => pageAccess(portal, page, pageIdentity).allowed,
            urlHistory: store.state.settings?.urlHistoryRedirects === true,
          })
        : !access.allowed
          ? deniedPageRoute(portal, url, pageIdentity, access, routeOptions)
          : signInRequired
            ? deniedPageRoute(portal, url, pageIdentity, { code: 'PROFILE_SIGN_IN_REQUIRED' }, routeOptions)
            : null);
    if (route?.kind === 'redirect' && !route.page) {
      res.writeHead(route.status, {
        location: route.location,
        'cache-control': 'no-store',
        'x-sim-route': route.source ?? 'redirect',
      });
      return res.end();
    }
    if (route?.kind === 'error') throw error(route.message, route.status, route.code);
    if (route)
      recordDiagnostic({
        code: route.code ?? 'PAGE_NOT_FOUND',
        path: url.pathname,
        message: `${route.message ? route.message + ' ' : ''}Rendered the ${route.page.name} page with HTTP ${route.status}.`,
      });
    // Native evidence covers GET page-query validation. Other request methods
    // retain their existing handlers until their validation order is observed.
    const queryValidation =
      req.method === 'GET' ? observedPageQueryValidation(url, config().observed ?? portal.observed) : null;
    if (queryValidation) throw error(queryValidation.message, queryValidation.status, queryValidation.code);
    const nativeContext = trace.getStore();
    if (nativeEntries && (route || !routedPage || !access?.allowed))
      throw error('Native form page is not accessible.', 403);
    let renderedSource;
    const renderCurrentPage = () => {
      if (nativeContext) nativeContext.nativePostbacks = [];
      renderedSource = { renderer, revision };
      return renderedSource.renderer.renderPage(
        (route ? route.page.url : markerRoute ? markerRoute.page.url : url.pathname) + url.search,
        {
          user: pageIdentity,
          // The website language whose code the language route removed from the path .
          languageCode: language?.code ?? null,
          request: {
            url: url.href,
            path: url.pathname,
            params: { ...formParams, ...Object.fromEntries(url.searchParams) },
            method: req.method,
          },
        },
      );
    };
    let rendered = await renderCurrentPage();
    if (nativeEntries) {
      const collected = nativeContext?.nativePostbacks ?? [];
      const submission = resolveNativeFormSubmission(nativeEntries, collected, url.href);
      let response;
      try {
        const { result, context } = await submitStagedNativePostback(
          nativeEntries,
          collected,
          formSubmissionOptions(pageIdentity, nativeContext?.visitor, url),
          nativeFiles,
        );
        response = nativePostbackResponse({ result, context, values: submission.body.values });
      } catch (cause) {
        response = nativePostbackResponse({
          error: cause,
          context: submission.context,
          values: submission.body.values,
          observed: config().observed ?? portal.observed,
        });
        nativeContext.error = cause;
        recordDiagnostic({
          ...(cause.details?.permissionDiagnostic ?? {
            code: cause.code ?? 'FORM_SAVE_FAILED',
            message: cause.message,
          }),
          path: url.pathname,
        });
      }
      if (response.location) return postbackRedirect(res, response, portal);
      retainStagedAttachments(response.state, nativeEntries, collected);
      nativeContext.nativePostbackState = response.state;
      rendered = await renderCurrentPage();
    }
    let html = typeof rendered === 'string' ? rendered : rendered.html;
    for (const diagnostic of rendered.diagnostics ?? []) recordDiagnostic({ ...diagnostic, path: url.pathname });
    // A component that sends the visitor elsewhere (an advanced form that requires
    // authentication sends an anonymous visitor to sign in) answers for the whole page.
    const componentRedirect = (rendered.diagnostics ?? []).find(
      (entry) => typeof entry.redirect === 'string',
    )?.redirect;
    if (componentRedirect) {
      res.writeHead(302, { location: componentRedirect, 'cache-control': 'no-store', 'x-sim-route': 'sign-in' });
      return res.end();
    }
    if (typeof html !== 'string') throw error('Renderer produced no response.', 500);
    const contentType = rendered.contentType ?? 'text/html; charset=utf-8';
    // Only HTML documents receive local runtime dependencies. Pages without the website
    // header/footer often return JSON or HTML fragments for the portal's own scripts;
    // the live portal serves their template output verbatim, so prepending scripts
    // would corrupt JSON.parse() and jQuery .load() consumers.
    const isDocument = contentType.includes('text/html') && (rendered.isDocument ?? isHtmlDocument(html));
    // A bare HTML template may be a native browser navigation or an XHR fragment. Only
    // the document destination establishes parser-node proof; data callers keep original bytes.
    if (contentType.includes('text/html') && req.headers['sec-fetch-dest'] === 'document' && !rendered.provenance) {
      const traced = renderedSource.renderer.provenanceFor(rendered);
      if (traced) {
        html = traced.html;
        rendered.provenance = traced.provenance;
      }
    }
    if (isDocument) {
      html = injectRuntimeDependencies(html, sourceDependencies);
      html = injectLocalHead(injectRuntimeCompatibility(html, sourceDependencies), localOverrides);
      for (const item of formStyleDiagnostics(html, config().shellProfile))
        recordDiagnostic({ ...item, path: url.pathname });
      if (localOverrides.assets.length || Object.keys(localOverrides.compat).length)
        recordDiagnostic({
          code: 'LOCAL_ONLY_OVERRIDES',
          severity: 'info',
          path: url.pathname,
          message: 'Project compat switches and local head additions are active.',
          localOverrides,
        });
    }
    // Page headers: no-cache, no-store, must-revalidate and only the HTTP/* site-setting
    // headers; the loopback policy only with config.confinePortalPages (lib/response-headers.mjs).
    const headers = {
      'content-type': contentType,
      ...PAGE_HEADERS,
      ...siteHeaders(portal, { confinement: confinementPolicy(), kind: 'page' }),
    };
    // A redirecting page answer has no Vary header (live sign-in redirect).
    if (route?.kind === 'redirect') {
      delete headers.vary;
      Object.assign(headers, { location: route.location, 'x-sim-route': route.source ?? 'redirect' });
    }
    // Local compatibility adapters in the document are reported here, not as page attributes;
    // their runtime modes are in window.__portalSimulation.compatibility.
    if (isDocument || rendered.provenance) {
      if (rendered.provenance) {
        const proof = rendered.provenance;
        const access = randomBytes(32).toString('hex');
        renderProofs.set(proof.proofId, { proof, access });
        headers['x-paqvilo-provenance-access'] = access;
        while (renderProofs.size > 64) renderProofs.delete(renderProofs.keys().next().value);
      }
      const adapters = [
        ...new Set(
          [...html.matchAll(/\/__sim-static\/([\w/.-]+)/g)]
            .map((match) => match[1].slice(match[1].lastIndexOf('/') + 1))
            .filter((name) => name.endsWith('-compat.js'))
            .map((name) => name.slice(0, -10)),
        ),
      ];
      if (adapters.length) headers['x-sim-compatibility'] = adapters.join(', ');
      if (rendered.provenance) headers['x-paqvilo-provenance'] = rendered.provenance.proofId;
    }
    const responseBody = isDocument
      ? injectRuntime(html, csrf, renderedSource.revision, pageIdentity, trace.getStore()?.spanId, siteLanguageCodes())
      : html;
    if (rendered.provenance) {
      const entry = renderProofs.get(rendered.provenance.proofId);
      if (entry) entry.proof = refreshScriptProofLocations(responseBody, rendered.provenance);
    }
    res.writeHead(route?.status ?? rendered.status ?? 200, headers);
    res.end(responseBody);
  }
  const server = http.createServer((req, res) => {
    if (closing)
      return json(
        res,
        503,
        { error: { code: 'SIMULATOR_CLOSING', message: 'The local runtime is shutting down.' } },
        { connection: 'close' },
      );
    if (/^\/_setup(?:\/|$)/.test(req.url?.split('?')[0] ?? '')) {
      setupHandler(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { error: { code: 'SETUP_FAILED', message: 'Setup request failed.' } });
      });
      return;
    }
    const started = Date.now();
    let url;
    try {
      url = requestTargetUrl(req.url, 'http://local.invalid');
    } catch {
      return json(res, 400, {
        error: { code: 'INVALID_REQUEST', message: 'Malformed request URL.' },
      });
    }
    // /_sim is the same administration surface as /__sim: never audit it as a portal page.
    if (/^\/_sim(?:\/|$)/.test(url.pathname)) url.pathname = url.pathname.replace(/^\/_sim/, '/__sim');
    // Browser sign-in session of this request (lib/auth-session.mjs).
    const auth = requestAuth(req, url);
    // Only synchronous audit classification reads this private configuration.
    // The handler snapshots its own response before any asynchronous writes.
    const cfg = config(store.state.simulator);
    const endpoint = (cfg.endpoints ?? []).find((item) => item.enabled !== false && item.path === url.pathname);
    const kind = url.pathname.startsWith('/__sim/forms/')
      ? 'form'
      : url.pathname.startsWith('/_api/') || url.pathname.startsWith('/__sim/artifacts/') || endpoint
        ? 'api'
        : 'page';
    const tracked = !url.pathname.startsWith('/__sim/') || kind === 'form' || kind === 'api';
    const staticPath =
      /\.(?:js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|pdf|json)$/i.test(url.pathname) ||
      /^\/(?:resource|_pcfwebresource|webresources|_webresource)\//.test(url.pathname);
    const parentHeader = req.headers['x-sim-parent-trace'];
    const parent =
      typeof parentHeader === 'string' && /^[\da-f-]{36}$/i.test(parentHeader)
        ? audit.entries.find((item) => item.id === parentHeader)
        : null;
    const span =
      tracked && (!staticPath || kind !== 'page')
        ? audit.begin({
            kind,
            method: req.method,
            path: url.pathname,
            query: url.searchParams,
            provider: endpoint?.mode ?? (kind === 'page' ? cfg.pageMode : cfg.mode),
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
    if (span) res.setHeader('X-Sim-Trace-Id', span.id);
    res.on('close', () => {
      if (!res.writableFinished)
        span?.finish({
          status: 499,
          error: {
            code: 'REQUEST_ABORTED',
            message: 'The client closed the request before completion.',
          },
        });
    });
    res.on('finish', () => {
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
        simulatorCode: res.getHeader('x-sim-error-code'),
      });
      if (
        req.url.startsWith('/__sim') &&
        !req.url.startsWith('/__sim/forms/') &&
        !req.url.startsWith('/__sim/artifacts/')
      )
        return;
      portalRequestTotal += 1;
      requests.push({
        at: started,
        method: req.method,
        path: ringPath(req.url),
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
      if (requests.length > 300) requests.shift();
    });
    // One request context per portal request: the trace correlation (or x-ms-correlation-request-id) reaches committed
    // events, jobs and flow runs; the visitor is the initiator.
    const requestContext = createRequestContext({
      organization,
      correlationId: correlationOf(req.headers['x-ms-correlation-request-id']) ?? context.correlationId ?? undefined,
      initiator: auth?.identity ? { kind: 'contact', id: auth.identity.id ?? null } : { kind: 'anonymous', id: null },
    });
    const invocation = organizationHost
      .run(() =>
        solutionMetadataOverlay.withReadEpoch(
          () =>
            runWithRequest(requestContext, () =>
              trace.run(context, async () => {
                // Enhanced authorization maps the visitor to its Dataverse user and roles before any entry point evaluates it. The
                // /_sim/api administration acts as the local administrator, never as the visitor: it maps nothing and provisions no
                // site application user, so a refused administration request leaves no side effect.
                if (!/^\/(?:_sim|__sim)\/api\//.test(req.url ?? '') && config().mode !== 'live')
                  await store.portalAuthorization?.prepare(currentIdentity());
                return runWithSourceDebugging(sourceMaps, () => handle(req, res));
              }),
            ),
          { valid: () => !store.inTransaction() || store.isUnmodifiedRead(), revision: () => store.dataRevision() },
        ),
      )
      .catch((err) => {
        context.error = err;
        if (err.code?.startsWith('PACK_CONFIGURATION_PRESET_'))
          recordDiagnostic(
            err.details?.configurationPresetDiagnostic ?? { code: err.code, severity: 'error', message: err.message },
          );
        if (err.details?.permissionDiagnostic)
          recordDiagnostic({ ...err.details.permissionDiagnostic, path: req.url?.split('?')[0] });
        // Administration API errors are answered to their caller; they are not portal runtime observations.
        if (!req.url?.startsWith('/__sim/api') && !err.details?.permissionDiagnostic)
          recordDiagnostic({
            code: err.code ?? 'RUNTIME_ERROR',
            message: err.message,
            path: req.url?.split('?')[0],
          });
        if (res.headersSent) {
          res.end();
          return;
        }
        const status = err.status ?? err.statusCode ?? 500;
        if (req.url.startsWith('/_api/') || req.url.startsWith('/__sim/api') || req.url.startsWith('/__sim/forms/'))
          json(res, status, {
            error: {
              code: err.code ?? 'SIMULATOR_ERROR',
              message: err.message,
              ...(req.url.startsWith('/__sim/forms/') && Array.isArray(err.details?.validationErrors)
                ? { validationErrors: err.details.validationErrors }
                : {}),
            },
            ...(req.url.startsWith('/__sim/forms/entityform/') &&
            formWriteError(err, config().observed ?? portal.observed)
              ? { postback: formWriteError(err, config().observed ?? portal.observed) }
              : {}),
          });
        else {
          const presentation = observedPageErrorResponse({
            method: req.method,
            error: err,
            observed: config().observed ?? portal.observed,
          });
          if (presentation) {
            res.writeHead(presentation.status, presentation.headers);
            return res.end(presentation.body);
          }
          res.writeHead(status, {
            'content-type': 'text/html; charset=utf-8',
            ...(err.code === 'REDIRECT_SITE_MARKER_NULL_REFERENCE' && observed.siteMarkerRedirect === 'null-reference'
              ? { 'cache-control': PAGE_CACHE_CONTROL }
              : {}),
          });
          const invalidReturnUrl = err.code === 'InvalidPersonaCatalog' && err.invalidParameter === 'returnUrl';
          const requestTitle = invalidReturnUrl
            ? 'Invalid returnUrl'
            : /^\/(?:_sim|__sim)\/sign-in(?:\?|$)/.test(req.url)
              ? err.status === 404 || /persona/i.test(err.message)
                ? 'Invalid persona parameter'
                : 'Local sign-in request failed'
              : null;
          res.end(
            `<!doctype html><title>${requestTitle ?? 'Portal simulation diagnostic'}</title><main style="font:16px system-ui;max-width:900px;margin:50px auto"><h1>${requestTitle ?? 'Portal rendering needs attention'}</h1><p>${escaped(err.message)}</p><p><a href="/__sim/">Open simulator admin</a></p></main>`,
          );
        }
      })
      .finally(() => activeRequests.delete(invocation));
    activeRequests.add(invocation);
  });
  bootstrapStageAt = performance.now();
  startupPhase('preset');
  if (startupPreset.applied)
    await store.initialize(() =>
      applySelectedPreset(preset, undefined, {
        applyConfiguration: presetConfiguration === 'apply',
        returnState: false,
      }),
    );
  bootstrapTimings.presetMs = Math.round(performance.now() - bootstrapStageAt);
  if (personaInstance) {
    const state = store.snapshot(undefined, { forkTables: true });
    state.simulator ??= {};
    if (personaInstance.deploymentProfile !== undefined)
      state.simulator.deploymentProfilePin = personaInstance.deploymentProfile;
    const variables = { ...state.simulator.environmentVariables };
    for (const [name, value] of Object.entries(personaInstance.environmentVariables ?? {})) {
      for (const existing of Object.keys(variables))
        if (existing.toLowerCase() === name.toLowerCase()) delete variables[existing];
      Object.defineProperty(variables, name, { value, enumerable: true, configurable: true, writable: true });
    }
    state.simulator.environmentVariables = variables;
    state.simulator.portalOverrides = {
      ...state.simulator.portalOverrides,
      settings: { ...state.simulator.portalOverrides?.settings, ...personaInstance.portalOverrides?.settings },
      snippets: { ...state.simulator.portalOverrides?.snippets, ...personaInstance.portalOverrides?.snippets },
    };
    state.simulator.mode = 'local';
    state.simulator.pageMode = 'local';
    state.simulator.live = { enabled: false };
    await saveState(state);
  }
  try {
    bootstrapStageAt = performance.now();
    startupPhase('organization');
    organization = await organizationHost.createOrganization({
      initializing: true,
      change,
      settings: liveDataverseSettings,
      schema: () => solutionData?.schema ?? null,
      metadataFields: (logical) => modelMetadata()?.entities?.[logical]?.fields,
      log: (...args) => recordDiagnostic({ code: 'DATAVERSE_API', message: String(args[0]?.message ?? args[0]) }),
    });
    organizationRecords = createModelDrivenRecordService({ organization, origin: () => localOrigin });
    // The site's authorization model (portal-authorization.mjs), reported once per start.
    store.setPortalAuthorization(
      createPortalAuthorization({
        store,
        website: () => portal.website,
        portal: () => portal,
        principals: organization.principals,
        fieldSecurity: () => organization.api?.fieldSecurity,
        organizationId: organization.organizationId,
        applicationUser: portalApplicationUser,
        existingApplicationUser: existingPortalApplicationUser,
        diagnostic: recordDiagnostic,
      }),
    );
    {
      const model = store.portalAuthorization.describe();
      recordDiagnostic({
        code: 'PORTAL_AUTHORIZATION_MODEL',
        severity: 'info',
        ...model,
        message:
          model.model === 'enhanced'
            ? `Enhanced authorization (${model.state}, ${model.label}): each visitor runs as its mapped Dataverse user; table permissions hold through the security roles mapped to its web roles and Dataverse column security profiles replace the Web API column permissions.`
            : 'Standard authorization: table permissions and Web API column permissions are evaluated for each visitor.',
      });
      if (model.unknown)
        recordDiagnostic({
          code: 'PORTAL_AUTHORIZATION_STATE_UNKNOWN',
          severity: 'warning',
          state: model.state,
          label: model.label,
          message: `The site record's enhanced authorization value ${model.state} is not documented (Learn lists 0 to 3); the site runs the standard model.`,
        });
    }
    bootstrapTimings.organizationMs = Math.round(performance.now() - bootstrapStageAt);
    store.completeInitialization();
    if (dataverseConfig.enabled) {
      dataverseCertificate = dataverseConfig.tls ? await ensureCertificate(dataverseCertificatePath) : null;
      // The Arc challenge's secret files sit beside the project state (.paqvilo/mirage/); other shapes need no secret directory.
      dataverse = await organizationHost.startApi({
        host,
        tls: dataverseCertificate ? { key: dataverseCertificate.key, cert: dataverseCertificate.cert } : null,
        beforeListen: () => storageAdapter?.activate(store.state),
        managedIdentities: managedIdentityList,
        managedIdentityMode,
        secretDirectory: path.join(projectRoot, '.paqvilo', 'mirage'),
      });
      managedIdentity = organizationHost.managedIdentity;
    }
    storageAdapter?.activate(store.state);
    startupPhase('listener');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port }, resolve);
    });
    localOrigin = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
    // The local identity provider: its own loopback port on the runtime's host, started with
    // the runtime and closed by close() (Ctrl+C, mirage stop, POST /_sim/api/shutdown).
    await externalSignIn.start({ host });
    bootstrapTimings.listenerMs = Math.round(performance.now() - startedAt);
    bootstrapTimings.memory = { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed };
  } catch (cause) {
    await close().catch((cleanup) => recordDiagnostic({ code: 'STARTUP_CLEANUP_FAILED', message: cleanup.message }));
    throw cause;
  }
  let reloadRequested = false;
  const changedPaths = new Set();
  let watchedLayers = '';
  const layerSignature = () =>
    JSON.stringify([
      (solutionData.layers ?? []).map((layer) => layer.dir),
      solutionMetadata.plugins?.sourceFiles ?? [],
    ]);
  async function reload() {
    if (closing) return;
    // Settled outside the host change queue (as standalone-runtime.mjs does): a job's api.change would wait on a held queue.
    await organizationHost.settle();
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
          solutionScan,
          solutionInventory,
          clientResources,
          canvasRecords: organizationHost.canvas.records,
          canvasDiagnostics: organizationHost.canvas.diagnostics,
        };
        try {
          const started = performance.now();
          const changed = [...changedPaths].sort();
          changedPaths.clear();
          activeProfiles = await loadDeploymentProfiles(profileConfig, config().deploymentProfilePin ?? null);
          sourcePortal = await importSource(config().modelDriven?.records);
          if (requirePortalSource) assertPortalSource(sourcePortal);
          portal = applyPortalOverrides(await environmentBound(sourcePortal, store.state), config().portalOverrides);
          sourceDependencies = { ...(await discoverSourceDependencies(portal)), compat: localOverrides.compat };
          await loadSolutions();
          generatedPresets = initialState(portal, bootstrapOptions()).presets;
          store.presetLibrary = generatedPresets;
          // Publish the new source fingerprint and renderer before the recompiled
          // state, so no status read pairs reloaded data with the old fingerprint.
          fingerprint = await calculateFingerprint();
          renderer = buildRenderer();
          // The re-registered Solution source modules (custom APIs, duplicate rules, workflows, plug-in registrations) follow in
          // the same change slot and source publication; their own transaction leaves the previous registrations when it fails.
          const publish = async () => {
            await replaceCompiledState(store.snapshot(undefined, { forkTables: true }));
            await organizationHost.refreshSources();
            await organizationHost.loadCanvas();
          };
          await change(() => (storageAdapter ? storageAdapter.bootstrap(publish, () => store.state) : publish()));
          diagnostics.length = 0;
          revision++;
          bootstrapTimings.lastReload = {
            at: new Date().toISOString(),
            durationMs: Math.round(performance.now() - started),
            changed: changed.slice(0, 50),
            changedCount: changed.length,
          };
          recordDiagnostic({
            code: 'SOURCES_RELOADED',
            severity: 'info',
            revision,
            changed: changed.slice(0, 20),
            message: `Reloaded portal and solution sources (${changed.length} changed path(s)); mappings, schemas and the permission model were recompiled.`,
          });
          if (watch && watchedLayers !== layerSignature()) await restartWatcher();
          for (const event of events) event.write(`event: reload\ndata: ${revision}\n\n`);
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
          ({ solutionScan, solutionInventory, clientResources } = previous);
          organizationHost.canvas.records = previous.canvasRecords;
          organizationHost.canvas.diagnostics = previous.canvasDiagnostics;
          recordDiagnostic({ code: 'RELOAD_FAILED', message: err.message });
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
    const pluginSources = [
      ...(solutionMetadata.plugins?.sourceFiles ?? []),
      ...Object.values(profileConfig.profiles).flatMap((sources) => Object.values(sources).flat()),
    ];
    const pluginSourceKeys = new Set(pluginSources.map((file) => path.resolve(file).toLowerCase()));
    const clientSources = modelDrivenSettingsValue.clientSources ?? [];
    const canvasSources = (settingOptionsRest.canvas?.sources ?? []).map((source) => path.resolve(projectRoot, source));
    const canvasKeys = canvasSources.map((source) => source.toLowerCase());
    const isCanvasSource = (file) => {
      const full = path.resolve(file).toLowerCase();
      const base = canvasKeys.find((root) => full === root || full.startsWith(root + path.sep));
      return (
        Boolean(base) &&
        !full
          .slice(base.length)
          .split(path.sep)
          .some((part) => /^(?:\.git|node_modules|\.paqvilo|bin|obj)$/i.test(part))
      );
    };
    // A <Library>@<version>.js clientSources entry is a file root (watched as that file), never a directory layer.
    const ignoreSource = solutionWatchFilter({
      sourceDir,
      roots: [...solutionRoots, ...clientSources],
      layers: [
        ...layers,
        ...clientSources.filter((source) => !/[.]js$/i.test(source)).map((dir) => ({ type: 'directory', dir })),
      ],
      exclude: stateFile ? [path.dirname(path.resolve(stateFile))] : [],
    });
    watcher = watchSources([sourceDir, ...solutionRoots, ...clientSources, ...pluginSources, ...canvasSources], {
      ignoreInitial: true,
      ignored: (file, stats) =>
        pluginSourceKeys.has(path.resolve(file).toLowerCase()) || isCanvasSource(file)
          ? false
          : ignoreSource(file, stats),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    const watched = watcher;
    const watchReady = new Promise((resolve) => {
      const settled = () => {
        watched.off('ready', settled);
        watched.off('error', settled);
        if (watcherReadyRelease === settled) watcherReadyRelease = null;
        resolve();
      };
      watcherReadyRelease = settled;
      watched.once('ready', settled);
      watched.once('error', settled);
    });
    watcher.on('all', (_event, file) => {
      if (closing) return;
      if (file) changedPaths.add(file);
      clearTimeout(watcherTimer);
      watcherTimer = setTimeout(() => {
        if (!closing) reload().catch(() => {});
      }, 250);
    });
    watcher.on('error', (err) => recordDiagnostic({ code: 'WATCH_ERROR', message: err.message }));
    await watchReady;
    bootstrapTimings.watcher =
      watched.nativeWatchCount?.() > 0
        ? { backend: 'windows-recursive', handles: watched.nativeWatchCount() }
        : { backend: 'chokidar', directories: Object.keys(watched.getWatched?.() ?? {}).length };
    await previousWatcher?.close();
  }
  if (watch) await restartWatcher();
  bootstrapTimings.startupMs = bootstrapTimings.listenerMs = Math.round(performance.now() - startedAt);
  startupPhase('listener-ready');
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
    // The simulated Dataverse API listener (null when disabled), for tools and tests.
    get dataverse() {
      return dataverse
        ? {
            origin: dataverse.origin,
            tlsOrigin: dataverse.tlsOrigin,
            authority: dataverse.authority,
            tenantId: dataverse.tenantId,
            organizationId: dataverse.organizationId,
            tdsPort: dataverse.tdsPort,
            requests: dataverse.requests,
          }
        : null;
    },
    state: exposedState,
    // The /_sim write token (x-sim-csrf); constant for the life of the server.
    csrf,
    // The preflight report of this running simulator (GET /_sim/api/preflight): { scenario, strict }.
    preflight,
    // Resolves once every committed-event job (asynchronous plug-in steps, web hooks, row-triggered flows, due scheduled
    // jobs) has run: the durable job queue runs on the scheduler, so awaiting the store queue alone is not enough.
    settle: () => organizationHost.settle(),
    applyPreset: (name) => change(() => applySelectedPreset(name)),
    // Sign-in for tools and tests that render portal routes as a persona :
    // { cookieHeader: "paqvilo-mirage-auth-<port>=…" for a Cookie request header, identity }.
    signIn: (contactId, options = {}) => {
      const session = signInSession(contactId, options);
      return {
        cookieHeader: `${authSessions.name}=${authSessions.value(session)}`,
        identity: describeSession(session),
      };
    },
    reload,
    close,
  };
}
