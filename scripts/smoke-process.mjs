/** Hang guard of one child process of the smoke, release and preparation scripts. It is not a speed limit: a loaded host finishes an offline install or a CLI
 * start well inside it, and only a child that never returns reaches it. */
export const CHILD_HANG_GUARD_MS = 900_000;

// Preserve spawn failures (including timeouts) alongside the child's captured output.
export function assertSmokeProcess(result, label) {
  if (result.status === 0 && !result.error) return;
  const details = [
    `status=${result.status ?? 'null'}`,
    `signal=${result.signal ?? 'none'}`,
    ...(result.error ? [`error=${result.error.code ?? 'unknown'}: ${result.error.message}`] : []),
  ].join(', ');
  throw new Error(`${label}: ${details}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}
