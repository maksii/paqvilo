/** Browser document replacement ends its requests; this does not prove a write committed. */
export function cancelNavigationRequests(requests, pending, records, { reason, at = Date.now() } = {}) {
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
    record.durationMs = at - record.started;
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
