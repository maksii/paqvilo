// Preflight report (ARCH decision 14): what a run of these sources requires and whether this runtime can satisfy it.
// buildPreflightReport is pure; preflight() loads the sources once (no listeners), composes the listener-free host
// description (organization-host.mjs composeHostDescription) and asks it, so offline and live preflight share one
// composition. The report names requirements by id and status only: secrets, connection ids and other configured values
// are never printed.
import { simulationSettings } from './simulation-settings.mjs';
import { globMatcher } from './capability-registry.mjs';

export const PREFLIGHT_STATUSES = Object.freeze(['satisfied', 'missing', 'placeholder', 'unsupported', 'disabled', 'secret']);
const LEVELS = ['inventory', 'contract', 'behaviour', 'native-qualified'];

/** Validates a scenario `{ id, requires: [pattern] }` (glob `*`). */
export function scenarioSettings(value, label = 'scenario') {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object { id, requires: [...] }`);
  for (const key of Object.keys(value)) if (!['id', 'requires', 'file', 'description'].includes(key)) throw new Error(`Unknown ${label} key '${key}'`);
  if (typeof value.id !== 'string' || !value.id.trim()) throw new Error(`${label}.id must be non-empty text`);
  if (!Array.isArray(value.requires) || value.requires.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${label}.requires must be an array of requirement ids or patterns`);
  return { id: value.id, requires: value.requires.map(item => item.trim()), ...(value.file ? { file: String(value.file) } : {}) };
}

function operationStatus(item) {
  if (item.enabled === false || item.mode === 'disabled') return 'disabled';
  if (item.unsupported) return 'unsupported';
  if (item.mode === 'placeholder' || item.mode === 'mock') return 'placeholder';
  return 'satisfied';
}

/**
 * The preflight JSON (schemaVersion 1). Requirements come from the source graph (`graph.requirements()`), the operation
 * catalogue items, local-service probes and provider probes; scenario patterns that match none of those are checked
 * against the capability registry. A requirement blocks only when it is in scope, not satisfied, and a scenario or
 * `strict` asks for blocking.
 */
export function buildPreflightReport({ runtime, simulation = null, registry, graph = null, operations = [], packs = [], localServices = [], providers = [],
  portal = null, scenario = null, strict = false, diagnostics = [] } = {}) {
  const selected = scenarioSettings(scenario);
  const matchers = selected?.requires.map(pattern => ({ pattern, match: globMatcher(pattern) })) ?? null;
  const rows = [];
  const push = ({ id, kind, source = null, status, reason = null, resolution = null, message = null, surface = null }) =>
    rows.push({ id, kind, source, status, reason, resolution, message, ...(surface ? { surface } : {}) });
  for (const row of graph?.requirements?.() ?? [])
    push({ id: row.id, kind: row.kind, source: { file: row.source ?? null, ...(row.layer != null ? { layer: row.layer } : {}) }, status: row.status, reason: row.reason ?? null,
      resolution: row.status === 'satisfied' ? { by: 'source' } : row.provider ? { by: row.provider } : row.level ? { level: row.level } : null,
      message: row.dependent ? `Required by ${row.dependent}.` : row.message ?? null, surface: row.surface });
  for (const item of operations) {
    const status = operationStatus(item);
    push({ id: item.key, kind: item.kind, source: { file: item.sourceFile ?? null }, status,
      resolution: { by: item.registered ? 'pack' : item.mode === 'exported' ? 'source' : null, mode: item.mode },
      message: item.unsupported ? String(item.unsupported) : status === 'placeholder' ? `The ${item.kind} answers through its ${item.mode}; it does not run.` : null });
  }
  for (const service of localServices)
    push({ id: `local-service:${service.id}`, kind: 'local-service', status: service.reachable ? 'satisfied' : 'missing', resolution: service.reachable ? { by: 'probe' } : null, message: service.message ?? null });
  for (const provider of providers)
    push({ id: provider.id, kind: 'provider', status: provider.status ?? (provider.reachable ? 'satisfied' : 'missing'),
      resolution: provider.resolution ?? (provider.reachable ? { by: 'probe' } : null), message: provider.message ?? null });
  // Scenario patterns that match no source requirement are answered by the source graph's components, then by the
  // capability registry, else reported missing.
  const capabilities = registry?.list() ?? [];
  // A pattern naming a host surface (`portalRendering`, or `portalRendering/<row id>`) brings that surface's gap rows into
  // scope; the surface is satisfied only when none of them is unsatisfied.
  const scoped = new Set();
  for (const { pattern, match } of matchers ?? []) {
    if (rows.some(row => match(row.id))) continue;
    const surfaces = capabilities.filter(record => record.kind === 'host-surface' && (match(record.name) || rows.some(row => row.surface === record.name && match(`${record.name}/${row.id}`))));
    for (const record of surfaces.filter(record => !scoped.has(record.name))) {
      scoped.add(record.name);
      const gaps = rows.filter(row => row.surface === record.name && row.status !== 'satisfied').map(row => row.id);
      const ok = !gaps.length && LEVELS.indexOf(record.level) >= LEVELS.indexOf('behaviour');
      push({ id: record.name, kind: 'host-surface', surface: record.name, status: ok ? 'satisfied' : 'unsupported', resolution: { level: record.level },
        message: ok ? null : gaps.length ? `Detected but not run by this surface: ${gaps.join(', ')}.` : `Registered at ${record.level}.` });
    }
    if (surfaces.length) continue;
    const nodes = [...(graph?.nodes?.values?.() ?? [])].filter(node => match(node.id)).map(node => ({ id: node.id, kind: node.kind, level: node.level, file: node.source }));
    const found = nodes.length ? nodes : capabilities.flatMap(record => [{ id: record.name, kind: 'capability', level: record.level, reason: record.reason },
      ...record.operations.map(operation => ({ id: `${record.name}/${operation.name}`, kind: 'capability', level: operation.level, reason: operation.reason }))]).filter(item => match(item.id));
    if (!found.length) push({ id: pattern, kind: 'scenario', status: 'missing', message: 'No source component or registered capability matches this scenario requirement.' });
    for (const item of found) {
      const ok = LEVELS.indexOf(item.level) >= LEVELS.indexOf('behaviour');
      push({ id: item.id, kind: item.kind, source: item.file ? { file: item.file } : null, status: ok ? 'satisfied' : 'unsupported', resolution: { level: item.level },
        message: ok ? null : `Registered at ${item.level}${item.reason ? `: ${item.reason}` : ''}.` });
    }
  }
  const requirements = rows.map(row => {
    const inScope = matchers ? matchers.some(({ match }) => match(row.id)) || scoped.has(row.surface) : true;
    return { ...row, inScope, blocking: inScope && row.status !== 'satisfied' && Boolean(selected || strict) };
  });
  const summary = { total: requirements.length, ...Object.fromEntries(PREFLIGHT_STATUSES.map(status => [status, requirements.filter(row => row.status === status).length])),
    blocking: requirements.filter(row => row.blocking).length };
  const capabilityReport = registry?.report() ?? { missing: [] };
  const layers = [...(graph?.nodes?.values?.() ?? [])].filter(node => node.kind === 'layer').sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0))
    .map(node => ({ index: node.layer, solution: node.solution, version: node.version, type: node.format ?? null, input: node.source }));
  return {
    schemaVersion: 1,
    kind: 'paqvilo.mirage.preflight',
    runtime: { kind: runtime?.kind ?? 'power-pages', simulation: simulation?.level ?? null, capabilities: registry?.summary() ?? {} },
    scope: { scenario: selected ? { id: selected.id, file: selected.file ?? null } : null, requires: selected?.requires ?? [], strict: Boolean(strict) },
    sources: { graphFingerprint: graph?.fingerprint ?? null, portal: portal ? { sourceDir: portal.sourceDir ?? null, layout: portal.source?.dialect ?? null, dataModel: portal.dataModel ?? null } : null, layers },
    modules: capabilities,
    requirements,
    summary,
    diagnostics: [
      ...(packs?.diagnostics ?? []),
      ...capabilityReport.missing.map(({ module, requires }) => ({ code: 'CAPABILITY_REQUIRES_UNREGISTERED', severity: 'info', module, requires,
        message: `${module} requires ${requires}, which no registered capability provides.` })),
      ...(graph?.diagnostics?.() ?? []),
      ...diagnostics,
    ],
  };
}

/** 0 = nothing blocking in scope, 1 = blocking requirement(s), 2 = no valid report (invocation or configuration error). */
export function preflightExitCode(report) {
  if (report?.kind !== 'paqvilo.mirage.preflight' || typeof report.summary?.blocking !== 'number') return 2;
  return report.summary.blocking > 0 ? 1 : 0;
}

/**
 * Load the sources (no listeners), compose the host description a running host of the same configuration builds
 * (organization-host.mjs composeHostDescription: host surfaces, organization modules, operations, connectors, providers with
 * pack factories, outbox, service fixtures, inventory and storage readiness) and return its preflight report. Options use
 * the createSimulator names (spread `runtimeOptions()` output): runtime, simulation, solutionRoots, solutionOrder, sourceDir,
 * dataModel, lcid, project, dataPacks, packs (module paths, loaded as createSimulator loads them), environmentVariables, deploymentProfiles, modelDriven, localServices,
 * providers, connections, secrets, canvas, dataverse, projectRoot, initial (its `mappings` join the boot mappings, as on the running host); plus scenario, strict and env (where env:NAME references
 * resolve, default process.env); loadedPacks takes already discovered packs instead. The one difference from GET /_sim/api/preflight: operation modes are the source defaults.
 */
export async function preflight({ runtime, simulation, solutionRoots = [], solutionOrder = 'derived', sourceDir = null, dataModel, lcid = 1033, project = null,
  dataPacks = [], packs: packModules, loadedPacks, environmentVariables = {}, deploymentProfiles, modelDriven, localServices, providers, connections, secrets, canvas, dataverse, connectorScripts,
  projectRoot = process.cwd(), scenario = null, strict = false, env = process.env, initial = null } = {}) {
  const [{ loadOrganizationSources }, catalogue, { discoverPacks }, { composeHostDescription, activeDeploymentProfile }] = await Promise.all([
    import('./solution-runtime-source.mjs'), import('./operation-catalogue.mjs'), import('./preset-registry.mjs'), import('./organization-host.mjs')]);
  const sources = await loadOrganizationSources({ solutionRoots, solutionOrder, modelDriven, lcid, projectRoot });
  let portal = null;
  if (sourceDir) {
    const [{ importPortal }, { assertPortalSource }] = await Promise.all([import('./importer.mjs'), import('./source-dialect.mjs')]);
    portal = assertPortalSource(await importPortal(sourceDir, { dataModel, lcid }));
  }
  const deploymentProfile = await activeDeploymentProfile({ deploymentProfiles, projectRoot, sourceDir });
  // packs: module paths, as createSimulator reads them (one loader); loadedPacks: already discovered packs (internal callers).
  const packs = loadedPacks ?? await discoverPacks({ project, portal, explicit: dataPacks, packs: packModules });
  const operationPortal = portal ? catalogue.withSolutionOperations(portal, await catalogue.importSolutionOperationSources(sources.scan.layers, portal.website)) : null;
  const description = await composeHostDescription({ sources, portal, operationPortal, packs, deploymentProfile, runtime, simulation: simulationSettings(simulation), projectRoot, env,
    config: { connections, secrets, providers, localServices, canvas, environmentVariables, dataverse, initial, connectorScripts } });
  try {
    return await description.preflight({ scenario, strict, env });
  } finally {
    await description.close();
  }
}
