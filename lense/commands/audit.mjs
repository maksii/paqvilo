import { loadCatalogue, loadConfig } from '../config.mjs';
import { PortalModel } from '../portal-model.mjs';
import { auditResources } from '../resource-audit.mjs';

export default async function audit(_cfg, args) {
  const catalogue = loadCatalogue(args);
  const reports = [];
  for (const site of args.all ? Object.keys(catalogue.sites) : [args.site]) {
    try {
      const cfg = await loadConfig({ ...args, site, ...(args.all ? { env: catalogue.sites[site].defaultEnv ?? Object.keys(catalogue.sites[site].environments)[0] } : {}) });
      reports.push({ site: cfg.siteName, ...auditResources(await PortalModel.create(cfg.sourceDir), cfg.site) });
    } catch (err) {
      reports.push({ site: site ?? catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite, coverage: { inventoryComplete: false, complete: false, runtimeVerified: false }, errors: [{ reason: err.message }], resources: [] });
    }
  }
  const complete = reports.length > 0 && reports.every((report) => report.coverage.complete);
  const ok = reports.length > 0 && reports.every((report) => report.coverage.inventoryComplete) && (!args.strict || complete);
  const report = { schemaVersion: 1, command: 'audit', ok, offline: true, writesFiles: false, complete, reports };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('Independent offline resource inventory (mapping does not prove browser coverage)');
    for (const item of reports) {
      console.log(`\n${item.site}: ${item.totals ? `${item.totals.mapped}/${item.totals.resources} mapped, ${item.totals.blocked} blocked, ${item.totals.gaps} gaps, ${item.totals.inactive} inactive, ${item.totals.deployment} deployment metadata, ${item.totals.disabled} disabled` : 'inventory failed'}`);
      for (const resource of item.resources.filter((entry) => entry.status === 'gap' || entry.status === 'blocked')) console.log(`  ${resource.status.toUpperCase()}: ${resource.id}: ${resource.reason}`);
      for (const error of item.errors) console.log(`  ERROR: ${error.relativePath ?? ''}: ${error.reason}`);
      for (const diagnostic of item.diagnostics ?? []) console.log(`  WARNING: ${diagnostic.relativePath}: ${diagnostic.reason}`);
    }
  }
  return ok ? 0 : 1;
}
