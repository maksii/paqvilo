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

/** Optional syntax lint of exported deployment profiles, independent of profile selection. */
export function inspectExportProfiles(sourceDir, deploymentProfiles = {}) {
  const profiles = deploymentProfiles.profiles ?? {};
  const boundFiles = Array.isArray(profiles) ? profiles.flatMap(profile => profile.files.map(entry => entry.file)) : Object.values(profiles).flatMap(sources => Object.values(sources).flat());
  const bound = new Set(boundFiles.map(file => path.resolve(file)));
  const diagnostics = [], pending = [{ directory: sourceDir, inProfiles: false }];
  const ignored = new Set(['.git', '.portalconfig', '.paqvilo', 'node_modules']);
  while (pending.length) {
    const { directory, inProfiles } = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignored.has(entry.name.toLowerCase())) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { pending.push({ directory: file, inProfiles: inProfiles || entry.name.toLowerCase() === 'deployment-profiles' }); continue; }
      if (!inProfiles || !entry.isFile() || !/\.(?:json|ya?ml)$/i.test(entry.name)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const add = (code, line = 1, column = 1) => diagnostics.push({ code, file: path.relative(sourceDir, file).replaceAll('\\', '/'), line, column, bound: bound.has(path.resolve(file)), severity: 'warning', message: `Invalid deployment profile syntax (${code}).` });
      if (/\.json$/i.test(file)) {
        try { JSON.parse(source); } catch {
          const { line, column } = jsonErrorLocation(source);
          add('JSON_SYNTAX_ERROR', line, column);
        }
      } else {
        const lines = new YAML.LineCounter(), document = YAML.parseDocument(source, { lineCounter: lines });
        for (const error of document.errors) { const position = lines.linePos(error.pos[0]); add(error.code, position.line, position.col); }
      }
    }
  }
  return diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

/** Inspect exported source YAML without walking local state or dependency trees. */
export function inspectSourceYaml(sourceDir) {
  const ignored=new Set(['.git','.portalconfig','.paqvilo','node_modules','deployment-profiles']);
  const diagnostics=[],pending=[sourceDir];
  while(pending.length){
    const directory=pending.pop();
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      if(entry.isSymbolicLink()||ignored.has(entry.name.toLowerCase()))continue;
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())pending.push(file);
      else if(entry.isFile()&&/\.ya?ml$/i.test(entry.name))diagnostics.push(...duplicateYamlDiagnostics(fs.readFileSync(file,'utf8'),file));
    }
  }
  return diagnostics;
}

export function inspectCheckout(cfg, { started = performance.now(), session = new OverlaySession(cfg) } = {}) {
  const errors = [];
  const warnings = [...session.model.warnings];
  if (!session.baseline.available && session.baseline.unborn && cfg.site.scope !== 'changed') {
    warnings.push(`Baseline "${cfg.site.markup.baseline}" is skipped: the repository has no commits yet. Commit the sources to enable changed scope and markup patches.`);
  } else if (!session.baseline.available) {
    const message = `Baseline "${cfg.site.markup.baseline}" is unavailable. Use an existing local commit/ref for changed scope and markup patches.`;
    (cfg.site.scope === 'changed' || cfg.site.markup.enabled ? errors : warnings).push(message);
  }
  for (const rule of cfg.site.routes) {
    const target = rule.file ?? rule.dir;
    if (!target) continue;
    const file = path.resolve(cfg.sourceDir, target);
    let stat;
    try { stat = fs.statSync(file); } catch { /* diagnostic below */ }
    if (!stat || (rule.file ? !stat.isFile() : !stat.isDirectory())) errors.push(`Route ${rule.url}: ${rule.file ? 'file' : 'directory'} does not exist: ${file}`);
  }
  return {
    site: cfg.siteName,
    environment: cfg.envName,
    source: cfg.sourceDir,
    format: session.model.format,
    scope: cfg.site.scope,
    baseline: { requested: cfg.site.markup.baseline, commit: session.baseline.available ? session.baseline.commit : null },
    counts: { pages: session.model.pages.size, webFiles: session.model.webFiles.length, mappedWebFiles: session.model.webFileByUrl.size, inlineSources: session.model.inlineSources.length, markupPatches: session.rewriter.patches.length },
    needsDeploy: session.rewriter.unsupported,
    errors,
    warnings,
    elapsedMs: Math.round(performance.now() - started),
    ready: errors.length === 0,
  };
}

export async function collectDoctor(args, { processEnv = process.env } = {}) {
  const catalogue = loadCatalogue(args, processEnv);
  if (args.site && !Object.hasOwn(catalogue.sites, args.site)) throw Object.assign(new Error(`Unknown site "${args.site}". Known sites: ${Object.keys(catalogue.sites).join(', ')}`), {code:'invalid_argument'});
  const reports = [];
  const names = args.all ? Object.keys(catalogue.sites) : [args.site];
  // Opt in to gating on Mirage while preserving the Lense-only default verdict.
  const { dependencyReadiness } = await import('../../scripts/ensure-dependencies.mjs');
  const dependencies = dependencyReadiness(TOOL_ROOT);
  for (const site of names) {
    try {
      // A Mirage-only site (standalone runtime, no portal export, no environment): only the Mirage checks apply.
      const name = site ?? catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite;
      if (mirageOnlySite(catalogue.sites[name])) {
        const cfg = (await import('../standalone-mirage.mjs')).standaloneCatalogueConfiguration(catalogue, name, {});
        const mirage = await mirageReadiness(cfg, { dependencies });
        reports.push({ site: name, environment: null, runtime: cfg.runtime.kind, errors: [], warnings: [], lenseReady: true, sourcesReady: true,
          mirage, ready: !args.mirage || mirage.ready });
        continue;
      }
      const cfg = await loadConfig({ ...args, site, ...(args.all ? { env: catalogue.sites[site].defaultEnv ?? Object.keys(catalogue.sites[site].environments)[0] } : {}) }, processEnv);
      const started = performance.now();
      const report = inspectCheckout(cfg, { started, session: await OverlaySession.create(cfg) });
      report.lenseReady = report.ready;
      report.sourceDiagnostics=inspectSourceYaml(cfg.sourceDir);
      report.sourcesReady=report.sourceDiagnostics.length===0;
      for(const item of report.sourceDiagnostics)(args.mirage?report.errors:report.warnings).push(`Sources: ${path.relative(cfg.sourceDir,item.file).replaceAll('\\','/')}:${item.line}: ${item.message}`);
      report.ready=report.errors.length===0;
      report.mirage = await mirageReadiness(cfg, { dependencies });
      if (args['lint-profiles']) {
        report.profileDiagnostics = inspectExportProfiles(cfg.sourceDir, report.mirage.deploymentProfiles);
        for (const item of report.profileDiagnostics) report.warnings.push(`Profiles: ${item.file}:${item.line}:${item.column}: ${item.message}${item.bound ? '' : ' (unbound)'}`);
      }
      if (args.mirage) report.ready = report.ready && report.mirage.ready;
      reports.push(report);
    } catch (err) {
      reports.push({ site: site ?? catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite, ready: false, errors: [{code:err.code??'check_failed',message:err.message}], warnings: [] });
    }
  }
  // mirage dev with portals=all runs one Mirage per site: each needs its own port.
  const sitesByPort = new Map();
  for (const item of reports) {
    const port = item.mirage?.port?.port;
    if (port) sitesByPort.set(port, [...(sitesByPort.get(port) ?? []), item.site]);
  }
  for (const item of reports) {
    const port = item.mirage?.port?.port;
    const others = (sitesByPort.get(port) ?? []).filter((site) => site !== item.site);
    if (port && others.length) item.mirage.warnings.push(`Mirage port ${port} is also configured for ${others.join(', ')}; mirage dev with portals=all needs a distinct port per site (sites.<id>.mirage.port, or 0 for any free port).`);
  }
  const ready = reports.length > 0 && reports.every((r) => r.ready);
  const warning = scaffoldWarning(catalogue.configDir);
  const report = { offline: true, ready, checks: args.mirage ? ['lense', 'sources', 'mirage'] : ['lense'], reports, ...(warning ? { warnings: [warning] } : {}) };
  return { report, catalogue };
}

export default async function doctor(_cfg, args) {
  const { report, catalogue } = await collectDoctor(args);
  const { ready, reports } = report;
  const warning = report.warnings?.[0];
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Offline checkout diagnostics (no browser or portal requests)');
    if (warning) console.log(`WARNING: ${warning}`);
    for (const item of reports) {
      console.log(`\n${item.ready ? 'READY' : 'ERROR'}  ${item.site}${item.environment ? ` @ ${item.environment}` : ''}${item.mirage ? ` · Lense ${item.runtime ? `not applicable (${item.runtime} Mirage site)` : item.lenseReady ? 'ready' : 'NOT READY'} · Sources ${item.sourcesReady ? 'ready' : 'NOT READY'} · Mirage ${item.mirage.ready ? 'ready' : 'NOT READY'}${args.mirage ? '' : ' (use --mirage to gate Sources and Mirage)'}` : ''}`);
      if (item.counts) console.log(`  ${item.format}: ${item.counts.pages} pages, ${item.counts.mappedWebFiles}/${item.counts.webFiles} mapped web files, ${item.counts.inlineSources} inline sources (${item.elapsedMs} ms)`);
      for (const error of item.errors) console.log(`  ERROR: ${error.message ?? error}`);
      for (const warning of item.warnings) console.log(`  WARNING: ${warning}`);
      for (const change of item.needsDeploy ?? []) console.log(`  NEEDS DEPLOY: ${change.rel}: ${change.reason}`);
      const mirage = item.mirage;
      if (mirage) {
        if(mirage.deploymentProfiles?.profiles.length)console.log(`  deployment profiles: default ${mirage.deploymentProfiles.default ?? 'none'}; ${mirage.deploymentProfiles.profiles.map(profile=>`${profile.id} ${profile.valid?'valid':'invalid'} (${profile.files.map(file=>`${file.section} ${path.relative(catalogue.configDir, file.file)}: ${file.exists?'found':'missing'}`).join(', ')})`).join('; ')}`);
        if(mirage.platform)console.log(`  platform defaults (catalogue): ${JSON.stringify(mirage.platform)}`);
        console.log(`  platform stylesheets: ${mirage.platformStyles?.mode === 'captured' ? `captured ${mirage.platformStyles.capturedAt} from ${mirage.platformStyles.origin}` : 'placeholder (local structural form rules)'}`);
        if (mirage.localOverrides?.assets.length || Object.keys(mirage.localOverrides?.compat ?? {}).length) console.log(`  local-only overrides: ${JSON.stringify(mirage.localOverrides)}`);
        const roots = mirage.solutionRoots.roots;
        console.log(`  mirage ${mirage.ready ? 'ready' : 'NOT READY'}: dependencies ${mirage.dependencies.ready ? 'installed' : 'missing'}, ${mirage.project.configured ? `project ${mirage.project.file}` : 'no project file'}, ${roots.length} Solution root(s) (${mirage.solutionRoots.source}${roots.length > 1 ? `, ${mirage.solutionRoots.order ?? 'derived'} order` : ''}), state folder ${mirage.stateDir.writable ? 'writable' : 'NOT writable'}, port ${mirage.port.port}${mirage.port.port === 0 ? ' (any free port)' : mirage.port.available ? ' free' : ' in use'}`);
        if (mirage.observed) console.log(`  mirage observed (${mirage.observedSource === 'project' ? 'project file' : 'catalogue'}): ${observedText(mirage.observed)}`);
        for (const error of mirage.errors) console.log(`  MIRAGE ERROR: ${error}`);
        for (const warning of mirage.warnings) console.log(`  MIRAGE WARNING: ${warning}`);
      }
    }
  }
  return ready ? 0 : 1;
}
