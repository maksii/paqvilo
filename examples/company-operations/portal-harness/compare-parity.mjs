import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { compareRuns } from './parity.mjs';

const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3) throw new Error('Usage: node portal-harness/compare-parity.mjs <native-run.json> <mirage-run.json> [private-report.json]');
const load = async file => {
  const value = JSON.parse(await readFile(file, 'utf8'));
  return value.results?.at(-1) ?? value;
};
const report = compareRuns(await load(args[0]), await load(args[1]));
const output = path.resolve(args[2] ?? '.paqvilo/portal-harness/mirage-parity.json');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ verdict: report.verdict, cases: report.pairs.length, prerequisiteFailures: report.prerequisiteFailures, output }));
if (report.verdict !== 'equal') process.exitCode = 1;
