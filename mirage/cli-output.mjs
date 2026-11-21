/** The toolkit's CLI codes, kept as every paqvilo command reports them (docs/cli.md). */
const TOOLKIT_CLI_CODES = new Set(['unsupported_option', 'invalid_argument', 'unknown_command', 'CONFIG_NOT_FOUND']);

/**
 * The JSON error code of a failed Mirage command: an unsupported option, a repeated single-value option, an unknown
 * command and a missing catalogue keep the toolkit's codes; any other failure is MIRAGE_FAILED.
 */
export const mirageFailureCode = (error) => (TOOLKIT_CLI_CODES.has(error?.code) ? error.code : 'MIRAGE_FAILED');

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
        error: { code: mirageFailureCode(error), message: error.message ?? String(error) },
      })}\n`,
    );
  else stderr.write(`${error.message ?? String(error)}\n`);
}
