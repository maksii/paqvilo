/** Reserve document/redirect time without treating an unrelated fast page as comparable.
 * With no comparable measurement, allow at most five seconds for pending writes.
 * Short actions retain a half-budget cap on the three-second minimum reserve. */
export function navigationCommitBudget(remainingMs, { explicitMs, comparableMs } = {}) {
  if (explicitMs !== undefined) return { reserveMs: explicitMs, policy: 'explicit' };
  const fallback = Math.max(Math.min(3000, remainingMs / 2), remainingMs - 5000);
  const measured = Number.isFinite(comparableMs) && comparableMs >= 0;
  return {
    reserveMs: Math.min(remainingMs, Math.max(fallback, measured ? comparableMs + 1000 : 0)),
    policy: measured ? 'comparable-navigation-chain' : 'bounded-write-fallback',
  };
}
