import { runOracle } from '../mirage/test-support/power-fx-oracle.mjs';

const USAGE = 'Usage: node scripts/power-fx-oracle.mjs [--pac path/to/pac.exe]';
const args = process.argv.slice(2);

function argumentProblem() {
  let pac;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') continue;
    if (arg !== '--pac') return 'unknown option ' + arg;
    if (pac !== undefined) return '--pac may be given only once';
    pac = args[++index];
    if (!pac || pac.startsWith('-')) return '--pac needs one path';
  }
  return null;
}

const problem = argumentProblem();
if (!problem && args.some((arg) => arg === '--help' || arg === '-h')) console.log(USAGE);
else
  try {
    if (problem) throw Object.assign(new Error(`${problem}. ${USAGE}`), { code: 'OracleArgumentsInvalid' });
    const report = await runOracle({ pac: args[args.indexOf('--pac') + 1] || undefined });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify({ ok: false, error: { code: error.code || 'OracleFailed', message: error.message } }, null, 2),
    );
    process.exitCode = 1;
  }
