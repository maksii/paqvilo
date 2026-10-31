import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projects = [
  '.',
  'mirage',
  'examples/company-operations',
  'mirage/test-sdk/tds',
  'mirage/test-sdk/dynamics-web-api',
  'mirage/test-sdk/cert-auth',
];
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
const lockfileOf = (cwd, project) =>
  JSON.parse(fs.readFileSync(path.join(cwd, project === '.' ? 'npm-shrinkwrap.json' : 'package-lock.json'), 'utf8'));
// The packages whose installed dependency on `name` resolves to the hoisted node_modules/<name>.
const dependentsOfHoisted = (lockfile, name) =>
  Object.entries(lockfile.packages ?? {})
    .filter(([location, entry]) => {
      if (!entry.dependencies?.[name] && !entry.devDependencies?.[name]) return false;
      const nested = `${location ? `${location}/` : ''}node_modules/${name}`;
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
function main() {
  const cli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (!fs.existsSync(cli)) throw new Error('Run npm run audit:dependencies.');
  let failed = false;
  for (const project of projects) {
    const cwd = path.resolve(root, project);
    if (!fs.existsSync(path.join(cwd, project === '.' ? 'npm-shrinkwrap.json' : 'package-lock.json')))
      throw new Error(`Missing lockfile in ${project}.`);
    const result = spawnSync(process.execPath, [cli, 'audit', '--json'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Dependency audit did not return JSON for ${project}.`);
    }
    if (report.error || !report.metadata?.vulnerabilities)
      throw new Error(`Dependency audit unavailable for ${project}: ${report.error?.summary ?? result.stderr}`);
    const counts = report.metadata.vulnerabilities;
    console.log(`${project}: ${JSON.stringify(counts)}`);
    if (counts.total > 0) {
      const lockfile = lockfileOf(cwd, project);
      for (const [name, finding] of Object.entries(report.vulnerabilities ?? {})) {
        const isAccepted = acceptedFinding(project, name, finding, report, lockfile);
        if (!isAccepted) failed = true;
        console.error(`${project}: ${name} (${finding.severity})${isAccepted ? ' accepted' : ''}`);
      }
    } else if (result.status !== 0) throw new Error(`Dependency audit failed for ${project} (${result.status}).`);
  }
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
