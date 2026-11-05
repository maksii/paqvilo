import { loadCatalogue, loadConfig, mirageOnlySite } from '../config.mjs';
import { analyzeProject, validateAnalysisPolicy } from '../analysis/index.mjs';

const displayPath = (value) =>
  JSON.stringify(value)
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
      (character) => String.raw`\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
    );

export function printAnalysis(analysis) {
  console.log(
    `  analysis: ${analysis.complete ? 'inventory complete' : 'INCOMPLETE'}, ${analysis.counts.error} errors, ${analysis.counts.warning} warnings, ${analysis.counts.hint} hints (fail on ${analysis.failOn})`,
  );
  for (const finding of analysis.findings) {
    const field = finding.field ? ` (${finding.field})` : '';
    console.log(
      `  ${finding.severity.toUpperCase()} [${finding.ruleId}] ${displayPath(finding.file)}:${finding.line}:${finding.column}${field}: ${finding.message}\n    ${finding.remediation}`,
    );
  }
  for (const skip of analysis.coverage.skipped) console.log(`  SKIPPED: ${displayPath(skip.file)}: ${skip.reason}`);
  if (analysis.coverage.findingsTruncated) console.log('  SKIPPED: finding limit reached; results are truncated.');
}

export function analysisFailure(analysis) {
  return {
    code: 'analysis_failed',
    message: `Static analysis ${analysis.complete ? 'reached the configured finding threshold' : 'is incomplete'} (fail on ${analysis.failOn}). Review findings and coverage.`,
  };
}

function analysisSiteArgs(catalogue, site, args) {
  return {
    ...args,
    site,
    ...(args.all
      ? { env: catalogue.sites[site].defaultEnv ?? Object.keys(catalogue.sites[site].environments)[0] }
      : {}),
  };
}

async function analyzeSiteReport(catalogue, site, args, failOn) {
  const name = site ?? catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite;
  try {
    if (mirageOnlySite(catalogue.sites[name])) throw new Error('unsupported source');
    const cfg = await loadConfig(analysisSiteArgs(catalogue, site, args));
    const analysis = analyzeProject(cfg.sourceDir, { failOn });
    return {
      site: cfg.siteName,
      analysis,
      ready: analysis.ready,
      errors: analysis.ready ? [] : [analysisFailure(analysis)],
    };
  } catch {
    return {
      site: name,
      ready: false,
      errors: [
        {
          code: 'analysis_unavailable',
          message:
            'Static portal analysis could not read the selected export or configuration. Check source paths, access and supported formats with doctor.',
        },
      ],
    };
  }
}

function printAnalyzeReport(reports) {
  console.log('Offline static source analysis (no live, rendered or authorization verification)');
  for (const item of reports) {
    console.log(`\n${item.site}: ${item.ready ? 'READY' : 'ERROR'}`);
    if (item.analysis) printAnalysis(item.analysis);
    for (const error of item.errors) console.log(`  ERROR: ${error.message}`);
  }
}

export default async function analyze(_cfg, args) {
  const failOn = validateAnalysisPolicy(args['fail-on'] ?? 'error');
  const catalogue = loadCatalogue(args);
  if (args.site && !Object.hasOwn(catalogue.sites, args.site))
    throw Object.assign(new Error('Unknown site selected for static analysis.'), { code: 'invalid_argument' });
  const reports = [];
  for (const site of args.all ? Object.keys(catalogue.sites) : [args.site])
    reports.push(await analyzeSiteReport(catalogue, site, args, failOn));
  const ok = reports.length > 0 && reports.every((report) => report.ready);
  const report = {
    schemaVersion: 1,
    command: 'analyze',
    ok,
    offline: true,
    writesFiles: [],
    errors: reports.flatMap((item) => item.errors),
    reports,
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printAnalyzeReport(reports);
  return ok ? 0 : 1;
}
