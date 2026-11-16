/**
 * Report invocation failures as a single JSON value when requested. `args` are the invocation's arguments (its
 * `--json` flag counts before any `--` terminator); the streams default to the process's.
 */
export function reportCliError(
  error,
  { args = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {},
) {
  if (args.slice(0, !args.includes('--') ? undefined : args.indexOf('--')).includes('--json'))
    stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        ok: false,
        error: { code: 'MIRAGE_FAILED', message: error.message ?? String(error) },
      })}\n`,
    );
  else stderr.write(`${error.message ?? String(error)}\n`);
}
