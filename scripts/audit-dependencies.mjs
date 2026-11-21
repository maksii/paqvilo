import { isEntryPoint } from '../lense/entry-point.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { runNpmAudit } from './audit-process.mjs';
import { fileURLToPath } from 'node:url';
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
function findingsFailAudit(project, report, status, evidence, { now, riskPolicy, error }) {
  const temporary = temporaryRiskAcceptance(project, report, status, evidence, { now, policy: riskPolicy });
  if (temporary.accepted) error(`${project}: ${temporary.message}`);
  else error(`${project}: temporary risk acceptance not applicable: ${temporary.reason}`);
  let failed = false;
  for (const [name, finding] of Object.entries(report.vulnerabilities ?? {})) {
    const riskAccepted = temporary.accepted && temporary.names.includes(name);
    if (!riskAccepted) failed = true;
    error(`${project}: ${name} (${finding.severity})${riskAccepted ? ' temporarily risk accepted (not fixed)' : ''}`);
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
    riskPolicy,
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
  const inspect = (value) => inspectAuditResult(project, value, { rootDirectory, before, now, riskPolicy, log, error });
  return result && typeof result.then === 'function' ? result.then(inspect) : inspect(result);
}

function inspectAuditResult(project, result, { rootDirectory, before, now, riskPolicy, log, error }) {
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
  if (counts.total === 0 && matchesApprovedRiskInputs(project, evidence, riskPolicy))
    throw new Error(
      `The unchanged approved dependency graph in ${project} returned zero advisory findings; this report change requires re-evaluation.`,
    );
  if (counts.total > 0) return findingsFailAudit(project, report, result.status, evidence, { now, riskPolicy, error });
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

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(`Usage: node scripts/audit-dependencies.mjs
Runs npm audit (contacts the npm registry) for each audited project and fails on findings outside the time-limited
risk acceptance in scripts/dependency-risk-acceptance.json. Takes no options; --help prints this help.
See docs/dependency-upgrades.md.`);
    return;
  }
  if (args.length) {
    // Any other argument list, --help beside another argument included, is refused: it never skips the audit silently.
    console.error(`audit-dependencies: unexpected arguments ${args.join(' ')}; it takes no options (see --help).`);
    process.exitCode = 1;
    return;
  }
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

if (isEntryPoint(import.meta.url)) await main(process.argv.slice(2));
