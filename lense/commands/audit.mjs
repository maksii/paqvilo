import { loadCatalogue, loadConfig, mirageOnlySite } from '../config.mjs';
import { PortalModel } from '../portal-model.mjs';
import { auditResources } from '../resource-audit.mjs';

// A Mirage-only site has no portal export to audit; under --all it is reported as skipped when the catalogue has a portal.
function skippedReport(site) {
  return {
    site,
    skipped: {
      code: 'mirage_only_site',
      reason: 'Mirage-only site without a portal export: not a Lense target, so it is not audited',
    },
    errors: [],
    resources: [],
  };
}

async function auditSite(args, catalogue, site) {
  try {
    const cfg = await loadConfig({
      ...args,
      site,
      ...(args.all
        ? { env: catalogue.sites[site].defaultEnv ?? Object.keys(catalogue.sites[site].environments)[0] }
        : {}),
    });
    return { site: cfg.siteName, ...auditResources(await PortalModel.create(cfg.sourceDir), cfg.site) };
  } catch (err) {
    return {
      site: site ?? catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite,
      coverage: { inventoryComplete: false, complete: false, runtimeVerified: false },
      errors: [{ reason: err.message }],
      resources: [],
    };
  }
}

function printReports(reports) {
  console.log('Independent offline resource inventory (mapping does not prove browser coverage)');
  for (const item of reports) {
    if (item.skipped) {
      console.log(`\n${item.site}: skipped (${item.skipped.reason})`);
      continue;
    }
    let summary = 'inventory failed';
    if (item.totals)
      summary = `${item.totals.mapped}/${item.totals.resources} mapped, ${item.totals.blocked} blocked, ${item.totals.gaps} gaps, ${item.totals.inactive} inactive, ${item.totals.deployment} deployment metadata, ${item.totals.disabled} disabled`;
    console.log(`\n${item.site}: ${summary}`);
    for (const resource of item.resources.filter((entry) => entry.status === 'gap' || entry.status === 'blocked'))
      console.log(`  ${resource.status.toUpperCase()}: ${resource.id}: ${resource.reason}`);
    for (const error of item.errors) console.log(`  ERROR: ${error.relativePath ?? ''}: ${error.reason}`);
    for (const diagnostic of item.diagnostics ?? [])
      console.log(`  WARNING: ${diagnostic.relativePath}: ${diagnostic.reason}`);
  }
}

export default async function audit(_cfg, args) {
  const catalogue = loadCatalogue(args);
  const hasPortal = Object.values(catalogue.sites).some((site) => !mirageOnlySite(site));
  const reports = [];
  for (const site of args.all ? Object.keys(catalogue.sites) : [args.site]) {
    if (args.all && hasPortal && mirageOnlySite(catalogue.sites[site])) reports.push(skippedReport(site));
    else reports.push(await auditSite(args, catalogue, site));
  }
  const audited = reports.filter((report) => !report.skipped);
  const complete = audited.length > 0 && audited.every((report) => report.coverage.complete);
  const ok =
    audited.length > 0 && audited.every((report) => report.coverage.inventoryComplete) && (!args.strict || complete);
  const errors = reports.flatMap((report) => report.errors ?? []);
  if (args.strict && !complete) {
    const total = (key) => reports.reduce((sum, report) => sum + (report.totals?.[key] ?? 0), 0);
    errors.push({
      code: 'strict_failed',
      message: `Strict source audit failed: ${total('blocked')} blocked resources, ${total('gaps')} gaps and ${reports.reduce((sum, report) => sum + (report.diagnostics?.length ?? 0), 0)} diagnostics; inventory is incomplete or coverage needs attention.`,
      blocked: total('blocked'),
      gaps: total('gaps'),
    });
  }
  const report = { schemaVersion: 1, command: 'audit', ok, offline: true, writesFiles: [], errors, complete, reports };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReports(reports);
  return ok ? 0 : 1;
}
