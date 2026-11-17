import fs from 'node:fs';
import path from 'node:path';
import { runNpmAudit } from './audit-process.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { npmCliPath } from './npm-cli.mjs';
import {
  readAuditInputs,
  unchangedAuditInputs,
  validateAuditReport,
  temporaryRiskAcceptance,
  matchesApprovedRiskInputs,
} from './dependency-risk-acceptance.mjs';

export { npmCliPath };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const auditedProjects = Object.freeze([
  '.',
  'mirage',
  'examples/company-operations',
  'mirage/test-sdk/tds',
  'mirage/test-sdk/dynamics-web-api',
  'mirage/test-sdk/cert-auth',
  'examples/project/components/pcf-dataset-control',
  'examples/project/components/pcf-field-control',
  'examples/project/components/pcf-field-types',
  'examples/project/components/pcf-web-api-control',
]);
// Accepted findings (user decision 2026-10-31): GHSA-g3hv-75wg-m249 (minimatch <11.0.1) in the dev-only lint copy that
// eslint-plugin-import-x 4.17.1 needs, since minimatch 11 removed its makeRe import; lint globs come from this repository.
// The other lint packages are overridden to minimatch 11 (package.json). An entry stops matching, and the audit fails,
// when import-x changes version or anything else depends on the vulnerable copy.
const accepted = [
  {
    project: '.',
    advisory: 'https://github.com/advisories/GHSA-g3hv-75wg-m249',
    dependency: 'minimatch',
    node: 'node_modules/minimatch',
    via: { name: 'eslint-plugin-import-x', version: '4.17.1' },
  },
];
// The packages whose installed dependency on `name` resolves to the hoisted node_modules/<name>.
const dependentsOfHoisted = (lockfile, name) =>
  Object.entries(lockfile.packages ?? {})
    .filter(([location, entry]) => {
      if (!entry.dependencies?.[name] && !entry.devDependencies?.[name]) return false;
      const prefix = location ? `${location}/` : '';
      const nested = `${prefix}node_modules/${name}`;
      return !lockfile.packages[nested];
    })
    .map(([location, entry]) => ({ location, version: entry.version }));
export function acceptedFinding(project, name, finding, report, lockfile) {
  const advisories = (vulnerable) =>
    (report.vulnerabilities[vulnerable]?.via ?? []).filter((via) => typeof via === 'object').map((via) => via.url);
  return accepted.some((entry) => {
    if (entry.project !== project) return false;
    const dependents = dependentsOfHoisted(lockfile, entry.dependency);
    const onlyVia =
      dependents.length === 1 &&
      dependents[0].location === `node_modules/${entry.via.name}` &&
      dependents[0].version === entry.via.version;
    const exact =
      JSON.stringify(report.vulnerabilities[entry.dependency]?.nodes) === JSON.stringify([entry.node]) &&
      JSON.stringify(advisories(entry.dependency)) === JSON.stringify([entry.advisory]);
    if (!onlyVia || !exact) return false;
    if (name === entry.dependency) return true;
    // The dependent itself is reported only through that dependency.
    return name === entry.via.name && JSON.stringify(finding.via) === JSON.stringify([entry.dependency]);
  });
}
function findingDisposition(historical, riskAccepted) {
  if (riskAccepted) return ' temporarily risk accepted (not fixed)';
  if (historical) return ' accepted';
  return '';
}

function findingsFailAudit(project, report, status, evidence, { now, error }) {
  const lockfile = JSON.parse(evidence.lock);
  const temporary = temporaryRiskAcceptance(project, report, status, evidence, { now });
  if (temporary.accepted) error(`${project}: ${temporary.message}`);
  else error(`${project}: temporary risk acceptance not applicable: ${temporary.reason}`);
  let failed = false;
  for (const [name, finding] of Object.entries(report.vulnerabilities ?? {})) {
    const historical = acceptedFinding(project, name, finding, report, lockfile);
    const riskAccepted = temporary.accepted && temporary.names.includes(name);
    if (!historical && !riskAccepted) failed = true;
    error(`${project}: ${name} (${finding.severity})${findingDisposition(historical, riskAccepted)}`);
  }
  return failed;
}

export function auditProject(
  project,
  cli,
  {
    rootDirectory = root,
    runAudit = runNpmAudit,
    now = Date.now,
    log = console.log,
    error = console.error,
    signal,
  } = {},
) {
  const cwd = path.resolve(rootDirectory, project);
  const before = readAuditInputs(rootDirectory, project);
  const result = runAudit(process.execPath, [cli, 'audit', '--json'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  const inspect = (value) => inspectAuditResult(project, value, { rootDirectory, before, now, log, error });
  return result && typeof result.then === 'function' ? result.then(inspect) : inspect(result);
}

function inspectAuditResult(project, result, { rootDirectory, before, now, log, error }) {
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Dependency audit was interrupted for ${project}.`);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Dependency audit did not return JSON for ${project}.`);
  }
  if (report.error || !report.metadata?.vulnerabilities)
    throw new Error(`Dependency audit unavailable for ${project}: ${report.error?.summary ?? result.stderr}`);
  validateAuditReport(report, result.status);
  const evidence = readAuditInputs(rootDirectory, project);
  if (!unchangedAuditInputs(before, evidence))
    throw new Error(`Dependency inputs changed during audit for ${project}.`);
  const counts = report.metadata.vulnerabilities;
  log(`${project}: ${JSON.stringify(counts)}`);
  if (counts.total === 0 && matchesApprovedRiskInputs(project, evidence))
    throw new Error(
      `The unchanged approved dependency graph in ${project} returned zero advisory findings; this report change requires re-evaluation.`,
    );
  if (counts.total > 0) return findingsFailAudit(project, report, result.status, evidence, { now, error });
  return false;
}

export function auditAllProjects(cli, options = {}) {
  const reportFailure = (project, error) => (options.error ?? console.error)(`${project}: ${error.message}`);
  function visit(index, failed) {
    if (options.signal?.aborted) throw new Error('Dependency audit cancelled.');
    if (index === auditedProjects.length) return failed;
    const project = auditedProjects[index];
    try {
      const result = auditProject(project, cli, options);
      if (result && typeof result.then === 'function') {
        return result.then(
          (finding) => visit(index + 1, failed || finding),
          (error) => {
            if (error.auditOwnershipFailure) throw error;
            reportFailure(project, error);
            return visit(index + 1, true);
          },
        );
      }
      return visit(index + 1, failed || result);
    } catch (error) {
      if (error.auditOwnershipFailure) throw error;
      reportFailure(project, error);
      return visit(index + 1, true);
    }
  }
  return visit(0, false);
}

async function main() {
  const cli = npmCliPath();
  if (!fs.existsSync(cli)) throw new Error('Run npm run audit:dependencies.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const failed = await auditAllProjects(cli, { signal: controller.signal });
    process.exitCode = failed ? 1 : 0;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
