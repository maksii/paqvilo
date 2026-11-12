/** Reserve document/redirect time without treating an unrelated fast page as comparable.
 * Without a comparable measurement the reserve is the larger of min(3 s, half the remaining budget) and
 * min(remaining - 5 s, half the remaining budget). It is never more than half the remaining budget:
 * 15 s remaining reserves 7.5 s and 4 s remaining reserves 2 s. Negative remaining time is treated as zero. */
export function navigationCommitBudget(remainingMs, { explicitMs, comparableMs } = {}) {
  if (explicitMs !== undefined) return { reserveMs: explicitMs, policy: 'explicit' };
  const remaining = Math.max(0, remainingMs);
  const fallback = Math.max(Math.min(3000, remaining / 2), Math.min(remaining - 5000, remaining / 2));
  const measured = Number.isFinite(comparableMs) && comparableMs >= 0;
  return {
    reserveMs: Math.min(remaining, Math.max(fallback, measured ? comparableMs + 1000 : 0)),
    policy: measured ? 'comparable-navigation-chain' : 'bounded-write-fallback',
  };
}
