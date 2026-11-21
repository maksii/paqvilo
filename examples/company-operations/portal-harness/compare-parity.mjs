import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { compareRuns } from './parity.mjs';
import { cli } from '../cli.mjs';
import { exampleRoot } from '../paths.mjs';

const { positionals: args } = cli(
  `Usage: node portal-harness/compare-parity.mjs <native-run.json> <mirage-run.json> [private-report.json]

Run from examples/company-operations. Compares a native and a Mirage run summary offline; exits 1 unless equal.
The report defaults to the example's .paqvilo/portal-harness/mirage-parity.json; relative paths given as arguments
resolve from the working directory.`,
  {},
  { positionals: [2, 3] },
);
const load = async (file) => {
  const value = JSON.parse(await readFile(file, 'utf8'));
  return value.results?.at(-1) ?? value;
};
const report = compareRuns(await load(args[0]), await load(args[1]));
const output = path.resolve(args[2] ?? path.join(exampleRoot, '.paqvilo/portal-harness/mirage-parity.json'));
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    verdict: report.verdict,
    cases: report.pairs.length,
    prerequisiteFailures: report.prerequisiteFailures,
    output,
  }),
);
if (report.verdict !== 'equal') process.exitCode = 1;
