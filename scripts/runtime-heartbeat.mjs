/** A responsiveness gate that stays active through UI reads and mutations,
 * not only while the complete metadata response is streaming. */
export function runtimeHeartbeat(url, { timeoutMs = 1000, fetch: request = globalThis.fetch, onFailure } = {}) {
  const abort = new AbortController();
  let rejectFailure,
    maxHeartbeatMs = 0,
    heartbeats = 0;
  const failure = new Promise((_resolve, reject) => {
    rejectFailure = reject;
  });
  failure.catch(() => {});
  const done = (async () => {
    while (!abort.signal.aborted) {
      const started = performance.now();
      try {
        const response = await request(url + '/_sim/api/status', {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (response.status !== 200) throw Error('Heartbeat status ' + response.status);
        await response.arrayBuffer();
        maxHeartbeatMs = Math.max(maxHeartbeatMs, performance.now() - started);
        heartbeats++;
        await new Promise((resolve) => {
          const timer = setTimeout(finish, 5);
          function finish() {
            clearTimeout(timer);
            abort.signal.removeEventListener('abort', finish);
            resolve();
          }
          abort.signal.addEventListener('abort', finish, { once: true });
          if (abort.signal.aborted) finish();
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        onFailure?.({ elapsedMs: Math.round(performance.now() - started), message: error.message });
        rejectFailure(error);
        return;
      }
    }
  })();
  return {
    failure,
    metrics: () => ({ maxHeartbeatMs: Math.round(maxHeartbeatMs), heartbeats }),
    async stop() {
      abort.abort();
      await done;
    },
  };
}
