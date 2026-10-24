import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projects = [
  '.',
  'mirage',
  'examples/company-operations',
  'mirage/test-sdk/tds',
  'mirage/test-sdk/dynamics-web-api',
  'mirage/test-sdk/cert-auth',
];
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
    failed = true;
    for (const [name, finding] of Object.entries(report.vulnerabilities ?? {}))
      console.error(`${project}: ${name} (${finding.severity})`);
  } else if (result.status !== 0) throw new Error(`Dependency audit failed for ${project} (${result.status}).`);
}
process.exitCode = failed ? 1 : 0;
