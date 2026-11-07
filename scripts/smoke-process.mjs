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
