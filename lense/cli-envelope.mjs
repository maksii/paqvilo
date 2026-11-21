// The JSON envelope of a lense command's output and the document of a failed one. The command line (lense/cli.mjs)
// and the in-process runner of the Mirage tests (test/helpers/mirage-in-process.mjs) both use them, so a result
// read in-process has the same fields as the one a command line prints.

/**
 * Returns the text a command prints in JSON mode with the envelope fields added: `schemaVersion`, `command`,
 * `offline`, `ok`, `writesFiles` and a normalised `errors` list. Text that is not JSON is returned unchanged.
 */
export function jsonEnvelope(text, { command, positionals }) {
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return text;
  }
  const normalizeError = (error) =>
    typeof error === 'string'
      ? { code: command === 'doctor' ? 'check_failed' : 'command_failed', message: error }
      : {
          ...error,
          code: error?.code ?? 'check_failed',
          message: error?.message ?? error?.reason ?? 'Command failed',
        };
  if (Array.isArray(result)) result = { results: result };
  if (Array.isArray(result.reports))
    result.reports = result.reports.map((report) => ({
      ...report,
      errors: (report.errors ?? []).map(normalizeError),
      ...(report.mirage
        ? { mirage: { ...report.mirage, errors: (report.mirage.errors ?? []).map(normalizeError) } }
        : {}),
    }));
  const errors = (
    result.errors ??
    (result.error
      ? [result.error]
      : (result.reports ?? []).flatMap((report) => [
          ...(report.errors ?? []),
          ...(result.checks?.includes('mirage') && report.mirage?.ready === false ? report.mirage.errors : []),
        ]))
  ).map(normalizeError);
  return JSON.stringify(
    {
      schemaVersion: 1,
      command,
      offline:
        result.command === 'help' ||
        (command === 'mirage'
          ? ['init', 'inspect'].includes(positionals[1])
          : !['agent', 'dev', 'verify', 'status'].includes(command)),
      ...result,
      // Help describes the command; it ran no action.
      ...(command === 'agent' && result.command !== 'help' ? { action: positionals[1] ?? 'sessions' } : {}),
      ok: result.ok ?? result.ready ?? result.passed ?? errors.length === 0,
      writesFiles: Array.isArray(result.writesFiles) ? result.writesFiles : [],
      errors,
    },
    null,
    2,
  );
}

/**
 * The document a command prints in JSON mode when it fails. A failure without a code is classified by the phase it
 * failed in: the arguments, the configuration or the execution of the command.
 */
export function failureDocument(error, { command, phase }) {
  let errorCode = error.code;
  if (errorCode == null) {
    if (phase === 'arguments') errorCode = 'invalid_argument';
    else if (phase === 'configuration') errorCode = 'configuration_error';
    else errorCode = 'command_failed';
  }
  return {
    schemaVersion: 1,
    command,
    ok: false,
    writesFiles: error.writesFiles ?? [],
    error: {
      code: errorCode,
      message: error.message,
      ...(error.status ? { status: error.status } : {}),
    },
  };
}
