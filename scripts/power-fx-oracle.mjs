import { runOracle } from '../mirage/test-support/power-fx-oracle.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--pac' || !args[1]))
    throw Object.assign(new Error('Usage: node scripts/power-fx-oracle.mjs [--pac path/to/pac.exe]'), {
      code: 'OracleArgumentsInvalid',
    });
  const report = await runOracle({ pac: args[1] });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.log(
    JSON.stringify({ ok: false, error: { code: error.code || 'OracleFailed', message: error.message } }, null, 2),
  );
  process.exitCode = 1;
}
