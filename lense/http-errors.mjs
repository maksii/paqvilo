const LIMIT = 32 * 1024;
const jsonType = (value) => /^application\/(?:json|[\w.-]+\+json)(?:\s*;|$)/i.test(value ?? '');
async function deadline(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Response observer connection timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Read Chromium's bounded response cache, never replay a request or materialize
// an unbounded Playwright response body. Chunked transfers need no size header.
export function observeHttpErrors(context, page, { origin, response, timeoutMs = 2000 }) {
  let client,
    closed = false,
    failed = false;
  const requests = new Map(),
    pending = new Map(),
    listeners = [];
  const take = (id) => {
    const entry = pending.get(id);
    pending.delete(id);
    if (entry) clearTimeout(entry.timer);
    return entry;
  };
  const clearPending = () => {
    for (const id of pending.keys()) take(id);
  };
  const detach = (candidate) =>
    deadline(
      Promise.resolve().then(() => candidate?.detach?.()),
      Math.min(timeoutMs, 500),
    ).catch(() => {});
  const ready = (async () => {
    const attaching = Promise.resolve().then(() => context.newCDPSession(page));
    attaching.then(
      (candidate) => {
        if (closed || failed) void detach(candidate);
      },
      () => {},
    );
    client = await deadline(attaching, timeoutMs);
    if (closed) return detach(client);
    const on = (name, fn) => {
      client.on(name, fn);
      listeners.push(() => client.off(name, fn));
    };
    on('Network.requestWillBeSent', (event) => {
      requests.delete(event.requestId);
      requests.set(event.requestId, event.request.method);
      if (requests.size > 512) requests.delete(requests.keys().next().value);
    });
    on('Network.responseReceived', (event) => {
      const res = event.response;
      let url;
      try {
        url = new URL(res.url);
      } catch {
        return;
      }
      if (res.status < 400 || url.origin !== origin) return;
      const finish = response({
        status: res.status,
        method: requests.get(event.requestId) ?? 'GET',
        path: url.pathname,
      });
      const headers = Object.fromEntries(
        Object.entries(res.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
      );
      if (
        !jsonType(headers['content-type'] ?? res.mimeType) ||
        (headers['content-encoding'] && headers['content-encoding'] !== 'identity') ||
        Number(headers['content-length']) > LIMIT
      ) {
        finish(null);
        return;
      }
      if (pending.size >= 128) {
        finish(null);
        return;
      }
      const entry = { finish, size: 0 };
      entry.timer = setTimeout(() => {
        const expired = take(event.requestId);
        if (!closed) expired?.finish(null);
      }, timeoutMs);
      pending.set(event.requestId, entry);
    });
    on('Network.dataReceived', (event) => {
      const entry = pending.get(event.requestId);
      if (!entry) return;
      entry.size += event.dataLength;
      if (entry.size > LIMIT) take(event.requestId)?.finish(null);
    });
    on('Network.loadingFailed', (event) => {
      requests.delete(event.requestId);
      const entry = take(event.requestId);
      entry?.finish(null);
    });
    on('Network.loadingFinished', async (event) => {
      requests.delete(event.requestId);
      const entry = take(event.requestId);
      if (!entry || closed) return;
      let body = null;
      try {
        const result = await deadline(
          client.send('Network.getResponseBody', { requestId: event.requestId }),
          timeoutMs,
        );
        const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
        if (bytes.length <= LIMIT) body = JSON.parse(bytes.toString('utf8'));
      } catch {
        /* evicted, incomplete, malformed or oversized body: retain the HTTP row */
      }
      if (!closed) entry.finish(body);
    });
    await deadline(
      client.send('Network.enable', {
        maxTotalBufferSize: 128 * 1024,
        maxResourceBufferSize: LIMIT,
        maxPostDataSize: 0,
      }),
      timeoutMs,
    );
  })();
  ready.catch(() => {
    failed = true;
    listeners.forEach((remove) => remove());
    clearPending();
    requests.clear();
    void detach(client);
  });
  return {
    ready,
    get failed() {
      return failed;
    },
    async close() {
      if (closed) return;
      closed = true;
      listeners.forEach((remove) => remove());
      clearPending();
      requests.clear();
      await detach(client);
    },
  };
}
