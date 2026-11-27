import { validateCanvasDisplay } from './canvas-display.mjs';
import { validateDataverseAttributeErrorContexts } from './dataverse-attribute-context.mjs';
import { isTimeZoneName } from './portal-query-time-zone.mjs';
import { observedFirewall, observedIpRestrictions } from './edge-access.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { contentPolicyDefaults } from './content-policy-defaults.mjs';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { importPortal } from './importer.mjs';
import { importSolutionMetadata } from './solution-metadata.mjs';
import { importSolutionData } from './solution-data.mjs';
import { scanSolutionSources, buildSolutionSchema } from './solution-schema.mjs';
import { solutionSideFileHashes } from './solution-content-fingerprint.mjs';
import { SolutionFileCache } from './solution-cache.mjs';
import { applyObserved } from './redirects.mjs';
import { isTenantAuthority } from './external-login.mjs';
import { resolveDeploymentProfiles, loadDeploymentProfiles } from './deployment-profiles.mjs';
import { loadOrganizationSources } from './solution-runtime-source.mjs';
import { parseSetting, projectKeys } from './config-keys.mjs';
import { jsonErrorPosition, withoutContent } from './path-options.mjs';
import './provider-modules.mjs';
import { codeComponentGuid } from './code-components.mjs';
import { readSigningKey } from './auth-token.mjs';

const VERSIONS = [1, 2];
const idPattern = /^[a-z0-9][a-z0-9._-]*$/i;
// Structural project keys; every setting key is a row of config-keys.mjs (projectKeys()).
const PROJECT_ONLY_KEYS = [
  'version',
  'defaultPortal',
  'default_portal',
  'portals',
  'solutions',
  'references',
  'referenceEnvironments',
  'presets',
  'lcid',
  'watch',
  'stateDirectory',
  'state_directory',
];
const KNOWN_KEYS = new Set([...PROJECT_ONLY_KEYS, ...projectKeys()]);
// Setting rows resolved by dedicated code below (per portal, async or path-bearing); the loop parses the others.
const RESOLVED_SEPARATELY = new Set([
  'runtime',
  'solutionOrder',
  'dataPacks',
  'deploymentProfiles',
  'confinePortalPages',
  'externalAssets',
  'externalFrameOrigins',
  'environmentVariables',
]);
// A resolved project carries a setting only when the file sets it, so a default (simulation, modelDriven, platform,
// dataverse) never masks a catalogue site's value in runtimeOptions(); readers take the default through defaultedSetting().
/** A project setting: the file's value, else the row's default. */
export const defaultedSetting = (project, key) => project?.[key] ?? parseSetting(key, undefined);

function list(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function validateOrigin(value, label, allowLoopback = false) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${label} must be an HTTPS origin`);
  }
  if (
    !(
      url.protocol === 'https:' ||
      (allowLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(`${label} must be an HTTPS origin without credentials, path, query, or fragment`);
  return url.origin;
}

/** Observed values that are a choice between documented behaviours. */
const OBSERVED_CHOICES = {
  formSubmissionErrorMarkup: ['inline', 'paragraph'],
  webApiInnerError: ['all-errors', 'dataverse-errors'],
  webApiUpdatePermissionQuery: ['native-classic'],
  webApiMutationPermissionText: ['table'],
  // Defaults first: the text of every hosted capture (the demo site, hosted session F1) and the cdscode F1 sent.
  webApiCdsErrorMessage: ['Common Data Service error occurred.', 'CDS error occurred.'],
  webApiCdsErrorCode: ['cdscode', 'innererror'],
  webApiAntiForgery: ['cookie-mismatch-403', 'decryption-401'],
  webApiReferenceErrors: ['dataverse', 'unexpected'],
  webApiInvalidDate: ['invalid-format', 'crm-minimum'],
  webApiDateParsing: ['iso', 'month-first'],
  // Stable reader exception/message wrappers differ by site; generated CLR stacks are not reproduced.
  webApiErrorDetails: ['diagnostic', 'odata-wrapper'],
  webApiWriteResponse: ['local', 'portal-classic'],
  webApiReadResponse: ['local', 'jsonnet-indented'],
  webApiFileDownload: ['portal-range'],
  // GET routes below an entity: "refused" (hosted session F1: /<column> and navigations to another table answer 403 All
  // Columns, a collection navigation to the same table names itself; lib/webapi-handler.mjs assertMemberRead) or
  // "served" (the former local model).
  webApiMemberReads: ['refused', 'served'],
  webApiRequestBody: ['strict', 'portal-classic'],
  anonymousDataAccess: ['allowed', 'blocked'],
  // Replay a recorded inactive-parent defect only for a site observed to have it.
  // Normal exported permission graphs keep incomplete parent chains closed.
  tablePermissionOrphans: ['closed', 'unrestricted'],
  tablePermissionQueryPipeline: ['row-filtered', 'native-classic'],
  webApiFetchXmlLinkTypes: ['dataverse', 'portal-classic'],
  liquidFetchXmlLinkTypes: ['dataverse', 'portal-classic'],
  fetchAllWithoutFilter: ['modeled', 'sql-error'],
  fetchLinkBudgetError: ['documented', 'reported-counts'],
  odataPermissionQueryPipeline: ['modeled', 'native-classic'],
  odataSameTableParentAnchor: ['shared-root'],
  liquidFetchExecution: ['eager', 'lazy-query-drop'],
  liquidFetchTop: ['drop-valid'],
  // The portal object model's authoring conversion of Liquid and Web API FetchXML (lib/portal-fetchxml.mjs).
  portalFetchXmlAuthoring: ['portal-classic'],
  // eq-userid, ne-userid, eq-businessid and ne-businessid of portal FetchXML evaluate against the site's application user.
  portalFetchIdentityOperators: ['application-user'],
  liquidFetchRights: ['read-only', 'native-classic'],
  liquidFetchErrorMessage: ['diagnostic', 'target-invocation'],
  // The environment's SharePoint integration: on with the sharepointDocuments storage route, or "off" as hosted session F7
  // recorded it (lib/sharepoint-document-table.mjs).
  sharePointIntegration: ['storage', 'off'],
  // Some deployments return 302 for an explicitly configured 301 redirect record.
  // Other status values are outside this observation and keep their source behavior.
  redirect301: ['configured', 'temporary'],
  webTemplateResponseNewline: ['none', 'crlf'],
  webFileMimeCharset: ['utf8', 'source'],
  siteMarkerRedirect: ['resolve', 'null-reference'],
  nativeFormTransport: ['json', 'postback'],
  // Native number boxes of a page culture other than the captured en-US and de-DE: "captured" (default: invariant
  // numbers, FORM_NUMBER_CULTURE_UNCAPTURED) or "locale-data" (the culture's marks from the locale data, uncaptured).
  nativeNumberCultures: ['captured', 'locale-data'],
  // /_services/execute-workflow: "list-action" (Mirage's default: a list's own workflow action, its signed
  // configuration and read/write access to the record) or "any-on-demand" (hosted session F2 OPS-01f: any on-demand
  // workflow, run as the site's application user, with no list or secure configuration; lib/native-services.mjs).
  executeWorkflowAccess: ['list-action', 'any-on-demand'],
  // Local account registration with a taken user name or address: "generic" (Mirage's default: 409 naming neither) or
  // "named" (hosted session F4 AUTH-04g: `The username "x" is already taken.`; lib/local-accounts.mjs).
  registrationDuplicateMessages: ['generic', 'named'],
  // A local account confirmation link: "one-time" (Mirage's default) or "reusable" (hosted session F4 AUTH-04g).
  confirmationLinkReuse: ['one-time', 'reusable'],
  // The private-site admission deadline: "application-cookie" (Mirage's default: the ExpireTimeSpan, 24 hours without
  // it) or "fixed-day" (24 hours whatever the cookie lifetime; hosted session F4 AUTH-06h held an admission at least
  // 59 minutes with a 6-minute cookie; lib/external-login.mjs admissionSessionLifetime).
  privateSiteAdmissionLifetime: ['application-cookie', 'fixed-day'],
  // A Power Pages cloud flow trigger's declared schema: "enforced" (Mirage's default: input the schema refuses fails the run
  // with InvalidRequest and reports FLOW_TRIGGER_SCHEMA_ENFORCED) or "not-enforced" (hosted session F8: the flow runs with
  // what was sent; lib/flow-runtime.mjs validateTriggerInput).
  powerPagesFlowTriggerSchema: ['enforced', 'not-enforced'],
  // List OData feeds: "removed" (the platform default since June 2026, LIST_ODATA_FEED_REMOVED:
  // /_odata/<feed> answers the Page Not Found page) or "served" (a site observed still serving them).
  listODataFeeds: ['removed', 'served'],
  modalLoadOrdering: ['ready', 'immediate'],
  modalFormShell: ['signed-in-zero-website', 'signed-in-exported-or-zero-website'],
  subgridLabelMarkup: ['encoded', 'sanitized'],
  webApiErrorStacks: ['diagnostic', 'response-template'],
  dataverseErrorStacks: ['diagnostic', 'response-template'],
  // Which Bootstrap stylesheet the layout links: the platform's /css/bootstrap.min.css or the
  // site's bootstrap.min.css web file (read by lib/liquid.mjs; default from the export).
  bootstrapStylesheet: ['platform', 'web-file'],
  // Site visibility (Power Platform admin, not exported): "private" renders the platform's
  // private-site banner first in the layout body (lib/liquid.mjs).
  siteVisibility: ['public', 'private'],
  // "platform": the site sends the default policy Learn documents for sites created after November 10, 2025 while it
  // sets no HTTP/Content-Security-Policy (lib/response-headers.mjs sitePolicy). The export does not show it.
  defaultContentSecurityPolicy: ['none', 'platform'],
  // Which script elements get the nonce of a nonce policy (lib/render-provenance.mjs): "proven" (the default, fail-closed:
  // only scripts and handlers the exported source or the platform wrote) or "every-script" (every script element and
  // inline handler, also those data writes, as hosted session F3 observed).
  scriptNonceScope: ['proven', 'every-script'],
  // Webapi/<table>/fields = "*": "enforced" (the hosted default; read by the Web API policy)
  // or "exempt" (the site was observed exposing every column for such a table).
  webApiWildcard: ['enforced', 'exempt'],
  webApiLookupFields: ['explicit-wire', 'logical-aliases'],
  // A site's Liquid math adapter may convert string inputs before decimal multiplication.
  // The pinned DotLiquid contract remains the default; a different result needs site evidence.
  liquidDecimalStringMultiply: ['dotliquid', 'convert'],
  liquidTimesDispatch: ['dotliquid', 'observed'],
  liquidFilterErrors: ['dotliquid', 'observed'],
  liquidServiceTags: ['dotliquid', 'observed'],
  // Records output only; an empty response does not establish the native integration's admin state.
  powerBiOutput: ['empty', 'placeholder'],
  // Generative AI for site users (Copilot hub governance at tenant, environment or site level; Power Platform admin,
  // not exported): "disabled" answers the Data Summarization API with 400 90041001 (lib/portal-data-summary.mjs).
  siteUserGenerativeAi: ['enabled', 'disabled'],
  // Web pages in a non-visible publishing state in portal search results: "excluded" (Mirage's default for a visitor
  // who cannot preview unpublished content) or "listed" (hosted session F3 PAGE-04f: a hosted site with Dataverse search
  // lists them to every visitor; lib/portal-search.mjs).
  searchUnpublishedPages: ['excluded', 'listed'],
  // entities.knowledgearticle with KnowledgeManagement/ContentAccessLevel/Enabled: "filtered" (Mirage's default: only an
  // article that shares a content access level with the visitor) or "unfiltered" (hosted session F3 AUTH-07c: an enhanced
  // site returns every article through entities; lib/liquid.mjs).
  knowledgeEntitiesContentAccess: ['filtered', 'unfiltered'],
  // The stamp of a new row's rollup columns (lib/dataverse-rollup.mjs): "calculated" (Mirage's default and a column created
  // with its definition through the Web API: state 1, _date the row's createdon) or "not-calculated" (summary-F6 DATA-04c2:
  // a column saved by the classic rollup designer: state 0, 0 or null, _date its last mass calculation or null).
  rollupCreateState: ['calculated', 'not-calculated'],
  liquidObjectCompatibility: ['dotliquid', 'observed'],
  liquidHtmlVoidSerialization: ['dotliquid', 'html'],
  liquidHtmlSafeInput: ['excluded', 'observed'],
  liquidPathAndQueryFragment: ['uri', 'query'],
  liquidRelativeQueryResolution: ['preserve', 'root'],
  liquidRuntimeCompatibility: ['dotliquid', 'observed'],
  liquidFilterRegistration: ['dotliquid', 'observed'],
  liquidEscapeOnce: ['dotliquid', 'passthrough'],
  liquidStripHtmlScriptText: ['remove', 'preserve'],
  liquidEditableMetadata: ['minimal', 'observed'],
  liquidMissingData: ['diagnostic', 'empty'],
  requestValidation: ['diagnostic', 'aspnet-query'],
  pageErrorPresentation: ['diagnostic', 'generic-error'],
  // The admin center's "Disable custom errors" site action (not exported): the error page's RTGE01 server log entry
  // gains the exception message (hosted session F3).
  customErrors: ['enabled', 'disabled'],
};

function applyObservedBasics(value, label, observed) {
  // portalId: the site's hosted portal id (the admin-center id, Microsoft.Dynamic365.Portal.id and a flow's siteId), which
  // differs from the website record id and is not in an export (hosted session F8 section 1).
  if (value.portalId != null) {
    if (typeof value.portalId !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value.portalId))
      throw new Error(`${label}.portalId must be a GUID`);
    observed.portalId = value.portalId.toLowerCase();
  }
  if (value.canvasDisplay !== undefined)
    observed.canvasDisplay = validateCanvasDisplay(value.canvasDisplay, `${label}.canvasDisplay`);
  if (value.webApiFetchXmlTransport != null) {
    const transport = value.webApiFetchXmlTransport,
      limits = ['maxHeaderXmlBytes', 'maxUrlXmlBytes', 'maxConstructedXmlBytes'];
    if (
      !transport ||
      typeof transport !== 'object' ||
      Array.isArray(transport) ||
      transport.encoding !== 'double-rfc3986' ||
      Object.keys(transport).some((key) => !['encoding', ...limits].includes(key)) ||
      limits.some((key) => !Number.isSafeInteger(transport[key]) || transport[key] < 1 || transport[key] > 4000000) ||
      transport.maxHeaderXmlBytes > transport.maxUrlXmlBytes ||
      transport.maxUrlXmlBytes > transport.maxConstructedXmlBytes
    )
      throw new Error(
        `${label}.webApiFetchXmlTransport requires double-rfc3986 encoding and ordered bounded integer XML byte budgets`,
      );
    observed.webApiFetchXmlTransport = { ...transport };
  }
  // A read cache the site was observed with (hosted session F1 follow-up: repeated identical reads were answered from a
  // cache for at least 195 s and under 415 s), so the lifetime must lie in that window.
  if (value.webApiReadCache != null) {
    const cache = value.webApiReadCache;
    if (
      !cache ||
      typeof cache !== 'object' ||
      Array.isArray(cache) ||
      Object.keys(cache).some((key) => key !== 'seconds') ||
      !Number.isInteger(cache.seconds) ||
      cache.seconds < 195 ||
      cache.seconds > 414
    )
      throw new Error(`${label}.webApiReadCache must be { seconds } with an integer from 195 to 414`);
    observed.webApiReadCache = { seconds: cache.seconds };
  }
  if (value.webApiTwoDigitYearMax != null) {
    if (
      !Number.isInteger(value.webApiTwoDigitYearMax) ||
      value.webApiTwoDigitYearMax < 99 ||
      value.webApiTwoDigitYearMax > 9999 ||
      value.webApiDateParsing !== 'month-first'
    )
      throw new Error(
        `${label}.webApiTwoDigitYearMax requires month-first parsing and an integer from 99 through 9999`,
      );
    observed.webApiTwoDigitYearMax = value.webApiTwoDigitYearMax;
  }
}

const observedObject = (item) => item && typeof item === 'object' && !Array.isArray(item);

function normalizePermissionGroup(group, seen, counter, field, label) {
  if (!Array.isArray(group) || !group.length || group.length > 5000)
    throw new Error(`${label}.${field} requires nonempty bounded GUID groups`);
  return group.map((id) => {
    if (
      typeof id !== 'string' ||
      !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id) ||
      seen.has(id.toLowerCase()) ||
      ++counter.total > 5000
    )
      throw new Error(`${label}.${field} contains invalid, duplicate or excessive permission GUIDs`);
    seen.add(id.toLowerCase());
    return id.toLowerCase();
  });
}

function normalizePermissionTables(input, field, label) {
  const tables = {},
    counter = { total: 0 };
  for (const [table, groups] of Object.entries(input)) {
    const seen = new Set();
    if (!/^[_a-z][a-z\d_]{0,127}$/i.test(table) || !Array.isArray(groups) || groups.length > 5000)
      throw new Error(`${label}.${field} requires bounded ordered GUID groups for each logical table`);
    tables[table] = groups.map((group) => normalizePermissionGroup(group, seen, counter, field, label));
  }
  return tables;
}

function normalizePermissionOrder(order, field, label) {
  if (
    !observedObject(order) ||
    Object.keys(order).some((key) => !['normalizedGraphHash', 'tables'].includes(key)) ||
    typeof order.normalizedGraphHash !== 'string' ||
    !/^[a-f\d]{64}$/.test(order.normalizedGraphHash) ||
    !observedObject(order.tables) ||
    Object.keys(order.tables).length > 100
  )
    throw new Error(`${label}.${field} requires a normalized graph SHA256 and at most 100 logical tables`);
  return {
    normalizedGraphHash: order.normalizedGraphHash,
    tables: normalizePermissionTables(order.tables, field, label),
  };
}

function applyObservedPermissionOrders(value, label, observed) {
  for (const field of ['tablePermissionGrantOrder', 'odataPermissionGrantOrder'])
    if (value[field] != null) observed[field] = normalizePermissionOrder(value[field], field, label);
}

function applyObservedFetchSettings(value, label, observed) {
  if (value.webApiGlobalMetadataVersion != null) {
    if (typeof value.webApiGlobalMetadataVersion !== 'string' || !/^\d{1,20}$/.test(value.webApiGlobalMetadataVersion))
      throw new Error(`${label}.webApiGlobalMetadataVersion must be a bounded numeric string`);
    observed.webApiGlobalMetadataVersion = value.webApiGlobalMetadataVersion;
  }
  if (value.fetchPreOperationSerialization != null) {
    const entries = value.fetchPreOperationSerialization;
    if (
      !entries ||
      typeof entries !== 'object' ||
      Array.isArray(entries) ||
      Object.keys(entries).length > 100 ||
      Object.entries(entries).some(([entity, mode]) => !/^[_a-z][a-z\d_]{0,127}$/i.test(entity) || mode !== 'compact')
    )
      throw new Error(`${label}.fetchPreOperationSerialization must map at most 100 exact logical tables to compact`);
    if (Object.keys(entries).length) observed.fetchPreOperationSerialization = { ...entries };
  }
  if (value.formSubmissionErrorMessage != null) {
    if (
      typeof value.formSubmissionErrorMessage !== 'string' ||
      !value.formSubmissionErrorMessage.trim() ||
      value.formSubmissionErrorMessage.length > 2000
    )
      throw new Error(`${label}.formSubmissionErrorMessage must be bounded plain text`);
    observed.formSubmissionErrorMessage = value.formSubmissionErrorMessage;
  }
}

function normalizeObservedPluginSource(name, source, label) {
  const relative = typeof source?.path === 'string' ? source.path.replaceAll('\\', '/') : '';
  if (
    !/^[_a-z][\w.+`]{0,249}$/i.test(name) ||
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    Object.keys(source).some((key) => !['path', 'evidence', 'root'].includes(key)) ||
    !relative.endsWith('.cs') ||
    path.isAbsolute(relative) ||
    // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
    /[:\x00-\x1f]/.test(relative) ||
    relative
      .split('/')
      .some(
        (part) => !part || part === '.' || part === '..' || /^(?:\.git|\.paqvilo|node_modules|bin|obj)$/i.test(part),
      ) ||
    typeof source.evidence !== 'string' ||
    !source.evidence.trim() ||
    source.evidence.length > 2000 ||
    // A relative root is resolved against the folder of the file that declares it.
    (source.root !== undefined &&
      // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
      (typeof source.root !== 'string' || !source.root.trim() || /[\x00-\x1f]/.test(source.root)))
  )
    throw new Error(
      `${label}.pluginSources requires exact type names, relative .cs paths, evidence and an optional trusted root`,
    );
  return {
    path: relative,
    evidence: source.evidence,
    ...(source.root ? { root: source.root } : {}),
  };
}

function applyObservedPluginSources(value, label, observed) {
  if (value.pluginSources == null) return;
  if (
    !value.pluginSources ||
    typeof value.pluginSources !== 'object' ||
    Array.isArray(value.pluginSources) ||
    Object.keys(value.pluginSources).length > 1000
  )
    throw new Error(
      `${label}.pluginSources must map at most 1000 exact plugin type names to source paths with evidence`,
    );
  observed.pluginSources = {};
  for (const [name, source] of Object.entries(value.pluginSources)) {
    observed.pluginSources[name] = normalizeObservedPluginSource(name, source, label);
  }
}

function normalizeObservedSdkMessage(message, id, label, observed) {
  if (
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id) ||
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    Object.keys(message).some((key) => !['name', 'evidence', 'availability', 'filterAvailability'].includes(key)) ||
    typeof message.name !== 'string' ||
    !/^[a-z][a-z0-9_]{0,199}$/i.test(message.name) ||
    typeof message.evidence !== 'string' ||
    !message.evidence.trim() ||
    message.evidence.length > 2000
  )
    throw new Error(`${label}.sdkMessages requires GUID keys, SDK names and evidence`);
  if (Object.hasOwn(observed.sdkMessages, id)) throw new Error(`${label}.sdkMessages has a duplicate SDK message GUID`);
  if (message.availability !== undefined && ![0, 1, 2].includes(message.availability))
    throw new Error(`${label}.sdkMessages availability must be 0 (server), 1 (client) or 2 (both)`);
  if (
    message.filterAvailability !== undefined &&
    (!message.filterAvailability ||
      typeof message.filterAvailability !== 'object' ||
      Array.isArray(message.filterAvailability) ||
      Object.keys(message.filterAvailability).length > 1000 ||
      Object.entries(message.filterAvailability).some(
        ([entity, availability]) => !/^[a-z][a-z0-9_]{0,199}$/i.test(entity) || ![0, 1, 2].includes(availability),
      ))
  )
    throw new Error(`${label}.sdkMessages filterAvailability must map logical table names to availability 0, 1 or 2`);
  if (
    message.filterAvailability &&
    new Set(Object.keys(message.filterAvailability).map((entity) => entity.toLowerCase())).size !==
      Object.keys(message.filterAvailability).length
  )
    throw new Error(`${label}.sdkMessages filterAvailability has a duplicate logical table name`);
  observed.sdkMessages[id] = {
    name: message.name,
    evidence: message.evidence,
    ...(message.availability !== undefined ? { availability: message.availability } : {}),
    ...(message.filterAvailability
      ? {
          filterAvailability: Object.fromEntries(
            Object.entries(message.filterAvailability).map(([entity, availability]) => [
              entity.toLowerCase(),
              availability,
            ]),
          ),
        }
      : {}),
  };
}

function applyObservedSdkMessages(value, label, observed) {
  if (value.sdkMessages == null) return;
  if (
    !value.sdkMessages ||
    typeof value.sdkMessages !== 'object' ||
    Array.isArray(value.sdkMessages) ||
    Object.keys(value.sdkMessages).length > 1000
  )
    throw new Error(`${label}.sdkMessages must map at most 1000 SDK message GUIDs to names with evidence`);
  observed.sdkMessages = {};
  for (const [raw, message] of Object.entries(value.sdkMessages)) {
    const id = raw.replace(/[{}]/g, '').toLowerCase();
    normalizeObservedSdkMessage(message, id, label, observed);
  }
}

function normalizeObservedOwnership(ownership, id, label, observed) {
  if (
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id) ||
    !ownership ||
    typeof ownership !== 'object' ||
    Array.isArray(ownership) ||
    Object.keys(ownership).some((key) => !['kind', 'evidence'].includes(key)) ||
    !['system', 'microsoft', 'custom', 'unknown'].includes(ownership.kind) ||
    typeof ownership.evidence !== 'string' ||
    !ownership.evidence.trim() ||
    ownership.evidence.length > 2000
  )
    throw new Error(
      `${label}.businessLogicOwnership requires GUID keys, a system/microsoft/custom/unknown kind and evidence`,
    );
  if (Object.hasOwn(observed.businessLogicOwnership, id))
    throw new Error(`${label}.businessLogicOwnership has a duplicate GUID`);
  observed.businessLogicOwnership[id] = { kind: ownership.kind, evidence: ownership.evidence };
}

function applyObservedBusinessLogicOwnership(value, label, observed) {
  if (value.businessLogicOwnership == null) return;
  if (
    !value.businessLogicOwnership ||
    typeof value.businessLogicOwnership !== 'object' ||
    Array.isArray(value.businessLogicOwnership) ||
    Object.keys(value.businessLogicOwnership).length > 1000
  )
    throw new Error(
      `${label}.businessLogicOwnership must map at most 1000 business logic GUIDs to evidenced ownership`,
    );
  observed.businessLogicOwnership = {};
  for (const [raw, ownership] of Object.entries(value.businessLogicOwnership)) {
    const id = raw.replace(/[{}]/g, '').toLowerCase();
    normalizeObservedOwnership(ownership, id, label, observed);
  }
}

function applyObservedCodeComponents(value, label, observed) {
  if (value.codeComponents == null) return;
  if (!value.codeComponents || typeof value.codeComponents !== 'object' || Array.isArray(value.codeComponents))
    throw new Error(`${label}.codeComponents must map GUIDs to control schema names`);
  observed.codeComponents = {};
  for (const [raw, schema] of Object.entries(value.codeComponents)) {
    const id = codeComponentGuid(raw);
    if (!id || typeof schema !== 'string' || !/^[\w.]+$/.test(schema))
      throw new Error(`${label}.codeComponents requires GUID keys and schema names`);
    if (Object.hasOwn(observed.codeComponents, id))
      throw new Error(`${label}.codeComponents has a duplicate component GUID`);
    observed.codeComponents[id] = schema;
  }
}

// The zone portal queries evaluate UserLocal date operators in (lib/portal-query-time-zone.mjs): an IANA zone name or
// "runtime" (the zone this local runtime is configured for).
function portalQueryTimeZone(raw, label) {
  const zone = typeof raw === 'string' ? raw.trim() : '';
  if (zone !== 'runtime' && !isTimeZoneName(zone))
    throw new Error(`${label}.portalQueryTimeZone must be an IANA time zone name or runtime`);
  return zone;
}

function applyObservedUserSettings(value, label, observed) {
  if (value.portalApplicationUser != null) {
    const name = String(value.portalApplicationUser).trim();
    if (!name || name.length > 200)
      throw new Error(`${label}.portalApplicationUser must be the application user's display name`);
    observed.portalApplicationUser = name;
  }
  if (value.portalApplicationUserId != null) {
    const id = String(value.portalApplicationUserId).trim().replace(/[{}]/g, '').toLowerCase();
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))
      throw new Error(`${label}.portalApplicationUserId must be the application user's systemuser GUID`);
    observed.portalApplicationUserId = id;
  }
  if (value.portalQueryTimeZone != null)
    observed.portalQueryTimeZone = portalQueryTimeZone(value.portalQueryTimeZone, label);
  if (value.loginPath != null) {
    const loginPath = String(value.loginPath).trim();
    if (!/^\/(?!\/)[^?#\s]*$/.test(loginPath))
      throw new Error(`${label}.loginPath must be a site-relative path such as /SignIn`);
    observed.loginPath = loginPath;
  }
}

const OBSERVED_HEADER_KINDS = ['page', 'webFile', 'webApi'];
const OBSERVED_HEADER_KIND_TEXT = `${OBSERVED_HEADER_KINDS.slice(0, -1).join(', ')} or ${OBSERVED_HEADER_KINDS.at(-1)}`;

function applyObservedHeaders(value, label, observed) {
  if (value.headers == null) return;
  if (typeof value.headers !== 'object' || Array.isArray(value.headers))
    throw new Error(`${label}.headers must map ${OBSERVED_HEADER_KIND_TEXT} to headers`);
  const headers = {};
  for (const [kind, entries] of Object.entries(value.headers)) {
    if (!OBSERVED_HEADER_KINDS.includes(kind))
      throw new Error(`${label}.headers.${kind} must be ${OBSERVED_HEADER_KIND_TEXT}`);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries))
      throw new Error(`${label}.headers.${kind} must map header names to values`);
    headers[kind] = {};
    for (const [name, raw] of Object.entries(entries)) {
      const header = String(raw ?? '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name) || !header || /[\r\n]/.test(header))
        throw new Error(`${label}.headers.${kind}.${name} must be a header name with a one-line value`);
      headers[kind][name.toLowerCase()] = header;
    }
  }
  if (Object.values(headers).some((entries) => Object.keys(entries).length)) observed.headers = headers;
}

function applyObservedAuthority(value, label, observed) {
  if (value.azureAdAuthority == null) return;
  const authority = String(value.azureAdAuthority).trim();
  if (!isTenantAuthority(authority))
    throw new Error(
      `${label}.azureAdAuthority must be the observed Microsoft Entra authority of one tenant, https://login.windows.net/<tenant>/ with the tenant's directory ID or domain name (not a placeholder, common or organizations)`,
    );
  observed.azureAdAuthority = authority;
}

function applyObservedSelfNnErrors(value, label, observed) {
  if (value.webApiSelfNnPermissionErrors == null) return;
  const profiles = value.webApiSelfNnPermissionErrors;
  if (
    !profiles ||
    typeof profiles !== 'object' ||
    Array.isArray(profiles) ||
    !Object.keys(profiles).length ||
    Object.keys(profiles).length > 1000
  )
    throw new Error(
      `${label}.webApiSelfNnPermissionErrors must map qualified relationship schema names to native-classic`,
    );
  observed.webApiSelfNnPermissionErrors = Object.create(null);
  for (const [schema, mode] of Object.entries(profiles)) {
    if (
      !/^[a-z][a-z0-9_]{0,199}$/i.test(schema) ||
      mode !== 'native-classic' ||
      Object.hasOwn(observed.webApiSelfNnPermissionErrors, schema.toLowerCase())
    )
      throw new Error(
        `${label}.webApiSelfNnPermissionErrors requires unique relationship schema names and native-classic values`,
      );
    observed.webApiSelfNnPermissionErrors[schema.toLowerCase()] = mode;
  }
}

function applyObservedChoices(value, label, observed) {
  for (const [key, choices] of Object.entries(OBSERVED_CHOICES)) {
    if (value[key] == null) continue;
    if (!choices.includes(value[key])) throw new Error(`${label}.${key} must be ${choices.join(' or ')}`);
    observed[key] = value[key];
  }
}

// RFC 6797 section 6.1: one max-age with a delta-seconds value (optionally quoted), optional includeSubDomains;
// preload is the common preload-list token. Each directive at most once.
function applyObservedStrictTransportSecurity(value, label, observed) {
  if (value.strictTransportSecurity == null) return;
  const header = typeof value.strictTransportSecurity === 'string' ? value.strictTransportSecurity.trim() : '';
  const directives = header
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean);
  const names = directives.map((directive) => directive.split('=')[0].trim().toLowerCase());
  const valid =
    header.length <= 256 &&
    !/[\r\n]/.test(header) &&
    new Set(names).size === names.length &&
    names.includes('max-age') &&
    directives.every((directive) =>
      /^(?:max-age\s*=\s*(?:\d{1,10}|"\d{1,10}")|includesubdomains|preload)$/i.test(directive),
    );
  if (!valid)
    throw new Error(
      `${label}.strictTransportSecurity must be the observed header value, such as max-age=31536000; includeSubDomains`,
    );
  observed.strictTransportSecurity = header;
}

// The hosted edge in front of the site: its IP allow list and WAF custom rules (lib/edge-access.mjs).
function applyObservedEdge(value, label, observed) {
  if (value.ipRestrictions != null)
    observed.ipRestrictions = observedIpRestrictions(value.ipRestrictions, `${label}.ipRestrictions`);
  if (value.firewall != null) observed.firewall = observedFirewall(value.firewall, `${label}.firewall`);
}

const CORS_PAGE_PATH = /^\/(?:[\w.~!$&'()*+,;=:@%-]+\/)+$/;
// Authored pages the site was observed sharing across origins (lib/page-cors.mjs): canonical page paths ending in "/".
function applyObservedCorsPages(value, label, observed) {
  if (value.corsPages == null) return;
  const paths = value.corsPages;
  if (!Array.isArray(paths) || !paths.length || paths.length > 50)
    throw new Error(`${label}.corsPages must list 1 to 50 exported page paths`);
  const seen = new Set();
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      !CORS_PAGE_PATH.test(path) ||
      path.split('/').some((segment) => segment === '.' || segment === '..')
    )
      throw new Error(`${label}.corsPages entries must be page paths such as /identity-layout/ (not the root)`);
    if (seen.has(path.toLowerCase())) throw new Error(`${label}.corsPages lists ${path} twice`);
    seen.add(path.toLowerCase());
  }
  // A cross-origin page answer bypasses no private-site gate: the observation must also record a public site
  // (applyObservedChoices has already read siteVisibility).
  if (observed.siteVisibility !== 'public')
    throw new Error(`${label}.corsPages requires siteVisibility public; set both or neither`);
  observed.corsPages = [...paths];
}

function applyObservedWildcardExpiry(value, label, observed) {
  if (!Object.hasOwn(value, 'webApiWildcardExpiresAt')) return;
  const expires = value.webApiWildcardExpiresAt;
  const instant = typeof expires === 'string' ? Date.parse(expires) : Number.NaN;
  if (
    observed.webApiWildcard !== 'exempt' ||
    !Number.isFinite(instant) ||
    new Date(instant).toISOString() !== expires.replace(/(:\d\d)Z$/, '$1.000Z')
  )
    throw new Error(`${label}.webApiWildcardExpiresAt requires an exempt wildcard and an ISO UTC timestamp`);
  observed.webApiWildcardExpiresAt = expires;
}

/**
 * Observed platform behaviour that the export cannot express, recorded per site with the
 * evidence for it: `{ loginPath?, headers?, webApiInnerError?, anonymousDataAccess?, bootstrapStylesheet?, evidence }`.
 * loginPath is the sign-in path the platform redirects to when the export sets no
 * Authentication/ApplicationCookie/LoginPath (sites without it answer /signin or /SignIn
 * online); webApiInnerError and anonymousDataAccess are read by the Web API and data
 * layers. Keys that are not given stay absent so each consumer applies its own default.
 * Any observation requires evidence naming where it was observed.
 */
export function observedConfig(value, label = 'observed') {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (
      ![
        'evidence',
        'loginPath',
        'portalApplicationUser',
        'portalApplicationUserId',
        'headers',
        'azureAdAuthority',
        'codeComponents',
        'canvasDisplay',
        'sdkMessages',
        'businessLogicOwnership',
        'pluginSources',
        'formSubmissionErrorMessage',
        'fetchPreOperationSerialization',
        'webApiGlobalMetadataVersion',
        'webApiWildcardExpiresAt',
        'tablePermissionGrantOrder',
        'odataPermissionGrantOrder',
        'webApiTwoDigitYearMax',
        'webApiFetchXmlTransport',
        'webApiReadCache',
        'webApiSelfNnPermissionErrors',
        'dataverseAttributeErrorContexts',
        'strictTransportSecurity',
        'ipRestrictions',
        'firewall',
        'corsPages',
        'portalQueryTimeZone',
        'portalId',
      ].includes(key) &&
      !Object.hasOwn(OBSERVED_CHOICES, key)
    )
      throw new Error(`Unknown ${label} key '${key}'`);
  const observed = {};
  if (Object.hasOwn(value, 'dataverseAttributeErrorContexts')) {
    const property = Object.getOwnPropertyDescriptor(value, 'dataverseAttributeErrorContexts');
    if (!('value' in property)) throw new Error(`${label}.dataverseAttributeErrorContexts requires explicit data`);
    observed.dataverseAttributeErrorContexts = validateDataverseAttributeErrorContexts(
      property.value,
      `${label}.dataverseAttributeErrorContexts`,
    );
  }
  applyObservedBasics(value, label, observed);
  applyObservedPermissionOrders(value, label, observed);
  applyObservedFetchSettings(value, label, observed);
  applyObservedPluginSources(value, label, observed);
  applyObservedSdkMessages(value, label, observed);
  applyObservedBusinessLogicOwnership(value, label, observed);
  applyObservedCodeComponents(value, label, observed);
  applyObservedUserSettings(value, label, observed);
  // headers: { page?: { <name>: <value> }, webFile?: { <name>: <value> } }, the response
  // headers the platform sends on that kind of response although no exported site setting
  // defines them (lib/response-headers.mjs siteHeaders).
  applyObservedHeaders(value, label, observed);
  // azureAdAuthority: the authority the built-in Microsoft Entra provider posts on the site
  // when the export carries no Authentication/OpenIdConnect/AzureAD/Authority (lib/external-login.mjs).
  // An observation names one tenant: a placeholder is never recorded as observed.
  applyObservedAuthority(value, label, observed);
  applyObservedSelfNnErrors(value, label, observed);
  applyObservedChoices(value, label, observed);
  applyObservedWildcardExpiry(value, label, observed);
  applyObservedCorsPages(value, label, observed);
  applyObservedStrictTransportSecurity(value, label, observed);
  applyObservedEdge(value, label, observed);
  if (!Object.keys(observed).length) return null;
  const evidence = typeof value.evidence === 'string' ? value.evidence.trim() : '';
  if (!evidence)
    throw new Error(`${label}.evidence must name the observation behind ${Object.keys(observed).join(', ')}`);
  // A denied native Liquid right answers an empty result only in the native table-permission pipeline, so the
  // observation is refused without it (as webApiTwoDigitYearMax is without month-first parsing).
  if (observed.liquidFetchRights === 'native-classic' && observed.tablePermissionQueryPipeline !== 'native-classic')
    throw new Error(
      `${label}.liquidFetchRights native-classic requires tablePermissionQueryPipeline native-classic; set both or neither`,
    );
  return { ...observed, evidence };
}
function normalizePortal(entry, index) {
  if (typeof entry === 'string') entry = { path: entry };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    throw new Error(`portals[${index}] must be a path or object`);
  const sourcePath = entry.path ?? entry.source ?? entry.sourceDir;
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error(`portals[${index}].path is required`);
  const id = String(entry.id ?? `portal-${index + 1}`);
  if (!idPattern.test(id)) throw new Error(`Invalid portal id '${id}'`);
  const solutions = entry.solutions == null ? null : list(entry.solutions, `portals[${index}].solutions`).map(String);
  return {
    id,
    sourcePath,
    origin: entry.origin == null ? null : validateOrigin(entry.origin, `portals[${index}].origin`),
    deploymentProfile: entry.deploymentProfile ?? entry.deployment_profile ?? null,
    deploymentProfiles: entry.deploymentProfiles,
    platform: entry.platform,
    ...contentPolicyDefaults(entry),
    solutionIds: solutions,
    reference: entry.reference == null ? null : String(entry.reference),
    observed: observedConfig(entry.observed, `portals[${index}].observed`),
    // The site's data model when the source does not record it (lib/importer.mjs dataModel).
    dataModel: dataModelOf(entry.dataModel, `portals[${index}].dataModel`),
  };
}
function dataModelOf(value, label) {
  if (value == null) return null;
  if (!['standard', 'enhanced'].includes(value)) throw new Error(`${label} must be standard or enhanced`);
  return value;
}

function normalizeSolution(entry, index) {
  if (typeof entry === 'string') entry = { path: entry };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    throw new Error(`solutions[${index}] must be a path or object`);
  const sourcePath = entry.path ?? entry.source ?? entry.root;
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error(`solutions[${index}].path is required`);
  const id = String(entry.id ?? `solution-${index + 1}`);
  if (!idPattern.test(id)) throw new Error(`Invalid solution id '${id}'`);
  return { id, sourcePath };
}

function normalizeReference(ref, index, allowLoopback = false) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`references[${index}] must be an object`);
  const id = String(ref.id ?? `reference-${index + 1}`);
  if (!idPattern.test(id)) throw new Error(`Invalid reference id '${id}'`);
  if (typeof ref.origin !== 'string') throw new Error(`references[${index}].origin must be an HTTPS origin`);
  if (ref.default !== undefined && typeof ref.default !== 'boolean')
    throw new Error(`references[${index}].default must be a boolean`);
  return {
    id,
    origin: validateOrigin(ref.origin, `references[${index}].origin`, allowLoopback),
    ...(ref.name ? { name: String(ref.name) } : {}),
    ...(ref.environment ? { environment: String(ref.environment) } : {}),
    default: ref.default === true,
  };
}

function normalizeDataPack(entry, index) {
  if (typeof entry === 'string') entry = { module: entry };
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    typeof entry.module !== 'string' ||
    !entry.module.trim()
  )
    throw new Error(`dataPacks[${index}] must be a module path or { id, module }`);
  const id = String(
    entry.id ??
      path
        .basename(entry.module)
        .replace(/\.[cm]?js$/i, '')
        .replace(/^index$/i, path.basename(path.dirname(entry.module))),
  );
  if (!idPattern.test(id)) throw new Error(`Invalid data pack id '${id}'`);
  return { id, modulePath: entry.module };
}

/**
 * Parse and validate a source-only Mirage project file (YAML or JSON).
 * Version 1 files keep loading unchanged; version 2 adds per-portal solution
 * selection, references with a default, data packs, lcid, watch, a state
 * directory override, solution order and local environment-variable values.
 */
export async function loadProjectConfig(configFile) {
  const absoluteConfig = path.resolve(configFile);
  const source = await fs.readFile(absoluteConfig, 'utf8');
  const json = /\.json$/i.test(absoluteConfig);
  let raw;
  try {
    raw = json ? JSON.parse(source) : YAML.parse(source);
  } catch (error) {
    // Parser messages quote file contents (a value may be a token): only the reason code and position are shown, in
    // the message and in the cause.
    const yamlAt = error.linePos?.[0];
    const yamlWhere = [error.code ?? 'YAMLParseError', yamlAt && `at line ${yamlAt.line}, column ${yamlAt.col}`];
    const where = json ? jsonErrorPosition(source, error) : yamlWhere.filter(Boolean).join(' ');
    withoutContent(error, where);
    throw new Error(`Project file ${absoluteConfig} is not valid ${json ? 'JSON' : 'YAML'} (${where}). Fix the file.`, {
      cause: error,
    });
  }
  return resolveProjectConfig(raw, absoluteConfig);
}

/** Setup validates structure separately from source readiness, without importing packs. */
function checkProjectConfigKeys(raw, diagnostics) {
  for (const key of Object.keys(raw)) {
    if (KNOWN_KEYS.has(key)) continue;
    if (raw.version >= 2) throw new Error(`Unknown project configuration key '${key}'`);
    diagnostics.push({
      code: 'PROJECT_CONFIG_KEY_UNKNOWN',
      severity: 'warning',
      key,
      message: `Unknown project configuration key '${key}' is ignored.`,
    });
  }
}

function assertUniqueEntries(entries, kind) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`Duplicate ${kind} id '${entry.id}'`);
    seen.add(entry.id);
  }
}

function assertPortalSources(portalEntries, runtime) {
  if (!portalEntries.length && runtime.kind === 'power-pages')
    throw new Error('At least one portal source is required');
}

async function resolveProjectSource(base, checkSources, sourcePath, kind, id) {
  const resolved = path.resolve(base, sourcePath);
  if (!checkSources) return resolved;
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(`${kind} '${id}' source directory does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`${kind} '${id}' source is not a directory: ${resolved}`);
  return fs.realpath(resolved);
}

async function resolveSolutionEntry(solution, resolveSource) {
  return { ...solution, root: await resolveSource(solution.sourcePath, 'Solution', solution.id) };
}

function referenceAllowsLoopback(ref, raw, runtime) {
  return (
    runtime.kind === 'model-driven' &&
    Array.isArray(raw.modelDriven?.targets) &&
    raw.modelDriven.targets.some((target) => target?.reference === ref?.id)
  );
}

async function resolveProjectPortal({
  solutionIds,
  portal,
  byId,
  references,
  solutions,
  raw,
  runtime,
  base,
  resolveSource,
}) {
  for (const solutionId of solutionIds ?? [])
    if (!byId.has(solutionId)) throw new Error(`Portal '${portal.id}' selects unknown solution '${solutionId}'`);
  if (portal.reference && !references.some((ref) => ref.id === portal.reference))
    throw new Error(`Portal '${portal.id}' selects unknown reference '${portal.reference}'`);
  const selected = (solutionIds ?? solutions.map((solution) => solution.id)).map((solutionId) => byId.get(solutionId));
  if (portal.observed?.pluginSources)
    portal.observed.pluginSources = Object.fromEntries(
      Object.entries(portal.observed.pluginSources).map(([name, source]) => [
        name,
        { ...source, root: source.root ? path.resolve(base, source.root) : base },
      ]),
    );
  // Standalone profiles retain portal selections for later use, without
  // requiring that unused export to be present on this machine.
  const sourceDir =
    runtime.kind === 'power-pages'
      ? await resolveSource(portal.sourcePath, 'Portal', portal.id)
      : path.resolve(base, portal.sourcePath);
  return {
    ...portal,
    ...contentPolicyDefaults(raw),
    ...contentPolicyDefaults(portal),
    platform: parseSetting('platform', portal.platform ?? raw.platform, { label: `portals.${portal.id}.platform` }),
    deploymentProfiles: resolveDeploymentProfiles(portal.deploymentProfiles ?? raw.deploymentProfiles, base, {
      sourceDir,
      sourceRoot: base,
    }),
    sourceDir,
    solutions: selected.map((solution) => solution.id),
    solutionRoots: selected.map((solution) => solution.root),
  };
}

async function resolveDataPack(pack, base, checkSources) {
  const module = path.resolve(base, pack.modulePath);
  if (!checkSources) return { id: pack.id, module };
  try {
    if (!(await fs.stat(module)).isFile()) throw new Error('Data pack module is not a file.');
  } catch {
    throw new Error(`Data pack '${pack.id}' module does not exist: ${module}`);
  }
  return { id: pack.id, module };
}

function validateEnvironmentVariables(environmentVariables) {
  if (!environmentVariables || typeof environmentVariables !== 'object' || Array.isArray(environmentVariables))
    throw new Error('environmentVariables must map schema names to values');
  for (const [name, value] of Object.entries(environmentVariables))
    if (!/^[a-z][\w.]*$/i.test(name) || !['string', 'number', 'boolean'].includes(typeof value))
      throw new Error(`environmentVariables.${name} must be a string, number or boolean value`);
}

function resolveProjectSettings(raw, runtime, base, diagnostics) {
  const settings = {};
  for (const key of projectKeys()) {
    if (RESOLVED_SEPARATELY.has(key)) continue;
    let value;
    if (key === 'dataverse')
      value = raw.dataverse ?? (runtime.kind === 'dataverse-api' ? { enabled: true } : undefined);
    else value = raw[key];
    if (value === undefined) continue;
    settings[key] = parseSetting(key, value, { base, diagnostics });
  }
  return settings;
}

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
// Each configured implicit grant signing key file must read as a usable key and stay outside every portal export and
// Solution folder, so a source checkout or a pac upload never carries it. A failure names the file and the reason only.
async function validateImplicitGrantKeys(settings, portals, solutions) {
  const keys = settings.implicitGrant?.signingKeys ?? [];
  if (!keys.length) return;
  const roots = await Promise.all(
    [...portals.map((portal) => portal.sourceDir), ...solutions.map((solution) => solution.root)].map((root) =>
      fs.realpath(root).catch(() => path.resolve(root)),
    ),
  );
  for (const [index, key] of keys.entries()) {
    const label = `implicitGrant.signingKeys[${index}].privateKeyFile`;
    try {
      readSigningKey(key.privateKeyFile);
    } catch (error) {
      throw Object.assign(new Error(`${label}: ${error.message}`), {
        code: error.code ?? 'IMPLICIT_GRANT_SIGNING_KEY_INVALID',
      });
    }
    const file = await fs.realpath(key.privateKeyFile);
    if (roots.some((root) => inside(root, file)))
      throw Object.assign(
        new Error(
          `${label}: ${key.privateKeyFile} is inside a portal export or Solution folder; keep signing keys outside the sources.`,
        ),
        { code: 'IMPLICIT_GRANT_SIGNING_KEY_INVALID' },
      );
  }
}

function validateModelDrivenTargets(settings, references) {
  const targetOrigins = new Set();
  for (const target of settings.modelDriven?.targets ?? []) {
    const reference = references.find((ref) => ref.id === target.reference);
    if (!reference) throw new Error(`Model-driven target selects unknown reference '${target.reference}'`);
    if (targetOrigins.has(reference.origin)) throw new Error('Model-driven targets must have distinct origins');
    targetOrigins.add(reference.origin);
  }
}

export async function resolveProjectConfig(raw, configFile, { checkSources = true } = {}) {
  const absoluteConfig = path.resolve(configFile);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Project configuration must be an object');
  if (!VERSIONS.includes(raw.version))
    throw new Error(`Project configuration version must be ${VERSIONS.join(' or ')}`);
  // Version 2 rejects unknown keys; version 1 stays lenient and reports them as diagnostics.
  const diagnostics = [];
  checkProjectConfigKeys(raw, diagnostics);
  const portalEntries = list(raw.portals, 'portals').map((entry, index) => normalizePortal(entry, index));
  const runtime = parseSetting('runtime', raw.runtime);
  assertPortalSources(portalEntries, runtime);
  const solutionEntries = list(raw.solutions, 'solutions').map((entry, index) => normalizeSolution(entry, index));
  assertUniqueEntries(portalEntries, 'portal');
  assertUniqueEntries(solutionEntries, 'solution');
  const base = path.dirname(absoluteConfig);
  const resolveSource = (sourcePath, kind, id) => resolveProjectSource(base, checkSources, sourcePath, kind, id);
  const solutions = await Promise.all(solutionEntries.map((solution) => resolveSolutionEntry(solution, resolveSource)));
  const byId = new Map(solutions.map((solution) => [solution.id, solution]));
  const references = list(raw.references ?? raw.referenceEnvironments, 'references').map((ref, index) =>
    normalizeReference(ref, index, referenceAllowsLoopback(ref, raw, runtime)),
  );
  assertUniqueEntries(references, 'reference');
  if (references.filter((ref) => ref.default).length > 1) throw new Error('Only one reference can be the default');
  const defaultReference = references.find((ref) => ref.default) ?? (references.length === 1 ? references[0] : null);
  const portals = await Promise.all(
    portalEntries.map(({ solutionIds, ...portal }) =>
      resolveProjectPortal({ solutionIds, portal, byId, references, solutions, raw, runtime, base, resolveSource }),
    ),
  );
  const defaultPortal = raw.defaultPortal ?? raw.default_portal ?? portals[0]?.id ?? null;
  if (defaultPortal !== null && !portals.some((portal) => portal.id === defaultPortal))
    throw new Error(`defaultPortal '${defaultPortal}' is not configured`);
  const dataPacks = await Promise.all(
    list(raw.dataPacks ?? raw.presets, 'dataPacks')
      .map((entry, index) => normalizeDataPack(entry, index))
      .map((pack) => resolveDataPack(pack, base, checkSources)),
  );
  assertUniqueEntries(dataPacks, 'data pack');
  const lcid = raw.lcid ?? raw.dataverse?.localeId ?? 1033;
  if (!Number.isInteger(lcid) || lcid <= 0) throw new Error('lcid must be a positive integer');
  if (raw.watch !== undefined && typeof raw.watch !== 'boolean') throw new Error('watch must be a boolean');
  // Solution roots are a set layered in dependency order; "explicit" keeps the listed order.
  const solutionOrder = raw.solutionOrder ?? 'derived';
  if (!['explicit', 'derived'].includes(solutionOrder)) throw new Error('solutionOrder must be explicit or derived');
  const stateDirectoryValue = raw.stateDirectory ?? raw.state_directory;
  if (stateDirectoryValue !== undefined && (typeof stateDirectoryValue !== 'string' || !stateDirectoryValue.trim()))
    throw new Error('stateDirectory must be a path');
  const environmentVariables = raw.environmentVariables ?? {};
  validateEnvironmentVariables(environmentVariables);
  const settings = resolveProjectSettings(raw, runtime, base, diagnostics);
  validateModelDrivenTargets(settings, references);
  if (checkSources) await validateImplicitGrantKeys(settings, portals, solutions);
  return {
    configFile: absoluteConfig,
    stateNamespace: createHash('sha256')
      .update(absoluteConfig)
      .update('\0')
      .update(portals.map((p) => p.sourceDir).join('\0'))
      .digest('hex')
      .slice(0, 16),
    version: raw.version,
    runtime,
    ...settings,
    defaultPortal,
    lcid,
    watch: raw.watch ?? null,
    stateDirectory: stateDirectoryValue ? path.resolve(base, stateDirectoryValue) : null,
    solutionOrder,
    portals,
    solutions,
    solutionRoots: solutions.map((solution) => solution.root),
    references,
    defaultReference,
    dataPacks,
    environmentVariables: Object.fromEntries(
      Object.entries(environmentVariables).map(([name, value]) => [name, String(value)]),
    ),
    diagnostics,
  };
}

/** Live origin for a portal: its own origin, else its selected or the default reference. */
export function projectOrigin(project, portal) {
  if (portal.origin) return portal.origin;
  const reference = portal.reference
    ? project.references.find((ref) => ref.id === portal.reference)
    : project.defaultReference;
  return reference?.origin ?? null;
}

/** State file for a project portal (state directory override, else the project namespace). */
export function projectStateFile(project, portalId, defaultRoot) {
  return path.join(project.stateDirectory ?? path.join(defaultRoot, project.stateNamespace), portalId, 'state.json');
}

/** JSON-safe project summary exposed by the runtime status (status.project). */
export function projectSummary(project, portalId = null) {
  return {
    configFile: project.configFile,
    version: project.version,
    runtime: project.runtime ?? { kind: 'power-pages' },
    simulation: defaultedSetting(project, 'simulation'),
    modelDriven: defaultedSetting(project, 'modelDriven'),
    platform: defaultedSetting(project, 'platform'),
    portal: portalId,
    defaultPortal: project.defaultPortal,
    lcid: project.lcid,
    watch: project.watch,
    solutionOrder: project.solutionOrder,
    stateDirectory: project.stateDirectory,
    portals: project.portals.map(
      ({
        id,
        sourceDir,
        origin,
        deploymentProfile,
        deploymentProfiles,
        platform,
        solutions,
        reference,
        observed,
        dataModel,
      }) => ({
        id,
        sourceDir,
        origin: origin ?? projectOrigin(project, { origin, reference }),
        deploymentProfile,
        deploymentProfiles,
        solutions,
        reference,
        observed: observed ?? null,
        dataModel: dataModel ?? null,
        ...(platform ? { platform } : {}),
      }),
    ),
    solutions: project.solutions.map(({ id, root }) => ({ id, root })),
    references: project.references,
    defaultReference: project.defaultReference?.id ?? null,
    dataPacks: project.dataPacks,
    environmentVariables: Object.keys(project.environmentVariables ?? {}),
    // Findings of the project file itself (PROJECT_CONFIG_KEY_UNKNOWN for a version-1 project's unknown key).
    diagnostics: project.diagnostics ?? [],
  };
}

/** Import all configured sources locally and deterministically; this performs no network access. */
export async function bootstrapProject(project, { lcid = project.lcid ?? 1033, cacheFile } = {}) {
  if (project.runtime?.kind && project.runtime.kind !== 'power-pages') {
    const organization = await loadOrganizationSources({
      solutionRoots: project.solutionRoots,
      solutionOrder: project.solutionOrder,
      modelDriven: defaultedSetting(project, 'modelDriven'),
      lcid,
      cacheFile,
    });
    return { project, portals: [], solutionData: organization.solutionData, organization };
  }
  const cache = await SolutionFileCache.open(cacheFile ?? null);
  // Duplicate-copy commit lookups of the portal exports, cached beside the solution cache.
  const portalCache = await SolutionFileCache.open(
    cacheFile ? path.join(path.dirname(cacheFile), 'portal-sources.json') : null,
  );
  const scans = new Map();
  const loadLayers = async (roots) => {
    const key = JSON.stringify(roots);
    if (!scans.has(key)) {
      const scan = await scanSolutionSources(roots, { cache, order: project.solutionOrder ?? 'derived' });
      const sideHashes = solutionSideFileHashes(scan.layers, scan.cache);
      scans.set(key, { scan, sideHashes, schema: buildSolutionSchema(scan, { lcid, sideHashes }) });
    }
    return scans.get(key);
  };
  const portals = [];
  for (const source of project.portals) {
    if (source.deploymentProfile && Object.keys(source.deploymentProfiles?.profiles ?? {}).length)
      throw new Error('Use deploymentProfiles or legacy deploymentProfile, not both.');
    const activeProfiles = await loadDeploymentProfiles(source.deploymentProfiles ?? resolveDeploymentProfiles());
    const portal = applyObserved(
      await importPortal(source.sourceDir, {
        lcid,
        cache: portalCache,
        ...(source.deploymentProfile ? { deploymentProfile: source.deploymentProfile } : {}),
        ...(activeProfiles.pagesFile
          ? { deploymentProfile: activeProfiles.profile, deploymentProfileFile: activeProfiles.pagesFile }
          : {}),
        ...(source.dataModel ? { dataModel: source.dataModel } : {}),
      }),
      source.observed,
    );
    const roots = source.solutionRoots ?? project.solutionRoots;
    const { scan, schema, sideHashes } = await loadLayers(roots);
    const metadata = await importSolutionMetadata(roots, {
      portal,
      lcid,
      scan,
      schema,
      sideHashes,
      observed: source.observed,
    });
    const solutionData = await importSolutionData(roots, { scan, schema, sideHashes, lcid });
    portals.push({ ...source, portal, metadata, solutionData, activeProfiles });
  }
  const shared = await loadLayers(project.solutionRoots);
  const solutionData = await importSolutionData(project.solutionRoots, { ...shared, lcid });
  await cache.save();
  await portalCache.save();
  cache.release();
  portalCache.release();
  return { project, portals, solutionData };
}
