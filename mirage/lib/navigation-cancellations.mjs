/** Browser document replacement ends its requests; this does not prove a write committed. */
export function cancelNavigationRequests(
  requests,
  pending,
  records,
  { reason, at = Date.now(), ticks = performance.now() } = {},
) {
  const cancelled = [];
  for (const request of requests) {
    const record = records.get(request);
    if (!record || record.navigationCancellation || record.finished === true) continue;
    const failure = request.failure()?.errorText;
    // Preserve completed HTTP errors and failures unrelated to navigation.
    if (record.status >= 400 || (failure && failure !== 'net::ERR_ABORTED')) continue;
    record.navigationCancellation = {
      classification: 'cancelled-by-navigation',
      reason,
      at: new Date(at).toISOString(),
    };
    // Elapsed on the runner's monotonic clock when the record carries its start (a wall clock step cannot move it);
    // `at` stays the reported timestamp.
    record.durationMs = Number.isFinite(record.startedTicks)
      ? Math.round(ticks - record.startedTicks)
      : at - record.started;
    record.finished = false;
    pending.delete(request);
    cancelled.push({
      requestKey: String(record.order),
      method: record.method,
      url: record.url,
      ...record.navigationCancellation,
    });
  }
  return cancelled;
}
