// Offline readiness checks. This command never launches a browser or requests a portal URL.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadCatalogue, loadConfig, TOOL_ROOT } from '../config.mjs';
import { OverlaySession } from '../session.mjs';
import { mirageReadiness, observedText } from './mirage.mjs';

export function inspectCheckout(cfg, { started = performance.now(), session = new OverlaySession(cfg) } = {}) {
  const errors = [];
  const warnings = [...session.model.warnings];
  if (!session.baseline.available) {
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

export default async function doctor(_cfg, args) {
  const catalogue = loadCatalogue(args);
  const reports = [];
  const names = args.all ? Object.keys(catalogue.sites) : [args.site];
  // Mirage readiness is reported beside the overlay checks; it does not change their verdict.
  const { dependencyReadiness } = await import('../../scripts/ensure-dependencies.mjs');
  const dependencies = dependencyReadiness(TOOL_ROOT);
  for (const site of names) {
    try {
      const cfg = await loadConfig({ ...args, site, ...(args.all ? { env: catalogue.sites[site].defaultEnv ?? Object.keys(catalogue.sites[site].environments)[0] } : {}) });
      const started = performance.now();
      const report = inspectCheckout(cfg, { started, session: await OverlaySession.create(cfg) });
      report.mirage = await mirageReadiness(cfg, { dependencies });
      reports.push(report);
    } catch (err) {
      reports.push({ site: site ?? catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite, ready: false, errors: [err.message], warnings: [] });
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
  const report = { offline: true, ready, reports };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Offline checkout diagnostics (no browser or portal requests)');
    for (const item of reports) {
      console.log(`\n${item.ready ? 'READY' : 'ERROR'}  ${item.site}${item.environment ? ` @ ${item.environment}` : ''}`);
      if (item.counts) console.log(`  ${item.format}: ${item.counts.pages} pages, ${item.counts.mappedWebFiles}/${item.counts.webFiles} mapped web files, ${item.counts.inlineSources} inline sources (${item.elapsedMs} ms)`);
      for (const error of item.errors) console.log(`  ERROR: ${error}`);
      for (const warning of item.warnings) console.log(`  WARNING: ${warning}`);
      for (const change of item.needsDeploy ?? []) console.log(`  NEEDS DEPLOY: ${change.rel}: ${change.reason}`);
      const mirage = item.mirage;
      if (mirage) {
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
