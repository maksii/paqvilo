// Offline readiness checks. This command never launches a browser or requests a portal URL.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadCatalogue, loadConfig, mirageOnlySite, TOOL_ROOT } from '../config.mjs';
import { OverlaySession } from '../session.mjs';
import { mirageReadiness, observedText } from './mirage.mjs';
import { duplicateYamlDiagnostics } from '../yaml-diagnostics.mjs';
import { scaffoldWarning } from '../project-check.mjs';
import YAML from 'yaml';
import { jsonErrorLocation } from '../../mirage/lib/json-diagnostics.mjs';
import { analyzeProject, validateAnalysisPolicy } from '../analysis/index.mjs';
import { printAnalysis, analysisFailure } from './analyze.mjs';
import { configuredAnalysisRoots } from '../analysis/project.mjs';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function addProfileDiagnostic(diagnostics, sourceDir, file, bound, code, line = 1, column = 1) {
  diagnostics.push({
    code,
    file: path.relative(sourceDir, file).replaceAll('\\', '/'),
    line,
    column,
    bound: bound.has(path.resolve(file)),
    severity: 'warning',
    message: `Invalid deployment profile syntax (${code}).`,
  });
}

function inspectProfileFile(file, sourceDir, bound, diagnostics) {
  const source = fs.readFileSync(file, 'utf8');
  if (/\.json$/i.test(file)) {
    try {
      JSON.parse(source);
    } catch {
      const { line, column } = jsonErrorLocation(source);
      addProfileDiagnostic(diagnostics, sourceDir, file, bound, 'JSON_SYNTAX_ERROR', line, column);
    }
    return;
  }
  const lines = new YAML.LineCounter(),
    document = YAML.parseDocument(source, { lineCounter: lines });
  for (const error of document.errors) {
    const position = lines.linePos(error.pos[0]);
    addProfileDiagnostic(diagnostics, sourceDir, file, bound, error.code, position.line, position.col);
  }
}

function inspectProfileDirectory(current, sourceDir, bound, diagnostics, pending, ignored) {
  const { directory, inProfiles } = current;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ignored.has(entry.name.toLowerCase())) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      pending.push({ directory: file, inProfiles: inProfiles || entry.name.toLowerCase() === 'deployment-profiles' });
      continue;
    }
    if (!inProfiles || !entry.isFile() || !/\.(?:json|ya?ml)$/i.test(entry.name)) continue;
    inspectProfileFile(file, sourceDir, bound, diagnostics);
  }
}

function inspectRouteFiles(cfg, errors) {
  for (const rule of cfg.site.routes) {
    const target = rule.file ?? rule.dir;
    if (!target) continue;
    const file = path.resolve(cfg.sourceDir, target);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      /* diagnostic below */
    }
    if (!stat || (rule.file ? !stat.isFile() : !stat.isDirectory()))
      errors.push(`Route ${rule.url}: ${rule.file ? 'file' : 'directory'} does not exist: ${file}`);
  }
}

/** Optional syntax lint of exported deployment profiles, independent of profile selection. */
export function inspectExportProfiles(sourceDir, deploymentProfiles = {}) {
  const profiles = deploymentProfiles.profiles ?? {};
  const boundFiles = Array.isArray(profiles)
    ? profiles.flatMap((profile) => profile.files.map((entry) => entry.file))
    : Object.values(profiles).flatMap((sources) => Object.values(sources).flat());
  const bound = new Set(boundFiles.map((file) => path.resolve(file)));
  const diagnostics = [],
    pending = [{ directory: sourceDir, inProfiles: false }];
  const ignored = new Set(['.git', '.portalconfig', '.paqvilo', 'node_modules']);
  while (pending.length) {
    inspectProfileDirectory(pending.pop(), sourceDir, bound, diagnostics, pending, ignored);
  }
  return diagnostics.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line || a.column - b.column);
}

/** Inspect exported source YAML without walking local state or dependency trees. */
export function inspectSourceYaml(sourceDir) {
  const ignored = new Set(['.git', '.portalconfig', '.paqvilo', 'node_modules', 'deployment-profiles']);
  const diagnostics = [],
    pending = [sourceDir];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignored.has(entry.name.toLowerCase())) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name))
        diagnostics.push(...duplicateYamlDiagnostics(fs.readFileSync(file, 'utf8'), file));
    }
  }
  return diagnostics;
}

function addSourceReportDiagnostics(report, cfg, args) {
  report.sourceDiagnostics = inspectSourceYaml(cfg.sourceDir);
  report.sourcesReady = report.sourceDiagnostics.length === 0;
  for (const item of report.sourceDiagnostics)
    (args.mirage ? report.errors : report.warnings).push(
      `Sources: ${path.relative(cfg.sourceDir, item.file).replaceAll('\\', '/')}:${item.line}: ${item.message}`,
    );
  report.ready = report.errors.length === 0;
}

function addProfileReportDiagnostics(report, cfg) {
  report.profileDiagnostics = inspectExportProfiles(cfg.sourceDir, report.mirage.deploymentProfiles);
  for (const item of report.profileDiagnostics)
    report.warnings.push(
      `Profiles: ${item.file}:${item.line}:${item.column}: ${item.message}${item.bound ? '' : ' (unbound)'}`,
    );
}

function addDuplicatePortWarnings(reports) {
  // mirage dev with portals=all runs one Mirage per site: each needs its own port.
  const sitesByPort = new Map();
  for (const item of reports) {
    const port = item.mirage?.port?.port;
    if (port) sitesByPort.set(port, [...(sitesByPort.get(port) ?? []), item.site]);
  }
  for (const item of reports) {
    const port = item.mirage?.port?.port;
    const others = (sitesByPort.get(port) ?? []).filter((site) => site !== item.site);
    if (port && others.length)
      item.mirage.warnings.push(
        `Mirage port ${port} is also configured for ${others.join(', ')}; mirage dev with portals=all needs a distinct port per site (sites.<id>.mirage.port, or 0 for any free port).`,
      );
  }
}

function assembleDoctorReport(args, reports, catalogue) {
  const ready = reports.length > 0 && reports.every((r) => r.ready);
  const warning = scaffoldWarning(catalogue.configDir);
  const report = {
    offline: true,
    ready,
    checks: [
      ...(args.mirage ? ['lense', 'sources', 'mirage'] : ['lense']),
      ...(args['fail-on'] && args['fail-on'] !== 'none' ? ['analysis'] : []),
    ],
    reports,
    ...(warning ? { warnings: [warning] } : {}),
  };
  return { report, catalogue };
}

function doctorSiteConfigArgs(args, catalogue, site) {
  return {
    ...args,
    site,
    ...(args.all
      ? { env: catalogue.sites[site].defaultEnv ?? Object.keys(catalogue.sites[site].environments)[0] }
      : {}),
  };
}

function standaloneSiteReport(name, cfg, mirage, args) {
  return {
    site: name,
    environment: null,
    runtime: cfg.runtime.kind,
    errors: [],
    warnings: [],
    lenseReady: true,
    sourcesReady: true,
    mirage,
    ready: !args.mirage || mirage.ready,
  };
}

function addProfileDiagnosticsWhenRequested(report, cfg, args) {
  if (args['lint-profiles']) addProfileReportDiagnostics(report, cfg);
}

function applyMirageReadinessGate(report, args) {
  if (args.mirage) report.ready = report.ready && report.mirage.ready;
}

export function inspectCheckout(cfg, { started = performance.now(), session = new OverlaySession(cfg) } = {}) {
  const errors = [];
  const warnings = [...session.model.warnings];
  if (!session.baseline.available && session.baseline.unborn && cfg.site.scope !== 'changed') {
    warnings.push(
      `Baseline "${cfg.site.markup.baseline}" is skipped: the repository has no commits yet. Commit the sources to enable changed scope and markup patches.`,
    );
  } else if (!session.baseline.available) {
    const message = `Baseline "${cfg.site.markup.baseline}" is unavailable. Use an existing local commit/ref for changed scope and markup patches.`;
    (cfg.site.scope === 'changed' || cfg.site.markup.enabled ? errors : warnings).push(message);
  }
  inspectRouteFiles(cfg, errors);
  return {
    site: cfg.siteName,
    environment: cfg.envName,
    source: cfg.sourceDir,
    format: session.model.format,
    scope: cfg.site.scope,
    baseline: {
      requested: cfg.site.markup.baseline,
      commit: session.baseline.available ? session.baseline.commit : null,
    },
    counts: {
      pages: session.model.pages.size,
      webFiles: session.model.webFiles.length,
      mappedWebFiles: session.model.webFileByUrl.size,
      inlineSources: session.model.inlineSources.length,
      markupPatches: session.rewriter.patches.length,
    },
    needsDeploy: session.rewriter.unsupported,
    errors,
    warnings,
    elapsedMs: Math.round(performance.now() - started),
    ready: errors.length === 0,
  };
}

async function standaloneDoctorReport(catalogue, name, args, dependencies, failOn) {
  const cfg = (await import('../standalone-mirage.mjs')).standaloneCatalogueConfiguration(catalogue, name, {});
  const mirage = await mirageReadiness(cfg, { dependencies });
  const report = standaloneSiteReport(name, cfg, mirage, args);
  addProjectAnalysis(report, cfg, failOn);
  return report;
}

async function portalDoctorReport(cfg, args, dependencies, failOn) {
  const started = performance.now();
  const report = inspectCheckout(cfg, { started, session: await OverlaySession.create(cfg) });
  report.lenseReady = report.ready;
  addSourceReportDiagnostics(report, cfg, args);
  addProjectAnalysis(report, cfg, failOn);
  report.mirage = await mirageReadiness(cfg, { dependencies });
  addProfileDiagnosticsWhenRequested(report, cfg, args);
  applyMirageReadinessGate(report, args);
  return report;
}

function addProjectAnalysis(report, cfg, failOn) {
  try {
    report.analysis = analyzeProject(cfg.sourceDir, { failOn, sourceRoots: configuredAnalysisRoots(cfg) });
    report.analysisReady = report.analysis.ready;
    if (!report.analysis.ready) report.errors.push(analysisFailure(report.analysis));
    report.ready = report.ready && report.analysis.ready;
  } catch {
    report.analysisReady = false;
    const error = {
      code: 'analysis_unavailable',
      message: 'Declared Power Platform sources or project metadata could not be inspected.',
    };
    if (failOn !== 'none') {
      report.ready = false;
      report.errors.push(error);
    } else report.warnings.push(error.message);
  }
}

async function doctorSiteReport(catalogue, site, args, processEnv, dependencies, failOn) {
  try {
    const name = site ?? catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite;
    // Standalone runtimes have no portal export; only their Mirage checks apply.
    if (mirageOnlySite(catalogue.sites[name]))
      return await standaloneDoctorReport(catalogue, name, args, dependencies, failOn);
    const cfg = await loadConfig(doctorSiteConfigArgs(args, catalogue, site), processEnv);
    return await portalDoctorReport(cfg, args, dependencies, failOn);
  } catch (err) {
    return {
      site: site ?? catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite,
      ready: false,
      errors: [{ code: err.code ?? 'check_failed', message: err.message }],
      warnings: [],
    };
  }
}

export async function collectDoctor(args, { processEnv = process.env } = {}) {
  const failOn = validateAnalysisPolicy(args['fail-on'] ?? 'none');
  const catalogue = loadCatalogue(args, processEnv);
  if (args.site && !Object.hasOwn(catalogue.sites, args.site))
    throw Object.assign(
      new Error(`Unknown site "${args.site}". Known sites: ${Object.keys(catalogue.sites).join(', ')}`),
      { code: 'invalid_argument' },
    );
  const reports = [];
  const names = args.all ? Object.keys(catalogue.sites) : [args.site];
  // Opt in to gating on Mirage while preserving the Lense-only default verdict.
  const { dependencyReadiness } = await import('../../scripts/ensure-dependencies.mjs');
  const dependencies = dependencyReadiness(TOOL_ROOT);
  for (const site of names)
    reports.push(await doctorSiteReport(catalogue, site, args, processEnv, dependencies, failOn));
  addDuplicatePortWarnings(reports);
  return assembleDoctorReport(args, reports, catalogue);
}

function describeDeploymentProfile(profile, configDir) {
  const files = profile.files
    .map((file) => {
      const status = file.exists ? 'found' : 'missing';
      return `${file.section} ${path.relative(configDir, file.file)}: ${status}`;
    })
    .join(', ');
  return `${profile.id} ${profile.valid ? 'valid' : 'invalid'} (${files})`;
}

function printDeploymentProfiles(mirage, catalogue) {
  if (!mirage.deploymentProfiles?.profiles.length) return;
  console.log(
    `  deployment profiles: default ${mirage.deploymentProfiles.default ?? 'none'}; ${mirage.deploymentProfiles.profiles.map((profile) => describeDeploymentProfile(profile, catalogue.configDir)).join('; ')}`,
  );
}

function printMirageStatus(mirage) {
  if (mirage.platform) console.log(`  platform defaults (catalogue): ${JSON.stringify(mirage.platform)}`);
  const platformStyles =
    mirage.platformStyles?.mode === 'captured'
      ? `captured ${mirage.platformStyles.capturedAt} from ${mirage.platformStyles.origin}`
      : 'placeholder (local structural form rules)';
  console.log(`  platform stylesheets: ${platformStyles}`);
  if (mirage.localOverrides?.assets.length || Object.keys(mirage.localOverrides?.compat ?? {}).length)
    console.log(`  local-only overrides: ${JSON.stringify(mirage.localOverrides)}`);
  const roots = mirage.solutionRoots.roots;
  const projectState = mirage.project.configured ? `project ${mirage.project.file}` : 'no project file';
  const rootsOrder = roots.length > 1 ? `, ${mirage.solutionRoots.order ?? 'derived'} order` : '';
  let portState = ' in use';
  if (mirage.port.port === 0) portState = ' (any free port)';
  else if (mirage.port.available) portState = ' free';
  console.log(
    `  mirage ${mirage.ready ? 'ready' : 'NOT READY'}: dependencies ${mirage.dependencies.ready ? 'installed' : 'missing'}, ${projectState}, ${roots.length} Solution root(s) (${mirage.solutionRoots.source}${rootsOrder}), state folder ${mirage.stateDir.writable ? 'writable' : 'NOT writable'}, port ${mirage.port.port}${portState}`,
  );
  if (mirage.observed)
    console.log(
      `  mirage observed (${mirage.observedSource === 'project' ? 'project file' : 'catalogue'}): ${observedText(mirage.observed)}`,
    );
}

function printMirageDetails(mirage, catalogue) {
  printDeploymentProfiles(mirage, catalogue);
  printMirageStatus(mirage);
  for (const error of mirage.errors) console.log(`  MIRAGE ERROR: ${error}`);
  for (const warning of mirage.warnings) console.log(`  MIRAGE WARNING: ${warning}`);
}

function printDoctorItem(item, args, catalogue) {
  const environmentLabel = item.environment ? ` @ ${item.environment}` : '';
  let lenseState = 'NOT READY';
  if (item.runtime) lenseState = `not applicable (${item.runtime} Mirage site)`;
  else if (item.lenseReady) lenseState = 'ready';
  const sourcesState = item.sourcesReady ? 'ready' : 'NOT READY';
  const mirageState = item.mirage?.ready ? 'ready' : 'NOT READY';
  const mirageGate = args.mirage ? '' : ' (use --mirage to gate Sources and Mirage)';
  const mirageSummary = item.mirage
    ? ` · Lense ${lenseState} · Sources ${sourcesState} · Mirage ${mirageState}${mirageGate}`
    : '';
  console.log(`\n${item.ready ? 'READY' : 'ERROR'}  ${item.site}${environmentLabel}${mirageSummary}`);
  if (item.counts)
    console.log(
      `  ${item.format}: ${plural(item.counts.pages, 'page')}, ${item.counts.mappedWebFiles}/${plural(item.counts.webFiles, 'mapped web file')}, ${plural(item.counts.inlineSources, 'inline source')} (${item.elapsedMs} ms)`,
    );
  for (const error of item.errors) console.log(`  ERROR: ${error.message ?? error}`);
  for (const warning of item.warnings) console.log(`  WARNING: ${warning}`);
  for (const change of item.needsDeploy ?? []) console.log(`  NEEDS DEPLOY: ${change.rel}: ${change.reason}`);
  if (item.analysis) printAnalysis(item.analysis);
  if (item.analysisApplicable === false) console.log('  analysis: not applicable to this standalone runtime');
  const mirage = item.mirage;
  if (mirage) printMirageDetails(mirage, catalogue);
}

function printDoctorReport(report, catalogue, args) {
  console.log('Offline checkout diagnostics (no browser or portal requests)');
  const warning = report.warnings?.[0];
  if (warning) console.log(`WARNING: ${warning}`);
  for (const item of report.reports) printDoctorItem(item, args, catalogue);
}

export default async function doctor(_cfg, args) {
  const { report, catalogue } = await collectDoctor(args);
  const { ready } = report;
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printDoctorReport(report, catalogue, args);
  return ready ? 0 : 1;
}
