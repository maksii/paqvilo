import { createHash } from 'node:crypto';

/** Network notifications can trail a successful Fetch.fulfillRequest acknowledgement. */
export function createResponseProofQueue({ requests, admit }) {
  const pending = new Map();
  let bytes = 0,
    timer,
    closed = false;
  const remove = (id) => {
    const entry = pending.get(id);
    if (entry) {
      bytes -= entry.bytes;
      pending.delete(id);
    }
    return entry;
  };
  const expire = () => {
    clearTimeout(timer);
    timer = null;
    const now = performance.now();
    for (const [id, entry] of pending) if (now - entry.time >= 3000) remove(id);
    if (pending.size) {
      timer = setTimeout(expire, Math.max(1, 3000 - (now - pending.values().next().value.time)));
      timer.unref();
    }
  };
  const match = (entry, request) => entry.frameId === request.frameId && entry.urlKey === request.urlKey;
  return {
    async fulfill(event, proof) {
      if (closed || typeof event.networkId !== 'string' || !event.frameId || typeof event.request?.url !== 'string')
        return false;
      const urlKey = createHash('sha256').update(event.request.url).digest('hex');
      const entry = { frameId: event.frameId, urlKey, proof, time: performance.now() };
      const request = requests.get(event.networkId);
      if (request && match(entry, request)) return admit(request.frameId, request.loaderId, proof, request);
      try {
        entry.bytes = Buffer.byteLength(JSON.stringify(proof));
      } catch {
        return false;
      }
      if (entry.bytes > 8 * 1024 * 1024) return false;
      remove(event.networkId);
      while (pending.size >= 256 || bytes + entry.bytes > 16 * 1024 * 1024) remove(pending.keys().next().value);
      pending.set(event.networkId, entry);
      bytes += entry.bytes;
      if (!timer) {
        timer = setTimeout(expire, 3000);
        timer.unref();
      }
      return true;
    },
    requested(id, request) {
      const entry = pending.get(id);
      if (closed || !entry || !match(entry, request)) return;
      remove(id);
      if (performance.now() - entry.time < 3000)
        Promise.resolve()
          .then(() => (closed ? false : admit(request.frameId, request.loaderId, entry.proof, request)))
          .catch(() => {});
    },
    clear() {
      closed = true;
      clearTimeout(timer);
      pending.clear();
      bytes = 0;
    },
  };
}
