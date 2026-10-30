/** Report invocation failures as a single JSON value when requested. */
export function reportCliError(error) {
  if (process.argv.slice(2, process.argv.indexOf('--') < 0 ? undefined : process.argv.indexOf('--')).includes('--json'))
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: false,
        error: { code: 'MIRAGE_FAILED', message: error.message ?? String(error) },
      }),
    );
  else console.error(error.message ?? String(error));
}
