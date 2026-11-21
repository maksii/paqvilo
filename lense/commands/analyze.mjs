import { CONFIGURATION_ERROR_CODES, loadCatalogue, loadConfig, mirageOnlySite } from '../config.mjs';
import { analyzeProject, validateAnalysisPolicy } from '../analysis/index.mjs';
import { analysisLabelPath, analysisLabelRoots } from '../analysis/inventory.mjs';
import { configuredAnalysisRoots } from '../analysis/project.mjs';
import { standaloneCatalogueConfiguration } from '../standalone-mirage.mjs';
import path from 'node:path';
import { paqviloCommand } from '../command-hint.mjs';

const displayPath = (value) =>
  JSON.stringify(value)
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
      (character) => String.raw`\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
    );

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Runs the analysis for a configuration; the label roots come back beside it for the text report. */
export function analyzeConfigured(cfg, failOn) {
  const sourceRoots = configuredAnalysisRoots(cfg);
  const analysis = analyzeProject(cfg.sourceDir, { failOn, sourceRoots });
  return { analysis, labelRoots: analysisLabelRoots(sourceRoots) };
}

// Label roots name absolute paths for the text report only: non-enumerable, so JSON.stringify leaves them out.
export function withLabelRoots(item, labelRoots) {
  return Object.defineProperty(item, 'labelRoots', { value: labelRoots, enumerable: false });
}

// A label becomes the file's path relative to the working directory, so a terminal can open it. A label that names
// only a root, or the whole project ('.'), keeps its own text.
function shownLabel(labelRoots, label) {
  if (label === '.' || labelRoots.some((root) => root.id === label)) return label;
  const absolute = analysisLabelPath(labelRoots, label);
  if (!absolute) return label;
  const member = label.includes('!/') ? label.slice(label.indexOf('!/')) : '';
  return path.relative(process.cwd(), absolute).replaceAll('\\', '/') + member;
}

// Every line that names a file (finding, SKIPPED, NOT INSPECTED) prints it through this one helper.
const fileText = (labelRoots) => (label) => displayPath(shownLabel(labelRoots, label));

// Prints each skipped file once per reason, however many coverage entries name it.
function skipReporter(shown) {
  const reported = new Set();
  return (skip) => {
    const key = JSON.stringify([skip.file, skip.reason]);
    if (reported.has(key)) return;
    reported.add(key);
    console.log(`  SKIPPED: ${shown(skip.file)}: ${skip.reason}`);
  };
}

function printFinding(finding, shown) {
  const field = finding.field ? ` (${finding.field})` : '';
  console.log(
    `  ${finding.severity.toUpperCase()} [${finding.ruleId}] ${shown(finding.file)}:${finding.line}:${finding.column}${field}: ${finding.message}\n    ${finding.remediation}`,
  );
}

function printDomain(domain, shown, skipLine) {
  if (domain.recognized > 0 || domain.files > 0)
    console.log(`  ${domain.domain}: ${domain.status} (${domain.recognized} recognized inputs)`);
  for (const skip of domain.skipped ?? []) skipLine(skip);
  for (const item of domain.superseded ?? []) {
    const source = item.source === '.' ? '.' : shown(item.source);
    console.log(`  NOT INSPECTED: ${shown(item.file)}: packed copy of ${source}, whose source is analysed`);
  }
}

export function printAnalysis(analysis, labelRoots) {
  console.log(
    `  analysis: ${analysis.complete ? 'inventory complete' : 'INCOMPLETE'}, ${plural(analysis.counts.error, 'error')}, ${plural(analysis.counts.warning, 'warning')}, ${plural(analysis.counts.hint, 'hint')} (fail on ${analysis.failOn})`,
  );
  const shown = fileText(labelRoots);
  for (const finding of analysis.findings) printFinding(finding, shown);
  const skipLine = skipReporter(shown);
  for (const skip of analysis.coverage.skipped) skipLine(skip);
  if (analysis.coverage.findingsTruncated) console.log('  SKIPPED: finding limit reached; results are truncated.');
  for (const domain of analysis.coverage.domains) printDomain(domain, shown, skipLine);
  console.log(
    '  Native builds, host/device tests, connector authorization and tenant/process evidence are separate checks; use --json for operation requirements.',
  );
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
    const cfg = mirageOnlySite(catalogue.sites[name])
      ? standaloneCatalogueConfiguration(catalogue, name, {})
      : await loadConfig(analysisSiteArgs(catalogue, site, args));
    if (args.project) cfg.mirageConfig.project = path.resolve(args.project);
    const { analysis, labelRoots } = analyzeConfigured(cfg, failOn);
    return withLabelRoots(
      {
        site: cfg.siteName,
        analysis,
        ready: analysis.ready,
        errors: analysis.ready ? [] : [analysisFailure(analysis)],
      },
      labelRoots,
    );
  } catch (error) {
    // Configuration and source-layout errors name their own problem; anything else is a failure of the command.
    if (!CONFIGURATION_ERROR_CODES.has(error?.code)) throw error;
    return { site: name, ready: false, errors: [{ code: error.code, message: displayPath(error.message) }] };
  }
}

function printAnalyzeReport(reports) {
  console.log('Offline Power Platform source analysis (no native build, live, rendered or authorization verification)');
  for (const item of reports) {
    console.log(`\n${item.site}: ${item.analysis ? item.analysis.verdict.toUpperCase() : 'ERROR'}`);
    if (item.analysis) printAnalysis(item.analysis, item.labelRoots);
    for (const error of item.errors) console.log(`  ERROR: ${error.message}`);
  }
}

function localAnalysisReport(args, failOn) {
  const projectFile = args.project ? path.resolve(args.project) : null;
  const cfg = {
    sourceDir: args.source ? path.resolve(args.source) : null,
    analysisSourceKind: 'source',
    analysisWholeProject: Boolean(projectFile),
    configDir: projectFile ? path.dirname(projectFile) : process.cwd(),
    mirageConfig: { project: projectFile },
  };
  const { analysis, labelRoots } = analyzeConfigured(cfg, failOn);
  return withLabelRoots(
    {
      site: 'local-project',
      analysis,
      ready: analysis.ready,
      errors: analysis.ready ? [] : [analysisFailure(analysis)],
    },
    labelRoots,
  );
}

// Checked before any source is read, with the same message lense doctor gives for an unknown environment.
function checkEnvironmentOption(catalogue, args) {
  if (args.all || !args.env) return;
  const name =
    args.site ??
    catalogue.settings.values.PAQVILO_SITE ??
    catalogue.root.defaultSite ??
    Object.keys(catalogue.sites)[0];
  const site = catalogue.sites[name];
  if (!site || mirageOnlySite(site) || Object.hasOwn(site.environments, args.env)) return;
  throw Object.assign(
    new Error(
      `Unknown environment "${args.env}" for site "${name}". Known: ${Object.keys(site.environments).join(', ') || '(none)'}. Run "${paqviloCommand(['lense', 'list'], { script: 'list', config: catalogue.configFile })}" to see them.`,
    ),
    { code: 'invalid_argument' },
  );
}

async function catalogueAnalysisReports(args, failOn) {
  const reports = [];
  const catalogue = loadCatalogue(args);
  if (args.site && !Object.hasOwn(catalogue.sites, args.site))
    throw Object.assign(new Error('Unknown site selected for static analysis.'), { code: 'invalid_argument' });
  checkEnvironmentOption(catalogue, args);
  for (const site of args.all ? Object.keys(catalogue.sites) : [args.site])
    reports.push(await analyzeSiteReport(catalogue, site, args, failOn));
  return reports;
}

// The standalone path (--source or --project without a catalogue selector) never reads --env or --repo, so each would
// be silently ignored: the combination is refused before any work, naming the standalone selector in use.
const STANDALONE_SELECTOR_REFUSALS = [
  ['env', (mode) => `--env selects a catalogue environment and cannot be combined with ${mode}.`],
  ['repo', (mode) => `--repo selects catalogue sources and cannot be combined with ${mode}.`],
];

function refusal(message) {
  return Object.assign(new Error(message), { code: 'invalid_argument' });
}

const catalogueSelected = (args) => Boolean(args.config || args.site || args.all);

// --source wins when both are given; a catalogue selector makes the run a catalogue run, where --source overrides the
// selected site's portal source.
function standaloneSelector(args) {
  if (catalogueSelected(args)) return null;
  if (args.source) return '--source';
  return args.project ? '--project' : null;
}

function refuseStandaloneCombinations(args) {
  const mode = standaloneSelector(args);
  if (!mode) return;
  const selector = STANDALONE_SELECTOR_REFUSALS.find(([name]) => args[name] !== undefined);
  if (selector) throw refusal(selector[1](mode));
}

export default async function analyze(_cfg, args) {
  refuseStandaloneCombinations(args);
  const failOn = validateAnalysisPolicy(args['fail-on'] ?? 'error');
  const local = (args.source || args.project) && !args.config && !args.site && !args.all;
  const reports = local ? [localAnalysisReport(args, failOn)] : await catalogueAnalysisReports(args, failOn);
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
